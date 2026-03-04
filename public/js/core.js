// ═══════════════════════════════════════════════
//  CORE.JS — утилиты, шифрование, тема, socket
// ═══════════════════════════════════════════════

// ─── ArrayBuffer → Base64 ───
function arrayBufferToBase64Safe(buffer) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const CHUNK = 8192;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  return btoa(binary);
}

// ─── ТЕМА ───
const THEME_KEY = 'privchat_theme';
let currentTheme = localStorage.getItem(THEME_KEY) || 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);

  const root = document.documentElement;

  if (theme === 'light') {
    root.style.setProperty('--bg',        '#f0f2f5');
    root.style.setProperty('--bg2',       '#ffffff');
    root.style.setProperty('--surface',   '#ffffff');
    root.style.setProperty('--surface2',  '#f7f8fa');
    root.style.setProperty('--surface3',  '#eff1f3');
    root.style.setProperty('--text',      '#111b21');
    root.style.setProperty('--text2',     '#3b4a54');
    root.style.setProperty('--sub',       '#8696a0');
    root.style.setProperty('--divider',   'rgba(0,0,0,0.08)');
    root.style.setProperty('--bubble-in', '#ffffff');
    root.style.setProperty('--bubble-me', '#d9fdd3');
    root.style.setProperty('--glass',     'rgba(255,255,255,0.92)');
    root.style.setProperty('--accent',    '#00a884');
    root.style.setProperty('--accent2',   '#00a884');
    root.style.setProperty('--accent-g',  'linear-gradient(135deg,#00a884,#00856f)');
    root.style.setProperty('--green',     '#25d366');
    root.style.setProperty('--red',       '#e05252');
    root.style.setProperty('--orange',    '#e08a3c');
  } else {
    root.style.setProperty('--bg',        '#0a0a0f');
    root.style.setProperty('--bg2',       '#111118');
    root.style.setProperty('--surface',   '#16161f');
    root.style.setProperty('--surface2',  '#1c1c28');
    root.style.setProperty('--surface3',  '#222232');
    root.style.setProperty('--text',      '#e8e8f0');
    root.style.setProperty('--text2',     '#9090b0');
    root.style.setProperty('--sub',       '#55556a');
    root.style.setProperty('--divider',   'rgba(255,255,255,0.06)');
    root.style.setProperty('--bubble-in', '#16161f');
    root.style.setProperty('--bubble-me', '#2d1f5e');
    root.style.setProperty('--glass',     'rgba(22,22,31,0.85)');
    root.style.setProperty('--accent',    '#7c5cbf');
    root.style.setProperty('--accent2',   '#a07de0');
    root.style.setProperty('--accent-g',  'linear-gradient(135deg,#7c5cbf,#5b3fa0)');
    root.style.setProperty('--green',     '#3dba6e');
    root.style.setProperty('--red',       '#e05252');
    root.style.setProperty('--orange',    '#e08a3c');
  }

  // Обновляем ВСЕ кнопки переключения темы
  document.querySelectorAll('#btn-drawer-theme, .theme-toggle-btn').forEach(btn => {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  });

  // theme-color для браузера
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = theme === 'light' ? '#f0f2f5' : '#0a0a0f';
}

function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// Применяем сразу
applyTheme(currentTheme);

// ─── Кнопка темы — вешаем обработчик несколькими способами ───
function initThemeBtn() {
  const btn = document.getElementById('btn-drawer-theme');
  if (btn) {
    // Удаляем старые обработчики клонированием
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleTheme();
    });
    // Сразу обновляем иконку
    newBtn.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  }
}

// Вешаем при загрузке DOM
document.addEventListener('DOMContentLoaded', initThemeBtn);

// И через небольшую задержку (на случай если drawer рендерится позже)
setTimeout(initThemeBtn, 500);
setTimeout(initThemeBtn, 1500);

// ─── УТИЛИТЫ ───
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatSize(bytes) {
  if (bytes < 1024)    return bytes + ' Б';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' КБ';
  return (bytes/1048576).toFixed(1) + ' МБ';
}
function shortId(id)   { return id ? id.slice(0,6) : '??'; }
function formatCountdown(msLeft) {
  if (msLeft <= 0) return '00:00';
  const s = Math.floor(msLeft/1000);
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  return String(Math.floor(s/60)).padStart(1,'0') + ':' + String(s%60).padStart(2,'0');
}
function $(id) { return document.getElementById(id); }

function scrollToBottom() {
  requestAnimationFrame(() => {
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    if (window._updateChatLayout) window._updateChatLayout();
  });
}

function showScreen(name) {
  const screenAuth  = document.getElementById('screen-auth');
  const screenLobby = document.getElementById('screen-lobby');
  const screenMain  = document.getElementById('screen-main');
  [screenAuth, screenLobby, screenMain].forEach(s => { if(s) s.classList.remove('active'); });
  if (name === 'auth'  && screenAuth)  screenAuth.classList.add('active');
  if (name === 'lobby' && screenLobby) screenLobby.classList.add('active');
  if (name === 'chat'  && screenMain)  {
    screenMain.classList.add('active');
    screenMain.style.height = '';
    screenMain.style.top    = '';
  }
  if (typeof updateCallButton  === 'function') updateCallButton();
  if (typeof updateHeaderButtons === 'function') updateHeaderButtons();
}

function avatarHtml(avatar, fallback = '👤', size = '100%') {
  if (avatar) return `<img src="${escapeHtml(avatar)}" alt="" style="width:${size};height:${size};object-fit:cover">`;
  return fallback;
}

// ─── TOAST ───
function showToast(text, duration = 3000, onClick = null) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (onClick ? ' invite-toast' : '');
  el.textContent = text;
  if (onClick) el.addEventListener('click', () => { onClick(); el.remove(); });
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
  return el;
}

function playMsgSound(chatId) {
  const setting = typeof getNotifSetting === 'function' ? getNotifSetting(chatId || '') : 'all';
  if (setting === 'none') return;
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.06);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => ctx.close();
  } catch (_) {}
}

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    Notification.requestPermission();
}

function showBrowserNotif(title, body, chatId) {
  if (chatId && typeof getNotifSetting === 'function' && getNotifSetting(chatId) === 'none') return;
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icon.png', silent: false, tag: chatId });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 5000);
  } catch (_) {}
}

// ─── SOCKET ───
const socket = io({
  reconnection:          true,
  reconnectionAttempts:  Infinity,
  reconnectionDelay:     1000,
  reconnectionDelayMax:  5000,
  timeout:               20000,
  transports:            ['websocket', 'polling'],
  autoConnect:           true,
});

// ─── SERVICE WORKER ───
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─── ГЛОБАЛЬНОЕ СОСТОЯНИЕ ───
let myNickname      = '';
let myUsername      = '';
let myAvatar        = null;
let authToken       = null;
let currentRoomId   = null;
let currentRoomData = null;
let currentPassword = '';
let pendingJoinRoom = null;
let roomPhotoData   = null;
let memberCount     = 0;
let isRoomOwner     = false;
let currentChatType = 'group';
let currentChatId   = null;
let currentChatWith = null;
let outgoingSeq     = 0;
let msgCounter      = 0;

const msgIdToDomId  = new Map();
const seqToMsgId    = new Map();
const unreadCounts  = {};
let totalUnread     = 0;

// ─── НАСТРОЙКИ УВЕДОМЛЕНИЙ ───
const notifSettings = {};
try {
  const saved = localStorage.getItem('notifSettings');
  if (saved) Object.assign(notifSettings, JSON.parse(saved));
} catch (_) {}

function saveNotifSettings() {
  try { localStorage.setItem('notifSettings', JSON.stringify(notifSettings)); } catch (_) {}
}
function getNotifSetting(id) { return notifSettings[id] || 'all'; }
function setNotifSetting(id, val) { notifSettings[id] = val; saveNotifSettings(); }

// ─── СЧЁТЧИК НЕПРОЧИТАННЫХ ───
function updateTabBadge() {
  totalUnread = Object.values(unreadCounts).reduce((a,b)=>a+b, 0);
  try { document.title = totalUnread > 0 ? `(${totalUnread}) Приватный чат` : 'Приватный чат'; } catch (_) {}
}
function addUnread(id, count = 1) {
  if (!id) return;
  unreadCounts[id] = (unreadCounts[id] || 0) + count;
  updateTabBadge();
  if (typeof renderUnifiedList === 'function') renderUnifiedList();
  if (typeof renderUnifiedListInChat === 'function') renderUnifiedListInChat();
}
function clearUnread(id) {
  if (!id || !unreadCounts[id]) return;
  delete unreadCounts[id];
  updateTabBadge();
  if (typeof renderUnifiedList === 'function') renderUnifiedList();
  if (typeof renderUnifiedListInChat === 'function') renderUnifiedListInChat();
}

// ─── ШИФРОВАНИЕ ───
const Crypto = (() => {
  let roomKey        = null;
  const sessionKeys  = {};
  const messageKeys  = {};
  let myEcdhKeyPair  = null;
  let messageCounter = 0;

  async function deriveKey(password, roomId, roomSalt) {
    const enc    = new TextEncoder();
    const secret = (password || 'open') + '|' + roomId;
    const keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const saltBytes = enc.encode(roomSalt + 'privchat-v4-aes256gcm');
    roomKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 310000, hash: 'SHA-256' },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
    return roomKey;
  }

  async function generateEcdhKeyPair() {
    myEcdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveKey', 'deriveBits']
    );
    return myEcdhKeyPair;
  }

  async function exportPublicKey() {
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const raw = await crypto.subtle.exportKey('raw', myEcdhKeyPair.publicKey);
    return arrayBufferToBase64Safe(raw);
  }

  async function deriveSessionKey(theirPubKeyB64, peerId) {
    const raw = Uint8Array.from(atob(theirPubKeyB64), c => c.charCodeAt(0));
    let theirKey;
    try {
      theirKey = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-384' }, false, []);
    } catch (_) {
      theirKey = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    }
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirKey }, myEcdhKeyPair.privateKey, 384);
    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const enc = new TextEncoder();
    sessionKeys[peerId] = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('privchat-session-v3-aes'), info: enc.encode('ecdh-aes-gcm-256-session') },
      hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    const rotationBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('privchat-rotation-v3'), info: enc.encode('forward-secrecy-seed') },
      hkdfKey, 256
    );
    messageKeys[peerId] = { seed: rotationBits, counter: 0 };
    return sessionKeys[peerId];
  }

  async function getKeyFingerprint() {
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const raw  = await crypto.subtle.exportKey('raw', myEcdhKeyPair.publicKey);
    const hash = await crypto.subtle.digest('SHA-256', raw);
    const hex  = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{4}/g).slice(0, 8).join(' ').toUpperCase();
  }

  function getSessionKey(peerId)   { return sessionKeys[peerId] || null; }
  function clearSessionKey(peerId) { delete sessionKeys[peerId]; delete messageKeys[peerId]; }

  async function encrypt(data, key) {
    const useKey = key || roomKey;
    if (!useKey) throw new Error('No encryption key available');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let encoded;
    if (typeof data === 'string') encoded = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) encoded = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) encoded = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else throw new TypeError('encrypt: unsupported data type');
    const paddingSize = Math.floor(Math.random() * 16);
    const padding     = crypto.getRandomValues(new Uint8Array(paddingSize));
    const padded      = new Uint8Array(1 + paddingSize + encoded.length);
    padded[0] = paddingSize;
    padded.set(padding, 1);
    padded.set(encoded, 1 + paddingSize);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, useKey, padded);
    return { iv: arrayBufferToBase64Safe(iv.buffer), encrypted: arrayBufferToBase64Safe(cipher) };
  }

  async function decrypt(encB64, ivB64, key) {
    const useKey = key || roomKey;
    if (!useKey) throw new Error('No decryption key available');
    const iv     = Uint8Array.from(atob(ivB64),  c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
    const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, useKey, cipher);
    const view   = new Uint8Array(plain);
    return plain.slice(1 + view[0]);
  }

  async function decryptText(encB64, ivB64, key) {
    return new TextDecoder().decode(await decrypt(encB64, ivB64, key));
  }

  async function decryptBlob(encB64, ivB64, mime, key) {
    return new Blob([await decrypt(encB64, ivB64, key)], { type: mime });
  }

  function clearAllKeys() {
    roomKey = null; myEcdhKeyPair = null; messageCounter = 0;
    for (const k in sessionKeys) delete sessionKeys[k];
    for (const k in messageKeys) delete messageKeys[k];
  }

  async function generateOTK() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function exportKey(key) {
    return arrayBufferToBase64Safe(await crypto.subtle.exportKey('raw', key));
  }
  async function importKey(b64) {
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  return {
    deriveKey, encrypt, decryptText, decryptBlob, decrypt,
    generateEcdhKeyPair, exportPublicKey, deriveSessionKey,
    getKeyFingerprint, getSessionKey, clearSessionKey, clearAllKeys,
    generateOTK, exportKey, importKey
  };
})();
