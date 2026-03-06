// ═══════════════════════════════════════════════
//  02-ui-auth-lobby.js — auth, профиль, лобби, комнаты, личные чаты
// ═══════════════════════════════════════════════

// ───────────────────────────────────────────────
//  ПРОФИЛЬ СОБЕСЕДНИКА
// ───────────────────────────────────────────────
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
      <div id="peer-status-hero" style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:4px;position:relative;z-index:1;">был(а) недавно</div>
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
      <div style="padding:14px 0;">
        <div style="font-size:11px;color:var(--sub);margin-bottom:4px">имя пользователя</div>
        <div style="font-size:16px;color:var(--accent2);font-weight:500">@${escapeHtml(peerLower)}</div>
      </div>
      <div id="peer-bio-block" style="display:none;padding:14px 0;border-top:1px solid var(--divider);">
        <div style="font-size:11px;color:var(--sub);margin-bottom:4px">о себе</div>
        <div id="peer-bio-val" style="font-size:15px;color:var(--text);line-height:1.6"></div>
      </div>
    </div>
    <div id="peer-actions-menu" style="display:none;background:var(--surface);border-radius:var(--radius);overflow:hidden;border:1px solid var(--divider);margin:8px 16px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
      <div id="peer-action-add" style="display:flex;align-items:center;gap:14px;padding:15px 16px;border-bottom:1px solid var(--divider);cursor:pointer;"><span style="font-size:20px">➕</span><span style="font-size:15px">Добавить в контакты</span></div>
      <div id="peer-action-block" style="display:flex;align-items:center;gap:14px;padding:15px 16px;border-bottom:1px solid var(--divider);cursor:pointer;"><span style="font-size:20px">🚫</span><span style="font-size:15px">Заблокировать</span></div>
      <div id="peer-action-notif" style="display:flex;align-items:center;gap:14px;padding:15px 16px;border-bottom:1px solid var(--divider);cursor:pointer;"><span style="font-size:20px">🔔</span><span style="font-size:15px">Уведомления</span></div>
      <div id="peer-action-delete" style="display:flex;align-items:center;gap:14px;padding:15px 16px;cursor:pointer;"><span style="font-size:20px">🗑</span><span style="font-size:15px;color:var(--red)">Удалить переписку</span></div>
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
    const statusEl = sheet.querySelector('#peer-status-hero');
    const bioBlock = sheet.querySelector('#peer-bio-block');
    const bioVal   = sheet.querySelector('#peer-bio-val');
    if (statusEl) {
      if (res.online) statusEl.innerHTML = '<span style="color:#3dba6e">● в сети</span>';
      else {
        const privacy = res.privacy || {};
        if (typeof formatLastSeen === 'function') {
          statusEl.textContent = formatLastSeen(null, privacy.lastSeenVisibility || 'nobody');
        }
      }
    }
    if (res.bio && bioBlock && bioVal) {
      bioBlock.style.display = 'block';
      bioVal.textContent = res.bio;
    }
  });

  const toggleMenu = () => {
    const menu = sheet.querySelector('#peer-actions-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  };

  sheet.querySelector('#peer-add-friend-btn')?.addEventListener('click', () => {
    socket.emit('friend-request', { toNickname: nickname }, r => {
      const msgs = {
        already_friends: '✅ Уже в друзьях',
        already_sent: '⏳ Запрос уже отправлен',
        self: '😄 Нельзя',
        not_found: '❌ Не найден'
      };
      showToast(r.ok ? '📨 Запрос отправлен!' : (msgs[r.error] || '⚠️ Ошибка'));
    });
  });

  sheet.querySelector('#peer-action-add')?.addEventListener('click', () => {
    socket.emit('friend-request', { toNickname: nickname }, r => {
      const msgs = {
        already_friends: '✅ Уже в друзьях',
        already_sent: '⏳ Запрос уже отправлен',
        self: '😄 Нельзя',
        not_found: '❌ Не найден'
      };
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
    if (typeof openChatNotifSettings === 'function')
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
    if (typeof openChatNotifSettings === 'function')
      openChatNotifSettings(currentChatId || nickname, nickname);
  });

  let startX = 0;
  sheet.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  sheet.addEventListener('touchmove',  e => {
    const dx = e.touches[0].clientX - startX;
    if (dx > 0) {
      sheet.style.transform = `translateX(${dx}px)`;
      sheet.style.opacity = String(1 - dx/300);
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  sheet.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    sheet.style.transform = '';
    sheet.style.opacity = '';
    if (dx > 80) close();
  }, { passive: true });
}

// ───────────────────────────────────────────────
//  AUTH
// ───────────────────────────────────────────────
function switchTab(tab) {
  if (tab === 'login') {
    tabLogin?.classList.add('active');
    tabRegister?.classList.remove('active');
    if (formLogin) formLogin.style.display = '';
    if (formRegister) formRegister.style.display = 'none';
  } else {
    tabRegister?.classList.add('active');
    tabLogin?.classList.remove('active');
    if (formRegister) formRegister.style.display = '';
    if (formLogin) formLogin.style.display = 'none';
  }
}

function tryAutoLogin() {
  try {
    const token = localStorage.getItem('chat_token');
    if (!token) return;
    const doAuth = () => {
      socket.emit('auth-token', { token }, res => {
        if (res.ok) {
          authToken  = token;
          myNickname = res.nickname;
          myUsername = res.username || res.nickname.toLowerCase();
          myAvatar   = res.avatar || null;
          onAuthSuccess();
        }
      });
    };
    if (socket.connected) doAuth();
    else socket.once('connect', doAuth);
  } catch (_) {}
}

function doLogin() {
  const nick = loginNick?.value.trim();
  const pw   = loginPw?.value;
  if (!nick) { if (loginError) loginError.textContent = 'Введи ник или логин'; return; }
  if (!pw)   { if (loginError) loginError.textContent = 'Введи пароль'; return; }

  if (btnLogin) { btnLogin.disabled = true; btnLogin.textContent = '⏳'; }
  socket.emit('auth-login', { nickname: nick, password: pw }, res => {
    if (btnLogin) { btnLogin.disabled = false; btnLogin.textContent = 'Войти'; }
    if (res.ok) {
      authToken  = res.token;
      myNickname = res.nickname;
      myUsername = res.username || res.nickname.toLowerCase();
      myAvatar   = res.avatar || null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = {
        wrong_creds: '❌ Неверный ник/логин или пароль',
        rate_limited: `⛔ Подождите ${res.secsLeft} сек.`
      };
      if (loginError) loginError.textContent = msgs[res.error] || '⚠️ Ошибка входа';
      if (loginPw) {
        loginPw.style.animation = 'shake 0.35s';
        setTimeout(() => { loginPw.style.animation = ''; }, 400);
      }
    }
  });
}

function doRegister() {
  const nick     = regNick?.value.trim();
  const pw       = regPw?.value;
  const hint     = $('reg-hint')     ? $('reg-hint').value.trim()     : '';
  const phone    = $('reg-phone')    ? $('reg-phone').value.trim()    : '';
  const username = $('reg-username') ? $('reg-username').value.trim() : '';

  if (!nick || nick.length < 2) { if (regError) regError.textContent = 'Ник минимум 2 символа'; return; }
  if (!pw || pw.length < 4)     { if (regError) regError.textContent = 'Пароль минимум 4 символа'; return; }

  if (btnRegister) { btnRegister.disabled = true; btnRegister.textContent = '⏳'; }
  socket.emit('auth-register', { nickname: nick, password: pw, hint, phone, username }, res => {
    if (btnRegister) { btnRegister.disabled = false; btnRegister.textContent = 'Создать аккаунт'; }
    if (res.ok) {
      authToken  = res.token;
      myNickname = res.nickname;
      myUsername = res.username || res.nickname.toLowerCase();
      myAvatar   = null;
      try { localStorage.setItem('chat_token', authToken); } catch (_) {}
      onAuthSuccess();
    } else {
      const msgs = {
        nick_taken: '❌ Ник занят',
        username_taken: '❌ Логин занят',
        nick_short: '❌ Ник слишком короткий',
        pw_short: '❌ Пароль слишком короткий'
      };
      if (regError) regError.textContent = msgs[res.error] || '⚠️ Ошибка';
    }
  });
}

function doLogout() {
  socket.emit('auth-logout', { token: authToken }, () => {});
  try { localStorage.removeItem('chat_token'); } catch (_) {}
  authToken = null; myNickname = ''; myUsername = ''; myAvatar = null;
  modalProfile?.classList.remove('open');
  modalSettings?.classList.remove('open');
  showScreen('auth');
}

function onAuthSuccess() {
  socket.emit('set-nickname', myNickname, () => {});
  updateLobbyAvatarBtn();
  showScreen('lobby');
  renderUnifiedList();
  loadPrivateChatsList();
  requestNotifPermission();

  // SECURITY: получаем временные ICE/TURN credentials с backend
  if (typeof refreshIceServers === 'function') {
    refreshIceServers().catch(() => {});
  }

  if (typeof applyTheme === 'function') applyTheme(currentTheme);
  if (typeof initUI === 'function') initUI();
  if (typeof checkInviteFromUrl === 'function') checkInviteFromUrl();
}

// ───────────────────────────────────────────────
//  LOBBY AVATAR BTN
// ───────────────────────────────────────────────
function updateLobbyAvatarBtn() {
  const btn = $('btn-open-profile');
  if (!btn) return;
  if (myAvatar) btn.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else btn.textContent = '👤';

  const da = $('drawer-avatar');
  const dn = $('drawer-name');
  const dk = $('drawer-nick');
  if (da) {
    if (myAvatar) da.innerHTML = `<img src="${myAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    else da.textContent = '👤';
  }
  if (dn) dn.textContent = myNickname || '—';
  if (dk) dk.textContent = myUsername ? '@' + myUsername : '';
}

// ───────────────────────────────────────────────
//  HEADER HELPERS
// ───────────────────────────────────────────────
function updateHeaderButtons() {
  const isPrivate = currentChatType === 'private';
  const callBtn    = $('btn-private-call');
  const membersBtn = $('btn-room-members');
  if (callBtn) callBtn.style.display = isPrivate ? 'flex' : 'none';
  if (membersBtn) membersBtn.style.display = isPrivate ? 'none' : 'flex';
}
function getHeaderSubEl() { return document.querySelector('.tg-header-sub'); }
function updateCallButton() {
  const btn = $('btn-private-call');
  if (btn) btn.style.display = currentChatType === 'private' ? 'flex' : 'none';
}
function updateNotifButton() {
  const id = currentChatType === 'private' ? currentChatId : currentRoomId;
  const btn = $('btn-notif-settings');
  if (btn && id) {
    const s = getNotifSetting(id);
    btn.textContent = s === 'all' ? '🔔' : s === 'mute' ? '🔇' : '🔕';
  }
}

// ───────────────────────────────────────────────
//  КНОПКА "+" — меню нового чата
// ───────────────────────────────────────────────
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
    if (dy > 0) { inner.style.transform = `translateY(${dy}px)`; inner.style.opacity = String(1 - dy/300); }
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
    if (!res.ok || !res.friends.length) {
      showToast('😔 Нет друзей. Сначала добавь кого-нибудь!', 4000);
      return;
    }
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
      if (!res.ok) {
        result.innerHTML = '<div style="text-align:center;color:var(--sub);padding:16px">❌ Не найден</div>';
        return;
      }
      result.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg2);border-radius:14px;border:1px solid rgba(255,255,255,0.06)">
          <div style="width:42px;height:42px;border-radius:50%;background:var(--accent-g);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
            ${res.avatar ? `<img src="${escapeHtml(res.avatar)}" style="width:100%;height:100%;object-fit:cover">` : '👤'}
          </div>
          <div style="flex:1"><div style="font-weight:600">${escapeHtml(res.nickname)}</div>${res.bio ? `<div style="font-size:12px;color:var(--sub)">${escapeHtml(res.bio)}</div>` : ''}</div>
          <button id="us-open-chat" style="padding:10px 16px;border:none;border-radius:12px;background:var(--accent-g);color:white;font-size:13px;font-weight:700;cursor:pointer">Написать</button>
        </div>`;
      result.querySelector('#us-open-chat').addEventListener('click', () => {
        close();
        openPrivateChatWith(res.nickname);
      });
    });
  };

  sheet.querySelector('#us-search-btn').addEventListener('click', doSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  setTimeout(() => input.focus(), 200);
}

// ───────────────────────────────────────────────
//  ВКЛАДКИ ЛОББИ
// ───────────────────────────────────────────────
function initLobbyTabs() {
  lobbyTabAll?.addEventListener('click', () => {
    [lobbyTabAll, lobbyTabGroups, lobbyTabPrivate].forEach(t => t?.classList.remove('active'));
    lobbyTabAll.classList.add('active');
    if (unifiedList) unifiedList.style.display = '';
    if (roomsList) roomsList.style.display = 'none';
    if (privateList) privateList.style.display = 'none';
    renderUnifiedList();
  });

  lobbyTabGroups?.addEventListener('click', () => {
    [lobbyTabAll, lobbyTabGroups, lobbyTabPrivate].forEach(t => t?.classList.remove('active'));
    lobbyTabGroups.classList.add('active');
    if (unifiedList) unifiedList.style.display = 'none';
    if (roomsList) roomsList.style.display = '';
    if (privateList) privateList.style.display = 'none';
    renderRoomList(cachedRoomList, roomsList);
  });

  lobbyTabPrivate?.addEventListener('click', () => {
    [lobbyTabAll, lobbyTabGroups, lobbyTabPrivate].forEach(t => t?.classList.remove('active'));
    lobbyTabPrivate.classList.add('active');
    if (unifiedList) unifiedList.style.display = 'none';
    if (roomsList) roomsList.style.display = 'none';
    if (privateList) privateList.style.display = '';
    loadPrivateChatsList(privateList);
  });

  chatTabAll?.addEventListener('click', () => {
    [chatTabAll, chatTabGroups, chatTabPrivate].forEach(t => t?.classList.remove('active'));
    chatTabAll.classList.add('active');
    if (chatUnifiedList) chatUnifiedList.style.display = '';
    if (chatRoomsList) chatRoomsList.style.display = 'none';
    if (chatPrivateList) chatPrivateList.style.display = 'none';
    renderUnifiedListInChat();
  });

  chatTabGroups?.addEventListener('click', () => {
    [chatTabAll, chatTabGroups, chatTabPrivate].forEach(t => t?.classList.remove('active'));
    chatTabGroups.classList.add('active');
    if (chatUnifiedList) chatUnifiedList.style.display = 'none';
    if (chatRoomsList) chatRoomsList.style.display = '';
    if (chatPrivateList) chatPrivateList.style.display = 'none';
    renderRoomListInChat(cachedRoomList);
  });

  chatTabPrivate?.addEventListener('click', () => {
    [chatTabAll, chatTabGroups, chatTabPrivate].forEach(t => t?.classList.remove('active'));
    chatTabPrivate.classList.add('active');
    if (chatUnifiedList) chatUnifiedList.style.display = 'none';
    if (chatRoomsList) chatRoomsList.style.display = 'none';
    if (chatPrivateList) chatPrivateList.style.display = '';
    loadPrivateChatsList(chatPrivateList);
  });
}

// ───────────────────────────────────────────────
//  РЕНДЕР СПИСКОВ
// ───────────────────────────────────────────────
function renderUnifiedList() {
  if (!unifiedList) return;
  const groups   = cachedRoomList || [];
  const privates = cachedPrivateList || [];
  if (!groups.length && !privates.length) {
    unifiedList.innerHTML = `<div class="rooms-empty"><div class="rooms-empty-icon">💬</div><div>Нет чатов.<br>Нажми + чтобы начать!</div></div>`;
    return;
  }
  let html = '';
  if (groups.length) {
    html += `<div class="chat-list-section-title">👥 Группы</div>`;
    html += groups.map(buildRoomCardHTML).join('');
  }
  if (privates.length) {
    html += `<div class="chat-list-section-title">💬 Личные чаты</div>`;
    html += privates.map(buildPrivateCardHTML).join('');
  }
  unifiedList.innerHTML = html;
  bindRoomCardEvents(unifiedList);
  bindPrivateCardEvents(unifiedList);
}

function renderUnifiedListInChat() {
  if (!chatUnifiedList) return;
  const groups   = cachedRoomList || [];
  const privates = cachedPrivateList || [];
  if (!groups.length && !privates.length) {
    chatUnifiedList.innerHTML = `<div class="rooms-empty" style="padding:20px 10px"><div class="rooms-empty-icon" style="font-size:36px">💬</div><div style="font-size:13px">Нет чатов</div></div>`;
    return;
  }
  let html = '';
  if (groups.length) {
    html += `<div class="chat-list-section-title">👥 Группы</div>`;
    html += groups.map(buildRoomCardSmallHTML).join('');
  }
  if (privates.length) {
    html += `<div class="chat-list-section-title">💬 Личные</div>`;
    html += privates.map(buildPrivateCardSmallHTML).join('');
  }
  chatUnifiedList.innerHTML = html;
  bindRoomCardEvents(chatUnifiedList);
  bindPrivateCardEvents(chatUnifiedList);
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
  const timerHtml = isEmpty
    ? `<span class="room-badge-timer" id="timer-${room.id}">🕐 --:--</span>`
    : `<span>👥 ${room.memberCount}</span>`;
  const joinBadge = room.joinMode === 'approval'
    ? `<span style="color:var(--orange);font-size:11px">📋</span>` : '';
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
  const timeStr = (c.lastMessage && c.lastMessage.timestamp && !isNaN(Number(c.lastMessage.timestamp)))
    ? (typeof formatChatTime === 'function'
        ? formatChatTime(c.lastMessage.timestamp)
        : new Date(Number(c.lastMessage.timestamp)).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}))
    : '';
  const onlineDot = c.online
    ? `<div style="position:absolute;bottom:2px;right:2px;width:10px;height:10px;border-radius:50%;background:var(--green);border:2px solid var(--surface)"></div>`
    : '';
  return `
    <div class="pc-card" data-chatid="${c.chatId}" data-with="${escapeHtml(c.withNickname)}" data-avatar="${escapeHtml(c.withAvatar||'')}">
      <div class="room-avatar" style="position:relative">
        ${c.withAvatar ? `<img src="${escapeHtml(c.withAvatar)}" alt="">` : '👤'}
        ${onlineDot}
      </div>
      <div class="room-info">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div class="room-name">${escapeHtml(c.withNickname)}</div>
          ${timeStr ? `<div style="font-size:11px;color:var(--sub);flex-shrink:0;margin-left:8px">${timeStr}</div>` : ''}
        </div>
        <div class="room-meta">${lastMsgText} ${buildNotifIcon(c.chatId)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${buildUnreadBadge(c.chatId)}<div class="room-arrow">›</div></div>
    </div>`;
}

function buildPrivateCardSmallHTML(c) {
  return `
    <div class="pc-card" style="margin-bottom:4px" data-chatid="${c.chatId}" data-with="${escapeHtml(c.withNickname)}" data-avatar="${escapeHtml(c.withAvatar||'')}">
      <div class="room-avatar" style="width:38px;height:38px;font-size:16px">${c.withAvatar ? `<img src="${escapeHtml(c.withAvatar)}" alt="">` : '👤'}</div>
      <div class="room-info"><div class="room-name" style="font-size:13px">${escapeHtml(c.withNickname)}</div><div class="room-meta" style="font-size:11px">💬 Личный</div></div>
      ${buildUnreadBadge(c.chatId)}
    </div>`;
}

function bindRoomCardEvents(container) {
  container.querySelectorAll('.room-card[data-id]').forEach(card => {
    card.addEventListener('click', () => {
      const joinMode = card.dataset.joinmode;
      if (card.dataset.hasPw === 'true') openRoomPasswordModal(card.dataset.id, card.dataset.name, joinMode);
      else if (joinMode === 'approval') handleApprovalJoin(card.dataset.id, card.dataset.name);
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

// ───────────────────────────────────────────────
//  ПРОФИЛЬ / ДРУЗЬЯ
// ───────────────────────────────────────────────
function openProfileModal() {
  if (!modalProfile) return;
  if (profileNameDisplay) profileNameDisplay.textContent = myNickname;
  if (profileEditName) profileEditName.value = myNickname;
  renderProfileAvatar();
  modalProfile.classList.add('open');
  loadFriends();
  socket.emit('profile-get', res => {
    if (res.ok) {
      if (profileEditBio) profileEditBio.value = res.bio || '';
      const phoneEl = $('profile-edit-phone');
      if (phoneEl) phoneEl.value = res.phone || '';
    }
  });
}

function renderProfileAvatar() {
  if (!profileAvatarDisplay) return;
  if (myAvatar) profileAvatarDisplay.innerHTML = `<img src="${myAvatar}" alt="">`;
  else profileAvatarDisplay.textContent = '👤';
}

function loadFriends() {
  socket.emit('friends-list', res => {
    if (!res.ok) return;
    if (friendsListContainer) renderFriendsList(res.friends, friendsListContainer);
    if (friendReqContainer) renderFriendRequests(res.requests, friendReqContainer);
  });
}

function renderFriendsList(friends, container) {
  if (!container) return;
  if (!friends.length) {
    container.innerHTML = '<div class="empty-list">Друзей пока нет</div>';
    return;
  }
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
  if (!requests.length) {
    container.innerHTML = '<div class="empty-list">Нет входящих запросов</div>';
    return;
  }
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
      socket.emit('friend-respond', { fromNickname: btn.dataset.nick, accept }, res => {
        if (res.ok) {
          loadFriends();
          showToast(accept ? '✅ Добавлен!' : 'Отклонено');
        }
      });
    });
  });
}

function searchUserForFriend(inputEl, resultEl) {
  if (!inputEl || !resultEl) return;
  const nick = inputEl.value.trim().replace(/^@/, '');
  if (!nick) return;
  socket.emit('profile-get-user', { nickname: nick }, res => {
    if (!res.ok) { resultEl.innerHTML = '<div class="empty-list">❌ Не найден</div>'; return; }
    resultEl.innerHTML = `
      <div class="friend-item">
        <div class="friend-avatar">${avatarHtml(res.avatar,'👤')}</div>
        <div class="friend-info">
          <div class="friend-name">${escapeHtml(res.nickname)}</div>
          ${res.bio ? `<div style="font-size:12px;color:var(--sub)">${escapeHtml(res.bio)}</div>` : ''}
        </div>
        <div class="friend-actions"><button class="btn-sm blue" id="btn-add-found-res">➕</button></div>
      </div>`;
    resultEl.querySelector('.btn-sm')?.addEventListener('click', () => {
      socket.emit('friend-request', { toNickname: res.nickname }, r => {
        const msgs = {
          already_friends: '✅ Уже в друзьях',
          already_sent: '⏳ Уже отправлено',
          self: '😄 Нельзя',
          not_found: '❌ Не найден'
        };
        showToast(r.ok ? '📨 Запрос отправлен!' : (msgs[r.error] || '⚠️ Ошибка'));
        if (r.ok) resultEl.innerHTML = '';
      });
    });
  });
}

// ───────────────────────────────────────────────
//  О ПРОЕКТЕ
// ───────────────────────────────────────────────
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
  const close = () => {
    sheet.style.transform = 'translateX(100%)';
    sheet.addEventListener('transitionend', () => sheet.remove(), { once: true });
  };

  sheet.querySelector('#about-back').addEventListener('click', close);
  let startX = 0;
  sheet.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  sheet.addEventListener('touchmove',  e => {
    const dx = e.touches[0].clientX - startX;
    if (dx > 0) { sheet.style.transform = `translateX(${dx}px)`; sheet.style.opacity = String(1 - dx/400); }
  }, { passive: true });
  sheet.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    sheet.style.opacity = '';
    if (dx > 80) close();
    else sheet.style.transform = 'translateX(0)';
  }, { passive: true });
}

// ───────────────────────────────────────────────
//  КОНТАКТЫ
// ───────────────────────────────────────────────
function openContactsModal() {
  if (!modalContacts) return;
  modalContacts.classList.add('open');
  loadContactsFriends();
}
function loadContactsFriends() {
  socket.emit('friends-list', res => {
    if (!res.ok) return;
    const cfl = $('contacts-friends-list');
    const crl = $('contacts-requests-list');
    if (cfl) renderFriendsList(res.friends, cfl);
    if (crl) renderFriendRequests(res.requests, crl);
  });
}

// ───────────────────────────────────────────────
//  ЛИЧНЫЕ ЧАТЫ
// ───────────────────────────────────────────────
function openPrivateChatWith(nickname) {
  closeAllModals();
  socket.emit('private-chat-open', { withNickname: nickname }, res => {
    if (!res.ok) { showToast('❌ Пользователь не найден'); return; }
    enterPrivateChat(res.chatId, res.withNickname, res.withAvatar);
  });
}

function startPrivateTyping() {
  if (!currentChatId || currentChatType !== 'private') return;
  if (privateChatTypingTimer) clearTimeout(privateChatTypingTimer);
  socket.emit('private-typing-start', { chatId: currentChatId });
  privateChatTypingTimer = setTimeout(stopPrivateTyping, 3000);
}
function stopPrivateTyping() {
  if (privateChatTypingTimer) { clearTimeout(privateChatTypingTimer); privateChatTypingTimer = null; }
  if (currentChatId && currentChatType === 'private')
    socket.emit('private-typing-stop', { chatId: currentChatId });
}

async function enterPrivateChat(chatId, withNickname, withAvatar) {
  if (currentRoomId) {
    socket.emit('leave-room');
    if (joined) { socket.emit('voice-leave'); hangUp(); joined = false; }
    currentRoomId = null;
    currentRoomData = null;
  }

  closeAllModals();
  currentChatType = 'private';
  currentChatId   = chatId;
  currentChatWith = withNickname;
  isRoomOwner = false;
  memberCount = 2;
  clearUnread(chatId);
  saveChatState();

  try { await Crypto.deriveKey('', chatId, chatId + '-private-v2'); } catch (e) { console.error(e); }

  if (chatRoomName) chatRoomName.textContent = withNickname;
  if (userCount) userCount.textContent = '2';
  if (chatRoomAvatar) chatRoomAvatar.innerHTML = withAvatar ? `<img src="${escapeHtml(withAvatar)}" alt="">` : '👤';

  if (typeof loadInitialStatus === 'function') loadInitialStatus(withNickname);
  else {
    const subEl = getHeaderSubEl();
    if (subEl) subEl.innerHTML = `<span style="color:var(--sub)">был(а) недавно</span>`;
  }

  clearChat();
  clearAllTyping();

  if (btnJoin) btnJoin.style.display = 'none';
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic) btnMic.style.display = 'none';

  socket.emit('private-chat-join', { chatId });
  showScreen('chat');
  updateNotifButton();
  updateHeaderButtons();

  await loadPrivateChatHistory(chatId);
}

async function loadPrivateChatHistory(chatId) {
  return new Promise(resolve => {
    socket.emit('private-chat-history', { chatId }, async res => {
      if (!res.ok || !res.messages || !res.messages.length) { resolve(); return; }
      const myLower = myNickname.toLowerCase();

      for (const msg of res.messages) {
        const mine = msg.from === myLower;
        if (msg.deletedFor && msg.deletedFor.includes(myLower)) continue;

        if (msg.type === 'voice') {
          const domId = appendMessage({
            id: msg.id, nickname: msg.fromNick, type: 'voice',
            duration: msg.duration || 0, timestamp: msg.timestamp, mine,
            status: 'ok', encrypted: msg.encrypted, iv: msg.iv, mimeType: msg.mimeType,
            msgStatus: mine ? (msg.status || 'sent') : null
          });
          if (msg.id && mine) msgIdToDomId.set(msg.id, domId);
        } else if (msg.type === 'text') {
          try {
            const text = await Crypto.decryptText(msg.encrypted, msg.iv);
            const domId = appendMessage({
              id: msg.id, nickname: msg.fromNick, text, type: 'text',
              timestamp: msg.timestamp, mine, status: 'ok',
              msgStatus: mine ? (msg.status || 'sent') : null,
              edited: msg.edited, replyTo: msg.replyTo || null
            });
            if (msg.id && mine) msgIdToDomId.set(msg.id, domId);
          } catch (_) {
            appendMessage({
              id: msg.id, nickname: msg.fromNick, text: '[зашифровано]',
              type: 'text', timestamp: msg.timestamp, mine, status: 'error'
            });
          }
        } else {
          const domId = appendMessage({
            id: msg.id, nickname: msg.fromNick, type: msg.type,
            fileName: msg.fileName, fileSize: msg.fileSize, mimeType: msg.mimeType,
            timestamp: msg.timestamp, mine, status: 'ok',
            msgStatus: mine ? (msg.status || 'sent') : null
          });
          if (msg.id && mine) msgIdToDomId.set(msg.id, domId);
        }
      }

      markChatAsRead(chatId, res.messages);
      resolve();
    });
  });
}

function markChatAsRead(chatId, messages) {
  if (!messages || !messages.length) return;
  const myLower = myNickname.toLowerCase();
  for (const msg of messages) {
    if (msg.from !== myLower && msg.id && (!msg.readBy || !msg.readBy.includes(myLower))) {
      socket.emit('private-msg-read', { chatId, msgId: msg.id });
    }
  }
}

function loadPrivateChatsList(container) {
  const el = container || privateList;
  socket.emit('private-chat-list', res => {
    cachedPrivateList = res.ok ? (res.chats || []) : [];
    if (el) {
      if (!res.ok || !cachedPrivateList.length) {
        el.innerHTML = `<div class="rooms-empty"><div class="rooms-empty-icon">💬</div><div>Нет личных чатов.<br>Нажми + чтобы начать!</div></div>`;
      } else {
        el.innerHTML = cachedPrivateList.map(buildPrivateCardHTML).join('');
        bindPrivateCardEvents(el);
      }
    }
    if (unifiedList && unifiedList.style.display !== 'none') renderUnifiedList();
    if (chatUnifiedList && chatUnifiedList.style.display !== 'none') renderUnifiedListInChat();
  });
}

// ───────────────────────────────────────────────
//  ROOM LIST SOCKET EVENTS
// ───────────────────────────────────────────────
socket.on('room-list', list => {
  cachedRoomList = list || [];
  renderRoomList(cachedRoomList, roomsList);
  renderRoomListInChat(cachedRoomList);
  if (lobbyTabAll && lobbyTabAll.classList.contains('active')) renderUnifiedList();
  if (chatTabAll && chatTabAll.classList.contains('active')) renderUnifiedListInChat();
});

function clearAllDeleteTimers() {
  for (const id in roomDeleteTimersMap) {
    clearInterval(roomDeleteTimersMap[id]);
    delete roomDeleteTimersMap[id];
  }
}

function renderRoomList(list, container) {
  if (!container) return;
  clearAllDeleteTimers();
  if (!list || !list.length) {
    container.innerHTML = `<div class="rooms-empty"><div class="rooms-empty-icon">🏠</div><div>Групп пока нет.<br>Создай первую!</div></div>`;
    return;
  }
  container.innerHTML = list.map(buildRoomCardHTML).join('');
  list.forEach(room => {
    if (room.memberCount === 0 && room.deleteAt) {
      const el = document.getElementById('timer-' + room.id);
      if (!el) return;
      const tick = () => {
        const left = room.deleteAt - Date.now();
        if (left <= 0) {
          el.textContent = '🕐 00:00';
          clearInterval(roomDeleteTimersMap[room.id]);
          return;
        }
        el.textContent = '🕐 ' + formatCountdown(left);
      };
      tick();
      roomDeleteTimersMap[room.id] = setInterval(tick, 1000);
    }
  });
  bindRoomCardEvents(container);
}

function renderRoomListInChat(list) {
  if (!chatRoomsList) return;
  if (!list || !list.length) {
    chatRoomsList.innerHTML = `<div class="rooms-empty" style="padding:30px 10px"><div class="rooms-empty-icon" style="font-size:36px">🏠</div><div style="font-size:13px">Групп нет</div></div>`;
    return;
  }
  chatRoomsList.innerHTML = list.map(buildRoomCardSmallHTML).join('');
  bindRoomCardEvents(chatRoomsList);
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
    leaveCurrentRoom();
    showScreen('lobby');
  }
});
socket.on('room-settings-changed', ({ roomId }) => {
  if (currentRoomId === roomId) appendSystemMsg('⚙️ Настройки обновлены');
});
socket.on('room-photo-updated', ({ roomId, photo }) => {
  if (currentRoomId === roomId) {
    if (chatRoomAvatar) chatRoomAvatar.innerHTML = photo ? `<img src="${escapeHtml(photo)}" alt="">` : '💬';
    appendSystemMsg('🖼 Фото группы обновлено');
  }
});
socket.on('room-member-left', ({ roomId, nickname }) => {
  if (currentRoomId === roomId) appendSystemMsg(`👋 ${escapeHtml(nickname)} покинул группу`);
});

// ───────────────────────────────────────────────
//  СОЗДАНИЕ КОМНАТЫ / ПАРОЛЬ
// ───────────────────────────────────────────────
function openCreateRoomModal() {
  if (!modalCreate) return;
  if (createRoomName) createRoomName.value = '';
  if (createRoomPw) createRoomPw.value = '';
  if (createRoomError) createRoomError.textContent = '';
  roomPhotoData = null;
  if (createAutoDelete) createAutoDelete.value = 'never';
  if (createJoinMode) createJoinMode.value = 'open';
  if (roomPhotoBtn) roomPhotoBtn.innerHTML = '<span class="cam-icon">📷</span><span>Фото</span>';
  modalCreate.classList.add('open');
  setTimeout(() => { if (createRoomName) createRoomName.focus(); }, 200);
}

function submitCreateRoom() {
  if (!createRoomName) return;
  const name = createRoomName.value.trim();
  if (!name) { if (createRoomError) createRoomError.textContent = 'Введи название'; return; }
  if (btnSubmitCreate) { btnSubmitCreate.disabled = true; btnSubmitCreate.textContent = '⏳'; }

  socket.emit('create-room', {
    name,
    password: createRoomPw ? createRoomPw.value : '',
    photo: roomPhotoData || null,
    autoDelete: createAutoDelete ? createAutoDelete.value : 'never',
    joinMode: createJoinMode ? createJoinMode.value : 'open'
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

function openRoomPasswordModal(roomId, roomName, joinMode) {
  if (!modalRoomPw) return;
  pendingJoinRoom = roomId ? { roomId, roomName } : pendingJoinRoom;
  pendingJoinRoomMode = joinMode || 'open';
  if (pwModalRoomName) pwModalRoomName.textContent = roomName;
  if (roomPwInput) roomPwInput.value = '';
  if (roomPwError) roomPwError.textContent = '';
  modalRoomPw.classList.add('open');
  setTimeout(() => { if (roomPwInput) roomPwInput.focus(); }, 200);
}

function submitRoomPassword() {
  if (!pendingJoinRoom || !roomPwInput) return;
  const pw = roomPwInput.value;
  if (!pw) { if (roomPwError) roomPwError.textContent = 'Введи пароль'; return; }
  if (btnSubmitRoomPw) { btnSubmitRoomPw.disabled = true; btnSubmitRoomPw.textContent = '⏳'; }

  if (pendingJoinRoomMode === 'approval') {
    if (modalRoomPw) modalRoomPw.classList.remove('open');
    if (btnSubmitRoomPw) { btnSubmitRoomPw.disabled = false; btnSubmitRoomPw.textContent = 'Войти в группу'; }
    handleApprovalJoin(pendingJoinRoom.roomId, pendingJoinRoom.roomName, pw);
    pendingJoinRoom = null;
    return;
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

// ───────────────────────────────────────────────
//  ЗАЯВКИ / ВХОД В КОМНАТУ
// ───────────────────────────────────────────────
function handleApprovalJoin(roomId, roomName, _pw) {
  if (!confirm(`📋 Для вступления в «${roomName}» требуется одобрение.\nОтправить заявку?`)) return;
  socket.emit('room-request-join', { roomId }, res => {
    if (res.ok) {
      if (res.autoAccepted) joinRoom(roomId, _pw || '');
      else showToast('📨 Заявка отправлена!', 5000);
    } else if (res.error === 'already_requested') showToast('⏳ Заявка уже отправлена');
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
  if (modalMembers?.classList.contains('open') && currentRoomId === roomId) loadJoinRequests(roomId);
});

function loadJoinRequests(roomId) {
  socket.emit('room-members', { roomId }, res => {
    if (res.ok) renderJoinRequests(res.pendingRequests || [], roomId);
  });
}

function renderJoinRequests(requests, roomId) {
  const count = requests.length;
  if (joinRequestsCount) joinRequestsCount.textContent = count ? `(${count})` : '';
  if (!joinRequestsList) return;

  if (!count) { joinRequestsList.innerHTML = '<div class="empty-list">Нет заявок</div>'; return; }

  joinRequestsList.innerHTML = requests.map(r => `
    <div class="request-item">
      <div class="friend-avatar">${avatarHtml(r.avatar,'👤')}</div>
      <div class="friend-info"><div class="friend-name">${escapeHtml(r.nickname)}</div></div>
      <div class="friend-actions">
        <button class="btn-sm green" data-action="accept" data-nick="${r.nickLower}">✓ Принять</button>
        <button class="btn-sm red" data-action="decline" data-nick="${r.nickLower}">✕</button>
      </div>
    </div>`).join('');

  joinRequestsList.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const accept = btn.dataset.action === 'accept';
      socket.emit('room-request-respond', {
        roomId, nickLower: btn.dataset.nick, accept
      }, res => {
        if (res.ok) {
          showToast(accept ? '✅ Принята' : 'Отклонено');
          loadJoinRequests(roomId);
        }
      });
    });
  });
}

function joinRoom(roomId, password, cb) {
  socket.emit('join-room', { roomId, password }, async res => {
    if (res?.ok) {
      currentRoomId   = roomId;
      currentRoomData = res.room;
      currentPassword = password || '';
      currentChatType = 'group';
      currentChatId   = null;
      currentChatWith = null;
      isRoomOwner     = res.room.isOwner || false;
      clearUnread(roomId);
      saveChatState();

      const roomSalt = res.room.roomSalt || (roomId + '-default-salt');
      await Crypto.deriveKey(password, roomId, roomSalt);
      await Crypto.generateEcdhKeyPair();
      outgoingSeq = 0;

      if (chatRoomName) chatRoomName.textContent = res.room.name;
      if (userCount) userCount.textContent = res.room.members.length + 1;
      memberCount = res.room.members.length + 1;
      if (chatRoomAvatar) chatRoomAvatar.innerHTML = res.room.photo ? `<img src="${escapeHtml(res.room.photo)}" alt="">` : '💬';

      if (btnJoin) btnJoin.style.display = 'block';
      if (btnLeave) btnLeave.style.display = 'none';
      if (btnMic) btnMic.style.display = 'none';

      clearChat();
      clearAllTyping();
      showScreen('chat');
      updateNotifButton();
      updateHeaderButtons();
      showOwnFingerprint();

      socket.emit('room-history', { roomId }, async histRes => {
        if (histRes.ok && histRes.messages && histRes.messages.length) {
          for (const msg of histRes.messages) {
            const mine    = msg.nickname && msg.nickname.toLowerCase() === myNickname.toLowerCase();
            const myLower = myNickname.toLowerCase();
            if (msg.deletedFor && msg.deletedFor.includes(myLower)) continue;

            if (msg.type === 'voice') {
              const domId = appendMessage({
                id: msg.id, nickname: msg.nickname, type: 'voice',
                duration: msg.duration || 0, timestamp: msg.timestamp,
                mine, status: 'ok', encrypted: msg.encrypted, iv: msg.iv, mimeType: msg.mimeType
              });
              if (msg.id && mine) msgIdToDomId.set(msg.id, domId);
            } else if (msg.type === 'text') {
              try {
                const text = await Crypto.decryptText(msg.encrypted, msg.iv);
                const domId = appendMessage({
                  id: msg.id, nickname: msg.nickname, text, type: 'text',
                  timestamp: msg.timestamp, mine, status: 'ok',
                  edited: msg.edited, replyTo: msg.replyTo || null
                });
                if (msg.id && mine) msgIdToDomId.set(msg.id, domId);
              } catch (_) {
                appendMessage({
                  id: msg.id, nickname: msg.nickname, text: '[зашифровано]',
                  type: 'text', timestamp: msg.timestamp, mine, status: 'error'
                });
              }
            } else {
              const domId = appendMessage({
                id: msg.id, nickname: msg.nickname, type: msg.type,
                fileName: msg.fileName, fileSize: msg.fileSize, mimeType: msg.mimeType,
                timestamp: msg.timestamp, mine, status: 'ok'
              });
              if (msg.id && mine) msgIdToDomId.set(msg.id, domId);
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
    const fp = await Crypto.getKeyFingerprint();
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
  msgIdToDomId.clear();
  seqToMsgId.clear();
}

// ───────────────────────────────────────────────
//  УЧАСТНИКИ / НАСТРОЙКИ ГРУППЫ
// ───────────────────────────────────────────────
function openMembersModal() {
  if (!currentRoomId || !modalMembers) return;

  if (renameSection) renameSection.style.display = isRoomOwner ? '' : 'none';
  if (groupSettingsSection) groupSettingsSection.style.display = isRoomOwner ? '' : 'none';
  if (joinRequestsSection) joinRequestsSection.style.display = isRoomOwner ? '' : 'none';
  const gps = $('group-photo-section');
  if (gps) gps.style.display = isRoomOwner ? '' : 'none';

  if (isRoomOwner && currentRoomData) {
    if (renameInput) renameInput.value = currentRoomData.name || '';
    if (groupAutodelSelect) groupAutodelSelect.value = currentRoomData.autoDelete ? String(currentRoomData.autoDelete) : 'never';
    if (groupJoinmodeSelect) groupJoinmodeSelect.value = currentRoomData.joinMode || 'open';
    const ns = $('group-notif-select');
    if (ns) ns.value = getNotifSetting(currentRoomId);
  }

  if (membersListContainer) membersListContainer.innerHTML = '<div class="empty-list">Загрузка…</div>';
  modalMembers.classList.add('open');

  socket.emit('room-members', { roomId: currentRoomId }, res => {
    if (!membersListContainer) return;
    if (!res.ok) { membersListContainer.innerHTML = '<div class="empty-list">Ошибка</div>'; return; }
    if (!res.members.length) { membersListContainer.innerHTML = '<div class="empty-list">Пусто</div>'; return; }

    membersListContainer.innerHTML = res.members.map(m => `
      <div class="member-item">
        <div class="member-avatar">${avatarHtml(m.avatar,'👤')}</div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.nickname)}${m.id === socket.id ? ' (Вы)' : ''}</div>
          ${m.isOwner ? '<div class="member-badge">👑 Создатель</div>' : ''}
        </div>
      </div>`).join('');

    if (isRoomOwner) renderJoinRequests(res.pendingRequests || [], currentRoomId);
  });

  document.getElementById('btn-leave-group-modal-wrap')?.remove();

  if (!isRoomOwner) {
    setTimeout(() => {
      const sheet = modalMembers.querySelector('.modal-sheet');
      if (!sheet || document.getElementById('btn-leave-group-modal-wrap')) return;

      const wrap = document.createElement('div');
      wrap.id = 'btn-leave-group-modal-wrap';
      wrap.style.marginTop = '16px';
      wrap.innerHTML = `<button id="btn-leave-group-modal" class="btn-danger">🚪 Выйти из группы</button>`;
      sheet.appendChild(wrap);

      document.getElementById('btn-leave-group-modal')?.addEventListener('click', () => {
        if (!confirm('Выйти из группы?')) return;
        socket.emit('leave-room-permanent', { roomId: currentRoomId }, res => {
          if (res.ok) {
            if (window._closeModal) window._closeModal(modalMembers);
            else modalMembers.classList.remove('open');
            leaveCurrentRoom();
            showScreen('lobby');
            showToast('✅ Вы вышли из группы');
          } else {
            const msgs = {
              owner_cannot_leave: '❌ Владелец не может выйти. Удалите группу.',
              not_found: '❌ Группа не найдена'
            };
            showToast(msgs[res.error] || '⚠️ Ошибка: ' + (res.error || ''));
          }
        });
      });
    }, 150);
  }

  setTimeout(() => { if (typeof addInviteLinkButton === 'function') addInviteLinkButton(); }, 200);
}

// ───────────────────────────────────────────────
//  ПРИГЛАШЕНИЯ
// ───────────────────────────────────────────────
function openInviteModal() {
  if (!currentRoomId || !modalInvite) return;
  modalInvite.classList.add('open');
  if (inviteFriendsList) inviteFriendsList.innerHTML = '<div class="empty-list">Загрузка…</div>';

  socket.emit('friends-list', res => {
    if (!inviteFriendsList) return;
    if (!res.ok || !res.friends.length) {
      inviteFriendsList.innerHTML = '<div class="empty-list">Нет друзей для приглашения</div>';
      return;
    }
    inviteFriendsList.innerHTML = res.friends.map(f => `
      <div class="friend-item">
        <div class="friend-avatar">${avatarHtml(f.avatar,'👤')}</div>
        <div class="friend-info"><div class="friend-name">${escapeHtml(f.nickname)}</div></div>
        <div class="friend-actions"><button class="btn-sm blue" data-action="invite" data-nick="${escapeHtml(f.nickname)}">Позвать</button></div>
      </div>`).join('');

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

// ───────────────────────────────────────────────
//  НАЗАД / ВЫХОД
// ───────────────────────────────────────────────
function leaveCurrentRoom() {
  stopMyTyping();
  stopPrivateTyping();
  stopVoiceRecording();

  if (currentChatType === 'group' && currentRoomId) {
    socket.emit('leave-room');
    if (joined) {
      socket.emit('voice-leave');
      hangUp();
      joined = false;
      if (micStatus) micStatus.className = 'mic-status';
    }
  }

  if (btnJoin) btnJoin.style.display = 'block';
  if (btnLeave) btnLeave.style.display = 'none';
  if (btnMic) btnMic.style.display = 'none';

  clearAllTyping();
  Crypto.clearAllKeys();
  ecdhExchanged.clear();
  outgoingSeq = 0;

  currentRoomId = null;
  currentRoomData = null;
  currentPassword = '';
  currentChatType = 'group';
  currentChatId = null;
  currentChatWith = null;
  isRoomOwner = false;
  clearChatState();
}

function closeAllModals() {
  [modalContacts, modalProfile, modalMembers, modalInvite, modalSettings, modalCreate, modalRoomPw]
    .forEach(m => { if (m) m.classList.remove('open'); });
}

// ───────────────────────────────────────────────
//  СОБЫТИЯ КОМНАТЫ / ECDH / TYPING
// ───────────────────────────────────────────────
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

function renderTyping() {
  const el = getHeaderSubEl();
  if (!el || currentChatType === 'private') return;
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
  if (typingUsers[id]) {
    clearTimeout(typingUsers[id].timer);
    delete typingUsers[id];
  }
  renderTyping();
}
function clearAllTyping() {
  Object.keys(typingUsers).forEach(id => {
    clearTimeout(typingUsers[id].timer);
    delete typingUsers[id];
  });
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

socket.on('typing-start', ({ from, nickname }) => {
  if (from !== socket.id) addTypingUser(from, nickname);
});
socket.on('typing-stop', ({ from }) => removeTypingUser(from));

// ───────────────────────────────────────────────
//  СТАТУСЫ В ЛИЧКЕ (для 03)
// ───────────────────────────────────────────────
function buildStatusTicks(status, mine) {
  if (!mine) return '';
  if (status==='sending')   return `<span class="msg-ticks sending" style="font-size:10px;color:rgba(255,255,255,0.4)">⏳</span>`;
  if (status==='sent')      return `<span class="msg-ticks sent" style="font-size:10px;color:rgba(255,255,255,0.4)">✓</span>`;
  if (status==='delivered') return `<span class="msg-ticks delivered" style="font-size:10px;color:rgba(255,255,255,0.5)">✓✓</span>`;
  if (status==='read')      return `<span class="msg-ticks read" style="font-size:10px;color:#7c5cbf">✓✓</span>`;
  return '';
}

function updateMsgStatus(msgId, status) {
  const domId = msgIdToDomId.get(msgId);
  if (!domId) return;
  const el = document.getElementById(domId);
  if (!el) return;

  const ticks = el.querySelector('.msg-ticks');
  const colorMap = {
    sending:'rgba(255,255,255,0.4)',
    sent:'rgba(255,255,255,0.4)',
    delivered:'rgba(255,255,255,0.5)',
    read:'#7c5cbf'
  };
  const textMap = { sending:'⏳', sent:'✓', delivered:'✓✓', read:'✓✓' };

  if (!ticks) {
    const meta = el.querySelector('.msg-meta');
    if (meta) {
      const span = document.createElement('span');
      span.className = 'msg-ticks ' + status;
      span.style.cssText = `font-size:10px;color:${colorMap[status] || ''}`;
      span.textContent = textMap[status] || '';
      meta.appendChild(span);
    }
    return;
  }

  ticks.className = 'msg-ticks ' + status;
  ticks.style.color = colorMap[status] || '';
  ticks.textContent = textMap[status] || '';
}

// ───────────────────────────────────────────────
//  PRIVATE typing/status socket events
// ───────────────────────────────────────────────
socket.on('private-typing-start', ({ chatId, fromNick }) => {
  if (currentChatId !== chatId) return;
  const el = getHeaderSubEl();
  if (el) {
    el.innerHTML = `<span class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span>${escapeHtml(fromNick)} печатает…</span>`;
  }
  clearTimeout(window._privateTypingClearTimer);
  window._privateTypingClearTimer = setTimeout(() => {
    if (typeof loadInitialStatus === 'function') loadInitialStatus(currentChatWith);
  }, 4000);
});
socket.on('private-typing-stop', ({ chatId }) => {
  if (currentChatId !== chatId) return;
  if (typeof loadInitialStatus === 'function') loadInitialStatus(currentChatWith);
});
socket.on('msg-delivered', ({ chatId, msgId }) => { if (currentChatId === chatId) updateMsgStatus(msgId, 'delivered'); });
socket.on('msg-read',      ({ chatId, msgId }) => { if (currentChatId === chatId) updateMsgStatus(msgId, 'read'); });
socket.on('chat-msg-id',   ({ seq, msgId }) => {
  const domId = seqToMsgId.get(seq);
  if (domId) {
    msgIdToDomId.set(msgId, domId);
    seqToMsgId.delete(seq);
    updateMsgStatus(msgId, 'sent');
  }
});
