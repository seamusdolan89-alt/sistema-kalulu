# Backlog

Reemplaza la sección "Pendiente de implementar" de `SPEC.md` (que quedó marcada como histórica). Este archivo sí se mantiene al día — cuando algo de acá se implementa, se borra de la lista (el detalle queda en el commit y, si hace falta, en `CLAUDE.md`); cuando surge algo nuevo para más adelante, se agrega.

No es un audit exhaustivo del código — es lo que se sabe pendiente en cada momento. Se arma conversacionalmente: cuando algo queda para después en vez de resolverse en el momento, anotarlo acá.

## Pendiente

### OCR de facturas de compra
- **Estado real (verificado 2026-09):** el lado servidor existe (`functions/index.js`, función `interpretarFacturaCompra`, usa la API de Claude vía `ANTHROPIC_API_KEY` como secret de Firebase) pero **no está deployada** (falta activar el plan Blaze del proyecto Firebase y configurar el secret) **ni conectada a ninguna pantalla** — ningún módulo del cliente la llama todavía.
- La ruta "carga manual" (`compras_v2.js`, flujo tipo POS de 5 pasos) cubre el caso de uso mientras tanto.
- Pendiente también: integración con Tesseract.js para lectura offline por template de proveedor (evita llamar a la API en proveedores ya conocidos).

### POS "flotante" — vender sin perder la compra que se está cargando

**Estado: analizado, sin implementar. El usuario está evaluando si vale la pena.**

El problema: el 90% de las veces que la cajera pausa una compra a medio cargar es
porque entró un cliente. Pausar y retomar es la herramienta equivocada para eso.

La idea: abrir el POS **encima** de la compra, cobrar, y que la ventana se cierre
sola al confirmar la venta — devolviendo a la cajera exactamente donde estaba. Se
cierra sola a propósito: si se pudiera dejar abierta "por si viene otro cliente",
se queda abierta y la compra se olvida.

Decidido con el usuario: **reusar el POS real**, no una pantalla de venta aparte,
para no terminar con dos lugares donde se vende y que uno quede atrás del otro.

**Lo que el análisis (2026-09-11) encontró a favor:**

- Las dos vistas pueden convivir en el DOM: 141 ids en `pos.html`, 95 en
  `compras_v2.html`, **cero en común**.
- Los dos módulos ya tienen `destroy()` que quita sus listeners de teclado, y
  `compras_v2` tiene `setupKeyboard()` para rearmarlo. Esa pieza existe porque se
  construyó al arreglar las ventas duplicadas.
- `finalizeSaleAndGoDashboard` (pos.js) es el **único** punto de salida después de
  una venta — atiende tanto cerrar como confirmar el ticket. Ahí engancha el
  cierre automático, en un solo lugar.
- El estado del POS vive dentro de `init()`, así que una instancia nueva arranca
  limpia.
- `pos.html` no trae `<script>` propio y su CSS no usa selectores genéricos: no se
  filtra a la pantalla de compras.

**Lo que hay que resolver:**

1. **El router no sirve.** `loadView` hace `innerHTML` sobre `#app`: navegar
   destruye la compra. El POS flotante necesita contenedor propio fuera de `#app`,
   con su propio fetch de la vista e import del módulo.
2. **El teclado es el riesgo principal.** Los dos escuchan en `document`; con los
   dos vivos una tecla dispara las dos pantallas — la misma familia de bugs que
   las ventas duplicadas. Hay que desarmar el teclado de compras al abrir y
   rearmarlo al cerrar, **por todos los caminos de salida**.
3. **El POS salta por hash en dos lugares** (`pos.js` ~2625 y ~2765: modal de
   navegación y cierre de caja). Cualquiera volaría la compra; hay que
   neutralizarlos en modo flotante.
4. **El guardia de navegación** de `app.js` (~472) ya bloquea salir del POS con
   carrito activo. Hay que decidir cómo se comporta cuando el POS es una ventana.

**Sin decidir todavía:**

- Si la cajera cierra sin cobrar, ¿se descarta el carrito o queda? (Hoy `pos_cart`
  vive en sessionStorage y reaparece en el POS normal — pasaría más seguido.)
- Sin caja abierta, ¿la venta flotante ofrece abrirla o el botón queda apagado?
- Desde dónde se abre: botón en compras, tecla, o las dos.

---

### Admin-POS responsive — para usar desde el celular

**Estado: sin implementar. Relevado el 2026-09-16 para que la sesión que lo
encare arranque informada, sin tener que redescubrir esto.**

El pedido: poder usar Admin-POS desde el teléfono. Hoy no se puede — no es que
se vea mal, es que **la navegación desaparece por completo** en una pantalla
angosta (ver primer punto).

**Lo que ya está, verificado:**

- El `<meta viewport>` ya está en los tres entry points (`index.html`,
  `admin-pos/index.html`, `views/login.html`) — no es lo que falta.

**Lo que hace que esto sea más que "agregar un par de media queries":**

1. **El sidebar desaparece sin reemplazo por debajo de 768px.** Ya existe un
   único `@media (max-width: 768px)` en `css/layout.css` (~línea 243) que hace
   `aside.sidebar { display: none; }` — pero no agrega ninguna navegación en su
   lugar (nada de hamburguesa, drawer, bottom nav). Confirmado por grep: no
   existe ningún "hamburger"/"toggle"/"mobile-nav" en toda la base. El sidebar
   es la ÚNICA navegación entre módulos que existe hoy — sin él, entrar desde
   un celular deja a cualquiera de las dos superficies sin forma de moverse
   entre pantallas. Esto es lo primero que hay que resolver, antes que
   cualquier otra cosa.
2. **El CSS es compartido entre POS y Admin-POS** (ver CLAUDE.md, sección "Las
   tres superficies") — los mismos 4 archivos, sin ninguna marca en el DOM que
   distinga una superficie de la otra para CSS (JS sí tiene
   `window.ADMIN_MODE`; CSS no tiene equivalente). Cualquier regla nueva en
   `css/layout.css`/`components.css` pega en POS también. Si se quiere
   responsive exclusivo de Admin-POS sin arriesgar el layout del POS real (una
   compu fija del local, sin necesidad obvia de ser mobile), conviene agregar
   algo como `document.body.classList.add('admin-pos')` en
   `admin-pos/index.html` — no existe ese gancho todavía.
3. **~22 módulos propios de Admin-POS en total** (ver `ADMIN_POS_MODULES` en
   `js/app.js`) — contexto general del patrón del código, no el alcance real
   (ver más abajo: son solo 5 áreas). De 28 vistas totales, 24 traen su propio
   `<style>` inline — no hay una convención centralizada de componentes.
   Conteo aproximado: al menos 20 usos de `min-width` fijo en px repartidos en
   esas vistas (celdas de tabla, inputs de modal) que van a desbordar en una
   pantalla angosta — esperable también en las 5 vistas que sí están en
   alcance (`productos.html`, `ordenes.html`, `cuenta_corriente_proveedores.html`,
   `informes.html`, `caja.html`).
4. **No hay convención de tabla ancha con scroll horizontal.** Algunas
   pantallas lo resuelven ad hoc (`overflow-x:auto` puntual, visto hoy en
   `compras_v2.js`), la mayoría probablemente no. Las pantallas de Admin-POS
   son data-dense por naturaleza (historiales, cuentas corrientes, informes) —
   esto va a aparecer en casi todas.
5. **No hay framework CSS** (Tailwind, Bootstrap, etc.) — todo vanilla con
   variables (`css/variables.css`) y `<style>` por vista. Cualquier solución
   tiene que jugar con ese mismo enfoque.

**Alcance real, definido por el usuario (16/9/2026) — NO son las 22 pantallas.**
Esto reemplaza el "sin decidir todavía" de la primera versión de esta entrada:
son 5 áreas puntuales, con prioridad marcada, y el resto de Admin-POS
(Clientes, Compras, Gastos, Usuarios, Configuración, Promociones, Etiquetas,
Ajustes de stock, Flujo, etc.) **queda explícitamente afuera** — no tocar esas
pantallas para esto salvo que el usuario lo pida aparte.

| Área | Qué necesita ver/hacer | Prioridad | Dónde vive hoy |
|---|---|---|---|
| **Productos** | Consultar: stock, precio, costo | Alta | `js/modules/productos.js` (la lista — NO `editor-producto.js`, ver [[project_editor_producto]] en memoria) |
| Productos | Ver sustitutos y familia | Media | Hoy son tabs dentro de `editor-producto.js` (`renderSustitutos`/`renderFamilia`, la página completa) — decidir si se reusa esa página responsive o se arma una vista de solo-consulta más liviana |
| **Órdenes de Compra** | Consultar OC generadas | Alta | `js/modules/ordenes.js` — lista + detalle de una orden |
| Órdenes de Compra | Generar una OC nueva | Media | `js/modules/ordenes.js` — flujo "Generar Orden" (`generarOrdenCompra`, modal `ord-btn-generar`) |
| **Proveedores** | Cargar pagos | Alta | `js/modules/cuenta_corriente_proveedores.js` + `pago_proveedor_wizard.js` (mismo wizard que ya usa el botón "Pago a proveedor" del dashboard Inicio del POS — ver `js/modules/inicio.js`) |
| Proveedores | Ver cuenta corriente | Alta | `js/modules/cuenta_corriente_proveedores.js` — `getLedger`/`getLedgerAgrupado`, la vista de detalle por proveedor |
| **Informes** | Solo "Ventas por Vendedor" — ningún otro reporte | Alta | `js/modules/informes.js`, `id: 'ventas_vendedor'` (reporte #5). El resto de los 8 reportes no hace falta en mobile |
| **Cajas** | KPI de saldo actual por caja/medio de pago | Alta | `js/modules/caja.js`, `renderOverview()` — el grid `.caja-overview-grid` ya usa `auto-fit`/`minmax`, es de los pocos lugares que ya reflowea razonablemente bien |

**El KPI de Cajas es en realidad un pedido más grande: un dashboard "Inicio"
propio para Admin-POS**, con saldo por caja + **Ticket promedio** + **Cantidad
de ventas** del día — el mismo espíritu que `js/modules/inicio.js` (dashboard
que ya existe, pero solo para POS; Admin-POS hoy arranca en `#productos` y no
tiene "Inicio" en el menú — confirmado por `test_inicio_dashboard.py`, que
además **assertea explícitamente que no lo tenga**, hay que actualizar ese
test si esto cambia el arranque de escritorio también). Los cálculos de
"ticket promedio" y "cantidad de ventas" no son nuevos: ya existen como
`num_ventas` y `total_neto/num_ventas` en el reporte "Ventas por Vendedor" y
en "Resumen Diario de Caja" (`js/modules/informes.js`) — es cuestión de
reempaquetarlos en un KPI para "hoy", no de inventar la cuenta.

**Decisión pendiente puntual sobre ese dashboard:** ¿arranca Admin-POS ahí
siempre (cambiando el comportamiento actual también en escritorio), o el
dashboard nuevo es *solo* la landing mobile (por debajo de cierto ancho),
dejando el arranque en `#productos` intacto en desktop? Ver el test citado
arriba antes de decidir — hoy garantiza lo segundo.

**Sobre las decisiones técnicas ya no abiertas (siguen valiendo del
relevamiento original):** el problema de navegación (sidebar sin reemplazo) y
el CSS compartido sin marca que distinga Admin-POS del POS siguen siendo
los primeros dos obstáculos a resolver, ahora acotados a estas 5 áreas en vez
de las 22.

---

*Agregar acá lo que se sepa pendiente — no hace falta esperar a que esté "bien redactado", una línea alcanza.*
