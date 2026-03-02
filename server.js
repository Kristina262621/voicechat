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
app.use(express.json({ limit: '110mb' }));

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
  maxHttpBufferSize: 110 * 1024 * 1024,
  transports:        ['websocket', 'polling'],
  allowUpgrades:     true,
  cors:              { origin: '*' }
});

// ════════════════════════════════════════════
//  ХРАНИЛИЩА
// ════════════════════════════════════════════
const rooms   = new Map();
const clients = new Map();
const users   = new Map();
const authTokens  = new Map();
const privateChats = new Map(); // chatId → { members, messages:[], createdAt }

const ROOM_EMPTY_TIMEOUT  = 60 * 60 * 1000;
const MAX_STORED_MESSAGES = 200; // макс сообщений на чат

// ════════════════════════════════════════════
//  RATE LIMITING
// ════════════════════════════════════════════
const bruteForceMap      = new Map();
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
  if (entry?.blockedUntil && now < entry.blockedUntil)
    return { blocked: true, secsLeft: Math.ceil((entry.blockedUntil - now) / 1000) };
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
function generateRoomId()  { return nodeCrypto.randomBytes(3).toString('hex').toUpperCase(); }
function generateToken()   { return nodeCrypto.randomBytes(32).toString('hex'); }
function generateChatId(a, b) { return [a, b].sort().join('::'); }
function shortId(id)       { return id ? id.slice(0, 6) : '??'; }

// ════════════════════════════════════════════
//  КОМНАТЫ
// ════════════════════════════════════════════
function getRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    const entry = {
      id,
      name:        room.name,
      hasPassword: !!room.passwordHash,
      photo:       room.photo || null,
      memberCount: room.members.size,
      createdAt:   room.createdAt,
      ownerId:     room.ownerNick || null,
      autoDelete:  room.autoDelete || null,
      joinMode:    room.joinMode || 'open'
    };
    if (room.members.size === 0 && room.emptyAt && room.autoDelete)
      entry.deleteAt = room.emptyAt + room.autoDelete;
    list.push(entry);
  }
  return list;
}
function broadcastRoomList() { io.emit('room-list', getRoomList()); }

function scheduleRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.autoDelete) { room.emptyAt = Date.now(); broadcastRoomList(); return; }
  if (room.emptyTimer) return;
  room.emptyAt    = Date.now();
  room.emptyTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.members.size === 0) { rooms.delete(roomId); broadcastRoomList(); }
  }, room.autoDelete);
  broadcastRoomList();
}
function cancelRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.emptyTimer) return;
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null; room.emptyAt = null;
  broadcastRoomList();
}

// ════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  clients.set(socket.id, { nickname: '', nickLower: '', roomId: null, authed: false });
  const clientIp = getClientIp(socket);

  socket.emit('room-list', getRoomList());

  // ════════════════════════════
  //  АУТЕНТИФИКАЦИЯ
  // ════════════════════════════
  socket.on('auth-register', ({ nickname, password, hint }, cb) => {
    const nick  = String(nickname || '').trim().slice(0, 32);
    const lower = nick.toLowerCase();
    if (!nick || nick.length < 2)  return cb({ ok: false, error: 'nick_short' });
    if (!password || password.length < 4) return cb({ ok: false, error: 'pw_short' });
    if (users.has(lower))          return cb({ ok: false, error: 'nick_taken' });

    const token = generateToken();
    users.set(lower, {
      nickname: nick,
      passwordHash: hashPassword(password),
      hint: String(hint || '').trim().slice(0, 100),
      avatar: null, bio: '',
      friends: [], friendRequests: [],
      createdAt: Date.now()
    });
    authTokens.set(token, lower);

    const client     = clients.get(socket.id);
    client.nickname  = nick;
    client.nickLower = lower;
    client.authed    = true;

    cb({ ok: true, token, nickname: nick, avatar: null });
  });

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

  socket.on('auth-logout', ({ token }, cb) => {
    if (token) authTokens.delete(token);
    const client = clients.get(socket.id);
    if (client) { client.authed = false; client.nickname = ''; client.nickLower = ''; }
    cb && cb({ ok: true });
  });

  socket.on('auth-get-hint', ({ nickname }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    const user  = users.get(lower);
    if (!user) return cb({ ok: false, error: 'not_found' });
    cb({ ok: true, hint: user.hint || '' });
  });

  // ════════════════════════════
  //  ПРОФИЛЬ
  // ════════════════════════════
  socket.on('profile-get', (cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb({ ok: false });
    cb({
      ok: true,
      nickname: user.nickname,
      avatar:   user.avatar || null,
      bio:      user.bio    || '',
      hint:     user.hint   || '',
      friends:  user.friends || [],
      friendRequests: user.friendRequests || []
    });
  });

  socket.on('profile-set-avatar', ({ avatar }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb({ ok: false });
    user.avatar = avatar || null;
    if (client.roomId) {
      socket.to(client.roomId).emit('user-avatar-updated', {
        nickLower: client.nickLower,
        nickname:  client.nickname,
        avatar:    user.avatar
      });
    }
    cb({ ok: true });
  });

  socket.on('profile-update', ({ nickname, bio }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb({ ok: false });
    if (bio !== undefined) user.bio = String(bio || '').slice(0, 200);
    if (nickname !== undefined) {
      const newNick = String(nickname || '').trim().slice(0, 32);
      if (newNick.length >= 2) { user.nickname = newNick; client.nickname = newNick; }
    }
    cb({ ok: true, nickname: user.nickname, bio: user.bio });
  });

  socket.on('profile-get-user', ({ nickname }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    const user  = users.get(lower);
    if (!user) return cb({ ok: false, error: 'not_found' });
    cb({ ok: true, nickname: user.nickname, avatar: user.avatar || null, bio: user.bio || '' });
  });

  // ════════════════════════════
  //  ДРУЗЬЯ
  // ════════════════════════════
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
    for (const [sid, cl] of clients) {
      if (cl.nickLower === toLower && cl.authed) {
        io.to(sid).emit('friend-request-incoming', {
          fromNick: fromUser.nickname, fromLower: client.nickLower, avatar: fromUser.avatar || null
        });
      }
    }
    cb({ ok: true });
  });

  socket.on('friend-respond', ({ fromNickname, accept }, cb) => {
    const client    = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const fromLower = String(fromNickname || '').trim().toLowerCase();
    const myUser    = users.get(client.nickLower);
    const fromUser  = users.get(fromLower);
    if (!fromUser) return cb({ ok: false, error: 'not_found' });

    myUser.friendRequests = myUser.friendRequests.filter(n => n !== fromLower);
    if (accept) {
      if (!myUser.friends.includes(fromLower))          myUser.friends.push(fromLower);
      if (!fromUser.friends.includes(client.nickLower)) fromUser.friends.push(client.nickLower);
      for (const [sid, cl] of clients) {
        if (cl.nickLower === fromLower && cl.authed) {
          io.to(sid).emit('friend-accepted', {
            byNick: myUser.nickname, byLower: client.nickLower, avatar: myUser.avatar || null
          });
        }
      }
    }
    cb({ ok: true });
  });

  socket.on('friend-remove', ({ nickname }, cb) => {
    const client    = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const lower     = String(nickname || '').trim().toLowerCase();
    const myUser    = users.get(client.nickLower);
    const theirUser = users.get(lower);
    if (myUser)    myUser.friends    = myUser.friends.filter(n => n !== lower);
    if (theirUser) theirUser.friends = theirUser.friends.filter(n => n !== client.nickLower);
    cb({ ok: true });
  });

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
  //  ЛИЧНЫЕ ЧАТЫ (с сохранением)
  // ════════════════════════════
  socket.on('private-chat-open', ({ withNickname }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const withLower = String(withNickname || '').trim().toLowerCase();
    const withUser  = users.get(withLower);
    if (!withUser) return cb({ ok: false, error: 'not_found' });
    if (withLower === client.nickLower) return cb({ ok: false, error: 'self' });

    const chatId = generateChatId(client.nickLower, withLower);
    if (!privateChats.has(chatId)) {
      privateChats.set(chatId, {
        id: chatId,
        members: [client.nickLower, withLower],
        messages: [],
        createdAt: Date.now()
      });
    }
    socket.join('pc:' + chatId);
    cb({ ok: true, chatId, withNickname: withUser.nickname, withAvatar: withUser.avatar || null });
  });

  socket.on('private-chat-list', (cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const list = [];
    for (const [id, chat] of privateChats) {
      if (chat.members.includes(client.nickLower)) {
        const otherLower = chat.members.find(m => m !== client.nickLower);
        const otherUser  = users.get(otherLower);
        const lastMsg    = chat.messages.length
          ? chat.messages[chat.messages.length - 1] : null;
        list.push({
          chatId:       id,
          withNickname: otherUser?.nickname || otherLower,
          withAvatar:   otherUser?.avatar   || null,
          withLower:    otherLower,
          createdAt:    chat.createdAt,
          lastMessage:  lastMsg
            ? { type: lastMsg.type, timestamp: lastMsg.timestamp }
            : null
        });
      }
    }
    list.sort((a, b) => {
      const ta = a.lastMessage?.timestamp || a.createdAt;
      const tb = b.lastMessage?.timestamp || b.createdAt;
      return tb - ta;
    });
    cb({ ok: true, chats: list });
  });

  // Получить историю личного чата
  socket.on('private-chat-history', ({ chatId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower))
      return cb && cb({ ok: false, error: 'not_member' });
    cb && cb({ ok: true, messages: chat.messages || [] });
  });

  // ── ИСПРАВЛЕНО: деструктуризация включает duration ──
  socket.on('private-message', async (
    { chatId, encrypted, iv, type, fileName, fileSize, mimeType, duration, seq },
    cb
  ) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower))
      return cb && cb({ ok: false, error: 'not_member' });

    const msg = {
      from:       client.nickLower,
      fromNick:   client.nickname,
      fromAvatar: users.get(client.nickLower)?.avatar || null,
      encrypted,
      iv,
      type:     type || 'text',
      fileName: fileName || null,
      fileSize: fileSize || null,
      mimeType: mimeType || null,
      duration: duration || 0,   // ← длительность голосового сообщения
      seq,
      timestamp: Date.now()
    };

    if (!chat.messages) chat.messages = [];
    chat.messages.push(msg);
    if (chat.messages.length > MAX_STORED_MESSAGES)
      chat.messages = chat.messages.slice(-MAX_STORED_MESSAGES);

    // Доставить всем в socket-комнате чата
    socket.to('pc:' + chatId).emit('private-message', { chatId, ...msg });

    // Убедиться что оффлайн-участник подключён к комнате
    const otherLower = chat.members.find(m => m !== client.nickLower);
    for (const [sid, cl] of clients) {
      if (cl.nickLower === otherLower && cl.authed) {
        io.in(sid).socketsJoin('pc:' + chatId);
      }
    }

    cb && cb({ ok: true, timestamp: msg.timestamp });
  });

  socket.on('private-chat-join', ({ chatId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false });
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower))
      return cb && cb({ ok: false });
    socket.join('pc:' + chatId);
    cb && cb({ ok: true });
  });
  // ════════════════════════════
  //  set-nickname (совместимость)
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
  socket.on('create-room', ({ name, password, photo, autoDelete, joinMode }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.nickname) return cb({ ok: false, error: 'no_nick' });
    const roomName = String(name || '').trim().slice(0, 50);
    if (!roomName) return cb({ ok: false, error: 'empty_name' });
    const id       = generateRoomId();
    const roomSalt = nodeCrypto.randomBytes(16).toString('hex');

    let autoDeleteMs = null;
    if (autoDelete && autoDelete !== 'never') {
      autoDeleteMs = parseInt(autoDelete);
      if (isNaN(autoDeleteMs) || autoDeleteMs < 0) autoDeleteMs = null;
    }

    rooms.set(id, {
      id, name: roomName,
      passwordHash: hashPassword(password || ''),
      photo: photo || null,
      ownerId:   socket.id,
      ownerNick: client.nickLower,
      members:   new Set(),
      pendingRequests: [],
      joinMode:  joinMode || 'open',
      autoDelete: autoDeleteMs,
      createdAt: Date.now(),
      emptyTimer: null, emptyAt: null,
      salt: roomSalt,
      lastSeq: new Map(),
      messages: [] // история группового чата
    });
    broadcastRoomList();
    cb({ ok: true, roomId: id, roomSalt });
  });

  socket.on('room-delete', ({ roomId }, cb) => {
    const client = clients.get(socket.id);
    const room   = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
      return cb({ ok: false, error: 'not_owner' });

    io.to(roomId).emit('room-deleted', { roomId, roomName: room.name });
    for (const sid of room.members) {
      const cl = clients.get(sid); if (cl) cl.roomId = null;
    }
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    rooms.delete(roomId);
    broadcastRoomList();
    cb({ ok: true });
  });

  socket.on('room-settings-update', ({ roomId, autoDelete, joinMode }, cb) => {
    const client = clients.get(socket.id);
    const room   = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
      return cb({ ok: false, error: 'not_owner' });

    if (autoDelete !== undefined) {
      let autoDeleteMs = null;
      if (autoDelete && autoDelete !== 'never') {
        autoDeleteMs = parseInt(autoDelete);
        if (isNaN(autoDeleteMs) || autoDeleteMs < 0) autoDeleteMs = null;
      }
      room.autoDelete = autoDeleteMs;
    }
    if (joinMode !== undefined)
      room.joinMode = joinMode === 'approval' ? 'approval' : 'open';

    broadcastRoomList();
    io.to(roomId).emit('room-settings-changed', {
      roomId, autoDelete: room.autoDelete, joinMode: room.joinMode
    });
    cb({ ok: true });
  });

  socket.on('room-rename', ({ roomId, newName }, cb) => {
    const client = clients.get(socket.id);
    const room   = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
      return cb({ ok: false, error: 'not_owner' });
    const name = String(newName || '').trim().slice(0, 50);
    if (!name) return cb({ ok: false, error: 'empty_name' });
    room.name = name;
    broadcastRoomList();
    io.to(roomId).emit('room-renamed', { roomId, newName: name });
    cb({ ok: true });
  });

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
    cb({ ok: true, members: list, pendingRequests: room.pendingRequests || [] });
  });

  // История группового чата
  socket.on('room-history', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false });
    cb && cb({ ok: true, messages: room.messages || [] });
  });

  // ════════════════════════════
  //  ЗАЯВКИ НА ВСТУПЛЕНИЕ
  // ════════════════════════════
  socket.on('room-request-join', ({ roomId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.joinMode !== 'approval') return cb({ ok: false, error: 'not_approval_mode' });
    if (room.members.has(socket.id)) return cb({ ok: false, error: 'already_member' });

    const already = room.pendingRequests.find(r => r.nickLower === client.nickLower);
    if (already) return cb({ ok: false, error: 'already_requested' });

    const user = users.get(client.nickLower);
    room.pendingRequests.push({
      nickLower: client.nickLower, nickname: client.nickname,
      avatar: user?.avatar || null, socketId: socket.id
    });

    for (const [sid, cl] of clients) {
      if (cl.nickLower === room.ownerNick && cl.authed) {
        io.to(sid).emit('room-join-request', {
          roomId, roomName: room.name,
          nickLower: client.nickLower, nickname: client.nickname,
          avatar: user?.avatar || null
        });
      }
    }
    cb({ ok: true });
  });

  socket.on('room-request-respond', ({ roomId, nickLower, accept }, cb) => {
    const client = clients.get(socket.id);
    const room   = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.ownerNick !== client.nickLower) return cb({ ok: false, error: 'not_owner' });

    const idx = room.pendingRequests.findIndex(r => r.nickLower === nickLower);
    if (idx === -1) return cb({ ok: false, error: 'not_found' });
    room.pendingRequests.splice(idx, 1);

    for (const [sid, cl] of clients) {
      if (cl.nickLower === nickLower) {
        if (accept) io.to(sid).emit('room-request-accepted', { roomId, roomName: room.name });
        else        io.to(sid).emit('room-request-declined', { roomId, roomName: room.name });
      }
    }
    cb({ ok: true });
  });

  socket.on('room-invite', ({ toNickname, roomId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'room_not_found' });
    const toLower = String(toNickname || '').trim().toLowerCase();
    let sent = false;
    for (const [sid, cl] of clients) {
      if (cl.nickLower === toLower && cl.authed) {
        io.to(sid).emit('room-invite', {
          fromNick: client.nickname, roomId: room.id, roomName: room.name,
          hasPassword: !!room.passwordHash, joinMode: room.joinMode
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

    if (room.joinMode === 'approval' && room.ownerNick !== client.nickLower && room.ownerId !== socket.id)
      return cb({ ok: false, error: 'approval_required' });

    if (client.roomId && client.roomId !== roomId) leaveRoom(socket, client.roomId);
    cancelRoomDelete(roomId);
    client.roomId = roomId;
    room.members.add(socket.id);
    socket.join(roomId);

    const others = [...room.members].filter(id => id !== socket.id).map(id => {
      const cl = clients.get(id);
      const u  = cl?.nickLower ? users.get(cl.nickLower) : null;
      return { id, nickname: cl?.nickname || shortId(id), avatar: u?.avatar || null };
    });

    socket.to(roomId).emit('room-user-joined', {
      id: socket.id, nickname: client.nickname,
      avatar: users.get(client.nickLower)?.avatar || null
    });

    broadcastRoomList();

    const isOwner = socket.id === room.ownerId || client.nickLower === room.ownerNick;

    cb({ ok: true, room: {
      id: room.id, name: room.name, photo: room.photo,
      members: others, roomSalt: room.salt,
      isOwner, autoDelete: room.autoDelete, joinMode: room.joinMode,
      pendingRequests: isOwner ? room.pendingRequests : []
    }});
  });

  // ════════════════════════════
  //  ЛИЧНЫЕ ЗВОНКИ
  // ════════════════════════════
  socket.on('private-call-offer', ({ chatId, to, offer }) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return;
    for (const [sid, cl] of clients) {
      if (cl.nickLower === to) {
        io.to(sid).emit('private-call-offer', {
          chatId, from: socket.id, fromNick: client.nickname,
          fromNickLower: client.nickLower,
          fromAvatar: users.get(client.nickLower)?.avatar || null,
          offer
        });
      }
    }
  });

  socket.on('private-call-answer', ({ to, answer }) => {
    io.to(to).emit('private-call-answer', { from: socket.id, answer });
  });

  socket.on('private-call-ice', ({ to, candidate }) => {
    // to может быть nickLower или socket.id
    // Сначала проверяем как socket.id
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ice', { from: socket.id, candidate });
    } else {
      // Ищем по nickLower
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to) {
          io.to(sid).emit('private-call-ice', { from: socket.id, candidate });
        }
      }
    }
  });

  socket.on('private-call-end', ({ to }) => {
    if (!to) return;
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ended', { from: socket.id });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to)
          io.to(sid).emit('private-call-ended', { from: socket.id });
      }
    }
  });

  socket.on('private-call-reject', ({ to }) => {
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-rejected', { from: socket.id });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to)
          io.to(sid).emit('private-call-rejected', { from: socket.id });
      }
    }
  });

    // ════════════════════════════
  //  ГОЛОС / ЧАТ
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
    const room = rooms.get(client.roomId);
    if (!room) return;
    const others = [...room.members]
      .filter(id => id !== socket.id)
      .map(id => ({
        id,
        nickname: clients.get(id)?.nickname || shortId(id)
      }));
    socket.to(client.roomId).emit('voice-user-joined', {
      id: socket.id,
      nickname: client.nickname
    });
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
    socket.to(client.roomId).emit('typing-start', {
      from: socket.id,
      nickname: client.nickname
    });
  });

  socket.on('typing-stop', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
  });

  socket.on('chat-message', (data) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;

    // Валидация seq
    const seqNum = parseInt(data.seq);
    if (!Number.isInteger(seqNum) || seqNum < 0) return;

    const room = rooms.get(client.roomId);
    if (!room) return;

    // Защита от дублей
    if (!room.lastSeq) room.lastSeq = new Map();
    const lastSeq = room.lastSeq.get(socket.id) || -1;
    if (seqNum <= lastSeq) return;
    room.lastSeq.set(socket.id, seqNum);

    const msg = {
      from:      socket.id,
      nickname:  client.nickname,
      encrypted: data.encrypted  || null,
      iv:        data.iv         || null,
      type:      data.type       || 'text',
      fileName:  data.fileName   || null,
      fileSize:  data.fileSize   || null,
      mimeType:  data.mimeType   || null,
      duration:  data.duration   || 0,    // ← длительность голосового сообщения
      seq:       seqNum,
      timestamp: Date.now()
    };

    // Сохранить в историю группы
    if (!room.messages) room.messages = [];
    room.messages.push(msg);
    if (room.messages.length > MAX_STORED_MESSAGES)
      room.messages = room.messages.slice(-MAX_STORED_MESSAGES);

    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
    socket.to(client.roomId).emit('chat-message', msg);
  });

  socket.on('understood', () => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    socket.to(client.roomId).emit('understood', {
      from: socket.id,
      nickname: client.nickname
    });
  });

  socket.on('ecdh-pubkey', ({ to, pubkey }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('ecdh-pubkey', {
      from: socket.id,
      pubkey,
      nickname: client.nickname
    });
  });

  socket.on('key-fingerprint', ({ to, fingerprint }) => {
    const client = clients.get(socket.id);
    if (!client?.roomId) return;
    io.to(to).emit('key-fingerprint', {
      from: socket.id,
      nickname: client.nickname,
      fingerprint
    });
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
      socket.to(roomId).emit('room-user-left',  socket.id);
      socket.to(roomId).emit('voice-user-left', socket.id);
      socket.to(roomId).emit('typing-stop',     { from: socket.id });
      socket.leave(roomId);
      if (room.members.size === 0) scheduleRoomDelete(roomId);
      else broadcastRoomList();
    }
    if (client) client.roomId = null;
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
