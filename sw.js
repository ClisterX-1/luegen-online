/* Lügen Service Worker.
   Bewusst OHNE Caching (network-only): macht die App installierbar, liefert aber
   immer die frische Version vom Server. So zeigt ein Update sofort, kein veralteter Cache. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  // Nur GET aus dem Netz holen; alles andere normal durchreichen.
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request));
});
