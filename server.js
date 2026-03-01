const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  socket.on('join-room', ({ roomId, name }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = name || 'Аноним';

    if (!rooms[roomId]) rooms[roomId] = [];

    const others = rooms[roomId].map(({ id, name }) => ({ id, name }));
    socket.emit('room-users', others);

    rooms[roomId].push({ id: socket.id, name: socket.userName });

    socket.to(roomId).emit('user-joined', { id: socket.id, name: socket.userName });

    console.log(`[${roomId}] ${socket.userName} (${socket.id}) вошёл. Всего: ${rooms[roomId].length}`);
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
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
      socket.to(roomId).emit('user-left', { id: socket.id, name: socket.userName });
      if (rooms[roomId].length === 0) delete rooms[roomId];
      console.log(`[${roomId}] ${socket.userName} отключился`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});