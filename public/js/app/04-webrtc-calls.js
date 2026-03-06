// ═══════════════════════════════════════════════
//  04-webrtc-calls.js — голосовой чат (группа) + личные звонки
//  SECURITY PATCH: TURN credentials only from backend /api/turn-credentials
// ═══════════════════════════════════════════════

let iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

async function refreshIceServers() {
  try {
    if (!authToken) return false;
    const r = await fetch('/api/turn-credentials', {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (j?.ok && Array.isArray(j.iceServers) && j.iceServers.length) {
      iceServers = {
        ...iceServers,
        iceServers: j.iceServers
      };
      return true;
    }
  } catch (_) {}
  return false;
}

function forceOpusMaxQuality(sdp) {
  const lines = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[1].split(' ')[0];
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) i++;
      result.push('a=fmtp:' + pt + ' minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=40000;dtx=1;cbr=0');
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

function calcLevel(rtt, lostRatio, jitter) {
  if (rtt === null && lostRatio === null) return 'none';
  const r = rtt !== null ? rtt : 999;
  const j = jitter !== null ? jitter * 1000 : 999;
  const l = lostRatio !== null ? lostRatio : 1;
  if (r < 100 && l < 0.02 && j < 20)  return 'excellent';
  if (r < 200 && l < 0.05 && j < 50)  return 'good';
  if (r < 400 && l < 0.15 && j < 100) return 'fair';
  return 'poor';
}

function renderSignal(userId, level) {
  const w = document.getElementById('sig-' + userId);
  if (!w) return;
  w.className = 'signal-wrap signal-' + (level || 'none');
}

async function measureQuality(peer, isLocal) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lostRatio = null, jitter = null;

    stats.forEach(r => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded') {
        if (r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
      }

      if (isLocal) {
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
          if (r.roundTripTime != null) rtt = r.roundTripTime * 1000;
          if (r.jitter != null) jitter = r.jitter;
          if (r.packetsLost != null) {
            stats.forEach(s => {
              if (s.type === 'outbound-rtp' && s.kind === 'audio' && s.packetsSent > 0) {
                lostRatio = Math.max(0, r.packetsLost) / (Math.max(0, r.packetsLost) + s.packetsSent);
              }
            });
          }
        }
      } else {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          if (r.jitter != null) jitter = r.jitter;
          const total = (r.packetsReceived || 0) + (r.packetsLost || 0);
          if (total > 0) lostRatio = Math.max(0, r.packetsLost || 0) / total;
        }
      }
    });

    return calcLevel(rtt, lostRatio, jitter);
  } catch {
    return 'none';
  }
}

function startQualityMonitor(userId, peer, isLocal) {
  stopQualityMonitor(userId);
  renderSignal(userId, 'good');
  qualityTimers[userId] = setInterval(async () => {
    const level = await measureQuality(peer, isLocal);
    renderSignal(userId, level);
  }, 3000);
}

function stopQualityMonitor(userId) {
  if (qualityTimers[userId]) {
    clearInterval(qualityTimers[userId]);
    delete qualityTimers[userId];
  }
  renderSignal(userId, 'none');
}

function addParticipant(userId, nickname, isMe) {
  if (!participantsList || !participantsBox) return;
  if (document.getElementById('p-' + userId)) {
    updateParticipantName(userId, nickname);
    return;
  }

  participantsBox.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'participant';
  div.id = 'p-' + userId;

  const displayName = isMe ? '🟢 ' + escapeHtml(nickname) + ' (Вы)' : '👤 ' + escapeHtml(nickname);
  const understoodBtn = isMe ? '' : `<button class="btn-understood" data-uid="${userId}">👍</button>`;

  div.innerHTML = `
    <span class="participant-name" id="pname-${userId}">${displayName}</span>
    <div class="volume-bar-wrap"><div class="volume-bar" id="vol-${userId}"></div></div>
    <div class="signal-wrap signal-none" id="sig-${userId}">
      <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
    </div>
    ${understoodBtn}
  `;

  participantsList.appendChild(div);

  div.querySelector('.btn-understood')?.addEventListener('click', function () {
    socket.emit('understood');
    this.textContent = '✅';
    this.disabled = true;
    setTimeout(() => { this.textContent = '👍'; this.disabled = false; }, 3000);
  });
}

function updateParticipantName(userId, nickname) {
  const el = document.getElementById('pname-' + userId);
  if (!el) return;
  el.textContent = userId === socket.id ? '🟢 ' + nickname + ' (Вы)' : '👤 ' + nickname;
}

function removeParticipant(userId) {
  document.getElementById('p-' + userId)?.remove();
  if (participantsList && !participantsList.children.length && participantsBox) {
    participantsBox.style.display = 'none';
  }
}

function setSpeaking(userId, speaking) {
  const row = document.getElementById('p-' + userId);
  if (!row) return;
  row.classList.toggle('speaking', speaking);
}

function startVolumeAnalysis(userId, stream) {
  const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  if (!audioCtx) audioCtx = ctx;

  stopVolumeAnalysis(userId);

  try {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;

    function tick() {
      if (!analysers[userId]) return;

      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];

      const pct = Math.min(100, (sum / data.length) * 3);
      const bar = document.getElementById('vol-' + userId);
      if (bar) {
        bar.style.width = pct + '%';
        bar.className = 'volume-bar' + (pct > 60 ? ' loud' : '');
      }

      const speaking = pct > SPEAKING_THRESHOLD;
      if (speaking !== wasSpeaking) {
        setSpeaking(userId, speaking);
        wasSpeaking = speaking;
      }

      analysers[userId].animFrame = requestAnimationFrame(tick);
    }

    analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
  } catch (e) {
    console.warn('startVolumeAnalysis error:', e);
  }
}

function stopVolumeAnalysis(userId) {
  if (analysers[userId]) {
    cancelAnimationFrame(analysers[userId].animFrame);
    try { analysers[userId].source.disconnect(); } catch (_) {}
    delete analysers[userId];
  }
  setSpeaking(userId, false);
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }
}

function startKeepAlive() {
  if (!keepAliveAudio) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const src = ctx.createBufferSource();
    const dest = ctx.createMediaStreamDestination();
    src.buffer = buf;
    src.loop = true;
    src.connect(dest);
    src.start();
    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(() => {});
  } catch (_) {}
}

function stopKeepAlive() {
  if (!keepAliveAudio) return;
  keepAliveAudio.srcObject = null;
  keepAliveAudio.pause();
}

async function getMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl:  { ideal: true },
        sampleRate:       { ideal: 48000 },
        channelCount:     { ideal: 1 }
      }
    });
  } catch (_) {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  }
}

async function buildAudioPipeline(rawStream) {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive'
    });
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  try { await audioCtx.audioWorklet.addModule('/audio-processor.js'); } catch (_) {}

  const source = audioCtx.createMediaStreamSource(rawStream);
  const hpf = audioCtx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 100; hpf.Q.value = 0.9;
  const lpf = audioCtx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 8000; lpf.Q.value = 0.7;
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -28; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;

  noiseWorklet = new AudioWorkletNode(audioCtx, 'noise-gate-processor', {
    processorOptions: { threshold: 0.08, attack: 0.003, release: 0.25, smoothing: 0.97 },
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });

  const gain = audioCtx.createGain();
  gain.gain.value = 1.2;
  const dest = audioCtx.createMediaStreamDestination();

  source.connect(hpf);
  hpf.connect(lpf);
  lpf.connect(comp);
  comp.connect(noiseWorklet);
  noiseWorklet.connect(gain);
  gain.connect(dest);

  if (noiseIndicator) noiseIndicator.classList.add('visible');
  return dest.stream;
}

function setMicStatus(active) {
  if (!micStatus) return;
  micStatus.textContent = active ? '🟢 Микрофон активен' : '🔴 Микрофон выключен';
  micStatus.className = 'mic-status ' + (active ? 'active' : 'muted');
}

async function handleOffer(from, offer, nickname) {
  if (!offer) return;

  if (nickname) {
    voiceNicknames[from] = nickname;
    updateParticipantName(from, nickname);
  }

  if (peers[from]) {
    try { peers[from].close(); } catch (_) {}
    delete peers[from];
  }

  const peer = new RTCPeerConnection(iceServers);
  peers[from] = peer;

  const stream = processedStream || localStream;
  if (stream) stream.getTracks().forEach(t => { try { peer.addTrack(t, stream); } catch (_) {} });

  peer.ontrack = e => {
    const st = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    if (e.track.kind !== 'audio') return;

    let audio = document.getElementById('audio-' + from);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + from;
      audio.autoplay = true;
      audio.playsInline = true;
      if (hiddenAudios) hiddenAudios.appendChild(audio);
    }

    if (audio.srcObject !== st) {
      audio.srcObject = st;
      audio.play()
        .then(() => startVolumeAnalysis(from, st))
        .catch(() => {
          document.addEventListener('click', () => audio.play().catch(() => {}), { once: true });
        });
    }
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: from, candidate: e.candidate });
  };

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    if (s === 'failed') peer.restartIce();
    if (s === 'disconnected') {
      setTimeout(() => {
        if (peer.iceConnectionState === 'disconnected') peer.restartIce();
      }, 3000);
    }
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') startQualityMonitor(from, peer, false);
  };

  try {
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peer.createAnswer();
    const improved = { type: answer.type, sdp: forceOpusMaxQuality(answer.sdp) };
    await peer.setLocalDescription(improved);
    socket.emit('answer', { to: from, answer: improved });
  } catch (e) {
    console.error('handleOffer error:', e);
  }
}

function createPeer(userId, isInitiator) {
  const peer = new RTCPeerConnection(iceServers);

  const stream = processedStream || localStream;
  if (stream) stream.getTracks().forEach(t => { try { peer.addTrack(t, stream); } catch (_) {} });

  peer.getSenders().forEach(s => {
    if (s.track?.kind === 'audio') {
      const p = s.getParameters();
      if (!p.encodings) p.encodings = [{}];
      p.encodings[0].maxBitrate = 40000;
      p.encodings[0].priority = 'high';
      s.setParameters(p).catch(() => {});
    }
  });

  let restartAttempts = 0;
  let restartTimer = null;

  function tryRestart() {
    if (restartAttempts >= 5) return;
    restartAttempts++;
    clearTimeout(restartTimer);
    const delay = Math.min(1500 * Math.pow(2, restartAttempts - 1), 20000);
    restartTimer = setTimeout(() => {
      if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') peer.restartIce();
    }, delay);
  }

  peer.addEventListener('connectionstatechange', () => {
    const state = peer.connectionState;
    if (state === 'connected') {
      restartAttempts = 0;
      clearTimeout(restartTimer);
      startQualityMonitor(userId, peer, isInitiator);
      if (isInitiator && !qualityTimers[socket.id]) startQualityMonitor(socket.id, peer, true);
    }
    if (state === 'failed') tryRestart();
    if (state === 'disconnected') {
      restartTimer = setTimeout(() => {
        if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') tryRestart();
      }, 3000);
    }
  });

  peer.ontrack = e => {
    const trackStream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    if (e.track.kind !== 'audio') return;

    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + userId;
      audio.autoplay = true;
      audio.playsInline = true;
      if (hiddenAudios) hiddenAudios.appendChild(audio);
    }

    if (audio.srcObject !== trackStream) {
      audio.srcObject = trackStream;
      audio.play()
        .then(() => startVolumeAnalysis(userId, trackStream))
        .catch(() => {
          document.addEventListener('click', () => audio.play().catch(() => {}), { once: true });
        });
    }
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: userId, candidate: e.candidate });
  };

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    if (s === 'failed') tryRestart();
    if (s === 'disconnected') {
      setTimeout(() => {
        if (peer.iceConnectionState === 'disconnected') tryRestart();
      }, 3000);
    }
  };

  if (isInitiator) {
    let offerSent = false;
    peer.onnegotiationneeded = async () => {
      if (offerSent) return;
      offerSent = true;
      try {
        const offer = await peer.createOffer({ offerToReceiveAudio: true });
        const improved = { type: offer.type, sdp: forceOpusMaxQuality(offer.sdp) };
        await peer.setLocalDescription(improved);
        socket.emit('offer', { to: userId, offer: improved });
      } catch (e) {
        console.error('createOffer error:', e);
        offerSent = false;
      }
    };
  }

  return peer;
}

function hangUp() {
  Object.keys(analysers).forEach(stopVolumeAnalysis);
  Object.keys(qualityTimers).forEach(stopQualityMonitor);

  Object.values(peers).forEach(p => { try { p.close(); } catch (_) {} });
  peers = {};

  for (const k in voiceNicknames) delete voiceNicknames[k];

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  if (noiseWorklet) {
    try { noiseWorklet.disconnect(); } catch (_) {}
    noiseWorklet = null;
  }

  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  processedStream = null;
  if (noiseIndicator) noiseIndicator.classList.remove('visible');
  if (hiddenAudios) hiddenAudios.innerHTML = '';
  pendingOffers = [];

  if (participantsList) participantsList.innerHTML = '';
  if (participantsBox) participantsBox.style.display = 'none';
}

function playBeep(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
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
  } catch (_) {}
}

function playOkSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    [{ freq: 880, start: 0 }, { freq: 1100, start: 0.22 }].forEach(item => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.connect(gain);
      osc.frequency.setValueAtTime(item.freq, ctx.currentTime + item.start);

      gain.gain.setValueAtTime(0, ctx.currentTime + item.start);
      gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + item.start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + item.start + 0.20);

      osc.start(ctx.currentTime + item.start);
      osc.stop(ctx.currentTime + item.start + 0.22);
    });

    setTimeout(() => ctx.close(), 1500);
  } catch (_) {}
}

// ───────────────────────────────────────────────
//  МИНИ-БАР ЗВОНКА
// ───────────────────────────────────────────────
function showCallMiniBar(name, avatar) {
  const bar = $('call-mini-bar');
  if (!bar) return;

  const nameEl = $('call-mini-name');
  const avatarEl = $('call-mini-avatar');

  if (nameEl) nameEl.textContent = name || '—';
  if (avatarEl) {
    if (avatar) avatarEl.innerHTML = `<img src="${avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else avatarEl.textContent = '👤';
  }

  bar.classList.add('visible');
  bar.onclick = e => {
    if (e.target.id === 'call-mini-hangup') return;
    const img = $('call-screen-avatar')?.querySelector('img')?.src || null;
    showCallScreen(pcCallRemoteNick, img, null, pcCallIsVideo);
  };
}

function hideCallMiniBar() {
  $('call-mini-bar')?.classList.remove('visible');
}

function updateCallMiniStatus(text) {
  const el = $('call-mini-status-text');
  if (el) el.textContent = text || 'Звонок…';
}

// ───────────────────────────────────────────────
//  ЗВУКИ ЗВОНКА
// ───────────────────────────────────────────────
function playIncomingRing() {
  stopIncomingRing();
  let count = 0;

  const playOnce = () => {
    if (count++ > 30) { stopIncomingRing(); return; }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ringToneCtx = ctx;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);

      [{ freq:480,time:0,dur:0.18 }, { freq:640,time:0.20,dur:0.18 }, { freq:800,time:0.40,dur:0.28 }]
        .forEach(note => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(note.freq, ctx.currentTime + note.time);
          osc.connect(gain);

          gain.gain.setValueAtTime(0, ctx.currentTime + note.time);
          gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + note.time + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.time + note.dur);

          osc.start(ctx.currentTime + note.time);
          osc.stop(ctx.currentTime + note.time + note.dur + 0.05);
        });

      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 1500);
    } catch (_) {}
  };

  playOnce();
  ringInterval = setInterval(playOnce, 2000);
}

function stopIncomingRing() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
  if (ringToneCtx) { try { ringToneCtx.close(); } catch (_) {} ringToneCtx = null; }
}

function playDialTone() {
  stopDialTone();
  let count = 0;

  const playOnce = () => {
    if (count++ > 60) { stopDialTone(); return; }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination);
      osc1.type = 'sine'; osc1.frequency.value = 425;
      osc2.type = 'sine'; osc2.frequency.value = 450;

      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime + 1.0);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.05);

      osc1.start(ctx.currentTime); osc1.stop(ctx.currentTime + 1.1);
      osc2.start(ctx.currentTime); osc2.stop(ctx.currentTime + 1.1);

      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 2500);
    } catch (_) {}
  };

  playOnce();
  dialToneInterval = setInterval(playOnce, 4000);
}

function stopDialTone() {
  if (dialToneInterval) { clearInterval(dialToneInterval); dialToneInterval = null; }
}

// ───────────────────────────────────────────────
//  CALL SCREEN
// ───────────────────────────────────────────────
function setSpeakerOutput(external) {
  isSpeakerMode = external;
  if (callBtnSpeaker) {
    if (external) {
      callBtnSpeaker.textContent = '🔊';
      callBtnSpeaker.classList.add('active');
    } else {
      callBtnSpeaker.textContent = '🔈';
      callBtnSpeaker.classList.remove('active');
    }
  }
  const callAudio = document.getElementById('audio-pc-call');
  if (callAudio) callAudio.volume = external ? 1.0 : 0.7;
}

function showCallControls() {
  callControlsVisible = true;
  const bottom = callScreen?.querySelector('.call-screen-bottom');
  const top = callScreen?.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s' });
  if (top)    Object.assign(top.style,    { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s' });

  clearTimeout(callControlsHideTimer);
  if (pcCallIsVideo) callControlsHideTimer = setTimeout(hideCallControls, 4000);
}

function hideCallControls() {
  if (!pcCallIsVideo) return;
  callControlsVisible = false;
  const bottom = callScreen?.querySelector('.call-screen-bottom');
  const top = callScreen?.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'0', pointerEvents:'none', transform:'translateY(80px)', transition:'opacity 0.3s, transform 0.3s' });
  if (top)    Object.assign(top.style,    { opacity:'0', pointerEvents:'none', transform:'translateY(-60px)', transition:'opacity 0.3s, transform 0.3s' });
}

function showCallScreen(name, avatar, status, isVideo) {
  if (!callScreen) return;

  if (callScreenName) callScreenName.textContent = name || '—';
  if (callScreenStatus) callScreenStatus.textContent = status || 'Соединение…';
  if (callScreenAvatar) {
    if (avatar) callScreenAvatar.innerHTML = `<img src="${avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    else callScreenAvatar.textContent = '👤';
  }

  const center = callScreen.querySelector('.call-screen-center');
  if (center) { center.style.display = isVideo ? 'none' : 'flex'; center.style.position = 'relative'; center.style.zIndex = '1000'; }

  if (callBtnMute) { callBtnMute.classList.remove('active'); callBtnMute.textContent = '🎤'; }

  setSpeakerOutput(isVideo);
  callScreen.classList.add('active');
  callScreen.classList.remove('minimizing');
  hideCallMiniBar();

  const bottom = callScreen.querySelector('.call-screen-bottom');
  const top = callScreen.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s', position:'relative', zIndex:'1001' });
  if (top)    Object.assign(top.style,    { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s', position:'relative', zIndex:'1001' });

  callControlsVisible = true;
  clearTimeout(callControlsHideTimer);

  if (isVideo) {
    ensureVideoElements();
    ensureLocalVideo();
    showVideoUI(true);
    startLocalVideo().then(s => {
      if (s && callBtnVideo) { callBtnVideo.classList.add('active'); pcCallIsVideo = true; }
      callControlsHideTimer = setTimeout(hideCallControls, 4000);
    });
  }
}

function hideCallScreen() {
  if (!callScreen) return;
  clearTimeout(callControlsHideTimer);

  callScreen.classList.add('minimizing');
  callScreen.addEventListener('animationend', () => {
    callScreen.classList.remove('active');
    callScreen.classList.remove('minimizing');
  }, { once: true });

  stopCallTimer();

  if (pcCallActive) {
    const img = callScreenAvatar?.querySelector('img');
    showCallMiniBar(pcCallRemoteNick, img ? img.src : null);
    updateCallMiniStatus(callScreenStatus?.textContent || 'Звонок…');
  }
}

function setCallStatus(text) {
  if (text && callScreenStatus) callScreenStatus.textContent = text;
  if (pcCallActive) updateCallMiniStatus(text);
}

function startCallTimer() {
  callSeconds = 0;
  stopCallTimer();

  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    const ts = m + ':' + s;
    if (callScreenStatus) callScreenStatus.textContent = ts;
    if (callStatusDot) { callStatusDot.style.animation = 'none'; callStatusDot.style.background = '#4caf50'; }
    updateCallMiniStatus(ts);
  }, 1000);
}

function stopCallTimer() {
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
}

// ───────────────────────────────────────────────
//  ВИДЕО
// ───────────────────────────────────────────────
function ensureVideoElements() {
  let vc = document.getElementById('call-video-container');
  if (!vc) {
    vc = document.createElement('div');
    vc.id = 'call-video-container';
    vc.style.cssText = 'position:fixed;inset:0;display:none;z-index:998;background:#000;overflow:hidden;';

    const rv = document.createElement('video');
    rv.id = 'video-remote';
    rv.autoplay = true;
    rv.playsInline = true;
    rv.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    vc.appendChild(rv);

    const ns = document.createElement('div');
    ns.id = 'video-no-signal';
    ns.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:rgba(255,255,255,0.4);font-size:14px;gap:12px;';
    ns.innerHTML = '<span style="font-size:48px">📷</span><span>Видео недоступно</span>';
    vc.appendChild(ns);

    document.body.appendChild(vc);
  }
  return vc;
}

function ensureLocalVideo() {
  let lv = document.getElementById('video-local');
  if (!lv) {
    lv = document.createElement('video');
    lv.id = 'video-local';
    lv.autoplay = true;
    lv.playsInline = true;
    lv.muted = true;
    document.body.appendChild(lv);
  }
  return lv;
}

async function startLocalVideo() {
  try {
    localVideoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode:'user', width:{ideal:1280}, height:{ideal:720} },
      audio: false
    });
    const lv = ensureLocalVideo();
    lv.srcObject = localVideoStream;
    lv.style.display = 'block';
    return localVideoStream;
  } catch (e) {
    console.warn('Нет доступа к камере:', e.name);
    return null;
  }
}

function stopLocalVideo() {
  if (localVideoStream) {
    localVideoStream.getTracks().forEach(t => t.stop());
    localVideoStream = null;
  }
  const lv = document.getElementById('video-local');
  if (lv) { lv.srcObject = null; lv.style.display = 'none'; }
}

function showVideoUI(show) {
  const vc = document.getElementById('call-video-container');
  if (vc) vc.style.display = show ? 'block' : 'none';
  const lv = document.getElementById('video-local');
  if (lv) lv.style.display = show ? 'block' : 'none';
}

// ───────────────────────────────────────────────
//  ЛИЧНЫЕ ЗВОНКИ
// ───────────────────────────────────────────────
function endPrivateCall(notify = true) {
  if (notify && (pcCallRemoteId || pcCallRemoteNickLow)) {
    socket.emit('private-call-end', { to: pcCallRemoteId || pcCallRemoteNickLow });
  }

  clearTimeout(callControlsHideTimer);
  stopDialTone();
  stopIncomingRing();

  if (pcCallPeer) { try { pcCallPeer.close(); } catch (_) {} pcCallPeer = null; }
  if (pcCallStream) { pcCallStream.getTracks().forEach(t => t.stop()); pcCallStream = null; }

  stopLocalVideo();
  showVideoUI(false);
  pcCallIsVideo = false;

  document.getElementById('audio-pc-call')?.remove();
  const rv = document.getElementById('video-remote');
  if (rv) rv.srcObject = null;

  pcCallActive = false;
  pcCallRemoteId = null;
  pcCallRemoteNickLow = null;
  pcCallRemoteNick = '';
  pcCallMuted = false;
  isSpeakerMode = false;
  pcIceCandidateBuffer = [];

  if (callScreen) {
    callScreen.classList.remove('active');
    callScreen.classList.remove('minimizing');
  }
  hideCallMiniBar();

  if (modalIncomingCall) modalIncomingCall.classList.remove('open');

  stopCallTimer();

  const center = callScreen?.querySelector('.call-screen-center');
  if (center) center.style.display = 'flex';

  const bottom = callScreen?.querySelector('.call-screen-bottom');
  const top = callScreen?.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'1', pointerEvents:'all', transform:'', transition:'' });
  if (top)    Object.assign(top.style,    { opacity:'1', pointerEvents:'all', transform:'', transition:'' });

  callControlsVisible = true;

  if (callBtnMute)   { callBtnMute.textContent = '🎤';   callBtnMute.classList.remove('active'); }
  if (callBtnSpeaker){ callBtnSpeaker.textContent = '🔈'; callBtnSpeaker.classList.remove('active'); }
  if (callBtnVideo)  { callBtnVideo.textContent = '📷';  callBtnVideo.classList.remove('active'); }
}

async function startPrivateCall(isVideo) {
  await refreshIceServers();

  pcCallRemoteNick = chatRoomName ? chatRoomName.textContent : '?';
  const withAvatar = chatRoomAvatar?.querySelector('img')?.src || null;

  const parts = currentChatId.split('::');
  const myLower = myNickname.toLowerCase();
  pcCallRemoteNickLow = parts.find(p => p !== myLower) || parts[0];

  pcCallRemoteId = null;
  pcIceCandidateBuffer = [];
  pcCallIsVideo = isVideo;

  try {
    pcCallStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (_) {
    showToast('❌ Нет доступа к микрофону');
    return;
  }

  pcCallPeer = createPrivateCallPeer(pcCallRemoteNickLow, true, isVideo);
  pcCallStream.getAudioTracks().forEach(t => { try { pcCallPeer.addTrack(t, pcCallStream); } catch (_) {} });

  if (isVideo) {
    ensureVideoElements();
    const vs = await startLocalVideo();
    if (vs && pcCallPeer) {
      const vt = vs.getVideoTracks()[0];
      if (vt) { try { pcCallPeer.addTrack(vt, vs); } catch (_) {} }
    }
  }

  playDialTone();
  showCallScreen(pcCallRemoteNick, withAvatar, isVideo ? '📹 Видеовызов…' : '📞 Вызов…', isVideo);
}

function openCallTypeSelector() {
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  sheet.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2)">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:20px">📞 Позвонить</div>
      <div style="display:flex;gap:16px;justify-content:center;margin-bottom:20px">
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
          <button id="call-audio-btn" style="width:72px;height:72px;border-radius:50%;border:none;background:linear-gradient(135deg,#1e8449,#145a32);color:white;font-size:30px;cursor:pointer">📞</button>
          <span style="font-size:13px;color:var(--sub)">Аудио</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
          <button id="call-video-btn-sel" style="width:72px;height:72px;border-radius:50%;border:none;background:linear-gradient(135deg,#7c5cbf,#5b3fa0);color:white;font-size:30px;cursor:pointer">📹</button>
          <span style="font-size:13px;color:var(--sub)">Видео</span>
        </div>
      </div>
      <button id="call-cancel-btn" style="width:100%;padding:14px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
    </div>`;
  document.body.appendChild(sheet);

  const close = () => sheet.remove();
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  sheet.querySelector('#call-cancel-btn').addEventListener('click', close);
  sheet.querySelector('#call-audio-btn').addEventListener('click', () => { close(); startPrivateCall(false); });
  sheet.querySelector('#call-video-btn-sel').addEventListener('click', () => { close(); startPrivateCall(true); });
}

function createPrivateCallPeer(targetId, isInitiator, isVideo) {
  const peer = new RTCPeerConnection(iceServers);

  if (isInitiator) {
    peer.addTransceiver('audio', { direction: 'sendrecv' });
    if (isVideo) peer.addTransceiver('video', { direction: 'sendrecv' });
  }

  peer.ontrack = e => {
    const track = e.track;
    const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([track]);

    if (track.kind === 'audio') {
      let audio = document.getElementById('audio-pc-call');
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'audio-pc-call';
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = stream;
      audio.volume = isSpeakerMode ? 1.0 : 0.7;
      audio.play().catch(() => {
        const resume = () => { audio.play().catch(() => {}); };
        document.addEventListener('click', resume, { once: true });
        document.addEventListener('touchstart', resume, { once: true });
      });
    }

    if (track.kind === 'video') {
      ensureVideoElements();
      showVideoUI(true);
      pcCallIsVideo = true;
      if (callBtnVideo) callBtnVideo.classList.add('active');

      const vc = document.getElementById('call-video-container');
      if (vc) vc.style.display = 'block';

      const rv = document.getElementById('video-remote');
      const ns = document.getElementById('video-no-signal');

      if (rv) {
        let remoteStream = rv.srcObject;
        if (!remoteStream || !(remoteStream instanceof MediaStream)) {
          remoteStream = new MediaStream();
          rv.srcObject = remoteStream;
        }
        remoteStream.getVideoTracks().forEach(t => remoteStream.removeTrack(t));
        remoteStream.addTrack(track);

        rv.play().then(() => {
          if (ns) ns.style.display = 'none';
          const center = callScreen?.querySelector('.call-screen-center');
          if (center) center.style.display = 'none';
          showCallControls();
        }).catch(() => {
          const resume = () => { rv.play().catch(() => {}); };
          document.addEventListener('click', resume, { once: true });
          document.addEventListener('touchstart', resume, { once: true });
        });
      }
    }
  };

  peer.onicecandidate = e => {
    if (!e.candidate) return;
    const target = pcCallRemoteId || targetId;
    if (isInitiator && !pcCallRemoteId) pcIceCandidateBuffer.push(e.candidate);
    else socket.emit('private-call-ice', { to: target, candidate: e.candidate });
  };

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    if (state === 'connected') {
      stopDialTone();
      pcCallActive = true;
      startCallTimer();
      showToast('🟢 Звонок установлен', 2000);
      setSpeakerOutput(pcCallIsVideo ? true : isSpeakerMode);
      setCallStatus('Соединён');
      if (pcCallIsVideo) showCallControls();
    }
    if (state === 'connecting') setCallStatus('Соединение…');
    if (state === 'disconnected') {
      setCallStatus('Переподключение…');
      setTimeout(() => {
        if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
          showToast('📵 Соединение прервано', 3000);
          endPrivateCall(false);
        }
      }, 6000);
    }
    if (state === 'failed') {
      showToast('📵 Не удалось соединиться', 3000);
      endPrivateCall(false);
    }
  };

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    if (s === 'checking') setCallStatus('Соединение…');
    if (s === 'connected') { stopDialTone(); setCallStatus('Соединён'); }
    if (s === 'disconnected') setCallStatus('Переподключение…');
    if (s === 'failed') peer.restartIce();
  };

  if (isInitiator) {
    let offerCreated = false;
    peer.onnegotiationneeded = async () => {
      if (offerCreated) return;
      offerCreated = true;
      try {
        const offer = await peer.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:isVideo });
        await peer.setLocalDescription(offer);
        socket.emit('private-call-offer', {
          chatId: currentChatId,
          to: pcCallRemoteNickLow,
          offer: peer.localDescription,
          isVideo
        });
      } catch (e) {
        console.error('Private call offer error:', e);
        offerCreated = false;
        showToast('❌ Ошибка при установке звонка', 3000);
        endPrivateCall(false);
      }
    };
  }

  return peer;
}

// ───────────────────────────────────────────────
//  SOCKET EVENTS — CALLS + VOICE GROUP
// ───────────────────────────────────────────────
socket.on('private-call-offer', async data => {
  if (pcCallActive) {
    socket.emit('private-call-reject', { to: data.from });
    return;
  }

  incomingCallData = data;

  if (incomingCallAvatar) {
    if (data.fromAvatar) incomingCallAvatar.innerHTML = `<img src="${data.fromAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else incomingCallAvatar.textContent = '👤';
  }

  if (incomingCallName) incomingCallName.textContent = data.fromNick || '?';
  const subEl = $('incoming-call-sub');
  if (subEl) subEl.textContent = data.isVideo ? '📹 Видеозвонок…' : '📞 Голосовой вызов…';

  if (modalIncomingCall) modalIncomingCall.classList.add('open');
  playIncomingRing();

  showBrowserNotif(
    data.isVideo ? '📹 Входящий видеозвонок' : '📞 Входящий звонок',
    (data.fromNick || '?') + ' звонит вам',
    'call'
  );
});

socket.on('private-call-answer', async ({ from, answer }) => {
  if (!pcCallPeer) return;

  pcCallRemoteId = from;
  stopDialTone();

  if (pcCallPeer.signalingState !== 'have-local-offer') {
    console.warn('Unexpected signalingState on answer:', pcCallPeer.signalingState);
    return;
  }

  try {
    await pcCallPeer.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (e) {
    console.error('setRemoteDescription (answer) error:', e);
    showToast('❌ Ошибка установки соединения', 3000);
    endPrivateCall(false);
    return;
  }

  for (const candidate of pcIceCandidateBuffer) {
    socket.emit('private-call-ice', { to: pcCallRemoteId, candidate });
  }
  pcIceCandidateBuffer = [];
});

socket.on('private-call-ice', async ({ candidate }) => {
  if (!candidate) return;

  if (pcCallPeer && pcCallPeer.remoteDescription) {
    try { await pcCallPeer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  } else {
    pcIceCandidateBuffer.push(candidate);
  }
});

socket.on('private-call-ended', () => {
  stopDialTone();
  showToast('📵 ' + (pcCallRemoteNick || '?') + ' завершил звонок', 3000);
  endPrivateCall(false);
});

socket.on('private-call-rejected', () => {
  stopDialTone();
  showToast('📵 ' + (pcCallRemoteNick || '?') + ' отклонил звонок', 3000);
  endPrivateCall(false);
});

socket.on('existing-voice-users', async users => {
  for (const user of users) {
    voiceNicknames[user.id] = user.nickname || shortId(user.id);
    addParticipant(user.id, voiceNicknames[user.id], false);

    if (!peers[user.id]) peers[user.id] = createPeer(user.id, true);

    try {
      if (!ecdhExchanged.has(user.id)) {
        ecdhExchanged.add(user.id);
        socket.emit('ecdh-pubkey', { to: user.id, pubkey: await Crypto.exportPublicKey() });
      }
    } catch (_) {}
  }
});

socket.on('voice-user-joined', async data => {
  const uid = typeof data === 'object' ? data.id : data;
  const nick = typeof data === 'object' ? data.nickname : shortId(data);

  playBeep('join');
  voiceNicknames[uid] = nick;
  addParticipant(uid, nick, false);

  if (joined) {
    if (!peers[uid]) peers[uid] = createPeer(uid, false);
    try {
      if (!ecdhExchanged.has(uid)) {
        ecdhExchanged.add(uid);
        socket.emit('ecdh-pubkey', { to: uid, pubkey: await Crypto.exportPublicKey() });
      }
    } catch (_) {}
  }
});

socket.on('offer', async ({ from, offer, nickname }) => {
  if (nickname) voiceNicknames[from] = nickname;
  if (!localStream) {
    pendingOffers.push({ from, offer, nickname });
    return;
  }
  await handleOffer(from, offer, nickname);
});

socket.on('answer', async ({ from, answer }) => {
  if (voiceNicknames[from]) updateParticipantName(from, voiceNicknames[from]);
  const peer = peers[from];
  if (peer && peer.signalingState === 'have-local-offer') {
    try { await peer.setRemoteDescription(new RTCSessionDescription(answer)); } catch (e) {
      console.error('answer setRemoteDescription error:', e);
    }
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) {
    try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }
});

socket.on('voice-user-left', uid => {
  playBeep('leave');
  removeParticipant(uid);
  stopVolumeAnalysis(uid);
  stopQualityMonitor(uid);
  delete voiceNicknames[uid];
  if (peers[uid]) { peers[uid].close(); delete peers[uid]; }
  document.getElementById('audio-' + uid)?.remove();
});

socket.on('understood', ({ from, nickname }) => {
  playOkSound();
  const b = document.createElement('div');
  b.className = 'understood-banner';
  b.textContent = '✅ Понял! (' + (nickname || shortId(from)) + ')';
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 3000);
});

// ───────────────────────────────────────────────
//  ВОССТАНОВЛЕНИЕ ПРИ VISIBILITYCHANGE
// ───────────────────────────────────────────────
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !joined || !localStream) return;

  await requestWakeLock();

  const tracks = localStream.getAudioTracks();
  if (tracks.every(t => t.readyState === 'ended')) {
    try {
      const newRaw = await getMicStream();
      let newProc;
      try { newProc = await buildAudioPipeline(newRaw); } catch { newProc = newRaw; }

      const procTrack = newProc.getAudioTracks()[0];
      for (const uid in peers) {
        const sender = peers[uid].getSenders().find(s => s.track?.kind === 'audio');
        if (sender && procTrack) await sender.replaceTrack(procTrack);
      }

      const newTrack = newRaw.getAudioTracks()[0];
      tracks.forEach(t => { localStream.removeTrack(t); t.stop(); });
      localStream.addTrack(newTrack);

      processedStream = newProc;
      stopVolumeAnalysis(socket.id);
      startVolumeAnalysis(socket.id, localStream);
      newTrack.enabled = micEnabled;
    } catch (_) {}
  } else {
    tracks.forEach(t => { t.enabled = micEnabled; });
  }

  if (audioCtx?.state === 'suspended') await audioCtx.resume();
});

// ───────────────────────────────────────────────
//  СТИЛИ (динамически)
// ───────────────────────────────────────────────
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes dlPulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
    .group-photo-change-btn {
      display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:14px;
      border:1px solid rgba(124,92,191,0.2);background:var(--bg2);color:var(--accent2);
      font-size:14px;cursor:pointer;width:100%;margin-bottom:12px;
    }
    .group-photo-change-btn:active { background:rgba(124,92,191,0.12); }
    .msg-ticks { margin-left:2px; transition:color 0.3s; }

    .signal-none .bar { background:rgba(255,255,255,0.1)!important; }
    .signal-excellent .bar { background:var(--green)!important; }
    .signal-good .bar:nth-child(-n+3) { background:#8bc34a!important; }
    .signal-good .bar:nth-child(4) { background:rgba(255,255,255,0.1)!important; }
    .signal-fair .bar:nth-child(-n+2) { background:var(--orange)!important; }
    .signal-fair .bar:nth-child(n+3) { background:rgba(255,255,255,0.1)!important; }
    .signal-poor .bar:nth-child(1) { background:var(--red)!important; }
    .signal-poor .bar:nth-child(n+2) { background:rgba(255,255,255,0.1)!important; }

    #call-video-container { position:fixed!important;inset:0!important;z-index:998!important;background:#000;overflow:hidden; }
    #video-remote { width:100%!important;height:100%!important;object-fit:cover!important; }
    #call-screen { background:transparent!important; }
    #call-screen.active { z-index:999!important; }

    #call-screen .call-screen-top {
      position:fixed!important;top:env(safe-area-inset-top,0)!important;left:0;right:0;z-index:1001!important;
      padding:max(env(safe-area-inset-top),12px) 20px 12px!important;
      background:linear-gradient(to bottom,rgba(0,0,0,0.6),transparent)!important;
    }

    #call-screen .call-screen-center {
      position:fixed!important;top:50%!important;left:0;right:0;transform:translateY(-50%)!important;
      z-index:1001!important;background:none!important;padding:20px!important;
    }

    #call-screen .call-screen-bottom {
      position:fixed!important;bottom:0!important;left:0;right:0;z-index:1001!important;
      padding:20px 24px max(env(safe-area-inset-bottom),24px)!important;
      background:linear-gradient(to top,rgba(0,0,0,0.75),transparent)!important;border-radius:0!important;
    }

    #video-local {
      position:fixed!important;
      top:max(calc(env(safe-area-inset-top,0px) + 60px),80px)!important;
      right:16px!important;width:90px!important;height:130px!important;border-radius:14px!important;
      object-fit:cover!important;border:2px solid rgba(255,255,255,0.4)!important;
      box-shadow:0 4px 16px rgba(0,0,0,0.6)!important;z-index:1002!important;cursor:pointer!important;background:#222!important;
    }
  `;
  document.head.appendChild(style);
})();
