'use strict';

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const multer     = require('multer');
const fs         = require('fs');

// ══════════════════════════════════════════════
//  КОНФИГ
// ══════════════════════════════════════════════
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
const DB_URL     = process.env.DATABASE_URL;
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Создаём папку uploads если нет
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ══════════════════════════════════════════════
//  БД
// ══════════════════════════════════════════════
const pool = new Pool({
  connectionString: DB_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
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
  console.log('БД инициализирована');
}

// ══════════════════════════════════════════════
//  MULTER — загрузка файлов
// ══════════════════════════════════════════════
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    // Блокируем опасные типы
    const blocked = ['.exe', '.bat', '.sh', '.cmd', '.msi'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blocked.includes(ext)) {
      return cb(new Error('file_type_blocked'));
    }
    cb(null, true);
  }
});

// ══════════════════════════════════════════════
//  APP
// ══════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*' }
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, UPLOAD_DIR)));

// ══════════════════════════════════════════════
//  ХЕЛПЕРЫ
// ══════════════════════════════════════════════
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  const data   = verifyToken(token);
  if (!data) return res.json({ ok: false, error: 'unauthorized' });
  req.userId = data.userId;
  next();
}

// Rate limiter
const rateLimitMap = new Map();
function rateLimit(key, max, windowMs) {
  const now  = Date.now();
  const data = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - data.start > windowMs) { data.count = 0; data.start = now; }
  data.count++;
  rateLimitMap.set(key, data);
  return data.count > max;
}

// ══════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════
app.post('/api/register', async (req, res) => {
  const ip = req.ip;
  if (rateLimit(`reg_${ip}`, 5, 60000))
    return res.json({ ok: false, error: 'rate_limited' });

  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ ok: false, error: 'missing_fields' });
  if (username.length < 2 || username.length > 32)
    return res.json({ ok: false, error: 'username_length' });
  if (password.length < 4)
    return res.json({ ok: false, error: 'password_short' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const r    = await pool.query(
      'INSERT INTO users(username,password) VALUES($1,$2) RETURNING id,username',
      [username, hash]
    );
    const user  = r.rows[0];
    const token = signToken({ userId: user.id });
    res.json({ ok: true, token, userId: user.id, username: user.username });
  } catch (e) {
    if (e.code === '23505') return res.json({ ok: false, error: 'username_taken' });
    console.error(e);
    res.json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  if (rateLimit(`login_${ip}`, 10, 60000))
    return res.json({ ok: false, error: 'rate_limited' });

  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ ok: false, error: 'missing_fields' });

  try {
    const r    = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const user = r.rows[0];
    if (!user) return res.json({ ok: false, error: 'wrong_credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)  return res.json({ ok: false, error: 'wrong_credentials' });

    const token = signToken({ userId: user.id });
    res.json({ ok: true, token, userId: user.id, username: user.username });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/logout', authMiddleware, async (req, res) => {
  await pool.query(
    'UPDATE users SET online=false, last_seen=NOW() WHERE id=$1',
    [req.userId]
  );
  res.json({ ok: true });
});

app.post('/api/verify', async (req, res) => {
  const { token } = req.body;
  const data = verifyToken(token);
  if (!data) return res.json({ ok: false });
  const r = await pool.query(
    'SELECT id,username,avatar,bio FROM users WHERE id=$1', [data.userId]
  );
  if (!r.rows[0]) return res.json({ ok: false });
  const u = r.rows[0];
  res.json({ ok: true, userId: u.id, username: u.username, avatar: u.avatar, bio: u.bio });
});

// ══════════════════════════════════════════════
//  USER ROUTES
// ══════════════════════════════════════════════
app.put('/api/me', authMiddleware, async (req, res) => {
  const { avatar, bio } = req.body;
  await pool.query(
    'UPDATE users SET avatar=$1, bio=$2 WHERE id=$3',
    [avatar || null, bio || null, req.userId]
  );
  res.json({ ok: true });
});

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, users: [] });
  const r = await pool.query(
    `SELECT id, username, avatar, bio FROM users
     WHERE username ILIKE $1 AND id != $2
     LIMIT 20`,
    [`%${q}%`, req.userId]
  );
  res.json({ ok: true, users: r.rows });
});

app.get('/api/users/:id/status', authMiddleware, async (req, res) => {
  const r = await pool.query(
    'SELECT online, last_seen FROM users WHERE id=$1',
    [+req.params.id]
  );
  if (!r.rows[0]) return res.json({ ok: false });
  res.json({ ok: true, ...r.rows[0] });
});

// ══════════════════════════════════════════════
//  UPLOAD ROUTE
// ══════════════════════════════════════════════
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'no_file' });
  res.json({
    ok:       true,
    url:      `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: req.file.mimetype
  });
}, (err, req, res, next) => {
  res.json({ ok: false, error: err.message });
});

// ══════════════════════════════════════════════
//  CONTACTS ROUTES
// ══════════════════════════════════════════════
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
    `SELECT u.id, u.username, u.avatar
     FROM contacts c
     JOIN users u ON c.from_id = u.id
     WHERE c.to_id=$1 AND c.status='pending'`,
    [req.userId]
  );
  res.json({ ok: true, requests: r.rows });
});

app.post('/api/contacts/send', authMiddleware, async (req, res) => {
  const { userId } = req.body;
  if (!userId || +userId === req.userId)
    return res.json({ ok: false, error: 'invalid' });
  try {
    await pool.query(
      'INSERT INTO contacts(from_id,to_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [req.userId, userId]
    );

    // Оповещаем получателя через сокет
    const senderR = await pool.query(
      'SELECT username, avatar FROM users WHERE id=$1', [req.userId]
    );
    const sender = senderR.rows[0];
    emitToUser(+userId, 'contact:request', {
      fromId:   req.userId,
      username: sender.username,
      avatar:   sender.avatar
    });

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/contacts/respond', authMiddleware, async (req, res) => {
  const { fromId, accept } = req.body;
  if (accept) {
    await pool.query(
      `UPDATE contacts SET status='accepted' WHERE from_id=$1 AND to_id=$2`,
      [fromId, req.userId]
    );
    // Оповещаем отправителя
    emitToUser(+fromId, 'contact:accepted', { userId: req.userId });
  } else {
    await pool.query(
      'DELETE FROM contacts WHERE from_id=$1 AND to_id=$2',
      [fromId, req.userId]
    );
  }
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', authMiddleware, async (req, res) => {
  const contactId = +req.params.id;
  await pool.query(
    `DELETE FROM contacts
     WHERE ((from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1))
     AND status='accepted'`,
    [req.userId, contactId]
  );
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
//  CHATS ROUTES
// ══════════════════════════════════════════════
app.get('/api/chats', authMiddleware, async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.type, c.name, c.avatar, c.owner_id,
            (c.password IS NOT NULL) as has_password,
            m.content as last_msg,
            m.created_at as last_msg_at,
            COUNT(unread.id) FILTER (
              WHERE unread.created_at > COALESCE(cm.joined_at, '1970-01-01')
              AND unread.user_id != $1
            ) as unread
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
     LEFT JOIN LATERAL (
       SELECT content, created_at FROM messages
       WHERE chat_id = c.id AND deleted = false
       ORDER BY created_at DESC LIMIT 1
     ) m ON true
     LEFT JOIN messages unread ON unread.chat_id = c.id
     GROUP BY c.id, m.content, m.created_at, cm.joined_at
     ORDER BY m.created_at DESC NULLS LAST`,
    [req.userId]
  );
  res.json({ ok: true, chats: r.rows });
});

app.get('/api/chats/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  const r = await pool.query(
    `SELECT c.id, c.name, c.avatar,
            (c.password IS NOT NULL) as has_password,
            COUNT(cm.user_id) as member_count
     FROM chats c
     LEFT JOIN chat_members cm ON cm.chat_id = c.id
     WHERE c.type='group' AND ($1 = '' OR c.name ILIKE $2)
     GROUP BY c.id
     ORDER BY member_count DESC
     LIMIT 30`,
    [q, `%${q}%`]
  );
  res.json({ ok: true, chats: r.rows });
});

app.post('/api/chats/private', authMiddleware, async (req, res) => {
  const { userId } = req.body;
  if (!userId || +userId === req.userId)
    return res.json({ ok: false, error: 'invalid' });

  const existing = await pool.query(
    `SELECT c.id FROM chats c
     JOIN chat_members cm1 ON cm1.chat_id=c.id AND cm1.user_id=$1
     JOIN chat_members cm2 ON cm2.chat_id=c.id AND cm2.user_id=$2
     WHERE c.type='private' LIMIT 1`,
    [req.userId, userId]
  );
  if (existing.rows[0])
    return res.json({ ok: true, chat: existing.rows[0] });

  const uRes  = await pool.query('SELECT username FROM users WHERE id=$1', [userId]);
  const myRes = await pool.query('SELECT username FROM users WHERE id=$1', [req.userId]);
  if (!uRes.rows[0]) return res.json({ ok: false, error: 'user_not_found' });

  const name  = `${myRes.rows[0].username} & ${uRes.rows[0].username}`;
  const chatR = await pool.query(
    'INSERT INTO chats(type,name,owner_id) VALUES($1,$2,$3) RETURNING *',
    ['private', name, req.userId]
  );
  const chat = chatR.rows[0];
  await pool.query(
    'INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2),($1,$3)',
    [chat.id, req.userId, userId]
  );

  // Оповещаем второго участника
  emitToUser(+userId, 'chat:new', { chat });

  res.json({ ok: true, chat });
});

app.post('/api/chats/group', authMiddleware, async (req, res) => {
  const { name, password } = req.body;
  if (!name || name.length < 2)
    return res.json({ ok: false, error: 'invalid_name' });

  const hash = password ? await bcrypt.hash(password, 10) : null;
  const r    = await pool.query(
    'INSERT INTO chats(type,name,password,owner_id) VALUES($1,$2,$3,$4) RETURNING *',
    ['group', name, hash, req.userId]
  );
  const chat = r.rows[0];
  await pool.query(
    'INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2)',
    [chat.id, req.userId]
  );
  res.json({ ok: true, chat });
});

app.post('/api/chats/:id/join', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;
  const { password } = req.body;

  const r    = await pool.query('SELECT * FROM chats WHERE id=$1', [chatId]);
  const chat = r.rows[0];
  if (!chat) return res.json({ ok: false, error: 'not_found' });

  if (chat.password) {
    if (!password) return res.json({ ok: false, error: 'password_required' });
    const ok = await bcrypt.compare(password, chat.password);
    if (!ok)  return res.json({ ok: false, error: 'wrong_password' });
  }

  await pool.query(
    'INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [chatId, req.userId]
  );
  res.json({ ok: true, chat });
});

app.delete('/api/chats/:id/leave', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;
  await pool.query(
    'DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2',
    [chatId, req.userId]
  );
  res.json({ ok: true });
});

app.put('/api/chats/:id/avatar', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;
  const { avatar } = req.body;
  const r = await pool.query('SELECT owner_id FROM chats WHERE id=$1', [chatId]);
  if (!r.rows[0] || r.rows[0].owner_id !== req.userId)
    return res.json({ ok: false, error: 'forbidden' });
  await pool.query('UPDATE chats SET avatar=$1 WHERE id=$2', [avatar, chatId]);
  res.json({ ok: true });
});

app.get('/api/chats/:id/members', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;
  const member = await pool.query(
    'SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2',
    [chatId, req.userId]
  );
  if (!member.rows[0]) return res.json({ ok: false, error: 'forbidden' });

  const r = await pool.query(
    `SELECT u.id, u.username, u.avatar, u.online, u.last_seen
     FROM chat_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id=$1`,
    [chatId]
  );
  res.json({ ok: true, members: r.rows });
});

// ══════════════════════════════════════════════
//  MESSAGES ROUTES
// ══════════════════════════════════════════════
app.get('/api/chats/:id/messages', authMiddleware, async (req, res) => {
  const chatId = +req.params.id;
  const limit  = Math.min(+req.query.limit || 50, 100);
  const before = req.query.before;

  const member = await pool.query(
    'SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2',
    [chatId, req.userId]
  );
  if (!member.rows[0]) return res.json({ ok: false, error: 'forbidden' });

  const params = before ? [chatId, limit, before] : [chatId, limit];
  const r = await pool.query(
    `SELECT m.id, m.msg_id, m.chat_id, m.user_id, m.type,
            m.content, m.iv, m.file_name, m.file_size,
            m.mime_type, m.reply_to, m.deleted,
            m.edited_at, m.created_at,
            u.username, u.avatar,
            COALESCE(
              json_agg(
                json_build_object('emoji', r.emoji, 'userId', r.user_id)
              ) FILTER (WHERE r.emoji IS NOT NULL),
              '[]'
            ) as reactions
     FROM messages m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN reactions r ON r.msg_id = m.msg_id
     WHERE m.chat_id=$1
       ${before ? 'AND m.created_at < $3' : ''}
     GROUP BY m.id, u.username, u.avatar
     ORDER BY m.created_at ASC
     LIMIT $2`,
    params
  );
  res.json({ ok: true, messages: r.rows });
});

// ══════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════
const userSockets = new Map(); // userId → Set<socketId>

// Хелпер — отправить событие конкретному юзеру
function emitToUser(userId, event, data) {
  const sockets = userSockets.get(userId);
  if (sockets) {
    sockets.forEach(socketId => {
      io.to(socketId).emit(event, data);
    });
  }
}

io.on('connection', (socket) => {

  // ── Аутентификация сокета ──────────────────
  socket.on('auth', async ({ token }) => {
    const data = verifyToken(token);
    if (!data) { socket.emit('auth:error', { error: 'invalid_token' }); return; }

    socket.userId = data.userId;

    if (!userSockets.has(data.userId))
      userSockets.set(data.userId, new Set());
    userSockets.get(data.userId).add(socket.id);

    await pool.query(
      'UPDATE users SET online=true WHERE id=$1', [data.userId]
    );

    const userR = await pool.query(
      'SELECT id, username, avatar, bio FROM users WHERE id=$1', [data.userId]
    );

    socket.emit('auth:ok', userR.rows[0]);
    io.emit('user:online', { userId: data.userId, online: true });
  });

  // ── Присоединиться к чату ──────────────────
  socket.on('chat:join', async ({ chatId }) => {
    if (!socket.userId) return;

    const member = await pool.query(
      'SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2',
      [chatId, socket.userId]
    );
    if (!member.rows[0]) return;

    // Выходим из предыдущего чата
    if (socket.chatId) socket.leave(`chat_${socket.chatId}`);

    socket.chatId = chatId;
    socket.join(`chat_${chatId}`);
    socket.emit('chat:joined', { chatId });
  });

  // ── Выйти из чата ─────────────────────────
  socket.on('chat:leave', ({ chatId }) => {
    socket.leave(`chat_${chatId}`);
    if (socket.chatId === chatId) socket.chatId = null;
  });

  // ── Отправить сообщение ───────────────────
  socket.on('msg:send', async (payload) => {
    if (!socket.userId || !socket.chatId) return;

    const { msgId, type, content, iv, fileName,
            fileSize, mimeType, replyTo } = payload;

    if (!msgId || !content) return;

    // Проверяем членство
    const member = await pool.query(
      'SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2',
      [socket.chatId, socket.userId]
    );
    if (!member.rows[0]) return;

    try {
      await pool.query(
        `INSERT INTO messages
           (msg_id, chat_id, user_id, type, content, iv,
            file_name, file_size, mime_type, reply_to)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [msgId, socket.chatId, socket.userId, type || 'text',
         content, iv || null, fileName || null,
         fileSize || null, mimeType || null, replyTo || null]
      );
    } catch (e) {
      // Дубликат msgId
      if (e.code === '23505') return;
      throw e;
    }

    const userR = await pool.query(
      'SELECT username, avatar FROM users WHERE id=$1', [socket.userId]
    );
    const user = userR.rows[0];

    const fullMsg = {
      msgId,
      msg_id:    msgId,
      chatId:    socket.chatId,
      chat_id:   socket.chatId,
      type:      type || 'text',
      content,
      iv:        iv        || null,
      file_name: fileName  || null,
      file_size: fileSize  || null,
      mime_type: mimeType  || null,
      reply_to:  replyTo   || null,
      user_id:   socket.userId,
      username:  user.username,
      avatar:    user.avatar,
      reactions: [],
      created_at: new Date().toISOString()
    };

    io.to(`chat_${socket.chatId}`).emit('msg:new', fullMsg);
    socket.emit('msg:sent', { msgId, timestamp: fullMsg.created_at });
  });

  // ── Редактировать сообщение ───────────────
  socket.on('msg:edit', async ({ msgId, content, iv }) => {
    if (!socket.userId) return;

    const r = await pool.query(
      'SELECT user_id, chat_id FROM messages WHERE msg_id=$1', [msgId]
    );
    if (!r.rows[0] || r.rows[0].user_id !== socket.userId) return;

    const now = new Date().toISOString();
    await pool.query(
      'UPDATE messages SET content=$1, iv=$2, edited_at=$3 WHERE msg_id=$4',
      [content, iv || null, now, msgId]
    );

    io.to(`chat_${r.rows[0].chat_id}`).emit('msg:edited', {
      msgId, content, iv, editedAt: now
    });
  });

  // ── Удалить сообщение ─────────────────────
  socket.on('msg:delete', async ({ msgId }) => {
    if (!socket.userId) return;

    const r = await pool.query(
      'SELECT user_id, chat_id FROM messages WHERE msg_id=$1', [msgId]
    );
    if (!r.rows[0] || r.rows[0].user_id !== socket.userId) return;

    await pool.query(
      'UPDATE messages SET deleted=true WHERE msg_id=$1', [msgId]
    );

    io.to(`chat_${r.rows[0].chat_id}`).emit('msg:deleted', { msgId });
  });

    // ── Реакция ───────────────────────────────
  socket.on('msg:react', async ({ msgId, emoji }) => {
    if (!socket.userId) return;

    const r = await pool.query(
      'SELECT chat_id FROM messages WHERE msg_id=$1', [msgId]
    );
    if (!r.rows[0]) return;

    // Если уже поставил — убираем (toggle)
    const existing = await pool.query(
      'SELECT 1 FROM reactions WHERE msg_id=$1 AND user_id=$2 AND emoji=$3',
      [msgId, socket.userId, emoji]
    );

    if (existing.rows[0]) {
      await pool.query(
        'DELETE FROM reactions WHERE msg_id=$1 AND user_id=$2 AND emoji=$3',
        [msgId, socket.userId, emoji]
      );
    } else {
      await pool.query(
        'INSERT INTO reactions(msg_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [msgId, socket.userId, emoji]
      );
    }

    const userR = await pool.query(
      'SELECT username FROM users WHERE id=$1', [socket.userId]
    );

    io.to(`chat_${r.rows[0].chat_id}`).emit('msg:reaction', {
      msgId,
      emoji,
      userId:   socket.userId,
      username: userR.rows[0]?.username,
      removed:  !!existing.rows[0]
    });
  });

  // ── Печатает ──────────────────────────────
  socket.on('chat:typing', ({ chatId, isTyping }) => {
    if (!socket.userId) return;
    socket.to(`chat_${chatId}`).emit('chat:typing', {
      userId:   socket.userId,
      isTyping
    });
  });

  // ── Прочитано ─────────────────────────────
  socket.on('msg:read', async ({ msgId, chatId }) => {
    if (!socket.userId) return;
    io.to(`chat_${chatId}`).emit('msg:read', {
      msgId,
      userId: socket.userId
    });
  });

  // ── Исследовать группы ────────────────────
  socket.on('groups:explore', async ({ query = '' }) => {
    if (!socket.userId) return;
    const r = await pool.query(
      `SELECT c.id, c.name, c.avatar,
              (c.password IS NOT NULL) as has_password,
              COUNT(cm.user_id) as member_count
       FROM chats c
       LEFT JOIN chat_members cm ON cm.chat_id = c.id
       WHERE c.type='group' AND ($1 = '' OR c.name ILIKE $2)
       GROUP BY c.id
       ORDER BY member_count DESC
       LIMIT 30`,
      [query, `%${query}%`]
    );
    socket.emit('groups:list', { chats: r.rows });
  });

  // ── Отключение ────────────────────────────
  socket.on('disconnect', async () => {
    if (!socket.userId) return;

    const sockets = userSockets.get(socket.userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(socket.userId);
        await pool.query(
          'UPDATE users SET online=false, last_seen=NOW() WHERE id=$1',
          [socket.userId]
        );
        io.emit('user:online', { userId: socket.userId, online: false });
      }
    }
  });
});

// ══════════════════════════════════════════════
//  СТАРТ
// ══════════════════════════════════════════════
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
  });
}).catch(e => {
  console.error('Ошибка БД:', e);
  process.exit(1);
});
