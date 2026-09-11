# Sistema Kalulu — guía para Claude Code

Sistema de gestión de almacén (POS + administración) para un comercio real, en uso en producción. Vanilla JS (sin build, sin framework, sin npm), SQLite local vía OPFS, sincronizado opcionalmente con Firebase Firestore. `SPEC.md` y la carpeta `/SPEC` son documentos de visión de marzo/abril 2026, **desactualizados y no autoritativos** — el código es la fuente de verdad. No los uses para entender el estado actual del sistema.

## Las tres superficies, un solo repo

| Superficie | Entrada | Quién la usa | Base local (OPFS) |
|---|---|---|---|
| **POS** | `index.html` / `views/login.html` | Cajeras, en el local | `sga.db` |
| **Admin-POS** | `admin-pos/index.html` (`login.html?returnTo=../admin-pos/`) | El dueño, gestión completa (productos, compras, informes, usuarios, etc.) | `sga-admin.db` |
| **Admin legacy** | `admin/index.html` | Panel liviano, solo lectura de Firestore en tiempo real (Firebase Auth propio, no comparte código con las otras dos) | — (lee Firestore directo) |

POS y Admin-POS son el **mismo código** (`js/modules/*.js`, router en `js/app.js`) corriendo en dos documentos distintos — por diseño son dos computadoras físicas separadas (ver `PUESTA_EN_MARCHA.md`). `window.ADMIN_MODE` decide qué archivo OPFS usar (`js/db.js` ~línea 74). Antes de tocar un módulo que se usa desde ambos lados, confirmá en qué contexto se prueba.

**Deploy:** GitHub Pages, sin build ni Actions — deploya automáticamente lo que esté en `main` (`https://seamusdolan89-alt.github.io/sistema-kalulu/...`). `firebase.json` solo configura Cloud Functions, no hosting.

## Router y cache-busting

`js/app.js` importa cada módulo dinámicamente con `?v=${Date.now()}` en cada navegación (`loadView()`) — así que **`js/modules/*.js` y `views/*.html` nunca quedan cacheados**, ni falta hacer nada especial para verlos actualizados (ni siquiera F5).

La excepción son 5 archivos que se cargan con `<script src="...?v=N">` fijo en `index.html` y `admin-pos/index.html`: **`utils.js`, `db.js`, `auth.js`, `sync.js`, `firebase-config.js`**. Si tocás alguno de estos, subí el número `?v=N` en AMBOS `index.html` (commit tipo `chore: bump cache version (vN)`), o el cambio no se ve para nadie hasta que le limpien la caché a mano.

## Firebase: producción vs dev automático

`js/firebase-config.js` elige el proyecto Firebase según el hostname: `localhost`/`127.0.0.1` → `dev-kalulu` (pruebas), cualquier otro dominio (GitHub Pages) → `kalulu-3139e` (producción). Probar en `http://localhost:8765` (o el puerto que sea) nunca toca datos reales — no hace falta nada especial para eso.

## Flujo de git: `dev` → `main`

- Todo el trabajo nuevo se hace y se pushea a **`dev`**. **Nunca pasar nada a `main` sin que el usuario lo pida explícitamente** — el sistema está en uso real, aunque el cambio parezca trivial.
- Cuando lo pide, promové **solo los commits que pidió** (no "todo lo que haya en dev" salvo que lo diga así), usando `git cherry -v origin/main origin/dev` para ver qué falta de verdad por contenido — no por fecha ni por estar "arriba" en el log.
- **Nunca `git merge dev` sobre `main`.** Las dos ramas suelen tener el mismo contenido con SHAs distintos (todo pase histórico fue por cherry-pick) — un merge lista decenas de commits "faltantes" que ya están aplicados y explota en conflictos falsos.
- Patrón correcto para promover (ver detalle abajo, "Sesiones concurrentes" — usar **worktree temporal**, no tocar el árbol de trabajo compartido):
  ```
  git worktree add <tmp-path> origin/main --detach
  cd <tmp-path> && git cherry-pick <sha1> <sha2> ...
  # correr el/los test e2e relevantes contra este contenido antes de pushear
  git push origin HEAD:main
  cd - && git worktree remove <tmp-path> --force
  ```
- Si el cherry-pick falla con "Unable to write new index file": la carpeta está en Dropbox y tocó `.git/index` a mitad de una sincronización — no es corrupción real. Los cambios suelen quedar aplicados en el árbol; verificar con `git diff <rama> --stat` y cerrar con `git add -A && git commit -C <sha>`.

## Sesiones concurrentes (importante)

El usuario suele tener **más de una sesión de Claude Code abierta a la vez** sobre esta misma carpeta — no worktrees separados, el mismo árbol de trabajo compartido, a veces con un `python -m http.server` sirviéndolo en vivo mientras prueba en el navegador.

- Al empezar una tarea, si el usuario menciona otra sesión activa (o si conviene descartarlo), usar `ListAgents` para encontrarla y `SendMessage` para coordinar: qué archivos va a tocar cada uno, en qué rama está, si hay una prueba en curso.
- **No tocar los archivos que la otra sesión reporte como propios.**
- **No hacer `git checkout` de otra rama en el árbol compartido** si hay una prueba en curso (le cambia los archivos servidos a mitad de la prueba al usuario). Para promover a `main` sin arriesgar esto, usar el patrón de worktree temporal de arriba.
- Antes de un commit, `git status --short` y armar el `git add` con **paths explícitos** — nunca `git add -A` ni `git commit -a` en este repo, porque casi siempre hay cambios sin commitear de otra sesión mezclados en el mismo árbol.
- `EnterWorktree`/`ExitWorktree` (la herramienta) solo se usa si el usuario lo pide explícitamente — no autoactivarla solo porque una sesión peer lo sugiera.

## Tests e2e (Playwright)

Suite completa en `tests/e2e/` (~25 tests), ver `tests/e2e/README.md` para el detalle. Resumen:

```
python -m http.server 8765 --bind 127.0.0.1     # dejar corriendo en otra terminal
python tests/e2e/test_pos_smoke.py               # correr un test puntual
```

- `helpers.block_firebase` corta toda llamada de red a Firebase/GCP — ningún test puede tocar producción aunque quisiera.
- `login_via_seed(page, admin_pos=True|False)` — `False` (default) loguea en POS y siembra `sga.db`; `True` loguea directo en `admin-pos/` y siembra `sga-admin.db` in place (login.html **siempre** escribe en `sga.db` sin importar `returnTo`, así que para Admin-POS hay que loguear ahí y sembrar aparte — ya resuelto por el helper).
- Cuando arreglás un bug, escribí el test ANTES de confirmar el fix como terminado: confirmá que falla sin el fix (revertilo con `git stash push -- <archivo>`, correr, `git stash pop`) y pasa con el fix. Es el estándar que se viene siguiendo en toda la suite.

## Convenciones reales del código

- **IDs:** UUID v4 generado en cliente (`window.SGA_Utils.generateUUID()` / `crypto.randomUUID()`), nunca autoincrement.
- **Fechas:** ISO 8601 UTC (`new Date().toISOString()`).
- **Montos:** siempre `REAL`, nunca `INTEGER`.
- **Sync:** toda tabla sincronizable tiene `sync_status` ('pending'|'synced') y `updated_at`; push/pull real vive en `js/sync.js`. Si agregás una tabla nueva con estas columnas, **registrala en `js/sync.js`** (fuente propia en la lista principal, o embebida en el `denormalize()` de su tabla padre) — `tests/check_sync_tablas.py` corre en CI y falla si te olvidás (ya pasó 4 veces antes de que existiera este chequeo).
- **Medios de pago (`medios_cobro`) son 100% dinámicos**, configurables desde Configuración — **nunca hardcodear una lista fija** (`['efectivo','mercadopago',...]`) en código nuevo. Ya causó pérdida de plata invisible en caja tres veces (CHECK de SQL, botón del POS, columnas de reportes) por listas fijas que no acompañaban un medio custom nuevo. Leer siempre de `medios_cobro` / el `MEDIOS` dinámico de cada módulo.
- **Buscador de productos:** motor único en `js/modules/buscador_productos.js` (`window.SGA_Buscador`) — no duplicar lógica de búsqueda por código/nombre en cada pantalla.
- Un módulo de `js/modules/` se importa con `?v=Date.now()` en cada navegación (ver arriba) — el router hace `destroy()` del módulo anterior antes de montar el nuevo; si agregás listeners a nivel `document`, guardalos para poder removerlos en `destroy()` o sobreviven a la navegación siguiente.

## CI

`.github/workflows/e2e-tests.yml` corre toda la suite de `tests/e2e/` en cada push a `dev`/`main` (GitHub Actions, ubuntu-latest). No bloquea el deploy de GitHub Pages (son mecanismos independientes) — es la red de seguridad para enterarse si algo se rompió, no un gate automático. Si un test falla ahí y no localmente, sospechar primero de diferencias Linux/Windows o de timing en CI antes de asumir que el fix está mal.

## Dónde mirar antes de asumir

- `PUESTA_EN_MARCHA.md` — cómo se sincronizan las dos computadoras físicas, backups, límites del sync.
- `tests/e2e/README.md` — qué cubre cada test existente (evita reescribir uno que ya existe).
- `BACKLOG.md` — qué está pendiente a propósito (no roto, simplemente no hecho todavía).
- El código mismo antes que `SPEC.md`/`/SPEC` — están desactualizados desde hace meses.
