const socket = io({
  reconnection:           true,
  reconnectionAttempts:   Infinity,
  reconnectionDelay:      1000,
  reconnectionDelayMax:   5000,
  timeout:                20000,
  transports:             ['websocket', 'polling'],
});

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
const analysers     = {};
const qualityTimers = {};

// WakeLock — не даёт телефону гасить экран (Chrome Android)
let wakeLock = null;

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
//  WAKELOCK — не даём телефону заморозить вкладку
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    log('WakeLock API not supported');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('WakeLock acquired');
    wakeLock.addEventListener('release', () => {
      log('WakeLock released');
    });
  } catch (e) {
    log('WakeLock error: ' + e.message);
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (_) {}
    wakeLock = null;
    log('WakeLock released manually');
  }
}

// ═══════════════════════════════════════════════
//  KEEP-ALIVE AUDIO — держит аудио-сессию на iOS
//  Воспроизводим тихий (нулевой) аудио-буфер
// ═══════════════════════════════════════════════
function startKeepAlive() {
  try {
    // Создаём тишину через AudioContext и подаём в audio-элемент
    const ctx         = new (window.AudioContext || window.webkitAudioContext)();
    const buffer      = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const source      = ctx.createBufferSource();
    const dest        = ctx.createMediaStreamDestination();

    source.buffer = buffer;
    source.loop   = true;
    source.connect(dest);
    source.start();

    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(e => log('KeepAlive play error: ' + e.message));
    log('KeepAlive audio started');
  } catch (e) {
    log('KeepAlive error: ' + e.message);
  }
}

function stopKeepAlive() {
  keepAliveAudio.srcObject = null;
  keepAliveAudio.pause();
}

// ═══════════════════════════════════════════════
//  ВОССТАНОВЛЕНИЕ ТРЕКА ПРИ БЛОКИРОВКЕ ЭКРАНА
// ═══════════════════════════════════════════════
document.addEventListener('visibilitychange', async () => {
  log('Visibility: ' + document.visibilityState);

  if (document.visibilityState === 'visible' && joined && localStream) {

    // Переполучаем WakeLock — он снимается когда экран гас
    await requestWakeLock();

    // Проверяем треки — на iOS они могут стать "ended" после блокировки
    const audioTracks = localStream.getAudioTracks();
    const allDead     = audioTracks.every(t => t.readyState === 'ended');

    if (allDead) {
      log('Tracks ended after screen lock — reacquiring mic...');
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
        log('Got new track: ' + newTrack.label);

        // Заменяем трек во всех peers
        for (const [userId, peer] of Object.entries(peers)) {
          const sender = peer.getSenders().find(s => s.track?.kind === 'audio');
          if (sender) {
            await sender.replaceTrack(newTrack);
            log('Replaced track for peer ' + userId);
          }
        }

        // Заменяем в localStream
        audioTracks.forEach(t => { localStream.removeTrack(t); t.stop(); });
        localStream.addTrack(newTrack);

        // Обновляем анализ громкости
        stopVolumeAnalysis(socket.id);
        startVolumeAnalysis(socket.id, localStream);

        // Восстанавливаем состояние mute
        newTrack.enabled = micEnabled;

        log('Mic restored after screen lock');
      } catch (e) {
        log('Failed to restore mic: ' + e.message);
      }
    } else {
      // Треки живые — просто убеждаемся что enabled правильный
      audioTracks.forEach(t => { t.enabled = micEnabled; });
      log('Tracks alive, enabled=' + micEnabled);
    }

    // AudioContext может быть suspended после блокировки
    if (audioCtx && audioCtx.state === 'suspended') {
      await audioCtx.resume();
      log('AudioContext resumed');
    }
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
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
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

// Для удалённых пиров — смотрим inbound-rtp
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
      if (r.type === 'candidate-pair' && r.state === 'succeeded') {
        if (r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
      }
    });

    return calcLevel(rtt, lost, received, jitter);
  } catch (e) {
    log('getStats error: ' + e.message);
    return 'none';
  }
}

// Для себя — смотрим outbound-rtp и remote-inbound-rtp (RTT исходящего потока)
async function measureLocalQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lost = 0, sent = 0, jitter = 0;

    stats.forEach(r => {
      // remote-inbound-rtp содержит RTT и потери с точки зрения получателя
      if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
        lost   = r.packetsLost    || 0;
        jitter = r.jitter         || 0;
        if (r.roundTripTime != null) rtt = r.roundTripTime * 1000;
      }
      if (r.type === 'outbound-rtp' && r.kind === 'audio') {
        sent = r.packetsSent || 0;
      }
    });

    return calcLevel(rtt, lost, sent, jitter);
  } catch (e) {
    return 'none';
  }
}

function calcLevel(rtt, lost, total, jitter) {
  if (rtt === null) return 'none';
  const lossRate = (lost + total) > 0 ? lost / (lost + total) : 0;
  if (rtt < 80  && lossRate < 0.02 && jitter < 0.02) return 'excellent';
  if (rtt < 150 && lossRate < 0.05 && jitter < 0.05) return 'good';
  if (rtt < 300 && lossRate < 0.10 && jitter < 0.10) return 'fair';
  return 'poor';
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
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
    </div>
  `;
  participantsList.appendChild(div);
}

function removeParticipant(userId) {
  const el = document.getElementById('p-' + userId);
  if (el) el.remove();
  if (participantsList.children.length === 0) {
    participantsBox.style.display = 'none';
  }
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
//  SOCKET
// ═══════════════════════════════════════════════
socket.on('connect', () => {
  log('Socket connected: ' + socket.id);
  reconnectBanner.classList.remove('visible');
  if (joined && localStream) {
    log('Rejoining after reconnect...');
    socket.emit('join');
  }
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
//  КНОПКИ
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

    // Запускаем механизмы удержания сессии
    await requestWakeLock();
    startKeepAlive();

    setMicStatus(true);
    btnJoin.style.display     = 'none';
    btnLeave.style.display    = 'block';
    btnMic.style.display      = 'block';
    secureBadge.style.display = 'inline-flex';
    joined = true;

    // Добавляем себя в список с шкалой сигнала
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
  log('Leave clicked');
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
  log('Sent answer to ' + from);
}

socket.on('answer', async ({ from, answer }) => {
  log('Got answer from ' + from);
  const peer = peers[from];
  if (peer && peer.signalingState === 'have-local-offer') {
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
      // Запускаем мониторинг: для первого пира меряем свою связь
      const isFirstPeer = Object.keys(peers).length === 1;
      if (isFirstPeer) {
        // Шкала для себя — через outbound/remote-inbound этого пира
        startQualityMonitor(socket.id, peer, true);
      }
      // Шкала для удалённого участника
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
      audio.setAttribute('playsinline', '');
      audio.setAttribute('webkit-playsinline', '');
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
    if (peer.iceConnectionState === 'failed') {
      log('ICE failed, restarting...');
      peer.restartIce();
    }
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

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }

  hiddenAudios.innerHTML     = '';
  pendingOffers              = [];
  participantsList.innerHTML = '';
  participantsBox.style.display = 'none';
}
