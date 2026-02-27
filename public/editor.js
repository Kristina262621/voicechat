// Минимальный редактор медиа (заглушка): просто отдаёт оригинальный файл.
// Можно заменить на полноценный UI без изменений в `public/app.js`.

window.MediaEditor = {
  openPhoto(file, onDone) {
    if (typeof onDone === 'function') onDone(file, file.type || 'image/jpeg', file.name || 'photo.jpg');
  },
  openVideo(file, onDone) {
    if (typeof onDone === 'function') onDone(file, file.type || 'video/mp4', file.name || 'video.mp4');
  }
};
