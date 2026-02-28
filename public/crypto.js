'use strict';

/* Без глобального const E2E, только window.CryptoUtils */
window.CryptoUtils = (() => {
  async function hashPassword(password, saltB64) {
    const enc = new TextEncoder();
    const salt = saltB64
      ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0))
      : crypto.getRandomValues(new Uint8Array(16));

    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    );

    return {
      hash: btoa(String.fromCharCode(...new Uint8Array(bits))),
      salt: btoa(String.fromCharCode(...salt))
    };
  }

  function randomId() {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replace(/[+/=]/g, '')
      .slice(0, 20);
  }

  return { hashPassword, randomId };
})();
