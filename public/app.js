/* ══════════════════════════════════════════════
   APP.JS — Главный файл приложения
   Часть 1: Состояние, инициализация, авторизация
══════════════════════════════════════════════ */

'use strict';

/* ─── СОСТОЯНИЕ ─── */
const App = {
  socket:       null,
  currentUser:  null,
  currentChat:  null,
  chats:        new Map(),   // chatId → { info, messages[] }
  contacts:     new Map(),   // userId → userInfo
  typingTimers: new Map(),   // chatId → timerId
  replyTo:      null,        // { msgId, text, senderName }
  editMsg:      null,        // { msgId, text }
  keyPair:      null,        // ECDH ключевая пара
  sharedKeys:   new Map(),   // chatId → CryptoKey
  unread:       new Map(),   // chatId → count
  activeTab:    'chats',     // 'chats' | 'contacts' | 'explore'
  searchQuery:  '',
  e2eEnabled:   false,
};

/* ─── DOM REFS ─── */
const $ = id => document.getElementById(id);

const DOM = {
  /* Экраны */
  screenAuth:    $('screen-auth'),
  screenApp:     $('screen-app'),

  /* Авторизация */
  authTabs:      document.querySelectorAll('.auth-tab'),
  authForms:     document.querySelectorAll('.auth-form'),
  loginForm:     $('login-form'),
  regForm:       $('reg-form'),
  loginUsername: $('login-username'),
  loginPassword: $('login-password'),
  loginErr:      $('login-err'),
  regUsername:   $('reg-username'),
  regPassword:   $('reg-password'),
  regPassword2:  $('reg-password2'),
  regErr:        $('reg-err'),

  /* Сайдбар */
  myAvatar:      $('my-avatar'),
  searchInput:   $('search-input'),
  searchClear:   $('search-clear'),
  newChatBtn:    $('new-chat-btn'),
  sidebarTabs:   document.querySelectorAll('.stab'),
  chatList:      $('chat-list'),
  contactsPanel: $('contacts-panel'),
  explorePanel:  $('explore-panel'),

  /* Область чата */
  chatPlaceholder: $('chat-placeholder'),
  chatWrap:        $('chat-wrap'),
  backBtn:         $('back-btn'),
  chAvatar:        $('ch-avatar'),
  chName:          $('ch-name'),
  chStatus:        $('ch-status'),
  chatInfoBtn:     $('chat-info-btn'),
  messagesList:    $('messages-list'),
  messagesArea:    $('messages-area'),

  /* Ввод */
  replyBar:      $('reply-bar'),
  replyText:     $('reply-text'),
  replyClose:    $('reply-close'),
  editBar:       $('edit-bar'),
  editText:      $('edit-bar-text'),
  editClose:     $('edit-close'),
  attachBtn:     $('attach-btn'),
  attachMenu:    $('attach-menu'),
  fileImageBtn:  $('file-image-btn'),
  fileDocBtn:    $('file-doc-btn'),
  fileInput:     $('file-input'),
  msgInput:      $('msg-input'),
  sendBtn:       $('send-btn'),

  /* Уведомления */
  notifications: $('notifications'),
};

/* ══════════════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ
══════════════════════════════════════════════ */
async function init() {
  // Генерируем ECDH ключевую пару для E2E
  try {
    App.keyPair = await E2E.generateKeyPair();
    App.e2eEnabled = true;
  } catch (e) {
    console.warn('E2E недоступен:', e);
  }

  // Подключаемся к серверу
  connectSocket();

  // Навешиваем обработчики
  bindAuthEvents();
  bindSidebarEvents();
  bindChatEvents();
  bindInputEvents();

  // Проверяем сохранённую сессию
  const saved = sessionStorage.getItem('chat_session');
  if (saved) {
    try {
      const sess = JSON.parse(saved);
      App.currentUser = sess;
      showApp();
      App.socket.emit('auth:restore', { userId: sess.id, token: sess.token });
    } catch { sessionStorage.removeItem('chat_session'); }
  }
}

/* ══════════════════════════════════════════════
   SOCKET.IO ПОДКЛЮЧЕНИЕ
══════════════════════════════════════════════ */
function connectSocket() {
  App.socket = io({ transports: ['websocket'] });

  App.socket.on('connect', () => {
    console.log('Socket connected:', App.socket.id);
  });

  App.socket.on('disconnect', () => {
    showNotif('Соединение потеряно. Переподключение…', 'error');
  });

  App.socket.on('connect_error', () => {
    showNotif('Ошибка подключения к серверу', 'error');
  });

  /* ── Авторизация ── */
  App.socket.on('auth:ok', onAuthOk);
  App.socket.on('auth:err', onAuthErr);

  /* ── Чаты ── */
  App.socket.on('chats:list',     onChatsList);
  App.socket.on('chat:created',   onChatCreated);
  App.socket.on('chat:updated',   onChatUpdated);
  App.socket.on('chat:joined',    onChatJoined);
  App.socket.on('chat:left',      onChatLeft);

  /* ── Сообщения ── */
  App.socket.on('msg:history',    onMsgHistory);
  App.socket.on('msg:new',        onMsgNew);
  App.socket.on('msg:edited',     onMsgEdited);
  App.socket.on('msg:deleted',    onMsgDeleted);
  App.socket.on('msg:reaction',   onMsgReaction);

  /* ── Контакты / пользователи ── */
  App.socket.on('contacts:list',  onContactsList);
  App.socket.on('contact:request',onContactRequest);
  App.socket.on('contact:accepted',onContactAccepted);
  App.socket.on('users:search',   onUsersSearch);
  App.socket.on('groups:explore', onGroupsExplore);

  /* ── Онлайн / печатает ── */
  App.socket.on('user:online',    onUserOnline);
  App.socket.on('user:offline',   onUserOffline);
  App.socket.on('chat:typing',    onChatTyping);

  /* ── E2E ── */
  App.socket.on('e2e:pubkey',     onE2EPubkey);
}

/* ══════════════════════════════════════════════
   АВТОРИЗАЦИЯ — СОБЫТИЯ DOM
══════════════════════════════════════════════ */
function bindAuthEvents() {
  // Переключение табов — только визуальное,
  // логика входа/регистрации через doLogin() / doRegister()
  DOM.authTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('onclick')?.match(/'(\w+)'/)?.[1];
      if (!tabName) return;
      DOM.authTabs.forEach(t => t.classList.remove('active'));
      DOM.authForms.forEach(f => f.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`tab-${tabName}`)?.classList.remove('hidden');
    });
  });
}

/* ══════════════════════════════════════════════
   АВТОРИЗАЦИЯ — SOCKET HANDLERS
══════════════════════════════════════════════ */
async function onAuthOk(data) {
  App.currentUser = data;
  sessionStorage.setItem('chat_session', JSON.stringify(data));

  // Отправляем публичный E2E ключ на сервер
  if (App.e2eEnabled) {
    const pubKey = await E2E.exportPublicKey(App.keyPair.publicKey);
    App.socket.emit('e2e:pubkey', { pubKey });
  }

  showApp();
  App.socket.emit('chats:get');
  App.socket.emit('contacts:get');
}

function onAuthErr(data) {
  const err = data.message || 'Ошибка авторизации';
  if ($('login-form').classList.contains('hidden')) {
    DOM.regErr.textContent = err;
  } else {
    DOM.loginErr.textContent = err;
  }
}

/* ══════════════════════════════════════════════
   ПЕРЕКЛЮЧЕНИЕ ЭКРАНОВ
══════════════════════════════════════════════ */
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
  sessionStorage.removeItem('chat_session');
}

/* ══════════════════════════════════════════════
   МОЙ АВАТАР
══════════════════════════════════════════════ */
function renderMyAvatar() {
  if (!App.currentUser) return;
  const u = App.currentUser;
  DOM.myAvatar.innerHTML = u.avatar
    ? `<img class="avatar-img" src="${u.avatar}" alt="">`
    : getInitialsEmoji(u.username);
}

/* ══════════════════════════════════════════════
   УТИЛИТЫ
══════════════════════════════════════════════ */
function getInitialsEmoji(name) {
  return `<span>${(name || '?')[0].toUpperCase()}</span>`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
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
  if (bytes < 1024)       return bytes + ' Б';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' КБ';
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
  const el = document.createElement('div');
  el.className = `notif${type === 'error' ? ' error' : type === 'success' ? ' success' : ''}`;
  el.textContent = text;
  DOM.notifications.appendChild(el);
  setTimeout(() => el.remove(), duration);
}
/* ══════════════════════════════════════════════
   ЧАСТЬ 2: Сайдбар, список чатов, табы
══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   САЙДБАР — СОБЫТИЯ
══════════════════════════════════════════════ */
function bindSidebarEvents() {
  /* Мой аватар → профиль */
  DOM.myAvatar.addEventListener('click', openProfileModal);

  /* Поиск */
  DOM.searchInput.addEventListener('input', e => {
    App.searchQuery = e.target.value.trim();
    DOM.searchClear.classList.toggle('hidden', !App.searchQuery);
    renderChatList();
  });

  DOM.searchClear.addEventListener('click', () => {
    DOM.searchInput.value = '';
    App.searchQuery = '';
    DOM.searchClear.classList.add('hidden');
    renderChatList();
  });

  /* Новый чат */
  DOM.newChatBtn.addEventListener('click', openNewChatModal);

  /* Табы сайдбара */
  DOM.sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      DOM.sidebarTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      App.activeTab = tab.dataset.tab;
      renderSidebarTab();
    });
  });
}

/* ══════════════════════════════════════════════
   РЕНДЕР ТАБА САЙДБАРА
══════════════════════════════════════════════ */
function renderSidebarTab() {
  DOM.chatList.classList.add('hidden');
  DOM.contactsPanel.classList.add('hidden');
  DOM.explorePanel.classList.add('hidden');

  switch (App.activeTab) {
    case 'chats':
      DOM.chatList.classList.remove('hidden');
      renderChatList();
      break;
    case 'contacts':
      DOM.contactsPanel.classList.remove('hidden');
      renderContactsPanel();
      break;
    case 'explore':
      DOM.explorePanel.classList.remove('hidden');
      App.socket.emit('groups:explore');
      break;
  }
}

/* ══════════════════════════════════════════════
   СПИСОК ЧАТОВ
══════════════════════════════════════════════ */
function onChatsList(data) {
  App.chats.clear();
  data.chats.forEach(chat => {
    App.chats.set(chat.id, { info: chat, messages: [] });
  });
  renderChatList();
}

function onChatCreated(chat) {
  App.chats.set(chat.id, { info: chat, messages: [] });
  renderChatList();
  // Автоматически открываем новый чат
  openChat(chat.id);
}

function onChatUpdated(chat) {
  const existing = App.chats.get(chat.id);
  if (existing) {
    existing.info = { ...existing.info, ...chat };
  } else {
    App.chats.set(chat.id, { info: chat, messages: [] });
  }
  renderChatList();
  if (App.currentChat === chat.id) renderChatHeader();
}

function onChatJoined(data) {
  showNotif(`Вы вступили в группу «${data.chatName}»`, 'success');
  App.socket.emit('chats:get');
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

function renderChatList() {
  const q = App.searchQuery.toLowerCase();
  let chats = [...App.chats.values()];

  if (q) {
    chats = chats.filter(c =>
      c.info.name.toLowerCase().includes(q)
    );
  }

  // Сортировка по времени последнего сообщения
  chats.sort((a, b) => {
    const ta = a.info.lastMsgTime || 0;
    const tb = b.info.lastMsgTime || 0;
    return tb - ta;
  });

  if (chats.length === 0) {
    DOM.chatList.innerHTML = `
      <div class="chat-placeholder" style="padding:32px 0">
        <div class="placeholder-icon">💬</div>
        <div class="placeholder-text">
          ${q ? 'Ничего не найдено' : 'Нет чатов'}
        </div>
      </div>`;
    return;
  }

  DOM.chatList.innerHTML = chats.map(c => renderChatItem(c)).join('');

  // Навешиваем клики
  DOM.chatList.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', () => openChat(el.dataset.id));
  });
}

function renderChatItem(c) {
  const info    = c.info;
  const unread  = App.unread.get(info.id) || 0;
  const isActive = App.currentChat === info.id;

  const avatarHtml = info.avatar
    ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
    : getInitialsEmoji(info.name);

  const lastMsg = info.lastMsg
    ? escHtml(info.lastMsg).slice(0, 42) + (info.lastMsg.length > 42 ? '…' : '')
    : '<span style="opacity:.5">Нет сообщений</span>';

  const timeStr = info.lastMsgTime
    ? formatTime(info.lastMsgTime)
    : '';

  const unreadBadge = unread > 0
    ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>`
    : '';

  const groupIcon = info.type === 'group'
    ? '<span style="font-size:10px;opacity:.5">👥</span>'
    : '';

  return `
    <div class="chat-item${isActive ? ' active' : ''}" data-id="${escHtml(info.id)}">
      <div class="ci-avatar">${avatarHtml}</div>
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${escHtml(info.name)} ${groupIcon}</span>
          <span class="ci-time">${timeStr}</span>
        </div>
        <div class="ci-bottom">
          <span class="ci-last">${lastMsg}</span>
          ${unreadBadge}
        </div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════
   ОТКРЫТИЕ ЧАТА
══════════════════════════════════════════════ */
function openChat(chatId) {
  if (App.currentChat === chatId) return;

  App.currentChat = chatId;
  App.unread.set(chatId, 0);

  // Мобильный — скрываем сайдбар
  if (window.innerWidth <= 700) {
    document.querySelector('.sidebar').classList.add('hidden-mobile');
  }

  DOM.chatPlaceholder.classList.add('hidden');
  DOM.chatWrap.classList.remove('hidden');

  renderChatHeader();
  renderChatList(); // обновить активный элемент

  // Сбрасываем состояние ввода
  clearReplyBar();
  clearEditBar();
  DOM.msgInput.value = '';

  // Запрашиваем историю
  const chat = App.chats.get(chatId);
  if (chat && chat.messages.length === 0) {
    App.socket.emit('msg:history', { chatId });
  } else {
    renderMessages();
  }

  // E2E — запрашиваем публичный ключ собеседника (для личных чатов)
  if (chat && chat.info.type === 'direct' && App.e2eEnabled) {
    const otherId = chat.info.members?.find(m => m !== App.currentUser.id);
    if (otherId) {
      App.socket.emit('e2e:getkey', { userId: otherId });
    }
  }
}

function showChatPlaceholder() {
  DOM.chatWrap.classList.add('hidden');
  DOM.chatPlaceholder.classList.remove('hidden');
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
    DOM.chStatus.textContent = `${info.memberCount || 0} участников`;
    DOM.chStatus.className = 'ch-status';
  } else {
    const online = info.online;
    DOM.chStatus.textContent = online ? 'В сети' : 'Не в сети';
    DOM.chStatus.className   = `ch-status${online ? ' online' : ''}`;
  }
}

/* ══════════════════════════════════════════════
   ОНЛАЙН / ОФЛАЙН
══════════════════════════════════════════════ */
function onUserOnline(data) {
  // Обновляем статус в чатах
  App.chats.forEach((chat, id) => {
    if (chat.info.type === 'direct' &&
        chat.info.members?.includes(data.userId)) {
      chat.info.online = true;
      if (App.currentChat === id) renderChatHeader();
    }
  });
  updateContactStatus(data.userId, true);
}

function onUserOffline(data) {
  App.chats.forEach((chat, id) => {
    if (chat.info.type === 'direct' &&
        chat.info.members?.includes(data.userId)) {
      chat.info.online = false;
      chat.info.lastSeen = data.lastSeen;
      if (App.currentChat === id) renderChatHeader();
    }
  });
  updateContactStatus(data.userId, false);
}

function updateContactStatus(userId, online) {
  const contact = App.contacts.get(userId);
  if (contact) {
    contact.online = online;
    if (App.activeTab === 'contacts') renderContactsPanel();
  }
}

/* ══════════════════════════════════════════════
   ПЕЧАТАЕТ…
══════════════════════════════════════════════ */
function onChatTyping(data) {
  if (data.chatId !== App.currentChat) return;
  if (data.userId === App.currentUser.id) return;

  const statusEl = DOM.chStatus;
  const prevText = statusEl.textContent;
  const prevClass = statusEl.className;

  statusEl.textContent = `${escHtml(data.username)} печатает…`;
  statusEl.className = 'ch-status';

  clearTimeout(App.typingTimers.get(data.chatId));
  App.typingTimers.set(data.chatId, setTimeout(() => {
    statusEl.textContent = prevText;
    statusEl.className   = prevClass;
  }, 3000));
}
/* ══════════════════════════════════════════════
   ЧАСТЬ 3: Сообщения — рендер, отправка, реакции
══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   ИСТОРИЯ СООБЩЕНИЙ
══════════════════════════════════════════════ */
function onMsgHistory(data) {
  const chat = App.chats.get(data.chatId);
  if (!chat) return;
  chat.messages = data.messages || [];
  if (App.currentChat === data.chatId) renderMessages();
}

function onMsgNew(data) {
  const chat = App.chats.get(data.chatId);
  if (!chat) return;

  chat.messages.push(data);
  chat.info.lastMsg     = data.text || (data.file ? '📎 Файл' : '');
  chat.info.lastMsgTime = data.ts;

  if (App.currentChat === data.chatId) {
    appendMessage(data);
    scrollToBottom();
    // Помечаем прочитанным
    App.socket.emit('msg:read', { chatId: data.chatId, msgId: data.id });
  } else {
    // Увеличиваем счётчик непрочитанных
    const prev = App.unread.get(data.chatId) || 0;
    App.unread.set(data.chatId, prev + 1);
    // Уведомление
    showNotif(`${escHtml(data.senderName)}: ${escHtml(data.text || '📎').slice(0, 50)}`);
  }
  renderChatList();
}

function onMsgEdited(data) {
  const chat = App.chats.get(data.chatId);
  if (!chat) return;
  const idx = chat.messages.findIndex(m => m.id === data.msgId);
  if (idx !== -1) {
    chat.messages[idx].text   = data.text;
    chat.messages[idx].edited = true;
  }
  if (App.currentChat === data.chatId) {
    const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
    if (el) {
      const textEl = el.querySelector('.msg-text');
      if (textEl) {
        textEl.innerHTML = formatMsgText(data.text);
        // Метка «изменено»
        let edited = el.querySelector('.msg-edited');
        if (!edited) {
          edited = document.createElement('span');
          edited.className = 'msg-edited';
          edited.textContent = ' (изм.)';
          el.querySelector('.msg-meta')?.appendChild(edited);
        }
      }
    }
  }
}

function onMsgDeleted(data) {
  const chat = App.chats.get(data.chatId);
  if (!chat) return;
  chat.messages = chat.messages.filter(m => m.id !== data.msgId);
  if (App.currentChat === data.chatId) {
    const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
    if (el) {
      el.classList.add('msg-deleted-anim');
      setTimeout(() => el.remove(), 250);
    }
  }
}

function onMsgReaction(data) {
  const chat = App.chats.get(data.chatId);
  if (!chat) return;
  const msg = chat.messages.find(m => m.id === data.msgId);
  if (msg) msg.reactions = data.reactions;
  if (App.currentChat === data.chatId) {
    const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
    if (el) renderReactions(el, data.reactions);
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
    const msgDate = new Date(msg.ts).toDateString();
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      const sep = document.createElement('div');
      sep.className   = 'date-separator';
      sep.textContent = formatDate(msg.ts);
      DOM.messagesList.appendChild(sep);
    }
    DOM.messagesList.appendChild(buildMsgEl(msg));
  });

  scrollToBottom(false);
}

function appendMessage(msg) {
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;

  // Разделитель даты если нужен
  const msgs    = chat.messages;
  const prev    = msgs[msgs.length - 2];
  const prevDate = prev ? new Date(prev.ts).toDateString() : null;
  const newDate  = new Date(msg.ts).toDateString();

  if (prevDate !== newDate) {
    const sep = document.createElement('div');
    sep.className   = 'date-separator';
    sep.textContent = formatDate(msg.ts);
    DOM.messagesList.appendChild(sep);
  }

  DOM.messagesList.appendChild(buildMsgEl(msg));
}

/* ── Построение DOM-элемента сообщения ── */
function buildMsgEl(msg) {
  const isMine = msg.senderId === App.currentUser?.id;
  const wrap   = document.createElement('div');
  wrap.className     = `msg-wrap${isMine ? ' mine' : ''}`;
  wrap.dataset.msgId = msg.id;

  wrap.innerHTML = buildMsgInner(msg, isMine);

  // Контекстное меню
  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMsgContextMenu(e, msg, isMine);
  });

  // Долгое нажатие (мобильный)
  let longPressTimer;
  wrap.addEventListener('touchstart', () => {
    longPressTimer = setTimeout(() => openMsgContextMenu(null, msg, isMine), 500);
  });
  wrap.addEventListener('touchend', () => clearTimeout(longPressTimer));

  return wrap;
}

function buildMsgInner(msg, isMine) {
  const avatar = !isMine
    ? `<div class="msg-avatar">
         ${msg.senderAvatar
           ? `<img class="avatar-img" src="${escHtml(msg.senderAvatar)}" alt="">`
           : getInitialsEmoji(msg.senderName)}
       </div>`
    : '';

  const replyHtml = msg.replyTo
    ? `<div class="msg-reply">
         <span class="msg-reply-name">${escHtml(msg.replyTo.senderName)}</span>
         <span class="msg-reply-text">${escHtml(msg.replyTo.text || '📎').slice(0, 60)}</span>
       </div>`
    : '';

  const contentHtml = buildMsgContent(msg);
  const editedMark  = msg.edited
    ? '<span class="msg-edited"> (изм.)</span>'
    : '';

  const reactionsHtml = msg.reactions && Object.keys(msg.reactions).length
    ? buildReactionsHtml(msg.reactions)
    : '<div class="msg-reactions"></div>';

  return `
    ${avatar}
    <div class="msg-bubble">
      ${!isMine && msg.senderName
        ? `<div class="msg-sender">${escHtml(msg.senderName)}</div>`
        : ''}
      ${replyHtml}
      ${contentHtml}
      <div class="msg-meta">
        <span class="msg-time">${formatTime(msg.ts)}</span>
        ${editedMark}
        ${isMine ? `<span class="msg-status">${msg.read ? '✓✓' : '✓'}</span>` : ''}
      </div>
      ${reactionsHtml}
    </div>`;
}

function buildMsgContent(msg) {
  if (msg.file) {
    const f = msg.file;
    if (f.type?.startsWith('image/')) {
      return `<img class="msg-image" src="${escHtml(f.url)}"
                   alt="${escHtml(f.name)}"
                   onclick="openImageModal('${escHtml(f.url)}')">`;
    }
    return `<div class="msg-file">
              <span class="msg-file-icon">📎</span>
              <div class="msg-file-info">
                <a class="msg-file-name" href="${escHtml(f.url)}"
                   target="_blank" download>${escHtml(f.name)}</a>
                <span class="msg-file-size">${formatSize(f.size)}</span>
              </div>
            </div>`;
  }
  if (msg.text) {
    return `<div class="msg-text">${formatMsgText(msg.text)}</div>`;
  }
  return '';
}

/* ── Форматирование текста (ссылки, жирный, курсив, код) ── */
function formatMsgText(text) {
  let t = escHtml(text);
  // Ссылки
  t = t.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener" class="msg-link">$1</a>'
  );
  // **жирный**
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // _курсив_
  t = t.replace(/_(.+?)_/g, '<em>$1</em>');
  // `код`
  t = t.replace(/`(.+?)`/g, '<code class="msg-code">$1</code>');
  // Переносы строк
  t = t.replace(/\n/g, '<br>');
  return t;
}

/* ══════════════════════════════════════════════
   РЕАКЦИИ
══════════════════════════════════════════════ */
function buildReactionsHtml(reactions) {
  if (!reactions || !Object.keys(reactions).length)
    return '<div class="msg-reactions"></div>';

  const items = Object.entries(reactions)
    .filter(([, users]) => users.length > 0)
    .map(([emoji, users]) =>
      `<span class="msg-reaction${users.includes(App.currentUser?.id) ? ' mine' : ''}"
             title="${escHtml(users.join(', '))}">
         ${emoji} ${users.length}
       </span>`
    ).join('');

  return `<div class="msg-reactions">${items}</div>`;
}

function renderReactions(msgWrapEl, reactions) {
  const el = msgWrapEl.querySelector('.msg-reactions');
  if (el) el.outerHTML = buildReactionsHtml(reactions);
}

/* ══════════════════════════════════════════════
   СКРОЛЛ
══════════════════════════════════════════════ */
function scrollToBottom(smooth = true) {
  const el = DOM.messagesArea;
  el.scrollTo({
    top:      el.scrollHeight,
    behavior: smooth ? 'smooth' : 'instant'
  });
}

/* ══════════════════════════════════════════════
   ОТПРАВКА СООБЩЕНИЙ
══════════════════════════════════════════════ */
function bindChatEvents() {
  /* Кнопка назад (мобильный) */
  DOM.backBtn.addEventListener('click', () => {
    document.querySelector('.sidebar').classList.remove('hidden-mobile');
    App.currentChat = null;
    showChatPlaceholder();
    renderChatList();
  });

  /* Инфо о чате */
  DOM.chatInfoBtn.addEventListener('click', openChatInfoModal);
}

function bindInputEvents() {
  /* Поле ввода */
  DOM.msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  DOM.msgInput.addEventListener('input', () => {
    autoResizeInput();
    sendTyping();
  });

  /* Кнопка отправки */
  DOM.sendBtn.addEventListener('click', sendMessage);

  /* Reply / Edit закрытие */
  DOM.replyClose.addEventListener('click', clearReplyBar);
  DOM.editClose.addEventListener('click',  clearEditBar);

  /* Прикрепить файл */
  DOM.attachBtn.addEventListener('click', e => {
    e.stopPropagation();
    DOM.attachMenu.classList.toggle('hidden');
  });

  DOM.fileImageBtn.addEventListener('click', () => {
    DOM.fileInput.accept = 'image/*';
    DOM.fileInput.click();
    DOM.attachMenu.classList.add('hidden');
  });

  DOM.fileDocBtn.addEventListener('click', () => {
    DOM.fileInput.accept = '*/*';
    DOM.fileInput.click();
    DOM.attachMenu.classList.add('hidden');
  });

  DOM.fileInput.addEventListener('change', onFileSelected);

  /* Клик вне attach-меню */
  document.addEventListener('click', e => {
    if (!DOM.attachMenu.classList.contains('hidden') &&
        !DOM.attachBtn.contains(e.target)) {
      DOM.attachMenu.classList.add('hidden');
    }
  });
}

async function sendMessage() {
  if (!App.currentChat) return;
  const text = DOM.msgInput.value.trim();

  /* Режим редактирования */
  if (App.editMsg) {
    if (!text) return;
    App.socket.emit('msg:edit', {
      chatId: App.currentChat,
      msgId:  App.editMsg.msgId,
      text
    });
    clearEditBar();
    DOM.msgInput.value = '';
    autoResizeInput();
    return;
  }

  if (!text) return;

  let payload = {
    chatId:  App.currentChat,
    text,
    replyTo: App.replyTo || null,
    tempId:  E2E.randomId()
  };

  /* E2E шифрование для личных чатов */
  const chat = App.chats.get(App.currentChat);
  if (App.e2eEnabled && chat?.info.type === 'direct') {
    const sharedKey = App.sharedKeys.get(App.currentChat);
    if (sharedKey) {
      payload.encText = await E2E.encrypt(sharedKey, text);
      payload.e2e     = true;
      delete payload.text;
    }
  }

  App.socket.emit('msg:send', payload);
  DOM.msgInput.value = '';
  autoResizeInput();
  clearReplyBar();
}

function autoResizeInput() {
  const el = DOM.msgInput;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

let typingTimeout;
function sendTyping() {
  if (!App.currentChat) return;
  App.socket.emit('chat:typing', { chatId: App.currentChat });
  clearTimeout(typingTimeout);
}

/* ══════════════════════════════════════════════
   ФАЙЛЫ
══════════════════════════════════════════════ */
async function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file || !App.currentChat) return;
  e.target.value = '';

  if (file.size > 20 * 1024 * 1024) {
    showNotif('Файл слишком большой (макс. 20 МБ)', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file',   file);
  formData.append('chatId', App.currentChat);

  try {
    const res  = await fetch('/upload', {
      method:  'POST',
      headers: { 'x-user-id': App.currentUser.id, 'x-token': App.currentUser.token },
      body:    formData
    });
    const data = await res.json();
    if (data.ok) {
      App.socket.emit('msg:send', {
        chatId: App.currentChat,
        file:   data.file,
        replyTo: App.replyTo || null,
        tempId:  E2E.randomId()
      });
      clearReplyBar();
    } else {
      showNotif(data.error || 'Ошибка загрузки файла', 'error');
    }
  } catch {
    showNotif('Ошибка загрузки файла', 'error');
  }
}

/* ══════════════════════════════════════════════
   REPLY / EDIT ПАНЕЛИ
══════════════════════════════════════════════ */
function openReplyBar(msg) {
  App.replyTo = { msgId: msg.id, text: msg.text || '📎', senderName: msg.senderName };
  DOM.replyText.textContent = `${msg.senderName}: ${(msg.text || '📎').slice(0, 60)}`;
  DOM.replyBar.classList.remove('hidden');
  DOM.msgInput.focus();
}

function clearReplyBar() {
  App.replyTo = null;
  DOM.replyBar.classList.add('hidden');
  DOM.replyText.textContent = '';
}

function openEditBar(msg) {
  App.editMsg = { msgId: msg.id, text: msg.text };
  DOM.editText.textContent = msg.text?.slice(0, 60) || '';
  DOM.editBar.classList.remove('hidden');
  DOM.msgInput.value = msg.text || '';
  DOM.msgInput.focus();
  autoResizeInput();
}

function clearEditBar() {
  App.editMsg = null;
  DOM.editBar.classList.add('hidden');
  DOM.msgInput.value = '';
  autoResizeInput();
}

/* ══════════════════════════════════════════════
   E2E — ОБМЕН КЛЮЧАМИ
══════════════════════════════════════════════ */
async function onE2EPubkey(data) {
  if (!App.e2eEnabled || !data.userId || !data.pubKey) return;
  try {
    const theirPub  = await E2E.importPublicKey(data.pubKey);
    const sharedKey = await E2E.deriveSharedKey(App.keyPair.privateKey, theirPub);
    // Связываем ключ с chatId
    App.chats.forEach((chat, chatId) => {
      if (chat.info.type === 'direct' &&
          chat.info.members?.includes(data.userId)) {
        App.sharedKeys.set(chatId, sharedKey);
      }
    });
  } catch (e) {
    console.warn('E2E ключ не удалось импортировать:', e);
  }
}
/* ══════════════════════════════════════════════
   ЧАСТЬ 4: Контекстное меню, модалки, изображения
══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   КОНТЕКСТНОЕ МЕНЮ СООБЩЕНИЯ
══════════════════════════════════════════════ */
function openMsgContextMenu(e, msg, isMine) {
  closeAllOverlays();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  const buttons = [
    { label: '↩️ Ответить',   action: () => openReplyBar(msg) },
    { label: '😊 Реакция',    action: () => openReactionPicker(msg) },
    { label: '📋 Копировать', action: () => copyText(msg.text) },
  ];

  if (isMine) {
    buttons.push({ label: '✏️ Редактировать', action: () => openEditBar(msg) });
    buttons.push({ label: '🗑 Удалить',        action: () => deleteMessage(msg), danger: true });
  }

  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.danger) btn.classList.add('danger');
    btn.addEventListener('click', () => {
      menu.remove();
      overlay.remove();
      b.action();
    });
    menu.appendChild(btn);
  });

  // Позиционирование
  document.body.appendChild(menu);

  let x, y;
  if (e) {
    x = e.clientX;
    y = e.clientY;
  } else {
    // Мобильный — по центру экрана
    x = window.innerWidth  / 2 - 85;
    y = window.innerHeight / 2 - 80;
  }

  // Проверяем выход за края
  const mw = menu.offsetWidth  || 180;
  const mh = menu.offsetHeight || 160;
  if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 8;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;

  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  // Оверлей для закрытия
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.addEventListener('click', () => {
    menu.remove();
    overlay.remove();
  });
  document.body.appendChild(overlay);
}

/* ══════════════════════════════════════════════
   ПИКЕР РЕАКЦИЙ
══════════════════════════════════════════════ */
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];

function openReactionPicker(msg) {
  closeAllOverlays();

  const picker = document.createElement('div');
  picker.className = 'reaction-picker';

  REACTIONS.forEach(emoji => {
    const span = document.createElement('span');
    span.textContent = emoji;
    span.addEventListener('click', () => {
      App.socket.emit('msg:react', {
        chatId: App.currentChat,
        msgId:  msg.id,
        emoji
      });
      picker.remove();
      overlay.remove();
    });
    picker.appendChild(span);
  });

  // Позиционирование — над полем ввода
  document.body.appendChild(picker);
  const pw = picker.offsetWidth || 280;
  picker.style.left   = Math.max(8, (window.innerWidth - pw) / 2) + 'px';
  picker.style.bottom = '80px';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.addEventListener('click', () => {
    picker.remove();
    overlay.remove();
  });
  document.body.appendChild(overlay);
}

/* ══════════════════════════════════════════════
   УДАЛЕНИЕ СООБЩЕНИЯ
══════════════════════════════════════════════ */
function deleteMessage(msg) {
  openConfirmModal(
    'Удалить сообщение?',
    'Это действие нельзя отменить.',
    () => {
      App.socket.emit('msg:delete', {
        chatId: App.currentChat,
        msgId:  msg.id
      });
    }
  );
}

/* ══════════════════════════════════════════════
   КОПИРОВАНИЕ
══════════════════════════════════════════════ */
function copyText(text) {
  if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => showNotif('Скопировано', 'success'))
    .catch(() => {
      // Фоллбэк
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showNotif('Скопировано', 'success');
    });
}

/* ══════════════════════════════════════════════
   ПРОСМОТР ИЗОБРАЖЕНИЯ
══════════════════════════════════════════════ */
function openImageModal(url) {
  closeAllOverlays();

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-image-box">
      <img src="${escHtml(url)}" alt="Изображение">
    </div>`;

  modal.addEventListener('click', () => modal.remove());
  document.body.appendChild(modal);
}

/* ══════════════════════════════════════════════
   МОДАЛКА — ПРОФИЛЬ
══════════════════════════════════════════════ */
function openProfileModal() {
  closeAllOverlays();
  const u = App.currentUser;
  if (!u) return;

  const modal = createModal('Мой профиль');
  modal.body.innerHTML = `
    <div class="profile-avatar-wrap">
      <div class="profile-avatar" id="pm-avatar">
        ${u.avatar
          ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
          : getInitialsEmoji(u.username)}
      </div>
      <button class="avatar-change-btn" id="pm-avatar-btn">Сменить фото</button>
      <input type="file" id="pm-avatar-input" accept="image/*" class="hidden">
    </div>
    <div class="profile-username">${escHtml(u.username)}</div>
    <textarea class="profile-bio-input" id="pm-bio"
              placeholder="О себе…" maxlength="200">${escHtml(u.bio || '')}</textarea>
    <button class="modal-btn" id="pm-save">Сохранить</button>
    <button class="modal-btn danger" id="pm-logout">Выйти</button>`;

  document.body.appendChild(modal.el);

  /* Смена аватара */
  const avatarInput = modal.body.querySelector('#pm-avatar-input');
  modal.body.querySelector('#pm-avatar-btn').addEventListener('click', () => {
    avatarInput.click();
  });

  avatarInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showNotif('Фото слишком большое (макс. 5 МБ)', 'error');
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'avatar');
    try {
      const res  = await fetch('/upload', {
        method:  'POST',
        headers: { 'x-user-id': u.id, 'x-token': u.token },
        body:    formData
      });
      const data = await res.json();
      if (data.ok) {
        modal.body.querySelector('#pm-avatar').innerHTML =
          `<img class="avatar-img" src="${escHtml(data.file.url)}" alt="">`;
        App.currentUser.avatar = data.file.url;
        renderMyAvatar();
      }
    } catch { showNotif('Ошибка загрузки фото', 'error'); }
  });

  /* Сохранить */
  modal.body.querySelector('#pm-save').addEventListener('click', () => {
    const bio = modal.body.querySelector('#pm-bio').value.trim();
    App.socket.emit('user:update', { bio, avatar: App.currentUser.avatar });
    App.currentUser.bio = bio;
    sessionStorage.setItem('chat_session', JSON.stringify(App.currentUser));
    modal.el.remove();
    showNotif('Профиль сохранён', 'success');
  });

  /* Выйти */
  modal.body.querySelector('#pm-logout').addEventListener('click', () => {
    modal.el.remove();
    App.socket.emit('auth:logout');
    showAuth();
  });
}

/* ══════════════════════════════════════════════
   МОДАЛКА — ИНФОРМАЦИЯ О ЧАТЕ
══════════════════════════════════════════════ */
function openChatInfoModal() {
  if (!App.currentChat) return;
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const info = chat.info;

  closeAllOverlays();
  const modal = createModal(info.type === 'group' ? 'О группе' : 'О чате');

  const membersHtml = info.type === 'group' && info.memberCount
    ? `<p>Участников: <strong>${info.memberCount}</strong></p>`
    : '';

  const descHtml = info.description
    ? `<p>${escHtml(info.description)}</p>`
    : '';

  modal.body.innerHTML = `
    <div class="profile-avatar-wrap">
      <div class="profile-avatar">
        ${info.avatar
          ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
          : getInitialsEmoji(info.name)}
      </div>
      <div class="profile-username">${escHtml(info.name)}</div>
    </div>
    <div class="chat-info-meta">
      ${descHtml}
      ${membersHtml}
    </div>
    ${info.type === 'group'
      ? `<button class="modal-btn danger" id="ci-leave">Покинуть группу</button>`
      : ''}`;

  document.body.appendChild(modal.el);

  modal.body.querySelector('#ci-leave')?.addEventListener('click', () => {
    modal.el.remove();
    openConfirmModal(
      'Покинуть группу?',
      `Вы покинете «${escHtml(info.name)}».`,
      () => App.socket.emit('chat:leave', { chatId: App.currentChat })
    );
  });
}

/* ══════════════════════════════════════════════
   МОДАЛКА — НОВЫЙ ЧАТ
══════════════════════════════════════════════ */
function openNewChatModal() {
  closeAllOverlays();
  const modal = createModal('Новый чат');

  modal.body.innerHTML = `
    <div class="new-chat-tabs">
      <button class="nctab active" data-tab="direct">Личный</button>
      <button class="nctab"        data-tab="group">Группа</button>
    </div>
    <div id="nct-direct">
      <input class="search-field" id="nc-search" placeholder="Имя пользователя…" autocomplete="off">
      <div id="nc-results" style="margin-top:8px;display:flex;flex-direction:column;gap:6px"></div>
    </div>
    <div id="nct-group" class="hidden">
      <input class="search-field" id="nc-group-name" placeholder="Название группы…" maxlength="40">
      <textarea class="profile-bio-input" id="nc-group-desc"
                placeholder="Описание (необязательно)" style="margin-top:8px"></textarea>
      <button class="modal-btn" id="nc-create-group" style="margin-top:4px">Создать группу</button>
    </div>`;

  document.body.appendChild(modal.el);

  /* Табы */
  modal.body.querySelectorAll('.nctab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.body.querySelectorAll('.nctab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      modal.body.querySelector('#nct-direct').classList.toggle('hidden', tab.dataset.tab !== 'direct');
      modal.body.querySelector('#nct-group').classList.toggle('hidden',  tab.dataset.tab !== 'group');
    });
  });

  /* Поиск пользователей */
  let searchTimer;
  modal.body.querySelector('#nc-search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) {
      modal.body.querySelector('#nc-results').innerHTML = '';
      return;
    }
    searchTimer = setTimeout(() => {
      App.socket.emit('users:search', { query: q });
    }, 300);
  });

  /* Результаты поиска */
  App._ncModal = modal;
  App._ncSearchHandler = data => renderNcResults(data, modal);
  App.socket.once('users:search', App._ncSearchHandler);

  /* Создать группу */
  modal.body.querySelector('#nc-create-group').addEventListener('click', () => {
    const name = modal.body.querySelector('#nc-group-name').value.trim();
    const desc = modal.body.querySelector('#nc-group-desc').value.trim();
    if (!name) { showNotif('Введите название группы', 'error'); return; }
    App.socket.emit('chat:create', { type: 'group', name, description: desc });
    modal.el.remove();
  });

  modal.el.addEventListener('remove', () => {
    App.socket.off('users:search', App._ncSearchHandler);
  });
}

function renderNcResults(data, modal) {
  const container = modal?.body.querySelector('#nc-results');
  if (!container) return;

  // Вешаем обработчик снова для следующего поиска
  App.socket.once('users:search', d => renderNcResults(d, App._ncModal));

  if (!data.users?.length) {
    container.innerHTML = '<div style="color:var(--text2);font-size:13px">Не найдено</div>';
    return;
  }

  container.innerHTML = data.users.map(u => `
    <div class="contact-item" data-uid="${escHtml(u.id)}" style="cursor:pointer">
      <div class="ci-avatar">
        ${u.avatar
          ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
          : getInitialsEmoji(u.username)}
      </div>
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${escHtml(u.username)}</span>
        </div>
      </div>
    </div>`).join('');

  container.querySelectorAll('.contact-item').forEach(el => {
    el.addEventListener('click', () => {
      App.socket.emit('chat:create', {
        type:   'direct',
        userId: el.dataset.uid
      });
      modal.el.remove();
    });
  });
}

/* ══════════════════════════════════════════════
   МОДАЛКА — ПОДТВЕРЖДЕНИЕ
══════════════════════════════════════════════ */
function openConfirmModal(title, text, onConfirm) {
  closeAllOverlays();
  const modal = createModal(title);
  modal.body.innerHTML = `
    <p style="color:var(--text2);font-size:14px">${escHtml(text)}</p>
    <button class="modal-btn danger" id="confirm-ok">Подтвердить</button>
    <button class="modal-btn" id="confirm-cancel"
            style="background:transparent;color:var(--text2)">Отмена</button>`;

  document.body.appendChild(modal.el);

  modal.body.querySelector('#confirm-ok').addEventListener('click', () => {
    modal.el.remove();
    onConfirm();
  });
  modal.body.querySelector('#confirm-cancel').addEventListener('click', () => {
    modal.el.remove();
  });
}

/* ══════════════════════════════════════════════
   ФАБРИКА МОДАЛОК
══════════════════════════════════════════════ */
function createModal(title) {
  const el = document.createElement('div');
  el.className = 'modal';

  const box = document.createElement('div');
  box.className = 'modal-box';

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.innerHTML = `
    <span>${escHtml(title)}</span>
    <button class="modal-close" title="Закрыть">✕</button>`;

  const body = document.createElement('div');
  body.className = 'modal-body';

  box.appendChild(header);
  box.appendChild(body);
  el.appendChild(box);

  // Закрытие по крестику
  header.querySelector('.modal-close').addEventListener('click', () => el.remove());

  // Закрытие по клику на фон
  el.addEventListener('click', e => {
    if (e.target === el) el.remove();
  });

  document.body.appendChild(el);

  return { el, box, header, body };
}

/* ══════════════════════════════════════════════
   ЗАКРЫТИЕ ВСЕХ ОВЕРЛЕЕВ
══════════════════════════════════════════════ */
function closeAllOverlays() {
  document.querySelectorAll('.modal, .ctx-menu, .reaction-picker, .overlay')
    .forEach(el => el.remove());
}
/* ══════════════════════════════════════════════
   ЧАСТЬ 5: Контакты, Explore, поиск пользователей
══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   КОНТАКТЫ — SOCKET HANDLERS
══════════════════════════════════════════════ */
function onContactsList(data) {
  App.contacts.clear();
  (data.contacts || []).forEach(c => App.contacts.set(c.id, c));
  if (App.activeTab === 'contacts') renderContactsPanel();
}

function onContactRequest(data) {
  showNotif(`📩 ${escHtml(data.fromUsername)} хочет добавить вас в контакты`);
  // Добавляем входящий запрос во временный список
  if (!App._pendingRequests) App._pendingRequests = [];
  App._pendingRequests.push(data);
  if (App.activeTab === 'contacts') renderContactsPanel();
}

function onContactAccepted(data) {
  showNotif(`✅ ${escHtml(data.username)} принял(а) ваш запрос`, 'success');
  App.contacts.set(data.id, data);
  if (App.activeTab === 'contacts') renderContactsPanel();
}

/* ══════════════════════════════════════════════
   КОНТАКТЫ — РЕНДЕР
══════════════════════════════════════════════ */
function renderContactsPanel() {
  const panel = DOM.contactsPanel;
  const q     = App.searchQuery.toLowerCase();

  let contacts = [...App.contacts.values()];
  if (q) {
    contacts = contacts.filter(c =>
      c.username.toLowerCase().includes(q)
    );
  }

  // Входящие запросы
  const pending = (App._pendingRequests || []);
  const pendingHtml = pending.length
    ? `<div class="section-title">Запросы (${pending.length})</div>
       ${pending.map(r => renderContactRequest(r)).join('')}`
    : '';

  const contactsHtml = contacts.length
    ? `<div class="section-title">Контакты (${contacts.length})</div>
       ${contacts.map(c => renderContactItem(c)).join('')}`
    : `<div class="empty-hint">
         ${q ? 'Ничего не найдено' : 'Нет контактов'}
       </div>`;

  panel.innerHTML = `
    <div class="contacts-search-row">
      <input class="search-field"
             id="contacts-search-field"
             placeholder="Найти пользователя…"
             value="${escHtml(q)}"
             autocomplete="off">
      <button class="icon-btn" id="contacts-search-btn" title="Поиск">🔍</button>
    </div>
    <div id="contacts-search-results"></div>
    ${pendingHtml}
    ${contactsHtml}`;

  /* Поиск по нику */
  let searchTimer;
  panel.querySelector('#contacts-search-field').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const val = e.target.value.trim();
    if (val.length < 2) {
      panel.querySelector('#contacts-search-results').innerHTML = '';
      return;
    }
    searchTimer = setTimeout(() => {
      App.socket.emit('users:search', { query: val });
    }, 300);
  });

  panel.querySelector('#contacts-search-btn').addEventListener('click', () => {
    const val = panel.querySelector('#contacts-search-field').value.trim();
    if (val.length < 2) return;
    App.socket.emit('users:search', { query: val });
  });

  /* Навешиваем обработчики */
  panel.querySelectorAll('.contact-accept-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const reqId = btn.closest('[data-req-id]')?.dataset.reqId;
      if (!reqId) return;
      App.socket.emit('contact:accept', { requestId: reqId });
      App._pendingRequests = (App._pendingRequests || [])
        .filter(r => r.requestId !== reqId);
      renderContactsPanel();
    });
  });

  panel.querySelectorAll('.contact-decline-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const reqId = btn.closest('[data-req-id]')?.dataset.reqId;
      if (!reqId) return;
      App.socket.emit('contact:decline', { requestId: reqId });
      App._pendingRequests = (App._pendingRequests || [])
        .filter(r => r.requestId !== reqId);
      renderContactsPanel();
    });
  });

  panel.querySelectorAll('.contact-item[data-uid]').forEach(el => {
    el.addEventListener('click', () => openUserProfileModal(el.dataset.uid));
  });
}

function renderContactItem(c) {
  const avatarHtml = c.avatar
    ? `<img class="avatar-img" src="${escHtml(c.avatar)}" alt="">`
    : getInitialsEmoji(c.username);

  const onlineHtml = c.online
    ? '<span class="online-dot"></span>'
    : '';

  return `
    <div class="contact-item" data-uid="${escHtml(c.id)}">
      <div class="ci-avatar">
        ${avatarHtml}
        ${onlineHtml}
      </div>
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${escHtml(c.username)}</span>
          ${c.online
            ? '<span style="font-size:11px;color:var(--accent)">В сети</span>'
            : ''}
        </div>
        <div class="ci-bottom">
          <span style="font-size:12px;color:var(--text2)">
            ${escHtml(c.bio || '')}
          </span>
        </div>
      </div>
    </div>`;
}

function renderContactRequest(r) {
  return `
    <div class="contact-item" data-req-id="${escHtml(r.requestId)}">
      <div class="ci-avatar">
        ${r.fromAvatar
          ? `<img class="avatar-img" src="${escHtml(r.fromAvatar)}" alt="">`
          : getInitialsEmoji(r.fromUsername)}
      </div>
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${escHtml(r.fromUsername)}</span>
        </div>
        <div class="ci-bottom" style="gap:6px;display:flex">
          <button class="contact-accept-btn">✅ Принять</button>
          <button class="contact-decline-btn">❌ Отклонить</button>
        </div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════
   ПОИСК ПОЛЬЗОВАТЕЛЕЙ (глобальный)
══════════════════════════════════════════════ */
function onUsersSearch(data) {
  // Если открыта панель контактов — показываем в ней
  if (App.activeTab === 'contacts') {
    const resultsEl = DOM.contactsPanel.querySelector('#contacts-search-results');
    if (!resultsEl) return;

    if (!data.users?.length) {
      resultsEl.innerHTML = '<div class="empty-hint">Пользователи не найдены</div>';
      return;
    }

    resultsEl.innerHTML = `
      <div class="section-title">Найдено</div>
      ${data.users.map(u => renderSearchUserItem(u)).join('')}`;

    resultsEl.querySelectorAll('.search-user-item').forEach(el => {
      el.addEventListener('click', () => openUserProfileModal(el.dataset.uid));
    });
  }

  // Если открыт новый-чат-модал — туда (обрабатывается в renderNcResults)
}

function renderSearchUserItem(u) {
  const isContact  = App.contacts.has(u.id);
  const isSelf     = u.id === App.currentUser?.id;

  return `
    <div class="contact-item search-user-item" data-uid="${escHtml(u.id)}">
      <div class="ci-avatar">
        ${u.avatar
          ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
          : getInitialsEmoji(u.username)}
      </div>
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${escHtml(u.username)}</span>
          ${isContact
            ? '<span style="font-size:11px;color:var(--accent)">В контактах</span>'
            : ''}
        </div>
        <div class="ci-bottom">
          <span style="font-size:12px;color:var(--text2)">
            ${escHtml(u.bio || '')}
          </span>
        </div>
      </div>
      ${!isContact && !isSelf
        ? `<button class="add-contact-btn icon-btn"
                   data-uid="${escHtml(u.id)}"
                   title="Добавить в контакты">➕</button>`
        : ''}
    </div>`;
}

/* ══════════════════════════════════════════════
   ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ
══════════════════════════════════════════════ */
function openUserProfileModal(userId) {
  const u = App.contacts.get(userId);
  if (!userId) return;

  closeAllOverlays();
  const modal  = createModal('Профиль');
  const isSelf = userId === App.currentUser?.id;

  const avatarHtml = u?.avatar
    ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
    : getInitialsEmoji(u?.username || '?');

  modal.body.innerHTML = `
    <div class="profile-avatar-wrap">
      <div class="profile-avatar">${avatarHtml}</div>
      <div class="profile-username">${escHtml(u?.username || userId)}</div>
    </div>
    ${u?.bio ? `<p style="text-align:center;color:var(--text2)">${escHtml(u.bio)}</p>` : ''}
    ${u?.online
      ? '<p style="text-align:center;font-size:13px;color:var(--accent)">🟢 В сети</p>'
      : ''}
    <div id="upm-actions" style="display:flex;flex-direction:column;gap:8px;margin-top:12px"></div>`;

  const actions = modal.body.querySelector('#upm-actions');

  if (!isSelf) {
    /* Написать сообщение */
    const msgBtn = document.createElement('button');
    msgBtn.className   = 'modal-btn';
    msgBtn.textContent = '💬 Написать сообщение';
    msgBtn.addEventListener('click', () => {
      modal.el.remove();
      App.socket.emit('chat:create', { type: 'direct', userId });
    });
    actions.appendChild(msgBtn);

    /* Добавить в контакты */
    if (!App.contacts.has(userId)) {
      const addBtn = document.createElement('button');
      addBtn.className   = 'modal-btn';
      addBtn.textContent = '➕ Добавить в контакты';
      addBtn.addEventListener('click', () => {
        App.socket.emit('contact:request', { toUserId: userId });
        addBtn.disabled     = true;
        addBtn.textContent  = '⏳ Запрос отправлен';
        showNotif('Запрос на добавление отправлен', 'success');
      });
      actions.appendChild(addBtn);
    }

    /* Удалить из контактов */
    if (App.contacts.has(userId)) {
      const delBtn = document.createElement('button');
      delBtn.className   = 'modal-btn danger';
      delBtn.textContent = '🗑 Удалить из контактов';
      delBtn.addEventListener('click', () => {
        openConfirmModal(
          'Удалить контакт?',
          `Удалить ${escHtml(u?.username || '')} из контактов?`,
          () => {
            App.socket.emit('contact:remove', { userId });
            App.contacts.delete(userId);
            modal.el.remove();
            if (App.activeTab === 'contacts') renderContactsPanel();
          }
        );
      });
      actions.appendChild(delBtn);
    }
  }
}

/* ══════════════════════════════════════════════
   EXPLORE — ПУБЛИЧНЫЕ ГРУППЫ
══════════════════════════════════════════════ */
function onGroupsExplore(data) {
  const panel = DOM.explorePanel;
  const groups = data.groups || [];

  if (!groups.length) {
    panel.innerHTML = `
      <div class="empty-hint">
        <div style="font-size:48px;margin-bottom:8px">🌐</div>
        Нет публичных групп
      </div>`;
    return;
  }

  panel.innerHTML = `
    <div class="section-title">Публичные группы</div>
    ${groups.map(g => renderGroupExploreItem(g)).join('')}`;

  panel.querySelectorAll('.explore-join-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const chatId = btn.dataset.chatId;
      App.socket.emit('chat:join', { chatId });
      btn.disabled     = true;
      btn.textContent  = '⏳ Вступаем…';
    });
  });

  panel.querySelectorAll('.explore-item').forEach(el => {
    el.addEventListener('click', () => {
      const chatId = el.dataset.chatId;
      if (App.chats.has(chatId)) openChat(chatId);
    });
  });
}

function renderGroupExploreItem(g) {
  const inChat    = App.chats.has(g.id);
  const avatarHtml = g.avatar
    ? `<img class="avatar-img" src="${escHtml(g.avatar)}" alt="">`
    : getInitialsEmoji(g.name);

  return `
    <div class="contact-item explore-item" data-chat-id="${escHtml(g.id)}">
      <div class="ci-avatar">${avatarHtml}</div>
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${escHtml(g.name)}</span>
          <span style="font-size:11px;color:var(--text2)">${g.memberCount || 0} уч.</span>
        </div>
        <div class="ci-bottom">
          <span style="font-size:12px;color:var(--text2)">
            ${escHtml((g.description || '').slice(0, 50))}
          </span>
        </div>
      </div>
      ${!inChat
        ? `<button class="explore-join-btn modal-btn"
                   style="padding:4px 10px;font-size:12px;min-height:0"
                   data-chat-id="${escHtml(g.id)}">Вступить</button>`
        : '<span style="font-size:11px;color:var(--accent)">✓ Вступил</span>'}
    </div>`;
}
/* ══════════════════════════════════════════════
   ЧАСТЬ 6: E2E крипто, уведомления, тема,
            Service Worker, точка входа
══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   ТЕМА (светлая / тёмная)
══════════════════════════════════════════════ */
const Theme = {
  STORAGE_KEY: 'chat_theme',

  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    const prefer = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
    this.apply(saved || prefer);
    this._bindToggle();
  },

  apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(this.STORAGE_KEY, theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  },

  toggle() {
    const curr = document.documentElement.getAttribute('data-theme');
    this.apply(curr === 'dark' ? 'light' : 'dark');
  },

  _bindToggle() {
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', () => this.toggle());
  },
};

/* ══════════════════════════════════════════════
   PUSH-УВЕДОМЛЕНИЯ (браузерные)
══════════════════════════════════════════════ */
const PushNotif = {
  allowed: false,

  async request() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      this.allowed = true;
      return;
    }
    if (Notification.permission !== 'denied') {
      const perm = await Notification.requestPermission();
      this.allowed = perm === 'granted';
    }
  },

  send(title, body, icon = '/icon.png') {
    if (!this.allowed || document.visibilityState === 'visible') return;
    try {
      new Notification(title, { body, icon, silent: false });
    } catch { /* Safari может бросить */ }
  },
};

/* ══════════════════════════════════════════════
   ЗВУК УВЕДОМЛЕНИЯ
══════════════════════════════════════════════ */
const Sound = {
  _ctx: null,

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this._ctx;
  },

  /* Простой «бип» без внешних файлов */
  playBeep() {
    try {
      const ctx  = this._getCtx();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value   = 880;
      osc.type              = 'sine';
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } catch { /* AudioContext может быть заблокирован */ }
  },
};

/* ══════════════════════════════════════════════
   SERVICE WORKER (PWA офлайн)
══════════════════════════════════════════════ */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('SW зарегистрирован:', reg.scope))
      .catch(err => console.warn('SW ошибка:', err));
  }
}

/* ══════════════════════════════════════════════
   ГЛОБАЛЬНЫЕ ГОРЯЧИЕ КЛАВИШИ
══════════════════════════════════════════════ */
function bindGlobalKeys() {
  document.addEventListener('keydown', e => {
    /* Escape — закрыть модалки */
    if (e.key === 'Escape') {
      closeAllOverlays();
      return;
    }
    /* Ctrl/Cmd + K — фокус на поиск */
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      DOM.searchInput?.focus();
      return;
    }
    /* Ctrl/Cmd + / — переключить тему */
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      Theme.toggle();
    }
  });
}

/* ══════════════════════════════════════════════
   ВИДИМОСТЬ СТРАНИЦЫ — пауза/возобновление
══════════════════════════════════════════════ */
function bindVisibilityChange() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Помечаем текущий чат прочитанным при возврате
      if (App.currentChat) {
        App.unread.set(App.currentChat, 0);
        renderChatList();
      }
    }
  });
}

/* ══════════════════════════════════════════════
   АДАПТИВНОСТЬ — resize
══════════════════════════════════════════════ */
function bindResize() {
  window.addEventListener('resize', () => {
    // Если стало широко — убираем мобильный класс
    if (window.innerWidth > 700) {
      document.querySelector('.sidebar')?.classList.remove('hidden-mobile');
    }
  });
}

/* ══════════════════════════════════════════════
   ONLINE / OFFLINE браузера
══════════════════════════════════════════════ */
function bindNetworkEvents() {
  window.addEventListener('offline', () => {
    showNotif('Нет интернет-соединения', 'error', 5000);
  });
  window.addEventListener('online', () => {
    showNotif('Соединение восстановлено', 'success');
    // Реконнект socket если нужен
    if (!App.socket?.connected) App.socket?.connect();
  });
}

/* ══════════════════════════════════════════════
   ПАТЧ onMsgNew — добавляем звук и push
══════════════════════════════════════════════ */
const _origOnMsgNew = onMsgNew;
window.onMsgNew = function patchedOnMsgNew(data) {
  _origOnMsgNew(data);
  // Звук только для чужих сообщений
  if (data.senderId !== App.currentUser?.id) {
    Sound.playBeep();
    PushNotif.send(
      data.senderName || 'Новое сообщение',
      (data.text || '📎 Файл').slice(0, 80)
    );
  }
};

/* ══════════════════════════════════════════════
   ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РЕНДЕРА
══════════════════════════════════════════════ */

/* Заголовок вкладки браузера с бейджем */
function updateDocTitle() {
  let total = 0;
  App.unread.forEach(v => { total += v; });
  document.title = total > 0
    ? `(${total > 99 ? '99+' : total}) Чат`
    : 'Чат';
}

/* Перехватываем renderChatList для обновления заголовка */
const _origRenderChatList = renderChatList;
window._renderChatListPatched = function() {
  _origRenderChatList();
  updateDocTitle();
};
// Перезаписываем через присваивание — работает
var renderChatList = window._renderChatListPatched;

/* ══════════════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ МОДУЛЯ НАСТРОЕК
══════════════════════════════════════════════ */
function initSettings() {
  const settingsBtn = document.getElementById('settings-btn');
  if (!settingsBtn) return;

  settingsBtn.addEventListener('click', () => {
    closeAllOverlays();
    const modal = createModal('Настройки');

    modal.body.innerHTML = `
      <div class="settings-row">
        <span>Тёмная тема</span>
        <label class="toggle-switch">
          <input type="checkbox" id="s-theme"
            ${document.documentElement.getAttribute('data-theme') === 'dark'
              ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <span>Звук уведомлений</span>
        <label class="toggle-switch">
          <input type="checkbox" id="s-sound"
            ${localStorage.getItem('chat_sound') !== 'off' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <span>Push-уведомления</span>
        <label class="toggle-switch">
          <input type="checkbox" id="s-push"
            ${PushNotif.allowed ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <span>E2E шифрование</span>
        <span style="font-size:12px;color:${App.e2eEnabled
          ? 'var(--accent)' : 'var(--text2)'}">
          ${App.e2eEnabled ? '🔒 Активно' : '⚠️ Недоступно'}
        </span>
      </div>`;

    /* Тема */
    modal.body.querySelector('#s-theme').addEventListener('change', e => {
      Theme.apply(e.target.checked ? 'dark' : 'light');
    });

    /* Звук */
    modal.body.querySelector('#s-sound').addEventListener('change', e => {
      localStorage.setItem('chat_sound', e.target.checked ? 'on' : 'off');
    });

    /* Push */
    modal.body.querySelector('#s-push').addEventListener('change', async e => {
      if (e.target.checked) {
        await PushNotif.request();
        e.target.checked = PushNotif.allowed;
      } else {
        PushNotif.allowed = false;
      }
    });
  });
}
/* ══════════════════════════════════════════════
   ГЛОБАЛЬНЫЕ ФУНКЦИИ ДЛЯ onclick В HTML
══════════════════════════════════════════════ */

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
  document.querySelector(`.auth-tab[onclick*="${tab}"]`)?.classList.add('active');
  document.getElementById(`tab-${tab}`)?.classList.remove('hidden');
}

function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-err');
  errEl.textContent = '';
  if (!username || !password) {
    errEl.textContent = 'Заполните все поля';
    return;
  }
  E2E.hashPassword(password).then(({ hash, salt }) => {
    App.socket.emit('auth:login', { username, passwordHash: hash, salt });
  });
}

function doRegister() {
  const username  = document.getElementById('reg-username').value.trim();
  const password  = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;
  const errEl     = document.getElementById('reg-err');
  errEl.textContent = '';
  if (!username || !password) {
    errEl.textContent = 'Заполните все поля';
    return;
  }
  if (password !== password2) {
    errEl.textContent = 'Пароли не совпадают';
    return;
  }
  if (password.length < 6) {
    errEl.textContent = 'Минимум 6 символов';
    return;
  }
  E2E.hashPassword(password).then(({ hash, salt }) => {
    App.socket.emit('auth:register', { username, passwordHash: hash, salt });
  });
}

function doLogout() {
  closeModal('modal-profile');
  App.socket.emit('auth:logout');
  showAuth();
}

function openMyProfile() {
  openProfileModal();
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

function onSearchInput() {
  const val = document.getElementById('search-input').value.trim();
  App.searchQuery = val;
  document.getElementById('search-clear').classList.toggle('hidden', !val);
  renderChatList();
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  App.searchQuery = '';
  document.getElementById('search-clear').classList.add('hidden');
  renderChatList();
}

function openNewChat() {
  openNewChatModal();
}

function switchTab(tab) {
  App.activeTab = tab;
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  document.getElementById(`stab-${tab}`)?.classList.add('active');
  renderSidebarTab();
}

function goBack() {
  document.querySelector('.sidebar')?.classList.remove('hidden-mobile');
  App.currentChat = null;
  showChatPlaceholder();
  renderChatList();
}

function openChatInfo() {
  openChatInfoModal();
}

function toggleAttachMenu() {
  document.getElementById('attach-menu')?.classList.toggle('hidden');
}

function pickFile(accept) {
  const input = document.getElementById('file-input');
  input.accept = accept;
  input.click();
  document.getElementById('attach-menu')?.classList.add('hidden');
}

function onMsgInput() {
  autoResizeInput();
  sendTyping();
}

function onMsgKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function cancelReply() {
  clearReplyBar();
}

function cancelEdit() {
  clearEditBar();
}

function onMessagesScroll() {
  // Можно добавить подгрузку истории при скролле вверх
}

function searchUsers() {
  const val = document.getElementById('nc-user-search')?.value.trim();
  if (!val || val.length < 2) {
    document.getElementById('nc-user-list').innerHTML = '';
    return;
  }
  App.socket.emit('users:search', { query: val });
}

function switchNewChatTab(tab) {
  document.querySelectorAll('.nctab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nctab[onclick*="${tab}"]`)?.classList.add('active');
  document.getElementById('nctab-private').classList.toggle('hidden', tab !== 'private');
  document.getElementById('nctab-group').classList.toggle('hidden',   tab !== 'group');
}

function createGroup() {
  const name = document.getElementById('nc-group-name')?.value.trim();
  if (!name) { showNotif('Введите название группы', 'error'); return; }
  App.socket.emit('chat:create', { type: 'group', name });
  closeModal('modal-new-chat');
}

function saveProfile() {
  const bio = document.getElementById('profile-bio')?.value.trim();
  App.socket.emit('user:update', { bio, avatar: App.currentUser.avatar });
  App.currentUser.bio = bio;
  sessionStorage.setItem('chat_session', JSON.stringify(App.currentUser));
  closeModal('modal-profile');
  showNotif('Профиль сохранён', 'success');
}

function changeAvatar() {
  document.getElementById('avatar-input')?.click();
}

function onAvatarSelected() {
  const input = document.getElementById('avatar-input');
  const file  = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('type', 'avatar');
  fetch('/upload', {
    method:  'POST',
    headers: { 'x-user-id': App.currentUser.id, 'x-token': App.currentUser.token },
    body:    formData
  }).then(r => r.json()).then(data => {
    if (data.ok) {
      App.currentUser.avatar = data.file.url;
      renderMyAvatar();
      showNotif('Фото обновлено', 'success');
    }
  }).catch(() => showNotif('Ошибка загрузки фото', 'error'));
}

function leaveChat() {
  closeModal('modal-chat-info');
  if (!App.currentChat) return;
  openConfirmModal(
    'Покинуть чат?',
    'Вы покинете этот чат.',
    () => App.socket.emit('chat:leave', { chatId: App.currentChat })
  );
}

function searchGroups() {
  const val = document.getElementById('explore-input')?.value.trim();
  App.socket.emit('groups:explore', { query: val });
}

function closeOverlay() {
  closeAllOverlays();
  document.getElementById('overlay')?.classList.add('hidden');
}

function ctxReply()  { /* обрабатывается через контекстное меню */ }
function ctxCopy()   { /* обрабатывается через контекстное меню */ }
function ctxEdit()   { /* обрабатывается через контекстное меню */ }
function ctxReact()  { /* обрабатывается через контекстное меню */ }
function ctxDelete() { /* обрабатывается через контекстное меню */ }
function pickReaction(emoji) { /* обрабатывается через пикер */ }
function changeChatAvatar()  { /* заглушка */ }
/* ══════════════════════════════════════════════
   ТОЧКА ВХОДА
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  /* 1. Тема */
  Theme.init();

  /* 2. Запрашиваем разрешение на уведомления */
  await PushNotif.request();

  /* 3. Service Worker */
  registerServiceWorker();

  /* 4. Глобальные обработчики */
  bindGlobalKeys();
  bindVisibilityChange();
  bindResize();
  bindNetworkEvents();

  /* 5. Настройки */
  initSettings();

  /* 6. Главная инициализация */
  await init();
});
