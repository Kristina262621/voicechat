// ═══════════════════════════════════════════════
//  01-state.js — переменные и initDOM (из app.js)
// ═══════════════════════════════════════════════

// ─── Переменные только для app.js ───
let localStream     = null;
let processedStream = null;
let noiseWorklet    = null;
let peers           = {};
let micEnabled      = true;
let pendingOffers   = [];
let joined          = false;
let audioCtx        = null;
let wakeLock        = null;

const voiceNicknames    = {};
const analysers         = {};
const qualityTimers     = {};
const typingUsers       = {};
let typingTimer         = null;
const ecdhExchanged     = new Set();

let cachedRoomList    = [];
let cachedPrivateList = [];

let voiceRecorder       = null;
let voiceRecordStream   = null;
let voiceRecordChunks   = [];
let voiceRecordSeconds  = 0;
let voiceRecordInterval = null;
let isVoiceRecording    = false;

let isSpeakerMode    = false;
let pcCallIsVideo    = false;
let localVideoStream = null;

const SPEAKING_THRESHOLD  = 20;
const MAX_STORED_MESSAGES = 200;

// ─── Звонки ───
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

// ─── Голосовая запись ───
let currentVoiceAudio = null;
let currentVoiceBtn   = null;

// ─── Звуки звонка ───
let ringInterval     = null;
let ringToneCtx      = null;
let dialToneInterval = null;

// ─── Pending join ───
let pendingJoinRoomMode = 'open';

// ─── Typing ───
let privateChatTypingTimer = null;
let replyToMsg             = null;
let longPressTimer         = null;
let longPressTarget        = null;

// ─── Reactions ───
const clientReactions = new Map();
const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','😡','🔥','👏','🎉','💯'];

// ─── Emoji ───
const EMOJI_LIST = [
  '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇',
  '🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪',
  '😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏',
  '😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕',
  '🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎',
  '🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧',
  '😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫',
  '🥱','😤','😡','😠','🤬','😈','👿','💀','💩','🤡','👹','👺',
  '👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕',
  '💞','💓','💗','💖','💘','💝','💟','👍','👎','👌','✌️','🤞',
  '🤟','🤘','🤙','👋','🤚','🖐️','✋','🖖','👏','🙌','🤲','🤝',
  '🙏','✍️','💪','🔥','⭐','🌟','💫','✨','🎉','🎊','🎁','🎈',
  '🏆','🥇','💎','👑','🔮','🎯','🎲','🎸','🎵','🎶','🎤','🎧'
];

// ─── Таймеры удаления комнат ───
const roomDeleteTimersMap = {};

// ═══════════════════════════════════════════════
//  DOM — ждём загрузки
// ═══════════════════════════════════════════════
let screenAuth, screenLobby, screenMain;
let tabLogin, tabRegister, formLogin, formRegister;
let loginNick, loginPw, loginError, btnLogin, btnShowHint;
let regNick, regPw, regError, btnRegister;
let drawer, drawerOverlay, drawerAvatar, drawerName, drawerNick;
let btnOpenProfile, roomsList, privateList, unifiedList, btnCreateRoom;
let lobbyTabAll, lobbyTabGroups, lobbyTabPrivate;
let chatUnifiedList, chatRoomsList, chatPrivateList;
let chatTabAll, chatTabGroups, chatTabPrivate;
let modalCreate, btnCloseCreate, roomPhotoBtn, roomPhotoInput;
let createRoomName, createRoomPw, btnToggleCreatePw;
let createRoomError, btnSubmitCreate, createAutoDelete, createJoinMode;
let modalRoomPw, btnClosePwModal, pwModalRoomName;
let roomPwInput, btnToggleRoomPw, roomPwError, btnSubmitRoomPw;
let modalProfile, btnCloseProfile, profileAvatarDisplay;
let profileAvatarWrap, profileNameDisplay, profileEditName, profileEditBio;
let btnSaveProfile, friendsListContainer, friendReqContainer;
let friendSearchInput, btnFriendSearch, friendSearchResult, btnLogout, avatarInput;
let modalSettings, btnCloseSettings;
let modalContacts, btnCloseContacts, contactsFriendsList;
let contactsReqList, contactsSearchInput, btnContactsSearch, contactsSearchResult;
let modalMembers, btnCloseMembers, membersModalTitle;
let renameSection, renameInput, btnRenameRoom, renameError, membersListContainer;
let groupSettingsSection, groupAutodelSelect, groupJoinmodeSelect;
let btnSaveGroupSettings, btnDeleteGroup;
let joinRequestsSection, joinRequestsCount, joinRequestsList;
let modalInvite, btnCloseInvite, inviteFriendsList;
let chatRoomAvatar, chatRoomName, chatHeaderInfo, userCount, btnBackLobby;
let btnJoin, btnLeave, btnMic, micStatus, hiddenAudios;
let participantsBox, participantsList, reconnectBanner, keepAliveAudio;
let chatMessages, chatInput, btnSend;
let btnPhoto, btnVideo, btnFile, fileInput;
let lightbox, lightboxContent, lightboxClose, noiseIndicator, btnRoomMembers;
let callScreen, callScreenAvatar, callScreenName, callScreenStatus, callStatusDot;
let callBtnSpeaker, callBtnVideo, callBtnMute, callBtnHangup, btnCallMinimize;
let modalIncomingCall, incomingCallAvatar, incomingCallName;
let btnCallAccept, btnCallReject, btnPrivateCall;
let btnVoiceRecord, voiceRecordTimer, voiceRecordTime;

function initDOM() {
  screenAuth  = $('screen-auth');
  screenLobby = $('screen-lobby');
  screenMain  = $('screen-main');

  tabLogin    = $('tab-login');
  tabRegister = $('tab-register');
  formLogin   = $('form-login');
  formRegister= $('form-register');
  loginNick   = $('login-nick');
  loginPw     = $('login-pw');
  loginError  = $('login-error');
  btnLogin    = $('btn-login');
  btnShowHint = $('btn-show-hint');
  regNick     = $('reg-nick');
  regPw       = $('reg-pw');
  regError    = $('reg-error');
  btnRegister = $('btn-register');

  drawer        = $('drawer');
  drawerOverlay = $('drawer-overlay');
  drawerAvatar  = $('drawer-avatar');
  drawerName    = $('drawer-name');
  drawerNick    = $('drawer-nick');

  btnOpenProfile = $('btn-open-profile');
  roomsList      = $('rooms-list');
  privateList    = $('private-list');
  unifiedList    = $('unified-list');
  btnCreateRoom  = $('btn-create-room');

  lobbyTabAll     = $('lobby-tab-all');
  lobbyTabGroups  = $('lobby-tab-groups');
  lobbyTabPrivate = $('lobby-tab-private');

  chatUnifiedList = $('chat-unified-list');
  chatRoomsList   = $('chat-rooms-list');
  chatPrivateList = $('chat-private-list');
  chatTabAll      = $('chat-tab-all');
  chatTabGroups   = $('chat-tab-groups');
  chatTabPrivate  = $('chat-tab-private');

  modalCreate       = $('modal-create-room');
  btnCloseCreate    = $('btn-close-create');
  roomPhotoBtn      = $('room-photo-btn');
  roomPhotoInput    = $('room-photo-input');
  createRoomName    = $('create-room-name');
  createRoomPw      = $('create-room-pw');
  btnToggleCreatePw = $('btn-toggle-create-pw');
  createRoomError   = $('create-room-error');
  btnSubmitCreate   = $('btn-submit-create');
  createAutoDelete  = $('create-room-autodelete');
  createJoinMode    = $('create-room-joinmode');

  modalRoomPw     = $('modal-room-password');
  btnClosePwModal = $('btn-close-pw-modal');
  pwModalRoomName = $('pw-modal-room-name');
  roomPwInput     = $('room-pw-input');
  btnToggleRoomPw = $('btn-toggle-room-pw');
  roomPwError     = $('room-pw-error');
  btnSubmitRoomPw = $('btn-submit-room-pw');

  modalProfile         = $('modal-profile');
  btnCloseProfile      = $('btn-close-profile');
  profileAvatarDisplay = $('profile-avatar-display');
  profileAvatarWrap    = $('profile-avatar-wrap');
  profileNameDisplay   = $('profile-name-display');
  profileEditName      = $('profile-edit-name');
  profileEditBio       = $('profile-edit-bio');
  btnSaveProfile       = $('btn-save-profile');
  friendsListContainer = $('friends-list-container');
  friendReqContainer   = $('friend-requests-container');
  friendSearchInput    = $('friend-search-input');
  btnFriendSearch      = $('btn-friend-search');
  friendSearchResult   = $('friend-search-result');
  btnLogout            = $('btn-logout');
  avatarInput          = $('avatar-input');

  modalSettings    = $('modal-settings');
  btnCloseSettings = $('btn-close-settings');

  modalContacts        = $('modal-contacts');
  btnCloseContacts     = $('btn-close-contacts');
  contactsFriendsList  = $('contacts-friends-list');
  contactsReqList      = $('contacts-requests-list');
  contactsSearchInput  = $('contacts-search-input');
  btnContactsSearch    = $('btn-contacts-search');
  contactsSearchResult = $('contacts-search-result');

  modalMembers         = $('modal-members');
  btnCloseMembers      = $('btn-close-members');
  membersModalTitle    = $('members-modal-title');
  renameSection        = $('rename-section');
  renameInput          = $('rename-input');
  btnRenameRoom        = $('btn-rename-room');
  renameError          = $('rename-error');
  membersListContainer = $('members-list-container');
  groupSettingsSection = $('group-settings-section');
  groupAutodelSelect   = $('group-autodelete-select');
  groupJoinmodeSelect  = $('group-joinmode-select');
  btnSaveGroupSettings = $('btn-save-group-settings');
  btnDeleteGroup       = $('btn-delete-group');
  joinRequestsSection  = $('join-requests-section');
  joinRequestsCount    = $('join-requests-count');
  joinRequestsList     = $('join-requests-list');

  modalInvite       = $('modal-invite');
  btnCloseInvite    = $('btn-close-invite');
  inviteFriendsList = $('invite-friends-list');

  chatRoomAvatar  = $('chat-room-avatar');
  chatRoomName    = $('chat-room-name');
  chatHeaderInfo  = $('chat-header-info');
  userCount       = $('user-count');
  btnBackLobby    = $('btn-back-lobby');
  btnJoin         = $('btn-join');
  btnLeave        = $('btn-leave');
  btnMic          = $('btn-mic');
  micStatus       = $('mic-status');
  hiddenAudios    = $('hidden-audios');
  participantsBox = $('participants');
  participantsList= $('participants-list');
  reconnectBanner = $('reconnect-banner');
  keepAliveAudio  = $('keep-alive-audio');
  chatMessages    = $('chat-messages');
  chatInput       = $('chat-input');
  btnSend         = $('btn-send');
  btnPhoto        = $('btn-photo');
  btnVideo        = $('btn-video');
  btnFile         = $('btn-file');
  fileInput       = $('file-input');
  lightbox        = $('lightbox');
  lightboxContent = $('lightbox-content');
  lightboxClose   = $('lightbox-close');
  noiseIndicator  = $('noise-indicator');
  btnRoomMembers  = $('btn-room-members');

  callScreen       = $('call-screen');
  callScreenAvatar = $('call-screen-avatar');
  callScreenName   = $('call-screen-name');
  callScreenStatus = $('call-screen-status');
  callStatusDot    = $('call-status-dot');
  callBtnSpeaker   = $('call-btn-speaker');
  callBtnVideo     = $('call-btn-video');
  callBtnMute      = $('call-btn-mute');
  callBtnHangup    = $('call-btn-hangup');
  btnCallMinimize  = $('btn-call-minimize');

  modalIncomingCall  = $('modal-incoming-call');
  incomingCallAvatar = $('incoming-call-avatar');
  incomingCallName   = $('incoming-call-name');
  btnCallAccept      = $('btn-call-accept');
  btnCallReject      = $('btn-call-reject');
  btnPrivateCall     = $('btn-private-call');

  btnVoiceRecord   = $('btn-voice-record');
  voiceRecordTimer = $('voice-record-timer');
  voiceRecordTime  = $('voice-record-time');
}
