// Service worker mínimo del Inbox Jacarí.
//
// Su único propósito HOY es habilitar la instalación como app (PWA): con un
// service worker registrado + manifest + íconos, el navegador ofrece "instalar"
// y la app abre en pantalla completa con su propio ícono.
//
// NO cachea nada a propósito: el inbox es data en vivo y con sesión. Un fetch
// handler "pass-through" (deja pasar todo a la red) alcanza para que cuente como
// instalable, sin arriesgar mostrar conversaciones viejas o datos de otra sesión.
//
// A futuro, si algún día se quieren notificaciones push web, los listeners
// 'push' y 'notificationclick' irían acá.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  /* red directa, sin caché */
});
