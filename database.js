// ═══════════════════════════════════════════════
//  DATABASE.JS — PostgreSQL (Railway) или SQLite (локально)
//  Если есть DATABASE_URL — используем PostgreSQL
//  Иначе — SQLite через better-sqlite3
// ═══════════════════════════════════════════════

const path = require('path');
const fs   = require('fs');

// ════════════════════════════════════════════
//  ОПРЕДЕЛЯЕМ РЕЖИМ РАБОТЫ
// ════════════════════════════════════════════
const USE_PG = !!process.env.DATABASE_URL;

let db, pgPool;

if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('Используем PostgreSQL (Railway)');
} else {
  const Database = require('better-sqlite3');
  const dataDir  = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'chat.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  console.log('Используем SQLite (локально)');
}

// ════════════════════════════════════════════
//  ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ + МИГРАЦИИ
// ════════════════════════════════════════════

async function _sqliteAddColumnIfMissing(table, column, ddl) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = rows.some(r => r.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function _runMigrations() {
  if (USE_PG) {
    await pgPool.query(`
      ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS voice_enabled SMALLINT DEFAULT 1,
        ADD COLUMN IF NOT EXISTS wallpaper TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS description_text TEXT DEFAULT '';

      ALTER TABLE private_chats
        ADD COLUMN IF NOT EXISTS wallpaper TEXT DEFAULT NULL;

      ALTER TABLE room_messages
        ADD COLUMN IF NOT EXISTS caption_encrypted TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS caption_iv TEXT DEFAULT NULL;

      ALTER TABLE private_messages
        ADD COLUMN IF NOT EXISTS caption_encrypted TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS caption_iv TEXT DEFAULT NULL;
    `);
  } else {
    await _sqliteAddColumnIfMissing('rooms', 'voice_enabled',   `voice_enabled INTEGER DEFAULT 1`);
    await _sqliteAddColumnIfMissing('rooms', 'wallpaper',       `wallpaper TEXT DEFAULT NULL`);
    await _sqliteAddColumnIfMissing('rooms', 'description_text',`description_text TEXT DEFAULT ''`);

    await _sqliteAddColumnIfMissing('private_chats', 'wallpaper', `wallpaper TEXT DEFAULT NULL`);

    await _sqliteAddColumnIfMissing('room_messages', 'caption_encrypted', `caption_encrypted TEXT DEFAULT NULL`);
    await _sqliteAddColumnIfMissing('room_messages', 'caption_iv',        `caption_iv TEXT DEFAULT NULL`);

    await _sqliteAddColumnIfMissing('private_messages', 'caption_encrypted', `caption_encrypted TEXT DEFAULT NULL`);
    await _sqliteAddColumnIfMissing('private_messages', 'caption_iv',        `caption_iv TEXT DEFAULT NULL`);
  }
}

async function initDB() {
  if (USE_PG) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        nick_lower     TEXT PRIMARY KEY,
        nickname       TEXT NOT NULL,
        username       TEXT NOT NULL,
        password_hash  TEXT,
        hint           TEXT DEFAULT '',
        phone          TEXT DEFAULT '',
        avatar         TEXT DEFAULT NULL,
        bio            TEXT DEFAULT '',
        privacy        TEXT DEFAULT '{}',
        created_at     BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friends (
        user_lower   TEXT NOT NULL,
        friend_lower TEXT NOT NULL,
        PRIMARY KEY (user_lower, friend_lower)
      );

      CREATE TABLE IF NOT EXISTS friend_requests (
        to_lower   TEXT NOT NULL,
        from_lower TEXT NOT NULL,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        PRIMARY KEY (to_lower, from_lower)
      );

      CREATE TABLE IF NOT EXISTS blocked (
        user_lower    TEXT NOT NULL,
        blocked_lower TEXT NOT NULL,
        PRIMARY KEY (user_lower, blocked_lower)
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token      TEXT PRIMARY KEY,
        nick_lower TEXT NOT NULL,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      );

      CREATE TABLE IF NOT EXISTS rooms (
        room_id        TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        password_hash  TEXT DEFAULT NULL,
        photo          TEXT DEFAULT NULL,
        owner_nick     TEXT NOT NULL,
        join_mode      TEXT DEFAULT 'open',
        auto_delete    BIGINT DEFAULT NULL,
        salt           TEXT NOT NULL,
        created_at     BIGINT NOT NULL,
        voice_enabled  SMALLINT DEFAULT 1,
        wallpaper      TEXT DEFAULT NULL,
        description_text TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS room_members (
        room_id    TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        joined_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        PRIMARY KEY (room_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS room_roles (
        room_id      TEXT NOT NULL,
        nick_lower   TEXT NOT NULL,
        role         TEXT NOT NULL, -- owner|admin|moderator
        assigned_by  TEXT DEFAULT NULL,
        assigned_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        PRIMARY KEY (room_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS room_messages (
        msg_id     TEXT PRIMARY KEY,
        room_id    TEXT NOT NULL,
        from_id    TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        nickname   TEXT NOT NULL,
        encrypted  TEXT,
        iv         TEXT,
        caption_encrypted TEXT DEFAULT NULL,
        caption_iv TEXT DEFAULT NULL,
        type       TEXT DEFAULT 'text',
        file_name  TEXT DEFAULT NULL,
        file_size  BIGINT DEFAULT NULL,
        mime_type  TEXT DEFAULT NULL,
        duration   INTEGER DEFAULT 0,
        seq        INTEGER NOT NULL,
        edited     INTEGER DEFAULT 0,
        deleted    INTEGER DEFAULT 0,
        timestamp  BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_msg_deleted_for (
        msg_id     TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        PRIMARY KEY (msg_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS room_pinned_media (
        room_id      TEXT NOT NULL,
        msg_id       TEXT NOT NULL,
        pinned_by    TEXT NOT NULL,
        created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        kind         TEXT DEFAULT 'media',
        PRIMARY KEY (room_id, msg_id)
      );

      CREATE TABLE IF NOT EXISTS private_chats (
        chat_id    TEXT PRIMARY KEY,
        member1    TEXT NOT NULL,
        member2    TEXT NOT NULL,
        wallpaper  TEXT DEFAULT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS private_messages (
        msg_id      TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        from_lower  TEXT NOT NULL,
        from_nick   TEXT NOT NULL,
        from_avatar TEXT DEFAULT NULL,
        encrypted   TEXT,
        iv          TEXT,
        caption_encrypted TEXT DEFAULT NULL,
        caption_iv TEXT DEFAULT NULL,
        type        TEXT DEFAULT 'text',
        file_name   TEXT DEFAULT NULL,
        file_size   BIGINT DEFAULT NULL,
        mime_type   TEXT DEFAULT NULL,
        duration    INTEGER DEFAULT 0,
        seq         INTEGER,
        status      TEXT DEFAULT 'sent',
        edited      INTEGER DEFAULT 0,
        timestamp   BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS private_msg_read_by (
        msg_id     TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        PRIMARY KEY (msg_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS private_msg_deleted_for (
        msg_id     TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        PRIMARY KEY (msg_id, nick_lower)
      );

      CREATE INDEX IF NOT EXISTS idx_room_messages_room     ON room_messages(room_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_private_messages_chat  ON private_messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_nick       ON auth_tokens(nick_lower);
      CREATE INDEX IF NOT EXISTS idx_room_members_nick      ON room_members(nick_lower);
      CREATE INDEX IF NOT EXISTS idx_private_chats_m1       ON private_chats(member1);
      CREATE INDEX IF NOT EXISTS idx_private_chats_m2       ON private_chats(member2);
      CREATE INDEX IF NOT EXISTS idx_room_roles_room        ON room_roles(room_id);
      CREATE INDEX IF NOT EXISTS idx_room_roles_nick        ON room_roles(nick_lower);
      CREATE INDEX IF NOT EXISTS idx_room_pinned_room       ON room_pinned_media(room_id, created_at DESC);
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        nick_lower     TEXT PRIMARY KEY,
        nickname       TEXT NOT NULL,
        username       TEXT NOT NULL,
        password_hash  TEXT,
        hint           TEXT DEFAULT '',
        phone          TEXT DEFAULT '',
        avatar         TEXT DEFAULT NULL,
        bio            TEXT DEFAULT '',
        privacy        TEXT DEFAULT '{}',
        created_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friends (
        user_lower   TEXT NOT NULL,
        friend_lower TEXT NOT NULL,
        PRIMARY KEY (user_lower, friend_lower)
      );

      CREATE TABLE IF NOT EXISTS friend_requests (
        to_lower   TEXT NOT NULL,
        from_lower TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        PRIMARY KEY (to_lower, from_lower)
      );

      CREATE TABLE IF NOT EXISTS blocked (
        user_lower    TEXT NOT NULL,
        blocked_lower TEXT NOT NULL,
        PRIMARY KEY (user_lower, blocked_lower)
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token      TEXT PRIMARY KEY,
        nick_lower TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS rooms (
        room_id        TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        password_hash  TEXT DEFAULT NULL,
        photo          TEXT DEFAULT NULL,
        owner_nick     TEXT NOT NULL,
        join_mode      TEXT DEFAULT 'open',
        auto_delete    INTEGER DEFAULT NULL,
        salt           TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        voice_enabled  INTEGER DEFAULT 1,
        wallpaper      TEXT DEFAULT NULL,
        description_text TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS room_members (
        room_id    TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        joined_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        PRIMARY KEY (room_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS room_roles (
        room_id      TEXT NOT NULL,
        nick_lower   TEXT NOT NULL,
        role         TEXT NOT NULL,
        assigned_by  TEXT DEFAULT NULL,
        assigned_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        PRIMARY KEY (room_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS room_messages (
        msg_id     TEXT PRIMARY KEY,
        room_id    TEXT NOT NULL,
        from_id    TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        nickname   TEXT NOT NULL,
        encrypted  TEXT,
        iv         TEXT,
        caption_encrypted TEXT DEFAULT NULL,
        caption_iv TEXT DEFAULT NULL,
        type       TEXT DEFAULT 'text',
        file_name  TEXT DEFAULT NULL,
        file_size  INTEGER DEFAULT NULL,
        mime_type  TEXT DEFAULT NULL,
        duration   INTEGER DEFAULT 0,
        seq        INTEGER NOT NULL,
        edited     INTEGER DEFAULT 0,
        deleted    INTEGER DEFAULT 0,
        timestamp  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_msg_deleted_for (
        msg_id     TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        PRIMARY KEY (msg_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS room_pinned_media (
        room_id      TEXT NOT NULL,
        msg_id       TEXT NOT NULL,
        pinned_by    TEXT NOT NULL,
        created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        kind         TEXT DEFAULT 'media',
        PRIMARY KEY (room_id, msg_id)
      );

      CREATE TABLE IF NOT EXISTS private_chats (
        chat_id    TEXT PRIMARY KEY,
        member1    TEXT NOT NULL,
        member2    TEXT NOT NULL,
        wallpaper  TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS private_messages (
        msg_id      TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        from_lower  TEXT NOT NULL,
        from_nick   TEXT NOT NULL,
        from_avatar TEXT DEFAULT NULL,
        encrypted   TEXT,
        iv          TEXT,
        caption_encrypted TEXT DEFAULT NULL,
        caption_iv TEXT DEFAULT NULL,
        type        TEXT DEFAULT 'text',
        file_name   TEXT DEFAULT NULL,
        file_size   INTEGER DEFAULT NULL,
        mime_type   TEXT DEFAULT NULL,
        duration    INTEGER DEFAULT 0,
        seq         INTEGER,
        status      TEXT DEFAULT 'sent',
        edited      INTEGER DEFAULT 0,
        timestamp   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS private_msg_read_by (
        msg_id     TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        PRIMARY KEY (msg_id, nick_lower)
      );

      CREATE TABLE IF NOT EXISTS private_msg_deleted_for (
        msg_id     TEXT NOT NULL,
        nick_lower TEXT NOT NULL,
        PRIMARY KEY (msg_id, nick_lower)
      );

      CREATE INDEX IF NOT EXISTS idx_room_messages_room     ON room_messages(room_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_private_messages_chat  ON private_messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_nick       ON auth_tokens(nick_lower);
      CREATE INDEX IF NOT EXISTS idx_room_members_nick      ON room_members(nick_lower);
      CREATE INDEX IF NOT EXISTS idx_private_chats_m1       ON private_chats(member1);
      CREATE INDEX IF NOT EXISTS idx_private_chats_m2       ON private_chats(member2);
      CREATE INDEX IF NOT EXISTS idx_room_roles_room        ON room_roles(room_id);
      CREATE INDEX IF NOT EXISTS idx_room_roles_nick        ON room_roles(nick_lower);
      CREATE INDEX IF NOT EXISTS idx_room_pinned_room       ON room_pinned_media(room_id, created_at DESC);
    `);
  }

  await _runMigrations();
}

// ════════════════════════════════════════════
//  УНИВЕРСАЛЬНЫЙ ЗАПРОС
// ════════════════════════════════════════════
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function query(sql, params = []) {
  if (USE_PG) {
    const pgSql = convertPlaceholders(sql);
    const res = await pgPool.query(pgSql, params);
    return res.rows;
  } else {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      return db.prepare(sql).all(...params);
    } else {
      db.prepare(sql).run(...params);
      return [];
    }
  }
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// ════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ УТИЛИТЫ
// ════════════════════════════════════════════
function _safeJson(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}

function _rowToUser(row) {
  if (!row) return null;
  return {
    nickname:     row.nickname,
    username:     row.username,
    passwordHash: row.password_hash,
    hint:         row.hint || '',
    phone:        row.phone || '',
    avatar:       row.avatar || null,
    bio:          row.bio || '',
    privacy:      _safeJson(row.privacy, {}),
    createdAt:    Number(row.created_at)
  };
}

function _rowToRoom(row) {
  if (!row) return null;
  return {
    id:             row.room_id,
    name:           row.name,
    passwordHash:   row.password_hash || null,
    photo:          row.photo || null,
    ownerNick:      row.owner_nick,
    joinMode:       row.join_mode || 'open',
    autoDelete:     row.auto_delete ? Number(row.auto_delete) : null,
    salt:           row.salt,
    createdAt:      Number(row.created_at),
    voiceEnabled:   Number(row.voice_enabled ?? 1) !== 0,
    wallpaper:      row.wallpaper || null,
    descriptionText: row.description_text || ''
  };
}

function _rowToRoomMsg(row) {
  if (!row) return null;
  return {
    id:          row.msg_id,
    roomId:      row.room_id,
    from:        row.from_id,
    nickLower:   row.nick_lower,
    nickname:    row.nickname,
    encrypted:   row.encrypted || null,
    iv:          row.iv || null,
    captionEncrypted: row.caption_encrypted || null,
    captionIv:   row.caption_iv || null,
    type:        row.type || 'text',
    fileName:    row.file_name || null,
    fileSize:    row.file_size ? Number(row.file_size) : null,
    mimeType:    row.mime_type || null,
    duration:    Number(row.duration) || 0,
    seq:         Number(row.seq) || 0,
    edited:      !!(Number(row.edited)),
    timestamp:   Number(row.timestamp),
    deletedFor:  row.deleted_for_list
      ? (Array.isArray(row.deleted_for_list) ? row.deleted_for_list : String(row.deleted_for_list).split(','))
      : []
  };
}

function _rowToPrivateMsg(row) {
  if (!row) return null;
  return {
    id:          row.msg_id,
    chatId:      row.chat_id,
    from:        row.from_lower,
    fromNick:    row.from_nick,
    fromAvatar:  row.from_avatar || null,
    encrypted:   row.encrypted || null,
    iv:          row.iv || null,
    captionEncrypted: row.caption_encrypted || null,
    captionIv:   row.caption_iv || null,
    type:        row.type || 'text',
    fileName:    row.file_name || null,
    fileSize:    row.file_size ? Number(row.file_size) : null,
    mimeType:    row.mime_type || null,
    duration:    Number(row.duration) || 0,
    seq:         Number(row.seq) || 0,
    status:      row.status || 'sent',
    edited:      !!(Number(row.edited)),
    timestamp:   Number(row.timestamp),
    readBy:      row.read_by_list
      ? (Array.isArray(row.read_by_list) ? row.read_by_list : String(row.read_by_list).split(','))
      : [],
    deletedFor:  row.deleted_for_list
      ? (Array.isArray(row.deleted_for_list) ? row.deleted_for_list : String(row.deleted_for_list).split(','))
      : []
  };
}

// ════════════════════════════════════════════
//  ПОЛЬЗОВАТЕЛИ
// ════════════════════════════════════════════
const UserDB = {
  async get(nickLower) {
    const row = await queryOne('SELECT * FROM users WHERE nick_lower = ?', [nickLower]);
    return _rowToUser(row);
  },

  async getByUsername(username) {
    const row = await queryOne('SELECT * FROM users WHERE username = ?', [username]);
    return _rowToUser(row);
  },

  async has(nickLower) {
    const row = await queryOne('SELECT 1 FROM users WHERE nick_lower = ?', [nickLower]);
    return !!row;
  },

  async hasUsername(username) {
    const row = await queryOne('SELECT 1 FROM users WHERE username = ?', [username]);
    return !!row;
  },

  async create(nickLower, data) {
    await query(
      `INSERT INTO users (nick_lower, nickname, username, password_hash, hint, phone, avatar, bio, privacy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (nick_lower) DO NOTHING`,
      [
        nickLower, data.nickname, data.username || nickLower,
        data.passwordHash || null, data.hint || '', data.phone || '',
        data.avatar || null, data.bio || '',
        JSON.stringify(data.privacy || {}), data.createdAt || Date.now()
      ]
    );
  },

  async update(nickLower, fields) {
    const allowed = ['nickname', 'username', 'password_hash', 'hint', 'phone', 'avatar', 'bio', 'privacy'];
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      if (!allowed.includes(col)) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'privacy' ? JSON.stringify(v) : v);
    }
    if (!sets.length) return;
    vals.push(nickLower);
    await query(`UPDATE users SET ${sets.join(', ')} WHERE nick_lower = ?`, vals);
  },

  async getFriends(nickLower) {
    const rows = await query(
      `SELECT u.nick_lower, u.nickname, u.avatar
       FROM friends f
       JOIN users u ON u.nick_lower = f.friend_lower
       WHERE f.user_lower = ?`, [nickLower]
    );
    return rows.map(r => ({ lower: r.nick_lower, nickname: r.nickname, avatar: r.avatar || null }));
  },

  async addFriend(a, b) {
    await query(`INSERT INTO friends (user_lower, friend_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [a, b]);
    await query(`INSERT INTO friends (user_lower, friend_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [b, a]);
  },

  async removeFriend(a, b) {
    await query(`DELETE FROM friends WHERE user_lower = ? AND friend_lower = ?`, [a, b]);
    await query(`DELETE FROM friends WHERE user_lower = ? AND friend_lower = ?`, [b, a]);
  },

  async areFriends(a, b) {
    const row = await queryOne(`SELECT 1 FROM friends WHERE user_lower = ? AND friend_lower = ?`, [a, b]);
    return !!row;
  },

  async getFriendRequests(nickLower) {
    const rows = await query(
      `SELECT u.nick_lower, u.nickname, u.avatar
       FROM friend_requests fr
       JOIN users u ON u.nick_lower = fr.from_lower
       WHERE fr.to_lower = ?
       ORDER BY fr.created_at`, [nickLower]
    );
    return rows.map(r => ({ lower: r.nick_lower, nickname: r.nickname, avatar: r.avatar || null }));
  },

  async hasRequest(toLower, fromLower) {
    const row = await queryOne(`SELECT 1 FROM friend_requests WHERE to_lower = ? AND from_lower = ?`, [toLower, fromLower]);
    return !!row;
  },

  async addRequest(toLower, fromLower) {
    await query(`INSERT INTO friend_requests (to_lower, from_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [toLower, fromLower]);
  },

  async removeRequest(toLower, fromLower) {
    await query(`DELETE FROM friend_requests WHERE to_lower = ? AND from_lower = ?`, [toLower, fromLower]);
  },

  async getBlocked(nickLower) {
    const rows = await query(`SELECT blocked_lower FROM blocked WHERE user_lower = ?`, [nickLower]);
    return rows.map(r => r.blocked_lower);
  },

  async block(userLower, blockedLower) {
    await query(`INSERT INTO blocked (user_lower, blocked_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [userLower, blockedLower]);
  },

  async unblock(userLower, blockedLower) {
    await query(`DELETE FROM blocked WHERE user_lower = ? AND blocked_lower = ?`, [userLower, blockedLower]);
  }
};

// ════════════════════════════════════════════
//  ТОКЕНЫ
// ════════════════════════════════════════════
const TokenDB = {
  async get(token) {
    const row = await queryOne(`SELECT nick_lower FROM auth_tokens WHERE token = ?`, [token]);
    return row ? row.nick_lower : null;
  },

  async set(token, nickLower) {
    await query(
      `INSERT INTO auth_tokens (token, nick_lower) VALUES (?, ?)
       ON CONFLICT (token) DO UPDATE SET nick_lower = EXCLUDED.nick_lower`,
      [token, nickLower]
    );
  },

  async delete(token) {
    await query(`DELETE FROM auth_tokens WHERE token = ?`, [token]);
  },

  async cleanup() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await query(`DELETE FROM auth_tokens WHERE created_at < ?`, [cutoff]);
  }
};

// ════════════════════════════════════════════
//  ГРУППЫ (КОМНАТЫ)
// ════════════════════════════════════════════
const RoomDB = {
  async get(roomId) {
    const row = await queryOne(`SELECT * FROM rooms WHERE room_id = ?`, [roomId]);
    return _rowToRoom(row);
  },

  async getAll() {
    const rows = await query(`SELECT * FROM rooms ORDER BY created_at DESC`);
    return rows.map(_rowToRoom);
  },

  async create(roomId, data) {
    await query(
      `INSERT INTO rooms
       (room_id, name, password_hash, photo, owner_nick, join_mode, auto_delete, salt, created_at, voice_enabled, wallpaper, description_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (room_id) DO NOTHING`,
      [
        roomId, data.name, data.passwordHash || null, data.photo || null,
        data.ownerNick, data.joinMode || 'open',
        data.autoDelete || null, data.salt, data.createdAt || Date.now(),
        data.voiceEnabled === false ? 0 : 1,
        data.wallpaper || null,
        data.descriptionText || ''
      ]
    );

    // role owner
    await query(
      `INSERT INTO room_roles (room_id, nick_lower, role, assigned_by, assigned_at)
       VALUES (?, ?, 'owner', ?, ?)
       ON CONFLICT (room_id, nick_lower) DO UPDATE SET role = 'owner'`,
      [roomId, data.ownerNick, data.ownerNick, Date.now()]
    );
  },

  async update(roomId, fields) {
    const map = {
      name: 'name',
      passwordHash: 'password_hash',
      photo: 'photo',
      joinMode: 'join_mode',
      autoDelete: 'auto_delete',
      voiceEnabled: 'voice_enabled',
      wallpaper: 'wallpaper',
      descriptionText: 'description_text'
    };
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      if (k === 'voiceEnabled') vals.push(v ? 1 : 0);
      else vals.push(v);
    }
    if (!sets.length) return;
    vals.push(roomId);
    await query(`UPDATE rooms SET ${sets.join(', ')} WHERE room_id = ?`, vals);
  },

  async delete(roomId) {
    await query(`DELETE FROM room_members WHERE room_id = ?`, [roomId]);
    await query(`DELETE FROM room_roles WHERE room_id = ?`, [roomId]);
    await query(`DELETE FROM room_pinned_media WHERE room_id = ?`, [roomId]);
    await query(`DELETE FROM room_msg_deleted_for WHERE msg_id IN (SELECT msg_id FROM room_messages WHERE room_id = ?)`, [roomId]);
    await query(`DELETE FROM room_messages WHERE room_id = ?`, [roomId]);
    await query(`DELETE FROM rooms WHERE room_id = ?`, [roomId]);
  },

  async getMembers(roomId) {
    const rows = await query(`SELECT nick_lower FROM room_members WHERE room_id = ?`, [roomId]);
    return rows.map(r => r.nick_lower);
  },

  async addMember(roomId, nickLower) {
    await query(`INSERT INTO room_members (room_id, nick_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [roomId, nickLower]);
  },

  async removeMember(roomId, nickLower) {
    await query(`DELETE FROM room_members WHERE room_id = ? AND nick_lower = ?`, [roomId, nickLower]);
    // роль тоже снимаем
    await query(`DELETE FROM room_roles WHERE room_id = ? AND nick_lower = ? AND role <> 'owner'`, [roomId, nickLower]);
  },

  async isMember(roomId, nickLower) {
    const row = await queryOne(`SELECT 1 FROM room_members WHERE room_id = ? AND nick_lower = ?`, [roomId, nickLower]);
    return !!row;
  },

  async getUserRooms(nickLower) {
    const rows = await query(`SELECT room_id FROM room_members WHERE nick_lower = ?`, [nickLower]);
    return rows.map(r => r.room_id);
  },

  // FIX: теперь берём ИСТОРИЮ ИЗ room_messages
  async getMessages(roomId, limit = 50, beforeTs = null) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const hasBefore = beforeTs !== null && beforeTs !== undefined && Number.isFinite(Number(beforeTs));
    const beforeNum = hasBefore ? Number(beforeTs) : null;

    let rows;
    if (USE_PG) {
      rows = await query(
        `SELECT
           m.*,
           (
             SELECT STRING_AGG(d.nick_lower, ',')
             FROM room_msg_deleted_for d
             WHERE d.msg_id = m.msg_id
           ) AS deleted_for_list
         FROM room_messages m
         WHERE m.room_id = ?
           ${hasBefore ? 'AND m.timestamp < ?' : ''}
         ORDER BY m.timestamp DESC
         LIMIT ?`,
        hasBefore ? [roomId, beforeNum, lim] : [roomId, lim]
      );
    } else {
      rows = await query(
        `SELECT
           m.*,
           (
             SELECT GROUP_CONCAT(d.nick_lower)
             FROM room_msg_deleted_for d
             WHERE d.msg_id = m.msg_id
           ) AS deleted_for_list
         FROM room_messages m
         WHERE m.room_id = ?
           ${hasBefore ? 'AND m.timestamp < ?' : ''}
         ORDER BY m.timestamp DESC
         LIMIT ?`,
        hasBefore ? [roomId, beforeNum, lim] : [roomId, lim]
      );
    }

    return rows.reverse().map(_rowToRoomMsg);
  },

  async saveMessage(msg) {
    await query(
      `INSERT INTO room_messages
       (msg_id, room_id, from_id, nick_lower, nickname, encrypted, iv, caption_encrypted, caption_iv, type,
        file_name, file_size, mime_type, duration, seq, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (msg_id) DO UPDATE SET
         encrypted = EXCLUDED.encrypted,
         iv = EXCLUDED.iv,
         caption_encrypted = EXCLUDED.caption_encrypted,
         caption_iv = EXCLUDED.caption_iv`,
      [
        msg.id, msg.roomId, msg.from, msg.nickLower || '', msg.nickname || '',
        msg.encrypted || null, msg.iv || null,
        msg.captionEncrypted || null, msg.captionIv || null,
        msg.type || 'text',
        msg.fileName || null, msg.fileSize || null, msg.mimeType || null,
        msg.duration || 0, msg.seq || 0, msg.timestamp || Date.now()
      ]
    );
  },

  async deleteMessage(msgId) {
    await query(`UPDATE room_messages SET deleted = 1 WHERE msg_id = ?`, [msgId]);
  },

  async editMessage(msgId, encrypted, iv) {
    await query(`UPDATE room_messages SET encrypted = ?, iv = ?, edited = 1 WHERE msg_id = ?`, [encrypted, iv, msgId]);
  },

  async addDeletedFor(msgId, nickLower) {
    await query(`INSERT INTO room_msg_deleted_for (msg_id, nick_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [msgId, nickLower]);
  },

  async getMessage(msgId) {
    const row = await queryOne(`SELECT * FROM room_messages WHERE msg_id = ?`, [msgId]);
    return row ? _rowToRoomMsg(row) : null;
  },

  // ── Роли ──
  async getRole(roomId, nickLower) {
    const row = await queryOne(`SELECT role FROM room_roles WHERE room_id = ? AND nick_lower = ?`, [roomId, nickLower]);
    return row ? row.role : null;
  },

  async getRoles(roomId) {
    const rows = await query(
      `SELECT nick_lower, role, assigned_by, assigned_at
       FROM room_roles
       WHERE room_id = ?
       ORDER BY
         CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'moderator' THEN 3 ELSE 4 END,
         assigned_at ASC`,
      [roomId]
    );
    return rows.map(r => ({
      nickLower: r.nick_lower,
      role: r.role,
      assignedBy: r.assigned_by || null,
      assignedAt: Number(r.assigned_at || 0)
    }));
  },

  async setRole(roomId, nickLower, role, assignedBy = null) {
    await query(
      `INSERT INTO room_roles (room_id, nick_lower, role, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (room_id, nick_lower) DO UPDATE SET
         role = EXCLUDED.role,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = EXCLUDED.assigned_at`,
      [roomId, nickLower, role, assignedBy, Date.now()]
    );
  },

  async removeRole(roomId, nickLower) {
    await query(`DELETE FROM room_roles WHERE room_id = ? AND nick_lower = ? AND role <> 'owner'`, [roomId, nickLower]);
  },

  // ── pinned media для "описания" ──
  async pinMedia(roomId, msgId, pinnedBy, kind = 'media') {
    await query(
      `INSERT INTO room_pinned_media (room_id, msg_id, pinned_by, created_at, kind)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (room_id, msg_id) DO UPDATE SET
         pinned_by = EXCLUDED.pinned_by,
         created_at = EXCLUDED.created_at,
         kind = EXCLUDED.kind`,
      [roomId, msgId, pinnedBy, Date.now(), kind]
    );
  },

  async unpinMedia(roomId, msgId) {
    await query(`DELETE FROM room_pinned_media WHERE room_id = ? AND msg_id = ?`, [roomId, msgId]);
  },

  async getPinnedMedia(roomId, limit = 200) {
    const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    const rows = await query(
      `SELECT p.room_id, p.msg_id, p.pinned_by, p.created_at, p.kind,
              m.type, m.file_name, m.file_size, m.mime_type, m.timestamp, m.nick_lower, m.nickname
       FROM room_pinned_media p
       LEFT JOIN room_messages m ON m.msg_id = p.msg_id
       WHERE p.room_id = ?
       ORDER BY p.created_at DESC
       LIMIT ?`,
      [roomId, lim]
    );
    return rows.map(r => ({
      roomId: r.room_id,
      msgId: r.msg_id,
      pinnedBy: r.pinned_by,
      createdAt: Number(r.created_at || 0),
      kind: r.kind || 'media',
      msg: r.type ? {
        type: r.type,
        fileName: r.file_name || null,
        fileSize: r.file_size ? Number(r.file_size) : null,
        mimeType: r.mime_type || null,
        timestamp: r.timestamp ? Number(r.timestamp) : null,
        nickLower: r.nick_lower || null,
        nickname: r.nickname || null
      } : null
    }));
  }
};

// ════════════════════════════════════════════
//  ЛИЧНЫЕ ЧАТЫ
// ════════════════════════════════════════════
const PrivateChatDB = {
  async get(chatId) {
    return await queryOne(`SELECT * FROM private_chats WHERE chat_id = ?`, [chatId]);
  },

  async create(chatId, member1, member2) {
    await query(
      `INSERT INTO private_chats (chat_id, member1, member2, wallpaper, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id) DO NOTHING`,
      [chatId, member1, member2, null, Date.now()]
    );
  },

  async setWallpaper(chatId, wallpaper) {
    await query(`UPDATE private_chats SET wallpaper = ? WHERE chat_id = ?`, [wallpaper || null, chatId]);
  },

  async getWallpaper(chatId) {
    const row = await queryOne(`SELECT wallpaper FROM private_chats WHERE chat_id = ?`, [chatId]);
    return row ? (row.wallpaper || null) : null;
  },

  async getUserChats(nickLower) {
    return await query(
      `SELECT pc.*,
        pm.type as last_type,
        pm.timestamp as last_ts,
        pm.encrypted as last_encrypted
       FROM private_chats pc
       LEFT JOIN private_messages pm ON pm.msg_id = (
         SELECT msg_id FROM private_messages
         WHERE chat_id = pc.chat_id
           AND seq IS NOT NULL
         ORDER BY timestamp DESC LIMIT 1
       )
       WHERE (pc.member1 = ? OR pc.member2 = ?)
       ORDER BY COALESCE(pm.timestamp, pc.created_at) DESC`,
      [nickLower, nickLower]
    );
  },

  async isMember(chatId, nickLower) {
    const chat = await queryOne(`SELECT * FROM private_chats WHERE chat_id = ?`, [chatId]);
    if (!chat) return false;
    return chat.member1 === nickLower || chat.member2 === nickLower;
  },

  async getMessages(chatId, limit = 50, beforeTs = null) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const hasBefore = Number.isFinite(Number(beforeTs));

    let rows;
    if (USE_PG) {
      rows = await query(
        `SELECT
           m.*,
           (
             SELECT STRING_AGG(r.nick_lower, ',')
             FROM private_msg_read_by r
             WHERE r.msg_id = m.msg_id
           ) AS read_by_list,
           (
             SELECT STRING_AGG(d.nick_lower, ',')
             FROM private_msg_deleted_for d
             WHERE d.msg_id = m.msg_id
           ) AS deleted_for_list
         FROM private_messages m
         WHERE m.chat_id = ?
           ${hasBefore ? 'AND m.timestamp < ?' : ''}
         ORDER BY m.timestamp DESC
         LIMIT ?`,
        hasBefore ? [chatId, Number(beforeTs), lim] : [chatId, lim]
      );
    } else {
      rows = await query(
        `SELECT
           m.*,
           (
             SELECT GROUP_CONCAT(r.nick_lower)
             FROM private_msg_read_by r
             WHERE r.msg_id = m.msg_id
           ) AS read_by_list,
           (
             SELECT GROUP_CONCAT(d.nick_lower)
             FROM private_msg_deleted_for d
             WHERE d.msg_id = m.msg_id
           ) AS deleted_for_list
         FROM private_messages m
         WHERE m.chat_id = ?
           ${hasBefore ? 'AND m.timestamp < ?' : ''}
         ORDER BY m.timestamp DESC
         LIMIT ?`,
        hasBefore ? [chatId, Number(beforeTs), lim] : [chatId, lim]
      );
    }

    return rows.reverse().map(_rowToPrivateMsg);
  },

  async saveMessage(msg) {
    await query(
      `INSERT INTO private_messages
       (msg_id, chat_id, from_lower, from_nick, from_avatar, encrypted, iv, caption_encrypted, caption_iv, type,
        file_name, file_size, mime_type, duration, seq, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (msg_id) DO UPDATE SET
         encrypted = EXCLUDED.encrypted,
         iv = EXCLUDED.iv,
         caption_encrypted = EXCLUDED.caption_encrypted,
         caption_iv = EXCLUDED.caption_iv`,
      [
        msg.id, msg.chatId, msg.from, msg.fromNick || '', msg.fromAvatar || null,
        msg.encrypted || null, msg.iv || null,
        msg.captionEncrypted || null, msg.captionIv || null,
        msg.type || 'text',
        msg.fileName || null, msg.fileSize || null, msg.mimeType || null,
        msg.duration || 0, msg.seq || 0, msg.status || 'sent',
        msg.timestamp || Date.now()
      ]
    );
  },

  async getMessage(msgId) {
    const row = await queryOne(`SELECT * FROM private_messages WHERE msg_id = ?`, [msgId]);
    return row ? _rowToPrivateMsg(row) : null;
  },

  async deleteMessage(msgId) {
    await query(`DELETE FROM private_messages WHERE msg_id = ?`, [msgId]);
  },

  async editMessage(msgId, encrypted, iv) {
    await query(`UPDATE private_messages SET encrypted = ?, iv = ?, edited = 1 WHERE msg_id = ?`, [encrypted, iv, msgId]);
  },

  async markRead(msgId, nickLower) {
    await query(`INSERT INTO private_msg_read_by (msg_id, nick_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [msgId, nickLower]);
    await query(`UPDATE private_messages SET status = 'read' WHERE msg_id = ?`, [msgId]);
  },

  async isReadBy(msgId, nickLower) {
    const row = await queryOne(`SELECT 1 FROM private_msg_read_by WHERE msg_id = ? AND nick_lower = ?`, [msgId, nickLower]);
    return !!row;
  },

  async addDeletedFor(msgId, nickLower) {
    await query(`INSERT INTO private_msg_deleted_for (msg_id, nick_lower) VALUES (?, ?) ON CONFLICT DO NOTHING`, [msgId, nickLower]);
  }
};

// Автоочистка старых токенов раз в сутки
setInterval(() => TokenDB.cleanup().catch(() => {}), 24 * 60 * 60 * 1000);

module.exports = { UserDB, TokenDB, RoomDB, PrivateChatDB, initDB, query, queryOne };
