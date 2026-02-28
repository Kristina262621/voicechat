'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

/* ══════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
const DB_URL = process.env.DATABASE_URL;
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

if (!DB_URL) {
  console.error('❌ DATABASE_URL не задан в переменных окружения');
  process.exit(1);
}

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* ══════════════════════════════════════════════
   DB
══════════════════════════════════════════════ */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      avatar     TEXT,
      bio        TEXT,
      online     BOOLEAN DEFAULT false,
      last_seen  TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id         SERIAL PRIMARY KEY,
      type       TEXT NOT NULL CHECK(type IN ('private','group')),
      name       TEXT,
      avatar     TEXT,
      password   TEXT,
      owner_id   INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id    INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      msg_id     TEXT UNIQUE NOT NULL,
      chat_id    INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id),
      type       TEXT DEFAULT 'text',
      content    TEXT,
      iv         TEXT,
      file_name  TEXT,
      file_size  BIGINT,
      mime_type  TEXT,
      reply_to   TEXT,
      deleted    BOOLEAN DEFAULT false,
      edited_at  TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reactions (
      msg_id  TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      emoji   TEXT NOT NULL,
      PRIMARY KEY (msg_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id         SERIAL PRIMARY KEY,
      from_id    INTEGER REFERENCES users(id),
      to_id      INTEGER REFERENCES users(id),
      status     TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(from_id, to_id)
    );
  `);

  console.log('✅ БД инициализирована');
}

/* ══════════════════════════════════════════════
   APP + SOCKET
══════════════════════════════════════════════ */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*' }
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, UPLOAD_DIR)));

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '').trim();
  const data = verifyToken(token);
  if (!data) return res.json({ ok: false, error: 'unauthorized' });
  req.userId = data.userId;
  next();
}

const rateLimitMap = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const data = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - data.start > windowMs) {
    data.count = 0;
    data.start = now;
  }
  data.count++;
  rateLimitMap.set(key, data);
  return data.count > max;
}

const userSockets = new Map(); // userId -> Set(socketId)
function emitToUser(userId, event, payload) {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}

async function getInitPayload(userId) {
  const userR = await pool.query(
    'SELECT id, username, avatar, bio FROM users WHERE id=$1',
    [userId]
  );

  const chatsR = await pool.query(
    `SELECT
       c.id,
       c.type,
       CASE
         WHEN c.type='private' THEN u_other.username
         ELSE c.name
       END AS name,
       CASE
         WHEN c.type='private' THEN u_other.avatar
         ELSE c.avatar
       END AS avatar,
       CASE
         WHEN c.type='private' THEN u_other.id
         ELSE NULL
       END AS "userId",
       CASE
         WHEN c.type='private' THEN COALESCE(u_other.online, false)
         ELSE false
       END AS online,
       lm.content AS last_msg,
       lm.created_at AS last_msg_at
     FROM chats c
     JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $1
     LEFT JOIN chat_members other_cm
       ON c.type='private' AND other_cm.chat_id = c.id AND other_cm.user_id != $1
     LEFT JOIN users u_other ON u_other.id = other_cm.user_id
     LEFT JOIN LATERAL (
       SELECT m.content, m.created_at
       FROM messages m
       WHERE m.chat_id = c.id AND m.deleted = false
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON true
     ORDER BY lm.created_at DESC NULLS LAST, c.id DESC`,
    [userId]
  );

  const contactsR = await pool.query(
    `SELECT u.id, u.username, u.avatar, u.bio, u.online, u.last_seen
     FROM contacts c
     JOIN users u ON (
       CASE WHEN c.from_id=$1 THEN c.to_id ELSE c.from_id END = u.id
     )
     WHERE (c.from_id=$1 OR c.to_id=$1) AND c.status='accepted'`,
    [userId]
  );

  const reqR = await pool.query(
    `SELECT c.from_id AS "fromId", u.username, u.avatar
     FROM contacts c
     JOIN users u ON u.id = c.from_id
     WHERE c.to_id = $1 AND c.status='pending'
     ORDER BY c.created_at DESC`,
    [userId]
  );

  return {
    user: userR.rows[0] || null,
    chats: chatsR.rows,
    contacts: contactsR.rows,
    pendingRequests: reqR.rows
  };
}

/* ══════════════════════════════════════════════
   MULTER
══════════════════════════════════════════════ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const blocked = ['.exe', '.bat', '.sh', '.cmd', '.msi'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blocked.includes(ext)) return cb(new Error('file_type_blocked'));
    cb(null, true);
  }
});

/* ══════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════ */
async function registerHandler(req, res) {
  const ip = req.ip;
  if (rateLimit(`reg_${ip}`, 5, 60_000)) {
    return res.json({ ok: false, error: 'rate_limited' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'missing_fields' });
  if (username.length < 2 || username.length > 32) return res.json({ ok: false, error: 'username_length' });
  if (password.length < 4) return res.json({ ok: false, error: 'password_short' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(username,password) VALUES($1,$2) RETURNING id,username',
      [username.trim(), hash]
    );
    const user = r.rows[0];
    const token = signToken({ userId: user.id });
    res.json({ ok: true, token, userId: user.id, username: user.username });
  } catch (e) {
    if (e.code === '23505') return res.json({ ok: false, error: 'username_taken' });
    console.error(e);
    res.json({ ok: false, error: 'server_error' });
  }
}

async function loginHandler(req, res) {
  const ip = req.ip;
  if (rateLimit(`login_${ip}`, 10, 60_000)) {
    return res.json({ ok: false, error: 'rate_limited' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'missing_fields' });

  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1', [username.trim()]);
    const user = r.rows[0];
    if (!user) return res.json({ ok: false, error: 'wrong_credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.json({ ok: false, error: 'wrong_credentials' });

    const token = signToken({ userId: user.id });
    res.json({ ok: true, token, userId: user.id, username: user.username });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'server_error' });
  }
}

// Поддерживаем оба формата путей:
app.post('/api/register', registerHandler);
app.post('/api/login', loginHandler);
app.post('/api/auth/register', registerHandler);
app.post('/api/auth/login', loginHandler);

/* ══════════════════════════════════════════════
   PROFILE / USERS
══════════════════════════════════════════════ */
app.put('/api/profile', authMiddleware, async (req, res) => {
  const { bio } = req.body || {};
  await pool.query('UPDATE users SET bio=$1 WHERE id=$2', [bio || null, req.userId]);
  res.json({ ok: true });
});

app.put('/api/me', authMiddleware, async (req, res) => {
  const { avatar, bio } = req.body || {};
  await pool.query(
    'UPDATE users SET avatar=$1, bio=$2 WHERE id=$3',
    [avatar || null, bio || null, req.userId]
  );
  res.json({ ok: true });
});

app.post('/api/verify', async (req, res) => {
  const { token } = req.body || {};
  const data = verifyToken(token);
  if (!data) return res.json({ ok: false });

  const r = await pool.query(
    'SELECT id,username,avatar,bio FROM users WHERE id=$1',
    [data.userId]
  );
  if (!r.rows[0]) return res.json({ ok: false });

  const u = r.rows[0];
  res.json({ ok: true, userId: u.id, username: u.username, avatar: u.avatar, bio: u.bio });
});

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, users: [] });

  const r = await pool.query(
    `SELECT id, username, avatar, bio
     FROM users
     WHERE username ILIKE $1 AND id != $2
     LIMIT 20`,
    [`%${q}%`, req.userId]
  );
  res.json({ ok: true, users: r.rows });
});

/* ══════════════════════════════════════════════
   UPLOADS
══════════════════════════════════════════════ */
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'no_file' });

  res.json({
    ok: true,
    url: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: req.file.mimetype
  });
});

app.post('/api/upload/avatar', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'no_file' });

  const url = `/uploads/${req.file.filename}`;
  await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [url, req.userId]);
  res.json({ ok: true, url });
});

/* ══════════════════════════════════════════════
   CONTACTS
══════════════════════════════════════════════ */
app.get('/api/contacts', authMiddleware, async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.username, u.avatar, u.bio, u.online, u.last_seen
     FROM contacts c
     JOIN users u ON (
       CASE WHEN c.from_id=$1 THEN c.to_id ELSE c.from_id END = u.id
     )
     WHERE (c.from_id=$1 OR c.to_id=$1) AND c.status='accepted'`,
    [req.userId]
  );
  res.json({ ok: true, contacts: r.rows });
});

app.get('/api/contacts/requests', authMiddleware, async (req, res) => {
  const r = await pool.query(
    `SELECT c.from_id AS "fromId", u.username, u.avatar
     FROM contacts c
     JOIN users u ON u.id = c.from_id
     WHERE c.to_id=$1 AND c.status='pending'
     ORDER BY c.created_at DESC`,
    [req.userId]
  );
  res.json({ ok: true, requests: r.rows });
});

app.post('/api/contacts/send', authMiddleware, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId || +userId === req.userId) return res.json({ ok: false, error: 'invalid' });

  try {
    await pool.query(
      'INSERT INTO contacts(from_id,to_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [req.userId, +userId]
    );

    const senderR = await pool.query(
      'SELECT id, username, avatar FROM users WHERE id=$1',
      [req.userId]
    );
    const s = senderR.rows[0];
    emitToUser(+userId, 'contact:request', {
      fromId: s.id,
      username: s.username,
      avatar: s.avatar
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/contacts/accept', authMiddleware, async (req, res) => {
  const { fromId } = req.body || {};
  if (!fromId) return res.json({ ok: false, error: 'invalid' });

  await pool.query(
    `UPDATE contacts
     SET status='accepted'
     WHERE from_id=$1 AND to_id=$2`,
    [+fromId, req.userId]
  );

  const meR = await pool.query(
    'SELECT id, username, avatar, bio, online, last_seen FROM users WHERE id=$1',
    [req.userId]
  );
  const me = meR.rows[0];

  emitToUser(+fromId, 'contact:accepted', me);
  res.json({ ok: true, contact: me });
});

app.post('/api/contacts/reject', authMiddleware, async (req, res) => {
  const { fromId } = req.body || {};
  if (!fromId) return res.json({ ok: false, error: 'invalid' });

  await pool.query(
    'DELETE FROM contacts WHERE from_id=$1 AND to_id=$2',
    [+fromId, req.userId]
  );

  res.json({ ok: true });
});

/* ══════════════════════════════════════════════
   CHATS
══════════════════════════════════════════════ */
app.post('/api/chats/private', authMiddleware, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId || +userId === req.userId) return res.json({ ok: false, error: 'invalid' });

  const existing = await pool.query(
    `SELECT c.id, c.type, c.name, c.avatar
     FROM chats c
     JOIN chat_members cm1 ON cm1.chat_id=c.id AND cm1.user_id=$1
     JOIN chat_members cm2 ON cm2.chat_id=c.id AND cm2.user_id=$2
     WHERE c.type='private'
     LIMIT 1`,
    [req.userId, +userId]
  );
  if (existing.rows[0]) return res.json({ ok: true, chat: existing.rows[0] });

  const uRes = await pool.query('SELECT username FROM users WHERE id=$1', [+userId]);
  const myRes = await pool.query('SELECT username FROM users WHERE id=$1', [req.userId]);
  if (!uRes.rows[0]) return res.json({ ok: false, error: 'user_not_found' });

  const name = `${myRes.rows[0].username} & ${uRes.rows[0].username}`;
  const chatR = await pool.query(
    'INSERT INTO chats(type,name,owner_id) VALUES($1,$2,$3) RETURNING id,type,name,avatar',
    ['private', name, req.userId]
  );
  const chat = chatR.rows[0];

  await pool.query(
    'INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2),($1,$3)',
    [chat.id, req.userId, +userId]
  );

  emitToUser(+userId, 'chat:new', { chat });
  res.json({ ok: true, chat });
});

app.post('/api/chats/group', authMiddleware, async (req, res) => {
  const { name, password, members } = req.body || {};
  if (!name || name.trim().length < 2) return res.json({ ok: false, error: 'invalid_name' });

  const hash = password ? await bcrypt.hash(password, 10) : null;
  const r = await pool.query(
    'INSERT INTO chats(type,name,password,owner_id) VALUES($1,$2,$3,$4) RETURNING id,type,name,avatar,owner_id',
    ['group', name.trim(), hash, req.userId]
  );
  const chat = r.rows[0];

  await pool.query(
    'INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2)',
    [chat.id, req.userId]
  );

  if (Array.isArray(members) && members.length) {
    for (const m of members) {
      if (+m === req.userId) continue;
      await pool.query(
        'INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [chat.id, +m]
      );
    }
  }

  res.json({ ok: true, chat });
});

app.post('/api/chats/:id/join', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;
  const { password } = req.body || {};

  const r = await pool.query('SELECT * FROM chats WHERE id=$1', [chatId]);
  const chat = r.rows[0];
  if (!chat) return res.json({ ok: false, error: 'not_found' });

  if (chat.password) {
    if (!password) return res.json({ ok: false, error: 'password_required' });
    const ok = await bcrypt.compare(password, chat.password);
    if (!ok) return res.json({ ok: false, error: 'wrong_password' });
  }

  await pool.query(
    'INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [chatId, req.userId]
  );

  res.json({ ok: true, chat: { id: chat.id, type: chat.type, name: chat.name, avatar: chat.avatar } });
});

app.post('/api/chats/:id/leave', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;
  await pool.query(
    'DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2',
    [chatId, req.userId]
  );
  res.json({ ok: true });
});

app.post('/api/chats/:id/avatar', authMiddleware, upload.single('file'), async (req, res) => {
  const chatId = +req.params.id;
  if (!req.file) return res.json({ ok: false, error: 'no_file' });

  const own = await pool.query('SELECT owner_id FROM chats WHERE id=$1', [chatId]);
  if (!own.rows[0] || own.rows[0].owner_id !== req.userId) {
    return res.json({ ok: false, error: 'forbidden' });
  }

  const url = `/uploads/${req.file.filename}`;
  await pool.query('UPDATE chats SET avatar=$1 WHERE id=$2', [url, chatId]);
  res.json({ ok: true, url });
});

app.get('/api/chats/:id/messages', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;

  const member = await pool.query(
    'SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2',
    [chatId, req.userId]
  );
  if (!member.rows[0]) return res.json({ ok: false, error: 'forbidden' });

  const r = await pool.query(
    `SELECT
       m.id, m.msg_id, m.chat_id, m.user_id, m.type, m.content, m.iv,
       m.file_name, m.file_size, m.mime_type, m.reply_to, m.deleted,
       m.edited_at, m.created_at,
       u.username, u.avatar,
       COALESCE(
         json_agg(
           json_build_object('emoji', r.emoji, 'userId', r.user_id)
         ) FILTER (WHERE r.emoji IS NOT NULL),
         '[]'
       ) AS reactions
     FROM messages m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN reactions r ON r.msg_id = m.msg_id
     WHERE m.chat_id=$1
     GROUP BY m.id, u.username, u.avatar
     ORDER BY m.created_at ASC`,
    [chatId]
  );

  res.json({ ok: true, messages: r.rows });
});

/* ══════════════════════════════════════════════
   SOCKET AUTH
══════════════════════════════════════════════ */
io.use((socket, next) => {
  const token = socket.handshake?.auth?.token;
  const data = verifyToken(token);
  if (!data) return next(new Error('unauthorized'));
  socket.userId = data.userId;
  next();
});

/* ══════════════════════════════════════════════
   SOCKET EVENTS
══════════════════════════════════════════════ */
io.on('connection', async (socket) => {
  const userId = socket.userId;

  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  await pool.query('UPDATE users SET online=true WHERE id=$1', [userId]);

  const uR = await pool.query('SELECT username FROM users WHERE id=$1', [userId]);
  socket.username = uR.rows[0]?.username || 'User';

  io.emit('user:online', { userId, online: true });

  // initial payload for frontend
  const initPayload = await getInitPayload(userId);
  socket.emit('init', initPayload);

  socket.on('chat:join', async ({ chatId }) => {
    const member = await pool.query(
      'SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2',
      [+chatId, userId]
    );
    if (!member.rows[0]) return;

    if (socket.chatId) socket.leave(`chat_${socket.chatId}`);
    socket.chatId = +chatId;
    socket.join(`chat_${chatId}`);
  });

  socket.on('chat:leave', ({ chatId }) => {
    socket.leave(`chat_${chatId}`);
    if (socket.chatId === +chatId) socket.chatId = null;
  });

  socket.on('msg:send', async (payload) => {
    const {
      msgId,
      chatId,
      type,
      content,
      iv,
      fileName,
      fileSize,
      mimeType,
      replyTo
    } = payload || {};

    if (!msgId || !chatId || !content) return;

    const member = await pool.query(
      'SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2',
      [+chatId, userId]
    );
    if (!member.rows[0]) return;

    try {
      await pool.query(
        `INSERT INTO messages
          (msg_id, chat_id, user_id, type, content, iv, file_name, file_size, mime_type, reply_to)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          msgId, +chatId, userId, type || 'text', content, iv || null,
          fileName || null, fileSize || null, mimeType || null, replyTo || null
        ]
      );
    } catch (e) {
      if (e.code === '23505') return; // duplicate msgId
      console.error(e);
      return;
    }

    const userR = await pool.query(
      'SELECT username, avatar FROM users WHERE id=$1',
      [userId]
    );
    const user = userR.rows[0];

    const fullMsg = {
      msgId,
      msg_id: msgId,
      chatId: +chatId,
      chat_id: +chatId,
      type: type || 'text',
      content,
      iv: iv || null,
      file_name: fileName || null,
      file_size: fileSize || null,
      mime_type: mimeType || null,
      reply_to: replyTo || null,
      user_id: userId,
      username: user.username,
      avatar: user.avatar,
      reactions: [],
      created_at: new Date().toISOString()
    };

    io.to(`chat_${chatId}`).emit('msg:new', fullMsg);
  });

  socket.on('msg:edit', async ({ msgId, content, iv }) => {
    if (!msgId || !content) return;

    const r = await pool.query(
      'SELECT user_id, chat_id FROM messages WHERE msg_id=$1',
      [msgId]
    );
    if (!r.rows[0] || r.rows[0].user_id !== userId) return;

    const editedAt = new Date().toISOString();
    await pool.query(
      'UPDATE messages SET content=$1, iv=$2, edited_at=$3 WHERE msg_id=$4',
      [content, iv || null, editedAt, msgId]
    );

    io.to(`chat_${r.rows[0].chat_id}`).emit('msg:edited', {
      msgId,
      content,
      iv: iv || null,
      editedAt
    });
  });

  socket.on('msg:delete', async ({ msgId }) => {
    if (!msgId) return;

    const r = await pool.query(
      'SELECT user_id, chat_id FROM messages WHERE msg_id=$1',
      [msgId]
    );
    if (!r.rows[0] || r.rows[0].user_id !== userId) return;

    await pool.query('UPDATE messages SET deleted=true WHERE msg_id=$1', [msgId]);
    io.to(`chat_${r.rows[0].chat_id}`).emit('msg:deleted', { msgId });
  });

  socket.on('msg:react', async ({ msgId, emoji }) => {
    if (!msgId || !emoji) return;

    const msgR = await pool.query('SELECT chat_id FROM messages WHERE msg_id=$1', [msgId]);
    if (!msgR.rows[0]) return;

    const existing = await pool.query(
      'SELECT 1 FROM reactions WHERE msg_id=$1 AND user_id=$2 AND emoji=$3',
      [msgId, userId, emoji]
    );

    if (existing.rows[0]) {
      await pool.query(
        'DELETE FROM reactions WHERE msg_id=$1 AND user_id=$2 AND emoji=$3',
        [msgId, userId, emoji]
      );
    } else {
      await pool.query(
        'INSERT INTO reactions(msg_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [msgId, userId, emoji]
      );
    }

    const allR = await pool.query(
      `SELECT emoji, user_id AS "userId"
       FROM reactions
       WHERE msg_id=$1`,
      [msgId]
    );

    io.to(`chat_${msgR.rows[0].chat_id}`).emit('msg:reaction', {
      msgId,
      reactions: allR.rows
    });
  });

  socket.on('chat:typing', ({ chatId, isTyping }) => {
    if (!chatId) return;
    socket.to(`chat_${chatId}`).emit('chat:typing', {
      chatId: +chatId,
      userId,
      username: socket.username,
      isTyping: !!isTyping
    });
  });

  socket.on('msg:read', ({ msgId, chatId }) => {
    if (!chatId) return;
    io.to(`chat_${chatId}`).emit('msg:read', { msgId, userId });
  });

  socket.on('groups:explore', async ({ query = '' } = {}) => {
    const r = await pool.query(
      `SELECT c.id, c.name, c.avatar,
              COUNT(cm.user_id)::int AS member_count
       FROM chats c
       LEFT JOIN chat_members cm ON cm.chat_id = c.id
       WHERE c.type='group' AND ($1 = '' OR c.name ILIKE $2)
       GROUP BY c.id
       ORDER BY member_count DESC
       LIMIT 30`,
      [query.trim(), `%${query.trim()}%`]
    );

    socket.emit('groups:explore', { groups: r.rows });
  });

  socket.on('disconnect', async () => {
    const set = userSockets.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        userSockets.delete(userId);
        await pool.query(
          'UPDATE users SET online=false, last_seen=NOW() WHERE id=$1',
          [userId]
        );
        io.emit('user:online', { userId, online: false });
        io.emit('user:offline', { userId });
      }
    }
  });
});

/* ══════════════════════════════════════════════
   START
══════════════════════════════════════════════ */
initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`✅ Сервер запущен на порту ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('❌ Ошибка БД:', e);
    process.exit(1);
  });
