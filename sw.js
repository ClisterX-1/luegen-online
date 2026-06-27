/* Lügen Service Worker.
   Macht die App installierbar, greift aber bewusst so wenig wie moeglich ein:
   - kein Caching (immer frische Version vom Server)
   - NUR Seitenaufrufe (navigate) werden behandelt.
   Medien (MP3 mit Range-Anfragen), Schriften, fetch und WebSocket gehen direkt ans Netz,
   sonst wuerde der Worker die Sound-Wiedergabe auf iOS/Safari blockieren. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(function () { return new Response("", { status: 504 }); }));
  }
  // alles andere (Sounds, Assets, API): kein Eingriff -> Browser laedt normal
});
