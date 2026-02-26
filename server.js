const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '333666';

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

// Проверка пароля
app.post('/auth', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ ok: false });
  if (password === ROOM_PASSWORD) return res.json({ ok: true });
  setTimeout(() => res.status(403).json({ ok: false, error: 'wrong_password' }), 1000);
});

const io = new Server(server, {
  pingTimeout:   60000,
  pingInterval:  10000,
  upgradeTimeout:30000,
  // Увеличиваем лимит для зашифрованных файлов
  maxHttpBufferSize: 50 * 1024 * 1024,
  transports:    ['websocket', 'polling'],
  allowUpgrades: true,
  cors:          { origin: '*' }
});

const users         = new Set();
const rooms         = new Map();
const authenticated = new Set();

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  users.add(socket.id);
  io.emit('user-count', users.size);

  socket.on('authenticate', (token) => {
    if (token === ROOM_PASSWORD) {
      authenticated.add(socket.id);
      socket.emit('auth-ok');
    } else {
      socket.emit('auth-fail');
    }
  });

  socket.on('join', () => {
    if (!authenticated.has(socket.id)) { socket.emit('auth-fail'); return; }
    rooms.set(socket.id, true);
    const others = [...rooms.keys()].filter(id => id !== socket.id);
    socket.emit('existing-users', others);
    socket.broadcast.emit('user-joined', socket.id);
  });

  // WebRTC сигнализация
  socket.on('offer', ({ to, offer }) => {
    if (!authenticated.has(socket.id)) return;
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    if (!authenticated.has(socket.id)) return;
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (!authenticated.has(socket.id)) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Чат — сервер видит только зашифрованный blob, не знает содержимого
  socket.on('chat-message', (data) => {
    if (!authenticated.has(socket.id)) return;
    // Пересылаем всем остальным как есть — не трогаем
    socket.broadcast.emit('chat-message', {
      from:      socket.id,
      encrypted: data.encrypted,   // зашифрованный текст/файл
      iv:        data.iv,          // вектор инициализации
      type:      data.type,        // 'text' | 'image' | 'video'
      fileName:  data.fileName,    // только для файлов
      fileSize:  data.fileSize,    // только для файлов
      timestamp: Date.now()
    });
  });

  socket.on('leave', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(socket) {
    users.delete(socket.id);
    rooms.delete(socket.id);
    authenticated.delete(socket.id);
    socket.broadcast.emit('user-left', socket.id);
    io.emit('user-count', users.size);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  console.log(`Password: ${ROOM_PASSWORD}`);
});
