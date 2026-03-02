// ═══════════════════════════════════════════════
//  CRYPTO
// ═══════════════════════════════════════════════
const Crypto = (() => {
  let roomKey = null;
  const sessionKeys = {};
  let myEcdhKeyPair = null;

  async function deriveKey(password, roomId, roomSalt) {
    const enc    = new TextEncoder();
    const secret = (password || 'open') + '|' + roomId;
    const keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const saltBytes = enc.encode(roomSalt + 'voicechat-v3');
    roomKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 200000, hash: 'SHA-256' },
      keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    return roomKey;
  }

  async function generateEcdhKeyPair() {
    myEcdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
    );
    return myEcdhKeyPair;
  }

  async function exportPublicKey() {
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const raw = await crypto.subtle.exportKey('raw', myEcdhKeyPair.publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  }

  async function deriveSessionKey(theirPubKeyB64, peerId) {
    const raw      = Uint8Array.from(atob(theirPubKeyB64), c => c.charCodeAt(0));
    const theirKey = await crypto.subtle.importKey(
      'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirKey }, myEcdhKeyPair.privateKey, 256
    );
    const keyMat = await crypto.subtle.importKey(
      'raw', sharedBits, { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const enc = new TextEncoder();
    sessionKeys[peerId] = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('ecdh-session-v1'), iterations: 1, hash: 'SHA-256' },
      keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    return sessionKeys[peerId];
  }

  async function getKeyFingerprint() {
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const raw  = await crypto.subtle.exportKey('raw', myEcdhKeyPair.publicKey);
    const hash = await crypto.subtle.digest('SHA-256', raw);
    const hex  = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{4}/g).slice(0, 8).join(' ').toUpperCase();
  }

  function getSessionKey(peerId)   { return sessionKeys[peerId] || null; }
  function clearSessionKey(peerId) { delete sessionKeys[peerId]; }

  async function encrypt(data, key) {
    const useKey  = key || roomKey;
    const iv      = crypto.getRandomValues(new Uint8Array(12));
    const encoded = typeof data === 'string'
      ? new TextEncoder().encode(data) : new Uint8Array(data);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, useKey, encoded);
    return {
      iv:        btoa(String.fromCharCode(...iv)),
      encrypted: btoa(String.fromCharCode(...new Uint8Array(cipher)))
    };
  }

  async function decrypt(encB64, ivB64, key) {
    const useKey = key || roomKey;
    const iv     = Uint8Array.from(atob(ivB64),  c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, useKey, cipher);
  }

  async function decryptText(encB64, ivB64, key) {
    return new TextDecoder().decode(await decrypt(encB64, ivB64, key));
  }

  async function decryptBlob(encB64, ivB64, mime, key) {
    return new Blob([await decrypt(encB64, ivB64, key)], { type: mime });
  }

  function clearAllKeys() {
    roomKey = null; myEcdhKeyPair = null;
    for (const k in sessionKeys) delete sessionKeys[k];
  }

  return {
    deriveKey, encrypt, decryptText, decryptBlob,
    generateEcdhKeyPair, exportPublicKey, deriveSessionKey,
    getKeyFingerprint, getSessionKey, clearSessionKey, clearAllKeys
  };
})();

// ═══════════════════════════════════════════════
//  SOCKET
// ═══════════════════════════════════════════════
const socket = io({
  reconnection: true, reconnectionAttempts: Infinity,
  reconnectionDelay: 1000, reconnectionDelayMax: 5000,
  timeout: 20000, transports: ['websocket', 'polling'], autoConnect: true,
});

// ═══════════════════════════════════════════════
//  DOM — все элементы берём через функцию,
//  чтобы не упасть если элемент не найден
// ═══════════════════════════════════════════════
function $(id) { return document.getElementById(id); }

const screenAuth  = $('screen-auth');
const screenLobby = $('screen-lobby');
const screenMain  = $('screen-main');

const tabLogin     = $('tab-login');
const tabRegister  = $('tab-register');
const formLogin    = $('form-login');
const formRegister = $('form-register');
const loginNick    = $('login-nick');
const loginPw      = $('login-pw');
const loginError   = $('login-error');
const btnLogin     = $('btn-login');
const btnShowHint  = $('btn-show-hint');
const regNick      = $('reg-nick');
const regPw        = $('reg-pw');
const regHint      = $('reg-hint');
const regError     = $('reg-error');
const btnRegister  = $('btn-register');

const drawer        = $('drawer');
const drawerOverlay = $('drawer-overlay');
const drawerAvatar  = $('drawer-avatar');
const drawerName    = $('drawer-name');
const drawerNick    = $('drawer-nick');

const btnOpenProfile = $('btn-open-profile');
const roomsList      = $('rooms-list');
const privateList    = $('private-list');
const btnCreateRoom  = $('btn-create-room');

const lobbyTabGroups  = $('lobby-tab-groups');
const lobbyTabPrivate = $('lobby-tab-private');

const chatRoomsList   = $('chat-rooms-list');
const chatPrivateList = $('chat-private-list');
const chatTabGroups   = $('chat-tab-groups');
const chatTabPrivate  = $('chat-tab-private');

const modalCreate       = $('modal-create-room');
const btnCloseCreate    = $('btn-close-create');
const roomPhotoBtn      = $('room-photo-btn');
const roomPhotoInput    = $('room-photo-input');
const createRoomName    = $('create-room-name');
const createRoomPw      = $('create-room-pw');
const btnToggleCreatePw = $('btn-toggle-create-pw');
const createRoomError   = $('create-room-error');
const btnSubmitCreate   = $('btn-submit-create');
const createAutoDelete  = $('create-room-autodelete');
const createJoinMode    = $('create-room-joinmode');

const modalRoomPw     = $('modal-room-password');
const btnClosePwModal = $('btn-close-pw-modal');
const pwModalRoomName = $('pw-modal-room-name');
const roomPwInput     = $('room-pw-input');
const btnToggleRoomPw = $('btn-toggle-room-pw');
const roomPwError     = $('room-pw-error');
const btnSubmitRoomPw = $('btn-submit-room-pw');

const modalProfile         = $('modal-profile');
const btnCloseProfile      = $('btn-close-profile');
const profileAvatarDisplay = $('profile-avatar-display');
const profileAvatarWrap    = $('profile-avatar-wrap');
const profileNameDisplay   = $('profile-name-display');
const profileEditName      = $('profile-edit-name');
const profileEditBio       = $('profile-edit-bio');
const btnSaveProfile       = $('btn-save-profile');
const friendsListContainer = $('friends-list-container');
const friendReqContainer   = $('friend-requests-container');
const friendSearchInput    = $('friend-search-input');
const btnFriendSearch      = $('btn-friend-search');
const friendSearchResult   = $('friend-search-result');
const btnLogout            = $('btn-logout');
const avatarInput          = $('avatar-input');

const modalSettings    = $('modal-settings');
const btnCloseSettings = $('btn-close-settings');

const modalContacts        = $('modal-contacts');
const btnCloseContacts     = $('btn-close-contacts');
const contactsFriendsList  = $('contacts-friends-list');
const contactsReqList      = $('contacts-requests-list');
const contactsSearchInput  = $('contacts-search-input');
const btnContactsSearch    = $('btn-contacts-search');
const contactsSearchResult = $('contacts-search-result');

const modalPrivateChats = $('modal-private-chats');
const btnClosePrivChats = $('btn-close-private-chats');
const pcSearchInput     = $('pc-search-input');
const btnPcSearch       = $('btn-pc-search');
const pcListContainer   = $('pc-list-container');

const modalMembers         = $('modal-members');
const btnCloseMembers      = $('btn-close-members');
const membersModalTitle    = $('members-modal-title');
const renameSection        = $('rename-section');
const renameInput          = $('rename-input');
const btnRenameRoom        = $('btn-rename-room');
const renameError          = $('rename-error');
const membersListContainer = $('members-list-container');
const groupSettingsSection = $('group-settings-section');
const groupAutodelSelect   = $('group-autodelete-select');
const groupJoinmodeSelect  = $('group-joinmode-select');
const btnSaveGroupSettings = $('btn-save-group-settings');
const btnDeleteGroup       = $('btn-delete-group');
const joinRequestsSection  = $('join-requests-section');
const joinRequestsCount    = $('join-requests-count');
const joinRequestsList     = $('join-requests-list');

const modalInvite       = $('modal-invite');
const btnCloseInvite    = $('btn-close-invite');
const inviteFriendsList = $('invite-friends-list');

const chatRoomAvatar  = $('chat-room-avatar');
const chatRoomName    = $('chat-room-name');
const chatHeaderInfo  = $('chat-header-info');
const userCount       = $('user-count');
const btnBackLobby    = $('btn-back-lobby');
const btnJoin         = $('btn-join');
const btnLeave        = $('btn-leave');
const btnMic          = $('btn-mic');
const micStatus       = $('mic-status');
const hiddenAudios    = $('hidden-audios');
const participantsBox = $('participants');
const participantsList= $('participants-list');
const reconnectBanner = $('reconnect-banner');
const keepAliveAudio  = $('keep-alive-audio');
const chatMessages    = $('chat-messages');
const chatInput       = $('chat-input');
const btnSend         = $('btn-send');
const btnPhoto        = $('btn-photo');
const btnVideo        = $('btn-video');
const btnFile         = $('btn-file');
const fileInput       = $('file-input');
const lightbox        = $('lightbox');
const lightboxContent = $('lightbox-content');
const lightboxClose   = $('lightbox-close');
const noiseIndicator  = $('noise-indicator');
const btnRoomMembers  = $('btn-room-members');
const btnInviteFriend = $('btn-invite-friend');

const callScreen       = $('call-screen');
const callScreenAvatar = $('call-screen-avatar');
const callScreenName   = $('call-screen-name');
const callScreenStatus = $('call-screen-status');
const callStatusDot    = $('call-status-dot');
const callBtnSpeaker   = $('call-btn-speaker');
const callBtnVideo     = $('call-btn-video');
const callBtnMute      = $('call-btn-mute');
const callBtnHangup    = $('call-btn-hangup');
const btnCallMinimize  = $('btn-call-minimize');

const modalIncomingCall = $('modal-incoming-call');
const incomingCallAvatar= $('incoming-call-avatar');
const incomingCallName  = $('incoming-call-name');
const btnCallAccept     = $('btn-call-accept');
const btnCallReject     = $('btn-call-reject');
const btnPrivateCall    = $('btn-private-call');

// ═══════════════════════════════════════════════
//  СОСТОЯНИЕ
// ═══════════════════════════════════════════════
let myNickname      = '';
let myAvatar        = null;
let authToken       = null;
let currentRoomId   = null;
let currentRoomData = null;
let currentPassword = '';
let pendingJoinRoom = null;
let roomPhotoData   = null;
let memberCount     = 0;
let isRoomOwner     = false;
let currentChatType = 'group';
let currentChatId   = null;

let localStream     = null;
let processedStream = null;
let noiseWorklet    = null;
let peers           = {};
let micEnabled      = true;
let pendingOffers   = [];
let joined          = false;
let audioCtx        = null;
let wakeLock        = null;
let msgCounter      = 0;
let outgoingSeq     = 0;

const voiceNicknames   = {};
const analysers        = {};
const qualityTimers    = {};
const SPEAKING_THRESHOLD = 8;

const typingUsers  = {};
let typingTimer    = null;
const ecdhExchanged = new Set();
const privateChatCache = {};

// ─────────────────────────────
//  УТИЛИТЫ
// ─────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatSize(bytes) {
  if (bytes < 1024)    return bytes + ' Б';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' КБ';
  return (bytes/1048576).toFixed(1) + ' МБ';
}
function shortId(id) { return id ? id.slice(0,6) : '??'; }
function formatCountdown(msLeft) {
  if (msLeft <= 0) return '00:00';
  const s = Math.floor(msLeft/1000);
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}

// ─────────────────────────────
//  FIX: Правильный скролл вниз
// ─────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => {
    if (chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    // Обновляем layout (на мобиле пересчитываем отступы)
    if (window._updateChatLayout) window._updateChatLayout();
  });
}

function showScreen(name) {
  [screenAuth, screenLobby, screenMain].forEach(s => { if(s) s.classList.remove('active'); });
  if (name === 'auth'  && screenAuth)  screenAuth.classList.add('active');
  if (name === 'lobby' && screenLobby) screenLobby.classList.add('active');
  if (name === 'chat'  && screenMain)  {
    screenMain.classList.add('active');
    screenMain.style.height = '';
    screenMain.style.top    = '';
  }
  updateCallButton();
}

function avatarHtml(avatar, fallback = '👤', size = '100%') {
  if (avatar) return `<img src="${avatar}" alt="" style="width:${size};height:${size};object-fit:cover">`;
  return fallback;
}

// ─────────────────────────────
//  TOAST
// ─────────────────────────────
function showToast(text, duration = 3000, onClick = null) {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (onClick ? ' invite-toast' : '');
  el.textContent = text;
  if (onClick) el.addEventListener('click', () => { onClick(); el.remove(); });
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
  return el;
}

function playMsgSound() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.06);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => ctx.close();
  } catch (_) {}
}

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    Notification.requestPermission();
}
function showBrowserNotif(title, body) {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icon.png', silent: false });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 5000);
  } catch (_) {}
}

// ─────────────────────────────
//  DRAWER
// ─────────────────────────────
function openDrawer()  { drawer.classList.add('open');    drawerOverlay.classList.add('open'); }
function closeDrawer() { drawer.classList.remove('open'); drawerOverlay.classList.remove('open'); }

$('btn-open-drawer').addEventListener('click', openDrawer);
$('btn-open-drawer-chat').addEventListener('click', openDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

function updateDrawer() {
  if (drawerName) drawerName.textContent = myNickname || '—';
  if (drawerNick) drawerNick.textContent = myNickname ? '@' + myNickname.toLowerCase() : '';
  if (!drawerAvatar) return;
  if (myAvatar) {
    drawerAvatar.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    drawerAvatar.textContent = '👤';
  }
}

$('dm-profile').addEventListener('click',       () => { closeDrawer(); openProfileModal(); });
$('dm-contacts').addEventListener('click',      () => { closeDrawer(); openContactsModal(); });
$('dm-private-chats').addEventListener('click', () => { closeDrawer(); openPrivateChatsModal(); });
$('dm-create-group').addEventListener('click',  () => { closeDrawer(); openCreateRoomModal(); });
$('dm-settings').addEventListener('click',      () => { closeDrawer(); modalSettings.classList.add('open'); });
$('dm-invite').addEventListener('click',        () => { closeDrawer(); showToast('🔗 Поделись ссылкой на сайт!', 4000); });
drawerAvatar.addEventListener('click', () => { closeDrawer(); openProfileModal(); });

function updateLobbyAvatarBtn() {
  if (!btnOpenProfile) return;
  if (myAvatar) {
    btnOpenProfile.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    btnOpenProfile.textContent = '👤';
  }
  updateDrawer();
}

// ═══════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════
tabLogin.addEventListener('click',    () => switchTab('login'));
tabRegister.addEventListener('click', () => switchTab('register'));

function switchTab(tab) {
  if (tab === 'login') {
    tabLogin.classList.add('active');    tabRegister.classList.remove('active');
    formLogin.style.display = '';        formRegister.style.display = 'none';
  } else {
    tabRegister.classList.add('active'); tabLogin.classList.remove('active');
    formRegister.style.display = '';     formLogin.style.display = 'none';
  }
}

// Автологин
(function tryAutoLogin() {
  try {
    const token = localStorage.getItem('chat_token');
    if (!token) return;
    const doAuth = () => {
      socket.emit('auth-token', { token }, res => {
        if (res.ok) {
          authToken  = token;
          myNickname = res.nickname;
          myAvatar   = res.avatar || null;
          onAuthSuccess();
        }
      });
    };
    if (socket.connected) doAuth();
    else socket.once('connect', doAuth);
  } catch (_) {}
})();

btnLogin.addEventListener('click', doLogin);
loginNick.addEventListener('keydown', e => { if (e.key === 'Enter') loginPw.focus(); });
loginPw.addEventListener('keydown',   e => { if (e.key === 'Enter') doLogin(); });

function doLogin() {
  const nick = loginNick.value.trim();
  const pw   = loginPw.value;
  if (!nick) { loginError.textContent = 'Введи ник'; return; }
  if (!pw)   { loginError.textContent = 'Введи пароль'; return; }
  btnLogin.disabled = true; btnLogin.textContent = '⏳';
  socket.emit('auth-login', { nickname: nick, password: pw }, res => {
    btnLogin.disabled = false; btnLogin.textContent = 'Войти';
    if (res.ok) {
      authToken = res.token; myNickname = res.nickname; myAvatar = res.avatar || null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = {
        wrong_creds:  '❌ Неверный ник или пароль',
        rate_limited: `⛔ Подождите ${res.secsLeft} сек.`
      };
      loginError.textContent = msgs[res.error] || '⚠️ Ошибка входа';
      loginPw.style.animation = 'shake 0.35s';
      setTimeout(() => { loginPw.style.animation = ''; }, 400);
    }
  });
}

btnRegister.addEventListener('click', doRegister);
regNick.addEventListener('keydown',  e => { if (e.key === 'Enter') regPw.focus(); });
regPw.addEventListener('keydown',    e => { if (e.key === 'Enter') regHint.focus(); });
regHint.addEventListener('keydown',  e => { if (e.key === 'Enter') doRegister(); });

function doRegister() {
  const nick = regNick.value.trim();
  const pw   = regPw.value;
  const hint = regHint.value.trim();
  if (!nick || nick.length < 2) { regError.textContent = 'Ник минимум 2 символа'; return; }
  if (!pw || pw.length < 4)     { regError.textContent = 'Пароль минимум 4 символа'; return; }
  btnRegister.disabled = true; btnRegister.textContent = '⏳';
  socket.emit('auth-register', { nickname: nick, password: pw, hint }, res => {
    btnRegister.disabled = false; btnRegister.textContent = 'Создать аккаунт';
    if (res.ok) {
      authToken = res.token; myNickname = res.nickname; myAvatar = null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = {
        nick_taken:  '❌ Ник занят',
        nick_short:  '❌ Ник слишком короткий',
        pw_short:    '❌ Пароль слишком короткий'
      };
      regError.textContent = msgs[res.error] || '⚠️ Ошибка';
    }
  });
}

btnShowHint.addEventListener('click', () => {
  const nick = loginNick.value.trim();
  if (!nick) { loginError.textContent = 'Сначала введи ник'; return; }
  socket.emit('auth-get-hint', { nickname: nick }, res => {
    if (!res.ok) { loginError.textContent = '❌ Не найден'; return; }
    showToast(res.hint ? '💡 Подсказка: ' + res.hint : 'Подсказка не задана', 6000);
  });
});

function onAuthSuccess() {
  socket.emit('set-nickname', myNickname, () => {});
  updateLobbyAvatarBtn();
  showScreen('lobby');
  renderRoomListInChat([]);
  loadPrivateChatsList();
  requestNotifPermission();
}

btnLogout.addEventListener('click', doLogout);
$('settings-go-logout').addEventListener('click', doLogout);
function doLogout() {
  socket.emit('auth-logout', { token: authToken }, () => {});
  try { localStorage.removeItem('chat_token'); } catch (_) {}
  authToken = null; myNickname = ''; myAvatar = null;
  if (modalProfile) modalProfile.classList.remove('open');
  if (modalSettings) modalSettings.classList.remove('open');
  showScreen('auth');
}

// ═══════════════════════════════════════════════
//  LOBBY TABS
// ═══════════════════════════════════════════════
lobbyTabGroups.addEventListener('click', () => {
  lobbyTabGroups.classList.add('active'); lobbyTabPrivate.classList.remove('active');
  roomsList.style.display = ''; privateList.style.display = 'none';
});
lobbyTabPrivate.addEventListener('click', () => {
  lobbyTabPrivate.classList.add('active'); lobbyTabGroups.classList.remove('active');
  privateList.style.display = ''; roomsList.style.display = 'none';
  loadPrivateChatsList();
});

if (chatTabGroups) chatTabGroups.addEventListener('click', () => {
  chatTabGroups.classList.add('active'); chatTabPrivate.classList.remove('active');
  chatRoomsList.style.display = ''; chatPrivateList.style.display = 'none';
});
if (chatTabPrivate) chatTabPrivate.addEventListener('click', () => {
  chatTabPrivate.classList.add('active'); chatTabGroups.classList.remove('active');
  chatPrivateList.style.display = ''; chatRoomsList.style.display = 'none';
  loadPrivateChatsList(chatPrivateList);
});

// ═══════════════════════════════════════════════
//  ПРОФИЛЬ
// ═══════════════════════════════════════════════
if (btnOpenProfile) btnOpenProfile.addEventListener('click', openProfileModal);
if (btnCloseProfile) btnCloseProfile.addEventListener('click', () => modalProfile.classList.remove('open'));
if (modalProfile) modalProfile.addEventListener('click', e => {
  if (e.target === modalProfile) modalProfile.classList.remove('open');
});

function openProfileModal() {
  if (!modalProfile) return;
  if (profileNameDisplay) profileNameDisplay.textContent = myNickname;
  if (profileEditName)    profileEditName.value = myNickname;
  renderProfileAvatar();
  modalProfile.classList.add('open');
  loadFriends();
  socket.emit('profile-get', res => {
    if (res.ok && profileEditBio) profileEditBio.value = res.bio || '';
  });
}

function renderProfileAvatar() {
  if (!profileAvatarDisplay) return;
  if (myAvatar) profileAvatarDisplay.innerHTML = `<img src="${myAvatar}" alt="">`;
  else profileAvatarDisplay.textContent = '👤';
}

if (btnSaveProfile) btnSaveProfile.addEventListener('click', () => {
  const newName = profileEditName ? profileEditName.value.trim() : '';
  const newBio  = profileEditBio  ? profileEditBio.value.trim()  : '';
  socket.emit('profile-update', { nickname: newName, bio: newBio }, res => {
    if (res.ok) {
      myNickname = res.nickname;
      if (profileNameDisplay) profileNameDisplay.textContent = myNickname;
      updateLobbyAvatarBtn();
      showToast('✅ Профиль сохранён');
    }
  });
});

if (profileAvatarWrap) profileAvatarWrap.addEventListener('click', () => { if(avatarInput) avatarInput.click(); });
if (avatarInput) avatarInput.addEventListener('change', () => {
  const file = avatarInput.files[0]; if (!file) return;
  avatarInput.value = '';
  if (file.size > 5 * 1024 * 1024) { showToast('⚠️ Фото слишком большое'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    myAvatar = e.target.result;
    renderProfileAvatar(); updateLobbyAvatarBtn();
    socket.emit('profile-set-avatar', { avatar: myAvatar }, res => {
      if (res.ok) showToast('✅ Аватар обновлён');
    });
  };
  reader.readAsDataURL(file);
});

function loadFriends() {
  socket.emit('friends-list', res => {
    if (!res.ok) return;
    if (friendsListContainer) renderFriendsList(res.friends, friendsListContainer);
    if (friendReqContainer)   renderFriendRequests(res.requests, friendReqContainer);
  });
}

function renderFriendsList(friends, container) {
  if (!container) return;
  if (!friends.length) { container.innerHTML = '<div class="empty-list">Друзей пока нет</div>'; return; }
  container.innerHTML = friends.map(f => `
    <div class="friend-item">
      <div class="friend-avatar">${avatarHtml(f.avatar, '👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(f.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm blue" data-action="private-chat"  data-nick="${escapeHtml(f.nickname)}">💬</button>
        <button class="btn-sm red"  data-action="remove-friend" data-nick="${escapeHtml(f.nickname)}">✕</button>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('[data-action="remove-friend"]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('friend-remove', { nickname: btn.dataset.nick }, res => {
        if (res.ok) { loadFriends(); showToast('Удалён из друзей'); }
      });
    });
  });
  container.querySelectorAll('[data-action="private-chat"]').forEach(btn => {
    btn.addEventListener('click', () => openPrivateChatWith(btn.dataset.nick));
  });
}

function renderFriendRequests(requests, container) {
  if (!container) return;
  if (!requests.length) { container.innerHTML = '<div class="empty-list">Нет входящих запросов</div>'; return; }
  container.innerHTML = requests.map(r => `
    <div class="friend-item">
      <div class="friend-avatar">${avatarHtml(r.avatar, '👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(r.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm green" data-action="accept"  data-nick="${escapeHtml(r.nickname)}">✓</button>
        <button class="btn-sm red"   data-action="decline" data-nick="${escapeHtml(r.nickname)}">✕</button>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const accept = btn.dataset.action === 'accept';
      socket.emit('friend-respond', { fromNickname: btn.dataset.nick, accept }, res => {
        if (res.ok) { loadFriends(); showToast(accept ? '✅ Добавлен!' : 'Отклонено'); }
      });
    });
  });
}

if (btnFriendSearch) btnFriendSearch.addEventListener('click', () =>
  searchUserForFriend(friendSearchInput, friendSearchResult));
if (friendSearchInput) friendSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') searchUserForFriend(friendSearchInput, friendSearchResult);
});

function searchUserForFriend(inputEl, resultEl) {
  if (!inputEl || !resultEl) return;
  const nick = inputEl.value.trim();
  if (!nick) return;
  socket.emit('profile-get-user', { nickname: nick }, res => {
    if (!res.ok) { resultEl.innerHTML = '<div class="empty-list">❌ Не найден</div>'; return; }
    resultEl.innerHTML = `
      <div class="friend-item">
        <div class="friend-avatar">${avatarHtml(res.avatar, '👤')}</div>
        <div class="friend-info">
          <div class="friend-name">${escapeHtml(res.nickname)}</div>
          ${res.bio ? `<div style="font-size:12px;color:var(--sub)">${escapeHtml(res.bio)}</div>` : ''}
        </div>
        <div class="friend-actions">
          <button class="btn-sm blue" id="btn-add-found-res">➕</button>
        </div>
      </div>`;
    resultEl.querySelector('.btn-sm').addEventListener('click', () => {
      socket.emit('friend-request', { toNickname: res.nickname }, r => {
        const msgs = {
          already_friends: '✅ Уже в друзьях',
          already_sent:    '⏳ Уже отправлено',
          self:            '😄 Нельзя',
          not_found:       '❌ Не найден'
        };
        showToast(r.ok ? '📨 Запрос отправлен!' : (msgs[r.error] || '⚠️ Ошибка'));
        if (r.ok) resultEl.innerHTML = '';
      });
    });
  });
}

socket.on('friend-request-incoming', ({ fromNick }) => {
  showToast(`👋 ${fromNick} хочет добавить тебя в друзья`, 6000, () => {
    socket.emit('friend-respond', { fromNickname: fromNick, accept: true }, res => {
      if (res.ok) { showToast('✅ Добавлен!'); loadFriends(); }
    });
  });
  if (modalProfile && modalProfile.classList.contains('open')) loadFriends();
  if (modalContacts && modalContacts.classList.contains('open')) loadContactsFriends();
});
socket.on('friend-accepted', ({ byNick }) => {
  showToast(`✅ ${byNick} принял запрос!`, 5000);
  if (modalProfile && modalProfile.classList.contains('open')) loadFriends();
  if (modalContacts && modalContacts.classList.contains('open')) loadContactsFriends();
});

// ═══════════════════════════════════════════════
//  НАСТРОЙКИ
// ═══════════════════════════════════════════════
if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => modalSettings.classList.remove('open'));
if (modalSettings) modalSettings.addEventListener('click', e => {
  if (e.target === modalSettings) modalSettings.classList.remove('open');
});
$('settings-go-profile').addEventListener('click', () => { modalSettings.classList.remove('open'); openProfileModal(); });
$('settings-go-privacy').addEventListener('click', () => showToast('🔒 Раздел в разработке'));
$('settings-go-notifs').addEventListener('click',  () => {
  requestNotifPermission();
  showToast('🔔 Уведомления: ' + (Notification.permission === 'granted' ? 'включены' : 'выкл'));
});
$('settings-go-data').addEventListener('click',  () => showToast('💾 Раздел в разработке'));
$('settings-go-lang').addEventListener('click',  () => showToast('🌐 Язык: Русский'));
$('settings-go-chats').addEventListener('click', () => showToast('💬 Раздел в разработке'));

// ═══════════════════════════════════════════════
//  КОНТАКТЫ
// ═══════════════════════════════════════════════
function openContactsModal() {
  if (!modalContacts) return;
  modalContacts.classList.add('open'); loadContactsFriends();
}
if (btnCloseContacts) btnCloseContacts.addEventListener('click', () => modalContacts.classList.remove('open'));
if (modalContacts) modalContacts.addEventListener('click', e => {
  if (e.target === modalContacts) modalContacts.classList.remove('open');
});
if (btnContactsSearch) btnContactsSearch.addEventListener('click', () =>
  searchUserForFriend(contactsSearchInput, contactsSearchResult));
if (contactsSearchInput) contactsSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') searchUserForFriend(contactsSearchInput, contactsSearchResult);
});

function loadContactsFriends() {
  socket.emit('friends-list', res => {
    if (!res.ok) return;
    if (contactsFriendsList) renderFriendsList(res.friends, contactsFriendsList);
    if (contactsReqList)     renderFriendRequests(res.requests, contactsReqList);
  });
}

// ═══════════════════════════════════════════════
//  ЛИЧНЫЕ ЧАТЫ
// ═══════════════════════════════════════════════
function openPrivateChatsModal() {
  if (!modalPrivateChats) return;
  modalPrivateChats.classList.add('open');
  loadPrivateChatsList(pcListContainer);
}
if (btnClosePrivChats) btnClosePrivChats.addEventListener('click', () => modalPrivateChats.classList.remove('open'));
if (modalPrivateChats) modalPrivateChats.addEventListener('click', e => {
  if (e.target === modalPrivateChats) modalPrivateChats.classList.remove('open');
});

if (btnPcSearch) btnPcSearch.addEventListener('click', () => {
  const nick = pcSearchInput ? pcSearchInput.value.trim() : '';
  if (!nick) return;
  openPrivateChatWith(nick);
  modalPrivateChats.classList.remove('open');
});
if (pcSearchInput) pcSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const nick = pcSearchInput.value.trim();
    if (!nick) return;
    openPrivateChatWith(nick);
    modalPrivateChats.classList.remove('open');
  }
});

// FIX 3: Закрываем все модалки перед открытием чата
function closeAllModals() {
  [modalContacts, modalPrivateChats, modalProfile,
   modalMembers, modalInvite, modalSettings,
   modalCreate, modalRoomPw].forEach(m => {
    if (m) m.classList.remove('open');
  });
}

function openPrivateChatWith(nickname) {
  closeAllModals();
  socket.emit('private-chat-open', { withNickname: nickname }, res => {
    if (!res.ok) { showToast('❌ Пользователь не найден'); return; }
    enterPrivateChat(res.chatId, res.withNickname, res.withAvatar);
  });
}

async function enterPrivateChat(chatId, withNickname, withAvatar) {
  if (currentRoomId) {
    socket.emit('leave-room');
    if (joined) { socket.emit('voice-leave'); hangUp(); joined = false; }
    currentRoomId = null; currentRoomData = null;
  }

  closeAllModals();

  currentChatType = 'private';
  currentChatId   = chatId;
  isRoomOwner     = false;
  memberCount     = 2;

  try {
    await Crypto.deriveKey('', chatId, chatId + '-private-v1');
  } catch (e) { console.error('Ошибка деривации ключа:', e); }

  if (chatRoomName)    chatRoomName.textContent = withNickname;
  if (userCount)       userCount.textContent    = '2';
  if (chatRoomAvatar)  chatRoomAvatar.innerHTML = withAvatar
    ? `<img src="${withAvatar}" alt="">` : '👤';

  clearChat(); clearAllTyping();

  if (btnJoin)  btnJoin.style.display  = 'none';
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic)   btnMic.style.display   = 'none';

  socket.emit('private-chat-join', { chatId });
  showScreen('chat');
  await loadPrivateChatHistory(chatId);
}

async function loadPrivateChatHistory(chatId) {
  return new Promise(resolve => {
    socket.emit('private-chat-history', { chatId }, async res => {
      if (!res.ok || !res.messages || !res.messages.length) { resolve(); return; }
      for (const msg of res.messages) {
        const mine = msg.from === myNickname.toLowerCase();
        if (msg.type === 'text') {
          try {
            const text = await Crypto.decryptText(msg.encrypted, msg.iv);
            appendMessage({ nickname: msg.fromNick, text, type: 'text', timestamp: msg.timestamp, mine, status: 'ok' });
          } catch (_) {
            appendMessage({ nickname: msg.fromNick, text: '[зашифровано]', type: 'text', timestamp: msg.timestamp, mine, status: 'error' });
          }
        } else {
          appendMessage({ nickname: msg.fromNick, type: msg.type, fileName: msg.fileName, fileSize: msg.fileSize, mimeType: msg.mimeType, timestamp: msg.timestamp, mine, status: 'ok' });
        }
      }
      resolve();
    });
  });
}

function loadPrivateChatsList(container) {
  const el = container || privateList;
  if (!el) return;
  socket.emit('private-chat-list', res => {
    if (!res.ok || !res.chats.length) {
      el.innerHTML = `<div class="rooms-empty">
        <div class="rooms-empty-icon">💬</div>
        <div>Нет личных чатов.<br>Найди друга и начни общение!</div>
      </div>`;
      return;
    }
    el.innerHTML = res.chats.map(c => `
      <div class="pc-card" data-chatid="${c.chatId}"
           data-with="${escapeHtml(c.withNickname)}"
           data-avatar="${escapeHtml(c.withAvatar||'')}">
        <div class="room-avatar">
          ${c.withAvatar ? `<img src="${c.withAvatar}" alt="">` : '👤'}
        </div>
        <div class="room-info">
          <div class="room-name">${escapeHtml(c.withNickname)}</div>
          <div class="room-meta" style="color:var(--green2)">💬 Личный чат</div>
        </div>
        <div class="room-arrow">›</div>
      </div>
    `).join('');
    el.querySelectorAll('.pc-card').forEach(card => {
      card.addEventListener('click', () => {
        closeAllModals();
        enterPrivateChat(card.dataset.chatid, card.dataset.with, card.dataset.avatar || null);
      });
    });
  });
}

socket.on('private-message', async data => {
  if (currentChatType !== 'private' || currentChatId !== data.chatId) {
    showToast('💬 ' + (data.fromNick || '?') + ': новое сообщение', 4000, () => {
      enterPrivateChat(data.chatId, data.fromNick, data.fromAvatar);
    });
    return;
  }
  playMsgSound();
  const msgId = appendMessage({
    from: data.from, nickname: data.fromNick, type: data.type,
    fileName: data.fileName, fileSize: data.fileSize, mimeType: data.mimeType,
    timestamp: data.timestamp, mine: false, status: 'decrypting'
  });
  try {
    if (data.type === 'text') {
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      updateMessage(msgId, { text, status: 'ok' });
      showBrowserNotif('💬 ' + (data.fromNick || '?'), text);
    } else {
      const mime = data.mimeType || 'application/octet-stream';
      const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
      updateMessage(msgId, { localUrl: URL.createObjectURL(blob), status: 'ok' });
    }
  } catch (e) {
    console.error('Decrypt private msg error:', e);
    updateMessage(msgId, { status: 'error' });
  }
});

// ═══════════════════════════════════════════════
//  СПИСОК КОМНАТ
// ═══════════════════════════════════════════════
socket.on('room-list', list => {
  renderRoomList(list, roomsList);
  renderRoomListInChat(list);
});

const roomDeleteTimersMap = {};
function clearAllDeleteTimers() {
  for (const id in roomDeleteTimersMap) {
    clearInterval(roomDeleteTimersMap[id]); delete roomDeleteTimersMap[id];
  }
}

function renderRoomList(list, container) {
  if (!container) return;
  clearAllDeleteTimers();
  if (!list || !list.length) {
    container.innerHTML = `<div class="rooms-empty">
      <div class="rooms-empty-icon">🏠</div>
      <div>Групп пока нет.<br>Создай первую!</div>
    </div>`;
    return;
  }
  container.innerHTML = list.map(room => {
    const isEmpty   = room.memberCount === 0 && room.deleteAt;
    const timerAttr = isEmpty ? ` data-delete-at="${room.deleteAt}"` : '';
    const timerHtml = isEmpty
      ? `<span class="room-badge-timer" id="timer-${room.id}">🕐 --:--</span>`
      : `<span class="room-badge-members">👥 ${room.memberCount}</span>`;
    const joinBadge = room.joinMode === 'approval'
      ? `<span style="color:var(--orange);font-size:11px">📋 По заявке</span>` : '';
    return `
      <div class="room-card" data-id="${room.id}"
           data-has-pw="${room.hasPassword}"
           data-name="${escapeHtml(room.name)}"
           data-joinmode="${room.joinMode || 'open'}"${timerAttr}>
        <div class="room-avatar">
          ${room.photo ? `<img src="${room.photo}" alt="">` : '🏠'}
        </div>
        <div class="room-info">
          <div class="room-name">${escapeHtml(room.name)}</div>
          <div class="room-meta">
            ${room.hasPassword
              ? '<span class="room-badge-lock">🔐 Закрытая</span>'
              : '<span style="color:var(--sub)">🌐 Открытая</span>'}
            ${timerHtml} ${joinBadge}
          </div>
        </div>
        <div class="room-arrow">›</div>
      </div>`;
  }).join('');

  list.forEach(room => {
    if (room.memberCount === 0 && room.deleteAt) {
      const el = document.getElementById('timer-' + room.id);
      if (!el) return;
      const tick = () => {
        const left = room.deleteAt - Date.now();
        if (left <= 0) { el.textContent = '🕐 00:00'; clearInterval(roomDeleteTimersMap[room.id]); return; }
        el.textContent = '🕐 ' + formatCountdown(left);
      };
      tick();
      roomDeleteTimersMap[room.id] = setInterval(tick, 1000);
    }
  });

  container.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('click', () => {
      const joinMode = card.dataset.joinmode;
      if (card.dataset.hasPw === 'true') openRoomPasswordModal(card.dataset.id, card.dataset.name, joinMode);
      else if (joinMode === 'approval')  handleApprovalJoin(card.dataset.id, card.dataset.name);
      else joinRoom(card.dataset.id, '');
    });
  });
}

function renderRoomListInChat(list) {
  if (!chatRoomsList) return;
  if (!list || !list.length) {
    chatRoomsList.innerHTML = `<div class="rooms-empty" style="padding:30px 10px">
      <div class="rooms-empty-icon" style="font-size:36px">🏠</div>
      <div style="font-size:13px">Групп нет</div>
    </div>`;
    return;
  }
  chatRoomsList.innerHTML = list.map(room => `
    <div class="room-card" style="margin-bottom:4px" data-id="${room.id}"
         data-has-pw="${room.hasPassword}" data-name="${escapeHtml(room.name)}"
         data-joinmode="${room.joinMode || 'open'}">
      <div class="room-avatar" style="width:38px;height:38px;font-size:16px">
        ${room.photo ? `<img src="${room.photo}" alt="">` : '🏠'}
      </div>
      <div class="room-info">
        <div class="room-name" style="font-size:13px">${escapeHtml(room.name)}</div>
        <div class="room-meta" style="font-size:11px">
          ${room.memberCount} чел.${room.joinMode === 'approval' ? ' · 📋' : ''}
        </div>
      </div>
    </div>
  `).join('');
  chatRoomsList.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('click', () => {
      const joinMode = card.dataset.joinmode;
      if (card.dataset.hasPw === 'true') openRoomPasswordModal(card.dataset.id, card.dataset.name, joinMode);
      else if (joinMode === 'approval')  handleApprovalJoin(card.dataset.id, card.dataset.name);
      else joinRoom(card.dataset.id, '');
    });
  });
}

socket.on('room-renamed', ({ roomId, newName }) => {
  if (currentRoomId === roomId) {
    if (chatRoomName) chatRoomName.textContent = newName;
    appendSystemMsg('✏️ Переименовано: ' + newName);
  }
});
socket.on('room-deleted', ({ roomId, roomName }) => {
  if (currentRoomId === roomId) {
    showToast('🗑 Группа «' + roomName + '» удалена', 5000);
    leaveCurrentRoom(); showScreen('lobby');
  }
});
socket.on('room-settings-changed', ({ roomId }) => {
  if (currentRoomId === roomId) appendSystemMsg('⚙️ Настройки группы обновлены');
});

// ═══════════════════════════════════════════════
//  СОЗДАНИЕ КОМНАТЫ
// ═══════════════════════════════════════════════
if (btnCreateRoom) btnCreateRoom.addEventListener('click', openCreateRoomModal);
$('btn-create-room-chat')?.addEventListener('click', openCreateRoomModal);
if (btnCloseCreate) btnCloseCreate.addEventListener('click', () => modalCreate.classList.remove('open'));
if (modalCreate) modalCreate.addEventListener('click', e => {
  if (e.target === modalCreate) modalCreate.classList.remove('open');
});

function openCreateRoomModal() {
  if (!modalCreate) return;
  if (createRoomName)   createRoomName.value = '';
  if (createRoomPw)     createRoomPw.value = '';
  if (createRoomError)  createRoomError.textContent = '';
  roomPhotoData = null;
  if (createAutoDelete) createAutoDelete.value = 'never';
  if (createJoinMode)   createJoinMode.value = 'open';
  if (roomPhotoBtn) roomPhotoBtn.innerHTML = '<span class="cam-icon">📷</span><span>Фото</span>';
  modalCreate.classList.add('open');
  setTimeout(() => { if (createRoomName) createRoomName.focus(); }, 200);
}

if (roomPhotoBtn) roomPhotoBtn.addEventListener('click', () => { if (roomPhotoInput) roomPhotoInput.click(); });
if (roomPhotoInput) roomPhotoInput.addEventListener('change', () => {
  const file = roomPhotoInput.files[0]; if (!file) return;
  roomPhotoInput.value = '';
  if (file.size > 5*1024*1024) { alert('Фото слишком большое'); return; }
  const r = new FileReader();
  r.onload = e => {
    roomPhotoData = e.target.result;
    if (roomPhotoBtn) roomPhotoBtn.innerHTML = `<img src="${roomPhotoData}" alt="">`;
  };
  r.readAsDataURL(file);
});

if (btnToggleCreatePw) btnToggleCreatePw.addEventListener('click', () => {
  if (!createRoomPw) return;
  const t = createRoomPw.type === 'text';
  createRoomPw.type = t ? 'password' : 'text';
  btnToggleCreatePw.textContent = t ? '👁' : '🙈';
});

if (btnSubmitCreate) btnSubmitCreate.addEventListener('click', submitCreateRoom);
if (createRoomName) createRoomName.addEventListener('keydown', e => { if (e.key === 'Enter') submitCreateRoom(); });

function submitCreateRoom() {
  if (!createRoomName) return;
  const name = createRoomName.value.trim();
  if (!name) { if (createRoomError) createRoomError.textContent = 'Введи название'; return; }
  if (btnSubmitCreate) { btnSubmitCreate.disabled = true; btnSubmitCreate.textContent = '⏳'; }
  socket.emit('create-room', {
    name,
    password:   createRoomPw   ? createRoomPw.value   : '',
    photo:      roomPhotoData  || null,
    autoDelete: createAutoDelete ? createAutoDelete.value : 'never',
    joinMode:   createJoinMode   ? createJoinMode.value   : 'open'
  }, res => {
    if (btnSubmitCreate) { btnSubmitCreate.disabled = false; btnSubmitCreate.textContent = 'Создать группу'; }
    if (res?.ok) {
      if (modalCreate) modalCreate.classList.remove('open');
      joinRoom(res.roomId, createRoomPw ? createRoomPw.value : '');
    } else {
      if (createRoomError) createRoomError.textContent = 'Ошибка. Попробуй снова.';
    }
  });
}

// ═══════════════════════════════════════════════
//  ПАРОЛЬ КОМНАТЫ
// ═══════════════════════════════════════════════
let pendingJoinRoomMode = 'open';

function openRoomPasswordModal(roomId, roomName, joinMode) {
  if (!modalRoomPw) return;
  pendingJoinRoom = { roomId, roomName };
  pendingJoinRoomMode = joinMode || 'open';
  if (pwModalRoomName) pwModalRoomName.textContent = roomName;
  if (roomPwInput)  roomPwInput.value = '';
  if (roomPwError)  roomPwError.textContent = '';
  modalRoomPw.classList.add('open');
  setTimeout(() => { if (roomPwInput) roomPwInput.focus(); }, 200);
}

if (btnClosePwModal) btnClosePwModal.addEventListener('click', () => {
  if (modalRoomPw) modalRoomPw.classList.remove('open');
  pendingJoinRoom = null;
});
if (modalRoomPw) modalRoomPw.addEventListener('click', e => {
  if (e.target === modalRoomPw) { modalRoomPw.classList.remove('open'); pendingJoinRoom = null; }
});
if (btnToggleRoomPw) btnToggleRoomPw.addEventListener('click', () => {
  if (!roomPwInput) return;
  const t = roomPwInput.type === 'text';
  roomPwInput.type = t ? 'password' : 'text';
  btnToggleRoomPw.textContent = t ? '👁' : '🙈';
});
if (btnSubmitRoomPw) btnSubmitRoomPw.addEventListener('click', submitRoomPassword);
if (roomPwInput) roomPwInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitRoomPassword(); });

function submitRoomPassword() {
  if (!pendingJoinRoom || !roomPwInput) return;
  const pw = roomPwInput.value;
  if (!pw) { if (roomPwError) roomPwError.textContent = 'Введи пароль'; return; }
  if (btnSubmitRoomPw) { btnSubmitRoomPw.disabled = true; btnSubmitRoomPw.textContent = '⏳'; }

  if (pendingJoinRoomMode === 'approval') {
    if (modalRoomPw) modalRoomPw.classList.remove('open');
    if (btnSubmitRoomPw) { btnSubmitRoomPw.disabled = false; btnSubmitRoomPw.textContent = 'Войти в группу'; }
    handleApprovalJoin(pendingJoinRoom.roomId, pendingJoinRoom.roomName, pw);
    pendingJoinRoom = null; return;
  }

  joinRoom(pendingJoinRoom.roomId, pw, (ok, err, secsLeft) => {
    if (btnSubmitRoomPw) { btnSubmitRoomPw.disabled = false; btnSubmitRoomPw.textContent = 'Войти в группу'; }
    if (ok) {
      if (modalRoomPw) modalRoomPw.classList.remove('open');
      pendingJoinRoom = null;
    } else if (err === 'rate_limited') {
      if (roomPwError) roomPwError.textContent = `⛔ Подождите ${secsLeft} сек.`;
    } else if (err === 'wrong_password') {
      if (roomPwError) roomPwError.textContent = '❌ Неверный пароль';
      if (roomPwInput) {
        roomPwInput.style.animation = 'shake 0.35s';
        setTimeout(() => { roomPwInput.style.animation = ''; }, 400);
      }
    } else {
      if (roomPwError) roomPwError.textContent = '⚠️ Ошибка';
    }
  });
}

// ═══════════════════════════════════════════════
//  ЗАЯВКИ НА ВСТУПЛЕНИЕ
// ═══════════════════════════════════════════════
function handleApprovalJoin(roomId, roomName, _pw) {
  if (!confirm(`📋 Для вступления в «${roomName}» требуется одобрение.\nОтправить заявку?`)) return;
  socket.emit('room-request-join', { roomId }, res => {
    if (res.ok) showToast('📨 Заявка отправлена!', 5000);
    else if (res.error === 'already_requested') showToast('⏳ Заявка уже отправлена');
    else if (res.error === 'already_member') joinRoom(roomId, _pw || '');
    else showToast('⚠️ Ошибка: ' + res.error);
  });
}

socket.on('room-request-accepted', ({ roomId, roomName }) => {
  showToast(`✅ Заявка в «${roomName}» одобрена!`, 6000, () => joinRoom(roomId, ''));
});
socket.on('room-request-declined', ({ roomId, roomName }) => {
  showToast(`❌ Заявка в «${roomName}» отклонена`, 5000);
});
socket.on('room-join-request', ({ roomId, nickname }) => {
  showToast(`📋 ${nickname} хочет вступить`, 8000, () => {
    if (currentRoomId === roomId) openMembersModal();
  });
  if (modalMembers && modalMembers.classList.contains('open') && currentRoomId === roomId)
    loadJoinRequests(roomId);
});

function loadJoinRequests(roomId) {
  socket.emit('room-members', { roomId }, res => {
    if (!res.ok) return;
    renderJoinRequests(res.pendingRequests || [], roomId);
  });
}

function renderJoinRequests(requests, roomId) {
  const count = requests.length;
  if (joinRequestsCount) joinRequestsCount.textContent = count ? `(${count})` : '';
  if (!joinRequestsList) return;
  if (!count) { joinRequestsList.innerHTML = '<div class="empty-list">Нет заявок</div>'; return; }
  joinRequestsList.innerHTML = requests.map(r => `
    <div class="request-item">
      <div class="friend-avatar">${avatarHtml(r.avatar, '👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(r.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm green" data-action="accept"  data-nick="${r.nickLower}">✓ Принять</button>
        <button class="btn-sm red"   data-action="decline" data-nick="${r.nickLower}">✕</button>
      </div>
    </div>
  `).join('');
  joinRequestsList.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const accept = btn.dataset.action === 'accept';
      socket.emit('room-request-respond', { roomId, nickLower: btn.dataset.nick, accept }, res => {
        if (res.ok) { showToast(accept ? '✅ Принята' : 'Отклонено'); loadJoinRequests(roomId); }
      });
    });
  });
}

// ═══════════════════════════════════════════════
//  ВХОД В КОМНАТУ
// ═══════════════════════════════════════════════
function joinRoom(roomId, password, cb) {
  socket.emit('join-room', { roomId, password }, async res => {
    if (res?.ok) {
      currentRoomId   = roomId;
      currentRoomData = res.room;
      currentPassword = password || '';
      currentChatType = 'group';
      currentChatId   = null;
      isRoomOwner     = res.room.isOwner || false;

      const roomSalt = res.room.roomSalt || (roomId + '-default-salt');
      await Crypto.deriveKey(password, roomId, roomSalt);
      await Crypto.generateEcdhKeyPair();
      outgoingSeq = 0;

      if (chatRoomName)    chatRoomName.textContent = res.room.name;
      if (userCount)       userCount.textContent    = res.room.members.length + 1;
      memberCount = res.room.members.length + 1;
      if (chatRoomAvatar)  chatRoomAvatar.innerHTML = res.room.photo
        ? `<img src="${res.room.photo}" alt="">` : '💬';

      if (btnJoin)  btnJoin.style.display  = 'block';
      if (btnLeave) btnLeave.style.display = 'none';
      if (btnMic)   btnMic.style.display   = 'none';

      clearChat(); clearAllTyping();
      showScreen('chat');
      showOwnFingerprint();

      socket.emit('room-history', { roomId }, async histRes => {
        if (histRes.ok && histRes.messages && histRes.messages.length) {
          for (const msg of histRes.messages) {
            const mine = msg.from === socket.id;
            if (msg.type === 'text') {
              try {
                const text = await Crypto.decryptText(msg.encrypted, msg.iv);
                appendMessage({ nickname: msg.nickname, text, type: 'text', timestamp: msg.timestamp, mine, status: 'ok' });
              } catch (_) {
                appendMessage({ nickname: msg.nickname, text: '[зашифровано]', type: 'text', timestamp: msg.timestamp, mine, status: 'error' });
              }
            } else {
              appendMessage({ nickname: msg.nickname, type: msg.type, fileName: msg.fileName, fileSize: msg.fileSize, mimeType: msg.mimeType, timestamp: msg.timestamp, mine, status: 'ok' });
            }
          }
        }
      });

      if (cb) cb(true);
      if (isRoomOwner && res.room.pendingRequests?.length)
        showToast(`📋 ${res.room.pendingRequests.length} заявок`, 5000);
    } else {
      if (res?.error === 'approval_required') {
        handleApprovalJoin(roomId, 'группу');
        if (cb) cb(false, 'approval_required'); return;
      }
      if (cb) cb(false, res?.error, res?.secsLeft);
      else if (res?.error === 'rate_limited') alert(`⛔ Подождите ${res.secsLeft} сек.`);
      else if (res?.error === 'wrong_password') alert('Неверный пароль');
      else alert('Не удалось войти');
    }
  });
}

async function showOwnFingerprint() {
  try {
    const fp  = await Crypto.getKeyFingerprint();
    const div = document.createElement('div');
    div.className = 'date-divider';
    div.style.cssText = 'font-size:10px;color:#5288c1;cursor:pointer;user-select:all;';
    div.textContent = '🔑 Твой ключ: ' + fp;
    if (chatMessages) chatMessages.appendChild(div);
    scrollToBottom();
  } catch (_) {}
}

function clearChat() {
  if (!chatMessages) return;
  const all = [...chatMessages.children];
  all.forEach((el, i) => { if (i > 1) el.remove(); });
  msgCounter = 0;
}

// ═══════════════════════════════════════════════
//  УЧАСТНИКИ КОМНАТЫ
// ═══════════════════════════════════════════════
if (chatRoomAvatar) chatRoomAvatar.addEventListener('click',  openMembersModal);
if (chatHeaderInfo) chatHeaderInfo.addEventListener('click',  openMembersModal);
if (btnRoomMembers) btnRoomMembers.addEventListener('click',  openMembersModal);
if (btnCloseMembers) btnCloseMembers.addEventListener('click', () => {
  if (modalMembers) modalMembers.classList.remove('open');
});
if (modalMembers) modalMembers.addEventListener('click', e => {
  if (e.target === modalMembers) modalMembers.classList.remove('open');
});

function openMembersModal() {
  if (currentChatType === 'private') {
    if (chatRoomName) showToast('💬 Личный чат с ' + chatRoomName.textContent, 2500);
    return;
  }
  if (!currentRoomId || !modalMembers) return;

  if (renameSection)        renameSection.style.display        = isRoomOwner ? '' : 'none';
  if (groupSettingsSection) groupSettingsSection.style.display = isRoomOwner ? '' : 'none';
  if (joinRequestsSection)  joinRequestsSection.style.display  = isRoomOwner ? '' : 'none';

  if (isRoomOwner && currentRoomData) {
    if (renameInput)         renameInput.value         = currentRoomData.name || '';
    if (groupAutodelSelect)  groupAutodelSelect.value  = currentRoomData.autoDelete ? String(currentRoomData.autoDelete) : 'never';
    if (groupJoinmodeSelect) groupJoinmodeSelect.value = currentRoomData.joinMode || 'open';
  }

  if (membersListContainer) membersListContainer.innerHTML = '<div class="empty-list">Загрузка…</div>';
  modalMembers.classList.add('open');

  socket.emit('room-members', { roomId: currentRoomId }, res => {
    if (!membersListContainer) return;
    if (!res.ok) { membersListContainer.innerHTML = '<div class="empty-list">Ошибка</div>'; return; }
    if (!res.members.length) { membersListContainer.innerHTML = '<div class="empty-list">Пусто</div>'; return; }
    membersListContainer.innerHTML = res.members.map(m => `
      <div class="member-item">
        <div class="member-avatar">${avatarHtml(m.avatar, '👤')}</div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.nickname)}${m.id === socket.id ? ' (Вы)' : ''}</div>
          ${m.isOwner ? '<div class="member-badge">👑 Создатель</div>' : ''}
        </div>
      </div>
    `).join('');
    if (isRoomOwner) renderJoinRequests(res.pendingRequests || [], currentRoomId);
  });
}

if (btnRenameRoom) btnRenameRoom.addEventListener('click', () => {
  if (!renameInput) return;
  const name = renameInput.value.trim();
  if (!name) { if (renameError) renameError.textContent = 'Введи название'; return; }
  if (renameError) renameError.textContent = '';
  socket.emit('room-rename', { roomId: currentRoomId, newName: name }, res => {
    if (res.ok) { showToast('✅ Переименовано'); if (currentRoomData) currentRoomData.name = name; }
    else if (renameError) renameError.textContent = res.error === 'not_owner' ? '❌ Нет прав' : '⚠️ Ошибка';
  });
});
if (renameInput) renameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && btnRenameRoom) btnRenameRoom.click(); });

if (btnSaveGroupSettings) btnSaveGroupSettings.addEventListener('click', () => {
  socket.emit('room-settings-update', {
    roomId:     currentRoomId,
    autoDelete: groupAutodelSelect  ? groupAutodelSelect.value  : 'never',
    joinMode:   groupJoinmodeSelect ? groupJoinmodeSelect.value : 'open'
  }, res => {
    if (res.ok) {
      showToast('✅ Настройки сохранены');
      if (currentRoomData) {
        currentRoomData.autoDelete = groupAutodelSelect?.value === 'never' ? null : parseInt(groupAutodelSelect?.value);
        currentRoomData.joinMode   = groupJoinmodeSelect?.value || 'open';
      }
    } else showToast('⚠️ Ошибка');
  });
});

if (btnDeleteGroup) btnDeleteGroup.addEventListener('click', () => {
  if (!confirm('🗑 Удалить группу?')) return;
  socket.emit('room-delete', { roomId: currentRoomId }, res => {
    if (res.ok) {
      if (modalMembers) modalMembers.classList.remove('open');
      leaveCurrentRoom(); showScreen('lobby'); showToast('🗑 Удалено');
    } else showToast('⚠️ Ошибка');
  });
});

// ═══════════════════════════════════════════════
//  ПРИГЛАШЕНИЯ
// ═══════════════════════════════════════════════
if (btnInviteFriend) btnInviteFriend.addEventListener('click', () => {
  if (currentChatType === 'private') { openPrivateChatsModal(); return; }
  openInviteModal();
});
if (btnCloseInvite) btnCloseInvite.addEventListener('click', () => {
  if (modalInvite) modalInvite.classList.remove('open');
});
if (modalInvite) modalInvite.addEventListener('click', e => {
  if (e.target === modalInvite) modalInvite.classList.remove('open');
});

function openInviteModal() {
  if (!currentRoomId || !modalInvite) return;
  modalInvite.classList.add('open');
  if (inviteFriendsList) inviteFriendsList.innerHTML = '<div class="empty-list">Загрузка…</div>';
  socket.emit('friends-list', res => {
    if (!inviteFriendsList) return;
    if (!res.ok || !res.friends.length) {
      inviteFriendsList.innerHTML = '<div class="empty-list">Нет друзей для приглашения</div>'; return;
    }
    inviteFriendsList.innerHTML = res.friends.map(f => `
      <div class="friend-item">
        <div class="friend-avatar">${avatarHtml(f.avatar, '👤')}</div>
        <div class="friend-info"><div class="friend-name">${escapeHtml(f.nickname)}</div></div>
        <div class="friend-actions">
          <button class="btn-sm blue" data-action="invite" data-nick="${escapeHtml(f.nickname)}">Позвать</button>
        </div>
      </div>
    `).join('');
    inviteFriendsList.querySelectorAll('[data-action="invite"]').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('room-invite', { toNickname: btn.dataset.nick, roomId: currentRoomId }, res => {
          btn.textContent = res.online ? '✅ Отправлено' : '📨 Будет доставлено';
          btn.disabled = true;
        });
      });
    });
  });
}

socket.on('room-invite', ({ fromNick, roomId, roomName, hasPassword, joinMode }) => {
  showToast(`📨 ${fromNick} приглашает в «${roomName}»`, 8000, () => {
    if (hasPassword) openRoomPasswordModal(roomId, roomName, joinMode);
    else if (joinMode === 'approval') handleApprovalJoin(roomId, roomName);
    else {
      socket.emit('leave-room');
      if (joined) { socket.emit('voice-leave'); hangUp(); joined = false; }
      joinRoom(roomId, '');
    }
  });
});

// ═══════════════════════════════════════════════
//  НАЗАД
// ═══════════════════════════════════════════════
if (btnBackLobby) btnBackLobby.addEventListener('click', () => { leaveCurrentRoom(); showScreen('lobby'); });

function leaveCurrentRoom() {
  stopMyTyping();
  if (currentChatType === 'group' && currentRoomId) {
    socket.emit('leave-room');
    if (joined) {
      socket.emit('voice-leave'); hangUp(); joined = false;
      if (micStatus) micStatus.className = 'mic-status';
    }
  }
  if (btnJoin)  btnJoin.style.display  = 'block';
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic)   btnMic.style.display   = 'none';
  clearAllTyping();
  Crypto.clearAllKeys();
  ecdhExchanged.clear();
  outgoingSeq = 0;
  currentRoomId = null; currentRoomData = null; currentPassword = '';
  currentChatType = 'group'; currentChatId = null; isRoomOwner = false;
}

// ═══════════════════════════════════════════════
//  СОБЫТИЯ КОМНАТЫ
// ═══════════════════════════════════════════════
socket.on('room-user-joined', ({ id, nickname }) => {
  memberCount++;
  if (userCount) userCount.textContent = memberCount;
  appendSystemMsg('👋 ' + nickname + ' вошёл');
});
socket.on('room-user-left', id => {
  memberCount = Math.max(0, memberCount - 1);
  if (userCount) userCount.textContent = memberCount;
  Crypto.clearSessionKey(id);
});
socket.on('connect', () => {
  if (reconnectBanner) reconnectBanner.classList.remove('visible');
  if (myNickname) {
    socket.emit('set-nickname', myNickname, () => {
      if (currentRoomId && currentChatType === 'group') joinRoom(currentRoomId, currentPassword);
      if (currentChatId && currentChatType === 'private') socket.emit('private-chat-join', { chatId: currentChatId });
    });
  }
});
socket.on('disconnect', () => {
  if ((currentRoomId || currentChatId) && reconnectBanner) reconnectBanner.classList.add('visible');
});
socket.on('ecdh-pubkey', async ({ from, pubkey, nickname }) => {
  try {
    await Crypto.deriveSessionKey(pubkey, from);
    appendSystemMsg('🔐 Ключ с ' + (nickname || shortId(from)));
    if (!ecdhExchanged.has(from)) {
      ecdhExchanged.add(from);
      const myPubKey = await Crypto.exportPublicKey();
      socket.emit('ecdh-pubkey', { to: from, pubkey: myPubKey });
      const fp = await Crypto.getKeyFingerprint();
      socket.emit('key-fingerprint', { to: from, fingerprint: fp });
    }
  } catch (_) {}
});
socket.on('key-fingerprint', ({ from, nickname, fingerprint }) => {
  const div = document.createElement('div');
  div.className = 'date-divider';
  div.style.cssText = 'font-size:10px;color:#4caf50;cursor:pointer;user-select:all;';
  div.textContent = '🔑 Ключ ' + escapeHtml(nickname || shortId(from)) + ': ' + fingerprint;
  if (chatMessages) chatMessages.appendChild(div);
  scrollToBottom();
});

// ═══════════════════════════════════════════════
//  СТАТУС «ПЕЧАТАЕТ»
//  FIX: ищем элемент каждый раз, а не при загрузке
// ═══════════════════════════════════════════════
function getHeaderSubEl() {
  return document.querySelector('.tg-header-sub');
}

function renderTyping() {
  const el = getHeaderSubEl();
  if (!el) return;
  const names = Object.values(typingUsers).map(u => u.nickname);
  if (!names.length) {
    el.innerHTML = `<span class="online"><span id="user-count">${memberCount}</span> участников</span>`;
    return;
  }
  const text = names.length === 1
    ? escapeHtml(names[0]) + ' печатает…'
    : escapeHtml(names.slice(0,2).join(', ')) + ' печатают…';
  el.innerHTML = `<span class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span>${text}</span>`;
}

function addTypingUser(id, nick) {
  if (typingUsers[id]) clearTimeout(typingUsers[id].timer);
  typingUsers[id] = { nickname: nick, timer: setTimeout(() => removeTypingUser(id), 4000) };
  renderTyping();
}
function removeTypingUser(id) {
  if (typingUsers[id]) { clearTimeout(typingUsers[id].timer); delete typingUsers[id]; }
  renderTyping();
}
function clearAllTyping() {
  Object.keys(typingUsers).forEach(id => { clearTimeout(typingUsers[id].timer); delete typingUsers[id]; });
  renderTyping();
}
function startMyTyping() {
  if (!currentRoomId || currentChatType !== 'group') return;
  if (typingTimer) clearTimeout(typingTimer);
  socket.emit('typing-start');
  typingTimer = setTimeout(stopMyTyping, 3000);
}
function stopMyTyping() {
  if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
  if (currentRoomId && currentChatType === 'group') socket.emit('typing-stop');
}
socket.on('typing-start', ({ from, nickname }) => { if (from !== socket.id) addTypingUser(from, nickname); });
socket.on('typing-stop',  ({ from }) => removeTypingUser(from));

// ═══════════════════════════════════════════════
//  ЧАТ: ОТПРАВКА
// ═══════════════════════════════════════════════
if (chatInput) {
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    if (chatInput.value.trim().length > 0) startMyTyping(); else stopMyTyping();
  });
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
  });
}
if (btnSend) btnSend.addEventListener('click', sendTextMessage);

async function sendTextMessage() {
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;
  stopMyTyping();
  if (btnSend) btnSend.disabled = true;
  try {
    if (currentChatType === 'private' && currentChatId) {
      const { encrypted, iv } = await Crypto.encrypt(text);
      socket.emit('private-message', { chatId: currentChatId, encrypted, iv, type: 'text', seq: ++outgoingSeq });
      appendMessage({ nickname: myNickname, text, type: 'text', timestamp: Date.now(), mine: true, status: 'ok' });
      chatInput.value = ''; chatInput.style.height = 'auto';
    } else if (currentRoomId) {
      const { encrypted, iv } = await Crypto.encrypt(text);
      socket.emit('chat-message', { encrypted, iv, type: 'text', seq: ++outgoingSeq });
      appendMessage({ from: socket.id, nickname: myNickname, text, type: 'text', timestamp: Date.now(), mine: true, status: 'ok' });
      chatInput.value = ''; chatInput.style.height = 'auto';
    }
  } catch (e) { console.error('Send error:', e); }
  finally { if (btnSend) btnSend.disabled = false; }
}

if (btnPhoto) btnPhoto.addEventListener('click', () => { if(fileInput){ fileInput.accept = 'image/*'; fileInput.click(); }});
if (btnVideo) btnVideo.addEventListener('click', () => { if(fileInput){ fileInput.accept = 'video/*'; fileInput.click(); }});
if (btnFile)  btnFile.addEventListener('click',  () => { if(fileInput){ fileInput.accept = '*/*';     fileInput.click(); }});

if (fileInput) fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]; if (!file) return;
  fileInput.value = '';
  if (file.size > 100 * 1024 * 1024) { showToast('⚠️ Файл слишком большой. Макс 100 МБ.'); return; }
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (isImage) { MediaEditor.openPhoto(file, async (b,mt,fn) => await sendMediaBlob(b,mt,fn,'image'), ()=>{}); return; }
  if (isVideo) { MediaEditor.openVideo(file, async (b,mt,fn) => await sendMediaBlob(b,mt,fn,'video'), ()=>{}); return; }
  await sendMediaBlob(file, file.type, file.name, 'file');
});

async function sendMediaBlob(blob, mimeType, fileName, type) {
  try {
    const ab = await blob.arrayBuffer();
    const { encrypted, iv } = await Crypto.encrypt(ab);
    const localUrl = URL.createObjectURL(new Blob([ab], { type: mimeType }));
    const payload  = { encrypted, iv, type, seq: ++outgoingSeq, fileName: fileName||'file', fileSize: blob.size, mimeType };
    if (currentChatType === 'private' && currentChatId) {
      socket.emit('private-message', { chatId: currentChatId, ...payload });
    } else if (currentRoomId) {
      socket.emit('chat-message', payload);
    }
    appendMessage({
      from: socket.id, nickname: myNickname, type, localUrl,
      fileName: fileName||'file', fileSize: blob.size, mimeType,
      timestamp: Date.now(), mine: true, status: 'ok'
    });
  } catch (e) { showToast('❌ Ошибка отправки: ' + e.message); }
}

socket.on('chat-message', async data => {
  playMsgSound();
  const msgId = appendMessage({
    from: data.from, nickname: data.nickname, type: data.type,
    fileName: data.fileName, fileSize: data.fileSize, mimeType: data.mimeType,
    timestamp: data.timestamp, mine: false, status: 'decrypting'
  });
  try {
    if (data.type === 'text') {
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      updateMessage(msgId, { text, status: 'ok' });
      showBrowserNotif('💬 ' + (data.nickname||'?'), text);
    } else {
      const mime = data.mimeType || 'application/octet-stream';
      const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
      updateMessage(msgId, { localUrl: URL.createObjectURL(blob), status: 'ok' });
    }
  } catch { updateMessage(msgId, { status: 'error' }); }
});

// ═══════════════════════════════════════════════
//  ЧАТ: РЕНДЕР СООБЩЕНИЙ
// ═══════════════════════════════════════════════
function appendMessage(msg) {
  if (!chatMessages) return 'msg-0';
  const id  = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.id = id;
  div.className = 'msg ' + (msg.mine ? 'mine' : 'theirs');
  div.dataset.type     = msg.type     || 'text';
  div.dataset.mimeType = msg.mimeType || '';
  div.dataset.fileName = msg.fileName || '';
  div.dataset.fileSize = msg.fileSize || '';
  div.innerHTML = buildMsgHTML(msg);
  chatMessages.appendChild(div);
  scrollToBottom();
  bindMediaEvents(div);
  return id;
}

function appendSystemMsg(text) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = 'date-divider'; div.textContent = text;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function updateMessage(id, updates) {
  const div = document.getElementById(id); if (!div) return;
  const content = div.querySelector('.msg-content');
  if (content) {
    content.innerHTML = buildContentHTML({
      type:     div.dataset.type,
      mimeType: div.dataset.mimeType,
      fileName: div.dataset.fileName,
      fileSize: div.dataset.fileSize,
      ...updates
    });
    bindMediaEvents(div);
  }
  const st = div.querySelector('.msg-decrypt-status');
  if (st) {
    if (updates.status === 'ok')         { st.className = 'msg-decrypt-status ok';  st.textContent = '🔓'; }
    if (updates.status === 'error')      { st.className = 'msg-decrypt-status err'; st.textContent = '⚠️'; }
    if (updates.status === 'decrypting') st.textContent = '⏳';
  }
  scrollToBottom();
}

function buildMsgHTML(msg) {
  const time    = new Date(msg.timestamp||Date.now()).toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });
  const sender  = msg.mine ? '' : `<div class="msg-sender">👤 ${escapeHtml(msg.nickname||'?')}</div>`;
  const stText  = msg.status==='ok' ? '🔓' : msg.status==='error' ? '⚠️' : '⏳';
  const stClass = msg.status==='ok' ? 'ok' : msg.status==='error' ? 'err' : '';
  const st      = msg.mine ? '' : `<div class="msg-decrypt-status ${stClass}">${stText}</div>`;
  return `${sender}<div class="msg-content">${buildContentHTML(msg)}</div><div class="msg-meta">${time}</div>${st}`;
}

function buildContentHTML(msg) {
  if (msg.type === 'text')  return escapeHtml(msg.text || '');
  if (msg.type === 'image') return msg.localUrl
    ? `<img class="msg-media" src="${msg.localUrl}" alt="фото" loading="lazy">`
    : '<span style="color:#888;font-size:12px">⏳ Загрузка…</span>';
  if (msg.type === 'video') return msg.localUrl
    ? `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>`
    : '<span style="color:#888;font-size:12px">⏳ Загрузка…</span>';
  if (msg.type === 'file') {
    const size = msg.fileSize ? formatSize(parseInt(msg.fileSize)) : '';
    return msg.localUrl
      ? `<div class="msg-file"><span class="msg-file-icon">📄</span><div class="msg-file-info"><div class="msg-file-name">${escapeHtml(msg.fileName||'файл')}</div><div class="msg-file-size">${size}</div></div><a class="msg-file-dl" href="${msg.localUrl}" download="${escapeHtml(msg.fileName||'file')}">⬇️</a></div>`
      : `<div class="msg-file"><span class="msg-file-icon">📄</span><div class="msg-file-info"><div class="msg-file-name">${escapeHtml(msg.fileName||'файл')}</div><div class="msg-file-size">${size}</div></div></div>`;
  }
  return '';
}

function bindMediaEvents(container) {
  container.querySelectorAll('img.msg-media').forEach(img => {
    img.onclick = () => openLightbox('img', img.src);
  });
  container.querySelectorAll('video.msg-media').forEach(vid => {
    vid.ondblclick = () => openLightbox('video', vid.src);
  });
}

// ═══════════════════════════════════════════════
//  LIGHTBOX
// ═══════════════════════════════════════════════
function openLightbox(type, src) {
  if (!lightboxContent || !lightbox) return;
  lightboxContent.innerHTML = type==='img'
    ? `<img src="${src}" alt="">`
    : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}
if (lightboxClose) lightboxClose.addEventListener('click', () => {
  if (lightbox) { lightbox.classList.remove('open'); if(lightboxContent) lightboxContent.innerHTML=''; }
});
if (lightbox) lightbox.addEventListener('click', e => {
  if (e.target===lightbox) { lightbox.classList.remove('open'); if(lightboxContent) lightboxContent.innerHTML=''; }
});

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ
// ═══════════════════════════════════════════════
const SPEAKING_THRESHOLD = 20; // Порог определения речи — 20% (было 8)

if (btnJoin) btnJoin.addEventListener('click', async () => {
  if (!currentRoomId || currentChatType !== 'group') return;
  try {
    const rawStream = await getMicStream();
    localStream = rawStream;
    try { processedStream = await buildAudioPipeline(rawStream); }
    catch (e) { processedStream = rawStream; if (noiseIndicator) noiseIndicator.classList.remove('visible'); }
    await requestWakeLock(); startKeepAlive(); setMicStatus(true);
    if (btnJoin)  btnJoin.style.display  = 'none';
    if (btnLeave) btnLeave.style.display = 'block';
    if (btnMic)   btnMic.style.display   = 'block';
    joined = true;
    addParticipant(socket.id, myNickname, true);
    startVolumeAnalysis(socket.id, localStream);
    socket.emit('voice-join');
    for (const { from, offer, nickname } of pendingOffers) await handleOffer(from, offer, nickname);
    pendingOffers = [];
  } catch (err) {
    const msgs = {
      NotAllowedError:  '❌ Доступ к микрофону запрещён. Разреши в настройках браузера.',
      NotFoundError:    '❌ Микрофон не найден.',
      NotReadableError: '❌ Микрофон занят другим приложением.'
    };
    alert(msgs[err.name] || '❌ Ошибка микрофона: ' + err.name);
  }
});

if (btnLeave) btnLeave.addEventListener('click', () => {
  socket.emit('voice-leave'); hangUp(); joined = false;
  if (btnJoin)  btnJoin.style.display  = 'block';
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic)   btnMic.style.display   = 'none';
  if (micStatus) { micStatus.className = 'mic-status'; micStatus.textContent = ''; }
  releaseWakeLock(); stopKeepAlive();
});

if (btnMic) btnMic.addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  setMicStatus(micEnabled);
  btnMic.textContent = micEnabled ? '🔇 Выключить микрофон' : '🎙️ Включить микрофон';
});

function setMicStatus(active) {
  if (!micStatus) return;
  micStatus.textContent = active ? '🟢 Микрофон активен' : '🔴 Микрофон выключен';
  micStatus.className   = 'mic-status ' + (active ? 'active' : 'muted');
}

socket.on('existing-voice-users', async users => {
  for (const user of users) {
    voiceNicknames[user.id] = user.nickname || shortId(user.id);
    addParticipant(user.id, voiceNicknames[user.id], false);
    peers[user.id] = createPeer(user.id, true);
    try {
      ecdhExchanged.add(user.id);
      socket.emit('ecdh-pubkey', { to: user.id, pubkey: await Crypto.exportPublicKey() });
    } catch (_) {}
  }
});

socket.on('voice-user-joined', async data => {
  const uid  = typeof data === 'object' ? data.id       : data;
  const nick = typeof data === 'object' ? data.nickname : shortId(data);
  playBeep('join');
  voiceNicknames[uid] = nick;
  addParticipant(uid, nick, false);
  if (joined) {
    if (!peers[uid]) peers[uid] = createPeer(uid, false);
    try {
      ecdhExchanged.add(uid);
      socket.emit('ecdh-pubkey', { to: uid, pubkey: await Crypto.exportPublicKey() });
    } catch (_) {}
  } else {
    pendingOffers.push({ from: uid, offer: null, nickname: nick });
  }
});

socket.on('offer', async ({ from, offer, nickname }) => {
  if (nickname) voiceNicknames[from] = nickname;
  if (!localStream) { pendingOffers.push({ from, offer, nickname }); return; }
  await handleOffer(from, offer, nickname);
});

async function handleOffer(from, offer, nickname) {
  if (!offer) return;
  if (nickname) { voiceNicknames[from] = nickname; updateParticipantName(from, nickname); }
  const peer = createPeer(from, false);
  peers[from] = peer;
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer   = await peer.createAnswer();
  const improved = { type: answer.type, sdp: forceOpusMaxQuality(answer.sdp) };
  await peer.setLocalDescription(improved);
  socket.emit('answer', { to: from, answer: improved });
}

socket.on('answer', async ({ from, answer }) => {
  if (voiceNicknames[from]) updateParticipantName(from, voiceNicknames[from]);
  const peer = peers[from];
  if (peer && peer.signalingState === 'have-local-offer')
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
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
  const el = document.getElementById('audio-' + uid);
  if (el) el.remove();
});

socket.on('understood', ({ from, nickname }) => {
  playOkSound();
  const b = document.createElement('div');
  b.className = 'understood-banner';
  b.textContent = '✅ Понял! (' + (nickname || shortId(from)) + ')';
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 3000);
});

function addParticipant(userId, nickname, isMe) {
  if (!participantsList || !participantsBox) return;
  if (document.getElementById('p-' + userId)) { updateParticipantName(userId, nickname); return; }
  participantsBox.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'participant';
  div.id = 'p-' + userId;
  const displayName   = isMe ? '🟢 ' + escapeHtml(nickname) + ' (Вы)' : '👤 ' + escapeHtml(nickname);
  const understoodBtn = isMe ? '' : `<button class="btn-understood" data-uid="${userId}">👍</button>`;
  div.innerHTML = `
    <span class="participant-name" id="pname-${userId}">${displayName}</span>
    <div class="volume-bar-wrap"><div class="volume-bar" id="vol-${userId}"></div></div>
    <div class="signal-wrap signal-none" id="sig-${userId}">
      <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
    </div>${understoodBtn}`;
  participantsList.appendChild(div);
  const btn = div.querySelector('.btn-understood');
  if (btn) btn.addEventListener('click', function () {
    socket.emit('understood');
    this.textContent = '✅'; this.disabled = true;
    setTimeout(() => { this.textContent = '👍'; this.disabled = false; }, 3000);
  });
}

function updateParticipantName(userId, nickname) {
  const el = document.getElementById('pname-' + userId); if (!el) return;
  el.textContent = userId === socket.id ? '🟢 ' + nickname + ' (Вы)' : '👤 ' + nickname;
}

function removeParticipant(userId) {
  const el = document.getElementById('p-' + userId); if (el) el.remove();
  if (participantsList && !participantsList.children.length && participantsBox)
    participantsBox.style.display = 'none';
}

function setSpeaking(userId, speaking) {
  const row = document.getElementById('p-' + userId); if (!row) return;
  row.classList.toggle('speaking', speaking);
}

function startVolumeAnalysis(userId, stream) {
  const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  if (!audioCtx) audioCtx = ctx;
  stopVolumeAnalysis(userId);
  const source   = ctx.createMediaStreamSource(stream);
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
      bar.className   = 'volume-bar' + (pct > 60 ? ' loud' : '');
    }
    const speaking = pct > SPEAKING_THRESHOLD;
    if (speaking !== wasSpeaking) { setSpeaking(userId, speaking); wasSpeaking = speaking; }
    analysers[userId].animFrame = requestAnimationFrame(tick);
  }
  analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
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
  if (wakeLock) { try { await wakeLock.release(); } catch (_) {} wakeLock = null; }
}

function startKeepAlive() {
  if (!keepAliveAudio) return;
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const buf  = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const src  = ctx.createBufferSource();
    const dest = ctx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true; src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream;
    keepAliveAudio.play().catch(() => {});
  } catch (_) {}
}
function stopKeepAlive() {
  if (!keepAliveAudio) return;
  keepAliveAudio.srcObject = null; keepAliveAudio.pause();
}

// ─────────────────────────────────────────────
//  getMicStream — улучшенные параметры микрофона
// ─────────────────────────────────────────────
async function getMicStream() {
  // Приоритет: лучшие настройки для подавления шума
  const constraints = {
    video: false,
    audio: {
      echoCancellation:    { ideal: true },
      noiseSuppression:    { ideal: true },
      autoGainControl:     { ideal: true },
      highpassFilter:      { ideal: true },
      sampleRate:          { ideal: 48000 },
      sampleSize:          { ideal: 16 },
      channelCount:        { ideal: 1 },
      latency:             { ideal: 0.01 },
      // Отключаем обработку на уровне ОС которая может конфликтовать
      googEchoCancellation:    true,
      googAutoGainControl:     true,
      googNoiseSuppression:    true,
      googHighpassFilter:      true,
      googNoiseSuppression2:   true,
      googEchoCancellation2:   true,
      googAutoGainControl2:    true
    }
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    // Фолбэк с простыми настройками
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  }
}

// ─────────────────────────────────────────────
//  buildAudioPipeline — порог поднят до 20%
// ─────────────────────────────────────────────
async function buildAudioPipeline(rawStream) {
  if (!audioCtx || audioCtx.state === 'closed')
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000, latencyHint: 'interactive'
    });
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  try { await audioCtx.audioWorklet.addModule('/audio-processor.js'); } catch (_) {}

  const source = audioCtx.createMediaStreamSource(rawStream);

  // Высокочастотный фильтр — срезаем гул ниже 100 Гц (шум двигателя, вентилятора)
  const hpf = audioCtx.createBiquadFilter();
  hpf.type            = 'highpass';
  hpf.frequency.value = 100;   // было 80 — поднимаем чтобы срезать больше фонового шума
  hpf.Q.value         = 0.9;

  // Низкочастотный фильтр — срезаем шипение выше 8 кГц
  const lpf = audioCtx.createBiquadFilter();
  lpf.type            = 'lowpass';
  lpf.frequency.value = 8000;
  lpf.Q.value         = 0.7;

  // Компрессор — выравниваем динамику голоса
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -28;  // чуть мягче чтобы голос не давился
  comp.knee.value      = 10;
  comp.ratio.value     = 6;    // сильнее сжимаем
  comp.attack.value    = 0.002;
  comp.release.value   = 0.12;

  // Noise Gate — КЛЮЧЕВОЙ параметр
  // threshold: 0.035 ≈ 20% от максимальной амплитуды
  // Шум автобуса обычно 10-15%, голос 25-100%
  noiseWorklet = new AudioWorkletNode(audioCtx, 'noise-gate-processor', {
    processorOptions: {
      threshold: 0.035,  // ← БЫЛО 0.008 (0.8%), ТЕПЕРЬ 0.035 (3.5% = ~20% субъективно)
      attack:    0.005,  // быстрая атака чтобы не срезать начало слов
      release:   0.20,   // медленный release — плавное закрытие ворот
      smoothing: 0.96    // сглаживание переходов
    },
    numberOfInputs:  1,
    numberOfOutputs: 1,
    outputChannelCount: [[1]](#annotation-152650-0)
  });

  // Усиление после обработки
  const gain = audioCtx.createGain();
  gain.gain.value = 1.2;  // немного усиливаем после шумодава

  const dest = audioCtx.createMediaStreamDestination();

  // Цепочка: source → HPF → LPF → Compressor → NoiseGate → Gain → output
  source.connect(hpf);
  hpf.connect(lpf);
  lpf.connect(comp);
  comp.connect(noiseWorklet);
  noiseWorklet.connect(gain);
  gain.connect(dest);

  if (noiseIndicator) noiseIndicator.classList.add('visible');
  return dest.stream;
}

// ─────────────────────────────────────────────
//  ICE серверы — расширенный список
// ─────────────────────────────────────────────
const iceServers = {
  iceServers: [
    // Google STUN
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Metered STUN
    { urls: 'stun:stun.relay.metered.ca:80' },
    // Metered TURN (важно для NAT за мобильными операторами)
    {
      urls:       'turn:global.relay.metered.ca:80',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    },
    {
      urls:       'turn:global.relay.metered.ca:80?transport=tcp',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    },
    {
      urls:       'turn:global.relay.metered.ca:443',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    },
    {
      urls:       'turns:global.relay.metered.ca:443?transport=tcp',
      username:   '4219a9030e911d3a21936639',
      credential: 'W9K/4EBqUUoxu9FC'
    }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy:         'max-bundle',
  rtcpMuxPolicy:        'require'
};

// ─────────────────────────────────────────────
//  Opus максимальное качество
// ─────────────────────────────────────────────
function forceOpusMaxQuality(sdp) {
  const lines  = sdp.split('\r\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[[1]](#annotation-152650-0).split(' ')[0];
      // Пропускаем старый fmtp если есть
      if (i + 1 < lines.length && lines[i + 1].startsWith('a=fmtp:' + pt)) i++;
      // Оптимальные параметры Opus для голоса
      result.push(
        'a=fmtp:' + pt +
        ' minptime=10' +
        ';useinbandfec=1' +       // Forward Error Correction
        ';stereo=0' +
        ';sprop-stereo=0' +
        ';maxaveragebitrate=40000' + // 40 кбит/с достаточно для голоса
        ';dtx=1' +                  // Прерывистая передача (тишина не тратит трафик)
        ';cbr=0'                    // Переменный битрейт
      );
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

// ─────────────────────────────────────────────
//  Качество сигнала
// ─────────────────────────────────────────────
function calcLevel(rtt, lost, total, jitter) {
  if (rtt === null) return 'none';
  const lr = (lost + total) > 0 ? lost / (lost + total) : 0;
  if (rtt < 80  && lr < 0.02 && jitter < 0.02) return 'excellent';
  if (rtt < 150 && lr < 0.05 && jitter < 0.05) return 'good';
  if (rtt < 300 && lr < 0.10 && jitter < 0.10) return 'fair';
  return 'poor';
}
function renderSignal(userId, level) {
  const w = document.getElementById('sig-' + userId);
  if (w) w.className = 'signal-wrap signal-' + level;
}
async function measureRemoteQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lost = 0, received = 0, jitter = 0;
    stats.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        lost     = r.packetsLost    || 0;
        received = r.packetsReceived || 0;
        jitter   = r.jitter         || 0;
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null)
        rtt = r.currentRoundTripTime * 1000;
    });
    return calcLevel(rtt, lost, received, jitter);
  } catch { return 'none'; }
}
async function measureLocalQuality(peer) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lost = 0, sent = 0, jitter = 0;
    stats.forEach(r => {
      if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
        lost   = r.packetsLost || 0;
        jitter = r.jitter      || 0;
        if (r.roundTripTime != null) rtt = r.roundTripTime * 1000;
      }
      if (r.type === 'outbound-rtp' && r.kind === 'audio')
        sent = r.packetsSent || 0;
    });
    return calcLevel(rtt, lost, sent, jitter);
  } catch { return 'none'; }
}
function startQualityMonitor(userId, peer, isLocal) {
  stopQualityMonitor(userId);
  qualityTimers[userId] = setInterval(async () => {
    renderSignal(userId, isLocal ? await measureLocalQuality(peer) : await measureRemoteQuality(peer));
  }, 2000);
}
function stopQualityMonitor(userId) {
  if (qualityTimers[userId]) { clearInterval(qualityTimers[userId]); delete qualityTimers[userId]; }
}

// ─────────────────────────────────────────────
//  createPeer — улучшенная обработка переподключения
// ─────────────────────────────────────────────
function createPeer(userId, isInitiator) {
  const peer   = new RTCPeerConnection(iceServers);
  const stream = processedStream || localStream;

  stream.getTracks().forEach(t => peer.addTrack(t, stream));

  // Устанавливаем параметры кодека
  peer.getSenders().forEach(s => {
    if (s.track?.kind === 'audio') {
      const p = s.getParameters();
      if (!p.encodings) p.encodings = [{}];
      p.encodings[0].maxBitrate = 40000;   // 40 кбит/с для голоса
      p.encodings[0].priority   = 'high';
      s.setParameters(p).catch(() => {});
    }
  });

  let restartAttempts = 0;
  let restartTimer    = null;

  function tryRestart() {
    if (restartAttempts >= 5) return;
    restartAttempts++;
    clearTimeout(restartTimer);
    const delay = Math.min(1500 * Math.pow(2, restartAttempts - 1), 20000);
    restartTimer = setTimeout(() => {
      if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') {
        console.log(`ICE restart attempt ${restartAttempts} for ${userId}`);
        peer.restartIce();
      }
    }, delay);
  }

  peer.addEventListener('connectionstatechange', () => {
    const state = peer.connectionState;
    console.log(`Peer ${shortId(userId)}: ${state}`);
    if (state === 'connected') {
      restartAttempts = 0;
      clearTimeout(restartTimer);
      // Запускаем мониторинг качества
      if (Object.keys(peers).length === 1) startQualityMonitor(socket.id, peer, true);
      startQualityMonitor(userId, peer, false);
    }
    if (state === 'failed') tryRestart();
    if (state === 'disconnected') {
      restartTimer = setTimeout(() => {
        if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed')
          tryRestart();
      }, 3000);
    }
  });

  peer.ontrack = e => {
    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio           = document.createElement('audio');
      audio.id        = 'audio-' + userId;
      audio.autoplay  = true;
      audio.playsInline = true;
      if (hiddenAudios) hiddenAudios.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.play()
      .then(() => startVolumeAnalysis(userId, e.streams[0]))
      .catch(() => {
        // Автовоспроизведение заблокировано — ждём взаимодействия
        document.addEventListener('click', () => audio.play().catch(() => {}), { once: true });
      });
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: userId, candidate: e.candidate });
  };

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    console.log(`ICE ${shortId(userId)}: ${s}`);
    if (s === 'failed') tryRestart();
    if (s === 'disconnected') {
      setTimeout(() => {
        if (peer.iceConnectionState === 'disconnected') tryRestart();
      }, 3000);
    }
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer   = await peer.createOffer();
        const improved = { type: offer.type, sdp: forceOpusMaxQuality(offer.sdp) };
        await peer.setLocalDescription(improved);
        socket.emit('offer', { to: userId, offer: improved });
      } catch (_) {}
    };
  }

  return peer;
}

// ─────────────────────────────────────────────
//  hangUp
// ─────────────────────────────────────────────
function hangUp() {
  Object.keys(analysers).forEach(stopVolumeAnalysis);
  Object.keys(qualityTimers).forEach(stopQualityMonitor);
  Object.values(peers).forEach(p => p.close());
  peers = {};
  for (const k in voiceNicknames) delete voiceNicknames[k];
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (noiseWorklet) { try { noiseWorklet.disconnect(); } catch (_) {} noiseWorklet = null; }
  if (audioCtx)     { audioCtx.close().catch(() => {}); audioCtx = null; }
  processedStream = null;
  if (noiseIndicator) noiseIndicator.classList.remove('visible');
  if (hiddenAudios)   hiddenAudios.innerHTML = '';
  pendingOffers = [];
  if (participantsList) participantsList.innerHTML = '';
  if (participantsBox)  participantsBox.style.display = 'none';
}

// ─────────────────────────────────────────────
//  Звуковые сигналы
// ─────────────────────────────────────────────
function playBeep(type) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    if (type === 'join') {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.setValueAtTime(900, ctx.currentTime + 0.12);
    } else {
      osc.frequency.setValueAtTime(900, ctx.currentTime);
      osc.frequency.setValueAtTime(500, ctx.currentTime + 0.12);
    }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close();
  } catch (_) {}
}

function playOkSound() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    [{ freq: 880, start: 0 }, { freq: 1100, start: 0.22 }].forEach(item => {
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.connect(gain);
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

// ─────────────────────────────────────────────
//  Восстановление микрофона при возврате из фона
// ─────────────────────────────────────────────
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !joined || !localStream) return;
  await requestWakeLock();
  const tracks = localStream.getAudioTracks();
  if (tracks.every(t => t.readyState === 'ended')) {
    try {
      const newRaw  = await getMicStream();
      let   newProc;
      try   { newProc = await buildAudioPipeline(newRaw); }
      catch { newProc = newRaw; }
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
// ═══════════════════════════════════════════════
//  КНОПКА ЗВОНКА
// ═══════════════════════════════════════════════
function updateCallButton() {
  if (btnPrivateCall) {
    btnPrivateCall.style.display = currentChatType === 'private' ? 'flex' : 'none';
  }
}

// ═══════════════════════════════════════════════
//  ЛИЧНЫЕ ЗВОНКИ
// ═══════════════════════════════════════════════
let pcCallPeer           = null;
let pcCallStream         = null;
let pcCallRemoteId       = null;
let pcCallRemoteNickLow  = null;
let pcCallRemoteNick     = '';
let pcCallMuted          = false;
let pcCallSpeaker        = true;
let pcCallActive         = false;
let incomingCallData     = null;
let pcIceCandidateBuffer = [];
let callTimer            = null;
let callSeconds          = 0;

function showCallScreen(name, avatar, status) {
  if (!callScreen) return;
  if (callScreenName)   callScreenName.textContent   = name || '—';
  if (callScreenStatus) callScreenStatus.textContent = status || 'Соединение…';
  if (callScreenAvatar) {
    if (avatar) callScreenAvatar.innerHTML = `<img src="${avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    else        callScreenAvatar.textContent = '👤';
  }
  if (callBtnMute)    { callBtnMute.classList.remove('active');    callBtnMute.textContent = '🎤'; }
  if (callBtnSpeaker) { callBtnSpeaker.classList.remove('active'); callBtnSpeaker.textContent = '🔈'; }
  callScreen.classList.add('active');
}
function hideCallScreen() {
  if (callScreen) callScreen.classList.remove('active');
  stopCallTimer();
}
function setCallStatus(text) {
  if (text && callScreenStatus) callScreenStatus.textContent = text;
}
function startCallTimer() {
  callSeconds = 0; stopCallTimer();
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
    const s = String(callSeconds%60).padStart(2,'0');
    if (callScreenStatus) callScreenStatus.textContent = m + ':' + s;
    if (callStatusDot) { callStatusDot.style.animation='none'; callStatusDot.style.background='#4caf50'; }
  }, 1000);
}
function stopCallTimer() {
  if (callTimer) { clearInterval(callTimer); callTimer=null; }
}

if (callBtnMute) callBtnMute.addEventListener('click', () => {
  pcCallMuted = !pcCallMuted;
  if (pcCallStream) pcCallStream.getAudioTracks().forEach(t => { t.enabled = !pcCallMuted; });
  if (pcCallMuted) { callBtnMute.classList.add('active'); callBtnMute.textContent='🔇'; }
  else             { callBtnMute.classList.remove('active'); callBtnMute.textContent='🎤'; }
});
if (callBtnSpeaker) callBtnSpeaker.addEventListener('click', () => {
  pcCallSpeaker = !pcCallSpeaker;
  const audio = document.getElementById('audio-pc-call');
  if (audio) audio.volume = pcCallSpeaker ? 1.0 : 0.0;
  if (pcCallSpeaker) { callBtnSpeaker.classList.remove('active'); callBtnSpeaker.textContent='🔈'; }
  else               { callBtnSpeaker.classList.add('active');    callBtnSpeaker.textContent='🔇'; }
});
if (callBtnVideo)  callBtnVideo.addEventListener('click', () => showToast('📷 Видеозвонки скоро появятся', 2500));
if (callBtnHangup) callBtnHangup.addEventListener('click', () => endPrivateCall(true));
if (btnCallMinimize) btnCallMinimize.addEventListener('click', () => {
  hideCallScreen();
  if (pcCallActive) showToast('📞 Звонок активен', 3000);
});

// Исходящий звонок
if (btnPrivateCall) btnPrivateCall.addEventListener('click', async () => {
  if (pcCallActive) {
    const withAvatar = chatRoomAvatar ? chatRoomAvatar.querySelector('img')?.src || null : null;
    showCallScreen(pcCallRemoteNick, withAvatar, null);
    return;
  }
  if (currentChatType !== 'private' || !currentChatId) return;
  pcCallRemoteNick    = chatRoomName ? chatRoomName.textContent : '?';
  const withAvatar    = chatRoomAvatar ? chatRoomAvatar.querySelector('img')?.src || null : null;
  try {
    pcCallStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
      video: false
    });
  } catch (e) { showToast('❌ Нет доступа к микрофону'); return; }

  const parts         = currentChatId.split('::');
  pcCallRemoteNickLow = parts.find(p => p !== myNickname.toLowerCase()) || parts[0];
  pcCallRemoteId      = null;
  pcIceCandidateBuffer = [];
  pcCallPeer = createPrivateCallPeer(pcCallRemoteNickLow, true);
  showCallScreen(pcCallRemoteNick, withAvatar, 'Вызов…');
});

// Входящий звонок
socket.on('private-call-offer', async (data) => {
  if (pcCallActive) { socket.emit('private-call-reject', { to: data.from }); return; }
  incomingCallData = data;
  if (incomingCallAvatar) {
    if (data.fromAvatar) incomingCallAvatar.innerHTML = `<img src="${data.fromAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else incomingCallAvatar.textContent = '👤';
  }
  if (incomingCallName) incomingCallName.textContent = data.fromNick || '?';
  if (modalIncomingCall) modalIncomingCall.classList.add('open');
  playIncomingRing();
});

// Принять
if (btnCallAccept) btnCallAccept.addEventListener('click', async () => {
  if (modalIncomingCall) modalIncomingCall.classList.remove('open');
  stopIncomingRing();
  if (!incomingCallData) return;
  try {
    pcCallStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
      video: false
    });
  } catch (e) {
    showToast('❌ Нет доступа к микрофону');
    socket.emit('private-call-reject', { to: incomingCallData.from });
    incomingCallData=null; return;
  }
  pcCallRemoteId      = incomingCallData.from;
  pcCallRemoteNickLow = incomingCallData.fromNickLower || incomingCallData.fromNick?.toLowerCase();
  pcCallRemoteNick    = incomingCallData.fromNick || '?';
  pcCallPeer = createPrivateCallPeer(pcCallRemoteId, false);
  await pcCallPeer.setRemoteDescription(new RTCSessionDescription(incomingCallData.offer));
  for (const c of pcIceCandidateBuffer) {
    try { await pcCallPeer.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
  }
  pcIceCandidateBuffer = [];
  const answer = await pcCallPeer.createAnswer();
  await pcCallPeer.setLocalDescription(answer);
  socket.emit('private-call-answer', { to: pcCallRemoteId, answer });
  pcCallActive = true;
  showCallScreen(pcCallRemoteNick, incomingCallData.fromAvatar||null, 'Соединение…');
  if (currentChatId !== incomingCallData.chatId) {
    socket.emit('private-chat-open', { withNickname: incomingCallData.fromNick }, res => {
      if (res.ok) enterPrivateChat(res.chatId, res.withNickname, res.withAvatar);
    });
  }
  incomingCallData = null;
});

// Отклонить
if (btnCallReject) btnCallReject.addEventListener('click', () => {
  if (modalIncomingCall) modalIncomingCall.classList.remove('open');
  stopIncomingRing();
  if (incomingCallData) {
    socket.emit('private-call-reject', { to: incomingCallData.from });
    incomingCallData = null;
  }
});

// Answer получен (звонящий)
socket.on('private-call-answer', async ({ from, answer }) => {
  if (!pcCallPeer) return;
  pcCallRemoteId = from;
  pcCallActive   = true;
  await pcCallPeer.setRemoteDescription(new RTCSessionDescription(answer));
  for (const candidate of pcIceCandidateBuffer) {
    socket.emit('private-call-ice', { to: from, candidate });
  }
  pcIceCandidateBuffer = [];
});

// ICE
socket.on('private-call-ice', async ({ from, candidate }) => {
  if (!candidate) return;
  if (pcCallPeer && pcCallPeer.remoteDescription) {
    try { await pcCallPeer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  } else {
    pcIceCandidateBuffer.push(candidate);
  }
});

socket.on('private-call-ended',   () => { showToast('📵 ' + (pcCallRemoteNick||'?') + ' завершил звонок', 3000); endPrivateCall(false); });
socket.on('private-call-rejected',() => { showToast('📵 ' + (pcCallRemoteNick||'?') + ' отклонил звонок', 3000); endPrivateCall(false); });

function endPrivateCall(notify=true) {
  if (notify && (pcCallRemoteId||pcCallRemoteNickLow))
    socket.emit('private-call-end', { to: pcCallRemoteId||pcCallRemoteNickLow });
  if (pcCallPeer)   { pcCallPeer.close();   pcCallPeer=null; }
  if (pcCallStream) { pcCallStream.getTracks().forEach(t=>t.stop()); pcCallStream=null; }
  const el = document.getElementById('audio-pc-call'); if (el) el.remove();
  pcCallActive=false; pcCallRemoteId=null; pcCallRemoteNickLow=null;
  pcCallRemoteNick=''; pcCallMuted=false; pcCallSpeaker=true; pcIceCandidateBuffer=[];
  hideCallScreen(); stopIncomingRing();
  if (modalIncomingCall) modalIncomingCall.classList.remove('open');
  stopCallTimer();
  if (callBtnMute)    { callBtnMute.textContent='🎤';    callBtnMute.classList.remove('active'); }
  if (callBtnSpeaker) { callBtnSpeaker.textContent='🔈'; callBtnSpeaker.classList.remove('active'); }
}

function createPrivateCallPeer(targetId, isInitiator) {
  const peer = new RTCPeerConnection(iceServers);
  if (pcCallStream) pcCallStream.getTracks().forEach(t => peer.addTrack(t, pcCallStream));
  peer.ontrack = e => {
    let audio = document.getElementById('audio-pc-call');
    if (!audio) {
      audio=document.createElement('audio'); audio.id='audio-pc-call';
      audio.autoplay=true; audio.playsInline=true; document.body.appendChild(audio);
    }
    audio.srcObject=e.streams[0];
    audio.volume=pcCallSpeaker?1.0:0.0;
    audio.play().catch(()=>{});
  };
  peer.onicecandidate = e => {
    if (!e.candidate) return;
    if (isInitiator) {
      if (!peer.remoteDescription) pcIceCandidateBuffer.push(e.candidate);
      else socket.emit('private-call-ice', { to: pcCallRemoteId||targetId, candidate: e.candidate });
    } else {
      socket.emit('private-call-ice', { to: pcCallRemoteId||targetId, candidate: e.candidate });
    }
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState==='connected') { startCallTimer(); showToast('🟢 Звонок установлен', 2000); }
    if (peer.connectionState==='connecting') setCallStatus('Соединение…');
    if (peer.connectionState==='disconnected'||peer.connectionState==='failed') {
      showToast('📵 Соединение прервано', 3000); endPrivateCall(false);
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState==='checking') setCallStatus('Соединение…');
    if (peer.iceConnectionState==='failed')   peer.restartIce();
  };
  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('private-call-offer', {
          chatId: currentChatId, to: pcCallRemoteNickLow, offer: peer.localDescription
        });
      } catch (e) { console.error('Offer error:', e); }
    };
  }
  return peer;
}

let ringInterval = null;
function playIncomingRing() {
  stopIncomingRing();
  let count=0;
  const ring=()=>{
    if (count++>30) { stopIncomingRing(); return; }
    try {
      const ctx=new (window.AudioContext||window.webkitAudioContext)();
      const osc=ctx.createOscillator(), gain=ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type='sine';
      osc.frequency.setValueAtTime(440,ctx.currentTime);
      osc.frequency.setValueAtTime(480,ctx.currentTime+0.15);
      gain.gain.setValueAtTime(0.3,ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.5);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.5);
      osc.onended=()=>ctx.close();
    } catch (_) {}
  };
  ring();
  ringInterval=setInterval(ring,1200);
}
function stopIncomingRing() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval=null; }
}
