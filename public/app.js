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

socket.on('user-count', (count) => {
  userCount.textContent = count;
});

btnJoin.addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setMicStatus(true);
    btnJoin.style.display = 'none';
    btnLeave.style.display = 'block';
    btnMic.style.display = 'block';
    joined = true;
    socket.emit('join');

    for (const { from, offer } of pendingOffers) {
      await handleOffer(from, offer);
    }
    pendingOffers = [];

  } catch (err) {
    alert('Не удалось получить доступ к микрофону: ' + err.message);
  }
});

btnLeave.addEventListener('click', () => {
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
  for (const userId of userIds) {
    const peer = createPeer(userId, true);
    peers[userId] = peer;
  }
});

socket.on('user-joined', async (userId) => {
  // Новый пользователь сам инициирует соединение через existing-users
});

socket.on('offer', async ({ from, offer }) => {
  if (!localStream) {
    pendingOffers.push({ from, offer });
    return;
  }
  await handleOffer(from, offer);
});

async function handleOffer(from, offer) {
  const peer = createPeer(from, false);
  peers[from] = peer;

  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
}

socket.on('answer', async ({ from, answer }) => {
  const peer = peers[from];
  if (peer && peer.signalingState === 'have-local-offer') {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) {
    try {
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('ICE candidate error:', e);
    }
  }
});

socket.on('user-left', (userId) => {
  if (peers[userId]) {
    peers[userId].close();
    delete peers[userId];
  }
  const audio = document.getElementById('audio-' + userId);
  if (audio) audio.remove();
});

function createPeer(userId, isInitiator) {
  const peer = new RTCPeerConnection(iceServers);

  localStream.getTracks().forEach(track => {
    peer.addTrack(track, localStream);
  });

  peer.ontrack = (event) => {
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + userId;
      audio.autoplay = true;
      audio.playsInline = true;
      hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play().catch(e => console.warn('Autoplay blocked:', e));
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: userId, candidate: event.candidate });
    }
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('offer', { to: userId, offer });
      } catch (e) {
        console.error('Offer error:', e);
      }
    };
  }

  return peer;
}

function hangUp() {
  Object.values(peers).forEach(peer => peer.close());
  peers = {};
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  hiddenAudios.innerHTML = '';
  pendingOffers = [];
}
