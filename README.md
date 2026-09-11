# Sistema Kalulu

Sistema de gestión de almacén (punto de venta + administración) para un comercio real, en uso en producción. Vanilla JS — sin build, sin framework, sin npm — con SQLite local vía OPFS y sincronización opcional con Firebase Firestore.

> Para arquitectura detallada, flujo de git y convenciones de trabajo, ver **[CLAUDE.md](CLAUDE.md)**. Para cómo sincronizar las dos computadoras (local + admin), ver **[PUESTA_EN_MARCHA.md](PUESTA_EN_MARCHA.md)**. Para qué está pendiente, ver **[BACKLOG.md](BACKLOG.md)**.

## Las tres superficies

| Superficie | Entrada | Uso |
|---|---|---|
| **POS** | `index.html` / `views/login.html` | Venta en el local (cajeras) |
| **Admin-POS** | `admin-pos/index.html` | Gestión completa: productos, compras, órdenes, informes, usuarios, caja admin |
| **Admin legacy** | `admin/index.html` | Panel liviano de solo lectura sobre Firestore en tiempo real |

POS y Admin-POS comparten el mismo código (`js/modules/*.js`) pero corren sobre bases OPFS locales distintas (`sga.db` vs `sga-admin.db`) — en producción son dos computadoras físicas separadas.

## Estructura de archivos

```
/
├── index.html                  # Entry point del POS
├── admin-pos/index.html        # Entry point de Admin-POS (mismo código, otra DB local)
├── admin/                      # Panel legacy, lee Firestore directo
├── sw.js                       # Service worker (solo para instalar como PWA; network-first)
│
├── /css                        # Estilos globales (reset, variables, layout, componentes)
│
├── /js
│   ├── app.js                  # Router SPA — importa cada módulo con ?v=Date.now() (sin caché)
│   ├── db.js                   # Capa SQLite/OPFS + todas las migraciones de schema
│   ├── auth.js                 # Login local (SQLite + SHA-256), no depende de Firebase Auth
│   ├── sync.js                 # Push/pull con Firestore
│   ├── firebase-config.js      # Elige proyecto Firebase por hostname (dev-kalulu en localhost)
│   ├── utils.js                # Helpers generales (UUID, formatos, denominaciones, etc.)
│   ├── print.js                # Impresión de tickets/etiquetas (window.print, ESC/POS)
│   │
│   └── /modules                # Un módulo por pantalla — 28 módulos hoy, entre ellos:
│       ├── pos.js                          # Punto de venta
│       ├── productos.js / editor-producto.js / familia.js
│       ├── buscador_productos.js           # Motor único de búsqueda por código/nombre
│       ├── compras_v2.js / ordenes.js / proveedores.js / pago_proveedor_wizard.js
│       ├── cuenta_corriente_proveedores.js / adelanto_pago.js / gastos.js
│       ├── clientes.js
│       ├── caja.js / caja_admin.js
│       ├── operaciones_stock.js / ajuste_stock.js / ajuste_stock_positivo.js
│       ├── roturas.js / vencimientos.js / consumo_interno.js
│       ├── promociones.js / etiquetas.js
│       ├── usuarios.js / configuracion.js / limpieza_prueba.js
│       ├── informes.js
│       └── flujo.js                        # Flujo de fondos (proyección 14 días)
│
├── /views                      # Un .html por módulo, cargado dinámicamente por el router
├── /functions                  # Cloud Functions (OCR de facturas vía API de Claude — la key
│                                #   vive en Secret Manager, `defineSecret`, nunca en el cliente)
├── /tests/e2e                  # Suite Playwright — ver tests/e2e/README.md
├── /templates/facturas         # Templates OCR por proveedor
├── SPEC.md, /SPEC               # ⚠️ Históricos (marzo/abril 2026) — no reflejan el sistema actual
├── CLAUDE.md                    # Arquitectura, git workflow, convenciones vigentes
└── PUESTA_EN_MARCHA.md          # Sincronización entre las dos computadoras, backups
```

## Arquitectura

- **SPA sin build:** ruteo por hash (`#modulo`), cada módulo se importa dinámicamente y se destruye al navegar (`app.js`). Sin webpack/vite/npm — ES Modules nativos + `<script>` tags.
- **Offline-first:** toda la data vive en SQLite local (OPFS). La sincronización con Firestore es opcional/asíncrona — cada tabla sincronizable tiene `sync_status` y `updated_at`.
- **Deploy:** GitHub Pages, sin CI/build — lo que esté en `main` se sirve tal cual.
- **Auth:** 100% local (SQLite + SHA-256) para POS/Admin-POS; Firebase Auth solo en el panel legacy.
- **Impresión:** `window.print()` para etiquetas/PDFs, Web Serial API (ESC/POS) para tickets térmicos.
- **OCR de facturas:** Tesseract.js offline por template de proveedor; API de Claude vía Cloud Function solo para proveedores nuevos (la API key nunca llega al cliente).

## Correr localmente

```
python -m http.server 8765 --bind 127.0.0.1
```

Abrir `http://127.0.0.1:8765/views/login.html` — al ser `localhost`, usa automáticamente el proyecto Firebase de pruebas (`dev-kalulu`), nunca producción. Botón "Cargar Datos Demo" para poblar con datos ficticios.

## Tests

Suite de Playwright en `tests/e2e/` — ver [tests/e2e/README.md](tests/e2e/README.md) para el detalle de qué cubre cada test y cómo correrlos. Corre automáticamente en GitHub Actions con cada push a `dev`/`main` ([.github/workflows/e2e-tests.yml](.github/workflows/e2e-tests.yml)).

## Requisitos de navegador

Chrome/Edge 89+ (OPFS), Firefox 108+, Safari 16+ (soporte OPFS limitado).
