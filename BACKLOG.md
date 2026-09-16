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
3. **~22 módulos propios de Admin-POS** (ver `ADMIN_POS_MODULES` en
   `js/app.js`), cada uno con su vista en `views/*.html`. De 28 vistas totales,
   24 traen su propio `<style>` inline — no hay una convención centralizada de
   componentes. Conteo aproximado: al menos 20 usos de `min-width` fijo en px
   repartidos en esas vistas (celdas de tabla, inputs de modal) que van a
   desbordar en una pantalla angosta.
4. **No hay convención de tabla ancha con scroll horizontal.** Algunas
   pantallas lo resuelven ad hoc (`overflow-x:auto` puntual, visto hoy en
   `compras_v2.js`), la mayoría probablemente no. Las pantallas de Admin-POS
   son data-dense por naturaleza (historiales, cuentas corrientes, informes) —
   esto va a aparecer en casi todas.
5. **No hay framework CSS** (Tailwind, Bootstrap, etc.) — todo vanilla con
   variables (`css/variables.css`) y `<style>` por vista. Cualquier solución
   tiene que jugar con ese mismo enfoque.

**Sin decidir todavía — buenas preguntas para el usuario antes de tocar código:**

- ¿Todo Admin-POS responsive, o un subconjunto priorizado (consulta rápida:
  saldo de un cliente, aprobar un pago, mirar un informe) en vez de las 22
  pantallas completas con edición full?
- ¿Se anima a tocar `css/layout.css` sabiendo que afecta también al POS real,
  o prefiere aislar todo detrás de una marca exclusiva de admin-pos primero?
- ¿"Usable" alcanza (scrollea, se lee, funciona) o espera un rediseño visual
  mobile-first para las pantallas prioritarias?

---

*Agregar acá lo que se sepa pendiente — no hace falta esperar a que esté "bien redactado", una línea alcanza.*
