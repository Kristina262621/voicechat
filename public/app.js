const socket = io({
  reconnection:         true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:    1000,
  reconnectionDelayMax: 5000,
  timeout:              20000,
  transports:           ['websocket', 'polling'],
  // Не подключаемся автоматически — ждём пока пройдёт auth
  autoConnect:          false,
});

// ── DOM ──
const screenPassword   = document.getElementById('screen-password');
const screenChat       = document.getElementById('screen-chat');
const pwInput          = document.getElementById('pw-input');
const pwError          = document.getElementById('pw-error');
const btnEnter         = document.getElementById('btn-enter');
const btnTogglePw      = document.getElementById('btn-toggle-pw');
const btnJoin          = document.getElementById('btn-join');
const btnLeave         = document.getElementById('btn-leave');
const btnMic           = document.getElementById('btn-mic');
const userCount        = document.getElementById('user-count');
const micStatus        = document.getElementById('mic-status');
const hiddenAudios     = document.getElementById('hidden-audios');
const participantsBox  = document.getElementById('participants');
const participantsList = document.getElementById('participants-list');
const reconnectBanner  = document.getElementById('reconnect-banner');
const secureBadge      = document.getElementById('secure-badge');
const keepAliveAudio   = document.getElementById('keep-alive-audio');

let localStream     = null;
let peers           = {};
let micEnabled      = true;
let pendingOffers   = [];
let joined          = false;
let audioCtx        = null;
let wakeLock        = null;
let savedPassword   = '';        // держим в памяти для реконнекта
const analysers     = {};
const qualityTimers = {};

// ═══════════════════════════════════════════════
//  ЛОГ
// ═══════════════════════════════════════════════
function log(msg) {
  console.log(msg);
  let logBox = document.getElementById('log-box');
  if (!logBox) {
    logBox = document.createElement('div');
    logBox.id = 'log-box';
    logBox.style.cssText = `
      position:fixed;bottom:0;left:0;right:0;
      background:rgba(0,0,0,0.85);color:#0f0;
      font-size:11px;font-family:monospace;
      padding:8px;max-height:40vh;overflow-y:auto;z-index:9999;
    `;
    document.body.appendChild(logBox);
  }
  const line = document.createElement('div');
  line.textContent = new Date().toISOString().slice(11, 19) + ' ' + msg;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

// ═══════════════════════════════════════════════
//  ЭКРАН ПАРОЛЯ
// ═══════════════════════════════════════════════

// Показать/скрыть пароль
btnTogglePw.addEventListener('click', () => {
  const isText = pwInput.type === 'text';
  pwInput.type       = isText ? 'password' : 'text';
  btnTogglePw.textContent = isText ? '👁' : '🙈';
});

// Enter в поле пароля
pwInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptEnter();
});

btnEnter.addEventListener('click', attemptEnter);

async function attemptEnter() {
  const pw = pwInput.value.trim();
  if (!pw) {
    showPwError('Введи пароль');
    return;
  }

  btnEnter.disabled      = true;
  btnEnter.textContent   = '⏳ Проверяем…';
  pwError.textContent    = '';

  try {
    const res  = await fetch('/auth', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: pw })
    });
    const data = await res.json();

    if (data.ok) {
      savedPassword = pw;
      enterChat();
    } else {
      showPwError('❌ Неверный пароль');
      pwInput.classList.add('error');
      setTimeout(() => pwInput.classList.remove('error'), 400);
    }
  } catch (e) {
    showPwError('⚠️ Ошибка соединения с сервером');
    log('Auth fetch error: ' + e.message);
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
  screenChat.style.display     = 'block';

  // Подключаем socket только после успешной авторизации
  socket.connect();
}

// ═══════════════════════════════════════════════
//  WAKELOCK
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('WakeLock acquired');
    wakeLock.addEventListener('release', () => log('WakeLock released'));
  } catch (e) { log('WakeLock error: ' + e.message); }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }
}

// ═══════════════════════════════════════════════
//  KEEP-ALIVE AUDIO (iOS)
// ═══════════════════════════════════════════════
function startKeepAlive() {
  try {
    const ctx    = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const source = ctx.createBufferSource();
    const dest   = ctx.createMediaStreamDestination();
    source.buffer = buffer;
    source.loop   = true;
    source.connect(dest);
    source.start();
    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(e => log('KeepAlive error: ' + e.message));
    log('KeepAlive started');
  } catch (e) { log('KeepAlive init error: ' + e.message); }
}

function stopKeepAlive() {
  keepAliveAudio.srcObject = null;
  keepAliveAudio.pause();
}

// ═══════════════════════════════════════════════
//  ВОССТАНОВЛЕНИЕ ПОСЛЕ БЛОКИРОВКИ ЭКРАНА
// ═══════════════════════════════════════════════
document.addEventListener('visibilitychange', async () => {
  log('Visibility: ' + document.visibilityState);
  if (document.visibilityState !== 'visible' || !joined || !localStream) return;

  await requestWakeLock();

  const audioTracks = localStream.getAudioTracks();
  const allDead     = audioTracks.every(t => t.readyState === 'ended');

  if (allDead) {
    log('Tracks ended — reacquiring mic...');
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          sampleRate:       48000,
          sampleSize:       16,
          channelCount:     2,
          latency:          0,
        }
      });

      const newTrack = newStream.getAudioTracks()[0];

      for (const [userId, peer] of Object.entries(peers)) {
        const sender = peer.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) {
          await sender.replaceTrack(newTrack);
          log('Replaced track for ' + userId);
        }
      }

      audioTracks.forEach(t => { localStream.removeTrack(t); t.stop(); });
      localStream.addTrack(newTrack);

      stopVolumeAnalysis(socket.id);
      startVolumeAnalysis(socket.id, localStream);
      newTrack.enabled = micEnabled;
      log('Mic restored');
    } catch (e) {
      log('Failed to restore mic: ' + e.message);
    }
  } else {
    audioTracks.forEach(t => { t.enabled = micEnabled; });
  }

  if (audioCtx?.state === 'suspended') {
    await audioCtx.resume();
    log('AudioContext resumed');
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
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    if (type === 'join') {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.setValueAtTime(900, ctx.currentTime + 0.12);
    } else {
      osc.frequency.setValueAtTime(900, ctx.currentTime);
      osc.frequency.setValueAtTime(500, ctx.currentTime + 0.12);
    }
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close();
  } catch (e) { log('Beep error: ' + e.message); }
}

// ═══════════════════════════════════════════════
//  ICE
// ═══════════════════════════════════════════════
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls:       'turn:openrelay.metered.ca:80',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443?transport=tcp',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// ═══════════════════════════════════════════════
//  SDP
// ═══════════════════════════════════════════════
function forceOpusMaxQuality(sdp) {
  const lines  = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[1].split(' ')[0];
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) i++;
      result.push(
        `a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000`
      );
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

// ═══════════════════════════════════════════════
//  ШКАЛА КАЧЕСТВА
// ═══════════════════════════════════════════════
function renderSignal(userId, level) {
  const wrap = document.getElementById('sig-' + userId);
  if (!wrap) return;
  wrap.className = 'signal-wrap signal-' + level;
}

function calcLevel(rtt, lost, total, jitter) {
  if (rtt === null) return 'none';
  const lossRate = (lost + total) > 0 ? lost / (lost + total) : 0;
  if (rtt < 80  && lossRate < 0.02 && jitter < 0.02) return 'excellent';
  if (rtt < 150 && lossRate < 0.05 && jitter < 0.05) return 'good';
  if (rtt < 300 && lossRate < 0.10 && jitter < 0.10) return 'fair';
  return 'poor';
}

async function measureRemoteQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lost = 0, received = 0, jitter = 0;
    stats.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        lost = r.packetsLost || 0; received = r.packetsReceived || 0; jitter = r.jitter || 0;
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
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
        lost = r.packetsLost || 0; jitter = r.jitter || 0;
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
  if (qualityTimers[userId]) { clearInterval(qualityTimers[userId]); delete qualityTimers[userId]; }
}

// ═══════════════════════════════════════════════
//  УЧАСТНИКИ UI
// ═══════════════════════════════════════════════
function shortId(id) { return id.slice(0, 6); }

function addParticipant(userId, label) {
  if (document.getElementById('p-' + userId)) return;
  participantsBox.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'participant';
  div.id = 'p-' + userId;
  div.innerHTML = `
    <span class="participant-name">${label}</span>
    <div class="volume-bar-wrap">
      <div class="volume-bar" id="vol-${userId}"></div>
    </div>
    <div class="signal-wrap signal-none" id="sig-${userId}">
      <div class="bar"></div><div class="bar"></div>
      <div class="bar"></div><div class="bar"></div>
    </div>
  `;
  participantsList.appendChild(div);
}

function removeParticipant(userId) {
  const el = document.getElementById('p-' + userId);
  if (el) el.remove();
  if (participantsList.children.length === 0) participantsBox.style.display = 'none';
}

// ═══════════════════════════════════════════════
//  ГРОМКОСТЬ
// ═══════════════════════════════════════════════
function startVolumeAnalysis(userId, stream) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  }
  stopVolumeAnalysis(userId);
  const source   = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    if (!analysers[userId]) return;
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const pct = Math.min(100, (sum / dataArray.length) * 3);
    const bar = document.getElementById('vol-' + userId);
    if (bar) {
      bar.style.width = pct + '%';
      bar.className   = 'volume-bar' + (pct > 60 ? ' loud' : '');
    }
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
//  SOCKET СОБЫТИЯ
// ═══════════════════════════════════════════════
socket.on('connect', () => {
  log('Socket connected: ' + socket.id);
  reconnectBanner.classList.remove('visible');

  // При каждом (пере)подключении аутентифицируемся через socket
  socket.emit('authenticate', savedPassword);
});

socket.on('auth-ok', () => {
  log('Socket auth OK');
  // Если были в чате — переподключаемся
  if (joined && localStream) {
    log('Rejoining after reconnect...');
    socket.emit('join');
  }
});

socket.on('auth-fail', () => {
  log('Socket auth FAILED — возвращаем на экран пароля');
  savedPassword = '';
  screenPassword.style.display = 'block';
  screenChat.style.display     = 'none';
  showPwError('❌ Сессия истекла, войди заново');
  hangUp();
  joined = false;
});

socket.on('disconnect', (reason) => {
  log('Socket disconnected: ' + reason);
  if (joined) reconnectBanner.classList.add('visible');
});

socket.on('reconnect_attempt', n => log('Reconnect attempt #' + n));

socket.on('reconnect', () => {
  log('Reconnected!');
  reconnectBanner.classList.remove('visible');
});

socket.on('user-count', count => { userCount.textContent = count; });

// ═══════════════════════════════════════════════
//  КНОПКИ ЧАТА
// ═══════════════════════════════════════════════
btnJoin.addEventListener('click', async () => {
  log('Join clicked');
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
        latency:          0,
        volume:           1.0
      }
    });

    localStream.getAudioTracks().forEach(t =>
      log('Track: ' + t.label + ' ' + JSON.stringify(t.getSettings()))
    );

    await requestWakeLock();
    startKeepAlive();

    setMicStatus(true);
    btnJoin.style.display     = 'none';
    btnLeave.style.display    = 'block';
    btnMic.style.display      = 'block';
    secureBadge.style.display = 'inline-flex';
    joined = true;

    addParticipant(socket.id, '🟢 Вы (' + shortId(socket.id) + ')');
    startVolumeAnalysis(socket.id, localStream);

    socket.emit('join');

    for (const { from, offer } of pendingOffers) await handleOffer(from, offer);
    pendingOffers = [];

  } catch (err) {
    log('MIC ERROR: ' + err.name + ' - ' + err.message);
    const msgs = {
      NotAllowedError:       '❌ Доступ к микрофону запрещён.\n\nРазреши микрофон в настройках браузера.',
      PermissionDeniedError: '❌ Доступ к микрофону запрещён.',
      NotFoundError:         '❌ Микрофон не найден.',
      NotReadableError:      '❌ Микрофон занят другим приложением.'
    };
    alert(msgs[err.name] || ('❌ Ошибка: ' + err.name + ' — ' + err.message));
  }
});

btnLeave.addEventListener('click', () => {
  socket.emit('leave');
  hangUp();
  joined = false;
  btnJoin.style.display     = 'block';
  btnLeave.style.display    = 'none';
  btnMic.style.display      = 'none';
  secureBadge.style.display = 'none';
  reconnectBanner.classList.remove('visible');
  micStatus.className   = 'mic-status';
  micStatus.textContent = '';
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
//  WebRTC СОБЫТИЯ
// ═══════════════════════════════════════════════
socket.on('existing-users', async (userIds) => {
  log('Existing users: ' + JSON.stringify(userIds));
  for (const userId of userIds) {
    addParticipant(userId, '👤 ' + shortId(userId));
    peers[userId] = createPeer(userId, true);
  }
});

socket.on('user-joined', (userId) => {
  log('User joined: ' + userId);
  playBeep('join');
  addParticipant(userId, '👤 ' + shortId(userId));
});

socket.on('offer', async ({ from, offer }) => {
  log('Got offer from ' + from);
  if (!localStream) { pendingOffers.push({ from, offer }); return; }
  await handleOffer(from, offer);
});

async function handleOffer(from, offer) {
  log('Handling offer from ' + from);
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
  if (peer?.signalingState === 'have-local-offer') {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) {
    try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { log('ICE error: ' + e.message); }
  }
});

socket.on('user-left', (userId) => {
  log('User left: ' + userId);
  playBeep('leave');
  removeParticipant(userId);
  stopVolumeAnalysis(userId);
  stopQualityMonitor(userId);
  if (peers[userId]) { peers[userId].close(); delete peers[userId]; }
  const audio = document.getElementById('audio-' + userId);
  if (audio) audio.remove();
});

// ═══════════════════════════════════════════════
//  СОЗДАНИЕ PEER
// ═══════════════════════════════════════════════
function createPeer(userId, isInitiator) {
  log('Creating peer for ' + userId + ' init=' + isInitiator);
  const peer = new RTCPeerConnection(iceServers);

  localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

  peer.getSenders().forEach(sender => {
    if (sender.track?.kind === 'audio') {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate      = 510000;
      params.encodings[0].priority        = 'high';
      params.encodings[0].networkPriority = 'high';
      sender.setParameters(params).catch(e => log('setParams: ' + e.message));
    }
  });

  peer.addEventListener('connectionstatechange', () => {
    log('Peer ' + userId + ' state: ' + peer.connectionState);
    if (peer.connectionState === 'connected') {
      const isFirstPeer = Object.keys(peers).length === 1;
      if (isFirstPeer) startQualityMonitor(socket.id, peer, true);
      startQualityMonitor(userId, peer, false);
    }
    if (peer.connectionState === 'failed') {
      log('Connection failed, restarting ICE...');
      peer.restartIce();
    }
  });

  peer.ontrack = (event) => {
    log('Got remote track from ' + userId);
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id          = 'audio-' + userId;
      audio.autoplay    = true;
      audio.playsInline = true;
      audio.muted       = false;
      hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play()
      .then(() => {
        log('Audio playing for ' + userId);
        startVolumeAnalysis(userId, event.streams[0]);
      })
      .catch(e => log('Autoplay BLOCKED: ' + e.message));
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: userId, candidate: event.candidate });
    }
  };

  peer.oniceconnectionstatechange = () => {
    log('Peer ' + userId + ' ICE: ' + peer.iceConnectionState);
    if (peer.iceConnectionState === 'failed') peer.restartIce();
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer    = await peer.createOffer();
        const improved = { type: offer.type, sdp: forceOpusMaxQuality(offer.sdp) };
        await peer.setLocalDescription(improved);
        socket.emit('offer', { to: userId, offer: improved });
        log('Sent offer to ' + userId);
      } catch (e) { log('Offer error: ' + e.message); }
    };
  }

  return peer;
}

// ═══════════════════════════════════════════════
//  ЗАВЕРШЕНИЕ
// ═══════════════════════════════════════════════
function hangUp() {
  log('Hanging up');
  Object.keys(analysers).forEach(id => stopVolumeAnalysis(id));
  Object.keys(qualityTimers).forEach(id => stopQualityMonitor(id));
  Object.values(peers).forEach(p => p.close());
  peers = {};
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (audioCtx)    { audioCtx.close(); audioCtx = null; }
  hiddenAudios.innerHTML     = '';
  pendingOffers              = [];
  participantsList.innerHTML = '';
  participantsBox.style.display = 'none';
}
