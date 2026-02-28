'use strict';

/* ─── СОСТОЯНИЕ ─── */
const App = {
  socket:       null,
  currentUser:  null,
  currentChat:  null,
  chats:        new Map(),
  contacts:     new Map(),
  typingTimers: new Map(),
  replyTo:      null,
  editMsg:      null,
  keyPair:      null,
  sharedKeys:   new Map(),
  unread:       new Map(),
  activeTab:    'chats',
  searchQuery:  '',
  e2eEnabled:   false,
  _pendingRequests: [],
  _ctxMsg:      null,
};

const $ = id => document.getElementById(id);
const DOM = {};

function initDOM() {
  Object.assign(DOM, {
    screenAuth:      $('screen-auth'),
    screenApp:       $('screen-app'),
    myAvatar:        $('my-avatar-el'),
    searchInput:     $('search-input'),
    searchClear:     $('search-clear'),
    chatList:        $('chat-list'),
    contactsPanel:   $('contacts-panel'),
    contactsList:    $('contacts-list'),
    requestsList:    $('requests-list'),
    explorePanel:    $('explore-panel'),
    exploreList:     $('explore-list'),
    chatPlaceholder: $('chat-placeholder'),
    chatWrap:        $('chat-wrap'),
    backBtn:         $('back-btn'),
    chAvatar:        $('ch-avatar'),
    chName:          $('ch-name'),
    chStatus:        $('ch-status'),
    messagesList:    $('messages-list'),
    messagesArea:    $('messages-area'),
    replyBar:        $('reply-bar'),
    replyText:       $('reply-bar-text'),
    editBar:         $('edit-bar'),
    editText:        $('edit-bar-text'),
    fileInput:       $('file-input'),
    msgInput:        $('msg-input'),
    sendBtn:         $('send-btn'),
    attachMenu:      $('attach-menu'),
    notifications:   $('notifications'),
    overlay:         $('overlay'),
    msgCtxMenu:      $('msg-ctx-menu'),
    reactionPicker:  $('reaction-picker'),
    modalProfile:    $('modal-profile'),
    profileAvatar:   $('profile-avatar-el'),
    profileUsername: $('profile-username-el'),
    profileBio:      $('profile-bio'),
    modalNewChat:    $('modal-new-chat'),
    ncUserSearch:    $('nc-user-search'),
    ncUserList:      $('nc-user-list'),
    ncGroupName:     $('nc-group-name'),
    modalChatInfo:   $('modal-chat-info'),
    chatInfoTitle:   $('chat-info-title'),
    chatInfoAvatar:  $('chat-info-avatar'),
    chatInfoName:    $('chat-info-name'),
    chatInfoMeta:    $('chat-info-meta'),
    chatInfoLeave:   $('chat-info-leave-btn'),
    chatInfoAvatarBtn: $('chat-info-avatar-btn'),
    modalImage:      $('modal-image'),
    modalImageEl:    $('modal-image-el'),
  });
}

/* ══════════════════════════════════════════════
   УТИЛИТЫ
══════════════════════════════════════════════ */
function getInitialsEmoji(name) {
  return `<span>${(name || '?')[0].toUpperCase()}</span>`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 86_400_000 && d.getDate() === now.getDate()) return 'Сегодня';
  if (diff < 172_800_000) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function formatSize(bytes) {
  if (bytes < 1024)    return bytes + ' Б';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1048576).toFixed(1) + ' МБ';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showNotif(text, type = 'info', duration = 3500) {
  if (!DOM.notifications) return;
  const el = document.createElement('div');
  el.className = `notif${type === 'error' ? ' error' : type === 'success' ? ' success' : ''}`;
  el.textContent = text;
  DOM.notifications.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function updateDocTitle() {
  let total = 0;
  App.unread.forEach(v => { total += v; });
  document.title = total > 0 ? `(${total > 99 ? '99+' : total}) SecureChat` : 'SecureChat';
}

/* ══════════════════════════════════════════════
   ТЕМА
══════════════════════════════════════════════ */
const Theme = {
  init() {
    const saved  = localStorage.getItem('chat_theme');
    const prefer = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
    this.apply(saved || prefer);
  },
  apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('chat_theme', theme);
  },
  toggle() {
    const curr = document.documentElement.getAttribute('data-theme');
    this.apply(curr === 'dark' ? 'light' : 'dark');
  },
};

/* ══════════════════════════════════════════════
   PUSH / ЗВУК
══════════════════════════════════════════════ */
const PushNotif = {
  allowed: false,
  async request() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') { this.allowed = true; return; }
    if (Notification.permission !== 'denied') {
      const p = await Notification.requestPermission();
      this.allowed = p === 'granted';
    }
  },
  send(title, body) {
    if (!this.allowed || document.visibilityState === 'visible') return;
    try { new Notification(title, { body, icon: '/icons/icon-192.png' }); } catch {}
  },
};

const Sound = {
  _ctx: null,
  playBeep() {
    if (localStorage.getItem('chat_sound') === 'off') return;
    try {
      if (!this._ctx)
        this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.connect(gain);
      gain.connect(this._ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, this._ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.0001, this._ctx.currentTime + 0.35
      );
      osc.start(this._ctx.currentTime);
      osc.stop(this._ctx.currentTime + 0.35);
    } catch {}
  },
};

/* ══════════════════════════════════════════════
   SERVICE WORKER
══════════════════════════════════════════════ */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(r => console.log('SW зарегистрирован:', r.scope))
      .catch(e => console.warn('SW ошибка:', e));
  }
}
/* ══════════════════════════════════════════════
   SOCKET.IO
══════════════════════════════════════════════ */
function connectSocket() {
  if (App.socket) {
    App.socket.disconnect();
    App.socket = null;
  }

  App.socket = io({ transports: ['websocket', 'polling'] });

  App.socket.on('connect', () => {
    console.log('Socket connected:', App.socket.id);
    const token = sessionStorage.getItem('chat_token');
    if (token) {
      App.socket.emit('auth', { token });
    }
  });

  App.socket.on('disconnect', () =>
    showNotif('Соединение потеряно…', 'error')
  );
  App.socket.on('connect_error', (e) => {
    console.error('connect_error', e);
    showNotif('Ошибка подключения', 'error');
  });

  App.socket.on('auth:ok',          onAuthOk);
  App.socket.on('auth:error',       onAuthErr);
  App.socket.on('chat:new',         onChatNew);
  App.socket.on('chat:updated',     onChatUpdated);
  App.socket.on('chat:joined',      onChatJoined);
  App.socket.on('chat:left',        onChatLeft);
  App.socket.on('msg:new',          onMsgNew);
  App.socket.on('msg:edited',       onMsgEdited);
  App.socket.on('msg:deleted',      onMsgDeleted);
  App.socket.on('msg:reaction',     onMsgReaction);
  App.socket.on('contact:request',  onContactRequest);
  App.socket.on('contact:accepted', onContactAccepted);
  App.socket.on('groups:list',      onGroupsExplore);
  App.socket.on('user:online',      onUserOnline);
  App.socket.on('chat:typing',      onChatTyping);
  App.socket.on('e2e:pubkey',       onE2EPubkey);
}

/* ══════════════════════════════════════════════
   АВТОРИЗАЦИЯ
══════════════════════════════════════════════ */
window.switchAuthTab = function(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
  if (tab === 'login') {
    document.querySelectorAll('.auth-tab')[0].classList.add('active');
    $('tab-login').classList.remove('hidden');
  } else {
    document.querySelectorAll('.auth-tab')[1].classList.add('active');
    $('tab-register').classList.remove('hidden');
  }
};

window.doLogin = async function() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  $('login-err').textContent = '';

  if (!username || !password) {
    $('login-err').textContent = 'Заполните все поля';
    return;
  }

  try {
    const res  = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!data.ok) {
      const msgs = {
        wrong_credentials: 'Неверный логин или пароль',
        rate_limited:      'Слишком много попыток, подождите',
        missing_fields:    'Заполните все поля',
        server_error:      'Ошибка сервера',
      };
      $('login-err').textContent = msgs[data.error] || data.error;
      return;
    }

    sessionStorage.setItem('chat_token', data.token);

    if (App.socket && App.socket.connected) {
      App.socket.emit('auth', { token: data.token });
    } else {
      connectSocket();
    }

  } catch(e) {
    $('login-err').textContent = 'Ошибка: ' + e.message;
    console.error(e);
  }
};

window.doRegister = async function() {
  const username  = $('reg-username').value.trim();
  const password  = $('reg-password').value;
  const password2 = $('reg-password2').value;
  $('reg-err').textContent = '';

  if (!username || !password) {
    $('reg-err').textContent = 'Заполните все поля';
    return;
  }
  if (password !== password2) {
    $('reg-err').textContent = 'Пароли не совпадают';
    return;
  }
  if (password.length < 6) {
    $('reg-err').textContent = 'Минимум 6 символов';
    return;
  }

  try {
    const res  = await fetch('/api/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!data.ok) {
      const msgs = {
        username_taken:  'Имя пользователя занято',
        username_length: 'Имя: от 2 до 32 символов',
        password_short:  'Минимум 4 символа',
        rate_limited:    'Слишком много попыток',
        server_error:    'Ошибка сервера',
      };
      $('reg-err').textContent = msgs[data.error] || data.error;
      return;
    }

    sessionStorage.setItem('chat_token', data.token);

    if (App.socket && App.socket.connected) {
      App.socket.emit('auth', { token: data.token });
    } else {
      connectSocket();
    }

  } catch(e) {
    $('reg-err').textContent = 'Ошибка: ' + e.message;
    console.error(e);
  }
};

window.doLogout = async function() {
  const token = sessionStorage.getItem('chat_token');
  if (token) {
    try {
      await fetch('/api/logout', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
    } catch {}
  }
  sessionStorage.removeItem('chat_token');
  sessionStorage.removeItem('chat_session');
  if (App.socket) {
    App.socket.disconnect();
    App.socket = null;
  }
  showAuth();
};

async function onAuthOk(data) {
  App.currentUser = data;
  sessionStorage.setItem('chat_session', JSON.stringify(data));

  if (App.e2eEnabled && App.keyPair) {
    try {
      const pubKey = await E2E.exportPublicKey(App.keyPair.publicKey);
      App.socket.emit('e2e:pubkey', { pubKey });
    } catch(e) { console.warn('E2E export:', e); }
  }

  showApp();
  await loadChats();
  await loadContacts();
}

function onAuthErr(data) {
  const err = data?.error || data?.message || 'Ошибка авторизации';
  const loginForm = $('tab-login');
  if (loginForm && !loginForm.classList.contains('hidden')) {
    $('login-err').textContent = err;
  } else {
    $('reg-err').textContent = err;
  }
}

function showApp() {
  DOM.screenAuth.classList.add('hidden');
  DOM.screenApp.classList.remove('hidden');
  renderMyAvatar();
}

function showAuth() {
  DOM.screenApp.classList.add('hidden');
  DOM.screenAuth.classList.remove('hidden');
  App.currentUser = null;
  App.currentChat = null;
  App.chats.clear();
  App.contacts.clear();
  App._pendingRequests = [];
  App.unread.clear();
  sessionStorage.removeItem('chat_session');
}

function renderMyAvatar() {
  if (!App.currentUser || !DOM.myAvatar) return;
  const u = App.currentUser;
  DOM.myAvatar.innerHTML = u.avatar
    ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
    : getInitialsEmoji(u.username);
}

/* ══════════════════════════════════════════════
   ЗАГРУЗКА ЧАТОВ И КОНТАКТОВ (REST)
══════════════════════════════════════════════ */
async function loadChats() {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch('/api/chats', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json();
    if (data.ok) {
      App.chats.clear();
      data.chats.forEach(chat => {
        App.chats.set(chat.id, { info: chat, messages: [] });
      });
      renderChatList();
    }
  } catch(e) { console.error('loadChats:', e); }
}

async function loadContacts() {
  const token = sessionStorage.getItem('chat_token');
  try {
    const [cRes, rRes] = await Promise.all([
      fetch('/api/contacts',          { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch('/api/contacts/requests', { headers: { 'Authorization': 'Bearer ' + token } }),
    ]);
    const [cData, rData] = await Promise.all([cRes.json(), rRes.json()]);

    if (cData.ok) {
      App.contacts.clear();
      cData.contacts.forEach(c => App.contacts.set(c.id, c));
    }
    if (rData.ok) {
      App._pendingRequests = rData.requests.map(r => ({
        fromId:   r.id,
        username: r.username,
        avatar:   r.avatar,
      }));
    }
  } catch(e) { console.error('loadContacts:', e); }
}

/* ══════════════════════════════════════════════
   E2E
══════════════════════════════════════════════ */
async function onE2EPubkey(data) {
  if (!App.e2eEnabled || !data.userId || !data.pubKey) return;
  try {
    const theirPub  = await E2E.importPublicKey(data.pubKey);
    const sharedKey = await E2E.deriveSharedKey(App.keyPair.privateKey, theirPub);
    App.chats.forEach((chat, chatId) => {
      if (chat.info.type === 'private') {
        App.sharedKeys.set(chatId, sharedKey);
      }
    });
  } catch(e) { console.warn('E2E:', e); }
}
/* ══════════════════════════════════════════════
   SOCKET — СОБЫТИЯ ЧАТОВ
══════════════════════════════════════════════ */
function onChatNew(data) {
  const chat = data.chat || data;
  if (!App.chats.has(chat.id)) {
    App.chats.set(chat.id, { info: chat, messages: [] });
  }
  renderChatList();
}

function onChatUpdated(chat) {
  const existing = App.chats.get(chat.id);
  if (existing) existing.info = { ...existing.info, ...chat };
  else App.chats.set(chat.id, { info: chat, messages: [] });
  renderChatList();
  if (App.currentChat === chat.id) renderChatHeader();
}

function onChatJoined(data) {
  loadChats();
}

function onChatLeft(data) {
  App.chats.delete(data.chatId);
  if (App.currentChat === data.chatId) {
    App.currentChat = null;
    showChatPlaceholder();
  }
  renderChatList();
  showNotif('Вы покинули чат');
}

/* ══════════════════════════════════════════════
   РЕНДЕР СПИСКА ЧАТОВ
══════════════════════════════════════════════ */
function renderChatList() {
  const q = App.searchQuery.toLowerCase();
  let chats = [...App.chats.values()];
  if (q) chats = chats.filter(c => c.info.name?.toLowerCase().includes(q));
  chats.sort((a, b) => {
    const at = a.info.last_msg_at ? new Date(a.info.last_msg_at).getTime() : 0;
    const bt = b.info.last_msg_at ? new Date(b.info.last_msg_at).getTime() : 0;
    return bt - at;
  });

  if (!chats.length) {
    DOM.chatList.innerHTML = `
      <div style="text-align:center;padding:32px 16px;color:var(--text2)">
        <div style="font-size:40px">💬</div>
        <div>${q ? 'Ничего не найдено' : 'Нет чатов'}</div>
      </div>`;
    updateDocTitle();
    return;
  }

  DOM.chatList.innerHTML = chats.map(c => {
    const info   = c.info;
    const unread = App.unread.get(info.id) || 0;
    const active = App.currentChat === info.id;
    const avatar = info.avatar
      ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
      : getInitialsEmoji(info.name);
    const lastMsg = info.last_msg
      ? escHtml(info.last_msg).slice(0, 42)
      : '<span style="opacity:.5">Нет сообщений</span>';
    const timeStr = info.last_msg_at ? formatTime(info.last_msg_at) : '';
    const badge   = unread > 0
      ? `<span class="ci-badge">${unread > 99 ? '99+' : unread}</span>` : '';

    return `
      <div class="chat-item${active ? ' active' : ''}"
           data-id="${info.id}"
           onclick="openChat(${info.id})">
        <div class="ci-avatar">${avatar}</div>
        <div class="ci-body">
          <div class="ci-top">
            <span class="ci-name">
              ${escHtml(info.name)}${info.type === 'group' ? ' 👥' : ''}
            </span>
            <span class="ci-time">${timeStr}</span>
          </div>
          <div class="ci-bottom">
            <span class="ci-last">${lastMsg}</span>
            ${badge}
          </div>
        </div>
      </div>`;
  }).join('');

  updateDocTitle();
}

/* ══════════════════════════════════════════════
   ОТКРЫТИЕ ЧАТА
══════════════════════════════════════════════ */
function openChat(chatId) {
  chatId = +chatId;
  if (App.currentChat === chatId) return;
  App.currentChat = chatId;
  App.unread.set(chatId, 0);

  if (window.innerWidth <= 700) {
    $('sidebar').classList.add('hidden-mobile');
    DOM.backBtn.classList.remove('hidden');
  }

  DOM.chatPlaceholder.classList.add('hidden');
  DOM.chatWrap.classList.remove('hidden');

  renderChatHeader();
  renderChatList();
  clearReplyBar();
  clearEditBar();
  DOM.msgInput.value = '';
  autoResizeInput();

  App.socket.emit('chat:join', { chatId });

  const chat = App.chats.get(chatId);
  if (chat && chat.messages.length === 0) {
    loadMessages(chatId);
  } else {
    renderMessages();
  }
}

async function loadMessages(chatId) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch(
      `/api/chats/${chatId}/messages?limit=50`,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const data = await res.json();
    if (!data.ok) return;
    const chat = App.chats.get(chatId);
    if (!chat) return;
    chat.messages = data.messages || [];
    if (App.currentChat === chatId) renderMessages();
  } catch(e) {
    console.error('loadMessages:', e);
  }
}

function showChatPlaceholder() {
  DOM.chatWrap.classList.add('hidden');
  DOM.chatPlaceholder.classList.remove('hidden');
  DOM.backBtn.classList.add('hidden');
}

/* ══════════════════════════════════════════════
   ШАПКА ЧАТА
══════════════════════════════════════════════ */
function renderChatHeader() {
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const info = chat.info;

  DOM.chAvatar.innerHTML = info.avatar
    ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
    : getInitialsEmoji(info.name);
  DOM.chName.textContent = info.name;

  if (info.type === 'group') {
    DOM.chStatus.textContent = `${info.member_count || 0} участников`;
    DOM.chStatus.className   = 'ch-status';
  } else {
    DOM.chStatus.textContent = info.online ? 'В сети' : 'Не в сети';
    DOM.chStatus.className   = `ch-status${info.online ? ' online' : ''}`;
  }
}

/* ══════════════════════════════════════════════
   ОНЛАЙН / ОФЛАЙН
══════════════════════════════════════════════ */
function onUserOnline(data) {
  App.chats.forEach((chat, id) => {
    if (chat.info.type === 'private') {
      chat.info.online = data.online;
      if (App.currentChat === id) renderChatHeader();
    }
  });
  renderChatList();
}

/* ══════════════════════════════════════════════
   ПЕЧАТАЕТ…
══════════════════════════════════════════════ */
function onChatTyping(data) {
  if (data.chatId !== App.currentChat || data.userId === App.currentUser?.id) return;
  const prev  = DOM.chStatus.textContent;
  const prevC = DOM.chStatus.className;
  DOM.chStatus.textContent = 'печатает…';
  DOM.chStatus.className   = 'ch-status';
  clearTimeout(App.typingTimers.get(App.currentChat));
  App.typingTimers.set(App.currentChat, setTimeout(() => {
    DOM.chStatus.textContent = prev;
    DOM.chStatus.className   = prevC;
  }, 3000));
}

/* ══════════════════════════════════════════════
   ТАБЫ САЙДБАРА
══════════════════════════════════════════════ */
function switchTab(tab) {
  App.activeTab = tab;
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  $(`stab-${tab}`)?.classList.add('active');

  DOM.chatList.classList.toggle('hidden',      tab !== 'chats');
  DOM.contactsPanel.classList.toggle('hidden', tab !== 'contacts');
  DOM.explorePanel.classList.toggle('hidden',  tab !== 'explore');

  if (tab === 'contacts') {
    loadContacts().then(() => renderContactsPanel());
  }

  if (tab === 'explore') {
    App.socket.emit('groups:explore', { query: '' });
  }
}

/* ══════════════════════════════════════════════
   ПРОЧИЕ ОБРАБОТЧИКИ САЙДБАРА
══════════════════════════════════════════════ */
function goBack() {
  $('sidebar')?.classList.remove('hidden-mobile');
  DOM.backBtn.classList.add('hidden');
  App.currentChat = null;
  showChatPlaceholder();
  renderChatList();
}

function onSearchInput() {
  App.searchQuery = DOM.searchInput.value.trim();
  DOM.searchClear.classList.toggle('hidden', !App.searchQuery);
  renderChatList();
}

function clearSearch() {
  DOM.searchInput.value = '';
  App.searchQuery = '';
  DOM.searchClear.classList.add('hidden');
  renderChatList();
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
    if (msg) {
      msg.content   = data.content;
      msg.edited_at = data.editedAt;
    }
  });

  if (App.currentChat) {
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
}

function onMsgDeleted(data) {
  App.chats.forEach(chat => {
    chat.messages = chat.messages.filter(m => m.msg_id !== data.msgId);
  });
  const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
  if (el) {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }
}

function onMsgReaction(data) {
  // Обновляем реакции в массиве сообщений
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
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const msgs    = chat.messages;
  const prev    = msgs[msgs.length - 2];
  const prevDate = prev
    ? new Date(prev.created_at || prev.ts).toDateString()
    : null;
  const newDate = new Date(msg.created_at || msg.ts).toDateString();

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
  wrap.addEventListener('touchend',   () => clearTimeout(lpt));
  wrap.addEventListener('touchmove',  () => clearTimeout(lpt));

  return wrap;
}

function buildMsgInner(msg, isMine) {
  const username  = msg.username    || msg.senderName   || '';
  const avatar    = msg.avatar      || msg.senderAvatar || '';
  const content   = msg.content     || msg.text         || '';
  const ts        = msg.created_at  || msg.ts;
  const reactions = msg.reactions   || [];
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
    return `<div class="msg-text" style="opacity:.5;font-style:italic">
              Сообщение удалено
            </div>`;
  }

  if (msg.type === 'image' ||
      (msg.mime_type && msg.mime_type.startsWith('image/'))) {
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
    return `<a class="msg-file"
               href="${escHtml(url)}"
               target="_blank"
               download>
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
  t = t.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener" class="msg-link">$1</a>'
  );
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
  DOM.messagesArea.scrollTo({
    top:      DOM.messagesArea.scrollHeight,
    behavior: smooth ? 'smooth' : 'instant',
  });
}

/* ══════════════════════════════════════════════
   ВВОД И ОТПРАВКА СООБЩЕНИЙ
══════════════════════════════════════════════ */
async function sendMessage() {
  if (!App.currentChat) return;
  const text = DOM.msgInput.value.trim();

  if (App.editMsg) {
    if (!text) return;
    App.socket.emit('msg:edit', {
      msgId:   App.editMsg.msgId,
      content: text,
    });
    clearEditBar();
    DOM.msgInput.value = '';
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

  DOM.msgInput.value = '';
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
  App.socket.emit('chat:typing', {
    chatId:   App.currentChat,
    isTyping: true,
  });
  _typingTimer = setTimeout(() => {
    App.socket.emit('chat:typing', {
      chatId:   App.currentChat,
      isTyping: false,
    });
  }, 2500);
}

async function onFileSelected() {
  const file = DOM.fileInput.files[0];
  if (!file || !App.currentChat) return;
  DOM.fileInput.value = '';

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
  DOM.replyBar.classList.add('hidden');
  DOM.replyText.textContent = '';
}

function openReplyBar(msg) {
  const content = msg.content || msg.text || '📎';
  const name    = msg.username || msg.senderName || '';
  App.replyTo   = { msgId: msg.msg_id || msg.id, text: content, senderName: name };
  DOM.replyText.textContent = `${name}: ${content.slice(0, 60)}`;
  DOM.replyBar.classList.remove('hidden');
  DOM.msgInput.focus();
}

function clearEditBar() {
  App.editMsg = null;
  DOM.editBar.classList.add('hidden');
  DOM.editText.textContent = '';
  DOM.msgInput.value = '';
  autoResizeInput();
}

function openEditBar(msg) {
  const content = msg.content || msg.text || '';
  App.editMsg   = { msgId: msg.msg_id || msg.id, content };
  DOM.editText.textContent = content.slice(0, 60);
  DOM.editBar.classList.remove('hidden');
  DOM.msgInput.value = content;
  DOM.msgInput.focus();
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
  menu.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');

  $('ctx-edit-btn').style.display = isMine ? '' : 'none';
  $('ctx-del-btn').style.display  = isMine ? '' : 'none';

  if (e) {
    let x = e.clientX;
    let y = e.clientY;
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

function ctxReply() {
  closeOverlay();
  if (_ctxMsg) openReplyBar(_ctxMsg);
}

function ctxCopy() {
  closeOverlay();
  const text = _ctxMsg?.content || _ctxMsg?.text;
  if (text) {
    navigator.clipboard.writeText(text)
      .then(()  => showNotif('Скопировано', 'success'))
      .catch(()  => showNotif('Не удалось скопировать', 'error'));
  }
}

function ctxEdit() {
  closeOverlay();
  if (_ctxMsg) openEditBar(_ctxMsg);
}

function ctxReact() {
  DOM.msgCtxMenu.classList.add('hidden');
  DOM.reactionPicker.classList.remove('hidden');
}

function ctxDelete() {
  closeOverlay();
  if (!_ctxMsg) return;
  if (!confirm('Удалить сообщение?')) return;
  App.socket.emit('msg:delete', {
    msgId: _ctxMsg.msg_id || _ctxMsg.id,
  });
}

function pickReaction(emoji) {
  DOM.reactionPicker.classList.add('hidden');
  DOM.overlay.classList.add('hidden');
  if (!_ctxMsg) return;
  App.socket.emit('msg:react', {
    msgId: _ctxMsg.msg_id || _ctxMsg.id,
    emoji,
  });
}

function sendReaction(emoji) {
  if (!_ctxMsg) return;
  App.socket.emit('msg:react', {
    msgId: _ctxMsg.msg_id || _ctxMsg.id,
    emoji,
  });
}

/* ══════════════════════════════════════════════
   ВСПОМОГАТЕЛЬНЫЕ ОБРАБОТЧИКИ ВВОДА
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

function toggleAttachMenu() {
  DOM.attachMenu.classList.toggle('hidden');
}

function pickFile(accept) {
  DOM.fileInput.accept = accept;
  DOM.fileInput.click();
  DOM.attachMenu.classList.add('hidden');
}
/* ══════════════════════════════════════════════
   OVERLAY / ЗАКРЫТИЕ
══════════════════════════════════════════════ */
function closeOverlay() {
  DOM.overlay.classList.add('hidden');
  DOM.msgCtxMenu.classList.add('hidden');
  DOM.reactionPicker.classList.add('hidden');
  DOM.modalProfile.classList.add('hidden');
  DOM.modalNewChat.classList.add('hidden');
  DOM.modalChatInfo.classList.add('hidden');
  DOM.modalImage.classList.add('hidden');
  _ctxMsg  = null;
  _ctxMine = false;
}

/* ══════════════════════════════════════════════
   МОДАЛКА — ПРОФИЛЬ
══════════════════════════════════════════════ */
function openProfileModal() {
  if (!App.currentUser) return;
  const u = App.currentUser;

  DOM.profileAvatar.innerHTML = u.avatar
    ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
    : getInitialsEmoji(u.username);

  DOM.profileUsername.textContent = u.username;
  DOM.profileBio.value            = u.bio || '';

  DOM.modalProfile.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
}

async function saveProfile() {
  const bio    = DOM.profileBio.value.trim();
  const token  = sessionStorage.getItem('chat_token');

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
      closeOverlay();
    } else {
      showNotif(data.error || 'Ошибка сохранения', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

async function uploadAvatar() {
  const input   = document.createElement('input');
  input.type    = 'file';
  input.accept  = 'image/*';
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
        DOM.profileAvatar.innerHTML =
          `<img class="avatar-img" src="${escHtml(data.url)}" alt="">`;
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
   МОДАЛКА — НОВЫЙ ЧАТ
══════════════════════════════════════════════ */
function openNewChatModal() {
  DOM.ncUserSearch.value  = '';
  DOM.ncGroupName.value   = '';
  DOM.ncUserList.innerHTML = '';
  $('nc-group-section').classList.add('hidden');
  $('nc-mode-private').classList.add('active');
  $('nc-mode-group').classList.remove('active');
  DOM.modalNewChat.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
  renderNcContacts('');
}

function switchNcMode(mode) {
  $('nc-mode-private').classList.toggle('active', mode === 'private');
  $('nc-mode-group').classList.toggle('active',   mode === 'group');
  $('nc-group-section').classList.toggle('hidden', mode !== 'group');
}

function renderNcContacts(query) {
  const q        = query.toLowerCase();
  const contacts = [...App.contacts.values()].filter(c =>
    !q || c.username.toLowerCase().includes(q)
  );

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
        <button class="btn-sm" onclick="ncSelectUser(${c.id})">
          Выбрать
        </button>
      </div>`;
  }).join('');
}

function ncSearchInput() {
  renderNcContacts(DOM.ncUserSearch.value.trim());
}

async function ncSelectUser(userId) {
  const mode = $('nc-mode-group').classList.contains('active') ? 'group' : 'private';

  if (mode === 'group') {
    const item = DOM.ncUserList.querySelector(`[data-id="${userId}"]`);
    if (item) item.classList.toggle('selected');
    return;
  }

  // Приватный чат
  closeOverlay();
  await createPrivateChat(userId);
}

async function createPrivateChat(userId) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch('/api/chats/private', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
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

async function createGroupChat() {
  const name     = DOM.ncGroupName.value.trim();
  const selected = [...DOM.ncUserList.querySelectorAll('.contact-item.selected')]
    .map(el => +el.dataset.id);

  if (!name) {
    showNotif('Введите название группы', 'error');
    return;
  }
  if (selected.length < 1) {
    showNotif('Выберите хотя бы одного участника', 'error');
    return;
  }

  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch('/api/chats/group', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ name, members: selected }),
    });
    const data = await res.json();

    if (data.ok && data.chat) {
      App.chats.set(data.chat.id, { info: data.chat, messages: [] });
      renderChatList();
      openChat(data.chat.id);
      closeOverlay();
    } else {
      showNotif(data.error || 'Ошибка создания группы', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
}

/* ══════════════════════════════════════════════
   МОДАЛКА — ИНФОРМАЦИЯ О ЧАТЕ
══════════════════════════════════════════════ */
async function openChatInfo() {
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const info = chat.info;

  DOM.chatInfoAvatar.innerHTML = info.avatar
    ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
    : getInitialsEmoji(info.name);

  DOM.chatInfoName.textContent = info.name;

  if (info.type === 'group') {
    DOM.chatInfoTitle.textContent    = 'Информация о группе';
    DOM.chatInfoMeta.textContent     = `${info.member_count || 0} участников`;
    DOM.chatInfoLeave.classList.remove('hidden');
    DOM.chatInfoAvatarBtn.classList.remove('hidden');
  } else {
    DOM.chatInfoTitle.textContent    = 'Информация о пользователе';
    DOM.chatInfoMeta.textContent     = info.online ? 'В сети' : 'Не в сети';
    DOM.chatInfoLeave.classList.add('hidden');
    DOM.chatInfoAvatarBtn.classList.add('hidden');
  }

  // Загружаем участников группы
  const membersEl = $('chat-info-members');
  if (membersEl) {
    membersEl.innerHTML = '';
    if (info.type === 'group') {
      await loadGroupMembers(info.id, membersEl);
    }
  }

  DOM.modalChatInfo.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
}

async function loadGroupMembers(chatId, container) {
  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch(`/api/chats/${chatId}/members`, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json();
    if (!data.ok) return;

    container.innerHTML = data.members.map(m => {
      const av = m.avatar
        ? `<img class="avatar-img" src="${escHtml(m.avatar)}" alt="">`
        : getInitialsEmoji(m.username);
      return `
        <div class="contact-item">
          <div class="ci-avatar">${av}</div>
          <div class="ci-body">
            <span class="ci-name">${escHtml(m.username)}</span>
            <span class="ci-sub">${m.role === 'admin' ? '👑 Админ' : 'Участник'}</span>
          </div>
        </div>`;
    }).join('');
  } catch {
    container.innerHTML =
      '<div style="color:var(--text2);padding:12px">Ошибка загрузки</div>';
  }
}

async function uploadGroupAvatar() {
  const chat = App.chats.get(App.currentChat);
  if (!chat || chat.info.type !== 'group') return;

  const input   = document.createElement('input');
  input.type    = 'file';
  input.accept  = 'image/*';
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
      const res  = await fetch(
        `/api/chats/${App.currentChat}/avatar`,
        {
          method:  'POST',
          headers: { 'Authorization': 'Bearer ' + token },
          body:    formData,
        }
      );
      const data = await res.json();

      if (data.ok) {
        chat.info.avatar = data.url;
        DOM.chatInfoAvatar.innerHTML =
          `<img class="avatar-img" src="${escHtml(data.url)}" alt="">`;
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

async function leaveGroupChat() {
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
      closeOverlay();
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
   МОДАЛКА — ПРОСМОТР ИЗОБРАЖЕНИЯ
══════════════════════════════════════════════ */
function openImageModal(url) {
  DOM.modalImageEl.src = url;
  DOM.modalImage.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
}

/* ══════════════════════════════════════════════
   КОНТАКТЫ — РЕНДЕР ПАНЕЛИ
══════════════════════════════════════════════ */
function renderContactsPanel() {
  renderContactsList();
  renderRequestsList();
}

function renderContactsList() {
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
        <button class="btn-sm" onclick="createPrivateChat(${c.id})">
          Написать
        </button>
      </div>`;
  }).join('');
}

function renderRequestsList() {
  const reqs = App._pendingRequests;
  const wrap = $('requests-wrap');
  if (wrap) wrap.classList.toggle('hidden', !reqs.length);

  if (!reqs.length) {
    DOM.requestsList.innerHTML = '';
    return;
  }

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
    fromId:   data.fromId,
    username: data.username,
    avatar:   data.avatar,
  });
  showNotif(`${data.username} хочет добавить вас в контакты`);
  if (App.activeTab === 'contacts') renderContactsPanel();
}

function onContactAccepted(data) {
  App.contacts.set(data.id, data);
  App._pendingRequests = App._pendingRequests.filter(r => r.fromId !== data.id);
  showNotif(`${data.username} принял(а) запрос в контакты`, 'success');
  if (App.activeTab === 'contacts') renderContactsPanel();
}

async function sendContactRequest() {
  const input = $('contact-search-input');
  const query = input?.value.trim();
  if (!query) {
    showNotif('Введите имя пользователя', 'error');
    return;
  }

  const token = sessionStorage.getItem('chat_token');
  try {
    const res  = await fetch('/api/contacts/request', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ username: query }),
    });
    const data = await res.json();

    if (data.ok) {
      showNotif('Запрос отправлен', 'success');
      if (input) input.value = '';
    } else {
      const msgs = {
        user_not_found:    'Пользователь не найден',
        already_contact:   'Уже в контактах',
        request_exists:    'Запрос уже отправлен',
        cannot_add_self:   'Нельзя добавить себя',
      };
      showNotif(msgs[data.error] || data.error || 'Ошибка', 'error');
    }
  } catch {
    showNotif('Ошибка сети', 'error');
  }
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
   EXPLORE — ПУБЛИЧНЫЕ ГРУППЫ
══════════════════════════════════════════════ */
function onGroupsExplore(data) {
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

function exploreSearch() {
  const q = $('explore-search')?.value.trim() || '';
  App.socket.emit('groups:explore', { query: q });
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
      'spki',
      buf.buffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
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
      { name: 'AES-GCM', iv },
      sharedKey,
      enc.encode(plaintext)
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
      { name: 'AES-GCM', iv },
      sharedKey,
      ct
    );
    return new TextDecoder().decode(pt);
  },
};

/* ══════════════════════════════════════════════
   E2E — УПРАВЛЕНИЕ ИЗ UI
══════════════════════════════════════════════ */
async function toggleE2E() {
  const btn = $('e2e-toggle-btn');

  if (App.e2eEnabled) {
    App.e2eEnabled = false;
    App.keyPair    = null;
    App.sharedKeys.clear();
    if (btn) {
      btn.textContent = '🔓 E2E выкл.';
      btn.classList.remove('active');
    }
    showNotif('E2E-шифрование отключено');
    return;
  }

  try {
    App.keyPair    = await E2E.generateKeyPair();
    App.e2eEnabled = true;

    const pubKey = await E2E.exportPublicKey(App.keyPair.publicKey);
    App.socket.emit('e2e:pubkey', { pubKey });

    if (btn) {
      btn.textContent = '🔐 E2E вкл.';
      btn.classList.add('active');
    }
    showNotif('E2E-шифрование включено', 'success');
  } catch(e) {
    console.error('E2E init:', e);
    showNotif('Ошибка инициализации E2E', 'error');
  }
}

/* ══════════════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ
══════════════════════════════════════════════ */
async function init() {
  initDOM();
  Theme.init();
  registerSW();
  await PushNotif.request();

  /* ─── Восстановление сессии ─── */
  const token   = sessionStorage.getItem('chat_token');
  const session = sessionStorage.getItem('chat_session');

  if (token && session) {
    try {
      App.currentUser = JSON.parse(session);
    } catch {}
  }

  connectSocket();

  /* ─── Если нет токена — показываем экран авторизации ─── */
  if (!token) {
    showAuth();
  }

  /* ─── Кнопка «Назад» (мобильная) ─── */
  DOM.backBtn?.addEventListener('click', goBack);

  /* ─── Поиск ─── */
  DOM.searchInput?.addEventListener('input', onSearchInput);
  DOM.searchClear?.addEventListener('click', clearSearch);

  /* ─── Ввод сообщения ─── */
  DOM.msgInput?.addEventListener('input',   onMsgInput);
  DOM.msgInput?.addEventListener('keydown', onMsgKeydown);

  /* ─── Прокрутка ─── */
  DOM.messagesArea?.addEventListener('scroll', onMessagesScroll);

  /* ─── Отправка по кнопке ─── */
  DOM.sendBtn?.addEventListener('click', sendMessage);

  /* ─── Файл ─── */
  DOM.fileInput?.addEventListener('change', onFileSelected);

  /* ─── Overlay / закрытие ─── */
  DOM.overlay?.addEventListener('click', closeOverlay);

  /* ─── Enter в авторизации ─── */
  $('login-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  $('reg-password2')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doRegister();
  });

  /* ─── Клавиша Escape ─── */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeOverlay();
  });

  /* ─── Смена видимости вкладки (обновить unread) ─── */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && App.currentChat) {
      App.unread.set(App.currentChat, 0);
      renderChatList();
    }
  });

  /* ─── Touch-жест: закрытие чата свайпом вправо ─── */
  let _tx0 = 0;
  document.addEventListener('touchstart', e => {
    _tx0 = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _tx0;
    if (dx > 80 && window.innerWidth <= 700 && App.currentChat) {
      goBack();
    }
  }, { passive: true });

  /* ─── PWA install prompt ─── */
  let _installPrompt;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _installPrompt = e;
    const btn = $('install-btn');
    if (btn) btn.classList.remove('hidden');
  });
  window.installApp = async function() {
    if (!_installPrompt) return;
    await _installPrompt.prompt();
    const result = await _installPrompt.userChoice;
    if (result.outcome === 'accepted') {
      $('install-btn')?.classList.add('hidden');
    }
    _installPrompt = null;
  };

  /* ─── Глобальные хелперы для HTML onclick= ─── */
  Object.assign(window, {
    openChat,
    goBack,
    switchTab,
    onSearchInput,
    clearSearch,
    sendMessage,
    cancelReply,
    cancelEdit,
    toggleAttachMenu,
    pickFile,
    onMsgInput,
    onMsgKeydown,
    onMessagesScroll,
    openProfileModal,
    saveProfile,
    uploadAvatar,
    openNewChatModal,
    switchNcMode,
    ncSearchInput,
    ncSelectUser,
    createGroupChat,
    openChatInfo,
    uploadGroupAvatar,
    leaveGroupChat,
    openImageModal,
    closeOverlay,
    ctxReply,
    ctxCopy,
    ctxEdit,
    ctxReact,
    ctxDelete,
    pickReaction,
    sendReaction,
    sendContactRequest,
    acceptContact,
    rejectContact,
    createPrivateChat,
    exploreSearch,
    joinGroup,
    toggleE2E,
    doLogin,
    doLogout,
    doRegister,
    switchAuthTab,
    Theme,
  });

  console.log('✅ SecureChat инициализирован');
}

/* ══════════════════════════════════════════════
   ТОЧКА ВХОДА
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
