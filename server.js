const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let activeUsers = new Set();

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  socket.on('join', () => {
    socket.emit('existing-users', [...activeUsers]);
    activeUsers.add(socket.id);
    io.emit('user-count', activeUsers.size);
    socket.broadcast.emit('user-joined', socket.id);
  });

  socket.on('leave', () => {
    activeUsers.delete(socket.id);
    io.emit('user-count', activeUsers.size);
    socket.broadcast.emit('user-left', socket.id);
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

  socket.on('disconnect', () => {
    activeUsers.delete(socket.id);
    io.emit('user-count', activeUsers.size);
    socket.broadcast.emit('user-left', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
