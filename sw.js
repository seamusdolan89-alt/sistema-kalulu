// Service Worker — Kalulu POS
// Solo necesario para habilitar instalación como PWA. Network-first.
const CACHE = 'kalulu-pos-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  // Solo interceptar peticiones del mismo origen
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
