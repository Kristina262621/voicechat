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
    // Стандартная светлая тема (День)
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
  } else if (theme === 'dark') {
    // Стандартная тёмная тема (Ночная)
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
  } else if (theme === 'light-beautiful') {
    // Красивая светлая тема (пастельные тона)
    root.style.setProperty('--bg',        '#f9f5ff');
    root.style.setProperty('--bg2',       '#ffffff');
    root.style.setProperty('--surface',   '#ffffff');
    root.style.setProperty('--surface2',  '#f3edff');
    root.style.setProperty('--surface3',  '#e9e0ff');
    root.style.setProperty('--text',      '#2d1b69');
    root.style.setProperty('--text2',     '#5a4b8c');
    root.style.setProperty('--sub',       '#8a7cb0');
    root.style.setProperty('--divider',   'rgba(45,27,105,0.08)');
    root.style.setProperty('--bubble-in', '#ffffff');
    root.style.setProperty('--bubble-me', '#e0d4ff');
    root.style.setProperty('--glass',     'rgba(255,255,255,0.92)');
    root.style.setProperty('--accent',    '#9d7bff');
    root.style.setProperty('--accent2',   '#b59cff');
    root.style.setProperty('--accent-g',  'linear-gradient(135deg,#9d7bff,#7b5bd6)');
    root.style.setProperty('--green',     '#6bcf7f');
    root.style.setProperty('--red',       '#ff6b8b');
    root.style.setProperty('--orange',    '#ffa85c');
  } else if (theme === 'dark-beautiful') {
    // Красивая тёмная тема (глубокий фиолетовый)
    root.style.setProperty('--bg',        '#0f0a1f');
    root.style.setProperty('--bg2',       '#1a1430');
    root.style.setProperty('--surface',   '#221c3c');
    root.style.setProperty('--surface2',  '#2a2448');
    root.style.setProperty('--surface3',  '#342e54');
    root.style.setProperty('--text',      '#e8e0ff');
    root.style.setProperty('--text2',     '#b8a8e8');
    root.style.setProperty('--sub',       '#7a6ca0');
    root.style.setProperty('--divider',   'rgba(232,224,255,0.06)');
    root.style.setProperty('--bubble-in', '#221c3c');
    root.style.setProperty('--bubble-me', '#3d2a6e');
    root.style.setProperty('--glass',     'rgba(34,28,60,0.85)');
    root.style.setProperty('--accent',    '#a07de0');
    root.style.setProperty('--accent2',   '#c0a5ff');
    root.style.setProperty('--accent-g',  'linear-gradient(135deg,#a07de0,#7c5cbf)');
    root.style.setProperty('--green',     '#6bcf7f');
    root.style.setProperty('--red',       '#ff6b8b');
    root.style.setProperty('--orange',    '#ffa85c');
  } else if (theme === 'telegram-dark') {
    // Тёмная тема Telegram (сине-серая)
    root.style.setProperty('--bg',        '#17212b');
    root.style.setProperty('--bg2',       '#232f3d');
    root.style.setProperty('--surface',   '#2b5278');
    root.style.setProperty('--surface2',  '#3a5d82');
    root.style.setProperty('--surface3',  '#4a6b8f');
    root.style.setProperty('--text',      '#ffffff');
    root.style.setProperty('--text2',     '#8f9ba8');
    root.style.setProperty('--sub',       '#6b7b8c');
    root.style.setProperty('--divider',   'rgba(255,255,255,0.08)');
    root.style.setProperty('--bubble-in', '#2b5278');
    root.style.setProperty('--bubble-me', '#2b5278');
    root.style.setProperty('--glass',     'rgba(43,82,120,0.85)');
    root.style.setProperty('--accent',    '#5288c1');
    root.style.setProperty('--accent2',   '#6ba1e0');
    root.style.setProperty('--accent-g',  'linear-gradient(135deg,#5288c1,#3a6ea5)');
    root.style.setProperty('--green',     '#34c759');
    root.style.setProperty('--red',       '#ff3b30');
    root.style.setProperty('--orange',    '#ff9500');
  } else if (theme === 'whatsapp-green') {
    // Светлая тема WhatsApp (зелёная)
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
  } else if (theme === 'blue-dark') {
    // Синяя тёмная тема
    root.style.setProperty('--bg',        '#0d1b2a');
    root.style.setProperty('--bg2',       '#1b263b');
    root.style.setProperty('--surface',   '#415a77');
    root.style.setProperty('--surface2',  '#4a6380');
    root.style.setProperty('--surface3',  '#556b8a');
    root.style.setProperty('--text',      '#e0e1dd');
    root.style.setProperty('--text2',     '#a3b1c2');
    root.style.setProperty('--sub',       '#778da9');
    root.style.setProperty('--divider',   'rgba(224,225,221,0.08)');
    root.style.setProperty('--bubble-in', '#415a77');
    root.style.setProperty('--bubble-me', '#2d4a6e');
    root.style.setProperty('--glass',     'rgba(65,90,119,0.85)');
    root.style.setProperty('--accent',    '#4cc9f0');
    root.style.setProperty('--accent2',   '#6bd4ff');
    root.style.setProperty('--accent-g',  'linear-gradient(135deg,#4cc9f0,#2a9d8f)');
    root.style.setProperty('--green',     '#2a9d8f');
    root.style.setProperty('--red',       '#e63946');
    root.style.setProperty('--orange',    '#f4a261');
  } else if (theme === 'amber') {
    // Янтарная тёплая тема
    root.style.setProperty('--bg',        '#fff8e1');
    root.style.setProperty('--bg2',       '#ffecb3');
    root.style.setProperty('--surface',   '#ffd54f');
    root.style.setProperty('--surface2',  '#ffca28');
    root.style.setProperty('--surface3',  '#ffb300');
    root.style.setProperty('--text',      '#5d4037');
    root.style.setProperty('--text2',     '#8d6e63');
    root.style.setProperty('--sub',       '#a1887f');
    root.style.setProperty('--divider',   'rgba(93,64,55,0.1)');
    root.style.setProperty('--bubble-in', '#ffecb3');
    root.style.setProperty('--bubble-me', '#ffd54f');
    root.style.setProperty('--glass',     'rgba(255,248,225,0.92)');
    root.style.setProperty('--accent',    '#ff9800');
    root.style.setProperty('--accent2',   '#ffb74d');
    root.style.setProperty('--accent-g',  'linear-gradient(135deg,#ff9800,#f57c00)');
    root.style.setProperty('--green',     '#4caf50');
    root.style.setProperty('--red',       '#f44336');
    root.style.setProperty('--orange',    '#ff9800');
  }

  // Обновляем иконки всех кнопок темы
  document.querySelectorAll('#btn-drawer-theme, .theme-toggle-btn').forEach(btn => {
    // Устанавливаем иконку в зависимости от темы
    let icon = '🌙';
    if (theme === 'light') icon = '☀️';
    else if (theme === 'light-beautiful') icon = '✨';
    else if (theme === 'dark-beautiful') icon = '🌟';
    btn.textContent = icon;
    btn.title = theme === 'dark' ? 'Светлая тема' :
                theme === 'light' ? 'Тёмная тема' :
                theme === 'dark-beautiful' ? 'Красивая тёмная' : 'Красивая светлая';
  });

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  let themeColor = '#0a0a0f';
  if (theme === 'light') themeColor = '#f0f2f5';
  else if (theme === 'light-beautiful') themeColor = '#f9f5ff';
  else if (theme === 'dark-beautiful') themeColor = '#0f0a1f';
  if (metaTheme) metaTheme.content = themeColor;
}

function toggleTheme() {
  const themes = ['dark', 'light', 'dark-beautiful', 'light-beautiful', 'telegram-dark', 'whatsapp-green', 'blue-dark', 'amber'];
  const currentIndex = themes.indexOf(currentTheme);
  const nextIndex = (currentIndex + 1) % themes.length;
  applyTheme(themes[nextIndex]);
}

// Применяем сразу
applyTheme(currentTheme);

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
