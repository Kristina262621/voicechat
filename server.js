const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

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
  pingTimeout:       60000,
  pingInterval:      10000,
  upgradeTimeout:    30000,
  maxHttpBufferSize: 50 * 1024 * 1024,
  transports:        ['websocket', 'polling'],
  allowUpgrades:     true,
  cors:              { origin: '*' }
});

// ── Хранилище комнат ──
// rooms: Map<roomId, { id, name, passwordHash, photo, ownerId, members: Set<socketId>, createdAt }>
const rooms   = new Map();
const clients = new Map(); // socketId → { nickname, roomId }

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Простое хэширование пароля (без bcrypt — нет зависимостей)
function hashPassword(pw) {
  if (!pw) return null;
  let hash = 0;
  for (let i = 0; i < pw.length; i++) {
    const chr = pw.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return String(hash);
}

// Отдаём список комнат (без паролей)
function getRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    list.push({
      id,
      name:        room.name,
      hasPassword: !!room.passwordHash,
      photo:       room.photo || null,
      memberCount: room.members.size,
      createdAt:   room.createdAt
    });
  }
  return list;
}

// Рассылаем обновлённый список всем в лобби
function broadcastRoomList() {
  io.emit('room-list', getRoomList());
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  clients.set(socket.id, { nickname: '', roomId: null });

  // ── Установить ник ──
  socket.on('set-nickname', (nickname, cb) => {
    const nick = String(nickname || '').trim().slice(0, 32);
    if (!nick) { cb && cb({ ok: false, error: 'empty' }); return; }
    clients.get(socket.id).nickname = nick;
    // Отправляем список комнат
    socket.emit('room-list', getRoomList());
    cb && cb({ ok: true });
  });

  // ── Создать комнату ──
  socket.on('create-room', ({ name, password, photo }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.nickname) { cb && cb({ ok: false, error: 'no_nick' }); return; }

    const roomName = String(name || '').trim().slice(0, 50);
    if (!roomName) { cb && cb({ ok: false, error: 'empty_name' }); return; }

    const id = generateRoomId();
    rooms.set(id, {
      id,
      name:         roomName,
      passwordHash: hashPassword(password || ''),
      photo:        photo || null,
      ownerId:      socket.id,
      members:      new Set(),
      createdAt:    Date.now()
    });

    broadcastRoomList();
    cb && cb({ ok: true, roomId: id });
  });

  // ── Войти в комнату ──
  socket.on('join-room', ({ roomId, password }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.nickname) { cb && cb({ ok: false, error: 'no_nick' }); return; }

    const room = rooms.get(roomId);
    if (!room) { cb && cb({ ok: false, error: 'not_found' }); return; }

    // Проверка пароля
    if (room.passwordHash) {
      const inputHash = hashPassword(password || '');
      if (inputHash !== room.passwordHash) {
        setTimeout(() => cb && cb({ ok: false, error: 'wrong_password' }), 800);
        return;
      }
    }

    // Покидаем предыдущую комнату
    if (client.roomId && client.roomId !== roomId) {
      leaveRoom(socket, client.roomId);
    }

    client.roomId = roomId;
    room.members.add(socket.id);
    socket.join(roomId);

    // Сообщаем остальным участникам комнаты
    const others = [...room.members].filter(id => id !== socket.id);
    const membersInfo = others.map(id => ({
      id,
      nickname: clients.get(id)?.nickname || shortId(id)
    }));

    socket.to(roomId).emit('room-user-joined', {
      id:       socket.id,
      nickname: client.nickname
    });

    broadcastRoomList();
    cb && cb({ ok: true, room: {
      id:      room.id,
      name:    room.name,
      photo:   room.photo,
      members: membersInfo
    }});
  });

  // ── WebRTC сигнализация (только внутри комнаты) ──
  socket.on('offer', ({ to, offer }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Голосовой чат: join/leave комнаты ──
  socket.on('voice-join', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    const room = rooms.get(client.roomId);
    if (!room) return;
    const others = [...room.members].filter(id => id !== socket.id);
    socket.emit('existing-voice-users', others);
    socket.to(client.roomId).emit('voice-user-joined', socket.id);
  });

  socket.on('voice-leave', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('voice-user-left', socket.id);
  });

  // ── Чат-сообщение (только в комнату) ──
  socket.on('chat-message', (data) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('chat-message', {
      from:      socket.id,
      nickname:  client.nickname,
      encrypted: data.encrypted,
      iv:        data.iv,
      type:      data.type,
      fileName:  data.fileName,
      fileSize:  data.fileSize,
      mimeType:  data.mimeType,
      timestamp: Date.now()
    });
  });

  // ── Понял ──
  socket.on('understood', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('understood', {
      from:     socket.id,
      nickname: client.nickname
    });
  });

  // ── Покинуть комнату (вернуться в лобби) ──
  socket.on('leave-room', () => {
    const client = clients.get(socket.id);
    if (client?.roomId) leaveRoom(socket, client.roomId);
  });

  socket.on('disconnect', () => {
    const client = clients.get(socket.id);
    if (client?.roomId) leaveRoom(socket, client.roomId);
    clients.delete(socket.id);
    console.log('Disconnected:', socket.id);
  });

  function leaveRoom(socket, roomId) {
    const room   = rooms.get(roomId);
    const client = clients.get(socket.id);
    if (room) {
      room.members.delete(socket.id);
      socket.to(roomId).emit('room-user-left', socket.id);
      socket.to(roomId).emit('voice-user-left', socket.id);
      socket.leave(roomId);
      // Удаляем пустые комнаты
      if (room.members.size === 0) {
        rooms.delete(roomId);
      }
      broadcastRoomList();
    }
    if (client) client.roomId = null;
  }
});

function shortId(id) { return id ? id.slice(0, 6) : '??'; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
