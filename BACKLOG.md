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

**Estado al 16/9/2026: las 5 áreas del alcance original están hechas** (en
`dev`; navegación/Productos/Inicio ya en `main`, falta pasar Órdenes/
Proveedores/Informes). Quedan afuera a propósito dos sub-ítems de
prioridad media que nunca estuvieron en el alcance alto: generar una OC
nueva y ver sustitutos/familia de un producto — ambos siguen siendo cosa
de la compu.

**Ya hecho:**
- **Navegación**: barra inferior fija para Admin-POS en `<768px` (Inicio /
  Productos / Órdenes / Proveedores / Informes), gateada con
  `body.admin-pos` — ver nota nueva en CLAUDE.md, sección "Las tres
  superficies". El POS del local sigue con hamburguesa + drawer (mismo CSS
  compartido, sin gate — el usuario pidió explícitamente no aislar el CSS
  más de lo necesario).
- **Productos**: lista pasa a cards en mobile (Nombre/Stock/Costo/Precio,
  badge "Bajo mín."), toolbar sin Descargar Plantilla/Importar
  Excel/Nuevo Producto/Bajo Mínimo (`views/productos.html`,
  `js/modules/productos.js`). Tocar la card abre el editor (ya funcionaba
  así, sin cambios).
- **Inicio**: dashboard nuevo para Admin-POS (`js/modules/inicio.js`,
  branch por `window.ADMIN_MODE`) — saldo por caja/medio, ventas de hoy,
  ticket promedio. Sin "Nueva venta" entre los accesos rápidos (no aplica
  remoto). Admin-POS sigue arrancando en `#productos` en escritorio —
  Inicio es alcanzable (agregado a `ADMIN_POS_MODULES`), no el arranque por
  defecto. `test_inicio_dashboard.py` actualizado.
- **Órdenes de Compra**: lista a cards; detalle de una orden ya generada
  pasa a solo-lectura simplificado (Producto + Stock actual + A pedir, sin
  las columnas de análisis para armar el pedido). Stock actual muestra la
  suma del grupo de sustitutos completo (`stockEfectivo()`, ya existente),
  no el producto individual — pedido explícito del usuario, verificado con
  un grupo de 2 productos. "+ Generar orden" oculto en mobile.
- **Proveedores / Cuenta Corriente**: lista a cards con saldo + botón
  "Pagar" directo. El extracto usa "Agrupado" (por factura, preferencia
  del usuario sobre "Cronológico") con la sección de pagos sin imputar y
  su botón "Imputar…" incluida. El wizard de pago no necesitó cambios —
  ya funcionaba bien en mobile.
- **Informes**: sin el selector de 9 reportes ni fechas sueltas — directo
  a "Ventas por Vendedor" con chips Hoy/Esta semana/Este mes + "Elegir
  mes" (mes completo, no rango libre). Reusa `queryVentasVendedor()` tal
  cual.
- De yapa: se encontró y arregló un bug real de login en dispositivo nuevo
  — `views/login.html` siempre abría `sga.db` (la del POS) sin importar
  `returnTo`, así que nadie podía entrar a Admin-POS con su contraseña real
  desde un dispositivo que nunca había entrado antes (solo con el admin por
  defecto). Ver la nota en CLAUDE.md, sección Firebase.

**Pendiente (prioridad media, fuera del alcance alto original):** generar
una OC nueva desde el celular, y ver sustitutos/familia de un producto
desde el celular — ver tabla de alcance más abajo.

---

El pedido original: poder usar Admin-POS desde el teléfono. Al empezar, no
se podía — no era que se viera mal, era que **la navegación desaparecía por
completo** en una pantalla angosta (ver primer punto, ya resuelto arriba).

**Lo que ya está, verificado:**

- El `<meta viewport>` ya está en los tres entry points (`index.html`,
  `admin-pos/index.html`, `views/login.html`) — no es lo que falta.

**Lo que hace que esto sea más que "agregar un par de media queries":**

1. ~~**El sidebar desaparece sin reemplazo por debajo de 768px.**~~ **✅
   Resuelto.** Antes había un único `@media (max-width: 768px)` en
   `css/layout.css` que hacía `aside.sidebar { display: none; }` sin agregar
   ninguna navegación en su lugar. Ahora: hamburguesa + drawer para el POS
   (`.nav-toggle-btn`, `aside.sidebar.mobile-open`), barra inferior fija
   para Admin-POS (`.admin-tabbar`, gateada con `body.admin-pos`).
2. ~~**El CSS es compartido entre POS y Admin-POS sin marca en el DOM.**~~
   **✅ Resuelto** (parcialmente — el gancho existe, no se usó para aislar
   *todo*). `js/app.js` agrega `body.classList.add('admin-pos')` cuando
   `window.ADMIN_MODE` es true. La barra inferior lo usa para no
   imponérsela al POS; el resto de las reglas de "Admin-POS responsive"
   siguen siendo compartidas a propósito (pedido explícito del usuario:
   "si este trabajo hace que POS también empiece a ser responsive,
   bienvenido").
3. ~~**~22 módulos propios de Admin-POS en total** — 20 usos de `min-width`
   fijo repartidos en `productos.html`, `ordenes.html`,
   `cuenta_corriente_proveedores.html`, `informes.html`, `caja.html`.~~ **✅
   Resuelto para las 5 vistas en alcance** — cada una tiene su propio
   `@media (max-width:768px)` con `body.admin-pos` (`caja.html` ya
   refloweaba bien de entrada, no necesitó cambios). El resto de Admin-POS
   (17 módulos) sigue sin tocar, a propósito — fuera de alcance.
4. ~~**No hay convención de tabla ancha con scroll horizontal.**~~ **✅
   No hizo falta una convención general** — cada tabla en alcance se
   resolvió con su propio pasaje a cards (mismo patrón repetido: `thead`
   oculto, `tr` a `display:flex`/`block`, columnas reordenadas con
   `order`), no con scroll horizontal.
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
| **Productos** | Consultar: stock, precio, costo | ✅ Hecho | Cards en mobile, `views/productos.html` + `js/modules/productos.js` |
| Productos | Ver sustitutos y familia | Media — pendiente | Hoy son tabs dentro de `editor-producto.js` (`renderSustitutos`/`renderFamilia`, la página completa) — decidir si se reusa esa página responsive o se arma una vista de solo-consulta más liviana |
| **Órdenes de Compra** | Consultar OC generadas | ✅ Hecho | Cards en mobile, `js/modules/ordenes.js` + `views/ordenes.html` |
| Órdenes de Compra | Generar una OC nueva | Media — pendiente | `js/modules/ordenes.js` — flujo "Generar Orden" (`generarOrdenCompra`, modal `ord-btn-generar`). Sigue siendo cosa de la compu a propósito |
| **Proveedores** | Cargar pagos | ✅ Hecho | Botón "Pagar" en la card + wizard existente (`pago_proveedor_wizard.js`) sin cambios |
| Proveedores | Ver cuenta corriente | ✅ Hecho | Extracto agrupado por factura + pagos sin imputar, `js/modules/cuenta_corriente_proveedores.js` + `views/cuenta_corriente_proveedores.html` |
| **Informes** | Solo "Ventas por Vendedor" — ningún otro reporte | ✅ Hecho | `js/modules/informes.js`, chips de período + "Elegir mes" |
| **Cajas** | KPI de saldo actual por caja/medio de pago | ✅ Hecho | Terminó siendo parte del dashboard "Inicio" nuevo, ver abajo |

**El KPI de Cajas terminó siendo, como se preveía, parte de algo más
grande: un dashboard "Inicio" propio para Admin-POS** (`js/modules/inicio.js`,
`views/inicio.html`, branch por `window.ADMIN_MODE`) — saldo por caja/medio,
ventas de hoy y ticket promedio, reusando los cálculos que ya existían en
`caja.js` (`getSesionActiva`/`getTotalesSesion`) y la fórmula de "neto" de
`informes.js` (`ventas_vendedor`). Sin accesos rápidos que no aplican remoto
(“Nueva venta” se saca cuando `ADMIN_MODE`). "Inicio" ya está en
`ADMIN_POS_MODULES` (visible en el menú de escritorio también) pero Admin-POS
sigue arrancando en `#productos` — no se tocó el arranque por defecto,
solo se sumó el acceso. `test_inicio_dashboard.py` actualizado para cubrir
ambos sets de KPIs (POS vs Admin-POS) en vez de asumir que Admin-POS no
tiene Inicio.

---

*Agregar acá lo que se sepa pendiente — no hace falta esperar a que esté "bien redactado", una línea alcanza.*
