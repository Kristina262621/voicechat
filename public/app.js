const socket = io();

const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const status = document.getElementById('status');
const users = document.getElementById('users');

let localStream = null;
let peers = {};

joinBtn.addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    socket.emit('join');
    joinBtn.style.display = 'none';
    leaveBtn.style.display = 'inline-block';
    status.textContent = 'Подключён ✅';
  } catch (err) {
    status.textContent = 'Ошибка доступа к микрофону ❌';
    console.error(err);
  }
});

leaveBtn.addEventListener('click', () => {
  socket.emit('leave');
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  joinBtn.style.display = 'inline-block';
  leaveBtn.style.display = 'none';
  status.textContent = 'Не подключён';
  users.textContent = '';
});

socket.on('user-count', (count) => {
  users.textContent = `Участников в чате: ${count}`;
});
