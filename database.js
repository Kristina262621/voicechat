// ═══════════════════════════════════════════════
//  DATABASE.JS — SQLite через better-sqlite3
//  Все данные сохраняются в файл ./data/chat.db
// ═══════════════════════════════════════════════
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// Создаём папку data если её нет
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'chat.db'));

// Включаем WAL режим — быстрее и надёжнее
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ════════════════════════════════════════════
//  СОЗДАНИЕ ТАБЛИЦ
// ════════════════════════════════════════════
db.exec(`
  -- Пользователи
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

  -- Друзья
  CREATE TABLE IF NOT EXISTS friends (
    user_lower   TEXT NOT NULL,
    friend_lower TEXT NOT NULL,
    PRIMARY KEY (user_lower, friend_lower),
    FOREIGN KEY (user_lower)   REFERENCES users(nick_lower) ON DELETE CASCADE,
    FOREIGN KEY (friend_lower) REFERENCES users(nick_lower) ON DELETE CASCADE
  );

  -- Заявки в друзья
  CREATE TABLE IF NOT EXISTS friend_requests (
    to_lower   TEXT NOT NULL,
    from_lower TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (to_lower, from_lower),
    FOREIGN KEY (to_lower)   REFERENCES users(nick_lower) ON DELETE CASCADE,
    FOREIGN KEY (from_lower) REFERENCES users(nick_lower) ON DELETE CASCADE
  );

  -- Заблокированные
  CREATE TABLE IF NOT EXISTS blocked (
    user_lower    TEXT NOT NULL,
    blocked_lower TEXT NOT NULL,
    PRIMARY KEY (user_lower, blocked_lower),
    FOREIGN KEY (user_lower) REFERENCES users(nick_lower) ON DELETE CASCADE
  );

  -- Токены авторизации
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token      TEXT PRIMARY KEY,
    nick_lower TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (nick_lower) REFERENCES users(nick_lower) ON DELETE CASCADE
  );

  -- Группы (комнаты)
  CREATE TABLE IF NOT EXISTS rooms (
    room_id        TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    password_hash  TEXT DEFAULT NULL,
    photo          TEXT DEFAULT NULL,
    owner_nick     TEXT NOT NULL,
    join_mode      TEXT DEFAULT 'open',
    auto_delete    INTEGER DEFAULT NULL,
    salt           TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );

  -- Постоянные участники групп
  CREATE TABLE IF NOT EXISTS room_members (
    room_id    TEXT NOT NULL,
    nick_lower TEXT NOT NULL,
    joined_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (room_id, nick_lower),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
  );

  -- Сообщения групп
  CREATE TABLE IF NOT EXISTS room_messages (
    msg_id     TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    from_id    TEXT NOT NULL,
    nick_lower TEXT NOT NULL,
    nickname   TEXT NOT NULL,
    encrypted  TEXT,
    iv         TEXT,
    type       TEXT DEFAULT 'text',
    file_name  TEXT DEFAULT NULL,
    file_size  INTEGER DEFAULT NULL,
    mime_type  TEXT DEFAULT NULL,
    duration   INTEGER DEFAULT 0,
    seq        INTEGER NOT NULL,
    edited     INTEGER DEFAULT 0,
    deleted    INTEGER DEFAULT 0,
    timestamp  INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
  );

  -- Удалённые для себя сообщения в группах
  CREATE TABLE IF NOT EXISTS room_msg_deleted_for (
    msg_id     TEXT NOT NULL,
    nick_lower TEXT NOT NULL,
    PRIMARY KEY (msg_id, nick_lower)
  );

  -- Личные чаты
  CREATE TABLE IF NOT EXISTS private_chats (
    chat_id    TEXT PRIMARY KEY,
    member1    TEXT NOT NULL,
    member2    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Сообщения личных чатов
  CREATE TABLE IF NOT EXISTS private_messages (
    msg_id      TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL,
    from_lower  TEXT NOT NULL,
    from_nick   TEXT NOT NULL,
    from_avatar TEXT DEFAULT NULL,
    encrypted   TEXT,
    iv          TEXT,
    type        TEXT DEFAULT 'text',
    file_name   TEXT DEFAULT NULL,
    file_size   INTEGER DEFAULT NULL,
    mime_type   TEXT DEFAULT NULL,
    duration    INTEGER DEFAULT 0,
    seq         INTEGER,
    status      TEXT DEFAULT 'sent',
    edited      INTEGER DEFAULT 0,
    timestamp   INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES private_chats(chat_id) ON DELETE CASCADE
  );

  -- Прочитанные личные сообщения
  CREATE TABLE IF NOT EXISTS private_msg_read_by (
    msg_id     TEXT NOT NULL,
    nick_lower TEXT NOT NULL,
    PRIMARY KEY (msg_id, nick_lower)
  );

  -- Удалённые для себя личные сообщения
  CREATE TABLE IF NOT EXISTS private_msg_deleted_for (
    msg_id     TEXT NOT NULL,
    nick_lower TEXT NOT NULL,
    PRIMARY KEY (msg_id, nick_lower)
  );

  -- Индексы для быстрого поиска
  CREATE INDEX IF NOT EXISTS idx_room_messages_room    ON room_messages(room_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_private_messages_chat ON private_messages(chat_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_nick      ON auth_tokens(nick_lower);
  CREATE INDEX IF NOT EXISTS idx_room_members_nick     ON room_members(nick_lower);
  CREATE INDEX IF NOT EXISTS idx_private_chats_m1      ON private_chats(member1);
  CREATE INDEX IF NOT EXISTS idx_private_chats_m2      ON private_chats(member2);
`);

// ════════════════════════════════════════════
//  ПОЛЬЗОВАТЕЛИ
// ════════════════════════════════════════════
const UserDB = {
  get(nickLower) {
    const row = db.prepare('SELECT * FROM users WHERE nick_lower = ?').get(nickLower);
    if (!row) return null;
    return _rowToUser(row);
  },

  getByUsername(username) {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) return null;
    return _rowToUser(row);
  },

  has(nickLower) {
    return !!db.prepare('SELECT 1 FROM users WHERE nick_lower = ?').get(nickLower);
  },

  hasUsername(username) {
    return !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  },

  create(nickLower, data) {
    db.prepare(`
      INSERT INTO users (nick_lower, nickname, username, password_hash, hint, phone, avatar, bio, privacy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nickLower,
      data.nickname,
      data.username || nickLower,
      data.passwordHash || null,
      data.hint    || '',
      data.phone   || '',
      data.avatar  || null,
      data.bio     || '',
      JSON.stringify(data.privacy || {}),
      data.createdAt || Date.now()
    );
  },

  update(nickLower, fields) {
    const allowed = ['nickname', 'username', 'password_hash', 'hint', 'phone', 'avatar', 'bio', 'privacy'];
    const sets    = [];
    const vals    = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = _camelToSnake(k);
      if (!allowed.includes(col)) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'privacy' ? JSON.stringify(v) : v);
    }
    if (!sets.length) return;
    vals.push(nickLower);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE nick_lower = ?`).run(...vals);
  },

  // Друзья
  getFriends(nickLower) {
    return db.prepare(`
      SELECT u.nick_lower, u.nickname, u.avatar
      FROM friends f
      JOIN users u ON u.nick_lower = f.friend_lower
      WHERE f.user_lower = ?
    `).all(nickLower).map(r => ({ lower: r.nick_lower, nickname: r.nickname, avatar: r.avatar }));
  },

  addFriend(a, b) {
    const ins = db.prepare('INSERT OR IGNORE INTO friends (user_lower, friend_lower) VALUES (?, ?)');
    db.transaction(() => { ins.run(a, b); ins.run(b, a); })();
  },

  removeFriend(a, b) {
    const del = db.prepare('DELETE FROM friends WHERE user_lower = ? AND friend_lower = ?');
    db.transaction(() => { del.run(a, b); del.run(b, a); })();
  },

  areFriends(a, b) {
    return !!db.prepare('SELECT 1 FROM friends WHERE user_lower = ? AND friend_lower = ?').get(a, b);
  },

  // Заявки
  getFriendRequests(nickLower) {
    return db.prepare(`
      SELECT u.nick_lower, u.nickname, u.avatar
      FROM friend_requests fr
      JOIN users u ON u.nick_lower = fr.from_lower
      WHERE fr.to_lower = ?
      ORDER BY fr.created_at
    `).all(nickLower).map(r => ({ lower: r.nick_lower, nickname: r.nickname, avatar: r.avatar }));
  },

  hasRequest(toLower, fromLower) {
    return !!db.prepare('SELECT 1 FROM friend_requests WHERE to_lower = ? AND from_lower = ?').get(toLower, fromLower);
  },

  addRequest(toLower, fromLower) {
    db.prepare('INSERT OR IGNORE INTO friend_requests (to_lower, from_lower) VALUES (?, ?)').run(toLower, fromLower);
  },

  removeRequest(toLower, fromLower) {
    db.prepare('DELETE FROM friend_requests WHERE to_lower = ? AND from_lower = ?').run(toLower, fromLower);
  },

  // Блокировка
  getBlocked(nickLower) {
    return db.prepare('SELECT blocked_lower FROM blocked WHERE user_lower = ?')
      .all(nickLower).map(r => r.blocked_lower);
  },

  block(userLower, blockedLower) {
    db.prepare('INSERT OR IGNORE INTO blocked (user_lower, blocked_lower) VALUES (?, ?)').run(userLower, blockedLower);
  },

  unblock(userLower, blockedLower) {
    db.prepare('DELETE FROM blocked WHERE user_lower = ? AND blocked_lower = ?').run(userLower, blockedLower);
  }
};

function _rowToUser(row) {
  return {
    nickname:     row.nickname,
    username:     row.username,
    passwordHash: row.password_hash,
    hint:         row.hint        || '',
    phone:        row.phone       || '',
    avatar:       row.avatar      || null,
    bio:          row.bio         || '',
    privacy:      _safeJson(row.privacy, {}),
    createdAt:    row.created_at
  };
}

// ════════════════════════════════════════════
//  ТОКЕНЫ
// ════════════════════════════════════════════
const TokenDB = {
  get(token) {
    const row = db.prepare('SELECT nick_lower FROM auth_tokens WHERE token = ?').get(token);
    return row ? row.nick_lower : null;
  },

  set(token, nickLower) {
    db.prepare('INSERT OR REPLACE INTO auth_tokens (token, nick_lower) VALUES (?, ?)').run(token, nickLower);
  },

  delete(token) {
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
  },

  // Удаляем старые токены (старше 30 дней)
  cleanup() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM auth_tokens WHERE created_at < ?').run(cutoff);
  }
};

// ════════════════════════════════════════════
//  ГРУППЫ (КОМНАТЫ)
// ════════════════════════════════════════════
const RoomDB = {
  get(roomId) {
    const row = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!row) return null;
    return _rowToRoom(row);
  },

  getAll() {
    return db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all().map(_rowToRoom);
  },

  create(roomId, data) {
    db.prepare(`
      INSERT INTO rooms (room_id, name, password_hash, photo, owner_nick, join_mode, auto_delete, salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      roomId, data.name, data.passwordHash || null, data.photo || null,
      data.ownerNick, data.joinMode || 'open',
      data.autoDelete || null, data.salt, data.createdAt || Date.now()
    );
  },

  update(roomId, fields) {
    const map = { name:'name', passwordHash:'password_hash', photo:'photo', joinMode:'join_mode', autoDelete:'auto_delete' };
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (map[k]) { sets.push(`${map[k]} = ?`); vals.push(v); }
    }
    if (!sets.length) return;
    vals.push(roomId);
    db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE room_id = ?`).run(...vals);
  },

  delete(roomId) {
    db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
  },

  // Участники
  getMembers(roomId) {
    return db.prepare('SELECT nick_lower FROM room_members WHERE room_id = ?')
      .all(roomId).map(r => r.nick_lower);
  },

  addMember(roomId, nickLower) {
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, nick_lower) VALUES (?, ?)').run(roomId, nickLower);
  },

  removeMember(roomId, nickLower) {
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND nick_lower = ?').run(roomId, nickLower);
  },

  isMember(roomId, nickLower) {
    return !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND nick_lower = ?').get(roomId, nickLower);
  },

  getUserRooms(nickLower) {
    return db.prepare('SELECT room_id FROM room_members WHERE nick_lower = ?')
      .all(nickLower).map(r => r.room_id);
  },

  // Сообщения
  getMessages(roomId, limit = 200) {
    const rows = db.prepare(`
      SELECT m.*, GROUP_CONCAT(d.nick_lower) as deleted_for_list
      FROM room_messages m
      LEFT JOIN room_msg_deleted_for d ON d.msg_id = m.msg_id
      WHERE m.room_id = ? AND m.deleted = 0
      GROUP BY m.msg_id
      ORDER BY m.timestamp ASC
      LIMIT ?
    `).all(roomId, limit);
    return rows.map(_rowToRoomMsg);
  },

  saveMessage(msg) {
    db.prepare(`
      INSERT OR REPLACE INTO room_messages
      (msg_id, room_id, from_id, nick_lower, nickname, encrypted, iv, type,
       file_name, file_size, mime_type, duration, seq, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id, msg.roomId, msg.from, msg.nickLower || '', msg.nickname || '',
      msg.encrypted || null, msg.iv || null, msg.type || 'text',
      msg.fileName || null, msg.fileSize || null, msg.mimeType || null,
      msg.duration || 0, msg.seq || 0, msg.timestamp || Date.now()
    );
  },

  deleteMessage(msgId) {
    db.prepare('UPDATE room_messages SET deleted = 1 WHERE msg_id = ?').run(msgId);
  },

  editMessage(msgId, encrypted, iv) {
    db.prepare('UPDATE room_messages SET encrypted = ?, iv = ?, edited = 1 WHERE msg_id = ?')
      .run(encrypted, iv, msgId);
  },

  addDeletedFor(msgId, nickLower) {
    db.prepare('INSERT OR IGNORE INTO room_msg_deleted_for (msg_id, nick_lower) VALUES (?, ?)').run(msgId, nickLower);
  },

  getMessage(msgId) {
    const row = db.prepare('SELECT * FROM room_messages WHERE msg_id = ?').get(msgId);
    return row ? _rowToRoomMsg(row) : null;
  }
};

function _rowToRoom(row) {
  return {
    id:           row.room_id,
    name:         row.name,
    passwordHash: row.password_hash || null,
    photo:        row.photo         || null,
    ownerNick:    row.owner_nick,
    joinMode:     row.join_mode     || 'open',
    autoDelete:   row.auto_delete   || null,
    salt:         row.salt,
    createdAt:    row.created_at
  };
}

function _rowToRoomMsg(row) {
  return {
    id:          row.msg_id,
    roomId:      row.room_id,
    from:        row.from_id,
    nickLower:   row.nick_lower,
    nickname:    row.nickname,
    encrypted:   row.encrypted  || null,
    iv:          row.iv         || null,
    type:        row.type       || 'text',
    fileName:    row.file_name  || null,
    fileSize:    row.file_size  || null,
    mimeType:    row.mime_type  || null,
    duration:    row.duration   || 0,
    seq:         row.seq        || 0,
    edited:      !!row.edited,
    timestamp:   row.timestamp,
    deletedFor:  row.deleted_for_list ? row.deleted_for_list.split(',') : []
  };
}

// ════════════════════════════════════════════
//  ЛИЧНЫЕ ЧАТЫ
// ════════════════════════════════════════════
const PrivateChatDB = {
  get(chatId) {
    return db.prepare('SELECT * FROM private_chats WHERE chat_id = ?').get(chatId);
  },

  create(chatId, member1, member2) {
    db.prepare('INSERT OR IGNORE INTO private_chats (chat_id, member1, member2, created_at) VALUES (?, ?, ?, ?)')
      .run(chatId, member1, member2, Date.now());
  },

  getUserChats(nickLower) {
    return db.prepare(`
      SELECT pc.*,
        pm.type as last_type, pm.timestamp as last_ts
      FROM private_chats pc
      LEFT JOIN private_messages pm ON pm.msg_id = (
        SELECT msg_id FROM private_messages
        WHERE chat_id = pc.chat_id
        ORDER BY timestamp DESC LIMIT 1
      )
      WHERE pc.member1 = ? OR pc.member2 = ?
      ORDER BY COALESCE(pm.timestamp, pc.created_at) DESC
    `).all(nickLower, nickLower);
  },

  isMember(chatId, nickLower) {
    const chat = db.prepare('SELECT * FROM private_chats WHERE chat_id = ?').get(chatId);
    if (!chat) return false;
    return chat.member1 === nickLower || chat.member2 === nickLower;
  },

  // Сообщения
  getMessages(chatId, limit = 200) {
    const rows = db.prepare(`
      SELECT
        m.*,
        GROUP_CONCAT(DISTINCT r.nick_lower) as read_by_list,
        GROUP_CONCAT(DISTINCT d.nick_lower) as deleted_for_list
      FROM private_messages m
      LEFT JOIN private_msg_read_by    r ON r.msg_id = m.msg_id
      LEFT JOIN private_msg_deleted_for d ON d.msg_id = m.msg_id
      WHERE m.chat_id = ?
      GROUP BY m.msg_id
      ORDER BY m.timestamp ASC
      LIMIT ?
    `).all(chatId, limit);
    return rows.map(_rowToPrivateMsg);
  },

  saveMessage(msg) {
    db.prepare(`
      INSERT OR REPLACE INTO private_messages
      (msg_id, chat_id, from_lower, from_nick, from_avatar, encrypted, iv, type,
       file_name, file_size, mime_type, duration, seq, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id, msg.chatId, msg.from, msg.fromNick || '', msg.fromAvatar || null,
      msg.encrypted || null, msg.iv || null, msg.type || 'text',
      msg.fileName || null, msg.fileSize || null, msg.mimeType || null,
      msg.duration || 0, msg.seq || 0, msg.status || 'sent',
      msg.timestamp || Date.now()
    );
  },

  getMessage(msgId) {
    const row = db.prepare('SELECT * FROM private_messages WHERE msg_id = ?').get(msgId);
    return row ? _rowToPrivateMsg(row) : null;
  },

  deleteMessage(msgId) {
    db.prepare('DELETE FROM private_messages WHERE msg_id = ?').run(msgId);
  },

  editMessage(msgId, encrypted, iv) {
    db.prepare('UPDATE private_messages SET encrypted = ?, iv = ?, edited = 1 WHERE msg_id = ?')
      .run(encrypted, iv, msgId);
  },

  markRead(msgId, nickLower) {
    db.prepare('INSERT OR IGNORE INTO private_msg_read_by (msg_id, nick_lower) VALUES (?, ?)').run(msgId, nickLower);
    db.prepare("UPDATE private_messages SET status = 'read' WHERE msg_id = ?").run(msgId);
  },

  isReadBy(msgId, nickLower) {
    return !!db.prepare('SELECT 1 FROM private_msg_read_by WHERE msg_id = ? AND nick_lower = ?').get(msgId, nickLower);
  },

  addDeletedFor(msgId, nickLower) {
    db.prepare('INSERT OR IGNORE INTO private_msg_deleted_for (msg_id, nick_lower) VALUES (?, ?)').run(msgId, nickLower);
  }
};

function _rowToPrivateMsg(row) {
  return {
    id:          row.msg_id,
    chatId:      row.chat_id,
    from:        row.from_lower,
    fromNick:    row.from_nick,
    fromAvatar:  row.from_avatar  || null,
    encrypted:   row.encrypted    || null,
    iv:          row.iv           || null,
    type:        row.type         || 'text',
    fileName:    row.file_name    || null,
    fileSize:    row.file_size    || null,
    mimeType:    row.mime_type    || null,
    duration:    row.duration     || 0,
    seq:         row.seq          || 0,
    status:      row.status       || 'sent',
    edited:      !!row.edited,
    timestamp:   row.timestamp,
    readBy:      row.read_by_list     ? row.read_by_list.split(',')     : [],
    deletedFor:  row.deleted_for_list ? row.deleted_for_list.split(',') : []
  };
}

// ════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ УТИЛИТЫ
// ════════════════════════════════════════════
function _safeJson(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}

function _camelToSnake(str) {
  return str.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}

// Автоочистка старых токенов раз в сутки
setInterval(() => TokenDB.cleanup(), 24 * 60 * 60 * 1000);

module.exports = { db, UserDB, TokenDB, RoomDB, PrivateChatDB };
