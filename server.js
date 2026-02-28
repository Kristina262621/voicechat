const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');

// ── PostgreSQL ───────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/postgres',
  ssl:
    process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false
});

const SESSION_TTL_DAYS = 30;
const AVATAR_MAX_BYTES = 512 * 1024;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   VARCHAR(24) UNIQUE NOT NULL,
      pass_hash  TEXT NOT NULL,
      avatar     TEXT,
      bio        TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_rooms (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(64) UNIQUE NOT NULL,
      pass_hash  TEXT,
      owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      avatar     TEXT,
      is_group   BOOLEAN DEFAULT false,
      is_private BOOLEAN DEFAULT false,
      pinned_msg_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER REFERENCES chat_rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role    TEXT DEFAULT 'member',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      room_id    INTEGER REFERENCES chat_rooms(id) ON DELETE CASCADE,
      msg_id     TEXT NOT NULL,
      sender_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      encrypted  TEXT,
      iv         TEXT,
      meta_enc   TEXT,
      meta_iv    TEXT,
      file_name  TEXT,
      file_size  INTEGER,
      mime_type  TEXT,
      deleted    BOOLEAN DEFAULT false,
      edited_at  TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contact_requests (
      id            SERIAL PRIMARY KEY,
      from_user_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      to_user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_user_id, to_user_id)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      contact_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, contact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at DESC);
  `);

  await pool.query(`
    UPDATE sessions 
    SET expires_at = NOW() + INTERVAL '${SESSION_TTL_DAYS} days'
    WHERE expires_at IS NULL
  `);

  console.log('✅ PostgreSQL таблицы успешно инициализированы');
}
initDB().catch(console.error);

// ── Helpers ──────────────────────────────────────────────
const PEPPER = 'salt_priv8';

async function hashPassword(password) {
  return bcrypt.hash(password + PEPPER, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password + PEPPER, hash);
}

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

async function createSession(userId) {
  const token = generateToken();
  await pool.query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
    [token, userId]
  );
  return token;
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

async function getUserByToken(token) {
  if (!token) return null;
  const res = await pool.query(
    `
    SELECT u.id, u.username, u.avatar, u.bio
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = $1 AND s.expires_at > NOW()
  `,
    [token]
  );
  return res.rows[0] || null;
}

// ── CORS helper (WebView + browser + Railway) ───────────
function allowOrigin(origin, cb) {
  if (!origin) return cb(null, true); // Android WebView/file:// часто без origin

  const allowed = [
    'http://localhost',
    'https://localhost',
    'capacitor://localhost',
    'ionic://localhost',
    'https://voicechat-production-3d23.up.railway.app'
  ];

  if (allowed.includes(origin)) return cb(null, true);

  try {
    const u = new URL(origin);
    if (u.hostname.endsWith('.up.railway.app')) return cb(null, true);
  } catch (_) {}

  return cb(new Error('CORS blocked: ' + origin));
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});

app.use(
  cors({
    origin: allowOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: false
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

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
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  return `${ip}:${suffix}`;
}

// ── Auth ─────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  if (!rateLimit(ipKey(req, 'register'), 6, 60_000)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ ok: false, error: 'username_length' });
  if (password.length < 4) return res.status(400).json({ ok: false, error: 'password_short' });

  try {
    const passHash = await hashPassword(password);
    const userRes = await pool.query(
      'INSERT INTO users (username, pass_hash) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), passHash]
    );

    const user = userRes.rows[0];
    const token = await createSession(user.id);
    res.json({ ok: true, token, username: user.username, userId: user.id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'username_taken' });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  if (!rateLimit(ipKey(req, 'login'), 10, 60_000)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = userRes.rows[0];

    if (!user || !(await verifyPassword(password, user.pass_hash))) {
      return setTimeout(() => res.status(403).json({ ok: false, error: 'wrong_credentials' }), 1000);
    }

    const token = await createSession(user.id);
    res.json({ ok: true, token, username: user.username, userId: user.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/verify', async (req, res) => {
  const { token } = req.body;
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });
  res.json({ ok: true, username: user.username, userId: user.id, avatar: user.avatar, bio: user.bio });
});

// ── Profile ──────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, user });
});

app.put('/api/me', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { avatar, bio } = req.body || {};
  const cleanBio = sanitizeBio(bio);

  if (avatar !== undefined && avatar !== null && !isValidDataUrlImage(avatar)) {
    return res.status(400).json({ ok: false, error: 'invalid_avatar' });
  }

  try {
    await pool.query('UPDATE users SET avatar = $1, bio = $2 WHERE id = $3', [avatar ?? user.avatar, cleanBio, user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ── Rooms ────────────────────────────────────────────────
app.get('/api/rooms', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!(await getUserByToken(token))) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const roomsRes = await pool.query(`
      SELECT r.id, r.name, r.avatar, r.is_group, r.is_private, r.owner_id, r.pinned_msg_id,
             u.username as owner,
             CASE WHEN r.pass_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
             r.created_at
      FROM chat_rooms r
      JOIN users u ON u.id = r.owner_id
      ORDER BY r.created_at DESC
    `);

    res.json({ ok: true, rooms: roomsRes.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { name, password, isGroup } = req.body;
    if (!name || name.length < 2 || name.length > 64) {
      return res.status(400).json({ ok: false, error: 'invalid_name' });
    }

    const passHash = password ? await hashPassword(password) : null;
    const roomRes = await pool.query(
      'INSERT INTO chat_rooms (name, pass_hash, owner_id, is_group, is_private) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name.trim(), passHash, user.id, !!isGroup, false]
    );

    await pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [
      roomRes.rows[0].id,
      user.id,
      'owner'
    ]);

    res.json({ ok: true, roomId: roomRes.rows[0].id, name: name.trim() });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'room_exists' });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const roomRes = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ ok: false, error: 'not_found' });

    if (room.pass_hash) {
      const { password } = req.body;
      if (!password || !(await verifyPassword(password, room.pass_hash))) {
        return setTimeout(() => res.status(403).json({ ok: false, error: 'wrong_password' }), 1000);
      }
    }

    await pool.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      room.id,
      user.id
    ]);

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
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.put('/api/rooms/:id/avatar', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const roomRes = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ ok: false, error: 'not_found' });
    if (room.owner_id !== user.id) return res.status(403).json({ ok: false, error: 'forbidden' });

    const { avatar } = req.body || {};
    if (!isValidDataUrlImage(avatar)) return res.status(400).json({ ok: false, error: 'invalid_avatar' });

    await pool.query('UPDATE chat_rooms SET avatar = $1 WHERE id = $2', [avatar, room.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/rooms/:id/messages', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const roomRes = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [req.params.id]);
    const room = roomRes.rows[0];
    if (!room) return res.status(404).json({ ok: false, error: 'not_found' });

    if (room.is_private || room.pass_hash) {
      const member = await pool.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
        room.id,
        user.id
      ]);
      if (!member.rows.length) return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const before = req.query.before ? new Date(req.query.before) : new Date();

    const msgs = await pool.query(
      `
      SELECT m.msg_id, m.type, m.encrypted, m.iv, m.meta_enc, m.meta_iv,
             m.file_name, m.file_size, m.mime_type, m.created_at, m.edited_at, m.deleted,
             u.username, u.avatar, u.id as user_id
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.room_id = $1 AND m.created_at < $2
      ORDER BY m.created_at DESC
      LIMIT $3
    `,
      [room.id, before, limit]
    );

    res.json({ ok: true, messages: msgs.rows.reverse(), pinned: room.pinned_msg_id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ── Contacts ─────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });

  const contacts = await pool.query(
    `
    SELECT u.id, u.username, u.avatar, u.bio
    FROM contacts c
    JOIN users u ON u.id = c.contact_id
    WHERE c.user_id = $1
  `,
    [user.id]
  );

  res.json({ ok: true, contacts: contacts.rows });
});

app.post('/api/contacts/send', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });

  const { userId } = req.body;
  if (!userId || userId === user.id) return res.status(400).json({ ok: false });

  await pool.query(
    `
    INSERT INTO contact_requests (from_user_id, to_user_id)
    VALUES ($1, $2) ON CONFLICT DO NOTHING
  `,
    [user.id, userId]
  );

  res.json({ ok: true });
});

app.get('/api/contacts/requests', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });

  const reqs = await pool.query(
    `
    SELECT u.id, u.username, u.avatar, u.bio
    FROM contact_requests r
    JOIN users u ON u.id = r.from_user_id
    WHERE r.to_user_id = $1
  `,
    [user.id]
  );

  res.json({ ok: true, requests: reqs.rows });
});

app.post('/api/contacts/requests/respond', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });

  const { id, accept } = req.body;
  if (!id) return res.status(400).json({ ok: false });

  if (accept) {
    await pool.query(
      `
      INSERT INTO contacts (user_id, contact_id)
      VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING
    `,
      [user.id, id]
    );
  }

  await pool.query('DELETE FROM contact_requests WHERE from_user_id = $1 AND to_user_id = $2', [id, user.id]);
  res.json({ ok: true });
});

// ── Private chat ─────────────────────────────────────────
app.post('/api/chats/private', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false });

  const { userId } = req.body;
  if (!userId || userId === user.id) return res.status(400).json({ ok: false });

  const existing = await pool.query(
    `
    SELECT r.*
    FROM chat_rooms r
    JOIN room_members m1 ON m1.room_id = r.id AND m1.user_id = $1
    JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id = $2
    WHERE r.is_private = true
    LIMIT 1
  `,
    [user.id, userId]
  );

  if (existing.rows[0]) {
    const room = existing.rows[0];
    return res.json({ ok: true, room });
  }

  const other = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
  if (!other.rows[0]) return res.status(404).json({ ok: false });

  const name = `${user.username} & ${other.rows[0].username}`;

  const roomRes = await pool.query(
    'INSERT INTO chat_rooms (name, owner_id, is_group, is_private) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, user.id, false, true]
  );
  const room = roomRes.rows[0];

  await pool.query(
    'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $3)',
    [room.id, user.id, 'member', userId]
  );

  res.json({ ok: true, room });
});

// ── HTTP server (Railway SSL termination outside) ───────
const server = http.createServer(app);

// ── Socket.IO ────────────────────────────────────────────
const io = new Server(server, {
  path: '/socket.io',
  pingTimeout: 60000,
  pingInterval: 10000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 50 * 1024 * 1024,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  cors: {
    origin: allowOrigin,
    methods: ['GET', 'POST']
  }
});

const socketMeta = new Map();

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomId, token }) => {
    try {
      const user = await getUserByToken(token);
      if (!user) {
        socket.emit('auth-fail');
        return;
      }

      const roomRes = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [roomId]);
      const room = roomRes.rows[0];
      if (!room) {
        socket.emit('auth-fail');
        return;
      }

      if (room.is_private || room.pass_hash) {
        const member = await pool.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
          room.id,
          user.id
        ]);
        if (!member.rows.length) {
          socket.emit('auth-fail');
          return;
        }
      }

      socketMeta.set(socket.id, {
        username: user.username,
        roomId: roomId,
        userId: user.id,
        avatar: user.avatar || null
      });

      socket.join(String(roomId));

      const roomSockets = io.sockets.adapter.rooms.get(String(roomId));
      const existingUsers = Array.from(roomSockets || [])
        .filter((id) => id !== socket.id)
        .map((id) => ({
          socketId: id,
          username: socketMeta.get(id)?.username || 'Участник',
          avatar: socketMeta.get(id)?.avatar || null,
          userId: socketMeta.get(id)?.userId || null
        }));

      const historyRes = await pool.query(
        `
        SELECT m.msg_id, m.type, m.encrypted, m.iv, m.meta_enc, m.meta_iv,
               m.file_name, m.file_size, m.mime_type, m.created_at, m.edited_at, m.deleted,
               u.username, u.avatar, u.id as user_id
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.room_id = $1
        ORDER BY m.created_at DESC
        LIMIT 50
      `,
        [roomId]
      );

      socket.emit('auth-ok', { username: user.username });
      socket.emit('existing-users', existingUsers);
      socket.emit('room-history', { messages: historyRes.rows.reverse(), pinned: room.pinned_msg_id || null });

      socket.to(String(roomId)).emit('user-joined', {
        socketId: socket.id,
        username: user.username,
        avatar: user.avatar || null,
        userId: user.id
      });

      io.to(String(roomId)).emit('user-count', roomSockets ? roomSockets.size : 1);
    } catch (e) {
      console.error('Socket DB Error:', e);
      socket.emit('auth-fail');
    }
  });

  socket.on('join', () => {
    // no-op (клиент шлёт join при старте голоса)
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

  socket.on('chat-message', async (data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const msgId = data.msgId || crypto.randomBytes(12).toString('hex');

    await pool.query(
      `
      INSERT INTO messages (room_id, msg_id, sender_id, type, encrypted, iv, meta_enc, meta_iv, file_name, file_size, mime_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `,
      [
        meta.roomId,
        msgId,
        meta.userId,
        data.type,
        data.encrypted,
        data.iv,
        data.metaEnc || null,
        data.metaIv || null,
        data.fileName || null,
        data.fileSize || null,
        data.mimeType || null
      ]
    );

    socket.to(String(meta.roomId)).emit('chat-message', {
      from: socket.id,
      username: meta.username,
      avatar: meta.avatar,
      userId: meta.userId,
      msgId,
      encrypted: data.encrypted,
      iv: data.iv,
      metaEnc: data.metaEnc || null,
      metaIv: data.metaIv || null,
      type: data.type,
      fileName: data.fileName,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
      timestamp: Date.now()
    });
  });

  socket.on('message-edit', async (data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    await pool.query(
      `
      UPDATE messages SET encrypted=$1, iv=$2, meta_enc=$3, meta_iv=$4, edited_at=NOW()
      WHERE msg_id=$5 AND sender_id=$6
    `,
      [data.encrypted, data.iv, data.metaEnc || null, data.metaIv || null, data.msgId, meta.userId]
    );

    socket.to(String(meta.roomId)).emit('message-edit', {
      msgId: data.msgId,
      encrypted: data.encrypted,
      iv: data.iv,
      metaEnc: data.metaEnc || null,
      metaIv: data.metaIv || null,
      editedAt: Date.now()
    });
  });

  socket.on('message-delete', async ({ msgId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    await pool.query('UPDATE messages SET deleted=true WHERE msg_id=$1 AND sender_id=$2', [msgId, meta.userId]);
    socket.to(String(meta.roomId)).emit('message-delete', { msgId });
  });

  socket.on('reaction-toggle', ({ msgId, emoji }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('reaction-toggle', {
      msgId,
      emoji,
      userId: meta.userId,
      username: meta.username
    });
  });

  socket.on('pin-message', async ({ msgId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const roomRes = await pool.query('SELECT owner_id FROM chat_rooms WHERE id = $1', [meta.roomId]);
    const room = roomRes.rows[0];
    if (!room || room.owner_id !== meta.userId) return;

    await pool.query('UPDATE chat_rooms SET pinned_msg_id = $1 WHERE id = $2', [msgId, meta.roomId]);
    io.to(String(meta.roomId)).emit('room-pinned', { msgId });
  });

  socket.on('unpin-message', async () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const roomRes = await pool.query('SELECT owner_id FROM chat_rooms WHERE id = $1', [meta.roomId]);
    const room = roomRes.rows[0];
    if (!room || room.owner_id !== meta.userId) return;

    await pool.query('UPDATE chat_rooms SET pinned_msg_id = NULL WHERE id = $1', [meta.roomId]);
    io.to(String(meta.roomId)).emit('room-pinned', { msgId: null });
  });

  socket.on('typing', ({ isTyping }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socket.to(String(meta.roomId)).emit('typing', {
      userId: meta.userId,
      username: meta.username,
      isTyping: !!isTyping
    });
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

  socket.on('leave', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(s) {
    const meta = socketMeta.get(s.id);
    if (meta) {
      s.leave(String(meta.roomId));
      s.to(String(meta.roomId)).emit('user-left', { socketId: s.id });

      const roomSockets = io.sockets.adapter.rooms.get(String(meta.roomId));
      const count = roomSockets ? roomSockets.size : 0;
      io.to(String(meta.roomId)).emit('user-count', count);

      socketMeta.delete(s.id);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is running on 0.0.0.0:${PORT}`);
});
