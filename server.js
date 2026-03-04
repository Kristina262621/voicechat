const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const nodeCrypto = require('crypto');
let PgPool = null;
try {
  ({ Pool: PgPool } = require('pg'));
} catch (_) {
  PgPool = null;
}

const { UserDB, TokenDB, RoomDB, PrivateChatDB, initDB, query, queryOne } = require('./database');

const app = express();

// ════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'production';
const ALLOW_GUEST = process.env.ALLOW_GUEST === 'true';

const MAX_JSON_MB = Number(process.env.MAX_JSON_MB || 20);
const MAX_SOCKET_MB = Number(process.env.MAX_SOCKET_MB || 20);

const OTP_TTL_SEC = Number(process.env.OTP_TTL_SEC || 600);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_COOLDOWN_SEC = Number(process.env.OTP_COOLDOWN_SEC || 60);
const OTP_PROVIDER = process.env.OTP_PROVIDER || 'console';

const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL_SEC = Number(process.env.TURN_TTL_SEC || 600);
const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ════════════════════════════════════════════
//  SIGNAL (Postgres store for libsignal public/prekeys)
// ════════════════════════════════════════════
let signalPool = null;
let signalSchemaReady = false;

if (PgPool && process.env.DATABASE_URL) {
  signalPool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL_DISABLE === 'true' ? false : { rejectUnauthorized: false }
  });
}

async function ensureSignalSchema() {
  if (!signalPool || signalSchemaReady) return;

  await signalPool.query(`
    CREATE TABLE IF NOT EXISTS signal_device_keys (
      user_id TEXT NOT NULL,
      device_id INTEGER NOT NULL DEFAULT 1,
      registration_id INTEGER NOT NULL,

      -- identity DH (ECDH)
      identity_key_public BYTEA NOT NULL,

      -- identity SIGN (ECDSA) for signedPreKey verification
      identity_sign_public BYTEA NULL,

      signed_prekey_id INTEGER NOT NULL,
      signed_prekey_public BYTEA NOT NULL,
      signed_prekey_signature BYTEA NOT NULL,

      kyber_prekey_id INTEGER NOT NULL,
      kyber_prekey_public BYTEA NOT NULL,
      kyber_prekey_signature BYTEA NOT NULL,

      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, device_id)
    );

    -- upgrade-safe
    ALTER TABLE signal_device_keys
      ADD COLUMN IF NOT EXISTS identity_sign_public BYTEA;

    CREATE TABLE IF NOT EXISTS signal_one_time_prekeys (
      user_id TEXT NOT NULL,
      device_id INTEGER NOT NULL DEFAULT 1,
      prekey_id INTEGER NOT NULL,
      prekey_public BYTEA NOT NULL,

      is_used BOOLEAN NOT NULL DEFAULT FALSE,
      used_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      PRIMARY KEY (user_id, device_id, prekey_id)
    );

    CREATE INDEX IF NOT EXISTS idx_signal_prekeys_available
      ON signal_one_time_prekeys (user_id, device_id, is_used);
  `);

  signalSchemaReady = true;
}

function b64ToBuf(v) {
  if (!v || typeof v !== 'string') return null;
  return Buffer.from(v, 'base64');
}
function bufToB64(v) {
  if (!v) return null;
  return Buffer.from(v).toString('base64');
}

async function getHttpAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;

  const nickLower = await TokenDB.get(token);
  if (!nickLower) return null;

  const user = await UserDB.get(nickLower);
  if (!user) return null;

  return { nickLower, user };
}

async function requireHttpAuth(req, res, next) {
  try {
    const auth = await getHttpAuth(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
    req.auth = auth;
    next();
  } catch (e) {
    console.error('[requireHttpAuth]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

// ════════════════════════════════════════════
//  ГЛОБАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК
// ════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.stack || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', promise, 'reason:', reason);
});

app.set('trust proxy', 1);

// ════════════════════════════════════════════
//  SECURITY HEADERS
// ════════════════════════════════════════════
app.use((req, res, next) => {
  const wsOrigins = ALLOWED_ORIGINS.map(o => o.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:'));
  const connectSrc = ["'self'", ...wsOrigins].join(' ');

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: `${MAX_JSON_MB}mb` }));

// ════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getClientIp(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address
    || 'unknown';
}

function shortId(id) {
  return id ? id.slice(0, 6) : '??';
}
function generateRoomId() {
  return nodeCrypto.randomBytes(3).toString('hex').toUpperCase();
}
function generateToken() {
  return nodeCrypto.randomBytes(32).toString('hex');
}
function generateChatId(a, b) {
  return [a, b].sort().join('::');
}
function generateMsgId() {
  return nodeCrypto.randomBytes(8).toString('hex');
}

// ════════════════════════════════════════════
//  PASSWORD POLICY + HASH
// ════════════════════════════════════════════
function validatePassword(pw) {
  if (typeof pw !== 'string') return 'invalid';
  if (pw.length < 12) return 'too_short';
  if (!/[a-z]/.test(pw)) return 'need_lower';
  if (!/[A-Z]/.test(pw)) return 'need_upper';
  if (!/[0-9]/.test(pw)) return 'need_digit';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'need_special';
  return null;
}

function legacyHashPassword(pw) {
  const salt = 'voicechat-pw-salt-v2-' + pw.slice(0, 2);
  return nodeCrypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
}

function hashPassword(pw) {
  const salt = nodeCrypto.randomBytes(16).toString('hex');
  const hash = nodeCrypto.pbkdf2Sync(pw, salt, 310000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const hash = parts[2];
    const calc = nodeCrypto.pbkdf2Sync(pw, salt, 310000, 32, 'sha256').toString('hex');
    return nodeCrypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
  }
  return stored === legacyHashPassword(pw);
}

// ════════════════════════════════════════════
//  HINT ENCRYPTION
// ════════════════════════════════════════════
const HINT_SECRET = 'privchat-hint-encryption-key-v2';

function encryptHint(text) {
  if (!text) return '';
  try {
    const key = nodeCrypto.createHash('sha256').update(HINT_SECRET).digest();
    const iv = nodeCrypto.randomBytes(16);
    const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch {
    return '';
  }
}

function decryptHint(encrypted) {
  if (!encrypted) return '';
  try {
    const [ivHex, dataHex] = String(encrypted).split(':');
    if (!ivHex || !dataHex) return '';
    const key = nodeCrypto.createHash('sha256').update(HINT_SECRET).digest();
    const iv = Buffer.from(ivHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ════════════════════════════════════════════
//  RATE LIMITING
// ════════════════════════════════════════════
const bruteForceMap = new Map();
const BRUTE_MAX_ATTEMPTS = 7;
const BRUTE_WINDOW_MS = 60 * 1000;
const BRUTE_BLOCK_MS = 10 * 60 * 1000;

function checkBruteForce(key) {
  const now = Date.now();
  const entry = bruteForceMap.get(key);
  if (entry?.blockedUntil && now < entry.blockedUntil) {
    return { blocked: true, secsLeft: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  return { blocked: false };
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const entry = bruteForceMap.get(key) || { attempts: 0, firstAttempt: now, blockedUntil: null };
  if (now - entry.firstAttempt > BRUTE_WINDOW_MS) {
    entry.attempts = 0;
    entry.firstAttempt = now;
    entry.blockedUntil = null;
  }
  entry.attempts++;
  if (entry.attempts >= BRUTE_MAX_ATTEMPTS) {
    entry.blockedUntil = now + BRUTE_BLOCK_MS;
  }
  bruteForceMap.set(key, entry);
}

function recordSuccessAttempt(key) {
  bruteForceMap.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of bruteForceMap) {
    if (entry.blockedUntil && now > entry.blockedUntil + BRUTE_BLOCK_MS) bruteForceMap.delete(k);
    else if (!entry.blockedUntil && now - entry.firstAttempt > BRUTE_WINDOW_MS * 3) bruteForceMap.delete(k);
  }
}, 10 * 60 * 1000);

// ════════════════════════════════════════════
//  OTP RESET
// ════════════════════════════════════════════
const otpStore = new Map(); // phone -> { codeHash, expiresAt, attempts, cooldownUntil, nickLower }

function otpHash(code) {
  return nodeCrypto.createHash('sha256').update(String(code)).digest('hex');
}

function sendOtp(phone, code) {
  if (OTP_PROVIDER === 'console') {
    console.log(`[OTP DEV] ${phone}: ${code}`);
  }
}

// ════════════════════════════════════════════
//  INVITE PAGE
// ════════════════════════════════════════════
app.get('/invite/:roomId', async (req, res) => {
  try {
    const room = await RoomDB.get(req.params.roomId);
    if (!room) return res.redirect('/?invite=' + encodeURIComponent(req.params.roomId));

    const members = await RoomDB.getMembers(room.id);
    const safeName = esc(room.name);
    const safeRoomId = encodeURIComponent(room.id);
    const safeImage = esc(room.photo || '/icon.png');

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta property="og:title" content="Присоединись к «${safeName}»">
  <meta property="og:description" content="Группа · ${members.length} участников · Приватный чат">
  <meta property="og:image" content="${safeImage}">
  <meta http-equiv="refresh" content="0;url=/?invite=${safeRoomId}">
  <title>Приглашение в «${safeName}»</title>
  <style>body{background:#0a0a0f;color:#e8e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px}</style>
</head>
<body>
  <div style="font-size:48px">🔐</div>
  <div style="font-size:20px;font-weight:700">«${safeName}»</div>
  <div style="color:#9090b0">Переход в приватный чат…</div>
  <script>setTimeout(()=>{location.href='/?invite=${safeRoomId}'},500)</script>
</body>
</html>`);
  } catch {
    res.redirect('/?invite=' + encodeURIComponent(req.params.roomId));
  }
});

// ════════════════════════════════════════════
//  TURN CREDENTIALS
// ════════════════════════════════════════════
app.get('/api/turn-credentials', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const nickLower = await TokenDB.get(token);
    if (!nickLower) return res.status(401).json({ ok: false, error: 'unauthorized' });

    if (!TURN_SECRET || !TURN_URLS.length) {
      return res.json({
        ok: true,
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
    }

    const unix = Math.floor(Date.now() / 1000) + TURN_TTL_SEC;
    const username = `${unix}:${nickLower}`;
    const credential = nodeCrypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

    res.json({
      ok: true,
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: TURN_URLS, username, credential }
      ]
    });
  } catch (e) {
    console.error('[turn-credentials]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ════════════════════════════════════════════
//  SIGNAL HTTP API
// ════════════════════════════════════════════

// upload / replace key bundle
app.post('/api/signal/keys/upload', requireHttpAuth, async (req, res) => {
  try {
    if (!signalPool) return res.status(500).json({ ok: false, error: 'signal_db_unavailable' });
    await ensureSignalSchema();

    const userId = req.auth.nickLower;
    const {
      deviceId = 1,
      registrationId,

      // new
      identitySignPublic,
      identityDhPublic,

      // backward alias
      identityKeyPublic,

      signedPreKey,
      kyberPreKey,
      oneTimePreKeys = []
    } = req.body || {};

    const dhPub = identityDhPublic || identityKeyPublic;

    if (
      !registrationId ||
      !dhPub ||
      !signedPreKey?.id || !signedPreKey?.publicKey || !signedPreKey?.signature ||
      !kyberPreKey?.id || !kyberPreKey?.publicKey || !kyberPreKey?.signature
    ) {
      return res.status(400).json({ ok: false, error: 'bad_request' });
    }

    const client = await signalPool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `
        INSERT INTO signal_device_keys (
          user_id, device_id, registration_id,
          identity_key_public,
          identity_sign_public,
          signed_prekey_id, signed_prekey_public, signed_prekey_signature,
          kyber_prekey_id, kyber_prekey_public, kyber_prekey_signature,
          uploaded_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
        ON CONFLICT (user_id, device_id)
        DO UPDATE SET
          registration_id = EXCLUDED.registration_id,
          identity_key_public = EXCLUDED.identity_key_public,
          identity_sign_public = EXCLUDED.identity_sign_public,
          signed_prekey_id = EXCLUDED.signed_prekey_id,
          signed_prekey_public = EXCLUDED.signed_prekey_public,
          signed_prekey_signature = EXCLUDED.signed_prekey_signature,
          kyber_prekey_id = EXCLUDED.kyber_prekey_id,
          kyber_prekey_public = EXCLUDED.kyber_prekey_public,
          kyber_prekey_signature = EXCLUDED.kyber_prekey_signature,
          uploaded_at = now()
        `,
        [
          userId,
          Number(deviceId),
          Number(registrationId),
          b64ToBuf(dhPub),
          identitySignPublic ? b64ToBuf(identitySignPublic) : null,
          Number(signedPreKey.id),
          b64ToBuf(signedPreKey.publicKey),
          b64ToBuf(signedPreKey.signature),
          Number(kyberPreKey.id),
          b64ToBuf(kyberPreKey.publicKey),
          b64ToBuf(kyberPreKey.signature)
        ]
      );

      for (const pk of oneTimePreKeys) {
        if (!pk || typeof pk.id === 'undefined' || !pk.publicKey) continue;
        await client.query(
          `
          INSERT INTO signal_one_time_prekeys (
            user_id, device_id, prekey_id, prekey_public, is_used, created_at
          ) VALUES ($1,$2,$3,$4,false,now())
          ON CONFLICT (user_id, device_id, prekey_id) DO NOTHING
          `,
          [userId, Number(deviceId), Number(pk.id), b64ToBuf(pk.publicKey)]
        );
      }

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[signal upload]', e);
      res.status(500).json({ ok: false, error: 'server_error' });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[signal upload outer]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// get peer bundle (+ optionally consume prekey)
app.get('/api/signal/keys/bundle/:userId', requireHttpAuth, async (req, res) => {
  try {
    if (!signalPool) return res.status(500).json({ ok: false, error: 'signal_db_unavailable' });
    await ensureSignalSchema();

    const raw = String(req.params.userId || '').trim().toLowerCase();
    const deviceId = Number(req.query.deviceId || 1);
    const consume = String(req.query.consume || '1') !== '0';

    if (!raw) return res.status(400).json({ ok: false, error: 'bad_request' });

    let targetLower = raw;
    let targetUser = await UserDB.get(raw);
    if (!targetUser) {
      const byUsername = await UserDB.getByUsername(raw);
      if (byUsername) {
        targetUser = byUsername;
        const row = await queryOne('SELECT nick_lower FROM users WHERE username = ?', [raw]);
        if (row?.nick_lower) targetLower = row.nick_lower;
      }
    }
    if (!targetUser) return res.status(404).json({ ok: false, error: 'not_found' });

    const client = await signalPool.connect();
    try {
      await client.query('BEGIN');

      const dev = await client.query(
        `
        SELECT
          registration_id,
          identity_key_public,
          identity_sign_public,
          signed_prekey_id,
          signed_prekey_public,
          signed_prekey_signature,
          kyber_prekey_id,
          kyber_prekey_public,
          kyber_prekey_signature
        FROM signal_device_keys
        WHERE user_id = $1 AND device_id = $2
        LIMIT 1
        `,
        [targetLower, deviceId]
      );

      if (!dev.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'bundle_not_found' });
      }

      let one = null;

      if (consume) {
        const pick = await client.query(
          `
          WITH picked AS (
            SELECT user_id, device_id, prekey_id
            FROM signal_one_time_prekeys
            WHERE user_id = $1
              AND device_id = $2
              AND is_used = false
            ORDER BY prekey_id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE signal_one_time_prekeys s
          SET is_used = true, used_at = now()
          FROM picked
          WHERE s.user_id = picked.user_id
            AND s.device_id = picked.device_id
            AND s.prekey_id = picked.prekey_id
          RETURNING s.prekey_id, s.prekey_public
          `,
          [targetLower, deviceId]
        );
        one = pick.rows[0] || null;
      } else {
        const peek = await client.query(
          `
          SELECT prekey_id, prekey_public
          FROM signal_one_time_prekeys
          WHERE user_id = $1
            AND device_id = $2
            AND is_used = false
          ORDER BY prekey_id
          LIMIT 1
          `,
          [targetLower, deviceId]
        );
        one = peek.rows[0] || null;
      }

      await client.query('COMMIT');

      const row = dev.rows[0];

      res.json({
        ok: true,
        bundle: {
          userId: targetLower,
          deviceId,
          registrationId: Number(row.registration_id),

          // new
          identitySignPublic: bufToB64(row.identity_sign_public),
          identityDhPublic: bufToB64(row.identity_key_public),

          // backward compat
          identityKeyPublic: bufToB64(row.identity_key_public),

          signedPreKey: {
            id: Number(row.signed_prekey_id),
            publicKey: bufToB64(row.signed_prekey_public),
            signature: bufToB64(row.signed_prekey_signature)
          },
          kyberPreKey: {
            id: Number(row.kyber_prekey_id),
            publicKey: bufToB64(row.kyber_prekey_public),
            signature: bufToB64(row.kyber_prekey_signature)
          },
          oneTimePreKey: one
            ? { id: Number(one.prekey_id), publicKey: bufToB64(one.prekey_public) }
            : null
        }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[signal bundle]', e);
      res.status(500).json({ ok: false, error: 'server_error' });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[signal bundle outer]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// count available prekeys
app.get('/api/signal/keys/prekeys/count', requireHttpAuth, async (req, res) => {
  try {
    if (!signalPool) return res.status(500).json({ ok: false, error: 'signal_db_unavailable' });
    await ensureSignalSchema();

    const userId = req.auth.nickLower;
    const deviceId = Number(req.query.deviceId || 1);

    const r = await signalPool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM signal_one_time_prekeys
      WHERE user_id = $1 AND device_id = $2 AND is_used = false
      `,
      [userId, deviceId]
    );

    res.json({ ok: true, count: r.rows[0]?.count || 0 });
  } catch (e) {
    console.error('[signal prekeys count]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ════════════════════════════════════════════
//  ГЛОБАЛЬНЫЙ HTTP ERROR HANDLER
// ════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('[HTTP ERROR]', err.stack || err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

// ════════════════════════════════════════════
//  HTTP/HTTPS SERVER
// ════════════════════════════════════════════
let server;
try {
  const sslOptions = {
    key: fs.readFileSync('/etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem')
  };
  server = https.createServer(sslOptions, app);
  console.log('HTTPS server');
} catch {
  server = http.createServer(app);
  console.log('HTTP server (no SSL cert loaded)');
}

const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 10000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: MAX_SOCKET_MB * 1024 * 1024,
  transports: ['websocket'],
  allowUpgrades: false,
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!ALLOWED_ORIGINS.length) {
        if (NODE_ENV === 'production') return cb(new Error('CORS blocked'));
        return cb(null, true);
      }
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('CORS blocked'));
    }
  }
});

// ════════════════════════════════════════════
//  RUNTIME STORE
// ════════════════════════════════════════════
const clients = new Map();
const rooms = new Map();
const onlineUsers = new Map();

const MAX_STORED_MESSAGES = 200;
const MAX_ENCRYPTED_B64_LEN = 35 * 1024 * 1024;

const FILE_LIMITS = {
  image: 10 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  file: 25 * 1024 * 1024,
  voice: 8 * 1024 * 1024
};

function validateMessagePayload(data) {
  const type = String(data?.type || 'text');
  const encrypted = data?.encrypted ? String(data.encrypted) : '';
  if (!encrypted || encrypted.length > MAX_ENCRYPTED_B64_LEN) {
    return { ok: false, error: 'payload_too_large' };
  }

  if (type === 'text') return { ok: true };

  const fileSize = Number(data?.fileSize || 0);
  if (!Number.isFinite(fileSize) || fileSize <= 0) return { ok: false, error: 'bad_size' };

  const limit = FILE_LIMITS[type] || FILE_LIMITS.file;
  if (fileSize > limit) return { ok: false, error: 'file_too_large' };

  const mime = String(data?.mimeType || '').toLowerCase();
  if (type === 'image' && !mime.startsWith('image/')) return { ok: false, error: 'bad_mime' };
  if (type === 'video' && !mime.startsWith('video/')) return { ok: false, error: 'bad_mime' };
  if (type === 'voice' && !mime.startsWith('audio/')) return { ok: false, error: 'bad_mime' };

  return { ok: true };
}

// ════════════════════════════════════════════
//  ONLINE STATUS
// ════════════════════════════════════════════
function setOnline(nickLower, socketId) {
  if (!onlineUsers.has(nickLower)) onlineUsers.set(nickLower, new Set());
  onlineUsers.get(nickLower).add(socketId);
  io.emit('user-online', { nickLower });
}
function setOffline(nickLower, socketId) {
  const set = onlineUsers.get(nickLower);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    onlineUsers.delete(nickLower);
    io.emit('user-offline', { nickLower, lastSeen: Date.now() });
  }
}
function isOnline(nickLower) {
  return onlineUsers.has(nickLower) && onlineUsers.get(nickLower).size > 0;
}

// ════════════════════════════════════════════
//  REACTIONS
// ════════════════════════════════════════════
const messageReactions = new Map();

function getReactions(msgId) {
  const map = messageReactions.get(msgId);
  if (!map) return {};
  const out = {};
  for (const [emoji, users] of map.entries()) {
    if (users.size > 0) out[emoji] = [...users];
  }
  return out;
}
function addReaction(msgId, emoji, nickLower) {
  if (!messageReactions.has(msgId)) messageReactions.set(msgId, new Map());
  const map = messageReactions.get(msgId);
  if (!map.has(emoji)) map.set(emoji, new Set());
  map.get(emoji).add(nickLower);
}
function removeReaction(msgId, emoji, nickLower) {
  const map = messageReactions.get(msgId);
  if (!map) return;
  const users = map.get(emoji);
  if (!users) return;
  users.delete(nickLower);
  if (users.size === 0) map.delete(emoji);
  if (map.size === 0) messageReactions.delete(msgId);
}

// ════════════════════════════════════════════
//  ROOM LIST
// ════════════════════════════════════════════
function getRoomList(nickLower) {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    const isMember = room.permanentMembers?.has(nickLower);
    const isOwner = room.ownerNick === nickLower;
    if (!isMember && !isOwner) continue;

    const entry = {
      id,
      name: room.name,
      hasPassword: !!room.passwordHash,
      photo: room.photo || null,
      memberCount: room.members.size,
      createdAt: room.createdAt,
      ownerId: null,
      autoDelete: room.autoDelete || null,
      joinMode: room.joinMode || 'open'
    };
    if (room.members.size === 0 && room.emptyAt && room.autoDelete) {
      entry.deleteAt = room.emptyAt + room.autoDelete;
    }
    list.push(entry);
  }
  return list;
}

function broadcastRoomList() {
  for (const [sid, c] of clients.entries()) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    if (c.authed && c.nickLower) s.emit('room-list', getRoomList(c.nickLower));
    else s.emit('room-list', []);
  }
}

function scheduleRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.autoDelete) {
    room.emptyAt = Date.now();
    broadcastRoomList();
    return;
  }
  if (room.emptyTimer) return;

  room.emptyAt = Date.now();
  room.emptyTimer = setTimeout(async () => {
    const r = rooms.get(roomId);
    if (r && r.members.size === 0) {
      rooms.delete(roomId);
      await RoomDB.delete(roomId).catch(e => console.error('RoomDB.delete error:', e));
      broadcastRoomList();
    }
  }, room.autoDelete);

  broadcastRoomList();
}

function cancelRoomDelete(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
  room.emptyAt = null;
  broadcastRoomList();
}

// ════════════════════════════════════════════
//  LOAD ROOMS FROM DB
// ════════════════════════════════════════════
async function loadRoomsFromDB() {
  const dbRooms = await RoomDB.getAll();
  for (const room of dbRooms) {
    const members = await RoomDB.getMembers(room.id);
    rooms.set(room.id, {
      ...room,
      members: new Set(),
      permanentMembers: new Set(members),
      pendingRequests: [],
      emptyTimer: null,
      emptyAt: null,
      lastSeq: new Map(),
      messages: []
    });
  }
  console.log(`Loaded ${dbRooms.length} rooms from DB`);
}

// ════════════════════════════════════════════
//  TOKEN CLEANUP
// ════════════════════════════════════════════
setInterval(() => {
  TokenDB.cleanup().catch(e => console.error('Token cleanup error:', e));
}, 24 * 60 * 60 * 1000);

// ════════════════════════════════════════════
//  HEARTBEAT REJOIN PRIVATE ROOMS
// ════════════════════════════════════════════
setInterval(async () => {
  for (const [socketId, client] of clients.entries()) {
    if (!client.authed || !client.nickLower) continue;
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    try {
      const rows = await PrivateChatDB.getUserChats(client.nickLower);
      for (const row of rows) {
        const roomName = 'pc:' + row.chat_id;
        if (!sock.rooms.has(roomName)) sock.join(roomName);
      }
    } catch (e) {
      console.error('[heartbeat] error:', e.message);
    }
  }
}, 30 * 1000);

// ════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  clients.set(socket.id, { nickname: '', nickLower: '', roomId: null, authed: false });
  const clientIp = getClientIp(socket);

  socket.emit('room-list', []);

  const safeOn = (event, handler) => {
    socket.on(event, async (...args) => {
      try {
        await handler(...args);
      } catch (err) {
        console.error(`[SOCKET ERROR] event=${event} socket=${socket.id}`, err.stack || err);
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
          try { cb({ ok: false, error: 'server_error' }); } catch {}
        }
      }
    });
  };

  function requireAuthed(cb) {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.nickLower) {
      if (typeof cb === 'function') cb({ ok: false, error: 'not_authed' });
      return null;
    }
    return c;
  }

  function isRoomOwner(client, room) {
    return !!client && !!room && client.nickLower === room.ownerNick;
  }

  function leaveRoom(sock, roomId) {
    const room = rooms.get(roomId);
    const client = clients.get(sock.id);

    if (room) {
      room.members.delete(sock.id);
      room.lastSeq?.delete(sock.id);
      sock.to(roomId).emit('room-user-left', sock.id);
      sock.to(roomId).emit('voice-user-left', sock.id);
      sock.to(roomId).emit('typing-stop', { from: sock.id });
      sock.leave(roomId);

      if (room.members.size === 0) scheduleRoomDelete(roomId);
      else broadcastRoomList();
    }

    if (client) client.roomId = null;
  }

  // AUTH
  safeOn('auth-register', async ({ nickname, password, hint, phone, username }, cb) => {
    const nick = String(nickname || '').trim().slice(0, 32);
    const lower = nick.toLowerCase();

    if (!nick || nick.length < 2) return cb({ ok: false, error: 'nick_short' });

    const pwErr = validatePassword(String(password || ''));
    if (pwErr) return cb({ ok: false, error: pwErr });

    const uname = String(username || nick)
      .trim()
      .slice(0, 32)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '');

    if (!uname || uname.length < 2) return cb({ ok: false, error: 'username_invalid' });
    if (await UserDB.has(lower)) return cb({ ok: false, error: 'nick_taken' });
    if (await UserDB.hasUsername(uname)) return cb({ ok: false, error: 'username_taken' });

    await UserDB.create(lower, {
      nickname: nick,
      username: uname,
      passwordHash: hashPassword(password),
      hint: encryptHint(String(hint || '').trim().slice(0, 100)),
      phone: String(phone || '').trim().slice(0, 20),
      avatar: null,
      bio: '',
      privacy: {
        phoneVisibility: 'nobody',
        lastSeenVisibility: 'nobody',
        avatarVisibility: 'all',
        forwardVisibility: 'nobody',
        callsVisibility: 'nobody',
        autoDeleteAccount: '12months',
        syncContacts: false,
        suggestContacts: false
      },
      createdAt: Date.now()
    });

    const token = generateToken();
    await TokenDB.set(token, lower);

    const client = clients.get(socket.id);
    client.nickname = nick;
    client.nickLower = lower;
    client.authed = true;

    setOnline(lower, socket.id);
    socket.emit('room-list', getRoomList(lower));

    cb({
      ok: true,
      token,
      nickname: nick,
      username: uname,
      avatar: null
    });
  });

  safeOn('auth-login', async ({ nickname, password }, cb) => {
    const login = String(nickname || '').trim().toLowerCase();
    const key = `${clientIp}:login`;
    const bf = checkBruteForce(key);
    if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });

    let user = await UserDB.get(login);
    let userLower = login;

    if (!user) {
      const byUsername = await UserDB.getByUsername(login);
      if (byUsername) {
        user = byUsername;
        const row = await queryOne('SELECT nick_lower FROM users WHERE username = ?', [login]);
        if (row?.nick_lower) userLower = row.nick_lower;
      }
    }

    if (!user) {
      recordFailedAttempt(key);
      return setTimeout(() => cb({ ok: false, error: 'wrong_creds' }), 700);
    }

    if (!userLower || userLower === login) {
      const row = await queryOne('SELECT nick_lower FROM users WHERE nickname = ? OR nick_lower = ?', [user.nickname, login]);
      if (row?.nick_lower) userLower = row.nick_lower;
    }
    if (!userLower) userLower = login;

    if (!verifyPassword(password, user.passwordHash)) {
      recordFailedAttempt(key);
      return setTimeout(() => cb({ ok: false, error: 'wrong_creds' }), 700);
    }

    if (user.passwordHash && !String(user.passwordHash).startsWith('pbkdf2$')) {
      await UserDB.update(userLower, { passwordHash: hashPassword(password) });
    }

    recordSuccessAttempt(key);

    const token = generateToken();
    await TokenDB.set(token, userLower);

    const client = clients.get(socket.id);
    client.nickname = user.nickname;
    client.nickLower = userLower;
    client.authed = true;

    setOnline(userLower, socket.id);

    const myRooms = await RoomDB.getUserRooms(userLower);
    for (const roomId of myRooms) {
      if (rooms.has(roomId)) socket.join(roomId);
    }

    const privateRows = await PrivateChatDB.getUserChats(userLower);
    for (const row of privateRows) socket.join('pc:' + row.chat_id);

    socket.emit('room-list', getRoomList(userLower));

    cb({
      ok: true,
      token,
      nickname: user.nickname,
      username: user.username || userLower,
      avatar: user.avatar || null,
      onlineUsers: [...onlineUsers.keys()]
    });
  });

  safeOn('auth-token', async ({ token }, cb) => {
    const lower = await TokenDB.get(token);
    if (!lower) return cb({ ok: false, error: 'invalid_token' });

    const user = await UserDB.get(lower);
    if (!user) return cb({ ok: false, error: 'invalid_token' });

    const client = clients.get(socket.id);
    client.nickname = user.nickname;
    client.nickLower = lower;
    client.authed = true;

    setOnline(lower, socket.id);

    const myRooms = await RoomDB.getUserRooms(lower);
    for (const roomId of myRooms) {
      if (rooms.has(roomId)) socket.join(roomId);
    }

    const privateRows = await PrivateChatDB.getUserChats(lower);
    for (const row of privateRows) socket.join('pc:' + row.chat_id);

    socket.emit('room-list', getRoomList(lower));

    cb({
      ok: true,
      nickname: user.nickname,
      username: user.username || lower,
      avatar: user.avatar || null,
      onlineUsers: [...onlineUsers.keys()]
    });
  });

  safeOn('auth-logout', async ({ token }, cb) => {
    if (token) await TokenDB.delete(token);

    const client = clients.get(socket.id);
    if (client?.nickLower) setOffline(client.nickLower, socket.id);

    if (client) {
      client.authed = false;
      client.nickname = '';
      client.nickLower = '';
      client.roomId = null;
    }

    cb && cb({ ok: true });
  });

  safeOn('auth-get-hint', async ({ nickname }, cb) => {
    const lower = String(nickname || '').trim().toLowerCase();
    let user = await UserDB.get(lower);
    if (!user) user = await UserDB.getByUsername(lower);
    if (!user) return cb({ ok: false, error: 'not_found' });

    cb({ ok: true, hint: decryptHint(user.hint) || '' });
  });

  // OTP START
  safeOn('auth-reset-start', async ({ phone }, cb) => {
    const cleanPhone = String(phone || '').trim().slice(0, 20);
    const key = `${clientIp}:reset-start`;
    const bf = checkBruteForce(key);
    if (bf.blocked) return cb({ ok: true });

    if (!cleanPhone) return cb({ ok: true });

    const now = Date.now();
    const existing = otpStore.get(cleanPhone);
    if (existing?.cooldownUntil && now < existing.cooldownUntil) {
      return cb({ ok: true });
    }

    const row = await queryOne('SELECT nick_lower FROM users WHERE phone = ?', [cleanPhone]);

    if (row?.nick_lower) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      otpStore.set(cleanPhone, {
        codeHash: otpHash(code),
        expiresAt: now + OTP_TTL_SEC * 1000,
        attempts: 0,
        cooldownUntil: now + OTP_COOLDOWN_SEC * 1000,
        nickLower: row.nick_lower
      });
      sendOtp(cleanPhone, code);
    }

    recordSuccessAttempt(key);
    cb({ ok: true });
  });

  // OTP CONFIRM
  safeOn('auth-reset-confirm', async ({ phone, code, newPassword }, cb) => {
    const cleanPhone = String(phone || '').trim().slice(0, 20);
    const cleanCode = String(code || '').trim();
    const pwErr = validatePassword(String(newPassword || ''));
    if (pwErr) return cb({ ok: false, error: pwErr });

    const entry = otpStore.get(cleanPhone);
    if (!entry) return cb({ ok: false, error: 'otp_invalid' });
    if (Date.now() > entry.expiresAt) {
      otpStore.delete(cleanPhone);
      return cb({ ok: false, error: 'otp_invalid' });
    }
    if (entry.attempts >= OTP_MAX_ATTEMPTS) {
      otpStore.delete(cleanPhone);
      return cb({ ok: false, error: 'otp_invalid' });
    }

    entry.attempts += 1;
    if (otpHash(cleanCode) !== entry.codeHash) {
      return cb({ ok: false, error: 'otp_invalid' });
    }

    await UserDB.update(entry.nickLower, { passwordHash: hashPassword(newPassword) });
    otpStore.delete(cleanPhone);
    cb({ ok: true });
  });

  safeOn('auth-reset-password', async (_data, cb) => {
    cb({ ok: false, error: 'use_otp_reset' });
  });

  // PROFILE / PRIVACY
  safeOn('profile-get', async (cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const user = await UserDB.get(client.nickLower);
    if (!user) return cb({ ok: false, error: 'not_found' });

    cb({
      ok: true,
      nickname: user.nickname,
      username: user.username || client.nickLower,
      avatar: user.avatar || null,
      bio: user.bio || '',
      phone: user.phone || '',
      hint: decryptHint(user.hint) || '',
      friends: await UserDB.getFriends(client.nickLower),
      friendRequests: await UserDB.getFriendRequests(client.nickLower),
      blocked: await UserDB.getBlocked(client.nickLower),
      privacy: user.privacy || {}
    });
  });

  safeOn('profile-set-avatar', async ({ avatar }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const av = avatar ? String(avatar) : null;
    if (av && av.length > 3 * 1024 * 1024) return cb({ ok: false, error: 'avatar_too_large' });

    await UserDB.update(client.nickLower, { avatar: av });

    if (client.roomId) {
      socket.to(client.roomId).emit('user-avatar-updated', {
        nickLower: client.nickLower,
        nickname: client.nickname,
        avatar: av
      });
    }

    cb({ ok: true });
  });

  safeOn('profile-update', async ({ nickname, bio, phone }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const updates = {};
    if (bio !== undefined) updates.bio = String(bio || '').slice(0, 200);
    if (phone !== undefined) updates.phone = String(phone || '').slice(0, 20);

    if (nickname !== undefined) {
      const nn = String(nickname || '').trim().slice(0, 32);
      if (nn.length >= 2) {
        updates.nickname = nn;
        client.nickname = nn;
      }
    }

    await UserDB.update(client.nickLower, updates);
    const user = await UserDB.get(client.nickLower);
    cb({ ok: true, nickname: user.nickname, bio: user.bio });
  });

  safeOn('privacy-update', async (settings, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const user = await UserDB.get(client.nickLower);
    if (!user) return cb({ ok: false, error: 'not_found' });

    const merged = Object.assign(user.privacy || {}, settings || {});
    await UserDB.update(client.nickLower, { privacy: merged });
    cb({ ok: true, privacy: merged });
  });

  safeOn('privacy-get', async (cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const user = await UserDB.get(client.nickLower);
    if (!user) return cb({ ok: false, error: 'not_found' });

    cb({ ok: true, privacy: user.privacy || {} });
  });

  safeOn('profile-get-user', async ({ nickname }, cb) => {
    const q = String(nickname || '').trim().toLowerCase();
    let user = await UserDB.get(q);
    let lower = q;

    if (!user) {
      const byUsername = await UserDB.getByUsername(q);
      if (byUsername) {
        user = byUsername;
        const row = await queryOne('SELECT nick_lower FROM users WHERE username = ?', [q]);
        if (row?.nick_lower) lower = row.nick_lower;
      }
    }
    if (!user) return cb({ ok: false, error: 'not_found' });

    cb({
      ok: true,
      nickname: user.nickname,
      avatar: user.avatar || null,
      bio: user.bio || '',
      username: user.username || lower,
      online: isOnline(lower),
      privacy: {
        lastSeenVisibility: user.privacy?.lastSeenVisibility || 'nobody',
        avatarVisibility: user.privacy?.avatarVisibility || 'all'
      }
    });
  });

  safeOn('get-online-status', async ({ nicknames }, cb) => {
    const out = {};
    for (const n of (nicknames || [])) out[String(n).toLowerCase()] = isOnline(String(n).toLowerCase());
    cb && cb({ ok: true, statuses: out });
  });

  // BLOCK / FRIENDS
  safeOn('user-block', async ({ nickname }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;
    const to = String(nickname || '').trim().toLowerCase();
    if (!to || to === client.nickLower) return cb({ ok: false, error: 'invalid' });
    await UserDB.block(client.nickLower, to);
    cb({ ok: true });
  });

  safeOn('user-unblock', async ({ nickname }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;
    const to = String(nickname || '').trim().toLowerCase();
    await UserDB.unblock(client.nickLower, to);
    cb({ ok: true });
  });

  safeOn('friend-request', async ({ toNickname }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const toLower = String(toNickname || '').trim().toLowerCase();
    const toUser = await UserDB.get(toLower);
    if (!toUser) return cb({ ok: false, error: 'not_found' });
    if (toLower === client.nickLower) return cb({ ok: false, error: 'self' });
    if (await UserDB.areFriends(client.nickLower, toLower)) return cb({ ok: false, error: 'already_friends' });
    if (await UserDB.hasRequest(toLower, client.nickLower)) return cb({ ok: false, error: 'already_sent' });

    await UserDB.addRequest(toLower, client.nickLower);

    const fromUser = await UserDB.get(client.nickLower);
    for (const [sid, cl] of clients.entries()) {
      if (cl.authed && cl.nickLower === toLower) {
        io.to(sid).emit('friend-request-incoming', {
          fromNick: fromUser.nickname,
          fromLower: client.nickLower,
          avatar: fromUser.avatar || null
        });
      }
    }

    cb({ ok: true });
  });

  safeOn('friend-respond', async ({ fromNickname, accept }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const fromLower = String(fromNickname || '').trim().toLowerCase();
    const fromUser = await UserDB.get(fromLower);
    if (!fromUser) return cb({ ok: false, error: 'not_found' });

    await UserDB.removeRequest(client.nickLower, fromLower);

    if (accept) {
      await UserDB.addFriend(client.nickLower, fromLower);
      const me = await UserDB.get(client.nickLower);
      for (const [sid, cl] of clients.entries()) {
        if (cl.authed && cl.nickLower === fromLower) {
          io.to(sid).emit('friend-accepted', {
            byNick: me.nickname,
            byLower: client.nickLower,
            avatar: me.avatar || null
          });
        }
      }
    }

    cb({ ok: true });
  });

  safeOn('friend-remove', async ({ nickname }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;
    const to = String(nickname || '').trim().toLowerCase();
    await UserDB.removeFriend(client.nickLower, to);
    cb({ ok: true });
  });

  safeOn('friends-list', async (cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    cb({
      ok: true,
      friends: await UserDB.getFriends(client.nickLower),
      requests: await UserDB.getFriendRequests(client.nickLower)
    });
  });

  // PRIVATE CHATS
  safeOn('private-chat-open', async ({ withNickname }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const withLower = String(withNickname || '').trim().toLowerCase();
    let withUser = await UserDB.get(withLower);
    let realLower = withLower;

    if (!withUser) {
      const byUsername = await UserDB.getByUsername(withLower);
      if (byUsername) {
        withUser = byUsername;
        const row = await queryOne('SELECT nick_lower FROM users WHERE username = ?', [withLower]);
        if (row?.nick_lower) realLower = row.nick_lower;
      }
    }

    if (!withUser) return cb({ ok: false, error: 'not_found' });
    if (realLower === client.nickLower) return cb({ ok: false, error: 'self' });

    const chatId = generateChatId(client.nickLower, realLower);
    await PrivateChatDB.create(chatId, client.nickLower, realLower);

    socket.join('pc:' + chatId);

    for (const [sid, cl] of clients.entries()) {
      if (cl.authed && cl.nickLower === realLower) {
        const wsock = io.sockets.sockets.get(sid);
        if (wsock) wsock.join('pc:' + chatId);
      }
    }

    cb({
      ok: true,
      chatId,
      withNickname: withUser.nickname,
      withAvatar: withUser.avatar || null,
      online: isOnline(realLower)
    });
  });

  safeOn('private-chat-list', async (cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const rows = await PrivateChatDB.getUserChats(client.nickLower);
    const list = await Promise.all(rows.map(async row => {
      const otherLower = row.member1 === client.nickLower ? row.member2 : row.member1;
      const other = await UserDB.get(otherLower);
      const lastTs = row.last_ts ? Number(row.last_ts) : null;
      return {
        chatId: row.chat_id,
        withNickname: other?.nickname || otherLower,
        withAvatar: other?.avatar || null,
        withLower: otherLower,
        createdAt: Number(row.created_at) || Date.now(),
        online: isOnline(otherLower),
        lastMessage: (row.last_type && lastTs && !isNaN(lastTs))
          ? { type: row.last_type, timestamp: lastTs }
          : null
      };
    }));

    cb({ ok: true, chats: list });
  });

  safeOn('private-chat-history', async ({ chatId, limit, beforeTs }, cb) => {
  const client = requireAuthed(cb);
  if (!client) return;

  if (!await PrivateChatDB.isMember(chatId, client.nickLower)) {
    return cb({ ok: false, error: 'not_member' });
  }

  const lim = Math.max(1, Math.min(100, Number(limit) || 50));
  const hasBefore = beforeTs !== null && beforeTs !== undefined && beforeTs !== '' && Number.isFinite(Number(beforeTs));
  const before = hasBefore ? Number(beforeTs) : null;

  // 🔒 Читаем напрямую из private_messages (обход проблемы getMessages)
  const baseRows = await query(
    `SELECT *
     FROM private_messages
     WHERE chat_id = ?
       ${hasBefore ? 'AND timestamp < ?' : ''}
     ORDER BY timestamp DESC
     LIMIT ?`,
    hasBefore ? [chatId, before, lim] : [chatId, lim]
  );

  // В хронологический порядок
  baseRows.reverse();

  const messages = [];
  for (const r of baseRows) {
    const readRows = await query(
      `SELECT nick_lower FROM private_msg_read_by WHERE msg_id = ?`,
      [r.msg_id]
    );
    const delRows = await query(
      `SELECT nick_lower FROM private_msg_deleted_for WHERE msg_id = ?`,
      [r.msg_id]
    );

    messages.push({
      id: r.msg_id,
      chatId: r.chat_id,
      from: r.from_lower,
      fromNick: r.from_nick,
      fromAvatar: r.from_avatar || null,
      encrypted: r.encrypted || null,
      iv: r.iv || null,
      type: r.type || 'text',
      fileName: r.file_name || null,
      fileSize: r.file_size ? Number(r.file_size) : null,
      mimeType: r.mime_type || null,
      duration: Number(r.duration) || 0,
      seq: Number(r.seq) || 0,
      status: r.status || 'sent',
      edited: !!Number(r.edited),
      timestamp: Number(r.timestamp),
      readBy: readRows.map(x => x.nick_lower),
      deletedFor: delRows.map(x => x.nick_lower)
    });
  }

  const filtered = messages.filter(m => !m.deletedFor.includes(client.nickLower));

  const rawCountRow = await queryOne(
    'SELECT COUNT(*) AS c FROM private_messages WHERE chat_id = ?',
    [chatId]
  );
  const rawCount = Number(rawCountRow?.c || 0);

  cb({
    ok: true,
    messages: filtered.map(m => ({ ...m, reactions: getReactions(m.id) })),
    hasMore: filtered.length >= lim,
    _debug: { rawCount, selected: messages.length, visible: filtered.length }
  });
});
  // ROOMS
  safeOn('create-room', async ({ name, password, photo, autoDelete, joinMode }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const roomName = String(name || '').trim().slice(0, 50);
    if (!roomName) return cb({ ok: false, error: 'empty_name' });

    let passwordHash = null;
    if (password && String(password).length > 0) {
      const pwErr = validatePassword(String(password));
      if (pwErr) return cb({ ok: false, error: `room_pw_${pwErr}` });
      passwordHash = hashPassword(String(password));
    }

    const roomId = generateRoomId();
    const roomSalt = nodeCrypto.randomBytes(16).toString('hex');

    let autoDeleteMs = null;
    if (autoDelete && autoDelete !== 'never') {
      const parsed = parseInt(autoDelete, 10);
      if (Number.isFinite(parsed) && parsed > 0) autoDeleteMs = parsed;
    }

    const roomData = {
      id: roomId,
      name: roomName,
      passwordHash,
      photo: photo || null,
      ownerNick: client.nickLower,
      joinMode: joinMode === 'approval' ? 'approval' : 'open',
      autoDelete: autoDeleteMs,
      salt: roomSalt,
      createdAt: Date.now(),
      members: new Set(),
      permanentMembers: new Set([client.nickLower]),
      pendingRequests: [],
      emptyTimer: null,
      emptyAt: null,
      lastSeq: new Map(),
      messages: []
    };

    await RoomDB.create(roomId, roomData);
    await RoomDB.addMember(roomId, client.nickLower);

    rooms.set(roomId, roomData);
    broadcastRoomList();

    cb({ ok: true, roomId, roomSalt });
  });

  safeOn('room-delete', async ({ roomId }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (!isRoomOwner(client, room)) return cb({ ok: false, error: 'not_owner' });

    io.to(roomId).emit('room-deleted', { roomId, roomName: room.name });

    for (const sid of room.members) {
      const c = clients.get(sid);
      if (c && c.roomId === roomId) c.roomId = null;
    }

    if (room.emptyTimer) clearTimeout(room.emptyTimer);

    rooms.delete(roomId);
    await RoomDB.delete(roomId);

    broadcastRoomList();
    cb({ ok: true });
  });

  safeOn('leave-room-permanent', async ({ roomId }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });

    if (isRoomOwner(client, room)) return cb({ ok: false, error: 'owner_cannot_leave' });

    room.permanentMembers.delete(client.nickLower);
    await RoomDB.removeMember(roomId, client.nickLower);

    socket.leave(roomId);

    if (client.roomId === roomId) {
      room.members.delete(socket.id);
      socket.to(roomId).emit('room-user-left', socket.id);
      client.roomId = null;
    }

    for (const [sid, cl] of clients.entries()) {
      if (cl.authed && cl.nickLower === room.ownerNick) {
        io.to(sid).emit('room-member-left', {
          roomId,
          nickname: client.nickname,
          nickLower: client.nickLower
        });
      }
    }

    broadcastRoomList();
    cb({ ok: true });
  });

  safeOn('room-settings-update', async ({ roomId, autoDelete, joinMode }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (!isRoomOwner(client, room)) return cb({ ok: false, error: 'not_owner' });

    const updates = {};

    if (autoDelete !== undefined) {
      let ms = null;
      if (autoDelete && autoDelete !== 'never') {
        const parsed = parseInt(autoDelete, 10);
        if (Number.isFinite(parsed) && parsed > 0) ms = parsed;
      }
      room.autoDelete = ms;
      updates.autoDelete = ms;
    }

    if (joinMode !== undefined) {
      room.joinMode = joinMode === 'approval' ? 'approval' : 'open';
      updates.joinMode = room.joinMode;
    }

    await RoomDB.update(roomId, updates);
    broadcastRoomList();
    io.to(roomId).emit('room-settings-changed', {
      roomId,
      autoDelete: room.autoDelete,
      joinMode: room.joinMode
    });

    cb({ ok: true });
  });

  safeOn('room-rename', async ({ roomId, newName }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (!isRoomOwner(client, room)) return cb({ ok: false, error: 'not_owner' });

    const name = String(newName || '').trim().slice(0, 50);
    if (!name) return cb({ ok: false, error: 'empty_name' });

    room.name = name;
    await RoomDB.update(roomId, { name });

    broadcastRoomList();
    io.to(roomId).emit('room-renamed', { roomId, newName: name });

    cb({ ok: true });
  });

  safeOn('room-set-photo', async ({ roomId, photo }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (!isRoomOwner(client, room)) return cb({ ok: false, error: 'not_owner' });

    const p = photo ? String(photo) : null;
    if (p && p.length > 3 * 1024 * 1024) return cb({ ok: false, error: 'photo_too_large' });

    room.photo = p;
    await RoomDB.update(roomId, { photo: p });

    broadcastRoomList();
    io.to(roomId).emit('room-photo-updated', { roomId, photo: p });

    cb({ ok: true });
  });

  safeOn('room-members', async ({ roomId }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });

    const canAccess = room.permanentMembers.has(client.nickLower) || isRoomOwner(client, room);
    if (!canAccess) return cb({ ok: false, error: 'not_member' });

    const list = [...room.members].map(sid => {
      const c = clients.get(sid);
      return {
        id: sid,
        nickname: c?.nickname || shortId(sid),
        avatar: null,
        isOwner: c?.nickLower === room.ownerNick
      };
    });

    cb({
      ok: true,
      members: list,
      pendingRequests: isRoomOwner(client, room) ? (room.pendingRequests || []) : []
    });
  });

  safeOn('room-request-join', async ({ roomId }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (room.joinMode !== 'approval') return cb({ ok: false, error: 'not_approval_mode' });

    if (room.permanentMembers.has(client.nickLower)) return cb({ ok: true, autoAccepted: true });

    const exists = room.pendingRequests.find(r => r.nickLower === client.nickLower);
    if (exists) return cb({ ok: false, error: 'already_requested' });

    const user = await UserDB.get(client.nickLower);
    room.pendingRequests.push({
      nickLower: client.nickLower,
      nickname: client.nickname,
      avatar: user?.avatar || null,
      socketId: socket.id
    });

    for (const [sid, cl] of clients.entries()) {
      if (cl.authed && cl.nickLower === room.ownerNick) {
        io.to(sid).emit('room-join-request', {
          roomId,
          roomName: room.name,
          nickLower: client.nickLower,
          nickname: client.nickname,
          avatar: user?.avatar || null
        });
      }
    }

    cb({ ok: true });
  });

  safeOn('room-request-respond', async ({ roomId, nickLower, accept }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });
    if (!isRoomOwner(client, room)) return cb({ ok: false, error: 'not_owner' });

    const idx = room.pendingRequests.findIndex(r => r.nickLower === nickLower);
    if (idx === -1) return cb({ ok: false, error: 'not_found' });

    room.pendingRequests.splice(idx, 1);

    if (accept) {
      room.permanentMembers.add(nickLower);
      await RoomDB.addMember(roomId, nickLower);
    }

    for (const [sid, cl] of clients.entries()) {
      if (cl.authed && cl.nickLower === nickLower) {
        if (accept) io.to(sid).emit('room-request-accepted', { roomId, roomName: room.name });
        else io.to(sid).emit('room-request-declined', { roomId, roomName: room.name });
      }
    }

    cb({ ok: true });
  });

  safeOn('room-invite', async ({ toNickname, roomId }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'room_not_found' });

    const canInvite = room.permanentMembers.has(client.nickLower) || isRoomOwner(client, room);
    if (!canInvite) return cb({ ok: false, error: 'not_member' });

    const toLower = String(toNickname || '').trim().toLowerCase();

    let sent = false;
    for (const [sid, cl] of clients.entries()) {
      if (cl.authed && cl.nickLower === toLower) {
        io.to(sid).emit('room-invite', {
          fromNick: client.nickname,
          roomId: room.id,
          roomName: room.name,
          hasPassword: !!room.passwordHash,
          joinMode: room.joinMode
        });
        sent = true;
      }
    }

    cb({ ok: true, online: sent });
  });

  safeOn('join-room', async ({ roomId, password }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });

    const bf = checkBruteForce(`${clientIp}:join-room`);
    if (bf.blocked) return cb({ ok: false, error: 'rate_limited', secsLeft: bf.secsLeft });

    if (room.passwordHash) {
      const pass = String(password || '');
      if (!verifyPassword(pass, room.passwordHash)) {
        recordFailedAttempt(`${clientIp}:join-room`);
        return setTimeout(() => cb({ ok: false, error: 'wrong_password' }), 700);
      }
    }
    recordSuccessAttempt(`${clientIp}:join-room`);

    const isMember = room.permanentMembers.has(client.nickLower);
    const owner = isRoomOwner(client, room);

    if (room.joinMode === 'approval' && !owner && !isMember) {
      return cb({ ok: false, error: 'approval_required' });
    }

    if (client.roomId && client.roomId !== roomId) leaveRoom(socket, client.roomId);

    cancelRoomDelete(roomId);

    client.roomId = roomId;
    room.members.add(socket.id);

    if (!isMember) {
      room.permanentMembers.add(client.nickLower);
      await RoomDB.addMember(roomId, client.nickLower);
    }

    socket.join(roomId);

    const user = await UserDB.get(client.nickLower);
    const others = [...room.members]
      .filter(id => id !== socket.id)
      .map(id => {
        const c = clients.get(id);
        return {
          id,
          nickname: c?.nickname || shortId(id),
          avatar: null
        };
      });

    socket.to(roomId).emit('room-user-joined', {
      id: socket.id,
      nickname: client.nickname,
      avatar: user?.avatar || null
    });

    broadcastRoomList();

    cb({
      ok: true,
      room: {
        id: room.id,
        name: room.name,
        photo: room.photo,
        members: others,
        roomSalt: room.salt,
        isOwner: owner,
        autoDelete: room.autoDelete,
        joinMode: room.joinMode,
        pendingRequests: owner ? room.pendingRequests : []
      }
    });
  });

  safeOn('leave-room', async (_payload, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;
    if (client.roomId) leaveRoom(socket, client.roomId);
    cb && cb({ ok: true });
  });

  safeOn('room-history', async ({ roomId }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });

    const canAccess = room.permanentMembers.has(client.nickLower) || isRoomOwner(client, room);
    if (!canAccess) return cb({ ok: false, error: 'not_member' });

    if (!room.messages || room.messages.length === 0) {
      room.messages = await RoomDB.getMessages(roomId, MAX_STORED_MESSAGES);
    }

    cb({
      ok: true,
      messages: room.messages.map(m => ({ ...m, reactions: getReactions(m.id) }))
    });
  });

  safeOn('chat-message', async (data, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    if (!client.roomId) return cb && cb({ ok: false, error: 'no_room' });

    const room = rooms.get(client.roomId);
    if (!room) return cb && cb({ ok: false, error: 'room_not_found' });

    if (!(room.permanentMembers.has(client.nickLower) || isRoomOwner(client, room))) {
      return cb && cb({ ok: false, error: 'not_member' });
    }

    const seqNum = parseInt(data?.seq, 10);
    if (!Number.isInteger(seqNum) || seqNum < 0) return cb && cb({ ok: false, error: 'bad_seq' });

    const lastSeq = room.lastSeq.get(socket.id) || -1;
    if (seqNum <= lastSeq) return cb && cb({ ok: false, error: 'replay' });
    room.lastSeq.set(socket.id, seqNum);

    const v = validateMessagePayload(data || {});
    if (!v.ok) return cb && cb({ ok: false, error: v.error });

    const msgId = generateMsgId();
    const msg = {
      id: msgId,
      roomId: client.roomId,
      from: socket.id,
      nickLower: client.nickLower,
      nickname: client.nickname,
      encrypted: data.encrypted || null,
      iv: data.iv || null,
      type: data.type || 'text',
      fileName: data.fileName || null,
      fileSize: data.fileSize || null,
      mimeType: data.mimeType || null,
      duration: data.duration || 0,
      seq: seqNum,
      timestamp: Date.now(),
      edited: false,
      deletedFor: [],
      replyTo: data.replyTo || null
    };

    await RoomDB.saveMessage(msg);

    if (!room.messages) room.messages = [];
    room.messages.push(msg);
    if (room.messages.length > MAX_STORED_MESSAGES) {
      room.messages = room.messages.slice(-MAX_STORED_MESSAGES);
    }

    socket.to(client.roomId).emit('typing-stop', { from: socket.id });
    socket.to(client.roomId).emit('chat-message', { ...msg, reactions: {} });
    socket.emit('chat-msg-id', { seq: seqNum, msgId });

    cb && cb({ ok: true, msgId });
  });

  safeOn('room-msg-delete', async ({ roomId, msgId, deleteFor }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });

    const canAccess = room.permanentMembers.has(client.nickLower) || isRoomOwner(client, room);
    if (!canAccess) return cb({ ok: false, error: 'not_member' });

    const msg = await RoomDB.getMessage(msgId);
    if (!msg) return cb({ ok: false, error: 'not_found' });

    const mine = msg.nickLower === client.nickLower;
    const owner = isRoomOwner(client, room);

    if (deleteFor === 'all') {
      if (!mine && !owner) return cb({ ok: false, error: 'not_allowed' });
      await RoomDB.deleteMessage(msgId);
      messageReactions.delete(msgId);
      room.messages = room.messages.filter(m => m.id !== msgId);
      io.to(roomId).emit('room-msg-deleted', { roomId, msgId, deleteFor: 'all' });
      return cb({ ok: true });
    }

    if (deleteFor === 'me') {
      await RoomDB.addDeletedFor(msgId, client.nickLower);
      room.messages = room.messages.map(m => {
        if (m.id !== msgId) return m;
        return { ...m, deletedFor: [...(m.deletedFor || []), client.nickLower] };
      });
      socket.emit('room-msg-deleted', { roomId, msgId, deleteFor: 'me' });
      return cb({ ok: true });
    }

    cb({ ok: false, error: 'invalid_delete_for' });
  });

  safeOn('room-msg-edit', async ({ roomId, msgId, newEncrypted, newIv }, cb) => {
    const client = requireAuthed(cb);
    if (!client) return;

    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'not_found' });

    const canAccess = room.permanentMembers.has(client.nickLower) || isRoomOwner(client, room);
    if (!canAccess) return cb({ ok: false, error: 'not_member' });

    const msg = await RoomDB.getMessage(msgId);
    if (!msg) return cb({ ok: false, error: 'not_found' });
    if (msg.nickLower !== client.nickLower) return cb({ ok: false, error: 'not_yours' });
    if (msg.type !== 'text') return cb({ ok: false, error: 'not_text' });

    if (!newEncrypted || String(newEncrypted).length > MAX_ENCRYPTED_B64_LEN) {
      return cb({ ok: false, error: 'payload_too_large' });
    }

    await RoomDB.editMessage(msgId, newEncrypted, newIv);

    room.messages = room.messages.map(m =>
      m.id === msgId
        ? { ...m, encrypted: newEncrypted, iv: newIv, edited: true }
        : m
    );

    io.to(roomId).emit('room-msg-edited', {
      roomId,
      msgId,
      newEncrypted,
      newIv,
      editedAt: Date.now()
    });

    cb({ ok: true });
  });

  // ════════════════════════════
  //  GROUP VOICE / WEBRTC
  // ════════════════════════════
  socket.on('offer', ({ to, offer }) => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    io.to(to).emit('offer', { from: socket.id, offer, nickname: c.nickname });
  });

  socket.on('answer', ({ to, answer }) => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    io.to(to).emit('answer', { from: socket.id, answer, nickname: c.nickname });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('voice-join', () => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    const room = rooms.get(c.roomId);
    if (!room) return;

    const others = [...room.members]
      .filter(id => id !== socket.id)
      .map(id => ({ id, nickname: clients.get(id)?.nickname || shortId(id) }));

    socket.to(c.roomId).emit('voice-user-joined', { id: socket.id, nickname: c.nickname });
    socket.emit('existing-voice-users', others);
  });

  socket.on('voice-leave', () => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    socket.to(c.roomId).emit('voice-user-left', socket.id);
  });

  socket.on('typing-start', () => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId || !c.nickname) return;
    socket.to(c.roomId).emit('typing-start', { from: socket.id, nickname: c.nickname });
  });

  socket.on('typing-stop', () => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    socket.to(c.roomId).emit('typing-stop', { from: socket.id });
  });

  socket.on('understood', () => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    socket.to(c.roomId).emit('understood', { from: socket.id, nickname: c.nickname });
  });

  socket.on('ecdh-pubkey', ({ to, pubkey }) => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    io.to(to).emit('ecdh-pubkey', { from: socket.id, pubkey, nickname: c.nickname });
  });

  socket.on('key-fingerprint', ({ to, fingerprint }) => {
    const c = clients.get(socket.id);
    if (!c?.authed || !c?.roomId) return;
    io.to(to).emit('key-fingerprint', { from: socket.id, nickname: c.nickname, fingerprint });
  });

  // ════════════════════════════
  //  PRIVATE CALLS
  // ════════════════════════════
  socket.on('private-call-offer', ({ chatId, to, offer, isVideo }) => {
    const c = clients.get(socket.id);
    if (!c?.authed) return;

    let sent = false;
    for (const [sid, cl] of clients.entries()) {
      if (cl.authed && cl.nickLower === to) {
        io.to(sid).emit('private-call-offer', {
          chatId,
          from: socket.id,
          fromNick: c.nickname,
          fromNickLower: c.nickLower,
          fromAvatar: null,
          offer,
          isVideo: !!isVideo
        });
        sent = true;
      }
    }
    if (!sent && io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-offer', {
        chatId,
        from: socket.id,
        fromNick: c.nickname,
        fromNickLower: c.nickLower,
        fromAvatar: null,
        offer,
        isVideo: !!isVideo
      });
    }
  });

  socket.on('private-call-answer', ({ to, answer }) => {
    if (io.sockets.sockets.get(to)) io.to(to).emit('private-call-answer', { from: socket.id, answer });
  });

  socket.on('private-call-ice', ({ to, candidate }) => {
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ice', { from: socket.id, candidate });
    } else {
      for (const [sid, cl] of clients.entries()) {
        if (cl.authed && cl.nickLower === to) io.to(sid).emit('private-call-ice', { from: socket.id, candidate });
      }
    }
  });

  socket.on('private-call-end', ({ to }) => {
    if (!to) return;
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ended', { from: socket.id });
    } else {
      for (const [sid, cl] of clients.entries()) {
        if (cl.authed && cl.nickLower === to) io.to(sid).emit('private-call-ended', { from: socket.id });
      }
    }
  });

  socket.on('private-call-reject', ({ to }) => {
    if (!to) return;
    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-rejected', { from: socket.id });
    } else {
      for (const [sid, cl] of clients.entries()) {
        if (cl.authed && cl.nickLower === to) io.to(sid).emit('private-call-rejected', { from: socket.id });
      }
    }
  });

  socket.on('private-call-ecdh', ({ to, pubkey }) => {
    const c = clients.get(socket.id);
    if (!c?.authed) return;

    if (io.sockets.sockets.get(to)) {
      io.to(to).emit('private-call-ecdh', { from: socket.id, pubkey });
    } else {
      for (const [sid, cl] of clients.entries()) {
        if (cl.authed && cl.nickLower === to) io.to(sid).emit('private-call-ecdh', { from: socket.id, pubkey });
      }
    }
  });

  // ════════════════════════════
  //  DISCONNECT
  // ════════════════════════════
  socket.on('disconnect', () => {
    const client = clients.get(socket.id);
    if (client?.roomId) leaveRoom(socket, client.roomId);
    if (client?.nickLower) setOffline(client.nickLower, socket.id);
    clients.delete(socket.id);
    console.log('Disconnected:', socket.id);
  });
});

// ════════════════════════════════════════════
//  START
// ════════════════════════════════════════════
initDB()
  .then(() => loadRoomsFromDB())
  .then(() => {
    server.listen(PORT, () => {
      console.log(`✅ Server running on ${PORT}`);
      console.log(`ENV=${NODE_ENV} | JSON=${MAX_JSON_MB}MB | SOCKET=${MAX_SOCKET_MB}MB`);
      console.log(`Guest mode: ${ALLOW_GUEST ? 'ON' : 'OFF'}`);
      if (ALLOWED_ORIGINS.length) console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
      else console.log('Allowed origins: (none set)');
    });
  })
  .catch(err => {
    console.error('❌ DB init error:', err);
    process.exit(1);
  });



