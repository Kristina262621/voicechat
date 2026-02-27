// ═══════════════════════════════════════════════
//  CRYPTO — AES-256-GCM
// ═══════════════════════════════════════════════
const Crypto = (() => {
  let cryptoKey = null;

  async function deriveKey(password) {
    const enc    = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name:'PBKDF2' }, false, ['deriveKey']
    );
    const salt = enc.encode('voicechat-salt-v1');
    cryptoKey  = await crypto.subtle.deriveKey(
      { name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' },
      keyMat,
      { name:'AES-GCM', length:256 },
      false,
      ['encrypt','decrypt']
    );
    return cryptoKey;
  }

  async function encrypt(data) {
    const iv      = crypto.getRandomValues(new Uint8Array(12));
    const encoded = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
    const cipher = await crypto.subtle.encrypt(
      { name:'AES-GCM', iv }, cryptoKey, encoded
    );
    return {
      iv:        btoa(String.fromCharCode(...iv)),
      encrypted: btoa(String.fromCharCode(...new Uint8Array(cipher)))
    };
  }

  async function decrypt(encB64, ivB64) {
    const iv     = Uint8Array.from(atob(ivB64),  c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
    return crypto.subtle.decrypt({ name:'AES-GCM', iv }, cryptoKey, cipher);
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
//  SOCKET — инициализируется через initSocket()
// ═══════════════════════════════════════════════
let socket = null;

// Множество socketId всех в текущей комнате
window._roomPeers = new Set();
// Map socketId → username
window._peerNames = new Map();

function initSocket(token, roomId, username) {
  // Закрываем предыдущее соединение если есть
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  window._roomPeers.clear();
  window._peerNames.clear();

  // Ключ шифрования = token (уникален для пользователя)
  // Все в одной комнате используют roomId как общий ключ шифрования
  Crypto.deriveKey(String(roomId)).then(() => {
    log('Crypto key derived from roomId');
  });

  socket = io({
    reconnection:         true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    1000,
    reconnectionDelayMax: 5000,
    timeout:              20000,
    transports:           ['websocket', 'polling'],
    autoConnect:          true,
  });

  window._socket = socket;

  // ── Подключение ──
  socket.on('connect', () => {
    log('Connected: ' + socket.id);
    document.getElementById('reconnect-banner').classList.remove('visible');
    socket.emit('authenticate', { token, roomId });
  });

  socket.on('auth-ok', ({ username: uname }) => {
    log('Auth OK as ' + uname);
    joined = false;
  });

  socket.on('auth-fail', () => {
    log('Auth FAIL');
    showScreen('screen-rooms');
    toast('❌ Ошибка авторизации');
  });

  socket.on('disconnect', reason => {
    log('Disconnected: ' + reason);
    if (joined) {
      document.getElementById('reconnect-banner').classList.add('visible');
    }
  });

  socket.on('user-count', count => {
    document.getElementById('user-count').textContent = count;
  });

  // ── Голосовой чат и Синхронизация комнаты ──
  socket.on('existing-users', async (users) => {
    log('Existing: ' + JSON.stringify(users));
    for (const u of users) {
      // Универсальная обработка (если сервер шлет объекты или просто ID)
      const socketId = typeof u === 'string' ? u : u.socketId;
      const uname = typeof u === 'string' ? 'User' : (u.username || 'User');

      window._roomPeers.add(socketId);
      window._peerNames.set(socketId, uname);
      
      if (joined && localStream) {
        addParticipant(socketId, '👤 ' + uname);
        peers[socketId] = createPeer(socketId, true);
      }

      // ВАЖНО: триггер для видеосетки! Оповещаем index.html, что тут уже есть люди
      if (window.onUserJoined) window.onUserJoined(socketId);
    }
  });

  socket.on('user-joined', (data) => {
    const socketId = typeof data === 'string' ? data : data.socketId;
    const uname = typeof data === 'string' ? 'User' : (data.username || 'User');

    log('User joined: ' + socketId + ' (' + uname + ')');
    window._roomPeers.add(socketId);
    window._peerNames.set(socketId, uname);
    playBeep('join');
    
    if (joined) {
      addParticipant(socketId, '👤 ' + uname);
    }
    showToastJoin(uname);

    // ВАЖНО: триггер для видеосетки! Оповещаем index.html о новичке
    if (window.onUserJoined) window.onUserJoined(socketId);
  });

  socket.on('offer', async ({ from, offer }) => {
    if (!localStream) { pendingOffers.push({ from, offer }); return; }
    await handleOffer(from, offer);
  });

  socket.on('answer', async ({ from, answer }) => {
    const peer = peers[from];
    if (peer?.signalingState === 'have-local-offer') {
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const peer = peers[from];
    if (peer && candidate) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch(e) { log('ICE: ' + e.message); }
    }
  });

  socket.on('user-left', (data) => {
    const socketId = typeof data === 'string' ? data : data.socketId;
    log('User left: ' + socketId);
    
    const uname = window._peerNames.get(socketId) || socketId.slice(0,6);
    window._roomPeers.delete(socketId);
    window._peerNames.delete(socketId);
    playBeep('leave');
    removeParticipant(socketId);
    stopVolumeAnalysis(socketId);
    stopQualityMonitor(socketId);
    
    if (peers[socketId]) { peers[socketId].close(); delete peers[socketId]; }
    document.getElementById('audio-' + socketId)?.remove();
    showToastLeave(uname);

    // ВАЖНО: Очищаем видео человека, который вышел
    if (window.onUserLeft) window.onUserLeft(socketId);
    if (window.onVideoStop) window.onVideoStop(socketId);
  });

  // ── Чат ──
  socket.on('chat-message', async (data) => {
    log('Chat msg type=' + data.type + ' from=' + data.from);
    const uname = window._peerNames.get(data.from) || data.username || data.from?.slice(0,6);

    const msgId = appendMessage({
      from:      data.from,
      username:  uname,
      type:      data.type,
      fileName:  data.fileName,
      fileSize:  data.fileSize,
      mimeType:  data.mimeType,
      timestamp: data.timestamp,
      mine:      false,
      status:    'decrypting'
    });

    try {
      if (data.type === 'text') {
        const text = await Crypto.decryptText(data.encrypted, data.iv);
        updateMessage(msgId, { text, status: 'ok' });
      } else {
        const mime = data.mimeType || 'application/octet-stream';
        const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
        const url  = URL.createObjectURL(blob);
        updateMessage(msgId, { localUrl: url, status: 'ok' });
      }
    } catch(e) {
      log('Decrypt error: ' + e.message);
      updateMessage(msgId, { status: 'error' });
    }
  });

  // ── Понял ──
  socket.on('understood', ({ from, username: uname }) => {
    log('Understood from: ' + from);
    playOkSound();
    const name = uname || window._peerNames.get(from) || from?.slice(0,6);
    const banner = document.createElement('div');
    banner.className   = 'understood-banner';
    banner.textContent = '✅ Понял! (' + name + ')';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 3000);
  });

  // ── Видео ── 
  // Изменен старый параметр ({from, username}) на прямую поддержку событий из index.html
  socket.on('video-start', (data) => {
    const from = typeof data === 'string' ? data : data.from;
    log('Video start from: ' + from);
    if (window.onVideoStart) window.onVideoStart(from);
  });

  socket.on('video-stop', (data) => {
    const from = typeof data === 'string' ? data : data.from;
    log('Video stop from: ' + from);
    if (window.onVideoStop) window.onVideoStop(from);
  });

  socket.on('video-offer', async (idOrData, offerObj) => {
    const from  = typeof idOrData === 'string' ? idOrData : idOrData.from;
    const offer = typeof idOrData === 'string' ? offerObj : idOrData.offer;
    
    // Если мы пропустили user-joined, добавим его превентивно
    window._roomPeers.add(from);
    if (window.onVideoOffer) await window.onVideoOffer(from, offer);
  });

  socket.on('video-answer', async (idOrData, answerObj) => {
    const from   = typeof idOrData === 'string' ? idOrData : idOrData.from;
    const answer = typeof idOrData === 'string' ? answerObj : idOrData.answer;
    if (window.onVideoAnswer) await window.onVideoAnswer(from, answer);
  });

  socket.on('video-ice', async (idOrData, candidateObj) => {
    const from      = typeof idOrData === 'string' ? idOrData : idOrData.from;
    const candidate = typeof idOrData === 'string' ? candidateObj : idOrData.candidate;
    if (window.onVideoIce) await window.onVideoIce(from, candidate);
  });
}

// Вызывается при выходе из комнаты
function socketLeave() {
  if (!socket) return;
  socket.emit('leave');
  if (typeof hangUp === 'function') hangUp();
  joined = false;
  if (typeof resetVoiceUI === 'function') resetVoiceUI();
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    window._socket = null;
  }
  window._roomPeers.clear();
  window._peerNames.clear();
}

// ── DOM ──
const btnJoin          = document.getElementById('btn-join');
const btnLeave         = document.getElementById('btn-leave');
const btnMic           = document.getElementById('btn-mic');
const userCount        = document.getElementById('user-count');
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

let localStream     = null;
let peers           = {};
let micEnabled      = true;
let pendingOffers   = [];
let joined          = false;
let audioCtx        = null;
let wakeLock        = null;
let msgCounter      = 0;
let pendingFileType = 'image/*';

const analysers     = {};
const qualityTimers = {};

// ═══════════════════════════════════════════════
//  DEBUG LOG
// ═══════════════════════════════════════════════
const DEBUG = false;

function log(msg) {
  if (!DEBUG) return;
  console.log(msg);
  let box = document.getElementById('log-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'log-box';
    box.style.cssText = [
      'position:fixed','bottom:0','left:0','right:0',
      'background:rgba(0,0,0,0.85)','color:#0f0',
      'font-size:10px','font-family:monospace',
      'padding:6px','max-height:35vh','overflow-y:auto','z-index:9999'
    ].join(';');
    document.body.appendChild(box);
  }
  const line = document.createElement('div');
  line.textContent = new Date().toISOString().slice(11,19) + ' ' + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ═══════════════════════════════════════════════
//  TOAST УВЕДОМЛЕНИЯ О ВХОДЕ / ВЫХОДЕ
// ═══════════════════════════════════════════════
function showToastJoin(username) {
  toast('👋 ' + username + ' вошёл в комнату');
}

function showToastLeave(username) {
  toast('🚪 ' + username + ' покинул комнату');
}

// ═══════════════════════════════════════════════
//  ЧАТ — ВВОД
// ═══════════════════════════════════════════════
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});

btnSend.addEventListener('click', sendTextMessage);

// ═══════════════════════════════════════════════
//  ОТПРАВКА ТЕКСТА
// ═══════════════════════════════════════════════
async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  btnSend.disabled = true;
  try {
    const { encrypted, iv } = await Crypto.encrypt(text);
    socket.emit('chat-message', { encrypted, iv, type: 'text' });
    appendMessage({
      from:      socket.id,
      username:  window._currentUsername || 'Вы',
      text,
      type:      'text',
      timestamp: Date.now(),
      mine:      true,
      status:    'ok'
    });
    chatInput.value       = '';
    chatInput.style.height = 'auto';
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch(e) { log('Send text error: ' + e.message); }
  finally    { btnSend.disabled = false; }
}

// ═══════════════════════════════════════════════
//  ФАЙЛЫ
// ═══════════════════════════════════════════════
btnPhoto?.addEventListener('click', () => {
  pendingFileType  = 'image/*';
  fileInput.accept = 'image/*';
  fileInput.click();
});

btnVideo?.addEventListener('click', () => {
  pendingFileType  = 'video/*';
  fileInput.accept = 'video/*';
  fileInput.click();
});

btnFile?.addEventListener('click', () => {
  pendingFileType  = '*/*';
  fileInput.accept = '*/*';
  fileInput.click();
});

fileInput?.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = '';

  if (file.size > 50 * 1024 * 1024) {
    toast('❌ Файл слишком большой. Максимум 50 МБ.');
    return;
  }

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  if (isImage) {
    await sendMediaBlob(file, file.type, file.name, 'image');
    return;
  }
  if (isVideo) {
    await sendMediaBlob(file, file.type, file.name, 'video');
    return;
  }
  await sendMediaBlob(file, file.type, file.name, 'file');
});

async function sendMediaBlob(blob, mimeType, fileName, type) {
  if (!socket) return;
  try {
    const arrayBuf          = await blob.arrayBuffer();
    const { encrypted, iv } = await Crypto.encrypt(arrayBuf);
    const localUrl          = URL.createObjectURL(
      new Blob([arrayBuf], { type: mimeType })
    );

    socket.emit('chat-message', {
      encrypted, iv, type,
      fileName: fileName || 'file',
      fileSize: blob.size,
      mimeType,
    });

    appendMessage({
      from:      socket.id,
      username:  window._currentUsername || 'Вы',
      type,
      localUrl,
      fileName:  fileName || 'file',
      fileSize:  blob.size,
      mimeType,
      timestamp: Date.now(),
      mine:      true,
      status:    'ok'
    });
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch(e) {
    log('Send media error: ' + e.message);
    toast('❌ Ошибка при отправке: ' + e.message);
  }
}

// ═══════════════════════════════════════════════
//  РЕНДЕР СООБЩЕНИЙ
// ═══════════════════════════════════════════════
function appendMessage(msg) {
  const id  = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.id        = id;
  div.className = 'msg ' + (msg.mine ? 'mine' : 'theirs');
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

function updateMessage(id, updates) {
  const div = document.getElementById(id);
  if (!div) return;

  const type     = div.dataset.type;
  const mimeType = div.dataset.mimeType;
  const fileName = div.dataset.fileName;
  const fileSize = div.dataset.fileSize;

  const content = div.querySelector('.msg-content');
  if (content) {
    content.innerHTML = buildContentHTML({
      type, mimeType, fileName, fileSize, ...updates
    });
    bindMediaEvents(div);
  }

  const statusEl = div.querySelector('.msg-decrypt-status');
  if (statusEl) {
    if (updates.status === 'ok') {
      statusEl.className   = 'msg-decrypt-status ok';
      statusEl.textContent = '🔓 расшифровано';
    }
    if (updates.status === 'error') {
      statusEl.className   = 'msg-decrypt-status err';
      statusEl.textContent = '⚠️ ошибка расшифровки';
    }
    if (updates.status === 'decrypting') {
      statusEl.textContent = '⏳ расшифровываем…';
    }
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function buildMsgHTML(msg) {
  const time = new Date(msg.timestamp || Date.now())
    .toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });

  const senderName = msg.mine
    ? ''
    : `<div class="msg-sender">👤 ${escapeHtml(msg.username || '??')}</div>`;

  const statusText  = msg.status === 'ok'          ? '🔓 расшифровано'
    : msg.status === 'error'                        ? '⚠️ ошибка расшифровки'
    : '⏳ расшифровываем…';
  const statusClass = msg.status === 'ok' ? 'ok' : msg.status === 'error' ? 'err' : '';
  const showStatus  = msg.mine
    ? ''
    : `<div class="msg-decrypt-status ${statusClass}">${statusText}</div>`;

  return `
    ${senderName}
    <div class="msg-content">${buildContentHTML(msg)}</div>
    <div class="msg-meta">${time}</div>
    ${showStatus}
  `;
}

function buildContentHTML(msg) {
  if (msg.type === 'text') {
    return escapeHtml(msg.text || '');
  }
  if (msg.type === 'image') {
    if (msg.localUrl)
      return `<img class="msg-media" src="${msg.localUrl}" alt="фото" loading="lazy">`;
    return '<span style="color:#888;font-size:12px">⏳ загрузка…</span>';
  }
  if (msg.type === 'video') {
    if (msg.localUrl)
      return `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>`;
    return '<span style="color:#888;font-size:12px">⏳ загрузка…</span>';
  }
  if (msg.type === 'file') {
    const size = msg.fileSize ? formatSize(parseInt(msg.fileSize)) : '';
    if (msg.localUrl) {
      return `<div class="msg-file">
        <span class="msg-file-icon">📄</span>
        <div class="msg-file-info">
          <div class="msg-file-name">${escapeHtml(msg.fileName || 'файл')}</div>
          <div class="msg-file-size">${size}</div>
        </div>
        <a class="msg-file-dl"
           href="${msg.localUrl}"
           download="${escapeHtml(msg.fileName || 'file')}"
           title="Скачать">⬇️</a>
      </div>`;
    }
    return `<div class="msg-file">
      <span class="msg-file-icon">📄</span>
      <div class="msg-file-info">
        <div class="msg-file-name">${escapeHtml(msg.fileName || 'файл')}</div>
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
    : `<video src="${src}" controls autoplay playsinline
         style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}

lightboxClose?.addEventListener('click', () => {
  lightbox.classList.remove('open');
  lightboxContent.innerHTML = '';
});

lightbox?.addEventListener('click', e => {
  if (e.target === lightbox) {
    lightbox.classList.remove('open');
    lightboxContent.innerHTML = '';
  }
});

// ═══════════════════════════════════════════════
//  УТИЛИТЫ
// ═══════════════════════════════════════════════
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;') .replace(/"/g,'&quot;');
}

function formatSize(bytes) {
  if (bytes < 1024)           return bytes + ' Б';
  if (bytes < 1024 * 1024)    return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}

// ═══════════════════════════════════════════════
//  WAKELOCK
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('WakeLock acquired');
  } catch(e) { log('WakeLock: ' + e.message); }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch(_) {}
    wakeLock = null;
  }
}

// ═══════════════════════════════════════════════
//  KEEP-ALIVE (iOS)
// ═══════════════════════════════════════════════
function startKeepAlive() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const buf  = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const src  = ctx.createBufferSource();
    const dest = ctx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true;
    src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(e => log('KeepAlive: ' + e.message));
  } catch(e) { log('KeepAlive init: ' + e.message); }
}

function stopKeepAlive() {
  keepAliveAudio.srcObject = null;
  keepAliveAudio.pause();
}

// ═══════════════════════════════════════════════
//  VISIBILITY CHANGE
// ═══════════════════════════════════════════════
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !joined || !localStream) return;
  await requestWakeLock();

  const tracks = localStream.getAudioTracks();
  if (tracks.every(t => t.readyState === 'ended')) {
    log('Tracks ended — reacquiring...');
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true, noiseSuppression: true,
          autoGainControl:  true, sampleRate: 48000, channelCount: 2
        }
      });
      const newTrack = newStream.getAudioTracks()[0];
      for (const [uid, peer] of Object.entries(peers)) {
        const sender = peer.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) {
          await sender.replaceTrack(newTrack);
          log('Replaced track for ' + uid);
        }
      }
      tracks.forEach(t => { localStream.removeTrack(t); t.stop(); });
      localStream.addTrack(newTrack);
      stopVolumeAnalysis(socket.id);
      startVolumeAnalysis(socket.id, localStream);
      newTrack.enabled = micEnabled;
      log('Mic restored');
    } catch(e) { log('Restore mic failed: ' + e.message); }
  } else {
    tracks.forEach(t => { t.enabled = micEnabled; });
  }

  if (audioCtx?.state === 'suspended') {
    await audioCtx.resume();
    log('AudioCtx resumed');
  }
});

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
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    if (type === 'join') {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.setValueAtTime(900, ctx.currentTime + 0.12);
    } else {
      osc.frequency.setValueAtTime(900, ctx.currentTime);
      osc.frequency.setValueAtTime(500, ctx.currentTime + 0.12);
    }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close();
  } catch(e) { log('Beep: ' + e.message); }
}

function playOkSound() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    [
      { freq: 880,  start: 0.00 },
      { freq: 1100, start: 0.22 },
    ].forEach(({ freq, start }) => {
      const osc = ctx.createOscillator();
      osc.type  = 'sine';
      osc.connect(gain);
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.4,   ctx.currentTime + start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.20);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime  + start + 0.22);
    });

    setTimeout(() => ctx.close(), 1500);
  } catch(e) { log('OkSound: ' + e.message); }
}

// ═══════════════════════════════════════════════
//  ICE CONFIG
// ═══════════════════════════════════════════════
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls:       'turn:global.relay.metered.ca:80',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    },
    {
      urls:       'turn:global.relay.metered.ca:80?transport=tcp',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    },
    {
      urls:       'turn:global.relay.metered.ca:443',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    },
    {
      urls:       'turns:global.relay.metered.ca:443?transport=tcp',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    },
  ]
};

function forceOpusMaxQuality(sdp) {
  const lines = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[1].split(' ')[0];
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) i++;
      result.push(
        `a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;` +
        `sprop-stereo=1;maxaveragebitrate=510000`
      );
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
  const lr = (lost + total) > 0 ? lost / (lost + total) : 0;
  if (rtt < 80  && lr < 0.02 && jitter < 0.02) return 'excellent';
  if (rtt < 150 && lr < 0.05 && jitter < 0.05) return 'good';
  if (rtt < 300 && lr < 0.10 && jitter < 0.10) return 'fair';
  return 'poor';
}

function renderSignal(userId, level) {
  const w = document.getElementById('sig-' + userId);
  if (w) w.className = 'signal-wrap signal-' + level;
}

async function measureRemoteQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lost = 0, received = 0, jitter = 0;
    stats.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        lost     = r.packetsLost    || 0;
        received = r.packetsReceived || 0;
        jitter   = r.jitter         || 0;
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' &&
          r.currentRoundTripTime != null) {
        rtt = r.currentRoundTripTime * 1000;
      }
    });
    return calcLevel(rtt, lost, received, jitter);
  } catch { return 'none'; }
}

async function measureLocalQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lost = 0, sent = 0, jitter = 0;
    stats.forEach(r => {
      if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
        lost   = r.packetsLost || 0;
        jitter = r.jitter      || 0;
        if (r.roundTripTime != null) rtt = r.roundTripTime * 1000;
      }
      if (r.type === 'outbound-rtp' && r.kind === 'audio') {
        sent = r.packetsSent || 0;
      }
    });
    return calcLevel(rtt, lost, sent, jitter);
  } catch { return 'none'; }
}

function startQualityMonitor(userId, peer, isLocal) {
  stopQualityMonitor(userId);
  qualityTimers[userId] = setInterval(async () => {
    const level = isLocal
      ? await measureLocalQuality(peer)
      : await measureRemoteQuality(peer);
    renderSignal(userId, level);
  }, 2000);
}

function stopQualityMonitor(userId) {
  if (qualityTimers[userId]) {
    clearInterval(qualityTimers[userId]);
    delete qualityTimers[userId];
  }
}

// ═══════════════════════════════════════════════
//  УЧАСТНИКИ
// ═══════════════════════════════════════════════
function addParticipant(userId, label) {
  if (document.getElementById('p-' + userId)) return;
  participantsBox.style.display = 'block';

  const div     = document.createElement('div');
  div.className = 'participant';
  div.id        = 'p-' + userId;

  const isMe          = socket && userId === socket.id;
  const understoodBtn = isMe
    ? ''
    : `<button class="btn-understood" data-uid="${userId}">👍 Понял</button>`;

  div.innerHTML = `
    <span class="participant-name">${escapeHtml(label)}</span>
    <div class="volume-bar-wrap">
      <div class="volume-bar" id="vol-${userId}"></div>
    </div>
    <div class="signal-wrap signal-none" id="sig-${userId}">
      <div class="bar"></div><div class="bar"></div>
      <div class="bar"></div><div class="bar"></div>
    </div>
    ${understoodBtn}
  `;

  participantsList.appendChild(div);

  const btn = div.querySelector('.btn-understood');
  if (btn) {
    btn.addEventListener('click', () => {
      if (!socket) return;
      socket.emit('understood');
      btn.textContent = '✅ Отправлено';
      btn.disabled    = true;
      setTimeout(() => {
        btn.textContent = '👍 Понял';
        btn.disabled    = false;
      }, 3000);
    });
  }
}

function removeParticipant(userId) {
  document.getElementById('p-' + userId)?.remove();
  if (participantsList.children.length === 0) {
    participantsBox.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════
//  АНАЛИЗ ГРОМКОСТИ
// ═══════════════════════════════════════════════
function startVolumeAnalysis(userId, stream) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)(
      { sampleRate: 48000 }
    );
  }
  stopVolumeAnalysis(userId);

  const source   = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    if (!analysers[userId]) return;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const pct = Math.min(100, (sum / data.length) * 3);
    const bar = document.getElementById('vol-' + userId);
    if (bar) {
      bar.style.width = pct + '%';
      bar.className   = 'volume-bar' + (pct > 60 ? ' loud' : '');
    }
    analysers[userId].animFrame = requestAnimationFrame(tick);
  }

  analysers[userId] = {
    analyser,
    source,
    animFrame: requestAnimationFrame(tick)
  };
}

function stopVolumeAnalysis(userId) {
  if (analysers[userId]) {
    cancelAnimationFrame(analysers[userId].animFrame);
    try { analysers[userId].source.disconnect(); } catch(_) {}
    delete analysers[userId];
  }
}

// ═══════════════════════════════════════════════
//  ГОЛОСОВЫЕ КНОПКИ
// ═══════════════════════════════════════════════
btnJoin?.addEventListener('click', async () => {
  if (!socket) { toast('❌ Нет соединения'); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        sampleRate:       48000,
        sampleSize:       16,
        channelCount:     2,
        latency:          0
      }
    });

    await requestWakeLock();
    startKeepAlive();
    setMicStatus(true);

    btnJoin.style.display  = 'none';
    btnLeave.style.display = 'block';
    btnMic.style.display   = 'block';
    joined = true;

    const myLabel = '🟢 Вы (' + (window._currentUsername || socket.id.slice(0,6)) + ')';
    addParticipant(socket.id, myLabel);
    startVolumeAnalysis(socket.id, localStream);

    socket.emit('join');

    // Обрабатываем накопленные офферы
    for (const { from, offer } of pendingOffers) {
      await handleOffer(from, offer);
    }
    pendingOffers = [];

    // Создаём peer-соединения с теми кто уже в комнате
    for (const peerId of window._roomPeers) {
      if (!peers[peerId]) {
        const uname = window._peerNames.get(peerId) || peerId.slice(0,6);
        addParticipant(peerId, '👤 ' + uname);
        peers[peerId] = createPeer(peerId, true);
      }
    }

  } catch(err) {
    log('MIC ERROR: ' + err.name);
    const msgs = {
      NotAllowedError:  '❌ Доступ к микрофону запрещён.',
      NotFoundError:    '❌ Микрофон не найден.',
      NotReadableError: '❌ Микрофон занят другим приложением.'
    };
    toast(msgs[err.name] || '❌ ' + err.name + ': ' + err.message);
  }
});

btnLeave?.addEventListener('click', () => {
  if (socket) socket.emit('leave');
  hangUp();
  joined = false;
  resetVoiceUI();
  releaseWakeLock();
  stopKeepAlive();
});

btnMic?.addEventListener('click', () => {
  micEnabled = !micEnabled;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  }
  setMicStatus(micEnabled);
  btnMic.textContent = micEnabled
    ? '🔇 Выкл. микрофон'
    : '🎙 Вкл. микрофон';
});

function setMicStatus(active) {
  const el = document.getElementById('mic-status');
  if (!el) return;
  el.textContent = active ? '🟢 Микрофон активен' : '🔴 Микрофон выключен';
  el.className   = 'mic-status ' + (active ? 'active' : 'muted');
}

function resetVoiceUI() {
  if (btnJoin)  btnJoin.style.display  = 'block';
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic)   btnMic.style.display   = 'none';
  document.getElementById('reconnect-banner')?.classList.remove('visible');
  const ms = document.getElementById('mic-status');
  if (ms) { ms.className = 'mic-status'; ms.textContent = ''; }
}

// ═══════════════════════════════════════════════
//  WebRTC — создание peer
// ═══════════════════════════════════════════════
function createPeer(userId, isInitiator) {
  log('Creating peer ' + userId + ' init=' + isInitiator);
  const peer = new RTCPeerConnection(iceServers);

  if (localStream) {
    localStream.getTracks().forEach(t => peer.addTrack(t, localStream));
  }

  // Максимальный битрейт для аудио
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
    log('Peer ' + userId + ': ' + peer.connectionState);
    if (peer.connectionState === 'connected') {
      if (Object.keys(peers).length === 1) {
        startQualityMonitor(socket.id, peer, true);
      }
      startQualityMonitor(userId, peer, false);
    }
    if (peer.connectionState === 'failed') peer.restartIce();
  });

  peer.ontrack = event => {
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio             = document.createElement('audio');
      audio.id          = 'audio-' + userId;
      audio.autoplay    = true;
      audio.playsInline = true;
      hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play()
      .then(() => startVolumeAnalysis(userId, event.streams[0]))
      .catch(e  => log('Autoplay: ' + e.message));
  };

  peer.onicecandidate = e => {
    if (e.candidate && socket) {
      socket.emit('ice-candidate', { to: userId, candidate: e.candidate });
    }
  };

  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState === 'failed') peer.restartIce();
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer    = await peer.createOffer();
        const improved = {
          type: offer.type,
          sdp:  forceOpusMaxQuality(offer.sdp)
        };
        await peer.setLocalDescription(improved);
        socket.emit('offer', { to: userId, offer: improved });
      } catch(e) { log('Offer error: ' + e.message); }
    };
  }

  return peer;
}

// ═══════════════════════════════════════════════
//  WebRTC — обработка входящего оффера
// ═══════════════════════════════════════════════
async function handleOffer(from, offer) {
  const peer  = createPeer(from, false);
  peers[from] = peer;

  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer   = await peer.createAnswer();
  const improved = {
    type: answer.type,
    sdp:  forceOpusMaxQuality(answer.sdp)
  };
  await peer.setLocalDescription(improved);
  socket.emit('answer', { to: from, answer: improved });
}

// ═══════════════════════════════════════════════
//  ЗАВЕРШЕНИЕ ГОЛОСОВОГО
// ═══════════════════════════════════════════════
function hangUp() {
  Object.keys(analysers)     .forEach(id => stopVolumeAnalysis(id));
  Object.keys(qualityTimers) .forEach(id => stopQualityMonitor(id));
  Object.values(peers)       .forEach(p  => p.close());
  peers = {};

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }

  hiddenAudios.innerHTML     = '';
  pendingOffers              = [];
  participantsList.innerHTML = '';
  participantsBox.style.display = 'none';
  micEnabled = true;
}

// ═══════════════════════════════════════════════
//  ЭКСПОРТ глобальных функций для index.html
// ═══════════════════════════════════════════════
window.initSocket   = initSocket;
window.socketLeave  = socketLeave;
