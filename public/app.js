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
    const cipher  = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, cryptoKey, encoded);
    return {
      iv:        btoa(String.fromCharCode(...iv)),
      encrypted: btoa(String.fromCharCode(...new Uint8Array(cipher)))
    };
  }

  async function decrypt(encB64, ivB64) {
    const iv     = Uint8Array.from(atob(ivB64),  c=>c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(encB64), c=>c.charCodeAt(0));
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
//  SOCKET
// ═══════════════════════════════════════════════
const socket = io({
  reconnection:         true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:    1000,
  reconnectionDelayMax: 5000,
  timeout:              20000,
  transports:           ['websocket','polling'],
  autoConnect:          false,
});

// ── DOM ──
const screenPassword   = document.getElementById('screen-password');
const screenMain       = document.getElementById('screen-main');
const pwInput          = document.getElementById('pw-input');
const pwError          = document.getElementById('pw-error');
const btnEnter         = document.getElementById('btn-enter');
const btnTogglePw      = document.getElementById('btn-toggle-pw');
const btnJoin          = document.getElementById('btn-join');
const btnLeave         = document.getElementById('btn-leave');
const btnMic           = document.getElementById('btn-mic');
const btnChatOpen      = document.getElementById('btn-chat-open');
const userCount        = document.getElementById('user-count');
const micStatus        = document.getElementById('mic-status');
const hiddenAudios     = document.getElementById('hidden-audios');
const participantsBox  = document.getElementById('participants');
const participantsList = document.getElementById('participants-list');
const reconnectBanner  = document.getElementById('reconnect-banner');
const secureBadge      = document.getElementById('secure-badge');
const keepAliveAudio   = document.getElementById('keep-alive-audio');
const chatPanel        = document.getElementById('chat-panel');
const chatMessages     = document.getElementById('chat-messages');
const chatInput        = document.getElementById('chat-input');
const btnSend          = document.getElementById('btn-send');
const btnClosChat      = document.getElementById('btn-close-chat');
const btnPhoto         = document.getElementById('btn-photo');
const btnVideo         = document.getElementById('btn-video');
const btnFile          = document.getElementById('btn-file');
const fileInput        = document.getElementById('file-input');
const chatBadge        = document.getElementById('chat-badge');
const lightbox         = document.getElementById('lightbox');
const lightboxContent  = document.getElementById('lightbox-content');
const lightboxClose    = document.getElementById('lightbox-close');
const noiseIndicator   = document.getElementById('noise-indicator');

let localStream      = null;   // сырой поток с микрофона
let processedStream  = null;   // поток после обработки (идёт в WebRTC)
let noiseWorklet     = null;   // AudioWorkletNode
let peers            = {};
let micEnabled       = true;
let pendingOffers    = [];
let joined           = false;
let audioCtx         = null;
let wakeLock         = null;
let savedPassword    = '';
let unreadCount      = 0;
let chatOpen         = false;
let pendingFileType  = 'image/*';
let msgCounter       = 0;

const analysers      = {};
const qualityTimers  = {};

// ═══════════════════════════════════════════════
//  ЛОГ
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
//  ПАРОЛЬ
// ═══════════════════════════════════════════════
btnTogglePw.addEventListener('click', () => {
  const isText = pwInput.type === 'text';
  pwInput.type            = isText ? 'password' : 'text';
  btnTogglePw.textContent = isText ? '👁' : '🙈';
});

pwInput.addEventListener('keydown', e => { if (e.key==='Enter') attemptEnter(); });
btnEnter.addEventListener('click', attemptEnter);

async function attemptEnter() {
  const pw = pwInput.value.trim();
  if (!pw) { showPwError('Введи пароль'); return; }

  btnEnter.disabled    = true;
  btnEnter.textContent = '⏳ Проверяем…';
  pwError.textContent  = '';

  try {
    const res  = await fetch('/auth', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();
    if (data.ok) {
      savedPassword = pw;
      await Crypto.deriveKey(pw);
      log('Crypto key derived');
      enterChat();
    } else {
      showPwError('❌ Неверный пароль');
      pwInput.classList.add('error');
      setTimeout(() => pwInput.classList.remove('error'), 400);
    }
  } catch(e) {
    showPwError('⚠️ Ошибка соединения');
    log('Auth error: ' + e.message);
  } finally {
    btnEnter.disabled    = false;
    btnEnter.textContent = '🔑 Войти';
  }
}

function showPwError(msg) {
  pwError.textContent = msg;
  setTimeout(() => { pwError.textContent = ''; }, 3000);
}

function enterChat() {
  screenPassword.style.display = 'none';
  screenMain.classList.add('active');
  secureBadge.classList.add('visible');
  btnChatOpen.classList.add('visible');
  socket.connect();
}

// ═══════════════════════════════════════════════
//  ЧАТ — ОТКРЫТИЕ / ЗАКРЫТИЕ
// ═══════════════════════════════════════════════
btnChatOpen.addEventListener('click', openChat);
btnClosChat.addEventListener('click', closeChat);

function openChat() {
  chatOpen    = true;
  unreadCount = 0;
  chatBadge.classList.remove('visible');
  chatBadge.textContent = '0';
  setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 100);
}

function closeChat() {
  chatOpen = false;
}

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

chatInput.addEventListener('keydown', e => {
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});

btnSend.addEventListener('click', sendTextMessage);

// ═══════════════════════════════════════════════
//  ОТПРАВКА ТЕКСТА
// ═══════════════════════════════════════════════
async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  btnSend.disabled = true;
  try {
    const { encrypted, iv } = await Crypto.encrypt(text);
    socket.emit('chat-message', { encrypted, iv, type:'text' });
    appendMessage({ from:socket.id, text, type:'text', timestamp:Date.now(), mine:true, status:'ok' });
    chatInput.value = '';
    chatInput.style.height = 'auto';
  } catch(e) { log('Send text error: '+e.message); }
  finally    { btnSend.disabled = false; }
}

// ═══════════════════════════════════════════════
//  ФАЙЛЫ — кнопки
// ═══════════════════════════════════════════════
btnPhoto.addEventListener('click', () => {
  pendingFileType  = 'image/*';
  fileInput.accept = 'image/*';
  fileInput.click();
});

btnVideo.addEventListener('click', () => {
  pendingFileType  = 'video/*';
  fileInput.accept = 'video/*';
  fileInput.click();
});

btnFile.addEventListener('click', () => {
  pendingFileType  = '*/*';
  fileInput.accept = '*/*';
  fileInput.click();
});

// ═══════════════════════════════════════════════
//  ФАЙЛЫ — обработка выбора + редактор
// ═══════════════════════════════════════════════
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = '';

  if (file.size > 50 * 1024 * 1024) {
    alert('Файл слишком большой. Максимум 50 МБ.');
    return;
  }

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  if (isImage) {
    MediaEditor.openPhoto(
      file,
      async (blob, mimeType, fileName) => { await sendMediaBlob(blob, mimeType, fileName, 'image'); },
      () => {}
    );
    return;
  }

  if (isVideo) {
    MediaEditor.openVideo(
      file,
      async (blob, mimeType, fileName) => { await sendMediaBlob(blob, mimeType, fileName, 'video'); },
      () => {}
    );
    return;
  }

  await sendMediaBlob(file, file.type, file.name, 'file');
});

async function sendMediaBlob(blob, mimeType, fileName, type) {
  try {
    const arrayBuf          = await blob.arrayBuffer();
    const { encrypted, iv } = await Crypto.encrypt(arrayBuf);
    const localUrl          = URL.createObjectURL(new Blob([arrayBuf], { type: mimeType }));

    socket.emit('chat-message', {
      encrypted, iv, type,
      fileName: fileName || 'file',
      fileSize: blob.size,
      mimeType,
    });

    appendMessage({
      from:      socket.id,
      type,
      localUrl,
      fileName:  fileName || 'file',
      fileSize:  blob.size,
      mimeType,
      timestamp: Date.now(),
      mine:      true,
      status:    'ok'
    });
  } catch(e) {
    log('Send media error: '+e.message);
    alert('Ошибка при отправке: '+e.message);
  }
}

// ═══════════════════════════════════════════════
//  ПОЛУЧЕНИЕ СООБЩЕНИЙ
// ═══════════════════════════════════════════════
socket.on('chat-message', async (data) => {
  log('Chat msg type='+data.type+' from='+data.from);

  const msgId = appendMessage({
    from:      data.from,
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
      updateMessage(msgId, { text, status:'ok' });
    } else {
      const mime = data.mimeType || 'application/octet-stream';
      const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
      const url  = URL.createObjectURL(blob);
      updateMessage(msgId, { localUrl:url, status:'ok' });
    }
  } catch(e) {
    log('Decrypt error: '+e.message);
    updateMessage(msgId, { status:'error' });
  }

  if (!chatOpen) {
    unreadCount++;
    chatBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    chatBadge.classList.add('visible');
  }
});

// ═══════════════════════════════════════════════
//  РЕНДЕР СООБЩЕНИЙ
// ═══════════════════════════════════════════════
function appendMessage(msg) {
  const id  = 'msg-'+(++msgCounter);
  const div = document.createElement('div');
  div.id        = id;
  div.className = 'msg '+(msg.mine ? 'mine' : 'theirs');
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
    content.innerHTML = buildContentHTML({ type, mimeType, fileName, fileSize, ...updates });
    bindMediaEvents(div);
  }

  const statusEl = div.querySelector('.msg-decrypt-status');
  if (statusEl) {
    if (updates.status==='ok')         { statusEl.className='msg-decrypt-status ok';  statusEl.textContent='🔓 расшифровано'; }
    if (updates.status==='error')      { statusEl.className='msg-decrypt-status err'; statusEl.textContent='⚠️ ошибка расшифровки'; }
    if (updates.status==='decrypting') statusEl.textContent = '⏳ расшифровываем…';
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function buildMsgHTML(msg) {
  const time        = new Date(msg.timestamp||Date.now()).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
  const sender      = msg.mine ? '' : `<div class="msg-sender">👤 ${shortId(msg.from)}</div>`;
  const statusText  = msg.status==='ok'    ? '🔓 расшифровано'
    : msg.status==='error'                 ? '⚠️ ошибка расшифровки'
    : '⏳ расшифровываем…';
  const statusClass = msg.status==='ok' ? 'ok' : msg.status==='error' ? 'err' : '';
  const showStatus  = msg.mine ? '' : `<div class="msg-decrypt-status ${statusClass}">${statusText}</div>`;

  return `
    ${sender}
    <div class="msg-content">${buildContentHTML(msg)}</div>
    <div class="msg-meta">${time}</div>
    ${showStatus}
  `;
}

function buildContentHTML(msg) {
  if (msg.type==='text') {
    return escapeHtml(msg.text || '');
  }
  if (msg.type==='image') {
    if (msg.localUrl) return `<img class="msg-media" src="${msg.localUrl}" alt="фото" loading="lazy">`;
    return '<span style="color:#888;font-size:12px">⏳ загрузка изображения…</span>';
  }
  if (msg.type==='video') {
    if (msg.localUrl) return `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>`;
    return '<span style="color:#888;font-size:12px">⏳ загрузка видео…</span>';
  }
  if (msg.type==='file') {
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
  lightboxContent.innerHTML = type==='img'
    ? `<img src="${src}" alt="">`
    : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}

lightboxClose.addEventListener('click', () => {
  lightbox.classList.remove('open');
  lightboxContent.innerHTML = '';
});

lightbox.addEventListener('click', e => {
  if (e.target===lightbox) {
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
  if (bytes < 1024)         return bytes+' Б';
  if (bytes < 1024*1024)    return (bytes/1024).toFixed(1)+' КБ';
  return (bytes/1024/1024).toFixed(1)+' МБ';
}

function shortId(id) { return id ? id.slice(0,6) : '??'; }

// ═══════════════════════════════════════════════
//  WAKELOCK
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('WakeLock acquired');
  } catch(e) { log('WakeLock: '+e.message); }
}

async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch(_){} wakeLock=null; }
}

// ═══════════════════════════════════════════════
//  KEEP-ALIVE (iOS)
// ═══════════════════════════════════════════════
function startKeepAlive() {
  try {
    const ctx  = new (window.AudioContext||window.webkitAudioContext)();
    const buf  = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const src  = ctx.createBufferSource();
    const dest = ctx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true;
    src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(e => log('KeepAlive: '+e.message));
  } catch(e) { log('KeepAlive init: '+e.message); }
}

function stopKeepAlive() {
  keepAliveAudio.srcObject = null;
  keepAliveAudio.pause();
}

// ═══════════════════════════════════════════════
//  AUDIO PIPELINE — шумоподавление
//
//  Цепочка обработки:
//    rawStream (микрофон)
//      → MediaStreamSource
//      → HighPassFilter  (убирает гул ниже 80 Гц)
//      → DynamicsCompressor (выравнивает громкость голоса)
//      → NoiseGateProcessor (AudioWorklet: гейт + вычитание шума)
//      → OutputGain
//      → MediaStreamDestination → processedStream (в WebRTC)
// ═══════════════════════════════════════════════

/**
 * Запрашивает микрофон с максимальными подсказками браузеру.
 * Возвращает сырой MediaStream.
 */
async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      echoCancellation:  true,
      noiseSuppression:  true,
      autoGainControl:   true,
      sampleRate:        48000,
      sampleSize:        16,
      channelCount:      2,
      latency:           0,
    }
  });
}

/**
 * Строит цепочку Web Audio обработки поверх сырого потока.
 * Возвращает обработанный MediaStream для передачи в WebRTC.
 * При любой ошибке возвращает исходный rawStream (фоллбэк).
 */
async function buildAudioPipeline(rawStream) {
  // Создаём / переиспользуем AudioContext
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate:  48000,
      latencyHint: 'interactive',
    });
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Загружаем AudioWorklet (ошибка "already loaded" — не страшна)
  try {
    await audioCtx.audioWorklet.addModule('/audio-processor.js');
    log('AudioWorklet loaded');
  } catch(e) {
    log('AudioWorklet load: ' + e.message);
  }

  const source = audioCtx.createMediaStreamSource(rawStream);

  // ── 1. High-pass фильтр — срезаем гул ниже 80 Гц ──
  const hpf           = audioCtx.createBiquadFilter();
  hpf.type            = 'highpass';
  hpf.frequency.value = 80;
  hpf.Q.value         = 0.7;

  // ── 2. DynamicsCompressor — выравниваем уровень голоса ──
  const compressor           = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;   // начинаем сжимать с -24 дБ
  compressor.knee.value      = 8;     // мягкое колено
  compressor.ratio.value     = 4;     // 4:1
  compressor.attack.value    = 0.003;
  compressor.release.value   = 0.15;

  // ── 3. Noise Gate (AudioWorklet) ──
  noiseWorklet = new AudioWorkletNode(audioCtx, 'noise-gate-processor', {
    processorOptions: {
      threshold: 0.008,  // порог срабатывания гейта
      attack:    0.003,
      release:   0.08,
      smoothing: 0.92,
    },
    numberOfInputs:     1,
    numberOfOutputs:    1,
    outputChannelCount: [[2]](#annotation-145666-1),
  });

  // ── 4. Выходное усиление ──
  const outputGain       = audioCtx.createGain();
  outputGain.gain.value  = 1.1;

  // ── 5. Назначение → обработанный MediaStream ──
  const destination = audioCtx.createMediaStreamDestination();

  // Собираем цепочку
  source
    .connect(hpf)
    .connect(compressor)
    .connect(noiseWorklet)
    .connect(outputGain)
    .connect(destination);

  if (noiseIndicator) noiseIndicator.classList.add('visible');
  log('Audio pipeline: HPF → Compressor → NoiseGate → Output');

  return destination.stream;
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
      const newRaw   = await getMicStream();
      const newTrack = newRaw.getAudioTracks()[0];

      // Заменяем трек во всех peer-соединениях
      // Если был worklet — пересобираем pipeline
      let newProcessed;
      try {
        newProcessed = await buildAudioPipeline(newRaw);
      } catch(e) {
        log('Pipeline rebuild fallback: ' + e.message);
        newProcessed = newRaw;
      }

      for (const [uid, peer] of Object.entries(peers)) {
        const senders = peer.getSenders();
        // Заменяем трек из обработанного потока
        const procTrack = newProcessed.getAudioTracks()[0];
        const sender    = senders.find(s => s.track?.kind === 'audio');
        if (sender && procTrack) {
          await sender.replaceTrack(procTrack);
          log('Replaced processed track for ' + uid);
        }
      }

      // Останавливаем старые треки
      tracks.forEach(t => { localStream.removeTrack(t); t.stop(); });
      localStream.addTrack(newTrack);
      processedStream = newProcessed;

      stopVolumeAnalysis(socket.id);
      startVolumeAnalysis(socket.id, localStream);
      newTrack.enabled = micEnabled;
      log('Mic restored');
    } catch(e) { log('Restore mic failed: ' + e.message); }
  } else {
    tracks.forEach(t => { t.enabled = micEnabled; });
  }

  if (audioCtx?.state === 'suspended') { await audioCtx.resume(); log('AudioCtx resumed'); }
});

// ═══════════════════════════════════════════════
//  ЗВУКИ
// ═══════════════════════════════════════════════
function playBeep(type) {
  try {
    const ctx  = new (window.AudioContext||window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.35);
    if (type==='join') {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.setValueAtTime(900, ctx.currentTime+0.12);
    } else {
      osc.frequency.setValueAtTime(900, ctx.currentTime);
      osc.frequency.setValueAtTime(500, ctx.currentTime+0.12);
    }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.35);
    osc.onended = () => ctx.close();
  } catch(e) { log('Beep: '+e.message); }
}

// ═══════════════════════════════════════════════
//  ЗВУК "ОК" — двойной тон когда друг нажал "Понял"
// ═══════════════════════════════════════════════
function playOkSound() {
  try {
    const ctx  = new (window.AudioContext||window.webkitAudioContext)();
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
      gain.gain.setValueAtTime(0,     ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.4,   ctx.currentTime + start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.20);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime  + start + 0.22);
    });

    setTimeout(() => ctx.close(), 1500);
  } catch(e) { log('OkSound: '+e.message); }
}

// ═══════════════════════════════════════════════
//  ICE
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
  const lines = sdp.split('\r\n'), result = [];
  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[[1]](#annotation-145666-0).split(' ')[0];
      if (i+1<lines.length && lines[i+1].startsWith('a=fmtp:'+pt)) i++;
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
  if (rtt===null) return 'none';
  const lr = (lost+total)>0 ? lost/(lost+total) : 0;
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
      if (r.type==='inbound-rtp'&&r.kind==='audio')   { lost=r.packetsLost||0; received=r.packetsReceived||0; jitter=r.jitter||0; }
      if (r.type==='candidate-pair'&&r.state==='succeeded'&&r.currentRoundTripTime!=null) rtt=r.currentRoundTripTime*1000;
    });
    return calcLevel(rtt, lost, received, jitter);
  } catch { return 'none'; }
}

async function measureLocalQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt=null, lost=0, sent=0, jitter=0;
    stats.forEach(r => {
      if (r.type==='remote-inbound-rtp'&&r.kind==='audio') { lost=r.packetsLost||0; jitter=r.jitter||0; if(r.roundTripTime!=null) rtt=r.roundTripTime*1000; }
      if (r.type==='outbound-rtp'&&r.kind==='audio')        sent=r.packetsSent||0;
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
//  УЧАСТНИКИ
// ═══════════════════════════════════════════════
function addParticipant(userId, label) {
  if (document.getElementById('p-'+userId)) return;
  participantsBox.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'participant';
  div.id        = 'p-'+userId;

  const isMe          = userId === socket.id;
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

  const btn = div.querySelector('.btn-understood');
  if (btn) {
    btn.addEventListener('click', () => {
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
  const el = document.getElementById('p-'+userId);
  if (el) el.remove();
  if (participantsList.children.length===0) participantsBox.style.display='none';
}

// ═══════════════════════════════════════════════
//  ГРОМКОСТЬ
// ═══════════════════════════════════════════════
function startVolumeAnalysis(userId, stream) {
  // Переиспользуем audioCtx если уже создан pipeline,
  // иначе создаём отдельный контекст для анализа
  const ctx = audioCtx || new (window.AudioContext||window.webkitAudioContext)({ sampleRate:48000 });
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
    const pct = Math.min(100, (sum / data.length) * 3);
    const bar = document.getElementById('vol-'+userId);
    if (bar) { bar.style.width = pct+'%'; bar.className = 'volume-bar'+(pct>60?' loud':''); }
    analysers[userId].animFrame = requestAnimationFrame(tick);
  }
  analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
}

function stopVolumeAnalysis(userId) {
  if (analysers[userId]) {
    cancelAnimationFrame(analysers[userId].animFrame);
    try { analysers[userId].source.disconnect(); } catch(_){}
    delete analysers[userId];
  }
}

// ═══════════════════════════════════════════════
//  SOCKET СОБЫТИЯ
// ═══════════════════════════════════════════════
socket.on('connect', () => {
  log('Connected: '+socket.id);
  reconnectBanner.classList.remove('visible');
  socket.emit('authenticate', savedPassword);
});

socket.on('auth-ok', () => {
  log('Auth OK');
  if (joined && localStream) socket.emit('join');
});

socket.on('auth-fail', () => {
  log('Auth FAIL');
  savedPassword = '';
  screenPassword.style.display = 'block';
  screenMain.classList.remove('active');
  secureBadge.classList.remove('visible');
  btnChatOpen.classList.remove('visible');
  showPwError('❌ Сессия истекла, войди заново');
  hangUp();
  joined = false;
});

socket.on('disconnect', reason => {
  log('Disconnected: '+reason);
  if (joined) reconnectBanner.classList.add('visible');
});

socket.on('user-count', count => { userCount.textContent = count; });

// ── Получаем сигнал "Понял" от друга ──
socket.on('understood', ({ from }) => {
  log('Understood from: '+from);
  playOkSound();

  const banner = document.createElement('div');
  banner.className   = 'understood-banner';
  banner.textContent = '✅ Понял! (' + shortId(from) + ')';
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 3000);
});

// ═══════════════════════════════════════════════
//  ГОЛОСОВЫЕ КНОПКИ
// ═══════════════════════════════════════════════
btnJoin.addEventListener('click', async () => {
  try {
    // 1. Получаем сырой поток с микрофона
    const rawStream = await getMicStream();
    localStream     = rawStream;

    // 2. Строим цепочку шумоподавления
    try {
      processedStream = await buildAudioPipeline(rawStream);
      log('Audio pipeline active');
    } catch(pipelineErr) {
      // AudioWorklet не поддерживается — передаём сырой поток
      log('Pipeline fallback: ' + pipelineErr.message);
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

    addParticipant(socket.id, '🟢 Вы ('+shortId(socket.id)+')');
    // Анализируем громкость по сырому потоку (виден реальный уровень)
    startVolumeAnalysis(socket.id, localStream);
    socket.emit('join');

    for (const { from, offer } of pendingOffers) await handleOffer(from, offer);
    pendingOffers = [];

  } catch(err) {
    log('MIC ERROR: '+err.name);
    const msgs = {
      NotAllowedError:  '❌ Доступ к микрофону запрещён.',
      NotFoundError:    '❌ Микрофон не найден.',
      NotReadableError: '❌ Микрофон занят.'
    };
    alert(msgs[err.name] || '❌ '+err.name+': '+err.message);
  }
});

btnLeave.addEventListener('click', () => {
  socket.emit('leave');
  hangUp();
  joined = false;
  btnJoin.style.display  = 'block';
  btnLeave.style.display = 'none';
  btnMic.style.display   = 'none';
  reconnectBanner.classList.remove('visible');
  micStatus.className = 'mic-status'; micStatus.textContent = '';
  releaseWakeLock();
  stopKeepAlive();
});

// Mute/unmute управляет сырым треком —
// worklet просто не получает сигнал и закрывает гейт
btnMic.addEventListener('click', () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  setMicStatus(micEnabled);
  btnMic.textContent = micEnabled ? '🔇 Выключить микрофон' : '🎙️ Включить микрофон';
});

function setMicStatus(active) {
  micStatus.textContent = active ? '🟢 Микрофон активен' : '🔴 Микрофон выключен';
  micStatus.className   = 'mic-status '+(active ? 'active' : 'muted');
}

// ═══════════════════════════════════════════════
//  WebRTC
// ═══════════════════════════════════════════════
socket.on('existing-users', async (userIds) => {
  log('Existing: '+JSON.stringify(userIds));
  for (const uid of userIds) {
    addParticipant(uid, '👤 '+shortId(uid));
    peers[uid] = createPeer(uid, true);
  }
});

socket.on('user-joined', uid => {
  log('User joined: '+uid);
  playBeep('join');
  addParticipant(uid, '👤 '+shortId(uid));
});

socket.on('offer', async ({ from, offer }) => {
  if (!localStream) { pendingOffers.push({ from, offer }); return; }
  await handleOffer(from, offer);
});

async function handleOffer(from, offer) {
  const peer  = createPeer(from, false);
  peers[from] = peer;
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer   = await peer.createAnswer();
  const improved = { type:answer.type, sdp:forceOpusMaxQuality(answer.sdp) };
  await peer.setLocalDescription(improved);
  socket.emit('answer', { to:from, answer:improved });
}

socket.on('answer', async ({ from, answer }) => {
  const peer = peers[from];
  if (peer?.signalingState==='have-local-offer')
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) {
    try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch(e) { log('ICE: '+e.message); }
  }
});

socket.on('user-left', uid => {
  log('User left: '+uid);
  playBeep('leave');
  removeParticipant(uid);
  stopVolumeAnalysis(uid);
  stopQualityMonitor(uid);
  if (peers[uid]) { peers[uid].close(); delete peers[uid]; }
  document.getElementById('audio-'+uid)?.remove();
});

function createPeer(userId, isInitiator) {
  log('Creating peer '+userId+' init='+isInitiator);
  const peer = new RTCPeerConnection(iceServers);

  // В WebRTC передаём обработанный поток (после шумоподавления)
  const stream = processedStream || localStream;
  stream.getTracks().forEach(t => peer.addTrack(t, stream));

  peer.getSenders().forEach(sender => {
    if (sender.track?.kind==='audio') {
      const p = sender.getParameters();
      if (!p.encodings) p.encodings = [{}];
      p.encodings[0].maxBitrate = 510000;
      p.encodings[0].priority   = 'high';
      sender.setParameters(p).catch(()=>{});
    }
  });

  peer.addEventListener('connectionstatechange', () => {
    log('Peer '+userId+': '+peer.connectionState);
    if (peer.connectionState==='connected') {
      if (Object.keys(peers).length===1) startQualityMonitor(socket.id, peer, true);
      startQualityMonitor(userId, peer, false);
    }
    if (peer.connectionState==='failed') peer.restartIce();
  });

  peer.ontrack = event => {
    let audio = document.getElementById('audio-'+userId);
    if (!audio) {
      audio             = document.createElement('audio');
      audio.id          = 'audio-'+userId;
      audio.autoplay    = true;
      audio.playsInline = true;
      hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play()
      .then(()  => startVolumeAnalysis(userId, event.streams[0]))
      .catch(e  => log('Autoplay: '+e.message));
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to:userId, candidate:e.candidate });
  };

  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState==='failed') peer.restartIce();
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer    = await peer.createOffer();
        const improved = { type:offer.type, sdp:forceOpusMaxQuality(offer.sdp) };
        await peer.setLocalDescription(improved);
        socket.emit('offer', { to:userId, offer:improved });
      } catch(e) { log('Offer error: '+e.message); }
    };
  }

  return peer;
}

// ═══════════════════════════════════════════════
//  ЗАВЕРШЕНИЕ
// ═══════════════════════════════════════════════
function hangUp() {
  Object.keys(analysers)    .forEach(id => stopVolumeAnalysis(id));
  Object.keys(qualityTimers).forEach(id => stopQualityMonitor(id));
  Object.values(peers).forEach(p => p.close());
  peers = {};

  // Останавливаем сырой поток
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  // Отключаем и удаляем worklet
  if (noiseWorklet) {
    try { noiseWorklet.disconnect(); } catch(_){}
    noiseWorklet = null;
  }

  // Закрываем AudioContext
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  processedStream = null;
  if (noiseIndicator) noiseIndicator.classList.remove('visible');

  hiddenAudios.innerHTML        = '';
  pendingOffers                 = [];
  participantsList.innerHTML    = '';
  participantsBox.style.display = 'none';
}
