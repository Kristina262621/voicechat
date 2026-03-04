// public/js/06-e2ee-keys.js
(() => {
  const DB_NAME = 'voicechat_e2ee';
  const DB_VERSION = 1;
  const STORE = 'kv';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbSet(key, value) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function dbGet(key) {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  async function exportRawPublicKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return new Uint8Array(raw);
  }

  async function exportSpkiPublicKey(key) {
    const spki = await crypto.subtle.exportKey('spki', key);
    return new Uint8Array(spki);
  }

  async function signBytes(ecdsaPrivateKey, bytes) {
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      ecdsaPrivateKey,
      bytes
    );
    return new Uint8Array(sig);
  }

  function nextId() {
    return Math.floor(Date.now() % 2000000000);
  }

  async function generateAndUpload({ oneTimeCount = 20 } = {}) {
    const token = localStorage.getItem('chat_token');
    if (!token) throw new Error('chat_token not found in localStorage');

    // identity signing key (ECDSA)
    const identitySign = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    // identity agreement key (ECDH)
    const identityDh = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );

    // signed prekey
    const signedPre = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const signedPrePubRaw = await exportRawPublicKey(signedPre.publicKey);
    const signedPreSig = await signBytes(identitySign.privateKey, signedPrePubRaw);

    // kyber placeholder (оставляем для совместимости бекенда)
    const kyberPre = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const kyberPrePubRaw = await exportRawPublicKey(kyberPre.publicKey);
    const kyberPreSig = await signBytes(identitySign.privateKey, kyberPrePubRaw);

    // one-time prekeys
    const base = nextId();
    const oneTimePairs = [];
    for (let i = 0; i < oneTimeCount; i++) {
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      );
      oneTimePairs.push({ id: base + i + 1, kp });
    }

    // local private storage
    await dbSet('identitySign.private', identitySign.privateKey);
    await dbSet('identitySign.public', identitySign.publicKey);
    await dbSet('identityDh.private', identityDh.privateKey);
    await dbSet('identityDh.public', identityDh.publicKey);
    await dbSet('signedPre.private', signedPre.privateKey);
    await dbSet('signedPre.public', signedPre.publicKey);

    for (const p of oneTimePairs) {
      await dbSet(`otpk.private.${p.id}`, p.kp.privateKey);
      await dbSet(`otpk.public.${p.id}`, p.kp.publicKey);
    }

    const identitySignPublic = bytesToB64(await exportSpkiPublicKey(identitySign.publicKey));
    const identityDhPublic = bytesToB64(await exportRawPublicKey(identityDh.publicKey));

    const payload = {
      deviceId: 1,
      registrationId: Math.floor(Math.random() * 16380) + 1,

      // новый формат
      identitySignPublic,
      identityDhPublic,

      // backward-compat для текущего бекенда
      identityKeyPublic: identityDhPublic,

      signedPreKey: {
        id: 1,
        publicKey: bytesToB64(signedPrePubRaw),
        signature: bytesToB64(signedPreSig)
      },
      kyberPreKey: {
        id: 1,
        publicKey: bytesToB64(kyberPrePubRaw),
        signature: bytesToB64(kyberPreSig)
      },
      oneTimePreKeys: await Promise.all(
        oneTimePairs.map(async ({ id, kp }) => ({
          id,
          publicKey: bytesToB64(await exportRawPublicKey(kp.publicKey))
        }))
      )
    };

    const res = await fetch('/api/signal/keys/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || 'upload failed');
    return json;
  }

  async function ensurePreKeys(minCount = 10, refillCount = 20) {
    const token = localStorage.getItem('chat_token');
    if (!token) return;

    const r = await fetch('/api/signal/keys/prekeys/count', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const j = await r.json();
    const count = j?.count ?? 0;

    if (count < minCount) {
      const out = await generateAndUpload({ oneTimeCount: refillCount });
      console.log('[E2EE] prekeys uploaded', out);
    } else {
      console.log('[E2EE] prekeys ok:', count);
    }
  }

  window.E2EEKeys = { generateAndUpload, ensurePreKeys, dbGet, dbSet };
})();
