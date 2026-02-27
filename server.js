const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

// ── In-memory storage (без БД) ───────────────────────────
let userSeq = 1;
let roomSeq = 1;

const users        = new Map(); // id -> user
const usersByName  = new Map(); // username -> user
const sessions     = new Map(); // token -> userId
const rooms        = new Map(); // id -> room
const roomMessages = new Map(); // roomId -> messages[]
const privateRooms = new Map(); // "a-b" -> roomId

const SESSION_TTL_DAYS = 30;
const AVATAR_MAX_BYTES = 512 * 1024;

// ── Helpers ──────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidDataUrlImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return false;
  if (!dataUrl.startsWith('data:image/')) return false;
  const base64 = dataUrl.split(',')[1] || '';
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes > 0 && bytes <= AVATAR_MAX_BYTES;
}

function sanitizeBio(bio) {
  if (typeof bio !== 'string') return null;
  const clean = bio.trim().slice(0, 140);
  return clean.length ? clean : null;
}

function createUser(username) {
  const user = {
    id: userSeq++,
    username: username.trim(),
    avatar: null,
    bio: null
  };
  users.set(user.id, user);
  usersByName.set(user.username, user);
  return user;
}

function createSession(userId) {
  const token = generateToken();
  const expiresAt = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  sessions.set(token, { userId, expiresAt });
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return users.get(s.userId) || null;
}

function getRoomById(id) {
  return rooms.get(Number(id)) || null;
}

function ensureDefaultRoom() {
  if (rooms.size > 0) return;
  const admin = createUser('Admin');
  const room = {
    id: roomSeq++,
    name: 'Общая комната',
    avatar: null,
    owner_id: admin.id,
    is_group: true,
    is_private: false,
    pinned_msg_id: null,
    created_at: new Date().toISOString()
  };
  rooms.set(room.id, room);
  roomMessages.set(room.id, []);
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// ── Simple rate limiter ──────────────────────────────────
const rateBucket = new Map();
function rateLimit(key, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const bucket = rateBucket.get(key) || { count: 0, start: now };
  if (now - bucket.start > windowMs) {
    bucket.count = 0;
    bucket.start = now;
  }
  bucket.count++;
  rateBucket.set(key, bucket);
  return bucket.count <= limit;
}
function ipKey(req, suffix) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  return `${ip}:${suffix}`;
}

// ── Auth ─────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  if (!rateLimit(ipKey(req, 'register'), 6, 60_000)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ ok: false, error: 'username_length' });
  if (password.length < 4) return res.status(400).json({ ok: false, error: 'password_short' });

  const existing = usersByName.get(username.trim());
  if (existing) return res.status(409).json({ ok: false, error: 'username_taken' });

  const user = createUser(username);
  const token = createSession(user.id);
  res.json({ ok: true, token, username: user.username, userId: user.id });
});

app.post('/api/login', (req, res) => {
  if (!rateLimit(ipKey(req, 'login'), 10, 60_000)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

  let user = usersByName.get(username.trim());
  if (!user) user = createUser(username);

  const token = createSession(user.id);
  res.json({ ok: true, token, username: user.username, userId: user.id });
});

app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });
  res.json({ ok: true, username: user.username, userId: user.id, avatar: user.avatar, bio: user.bio });
});

// ── Profile ──────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, user });
});

app.put('/api/me', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { avatar, bio } = req.body || {};
  const cleanBio = sanitizeBio(bio);

  if (avatar !== undefined && avatar !== null && !isValidDataUrlImage(avatar)) {
    return res.status(400).json({ ok: false, error: 'invalid_avatar' });
  }

  user.avatar = avatar ?? user.avatar;
  user.bio = cleanBio;
  res.json({ ok: true });
});

// ── Rooms ────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!getUserByToken(token)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  ensureDefaultRoom();

  const list = Array.from(rooms.values()).map(r => ({
    id: r.id,
    name: r.name,
    avatar: r.avatar,
    is_group: r.is_group,
    is_private: r.is_private,
    owner_id: r.owner_id,
    pinned_msg_id: r.pinned_msg_id,
    owner: users.get(r.owner_id)?.username || 'admin',
    has_password: 0,
    created_at: r.created_at
  }));
  res.json({ ok: true, rooms: list });
});

app.post('/api/rooms', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { name, isGroup } = req.body;
  if (!name || name.length < 2 || name.length > 64)
    return res.status(400).json({ ok: false, error: 'invalid_name' });

  const room = {
    id: roomSeq++,
    name: name.trim(),
    avatar: null,
    owner_id: user.id,
    is_group: !!isGroup,
    is_private: false,
    pinned_msg_id: null,
    created_at: new Date().toISOString()
  };
  rooms.set(room.id, room);
  roomMessages.set(room.id, []);
  res.json({ ok: true, roomId: room.id, name: room.name });
});

app.post('/api/rooms/:id/join', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const room = getRoomById(req.params.id);
  if (!room) return res.status(404).json({ ok: false, error: 'not_found' });

  res.json({ 
    ok: true, 
    room: { 
      id: room.id, 
      name: room.name, 
      avatar: room.avatar,
      owner_id: room.owner_id,
      is_group: room.is_group,
      is_private: room.is_private,
      pinned_msg_id: room.pinned_msg_id
    } 
  });
});

app.put('/api/rooms/:id/avatar', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const room = getRoomById(req.params.id);
  if (!room) return res.status(404).json({ ok: false, error: 'not_found' });
  if (room.owner_id !== user.id) return res.status(403).json({ ok: false, error: 'forbidden' });

  const { avatar } = req.body || {};
  if (!isValidDataUrlImage(avatar)) return res.status(400).json({ ok: false, error: 'invalid_avatar' });

  room.avatar = avatar;
  res.json({ ok: true });
});

app.get('/api/rooms/:id/messages', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const room = getRoomById(req.params.id);
  if (!room) return res.status(404).json({ ok: false, error: 'not_found' });

  const msgs = roomMessages.get(room.id) || [];
  res.json({ ok: true, messages: msgs.slice(-50), pinned: room.pinned_msg_id || null });
});

// ── Contacts (заглушки) ──────────────────────────────────
app.get('/api/contacts', (req, res) => res.json({ ok: true, contacts: [] }));
app.post('/api/contacts/send', (req, res) => res.json({ ok: true }));
app.get('/api/contacts/requests', (req, res) => res.json({ ok: true, requests: [] }));
app.post('/api/contacts/requests/respond', (req, res) => res.json({ ok: true }));

// ── Private chat ─────────────────────────────────────────
app.post('/api/chats/private', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { userId } = req.body;
  if (!userId || Number(userId) === user.id) return res.status(400).json({ ok: false });

  const a = Math.min(user.id, Number(userId));
  const b = Math.max(user.id, Number(userId));
  const key = `${a}-${b}`;

  let roomId = privateRooms.get(key);
  if (!roomId) {
    const other = users.get(Number(userId)) || createUser('User' + userId);
    const room = {
      id: roomSeq++,
      name: `${user.username} & ${other.username}`,
      avatar: null,
      owner_id: user.id,
      is_group: false,
      is_private: true,
      pinned_msg_id: null,
      created_at: new Date().toISOString()
    };
    rooms.set(room.id, room);
    roomMessages.set(room.id, []);
    privateRooms.set(key, room.id);
    roomId = room.id;
  }

  res.json({ ok: true, room: rooms.get(roomId) });
});

// ── HTTPS / HTTP ─────────────────────────────────────────
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

// ── Socket.IO ────────────────────────────────────────────
const io = new Server(server, {
  pingTimeout:       60000,
  pingInterval:      10000,
  upgradeTimeout:    30000,
  maxHttpBufferSize: 50 * 1024 * 1024,
  transports:        ['websocket', 'polling'],
  allowUpgrades:     true,
  cors:              { origin: '*' }
});

const socketMeta = new Map();

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, token }) => {
    const user = getUserByToken(token);
    if (!user) { socket.emit('auth-fail'); return; }

    const room = getRoomById(roomId);
    if (!room) { socket.emit('auth-fail'); return; }

    socketMeta.set(socket.id, { 
      username: user.username, 
      roomId: roomId,
      userId: user.id,
      avatar: user.avatar || null
    });

    socket.join(String(roomId));

    const roomSockets = io.sockets.adapter.rooms.get(String(roomId));
    const existingUsers = Array.from(roomSockets || [])
      .filter(id => id !== socket.id)
      .map(id => ({
        socketId: id,
        username: socketMeta.get(id)?.username || 'Участник',
        avatar: socketMeta.get(id)?.avatar || null,
        userId: socketMeta.get(id)?.userId || null
      }));

    const history = roomMessages.get(Number(roomId)) || [];

    socket.emit('auth-ok', { username: user.username });
    socket.emit('existing-users', existingUsers);
    socket.emit('room-history', { messages: history.slice(-50), pinned: room.pinned_msg_id || null });

    socket.to(String(roomId)).emit('user-joined', {
      socketId: socket.id,
      username: user.username,
      avatar: user.avatar || null,
      userId: user.id
    });

    io.to(String(roomId)).emit('user-count', roomSockets ? roomSockets.size : 1);
  });

  socket.on('offer', ({ to, offer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('chat-message', (data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const msgId = data.msgId || crypto.randomBytes(12).toString('hex');
    const roomId = Number(meta.roomId);

    const msg = {
      msg_id: msgId,
      type: data.type,
      encrypted: data.encrypted,
      iv: data.iv,
      meta_enc: data.metaEnc || null,
      meta_iv: data.metaIv || null,
      file_name: data.fileName || null,
      file_size: data.fileSize || null,
      mime_type: data.mimeType || null,
      deleted: false,
      edited_at: null,
      created_at: new Date().toISOString(),
      username: meta.username,
      avatar: meta.avatar || null,
      user_id: meta.userId
    };

    const arr = roomMessages.get(roomId) || [];
    arr.push(msg);
    roomMessages.set(roomId, arr);

    socket.to(String(meta.roomId)).emit('chat-message', {
      from:      socket.id,
      username:  meta.username,
      avatar:    meta.avatar,
      userId:    meta.userId,
      msgId,
      encrypted: data.encrypted,
      iv:        data.iv,
      metaEnc:   data.metaEnc || null,
      metaIv:    data.metaIv || null,
      type:      data.type,
      fileName:  data.fileName,
      fileSize:  data.fileSize,
      mimeType:  data.mimeType,
      timestamp: Date.now()
    });
  });

  socket.on('message-edit', (data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const roomId = Number(meta.roomId);
    const arr = roomMessages.get(roomId) || [];
    const msg = arr.find(m => m.msg_id === data.msgId && m.user_id === meta.userId);
    if (msg) {
      msg.encrypted = data.encrypted;
      msg.iv = data.iv;
      msg.meta_enc = data.metaEnc || null;
      msg.meta_iv = data.metaIv || null;
      msg.edited_at = new Date().toISOString();
    }

    socket.to(String(meta.roomId)).emit('message-edit', {
      msgId: data.msgId,
      encrypted: data.encrypted,
      iv: data.iv,
      metaEnc: data.metaEnc || null,
      metaIv: data.metaIv || null,
      editedAt: Date.now()
    });
  });

  socket.on('message-delete', ({ msgId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const roomId = Number(meta.roomId);
    const arr = roomMessages.get(roomId) || [];
    const msg = arr.find(m => m.msg_id === msgId && m.user_id === meta.userId);
    if (msg) msg.deleted = true;

    socket.to(String(meta.roomId)).emit('message-delete', { msgId });
  });

  socket.on('reaction-toggle', ({ msgId, emoji }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('reaction-toggle', {
      msgId, emoji, userId: meta.userId, username: meta.username
    });
  });

  socket.on('pin-message', ({ msgId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = getRoomById(meta.roomId);
    if (!room || room.owner_id !== meta.userId) return;

    room.pinned_msg_id = msgId;
    io.to(String(meta.roomId)).emit('room-pinned', { msgId });
  });

  socket.on('unpin-message', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = getRoomById(meta.roomId);
    if (!room || room.owner_id !== meta.userId) return;

    room.pinned_msg_id = null;
    io.to(String(meta.roomId)).emit('room-pinned', { msgId: null });
  });

  socket.on('typing', ({ isTyping }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('typing', { userId: meta.userId, username: meta.username, isTyping: !!isTyping });
  });

  socket.on('understood', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('understood', { from: socket.id, username: meta.username });
  });

  socket.on('video-offer', ({ to, offer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('video-offer', { from: socket.id, offer });
  });

  socket.on('video-answer', ({ to, answer }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('video-answer', { from: socket.id, answer });
  });

  socket.on('video-ice', ({ to, candidate }) => {
    if (!socketMeta.has(socket.id)) return;
    io.to(to).emit('video-ice', { from: socket.id, candidate });
  });

  socket.on('video-start', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('video-start', { from: socket.id, username: meta.username });
  });

  socket.on('video-stop', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('video-stop', { from: socket.id });
  });

  socket.on('leave',      () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(socket) {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      socket.to(String(meta.roomId)).emit('user-left', { socketId: socket.id });
      const roomSockets = io.sockets.adapter.rooms.get(String(meta.roomId));
      const count = roomSockets ? roomSockets.size : 0;
      io.to(String(meta.roomId)).emit('user-count', count);
      socketMeta.delete(socket.id);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
