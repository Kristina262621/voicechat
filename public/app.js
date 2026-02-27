// ═══════════════════════════════════════════════
//  CRYPTO — AES-256-GCM (Сквозное шифрование)
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
    const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const cipher  = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, cryptoKey, encoded);
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
//  SOCKET — ЯДРО СВЯЗИ С СЕРВЕРОМ
// ═══════════════════════════════════════════════
let socket = null;
window._roomPeers = new Set();
window._peerNames = new Map();

function initSocket(token, roomId, username) {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  window._roomPeers.clear();
  window._peerNames.clear();

  Crypto.deriveKey(String(roomId)).catch(e => console.error(e));

  socket = io({
    reconnection:         true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    1000,
    reconnectionDelayMax: 5000,
    timeout:              20000,
    transports:           ['websocket', 'polling'],
  });

  window._socket = socket;

  // ── Подключение ──
  socket.on('connect', () => {
    document.getElementById('reconnect-banner').classList.remove('visible');
    socket.emit('join-room', { token, roomId });
  });

  socket.on('auth-ok', ({ username: uname }) => { joined = false; });
  socket.on('auth-fail', () => { showScreen('screen-rooms'); toast('❌ Ошибка авторизации'); });
  socket.on('disconnect', () => { if (joined) document.getElementById('reconnect-banner').classList.add('visible'); });

  socket.on('user-count', count => {
    const el = document.getElementById('user-count');
    if (el) el.textContent = count;
  });

  // ── Синхронизация комнаты ──
  socket.on('existing-users', async (users) => {
    for (const u of users) {
      const socketId = typeof u === 'string' ? u : u.socketId;
      const uname = typeof u === 'string' ? 'Участник' : (u.username || 'Участник');

      window._roomPeers.add(socketId);
      window._peerNames.set(socketId, uname);
      
      if (joined && localStream) {
        addParticipant(socketId, '👤 ' + uname);
        peers[socketId] = createPeer(socketId, true);
      }
      if (window.onUserJoined) window.onUserJoined(socketId); // Для Видеочата
    }
  });

  socket.on('user-joined', (data) => {
    const socketId = typeof data === 'string' ? data : data.socketId;
    const uname = typeof data === 'string' ? 'Участник' : (data.username || 'Участник');

    window._roomPeers.add(socketId);
    window._peerNames.set(socketId, uname);
    playBeep('join');
    
    if (joined) addParticipant(socketId, '👤 ' + uname);
    showToastJoin(uname);

    if (window.onUserJoined) window.onUserJoined(socketId); // Для Видеочата
  });

  socket.on('user-left', (data) => {
    const socketId = typeof data === 'string' ? data : data.socketId;
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

    if (window.onUserLeft) window.onUserLeft(socketId); // Для Видеочата
  });

  // ── Голосовой WebRTC ──
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
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    }
  });

  // ── Чат (Текст и Файлы) ──
  socket.on('chat-message', async (data) => {
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
      updateMessage(msgId, { status: 'error' });
    }
  });

  socket.on('understood', ({ from, username: uname }) => {
    playOkSound();
    const name = uname || window._peerNames.get(from) || from?.slice(0,6);
    const banner = document.createElement('div');
    banner.className   = 'understood-banner';
    banner.textContent = '✅ Понял! (' + name + ')';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 3000);
  });

  // ── ВИДЕО WEB-RTC МОСТЫ (Связь с index.html) ── 
  socket.on('video-start',  (data) => { if (window.onVideoStart) window.onVideoStart(typeof data==='string'?data:data.from); });
  socket.on('video-stop',   (data) => { if (window.onVideoStop) window.onVideoStop(typeof data==='string'?data:data.from); });
  socket.on('video-offer',  async (data) => { window._roomPeers.add(data.from); if (window.onVideoOffer) await window.onVideoOffer(data.from, data.offer); });
  socket.on('video-answer', async (data) => { if (window.onVideoAnswer) await window.onVideoAnswer(data.from, data.answer); });
  socket.on('video-ice',    async (data) => { if (window.onVideoIce) await window.onVideoIce(data.from, data.candidate); });
}

function socketLeave() {
  if (!socket) return;
  socket.emit('leave');
  hangUp();
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

// ═══════════════════════════════════════════════
//  DOM ИНТЕРФЕЙС И УТИЛИТЫ ГЛОБАЛЬНОГО СОСТОЯНИЯ
// ═══════════════════════════════════════════════
const btnJoin          = document.getElementById('btn-join');
const btnLeave         = document.getElementById('btn-leave');
const btnMic           = document.getElementById('btn-mic');
const hiddenAudios     = document.getElementById('hidden-audios');
const participantsBox  = document.getElementById('participants');
const participantsList = document.getElementById('participants-list');
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

function showToastJoin(username) { toast('👋 ' + username + ' вошёл в комнату'); }
function showToastLeave(username) { toast('🚪 ' + username + ' покинул комнату'); }
function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatSize(b) { if(b<1024)return b+' Б'; if(b<1024*1024)return(b/1024).toFixed(1)+' КБ'; return(b/1024/1024).toFixed(1)+' МБ'; }

// ═══════════════════════════════════════════════
//  ЧАТ — ОТПРАВКА И ФАЙЛЫ
// ═══════════════════════════════════════════════
chatInput?.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

chatInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});

btnSend?.addEventListener('click', sendTextMessage);

async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  btnSend.disabled = true;
  try {
    const { encrypted, iv } = await Crypto.encrypt(text);
    socket.emit('chat-message', { encrypted, iv, type: 'text' });
    appendMessage({ from: socket.id, username: window._currentUsername || 'Вы', text, type: 'text', timestamp: Date.now(), mine: true, status: 'ok' });
    chatInput.value = ''; chatInput.style.height = 'auto';
  } catch(e) {}
  finally { btnSend.disabled = false; }
}

btnPhoto?.addEventListener('click', () => { fileInput.accept = 'image/*'; fileInput.click(); });
btnVideo?.addEventListener('click', () => { fileInput.accept = 'video/*'; fileInput.click(); });
btnFile?.addEventListener('click',  () => { fileInput.accept = '*/*'; fileInput.click(); });

fileInput?.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return; fileInput.value = '';
  if (file.size > 50 * 1024 * 1024) return toast('❌ Файл слишком большой. Максимум 50 МБ.');
  
  const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
  await sendMediaBlob(file, file.type, file.name, type);
});

async function sendMediaBlob(blob, mimeType, fileName, type) {
  if (!socket) return;
  try {
    const arrayBuf = await blob.arrayBuffer();
    const { encrypted, iv } = await Crypto.encrypt(arrayBuf);
    const localUrl = URL.createObjectURL(new Blob([arrayBuf], { type: mimeType }));

    socket.emit('chat-message', { encrypted, iv, type, fileName: fileName || 'file', fileSize: blob.size, mimeType });
    appendMessage({ from: socket.id, username: window._currentUsername || 'Вы', type, localUrl, fileName: fileName || 'file', fileSize: blob.size, mimeType, timestamp: Date.now(), mine: true, status: 'ok' });
  } catch(e) { toast('❌ Ошибка отправки'); }
}

function appendMessage(msg) {
  const id = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.id = id; div.className = 'msg ' + (msg.mine ? 'mine' : 'theirs');
  div.dataset.type = msg.type || 'text';
  div.innerHTML = buildMsgHTML(msg);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  bindMediaEvents(div);
  return id;
}

function updateMessage(id, updates) {
  const div = document.getElementById(id);
  if (!div) return;
  const content = div.querySelector('.msg-content');
  if (content) { content.innerHTML = buildContentHTML({ type: div.dataset.type, ...updates }); bindMediaEvents(div); }
  
  const statusEl = div.querySelector('.msg-decrypt-status');
  if (statusEl) {
    if (updates.status === 'ok') { statusEl.className = 'msg-decrypt-status ok'; statusEl.textContent = '🔓 расшифровано'; }
    if (updates.status === 'error') { statusEl.className = 'msg-decrypt-status err'; statusEl.textContent = '⚠️ ошибка'; }
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function buildMsgHTML(msg) {
  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });
  const senderName = msg.mine ? '' : `<div class="msg-sender">👤 ${escapeHtml(msg.username || '??')}</div>`;
  const statText = msg.status === 'ok' ? '🔓 расшифровано' : msg.status === 'error' ? '⚠️ ошибка' : '⏳ расшифровываем…';
  const showStatus = msg.mine ? '' : `<div class="msg-decrypt-status">${statText}</div>`;
  return `${senderName}<div class="msg-content">${buildContentHTML(msg)}</div><div class="msg-meta">${time}</div>${showStatus}`;
}

function buildContentHTML(msg) {
  if (msg.type === 'text') return escapeHtml(msg.text || '');
  if (msg.type === 'image') return msg.localUrl ? `<img class="msg-media" src="${msg.localUrl}" alt="фото">` : '<span>⏳</span>';
  if (msg.type === 'video') return msg.localUrl ? `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>` : '<span>⏳</span>';
  if (msg.type === 'file') {
    if (msg.localUrl) return `<div class="msg-file"><span class="msg-file-icon">📄</span><div class="msg-file-info"><div class="msg-file-name">${escapeHtml(msg.fileName)}</div><div class="msg-file-size">${formatSize(msg.fileSize)}</div></div><a class="msg-file-dl" href="${msg.localUrl}" download="${escapeHtml(msg.fileName)}">⬇️</a></div>`;
    return '<div class="msg-file">⏳ Загрузка файла...</div>';
  }
  return '';
}

function bindMediaEvents(container) {
  container.querySelectorAll('img.msg-media').forEach(img => { img.onclick = () => openLightbox('img', img.src); });
  container.querySelectorAll('video.msg-media').forEach(vid => { vid.ondblclick = () => openLightbox('video', vid.src); });
}

function openLightbox(type, src) {
  lightboxContent.innerHTML = type === 'img' ? `<img src="${src}" alt="">` : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ WEB-RTC И УЛУЧШЕНИЕ ЗВУКА
// ═══════════════════════════════════════════════
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: '4219a9030e911d3a21936639', credential: 'W9K/4EBqUUoxu9FC' }
  ]
};

// Функция улучшения качества аудио (Opus)
function forceOpusMaxQuality(sdp) {
  const lines = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[1].split(' ')[0];
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) i++;
      result.push(`a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000`);
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

btnJoin?.addEventListener('click', async () => {
  if (!socket) return toast('❌ Нет соединения');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 2 }
    });
    
    await requestWakeLock(); 
    startKeepAlive(); 
    setMicStatus(true);
    
    btnJoin.style.display = 'none'; btnLeave.style.display = 'block'; btnMic.style.display = 'block';
    joined = true;
    
    addParticipant(socket.id, '🟢 Вы (' + (window._currentUsername || socket.id.slice(0,6)) + ')');
    startVolumeAnalysis(socket.id, localStream);
    
    socket.emit('join');

    // Подключаемся к тем, кто уже в комнате
    for (const peerId of window._roomPeers) {
      if (!peers[peerId]) {
        addParticipant(peerId, '👤 ' + (window._peerNames.get(peerId) || peerId.slice(0,6)));
        peers[peerId] = createPeer(peerId, true);
      }
    }
    
    // Подхватываем тех, кто звонил нам пока мы не приняли доступ
    for (const { from, offer } of pendingOffers) await handleOffer(from, offer);
    pendingOffers = [];

  } catch(err) { toast('❌ Ошибка доступа к микрофону'); }
});

btnLeave?.addEventListener('click', () => {
  if (socket) socket.emit('leave');
  hangUp(); joined = false; resetVoiceUI(); releaseWakeLock(); stopKeepAlive();
});

btnMic?.addEventListener('click', () => {
  micEnabled = !micEnabled;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  setMicStatus(micEnabled);
  if (btnMic) btnMic.textContent = micEnabled ? '🔇 Выкл. микрофон' : '🎙 Вкл. микрофон';
});

function createPeer(userId, isInitiator) {
  const peer = new RTCPeerConnection(iceServers);
  if (localStream) localStream.getTracks().forEach(t => peer.addTrack(t, localStream));

  peer.ontrack = event => {
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio'); audio.id = 'audio-' + userId;
      audio.autoplay = true; audio.playsInline = true; hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play().then(() => startVolumeAnalysis(userId, event.streams[0])).catch(e=>{});
  };

  peer.onicecandidate = e => { if (e.candidate && socket) socket.emit('ice-candidate', { to: userId, candidate: e.candidate }); };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      const offer = await peer.createOffer();
      const improvedOffer = { type: offer.type, sdp: forceOpusMaxQuality(offer.sdp) };
      await peer.setLocalDescription(improvedOffer);
      socket.emit('offer', { to: userId, offer: improvedOffer });
    };
  }
  return peer;
}

async function handleOffer(from, offer) {
  const peer = createPeer(from, false);
  peers[from] = peer;
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.createAnswer();
  const improvedAnswer = { type: answer.type, sdp: forceOpusMaxQuality(answer.sdp) };
  await peer.setLocalDescription(improvedAnswer);
  socket.emit('answer', { to: from, answer: improvedAnswer });
}

// ═══════════════════════════════════════════════
//  УТИЛИТЫ ГРОМКОСТИ И ВИЗУАЛИЗАЦИЯ
// ═══════════════════════════════════════════════
function addParticipant(userId, label) {
  if (document.getElementById('p-' + userId) || !participantsBox) return;
  participantsBox.style.display = 'block';
  const div = document.createElement('div'); div.className = 'participant'; div.id = 'p-' + userId;
  const isMe = socket && userId === socket.id;
  div.innerHTML = `<span class="participant-name">${escapeHtml(label)}</span><div class="volume-bar-wrap"><div class="volume-bar" id="vol-${userId}"></div></div>` + (isMe ? '' : `<button class="btn-understood" data-uid="${userId}">👍 Понял</button>`);
  participantsList.appendChild(div);
  
  const btn = div.querySelector('.btn-understood');
  if (btn) btn.onclick = () => { socket?.emit('understood'); btn.textContent = '✅ Отправлено'; btn.disabled = true; setTimeout(() => { btn.textContent = '👍 Понял'; btn.disabled = false; }, 3000); };
}

function removeParticipant(userId) {
  document.getElementById('p-' + userId)?.remove();
  if (participantsList && participantsList.children.length === 0) participantsBox.style.display = 'none';
}

function startVolumeAnalysis(userId, stream) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  stopVolumeAnalysis(userId);
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    if (!analysers[userId]) return;
    analyser.getByteFrequencyData(data); let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const pct = Math.min(100, (sum / data.length) * 3);
    const bar = document.getElementById('vol-' + userId);
    if (bar) { bar.style.width = pct + '%'; bar.className = 'volume-bar' + (pct > 60 ? ' loud' : ''); }
    analysers[userId].animFrame = requestAnimationFrame(tick);
  }
  analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
}

function stopVolumeAnalysis(userId) {
  if (analysers[userId]) { cancelAnimationFrame(analysers[userId].animFrame); try { analysers[userId].source.disconnect(); } catch(_) {} delete analysers[userId]; }
}

function stopQualityMonitor(id) {
  if (qualityTimers[id]) { clearInterval(qualityTimers[id]); delete qualityTimers[id]; }
}

// ═══════════════════════════════════════════════
//  СИСТЕМНЫЕ ЗВУКИ И WAKELOCK (ВОССТАНОВЛЕНО)
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}
async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch(_) {} wakeLock = null; }
}

function startKeepAlive() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    const dest = audioCtx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true; src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream; keepAliveAudio.play().catch(e=>{});
  } catch(e) {}
}
function stopKeepAlive() { keepAliveAudio.srcObject = null; keepAliveAudio.pause(); }

function playBeep(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    if (type === 'join') { osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.setValueAtTime(900, ctx.currentTime + 0.12); } 
    else { osc.frequency.setValueAtTime(900, ctx.currentTime); osc.frequency.setValueAtTime(500, ctx.currentTime + 0.12); }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close();
  } catch(e) {}
}

function playOkSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain(); gain.connect(ctx.destination);
    [{ freq: 880, start: 0.00 }, { freq: 1100, start: 0.22 }].forEach(({ freq, start }) => {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.connect(gain);
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.20);
      osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + 0.22);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch(e) {}
}

function setMicStatus(active) { const el = document.getElementById('mic-status'); if(el) { el.textContent = active ? '🟢 Микрофон включен' : '🔴 Микрофон выключен'; el.className = 'mic-status ' + (active ? 'active' : 'muted'); } }
function resetVoiceUI() { if(btnJoin) btnJoin.style.display='block'; if(btnLeave) btnLeave.style.display='none'; if(btnMic) btnMic.style.display='none'; setMicStatus(false); }

// ═══════════════════════════════════════════════
//  ПОЛНАЯ ОЧИСТКА ПРИ ВЫХОДЕ ИЗ ЗВОНКА/КОМНАТЫ
// ═══════════════════════════════════════════════
function hangUp() {
  Object.keys(analysers).forEach(id => stopVolumeAnalysis(id));
  Object.values(peers).forEach(p  => p.close());
  peers = {};

  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }

  if (hiddenAudios) hiddenAudios.innerHTML = '';
  pendingOffers = [];
  if (participantsList) participantsList.innerHTML = '';
  if (participantsBox) participantsBox.style.display = 'none';
  micEnabled = true;

  // Если был включен видеочат (из index.html), автоматически закроем и его
  if (window.stopVideo) window.stopVideo(); 
}

window.initSocket  = initSocket;
window.socketLeave = socketLeave;
