const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Voice Chat Server работает!');
});

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
  });
});

http.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
