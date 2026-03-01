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
//  DOM
// ═══════════════════════════════════════════════
const screenAuth  = document.getElementById('screen-auth');
const screenLobby = document.getElementById('screen-lobby');
const screenMain  = document.getElementById('screen-main');

// Auth
const tabLogin     = document.getElementById('tab-login');
const tabRegister  = document.getElementById('tab-register');
const formLogin    = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');
const loginNick    = document.getElementById('login-nick');
const loginPw      = document.getElementById('login-pw');
const loginError   = document.getElementById('login-error');
const btnLogin     = document.getElementById('btn-login');
const btnShowHint  = document.getElementById('btn-show-hint');
const regNick      = document.getElementById('reg-nick');
const regPw        = document.getElementById('reg-pw');
const regHint      = document.getElementById('reg-hint');
const regError     = document.getElementById('reg-error');
const btnRegister  = document.getElementById('btn-register');

// Drawer
const drawer        = document.getElementById('drawer');
const drawerOverlay = document.getElementById('drawer-overlay');
const drawerAvatar  = document.getElementById('drawer-avatar');
const drawerName    = document.getElementById('drawer-name');
const drawerNick    = document.getElementById('drawer-nick');

// Lobby
const btnOpenProfile = document.getElementById('btn-open-profile');
const roomsList      = document.getElementById('rooms-list');
const privateList    = document.getElementById('private-list');
const btnCreateRoom  = document.getElementById('btn-create-room');

// Lobby tabs
const lobbyTabGroups  = document.getElementById('lobby-tab-groups');
const lobbyTabPrivate = document.getElementById('lobby-tab-private');

// Chat sidebar (desktop)
const chatRoomsList   = document.getElementById('chat-rooms-list');
const chatPrivateList = document.getElementById('chat-private-list');
const chatTabGroups   = document.getElementById('chat-tab-groups');
const chatTabPrivate  = document.getElementById('chat-tab-private');

// Modals
const modalCreate       = document.getElementById('modal-create-room');
const btnCloseCreate    = document.getElementById('btn-close-create');
const roomPhotoBtn      = document.getElementById('room-photo-btn');
const roomPhotoInput    = document.getElementById('room-photo-input');
const createRoomName    = document.getElementById('create-room-name');
const createRoomPw      = document.getElementById('create-room-pw');
const btnToggleCreatePw = document.getElementById('btn-toggle-create-pw');
const createRoomError   = document.getElementById('create-room-error');
const btnSubmitCreate   = document.getElementById('btn-submit-create');
const createAutoDelete  = document.getElementById('create-room-autodelete');
const createJoinMode    = document.getElementById('create-room-joinmode');

const modalRoomPw     = document.getElementById('modal-room-password');
const btnClosePwModal = document.getElementById('btn-close-pw-modal');
const pwModalRoomName = document.getElementById('pw-modal-room-name');
const roomPwInput     = document.getElementById('room-pw-input');
const btnToggleRoomPw = document.getElementById('btn-toggle-room-pw');
const roomPwError     = document.getElementById('room-pw-error');
const btnSubmitRoomPw = document.getElementById('btn-submit-room-pw');

const modalProfile         = document.getElementById('modal-profile');
const btnCloseProfile      = document.getElementById('btn-close-profile');
const profileAvatarDisplay = document.getElementById('profile-avatar-display');
const profileAvatarWrap    = document.getElementById('profile-avatar-wrap');
const profileNameDisplay   = document.getElementById('profile-name-display');
const profileEditName      = document.getElementById('profile-edit-name');
const profileEditBio       = document.getElementById('profile-edit-bio');
const btnSaveProfile       = document.getElementById('btn-save-profile');
const friendsListContainer = document.getElementById('friends-list-container');
const friendReqContainer   = document.getElementById('friend-requests-container');
const friendSearchInput    = document.getElementById('friend-search-input');
const btnFriendSearch      = document.getElementById('btn-friend-search');
const friendSearchResult   = document.getElementById('friend-search-result');
const btnLogout            = document.getElementById('btn-logout');
const avatarInput          = document.getElementById('avatar-input');

const modalSettings     = document.getElementById('modal-settings');
const btnCloseSettings  = document.getElementById('btn-close-settings');

const modalContacts       = document.getElementById('modal-contacts');
const btnCloseContacts    = document.getElementById('btn-close-contacts');
const contactsFriendsList = document.getElementById('contacts-friends-list');
const contactsReqList     = document.getElementById('contacts-requests-list');
const contactsSearchInput = document.getElementById('contacts-search-input');
const btnContactsSearch   = document.getElementById('btn-contacts-search');
const contactsSearchResult= document.getElementById('contacts-search-result');

const modalPrivateChats   = document.getElementById('modal-private-chats');
const btnClosePrivChats   = document.getElementById('btn-close-private-chats');
const pcSearchInput       = document.getElementById('pc-search-input');
const btnPcSearch         = document.getElementById('btn-pc-search');
const pcListContainer     = document.getElementById('pc-list-container');

const modalMembers         = document.getElementById('modal-members');
const btnCloseMembers      = document.getElementById('btn-close-members');
const membersModalTitle    = document.getElementById('members-modal-title');
const renameSection        = document.getElementById('rename-section');
const renameInput          = document.getElementById('rename-input');
const btnRenameRoom        = document.getElementById('btn-rename-room');
const renameError          = document.getElementById('rename-error');
const membersListContainer = document.getElementById('members-list-container');
const groupSettingsSection = document.getElementById('group-settings-section');
const groupAutodelSelect   = document.getElementById('group-autodelete-select');
const groupJoinmodeSelect  = document.getElementById('group-joinmode-select');
const btnSaveGroupSettings = document.getElementById('btn-save-group-settings');
const btnDeleteGroup       = document.getElementById('btn-delete-group');
const joinRequestsSection  = document.getElementById('join-requests-section');
const joinRequestsCount    = document.getElementById('join-requests-count');
const joinRequestsList     = document.getElementById('join-requests-list');

const modalInvite       = document.getElementById('modal-invite');
const btnCloseInvite    = document.getElementById('btn-close-invite');
const inviteFriendsList = document.getElementById('invite-friends-list');

// Chat
const chatRoomAvatar  = document.getElementById('chat-room-avatar');
const chatRoomName    = document.getElementById('chat-room-name');
const chatHeaderInfo  = document.getElementById('chat-header-info');
const userCount       = document.getElementById('user-count');
const btnBackLobby    = document.getElementById('btn-back-lobby');
const btnJoin         = document.getElementById('btn-join');
const btnLeave        = document.getElementById('btn-leave');
const btnMic          = document.getElementById('btn-mic');
const micStatus       = document.getElementById('mic-status');
const hiddenAudios    = document.getElementById('hidden-audios');
const participantsBox = document.getElementById('participants');
const participantsList= document.getElementById('participants-list');
const reconnectBanner = document.getElementById('reconnect-banner');
const keepAliveAudio  = document.getElementById('keep-alive-audio');
const chatMessages    = document.getElementById('chat-messages');
const chatInput       = document.getElementById('chat-input');
const btnSend         = document.getElementById('btn-send');
const btnPhoto        = document.getElementById('btn-photo');
const btnVideo        = document.getElementById('btn-video');
const btnFile         = document.getElementById('btn-file');
const fileInput       = document.getElementById('file-input');
const lightbox        = document.getElementById('lightbox');
const lightboxContent = document.getElementById('lightbox-content');
const lightboxClose   = document.getElementById('lightbox-close');
const noiseIndicator  = document.getElementById('noise-indicator');
const btnRoomMembers  = document.getElementById('btn-room-members');
const btnInviteFriend = document.getElementById('btn-invite-friend');

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
let currentChatType = 'group'; // 'group' | 'private'
let currentChatId   = null;    // для личных чатов

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

const voiceNicknames = {};
const analysers      = {};
const qualityTimers  = {};
const roomDeleteTimers = {};
const SPEAKING_THRESHOLD = 8;

const typingUsers = {};
let typingTimer   = null;

const ecdhExchanged = new Set();

// ═══════════════════════════════════════════════
//  УТИЛИТЫ
// ═══════════════════════════════════════════════
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

function showScreen(name) {
  [screenAuth, screenLobby, screenMain].forEach(s => s.classList.remove('active'));
  if (name === 'auth')  screenAuth.classList.add('active');
  if (name === 'lobby') screenLobby.classList.add('active');
  if (name === 'chat')  screenMain.classList.add('active');
}

function avatarHtml(avatar, fallback = '👤', size = '100%') {
  if (avatar) return `<img src="${avatar}" alt="" style="width:${size};height:${size};object-fit:cover">`;
  return fallback;
}

// ═══════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════
function showToast(text, duration = 3000, onClick = null) {
  const container = document.getElementById('toast-container');
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

// ═══════════════════════════════════════════════
//  DRAWER (боковое меню)
// ═══════════════════════════════════════════════
function openDrawer() {
  drawer.classList.add('open');
  drawerOverlay.classList.add('open');
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawerOverlay.classList.remove('open');
}

document.getElementById('btn-open-drawer').addEventListener('click', openDrawer);
document.getElementById('btn-open-drawer-chat').addEventListener('click', openDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

function updateDrawer() {
  drawerName.textContent = myNickname || '—';
  drawerNick.textContent = myNickname ? '@' + myNickname.toLowerCase() : '';
  if (myAvatar) {
    drawerAvatar.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    drawerAvatar.textContent = '👤';
  }
}

// Меню пункты
document.getElementById('dm-profile').addEventListener('click', () => {
  closeDrawer(); openProfileModal();
});
document.getElementById('dm-contacts').addEventListener('click', () => {
  closeDrawer(); openContactsModal();
});
document.getElementById('dm-private-chats').addEventListener('click', () => {
  closeDrawer(); openPrivateChatsModal();
});
document.getElementById('dm-create-group').addEventListener('click', () => {
  closeDrawer(); openCreateRoomModal();
});
document.getElementById('dm-settings').addEventListener('click', () => {
  closeDrawer(); modalSettings.classList.add('open');
});
document.getElementById('dm-invite').addEventListener('click', () => {
  closeDrawer();
  showToast('🔗 Пригласить: поделись ссылкой на сайт!', 4000);
});
drawerAvatar.addEventListener('click', () => { closeDrawer(); openProfileModal(); });

// ═══════════════════════════════════════════════
//  LOBBY AVATAR BUTTON
// ═══════════════════════════════════════════════
function updateLobbyAvatarBtn() {
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
    tabLogin.classList.add('active'); tabRegister.classList.remove('active');
    formLogin.style.display = ''; formRegister.style.display = 'none';
  } else {
    tabRegister.classList.add('active'); tabLogin.classList.remove('active');
    formRegister.style.display = ''; formLogin.style.display = 'none';
  }
}

// Авто-вход
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
loginPw.addEventListener('keydown',  e => { if (e.key === 'Enter') doLogin(); });
function doLogin() {
  const nick = loginNick.value.trim();
  const pw   = loginPw.value;
  if (!nick) { loginError.textContent = 'Введи ник'; return; }
  if (!pw)   { loginError.textContent = 'Введи пароль'; return; }
  btnLogin.disabled = true; btnLogin.textContent = '⏳';
  socket.emit('auth-login', { nickname: nick, password: pw }, res => {
    btnLogin.disabled = false; btnLogin.textContent = 'Войти';
    if (res.ok) {
      authToken  = res.token; myNickname = res.nickname; myAvatar = res.avatar || null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = { wrong_creds: '❌ Неверный ник или пароль', rate_limited: `⛔ Подождите ${res.secsLeft} сек.` };
      loginError.textContent = msgs[res.error] || '⚠️ Ошибка входа';
      loginPw.style.animation = 'shake 0.35s';
      setTimeout(() => { loginPw.style.animation = ''; }, 400);
    }
  });
}

btnRegister.addEventListener('click', doRegister);
regNick.addEventListener('keydown', e => { if (e.key === 'Enter') regPw.focus(); });
regPw.addEventListener('keydown',   e => { if (e.key === 'Enter') regHint.focus(); });
regHint.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
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
      authToken  = res.token; myNickname = res.nickname; myAvatar = null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = { nick_taken:'❌ Ник занят', nick_short:'❌ Ник слишком короткий', pw_short:'❌ Пароль слишком короткий' };
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

// Выход
btnLogout.addEventListener('click', doLogout);
document.getElementById('settings-go-logout').addEventListener('click', doLogout);
function doLogout() {
  socket.emit('auth-logout', { token: authToken }, () => {});
  try { localStorage.removeItem('chat_token'); } catch (_) {}
  authToken = null; myNickname = ''; myAvatar = null;
  modalProfile.classList.remove('open');
  modalSettings.classList.remove('open');
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

// Chat sidebar tabs (desktop)
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
btnOpenProfile.addEventListener('click', openProfileModal);
btnCloseProfile.addEventListener('click', () => modalProfile.classList.remove('open'));
modalProfile.addEventListener('click', e => { if (e.target === modalProfile) modalProfile.classList.remove('open'); });

function openProfileModal() {
  profileNameDisplay.textContent = myNickname;
  profileEditName.value = myNickname;
  renderProfileAvatar();
  modalProfile.classList.add('open');
  loadFriends();
  // Загрузить bio
  socket.emit('profile-get', res => {
    if (res.ok) profileEditBio.value = res.bio || '';
  });
}

function renderProfileAvatar() {
  if (myAvatar) {
    profileAvatarDisplay.innerHTML = `<img src="${myAvatar}" alt="">`;
  } else {
    profileAvatarDisplay.textContent = '👤';
  }
}

// Сохранить профиль
btnSaveProfile.addEventListener('click', () => {
  const newName = profileEditName.value.trim();
  const newBio  = profileEditBio.value.trim();
  socket.emit('profile-update', { nickname: newName, bio: newBio }, res => {
    if (res.ok) {
      myNickname = res.nickname;
      profileNameDisplay.textContent = myNickname;
      updateLobbyAvatarBtn();
      showToast('✅ Профиль сохранён');
    }
  });
});

// Аватар
profileAvatarWrap.addEventListener('click', () => avatarInput.click());
avatarInput.addEventListener('change', () => {
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

// Друзья
function loadFriends() {
  socket.emit('friends-list', res => {
    if (!res.ok) return;
    renderFriendsList(res.friends, friendsListContainer);
    renderFriendRequests(res.requests, friendReqContainer);
  });
}

function renderFriendsList(friends, container) {
  if (!friends.length) {
    container.innerHTML = '<div class="empty-list">Друзей пока нет</div>'; return;
  }
  container.innerHTML = friends.map(f => `
    <div class="friend-item">
      <div class="friend-avatar">${avatarHtml(f.avatar, '👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(f.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm blue" data-action="private-chat" data-nick="${escapeHtml(f.nickname)}">💬</button>
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
    btn.addEventListener('click', () => {
      openPrivateChatWith(btn.dataset.nick);
    });
  });
}

function renderFriendRequests(requests, container) {
  if (!requests.length) {
    container.innerHTML = '<div class="empty-list">Нет входящих запросов</div>'; return;
  }
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

// Поиск для добавления друга
btnFriendSearch.addEventListener('click', () => searchUserForFriend(friendSearchInput, friendSearchResult));
friendSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchUserForFriend(friendSearchInput, friendSearchResult); });

function searchUserForFriend(inputEl, resultEl) {
  const nick = inputEl.value.trim();
  if (!nick) return;
  socket.emit('profile-get-user', { nickname: nick }, res => {
    if (!res.ok) { resultEl.innerHTML = '<div class="empty-list">❌ Не найден</div>'; return; }
    resultEl.innerHTML = `
      <div class="friend-item">
        <div class="friend-avatar">${avatarHtml(res.avatar, '👤')}</div>
        <div class="friend-info"><div class="friend-name">${escapeHtml(res.nickname)}</div>
          ${res.bio ? `<div style="font-size:12px;color:var(--sub)">${escapeHtml(res.bio)}</div>` : ''}
        </div>
        <div class="friend-actions">
          <button class="btn-sm blue" id="btn-add-found-${resultEl.id}">➕</button>
        </div>
      </div>`;
    resultEl.querySelector('.btn-sm').addEventListener('click', () => {
      socket.emit('friend-request', { toNickname: res.nickname }, r => {
        const msgs = { already_friends:'✅ Уже в друзьях', already_sent:'⏳ Уже отправлено', self:'😄 Нельзя', not_found:'❌ Не найден' };
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
  if (modalProfile.classList.contains('open')) loadFriends();
  if (modalContacts.classList.contains('open')) loadContactsFriends();
});
socket.on('friend-accepted', ({ byNick }) => {
  showToast(`✅ ${byNick} принял запрос!`, 5000);
  if (modalProfile.classList.contains('open')) loadFriends();
  if (modalContacts.classList.contains('open')) loadContactsFriends();
});

// ═══════════════════════════════════════════════
//  НАСТРОЙКИ
// ═══════════════════════════════════════════════
btnCloseSettings.addEventListener('click', () => modalSettings.classList.remove('open'));
modalSettings.addEventListener('click', e => { if (e.target === modalSettings) modalSettings.classList.remove('open'); });
document.getElementById('settings-go-profile').addEventListener('click', () => {
  modalSettings.classList.remove('open'); openProfileModal();
});
document.getElementById('settings-go-privacy').addEventListener('click', () => {
  showToast('🔒 Раздел в разработке');
});
document.getElementById('settings-go-notifs').addEventListener('click', () => {
  requestNotifPermission(); showToast('🔔 Уведомления: ' + (Notification.permission === 'granted' ? 'включены' : 'выкл/заблокированы'));
});
document.getElementById('settings-go-data').addEventListener('click', () => {
  showToast('💾 Раздел в разработке');
});
document.getElementById('settings-go-lang').addEventListener('click', () => {
  showToast('🌐 Язык: Русский');
});
document.getElementById('settings-go-chats').addEventListener('click', () => {
  showToast('💬 Раздел в разработке');
});

// ═══════════════════════════════════════════════
//  КОНТАКТЫ
// ═══════════════════════════════════════════════
function openContactsModal() {
  modalContacts.classList.add('open');
  loadContactsFriends();
}
btnCloseContacts.addEventListener('click', () => modalContacts.classList.remove('open'));
modalContacts.addEventListener('click', e => { if (e.target === modalContacts) modalContacts.classList.remove('open'); });
btnContactsSearch.addEventListener('click', () => searchUserForFriend(contactsSearchInput, contactsSearchResult));
contactsSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchUserForFriend(contactsSearchInput, contactsSearchResult); });

function loadContactsFriends() {
  socket.emit('friends-list', res => {
    if (!res.ok) return;
    renderFriendsList(res.friends, contactsFriendsList);
    renderFriendRequests(res.requests, contactsReqList);
  });
}

// ═══════════════════════════════════════════════
//  ЛИЧНЫЕ ЧАТЫ
// ═══════════════════════════════════════════════
function openPrivateChatsModal() {
  modalPrivateChats.classList.add('open');
  loadPrivateChatsList(pcListContainer);
}
btnClosePrivChats.addEventListener('click', () => modalPrivateChats.classList.remove('open'));
modalPrivateChats.addEventListener('click', e => { if (e.target === modalPrivateChats) modalPrivateChats.classList.remove('open'); });

btnPcSearch.addEventListener('click', () => {
  const nick = pcSearchInput.value.trim();
  if (!nick) return;
  openPrivateChatWith(nick);
  modalPrivateChats.classList.remove('open');
});
pcSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const nick = pcSearchInput.value.trim();
    if (!nick) return;
    openPrivateChatWith(nick);
    modalPrivateChats.classList.remove('open');
  }
});

function openPrivateChatWith(nickname) {
  socket.emit('private-chat-open', { withNickname: nickname }, res => {
    if (!res.ok) { showToast('❌ Пользователь не найден'); return; }
    enterPrivateChat(res.chatId, res.withNickname, res.withAvatar);
  });
}

async function enterPrivateChat(chatId, withNickname, withAvatar) {
  // Закрыть текущую комнату если есть
  if (currentRoomId) {
    socket.emit('leave-room');
    if (joined) { socket.emit('voice-leave'); hangUp(); joined = false; }
    currentRoomId = null; currentRoomData = null;
  }

  currentChatType = 'private';
  currentChatId   = chatId;
  isRoomOwner     = false;
  memberCount     = 2;

  // ── КЛЮЧ ДЛЯ ЛИЧНОГО ЧАТА ──
  // Деривируем детерминированный ключ из chatId (без пароля)
  // Оба участника получат одинаковый ключ т.к. chatId = sort([nickA, nickB]).join('::')
  try {
    await Crypto.deriveKey('', chatId, chatId + '-private-v1');
  } catch (e) {
    console.error('Ошибка деривации ключа личного чата:', e);
  }

  chatRoomName.textContent = withNickname;
  userCount.textContent    = '2';
  chatRoomAvatar.innerHTML = withAvatar
    ? `<img src="${withAvatar}" alt="">` : '👤';

  clearChat(); clearAllTyping();

  // Скрыть голосовые кнопки для личных чатов
  btnJoin.style.display  = 'none';
  btnLeave.style.display = 'none';
  btnMic.style.display   = 'none';

  // Вступить в socket-комнату чата
  socket.emit('private-chat-join', { chatId });

  showScreen('chat');
  showToast('💬 Личный чат: ' + withNickname, 2500);
}

function loadPrivateChatsList(container) {
  const el = container || privateList;
  socket.emit('private-chat-list', res => {
    if (!res.ok || !res.chats.length) {
      el.innerHTML = `<div class="rooms-empty">
        <div class="rooms-empty-icon">💬</div>
        <div>Нет личных чатов.<br>Найди друга и начни общение!</div>
      </div>`;
      return;
    }
    el.innerHTML = res.chats.map(c => `
      <div class="pc-card" data-chatid="${c.chatId}" data-with="${escapeHtml(c.withNickname)}" data-avatar="${c.withAvatar||''}">
        <div class="room-avatar">
          ${c.withAvatar ? `<img src="${c.withAvatar}" alt="">` : '👤'}
        </div>
        <div class="room-info">
          <div class="room-name">${escapeHtml(c.withNickname)}</div>
          <div class="room-meta" style="color:var(--green)">💬 Личный чат</div>
        </div>
        <div style="color:var(--sub);font-size:20px">›</div>
      </div>
    `).join('');
    el.querySelectorAll('.pc-card').forEach(card => {
      card.addEventListener('click', () => {
        enterPrivateChat(card.dataset.chatid, card.dataset.with, card.dataset.avatar || null);
        if (modalPrivateChats.classList.contains('open')) modalPrivateChats.classList.remove('open');
      });
    });
  });
}

// Получение личного сообщения
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
  for (const id in roomDeleteTimersMap) { clearInterval(roomDeleteTimersMap[id]); delete roomDeleteTimersMap[id]; }
}

function renderRoomList(list, container) {
  clearAllDeleteTimers();
  if (!list || !list.length) {
    container.innerHTML = `<div class="rooms-empty">
      <div class="rooms-empty-icon">🏠</div>
      <div>Групп пока нет.<br>Создай первую!</div>
    </div>`;
    return;
  }
  container.innerHTML = list.map(room => {
    const now = Date.now();
    const isEmpty = room.memberCount === 0 && room.deleteAt;
    const timerAttr = isEmpty ? ` data-delete-at="${room.deleteAt}"` : '';
    const timerHtml = isEmpty
      ? `<span class="room-badge-timer" id="timer-${room.id}">🕐 --:--</span>`
      : `<span class="room-badge-members">· 👥 ${room.memberCount}</span>`;
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
              : '<span>🌐 Открытая</span>'}
            ${timerHtml} ${joinBadge}
          </div>
        </div>
        <div style="color:var(--sub);font-size:20px">›</div>
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
      if (card.dataset.hasPw === 'true') {
        openRoomPasswordModal(card.dataset.id, card.dataset.name, joinMode);
      } else if (joinMode === 'approval') {
        handleApprovalJoin(card.dataset.id, card.dataset.name);
      } else {
        joinRoom(card.dataset.id, '');
      }
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
          ${room.memberCount} чел.
          ${room.joinMode === 'approval' ? '· 📋' : ''}
        </div>
      </div>
    </div>
  `).join('');
  chatRoomsList.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('click', () => {
      const joinMode = card.dataset.joinmode;
      if (card.dataset.hasPw === 'true') {
        openRoomPasswordModal(card.dataset.id, card.dataset.name, joinMode);
      } else if (joinMode === 'approval') {
        handleApprovalJoin(card.dataset.id, card.dataset.name);
      } else {
        joinRoom(card.dataset.id, '');
      }
    });
  });
}

socket.on('room-renamed', ({ roomId, newName }) => {
  if (currentRoomId === roomId) {
    chatRoomName.textContent = newName;
    appendSystemMsg('✏️ Переименовано: ' + newName);
  }
});

// Комната удалена сервером
socket.on('room-deleted', ({ roomId, roomName }) => {
  if (currentRoomId === roomId) {
    showToast('🗑 Группа «' + roomName + '» удалена создателем', 5000);
    leaveCurrentRoom();
    showScreen('lobby');
  }
});

// Настройки группы изменены
socket.on('room-settings-changed', ({ roomId, autoDelete, joinMode }) => {
  if (currentRoomId === roomId) {
    appendSystemMsg('⚙️ Настройки группы обновлены');
  }
});

// ═══════════════════════════════════════════════
//  СОЗДАНИЕ КОМНАТЫ
// ═══════════════════════════════════════════════
btnCreateRoom.addEventListener('click', openCreateRoomModal);
document.getElementById('btn-create-room-chat')?.addEventListener('click', openCreateRoomModal);
btnCloseCreate.addEventListener('click', () => modalCreate.classList.remove('open'));
modalCreate.addEventListener('click', e => { if (e.target === modalCreate) modalCreate.classList.remove('open'); });

function openCreateRoomModal() {
  createRoomName.value = ''; createRoomPw.value = '';
  createRoomError.textContent = ''; roomPhotoData = null;
  createAutoDelete.value = 'never'; createJoinMode.value = 'open';
  roomPhotoBtn.innerHTML = '<span class="cam-icon">📷</span><span>Фото</span>';
  modalCreate.classList.add('open');
  setTimeout(() => createRoomName.focus(), 200);
}

roomPhotoBtn.addEventListener('click', () => roomPhotoInput.click());
roomPhotoInput.addEventListener('change', () => {
  const file = roomPhotoInput.files[0]; if (!file) return;
  roomPhotoInput.value = '';
  if (file.size > 5*1024*1024) { alert('Фото слишком большое'); return; }
  const r = new FileReader();
  r.onload = e => {
    roomPhotoData = e.target.result;
    roomPhotoBtn.innerHTML = `<img src="${roomPhotoData}" alt="">`;
  };
  r.readAsDataURL(file);
});

btnToggleCreatePw.addEventListener('click', () => {
  const t = createRoomPw.type === 'text';
  createRoomPw.type = t ? 'password' : 'text';
  btnToggleCreatePw.textContent = t ? '👁' : '🙈';
});

btnSubmitCreate.addEventListener('click', submitCreateRoom);
createRoomName.addEventListener('keydown', e => { if (e.key === 'Enter') submitCreateRoom(); });

function submitCreateRoom() {
  const name = createRoomName.value.trim();
  if (!name) { createRoomError.textContent = 'Введи название'; return; }
  btnSubmitCreate.disabled = true; btnSubmitCreate.textContent = '⏳';
  socket.emit('create-room', {
    name,
    password: createRoomPw.value || '',
    photo: roomPhotoData || null,
    autoDelete: createAutoDelete.value,
    joinMode: createJoinMode.value
  }, res => {
    btnSubmitCreate.disabled = false; btnSubmitCreate.textContent = 'Создать группу';
    if (res?.ok) {
      modalCreate.classList.remove('open');
      joinRoom(res.roomId, createRoomPw.value || '');
    } else {
      createRoomError.textContent = 'Ошибка. Попробуй снова.';
    }
  });
}

// ═══════════════════════════════════════════════
//  ПАРОЛЬ КОМНАТЫ
// ═══════════════════════════════════════════════
let pendingJoinRoomMode = 'open';

function openRoomPasswordModal(roomId, roomName, joinMode) {
  pendingJoinRoom = { roomId, roomName };
  pendingJoinRoomMode = joinMode || 'open';
  pwModalRoomName.textContent = roomName;
  roomPwInput.value = ''; roomPwError.textContent = '';
  modalRoomPw.classList.add('open');
  setTimeout(() => roomPwInput.focus(), 200);
}
btnClosePwModal.addEventListener('click', () => { modalRoomPw.classList.remove('open'); pendingJoinRoom = null; });
modalRoomPw.addEventListener('click', e => { if (e.target === modalRoomPw) { modalRoomPw.classList.remove('open'); pendingJoinRoom = null; } });
btnToggleRoomPw.addEventListener('click', () => {
  const t = roomPwInput.type === 'text';
  roomPwInput.type = t ? 'password' : 'text';
  btnToggleRoomPw.textContent = t ? '👁' : '🙈';
});
btnSubmitRoomPw.addEventListener('click', submitRoomPassword);
roomPwInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitRoomPassword(); });

function submitRoomPassword() {
  if (!pendingJoinRoom) return;
  const pw = roomPwInput.value;
  if (!pw) { roomPwError.textContent = 'Введи пароль'; return; }
  btnSubmitRoomPw.disabled = true; btnSubmitRoomPw.textContent = '⏳';

  if (pendingJoinRoomMode === 'approval') {
    // Сначала ввели пароль, потом надо подать заявку
    modalRoomPw.classList.remove('open');
    btnSubmitRoomPw.disabled = false; btnSubmitRoomPw.textContent = 'Войти в группу';
    handleApprovalJoin(pendingJoinRoom.roomId, pendingJoinRoom.roomName, pw);
    pendingJoinRoom = null;
    return;
  }

  joinRoom(pendingJoinRoom.roomId, pw, (ok, err, secsLeft) => {
    btnSubmitRoomPw.disabled = false; btnSubmitRoomPw.textContent = 'Войти в группу';
    if (ok) { modalRoomPw.classList.remove('open'); pendingJoinRoom = null; }
    else if (err === 'rate_limited') roomPwError.textContent = `⛔ Подождите ${secsLeft} сек.`;
    else if (err === 'wrong_password') {
      roomPwError.textContent = '❌ Неверный пароль';
      roomPwInput.style.animation = 'shake 0.35s';
      setTimeout(() => { roomPwInput.style.animation = ''; }, 400);
    } else roomPwError.textContent = '⚠️ Ошибка';
  });
}

// ═══════════════════════════════════════════════
//  ЗАЯВКИ НА ВСТУПЛЕНИЕ
// ═══════════════════════════════════════════════
function handleApprovalJoin(roomId, roomName, _pw) {
  if (!confirm(`📋 Для вступления в «${roomName}» требуется одобрение создателя.\nОтправить заявку?`)) return;
  socket.emit('room-request-join', { roomId }, res => {
    if (res.ok) showToast('📨 Заявка отправлена! Ждём одобрения.', 5000);
    else if (res.error === 'already_requested') showToast('⏳ Заявка уже отправлена');
    else if (res.error === 'already_member') joinRoom(roomId, _pw || '');
    else showToast('⚠️ Ошибка: ' + res.error);
  });
}

// Заявка одобрена
socket.on('room-request-accepted', ({ roomId, roomName }) => {
  showToast(`✅ Заявка в «${roomName}» одобрена!`, 6000, () => {
    joinRoom(roomId, '');
  });
});
// Заявка отклонена
socket.on('room-request-declined', ({ roomId, roomName }) => {
  showToast(`❌ Заявка в «${roomName}» отклонена`, 5000);
});
// Входящая заявка (для создателя)
socket.on('room-join-request', ({ roomId, roomName, nickLower, nickname, avatar }) => {
  showToast(`📋 ${nickname} хочет вступить в «${roomName}»`, 8000, () => {
    openMembersModal();
  });
  // Если модалка открыта — обновить список заявок
  if (modalMembers.classList.contains('open') && currentRoomId === roomId) {
    loadJoinRequests(roomId);
  }
});

function loadJoinRequests(roomId) {
  socket.emit('room-members', { roomId }, res => {
    if (!res.ok) return;
    renderJoinRequests(res.pendingRequests || [], roomId);
  });
}

function renderJoinRequests(requests, roomId) {
  const count = requests.length;
  joinRequestsCount.textContent = count ? `(${count})` : '';
  if (!count) {
    joinRequestsList.innerHTML = '<div class="empty-list">Нет заявок</div>'; return;
  }
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
        if (res.ok) {
          showToast(accept ? '✅ Заявка принята' : 'Отклонено');
          loadJoinRequests(roomId);
        }
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

      chatRoomName.textContent = res.room.name;
      userCount.textContent    = res.room.members.length + 1;
      memberCount              = res.room.members.length + 1;
      chatRoomAvatar.innerHTML = res.room.photo ? `<img src="${res.room.photo}" alt="">` : '💬';

      // Восстановить голосовые кнопки
      btnJoin.style.display  = 'block';
      btnLeave.style.display = 'none';
      btnMic.style.display   = 'none';

      clearChat(); clearAllTyping();
      showScreen('chat');
      showOwnFingerprint();
      if (cb) cb(true);

      // Если создатель — предзагрузить заявки
      if (isRoomOwner && res.room.pendingRequests?.length) {
        showToast(`📋 ${res.room.pendingRequests.length} заявок на вступление`, 5000);
      }
    } else {
      if (res?.error === 'approval_required') {
        handleApprovalJoin(roomId, 'группу');
        if (cb) cb(false, 'approval_required');
        return;
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
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (_) {}
}

function clearChat() {
  const all = [...chatMessages.children];
  all.forEach((el, i) => { if (i > 1) el.remove(); });
  msgCounter = 0;
}

// ═══════════════════════════════════════════════
//  УЧАСТНИКИ КОМНАТЫ
// ═══════════════════════════════════════════════
chatRoomAvatar.addEventListener('click',  openMembersModal);
chatHeaderInfo.addEventListener('click',  openMembersModal);
btnRoomMembers.addEventListener('click',  openMembersModal);
btnCloseMembers.addEventListener('click', () => modalMembers.classList.remove('open'));
modalMembers.addEventListener('click', e => { if (e.target === modalMembers) modalMembers.classList.remove('open'); });

function openMembersModal() {
  // В личном чате — показать имя собеседника, не открывать модалку группы
  if (currentChatType === 'private') {
    showToast('💬 Личный чат с ' + chatRoomName.textContent, 2500);
    return;
  }
  if (!currentRoomId) return;

  membersModalTitle.textContent = 'Участники';
  renameSection.style.display         = isRoomOwner ? '' : 'none';
  groupSettingsSection.style.display  = isRoomOwner ? '' : 'none';
  joinRequestsSection.style.display   = isRoomOwner ? '' : 'none';

  if (isRoomOwner && currentRoomData) {
    renameInput.value = currentRoomData.name || '';
    groupAutodelSelect.value  = currentRoomData.autoDelete
      ? String(currentRoomData.autoDelete) : 'never';
    groupJoinmodeSelect.value = currentRoomData.joinMode || 'open';
  }

  membersListContainer.innerHTML = '<div class="empty-list">Загрузка…</div>';
  modalMembers.classList.add('open');

  socket.emit('room-members', { roomId: currentRoomId }, res => {
    if (!res.ok) {
      membersListContainer.innerHTML = '<div class="empty-list">Ошибка</div>';
      return;
    }
    if (!res.members.length) {
      membersListContainer.innerHTML = '<div class="empty-list">Пусто</div>';
      return;
    }
    membersListContainer.innerHTML = res.members.map(m => `
      <div class="member-item">
        <div class="member-avatar">${avatarHtml(m.avatar, '👤')}</div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.nickname)}${m.id === socket.id ? ' (Вы)' : ''}</div>
          ${m.isOwner ? '<div class="member-badge">👑 Создатель</div>' : ''}
        </div>
      </div>
    `).join('');
    if (isRoomOwner) {
      renderJoinRequests(res.pendingRequests || [], currentRoomId);
    }
  });
}

// Переименование
btnRenameRoom.addEventListener('click', () => {
  const name = renameInput.value.trim();
  if (!name) { renameError.textContent = 'Введи название'; return; }
  renameError.textContent = '';
  socket.emit('room-rename', { roomId: currentRoomId, newName: name }, res => {
    if (res.ok) {
      showToast('✅ Переименовано');
      if (currentRoomData) currentRoomData.name = name;
    } else {
      renameError.textContent = res.error === 'not_owner' ? '❌ Нет прав' : '⚠️ Ошибка';
    }
  });
});
renameInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnRenameRoom.click(); });

// Сохранить настройки группы
btnSaveGroupSettings.addEventListener('click', () => {
  socket.emit('room-settings-update', {
    roomId:     currentRoomId,
    autoDelete: groupAutodelSelect.value,
    joinMode:   groupJoinmodeSelect.value
  }, res => {
    if (res.ok) {
      showToast('✅ Настройки сохранены');
      if (currentRoomData) {
        currentRoomData.autoDelete = groupAutodelSelect.value === 'never'
          ? null : parseInt(groupAutodelSelect.value);
        currentRoomData.joinMode = groupJoinmodeSelect.value;
      }
    } else {
      showToast('⚠️ Ошибка сохранения');
    }
  });
});

// Удалить группу
btnDeleteGroup.addEventListener('click', () => {
  if (!confirm('🗑 Удалить группу? Это действие необратимо.')) return;
  socket.emit('room-delete', { roomId: currentRoomId }, res => {
    if (res.ok) {
      modalMembers.classList.remove('open');
      leaveCurrentRoom();
      showScreen('lobby');
      showToast('🗑 Группа удалена');
    } else {
      showToast('⚠️ Ошибка: ' + res.error);
    }
  });
});

// ═══════════════════════════════════════════════
//  ПРИГЛАШЕНИЯ
// ═══════════════════════════════════════════════
btnInviteFriend.addEventListener('click', () => {
  // В личном чате кнопка 👥 открывает поиск для нового личного чата
  if (currentChatType === 'private') {
    openPrivateChatsModal();
    return;
  }
  openInviteModal();
});
btnCloseInvite.addEventListener('click',  () => modalInvite.classList.remove('open'));
modalInvite.addEventListener('click', e => { if (e.target === modalInvite) modalInvite.classList.remove('open'); });

function openInviteModal() {
  if (!currentRoomId) return;
  modalInvite.classList.add('open');
  inviteFriendsList.innerHTML = '<div class="empty-list">Загрузка…</div>';
  socket.emit('friends-list', res => {
    if (!res.ok || !res.friends.length) {
      inviteFriendsList.innerHTML = '<div class="empty-list">Нет друзей для приглашения</div>';
      return;
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
          btn.disabled    = true;
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
btnBackLobby.addEventListener('click', () => {
  leaveCurrentRoom();
  showScreen('lobby');
});

function leaveCurrentRoom() {
  stopMyTyping();

  if (currentChatType === 'group' && currentRoomId) {
    socket.emit('leave-room');
    if (joined) {
      socket.emit('voice-leave'); hangUp(); joined = false;
      micStatus.className = 'mic-status';
    }
  }

  // Восстановить голосовые кнопки для следующего входа в группу
  btnJoin.style.display  = 'block';
  btnLeave.style.display = 'none';
  btnMic.style.display   = 'none';

  clearAllTyping();
  Crypto.clearAllKeys();
  ecdhExchanged.clear();
  outgoingSeq = 0;

  currentRoomId   = null;
  currentRoomData = null;
  currentPassword = '';
  currentChatType = 'group';
  currentChatId   = null;
  isRoomOwner     = false;
}

// ═══════════════════════════════════════════════
//  СОБЫТИЯ КОМНАТЫ
// ═══════════════════════════════════════════════
socket.on('room-user-joined', ({ id, nickname }) => {
  memberCount++; userCount.textContent = memberCount;
  appendSystemMsg('👋 ' + nickname + ' вошёл');
});
socket.on('room-user-left', id => {
  memberCount = Math.max(0, memberCount - 1);
  userCount.textContent = memberCount;
  Crypto.clearSessionKey(id);
});
socket.on('connect', () => {
  reconnectBanner.classList.remove('visible');
  if (myNickname) {
    socket.emit('set-nickname', myNickname, () => {
      if (currentRoomId && currentChatType === 'group') joinRoom(currentRoomId, currentPassword);
    });
  }
});
socket.on('disconnect', () => {
  if (currentRoomId) reconnectBanner.classList.add('visible');
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
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ═══════════════════════════════════════════════
//  СТАТУС «ПЕЧАТАЕТ»
// ═══════════════════════════════════════════════
const headerSubEl = document.querySelector('.tg-header-sub');

function renderTyping() {
  const names = Object.values(typingUsers).map(u => u.nickname);
  if (!names.length) {
    headerSubEl.innerHTML = `<span class="online"><span id="user-count">${memberCount}</span> участников</span>`;
    return;
  }
  const text = names.length === 1
    ? escapeHtml(names[0]) + ' печатает…'
    : escapeHtml(names.slice(0,2).join(', ')) + ' печатают…';
  headerSubEl.innerHTML = `<span class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span>${text}</span>`;
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
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  if (chatInput.value.trim().length > 0) startMyTyping(); else stopMyTyping();
});
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});
btnSend.addEventListener('click', sendTextMessage);

async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  stopMyTyping(); btnSend.disabled = true;
  try {
    if (currentChatType === 'private' && currentChatId) {
      const { encrypted, iv } = await Crypto.encrypt(text);
      const seq = ++outgoingSeq;
      socket.emit('private-message', { chatId: currentChatId, encrypted, iv, type: 'text', seq });
      appendMessage({ nickname: myNickname, text, type: 'text', timestamp: Date.now(), mine: true, status: 'ok' });
      chatInput.value = ''; chatInput.style.height = 'auto';
    } else if (currentRoomId) {
      const { encrypted, iv } = await Crypto.encrypt(text);
      const seq = ++outgoingSeq;
      socket.emit('chat-message', { encrypted, iv, type: 'text', seq });
      appendMessage({ from: socket.id, nickname: myNickname, text, type: 'text', timestamp: Date.now(), mine: true, status: 'ok' });
      chatInput.value = ''; chatInput.style.height = 'auto';
    }
  } catch (e) { console.error('Send error:', e); }
  finally { btnSend.disabled = false; }
}

// Файлы
btnPhoto.addEventListener('click', () => { fileInput.accept = 'image/*'; fileInput.click(); });
btnVideo.addEventListener('click', () => { fileInput.accept = 'video/*'; fileInput.click(); });
btnFile.addEventListener('click',  () => { fileInput.accept = '*/*';     fileInput.click(); });

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]; if (!file) return;
  fileInput.value = '';
  if (file.size > 50*1024*1024) { alert('Файл слишком большой. Макс 50 МБ.'); return; }
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
    const seq = ++outgoingSeq;
    const payload = { encrypted, iv, type, seq, fileName: fileName||'file', fileSize: blob.size, mimeType };

    if (currentChatType === 'private' && currentChatId) {
      socket.emit('private-message', { chatId: currentChatId, ...payload });
    } else if (currentRoomId) {
      socket.emit('chat-message', payload);
    }
    appendMessage({ from: socket.id, nickname: myNickname, type, localUrl, fileName: fileName||'file', fileSize: blob.size, mimeType, timestamp: Date.now(), mine: true, status: 'ok' });
  } catch (e) { alert('Ошибка отправки: ' + e.message); }
}

// Получение сообщений группы
socket.on('chat-message', async data => {
  playMsgSound();
  showBrowserNotif('💬 ' + (data.nickname||'?'), data.type==='text' ? '✉️ Сообщение' : '📎 Файл');
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
//  ЧАТ: РЕНДЕР
// ═══════════════════════════════════════════════
function appendMessage(msg) {
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
  chatMessages.scrollTop = chatMessages.scrollHeight;
  bindMediaEvents(div);
  return id;
}
function appendSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'date-divider'; div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function updateMessage(id, updates) {
  const div = document.getElementById(id); if (!div) return;
  const content = div.querySelector('.msg-content');
  if (content) {
    content.innerHTML = buildContentHTML({ type: div.dataset.type, mimeType: div.dataset.mimeType, fileName: div.dataset.fileName, fileSize: div.dataset.fileSize, ...updates });
    bindMediaEvents(div);
  }
  const st = div.querySelector('.msg-decrypt-status');
  if (st) {
    if (updates.status === 'ok')         { st.className = 'msg-decrypt-status ok';  st.textContent = '🔓'; }
    if (updates.status === 'error')      { st.className = 'msg-decrypt-status err'; st.textContent = '⚠️'; }
    if (updates.status === 'decrypting') st.textContent = '⏳';
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function buildMsgHTML(msg) {
  const time = new Date(msg.timestamp||Date.now()).toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });
  const sender = msg.mine ? '' : `<div class="msg-sender">👤 ${escapeHtml(msg.nickname||'?')}</div>`;
  const stText  = msg.status==='ok' ? '🔓' : msg.status==='error' ? '⚠️' : '⏳';
  const stClass = msg.status==='ok' ? 'ok' : msg.status==='error' ? 'err' : '';
  const st = msg.mine ? '' : `<div class="msg-decrypt-status ${stClass}">${stText}</div>`;
  return `${sender}<div class="msg-content">${buildContentHTML(msg)}</div><div class="msg-meta">${time}</div>${st}`;
}
function buildContentHTML(msg) {
  if (msg.type === 'text')  return escapeHtml(msg.text || '');
  if (msg.type === 'image') return msg.localUrl ? `<img class="msg-media" src="${msg.localUrl}" alt="фото" loading="lazy">` : '<span style="color:#888;font-size:12px">⏳</span>';
  if (msg.type === 'video') return msg.localUrl ? `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>` : '<span style="color:#888;font-size:12px">⏳</span>';
  if (msg.type === 'file') {
    const size = msg.fileSize ? formatSize(parseInt(msg.fileSize)) : '';
    return msg.localUrl
      ? `<div class="msg-file"><span class="msg-file-icon">📄</span><div class="msg-file-info"><div class="msg-file-name">${escapeHtml(msg.fileName||'файл')}</div><div class="msg-file-size">${size}</div></div><a class="msg-file-dl" href="${msg.localUrl}" download="${escapeHtml(msg.fileName||'file')}">⬇️</a></div>`
      : `<div class="msg-file"><span class="msg-file-icon">📄</span><div class="msg-file-info"><div class="msg-file-name">${escapeHtml(msg.fileName||'файл')}</div><div class="msg-file-size">${size}</div></div><span style="color:#888;font-size:12px">⏳</span></div>`;
  }
  return '';
}
function bindMediaEvents(container) {
  container.querySelectorAll('img.msg-media').forEach(img => { img.onclick = () => openLightbox('img', img.src); });
  container.querySelectorAll('video.msg-media').forEach(vid => { vid.ondblclick = () => openLightbox('video', vid.src); });
}

// ═══════════════════════════════════════════════
//  LIGHTBOX
// ═══════════════════════════════════════════════
function openLightbox(type, src) {
  lightboxContent.innerHTML = type==='img'
    ? `<img src="${src}" alt="">`
    : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}
lightboxClose.addEventListener('click', () => { lightbox.classList.remove('open'); lightboxContent.innerHTML=''; });
lightbox.addEventListener('click', e => { if (e.target===lightbox) { lightbox.classList.remove('open'); lightboxContent.innerHTML=''; } });

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ (без изменений)
// ═══════════════════════════════════════════════
btnJoin.addEventListener('click', async () => {
  if (!currentRoomId || currentChatType !== 'group') return;
  try {
    const rawStream = await getMicStream();
    localStream = rawStream;
    try { processedStream = await buildAudioPipeline(rawStream); }
    catch (e) { processedStream = rawStream; if (noiseIndicator) noiseIndicator.classList.remove('visible'); }
    await requestWakeLock(); startKeepAlive(); setMicStatus(true);
    btnJoin.style.display = 'none'; btnLeave.style.display = btnMic.style.display = 'block';
    joined = true;
    addParticipant(socket.id, myNickname, true);
    startVolumeAnalysis(socket.id, localStream);
    socket.emit('voice-join');
    for (const { from, offer, nickname } of pendingOffers) await handleOffer(from, offer, nickname);
    pendingOffers = [];
  } catch (err) {
    const msgs = { NotAllowedError:'❌ Доступ запрещён.', NotFoundError:'❌ Микрофон не найден.', NotReadableError:'❌ Микрофон занят.' };
    alert(msgs[err.name] || '❌ ' + err.name);
  }
});
btnLeave.addEventListener('click', () => {
  socket.emit('voice-leave'); hangUp(); joined = false;
  btnJoin.style.display = 'block'; btnLeave.style.display = btnMic.style.display = 'none';
  micStatus.className = 'mic-status'; micStatus.textContent = '';
  releaseWakeLock(); stopKeepAlive();
});
btnMic.addEventListener('click', () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  setMicStatus(micEnabled);
  btnMic.textContent = micEnabled ? '🔇 Выключить микрофон' : '🎙️ Включить микрофон';
});
function setMicStatus(active) {
  micStatus.textContent = active ? '🟢 Микрофон активен' : '🔴 Микрофон выключен';
  micStatus.className = 'mic-status ' + (active ? 'active' : 'muted');
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
  const uid  = typeof data==='object' ? data.id       : data;
  const nick = typeof data==='object' ? data.nickname : shortId(data);
  playBeep('join'); voiceNicknames[uid] = nick; addParticipant(uid, nick, false);
  if (joined) {
    if (!peers[uid]) peers[uid] = createPeer(uid, false);
    try { ecdhExchanged.add(uid); socket.emit('ecdh-pubkey', { to: uid, pubkey: await Crypto.exportPublicKey() }); } catch (_) {}
  } else { pendingOffers.push({ from: uid, offer: null, nickname: nick }); }
});
socket.on('offer', async ({ from, offer, nickname }) => {
  if (nickname) voiceNicknames[from] = nickname;
  if (!localStream) { pendingOffers.push({ from, offer, nickname }); return; }
  await handleOffer(from, offer, nickname);
});
async function handleOffer(from, offer, nickname) {
  if (!offer) return;
  if (nickname) { voiceNicknames[from] = nickname; updateParticipantName(from, nickname); }
  const peer = createPeer(from, false); peers[from] = peer;
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer  = await peer.createAnswer();
  const improved = { type: answer.type, sdp: forceOpusMaxQuality(answer.sdp) };
  await peer.setLocalDescription(improved);
  socket.emit('answer', { to: from, answer: improved });
}
socket.on('answer', async ({ from, answer, nickname }) => {
  if (nickname) { voiceNicknames[from] = nickname; updateParticipantName(from, nickname); }
  const peer = peers[from];
  if (peer && peer.signalingState==='have-local-offer') await peer.setRemoteDescription(new RTCSessionDescription(answer));
});
socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
});
socket.on('voice-user-left', uid => {
  playBeep('leave'); removeParticipant(uid); stopVolumeAnalysis(uid); stopQualityMonitor(uid);
  delete voiceNicknames[uid];
  if (peers[uid]) { peers[uid].close(); delete peers[uid]; }
  const el = document.getElementById('audio-'+uid); if (el) el.remove();
});
socket.on('understood', ({ from, nickname }) => {
  playOkSound();
  const b = document.createElement('div'); b.className='understood-banner';
  b.textContent = '✅ Понял! (' + (nickname||shortId(from)) + ')';
  document.body.appendChild(b); setTimeout(() => b.remove(), 3000);
});

function addParticipant(userId, nickname, isMe) {
  if (document.getElementById('p-'+userId)) { updateParticipantName(userId, nickname); return; }
  participantsBox.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'participant'; div.id = 'p-'+userId;
  const displayName = isMe ? '🟢 '+escapeHtml(nickname)+' (Вы)' : '👤 '+escapeHtml(nickname);
  const understoodBtn = isMe ? '' : `<button class="btn-understood" data-uid="${userId}">👍</button>`;
  div.innerHTML = `
    <span class="participant-name" id="pname-${userId}">${displayName}</span>
    <div class="volume-bar-wrap"><div class="volume-bar" id="vol-${userId}"></div></div>
    <div class="signal-wrap signal-none" id="sig-${userId}">
      <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
    </div>${understoodBtn}`;
  participantsList.appendChild(div);
  const btn = div.querySelector('.btn-understood');
  if (btn) btn.addEventListener('click', function() {
    socket.emit('understood');
    this.textContent = '✅'; this.disabled = true;
    setTimeout(() => { this.textContent = '👍'; this.disabled = false; }, 3000);
  });
}
function updateParticipantName(userId, nickname) {
  const el = document.getElementById('pname-'+userId); if (!el) return;
  el.textContent = userId===socket.id ? '🟢 '+nickname+' (Вы)' : '👤 '+nickname;
}
function removeParticipant(userId) {
  const el = document.getElementById('p-'+userId); if (el) el.remove();
  if (!participantsList.children.length) participantsBox.style.display = 'none';
}
function setSpeaking(userId, speaking) {
  const row = document.getElementById('p-'+userId); if (!row) return;
  row.classList.toggle('speaking', speaking);
}
function startVolumeAnalysis(userId, stream) {
  const ctx = audioCtx || new (window.AudioContext||window.webkitAudioContext)({ sampleRate:48000 });
  if (!audioCtx) audioCtx = ctx;
  stopVolumeAnalysis(userId);
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let wasSpeaking = false;
  function tick() {
    if (!analysers[userId]) return;
    analyser.getByteFrequencyData(data);
    let sum = 0; for (let i=0;i<data.length;i++) sum+=data[i];
    const pct = Math.min(100, (sum/data.length)*3);
    const bar = document.getElementById('vol-'+userId);
    if (bar) { bar.style.width=pct+'%'; bar.className='volume-bar'+(pct>60?' loud':''); }
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
  try {
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const src = ctx.createBufferSource();
    const dest = ctx.createMediaStreamDestination();
    src.buffer = buf; src.loop = true; src.connect(dest); src.start();
    keepAliveAudio.srcObject = dest.stream; keepAliveAudio.play().catch(()=>{});
  } catch (_) {}
}
function stopKeepAlive() { keepAliveAudio.srcObject = null; keepAliveAudio.pause(); }

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({ video:false, audio:{
    echoCancellation:true, noiseSuppression:true, autoGainControl:true,
    sampleRate:48000, channelCount:1, latency:0
  }});
}
async function buildAudioPipeline(rawStream) {
  if (!audioCtx || audioCtx.state==='closed')
    audioCtx = new (window.AudioContext||window.webkitAudioContext)({ sampleRate:48000, latencyHint:'interactive' });
  if (audioCtx.state==='suspended') await audioCtx.resume();
  try { await audioCtx.audioWorklet.addModule('/audio-processor.js'); } catch (_) {}
  const source = audioCtx.createMediaStreamSource(rawStream);
  const hpf = audioCtx.createBiquadFilter(); hpf.type='highpass'; hpf.frequency.value=80; hpf.Q.value=0.7;
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value=-24; comp.knee.value=8; comp.ratio.value=4; comp.attack.value=0.003; comp.release.value=0.15;
  noiseWorklet = new AudioWorkletNode(audioCtx, 'noise-gate-processor', {
    processorOptions:{ threshold:0.008, attack:0.003, release:0.08, smoothing:0.92 },
    numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1]
  });
  const gain = audioCtx.createGain(); gain.gain.value=1.1;
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(hpf).connect(comp).connect(noiseWorklet).connect(gain).connect(dest);
  if (noiseIndicator) noiseIndicator.classList.add('visible');
  return dest.stream;
}

const iceServers = {
  iceServers:[
    { urls:'stun:stun.relay.metered.ca:80' },
    { urls:'turn:global.relay.metered.ca:80', username:'4219a9030e911d3a21936639', credential:'W9K/4EBqUUoxu9FC' },
    { urls:'turn:global.relay.metered.ca:80?transport=tcp', username:'4219a9030e911d3a21936639', credential:'W9K/4EBqUUoxu9FC' },
    { urls:'turn:global.relay.metered.ca:443', username:'4219a9030e911d3a21936639', credential:'W9K/4EBqUUoxu9FC' },
    { urls:'turns:global.relay.metered.ca:443?transport=tcp', username:'4219a9030e911d3a21936639', credential:'W9K/4EBqUUoxu9FC' }
  ],
  iceCandidatePoolSize:10, bundlePolicy:'max-bundle', rtcpMuxPolicy:'require'
};

function forceOpusMaxQuality(sdp) {
  const lines=sdp.split('\r\n'), result=[];
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt=line.split(':')[1].split(' ')[0];
      if (i+1<lines.length && lines[i+1].startsWith('a=fmtp:'+pt)) i++;
      result.push('a=fmtp:'+pt+' minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000;dtx=1;cbr=0');
      continue;
    }
    if (line.startsWith('b=AS:')||line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

function calcLevel(rtt, lost, total, jitter) {
  if (rtt===null) return 'none';
  const lr = (lost+total)>0 ? lost/(lost+total) : 0;
  if (rtt<80  && lr<0.02 && jitter<0.02) return 'excellent';
  if (rtt<150 && lr<0.05 && jitter<0.05) return 'good';
  if (rtt<300 && lr<0.10 && jitter<0.10) return 'fair';
  return 'poor';
}
function renderSignal(userId, level) { const w=document.getElementById('sig-'+userId); if(w) w.className='signal-wrap signal-'+level; }
async function measureRemoteQuality(peer) {
  try {
    const stats=await peer.getStats(); let rtt=null,lost=0,received=0,jitter=0;
    stats.forEach(r=>{
      if (r.type==='inbound-rtp'&&r.kind==='audio') { lost=r.packetsLost||0;received=r.packetsReceived||0;jitter=r.jitter||0; }
      if (r.type==='candidate-pair'&&r.state==='succeeded'&&r.currentRoundTripTime!=null) rtt=r.currentRoundTripTime*1000;
    });
    return calcLevel(rtt, lost, received, jitter);
  } catch { return 'none'; }
}
async function measureLocalQuality(peer) {
  try {
    const stats=await peer.getStats(); let rtt=null,lost=0,sent=0,jitter=0;
    stats.forEach(r=>{
      if (r.type==='remote-inbound-rtp'&&r.kind==='audio') { lost=r.packetsLost||0;jitter=r.jitter||0;if(r.roundTripTime!=null) rtt=r.roundTripTime*1000; }
      if (r.type==='outbound-rtp'&&r.kind==='audio') sent=r.packetsSent||0;
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
function stopQualityMonitor(userId) { if(qualityTimers[userId]){clearInterval(qualityTimers[userId]);delete qualityTimers[userId];} }

function createPeer(userId, isInitiator) {
  const peer   = new RTCPeerConnection(iceServers);
  const stream = processedStream || localStream;
  stream.getTracks().forEach(t => peer.addTrack(t, stream));
  peer.getSenders().forEach(s => {
    if (s.track?.kind==='audio') {
      const p=s.getParameters(); if(!p.encodings) p.encodings=[{}];
      p.encodings[0].maxBitrate=64000; p.encodings[0].priority='high'; p.encodings[0].networkPriority='high';
      s.setParameters(p).catch(()=>{});
    }
  });
  let restartAttempts=0, restartTimer=null;
  function tryRestart() {
    if (restartAttempts>=5) return;
    restartAttempts++;
    clearTimeout(restartTimer);
    restartTimer=setTimeout(()=>{
      if (peer.connectionState==='failed'||peer.iceConnectionState==='failed') peer.restartIce();
    }, Math.min(2000*Math.pow(2,restartAttempts-1),30000));
  }
  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState==='connected') {
      restartAttempts=0; clearTimeout(restartTimer);
      if (Object.keys(peers).length===1) startQualityMonitor(socket.id, peer, true);
      startQualityMonitor(userId, peer, false);
    }
    if (peer.connectionState==='failed') tryRestart();
    if (peer.connectionState==='disconnected')
      restartTimer=setTimeout(()=>{ if(peer.connectionState==='disconnected'||peer.connectionState==='failed') tryRestart(); }, 4000);
  });
  peer.ontrack = e => {
    let audio=document.getElementById('audio-'+userId);
    if (!audio) { audio=document.createElement('audio'); audio.id='audio-'+userId; audio.autoplay=true; audio.playsInline=true; hiddenAudios.appendChild(audio); }
    audio.srcObject=e.streams[0];
    audio.play().then(()=>startVolumeAnalysis(userId,e.streams[0])).catch(()=>{});
  };
  peer.onicecandidate = e => { if(e.candidate) socket.emit('ice-candidate',{to:userId,candidate:e.candidate}); };
  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState==='failed') tryRestart();
    if (peer.iceConnectionState==='disconnected') setTimeout(()=>{ if(peer.iceConnectionState==='disconnected') tryRestart(); },4000);
  };
  if (isInitiator) peer.onnegotiationneeded = async () => {
    try {
      const offer=await peer.createOffer();
      const improved={type:offer.type,sdp:forceOpusMaxQuality(offer.sdp)};
      await peer.setLocalDescription(improved);
      socket.emit('offer',{to:userId,offer:improved});
    } catch (_) {}
  };
  return peer;
}

function hangUp() {
  Object.keys(analysers).forEach(stopVolumeAnalysis);
  Object.keys(qualityTimers).forEach(stopQualityMonitor);
  Object.values(peers).forEach(p=>p.close()); peers={};
  for (const k in voiceNicknames) delete voiceNicknames[k];
  if (localStream) { localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  if (noiseWorklet) { try { noiseWorklet.disconnect(); } catch(_){} noiseWorklet=null; }
  if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx=null; }
  processedStream=null;
  if (noiseIndicator) noiseIndicator.classList.remove('visible');
  hiddenAudios.innerHTML=''; pendingOffers=[];
  participantsList.innerHTML=''; participantsBox.style.display='none';
}

function playBeep(type) {
  try {
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.35);
    if (type==='join') { osc.frequency.setValueAtTime(600,ctx.currentTime); osc.frequency.setValueAtTime(900,ctx.currentTime+0.12); }
    else               { osc.frequency.setValueAtTime(900,ctx.currentTime); osc.frequency.setValueAtTime(500,ctx.currentTime+0.12); }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.35);
    osc.onended=()=>ctx.close();
  } catch (_) {}
}
function playOkSound() {
  try {
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const gain=ctx.createGain(); gain.connect(ctx.destination);
    [{freq:880,start:0},{freq:1100,start:0.22}].forEach(item=>{
      const osc=ctx.createOscillator(); osc.type='sine'; osc.connect(gain);
      osc.frequency.setValueAtTime(item.freq, ctx.currentTime+item.start);
      gain.gain.setValueAtTime(0, ctx.currentTime+item.start);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime+item.start+0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+item.start+0.20);
      osc.start(ctx.currentTime+item.start); osc.stop(ctx.currentTime+item.start+0.22);
    });
    setTimeout(()=>ctx.close(), 1500);
  } catch (_) {}
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState!=='visible'||!joined||!localStream) return;
  await requestWakeLock();
  const tracks=localStream.getAudioTracks();
  if (tracks.every(t=>t.readyState==='ended')) {
    try {
      const newRaw=await getMicStream();
      let newProc; try { newProc=await buildAudioPipeline(newRaw); } catch { newProc=newRaw; }
      const procTrack=newProc.getAudioTracks()[0];
      for (const uid in peers) {
        const sender=peers[uid].getSenders().find(s=>s.track?.kind==='audio');
        if (sender&&procTrack) await sender.replaceTrack(procTrack);
      }
      const newTrack=newRaw.getAudioTracks()[0];
      tracks.forEach(t=>{localStream.removeTrack(t);t.stop();});
      localStream.addTrack(newTrack); processedStream=newProc;
      stopVolumeAnalysis(socket.id); startVolumeAnalysis(socket.id, localStream);
      newTrack.enabled=micEnabled;
    } catch (_) {}
  } else { tracks.forEach(t=>{t.enabled=micEnabled;}); }
  if (audioCtx?.state==='suspended') await audioCtx.resume();
});
