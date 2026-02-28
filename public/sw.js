// public/sw.js
'use strict';

const CACHE_NAME    = 'securechat-v1';
const OFFLINE_URL   = '/index.html';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/crypto.js',
  '/manifest.json'
];

// ══════════════════════════════════════════════
//  INSTALL — кэшируем статику
// ══════════════════════════════════════════════
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// ══════════════════════════════════════════════
//  ACTIVATE — чистим старые кэши
// ══════════════════════════════════════════════
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key)  => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// ══════════════════════════════════════════════
//  FETCH — стратегия кэширования
// ══════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API и сокеты — всегда в сеть, не кэшируем
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      fetch(request).catch(() => {
        // Если API недоступен — возвращаем JSON ошибку
        return new Response(
          JSON.stringify({ ok: false, error: 'offline' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Статика — сначала кэш, потом сеть
  if (request.method === 'GET') {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;

        return fetch(request).then((response) => {
          // Кэшируем только успешные ответы
          if (!response || response.status !== 200 || response.type === 'opaque') {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
          return response;
        }).catch(() => {
          // Офлайн — отдаём index.html для навигации
          if (request.destination === 'document') {
            return caches.match(OFFLINE_URL);
          }
        });
      })
    );
    return;
  }
});

// ══════════════════════════════════════════════
//  PUSH УВЕДОМЛЕНИЯ
// ══════════════════════════════════════════════
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'SecureChat', body: event.data.text() };
  }

  const options = {
    body:    data.body    || 'Новое сообщение',
    icon:    data.icon    || '/icons/icon-192.png',
    badge:   data.badge   || '/icons/badge-72.png',
    tag:     data.tag     || 'securechat-msg',
    data:    data.data    || {},
    actions: [
      { action: 'open',    title: 'Открыть' },
      { action: 'dismiss', title: 'Закрыть' }
    ],
    requireInteraction: false,
    silent: false
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'SecureChat', options)
  );
});

// ══════════════════════════════════════════════
//  КЛИК ПО УВЕДОМЛЕНИЮ
// ══════════════════════════════════════════════
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const chatId = event.notification.data?.chatId;
  const url    = chatId ? `/?chat=${chatId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Если вкладка уже открыта — фокусируем её
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'open-chat', chatId });
          return;
        }
      }
      // Иначе открываем новую вкладку
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// ══════════════════════════════════════════════
//  SYNC — отправка отложенных сообщений
// ══════════════════════════════════════════════
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncPendingMessages());
  }
});

async function syncPendingMessages() {
  // Получаем отложенные сообщения из IndexedDB через postMessage
  const allClients = await clients.matchAll();
  allClients.forEach((client) => {
    client.postMessage({ type: 'sync-pending' });
  });
}
