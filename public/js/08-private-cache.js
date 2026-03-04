// public/js/08-private-cache.js
(() => {
  const DB_NAME = 'voicechat_local_cache';
  const DB_VER = 1;
  const STORE_MSG = 'private_msgs';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MSG)) {
          const s = db.createObjectStore(STORE_MSG, { keyPath: 'k' }); // k = chatId|ts|msgId
          s.createIndex('chat_ts', ['chatId', 'timestamp'], { unique: false });
          s.createIndex('chat_msgid', ['chatId', 'msgId'], { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function makeKey(chatId, timestamp, msgId) {
    return `${chatId}|${String(timestamp).padStart(16, '0')}|${msgId}`;
  }

  async function putPrivateMessage(m) {
    if (!m?.chatId || !m?.msgId) return;
    const row = {
      k: makeKey(m.chatId, Number(m.timestamp || Date.now()), m.msgId),
      chatId: m.chatId,
      msgId: m.msgId,
      timestamp: Number(m.timestamp || Date.now()),
      from: m.from || '',
      fromNick: m.fromNick || '',
      type: m.type || 'text',
      encrypted: m.encrypted || null,
      iv: m.iv || null,
      mimeType: m.mimeType || null,
      fileName: m.fileName || null,
      fileSize: m.fileSize || null,
      duration: Number(m.duration || 0),
      status: m.status || 'sent',
      edited: !!m.edited,
      replyTo: m.replyTo || null
    };

    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MSG], 'readwrite');
      tx.objectStore(STORE_MSG).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function putPrivateMessagesBulk(chatId, messages) {
    if (!chatId || !Array.isArray(messages) || !messages.length) return;
    const db = await openDb();

    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MSG], 'readwrite');
      const st = tx.objectStore(STORE_MSG);

      for (const m of messages) {
        if (!m?.id) continue;
        const ts = Number(m.timestamp || Date.now());
        st.put({
          k: makeKey(chatId, ts, m.id),
          chatId,
          msgId: m.id,
          timestamp: ts,
          from: m.from || '',
          fromNick: m.fromNick || '',
          type: m.type || 'text',
          encrypted: m.encrypted || null,
          iv: m.iv || null,
          mimeType: m.mimeType || null,
          fileName: m.fileName || null,
          fileSize: m.fileSize || null,
          duration: Number(m.duration || 0),
          status: m.status || 'sent',
          edited: !!m.edited,
          replyTo: m.replyTo || null
        });
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db.close();
  }

  async function getPrivateMessages(chatId, limit = 50, beforeTs = null) {
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MSG], 'readonly');
      const idx = tx.objectStore(STORE_MSG).index('chat_ts');
      const out = [];

      const upper = (beforeTs == null)
        ? [chatId, Number.MAX_SAFE_INTEGER]
        : [chatId, Number(beforeTs) - 1];

      const lower = [chatId, 0];
      const range = IDBKeyRange.bound(lower, upper);

      // Идём с конца (новые -> старые), потом перевернём
      const req = idx.openCursor(range, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out.reverse());
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return rows;
  }

  async function getLastTs(chatId) {
    const rows = await getPrivateMessages(chatId, 1, null);
    return rows.length ? Number(rows[0].timestamp) : 0;
  }

  async function clearChat(chatId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MSG], 'readwrite');
      const idx = tx.objectStore(STORE_MSG).index('chat_ts');
      const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
      const req = idx.openCursor(range);

      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        c.delete();
        c.continue();
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      req.onerror = () => reject(req.error);
    });
    db.close();
  }

  window.PrivateCache = {
    putPrivateMessage,
    putPrivateMessagesBulk,
    getPrivateMessages,
    getLastTs,
    clearChat
  };
})();
