// ═══════════════════════════════════════════════
//  УТИЛИТА: безопасная конвертация ArrayBuffer→Base64
// ═══════════════════════════════════════════════
function arrayBufferToBase64Safe(buffer) {
  const bytes  = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const CHUNK  = 8192;
  let binary   = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

// ═══════════════════════════════════════════════
//  ТЕМА: ДЕНЬ / НОЧЬ
// ═══════════════════════════════════════════════
const THEME_KEY = 'privchat_theme';
let currentTheme = localStorage.getItem(THEME_KEY) || 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
  const btns = document.querySelectorAll('.theme-toggle-btn, #btn-drawer-theme');
  btns.forEach(btn => {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  });
  if (theme === 'light') {
    document.documentElement.style.setProperty('--bg',        '#f0f2f5');
    document.documentElement.style.setProperty('--bg2',       '#e4e6eb');
    document.documentElement.style.setProperty('--surface',   '#ffffff');
    document.documentElement.style.setProperty('--surface2',  '#f7f8fa');
    document.documentElement.style.setProperty('--surface3',  '#efefef');
    document.documentElement.style.setProperty('--text',      '#1a1a2e');
    document.documentElement.style.setProperty('--text2',     '#4a4a6a');
    document.documentElement.style.setProperty('--sub',       '#8888aa');
    document.documentElement.style.setProperty('--divider',   'rgba(0,0,0,0.08)');
    document.documentElement.style.setProperty('--bubble-in', '#ffffff');
    document.documentElement.style.setProperty('--bubble-me', '#d9c8f8');
    document.documentElement.style.setProperty('--glass',     'rgba(255,255,255,0.85)');
  } else {
    document.documentElement.style.setProperty('--bg',        '#0a0a0f');
    document.documentElement.style.setProperty('--bg2',       '#111118');
    document.documentElement.style.setProperty('--surface',   '#16161f');
    document.documentElement.style.setProperty('--surface2',  '#1c1c28');
    document.documentElement.style.setProperty('--surface3',  '#222232');
    document.documentElement.style.setProperty('--text',      '#e8e8f0');
    document.documentElement.style.setProperty('--text2',     '#9090b0');
    document.documentElement.style.setProperty('--sub',       '#55556a');
    document.documentElement.style.setProperty('--divider',   'rgba(255,255,255,0.06)');
    document.documentElement.style.setProperty('--bubble-in', '#16161f');
    document.documentElement.style.setProperty('--bubble-me', '#2d1f5e');
    document.documentElement.style.setProperty('--glass',     'rgba(22,22,31,0.85)');
  }
}

function toggleTheme() { applyTheme(currentTheme === 'dark' ? 'light' : 'dark'); }
applyTheme(currentTheme);

// ═══════════════════════════════════════════════
//  МНОГОУРОВНЕВОЕ ШИФРОВАНИЕ
// ═══════════════════════════════════════════════
const Crypto = (() => {
  let roomKey    = null;
  const sessionKeys  = {};
  const messageKeys  = {};
  let myEcdhKeyPair  = null;
  let messageCounter = 0;
  const KEY_ROTATION_INTERVAL = 100;

  async function deriveKey(password, roomId, roomSalt) {
    const enc    = new TextEncoder();
    const secret = (password || 'open') + '|' + roomId;
    const keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const saltBytes = enc.encode(roomSalt + 'privchat-v4-aes256gcm');
    roomKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 310000, hash: 'SHA-256' },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return roomKey;
  }

  async function generateEcdhKeyPair() {
    myEcdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-384' },
      true,
      ['deriveKey', 'deriveBits']
    );
    return myEcdhKeyPair;
  }

  async function exportPublicKey() {
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const raw = await crypto.subtle.exportKey('raw', myEcdhKeyPair.publicKey);
    return arrayBufferToBase64Safe(raw);
  }

  async function deriveSessionKey(theirPubKeyB64, peerId) {
    const raw = Uint8Array.from(atob(theirPubKeyB64), c => c.charCodeAt(0));
    let theirKey;
    try {
      theirKey = await crypto.subtle.importKey(
        'raw', raw, { name: 'ECDH', namedCurve: 'P-384' }, false, []
      );
    } catch (_) {
      theirKey = await crypto.subtle.importKey(
        'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
      );
    }
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirKey },
      myEcdhKeyPair.privateKey,
      384
    );
    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const enc     = new TextEncoder();

    sessionKeys[peerId] = await crypto.subtle.deriveKey(
      {
        name: 'HKDF', hash: 'SHA-256',
        salt: enc.encode('privchat-session-v3-aes'),
        info: enc.encode('ecdh-aes-gcm-256-session')
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    const rotationBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF', hash: 'SHA-256',
        salt: enc.encode('privchat-rotation-v3'),
        info: enc.encode('forward-secrecy-seed')
      },
      hkdfKey,
      256
    );
    messageKeys[peerId] = { seed: rotationBits, counter: 0 };

    return sessionKeys[peerId];
  }

  async function getRotatedKey(peerId) {
    const base = messageKeys[peerId];
    if (!base) return sessionKeys[peerId];

    const counter = base.counter;
    const enc     = new TextEncoder();
    const keyMat  = await crypto.subtle.importKey('raw', base.seed, 'HKDF', false, ['deriveKey']);
    const rotated = await crypto.subtle.deriveKey(
      {
        name: 'HKDF', hash: 'SHA-256',
        salt: enc.encode('rotation-' + counter),
        info: enc.encode('rotated-aes-gcm-256')
      },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    messageKeys[peerId].counter++;
    return rotated;
  }

  async function getKeyFingerprint() {
    if (!myEcdhKeyPair) await generateEcdhKeyPair();
    const raw  = await crypto.subtle.exportKey('raw', myEcdhKeyPair.publicKey);
    const hash = await crypto.subtle.digest('SHA-256', raw);
    const hex  = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{4}/g).slice(0, 8).join(' ').toUpperCase();
  }

  function getSessionKey(peerId)   { return sessionKeys[peerId] || null; }
  function clearSessionKey(peerId) {
    delete sessionKeys[peerId];
    delete messageKeys[peerId];
  }

  async function encrypt(data, key) {
    const useKey = key || roomKey;
    if (!useKey) throw new Error('No encryption key available');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let encoded;
    if (typeof data === 'string') {
      encoded = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      encoded = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      encoded = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      throw new TypeError('encrypt: unsupported data type');
    }
    const paddingSize = Math.floor(Math.random() * 16);
    const padding     = crypto.getRandomValues(new Uint8Array(paddingSize));
    const padded      = new Uint8Array(1 + paddingSize + encoded.length);
    padded[0]         = paddingSize;
    padded.set(padding, 1);
    padded.set(encoded, 1 + paddingSize);

    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, useKey, padded);
    return {
      iv:        arrayBufferToBase64Safe(iv.buffer),
      encrypted: arrayBufferToBase64Safe(cipher)
    };
  }

  async function decrypt(encB64, ivB64, key) {
    const useKey = key || roomKey;
    if (!useKey) throw new Error('No decryption key available');
    const iv     = Uint8Array.from(atob(ivB64),  c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
    const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, useKey, cipher);
    const view        = new Uint8Array(plain);
    const paddingSize = view[0];
    return plain.slice(1 + paddingSize);
  }

  async function decryptText(encB64, ivB64, key) {
    return new TextDecoder().decode(await decrypt(encB64, ivB64, key));
  }

  async function decryptBlob(encB64, ivB64, mime, key) {
    return new Blob([await decrypt(encB64, ivB64, key)], { type: mime });
  }

  function clearAllKeys() {
    roomKey = null;
    myEcdhKeyPair = null;
    for (const k in sessionKeys) delete sessionKeys[k];
    for (const k in messageKeys) delete messageKeys[k];
    messageCounter = 0;
  }

  async function generateOTK() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
  }

  async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return arrayBufferToBase64Safe(raw);
  }

  async function importKey(b64) {
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  return {
    deriveKey, encrypt, decryptText, decryptBlob, decrypt,
    generateEcdhKeyPair, exportPublicKey, deriveSessionKey,
    getRotatedKey, getKeyFingerprint,
    getSessionKey, clearSessionKey, clearAllKeys,
    generateOTK, exportKey, importKey
  };
})();

// ═══════════════════════════════════════════════
//  SERVICE WORKER
// ═══════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ═══════════════════════════════════════════════
//  SOCKET
// ═══════════════════════════════════════════════
const socket = io({
  reconnection:          true,
  reconnectionAttempts:  Infinity,
  reconnectionDelay:     1000,
  reconnectionDelayMax:  5000,
  timeout:               20000,
  transports:            ['websocket', 'polling'],
  autoConnect:           true,
});

// ═══════════════════════════════════════════════
//  DOM
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
const unifiedList    = $('unified-list');
const btnCreateRoom  = $('btn-create-room');

const lobbyTabAll     = $('lobby-tab-all');
const lobbyTabGroups  = $('lobby-tab-groups');
const lobbyTabPrivate = $('lobby-tab-private');

const chatUnifiedList = $('chat-unified-list');
const chatRoomsList   = $('chat-rooms-list');
const chatPrivateList = $('chat-private-list');
const chatTabAll      = $('chat-tab-all');
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

const modalIncomingCall  = $('modal-incoming-call');
const incomingCallAvatar = $('incoming-call-avatar');
const incomingCallName   = $('incoming-call-name');
const btnCallAccept      = $('btn-call-accept');
const btnCallReject      = $('btn-call-reject');
const btnPrivateCall     = $('btn-private-call');

const btnVoiceRecord    = $('btn-voice-record');
const voiceRecordTimer  = $('voice-record-timer');
const voiceRecordTime   = $('voice-record-time');

// ═══════════════════════════════════════════════
//  СОСТОЯНИЕ
// ═══════════════════════════════════════════════
let myNickname      = '';
let myUsername      = '';
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
let currentChatWith = null;

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

const msgIdToDomId  = new Map();
const seqToMsgId    = new Map();
const unreadCounts  = {};
let totalUnread     = 0;

const notifSettings = {};
try {
  const saved = localStorage.getItem('notifSettings');
  if (saved) Object.assign(notifSettings, JSON.parse(saved));
} catch (_) {}

function saveNotifSettings() {
  try { localStorage.setItem('notifSettings', JSON.stringify(notifSettings)); } catch (_) {}
}
function getNotifSetting(id) { return notifSettings[id] || 'all'; }
function setNotifSetting(id, val) { notifSettings[id] = val; saveNotifSettings(); }

const SPEAKING_THRESHOLD = 20;
const voiceNicknames   = {};
const analysers        = {};
const qualityTimers    = {};
const typingUsers  = {};
let typingTimer    = null;
const ecdhExchanged = new Set();

let cachedRoomList    = [];
let cachedPrivateList = [];

let voiceRecorder      = null;
let voiceRecordStream  = null;
let voiceRecordChunks  = [];
let voiceRecordSeconds = 0;
let voiceRecordInterval= null;
let isVoiceRecording   = false;

let isSpeakerMode    = false;
let pcCallIsVideo    = false;
let localVideoStream = null;

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
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  return String(Math.floor(s/60)).padStart(1,'0') + ':' + String(s%60).padStart(2,'0');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
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
  updateHeaderButtons();
}

function avatarHtml(avatar, fallback = '👤', size = '100%') {
  if (avatar) return `<img src="${escapeHtml(avatar)}" alt="" style="width:${size};height:${size};object-fit:cover">`;
  return fallback;
}

// ═══════════════════════════════════════════════
//  КНОПКИ ШАПКИ ЧАТА
// ═══════════════════════════════════════════════
function updateHeaderButtons() {
  const isPrivate = currentChatType === 'private';
  const callBtn   = $('btn-private-call');
  const membersBtn= $('btn-room-members');
  if (callBtn)    callBtn.style.display    = isPrivate ? 'flex' : 'none';
  if (membersBtn) membersBtn.style.display = isPrivate ? 'none' : 'flex';
}

// ═══════════════════════════════════════════════
//  ПРОФИЛЬ СОБЕСЕДНИКА
// ═══════════════════════════════════════════════
function openPeerProfile(nickname, avatar) {
  if (!nickname) return;
  const peerLower = nickname.toLowerCase();

  const sheet = document.createElement('div');
  sheet.className = 'peer-profile-sheet';
  sheet.id = 'peer-profile-sheet';
  sheet.innerHTML = `
    <div style="position:sticky;top:0;background:transparent;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:max(env(safe-area-inset-top),14px) 16px 0;">
      <button id="peer-back-btn" style="background:rgba(0,0,0,0.4);border:none;color:white;font-size:22px;cursor:pointer;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:50%;backdrop-filter:blur(8px);">←</button>
      <button id="peer-more-btn" style="background:rgba(0,0,0,0.4);border:none;color:white;font-size:20px;cursor:pointer;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:50%;backdrop-filter:blur(8px);">⋯</button>
    </div>
    <div style="position:relative;height:320px;background:linear-gradient(180deg,#1a0f30,#0d0d1a);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:24px;flex-shrink:0;">
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0.15;font-size:180px;user-select:none;">👤</div>
      <div style="width:120px;height:120px;border-radius:50%;background:var(--accent-g);overflow:hidden;border:3px solid rgba(255,255,255,0.15);box-shadow:0 8px 32px rgba(0,0,0,0.6);position:relative;z-index:1;">
        ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:100%;height:100%;object-fit:cover">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:50px;">👤</div>'}
      </div>
      <div style="margin-top:14px;font-size:24px;font-weight:800;color:white;position:relative;z-index:1;">${escapeHtml(nickname)}</div>
      <div id="peer-bio-hero" style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:4px;position:relative;z-index:1;">был(а) недавно</div>
    </div>
    <div style="display:flex;gap:10px;padding:16px;background:var(--surface);border-bottom:1px solid var(--divider);">
      <button id="peer-call-btn" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 8px;background:var(--bg2);border:1px solid rgba(255,255,255,0.06);border-radius:16px;color:var(--accent2);cursor:pointer;">
        <span style="font-size:22px">📞</span><span style="font-size:11px;font-weight:600">звонок</span>
      </button>
      <button id="peer-msg-btn" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 8px;background:var(--bg2);border:1px solid rgba(255,255,255,0.06);border-radius:16px;color:var(--accent2);cursor:pointer;">
        <span style="font-size:22px">💬</span><span style="font-size:11px;font-weight:600">сообщение</span>
      </button>
      <button id="peer-add-friend-btn" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 8px;background:var(--bg2);border:1px solid rgba(255,255,255,0.06);border-radius:16px;color:var(--accent2);cursor:pointer;">
        <span style="font-size:22px">➕</span><span style="font-size:11px;font-weight:600">добавить</span>
      </button>
      <button id="peer-notif-btn" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 8px;background:var(--bg2);border:1px solid rgba(255,255,255,0.06);border-radius:16px;color:var(--accent2);cursor:pointer;">
        <span style="font-size:22px">🔔</span><span style="font-size:11px;font-weight:600">звук</span>
      </button>
    </div>
    <div style="background:var(--surface);margin-top:8px;padding:0 16px;border-top:1px solid var(--divider);border-bottom:1px solid var(--divider);">
      <div style="padding:14px 0;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:11px;color:var(--sub);margin-bottom:4px">имя пользователя</div>
          <div style="font-size:16px;color:var(--accent2);font-weight:500">@${escapeHtml(peerLower)}</div>
        </div>
      </div>
      <div id="peer-bio-block" style="display:none;padding:14px 0;border-top:1px solid var(--divider);">
        <div style="font-size:11px;color:var(--sub);margin-bottom:4px">о себе</div>
        <div id="peer-bio-val" style="font-size:15px;color:var(--text);line-height:1.6"></div>
      </div>
    </div>
    <div id="peer-actions-menu" style="display:none;background:var(--surface);border-radius:var(--radius);overflow:hidden;border:1px solid var(--divider);margin:8px 16px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
      <div id="peer-action-add" style="display:flex;align-items:center;gap:14px;padding:15px 16px;border-bottom:1px solid var(--divider);cursor:pointer;">
        <span style="font-size:20px">➕</span><span style="font-size:15px">Добавить в контакты</span>
      </div>
      <div id="peer-action-block" style="display:flex;align-items:center;gap:14px;padding:15px 16px;border-bottom:1px solid var(--divider);cursor:pointer;">
        <span style="font-size:20px">🚫</span><span style="font-size:15px">Заблокировать</span>
      </div>
      <div id="peer-action-notif" style="display:flex;align-items:center;gap:14px;padding:15px 16px;border-bottom:1px solid var(--divider);cursor:pointer;">
        <span style="font-size:20px">🔔</span><span style="font-size:15px">Уведомления</span>
      </div>
      <div id="peer-action-delete" style="display:flex;align-items:center;gap:14px;padding:15px 16px;cursor:pointer;">
        <span style="font-size:20px">🗑</span><span style="font-size:15px;color:var(--red)">Удалить переписку</span>
      </div>
    </div>
    <div style="height:32px"></div>`;

  document.body.appendChild(sheet);
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));

  const close = () => {
    sheet.classList.add('closing');
    sheet.addEventListener('animationend', () => sheet.remove(), { once: true });
  };

  sheet.querySelector('#peer-back-btn').addEventListener('click', close);
  sheet.querySelector('#peer-more-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const menu = sheet.querySelector('#peer-actions-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  socket.emit('profile-get-user', { nickname }, res => {
    if (!res.ok) return;
    const bioHero  = sheet.querySelector('#peer-bio-hero');
    const bioBlock = sheet.querySelector('#peer-bio-block');
    const bioVal   = sheet.querySelector('#peer-bio-val');
    if (bioHero && res.bio) bioHero.textContent = res.bio;
    if (res.bio && bioBlock && bioVal) {
      bioBlock.style.display = 'block';
      bioVal.textContent     = res.bio;
    }
  });

  const toggleMenu = () => {
    const menu = sheet.querySelector('#peer-actions-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  };

  sheet.querySelector('#peer-add-friend-btn')?.addEventListener('click', () => {
    socket.emit('friend-request', { toNickname: nickname }, r => {
      const msgs = { already_friends: '✅ Уже в друзьях', already_sent: '⏳ Запрос уже отправлен', self: '😄 Нельзя', not_found: '❌ Не найден' };
      showToast(r.ok ? '📨 Запрос отправлен!' : (msgs[r.error] || '⚠️ Ошибка'));
    });
  });

  sheet.querySelector('#peer-action-add')?.addEventListener('click', () => {
    socket.emit('friend-request', { toNickname: nickname }, r => {
      const msgs = { already_friends: '✅ Уже в друзьях', already_sent: '⏳ Запрос уже отправлен', self: '😄 Нельзя', not_found: '❌ Не найден' };
      showToast(r.ok ? '📨 Запрос отправлен!' : (msgs[r.error] || '⚠️ Ошибка'));
      toggleMenu();
    });
  });

  sheet.querySelector('#peer-action-block')?.addEventListener('click', () => {
    if (confirm(`Заблокировать ${nickname}?`)) {
      socket.emit('user-block', { nickname }, res => {
        if (res?.ok) { showToast('🚫 Пользователь заблокирован'); close(); }
      });
    }
    toggleMenu();
  });

  sheet.querySelector('#peer-action-notif')?.addEventListener('click', () => {
    toggleMenu();
    openChatNotifSettings(currentChatId || nickname, nickname);
  });

  sheet.querySelector('#peer-action-delete')?.addEventListener('click', () => {
    if (confirm('Удалить переписку?')) { close(); showToast('🗑 Переписка удалена'); }
    toggleMenu();
  });

  sheet.querySelector('#peer-call-btn')?.addEventListener('click', () => {
    close();
    setTimeout(() => {
      openPrivateChatWith(nickname);
      setTimeout(() => startPrivateCall(false), 800);
    }, 400);
  });

  sheet.querySelector('#peer-msg-btn')?.addEventListener('click', () => {
    close();
    setTimeout(() => openPrivateChatWith(nickname), 400);
  });

  sheet.querySelector('#peer-notif-btn')?.addEventListener('click', () => {
    openChatNotifSettings(currentChatId || nickname, nickname);
  });

  let startX = 0;
  sheet.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX;
    if (dx > 0) { sheet.style.transform = `translateX(${dx}px)`; sheet.style.opacity = String(1 - dx / 300); if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  sheet.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    sheet.style.transform = ''; sheet.style.opacity = '';
    if (dx > 80) close();
  }, { passive: true });
}

if (chatRoomAvatar) chatRoomAvatar.addEventListener('click', () => {
  if (currentChatType === 'private' && currentChatWith) {
    const img = chatRoomAvatar.querySelector('img');
    openPeerProfile(currentChatWith, img ? img.src : null);
  } else if (currentChatType === 'group') {
    openMembersModal();
  }
});

if (chatHeaderInfo) chatHeaderInfo.addEventListener('click', () => {
  if (currentChatType === 'private' && currentChatWith) {
    const img = chatRoomAvatar?.querySelector('img');
    openPeerProfile(currentChatWith, img ? img.src : null);
  } else if (currentChatType === 'group') {
    openMembersModal();
  }
});

// ═══════════════════════════════════════════════
//  СЧЁТЧИК НЕПРОЧИТАННЫХ
// ═══════════════════════════════════════════════
function updateTabBadge() {
  totalUnread = Object.values(unreadCounts).reduce((a,b)=>a+b, 0);
  try { document.title = totalUnread > 0 ? `(${totalUnread}) Приватный чат` : 'Приватный чат'; } catch (_) {}
}
function addUnread(id, count = 1) {
  if (!id) return;
  unreadCounts[id] = (unreadCounts[id] || 0) + count;
  updateTabBadge(); renderUnifiedList(); renderUnifiedListInChat();
}
function clearUnread(id) {
  if (!id || !unreadCounts[id]) return;
  delete unreadCounts[id];
  updateTabBadge(); renderUnifiedList(); renderUnifiedListInChat();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const id = currentChatType === 'private' ? currentChatId : currentRoomId;
    if (id) clearUnread(id);
  }
});

// ═══════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════
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

function playMsgSound(chatId) {
  const setting = getNotifSetting(chatId || '');
  if (setting === 'none') return;
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

function showBrowserNotif(title, body, chatId) {
  if (chatId && getNotifSetting(chatId) === 'none') return;
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icon.png', silent: false, tag: chatId });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 5000);
  } catch (_) {}
}

// ═══════════════════════════════════════════════
//  DRAWER
// ═══════════════════════════════════════════════
function openDrawer()  { drawer.classList.add('open');    drawerOverlay.classList.add('open'); }
function closeDrawer() { drawer.classList.remove('open'); drawerOverlay.classList.remove('open'); }

$('btn-open-drawer').addEventListener('click', openDrawer);
$('btn-open-drawer-chat').addEventListener('click', openDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

function updateDrawer() {
  if (drawerName) drawerName.textContent = myNickname || '—';
  if (drawerNick) drawerNick.textContent = myUsername ? '@' + myUsername : (myNickname ? '@' + myNickname.toLowerCase() : '');
  if (!drawerAvatar) return;
  if (myAvatar) drawerAvatar.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else drawerAvatar.textContent = '👤';
}

$('btn-drawer-theme')?.addEventListener('click', toggleTheme);
$('dm-profile').addEventListener('click',      () => { closeDrawer(); openProfileModal(); });
$('dm-contacts').addEventListener('click',     () => { closeDrawer(); openContactsModal(); });
$('dm-create-group').addEventListener('click', () => { closeDrawer(); openCreateRoomModal(); });
$('dm-settings').addEventListener('click',    () => { closeDrawer(); modalSettings.classList.add('open'); });
$('dm-invite').addEventListener('click',       () => { closeDrawer(); showToast('🔗 Поделись ссылкой на сайт!', 4000); });
$('dm-about')?.addEventListener('click',       () => { closeDrawer(); openAboutPage(); });
drawerAvatar.addEventListener('click', () => { closeDrawer(); openProfileModal(); });

function updateLobbyAvatarBtn() {
  if (!btnOpenProfile) return;
  if (myAvatar) btnOpenProfile.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else btnOpenProfile.textContent = '👤';
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

(function tryAutoLogin() {
  try {
    const token = localStorage.getItem('chat_token');
    if (!token) return;
    const doAuth = () => {
      socket.emit('auth-token', { token }, res => {
        if (res.ok) {
          authToken  = token; myNickname = res.nickname;
          myUsername = res.username || res.nickname.toLowerCase();
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
  if (!nick) { loginError.textContent = 'Введи ник или логин'; return; }
  if (!pw)   { loginError.textContent = 'Введи пароль'; return; }
  btnLogin.disabled = true; btnLogin.textContent = '⏳';
  socket.emit('auth-login', { nickname: nick, password: pw }, res => {
    btnLogin.disabled = false; btnLogin.textContent = 'Войти';
    if (res.ok) {
      authToken = res.token; myNickname = res.nickname;
      myUsername = res.username || res.nickname.toLowerCase();
      myAvatar = res.avatar || null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = { wrong_creds: '❌ Неверный ник/логин или пароль', rate_limited: `⛔ Подождите ${res.secsLeft} сек.` };
      loginError.textContent = msgs[res.error] || '⚠️ Ошибка входа';
      loginPw.style.animation = 'shake 0.35s';
      setTimeout(() => { loginPw.style.animation = ''; }, 400);
    }
  });
}

btnRegister.addEventListener('click', doRegister);
regNick.addEventListener('keydown',  e => { if (e.key === 'Enter') regPw.focus(); });
regPw.addEventListener('keydown',    e => { if (e.key === 'Enter') doRegister(); });

function doRegister() {
  const nick     = regNick.value.trim();
  const pw       = regPw.value;
  const hint     = $('reg-hint')     ? $('reg-hint').value.trim()     : '';
  const phone    = $('reg-phone')    ? $('reg-phone').value.trim()    : '';
  const username = $('reg-username') ? $('reg-username').value.trim() : '';
  if (!nick || nick.length < 2) { regError.textContent = 'Ник минимум 2 символа'; return; }
  if (!pw || pw.length < 4)     { regError.textContent = 'Пароль минимум 4 символа'; return; }
  btnRegister.disabled = true; btnRegister.textContent = '⏳';
  socket.emit('auth-register', { nickname: nick, password: pw, hint, phone, username }, res => {
    btnRegister.disabled = false; btnRegister.textContent = 'Создать аккаунт';
    if (res.ok) {
      authToken = res.token; myNickname = res.nickname;
      myUsername = res.username || res.nickname.toLowerCase();
      myAvatar = null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = { nick_taken: '❌ Ник занят', username_taken: '❌ Логин занят', nick_short: '❌ Ник слишком короткий', pw_short: '❌ Пароль слишком короткий' };
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

const btnResetPw = $('btn-reset-password');
if (btnResetPw) {
  btnResetPw.addEventListener('click', () => {
    const phone = $('reset-phone') ? $('reset-phone').value.trim() : '';
    const newPw = $('reset-newpw') ? $('reset-newpw').value : '';
    if (!phone) { showToast('❌ Введи номер телефона'); return; }
    if (!newPw || newPw.length < 4) { showToast('❌ Пароль минимум 4 символа'); return; }
    socket.emit('auth-reset-password', { phone, newPassword: newPw }, res => {
      if (res.ok) {
        showToast('✅ Пароль изменён! Войди с новым паролем', 5000);
        const s = $('reset-password-section'); if (s) s.style.display = 'none';
      } else {
        const msgs = { not_found: '❌ Номер не найден', rate_limited: `⛔ Подождите ${res.secsLeft} сек.` };
        showToast(msgs[res.error] || '⚠️ Ошибка');
      }
    });
  });
}

const btnShowReset = $('btn-show-reset');
if (btnShowReset) {
  btnShowReset.addEventListener('click', () => {
    const s = $('reset-password-section');
    if (s) s.style.display = s.style.display === 'none' ? '' : 'none';
  });
}

function onAuthSuccess() {
  socket.emit('set-nickname', myNickname, () => {});
  updateLobbyAvatarBtn();
  showScreen('lobby');
  renderUnifiedList();
  loadPrivateChatsList();
  requestNotifPermission();
}

btnLogout.addEventListener('click', doLogout);
$('settings-go-logout')?.addEventListener('click', doLogout);
function doLogout() {
  socket.emit('auth-logout', { token: authToken }, () => {});
  try { localStorage.removeItem('chat_token'); } catch (_) {}
  authToken = null; myNickname = ''; myUsername = ''; myAvatar = null;
  if (modalProfile) modalProfile.classList.remove('open');
  if (modalSettings) modalSettings.classList.remove('open');
  showScreen('auth');
}

// ═══════════════════════════════════════════════
//  КНОПКА "+" — меню нового чата
// ═══════════════════════════════════════════════
function openNewChatMenu() {
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  sheet.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2);touch-action:pan-y">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:20px">Новый чат</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="nc-group" style="padding:16px 18px;border-radius:14px;border:1px solid rgba(124,92,191,0.2);background:var(--bg2);color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:14px">
          <span style="font-size:24px;width:40px;text-align:center">👥</span>
          <div><div style="font-weight:600">Создать группу</div><div style="font-size:12px;color:var(--sub)">Чат для нескольких участников</div></div>
        </button>
        <button id="nc-private" style="padding:16px 18px;border-radius:14px;border:1px solid rgba(124,92,191,0.2);background:var(--bg2);color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:14px">
          <span style="font-size:24px;width:40px;text-align:center">💬</span>
          <div><div style="font-weight:600">Написать другу</div><div style="font-size:12px;color:var(--sub)">Личный чат из контактов</div></div>
        </button>
        <button id="nc-search" style="padding:16px 18px;border-radius:14px;border:1px solid rgba(124,92,191,0.2);background:var(--bg2);color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:14px">
          <span style="font-size:24px;width:40px;text-align:center">🔍</span>
          <div><div style="font-weight:600">Найти пользователя</div><div style="font-size:12px;color:var(--sub)">Поиск по нику или логину</div></div>
        </button>
      </div>
      <button id="nc-cancel" style="margin-top:14px;width:100%;padding:14px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
    </div>`;
  document.body.appendChild(sheet);

  const inner = sheet.querySelector('div');
  let startY = 0;
  inner.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
  inner.addEventListener('touchmove', e => {
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) { inner.style.transform = `translateY(${dy}px)`; inner.style.opacity = String(1 - dy / 300); }
  }, { passive: true });
  inner.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - startY;
    inner.style.transform = ''; inner.style.opacity = '';
    if (dy > 80) close();
  }, { passive: true });

  const close = () => sheet.remove();
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  sheet.querySelector('#nc-cancel').addEventListener('click', close);
  sheet.querySelector('#nc-group').addEventListener('click', () => { close(); openCreateRoomModal(); });
  sheet.querySelector('#nc-private').addEventListener('click', () => { close(); openFriendPickerForChat(); });
  sheet.querySelector('#nc-search').addEventListener('click', () => { close(); openUserSearchForChat(); });
}

function openFriendPickerForChat() {
  socket.emit('friends-list', res => {
    if (!res.ok || !res.friends.length) { showToast('😔 Нет друзей. Сначала добавь кого-нибудь!', 4000); return; }
    const sheet = document.createElement('div');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
    sheet.innerHTML = `
      <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2);max-height:70vh;overflow-y:auto">
        <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
        <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:16px">💬 Выбери друга</div>
        <div id="fp-list" style="display:flex;flex-direction:column;gap:4px">
          ${res.friends.map(f => `
            <button class="fp-item" data-nick="${escapeHtml(f.nickname)}"
              style="padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,0.06);background:var(--bg2);color:var(--text);font-size:14px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px">
              <div style="width:42px;height:42px;border-radius:50%;background:var(--accent-g);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
                ${f.avatar ? `<img src="${escapeHtml(f.avatar)}" style="width:100%;height:100%;object-fit:cover">` : '👤'}
              </div>
              <div style="font-weight:600">${escapeHtml(f.nickname)}</div>
            </button>`).join('')}
        </div>
        <button id="fp-cancel" style="margin-top:14px;width:100%;padding:14px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
      </div>`;
    document.body.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
    sheet.querySelector('#fp-cancel').addEventListener('click', close);
    sheet.querySelectorAll('.fp-item').forEach(btn => {
      btn.addEventListener('click', () => { close(); openPrivateChatWith(btn.dataset.nick); });
    });
  });
}

function openUserSearchForChat() {
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  sheet.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2)">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:16px">🔍 Найти пользователя</div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input id="us-input" type="text" placeholder="Ник или @логин…" maxlength="32"
          style="flex:1;padding:13px 16px;background:var(--bg2);border:1.5px solid rgba(255,255,255,0.07);border-radius:14px;color:var(--text);font-size:16px;outline:none;font-family:inherit;-webkit-appearance:none"
          autocorrect="off" autocapitalize="none"/>
        <button id="us-search-btn" style="padding:13px 18px;border:none;border-radius:14px;background:var(--accent-g);color:white;font-size:14px;font-weight:700;cursor:pointer">Найти</button>
      </div>
      <div id="us-result"></div>
      <button id="us-cancel" style="margin-top:14px;width:100%;padding:14px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  sheet.querySelector('#us-cancel').addEventListener('click', close);
  const input  = sheet.querySelector('#us-input');
  const result = sheet.querySelector('#us-result');
  const doSearch = () => {
    const nick = input.value.trim().replace(/^@/, '');
    if (!nick) return;
    socket.emit('profile-get-user', { nickname: nick }, res => {
      if (!res.ok) { result.innerHTML = '<div style="text-align:center;color:var(--sub);padding:16px">❌ Не найден</div>'; return; }
      result.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg2);border-radius:14px;border:1px solid rgba(255,255,255,0.06)">
          <div style="width:42px;height:42px;border-radius:50%;background:var(--accent-g);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
            ${res.avatar ? `<img src="${escapeHtml(res.avatar)}" style="width:100%;height:100%;object-fit:cover">` : '👤'}
          </div>
          <div style="flex:1"><div style="font-weight:600">${escapeHtml(res.nickname)}</div>${res.bio ? `<div style="font-size:12px;color:var(--sub)">${escapeHtml(res.bio)}</div>` : ''}</div>
          <button id="us-open-chat" style="padding:10px 16px;border:none;border-radius:12px;background:var(--accent-g);color:white;font-size:13px;font-weight:700;cursor:pointer">Написать</button>
        </div>`;
      result.querySelector('#us-open-chat').addEventListener('click', () => { close(); openPrivateChatWith(res.nickname); });
    });
  };
  sheet.querySelector('#us-search-btn').addEventListener('click', doSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  setTimeout(() => input.focus(), 200);
}

if (btnCreateRoom)  btnCreateRoom.addEventListener('click', openNewChatMenu);
$('btn-create-room-chat')?.addEventListener('click', openNewChatMenu);

// ═══════════════════════════════════════════════
//  ВКЛАДКИ ЛОББИ
// ═══════════════════════════════════════════════
if (lobbyTabAll) lobbyTabAll.addEventListener('click', () => {
  [lobbyTabAll, lobbyTabGroups, lobbyTabPrivate].forEach(t => t && t.classList.remove('active'));
  lobbyTabAll.classList.add('active');
  if (unifiedList) unifiedList.style.display = '';
  if (roomsList)   roomsList.style.display   = 'none';
  if (privateList) privateList.style.display = 'none';
  renderUnifiedList();
});
if (lobbyTabGroups) lobbyTabGroups.addEventListener('click', () => {
  [lobbyTabAll, lobbyTabGroups, lobbyTabPrivate].forEach(t => t && t.classList.remove('active'));
  lobbyTabGroups.classList.add('active');
  if (unifiedList) unifiedList.style.display = 'none';
  if (roomsList)   roomsList.style.display   = '';
  if (privateList) privateList.style.display = 'none';
  renderRoomList(cachedRoomList, roomsList);
});
if (lobbyTabPrivate) lobbyTabPrivate.addEventListener('click', () => {
  [lobbyTabAll, lobbyTabGroups, lobbyTabPrivate].forEach(t => t && t.classList.remove('active'));
  lobbyTabPrivate.classList.add('active');
  if (unifiedList) unifiedList.style.display = 'none';
  if (roomsList)   roomsList.style.display   = 'none';
  if (privateList) privateList.style.display = '';
  loadPrivateChatsList(privateList);
});

if (chatTabAll) chatTabAll.addEventListener('click', () => {
  [chatTabAll, chatTabGroups, chatTabPrivate].forEach(t => t && t.classList.remove('active'));
  chatTabAll.classList.add('active');
  if (chatUnifiedList) chatUnifiedList.style.display = '';
  if (chatRoomsList)   chatRoomsList.style.display   = 'none';
  if (chatPrivateList) chatPrivateList.style.display = 'none';
  renderUnifiedListInChat();
});
if (chatTabGroups) chatTabGroups.addEventListener('click', () => {
  [chatTabAll, chatTabGroups, chatTabPrivate].forEach(t => t && t.classList.remove('active'));
  chatTabGroups.classList.add('active');
  if (chatUnifiedList) chatUnifiedList.style.display = 'none';
  if (chatRoomsList)   chatRoomsList.style.display   = '';
  if (chatPrivateList) chatPrivateList.style.display = 'none';
  renderRoomListInChat(cachedRoomList);
});
if (chatTabPrivate) chatTabPrivate.addEventListener('click', () => {
  [chatTabAll, chatTabGroups, chatTabPrivate].forEach(t => t && t.classList.remove('active'));
  chatTabPrivate.classList.add('active');
  if (chatUnifiedList) chatUnifiedList.style.display = 'none';
  if (chatRoomsList)   chatRoomsList.style.display   = 'none';
  if (chatPrivateList) chatPrivateList.style.display = '';
  loadPrivateChatsList(chatPrivateList);
});

function renderUnifiedList() {
  if (!unifiedList) return;
  const groups   = cachedRoomList   || [];
  const privates = cachedPrivateList || [];
  if (!groups.length && !privates.length) {
    unifiedList.innerHTML = `<div class="rooms-empty"><div class="rooms-empty-icon">💬</div><div>Нет чатов.<br>Нажми + чтобы начать!</div></div>`;
    return;
  }
  let html = '';
  if (groups.length)   { html += `<div class="chat-list-section-title">👥 Группы</div>`;  html += groups.map(r => buildRoomCardHTML(r)).join(''); }
  if (privates.length) { html += `<div class="chat-list-section-title">💬 Личные чаты</div>`; html += privates.map(c => buildPrivateCardHTML(c)).join(''); }
  unifiedList.innerHTML = html;
  bindRoomCardEvents(unifiedList); bindPrivateCardEvents(unifiedList);
}

function renderUnifiedListInChat() {
  if (!chatUnifiedList) return;
  const groups   = cachedRoomList   || [];
  const privates = cachedPrivateList || [];
  if (!groups.length && !privates.length) {
    chatUnifiedList.innerHTML = `<div class="rooms-empty" style="padding:20px 10px"><div class="rooms-empty-icon" style="font-size:36px">💬</div><div style="font-size:13px">Нет чатов</div></div>`;
    return;
  }
  let html = '';
  if (groups.length)   { html += `<div class="chat-list-section-title">👥 Группы</div>`;  html += groups.map(r => buildRoomCardSmallHTML(r)).join(''); }
  if (privates.length) { html += `<div class="chat-list-section-title">💬 Личные</div>`; html += privates.map(c => buildPrivateCardSmallHTML(c)).join(''); }
  chatUnifiedList.innerHTML = html;
  bindRoomCardEvents(chatUnifiedList); bindPrivateCardEvents(chatUnifiedList);
}

function buildUnreadBadge(id) {
  const count = unreadCounts[id] || 0;
  if (!count) return '';
  return `<div class="room-unread">${count > 99 ? '99+' : count}</div>`;
}
function buildNotifIcon(id) {
  const s = getNotifSetting(id);
  if (s === 'none') return `<span style="font-size:13px;color:var(--sub)">🔕</span>`;
  if (s === 'mute') return `<span style="font-size:13px;color:var(--sub)">🔇</span>`;
  return '';
}

function buildRoomCardHTML(room) {
  const isEmpty   = room.memberCount === 0 && room.deleteAt;
  const timerHtml = isEmpty ? `<span class="room-badge-timer" id="timer-${room.id}">🕐 --:--</span>` : `<span>👥 ${room.memberCount}</span>`;
  const joinBadge = room.joinMode === 'approval' ? `<span style="color:var(--orange);font-size:11px">📋</span>` : '';
  return `
    <div class="room-card" data-id="${room.id}" data-has-pw="${room.hasPassword}" data-name="${escapeHtml(room.name)}" data-joinmode="${room.joinMode||'open'}" data-delete-at="${room.deleteAt||''}">
      <div class="room-avatar">${room.photo ? `<img src="${escapeHtml(room.photo)}" alt="">` : '🏠'}</div>
      <div class="room-info">
        <div class="room-name">${escapeHtml(room.name)}</div>
        <div class="room-meta">${room.hasPassword ? '<span class="room-badge-lock">🔐</span>' : '<span>🌐</span>'} ${timerHtml} ${joinBadge} ${buildNotifIcon(room.id)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${buildUnreadBadge(room.id)}<div class="room-arrow">›</div></div>
    </div>`;
}
function buildRoomCardSmallHTML(room) {
  return `
    <div class="room-card" style="margin-bottom:4px" data-id="${room.id}" data-has-pw="${room.hasPassword}" data-name="${escapeHtml(room.name)}" data-joinmode="${room.joinMode||'open'}">
      <div class="room-avatar" style="width:38px;height:38px;font-size:16px">${room.photo ? `<img src="${escapeHtml(room.photo)}" alt="">` : '🏠'}</div>
      <div class="room-info"><div class="room-name" style="font-size:13px">${escapeHtml(room.name)}</div><div class="room-meta" style="font-size:11px">${room.memberCount} чел.</div></div>
      ${buildUnreadBadge(room.id)}
    </div>`;
}
function buildPrivateCardHTML(c) {
  let lastMsgText = '💬 Личный чат';
  if (c.lastMessage) {
    const t = c.lastMessage.type;
    lastMsgText = t==='text'?'💬 Сообщение':t==='image'?'🖼 Фото':t==='video'?'🎬 Видео':t==='voice'?'🎤 Голосовое':'📎 Файл';
  }
  const timeStr = c.lastMessage ? new Date(c.lastMessage.timestamp).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}) : '';
  return `
    <div class="pc-card" data-chatid="${c.chatId}" data-with="${escapeHtml(c.withNickname)}" data-avatar="${escapeHtml(c.withAvatar||'')}">
      <div class="room-avatar">${c.withAvatar?`<img src="${escapeHtml(c.withAvatar)}" alt="">`:'👤'}</div>
      <div class="room-info">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div class="room-name">${escapeHtml(c.withNickname)}</div>
          ${timeStr?`<div style="font-size:11px;color:var(--sub);flex-shrink:0;margin-left:8px">${timeStr}</div>`:''}
        </div>
        <div class="room-meta">${lastMsgText} ${buildNotifIcon(c.chatId)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${buildUnreadBadge(c.chatId)}<div class="room-arrow">›</div></div>
    </div>`;
}
function buildPrivateCardSmallHTML(c) {
  return `
    <div class="pc-card" style="margin-bottom:4px" data-chatid="${c.chatId}" data-with="${escapeHtml(c.withNickname)}" data-avatar="${escapeHtml(c.withAvatar||'')}">
      <div class="room-avatar" style="width:38px;height:38px;font-size:16px">${c.withAvatar?`<img src="${escapeHtml(c.withAvatar)}" alt="">`:'👤'}</div>
      <div class="room-info"><div class="room-name" style="font-size:13px">${escapeHtml(c.withNickname)}</div><div class="room-meta" style="font-size:11px">💬 Личный</div></div>
      ${buildUnreadBadge(c.chatId)}
    </div>`;
}

function bindRoomCardEvents(container) {
  container.querySelectorAll('.room-card[data-id]').forEach(card => {
    card.addEventListener('click', () => {
      const joinMode = card.dataset.joinmode;
      if (card.dataset.hasPw === 'true') openRoomPasswordModal(card.dataset.id, card.dataset.name, joinMode);
      else if (joinMode === 'approval')  handleApprovalJoin(card.dataset.id, card.dataset.name);
      else joinRoom(card.dataset.id, '');
    });
  });
}
function bindPrivateCardEvents(container) {
  container.querySelectorAll('.pc-card[data-chatid]').forEach(card => {
    card.addEventListener('click', () => {
      closeAllModals();
      enterPrivateChat(card.dataset.chatid, card.dataset.with, card.dataset.avatar || null);
    });
  });
}

// ═══════════════════════════════════════════════
//  ПРОФИЛЬ
// ═══════════════════════════════════════════════
if (btnOpenProfile)   btnOpenProfile.addEventListener('click', openProfileModal);
if (btnCloseProfile)  btnCloseProfile.addEventListener('click', () => { if (window._closeModal) window._closeModal(modalProfile); else modalProfile.classList.remove('open'); });

function openProfileModal() {
  if (!modalProfile) return;
  if (profileNameDisplay) profileNameDisplay.textContent = myNickname;
  if (profileEditName)    profileEditName.value = myNickname;
  renderProfileAvatar();
  modalProfile.classList.add('open');
  loadFriends();
  socket.emit('profile-get', res => {
    if (res.ok) {
      if (profileEditBio) profileEditBio.value = res.bio || '';
      const phoneEl = $('profile-edit-phone'); if (phoneEl) phoneEl.value = res.phone || '';
    }
  });
}

function renderProfileAvatar() {
  if (!profileAvatarDisplay) return;
  if (myAvatar) profileAvatarDisplay.innerHTML = `<img src="${myAvatar}" alt="">`;
  else profileAvatarDisplay.textContent = '👤';
}

if (btnSaveProfile) btnSaveProfile.addEventListener('click', () => {
  const newName  = profileEditName ? profileEditName.value.trim() : '';
  const newBio   = profileEditBio  ? profileEditBio.value.trim()  : '';
  const newPhone = $('profile-edit-phone') ? $('profile-edit-phone').value.trim() : '';
  socket.emit('profile-update', { nickname: newName, bio: newBio, phone: newPhone }, res => {
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
  if (file.size > 5*1024*1024) { showToast('⚠️ Фото слишком большое'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    myAvatar = e.target.result;
    renderProfileAvatar(); updateLobbyAvatarBtn();
    socket.emit('profile-set-avatar', { avatar: myAvatar }, res => { if (res.ok) showToast('✅ Аватар обновлён'); });
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
      <div class="friend-avatar">${avatarHtml(f.avatar,'👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(f.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm blue" data-action="private-chat"  data-nick="${escapeHtml(f.nickname)}">💬</button>
        <button class="btn-sm red"  data-action="remove-friend" data-nick="${escapeHtml(f.nickname)}">✕</button>
      </div>
    </div>`).join('');
  container.querySelectorAll('[data-action="remove-friend"]').forEach(btn => {
    btn.addEventListener('click', () => { socket.emit('friend-remove',{nickname:btn.dataset.nick},res=>{ if(res.ok){loadFriends();showToast('Удалён из друзей');}}); });
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
      <div class="friend-avatar">${avatarHtml(r.avatar,'👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(r.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm green" data-action="accept"  data-nick="${escapeHtml(r.nickname)}">✓</button>
        <button class="btn-sm red"   data-action="decline" data-nick="${escapeHtml(r.nickname)}">✕</button>
      </div>
    </div>`).join('');
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const accept = btn.dataset.action === 'accept';
      socket.emit('friend-respond',{fromNickname:btn.dataset.nick,accept},res=>{ if(res.ok){loadFriends();showToast(accept?'✅ Добавлен!':'Отклонено');} });
    });
  });
}
if (btnFriendSearch) btnFriendSearch.addEventListener('click', () => searchUserForFriend(friendSearchInput, friendSearchResult));
if (friendSearchInput) friendSearchInput.addEventListener('keydown', e => { if (e.key==='Enter') searchUserForFriend(friendSearchInput, friendSearchResult); });
function searchUserForFriend(inputEl, resultEl) {
  if (!inputEl||!resultEl) return;
  const nick = inputEl.value.trim().replace(/^@/,''); if (!nick) return;
  socket.emit('profile-get-user',{nickname:nick},res=>{
    if (!res.ok){resultEl.innerHTML='<div class="empty-list">❌ Не найден</div>';return;}
    resultEl.innerHTML=`<div class="friend-item"><div class="friend-avatar">${avatarHtml(res.avatar,'👤')}</div><div class="friend-info"><div class="friend-name">${escapeHtml(res.nickname)}</div>${res.bio?`<div style="font-size:12px;color:var(--sub)">${escapeHtml(res.bio)}</div>`:''}</div><div class="friend-actions"><button class="btn-sm blue" id="btn-add-found-res">➕</button></div></div>`;
    resultEl.querySelector('.btn-sm').addEventListener('click',()=>{
      socket.emit('friend-request',{toNickname:res.nickname},r=>{
        const msgs={already_friends:'✅ Уже в друзьях',already_sent:'⏳ Уже отправлено',self:'😄 Нельзя',not_found:'❌ Не найден'};
        showToast(r.ok?'📨 Запрос отправлен!':(msgs[r.error]||'⚠️ Ошибка'));
        if(r.ok)resultEl.innerHTML='';
      });
    });
  });
}

socket.on('friend-request-incoming', ({ fromNick }) => {
  showToast(`👋 ${fromNick} хочет добавить тебя в друзья`, 6000, () => {
    socket.emit('friend-respond',{fromNickname:fromNick,accept:true},res=>{ if(res.ok){showToast('✅ Добавлен!');loadFriends();} });
  });
  if (modalProfile?.classList.contains('open')) loadFriends();
  if (modalContacts?.classList.contains('open')) loadContactsFriends();
});
socket.on('friend-accepted', ({ byNick }) => {
  showToast(`✅ ${byNick} принял запрос!`, 5000);
  if (modalProfile?.classList.contains('open')) loadFriends();
  if (modalContacts?.classList.contains('open')) loadContactsFriends();
});

// ═══════════════════════════════════════════════
//  НАСТРОЙКИ УВЕДОМЛЕНИЙ ЧАТА
// ═══════════════════════════════════════════════
function openChatNotifSettings(chatId, chatName) {
  const current = getNotifSetting(chatId);
  const sheet   = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  sheet.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2);touch-action:pan-y">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:6px">🔔 Уведомления</div>
      <div style="font-size:13px;color:var(--sub);text-align:center;margin-bottom:22px">${escapeHtml(chatName)}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="notif-opt" data-val="all" style="padding:14px 18px;border-radius:14px;border:1.5px solid ${current==='all'?'var(--accent)':'rgba(255,255,255,0.07)'};background:${current==='all'?'rgba(124,92,191,0.12)':'var(--bg2)'};color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px">
          <span>🔔</span><div><div style="font-weight:600">Все уведомления</div><div style="font-size:12px;color:var(--sub)">Получать все звуки и уведомления</div></div>
        </button>
        <button class="notif-opt" data-val="mute" style="padding:14px 18px;border-radius:14px;border:1.5px solid ${current==='mute'?'var(--accent)':'rgba(255,255,255,0.07)'};background:${current==='mute'?'rgba(124,92,191,0.12)':'var(--bg2)'};color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px">
          <span>🔇</span><div><div style="font-weight:600">Беззвучно</div><div style="font-size:12px;color:var(--sub)">Уведомления без звука</div></div>
        </button>
        <button class="notif-opt" data-val="none" style="padding:14px 18px;border-radius:14px;border:1.5px solid ${current==='none'?'var(--accent)':'rgba(255,255,255,0.07)'};background:${current==='none'?'rgba(124,92,191,0.12)':'var(--bg2)'};color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px">
          <span>🔕</span><div><div style="font-weight:600">Выключить</div><div style="font-size:12px;color:var(--sub)">Никаких уведомлений</div></div>
        </button>
      </div>
      <button id="notif-close-btn" style="margin-top:16px;width:100%;padding:14px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
    </div>`;
  document.body.appendChild(sheet);
  const inner = sheet.querySelector('div');
  let startY = 0;
  inner.addEventListener('touchstart', e=>{startY=e.touches[0].clientY;},{passive:true});
  inner.addEventListener('touchmove', e=>{const dy=e.touches[0].clientY-startY;if(dy>0){inner.style.transform=`translateY(${dy}px)`;inner.style.opacity=String(1-dy/300);}},{passive:true});
  inner.addEventListener('touchend', e=>{const dy=e.changedTouches[0].clientY-startY;inner.style.transform='';inner.style.opacity='';if(dy>80)sheet.remove();},{passive:true});
  sheet.querySelectorAll('.notif-opt').forEach(btn=>{
    btn.addEventListener('click',()=>{
      setNotifSetting(chatId,btn.dataset.val);sheet.remove();
      showToast(btn.dataset.val==='all'?'🔔 Уведомления включены':btn.dataset.val==='mute'?'🔇 Беззвучный режим':'🔕 Уведомления выключены');
      renderUnifiedList();renderUnifiedListInChat();
      updateNotifButton();
    });
  });
  sheet.querySelector('#notif-close-btn').addEventListener('click',()=>sheet.remove());
  sheet.addEventListener('click',e=>{if(e.target===sheet)sheet.remove();});
}

// ═══════════════════════════════════════════════
//  КОНФИДЕНЦИАЛЬНОСТЬ
// ═══════════════════════════════════════════════
function openPrivacySettings() {
  socket.emit('privacy-get', res => {
    const p = res.ok ? res.privacy : {};
    const sheet = document.createElement('div');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg);overflow-y:auto;display:flex;flex-direction:column';
    sheet.innerHTML = `
      <div style="position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--divider);display:flex;align-items:center;gap:12px;padding:max(env(safe-area-inset-top),14px) 16px 14px;z-index:1">
        <button id="priv-back" style="background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%">←</button>
        <div style="font-size:18px;font-weight:800">🔒 Конфиденциальность</div>
      </div>
      <div style="padding:16px;max-width:520px;width:100%;margin:0 auto">
        <div style="font-size:11px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:16px 4px 8px">🔐 Шифрование</div>
        <div style="background:var(--surface);border-radius:var(--radius);padding:20px;margin-bottom:8px;border:1px solid rgba(124,92,191,0.2)">
          <div style="font-size:13px;color:var(--text2);line-height:1.8">
            ✅ <strong>AES-256-GCM</strong> — шифрование всех сообщений<br>
            ✅ <strong>ECDH P-384</strong> — обмен ключами (E2E)<br>
            ✅ <strong>HKDF-SHA-256</strong> — деривация сессионных ключей<br>
            ✅ <strong>PBKDF2-SHA256</strong> 310K итераций — пароли групп<br>
            ✅ <strong>Forward Secrecy</strong> — ротация каждые 100 сообщений<br>
            ✅ <strong>Random padding</strong> — защита метаданных
          </div>
        </div>
        <div style="font-size:11px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:16px 4px 8px">Безопасность</div>
        <div style="background:var(--surface);border-radius:var(--radius);overflow:hidden;border:1px solid rgba(255,255,255,0.04)">
          ${privacyItem('🔑','Код-пароль','passcodeLock',p.passcodeLock,'toggle')}
          ${privacyItem('⏱','Автоудаление сообщений','autoDeleteMessages',p.autoDeleteMessages,'toggle')}
          ${privacyItem('☁️','Облачный пароль','cloudPassword',p.cloudPassword,'toggle')}
        </div>
        <div style="font-size:11px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:20px 4px 8px">Приватность</div>
        <div style="background:var(--surface);border-radius:var(--radius);overflow:hidden;border:1px solid rgba(255,255,255,0.04)">
          ${privacySelect('📞','Номер телефона','phoneVisibility',p.phoneVisibility||'nobody')}
          ${privacySelect('🕐','Время захода','lastSeenVisibility',p.lastSeenVisibility||'nobody')}
          ${privacySelect('🖼','Фото профиля','avatarVisibility',p.avatarVisibility||'all')}
          ${privacySelect('↩️','Пересылка сообщений','forwardVisibility',p.forwardVisibility||'nobody')}
          ${privacySelect('📞','Звонки','callsVisibility',p.callsVisibility||'nobody')}
        </div>
        <div style="height:20px"></div>
        <button id="priv-save" style="width:100%;padding:15px;background:var(--accent-g);color:white;border:none;border-radius:var(--radius-sm);font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(124,92,191,0.4)">💾 Сохранить</button>
        <div style="height:20px"></div>
      </div>`;
    document.body.appendChild(sheet);

    let startX = 0;
    sheet.addEventListener('touchstart', e=>{startX=e.touches[0].clientX;},{passive:true});
    sheet.addEventListener('touchend', e=>{const dx=e.changedTouches[0].clientX-startX;if(dx>80)sheet.remove();},{passive:true});
    sheet.querySelector('#priv-back').addEventListener('click', ()=>sheet.remove());
    sheet.querySelector('#priv-save').addEventListener('click', ()=>{
      const settings={};
      sheet.querySelectorAll('.priv-toggle').forEach(el=>{settings[el.dataset.key]=el.checked;});
      sheet.querySelectorAll('.priv-select').forEach(el=>{settings[el.dataset.key]=el.value;});
      socket.emit('privacy-update', settings, res=>{
        if(res.ok){showToast('✅ Настройки сохранены');sheet.remove();}
        else showToast('⚠️ Ошибка сохранения');
      });
    });
    setTimeout(()=>initPrivacyToggles(sheet),50);
  });
}

function privacyItem(icon, label, key, value, type) {
  if (type==='toggle') return `
    <div style="padding:14px 16px;border-bottom:1px solid var(--divider);display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px"><span style="font-size:20px">${icon}</span><div style="font-size:15px;font-weight:500">${label}</div></div>
      <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
        <input type="checkbox" class="priv-toggle" data-key="${key}" ${value?'checked':''} style="opacity:0;width:0;height:0;position:absolute">
        <span style="position:absolute;inset:0;border-radius:12px;background:var(--bg2);border:1px solid rgba(255,255,255,0.1);transition:0.3s" class="ptoggle-bg"></span>
        <span style="position:absolute;left:2px;top:2px;width:20px;height:20px;border-radius:50%;background:white;transition:0.3s;box-shadow:0 1px 4px rgba(0,0,0,0.4)" class="ptoggle-knob"></span>
      </label>
    </div>`;
  return '';
}
function privacySelect(icon, label, key, value) {
  return `
    <div style="padding:14px 16px;border-bottom:1px solid var(--divider);display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px"><span style="font-size:20px">${icon}</span><div style="font-size:15px;font-weight:500">${label}</div></div>
      <select class="priv-select" data-key="${key}" style="background:var(--bg2);border:1px solid rgba(255,255,255,0.07);border-radius:10px;color:var(--accent2);padding:6px 10px;font-size:14px;outline:none;cursor:pointer">
        <option value="all" ${value==='all'?'selected':''}>Все</option>
        <option value="contacts" ${value==='contacts'?'selected':''}>Контакты</option>
        <option value="nobody" ${value==='nobody'?'selected':''}>Никто</option>
      </select>
    </div>`;
}
document.addEventListener('change', e => {
  if (e.target.classList.contains('priv-toggle')) {
    const label=e.target.parentElement;
    const bg=label.querySelector('.ptoggle-bg');
    const knob=label.querySelector('.ptoggle-knob');
    if(e.target.checked){if(bg)bg.style.background='var(--accent)';if(knob)knob.style.transform='translateX(20px)';}
    else{if(bg)bg.style.background='var(--bg2)';if(knob)knob.style.transform='translateX(0)';}
  }
});
function initPrivacyToggles(container) {
  container.querySelectorAll('.priv-toggle').forEach(el=>{
    const label=el.parentElement;const bg=label.querySelector('.ptoggle-bg');const knob=label.querySelector('.ptoggle-knob');
    if(el.checked){if(bg)bg.style.background='var(--accent)';if(knob)knob.style.transform='translateX(20px)';}
  });
}

// ═══════════════════════════════════════════════
//  О ПРОЕКТЕ
// ═══════════════════════════════════════════════
function openAboutPage() {
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg);overflow-y:auto;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.32s cubic-bezier(0.4,0,0.2,1)';
  sheet.innerHTML = `
    <div style="position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--divider);display:flex;align-items:center;gap:12px;padding:max(env(safe-area-inset-top),14px) 16px 14px;z-index:1">
      <button id="about-back" style="background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%">←</button>
      <div style="font-size:18px;font-weight:800">ℹ️ О проекте</div>
    </div>
    <div style="padding:24px 20px;max-width:520px;width:100%;margin:0 auto">
      <div style="text-align:center;margin-bottom:32px">
        <div style="width:96px;height:96px;border-radius:28px;background:var(--accent-g);display:inline-flex;align-items:center;justify-content:center;font-size:48px;margin-bottom:18px;box-shadow:0 8px 32px rgba(124,92,191,0.4)">🔐</div>
        <div style="font-size:26px;font-weight:800;letter-spacing:-0.5px">Приватный чат</div>
        <div style="font-size:13px;color:var(--sub);margin-top:6px">Версия 3.0 · Максимальная защита</div>
      </div>
      <div style="background:var(--surface);border-radius:var(--radius);padding:20px;margin-bottom:16px;border:1px solid rgba(124,92,191,0.15)">
        <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:var(--accent2)">🔒 Многоуровневое шифрование</div>
        <div style="font-size:13px;color:var(--text2);line-height:1.8">
          🛡 <strong>AES-256-GCM</strong> — шифрование всех сообщений<br>
          🔑 <strong>ECDH P-384</strong> — обмен ключами (E2E)<br>
          🔄 <strong>HKDF-SHA-256</strong> — деривация сессионных ключей<br>
          🏰 <strong>PBKDF2-SHA256</strong> 310K итераций — пароли групп<br>
          ⏩ <strong>Forward Secrecy</strong> — ротация ключей каждые 100 сообщений<br>
          🎲 <strong>Random padding</strong> — защита метаданных<br>
          📡 <strong>Сервер не видит</strong> содержимое сообщений
        </div>
      </div>
      <div style="text-align:center;color:var(--sub);font-size:12px;padding-bottom:40px">Сделано с ❤️ для приватного общения</div>
    </div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.transform = 'translateX(0)'; }));
  const close = () => { sheet.style.transform='translateX(100%)'; sheet.addEventListener('transitionend',()=>sheet.remove(),{once:true}); };
  sheet.querySelector('#about-back').addEventListener('click', close);
  let startX = 0;
  sheet.addEventListener('touchstart', e=>{startX=e.touches[0].clientX;},{passive:true});
  sheet.addEventListener('touchmove', e=>{const dx=e.touches[0].clientX-startX;if(dx>0){sheet.style.transform=`translateX(${dx}px)`;sheet.style.opacity=String(1-dx/400);}},{passive:true});
  sheet.addEventListener('touchend', e=>{const dx=e.changedTouches[0].clientX-startX;sheet.style.opacity='';if(dx>80)close();else sheet.style.transform='translateX(0)';},{passive:true});
}

// ═══════════════════════════════════════════════
//  НАСТРОЙКИ
// ═══════════════════════════════════════════════
if (btnCloseSettings) btnCloseSettings.addEventListener('click', ()=>{ if(window._closeModal)window._closeModal(modalSettings);else modalSettings.classList.remove('open'); });
$('settings-go-profile')?.addEventListener('click', ()=>{ modalSettings.classList.remove('open'); openProfileModal(); });
$('settings-go-privacy')?.addEventListener('click', ()=>{ modalSettings.classList.remove('open'); openPrivacySettings(); });
$('settings-go-notifs')?.addEventListener('click',  ()=>{ requestNotifPermission(); showToast('🔔 Уведомления: '+(Notification.permission==='granted'?'включены':'требуется разрешение')); });
$('settings-go-data')?.addEventListener('click',    ()=>showToast('💾 Кэш очищен'));
$('settings-go-lang')?.addEventListener('click',    ()=>showToast('🌐 Язык: Русский'));
$('settings-go-chats')?.addEventListener('click',   ()=>showToast('💬 Раздел в разработке'));
$('settings-go-about')?.addEventListener('click',   ()=>{ modalSettings.classList.remove('open'); openAboutPage(); });

// ═══════════════════════════════════════════════
//  КОНТАКТЫ
// ═══════════════════════════════════════════════
function openContactsModal() { if(!modalContacts)return; modalContacts.classList.add('open'); loadContactsFriends(); }
if (btnCloseContacts) btnCloseContacts.addEventListener('click',()=>{ if(window._closeModal)window._closeModal(modalContacts);else if(modalContacts)modalContacts.classList.remove('open'); });
if (btnContactsSearch) btnContactsSearch.addEventListener('click',()=>searchUserForFriend(contactsSearchInput,contactsSearchResult));
if (contactsSearchInput) contactsSearchInput.addEventListener('keydown',e=>{ if(e.key==='Enter')searchUserForFriend(contactsSearchInput,contactsSearchResult); });
function loadContactsFriends() {
  socket.emit('friends-list', res=>{
    if(!res.ok)return;
    if(contactsFriendsList)renderFriendsList(res.friends,contactsFriendsList);
    if(contactsReqList)renderFriendRequests(res.requests,contactsReqList);
  });
}

// ═══════════════════════════════════════════════
//  ЛИЧНЫЕ ЧАТЫ
// ═══════════════════════════════════════════════
function openPrivateChatWith(nickname) {
  closeAllModals();
  socket.emit('private-chat-open',{withNickname:nickname},res=>{
    if(!res.ok){showToast('❌ Пользователь не найден');return;}
    enterPrivateChat(res.chatId,res.withNickname,res.withAvatar);
  });
}

let privateChatTypingTimer = null;
function startPrivateTyping() {
  if(!currentChatId||currentChatType!=='private')return;
  if(privateChatTypingTimer)clearTimeout(privateChatTypingTimer);
  socket.emit('private-typing-start',{chatId:currentChatId});
  privateChatTypingTimer=setTimeout(stopPrivateTyping,3000);
}
function stopPrivateTyping() {
  if(privateChatTypingTimer){clearTimeout(privateChatTypingTimer);privateChatTypingTimer=null;}
  if(currentChatId&&currentChatType==='private')socket.emit('private-typing-stop',{chatId:currentChatId});
}

socket.on('private-typing-start',({chatId,fromNick})=>{
  if(currentChatId!==chatId)return;
  const el=getHeaderSubEl();
  if(el)el.innerHTML=`<span class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span>${escapeHtml(fromNick)} печатает…</span>`;
  clearTimeout(window._privateTypingClearTimer);
  window._privateTypingClearTimer=setTimeout(()=>{ const s=getHeaderSubEl();if(s)s.innerHTML=`<span class="online">в сети</span>`; },4000);
});
socket.on('private-typing-stop',({chatId})=>{
  if(currentChatId!==chatId)return;
  const s=getHeaderSubEl();if(s)s.innerHTML=`<span class="online">в сети</span>`;
});

async function enterPrivateChat(chatId, withNickname, withAvatar) {
  if (currentRoomId) {
    socket.emit('leave-room');
    if (joined) { socket.emit('voice-leave'); hangUp(); joined = false; }
    currentRoomId=null; currentRoomData=null;
  }
  closeAllModals();
  currentChatType = 'private';
  currentChatId   = chatId;
  currentChatWith = withNickname;
  isRoomOwner     = false;
  memberCount     = 2;
  clearUnread(chatId);

  try { await Crypto.deriveKey('', chatId, chatId + '-private-v2'); } catch (e) { console.error(e); }

  if (chatRoomName)   chatRoomName.textContent = withNickname;
  if (userCount)      userCount.textContent    = '2';
  if (chatRoomAvatar) chatRoomAvatar.innerHTML = withAvatar ? `<img src="${escapeHtml(withAvatar)}" alt="">` : '👤';

  const subEl = getHeaderSubEl();
  if (subEl) subEl.innerHTML = `<span class="online">в сети</span>`;

  clearChat(); clearAllTyping();
  if (btnJoin)  btnJoin.style.display  = 'none';
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic)   btnMic.style.display   = 'none';

  socket.emit('private-chat-join', { chatId });
  showScreen('chat');
  updateNotifButton();
  updateHeaderButtons();
  await loadPrivateChatHistory(chatId);
}

function updateNotifButton() {
  const id  = currentChatType === 'private' ? currentChatId : currentRoomId;
  const btn = $('btn-notif-settings');
  if (btn && id) {
    const s = getNotifSetting(id);
    btn.textContent = s==='all'?'🔔':s==='mute'?'🔇':'🔕';
  }
}

// ═══════════════════════════════════════════════
//  СТАТУСЫ СООБЩЕНИЙ
// ═══════════════════════════════════════════════
function buildStatusTicks(status, mine) {
  if (!mine) return '';
  if (status==='sending')   return `<span class="msg-ticks sending" style="font-size:10px;color:rgba(255,255,255,0.4)">⏳</span>`;
  if (status==='sent')      return `<span class="msg-ticks sent" style="font-size:10px;color:rgba(255,255,255,0.4)">✓</span>`;
  if (status==='delivered') return `<span class="msg-ticks delivered" style="font-size:10px;color:rgba(255,255,255,0.5)">✓✓</span>`;
  if (status==='read')      return `<span class="msg-ticks read" style="font-size:10px;color:#7c5cbf">✓✓</span>`;
  return '';
}

function updateMsgStatus(msgId, status) {
  const domId = msgIdToDomId.get(msgId); if (!domId) return;
  const el    = document.getElementById(domId); if (!el) return;
  const ticks = el.querySelector('.msg-ticks');
  const colorMap = { sending:'rgba(255,255,255,0.4)', sent:'rgba(255,255,255,0.4)', delivered:'rgba(255,255,255,0.5)', read:'#7c5cbf' };
  const textMap  = { sending:'⏳', sent:'✓', delivered:'✓✓', read:'✓✓' };
  if (!ticks) {
    const meta = el.querySelector('.msg-meta');
    if (meta) { const span=document.createElement('span'); span.className='msg-ticks '+status; span.style.cssText=`font-size:10px;color:${colorMap[status]||''}`;span.textContent=textMap[status]||'';meta.appendChild(span); }
    return;
  }
  ticks.className = 'msg-ticks ' + status;
  ticks.style.color = colorMap[status] || '';
  ticks.textContent = textMap[status] || '';
}

socket.on('msg-delivered', ({ chatId, msgId }) => { if (currentChatId===chatId) updateMsgStatus(msgId,'delivered'); });
socket.on('msg-read',      ({ chatId, msgId }) => { if (currentChatId===chatId) updateMsgStatus(msgId,'read'); });
socket.on('chat-msg-id',   ({ seq, msgId })    => {
  const domId = seqToMsgId.get(seq);
  if (domId) { msgIdToDomId.set(msgId,domId); seqToMsgId.delete(seq); updateMsgStatus(msgId,'sent'); }
});

function markChatAsRead(chatId, messages) {
  if (!messages||!messages.length) return;
  const myLower = myNickname.toLowerCase();
  for (const msg of messages) {
    if (msg.from!==myLower && msg.id && (!msg.readBy||!msg.readBy.includes(myLower))) {
      socket.emit('private-msg-read',{chatId,msgId:msg.id});
    }
  }
}

async function loadPrivateChatHistory(chatId) {
  return new Promise(resolve => {
    socket.emit('private-chat-history',{chatId},async res=>{
      if(!res.ok||!res.messages||!res.messages.length){resolve();return;}
      const myLower = myNickname.toLowerCase();
      for (const msg of res.messages) {
        const mine = msg.from === myLower;
        if (msg.deletedFor && msg.deletedFor.includes(myLower)) continue;
        if (msg.type==='voice') {
          const domId=appendMessage({id:msg.id,nickname:msg.fromNick,type:'voice',duration:msg.duration||0,timestamp:msg.timestamp,mine,status:'ok',encrypted:msg.encrypted,iv:msg.iv,mimeType:msg.mimeType,msgStatus:mine?(msg.status||'sent'):null});
          if(msg.id&&mine)msgIdToDomId.set(msg.id,domId);
        } else if (msg.type==='text') {
          try {
            const text=await Crypto.decryptText(msg.encrypted,msg.iv);
            const domId=appendMessage({id:msg.id,nickname:msg.fromNick,text,type:'text',timestamp:msg.timestamp,mine,status:'ok',msgStatus:mine?(msg.status||'sent'):null,edited:msg.edited});
            if(msg.id&&mine)msgIdToDomId.set(msg.id,domId);
          } catch(_) { appendMessage({id:msg.id,nickname:msg.fromNick,text:'[зашифровано]',type:'text',timestamp:msg.timestamp,mine,status:'error'}); }
        } else {
          const domId=appendMessage({id:msg.id,nickname:msg.fromNick,type:msg.type,fileName:msg.fileName,fileSize:msg.fileSize,mimeType:msg.mimeType,timestamp:msg.timestamp,mine,status:'ok',msgStatus:mine?(msg.status||'sent'):null});
          if(msg.id&&mine)msgIdToDomId.set(msg.id,domId);
        }
      }
      markChatAsRead(chatId, res.messages);
      resolve();
    });
  });
}

function loadPrivateChatsList(container) {
  const el = container || privateList;
  socket.emit('private-chat-list', res => {
    cachedPrivateList = res.ok ? res.chats : [];
    if (el) {
      if (!res.ok||!res.chats.length) {
        el.innerHTML=`<div class="rooms-empty"><div class="rooms-empty-icon">💬</div><div>Нет личных чатов.<br>Нажми + чтобы начать!</div></div>`;
      } else {
        el.innerHTML = res.chats.map(buildPrivateCardHTML).join('');
        bindPrivateCardEvents(el);
      }
    }
    if(unifiedList&&unifiedList.style.display!=='none')renderUnifiedList();
    if(chatUnifiedList&&chatUnifiedList.style.display!=='none')renderUnifiedListInChat();
  });
}

// ═══════════════════════════════════════════════
//  ВХОДЯЩИЕ СООБЩЕНИЯ
// ═══════════════════════════════════════════════
socket.on('private-message', async data => {
  const isCurrentChat = currentChatType==='private' && currentChatId===data.chatId;
  if (!isCurrentChat) {
    const setting = getNotifSetting(data.chatId);
    if (setting!=='none') {
      showToast('💬 '+(data.fromNick||'?')+': новое сообщение',4000,()=>enterPrivateChat(data.chatId,data.fromNick,data.fromAvatar));
      if(setting!=='mute')playMsgSound(data.chatId);
    }
    addUnread(data.chatId,1);
    showBrowserNotif('💬 '+(data.fromNick||'?'),'новое сообщение',data.chatId);
    loadPrivateChatsList(); return;
  }
  if(getNotifSetting(data.chatId)!=='none')playMsgSound(data.chatId);
  if(data.id)socket.emit('private-msg-read',{chatId:data.chatId,msgId:data.id});
  if (data.type==='voice') {
    appendMessage({id:data.id,nickname:data.fromNick,type:'voice',duration:data.duration||0,timestamp:data.timestamp,mine:false,status:'ok',encrypted:data.encrypted,iv:data.iv,mimeType:data.mimeType});
    return;
  }
  const domId = appendMessage({id:data.id,nickname:data.fromNick,type:data.type,fileName:data.fileName,fileSize:data.fileSize,mimeType:data.mimeType,timestamp:data.timestamp,mine:false,status:'decrypting'});
  try {
    if (data.type==='text') {
      const text=await Crypto.decryptText(data.encrypted,data.iv);
      updateMessage(domId,{text,status:'ok'});
      showBrowserNotif('💬 '+(data.fromNick||'?'),text,data.chatId);
    } else {
      const mime=data.mimeType||'application/octet-stream';
      const blob=await Crypto.decryptBlob(data.encrypted,data.iv,mime);
      updateMessage(domId,{localUrl:URL.createObjectURL(blob),status:'ok'});
    }
  } catch(e) { updateMessage(domId,{status:'error'}); }
  loadPrivateChatsList();
});

socket.on('private-msg-deleted', ({chatId,msgId,deleteFor})=>{
  if(currentChatId!==chatId&&deleteFor!=='me')return;
  for(const[mId,domId]of msgIdToDomId){
    if(mId===msgId){
      const el=document.getElementById(domId);
      if(el){
        if(deleteFor==='all'){el.innerHTML=`<div style="font-size:12px;color:var(--sub);font-style:italic;padding:4px 8px">🗑 Сообщение удалено</div>`;el.style.background='transparent';el.style.border='none';}
        else el.remove();
      }
      msgIdToDomId.delete(mId);break;
    }
  }
});

socket.on('private-msg-edited', async ({chatId,msgId,newEncrypted,newIv})=>{
  if(currentChatId!==chatId)return;
  const domId=msgIdToDomId.get(msgId);if(!domId)return;
  try {
    const text=await Crypto.decryptText(newEncrypted,newIv);
    const el=document.getElementById(domId);
    if(el){const c=el.querySelector('.msg-content');if(c)c.innerHTML=escapeHtml(text)+' <span style="font-size:10px;opacity:0.5">(ред.)</span>';}
  } catch(_){}
});

socket.on('room-msg-deleted',({roomId,msgId,deleteFor})=>{
  if(currentRoomId!==roomId)return;
  for(const[mId,domId]of msgIdToDomId){
    if(mId===msgId){
      const el=document.getElementById(domId);
      if(el){
        if(deleteFor==='all'){el.innerHTML=`<div style="font-size:12px;color:var(--sub);font-style:italic;padding:4px 8px">🗑 Сообщение удалено</div>`;el.style.background='transparent';el.style.border='none';}
        else el.remove();
      }
      msgIdToDomId.delete(mId);break;
    }
  }
});

socket.on('room-msg-edited', async ({roomId,msgId,newEncrypted,newIv})=>{
  if(currentRoomId!==roomId)return;
  const domId=msgIdToDomId.get(msgId);if(!domId)return;
  try {
    const text=await Crypto.decryptText(newEncrypted,newIv);
    const el=document.getElementById(domId);
    if(el){const c=el.querySelector('.msg-content');if(c)c.innerHTML=escapeHtml(text)+' <span style="font-size:10px;opacity:0.5">(ред.)</span>';}
  } catch(_){}
});

// ═══════════════════════════════════════════════
//  КОНТЕКСТНОЕ МЕНЮ СООБЩЕНИЯ
// ═══════════════════════════════════════════════
let longPressTimer  = null;
let longPressTarget = null;

function openMsgContextMenu(domId, msgEl) {
  if (!domId||!msgEl) return;
  const isMine    = msgEl.classList.contains('mine');
  const msgType   = msgEl.dataset.type || 'text';
  const isText    = msgType === 'text';
  const msgIdAttr = msgEl.dataset.msgId || '';
  document.querySelector('.msg-context-menu')?.remove();

  const items = [];
  if (isMine && isText) items.push({icon:'✏️',label:'Изменить',action:'edit'});
  if (isMine)           items.push({icon:'🗑',label:'Удалить у всех',action:'delete-all',danger:true});
  items.push({icon:'🗑',label:'Удалить у себя',action:'delete-me',danger:true});
  if (isText)           items.push({icon:'📋',label:'Копировать',action:'copy'});

  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';
  menu.innerHTML = `
    <div class="msg-ctx-backdrop" style="position:fixed;inset:0;z-index:2999"></div>
    <div class="msg-ctx-sheet" style="position:fixed;bottom:0;left:0;right:0;max-width:520px;margin:0 auto;background:var(--surface);border-radius:28px 28px 0 0;padding:12px 12px 40px;z-index:3000;border-top:1px solid rgba(124,92,191,0.2);transform:translateY(100%);transition:transform 0.25s cubic-bezier(0.34,1.1,0.64,1)">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:8px auto 16px"></div>
      ${items.map(item=>`<button class="msg-ctx-item" data-action="${item.action}" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:none;background:none;color:${item.danger?'var(--red)':'var(--text)'};font-size:15px;cursor:pointer;width:100%;text-align:left">
        <span style="font-size:20px">${item.icon}</span><span>${item.label}</span>
      </button>`).join('')}
      <button class="msg-ctx-cancel" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:none;background:rgba(255,255,255,0.05);color:var(--sub);font-size:15px;cursor:pointer;width:100%;text-align:left;margin-top:8px">
        <span style="font-size:20px">✕</span><span>Отмена</span>
      </button>
    </div>`;
  document.body.appendChild(menu);

  requestAnimationFrame(()=>requestAnimationFrame(()=>{ const s=menu.querySelector('.msg-ctx-sheet');if(s)s.style.transform='translateY(0)'; }));

  const close = () => {
    const s=menu.querySelector('.msg-ctx-sheet');
    if(s){s.style.transform='translateY(100%)';s.addEventListener('transitionend',()=>menu.remove(),{once:true});}
    else menu.remove();
  };

  menu.querySelector('.msg-ctx-backdrop').addEventListener('click', close);
  menu.querySelector('.msg-ctx-cancel').addEventListener('click', close);

  menu.querySelectorAll('.msg-ctx-item[data-action]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const action = btn.dataset.action; close();
      if (action==='copy') {
        const c=msgEl.querySelector('.msg-content');
        if(c)navigator.clipboard?.writeText(c.innerText||c.textContent||'').then(()=>showToast('📋 Скопировано')).catch(()=>showToast('❌ Ошибка'));
        return;
      }
      if (action==='edit') { openMsgEditDialog(domId,msgEl,msgIdAttr); return; }
      const deleteFor = action==='delete-all'?'all':'me';
      if (currentChatType==='private'&&currentChatId) {
        socket.emit('private-msg-delete',{chatId:currentChatId,msgId:msgIdAttr,deleteFor},res=>{if(!res.ok)showToast('❌ Ошибка удаления');});
      } else if (currentRoomId) {
        socket.emit('room-msg-delete',{roomId:currentRoomId,msgId:msgIdAttr,deleteFor},res=>{if(!res.ok)showToast('❌ Ошибка удаления');});
      }
    });
  });
}

function openMsgEditDialog(domId, msgEl, msgId) {
  const content   = msgEl.querySelector('.msg-content');
  const currentText = content ? (content.innerText||content.textContent||'').trim() : '';
  const dlg = document.createElement('div');
  dlg.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  dlg.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2)">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:16px">✏️ Изменить</div>
      <textarea id="edit-msg-input" style="width:100%;padding:13px 16px;background:var(--bg2);border:1.5px solid rgba(255,255,255,0.07);border-radius:14px;color:var(--text);font-size:16px;outline:none;font-family:inherit;resize:none;min-height:80px;max-height:200px;"></textarea>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button id="edit-cancel" style="flex:1;padding:13px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
        <button id="edit-save"   style="flex:1;padding:13px;border:none;border-radius:14px;background:var(--accent-g);color:white;font-size:15px;font-weight:700;cursor:pointer">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const input=dlg.querySelector('#edit-msg-input'); input.value=currentText;
  const close=()=>dlg.remove();
  dlg.querySelector('#edit-cancel').addEventListener('click',close);
  dlg.querySelector('#edit-save').addEventListener('click', async()=>{
    const newText=input.value.trim(); if(!newText)return;
    try {
      const{encrypted,iv}=await Crypto.encrypt(newText);
      if(currentChatType==='private'&&currentChatId){
        socket.emit('private-msg-edit',{chatId:currentChatId,msgId,newEncrypted:encrypted,newIv:iv},res=>{
          if(res.ok){if(content)content.innerHTML=escapeHtml(newText)+' <span style="font-size:10px;opacity:0.5">(ред.)</span>';close();}
          else showToast('❌ Ошибка редактирования');
        });
      } else if(currentRoomId){
        socket.emit('room-msg-edit',{roomId:currentRoomId,msgId,newEncrypted:encrypted,newIv:iv},res=>{
          if(res.ok){if(content)content.innerHTML=escapeHtml(newText)+' <span style="font-size:10px;opacity:0.5">(ред.)</span>';close();}
          else showToast('❌ Ошибка редактирования');
        });
      }
    } catch(e){showToast('❌ Ошибка шифрования');}
  });
  dlg.addEventListener('click',e=>{if(e.target===dlg)close();});
  setTimeout(()=>input.focus(),200);
}

if (chatMessages) {
  chatMessages.addEventListener('touchstart', e=>{
    const msgEl=e.target.closest('.msg');if(!msgEl)return;
    longPressTarget=msgEl;
    longPressTimer=setTimeout(()=>{
      if(longPressTarget===msgEl){if(navigator.vibrate)navigator.vibrate(50);openMsgContextMenu(msgEl.id,msgEl);}
    },500);
  },{passive:true});
  chatMessages.addEventListener('touchend',  ()=>{clearTimeout(longPressTimer);longPressTarget=null;},{passive:true});
  chatMessages.addEventListener('touchmove', ()=>{clearTimeout(longPressTimer);longPressTarget=null;},{passive:true});
  chatMessages.addEventListener('contextmenu',e=>{
    const msgEl=e.target.closest('.msg');if(!msgEl)return;
    e.preventDefault();openMsgContextMenu(msgEl.id,msgEl);
  });
}

// ═══════════════════════════════════════════════
//  ПРОГРЕСС ЗАГРУЗКИ
// ═══════════════════════════════════════════════
function showUploadProgress(fileName) {
  hideUploadProgress();
  const el=document.createElement('div'); el.id='upload-progress-wrap';
  el.style.cssText='padding:8px 12px 0;';
  el.innerHTML=`
    <div style="font-size:12px;color:var(--sub);margin-bottom:4px">📤 ${escapeHtml(fileName||'файл')}…</div>
    <div style="height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden">
      <div id="upload-progress-fill" style="height:100%;width:0%;background:var(--accent-g);border-radius:2px;transition:width 0.2s"></div>
    </div>
    <div id="upload-progress-pct" style="font-size:11px;color:var(--accent2);margin-top:2px;text-align:right">0%</div>`;
  const tb=$('tg-bottom');if(tb)tb.insertBefore(el,tb.firstChild);
  return el;
}
function updateUploadProgress(pct) {
  const fill=$('upload-progress-fill');const text=$('upload-progress-pct');
  if(fill)fill.style.width=pct+'%';if(text)text.textContent=Math.round(pct)+'%';
}
function hideUploadProgress() { const el=$('upload-progress-wrap');if(el)el.remove(); }

function showChatUploadStatus(type) {
  const el=getHeaderSubEl();if(!el)return;
  const labels={image:'📷 отправляет фото…',video:'🎬 отправляет видео…',file:'📎 отправляет файл…',voice:'🎤 записывает…'};
  el.innerHTML=`<span class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span>${labels[type]||'отправляет…'}</span>`;
}
function hideChatUploadStatus() {
  const el=getHeaderSubEl();if(!el)return;
  if(currentChatType==='private') el.innerHTML=`<span class="online">в сети</span>`;
  else el.innerHTML=`<span class="online"><span id="user-count">${memberCount}</span> участников</span>`;
}

// ═══════════════════════════════════════════════
//  СПИСОК КОМНАТ
// ═══════════════════════════════════════════════
socket.on('room-list', list=>{
  cachedRoomList=list||[];
  renderRoomList(cachedRoomList,roomsList);
  renderRoomListInChat(cachedRoomList);
  if(lobbyTabAll&&lobbyTabAll.classList.contains('active'))renderUnifiedList();
  if(chatTabAll&&chatTabAll.classList.contains('active'))renderUnifiedListInChat();
});

const roomDeleteTimersMap={};
function clearAllDeleteTimers(){for(const id in roomDeleteTimersMap){clearInterval(roomDeleteTimersMap[id]);delete roomDeleteTimersMap[id];}}

function renderRoomList(list,container){
  if(!container)return;
  clearAllDeleteTimers();
  if(!list||!list.length){container.innerHTML=`<div class="rooms-empty"><div class="rooms-empty-icon">🏠</div><div>Групп пока нет.<br>Создай первую!</div></div>`;return;}
  container.innerHTML=list.map(r=>buildRoomCardHTML(r)).join('');
  list.forEach(room=>{
    if(room.memberCount===0&&room.deleteAt){
      const el=document.getElementById('timer-'+room.id);if(!el)return;
      const tick=()=>{const left=room.deleteAt-Date.now();if(left<=0){el.textContent='🕐 00:00';clearInterval(roomDeleteTimersMap[room.id]);return;}el.textContent='🕐 '+formatCountdown(left);};
      tick();roomDeleteTimersMap[room.id]=setInterval(tick,1000);
    }
  });
  bindRoomCardEvents(container);
}
function renderRoomListInChat(list){
  if(!chatRoomsList)return;
  if(!list||!list.length){chatRoomsList.innerHTML=`<div class="rooms-empty" style="padding:30px 10px"><div class="rooms-empty-icon" style="font-size:36px">🏠</div><div style="font-size:13px">Групп нет</div></div>`;return;}
  chatRoomsList.innerHTML=list.map(r=>buildRoomCardSmallHTML(r)).join('');
  bindRoomCardEvents(chatRoomsList);
}

socket.on('room-renamed',({roomId,newName})=>{ if(currentRoomId===roomId){if(chatRoomName)chatRoomName.textContent=newName;appendSystemMsg('✏️ Переименовано: '+newName);} });
socket.on('room-deleted',({roomId,roomName})=>{ if(currentRoomId===roomId){showToast('🗑 Группа «'+roomName+'» удалена',5000);leaveCurrentRoom();showScreen('lobby');} });
socket.on('room-settings-changed',({roomId})=>{ if(currentRoomId===roomId)appendSystemMsg('⚙️ Настройки обновлены'); });
socket.on('room-photo-updated',({roomId,photo})=>{
  if(currentRoomId===roomId){if(chatRoomAvatar)chatRoomAvatar.innerHTML=photo?`<img src="${escapeHtml(photo)}" alt="">`:'💬';appendSystemMsg('🖼 Фото группы обновлено');}
});

// ═══════════════════════════════════════════════
//  СОЗДАНИЕ КОМНАТЫ
// ═══════════════════════════════════════════════
if (btnCloseCreate) btnCloseCreate.addEventListener('click',()=>{ if(window._closeModal)window._closeModal(modalCreate);else modalCreate.classList.remove('open'); });

function openCreateRoomModal(){
  if(!modalCreate)return;
  if(createRoomName) createRoomName.value='';
  if(createRoomPw)   createRoomPw.value='';
  if(createRoomError)createRoomError.textContent='';
  roomPhotoData=null;
  if(createAutoDelete)createAutoDelete.value='never';
  if(createJoinMode)  createJoinMode.value='open';
  if(roomPhotoBtn)    roomPhotoBtn.innerHTML='<span class="cam-icon">📷</span><span>Фото</span>';
  modalCreate.classList.add('open');
  setTimeout(()=>{ if(createRoomName)createRoomName.focus(); },200);
}

if (roomPhotoBtn)   roomPhotoBtn.addEventListener('click',()=>{ if(roomPhotoInput)roomPhotoInput.click(); });
if (roomPhotoInput) roomPhotoInput.addEventListener('change',()=>{
  const file=roomPhotoInput.files[0];if(!file)return;roomPhotoInput.value='';
  if(file.size>5*1024*1024){alert('Фото слишком большое');return;}
  const r=new FileReader();r.onload=e=>{roomPhotoData=e.target.result;if(roomPhotoBtn)roomPhotoBtn.innerHTML=`<img src="${roomPhotoData}" alt="">`;};r.readAsDataURL(file);
});
if (btnToggleCreatePw) btnToggleCreatePw.addEventListener('click',()=>{
  if(!createRoomPw)return;const t=createRoomPw.type==='text';createRoomPw.type=t?'password':'text';btnToggleCreatePw.textContent=t?'👁':'🙈';
});
if (btnSubmitCreate) btnSubmitCreate.addEventListener('click',submitCreateRoom);
if (createRoomName)  createRoomName.addEventListener('keydown',e=>{if(e.key==='Enter')submitCreateRoom();});

function submitCreateRoom(){
  if(!createRoomName)return;
  const name=createRoomName.value.trim();
  if(!name){if(createRoomError)createRoomError.textContent='Введи название';return;}
  if(btnSubmitCreate){btnSubmitCreate.disabled=true;btnSubmitCreate.textContent='⏳';}
  socket.emit('create-room',{name,password:createRoomPw?createRoomPw.value:'',photo:roomPhotoData||null,autoDelete:createAutoDelete?createAutoDelete.value:'never',joinMode:createJoinMode?createJoinMode.value:'open'},res=>{
    if(btnSubmitCreate){btnSubmitCreate.disabled=false;btnSubmitCreate.textContent='Создать группу';}
    if(res?.ok){if(modalCreate)modalCreate.classList.remove('open');joinRoom(res.roomId,createRoomPw?createRoomPw.value:'');}
    else{if(createRoomError)createRoomError.textContent='Ошибка. Попробуй снова.';}
  });
}

// ═══════════════════════════════════════════════
//  ПАРОЛЬ КОМНАТЫ
// ═══════════════════════════════════════════════
let pendingJoinRoomMode = 'open';
function openRoomPasswordModal(roomId,roomName,joinMode){
  if(!modalRoomPw)return;
  pendingJoinRoom=roomId?{roomId,roomName}:pendingJoinRoom;
  pendingJoinRoomMode=joinMode||'open';
  if(pwModalRoomName)pwModalRoomName.textContent=roomName;
  if(roomPwInput) roomPwInput.value='';
  if(roomPwError) roomPwError.textContent='';
  modalRoomPw.classList.add('open');
  setTimeout(()=>{ if(roomPwInput)roomPwInput.focus(); },200);
}
if (btnClosePwModal) btnClosePwModal.addEventListener('click',()=>{ if(window._closeModal)window._closeModal(modalRoomPw);else modalRoomPw.classList.remove('open');pendingJoinRoom=null; });
if (btnToggleRoomPw) btnToggleRoomPw.addEventListener('click',()=>{
  if(!roomPwInput)return;const t=roomPwInput.type==='text';roomPwInput.type=t?'password':'text';btnToggleRoomPw.textContent=t?'👁':'🙈';
});
if (btnSubmitRoomPw) btnSubmitRoomPw.addEventListener('click',submitRoomPassword);
if (roomPwInput)     roomPwInput.addEventListener('keydown',e=>{if(e.key==='Enter')submitRoomPassword();});

function submitRoomPassword(){
  if(!pendingJoinRoom||!roomPwInput)return;
  const pw=roomPwInput.value;
  if(!pw){if(roomPwError)roomPwError.textContent='Введи пароль';return;}
  if(btnSubmitRoomPw){btnSubmitRoomPw.disabled=true;btnSubmitRoomPw.textContent='⏳';}
  if(pendingJoinRoomMode==='approval'){
    if(modalRoomPw)modalRoomPw.classList.remove('open');
    if(btnSubmitRoomPw){btnSubmitRoomPw.disabled=false;btnSubmitRoomPw.textContent='Войти в группу';}
    handleApprovalJoin(pendingJoinRoom.roomId,pendingJoinRoom.roomName,pw);
    pendingJoinRoom=null;return;
  }
  joinRoom(pendingJoinRoom.roomId,pw,(ok,err,secsLeft)=>{
    if(btnSubmitRoomPw){btnSubmitRoomPw.disabled=false;btnSubmitRoomPw.textContent='Войти в группу';}
    if(ok){if(modalRoomPw)modalRoomPw.classList.remove('open');pendingJoinRoom=null;}
    else if(err==='rate_limited'){if(roomPwError)roomPwError.textContent=`⛔ Подождите ${secsLeft} сек.`;}
    else if(err==='wrong_password'){
      if(roomPwError)roomPwError.textContent='❌ Неверный пароль';
      if(roomPwInput){roomPwInput.style.animation='shake 0.35s';setTimeout(()=>{roomPwInput.style.animation='';},400);}
    } else{if(roomPwError)roomPwError.textContent='⚠️ Ошибка';}
  });
}

// ═══════════════════════════════════════════════
//  ЗАЯВКИ
// ═══════════════════════════════════════════════
function handleApprovalJoin(roomId,roomName,_pw){
  if(!confirm(`📋 Для вступления в «${roomName}» требуется одобрение.\nОтправить заявку?`))return;
  socket.emit('room-request-join',{roomId},res=>{
    if(res.ok){if(res.autoAccepted)joinRoom(roomId,_pw||'');else showToast('📨 Заявка отправлена!',5000);}
    else if(res.error==='already_requested')showToast('⏳ Заявка уже отправлена');
    else if(res.error==='already_member')joinRoom(roomId,_pw||'');
    else showToast('⚠️ Ошибка: '+res.error);
  });
}
socket.on('room-request-accepted',({roomId,roomName})=>{ showToast(`✅ Заявка в «${roomName}» одобрена!`,6000,()=>joinRoom(roomId,'')); });
socket.on('room-request-declined',({roomId,roomName})=>{ showToast(`❌ Заявка в «${roomName}» отклонена`,5000); });
socket.on('room-join-request',({roomId,nickname})=>{
  showToast(`📋 ${nickname} хочет вступить`,8000,()=>{ if(currentRoomId===roomId)openMembersModal(); });
  if(modalMembers?.classList.contains('open')&&currentRoomId===roomId)loadJoinRequests(roomId);
});

function loadJoinRequests(roomId){
  socket.emit('room-members',{roomId},res=>{ if(res.ok)renderJoinRequests(res.pendingRequests||[],roomId); });
}
function renderJoinRequests(requests,roomId){
  const count=requests.length;
  if(joinRequestsCount)joinRequestsCount.textContent=count?`(${count})`:'';
  if(!joinRequestsList)return;
  if(!count){joinRequestsList.innerHTML='<div class="empty-list">Нет заявок</div>';return;}
  joinRequestsList.innerHTML=requests.map(r=>`
    <div class="request-item">
      <div class="friend-avatar">${avatarHtml(r.avatar,'👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(r.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm green" data-action="accept"  data-nick="${r.nickLower}">✓ Принять</button>
        <button class="btn-sm red"   data-action="decline" data-nick="${r.nickLower}">✕</button>
      </div>
    </div>`).join('');
  joinRequestsList.querySelectorAll('[data-action]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const accept=btn.dataset.action==='accept';
      socket.emit('room-request-respond',{roomId,nickLower:btn.dataset.nick,accept},res=>{
        if(res.ok){showToast(accept?'✅ Принята':'Отклонено');loadJoinRequests(roomId);}
      });
    });
  });
}

// ═══════════════════════════════════════════════
//  ВХОД В КОМНАТУ
// ═══════════════════════════════════════════════
function joinRoom(roomId, password, cb) {
  socket.emit('join-room',{roomId,password},async res=>{
    if(res?.ok){
      currentRoomId=roomId;currentRoomData=res.room;currentPassword=password||'';
      currentChatType='group';currentChatId=null;currentChatWith=null;
      isRoomOwner=res.room.isOwner||false;
      clearUnread(roomId);
      const roomSalt=res.room.roomSalt||(roomId+'-default-salt');
      await Crypto.deriveKey(password,roomId,roomSalt);
      await Crypto.generateEcdhKeyPair();
      outgoingSeq=0;
      if(chatRoomName)   chatRoomName.textContent=res.room.name;
      if(userCount)      userCount.textContent=res.room.members.length+1;
      memberCount=res.room.members.length+1;
      if(chatRoomAvatar) chatRoomAvatar.innerHTML=res.room.photo?`<img src="${escapeHtml(res.room.photo)}" alt="">`:'💬';
      if(btnJoin)  btnJoin.style.display='block';
      if(btnLeave) btnLeave.style.display='none';
      if(btnMic)   btnMic.style.display='none';
      clearChat();clearAllTyping();
      showScreen('chat');updateNotifButton();updateHeaderButtons();showOwnFingerprint();
      socket.emit('room-history',{roomId},async histRes=>{
        if(histRes.ok&&histRes.messages&&histRes.messages.length){
          for(const msg of histRes.messages){
            const mine=msg.nickname&&msg.nickname.toLowerCase()===myNickname.toLowerCase();
            const myLower=myNickname.toLowerCase();
            if(msg.deletedFor&&msg.deletedFor.includes(myLower))continue;
            if(msg.type==='voice'){
              const domId=appendMessage({id:msg.id,nickname:msg.nickname,type:'voice',duration:msg.duration||0,timestamp:msg.timestamp,mine,status:'ok',encrypted:msg.encrypted,iv:msg.iv,mimeType:msg.mimeType});
              if(msg.id&&mine)msgIdToDomId.set(msg.id,domId);
            } else if(msg.type==='text'){
              try {
                const text=await Crypto.decryptText(msg.encrypted,msg.iv);
                const domId=appendMessage({id:msg.id,nickname:msg.nickname,text,type:'text',timestamp:msg.timestamp,mine,status:'ok',edited:msg.edited});
                if(msg.id&&mine)msgIdToDomId.set(msg.id,domId);
              } catch(_){appendMessage({id:msg.id,nickname:msg.nickname,text:'[зашифровано]',type:'text',timestamp:msg.timestamp,mine,status:'error'});}
            } else {
              const domId=appendMessage({id:msg.id,nickname:msg.nickname,type:msg.type,fileName:msg.fileName,fileSize:msg.fileSize,mimeType:msg.mimeType,timestamp:msg.timestamp,mine,status:'ok'});
              if(msg.id&&mine)msgIdToDomId.set(msg.id,domId);
            }
          }
        }
      });
      if(cb)cb(true);
      if(isRoomOwner&&res.room.pendingRequests?.length)showToast(`📋 ${res.room.pendingRequests.length} заявок`,5000);
    } else {
      if(res?.error==='approval_required'){handleApprovalJoin(roomId,'группу');if(cb)cb(false,'approval_required');return;}
      if(cb)cb(false,res?.error,res?.secsLeft);
      else if(res?.error==='rate_limited')alert(`⛔ Подождите ${res.secsLeft} сек.`);
      else if(res?.error==='wrong_password')alert('Неверный пароль');
      else alert('Не удалось войти');
    }
  });
}

async function showOwnFingerprint(){
  try{
    const fp=await Crypto.getKeyFingerprint();
    const div=document.createElement('div');div.className='date-divider';
    div.style.cssText='font-size:10px;color:#5288c1;cursor:pointer;user-select:all;';
    div.textContent='🔑 Твой ключ: '+fp;
    if(chatMessages)chatMessages.appendChild(div);scrollToBottom();
  }catch(_){}
}

function clearChat(){
  if(!chatMessages)return;
  const all=[...chatMessages.children];
  all.forEach((el,i)=>{if(i>1)el.remove();});
  msgCounter=0;msgIdToDomId.clear();seqToMsgId.clear();
}

// ═══════════════════════════════════════════════
//  УЧАСТНИКИ
// ═══════════════════════════════════════════════
if (btnCloseMembers) btnCloseMembers.addEventListener('click',()=>{ if(window._closeModal)window._closeModal(modalMembers);else if(modalMembers)modalMembers.classList.remove('open'); });

function openMembersModal(){
  if(!currentRoomId||!modalMembers)return;
  if(renameSection)       renameSection.style.display       =isRoomOwner?'':'none';
  if(groupSettingsSection)groupSettingsSection.style.display=isRoomOwner?'':'none';
  if(joinRequestsSection) joinRequestsSection.style.display =isRoomOwner?'':'none';
  const gps=$('group-photo-section');if(gps)gps.style.display=isRoomOwner?'':'none';
  if(isRoomOwner&&currentRoomData){
    if(renameInput)        renameInput.value        =currentRoomData.name||'';
    if(groupAutodelSelect) groupAutodelSelect.value =currentRoomData.autoDelete?String(currentRoomData.autoDelete):'never';
    if(groupJoinmodeSelect)groupJoinmodeSelect.value=currentRoomData.joinMode||'open';
    const ns=$('group-notif-select');if(ns)ns.value=getNotifSetting(currentRoomId);
  }
  if(membersListContainer)membersListContainer.innerHTML='<div class="empty-list">Загрузка…</div>';
  modalMembers.classList.add('open');
  socket.emit('room-members',{roomId:currentRoomId},res=>{
    if(!membersListContainer)return;
    if(!res.ok){membersListContainer.innerHTML='<div class="empty-list">Ошибка</div>';return;}
    if(!res.members.length){membersListContainer.innerHTML='<div class="empty-list">Пусто</div>';return;}
    membersListContainer.innerHTML=res.members.map(m=>`
      <div class="member-item">
        <div class="member-avatar">${avatarHtml(m.avatar,'👤')}</div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.nickname)}${m.id===socket.id?' (Вы)':''}</div>
          ${m.isOwner?'<div class="member-badge">👑 Создатель</div>':''}
        </div>
      </div>`).join('');
    if(isRoomOwner)renderJoinRequests(res.pendingRequests||[],currentRoomId);
  });
}

if (btnRenameRoom) btnRenameRoom.addEventListener('click',()=>{
  if(!renameInput)return;const name=renameInput.value.trim();
  if(!name){if(renameError)renameError.textContent='Введи название';return;}
  if(renameError)renameError.textContent='';
  socket.emit('room-rename',{roomId:currentRoomId,newName:name},res=>{
    if(res.ok){showToast('✅ Переименовано');if(currentRoomData)currentRoomData.name=name;}
    else if(renameError)renameError.textContent=res.error==='not_owner'?'❌ Нет прав':'⚠️ Ошибка';
  });
});
if (renameInput) renameInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&btnRenameRoom)btnRenameRoom.click();});

const groupPhotoChangeBtn   = $('btn-group-photo-change');
const groupPhotoChangeInput = $('group-photo-input');
if (groupPhotoChangeBtn) {
  groupPhotoChangeBtn.addEventListener('click',()=>{ if(groupPhotoChangeInput)groupPhotoChangeInput.click(); });
}
if (groupPhotoChangeInput) {
  groupPhotoChangeInput.addEventListener('change',()=>{
    const file=groupPhotoChangeInput.files[0];if(!file)return;groupPhotoChangeInput.value='';
    if(file.size>5*1024*1024){showToast('⚠️ Фото слишком большое');return;}
    const r=new FileReader();r.onload=e=>{
      socket.emit('room-set-photo',{roomId:currentRoomId,photo:e.target.result},res=>{
        if(res.ok){showToast('✅ Фото обновлено');if(chatRoomAvatar)chatRoomAvatar.innerHTML=`<img src="${e.target.result}" alt="">`;if(currentRoomData)currentRoomData.photo=e.target.result;}
        else showToast('❌ Ошибка: '+(res.error||''));
      });
    };r.readAsDataURL(file);
  });
}

if (btnSaveGroupSettings) btnSaveGroupSettings.addEventListener('click',()=>{
  socket.emit('room-settings-update',{roomId:currentRoomId,autoDelete:groupAutodelSelect?groupAutodelSelect.value:'never',joinMode:groupJoinmodeSelect?groupJoinmodeSelect.value:'open'},res=>{
    if(res.ok){
      const ns=$('group-notif-select');if(ns&&currentRoomId)setNotifSetting(currentRoomId,ns.value);
      showToast('✅ Настройки сохранены');
      if(currentRoomData){currentRoomData.autoDelete=groupAutodelSelect?.value==='never'?null:parseInt(groupAutodelSelect?.value);currentRoomData.joinMode=groupJoinmodeSelect?.value||'open';}
    } else showToast('⚠️ Ошибка сохранения');
  });
});

if (btnDeleteGroup) btnDeleteGroup.addEventListener('click',()=>{
  if(!confirm('🗑 Удалить группу?'))return;
  socket.emit('room-delete',{roomId:currentRoomId},res=>{
    if(res.ok){if(modalMembers)modalMembers.classList.remove('open');leaveCurrentRoom();showScreen('lobby');showToast('🗑 Группа удалена');}
    else showToast('⚠️ Ошибка: '+(res.error||''));
  });
});

// ═══════════════════════════════════════════════
//  ПРИГЛАШЕНИЯ
// ═══════════════════════════════════════════════
if (btnCloseInvite) btnCloseInvite.addEventListener('click',()=>{ if(window._closeModal)window._closeModal(modalInvite);else if(modalInvite)modalInvite.classList.remove('open'); });

function openInviteModal(){
  if(!currentRoomId||!modalInvite)return;
  modalInvite.classList.add('open');
  if(inviteFriendsList)inviteFriendsList.innerHTML='<div class="empty-list">Загрузка…</div>';
  socket.emit('friends-list',res=>{
    if(!inviteFriendsList)return;
    if(!res.ok||!res.friends.length){inviteFriendsList.innerHTML='<div class="empty-list">Нет друзей для приглашения</div>';return;}
    inviteFriendsList.innerHTML=res.friends.map(f=>`
      <div class="friend-item">
        <div class="friend-avatar">${avatarHtml(f.avatar,'👤')}</div>
        <div class="friend-info"><div class="friend-name">${escapeHtml(f.nickname)}</div></div>
        <div class="friend-actions"><button class="btn-sm blue" data-action="invite" data-nick="${escapeHtml(f.nickname)}">Позвать</button></div>
      </div>`).join('');
    inviteFriendsList.querySelectorAll('[data-action="invite"]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        socket.emit('room-invite',{toNickname:btn.dataset.nick,roomId:currentRoomId},res=>{
          btn.textContent=res.online?'✅ Отправлено':'📨 Будет доставлено';btn.disabled=true;
        });
      });
    });
  });
}

socket.on('room-invite',({fromNick,roomId,roomName,hasPassword,joinMode})=>{
  showToast(`📨 ${fromNick} приглашает в «${roomName}»`,8000,()=>{
    if(hasPassword)openRoomPasswordModal(roomId,roomName,joinMode);
    else if(joinMode==='approval')handleApprovalJoin(roomId,roomName);
    else{socket.emit('leave-room');if(joined){socket.emit('voice-leave');hangUp();joined=false;}joinRoom(roomId,'');}
  });
});

// ═══════════════════════════════════════════════
//  НАЗАД
// ═══════════════════════════════════════════════
if (btnBackLobby) btnBackLobby.addEventListener('click',()=>{ leaveCurrentRoom(); showScreen('lobby'); });

function leaveCurrentRoom(){
  stopMyTyping();stopPrivateTyping();stopVoiceRecording();
  if(currentChatType==='group'&&currentRoomId){
    socket.emit('leave-room');
    if(joined){socket.emit('voice-leave');hangUp();joined=false;if(micStatus)micStatus.className='mic-status';}
  }
  if(btnJoin) btnJoin.style.display='block';
  if(btnLeave)btnLeave.style.display='none';
  if(btnMic)  btnMic.style.display='none';
  clearAllTyping();Crypto.clearAllKeys();ecdhExchanged.clear();outgoingSeq=0;
  currentRoomId=null;currentRoomData=null;currentPassword='';
  currentChatType='group';currentChatId=null;currentChatWith=null;isRoomOwner=false;
}
function closeAllModals(){
  [modalContacts,modalProfile,modalMembers,modalInvite,modalSettings,modalCreate,modalRoomPw].forEach(m=>{if(m)m.classList.remove('open');});
}

// ═══════════════════════════════════════════════
//  СОБЫТИЯ КОМНАТЫ
// ═══════════════════════════════════════════════
socket.on('room-user-joined',({id,nickname})=>{ memberCount++;if(userCount)userCount.textContent=memberCount;appendSystemMsg('👋 '+nickname+' вошёл'); });
socket.on('room-user-left', id=>{ memberCount=Math.max(0,memberCount-1);if(userCount)userCount.textContent=memberCount;Crypto.clearSessionKey(id); });

socket.on('connect',()=>{
  if(reconnectBanner)reconnectBanner.classList.remove('visible');
  if(myNickname){
    socket.emit('set-nickname',myNickname,()=>{
      if(currentRoomId&&currentChatType==='group')joinRoom(currentRoomId,currentPassword);
      if(currentChatId&&currentChatType==='private')socket.emit('private-chat-join',{chatId:currentChatId});
    });
  }
});
socket.on('disconnect',()=>{ if((currentRoomId||currentChatId)&&reconnectBanner)reconnectBanner.classList.add('visible'); });

socket.on('ecdh-pubkey',async({from,pubkey,nickname})=>{
  try {
    await Crypto.deriveSessionKey(pubkey,from);
    appendSystemMsg('🔐 Ключ с '+(nickname||shortId(from)));
    if(!ecdhExchanged.has(from)){
      ecdhExchanged.add(from);
      const myPubKey=await Crypto.exportPublicKey();
      socket.emit('ecdh-pubkey',{to:from,pubkey:myPubKey});
      const fp=await Crypto.getKeyFingerprint();
      socket.emit('key-fingerprint',{to:from,fingerprint:fp});
    }
  }catch(_){}
});
socket.on('key-fingerprint',({from,nickname,fingerprint})=>{
  const div=document.createElement('div');div.className='date-divider';
  div.style.cssText='font-size:10px;color:#4caf50;cursor:pointer;user-select:all;';
  div.textContent='🔑 Ключ '+escapeHtml(nickname||shortId(from))+': '+fingerprint;
  if(chatMessages)chatMessages.appendChild(div);scrollToBottom();
});

// ═══════════════════════════════════════════════
//  TYPING
// ═══════════════════════════════════════════════
function getHeaderSubEl(){ return document.querySelector('.tg-header-sub'); }
function renderTyping(){
  const el=getHeaderSubEl();if(!el)return;
  if(currentChatType==='private')return;
  const names=Object.values(typingUsers).map(u=>u.nickname);
  if(!names.length){el.innerHTML=`<span class="online"><span id="user-count">${memberCount}</span> участников</span>`;return;}
  const text=names.length===1?escapeHtml(names[0])+' печатает…':escapeHtml(names.slice(0,2).join(', '))+' печатают…';
  el.innerHTML=`<span class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span>${text}</span>`;
}
function addTypingUser(id,nick){ if(typingUsers[id])clearTimeout(typingUsers[id].timer);typingUsers[id]={nickname:nick,timer:setTimeout(()=>removeTypingUser(id),4000)};renderTyping(); }
function removeTypingUser(id){ if(typingUsers[id]){clearTimeout(typingUsers[id].timer);delete typingUsers[id];}renderTyping(); }
function clearAllTyping(){ Object.keys(typingUsers).forEach(id=>{clearTimeout(typingUsers[id].timer);delete typingUsers[id];});renderTyping(); }
function startMyTyping(){ if(!currentRoomId||currentChatType!=='group')return;if(typingTimer)clearTimeout(typingTimer);socket.emit('typing-start');typingTimer=setTimeout(stopMyTyping,3000); }
function stopMyTyping(){ if(typingTimer){clearTimeout(typingTimer);typingTimer=null;}if(currentRoomId&&currentChatType==='group')socket.emit('typing-stop'); }
socket.on('typing-start',({from,nickname})=>{ if(from!==socket.id)addTypingUser(from,nickname); });
socket.on('typing-stop', ({from})=>removeTypingUser(from));

// ═══════════════════════════════════════════════
//  ОТПРАВКА ТЕКСТА
// ═══════════════════════════════════════════════
if (chatInput) {
  chatInput.addEventListener('input',()=>{
    chatInput.style.height='auto';
    chatInput.style.height=Math.min(chatInput.scrollHeight,120)+'px';
    if(btnVoiceRecord)btnVoiceRecord.style.display=chatInput.value.trim().length>0?'none':'flex';
    if(chatInput.value.trim().length>0){if(currentChatType==='private')startPrivateTyping();else startMyTyping();}
    else{if(currentChatType==='private')stopPrivateTyping();else stopMyTyping();}
  });
  chatInput.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendTextMessage();} });
}
if (btnSend) btnSend.addEventListener('click',sendTextMessage);

async function sendTextMessage(){
  if(!chatInput)return;
  const text=chatInput.value.trim();if(!text)return;
  stopMyTyping();stopPrivateTyping();
  if(btnSend)btnSend.disabled=true;
  try{
    if(currentChatType==='private'&&currentChatId){
      const{encrypted,iv}=await Crypto.encrypt(text);
      const seq=++outgoingSeq;
      const domId=appendMessage({nickname:myNickname,text,type:'text',timestamp:Date.now(),mine:true,status:'ok',msgStatus:'sending'});
      msgIdToDomId.set('pending-'+seq,domId);
      chatInput.value='';chatInput.style.height='auto';
      socket.emit('private-message',{chatId:currentChatId,encrypted,iv,type:'text',seq},res=>{
        if(res&&res.msgId){const d=msgIdToDomId.get('pending-'+seq);if(d){msgIdToDomId.delete('pending-'+seq);msgIdToDomId.set(res.msgId,d);updateMsgStatus(res.msgId,'sent');}}
      });
    } else if(currentRoomId){
      const{encrypted,iv}=await Crypto.encrypt(text);
      const seq=++outgoingSeq;
      const domId=appendMessage({from:socket.id,nickname:myNickname,text,type:'text',timestamp:Date.now(),mine:true,status:'ok',msgStatus:'sending'});
      seqToMsgId.set(seq,domId);
      chatInput.value='';chatInput.style.height='auto';
      socket.emit('chat-message',{encrypted,iv,type:'text',seq});
    }
    if(btnVoiceRecord)btnVoiceRecord.style.display='flex';
  }catch(e){showToast('❌ Ошибка отправки: '+e.message);}
  finally{if(btnSend)btnSend.disabled=false;}
}

// ═══════════════════════════════════════════════
//  ГОЛОСОВЫЕ СООБЩЕНИЯ — отправка
// ═══════════════════════════════════════════════
async function sendVoiceMessage(blob, duration, mimeType) {
  try {
    const ab = await blob.arrayBuffer();
    const { encrypted, iv } = await Crypto.encrypt(ab);
    const localUrl = URL.createObjectURL(new Blob([ab], { type: mimeType }));
    const seq      = ++outgoingSeq;
    const payload  = { encrypted, iv, type: 'voice', seq, duration, mimeType, fileName: 'voice.ogg', fileSize: blob.size };
    const domId = appendMessage({
      from: socket.id, nickname: myNickname, type: 'voice',
      localUrl, duration, mimeType, timestamp: Date.now(),
      mine: true, status: 'ok', msgStatus: 'sending'
    });
    msgIdToDomId.set('pending-' + seq, domId);
    if (currentChatType === 'private' && currentChatId) {
      socket.emit('private-message', { chatId: currentChatId, ...payload }, res => {
        if (res && res.msgId) {
          const d = msgIdToDomId.get('pending-' + seq);
          if (d) { msgIdToDomId.delete('pending-' + seq); msgIdToDomId.set(res.msgId, d); updateMsgStatus(res.msgId, 'sent'); }
        }
      });
    } else if (currentRoomId) {
      socket.emit('chat-message', payload);
    }
  } catch(e) { showToast('❌ Ошибка отправки голосового: ' + e.message); }
}

// ═══════════════════════════════════════════════
//  ЗАПИСЬ ГОЛОСОВЫХ СООБЩЕНИЙ
// ═══════════════════════════════════════════════
if (btnVoiceRecord) {
  let isPointerDown = false;

  btnVoiceRecord.addEventListener('touchstart', e => {
    e.preventDefault();
    isPointerDown = true;
    setTimeout(() => { if (isPointerDown && !isVoiceRecording) startVoiceRecording(); }, 100);
  }, { passive: false });

  btnVoiceRecord.addEventListener('touchend', e => {
    e.preventDefault();
    isPointerDown = false;
    if (isVoiceRecording) stopAndSendVoice();
  }, { passive: false });

  btnVoiceRecord.addEventListener('touchcancel', e => {
    e.preventDefault();
    isPointerDown = false;
    if (isVoiceRecording) stopAndCancelVoice();
  }, { passive: false });

  btnVoiceRecord.addEventListener('mousedown', e => {
    e.preventDefault();
    isPointerDown = true;
    if (!isVoiceRecording) startVoiceRecording();
  });

  document.addEventListener('mouseup', () => {
    if (isPointerDown) { isPointerDown = false; if (isVoiceRecording) stopAndSendVoice(); }
  });

  let touchStartX = 0;
  btnVoiceRecord.addEventListener('touchmove', e => {
    if (!isVoiceRecording) return;
    const touch = e.touches[0];
    if (!touchStartX) touchStartX = touch.clientX;
    const deltaX = touch.clientX - touchStartX;
    if (deltaX < -60) { touchStartX = 0; stopAndCancelVoice(); showToast('❌ Запись отменена'); }
  }, { passive: true });
}

async function startVoiceRecording() {
  if (isVoiceRecording) return;
  try { voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch (e) { showToast('❌ Нет доступа к микрофону'); return; }
  isVoiceRecording = true; voiceRecordChunks = []; voiceRecordSeconds = 0;
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
  voiceRecorder = new MediaRecorder(voiceRecordStream, { mimeType });
  voiceRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) voiceRecordChunks.push(e.data); };
  voiceRecorder.onstop = async () => {
    const blob = new Blob(voiceRecordChunks, { type: mimeType });
    if (voiceRecordStream) { voiceRecordStream.getTracks().forEach(t => t.stop()); voiceRecordStream = null; }
    if (blob.size < 100) return;
    await sendVoiceMessage(blob, voiceRecordSeconds, mimeType);
  };
  voiceRecorder.start(100);
  if (btnVoiceRecord) btnVoiceRecord.classList.add('recording');
  if (voiceRecordTimer) voiceRecordTimer.classList.add('visible');
  if (chatInput) chatInput.style.display = 'none';
  voiceRecordInterval = setInterval(() => {
    voiceRecordSeconds++;
    if (voiceRecordTime) voiceRecordTime.textContent = formatDuration(voiceRecordSeconds);
    if (voiceRecordSeconds >= 120) stopAndSendVoice();
  }, 1000);
}

function stopAndSendVoice() {
  if (!isVoiceRecording) return;
  isVoiceRecording = false; clearInterval(voiceRecordInterval);
  if (voiceRecorder && voiceRecorder.state !== 'inactive') voiceRecorder.stop();
  if (btnVoiceRecord) btnVoiceRecord.classList.remove('recording');
  if (voiceRecordTimer) voiceRecordTimer.classList.remove('visible');
  if (chatInput) chatInput.style.display = '';
  if (voiceRecordTime) voiceRecordTime.textContent = '0:00';
}

function stopAndCancelVoice() {
  if (!isVoiceRecording) return;
  isVoiceRecording = false; clearInterval(voiceRecordInterval);
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.ondataavailable = null; voiceRecorder.onstop = null; voiceRecorder.stop();
  }
  if (voiceRecordStream) { voiceRecordStream.getTracks().forEach(t => t.stop()); voiceRecordStream = null; }
  if (btnVoiceRecord) btnVoiceRecord.classList.remove('recording');
  if (voiceRecordTimer) voiceRecordTimer.classList.remove('visible');
  if (chatInput) chatInput.style.display = '';
  if (voiceRecordTime) voiceRecordTime.textContent = '0:00';
}

function stopVoiceRecording() { if (isVoiceRecording) stopAndCancelVoice(); }

// ─── Файлы ───
if (btnPhoto) btnPhoto.addEventListener('click', () => { if(fileInput){ fileInput.accept='image/*'; fileInput.click(); }});
if (btnVideo) btnVideo.addEventListener('click', () => { if(fileInput){ fileInput.accept='video/*'; fileInput.click(); }});
if (btnFile)  btnFile.addEventListener('click',  () => { if(fileInput){ fileInput.accept='*/*';     fileInput.click(); }});

if (fileInput) fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]; if (!file) return;
  fileInput.value = '';
  if (file.size > 100 * 1024 * 1024) { showToast('⚠️ Файл слишком большой. Максимум 100 МБ.'); return; }
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (isImage) { MediaEditor.openPhoto(file, async (b,mt,fn) => await sendMediaBlob(b,mt,fn,'image'), ()=>{}); return; }
  if (isVideo) { MediaEditor.openVideo(file, async (b,mt,fn) => await sendMediaBlob(b,mt,fn,'video'), ()=>{}); return; }
  await sendMediaBlob(file, file.type, file.name, 'file');
});

async function sendMediaBlob(blob, mimeType, fileName, type) {
  showUploadProgress(fileName);
  showChatUploadStatus(type);
  try {
    const ab = await blob.arrayBuffer();
    let fakeProgress = 0;
    const progressInterval = setInterval(() => {
      fakeProgress = Math.min(fakeProgress + 5, 90);
      updateUploadProgress(fakeProgress);
    }, 100);
    const { encrypted, iv } = await Crypto.encrypt(ab);
    clearInterval(progressInterval);
    updateUploadProgress(95);
    const localUrl = URL.createObjectURL(new Blob([ab], { type: mimeType }));
    const seq      = ++outgoingSeq;
    const payload  = { encrypted, iv, type, seq, fileName: fileName || 'file', fileSize: blob.size, mimeType };
    const domId = appendMessage({
      from: socket.id, nickname: myNickname, type, localUrl,
      fileName: fileName || 'file', fileSize: blob.size, mimeType,
      timestamp: Date.now(), mine: true, status: 'ok', msgStatus: 'sending'
    });
    msgIdToDomId.set('pending-' + seq, domId);
    if (currentChatType === 'private' && currentChatId) {
      socket.emit('private-message', { chatId: currentChatId, ...payload }, res => {
        updateUploadProgress(100); setTimeout(hideUploadProgress, 500); hideChatUploadStatus();
        if (res && !res.ok) showToast('❌ Ошибка: ' + (res.error === 'file_too_large' ? 'Файл слишком большой' : res.error));
        if (res && res.msgId) {
          const d = msgIdToDomId.get('pending-' + seq);
          if (d) { msgIdToDomId.delete('pending-' + seq); msgIdToDomId.set(res.msgId, d); updateMsgStatus(res.msgId, 'sent'); }
        }
      });
    } else if (currentRoomId) {
      socket.emit('chat-message', payload);
      updateUploadProgress(100); setTimeout(hideUploadProgress, 500); hideChatUploadStatus();
    }
  } catch (e) {
    hideUploadProgress(); hideChatUploadStatus();
    showToast('❌ Ошибка отправки: ' + e.message);
  }
}

// ─── Входящие сообщения группы ───
socket.on('chat-message', async data => {
  const chatId  = currentRoomId;
  const setting = getNotifSetting(chatId || '');

  if (data.type === 'voice') {
    if (setting !== 'none' && setting !== 'mute') playMsgSound(chatId);
    appendMessage({
      id: data.id, from: data.from, nickname: data.nickname, type: 'voice',
      duration: data.duration || 0, timestamp: data.timestamp, mine: false, status: 'ok',
      encrypted: data.encrypted, iv: data.iv, mimeType: data.mimeType
    });
    if (document.visibilityState !== 'visible') addUnread(chatId, 1);
    return;
  }

  const domId = appendMessage({
    id: data.id, from: data.from, nickname: data.nickname, type: data.type,
    fileName: data.fileName, fileSize: data.fileSize, mimeType: data.mimeType,
    timestamp: data.timestamp, mine: false, status: 'decrypting'
  });

  try {
    if (data.type === 'text') {
      const text = await Crypto.decryptText(data.encrypted, data.iv);
      updateMessage(domId, { text, status: 'ok' });
      if (setting !== 'none') {
        if (setting !== 'mute') playMsgSound(chatId);
        showBrowserNotif('💬 ' + (data.nickname || '?'), text, chatId);
      }
      if (document.visibilityState !== 'visible') addUnread(chatId, 1);
    } else {
      const mime = data.mimeType || 'application/octet-stream';
      const blob = await Crypto.decryptBlob(data.encrypted, data.iv, mime);
      updateMessage(domId, { localUrl: URL.createObjectURL(blob), status: 'ok' });
      if (document.visibilityState !== 'visible') addUnread(chatId, 1);
    }
  } catch { updateMessage(domId, { status: 'error' }); }
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
  div.dataset.type      = msg.type     || 'text';
  div.dataset.mimeType  = msg.mimeType || '';
  div.dataset.fileName  = msg.fileName || '';
  div.dataset.fileSize  = String(msg.fileSize || '');
  div.dataset.duration  = String(msg.duration || '0');
  div.dataset.encrypted = msg.encrypted || '';
  div.dataset.iv        = msg.iv        || '';
  div.dataset.msgId     = msg.id        || '';
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
    const merged = {
      type: div.dataset.type, mimeType: div.dataset.mimeType,
      fileName: div.dataset.fileName, fileSize: div.dataset.fileSize,
      duration: div.dataset.duration, ...updates
    };
    content.innerHTML = buildContentHTML(merged);
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
  const time   = new Date(msg.timestamp || Date.now()).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const sender = msg.mine ? '' : `<div class="msg-sender">👤 ${escapeHtml(msg.nickname || '?')}</div>`;
  const stText  = msg.status === 'ok' ? '🔓' : msg.status === 'error' ? '⚠️' : '⏳';
  const stClass = msg.status === 'ok' ? 'ok' : msg.status === 'error' ? 'err' : '';
  const st      = msg.mine ? '' : `<div class="msg-decrypt-status ${stClass}">${stText}</div>`;
  const ticks   = buildStatusTicks(msg.msgStatus || (msg.mine ? 'sent' : null), msg.mine);
  const edited  = msg.edited ? `<span style="font-size:10px;opacity:0.5"> (ред.)</span>` : '';
  return `
    ${sender}
    <div class="msg-content">${buildContentHTML(msg)}${edited}</div>
    <div class="msg-meta" style="display:flex;align-items:center;justify-content:flex-end;gap:4px;">
      <span>${time}</span>${ticks}
    </div>
    ${st}`;
}

function buildContentHTML(msg) {
  if (msg.type === 'text') return escapeHtml(msg.text || '');
  if (msg.type === 'image') return msg.localUrl
    ? `<img class="msg-media" src="${msg.localUrl}" alt="фото" loading="lazy">`
    : `<div style="display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px"><span>🖼</span><span>Загрузка…</span></div>`;
  if (msg.type === 'video') return msg.localUrl
    ? `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>`
    : `<div style="display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px"><span>🎬</span><span>Загрузка…</span></div>`;
  if (msg.type === 'file') {
    const size = msg.fileSize ? formatSize(parseInt(msg.fileSize)) : '';
    return msg.localUrl
      ? `<div class="msg-file">
           <span class="msg-file-icon">📄</span>
           <div class="msg-file-info">
             <div class="msg-file-name">${escapeHtml(msg.fileName || 'файл')}</div>
             <div class="msg-file-size">${size}</div>
           </div>
           <a class="msg-file-dl" href="${msg.localUrl}" download="${escapeHtml(msg.fileName || 'file')}">⬇️</a>
         </div>`
      : `<div style="display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px"><span>📎</span><span>${escapeHtml(msg.fileName || 'файл')} · Загрузка…</span></div>`;
  }
  if (msg.type === 'voice') return buildVoiceMessageHTML(msg);
  return '';
}

function buildVoiceMessageHTML(msg) {
  const dur    = parseInt(msg.duration) || 0;
  const durStr = formatDuration(dur);
  const vmId   = 'vm-' + Math.random().toString(36).slice(2);
  const bars   = Array.from({ length: 20 }, () => {
    const h = Math.floor(Math.random() * 16 + 4);
    return `<div class="voice-msg-bar" style="height:${h}px"></div>`;
  }).join('');
  if (msg.localUrl) {
    return `<div class="voice-msg" id="${vmId}" data-dur="${dur}">
      <button class="voice-msg-btn" data-url="${msg.localUrl}">▶️</button>
      <div class="voice-msg-waveform">${bars}</div>
      <span class="voice-msg-duration">${durStr}</span>
    </div>`;
  }
  return `<div class="voice-msg" id="${vmId}" data-encrypted="${msg.encrypted||''}" data-iv="${msg.iv||''}" data-mime="${msg.mimeType||'audio/webm'}" data-dur="${dur}">
    <button class="voice-msg-btn voice-decrypt-btn">▶️</button>
    <div class="voice-msg-waveform">${bars}</div>
    <span class="voice-msg-duration">${durStr}</span>
  </div>`;
}

let currentVoiceAudio = null;
let currentVoiceBtn   = null;

function playVoiceMsg(btn, url, wrap) {
  if (!wrap) wrap = btn.closest('.voice-msg');
  if (currentVoiceAudio && !currentVoiceAudio.paused) {
    currentVoiceAudio.pause();
    currentVoiceAudio.currentTime = 0;
    document.querySelectorAll('.voice-msg-btn').forEach(b => b.textContent = '▶️');
    document.querySelectorAll('.voice-msg-bar').forEach(b => b.classList.remove('active'));
    if (currentVoiceAudio._url === url) { currentVoiceAudio = null; currentVoiceBtn = null; return; }
  }
  const audio = new Audio(url); audio._url = url;
  currentVoiceAudio = audio; currentVoiceBtn = btn;
  btn.textContent = '⏸️';
  audio.play().then(() => {
    const bars    = wrap ? [...wrap.querySelectorAll('.voice-msg-bar')] : [];
    const durEl   = wrap ? wrap.querySelector('.voice-msg-duration') : null;
    const origDur = parseInt(wrap?.dataset.dur || '0');
    audio.ontimeupdate = () => {
      const pct    = audio.duration ? audio.currentTime / audio.duration : 0;
      const active = Math.floor(pct * bars.length);
      bars.forEach((b, i) => b.classList.toggle('active', i <= active));
      if (durEl) durEl.textContent = formatDuration(Math.floor(audio.currentTime));
    };
    audio.onended = () => {
      btn.textContent = '▶️';
      bars.forEach(b => b.classList.remove('active'));
      if (durEl) durEl.textContent = formatDuration(origDur);
      currentVoiceAudio = null; currentVoiceBtn = null;
    };
  }).catch(() => { btn.textContent = '▶️'; });
}

function bindMediaEvents(container) {
  container.querySelectorAll('img.msg-media').forEach(img => {
    img.onclick = () => openLightbox('img', img.src);
  });
  container.querySelectorAll('video.msg-media').forEach(vid => {
    vid.ondblclick = () => openLightbox('video', vid.src);
  });
  container.querySelectorAll('.voice-msg-btn[data-url]').forEach(btn => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.voice-msg');
      playVoiceMsg(btn, btn.dataset.url, wrap);
    });
  });
  container.querySelectorAll('.voice-decrypt-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const wrap = btn.closest('.voice-msg'); if (!wrap) return;
      const enc  = wrap.dataset.encrypted;
      const iv   = wrap.dataset.iv;
      const mime = wrap.dataset.mime || 'audio/webm';
      if (!enc || !iv) return;
      btn.textContent = '⏳';
      try {
        const blob = await Crypto.decryptBlob(enc, iv, mime);
        const url  = URL.createObjectURL(blob);
        btn.classList.remove('voice-decrypt-btn');
        btn.dataset.url = url;
        btn.textContent = '▶️';
        btn.addEventListener('click', () => playVoiceMsg(btn, url, wrap));
        playVoiceMsg(btn, url, wrap);
      } catch (e) { btn.textContent = '❌'; showToast('Ошибка воспроизведения'); }
    });
  });
}

// ═══════════════════════════════════════════════
//  LIGHTBOX
// ═══════════════════════════════════════════════
function openLightbox(type, src) {
  if (!lightboxContent || !lightbox) return;
  lightboxContent.innerHTML = type === 'img'
    ? `<img src="${src}" alt="">`
    : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}
if (lightboxClose) lightboxClose.addEventListener('click', () => {
  if (lightbox) { lightbox.classList.remove('open'); if (lightboxContent) lightboxContent.innerHTML = ''; }
});
if (lightbox) lightbox.addEventListener('click', e => {
  if (e.target === lightbox) { lightbox.classList.remove('open'); if (lightboxContent) lightboxContent.innerHTML = ''; }
});

// ═══════════════════════════════════════════════
//  ГОЛОСОВОЙ ЧАТ (WebRTC — группы)
// ═══════════════════════════════════════════════
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
    // Обрабатываем отложенные оферы
    for (const { from, offer, nickname } of pendingOffers) {
      if (offer) await handleOffer(from, offer, nickname);
    }
    pendingOffers = [];
  } catch (err) {
    const msgs = {
      NotAllowedError:  '❌ Доступ к микрофону запрещён.',
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
    if (!peers[user.id]) {
      peers[user.id] = createPeer(user.id, true);
    }
    try {
      if (!ecdhExchanged.has(user.id)) {
        ecdhExchanged.add(user.id);
        socket.emit('ecdh-pubkey', { to: user.id, pubkey: await Crypto.exportPublicKey() });
      }
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
    // Новый пользователь — мы инициируем offer к нему
    if (!peers[uid]) peers[uid] = createPeer(uid, false);
    try {
      if (!ecdhExchanged.has(uid)) {
        ecdhExchanged.add(uid);
        socket.emit('ecdh-pubkey', { to: uid, pubkey: await Crypto.exportPublicKey() });
      }
    } catch (_) {}
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

  // Закрываем старый peer если был
  if (peers[from]) { try { peers[from].close(); } catch(_) {} delete peers[from]; }

  const peer = new RTCPeerConnection(iceServers);
  peers[from] = peer;

  // ─── КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ для групп: добавляем треки ПЕРЕД setRemoteDescription ───
  const stream = processedStream || localStream;
  if (stream) {
    stream.getTracks().forEach(t => {
      try { peer.addTrack(t, stream); } catch(_) {}
    });
  }

  peer.ontrack = e => {
    const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    if (e.track.kind !== 'audio') return;
    let audio = document.getElementById('audio-' + from);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + from;
      audio.autoplay = true;
      audio.playsInline = true;
      if (hiddenAudios) hiddenAudios.appendChild(audio);
    }
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
      audio.play()
        .then(() => startVolumeAnalysis(from, stream))
        .catch(() => { document.addEventListener('click', () => audio.play().catch(() => {}), { once: true }); });
    }
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: from, candidate: e.candidate });
  };

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    if (s === 'failed') peer.restartIce();
    if (s === 'disconnected') setTimeout(() => { if (peer.iceConnectionState === 'disconnected') peer.restartIce(); }, 3000);
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') {
      startQualityMonitor(from, peer, false);
    }
  };

  try {
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    const answer   = await peer.createAnswer();
    const improved = { type: answer.type, sdp: forceOpusMaxQuality(answer.sdp) };
    await peer.setLocalDescription(improved);
    socket.emit('answer', { to: from, answer: improved });
  } catch(e) {
    console.error('handleOffer error:', e);
  }
}

socket.on('answer', async ({ from, answer }) => {
  if (voiceNicknames[from]) updateParticipantName(from, voiceNicknames[from]);
  const peer = peers[from];
  if (peer && peer.signalingState === 'have-local-offer') {
    try { await peer.setRemoteDescription(new RTCSessionDescription(answer)); }
    catch(e) { console.error('answer setRemoteDescription error:', e); }
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (peer && candidate) {
    try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }
});

socket.on('voice-user-left', uid => {
  playBeep('leave');
  removeParticipant(uid); stopVolumeAnalysis(uid); stopQualityMonitor(uid);
  delete voiceNicknames[uid];
  if (peers[uid]) { peers[uid].close(); delete peers[uid]; }
  const el = document.getElementById('audio-' + uid); if (el) el.remove();
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
  div.className = 'participant'; div.id = 'p-' + userId;
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
  if (btn) btn.addEventListener('click', function() {
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
  try {
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;
    function tick() {
      if (!analysers[userId]) return;
      analyser.getByteFrequencyData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
      const pct = Math.min(100, (sum / data.length) * 3);
      const bar = document.getElementById('vol-' + userId);
      if (bar) { bar.style.width = pct + '%'; bar.className = 'volume-bar' + (pct > 60 ? ' loud' : ''); }
      const speaking = pct > SPEAKING_THRESHOLD;
      if (speaking !== wasSpeaking) { setSpeaking(userId, speaking); wasSpeaking = speaking; }
      analysers[userId].animFrame = requestAnimationFrame(tick);
    }
    analysers[userId] = { analyser, source, animFrame: requestAnimationFrame(tick) };
  } catch(e) {
    console.warn('startVolumeAnalysis error:', e);
  }
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

async function getMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: { ideal: true }, noiseSuppression: { ideal: true },
        autoGainControl:  { ideal: true }, sampleRate: { ideal: 48000 }, channelCount: { ideal: 1 }
      }
    });
  } catch (e) {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  }
}

async function buildAudioPipeline(rawStream) {
  if (!audioCtx || audioCtx.state === 'closed')
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  try { await audioCtx.audioWorklet.addModule('/audio-processor.js'); } catch (_) {}
  const source = audioCtx.createMediaStreamSource(rawStream);
  const hpf    = audioCtx.createBiquadFilter();
  hpf.type = 'highpass'; hpf.frequency.value = 100; hpf.Q.value = 0.9;
  const lpf = audioCtx.createBiquadFilter();
  lpf.type = 'lowpass'; lpf.frequency.value = 8000; lpf.Q.value = 0.7;
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -28; comp.knee.value = 10;
  comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;
  noiseWorklet = new AudioWorkletNode(audioCtx, 'noise-gate-processor', {
    processorOptions: { threshold: 0.08, attack: 0.003, release: 0.25, smoothing: 0.97 },
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
  });
  const gain = audioCtx.createGain(); gain.gain.value = 1.2;
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(hpf); hpf.connect(lpf); lpf.connect(comp);
  comp.connect(noiseWorklet); noiseWorklet.connect(gain); gain.connect(dest);
  if (noiseIndicator) noiseIndicator.classList.add('visible');
  return dest.stream;
}

const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'   },
    { urls: 'stun:stun1.l.google.com:19302'  },
    { urls: 'stun:stun2.l.google.com:19302'  },
    { urls: 'stun:stun.relay.metered.ca:80'  },
    { urls: 'turn:global.relay.metered.ca:80',                 username: '4219a9030e911d3a21936639', credential: 'W9K/4EBqUUoxu9FC' },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp',   username: '4219a9030e911d3a21936639', credential: 'W9K/4EBqUUoxu9FC' },
    { urls: 'turn:global.relay.metered.ca:443',                username: '4219a9030e911d3a21936639', credential: 'W9K/4EBqUUoxu9FC' },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: '4219a9030e911d3a21936639', credential: 'W9K/4EBqUUoxu9FC' }
  ],
  iceCandidatePoolSize: 10, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require'
};

function forceOpusMaxQuality(sdp) {
  const lines = sdp.split('\r\n'); const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('a=rtpmap') && line.toLowerCase().includes('opus')) {
      result.push(line);
      const pt = line.split(':')[1].split(' ')[0];
      if (i + 1 < lines.length && lines[i+1].startsWith('a=fmtp:' + pt)) i++;
      result.push('a=fmtp:' + pt + ' minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=40000;dtx=1;cbr=0');
      continue;
    }
    if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) continue;
    result.push(line);
  }
  return result.join('\r\n');
}

// ═══════════════════════════════════════════════
//  ШКАЛА КАЧЕСТВА СИГНАЛА — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ═══════════════════════════════════════════════
function calcLevel(rtt, lostRatio, jitter) {
  // rtt в мс, lostRatio 0..1, jitter в секундах
  if (rtt === null && lostRatio === null) return 'none';
  const r = rtt !== null ? rtt : 999;
  const j = jitter !== null ? jitter * 1000 : 999; // переводим в мс
  const l = lostRatio !== null ? lostRatio : 1;

  // 4 палки — отличное
  if (r < 100 && l < 0.02 && j < 20)  return 'excellent';
  // 3 палки — хорошее
  if (r < 200 && l < 0.05 && j < 50)  return 'good';
  // 2 палки — среднее
  if (r < 400 && l < 0.15 && j < 100) return 'fair';
  // 1 палка — плохое
  return 'poor';
}

function renderSignal(userId, level) {
  const w = document.getElementById('sig-' + userId);
  if (!w) return;
  // Убираем все классы signal-*
  w.className = 'signal-wrap signal-' + (level || 'none');
}

async function measureQuality(peer, isLocal) {
  try {
    const stats = await peer.getStats();
    let rtt = null, lostRatio = null, jitter = null;

    stats.forEach(r => {
      // RTT из candidate-pair (наиболее надёжно)
      if (r.type === 'candidate-pair' && r.state === 'succeeded') {
        if (r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
      }

      if (isLocal) {
        // Для отправителя — смотрим remote-inbound-rtp
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
          if (r.roundTripTime != null) rtt = r.roundTripTime * 1000;
          if (r.jitter != null) jitter = r.jitter;
          if (r.packetsLost != null) {
            // Считаем ratio из outbound-rtp
            stats.forEach(s => {
              if (s.type === 'outbound-rtp' && s.kind === 'audio' && s.packetsSent > 0) {
                lostRatio = Math.max(0, r.packetsLost) / (Math.max(0, r.packetsLost) + s.packetsSent);
              }
            });
          }
        }
      } else {
        // Для получателя — смотрим inbound-rtp
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          if (r.jitter != null) jitter = r.jitter;
          const total = (r.packetsReceived || 0) + (r.packetsLost || 0);
          if (total > 0) lostRatio = Math.max(0, r.packetsLost || 0) / total;
        }
      }
    });

    return calcLevel(rtt, lostRatio, jitter);
  } catch {
    return 'none';
  }
}

function startQualityMonitor(userId, peer, isLocal) {
  stopQualityMonitor(userId);
  // Сразу ставим хорошее — при подключении нет данных
  renderSignal(userId, 'good');
  qualityTimers[userId] = setInterval(async () => {
    const level = await measureQuality(peer, isLocal);
    renderSignal(userId, level);
  }, 3000);
}

function stopQualityMonitor(userId) {
  if (qualityTimers[userId]) { clearInterval(qualityTimers[userId]); delete qualityTimers[userId]; }
  renderSignal(userId, 'none');
}

// ─── createPeer для групповых звонков ───
function createPeer(userId, isInitiator) {
  const peer   = new RTCPeerConnection(iceServers);

  // ─── КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: добавляем треки СРАЗУ при создании peer ───
  const stream = processedStream || localStream;
  if (stream) {
    stream.getTracks().forEach(t => {
      try { peer.addTrack(t, stream); } catch(_) {}
    });
  }

  // Устанавливаем параметры кодека
  peer.getSenders().forEach(s => {
    if (s.track?.kind === 'audio') {
      const p = s.getParameters();
      if (!p.encodings) p.encodings = [{}];
      p.encodings[0].maxBitrate = 40000; p.encodings[0].priority = 'high';
      s.setParameters(p).catch(() => {});
    }
  });

  let restartAttempts = 0, restartTimer = null;
  function tryRestart() {
    if (restartAttempts >= 5) return;
    restartAttempts++;
    clearTimeout(restartTimer);
    const delay = Math.min(1500 * Math.pow(2, restartAttempts - 1), 20000);
    restartTimer = setTimeout(() => {
      if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') peer.restartIce();
    }, delay);
  }

  peer.addEventListener('connectionstatechange', () => {
    const state = peer.connectionState;
    if (state === 'connected') {
      restartAttempts = 0; clearTimeout(restartTimer);
      startQualityMonitor(userId, peer, isInitiator);
      // Если это мы — запускаем мониторинг и для себя
      if (isInitiator && !qualityTimers[socket.id]) {
        startQualityMonitor(socket.id, peer, true);
      }
    }
    if (state === 'failed') tryRestart();
    if (state === 'disconnected') {
      restartTimer = setTimeout(() => {
        if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') tryRestart();
      }, 3000);
    }
  });

  peer.ontrack = e => {
    const trackStream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    if (e.track.kind !== 'audio') return;

    let audio = document.getElementById('audio-' + userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + userId;
      audio.autoplay = true;
      audio.playsInline = true;
      if (hiddenAudios) hiddenAudios.appendChild(audio);
    }
    // ─── КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: всегда обновляем srcObject ───
    if (audio.srcObject !== trackStream) {
      audio.srcObject = trackStream;
      audio.play()
        .then(() => startVolumeAnalysis(userId, trackStream))
        .catch(() => {
          document.addEventListener('click', () => {
            audio.play().catch(() => {});
          }, { once: true });
        });
    }
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: userId, candidate: e.candidate });
  };

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    if (s === 'failed') tryRestart();
    if (s === 'disconnected') setTimeout(() => { if (peer.iceConnectionState === 'disconnected') tryRestart(); }, 3000);
  };

  if (isInitiator) {
    let offerSent = false;
    peer.onnegotiationneeded = async () => {
      if (offerSent) return; offerSent = true;
      try {
        const offer    = await peer.createOffer({ offerToReceiveAudio: true });
        const improved = { type: offer.type, sdp: forceOpusMaxQuality(offer.sdp) };
        await peer.setLocalDescription(improved);
        socket.emit('offer', { to: userId, offer: improved });
      } catch (e) {
        console.error('createOffer error:', e);
        offerSent = false;
      }
    };
  }
  return peer;
}

function hangUp() {
  Object.keys(analysers).forEach(stopVolumeAnalysis);
  Object.keys(qualityTimers).forEach(stopQualityMonitor);
  Object.values(peers).forEach(p => { try { p.close(); } catch(_) {} });
  peers = {};
  for (const k in voiceNicknames) delete voiceNicknames[k];
  if (localStream)  { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (noiseWorklet) { try { noiseWorklet.disconnect(); } catch (_) {} noiseWorklet = null; }
  if (audioCtx)     { audioCtx.close().catch(() => {}); audioCtx = null; }
  processedStream = null;
  if (noiseIndicator) noiseIndicator.classList.remove('visible');
  if (hiddenAudios)   hiddenAudios.innerHTML = '';
  pendingOffers = [];
  if (participantsList) participantsList.innerHTML = '';
  if (participantsBox)  participantsBox.style.display = 'none';
}

function playBeep(type) {
  try {
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    if (type==='join') { osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.setValueAtTime(900, ctx.currentTime+0.12); }
    else               { osc.frequency.setValueAtTime(900, ctx.currentTime); osc.frequency.setValueAtTime(500, ctx.currentTime+0.12); }
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close();
  } catch (_) {}
}

function playOkSound() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain(); gain.connect(ctx.destination);
    [{freq:880,start:0},{freq:1100,start:0.22}].forEach(item => {
      const osc = ctx.createOscillator(); osc.type='sine'; osc.connect(gain);
      osc.frequency.setValueAtTime(item.freq, ctx.currentTime+item.start);
      gain.gain.setValueAtTime(0, ctx.currentTime+item.start);
      gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime+item.start+0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+item.start+0.20);
      osc.start(ctx.currentTime+item.start); osc.stop(ctx.currentTime+item.start+0.22);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch (_) {}
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !joined || !localStream) return;
  await requestWakeLock();
  const tracks = localStream.getAudioTracks();
  if (tracks.every(t => t.readyState === 'ended')) {
    try {
      const newRaw = await getMicStream();
      let newProc;
      try { newProc = await buildAudioPipeline(newRaw); } catch { newProc = newRaw; }
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
  } else { tracks.forEach(t => { t.enabled = micEnabled; }); }
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
});

// ═══════════════════════════════════════════════
//  КНОПКА ЗВОНКА
// ═══════════════════════════════════════════════
function updateCallButton() {
  if (btnPrivateCall) btnPrivateCall.style.display = currentChatType === 'private' ? 'flex' : 'none';
}

$('btn-notif-settings')?.addEventListener('click', () => {
  const id   = currentChatType === 'private' ? currentChatId : currentRoomId;
  const name = document.getElementById('chat-room-name')?.textContent || '?';
  if (id) openChatNotifSettings(id, name);
});

$('btn-room-members')?.addEventListener('click', () => {
  if (currentChatType === 'group' && currentRoomId) openMembersModal();
});

// ═══════════════════════════════════════════════
//  МИНИ-БАР ЗВОНКА
// ═══════════════════════════════════════════════
function showCallMiniBar(name, avatar) {
  const bar = $('call-mini-bar'); if (!bar) return;
  const nameEl   = $('call-mini-name');
  const avatarEl = $('call-mini-avatar');
  if (nameEl)   nameEl.textContent = name || '—';
  if (avatarEl) {
    if (avatar) avatarEl.innerHTML = `<img src="${avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else        avatarEl.textContent = '👤';
  }
  bar.classList.add('visible');
  bar.onclick = e => {
    if (e.target.id === 'call-mini-hangup') return;
    const withAvatar = $('call-screen-avatar')?.querySelector('img')?.src || null;
    showCallScreen(pcCallRemoteNick, withAvatar, null, pcCallIsVideo);
  };
}
function hideCallMiniBar() {
  const bar = $('call-mini-bar'); if (bar) bar.classList.remove('visible');
}
function updateCallMiniStatus(text) {
  const el = $('call-mini-status-text'); if (el) el.textContent = text || 'Звонок…';
}

// ═══════════════════════════════════════════════
//  ЗВУКИ ЗВОНКА
// ═══════════════════════════════════════════════
let ringInterval     = null;
let ringToneCtx      = null;
let dialToneInterval = null;

function playIncomingRing() {
  stopIncomingRing();
  let count = 0;
  const playOnce = () => {
    if (count++ > 30) { stopIncomingRing(); return; }
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      ringToneCtx = ctx;
      const gain = ctx.createGain(); gain.connect(ctx.destination);
      const notes = [
        { freq: 480, time: 0,    dur: 0.18 },
        { freq: 640, time: 0.20, dur: 0.18 },
        { freq: 800, time: 0.40, dur: 0.28 }
      ];
      notes.forEach(note => {
        const osc = ctx.createOscillator(); osc.type = 'sine';
        osc.frequency.setValueAtTime(note.freq, ctx.currentTime + note.time);
        osc.connect(gain);
        gain.gain.setValueAtTime(0, ctx.currentTime + note.time);
        gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + note.time + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.time + note.dur);
        osc.start(ctx.currentTime + note.time);
        osc.stop(ctx.currentTime + note.time + note.dur + 0.05);
      });
      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 1500);
    } catch (_) {}
  };
  playOnce();
  ringInterval = setInterval(playOnce, 2000);
}
function stopIncomingRing() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
  if (ringToneCtx)  { try { ringToneCtx.close(); } catch (_) {} ringToneCtx = null; }
}

function playDialTone() {
  stopDialTone();
  let count = 0;
  const playOnce = () => {
    if (count++ > 60) { stopDialTone(); return; }
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination);
      osc1.type = 'sine'; osc1.frequency.value = 425;
      osc2.type = 'sine'; osc2.frequency.value = 450;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime + 1.0);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.05);
      osc1.start(ctx.currentTime); osc1.stop(ctx.currentTime + 1.1);
      osc2.start(ctx.currentTime); osc2.stop(ctx.currentTime + 1.1);
      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 2500);
    } catch (_) {}
  };
  playOnce();
  dialToneInterval = setInterval(playOnce, 4000);
}
function stopDialTone() {
  if (dialToneInterval) { clearInterval(dialToneInterval); dialToneInterval = null; }
}

// ═══════════════════════════════════════════════
//  ДИНАМИК
// ═══════════════════════════════════════════════
function setSpeakerOutput(external) {
  isSpeakerMode = external;
  if (callBtnSpeaker) {
    if (external) { callBtnSpeaker.textContent = '🔊'; callBtnSpeaker.classList.add('active'); }
    else          { callBtnSpeaker.textContent = '🔈'; callBtnSpeaker.classList.remove('active'); }
  }
  const callAudio = document.getElementById('audio-pc-call');
  if (callAudio) callAudio.volume = external ? 1.0 : 0.7;
}
if (callBtnSpeaker) callBtnSpeaker.addEventListener('click', () => setSpeakerOutput(!isSpeakerMode));

// ═══════════════════════════════════════════════
//  ВИДЕО — утилиты
// ═══════════════════════════════════════════════
function ensureVideoElements() {
  let vc = document.getElementById('call-video-container');
  if (!vc) {
    vc = document.createElement('div');
    vc.id = 'call-video-container';
    vc.style.cssText = 'position:fixed;inset:0;display:none;z-index:998;background:#000;overflow:hidden;';
    const rv = document.createElement('video');
    rv.id = 'video-remote'; rv.autoplay = true; rv.playsInline = true;
    rv.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    vc.appendChild(rv);
    const ns = document.createElement('div');
    ns.id = 'video-no-signal';
    ns.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:rgba(255,255,255,0.4);font-size:14px;gap:12px;';
    ns.innerHTML = '<span style="font-size:48px">📷</span><span>Видео недоступно</span>';
    vc.appendChild(ns);
    document.body.appendChild(vc);
  }
  return vc;
}

function ensureLocalVideo() {
  let lv = document.getElementById('video-local');
  if (!lv) {
    lv = document.createElement('video');
    lv.id = 'video-local'; lv.autoplay = true; lv.playsInline = true; lv.muted = true;
    document.body.appendChild(lv);
  }
  return lv;
}

async function startLocalVideo() {
  try {
    localVideoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const lv = ensureLocalVideo();
    lv.srcObject = localVideoStream;
    lv.style.display = 'block';
    return localVideoStream;
  } catch (e) { console.warn('Нет доступа к камере:', e.name); return null; }
}

function stopLocalVideo() {
  if (localVideoStream) { localVideoStream.getTracks().forEach(t => t.stop()); localVideoStream = null; }
  const lv = document.getElementById('video-local');
  if (lv) { lv.srcObject = null; lv.style.display = 'none'; }
}

function showVideoUI(show) {
  const vc = document.getElementById('call-video-container');
  if (vc) vc.style.display = show ? 'block' : 'none';
  const lv = document.getElementById('video-local');
  if (lv) lv.style.display = show ? 'block' : 'none';
}

document.addEventListener('click', e => {
  if (e.target && e.target.id === 'video-local' && localVideoStream) {
    const ct = localVideoStream.getVideoTracks()[0]; if (!ct) return;
    const settings  = ct.getSettings();
    const newFacing = settings.facingMode === 'user' ? 'environment' : 'user';
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: newFacing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    }).then(async ns => {
      const nt = ns.getVideoTracks()[0];
      if (pcCallPeer) {
        const sender = pcCallPeer.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(nt);
      }
      ct.stop();
      const lv = document.getElementById('video-local');
      if (lv) lv.srcObject = ns;
      localVideoStream = ns;
    }).catch(() => showToast('❌ Ошибка переключения камеры'));
  }
});

if (callBtnVideo) {
  callBtnVideo.addEventListener('click', async () => {
    if (!pcCallActive) { showToast('Сначала установите звонок', 2000); return; }
    if (!pcCallIsVideo) {
      ensureVideoElements();
      const vs = await startLocalVideo();
      if (!vs) { showToast('❌ Нет доступа к камере', 3000); return; }
      pcCallIsVideo = true;
      callBtnVideo.classList.add('active');
      showVideoUI(true);
      if (pcCallPeer) {
        const vt = vs.getVideoTracks()[0];
        if (vt) {
          try {
            const existing = pcCallPeer.getSenders().find(s => s.track?.kind === 'video');
            if (existing) await existing.replaceTrack(vt);
            else pcCallPeer.addTrack(vt, localVideoStream);
            showToast('📷 Видео включено', 2000);
          } catch (e) { showToast('⚠️ Не удалось добавить видео', 3000); }
        }
      }
    } else {
      pcCallIsVideo = false;
      callBtnVideo.classList.remove('active');
      showVideoUI(false);
      if (pcCallPeer) {
        const vs = pcCallPeer.getSenders().find(s => s.track?.kind === 'video');
        if (vs) { vs.track?.stop(); try { await vs.replaceTrack(null); } catch (_) {} }
      }
      stopLocalVideo();
      showToast('📷 Видео выключено', 2000);
    }
  });
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
let pcCallActive         = false;
let incomingCallData     = null;
let pcIceCandidateBuffer = [];
let callTimer            = null;
let callSeconds          = 0;

let callControlsHideTimer = null;
let callControlsVisible   = true;

function showCallControls() {
  callControlsVisible = true;
  const bottom = callScreen?.querySelector('.call-screen-bottom');
  const top    = callScreen?.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s' });
  if (top)    Object.assign(top.style,    { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s' });
  clearTimeout(callControlsHideTimer);
  if (pcCallIsVideo) {
    callControlsHideTimer = setTimeout(hideCallControls, 4000);
  }
}

function hideCallControls() {
  if (!pcCallIsVideo) return;
  callControlsVisible = false;
  const bottom = callScreen?.querySelector('.call-screen-bottom');
  const top    = callScreen?.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'0', pointerEvents:'none', transform:'translateY(80px)', transition:'opacity 0.3s, transform 0.3s' });
  if (top)    Object.assign(top.style,    { opacity:'0', pointerEvents:'none', transform:'translateY(-60px)', transition:'opacity 0.3s, transform 0.3s' });
}

if (callScreen) {
  callScreen.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (pcCallIsVideo) {
      if (callControlsVisible) hideCallControls();
      else showCallControls();
    }
  });
}

function showCallScreen(name, avatar, status, isVideo) {
  if (!callScreen) return;
  if (callScreenName)   callScreenName.textContent   = name || '—';
  if (callScreenStatus) callScreenStatus.textContent = status || 'Соединение…';
  if (callScreenAvatar) {
    if (avatar) callScreenAvatar.innerHTML = `<img src="${avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    else        callScreenAvatar.textContent = '👤';
  }
  const center = callScreen.querySelector('.call-screen-center');
  if (center) {
    center.style.display  = isVideo ? 'none' : 'flex';
    center.style.position = 'relative';
    center.style.zIndex   = '1000';
  }
  if (callBtnMute) { callBtnMute.classList.remove('active'); callBtnMute.textContent = '🎤'; }
  setSpeakerOutput(isVideo);
  callScreen.classList.add('active');
  callScreen.classList.remove('minimizing');
  hideCallMiniBar();
  const bottom = callScreen.querySelector('.call-screen-bottom');
  const top    = callScreen.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s', position:'relative', zIndex:'1001' });
  if (top)    Object.assign(top.style,    { opacity:'1', pointerEvents:'all', transform:'translateY(0)', transition:'opacity 0.3s, transform 0.3s', position:'relative', zIndex:'1001' });
  callControlsVisible = true;
  clearTimeout(callControlsHideTimer);
  if (isVideo) {
    ensureVideoElements();
    ensureLocalVideo();
    showVideoUI(true);
    startLocalVideo().then(s => {
      if (s && callBtnVideo) { callBtnVideo.classList.add('active'); pcCallIsVideo = true; }
      callControlsHideTimer = setTimeout(hideCallControls, 4000);
    });
  }
}

function hideCallScreen() {
  if (!callScreen) return;
  clearTimeout(callControlsHideTimer);
  callScreen.classList.add('minimizing');
  callScreen.addEventListener('animationend', () => {
    callScreen.classList.remove('active');
    callScreen.classList.remove('minimizing');
  }, { once: true });
  stopCallTimer();
  if (pcCallActive) {
    const img = callScreenAvatar?.querySelector('img');
    showCallMiniBar(pcCallRemoteNick, img ? img.src : null);
    updateCallMiniStatus(callScreenStatus?.textContent || 'Звонок…');
  }
}

function setCallStatus(text) {
  if (text && callScreenStatus) callScreenStatus.textContent = text;
  if (pcCallActive) updateCallMiniStatus(text);
}

function startCallTimer() {
  callSeconds = 0; stopCallTimer();
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    const ts = m + ':' + s;
    if (callScreenStatus) callScreenStatus.textContent = ts;
    if (callStatusDot) { callStatusDot.style.animation = 'none'; callStatusDot.style.background = '#4caf50'; }
    updateCallMiniStatus(ts);
  }, 1000);
}
function stopCallTimer() {
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
}

if (callBtnMute) callBtnMute.addEventListener('click', () => {
  pcCallMuted = !pcCallMuted;
  if (pcCallStream) pcCallStream.getAudioTracks().forEach(t => { t.enabled = !pcCallMuted; });
  if (pcCallMuted) { callBtnMute.classList.add('active'); callBtnMute.textContent = '🔇'; }
  else             { callBtnMute.classList.remove('active'); callBtnMute.textContent = '🎤'; }
  if (pcCallIsVideo) showCallControls();
});

if (callBtnHangup)   callBtnHangup.addEventListener('click',  () => { endPrivateCall(true); });
if (btnCallMinimize) btnCallMinimize.addEventListener('click', () => hideCallScreen());
$('call-mini-hangup')?.addEventListener('click', e => { e.stopPropagation(); endPrivateCall(true); });

if (btnPrivateCall) btnPrivateCall.addEventListener('click', async () => {
  if (pcCallActive) {
    const withAvatar = chatRoomAvatar?.querySelector('img')?.src || null;
    showCallScreen(pcCallRemoteNick, withAvatar, callScreenStatus?.textContent || null, pcCallIsVideo);
    return;
  }
  if (currentChatType !== 'private' || !currentChatId) return;
  openCallTypeSelector();
});

function openCallTypeSelector() {
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  sheet.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2)">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:20px">📞 Позвонить</div>
      <div style="display:flex;gap:16px;justify-content:center;margin-bottom:20px">
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
          <button id="call-audio-btn" style="width:72px;height:72px;border-radius:50%;border:none;background:linear-gradient(135deg,#1e8449,#145a32);color:white;font-size:30px;cursor:pointer;box-shadow:0 4px 20px rgba(30,132,73,0.45)">📞</button>
          <span style="font-size:13px;color:var(--sub)">Аудио</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
          <button id="call-video-btn-sel" style="width:72px;height:72px;border-radius:50%;border:none;background:linear-gradient(135deg,#7c5cbf,#5b3fa0);color:white;font-size:30px;cursor:pointer;box-shadow:0 4px 20px rgba(124,92,191,0.45)">📹</button>
          <span style="font-size:13px;color:var(--sub)">Видео</span>
        </div>
      </div>
      <button id="call-cancel-btn" style="width:100%;padding:14px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  sheet.querySelector('#call-cancel-btn').addEventListener('click', close);
  sheet.querySelector('#call-audio-btn').addEventListener('click', () => { close(); startPrivateCall(false); });
  sheet.querySelector('#call-video-btn-sel').addEventListener('click', () => { close(); startPrivateCall(true); });
}

async function startPrivateCall(isVideo) {
  pcCallRemoteNick    = chatRoomName ? chatRoomName.textContent : '?';
  const withAvatar    = chatRoomAvatar?.querySelector('img')?.src || null;
  const parts         = currentChatId.split('::');
  const myLower       = myNickname.toLowerCase();
  pcCallRemoteNickLow = parts.find(p => p !== myLower) || parts[0];
  pcCallRemoteId      = null;
  pcIceCandidateBuffer = [];
  pcCallIsVideo       = isVideo;

  try {
    pcCallStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) { showToast('❌ Нет доступа к микрофону'); return; }

  // ─── Создаём peer и сразу добавляем аудио треки ───
  pcCallPeer = createPrivateCallPeer(pcCallRemoteNickLow, true, isVideo);
  pcCallStream.getAudioTracks().forEach(t => {
    try { pcCallPeer.addTrack(t, pcCallStream); } catch(_) {}
  });

  if (isVideo) {
    ensureVideoElements();
    const vs = await startLocalVideo();
    if (vs && pcCallPeer) {
      const vt = vs.getVideoTracks()[0];
      if (vt) {
        try { pcCallPeer.addTrack(vt, vs); } catch(_) {}
      }
    }
  }

  playDialTone();
  showCallScreen(pcCallRemoteNick, withAvatar, isVideo ? '📹 Видеовызов…' : '📞 Вызов…', isVideo);
}

socket.on('private-call-offer', async data => {
  if (pcCallActive) { socket.emit('private-call-reject', { to: data.from }); return; }
  incomingCallData = data;
  if (incomingCallAvatar) {
    if (data.fromAvatar) incomingCallAvatar.innerHTML = `<img src="${data.fromAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else incomingCallAvatar.textContent = '👤';
  }
  if (incomingCallName) incomingCallName.textContent = data.fromNick || '?';
  const subEl = $('incoming-call-sub');
  if (subEl) subEl.textContent = data.isVideo ? '📹 Видеозвонок…' : '📞 Голосовой вызов…';
  if (modalIncomingCall) modalIncomingCall.classList.add('open');
  playIncomingRing();
  showBrowserNotif(data.isVideo ? '📹 Входящий видеозвонок' : '📞 Входящий звонок', (data.fromNick || '?') + ' звонит вам', 'call');
});

if (btnCallAccept) btnCallAccept.addEventListener('click', async () => {
  if (modalIncomingCall) modalIncomingCall.classList.remove('open');
  stopIncomingRing();
  if (!incomingCallData) return;

  const data    = incomingCallData;
  const isVideo = data.isVideo || false;
  pcCallIsVideo = isVideo;

  try {
    pcCallStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    showToast('❌ Нет доступа к микрофону');
    socket.emit('private-call-reject', { to: data.from });
    incomingCallData = null; return;
  }

  pcCallRemoteId      = data.from;
  pcCallRemoteNickLow = data.fromNickLower || data.fromNick?.toLowerCase();
  pcCallRemoteNick    = data.fromNick || '?';

  // ─── Создаём peer (НЕ initiator) ───
  pcCallPeer = createPrivateCallPeer(pcCallRemoteId, false, isVideo);

  // ─── Добавляем аудио треки ПЕРЕД setRemoteDescription ───
  pcCallStream.getAudioTracks().forEach(t => {
    try { pcCallPeer.addTrack(t, pcCallStream); } catch(_) {}
  });

  try {
    await pcCallPeer.setRemoteDescription(new RTCSessionDescription(data.offer));
  } catch (e) {
    console.error('setRemoteDescription error:', e);
    showToast('❌ Ошибка установки соединения');
    endPrivateCall(false); return;
  }

  // ─── Добавляем буферизованные ICE кандидаты после setRemoteDescription ───
  for (const c of pcIceCandidateBuffer) {
    try { await pcCallPeer.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
  }
  pcIceCandidateBuffer = [];

  // Если видео — добавляем видео трек
  if (isVideo) {
    ensureVideoElements();
    const vs = await startLocalVideo();
    if (vs && pcCallPeer) {
      const vt = vs.getVideoTracks()[0];
      if (vt) {
        try { pcCallPeer.addTrack(vt, vs); } catch(_) {}
      }
    }
  }

  let answer;
  try {
    answer = await pcCallPeer.createAnswer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: isVideo
    });
    await pcCallPeer.setLocalDescription(answer);
  } catch (e) {
    console.error('createAnswer error:', e);
    showToast('❌ Ошибка ответа на звонок');
    endPrivateCall(false); return;
  }

  socket.emit('private-call-answer', { to: pcCallRemoteId, answer });
  pcCallActive = true;
  showCallScreen(pcCallRemoteNick, data.fromAvatar || null, 'Соединение…', isVideo);

  if (currentChatId !== data.chatId) {
    socket.emit('private-chat-open', { withNickname: data.fromNick }, res => {
      if (res.ok) enterPrivateChat(res.chatId, res.withNickname, res.withAvatar);
    });
  }
  incomingCallData = null;
});

if (btnCallReject) btnCallReject.addEventListener('click', () => {
  if (modalIncomingCall) modalIncomingCall.classList.remove('open');
  stopIncomingRing();
  if (incomingCallData) {
    socket.emit('private-call-reject', { to: incomingCallData.from });
    incomingCallData = null;
  }
});

socket.on('private-call-answer', async ({ from, answer }) => {
  if (!pcCallPeer) return;
  pcCallRemoteId = from;
  stopDialTone();

  if (pcCallPeer.signalingState !== 'have-local-offer') {
    console.warn('Unexpected signalingState on answer:', pcCallPeer.signalingState);
    return;
  }
  try {
    await pcCallPeer.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (e) {
    console.error('setRemoteDescription (answer) error:', e);
    showToast('❌ Ошибка установки соединения', 3000);
    endPrivateCall(false); return;
  }

  // ─── Отправляем накопленные ICE кандидаты ───
  for (const candidate of pcIceCandidateBuffer) {
    socket.emit('private-call-ice', { to: pcCallRemoteId, candidate });
  }
  pcIceCandidateBuffer = [];
});

socket.on('private-call-ice', async ({ from, candidate }) => {
  if (!candidate) return;
  if (pcCallPeer && pcCallPeer.remoteDescription) {
    try { await pcCallPeer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  } else {
    pcIceCandidateBuffer.push(candidate);
  }
});

socket.on('private-call-ended',    () => { stopDialTone(); showToast('📵 ' + (pcCallRemoteNick || '?') + ' завершил звонок', 3000);  endPrivateCall(false); });
socket.on('private-call-rejected', () => { stopDialTone(); showToast('📵 ' + (pcCallRemoteNick || '?') + ' отклонил звонок', 3000); endPrivateCall(false); });

function endPrivateCall(notify = true) {
  if (notify && (pcCallRemoteId || pcCallRemoteNickLow)) {
    socket.emit('private-call-end', { to: pcCallRemoteId || pcCallRemoteNickLow });
  }
  clearTimeout(callControlsHideTimer);
  stopDialTone(); stopIncomingRing();
  if (pcCallPeer)   { try { pcCallPeer.close(); } catch(_) {} pcCallPeer = null; }
  if (pcCallStream) { pcCallStream.getTracks().forEach(t => t.stop()); pcCallStream = null; }
  stopLocalVideo(); showVideoUI(false); pcCallIsVideo = false;
  const el = document.getElementById('audio-pc-call'); if (el) el.remove();
  const rv = document.getElementById('video-remote');  if (rv) rv.srcObject = null;
  pcCallActive = false; pcCallRemoteId = null; pcCallRemoteNickLow = null;
  pcCallRemoteNick = ''; pcCallMuted = false; isSpeakerMode = false;
  pcIceCandidateBuffer = [];
  if (callScreen) { callScreen.classList.remove('active'); callScreen.classList.remove('minimizing'); }
  hideCallMiniBar();
  if (modalIncomingCall) modalIncomingCall.classList.remove('open');
  stopCallTimer();
  const center = callScreen?.querySelector('.call-screen-center');
  if (center) center.style.display = 'flex';
  const bottom = callScreen?.querySelector('.call-screen-bottom');
  const top    = callScreen?.querySelector('.call-screen-top');
  if (bottom) Object.assign(bottom.style, { opacity:'1', pointerEvents:'all', transform:'', transition:'' });
  if (top)    Object.assign(top.style,    { opacity:'1', pointerEvents:'all', transform:'', transition:'' });
  callControlsVisible = true;
  if (callBtnMute)    { callBtnMute.textContent = '🎤';    callBtnMute.classList.remove('active'); }
  if (callBtnSpeaker) { callBtnSpeaker.textContent = '🔈'; callBtnSpeaker.classList.remove('active'); }
  if (callBtnVideo)   { callBtnVideo.textContent = '📷';   callBtnVideo.classList.remove('active'); }
}

// ─── createPrivateCallPeer ───
function createPrivateCallPeer(targetId, isInitiator, isVideo) {
  const peer = new RTCPeerConnection(iceServers);

  // ─── ИСПРАВЛЕНИЕ: для initiator добавляем transceiver'ы чтобы SDP содержал нужные секции ───
  if (isInitiator) {
    peer.addTransceiver('audio', { direction: 'sendrecv' });
    if (isVideo) {
      peer.addTransceiver('video', { direction: 'sendrecv' });
    }
  }

  // ─── Обработка входящих треков ───
  peer.ontrack = e => {
    const track  = e.track;
    const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([track]);

    console.log('private ontrack:', track.kind, 'readyState:', track.readyState);

    if (track.kind === 'audio') {
      let audio = document.getElementById('audio-pc-call');
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'audio-pc-call';
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
      }
      // ─── КЛЮЧЕВОЕ: всегда обновляем srcObject при получении трека ───
      audio.srcObject = stream;
      audio.volume = isSpeakerMode ? 1.0 : 0.7;
      audio.play().catch(() => {
        // Автовоспроизведение заблокировано — ждём первого касания
        const resume = () => { audio.play().catch(() => {}); document.removeEventListener('click', resume); document.removeEventListener('touchstart', resume); };
        document.addEventListener('click',      resume, { once: true });
        document.addEventListener('touchstart', resume, { once: true });
      });
    }

    if (track.kind === 'video') {
      console.log('Получен видео трек от собеседника');
      ensureVideoElements();
      showVideoUI(true);
      pcCallIsVideo = true;
      if (callBtnVideo) callBtnVideo.classList.add('active');

      const vc = document.getElementById('call-video-container');
      if (vc) vc.style.display = 'block';

      const rv = document.getElementById('video-remote');
      const ns = document.getElementById('video-no-signal');

      if (rv) {
        // Создаём или обновляем remote stream
        let remoteStream = rv.srcObject;
        if (!remoteStream || !(remoteStream instanceof MediaStream)) {
          remoteStream = new MediaStream();
          rv.srcObject = remoteStream;
        }
        // Убираем старые треки того же типа
        remoteStream.getVideoTracks().forEach(t => remoteStream.removeTrack(t));
        remoteStream.addTrack(track);

        // Синхронизируем аудио если есть в том же stream
        if (e.streams[0]) {
          const audioEl = document.getElementById('audio-pc-call');
          if (audioEl) {
            e.streams[0].getAudioTracks().forEach(at => {
              const existing = (audioEl.srcObject instanceof MediaStream) ? audioEl.srcObject : null;
              if (existing && !existing.getAudioTracks().includes(at)) {
                existing.addTrack(at);
              }
            });
          }
        }

        rv.play()
          .then(() => {
            if (ns) ns.style.display = 'none';
            console.log('Видео собеседника воспроизводится');
            const center = callScreen?.querySelector('.call-screen-center');
            if (center) center.style.display = 'none';
            showCallControls();
          })
          .catch(err => {
            console.warn('Ошибка воспроизведения видео:', err);
            const resume = () => { rv.play().catch(() => {}); };
            document.addEventListener('click',      resume, { once: true });
            document.addEventListener('touchstart', resume, { once: true });
          });
      }
    }
  };

  peer.onicecandidate = e => {
    if (!e.candidate) return;
    const target = pcCallRemoteId || targetId;
    if (isInitiator && !pcCallRemoteId) {
      // Буферизуем пока не знаем remote socket id
      pcIceCandidateBuffer.push(e.candidate);
    } else {
      socket.emit('private-call-ice', { to: target, candidate: e.candidate });
    }
  };

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    console.log('Private call connection state:', state);
    if (state === 'connected') {
      stopDialTone();
      pcCallActive = true;
      startCallTimer();
      showToast('🟢 Звонок установлен', 2000);
      setSpeakerOutput(pcCallIsVideo ? true : isSpeakerMode);
      setCallStatus('Соединён');
      if (pcCallIsVideo) showCallControls();
    }
    if (state === 'connecting')   setCallStatus('Соединение…');
    if (state === 'disconnected') {
      setCallStatus('Переподключение…');
      setTimeout(() => {
        if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
          showToast('📵 Соединение прервано', 3000);
          endPrivateCall(false);
        }
      }, 6000);
    }
    if (state === 'failed') {
      showToast('📵 Не удалось соединиться', 3000);
      endPrivateCall(false);
    }
  };

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    console.log('Private ICE state:', s);
    if (s === 'checking')     setCallStatus('Соединение…');
    if (s === 'connected')    { stopDialTone(); setCallStatus('Соединён'); }
    if (s === 'disconnected') setCallStatus('Переподключение…');
    if (s === 'failed')       peer.restartIce();
  };

  if (isInitiator) {
    let offerCreated = false;
    peer.onnegotiationneeded = async () => {
      if (offerCreated) return;
      offerCreated = true;
      try {
        const offer = await peer.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: isVideo
        });
        await peer.setLocalDescription(offer);
        socket.emit('private-call-offer', {
          chatId:  currentChatId,
          to:      pcCallRemoteNickLow,
          offer:   peer.localDescription,
          isVideo: isVideo
        });
      } catch (e) {
        console.error('Private call offer error:', e);
        offerCreated = false;
        showToast('❌ Ошибка при установке звонка', 3000);
        endPrivateCall(false);
      }
    };
  }

  return peer;
}

// ═══════════════════════════════════════════════
//  СТИЛИ (инжектируем динамически)
// ═══════════════════════════════════════════════
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes dlPulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }

    .group-photo-change-btn {
      display:flex; align-items:center; gap:10px; padding:12px 16px;
      border-radius:14px; border:1px solid rgba(124,92,191,0.2);
      background:var(--bg2); color:var(--accent2); font-size:14px;
      cursor:pointer; width:100%; margin-bottom:12px;
    }
    .group-photo-change-btn:active { background:rgba(124,92,191,0.12); }

    .msg-ticks { margin-left:2px; transition:color 0.3s; }

    /* Шкала сигнала — классы */
    .signal-none .bar        { background:rgba(255,255,255,0.1) !important; }
    .signal-excellent .bar   { background:var(--green) !important; }
    .signal-good .bar:nth-child(-n+3) { background:#8bc34a !important; }
    .signal-good .bar:nth-child(4)    { background:rgba(255,255,255,0.1) !important; }
    .signal-fair .bar:nth-child(-n+2) { background:var(--orange) !important; }
    .signal-fair .bar:nth-child(n+3)  { background:rgba(255,255,255,0.1) !important; }
    .signal-poor .bar:nth-child(1)    { background:var(--red) !important; }
    .signal-poor .bar:nth-child(n+2)  { background:rgba(255,255,255,0.1) !important; }

    /* ─── ЭКРАН ЗВОНКА: полноэкранное видео ─── */
    #call-video-container {
      position: fixed !important;
      inset: 0 !important;
      z-index: 998 !important;
      background: #000;
      overflow: hidden;
    }
    #video-remote {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
    }
    #call-screen {
      background: transparent !important;
    }
    #call-screen.active {
      z-index: 999 !important;
    }
    #call-screen .call-screen-top {
      position: fixed !important;
      top: env(safe-area-inset-top, 0) !important;
      left: 0; right: 0;
      z-index: 1001 !important;
      padding: max(env(safe-area-inset-top), 12px) 20px 12px !important;
      background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent) !important;
    }
    #call-screen .call-screen-center {
      position: fixed !important;
      top: 50% !important;
      left: 0; right: 0;
      transform: translateY(-50%) !important;
      z-index: 1001 !important;
      background: none !important;
      padding: 20px !important;
    }
    #call-screen .call-screen-bottom {
      position: fixed !important;
      bottom: 0 !important;
      left: 0; right: 0;
      z-index: 1001 !important;
      padding: 20px 24px max(env(safe-area-inset-bottom), 24px) !important;
      background: linear-gradient(to top, rgba(0,0,0,0.75), transparent) !important;
      border-radius: 0 !important;
    }
    #video-local {
      position: fixed !important;
      top: max(env(safe-area-inset-top, 0px) + 60px, 80px) !important;
      right: 16px !important;
      width: 90px !important;
      height: 130px !important;
      border-radius: 14px !important;
      object-fit: cover !important;
      border: 2px solid rgba(255,255,255,0.4) !important;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6) !important;
      z-index: 1002 !important;
      cursor: pointer !important;
      background: #222 !important;
    }
  `;
  document.head.appendChild(style);
})();
