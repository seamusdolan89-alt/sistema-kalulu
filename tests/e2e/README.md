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
| `test_compras_v2_imp_interno_control.py` | Compras (Factura A): el control de cabecera ("≠ carrito") ya no marca falso mismatch cuando la factura del proveedor trae Impuesto Interno — el costo de línea se carga con el interno adentro (es lo que de verdad se paga), pero la propia factura lo excluye del "Subtotal Neto"; `calcNetoParaControl()` resta el `Imp. Interno` tipeado antes de comparar. No se discrimina por producto a propósito: el Impuesto Interno no da crédito fiscal (a diferencia del IVA), alcanza con el total de la factura |
| `test_compras_v2_markup_fijo.py` | **Markup predeterminado por producto** (`productos.markup_fijo`, campo unificado con Margen/Markup en Editor de Producto — checkbox "predeterminado" decide si se persiste): al confirmar una compra que le cambia el costo a un producto con markup fijo, `precio_venta` se recalcula SOLO (costo × (1 + markup%), redondeado al múltiplo de 10 más cercano — `window.SGA_Utils.roundTo10()`, el dueño nunca carga precios que no sean múltiplo de 10) sin pasar por el paso de revisar/aceptar precio — la fila de la pantalla de éxito aparece resuelta con el badge "Markup fijo (X%)". Corregir ese precio a mano pregunta (confirm) si eso actualiza el markup predeterminado para siempre o es una excepción de esa factura — "solo esta vez" no toca `markup_fijo`, y la siguiente compra que le cambie el costo vuelve a aplicar el de siempre, pisando el precio puntual. El mismo redondeo aplica a la sugerencia normal (productos SIN markup fijo). Si el producto además tiene familia (madre/hijo con herencia), el recálculo automático abre SOLO el wizard de sincronización de familia sin que haga falta tocar nada — y un re-render de la misma pantalla (Finalizar → Resumen Final → Volver) no lo vuelve a abrir para el mismo producto (`markupFamiliaPreguntado`) |
| `test_operaciones_stock_markup_fijo.py` | Historial de Compras → Ver (Operaciones de Stock): un producto con `markup_fijo` muestra el badge "Markup X%" junto al precio editable, comparado contra el costo de ESA línea de compra (no el costo actual del producto). Guardar un precio que coincide con el markup no pregunta nada; uno que no coincide dispara el mismo confirm que la pantalla de éxito post-compra — "Aceptar" actualiza `markup_fijo` (badge en vivo, sin recargar), "Cancelar" deja el precio puntual sin tocarlo |
| `test_cuenta_corriente_proveedores.py` | Compras (admin-pos): completar una compra a crédito genera el saldo correcto en Cuentas Corrientes; registrar un pago parcial lo imputa automáticamente por antigüedad y descuenta el saldo |
| `test_cuenta_corriente_proveedores_ver_compra.py` | Cuentas Corrientes de proveedores: botón "Ver" junto a cada fila "Compra" (en las dos vistas del ledger, Cronológico y Por factura) abre un detalle de solo lectura con los productos/cantidades/costos de esa compra — antes había que ir a Historial de Compras para verlo |
| `test_pos_multiples_medios_pago.py` | POS: venta con Cobro múltiple (split Efectivo + resto a Cta. Cte. del cliente) — regresión del bug `MPAY is not defined` que dejaba el botón Confirmar Venta permanentemente deshabilitado |
| `test_pos_cobro_multiple_medio_custom.py` | POS: Cobro múltiple con un medio custom agregado desde Configuración (ej. "Link de Pago") — regresión de `getTotalAsignado()`/armado de `pagos` con lista fija hardcodeada: el estado mostraba "✓ Cubierto" pero el botón Confirmar Venta quedaba deshabilitado y ese pago se perdía sin llegar a `venta_pagos` |
| `test_informes_resumen_otros.py` | Informes → Resumen Diario de Caja: un medio de pago custom (ej. "Link de Pago") ahora aparece en su propia columna "Otros" en vez de sumar solo al total sin desglosar — mismo patrón de listas hardcodeadas que `test_pos_cobro_multiple_medio_custom.py`, esta vez en el reporte |
| `test_pos_buscador_sugerencia_fantasma.py` | POS: al escanear un código de barras rápido (lector real), el dropdown del buscador ya no vuelve a aparecer solo con el producto recién agregado (race condition entre el debounce de 180ms y el Enter del lector) ni sobrevive a la venta siguiente |
| `test_pos_carrito_autoscroll.py` | POS: con el carrito lleno (más de ~7 ítems), agregar un producto nuevo hace autoscroll para que la fila quede visible sin scrollear a mano |
| `test_pos_ticket_escape_no_duplica_venta.py` | Con el ticket de venta en pantalla (la venta YA está registrada), Escape tiene que finalizar igual que F2/F10/el botón "✕" (`finalizeSaleAndGoDashboard`: limpia el carrito y navega a #inicio) — antes caía en el handler genérico de "cerrar el modal de encima" y dejaba el carrito intacto con "Confirmar venta" listo para volver a clickearse, la vía más común de venta duplicada, ahora también por teclado |
| `test_compras_carrito_autoscroll.py` | Compras (admin-pos): mismo autoscroll que en el POS, aplicado al carrito de una compra |
| `test_ordenes_agregar_orden_insercion.py` | Órdenes de Compra (admin-pos): agregar un producto manualmente a una orden lo deja al final del listado (orden de inserción), en vez de reordenar todo alfabéticamente por nombre |
| `test_ordenes_reordenar_alfabetico.py` | Órdenes de Compra (admin-pos): botón "A→Z" en el header "Descripción" reordena los items alfabéticamente de forma persistente (sobrevive a salir/reentrar a la orden), y agregar un producto nuevo después sigue yendo al final |
| `test_ordenes_exportar_imagen_calidad.py` | Órdenes de Compra (admin-pos): "Exportar imagen" usa `scale:3` en html2canvas (antes `scale:2`) para que la imagen quede más nítida al reenviarla por WhatsApp o hacerle zoom |
| `test_ordenes_exportar_pdf.py` | Órdenes de Compra (admin-pos): botón "Exportar PDF" (impresión nativa del navegador, sin librerías externas) para que WhatsApp no la recomprima como haría con una imagen enviada como "Foto" |
| `test_clientes_cuenta_corriente.py` | Clientes: saldo deudor correcto en la lista y en la ficha; registrar un pago desde la ficha descuenta el saldo y queda en el historial de movimientos |
| `test_clientes_detalle_venta.py` | Ficha de cliente: el link "#&lt;id&gt;" de una deuda en Cuenta Corriente y cada fila de Historial de Compras ya tenían el `data-venta` y el `cursor:pointer` puestos, pero sin ningún listener enganchado — clickear no hacía nada. Ahora abren un modal "Detalle de venta" (productos, cantidades, precios, medio de pago) desde los dos lugares |
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
| `test_stock_ledger.py` | **Registro de movimientos de stock (ledger), etapas 1 y 2.** `SGA_DB.moverStock()` es el UNICO punto de escritura de stock: agrega un movimiento inmutable a `stock_movimientos` y actualiza la cache `stock.cantidad` en la misma transaccion, asi `stock.cantidad == SUM(delta)` siempre (`SGA_DB.verificarIntegridadStock()`). Cubre moverStock (crea fila / no la crea / delta 0 / tira si falta el tipo), `setStockAbsoluto`, el relleno inicial de una sola vez, venta/edicion/anulacion/devolucion reales del POS, una regla estatica (ningun otro archivo escribe la tabla `stock`), y la etapa 2: los movimientos suben y bajan TAL CUAL (no como un 'sync' generico), dos compus mueven el MISMO producto sin coordinarse y el total converge en las dos, redelivery del mismo id no duplica nada, y un dispositivo NUEVO arranca con el bootstrap rapido de `stock` y se autocorrige solo cuando le llega el historial real de `stock_movimientos`. `helpers.assert_stock_integro(page)` verifica la invariante al final de los tests de ajustes, salidas, consumo, aprobaciones, compras, remitos y ventas |
| `test_stock_ledger_cutover.py` | Herramientas de reconciliacion del saldo inicial del ledger (`SGA_Sync.diagnosticarSaldoInicial` / `prepararAdopcionLedger`), para el corte real de la etapa 2 en produccion: las dos compus corrieron `backfillSaldoInicial()` por separado en la etapa 1, cada una con SU stock de ese momento (id determinístico `saldo_inicial:<producto>:<sucursal>`) — si no coincidian, quedaron en conflicto. Verifica que Admin-POS NUNCA sube su propio saldo inicial (queda el del POS en Firestore), que el diagnostico encuentra la divergencia, que `prepararAdopcionLedger()` se niega a correr en el POS, y que en Admin-POS adopta correctamente el del POS |
| `test_stock_ledger_migracion_legacy.py` | Regresion de un bug de migracion encontrado ANTES de promover la etapa 2 del ledger (sigue solo en `dev`): `ALTER TABLE stock_movimientos ADD COLUMN sync_status TEXT DEFAULT 'pending'` backfillea ese default a TODAS las filas viejas de una base que venia de la etapa 1 (comportamiento de SQLite), incluidos los movimientos tipo `'sync'` que `aplicarStockSync` (ya eliminada) creaba solo para que la cache local cuadrara con el valor absoluto que llegaba por el canal viejo — no son un hecho nuevo, son el reflejo local de algo que YA viajo. Sin arreglo, esas filas quedaban 'pending' y el push generico las subia por primera vez: la otra compu las aplicaba como un movimiento REAL nuevo, descontando dos veces (confirmado con este mismo simulador y contra `dev-kalulu`: un stock fisico real de 7 terminaba en 4 en las dos compus). El fix agrega, en el mismo `try` que agrega la columna, un `UPDATE ... SET sync_status='synced' WHERE sync_status='pending'` justo despues del ALTER. Chequeo estatico (estas tres sentencias en ese orden exacto en `js/db.js`) + dos escenarios dinamicos sobre productos distintos sembrados por SQL directo (mismo `saldo_inicial` en las dos compus, un movimiento real `'venta'` en una y un `'sync'` compensatorio en la otra, las dos arrancando en el fisico real 7): sin el fix (`sync_status='pending'`) un ciclo de sync converge MAL a 4 — reproduce el bug de punta a punta; con el fix (`sync_status='synced'`) el mismo ciclo converge BIEN a 7 en las dos, porque el historial viejo nunca se sube. Caveat documentado en el propio test: esto protege a un dispositivo que TODAVIA no corrio el ALTER buggy — uno que ya lo corrio sin el fix (columnas ya creadas) no se autorepara solo actualizando el codigo, hace falta limpieza de datos puntual |
| `test_editor_producto_movimientos_stock.py` | Editor de Producto → pestaña Transacciones muestra el REGISTRO REAL de movimientos de stock (`stock_movimientos`): compra, rotura, remito, venta y devolución con su motivo y quién lo hizo; la columna Saldo es el stock verdadero (el último saldo = stock actual) y el filtro por tipo no lo recalcula. Antes era un pseudo-historial reconstruido desde ventas/compras/ajustes que no incluía remitos ni devoluciones y nunca terminaba en el stock real |
| `test_sync_badge_admin.py` | El indicador de sync (🟡/🟢/🔴) en Admin-POS quedaba permanentemente en 🟡 "Sincronizando..." — `syncNow()` en modo admin nunca llamaba `updateSyncBadge('ok')` al terminar un ciclo (a diferencia de la rama POS, que sí). No afectaba los datos (pull/push seguían corriendo solos), solo el indicador mentía. Verifica el DOM real (`#sync-badge`) tras uno y dos ciclos de sync |
| `test_sync_caja_admin_pos.py` | La CAJA cuadra igual en el POS y en Admin-POS: un pago en efectivo a un proveedor hecho desde Admin-POS contra la caja abierta del local baja la caja esperada TAMBIEN en el POS (antes el POS no tenia receptor de `egresos_caja`/`ingresos_caja`/`sesiones_caja`/`ventas`/`consumo_interno`). Incluye dos guardas probadas con mutacion: una copia vieja 'abierta' del admin NO reabre una caja que el POS ya cerro, y una copia sin recuento NO borra el recuento de billetes en curso |
| `test_sync_borradores.py` | Ventas pausadas (`pedidos_abiertos`) y compras pausadas (`compras_pausadas`) se sincronizan: Admin-POS las ve, las elimina, y el borrado llega a la caja y no se resucita en un dispositivo nuevo. **Registra la deuda multi-caja**: una segunda caja POS todavia NO ve los borradores de la primera (no existe el canal POS<->POS); el test falla si eso empieza a funcionar, para sacar la deuda |
| `test_sync_admin_push_bandera_pulled.py` | Caso real "Agua Belen" (18/9/2026): en Admin-POS, `pushPending()` (que llaman gastos/compras/caja/aprobaciones) subia los docs SIN `_pulled:false` y los dejaba `synced`, asi que el POS nunca los descargaba; ahora en modo admin `pushPending()` = `pushToPos()`. Tambien cubre que `pushToPos()` suba TODA tabla pendiente (antes una lista fija dejaba afuera categorias, stock_ajustes, gastos_pagos, etc.). Usa un Firestore falso que registra cada `batch.set()` |
| `test_compras_editar_remito.py` | Compras → Remitos Pendientes → "✏️ Editar" (solo Admin-POS): sacar el producto equivocado, cambiar una cantidad y agregar el correcto mueve el stock por la diferencia neta por producto (no "revertir todo y recargar"), la línea editada conserva su `remito_items.id`, el remito queda `pending` para sync, avisa (confirm) antes de dejar stock negativo, restaura la pantalla al salir, y el botón no aparece en el POS del local |
| `test_stock_ajustes_sync.py` | Los 5 flujos de ajuste/salida de stock (Ingreso por Ajuste, Ajuste, Consumo Interno, Rotura, Vencimiento) marcan `stock.sync_status='pending'` al confirmar — antes ninguno lo hacía, así que el número de stock quedaba desincronizado entre POS y Admin-POS aunque el historial de movimientos sí viajara |
| `test_sync_skip_no_pierde_cambios.py` | Guarda anti-pisada (`tienePendienteLocal`): un documento entrante descartado por choque con un cambio local sin subir queda marcado "sin resolver" (`ultimoSkipPorPendiente`) en vez de darse por entregado — sin esto, ese cambio remoto (ej. el estado de una Orden de Compra) se perdía para siempre en vez de reintentarse |
| `test_editor_producto.py` | Editor de Producto (página completa, no confundir con la lista de `productos.js`): crear producto nuevo, editar uno existente, y que el margen se recalcule automáticamente al cambiar el precio |
| `test_editor_producto_sustitutos_cadena.py` | Sustitutos: elegir como referencia un producto que ya pertenece a otro grupo (o cambiar de grupo a uno al que otros ya apuntaban) avisa antes de escribir la cadena, se puede cancelar, y al confirmar repunta a todos los afectados sin dejar huérfanos — además marca sync_status='pending' en los productos que realmente cambiaron |
| `test_input_number_rueda.py` | La rueda del mouse NO cambia el valor de un campo numérico enfocado (cantidad/precio): listener global `wheel` en `app.js` que le saca el foco al `type="number"`, así el valor no cambia y el scroll sigue de largo. POS y Admin-POS |
| `test_compras_remito_enter_foco.py` | Compras "Sin Factura" (remito): Enter en la cantidad devuelve el foco al buscador (antes se quedaba en la cantidad: intentaba enfocar el "Nuevo costo", oculto en modo remito, y no caía al buscador). También verifica que en una compra normal Enter sigue saltando al costo |
| `test_operaciones_stock_historial_filtro_proveedor.py` | Historial de compras (Operaciones de Stock): filtro por proveedor — el select lista solo proveedores con compras, filtra al elegir, se combina con el rango de fechas y "Limpiar" lo resetea |
| `test_operaciones_stock_historial_orden.py` | Historial de compras: dos compras con la misma fecha de factura (mismo día) quedan ordenadas por orden real de carga (`updated_at` como desempate de `ORDER BY fecha DESC`), no al azar — la recién cargada no debe aparecer segunda |
| `test_compras_revision_menu_sin_recorte.py` | Compras — Revisión: los menús por fila ("Familia": sustituto/madre; "Desincorporar": rotura/consumo/producto no entregado) no se recortan en la última fila (antes el panel era absolute dentro de la tabla con overflow:hidden y la 3ra opción quedaba cortada), se abren hacia arriba si no entran, se cierran con 2º click / click afuera / scroll / Escape (sin cerrar Revisión) y cada opción de Desincorporar abre el modal de ajuste con su motivo elegido |
| `test_compras_revision_familia_info.py` | Compras — Revisión: los modales "Asociar sustituto"/"Asignar madre" muestran PRIMERO si el producto ya pertenece a una familia o a un grupo de sustitutos (referencia + quiénes le apuntan; madre + hermanos; o "ya es madre de N" con sus hijos, como lista `<li>` — no texto corrido, para que una familia grande no desborde la caja) antes de dejar buscar una asignación nueva — antes arrancaban directo en el buscador vacío sin ningún dato previo. Escape cierra ESTE modal y no filtra hacia la pantalla de Revisión de atrás (antes cerraba/afectaba Revisión en vez del modal de encima) |
| `test_compras_revision_seleccion_multiple.py` | Compras — Revisión, "Asociar sustituto"/"Asignar madre": candidatos que ya pertenecen a un grupo/familia se resaltan con un badge en los resultados de búsqueda; barra espaciadora (o un ☐/☑ por fila, `Buscador.attachDropdownKeyboard` con el nuevo `onSpace` opt-in) marca varios candidatos antes de aplicar el cambio a todos juntos. Sustituto: se elige UNA referencia final para todo el lote (fila original + marcados). Madre: el que se CLICKEA (no el checkbox) es siempre la madre; fila original + marcados quedan todos como sus hijos. Clickear un resultado sin marcar nada sigue siendo el camino simple de siempre (cubierto en `test_compras_revision_acciones_rapidas.py`) |
| `test_compras_revision_sustituto_corrige_cadenas.py` | "Asociar sustituto" en lote también sirve para corregir grupos viejos conflictivos. Marcar la REFERENCIA de un grupo viejo arrastra a sus seguidores solo, sin preguntar. Marcar un SEGUIDOR suelto (no la referencia) dispara un `confirm()`: "¿querés que su referencia vieja (y todo su grupo) también se una a la nueva?" — Aceptar arrastra todo el grupo viejo; Cancelar deja el comportamiento default (solo migra lo marcado, la referencia vieja queda sin grupo si se quedó sin nadie) |
| `test_cuenta_corriente_anular_pago.py` | **Anular pago a proveedor** (Cuentas Corrientes, solo Admin-POS + admin): borra el pago con sus medios e imputaciones y deja marca de borrado; las facturas que saldaba vuelven a quedar pendientes. Transferencia (no toca caja), pago sin imputar (se pierde el crédito), efectivo con caja ABIERTA (se revierte el egreso) y efectivo con caja CERRADA (la capa de datos exige confirmación y, al confirmar, la caja queda intacta). El POS del local no ve el botón ni puede llamarlo |
| `test_sync_anular_pago.py` | Anular un pago viaja al otro dispositivo: un pago en efectivo cargado en el POS (con su egreso en la caja abierta y aplicado a una factura) se anula desde Admin-POS y el POS pierde pago, medios, imputación Y egreso, la factura vuelve a figurar pendiente, y un Admin-POS nuevo con base vacía no lo resucita. Antes `pagos_proveedores`/`egresos_caja` no tenían borrado sincronizado (ni marca ni guarda `fueEliminado` en su apply*) |
| `test_compras_anular.py` | **Anular compra** (Historial de compras, solo Admin-POS + admin), para facturas cargadas por error (no es una NC): con una compra REAL cargada por el flujo de Compras verifica el modal (efectos + motivo obligatorio) y que quedan deshechos la deuda, el stock (movimiento nuevo de signo contrario, `stock.cantidad` íntegro), la imputación del pago (con marca de borrado; el pago sigue y su crédito vuelve), el ajuste pendiente (rechazado) y el costo (solo si era la última compra). Por SQL: bloqueo por ajuste ya aprobado, remito reabierto y costo NO revertido si hay una compra posterior. El POS no puede anular |
| `test_sync_anular_compra.py` | Anular una compra en Admin-POS llega al POS (y a un dispositivo nuevo): estado + motivo/quién/cuándo (columnas nuevas que `applyCompra` tiene que copiar), el movimiento de stock de reversión, la imputación liberada (con marca; no resucita desde el documento del pago que sigue en Firestore) y el costo revertido |
| `test_sync_compra_no_pisa_costo_paquete.py` | **Bug real reportado por el usuario (3/10/2026, caso "Cebolla")**: una compra que cambia costo y precio de venta sincronizaba con `costo` correcto pero `costo_paquete` y `precio_venta` viejos del otro lado. Causa: `applyCompra()` (sync.js) tenía su propia lógica duplicada y vieja (de mayo/2026) que re-actualizaba SOLO `productos.costo` al aplicar una compra — además de marcar `sync_status='pending'` sin ningún cambio local real, lo que activaba el guard anti-pisada de `applyProductoFull()` (que sí actualiza las 4 columnas juntas) y descartaba en silencio el documento de producto completo que llegaba en el mismo ciclo (`compras` se aplica antes que `productos`, orden fijo — 100% reproducible, no una carrera). Fix: se eliminó el UPDATE duplicado; el costo completo ya viaja solo por la sincronización propia de `productos`. Requiere que Admin-POS ya tenga el producto sincronizado ANTES de la compra para reproducir el bug (un producto nuevo no lo dispara, el UPDATE parcial no encuentra fila que pisar) |
| `test_nc_proveedor.py` | **Nota de crédito de proveedor** (Cuentas Corrientes + Historial de compras): un formulario con líneas de producto devuelto (bajan stock) y de concepto/descuento, NC A con IVA discriminado, total editable, aplicada a la factura de referencia o como crédito libre. Verifica saldo, stock, ledger (cronológico con insignia NC y por factura), que NO toca costos ni precios, el botón NC del Historial con la factura ya elegida, anular la NC (repone stock, libera la factura) y que una compra con NC asociada no se puede anular |
| `test_nc_proveedor_picker_restringido.py` | Con una factura de referencia elegida, el picker de productos de la NC deja de ser el buscador libre y se acota a lo que ESA factura tiene cargado (`compra_items`): líneas precargadas y destildadas por defecto, buscador libre oculto, tope de cantidad por línea (recorta y avisa si se escribe más de lo comprado), solo las líneas tildadas entran a la NC (mueven stock) y una tildada en 0 bloquea el guardado. Cambiar la referencia a otra factura recarga la lista (no la acumula) y volver a "Sin referencia" la limpia y devuelve el buscador libre |
| `test_sync_nc_proveedor.py` | La NC sincroniza completa entre POS y Admin-POS: datos propios (tipo, comprobante, letra, referencia, neto, IVA), líneas, imputación y el movimiento de stock de la devolución; el saldo da lo mismo en las dos compus; anularla viaja (pago, líneas, imputación, stock) y no resucita en un Admin-POS nuevo |
| `test_nc_migracion_check.py` | Una base YA existente (con el CHECK viejo de `pagos_proveedores_metodos`) se migra sola al arrancar para aceptar el método `nota_credito` sin perder ningún pago, y existen las columnas nuevas y la tabla de líneas de la NC |
| `test_aprobaciones_pendientes_doble.py` | **Aprobar/rechazar un ajuste de stock que otra pestaña de Admin-POS (o la otra compu, vía sync) ya resolvió no lo vuelve a tocar** — bug real: sin este chequeo, dos pestañas con la misma lista sin refrescar podían descontar el mismo stock dos veces. `aprobar()`/`rechazar()` releen el `estado` fresco antes y después del diálogo de confirmación; si ya no es `pendiente_aprobacion`, avisan (aprobado/rechazado/inexistente) y refrescan la lista sin tocar nada |
| `test_nc_provisoria_no_entregado.py` | **"Producto no entregado" acredita al proveedor con una NC provisoria** en vez de quedar como consumo interno: al aprobar (Aprobaciones Pendientes) el stock baja igual, NO se crea `consumo_interno` (Rotura sigue creándolo), y se genera UNA NC provisoria por compra (las aprobaciones siguientes le suman líneas; también reconoce el nombre viejo "…por proveedor") por costo × cantidad + IVA si la factura es A, aplicada sola a la factura de origen y sin volver a mover stock. "Completar NC" carga el N° y el importe real y re-aplica; una aprobación posterior abre otra provisoria. Rechazar no genera NC; Factura C no suma IVA |
| `test_sync_nc_provisoria.py` | El ciclo de la NC provisoria sincroniza en cada paso: nace, se le suma una línea (importe nuevo + imputación adicional, el medio de pago no se duplica), se completa con la NC real (N°, marca y importe) y las imputaciones viejas —borradas con marca al re-aplicar— no reaparecen en el POS ni en un Admin-POS nuevo |
| `test_pos_vuelto_a_favor_caja.py` | **Lo que el cliente deja de más, o la deuda que salda en el ticket, entra a la caja del MEDIO con que pagó** (bug real: cajas con sobrante cuando el cliente dejaba saldo a favor). Flujo real de la pantalla de venta: vuelto en efectivo dejado a favor → ingreso `vuelto_a_favor`; vuelto que cancela deuda → ingreso `cobro_cliente` (+ el resto a favor); deuda cobrada dentro de la venta → la venta registra solo lo suyo ($95) y la deuda ($60) va como cobranza de deuda; lo mismo con MercadoPago (venta + deuda + vuelto = todo lo que entró por MP); cliente que debe $5 y paga $100 exactos; cobro múltiple con vuelto (sale del efectivo) y excedente no devolvible (se frena); pago exacto / vuelto devuelto en mano no generan ingreso. En cada paso el esperado del efectivo == efectivo físico y el de MercadoPago == lo que entró. Anular la venta devuelve ese dinero (con marca) y editarla saca sus movimientos viejos (ingresos y cuenta corriente) para no duplicarlos |
| `test_caja_resumen_efectivo_recibido.py` | **El resumen del turno (al cerrar la caja) desglosa el "Efectivo recibido"**: cobranza de ventas / cobranza de deuda (incluida la que se salda dentro de una venta) / vuelto dejado a favor / otros ingresos, más "Otros medios recibidos" con cuánto entró por MercadoPago y su desglose (ventas + deuda + vuelto a favor), y "Saldo de caja" donde inicial + efectivo recibido − egresos = esperado = contado (cierra sin diferencias). También: la caja digital de MercadoPago suma todo lo que entró por ese medio con su origen, la pestaña Egresos e Ingresos lista los ingresos en efectivo con su tipo (y no los de otros medios), el Resumen tiene la tarjeta Ingresos, el esperado de los medios digitales en el cierre incluye deuda y vuelto a favor, el Resumen de sesión del historial trae el mismo desglose, y **Informes → Resumen Diario** muestra el día con origen y medio, coincidiendo con las cajas |
| `test_pos_cobro_multiple_saldo_favor.py` | **En cobro múltiple, el saldo a favor que se aplica a la venta se descuenta de la cuenta del cliente** (bug real: el total a cobrar bajaba pero el crédito no se consumía, el cliente lo usaba y lo seguía teniendo). Cliente con $30 a favor compra $95 en efectivo $40 + MercadoPago $25: la venta registra $30 de `saldo_favor`, la cuenta queda en $0 y los pagos suman el total |
| `test_editor_producto_iva.py` | **IVA por producto** (21% / 10,5% / sin discriminar, mismos 3 valores que el selector de línea de Compras/NC): el Editor de Producto (pestaña Precios y Costos) tiene el select `#ed-iva`, persiste en `productos.iva` con `sync_status='pending'` y se recarga al reabrir. En Compras (Factura A, único lugar con IVA por línea), agregar al carrito un producto con IVA ya guardado precarga la línea con ese valor (código ya existente, sin cubrir hasta ahora); y confirmar la compra con un IVA de línea distinto reescribe `productos.iva` (`commitCompra()` "aprende" el dato con cada factura real) |

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
