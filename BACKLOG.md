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

**Estado al 16/9/2026: navegación, Productos e Inicio ya hechos (en `dev`,
falta pasar a `main`). Quedan pendientes Órdenes, Proveedores/cuenta
corriente e Informes — alcanzables desde la barra inferior, pero esas
pantallas en sí todavía no tienen tratamiento responsive (tablas fijas,
sin scroll horizontal).**

**Ya hecho:**
- **Navegación**: barra inferior fija para Admin-POS en `<768px` (Inicio /
  Productos / Órdenes / Proveedores / Informes), gateada con
  `body.admin-pos` — ver nota nueva en CLAUDE.md, sección "Las tres
  superficies". El POS del local sigue con hamburguesa + drawer (mismo CSS
  compartido, sin gate — el usuario pidió explícitamente no aislar el CSS
  más de lo necesario).
- **Productos**: lista pasa a cards en mobile (Nombre/Stock/Costo/Precio,
  badge "Bajo mín."), toolbar sin Descargar Plantilla/Importar
  Excel/Nuevo Producto (`views/productos.html`, `js/modules/productos.js`).
  Tocar la card abre el editor (ya funcionaba así, sin cambios).
- **Inicio**: dashboard nuevo para Admin-POS (`js/modules/inicio.js`,
  branch por `window.ADMIN_MODE`) — saldo por caja/medio, ventas de hoy,
  ticket promedio. Sin "Nueva venta" entre los accesos rápidos (no aplica
  remoto). Admin-POS sigue arrancando en `#productos` en escritorio —
  Inicio es alcanzable (agregado a `ADMIN_POS_MODULES`), no el arranque por
  defecto. `test_inicio_dashboard.py` actualizado.
- De yapa: se encontró y arregló un bug real de login en dispositivo nuevo
  — `views/login.html` siempre abría `sga.db` (la del POS) sin importar
  `returnTo`, así que nadie podía entrar a Admin-POS con su contraseña real
  desde un dispositivo que nunca había entrado antes (solo con el admin por
  defecto). Ver la nota en CLAUDE.md, sección Firebase.

**Pendiente:** Órdenes de Compra, Proveedores (cuenta corriente + pagos) e
Informes (recortado a "Ventas por Vendedor") — ver tabla de alcance más
abajo. La navegación ya los apunta bien (`#ordenes`,
`#cuenta_corriente_proveedores`, `#informes`), pero esas pantallas siguen
con las tablas de escritorio sin adaptar.

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
| **Productos** | Consultar: stock, precio, costo | ✅ Hecho | Cards en mobile, `views/productos.html` + `js/modules/productos.js` |
| Productos | Ver sustitutos y familia | Media — pendiente | Hoy son tabs dentro de `editor-producto.js` (`renderSustitutos`/`renderFamilia`, la página completa) — decidir si se reusa esa página responsive o se arma una vista de solo-consulta más liviana |
| **Órdenes de Compra** | Consultar OC generadas | Alta — pendiente | `js/modules/ordenes.js` — lista + detalle de una orden. Alcanzable desde la barra inferior (`#ordenes`), la pantalla en sí no está adaptada todavía |
| Órdenes de Compra | Generar una OC nueva | Media — pendiente | `js/modules/ordenes.js` — flujo "Generar Orden" (`generarOrdenCompra`, modal `ord-btn-generar`) |
| **Proveedores** | Cargar pagos | Alta — pendiente | `js/modules/cuenta_corriente_proveedores.js` + `pago_proveedor_wizard.js` (mismo wizard que ya usa el botón "Pago a proveedor" del dashboard Inicio del POS — ver `js/modules/inicio.js`). Alcanzable desde la barra inferior (`#cuenta_corriente_proveedores`), pantalla sin adaptar |
| Proveedores | Ver cuenta corriente | Alta — pendiente | `js/modules/cuenta_corriente_proveedores.js` — `getLedger`/`getLedgerAgrupado`, la vista de detalle por proveedor |
| **Informes** | Solo "Ventas por Vendedor" — ningún otro reporte | Alta — pendiente | `js/modules/informes.js`, `id: 'ventas_vendedor'` (reporte #5). Alcanzable desde la barra inferior (`#informes`), pero hoy muestra el selector completo de 9 reportes + filtros de escritorio, no una vista recortada |
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
