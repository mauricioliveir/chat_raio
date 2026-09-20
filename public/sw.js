// Service worker mínimo: permite instalar o app na tela inicial e mostrar
// notificações. Não guarda nada em cache (o chat sempre usa a versão mais nova).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Necessário para o navegador considerar o app "instalável".
self.addEventListener('fetch', () => {});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const j of janelas) if ('focus' in j) return j.focus();
      return self.clients.openWindow('/');
    })
  );
});
