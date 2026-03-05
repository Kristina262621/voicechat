// ═══════════════════════════════════════════════
//  MediaEditor — редактор медиа перед отправкой
//  Поддерживает: подпись к фото/видео, предпросмотр
// ═══════════════════════════════════════════════
const MediaEditor = (() => {

  // ─── Общий стиль оверлея ───
  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9000',
      'background:rgba(0,0,0,0.92)', 'display:flex',
      'flex-direction:column', 'align-items:center',
      'justify-content:flex-start', 'backdrop-filter:blur(12px)',
      'animation:fadeIn 0.2s ease'
    ].join(';');
    return overlay;
  }

  // ─── Кнопка «Отправить» ───
  function createSendBtn(label) {
    const btn = document.createElement('button');
    btn.textContent = label || '✈️ Отправить';
    btn.style.cssText = [
      'padding:14px 32px', 'border:none', 'border-radius:24px',
      'background:linear-gradient(135deg,#7c5cbf,#5b3fa0)',
      'color:white', 'font-size:16px', 'font-weight:700',
      'cursor:pointer', 'min-width:160px',
      'box-shadow:0 4px 20px rgba(124,92,191,0.5)',
      'transition:transform 0.15s, box-shadow 0.15s'
    ].join(';');
    btn.addEventListener('mousedown', () => {
      btn.style.transform = 'scale(0.96)';
      btn.style.boxShadow = '0 2px 10px rgba(124,92,191,0.4)';
    });
    btn.addEventListener('mouseup', () => {
      btn.style.transform = '';
      btn.style.boxShadow = '0 4px 20px rgba(124,92,191,0.5)';
    });
    return btn;
  }

  // ─── Поле подписи ───
  function createCaptionInput(placeholder) {
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'width:100%', 'max-width:520px', 'padding:0 16px',
      'box-sizing:border-box', 'margin-bottom:8px'
    ].join(';');

    const input = document.createElement('textarea');
    input.placeholder = placeholder || 'Добавить подпись…';
    input.maxLength = 1000;
    input.rows = 2;
    input.style.cssText = [
      'width:100%', 'padding:12px 16px',
      'background:rgba(255,255,255,0.08)',
      'border:1.5px solid rgba(255,255,255,0.12)',
      'border-radius:16px', 'color:#e8e8f0',
      'font-size:15px', 'font-family:inherit',
      'outline:none', 'resize:none',
      'box-sizing:border-box',
      'transition:border-color 0.2s'
    ].join(';');
    input.addEventListener('focus', () => {
      input.style.borderColor = 'rgba(124,92,191,0.6)';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = 'rgba(255,255,255,0.12)';
    });
    // Enter = новая строка, Ctrl/Cmd+Enter = отправить
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const sendBtn = wrap.closest('[data-media-editor]')?.querySelector('[data-send-btn]');
        if (sendBtn) sendBtn.click();
      }
    });

    wrap.appendChild(input);
    return { wrap, input };
  }

  // ─── Кнопка «Отмена» ───
  function createCancelBtn() {
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.title = 'Отмена';
    btn.style.cssText = [
      'position:absolute', 'top:max(env(safe-area-inset-top),14px)',
      'left:16px', 'background:rgba(0,0,0,0.5)',
      'border:none', 'color:white', 'font-size:20px',
      'cursor:pointer', 'width:40px', 'height:40px',
      'border-radius:50%', 'display:flex',
      'align-items:center', 'justify-content:center',
      'backdrop-filter:blur(8px)', 'z-index:1'
    ].join(';');
    return btn;
  }

  // ─── ФОТО ───
  function openPhoto(file, onConfirm, onCancel) {
    const url = URL.createObjectURL(file);
    const overlay = createOverlay();
    overlay.setAttribute('data-media-editor', '1');

    // Заголовок
    const header = document.createElement('div');
    header.style.cssText = [
      'width:100%', 'max-width:520px',
      'display:flex', 'align-items:center',
      'justify-content:center', 'padding:max(env(safe-area-inset-top),14px) 16px 12px',
      'position:relative', 'flex-shrink:0'
    ].join(';');
    header.innerHTML = '<div style="font-size:16px;font-weight:700;color:white">🖼 Отправить фото</div>';

    const cancelBtn = createCancelBtn();
    header.appendChild(cancelBtn);
    overlay.appendChild(header);

    // Превью
    const imgWrap = document.createElement('div');
    imgWrap.style.cssText = [
      'flex:1', 'display:flex', 'align-items:center',
      'justify-content:center', 'overflow:hidden',
      'width:100%', 'max-width:520px', 'padding:0 16px',
      'box-sizing:border-box', 'min-height:0'
    ].join(';');

    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = [
      'max-width:100%', 'max-height:100%',
      'border-radius:16px', 'object-fit:contain',
      'box-shadow:0 8px 40px rgba(0,0,0,0.6)'
    ].join(';');
    imgWrap.appendChild(img);
    overlay.appendChild(imgWrap);

    // Нижняя панель
    const bottom = document.createElement('div');
    bottom.style.cssText = [
      'width:100%', 'max-width:520px',
      'padding:12px 0 max(env(safe-area-inset-bottom),24px)',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'gap:10px', 'flex-shrink:0'
    ].join(';');

    const { wrap: captionWrap, input: captionInput } = createCaptionInput('Добавить подпись к фото…');
    bottom.appendChild(captionWrap);

    const sendBtn = createSendBtn('✈️ Отправить фото');
    sendBtn.setAttribute('data-send-btn', '1');
    bottom.appendChild(sendBtn);
    overlay.appendChild(bottom);

    document.body.appendChild(overlay);

    // Фокус на поле подписи
    setTimeout(() => captionInput.focus(), 300);

    const close = () => {
      URL.revokeObjectURL(url);
      overlay.style.animation = 'fadeOut 0.15s ease forwards';
      setTimeout(() => overlay.remove(), 150);
    };

    cancelBtn.addEventListener('click', () => {
      close();
      if (onCancel) onCancel();
    });

    sendBtn.addEventListener('click', () => {
      const caption = captionInput.value.trim();
      close();
      onConfirm(file, file.type, file.name, caption || null);
    });

    // Закрытие по клику на фон
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        close();
        if (onCancel) onCancel();
      }
    });
  }

  // ─── ВИДЕО ───
  function openVideo(file, onConfirm, onCancel) {
    const url = URL.createObjectURL(file);
    const overlay = createOverlay();
    overlay.setAttribute('data-media-editor', '1');

    // Заголовок
    const header = document.createElement('div');
    header.style.cssText = [
      'width:100%', 'max-width:520px',
      'display:flex', 'align-items:center',
      'justify-content:center', 'padding:max(env(safe-area-inset-top),14px) 16px 12px',
      'position:relative', 'flex-shrink:0'
    ].join(';');
    header.innerHTML = '<div style="font-size:16px;font-weight:700;color:white">🎬 Отправить видео</div>';

    const cancelBtn = createCancelBtn();
    header.appendChild(cancelBtn);
    overlay.appendChild(header);

    // Превью видео
    const videoWrap = document.createElement('div');
    videoWrap.style.cssText = [
      'flex:1', 'display:flex', 'align-items:center',
      'justify-content:center', 'overflow:hidden',
      'width:100%', 'max-width:520px', 'padding:0 16px',
      'box-sizing:border-box', 'min-height:0'
    ].join(';');

    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    video.style.cssText = [
      'max-width:100%', 'max-height:100%',
      'border-radius:16px', 'object-fit:contain',
      'box-shadow:0 8px 40px rgba(0,0,0,0.6)'
    ].join(';');
    videoWrap.appendChild(video);
    overlay.appendChild(videoWrap);

    // Нижняя панель
    const bottom = document.createElement('div');
    bottom.style.cssText = [
      'width:100%', 'max-width:520px',
      'padding:12px 0 max(env(safe-area-inset-bottom),24px)',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'gap:10px', 'flex-shrink:0'
    ].join(';');

    // Информация о файле
    const fileInfo = document.createElement('div');
    fileInfo.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.5);padding:0 16px;text-align:center;';
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    fileInfo.textContent = `${file.name} · ${sizeMB} МБ`;
    bottom.appendChild(fileInfo);

    const { wrap: captionWrap, input: captionInput } = createCaptionInput('Добавить подпись к видео…');
    bottom.appendChild(captionWrap);

    const sendBtn = createSendBtn('✈️ Отправить видео');
    sendBtn.setAttribute('data-send-btn', '1');
    bottom.appendChild(sendBtn);
    overlay.appendChild(bottom);

    document.body.appendChild(overlay);

    const close = () => {
      URL.revokeObjectURL(url);
      overlay.style.animation = 'fadeOut 0.15s ease forwards';
      setTimeout(() => overlay.remove(), 150);
    };

    cancelBtn.addEventListener('click', () => {
      close();
      if (onCancel) onCancel();
    });

    sendBtn.addEventListener('click', () => {
      const caption = captionInput.value.trim();
      close();
      onConfirm(file, file.type, file.name, caption || null);
    });

    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        close();
        if (onCancel) onCancel();
      }
    });
  }

  // Добавляем стили анимации
  (function injectStyles() {
    if (document.getElementById('media-editor-styles')) return;
    const style = document.createElement('style');
    style.id = 'media-editor-styles';
    style.textContent = `
      @keyframes fadeIn  { from { opacity:0; transform:scale(0.97) } to { opacity:1; transform:scale(1) } }
      @keyframes fadeOut { from { opacity:1; transform:scale(1) } to { opacity:0; transform:scale(0.97) } }
    `;
    document.head.appendChild(style);
  })();

  return { openPhoto, openVideo };
})();
