// ═══════════════════════════════════════════════
//  CRYPTO — AES-256-GCM
// ═══════════════════════════════════════════════
const Crypto = (() => {
  let cryptoKey = null;

  // Ключ на основе roomId + случайной соли (одинаковой для всей комнаты)
  // Используем roomId как «пароль» для E2E внутри комнаты.
  // Дополнительно можно передавать реальный пароль.
  async function deriveKey(secret) {
    const enc    = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const salt = enc.encode('voicechat-salt-v2');
    cryptoKey  = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return cryptoKey;
  }

  async function encrypt(data) {
    const iv      = crypto.getRandomValues(new Uint8Array(12));
    const encoded = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
    const cipher  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    return {
      iv:        btoa(String.fromCharCode(...iv)),
      encrypted: btoa(String.fromCharCode(...new Uint8Array(cipher)))
    };
  }

  async function decrypt(encB64, ivB64) {
    const iv     = Uint8Array.from(atob(ivB64),  c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, cipher);
  }

  async function decryptText(encB64, ivB64) {
    return new TextDecoder().decode(await decrypt(encB64, ivB64));
  }

  async function decryptBlob(encB64, ivB64, mime) {
    return new Blob([await decrypt(encB64, ivB64)], { type: mime });
  }

  return { deriveKey, encrypt, decryptText, decryptBlob };
})();

// ═══════════════════════════════════════════════
//  SOCKET
// ═══════════════════════════════════════════════
const socket = io({
  reconnection:         true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:    1000,
  reconnectionDelayMax: 5000,
  timeout:              20000,
  transports:           ['websocket', 'polling'],
  autoConnect:          true,
});

// ── DOM: экраны ──
const screenNick  = document.getElementById('screen-nick');
const screenLobby = document.getElementById('screen-lobby');
const screenMain  = document.getElementById('screen-main');

// ── DOM: ник ──
const nickInput       = document.getElementById('nick-input');
const nickError       = document.getElementById('nick-error');
const btnNickEnter    = document.getElementById('btn-nick-enter');

// ── DOM: лобби ──
const lobbyNickLabel  = document.getElementById('lobby-nick-label');
const roomsList       = document.getElementById('rooms-list');
const btnCreateRoom   = document.getElementById('btn-create-room');

// ── DOM: модалка создания ──
const modalCreate        = document.getElementById('modal-create-room');
const btnCloseCreate     = document.getElementById('btn-close-create');
const roomPhotoBtn       = document.getElementById('room-photo-btn');
const roomPhotoInput     = document.getElementById('room-photo-input');
const createRoomName     = document.getElementById('create-room-name');
const createRoomPw       = document.getElementById('create-room-pw');
const btnToggleCreatePw  = document.getElementById('btn-toggle-create-pw');
const createRoomError    = document.getElementById('create-room-error');
const btnSubmitCreate    = document.getElementById('btn-submit-create');

// ── DOM: модалка пароля комнаты ──
const modalRoomPw       = document.getElementById('modal-room-password');
const btnClosePwModal   = document.getElementById('btn-close-pw-modal');
const pwModalRoomName   = document.getElementById('pw-modal-room-name');
const roomPwInput       = document.getElementById('room-pw-input');
const btnToggleRoomPw   = document.getElementById('btn-toggle-room-pw');
const roomPwError       = document.getElementById('room-pw-error');
const btnSubmitRoomPw   = document.getElementById('btn-submit-room-pw');

// ── DOM: чат ──
const chatRoomAvatar   = document.getElementById('chat-room-avatar');
const chatRoomName     = document.getElementById('chat-room-name');
const userCount        = document.getElementById('user-count');
const btnBackLobby     = document.getElementById('btn-back-lobby');
const btnJoin          = document.getElementById('btn-join');
const btnLeave         = document.getElementById('btn-leave');
const btnMic           = document.getElementById('btn-mic');
const micStatus        = document.getElementById('mic-status');
const hiddenAudios     = document.getElementById('hidden-audios');
const participantsBox  = document.getElementById('participants');
const participantsList = document.getElementById('participants-list');
const reconnectBanner  = document.getElementById('reconnect-banner');
const keepAliveAudio   = document.getElementById('keep-alive-audio');
const chatMessages     = document.getElementById('chat-messages');
const chatInput        = document.getElementById('chat-input');
const btnSend          = document.getElementById('btn-send');
const btnPhoto         = document.getElementById('btn-photo');
const btnVideo         = document.getElementById('btn-video');
const btnFile          = document.getElementById('btn-file');
const fileInput        = document.getElementById('file-input');
const lightbox         = document.getElementById('lightbox');
const lightboxContent  = document.getElementById('lightbox-content');
const lightboxClose    = document.getElementById('lightbox-close');
const noiseIndicator   = document.getElementById('noise-indicator');

// ── Состояние ──
let myNickname      = '';
let currentRoomId   = null;
let currentRoomData = null;
let pendingJoinRoom = null; // { roomId, name } — ожидает ввода пароля
let roomPhotoData   = null; // base64 строка для фото комнаты
let memberCount     = 0;

let localStream     = null;
let processedStream = null;
let noiseWorklet    = null;
let peers           = {};
let micEnabled      = true;
let pendingOffers   = [];
let joined          = false;
let audioCtx        = null;
let wakeLock        = null;
let pendingFileType = 'image/*';
let msgCounter      = 0;

const analysers     = {};
const qualityTimers = {};

// ═══════════════════════════════════════════════
//  УТИЛИТЫ
// ═══════════════════════════════════════════════
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;') .replace(/"/g,'&quot;');
}
function formatSize(bytes) {
  if (bytes < 1024)       return bytes + ' Б';
  if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' КБ';
  return (bytes/1024/1024).toFixed(1) + ' МБ';
}
function shortId(id) { return id ? id.slice(0,6) : '??'; }

function showScreen(name) {
  [screenNick, screenLobby, screenMain].forEach(s => s.classList.remove('active'));
  if (name === 'nick')  screenNick.classList.add('active');
  if (name === 'lobby') screenLobby.classList.add('active');
  if (name === 'chat')  screenMain.classList.add('active');
}

// ═══════════════════════════════════════════════
//  ЭКРАН: ВВОД НИКА
// ═══════════════════════════════════════════════
nickInput.addEventListener('keydown', e => { if (e.key === 'Enter') enterNick(); });
btnNickEnter.addEventListener('click', enterNick);

function enterNick() {
  const nick = nickInput.value.trim();
  if (!nick) { showNickError('Введи своё имя'); return; }

  btnNickEnter.disabled    = true;
  btnNickEnter.textContent = '⏳';

  socket.emit('set-nickname', nick, (res) => {
    btnNickEnter.disabled    = false;
    btnNickEnter.textContent = 'Войти →';
    if (res && res.ok) {
      myNickname = nick;
      lobbyNickLabel.textContent = '👤 ' + nick;
      showScreen('lobby');
    } else {
      showNickError('Ошибка, попробуй снова');
    }
  });
}

function showNickError(msg) {
  nickError.textContent = msg;
  setTimeout(() => { nickError.textContent = ''; }, 3000);
}

// ═══════════════════════════════════════════════
//  SOCKET: список комнат
// ═══════════════════════════════════════════════
socket.on('room-list', (list) => {
  renderRoomList(list);
});

function renderRoomList(list) {
  if (!list || list.length === 0) {
    roomsList.innerHTML = `
      <div class="rooms-empty">
        <div class="rooms-empty-icon">🏠</div>
        <div>Комнат пока нет.<br>Создай первую!</div>
      </div>`;
    return;
  }

  roomsList.innerHTML = list.map(room => `
    <div class="room-card" data-id="${room.id}"
         data-has-pw="${room.hasPassword}"
         data-name="${escapeHtml(room.name)}">
      <div class="room-avatar">
        ${room.photo
          ? `<img src="${room.photo}" alt="">`
          : '🏠'}
      </div>
      <div class="room-info">
        <div class="room-name">${escapeHtml(room.name)}</div>
        <div class="room-meta">
          ${room.hasPassword ? '<span class="room-badge-lock">🔐 Закрытая</span>' : '<span>🌐 Открытая</span>'}
          <span class="room-badge-members">· 👥 ${room.memberCount}</span>
        </div>
      </div>
      <div style="color:var(--sub);font-size:20px">›</div>
    </div>
  `).join('');

  // Клик по карточке
  roomsList.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('click', () => {
      const roomId  = card.dataset.id;
      const hasPw   = card.dataset.hasPw === 'true';
      const name    = card.dataset.name;

      if (hasPw) {
        openRoomPasswordModal(roomId, name);
      } else {
        joinRoom(roomId, '');
      }
    });
  });
}

// ═══════════════════════════════════════════════
//  СОЗДАНИЕ КОМНАТЫ
// ═══════════════════════════════════════════════
btnCreateRoom.addEventListener('click', () => {
  createRoomName.value  = '';
  createRoomPw.value    = '';
  createRoomError.textContent = '';
  roomPhotoData         = null;
  roomPhotoBtn.innerHTML = '<span class="cam-icon">📷</span><span>Фото</span>';
  modalCreate.classList.add('open');
  setTimeout(() => createRoomName.focus(), 200);
});

btnCloseCreate.addEventListener('click', () => modalCreate.classList.remove('open'));
modalCreate.addEventListener('click', e => {
  if (e.target === modalCreate) modalCreate.classList.remove('open');
});

// Фото комнаты
roomPhotoBtn.addEventListener('click', () => roomPhotoInput.click());
roomPhotoInput.addEventListener('change', () => {
  const file = roomPhotoInput.files[0];
  if (!file) return;
  roomPhotoInput.value = '';
  if (file.size > 5 * 1024 * 1024) { alert('Фото слишком большое. Максимум 5 МБ.'); return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    roomPhotoData = e.target.result;
    roomPhotoBtn.innerHTML = `<img src="${roomPhotoData}" alt="фото комнаты">`;
  };
  reader.readAsDataURL(file);
});

// Переключатель пароля
btnToggleCreatePw.addEventListener('click', () => {
  const isText = createRoomPw.type === 'text';
  createRoomPw.type            = isText ? 'password' : 'text';
  btnToggleCreatePw.textContent = isText ? '👁' : '🙈';
});

btnSubmitCreate.addEventListener('click', submitCreateRoom);
createRoomName.addEventListener('keydown', e => {
  if (e.key === 'Enter') submitCreateRoom();
});

function submitCreateRoom() {
  const name = createRoomName.value.trim();
  if (!name) {
    createRoomError.textContent = 'Введи название комнаты';
    return;
  }

  btnSubmitCreate.disabled    = true;
  btnSubmitCreate.textContent = '⏳ Создаём…';

  socket.emit('create-room', {
    name,
    password: createRoomPw.value || '',
    photo:    roomPhotoData || null
  }, (res) => {
    btnSubmitCreate.disabled    = false;
    btnSubmitCreate.textContent = 'Создать комнату';

    if (res && res.ok) {
      modalCreate.classList.remove('open');
      joinRoom(res.roomId, createRoomPw.value || '');
    } else {
      createRoomError.textContent = 'Ошибка создания. Попробуй снова.';
    }
  });
}

// ═══════════════════════════════════════════════
//  ВВОД ПАРОЛЯ ДЛЯ ВХОДА В КОМНАТУ
// ═══════════════════════════════════════════════
function openRoomPasswordModal(roomId, roomName) {
  pendingJoinRoom = { roomId, roomName };
  pwModalRoomName.textContent  = roomName;
  roomPwInput.value            = '';
  roomPwError.textContent      = '';
  modalRoomPw.classList.add('open');
  setTimeout(() => roomPwInput.focus(), 200);
}

btnClosePwModal.addEventListener('click', () => {
  modalRoomPw.classList.remove('open');
  pendingJoinRoom = null;
});
modalRoomPw.addEventListener('click', e => {
  if (e.target === modalRoomPw) {
    modalRoomPw.classList.remove('open');
    pendingJoinRoom = null;
  }
});

btnToggleRoomPw.addEventListener('click', () => {
  const isText = roomPwInput.type === 'text';
  roomPwInput.type            = isText ? 'password' : 'text';
  btnToggleRoomPw.textContent = isText ? '👁' : '🙈';
});

btnSubmitRoomPw.addEventListener('click', submitRoomPassword);
roomPwInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') submitRoomPassword();
});

function submitRoomPassword() {
  if (!pendingJoinRoom) return;
  const pw = roomPwInput.value;
  if (!pw) { roomPwError.textContent = 'Введи пароль'; return; }

  btnSubmitRoomPw.disabled    = true;
  btnSubmitRoomPw.textContent = '⏳ Проверяем…';

  joinRoom(pendingJoinRoom.roomId, pw, (ok, err) => {
    btnSubmitRoomPw.disabled    = false;
    btnSubmitRoomPw.textContent = 'Войти в комнату';

    if (ok) {
      modalRoomPw.classList.remove('open');
      pendingJoinRoom = null;
    } else if (err === 'wrong_password') {
      roomPwError.textContent = '❌ Неверный пароль';
      roomPwInput.style.animation = 'shake 0.35s';
      setTimeout(() => { roomPwInput.style.animation = ''; }, 400);
    } else {
      roomPwError.textContent = '⚠️ Комната не найдена';
    }
  });
}

// ═══════════════════════════════════════════════
//  ВХОД В КОМНАТУ
// ═══════════════════════════════════════════════
function joinRoom(roomId, password, cb) {
  socket.emit('join-room', { roomId, password }, async (res) => {
    if (res && res.ok) {
      currentRoomId   = roomId;
      currentRoomData = res.room;

      // Деривируем ключ шифрования на основе roomId + пароля
      const cryptoSecret = roomId + ':' + (password || 'open');
      await Crypto.deriveKey(cryptoSecret);

      // Обновляем шапку
      chatRoomName.textContent = res.room.name;
      userCount.textContent    = res.room.members.length + 1; // +1 = я

      if (res.room.photo) {
        chatRoomAvatar.innerHTML = `<img src="${res.room.photo}" alt="">`;
      } else {
        chatRoomAvatar.innerHTML = '💬';
      }

      // Очищаем старый чат
      clearChat();

      // Добавляем себя в участники (голосовой)
      memberCount = res.room.members.length + 1;

      showScreen('chat');
      if (cb) cb(true);
    } else {
      if (cb) cb(false, res?.error);
      else if (res?.error === 'wrong_password') {
        alert('Неверный пароль');
      } else {
        alert('Не удалось войти в комнату');
      }
    }
  });
}

function clearChat() {
  // Удаляем все сообщения кроме системных
  const msgs = chatMessages.querySelectorAll('.msg, .date-divider');
  // Оставляем первый date-divider и инфо-блок
  const allChildren = [...chatMessages.children];
  allChildren.forEach((el, i) => {
    if (i > 1) el.remove(); // оставляем participants + первые 2 системных блока
  });
  msgCounter = 0;
}

// ═══════════════════════════════════════════════
//  КНОПКА "НАЗАД" — возврат в лобби
// ═══════════════════════════════════════════════
btnBackLobby.addEventListener('click', () => {
  socket.emit('leave-room');
  // Останавливаем голосовой если был активен
  if (joined) {
    socket.emit('voice-leave');
    hangUp();
    joined = false;
    btnJoin.style.display  = 'block';
    btnLeave.style.display = 'none';
    btnMic.style.display   = 'none';
    micStatus.className    = 'mic-status';
  }
  currentRoomId   = null;
  currentRoomData = null;
  showScreen('lobby');
});

// ═══════════════════════════════════════════════
//  SOCKET: события комнаты
// ═══════════════════════════════════════════════
socket.on('room-user-joined', ({ id, nickname }) => {
  memberCount++;
  userCount.textContent = memberCount;
  appendSystemMsg(`👋 ${nickname} вошёл в комнату`);
});

socket.on('room-user-left', (id) => {
  memberCount = Math.max(0, memberCount - 1);
  userCount.textContent = memberCount;
});

// Переподключение
socket.on('connect', () => {
  reconnectBanner.classList.remove('visible');
  // Восстанавливаем ник
  if (myNickname) {
    socket.emit('set-nickname', myNickname, () => {
      // Если были в комнате — пытаемся вернуться
      if (currentRoomId && currentRoomData) {
        joinRoom(currentRoomId, '');
      }
    });
  }
});

socket.on('disconnect', () => {
  if (currentRoomId) reconnectBanner.classList.add('visible');
});

// ═══════════════════════════════════════════════
//  ЧАТ: отправка текста
// ═══════════════════════════════════════════════
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});
btnSend.addEventListener('click', sendTextMessage);

async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text || !currentRoomId) return;
  btnSend.disabled = true;
  try {
    const { encrypted, iv } = await Crypto.encrypt(text);
    socket.emit('chat-message', { encrypted, iv, type: 'text' });
    appendMessage({
      from: socket.id, nickname: myNickname,
      text, type: 'text', timestamp: Date.now(), mine: true, status: 'ok'
    });
    chatInput.value        = '';
    chatInput.style.height = 'auto';
  } catch (e) { console.error('Send text error:', e); }
  finally     { btnSend.disabled = false; }
}

// ═══════════════════════════════════════════════
//  ЧАТ: файлы
// ═══════════════════════════════════════════════
btnPhoto.addEventListener('click', () => {
  pendingFileType = 'image/*'; fileInput.accept = 'image/*'; fileInput.click();
});
btnVideo.addEventListener('click', () => {
  pendingFileType = 'video/*'; fileInput.accept = 'video/*'; fileInput.click();
});
btnFile.addEventListener('click', () => {
  pendingFileType = '*/*'; fileInput.accept = '*/*'; fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = '';
  if (file.size > 50 * 1024 * 1024) { alert('Файл слишком большой. Максимум 50 МБ.'); return; }

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  if (isImage) {
    MediaEditor.openPhoto(file,
      async (blob, mt, fn) => await sendMediaBlob(blob, mt, fn, 'image'),
      () => {}
    );
    return;
  }
  if (isVideo) {
    MediaEditor.openVideo(file,
      async (blob, mt, fn) => await sendMediaBlob(blob, mt, fn, 'video'),
      () => {}
    );
    return;
  }
  await sendMediaBlob(file, file.type, file.name, 'file');
});

async function sendMediaBlob(blob, mimeType, fileName, type) {
  if (!currentRoomId) return;
  try {
    const arrayBuf          = await blob.arrayBuffer();
    const { encrypted, iv } = await Crypto.encrypt(arrayBuf);
    const localUrl          = URL.createObjectURL(new Blob([arrayBuf], { type: mimeType }));
    socket.emit('chat-message', {
      encrypted, iv, type,
      fileName: fileName || 'file', fileSize: blob.size, mimeType
    });
    appendMessage({
      from: socket.id, nickname: myNickname, type,
      localUrl, fileName: fileName || 'file',
      fileSize: blob.size, mimeType,
      timestamp: Date.now(), mine: true, status: 'ok'
    });
  } catch (e) {
    console.error('Send media error:', e);
    alert('Ошибка при отправке: ' + e.message);
  }
}

// ═══════════════════════════════════════════════
//  ЧАТ: получение сообщений
// ═══════════════════════════════════════════════
socket.on('chat-message', async (data) => {
  const msgId = appendMessage({
    from:     data.from,
    nickname: data.nickname,
    type:     data.type,
    fileName: data.fileName,
    fileSize: data.fileSize,
    mimeType: data.mimeType,
    timestamp: data.timestamp,
    mine:     false,
    status:   'decrypting'
  });

  try {
    if (data.type === 'text') {
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      updateMessage(msgId, { text, status: 'ok' });
    } else {
      const mime = data.mimeType || 'application/octet-stream';
      const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
      updateMessage(msgId, { localUrl: URL.createObjectURL(blob), status: 'ok' });
    }
  } catch (e) {
    updateMessage(msgId, { status: 'error' });
  }
});

// ═══════════════════════════════════════════════
//  ЧАТ: рендер сообщений
// ═══════════════════════════════════════════════
function appendMessage(msg) {
  const id  = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.id               = id;
  div.className        = 'msg ' + (msg.mine ? 'mine' : 'theirs');
  div.dataset.type     = msg.type     || 'text';
  div.dataset.mimeType = msg.mimeType || '';
  div.dataset.fileName = msg.fileName || '';
  div.dataset.fileSize = msg.fileSize || '';
  div.innerHTML = buildMsgHTML(msg);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  bindMediaEvents(div);
  return id;
}

function appendSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'date-divider';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateMessage(id, updates) {
  const div = document.getElementById(id);
  if (!div) return;
  const content = div.querySelector('.msg-content');
  if (content) {
    content.innerHTML = buildContentHTML({
      type:     div.dataset.type,
      mimeType: div.dataset.mimeType,
      fileName: div.dataset.fileName,
      fileSize: div.dataset.fileSize,
      ...updates
    });
    bindMediaEvents(div);
  }
  const statusEl = div.querySelector('.msg-decrypt-status');
  if (statusEl) {
    if (updates.status === 'ok')         { statusEl.className = 'msg-decrypt-status ok';  statusEl.textContent = '🔓 расшифровано'; }
    if (updates.status === 'error')      { statusEl.className = 'msg-decrypt-status err'; statusEl.textContent = '⚠️ ошибка расшифровки'; }
    if (updates.status === 'decrypting') statusEl.textContent = '⏳ расшифровываем…';
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function buildMsgHTML(msg) {
  const time       = new Date(msg.timestamp || Date.now())
    .toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });
  const senderName = msg.nickname || shortId(msg.from);
  const sender     = msg.mine
    ? ''
    : `<div class="msg-sender">👤 ${escapeHtml(senderName)}</div>`;
  const statusText = msg.status === 'ok'
    ? '🔓 расшифровано'
    : msg.status === 'error' ? '⚠️ ошибка' : '⏳ расшифровываем…';
  const statusClass = msg.status === 'ok' ? 'ok' : msg.status === 'error' ? 'err' : '';
  const showStatus  = msg.mine
    ? ''
    : `<div class="msg-decrypt-status ${statusClass}">${statusText}</div>`;
  return `
    ${sender}
    <div class="msg-content">${buildContentHTML(msg)}</div>
    <div class="msg-meta">${time}</div>
    ${showStatus}
  `;
}

function buildContentHTML(msg) {
  if (msg.type === 'text')  return escapeHtml(msg.text || '');
  if (msg.type === 'image') {
    if (msg.localUrl) return `<img class="msg-media" src="${msg.localUrl}" alt="фото" loading="lazy">`;
    return '<span style="color:#888;font-size:12px">⏳ загрузка…</span>';
  }
  if (msg.type === 'video') {
    if (msg.localUrl) return `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>`;
    return '<span style="color:#888;font-size:12px">⏳ загрузка…</span>';
  }
  if (msg.type === 'file') {
    const size = msg.fileSize ? formatSize(parseInt(msg.fileSize)) : '';
    if (msg.localUrl) {
      return `<div class="msg-file">
        <span class="msg-file-icon">📄</span>
        <div class="msg-file-info">
          <div class="msg-file-name">${escapeHtml(msg.fileName||'файл')}</div>
          <div class="msg-file-size">${size}</div>
        </div>
        <a class="msg-file-dl" href="${msg.localUrl}"
           download="${escapeHtml(msg.fileName||'file')}" title="Скачать">⬇️</a>
      </div>`;
    }
    return `<div class="msg-file">
      <span class="msg-file-icon">📄</span>
      <div class="msg-file-info">
        <div class="msg-file-name">${escapeHtml(msg.fileName||'файл')}</div>
        <div class="msg-file-size">${size}</div>
      </div>
      <span style="color:#888;font-size:12px">⏳</span>
    </div>`;
  }
  return '';
}

function bindMediaEvents(container) {
  container.querySelectorAll('img.msg-media').forEach(img => {
    img.onclick = () => openLightbox('img', img.src);
  });
  container.querySelectorAll('video.msg-media').forEach(vid => {
    vid.ondblclick = () => openLightbox('video', vid.src);
  });
}

// ═══════════════════════════════════════════════
//  LIGHTBOX
// ═══════════════════════════════════════════════
function openLightbox(type, src) {
  lightboxContent.innerHTML = type === 'img'
    ? `<img src="${src}" alt="">`
    : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}
lightboxClose.addEventListener('click', () => {
  lightbox.classList.remove('open'); lightboxContent.innerHTML = '';
});
lightbox.addEventListener('click', e => {
  if (e.target === lightbox) { lightbox.classList.remove('open'); lightboxContent.innerHTML = ''; }
});

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ — кнопки
// ═══════════════════════════════════════════════
btnJoin.addEventListener('click', async () => {
  if (!currentRoomId) return;
  try {
    const rawStream = await getMicStream();
    localStream     = rawStream;

    try {
      processedStream = await buildAudioPipeline(rawStream);
    } catch (e) {
      processedStream = rawStream;
      if (noiseIndicator) noiseIndicator.classList.remove('visible');
    }

    await requestWakeLock();
    startKeepAlive();
    setMicStatus(true);

    btnJoin.style.display  = 'none';
    btnLeave.style.display = 'block';
    btnMic.style.display   = 'block';
    joined = true;

    addParticipant(socket.id, '🟢 Вы (' + myNickname + ')');
    startVolumeAnalysis(socket.id, localStream);

    socket.emit('voice-join');

    for (const { from, offer } of pendingOffers) await handleOffer(from, offer);
    pendingOffers = [];

  } catch (err) {
    const msgs = {
      NotAllowedError:  '❌ Доступ к микрофону запрещён.',
      NotFoundError:    '❌ Микрофон не найден.',
      NotReadableError: '❌ Микрофон занят.'
    };
    alert(msgs[err.name] || '❌ ' + err.name + ': ' + err.message);
  }
});

btnLeave.addEventListener('click', () => {
  socket.emit('voice-leave');
  hangUp();
  joined = false;
  btnJoin.style.display  = 'block';
  btnLeave.style.display = 'none';
  btnMic.style.display   = 'none';
  micStatus.className    = 'mic-status';
  micStatus.textContent  = '';
  releaseWakeLock();
  stopKeepAlive();
});

btnMic.addEventListener('click', () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  setMicStatus(micEnabled);
  btnMic.textContent = micEnabled ? '🔇 Выключить микрофон' : '🎙️ Включить микрофон';
});

function setMicStatus(active) {
  micStatus.textContent = active ? '🟢 Микрофон активен' : '🔴 Микрофон выключен';
  micStatus.className   = 'mic-status ' + (active ? 'active' : 'muted');
}

// ═══════════════════════════════════════════════
//  WebRTC — события
// ═══════════════════════════════════════════════
socket.on('existing-voice-users', async (userIds) => {
  for (const uid of userIds) {
    addParticipant(uid, '👤 ' + shortId(uid));
    peers[uid] = createPeer(uid, true);
  }
});

socket.on('voice-user-joined', uid => {
  playBeep('join');
  addParticipant(uid, '👤 ' + shortId(uid));
  if (joined) {
    if (!peers[uid]) peers[uid] = createPeer(uid, false);
  } else {
    pendingOffers.push({ from: uid, offer: null });
  }
});

socket.on('offer', async ({ from, offer }) => {
  if (!localStream) { pendingOffers.push({ from, offer }); return; }
  await handleOffer(from, offer);
});

async function handleOffer(from, offer) {
  if (!offer) return;
  const peer  = createPeer(from, false);
  peers[from] = peer;
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer   = await peer.createAnswer();
  const improved = { type: answer.type, sdp: forceOpusMaxQuality(answer.sdp) };
  await peer.setLocalDescription(improved);
  socket.emit('answer', { to: from, answer: improved });
}

socket.on('answer', async ({ from, answer }) => {
  const peer = peers[from];
  if (peer?.signalingState === 'have-local-offer')
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) {
    try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.error('ICE:', e.message); }
  }
});

socket.on('voice-user-left', uid => {
  playBeep('leave');
  removeParticipant(uid);
  stopVolumeAnalysis(uid);
  stopQualityMonitor(uid);
  if (peers[uid]) { peers[uid].close(); delete peers[uid]; }
  document.getElementById('audio-' + uid)?.remove();
});

// ═══════════════════════════════════════════════
//  ПОНЯЛ
// ═══════════════════════════════════════════════
socket.on('understood', ({ from, nickname }) => {
  playOkSound();
  const banner = document.createElement('div');
  banner.className   = 'understood-banner';
  banner.textContent = '✅ Понял! (' + (nickname || shortId(from)) + ')';
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 3000);
});

// ═══════════════════════════════════════════════
//  УЧАСТНИКИ ГОЛОСОВОГО
// ═══════════════════════════════════════════════
function addParticipant(userId, label) {
  if (document.getElementById('p-' + userId)) return;
  participantsBox.style.display = 'block';
  const div     = document.createElement('div');
  div.className = 'participant';
  div.id        = 'p-' + userId;
  const isMe    = userId === socket.id;
  const understoodBtn = isMe
    ? ''
    : `<button class="btn-understood" data-uid="${userId}">👍 Понял</button>`;
  div.innerHTML = `
    <span class="participant-name">${label}</span>
    <div class="volume-bar-wrap"><div class="volume-bar" id="vol-${userId}"></div></div>
    <div class="signal-wrap signal-none" id="sig-${userId}">
      <div class="bar"></div><div class="bar"></div>
      <div class="bar"></div><div class="bar"></div>
    </div>
    ${understoodBtn}`;
  participantsList.appendChild(div);
  div.querySelector('.btn-understood')?.addEventListener('click', function() {
    socket.emit('understood');
    this.textContent = '✅ Отправлено';
    this.disabled    = true;
    setTimeout(() => { this.textContent = '👍 Понял'; this.disabled = false; }, 3000);
  });
}

function removeParticipant(userId) {
  document.getElementById('p-' + userId)?.remove();
  if (participantsList.children.length === 0) participantsBox.style.display = 'none';
}

// ═══════════════════════════════════════════════
//  ГРОМКОСТЬ
// ═══════════════════════════════════════════════
function startVolumeAnalysis(userId, stream) {
  const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate:48000 });
  if (!audioCtx) audioCtx = ctx;
  stopVolumeAnalysis(userId);
  const source   = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  function tick() {
    if (!analysers[userId]) return;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const pct = Math.min(100, (sum/data.length)*3);
    const bar = document.getElementById('vol-' + userId);
    if (bar) { bar.style.width = pct+'%'; bar.className='volume-bar'+(pct>60?' loud':''); }
    analysers[userId].animFrame = requestAnimationFrame(tick);
  }
  analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
}

function stopVolumeAnalysis(userId) {
  if (analysers[userId]) {
    cancelAnimationFrame(analysers[userId].animFrame);
    try { analysers[userId].source.disconnect(); } catch (_) {}
    delete analysers[userId];
  }
}

// ═══════════════════════════════════════════════
//  WAKELOCK / KEEP-ALIVE
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch (_) {} wakeLock = null; }
}
function startKeepAlive() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const buf  = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const src  = ctx.createBufferSource();
    const dest = ctx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true;
    src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(() => {});
  } catch (_) {}
}
function stopKeepAlive() {
  keepAliveAudio.srcObject = null;
  keepAliveAudio.pause();
}

// ═══════════════════════════════════════════════
//  AUDIO PIPELINE
// ═══════════════════════════════════════════════
async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl:  true,
      sampleRate:       48000,
      channelCount:     2,
      latency:          0,
    }
  });
}

async function buildAudioPipeline(rawStream) {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000, latencyHint: 'interactive'
    });
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  try {
    await audioCtx.audioWorklet.addModule('/audio-processor.js');
  } catch (_) {}

  const source = audioCtx.createMediaStreamSource(rawStream);
  const hpf    = audioCtx.createBiquadFilter();
  hpf.type = 'highpass'; hpf.frequency.value = 80; hpf.Q.value = 0.7;

  const compressor           = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24; compressor.knee.value = 8;
  compressor.ratio.value     = 4;   compressor.attack.value = 0.003;
  compressor.release.value   = 0.15;

  noiseWorklet = new AudioWorkletNode(audioCtx, 'noise-gate-processor', {
    processorOptions: { threshold:0.008, attack:0.003, release:0.08, smoothing:0.92 },
    numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[[2]](#annotation-145686-1)
  });

  const outputGain      = audioCtx.createGain();
  outputGain.gain.value = 1.1;
  const destination     = audioCtx.createMediaStreamDestination();

  source.connect(hpf).connect(compressor).connect(noiseWorklet).connect(outputGain).connect(destination);
  if (noiseIndicator) noiseIndicator.classList.add('visible');
  return destination.stream;
}

// ═══════════════════════════════════════════════
//  ICE CONFIG
// ═══════════════════════════════════════════════
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls:'turn:global.relay.metered.ca:80',             username:'4219a9030e911d3a21936639', credential:'W9K/4EBqUUoxu9FC' },
    { urls:'turn:global.relay.metered.ca:80?transport=tcp',username:'4219a9030e911d3a21936639', credential:'W9K/4EBqUUoxu9FC' },
    { urls:'turn:global.relay.metered.ca:443',             username:'4219a9030e911d3a21936639', credential:'W9K/4EBqUUoxu9FC' },
    { urls:'turns:global.relay.metered.ca:443?transport=tcp',username:'4219a9030e911d3a21936639',credential:'W9K/4EBqUUoxu9FC' },
  ]
};

function forceOpusMaxQuality(sdp) {
  const lines = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[[1]](#annotation-145686-0).split(' ')[0];
      if (i+1 < lines.length && lines[i+1].startsWith('a=fmtp:'+pt)) i++;
      result.push(`a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000`);
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

// ═══════════════════════════════════════════════
//  КАЧЕСТВО СВЯЗИ
// ═══════════════════════════════════════════════
function calcLevel(rtt, lost, total, jitter) {
  if (rtt === null) return 'none';
  const lr = (lost+total) > 0 ? lost/(lost+total) : 0;
  if (rtt<80  && lr<0.02 && jitter<0.02) return 'excellent';
  if (rtt<150 && lr<0.05 && jitter<0.05) return 'good';
  if (rtt<300 && lr<0.10 && jitter<0.10) return 'fair';
  return 'poor';
}
function renderSignal(userId, level) {
  const w = document.getElementById('sig-'+userId);
  if (w) w.className = 'signal-wrap signal-'+level;
}
async function measureRemoteQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt=null, lost=0, received=0, jitter=0;
    stats.forEach(r => {
      if (r.type==='inbound-rtp'  && r.kind==='audio') { lost=r.packetsLost||0; received=r.packetsReceived||0; jitter=r.jitter||0; }
      if (r.type==='candidate-pair' && r.state==='succeeded' && r.currentRoundTripTime!=null) rtt=r.currentRoundTripTime*1000;
    });
    return calcLevel(rtt, lost, received, jitter);
  } catch { return 'none'; }
}
async function measureLocalQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt=null, lost=0, sent=0, jitter=0;
    stats.forEach(r => {
      if (r.type==='remote-inbound-rtp' && r.kind==='audio') { lost=r.packetsLost||0; jitter=r.jitter||0; if(r.roundTripTime!=null) rtt=r.roundTripTime*1000; }
      if (r.type==='outbound-rtp' && r.kind==='audio') sent=r.packetsSent||0;
    });
    return calcLevel(rtt, lost, sent, jitter);
  } catch { return 'none'; }
}
function startQualityMonitor(userId, peer, isLocal) {
  stopQualityMonitor(userId);
  qualityTimers[userId] = setInterval(async () => {
    const level = isLocal ? await measureLocalQuality(peer) : await measureRemoteQuality(peer);
    renderSignal(userId, level);
  }, 2000);
}
function stopQualityMonitor(userId) {
  if (qualityTimers[userId]) { clearInterval(qualityTimers[userId]); delete qualityTimers[userId]; }
}

// ═══════════════════════════════════════════════
//  CREATE PEER
// ═══════════════════════════════════════════════
function createPeer(userId, isInitiator) {
  const peer   = new RTCPeerConnection(iceServers);
  const stream = processedStream || localStream;
  stream.getTracks().forEach(t => peer.addTrack(t, stream));

  peer.getSenders().forEach(sender => {
    if (sender.track?.kind === 'audio') {
      const p = sender.getParameters();
      if (!p.encodings) p.encodings = [{}];
      p.encodings[0].maxBitrate = 510000;
      p.encodings[0].priority   = 'high';
      sender.setParameters(p).catch(() => {});
    }
  });

  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'connected') {
      if (Object.keys(peers).length === 1) startQualityMonitor(socket.id, peer, true);
      startQualityMonitor(userId, peer, false);
    }
    if (peer.connectionState === 'failed') peer.restartIce();
  });

  peer.ontrack = event => {
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + userId;
      audio.autoplay = true; audio.playsInline = true;
      hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play()
      .then(() => startVolumeAnalysis(userId, event.streams[0]))
      .catch(() => {});
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: userId, candidate: e.candidate });
  };
  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState === 'failed') peer.restartIce();
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer    = await peer.createOffer();
        const improved = { type: offer.type, sdp: forceOpusMaxQuality(offer.sdp) };
        await peer.setLocalDescription(improved);
        socket.emit('offer', { to: userId, offer: improved });
      } catch (e) { console.error('Offer error:', e); }
    };
  }
  return peer;
}

// ═══════════════════════════════════════════════
//  HANGUP
// ═══════════════════════════════════════════════
function hangUp() {
  Object.keys(analysers)    .forEach(id => stopVolumeAnalysis(id));
  Object.keys(qualityTimers).forEach(id => stopQualityMonitor(id));
  Object.values(peers).forEach(p => p.close());
  peers = {};
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (noiseWorklet) { try { noiseWorklet.disconnect(); } catch (_) {} noiseWorklet = null; }
  if (audioCtx)    { audioCtx.close().catch(() => {}); audioCtx = null; }
  processedStream = null;
  if (noiseIndicator) noiseIndicator.classList.remove('visible');
  hiddenAudios.innerHTML     = '';
  pendingOffers              = [];
  participantsList.innerHTML = '';
  participantsBox.style.display = 'none';
}

// ═══════════════════════════════════════════════
//  ЗВУКИ
// ═══════════════════════════════════════════════
function playBeep(type) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.35);
    if (type === 'join') {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.setValueAtTime(900, ctx.currentTime+0.12);
    } else {
      osc.frequency.setValueAtTime(900, ctx.currentTime);
      osc.frequency.setValueAtTime(500, ctx.currentTime+0.12);
    }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.35);
    osc.onended = () => ctx.close();
  } catch (_) {}
}

function playOkSound() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    [{ freq:880, start:0.00 }, { freq:1100, start:0.22 }].forEach(({ freq, start }) => {
      const osc = ctx.createOscillator();
      osc.type  = 'sine'; osc.connect(gain);
      osc.frequency.setValueAtTime(freq, ctx.currentTime+start);
      gain.gain.setValueAtTime(0, ctx.currentTime+start);
      gain.gain.linearRampToValueAtTime(0.4,   ctx.currentTime+start+0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+start+0.20);
      osc.start(ctx.currentTime+start); osc.stop(ctx.currentTime+start+0.22);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch (_) {}
}

// ═══════════════════════════════════════════════
//  VISIBILITY CHANGE
// ═══════════════════════════════════════════════
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !joined || !localStream) return;
  await requestWakeLock();
  const tracks = localStream.getAudioTracks();
  if (tracks.every(t => t.readyState === 'ended')) {
    try {
      const newRaw = await getMicStream();
      let newProcessed;
      try { newProcessed = await buildAudioPipeline(newRaw); }
      catch (e) { newProcessed = newRaw; }
      const procTrack = newProcessed.getAudioTracks()[0];
      for (const [uid, peer] of Object.entries(peers)) {
        const sender = peer.getSenders().find(s => s.track?.kind === 'audio');
        if (sender && procTrack) await sender.replaceTrack(procTrack);
      }
      const newTrack = newRaw.getAudioTracks()[0];
      tracks.forEach(t => { localStream.removeTrack(t); t.stop(); });
      localStream.addTrack(newTrack);
      processedStream = newProcessed;
      stopVolumeAnalysis(socket.id);
      startVolumeAnalysis(socket.id, localStream);
      newTrack.enabled = micEnabled;
    } catch (_) {}
  } else {
    tracks.forEach(t => { t.enabled = micEnabled; });
  }
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
});
