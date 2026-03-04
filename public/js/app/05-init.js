// ═══════════════════════════════════════════════
//  05-init.js — инициализация и все обработчики UI
// ═══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initDOM();

  if (typeof applyTheme === 'function') applyTheme(currentTheme);
  if (typeof initUI === 'function') initUI();

  initEventListeners();
  tryAutoLogin();
});

// ───────────────────────────────────────────────
//  HELPERS
// ───────────────────────────────────────────────
function validateStrongPasswordClient(pw) {
  if (typeof pw !== 'string') return 'invalid';
  if (pw.length < 12) return 'too_short';
  if (!/[a-z]/.test(pw)) return 'need_lower';
  if (!/[A-Z]/.test(pw)) return 'need_upper';
  if (!/[0-9]/.test(pw)) return 'need_digit';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'need_special';
  return null;
}

// ───────────────────────────────────────────────
//  CONNECT / DISCONNECT
// ───────────────────────────────────────────────
socket.on('connect', () => {
  if (reconnectBanner) reconnectBanner.classList.remove('visible');

  // Важно: при ALLOW_GUEST=false после reconnect нужно заново auth-token.
  if (authToken) {
    socket.emit('auth-token', { token: authToken }, res => {
      if (!res?.ok) {
        try { localStorage.removeItem('chat_token'); } catch (_) {}
        authToken = null;
        myNickname = '';
        myUsername = '';
        myAvatar = null;
        showScreen('auth');
        return;
      }

      myNickname = res.nickname;
      myUsername = res.username || res.nickname.toLowerCase();
      myAvatar = res.avatar || null;
      updateLobbyAvatarBtn?.();

      // восстановление текущего контекста
      if (currentRoomId && currentChatType === 'group') joinRoom(currentRoomId, currentPassword);
      if (currentChatId && currentChatType === 'private') socket.emit('private-chat-join', { chatId: currentChatId });

      // обновим TURN
      if (typeof refreshIceServers === 'function') refreshIceServers().catch(() => {});
    });
  }
});

socket.on('disconnect', () => {
  if ((currentRoomId || currentChatId) && reconnectBanner) reconnectBanner.classList.add('visible');
});

// ───────────────────────────────────────────────
//  ВСЕ ОБРАБОТЧИКИ
// ───────────────────────────────────────────────
function initEventListeners() {
  // Auth
  $('tab-login')?.addEventListener('click', () => switchTab('login'));
  $('tab-register')?.addEventListener('click', () => switchTab('register'));
  $('btn-login')?.addEventListener('click', doLogin);
  $('login-nick')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('login-pw')?.focus(); });
  $('login-pw')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  $('btn-register')?.addEventListener('click', doRegister);
  $('reg-nick')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('reg-pw')?.focus(); });
  $('reg-pw')?.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

  $('btn-show-hint')?.addEventListener('click', () => {
    const nick = $('login-nick')?.value.trim();
    if (!nick) { if (loginError) loginError.textContent = 'Сначала введи ник'; return; }
    socket.emit('auth-get-hint', { nickname: nick }, res => {
      if (!res.ok) { if (loginError) loginError.textContent = '❌ Не найден'; return; }
      showToast(res.hint ? '💡 Подсказка: ' + res.hint : 'Подсказка не задана', 6000);
    });
  });

  // OTP reset flow (без дублей)
  $('btn-show-reset')?.addEventListener('click', () => {
    const s = $('reset-password-section');
    if (s) s.style.display = s.style.display === 'none' ? '' : 'none';
  });

  $('btn-reset-send-otp')?.addEventListener('click', () => {
    const phone = $('reset-phone')?.value.trim() || '';
    if (!phone) { showToast('❌ Введи номер телефона'); return; }

    const btn = $('btn-reset-send-otp');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Отправка…'; }

    socket.emit('auth-reset-start', { phone }, res => {
      if (btn) { btn.disabled = false; btn.textContent = '📨 Отправить код'; }
      if (res?.ok) showToast('📨 Если номер найден, код отправлен', 4000);
      else showToast('⚠️ Ошибка отправки кода');
    });
  });

  $('btn-reset-confirm')?.addEventListener('click', () => {
    const phone = $('reset-phone')?.value.trim() || '';
    const code  = $('reset-otp')?.value.trim() || '';
    const newPw = $('reset-newpw')?.value || '';

    if (!phone) { showToast('❌ Введи номер телефона'); return; }
    if (!code || code.length < 4) { showToast('❌ Введи корректный код'); return; }
    if (!newPw) { showToast('❌ Введи новый пароль'); return; }

    const btn = $('btn-reset-confirm');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Проверка…'; }

    socket.emit('auth-reset-confirm', { phone, code, newPassword: newPw }, res => {
      if (btn) { btn.disabled = false; btn.textContent = '🔑 Подтвердить сброс'; }

      if (res?.ok) {
        showToast('✅ Пароль изменён. Войди заново', 5000);
        const s = $('reset-password-section');
        if (s) s.style.display = 'none';
        if ($('reset-otp')) $('reset-otp').value = '';
        if ($('reset-newpw')) $('reset-newpw').value = '';
        return;
      }

      const msgs = {
        otp_invalid: '❌ Неверный или просроченный код',
        too_short: '❌ Пароль слишком короткий',
        need_lower: '❌ Нужна строчная буква',
        need_upper: '❌ Нужна заглавная буква',
        need_digit: '❌ Нужна цифра',
        need_special: '❌ Нужен спецсимвол'
      };
      showToast(msgs[res?.error] || '⚠️ Ошибка сброса');
    });
  });

  $('btn-logout')?.addEventListener('click', doLogout);
  $('settings-go-logout')?.addEventListener('click', doLogout);

  // Profile
  $('btn-open-profile')?.addEventListener('click', openProfileModal);
  $('btn-close-profile')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(modalProfile);
    else modalProfile?.classList.remove('open');
  });

  $('btn-save-profile')?.addEventListener('click', () => {
    const newName  = $('profile-edit-name')?.value.trim()  || '';
    const newBio   = $('profile-edit-bio')?.value.trim()   || '';
    const newPhone = $('profile-edit-phone')?.value.trim() || '';
    socket.emit('profile-update', { nickname: newName, bio: newBio, phone: newPhone }, res => {
      if (res.ok) {
        myNickname = res.nickname;
        if (profileNameDisplay) profileNameDisplay.textContent = myNickname;
        updateLobbyAvatarBtn();
        showToast('✅ Профиль сохранён');
      }
    });
  });

  $('profile-avatar-wrap')?.addEventListener('click', () => { $('avatar-input')?.click(); });
  $('avatar-input')?.addEventListener('change', () => {
    const ai = $('avatar-input');
    const file = ai?.files[0];
    if (!file) return;
    if (ai) ai.value = '';

    if (file.size > 5 * 1024 * 1024) { showToast('⚠️ Фото слишком большое'); return; }

    const reader = new FileReader();
    reader.onload = e => {
      myAvatar = e.target.result;
      renderProfileAvatar();
      updateLobbyAvatarBtn();
      socket.emit('profile-set-avatar', { avatar: myAvatar }, res => {
        if (res.ok) showToast('✅ Аватар обновлён');
      });
    };
    reader.readAsDataURL(file);
  });

  $('btn-friend-search')?.addEventListener('click', () =>
    searchUserForFriend($('friend-search-input'), $('friend-search-result'))
  );
  $('friend-search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchUserForFriend($('friend-search-input'), $('friend-search-result'));
  });

  // Contacts
  $('btn-close-contacts')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(modalContacts);
    else modalContacts?.classList.remove('open');
  });

  $('btn-contacts-search')?.addEventListener('click', () =>
    searchUserForFriend($('contacts-search-input'), $('contacts-search-result'))
  );
  $('contacts-search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchUserForFriend($('contacts-search-input'), $('contacts-search-result'));
  });

  // Settings
  $('btn-close-settings')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(modalSettings);
    else modalSettings?.classList.remove('open');
  });

  $('settings-go-profile')?.addEventListener('click', () => {
    modalSettings?.classList.remove('open');
    openProfileModal();
  });

  $('settings-go-privacy')?.addEventListener('click', () => {
    modalSettings?.classList.remove('open');
    if (typeof openPrivacySettings === 'function') openPrivacySettings();
  });

  $('settings-go-notifs')?.addEventListener('click', () => {
    requestNotifPermission();
    showToast('🔔 Уведомления: ' + (Notification.permission === 'granted' ? 'включены' : 'требуется разрешение'));
  });

  $('settings-go-data')?.addEventListener('click', () => showToast('💾 Кэш очищен'));
  $('settings-go-lang')?.addEventListener('click', () => showToast('🌐 Язык: Русский'));
  $('settings-go-chats')?.addEventListener('click', () => showToast('💬 Раздел в разработке'));
  $('settings-go-about')?.addEventListener('click', () => {
    modalSettings?.classList.remove('open');
    openAboutPage();
  });

  // Create room
  $('btn-close-create')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(modalCreate);
    else modalCreate?.classList.remove('open');
  });

  $('room-photo-btn')?.addEventListener('click', () => $('room-photo-input')?.click());
  $('room-photo-input')?.addEventListener('change', () => {
    const rpi = $('room-photo-input');
    const file = rpi?.files[0];
    if (!file) return;
    if (rpi) rpi.value = '';
    if (file.size > 5 * 1024 * 1024) { alert('Фото слишком большое'); return; }

    const r = new FileReader();
    r.onload = e => {
      roomPhotoData = e.target.result;
      const btn = $('room-photo-btn');
      if (btn) btn.innerHTML = `<img src="${roomPhotoData}" alt="">`;
    };
    r.readAsDataURL(file);
  });

  $('btn-toggle-create-pw')?.addEventListener('click', () => {
    const i = $('create-room-pw');
    if (!i) return;
    const t = i.type === 'text';
    i.type = t ? 'password' : 'text';
    const btn = $('btn-toggle-create-pw');
    if (btn) btn.textContent = t ? '👁' : '🙈';
  });

  $('btn-submit-create')?.addEventListener('click', submitCreateRoom);
  $('create-room-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitCreateRoom(); });

  // Room password
  $('btn-close-pw-modal')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(modalRoomPw);
    else modalRoomPw?.classList.remove('open');
    pendingJoinRoom = null;
  });

  $('btn-toggle-room-pw')?.addEventListener('click', () => {
    const i = $('room-pw-input');
    if (!i) return;
    const t = i.type === 'text';
    i.type = t ? 'password' : 'text';
    const btn = $('btn-toggle-room-pw');
    if (btn) btn.textContent = t ? '👁' : '🙈';
  });

  $('btn-submit-room-pw')?.addEventListener('click', submitRoomPassword);
  $('room-pw-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitRoomPassword(); });

  // Members modal
  $('btn-close-members')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(modalMembers);
    else modalMembers?.classList.remove('open');
  });

  $('btn-rename-room')?.addEventListener('click', () => {
    const ri = $('rename-input');
    const name = ri?.value.trim();
    if (!name) { const re = $('rename-error'); if (re) re.textContent = 'Введи название'; return; }
    const re = $('rename-error'); if (re) re.textContent = '';

    socket.emit('room-rename', { roomId: currentRoomId, newName: name }, res => {
      if (res.ok) {
        showToast('✅ Переименовано');
        if (currentRoomData) currentRoomData.name = name;
      } else {
        const re2 = $('rename-error');
        if (re2) re2.textContent = res.error === 'not_owner' ? '❌ Нет прав' : '⚠️ Ошибка';
      }
    });
  });

  $('rename-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-rename-room')?.click(); });

  $('btn-group-photo-change')?.addEventListener('click', () => $('group-photo-input')?.click());
  $('group-photo-input')?.addEventListener('change', () => {
    const gpi = $('group-photo-input');
    const file = gpi?.files[0];
    if (!file) return;
    if (gpi) gpi.value = '';
    if (file.size > 5 * 1024 * 1024) { showToast('⚠️ Фото слишком большое'); return; }

    const r = new FileReader();
    r.onload = e => {
      socket.emit('room-set-photo', { roomId: currentRoomId, photo: e.target.result }, res => {
        if (res.ok) {
          showToast('✅ Фото обновлено');
          if (chatRoomAvatar) chatRoomAvatar.innerHTML = `<img src="${e.target.result}" alt="">`;
          if (currentRoomData) currentRoomData.photo = e.target.result;
        } else showToast('❌ Ошибка: ' + (res.error || ''));
      });
    };
    r.readAsDataURL(file);
  });

  $('btn-save-group-settings')?.addEventListener('click', () => {
    const gad = $('group-autodelete-select');
    const gjm = $('group-joinmode-select');

    socket.emit('room-settings-update', {
      roomId: currentRoomId,
      autoDelete: gad ? gad.value : 'never',
      joinMode: gjm ? gjm.value : 'open'
    }, res => {
      if (res.ok) {
        const ns = $('group-notif-select');
        if (ns && currentRoomId) setNotifSetting(currentRoomId, ns.value);
        showToast('✅ Настройки сохранены');
        if (currentRoomData) {
          currentRoomData.autoDelete = gad?.value === 'never' ? null : parseInt(gad?.value, 10);
          currentRoomData.joinMode = gjm?.value || 'open';
        }
      } else showToast('⚠️ Ошибка сохранения');
    });
  });

  $('btn-delete-group')?.addEventListener('click', () => {
    if (!confirm('🗑 Удалить группу?')) return;
    socket.emit('room-delete', { roomId: currentRoomId }, res => {
      if (res.ok) {
        modalMembers?.classList.remove('open');
        leaveCurrentRoom();
        showScreen('lobby');
        showToast('🗑 Группа удалена');
      } else showToast('⚠️ Ошибка: ' + (res.error || ''));
    });
  });

  // Invite modal
  $('btn-close-invite')?.addEventListener('click', () => {
    if (window._closeModal) window._closeModal(modalInvite);
    else modalInvite?.classList.remove('open');
  });

  // New chat button
  $('btn-create-room')?.addEventListener('click', openNewChatMenu);
  $('btn-create-room-chat')?.addEventListener('click', openNewChatMenu);

  // Tabs
  initLobbyTabs();

  // Chat header
  $('btn-back-lobby')?.addEventListener('click', () => {
    leaveCurrentRoom();
    showScreen('lobby');
  });

  $('chat-room-avatar')?.addEventListener('click', () => {
    if (currentChatType === 'private' && currentChatWith) {
      const img = $('chat-room-avatar')?.querySelector('img');
      openPeerProfile(currentChatWith, img ? img.src : null);
    } else if (currentChatType === 'group') {
      openMembersModal();
    }
  });

  $('chat-header-info')?.addEventListener('click', () => {
    if (currentChatType === 'private' && currentChatWith) {
      const img = $('chat-room-avatar')?.querySelector('img');
      openPeerProfile(currentChatWith, img ? img.src : null);
    } else if (currentChatType === 'group') {
      openMembersModal();
    }
  });

  $('btn-notif-settings')?.addEventListener('click', () => {
    const id = currentChatType === 'private' ? currentChatId : currentRoomId;
    const name = $('chat-room-name')?.textContent || '?';
    if (id && typeof openChatNotifSettings === 'function') openChatNotifSettings(id, name);
  });

  $('btn-room-members')?.addEventListener('click', () => {
    if (currentChatType === 'group' && currentRoomId) openMembersModal();
  });

  // Voice group
  $('btn-join')?.addEventListener('click', async () => {
    if (!currentRoomId || currentChatType !== 'group') return;
    try {
      const rawStream = await getMicStream();
      localStream = rawStream;

      try { processedStream = await buildAudioPipeline(rawStream); }
      catch (_) {
        processedStream = rawStream;
        if (noiseIndicator) noiseIndicator.classList.remove('visible');
      }

      await requestWakeLock();
      startKeepAlive();
      setMicStatus(true);

      if (btnJoin) btnJoin.style.display = 'none';
      if (btnLeave) btnLeave.style.display = 'block';
      if (btnMic) btnMic.style.display = 'block';

      joined = true;
      addParticipant(socket.id, myNickname, true);
      startVolumeAnalysis(socket.id, localStream);

      socket.emit('voice-join');

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

  $('btn-leave')?.addEventListener('click', () => {
    socket.emit('voice-leave');
    hangUp();
    joined = false;

    if (btnJoin) btnJoin.style.display = 'block';
    if (btnLeave) btnLeave.style.display = 'none';
    if (btnMic) btnMic.style.display = 'none';

    if (micStatus) { micStatus.className = 'mic-status'; micStatus.textContent = ''; }

    releaseWakeLock();
    stopKeepAlive();
  });

  $('btn-mic')?.addEventListener('click', () => {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    setMicStatus(micEnabled);

    if (btnMic) btnMic.textContent = micEnabled ? '🔇 Выключить микрофон' : '🎙️ Включить микрофон';
  });

  // Input
  $('chat-input')?.addEventListener('input', () => {
    const ci = $('chat-input');
    if (!ci) return;

    ci.style.height = 'auto';
    ci.style.height = Math.min(ci.scrollHeight, 120) + 'px';

    if (btnVoiceRecord) btnVoiceRecord.style.display = ci.value.trim().length > 0 ? 'none' : 'flex';

    if (ci.value.trim().length > 0) {
      if (currentChatType === 'private') startPrivateTyping();
      else startMyTyping();
    } else {
      if (currentChatType === 'private') stopPrivateTyping();
      else stopMyTyping();
    }
  });

  $('chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTextMessage();
    }
  });

  $('btn-send')?.addEventListener('click', sendTextMessage);

  // Attach/file
  $('btn-photo')?.addEventListener('click', () => {
    if (fileInput) { fileInput.accept = 'image/*'; fileInput.click(); }
  });

  $('btn-video')?.addEventListener('click', () => {
    if (fileInput) { fileInput.accept = 'video/*'; fileInput.click(); }
  });

  $('btn-file')?.addEventListener('click', () => {
    if (fileInput) { fileInput.accept = '*/*'; fileInput.click(); }
  });

  $('file-input')?.addEventListener('change', async () => {
    const fi = $('file-input');
    const file = fi?.files[0];
    if (!file) return;
    if (fi) fi.value = '';

    if (file.size > 25 * 1024 * 1024) {
      showToast('⚠️ Файл слишком большой. Максимум 25 МБ.');
      return;
    }

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');

    if (isImage) {
      MediaEditor.openPhoto(file, async (b, mt, fn) => await sendMediaBlob(b, mt, fn, 'image'), () => {});
      return;
    }
    if (isVideo) {
      MediaEditor.openVideo(file, async (b, mt, fn) => await sendMediaBlob(b, mt, fn, 'video'), () => {});
      return;
    }

    await sendMediaBlob(file, file.type, file.name, 'file');
  });

  // Lightbox
  $('lightbox-close')?.addEventListener('click', () => {
    $('lightbox')?.classList.remove('open');
    if (lightboxContent) lightboxContent.innerHTML = '';
  });

  $('lightbox')?.addEventListener('click', e => {
    if (e.target === $('lightbox')) {
      $('lightbox')?.classList.remove('open');
      if (lightboxContent) lightboxContent.innerHTML = '';
    }
  });

  // Voice record button
  if (btnVoiceRecord) {
    let isPointerDown = false;
    let touchStartX = 0;

    btnVoiceRecord.addEventListener('touchstart', e => {
      e.preventDefault();
      isPointerDown = true;
      touchStartX = e.touches[0]?.clientX || 0;
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

    btnVoiceRecord.addEventListener('touchmove', e => {
      if (!isVoiceRecording) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartX;
      if (deltaX < -60) {
        stopAndCancelVoice();
        showToast('❌ Запись отменена');
      }
    }, { passive: true });

    btnVoiceRecord.addEventListener('mousedown', e => {
      e.preventDefault();
      isPointerDown = true;
      if (!isVoiceRecording) startVoiceRecording();
    });

    document.addEventListener('mouseup', () => {
      if (isPointerDown) {
        isPointerDown = false;
        if (isVoiceRecording) stopAndSendVoice();
      }
    });
  }

  // Call screen buttons
  $('btn-call-minimize')?.addEventListener('click', hideCallScreen);
  $('call-btn-hangup')?.addEventListener('click', () => endPrivateCall(true));
  $('call-mini-hangup')?.addEventListener('click', e => {
    e.stopPropagation();
    endPrivateCall(true);
  });

  $('call-btn-speaker')?.addEventListener('click', () => setSpeakerOutput(!isSpeakerMode));

  $('call-btn-mute')?.addEventListener('click', () => {
    pcCallMuted = !pcCallMuted;
    if (pcCallStream) pcCallStream.getAudioTracks().forEach(t => { t.enabled = !pcCallMuted; });

    if (pcCallMuted) {
      callBtnMute?.classList.add('active');
      if (callBtnMute) callBtnMute.textContent = '🔇';
    } else {
      callBtnMute?.classList.remove('active');
      if (callBtnMute) callBtnMute.textContent = '🎤';
    }

    if (pcCallIsVideo) showCallControls();
  });

  $('call-btn-video')?.addEventListener('click', async () => {
    if (!pcCallActive) { showToast('Сначала установите звонок', 2000); return; }

    if (!pcCallIsVideo) {
      ensureVideoElements();
      const vs = await startLocalVideo();
      if (!vs) { showToast('❌ Нет доступа к камере', 3000); return; }

      pcCallIsVideo = true;
      callBtnVideo?.classList.add('active');
      showVideoUI(true);

      if (pcCallPeer) {
        const vt = vs.getVideoTracks()[0];
        if (vt) {
          try {
            const existing = pcCallPeer.getSenders().find(s => s.track?.kind === 'video');
            if (existing) await existing.replaceTrack(vt);
            else pcCallPeer.addTrack(vt, localVideoStream);
            showToast('📷 Видео включено', 2000);
          } catch (_) {
            showToast('⚠️ Не удалось добавить видео', 3000);
          }
        }
      }
    } else {
      pcCallIsVideo = false;
      callBtnVideo?.classList.remove('active');
      showVideoUI(false);

      if (pcCallPeer) {
        const vs = pcCallPeer.getSenders().find(s => s.track?.kind === 'video');
        if (vs) {
          vs.track?.stop();
          try { await vs.replaceTrack(null); } catch (_) {}
        }
      }
      stopLocalVideo();
      showToast('📷 Видео выключено', 2000);
    }
  });

  $('call-screen')?.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (pcCallIsVideo) {
      if (callControlsVisible) hideCallControls();
      else showCallControls();
    }
  });

  $('btn-private-call')?.addEventListener('click', async () => {
    if (pcCallActive) {
      const withAvatar = $('chat-room-avatar')?.querySelector('img')?.src || null;
      showCallScreen(pcCallRemoteNick, withAvatar, $('call-screen-status')?.textContent || null, pcCallIsVideo);
      return;
    }
    if (currentChatType !== 'private' || !currentChatId) return;
    openCallTypeSelector();
  });

  // Incoming call
  $('btn-call-accept')?.addEventListener('click', async () => {
    $('modal-incoming-call')?.classList.remove('open');
    stopIncomingRing();

    if (!incomingCallData) return;
    const data = incomingCallData;
    const isVideo = data.isVideo || false;
    pcCallIsVideo = isVideo;

    try {
      pcCallStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (_) {
      showToast('❌ Нет доступа к микрофону');
      socket.emit('private-call-reject', { to: data.from });
      incomingCallData = null;
      return;
    }

    pcCallRemoteId = data.from;
    pcCallRemoteNickLow = data.fromNickLower || data.fromNick?.toLowerCase();
    pcCallRemoteNick = data.fromNick || '?';

    pcCallPeer = createPrivateCallPeer(pcCallRemoteId, false, isVideo);
    pcCallStream.getAudioTracks().forEach(t => { try { pcCallPeer.addTrack(t, pcCallStream); } catch (_) {} });

    try {
      await pcCallPeer.setRemoteDescription(new RTCSessionDescription(data.offer));
    } catch (e) {
      console.error('setRemoteDescription error:', e);
      showToast('❌ Ошибка установки соединения');
      endPrivateCall(false);
      return;
    }

    for (const c of pcIceCandidateBuffer) {
      try { await pcCallPeer.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
    pcIceCandidateBuffer = [];

    if (isVideo) {
      ensureVideoElements();
      const vs = await startLocalVideo();
      if (vs && pcCallPeer) {
        const vt = vs.getVideoTracks()[0];
        if (vt) { try { pcCallPeer.addTrack(vt, vs); } catch (_) {} }
      }
    }

    let answer;
    try {
      answer = await pcCallPeer.createAnswer({ offerToReceiveAudio: true, offerToReceiveVideo: isVideo });
      await pcCallPeer.setLocalDescription(answer);
    } catch (e) {
      console.error('createAnswer error:', e);
      showToast('❌ Ошибка ответа на звонок');
      endPrivateCall(false);
      return;
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

  $('btn-call-reject')?.addEventListener('click', () => {
    $('modal-incoming-call')?.classList.remove('open');
    stopIncomingRing();
    if (incomingCallData) {
      socket.emit('private-call-reject', { to: incomingCallData.from });
      incomingCallData = null;
    }
  });

  // Emoji button near input
  (function addEmojiButton() {
    const inputRow = document.querySelector('.tg-input-row');
    const input = $('chat-input');
    if (!inputRow || !input || $('btn-emoji-picker')) return;

    const btn = document.createElement('button');
    btn.id = 'btn-emoji-picker';
    btn.className = 'btn-attach-tg';
    btn.style.cssText = 'font-size:20px;';
    btn.textContent = '😊';
    btn.title = 'Эмодзи';

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if ($('emoji-picker-popup')) $('emoji-picker-popup').remove();
      else openEmojiPicker();
    });

    inputRow.insertBefore(btn, input);
  })();

  // Tap local preview to switch camera
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'video-local' && localVideoStream) {
      const ct = localVideoStream.getVideoTracks()[0];
      if (!ct) return;

      const settings = ct.getSettings();
      const newFacing = settings.facingMode === 'user' ? 'environment' : 'user';

      navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      }).then(async ns => {
        const nt = ns.getVideoTracks()[0];
        if (pcCallPeer) {
          const sender = pcCallPeer.getSenders().find(s => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(nt);
        }
        ct.stop();
        const lv = $('video-local');
        if (lv) lv.srcObject = ns;
        localVideoStream = ns;
      }).catch(() => showToast('❌ Ошибка переключения камеры'));
    }
  });

  // Long press menu
  initLongPress();

  // Friend events
  socket.on('friend-request-incoming', ({ fromNick }) => {
    showToast(`👋 ${fromNick} хочет добавить тебя в друзья`, 6000, () => {
      socket.emit('friend-respond', { fromNickname: fromNick, accept: true }, res => {
        if (res.ok) { showToast('✅ Добавлен!'); loadFriends(); }
      });
    });
    if (modalProfile?.classList.contains('open')) loadFriends();
    if (modalContacts?.classList.contains('open')) loadContactsFriends();
  });

  socket.on('friend-accepted', ({ byNick }) => {
    showToast(`✅ ${byNick} принял запрос!`, 5000);
    if (modalProfile?.classList.contains('open')) loadFriends();
    if (modalContacts?.classList.contains('open')) loadContactsFriends();
  });

  // Drawer avatar click
  $('drawer-avatar')?.addEventListener('click', () => {
    if (typeof closeDrawer === 'function') closeDrawer();
    openProfileModal();
  });

  // Clear unread on focus
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const id = currentChatType === 'private' ? currentChatId : currentRoomId;
      if (id) clearUnread(id);
    }
  });

  // Username availability check
  (function initUsernameCheck() {
    const input  = $('reg-username');
    const status = $('username-status');
    const rn     = $('reg-nick');
    if (!input || !status) return;

    function suggestUsername(base) {
      return base.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').replace(/^_|_$/g, '') || 'user';
    }

    rn?.addEventListener('input', () => {
      if (input.value.trim()) return;
      const suggestion = suggestUsername(rn.value.trim());
      if (suggestion.length >= 2) {
        input.value = suggestion;
        checkUsername(suggestion);
      }
    });

    let timer = null;

    function checkUsername(val) {
      val = val.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!val || val.length < 2) {
        status.className = 'username-status';
        status.textContent = '';
        return;
      }

      status.className = 'username-status loading';
      status.textContent = '⏳ Проверяем…';

      clearTimeout(timer);
      timer = setTimeout(() => {
        socket.emit('profile-get-user', { nickname: val }, res => {
          if (res.ok) {
            status.className = 'username-status taken';
            const alt1 = val + Math.floor(Math.random() * 90 + 10);
            const alt2 = val + '_' + (new Date().getFullYear() % 100);
            status.innerHTML = `❌ Занят. Попробуй: <button onclick="document.getElementById('reg-username').value='${alt1}';window.checkUsernameInput&&checkUsernameInput()" style="background:none;border:none;color:var(--accent2);cursor:pointer;font-size:11px;text-decoration:underline">${alt1}</button> или <button onclick="document.getElementById('reg-username').value='${alt2}';window.checkUsernameInput&&checkUsernameInput()" style="background:none;border:none;color:var(--accent2);cursor:pointer;font-size:11px;text-decoration:underline">${alt2}</button>`;
          } else {
            status.className = 'username-status ok';
            status.textContent = '✓ Логин свободен';
          }
        });
      }, 500);
    }

    window.checkUsernameInput = () => checkUsername(input.value);
    input.addEventListener('input', () => checkUsername(input.value));
  })();
}

// ───────────────────────────────────────────────
//  AUTH ACTIONS
// ───────────────────────────────────────────────
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

  const pErr = validateStrongPasswordClient(pw || '');
  if (pErr) {
    const msgs = {
      too_short: '❌ Пароль: минимум 12 символов',
      need_lower: '❌ Нужна строчная буква',
      need_upper: '❌ Нужна заглавная буква',
      need_digit: '❌ Нужна цифра',
      need_special: '❌ Нужен спецсимвол'
    };
    if (regError) regError.textContent = msgs[pErr] || '❌ Слабый пароль';
    return;
  }

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
        too_short: '❌ Пароль слишком короткий',
        need_lower: '❌ Нужна строчная буква',
        need_upper: '❌ Нужна заглавная буква',
        need_digit: '❌ Нужна цифра',
        need_special: '❌ Нужен спецсимвол'
      };
      if (regError) regError.textContent = msgs[res.error] || '⚠️ Ошибка';
    }
  });
}
