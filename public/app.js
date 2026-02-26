const socket = io();

const btnJoin = document.getElementById('btn-join');
const btnLeave = document.getElementById('btn-leave');
const btnMic = document.getElementById('btn-mic');
const userCount = document.getElementById('user-count');
const micStatus = document.getElementById('mic-status');
const hiddenAudios = document.getElementById('hidden-audios');

let localStream = null;
let peers = {};
let micEnabled = true;
let pendingOffers = [];
let joined = false;

// Лог на экране
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
  line.textContent = new Date().toISOString().slice(11,19) + ' ' + msg;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

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

socket.on('connect', () => log('Socket connected: ' + socket.id));
socket.on('disconnect', () => log('Socket disconnected'));

socket.on('user-count', (count) => {
  userCount.textContent = count;
  log('User count: ' + count);
});

btnJoin.addEventListener('click', async () => {
  log('Join clicked');
  try {
    log('Requesting microphone...');

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    const tracks = localStream.getAudioTracks();
    log('Got stream. Tracks: ' + tracks.length);
    tracks.forEach(t => log('Track: ' + t.label + ' enabled=' + t.enabled + ' readyState=' + t.readyState));

    setMicStatus(true);
    btnJoin.style.display = 'none';
    btnLeave.style.display = 'block';
    btnMic.style.display = 'block';
    joined = true;
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
  btnJoin.style.display = 'block';
  btnLeave.style.display = 'none';
  btnMic.style.display = 'none';
  micStatus.className = 'mic-status';
});

btnMic.addEventListener('click', () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = micEnabled;
  });
  setMicStatus(micEnabled);
  btnMic.textContent = micEnabled ? '🔇 Выключить микрофон' : '🎙️ Включить микрофон';
  log('Mic enabled: ' + micEnabled);
});

function setMicStatus(active) {
  if (active) {
    micStatus.textContent = '🟢 Микрофон активен';
    micStatus.className = 'mic-status active';
  } else {
    micStatus.textContent = '🔴 Микрофон выключен';
    micStatus.className = 'mic-status muted';
  }
}

socket.on('existing-users', async (userIds) => {
  log('Existing users: ' + JSON.stringify(userIds));
  for (const userId of userIds) {
    const peer = createPeer(userId, true);
    peers[userId] = peer;
  }
});

socket.on('user-joined', (userId) => {
  log('User joined: ' + userId);
});

socket.on('offer', async ({ from, offer }) => {
  log('Got offer from ' + from);
  if (!localStream) {
    log('No stream yet, buffering offer');
    pendingOffers.push({ from, offer });
    return;
  }
  await handleOffer(from, offer);
});

async function handleOffer(from, offer) {
  log('Handling offer from ' + from);
  const peer = createPeer(from, false);
  peers[from] = peer;

  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  log('Set remote description');
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
  log('Sent answer to ' + from);
}

socket.on('answer', async ({ from, answer }) => {
  log('Got answer from ' + from);
  const peer = peers[from];
  if (peer && peer.signalingState === 'have-local-offer') {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
    log('Set remote description (answer) from ' + from);
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
  if (peers[userId]) {
    peers[userId].close();
    delete peers[userId];
  }
  const audio = document.getElementById('audio-' + userId);
  if (audio) audio.remove();
});

function createPeer(userId, isInitiator) {
  log('Creating peer for ' + userId + ' initiator=' + isInitiator);
  const peer = new RTCPeerConnection(iceServers);

  localStream.getTracks().forEach(track => {
    peer.addTrack(track, localStream);
    log('Added track to peer: ' + track.kind);
  });

  peer.ontrack = (event) => {
    log('Got remote track from ' + userId + ' streams=' + event.streams.length);
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + userId;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.setAttribute('playsinline', '');
      audio.setAttribute('webkit-playsinline', '');
      hiddenAudios.appendChild(audio);
      log('Created audio element for ' + userId);
    }
    audio.srcObject = event.streams[0];
    audio.play()
      .then(() => log('Audio playing for ' + userId))
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
        await peer.setLocalDescription(offer);
        socket.emit('offer', { to: userId, offer });
        log('Sent offer to ' + userId);
      } catch (e) {
        log('Offer error: ' + e.message);
      }
    };
  }

  return peer;
}

function hangUp() {
  log('Hanging up');
  Object.values(peers).forEach(peer => peer.close());
  peers = {};
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  hiddenAudios.innerHTML = '';
  pendingOffers = [];
}
