// ═══════════════════════════════════════════════
//  CRYPTO — AES-256-GCM
// ═══════════════════════════════════════════════
const Crypto = (() => {
  let cryptoKey = null;

  async function deriveKey(password) {
    const enc    = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const salt = enc.encode('voicechat-salt-v1');
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
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
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
//  GLOBALS
// ═══════════════════════════════════════════════
let socket        = null;
let localStream   = null;
let peers         = {};
let micEnabled    = true;
let pendingOffers = [];
let joined        = false;
let audioCtx      = null;
let wakeLock      = null;
let msgCounter    = 0;

const analysers     = {};
const qualityTimers = {};
const messageStore  = new Map();
const typingSet     = new Set();

let replyTarget   = null;
let editingMsgId  = null;
let typingTimer   = null;
let typingActive  = false;

window._roomPeers  = new Set();
window._peerNames  = new Map();
window._peerAvatars = new Map();
window._peerIds    = new Map();

const DEFAULT_SERVER_URL = 'https://voicechat-production-3d23.up.railway.app';

// ═══════════════════════════════════════════════
//  DOM REFS  (безопасное получение)
// ═══════════════════════════════════════════════
function el(id) { return document.getElementById(id); }

// ═══════════════════════════════════════════════
//  УТИЛИТЫ
// ═══════════════════════════════════════════════
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b/1024).toFixed(1) + ' КБ';
  return (b/1048576).toFixed(1) + ' МБ';
}
function generateMsgId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ('m' + Date.now() + '-' + Math.random().toString(16).slice(2));
}
function getUserMeta(socketId) {
  return {
    socketId,
    username:  window._peerNames.get(socketId)  || 'Участник',
    avatar:    window._peerAvatars.get(socketId) || null,
    userId:    window._peerIds.get(socketId)     || null
  };
}
async function decryptMeta(metaEnc, metaIv) {
  if (!metaEnc || !metaIv) return null;
  try { return JSON.parse(await Crypto.decryptText(metaEnc, metaIv)); }
  catch { return null; }
}
function showToastJoin(username)  { toast('👋 ' + username + ' вошёл в комнату'); }
function showToastLeave(username) { toast('🚪 ' + username + ' покинул комнату'); }
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ═══════════════════════════════════════════════
//  SOCKET
// ═══════════════════════════════════════════════
function normalizeServerUrl(input) {
  let url = (input && String(input).trim()) || DEFAULT_SERVER_URL;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    u.hash = ''; u.search = '';
    if (u.hostname.endsWith('.up.railway.app')) u.port = '';
    return u.origin;
  } catch { return DEFAULT_SERVER_URL; }
}

function initSocket(token, roomId, username, serverUrl) {
  // Сброс предыдущего соединения
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  window._roomPeers.clear();
  window._peerNames.clear();
  window._peerAvatars.clear();
  window._peerIds.clear();

  // Сбрасываем состояние голосового чата
  hangUp();
  joined = false;
  resetVoiceUI();

  // Сбрасываем сообщения
  msgCounter = 0;
  messageStore.clear();
  typingSet.clear();

  Crypto.deriveKey(String(roomId)).catch(e => console.error('[crypto]', e));

  const url = normalizeServerUrl(serverUrl);
  console.log('[socket] connecting to:', url);

  socket = io(url, {
    path:               '/socket.io',
    transports:         ['websocket', 'polling'],
    upgrade:            true,
    rememberUpgrade:    true,
    reconnection:       true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:  1000,
    reconnectionDelayMax: 5000,
    timeout:            20000,
    withCredentials:    false
  });

  window._socket = socket;

  if (socket.io) {
    socket.io.on('reconnect_attempt', n => console.warn('[socket] reconnect_attempt:', n));
    socket.io.on('reconnect_error',   e => console.error('[socket] reconnect_error:', e?.message));
    socket.io.on('reconnect_failed',  () => console.error('[socket] reconnect_failed'));
  }

  socket.on('connect', () => {
    console.log('[socket] connected:', socket.id);
    el('reconnect-banner')?.classList.remove('visible');
    socket.emit('join-room', { token, roomId });
  });

  socket.on('connect_error', err => console.error('[socket] connect_error:', err?.message));
  socket.on('error', err => console.error('[socket] error:', err));

  socket.on('auth-fail', () => {
    if (window.showScreen) window.showScreen('screen-rooms');
    toast('❌ Ошибка авторизации');
  });

  socket.on('disconnect', reason => {
    console.warn('[socket] disconnect:', reason);
    if (joined) el('reconnect-banner')?.classList.add('visible');
  });

  socket.on('user-count', count => {
    const countEl = el('user-count');
    if (countEl) countEl.textContent = count;
  });

  socket.on('existing-users', async (users) => {
    for (const u of users) {
      const sid = u.socketId;
      window._roomPeers.add(sid);
      window._peerNames.set(sid, u.username || 'Участник');
      window._peerAvatars.set(sid, u.avatar || null);
      window._peerIds.set(sid, u.userId || null);
      // Если уже в голосовом — создаём peerConnection
      if (joined && localStream && !peers[sid]) {
        addParticipant(sid, u.username || 'Участник');
        peers[sid] = createPeer(sid, true);
      }
    }
  });

  socket.on('room-history', async ({ messages, pinned }) => {
    if (!Array.isArray(messages)) return;
    for (const m of messages) await appendHistoryMessage(m);
    if (pinned) updatePinnedBanner(pinned);
  });

  socket.on('user-joined', data => {
    const sid   = data.socketId;
    const uname = data.username || 'Участник';
    window._roomPeers.add(sid);
    window._peerNames.set(sid, uname);
    window._peerAvatars.set(sid, data.avatar || null);
    window._peerIds.set(sid, data.userId || null);
    playBeep('join');
    showToastJoin(uname);
    if (joined && localStream && !peers[sid]) {
      addParticipant(sid, uname);
      peers[sid] = createPeer(sid, true);
    }
  });

  socket.on('user-left', data => {
    const sid   = typeof data === 'string' ? data : data.socketId;
    const uname = window._peerNames.get(sid) || '???';
    window._roomPeers.delete(sid);
    window._peerNames.delete(sid);
    window._peerAvatars.delete(sid);
    window._peerIds.delete(sid);
    playBeep('leave');
    removeParticipant(sid);
    stopVolumeAnalysis(sid);
    stopQualityMonitor(sid);
    if (peers[sid]) { peers[sid].close(); delete peers[sid]; }
    el('audio-' + sid)?.remove();
    showToastLeave(uname);
    if (window.onUserLeft) window.onUserLeft(sid);
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
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    }
  });

  socket.on('chat-message', async (data) => {
    const uname  = window._peerNames.get(data.from) || data.username || '???';
    const avatar = window._peerAvatars.get(data.from) || null;
    const domId  = appendMessage({
      from:      data.from,
      userId:    data.userId,
      msgId:     data.msgId,
      username:  uname,
      avatar,
      type:      data.type,
      fileName:  data.fileName,
      fileSize:  data.fileSize,
      mimeType:  data.mimeType,
      timestamp: data.timestamp,
      mine:      false,
      status:    'decrypting'
    });
    try {
      const meta = await decryptMeta(data.metaEnc, data.metaIv);
      if (data.type === 'text') {
        const text = await Crypto.decryptText(data.encrypted, data.iv);
        updateMessage(domId, { text, status: 'ok', replyTo: meta?.replyTo || null, editedAt: data.editedAt || null });
      } else {
        const mime = data.mimeType || 'application/octet-stream';
        const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
        updateMessage(domId, { localUrl: URL.createObjectURL(blob), status: 'ok', replyTo: meta?.replyTo || null });
      }
    } catch { updateMessage(domId, { status: 'error' }); }
  });

  socket.on('message-edit', async (data) => {
    const msg = messageStore.get(data.msgId);
    if (!msg) return;
    try {
      const meta = await decryptMeta(data.metaEnc, data.metaIv);
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      updateMessage(msg.domId, { text, editedAt: data.editedAt || Date.now(), replyTo: meta?.replyTo || null });
    } catch {}
  });

  socket.on('message-delete', ({ msgId }) => {
    const msg = messageStore.get(msgId);
    if (msg) markMessageDeleted(msg.domId);
  });

  socket.on('reaction-toggle', ({ msgId, emoji, userId }) => {
    toggleReactionLocal(msgId, emoji, userId);
  });

  socket.on('room-pinned', ({ msgId }) => updatePinnedBanner(msgId));

  socket.on('typing', ({ username, isTyping }) => updateTyping(username, isTyping));

  socket.on('understood', ({ from, username: uname }) => {
    playOkSound();
    const name   = uname || window._peerNames.get(from) || '???';
    const banner = document.createElement('div');
    banner.className   = 'understood-banner';
    banner.textContent = '✅ Понял! (' + name + ')';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 3000);
  });

  socket.on('video-start',  d => { if (window.onVideoStart)  window.onVideoStart(typeof d==='string'?d:d.from); });
  socket.on('video-stop',   d => { if (window.onVideoStop)   window.onVideoStop(typeof d==='string'?d:d.from); });
  socket.on('video-offer',  async d => { window._roomPeers.add(d.from); if (window.onVideoOffer)  await window.onVideoOffer(d.from, d.offer); });
  socket.on('video-answer', async d => { if (window.onVideoAnswer) await window.onVideoAnswer(d.from, d.answer); });
  socket.on('video-ice',    async d => { if (window.onVideoIce)    await window.onVideoIce(d.from, d.candidate); });
}

function socketLeave() {
  if (!socket) return;
  socket.emit('leave');
  hangUp();
  joined = false;
  resetVoiceUI();
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  window._socket = null;
  window._roomPeers.clear();
  window._peerNames.clear();
  window._peerAvatars.clear();
  window._peerIds.clear();
}

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ — WebRTC
// ═══════════════════════════════════════════════
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls:       'turn:global.relay.metered.ca:80',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    }
  ]
};

function forceOpusQuality(sdp) {
  const lines = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[1].split(' ')[0];
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) i++;
      result.push(`a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=64000`);
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

// Ждём кнопку через DOMContentLoaded или сразу если DOM готов
function setupVoiceButtons() {
  const btnJoin  = el('btn-join');
  const btnLeave = el('btn-leave');
  const btnMic   = el('btn-mic');

  if (!btnJoin) {
    console.error('[voice] btn-join не найден!');
    return;
  }

  btnJoin.addEventListener('click', async () => {
    console.log('[voice] btn-join clicked, socket:', !!socket);

    if (!socket || !socket.connected) {
      toast('❌ Нет соединения с сервером');
      return;
    }

    // Разблокируем AudioContext на iOS — требует user gesture
    if (audioCtx && audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    btnJoin.disabled = true;
    btnJoin.textContent = '⏳ Подключаемся…';

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation:  true,
          noiseSuppression:  true,
          autoGainControl:   true,
          sampleRate:        48000,
          channelCount:      1
        }
      });

      console.log('[voice] got localStream, tracks:', localStream.getTracks().length);

      // Инициализируем AudioContext после получения потока (user gesture уже был)
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      }
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      await requestWakeLock();
      startKeepAlive();
      setMicStatus(true);

      btnJoin.style.display  = 'none';
      btnLeave.style.display = 'block';
      btnMic.style.display   = 'block';
      joined = true;

      addParticipant(socket.id, window._currentUsername || 'Вы');
      startVolumeAnalysis(socket.id, localStream);

      socket.emit('join');

      // Создаём пиры со всеми кто уже в комнате
      for (const peerId of window._roomPeers) {
        if (peerId === socket.id) continue;
        if (!peers[peerId]) {
          addParticipant(peerId, window._peerNames.get(peerId) || peerId.slice(0,6));
          peers[peerId] = createPeer(peerId, true);
        }
      }

      // Обрабатываем накопленные офферы
      for (const { from, offer } of pendingOffers) await handleOffer(from, offer);
      pendingOffers = [];

    } catch (err) {
      console.error('[voice] getUserMedia error:', err.name, err.message);
      let msg = '❌ Ошибка доступа к микрофону';
      if (err.name === 'NotAllowedError')  msg = '❌ Нет разрешения на микрофон';
      if (err.name === 'NotFoundError')    msg = '❌ Микрофон не найден';
      if (err.name === 'NotReadableError') msg = '❌ Микрофон занят другим приложением';
      toast(msg);
      joined = false;
    } finally {
      btnJoin.disabled    = false;
      btnJoin.textContent = '🎙 Войти в голосовой';
    }
  });

  btnLeave.addEventListener('click', () => {
    if (socket) socket.emit('leave');
    hangUp();
    joined = false;
    resetVoiceUI();
    releaseWakeLock();
    stopKeepAlive();
  });

  btnMic.addEventListener('click', () => {
    micEnabled = !micEnabled;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    setMicStatus(micEnabled);
    btnMic.textContent = micEnabled ? '🔇 Выкл. микрофон' : '🎙 Вкл. микрофон';
  });
}

function createPeer(peerId, isInitiator) {
  const peer = new RTCPeerConnection(ICE_CONFIG);

  // Добавляем треки локального потока
  if (localStream) {
    localStream.getTracks().forEach(t => peer.addTrack(t, localStream));
  }

  // Получаем удалённый аудио
  peer.ontrack = event => {
    console.log('[peer] ontrack from', peerId, event.streams.length, 'streams');
    const stream = event.streams[0];
    if (!stream) return;

    let audio = el('audio-' + peerId);
    if (!audio) {
      audio           = document.createElement('audio');
      audio.id        = 'audio-' + peerId;
      audio.autoplay  = true;
      audio.setAttribute('playsinline', '');
      // Явно НЕ muted — иначе звук не слышно!
      audio.muted     = false;
      el('hidden-audios')?.appendChild(audio);
    }

    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }

    // На iOS нужен явный .play() после user gesture
    const playPromise = audio.play();
    if (playPromise) {
      playPromise
        .then(() => {
          console.log('[audio] playing from', peerId);
          startVolumeAnalysis(peerId, stream);
        })
        .catch(e => {
          console.warn('[audio] play failed:', e.name, e.message);
          // Пробуем через небольшой таймаут
          setTimeout(() => {
            audio.play()
              .then(() => startVolumeAnalysis(peerId, stream))
              .catch(() => {});
          }, 300);
        });
    }
  };

  peer.onicecandidate = e => {
    if (e.candidate && socket) {
      socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    }
  };

  peer.onconnectionstatechange = () => {
    console.log('[peer] connectionState with', peerId, ':', peer.connectionState);
    if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
      stopVolumeAnalysis(peerId);
      el('audio-' + peerId)?.remove();
    }
  };

  peer.oniceconnectionstatechange = () => {
    console.log('[peer] iceConnectionState with', peerId, ':', peer.iceConnectionState);
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer        = await peer.createOffer();
        const modifiedOffer = { type: offer.type, sdp: forceOpusQuality(offer.sdp) };
        await peer.setLocalDescription(modifiedOffer);
        socket.emit('offer', { to: peerId, offer: modifiedOffer });
      } catch(e) { console.error('[peer] onnegotiationneeded error:', e); }
    };
  }

  return peer;
}

async function handleOffer(from, offer) {
  try {
    const peer = createPeer(from, false);
    peers[from] = peer;
    addParticipant(from, window._peerNames.get(from) || from.slice(0,6));
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    const answer        = await peer.createAnswer();
    const modifiedAnswer = { type: answer.type, sdp: forceOpusQuality(answer.sdp) };
    await peer.setLocalDescription(modifiedAnswer);
    socket.emit('answer', { to: from, answer: modifiedAnswer });
  } catch(e) { console.error('[handleOffer] error:', e); }
}

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ — UI УЧАСТНИКОВ
// ═══════════════════════════════════════════════
function addParticipant(userId, label) {
  const participantsBox  = el('participants');
  const participantsList = el('participants-list');
  if (!participantsBox || !participantsList) return;
  if (el('p-' + userId)) return;  // уже есть

  participantsBox.style.display = 'block';

  const div = document.createElement('div');
  div.className = 'participant';
  div.id = 'p-' + userId;

  const isMe  = socket && userId === socket.id;
  const avatar = isMe ? null : (window._peerAvatars.get(userId) || null);
  const avatarHtml = avatar
    ? `<img src="${avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : `<div class="p-avatar-fallback">${escapeHtml(label.slice(0,1).toUpperCase())}</div>`;

  div.innerHTML = `
    <div class="p-avatar">${avatarHtml}</div>
    <span class="participant-name" style="flex:1">${escapeHtml(label)}</span>
    <div class="volume-bar-wrap"><div class="volume-bar" id="vol-${userId}"></div></div>
    ${isMe ? '' : `<button class="btn-understood" data-uid="${userId}">👍 Понял</button>`}
  `;

  participantsList.appendChild(div);

  const btn = div.querySelector('.btn-understood');
  if (btn) {
    btn.onclick = () => {
      socket?.emit('understood');
      btn.textContent = '✅ Отправлено';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = '👍 Понял'; btn.disabled = false; }, 3000);
    };
  }

  const nameEl = div.querySelector('.participant-name');
  if (nameEl && !isMe) {
    nameEl.style.cursor = 'pointer';
    nameEl.onclick = () => {
      const meta = getUserMeta(userId);
      if (window.showUserProfile) window.showUserProfile(meta);
    };
  }
}

function removeParticipant(userId) {
  el('p-' + userId)?.remove();
  const participantsBox  = el('participants');
  const participantsList = el('participants-list');
  if (participantsList && participantsBox && participantsList.children.length === 0) {
    participantsBox.style.display = 'none';
  }
}

function setMicStatus(active) {
  const statusEl = el('mic-status');
  if (!statusEl) return;
  statusEl.textContent = active ? '🟢 Микрофон включен' : '🔴 Микрофон выключен';
  statusEl.className = 'mic-status ' + (active ? 'active' : 'muted');
}

function resetVoiceUI() {
  const btnJoin  = el('btn-join');
  const btnLeave = el('btn-leave');
  const btnMic   = el('btn-mic');
  if (btnJoin)  { btnJoin.style.display  = 'block'; btnJoin.disabled = false; }
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic)   btnMic.style.display   = 'none';
  setMicStatus(false);
}

function hangUp() {
  Object.keys(analysers).forEach(id => stopVolumeAnalysis(id));
  Object.values(peers).forEach(p => { try { p.close(); } catch(_) {} });
  peers = {};

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  const hiddenAudios = el('hidden-audios');
  if (hiddenAudios) hiddenAudios.innerHTML = '';

  const participantsList = el('participants-list');
  if (participantsList) participantsList.innerHTML = '';
  const participantsBox = el('participants');
  if (participantsBox) participantsBox.style.display = 'none';

  pendingOffers = [];
  micEnabled    = true;

  if (window.stopVideo) window.stopVideo();
}

// ═══════════════════════════════════════════════
//  АНАЛИЗ ГРОМКОСТИ
// ═══════════════════════════════════════════════
function startVolumeAnalysis(userId, stream) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    stopVolumeAnalysis(userId);

    const source  = audioCtx.createMediaStreamSource(stream);
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
      const bar = el('vol-' + userId);
      if (bar) {
        bar.style.width = pct + '%';
        bar.className = 'volume-bar' + (pct > 60 ? ' loud' : '');
      }
      analysers[userId].animFrame = requestAnimationFrame(tick);
    }

    analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
  } catch(e) { console.warn('[volume]', e.message); }
}

function stopVolumeAnalysis(userId) {
  if (!analysers[userId]) return;
  cancelAnimationFrame(analysers[userId].animFrame);
  try { analysers[userId].source.disconnect(); } catch(_) {}
  delete analysers[userId];
}

function stopQualityMonitor(id) {
  if (qualityTimers[id]) { clearInterval(qualityTimers[id]); delete qualityTimers[id]; }
}

// ═══════════════════════════════════════════════
//  WAKELOCK + KEEP-ALIVE
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}
async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch(_) {} wakeLock = null; }
}

function startKeepAlive() {
  const keepAliveAudio = el('keep-alive-audio');
  if (!keepAliveAudio) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf  = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
    const src  = audioCtx.createBufferSource();
    const dest = audioCtx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true;
    src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(() => {});
  } catch(e) {}
}

function stopKeepAlive() {
  const keepAliveAudio = el('keep-alive-audio');
  if (!keepAliveAudio) return;
  keepAliveAudio.srcObject = null;
  keepAliveAudio.pause();
}

// ═══════════════════════════════════════════════
//  СИСТЕМНЫЕ ЗВУКИ
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
  } catch(e) {}
}

function playOkSound() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    [{ freq:880, start:0.00 }, { freq:1100, start:0.22 }].forEach(({ freq, start }) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.connect(gain);
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.20);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.22);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch(e) {}
}

// ═══════════════════════════════════════════════
//  ЧАТ — СООБЩЕНИЯ
// ═══════════════════════════════════════════════
function setupChatInput() {
  const chatInput = el('chat-input');
  const btnSend   = el('btn-send');
  const replyBar    = el('reply-bar');
  const replyCancel = el('reply-cancel');

  if (!chatInput) return;

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    if (!socket) return;
    if (!typingActive) {
      typingActive = true;
      socket.emit('typing', { isTyping: true });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingActive = false;
      socket.emit('typing', { isTyping: false });
    }, 800);
  });

  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
  });

  btnSend?.addEventListener('click', sendTextMessage);
  replyCancel?.addEventListener('click', () => setReplyTarget(null));
}

async function sendTextMessage() {
  const chatInput = el('chat-input');
  const btnSend   = el('btn-send');
  const text = chatInput?.value.trim();
  if (!text || !socket) return;

  if (btnSend) btnSend.disabled = true;
  try {
    if (editingMsgId) {
      const { encrypted, iv } = await Crypto.encrypt(text);
      const meta = { replyTo: replyTarget || null };
      const { encrypted: metaEnc, iv: metaIv } = await Crypto.encrypt(JSON.stringify(meta));
      socket.emit('message-edit', { msgId: editingMsgId, encrypted, iv, metaEnc, metaIv });
      const msg = messageStore.get(editingMsgId);
      if (msg) updateMessage(msg.domId, { text, editedAt: Date.now(), replyTo: replyTarget || null });
      editingMsgId = null;
      setReplyTarget(null);
      chatInput.value = ''; chatInput.style.height = 'auto';
      return;
    }

    const msgId = generateMsgId();
    const { encrypted, iv } = await Crypto.encrypt(text);
    const meta = { replyTo: replyTarget || null };
    const { encrypted: metaEnc, iv: metaIv } = await Crypto.encrypt(JSON.stringify(meta));
    socket.emit('chat-message', { msgId, encrypted, iv, metaEnc, metaIv, type: 'text' });

    appendMessage({
      from:      socket.id,
      userId:    window._currentUserId,
      msgId,
      username:  window._currentUsername || 'Вы',
      text,
      type:      'text',
      timestamp: Date.now(),
      mine:      true,
      status:    'ok',
      replyTo:   replyTarget || null
    });

    chatInput.value = ''; chatInput.style.height = 'auto';
    setReplyTarget(null);
  } catch(e) { console.error('[send]', e); }
  finally { if (btnSend) btnSend.disabled = false; }
}

function setupFileInput() {
  const fileInput = el('file-input');
  const btnPhoto  = el('btn-photo');
  const btnVideoFile = el('btn-video-file');
  const btnFile   = el('btn-file');

  btnPhoto?.addEventListener('click', () => { if (fileInput) { fileInput.accept = 'image/*'; fileInput.click(); } });
  btnVideoFile?.addEventListener('click', () => { if (fileInput) { fileInput.accept = 'video/*'; fileInput.click(); } });
  btnFile?.addEventListener('click', () => { if (fileInput) { fileInput.accept = '*/*'; fileInput.click(); } });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files[0]; if (!file) return;
    fileInput.value = '';
    if (file.size > 50 * 1024 * 1024) { toast('❌ Файл слишком большой (макс. 50 МБ)'); return; }

    if (file.type.startsWith('image/') && window.MediaEditor) {
      MediaEditor.openPhoto(file, (blob, mime, name) => sendMediaBlob(blob, mime, name, 'image'));
      return;
    }
    if (file.type.startsWith('video/') && window.MediaEditor) {
      MediaEditor.openVideo(file, (blob, mime, name) => sendMediaBlob(blob, mime, name, 'video'));
      return;
    }
    const type = file.type.startsWith('image/') ? 'image'
               : file.type.startsWith('video/') ? 'video' : 'file';
    await sendMediaBlob(file, file.type, file.name, type);
  });
}

async function sendMediaBlob(blob, mimeType, fileName, type) {
  if (!socket) return;
  try {
    const arrayBuf = await blob.arrayBuffer();
    const msgId    = generateMsgId();
    const { encrypted, iv } = await Crypto.encrypt(arrayBuf);
    const meta = { replyTo: replyTarget || null };
    const { encrypted: metaEnc, iv: metaIv } = await Crypto.encrypt(JSON.stringify(meta));
    const localUrl = URL.createObjectURL(new Blob([arrayBuf], { type: mimeType }));

    socket.emit('chat-message', { msgId, encrypted, iv, metaEnc, metaIv, type, fileName: fileName || 'file', fileSize: blob.size, mimeType });
    appendMessage({
      from:      socket.id,
      userId:    window._currentUserId,
      msgId,
      username:  window._currentUsername || 'Вы',
      type,
      localUrl,
      fileName:  fileName || 'file',
      fileSize:  blob.size,
      mimeType,
      timestamp: Date.now(),
      mine:      true,
      status:    'ok',
      replyTo:   replyTarget || null
    });
    setReplyTarget(null);
  } catch(e) { toast('❌ Ошибка отправки'); }
}

async function appendHistoryMessage(data) {
  const msgId  = data.msg_id || generateMsgId();
  const meta   = await decryptMeta(data.meta_enc, data.meta_iv);
  const isMine = data.user_id === window._currentUserId;

  if (data.deleted) {
    appendMessage({ from: isMine ? socket?.id : 'peer', userId: data.user_id, msgId, username: data.username, avatar: data.avatar, type: data.type, timestamp: data.created_at, mine: isMine, status: 'ok', deleted: true, replyTo: meta?.replyTo || null });
    return;
  }

  if (data.type === 'text') {
    try {
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      appendMessage({ from: isMine ? socket?.id : 'peer', userId: data.user_id, msgId, username: data.username, avatar: data.avatar, type: 'text', text, timestamp: data.created_at, editedAt: data.edited_at, mine: isMine, status: 'ok', replyTo: meta?.replyTo || null });
    } catch {}
  } else {
    try {
      const mime = data.mime_type || 'application/octet-stream';
      const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
      appendMessage({ from: isMine ? socket?.id : 'peer', userId: data.user_id, msgId, username: data.username, avatar: data.avatar, type: data.type, localUrl: URL.createObjectURL(blob), fileName: data.file_name, fileSize: data.file_size, mimeType: mime, timestamp: data.created_at, editedAt: data.edited_at, mine: isMine, status: 'ok', replyTo: meta?.replyTo || null });
    } catch {}
  }
}

function appendMessage(msg) {
  const chatMessages = el('chat-messages');
  if (!chatMessages) return null;

  const id  = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.id          = id;
  div.className   = 'msg ' + (msg.mine ? 'mine' : 'theirs');
  div.dataset.type  = msg.type || 'text';
  div.dataset.msgId = msg.msgId;
  div.innerHTML   = buildMsgHTML(msg);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  bindMediaEvents(div);
  bindUserEvents(div);
  bindMsgActions(div);

  messageStore.set(msg.msgId, {
    domId:    id,
    mine:     msg.mine,
    text:     msg.text  || '',
    type:     msg.type,
    userId:   msg.userId,
    username: msg.username
  });

  return id;
}

function updateMessage(id, updates) {
  const div = el(id); if (!div) return;
  const content = div.querySelector('.msg-content');
  if (content) {
    content.innerHTML = buildContentHTML({ type: div.dataset.type, ...updates });
    bindMediaEvents(div);
  }
  const statusEl = div.querySelector('.msg-decrypt-status');
  if (statusEl) {
    if (updates.status === 'ok')    { statusEl.className = 'msg-decrypt-status ok';  statusEl.textContent = '🔓 расшифровано'; }
    if (updates.status === 'error') { statusEl.className = 'msg-decrypt-status err'; statusEl.textContent = '⚠️ ошибка'; }
  }
  if (updates.editedAt) {
    const metaEl = div.querySelector('.msg-meta');
    if (metaEl && !metaEl.querySelector('.msg-edited')) {
      metaEl.innerHTML += ' <span class="msg-edited">(изменено)</span>';
    }
  }
  const chatMessages = el('chat-messages');
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function markMessageDeleted(domId) {
  const div = el(domId); if (!div) return;
  div.classList.add('deleted');
  const content = div.querySelector('.msg-content');
  if (content) content.innerHTML = '<i>Сообщение удалено</i>';
}

function buildMsgHTML(msg) {
  const time       = new Date(msg.timestamp || Date.now()).toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });
  const avatarHtml = msg.avatar
    ? `<img class="msg-avatar-img" src="${msg.avatar}" alt="">`
    : `<div class="msg-avatar-fallback">${escapeHtml((msg.username||'?').slice(0,1).toUpperCase())}</div>`;
  const senderHtml = msg.mine ? '' :
    `<div class="msg-sender" data-socketid="${escapeHtml(msg.from||'')}">
       <div class="msg-avatar">${avatarHtml}</div>
       <span>${escapeHtml(msg.username||'??')}</span>
     </div>`;
  const statusText = msg.status==='ok' ? '🔓 расшифровано' : msg.status==='error' ? '⚠️ ошибка' : '⏳ расшифровываем…';
  const statusHtml = msg.mine ? '' : `<div class="msg-decrypt-status ${msg.status==='ok'?'ok':''}">${statusText}</div>`;
  const editedHtml = msg.editedAt ? ' <span class="msg-edited">(изменено)</span>' : '';
  return `${senderHtml}${buildReplyHTML(msg.replyTo)}<div class="msg-content">${buildContentHTML(msg)}</div><div class="msg-meta">${time}${editedHtml}</div>${statusHtml}${buildReactionsHTML(msg.msgId)}`;
}

function buildReplyHTML(replyTo) {
  if (!replyTo) return '';
  return `<div class="msg-reply"><span>Ответ:</span> ${escapeHtml(replyTo.preview || 'Ответ')}</div>`;
}

function buildContentHTML(msg) {
  if (msg.deleted) return '<i>Сообщение удалено</i>';
  if (msg.type === 'text') return escapeHtml(msg.text || '');
  if (msg.type === 'image') return msg.localUrl
    ? `<img class="msg-media" src="${msg.localUrl}" alt="фото">`
    : '<span>⏳</span>';
  if (msg.type === 'video') return msg.localUrl
    ? `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>`
    : '<span>⏳</span>';
  if (msg.type === 'file') {
    if (msg.localUrl) return `
      <div class="msg-file">
        <span class="msg-file-icon">📄</span>
        <div class="msg-file-info">
          <div class="msg-file-name">${escapeHtml(msg.fileName || 'файл')}</div>
          <div class="msg-file-size">${formatSize(msg.fileSize || 0)}</div>
        </div>
        <a class="msg-file-dl" href="${msg.localUrl}" download="${escapeHtml(msg.fileName || 'file')}">⬇️</a>
      </div>`;
    return '<div class="msg-file">⏳ Загрузка...</div>';
  }
  return '';
}

function buildReactionsHTML(msgId) {
  return `<div class="msg-reactions" data-msgid="${msgId}"></div>`;
}

function bindMediaEvents(container) {
  container.querySelectorAll('img.msg-media').forEach(img => {
    img.onclick = () => openLightbox('img', img.src);
  });
  container.querySelectorAll('video.msg-media').forEach(vid => {
    vid.ondblclick = () => openLightbox('video', vid.src);
  });
}

function bindUserEvents(container) {
  container.querySelectorAll('.msg-sender').forEach(el => {
    el.onclick = () => {
      const socketId = el.dataset.socketid;
      if (!socketId) return;
      if (window.showUserProfile) window.showUserProfile(getUserMeta(socketId));
    };
  });
}

function bindMsgActions(container) {
  container.addEventListener('contextmenu', e => {
    e.preventDefault();
    const msgId = container.dataset.msgId;
    if (msgId) openMsgMenu(e.clientX, e.clientY, msgId);
  });
  // Долгое нажатие для мобильных
  let longPressTimer = null;
  container.addEventListener('touchstart', e => {
    longPressTimer = setTimeout(() => {
      const msgId = container.dataset.msgId;
      if (msgId) openMsgMenu(e.touches[0].clientX, e.touches[0].clientY, msgId);
    }, 500);
  }, { passive: true });
  container.addEventListener('touchend', () => clearTimeout(longPressTimer));
  container.addEventListener('touchmove', () => clearTimeout(longPressTimer));
}

function openMsgMenu(x, y, msgId) {
  const msgMenuEl = el('msg-menu');
  const msg = messageStore.get(msgId);
  if (!msg || !msgMenuEl) return;

  // Позиционируем в пределах экрана
  const menuW = 170, menuH = 220;
  const left  = Math.min(x, window.innerWidth  - menuW - 10);
  const top   = Math.min(y, window.innerHeight - menuH - 10);

  msgMenuEl.style.display = 'block';
  msgMenuEl.style.left    = left + 'px';
  msgMenuEl.style.top     = top  + 'px';

  msgMenuEl.querySelector('[data-action="reply"]').onclick = () => {
    setReplyTarget({ id: msgId, preview: (msg.text || '').slice(0, 80) });
    closeMsgMenu();
  };

  msgMenuEl.querySelector('[data-action="copy"]').onclick = () => {
    if (msg.text) navigator.clipboard?.writeText(msg.text);
    closeMsgMenu();
  };

  const editItem   = msgMenuEl.querySelector('[data-action="edit"]');
  const deleteItem = msgMenuEl.querySelector('[data-action="delete"]');
  editItem.style.display   = msg.mine ? 'block' : 'none';
  deleteItem.style.display = msg.mine ? 'block' : 'none';

  editItem.onclick = () => {
    if (!msg.text) return;
    const chatInput = el('chat-input');
    if (chatInput) { chatInput.value = msg.text; chatInput.focus(); }
    editingMsgId = msgId;
    closeMsgMenu();
  };

  deleteItem.onclick = () => {
    socket?.emit('message-delete', { msgId });
    markMessageDeleted(msg.domId);
    closeMsgMenu();
  };

  msgMenuEl.querySelector('[data-action="pin"]').onclick = () => {
    socket?.emit('pin-message', { msgId });
    closeMsgMenu();
  };

  msgMenuEl.querySelector('[data-action="react"]').onclick = () => {
    openReactionPicker(x, y, msgId);
    closeMsgMenu();
  };
}

function closeMsgMenu() {
  const msgMenuEl = el('msg-menu');
  if (msgMenuEl) msgMenuEl.style.display = 'none';
}

function openReactionPicker(x, y, msgId) {
  const picker = el('reaction-picker');
  if (!picker) return;
  picker.style.display = 'flex';
  picker.style.left    = x + 'px';
  picker.style.top     = (y - 56) + 'px';
  picker.querySelectorAll('.reaction-item').forEach(item => {
    item.onclick = () => {
      toggleReactionLocal(msgId, item.textContent, window._currentUserId || 'me');
      socket?.emit('reaction-toggle', { msgId, emoji: item.textContent });
      picker.style.display = 'none';
    };
  });
}

function toggleReactionLocal(msgId, emoji, userId) {
  const box = document.querySelector(`.msg-reactions[data-msgid="${msgId}"]`);
  if (!box) return;
  let chip = box.querySelector(`[data-emoji="${emoji}"]`);
  if (!chip) {
    chip = document.createElement('span');
    chip.className    = 'reaction-chip';
    chip.dataset.emoji = emoji;
    chip.dataset.users = JSON.stringify([userId]);
    chip.textContent  = `${emoji} 1`;
    box.appendChild(chip);
  } else {
    let users = JSON.parse(chip.dataset.users || '[]');
    users = users.includes(userId)
      ? users.filter(u => u !== userId)
      : [...users, userId];
    chip.dataset.users = JSON.stringify(users);
    if (users.length === 0) chip.remove();
    else chip.textContent = `${emoji} ${users.length}`;
  }
}

function setReplyTarget(target) {
  replyTarget = target;
  const replyBar  = el('reply-bar');
  const replyText = el('reply-text');
  if (!target) {
    if (replyBar)  replyBar.style.display  = 'none';
    if (replyText) replyText.textContent   = '';
    return;
  }
  if (replyBar)  replyBar.style.display  = 'flex';
  if (replyText) replyText.textContent   = target.preview || 'Ответ';
}

function updateTyping(username, isTyping) {
  if (isTyping) typingSet.add(username);
  else typingSet.delete(username);
  const indicator = el('typing-indicator');
  if (!indicator) return;
  if (typingSet.size === 0) {
    indicator.textContent    = '';
    indicator.style.display  = 'none';
  } else {
    indicator.textContent    = Array.from(typingSet).join(', ') + ' печатает...';
    indicator.style.display  = 'block';
  }
}

function updatePinnedBanner(msgId) {
  const banner = el('pinned-banner');
  if (!banner) return;
  if (!msgId) { banner.style.display = 'none'; banner.textContent = ''; return; }
  const msg  = messageStore.get(msgId);
  const text = msg?.text ? msg.text.slice(0, 80) : 'Закреплено сообщение';
  banner.textContent    = '📌 ' + text;
  banner.style.display  = 'block';
  banner.onclick = () => {
    if (msg?.domId) el(msg.domId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}

function openLightbox(type, src) {
  const lightbox        = el('lightbox');
  const lightboxContent = el('lightbox-content');
  if (!lightbox || !lightboxContent) return;
  lightboxContent.innerHTML = type === 'img'
    ? `<img src="${src}" alt="">`
    : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}

// ═══════════════════════════════════════════════
//  ИНИЦИАЛИЗАЦИЯ
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  setupVoiceButtons();
  setupChatInput();
  setupFileInput();

  // Закрытие меню по клику вне
  document.addEventListener('click', () => {
    closeMsgMenu();
    el('reaction-picker') && (el('reaction-picker').style.display = 'none');
  });
});

window.initSocket  = initSocket;
window.socketLeave = socketLeave;
