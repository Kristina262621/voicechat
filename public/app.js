// app.js — загрузчик частей (чтобы сохранить подключение в index.html как есть)
(function () {
  // Порядок важен
  const parts = [
    '/js/app/01-state.js',
    '/js/app/02-ui-auth-lobby.js',
    '/js/app/03-messaging.js',
    '/js/app/04-webrtc-calls.js',
    '/js/app/05-init.js'
  ];

  // Синхронная подгрузка во время парсинга документа
  for (const src of parts) {
    document.write(`<script src="${src}"><\/script>`);
  }
})();
