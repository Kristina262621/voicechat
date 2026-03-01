const socket = io();

const btnJoin          = document.getElementById('btn-join');
const btnLeave         = document.getElementById('btn-leave');
const btnMic           = document.getElementById('btn-mic');
const userCount        = document.getElementById('user-count');
const micStatus        = document.getElementById('mic-status');
const hiddenAudios     = document.getElementById('hidden-audios');
const participantsBox  = document.getElementById('participants');
const participantsList = document.getElementById('participants-list');

let localStream   = null;
let peers         = {};
let micEnabled    = true;
let pendingOffers = [];
let joined        = false;
let audioCtx      = null;
const analysers   = {};

// ───── Лог ─────
function log(msg) {
  console.log(msg);
  let logBox = document.getElementById('log-box');
  if (!logBox) {
    logBox = document.createElement('div');
    logBox.id = 'log-box';
    logBox.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0;
      background: rgba(0,0,0,0.85); color: #0f0;
      font-size: 11px; font-family: monospace;
      padding: 8px; max-height: 40vh; overflow-y: auto;
      z-index: 9999;
    `;
    document.body.appendChild(logBox);
  }
  const line = document.createElement('div');
  line.textContent = new Date().toISOString().slice(11, 19) + ' ' + msg;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

// ───── Звуки входа / выхода ─────
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
  } catch (e) {
    log('Beep error: ' + e.message);
  }
}

// ───── ICE серверы ─────
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

// ───── SDP: форсируем Opus с максимальным битрейтом ─────
function forceOpusMaxQuality(sdp) {
  const lines = sdp.split('\r\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Находим payload type для opus
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);

      // Ищем следующую fmtp строку для opus и заменяем/добавляем параметры
      const pt = line.split(':')[1].split(' ')[0];

      // Удаляем старую fmtp если есть
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) {
        i++; // пропускаем старую
      }

      // Вставляем улучшенную fmtp
      result.push(
        `a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000`
      );
      continue;
    }

    // Убираем старые ограничения битрейта
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) {
      continue;
    }

    result.push(line);
  }

  return result.join('\r\n');
}

// ───── Участники UI ─────
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

// ───── Анализ громкости (только analyser, не destination) ─────
function startVolumeAnalysis(userId, stream) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
  }

  stopVolumeAnalysis(userId);

  const source   = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  // НЕ подключаем к destination

  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    if (!analysers[userId]) return;
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const avg = sum / dataArray.length;
    const pct = Math.min(100, avg * 3);
    const bar = document.getElementById('vol-' + userId);
    if (bar) {
      bar.style.width = pct + '%';
      bar.className   = 'volume-bar' + (pct > 60 ? ' loud' : '');
    }
    analysers[userId].animFrame = requestAnimationFrame(tick);
  }

  analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
  log('Volume analysis started for ' + userId);
}

function stopVolumeAnalysis(userId) {
  if (analysers[userId]) {
    cancelAnimationFrame(analysers[userId].animFrame);
    try { analysers[userId].source.disconnect(); } catch (_) {}
    delete analysers[userId];
  }
}

// ───── Socket ─────
socket.on('connect', () => log('Socket connected: ' + socket.id));
socket.on('disconnect', () => log('Socket disconnected'));
socket.on('user-count', (count) => {
  userCount.textContent = count;
  log('User count: ' + count);
});

// ───── Кнопки ─────
btnJoin.addEventListener('click', async () => {
  log('Join clicked');
  try {
    log('Requesting microphone...');
    localStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,       // подавление эха
        noiseSuppression: true,       // подавление шума
        autoGainControl: true,        // автоусиление
        sampleRate: 48000,            // 48 кГц — стандарт Opus
        sampleSize: 16,               // 16 бит
        channelCount: 2,              // стерео (если микрофон поддерживает)
        latency: 0,                   // минимальная задержка
        volume: 1.0
      }
    });

    const tracks = localStream.getAudioTracks();
    log('Got stream. Tracks: ' + tracks.length);
    tracks.forEach(t => {
      log('Track: ' + t.label);
      const settings = t.getSettings();
      log('Settings: ' + JSON.stringify(settings));
    });

    setMicStatus(true);
    btnJoin.style.display  = 'none';
    btnLeave.style.display = 'block';
    btnMic.style.display   = 'block';
    joined = true;

    addParticipant(socket.id, '🟢 Вы (' + shortId(socket.id) + ')');
    startVolumeAnalysis(socket.id, localStream);

    socket.emit('join');
    log('Emitted join');

    for (const { from, offer } of pendingOffers) {
      log('Processing pending offer from ' + from);
      await handleOffer(from, offer);
    }
    pendingOffers = [];

  } catch (err) {
    log('MIC ERROR: ' + err.name + ' - ' + err.message);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      alert('❌ Доступ к микрофону запрещён.\n\nОткрой настройки браузера → Разрешения сайтов → Микрофон → разреши для этого сайта.');
    } else if (err.name === 'NotFoundError') {
      alert('❌ Микрофон не найден.');
    } else if (err.name === 'NotReadableError') {
      alert('❌ Микрофон занят другим приложением.');
    } else {
      alert('❌ Ошибка: ' + err.name + ' - ' + err.message);
    }
  }
});

btnLeave.addEventListener('click', () => {
  log('Leave clicked');
  socket.emit('leave');
  hangUp();
  joined = false;
  btnJoin.style.display  = 'block';
  btnLeave.style.display = 'none';
  btnMic.style.display   = 'none';
  micStatus.className    = 'mic-status';
  micStatus.textContent  = '';
});

btnMic.addEventListener('click', () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(track => { track.enabled = micEnabled; });
  setMicStatus(micEnabled);
  btnMic.textContent = micEnabled ? '🔇 Выключить микрофон' : '🎙️ Включить микрофон';
  log('Mic enabled: ' + micEnabled);
});

function setMicStatus(active) {
  micStatus.textContent = active ? '🟢 Микрофон активен' : '🔴 Микрофон выключен';
  micStatus.className   = 'mic-status ' + (active ? 'active' : 'muted');
}

// ───── WebRTC события ─────
socket.on('existing-users', async (userIds) => {
  log('Existing users: ' + JSON.stringify(userIds));
  for (const userId of userIds) {
    addParticipant(userId, '👤 ' + shortId(userId));
    const peer = createPeer(userId, true);
    peers[userId] = peer;
  }
});

socket.on('user-joined', (userId) => {
  log('User joined: ' + userId);
  playBeep('join');
  addParticipant(userId, '👤 ' + shortId(userId));
});

socket.on('offer', async ({ from, offer }) => {
  log('Got offer from ' + from);
  if (!localStream) {
    pendingOffers.push({ from, offer });
    log('No stream yet, buffering offer');
    return;
  }
  await handleOffer(from, offer);
});

async function handleOffer(from, offer) {
  log('Handling offer from ' + from);
  const peer = createPeer(from, false);
  peers[from] = peer;
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.createAnswer();

  // Применяем улучшение качества к answer
  const improvedAnswer = {
    type: answer.type,
    sdp: forceOpusMaxQuality(answer.sdp)
  };

  await peer.setLocalDescription(improvedAnswer);
  socket.emit('answer', { to: from, answer: improvedAnswer });
  log('Sent answer to ' + from);
}

socket.on('answer', async ({ from, answer }) => {
  log('Got answer from ' + from);
  const peer = peers[from];
  if (peer && peer.signalingState === 'have-local-offer') {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
    log('Set remote description from ' + from);
  } else {
    log('WARNING: peer state is ' + (peer ? peer.signalingState : 'no peer'));
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  log('ICE from ' + from);
  const peer = peers[from];
  if (peer && candidate) {
    try {
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      log('ICE error: ' + e.message);
    }
  }
});

socket.on('user-left', (userId) => {
  log('User left: ' + userId);
  playBeep('leave');
  removeParticipant(userId);
  stopVolumeAnalysis(userId);
  if (peers[userId]) {
    peers[userId].close();
    delete peers[userId];
  }
  const audio = document.getElementById('audio-' + userId);
  if (audio) audio.remove();
});

// ───── Создание peer ─────
function createPeer(userId, isInitiator) {
  log('Creating peer for ' + userId + ' initiator=' + isInitiator);
  const peer = new RTCPeerConnection(iceServers);

  localStream.getTracks().forEach(track => {
    peer.addTrack(track, localStream);
    log('Added track: ' + track.kind);
  });

  // Устанавливаем параметры кодека через sender
  peer.getSenders().forEach(sender => {
    if (sender.track && sender.track.kind === 'audio') {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate  = 510000; // 510 kbps
      params.encodings[0].priority    = 'high';
      params.encodings[0].networkPriority = 'high';
      sender.setParameters(params).catch(e => log('setParameters error: ' + e.message));
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
      .catch(e => log('Autoplay BLOCKED for ' + userId + ': ' + e.message));
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: userId, candidate: event.candidate });
      log('Sent ICE to ' + userId);
    } else {
      log('ICE gathering complete for ' + userId);
    }
  };

  peer.onconnectionstatechange = () => {
    log('Peer ' + userId + ' connection: ' + peer.connectionState);
  };

  peer.oniceconnectionstatechange = () => {
    log('Peer ' + userId + ' ICE: ' + peer.iceConnectionState);
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      log('Negotiation needed for ' + userId);
      try {
        const offer = await peer.createOffer();

        // Применяем улучшение качества к offer
        const improvedOffer = {
          type: offer.type,
          sdp: forceOpusMaxQuality(offer.sdp)
        };

        await peer.setLocalDescription(improvedOffer);
        socket.emit('offer', { to: userId, offer: improvedOffer });
        log('Sent offer to ' + userId);
      } catch (e) {
        log('Offer error: ' + e.message);
      }
    };
  }

  return peer;
}

// ───── Завершение ─────
function hangUp() {
  log('Hanging up');
  Object.keys(analysers).forEach(id => stopVolumeAnalysis(id));
  Object.values(peers).forEach(peer => peer.close());
  peers = {};

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
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
}
