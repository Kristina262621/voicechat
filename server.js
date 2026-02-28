const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Присоединение к комнате
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    
    const room = rooms.get(roomId);
    room.add(socket.id);
    
    // Если в комнате уже есть участник — сигнализируем о готовности
    if (room.size === 2) {
      socket.to(roomId).emit('user-joined');
      console.log(`Room ${roomId} is full, starting connection...`);
    } else {
      socket.emit('waiting');
    }
  });

  // WebRTC сигналинг: обмен Offer и Answer
  socket.on('offer', (data) => {
    socket.to(data.roomId).emit('offer', { offer: data.offer, sender: socket.id });
  });

  socket.on('answer', (data) => {
    socket.to(data.roomId).emit('answer', { answer: data.answer, sender: socket.id });
  });

  // ICE кандидаты (для обхода NAT)
  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', { candidate: data.candidate, sender: socket.id });
  });

  // Отключение
  socket.on('disconnect', () => {
    rooms.forEach((users, roomId) => {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        socket.to(roomId).emit('user-left');
        if (users.size === 0) rooms.delete(roomId);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on https://localhost:${PORT}`);
  console.log(`For mobile testing use ngrok: npx ngrok http ${PORT}`);
});
