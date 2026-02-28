const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (t) => (logEl.textContent += `${t}\n`);

let ws;
let pc;
let localStream;
let dataChannel;
let joined = false;

const roomInput = $('roomId');
const remoteAudio = $('remoteAudio');

const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

async function ensureMedia() {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    log('🎤 Микрофон получен');
  }
}

function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    log('🔌 WS подключен');
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'joined') {
      joined = true;
      log(`✅ В комнате. Других участников: ${msg.peers}`);
      return;
    }

    if (!pc) await createPeer(false);

    if (msg.type === 'offer') {
      await pc.setRemoteDescription(msg.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', answer }));
      log('📨 Answer отправлен');
    }

    if (msg.type === 'answer') {
      await pc.setRemoteDescription(msg.answer);
      log('🤝 Соединение установлено');
    }

    if (msg.type === 'ice') {
      try { await pc.addIceCandidate(msg.candidate); } catch {}
    }
  };

  ws.onclose = () => log('WS закрыт');
}

async function createPeer(isCaller) {
  await ensureMedia();

  pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
    log('🔊 Получаю аудио');
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
  };

  if (isCaller) {
    dataChannel = pc.createDataChannel('control');
    setupDataChannel();
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      setupDataChannel();
    };
  }
}

function setupDataChannel() {
  dataChannel.onopen = () => log('📡 Канал управления открыт');
  dataChannel.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'ack') {
      log('✅ Собеседник нажал: Понял');
      alert('Собеседник: Понял ✅');
    }
  };
}

$('joinBtn').onclick = async () => {
  const roomId = roomInput.value.trim() || 'default';
  connectWS();

  // ждём открытия WS
  await new Promise((res) => {
    if (ws.readyState === WebSocket.OPEN) return res();
    ws.addEventListener('open', res, { once: true });
  });

  ws.send(JSON.stringify({ type: 'join', roomId }));
  log(`🚪 Вход в комнату: ${roomId}`);
};

$('callBtn').onclick = async () => {
  if (!joined) return alert('Сначала нажми "Подключиться"');
  await createPeer(true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', offer }));
  log('📞 Offer отправлен');
};

$('ackBtn').onclick = () => {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'ack' }));
    log('☑️ Отправил: Понял');
  } else {
    alert('Канал еще не готов');
  }
};

$('hangBtn').onclick = () => {
  if (pc) pc.close();
  pc = null;
  dataChannel = null;
  remoteAudio.srcObject = null;
  log('🛑 Завершено');
};
