// public/js/07-e2ee-session.js
(() => {
  const te = new TextEncoder();
  const td = new TextDecoder();
  const cache = new Map(); // peerId -> { outboundKey, inboundKey }
  const messageCounts = new Map(); // peerId -> count

  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Unsupported data type for toBytes');
  }

  async function importEcdhRawPublic(rawB64) {
    return crypto.subtle.importKey(
      'raw',
      b64ToBytes(rawB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
  }

  async function importEcdsaSpkiPublic(spkiB64) {
    return crypto.subtle.importKey(
      'spki',
      b64ToBytes(spkiB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );
  }

  async function verifySignedPreKey(bundle) {
    console.log('[E2EE] Verifying signed pre-key signature');
    if (!bundle.identitySignPublic) {
      console.log('[E2EE] No identitySignPublic, skipping verification');
      return true;
    }
    const verifyKey = await importEcdsaSpkiPublic(bundle.identitySignPublic);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      b64ToBytes(bundle.signedPreKey.signature),
      b64ToBytes(bundle.signedPreKey.publicKey)
    );
    if (!ok) throw new Error('signed_prekey_invalid_signature');
    console.log('[E2EE] Signed pre-key signature valid');
    return true;
  }

  async function hkdfAes(sharedBits) {
    // Проверка длины sharedBits (256 бит = 32 байта)
    if (sharedBits.byteLength !== 32) {
      console.error('[E2EE] Invalid sharedBits length:', sharedBits.byteLength);
      throw new Error('shared_bits_invalid_length');
    }
    const ikm = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: te.encode('voicechat-e2ee-v1-salt'),
        info: te.encode('voicechat-private-msg-v1')
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function fetchBundle(peerId, consume = 1) {
    const token = localStorage.getItem('chat_token');
    if (!token) throw new Error('chat_token_missing');

    const r = await fetch(`/api/signal/keys/bundle/${encodeURIComponent(peerId)}?consume=${consume}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const j = await r.json();
    if (!r.ok || !j?.ok || !j?.bundle) throw new Error(j?.error || 'bundle_fetch_failed');
    return j.bundle;
  }

  async function deriveOutboundKey(peerId) {
    const peerBundle = await fetchBundle(peerId, 1); // consume one-time (but we ignore it)
    await verifySignedPreKey(peerBundle);

    const myIdentityDhPriv = await window.E2EEKeys.dbGet('identityDh.private');
    if (!myIdentityDhPriv) throw new Error('identityDh.private_missing');

    const peerSignedPub = await importEcdhRawPublic(peerBundle.signedPreKey.publicKey);
    console.log('[E2EE] deriveOutboundKey: myIdentityDhPriv present, peerSignedPub imported');
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerSignedPub },
      myIdentityDhPriv,
      256
    );
    console.log('[E2EE] deriveOutboundKey derived bits, length:', bits.byteLength, 'first few bytes:', new Uint8Array(bits).slice(0, 4).join(','));

    // Ignore oneTimePreKey for simplicity and compatibility with deriveInboundKey
    console.log('[E2EE] deriveOutboundKey using only signed pre-key (oneTimePreKey ignored)');
    const key = await hkdfAes(bits);
    console.log('[E2EE] Outbound key derived successfully, key algorithm:', key.algorithm);
    
    // Тестируем ключ: шифруем и расшифровываем тестовые данные
    try {
      const testIv = crypto.getRandomValues(new Uint8Array(12));
      const testData = te.encode('test');
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: testIv }, key, testData);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: testIv }, key, encrypted);
      const decoded = td.decode(decrypted);
      console.log('[E2EE] Outbound key self-test passed, decrypted:', decoded);
    } catch (testError) {
      console.error('[E2EE] Outbound key self-test failed:', testError);
      const err = new Error('derived_key_invalid');
      err.name = 'DerivedKeyInvalidError';
      throw err;
    }
    
    return key;
  }

  async function deriveInboundKey(peerId) {
    console.log('[E2EE] deriveInboundKey for peer:', peerId);
    
    const peerBundle = await fetchBundle(peerId, 0); // не потребляем
    console.log('[E2EE] Got peer bundle:', peerBundle ? JSON.stringify(peerBundle, null, 2) : 'no');
    
    const mySignedPriv = await window.E2EEKeys.dbGet('signedPre.private');
    console.log('[E2EE] mySignedPriv:', mySignedPriv ? 'present' : 'missing');
    if (!mySignedPriv) throw new Error('signedPre.private_missing');

    const peerIdentityDh = peerBundle.identityDhPublic || peerBundle.identityKeyPublic;
    console.log('[E2EE] peerIdentityDh:', peerIdentityDh ? peerIdentityDh.substring(0, 20) + '...' : 'missing');
    if (!peerIdentityDh) throw new Error('peer_identityDh_missing');

    const peerIdentityPub = await importEcdhRawPublic(peerIdentityDh);
    console.log('[E2EE] Derived peerIdentityPub');
    
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerIdentityPub },
      mySignedPriv,
      256
    );
    console.log('[E2EE] Derived bits, length:', bits.byteLength, 'first few bytes:', new Uint8Array(bits).slice(0, 4).join(','));
    
    const key = await hkdfAes(bits);
    console.log('[E2EE] Inbound key derived successfully, key algorithm:', key.algorithm);
    
    // Тестируем ключ: шифруем и расшифровываем тестовые данные
    try {
      const testIv = crypto.getRandomValues(new Uint8Array(12));
      const testData = te.encode('test');
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: testIv }, key, testData);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: testIv }, key, encrypted);
      const decoded = td.decode(decrypted);
      console.log('[E2EE] Key self-test passed, decrypted:', decoded);
    } catch (testError) {
      console.error('[E2EE] Key self-test failed:', testError);
      const err = new Error('derived_key_invalid');
      err.name = 'DerivedKeyInvalidError';
      throw err;
    }
    
    return key;
  }

  async function ensurePeer(peerId) {
    if (!cache.has(peerId)) cache.set(peerId, {});
    const s = cache.get(peerId);

    if (!s.outboundKey) s.outboundKey = await deriveOutboundKey(peerId);
    if (!s.inboundKey) s.inboundKey = await deriveInboundKey(peerId);

    return s;
  }

  async function rotateKeysIfNeeded(peerId, direction) {
    const count = (messageCounts.get(peerId) || 0) + 1;
    messageCounts.set(peerId, count);
    if (count % 50 === 0) {
      const s = cache.get(peerId);
      if (!s) return;
      if (direction === 'outbound') {
        s.outboundKey = await deriveOutboundKey(peerId);
      } else if (direction === 'inbound') {
        s.inboundKey = await deriveInboundKey(peerId);
      }
    }
  }

  async function encryptTextForPeer(peerId, text) {
    const s = await ensurePeer(peerId);
    console.log('[E2EE] encryptTextForPeer: outboundKey algorithm:', s.outboundKey.algorithm);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = te.encode(String(text));
    console.log('[E2EE] encryptTextForPeer: plaintext length:', pt.length);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, s.outboundKey, pt);
    console.log('[E2EE] encryptTextForPeer: ciphertext length:', ct.byteLength);
    await rotateKeysIfNeeded(peerId, 'outbound');
    return { encrypted: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) };
  }

  async function decryptTextFromPeer(peerId, encryptedB64, ivB64) {
    console.log('[E2EE] decryptTextFromPeer for peer:', peerId, 'encrypted length:', encryptedB64?.length);
    try {
      const s = await ensurePeer(peerId);
      console.log('[E2EE] Session ensured, inboundKey:', s.inboundKey ? 'present' : 'missing');
      
      const iv = b64ToBytes(ivB64);
      const ct = b64ToBytes(encryptedB64);
      console.log('[E2EE] IV length:', iv.length, 'CT length:', ct.length);
      console.log('[E2EE] IV (hex):', Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''));
      console.log('[E2EE] CT first 16 bytes (hex):', Array.from(ct.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(''));
      
      // Детальное логирование ключа
      if (s.inboundKey) {
        const keyInfo = await crypto.subtle.exportKey('jwk', s.inboundKey).catch(() => null);
        console.log('[E2EE] Inbound key algorithm:', s.inboundKey.algorithm, 'extractable:', s.inboundKey.extractable);
        if (keyInfo) {
          console.log('[E2EE] Inbound key JWK kty:', keyInfo.kty, 'alg:', keyInfo.alg);
        }
      }
      
      console.log('[E2EE] Decrypting with algorithm:', { name: 'AES-GCM', iv: Array.from(iv) });
      // Проверка длины IV (должно быть 12 байт для AES-GCM)
      if (iv.length !== 12) {
        console.error('[E2EE] Invalid IV length:', iv.length);
        throw new Error('invalid_iv_length');
      }
      // Проверка, что ключ существует
      if (!s.inboundKey) {
        throw new Error('inbound_key_missing');
      }
      // Дополнительное логирование ключа
      const keyAlgo = s.inboundKey.algorithm;
      console.log('[E2EE] Inbound key algorithm:', keyAlgo);
      
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.inboundKey, ct);
      console.log('[E2EE] Decryption successful, plaintext length:', pt.byteLength);
      
      await rotateKeysIfNeeded(peerId, 'inbound');
      const result = td.decode(pt);
      console.log('[E2EE] Decoded text length:', result.length);
      return result;
    } catch (error) {
      console.error('[E2EE] decryptTextFromPeer failed:', error);
      // При ошибке OperationError попробуем сбросить сессию и повторить
      if (error.name === 'OperationError') {
        console.log('[E2EE] OperationError, clearing peer cache and retrying...');
        clearPeer(peerId);
        try {
          const s = await ensurePeer(peerId);
          const iv = b64ToBytes(ivB64);
          const ct = b64ToBytes(encryptedB64);
          // Дополнительное логирование при ретрае
          console.log('[E2EE] Retry with inboundKey present:', !!s.inboundKey);
          const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.inboundKey, ct);
          await rotateKeysIfNeeded(peerId, 'inbound');
          return td.decode(pt);
        } catch (retryError) {
          console.error('[E2EE] Retry also failed:', retryError);
          // Попробуем использовать outboundKey, если inboundKey не сработал
          if (retryError.name === 'OperationError') {
            console.log('[E2EE] Trying fallback decryption with outboundKey');
            try {
              const s = await ensurePeer(peerId);
              const iv = b64ToBytes(ivB64);
              const ct = b64ToBytes(encryptedB64);
              const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.outboundKey, ct);
              await rotateKeysIfNeeded(peerId, 'outbound');
              return td.decode(pt);
            } catch (outboundError) {
              console.error('[E2EE] Fallback decryption with outboundKey also failed:', outboundError);
              throw outboundError;
            }
          }
          throw retryError;
        }
      }
      if (error.name === 'DerivedKeyInvalidError') {
        console.log('[E2EE] DerivedKeyInvalidError, clearing peer cache and retrying...');
        clearPeer(peerId);
        try {
          const s = await ensurePeer(peerId);
          const iv = b64ToBytes(ivB64);
          const ct = b64ToBytes(encryptedB64);
          console.log('[E2EE] Retry with inboundKey present:', !!s.inboundKey);
          const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.inboundKey, ct);
          await rotateKeysIfNeeded(peerId, 'inbound');
          return td.decode(pt);
        } catch (retryError) {
          console.error('[E2EE] Retry also failed:', retryError);
          // Попробуем использовать outboundKey, если inboundKey не сработал
          if (retryError.name === 'OperationError') {
            console.log('[E2EE] Trying fallback decryption with outboundKey');
            try {
              const s = await ensurePeer(peerId);
              const iv = b64ToBytes(ivB64);
              const ct = b64ToBytes(encryptedB64);
              const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.outboundKey, ct);
              await rotateKeysIfNeeded(peerId, 'outbound');
              return td.decode(pt);
            } catch (outboundError) {
              console.error('[E2EE] Fallback decryption with outboundKey also failed:', outboundError);
              throw outboundError;
            }
          }
          throw retryError;
        }
      }
      throw error;
    }
  }

  async function decryptOwnTextForPeer(peerId, encryptedB64, ivB64) {
    try {
      const s = await ensurePeer(peerId);
      const iv = b64ToBytes(ivB64);
      const ct = b64ToBytes(encryptedB64);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.outboundKey, ct);
      return td.decode(pt);
    } catch (error) {
      console.error('[E2EE] decryptOwnTextForPeer failed:', error);
      if (error.name === 'OperationError') {
        console.log('[E2EE] OperationError, clearing peer cache and retrying...');
        clearPeer(peerId);
        try {
          const s = await ensurePeer(peerId);
          const iv = b64ToBytes(ivB64);
          const ct = b64ToBytes(encryptedB64);
          const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.outboundKey, ct);
          return td.decode(pt);
        } catch (retryError) {
          console.error('[E2EE] Retry also failed:', retryError);
          throw retryError;
        }
      }
      throw error;
    }
  }

  async function encryptBytesForPeer(peerId, bytesLike) {
    const s = await ensurePeer(peerId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = toBytes(bytesLike);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, s.outboundKey, pt);
    await rotateKeysIfNeeded(peerId, 'outbound');
    return { encrypted: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) };
  }

  async function decryptBytesFromPeer(peerId, encryptedB64, ivB64) {
    const s = await ensurePeer(peerId);
    const iv = b64ToBytes(ivB64);
    const ct = b64ToBytes(encryptedB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.inboundKey, ct);
    await rotateKeysIfNeeded(peerId, 'inbound');
    return new Uint8Array(pt);
  }

  async function decryptOwnBytesForPeer(peerId, encryptedB64, ivB64) {
    const s = await ensurePeer(peerId);
    const iv = b64ToBytes(ivB64);
    const ct = b64ToBytes(encryptedB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.outboundKey, ct);
    return new Uint8Array(pt);
  }

  async function decryptBlobFromPeer(peerId, encryptedB64, ivB64, mimeType) {
    const bytes = await decryptBytesFromPeer(peerId, encryptedB64, ivB64);
    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  }

  async function decryptOwnBlobForPeer(peerId, encryptedB64, ivB64, mimeType) {
    const bytes = await decryptOwnBytesForPeer(peerId, encryptedB64, ivB64);
    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  }

  function clearPeer(peerId) {
    cache.delete(peerId);
    messageCounts.delete(peerId);
  }

  window.E2EESession = {
    encryptTextForPeer,
    decryptTextFromPeer,
    decryptOwnTextForPeer,
    encryptBytesForPeer,
    decryptBytesFromPeer,
    decryptOwnBytesForPeer,
    decryptBlobFromPeer,
    decryptOwnBlobForPeer,
    clearPeer
  };
})();
