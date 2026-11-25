/**
 * impresion.js — Motor de impresión (ticket de venta + etiquetas) y su configuración.
 *
 * POR QUÉ EXISTE (23/11/2026): el botón "Imprimir ticket" del POS hacía window.print() sobre la
 * PANTALLA ENTERA: no había ninguna regla de impresión para el POS, así que salían el menú, el modal
 * y los botones "Confirmar y finalizar / Imprimir / Iniciar nueva venta" junto con el ticket.
 *
 * Ahora el ticket es un documento aislado (solo el ticket) que se imprime desde un iframe oculto
 * (srcdoc: mismo origen, no necesita red, el Service Worker no se interpone). `@page` fija el ancho
 * del rollo y deja el alto en `auto`: el largo del ticket lo decide el contenido.
 *
 * CONFIGURACIÓN POR EQUIPO, NO SINCRONIZADA (excepción deliberada al criterio "todo sincroniza"):
 * la impresora está conectada a UNA compu. Si el ticket de 58 mm del POS del local viajara al
 * Admin-POS, pisaría la config de otra impresora. Vive en localStorage de este navegador.
 *
 * Se expone también como window.SGA_Impresion (los tests la usan para espiar el HTML a imprimir).
 */

const LS_KEY = 'sga_print_config';

// ── Valores por defecto ───────────────────────────────────────────────────────
const DEFAULTS = {
  ticket: {
    anchoPapel: 58,      // mm — ancho NOMINAL del rollo (lo que dice la caja)
    anchoUtil: 48,       // mm — ancho que la impresora realmente imprime (en un rollo de 58 suele ser ~48)
    fuentePx: 12,        // tamaño de letra base
    copias: 1,
    mostrarDireccion: true,
    mostrarVendedor: true,
    mostrarCliente: true,
    encabezado: '',      // línea extra bajo el nombre de la sucursal (ej. CUIT, teléfono)
    pie: '¡Gracias por su compra!',
  },
  etiquetas: {
    preset: 'a4_3x10',
    modo: 'hoja',        // 'hoja' (varias por hoja) | 'rollo' (una por página, rollo de etiquetas)
    papel: 'A4',         // 'A4' | 'Carta' (solo modo hoja)
    columnas: 3,
    ancho: 70,           // mm, de CADA etiqueta
    alto: 29.7,          // mm, de CADA etiqueta
    margenSup: 0,        // mm (solo modo hoja)
    margenIzq: 0,
    gapX: 0,             // separación entre etiquetas (solo modo hoja)
    gapY: 0,
  },
  // Etiquetas de PROMOCION (Informes -> Bajas de Precio): tamaño propio, algo mas grande.
  etiquetasPromo: {
    preset: 'a4_3x8',
    modo: 'hoja',
    papel: 'A4',
    columnas: 3,
    ancho: 70,
    alto: 37.1,
    margenSup: 0,
    margenIzq: 0,
    gapX: 0,
    gapY: 0,
  },
};

// Los presets son divisiones PAREJAS de la hoja (no modelos comerciales con nombre: no se puede
// asegurar el medido exacto de cada marca — para eso está "Personalizado").
const PRESETS_ETIQUETA = {
  a4_3x10:  { label: 'Hoja A4 · 3 × 10 (70 × 29,7 mm) — el de siempre', modo: 'hoja', papel: 'A4', columnas: 3, ancho: 70,   alto: 29.7 },
  a4_3x8:   { label: 'Hoja A4 · 3 × 8 (70 × 37,1 mm)',                  modo: 'hoja', papel: 'A4', columnas: 3, ancho: 70,   alto: 37.1 },
  a4_4x12:  { label: 'Hoja A4 · 4 × 12 (52,5 × 24,7 mm)',               modo: 'hoja', papel: 'A4', columnas: 4, ancho: 52.5, alto: 24.7 },
  a4_2x7:   { label: 'Hoja A4 · 2 × 7 (105 × 42,4 mm)',                 modo: 'hoja', papel: 'A4', columnas: 2, ancho: 105,  alto: 42.4 },
  a4_2x5:   { label: 'Hoja A4 · 2 × 5 (105 × 59,4 mm)',                 modo: 'hoja', papel: 'A4', columnas: 2, ancho: 105,  alto: 59.4 },
  rollo_50x30: { label: 'Rollo de etiquetas · 50 × 30 mm',              modo: 'rollo', columnas: 1, ancho: 50, alto: 30 },
  rollo_40x25: { label: 'Rollo de etiquetas · 40 × 25 mm',              modo: 'rollo', columnas: 1, ancho: 40, alto: 25 },
  rollo_60x40: { label: 'Rollo de etiquetas · 60 × 40 mm',              modo: 'rollo', columnas: 1, ancho: 60, alto: 40 },
  custom:   { label: 'Personalizado', modo: null },
};

const PAPELES = { A4: { w: 210, h: 297 }, Carta: { w: 215.9, h: 279.4 } };

// ── Utilidades ────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (v, def, min, max) => {
  const n = parseFloat(String(v).replace(',', '.'));
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

const bool = (v, def) => (v === undefined || v === null) ? def : !!v;

// Emojis y símbolos: una térmica con driver de texto suele imprimir un cuadrado en su lugar.
const sinEmoji = (s) => String(s == null ? '' : s)
  .replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/\s{2,}/g, ' ').trim();

const money = (n) => window.SGA_Utils.formatCurrency(n);

// ── Configuración (localStorage) ──────────────────────────────────────────────
function normalizarEtiquetas(raw, def) {
  const e = Object.assign({}, def, raw || {});
  const modo = e.modo === 'rollo' ? 'rollo' : 'hoja';
  return {
    preset: PRESETS_ETIQUETA[e.preset] ? e.preset : 'custom',
    modo,
    papel: PAPELES[e.papel] ? e.papel : 'A4',
    columnas: modo === 'rollo' ? 1 : Math.round(num(e.columnas, def.columnas, 1, 8)),
    ancho: num(e.ancho, def.ancho, 15, 210),
    alto: num(e.alto, def.alto, 10, 297),
    margenSup: num(e.margenSup, 0, 0, 60),
    margenIzq: num(e.margenIzq, 0, 0, 60),
    gapX: num(e.gapX, 0, 0, 20),
    gapY: num(e.gapY, 0, 0, 20),
  };
}

function normalizar(raw) {
  const t = Object.assign({}, DEFAULTS.ticket, raw?.ticket || {});

  const anchoPapel = num(t.anchoPapel, 58, 40, 120);
  const ticket = {
    anchoPapel,
    anchoUtil: num(t.anchoUtil, 48, 30, anchoPapel),
    fuentePx: num(t.fuentePx, 12, 8, 20),
    copias: Math.round(num(t.copias, 1, 1, 5)),
    mostrarDireccion: bool(t.mostrarDireccion, true),
    mostrarVendedor: bool(t.mostrarVendedor, true),
    mostrarCliente: bool(t.mostrarCliente, true),
    encabezado: String(t.encabezado || '').slice(0, 120),
    pie: String(t.pie == null ? DEFAULTS.ticket.pie : t.pie).slice(0, 160),
  };

  const etiquetas = normalizarEtiquetas(raw?.etiquetas, DEFAULTS.etiquetas);
  const etiquetasPromo = normalizarEtiquetas(raw?.etiquetasPromo, DEFAULTS.etiquetasPromo);
  return { ticket, etiquetas, etiquetasPromo };
}

function getConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    return normalizar(raw || {});
  } catch (e) { return normalizar({}); }
}

function saveConfig(cfg) {
  const n = normalizar(cfg);
  localStorage.setItem(LS_KEY, JSON.stringify(n));
  return n;
}

function resetConfig() {
  localStorage.removeItem(LS_KEY);
  return getConfig();
}

// ── Ticket de venta ───────────────────────────────────────────────────────────
function nombreMedio(id) {
  try {
    const r = window.SGA_DB.query(`SELECT nombre FROM medios_cobro WHERE id = ?`, [id])[0];
    if (r?.nombre) return sinEmoji(r.nombre);
  } catch (e) { /* sin tabla: se muestra el id */ }
  return sinEmoji(id);
}

/**
 * Cuerpo del ticket (sin <html>): lo comparten el documento a imprimir y la vista previa de la
 * pantalla de configuración. `d` es el mismo objeto `ticketData` que arma pos.js.
 */
function buildTicketBody(d, cfg) {
  const t = (cfg || getConfig()).ticket;
  const suc = d.sucursal || {};
  const fecha = d.fecha ? new Date(d.fecha) : new Date();
  const fila = (a, b, cls = '') => `<div class="row ${cls}"><span>${a}</span><span class="r">${b}</span></div>`;

  const items = (d.items || []).map(i => {
    const sub = i.cantidad * i.precioUnitario - (i.descuentoItem || 0);
    return `<div class="it">
      <div class="it-n">${esc(i.nombre)}</div>
      ${fila(`${esc(i.cantidad)} × ${money(i.precioUnitario)}`, money(sub), 'it-row')}
    </div>`;
  }).join('');

  const pagos = (d.pagos || []).map(p => fila(esc(nombreMedio(p.medio)), money(p.monto))).join('');

  return `
    <div class="c"><strong class="big">${esc(suc.nombre || 'Sistema Kalulu')}</strong>
      ${t.mostrarDireccion && suc.direccion ? `<br>${esc(suc.direccion)}` : ''}
      ${t.encabezado ? `<br>${esc(t.encabezado)}` : ''}</div>
    <hr>
    <div>${esc(fecha.toLocaleString('es-AR'))}
      ${t.mostrarVendedor && d.usuario?.nombre ? `<br>Vendedor: ${esc(d.usuario.nombre)}` : ''}
      ${t.mostrarCliente && d.cliente?.nombre ? `<br>Cliente: ${esc(d.cliente.nombre)}` : ''}</div>
    <hr>
    ${items}
    <hr>
    ${fila('Subtotal', money(d.subtotal))}
    ${d.descuentoTotal > 0 ? fila('Descuento', '-' + money(d.descuentoTotal)) : ''}
    ${fila('TOTAL', money(d.total), 'grand')}
    <hr>
    ${pagos}
    ${d.deudaCobrada > 0.005 ? fila('Cobranza de deuda anterior', money(d.deudaCobrada)) : ''}
    ${d.vueltoAFavor > 0.005 ? fila('Vuelto dejado a favor', money(d.vueltoAFavor)) : ''}
    ${t.pie ? `<hr><div class="c">${esc(t.pie)}</div>` : ''}`;
}

function ticketCSS(t) {
  return `
@page { size: ${t.anchoPapel}mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: ${t.anchoUtil}mm; margin: 0 auto; padding: 2mm 0 6mm; color: #000;
  font-family: 'Courier New', Courier, monospace; font-size: ${t.fuentePx}px; line-height: 1.3; }
.c { text-align: center; }
.big { font-size: ${Math.round(t.fuentePx * 1.25)}px; }
hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
.row { display: flex; justify-content: space-between; gap: 6px; }
.row .r { text-align: right; white-space: nowrap; margin-left: auto; }
/* Linea de item: si 'cant x precio' + subtotal no entran en el ancho, el subtotal baja solo a la
   linea de abajo (alineado a la derecha) en vez de partir el texto a la mitad. */
.row.it-row { flex-wrap: wrap; }
.row.it-row span:first-child { white-space: nowrap; }
.grand { font-size: ${Math.round(t.fuentePx * 1.2)}px; font-weight: 700; }
.it { margin: 3px 0; }
.it-n { word-break: break-word; }
.copia { page-break-after: always; break-after: page; }
.copia:last-child { page-break-after: auto; break-after: auto; }
`;
}

function buildTicketHTML(d, cfg) {
  const c = cfg || getConfig();
  const body = buildTicketBody(d, c);
  const copias = Array.from({ length: c.ticket.copias }, () => `<div class="copia">${body}</div>`).join('');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Ticket</title>
<style>${ticketCSS(c.ticket)}</style></head><body>${copias}</body></html>`;
}

// Ticket de calibración: marca el ancho útil con bordes y una regla, para ver al toque si algo
// queda cortado (el "58 mm" de la caja casi nunca es el ancho que realmente imprime la térmica).
function buildTicketPruebaHTML(cfg) {
  const c = cfg || getConfig();
  const t = c.ticket;
  const reglas = Array.from({ length: Math.floor(t.anchoUtil / 10) + 1 }, (_, i) => `<span>${i * 10}</span>`).join('');
  const demo = buildTicketBody({
    fecha: new Date().toISOString(),
    sucursal: { nombre: 'TICKET DE PRUEBA', direccion: 'Calle Falsa 123' },
    usuario: { nombre: 'Prueba' },
    items: [
      { nombre: 'Producto con un nombre bastante largo para probar el corte de línea', cantidad: 2, precioUnitario: 1500, descuentoItem: 0 },
      { nombre: 'Producto corto', cantidad: 1, precioUnitario: 12345.5, descuentoItem: 0 },
    ],
    subtotal: 15345.5, descuentoTotal: 0, total: 15345.5,
    pagos: [{ medio: 'efectivo', monto: 15345.5 }],
  }, c);
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Ticket de prueba</title>
<style>${ticketCSS(t)}
.marco { border: 1px solid #000; }
.regla { display: flex; justify-content: space-between; font-size: 9px; border-bottom: 1px solid #000; }
</style></head><body><div class="marco">
<div class="regla">${reglas}</div>
<div class="c" style="font-size:10px">|← ${t.anchoUtil} mm de ancho útil →|<br>Papel configurado: ${t.anchoPapel} mm</div>
${demo}
</div></body></html>`;
}

// ── Imprimir un documento HTML aislado (iframe oculto) ────────────────────────
function imprimirHTML(html) {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    let listo = false;
    const limpiar = () => { try { f.remove(); } catch (e) { /* ya no está */ } resolve(); };
    f.onload = () => {
      if (listo) return; listo = true;
      // Un respiro para que el motor termine el layout (y cargue imágenes, si las hubiera).
      setTimeout(() => {
        try {
          f.contentWindow.addEventListener('afterprint', () => setTimeout(limpiar, 200));
          f.contentWindow.focus();
          f.contentWindow.print();
        } catch (e) { console.warn('imprimirHTML:', e.message); limpiar(); return; }
        setTimeout(limpiar, 60_000); // por si afterprint nunca dispara
      }, 150);
    };
    f.srcdoc = html;
    document.body.appendChild(f);
  });
}

// ── API pública (siempre se llama vía `api.` para que un test pueda reemplazar imprimirHTML) ──
const api = {
  DEFAULTS, PRESETS_ETIQUETA, PAPELES,
  getConfig, saveConfig, resetConfig, normalizar,
  buildTicketBody, buildTicketHTML, buildTicketPruebaHTML, ticketCSS,
  imprimirHTML,
  imprimirTicket(ticketData) { return api.imprimirHTML(api.buildTicketHTML(ticketData)); },
  imprimirTicketPrueba() { return api.imprimirHTML(api.buildTicketPruebaHTML()); },
  etiquetaGeometria, etiquetaCSS, etiquetaPromoCSS, validarEtiquetas,
  buildEtiquetasPruebaHTML,
  // Abre la hoja de prueba en una pestaña (igual que Etiquetas; el clic del usuario evita el bloqueo de popups).
  imprimirEtiquetasPrueba() {
    const html = api.buildEtiquetasPruebaHTML();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const win = window.open(url, '_blank');
    if (!win) alert('El navegador bloqueó la ventana emergente. Permití los popups para esta página e intentá de nuevo.');
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  },
};

// ── Etiquetas: geometría y CSS según la configuración ─────────────────────────
// A los valores por defecto (A4 3×10 de 70 × 29,7 mm) el CSS es el mismo de siempre: lo que cambia
// con otro tamaño es la escala `k` de lo que va ADENTRO de la etiqueta (letras, logo, código).
function etiquetaGeometria(e) {
  const k = Math.min(2.2, Math.max(0.45, Math.min(e.ancho / 70, e.alto / 29.7)));
  const r = (v) => Math.round(v * 100) / 100;
  const papel = PAPELES[e.papel] || PAPELES.A4;
  return {
    k,
    papel,
    nombre: r(9.5 * k), precio: r(11 * k), bcFont: Math.max(5, r(8 * k)),
    topPad: `${r(2 * k)}mm ${r(3 * k)}mm ${r(0.5 * k)}mm ${r(3 * k)}mm`,
    bottomH: r(14.5 * k), bottomPad: `0 ${r(2 * k)}mm ${r(1.5 * k)}mm ${r(2 * k)}mm`, gap: r(1.5 * k),
    logo: r(10 * k), bcW: r(Math.min(30 * k, e.ancho * 0.46)), bcMaxH: r(12 * k),
  };
}

// Devuelve { avisos: [], porHoja: n } — avisos que la pantalla de configuración muestra en rojo.
function validarEtiquetas(e) {
  const avisos = [];
  let porHoja = 1;
  if (e.modo === 'hoja') {
    const p = PAPELES[e.papel] || PAPELES.A4;
    const usadoX = e.margenIzq + e.columnas * e.ancho + (e.columnas - 1) * e.gapX;
    if (usadoX > p.w + 0.1) avisos.push(`Las ${e.columnas} columnas de ${e.ancho} mm (más márgenes y separación) suman ${Math.round(usadoX * 10) / 10} mm y la hoja ${e.papel} mide ${p.w} mm de ancho: la última columna se cortaría.`);
    const filas = Math.floor((p.h - e.margenSup + e.gapY + 0.01) / (e.alto + e.gapY));
    if (filas < 1) avisos.push('La etiqueta es más alta que la hoja.');
    porHoja = Math.max(0, filas) * e.columnas;
  }
  return { avisos, porHoja };
}

// Hoja de prueba: una hoja llena de etiquetas de ejemplo numeradas (o 3 en modo rollo), con la
// MISMA geometría que la impresión real, para ver si cae bien sobre el papel de esta impresora.
// No pasa por Etiquetas._print: no marca ningún producto como impreso.
const JSBARCODE_CDN = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';

function buildEtiquetasPruebaHTML(cfg) {
  const e = (cfg || getConfig()).etiquetas;
  const g = etiquetaGeometria(e);
  const n = e.modo === 'rollo' ? 3 : Math.min(60, Math.max(1, validarEtiquetas(e).porHoja || e.columnas));
  const labels = Array.from({ length: n }, (_, i) => `
  <div class="etiq">
    <div class="etiq-top"><div class="etiq-nombre">Etiqueta de prueba N° ${i + 1} — ${e.ancho} × ${e.alto} mm</div></div>
    <div class="etiq-bottom">
      <div class="etiq-logo" style="border:0.3pt dashed #888"></div>
      <div class="etiq-precio">$ 1.234,00</div>
      <div class="etiq-barcode"><svg class="bc-svg" data-code="7791234567895"></svg></div>
    </div>
  </div>`).join('\n');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Prueba de etiquetas</title>
<script src="${JSBARCODE_CDN}"><` + `/script>
<style>${etiquetaCSS(e)}</style></head><body><div class="grid">${labels}</div>
<script>
(function() {
  document.querySelectorAll('.bc-svg').forEach(function(svg) {
    try {
      JsBarcode(svg, svg.dataset.code, { width: 1.3, height: 36, displayValue: true, fontSize: 8, margin: 3, textMargin: 0,
        background: '#ffffff', lineColor: '#000000' });
      svg.style.cssText = 'display:block;width:${g.bcW}mm;height:auto;max-height:${g.bcMaxH}mm';
    } catch (err) { /* sin internet: queda sin barras, el resto de la prueba sirve igual */ }
  });
  setTimeout(function() { window.print(); }, 400);
})();
<` + `/script></body></html>`;
}

function etiquetaCSS(e) {
  const g = etiquetaGeometria(e);
  const rollo = e.modo === 'rollo';
  const pageSize = rollo ? `${e.ancho}mm ${e.alto}mm` : `${e.papel === 'Carta' ? 'Letter' : 'A4'} portrait`;
  const docW = rollo ? e.ancho : g.papel.w;
  const grid = rollo
    ? `.grid { width: ${e.ancho}mm; display: block; }`
    : `.grid { width: ${docW}mm; display: grid;
  grid-template-columns: repeat(${e.columnas}, ${e.ancho}mm);
  grid-auto-rows: ${e.alto}mm;
  column-gap: ${e.gapX}mm; row-gap: ${e.gapY}mm;
  padding: ${e.margenSup}mm 0 0 ${e.margenIzq}mm; }`;
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
@page { size: ${pageSize}; margin: 0; }
html, body {
  width: ${docW}mm;
  font-family: Arial, Helvetica, sans-serif;
  background: white;
}
${grid}
/* ── Label shell ── */
.etiq {
  width: ${e.ancho}mm;
  height: ${e.alto}mm;
  border: ${rollo ? 'none' : '0.3pt solid #aaa'};
  display: flex;
  flex-direction: column;
  overflow: hidden;
  break-inside: avoid;
  ${rollo ? 'break-after: page; page-break-after: always;' : ''}
}
${rollo ? '.etiq:last-child { break-after: auto; page-break-after: auto; }' : ''}
/* ── Top: product name ── */
.etiq-top {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${g.topPad};
  overflow: hidden;
}
.etiq-nombre {
  font-size: ${g.nombre}pt;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
  word-wrap: break-word;
  overflow-wrap: break-word;
  hyphens: auto;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  width: 100%;
}
/* ── Bottom row: logo | price | barcode ── */
.etiq-bottom {
  height: ${g.bottomH}mm;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: ${g.bottomPad};
  gap: ${g.gap}mm;
}
.etiq-logo {
  width: ${g.logo}mm;
  height: ${g.logo}mm;
  flex-shrink: 0;
}
.etiq-precio {
  flex: 1;
  font-size: ${g.precio}pt;
  font-weight: 900;
  text-align: center;
  white-space: nowrap;
  letter-spacing: -0.3pt;
}
/* Barcode area — horizontal, no rotation */
.etiq-barcode {
  width: ${g.bcW}mm;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.bc-svg {
  display: block;
  width: ${g.bcW}mm;   /* forces SVG to scale to this width */
  height: auto;  /* aspect ratio preserved via viewBox */
  max-height: ${g.bcMaxH}mm;
}
`;
}

// Formato PROMOCION (se agrega DESPUES de etiquetaCSS). Blanco y negro, alto contraste; los fondos
// negros necesitan print-color-adjust: exact o Chrome no los imprime. Escala con la misma `k`.
function etiquetaPromoCSS(e) {
  // Escala propia, con base en la etiqueta de promo estandar (70 x 37,1 mm): el precio es lo que
  // tiene que verse desde lejos. El codigo de barras escala con el ANCHO (angosto, cuesta leerlo).
  const kw = e.ancho / 70;
  const k = Math.min(2.2, Math.max(0.5, Math.min(kw, e.alto / 37.1)));
  const r = (v) => Math.round(v * k * 100) / 100;
  const bcW = Math.round(Math.min(30 * kw, e.ancho * 0.46) * 100) / 100;
  return `
.etiq-promo { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.promo-banda { flex-shrink: 0; display: flex; justify-content: space-between; align-items: center;
  background: #000; color: #fff; padding: ${r(0.6)}mm ${r(2.5)}mm; font-size: ${r(12)}pt; font-weight: 900;
  letter-spacing: ${r(1.2)}pt; line-height: 1.15; }
.promo-pct { background: #fff; color: #000; letter-spacing: 0; padding: 0 ${r(1.5)}mm; border-radius: ${r(0.8)}mm; }
.promo-nombre-wrap { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
  padding: ${r(0.3)}mm ${r(2)}mm; overflow: hidden; }
.promo-nombre { width: 100%; text-align: center; font-weight: 700; font-size: ${r(9)}pt; line-height: 1.12;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.promo-ahora { flex-shrink: 0; text-align: center; white-space: nowrap; font-size: ${r(32)}pt; font-weight: 900;
  letter-spacing: -1pt; line-height: 1.06; }
.promo-ahora.largo { font-size: ${r(25)}pt; }
.promo-pie { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: ${r(1)}mm;
  height: ${r(9.5)}mm; padding: 0 ${r(2)}mm ${r(0.8)}mm; }
.promo-antes { flex: 1; min-width: 0; text-align: center; white-space: nowrap; font-size: ${r(10)}pt; }
.promo-antes s { text-decoration-thickness: ${r(0.35)}mm; }
.etiq-promo .etiq-barcode { width: ${bcW}mm; }
.etiq-promo .bc-svg { width: ${bcW}mm !important; max-height: ${r(8.7)}mm !important; }
`;
}

window.SGA_Impresion = api;
export default api;
