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
| `login_via_seed(page, wait_target="inicio")` | Login completo con datos demo cargados (usar en el primer paso de cada test). El POS arranca en `#inicio` (dashboard, ver `inicio.js`) — para tests que interactúan con el carrito/caja hay que navegar a `#pos` explícitamente después (`page.evaluate("window.location.hash = 'pos'")`) |
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

> `sync_sim.py` (en esta carpeta, sin prefijo `test_` a proposito para que el CI no lo ejecute como test) es el simulador de dos dispositivos: `with Simulador() as sim:` da `sim.pos` y `sim.admin` (cada uno con `q()/run()/push()/pull()`), y `sim.nuevo_dispositivo()` para un Admin-POS con base vacia.


| Archivo | Cubre |
|---|---|
| `test_pos_smoke.py` | Login → POS carga → sidebar completo → modal Apertura de Caja |
| `test_inicio_dashboard.py` | Dashboard "Inicio" del POS del local (no Admin-POS): arranca ahí para cualquier rol, los 3 KPIs (turno/más vendidos/reponer en góndola) no rompen sin datos, los accesos rápidos navegan a donde corresponde ("Nueva venta" entra al flujo real, no al dashboard interno de ventas de pos.js), y Admin-POS sigue arrancando en `#productos` sin "Inicio" en el menú |
| `test_compras_carrito_revision.py` | Compras (admin-pos): columna IVA en Factura A, subtotal con descuento en Carrito, y que coincida con Revisión (regresión del fix `compras-v2-descuento-iva`) |
| `test_cuenta_corriente_proveedores.py` | Compras (admin-pos): completar una compra a crédito genera el saldo correcto en Cuentas Corrientes; registrar un pago parcial lo imputa automáticamente por antigüedad y descuenta el saldo |
| `test_pos_multiples_medios_pago.py` | POS: venta con Cobro múltiple (split Efectivo + resto a Cta. Cte. del cliente) — regresión del bug `MPAY is not defined` que dejaba el botón Confirmar Venta permanentemente deshabilitado |
| `test_pos_cobro_multiple_medio_custom.py` | POS: Cobro múltiple con un medio custom agregado desde Configuración (ej. "Link de Pago") — regresión de `getTotalAsignado()`/armado de `pagos` con lista fija hardcodeada: el estado mostraba "✓ Cubierto" pero el botón Confirmar Venta quedaba deshabilitado y ese pago se perdía sin llegar a `venta_pagos` |
| `test_informes_resumen_otros.py` | Informes → Resumen Diario de Caja: un medio de pago custom (ej. "Link de Pago") ahora aparece en su propia columna "Otros" en vez de sumar solo al total sin desglosar — mismo patrón de listas hardcodeadas que `test_pos_cobro_multiple_medio_custom.py`, esta vez en el reporte |
| `test_pos_buscador_sugerencia_fantasma.py` | POS: al escanear un código de barras rápido (lector real), el dropdown del buscador ya no vuelve a aparecer solo con el producto recién agregado (race condition entre el debounce de 180ms y el Enter del lector) ni sobrevive a la venta siguiente |
| `test_pos_carrito_autoscroll.py` | POS: con el carrito lleno (más de ~7 ítems), agregar un producto nuevo hace autoscroll para que la fila quede visible sin scrollear a mano |
| `test_compras_carrito_autoscroll.py` | Compras (admin-pos): mismo autoscroll que en el POS, aplicado al carrito de una compra |
| `test_ordenes_agregar_orden_insercion.py` | Órdenes de Compra (admin-pos): agregar un producto manualmente a una orden lo deja al final del listado (orden de inserción), en vez de reordenar todo alfabéticamente por nombre |
| `test_ordenes_reordenar_alfabetico.py` | Órdenes de Compra (admin-pos): botón "A→Z" en el header "Descripción" reordena los items alfabéticamente de forma persistente (sobrevive a salir/reentrar a la orden), y agregar un producto nuevo después sigue yendo al final |
| `test_ordenes_exportar_imagen_calidad.py` | Órdenes de Compra (admin-pos): "Exportar imagen" usa `scale:3` en html2canvas (antes `scale:2`) para que la imagen quede más nítida al reenviarla por WhatsApp o hacerle zoom |
| `test_ordenes_exportar_pdf.py` | Órdenes de Compra (admin-pos): botón "Exportar PDF" (impresión nativa del navegador, sin librerías externas) para que WhatsApp no la recomprima como haría con una imagen enviada como "Foto" |
| `test_clientes_cuenta_corriente.py` | Clientes: saldo deudor correcto en la lista y en la ficha; registrar un pago desde la ficha descuenta el saldo y queda en el historial de movimientos |
| `test_promociones.py` | Crear una promoción (10% sobre un producto) y verificar que se aplica automáticamente al agregarlo al carrito en el POS |
| `test_consumo_interno.py` | Consumo interno atribuido a otro usuario: pide contraseña, rechaza vacía/incorrecta, guarda con la correcta; el registro queda `usuario_id`=atribuido / `registrado_por_usuario_id`=quien operaba; stock se descuenta |
| `test_operaciones_stock_salidas.py` | Rotura + Vencimiento + Consumo Interno, y el informe "Salidas de Stock (no venta)" (commit 7dd1082) agrupando por persona con valuación a costo/venta y filtro por tipo |
| `test_usuarios_permisos.py` | Regresión del guard de rutas (`isRouteAllowed` en app.js): un usuario sin permiso queda bloqueado accediendo por URL directa (no solo oculto del menú); admin en POS local y admin-pos no pierden nada |
| `test_usuarios_rediseno_permisos.py` | Rediseño de Usuarios: plantilla de rol aplicada desde la UI, dependencia blanda (editar productos auto-tilda y bloquea "ver productos"), guardar, loguearse como ese usuario y verificar que el enforcement real (productos.js, operaciones_stock.js, router) coincide con la plantilla |
| `test_caja_movimientos.py` | Caja: egreso/ingreso calculan bien el saldo esperado; cierre de caja concilia en cero; regresión del bug real `clave`/`valor` vs `key`/`value` en "Editar denominaciones" (guardaba "✓ Guardado" pero nunca persistía) |
| `test_caja_pago_proveedor.py` | "💳 Pago a Proveedor" desde Caja: un pago descuenta la caja (egreso) Y la cuenta corriente del proveedor a la vez |
| `test_gastos_generales.py` | Buscar un proveedor de servicios (`tipo_proveedor='servicios'`) y cargar un gasto |
| `test_adelanto_pago.py` | Adelanto de Pago a proveedor (admin-only): se registra como crédito huérfano (`pagos_proveedores`), sin imputar todavía, listo para aplicarse a la próxima compra |
| `test_informes.py` | Los 8 reportes de Informes (Ventas por Producto, Análisis de Productos, Ventas por Transacción, Quiebres de Stock, Ventas por Vendedor, Aging CC, Resumen Diario de Caja, Stock sin Movimiento) — verifica los números exactos, no solo que rendericen |
| `test_informes_sustitutos_grupos.py` | Informes → "Grupos de Sustitutos": audita `producto_sustitutos` y detecta cadenas rotas (un producto apunta como referencia a otro que ya se unió a otro grupo distinto) |
| `test_compras_vincular_remito_barcode_duplicado.py` | Compras → "Vincular Factura" desde un remito pendiente: un producto con código de barras duplicado (`es_principal=1` repetido) ya no duplica la fila en el carrito (mismo patrón de JOIN sin límite que en Órdenes/Informes) |
| `test_sync_convergencia_tablas.py` | **Auditoria de sync tabla por tabla y en los dos sentidos** con DOS dispositivos reales (POS + Admin-POS) contra un Firestore falso compartido (`sync_sim.py`). Descubre las tablas del esquema REAL (sqlite_master), no de una lista: para cada una prueba alta con todas las columnas, actualizacion, borrado de hijos, borrado de padres con marca de eliminacion, y un Admin-POS nuevo con base vacia. Toda falla tiene que estar en `EXCEPCIONES_DISENO` (justificada) o en `DEUDA` (con plan); si una entrada ya converge el test falla para que la lista solo pueda encogerse. `--informe` imprime todo sin fallar |
| `test_stock_ledger.py` | **Registro de movimientos de stock (ledger), etapa 1.** `SGA_DB.moverStock()` es el UNICO punto de escritura de stock: agrega un movimiento inmutable a `stock_movimientos` y actualiza la cache `stock.cantidad` en la misma transaccion, asi `stock.cantidad == SUM(delta)` siempre (`SGA_DB.verificarIntegridadStock()`). Cubre moverStock (crea fila / no la crea / delta 0 / tira si falta el tipo), `setStockAbsoluto`, el relleno inicial de una sola vez, venta/edicion/anulacion/devolucion reales del POS, el receptor de sync, y una regla estatica: ningun otro archivo escribe la tabla `stock`. `helpers.assert_stock_integro(page)` verifica la invariante al final de los tests de ajustes, salidas, consumo, aprobaciones, compras, remitos y ventas |
| `test_editor_producto_movimientos_stock.py` | Editor de Producto → pestaña Transacciones muestra el REGISTRO REAL de movimientos de stock (`stock_movimientos`): compra, rotura, remito, venta y devolución con su motivo y quién lo hizo; la columna Saldo es el stock verdadero (el último saldo = stock actual) y el filtro por tipo no lo recalcula. Antes era un pseudo-historial reconstruido desde ventas/compras/ajustes que no incluía remitos ni devoluciones y nunca terminaba en el stock real |
| `test_sync_caja_admin_pos.py` | La CAJA cuadra igual en el POS y en Admin-POS: un pago en efectivo a un proveedor hecho desde Admin-POS contra la caja abierta del local baja la caja esperada TAMBIEN en el POS (antes el POS no tenia receptor de `egresos_caja`/`ingresos_caja`/`sesiones_caja`/`ventas`/`consumo_interno`). Incluye dos guardas probadas con mutacion: una copia vieja 'abierta' del admin NO reabre una caja que el POS ya cerro, y una copia sin recuento NO borra el recuento de billetes en curso |
| `test_sync_borradores.py` | Ventas pausadas (`pedidos_abiertos`) y compras pausadas (`compras_pausadas`) se sincronizan: Admin-POS las ve, las elimina, y el borrado llega a la caja y no se resucita en un dispositivo nuevo. **Registra la deuda multi-caja**: una segunda caja POS todavia NO ve los borradores de la primera (no existe el canal POS<->POS); el test falla si eso empieza a funcionar, para sacar la deuda |
| `test_sync_admin_push_bandera_pulled.py` | Caso real "Agua Belen" (18/9/2026): en Admin-POS, `pushPending()` (que llaman gastos/compras/caja/aprobaciones) subia los docs SIN `_pulled:false` y los dejaba `synced`, asi que el POS nunca los descargaba; ahora en modo admin `pushPending()` = `pushToPos()`. Tambien cubre que `pushToPos()` suba TODA tabla pendiente (antes una lista fija dejaba afuera categorias, stock_ajustes, gastos_pagos, etc.). Usa un Firestore falso que registra cada `batch.set()` |
| `test_compras_editar_remito.py` | Compras → Remitos Pendientes → "✏️ Editar" (solo Admin-POS): sacar el producto equivocado, cambiar una cantidad y agregar el correcto mueve el stock por la diferencia neta por producto (no "revertir todo y recargar"), la línea editada conserva su `remito_items.id`, el remito queda `pending` para sync, avisa (confirm) antes de dejar stock negativo, restaura la pantalla al salir, y el botón no aparece en el POS del local |
| `test_stock_ajustes_sync.py` | Los 5 flujos de ajuste/salida de stock (Ingreso por Ajuste, Ajuste, Consumo Interno, Rotura, Vencimiento) marcan `stock.sync_status='pending'` al confirmar — antes ninguno lo hacía, así que el número de stock quedaba desincronizado entre POS y Admin-POS aunque el historial de movimientos sí viajara |
| `test_sync_skip_no_pierde_cambios.py` | Guarda anti-pisada (`tienePendienteLocal`): un documento entrante descartado por choque con un cambio local sin subir queda marcado "sin resolver" (`ultimoSkipPorPendiente`) en vez de darse por entregado — sin esto, ese cambio remoto (ej. el estado de una Orden de Compra) se perdía para siempre en vez de reintentarse |
| `test_editor_producto.py` | Editor de Producto (página completa, no confundir con la lista de `productos.js`): crear producto nuevo, editar uno existente, y que el margen se recalcule automáticamente al cambiar el precio |
| `test_editor_producto_sustitutos_cadena.py` | Sustitutos: elegir como referencia un producto que ya pertenece a otro grupo (o cambiar de grupo a uno al que otros ya apuntaban) avisa antes de escribir la cadena, se puede cancelar, y al confirmar repunta a todos los afectados sin dejar huérfanos — además marca sync_status='pending' en los productos que realmente cambiaron |

Nota: toda compra en este sistema queda "Cta. Cte." — la condición de pago
está fija en `compras_v2.js` (`state.condicionPago = 'pendiente'`, sin
toggle en la UI), así que cualquier compra completada sirve para generar
saldo de prueba en Cuentas Corrientes.

## Próximos módulos a cubrir

- Proveedores (CRUD completo), Órdenes de Compra, Etiquetas,
  Devoluciones/Pedido Abierto (dentro de POS) — se van agregando como
  `test_<modulo>.py` reusando `helpers.py`.
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
