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

// Обновление счётчика
socket.on('user-count', (count) => {
  userCount.textContent = count;
});

// Кнопка "Войти"
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

// Кнопка "Выйти"
btnLeave.addEventListener('click', () => {
  socket.emit('leave');
  hangUp();

  btnJoin.style.display = 'block';
  btnLeave.style.display = 'none';
  btnMic.style.display = 'none';
  micStatus.className = 'mic-status';
});

// Кнопка "Микрофон вкл/выкл"
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

// Новый участник зашёл — создаём ему offer
socket.on('user-joined', async (userId) => {
  const peer = createPeer(userId);
  peers[userId] = peer;

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  socket.emit('offer', { to: userId, offer });
});

// Получили список тех, кто уже в чате
socket.on('existing-users', async (userIds) => {
  for (const userId of userIds) {
    const peer = createPeer(userId);
    peers[userId] = peer;

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit('offer', { to: userId, offer });
  }
});

// Получили offer — отвечаем answer
socket.on('offer', async ({ from, offer }) => {
  const peer = createPeer(from);
  peers[from] = peer;

  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
});

// Получили answer
socket.on('answer', async ({ from, answer }) => {
  const peer = peers[from];
  if (peer) {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

// ICE кандидаты
socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) {
    await peer.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// Участник вышел
socket.on('user-left', (userId) => {
  if (peers[userId]) {
    peers[userId].close();
    delete peers[userId];
  }
  const audio = document.getElementById('audio-' + userId);
  if (audio) audio.remove();
});

// Создаём RTCPeerConnection для участника
function createPeer(userId) {
  const peer = new RTCPeerConnection(iceServers);

  // Добавляем свой аудиопоток
  localStream.getTracks().forEach(track => {
    peer.addTrack(track, localStream);
  });

  // Получаем аудио от участника
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

  // Отправляем ICE кандидаты
  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: userId, candidate: event.candidate });
    }
  };

  return peer;
}

// Завершаем все соединения
function hangUp() {
  Object.values(peers).forEach(peer => peer.close());
  peers = {};

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  hiddenAudios.innerHTML = '';
}
