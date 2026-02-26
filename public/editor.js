const MediaEditor = (() => {
  let canvas, ctx;
  let originalImage  = null;
  let history        = [];
  let currentTool    = 'draw';
  let isDrawing      = false;
  let startX = 0, startY = 0;
  let brushColor     = '#ff3b5c';
  let brushSize      = 4;
  let onConfirm      = null;
  let onCancel       = null;
  let textInput      = null;
  let cropStart      = null;
  let cropRect       = null;
  let blurPath       = [];
  let videoSrc       = null;
  let videoDuration  = 0;
  let trimStart      = 0;
  let trimEnd        = 0;
  let videoEl        = null;
  let isVideoMode    = false;
  let shapeSnapshot  = null;

  const editorStyles = `
  <style id="med-styles">
  #media-editor {
    position:fixed;inset:0;z-index:3000;
    display:flex;align-items:center;justify-content:center;
  }
  #med-backdrop {
    position:absolute;inset:0;background:rgba(0,0,0,0.95);
  }
  #med-shell {
    position:relative;z-index:1;
    display:flex;flex-direction:column;
    width:100%;max-width:600px;
    height:100vh;max-height:100vh;
    background:#111827;
  }
  #med-header {
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 14px;background:#0f172a;flex-shrink:0;
  }
  #med-cancel {
    background:none;border:none;color:#aaa;font-size:20px;
    cursor:pointer;padding:6px 10px;border-radius:8px;
  }
  #med-cancel:hover{color:white;background:#1e293b;}
  #med-title{font-size:15px;font-weight:bold;color:white;}
  #med-confirm {
    background:#e94560;color:white;border:none;
    border-radius:10px;padding:8px 16px;
    font-size:14px;font-weight:bold;cursor:pointer;
  }
  #med-confirm:hover{background:#c73652;}
  #med-canvas-wrap {
    flex:1;position:relative;
    display:flex;align-items:center;justify-content:center;
    overflow:hidden;background:#000;min-height:0;
  }
  #med-canvas {
    display:block;max-width:100%;max-height:100%;
    touch-action:none;cursor:crosshair;
  }
  #med-video-trim {
    padding:12px 16px;background:#0f172a;flex-shrink:0;
  }
  #med-trim-label{font-size:12px;color:#aaa;margin-bottom:10px;}
  #med-trim-label span{color:#e94560;font-weight:bold;}
  #med-trim-track {
    position:relative;height:40px;
    background:#1e293b;border-radius:8px;
    margin-bottom:10px;user-select:none;
  }
  #med-trim-bg{position:absolute;inset:0;border-radius:8px;background:#334155;}
  #med-trim-range {
    position:absolute;top:0;bottom:0;
    background:rgba(233,69,96,0.35);
    border-top:2px solid #e94560;border-bottom:2px solid #e94560;
    pointer-events:none;
  }
  .med-trim-handle {
    position:absolute;top:0;bottom:0;width:18px;
    background:#e94560;border-radius:4px;
    cursor:ew-resize;display:flex;
    align-items:center;justify-content:center;
    color:white;font-size:10px;font-weight:bold;
    touch-action:none;z-index:2;
  }
  .med-trim-handle::after{content:'⋮';}
  #med-trim-handle-l{border-radius:6px 0 0 6px;transform:translateX(-50%);}
  #med-trim-handle-r{border-radius:0 6px 6px 0;transform:translateX(50%);}
  #med-trim-playhead {
    position:absolute;top:-4px;bottom:-4px;
    width:2px;background:white;pointer-events:none;z-index:3;left:0%;
  }
  #med-trim-buttons{display:flex;align-items:center;gap:12px;}
  #med-trim-play {
    background:#1e293b;color:white;
    border:1px solid #334155;border-radius:8px;
    padding:6px 14px;font-size:13px;cursor:pointer;
  }
  #med-trim-play:hover{background:#334155;}
  #med-trim-dur{font-size:12px;color:#64748b;}
  #med-tools{background:#0f172a;padding:10px 12px;flex-shrink:0;}
  #med-tool-row{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;}
  .med-tool {
    width:38px;height:38px;border:2px solid transparent;
    border-radius:10px;background:#1e293b;
    color:white;font-size:16px;cursor:pointer;
    transition:all 0.15s;display:flex;
    align-items:center;justify-content:center;
  }
  .med-tool:hover{background:#334155;}
  .med-tool.active{border-color:#e94560;background:#2d1520;}
  #med-colors{display:flex;gap:7px;margin-bottom:10px;flex-wrap:wrap;align-items:center;}
  .med-color {
    width:26px;height:26px;border-radius:50%;cursor:pointer;
    border:2px solid transparent;transition:transform 0.15s,border-color 0.15s;
    flex-shrink:0;
  }
  .med-color:hover{transform:scale(1.2);}
  .med-color.active{border-color:white;transform:scale(1.15);}
  .custom-color-wrap {
    width:26px;height:26px;
    background:linear-gradient(135deg,#f00,#0f0,#00f);
    border-radius:50%;overflow:hidden;
    display:flex;align-items:center;justify-content:center;
  }
  #med-color-custom{width:200%;height:200%;opacity:0;cursor:pointer;}
  #med-brush-row{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
  #med-brush-size{flex:1;accent-color:#e94560;}
  #med-brush-preview{
    width:24px;height:24px;border-radius:50%;
    background:#ff3b5c;transition:all 0.1s;flex-shrink:0;
  }
  #med-actions{display:flex;gap:8px;flex-wrap:wrap;}
  #med-actions button {
    padding:7px 14px;border:1px solid #334155;
    border-radius:9px;background:#1e293b;color:#ccc;
    font-size:13px;cursor:pointer;
  }
  #med-actions button:hover{background:#334155;color:white;}
  #med-emoji-picker {
    position:absolute;bottom:100%;left:0;right:0;
    background:#1e293b;border-top:1px solid #334155;
    display:flex;flex-wrap:wrap;gap:4px;
    padding:10px;z-index:10;
    max-height:160px;overflow-y:auto;
  }
  .med-emoji-item {
    font-size:26px;cursor:pointer;padding:4px;
    border-radius:6px;transition:background 0.1s;line-height:1;
  }
  .med-emoji-item:hover{background:#334155;}
  #med-text-input {
    position:fixed;background:transparent;
    border:2px dashed rgba(255,255,255,0.6);
    border-radius:4px;color:white;
    font-size:24px;font-weight:bold;
    padding:4px 8px;outline:none;min-width:120px;
    text-shadow:1px 1px 3px rgba(0,0,0,0.8);
    font-family:Arial,sans-serif;
  }
  </style>`;

  const editorHTML = `
  <div id="media-editor" style="display:none">
    <div id="med-backdrop"></div>
    <div id="med-shell">
      <div id="med-header">
        <button id="med-cancel">✕</button>
        <div id="med-title">Редактор</div>
        <button id="med-confirm">Отправить ➤</button>
      </div>
      <div id="med-canvas-wrap">
        <canvas id="med-canvas"></canvas>
      </div>
      <div id="med-video-trim" style="display:none">
        <div id="med-trim-label">✂️ Обрезка: <span id="med-trim-time">0.0s — 0.0s</span></div>
        <div id="med-trim-track">
          <div id="med-trim-bg"></div>
          <div id="med-trim-range"></div>
          <div id="med-trim-handle-l" class="med-trim-handle" data-side="left"></div>
          <div id="med-trim-handle-r" class="med-trim-handle" data-side="right"></div>
          <div id="med-trim-playhead"></div>
        </div>
        <div id="med-trim-buttons">
          <button id="med-trim-play">▶ Воспроизвести</button>
          <span id="med-trim-dur"></span>
        </div>
      </div>
      <div id="med-tools" style="display:none">
        <div id="med-tool-row">
          <button class="med-tool active" data-tool="draw"   title="Рисовать">✏️</button>
          <button class="med-tool"        data-tool="line"   title="Линия">╱</button>
          <button class="med-tool"        data-tool="arrow"  title="Стрелка">➜</button>
          <button class="med-tool"        data-tool="rect"   title="Прямоугольник">▭</button>
          <button class="med-tool"        data-tool="circle" title="Круг">○</button>
          <button class="med-tool"        data-tool="text"   title="Текст">T</button>
          <button class="med-tool"        data-tool="blur"   title="Размытие">◈</button>
          <button class="med-tool"        data-tool="crop"   title="Кадрировать">⊡</button>
          <button class="med-tool"        data-tool="emoji"  title="Эмодзи">😊</button>
        </div>
        <div id="med-colors">
          <div class="med-color active" style="background:#ff3b5c" data-color="#ff3b5c"></div>
          <div class="med-color" style="background:#ffffff" data-color="#ffffff"></div>
          <div class="med-color" style="background:#000000" data-color="#000000"></div>
          <div class="med-color" style="background:#ffd700" data-color="#ffd700"></div>
          <div class="med-color" style="background:#00e676" data-color="#00e676"></div>
          <div class="med-color" style="background:#2196f3" data-color="#2196f3"></div>
          <div class="med-color" style="background:#ff9800" data-color="#ff9800"></div>
          <div class="med-color custom-color-wrap">
            <input type="color" id="med-color-custom" value="#ff3b5c" title="Свой цвет">
          </div>
        </div>
        <div id="med-brush-row">
          <span style="font-size:11px;color:#aaa">Размер</span>
          <input type="range" id="med-brush-size" min="1" max="40" value="4">
          <div id="med-brush-preview"></div>
        </div>
        <div id="med-actions">
          <button id="med-undo">↩ Отменить</button>
          <button id="med-clear">🗑 Очистить</button>
          <button id="med-crop-apply" style="display:none">✂️ Применить кадрирование</button>
        </div>
        <div id="med-emoji-picker" style="display:none">
          ${['😀','😂','😍','😎','🔥','❤️','👍','💀','🎉','😭',
             '🤔','😡','👀','💯','🙏','✨','🎭','🦄','💪','🤝',
             '😏','🥳','😱','🤯','💥','🌟','🎯','🏆','💰','🔐']
            .map(e=>`<span class="med-emoji-item">${e}</span>`).join('')}
        </div>
      </div>
    </div>
  </div>`;

  function init() {
    if (document.getElementById('media-editor')) return;
    document.head.insertAdjacentHTML('beforeend', editorStyles);
    document.body.insertAdjacentHTML('beforeend', editorHTML);

    canvas = document.getElementById('med-canvas');
    ctx    = canvas.getContext('2d');

    document.getElementById('med-cancel') .addEventListener('click', cancelEditor);
    document.getElementById('med-confirm').addEventListener('click', confirmEditor);

    document.querySelectorAll('.med-tool').forEach(btn => {
      btn.addEventListener('click', () => selectTool(btn.dataset.tool));
    });

    document.querySelectorAll('.med-color[data-color]').forEach(el => {
      el.addEventListener('click', () => selectColor(el.dataset.color, el));
    });

    document.getElementById('med-color-custom').addEventListener('input', e => {
      selectColor(e.target.value, null);
    });

    document.getElementById('med-brush-size').addEventListener('input', function() {
      brushSize = parseInt(this.value);
      updateBrushPreview();
    });

    document.getElementById('med-undo') .addEventListener('click', undo);
    document.getElementById('med-clear').addEventListener('click', clearDrawing);
    document.getElementById('med-crop-apply').addEventListener('click', applyCrop);
    document.getElementById('med-trim-play') .addEventListener('click', toggleTrimPlay);

    canvas.addEventListener('mousedown',  onPointerDown);
    canvas.addEventListener('mousemove',  onPointerMove);
    canvas.addEventListener('mouseup',    onPointerUp);
    canvas.addEventListener('mouseleave', e => { if(isDrawing) onPointerUp(e); });

    canvas.addEventListener('touchstart', e => { e.preventDefault(); onPointerDown(touchEvt(e)); }, { passive:false });
    canvas.addEventListener('touchmove',  e => { e.preventDefault(); onPointerMove(touchEvt(e)); }, { passive:false });
    canvas.addEventListener('touchend',   e => { e.preventDefault(); onPointerUp(touchEvt(e));   }, { passive:false });

    initTrimHandles();
  }

  /* ── PUBLIC ── */
  async function openPhoto(file, cbOk, cbCancel) {
    init();
    isVideoMode = false;
    onConfirm   = cbOk;
    onCancel    = cbCancel;

    // Восстанавливаем canvas если был видео-режим
    const wrap = document.getElementById('med-canvas-wrap');
    wrap.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.id = 'med-canvas';
    canvas.style.cssText = 'display:block;max-width:100%;max-height:100%;touch-action:none;cursor:crosshair;';
    wrap.appendChild(canvas);
    ctx = canvas.getContext('2d');
    rebindCanvas();

    const bmp   = await createImageBitmap(file);
    originalImage = bmp;
    const scale = Math.min(1, 1920/bmp.width, 1080/bmp.height);
    canvas.width  = Math.round(bmp.width  * scale);
    canvas.height = Math.round(bmp.height * scale);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

    history     = [canvas.toDataURL()];
    currentTool = 'draw';

    document.getElementById('med-title').textContent = '✏️ Редактор фото';
    document.getElementById('med-tools').style.display      = 'block';
    document.getElementById('med-video-trim').style.display = 'none';
    document.querySelectorAll('.med-tool').forEach(b=>b.classList.remove('active'));
    document.querySelector('[data-tool="draw"]').classList.add('active');
    show();
  }

  async function openVideo(file, cbOk, cbCancel) {
    init();
    isVideoMode = true;
    onConfirm   = cbOk;
    onCancel    = cbCancel;
    videoSrc    = URL.createObjectURL(file);

    if (videoEl) { videoEl.pause(); videoEl.remove(); }
    videoEl = document.createElement('video');
    videoEl.src         = videoSrc;
    videoEl.playsInline = true;
    videoEl.controls    = true;
    videoEl.style.cssText = 'max-width:100%;max-height:100%;';
    videoEl.preload = 'metadata';

    await new Promise(res => {
      videoEl.onloadedmetadata = () => { videoDuration = videoEl.duration; res(); };
      videoEl.onerror = res;
    });

    trimStart = 0;
    trimEnd   = videoDuration;

    const wrap = document.getElementById('med-canvas-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(videoEl);

    videoEl.addEventListener('timeupdate', () => {
      const pct = videoDuration > 0 ? videoEl.currentTime / videoDuration : 0;
      const ph  = document.getElementById('med-trim-playhead');
      if (ph) ph.style.left = (pct*100)+'%';
      if (videoEl.currentTime >= trimEnd) {
        videoEl.pause();
        videoEl.currentTime = trimStart;
        document.getElementById('med-trim-play').textContent = '▶ Воспроизвести';
      }
    });

    updateTrimUI();
    document.getElementById('med-title').textContent = '✂️ Редактор видео';
    document.getElementById('med-tools').style.display      = 'none';
    document.getElementById('med-video-trim').style.display = 'block';
    show();
  }

  /* ── SHOW / HIDE ── */
  function show() {
    document.getElementById('media-editor').style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function hide() {
    document.getElementById('media-editor').style.display = 'none';
    document.body.style.overflow = '';
    if (videoEl) videoEl.pause();
    closeEmojiPicker();
    removeTextInput();
  }

  function cancelEditor() { hide(); if(onCancel) onCancel(); }

  async function confirmEditor() {
    if (isVideoMode) await confirmVideo();
    else             await confirmPhoto();
  }

  async function confirmPhoto() {
    hide();
    canvas.toBlob(blob => { if(onConfirm) onConfirm(blob,'image/png','edited.png'); }, 'image/png', 0.95);
  }

  async function confirmVideo() {
    hide();
    if (Math.abs(trimStart) < 0.01 && Math.abs(trimEnd - videoDuration) < 0.01) {
      const res  = await fetch(videoSrc);
      const blob = await res.blob();
      if (onConfirm) onConfirm(blob, blob.type, 'video.mp4');
      return;
    }
    try {
      const blob = await trimVideo(videoEl, trimStart, trimEnd);
      if (onConfirm) onConfirm(blob, blob.type, 'trimmed.webm');
    } catch(e) {
      const res  = await fetch(videoSrc);
      const blob = await res.blob();
      if (onConfirm) onConfirm(blob, blob.type, 'video.mp4');
    }
  }

  /* ── TRIM VIDEO ── */
  function trimVideo(video, start, end) {
    return new Promise((resolve, reject) => {
      const stream = video.captureStream
        ? video.captureStream(30)
        : video.mozCaptureStream
          ? video.mozCaptureStream(30)
          : null;
      if (!stream) { reject(new Error('captureStream not supported')); return; }

      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm';

      const chunks   = [];
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = e => { if(e.data.size>0) chunks.push(e.data); };
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
      recorder.onerror = reject;

      video.currentTime = start;
      video.onseeked = () => {
        video.onseeked = null;
        video.play();
        recorder.start(100);
        const t = setInterval(() => {
          if (video.currentTime >= end) {
            clearInterval(t);
            video.pause();
            recorder.stop();
            stream.getTracks().forEach(t=>t.stop());
          }
        }, 50);
      };
    });
  }

  /* ── TRIM UI ── */
  function initTrimHandles() {
    const track = document.getElementById('med-trim-track');
    let dragging = null;

    function pct(clientX) {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    }

    ['l','r'].forEach(side => {
      const el = document.getElementById('med-trim-handle-'+side);
      el.addEventListener('mousedown',  e => { e.preventDefault(); dragging = side; });
      el.addEventListener('touchstart', e => { e.preventDefault(); dragging = side; }, {passive:false});
    });

    function onMove(cx) {
      if (!dragging) return;
      const t = pct(cx) * videoDuration;
      if (dragging==='l') trimStart = Math.min(t, trimEnd-0.5);
      else                trimEnd   = Math.max(t, trimStart+0.5);
      updateTrimUI();
      if (videoEl) videoEl.currentTime = dragging==='l' ? trimStart : trimEnd;
    }

    window.addEventListener('mousemove', e => onMove(e.clientX));
    window.addEventListener('touchmove', e => { if(dragging){ e.preventDefault(); onMove(e.touches[0].clientX); } }, {passive:false});
    window.addEventListener('mouseup',  () => { dragging = null; });
    window.addEventListener('touchend', () => { dragging = null; });
  }

  function updateTrimUI() {
    const dur  = videoDuration || 1;
    const lPct = (trimStart/dur)*100;
    const rPct = (trimEnd  /dur)*100;
    document.getElementById('med-trim-handle-l').style.left = lPct+'%';
    document.getElementById('med-trim-handle-r').style.left = rPct+'%';
    document.getElementById('med-trim-range').style.left    = lPct+'%';
    document.getElementById('med-trim-range').style.width   = (rPct-lPct)+'%';
    document.getElementById('med-trim-time').textContent    = trimStart.toFixed(1)+'s — '+trimEnd.toFixed(1)+'s';
    document.getElementById('med-trim-dur').textContent     = 'Длительность: '+(trimEnd-trimStart).toFixed(1)+'с';
  }

  function toggleTrimPlay() {
    if (!videoEl) return;
    const btn = document.getElementById('med-trim-play');
    if (videoEl.paused) {
      videoEl.currentTime = trimStart;
      videoEl.play();
      btn.textContent = '⏸ Пауза';
    } else {
      videoEl.pause();
      btn.textContent = '▶ Воспроизвести';
    }
  }

  /* ── TOOLS ── */
  function selectTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.med-tool').forEach(b=>b.classList.remove('active'));
    const btn = document.querySelector(`[data-tool="${tool}"]`);
    if (btn) btn.classList.add('active');

    if (tool==='emoji') toggleEmojiPicker();
    else                closeEmojiPicker();

    document.getElementById('med-crop-apply').style.display = tool==='crop' ? 'inline-block' : 'none';
    canvas.style.cursor = tool==='text' ? 'text' : 'crosshair';
    removeTextInput();
  }

  function selectColor(color, el) {
    brushColor = color;
    document.querySelectorAll('.med-color[data-color]').forEach(e=>e.classList.remove('active'));
    if (el) el.classList.add('active');
    updateBrushPreview();
  }

  function updateBrushPreview() {
    const p = document.getElementById('med-brush-preview');
    const s = Math.min(brushSize*2, 40);
    p.style.cssText = `width:${s}px;height:${s}px;border-radius:50%;background:${brushColor};transition:all 0.1s;flex-shrink:0;`;
  }

  /* ── POINTER ── */
  function getXY(e) {
    const r  = canvas.getBoundingClientRect();
    const sx = canvas.width  / r.width;
    const sy = canvas.height / r.height;
    return { x:(e.clientX-r.left)*sx, y:(e.clientY-r.top)*sy };
  }

  function touchEvt(e) {
    const t = e.touches[0] || e.changedTouches[0];
    return { clientX:t.clientX, clientY:t.clientY };
  }

  function rebindCanvas() {
    canvas.addEventListener('mousedown',  onPointerDown);
    canvas.addEventListener('mousemove',  onPointerMove);
    canvas.addEventListener('mouseup',    onPointerUp);
    canvas.addEventListener('mouseleave', e=>{ if(isDrawing) onPointerUp(e); });
    canvas.addEventListener('touchstart', e=>{ e.preventDefault(); onPointerDown(touchEvt(e)); }, {passive:false});
    canvas.addEventListener('touchmove',  e=>{ e.preventDefault(); onPointerMove(touchEvt(e)); }, {passive:false});
    canvas.addEventListener('touchend',   e=>{ e.preventDefault(); onPointerUp(touchEvt(e));   }, {passive:false});
  }

  function onPointerDown(e) {
    const {x,y} = getXY(e);
    isDrawing = true;
    startX = x; startY = y;

    if (currentTool==='draw' || currentTool==='blur') {
      saveHistory();
      ctx.beginPath();
      ctx.moveTo(x,y);
      blurPath = [{x,y}];
    }

    if (['line','arrow','rect','circle'].includes(currentTool)) {
      saveHistory();
      shapeSnapshot = canvas.toDataURL();
    }

    if (currentTool==='text') {
      placeTextInput(x,y);
      isDrawing = false;
    }

    if (currentTool==='crop') {
      cropStart = {x,y};
      cropRect  = null;
    }
  }

  function onPointerMove(e) {
    if (!isDrawing) return;
    const {x,y} = getXY(e);

    if (currentTool==='draw') {
      ctx.strokeStyle = brushColor;
      ctx.lineWidth   = brushSize;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.lineTo(x,y);
      ctx.stroke();
      return;
    }

    if (currentTool==='blur') {
      blurPath.push({x,y});
      ctx.strokeStyle = 'rgba(0,0,0,0.01)';
      ctx.lineWidth   = brushSize*3;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.lineTo(x,y);
      ctx.stroke();
      return;
    }

    if (['line','arrow','rect','circle'].includes(currentTool) && shapeSnapshot) {
      const img = new Image();
      img.src = shapeSnapshot;
      img.onload = () => {
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0);
        drawShape(currentTool, startX, startY, x, y);
      };
      return;
    }

    if (currentTool==='crop') {
      drawCropOverlay(startX, startY, x, y);
    }
  }

  function onPointerUp(e) {
    if (!isDrawing) return;
    isDrawing = false;

    if (currentTool==='blur') {
      applyBlur();
      return;
    }

    if (['line','arrow','rect','circle'].includes(currentTool) && e && e.clientX !== undefined) {
      const {x,y} = getXY(e);
      if (shapeSnapshot) {
        const img = new Image();
        img.src = shapeSnapshot;
        img.onload = () => {
          ctx.clearRect(0,0,canvas.width,canvas.height);
          ctx.drawImage(img,0,0);
          drawShape(currentTool, startX, startY, x, y);
          history[history.length-1] = canvas.toDataURL();
          shapeSnapshot = null;
        };
      }
    }
  }

  /* ── SHAPES ── */
  function drawShape(tool, x1, y1, x2, y2) {
    ctx.strokeStyle = ctx.fillStyle = brushColor;
    ctx.lineWidth   = brushSize;
    ctx.lineCap = ctx.lineJoin = 'round';

    if (tool==='line') {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    } else if (tool==='arrow') {
      drawArrow(x1,y1,x2,y2);
    } else if (tool==='rect') {
      ctx.beginPath(); ctx.strokeRect(x1,y1,x2-x1,y2-y1);
    } else if (tool==='circle') {
      ctx.beginPath();
      ctx.ellipse(x1+(x2-x1)/2, y1+(y2-y1)/2, Math.abs(x2-x1)/2, Math.abs(y2-y1)/2, 0, 0, Math.PI*2);
      ctx.stroke();
    }
  }

  function drawArrow(x1,y1,x2,y2) {
    const angle   = Math.atan2(y2-y1, x2-x1);
    const headLen = Math.max(brushSize*4, 16);
    const ha      = Math.PI/6;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(x2-headLen*Math.cos(angle-ha), y2-headLen*Math.sin(angle-ha));
    ctx.lineTo(x2-headLen*Math.cos(angle+ha), y2-headLen*Math.sin(angle+ha));
    ctx.closePath(); ctx.fill();
  }

  /* ── BLUR ── */
  function applyBlur() {
    if (blurPath.length < 2) return;
    const radius = brushSize * 3;
    const off    = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const offCtx = off.getContext('2d');
    const img    = new Image();
    img.src = history[history.length-1];
    img.onload = () => {
      offCtx.filter = `blur(${radius}px)`;
      offCtx.drawImage(img, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(blurPath[0].x, blurPath[0].y);
      for (let i=1;i<blurPath.length;i++) ctx.lineTo(blurPath[i].x, blurPath[i].y);
      ctx.lineWidth   = radius*2;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.clip();
      ctx.drawImage(off, 0, 0);
      ctx.restore();
      blurPath = [];
      history[history.length-1] = canvas.toDataURL();
    };
  }

  /* ── CROP ── */
  function drawCropOverlay(x1,y1,x2,y2) {
    const cx = Math.min(x1,x2), cy = Math.min(y1,y2);
    const w  = Math.abs(x2-x1), h  = Math.abs(y2-y1);
    if (history.length === 0) return;
    const img = new Image();
    img.src = history[history.length-1];
    img.onload = () => {
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img,0,0);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0,0,canvas.width,cy);
      ctx.fillRect(0,cy,cx,h);
      ctx.fillRect(cx+w,cy,canvas.width-cx-w,h);
      ctx.fillRect(0,cy+h,canvas.width,canvas.height-cy-h);
      ctx.strokeStyle = 'white'; ctx.lineWidth = 2;
      ctx.strokeRect(cx,cy,w,h);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
      ctx.setLineDash([4,4]);
      for (let i=1;i<3;i++) {
        ctx.beginPath(); ctx.moveTo(cx+(w/3)*i,cy); ctx.lineTo(cx+(w/3)*i,cy+h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx,cy+(h/3)*i); ctx.lineTo(cx+w,cy+(h/3)*i); ctx.stroke();
      }
      ctx.setLineDash([]);
      cropRect = {x:cx,y:cy,w,h};
    };
  }

  function applyCrop() {
    if (!cropRect || cropRect.w<10 || cropRect.h<10) return;
    const {x,y,w,h} = cropRect;
    const data = ctx.getImageData(x,y,w,h);
    canvas.width = w; canvas.height = h;
    ctx.putImageData(data,0,0);
    history = [canvas.toDataURL()];
    cropRect = null;
    selectTool('draw');
  }

  /* ── TEXT ── */
  function placeTextInput(x,y) {
    removeTextInput();
    const r  = canvas.getBoundingClientRect();
    const sx = r.width  / canvas.width;
    const sy = r.height / canvas.height;

    textInput = document.createElement('input');
    textInput.id = 'med-text-input';
    textInput.type = 'text';
    textInput.placeholder = 'Введи текст…';
    textInput.style.left  = (r.left + x*sx) + 'px';
    textInput.style.top   = (r.top  + y*sy) + 'px';
    textInput.style.color = brushColor;
    textInput.style.fontSize = '24px';
    document.body.appendChild(textInput);
    textInput.focus();

    textInput.addEventListener('keydown', e => {
      if (e.key==='Enter')  commitText(x,y);
      if (e.key==='Escape') removeTextInput();
    });

    setTimeout(() => {
      function outside(e) {
        if (textInput && !textInput.contains(e.target)) {
          commitText(x,y);
          document.removeEventListener('mousedown', outside);
          document.removeEventListener('touchstart', outside);
        }
      }
      document.addEventListener('mousedown',  outside);
      document.addEventListener('touchstart', outside);
    }, 50);
  }

  function commitText(x,y) {
    if (!textInput) return;
    const text = textInput.value.trim();
    removeTextInput();
    if (!text) return;
    saveHistory();
    ctx.font         = `bold 24px Arial`;
    ctx.fillStyle    = brushColor;
    ctx.shadowColor  = brushColor==='#ffffff' ? '#000' : 'rgba(0,0,0,0.8)';
    ctx.shadowBlur   = 4;
    ctx.fillText(text, x, y+24);
    ctx.shadowBlur   = 0;
    history[history.length-1] = canvas.toDataURL();
  }

  function removeTextInput() {
    if (textInput) { textInput.remove(); textInput = null; }
  }

  /* ── EMOJI ── */
  function toggleEmojiPicker() {
    const p = document.getElementById('med-emoji-picker');
    const open = p.style.display !== 'none';
    p.style.display = open ? 'none' : 'flex';
    if (!open) {
      p.querySelectorAll('.med-emoji-item').forEach(item => {
        item.onclick = () => {
          closeEmojiPicker();
          const emoji = item.textContent;
          canvas._pendingEmoji = emoji;
          canvas.style.cursor  = 'copy';
          currentTool = '_emoji';
          document.querySelectorAll('.med-tool').forEach(b=>b.classList.remove('active'));
        };
      });
    }
  }

  function closeEmojiPicker() {
    const p = document.getElementById('med-emoji-picker');
    if (p) p.style.display = 'none';
  }

  // Перехватываем клик на canvas для эмодзи
  document.addEventListener('click', e => {
    if (currentTool !== '_emoji') return;
    if (!canvas || !canvas.contains(e.target)) return;
    const {x,y} = getXY(e);
    saveHistory();
    ctx.font      = `${brushSize*8+16}px serif`;
    ctx.textAlign = 'center';
    ctx.fillText(canvas._pendingEmoji || '😀', x, y);
    ctx.textAlign = 'left';
    history[history.length-1] = canvas.toDataURL();
    canvas.style.cursor = 'crosshair';
    currentTool = 'draw';
    document.querySelector('[data-tool="draw"]')?.classList.add('active');
  });

  /* ── HISTORY ── */
  function saveHistory() {
    if (history.length > 20) history.shift();
    history.push(canvas.toDataURL());
  }

  function undo() {
    if (history.length <= 1) return;
    history.pop();
    const img = new Image();
    img.src = history[history.length-1];
    img.onload = () => { ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0); };
  }

  function clearDrawing() {
    if (!originalImage) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(originalImage,0,0,canvas.width,canvas.height);
    history = [canvas.toDataURL()];
  }

  return { openPhoto, openVideo };
})();
