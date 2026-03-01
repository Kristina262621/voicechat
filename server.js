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
    activeUsers.add(socket.id);
    io.emit('user-count', activeUsers.size);
    console.log('Вошёл в чат:', socket.id);
  });

  socket.on('leave', () => {
    activeUsers.delete(socket.id);
    io.emit('user-count', activeUsers.size);
    console.log('Вышел из чата:', socket.id);
  });

  socket.on('disconnect', () => {
    activeUsers.delete(socket.id);
    io.emit('user-count', activeUsers.size);
    console.log('Отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
