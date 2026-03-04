// ═══════════════════════════════════════════════
//  STATUS.JS — онлайн статусы и "Invalid Date" fix
// ═══════════════════════════════════════════════

// ─── Форматирование времени (исправляет "Invalid Date") ───
function formatChatTime(timestamp) {
  if (!timestamp || isNaN(Number(timestamp))) return '';
  const date = new Date(Number(timestamp));
  if (isNaN(date.getTime())) return '';
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today - msgDate) / 86400000);
  if (diffDays === 0) return date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7)  return date.toLocaleDateString('ru', { weekday: 'short' });
  return date.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

// ─── Форматирование статуса "последний раз в сети" ───
function formatLastSeen(lastSeenTs, privacySetting) {
  // Если настройка = nobody — показываем "был(а) недавно"
  if (privacySetting === 'nobody') return 'был(а) недавно';

  if (!lastSeenTs || isNaN(Number(lastSeenTs))) return 'был(а) недавно';
  const date = new Date(Number(lastSeenTs));
  if (isNaN(date.getTime())) return 'был(а) недавно';

  const now     = Date.now();
  const diffMs  = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1)   return 'только что';
  if (diffMin < 60)  return `был(а) ${diffMin} мин. назад`;

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `был(а) ${diffHrs} ч. назад`;

  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return 'был(а) вчера';
  if (diffDays < 7)  return `был(а) ${diffDays} дн. назад`;

  return 'был(а) недавно';
}

// ─── Обновление статуса в заголовке чата ───
function updatePrivateChatStatus(nickLower, online, lastSeen) {
  if (currentChatType !== 'private') return;
  if (!currentChatWith || currentChatWith.toLowerCase() !== nickLower) return;

  const el = getHeaderSubEl();
  if (!el) return;

  if (online) {
    el.innerHTML = `<span class="online">в сети</span>`;
  } else {
    // Получаем настройку приватности пользователя
    socket.emit('profile-get-user', { nickname: currentChatWith }, res => {
      const privacy = res.ok ? (res.privacy || {}) : {};
      const lastSeenVisibility = privacy.lastSeenVisibility || 'nobody';
      const statusText = formatLastSeen(lastSeen, lastSeenVisibility);
      if (el) el.innerHTML = `<span style="color:var(--sub)">${statusText}</span>`;
    });
  }
}

// ─── Загрузка начального статуса при открытии чата ───
function loadInitialStatus(withNickname) {
  socket.emit('get-online-status', { nicknames: [withNickname] }, res => {
    if (!res.ok) return;
    const isOnline = res.statuses[withNickname.toLowerCase()];
    const el = getHeaderSubEl();
    if (!el) return;

    if (isOnline) {
      el.innerHTML = `<span class="online">в сети</span>`;
    } else {
      // Запрашиваем профиль для определения настройки lastSeen
      socket.emit('profile-get-user', { nickname: withNickname }, profileRes => {
        const privacy = profileRes.ok ? (profileRes.privacy || {}) : {};
        const lastSeenVisibility = privacy.lastSeenVisibility || 'nobody';
        const statusText = formatLastSeen(null, lastSeenVisibility);
        if (el) el.innerHTML = `<span style="color:var(--sub)">${statusText}</span>`;
      });
    }
  });
}

// ─── Слушаем события онлайн/оффлайн ───
socket.on('user-online', ({ nickLower }) => {
  // Обновляем заголовок чата
  if (currentChatType === 'private' && currentChatWith?.toLowerCase() === nickLower) {
    const el = getHeaderSubEl();
    if (el) el.innerHTML = `<span class="online">в сети</span>`;
  }
  // Обновляем список чатов
  if (typeof cachedPrivateList !== 'undefined') {
    cachedPrivateList = cachedPrivateList.map(c =>
      c.withLower === nickLower ? { ...c, online: true } : c
    );
    if (typeof renderUnifiedList === 'function') renderUnifiedList();
    if (typeof renderUnifiedListInChat === 'function') renderUnifiedListInChat();
  }
});

socket.on('user-offline', ({ nickLower, lastSeen }) => {
  // Обновляем заголовок чата
  if (currentChatType === 'private' && currentChatWith?.toLowerCase() === nickLower) {
    socket.emit('profile-get-user', { nickname: currentChatWith }, res => {
      const privacy = res.ok ? (res.privacy || {}) : {};
      const lastSeenVisibility = privacy.lastSeenVisibility || 'nobody';
      const statusText = formatLastSeen(lastSeen, lastSeenVisibility);
      const el = getHeaderSubEl();
      if (el) el.innerHTML = `<span style="color:var(--sub)">${statusText}</span>`;
    });
  }
  // Обновляем список чатов
  if (typeof cachedPrivateList !== 'undefined') {
    cachedPrivateList = cachedPrivateList.map(c =>
      c.withLower === nickLower ? { ...c, online: false, lastSeen } : c
    );
    if (typeof renderUnifiedList === 'function') renderUnifiedList();
    if (typeof renderUnifiedListInChat === 'function') renderUnifiedListInChat();
  }
});
