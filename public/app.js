const socket = io();
let localStream = null;
let peerConnection = null;
let currentRoom = null;
let isMuted = false;

// Конфигурация ICE серверов (STUN для обхода NAT)
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // Для production добавь TUN сервер для надежности
  ]
};

const statusEl = document.getElementById('status');
const roomInput = document.getElementById('roomId');
const joinBtn = document.getElementById('joinBtn');
const createBtn = document.getElementById('createBtn');
const callControls = document.getElementById('callControls');
const roomControls = document.querySelector('.room-controls');
const muteBtn = document.getElementById('muteBtn');
const hangupBtn = document.getElementById('hangupBtn');

// Генерация ID комнаты
createBtn.addEventListener('click', () => {
  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  roomInput.value = roomId;
  joinRoom(roomId);
});

joinBtn.addEventListener('click', () => {
  const roomId = roomInput.value.trim().toUpperCase();
  if (roomId) joinRoom(roomId);
});

async function joinRoom(roomId) {
  currentRoom = roomId;
  updateStatus('connecting', 'Подключение...');
  
  try {
    // Получаем доступ к микрофону
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100
      },
      video: false 
    });
    
    socket.emit('join-room', roomId);
    roomControls.classList.add('hidden');
    callControls.classList.remove('hidden');
    
  } catch (err) {
    alert('Не удалось получить доступ к микрофону: ' + err.message);
    updateStatus('disconnected', 'Ошибка доступа');
  }
}

// WebRTC логика
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(configuration);
  
  // Добавляем локальный трек
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });
  
  // Обработка входящего аудио
  peerConnection.ontrack = (event) => {
    const remoteAudio = document.createElement('audio');
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.autoplay = true;
    remoteAudio.id = 'remoteAudio';
    document.getElementById('audioContainer').appendChild(remoteAudio);
    updateStatus('connected', 'В эфире');
    document.getElementById('peerStatus').textContent = 'Собеседник на связи 📡';
  };
  
  // Обмен ICE кандидатами
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        roomId: currentRoom,
        candidate: event.candidate
      });
    }
  };
}

// Сигналинг
socket.on('user-joined', async () => {
  console.log('Peer joined, creating offer...');
  createPeerConnection();
  
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('offer', { roomId: currentRoom, offer });
});

socket.on('offer', async (data) => {
  console.log('Received offer');
  createPeerConnection();
  
  await peerConnection.setRemoteDescription(data.offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  
  socket.emit('answer', { roomId: currentRoom, answer });
});

socket.on('answer', async (data) => {
  console.log('Received answer');
  await peerConnection.setRemoteDescription(data.answer);
});

socket.on('ice-candidate', async (data) => {
  try {
    await peerConnection.addIceCandidate(data.candidate);
  } catch (e) {
    console.error('Error adding ICE candidate:', e);
  }
});

socket.on('waiting', () => {
  updateStatus('connecting', 'Ожидание собеседника...');
  document.getElementById('peerStatus').textContent = 'Поделитесь ID комнаты: ' + currentRoom;
});

socket.on('user-left', () => {
  updateStatus('connecting', 'Собеседник отключился');
  document.getElementById('peerStatus').textContent = 'Собеседник отключился';
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  document.getElementById('remoteAudio')?.remove();
});

// Управление звонком
muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  muteBtn.classList.toggle('muted', isMuted);
  muteBtn.textContent = isMuted ? '🔇' : '🎤';
});

hangupBtn.addEventListener('click', () => {
  socket.disconnect();
  location.reload();
});

function updateStatus(type, text) {
  statusEl.className = `status ${type}`;
  statusEl.textContent = text;
}
