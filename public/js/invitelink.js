// ═══════════════════════════════════════════════
//  INVITELINK.JS — ссылки-приглашения в группы
// ═══════════════════════════════════════════════

// ─── Генерация ссылки ───
function getInviteLink(roomId) {
  const base = window.location.origin;
  return `${base}/?invite=${roomId}`;
}

// ─── Копировать ссылку ───
function copyInviteLink(roomId) {
  const link = getInviteLink(roomId);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link)
      .then(() => showToast('🔗 Ссылка скопирована!', 3000))
      .catch(() => { prompt('Скопируй ссылку:', link); });
  } else {
    prompt('Скопируй ссылку:', link);
  }
}

// ─── Поделиться ссылкой ───
function shareInviteLink(roomId, roomName) {
  const link = getInviteLink(roomId);
  if (navigator.share) {
    navigator.share({
      title: `Присоединяйся к "${roomName}"`,
      text:  `Тебя приглашают в группу "${roomName}"`,
      url:   link
    }).catch(() => copyInviteLink(roomId));
  } else {
    copyInviteLink(roomId);
  }
}

// ─── UI кнопки в модалке участников ───
function addInviteLinkButton() {
  const membersModal = document.getElementById('modal-members');
  if (!membersModal || document.getElementById('invite-link-section')) return;

  const section = document.createElement('div');
  section.id = 'invite-link-section';
  section.style.cssText = 'margin-bottom:8px';
  section.innerHTML = `
    <div class="profile-section-title">🔗 Ссылка-приглашение</div>
    <div style="display:flex;gap:8px;align-items:center;padding:10px 14px;
      background:var(--bg2);border-radius:14px;border:1px solid rgba(255,255,255,0.06);">
      <div id="invite-link-text" style="flex:1;font-size:13px;color:var(--accent2);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer">
        ${currentRoomId ? getInviteLink(currentRoomId) : '—'}
      </div>
      <button id="btn-copy-invite-link"
        style="padding:8px 14px;border:none;border-radius:10px;background:var(--accent-g);
               color:white;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">
        📋 Копировать
      </button>
    </div>
    <button id="btn-share-invite-link"
      style="margin-top:8px;width:100%;padding:11px;border:1px solid rgba(124,92,191,0.25);
             border-radius:12px;background:rgba(124,92,191,0.08);color:var(--accent2);
             font-size:14px;font-weight:600;cursor:pointer">
      📤 Поделиться ссылкой
    </button>`;

  const renameSection = document.getElementById('rename-section');
  const joinReqSection = document.getElementById('join-requests-section');
  const target = renameSection || joinReqSection || membersModal.querySelector('.modal-handle')?.nextSibling;
  if (target && target.parentNode) {
    target.parentNode.insertBefore(section, target);
  } else {
    membersModal.querySelector('.modal-sheet')?.appendChild(section);
  }

  section.querySelector('#btn-copy-invite-link')?.addEventListener('click', () => {
    if (currentRoomId) copyInviteLink(currentRoomId);
  });
  section.querySelector('#btn-share-invite-link')?.addEventListener('click', () => {
    if (currentRoomId) shareInviteLink(currentRoomId, document.getElementById('chat-room-name')?.textContent || 'группу');
  });
  section.querySelector('#invite-link-text')?.addEventListener('click', () => {
    if (currentRoomId) copyInviteLink(currentRoomId);
  });
}

// ─── Обновляем ссылку при открытии модалки ───
const _origOpenMembersModal = typeof openMembersModal !== 'undefined' ? openMembersModal : null;

document.addEventListener('DOMContentLoaded', () => {
  // Перехватываем openMembersModal чтобы добавить секцию ссылки
  const origBtn = document.getElementById('btn-room-members');
  if (origBtn) {
    origBtn.addEventListener('click', () => {
      // Даём время модалке открыться
      setTimeout(() => {
        addInviteLinkButton();
        const linkEl = document.getElementById('invite-link-text');
        if (linkEl && currentRoomId) linkEl.textContent = getInviteLink(currentRoomId);
      }, 100);
    });
  }
});

// ─── Обработка перехода по ссылке-приглашению ───
function checkInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  if (!invite) return;

  // Чистим URL без перезагрузки
  window.history.replaceState({}, '', window.location.pathname);

  // Ждём авторизации
  const tryJoin = () => {
    if (!myNickname) { setTimeout(tryJoin, 500); return; }
    showToast(`🔗 Переход по ссылке-приглашению…`, 3000);
    if (typeof joinRoom === 'function') {
      joinRoom(invite, '', (ok, err) => {
        if (!ok) {
          if (err === 'not_found') showToast('❌ Группа не найдена или удалена', 4000);
          else if (err === 'wrong_password') {
            // Попросим пароль
            if (typeof openRoomPasswordModal === 'function') {
              openRoomPasswordModal(invite, 'Группа', 'open');
            }
          }
        }
      });
    }
  };
  setTimeout(tryJoin, 800);
}

// Проверяем при загрузке
window.addEventListener('load', checkInviteFromUrl);
