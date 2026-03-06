const CACHE_NAME = 'privchat-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/editor.js',
  '/audio-processor.js',
  '/js/core.js',
  '/js/ui.js',
  '/js/status.js',
  '/js/invitelink.js',
  '/js/app/01-state.js',
  '/js/app/02-ui-auth-lobby.js',
  '/js/app/03-messaging.js',
  '/js/app/04-webrtc-calls.js',
  '/js/app/05-init.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

self.addEventListener('push', e => {
  let data = { title: '📩 Новое сообщение', body: '', tag: 'msg' };
  try { data = Object.assign(data, e.data?.json()); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      tag: data.tag || 'msg',
      renotify: true,
      requireInteraction: data.requireInteraction || false,
      data
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
