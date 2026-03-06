// ═══════════════════════════════════════════════
//  MediaEditor — заглушка без внешних зависимостей
//  Просто передаёт файл дальше без редактирования
// ═══════════════════════════════════════════════
const MediaEditor = (() => {

  function openPhoto(file, onConfirm, onCancel) {
    // Просто передаём файл как есть
    onConfirm(file, file.type, file.name);
  }

  function openVideo(file, onConfirm, onCancel) {
    // Просто передаём файл как есть
    onConfirm(file, file.type, file.name);
  }

  return { openPhoto, openVideo };
})();
