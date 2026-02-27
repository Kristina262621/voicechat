const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const { Pool }   = require('pg');

// ── База данных PostgreSQL ───────────────────────────────
// Платформа Railway автоматически передает ссылку на Postgres через process.env.DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/postgres',
  // Разрешаем SSL для облачных серверов, если подключаемся не локально
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') 
       ? { rejectUnauthorized: false } 
       : false
});

// Инициализация таблиц
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   VARCHAR(24) UNIQUE NOT NULL,
      pass_hash  TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_rooms (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(32) UNIQUE NOT NULL,
      pass_hash  TEXT,
      owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ PostgreSQL таблицы успешно инициализированы');
}
initDB().catch(console.error);

// ── Helpers ──────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'salt_priv8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

// Теперь функция асинхронная, так как мы ждем ответа от сервера Postgres
async function getUserByToken(token) {
  if (!token) return null;
  const res = await pool.query(`
    SELECT u.id, u.username
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = $1
  `, [token]);
  return res.rows[0] || null;
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ ok: false, error: 'username_length' });
  if (password.length < 4) return res.status(400).json({ ok: false, error: 'password_short' });

  try {
    const userRes = await pool.query(
      'INSERT INTO users (username, pass_hash) VALUES ($1, $2) RETURNING id',
      [username.trim(), hashPassword(password)]
    );
    
    const userId = userRes.rows[0].id;
    const token = generateToken();
    
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
    
    res.json({ ok: true, token, username: username.trim() });
  } catch (e) {
    // Ошибка 23505 — Нарушение уникальности (PostgreSQL)
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'username_taken' });
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = userRes.rows[0];

    if (!user || user.pass_hash !== hashPassword(password)) {
      return setTimeout(() => res.status(403).json({ ok: false, error: 'wrong_credentials' }), 1000);
    }

    const token = generateToken();
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
    res.json({ ok: true, token, username: user.username });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Проверка токена
app.post('/api/verify', async (req, res) => {
  const { token } = req.body;
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });
  res.json({ ok: true, username: user.username });
});

// Список комнат
app.get('/api/rooms', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!(await getUserByToken(token))) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const roomsRes = await pool.query(`
      SELECT r.id, r.name, u.username as owner,
             CASE WHEN r.pass_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
             r.created_at
      FROM chat_rooms r
      JOIN users u ON u.id = r.owner_id
      ORDER BY r.created_at DESC
    `);

    res.json({ ok: true, rooms: roomsRes.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Создать комнату
app.post('/api/rooms', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { name, password } = req.body;
    if (!name || name.length < 2 || name.length > 32)
      return res.status(400).json({ ok: false, error: 'invalid_name' });

    const passHash = password ? hashPassword(password) : null;
    const roomRes = await pool.query(
      'INSERT INTO chat_rooms (name, pass_hash, owner_id) VALUES ($1, $2, $3) RETURNING id',
      [name.trim(), passHash, user.id]
    );

    res.json({ ok: true, roomId: roomRes.rows[0].id, name: name.trim() });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'room_exists' });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Войти в комнату (проверка пароля комнаты)
app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const roomRes = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ ok: false, error: 'not_found' });

    if (room.pass_hash) {
      const { password } = req.body;
      if (!password || hashPassword(password) !== room.pass_hash)
        return setTimeout(() => res.status(403).json({ ok: false, error: 'wrong_password' }), 1000);
    }

    res.json({ ok: true, room: { id: room.id, name: room.name } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
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

// Хранилище: socket.id → { username, roomId }
const socketMeta = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // Аутентификация перед присоединением к комнате (теперь асинхронно из-за Postgres)
  socket.on('join-room', async ({ roomId, token }) => {
    try {
      const user = await getUserByToken(token);
      
      if (!user) {
        socket.emit('auth-fail');
        return;
      }

      socketMeta.set(socket.id, { username: user.username, roomId: roomId });
      socket.join(String(roomId));

      const roomSockets = io.sockets.adapter.rooms.get(String(roomId));
      const existingUsers = Array.from(roomSockets || []).filter(id => id !== socket.id);

      socket.emit('existing-users', existingUsers);
      socket.to(String(roomId)).emit('user-joined', socket.id);
      io.to(String(roomId)).emit('user-count', roomSockets ? roomSockets.size : 1);
      
      console.log(`👤 ${user.username} joined room ${roomId}`);
    } catch (e) {
      console.error('Socket DB Error:', e);
    }
  });

  // Остальные WebRTC события без изменений...
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

  socket.on('chat-message', (data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('chat-message', {
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

  socket.on('understood', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('understood', {
      from:     socket.id,
      username: meta.username
    });
  });

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
    socket.to(String(meta.roomId)).emit('video-start', {
      from:     socket.id,
      username: meta.username
    });
  });

  socket.on('video-stop', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('video-stop', { from: socket.id });
  });

  socket.on('leave',      () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(socket) {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      socket.to(String(meta.roomId)).emit('user-left', { socketId: socket.id });
      
      const roomSockets = io.sockets.adapter.rooms.get(String(meta.roomId));
      const count = roomSockets ? roomSockets.size : 0;
      io.to(String(meta.roomId)).emit('user-count', count);
      
      socketMeta.delete(socket.id);
      console.log(`🚪 Disconnected: ${meta.username} (${socket.id})`);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
