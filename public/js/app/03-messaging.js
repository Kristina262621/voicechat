// ═══════════════════════════════════════════════
//  03-messaging.js — сообщения, файлы, голосовые, реакции, reply
// ═══════════════════════════════════════════════

// ───────────────────────────────────────────────
//  КОНТЕКСТНОЕ МЕНЮ СООБЩЕНИЯ
// ───────────────────────────────────────────────
function openMsgContextMenu(domId, msgEl) {
  if (!domId || !msgEl) return;
  const isMine    = msgEl.classList.contains('mine');
  const msgType   = msgEl.dataset.type || 'text';
  const isText    = msgType === 'text';
  const msgIdAttr = msgEl.dataset.msgId || '';

  document.querySelector('.msg-context-menu')?.remove();

  const items = [];
  if (isMine && isText) items.push({ icon: '✏️', label: 'Изменить', action: 'edit' });
  if (isMine)           items.push({ icon: '🗑', label: 'Удалить у всех', action: 'delete-all', danger: true });
  items.push({ icon: '🗑', label: 'Удалить у себя', action: 'delete-me', danger: true });
  if (isText) items.push({ icon: '📋', label: 'Копировать', action: 'copy' });

  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';
  menu.innerHTML = `
    <div class="msg-ctx-backdrop" style="position:fixed;inset:0;z-index:2999"></div>
    <div class="msg-ctx-sheet" style="position:fixed;bottom:0;left:0;right:0;max-width:520px;margin:0 auto;background:var(--surface);border-radius:28px 28px 0 0;padding:12px 12px 40px;z-index:3000;border-top:1px solid rgba(124,92,191,0.2);transform:translateY(100%);transition:transform 0.25s cubic-bezier(0.34,1.1,0.64,1)">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:8px auto 16px" class="modal-handle"></div>
      ${items.map(item => `
        <button class="msg-ctx-item" data-action="${item.action}" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:none;background:none;color:${item.danger?'var(--red)':'var(--text)'};font-size:15px;cursor:pointer;width:100%;text-align:left">
          <span style="font-size:20px">${item.icon}</span><span>${item.label}</span>
        </button>`).join('')}
      <button class="msg-ctx-cancel" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:none;background:rgba(255,255,255,0.05);color:var(--sub);font-size:15px;cursor:pointer;width:100%;text-align:left;margin-top:8px">
        <span style="font-size:20px">✕</span><span>Отмена</span>
      </button>
    </div>`;
  document.body.appendChild(menu);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const s = menu.querySelector('.msg-ctx-sheet');
    if (s) s.style.transform = 'translateY(0)';
  }));

  const close = () => {
    const s = menu.querySelector('.msg-ctx-sheet');
    if (s) {
      s.style.transform = 'translateY(100%)';
      s.addEventListener('transitionend', () => menu.remove(), { once: true });
    } else menu.remove();
  };

  menu.querySelector('.msg-ctx-backdrop').addEventListener('click', close);
  menu.querySelector('.msg-ctx-cancel').addEventListener('click', close);

  menu.querySelectorAll('.msg-ctx-item[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      close();

      if (action === 'copy') {
        const c = msgEl.querySelector('.msg-content');
        if (c) navigator.clipboard?.writeText(c.innerText || c.textContent || '')
          .then(() => showToast('📋 Скопировано'))
          .catch(() => showToast('❌ Ошибка'));
        return;
      }

      if (action === 'edit') {
        openMsgEditDialog(domId, msgEl, msgIdAttr);
        return;
      }

      const deleteFor = action === 'delete-all' ? 'all' : 'me';
      if (currentChatType === 'private' && currentChatId) {
        socket.emit('private-msg-delete', { chatId: currentChatId, msgId: msgIdAttr, deleteFor }, res => {
          if (!res.ok) showToast('❌ Ошибка удаления');
        });
      } else if (currentRoomId) {
        socket.emit('room-msg-delete', { roomId: currentRoomId, msgId: msgIdAttr, deleteFor }, res => {
          if (!res.ok) showToast('❌ Ошибка удаления');
        });
      }
    });
  });

  requestAnimationFrame(() => {
    const sheet = menu.querySelector('.msg-ctx-sheet');
    if (!sheet || !msgIdAttr) return;

    const reactionRow = document.createElement('div');
    reactionRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:8px 16px 4px;border-bottom:1px solid var(--divider);';
    reactionRow.innerHTML = REACTION_EMOJIS.slice(0, 6).map(emoji =>
      `<button class="ctx-reaction-btn" data-emoji="${emoji}" style="width:36px;height:36px;border:none;background:none;font-size:22px;cursor:pointer;border-radius:10px;">${emoji}</button>`
    ).join('') + `<button class="ctx-reaction-btn ctx-more-emoji" data-emoji="" style="width:36px;height:36px;border:none;background:rgba(255,255,255,0.06);font-size:16px;cursor:pointer;border-radius:10px;color:var(--sub)">+</button>`;

    const handle = sheet.querySelector('.modal-handle');
    if (handle) handle.insertAdjacentElement('afterend', reactionRow);
    else sheet.insertBefore(reactionRow, sheet.firstElementChild);

    reactionRow.querySelectorAll('.ctx-reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        menu.remove();
        if (!btn.dataset.emoji) openReactionPicker(msgIdAttr, msgEl);
        else toggleReaction(msgIdAttr, btn.dataset.emoji, msgEl);
      });
    });

    const replyBtn = document.createElement('button');
    replyBtn.className = 'msg-ctx-item';
    replyBtn.style.cssText = 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:none;background:none;color:var(--text);font-size:15px;cursor:pointer;width:100%;text-align:left;';
    replyBtn.innerHTML = '<span style="font-size:20px">↩️</span><span>Ответить</span>';
    replyBtn.addEventListener('click', () => {
      menu.remove();
      setReplyTo(msgIdAttr, msgEl);
    });

    const firstItem = sheet.querySelector('.msg-ctx-item[data-action]');
    if (firstItem) firstItem.insertAdjacentElement('beforebegin', replyBtn);
    else sheet.appendChild(replyBtn);

    // Кнопка "Закрепить" — только в групповом чате для медиа-сообщений, если пользователь owner/admin
    const canPin = currentChatType === 'group' && currentRoomId && msgIdAttr &&
      (typeof myRole !== 'undefined' ? (myRole === 'owner' || myRole === 'admin') : isRoomOwner);
    const isMedia = ['image', 'video', 'file', 'voice'].includes(msgType);
    if (canPin && isMedia) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'msg-ctx-item';
      pinBtn.style.cssText = 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:none;background:none;color:var(--text);font-size:15px;cursor:pointer;width:100%;text-align:left;';
      pinBtn.innerHTML = '<span style="font-size:20px">📌</span><span>Закрепить в описании</span>';
      pinBtn.addEventListener('click', () => {
        menu.remove();
        socket.emit('room-pin-media', { roomId: currentRoomId, msgId: msgIdAttr, kind: msgType }, res => {
          if (!res?.ok) showToast('❌ Не удалось закрепить');
          else showToast('📌 Медиа закреплено в описании группы');
        });
      });
      const cancelBtn = sheet.querySelector('.msg-ctx-cancel');
      if (cancelBtn) cancelBtn.insertAdjacentElement('beforebegin', pinBtn);
      else sheet.appendChild(pinBtn);
    }
  });
}

function openMsgEditDialog(domId, msgEl, msgId) {
  const content     = msgEl.querySelector('.msg-content');
  const currentText = content ? (content.innerText || content.textContent || '').trim() : '';
  const dlg = document.createElement('div');
  dlg.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px)';
  dlg.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);border-radius:28px 28px 0 0;padding:20px 20px 40px;border-top:1px solid rgba(124,92,191,0.2)">
      <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 18px"></div>
      <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:16px">✏️ Изменить</div>
      <textarea id="edit-msg-input" style="width:100%;padding:13px 16px;background:var(--bg2);border:1.5px solid rgba(255,255,255,0.07);border-radius:14px;color:var(--text);font-size:16px;outline:none;font-family:inherit;resize:none;min-height:80px;max-height:200px;"></textarea>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button id="edit-cancel" style="flex:1;padding:13px;border:none;border-radius:14px;background:rgba(255,255,255,0.06);color:var(--text);font-size:15px;cursor:pointer">Отмена</button>
        <button id="edit-save" style="flex:1;padding:13px;border:none;border-radius:14px;background:var(--accent-g);color:white;font-size:15px;font-weight:700;cursor:pointer">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  const input = dlg.querySelector('#edit-msg-input');
  input.value = currentText;

  const close = () => dlg.remove();

  dlg.querySelector('#edit-cancel').addEventListener('click', close);
  dlg.querySelector('#edit-save').addEventListener('click', async () => {
    const newText = input.value.trim();
    if (!newText) return;
    try {
      let encrypted, iv;
      if (currentChatType === 'private' && currentChatWith) {
        ({ encrypted, iv } = await encryptPrivateTextE2EE(currentChatWith, newText));
      } else {
        ({ encrypted, iv } = await Crypto.encrypt(newText));
      }

      if (currentChatType === 'private' && currentChatId) {
        socket.emit('private-msg-edit', { chatId: currentChatId, msgId, newEncrypted: encrypted, newIv: iv }, res => {
          if (res.ok) {
            if (content) content.innerHTML = escapeHtml(newText) + ' <span style="font-size:10px;opacity:0.5">(ред.)</span>';
            close();
          } else showToast('❌ Ошибка редактирования');
        });
      } else if (currentRoomId) {
        socket.emit('room-msg-edit', { roomId: currentRoomId, msgId, newEncrypted: encrypted, newIv: iv }, res => {
          if (res.ok) {
            if (content) content.innerHTML = escapeHtml(newText) + ' <span style="font-size:10px;opacity:0.5">(ред.)</span>';
            close();
          } else showToast('❌ Ошибка редактирования');
        });
      }
    } catch (_) {
      showToast('❌ Ошибка шифрования');
    }
  });

  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  setTimeout(() => input.focus(), 200);
}

function initLongPress() {
  if (!chatMessages) return;
  chatMessages.addEventListener('touchstart', e => {
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    longPressTarget = msgEl;
    longPressTimer = setTimeout(() => {
      if (longPressTarget === msgEl) {
        if (navigator.vibrate) navigator.vibrate(50);
        openMsgContextMenu(msgEl.id, msgEl);
      }
    }, 500);
  }, { passive: true });

  chatMessages.addEventListener('touchend', () => { clearTimeout(longPressTimer); longPressTarget = null; }, { passive: true });
  chatMessages.addEventListener('touchmove', () => { clearTimeout(longPressTimer); longPressTarget = null; }, { passive: true });

  chatMessages.addEventListener('contextmenu', e => {
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    e.preventDefault();
    openMsgContextMenu(msgEl.id, msgEl);
  });
}

// ───────────────────────────────────────────────
//  ПРОГРЕСС ЗАГРУЗКИ
// ───────────────────────────────────────────────
function getFileIcon(fileName, mimeType) {
  if (!mimeType && !fileName) return '📎';
  const mime = (mimeType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  if (mime.startsWith('image/')) return '🖼';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎤';
  if (name.endsWith('.pdf')) return '📄';
  if (name.endsWith('.zip') || name.endsWith('.rar')) return '🗜';
  if (name.endsWith('.doc') || name.endsWith('.docx')) return '📝';
  return '📎';
}

function showUploadProgress(fileName, mimeType) {
  hideUploadProgress();
  const el = document.createElement('div');
  el.id = 'upload-progress-wrap';
  const icon = getFileIcon(fileName, mimeType);
  el.innerHTML = `
    <div class="upload-progress-header">
      <div class="upload-progress-icon">${icon}</div>
      <div class="upload-progress-info">
        <div class="upload-progress-name">${escapeHtml(fileName || 'файл')}</div>
        <div class="upload-progress-pct" id="upload-progress-pct">Подготовка…</div>
      </div>
    </div>
    <div class="upload-progress-track"><div id="upload-progress-fill"></div></div>`;
  const tb = document.getElementById('tg-bottom');
  if (tb) tb.insertBefore(el, tb.firstChild);
  return el;
}

function updateUploadProgress(pct) {
  const fill = document.getElementById('upload-progress-fill');
  const text = document.getElementById('upload-progress-pct');
  if (fill) fill.style.width = Math.round(pct) + '%';
  if (text) text.textContent = pct < 100 ? ('Загрузка ' + Math.round(pct) + '%…') : '✅ Отправлено!';
}

function hideUploadProgress() {
  const el = document.getElementById('upload-progress-wrap');
  if (!el) return;
  el.style.transition = 'opacity 0.3s, transform 0.3s';
  el.style.opacity = '0';
  el.style.transform = 'translateY(-4px)';
  setTimeout(() => el.remove(), 350);
}

function showChatUploadStatus(type) {
  let badge = document.getElementById('chat-upload-status');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'chat-upload-status';
    badge.style.cssText = 'padding:6px 12px;font-size:12px;color:var(--sub);text-align:center;';
    const tb = document.getElementById('tg-bottom');
    tb?.insertBefore(badge, tb.firstChild);
  }
  const map = { image: '🖼 Отправляем фото…', video: '🎬 Отправляем видео…', file: '📎 Отправляем файл…', voice: '🎤 Отправляем голосовое…' };
  badge.textContent = map[type] || '⏳ Отправка…';
}
function hideChatUploadStatus() {
  document.getElementById('chat-upload-status')?.remove();
}

// ───────────────────────────────────────────────
//  E2EE helper для private (text+bytes)
// ───────────────────────────────────────────────
async function encryptPrivateTextE2EE(peerId, text) {
  // Приводим peerId к нижнему регистру для consistency
  const normalizedPeerId = peerId ? String(peerId).toLowerCase().trim() : '';
  
  // Пробуем E2EE сессию
  if (window.E2EESession?.encryptTextForPeer && normalizedPeerId) {
    try {
      return await window.E2EESession.encryptTextForPeer(normalizedPeerId, text);
    } catch (e) {
      console.warn('[E2EE] encryptTextForPeer failed for peer', normalizedPeerId, e);
      // Fallback на обычное шифрование
    }
  }
  
  // Fallback на обычное шифрование
  return Crypto.encrypt(text);
}

async function decryptPrivateTextE2EE(peerId, encrypted, iv) {
  // Приводим peerId к нижнему регистру для consistency
  const normalizedPeerId = peerId ? String(peerId).toLowerCase().trim() : '';
  
  // Сначала пробуем E2EE сессию
  if (window.E2EESession?.decryptTextFromPeer && normalizedPeerId) {
    try {
      return await window.E2EESession.decryptTextFromPeer(normalizedPeerId, encrypted, iv);
    } catch (e) {
      console.warn('[E2EE] decryptTextFromPeer failed for peer', normalizedPeerId, e);
      // Пробуем расшифровать своими ключами (для своих сообщений)
      if (window.E2EESession?.decryptOwnTextForPeer) {
        try {
          return await window.E2EESession.decryptOwnTextForPeer(normalizedPeerId, encrypted, iv);
        } catch (e2) {
          console.warn('[E2EE] decryptOwnTextForPeer also failed', e2);
        }
      }
    }
  }
  
  // Fallback на обычное шифрование
  try {
    return await Crypto.decryptText(encrypted, iv);
  } catch (e) {
    console.error('[Crypto] decryptText failed', e);
    throw e; // Пробрасываем ошибку дальше
  }
}

async function encryptPrivateBytesE2EE(peerId, bytesLike) {
  // Приводим peerId к нижнему регистру для consistency
  const normalizedPeerId = peerId ? String(peerId).toLowerCase().trim() : '';
  if (window.E2EESession?.encryptBytesForPeer && normalizedPeerId) {
    return window.E2EESession.encryptBytesForPeer(normalizedPeerId, bytesLike);
  }
  return Crypto.encrypt(bytesLike);
}

async function decryptPrivateBlobE2EE(peerId, encrypted, iv, mime) {
  // Приводим peerId к нижнему регистру для consistency
  const normalizedPeerId = peerId ? String(peerId).toLowerCase().trim() : '';
  if (window.E2EESession?.decryptBlobFromPeer && normalizedPeerId) {
    try { return await window.E2EESession.decryptBlobFromPeer(normalizedPeerId, encrypted, iv, mime); }
    catch (_) {}
  }
  return Crypto.decryptBlob(encrypted, iv, mime);
}

// ───────────────────────────────────────────────
//  ОТПРАВКА ТЕКСТА
// ───────────────────────────────────────────────
async function sendTextMessage() {
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;

  stopMyTyping();
  stopPrivateTyping();
  if (btnSend) btnSend.disabled = true;

  const currentReply = replyToMsg ? { ...replyToMsg } : null;

  try {
    if (currentChatType === 'private' && currentChatId) {
      const peerId = currentChatWith || '';
      const { encrypted, iv } = await encryptPrivateTextE2EE(peerId, text);
      const seq = ++outgoingSeq;

      const domId = appendMessage({
        nickname: myNickname, text, type: 'text', timestamp: Date.now(),
        mine: true, status: 'ok', msgStatus: 'sending', replyTo: currentReply
      });
      msgIdToDomId.set('pending-' + seq, domId);

      chatInput.value = '';
      chatInput.style.height = 'auto';
      if (typeof cancelReply === 'function') cancelReply();

      socket.emit('private-message', { chatId: currentChatId, encrypted, iv, type: 'text', seq, replyTo: currentReply }, res => {
        if (res && res.msgId) {
          const d = msgIdToDomId.get('pending-' + seq);
          if (d) {
            msgIdToDomId.delete('pending-' + seq);
            msgIdToDomId.set(res.msgId, d);
            updateMsgStatus(res.msgId, 'sent');
          }
        }
      });

    } else if (currentRoomId) {
      const { encrypted, iv } = await Crypto.encrypt(text);
      const seq = ++outgoingSeq;

      const domId = appendMessage({
        from: socket.id, nickname: myNickname, text, type: 'text',
        timestamp: Date.now(), mine: true, status: 'ok',
        msgStatus: 'sending', replyTo: currentReply
      });
      seqToMsgId.set(seq, domId);

      chatInput.value = '';
      chatInput.style.height = 'auto';
      if (typeof cancelReply === 'function') cancelReply();

      socket.emit('chat-message', { encrypted, iv, type: 'text', seq, replyTo: currentReply });
    }

    if (btnVoiceRecord) btnVoiceRecord.style.display = 'flex';
  } catch (e) {
    showToast('❌ Ошибка отправки: ' + e.message);
  } finally {
    if (btnSend) btnSend.disabled = false;
  }
}

// ───────────────────────────────────────────────
//  ГОЛОСОВЫЕ СООБЩЕНИЯ
// ───────────────────────────────────────────────
async function sendVoiceMessage(blob, duration, mimeType) {
  try {
    const ab = await blob.arrayBuffer();

    let encrypted, iv;
    if (currentChatType === 'private' && currentChatWith) {
      ({ encrypted, iv } = await encryptPrivateBytesE2EE(currentChatWith, ab));
    } else {
      ({ encrypted, iv } = await Crypto.encrypt(ab));
    }

    const localUrl = URL.createObjectURL(new Blob([ab], { type: mimeType }));
    const seq = ++outgoingSeq;

    const payload = {
      encrypted, iv, type: 'voice', seq, duration, mimeType,
      fileName: 'voice.ogg', fileSize: blob.size
    };

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
          if (d) {
            msgIdToDomId.delete('pending-' + seq);
            msgIdToDomId.set(res.msgId, d);
            updateMsgStatus(res.msgId, 'sent');
          }
        }
      });
    } else if (currentRoomId) {
      socket.emit('chat-message', payload);
    }
  } catch (e) {
    showToast('❌ Ошибка отправки голосового: ' + e.message);
  }
}

async function startVoiceRecording() {
  if (isVoiceRecording) return;
  try {
    voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (_) {
    showToast('❌ Нет доступа к микрофону');
    return;
  }

  isVoiceRecording = true;
  voiceRecordChunks = [];
  voiceRecordSeconds = 0;

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg');

  voiceRecorder = new MediaRecorder(voiceRecordStream, { mimeType });

  voiceRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) voiceRecordChunks.push(e.data);
  };

  voiceRecorder.onstop = async () => {
    const blob = new Blob(voiceRecordChunks, { type: mimeType });
    if (voiceRecordStream) {
      voiceRecordStream.getTracks().forEach(t => t.stop());
      voiceRecordStream = null;
    }
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
  isVoiceRecording = false;
  clearInterval(voiceRecordInterval);

  if (voiceRecorder && voiceRecorder.state !== 'inactive') voiceRecorder.stop();

  if (btnVoiceRecord) btnVoiceRecord.classList.remove('recording');
  if (voiceRecordTimer) voiceRecordTimer.classList.remove('visible');
  if (chatInput) chatInput.style.display = '';
  if (voiceRecordTime) voiceRecordTime.textContent = '0:00';
}

function stopAndCancelVoice() {
  if (!isVoiceRecording) return;
  isVoiceRecording = false;
  clearInterval(voiceRecordInterval);

  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.ondataavailable = null;
    voiceRecorder.onstop = null;
    voiceRecorder.stop();
  }

  if (voiceRecordStream) {
    voiceRecordStream.getTracks().forEach(t => t.stop());
    voiceRecordStream = null;
  }

  if (btnVoiceRecord) btnVoiceRecord.classList.remove('recording');
  if (voiceRecordTimer) voiceRecordTimer.classList.remove('visible');
  if (chatInput) chatInput.style.display = '';
  if (voiceRecordTime) voiceRecordTime.textContent = '0:00';
}

function stopVoiceRecording() {
  if (isVoiceRecording) stopAndCancelVoice();
}

// ───────────────────────────────────────────────
//  ФАЙЛЫ / МЕДИА
// ───────────────────────────────────────────────
async function sendMediaBlob(blob, mimeType, fileName, type, caption) {
  showUploadProgress(fileName, mimeType);
  showChatUploadStatus(type);

  try {
    const ab = await blob.arrayBuffer();

    let fakeProgress = 0;
    const progressInterval = setInterval(() => {
      fakeProgress = Math.min(fakeProgress + 5, 90);
      updateUploadProgress(fakeProgress);
    }, 100);

    let encrypted, iv;
    if (currentChatType === 'private' && currentChatWith) {
      ({ encrypted, iv } = await encryptPrivateBytesE2EE(currentChatWith, ab));
    } else {
      ({ encrypted, iv } = await Crypto.encrypt(ab));
    }

    clearInterval(progressInterval);
    updateUploadProgress(95);

    // Шифруем подпись если есть
    let captionEncrypted = null, captionIv = null;
    if (caption && caption.trim()) {
      try {
        if (currentChatType === 'private' && currentChatWith) {
          ({ encrypted: captionEncrypted, iv: captionIv } = await encryptPrivateTextE2EE(currentChatWith, caption.trim()));
        } else {
          ({ encrypted: captionEncrypted, iv: captionIv } = await Crypto.encrypt(caption.trim()));
        }
      } catch (_) {}
    }

    const localUrl = URL.createObjectURL(new Blob([ab], { type: mimeType }));
    const seq = ++outgoingSeq;

    const payload = {
      encrypted, iv, type, seq,
      fileName: fileName || 'file',
      fileSize: blob.size,
      mimeType,
      captionEncrypted: captionEncrypted || null,
      captionIv: captionIv || null
    };

    const domId = appendMessage({
      from: socket.id, nickname: myNickname, type, localUrl,
      fileName: fileName || 'file', fileSize: blob.size, mimeType,
      caption: caption || null,
      timestamp: Date.now(), mine: true, status: 'ok', msgStatus: 'sending'
    });
    msgIdToDomId.set('pending-' + seq, domId);

    if (currentChatType === 'private' && currentChatId) {
      socket.emit('private-message', { chatId: currentChatId, ...payload }, res => {
        updateUploadProgress(100);
        setTimeout(hideUploadProgress, 500);
        hideChatUploadStatus();

        if (res && !res.ok) {
          showToast('❌ Ошибка: ' + (res.error === 'file_too_large' ? 'Файл слишком большой' : res.error));
        }

        if (res && res.msgId) {
          const d = msgIdToDomId.get('pending-' + seq);
          if (d) {
            msgIdToDomId.delete('pending-' + seq);
            msgIdToDomId.set(res.msgId, d);
            updateMsgStatus(res.msgId, 'sent');
          }
        }
      });
    } else if (currentRoomId) {
      socket.emit('chat-message', payload);
      updateUploadProgress(100);
      setTimeout(hideUploadProgress, 500);
      hideChatUploadStatus();
    }
  } catch (e) {
    hideUploadProgress();
    hideChatUploadStatus();
    showToast('❌ Ошибка отправки: ' + e.message);
  }
}
// ───────────────────────────────────────────────
//  ВХОДЯЩИЕ СООБЩЕНИЯ (ЛИЧНЫЕ)
// ───────────────────────────────────────────────
socket.on('private-message', async data => {
  const isCurrentChat = currentChatType === 'private' && currentChatId === data.chatId;

  // Проверка на дублирование: если сообщение от текущего пользователя, пропускаем
  const isFromMe = data.fromNick === myNickname || data.from === myUsername;
  if (isFromMe && isCurrentChat) {
    // Сообщение уже добавлено локально при отправке, не добавляем дубль
    // Но обновим статус прочтения, если нужно
    if (data.id) socket.emit('private-msg-read', { chatId: data.chatId, msgId: data.id });
    return;
  }

  // Проверка на дублирование по msgId (если сообщение уже есть в чате)
  if (data.id && msgIdToDomId.has(data.id)) {
    // Дубликат, игнорируем
    return;
  }

  if (!isCurrentChat) {
    // Если сообщение от меня, не показываем уведомление
    if (isFromMe) return;
    
    const setting = getNotifSetting(data.chatId);
    if (setting !== 'none') {
      showToast('💬 ' + (data.fromNick || '?') + ': новое сообщение', 4000, () => {
        enterPrivateChat(data.chatId, data.fromNick, data.fromAvatar);
      });
      if (setting !== 'mute') playMsgSound(data.chatId);
    }
    addUnread(data.chatId, 1);
    showBrowserNotif('💬 ' + (data.fromNick || '?'), 'новое сообщение', data.chatId);
    loadPrivateChatsList();
    return;
  }

  if (getNotifSetting(data.chatId) !== 'none') playMsgSound(data.chatId);
  if (data.id) socket.emit('private-msg-read', { chatId: data.chatId, msgId: data.id });

  const peerIdRaw = data.from || data.fromNick || currentChatWith || '';
  const peerId = peerIdRaw.toLowerCase().trim();

  if (data.type === 'voice') {
    // Проверка на дублирование для голосовых сообщений
    if (isFromMe || (data.id && msgIdToDomId.has(data.id))) {
      return;
    }
    try {
      const blob = await decryptPrivateBlobE2EE(peerId, data.encrypted, data.iv, data.mimeType || 'audio/webm');
      const localUrl = URL.createObjectURL(blob);
      appendMessage({
        id: data.id, nickname: data.fromNick, type: 'voice',
        duration: data.duration || 0, timestamp: data.timestamp,
        mine: false, status: 'ok', localUrl, mimeType: data.mimeType,
        peerId
      });
    } catch (_) {
      appendMessage({
        id: data.id, nickname: data.fromNick, type: 'voice',
        duration: data.duration || 0, timestamp: data.timestamp,
        mine: false, status: 'error', encrypted: data.encrypted, iv: data.iv, mimeType: data.mimeType,
        peerId
      });
    }
    return;
  }

  const domId = appendMessage({
    id: data.id, nickname: data.fromNick, type: data.type,
    fileName: data.fileName, fileSize: data.fileSize, mimeType: data.mimeType,
    timestamp: data.timestamp, mine: false, status: 'decrypting',
    replyTo: data.replyTo || null, peerId
  });

  try {
    if (data.type === 'text') {
      const text = await decryptPrivateTextE2EE(peerId, data.encrypted, data.iv);
      updateMessage(domId, { text, status: 'ok' });
      showBrowserNotif('💬 ' + (data.fromNick || '?'), text, data.chatId);
    } else {
      const mime = data.mimeType || 'application/octet-stream';
      const blob = await decryptPrivateBlobE2EE(peerId, data.encrypted, data.iv, mime);
      // Расшифровываем подпись если есть
      let caption = null;
      if (data.captionEncrypted && data.captionIv) {
        try {
          caption = await decryptPrivateTextE2EE(peerId, data.captionEncrypted, data.captionIv);
        } catch (e) {
          console.warn('[private-message] caption decrypt error', e);
        }
      }
      updateMessage(domId, { localUrl: URL.createObjectURL(blob), status: 'ok', caption });
    }
  } catch (e) {
    console.error('[private-message] Decryption failed:', e, 'peerId:', peerId, 'type:', data.type);
    
    // Пробуем альтернативные методы дешифрования
    if (data.type === 'text') {
      try {
        // Пробуем использовать другой peerId (без нормализации)
        const altPeerId = data.fromNick || data.from || currentChatWith || '';
        if (altPeerId && altPeerId !== peerId) {
          console.log('[private-message] Trying alternative peerId:', altPeerId);
          const text = await decryptPrivateTextE2EE(altPeerId, data.encrypted, data.iv);
          updateMessage(domId, { text, status: 'ok' });
          console.log('[private-message] Decryption succeeded with alternative peerId');
          return;
        }
      } catch (e2) {
        console.warn('[private-message] Alternative decryption also failed:', e2);
      }
    }
    
    // Не обновлять статус на ошибку, если сообщение уже успешно расшифровано
    const msgEl = document.getElementById(domId);
    if (msgEl) {
      const statusEl = msgEl.querySelector('.msg-decrypt-status');
      if (!statusEl || !statusEl.classList.contains('ok')) {
        updateMessage(domId, { status: 'error' });
      }
    } else {
      updateMessage(domId, { status: 'error' });
    }
    
    // Показываем уведомление пользователю
    if (typeof showToast === 'function') {
      showToast('⚠️ Не удалось расшифровать сообщение', 3000);
    }
  }

  loadPrivateChatsList();
});

socket.on('private-msg-deleted', ({ chatId, msgId, deleteFor }) => {
  if (currentChatId !== chatId && deleteFor !== 'me') return;
  for (const [mId, domId] of msgIdToDomId) {
    if (mId === msgId) {
      const el = document.getElementById(domId);
      if (el) {
        if (deleteFor === 'all') {
          el.innerHTML = `<div style="font-size:12px;color:var(--sub);font-style:italic;padding:4px 8px">🗑 Сообщение удалено</div>`;
          el.style.background = 'transparent';
          el.style.border = 'none';
        } else {
          el.remove();
        }
      }
      msgIdToDomId.delete(mId);
      break;
    }
  }
});

socket.on('private-msg-edited', async ({ chatId, msgId, newEncrypted, newIv }) => {
  if (currentChatId !== chatId) return;
  const domId = msgIdToDomId.get(msgId);
  if (!domId) return;
  try {
    const peerId = currentChatWith || '';
    const text = await decryptPrivateTextE2EE(peerId, newEncrypted, newIv);
    const el = document.getElementById(domId);
    if (el) {
      const c = el.querySelector('.msg-content');
      if (c) c.innerHTML = escapeHtml(text) + ' <span style="font-size:10px;opacity:0.5">(ред.)</span>';
    }
  } catch (_) {}
});

// ───────────────────────────────────────────────
//  ВХОДЯЩИЕ СООБЩЕНИЯ (ГРУППЫ)
// ───────────────────────────────────────────────
socket.on('room-msg-deleted', ({ roomId, msgId, deleteFor }) => {
  if (currentRoomId !== roomId) return;
  for (const [mId, domId] of msgIdToDomId) {
    if (mId === msgId) {
      const el = document.getElementById(domId);
      if (el) {
        if (deleteFor === 'all') {
          el.innerHTML = `<div style="font-size:12px;color:var(--sub);font-style:italic;padding:4px 8px">🗑 Сообщение удалено</div>`;
          el.style.background = 'transparent';
          el.style.border = 'none';
        } else {
          el.remove();
        }
      }
      msgIdToDomId.delete(mId);
      break;
    }
  }
});

socket.on('room-msg-edited', async ({ roomId, msgId, newEncrypted, newIv }) => {
  if (currentRoomId !== roomId) return;
  const domId = msgIdToDomId.get(msgId);
  if (!domId) return;
  try {
    const text = await Crypto.decryptText(newEncrypted, newIv);
    const el = document.getElementById(domId);
    if (el) {
      const c = el.querySelector('.msg-content');
      if (c) c.innerHTML = escapeHtml(text) + ' <span style="font-size:10px;opacity:0.5">(ред.)</span>';
    }
  } catch (_) {}
});

socket.on('chat-message', async data => {
  const chatId = currentRoomId;
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
    timestamp: data.timestamp, mine: false, status: 'decrypting',
    replyTo: data.replyTo || null
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
      // Расшифровываем подпись если есть
      let caption = null;
      if (data.captionEncrypted && data.captionIv) {
        try {
          caption = await Crypto.decryptText(data.captionEncrypted, data.captionIv);
        } catch (e) {
          console.warn('[chat-message] caption decrypt error', e);
        }
      }
      updateMessage(domId, { localUrl: URL.createObjectURL(blob), status: 'ok', caption });
      if (document.visibilityState !== 'visible') addUnread(chatId, 1);
    }
  } catch (_) {
    // Не обновлять статус на ошибку, если сообщение уже успешно расшифровано
    const msgEl = document.getElementById(domId);
    if (msgEl) {
      const statusEl = msgEl.querySelector('.msg-decrypt-status');
      if (!statusEl || !statusEl.classList.contains('ok')) {
        updateMessage(domId, { status: 'error' });
      }
    } else {
      updateMessage(domId, { status: 'error' });
    }
  }
});

// ───────────────────────────────────────────────
//  РЕНДЕР СООБЩЕНИЙ
// ───────────────────────────────────────────────
function appendMessage(msg) {
  if (!chatMessages) return 'msg-0';
  const id = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.id = id;
  div.className = 'msg ' + (msg.mine ? 'mine' : 'theirs');
  div.dataset.type = msg.type || 'text';
  div.dataset.mimeType = msg.mimeType || '';
  div.dataset.fileName = msg.fileName || '';
  div.dataset.fileSize = String(msg.fileSize || '');
  div.dataset.duration = String(msg.duration || '0');
  div.dataset.encrypted = msg.encrypted || '';
  div.dataset.iv = msg.iv || '';
  div.dataset.msgId = msg.id || '';
  div.dataset.peerId = msg.peerId || '';
  div.dataset.caption = msg.caption || '';
  div.innerHTML = buildMsgHTML(msg);
  chatMessages.appendChild(div);
  scrollToBottom();
  bindMediaEvents(div);
  return id;
}

function appendSystemMsg(text) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = 'date-divider';
  div.textContent = text;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function updateMessage(id, updates) {
  const div = document.getElementById(id);
  if (!div) return;

  const content = div.querySelector('.msg-content');
  if (content) {
    const merged = {
      type: div.dataset.type,
      mimeType: div.dataset.mimeType,
      fileName: div.dataset.fileName,
      fileSize: div.dataset.fileSize,
      duration: div.dataset.duration,
      caption: div.dataset.caption || null,
      ...updates
    };
    // Сохраняем caption в dataset для последующих обновлений
    if (updates.caption !== undefined) div.dataset.caption = updates.caption || '';
    content.innerHTML = buildContentHTML(merged);
    bindMediaEvents(div);
  }

  const st = div.querySelector('.msg-decrypt-status');
  if (st) {
    if (updates.status === 'ok')   { st.className = 'msg-decrypt-status ok'; st.textContent = '🔓'; }
    if (updates.status === 'error'){ st.className = 'msg-decrypt-status err'; st.textContent = '⚠️'; }
    if (updates.status === 'decrypting') st.textContent = '⏳';
  }

  scrollToBottom();
}

function buildReplyHTML(replyTo) {
  if (!replyTo || !replyTo.id) return '';
  return `
    <div class="msg-reply-block" data-reply-id="${replyTo.id}"
      style="background:rgba(255,255,255,0.05);border-left:3px solid var(--accent2);border-radius:8px;padding:5px 10px;margin-bottom:6px;cursor:pointer;font-size:12px;line-height:1.5;max-height:52px;overflow:hidden;">
      <div style="color:var(--accent2);font-weight:600;font-size:11px">${escapeHtml(replyTo.nickname || '?')}</div>
      <div style="opacity:0.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(replyTo.text || '…')}</div>
    </div>`;
}

function buildMsgHTML(msg) {
  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' });
  const sender = msg.mine ? '' : `<div class="msg-sender">👤 ${escapeHtml(msg.nickname || '?')}</div>`;
  const stText  = msg.status === 'ok' ? '🔓' : msg.status === 'error' ? '⚠️' : '⏳';
  const stClass = msg.status === 'ok' ? 'ok' : msg.status === 'error' ? 'err' : '';
  const st = msg.mine ? '' : `<div class="msg-decrypt-status ${stClass}">${stText}</div>`;
  const ticks = buildStatusTicks(msg.msgStatus || (msg.mine ? 'sent' : null), msg.mine);
  const edited = msg.edited ? `<span style="font-size:10px;opacity:0.5"> (ред.)</span>` : '';
  const reply = buildReplyHTML(msg.replyTo);

  return `
    ${sender}
    ${reply}
    <div class="msg-content">${buildContentHTML(msg)}${edited}</div>
    <div class="msg-meta" style="display:flex;align-items:center;justify-content:flex-end;gap:4px;">
      <span>${time}</span>${ticks}
    </div>
    ${st}`;
}

function buildCaptionHTML(caption) {
  if (!caption) return '';
  return `<div class="msg-caption" style="margin-top:6px;font-size:14px;color:var(--text);line-height:1.5;word-break:break-word;">${escapeHtml(caption)}</div>`;
}

function buildContentHTML(msg) {
  if (msg.type === 'text') {
    // Если текст есть, показываем его
    if (msg.text) return escapeHtml(msg.text);
    // Если текста нет и статус не 'ok', показываем placeholder
    if (msg.status !== 'ok') return '<span style="opacity:0.6;font-style:italic">[зашифровано]</span>';
    // Иначе пустая строка
    return '';
  }

  if (msg.type === 'image') {
    const caption = buildCaptionHTML(msg.caption);
    return msg.localUrl
      ? `<img class="msg-media" src="${msg.localUrl}" alt="фото" loading="lazy">${caption}`
      : `<div style="display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px"><span>🖼</span><span>Загрузка…</span></div>`;
  }

  if (msg.type === 'video') {
    const caption = buildCaptionHTML(msg.caption);
    return msg.localUrl
      ? `<video class="msg-media" src="${msg.localUrl}" controls playsinline></video>${caption}`
      : `<div style="display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px"><span>🎬</span><span>Загрузка…</span></div>`;
  }

  if (msg.type === 'file') {
    const size = msg.fileSize ? formatSize(parseInt(msg.fileSize)) : '';
    const caption = buildCaptionHTML(msg.caption);
    return msg.localUrl
      ? `<div class="msg-file">
          <span class="msg-file-icon">📄</span>
          <div class="msg-file-info">
            <div class="msg-file-name">${escapeHtml(msg.fileName || 'файл')}</div>
            <div class="msg-file-size">${size}</div>
          </div>
          <a class="msg-file-dl" href="${msg.localUrl}" download="${escapeHtml(msg.fileName || 'file')}">⬇️</a>
         </div>${caption}`
      : `<div style="display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px"><span>📎</span><span>${escapeHtml(msg.fileName || 'файл')} · Загрузка…</span></div>`;
  }

  if (msg.type === 'voice') return buildVoiceMessageHTML(msg);

  return '';
}

function buildVoiceMessageHTML(msg) {
  const dur = parseInt(msg.duration) || 0;
  const durStr = formatDuration(dur);
  const vmId = 'vm-' + Math.random().toString(36).slice(2);
  const bars = Array.from({ length: 20 }, () => {
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

  return `<div class="voice-msg" id="${vmId}" data-encrypted="${msg.encrypted || ''}" data-iv="${msg.iv || ''}" data-mime="${msg.mimeType || 'audio/webm'}" data-peer="${msg.peerId || ''}" data-dur="${dur}">
    <button class="voice-msg-btn voice-decrypt-btn">▶️</button>
    <div class="voice-msg-waveform">${bars}</div>
    <span class="voice-msg-duration">${durStr}</span>
  </div>`;
}

function playVoiceMsg(btn, url, wrap) {
  if (!wrap) wrap = btn.closest('.voice-msg');

  if (currentVoiceAudio && !currentVoiceAudio.paused) {
    currentVoiceAudio.pause();
    currentVoiceAudio.currentTime = 0;
    document.querySelectorAll('.voice-msg-btn').forEach(b => b.textContent = '▶️');
    document.querySelectorAll('.voice-msg-bar').forEach(b => b.classList.remove('active'));
    if (currentVoiceAudio._url === url) {
      currentVoiceAudio = null;
      currentVoiceBtn = null;
      return;
    }
  }

  const audio = new Audio(url);
  audio._url = url;
  currentVoiceAudio = audio;
  currentVoiceBtn = btn;
  btn.textContent = '⏸️';

  audio.play().then(() => {
    const bars = wrap ? [...wrap.querySelectorAll('.voice-msg-bar')] : [];
    const durEl = wrap ? wrap.querySelector('.voice-msg-duration') : null;
    const origDur = parseInt(wrap?.dataset.dur || '0');

    audio.ontimeupdate = () => {
      const pct = audio.duration ? audio.currentTime / audio.duration : 0;
      const active = Math.floor(pct * bars.length);
      bars.forEach((b, i) => b.classList.toggle('active', i <= active));
      if (durEl) durEl.textContent = formatDuration(Math.floor(audio.currentTime));
    };

    audio.onended = () => {
      btn.textContent = '▶️';
      bars.forEach(b => b.classList.remove('active'));
      if (durEl) durEl.textContent = formatDuration(origDur);
      currentVoiceAudio = null;
      currentVoiceBtn = null;
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
    btn.addEventListener('click', async function () {
      const wrap = btn.closest('.voice-msg');
      if (!wrap) return;
      const enc = wrap.dataset.encrypted;
      const iv = wrap.dataset.iv;
      const mime = wrap.dataset.mime || 'audio/webm';
      const peerId = wrap.dataset.peer || '';
      if (!enc || !iv) return;
      btn.textContent = '⏳';
      try {
        let blob;
        if (peerId) blob = await decryptPrivateBlobE2EE(peerId, enc, iv, mime);
        else blob = await Crypto.decryptBlob(enc, iv, mime);

        const url = URL.createObjectURL(blob);
        btn.classList.remove('voice-decrypt-btn');
        btn.dataset.url = url;
        btn.textContent = '▶️';
        btn.addEventListener('click', () => playVoiceMsg(btn, url, wrap));
        playVoiceMsg(btn, url, wrap);
      } catch (_) {
        btn.textContent = '❌';
        showToast('Ошибка воспроизведения');
      }
    });
  });

  container.querySelectorAll('.msg-reply-block').forEach(block => {
    block.addEventListener('click', () => {
      const replyId = block.dataset.replyId;
      if (!replyId) return;

      let target = document.querySelector(`[data-msg-id="${replyId}"]`);
      if (!target) {
        const domId = msgIdToDomId.get(replyId);
        if (domId) target = document.getElementById(domId);
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '2px solid var(--accent)';
        setTimeout(() => { target.style.outline = ''; }, 1500);
      }
    });
  });
}

function openLightbox(type, src) {
  if (!lightboxContent || !lightbox) return;
  lightboxContent.innerHTML = type === 'img'
    ? `<img src="${src}" alt="">`
    : `<video src="${src}" controls autoplay playsinline style="max-width:95vw;max-height:85vh"></video>`;
  lightbox.classList.add('open');
}

// ───────────────────────────────────────────────
//  РЕАКЦИИ
// ───────────────────────────────────────────────
function getClientReactions(msgId) {
  return clientReactions.get(msgId) || {};
}
function setClientReactions(msgId, reactions) {
  if (reactions && Object.keys(reactions).length > 0) clientReactions.set(msgId, reactions);
  else clientReactions.delete(msgId);
}

function buildReactionsHTML(msgId, reactions) {
  if (!reactions || !Object.keys(reactions).length) return '';
  const myLower = myNickname.toLowerCase();

  const html = Object.entries(reactions)
    .filter(([, users]) => users.length > 0)
    .map(([emoji, users]) => {
      const iMine = users.includes(myLower);
      return `<button class="reaction-btn${iMine ? ' mine' : ''}" data-msgid="${msgId}" data-emoji="${emoji}" title="${users.join(', ')}"
        style="display:inline-flex;align-items:center;gap:3px;padding:3px 7px;border-radius:12px;border:1px solid ${iMine?'rgba(124,92,191,0.5)':'rgba(255,255,255,0.1)'};background:${iMine?'rgba(124,92,191,0.2)':'rgba(255,255,255,0.05)'};font-size:13px;cursor:pointer;color:var(--text);">
        ${emoji} <span style="font-size:11px;opacity:0.8">${users.length}</span>
      </button>`;
    }).join('');

  return html
    ? `<div class="msg-reactions" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;">${html}</div>`
    : '';
}
function openReactionPicker(msgId, msgEl) {
  document.querySelector('.reaction-picker-popup')?.remove();

  const popup = document.createElement('div');
  popup.className = 'reaction-picker-popup';

  const rect = msgEl.getBoundingClientRect();
  const isMine = msgEl.classList.contains('mine');
  const left = isMine ? Math.max(8, rect.right - 320) : Math.min(window.innerWidth - 328, rect.left);
  const top  = rect.top > 120 ? rect.top - 60 : rect.bottom + 8;

  popup.style.cssText = `position:fixed;left:${left}px;top:${top}px;z-index:4000;background:var(--surface2);border-radius:24px;border:1px solid rgba(124,92,191,0.25);box-shadow:0 8px 32px rgba(0,0,0,0.6);padding:10px 12px;display:flex;gap:6px;flex-wrap:wrap;max-width:316px;backdrop-filter:blur(16px);animation:toastIn 0.2s cubic-bezier(0.34,1.2,0.64,1);`;

  popup.innerHTML = REACTION_EMOJIS.map(emoji =>
    `<button class="rp-btn" data-emoji="${emoji}" style="width:36px;height:36px;border:none;background:none;font-size:22px;cursor:pointer;border-radius:10px;">${emoji}</button>`
  ).join('');

  document.body.appendChild(popup);

  popup.querySelectorAll('.rp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      popup.remove();
      toggleReaction(msgId, btn.dataset.emoji, msgEl);
    });
  });

  setTimeout(() => {
    document.addEventListener('click', function h(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', h);
      }
    });
  }, 50);
}

function toggleReaction(msgId, emoji, msgEl) {
  const reactions = getClientReactions(msgId);
  const myLower = myNickname.toLowerCase();
  const users = reactions[emoji] || [];
  const iMine = users.includes(myLower);

  const chatId = currentChatType === 'private' ? currentChatId : null;
  const roomId = currentChatType === 'group' ? currentRoomId : null;

  if (iMine) {
    socket.emit('remove-reaction', { msgId, emoji, chatId, roomId }, res => {
      if (res.ok) updateMsgReactions(msgId, res.reactions, msgEl);
    });
  } else {
    socket.emit('add-reaction', { msgId, emoji, chatId, roomId }, res => {
      if (res.ok) updateMsgReactions(msgId, res.reactions, msgEl);
    });
  }
}

function updateMsgReactions(msgId, reactions, msgEl) {
  setClientReactions(msgId, reactions);

  if (!msgEl) {
    msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!msgEl) {
      for (const [, domId] of msgIdToDomId) {
        const el = document.getElementById(domId);
        if (el && el.dataset.msgId === msgId) { msgEl = el; break; }
      }
    }
  }
  if (!msgEl) return;

  const reactionsEl = msgEl.querySelector('.msg-reactions');
  const newHTML = buildReactionsHTML(msgId, reactions);

  if (reactionsEl) {
    if (newHTML) reactionsEl.outerHTML = newHTML;
    else reactionsEl.remove();
  } else if (newHTML) {
    const meta = msgEl.querySelector('.msg-meta');
    if (meta) meta.insertAdjacentHTML('beforebegin', newHTML);
    else msgEl.insertAdjacentHTML('beforeend', newHTML);
  }
}

socket.on('reaction-updated', ({ msgId, reactions }) => {
  setClientReactions(msgId, reactions);

  let msgEl = null;
  for (const [mId, domId] of msgIdToDomId) {
    if (mId === msgId) { msgEl = document.getElementById(domId); break; }
  }
  if (!msgEl) {
    document.querySelectorAll('.msg').forEach(el => {
      if (el.dataset.msgId === msgId) msgEl = el;
    });
  }

  updateMsgReactions(msgId, reactions, msgEl);
});

document.addEventListener('click', e => {
  const btn = e.target.closest('.reaction-btn');
  if (!btn) return;
  const msgId = btn.dataset.msgid;
  const emoji = btn.dataset.emoji;
  if (msgId && emoji) toggleReaction(msgId, emoji, btn.closest('.msg'));
});

// ───────────────────────────────────────────────
//  REPLY
// ───────────────────────────────────────────────
function setReplyTo(msgId, msgEl) {
  const content  = msgEl?.querySelector('.msg-content');
  const text = content ? (content.innerText || content.textContent || '').trim().slice(0, 60) : '';
  const nickname = msgEl?.querySelector('.msg-sender')?.textContent?.replace('👤 ','').trim()
    || (msgEl?.classList.contains('mine') ? myNickname : '?');

  replyToMsg = { id: msgId, nickname, text };

  let bar = document.getElementById('reply-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'reply-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 14px;background:var(--surface2);border-top:2px solid var(--accent);border-bottom:1px solid var(--divider);font-size:13px;color:var(--text);';
    const tgBottom = document.getElementById('tg-bottom');
    if (tgBottom) tgBottom.insertBefore(bar, tgBottom.firstChild);
  }

  bar.innerHTML = `
    <span style="color:var(--accent2);font-weight:600;flex-shrink:0">↩️ ${escapeHtml(nickname)}</span>
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.7">${escapeHtml(text || '…')}</span>
    <button id="cancel-reply-btn" style="background:none;border:none;color:var(--sub);font-size:18px;cursor:pointer;padding:4px;flex-shrink:0">✕</button>`;

  document.getElementById('cancel-reply-btn')?.addEventListener('click', cancelReply);
  if (window._updateChatLayout) window._updateChatLayout();
  if (chatInput) chatInput.focus();
}

function cancelReply() {
  replyToMsg = null;
  document.getElementById('reply-bar')?.remove();
  if (window._updateChatLayout) window._updateChatLayout();
}

// ───────────────────────────────────────────────
//  ПОИСК / ЭМОДЗИ
// ───────────────────────────────────────────────
function openSearchModal() {
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg);display:flex;flex-direction:column;';
  sheet.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:max(env(safe-area-inset-top),14px) 16px 14px;background:var(--surface);border-bottom:1px solid var(--divider);">
      <button id="search-back" style="background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%">←</button>
      <input id="search-input" type="text" placeholder="Поиск чатов и пользователей…"
        style="flex:1;padding:10px 16px;background:var(--bg2);border:1.5px solid rgba(255,255,255,0.07);border-radius:24px;color:var(--text);font-size:15px;outline:none;font-family:inherit;"
        autocorrect="off" autocapitalize="none" autocomplete="off"/>
    </div>
    <div id="search-results" style="flex:1;overflow-y:auto;padding:8px;">
      <div style="text-align:center;color:var(--sub);font-size:14px;padding:40px 20px">Начни вводить для поиска</div>
    </div>`;
  document.body.appendChild(sheet);

  const input = sheet.querySelector('#search-input');
  const results = sheet.querySelector('#search-results');
  const close = () => sheet.remove();

  sheet.querySelector('#search-back').addEventListener('click', close);
  setTimeout(() => input.focus(), 100);

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      results.innerHTML = '<div style="text-align:center;color:var(--sub);font-size:14px;padding:40px 20px">Начни вводить для поиска</div>';
      return;
    }

    results.innerHTML = '<div style="text-align:center;color:var(--sub);font-size:14px;padding:20px">Поиск…</div>';
    timer = setTimeout(() => {
      socket.emit('search-chats', { query: q }, res => {
        if (!res.ok) return;
        let html = '';

        if (res.rooms && res.rooms.length) {
          html += '<div class="chat-list-section-title">👥 Группы</div>';
          html += res.rooms.map(r => `
            <div class="room-card search-result-room" data-id="${r.id}" data-has-pw="${r.hasPassword||false}" data-joinmode="${r.joinMode||'open'}" data-name="${escapeHtml(r.name)}" style="cursor:pointer;">
              <div class="room-avatar">${r.photo ? `<img src="${escapeHtml(r.photo)}" alt="">` : '🏠'}</div>
              <div class="room-info"><div class="room-name">${escapeHtml(r.name)}</div><div class="room-meta">👥 ${r.memberCount} участников</div></div>
            </div>`).join('');
        }

        if (res.users && res.users.length) {
          html += '<div class="chat-list-section-title">👤 Пользователи</div>';
          html += res.users.map(u => `
            <div class="pc-card search-result-user" data-nick="${escapeHtml(u.nickname)}" style="cursor:pointer;">
              <div class="room-avatar">👤</div>
              <div class="room-info"><div class="room-name">${escapeHtml(u.nickname)}</div><div class="room-meta">@${escapeHtml(u.lower)}</div></div>
            </div>`).join('');
        }

        if (!html) html = '<div style="text-align:center;color:var(--sub);font-size:14px;padding:40px 20px">Ничего не найдено</div>';
        results.innerHTML = html;

        results.querySelectorAll('.search-result-room').forEach(card => {
          card.addEventListener('click', () => { close(); joinRoom(card.dataset.id, ''); });
        });
        results.querySelectorAll('.search-result-user').forEach(card => {
          card.addEventListener('click', () => { close(); openPrivateChatWith(card.dataset.nick); });
        });
      });
    }, 300);
  });
}

function openEmojiPicker() {
  document.getElementById('emoji-picker-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'emoji-picker-popup';
  const tgBottom = document.getElementById('tg-bottom');
  const tbRect = tgBottom?.getBoundingClientRect();
  const bottomSpace = tbRect ? (window.innerHeight - tbRect.top) : 120;

  popup.style.cssText = `position:fixed;bottom:${bottomSpace+4}px;left:8px;right:8px;max-width:380px;margin:0 auto;background:var(--surface2);border-radius:20px;border:1px solid rgba(124,92,191,0.2);box-shadow:0 8px 32px rgba(0,0,0,0.6);padding:10px;z-index:3500;animation:slideUp 0.25s cubic-bezier(0.34,1.1,0.64,1);`;
  popup.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:4px;max-height:220px;overflow-y:auto;">
    ${EMOJI_LIST.map(emoji => `<button class="ep-btn" style="width:36px;height:36px;border:none;background:none;font-size:22px;cursor:pointer;border-radius:10px;">${emoji}</button>`).join('')}
  </div>`;

  document.body.appendChild(popup);

  popup.querySelectorAll('.ep-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (chatInput) {
        const pos = chatInput.selectionStart || 0;
        const val = chatInput.value;
        chatInput.value = val.slice(0, pos) + btn.textContent + val.slice(pos);
        chatInput.selectionStart = chatInput.selectionEnd = pos + btn.textContent.length;
        chatInput.dispatchEvent(new Event('input'));
        chatInput.focus();
      }
      popup.remove();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', function h(e) {
      if (!popup.contains(e.target) && e.target.id !== 'btn-emoji-picker') {
        popup.remove();
        document.removeEventListener('click', h);
      }
    });
  }, 50);
}
