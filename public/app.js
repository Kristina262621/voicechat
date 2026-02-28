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
    replyClose:      null,
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
    // Модалки
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
   SOCKET.IO
══════════════════════════════════════════════ */
function connectSocket() {
  App.socket = io({ transports: ['websocket'] });

  App.socket.on('connect', () => console.log('Socket connected:', App.socket.id));
  App.socket.on('disconnect', () => showNotif('Соединение потеряно…', 'error'));
  App.socket.on('connect_error', () => showNotif('Ошибка подключения', 'error'));

  App.socket.on('auth:ok',          onAuthOk);
  App.socket.on('auth:err',         onAuthErr);
  App.socket.on('chats:list',       onChatsList);
  App.socket.on('chat:created',     onChatCreated);
  App.socket.on('chat:updated',     onChatUpdated);
  App.socket.on('chat:joined',      onChatJoined);
  App.socket.on('chat:left',        onChatLeft);
  App.socket.on('msg:history',      onMsgHistory);
  App.socket.on('msg:new',          onMsgNew);
  App.socket.on('msg:edited',       onMsgEdited);
  App.socket.on('msg:deleted',      onMsgDeleted);
  App.socket.on('msg:reaction',     onMsgReaction);
  App.socket.on('contacts:list',    onContactsList);
  App.socket.on('contact:request',  onContactRequest);
  App.socket.on('contact:accepted', onContactAccepted);
  App.socket.on('users:search',     onUsersSearch);
  App.socket.on('groups:explore',   onGroupsExplore);
  App.socket.on('user:online',      onUserOnline);
  App.socket.on('user:offline',     onUserOffline);
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
    const { hash, salt } = await E2E.hashPassword(password);
    App.socket.emit('auth:login', { username, passwordHash: hash, salt });
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
    const { hash, salt } = await E2E.hashPassword(password);
    App.socket.emit('auth:register', { username, passwordHash: hash, salt });
  } catch(e) {
    $('reg-err').textContent = 'Ошибка: ' + e.message;
    console.error(e);
  }
};

window.doLogout = function() {
  App.socket.emit('auth:logout');
  showAuth();
};

async function onAuthOk(data) {
  App.currentUser = data;
  sessionStorage.setItem('chat_session', JSON.stringify(data));

  if (App.e2eEnabled) {
    const pubKey = await E2E.exportPublicKey(App.keyPair.publicKey);
    App.socket.emit('e2e:pubkey', { pubKey });
  }

  showApp();
  App.socket.emit('chats:get');
  App.socket.emit('contacts:get');
}

function onAuthErr(data) {
  const err = data?.message || 'Ошибка авторизации';
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
   САЙДБАР — список чатов
══════════════════════════════════════════════ */
function onChatsList(data) {
  App.chats.clear();
  (data.chats || []).forEach(chat => App.chats.set(chat.id, { info: chat, messages: [] }));
  renderChatList();
}

function onChatCreated(chat) {
  App.chats.set(chat.id, { info: chat, messages: [] });
  renderChatList();
  closeModal('modal-new-chat');
  openChat(chat.id);
}

function onChatUpdated(chat) {
  const existing = App.chats.get(chat.id);
  if (existing) existing.info = { ...existing.info, ...chat };
  else App.chats.set(chat.id, { info: chat, messages: [] });
  renderChatList();
  if (App.currentChat === chat.id) renderChatHeader();
}

function onChatJoined(data) {
  showNotif(`Вы вступили в группу «${escHtml(data.chatName)}»`, 'success');
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
  if (q) chats = chats.filter(c => c.info.name?.toLowerCase().includes(q));
  chats.sort((a, b) => (b.info.lastMsgTime || 0) - (a.info.lastMsgTime || 0));

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
    const lastMsg = info.lastMsg
      ? escHtml(info.lastMsg).slice(0, 42)
      : '<span style="opacity:.5">Нет сообщений</span>';
    const timeStr = info.lastMsgTime ? formatTime(info.lastMsgTime) : '';
    const badge   = unread > 0
      ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';

    return `
      <div class="chat-item${active ? ' active' : ''}"
           data-id="${escHtml(info.id)}" onclick="openChat('${escHtml(info.id)}')">
        <div class="ci-avatar">${avatar}</div>
        <div class="ci-body">
          <div class="ci-top">
            <span class="ci-name">${escHtml(info.name)}${info.type === 'group' ? ' 👥' : ''}</span>
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

  const chat = App.chats.get(chatId);
  if (chat && chat.messages.length === 0) {
    App.socket.emit('msg:history', { chatId });
  } else {
    renderMessages();
  }

  if (chat?.info.type === 'direct' && App.e2eEnabled) {
    const otherId = chat.info.members?.find(m => m !== App.currentUser.id);
    if (otherId) App.socket.emit('e2e:getkey', { userId: otherId });
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
    DOM.chStatus.textContent = `${info.memberCount || 0} участников`;
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
    if (chat.info.type === 'direct' && chat.info.members?.includes(data.userId)) {
      chat.info.online = true;
      if (App.currentChat === id) renderChatHeader();
    }
  });
}

function onUserOffline(data) {
  App.chats.forEach((chat, id) => {
    if (chat.info.type === 'direct' && chat.info.members?.includes(data.userId)) {
      chat.info.online   = false;
      chat.info.lastSeen = data.lastSeen;
      if (App.currentChat === id) renderChatHeader();
    }
  });
}

/* ══════════════════════════════════════════════
   ПЕЧАТАЕТ…
══════════════════════════════════════════════ */
function onChatTyping(data) {
  if (data.chatId !== App.currentChat) return;
  if (data.userId === App.currentUser?.id) return;
  const prev  = DOM.chStatus.textContent;
  const prevC = DOM.chStatus.className;
  DOM.chStatus.textContent = `${data.username} печатает…`;
  DOM.chStatus.className   = 'ch-status';
  clearTimeout(App.typingTimers.get(data.chatId));
  App.typingTimers.set(data.chatId, setTimeout(() => {
    DOM.chStatus.textContent = prev;
    DOM.chStatus.className   = prevC;
  }, 3000));
}

/* ══════════════════════════════════════════════
   СООБЩЕНИЯ — SOCKET
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
    App.socket.emit('msg:read', { chatId: data.chatId, msgId: data.id });
  } else {
    App.unread.set(data.chatId, (App.unread.get(data.chatId) || 0) + 1);
    showNotif(`${data.senderName}: ${(data.text || '📎').slice(0, 50)}`);
  }

  if (data.senderId !== App.currentUser?.id) {
    Sound.playBeep();
    PushNotif.send(data.senderName || 'Новое сообщение', (data.text || '📎 Файл').slice(0, 80));
  }
  renderChatList();
}

function onMsgEdited(data) {
  const chat = App.chats.get(data.chatId);
  if (!chat) return;
  const msg = chat.messages.find(m => m.id === data.msgId);
  if (msg) { msg.text = data.text; msg.edited = true; }
  if (App.currentChat === data.chatId) {
    const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
    if (el) {
      const t = el.querySelector('.msg-text');
      if (t) t.innerHTML = formatMsgText(data.text);
      if (!el.querySelector('.msg-edited')) {
        const s = document.createElement('span');
        s.className = 'msg-edited'; s.textContent = ' (изм.)';
        el.querySelector('.msg-meta')?.appendChild(s);
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
    if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }
  }
}

function onMsgReaction(data) {
  const chat = App.chats.get(data.chatId);
  if (!chat) return;
  const msg = chat.messages.find(m => m.id === data.msgId);
  if (msg) msg.reactions = data.reactions;
  if (App.currentChat === data.chatId) {
    const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
    if (el) {
      const r = el.querySelector('.msg-reactions');
      if (r) r.outerHTML = buildReactionsHtml(data.reactions);
    }
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
    const d = new Date(msg.ts).toDateString();
    if (d !== lastDate) {
      lastDate = d;
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

function buildMsgEl(msg) {
  const isMine = msg.senderId === App.currentUser?.id;
  const wrap   = document.createElement('div');
  wrap.className     = `msg-wrap${isMine ? ' mine' : ''}`;
  wrap.dataset.msgId = msg.id;
  wrap.innerHTML     = buildMsgInner(msg, isMine);

  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    showCtxMenu(e, msg, isMine);
  });

  let lpt;
  wrap.addEventListener('touchstart', () => { lpt = setTimeout(() => showCtxMenu(null, msg, isMine), 500); });
  wrap.addEventListener('touchend',   () => clearTimeout(lpt));
  return wrap;
}

function buildMsgInner(msg, isMine) {
  const avatar = !isMine
    ? `<div class="msg-avatar">${msg.senderAvatar
        ? `<img class="avatar-img" src="${escHtml(msg.senderAvatar)}" alt="">`
        : getInitialsEmoji(msg.senderName)}</div>` : '';

  const reply = msg.replyTo
    ? `<div class="msg-reply">
         <span class="msg-reply-name">${escHtml(msg.replyTo.senderName)}</span>
         <span class="msg-reply-text">${escHtml((msg.replyTo.text || '📎').slice(0, 60))}</span>
       </div>` : '';

  const content  = buildMsgContent(msg);
  const edited   = msg.edited ? '<span class="msg-edited"> (изм.)</span>' : '';
  const reactions = buildReactionsHtml(msg.reactions);

  return `
    ${avatar}
    <div class="msg-bubble">
      ${!isMine && msg.senderName ? `<div class="msg-sender">${escHtml(msg.senderName)}</div>` : ''}
      ${reply}
      ${content}
      <div class="msg-meta">
        <span class="msg-time">${formatTime(msg.ts)}</span>
        ${edited}
        ${isMine ? `<span class="msg-status">${msg.read ? '✓✓' : '✓'}</span>` : ''}
      </div>
      ${reactions}
    </div>`;
}

function buildMsgContent(msg) {
  if (msg.file) {
    const f = msg.file;
    if (f.type?.startsWith('image/')) {
      return `<img class="msg-image" src="${escHtml(f.url)}" alt="${escHtml(f.name)}"
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
  if (msg.text) return `<div class="msg-text">${formatMsgText(msg.text)}</div>`;
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
  if (!reactions || !Object.keys(reactions).length)
    return '<div class="msg-reactions"></div>';
  const items = Object.entries(reactions)
    .filter(([, u]) => u.length)
    .map(([emoji, users]) =>
      `<span class="msg-reaction${users.includes(App.currentUser?.id) ? ' mine' : ''}"
             onclick="sendReaction('${escHtml(emoji)}')"
             title="${escHtml(users.join(', '))}">${emoji} ${users.length}</span>`
    ).join('');
  return `<div class="msg-reactions">${items}</div>`;
}

function scrollToBottom(smooth = true) {
  DOM.messagesArea.scrollTo({
    top:      DOM.messagesArea.scrollHeight,
    behavior: smooth ? 'smooth' : 'instant',
  });
}

/* ══════════════════════════════════════════════
   ВВОД СООБЩЕНИЯ
══════════════════════════════════════════════ */
async function sendMessage() {
  if (!App.currentChat) return;
  const text = DOM.msgInput.value.trim();

  if (App.editMsg) {
    if (!text) return;
    App.socket.emit('msg:edit', {
      chatId: App.currentChat,
      msgId:  App.editMsg.msgId,
      text,
    });
    clearEditBar();
    DOM.msgInput.value = '';
    autoResizeInput();
    return;
  }

  if (!text) return;

  const payload = {
    chatId:  App.currentChat,
    text,
    replyTo: App.replyTo || null,
    tempId:  Math.random().toString(36).slice(2),
  };

  App.socket.emit('msg:send', payload);
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
  App.socket.emit('chat:typing', { chatId: App.currentChat });
}

async function onFileSelected() {
  const file = DOM.fileInput.files[0];
  if (!file || !App.currentChat) return;
  DOM.fileInput.value = '';

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
      body:    formData,
    });
    const data = await res.json();
    if (data.ok) {
      App.socket.emit('msg:send', {
        chatId:  App.currentChat,
        file:    data.file,
        replyTo: App.replyTo || null,
      });
      clearReplyBar();
    } else {
      showNotif(data.error || 'Ошибка загрузки', 'error');
    }
  } catch {
    showNotif('Ошибка загрузки файла', 'error');
  }
}

function clearReplyBar() {
  App.replyTo = null;
  DOM.replyBar.classList.add('hidden');
  DOM.replyText.textContent = '';
}

function openReplyBar(msg) {
  App.replyTo = { msgId: msg.id, text: msg.text || '📎', senderName: msg.senderName };
  DOM.replyText.textContent = `${msg.senderName}: ${(msg.text || '📎').slice(0, 60)}`;
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
  App.editMsg = { msgId: msg.id, text: msg.text };
  DOM.editText.textContent = (msg.text || '').slice(0, 60);
  DOM.editBar.classList.remove('hidden');
  DOM.msgInput.value = msg.text || '';
  DOM.msgInput.focus();
  autoResizeInput();
}

/* ══════════════════════════════════════════════
   КОНТЕКСТНОЕ МЕНЮ
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
    let x = e.clientX, y = e.clientY;
    const mw = menu.offsetWidth  || 180;
    const mh = menu.offsetHeight || 160;
    if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.style.bottom = '';
  } else {
    menu.style.left   = '50%';
    menu.style.top    = '50%';
    menu.style.transform = 'translate(-50%,-50%)';
  }
}

function ctxReply() {
  closeOverlay();
  if (_ctxMsg) openReplyBar(_ctxMsg);
}

function ctxCopy() {
  closeOverlay();
  if (_ctxMsg?.text) {
    navigator.clipboard.writeText(_ctxMsg.text)
      .then(() => showNotif('Скопировано', 'success'))
      .catch(() => showNotif('Не удалось скопировать', 'error'));
  }
}

function ctxEdit() {
  closeOverlay();
  if (_ctxMsg) openEditBar(_ctxMsg);
}

function ctxReact() {
  closeOverlay();
  const picker = DOM.reactionPicker;
  picker.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
}

function ctxDelete() {
  closeOverlay();
  if (!_ctxMsg) return;
  if (!confirm('Удалить сообщение?')) return;
  App.socket.emit('msg:delete', { chatId: App.currentChat, msgId: _ctxMsg.id });
}

function pickReaction(emoji) {
  DOM.reactionPicker.classList.add('hidden');
  DOM.overlay.classList.add('hidden');
  if (!_ctxMsg || !App.currentChat) return;
  App.socket.emit('msg:react', { chatId: App.currentChat, msgId: _ctxMsg.id, emoji });
}

function sendReaction(emoji) {
  if (!App.currentChat || !_ctxMsg) return;
  App.socket.emit('msg:react', { chatId: App.currentChat, msgId: _ctxMsg.id, emoji });
}

/* ══════════════════════════════════════════════
   МОДАЛКИ
══════════════════════════════════════════════ */
function closeModal(id) {
  $(id)?.classList.add('hidden');
  DOM.overlay.classList.add('hidden');
}

function closeOverlay() {
  DOM.overlay.classList.add('hidden');
  DOM.msgCtxMenu.classList.add('hidden');
  DOM.reactionPicker.classList.add('hidden');
}

function openImageModal(url) {
  DOM.modalImageEl.src = url;
  DOM.modalImage.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
}

/* ══════════════════════════════════════════════
   ПРОФИЛЬ
══════════════════════════════════════════════ */
function openMyProfile() {
  const u = App.currentUser;
  if (!u) return;
  DOM.profileUsername.textContent = u.username;
  DOM.profileBio.value = u.bio || '';
  DOM.profileAvatar.innerHTML = u.avatar
    ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
    : getInitialsEmoji(u.username);
  DOM.modalProfile.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
}

function saveProfile() {
  const bio = DOM.profileBio.value.trim();
  App.socket.emit('user:update', { bio, avatar: App.currentUser.avatar });
  App.currentUser.bio = bio;
  sessionStorage.setItem('chat_session', JSON.stringify(App.currentUser));
  closeModal('modal-profile');
  showNotif('Профиль сохранён', 'success');
}

function changeAvatar() {
  $('avatar-input').click();
}

async function onAvatarSelected() {
  const file = $('avatar-input').files[0];
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
      headers: { 'x-user-id': App.currentUser.id, 'x-token': App.currentUser.token },
      body:    formData,
    });
    const data = await res.json();
    if (data.ok) {
      App.currentUser.avatar = data.file.url;
      DOM.profileAvatar.innerHTML =
        `<img class="avatar-img" src="${escHtml(data.file.url)}" alt="">`;
      renderMyAvatar();
      showNotif('Фото обновлено', 'success');
    }
  } catch { showNotif('Ошибка загрузки фото', 'error'); }
}

/* ══════════════════════════════════════════════
   НОВЫЙ ЧАТ
══════════════════════════════════════════════ */
function openNewChat() {
  DOM.modalNewChat.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
  switchNewChatTab('private');
}

function switchNewChatTab(tab) {
  document.querySelectorAll('.nctab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nctab[onclick*="${tab}"]`)?.classList.add('active');
  $('nctab-private').classList.toggle('hidden', tab !== 'private');
  $('nctab-group').classList.toggle('hidden',   tab !== 'group');
}

let _userSearchTimer;
function searchUsers() {
  const q = DOM.ncUserSearch.value.trim();
  DOM.ncUserList.innerHTML = '';
  if (q.length < 2) return;
  clearTimeout(_userSearchTimer);
  _userSearchTimer = setTimeout(() => {
    App.socket.emit('users:search', { query: q });
  }, 300);
}

function onUsersSearch(data) {
  /* Если открыт модал нового чата */
  if (!DOM.modalNewChat.classList.contains('hidden')) {
    if (!data.users?.length) {
      DOM.ncUserList.innerHTML =
        '<div style="color:var(--text2);padding:8px">Не найдено</div>';
      return;
    }
    DOM.ncUserList.innerHTML = data.users.map(u => `
      <div class="contact-item" onclick="startDirectChat('${escHtml(u.id)}')">
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
    return;
  }

  /* Если открыта панель контактов */
  if (App.activeTab === 'contacts') {
    const resultsEl = $('contacts-search-results');
    if (!resultsEl) return;
    if (!data.users?.length) {
      resultsEl.innerHTML =
        '<div style="color:var(--text2);padding:8px">Не найдено</div>';
      return;
    }
    resultsEl.innerHTML = data.users.map(u => `
      <div class="contact-item" onclick="openUserProfile('${escHtml(u.id)}')">
        <div class="ci-avatar">
          ${u.avatar
            ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
            : getInitialsEmoji(u.username)}
        </div>
        <div class="ci-body">
          <div class="ci-top">
            <span class="ci-name">${escHtml(u.username)}</span>
            ${App.contacts.has(u.id)
              ? '<span style="font-size:11px;color:var(--accent)">В контактах</span>' : ''}
          </div>
          <div class="ci-bottom">
            <span style="font-size:12px;color:var(--text2)">${escHtml(u.bio || '')}</span>
          </div>
        </div>
        ${!App.contacts.has(u.id) && u.id !== App.currentUser?.id
          ? `<button onclick="addContact(event,'${escHtml(u.id)}')">➕</button>` : ''}
      </div>`).join('');
  }
}

function startDirectChat(userId) {
  App.socket.emit('chat:create', { type: 'direct', userId });
  closeModal('modal-new-chat');
}

function createGroup() {
  const name = DOM.ncGroupName.value.trim();
  if (!name) { showNotif('Введите название группы', 'error'); return; }
  App.socket.emit('chat:create', { type: 'group', name });
  closeModal('modal-new-chat');
}

/* ══════════════════════════════════════════════
   ИНФОРМАЦИЯ О ЧАТЕ
══════════════════════════════════════════════ */
function openChatInfo() {
  if (!App.currentChat) return;
  const chat = App.chats.get(App.currentChat);
  if (!chat) return;
  const info = chat.info;

  DOM.chatInfoTitle.textContent  = info.type === 'group' ? 'О группе' : 'О чате';
  DOM.chatInfoName.textContent   = info.name;
  DOM.chatInfoAvatar.innerHTML   = info.avatar
    ? `<img class="avatar-img" src="${escHtml(info.avatar)}" alt="">`
    : getInitialsEmoji(info.name);
  DOM.chatInfoMeta.innerHTML     = info.type === 'group'
    ? `<p>Участников: <strong>${info.memberCount || 0}</strong></p>
       ${info.description ? `<p>${escHtml(info.description)}</p>` : ''}`
    : '';
  DOM.chatInfoLeave.style.display = info.type === 'group' ? '' : 'none';
  DOM.chatInfoAvatarBtn.style.display =
    info.type === 'group' ? '' : 'none';

  DOM.modalChatInfo.classList.remove('hidden');
  DOM.overlay.classList.remove('hidden');
}

function leaveChat() {
  if (!App.currentChat) return;
  closeModal('modal-chat-info');
  if (!confirm('Покинуть группу?')) return;
  App.socket.emit('chat:leave', { chatId: App.currentChat });
}

function changeChatAvatar() {
  /* TODO */
}

/* ══════════════════════════════════════════════
   КОНТАКТЫ
══════════════════════════════════════════════ */
function onContactsList(data) {
  App.contacts.clear();
  (data.contacts || []).forEach(c => App.contacts.set(c.id, c));
  renderContactsPanel();
}

function onContactRequest(req) {
  App._pendingRequests.push(req);
  showNotif(`📩 ${req.fromUsername} хочет добавить вас в контакты`);
  if (App.activeTab === 'contacts') renderContactsPanel();
}

function onContactAccepted(data) {
  App.contacts.set(data.id, data);
  showNotif(`✅ ${data.username} принял(а) запрос`, 'success');
  if (App.activeTab === 'contacts') renderContactsPanel();
}

function renderContactsPanel() {
  const pending = App._pendingRequests || [];

  DOM.requestsList.innerHTML = pending.length
    ? pending.map(r => `
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
            <div style="display:flex;gap:6px;margin-top:4px">
              <button onclick="acceptContact('${escHtml(r.requestId)}')">✅ Принять</button>
              <button onclick="declineContact('${escHtml(r.requestId)}')">❌ Отклонить</button>
            </div>
          </div>
        </div>`).join('')
    : '<div style="color:var(--text2);padding:8px;font-size:13px">Нет запросов</div>';

  const contacts = [...App.contacts.values()];
  DOM.contactsList.innerHTML = contacts.length
    ? contacts.map(c => `
        <div class="contact-item" onclick="openUserProfile('${escHtml(c.id)}')">
          <div class="ci-avatar">
            ${c.avatar
              ? `<img class="avatar-img" src="${escHtml(c.avatar)}" alt="">`
              : getInitialsEmoji(c.username)}
            ${c.online ? '<span class="online-dot"></span>' : ''}
          </div>
          <div class="ci-body">
            <div class="ci-top">
              <span class="ci-name">${escHtml(c.username)}</span>
              ${c.online ? '<span style="font-size:11px;color:var(--accent)">В сети</span>' : ''}
            </div>
            <div class="ci-bottom">
              <span style="font-size:12px;color:var(--text2)">${escHtml(c.bio || '')}</span>
            </div>
          </div>
        </div>`).join('')
    : '<div style="color:var(--text2);padding:8px;font-size:13px">Нет контактов</div>';
}

function acceptContact(reqId) {
  App.socket.emit('contact:accept', { requestId: reqId });
  App._pendingRequests = App._pendingRequests.filter(r => r.requestId !== reqId);
  renderContactsPanel();
}

function declineContact(reqId) {
  App.socket.emit('contact:decline', { requestId: reqId });
  App._pendingRequests = App._pendingRequests.filter(r => r.requestId !== reqId);
  renderContactsPanel();
}

function addContact(e, userId) {
  e.stopPropagation();
  App.socket.emit('contact:request', { toUserId: userId });
  showNotif('Запрос отправлен', 'success');
}

function openUserProfile(userId) {
  const u = App.contacts.get(userId) || { id: userId, username: userId };
  const isSelf = userId === App.currentUser?.id;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <span>Профиль</span>
        <button class="modal-close" onclick="this.closest('.modal').remove();DOM.overlay.classList.add('hidden')">✕</button>
      </div>
      <div class="modal-body">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar">
            ${u.avatar
              ? `<img class="avatar-img" src="${escHtml(u.avatar)}" alt="">`
              : getInitialsEmoji(u.username)}
          </div>
          <div class="profile-username">${escHtml(u.username)}</div>
        </div>
        ${u.bio ? `<p style="text-align:center;color:var(--text2)">${escHtml(u.bio)}</p>` : ''}
        ${!isSelf ? `
          <button class="modal-btn" onclick="startDirectChat('${escHtml(userId)}');this.closest('.modal').remove()">
            💬 Написать
          </button>
          ${!App.contacts.has(userId) ? `
            <button class="modal-btn" onclick="addContactById('${escHtml(userId)}');this.closest('.modal').remove()">
              ➕ Добавить в контакты
            </button>` : ''}
        ` : ''}
      </div>
    </div>`;
  document.body.appendChild(modal);
  DOM.overlay.classList.remove('hidden');
}

function addContactById(userId) {
  App.socket.emit('contact:request', { toUserId: userId });
  showNotif('Запрос отправлен', 'success');
}

/* ══════════════════════════════════════════════
   EXPLORE
══════════════════════════════════════════════ */
function onGroupsExplore(data) {
  const groups = data.groups || [];
  if (!groups.length) {
    DOM.exploreList.innerHTML =
      '<div style="color:var(--text2);padding:16px;text-align:center">Нет публичных групп</div>';
    return;
  }
  DOM.exploreList.innerHTML = groups.map(g => `
    <div class="contact-item">
      <div class="ci-avatar">
        ${g.avatar
          ? `<img class="avatar-img" src="${escHtml(g.avatar)}" alt="">`
          : getInitialsEmoji(g.name)}
      </div>
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
      ${!App.chats.has(g.id)
        ? `<button class="modal-btn"
                   style="padding:4px 10px;font-size:12px"
                   onclick="joinGroup('${escHtml(g.id)}',this)">Вступить</button>`
        : '<span style="font-size:11px;color:var(--accent)">✓ Вступил</span>'}
    </div>`).join('');
}

function joinGroup(chatId, btn) {
  App.socket.emit('chat:join', { chatId });
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
}

function searchGroups() {
  const q = $('explore-input')?.value.trim() || '';
  App.socket.emit('groups:explore', { query: q });
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
      if (chat.info.type === 'direct' && chat.info.members?.includes(data.userId)) {
        App.sharedKeys.set(chatId, sharedKey);
      }
    });
  } catch (e) { console.warn('E2E:', e); }
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

  if (tab === 'contacts') renderContactsPanel();
  if (tab === 'explore')  App.socket.emit('groups:explore', {});
}

/* ══════════════════════════════════════════════
   ПРОЧИЕ ОБРАБОТЧИКИ HTML
══════════════════════════════════════════════ */
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
  document.querySelector(`.auth-tab[onclick*="'${tab}'"]`)?.classList.add('active');
  $(`tab-${tab}`)?.classList.remove('hidden');
}

function doLogin() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  $('login-err').textContent = '';
  if (!username || !password) { $('login-err').textContent = 'Заполните все поля'; return; }
  E2E.hashPassword(password).then(({ hash, salt }) => {
    App.socket.emit('auth:login', { username, passwordHash: hash, salt });
  });
}

function doRegister() {
  const username  = $('reg-username').value.trim();
  const password  = $('reg-password').value;
  const password2 = $('reg-password2').value;
  $('reg-err').textContent = '';
  if (!username || !password) { $('reg-err').textContent = 'Заполните все поля'; return; }
  if (password !== password2) { $('reg-err').textContent = 'Пароли не совпадают'; return; }
  if (password.length < 6)   { $('reg-err').textContent = 'Минимум 6 символов'; return; }
  E2E.hashPassword(password).then(({ hash, salt }) => {
    App.socket.emit('auth:register', { username, passwordHash: hash, salt });
  });
}

function doLogout() {
  App.socket.emit('auth:logout');
  showAuth();
}

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

function toggleAttachMenu() {
  DOM.attachMenu.classList.toggle('hidden');
}

function pickFile(accept) {
  DOM.fileInput.accept = accept;
  DOM.fileInput.click();
  DOM.attachMenu.classList.add('hidden');
}

function onMsgInput()      { autoResizeInput(); sendTyping(); }
function onMsgKeydown(e)   { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function cancelReply()     { clearReplyBar(); }
function cancelEdit()      { clearEditBar(); }
function onMessagesScroll(){}

/* ══════════════════════════════════════════════
   ТЕМА
══════════════════════════════════════════════ */
const Theme = {
  init() {
    const saved  = localStorage.getItem('chat_theme');
    const prefer = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
      if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.connect(gain); gain.connect(this._ctx.destination);
      osc.frequency.value = 880; osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, this._ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this._ctx.currentTime + 0.35);
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
   ТОЧКА ВХОДА
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  initDOM();
  Theme.init();
  await PushNotif.request();
  registerSW();

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeOverlay();
  });

  window.addEventListener('offline', () => showNotif('Нет интернета', 'error', 5000));
  window.addEventListener('online',  () => showNotif('Соединение восстановлено', 'success'));

  window.addEventListener('resize', () => {
    if (window.innerWidth > 700)
      $('sidebar')?.classList.remove('hidden-mobile');
  });

  /* E2E */
  try {
    App.keyPair    = await E2E.generateKeyPair();
    App.e2eEnabled = true;
  } catch (e) {
    console.warn('E2E недоступен:', e);
  }

  connectSocket();

  /* Восстановление сессии */
  const saved = sessionStorage.getItem('chat_session');
  if (saved) {
    try {
      const user = JSON.parse(saved);
      App.socket.once('connect', () => {
        App.socket.emit('auth:restore', { userId: user.id, token: user.token });
      });
    } catch {}
  }
  /* ══════════════════════════════════════════════
   ГЛОБАЛЬНЫЙ ЭКСПОРТ для onclick в HTML
══════════════════════════════════════════════ */
window.doLogin          = doLogin;
window.doRegister       = doRegister;
window.doLogout         = doLogout;
window.switchAuthTab    = switchAuthTab;
window.switchTab        = switchTab;
window.goBack           = goBack;
window.openChatInfo     = openChatInfo;
window.openNewChat      = openNewChat;
window.openMyProfile    = openMyProfile;
window.cancelReply      = cancelReply;
window.cancelEdit       = cancelEdit;
window.closeOverlay     = closeOverlay;
window.closeModal       = closeModal;
window.toggleAttachMenu = toggleAttachMenu;
window.pickFile         = pickFile;
window.onMsgInput       = onMsgInput;
window.onMsgKeydown     = onMsgKeydown;
window.onSearchInput    = onSearchInput;
window.clearSearch      = clearSearch;
window.searchGroups     = searchGroups;
window.searchUsers      = searchUsers;
window.openImageModal   = openImageModal;
window.ctxReply         = ctxReply;
window.ctxCopy          = ctxCopy;
window.ctxEdit          = ctxEdit;
window.ctxReact         = ctxReact;
window.ctxDelete        = ctxDelete;
window.pickReaction     = pickReaction;
window.sendReaction     = sendReaction;
window.startDirectChat  = startDirectChat;
window.createGroup      = createGroup;
window.switchNewChatTab = switchNewChatTab;
window.leaveChat        = leaveChat;
window.changeChatAvatar = changeChatAvatar;
window.changeAvatar     = changeAvatar;
window.saveProfile      = saveProfile;
window.onAvatarSelected = onAvatarSelected;
window.onFileSelected   = onFileSelected;
window.acceptContact    = acceptContact;
window.declineContact   = declineContact;
window.addContact       = addContact;
window.addContactById   = addContactById;
window.openUserProfile  = openUserProfile;
window.joinGroup        = joinGroup;
window.sendMessage      = sendMessage;
window.openChat         = openChat;
window.onMessagesScroll = onMessagesScroll;
});
