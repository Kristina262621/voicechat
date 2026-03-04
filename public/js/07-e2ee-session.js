// public/js/07-e2ee-session.js
(() => {
  const te = new TextEncoder();
  const td = new TextDecoder();
  const cache = new Map(); // peer -> { outboundKey, inboundKey }

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

  async function fetchBundle(peerId, consume = 0) {
    const token = localStorage.getItem('chat_token');
    if (!token) throw new Error('chat_token missing');

    const r = await fetch(`/api/signal/keys/bundle/${encodeURIComponent(peerId)}?consume=${consume}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const j = await r.json();
    if (!r.ok || !j?.ok || !j?.bundle) throw new Error(j?.error || 'bundle_fetch_failed');
    return j.bundle;
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
    if (!bundle.identitySignPublic) return; // backward compatibility
    const verifyKey = await importEcdsaSpkiPublic(bundle.identitySignPublic);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      b64ToBytes(bundle.signedPreKey.signature),
      b64ToBytes(bundle.signedPreKey.publicKey)
    );
    if (!ok) throw new Error('signed_prekey_invalid_signature');
  }

  async function hkdfAes(sharedBits) {
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

  async function deriveOutboundKey(peerId) {
    // my identityDh.private + peer signedPre.public
    const peerBundle = await fetchBundle(peerId, 0);
    await verifySignedPreKey(peerBundle);

    const myIdentityDhPriv = await window.E2EEKeys.dbGet('identityDh.private');
    if (!myIdentityDhPriv) throw new Error('identityDh.private not found');

    const peerSignedPrePub = await importEcdhRawPublic(peerBundle.signedPreKey.publicKey);
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerSignedPrePub },
      myIdentityDhPriv,
      256
    );
    return hkdfAes(bits);
  }

  async function deriveInboundKey(peerId) {
    // my signedPre.private + peer identityDh.public
    const peerBundle = await fetchBundle(peerId, 0);

    const mySignedPrePriv = await window.E2EEKeys.dbGet('signedPre.private');
    if (!mySignedPrePriv) throw new Error('signedPre.private not found');

    const peerIdentityDh = peerBundle.identityDhPublic || peerBundle.identityKeyPublic;
    if (!peerIdentityDh) throw new Error('peer identityDh missing');

    const peerIdentityDhPub = await importEcdhRawPublic(peerIdentityDh);
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerIdentityDhPub },
      mySignedPrePriv,
      256
    );
    return hkdfAes(bits);
  }

  async function ensurePeer(peerId) {
    if (!cache.has(peerId)) cache.set(peerId, {});
    const s = cache.get(peerId);

    if (!s.outboundKey) s.outboundKey = await deriveOutboundKey(peerId);
    if (!s.inboundKey) s.inboundKey = await deriveInboundKey(peerId);

    return s;
  }

  async function encryptTextForPeer(peerId, text) {
    const s = await ensurePeer(peerId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = te.encode(String(text));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, s.outboundKey, pt);

    return {
      encrypted: bytesToB64(new Uint8Array(ct)),
      iv: bytesToB64(iv)
    };
  }

  async function decryptTextFromPeer(peerId, encryptedB64, ivB64) {
    const s = await ensurePeer(peerId);
    const iv = b64ToBytes(ivB64);
    const ct = b64ToBytes(encryptedB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, s.inboundKey, ct);
    return td.decode(pt);
  }

  function clearPeer(peerId) {
    cache.delete(peerId);
  }

  window.E2EESession = {
    encryptTextForPeer,
    decryptTextFromPeer,
    clearPeer
  };
})();
