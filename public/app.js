'use strict';

/* ══════════════════════════════════════════════
   СОСТОЯНИЕ
══════════════════════════════════════════════ */
const App = {
  socket:           null,
  currentUser:      null,
  currentChat:      null,
  chats:            new Map(),
  contacts:         new Map(),
  unread:           new Map(),
  activeTab:        'chats',
  replyTo:          null,
  editMsg:          null,
  keyPair:          null,
  sharedKeys:       new Map(),
  e2eEnabled:       false,
  _pendingRequests: [],
};

/* ══════════════════════════════════════════════
   DOM-КЭШ
══════════════════════════════════════════════ */
const DOM = {};

function $(id) { return document.getElementById(id); }

function initDOM() {
  DOM.authScreen      = $('screen-auth');
  DOM.appScreen       = $('screen-app');
  DOM.chatList        = $('chat-list');
  DOM.messagesList    = $('messages-list');
  DOM.messagesArea    = $('messages-area');
  DOM.msgInput        = $('msg-input');
  DOM.sendBtn         = $('send-btn');
  DOM.fileInput       = $('file-input');
  DOM.searchInput     = $('search-input');
  DOM.searchClear     = $('search-clear');
  DOM.backBtn         = $('back-btn');
  DOM.replyBar        = $('reply-bar');
  DOM.replyText       = $('reply-bar-text');
  DOM.editBar         = $('edit-bar');
  DOM.editText        = $('edit-bar-text');
  DOM.overlay         = $('overlay');
  DOM.msgCtxMenu      = $('msg-ctx-menu');
  DOM.reactionPicker  = $('reaction-picker');
  DOM.modalProfile    = $('modal-profile');
  DOM.modalNewChat    = $('modal-new-chat');
  DOM.modalChatInfo   = $('modal-chat-info');
  DOM.modalImage      = $('modal-image');
  DOM.modalImageEl    = $('modal-image-el');
  DOM.profileAvatar   = $('profile-avatar-el');
  DOM.profileUsername = $('profile-username-el');
  DOM.profileBio      = $('profile-bio');
  DOM.chatInfoAvatar  = $('chat-info-avatar');
  DOM.chatInfoName    = $('chat-info-name');
  DOM.chatInfoTitle   = $('chat-info-title');
  DOM.chatInfoMeta    = $('chat-info-meta');
  DOM.chatInfoLeave   = $('chat-info-leave-btn');
  DOM.chatInfoAvatarBtn = $('chat-info-avatar-btn');
  DOM.ncUserSearch    = $('nc-user-search');
  DOM.ncGroupName     = $('nc-group-name');
  DOM.ncUserList      = $('nc-user-list');
  DOM.contactsList    = $('contacts-list');
  DOM.requestsList    = $('requests-list');
  DOM.exploreList     = $('explore-list');
  DOM.attachMenu      = $('attach-menu');
  DOM.sidebarPanel    = $('sidebar');
  DOM.chatPanel       = $('chat-area');
  DOM.chatWrap        = $('chat-wrap');
  DOM.chatPlaceholder = $('chat-placeholder');
  DOM.contactsPanel   = $('contacts-panel');
  DOM.explorePanel    = $('explore-panel');
  DOM.myAvatar        = $('my-avatar-el');
  DOM.chatHeaderName  = $('ch-name');
  DOM.chatHeaderStatus= $('ch-status');
  DOM.chatHeaderAvatar= $('ch-avatar');
  DOM.notifications   = $('notifications');
}

/* ══════════════════════════════════════════════
   УТИЛИТЫ
══════════════════════════════════════════════ */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  if (!ts) return '';
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function formatSize(bytes) {
  if (bytes < 1024)        return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}

function getInitialsEmoji(name) {
  if (!name) return '<div class="avatar-placeholder">?</div>';
  const initials = name.trim().slice(0, 2).toUpperCase();
  return `<div class="avatar-placeholder">${initials}</div>`;
}

function showNotif(text, type = 'info') {
  const el = document.createElement('div');
  el.className   = `notif notif-${type}`;
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ══════════════════════════════════════════════
   ТЕМА
══════════════════════════════════════════════ */
const Theme = {
  init() {
    const saved = localStorage.getItem('theme') || 'light';
    this.apply(saved);
  },
  apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('theme', t);
  },
  toggle() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    this.apply(cur === 'dark' ? 'light' : 'dark');
  },
};

/* ══════════════════════════════════════════════
   ЗВУК
══════════════════════════════════════════════ */
const Sound = {
  ctx: null,
  getCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  },
  playBeep() {
    try {
      const ctx  = this.getCtx();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch {}
  },
};

/* ══════════════════════════════════════════════
   PUSH-УВЕДОМЛЕНИЯ
══════════════════════════════════════════════ */
const PushNotif = {
  async request() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  },
  send(title, body) {
    if (Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible')  return;
    new Notification(title, { body, icon: '/icon-192.png' });
  },
};

/* ══════════════════════════════════════════════
   SERVICE WORKER
══════════════════════════════════════════════ */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

/* ══════════════════════════════════════════════
   SOCKET.IO — ПОДКЛЮЧЕНИЕ
══════════════════════════════════════════════ */
function connectSocket() {
  const token = sessionStorage.getItem('chat_token');
  App.socket  = io({ auth: { token }, transports: ['websocket'] });

  App.socket.on('connect',       onSocketConnect);
  App.socket.on('disconnect',    onSocketDisconnect);
  App.socket.on('connect_error', onSocketError);

  App.socket.on('init',             onInit);
  App.socket.on('msg:new',          onMsgNew);
  App.socket.on('msg:edited',       onMsgEdited);
  App.socket.on('msg:deleted',      onMsgDeleted);
  App.socket.on('msg:reaction',     onMsgReaction);
  App.socket.on('chat:typing',      onTyping);
  App.socket.on('user:online',      onUserOnline);
  App.socket.on('user:offline',     onUserOffline);
  App.socket.on('contact:request',  onContactRequest);
  App.socket.on('contact:accepted', onContactAccepted);
  App.socket.on('groups:explore',   onGroupsExplore);
  App.socket.on('e2e:pubkey',       onE2EPubkey);
}

function onSocketConnect() {
  console.log('✅ Socket connected');
  showNotif('Подключено', 'success');
}

function onSocketDisconnect() {
  showNotif('Соединение потеряно', 'error');
}

function onSocketError(err) {
  if (err.message === 'unauthorized') showAuth();
}

/* ══════════════════════════════════════════════
   INIT — данные с сервера
══════════════════════════════════════════════ */
function onInit(data) {
  App.currentUser = data.user;
  sessionStorage.setItem('chat_session', JSON.stringify(data.user));

  App.chats.clear();
  (data.chats || []).forEach(c => {
    App.chats.set(c.id, { info: c, messages: c.messages || [] });
  });

  App.contacts.clear();
  (data.contacts || []).forEach(c => App.contacts.set(c.id, c));

  App._pendingRequests = data.pendingRequests || [];

  showApp();
  renderMyAvatar();
  renderChatList();
}

/* ══════════════════════════════════════════════
   АВТОРИЗАЦИЯ
══════════════════════════════════════════════ */
function showAuth() {
  DOM.authScreen?.classList.remove('hidden');
  DOM.appScreen?.classList.add('hidden');
}

function showApp() {
  DOM.authScreen?.classList.add('hidden');
  DOM.appScreen?.classList.remove('hidden');
}

function switchAuthTab(tab) {
  // tab = 'login' | 'register'
  document.querySelectorAll('.auth-tab').forEach((btn, i) => {
    btn.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'));
  });
  $('tab-login')?.classList.toggle('hidden',    tab !== 'login');
  $('tab-register')?.classList.toggle('hidden', tab !== 'register');
}

async function doLogin() {
  const username = $('login-username')?.value.trim();
  const password = $('login-password')?.value.trim();
  const errEl    = $('login-err');
  if (!username || !password) {
    if (errEl) errEl.textContent = 'Заполните все поля';
    return;
  }
  try {
    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.ok) {
      sessionStorage.setItem('chat_token', data.token);
      if (errEl) errEl.textContent = '';
      App.socket?.disconnect();
      connectSocket();
    } else {
      if (errEl) errEl.textContent = data.error || 'Ошибка входа';
    }
  } catch {
    if (errEl) errEl.textContent = 'Ошибка сети';
  }
}

async function doRegister() {
  const username  = $('reg-username')?.value.trim();
  const password  = $('reg-password')?.value.trim();
  const password2 = $('reg-password2')?.value.trim();
  const errEl     = $('reg-err');
  if (!username || !password || !password2) {
    if (errEl) errEl.textContent = 'Заполните все поля';
    return;
  }
  if (password !== password2) {
    if (errEl) errEl.textContent = 'Пароли не совпадают';
    return;
  }
  try {
    const res  = await fetch('/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.ok) {
      sessionStorage.setItem('chat_token', data.token);
      if (errEl) errEl.textContent = '';
      App.socket?.disconnect();
      connectSocket();
    } else {
      if (errEl) errEl.textContent = data.error || 'Ошибка регистрации';
    }
  } catch {
    if (errEl) errEl.textContent = 'Ошибка сети';
  }
}

function doLogout() {
  sessionStorage.removeItem('chat_token');
  sessionStorage.removeItem('chat_session');
  App.socket?.disconnect();
  App.currentUser = null;
  App.currentChat = null;
  App.chats.clear();
  App.contacts.clear();
  App.unread.clear();
  closeModal('modal-profile');
  showAuth();
}

/* ══════════════════════════════════════════════
   E2E — ECDH + AES-GCM
══════════════════════════════════════════════ */
const E2E = {
  async generateKeyPair() {
    return await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
  },
  async exportPublicKey(pubKey) {
    const raw = await crypto.subtle.exportKey('spki', pubKey);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  },
  async importPublicKey(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length).map((_, i) => bin.charCodeAt(i));
    return await crypto.subtle.importKey(
      'spki', buf.buffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, []
    );
  },
  async deriveSharedKey(privKey, theirPubKey) {
    return await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPubKey },
      privKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },
  async encrypt(sharedKey, plaintext) {
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ct  = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, sharedKey, enc.encode(plaintext)
    );
    const combined = new Uint8Array(iv.byteLength + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), iv.byteLength);
    return btoa(String.fromCharCode(...combined));
  },
  async decrypt(sharedKey, b64) {
    const bin      = atob(b64);
    const combined = new Uint8Array(bin.length).map((_, i) => bin.charCodeAt(i));
    const iv       = combined.slice(0, 12);
    const ct       = combined.slice(12);
    const pt       = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, sharedKey, ct
    );
    return new TextDecoder().decode(pt);
  },
};

async function onE2EPubkey(data) {
  if (!App.e2eEnabled || !App.keyPair) return;
  try {
    const theirKey = await E2E.importPublicKey(data.pubKey);
    const shared   = await E2E.deriveSharedKey(App.keyPair.privateKey, theirKey);
    App.sharedKeys.set(data.userId, shared);
  } catch(e) {
    console.error('E2E key exchange error:', e);
  }
}

/* ══════════════════════════════════════════════
   САЙДБАР — ТАБЫ
══════════════════════════════════════════════ */
function switchTab(tab) {
  App.activeTab = tab;

  ['chats', 'contacts', 'explore'].forEach(t => {
    $(`stab-${t}`)?.classList.toggle('active', t === tab);
  });

  // Показываем нужную панель
  DOM.chatList?.classList.toggle('hidden',        tab !== 'chats');
  DOM.contactsPanel?.classList.toggle('hidden',   tab !== 'contacts');
  DOM.explorePanel?.classList.toggle('hidden',    tab !== 'explore');

  if (tab === 'contacts') renderContactsPanel();
  if (tab === 'explore')  App.socket.emit('groups:explore', { query: '' });
}

/* ══════════════════════════════════════════════
   АВАТАР ТЕКУЩЕГО ПОЛЬЗОВАТЕЛЯ
══════════════════════════════════════════════ */
function renderMyAvatar() {
  const u  = App.currentUser;
  const el = DOM.myAvatar;
  if (!el || !u) return;
  el.innerHTML = u.avatar
    ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
    : getInitialsEmoji(u.username);
}

/* ══════════════════════════════════════════════
   СПИСОК ЧАТОВ
══════════════════════════════════════════════ */
function renderChatList() {
  if (!DOM.chatList) return;
  const query = DOM.searchInput?.value.toLowerCase() || '';

  let chats = [...App.chats.values()];
  if (query) {
    chats = chats.filter(c =>
      (c.info.name || '').toLowerCase().includes(query)
    );
  }

  chats.sort((a, b) => {
    const ta = new Date(a.info.last_msg_at || 0).getTime();
    const tb = new Date(b.info.last_msg_at || 0).getTime();
    return tb - ta;
  });

  if (!chats.length) {
    DOM.chatList.innerHTML =
      `<div style="text-align:center;padding:32px;color:var(--text2)">
         <div style="font-size:40px">💬</div>
         <div>${query ? 'Ничего не найдено' : 'Нет чатов'}</div>
       </div>`;
    return;
  }

  DOM.chatList.innerHTML = chats.map(c => buildChatItem(c)).join('');
}

function buildChatItem(c) {
  const info   = c.info;
  const unread = App.unread.get(info.id) || 0;
  const active = App.currentChat === info.id;
  const av     = info.avatar
    ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
    : getInitialsEmoji(info.name);
  const lastMsg = escHtml((info.last_msg || '').slice(0, 40));
  const time    = info.last_msg_at ? formatTime(info.last_msg_at) : '';

  return `
    <div class="chat-item${active ? ' active' : ''}"
         onclick="openChat(${info.id})">
      <div class="ci-avatar">${av}</div>
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${escHtml(info.name || '')}</span>
          <span class="ci-time">${time}</span>
        </div>
        <div class="ci-bottom">
          <span class="ci-last">${lastMsg}</span>
          ${unread ? `<span class="unread-badge">${unread}</span>` : ''}
        </div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════
   ОТКРЫТИЕ ЧАТА
══════════════════════════════════════════════ */
async function openChat(chatId) {
  App.currentChat = chatId;
  App.unread.set(chatId, 0);

  const chat = App.chats.get(chatId);
  if (!chat) return;

  renderChatList();
  renderChatHeader();

  if (!chat.messages.length) {
    await loadMessages(chatId);
  }

  renderMessages();
  showChatPanel();

  App.socket.emit('msg:read', { chatId });
  App.socket.emit('chat:join', { chatId });
}

async function loadMessages(chatId) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch(`/api/chats/${chatId}/messages`, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json();
    if (data.ok && data.messages) {
      const chat = App.chats.get(chatId);
      if (chat) chat.messages = data.messages;
    }
  } catch(e) {
    console.error('loadMessages:', e);
  }
}

function showChatPanel() {
  DOM.chatPlaceholder?.classList.add('hidden');
  DOM.chatWrap?.classList.remove('hidden');
  if (window.innerWidth <= 700) {
    DOM.sidebarPanel?.classList.add('hidden');
    DOM.backBtn?.classList.remove('hidden');
  }
}

function showChatPlaceholder() {
  DOM.chatWrap?.classList.add('hidden');
  DOM.chatPlaceholder?.classList.remove('hidden');
  if (window.innerWidth <= 700) {
    DOM.sidebarPanel?.classList.remove('hidden');
    DOM.backBtn?.classList.add('hidden');
  }
}

function goBack() {
  App.currentChat = null;
  DOM.sidebarPanel?.classList.remove('hidden');
  DOM.backBtn?.classList.add('hidden');
  showChatPlaceholder();
}

/* ══════════════════════════════════════════════
   ШАПКА ЧАТА
══════════════════════════════════════════════ */
function renderChatHeader() {
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const info = chat.info;

  if (DOM.chatHeaderName)   DOM.chatHeaderName.textContent   = info.name || '';
  if (DOM.chatHeaderStatus) DOM.chatHeaderStatus.textContent = info.online ? 'В сети' : '';
  if (DOM.chatHeaderAvatar) {
    DOM.chatHeaderAvatar.innerHTML = info.avatar
      ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
      : getInitialsEmoji(info.name);
  }
}

/* ══════════════════════════════════════════════
   ПОИСК
══════════════════════════════════════════════ */
function onSearchInput() {
  const q = DOM.searchInput?.value || '';
  DOM.searchClear?.classList.toggle('hidden', !q);
  renderChatList();
}

function clearSearch() {
  if (DOM.searchInput) DOM.searchInput.value = '';
  DOM.searchClear?.classList.add('hidden');
  renderChatList();
}

/* ══════════════════════════════════════════════
   TYPING
══════════════════════════════════════════════ */
const _typingUsers = new Map();

function onTyping(data) {
  if (data.chatId !== App.currentChat) return;
  if (data.isTyping) {
    _typingUsers.set(data.userId, data.username);
  } else {
    _typingUsers.delete(data.userId);
  }
  renderTyping();
}

function renderTyping() {
  const el = $('ch-status');
  if (!el) return;
  if (_typingUsers.size) {
    const names = [..._typingUsers.values()].join(', ');
    el.textContent = `${names} печатает...`;
  } else {
    const chat = App.chats.get(App.currentChat);
    el.textContent = chat?.info.online ? 'В сети' : '';
  }
}

/* ══════════════════════════════════════════════
   ОНЛАЙН-СТАТУС
══════════════════════════════════════════════ */
function onUserOnline(data) {
  App.chats.forEach(c => {
    if (c.info.type === 'private' && c.info.userId === data.userId) c.info.online = true;
  });
  App.contacts.forEach(c => { if (c.id === data.userId) c.online = true; });
  if (App.currentChat) renderChatHeader();
  if (App.activeTab === 'contacts') renderContactsList();
}

function onUserOffline(data) {
  App.chats.forEach(c => {
    if (c.info.type === 'private' && c.info.userId === data.userId) c.info.online = false;
  });
  App.contacts.forEach(c => { if (c.id === data.userId) c.online = false; });
  if (App.currentChat) renderChatHeader();
  if (App.activeTab === 'contacts') renderContactsList();
}

/* ══════════════════════════════════════════════
   SOCKET — СОБЫТИЯ СООБЩЕНИЙ
══════════════════════════════════════════════ */
function onMsgNew(msg) {
  const chatId = msg.chat_id || msg.chatId;
  const chat   = App.chats.get(chatId);
  if (!chat) return;

  chat.messages.push(msg);
  chat.info.last_msg    = msg.content || (msg.type !== 'text' ? '📎 Файл' : '');
  chat.info.last_msg_at = msg.created_at;

  if (App.currentChat === chatId) {
    appendMessage(msg);
    scrollToBottom();
    App.socket.emit('msg:read', { chatId, msgId: msg.msg_id });
  } else {
    App.unread.set(chatId, (App.unread.get(chatId) || 0) + 1);
    showNotif(`${msg.username}: ${(msg.content || '📎').slice(0, 50)}`);
  }

  if (msg.user_id !== App.currentUser?.id) {
    Sound.playBeep();
    PushNotif.send(
      msg.username || 'Новое сообщение',
      (msg.content || '📎 Файл').slice(0, 80)
    );
  }

  renderChatList();
}

function onMsgEdited(data) {
  App.chats.forEach(chat => {
    const msg = chat.messages.find(m => m.msg_id === data.msgId);
    if (msg) { msg.content = data.content; msg.edited_at = data.editedAt; }
  });
  const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
  if (el) {
    const t = el.querySelector('.msg-text');
    if (t) t.innerHTML = formatMsgText(data.content);
    if (!el.querySelector('.msg-edited')) {
      const s = document.createElement('span');
      s.className   = 'msg-edited';
      s.textContent = ' (изм.)';
      el.querySelector('.msg-meta')?.appendChild(s);
    }
  }
}

function onMsgDeleted(data) {
  App.chats.forEach(chat => {
    chat.messages = chat.messages.filter(m => m.msg_id !== data.msgId);
  });
  const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
  if (el) {
    el.style.opacity    = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }
}

function onMsgReaction(data) {
  App.chats.forEach(chat => {
    const msg = chat.messages.find(m => m.msg_id === data.msgId);
    if (msg) msg.reactions = data.reactions;
  });
  const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
  if (el) {
    const r = el.querySelector('.msg-reactions');
    if (r) r.outerHTML = buildReactionsHtml(data.reactions);
  }
}

/* ══════════════════════════════════════════════
   РЕНДЕР СООБЩЕНИЙ
══════════════════════════════════════════════ */
function renderMessages() {
  if (!DOM.messagesList) return;
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  DOM.messagesList.innerHTML = '';
  let lastDate = null;

  chat.messages.forEach(msg => {
    const d = new Date(msg.created_at || msg.ts).toDateString();
    if (d !== lastDate) {
      lastDate = d;
      const sep = document.createElement('div');
      sep.className   = 'date-divider';
      sep.textContent = formatDate(msg.created_at || msg.ts);
      DOM.messagesList.appendChild(sep);
    }
    DOM.messagesList.appendChild(buildMsgEl(msg));
  });

  scrollToBottom(false);
}

function appendMessage(msg) {
  if (!DOM.messagesList) return;
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const msgs    = chat.messages;
  const prev    = msgs[msgs.length - 2];
  const prevDate = prev
    ? new Date(prev.created_at || prev.ts).toDateString() : null;
  const newDate  = new Date(msg.created_at || msg.ts).toDateString();

  if (prevDate !== newDate) {
    const sep = document.createElement('div');
    sep.className   = 'date-divider';
    sep.textContent = formatDate(msg.created_at || msg.ts);
    DOM.messagesList.appendChild(sep);
  }
  DOM.messagesList.appendChild(buildMsgEl(msg));
}

function buildMsgEl(msg) {
  const userId = msg.user_id || msg.senderId;
  const isMine = userId === App.currentUser?.id;
  const wrap   = document.createElement('div');
  wrap.className     = `msg-wrap ${isMine ? 'own' : 'other'}`;
  wrap.dataset.msgId = msg.msg_id || msg.id;
  wrap.innerHTML     = buildMsgInner(msg, isMine);

  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    showCtxMenu(e, msg, isMine);
  });

  let lpt;
  wrap.addEventListener('touchstart', () => {
    lpt = setTimeout(() => showCtxMenu(null, msg, isMine), 500);
  });
  wrap.addEventListener('touchend',  () => clearTimeout(lpt));
  wrap.addEventListener('touchmove', () => clearTimeout(lpt));

  return wrap;
}

function buildMsgInner(msg, isMine) {
  const username  = msg.username   || msg.senderName   || '';
  const avatar    = msg.avatar     || msg.senderAvatar || '';
  const content   = msg.content    || msg.text         || '';
  const ts        = msg.created_at || msg.ts;
  const reactions = msg.reactions  || [];
  const replyTo   = msg.reply_to;

  const avatarHtml = !isMine
    ? `<div class="msg-avatar">${
        avatar
          ? `<img class="avatar-img" src="${escHtml(avatar)}" alt="">`
          : getInitialsEmoji(username)
      }</div>`
    : '';

  const replyHtml = replyTo
    ? `<div class="msg-reply">
         <span class="msg-reply-name">Ответ</span>
         <span>${escHtml(String(replyTo).slice(0, 60))}</span>
       </div>`
    : '';

  const contentHtml = buildMsgContent(msg, content);
  const edited      = msg.edited_at
    ? '<span class="msg-edited"> (изм.)</span>' : '';
  const reactHtml   = buildReactionsHtml(reactions);

  return `
    <div class="msg-row">
      ${avatarHtml}
      <div class="msg-bubble${msg.deleted ? ' deleted' : ''}">
        ${!isMine && username
          ? `<div class="msg-sender">${escHtml(username)}</div>` : ''}
        ${replyHtml}
        ${contentHtml}
        <div class="msg-meta">
          <span class="msg-time">${formatTime(ts)}</span>
          ${edited}
        </div>
      </div>
    </div>
    ${reactHtml}`;
}

function buildMsgContent(msg, content) {
  if (msg.deleted) {
    return `<div class="msg-text" style="opacity:.5;font-style:italic">Сообщение удалено</div>`;
  }
  if (msg.type === 'image' || (msg.mime_type && msg.mime_type.startsWith('image/'))) {
    const url = msg.file_url || content;
    return `<img class="msg-image"
                 src="${escHtml(url)}"
                 alt="${escHtml(msg.file_name || '')}"
                 onclick="openImageModal('${escHtml(url)}')">`;
  }
  if (msg.type === 'file' || msg.file_name) {
    const url  = msg.file_url || content;
    const name = msg.file_name || 'файл';
    const size = msg.file_size ? formatSize(msg.file_size) : '';
    return `<a class="msg-file" href="${escHtml(url)}" target="_blank" download>
              <span class="msg-file-icon">📎</span>
              <div class="msg-file-info">
                <span class="msg-file-name">${escHtml(name)}</span>
                <span class="msg-file-size">${size}</span>
              </div>
            </a>`;
  }
  if (content) {
    return `<div class="msg-text">${formatMsgText(content)}</div>`;
  }
  return '';
}

function formatMsgText(text) {
  let t = escHtml(text);
  t = t.replace(/(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener" class="msg-link">$1</a>');
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/_(.+?)_/g,       '<em>$1</em>');
  t = t.replace(/`(.+?)`/g,       '<code class="msg-code">$1</code>');
  t = t.replace(/\n/g, '<br>');
  return t;
}

function buildReactionsHtml(reactions) {
  if (!reactions || !reactions.length)
    return '<div class="msg-reactions"></div>';

  const grouped = {};
  reactions.forEach(r => {
    if (!grouped[r.emoji]) grouped[r.emoji] = [];
    grouped[r.emoji].push(r.userId || r.user_id);
  });

  const items = Object.entries(grouped).map(([emoji, users]) => {
    const isMine = users.includes(App.currentUser?.id);
    return `<span class="reaction-chip${isMine ? ' mine' : ''}"
                  onclick="sendReaction('${escHtml(emoji)}')"
                  title="${users.length} чел.">
              ${emoji}
              <span class="r-count">${users.length}</span>
            </span>`;
  }).join('');

  return `<div class="msg-reactions">${items}</div>`;
}

function scrollToBottom(smooth = true) {
  DOM.messagesArea?.scrollTo({
    top:      DOM.messagesArea.scrollHeight,
    behavior: smooth ? 'smooth' : 'instant',
  });
}

/* ══════════════════════════════════════════════
   ВВОД И ОТПРАВКА СООБЩЕНИЙ
══════════════════════════════════════════════ */
async function sendMessage() {
  if (!App.currentChat) return;
  const text = DOM.msgInput?.value.trim();

  if (App.editMsg) {
    if (!text) return;
    App.socket.emit('msg:edit', { msgId: App.editMsg.msgId, content: text });
    clearEditBar();
    if (DOM.msgInput) DOM.msgInput.value = '';
    autoResizeInput();
    return;
  }

  if (!text) return;

  const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  App.socket.emit('msg:send', {
    msgId,
    chatId:  App.currentChat,
    type:    'text',
    content: text,
    replyTo: App.replyTo ? App.replyTo.msgId : null,
  });

  if (DOM.msgInput) DOM.msgInput.value = '';
  autoResizeInput();
  clearReplyBar();
}

function autoResizeInput() {
  const el = DOM.msgInput;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

let _typingTimer;
function sendTyping() {
  if (!App.currentChat) return;
  clearTimeout(_typingTimer);
  App.socket.emit('chat:typing', { chatId: App.currentChat, isTyping: true });
  _typingTimer = setTimeout(() => {
    App.socket.emit('chat:typing', { chatId: App.currentChat, isTyping: false });
  }, 2500);
}

async function onFileSelected() {
  const file = DOM.fileInput?.files[0];
  if (!file || !App.currentChat) return;
  if (DOM.fileInput) DOM.fileInput.value = '';

  if (file.size > 20 * 1024 * 1024) {
    showNotif('Файл слишком большой (макс. 20 МБ)', 'error');
    return;
  }

  const token    = sessionStorage.getItem('chat_token');
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res  = await fetch('/api/upload', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body:    formData,
    });
    const data = await res.json();
    if (data.ok) {
      const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      App.socket.emit('msg:send', {
        msgId,
        chatId:   App.currentChat,
        type:     file.type.startsWith('image/') ? 'image' : 'file',
        content:  data.url,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        replyTo:  App.replyTo ? App.replyTo.msgId : null,
      });
      clearReplyBar();
    } else {
      showNotif(data.error || 'Ошибка загрузки', 'error');
    }
  } catch {
    showNotif('Ошибка загрузки файла', 'error');
  }
}

/* ══════════════════════════════════════════════
   REPLY / EDIT BARS
══════════════════════════════════════════════ */
function clearReplyBar() {
  App.replyTo = null;
  DOM.replyBar?.classList.add('hidden');
  if (DOM.replyText) DOM.replyText.textContent = '';
}

function openReplyBar(msg) {
  const content = msg.content || msg.text || '📎';
  const name    = msg.username || msg.senderName || '';
  App.replyTo   = { msgId: msg.msg_id || msg.id, text: content, senderName: name };
  if (DOM.replyText) DOM.replyText.textContent = `${name}: ${content.slice(0, 60)}`;
  DOM.replyBar?.classList.remove('hidden');
  DOM.msgInput?.focus();
}

function clearEditBar() {
  App.editMsg = null;
  DOM.editBar?.classList.add('hidden');
  if (DOM.editText) DOM.editText.textContent = '';
  if (DOM.msgInput) DOM.msgInput.value = '';
  autoResizeInput();
}

function openEditBar(msg) {
  const content = msg.content || msg.text || '';
  App.editMsg   = { msgId: msg.msg_id || msg.id, content };
  if (DOM.editText) DOM.editText.textContent = content.slice(0, 60);
  DOM.editBar?.classList.remove('hidden');
  if (DOM.msgInput) { DOM.msgInput.value = content; DOM.msgInput.focus(); }
  autoResizeInput();
}

/* ══════════════════════════════════════════════
   КОНТЕКСТНОЕ МЕНЮ + РЕАКЦИИ
══════════════════════════════════════════════ */
let _ctxMsg  = null;
let _ctxMine = false;

function showCtxMenu(e, msg, isMine) {
  _ctxMsg  = msg;
  _ctxMine = isMine;

  const menu = DOM.msgCtxMenu;
  if (!menu) return;
  menu.classList.remove('hidden');
  DOM.overlay?.classList.remove('hidden');

  $('ctx-edit-btn').style.display = isMine ? '' : 'none';
  $('ctx-del-btn').style.display  = isMine ? '' : 'none';

  if (e) {
    let x = e.clientX, y = e.clientY;
    const mw = 180, mh = 200;
    if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    menu.style.left      = x + 'px';
    menu.style.top       = y + 'px';
    menu.style.transform = '';
  } else {
    menu.style.left      = '50%';
    menu.style.top       = '50%';
    menu.style.transform = 'translate(-50%,-50%)';
  }
}

function ctxReply()  { closeOverlay(); if (_ctxMsg) openReplyBar(_ctxMsg); }
function ctxCopy()   {
  closeOverlay();
  const text = _ctxMsg?.content || _ctxMsg?.text;
  if (text) {
    navigator.clipboard.writeText(text)
      .then(()  => showNotif('Скопировано', 'success'))
      .catch(()  => showNotif('Не удалось скопировать', 'error'));
  }
}
function ctxEdit()   { closeOverlay(); if (_ctxMsg) openEditBar(_ctxMsg); }
function ctxReact()  {
  DOM.msgCtxMenu?.classList.add('hidden');
  DOM.reactionPicker?.classList.remove('hidden');
}
function ctxDelete() {
  closeOverlay();
  if (!_ctxMsg) return;
  if (!confirm('Удалить сообщение?')) return;
  App.socket.emit('msg:delete', { msgId: _ctxMsg.msg_id || _ctxMsg.id });
}

function pickReaction(emoji) {
  DOM.reactionPicker?.classList.add('hidden');
  DOM.overlay?.classList.add('hidden');
  if (!_ctxMsg) return;
  App.socket.emit('msg:react', { msgId: _ctxMsg.msg_id || _ctxMsg.id, emoji });
}

function sendReaction(emoji) {
  if (!_ctxMsg) return;
  App.socket.emit('msg:react', { msgId: _ctxMsg.msg_id || _ctxMsg.id, emoji });
}

/* ══════════════════════════════════════════════
   OVERLAY / МОДАЛКИ
══════════════════════════════════════════════ */
function closeOverlay() {
  DOM.overlay?.classList.add('hidden');
  DOM.msgCtxMenu?.classList.add('hidden');
  DOM.reactionPicker?.classList.add('hidden');
  _ctxMsg  = null;
  _ctxMine = false;
}

function closeModal(id) {
  $(id)?.classList.add('hidden');
  DOM.overlay?.classList.add('hidden');
}

function openModal(id) {
  $(id)?.classList.remove('hidden');
  DOM.overlay?.classList.remove('hidden');
}

/* ══════════════════════════════════════════════
   ПРОФИЛЬ
══════════════════════════════════════════════ */
function openMyProfile() {
  if (!App.currentUser) return;
  const u = App.currentUser;
  if (DOM.profileAvatar) {
    DOM.profileAvatar.innerHTML = u.avatar
      ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
      : getInitialsEmoji(u.username);
  }
  if (DOM.profileUsername) DOM.profileUsername.textContent = u.username;
  if (DOM.profileBio)      DOM.profileBio.value            = u.bio || '';
  openModal('modal-profile');
}

async function saveProfile() {
  const bio   = DOM.profileBio?.value.trim();
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch('/api/profile', {
      method:  'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ bio }),
    });
    const data = await res.json();
    if (data.ok) {
      App.currentUser.bio = bio;
      showNotif('Профиль сохранён', 'success');
      closeModal('modal-profile');
    } else {
      showNotif(data.error || 'Ошибка сохранения', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

async function changeAvatar() {
  const input  = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showNotif('Файл слишком большой (макс. 5 МБ)', 'error');
      return;
    }
    const token    = sessionStorage.getItem('chat_token');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res  = await fetch('/api/upload/avatar', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body:    formData,
      });
      const data = await res.json();
      if (data.ok) {
        App.currentUser.avatar = data.url;
        if (DOM.profileAvatar) {
          DOM.profileAvatar.innerHTML =
            `<img class="avatar-img" src="${escHtml(data.url)}" alt="">`;
        }
        renderMyAvatar();
        renderChatList();
        showNotif('Аватар обновлён', 'success');
      } else {
        showNotif(data.error || 'Ошибка загрузки', 'error');
      }
    } catch {
      showNotif('Ошибка сети', 'error');
    }
  };
  input.click();
}

/* ══════════════════════════════════════════════
   НОВЫЙ ЧАТ
══════════════════════════════════════════════ */
function openNewChat() {
  // init состояния выбора участников для групп
  if (!App.ncGroupSelected) App.ncGroupSelected = new Set();
  App.ncGroupSelected.clear();

  if ($('nc-group-solo')) $('nc-group-solo').checked = false;
  if (DOM.ncUserSearch) DOM.ncUserSearch.value = '';
  if (DOM.ncGroupName)  DOM.ncGroupName.value  = '';
  if ($('nc-group-pass'))   $('nc-group-pass').value   = '';
  if ($('nc-group-search')) $('nc-group-search').value = '';

  if (DOM.ncUserList) DOM.ncUserList.innerHTML = '';
  if ($('nc-group-list')) $('nc-group-list').innerHTML = '';

  const selCounter = $('nc-group-selected');
  if (selCounter) selCounter.textContent = 'Выбрано: 0';

  switchNewChatTab('private');
  openModal('modal-new-chat');
  renderNcContacts('');
}

function switchNewChatTab(mode) {
  document.querySelectorAll('.nctab').forEach((btn, i) => {
    btn.classList.toggle(
      'active',
      (i === 0 && mode === 'private') || (i === 1 && mode === 'group')
    );
  });

  $('nctab-private')?.classList.toggle('hidden', mode !== 'private');
  $('nctab-group')?.classList.toggle('hidden',   mode !== 'group');

  if (mode === 'private') {
    renderNcContacts(DOM.ncUserSearch?.value.trim() || '');
  } else {
    renderNcGroupContacts($('nc-group-search')?.value.trim() || '');
  }
}

function renderNcContacts(query) {
  const q = query.toLowerCase();
  const contacts = [...App.contacts.values()].filter(c =>
    !q || c.username.toLowerCase().includes(q)
  );

  if (!DOM.ncUserList) return;

  if (!contacts.length) {
    DOM.ncUserList.innerHTML =
      `<div style="text-align:center;padding:24px;color:var(--text2)">
         Контакты не найдены
       </div>`;
    return;
  }

  DOM.ncUserList.innerHTML = contacts.map(c => {
    const av = c.avatar
      ? `<img class="avatar-img" src="${escHtml(c.avatar)}" alt="">`
      : getInitialsEmoji(c.username);

    return `
      <div class="contact-item" data-id="${c.id}">
        <div class="ci-avatar">${av}</div>
        <div class="ci-body">
          <span class="ci-name">${escHtml(c.username)}</span>
        </div>
        <button class="btn-sm" onclick="ncSelectUser(${c.id})">Выбрать</button>
      </div>`;
  }).join('');
}

function searchUsers() {
  renderNcContacts(DOM.ncUserSearch?.value.trim() || '');
}

function searchGroupUsers() {
  renderNcGroupContacts($('nc-group-search')?.value.trim() || '');
}

function renderNcGroupContacts(query) {
  if (!App.ncGroupSelected) App.ncGroupSelected = new Set();

  const q = (query || '').toLowerCase();
  const contacts = [...App.contacts.values()].filter(c =>
    !q || c.username.toLowerCase().includes(q)
  );

  const list = $('nc-group-list');
  if (!list) return;

  if (!contacts.length) {
    list.innerHTML =
      `<div style="text-align:center;padding:24px;color:var(--text2)">
         Контакты не найдены
       </div>`;
  } else {
    list.innerHTML = contacts.map(c => {
      const selected = App.ncGroupSelected.has(c.id);
      const av = c.avatar
        ? `<img class="avatar-img" src="${escHtml(c.avatar)}" alt="">`
        : getInitialsEmoji(c.username);

      return `
        <div class="contact-item ${selected ? 'selected' : ''}" data-id="${c.id}">
          <div class="ci-avatar">${av}</div>
          <div class="ci-body">
            <span class="ci-name">${escHtml(c.username)}</span>
          </div>
          <button class="btn-sm" onclick="toggleGroupUser(${c.id})">
            ${selected ? 'Убрать' : 'Выбрать'}
          </button>
        </div>`;
    }).join('');
  }

  const counter = $('nc-group-selected');
  if (counter) counter.textContent = `Выбрано: ${App.ncGroupSelected.size}`;
}

function toggleGroupUser(userId) {
  if (!App.ncGroupSelected) App.ncGroupSelected = new Set();

  if (App.ncGroupSelected.has(userId)) {
    App.ncGroupSelected.delete(userId);
  } else {
    App.ncGroupSelected.add(userId);
  }

  renderNcGroupContacts($('nc-group-search')?.value.trim() || '');
}

async function ncSelectUser(userId) {
  const isGroup = !$('nctab-group')?.classList.contains('hidden');
  if (isGroup) {
    // в режиме группы выбор идет через toggleGroupUser()
    return;
  }
  closeModal('modal-new-chat');
  await createPrivateChat(userId);
}

async function createPrivateChat(userId) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res = await fetch('/api/chats/private', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json();
    if (data.ok && data.chat) {
      App.chats.set(data.chat.id, { info: data.chat, messages: [] });
      renderChatList();
      openChat(data.chat.id);
    } else {
      showNotif(data.error || 'Ошибка создания чата', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

async function createGroup() {
  const name = DOM.ncGroupName?.value.trim();
  const pass = $('nc-group-pass')?.value.trim() || '';
  const solo = !!$('nc-group-solo')?.checked;
  const selected = [...(App.ncGroupSelected || new Set())];

  if (!name) {
    showNotif('Введите название группы', 'error');
    return;
  }

  // пробуем взять id текущего пользователя из разных мест
  const myId =
    App.me?.id ??
    App.user?.id ??
    +(sessionStorage.getItem('user_id') || 0) ||
    null;

  // если "в одиночку" — отправим хотя бы себя (частый req бэка: min 1)
  const members = solo ? (myId ? [myId] : []) : selected;

  if (!members.length) {
    showNotif('Выберите участника (или не удалось определить ваш user_id для одиночной группы)', 'error');
    return;
  }

  const token = sessionStorage.getItem('chat_token');

  try {
    const payload = {
      name,
      members,          // основной вариант
      memberIds: members,     // совместимость
      participants: members,  // совместимость
    };
    if (pass) payload.password = pass;

    const res = await fetch('/api/chats/group', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { data = { ok: false, error: raw || `HTTP ${res.status}` }; }

    if (res.ok && data.ok && data.chat) {
      App.chats.set(data.chat.id, { info: data.chat, messages: [] });
      renderChatList();
      openChat(data.chat.id);
      closeModal('modal-new-chat');
      showNotif('Группа создана', 'success');
    } else {
      console.error('createGroup failed:', res.status, data);
      showNotif(`[${res.status}] ${data.error || 'Ошибка создания группы'}`, 'error');
    }
  } catch (e) {
    console.error('createGroup exception:', e);
    showNotif('Ошибка сети/клиента при создании группы', 'error');
  }
}
/* ══════════════════════════════════════════════
   ИНФОРМАЦИЯ О ЧАТЕ
══════════════════════════════════════════════ */
async function openChatInfo() {
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const info = chat.info;

  if (DOM.chatInfoAvatar) {
    DOM.chatInfoAvatar.innerHTML = info.avatar
      ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
      : getInitialsEmoji(info.name);
  }
  if (DOM.chatInfoName)  DOM.chatInfoName.textContent  = info.name;
  if (DOM.chatInfoTitle) DOM.chatInfoTitle.textContent =
    info.type === 'group' ? 'Информация о группе' : 'Информация о пользователе';
  if (DOM.chatInfoMeta)  DOM.chatInfoMeta.textContent  =
    info.type === 'group'
      ? `${info.member_count || 0} участников`
      : (info.online ? 'В сети' : 'Не в сети');

  if (DOM.chatInfoLeave) {
    DOM.chatInfoLeave.style.display = info.type === 'group' ? '' : 'none';
  }
  if (DOM.chatInfoAvatarBtn) {
    DOM.chatInfoAvatarBtn.style.display = info.type === 'group' ? '' : 'none';
  }

  openModal('modal-chat-info');
}

async function changeChatAvatar() {
  const chat = App.chats.get(App.currentChat);
  if (!chat || chat.info.type !== 'group') return;
  const input  = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const token    = sessionStorage.getItem('chat_token');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res  = await fetch(`/api/chats/${App.currentChat}/avatar`, {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body:    formData,
      });
      const data = await res.json();
      if (data.ok) {
        chat.info.avatar = data.url;
        if (DOM.chatInfoAvatar) {
          DOM.chatInfoAvatar.innerHTML =
            `<img class="avatar-img" src="${escHtml(data.url)}" alt="">`;
        }
        renderChatHeader();
        renderChatList();
        showNotif('Аватар группы обновлён', 'success');
      } else {
        showNotif(data.error || 'Ошибка загрузки', 'error');
      }
    } catch {
      showNotif('Ошибка сети', 'error');
    }
  };
  input.click();
}

async function leaveChat() {
  if (!App.currentChat) return;
  if (!confirm('Покинуть группу?')) return;
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch(`/api/chats/${App.currentChat}/leave`, {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json();
    if (data.ok) {
      closeModal('modal-chat-info');
      App.chats.delete(App.currentChat);
      App.currentChat = null;
      showChatPlaceholder();
      renderChatList();
      showNotif('Вы покинули группу');
    } else {
      showNotif(data.error || 'Ошибка', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

/* ══════════════════════════════════════════════
   ИЗОБРАЖЕНИЕ
══════════════════════════════════════════════ */
function openImageModal(url) {
  if (DOM.modalImageEl) DOM.modalImageEl.src = url;
  openModal('modal-image');
}

/* ══════════════════════════════════════════════
   КОНТАКТЫ
══════════════════════════════════════════════ */
function renderContactsPanel() {
  renderContactsList();
  renderRequestsList();
}

function renderContactsList() {
  if (!DOM.contactsList) return;
  const contacts = [...App.contacts.values()];
  if (!contacts.length) {
    DOM.contactsList.innerHTML =
      `<div style="text-align:center;padding:24px;color:var(--text2)">
         <div style="font-size:36px">👥</div>
         <div>Нет контактов</div>
       </div>`;
    return;
  }
  DOM.contactsList.innerHTML = contacts.map(c => {
    const av = c.avatar
      ? `<img class="avatar-img" src="${escHtml(c.avatar)}" alt="">`
      : getInitialsEmoji(c.username);
    return `
      <div class="contact-item">
        <div class="ci-avatar">${av}</div>
        <div class="ci-body">
          <span class="ci-name">${escHtml(c.username)}</span>
          <span class="ci-sub${c.online ? ' online' : ''}">
            ${c.online ? 'В сети' : 'Не в сети'}
          </span>
        </div>
        <button class="btn-sm" onclick="createPrivateChat(${c.id})">Написать</button>
      </div>`;
  }).join('');
}

function renderRequestsList() {
  if (!DOM.requestsList) return;
  const reqs = App._pendingRequests;
  if (!reqs.length) { DOM.requestsList.innerHTML = ''; return; }
  DOM.requestsList.innerHTML = reqs.map(r => {
    const av = r.avatar
      ? `<img class="avatar-img" src="${escHtml(r.avatar)}" alt="">`
      : getInitialsEmoji(r.username);
    return `
      <div class="contact-item" data-from="${r.fromId}">
        <div class="ci-avatar">${av}</div>
        <div class="ci-body">
          <span class="ci-name">${escHtml(r.username)}</span>
          <span class="ci-sub">Запрос в контакты</span>
        </div>
        <button class="btn-sm success" onclick="acceptContact(${r.fromId})">✓</button>
        <button class="btn-sm danger"  onclick="rejectContact(${r.fromId})">✕</button>
      </div>`;
  }).join('');
}

function onContactRequest(data) {
  App._pendingRequests.push({
    fromId: data.fromId, username: data.username, avatar: data.avatar,
  });
  showNotif(`${data.username} хочет добавить вас в контакты`);
  if (App.activeTab === 'contacts') renderContactsPanel();
}

function onContactAccepted(data) {
  App.contacts.set(data.id, data);
  App._pendingRequests = App._pendingRequests.filter(r => r.fromId !== data.id);
  showNotif(`${data.username} принял(а) запрос`, 'success');
  if (App.activeTab === 'contacts') renderContactsPanel();
}

async function acceptContact(fromId) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch('/api/contacts/accept', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ fromId }),
    });
    const data = await res.json();
    if (data.ok) {
      App._pendingRequests = App._pendingRequests.filter(r => r.fromId !== fromId);
      if (data.contact) App.contacts.set(data.contact.id, data.contact);
      showNotif('Контакт добавлен', 'success');
      renderContactsPanel();
    } else {
      showNotif(data.error || 'Ошибка', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

async function rejectContact(fromId) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch('/api/contacts/reject', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ fromId }),
    });
    const data = await res.json();
    if (data.ok) {
      App._pendingRequests = App._pendingRequests.filter(r => r.fromId !== fromId);
      renderContactsPanel();
    } else {
      showNotif(data.error || 'Ошибка', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

/* ══════════════════════════════════════════════
   EXPLORE
══════════════════════════════════════════════ */
function onGroupsExplore(data) {
  if (!DOM.exploreList) return;
  const groups = data.groups || [];
  if (!groups.length) {
    DOM.exploreList.innerHTML =
      `<div style="text-align:center;padding:24px;color:var(--text2)">
         <div style="font-size:36px">🔍</div>
         <div>Группы не найдены</div>
       </div>`;
    return;
  }
  DOM.exploreList.innerHTML = groups.map(g => {
    const av = g.avatar
      ? `<img class="avatar-img" src="${escHtml(g.avatar)}" alt="">`
      : getInitialsEmoji(g.name);
    const joined = App.chats.has(g.id);
    return `
      <div class="contact-item">
        <div class="ci-avatar">${av}</div>
        <div class="ci-body">
          <span class="ci-name">${escHtml(g.name)}</span>
          <span class="ci-sub">${g.member_count || 0} участников</span>
        </div>
        ${joined
          ? `<button class="btn-sm" onclick="openChat(${g.id})">Открыть</button>`
          : `<button class="btn-sm success" onclick="joinGroup(${g.id})">Вступить</button>`
        }
      </div>`;
  }).join('');
}

function searchGroups() {
  const q = $('explore-input')?.value.trim() || '';
  App.socket?.emit('groups:explore', { query: q });
}

async function joinGroup(groupId) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch(`/api/chats/${groupId}/join`, {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json();
    if (data.ok && data.chat) {
      App.chats.set(data.chat.id, { info: data.chat, messages: [] });
      renderChatList();
      openChat(data.chat.id);
      switchTab('chats');
      showNotif('Вы вступили в группу', 'success');
    } else {
      showNotif(data.error || 'Ошибка', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

/* ══════════════════════════════════════════════
   ВСПОМОГАТЕЛЬНЫЕ ОБРАБОТЧИКИ
══════════════════════════════════════════════ */
function onMsgInput()    { autoResizeInput(); sendTyping(); }
function onMsgKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}
function cancelReply()      { clearReplyBar(); }
function cancelEdit()       { clearEditBar(); }
function onMessagesScroll() {}
function toggleAttachMenu() { DOM.attachMenu?.classList.toggle('hidden'); }
function pickFile(accept)   {
  if (DOM.fileInput) DOM.fileInput.accept = accept;
  DOM.fileInput?.click();
  DOM.attachMenu?.classList.add('hidden');
}

/* ══════════════════════════════════════════════
   ГЛОБАЛЬНЫЙ ЭКСПОРТ
══════════════════════════════════════════════ */
function getMyId() {
  // 1) из состояния приложения
  let id =
    App?.me?.id ??
    App?.user?.id ??
    App?.profile?.id ??
    null;

  // 2) из storage
  if (!id) {
    id =
      sessionStorage.getItem('user_id') ||
      localStorage.getItem('user_id') ||
      null;
  }

  // 3) из JWT (chat_token)
  if (!id) {
    const token = sessionStorage.getItem('chat_token');
    if (token && token.split('.').length === 3) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        id = payload.userId ?? payload.id ?? payload.sub ?? null;
      } catch {}
    }
  }

  id = Number(id);
  return Number.isFinite(id) && id > 0 ? id : null;
}
function exposeGlobals() {
  Object.assign(window, {
    openChat, goBack, switchTab,
    onSearchInput, clearSearch,
    sendMessage, cancelReply, cancelEdit,
    toggleAttachMenu, pickFile,
    onMsgInput, onMsgKeydown, onMessagesScroll,
    openMyProfile, saveProfile, changeAvatar,
    openNewChat, switchNewChatTab, searchUsers,
    ncSelectUser, createGroup,
    openChatInfo, changeChatAvatar, leaveChat,
    openImageModal, closeOverlay, closeModal,
    ctxReply, ctxCopy, ctxEdit, ctxReact, ctxDelete,
    pickReaction, sendReaction,
    acceptContact, rejectContact,
    createPrivateChat, searchGroups, joinGroup,
    doLogin, doLogout, doRegister, switchAuthTab,
    Theme,
  });
}
exposeGlobals();

/* ══════════════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ
══════════════════════════════════════════════ */
async function init() {
  try {
    initDOM();
    Theme.init();
    registerSW();
    await PushNotif.request();

    const token   = sessionStorage.getItem('chat_token');
    const session = sessionStorage.getItem('chat_session');
    if (token && session) {
      try { App.currentUser = JSON.parse(session); } catch {}
    }

    connectSocket();
    if (!token) showAuth();

    DOM.backBtn      && DOM.backBtn.addEventListener('click', goBack);
    DOM.searchInput  && DOM.searchInput.addEventListener('input', onSearchInput);
    DOM.searchClear  && DOM.searchClear.addEventListener('click', clearSearch);
    DOM.msgInput     && DOM.msgInput.addEventListener('input',   onMsgInput);
    DOM.msgInput     && DOM.msgInput.addEventListener('keydown', onMsgKeydown);
    DOM.messagesArea && DOM.messagesArea.addEventListener('scroll', onMessagesScroll);
    DOM.sendBtn      && DOM.sendBtn.addEventListener('click', sendMessage);
    DOM.fileInput    && DOM.fileInput.addEventListener('change', onFileSelected);
    DOM.overlay      && DOM.overlay.addEventListener('click', closeOverlay);

    $('login-password')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
    $('reg-password2')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') doRegister();
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeOverlay();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && App.currentChat) {
        App.unread.set(App.currentChat, 0);
        renderChatList();
      }
    });

    let _tx0 = 0;
    document.addEventListener('touchstart', e => {
      _tx0 = e.touches[0].clientX;
    }, { passive: true });

    document.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - _tx0;
      if (dx > 80 && window.innerWidth <= 700 && App.currentChat) goBack();
    }, { passive: true });

  } catch (e) {
    console.error('❌ init failed:', e);
    showAuth();
  } finally {
    console.log('✅ SecureChat ready');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
