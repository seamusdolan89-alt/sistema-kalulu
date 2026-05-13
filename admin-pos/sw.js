// Service Worker — Kalulu Admin
// Solo necesario para habilitar instalación como PWA. Network-first.
const CACHE = 'kalulu-admin-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
