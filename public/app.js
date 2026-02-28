/* ═══════════════════════════════════════════════════════════
   УТИЛИТЫ
═══════════════════════════════════════════════════════════ */
const $   = id  => document.getElementById(id);
const qs  = (sel, ctx = document) => ctx.querySelector(sel);
const qsa = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function toast(msg, duration = 3000) {
  const el = document.createElement('div');
  el.className   = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('ru-RU', {
    hour:   '2-digit',
    minute: '2-digit'
  });
}

function formatDate(ts) {
  const d   = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function formatSize(bytes) {
  if (!bytes)              return '';
  if (bytes < 1024)        return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

function avatarLetter(name) {
  return (name || '?')[0].toUpperCase();
}

function avatarColor(name) {
  const colors = [
    '#5b6af0', '#e05592', '#f0a040', '#4caf7d',
    '#7c4af0', '#e07755', '#40b0f0', '#c05be0'
  ];
  let hash = 0;
  for (const c of (name || '')) {
    hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  }
  return colors[Math.abs(hash) % colors.length];
}

function makeAvatar(name, avatarUrl, size = 36) {
  const el = document.createElement('div');
  el.className = 'profile-avatar';
  el.style.cssText = [
    `width:${size}px`,
    `height:${size}px`,
    `font-size:${Math.round(size * 0.4)}px`,
    'flex-shrink:0'
  ].join(';');

  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = name;
    el.appendChild(img);
  } else {
    el.style.background = avatarColor(name);
    el.textContent      = avatarLetter(name);
  }
  return el;
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openModal(id)  { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

/* Закрытие модалок по data-close */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-close]');
  if (t) closeModal(t.dataset.close);
});

/* Закрытие по клику на оверлей */
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});

/* ═══════════════════════════════════════════════════════════
   СОСТОЯНИЕ
═══════════════════════════════════════════════════════════ */
const state = {
  token:        null,
  user:         null,
  rooms:        [],
  currentRoom:  null,
  messages:     [],
  members:      [],
  onlineUsers:  new Set(),
  replyTo:      null,
  typingTimers: {},
  typingUsers:  {},
  contacts:     [],
  requests:     [],
  searchQuery:  '',
};

/* ═══════════════════════════════════════════════════════════
   API
═══════════════════════════════════════════════════════════ */
async function api(method, url, body, isForm = false) {
  const opts = { method, headers: {} };

  if (state.token) {
    opts.headers['Authorization'] = `Bearer ${state.token}`;
  }

  if (body) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }

  const res  = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

/* ═══════════════════════════════════════════════════════════
   SOCKET
═══════════════════════════════════════════════════════════ */
let socket = null;

function initSocket() {
  socket = io({ auth: { token: state.token } });

  socket.on('connect', () => {
    console.log('[socket] connected');
    if (state.currentRoom) {
      socket.emit('room:join', { roomId: state.currentRoom.id });
    }
  });

  socket.on('connect_error', err => {
    console.error('[socket]', err.message);
  });

  /* ── Комнаты ── */
  socket.on('room:created', room => {
    if (!state.rooms.find(r => r.id === room.id)) {
      state.rooms.unshift(room);
      renderRooms();
    }
  });

  socket.on('room:deleted', ({ roomId }) => {
    state.rooms = state.rooms.filter(r => r.id !== roomId);
    if (state.currentRoom?.id === roomId) {
      state.currentRoom = null;
      showEmpty();
    }
    renderRooms();
  });

  socket.on('room:online', ({ roomId, count, users }) => {
    const room = state.rooms.find(r => r.id === roomId);
    if (room) {
      room.online      = count;
      room.onlineUsers = users;
    }
    if (state.currentRoom?.id === roomId) {
      updateRoomSub();
      updateMembersOnline(users);
    }
    renderRooms();
  });

  socket.on('room:user-joined', ({ roomId, userId, username }) => {
    if (state.currentRoom?.id === roomId && userId !== state.user.id) {
      appendSystemMsg(`${username} вошёл в комнату`);
    }
  });

  socket.on('room:user-left', ({ roomId, userId, username }) => {
    if (state.currentRoom?.id === roomId && userId !== state.user.id) {
      appendSystemMsg(`${username} покинул комнату`);
    }
  });

  /* ── Сообщения ── */
  socket.on('message:new', msg => {
    if (msg.roomId === state.currentRoom?.id) {
      state.messages.push(msg);
      appendMessage(msg);
      scrollToBottom();
    }
  });

  socket.on('message:edited', ({ messageId, text }) => {
    const msg = state.messages.find(m => m.id === messageId);
    if (msg) { msg.text = text; msg.edited = true; }

    const textEl = document.querySelector(
      `[data-msg-id="${messageId}"] .msg-text`
    );
    if (textEl) {
      textEl.textContent = text;
      if (!textEl.parentElement.querySelector('.msg-edited')) {
        const span = document.createElement('span');
        span.className   = 'msg-edited';
        span.textContent = '(ред.)';
        textEl.after(span);
      }
    }
  });

  socket.on('message:deleted', ({ messageId }) => {
    const el = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!el) return;
    const textEl = el.querySelector('.msg-text');
    if (textEl) {
      textEl.textContent = 'Сообщение удалено';
      textEl.classList.add('deleted');
    }
    const actions = el.querySelector('.msg-actions');
    if (actions) actions.remove();
  });

  socket.on('message:pinned', ({ roomId, message }) => {
    if (state.currentRoom?.id === roomId) {
      state.currentRoom.pinned = message;
      showPinned(message);
    }
  });

  socket.on('message:unpinned', ({ roomId }) => {
    if (state.currentRoom?.id === roomId) {
      state.currentRoom.pinned = null;
      $('pinned-bar').classList.add('hidden');
    }
  });

  /* ── Реакции ── */
  socket.on('reaction:updated', ({ messageId, reactions }) => {
    const el = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (el) renderReactions(el, messageId, reactions);
  });

  /* ── Typing ── */
  socket.on('typing:start', ({ roomId, userId, username }) => {
    if (roomId !== state.currentRoom?.id || userId === state.user.id) return;
    state.typingUsers[userId] = username;
    updateTyping();
    clearTimeout(state.typingTimers[userId]);
    state.typingTimers[userId] = setTimeout(() => {
      delete state.typingUsers[userId];
      updateTyping();
    }, 3000);
  });

  socket.on('typing:stop', ({ roomId, userId }) => {
    if (roomId !== state.currentRoom?.id) return;
    delete state.typingUsers[userId];
    clearTimeout(state.typingTimers[userId]);
    updateTyping();
  });

  /* ── Контакты / DM ── */
  socket.on('contact:request', ({ username }) => {
    toast(`📩 ${username} хочет добавить вас в контакты`);
    loadContacts();
  });

  socket.on('dm:message', ({ fromUsername, text }) => {
    toast(`💬 ${fromUsername}: ${text.slice(0, 60)}`);
  });

  /* ── Присутствие ── */
  socket.on('presence:online', ({ userId }) => {
    state.onlineUsers.add(userId);
    updateMembersOnline();
  });

  /* ── WebRTC ── */
  initWebRTC();
}

/* ═══════════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════════ */
function showApp() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  updateSidebarProfile();
  loadRooms();
  loadContacts();
  initMsgInput();
  initSocket();
}

function showAuth() {
  $('app-screen').classList.add('hidden');
  $('auth-screen').classList.remove('hidden');
}

/* Табы авторизации */
qsa('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const panel = tab.dataset.tab;
    $('login-form').classList.toggle('hidden',    panel !== 'login');
    $('register-form').classList.toggle('hidden', panel !== 'register');
    $('login-error').textContent = '';
    $('reg-error').textContent   = '';
  });
});

/* Вход */
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  $('login-error').textContent = '';
  try {
    const data  = await api('POST', '/api/login', { username, password });
    state.token = data.token;
    state.user  = data.user;
    localStorage.setItem('token', data.token);
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

/* Регистрация */
$('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('reg-username').value.trim();
  const password = $('reg-password').value;
  $('reg-error').textContent = '';
  try {
    const data  = await api('POST', '/api/register', { username, password });
    state.token = data.token;
    state.user  = data.user;
    localStorage.setItem('token', data.token);
    showApp();
  } catch (err) {
    $('reg-error').textContent = err.message;
  }
});

/* Выход */
$('logout-btn').addEventListener('click', e => {
  e.stopPropagation();
  localStorage.removeItem('token');
  state.token = null;
  state.user  = null;
  if (socket) { socket.disconnect(); socket = null; }
  showAuth();
});

/* Автологин */
(async () => {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    state.token = token;
    state.user  = await api('GET', '/api/me');
    showApp();
  } catch {
    localStorage.removeItem('token');
  }
})();
/* ═══════════════════════════════════════════════════════════
   ПРОФИЛЬ
═══════════════════════════════════════════════════════════ */
function updateSidebarProfile() {
  const { username, avatar } = state.user;
  $('sidebar-username').textContent = username;

  const avatarEl = $('sidebar-avatar');
  avatarEl.innerHTML = '';

  if (avatar) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = username;
    avatarEl.appendChild(img);
  } else {
    avatarEl.style.background = avatarColor(username);
    avatarEl.textContent      = avatarLetter(username);
  }
}

$('profile-btn').addEventListener('click', () => {
  const { username, avatar, bio } = state.user;
  $('profile-username').value = username;
  $('profile-bio').value      = bio || '';

  const avatarEl = $('profile-modal-avatar');
  avatarEl.innerHTML = '';

  if (avatar) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = username;
    avatarEl.appendChild(img);
  } else {
    avatarEl.style.background = avatarColor(username);
    avatarEl.textContent      = avatarLetter(username);
  }

  openModal('modal-profile');
});

$('save-profile-btn').addEventListener('click', async () => {
  const bio = $('profile-bio').value;
  try {
    await api('PATCH', '/api/me/bio', { bio });
    state.user.bio = bio;
    toast('Профиль сохранён ✓');
    closeModal('modal-profile');
  } catch (err) {
    toast('Ошибка: ' + err.message);
  }
});

$('avatar-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  const form = new FormData();
  form.append('avatar', file);

  try {
    const data        = await api('POST', '/api/me/avatar', form, true);
    state.user.avatar = data.avatar;
    updateSidebarProfile();

    const avatarEl     = $('profile-modal-avatar');
    avatarEl.innerHTML = '';
    const img          = document.createElement('img');
    img.src            = data.avatar;
    avatarEl.appendChild(img);

    toast('Аватар обновлён ✓');
  } catch (err) {
    toast('Ошибка: ' + err.message);
  }
});

/* ═══════════════════════════════════════════════════════════
   SIDEBAR TABS
═══════════════════════════════════════════════════════════ */
qsa('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('.sidebar-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const panel = tab.dataset.panel;
    $('panel-rooms').classList.toggle('hidden',    panel !== 'rooms');
    $('panel-contacts').classList.toggle('hidden', panel !== 'contacts');
  });
});

/* ═══════════════════════════════════════════════════════════
   КОМНАТЫ
═══════════════════════════════════════════════════════════ */
async function loadRooms() {
  try {
    state.rooms = await api('GET', '/api/rooms');
    renderRooms();
  } catch {
    toast('Не удалось загрузить комнаты');
  }
}

function renderRooms() {
  const q    = state.searchQuery.toLowerCase();
  const list = $('rooms-list');
  list.innerHTML = '';

  const filtered = state.rooms.filter(r =>
    r.name.toLowerCase().includes(q)
  );

  if (!filtered.length) {
    list.innerHTML = `
      <div class="text-muted text-sm" style="padding:16px;text-align:center">
        ${q ? 'Ничего не найдено' : 'Нет комнат'}
      </div>`;
    return;
  }

  filtered.forEach(room => {
    const bgColor = avatarColor(room.name);
    const item    = document.createElement('div');
    item.className      = 'room-item' +
      (state.currentRoom?.id === room.id ? ' active' : '');
    item.dataset.roomId = room.id;
    item.innerHTML = `
      <div class="room-icon" style="background:${bgColor}20;color:${bgColor}">
        ${room.isGroup ? '👥' : escHtml(room.name[0].toUpperCase())}
      </div>
      <div class="room-info">
        <div class="room-name">
          ${room.hasPass ? '🔒 ' : ''}${escHtml(room.name)}
        </div>
        <div class="room-meta">
          <span>Создал: ${escHtml(room.ownerName)}</span>
          ${room.online > 0
            ? `<span class="room-badge online">● ${room.online}</span>`
            : ''}
        </div>
      </div>`;
    item.addEventListener('click', () => joinRoom(room));
    list.appendChild(item);
  });
}

/* Поиск комнат */
$('room-search').addEventListener('input', e => {
  state.searchQuery = e.target.value.trim();
  renderRooms();
});

/* Создать комнату */
$('create-room-btn').addEventListener('click', () => {
  $('new-room-name').value        = '';
  $('new-room-pass').value        = '';
  $('new-room-group').checked     = false;
  $('create-room-error').textContent = '';
  openModal('modal-create-room');
  setTimeout(() => $('new-room-name').focus(), 100);
});

$('confirm-create-room').addEventListener('click', async () => {
  const name    = $('new-room-name').value.trim();
  const password = $('new-room-pass').value;
  const isGroup  = $('new-room-group').checked;
  $('create-room-error').textContent = '';

  if (!name) {
    $('create-room-error').textContent = 'Введите название';
    return;
  }

  try {
    await api('POST', '/api/rooms', { name, password, isGroup });
    closeModal('modal-create-room');
  } catch (err) {
    $('create-room-error').textContent = err.message;
  }
});

$('new-room-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('confirm-create-room').click();
});

/* ── Вход в комнату ────────────────────────────────────── */
let pendingRoom = null;

async function joinRoom(room) {
  if (state.currentRoom?.id === room.id) {
    closeMobileSidebar();
    return;
  }

  if (room.hasPass) {
    pendingRoom = room;
    $('room-pass-input').value       = '';
    $('room-pass-error').textContent = '';
    openModal('modal-room-pass');
    setTimeout(() => $('room-pass-input').focus(), 100);
    return;
  }

  await doJoinRoom(room, '');
}

$('confirm-room-pass').addEventListener('click', async () => {
  const password = $('room-pass-input').value;
  $('room-pass-error').textContent = '';
  try {
    await doJoinRoom(pendingRoom, password);
    closeModal('modal-room-pass');
  } catch (err) {
    $('room-pass-error').textContent = err.message;
  }
});

$('room-pass-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('confirm-room-pass').click();
});

function doJoinRoom(room, password) {
  return new Promise((resolve, reject) => {
    socket.emit('room:join', { roomId: room.id, password }, res => {
      if (res.error) return reject(new Error(res.error));

      if (state.currentRoom) {
        socket.emit('room:leave', { roomId: state.currentRoom.id });
      }

      state.currentRoom = room;
      state.messages    = res.messages || [];
      state.members     = res.members  || [];

      showChat(room, res);
      closeMobileSidebar();
      renderRooms();
      resolve();
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   ЧАТ
═══════════════════════════════════════════════════════════ */
function showEmpty() {
  $('chat-empty').classList.remove('hidden');
  $('chat-view').style.display = 'none';
}

function showChat(room, data) {
  $('chat-empty').classList.add('hidden');

  /* ← НОВОЕ: закрываем сайдбар на мобильном */
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('visible');

  const cv = $('chat-view');
  cv.style.display       = 'flex';
  cv.style.flexDirection = 'column';
  cv.style.height        = '100%';

  $('chat-room-name').textContent = room.name;
  updateRoomSub();

  /* Кнопка настроек — только для владельца */
  const settingsBtn = $('room-settings-btn');
  if (room.ownerId === state.user.id) {
    settingsBtn.classList.remove('hidden');
  } else {
    settingsBtn.classList.add('hidden');
  }

  /* Закреплённое сообщение */
  if (data.pinned) showPinned(data.pinned);
  else $('pinned-bar').classList.add('hidden');

  renderMessages(state.messages);
  renderMembers(state.members, data.online?.users || []);
  cancelReply();

  setTimeout(() => $('msg-input').focus(), 100);
}

function updateRoomSub() {
  const room = state.currentRoom;
  if (!room) return;
  $('chat-room-sub').textContent =
    `${room.online || 0} онлайн · ${room.isGroup ? 'групповая' : 'обычная'}`;
}

/* ── Рендер сообщений ──────────────────────────────────── */
function renderMessages(messages) {
  const wrap = $('messages-wrap');
  wrap.innerHTML = '';

  let lastDate   = null;
  let lastUserId = null;
  let lastTs     = 0;

  messages.forEach(msg => {
    const date = formatDate(msg.createdAt);
    if (date !== lastDate) {
      lastDate   = date;
      lastUserId = null;
      const div  = document.createElement('div');
      div.className   = 'date-divider';
      div.textContent = date;
      wrap.appendChild(div);
    }

    const grouped =
      lastUserId === msg.userId &&
      (msg.createdAt - lastTs) < 300 &&
      !msg.replyTo;

    lastUserId = msg.userId;
    lastTs     = msg.createdAt;

    wrap.appendChild(buildMessageEl(msg, grouped));
  });

  scrollToBottom();
}

function appendMessage(msg) {
  const wrap = $('messages-wrap');

  /* Разделитель даты если нужен */
  const date       = formatDate(msg.createdAt);
  const lastDateEl = wrap.querySelector('.date-divider:last-of-type');
  if (!lastDateEl || lastDateEl.textContent !== date) {
    const div       = document.createElement('div');
    div.className   = 'date-divider';
    div.textContent = date;
    wrap.appendChild(div);
  }

  /* Группировка */
  const prev    = state.messages[state.messages.length - 2];
  const grouped =
    prev &&
    prev.userId === msg.userId &&
    (msg.createdAt - prev.createdAt) < 300 &&
    !msg.replyTo;

  wrap.appendChild(buildMessageEl(msg, grouped));
}

function buildMessageEl(msg, grouped = false) {
  const isOwn = msg.userId === state.user.id;

  const el = document.createElement('div');
  el.className    = `msg${grouped ? ' grouped' : ''}`;
  el.dataset.msgId = msg.id;

  /* Аватар */
  const avatarEl    = makeAvatar(msg.username, msg.avatar, 36);
  avatarEl.className = 'msg-avatar';
  el.appendChild(avatarEl);

  /* Тело */
  const body    = document.createElement('div');
  body.className = 'msg-body';

  /* Заголовок */
  const header    = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML = `
    <span class="msg-username${isOwn ? ' own' : ''}">
      ${escHtml(msg.username)}
    </span>
    <span class="msg-time">${formatTime(msg.createdAt)}</span>`;
  body.appendChild(header);

  /* Reply-цитата */
  if (msg.replyTo) {
    const replyEl       = document.createElement('div');
    replyEl.className   = 'msg-reply';
    replyEl.textContent = '↩ ' + (msg.replyText || 'Сообщение');
    replyEl.addEventListener('click', () => scrollToMsg(msg.replyTo));
    body.appendChild(replyEl);
  }

  /* Файл */
  if (msg.fileUrl) body.appendChild(buildFileEl(msg));

  /* Текст */
  if (msg.text) {
    const textEl       = document.createElement('div');
    textEl.className   = 'msg-text';
    textEl.textContent = msg.text;
    body.appendChild(textEl);

    if (msg.edited) {
      const span       = document.createElement('span');
      span.className   = 'msg-edited';
      span.textContent = '(ред.)';
      textEl.after(span);
    }
  }

  /* Реакции */
  const reactionsEl    = document.createElement('div');
  reactionsEl.className = 'msg-reactions';
  body.appendChild(reactionsEl);
  if (msg.reactions) renderReactions(el, msg.id, msg.reactions);

  el.appendChild(body);
  el.appendChild(buildMsgActions(msg, isOwn));

  return el;
}

/* ── Файлы в сообщениях ────────────────────────────────── */
function buildFileEl(msg) {
  const { fileUrl, fileType, fileName, fileSize } = msg;
  const wrap = document.createElement('div');

  if (fileType?.startsWith('image/')) {
    const img       = document.createElement('img');
    img.className   = 'msg-image';
    img.src         = fileUrl;
    img.alt         = fileName || 'image';
    img.loading     = 'lazy';
    img.addEventListener('click', () => openLightbox(fileUrl));
    wrap.appendChild(img);

  } else if (fileType?.startsWith('video/')) {
    const video     = document.createElement('video');
    video.className = 'msg-video';
    video.src       = fileUrl;
    video.controls  = true;
    video.preload   = 'metadata';
    wrap.appendChild(video);

  } else if (fileType?.startsWith('audio/')) {
    const audio     = document.createElement('audio');
    audio.className = 'msg-audio';
    audio.src       = fileUrl;
    audio.controls  = true;
    wrap.appendChild(audio);

  } else {
    const fileEl      = document.createElement('a');
    fileEl.className  = 'msg-file';
    fileEl.href       = fileUrl;
    fileEl.target     = '_blank';
    fileEl.download   = fileName || 'file';
    fileEl.innerHTML  = `
      <span class="msg-file-icon">${getFileIcon(fileType)}</span>
      <div class="msg-file-info">
        <div class="msg-file-name">${escHtml(fileName || 'Файл')}</div>
        <div class="msg-file-size">${formatSize(fileSize)}</div>
      </div>
      <span style="color:var(--accent);font-size:18px">⬇</span>`;
    wrap.appendChild(fileEl);
  }

  return wrap;
}

function getFileIcon(type) {
  if (!type) return '📄';
  if (type.includes('pdf'))                          return '📕';
  if (type.includes('zip') || type.includes('rar')) return '🗜️';
  if (type.includes('word') || type.includes('doc')) return '📝';
  if (type.includes('text'))                         return '📃';
  return '📄';
}

/* ── Кнопки действий сообщения ─────────────────────────── */
function buildMsgActions(msg, isOwn) {
  const wrap    = document.createElement('div');
  wrap.className = 'msg-actions';

  /* Реакция */
  const reactBtn       = document.createElement('button');
  reactBtn.className   = 'msg-action-btn';
  reactBtn.title       = 'Реакция';
  reactBtn.textContent = '😊';
  reactBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleEmojiPicker(msg.id, reactBtn);
  });
  wrap.appendChild(reactBtn);

  /* Ответить */
  const replyBtn       = document.createElement('button');
  replyBtn.className   = 'msg-action-btn';
  replyBtn.title       = 'Ответить';
  replyBtn.textContent = '↩️';
  replyBtn.addEventListener('click', () => setReply(msg));
  wrap.appendChild(replyBtn);

  /* Редактировать (только своё текстовое) */
  if (isOwn && msg.text) {
    const editBtn       = document.createElement('button');
    editBtn.className   = 'msg-action-btn';
    editBtn.title       = 'Редактировать';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => startEdit(msg));
    wrap.appendChild(editBtn);
  }

  /* Закрепить (только владелец комнаты) */
  if (state.currentRoom?.ownerId === state.user.id) {
    const pinBtn       = document.createElement('button');
    pinBtn.className   = 'msg-action-btn';
    pinBtn.title       = 'Закрепить';
    pinBtn.textContent = '📌';
    pinBtn.addEventListener('click', () => {
      socket.emit(
        'message:pin',
        { messageId: msg.id, roomId: state.currentRoom.id },
        res => { if (res.error) toast('Ошибка: ' + res.error); }
      );
    });
    wrap.appendChild(pinBtn);
  }

  /* Удалить (своё или владелец комнаты) */
  const isOwner = state.currentRoom?.ownerId === state.user.id;
  if (isOwn || isOwner) {
    const delBtn       = document.createElement('button');
    delBtn.className   = 'msg-action-btn';
    delBtn.title       = 'Удалить';
    delBtn.textContent = '🗑️';
    delBtn.style.color = 'var(--danger)';
    delBtn.addEventListener('click', () => {
      if (!confirm('Удалить сообщение?')) return;
      socket.emit(
        'message:delete',
        { messageId: msg.id },
        res => { if (res.error) toast('Ошибка: ' + res.error); }
      );
    });
    wrap.appendChild(delBtn);
  }

  return wrap;
}

/* ── Реакции ───────────────────────────────────────────── */
const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','😡','💯'];

let emojiPickerEl    = null;
let emojiPickerMsgId = null;

function toggleEmojiPicker(msgId, anchor) {
  /* Закрыть если уже открыт для этого сообщения */
  if (emojiPickerEl && emojiPickerMsgId === msgId) {
    emojiPickerEl.remove();
    emojiPickerEl    = null;
    emojiPickerMsgId = null;
    return;
  }

  if (emojiPickerEl) emojiPickerEl.remove();

  const picker    = document.createElement('div');
  picker.className = 'emoji-picker';

  EMOJIS.forEach(emoji => {
    const btn       = document.createElement('button');
    btn.className   = 'emoji-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      socket.emit('reaction:toggle', { messageId: msgId, emoji });
      picker.remove();
      emojiPickerEl    = null;
      emojiPickerMsgId = null;
    });
    picker.appendChild(btn);
  });

  anchor.parentElement.style.position = 'relative';
  anchor.parentElement.appendChild(picker);
  emojiPickerEl    = picker;
  emojiPickerMsgId = msgId;
}

/* Закрытие пикера по клику вне */
document.addEventListener('click', () => {
  if (emojiPickerEl) {
    emojiPickerEl.remove();
    emojiPickerEl    = null;
    emojiPickerMsgId = null;
  }
});

function renderReactions(msgEl, msgId, reactions) {
  const container = msgEl.querySelector('.msg-reactions');
  if (!container) return;
  container.innerHTML = '';

  Object.entries(reactions || {}).forEach(([emoji, data]) => {
    const btn       = document.createElement('button');
    btn.className   = 'reaction-btn' +
      (data.users?.includes(state.user.id) ? ' own' : '');
    btn.innerHTML   = `${emoji} <span class="r-count">${data.count}</span>`;
    btn.addEventListener('click', () => {
      socket.emit('reaction:toggle', { messageId: msgId, emoji });
    });
    container.appendChild(btn);
  });
}

/* ── Скролл ────────────────────────────────────────────── */
function scrollToBottom(smooth = false) {
  const wrap = $('messages-wrap');
  wrap.scrollTo({ top: wrap.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

function scrollToMsg(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.background = 'var(--accent-soft)';
  setTimeout(() => { el.style.background = ''; }, 1500);
}

/* ── Закреплённое ──────────────────────────────────────── */
function showPinned(msg) {
  $('pinned-bar').classList.remove('hidden');
  $('pinned-text').textContent = msg.text || '📎 Файл';
  $('pinned-bar').onclick      = () => scrollToMsg(msg.id);
}

$('unpin-btn').addEventListener('click', e => {
  e.stopPropagation();
  if (!state.currentRoom) return;
  socket.emit(
    'message:unpin',
    { roomId: state.currentRoom.id },
    res => { if (res.error) toast('Ошибка: ' + res.error); }
  );
});

/* ── Поиск по сообщениям ───────────────────────────────── */
$('search-msg-btn').addEventListener('click', () => {
  const bar = $('msg-search-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) $('msg-search-input').focus();
});

$('msg-search-input').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  qsa('[data-msg-id]').forEach(el => {
    const text = el.querySelector('.msg-text')?.textContent.toLowerCase() || '';
    el.style.display = (!q || text.includes(q)) ? '' : 'none';
  });
});

/* ── Системное сообщение ───────────────────────────────── */
function appendSystemMsg(text) {
  const wrap       = $('messages-wrap');
  const div        = document.createElement('div');
  div.style.cssText = 'text-align:center;font-size:12px;color:var(--text-3);padding:4px 0';
  div.textContent  = text;
  wrap.appendChild(div);
  scrollToBottom();
}

/* ── Typing индикатор ──────────────────────────────────── */
function updateTyping() {
  const users = Object.values(state.typingUsers);
  const el    = $('typing-indicator');
  if (!users.length)      { el.textContent = ''; return; }
  if (users.length === 1)   el.textContent = `${users[0]} печатает...`;
  else                      el.textContent = `${users.join(', ')} печатают...`;
}

/* ── Лайтбокс ─────────────────────────────────────────── */
function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').classList.remove('hidden');
}

$('lightbox').addEventListener('click', () => {
  $('lightbox').classList.add('hidden');
  $('lightbox-img').src = '';
});
/* ═══════════════════════════════════════════════════════════
   REPLY
═══════════════════════════════════════════════════════════ */
function setReply(msg) {
  state.replyTo = msg;
  $('reply-to-name').textContent = msg.username;
  $('reply-bar').classList.remove('hidden');
  $('msg-input').focus();
}

function cancelReply() {
  state.replyTo = null;
  $('reply-bar').classList.add('hidden');
}

$('reply-close').addEventListener('click', cancelReply);

/* ═══════════════════════════════════════════════════════════
   РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
═══════════════════════════════════════════════════════════ */
let editingMsgId = null;

function startEdit(msg) {
  editingMsgId = msg.id;
  const input  = $('msg-input');
  input.value  = msg.text;
  autoResize(input);
  input.dataset.editing = '1';
  input.placeholder     = 'Редактирование...';
  input.focus();
}

function cancelEdit() {
  editingMsgId = null;
  const input  = $('msg-input');
  input.value            = '';
  input.dataset.editing  = '';
  input.placeholder      = 'Написать сообщение...';
  autoResize(input);
}

/* ═══════════════════════════════════════════════════════════
   ВВОД И ОТПРАВКА
═══════════════════════════════════════════════════════════ */
let msgInput    = null;
let typingSent  = false;
let typingStop  = null;
let pendingFile = null;

function initMsgInput() {
  msgInput = $('msg-input');

  msgInput.addEventListener('input', () => {
    autoResize(msgInput);
    if (!state.currentRoom) return;

    if (!typingSent) {
      typingSent = true;
      socket.emit('typing:start', { roomId: state.currentRoom.id });
    }

    clearTimeout(typingStop);
    typingStop = setTimeout(() => {
      typingSent = false;
      socket.emit('typing:stop', { roomId: state.currentRoom.id });
    }, 2000);
  });

  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Escape') {
      if (editingMsgId) cancelEdit();
      else cancelReply();
    }
  });

  $('send-btn').addEventListener('click', sendMessage);
}

function sendMessage() {
  if (!state.currentRoom || !msgInput) return;
  const text = msgInput.value.trim();

  /* Режим редактирования */
  if (editingMsgId) {
    if (!text) return;
    socket.emit(
      'message:edit',
      { messageId: editingMsgId, text },
      res => {
        if (res.error) toast('Ошибка: ' + res.error);
        else cancelEdit();
      }
    );
    return;
  }

  if (!text && !pendingFile) return;

  /* Есть файл — загружаем и отправляем */
  if (pendingFile) {
    uploadAndSend(text);
    return;
  }

  /* Обычное текстовое сообщение */
  socket.emit(
    'message:send',
    {
      roomId:  state.currentRoom.id,
      text,
      replyTo: state.replyTo?.id || null
    },
    res => { if (res.error) toast('Ошибка: ' + res.error); }
  );

  msgInput.value = '';
  autoResize(msgInput);
  cancelReply();
  socket.emit('typing:stop', { roomId: state.currentRoom.id });
  typingSent = false;
}

/* ═══════════════════════════════════════════════════════════
   ФАЙЛЫ
═══════════════════════════════════════════════════════════ */
$('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 50 * 1024 * 1024) {
    toast('Файл слишком большой (макс. 50 МБ)');
    $('file-input').value = '';
    return;
  }

  pendingFile = file;
  if (msgInput) {
    msgInput.placeholder = `📎 ${file.name}`;
    msgInput.focus();
  }
});

async function uploadAndSend(text) {
  if (!pendingFile) return;

  const form = new FormData();
  form.append('file', pendingFile);

  try {
    const data = await api('POST', '/api/upload', form, true);

    socket.emit(
      'message:send',
      {
        roomId:   state.currentRoom.id,
        text,
        fileUrl:  data.url,
        fileType: data.type,
        fileName: data.name,
        fileSize: data.size,
        replyTo:  state.replyTo?.id || null
      },
      res => { if (res.error) toast('Ошибка: ' + res.error); }
    );

    pendingFile              = null;
    msgInput.value           = '';
    msgInput.placeholder     = 'Написать сообщение...';
    autoResize(msgInput);
    cancelReply();
    $('file-input').value    = '';

  } catch (err) {
    toast('Ошибка загрузки: ' + err.message);
  }
}

/* ═══════════════════════════════════════════════════════════
   УЧАСТНИКИ
═══════════════════════════════════════════════════════════ */
function renderMembers(members, onlineUsers = []) {
  const list      = $('members-list');
  list.innerHTML  = '';
  const onlineSet = new Set(onlineUsers.map(String));

  /* Онлайн — первые, остальные по алфавиту */
  const sorted = [...members].sort((a, b) => {
    const aOn = onlineSet.has(String(a.userId));
    const bOn = onlineSet.has(String(b.userId));
    if (aOn && !bOn) return -1;
    if (!aOn && bOn) return  1;
    return a.username.localeCompare(b.username);
  });

  sorted.forEach(m => {
    const isOnline = onlineSet.has(String(m.userId));

    const item         = document.createElement('div');
    item.className     = 'member-item';
    item.dataset.memberId = m.userId;

    /* Аватар */
    const avatarWrap         = document.createElement('div');
    avatarWrap.className     = 'member-avatar';
    avatarWrap.style.background = avatarColor(m.username);

    if (m.avatar) {
      const img = document.createElement('img');
      img.src   = m.avatar;
      img.alt   = m.username;
      avatarWrap.appendChild(img);
    } else {
      avatarWrap.textContent = avatarLetter(m.username);
    }

    if (isOnline) {
      const dot     = document.createElement('div');
      dot.className = 'online-dot';
      avatarWrap.appendChild(dot);
    }

    /* Имя */
    const name         = document.createElement('div');
    name.className     = 'member-name';
    name.textContent   =
      m.username +
      (m.userId === state.user.id          ? ' (я)' : '') +
      (m.userId === state.currentRoom?.ownerId ? ' 👑' : '');
    name.style.color   = isOnline ? 'var(--text-1)' : 'var(--text-3)';

    item.appendChild(avatarWrap);
    item.appendChild(name);
    list.appendChild(item);
  });
}

function updateMembersOnline(onlineUsers) {
  if (!onlineUsers) {
    onlineUsers = state.currentRoom?.onlineUsers || [];
  }
  renderMembers(state.members, onlineUsers);
}

/* Тоггл панели участников */
$('members-toggle-btn').addEventListener('click', () => {
  const panel = $('members-panel');
  panel.classList.toggle('open');
  if (window.innerWidth <= 680 && panel.classList.contains('open')) {
    $('members-close-btn').style.display = 'flex';
  }
});

$('members-close-btn').addEventListener('click', () => {
  $('members-panel').classList.remove('open');
});

/* ═══════════════════════════════════════════════════════════
   НАСТРОЙКИ КОМНАТЫ
═══════════════════════════════════════════════════════════ */
$('room-settings-btn').addEventListener('click', () => {
  if (!state.currentRoom) return;
  $('room-settings-name').textContent = state.currentRoom.name;
  openModal('modal-room-settings');
});

$('delete-room-btn').addEventListener('click', async () => {
  if (!state.currentRoom) return;
  if (!confirm(`Удалить комнату "${state.currentRoom.name}"?`)) return;
  try {
    await api('DELETE', `/api/rooms/${state.currentRoom.id}`);
    closeModal('modal-room-settings');
    toast('Комната удалена');
  } catch (err) {
    toast('Ошибка: ' + err.message);
  }
});

/* ═══════════════════════════════════════════════════════════
   КОНТАКТЫ
═══════════════════════════════════════════════════════════ */
async function loadContacts() {
  try {
    const data      = await api('GET', '/api/contacts');
    state.contacts  = data.contacts || [];
    state.requests  = data.requests || [];
    renderContacts();
  } catch {}
}

function renderContacts() {
  const list     = $('contacts-list');
  list.innerHTML = '';

  if (!state.contacts.length) {
    list.innerHTML = `
      <div class="text-muted text-sm" style="padding:16px;text-align:center">
        Нет контактов
      </div>`;
  }

  state.contacts.forEach(c => {
    const isOnline = state.onlineUsers.has(c.userId);
    const item     = document.createElement('div');
    item.className = 'room-item';

    /* Аватар */
    const avatarWrap          = document.createElement('div');
    avatarWrap.className      = 'room-icon';
    avatarWrap.style.cssText  =
      `background:${avatarColor(c.username)}20;` +
      `color:${avatarColor(c.username)};` +
      `position:relative`;
    avatarWrap.textContent    = avatarLetter(c.username);

    if (isOnline) {
      const dot           = document.createElement('div');
      dot.className       = 'online-dot';
      dot.style.cssText   =
        'position:absolute;bottom:2px;right:2px;border-color:var(--bg-1)';
      avatarWrap.appendChild(dot);
    }

    /* Инфо */
    const info         = document.createElement('div');
    info.className     = 'room-info';
    info.innerHTML     = `
      <div class="room-name">${escHtml(c.username)}</div>
      <div class="room-meta">${isOnline ? '● Онлайн' : 'Оффлайн'}</div>`;

    /* Кнопка DM */
    const dmBtn           = document.createElement('button');
    dmBtn.className       = 'btn-icon';
    dmBtn.title           = 'Написать';
    dmBtn.textContent     = '💬';
    dmBtn.style.fontSize  = '16px';
    dmBtn.addEventListener('click', e => {
      e.stopPropagation();
      openDM(c);
    });

    item.appendChild(avatarWrap);
    item.appendChild(info);
    item.appendChild(dmBtn);
    list.appendChild(item);
  });

  /* ── Запросы в друзья ── */
  const reqBlock     = $('friend-requests-block');
  const reqList      = $('requests-list');
  reqList.innerHTML  = '';

  if (state.requests.length) {
    reqBlock.classList.remove('hidden');

    state.requests.forEach(r => {
      const item         = document.createElement('div');
      item.className     = 'room-item';
      item.style.padding = '8px';
      item.innerHTML     = `
        <div class="room-icon"
          style="background:${avatarColor(r.username)}20;color:${avatarColor(r.username)}">
          ${avatarLetter(r.username)}
        </div>
        <div class="room-info">
          <div class="room-name">${escHtml(r.username)}</div>
          <div class="room-meta">Запрос</div>
        </div>`;

      /* Принять */
      const acceptBtn         = document.createElement('button');
      acceptBtn.className     = 'btn btn-ghost';
      acceptBtn.textContent   = '✓';
      acceptBtn.style.cssText =
        'padding:4px 10px;font-size:14px;color:var(--success)';
      acceptBtn.addEventListener('click', async () => {
        try {
          await api('POST', `/api/contacts/${r.id}/accept`);
          toast(`${r.username} добавлен в контакты`);
          loadContacts();
        } catch (err) { toast(err.message); }
      });

      /* Отклонить */
      const rejectBtn         = document.createElement('button');
      rejectBtn.className     = 'btn btn-ghost';
      rejectBtn.textContent   = '✕';
      rejectBtn.style.cssText =
        'padding:4px 10px;font-size:14px;color:var(--danger)';
      rejectBtn.addEventListener('click', async () => {
        try {
          await api('DELETE', `/api/contacts/${r.id}`);
          loadContacts();
        } catch (err) { toast(err.message); }
      });

      item.appendChild(acceptBtn);
      item.appendChild(rejectBtn);
      reqList.appendChild(item);
    });

  } else {
    reqBlock.classList.add('hidden');
  }
}

/* Добавить контакт */
$('add-contact-btn').addEventListener('click', () => {
  $('contact-username').value        = '';
  $('add-contact-error').textContent = '';
  $('user-search-results').innerHTML = '';
  openModal('modal-add-contact');
  setTimeout(() => $('contact-username').focus(), 100);
});

$('confirm-add-contact').addEventListener('click', async () => {
  const username = $('contact-username').value.trim();
  $('add-contact-error').textContent = '';

  if (!username) {
    $('add-contact-error').textContent = 'Введите имя пользователя';
    return;
  }

  try {
    await api('POST', '/api/contacts', { username });
    toast(`Запрос отправлен ${username}`);
    closeModal('modal-add-contact');
  } catch (err) {
    $('add-contact-error').textContent = err.message;
  }
});

$('contact-username').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('confirm-add-contact').click();
});

/* DM через prompt */
function openDM(contact) {
  const text = prompt(`Написать ${contact.username}:`);
  if (!text?.trim()) return;
  socket.emit(
    'dm:send',
    { targetUserId: contact.userId, text: text.trim() },
    res => {
      if (res.error) toast('Ошибка: ' + res.error);
      else toast(`Сообщение отправлено ${contact.username}`);
    }
  );
}

/* ═══════════════════════════════════════════════════════════
   МОБИЛЬНОЕ МЕНЮ
═══════════════════════════════════════════════════════════ */
$('mobile-menu-btn').addEventListener('click', () => {
  $('sidebar').classList.toggle('open');
  $('sidebar-overlay').classList.toggle('visible');
});

$('sidebar-overlay').addEventListener('click', closeMobileSidebar);

function closeMobileSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('visible');
}
/* ═══════════════════════════════════════════════════════════
   WebRTC — ГОЛОСОВЫЕ / ВИДЕО ЗВОНКИ
═══════════════════════════════════════════════════════════ */
const rtc = {
  peer:        null,   /* RTCPeerConnection          */
  localStream: null,   /* MediaStream с микрофона/камеры */
  roomId:      null,   /* комната в которой идёт звонок  */
  isCaller:    false,  /* мы инициировали звонок?        */
  videoEnabled: false, /* включено ли видео?             */
  audioEnabled: true,  /* включён ли микрофон?           */
};

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

/* ── UI-хелперы ────────────────────────────────────────── */
function showCallBar(label) {
  $('call-bar').classList.remove('hidden');
  $('call-status').textContent = label;
}

function hideCallBar() {
  $('call-bar').classList.add('hidden');
  $('call-status').textContent = '';
}

function setCallBtn(active) {
  $('voice-call-btn').classList.toggle('active', active);
  $('video-call-btn').classList.toggle('active', active);
}

/* ── Получить медиапоток ───────────────────────────────── */
async function getLocalStream(withVideo = false) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo
    });
    return stream;
  } catch (err) {
    toast('Нет доступа к микрофону/камере: ' + err.message);
    return null;
  }
}

/* ── Создать RTCPeerConnection ─────────────────────────── */
function createPeer() {
  const peer = new RTCPeerConnection(ICE_SERVERS);

  /* Отправляем ICE-кандидаты собеседнику */
  peer.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('rtc:ice', {
        roomId:    rtc.roomId,
        candidate: e.candidate
      });
    }
  };

  /* Получаем удалённый поток */
  peer.ontrack = e => {
    const remoteVideo = $('remote-video');
    if (remoteVideo.srcObject !== e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
    }
  };

  peer.onconnectionstatechange = () => {
    const s = peer.connectionState;
    if (s === 'connected') {
      showCallBar('🔴 В звонке');
    }
    if (s === 'disconnected' || s === 'failed' || s === 'closed') {
      endCall(false);
    }
  };

  return peer;
}

/* ── Начать звонок (caller) ────────────────────────────── */
async function startCall(withVideo = false) {
  if (!state.currentRoom) return;
  if (rtc.peer) { toast('Звонок уже идёт'); return; }

  rtc.videoEnabled = withVideo;
  rtc.isCaller     = true;
  rtc.roomId       = state.currentRoom.id;

  const stream = await getLocalStream(withVideo);
  if (!stream) return;

  rtc.localStream  = stream;
  showLocalVideo(stream, withVideo);

  rtc.peer = createPeer();
  stream.getTracks().forEach(t => rtc.peer.addTrack(t, stream));

  const offer = await rtc.peer.createOffer();
  await rtc.peer.setLocalDescription(offer);

  socket.emit('rtc:offer', {
    roomId: rtc.roomId,
    offer:  rtc.peer.localDescription
  });

  showCallBar('📞 Вызов...');
  setCallBtn(true);
}

/* ── Принять звонок (callee) ───────────────────────────── */
async function answerCall(offer, fromRoomId, withVideo = false) {
  if (rtc.peer) endCall(false);   /* завершаем предыдущий если был */

  rtc.videoEnabled = withVideo;
  rtc.isCaller     = false;
  rtc.roomId       = fromRoomId;

  const stream = await getLocalStream(withVideo);
  if (!stream) return;

  rtc.localStream = stream;
  showLocalVideo(stream, withVideo);

  rtc.peer = createPeer();
  stream.getTracks().forEach(t => rtc.peer.addTrack(t, stream));

  await rtc.peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await rtc.peer.createAnswer();
  await rtc.peer.setLocalDescription(answer);

  socket.emit('rtc:answer', {
    roomId: fromRoomId,
    answer: rtc.peer.localDescription
  });

  showCallBar('🔴 В звонке');
  setCallBtn(true);
}

/* ── Завершить звонок ──────────────────────────────────── */
function endCall(notify = true) {
  if (notify && rtc.roomId) {
    socket.emit('rtc:end', { roomId: rtc.roomId });
  }

  if (rtc.localStream) {
    rtc.localStream.getTracks().forEach(t => t.stop());
    rtc.localStream = null;
  }

  if (rtc.peer) {
    rtc.peer.close();
    rtc.peer = null;
  }

  rtc.roomId       = null;
  rtc.isCaller     = false;
  rtc.videoEnabled = false;

  hideCallBar();
  setCallBtn(false);
  hideLocalVideo();

  const remoteVideo = $('remote-video');
  if (remoteVideo) remoteVideo.srcObject = null;
}

/* ── Управление микрофоном ─────────────────────────────── */
function toggleMic() {
  if (!rtc.localStream) return;
  rtc.audioEnabled = !rtc.audioEnabled;
  rtc.localStream.getAudioTracks().forEach(t => {
    t.enabled = rtc.audioEnabled;
  });
  const btn = $('toggle-mic-btn');
  if (btn) {
    btn.textContent = rtc.audioEnabled ? '🎙️' : '🔇';
    btn.title       = rtc.audioEnabled ? 'Выкл. микрофон' : 'Вкл. микрофон';
  }
  toast(rtc.audioEnabled ? 'Микрофон включён' : 'Микрофон выключен');
}

/* ── Управление камерой ────────────────────────────────── */
function toggleCamera() {
  if (!rtc.localStream) return;
  rtc.videoEnabled = !rtc.videoEnabled;
  rtc.localStream.getVideoTracks().forEach(t => {
    t.enabled = rtc.videoEnabled;
  });
  const btn = $('toggle-cam-btn');
  if (btn) {
    btn.textContent = rtc.videoEnabled ? '📷' : '📷❌';
    btn.title       = rtc.videoEnabled ? 'Выкл. камеру' : 'Вкл. камеру';
  }
  toast(rtc.videoEnabled ? 'Камера включена' : 'Камера выключена');
}

/* ── Локальное видео ───────────────────────────────────── */
function showLocalVideo(stream, withVideo) {
  const localVideo = $('local-video');
  if (!localVideo) return;
  localVideo.srcObject = stream;
  localVideo.classList.toggle('hidden', !withVideo);
}

function hideLocalVideo() {
  const localVideo = $('local-video');
  if (!localVideo) return;
  localVideo.srcObject = null;
  localVideo.classList.add('hidden');
}

/* ── Socket-события WebRTC ─────────────────────────────── */
function initWebRTC() {
  /* Входящий звонок */
  socket.on('rtc:offer', async ({ offer, roomId, fromUsername }) => {
    if (rtc.peer) {
      /* Уже в звонке — отклоняем */
      socket.emit('rtc:busy', { roomId });
      return;
    }

    const accept = confirm(
      `📞 ${fromUsername} звонит. Принять звонок?`
    );

    if (accept) {
      await answerCall(offer, roomId, false);
    } else {
      socket.emit('rtc:decline', { roomId });
    }
  });

  /* Получен ответ (caller) */
  socket.on('rtc:answer', async ({ answer }) => {
    if (!rtc.peer) return;
    try {
      await rtc.peer.setRemoteDescription(
        new RTCSessionDescription(answer)
      );
    } catch (err) {
      console.error('[rtc] setRemoteDescription:', err);
    }
  });

  /* ICE-кандидат от собеседника */
  socket.on('rtc:ice', async ({ candidate }) => {
    if (!rtc.peer) return;
    try {
      await rtc.peer.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (err) {
      console.error('[rtc] addIceCandidate:', err);
    }
  });

  /* Собеседник завершил звонок */
  socket.on('rtc:end', () => {
    toast('Звонок завершён');
    endCall(false);
  });

  /* Отклонён */
  socket.on('rtc:decline', () => {
    toast('Звонок отклонён');
    endCall(false);
  });

  /* Занят */
  socket.on('rtc:busy', () => {
    toast('Пользователь уже в звонке');
    endCall(false);
  });
}

/* ── Кнопки интерфейса ─────────────────────────────────── */
const voiceCallBtn = $('voice-call-btn');
const videoCallBtn = $('video-call-btn');
const endCallBtn   = $('end-call-btn');
const toggleMicBtn = $('toggle-mic-btn');
const toggleCamBtn = $('toggle-cam-btn');

if (voiceCallBtn) {
  voiceCallBtn.addEventListener('click', () => {
    if (rtc.peer) endCall();
    else startCall(false);
  });
}

if (videoCallBtn) {
  videoCallBtn.addEventListener('click', () => {
    if (rtc.peer) endCall();
    else startCall(true);
  });
}

if (endCallBtn) {
  endCallBtn.addEventListener('click', () => endCall());
}

if (toggleMicBtn) {
  toggleMicBtn.addEventListener('click', toggleMic);
}

if (toggleCamBtn) {
  toggleCamBtn.addEventListener('click', toggleCamera);
}

/* ═══════════════════════════════════════════════════════════
   ТЕМА (светлая / тёмная)
═══════════════════════════════════════════════════════════ */
(function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.dataset.theme = saved;

  const btn = $('theme-toggle-btn');
  if (!btn) return;

  btn.textContent = saved === 'dark' ? '☀️' : '🌙';

  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark'
      ? 'light'
      : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    btn.textContent = next === 'dark' ? '☀️' : '🌙';
  });
})();

/* ═══════════════════════════════════════════════════════════
   ГОРЯЧИЕ КЛАВИШИ
═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  /* Ctrl/Cmd + K — фокус на поиск комнат */
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    $('room-search').focus();
  }

  /* Ctrl/Cmd + Enter — отправить сообщение */
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    sendMessage();
  }

  /* Escape — закрыть любую открытую модалку */
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => {
      m.classList.add('hidden');
    });
  }
});

/* ═══════════════════════════════════════════════════════════
   RESIZE — адаптив
═══════════════════════════════════════════════════════════ */
window.addEventListener('resize', () => {
  /* Закрываем мобильный сайдбар если экран расширился */
  if (window.innerWidth > 680) {
    $('sidebar').classList.remove('open');
    $('sidebar-overlay').classList.remove('visible');
  }

  /* Закрываем панель участников на широком экране */
  if (window.innerWidth > 900) {
    $('members-close-btn').style.display = 'none';
  }
});
