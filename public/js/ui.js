// ═══════════════════════════════════════════════
//  UI.JS — drawer, модалки, нижняя навигация
// ═══════════════════════════════════════════════

(function injectUIStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @media (max-width: 767px) {
      #screen-lobby { flex-direction: column !important; }
      .lobby-sidebar {
        width: 100% !important; flex: 1 !important;
        min-height: 0 !important; overflow: hidden !important;
        display: flex !important; flex-direction: column !important;
      }
      .lobby-right { display: none !important; }
      #bottom-nav { flex-shrink: 0 !important; width: 100% !important; }
      .unified-chat-list, .rooms-list {
        flex: 1 !important; min-height: 0 !important;
        overflow-y: auto !important; -webkit-overflow-scrolling: touch !important;
      }
    }

    [data-theme="light"] body { background: #f0f2f5; }
    [data-theme="light"] .room-card,[data-theme="light"] .pc-card {
      background:#ffffff; border-color:rgba(0,0,0,0.04); box-shadow:0 1px 3px rgba(0,0,0,0.04);
    }
    [data-theme="light"] .room-card:active,[data-theme="light"] .pc-card:active { background:#f5f6f7; }
    [data-theme="light"] .msg.theirs { background:#ffffff !important; border-color:rgba(0,0,0,0.06) !important; color:#111b21 !important; }
    [data-theme="light"] .msg.mine   { background:#d9fdd3 !important; border-color:rgba(0,0,0,0.06) !important; color:#111b21 !important; }
    [data-theme="light"] .msg.mine::after   { border-bottom-color:#d9fdd3 !important; }
    [data-theme="light"] .msg.theirs::before{ border-bottom-color:#ffffff !important; }
    [data-theme="light"] .tg-header  { background:rgba(240,242,245,0.97) !important; border-bottom-color:rgba(0,0,0,0.1) !important; }
    [data-theme="light"] .tg-bottom  { background:rgba(240,242,245,0.97) !important; border-top-color:rgba(0,0,0,0.1) !important; }
    [data-theme="light"] #chat-messages { background:#efeae2 !important; background-image:none !important; }
    [data-theme="light"] #chat-input { background:#ffffff !important; color:#111b21 !important; border-color:rgba(0,0,0,0.1) !important; }
    [data-theme="light"] .attach-popup { background:#ffffff !important; border-color:rgba(0,0,0,0.1) !important; }
    [data-theme="light"] .attach-item { color:#111b21 !important; }
    [data-theme="light"] .lobby-header { background:#f0f2f5 !important; border-bottom-color:rgba(0,0,0,0.1) !important; }
    [data-theme="light"] .lobby-tabs  { background:#f0f2f5 !important; border-bottom-color:rgba(0,0,0,0.1) !important; }
    [data-theme="light"] .lobby-tab   { color:#8696a0; }
    [data-theme="light"] .lobby-tab.active { color:#00a884; border-bottom-color:#00a884; }
    [data-theme="light"] #lobby-search-bar { background:#f0f2f5 !important; }
    [data-theme="light"] #lobby-search-bar input { background:#ffffff !important; color:#111b21 !important; }
    [data-theme="light"] .auth-card   { background:#ffffff !important; border-color:rgba(0,0,0,0.08) !important; }
    [data-theme="light"] #screen-auth { background:#f0f2f5 !important; background-image:none !important; }
    [data-theme="light"] .field-input,
    [data-theme="light"] .field-wrap input,
    [data-theme="light"] .field-wrap textarea,
    [data-theme="light"] .field-wrap select {
      background:#f0f2f5 !important; color:#111b21 !important; border-color:rgba(0,0,0,0.1) !important;
    }
    [data-theme="light"] .field-input:focus,
    [data-theme="light"] .field-wrap input:focus,
    [data-theme="light"] .field-wrap textarea:focus {
      border-color:#00a884 !important; box-shadow:0 0 0 3px rgba(0,168,132,0.12) !important;
    }
    [data-theme="light"] .auth-tab { color:#8696a0; }
    [data-theme="light"] .auth-tab.active { color:#00a884; border-bottom-color:#00a884; }
    [data-theme="light"] .btn-primary { background:linear-gradient(135deg,#00a884,#00856f) !important; box-shadow:0 4px 20px rgba(0,168,132,0.3) !important; }
    [data-theme="light"] #btn-send { background:linear-gradient(135deg,#00a884,#00856f) !important; }
    [data-theme="light"] #btn-create-room { background:linear-gradient(135deg,#00a884,#00856f) !important; }
    [data-theme="light"] .user-search-row button { background:linear-gradient(135deg,#00a884,#00856f) !important; }
    [data-theme="light"] .modal-sheet { background:#ffffff !important; }
    [data-theme="light"] .drawer-header { background:linear-gradient(160deg,#00a884 0%,#00856f 100%) !important; }
    [data-theme="light"] .drawer-header .drawer-name { color:#ffffff; }
    [data-theme="light"] .drawer-header .drawer-nick { color:rgba(255,255,255,0.8); }
    [data-theme="light"] #drawer { background:#ffffff !important; }
    [data-theme="light"] .drawer-item { color:#111b21 !important; }
    [data-theme="light"] .drawer-item:hover { background:rgba(0,168,132,0.08) !important; }
    [data-theme="light"] .drawer-theme-btn { background:rgba(0,0,0,0.08) !important; border-color:rgba(0,0,0,0.1) !important; color:#3b4a54 !important; }
    [data-theme="light"] .settings-item { color:#111b21 !important; border-bottom-color:rgba(0,0,0,0.08) !important; }
    [data-theme="light"] .settings-item-icon { background:rgba(0,0,0,0.04) !important; }
    [data-theme="light"] .date-divider { background:rgba(225,221,216,0.9) !important; color:#667781 !important; border-color:transparent !important; }
    [data-theme="light"] #participants { background:#ffffff !important; border-color:rgba(0,0,0,0.06) !important; }
    [data-theme="light"] .toast { background:rgba(255,255,255,0.98) !important; color:#111b21 !important; box-shadow:0 8px 32px rgba(0,0,0,0.15) !important; }
    [data-theme="light"] #bottom-nav {
      background:rgba(255,255,255,0.85) !important;
      backdrop-filter:blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter:blur(20px) saturate(180%) !important;
      border-top:1px solid rgba(0,0,0,0.08) !important;
      box-shadow:0 -2px 20px rgba(0,0,0,0.06) !important;
    }
    [data-theme="light"] .bn-item { color:#8696a0; }
    [data-theme="light"] .bn-item.active { color:#00a884; }
    [data-theme="light"] .bn-badge { background:#00a884; }
    [data-theme="light"] .chat-list-section-title { color:#667781; }
    [data-theme="light"] .room-name { color:#111b21; }
    [data-theme="light"] .room-meta { color:#8696a0; }
    [data-theme="light"] .msg-meta  { color:rgba(0,0,0,0.45) !important; }
    [data-theme="light"] .msg-sender{ color:#00a884 !important; }
    [data-theme="light"] .unified-chat-list,[data-theme="light"] .rooms-list { background:#f0f2f5; }
    [data-theme="light"] .rooms-empty { color:#8696a0; }
    [data-theme="light"] #reconnect-banner { background:rgba(255,59,48,0.1); color:#e05252; }
    [data-theme="light"] #btn-join { background:linear-gradient(135deg,#00a884,#00856f); }
    [data-theme="light"] #btn-mic  { background:rgba(0,0,0,0.07); color:#111b21; border-color:rgba(0,0,0,0.1); }
    [data-theme="light"] .friend-item { border-bottom-color:rgba(0,0,0,0.06); }
    [data-theme="light"] .friend-name,[data-theme="light"] .member-name,
    [data-theme="light"] .profile-name,[data-theme="light"] .modal-title { color:#111b21; }
    [data-theme="light"] .peer-profile-sheet { background:#f0f2f5 !important; }
    [data-theme="light"] .empty-list { color:#8696a0; }

    /* Переключатель темы в настройках */
    .theme-switch-row {
      display:flex; align-items:center; justify-content:space-between;
      padding:16px 0; border-bottom:1px solid var(--divider);
    }
    .theme-switch-left {
      display:flex; align-items:center; gap:14px;
    }
    .theme-switch-icon {
      width:36px; height:36px; border-radius:10px;
      background:rgba(255,255,255,0.05);
      display:flex; align-items:center; justify-content:center;
      font-size:18px; flex-shrink:0;
    }
    [data-theme="light"] .theme-switch-icon { background:rgba(0,0,0,0.04); }
    .theme-switch-label { font-size:15px; font-weight:500; }
    .theme-toggle-track {
      width:50px; height:28px; border-radius:14px;
      background:var(--sub); position:relative;
      cursor:pointer; transition:background 0.25s;
      border:none; flex-shrink:0;
      display:flex; align-items:center; padding:3px;
    }
    .theme-toggle-track.light-on { background:#00a884; }
    .theme-toggle-track.dark-on  { background:#7c5cbf; }
    .theme-toggle-thumb {
      width:22px; height:22px; border-radius:50%;
      background:white; box-shadow:0 1px 4px rgba(0,0,0,0.3);
      transition:transform 0.25s cubic-bezier(0.34,1.2,0.64,1);
      transform:translateX(0);
      pointer-events:none;
    }
    .theme-toggle-track.light-on .theme-toggle-thumb { transform:translateX(22px); }

    #lobby-search-bar {
      display:flex; align-items:center;
      padding:8px 12px 6px;
      background:var(--bg);
      border-bottom:1px solid var(--divider);
      flex-shrink:0;
    }
    #lobby-search-bar input {
      flex:1; padding:9px 16px;
      background:var(--surface2);
      border:none; border-radius:24px;
      color:var(--text); font-size:15px;
      outline:none; font-family:inherit;
    }
    #lobby-search-bar input::placeholder { color:var(--sub); }

    #bottom-nav {
      display:flex; flex-shrink:0; width:100%;
      background:rgba(22,22,31,0.85);
      backdrop-filter:blur(20px) saturate(180%);
      -webkit-backdrop-filter:blur(20px) saturate(180%);
      border-top:1px solid rgba(255,255,255,0.08);
      padding-bottom:env(safe-area-inset-bottom);
      box-shadow:0 -1px 0 rgba(255,255,255,0.04), 0 -8px 32px rgba(0,0,0,0.3);
    }
    .bn-item {
      flex:1; display:flex; flex-direction:column;
      align-items:center; justify-content:center;
      gap:3px; padding:10px 4px 8px;
      border:none; background:none; cursor:pointer;
      color:var(--sub); position:relative;
      transition:color 0.2s;
      -webkit-tap-highlight-color:transparent;
      min-height:52px;
    }
    .bn-item.active { color:var(--accent2); }
    [data-theme="light"] .bn-item.active { color:#00a884; }
    .bn-item:active { opacity:0.7; }
    .bn-icon  { font-size:22px; line-height:1; }
    .bn-label { font-size:10px; font-weight:600; white-space:nowrap; }
    .bn-badge {
      position:absolute; top:6px; right:calc(50% - 18px);
      background:var(--accent); color:white;
      border-radius:10px; font-size:10px; font-weight:700;
      padding:1px 5px; min-width:16px; text-align:center;
    }

    #upload-progress-wrap {
      margin:6px 10px; padding:10px 14px;
      background:var(--surface2); border-radius:14px;
      border:1px solid rgba(124,92,191,0.2);
      box-shadow:0 2px 12px rgba(0,0,0,0.2);
      animation:uploadFadeIn 0.25s cubic-bezier(0.34,1.1,0.64,1);
    }
    [data-theme="light"] #upload-progress-wrap { background:#ffffff; border-color:rgba(0,168,132,0.2); }
    @keyframes uploadFadeIn {
      from{opacity:0;transform:translateY(6px);}
      to{opacity:1;transform:translateY(0);}
    }
    .upload-progress-header { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
    .upload-progress-icon {
      width:32px; height:32px; border-radius:10px;
      background:var(--accent-g);
      display:flex; align-items:center; justify-content:center;
      font-size:16px; flex-shrink:0;
    }
    .upload-progress-info  { flex:1; min-width:0; }
    .upload-progress-name  { font-size:13px; font-weight:600; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .upload-progress-pct   { font-size:11px; color:var(--accent2); margin-top:1px; font-weight:500; }
    .upload-progress-track { height:4px; background:rgba(255,255,255,0.08); border-radius:4px; overflow:hidden; }
    [data-theme="light"] .upload-progress-track { background:rgba(0,0,0,0.08); }
    #upload-progress-fill  {
      height:100%; width:0%;
      background:var(--accent-g); border-radius:4px;
      transition:width 0.2s ease;
    }
    [data-theme="light"] #upload-progress-fill { background:linear-gradient(135deg,#00a884,#00856f); }

    .lobby-header .lobby-header-title { display:none !important; }
    .lobby-sidebar { display:flex; flex-direction:column; }

    body,.tg-header,.tg-bottom,#bottom-nav,
    .room-card,.pc-card,.msg,.modal-sheet,
    #drawer,.lobby-header,.lobby-tabs,
    .auth-card,#chat-messages,#chat-input {
      transition:background 0.25s ease,color 0.15s ease,border-color 0.25s ease;
    }

    @media (max-width:767px) {
      .tg-header { padding-left:8px; padding-right:8px; }
      .tg-input-row { padding:6px 8px 8px; gap:6px; }
      #chat-input { font-size:15px; padding:10px 14px; }
      #btn-send { width:40px; height:40px; }
      .voice-record-btn { width:40px; height:40px; }
      .btn-attach-tg { width:36px; height:36px; font-size:20px; }
      .msg { max-width:88%; font-size:14px; }
      .room-card,.pc-card { padding:10px 12px; }
      .room-avatar { width:48px; height:48px; font-size:20px; }
      .lobby-header { padding:10px 12px; padding-top:max(10px,env(safe-area-inset-top)); }
    }
  `;
  document.head.appendChild(style);
})();

// ─── НИЖНЯЯ НАВИГАЦИЯ ───
function initBottomNav() {
  if (document.getElementById('bottom-nav')) return;
  const nav = document.createElement('div');
  nav.id = 'bottom-nav';
  nav.innerHTML = `
    <button class="bn-item active" data-tab="chats">
      <span class="bn-icon">💬</span><span class="bn-label">Чаты</span>
      <span class="bn-badge" id="bn-badge-chats" style="display:none"></span>
    </button>
    <button class="bn-item" data-tab="calls">
      <span class="bn-icon">📞</span><span class="bn-label">Звонки</span>
    </button>
    <button class="bn-item" data-tab="contacts">
      <span class="bn-icon">👥</span><span class="bn-label">Контакты</span>
    </button>
    <button class="bn-item" data-tab="settings">
      <span class="bn-icon">⚙️</span><span class="bn-label">Настройки</span>
    </button>`;
  const lobby = document.getElementById('screen-lobby');
  if (lobby) lobby.appendChild(nav);
  nav.querySelectorAll('.bn-item').forEach(btn => {
    btn.addEventListener('click', () => {
      nav.querySelectorAll('.bn-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      if (tab === 'chats')    showLobbyTab('chats');
      if (tab === 'calls')    showToast('📞 Звонки — в разработке', 2000);
      if (tab === 'contacts') { if (typeof openContactsModal === 'function') openContactsModal(); }
      if (tab === 'settings') { document.getElementById('modal-settings')?.classList.add('open'); }
    });
  });
}

function showLobbyTab() {
  const ul = document.getElementById('unified-list');
  const rl = document.getElementById('rooms-list');
  const pl = document.getElementById('private-list');
  if (ul) ul.style.display = '';
  if (rl) rl.style.display = 'none';
  if (pl) pl.style.display = 'none';
  if (typeof renderUnifiedList === 'function') renderUnifiedList();
}

// ─── ПОИСКОВАЯ СТРОКА ───
function initLobbySearchBar() {
  const lobbySidebar = document.querySelector('.lobby-sidebar');
  const lobbyTabs    = document.querySelector('.lobby-tabs');
  if (!lobbySidebar || !lobbyTabs || document.getElementById('lobby-search-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'lobby-search-bar';
  bar.innerHTML = `<input type="text" id="lobby-search-input"
    placeholder="🔍 Поиск чатов и пользователей…"
    autocorrect="off" autocapitalize="none" autocomplete="off"/>`;
  lobbySidebar.insertBefore(bar, lobbyTabs);
  let timer = null;
  const input = bar.querySelector('#lobby-search-input');

  // Функция для определения активной вкладки
  function getActiveTabType() {
    const activeTab = document.querySelector('.lobby-tab.active');
    if (!activeTab) return 'all';
    const id = activeTab.id;
    if (id === 'lobby-tab-groups') return 'groups';
    if (id === 'lobby-tab-private') return 'private';
    return 'all'; // lobby-tab-all или по умолчанию
  }

  // Функция для обновления placeholder в зависимости от активной вкладки
  function updateSearchPlaceholder() {
    const type = getActiveTabType();
    const placeholders = {
      all: '🔍 Поиск чатов и пользователей…',
      groups: '🔍 Поиск групп…',
      private: '🔍 Поиск пользователей…'
    };
    input.placeholder = placeholders[type];
  }

  // Инициализируем placeholder
  updateSearchPlaceholder();

  // Обновляем placeholder при переключении вкладок
  const observer = new MutationObserver(updateSearchPlaceholder);
  const tabsContainer = document.querySelector('.lobby-tabs');
  if (tabsContainer) {
    observer.observe(tabsContainer, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      // Если строка поиска пуста, показываем обычный список в зависимости от вкладки
      const type = getActiveTabType();
      if (type === 'groups') {
        if (typeof renderRoomList === 'function') renderRoomList(cachedRoomList, roomsList);
      } else if (type === 'private') {
        if (typeof renderPrivateList === 'function') renderPrivateList(cachedPrivateList, privateList);
      } else {
        if (typeof renderUnifiedList === 'function') renderUnifiedList();
      }
      return;
    }
    timer = setTimeout(() => {
      socket.emit('search-chats', { query: q }, res => {
        if (!res.ok) return;
        const type = getActiveTabType();
        // Определяем, какой список нужно обновить
        let targetList = null;
        if (type === 'groups') targetList = roomsList;
        else if (type === 'private') targetList = privateList;
        else targetList = unifiedList;
        if (!targetList) targetList = unifiedList; // fallback

        let html = '';
        // Фильтруем результаты в зависимости от вкладки
        if (type === 'all' || type === 'groups') {
          if (res.rooms && res.rooms.length) {
            html += '<div class="chat-list-section-title">👥 Группы</div>';
            html += res.rooms.map(r => `
              <div class="room-card search-result-room" data-id="${r.id}"
                   data-has-pw="${r.hasPassword||false}" data-joinmode="${r.joinMode||'open'}"
                   data-name="${escapeHtml(r.name)}" style="cursor:pointer;">
                <div class="room-avatar">${r.photo?`<img src="${escapeHtml(r.photo)}" alt="">`:'🏠'}</div>
                <div class="room-info">
                  <div class="room-name">${escapeHtml(r.name)}</div>
                  <div class="room-meta">👥 ${r.memberCount} участников</div>
                </div>
              </div>`).join('');
          }
        }
        if (type === 'all' || type === 'private') {
          if (res.users && res.users.length) {
            html += '<div class="chat-list-section-title">👤 Пользователи</div>';
            html += res.users.map(u => `
              <div class="pc-card search-result-user" data-nick="${escapeHtml(u.nickname)}" style="cursor:pointer;">
                <div class="room-avatar">👤</div>
                <div class="room-info">
                  <div class="room-name">${escapeHtml(u.nickname)}</div>
                  <div class="room-meta">@${escapeHtml(u.lower)}</div>
                </div>
              </div>`).join('');
          }
        }
        if (!html) html = '<div class="rooms-empty"><div class="rooms-empty-icon">🔍</div><div>Ничего не найдено</div></div>';
        targetList.innerHTML = html;
        targetList.querySelectorAll('.search-result-room').forEach(card => {
          card.addEventListener('click', () => { if (typeof joinRoom === 'function') joinRoom(card.dataset.id, ''); });
        });
        targetList.querySelectorAll('.search-result-user').forEach(card => {
          card.addEventListener('click', () => { if (typeof openPrivateChatWith === 'function') openPrivateChatWith(card.dataset.nick); });
        });
      });
    }, 300);
  });
}

// ─── DRAWER ───
function openDrawer()  {
  document.getElementById('drawer')?.classList.add('open');
  document.getElementById('drawer-overlay')?.classList.add('open');
}
function closeDrawer() {
  document.getElementById('drawer')?.classList.remove('open');
  document.getElementById('drawer-overlay')?.classList.remove('open');
}
function updateDrawer() {
  const dn = document.getElementById('drawer-name');
  const dk = document.getElementById('drawer-nick');
  const da = document.getElementById('drawer-avatar');
  if (dn) dn.textContent = myNickname || '—';
  if (dk) dk.textContent = myUsername ? '@'+myUsername : (myNickname ? '@'+myNickname.toLowerCase() : '');
  if (!da) return;
  if (myAvatar) da.innerHTML = `<img src="${escapeHtml(myAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else da.textContent = '👤';
}
function updateLobbyAvatarBtn() {
  const btn = document.getElementById('btn-open-profile');
  if (!btn) return;
  if (myAvatar) btn.innerHTML = `<img src="${escapeHtml(myAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else btn.textContent = '👤';
  updateDrawer();
}

// ─── ШАПКА ЧАТА ───
function updateHeaderButtons() {
  const isPrivate  = currentChatType === 'private';
  const callBtn    = document.getElementById('btn-private-call');
  const membersBtn = document.getElementById('btn-room-members');
  if (callBtn)    callBtn.style.display    = isPrivate ? 'flex' : 'none';
  if (membersBtn) membersBtn.style.display = isPrivate ? 'none' : 'flex';
}
function getHeaderSubEl() { return document.querySelector('.tg-header-sub'); }
function updateNotifButton() {
  const id  = currentChatType === 'private' ? currentChatId : currentRoomId;
  const btn = document.getElementById('btn-notif-settings');
  if (btn && id) {
    const s = getNotifSetting(id);
    btn.textContent = s === 'all' ? '🔔' : s === 'mute' ? '🔇' : '🔕';
  }
}

// ─── НАСТРОЙКИ УВЕДОМЛЕНИЙ ───
function openChatNotifSettings(chatId, chatName) {
  const current = getNotifSetting(chatId);
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  sheet.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2);">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:6px">🔔 Уведомления</div>
      <div style="font-size:13px;color:var(--sub);text-align:center;margin-bottom:22px">${escapeHtml(chatName)}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${['all','mute','none'].map(val => {
          const icon  = val==='all'?'🔔':val==='mute'?'🔇':'🔕';
          const title = val==='all'?'Все уведомления':val==='mute'?'Беззвучно':'Выключить';
          const desc  = val==='all'?'Получать все звуки и уведомления':val==='mute'?'Уведомления без звука':'Никаких уведомлений';
          return `<button class="notif-opt" data-val="${val}"
            style="padding:14px 18px;border-radius:14px;border:1.5px solid ${current===val?'var(--accent)':'rgba(255,255,255,0.07)'};
                   background:${current===val?'rgba(124,92,191,0.12)':'var(--bg2)'};color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px">
            <span>${icon}</span>
            <div><div style="font-weight:600">${title}</div><div style="font-size:12px;color:var(--sub)">${desc}</div></div>
          </button>`;
        }).join('')}
      </div>
      <button id="notif-close-btn" style="margin-top:16px;width:100%;padding:14px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
    </div>`;
  document.body.appendChild(sheet);
  sheet.querySelectorAll('.notif-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      setNotifSetting(chatId, btn.dataset.val);
      sheet.remove();
      const msgs = { all:'🔔 Уведомления включены', mute:'🔇 Беззвучный режим', none:'🔕 Уведомления выключены' };
      showToast(msgs[btn.dataset.val]);
      if (typeof renderUnifiedList === 'function') renderUnifiedList();
      if (typeof renderUnifiedListInChat === 'function') renderUnifiedListInChat();
      updateNotifButton();
    });
  });
  sheet.querySelector('#notif-close-btn').addEventListener('click', () => sheet.remove());
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
}

// ─── НАСТРОЙКИ ЧАТОВ (с переключателем темы) ───
function openChatSettings() {
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg);overflow-y:auto;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.32s cubic-bezier(0.4,0,0.2,1)';

  // Функция для получения названия и иконки темы
  function getThemeInfo(theme) {
    switch(theme) {
      case 'dark': return { name: 'Тёмная', icon: '🌙', isLight: false };
      case 'light': return { name: 'Светлая', icon: '☀️', isLight: true };
      case 'dark-beautiful': return { name: 'Красивая тёмная', icon: '🌟', isLight: false };
      case 'light-beautiful': return { name: 'Красивая светлая', icon: '✨', isLight: true };
      default: return { name: 'Тёмная', icon: '🌙', isLight: false };
    }
  }

  const themeInfo = getThemeInfo(currentTheme);

  sheet.innerHTML = `
    <div style="position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--divider);
                display:flex;align-items:center;gap:12px;
                padding:max(env(safe-area-inset-top),14px) 16px 14px;z-index:1">
      <button id="chat-settings-back"
        style="background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;
               width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%">←</button>
      <div style="font-size:18px;font-weight:800">💬 Настройки чатов</div>
    </div>
    <div style="padding:16px;max-width:520px;width:100%;margin:0 auto">

      <div style="font-size:11px;color:var(--accent2);font-weight:700;text-transform:uppercase;
                  letter-spacing:1px;padding:16px 4px 8px">Внешний вид</div>

      <div style="background:var(--surface);border-radius:var(--radius);overflow:hidden;
                  border:1px solid rgba(255,255,255,0.04)">

        <!-- ПЕРЕКЛЮЧАТЕЛЬ ТЕМЫ -->
        <div class="theme-switch-row" style="padding:16px;border-bottom:1px solid var(--divider)">
          <div class="theme-switch-left">
            <div class="theme-switch-icon">
              <span id="theme-icon-display">${themeInfo.icon}</span>
            </div>
            <div>
              <div class="theme-switch-label">Тема оформления</div>
              <div style="font-size:12px;color:var(--sub);margin-top:2px" id="theme-name-display">
                ${themeInfo.name}
              </div>
            </div>
          </div>
          <button id="theme-toggle-btn" class="theme-toggle-track ${themeInfo.isLight ? 'light-on' : 'dark-on'}"
            title="Переключить тему" type="button">
            <div class="theme-toggle-thumb"></div>
          </button>
        </div>

        <!-- Другие настройки чатов -->
        <div style="padding:14px 16px;border-bottom:1px solid var(--divider);
                    display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:12px">
            <div class="theme-switch-icon">🔔</div>
            <div style="font-size:15px;font-weight:500">Звуки сообщений</div>
          </div>
          <div style="font-size:13px;color:var(--sub)">Включены</div>
        </div>

        <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:12px">
            <div class="theme-switch-icon">💬</div>
            <div style="font-size:15px;font-weight:500">Размер шрифта</div>
          </div>
          <div style="font-size:13px;color:var(--sub)">Обычный</div>
        </div>

      </div>
      <div style="height:30px"></div>
    </div>`;

  document.body.appendChild(sheet);
  requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.transform = 'translateX(0)'; }));

  const close = () => {
    sheet.style.transform = 'translateX(100%)';
    sheet.addEventListener('transitionend', () => sheet.remove(), { once: true });
  };

  sheet.querySelector('#chat-settings-back').addEventListener('click', close);

  // ── КНОПКА ПЕРЕКЛЮЧЕНИЯ ТЕМЫ ──
  const toggleBtn  = sheet.querySelector('#theme-toggle-btn');
  const iconEl     = sheet.querySelector('#theme-icon-display');
  const nameEl     = sheet.querySelector('#theme-name-display');

  toggleBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    toggleTheme(); // вызываем глобальную функцию из core.js

    // Обновляем UI внутри шторки
    const newThemeInfo = getThemeInfo(currentTheme);
    
    // Обновляем классы кнопки
    if (newThemeInfo.isLight) {
      toggleBtn.classList.add('light-on');
      toggleBtn.classList.remove('dark-on');
    } else {
      toggleBtn.classList.add('dark-on');
      toggleBtn.classList.remove('light-on');
    }
    
    // Обновляем иконку и название
    if (iconEl) iconEl.textContent = newThemeInfo.icon;
    if (nameEl) nameEl.textContent = newThemeInfo.name;
  });

  // свайп назад
  let startX = 0;
  sheet.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  sheet.addEventListener('touchend',   e => { if (e.changedTouches[0].clientX - startX > 80) close(); }, { passive: true });
}

// ─── КОНФИДЕНЦИАЛЬНОСТЬ ───
function openPrivacySettings() {
  socket.emit('privacy-get', res => {
    const p = res.ok ? res.privacy : {};
    const sheet = document.createElement('div');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg);overflow-y:auto;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.32s cubic-bezier(0.4,0,0.2,1)';
    sheet.innerHTML = `
      <div style="position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--divider);
                  display:flex;align-items:center;gap:12px;
                  padding:max(env(safe-area-inset-top),14px) 16px 14px;z-index:1">
        <button id="priv-back"
          style="background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;
                 width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%">←</button>
        <div style="font-size:18px;font-weight:800">🔒 Конфиденциальность</div>
      </div>
      <div style="padding:16px;max-width:520px;width:100%;margin:0 auto">
        <div style="font-size:11px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:16px 4px 8px">Приватность</div>
        <div style="background:var(--surface);border-radius:var(--radius);overflow:hidden;border:1px solid rgba(255,255,255,0.04)">
          ${privacySelect('📞','Номер телефона','phoneVisibility',p.phoneVisibility||'nobody')}
          ${privacySelect('🕐','Время последнего захода','lastSeenVisibility',p.lastSeenVisibility||'nobody')}
          ${privacySelect('🖼','Фото профиля','avatarVisibility',p.avatarVisibility||'all')}
          ${privacySelect('↩️','Пересылка сообщений','forwardVisibility',p.forwardVisibility||'nobody')}
          ${privacySelect('📞','Звонки','callsVisibility',p.callsVisibility||'nobody')}
        </div>
        <div style="font-size:11px;color:var(--sub);padding:8px 4px;line-height:1.6">
          💡 Если «Время захода» = Никто — другие увидят «был(а) недавно».
        </div>
        <div style="height:16px"></div>
        <button id="priv-save"
          style="width:100%;padding:15px;background:var(--accent-g);color:white;border:none;
                 border-radius:var(--radius-sm);font-size:15px;font-weight:700;cursor:pointer">💾 Сохранить</button>
        <div style="height:30px"></div>
      </div>`;
    document.body.appendChild(sheet);
    requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.transform = 'translateX(0)'; }));
    const close = () => { sheet.style.transform='translateX(100%)'; sheet.addEventListener('transitionend',()=>sheet.remove(),{once:true}); };
    sheet.querySelector('#priv-back').addEventListener('click', close);
    sheet.querySelector('#priv-save').addEventListener('click', () => {
      const settings = {};
      sheet.querySelectorAll('.priv-select').forEach(el => { settings[el.dataset.key] = el.value; });
      socket.emit('privacy-update', settings, res => {
        if (res.ok) { showToast('✅ Настройки сохранены'); close(); }
        else showToast('⚠️ Ошибка сохранения');
      });
    });
    let startX = 0;
    sheet.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
    sheet.addEventListener('touchend',   e => { if (e.changedTouches[0].clientX - startX > 80) close(); }, { passive: true });
  });
}

function privacySelect(icon, label, key, value) {
  return `
    <div style="padding:14px 16px;border-bottom:1px solid var(--divider);
                display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:20px">${icon}</span>
        <div style="font-size:15px;font-weight:500">${label}</div>
      </div>
      <select class="priv-select" data-key="${key}"
        style="background:var(--bg2);border:1px solid rgba(255,255,255,0.07);border-radius:10px;
               color:var(--accent2);padding:6px 10px;font-size:14px;outline:none;cursor:pointer">
        <option value="all"      ${value==='all'?'selected':''}>Все</option>
        <option value="contacts" ${value==='contacts'?'selected':''}>Контакты</option>
        <option value="nobody"   ${value==='nobody'?'selected':''}>Никто</option>
      </select>
    </div>`;
}

// ─── ИНИЦИАЛИЗАЦИЯ UI ───
function initUI() {
  // Drawer
  document.getElementById('btn-open-drawer')?.addEventListener('click', openDrawer);
  document.getElementById('btn-open-drawer-chat')?.addEventListener('click', openDrawer);
  document.getElementById('drawer-overlay')?.addEventListener('click', closeDrawer);
  document.getElementById('drawer-avatar')?.addEventListener('click', () => { closeDrawer(); if (typeof openProfileModal==='function') openProfileModal(); });
  document.getElementById('dm-profile')?.addEventListener('click',      () => { closeDrawer(); if (typeof openProfileModal==='function') openProfileModal(); });
  document.getElementById('dm-contacts')?.addEventListener('click',     () => { closeDrawer(); if (typeof openContactsModal==='function') openContactsModal(); });
  document.getElementById('dm-create-group')?.addEventListener('click', () => { closeDrawer(); if (typeof openCreateRoomModal==='function') openCreateRoomModal(); });
  document.getElementById('dm-settings')?.addEventListener('click',     () => { closeDrawer(); document.getElementById('modal-settings')?.classList.add('open'); });
  document.getElementById('dm-invite')?.addEventListener('click',       () => { closeDrawer(); showToast('🔗 Поделись ссылкой на сайт!', 4000); });
  document.getElementById('dm-about')?.addEventListener('click',        () => { closeDrawer(); if (typeof openAboutPage==='function') openAboutPage(); });
  document.getElementById('btn-open-profile')?.addEventListener('click', () => { if (typeof openProfileModal==='function') openProfileModal(); });

  // Убираем старую кнопку темы из drawer — она теперь в настройках чатов
  const oldThemeBtn = document.getElementById('btn-drawer-theme');
  if (oldThemeBtn) oldThemeBtn.style.display = 'none';

  // Настройки
  document.getElementById('btn-close-settings')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(document.getElementById('modal-settings'));
    else document.getElementById('modal-settings')?.classList.remove('open');
  });
  document.getElementById('settings-go-profile')?.addEventListener('click', () => {
    document.getElementById('modal-settings')?.classList.remove('open');
    if (typeof openProfileModal==='function') openProfileModal();
  });
  document.getElementById('settings-go-privacy')?.addEventListener('click', () => {
    document.getElementById('modal-settings')?.classList.remove('open');
    openPrivacySettings();
  });
  document.getElementById('settings-go-notifs')?.addEventListener('click', () => {
    requestNotifPermission();
    showToast('🔔 Уведомления: ' + (Notification.permission==='granted' ? 'включены' : 'требуется разрешение'));
  });
  document.getElementById('settings-go-data')?.addEventListener('click',  () => showToast('💾 Кэш очищен'));
  document.getElementById('settings-go-lang')?.addEventListener('click',  () => showToast('🌐 Язык: Русский'));

  // Переключатель звуков сообщений
  document.getElementById('settings-toggle-sounds')?.addEventListener('click', (e) => {
    e.stopPropagation(); // предотвращаем срабатывание родительского элемента
  });
  document.getElementById('toggle-message-sounds')?.addEventListener('change', function(e) {
    const enabled = this.checked;
    localStorage.setItem('messageSounds', enabled ? '1' : '0');
    showToast(enabled ? '🔊 Звуки сообщений включены' : '🔇 Звуки сообщений выключены');
  });

  // Размер шрифта
  document.getElementById('settings-go-font-size')?.addEventListener('click', () => {
    showToast('🔤 Размер шрифта: можно выбрать маленький, средний или большой');
  });

  // ── Тема и оформление — открывает шторку с переключателем темы ──
  document.getElementById('settings-go-chats')?.addEventListener('click', () => {
    document.getElementById('modal-settings')?.classList.remove('open');
    openChatSettings();
  });

  document.getElementById('settings-go-about')?.addEventListener('click', () => {
    document.getElementById('modal-settings')?.classList.remove('open');
    if (typeof openAboutPage==='function') openAboutPage();
  });
  document.getElementById('settings-go-logout')?.addEventListener('click', () => {
    if (typeof doLogout==='function') doLogout();
  });

  // Уведомления чата
  document.getElementById('btn-notif-settings')?.addEventListener('click', () => {
    const id   = currentChatType==='private' ? currentChatId : currentRoomId;
    const name = document.getElementById('chat-room-name')?.textContent || '?';
    if (id) openChatNotifSettings(id, name);
  });

  // Кнопка участников
  document.getElementById('btn-room-members')?.addEventListener('click', () => {
    if (currentChatType==='group' && currentRoomId && typeof openMembersModal==='function') openMembersModal();
  });

  initBottomNav();
  initLobbySearchBar();
}
