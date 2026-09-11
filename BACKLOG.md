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

---

*Agregar acá lo que se sepa pendiente — no hace falta esperar a que esté "bien redactado", una línea alcanza.*
