const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

app.post('/auth', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ ok: false, error: 'no_password' });
  if (password === ROOM_PASSWORD) return res.json({ ok: true });
  setTimeout(() => res.status(403).json({ ok: false, error: 'wrong_password' }), 1000);
});

const io = new Server(server, {
  pingTimeout:   60000,
  pingInterval:  10000,
  upgradeTimeout: 30000,
  transports:    ['websocket', 'polling'],
  allowUpgrades: true,
  cors:          { origin: '*' }
});

const users         = new Set();
const rooms         = new Map();
const authenticated = new Set();

// Сообщения НЕ сохраняем — только пересылаем
// Сервер видит только зашифрованный blob, ключа у него нет

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  users.add(socket.id);
  io.emit('user-count', users.size);

  socket.on('authenticate', (token) => {
    if (token === ROOM_PASSWORD) {
      authenticated.add(socket.id);
      socket.emit('auth-ok');
      console.log('Authenticated:', socket.id);
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

  // Сообщение чата — просто relay, сервер не знает ключ
  socket.on('chat-message', (payload) => {
    if (!authenticated.has(socket.id)) return;
    // payload = { iv, data } — зашифрованный AES-GCM blob
    // Добавляем только id отправителя (
