// ═══════════════════════════════════════════════════════════
//  app.js  —  VoiceChat клиент
// ═══════════════════════════════════════════════════════════

'use strict';

// ── Константы ────────────────────────────────────────────
const API = '';
const STORAGE_TOKEN = 'chat_token';
const STORAGE_USER  = 'chat_user';
const STORAGE_THEME = 'chat_theme';
const MSG_LIMIT     = 50;

// ── Состояние приложения ─────────────────────────────────
let socket        = null;
let currentRoom   = null;
let currentUser   = null;
let authToken     = null;
let cryptoKey     = null;
let mediaStream   = null;
let isMuted       = false;
let peers         = {};          // socketId → RTCPeerConnection
let audioEls      = {};          // socketId → <audio>
let ICE_CONFIG    = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]};

let videoStream       = null;
let videopeers        = {};      // socketId → RTCPeerConnection (video)
let localVideoEl      = null;
let remoteVideoEls    = {};      // socketId → <video>

let typingTimer       = null;
let isTyping          = false;
let replyTo           = null;    // { msgId, username, text }
let editingMsgId      = null;
let messageCache      = {};      // msgId → { el, data }
let reactions         = {};      // msgId → { emoji → Set(userId) }
let loadingHistory    = false;
let allHistoryLoaded  = false;
let oldestMsgDate     = null;
let pinnedMsgId       = null;
let contacts          = [];
let contactRequests   = [];
let rooms             = [];

// ── DOM helpers ──────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (html) e.innerHTML   = html;
  return e;
};

function toast(msg, duration = 3000) {
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, duration);
}

function avatarHtml(avatarUrl, username, size = 36) {
  if (avatarUrl) {
    return `<img src="${avatarUrl}" class="avatar-img" width="${size}" height="${size}"
                 style="border-radius:50%;object-fit:cover" alt="">`;
  }
  const letter = (username || '?')[0].toUpperCase();
  const colors  = ['#5865f2','#eb459e','#57f287','#fee75c','#ed4245','#9b59b6','#e67e22'];
  const color   = colors[(username || '').charCodeAt(0) % colors.length];
  return `<div class="avatar-letter" style="width:${size}px;height:${size}px;
          border-radius:50%;background:${color};display:flex;align-items:center;
          justify-content:center;font-weight:700;font-size:${Math.floor(size*0.45)}px;
          color:#fff;flex-shrink:0">${letter}</div>`;
}

// ── Тема ─────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_THEME, theme);
  const btn = $('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  const saved = localStorage.getItem(STORAGE_THEME);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

// ── Крипто ───────────────────────────────────────────────
async function generateRoomKey(roomName, roomId) {
  const raw = `${roomName}::${roomId}::voicechat_secret_v2`;
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(raw), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('vchat_salt_2024'),
      iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(text) {
  if (!cryptoKey) return { encrypted: text, iv: '' };
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(text)
  );
  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(enc))),
    iv:        btoa(String.fromCharCode(...iv))
  };
}

async function decryptText(encrypted, ivB64) {
  if (!cryptoKey || !ivB64) return encrypted;
  try {
    const iv  = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const enc = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, enc);
    return new TextDecoder().decode(dec);
  } catch { return '🔒 [не удалось расшифровать]'; }
}

async function encryptMeta(obj) {
  const json = JSON.stringify(obj);
  return encryptText(json);
}

async function decryptMeta(enc, iv) {
  if (!enc) return null;
  try {
    const json = await decryptText(enc, iv);
    return JSON.parse(json);
  } catch { return null; }
}

// ── ICE конфиг ───────────────────────────────────────────
async function loadIceConfig() {
  try {
    const r = await fetch(`${API}/api/ice-config`, {
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    const d = await r.json();
    if (d.ok && d.iceServers) {
      ICE_CONFIG = { iceServers: d.iceServers };
      console.log('[ICE] config loaded, servers:', d.iceServers.length);
    }
  } catch(e) {
    console.warn('[ICE] failed to load config, using defaults');
  }
}

// ── Инициализация ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  setupAuthForms();
  setupThemeToggle();

  const token    = localStorage.getItem(STORAGE_TOKEN);
  const username = localStorage.getItem(STORAGE_USER);

  if (token && username) {
    try {
      const r = await fetch(`${API}/api/verify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token })
      });
      const d = await r.json();
      if (d.ok) {
        authToken   = token;
        currentUser = { username: d.username, userId: d.userId, avatar: d.avatar, bio: d.bio };
        await loadIceConfig();
        showApp();
      } else {
        showAuth();
      }
    } catch { showAuth(); }
  } else {
    showAuth();
  }
});

// ── Auth ─────────────────────────────────────────────────
function setupAuthForms() {
  $('form-login')?.addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!username || !password) return toast('⚠️ Заполните все поля');

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/api/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password })
      });
      const d = await r.json();
      if (d.ok) {
        authToken   = d.token;
        currentUser = { username: d.username, userId: d.userId };
        localStorage.setItem(STORAGE_TOKEN, d.token);
        localStorage.setItem(STORAGE_USER,  d.username);
        await loadIceConfig();
        showApp();
      } else {
        const msgs = {
          wrong_credentials: '❌ Неверный логин или пароль',
          rate_limited:      '⏳ Слишком много попыток, подождите',
          missing_fields:    '⚠️ Заполните все поля'
        };
        toast(msgs[d.error] || '❌ Ошибка входа');
      }
    } catch { toast('❌ Ошибка сети'); }
    finally  { btn.disabled = false; }
  });

  $('form-register')?.addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('reg-username').value.trim();
    const password = $('reg-password').value;
    if (!username || !password) return toast('⚠️ Заполните все поля');
    if (username.length < 2)  return toast('⚠️ Имя минимум 2 символа');
    if (password.length < 4)  return toast('⚠️ Пароль минимум 4 символа');

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/api/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password })
      });
      const d = await r.json();
      if (d.ok) {
        authToken   = d.token;
        currentUser = { username: d.username, userId: d.userId };
        localStorage.setItem(STORAGE_TOKEN, d.token);
        localStorage.setItem(STORAGE_USER,  d.username);
        await loadIceConfig();
        showApp();
      } else {
        const msgs = {
          username_taken:  '❌ Имя уже занято',
          username_length: '⚠️ Имя от 2 до 24 символов',
          password_short:  '⚠️ Пароль минимум 4 символа',
          rate_limited:    '⏳ Слишком много попыток'
        };
        toast(msgs[d.error] || '❌ Ошибка регистрации');
      }
    } catch { toast('❌ Ошибка сети'); }
    finally  { btn.disabled = false; }
  });

  $('link-to-register')?.addEventListener('click', e => {
    e.preventDefault();
    $('auth-login').style.display    = 'none';
    $('auth-register').style.display = 'block';
  });

  $('link-to-login')?.addEventListener('click', e => {
    e.preventDefault();
    $('auth-register').style.display = 'none';
    $('auth-login').style.display    = 'block';
  });
}

function setupThemeToggle() {
  $('btn-theme')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
}

function showAuth() {
  $('auth-screen').style.display = 'flex';
  $('app-screen').style.display  = 'none';
}

function showApp() {
  $('auth-screen').style.display = 'none';
  $('app-screen').style.display  = 'flex';
  initApp();
}

// ── Главный экран ────────────────────────────────────────
async function initApp() {
  updateProfileUI();
  setupSidebar();
  setupProfileModal();
  setupCreateRoom();
  setupVoiceButtons();
  setupChatInput();
  setupMessageSearch();
  await loadRooms();
  await loadContacts();
  connectSocket();
}

function updateProfileUI() {
  const nameEl   = $('profile-username');
  const avatarEl = $('profile-avatar');
  if (nameEl)   nameEl.textContent = currentUser?.username || '';
  if (avatarEl) avatarEl.innerHTML = avatarHtml(currentUser?.avatar, currentUser?.username, 36);
}

// ── Sidebar ──────────────────────────────────────────────
function setupSidebar() {
  $('btn-logout')?.addEventListener('click', () => {
    if (!confirm('Выйти из аккаунта?')) return;
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_USER);
    disconnectSocket();
    location.reload();
  });

  $('btn-show-contacts')?.addEventListener('click', () => {
    showPanel('contacts-panel');
  });

  $('btn-show-rooms')?.addEventListener('click', () => {
    showPanel('rooms-panel');
  });

  $('btn-theme')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
}

function showPanel(panelId) {
  ['rooms-panel','contacts-panel'].forEach(id => {
    const p = $(id);
    if (p) p.style.display = id === panelId ? 'flex' : 'none';
  });
}
// ── Комнаты ──────────────────────────────────────────────
async function loadRooms() {
  try {
    const r = await fetch(`${API}/api/rooms`, {
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    const d = await r.json();
    if (!d.ok) return;
    rooms = d.rooms;
    renderRoomList(rooms);
  } catch(e) { console.error('[loadRooms]', e); }
}

function renderRoomList(list) {
  const container = $('room-list');
  if (!container) return;
  container.innerHTML = '';

  if (!list.length) {
    container.innerHTML = '<div class="empty-hint">Нет доступных комнат</div>';
    return;
  }

  list.forEach(room => {
    const div = el('div', 'room-item');
    div.dataset.roomId = room.id;

    const lockIcon  = room.has_password ? '🔒 ' : '';
    const groupIcon = room.is_group ? '👥 ' : '';
    const privIcon  = room.is_private ? '🔐 ' : '';

    div.innerHTML = `
      <div class="room-avatar">${avatarHtml(room.avatar, room.name, 40)}</div>
      <div class="room-info">
        <div class="room-name">${lockIcon}${groupIcon}${privIcon}${escHtml(room.name)}</div>
        <div class="room-owner">Создал: ${escHtml(room.owner)}</div>
      </div>
    `;

    div.addEventListener('click', () => joinRoom(room));
    container.appendChild(div);
  });
}

function setupCreateRoom() {
  const btn  = $('btn-create-room');
  const form = $('create-room-form');
  const cancel = $('btn-cancel-create');

  btn?.addEventListener('click', () => {
    if (form) form.style.display = form.style.display === 'none' ? 'flex' : 'none';
  });

  cancel?.addEventListener('click', () => {
    if (form) form.style.display = 'none';
  });

  $('form-create-room')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name     = $('new-room-name').value.trim();
    const password = $('new-room-pass').value;
    const isGroup  = $('new-room-group')?.checked || false;

    if (!name) return toast('⚠️ Введите название комнаты');
    if (name.length < 2 || name.length > 64) return toast('⚠️ Название от 2 до 64 символов');

    const submitBtn = e.target.querySelector('button[type=submit]');
    submitBtn.disabled = true;

    try {
      const r = await fetch(`${API}/api/rooms`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ name, password, isGroup })
      });
      const d = await r.json();
      if (d.ok) {
        toast('✅ Комната создана');
        $('new-room-name').value = '';
        $('new-room-pass').value = '';
        if ($('new-room-group')) $('new-room-group').checked = false;
        if (form) form.style.display = 'none';
        await loadRooms();
      } else {
        const msgs = {
          room_exists:  '❌ Комната с таким названием уже существует',
          invalid_name: '⚠️ Недопустимое название'
        };
        toast(msgs[d.error] || '❌ Ошибка создания комнаты');
      }
    } catch { toast('❌ Ошибка сети'); }
    finally  { submitBtn.disabled = false; }
  });

  $('room-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    const filtered = rooms.filter(r => r.name.toLowerCase().includes(q));
    renderRoomList(filtered);
  });
}

async function joinRoom(room) {
  if (room.is_private) {
    const member = await checkMembership(room.id);
    if (!member) {
      toast('🔐 Это приватный чат');
      return;
    }
  }

  if (room.has_password && !room.is_private) {
    const alreadyMember = await checkMembership(room.id);
    if (!alreadyMember) {
      const password = prompt(`🔒 Комната "${room.name}" защищена паролем:`);
      if (password === null) return;
      try {
        const r = await fetch(`${API}/api/rooms/${room.id}/join`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + authToken
          },
          body: JSON.stringify({ password })
        });
        const d = await r.json();
        if (!d.ok) {
          toast(d.error === 'wrong_password' ? '❌ Неверный пароль' : '❌ Ошибка входа');
          return;
        }
        room = d.room;
      } catch { toast('❌ Ошибка сети'); return; }
    }
  } else if (!room.is_private && !room.has_password) {
    try {
      const r = await fetch(`${API}/api/rooms/${room.id}/join`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({})
      });
      const d = await r.json();
      if (d.ok && d.room) room = d.room;
    } catch {}
  }

  enterRoom(room);
}

async function checkMembership(roomId) {
  try {
    const r = await fetch(`${API}/api/rooms/${roomId}/join`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + authToken
      },
      body: JSON.stringify({})
    });
    const d = await r.json();
    return d.ok;
  } catch { return false; }
}

async function enterRoom(room) {
  if (currentRoom && currentRoom.id === room.id) return;

  if (currentRoom) {
    leaveCurrentRoom();
  }

  currentRoom = room;
  messageCache   = {};
  reactions      = {};
  replyTo        = null;
  editingMsgId   = null;
  allHistoryLoaded = false;
  oldestMsgDate  = null;
  pinnedMsgId    = null;

  cryptoKey = await generateRoomKey(room.name, room.id);

  const chatArea = $('chat-area');
  if (chatArea) chatArea.style.display = 'flex';

  const roomTitle = $('current-room-name');
  if (roomTitle) roomTitle.textContent = room.name;

  const msgList = $('message-list');
  if (msgList) msgList.innerHTML = '';

  hidePinnedBanner();

  if (socket && socket.connected) {
    socket.emit('join-room', { roomId: room.id, token: authToken });
  }

  updateRoomItemActive(room.id);
  highlightActiveRoom(room.id);
}

function leaveCurrentRoom() {
  if (!currentRoom) return;
  if (socket) socket.emit('leave');
  stopVoice();
  stopVideo();
  currentRoom = null;
  messageCache = {};
  reactions = {};
  replyTo = null;
  editingMsgId = null;
  cryptoKey = null;
  const chatArea = $('chat-area');
  if (chatArea) chatArea.style.display = 'none';
}

function updateRoomItemActive(roomId) {
  document.querySelectorAll('.room-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.roomId) === parseInt(roomId));
  });
}

function highlightActiveRoom(roomId) {
  document.querySelectorAll('.contact-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.roomId) === parseInt(roomId));
  });
}

// ── Контакты ─────────────────────────────────────────────
async function loadContacts() {
  try {
    const [cr, rr] = await Promise.all([
      fetch(`${API}/api/contacts`, { headers: { 'Authorization': 'Bearer ' + authToken } }),
      fetch(`${API}/api/contacts/requests`, { headers: { 'Authorization': 'Bearer ' + authToken } })
    ]);
    const cd = await cr.json();
    const rd = await rr.json();
    if (cd.ok) contacts = cd.contacts;
    if (rd.ok) contactRequests = rd.requests;
    renderContacts();
    renderContactRequests();
  } catch(e) { console.error('[loadContacts]', e); }
}

function renderContacts() {
  const list = $('contacts-list');
  if (!list) return;
  list.innerHTML = '';

  if (!contacts.length) {
    list.innerHTML = '<div class="empty-hint">Нет контактов</div>';
    return;
  }

  contacts.forEach(c => {
    const div = el('div', 'contact-item');
    div.innerHTML = `
      <div class="contact-avatar">${avatarHtml(c.avatar, c.username, 38)}</div>
      <div class="contact-info">
        <div class="contact-name">${escHtml(c.username)}</div>
        ${c.bio ? `<div class="contact-bio">${escHtml(c.bio)}</div>` : ''}
      </div>
      <button class="btn-icon btn-chat-private" title="Написать" data-uid="${c.id}">💬</button>
    `;
    div.querySelector('.btn-chat-private').addEventListener('click', async (e) => {
      e.stopPropagation();
      await openPrivateChat(c.id);
    });
    list.appendChild(div);
  });
}

function renderContactRequests() {
  const list = $('contact-requests-list');
  if (!list) return;
  list.innerHTML = '';

  if (!contactRequests.length) {
    const badge = $('requests-badge');
    if (badge) badge.style.display = 'none';
    return;
  }

  const badge = $('requests-badge');
  if (badge) {
    badge.textContent = contactRequests.length;
    badge.style.display = 'inline-block';
  }

  contactRequests.forEach(c => {
    const div = el('div', 'request-item');
    div.innerHTML = `
      <div class="contact-avatar">${avatarHtml(c.avatar, c.username, 36)}</div>
      <div class="contact-info">
        <div class="contact-name">${escHtml(c.username)}</div>
      </div>
      <button class="btn-accept" data-uid="${c.id}">✅</button>
      <button class="btn-decline" data-uid="${c.id}">❌</button>
    `;
    div.querySelector('.btn-accept').addEventListener('click', () => respondRequest(c.id, true));
    div.querySelector('.btn-decline').addEventListener('click', () => respondRequest(c.id, false));
    list.appendChild(div);
  });
}

async function respondRequest(userId, accept) {
  try {
    await fetch(`${API}/api/contacts/requests/respond`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + authToken
      },
      body: JSON.stringify({ id: userId, accept })
    });
    toast(accept ? '✅ Контакт добавлен' : '❌ Заявка отклонена');
    await loadContacts();
  } catch { toast('❌ Ошибка'); }
}

async function openPrivateChat(userId) {
  try {
    const r = await fetch(`${API}/api/chats/private`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + authToken
      },
      body: JSON.stringify({ userId })
    });
    const d = await r.json();
    if (d.ok) {
      enterRoom(d.room);
      showPanel('rooms-panel');
    } else {
      toast('❌ Не удалось открыть чат');
    }
  } catch { toast('❌ Ошибка сети'); }
}

// ── Профиль ──────────────────────────────────────────────
function setupProfileModal() {
  const btn   = $('btn-edit-profile');
  const modal = $('profile-modal');
  const close = $('btn-close-profile');
  const form  = $('form-profile');

  btn?.addEventListener('click', async () => {
    const r = await fetch(`${API}/api/me`, {
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    const d = await r.json();
    if (d.ok) {
      currentUser = { ...currentUser, ...d.user };
      $('profile-bio-input').value = d.user.bio || '';
      $('profile-avatar-preview').innerHTML = avatarHtml(d.user.avatar, d.user.username, 64);
    }
    modal.style.display = 'flex';
  });

  close?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal?.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  $('profile-avatar-input')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('⚠️ Только изображения');
    if (file.size > 512 * 1024) return toast('⚠️ Максимум 512 КБ');
    const reader = new FileReader();
    reader.onload = ev => {
      $('profile-avatar-preview').innerHTML = `<img src="${ev.target.result}"
        style="width:64px;height:64px;border-radius:50%;object-fit:cover">`;
      $('profile-avatar-preview').dataset.dataUrl = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const bio    = $('profile-bio-input').value;
    const avatar = $('profile-avatar-preview').dataset.dataUrl || null;
    const btn    = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/api/me`, {
        method:  'PUT',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ bio, avatar })
      });
      const d = await r.json();
      if (d.ok) {
        if (avatar) currentUser.avatar = avatar;
        currentUser.bio = bio;
        updateProfileUI();
        modal.style.display = 'none';
        toast('✅ Профиль сохранён');
      } else {
        toast(d.error === 'invalid_avatar' ? '⚠️ Недопустимый аватар' : '❌ Ошибка сохранения');
      }
    } catch { toast('❌ Ошибка сети'); }
    finally  { btn.disabled = false; }
  });
}

// ── Утилиты сообщений ────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

function linkify(text) {
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  return escHtml(text).replace(urlRegex, url =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function setupMessageSearch() {
  const input = $('msg-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    document.querySelectorAll('.message-item').forEach(el => {
      const text = el.querySelector('.msg-text')?.textContent?.toLowerCase() || '';
      el.style.display = !q || text.includes(q) ? '' : 'none';
    });
  });
}
// ── Рендер сообщений ─────────────────────────────────────
async function renderMessage(data, prepend = false) {
  const msgList = $('message-list');
  if (!msgList) return;

  const isOwn = data.user_id === currentUser?.userId ||
                data.userId  === currentUser?.userId;

  let text = '';
  if (data.deleted) {
    text = '🗑 Сообщение удалено';
  } else if (data.type === 'text' || data.type === 'reply') {
    text = await decryptText(data.encrypted, data.iv);
  }

  let meta = null;
  if (!data.deleted && data.meta_enc && data.meta_iv) {
    meta = await decryptMeta(data.meta_enc, data.meta_iv);
  } else if (!data.deleted && data.metaEnc && data.metaIv) {
    meta = await decryptMeta(data.metaEnc, data.metaIv);
  }

  const msgId    = data.msg_id || data.msgId;
  const username = data.username || 'Участник';
  const avatar   = data.avatar   || null;
  const ts       = data.created_at || data.timestamp;
  const edited   = data.edited_at  || data.editedAt;

  const div = el('div', `message-item ${isOwn ? 'own' : 'other'}`);
  div.dataset.msgId = msgId;

  // reply block
  let replyHtml = '';
  if (meta?.replyTo && !data.deleted) {
    replyHtml = `
      <div class="reply-block" data-reply-id="${escHtml(meta.replyTo.msgId)}">
        <span class="reply-author">${escHtml(meta.replyTo.username)}</span>
        <span class="reply-text">${escHtml((meta.replyTo.text || '').slice(0, 80))}</span>
      </div>`;
  }

  // file block
  let fileHtml = '';
  if ((data.type === 'file' || data.type === 'image') && !data.deleted) {
    const fname = data.file_name || data.fileName || 'файл';
    const fsize = data.file_size || data.fileSize || 0;
    const mime  = data.mime_type || data.mimeType || '';

    if (mime.startsWith('image/') && data.encrypted) {
      fileHtml = `<div class="msg-image-wrap">
        <img class="msg-image lazy-decrypt"
             data-encrypted="${escHtml(data.encrypted)}"
             data-iv="${escHtml(data.iv)}"
             src="" alt="${escHtml(fname)}"
             style="max-width:260px;max-height:200px;border-radius:8px;cursor:pointer">
      </div>`;
    } else if (mime.startsWith('audio/') && data.encrypted) {
      fileHtml = `<div class="msg-audio">
        <audio class="lazy-decrypt-audio" controls
               data-encrypted="${escHtml(data.encrypted)}"
               data-iv="${escHtml(data.iv)}"
               data-mime="${escHtml(mime)}"></audio>
      </div>`;
    } else if (mime.startsWith('video/') && data.encrypted) {
      fileHtml = `<div class="msg-video">
        <video class="lazy-decrypt-video" controls
               data-encrypted="${escHtml(data.encrypted)}"
               data-iv="${escHtml(data.iv)}"
               data-mime="${escHtml(mime)}"
               style="max-width:260px;border-radius:8px"></video>
      </div>`;
    } else {
      fileHtml = `<div class="msg-file">
        <span class="file-icon">📎</span>
        <span class="file-name">${escHtml(fname)}</span>
        <span class="file-size">${formatBytes(fsize)}</span>
        <button class="btn-download-file"
                data-encrypted="${escHtml(data.encrypted)}"
                data-iv="${escHtml(data.iv)}"
                data-fname="${escHtml(fname)}"
                data-mime="${escHtml(mime)}">⬇️</button>
      </div>`;
    }
  }

  // text content
  let textHtml = '';
  if (!data.deleted && text && data.type !== 'file' && data.type !== 'image') {
    textHtml = `<div class="msg-text">${linkify(text)}</div>`;
  } else if (data.deleted) {
    textHtml = `<div class="msg-text deleted-msg">${escHtml(text)}</div>`;
  }

  // reactions
  const msgReactions = reactions[msgId] || {};
  let reactHtml = renderReactionsHtml(msgId, msgReactions);

  // context menu button
  const menuBtn = data.deleted ? '' :
    `<button class="btn-msg-menu" data-msgid="${escHtml(msgId)}" title="Действия">⋯</button>`;

  div.innerHTML = `
    <div class="msg-avatar">${avatarHtml(avatar, username, 32)}</div>
    <div class="msg-body">
      <div class="msg-header">
        <span class="msg-author">${escHtml(username)}</span>
        <span class="msg-time">${formatTime(ts)}</span>
        ${edited ? '<span class="msg-edited">ред.</span>' : ''}
        ${menuBtn}
      </div>
      ${replyHtml}
      ${fileHtml}
      ${textHtml}
      <div class="msg-reactions" data-msgid="${escHtml(msgId)}">${reactHtml}</div>
    </div>
  `;

  // lazy decrypt images
  div.querySelectorAll('.lazy-decrypt').forEach(img => {
    decryptBlob(img.dataset.encrypted, img.dataset.iv, 'image/jpeg').then(url => {
      if (url) {
        img.src = url;
        img.addEventListener('click', () => openLightbox(url));
      }
    });
  });

  // lazy decrypt audio
  div.querySelectorAll('.lazy-decrypt-audio').forEach(audio => {
    decryptBlob(audio.dataset.encrypted, audio.dataset.iv, audio.dataset.mime).then(url => {
      if (url) audio.src = url;
    });
  });

  // lazy decrypt video
  div.querySelectorAll('.lazy-decrypt-video').forEach(video => {
    decryptBlob(video.dataset.encrypted, video.dataset.iv, video.dataset.mime).then(url => {
      if (url) video.src = url;
    });
  });

  // download file button
  div.querySelectorAll('.btn-download-file').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = await decryptBlob(btn.dataset.encrypted, btn.dataset.iv, btn.dataset.mime);
      if (url) {
        const a = document.createElement('a');
        a.href = url; a.download = btn.dataset.fname;
        a.click();
      }
    });
  });

  // context menu
  div.querySelectorAll('.btn-msg-menu').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      showMessageMenu(e, msgId, isOwn, text);
    });
  });

  // reply click
  div.querySelectorAll('.reply-block').forEach(rb => {
    rb.addEventListener('click', () => {
      scrollToMessage(rb.dataset.replyId);
    });
  });

  messageCache[msgId] = { el: div, data: { ...data, decryptedText: text } };

  if (prepend) {
    msgList.insertBefore(div, msgList.firstChild);
  } else {
    msgList.appendChild(div);
    scrollToBottom();
  }
}

function renderReactionsHtml(msgId, msgReactions) {
  let html = '';
  for (const [emoji, users] of Object.entries(msgReactions)) {
    if (!users || users.size === 0) continue;
    const hasMe = users.has(currentUser?.userId);
    html += `<button class="reaction-btn ${hasMe ? 'reacted' : ''}"
               data-msgid="${escHtml(msgId)}" data-emoji="${escHtml(emoji)}">
               ${emoji} <span>${users.size}</span>
             </button>`;
  }
  return html;
}

function updateReactionsEl(msgId) {
  const el = document.querySelector(`.msg-reactions[data-msgid="${msgId}"]`);
  if (!el) return;
  el.innerHTML = renderReactionsHtml(msgId, reactions[msgId] || {});
  el.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket?.emit('reaction-toggle', { msgId: btn.dataset.msgid, emoji: btn.dataset.emoji });
      toggleReactionLocal(btn.dataset.msgid, btn.dataset.emoji, currentUser.userId);
      updateReactionsEl(btn.dataset.msgid);
    });
  });
}

function toggleReactionLocal(msgId, emoji, userId) {
  if (!reactions[msgId]) reactions[msgId] = {};
  if (!reactions[msgId][emoji]) reactions[msgId][emoji] = new Set();
  const set = reactions[msgId][emoji];
  if (set.has(userId)) set.delete(userId);
  else set.add(userId);
}

async function decryptBlob(encrypted, iv, mime) {
  if (!cryptoKey || !encrypted || !iv) return null;
  try {
    const ivBytes  = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
    const encBytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, cryptoKey, encBytes);
    const blob = new Blob([dec], { type: mime });
    return URL.createObjectURL(blob);
  } catch { return null; }
}

function openLightbox(url) {
  const overlay = el('div', 'lightbox-overlay');
  overlay.innerHTML = `<img src="${url}" class="lightbox-img">
    <button class="lightbox-close">✕</button>`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function scrollToBottom() {
  const list = $('message-list');
  if (list) list.scrollTop = list.scrollHeight;
}

function scrollToMessage(msgId) {
  const cached = messageCache[msgId];
  if (cached?.el) {
    cached.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    cached.el.classList.add('highlight');
    setTimeout(() => cached.el.classList.remove('highlight'), 1500);
  }
}

// ── Контекстное меню сообщений ───────────────────────────
function showMessageMenu(e, msgId, isOwn, text) {
  document.querySelectorAll('.msg-context-menu').forEach(m => m.remove());

  const menu = el('div', 'msg-context-menu');

  const actions = [
    { label: '↩️ Ответить',   fn: () => setReply(msgId, text) },
    { label: '😀 Реакция',    fn: () => showEmojiPicker(msgId) }
  ];

  if (isOwn) {
    actions.push({ label: '✏️ Редактировать', fn: () => startEdit(msgId, text) });
    actions.push({ label: '🗑 Удалить',        fn: () => deleteMessage(msgId) });
  }

  if (currentRoom?.owner_id === currentUser?.userId) {
    actions.push({ label: '📌 Закрепить', fn: () => pinMessage(msgId) });
  }

  actions.forEach(a => {
    const btn = el('button', 'ctx-menu-item', a.label);
    btn.addEventListener('click', () => { a.fn(); menu.remove(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  const x = Math.min(e.clientX, window.innerWidth  - 180);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 50);
}

function showEmojiPicker(msgId) {
  document.querySelectorAll('.emoji-picker-popup').forEach(p => p.remove());
  const emojis = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','😡','💯'];
  const picker = el('div', 'emoji-picker-popup');
  emojis.forEach(emoji => {
    const btn = el('button', 'emoji-pick-btn', emoji);
    btn.addEventListener('click', () => {
      socket?.emit('reaction-toggle', { msgId, emoji });
      toggleReactionLocal(msgId, emoji, currentUser.userId);
      updateReactionsEl(msgId);
      picker.remove();
    });
    picker.appendChild(btn);
  });
  document.body.appendChild(picker);
  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 50);
}

function setReply(msgId, text) {
  replyTo = {
    msgId,
    username: messageCache[msgId]?.data?.username || '',
    text:     (text || '').slice(0, 80)
  };
  const bar = $('reply-bar');
  if (bar) {
    bar.style.display = 'flex';
    const info = bar.querySelector('.reply-info');
    if (info) info.textContent = `↩️ ${replyTo.username}: ${replyTo.text}`;
  }
  $('chat-input')?.focus();
}

function clearReply() {
  replyTo = null;
  const bar = $('reply-bar');
  if (bar) bar.style.display = 'none';
}

function startEdit(msgId, text) {
  editingMsgId = msgId;
  const input = $('chat-input');
  if (input) {
    input.value = text || '';
    input.focus();
  }
  const bar = $('edit-bar');
  if (bar) {
    bar.style.display = 'flex';
    const info = bar.querySelector('.edit-info');
    if (info) info.textContent = '✏️ Редактирование сообщения';
  }
}

function cancelEdit() {
  editingMsgId = null;
  const input = $('chat-input');
  if (input) input.value = '';
  const bar = $('edit-bar');
  if (bar) bar.style.display = 'none';
}

async function deleteMessage(msgId) {
  if (!confirm('Удалить сообщение?')) return;
  socket?.emit('message-delete', { msgId });
  applyDeleteLocal(msgId);
}

function applyDeleteLocal(msgId) {
  const cached = messageCache[msgId];
  if (!cached) return;
  const textEl = cached.el.querySelector('.msg-text');
  if (textEl) {
    textEl.textContent = '🗑 Сообщение удалено';
    textEl.classList.add('deleted-msg');
  }
  cached.el.querySelector('.btn-msg-menu')?.remove();
}

function pinMessage(msgId) {
  socket?.emit('pin-message', { msgId });
}

function showPinnedBanner(msgId) {
  pinnedMsgId = msgId;
  const banner = $('pinned-banner');
  if (!banner) return;
  if (!msgId) { hidePinnedBanner(); return; }
  banner.style.display = 'flex';
  const cached = messageCache[msgId];
  const preview = banner.querySelector('.pinned-preview');
  if (preview) {
    preview.textContent = cached?.data?.decryptedText
      ? '📌 ' + cached.data.decryptedText.slice(0, 60)
      : '📌 Закреплённое сообщение';
  }
  banner.onclick = () => scrollToMessage(msgId);
  const unpinBtn = banner.querySelector('.btn-unpin');
  if (unpinBtn) {
    unpinBtn.onclick = e => {
      e.stopPropagation();
      socket?.emit('unpin-message');
    };
  }
}

function hidePinnedBanner() {
  pinnedMsgId = null;
  const banner = $('pinned-banner');
  if (banner) banner.style.display = 'none';
}

// ── Ввод сообщений ───────────────────────────────────────
function setupChatInput() {
  const input   = $('chat-input');
  const sendBtn = $('btn-send');
  const fileBtn = $('btn-attach-file');
  const fileInput = $('file-input');

  $('btn-cancel-reply')?.addEventListener('click', clearReply);
  $('btn-cancel-edit')?.addEventListener('click',  cancelEdit);

  sendBtn?.addEventListener('click', sendMessage);

  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (editingMsgId) sendEdit();
      else sendMessage();
    }
  });

  input?.addEventListener('input', () => {
    if (!socket || !currentRoom) return;
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing', { isTyping: true });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      isTyping = false;
      socket.emit('typing', { isTyping: false });
    }, 2000);
  });

  fileBtn?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    fileInput.value = '';
    await sendFile(file);
  });

  $('btn-emoji')?.addEventListener('click', e => {
    e.stopPropagation();
    showChatEmojiPicker();
  });

  setupInfiniteScroll();
}

async function sendMessage() {
  const input = $('chat-input');
  const text  = input?.value.trim();
  if (!text || !socket || !currentRoom) return;

  if (editingMsgId) { sendEdit(); return; }

  input.value = '';

  const { encrypted, iv } = await encryptText(text);
  const msgId = crypto.randomUUID ? crypto.randomUUID() :
    crypto.randomBytes ? crypto.randomBytes(12).toString('hex') :
    Math.random().toString(36).slice(2);

  let metaEnc = null, metaIv = null;
  if (replyTo) {
    const m = await encryptMeta({ replyTo });
    metaEnc = m.encrypted;
    metaIv  = m.iv;
  }

  const payload = {
    msgId, type: replyTo ? 'reply' : 'text',
    encrypted, iv, metaEnc, metaIv
  };

  socket.emit('chat-message', payload);

  await renderMessage({
    msg_id:    msgId,
    type:      payload.type,
    encrypted, iv,
    meta_enc:  metaEnc,
    meta_iv:   metaIv,
    username:  currentUser.username,
    avatar:    currentUser.avatar,
    user_id:   currentUser.userId,
    timestamp: Date.now()
  });

  clearReply();
  isTyping = false;
  socket.emit('typing', { isTyping: false });
}

async function sendEdit() {
  const input = $('chat-input');
  const text  = input?.value.trim();
  if (!text || !editingMsgId || !socket) return;

  const { encrypted, iv } = await encryptText(text);

  socket.emit('message-edit', {
    msgId: editingMsgId, encrypted, iv
  });

  const cached = messageCache[editingMsgId];
  if (cached) {
    const textEl = cached.el.querySelector('.msg-text');
    if (textEl) textEl.innerHTML = linkify(text);
    const hdr = cached.el.querySelector('.msg-header');
    if (hdr && !hdr.querySelector('.msg-edited')) {
      const span = el('span', 'msg-edited', 'ред.');
      hdr.appendChild(span);
    }
    cached.data.decryptedText = text;
  }

  cancelEdit();
}

async function sendFile(file) {
  if (!socket || !currentRoom) return;
  const MAX = 20 * 1024 * 1024;
  if (file.size > MAX) return toast('⚠️ Максимум 20 МБ');

  toast('📤 Отправка файла...');

  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const arrayBuf = ev.target.result;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, cryptoKey, arrayBuf
      );
      const encrypted = btoa(String.fromCharCode(...new Uint8Array(enc)));
      const ivB64     = btoa(String.fromCharCode(...iv));

      const isImage = file.type.startsWith('image/');
      const msgId   = (crypto.randomUUID ? crypto.randomUUID() :
        Math.random().toString(36).slice(2));

      const payload = {
        msgId,
        type:      isImage ? 'image' : 'file',
        encrypted, iv: ivB64,
        fileName:  file.name,
        fileSize:  file.size,
        mimeType:  file.type
      };

      socket.emit('chat-message', payload);

      await renderMessage({
        msg_id:    msgId,
        type:      payload.type,
        encrypted, iv: ivB64,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        username:  currentUser.username,
        avatar:    currentUser.avatar,
        user_id:   currentUser.userId,
        timestamp: Date.now()
      });
    } catch(e) {
      console.error('[sendFile]', e);
      toast('❌ Ошибка отправки файла');
    }
  };
  reader.readAsArrayBuffer(file);
}

function showChatEmojiPicker() {
  document.querySelectorAll('.chat-emoji-popup').forEach(p => p.remove());
  const emojis = ['😀','😂','😍','🤔','😢','😡','👍','👎',
                  '❤️','🔥','🎉','✨','😎','🤣','🥰','😱'];
  const picker = el('div', 'chat-emoji-popup');
  emojis.forEach(emoji => {
    const btn = el('button', 'emoji-pick-btn', emoji);
    btn.addEventListener('click', () => {
      const input = $('chat-input');
      if (input) { input.value += emoji; input.focus(); }
      picker.remove();
    });
    picker.appendChild(btn);
  });
  const wrap = $('chat-input-wrap') || document.body;
  wrap.appendChild(picker);
  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 50);
}

function setupInfiniteScroll() {
  const list = $('message-list');
  if (!list) return;
  list.addEventListener('scroll', async () => {
    if (list.scrollTop < 60 && !loadingHistory && !allHistoryLoaded && currentRoom) {
      await loadMoreHistory();
    }
  });
}

async function loadMoreHistory() {
  if (!currentRoom || loadingHistory || allHistoryLoaded) return;
  loadingHistory = true;
  try {
    const before = oldestMsgDate ? `&before=${encodeURIComponent(oldestMsgDate)}` : '';
    const r = await fetch(
      `${API}/api/rooms/${currentRoom.id}/history?limit=30${before}`,
      { headers: { 'Authorization': 'Bearer ' + authToken } }
    );
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok || !d.messages?.length) { allHistoryLoaded = true; return; }
    if (d.messages.length < 30) allHistoryLoaded = true;
    const list = $('message-list');
    const prevH = list?.scrollHeight || 0;
    for (const msg of d.messages) {
      await renderMessage(msg, true);
    }
    oldestMsgDate = d.messages[0]?.created_at;
    if (list) list.scrollTop = list.scrollHeight - prevH;
  } catch(e) { console.error('[loadMoreHistory]', e); }
  finally { loadingHistory = false; }
}
// ── Socket.io ────────────────────────────────────────────
function connectSocket() {
  if (socket) socket.disconnect();

  socket = io({
    path:               '/socket.io',
    transports:         ['websocket', 'polling'],
    reconnectionAttempts: 10,
    reconnectionDelay:  2000,
    timeout:            20000
  });

  socket.on('connect', () => {
    console.log('[socket] connected:', socket.id);
    if (currentRoom) {
      socket.emit('join-room', { roomId: currentRoom.id, token: authToken });
    }
  });

  socket.on('disconnect', reason => {
    console.log('[socket] disconnected:', reason);
    toast('⚠️ Соединение прервано, переподключение...');
  });

  socket.on('reconnect', () => {
    toast('✅ Соединение восстановлено');
    if (currentRoom) {
      socket.emit('join-room', { roomId: currentRoom.id, token: authToken });
    }
  });

  socket.on('auth-fail', () => {
    toast('❌ Ошибка авторизации');
  });

  socket.on('auth-ok', ({ username }) => {
    console.log('[socket] auth ok:', username);
  });

  socket.on('existing-users', users => {
    peers = {};
    users.forEach(u => {
      createPeerConnection(u.socketId, true);
    });
    updateUserList(users);
  });

  socket.on('room-history', async ({ messages, pinned }) => {
    const list = $('message-list');
    if (list) list.innerHTML = '';
    messageCache = {};
    reactions   = {};

    if (messages.length < MSG_LIMIT) allHistoryLoaded = true;
    if (messages.length > 0) oldestMsgDate = messages[0].created_at;

    for (const msg of messages) {
      await renderMessage(msg);
    }

    if (pinned) showPinnedBanner(pinned);
    scrollToBottom();
  });

  socket.on('user-joined', ({ socketId, username, avatar, userId }) => {
    toast(`👤 ${username} вошёл в комнату`);
    addUserToList({ socketId, username, avatar, userId });
    if (mediaStream) {
      createPeerConnection(socketId, true);
    }
  });

  socket.on('user-left', ({ socketId }) => {
    const meta = getUserMeta(socketId);
    if (meta) toast(`👋 ${meta.username} покинул комнату`);
    removeUserFromList(socketId);
    closePeer(socketId);
    closeVideoPeer(socketId);
  });

  socket.on('user-count', count => {
    const el = $('user-count');
    if (el) el.textContent = count + ' онлайн';
  });

  socket.on('chat-message', async data => {
    await renderMessage(data);
  });

  socket.on('message-edit', async ({ msgId, encrypted, iv, metaEnc, metaIv, editedAt }) => {
    const cached = messageCache[msgId];
    if (!cached) return;
    const newText = await decryptText(encrypted, iv);
    const textEl  = cached.el.querySelector('.msg-text');
    if (textEl) textEl.innerHTML = linkify(newText);
    const hdr = cached.el.querySelector('.msg-header');
    if (hdr && !hdr.querySelector('.msg-edited')) {
      hdr.appendChild(el('span', 'msg-edited', 'ред.'));
    }
    cached.data.decryptedText = newText;
  });

  socket.on('message-delete', ({ msgId }) => {
    applyDeleteLocal(msgId);
  });

  socket.on('reaction-toggle', ({ msgId, emoji, userId }) => {
    toggleReactionLocal(msgId, emoji, userId);
    updateReactionsEl(msgId);
  });

  socket.on('room-pinned', ({ msgId }) => {
    if (msgId) showPinnedBanner(msgId);
    else hidePinnedBanner();
  });

  socket.on('typing', ({ userId, username, isTyping }) => {
    if (userId === currentUser?.userId) return;
    showTypingIndicator(username, isTyping);
  });

  // ── WebRTC voice ──────────────────────────────────────
  socket.on('offer', async ({ from, offer }) => {
    if (!mediaStream) return;
    const pc = createPeerConnection(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer });
  });

  socket.on('answer', async ({ from, answer }) => {
    const pc = peers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const pc = peers[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    }
  });

  // ── WebRTC video ──────────────────────────────────────
  socket.on('video-offer', async ({ from, offer }) => {
    if (!videoStream) return;
    const pc = createVideoPeer(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('video-answer', { to: from, answer });
  });

  socket.on('video-answer', async ({ from, answer }) => {
    const pc = videopeers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('video-ice', async ({ from, candidate }) => {
    const pc = videopeers[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    }
  });

  socket.on('video-start', ({ from, username }) => {
    toast(`📹 ${username} включил видео`);
  });

  socket.on('video-stop', ({ from }) => {
    closeVideoPeer(from);
    const v = remoteVideoEls[from];
    if (v) { v.remove(); delete remoteVideoEls[from]; }
  });

  socket.on('understood', ({ username }) => {
    toast(`✅ ${username} понял`);
  });
}

function disconnectSocket() {
  if (socket) { socket.disconnect(); socket = null; }
}

// ── Пользователи в комнате ───────────────────────────────
const roomUsers = new Map(); // socketId → { username, avatar, userId }

function getUserMeta(socketId) { return roomUsers.get(socketId); }

function addUserToList({ socketId, username, avatar, userId }) {
  roomUsers.set(socketId, { username, avatar, userId });
  renderUserList();
}

function removeUserFromList(socketId) {
  roomUsers.delete(socketId);
  renderUserList();
}

function updateUserList(users) {
  roomUsers.clear();
  users.forEach(u => roomUsers.set(u.socketId, {
    username: u.username, avatar: u.avatar, userId: u.userId
  }));
  renderUserList();
}

function renderUserList() {
  const list = $('user-list');
  if (!list) return;
  list.innerHTML = '';

  // always show self
  const selfDiv = el('div', 'user-item self');
  selfDiv.innerHTML = `
    ${avatarHtml(currentUser?.avatar, currentUser?.username, 28)}
    <span class="user-name">${escHtml(currentUser?.username)} (вы)</span>
  `;
  list.appendChild(selfDiv);

  roomUsers.forEach(({ username, avatar, userId }, socketId) => {
    const div = el('div', 'user-item');
    div.innerHTML = `
      ${avatarHtml(avatar, username, 28)}
      <span class="user-name">${escHtml(username)}</span>
      <button class="btn-add-contact btn-icon" data-uid="${userId}" title="Добавить контакт">➕</button>
    `;
    div.querySelector('.btn-add-contact')?.addEventListener('click', async () => {
      try {
        await fetch(`${API}/api/contacts/send`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + authToken
          },
          body: JSON.stringify({ userId })
        });
        toast('✅ Заявка отправлена');
      } catch { toast('❌ Ошибка'); }
    });
    list.appendChild(div);
  });
}

// ── Индикатор печати ─────────────────────────────────────
let typingUsers = new Map();
let typingHideTimers = new Map();

function showTypingIndicator(username, active) {
  if (active) {
    typingUsers.set(username, true);
    clearTimeout(typingHideTimers.get(username));
    typingHideTimers.set(username, setTimeout(() => {
      typingUsers.delete(username);
      renderTyping();
    }, 3000));
  } else {
    typingUsers.delete(username);
    clearTimeout(typingHideTimers.get(username));
  }
  renderTyping();
}

function renderTyping() {
  const el = $('typing-indicator');
  if (!el) return;
  if (typingUsers.size === 0) { el.style.display = 'none'; return; }
  const names = [...typingUsers.keys()].join(', ');
  el.textContent = `${names} печатает...`;
  el.style.display = 'block';
}

// ── WebRTC голос ─────────────────────────────────────────
function setupVoiceButtons() {
  $('btn-join-voice')?.addEventListener('click',  startVoice);
  $('btn-leave-voice')?.addEventListener('click', stopVoice);
  $('btn-mute')?.addEventListener('click',        toggleMute);
  $('btn-start-video')?.addEventListener('click', startVideo);
  $('btn-stop-video')?.addEventListener('click',  stopVideo);
}

async function startVoice() {
  if (mediaStream) return;
  if (!currentRoom)  return toast('⚠️ Сначала войдите в комнату');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    $('btn-join-voice').style.display  = 'none';
    $('btn-leave-voice').style.display = 'inline-flex';
    $('btn-mute').style.display        = 'inline-flex';
    toast('🎙️ Голосовой чат включён');

    roomUsers.forEach((_, socketId) => createPeerConnection(socketId, true));
  } catch(e) {
    console.error('[startVoice]', e);
    toast('❌ Нет доступа к микрофону');
  }
}

function stopVoice() {
  if (!mediaStream) return;
  mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
  isMuted = false;

  Object.keys(peers).forEach(id => closePeer(id));
  peers = {};

  Object.values(audioEls).forEach(a => a.remove());
  audioEls = {};

  $('btn-join-voice').style.display  = 'inline-flex';
  $('btn-leave-voice').style.display = 'none';
  $('btn-mute').style.display        = 'none';
  toast('🔇 Голосовой чат отключён');
}

function toggleMute() {
  if (!mediaStream) return;
  isMuted = !isMuted;
  mediaStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = $('btn-mute');
  if (btn) btn.textContent = isMuted ? '🔇 Без звука' : '🎙️ Микрофон';
  toast(isMuted ? '🔇 Микрофон выключен' : '🎙️ Микрофон включён');
}

function createPeerConnection(socketId, isInitiator) {
  if (peers[socketId]) { peers[socketId].close(); }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[socketId] = pc;

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => pc.addTrack(t, mediaStream));
  }

  pc.ontrack = e => {
    if (!audioEls[socketId]) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      audioEls[socketId] = audio;
    }
    audioEls[socketId].srcObject = e.streams[0];
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket?.emit('ice-candidate', { to: socketId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) {
      closePeer(socketId);
    }
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket?.emit('offer', { to: socketId, offer: pc.localDescription });
      } catch(e) { console.error('[offer]', e); }
    };
  }

  return pc;
}

function closePeer(socketId) {
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  if (audioEls[socketId]) {
    audioEls[socketId].remove();
    delete audioEls[socketId];
  }
}

// ── WebRTC видео ─────────────────────────────────────────
async function startVideo() {
  if (videoStream) return;
  if (!currentRoom) return toast('⚠️ Сначала войдите в комнату');
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

    if (!localVideoEl) {
      localVideoEl = document.createElement('video');
      localVideoEl.autoplay   = true;
      localVideoEl.muted      = true;
      localVideoEl.playsInline = true;
      localVideoEl.className  = 'local-video';
      $('video-area')?.appendChild(localVideoEl);
    }
    localVideoEl.srcObject = videoStream;

    $('btn-start-video').style.display = 'none';
    $('btn-stop-video').style.display  = 'inline-flex';
    $('video-area').style.display      = 'flex';

    socket?.emit('video-start');
    roomUsers.forEach((_, socketId) => createVideoPeer(socketId, true));
    toast('📹 Видео включено');
  } catch(e) {
    console.error('[startVideo]', e);
    toast('❌ Нет доступа к камере');
  }
}

function stopVideo() {
  if (!videoStream) return;
  videoStream.getTracks().forEach(t => t.stop());
  videoStream = null;

  Object.keys(videopeers).forEach(id => closeVideoPeer(id));
  videopeers = {};

  Object.values(remoteVideoEls).forEach(v => v.remove());
  remoteVideoEls = {};

  if (localVideoEl) { localVideoEl.remove(); localVideoEl = null; }

  $('btn-start-video').style.display = 'inline-flex';
  $('btn-stop-video').style.display  = 'none';

  const va = $('video-area');
  if (va) va.style.display = 'none';

  socket?.emit('video-stop');
  toast('📹 Видео отключено');
}

function createVideoPeer(socketId, isInitiator) {
  if (videopeers[socketId]) { videopeers[socketId].close(); }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  videopeers[socketId] = pc;

  if (videoStream) {
    videoStream.getTracks().forEach(t => pc.addTrack(t, videoStream));
  }

  pc.ontrack = e => {
    if (!remoteVideoEls[socketId]) {
      const video = document.createElement('video');
      video.autoplay    = true;
      video.playsInline = true;
      video.className   = 'remote-video';
      $('video-area')?.appendChild(video);
      remoteVideoEls[socketId] = video;
    }
    remoteVideoEls[socketId].srcObject = e.streams[0];
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket?.emit('video-ice', { to: socketId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) {
      closeVideoPeer(socketId);
    }
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket?.emit('video-offer', { to: socketId, offer: pc.localDescription });
      } catch(e) { console.error('[video-offer]', e); }
    };
  }

  return pc;
}

function closeVideoPeer(socketId) {
  if (videopeers[socketId]) {
    videopeers[socketId].close();
    delete videopeers[socketId];
  }
  if (remoteVideoEls[socketId]) {
    remoteVideoEls[socketId].remove();
    delete remoteVideoEls[socketId];
  }
}

// ── Финал ────────────────────────────────────────────────
console.log('✅ VoiceChat app.js loaded');
