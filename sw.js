// Service Worker — Kalulu POS
//
// Cachea la app entera (HTML/CSS/JS propios + las librerías de terceros que
// se cargan por CDN: Firebase SDK, sql.js, html2canvas, Tesseract.js, SheetJS,
// JsBarcode) para que la pantalla pueda cargar sin internet. La base de datos
// (SQLite vía OPFS) vive aparte, en disco, y no depende en nada de este
// archivo — ya persiste sola, con o sin Service Worker.
//
// Estrategia: network-first con fallback a cache cuando falla la red. Cada
// fetch exitoso re-escribe el cache solo (cache.put) — así se mantiene al día
// sin tocar este archivo, salvo para sumar una entrada nueva a OWN_PATHS de
// abajo (opcional: sirve para que una pantalla que todavía nunca se visitó
// funcione offline desde la primera instalación; si te olvidás de sumarla acá,
// igual queda cacheada sola la primera vez que se visite con internet).
//
// El cache-busting de `?v=...` (ver CLAUDE.md, "Router y cache-busting") se
// ignora al guardar y al buscar en el cache (cacheKey() lo saca) — así una
// misma pantalla no genera una entrada nueva por cada timestamp, y bumpear un
// `?v=N` en alguno de los 5 archivos fijos no rompe ni duplica nada acá.
//
// Hay DOS copias de este archivo a propósito — esta (scope "/", todo el
// sitio) y admin-pos/sw.js (scope "/admin-pos/", se registra aparte porque
// admin-pos/index.html hace `register('./sw.js')` relativo a sí mismo) — son
// dos Service Workers independientes, cada uno con su propio cache. El
// cálculo de ROOT de abajo hace que el MISMO contenido sirva para las dos
// copias sin tener que adaptar rutas a mano.

'use strict';

const CACHE = 'kalulu-pos-v2';

// Repo root, sea cual sea el subpath de hosting (GitHub Pages bajo
// /sistema-kalulu/, o un server local en la raíz) y sea cual sea la copia de
// este archivo (la de la raíz o la de admin-pos/).
const ROOT = self.location.href.replace(/(?:admin-pos\/)?sw\.js(?:\?.*)?$/, '');

// Hosts de CDN que SÍ se cachean (librerías estáticas que usa la app, fijas
// en una versión puntual). Nunca se cachea ningún otro origen — en particular
// nunca el tráfico real de Firestore (otro host, no pasa por acá de todos
// modos: usa su propio canal, no fetch() normal).
const CDN_HOSTS = ['www.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

const CDN_FILES = [
  'https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.1/firebase-storage-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.1/firebase-functions-compat.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.wasm',
];

// Rutas propias a precachear en la instalación, relativas a ROOT (sin `?v=`:
// el query string es puro cache-busting del lado del cliente, el server
// devuelve el mismo archivo la tenga o no).
const OWN_PATHS = [
  'index.html', 'admin-pos/index.html', 'views/login.html',
  'manifest.json', 'icons/pos-icon.svg', 'icons/admin-icon.svg',

  'css/reset.css', 'css/variables.css', 'css/layout.css', 'css/components.css',

  'js/utils.js', 'js/db.js', 'js/auth.js', 'js/sync.js', 'js/firebase-config.js',
  'js/print.js', 'js/icons.js', 'js/seed.js', 'js/app.js',

  'js/modules/configuracion.js', 'js/modules/proveedores.js', 'js/modules/promociones.js',
  'js/modules/limpieza_prueba.js', 'js/modules/usuarios.js', 'js/modules/inicio.js',
  'js/modules/adelanto_pago.js', 'js/modules/ajuste_stock.js', 'js/modules/ajuste_stock_positivo.js',
  'js/modules/consumo_interno.js', 'js/modules/roturas.js', 'js/modules/flujo.js',
  'js/modules/aprobaciones_pendientes.js', 'js/modules/buscador_productos.js', 'js/modules/clientes.js',
  'js/modules/grupos_sustitutos.js', 'js/modules/gastos.js', 'js/modules/pago_proveedor_wizard.js',
  'js/modules/sugerencias.js', 'js/modules/ordenes.js', 'js/modules/vencimientos.js',
  'js/modules/etiquetas.js', 'js/modules/peek_productos.js', 'js/modules/cuenta_corriente_proveedores.js',
  'js/modules/nota_credito_wizard.js', 'js/modules/caja.js', 'js/modules/pos.js',
  'js/modules/compras_v2.js', 'js/modules/familia.js', 'js/modules/informes.js',
  'js/modules/operaciones_stock.js', 'js/modules/editor-producto.js', 'js/modules/productos.js',

  'views/editor-producto.html', 'views/vencimientos.html', 'views/roturas.html',
  'views/gastos.html', 'views/proveedores.html', 'views/configuracion.html',
  'views/flujo.html', 'views/limpieza_prueba.html', 'views/usuarios.html',
  'views/etiquetas.html', 'views/ajuste_stock.html', 'views/ajuste_stock_positivo.html',
  'views/consumo_interno.html', 'views/caja.html', 'views/inicio.html',
  'views/aprobaciones_pendientes.html', 'views/adelanto_pago.html', 'views/clientes.html',
  'views/cuenta_corriente_proveedores.html', 'views/promociones.html', 'views/ordenes.html',
  'views/sugerencias.html', 'views/compras_v2.html', 'views/productos.html',
  'views/operaciones_stock.html', 'views/pos.html', 'views/informes.html',
];

function cacheKey(url) {
  const u = new URL(url, ROOT);
  u.search = ''; // ignora ?v=... para no acumular una entrada nueva por cada timestamp
  return u.href;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => {
      const ownUrls = OWN_PATHS.map((p) => ROOT + p);
      const tasks = ownUrls.map((url) =>
        fetch(url, { cache: 'reload' })
          .then((resp) => (resp.ok ? cache.put(cacheKey(url), resp) : null))
          .catch(() => {}) // un archivo que falle (ej. sin internet en la instalación) no bloquea el resto
      ).concat(
        // Los 3 CDN de CDN_HOSTS mandan Access-Control-Allow-Origin: * para
        // estos archivos (verificado con curl, 11/11/2026) — 'cors' en vez de
        // 'no-cors' evita guardar "opaque responses" (no se puede leer su
        // tamaño real ni si fallaron, y Chrome les aplica un padding de
        // seguridad que puede inflar la cuota de Cache Storage ~1000x).
        CDN_FILES.map((url) =>
          fetch(url, { mode: 'cors', cache: 'reload' })
            .then((resp) => (resp.ok ? cache.put(cacheKey(url), resp) : null))
            .catch(() => {})
        )
      );
      return Promise.all(tasks);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isOwn = url.origin === self.location.origin;
  const isCdn = CDN_HOSTS.includes(url.host);
  if (!isOwn && !isCdn) return; // nunca tocar otro origen (ej. Firestore real-time)

  const key = cacheKey(req.url);
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (!isOwn || resp.ok) {
          caches.open(CACHE).then((cache) => cache.put(key, resp.clone()));
        }
        return resp;
      })
      .catch(() => caches.match(key, { ignoreSearch: true }))
  );
});
