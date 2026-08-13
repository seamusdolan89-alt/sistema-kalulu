# Tests E2E — Sistema Kalulu

Tests de Playwright (Python) para verificar los módulos de la app contra un
servidor estático local, **sin tocar nunca el Firebase de producción**
(`kalulu-3139e`).

## Por qué es seguro

- El **login es 100% local** (SQLite/OPFS + SHA-256, ver `js/auth.js`) — no
  depende de Firebase Auth.
- `helpers.block_firebase` corta toda llamada de red hacia
  `firestore.googleapis.com`, `identitytoolkit.googleapis.com` y demás
  dominios de Firebase/GCP en el `BrowserContext`, antes de navegar. Todos
  los tests lo registran.
- El modo dev (`localStorage.dev_mode = 'true'`) habilita el botón
  **"Cargar Datos Demo"** en `login.html`, que carga una base local con
  datos ficticios (`js/seed.js`): admin, 5 categorías, 3 proveedores, 2
  productos con stock. Cada test corre sobre un browser context nuevo (DB
  vacía), así que no hay contaminación entre tests ni con datos reales.

**Credenciales en una DB local fresca:** `admin` / `kalulu123` (las crea
`js/db.js` en la primera inicialización — ver línea ~1176).

## Cómo correr un test

1. Levantar el servidor estático desde la raíz del repo (dejarlo corriendo
   en otra terminal):

   ```
   python -m http.server 8765 --bind 127.0.0.1
   ```

   > Usar `--bind 127.0.0.1` explícito. En Windows, bindear a `::` (default)
   > puede dejar conexiones IPv4 rotas si queda un `http.server` viejo
   > corriendo en el mismo puerto — si un test cuelga en `page.goto`, revisar
   > `Get-Process python` / `Get-NetTCPConnection -LocalPort 8765` y matar
   > procesos huérfanos.

2. Correr el test:

   ```
   python tests/e2e/test_pos_smoke.py
   ```

   O con el helper `with_server.py` de la skill `webapp-testing` (maneja el
   ciclo de vida del server automáticamente):

   ```
   python <ruta-a-skills>/webapp-testing/scripts/with_server.py \
       --server "python -m http.server 8765 --bind 127.0.0.1" --port 8765 \
       -- python tests/e2e/test_pos_smoke.py
   ```

Los screenshots quedan en `tests/e2e/screenshots/` (gitignored).

## Helpers disponibles (`helpers.py`)

| Función | Qué hace |
|---|---|
| `block_firebase(route)` | Handler para `context.route("**/*", ...)` — aborta llamadas a Firebase/GCP |
| `enable_dev_mode(context)` | Activa `dev_mode` antes de que cargue la página |
| `login_via_seed(page, wait_target="pos")` | Login completo con datos demo cargados (usar en el primer paso de cada test) |
| `login_direct(page, ...)` | Login sin re-seedear (reusar sesión/DB entre pasos) |

## Dos bases de datos locales — POS vs Admin-POS

`js/db.js` usa un archivo OPFS distinto según el contexto:

```js
const dbFileName = window.ADMIN_MODE ? 'sga-admin.db' : 'sga.db';
```

Esto es a propósito (en producción son dos computadoras físicas separadas —
ver `PUESTA_EN_MARCHA.md`). Pero `login.html` **siempre** inicializa/escribe
en `sga.db`, sin importar el `returnTo` — así que el botón "Cargar Datos
Demo" de login.html solo sirve para poblar el POS. Para Admin-POS (Compras,
Cuentas Corrientes, Órdenes, etc.), `login_via_seed(page, admin_pos=True)`
loguea ahí primero y corre el seed *in place* (`seed_in_place()`), que sí
escribe en `sga-admin.db`. No hace falta pensar en esto al escribir un test
nuevo — `login_via_seed()` ya lo resuelve — pero es la explicación si algo
sale "vacío" inesperadamente.

## Tests existentes

| Archivo | Cubre |
|---|---|
| `test_pos_smoke.py` | Login → POS carga → sidebar completo → modal Apertura de Caja |
| `test_compras_carrito_revision.py` | Compras (admin-pos): columna IVA en Factura A, subtotal con descuento en Carrito, y que coincida con Revisión (regresión del fix `compras-v2-descuento-iva`) |
| `test_cuenta_corriente_proveedores.py` | Compras (admin-pos): completar una compra a crédito genera el saldo correcto en Cuentas Corrientes; registrar un pago parcial lo imputa automáticamente por antigüedad y descuenta el saldo |
| `test_pos_multiples_medios_pago.py` | POS: venta con Cobro múltiple (split Efectivo + resto a Cta. Cte. del cliente) — regresión del bug `MPAY is not defined` que dejaba el botón Confirmar Venta permanentemente deshabilitado |
| `test_clientes_cuenta_corriente.py` | Clientes: saldo deudor correcto en la lista y en la ficha; registrar un pago desde la ficha descuenta el saldo y queda en el historial de movimientos |
| `test_promociones.py` | Crear una promoción (10% sobre un producto) y verificar que se aplica automáticamente al agregarlo al carrito en el POS |
| `test_consumo_interno.py` | Consumo interno atribuido a otro usuario: pide contraseña, rechaza vacía/incorrecta, guarda con la correcta; el registro queda `usuario_id`=atribuido / `registrado_por_usuario_id`=quien operaba; stock se descuenta |
| `test_operaciones_stock_salidas.py` | Rotura + Vencimiento + Consumo Interno, y el informe "Salidas de Stock (no venta)" (commit 7dd1082) agrupando por persona con valuación a costo/venta y filtro por tipo |
| `test_usuarios_permisos.py` | Regresión del guard de rutas (`isRouteAllowed` en app.js): un usuario sin permiso queda bloqueado accediendo por URL directa (no solo oculto del menú); admin en POS local y admin-pos no pierden nada |
| `test_usuarios_rediseno_permisos.py` | Rediseño de Usuarios: plantilla de rol aplicada desde la UI, dependencia blanda (editar productos auto-tilda y bloquea "ver productos"), guardar, loguearse como ese usuario y verificar que el enforcement real (productos.js, operaciones_stock.js, router) coincide con la plantilla |

Nota: toda compra en este sistema queda "Cta. Cte." — la condición de pago
está fija en `compras_v2.js` (`state.condicionPago = 'pendiente'`, sin
toggle en la UI), así que cualquier compra completada sirve para generar
saldo de prueba en Cuentas Corrientes.

## Próximos módulos a cubrir

- Etiquetas, órdenes de compra — se van agregando como `test_<modulo>.py`
  reusando `helpers.py`.
- El modal de herencia de familias en Compras (`showHerenciaModal`) ya fue
  validado manualmente por el usuario — no hace falta cubrirlo con e2e por
  ahora (ver memoria `project_compras_v2_pendiente.md`).

## Hallazgo cerrado — no era un bug

Una versión anterior de `test_consumo_interno.py` reportaba un error de
consola reproducible ("NotFoundError: node no longer a child of this
node") al cambiar la cantidad en el carrito vía
`input.dispatch_event("change")`. Se investigó con el stack trace completo
(`exc.stack` del `pageerror`) y apuntaba a `renderCart()` en
`consumo_interno.js` — pero al reproducir el mismo cambio de cantidad con
una interacción **real** (escribir + click en otro campo, blur genuino en
vez de `dispatch_event` sintético), el mismo flujo funciona sin ningún
error. Conclusión: era un artefacto del test, no un bug de la app. Moraleja
para escribir tests nuevos — **preferir interacciones reales
(`.click()`, `.fill()` + click en otro elemento) a `dispatch_event()`
sintético** cuando el código de la app depende de eventos `change`/`blur`
nativos en inputs.
