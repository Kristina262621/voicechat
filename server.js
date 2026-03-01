const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');
const nodeCrypto = require('crypto');

const app = express();

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

// ════════════════════════════════════════════
//  ХРАНИЛИЩА
// ════════════════════════════════════════════
const rooms   = new Map(); // roomId → room
const clients = new Map(); // socketId → client

// База пользователей: nickname(lower) → userData
const users = new Map();
// Токены автовхода: token → nickname(lower)
const authTokens = new Map();

const ROOM_EMPTY_TIMEOUT = 60 * 60 * 1000;

// ════════════════════════════════════════════
//  RATE LIMITING
// ════════════════════════════════════════════
const bruteForceMap = new Map();
const BRUTE_MAX_ATTEMPTS = 5;
const BRUTE_WINDOW_MS    = 60 * 1000;
const BRUTE_BLOCK_MS     = 5 * 60 * 1000;

function getClientIp(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address || 'unknown';
}
function checkBruteForce(ip) {
  const now   = Date.now();
  const entry = bruteForceMap.get(ip);
  if (entry?.blockedUntil && now < entry.blockedUntil) {
    return { blocked: true, secsLeft: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  return { blocked: false };
}
function recordFailedAttempt(ip) {
  const now   = Date.now();
  const entry = bruteForceMap.get(ip) || { attempts: 0, firstAttempt: now, blockedUntil: null };
  if (now - entry.firstAttempt > BRUTE_WINDOW_MS) {
    entry.attempts = 0; entry.firstAttempt = now; entry.blockedUntil = null;
  }
  entry.attempts++;
  if (entry.attempts >= BRUTE_MAX_ATTEMPTS) entry.blockedUntil = now + BRUTE_BLOCK_MS;
  bruteForceMap.set(ip, entry);
}
function recordSuccessAttempt(ip) { bruteForceMap.delete(ip); }

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of bruteForceMap) {
    if (entry.blockedUntil && now > entry.blockedUntil + BRUTE_BLOCK_MS) bruteForceMap.delete(ip);
    else if (!entry.blockedUntil && now - entry.firstAttempt > BRUTE_WINDOW_MS * 2) bruteForceMap.delete(ip);
  }
}, 10 * 60 * 1000);

// ════════════════════════════════════════════
//  УТИЛИТЫ
// ════════════════════════════════════════════
function hashPassword(pw) {
  if (!pw) return null;
  return nodeCrypto.createHash('sha256').update(pw + 'voicechat-pw-salt-v1').digest('hex');
}
function generateRoomId() {
  return nodeCrypto.randomBytes(3).toString('hex').toUpperCase();
}
function generateToken() {
  return nodeCrypto.randomBytes(32).toString('hex');
}

// ════════════════════════════════════════════
//  КОМНАТЫ
// ════════════════════════════════════════════
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
      createdAt:   room.createdAt,
      ownerId:     room.ownerNick || null
    };
    if (room.members.size === 0 && room.emptyAt) {
      entry.deleteAt = now + Math.max(0, ROOM_EMPTY_TIMEOUT - (now - room.emptyAt));
    }
    list.push(entry);
  }
  return list;
}
function broadcastRoomList() { io.emit('room-list', getRoomList()); }

function scheduleRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.emptyTimer) return;
  room.emptyAt    = Date.now();
  room.emptyTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.members.size === 0) { rooms.delete(roomId); broadcastRoomList(); }
  }, ROOM_EMPTY_TIMEOUT);
  broadcastRoomList();
}
function cancelRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.emptyTimer) return;
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null;
  room.emptyAt    = null;
  broadcastRoomList();
}

// ════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  clients.set(socket.id, { nickname: '', nickLower: '', roomId: null, authed: false });
  const clientIp = getClientIp(socket);

  // ── Отправить список комнат без авторизации ──
  socket.emit('room-list', getRoomList());

  // ════════════════════════════
  //  АУТЕНТИФИКАЦИЯ
  // ════════════════════════════

  // Регистрация
  socket.on('auth-register', ({ nickname, password, hint }, cb) => {
    const nick  = String(nickname || '').trim().slice(0, 32);
    const lower = nick.toLowerCase();
    if (!nick || nick.length < 2)
      return cb({ ok: false, error: 'nick_short' });
    if (!password || password.length < 4)
      return cb({ ok: false, error: 'pw_short' });
    if (users.has(lower))
      return cb({ ok: false, error: 'nick_taken' });

    const token = generateToken();
    users.set(lower, {
      nickname: nick,
      passwordHash: hashPassword(password),
      hint: String(hint || '').trim().slice(0, 100),
      avatar: null,
      friends: [],       // [nickLower, ...]
      friendRequests: [], // входящие
      createdAt: Date.now()
    });
    authTokens.set(token, lower);

    const client     = clients.get(socket.id);
    client.nickname  = nick;
    client.nickLower = lower;
    client.authed    = true;

    cb({ ok: true, token, nickname: nick, avatar: null });
  });

  // Вход по паролю
  socket.on('auth-login', ({ nickname, password }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    const bf    = checkBruteForce(clientIp + ':login');
    if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });

    const user = users.get(lower);
    if (!user || user.passwordHash !== hashPassword(password)) {
      recordFailedAttempt(clientIp + ':login');
      return setTimeout(() => cb({ ok: false, error: 'wrong_creds' }), 800);
    }
    recordSuccessAttempt(clientIp + ':login');

    const token = generateToken();
    authTokens.set(token, lower);

    const client     = clients.get(socket.id);
    client.nickname  = user.nickname;
    client.nickLower = lower;
    client.authed    = true;

    cb({ ok: true, token, nickname: user.nickname, avatar: user.avatar || null });
  });

  // Авто-вход по токену
  socket.on('auth-token', ({ token }, cb) => {
    const lower = authTokens.get(token);
    const user  = lower ? users.get(lower) : null;
    if (!user) return cb({ ok: false, error: 'invalid_token' });

    const client     = clients.get(socket.id);
    client.nickname  = user.nickname;
    client.nickLower = lower;
    client.authed    = true;

    cb({ ok: true, nickname: user.nickname, avatar: user.avatar || null });
  });

  // Выход
  socket.on('auth-logout', ({ token }, cb) => {
    if (token) authTokens.delete(token);
    const client = clients.get(socket.id);
    if (client) { client.authed = false; client.nickname = ''; client.nickLower = ''; }
    cb && cb({ ok: true });
  });

  // Подсказка пароля
  socket.on('auth-get-hint', ({ nickname }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    const user  = users.get(lower);
    if (!user) return cb({ ok: false, error: 'not_found' });
    cb({ ok: true, hint: user.hint || '' });
  });

  // ════════════════════════════
  //  ПРОФИЛЬ
  // ════════════════════════════

  // Получить свой профиль
  socket.on('profile-get', (cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb({ ok: false });
    cb({
      ok: true,
      nickname: user.nickname,
      avatar:   user.avatar || null,
      hint:     user.hint   || '',
      friends:  user.friends || [],
      friendRequests: user.friendRequests || []
    });
  });

  // Обновить аватар
  socket.on('profile-set-avatar', ({ avatar }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb({ ok: false });
    user.avatar = avatar || null;
    // Уведомить всех в комнате об обновлении аватара
    if (client.roomId) {
      socket.to(client.roomId).emit('user-avatar-updated', {
        nickLower: client.nickLower,
        nickname:  client.nickname,
        avatar:    user.avatar
      });
    }
    cb({ ok: true });
  });

  // Получить профиль другого пользователя
  socket.on('profile-get-user', ({ nickname }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    const user  = users.get(lower);
    if (!user) return cb({ ok: false, error: 'not_found' });
    cb({
      ok:       true,
      nickname: user.nickname,
      avatar:   user.avatar || null
    });
  });

  // ════════════════════════════
  //  ДРУЗЬЯ
  // ════════════════════════════

  // Отправить запрос в друзья
  socket.on('friend-request', ({ toNickname }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const toLower  = String(toNickname || '').trim().toLowerCase();
    const fromUser = users.get(client.nickLower);
    const toUser   = users.get(toLower);
    if (!toUser)                            return cb({ ok: false, error: 'not_found' });
    if (toLower === client.nickLower)       return cb({ ok: false, error: 'self' });
    if (fromUser.friends.includes(toLower)) return cb({ ok: false, error: 'already_friends' });
    if (toUser.friendRequests.includes(client.nickLower))
      return cb({ ok: false, error: 'already_sent' });

    toUser.friendRequests.push(client.nickLower);

    // Уведомить онлайн пользователя
    for (const [sid, cl] of clients) {
      if (cl.nickLower === toLower && cl.authed) {
        io.to(sid).emit('friend-request-incoming', {
          fromNick: fromUser.nickname,
          fromLower: client.nickLower,
          avatar:   fromUser.avatar || null
        });
      }
    }
    cb({ ok: true });
  });

  // Принять / отклонить запрос
  socket.on('friend-respond', ({ fromNickname, accept }, cb) => {
    const client   = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const fromLower = String(fromNickname || '').trim().toLowerCase();
    const myUser    = users.get(client.nickLower);
    const fromUser  = users.get(fromLower);
    if (!fromUser) return cb({ ok: false, error: 'not_found' });

    myUser.friendRequests = myUser.friendRequests.filter(n => n !== fromLower);
    if (accept) {
      if (!myUser.friends.includes(fromLower))   myUser.friends.push(fromLower);
      if (!fromUser.friends.includes(client.nickLower)) fromUser.friends.push(client.nickLower);
      // Уведомить того кто отправил
      for (const [sid, cl] of clients) {
        if (cl.nickLower === fromLower && cl.authed) {
          io.to(sid).emit('friend-accepted', {
            byNick:  myUser.nickname,
            byLower: client.nickLower,
            avatar:  myUser.avatar || null
          });
        }
      }
    }
    cb({ ok: true });
  });

  // Удалить из друзей
  socket.on('friend-remove', ({ nickname }, cb) => {
    const client  = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const lower   = String(nickname || '').trim().toLowerCase();
    const myUser  = users.get(client.nickLower);
    const theirUser = users.get(lower);
    if (myUser)    myUser.friends    = myUser.friends.filter(n => n !== lower);
    if (theirUser) theirUser.friends = theirUser.friends.filter(n => n !== client.nickLower);
    cb({ ok: true });
  });

  // Список друзей с данными
  socket.on('friends-list', (cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const myUser = users.get(client.nickLower);
    if (!myUser) return cb({ ok: false });
    const list = myUser.friends.map(lower => {
      const u = users.get(lower);
      return u ? { nickname: u.nickname, avatar: u.avatar || null, lower } : null;
    }).filter(Boolean);
    cb({ ok: true, friends: list, requests: myUser.friendRequests.map(lower => {
      const u = users.get(lower);
      return u ? { nickname: u.nickname, avatar: u.avatar || null, lower } : null;
    }).filter(Boolean) });
  });

  // ════════════════════════════
  //  СОВМЕСТИМОСТЬ: set-nickname
  // ════════════════════════════
  socket.on('set-nickname', (nickname, cb) => {
    const client = clients.get(socket.id);
    if (client?.authed) {
      socket.emit('room-list', getRoomList());
      return cb && cb({ ok: true });
    }
    const nick = String(nickname || '').trim().slice(0, 32);
    if (!nick) { cb && cb({ ok: false, error: 'empty' }); return; }
    client.nickname  = nick;
    client.nickLower = nick.toLowerCase();
    socket.emit('room-list', getRoomList());
    cb && cb({ ok: true });
  });

  // ════════════════════════════
  //  КОМНАТЫ
  // ════════════════════════════
  socket.on('create-room', ({ name, password, photo }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.nickname) return cb({ ok: false, error: 'no_nick' });
    const roomName = String(name || '').trim().slice(0, 50);
    if (!roomName) return cb({ ok: false, error: 'empty_name' });
    const id       = generateRoomId();
    const roomSalt = nodeCrypto.randomBytes(16).toString('hex');
    rooms.set(id, {
      id, name: roomName,
      passwordHash: hashPassword(password || ''),
      photo: photo || null,
      ownerId:   socket.id,
      ownerNick: client.nickLower,
      members:   new Set(),
      createdAt: Date.now(),
      emptyTimer: null, emptyAt: null,
      salt: roomSalt,
      lastSeq: new Map()
    });
    broadcastRoomList();
    cb({ ok: true, roomId: id, roomSalt });
  });

  // Переименование комнаты (только создатель)
  socket.on('room-rename', ({ roomId, newName }, cb) => {
    const client = clients.get(socket.id);
    const room   = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    // Проверяем: либо socketId совпадает, либо nickLower совпадает
    if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
      return cb({ ok: false, error: 'not_owner' });
    const name = String(newName || '').trim().slice(0, 50);
    if (!name) return cb({ ok: false, error: 'empty_name' });
    room.name = name;
    broadcastRoomList();
    io.to(roomId).emit('room-renamed', { roomId, newName: name });
    cb({ ok: true });
  });

  // Список участников комнаты
  socket.on('room-members', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    const list = [...room.members].map(sid => {
      const cl = clients.get(sid);
      const u  = cl?.nickLower ? users.get(cl.nickLower) : null;
      return {
        id:       sid,
        nickname: cl?.nickname || shortId(sid),
        avatar:   u?.avatar || null,
        isOwner:  sid === room.ownerId || (cl?.nickLower && cl.nickLower === room.ownerNick)
      };
    });
    cb({ ok: true, members: list });
  });

  // Пригласить в комнату (отправить уведомление)
  socket.on('room-invite', ({ toNickname, roomId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'room_not_found' });
    const toLower = String(toNickname || '').trim().toLowerCase();
    // Найти сокет получателя
    let sent = false;
    for (const [sid, cl] of clients) {
      if (cl.nickLower === toLower && cl.authed) {
        io.to(sid).emit('room-invite', {
          fromNick:  client.nickname,
          roomId:    room.id,
          roomName:  room.name,
          hasPassword: !!room.passwordHash
        });
        sent = true;
      }
    }
    cb({ ok: true, online: sent });
  });

  // ════════════════════════════
  //  ВХОД В КОМНАТУ
  // ════════════════════════════
  socket.on('join-room', ({ roomId, password }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.nickname) return cb({ ok: false, error: 'no_nick' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });

    const bf = checkBruteForce(clientIp);
    if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });

    if (room.passwordHash) {
      if (hashPassword(password || '') !== room.passwordHash) {
        recordFailedAttempt(clientIp);
        return setTimeout(() => cb({ ok: false, error: 'wrong_password' }), 800);
      }
    }
    recordSuccessAttempt(clientIp);

    if (client.roomId && client.roomId !== roomId) leaveRoom(socket, client.roomId);
    cancelRoomDelete(roomId);
    client.roomId = roomId;
    room.members.add(socket.id);
    socket.join(roomId);

    const others = [...room.members]
      .filter(id => id !== socket.id)
      .map(id => {
        const cl = clients.get(id);
        const u  = cl?.nickLower ? users.get(cl.nickLower) : null;
        return { id, nickname: cl?.nickname || shortId(id), avatar: u?.avatar || null };
      });

    socket.to(roomId).emit('room-user-joined', {
      id: socket.id, nickname: client.nickname,
      avatar: (() => { const u = users.get(client.nickLower); return u?.avatar || null; })()
    });

    broadcastRoomList();

    const myUser    = client.nickLower ? users.get(client.nickLower) : null;
    const isOwner   = socket.id === room.ownerId || client.nickLower === room.ownerNick;

    cb({ ok: true, room: {
      id: room.id, name: room.name, photo: room.photo,
      members: others, roomSalt: room.salt,
      isOwner
    }});
  });

  // ════════════════════════════
  //  ЧАТ: СОВМЕСТИМОСТЬ
  // ════════════════════════════
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
  socket.on('voice-join', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    const room   = rooms.get(client.roomId);
    if (!room) return;
    const others = [...room.members].filter(id => id !== socket.id).map(id => ({
      id, nickname: clients.get(id)?.nickname || shortId(id)
    }));
    socket.to(client.roomId).emit('voice-user-joined', { id: socket.id, nickname: client.nickname });
    socket.emit('existing-voice-users', others);
  });
  socket.on('voice-leave', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('voice-user-left', socket.id);
  });
  socket.on('typing-start', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId || !client.nickname) return;
    socket.to(client.roomId).emit('typing-start', { from: socket.id, nickname: client.nickname });
  });
  socket.on('typing-stop', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
  });
  socket.on('chat-message', (data) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    const seqNum = parseInt(data.seq);
    if (!Number.isInteger(seqNum) || seqNum < 0) return;
    const room = rooms.get(client.roomId);
    if (!room) return;
    if (!room.lastSeq) room.lastSeq = new Map();
    const lastSeq = room.lastSeq.get(socket.id) || -1;
    if (seqNum <= lastSeq) return;
    room.lastSeq.set(socket.id, seqNum);
    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
    socket.to(client.roomId).emit('chat-message', {
      from: socket.id, nickname: client.nickname,
      encrypted: data.encrypted, iv: data.iv, type: data.type,
      fileName: data.fileName, fileSize: data.fileSize, mimeType: data.mimeType,
      seq: seqNum, timestamp: Date.now()
    });
  });
  socket.on('understood', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('understood', { from: socket.id, nickname: client.nickname });
  });
  socket.on('ecdh-pubkey', ({ to, pubkey }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('ecdh-pubkey', { from: socket.id, pubkey, nickname: client.nickname });
  });
  socket.on('key-fingerprint', ({ to, fingerprint }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('key-fingerprint', { from: socket.id, nickname: client.nickname, fingerprint });
  });
  socket.on('leave-room', () => {
    const client = clients.get(socket.id);
    if (client?.roomId) leaveRoom(socket, client.roomId);
  });
  socket.on('disconnect', () => {
    const client = clients.get(socket.id);
    if (client?.roomId) leaveRoom(socket, client.roomId);
    clients.delete(socket.id);
  });

  function leaveRoom(socket, roomId) {
    const room   = rooms.get(roomId);
    const client = clients.get(socket.id);
    if (room) {
      room.members.delete(socket.id);
      if (room.lastSeq) room.lastSeq.delete(socket.id);
      socket.to(roomId).emit('room-user-left', socket.id);
      socket.to(roomId).emit('voice-user-left', socket.id);
      socket.to(roomId).emit('typing-stop', { from: socket.id });
      socket.leave(roomId);
      if (room.members.size === 0) scheduleRoomDelete(roomId);
      else broadcastRoomList();
    }
    if (client) client.roomId = null;
  }
});

function shortId(id) { return id ? id.slice(0, 6) : '??'; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
