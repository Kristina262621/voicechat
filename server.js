const express   = require('express');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const { Server } = require('socket.io');
const path      = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

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

const io = new Server(server, {
  // Устойчивость к плохому соединению
  pingTimeout:        60000,   // ждём pong 60 сек
  pingInterval:       10000,   // ping каждые 10 сек
  upgradeTimeout:     30000,
  transports:         ['websocket', 'polling'],  // fallback на polling
  allowUpgrades:      true,
  reconnection:       true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:  1000,
  reconnectionDelayMax: 5000,
  cors: { origin: '*' }
});

const rooms  = new Map(); // socketId -> roomId
const users  = new Set(); // все подключённые

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  users.add(socket.id);
  io.emit('user-count', users.size);

  socket.on('join', () => {
    console.log('Join:', socket.id);
    rooms.set(socket.id, true);

    // Отправляем список уже подключённых
    const others = [...rooms.keys()].filter(id => id !== socket.id);
    socket.emit('existing-users', others);

    // Уведомляем остальных
    socket.broadcast.emit('user-joined', socket.id);
  });

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('leave', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', socket.id, reason);
    handleLeave(socket);
  });

  function handleLeave(socket) {
    users.delete(socket.id);
    rooms.delete(socket.id);
    socket.broadcast.emit('user-left', socket.id);
    io.emit('user-count', users.size);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
