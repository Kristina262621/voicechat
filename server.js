const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');
const nodeCrypto = require('crypto');

const app = express();

app.use((req, res, next) => {
  // ИСПРАВЛЕНО: убрали запрет микрофона и камеры из Permissions-Policy
  // Теперь разрешаем camera и microphone (пустое значение = разрешено запрашивать)
  res.setHeader('Permissions-Policy', 'geolocation=()');

  // ИСПРАВЛЕНО: добавили mediastream и разрешили нужные источники в CSP
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "media-src 'self' blob: mediastream:; " +
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
const rooms        = new Map();
const clients      = new Map();
const users        = new Map();
const authTokens   = new Map();
const privateChats = new Map();
const groupMembership = new Map();

const ROOM_EMPTY_TIMEOUT  = 60 * 60 * 1000;
const MAX_STORED_MESSAGES = 200;

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
  const salt   = 'voicechat-pw-salt-v2-' + pw.slice(0, 2);
  return nodeCrypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
}

const HINT_SECRET = 'privchat-hint-encryption-key-v2';
function encryptHint(text) {
  if (!text) return '';
  try {
    const key = nodeCrypto.createHash('sha256').update(HINT_SECRET).digest();
    const iv  = nodeCrypto.randomBytes(16);
    const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) { return ''; }
}
function decryptHint(encrypted) {
  if (!encrypted) return '';
  try {
    const [ivHex, dataHex] = encrypted.split(':');
    if (!ivHex || !dataHex) return '';
    const key  = nodeCrypto.createHash('sha256').update(HINT_SECRET).digest();
    const iv   = Buffer.from(ivHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) { return ''; }
}

function generateRoomId()  { return nodeCrypto.randomBytes(3).toString('hex').toUpperCase(); }
function generateToken()   { return nodeCrypto.randomBytes(32).toString('hex'); }
function generateChatId(a, b) { return [a, b].sort().join('::'); }
function shortId(id)       { return id ? id.slice(0, 6) : '??'; }
function generateMsgId()   { return nodeCrypto.randomBytes(8).toString('hex'); }

// ════════════════════════════════════════════
//  ЧЛЕНСТВО В ГРУППАХ
// ════════════════════════════════════════════
function addGroupMember(nickLower, roomId) {
  if (!groupMembership.has(nickLower)) groupMembership.set(nickLower, new Set());
  groupMembership.get(nickLower).add(roomId);
}
function removeGroupMember(nickLower, roomId) {
  groupMembership.get(nickLower)?.delete(roomId);
}
function getUserGroups(nickLower) {
  return [...(groupMembership.get(nickLower) || [])];
}

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
  socket.on('auth-register', ({ nickname, password, hint, phone, username }, cb) => {
    const nick  = String(nickname || '').trim().slice(0, 32);
    const uname = String(username || nick).trim().slice(0, 32).toLowerCase().replace(/[^a-z0-9_]/g, '');
    const lower = nick.toLowerCase();
    if (!nick || nick.length < 2)       return cb({ ok: false, error: 'nick_short' });
    if (!password || password.length < 4) return cb({ ok: false, error: 'pw_short' });
    if (users.has(lower))               return cb({ ok: false, error: 'nick_taken' });
    if (uname && uname !== lower && users.has(uname)) return cb({ ok: false, error: 'username_taken' });

    const token = generateToken();
    users.set(lower, {
      nickname:     nick,
      username:     uname || lower,
      passwordHash: hashPassword(password),
      hint:         encryptHint(String(hint || '').trim().slice(0, 100)),
      phone:        String(phone || '').trim().slice(0, 20),
      avatar:       null,
      bio:          '',
      friends:      [],
      friendRequests: [],
      blocked:      [],
      privacy: {
        phoneVisibility:     'nobody',
        lastSeenVisibility:  'nobody',
        avatarVisibility:    'all',
        forwardVisibility:   'nobody',
        callsVisibility:     'nobody',
        autoDeleteAccount:   '12months',
        syncContacts:        false,
        suggestContacts:     false,
        secretChatLinkPreview: false,
        secretChatMapPreview:  false,
        cloudPassword:       false,
        autoDeleteMessages:  false,
        passcodeLock:        false,
      },
      createdAt: Date.now()
    });
    authTokens.set(token, lower);

    const client     = clients.get(socket.id);
    client.nickname  = nick;
    client.nickLower = lower;
    client.authed    = true;

    cb({ ok: true, token, nickname: nick, username: uname || lower, avatar: null });
  });

  socket.on('auth-login', ({ nickname, password }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    const bf    = checkBruteForce(clientIp + ':login');
    if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });

    let userKey = lower;
    if (!users.has(lower)) {
      for (const [k, u] of users) {
        if (u.username === lower) { userKey = k; break; }
      }
    }

    const user = users.get(userKey);
    if (!user || user.passwordHash !== hashPassword(password)) {
      recordFailedAttempt(clientIp + ':login');
      return setTimeout(() => cb({ ok: false, error: 'wrong_creds' }), 800);
    }
    recordSuccessAttempt(clientIp + ':login');

    const token = generateToken();
    authTokens.set(token, userKey);

    const client     = clients.get(socket.id);
    client.nickname  = user.nickname;
    client.nickLower = userKey;
    client.authed    = true;

    const myGroups = getUserGroups(userKey);
    for (const roomId of myGroups) {
      const room = rooms.get(roomId);
      if (room) socket.join(roomId);
    }

    cb({ ok: true, token, nickname: user.nickname, username: user.username || userKey, avatar: user.avatar || null });
  });

  socket.on('auth-token', ({ token }, cb) => {
    const lower = authTokens.get(token);
    const user  = lower ? users.get(lower) : null;
    if (!user) return cb({ ok: false, error: 'invalid_token' });

    const client     = clients.get(socket.id);
    client.nickname  = user.nickname;
    client.nickLower = lower;
    client.authed    = true;

    const myGroups = getUserGroups(lower);
    for (const roomId of myGroups) {
      const room = rooms.get(roomId);
      if (room) socket.join(roomId);
    }

    cb({ ok: true, nickname: user.nickname, username: user.username || lower, avatar: user.avatar || null });
  });

  socket.on('auth-logout', ({ token }, cb) => {
    if (token) authTokens.delete(token);
    const client = clients.get(socket.id);
    if (client) { client.authed = false; client.nickname = ''; client.nickLower = ''; }
    cb && cb({ ok: true });
  });

  socket.on('auth-get-hint', ({ nickname }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    let userKey = lower;
    if (!users.has(lower)) {
      for (const [k, u] of users) {
        if (u.username === lower) { userKey = k; break; }
      }
    }
    const user = users.get(userKey);
    if (!user) return cb({ ok: false, error: 'not_found' });
    const hint = decryptHint(user.hint);
    cb({ ok: true, hint: hint || '' });
  });

  socket.on('auth-reset-password', ({ phone, newPassword }, cb) => {
    const bf = checkBruteForce(clientIp + ':reset');
    if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });
    if (!phone || !newPassword || newPassword.length < 4)
      return cb({ ok: false, error: 'invalid' });
    for (const [key, user] of users) {
      if (user.phone && user.phone === phone.trim()) {
        user.passwordHash = hashPassword(newPassword);
        recordSuccessAttempt(clientIp + ':reset');
        return cb({ ok: true });
      }
    }
    recordFailedAttempt(clientIp + ':reset');
    setTimeout(() => cb({ ok: false, error: 'not_found' }), 800);
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
      ok:       true,
      nickname: user.nickname,
      username: user.username || client.nickLower,
      avatar:   user.avatar || null,
      bio:      user.bio    || '',
      phone:    user.phone  || '',
      hint:     decryptHint(user.hint) || '',
      friends:  user.friends || [],
      friendRequests: user.friendRequests || [],
      blocked:  user.blocked || [],
      privacy:  user.privacy || {}
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

  socket.on('profile-update', ({ nickname, bio, phone }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb({ ok: false });
    if (bio   !== undefined) user.bio   = String(bio   || '').slice(0, 200);
    if (phone !== undefined) user.phone = String(phone || '').slice(0, 20);
    if (nickname !== undefined) {
      const newNick = String(nickname || '').trim().slice(0, 32);
      if (newNick.length >= 2) { user.nickname = newNick; client.nickname = newNick; }
    }
    cb({ ok: true, nickname: user.nickname, bio: user.bio });
  });

  socket.on('privacy-update', (settings, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb && cb({ ok: false });
    if (!user.privacy) user.privacy = {};
    Object.assign(user.privacy, settings);
    cb && cb({ ok: true, privacy: user.privacy });
  });

  socket.on('privacy-get', (cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const user = users.get(client.nickLower);
    if (!user) return cb({ ok: false });
    cb({ ok: true, privacy: user.privacy || {} });
  });

  socket.on('profile-get-user', ({ nickname }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    let userKey = lower;
    if (!users.has(lower)) {
      for (const [k, u] of users) {
        if (u.username === lower) { userKey = k; break; }
      }
    }
    const user = users.get(userKey);
    if (!user) return cb({ ok: false, error: 'not_found' });
    cb({ ok: true, nickname: user.nickname, avatar: user.avatar || null, bio: user.bio || '', username: user.username || userKey });
  });

  // ════════════════════════════
  //  БЛОКИРОВКА
  // ════════════════════════════
  socket.on('user-block', ({ nickname }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const toLower = String(nickname || '').trim().toLowerCase();
    const myUser  = users.get(client.nickLower);
    if (!myUser) return cb && cb({ ok: false });
    if (!myUser.blocked) myUser.blocked = [];
    if (!myUser.blocked.includes(toLower)) myUser.blocked.push(toLower);
    cb && cb({ ok: true });
  });

  socket.on('user-unblock', ({ nickname }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const toLower = String(nickname || '').trim().toLowerCase();
    const myUser  = users.get(client.nickLower);
    if (!myUser) return cb && cb({ ok: false });
    myUser.blocked = (myUser.blocked || []).filter(n => n !== toLower);
    cb && cb({ ok: true });
  });

  // ════════════════════════════
  //  ДРУЗЬЯ
  // ════════════════════════════
  socket.on('friend-request', ({ toNickname }, cb) => {
    const client   = clients.get(socket.id);
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
  //  ЛИЧНЫЕ ЧАТЫ
  // ════════════════════════════
  socket.on('private-chat-open', ({ withNickname }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const withLower = String(withNickname || '').trim().toLowerCase();
    let withUserKey = withLower;
    if (!users.has(withLower)) {
      for (const [k, u] of users) {
        if (u.username === withLower) { withUserKey = k; break; }
      }
    }
    const withUser = users.get(withUserKey);
    if (!withUser) return cb({ ok: false, error: 'not_found' });
    if (withUserKey === client.nickLower) return cb({ ok: false, error: 'self' });

    const chatId = generateChatId(client.nickLower, withUserKey);
    if (!privateChats.has(chatId)) {
      privateChats.set(chatId, {
        id: chatId,
        members: [client.nickLower, withUserKey],
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
        const lastMsg    = chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
        list.push({
          chatId:       id,
          withNickname: otherUser?.nickname || otherLower,
          withAvatar:   otherUser?.avatar   || null,
          withLower:    otherLower,
          createdAt:    chat.createdAt,
          lastMessage:  lastMsg ? { type: lastMsg.type, timestamp: lastMsg.timestamp } : null
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

  socket.on('private-chat-history', ({ chatId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower))
      return cb && cb({ ok: false, error: 'not_member' });
    cb && cb({ ok: true, messages: chat.messages || [] });
  });

  socket.on('private-message', async ({ chatId, encrypted, iv, type, fileName, fileSize, mimeType, duration, seq }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower))
      return cb && cb({ ok: false, error: 'not_member' });

    if (encrypted && encrypted.length > 140 * 1024 * 1024)
      return cb && cb({ ok: false, error: 'file_too_large' });

    const msgId = generateMsgId();
    const msg = {
      id:         msgId,
      from:       client.nickLower,
      fromNick:   client.nickname,
      fromAvatar: users.get(client.nickLower)?.avatar || null,
      encrypted, iv,
      type:     type || 'text',
      fileName: fileName || null,
      fileSize: fileSize || null,
      mimeType: mimeType || null,
      duration: duration || 0,
      seq,
      timestamp: Date.now(),
      status:    'sent',
      readBy:    []
    };

    if (!chat.messages) chat.messages = [];
    chat.messages.push(msg);
    if (chat.messages.length > MAX_STORED_MESSAGES)
      chat.messages = chat.messages.slice(-MAX_STORED_MESSAGES);

    socket.to('pc:' + chatId).emit('private-message', { chatId, ...msg });

    const otherLower = chat.members.find(m => m !== client.nickLower);
    for (const [sid, cl] of clients) {
      if (cl.nickLower === otherLower && cl.authed) {
        io.in(sid).socketsJoin('pc:' + chatId);
        io.to(sid).emit('msg-delivered', { chatId, msgId });
      }
    }

    cb && cb({ ok: true, timestamp: msg.timestamp, msgId });
  });

  socket.on('private-msg-read', ({ chatId, msgId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return;
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower)) return;

    const msg = chat.messages?.find(m => m.id === msgId);
    if (msg && !msg.readBy?.includes(client.nickLower)) {
      if (!msg.readBy) msg.readBy = [];
      msg.readBy.push(client.nickLower);
      msg.status = 'read';

      const senderLower = msg.from;
      for (const [sid, cl] of clients) {
        if (cl.nickLower === senderLower) {
          io.to(sid).emit('msg-read', { chatId, msgId, byNick: client.nickLower });
        }
      }
    }
    cb && cb({ ok: true });
  });

  socket.on('private-msg-delete', ({ chatId, msgId, deleteFor }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower))
      return cb && cb({ ok: false, error: 'not_member' });

    const msgIdx = chat.messages?.findIndex(m => m.id === msgId);
    if (msgIdx === -1 || msgIdx === undefined) return cb && cb({ ok: false, error: 'not_found' });

    const msg = chat.messages[msgIdx];
    if (deleteFor === 'all') {
      if (msg.from !== client.nickLower) return cb && cb({ ok: false, error: 'not_yours' });
      chat.messages.splice(msgIdx, 1);
      io.to('pc:' + chatId).emit('private-msg-deleted', { chatId, msgId, deleteFor: 'all' });
    } else {
      if (!msg.deletedFor) msg.deletedFor = [];
      if (!msg.deletedFor.includes(client.nickLower)) msg.deletedFor.push(client.nickLower);
      socket.emit('private-msg-deleted', { chatId, msgId, deleteFor: 'me' });
    }
    cb && cb({ ok: true });
  });

  socket.on('private-msg-edit', ({ chatId, msgId, newEncrypted, newIv }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const chat = privateChats.get(chatId);
    if (!chat || !chat.members.includes(client.nickLower))
      return cb && cb({ ok: false, error: 'not_member' });

    const msg = chat.messages?.find(m => m.id === msgId);
    if (!msg) return cb && cb({ ok: false, error: 'not_found' });
    if (msg.from !== client.nickLower) return cb && cb({ ok: false, error: 'not_yours' });
    if (msg.type !== 'text') return cb && cb({ ok: false, error: 'not_text' });

    msg.encrypted = newEncrypted;
    msg.iv        = newIv;
    msg.edited    = true;
    msg.editedAt  = Date.now();

    io.to('pc:' + chatId).emit('private-msg-edited', {
      chatId, msgId, newEncrypted, newIv, editedAt: msg.editedAt
    });
    cb && cb({ ok: true });
  });

  socket.on('private-typing-start', ({ chatId }) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return;
    socket.to('pc:' + chatId).emit('private-typing-start', {
      chatId, fromNick: client.nickname, fromLower: client.nickLower
    });
  });

  socket.on('private-typing-stop', ({ chatId }) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return;
    socket.to('pc:' + chatId).emit('private-typing-stop', {
      chatId, fromLower: client.nickLower
    });
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
  //  set-nickname
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
      passwordHash: password ? hashPassword(password) : null,
      photo: photo || null,
      ownerId:   socket.id,
      ownerNick: client.nickLower,
      members:   new Set(),
      permanentMembers: new Set(),
      pendingRequests: [],
      joinMode:  joinMode || 'open',
      autoDelete: autoDeleteMs,
      createdAt: Date.now(),
      emptyTimer: null, emptyAt: null,
      salt: roomSalt,
      lastSeq: new Map(),
      messages: []
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
    for (const nickLower of room.permanentMembers) {
      removeGroupMember(nickLower, roomId);
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
    if (joinMode !== undefined) room.joinMode = joinMode === 'approval' ? 'approval' : 'open';
    broadcastRoomList();
    io.to(roomId).emit('room-settings-changed', { roomId, autoDelete: room.autoDelete, joinMode: room.joinMode });
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

  socket.on('room-set-photo', ({ roomId, photo }, cb) => {
    const client = clients.get(socket.id);
    const room   = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
      return cb({ ok: false, error: 'not_owner' });
    room.photo = photo || null;
    broadcastRoomList();
    io.to(roomId).emit('room-photo-updated', { roomId, photo: room.photo });
    cb({ ok: true });
  });

  socket.on('room-members', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    const list = [...room.members].map(sid => {
      const cl = clients.get(sid);
      const u  = cl?.nickLower ? users.get(cl.nickLower) : null;
      return {
        id: sid, nickname: cl?.nickname || shortId(sid),
        avatar: u?.avatar || null,
        isOwner: sid === room.ownerId || (cl?.nickLower && cl.nickLower === room.ownerNick)
      };
    });
    cb({ ok: true, members: list, pendingRequests: room.pendingRequests || [] });
  });

  socket.on('room-history', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false });
    cb && cb({ ok: true, messages: room.messages || [] });
  });

  socket.on('room-msg-delete', ({ roomId, msgId, deleteFor }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false, error: 'not_found' });

    const msgIdx = room.messages?.findIndex(m => m.id === msgId);
    if (msgIdx === -1 || msgIdx === undefined) return cb && cb({ ok: false, error: 'not_found' });

    const msg = room.messages[msgIdx];
    const isOwner = room.ownerNick === client.nickLower;
    const isMine  = msg.from === socket.id || msg.nickLower === client.nickLower;

    if (deleteFor === 'all' && (isMine || isOwner)) {
      room.messages.splice(msgIdx, 1);
      io.to(roomId).emit('room-msg-deleted', { roomId, msgId, deleteFor: 'all' });
    } else if (deleteFor === 'me') {
      if (!msg.deletedFor) msg.deletedFor = [];
      if (!msg.deletedFor.includes(client.nickLower)) msg.deletedFor.push(client.nickLower);
      socket.emit('room-msg-deleted', { roomId, msgId, deleteFor: 'me' });
    } else {
      return cb && cb({ ok: false, error: 'not_allowed' });
    }
    cb && cb({ ok: true });
  });

  socket.on('room-msg-edit', ({ roomId, msgId, newEncrypted, newIv }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false, error: 'not_found' });

    const msg = room.messages?.find(m => m.id === msgId);
    if (!msg) return cb && cb({ ok: false, error: 'not_found' });
    const isMine = msg.from === socket.id || msg.nickLower === client.nickLower;
    if (!isMine) return cb && cb({ ok: false, error: 'not_yours' });
    if (msg.type !== 'text') return cb && cb({ ok: false, error: 'not_text' });

    msg.encrypted = newEncrypted;
    msg.iv        = newIv;
    msg.edited    = true;
    msg.editedAt  = Date.now();

    io.to(roomId).emit('room-msg-edited', {
      roomId, msgId, newEncrypted, newIv, editedAt: msg.editedAt
    });
    cb && cb({ ok: true });
  });

  // ════════════════════════════
  //  ЗАЯВКИ
  // ════════════════════════════
  socket.on('room-request-join', ({ roomId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.joinMode !== 'approval') return cb({ ok: false, error: 'not_approval_mode' });
    if (room.members.has(socket.id)) return cb({ ok: false, error: 'already_member' });
    if (room.permanentMembers?.has(client.nickLower)) return cb({ ok: true, autoAccepted: true });

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
          nickLower: client.nickLower, nickname: client.nickname, avatar: user?.avatar || null
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
    const req = room.pendingRequests[idx];
    room.pendingRequests.splice(idx, 1);
    if (accept) {
      if (!room.permanentMembers) room.permanentMembers = new Set();
      room.permanentMembers.add(nickLower);
      addGroupMember(nickLower, roomId);
    }
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
      const submitted = password ? hashPassword(password) : null;
      if (submitted !== room.passwordHash) {
        recordFailedAttempt(clientIp);
        return setTimeout(() => cb({ ok: false, error: 'wrong_password' }), 800);
      }
    }
    recordSuccessAttempt(clientIp);
    const isPermanentMember = room.permanentMembers?.has(client.nickLower);
    const isOwner = socket.id === room.ownerId || client.nickLower === room.ownerNick;
    if (room.joinMode === 'approval' && !isOwner && !isPermanentMember)
      return cb({ ok: false, error: 'approval_required' });

    if (client.roomId && client.roomId !== roomId) leaveRoom(socket, client.roomId);
    cancelRoomDelete(roomId);
    client.roomId = roomId;
    room.members.add(socket.id);
    if (!room.permanentMembers) room.permanentMembers = new Set();
    room.permanentMembers.add(client.nickLower);
    addGroupMember(client.nickLower, roomId);

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
  socket.on('private-call-offer', ({ chatId, to, offer, isVideo }) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return;
    let found = false;
    for (const [sid, cl] of clients) {
      if (cl.nickLower === to && cl.authed) {
        io.to(sid).emit('private-call-offer', {
          chatId,
          from:          socket.id,
          fromNick:      client.nickname,
          fromNickLower: client.nickLower,
          fromAvatar:    users.get(client.nickLower)?.avatar || null,
          offer,
          isVideo: !!isVideo
        });
        found = true;
      }
    }
    if (!found && io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-offer', {
        chatId,
        from:          socket.id,
        fromNick:      client.nickname,
        fromNickLower: client.nickLower,
        fromAvatar:    users.get(client.nickLower)?.avatar || null,
        offer,
        isVideo: !!isVideo
      });
    }
  });

  socket.on('private-call-answer', ({ to, answer }) => {
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-answer', { from: socket.id, answer });
    }
  });

  socket.on('private-call-ice', ({ to, candidate }) => {
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ice', { from: socket.id, candidate });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to && cl.authed) {
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
        if (cl.nickLower === to && cl.authed) {
          io.to(sid).emit('private-call-ended', { from: socket.id });
        }
      }
    }
  });

  socket.on('private-call-reject', ({ to }) => {
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-rejected', { from: socket.id });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to && cl.authed) {
          io.to(sid).emit('private-call-rejected', { from: socket.id });
        }
      }
    }
  });

  // ════════════════════════════
  //  ГОЛОС (группы)
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
    const others = [...room.members].filter(id => id !== socket.id)
      .map(id => ({ id, nickname: clients.get(id)?.nickname || shortId(id) }));
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

    if (data.encrypted && data.encrypted.length > 140 * 1024 * 1024) return;

    const msgId = generateMsgId();
    const msg = {
      id:       msgId,
      from:     socket.id,
      nickLower: client.nickLower,
      nickname: client.nickname,
      encrypted: data.encrypted || null, iv: data.iv || null,
      type: data.type || 'text',
      fileName: data.fileName || null, fileSize: data.fileSize || null,
      mimeType: data.mimeType || null, duration: data.duration || 0,
      seq: seqNum, timestamp: Date.now(),
      edited: false
    };
    if (!room.messages) room.messages = [];
    room.messages.push(msg);
    if (room.messages.length > MAX_STORED_MESSAGES)
      room.messages = room.messages.slice(-MAX_STORED_MESSAGES);
    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
    socket.to(client.roomId).emit('chat-message', msg);
    socket.emit('chat-msg-id', { seq: seqNum, msgId });
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

  socket.on('private-call-ecdh', ({ to, pubkey }) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return;
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ecdh', { from: socket.id, pubkey });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to && cl.authed) {
          io.to(sid).emit('private-call-ecdh', { from: socket.id, pubkey });
        }
      }
    }
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
