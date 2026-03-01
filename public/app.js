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

const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
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
    socket.emit('join');
  } catch (err) {
    alert('Не удалось получить доступ к микрофону: ' + err.message);
  }
});

btnLeave.addEventListener('click', () => {
  socket.emit('leave');
  hangUp();
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

// Новый участник — мы создаём offer (мы инициатор)
socket.on('user-joined', async (userId) => {
  const peer = createPeer(userId, true);
  peers[userId] = peer;
});

// Уже существующие пользователи — мы создаём offer для каждого
socket.on('existing-users', async (userIds) => {
  for (const userId of userIds) {
    const peer = createPeer(userId, true);
    peers[userId] = peer;
  }
});

// Получили offer — мы не инициатор, создаём peer и отвечаем
socket.on('offer', async ({ from, offer }) => {
  const peer = createPeer(from, false);
  peers[from] = peer;

  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
});

// Получили answer — только инициатор сюда попадает
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
      hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: userId, candidate: event.candidate });
    }
  };

  // Только инициатор создаёт offer
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
}
