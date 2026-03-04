// ═══════════════════════════════════════════════
//  UI.JS — drawer, модалки, нижняя навигация
// ═══════════════════════════════════════════════

// ─── НИЖНЯЯ НАВИГАЦИЯ (как WhatsApp) ───
function initBottomNav() {
  // Удаляем старый drawer-меню (пункты переедут вниз)
  const existingNav = document.getElementById('bottom-nav');
  if (existingNav) return;

  const nav = document.createElement('div');
  nav.id = 'bottom-nav';
  nav.innerHTML = `
    <button class="bn-item active" data-tab="chats">
      <span class="bn-icon">💬</span>
      <span class="bn-label">Чаты</span>
      <span class="bn-badge" id="bn-badge-chats" style="display:none"></span>
    </button>
    <button class="bn-item" data-tab="calls">
      <span class="bn-icon">📞</span>
      <span class="bn-label">Звонки</span>
    </button>
    <button class="bn-item" data-tab="contacts">
      <span class="bn-icon">👥</span>
      <span class="bn-label">Контакты</span>
    </button>
    <button class="bn-item" data-tab="settings">
      <span class="bn-icon">⚙️</span>
      <span class="bn-label">Настройки</span>
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
      if (tab === 'settings') {
        const ms = document.getElementById('modal-settings');
        if (ms) ms.classList.add('open');
      }
    });
  });
}

function showLobbyTab(tab) {
  const ul = document.getElementById('unified-list');
  const rl = document.getElementById('rooms-list');
  const pl = document.getElementById('private-list');
  if (ul) ul.style.display = '';
  if (rl) rl.style.display = 'none';
  if (pl) pl.style.display = 'none';
  if (typeof renderUnifiedList === 'function') renderUnifiedList();
}

// ─── ИНЪЕКЦИЯ СТИЛЕЙ НИЖНЕЙ НАВИГАЦИИ ───
(function injectBottomNavStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* ── Нижняя навигация ── */
    #bottom-nav {
      position: sticky;
      bottom: 0;
      left: 0; right: 0;
      display: flex;
      background: var(--surface);
      border-top: 1px solid var(--divider);
      z-index: 100;
      padding-bottom: env(safe-area-inset-bottom);
      box-shadow: 0 -2px 20px rgba(0,0,0,0.15);
    }
    [data-theme="light"] #bottom-nav {
      background: #ffffff;
      border-top: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 -2px 20px rgba(0,0,0,0.06);
    }
    .bn-item {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 3px; padding: 10px 4px 8px;
      border: none; background: none; cursor: pointer;
      color: var(--sub); position: relative;
      transition: color 0.2s;
      -webkit-tap-highlight-color: transparent;
    }
    .bn-item.active { color: var(--accent2); }
    [data-theme="light"] .bn-item.active { color: #00a884; }
    .bn-icon { font-size: 22px; line-height: 1; }
    .bn-label { font-size: 10px; font-weight: 600; white-space: nowrap; }
    .bn-badge {
      position: absolute; top: 6px; right: calc(50% - 18px);
      background: var(--accent); color: white;
      border-radius: 10px; font-size: 10px; font-weight: 700;
      padding: 1px 5px; min-width: 16px; text-align: center;
    }
    [data-theme="light"] .bn-badge { background: #00a884; }

    /* ── Скрываем старую кнопку лупы в хедере ── */
    #btn-search-chats-old { display: none !important; }

    /* ── Убираем надпись "Чаты" из lobby-header (она есть во вкладках) ── */
    .lobby-header .lobby-header-title { display: none !important; }

    /* ── Строка поиска вверху лобби ── */
    #lobby-search-bar {
      display: flex; align-items: center;
      padding: 8px 12px 6px;
      background: var(--bg);
      border-bottom: 1px solid var(--divider);
      flex-shrink: 0;
    }
    [data-theme="light"] #lobby-search-bar { background: #f0f2f5; }
    #lobby-search-bar input {
      flex: 1; padding: 9px 16px;
      background: var(--surface2);
      border: none; border-radius: 24px;
      color: var(--text); font-size: 15px;
      outline: none; font-family: inherit;
    }
    [data-theme="light"] #lobby-search-bar input {
      background: #ffffff;
    }
    #lobby-search-bar input::placeholder { color: var(--sub); }
    #lobby-search-bar input:focus { outline: none; }

    /* ── Светлая тема — общие улучшения ── */
    [data-theme="light"] .room-card,
    [data-theme="light"] .pc-card {
      background: #ffffff;
      border-color: rgba(0,0,0,0.04);
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    [data-theme="light"] .room-card:active,
    [data-theme="light"] .pc-card:active {
      background: #f5f6f7;
    }
    [data-theme="light"] .msg.theirs {
      background: #ffffff;
      border-color: rgba(0,0,0,0.06);
      color: #111b21;
    }
    [data-theme="light"] .msg.mine {
      background: #d9fdd3;
      border-color: rgba(0,0,0,0.06);
      color: #111b21;
    }
    [data-theme="light"] .msg.mine::after {
      border-bottom-color: #d9fdd3;
    }
    [data-theme="light"] .msg.theirs::before {
      border-bottom-color: #ffffff;
    }
    [data-theme="light"] .tg-header {
      background: rgba(240,242,245,0.97) !important;
    }
    [data-theme="light"] .tg-bottom {
      background: rgba(240,242,245,0.97) !important;
    }
    [data-theme="light"] #chat-input {
      background: #ffffff;
      color: #111b21;
    }
    [data-theme="light"] #chat-messages {
      background: #efeae2;
      background-image: none;
    }
    [data-theme="light"] .auth-card {
      background: #ffffff;
      border-color: rgba(0,0,0,0.08);
    }
    [data-theme="light"] .drawer-header {
      background: linear-gradient(160deg,#00a884 0%,#00856f 100%);
    }
    [data-theme="light"] .modal-sheet {
      background: #ffffff;
    }
    [data-theme="light"] .field-input,
    [data-theme="light"] .field-wrap input,
    [data-theme="light"] .field-wrap textarea,
    [data-theme="light"] .field-wrap select {
      background: #f0f2f5;
      color: #111b21;
      border-color: rgba(0,0,0,0.1);
    }
    [data-theme="light"] .drawer-item { color: #111b21; }
    [data-theme="light"] .drawer-item:hover { background: rgba(0,168,132,0.08); }
    [data-theme="light"] .settings-item { color: #111b21; }
    [data-theme="light"] .lobby-tabs { background: #f0f2f5; }
    [data-theme="light"] .lobby-tab.active { color: #00a884; border-bottom-color: #00a884; }
    [data-theme="light"] .chat-list-section-title { color: #667781; }
    [data-theme="light"] .date-divider {
      background: rgba(225,221,216,0.9);
      color: #667781;
    }
    [data-theme="light"] .btn-primary {
      background: linear-gradient(135deg,#00a884,#00856f);
      box-shadow: 0 4px 20px rgba(0,168,132,0.3);
    }
    [data-theme="light"] #participants {
      background: #ffffff;
    }
    [data-theme="light"] .toast {
      background: rgba(255,255,255,0.98);
      color: #111b21;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
    }
    [data-theme="light"] #reconnect-banner {
      background: rgba(255,235,230,0.9);
    }

    /* ── Скрыть лупу внутри поля поиска ── */
    #search-input::placeholder {
      /* убираем эмодзи лупы из плейсхолдера через JS */
    }
  `;
  document.head.appendChild(style);
})();

// ─── ПОИСКОВАЯ СТРОКА В ЛОББИ (вместо свайпа) ───
function initLobbySearchBar() {
  const lobbySidebar = document.querySelector('.lobby-sidebar');
  const lobbyTabs    = document.querySelector('.lobby-tabs');
  if (!lobbySidebar || !lobbyTabs || document.getElementById('lobby-search-bar')) return;

  const bar = document.createElement('div');
  bar.id = 'lobby-search-bar';
  bar.innerHTML = `
    <input type="text" id="lobby-search-input"
      placeholder="Поиск чатов и пользователей…"
      autocorrect="off" autocapitalize="none" autocomplete="off"/>`;
  lobbySidebar.insertBefore(bar, lobbyTabs);

  let timer = null;
  const input = bar.querySelector('#lobby-search-input');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      renderUnifiedList(); return;
    }
    timer = setTimeout(() => {
      socket.emit('search-chats', { query: q }, res => {
        if (!res.ok) return;
        const ul = document.getElementById('unified-list');
        if (!ul) return;
        let html = '';
        if (res.rooms && res.rooms.length) {
          html += '<div class="chat-list-section-title">👥 Группы</div>';
          html += res.rooms.map(r => `
            <div class="room-card search-result-room" data-id="${r.id}"
                 data-has-pw="${r.hasPassword || false}"
                 data-joinmode="${r.joinMode || 'open'}"
                 data-name="${escapeHtml(r.name)}" style="cursor:pointer;">
              <div class="room-avatar">${r.photo ? `<img src="${escapeHtml(r.photo)}" alt="">` : '🏠'}</div>
              <div class="room-info">
                <div class="room-name">${escapeHtml(r.name)}</div>
                <div class="room-meta">👥 ${r.memberCount} участников</div>
              </div>
            </div>`).join('');
        }
        if (res.users && res.users.length) {
          html += '<div class="chat-list-section-title">👤 Пользователи</div>';
          html += res.users.map(u => `
            <div class="pc-card search-result-user"
                 data-nick="${escapeHtml(u.nickname)}" style="cursor:pointer;">
              <div class="room-avatar">👤</div>
              <div class="room-info">
                <div class="room-name">${escapeHtml(u.nickname)}</div>
                <div class="room-meta">@${escapeHtml(u.lower)}</div>
              </div>
            </div>`).join('');
        }
        if (!html) html = '<div class="rooms-empty"><div class="rooms-empty-icon">🔍</div><div>Ничего не найдено</div></div>';
        ul.innerHTML = html;
        ul.querySelectorAll('.search-result-room').forEach(card => {
          card.addEventListener('click', () => {
            if (typeof joinRoom === 'function') joinRoom(card.dataset.id, '');
          });
        });
        ul.querySelectorAll('.search-result-user').forEach(card => {
          card.addEventListener('click', () => {
            if (typeof openPrivateChatWith === 'function') openPrivateChatWith(card.dataset.nick);
          });
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
  const drawerName   = document.getElementById('drawer-name');
  const drawerNick   = document.getElementById('drawer-nick');
  const drawerAvatar = document.getElementById('drawer-avatar');
  if (drawerName) drawerName.textContent = myNickname || '—';
  if (drawerNick) drawerNick.textContent = myUsername ? '@' + myUsername : (myNickname ? '@' + myNickname.toLowerCase() : '');
  if (!drawerAvatar) return;
  if (myAvatar) drawerAvatar.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else drawerAvatar.textContent = '👤';
}

function updateLobbyAvatarBtn() {
  const btn = document.getElementById('btn-open-profile');
  if (!btn) return;
  if (myAvatar) btn.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
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

// ─── НАСТРОЙКИ УВЕДОМЛЕНИЙ ЧАТА ───
function openChatNotifSettings(chatId, chatName) {
  const current = getNotifSetting(chatId);
  const sheet   = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  sheet.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2);">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:6px">🔔 Уведомления</div>
      <div style="font-size:13px;color:var(--sub);text-align:center;margin-bottom:22px">${escapeHtml(chatName)}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${['all','mute','none'].map(val => {
          const icon  = val === 'all' ? '🔔' : val === 'mute' ? '🔇' : '🔕';
          const title = val === 'all' ? 'Все уведомления' : val === 'mute' ? 'Беззвучно' : 'Выключить';
          const desc  = val === 'all' ? 'Получать все звуки и уведомления' : val === 'mute' ? 'Уведомления без звука' : 'Никаких уведомлений';
          return `<button class="notif-opt" data-val="${val}"
            style="padding:14px 18px;border-radius:14px;border:1.5px solid ${current === val ? 'var(--accent)' : 'rgba(255,255,255,0.07)'};
                   background:${current === val ? 'rgba(124,92,191,0.12)' : 'var(--bg2)'};color:var(--text);font-size:15px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px">
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
      const msgs = { all: '🔔 Уведомления включены', mute: '🔇 Беззвучный режим', none: '🔕 Уведомления выключены' };
      showToast(msgs[btn.dataset.val]);
      if (typeof renderUnifiedList === 'function') renderUnifiedList();
      if (typeof renderUnifiedListInChat === 'function') renderUnifiedListInChat();
      updateNotifButton();
    });
  });
  sheet.querySelector('#notif-close-btn').addEventListener('click', () => sheet.remove());
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
}

// ─── КОНФИДЕНЦИАЛЬНОСТЬ ───
function openPrivacySettings() {
  socket.emit('privacy-get', res => {
    const p = res.ok ? res.privacy : {};
    const sheet = document.createElement('div');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg);overflow-y:auto;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.32s cubic-bezier(0.4,0,0.2,1)';
    sheet.innerHTML = `
      <div style="position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--divider);display:flex;align-items:center;gap:12px;padding:max(env(safe-area-inset-top),14px) 16px 14px;z-index:1">
        <button id="priv-back" style="background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%">←</button>
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
          💡 Если «Время захода» = Никто — другие увидят «был(а) недавно» вместо точного времени.
        </div>
        <div style="height:16px"></div>
        <button id="priv-save" style="width:100%;padding:15px;background:var(--accent-g);color:white;border:none;border-radius:var(--radius-sm);font-size:15px;font-weight:700;cursor:pointer">💾 Сохранить</button>
        <div style="height:30px"></div>
      </div>`;
    document.body.appendChild(sheet);
    requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.transform = 'translateX(0)'; }));
    const close = () => { sheet.style.transform = 'translateX(100%)'; sheet.addEventListener('transitionend', () => sheet.remove(), { once: true }); };
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
    <div style="padding:14px 16px;border-bottom:1px solid var(--divider);display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px"><span style="font-size:20px">${icon}</span><div style="font-size:15px;font-weight:500">${label}</div></div>
      <select class="priv-select" data-key="${key}"
        style="background:var(--bg2);border:1px solid rgba(255,255,255,0.07);border-radius:10px;color:var(--accent2);padding:6px 10px;font-size:14px;outline:none;cursor:pointer">
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
  document.getElementById('drawer-avatar')?.addEventListener('click', () => { closeDrawer(); if (typeof openProfileModal === 'function') openProfileModal(); });
  document.getElementById('dm-profile')?.addEventListener('click',      () => { closeDrawer(); if (typeof openProfileModal === 'function') openProfileModal(); });
  document.getElementById('dm-contacts')?.addEventListener('click',     () => { closeDrawer(); if (typeof openContactsModal === 'function') openContactsModal(); });
  document.getElementById('dm-create-group')?.addEventListener('click', () => { closeDrawer(); if (typeof openCreateRoomModal === 'function') openCreateRoomModal(); });
  document.getElementById('dm-settings')?.addEventListener('click',     () => { closeDrawer(); document.getElementById('modal-settings')?.classList.add('open'); });
  document.getElementById('dm-invite')?.addEventListener('click',       () => { closeDrawer(); showToast('🔗 Поделись ссылкой на сайт!', 4000); });
  document.getElementById('dm-about')?.addEventListener('click',        () => { closeDrawer(); if (typeof openAboutPage === 'function') openAboutPage(); });
  document.getElementById('btn-open-profile')?.addEventListener('click', () => { if (typeof openProfileModal === 'function') openProfileModal(); });

  // Настройки
  document.getElementById('btn-close-settings')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(document.getElementById('modal-settings'));
    else document.getElementById('modal-settings')?.classList.remove('open');
  });
  document.getElementById('settings-go-profile')?.addEventListener('click', () => { document.getElementById('modal-settings')?.classList.remove('open'); if (typeof openProfileModal === 'function') openProfileModal(); });
  document.getElementById('settings-go-privacy')?.addEventListener('click', () => { document.getElementById('modal-settings')?.classList.remove('open'); openPrivacySettings(); });
  document.getElementById('settings-go-notifs')?.addEventListener('click',  () => { requestNotifPermission(); showToast('🔔 Уведомления: ' + (Notification.permission === 'granted' ? 'включены' : 'требуется разрешение')); });
  document.getElementById('settings-go-data')?.addEventListener('click',    () => showToast('💾 Кэш очищен'));
  document.getElementById('settings-go-lang')?.addEventListener('click',    () => showToast('🌐 Язык: Русский'));
  document.getElementById('settings-go-chats')?.addEventListener('click',   () => showToast('💬 Раздел в разработке'));
  document.getElementById('settings-go-about')?.addEventListener('click',   () => { document.getElementById('modal-settings')?.classList.remove('open'); if (typeof openAboutPage === 'function') openAboutPage(); });
  document.getElementById('settings-go-logout')?.addEventListener('click',  () => { if (typeof doLogout === 'function') doLogout(); });

  // Уведомления чата
  document.getElementById('btn-notif-settings')?.addEventListener('click', () => {
    const id   = currentChatType === 'private' ? currentChatId : currentRoomId;
    const name = document.getElementById('chat-room-name')?.textContent || '?';
    if (id) openChatNotifSettings(id, name);
  });

  // Кнопка ⚙️ участников
  document.getElementById('btn-room-members')?.addEventListener('click', () => {
    if (currentChatType === 'group' && currentRoomId && typeof openMembersModal === 'function') openMembersModal();
  });

  // Нижняя навигация
  initBottomNav();

  // Поисковая строка в лобби
  initLobbySearchBar();
}
