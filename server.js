const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');
const nodeCrypto = require('crypto');

const { UserDB, TokenDB, RoomDB, PrivateChatDB, initDB } = require('./database');

const app = express();

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=()');
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
//  RUNTIME-ХРАНИЛИЩА
// ════════════════════════════════════════════
const clients        = new Map();
const rooms          = new Map();
const pendingRequests = new Map();
const MAX_STORED_MESSAGES = 200;

// ════════════════════════════════════════════
//  ЗАГРУЗКА КОМНАТ ИЗ БД
// ════════════════════════════════════════════
async function loadRoomsFromDB() {
  const dbRooms = await RoomDB.getAll();
  for (const room of dbRooms) {
    const members = await RoomDB.getMembers(room.id);
    rooms.set(room.id, {
      ...room,
      members:          new Set(),
      permanentMembers: new Set(members),
      pendingRequests:  [],
      emptyTimer:       null,
      emptyAt:          null,
      lastSeq:          new Map(),
      messages:         []
    });
  }
  console.log(`Загружено ${dbRooms.length} комнат из БД`);
}

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
  const salt = 'voicechat-pw-salt-v2-' + pw.slice(0, 2);
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

function generateRoomId()     { return nodeCrypto.randomBytes(3).toString('hex').toUpperCase(); }
function generateToken()      { return nodeCrypto.randomBytes(32).toString('hex'); }
function generateChatId(a, b) { return [a, b].sort().join('::'); }
function shortId(id)          { return id ? id.slice(0, 6) : '??'; }
function generateMsgId()      { return nodeCrypto.randomBytes(8).toString('hex'); }

// ════════════════════════════════════════════
//  КОМНАТЫ
// ════════════════════════════════════════════
function getRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    const entry = {
      id, name: room.name, hasPassword: !!room.passwordHash,
      photo: room.photo || null, memberCount: room.members.size,
      createdAt: room.createdAt, ownerId: room.ownerNick || null,
      autoDelete: room.autoDelete || null, joinMode: room.joinMode || 'open'
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
  room.emptyTimer = setTimeout(async () => {
    const r = rooms.get(roomId);
    if (r && r.members.size === 0) {
      rooms.delete(roomId);
      await RoomDB.delete(roomId);
      broadcastRoomList();
    }
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
  socket.on('auth-register', async ({ nickname, password, hint, phone, username }, cb) => {
    try {
      const nick  = String(nickname || '').trim().slice(0, 32);
      const uname = String(username || nick).trim().slice(0, 32).toLowerCase().replace(/[^a-z0-9_]/g, '');
      const lower = nick.toLowerCase();
      if (!nick || nick.length < 2)         return cb({ ok: false, error: 'nick_short' });
      if (!password || password.length < 4) return cb({ ok: false, error: 'pw_short' });
      if (await UserDB.has(lower))          return cb({ ok: false, error: 'nick_taken' });
      if (uname && uname !== lower && await UserDB.hasUsername(uname))
        return cb({ ok: false, error: 'username_taken' });

      await UserDB.create(lower, {
        nickname: nick, username: uname || lower,
        passwordHash: hashPassword(password),
        hint:     encryptHint(String(hint  || '').trim().slice(0, 100)),
        phone:    String(phone || '').trim().slice(0, 20),
        privacy: {
          phoneVisibility: 'nobody', lastSeenVisibility: 'nobody',
          avatarVisibility: 'all',   forwardVisibility: 'nobody',
          callsVisibility: 'nobody', autoDeleteAccount: '12months',
          syncContacts: false, suggestContacts: false,
          secretChatLinkPreview: false, secretChatMapPreview: false,
          cloudPassword: false, autoDeleteMessages: false, passcodeLock: false,
        },
        createdAt: Date.now()
      });

      const token = generateToken();
      await TokenDB.set(token, lower);

      const client     = clients.get(socket.id);
      client.nickname  = nick;
      client.nickLower = lower;
      client.authed    = true;

      cb({ ok: true, token, nickname: nick, username: uname || lower, avatar: null });
    } catch (e) { console.error('auth-register error:', e); cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('auth-login', async ({ nickname, password }, cb) => {
    try {
      const lower = String(nickname || '').trim().toLowerCase();
      const bf    = checkBruteForce(clientIp + ':login');
      if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });

      let user = await UserDB.get(lower);
      if (!user) {
        const byUsername = await UserDB.getByUsername(lower);
        if (byUsername) user = byUsername;
      }

      if (!user || user.passwordHash !== hashPassword(password)) {
        recordFailedAttempt(clientIp + ':login');
        return setTimeout(() => cb({ ok: false, error: 'wrong_creds' }), 800);
      }
      recordSuccessAttempt(clientIp + ':login');

      const userKey = lower;
      const token   = generateToken();
      await TokenDB.set(token, userKey);

      const client     = clients.get(socket.id);
      client.nickname  = user.nickname;
      client.nickLower = userKey;
      client.authed    = true;

      const myRooms = await RoomDB.getUserRooms(userKey);
      for (const roomId of myRooms) {
        const room = rooms.get(roomId);
        if (room) socket.join(roomId);
      }

      cb({ ok: true, token, nickname: user.nickname, username: user.username || userKey, avatar: user.avatar || null });
    } catch (e) { console.error('auth-login error:', e); cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('auth-token', async ({ token }, cb) => {
    try {
      const lower = await TokenDB.get(token);
      const user  = lower ? await UserDB.get(lower) : null;
      if (!user) return cb({ ok: false, error: 'invalid_token' });

      const client     = clients.get(socket.id);
      client.nickname  = user.nickname;
      client.nickLower = lower;
      client.authed    = true;

      const myRooms = await RoomDB.getUserRooms(lower);
      for (const roomId of myRooms) {
        const room = rooms.get(roomId);
        if (room) socket.join(roomId);
      }

      cb({ ok: true, nickname: user.nickname, username: user.username || lower, avatar: user.avatar || null });
    } catch (e) { console.error('auth-token error:', e); cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('auth-logout', async ({ token }, cb) => {
    try {
      if (token) await TokenDB.delete(token);
      const client = clients.get(socket.id);
      if (client) { client.authed = false; client.nickname = ''; client.nickLower = ''; }
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: true }); }
  });

  socket.on('auth-get-hint', async ({ nickname }, cb) => {
    try {
      const lower = String(nickname || '').trim().toLowerCase();
      let user = await UserDB.get(lower) || await UserDB.getByUsername(lower);
      if (!user) return cb({ ok: false, error: 'not_found' });
      cb({ ok: true, hint: decryptHint(user.hint) || '' });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('auth-reset-password', async ({ phone, newPassword }, cb) => {
    try {
      const bf = checkBruteForce(clientIp + ':reset');
      if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });
      if (!phone || !newPassword || newPassword.length < 4)
        return cb({ ok: false, error: 'invalid' });

      const { queryOne } = require('./database');
      const row = await queryOne('SELECT nick_lower FROM users WHERE phone = ?', [phone.trim()]);
      if (!row) {
        recordFailedAttempt(clientIp + ':reset');
        return setTimeout(() => cb({ ok: false, error: 'not_found' }), 800);
      }
      await UserDB.update(row.nick_lower, { passwordHash: hashPassword(newPassword) });
      recordSuccessAttempt(clientIp + ':reset');
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  // ════════════════════════════
  //  ПРОФИЛЬ
  // ════════════════════════════
  socket.on('profile-get', async (cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const user = await UserDB.get(client.nickLower);
      if (!user) return cb({ ok: false });
      cb({
        ok:       true,
        nickname: user.nickname,
        username: user.username || client.nickLower,
        avatar:   user.avatar   || null,
        bio:      user.bio      || '',
        phone:    user.phone    || '',
        hint:     decryptHint(user.hint) || '',
        friends:  await UserDB.getFriends(client.nickLower),
        friendRequests: await UserDB.getFriendRequests(client.nickLower),
        blocked:  await UserDB.getBlocked(client.nickLower),
        privacy:  user.privacy  || {}
      });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('profile-set-avatar', async ({ avatar }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      await UserDB.update(client.nickLower, { avatar: avatar || null });
      if (client.roomId) {
        socket.to(client.roomId).emit('user-avatar-updated', {
          nickLower: client.nickLower, nickname: client.nickname, avatar: avatar || null
        });
      }
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('profile-update', async ({ nickname, bio, phone }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const updates = {};
      if (bio      !== undefined) updates.bio   = String(bio   || '').slice(0, 200);
      if (phone    !== undefined) updates.phone = String(phone || '').slice(0, 20);
      if (nickname !== undefined) {
        const newNick = String(nickname || '').trim().slice(0, 32);
        if (newNick.length >= 2) { updates.nickname = newNick; client.nickname = newNick; }
      }
      await UserDB.update(client.nickLower, updates);
      const user = await UserDB.get(client.nickLower);
      cb({ ok: true, nickname: user.nickname, bio: user.bio });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('privacy-update', async (settings, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      const user = await UserDB.get(client.nickLower);
      if (!user) return cb && cb({ ok: false });
      const newPrivacy = Object.assign(user.privacy || {}, settings);
      await UserDB.update(client.nickLower, { privacy: newPrivacy });
      cb && cb({ ok: true, privacy: newPrivacy });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('privacy-get', async (cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const user = await UserDB.get(client.nickLower);
      if (!user) return cb({ ok: false });
      cb({ ok: true, privacy: user.privacy || {} });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('profile-get-user', async ({ nickname }, cb) => {
    try {
      const lower = String(nickname || '').trim().toLowerCase();
      const user  = await UserDB.get(lower) || await UserDB.getByUsername(lower);
      if (!user) return cb({ ok: false, error: 'not_found' });
      cb({ ok: true, nickname: user.nickname, avatar: user.avatar || null, bio: user.bio || '', username: user.username || lower });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  // ════════════════════════════
  //  БЛОКИРОВКА
  // ════════════════════════════
  socket.on('user-block', async ({ nickname }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      await UserDB.block(client.nickLower, String(nickname || '').trim().toLowerCase());
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('user-unblock', async ({ nickname }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      await UserDB.unblock(client.nickLower, String(nickname || '').trim().toLowerCase());
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
  });

  // ════════════════════════════
  //  ДРУЗЬЯ
  // ════════════════════════════
  socket.on('friend-request', async ({ toNickname }, cb) => {
    try {
      const client  = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const toLower = String(toNickname || '').trim().toLowerCase();
      const toUser  = await UserDB.get(toLower);
      if (!toUser)                                                    return cb({ ok: false, error: 'not_found' });
      if (toLower === client.nickLower)                               return cb({ ok: false, error: 'self' });
      if (await UserDB.areFriends(client.nickLower, toLower))         return cb({ ok: false, error: 'already_friends' });
      if (await UserDB.hasRequest(toLower, client.nickLower))         return cb({ ok: false, error: 'already_sent' });

      await UserDB.addRequest(toLower, client.nickLower);
      const fromUser = await UserDB.get(client.nickLower);
      for (const [sid, cl] of clients) {
        if (cl.nickLower === toLower && cl.authed) {
          io.to(sid).emit('friend-request-incoming', {
            fromNick: fromUser.nickname, fromLower: client.nickLower, avatar: fromUser.avatar || null
          });
        }
      }
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('friend-respond', async ({ fromNickname, accept }, cb) => {
    try {
      const client    = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const fromLower = String(fromNickname || '').trim().toLowerCase();
      const fromUser  = await UserDB.get(fromLower);
      if (!fromUser) return cb({ ok: false, error: 'not_found' });

      await UserDB.removeRequest(client.nickLower, fromLower);
      if (accept) {
        await UserDB.addFriend(client.nickLower, fromLower);
        const myUser = await UserDB.get(client.nickLower);
        for (const [sid, cl] of clients) {
          if (cl.nickLower === fromLower && cl.authed) {
            io.to(sid).emit('friend-accepted', {
              byNick: myUser.nickname, byLower: client.nickLower, avatar: myUser.avatar || null
            });
          }
        }
      }
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('friend-remove', async ({ nickname }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      await UserDB.removeFriend(client.nickLower, String(nickname || '').trim().toLowerCase());
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('friends-list', async (cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      cb({
        ok:       true,
        friends:  await UserDB.getFriends(client.nickLower),
        requests: await UserDB.getFriendRequests(client.nickLower)
      });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  // ════════════════════════════
  //  ЛИЧНЫЕ ЧАТЫ
  // ════════════════════════════
  socket.on('private-chat-open', async ({ withNickname }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const withLower = String(withNickname || '').trim().toLowerCase();
      let withUser = await UserDB.get(withLower) || await UserDB.getByUsername(withLower);
      if (!withUser) return cb({ ok: false, error: 'not_found' });
      if (withLower === client.nickLower) return cb({ ok: false, error: 'self' });

      const chatId = generateChatId(client.nickLower, withLower);
      await PrivateChatDB.create(chatId, client.nickLower, withLower);
      socket.join('pc:' + chatId);
      cb({ ok: true, chatId, withNickname: withUser.nickname, withAvatar: withUser.avatar || null });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('private-chat-list', async (cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const rows = await PrivateChatDB.getUserChats(client.nickLower);
      const list = await Promise.all(rows.map(async row => {
        const otherLower = row.member1 === client.nickLower ? row.member2 : row.member1;
        const otherUser  = await UserDB.get(otherLower);
        return {
          chatId:       row.chat_id,
          withNickname: otherUser?.nickname  || otherLower,
          withAvatar:   otherUser?.avatar    || null,
          withLower:    otherLower,
          createdAt:    row.created_at,
          lastMessage:  row.last_type ? { type: row.last_type, timestamp: row.last_ts } : null
        };
      }));
      cb({ ok: true, chats: list });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('private-chat-history', async ({ chatId }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      if (!await PrivateChatDB.isMember(chatId, client.nickLower))
        return cb && cb({ ok: false, error: 'not_member' });
      const messages = await PrivateChatDB.getMessages(chatId, MAX_STORED_MESSAGES);
      const filtered = messages.filter(m => !m.deletedFor.includes(client.nickLower));
      cb && cb({ ok: true, messages: filtered });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('private-message', async ({ chatId, encrypted, iv, type, fileName, fileSize, mimeType, duration, seq }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      if (!await PrivateChatDB.isMember(chatId, client.nickLower))
        return cb && cb({ ok: false, error: 'not_member' });
      if (encrypted && encrypted.length > 140 * 1024 * 1024)
        return cb && cb({ ok: false, error: 'file_too_large' });

      const user  = await UserDB.get(client.nickLower);
      const msgId = generateMsgId();
      const msg   = {
        id: msgId, chatId, from: client.nickLower,
        fromNick: client.nickname, fromAvatar: user?.avatar || null,
        encrypted, iv, type: type || 'text',
        fileName: fileName || null, fileSize: fileSize || null,
        mimeType: mimeType || null, duration: duration || 0,
        seq, timestamp: Date.now(), status: 'sent'
      };

      await PrivateChatDB.saveMessage(msg);
      socket.to('pc:' + chatId).emit('private-message', { ...msg });

      const chat = await PrivateChatDB.get(chatId);
      if (chat) {
        const otherLower = chat.member1 === client.nickLower ? chat.member2 : chat.member1;
        for (const [sid, cl] of clients) {
          if (cl.nickLower === otherLower && cl.authed) {
            io.in(sid).socketsJoin('pc:' + chatId);
            io.to(sid).emit('msg-delivered', { chatId, msgId });
          }
        }
      }
      cb && cb({ ok: true, timestamp: msg.timestamp, msgId });
    } catch (e) { console.error('private-message error:', e); cb && cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('private-msg-read', async ({ chatId, msgId }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return;
      if (!await PrivateChatDB.isMember(chatId, client.nickLower)) return;
      if (!await PrivateChatDB.isReadBy(msgId, client.nickLower)) {
        await PrivateChatDB.markRead(msgId, client.nickLower);
        const msg = await PrivateChatDB.getMessage(msgId);
        if (msg) {
          for (const [sid, cl] of clients) {
            if (cl.nickLower === msg.from) {
              io.to(sid).emit('msg-read', { chatId, msgId, byNick: client.nickLower });
            }
          }
        }
      }
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: true }); }
  });

  socket.on('private-msg-delete', async ({ chatId, msgId, deleteFor }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      if (!await PrivateChatDB.isMember(chatId, client.nickLower))
        return cb && cb({ ok: false, error: 'not_member' });
      const msg = await PrivateChatDB.getMessage(msgId);
      if (!msg) return cb && cb({ ok: false, error: 'not_found' });

      if (deleteFor === 'all') {
        if (msg.from !== client.nickLower) return cb && cb({ ok: false, error: 'not_yours' });
        await PrivateChatDB.deleteMessage(msgId);
        io.to('pc:' + chatId).emit('private-msg-deleted', { chatId, msgId, deleteFor: 'all' });
      } else {
        await PrivateChatDB.addDeletedFor(msgId, client.nickLower);
        socket.emit('private-msg-deleted', { chatId, msgId, deleteFor: 'me' });
      }
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('private-msg-edit', async ({ chatId, msgId, newEncrypted, newIv }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      if (!await PrivateChatDB.isMember(chatId, client.nickLower))
        return cb && cb({ ok: false, error: 'not_member' });
      const msg = await PrivateChatDB.getMessage(msgId);
      if (!msg) return cb && cb({ ok: false, error: 'not_found' });
      if (msg.from !== client.nickLower) return cb && cb({ ok: false, error: 'not_yours' });
      if (msg.type !== 'text') return cb && cb({ ok: false, error: 'not_text' });

      await PrivateChatDB.editMessage(msgId, newEncrypted, newIv);
      const editedAt = Date.now();
      io.to('pc:' + chatId).emit('private-msg-edited', { chatId, msgId, newEncrypted, newIv, editedAt });
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
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
    socket.to('pc:' + chatId).emit('private-typing-stop', { chatId, fromLower: client.nickLower });
  });

  socket.on('private-chat-join', ({ chatId }, cb) => {
    const client = clients.get(socket.id);
    if (!client?.authed) return cb && cb({ ok: false });
    socket.join('pc:' + chatId);
    cb && cb({ ok: true });
  });

  // ════════════════════════════
  //  set-nickname
  // ════════════════════════════
  socket.on('set-nickname', (nickname, cb) => {
    const client = clients.get(socket.id);
    if (client?.authed) { socket.emit('room-list', getRoomList()); return cb && cb({ ok: true }); }
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
  socket.on('create-room', async ({ name, password, photo, autoDelete, joinMode }, cb) => {
    try {
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

      const roomData = {
        name: roomName, passwordHash: password ? hashPassword(password) : null,
        photo: photo || null, ownerNick: client.nickLower,
        joinMode: joinMode || 'open', autoDelete: autoDeleteMs,
        salt: roomSalt, createdAt: Date.now()
      };

      await RoomDB.create(id, roomData);
      rooms.set(id, {
        ...roomData, id,
        ownerId:          socket.id,
        members:          new Set(),
        permanentMembers: new Set(),
        pendingRequests:  [],
        emptyTimer:       null,
        emptyAt:          null,
        lastSeq:          new Map(),
        messages:         []
      });

      broadcastRoomList();
      cb({ ok: true, roomId: id, roomSalt });
    } catch (e) { console.error('create-room error:', e); cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('room-delete', async ({ roomId }, cb) => {
    try {
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
      await RoomDB.delete(roomId);
      broadcastRoomList();
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('room-settings-update', async ({ roomId, autoDelete, joinMode }, cb) => {
    try {
      const client = clients.get(socket.id);
      const room   = rooms.get(roomId);
      if (!room) return cb({ ok: false, error: 'not_found' });
      if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
        return cb({ ok: false, error: 'not_owner' });

      const updates = {};
      if (autoDelete !== undefined) {
        let ms = null;
        if (autoDelete && autoDelete !== 'never') {
          ms = parseInt(autoDelete);
          if (isNaN(ms) || ms < 0) ms = null;
        }
        room.autoDelete = ms; updates.autoDelete = ms;
      }
      if (joinMode !== undefined) {
        room.joinMode = joinMode === 'approval' ? 'approval' : 'open';
        updates.joinMode = room.joinMode;
      }
      await RoomDB.update(roomId, updates);
      broadcastRoomList();
      io.to(roomId).emit('room-settings-changed', { roomId, autoDelete: room.autoDelete, joinMode: room.joinMode });
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('room-rename', async ({ roomId, newName }, cb) => {
    try {
      const client = clients.get(socket.id);
      const room   = rooms.get(roomId);
      if (!room) return cb({ ok: false, error: 'not_found' });
      if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
        return cb({ ok: false, error: 'not_owner' });
      const name = String(newName || '').trim().slice(0, 50);
      if (!name) return cb({ ok: false, error: 'empty_name' });
      room.name = name;
      await RoomDB.update(roomId, { name });
      broadcastRoomList();
      io.to(roomId).emit('room-renamed', { roomId, newName: name });
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('room-set-photo', async ({ roomId, photo }, cb) => {
    try {
      const client = clients.get(socket.id);
      const room   = rooms.get(roomId);
      if (!room) return cb({ ok: false, error: 'not_found' });
      if (room.ownerId !== socket.id && room.ownerNick !== client.nickLower)
        return cb({ ok: false, error: 'not_owner' });
      room.photo = photo || null;
      await RoomDB.update(roomId, { photo: room.photo });
      broadcastRoomList();
      io.to(roomId).emit('room-photo-updated', { roomId, photo: room.photo });
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('room-members', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    const list = [...room.members].map(sid => {
      const cl = clients.get(sid);
      const u  = null; // аватары грузятся на клиенте
      return {
        id: sid, nickname: cl?.nickname || shortId(sid),
        avatar: null,
        isOwner: sid === room.ownerId || (cl?.nickLower && cl.nickLower === room.ownerNick)
      };
    });
    cb({ ok: true, members: list, pendingRequests: room.pendingRequests || [] });
  });

  socket.on('room-history', async ({ roomId }, cb) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return cb && cb({ ok: false });
      if (room.messages && room.messages.length) {
        return cb && cb({ ok: true, messages: room.messages });
      }
      const msgs = await RoomDB.getMessages(roomId, MAX_STORED_MESSAGES);
      room.messages = msgs;
      cb && cb({ ok: true, messages: msgs });
    } catch (e) { cb && cb({ ok: false }); }
  });

  socket.on('room-msg-delete', async ({ roomId, msgId, deleteFor }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      const room = rooms.get(roomId);
      if (!room) return cb && cb({ ok: false, error: 'not_found' });

      const msg = await RoomDB.getMessage(msgId);
      if (!msg) return cb && cb({ ok: false, error: 'not_found' });

      const isOwner = room.ownerNick === client.nickLower;
      const isMine  = msg.nickLower  === client.nickLower;

      if (deleteFor === 'all' && (isMine || isOwner)) {
        await RoomDB.deleteMessage(msgId);
        room.messages = room.messages.filter(m => m.id !== msgId);
        io.to(roomId).emit('room-msg-deleted', { roomId, msgId, deleteFor: 'all' });
      } else if (deleteFor === 'me') {
        await RoomDB.addDeletedFor(msgId, client.nickLower);
        room.messages = room.messages.map(m => {
          if (m.id !== msgId) return m;
          return { ...m, deletedFor: [...(m.deletedFor || []), client.nickLower] };
        });
        socket.emit('room-msg-deleted', { roomId, msgId, deleteFor: 'me' });
      } else {
        return cb && cb({ ok: false, error: 'not_allowed' });
      }
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('room-msg-edit', async ({ roomId, msgId, newEncrypted, newIv }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb && cb({ ok: false, error: 'not_authed' });
      const room = rooms.get(roomId);
      if (!room) return cb && cb({ ok: false, error: 'not_found' });
      const msg = await RoomDB.getMessage(msgId);
      if (!msg) return cb && cb({ ok: false, error: 'not_found' });
      if (msg.nickLower !== client.nickLower) return cb && cb({ ok: false, error: 'not_yours' });
      if (msg.type !== 'text') return cb && cb({ ok: false, error: 'not_text' });

      await RoomDB.editMessage(msgId, newEncrypted, newIv);
      room.messages = room.messages.map(m =>
        m.id === msgId ? { ...m, encrypted: newEncrypted, iv: newIv, edited: true } : m
      );
      const editedAt = Date.now();
      io.to(roomId).emit('room-msg-edited', { roomId, msgId, newEncrypted, newIv, editedAt });
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: 'server_error' }); }
  });

  // ════════════════════════════
  //  ЗАЯВКИ
  // ════════════════════════════
  socket.on('room-request-join', async ({ roomId }, cb) => {
    try {
      const client = clients.get(socket.id);
      if (!client?.authed) return cb({ ok: false, error: 'not_authed' });
      const room = rooms.get(roomId);
      if (!room) return cb({ ok: false, error: 'not_found' });
      if (room.joinMode !== 'approval') return cb({ ok: false, error: 'not_approval_mode' });
      if (room.members.has(socket.id)) return cb({ ok: false, error: 'already_member' });
      if (await RoomDB.isMember(roomId, client.nickLower)) return cb({ ok: true, autoAccepted: true });

      const already = room.pendingRequests.find(r => r.nickLower === client.nickLower);
      if (already) return cb({ ok: false, error: 'already_requested' });

      const user = await UserDB.get(client.nickLower);
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
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
  });

  socket.on('room-request-respond', async ({ roomId, nickLower, accept }, cb) => {
    try {
      const client = clients.get(socket.id);
      const room   = rooms.get(roomId);
      if (!room) return cb({ ok: false, error: 'not_found' });
      if (room.ownerNick !== client.nickLower) return cb({ ok: false, error: 'not_owner' });
      const idx = room.pendingRequests.findIndex(r => r.nickLower === nickLower);
      if (idx === -1) return cb({ ok: false, error: 'not_found' });
      room.pendingRequests.splice(idx, 1);
      if (accept) {
        room.permanentMembers.add(nickLower);
        await RoomDB.addMember(roomId, nickLower);
      }
      for (const [sid, cl] of clients) {
        if (cl.nickLower === nickLower) {
          if (accept) io.to(sid).emit('room-request-accepted', { roomId, roomName: room.name });
          else        io.to(sid).emit('room-request-declined', { roomId, roomName: room.name });
        }
      }
      cb({ ok: true });
    } catch (e) { cb({ ok: false, error: 'server_error' }); }
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
  socket.on('join-room', async ({ roomId, password }, cb) => {
    try {
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

      const isPermanentMember = await RoomDB.isMember(roomId, client.nickLower);
      const isOwner = socket.id === room.ownerId || client.nickLower === room.ownerNick;
      if (room.joinMode === 'approval' && !isOwner && !isPermanentMember)
        return cb({ ok: false, error: 'approval_required' });

      if (client.roomId && client.roomId !== roomId) leaveRoom(socket, client.roomId);
      cancelRoomDelete(roomId);
      client.roomId = roomId;
      room.members.add(socket.id);

      if (!isPermanentMember) {
        room.permanentMembers.add(client.nickLower);
        await RoomDB.addMember(roomId, client.nickLower);
      }

      socket.join(roomId);
      const user   = await UserDB.get(client.nickLower);
      const others = [...room.members].filter(id => id !== socket.id).map(id => {
        const cl = clients.get(id);
        return { id, nickname: cl?.nickname || shortId(id), avatar: null };
      });
      socket.to(roomId).emit('room-user-joined', {
        id: socket.id, nickname: client.nickname, avatar: user?.avatar || null
      });
      broadcastRoomList();
      cb({ ok: true, room: {
        id: room.id, name: room.name, photo: room.photo,
        members: others, roomSalt: room.salt,
        isOwner, autoDelete: room.autoDelete, joinMode: room.joinMode,
        pendingRequests: isOwner ? room.pendingRequests : []
      }});
    } catch (e) { console.error('join-room error:', e); cb({ ok: false, error: 'server_error' }); }
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
          chatId, from: socket.id, fromNick: client.nickname,
          fromNickLower: client.nickLower,
          fromAvatar: null,
          offer, isVideo: !!isVideo
        });
        found = true;
      }
    }
    if (!found && io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-offer', {
        chatId, from: socket.id, fromNick: client.nickname,
        fromNickLower: client.nickLower,
        fromAvatar: null,
        offer, isVideo: !!isVideo
      });
    }
  });

  socket.on('private-call-answer', ({ to, answer }) => {
    // to здесь — это socket.id инициатора
    if (io.sockets.sockets.get(to))
      io.to(to).emit('private-call-answer', { from: socket.id, answer });
  });

  socket.on('private-call-ice', ({ to, candidate }) => {
    // to может быть socket.id или nickLower
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ice', { from: socket.id, candidate });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to && cl.authed)
          io.to(sid).emit('private-call-ice', { from: socket.id, candidate });
      }
    }
  });

  socket.on('private-call-end', ({ to }) => {
    if (!to) return;
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ended', { from: socket.id });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to && cl.authed)
          io.to(sid).emit('private-call-ended', { from: socket.id });
      }
    }
  });

  socket.on('private-call-reject', ({ to }) => {
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-rejected', { from: socket.id });
    } else {
      for (const [sid, cl] of clients) {
        if (cl.nickLower === to && cl.authed)
          io.to(sid).emit('private-call-rejected', { from: socket.id });
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

  socket.on('chat-message', async (data) => {
    try {
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
        id: msgId, roomId: client.roomId, from: socket.id,
        nickLower: client.nickLower, nickname: client.nickname,
        encrypted: data.encrypted || null, iv: data.iv || null,
        type: data.type || 'text', fileName: data.fileName || null,
        fileSize: data.fileSize || null, mimeType: data.mimeType || null,
        duration: data.duration || 0, seq: seqNum,
        timestamp: Date.now(), edited: false, deletedFor: []
      };

      await RoomDB.saveMessage(msg);

      if (!room.messages) room.messages = [];
      room.messages.push(msg);
      if (room.messages.length > MAX_STORED_MESSAGES)
        room.messages = room.messages.slice(-MAX_STORED_MESSAGES);

      socket.to(client.roomId).emit('typing-stop', { from: socket.id });
      socket.to(client.roomId).emit('chat-message', msg);
      socket.emit('chat-msg-id', { seq: seqNum, msgId });
    } catch (e) { console.error('chat-message error:', e); }
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
        if (cl.nickLower === to && cl.authed)
          io.to(sid).emit('private-call-ecdh', { from: socket.id, pubkey });
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

// ════════════════════════════════════════════
//  ЗАПУСК
// ════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  return loadRoomsFromDB();
}).then(() => {
  server.listen(PORT, () => console.log(`Server on port ${PORT}`));
}).catch(err => {
  console.error('Ошибка инициализации БД:', err);
  process.exit(1);
});
