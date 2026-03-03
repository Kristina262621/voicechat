const CACHE_NAME = 'privchat-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/editor.js', '/audio-processor.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  // Сеть прежде всего, fallback на кэш
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Обработка push-уведомлений
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
      data: data
    })
  );
});

// Клик по уведомлению — открыть/сфокусировать приложение
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
