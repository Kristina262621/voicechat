const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Пароль задаётся через переменную окружения или дефолт ──
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

// ── REST endpoint для проверки пароля ──
// Не передаём пароль через WebSocket — так безопаснее
app.post('/auth', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ ok: false, error: 'no_password' });
  }
  if (password === ROOM_PASSWORD) {
    return res.json({ ok: true });
  }
  // Намеренная задержка — защита от брутфорса
  setTimeout(() => {
    res.status(403).json({ ok: false, error: 'wrong_password' });
  }, 1000);
});

const io = new Server(server, {
  pingTimeout:      60000,
  pingInterval:     10000,
  upgradeTimeout:   30000,
  transports:       ['websocket', 'polling'],
  allowUpgrades:    true,
  cors:             { origin: '*' }
});

const rooms         = new Map(); // socketId -> true
const users         = new Set(); // все подключённые
const authenticated = new Set(); // socketId прошедших проверку

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  users.add(socket.id);
  io.emit('user-count', users.size);

  // ── Аутентификация через socket (второй рубеж) ──
  socket.on('authenticate', (token) => {
    // Клиент присылает пароль ещё раз при join —
    // так нельзя войти зная только socket.id
    if (token === ROOM_PASSWORD) {
      authenticated.add(socket.id);
      socket.emit('auth-ok');
      console.log('Authenticated:', socket.id);
    } else {
      socket.emit('auth-fail');
      console.log('Auth failed:', socket.id);
    }
  });

  socket.on('join', () => {
    // Пропускаем только аутентифицированных
    if (!authenticated.has(socket.id)) {
      socket.emit('auth-fail');
      return;
    }

    console.log('Join:', socket.id);
    rooms.set(socket.id, true);

    const others = [...rooms.keys()].filter(id => id !== socket.id);
    socket.emit('existing-users', others);
    socket.broadcast.emit('user-joined', socket.id);
  });

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

  socket.on('leave', () => handleLeave(socket));

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', socket.id, reason);
    handleLeave(socket);
  });

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
  console.log(`Server running on port ${PORT}`);
  console.log(`Room password: ${ROOM_PASSWORD}`);
});
