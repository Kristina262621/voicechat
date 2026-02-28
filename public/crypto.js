/* ══════════════════════════════════════════════
   CRYPTO.JS — End-to-End шифрование (Web Crypto API)
   AES-GCM 256 + ECDH P-256 обмен ключами
══════════════════════════════════════════════ */

const E2E = (() => {

  /* ── Генерация пары ключей ECDH ── */
  async function generateKeyPair() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
    return pair;
  }

  /* ── Экспорт публичного ключа в Base64 ── */
  async function exportPublicKey(publicKey) {
    const raw = await crypto.subtle.exportKey('raw', publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  }

  /* ── Импорт публичного ключа из Base64 ── */
  async function importPublicKey(b64) {
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
  }

  /* ── Деривация общего AES ключа ── */
  async function deriveSharedKey(privateKey, theirPublicKey) {
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPublicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* ── Шифрование строки ── */
  async function encrypt(sharedKey, plaintext) {
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ct  = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sharedKey,
      enc.encode(plaintext)
    );
    // Собираем: iv(12) + ciphertext → Base64
    const buf = new Uint8Array(12 + ct.byteLength);
    buf.set(iv, 0);
    buf.set(new Uint8Array(ct), 12);
    return btoa(String.fromCharCode(...buf));
  }

  /* ── Дешифрование строки ── */
  async function decrypt(sharedKey, b64) {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv  = buf.slice(0, 12);
    const ct  = buf.slice(12);
    const dec = new TextDecoder();
    const pt  = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      sharedKey,
      ct
    );
    return dec.decode(pt);
  }

  /* ── Хэш пароля (PBKDF2 → Base64) ── */
  async function hashPassword(password, saltB64) {
    const enc  = new TextEncoder();
    const salt = saltB64
      ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0))
      : crypto.getRandomValues(new Uint8Array(16));

    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
    const saltB64Out = btoa(String.fromCharCode(...salt));
    return { hash: hashB64, salt: saltB64Out };
  }

  /* ── Случайный ID ── */
  function randomId() {
    return btoa(String.fromCharCode(
      ...crypto.getRandomValues(new Uint8Array(16))
    )).replace(/[+/=]/g, '').slice(0, 20);
  }

  /* ── Публичный API ── */
  return {
    generateKeyPair,
    exportPublicKey,
    importPublicKey,
    deriveSharedKey,
    encrypt,
    decrypt,
    hashPassword,
    randomId
  };
})();
