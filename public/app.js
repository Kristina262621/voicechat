// ═══════════════════════════════════════════════
//  CRYPTO — AES-256-GCM (Сквозное шифрование)
// ═══════════════════════════════════════════════
const Crypto = (() => {
  let cryptoKey = null;

  async function deriveKey(password) {
    const enc    = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name:'PBKDF2' }, false, ['deriveKey']
    );
    const salt = enc.encode('voicechat-salt-v1');
    cryptoKey  = await crypto.subtle.deriveKey(
      { name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' },
      keyMat,
      { name:'AES-GCM', length:256 },
      false,
      ['encrypt','decrypt']
    );
    return cryptoKey;
  }

  async function encrypt(data) {
    const iv      = crypto.getRandomValues(new Uint8Array(12));
    const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const cipher  = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, cryptoKey, encoded);
    return {
      iv:        btoa(String.fromCharCode(...iv)),
      encrypted: btoa(String.fromCharCode(...new Uint8Array(cipher)))
    };
  }

  async function decrypt(encB64, ivB64) {
    const iv     = Uint8Array.from(atob(ivB64),  c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
    return crypto.subtle.decrypt({ name:'AES-GCM', iv }, cryptoKey, cipher);
  }

  async function decryptText(encB64, ivB64) {
    return new TextDecoder().decode(await decrypt(encB64, ivB64));
  }

  async function decryptBlob(encB64, ivB64, mime) {
    return new Blob([await decrypt(encB64, ivB64)], { type: mime });
  }

  return { deriveKey, encrypt, decryptText, decryptBlob };
})();

// ═══════════════════════════════════════════════
//  SOCKET — ЯДРО СВЯЗИ С СЕРВЕРОМ
// ═══════════════════════════════════════════════
let socket = null;
window._roomPeers = new Set();
window._peerNames = new Map();
window._peerAvatars = new Map();
window._peerIds = new Map();

function initSocket(token, roomId, username) {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  window._roomPeers.clear();
  window._peerNames.clear();
  window._peerAvatars.clear();
  window._peerIds.clear();

  Crypto.deriveKey(String(roomId)).catch(e => console.error(e));

  socket = io({
    reconnection:         true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    1000,
    reconnectionDelayMax: 5000,
    timeout:              20000,
    transports:           ['websocket', 'polling'],
  });

  window._socket = socket;

  socket.on('connect', () => {
    document.getElementById('reconnect-banner').classList.remove('visible');
    socket.emit('join-room', { token, roomId });
  });

  socket.on('auth-ok', ({ username: uname }) => { joined = false; });
  socket.on('auth-fail', () => { showScreen('screen-rooms'); toast('❌ Ошибка авторизации'); });
  socket.on('disconnect', () => { if (joined) document.getElementById('reconnect-banner').classList.add('visible'); });

  socket.on('user-count', count => {
    const el = document.getElementById('user-count');
    if (el) el.textContent = count;
  });

  socket.on('existing-users', async (users) => {
    for (const u of users) {
      const socketId = u.socketId;
      const uname = u.username || 'Участник';

      window._roomPeers.add(socketId);
      window._peerNames.set(socketId, uname);
      window._peerAvatars.set(socketId, u.avatar || null);
      window._peerIds.set(socketId, u.userId || null);
      
      if (joined && localStream) {
        addParticipant(socketId, uname);
        peers[socketId] = createPeer(socketId, true);
      }
      if (window.onUserJoined) window.onUserJoined(socketId);
    }
  });

  socket.on('room-history', async ({ messages, pinned }) => {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      await appendHistoryMessage(m);
    }
    if (pinned) updatePinnedBanner(pinned);
  });

  socket.on('user-joined', (data) => {
    const socketId = data.socketId;
    const uname = data.username || 'Участник';

    window._roomPeers.add(socketId);
    window._peerNames.set(socketId, uname);
    window._peerAvatars.set(socketId, data.avatar || null);
    window._peerIds.set(socketId, data.userId || null);
    playBeep('join');
    
    if (joined) addParticipant(socketId, uname);
    showToastJoin(uname);

    if (window.onUserJoined) window.onUserJoined(socketId);
  });

  socket.on('user-left', (data) => {
    const socketId = typeof data === 'string' ? data : data.socketId;
    const uname = window._peerNames.get(socketId) || socketId.slice(0,6);
    
    window._roomPeers.delete(socketId);
    window._peerNames.delete(socketId);
    window._peerAvatars.delete(socketId);
    window._peerIds.delete(socketId);
    
    playBeep('leave');
    removeParticipant(socketId);
    stopVolumeAnalysis(socketId);
    stopQualityMonitor(socketId);
    
    if (peers[socketId]) { peers[socketId].close(); delete peers[socketId]; }
    document.getElementById('audio-' + socketId)?.remove();
    showToastLeave(uname);

    if (window.onUserLeft) window.onUserLeft(socketId);
  });

  socket.on('offer', async ({ from, offer }) => {
    if (!localStream) { pendingOffers.push({ from, offer }); return; }
    await handleOffer(from, offer);
  });

  socket.on('answer', async ({ from, answer }) => {
    const peer = peers[from];
    if (peer?.signalingState === 'have-local-offer') {
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const peer = peers[from];
    if (peer && candidate) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    }
  });

  socket.on('chat-message', async (data) => {
    const uname = window._peerNames.get(data.from) || data.username || data.from?.slice(0,6);
    const avatar = window._peerAvatars.get(data.from) || null;

    const msgId = appendMessage({
      from:      data.from,
      userId:    data.userId,
      msgId:     data.msgId,
      username:  uname,
      avatar,
      type:      data.type,
      fileName:  data.fileName,
      fileSize:  data.fileSize,
      mimeType:  data.mimeType,
      timestamp: data.timestamp,
      mine:      false,
      status:    'decrypting'
    });

    try {
      const meta = await decryptMeta(data.metaEnc, data.metaIv);
      if (data.type === 'text') {
        const text = await Crypto.decryptText(data.encrypted, data.iv);
        updateMessage(msgId, { text, status: 'ok', replyTo: meta?.replyTo || null, editedAt: data.editedAt || null });
      } else {
        const mime = data.mimeType || 'application/octet-stream';
        const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
        const url  = URL.createObjectURL(blob);
        updateMessage(msgId, { localUrl: url, status: 'ok', replyTo: meta?.replyTo || null, editedAt: data.editedAt || null });
      }
    } catch(e) {
      updateMessage(msgId, { status: 'error' });
    }
  });

  socket.on('message-edit', async (data) => {
    const msg = messageStore.get(data.msgId);
    if (!msg) return;
    try {
      const meta = await decryptMeta(data.metaEnc, data.metaIv);
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      updateMessage(msg.domId, { text, editedAt: data.editedAt || Date.now(), replyTo: meta?.replyTo || null });
    } catch {}
  });

  socket.on('message-delete', ({ msgId }) => {
    const msg = messageStore.get(msgId);
    if (!msg) return;
    markMessageDeleted(msg.domId);
  });

  socket.on('reaction-toggle', ({ msgId, emoji, userId }) => {
    toggleReactionLocal(msgId, emoji, userId);
  });

  socket.on('room-pinned', ({ msgId }) => {
    updatePinnedBanner(msgId);
  });

  socket.on('typing', ({ username, isTyping }) => {
    updateTyping(username, isTyping);
  });

  socket.on('understood', ({ from, username: uname }) => {
    playOkSound();
    const name = uname || window._peerNames.get(from) || from?.slice(0,6);
    const banner = document.createElement('div');
    banner.className   = 'understood-banner';
    banner.textContent = '✅ Понял! (' + name + ')';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 3000);
  });

  socket.on('video-start',  (data) => { if (window.onVideoStart) window.onVideoStart(typeof data==='string'?data:data.from); });
  socket.on('video-stop',   (data) => { if (window.onVideoStop) window.onVideoStop(typeof data==='string'?data:data.from); });
  socket.on('video-offer',  async (data) => { window._roomPeers.add(data.from); if (window.onVideoOffer) await window.onVideoOffer(data.from, data.offer); });
  socket.on('video-answer', async (data) => { if (window.onVideoAnswer) await window.onVideoAnswer(data.from, data.answer); });
  socket.on('video-ice',    async (data) => { if (window.onVideoIce) await window.onVideoIce(data.from, data.candidate); });
}

function socketLeave() {
  if (!socket) return;
  socket.emit('leave');
  hangUp();
  joined = false;
  if (typeof resetVoiceUI === 'function') resetVoiceUI();
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    window._socket = null;
  }
  window._roomPeers.clear();
  window._peerNames.clear();
  window._peerAvatars.clear();
  window._peerIds.clear();
}

// ═══════════════════════════════════════════════
//  DOM ИНТЕРФЕЙС И УТИЛИТЫ ГЛОБАЛЬНОГО СОСТОЯНИЯ
// ═══════════════════════════════════════════════
const btnJoin          = document.getElementById('btn-join');
const btnLeave         = document.getElementById('btn-leave');
const btnMic           = document.getElementById('btn-mic');
const hiddenAudios     = document.getElementById('hidden-audios');
const participantsBox  = document.getElementById('participants');
const participantsList = document.getElementById('participants-list');
const keepAliveAudio   = document.getElementById('keep-alive-audio');
const chatMessages     = document.getElementById('chat-messages');
const chatInput        = document.getElementById('chat-input');
const btnSend          = document.getElementById('btn-send');
const btnPhoto         = document.getElementById('btn-photo');
const btnVideo         = document.getElementById('btn-video');
const btnFile          = document.getElementById('btn-file');
const fileInput        = document.getElementById('file-input');
const lightbox         = document.getElementById('lightbox');
const lightboxContent  = document.getElementById('lightbox-content');
const lightboxClose    = document.getElementById('lightbox-close');

const replyBar         = document.getElementById('reply-bar');
const replyText        = document.getElementById('reply-text');
const replyCancel      = document.getElementById('reply-cancel');
const typingIndicator  = document.getElementById('typing-indicator');
const pinnedBanner     = document.getElementById('pinned-banner');
const msgMenu          = document.getElementById('msg-menu');

let localStream     = null;
let peers           = {};
let micEnabled      = true;
let pendingOffers   = [];
let joined          = false;
let audioCtx        = null;
let wakeLock        = null;
let msgCounter      = 0;

const analysers     = {};
const qualityTimers = {};

const messageStore  = new Map();
let replyTarget     = null;
let editingMsgId    = null;
let typingTimer     = null;
let typingActive    = false;
const typingSet     = new Set();

function showToastJoin(username) { toast('👋 ' + username + ' вошёл в комнату'); }
function showToastLeave(username) { toast('🚪 ' + username + ' покинул комнату'); }
function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatSize(b) { if(b<1024)return b+' Б'; if(b<1024*1024)return(b/1024).toFixed(1)+' КБ'; return(b/1024/1024).toFixed(1)+' МБ'; }

function getUserMeta(socketId) {
  return {
    socketId,
    username: window._peerNames.get(socketId) || 'Участник',
    avatar: window._peerAvatars.get(socketId) || null,
    userId: window._peerIds.get(socketId) || null
  };
}

function generateMsgId() {
  return (crypto.randomUUID && crypto.randomUUID()) || ('m' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

async function decryptMeta(metaEnc, metaIv) {
  if (!metaEnc || !metaIv) return null;
  try {
    const json = await Crypto.decryptText(metaEnc, metaIv);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════
//  ЧАТ — ОТПРАВКА И ФАЙЛЫ
// ═══════════════════════════════════════════════
chatInput?.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';

  if (!socket) return;
  if (!typingActive) {
    typingActive = true;
    socket.emit('typing', { isTyping: true });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    typingActive = false;
    socket.emit('typing', { isTyping: false });
  }, 800);
});

chatInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});

btnSend?.addEventListener('click', sendTextMessage);
replyCancel?.addEventListener('click', () => setReplyTarget(null));

async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;

  btnSend.disabled = true;
  try {
    if (editingMsgId) {
      const { encrypted, iv } = await Crypto.encrypt(text);
      const meta = { replyTo: replyTarget ? replyTarget : null };
      const { encrypted: metaEnc, iv: metaIv } = await Crypto.encrypt(JSON.stringify(meta));

      socket.emit('message-edit', { msgId: editingMsgId, encrypted, iv, metaEnc, metaIv });
      const msg = messageStore.get(editingMsgId);
      if (msg) updateMessage(msg.domId, { text, editedAt: Date.now(), replyTo: replyTarget || null });
      editingMsgId = null;
      setReplyTarget(null);
      chatInput.value = ''; chatInput.style.height = 'auto';
      return;
    }

    const msgId = generateMsgId();
    const { encrypted, iv } = await Crypto.encrypt(text);
    const meta = { replyTo: replyTarget ? replyTarget : null };
    const { encrypted: metaEnc, iv: metaIv } = await Crypto.encrypt(JSON.stringify(meta));

    socket.emit('chat-message', { msgId, encrypted, iv, metaEnc, metaIv, type: 'text' });
    appendMessage({ 
      from: socket.id, 
      userId: window._currentUserId,
      msgId,
      username: window._currentUsername || 'Вы', 
      text, 
      type: 'text', 
      timestamp: Date.now(), 
      mine: true, 
      status: 'ok',
      replyTo: replyTarget || null
    });
    chatInput.value = ''; chatInput.style.height = 'auto';
    setReplyTarget(null);
  } catch(e) {}
  finally { btnSend.disabled = false; }
}

btnPhoto?.addEventListener('click', () => { fileInput.accept = 'image/*'; fileInput.click(); });
btnVideo?.addEventListener('click', () => { fileInput.accept = 'video/*'; fileInput.click(); });
btnFile?.addEventListener('click',  () => { fileInput.accept = '*/*'; fileInput.click(); });

fileInput?.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return; 
  fileInput.value = '';
  if (file.size > 50 * 1024 * 1024) return toast('❌ Файл слишком большой. Максимум 50 МБ.');

  if (file.type.startsWith('image/') && window.MediaEditor) {
    MediaEditor.openPhoto(file, (blob, mime, name) => sendMediaBlob(blob, mime, name, 'image'));
    return;
  }

  if (file.type.startsWith('video/') && window.MediaEditor) {
    MediaEditor.openVideo(file, (blob, mime, name) => sendMediaBlob(blob, mime, name, 'video'));
    return;
  }
  
  const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
  await sendMediaBlob(file, file.type, file.name, type);
});

async function sendMediaBlob(blob, mimeType, fileName, type) {
  if (!socket) return;
  try {
    const arrayBuf = await blob.arrayBuffer();
    const msgId = generateMsgId();
    const { encrypted, iv } = await Crypto.encrypt(arrayBuf);
    const meta = { replyTo: replyTarget ? replyTarget : null };
    const { encrypted: metaEnc, iv: metaIv } = await Crypto.encrypt(JSON.stringify(meta));
    const localUrl = URL.createObjectURL(new Blob([arrayBuf], { type: mimeType }));

    socket.emit('chat-message', { msgId, encrypted, iv, metaEnc, metaIv, type, fileName: fileName || 'file', fileSize: blob.size, mimeType });
    appendMessage({ 
      from: socket.id, 
      userId: window._currentUserId,
      msgId,
      username: window._currentUsername || 'Вы', 
      type, 
      localUrl, 
      fileName: fileName || 'file', 
      fileSize: blob.size, 
      mimeType, 
      timestamp: Date.now(), 
      mine: true, 
      status: 'ok',
      replyTo: replyTarget || null
    });
    setReplyTarget(null);
  } catch(e) { toast('❌ Ошибка отправки'); }
}

async function appendHistoryMessage(data) {
  const msgId = data.msg_id || generateMsgId();
  const meta = await decryptMeta(data.meta_enc, data.meta_iv);
  const isMine = data.user_id === window._currentUserId;

  if (data.deleted) {
    appendMessage({
      from: isMine ? socket?.id : 'peer',
      userId: data.user_id,
      msgId,
      username: data.username,
      avatar: data.avatar,
      type: data.type,
      timestamp: data.created_at,
      mine: isMine,
      status: 'ok',
      deleted: true,
      replyTo: meta?.replyTo || null
    });
    return;
  }

  if (data.type === 'text') {
    try {
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      appendMessage({
        from: isMine ? socket?.id : 'peer',
        userId: data.user_id,
        msgId,
        username: data.username,
        avatar: data.avatar,
        type: data.type,
        text,
        timestamp: data.created_at,
        editedAt: data.edited_at,
        mine: isMine,
        status: 'ok',
        replyTo: meta?.replyTo || null
      });
    } catch {}
  } else {
    try {
      const mime = data.mime_type || 'application/octet-stream';
      const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
      const url = URL.createObjectURL(blob);
      appendMessage({
        from: isMine ? socket?.id : 'peer',
        userId: data.user_id,
        msgId,
        username: data.username,
        avatar: data.avatar,
        type: data.type,
        localUrl: url,
        fileName: data.file_name,
        fileSize: data.file_size,
        mimeType: mime,
        timestamp: data.created_at,
        editedAt: data.edited_at,
        mine: isMine,
        status: 'ok',
        replyTo: meta?.replyTo || null
      });
    } catch {}
  }
}

function appendMessage(msg) {
  const id = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.id = id; div.className = 'msg ' + (msg.mine ? 'mine' : 'theirs');
  div.dataset.type = msg.type || 'text';
  div.dataset.msgId = msg.msgId;
  div.innerHTML = buildMsgHTML(msg);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  bindMediaEvents(div);
  bindUserEvents(div);
  bindMsgActions(div);

  messageStore.set(msg.msgId, {
    domId: id,
    mine: msg.mine,
    text: msg.text || '',
    type: msg.type,
    userId: msg.userId,
    username: msg.username
  });

  return id;
}

function updateMessage(id, updates) {
  const div = document.getElementById(id);
  if (!div) return;
  const content = div.querySelector('.msg-content');
  if (content) { content.innerHTML = buildContentHTML({ type: div.dataset.type, ...updates }); bindMediaEvents(div); }
  
  const statusEl = div.querySelector('.msg-decrypt-status');
  if (statusEl) {
    if (updates.status === 'ok') { statusEl.className = 'msg-decrypt-status ok'; statusEl.textContent = '🔓 расшифровано'; }
    if (updates.status === 'error') { statusEl.className = 'msg-decrypt-status err'; statusEl.textContent = '⚠️ ошибка'; }
  }

  const metaEl = div.querySelector('.msg-meta');
  if (metaEl && updates.editedAt) metaEl.innerHTML = metaEl.innerHTML.replace(' (изменено)', '') + ' <span class="msg-edited">(изменено)</span>';

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function markMessageDeleted(domId) {
  const div = document.getElementById(domId);
  if (!div) return;
  div.classList.add('deleted');
  div.querySelector('.msg-content').innerHTML = '<i>Сообщение удалено</i>';
}

function buildMsgHTML(msg) {
  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });
  const avatarHtml = msg.avatar 
    ? `<img class="msg-avatar-img" src="${msg.avatar}" alt="">`
    : `<div class="msg-avatar-fallback">${escapeHtml((msg.username || '?').slice(0,1).toUpperCase())}</div>`;
  const senderName = msg.mine ? '' : `<div class="msg-sender" data-socketid="${escapeHtml(msg.from || '')}"><div class="msg-avatar">${avatarHtml}</div><span>${escapeHtml(msg.username || '??')}</span></div>`;
  const statText = msg.status === 'ok' ? '🔓 расшифровано' : msg.status === 'error' ? '⚠️ ошибка' : '⏳ расшифровываем…';
  const showStatus = msg.mine ? '' : `<div class="msg-decrypt-status">${statText}</div>`;
  const edited = msg.editedAt ? ' <span class="msg-edited">(изменено)</span>' : '';
  return `${senderName}${buildReplyHTML(msg.replyTo)}<div class="msg-content">${buildContentHTML(msg)}</div><div class="msg-meta">${time}${edited}</div>${showStatus}${buildReactionsHTML(msg.msgId)}`;
}

function buildReplyHTML(replyTo) {
  if (!replyTo) return '';
  const txt = escapeHtml(replyTo.preview || 'Ответ');
  return `<div class="msg-reply"><span>Ответ:</span> ${txt}</div>`;
}

function buildContentHTML(msg) {
  if (msg.deleted) return '<i>Сообщение удалено</i>';
  if (msg.type === 'text') return escapeHtml(msg.text || '');
  if (msg.type === 'image') return msg.localUrl ? `<img class="msg-media" src="${msg.localUrl}" alt="фото">` : '<span>⏳</span>';
  if (msg.type === 'video') return msg.localUrl ? `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>` : '<span>⏳</span>';
  if (msg.type === 'file') {
    if (msg.localUrl) return `<div class="msg-file"><span class="msg-file-icon">📄</span><div class="msg-file-info"><div class="msg-file-name">${escapeHtml(msg.fileName)}</div><div class="msg-file-size">${formatSize(msg.fileSize)}</div></div><a class="msg-file-dl" href="${msg.localUrl}" download="${escapeHtml(msg.fileName)}">⬇️</a></div>`;
    return '<div class="msg-file">⏳ Загрузка файла...</div>';
  }
  return '';
}

function buildReactionsHTML(msgId) {
  return `<div class="msg-reactions" data-msgid="${msgId}"></div>`;
}

function bindMediaEvents(container) {
  container.querySelectorAll('img.msg-media').forEach(img => { img.onclick = () => openLightbox('img', img.src); });
  container.querySelectorAll('video.msg-media').forEach(vid => { vid.ondblclick = () => openLightbox('video', vid.src); });
}

function bindUserEvents(container) {
  container.querySelectorAll('.msg-sender').forEach(el => {
    el.onclick = () => {
      const socketId = el.dataset.socketid;
      if (!socketId) return;
      const meta = getUserMeta(socketId);
      if (window.showUserProfile) window.showUserProfile(meta);
    };
  });
}

function bindMsgActions(container) {
  container.oncontextmenu = (e) => {
    e.preventDefault();
    const msgId = container.dataset.msgId;
    if (!msgId) return;
    openMsgMenu(e.clientX, e.clientY, msgId);
  };
}

function openMsgMenu(x, y, msgId) {
  const msg = messageStore.get(msgId);
  if (!msg) return;

  msgMenu.style.display = 'block';
  msgMenu.style.left = x + 'px';
  msgMenu.style.top = y + 'px';

  msgMenu.querySelector('[data-action="reply"]').onclick = () => {
    const preview = (msg.text || '').slice(0, 80);
    setReplyTarget({ id: msgId, preview });
    closeMsgMenu();
  };

  msgMenu.querySelector('[data-action="copy"]').onclick = () => {
    if (msg.text) navigator.clipboard.writeText(msg.text);
    closeMsgMenu();
  };

  msgMenu.querySelector('[data-action="edit"]').style.display = msg.mine ? 'block' : 'none';
  msgMenu.querySelector('[data-action="delete"]').style.display = msg.mine ? 'block' : 'none';

  msgMenu.querySelector('[data-action="edit"]').onclick = () => {
    if (!msg.text) return;
    chatInput.value = msg.text;
    chatInput.focus();
    editingMsgId = msgId;
    closeMsgMenu();
  };

  msgMenu.querySelector('[data-action="delete"]').onclick = () => {
    socket?.emit('message-delete', { msgId });
    const domId = msg.domId;
    markMessageDeleted(domId);
    closeMsgMenu();
  };

  msgMenu.querySelector('[data-action="pin"]').onclick = () => {
    socket?.emit('pin-message', { msgId });
    closeMsgMenu();
  };

  msgMenu.querySelector('[data-action="react"]').onclick = () => {
    openReactionPicker(x, y, msgId);
    closeMsgMenu();
  };
}

function closeMsgMenu() { msgMenu.style.display = 'none'; }

function openReactionPicker(x, y, msgId) {
  const picker = document.getElementById('reaction-picker');
  picker.style.display = 'flex';
  picker.style.left = x + 'px';
  picker.style.top = (y - 50) + 'px';
  picker.querySelectorAll('.reaction-item').forEach(item => {
    item.onclick = () => {
      toggleReactionLocal(msgId, item.textContent, window._currentUserId || 'me');
      socket?.emit('reaction-toggle', { msgId, emoji: item.textContent });
      picker.style.display = 'none';
    };
  });
}

function toggleReactionLocal(msgId, emoji, userId) {
  const reactionBox = document.querySelector(`.msg-reactions[data-msgid="${msgId}"]`);
  if (!reactionBox) return;
  let chip = reactionBox.querySelector(`[data-emoji="${emoji}"]`);
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'reaction-chip';
    chip.dataset.emoji = emoji;
    chip.dataset.users = JSON.stringify([userId]);
    chip.textContent = `${emoji} 1`;
    reactionBox.appendChild(chip);
  } else {
    let users = JSON.parse(chip.dataset.users || '[]');
    if (users.includes(userId)) {
      users = users.filter(u => u !== userId);
    } else {
      users.push(userId);
    }
    chip.dataset.users = JSON.stringify(users);
    if (users.length === 0) chip.remove();
    else chip.textContent = `${emoji} ${users.length}`;
  }
}

function setReplyTarget(target) {
  replyTarget = target;
  if (!target) {
    replyBar.style.display = 'none';
    replyText.textContent = '';
    return;
  }
  replyBar.style.display = 'flex';
  replyText.textContent = target.preview || 'Ответ';
}

function updateTyping(username, isTyping) {
  if (isTyping) typingSet.add(username);
  else typingSet.delete(username);

  if (typingSet.size === 0) {
    typingIndicator.textContent = '';
    typingIndicator.style.display = 'none';
  } else {
    typingIndicator.textContent = Array.from(typingSet).join(', ') + ' печатает...';
    typingIndicator.style.display = 'block';
  }
}

function updatePinnedBanner(msgId) {
  if (!msgId) {
    pinnedBanner.style.display = 'none';
    pinnedBanner.textContent = '';
    return;
  }
  const msg = messageStore.get(msgId);
  const text = msg?.text ? msg.text.slice(0, 80) : 'Закреплено сообщение';
  pinnedBanner.textContent = '📌 ' + text;
  pinnedBanner.style.display = 'block';
  pinnedBanner.onclick = () => {
    const domId = msg?.domId;
    if (domId) document.getElementById(domId)?.scrollIntoView({ behavior:'smooth', block:'center' });
  };
}

function openLightbox(type, src) {
  lightboxContent.innerHTML = type === 'img' ? `<img src="${src}" alt="">` : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ WEB-RTC
// ═══════════════════════════════════════════════
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: '4219a9030e911d3a21936639', credential: 'W9K/4EBqUUoxu9FC' }
  ]
};

function forceOpusMaxQuality(sdp) {
  const lines = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[1].split(' ')[0];
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) i++;
      result.push(`a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000`);
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

btnJoin?.addEventListener('click', async () => {
  if (!socket) return toast('❌ Нет соединения');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { 
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1
      }
    });
    
    await requestWakeLock(); 
    startKeepAlive(); 
    setMicStatus(true);
    
    btnJoin.style.display = 'none'; btnLeave.style.display = 'block'; btnMic.style.display = 'block';
    joined = true;
    
    addParticipant(socket.id, 'Вы');
    startVolumeAnalysis(socket.id, localStream);
    
    socket.emit('join');

    for (const peerId of window._roomPeers) {
      if (!peers[peerId]) {
        addParticipant(peerId, window._peerNames.get(peerId) || peerId.slice(0,6));
        peers[peerId] = createPeer(peerId, true);
      }
    }
    
    for (const { from, offer } of pendingOffers) await handleOffer(from, offer);
    pendingOffers = [];

  } catch(err) { toast('❌ Ошибка доступа к микрофону'); }
});

btnLeave?.addEventListener('click', () => {
  if (socket) socket.emit('leave');
  hangUp(); joined = false; resetVoiceUI(); releaseWakeLock(); stopKeepAlive();
});

btnMic?.addEventListener('click', () => {
  micEnabled = !micEnabled;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  setMicStatus(micEnabled);
  if (btnMic) btnMic.textContent = micEnabled ? '🔇 Выкл. микрофон' : '🎙 Вкл. микрофон';
});

function createPeer(userId, isInitiator) {
  const peer = new RTCPeerConnection(iceServers);
  if (localStream) localStream.getTracks().forEach(t => peer.addTrack(t, localStream));

  peer.ontrack = event => {
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio'); audio.id = 'audio-' + userId;
      audio.autoplay = true; audio.playsInline = true; hiddenAudios.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play().then(() => startVolumeAnalysis(userId, event.streams[0])).catch(e=>{});
  };

  peer.onicecandidate = e => { if (e.candidate && socket) socket.emit('ice-candidate', { to: userId, candidate: e.candidate }); };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      const offer = await peer.createOffer();
      const improvedOffer = { type: offer.type, sdp: forceOpusMaxQuality(offer.sdp) };
      await peer.setLocalDescription(improvedOffer);
      socket.emit('offer', { to: userId, offer: improvedOffer });
    };
  }
  return peer;
}

async function handleOffer(from, offer) {
  const peer = createPeer(from, false);
  peers[from] = peer;
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.createAnswer();
  const improvedAnswer = { type: answer.type, sdp: forceOpusMaxQuality(answer.sdp) };
  await peer.setLocalDescription(improvedAnswer);
  socket.emit('answer', { to: from, answer: improvedAnswer });
}

// ═══════════════════════════════════════════════
//  УТИЛИТЫ ГРОМКОСТИ И ВИЗУАЛИЗАЦИЯ
// ═══════════════════════════════════════════════
function addParticipant(userId, label) {
  if (document.getElementById('p-' + userId) || !participantsBox) return;
  participantsBox.style.display = 'block';
  const div = document.createElement('div'); div.className = 'participant'; div.id = 'p-' + userId;
  const isMe = socket && userId === socket.id;
  const avatar = isMe 
    ? null 
    : (window._peerAvatars.get(userId) || null);

  const avatarHtml = avatar 
    ? `<img class="p-avatar-img" src="${avatar}" alt="">` 
    : `<div class="p-avatar-fallback">${escapeHtml(label.slice(0,1).toUpperCase())}</div>`;

  div.innerHTML = `
    <div class="p-avatar">${avatarHtml}</div>
    <span class="participant-name">${escapeHtml(label)}</span>
    <div class="volume-bar-wrap"><div class="volume-bar" id="vol-${userId}"></div></div>
    ${isMe ? '' : `<button class="btn-understood" data-uid="${userId}">👍 Понял</button>`}
  `;
  participantsList.appendChild(div);
  
  const btn = div.querySelector('.btn-understood');
  if (btn) btn.onclick = () => { 
    socket?.emit('understood'); 
    btn.textContent = '✅ Отправлено'; 
    btn.disabled = true; 
    setTimeout(() => { btn.textContent = '👍 Понял'; btn.disabled = false; }, 3000); 
  };

  const nameEl = div.querySelector('.participant-name');
  if (nameEl && !isMe) {
    nameEl.onclick = () => {
      const meta = getUserMeta(userId);
      if (window.showUserProfile) window.showUserProfile(meta);
    };
  }
}

function removeParticipant(userId) {
  document.getElementById('p-' + userId)?.remove();
  if (participantsList && participantsList.children.length === 0) participantsBox.style.display = 'none';
}

function startVolumeAnalysis(userId, stream) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  stopVolumeAnalysis(userId);
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    if (!analysers[userId]) return;
    analyser.getByteFrequencyData(data); let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const pct = Math.min(100, (sum / data.length) * 3);
    const bar = document.getElementById('vol-' + userId);
    if (bar) { bar.style.width = pct + '%'; bar.className = 'volume-bar' + (pct > 60 ? ' loud' : ''); }
    analysers[userId].animFrame = requestAnimationFrame(tick);
  }
  analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
}

function stopVolumeAnalysis(userId) {
  if (analysers[userId]) { cancelAnimationFrame(analysers[userId].animFrame); try { analysers[userId].source.disconnect(); } catch(_) {} delete analysers[userId]; }
}

function stopQualityMonitor(id) {
  if (qualityTimers[id]) { clearInterval(qualityTimers[id]); delete qualityTimers[id]; }
}

// ═══════════════════════════════════════════════
//  СИСТЕМНЫЕ ЗВУКИ И WAKELOCK
// ═══════════════════════════════════════════════
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}
async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch(_) {} wakeLock = null; }
}

function startKeepAlive() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    const dest = audioCtx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true; src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream; keepAliveAudio.play().catch(e=>{});
  } catch(e) {}
}
function stopKeepAlive() { keepAliveAudio.srcObject = null; keepAliveAudio.pause(); }

function playBeep(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    if (type === 'join') { osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.setValueAtTime(900, ctx.currentTime + 0.12); } 
    else { osc.frequency.setValueAtTime(900, ctx.currentTime); osc.frequency.setValueAtTime(500, ctx.currentTime + 0.12); }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close();
  } catch(e) {}
}

function playOkSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain(); gain.connect(ctx.destination);
    [{ freq: 880, start: 0.00 }, { freq: 1100, start: 0.22 }].forEach(({ freq, start }) => {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.connect(gain);
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.20);
      osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + 0.22);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch(e) {}
}

function setMicStatus(active) { const el = document.getElementById('mic-status'); if(el) { el.textContent = active ? '🟢 Микрофон включен' : '🔴 Микрофон выключен'; el.className = 'mic-status ' + (active ? 'active' : 'muted'); } }
function resetVoiceUI() { if(btnJoin) btnJoin.style.display='block'; if(btnLeave) btnLeave.style.display='none'; if(btnMic) btnMic.style.display='none'; setMicStatus(false); }

// ═══════════════════════════════════════════════
//  ПОЛНАЯ ОЧИСТКА ПРИ ВЫХОДЕ ИЗ ЗВОНКА/КОМНАТЫ
// ═══════════════════════════════════════════════
function hangUp() {
  Object.keys(analysers).forEach(id => stopVolumeAnalysis(id));
  Object.values(peers).forEach(p  => p.close());
  peers = {};

  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }

  if (hiddenAudios) hiddenAudios.innerHTML = '';
  pendingOffers = [];
  if (participantsList) participantsList.innerHTML = '';
  if (participantsBox) participantsBox.style.display = 'none';
  micEnabled = true;

  if (window.stopVideo) window.stopVideo(); 
}

document.addEventListener('click', () => closeMsgMenu());

window.initSocket  = initSocket;
window.socketLeave = socketLeave;
