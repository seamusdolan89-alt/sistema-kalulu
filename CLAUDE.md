# Sistema Kalulu — guía para Claude Code

Sistema de gestión de almacén (POS + administración) para un comercio real, en uso en producción. Vanilla JS (sin build, sin framework, sin npm), SQLite local vía OPFS, sincronizado opcionalmente con Firebase Firestore. `SPEC.md` y la carpeta `/SPEC` son documentos de visión de marzo/abril 2026, **desactualizados y no autoritativos** — el código es la fuente de verdad. No los uses para entender el estado actual del sistema.

## Las tres superficies, un solo repo

| Superficie | Entrada | Quién la usa | Base local (OPFS) |
|---|---|---|---|
| **POS** | `index.html` / `views/login.html` | Cajeras, en el local | `sga.db` |
| **Admin-POS** | `admin-pos/index.html` (`login.html?returnTo=../admin-pos/`) | El dueño, gestión completa (productos, compras, informes, usuarios, etc.) | `sga-admin.db` |
| **Admin legacy** | `admin/index.html` | Panel liviano, solo lectura de Firestore en tiempo real (Firebase Auth propio, no comparte código con las otras dos) | — (lee Firestore directo) |

POS y Admin-POS son el **mismo código** (`js/modules/*.js`, router en `js/app.js`) corriendo en dos documentos distintos — por diseño son dos computadoras físicas separadas (ver `PUESTA_EN_MARCHA.md`). `window.ADMIN_MODE` decide qué archivo OPFS usar (`js/db.js` ~línea 74). Antes de tocar un módulo que se usa desde ambos lados, confirmá en qué contexto se prueba.

Esto también vale para el **CSS global** (`css/reset.css`, `variables.css`, `layout.css`, `components.css`): son los mismos 4 archivos en las dos superficies — una regla nueva ahí pega en POS y Admin-POS por igual salvo que la limites explícitamente. Desde el trabajo de "Admin-POS responsive" (BACKLOG.md) sí existe un gancho en el DOM para eso: `js/app.js` (`init()`) agrega `body.classList.add('admin-pos')` cuando `window.ADMIN_MODE` es true — usalo (`body.admin-pos ...`) para CSS exclusivo de esa superficie en vez de asumir que no hay forma de distinguirlas.

**Deploy:** GitHub Pages, sin build ni Actions — deploya automáticamente lo que esté en `main` (`https://seamusdolan89-alt.github.io/sistema-kalulu/...`). `firebase.json` solo configura Cloud Functions, no hosting.

## Router y cache-busting

`js/app.js` importa cada módulo dinámicamente con `?v=${Date.now()}` en cada navegación (`loadView()`) — así que **`js/modules/*.js` y `views/*.html` nunca quedan cacheados**, ni falta hacer nada especial para verlos actualizados (ni siquiera F5).

La excepción son 5 archivos que se cargan con `<script src="...?v=N">` fijo en **tres** entradas — `index.html`, `admin-pos/index.html` y `views/login.html` (login también los carga, para poder abrir la base antes de loguear) —: **`utils.js`, `db.js`, `auth.js`, `sync.js`, `firebase-config.js`**. Si tocás alguno de estos, subí el número `?v=N` en LAS TRES (commit tipo `chore: bump cache version (vN)`), o el cambio no se ve para nadie hasta que le limpien la caché a mano.

**Otra excepción real, no documentada hasta ahora (2026-09-17):** el `?v=${Date.now()}` solo lo lleva el `import()` dinámico que hace `loadView()` del módulo de la ruta actual (ej. `compras_v2.js`). Un `import` estático DENTRO de ese módulo hacia otro archivo (ej. `import Buscador from './buscador_productos.js'`, sin `?v=`) resuelve a una URL fija — si esa URL ya estaba en el registro de módulos ES del navegador (cargada antes, aunque haya sido por otra ruta que también la importa, como `ordenes.js`), el navegador reusa esa instancia vieja sin volver a pedirla, aunque el archivo en el server ya esté actualizado. Pasa con cualquier módulo compartido importado así (`buscador_productos.js`, `grupos_sustitutos.js`, `familia.js`, etc.) — a diferencia de lo que dice el párrafo de arriba, en este caso sí hace falta F5 (o mejor, hard refresh `Ctrl+Shift+R`) en las pestañas que ya estaban abiertas antes del cambio.

## Firebase: producción vs dev automático

`js/firebase-config.js` elige el proyecto Firebase según el hostname: `localhost`/`127.0.0.1` → `dev-kalulu` (pruebas), cualquier otro dominio (GitHub Pages) → `kalulu-3139e` (producción). Probar en `http://localhost:8765` (o el puerto que sea) nunca toca datos reales — no hace falta nada especial para eso.

**Login en un dispositivo nuevo (`views/login.html`):** si `?returnTo=` apunta a `admin-pos`, la página setea `window.ADMIN_MODE=true` ANTES de `SGA_DB.initialize()` (abre `sga-admin.db`, no `sga.db`) y, si esa base está vacía, corre `SGA_Sync.pullUsuariosOnly()` (trae *solo* la colección `usuarios`, no las ~28 completas) antes de dejar intentar el login — si no, un dispositivo que nunca entró a Admin-POS solo podía loguearse con el admin por defecto (`admin`/`kalulu123`) que crea `db.js` en la primera instalación, nunca con la contraseña real. Acotado a `usuarios` a propósito: la primera versión de este fix llamaba a `initialSyncFromFirestore()` completo, y en una base real con meses de ventas/compras eso podía tardar minutos en una conexión de celular antes de mostrar el formulario. El resto de las colecciones sigue llegando igual que siempre, pero recién después de loguearse (el overlay "Descargando datos..." de `admin-pos/index.html`, sin cambios) — salvo las de `MOBILE_SKIP_COLLECTIONS` (ver nota siguiente), que tampoco bajan ahí. El listener de submit del `<form>` se engancha de forma síncrona (antes de ese trabajo async) para que un click mientras el pre-sync está en curso no dispare un submit nativo del `<form>` sin handler todavía enganchado.

**Sync recortado en Admin-POS mobile (`js/sync.js`, `MOBILE_SKIP_COLLECTIONS` / `isMobileAdminPos()`):** en un celular (`window.ADMIN_MODE` true + `window.innerWidth <= 768`), tanto `initialSyncFromFirestore()` como el sync periódico de cada 5 min (`syncMonitoringData()`) saltean las colecciones que ninguna de las 5 áreas mobile lee (Clientes, Configuración, Flujo de Fondos, Consumo Interno, matcheo de códigos de proveedor, desglose de pagos de Gastos, cta cte de clientes) — auditado módulo por módulo antes de tocar esto (17/9/2026). A propósito **no** están en esa lista `compras`/`gastos`/`pagos_proveedores`/`ventas`/`sesiones_caja`/`ordenes_compra`/`stock_ajustes`: `getSaldoProveedor` (cuenta_corriente_proveedores.js) suma compras+gastos+pagos de toda la vida sin filtro de fecha, así que acotarlas arriesgaba mostrar un saldo de proveedor mal en el celular — mismo tipo de bug que ya pasó antes con medios de pago fijos (ver más abajo, "Convenciones reales del código"). Si agregás un módulo nuevo al alcance mobile (BACKLOG.md, "Admin-POS responsive"), revisá qué tablas lee antes de asumir que ya están en el sync recortado.

**Sync inicial partido en esencial/historial (`js/sync.js`, `ESSENTIAL_COLLECTIONS` / `syncHistoricalInBackground()`, 17/9/2026):** aun con `MOBILE_SKIP_COLLECTIONS` recortando lo que ningún módulo mobile lee, `initialSyncFromFirestore()` (dispositivo nuevo con la base local vacía) seguía bloqueando TODA la app detrás de `#initial-sync-overlay` hasta bajar `ventas`/`compras`/`stock_ajustes`/etc. completas — colecciones que crecen con el TIEMPO de uso real, no con la cantidad de productos, así que en producción con meses de historia esto colgaba la pantalla en "Descargando datos..." indefinidamente en una conexión de celular (reportado por el usuario probándolo en el teléfono). Ahora `initialSyncFromFirestore()` espera (bloqueante) solo `ESSENTIAL_COLLECTIONS` — el catálogo chico que no depende del tiempo (`usuarios`, `categorias`, `proveedores`, `productos`, `stock`, `medios_cobro`, `sucursales`) — y dispara el resto con `syncHistoricalInBackground()` **sin esperarlo** (fire-and-forget): quien llamó a la función recupera el control apenas termina el catálogo, el overlay se cierra y Productos/Inicio ya funcionan. El historial pesado sigue bajando solo, con el badge de sync (`updateSyncBadge`, 🟡→🟢) como único indicador — sin overlay del otro lado escuchando ya. Efecto secundario esperado y aceptado: recién entrado, Proveedores/Órdenes/Informes pueden verse incompletos (ej. saldo de un proveedor) hasta que ese lote de fondo termine — no hay otro aviso en la UI más que el badge. `closeOrphanSessions()` se movió al final del lote de fondo (depende de `sesiones_caja`, que ahora es historial). Verificado a mano contra `dev-kalulu` con un documento esencial y uno histórico recién escritos: al cerrarse el overlay el esencial ya estaba, el histórico no — llegó recién tras esperar `window.SGA_Sync.getHistoricalSyncPromise()` (expuesto para poder esperarlo desde afuera, ej. en tests). Si agregás una colección nueva a `initialSyncFromFirestore`, pensá si su tamaño depende de la cantidad de productos/proveedores (va en `ESSENTIAL_COLLECTIONS`) o del tiempo de uso del negocio (va al lote de fondo por default, no hace falta tocar nada).

**BUG GRAVE ya arreglado — Admin-POS dejó de subir cambios al POS durante ~2 días (16 al 18/9/2026):** al unificar los botones "⬇ Pull"/"⬆ Push POS" en uno solo ("Sincronizar", `syncNow()`, commit del 16/9), `syncNow()` en modo admin quedó llamando SOLO a `syncMonitoringData()` (pull) — `pushToPos()` (push de los cambios propios del admin hacia Firestore/POS) se quedó sin ningún llamador automático, ni en el botón ni en el timer de 5 min. Cualquier cambio hecho en Admin-POS (un pago a proveedor, una compra, etc.) quedaba `sync_status='pending'` en la base local para siempre: el botón decía "✓ Al día" pero nunca llegaba a Firestore ni al POS. Detectado porque el saldo de un proveedor no coincidía entre la compu de administración y la del local pese a haber "sincronizado" de los dos lados. Fix: `syncNow()` en modo admin ahora llama a `syncMonitoringData()` Y `pushToPos()` en el mismo ciclo. **Si viste este bug en producción:** una vez que la compu de administración corra el código con el fix (cache-bust de `sync.js` incluido) y sincronice una vez, todo lo que haya quedado `pending` localmente se sube solo — no hace falta backfill manual, `pushToPos()` barre todo lo pendiente de `ADMIN_PUSH_TABLES` cada vez que corre. Test de regresión: `tests/e2e/test_sync_admin_push_wired.py` (usa `__testForceInitialized()`, expuesto para simular "ya conectado" sin Firestore real). Verificado también de punta a punta contra `dev-kalulu`: push desde admin-pos → Firestore → pull en POS.

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
- `login_via_seed(page, admin_pos=True|False)` — `False` (default) loguea en POS y siembra `sga.db`; `True` loguea directo en `admin-pos/` y siembra `sga-admin.db` in place. Desde el fix de login en dispositivo nuevo (ver abajo), `login.html` con `?returnTo=admin-pos` ya abre `sga-admin.db` (no `sga.db`) y hace ADMIN_MODE=true antes de inicializar — pero el helper sigue sembrando datos demo aparte con `seed_in_place()` porque login.html solo crea el usuario admin por defecto, no productos/proveedores/categorías.
- Cuando arreglás un bug, escribí el test ANTES de confirmar el fix como terminado: confirmá que falla sin el fix (revertilo con `git stash push -- <archivo>`, correr, `git stash pop`) y pasa con el fix. Es el estándar que se viene siguiendo en toda la suite.

## Convenciones reales del código

- **IDs:** UUID v4 generado en cliente (`window.SGA_Utils.generateUUID()` / `crypto.randomUUID()`), nunca autoincrement.
- **Fechas:** ISO 8601 UTC (`new Date().toISOString()`).
- **Montos:** siempre `REAL`, nunca `INTEGER`.
- **Sync:** toda tabla sincronizable tiene `sync_status` ('pending'|'synced') y `updated_at`; push/pull real vive en `js/sync.js`. Si agregás una tabla nueva con estas columnas, **registrala en `js/sync.js`** (fuente propia en la lista principal, o embebida en el `denormalize()` de su tabla padre) — `tests/check_sync_tablas.py` corre en CI y falla si te olvidás (ya pasó 4 veces antes de que existiera este chequeo). Ese chequeo cubre solo el *registro* de la tabla — **no** cubre que cada `UPDATE`/`INSERT` puntual a una tabla ya registrada realmente marque `sync_status='pending'` (16/9/2026: 6 lugares tocaban `stock.cantidad` sin marcarla — el cambio quedaba guardado local y nunca viajaba). Ante cualquier "esto lo hice en una máquina y no aparece en la otra", sospechar primero de un `UPDATE` a una tabla sincronizable que se olvidó el `sync_status`, antes que de un problema de red o de Firestore.
- **Medios de pago (`medios_cobro`) son 100% dinámicos**, configurables desde Configuración — **nunca hardcodear una lista fija** (`['efectivo','mercadopago',...]`) en código nuevo. Ya causó pérdida de plata invisible en caja tres veces (CHECK de SQL, botón del POS, columnas de reportes) por listas fijas que no acompañaban un medio custom nuevo. Leer siempre de `medios_cobro` / el `MEDIOS` dinámico de cada módulo.
- **Buscador de productos:** motor único en `js/modules/buscador_productos.js` (`window.SGA_Buscador`) — no duplicar lógica de búsqueda por código/nombre en cada pantalla.
- **Grupos de sustitutos** (`producto_sustitutos`): no hay una tabla de "grupo" con ID propio, cada fila dice "mi referencia es X" — así que un producto puede terminar apuntando a otro que ya se unió a un grupo distinto (cadena rota, stock/reposición mal calculados). Único punto de escritura: `js/modules/grupos_sustitutos.js` (`window.SGA_GruposSustitutos`), función `aplicarCambioReferencia()` — resuelve la cadena en las dos direcciones y marca pendientes de sync los productos afectados. No escribir `producto_sustitutos` directo desde una pantalla nueva. Informes → "Grupos de Sustitutos" audita el catálogo existente en busca de cadenas rotas.
- Un módulo de `js/modules/` se importa con `?v=Date.now()` en cada navegación (ver arriba) — el router hace `destroy()` del módulo anterior antes de montar el nuevo; si agregás listeners a nivel `document`, guardalos para poder removerlos en `destroy()` o sobreviven a la navegación siguiente.

## Sync: criterio y cómo se audita (18/9/2026)

**Criterio del dueño: todo se sincroniza en ambos sentidos salvo excepciones explícitas y justificadas.** Lo que ve cada usuario se limita con *permisos*, nunca dejando de sincronizar. No hay lista de "tablas que viajan": no agregues tablas a una lista, y no confíes en tu memoria de cómo viaja algo — leé la función real (`apply*`/`denormalize*` en `js/sync.js`) y probalo.

- **`tests/e2e/test_sync_convergencia_tablas.py`** es la fuente de verdad: descubre las tablas del esquema REAL (`sqlite_master`) y prueba cada una en los dos sentidos con dos dispositivos reales (POS + Admin-POS) sobre un Firestore falso compartido (`tests/e2e/sync_sim.py`): alta con todas las columnas, actualización, borrado de hijos y de padres con marca, y un Admin-POS nuevo con la base vacía. Toda falla tiene que estar en `EXCEPCIONES_DISENO` (justificada) o `DEUDA` (con plan); si una entrada ya converge, el test falla para que la lista solo pueda encogerse. Una tabla nueva entra sola a la auditoría y falla hasta que sincronice bien. `python tests/e2e/test_sync_convergencia_tablas.py --informe` imprime todo sin fallar.
- Los hijos embebidos (`venta_items`, `compra_items`, …) viajan dentro del documento de su padre: el `apply*` tiene que **reemplazar** el conjunto (DELETE + INSERT), no solo insertar — al editar, los ids cambian y quedan líneas duplicadas.
- Los booleanos de SQLite viajan como el número `0`/`1`: usá `bool01(data.x)`, nunca `data.x !== false ? 1 : 0` (`0 !== false` es true → desactivar algo no viajaba).
- `INSERT OR REPLACE` reescribe la fila entera: toda columna que no esté en la lista del `apply*` vuelve a su default. La auditoría lo detecta.
- Borrar un registro sincronizable: `DELETE` + `SGA_DB.registrarEliminacion(tabla, id)` (la tabla tiene que estar en `HIJOS_DE` de `js/db.js`). Sin marca, el otro lado lo resucita — incluido un dispositivo nuevo.
- En Admin-POS, `SGA_Sync.pushPending()` delega en `pushToPos()` (sube con `_pulled:false`; el POS solo baja lo marcado). Los módulos pueden llamarlo sin saber en qué superficie corren.
- **Caja:** la caja esperada se SUMA desde filas (`caja.js getTotalesSesion`); los contadores `sesiones_caja.total_*` ya no los lee nadie — no los incrementes ni los leas. El cierre de `pos.js` (`cerrarCaja`, `showModalCierre`, `registrarEgreso`) es código muerto con la fórmula vieja.
- **Limitaciones conocidas (no soportado todavía):** (1) **multi-caja**: no existe el canal POS↔POS (el POS sube sin `_pulled` y solo baja lo marcado; una segunda caja no recibe lo de la primera); (2) **multi-sucursal**: todos los documentos se etiquetan con una sucursal fija (`SK_SUCURSAL_FIREBASE_ID`); (3) el **stock** se replica como valor absoluto (el último que escribe pisa al otro): hace falta un ledger de movimientos ANTES de habilitar POS↔POS; (4) sin comparar `updated_at` al aplicar: gana el último en llegar (la única guarda es `tienePendienteLocal`); (5) el simulador replica la semántica de Firestore leída del código, no se probó contra `dev-kalulu`.

## CI

`.github/workflows/e2e-tests.yml` corre toda la suite de `tests/e2e/` en cada push a `dev`/`main` (GitHub Actions, ubuntu-latest). No bloquea el deploy de GitHub Pages (son mecanismos independientes) — es la red de seguridad para enterarse si algo se rompió, no un gate automático. Si un test falla ahí y no localmente, sospechar primero de diferencias Linux/Windows o de timing en CI antes de asumir que el fix está mal.

## Dónde mirar antes de asumir

- `PUESTA_EN_MARCHA.md` — cómo se sincronizan las dos computadoras físicas, backups, límites del sync.
- `tests/e2e/README.md` — qué cubre cada test existente (evita reescribir uno que ya existe).
- `BACKLOG.md` — qué está pendiente a propósito (no roto, simplemente no hecho todavía).
- El código mismo antes que `SPEC.md`/`/SPEC` — están desactualizados desde hace meses.
