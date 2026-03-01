const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');
const nodeCrypto = require('crypto'); // встроенный Node.js crypto

const app = express();

// ════════════════════════════════════════════
//  7. CSP — Content Security Policy заголовки
// ════════════════════════════════════════════
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "media-src 'self' blob:; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' wss: ws:; " +
    "frame-ancestors 'none';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

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

const rooms   = new Map();
const clients = new Map();

const ROOM_EMPTY_TIMEOUT = 60 * 60 * 1000;

// ════════════════════════════════════════════
//  2. RATE LIMITING — защита от брутфорса
// ════════════════════════════════════════════
// Хранит: IP → { attempts, blockedUntil }
const bruteForceMap = new Map();

const BRUTE_MAX_ATTEMPTS = 5;    // попыток до блокировки
const BRUTE_WINDOW_MS    = 60 * 1000;   // окно 1 минута
const BRUTE_BLOCK_MS     = 5 * 60 * 1000; // блокировка 5 минут

function getClientIp(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address
    || 'unknown';
}

function checkBruteForce(ip) {
  const now  = Date.now();
  const entry = bruteForceMap.get(ip);

  if (entry?.blockedUntil && now < entry.blockedUntil) {
    const secsLeft = Math.ceil((entry.blockedUntil - now) / 1000);
    return { blocked: true, secsLeft };
  }

  return { blocked: false };
}

function recordFailedAttempt(ip) {
  const now   = Date.now();
  const entry = bruteForceMap.get(ip) || { attempts: 0, firstAttempt: now, blockedUntil: null };

  // Сбрасываем если прошло окно
  if (now - entry.firstAttempt > BRUTE_WINDOW_MS) {
    entry.attempts    = 0;
    entry.firstAttempt = now;
    entry.blockedUntil = null;
  }

  entry.attempts++;

  if (entry.attempts >= BRUTE_MAX_ATTEMPTS) {
    entry.blockedUntil = now + BRUTE_BLOCK_MS;
    console.log(`IP ${ip} blocked for brute force`);
  }

  bruteForceMap.set(ip, entry);
}

function recordSuccessAttempt(ip) {
  bruteForceMap.delete(ip);
}

// Чистим старые записи каждые 10 минут
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of bruteForceMap) {
    if (entry.blockedUntil && now > entry.blockedUntil + BRUTE_BLOCK_MS) {
      bruteForceMap.delete(ip);
    } else if (!entry.blockedUntil && now - entry.firstAttempt > BRUTE_WINDOW_MS * 2) {
      bruteForceMap.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// ════════════════════════════════════════════
//  1. SHA-256 хеш пароля (вместо слабого хеша)
// ════════════════════════════════════════════
function hashPassword(pw) {
  if (!pw) return null;
  // SHA-256 через встроенный Node.js crypto — без зависимостей
  return nodeCrypto.createHash('sha256').update(pw + 'voicechat-pw-salt-v1').digest('hex');
}

function generateRoomId() {
  // Криптографически случайный ID вместо Math.random()
  return nodeCrypto.randomBytes(3).toString('hex').toUpperCase();
}

function getRoomList() {
  const list = [];
  const now  = Date.now();
  for (const [id, room] of rooms) {
    const entry = {
      id,
      name:        room.name,
      hasPassword: !!room.passwordHash,
      photo:       room.photo || null,
      memberCount: room.members.size,
      createdAt:   room.createdAt
    };
    if (room.members.size === 0 && room.emptyAt) {
      const msLeft = ROOM_EMPTY_TIMEOUT - (now - room.emptyAt);
      entry.deleteAt = now + Math.max(0, msLeft);
    }
    list.push(entry);
  }
  return list;
}

function broadcastRoomList() {
  io.emit('room-list', getRoomList());
}

function scheduleRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.emptyTimer) return;
  room.emptyAt    = Date.now();
  room.emptyTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.members.size === 0) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted after 60min empty`);
      broadcastRoomList();
    }
  }, ROOM_EMPTY_TIMEOUT);
  broadcastRoomList();
}

function cancelRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
    room.emptyAt    = null;
    broadcastRoomList();
  }
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  clients.set(socket.id, { nickname: '', roomId: null });

  const clientIp = getClientIp(socket);

  // ── Установить ник ──
  socket.on('set-nickname', (nickname, cb) => {
    const nick = String(nickname || '').trim().slice(0, 32);
    if (!nick) { cb && cb({ ok: false, error: 'empty' }); return; }
    clients.get(socket.id).nickname = nick;
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

    // ── 3. Соль комнаты для усиления ключа шифрования ──
    // Генерируем случайную соль — клиент получит её и использует в PBKDF2
    const roomSalt = nodeCrypto.randomBytes(16).toString('hex');

    rooms.set(id, {
      id,
      name:         roomName,
      passwordHash: hashPassword(password || ''),
      photo:        photo || null,
      ownerId:      socket.id,
      members:      new Set(),
      createdAt:    Date.now(),
      emptyTimer:   null,
      emptyAt:      null,
      salt:         roomSalt,   // уникальная соль для ключа шифрования
    });

    broadcastRoomList();
    // Возвращаем соль создателю
    cb && cb({ ok: true, roomId: id, roomSalt });
  });

  // ── Войти в комнату ──
  socket.on('join-room', ({ roomId, password }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.nickname) { cb && cb({ ok: false, error: 'no_nick' }); return; }

    const room = rooms.get(roomId);
    if (!room) { cb && cb({ ok: false, error: 'not_found' }); return; }

    // ── 2. Проверка rate limiting ──
    const bf = checkBruteForce(clientIp);
    if (bf.blocked) {
      cb && cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });
      return;
    }

    if (room.passwordHash) {
      const inputHash = hashPassword(password || '');
      if (inputHash !== room.passwordHash) {
        recordFailedAttempt(clientIp);
        setTimeout(() => cb && cb({ ok: false, error: 'wrong_password' }), 800);
        return;
      }
    }

    // Успешный вход — сбрасываем счётчик
    recordSuccessAttempt(clientIp);

    if (client.roomId && client.roomId !== roomId) {
      leaveRoom(socket, client.roomId);
    }

    cancelRoomDelete(roomId);
    client.roomId = roomId;
    room.members.add(socket.id);
    socket.join(roomId);

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

    // Передаём соль комнаты — клиент использует её для генерации ключа
    cb && cb({ ok: true, room: {
      id:       room.id,
      name:     room.name,
      photo:    room.photo,
      members:  membersInfo,
      roomSalt: room.salt   // соль для шифрования
    }});
  });

  // ── WebRTC сигнализация ──
  socket.on('offer', ({ to, offer }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('offer', { from: socket.id, offer, nickname: client.nickname });
  });

  socket.on('answer', ({ to, answer }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('answer', { from: socket.id, answer, nickname: client.nickname });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Голосовой чат ──
  socket.on('voice-join', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    const room = rooms.get(client.roomId);
    if (!room) return;
    const others = [...room.members].filter(id => id !== socket.id);
    socket.to(client.roomId).emit('voice-user-joined', {
      id:       socket.id,
      nickname: client.nickname
    });
    const othersWithNicks = others.map(id => ({
      id,
      nickname: clients.get(id)?.nickname || shortId(id)
    }));
    socket.emit('existing-voice-users', othersWithNicks);
  });

  socket.on('voice-leave', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('voice-user-left', socket.id);
  });

  // ── Статус «печатает» ──
  socket.on('typing-start', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId || !client.nickname) return;
    socket.to(client.roomId).emit('typing-start', {
      from:     socket.id,
      nickname: client.nickname
    });
  });

  socket.on('typing-stop', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
  });

  // ── Чат-сообщение ──
  // 9. Сервер НИКОГДА не логирует содержимое сообщений
  socket.on('chat-message', (data) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;

    // 6. Защита от replay-атак: проверяем порядковый номер
    const seqNum = parseInt(data.seq);
    if (!Number.isInteger(seqNum) || seqNum < 0) return;

    const room = rooms.get(client.roomId);
    if (!room) return;

    // Проверяем что номер больше последнего для этого клиента
    if (!room.lastSeq) room.lastSeq = new Map();
    const lastSeq = room.lastSeq.get(socket.id) || -1;
    if (seqNum <= lastSeq) {
      // Replay-атака или дубликат — отбрасываем
      console.log(`Replay detected from ${socket.id}: seq ${seqNum} <= ${lastSeq}`);
      return;
    }
    room.lastSeq.set(socket.id, seqNum);

    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
    socket.to(client.roomId).emit('chat-message', {
      from:      socket.id,
      nickname:  client.nickname,
      encrypted: data.encrypted,
      iv:        data.iv,
      type:      data.type,
      fileName:  data.fileName,
      fileSize:  data.fileSize,
      mimeType:  data.mimeType,
      seq:       seqNum,
      timestamp: Date.now()
      // содержимое НЕ логируется — только пересылается
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

  // ── ECDH: обмен публичными ключами для Forward Secrecy ──
  // 4. Клиент отправляет свой публичный ECDH ключ другому участнику
  socket.on('ecdh-pubkey', ({ to, pubkey }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    // Просто пересылаем — сервер ключ не видит и не хранит
    io.to(to).emit('ecdh-pubkey', { from: socket.id, pubkey, nickname: client.nickname });
  });

  // 5. Верификация: обмен отпечатками ключей
  socket.on('key-fingerprint', ({ to, fingerprint }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('key-fingerprint', {
      from:        socket.id,
      nickname:    client.nickname,
      fingerprint
    });
  });

  // ── Покинуть комнату ──
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
      // 9. Очищаем счётчик seq при выходе
      if (room.lastSeq) room.lastSeq.delete(socket.id);
      socket.to(roomId).emit('room-user-left', socket.id);
      socket.to(roomId).emit('voice-user-left', socket.id);
      socket.to(roomId).emit('typing-stop', { from: socket.id });
      socket.leave(roomId);
      if (room.members.size === 0) {
        scheduleRoomDelete(roomId);
      } else {
        broadcastRoomList();
      }
    }
    if (client) client.roomId = null;
  }
});

function shortId(id) { return id ? id.slice(0, 6) : '??'; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
