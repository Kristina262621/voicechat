'use strict';

/* ═══════════════════════════════════════════════════════════
   ИМПОРТЫ И КОНФИГУРАЦИЯ
═══════════════════════════════════════════════════════════ */
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const Database   = require('better-sqlite3');

/* ── Константы ──────────────────────────────────────────── */
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production';
const NODE_ENV   = process.env.NODE_ENV   || 'development';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH    = path.join(__dirname, 'voicechat.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ── Создаём папку для загрузок ─────────────────────────── */
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ═══════════════════════════════════════════════════════════
   БАЗА ДАННЫХ (SQLite)
═══════════════════════════════════════════════════════════ */
const db = new Database(DB_PATH);

/* WAL-режим — быстрее при многих записях */
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ── Схема ──────────────────────────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password   TEXT NOT NULL,
    avatar     TEXT DEFAULT NULL,
    bio        TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    password   TEXT DEFAULT NULL,
    is_group   INTEGER DEFAULT 0,
    pinned_msg TEXT DEFAULT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    text        TEXT DEFAULT '',
    file_url    TEXT DEFAULT NULL,
    file_type   TEXT DEFAULT NULL,
    file_name   TEXT DEFAULT NULL,
    file_size   INTEGER DEFAULT NULL,
    reply_to    TEXT DEFAULT NULL,
    edited      INTEGER DEFAULT 0,
    deleted     INTEGER DEFAULT 0,
    created_at  INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contacts (
    user_id    TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    status     TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (user_id, contact_id),
    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, status);
`);

/* ── Подготовленные запросы ─────────────────────────────── */
const stmt = {
  /* users */
  createUser:      db.prepare(`INSERT INTO users (id,username,password) VALUES (?,?,?)`),
  getUserByName:   db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  getUserById:     db.prepare(`SELECT * FROM users WHERE id = ?`),
  updateAvatar:    db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`),
  updateBio:       db.prepare(`UPDATE users SET bio = ? WHERE id = ?`),

  /* rooms */
  createRoom:      db.prepare(`INSERT INTO rooms (id,name,owner_id,password,is_group) VALUES (?,?,?,?,?)`),
  getRooms:        db.prepare(`SELECT r.*, u.username as owner_name FROM rooms r JOIN users u ON r.owner_id=u.id ORDER BY r.created_at DESC`),
  getRoomById:     db.prepare(`SELECT * FROM rooms WHERE id = ?`),
  deleteRoom:      db.prepare(`DELETE FROM rooms WHERE id = ?`),
  setPinnedMsg:    db.prepare(`UPDATE rooms SET pinned_msg = ? WHERE id = ?`),

  /* members */
  addMember:       db.prepare(`INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)`),
  removeMember:    db.prepare(`DELETE FROM room_members WHERE room_id=? AND user_id=?`),
  getMembers:      db.prepare(`SELECT u.id,u.username,u.avatar FROM room_members rm JOIN users u ON rm.user_id=u.id WHERE rm.room_id=?`),
  isMember:        db.prepare(`SELECT 1 FROM room_members WHERE room_id=? AND user_id=?`),

  /* messages */
  createMessage:   db.prepare(`INSERT INTO messages (id,room_id,user_id,text,file_url,file_type,file_name,file_size,reply_to) VALUES (?,?,?,?,?,?,?,?,?)`),
  getMessages:     db.prepare(`SELECT m.*,u.username,u.avatar FROM messages m JOIN users u ON m.user_id=u.id WHERE m.room_id=? ORDER BY m.created_at ASC LIMIT 100`),
  getMessageById:  db.prepare(`SELECT * FROM messages WHERE id=?`),
  editMessage:     db.prepare(`UPDATE messages SET text=?,edited=1 WHERE id=? AND user_id=?`),
  deleteMessage:   db.prepare(`UPDATE messages SET deleted=1,text='' WHERE id=? AND user_id=?`),
  deleteMessageMod:db.prepare(`UPDATE messages SET deleted=1,text='' WHERE id=?`),

  /* reactions */
  addReaction:     db.prepare(`INSERT OR REPLACE INTO reactions (message_id,user_id,emoji) VALUES (?,?,?)`),
  removeReaction:  db.prepare(`DELETE FROM reactions WHERE message_id=? AND user_id=?`),
  getReactions:    db.prepare(`SELECT emoji,COUNT(*) as count,GROUP_CONCAT(user_id) as users FROM reactions WHERE message_id=? GROUP BY emoji`),
  getUserReaction: db.prepare(`SELECT emoji FROM reactions WHERE message_id=? AND user_id=?`),

  /* contacts */
  sendRequest:     db.prepare(`INSERT OR IGNORE INTO contacts (user_id,contact_id,status) VALUES (?,?,'pending')`),
  acceptContact:   db.prepare(`UPDATE contacts SET status='accepted' WHERE user_id=? AND contact_id=?`),
  declineContact:  db.prepare(`DELETE FROM contacts WHERE user_id=? AND contact_id=?`),
  getContacts:     db.prepare(`SELECT u.id,u.username,u.avatar,u.bio FROM contacts c JOIN users u ON c.contact_id=u.id WHERE c.user_id=? AND c.status='accepted'`),
  getRequests:     db.prepare(`SELECT u.id,u.username,u.avatar FROM contacts c JOIN users u ON c.user_id=u.id WHERE c.contact_id=? AND c.status='pending'`),
  isContact:       db.prepare(`SELECT status FROM contacts WHERE user_id=? AND contact_id=?`),
};

/* ═══════════════════════════════════════════════════════════
   EXPRESS + SOCKET.IO
═══════════════════════════════════════════════════════════ */
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  maxHttpBufferSize: 20 * 1024 * 1024   /* 20 MB */
});

/* ── Middleware ─────────────────────────────────────────── */
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

/* ── Multer (загрузка файлов) ───────────────────────────── */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req,  file, cb) => {
    const ext  = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /image|audio|video|pdf|msword|officedocument|text|zip/;
    cb(null, allowed.test(file.mimetype));
  }
});

/* ═══════════════════════════════════════════════════════════
   ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
═══════════════════════════════════════════════════════════ */

/** JWT — создать токен */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

/** JWT — проверить токен */
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

/** Middleware — проверка авторизации HTTP */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'Не авторизован' });
  req.user = payload;
  next();
}

/** Получить реакции для сообщения */
function getReactionsForMsg(msgId) {
  return stmt.getReactions.all(msgId).map(r => ({
    emoji: r.emoji,
    count: r.count,
    users: r.users ? r.users.split(',') : []
  }));
}

/** Форматировать сообщение для клиента */
function formatMessage(msg) {
  return {
    id:        msg.id,
    roomId:    msg.room_id,
    userId:    msg.user_id,
    username:  msg.username,
    avatar:    msg.avatar    || null,
    text:      msg.deleted   ? '' : msg.text,
    fileUrl:   msg.file_url  || null,
    fileType:  msg.file_type || null,
    fileName:  msg.file_name || null,
    fileSize:  msg.file_size || null,
    replyTo:   msg.reply_to  || null,
    edited:    !!msg.edited,
    deleted:   !!msg.deleted,
    createdAt: msg.created_at,
    reactions: getReactionsForMsg(msg.id)
  };
}

/** Онлайн-пользователи: Map roomId → Set { userId } */
const roomOnline = new Map();

/** socketId → userId */
const socketUser = new Map();

/** userId → socketId */
const userSocket = new Map();

function getRoomOnline(roomId) {
  return roomOnline.get(roomId) || new Set();
}
/* ═══════════════════════════════════════════════════════════
   REST API — АВТОРИЗАЦИЯ
═══════════════════════════════════════════════════════════ */

/** POST /api/register */
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Укажите имя и пароль' });

    if (username.length < 2 || username.length > 32)
      return res.status(400).json({ error: 'Имя: 2–32 символа' });

    if (password.length < 4)
      return res.status(400).json({ error: 'Пароль минимум 4 символа' });

    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_\-\.]+$/.test(username))
      return res.status(400).json({ error: 'Имя содержит недопустимые символы' });

    const existing = stmt.getUserByName.get(username);
    if (existing)
      return res.status(409).json({ error: 'Имя уже занято' });

    const hash = await bcrypt.hash(password, 10);
    const id   = uuidv4();
    stmt.createUser.run(id, username, hash);

    const token = signToken({ id, username });
    res.json({ token, user: { id, username, avatar: null, bio: '' } });

  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/** POST /api/login */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Укажите имя и пароль' });

    const user = stmt.getUserByName.get(username);
    if (!user)
      return res.status(401).json({ error: 'Неверное имя или пароль' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(401).json({ error: 'Неверное имя или пароль' });

    const token = signToken({ id: user.id, username: user.username });
    res.json({
      token,
      user: {
        id:       user.id,
        username: user.username,
        avatar:   user.avatar || null,
        bio:      user.bio    || ''
      }
    });

  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/* ═══════════════════════════════════════════════════════════
   REST API — ПРОФИЛЬ
═══════════════════════════════════════════════════════════ */

/** GET /api/me */
app.get('/api/me', authMiddleware, (req, res) => {
  const user = stmt.getUserById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({
    id:       user.id,
    username: user.username,
    avatar:   user.avatar || null,
    bio:      user.bio    || ''
  });
});

/** POST /api/me/avatar */
app.post('/api/me/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'Файл не загружен' });

    const url = `/uploads/${req.file.filename}`;
    stmt.updateAvatar.run(url, req.user.id);

    /* Удаляем старый аватар */
    const user = stmt.getUserById.get(req.user.id);
    if (user && user.avatar) {
      const old = path.join(__dirname, user.avatar);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }

    res.json({ avatar: url });
  } catch (err) {
    console.error('[avatar]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/** PATCH /api/me/bio */
app.patch('/api/me/bio', authMiddleware, (req, res) => {
  const { bio } = req.body;
  if (typeof bio !== 'string')
    return res.status(400).json({ error: 'Неверные данные' });

  stmt.updateBio.run(bio.slice(0, 200), req.user.id);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   REST API — КОМНАТЫ
═══════════════════════════════════════════════════════════ */

/** GET /api/rooms */
app.get('/api/rooms', authMiddleware, (req, res) => {
  const rooms = stmt.getRooms.all().map(r => ({
    id:        r.id,
    name:      r.name,
    ownerId:   r.owner_id,
    ownerName: r.owner_name,
    hasPass:   !!r.password,
    isGroup:   !!r.is_group,
    pinned:    r.pinned_msg || null,
    online:    getRoomOnline(r.id).size,
    createdAt: r.created_at
  }));
  res.json(rooms);
});

/** POST /api/rooms */
app.post('/api/rooms', authMiddleware, async (req, res) => {
  try {
    const { name, password, isGroup } = req.body;

    if (!name || name.trim().length < 1)
      return res.status(400).json({ error: 'Укажите название комнаты' });

    if (name.trim().length > 64)
      return res.status(400).json({ error: 'Название слишком длинное' });

    const id   = uuidv4();
    const hash = password ? await bcrypt.hash(password, 8) : null;

    stmt.createRoom.run(id, name.trim(), req.user.id, hash, isGroup ? 1 : 0);
    stmt.addMember.run(id, req.user.id);

    const room = stmt.getRoomById.get(id);
    const owner = stmt.getUserById.get(req.user.id);

    const result = {
      id,
      name:      room.name,
      ownerId:   room.owner_id,
      ownerName: owner.username,
      hasPass:   !!room.password,
      isGroup:   !!room.is_group,
      pinned:    null,
      online:    0,
      createdAt: room.created_at
    };

    io.emit('room:created', result);
    res.json(result);

  } catch (err) {
    console.error('[createRoom]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/** DELETE /api/rooms/:id */
app.delete('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = stmt.getRoomById.get(req.params.id);
  if (!room)
    return res.status(404).json({ error: 'Комната не найдена' });

  if (room.owner_id !== req.user.id)
    return res.status(403).json({ error: 'Только владелец может удалить комнату' });

  stmt.deleteRoom.run(room.id);
  io.emit('room:deleted', { roomId: room.id });
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   REST API — СООБЩЕНИЯ
═══════════════════════════════════════════════════════════ */

/** GET /api/rooms/:id/messages */
app.get('/api/rooms/:id/messages', authMiddleware, (req, res) => {
  const room = stmt.getRoomById.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Комната не найдена' });

  const messages = stmt.getMessages.all(room.id).map(formatMessage);
  res.json(messages);
});

/* ═══════════════════════════════════════════════════════════
   REST API — ЗАГРУЗКА ФАЙЛОВ
═══════════════════════════════════════════════════════════ */

/** POST /api/upload */
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'Файл не загружен' });

    res.json({
      url:      `/uploads/${req.file.filename}`,
      type:     req.file.mimetype,
      name:     req.file.originalname,
      size:     req.file.size
    });
  } catch (err) {
    console.error('[upload]', err);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

/* ═══════════════════════════════════════════════════════════
   REST API — КОНТАКТЫ
═══════════════════════════════════════════════════════════ */

/** GET /api/contacts */
app.get('/api/contacts', authMiddleware, (req, res) => {
  const contacts = stmt.getContacts.all(req.user.id);
  const requests = stmt.getRequests.all(req.user.id);
  res.json({ contacts, requests });
});

/** POST /api/contacts/request */
app.post('/api/contacts/request', authMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username)
    return res.status(400).json({ error: 'Укажите имя пользователя' });

  const target = stmt.getUserByName.get(username);
  if (!target)
    return res.status(404).json({ error: 'Пользователь не найден' });

  if (target.id === req.user.id)
    return res.status(400).json({ error: 'Нельзя добавить себя' });

  const existing = stmt.isContact.get(req.user.id, target.id);
  if (existing)
    return res.status(409).json({ error: 'Запрос уже отправлен или вы уже в контактах' });

  stmt.sendRequest.run(req.user.id, target.id);

  /* Уведомляем получателя если онлайн */
  const targetSocket = userSocket.get(target.id);
  if (targetSocket) {
    io.to(targetSocket).emit('contact:request', {
      id:       req.user.id,
      username: req.user.username
    });
  }

  res.json({ ok: true });
});

/** POST /api/contacts/accept */
app.post('/api/contacts/accept', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId)
    return res.status(400).json({ error: 'Укажите userId' });

  stmt.acceptContact.run(userId, req.user.id);
  /* Взаимная связь */
  stmt.sendRequest.run(req.user.id, userId);
  stmt.acceptContact.run(req.user.id, userId);

  res.json({ ok: true });
});

/** POST /api/contacts/decline */
app.post('/api/contacts/decline', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId)
    return res.status(400).json({ error: 'Укажите userId' });

  stmt.declineContact.run(userId, req.user.id);
  res.json({ ok: true });
});

/** GET /api/users/search?q= */
app.get('/api/users/search', authMiddleware, (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2)
    return res.json([]);

  const users = db.prepare(`
    SELECT id, username, avatar, bio FROM users
    WHERE username LIKE ? COLLATE NOCASE AND id != ?
    LIMIT 20
  `).all(`%${q}%`, req.user.id);

  res.json(users);
});
/* ═══════════════════════════════════════════════════════════
   SOCKET.IO — АУТЕНТИФИКАЦИЯ
═══════════════════════════════════════════════════════════ */
io.use((socket, next) => {
  const token   = socket.handshake.auth?.token;
  const payload = token ? verifyToken(token) : null;

  if (!payload)
    return next(new Error('Не авторизован'));

  socket.userId   = payload.id;
  socket.username = payload.username;
  next();
});

/* ═══════════════════════════════════════════════════════════
   SOCKET.IO — ПОДКЛЮЧЕНИЕ
═══════════════════════════════════════════════════════════ */
io.on('connection', (socket) => {
  console.log(`[socket] + ${socket.username} (${socket.id})`);

  /* Регистрируем сокет */
  socketUser.set(socket.id, socket.userId);
  userSocket.set(socket.userId, socket.id);

  /* ── Отключение ─────────────────────────────────────── */
  socket.on('disconnect', () => {
    console.log(`[socket] - ${socket.username} (${socket.id})`);

    socketUser.delete(socket.id);
    userSocket.delete(socket.userId);

    /* Убираем из всех комнат */
    roomOnline.forEach((users, roomId) => {
      if (users.has(socket.userId)) {
        users.delete(socket.userId);
        io.to(roomId).emit('room:online', {
          roomId,
          count: users.size,
          users: [...users]
        });
      }
    });

    /* Покидаем WebRTC-сессии */
    socket.to([...socket.rooms]).emit('voice:user-left', {
      userId: socket.userId
    });
  });

  /* ═══════════════════════════════════════════════════════
     КОМНАТЫ
  ═══════════════════════════════════════════════════════ */

  /** room:join — войти в комнату */
  socket.on('room:join', async ({ roomId, password }, cb = () => {}) => {
    try {
      const room = stmt.getRoomById.get(roomId);
      if (!room) return cb({ error: 'Комната не найдена' });

      /* Проверка пароля */
      if (room.password) {
        if (!password)
          return cb({ error: 'Требуется пароль' });
        const ok = await bcrypt.compare(password, room.password);
        if (!ok)
          return cb({ error: 'Неверный пароль' });
      }

      /* Добавляем в БД и в Socket.IO room */
      stmt.addMember.run(roomId, socket.userId);
      socket.join(roomId);

      /* Онлайн */
      if (!roomOnline.has(roomId)) roomOnline.set(roomId, new Set());
      roomOnline.get(roomId).add(socket.userId);

      /* История сообщений */
      const messages = stmt.getMessages.all(roomId).map(formatMessage);

      /* Участники */
      const members = stmt.getMembers.all(roomId);

      /* Закреплённое */
      let pinnedMsg = null;
      if (room.pinned_msg) {
        const pm = stmt.getMessageById.get(room.pinned_msg);
        if (pm) pinnedMsg = formatMessage({ ...pm, username: '', avatar: null });
      }

      cb({
        ok: true,
        messages,
        members,
        pinned: pinnedMsg,
        online: getRoomOnline(roomId).size
      });

      /* Обновляем онлайн для всех в комнате */
      io.to(roomId).emit('room:online', {
        roomId,
        count: getRoomOnline(roomId).size,
        users: [...getRoomOnline(roomId)]
      });

      /* Системное сообщение */
      io.to(roomId).emit('room:user-joined', {
        roomId,
        userId:   socket.userId,
        username: socket.username
      });

    } catch (err) {
      console.error('[room:join]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /** room:leave — покинуть комнату */
  socket.on('room:leave', ({ roomId }) => {
    socket.leave(roomId);

    const online = roomOnline.get(roomId);
    if (online) {
      online.delete(socket.userId);
      io.to(roomId).emit('room:online', {
        roomId,
        count: online.size,
        users: [...online]
      });
    }

    io.to(roomId).emit('room:user-left', {
      roomId,
      userId:   socket.userId,
      username: socket.username
    });
  });

  /* ═══════════════════════════════════════════════════════
     СООБЩЕНИЯ
  ═══════════════════════════════════════════════════════ */

  /** message:send */
  socket.on('message:send', ({ roomId, text, fileUrl, fileType, fileName, fileSize, replyTo }, cb = () => {}) => {
    try {
      const room = stmt.getRoomById.get(roomId);
      if (!room) return cb({ error: 'Комната не найдена' });

      if (!text && !fileUrl)
        return cb({ error: 'Пустое сообщение' });

      if (text && text.length > 4000)
        return cb({ error: 'Сообщение слишком длинное' });

      const id = uuidv4();
      stmt.createMessage.run(
        id, roomId, socket.userId,
        text || '',
        fileUrl  || null,
        fileType || null,
        fileName || null,
        fileSize || null,
        replyTo  || null
      );

      const raw = db.prepare(`
        SELECT m.*, u.username, u.avatar
        FROM messages m JOIN users u ON m.user_id = u.id
        WHERE m.id = ?
      `).get(id);

      const msg = formatMessage(raw);

      io.to(roomId).emit('message:new', msg);
      cb({ ok: true, messageId: id });

    } catch (err) {
      console.error('[message:send]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /** message:edit */
  socket.on('message:edit', ({ messageId, text }, cb = () => {}) => {
    try {
      if (!text || text.trim().length === 0)
        return cb({ error: 'Текст не может быть пустым' });

      if (text.length > 4000)
        return cb({ error: 'Слишком длинное' });

      const msg = stmt.getMessageById.get(messageId);
      if (!msg) return cb({ error: 'Сообщение не найдено' });
      if (msg.user_id !== socket.userId)
        return cb({ error: 'Нет прав' });

      stmt.editMessage.run(text.trim(), messageId, socket.userId);

      io.to(msg.room_id).emit('message:edited', {
        messageId,
        text: text.trim(),
        roomId: msg.room_id
      });

      cb({ ok: true });

    } catch (err) {
      console.error('[message:edit]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /** message:delete */
  socket.on('message:delete', ({ messageId }, cb = () => {}) => {
    try {
      const msg = stmt.getMessageById.get(messageId);
      if (!msg) return cb({ error: 'Сообщение не найдено' });

      /* Удалить может автор или владелец комнаты */
      const room = stmt.getRoomById.get(msg.room_id);
      const canDelete = msg.user_id === socket.userId ||
                        (room && room.owner_id === socket.userId);

      if (!canDelete) return cb({ error: 'Нет прав' });

      if (msg.user_id === socket.userId) {
        stmt.deleteMessage.run(messageId, socket.userId);
      } else {
        stmt.deleteMessageMod.run(messageId);
      }

      io.to(msg.room_id).emit('message:deleted', {
        messageId,
        roomId: msg.room_id
      });

      cb({ ok: true });

    } catch (err) {
      console.error('[message:delete]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /** message:pin */
  socket.on('message:pin', ({ messageId, roomId }, cb = () => {}) => {
    try {
      const room = stmt.getRoomById.get(roomId);
      if (!room) return cb({ error: 'Комната не найдена' });
      if (room.owner_id !== socket.userId)
        return cb({ error: 'Только владелец может закреплять' });

      stmt.setPinnedMsg.run(messageId, roomId);

      const raw = db.prepare(`
        SELECT m.*, u.username, u.avatar
        FROM messages m JOIN users u ON m.user_id = u.id
        WHERE m.id = ?
      `).get(messageId);

      if (!raw) return cb({ error: 'Сообщение не найдено' });

      const pinned = formatMessage(raw);
      io.to(roomId).emit('message:pinned', { roomId, message: pinned });
      cb({ ok: true });

    } catch (err) {
      console.error('[message:pin]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /** message:unpin */
  socket.on('message:unpin', ({ roomId }, cb = () => {}) => {
    try {
      const room = stmt.getRoomById.get(roomId);
      if (!room) return cb({ error: 'Комната не найдена' });
      if (room.owner_id !== socket.userId)
        return cb({ error: 'Только владелец может откреплять' });

      stmt.setPinnedMsg.run(null, roomId);
      io.to(roomId).emit('message:unpinned', { roomId });
      cb({ ok: true });

    } catch (err) {
      console.error('[message:unpin]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /* ═══════════════════════════════════════════════════════
     РЕАКЦИИ
  ═══════════════════════════════════════════════════════ */

  /** reaction:toggle */
  socket.on('reaction:toggle', ({ messageId, emoji }, cb = () => {}) => {
    try {
      const msg = stmt.getMessageById.get(messageId);
      if (!msg) return cb({ error: 'Сообщение не найдено' });

      const existing = stmt.getUserReaction.get(messageId, socket.userId);

      if (existing && existing.emoji === emoji) {
        stmt.removeReaction.run(messageId, socket.userId);
      } else {
        stmt.addReaction.run(messageId, socket.userId, emoji);
      }

      const reactions = getReactionsForMsg(messageId);

      io.to(msg.room_id).emit('reaction:updated', {
        messageId,
        roomId:    msg.room_id,
        reactions
      });

      cb({ ok: true });

    } catch (err) {
      console.error('[reaction:toggle]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /* ═══════════════════════════════════════════════════════
     ПЕЧАТАЕТ...
  ═══════════════════════════════════════════════════════ */

  /** typing:start */
  socket.on('typing:start', ({ roomId }) => {
    socket.to(roomId).emit('typing:start', {
      roomId,
      userId:   socket.userId,
      username: socket.username
    });
  });

  /** typing:stop */
  socket.on('typing:stop', ({ roomId }) => {
    socket.to(roomId).emit('typing:stop', {
      roomId,
      userId: socket.userId
    });
  });
    /* ═══════════════════════════════════════════════════════
     WebRTC — ГОЛОС / ВИДЕО
  ═══════════════════════════════════════════════════════ */

  /** voice:join — войти в голосовой канал */
  socket.on('voice:join', ({ roomId }, cb = () => {}) => {
    try {
      socket.join(`voice:${roomId}`);

      /* Список уже присутствующих */
      const room  = io.sockets.adapter.rooms.get(`voice:${roomId}`);
      const peers = room
        ? [...room].filter(sid => sid !== socket.id).map(sid => ({
            socketId: sid,
            userId:   socketUser.get(sid)
          }))
        : [];

      /* Сообщаем новому участнику кто уже есть */
      cb({ ok: true, peers });

      /* Остальным — о новом участнике */
      socket.to(`voice:${roomId}`).emit('voice:user-joined', {
        socketId: socket.id,
        userId:   socket.userId,
        username: socket.username
      });

    } catch (err) {
      console.error('[voice:join]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /** voice:leave — покинуть голосовой канал */
  socket.on('voice:leave', ({ roomId }) => {
    socket.leave(`voice:${roomId}`);
    socket.to(`voice:${roomId}`).emit('voice:user-left', {
      socketId: socket.id,
      userId:   socket.userId
    });
  });

  /** voice:offer — SDP offer (WebRTC handshake) */
  socket.on('voice:offer', ({ targetSocketId, offer, roomId }) => {
    io.to(targetSocketId).emit('voice:offer', {
      offer,
      roomId,
      fromSocketId: socket.id,
      fromUserId:   socket.userId,
      fromUsername: socket.username
    });
  });

  /** voice:answer — SDP answer */
  socket.on('voice:answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('voice:answer', {
      answer,
      fromSocketId: socket.id
    });
  });

  /** voice:ice-candidate — ICE кандидат */
  socket.on('voice:ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('voice:ice-candidate', {
      candidate,
      fromSocketId: socket.id
    });
  });

  /** voice:toggle-mic — вкл/выкл микрофон */
  socket.on('voice:toggle-mic', ({ roomId, enabled }) => {
    socket.to(`voice:${roomId}`).emit('voice:toggle-mic', {
      socketId: socket.id,
      userId:   socket.userId,
      enabled
    });
  });

  /** voice:toggle-cam — вкл/выкл камера */
  socket.on('voice:toggle-cam', ({ roomId, enabled }) => {
    socket.to(`voice:${roomId}`).emit('voice:toggle-cam', {
      socketId: socket.id,
      userId:   socket.userId,
      enabled
    });
  });

  /** voice:toggle-screen — вкл/выкл демонстрация экрана */
  socket.on('voice:toggle-screen', ({ roomId, enabled }) => {
    socket.to(`voice:${roomId}`).emit('voice:toggle-screen', {
      socketId: socket.id,
      userId:   socket.userId,
      enabled
    });
  });

  /* ═══════════════════════════════════════════════════════
     ПРЯМЫЕ СООБЩЕНИЯ (DM)
  ═══════════════════════════════════════════════════════ */

  /** dm:send — личное сообщение */
  socket.on('dm:send', ({ targetUserId, text }, cb = () => {}) => {
    try {
      if (!text || text.trim().length === 0)
        return cb({ error: 'Пустое сообщение' });

      if (text.length > 4000)
        return cb({ error: 'Слишком длинное' });

      /* Проверяем что в контактах */
      const rel = stmt.isContact.get(socket.userId, targetUserId);
      if (!rel || rel.status !== 'accepted')
        return cb({ error: 'Пользователь не в контактах' });

      const targetSocket = userSocket.get(targetUserId);

      const payload = {
        fromUserId:   socket.userId,
        fromUsername: socket.username,
        text:         text.trim(),
        createdAt:    Math.floor(Date.now() / 1000)
      };

      if (targetSocket) {
        io.to(targetSocket).emit('dm:message', payload);
      }

      cb({ ok: true });

    } catch (err) {
      console.error('[dm:send]', err);
      cb({ error: 'Ошибка сервера' });
    }
  });

  /* ═══════════════════════════════════════════════════════
     ОНЛАЙН-СТАТУС
  ═══════════════════════════════════════════════════════ */

  /** presence:ping — клиент пингует что он онлайн */
  socket.on('presence:ping', () => {
    socket.broadcast.emit('presence:online', { userId: socket.userId });
  });

  /** presence:get — запросить список онлайн-пользователей */
  socket.on('presence:get', (cb = () => {}) => {
    const online = [...userSocket.keys()];
    cb({ online });
  });

}); /* конец io.on('connection') */

/* ═══════════════════════════════════════════════════════════
   FALLBACK — SPA
═══════════════════════════════════════════════════════════ */
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ═══════════════════════════════════════════════════════════
   GRACEFUL SHUTDOWN
═══════════════════════════════════════════════════════════ */
function shutdown(signal) {
  console.log(`\n[server] ${signal} — завершение...`);
  server.close(() => {
    db.close();
    console.log('[server] Остановлен.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

/* ═══════════════════════════════════════════════════════════
   СТАРТ
═══════════════════════════════════════════════════════════ */
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════╗
║   VoiceChat запущен               ║
║   http://localhost:${PORT}           ║
║   NODE_ENV: ${NODE_ENV.padEnd(22)}║
╚═══════════════════════════════════╝
  `);
});
