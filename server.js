const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const Database   = require('better-sqlite3');

// ── База данных ──────────────────────────────────────────
const db = new Database(path.join(__dirname, 'chat.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    UNIQUE NOT NULL,
    pass_hash  TEXT    NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS chat_rooms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    UNIQUE NOT NULL,
    pass_hash  TEXT,
    owner_id   INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );
`);

// ── Helpers ──────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'salt_priv8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

function getUserByToken(token) {
  if (!token) return null;
  const session = db.prepare(`
    SELECT u.id, u.username
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  return session || null;
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// Регистрация
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  if (username.length < 2 || username.length > 24)
    return res.status(400).json({ ok: false, error: 'username_length' });
  if (password.length < 4)
    return res.status(400).json({ ok: false, error: 'password_short' });

  try {
    const stmt = db.prepare(
      'INSERT INTO users (username, pass_hash) VALUES (?, ?)'
    );
    const info = stmt.run(username.trim(), hashPassword(password));
    const token = generateToken();
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)')
      .run(token, info.lastInsertRowid);
    res.json({ ok: true, token, username: username.trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE'))
      return res.status(409).json({ ok: false, error: 'username_taken' });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Вход
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ ok: false, error: 'missing_fields' });

  const user = db.prepare(
    'SELECT * FROM users WHERE username = ?'
  ).get(username.trim());

  if (!user || user.pass_hash !== hashPassword(password)) {
    return setTimeout(
      () => res.status(403).json({ ok: false, error: 'wrong_credentials' }),
      1000
    );
  }

  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)')
    .run(token, user.id);
  res.json({ ok: true, token, username: user.username });
});

// Проверка токена
app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });
  res.json({ ok: true, username: user.username });
});

// Список комнат
app.get('/api/rooms', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!getUserByToken(token))
    return res.status(401).json({ ok: false, error: 'unauthorized' });

  const rooms = db.prepare(`
    SELECT r.id, r.name, u.username as owner,
           CASE WHEN r.pass_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
           r.created_at
    FROM chat_rooms r
    JOIN users u ON u.id = r.owner_id
    ORDER BY r.created_at DESC
  `).all();

  res.json({ ok: true, rooms });
});

// Создать комнату
app.post('/api/rooms', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user  = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { name, password } = req.body;
  if (!name || name.length < 2 || name.length > 32)
    return res.status(400).json({ ok: false, error: 'invalid_name' });

  try {
    const passHash = password ? hashPassword(password) : null;
    const info = db.prepare(
      'INSERT INTO chat_rooms (name, pass_hash, owner_id) VALUES (?, ?, ?)'
    ).run(name.trim(), passHash, user.id);
    res.json({ ok: true, roomId: info.lastInsertRowid, name: name.trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE'))
      return res.status(409).json({ ok: false, error: 'room_exists' });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Войти в комнату (проверка пароля комнаты)
app.post('/api/rooms/:id/join', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user  = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const room = db.prepare('SELECT * FROM chat_rooms WHERE id = ?')
    .get(req.params.id);
  if (!room) return res.status(404).json({ ok: false, error: 'not_found' });

  if (room.pass_hash) {
    const { password } = req.body;
    if (!password || hashPassword(password) !== room.pass_hash)
      return setTimeout(
        () => res.status(403).json({ ok: false, error: 'wrong_password' }),
        1000
      );
  }

  res.json({ ok: true, room: { id: room.id, name: room.name } });
});

// ── HTTPS / HTTP ─────────────────────────────────────────
let server;
try {
  const sslOptions = {
    key:  fs.readFileSync('/etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem')
  };
  server = https.createServer(sslOptions, app);
  console.log('HTTPS server');
} catch (e) {
  server = http.createServer(app);
  console.log('HTTP server (no SSL)');
}

// ── Socket.IO ────────────────────────────────────────────
const io = new Server(server, {
  pingTimeout:       60000,
  pingInterval:      10000,
  upgradeTimeout:    30000,
  maxHttpBufferSize: 50 * 1024 * 1024,
  transports:        ['websocket', 'polling'],
  allowUpgrades:     true,
  cors:              { origin: '*' }
});

// socket.id → { username, roomId }
const socketMeta = new Map();

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Аутентификация через токен
  socket.on('join-room', ({ roomId, token, username }) => {
    if (!users.has(token)) return; 
    currentRoom = roomId;
    socket.join(roomId);

    // Узнаем, кто УЖЕ в комнате (исключая самого себя)
    const roomSockets = io.sockets.adapter.rooms.get(roomId);
    const existingUsers = Array.from(roomSockets || []).filter(id => id !== socket.id);
    
    // ОТПРАВЛЯЕМ новичку список тех, кто тут сидит
    socket.emit('existing-users', existingUsers);

    // Оповещаем остальных, что новичок зашел
    socket.to(roomId).emit('user-joined', socket.id);
  });

    console.log(`${user.username} joined room ${room.name}`);
  });

  // WebRTC сигнализация
  socket.on('offer', ({ to, offer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Чат
  socket.on('chat-message', (data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(meta.roomId).emit('chat-message', {
      from:      socket.id,
      username:  meta.username,
      encrypted: data.encrypted,
      iv:        data.iv,
      type:      data.type,
      fileName:  data.fileName,
      fileSize:  data.fileSize,
      mimeType:  data.mimeType,
      timestamp: Date.now()
    });
  });

  // Понял
  socket.on('understood', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(meta.roomId).emit('understood', {
      from:     socket.id,
      username: meta.username
    });
  });

  // Видео-сигнализация
  socket.on('video-offer', ({ to, offer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('video-offer', { from: socket.id, offer });
  });

  socket.on('video-answer', ({ to, answer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('video-answer', { from: socket.id, answer });
  });

  socket.on('video-ice', ({ to, candidate }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('video-ice', { from: socket.id, candidate });
  });

  socket.on('video-start', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(meta.roomId).emit('video-start', {
      from:     socket.id,
      username: meta.username
    });
  });

  socket.on('video-stop', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(meta.roomId).emit('video-stop', { from: socket.id });
  });

  // Отключение
  socket.on('leave',      () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(socket) {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      socket.to(meta.roomId).emit('user-left', { socketId: socket.id });
      const roomSockets = io.sockets.adapter.rooms.get(meta.roomId);
      const count = roomSockets ? roomSockets.size - 1 : 0;
      io.to(meta.roomId).emit('user-count', Math.max(0, count));
    }
    socketMeta.delete(socket.id);
    console.log('Disconnected:', socket.id);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
});
