/**
 * config_impresion.js — Configuración de impresión (ticket de venta + etiquetas).
 *
 * Se guarda POR EQUIPO (localStorage), no se sincroniza: la impresora está conectada a una compu en
 * particular (ver el comentario de impresion.js). Disponible en POS y en Admin-POS.
 */
import Impresion from './impresion.js';
// Para la hoja de prueba de promocion: mismo armado de etiqueta que la impresion real.
import Etiquetas from './etiquetas.js';

const ConfigImpresion = (() => {
  'use strict';

  const ge = (id) => document.getElementById(id);
  const PRESETS = Impresion.PRESETS_ETIQUETA;

  // Datos de ejemplo para la vista previa del ticket (los mismos campos que arma pos.js).
  const EJEMPLO = {
    fecha: new Date().toISOString(),
    sucursal: { nombre: 'Kalulu', direccion: 'Calle Falsa 123' },
    usuario: { nombre: 'Cajera' },
    cliente: { nombre: 'Cliente de ejemplo' },
    items: [
      { nombre: 'Leche entera sachet 1 L', cantidad: 2, precioUnitario: 1800, descuentoItem: 0 },
      { nombre: 'Galletitas de agua con semillas 300 g', cantidad: 1, precioUnitario: 2450, descuentoItem: 0 },
    ],
    subtotal: 6050, descuentoTotal: 0, total: 6050,
    pagos: [{ medio: 'efectivo', monto: 6050 }],
  };

  // ── Form <-> config ────────────────────────────────────────────────────────
  function leerForm() {
    return {
      ticket: {
        anchoPapel: ge('ci-t-papel').value,
        anchoUtil: ge('ci-t-util').value,
        fuentePx: ge('ci-t-fuente').value,
        copias: ge('ci-t-copias').value,
        mostrarDireccion: ge('ci-t-dir').checked,
        mostrarVendedor: ge('ci-t-vend').checked,
        mostrarCliente: ge('ci-t-cli').checked,
        encabezado: ge('ci-t-enc').value,
        pie: ge('ci-t-pie').value,
      },
      etiquetas: {
        preset: ge('ci-e-preset').value,
        modo: ge('ci-e-modo').value,
        papel: ge('ci-e-papel').value,
        columnas: ge('ci-e-cols').value,
        ancho: ge('ci-e-ancho').value,
        alto: ge('ci-e-alto').value,
        margenSup: ge('ci-e-msup').value,
        margenIzq: ge('ci-e-mizq').value,
        gapX: ge('ci-e-gx').value,
        gapY: ge('ci-e-gy').value,
      },
      etiquetasPromo: leerPromo(),
    };
  }

  // El tamaño de promocion se elige entre los modelos (sin "Personalizado").
  function leerPromo() {
    const id = ge('ci-p-preset').value;
    if (!PRESETS[id] || id === 'custom') return Impresion.getConfig().etiquetasPromo;
    const p = PRESETS[id];
    return { preset: id, modo: p.modo, papel: p.papel || 'A4', columnas: p.columnas, ancho: p.ancho, alto: p.alto,
             margenSup: 0, margenIzq: 0, gapX: 0, gapY: 0 };
  }

  function refrescarPromo() {
    const e = Impresion.normalizar({ etiquetasPromo: leerPromo() }).etiquetasPromo;
    ge('ci-p-info').innerHTML = e.modo === 'hoja'
      ? `Entran <strong>${Impresion.validarEtiquetas(e).porHoja}</strong> etiquetas de promoción por hoja.`
      : `Se imprime una etiqueta de ${e.ancho} × ${e.alto} mm por vez.`;
  }

  function escribirForm(cfg) {
    const t = cfg.ticket, e = cfg.etiquetas;
    // El select de ancho solo ofrece 58/80; un valor distinto (config vieja) se agrega como opción.
    const sel = ge('ci-t-papel');
    if (![...sel.options].some(o => +o.value === t.anchoPapel)) {
      sel.add(new Option(`${t.anchoPapel} mm`, String(t.anchoPapel)));
    }
    sel.value = String(t.anchoPapel);
    ge('ci-t-util').value = t.anchoUtil;
    ge('ci-t-fuente').value = t.fuentePx;
    ge('ci-t-copias').value = t.copias;
    ge('ci-t-dir').checked = t.mostrarDireccion;
    ge('ci-t-vend').checked = t.mostrarVendedor;
    ge('ci-t-cli').checked = t.mostrarCliente;
    ge('ci-t-enc').value = t.encabezado;
    ge('ci-t-pie').value = t.pie;

    ge('ci-e-preset').value = e.preset;
    ge('ci-e-modo').value = e.modo;
    ge('ci-e-papel').value = e.papel;
    ge('ci-e-cols').value = e.columnas;
    ge('ci-e-ancho').value = e.ancho;
    ge('ci-e-alto').value = e.alto;
    ge('ci-e-msup').value = e.margenSup;
    ge('ci-e-mizq').value = e.margenIzq;
    ge('ci-e-gx').value = e.gapX;
    ge('ci-e-gy').value = e.gapY;
    ge('ci-p-preset').value = cfg.etiquetasPromo.preset;
    refrescarPromo();
  }

  // ── Etiquetas: qué campos aplican y cuáles son editables ─────────────────────
  function refrescarEtiquetas() {
    const preset = ge('ci-e-preset').value;
    const custom = preset === 'custom';

    // Un preset fija los valores; "Personalizado" los deja editar.
    if (!custom) {
      const p = PRESETS[preset];
      ge('ci-e-modo').value = p.modo;
      if (p.papel) ge('ci-e-papel').value = p.papel;
      ge('ci-e-cols').value = p.columnas;
      ge('ci-e-ancho').value = p.ancho;
      ge('ci-e-alto').value = p.alto;
      if (p.modo === 'hoja') { /* márgenes y separación quedan como estén */ }
    }
    const soloRollo = ge('ci-e-modo').value === 'rollo';
    ['ci-e-modo', 'ci-e-papel', 'ci-e-cols', 'ci-e-ancho', 'ci-e-alto', 'ci-e-msup', 'ci-e-mizq', 'ci-e-gx', 'ci-e-gy']
      .forEach(id => { ge(id).disabled = !custom && !['ci-e-msup', 'ci-e-mizq', 'ci-e-gx', 'ci-e-gy'].includes(id); });
    // Del papel de hoja solo aplican cuando NO es rollo.
    ['ci-e-g-papel', 'ci-e-g-cols', 'ci-e-g-msup', 'ci-e-g-mizq', 'ci-e-g-gx', 'ci-e-g-gy']
      .forEach(id => { ge(id).style.display = soloRollo ? 'none' : ''; });

    const cfg = Impresion.normalizar(leerForm());
    const v = Impresion.validarEtiquetas(cfg.etiquetas);
    const info = ge('ci-e-info');
    info.innerHTML = (cfg.etiquetas.modo === 'hoja'
      ? `<span style="color:var(--color-text-secondary)">Entran <strong>${v.porHoja}</strong> etiquetas por hoja.</span>`
      : `<span style="color:var(--color-text-secondary)">Se imprime una etiqueta de ${cfg.etiquetas.ancho} × ${cfg.etiquetas.alto} mm por vez.</span>`)
      + v.avisos.map(a => `<div style="color:var(--color-danger,#c62828);margin-top:4px;">⚠️ ${a}</div>`).join('');
  }

  // ── Ticket: vista previa en vivo ─────────────────────────────────────────────
  function refrescarPreview() {
    const cfg = Impresion.normalizar(leerForm());
    const f = ge('ci-t-preview');
    f.style.width = `${cfg.ticket.anchoUtil}mm`;
    f.onload = () => {
      try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 4) + 'px'; } catch (e) { /* mismo origen: no debería fallar */ }
    };
    f.srcdoc = Impresion.buildTicketHTML(EJEMPLO, cfg);
  }

  function mensaje(txt, ok = true) {
    const m = ge('ci-msg');
    m.textContent = txt;
    m.style.color = ok ? 'var(--color-success,#2e7d32)' : 'var(--color-danger,#c62828)';
    m.style.display = '';
    clearTimeout(mensaje._t);
    mensaje._t = setTimeout(() => { m.style.display = 'none'; }, 3500);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    const puede = user && (user.rol === 'admin' || window.SGA_Permisos?.can('can_config_impresion'));
    if (!puede) {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">No tenés permiso para configurar la impresión.</div>';
      return;
    }

    ge('ci-e-preset').innerHTML = Object.entries(PRESETS)
      .map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
    ge('ci-p-preset').innerHTML = Object.entries(PRESETS).filter(([id]) => id !== 'custom')
      .map(([id, p]) => `<option value="${id}">${p.label.replace(' — el de siempre', '')}</option>`).join('');
    escribirForm(Impresion.getConfig());
    refrescarEtiquetas();
    refrescarPreview();

    // Cambiar el rollo sugiere el ancho útil típico de ese rollo.
    ge('ci-t-papel').addEventListener('change', () => {
      ge('ci-t-util').value = +ge('ci-t-papel').value >= 80 ? 72 : 48;
      refrescarPreview();
    });
    ['ci-t-util', 'ci-t-fuente', 'ci-t-copias', 'ci-t-dir', 'ci-t-vend', 'ci-t-cli', 'ci-t-enc', 'ci-t-pie']
      .forEach(id => ge(id).addEventListener('input', refrescarPreview));

    ge('ci-e-preset').addEventListener('change', refrescarEtiquetas);
    ge('ci-p-preset').addEventListener('change', refrescarPromo);
    ge('ci-p-prueba').addEventListener('click', () => {
      const cfg = Impresion.normalizar(leerForm());
      const e = cfg.etiquetasPromo;
      const n = e.modo === 'rollo' ? 2 : Math.max(1, Impresion.validarEtiquetas(e).porHoja);
      const html = Etiquetas.construirHTML(Array.from({ length: n }, (_, i) => ({
        nombre: `Producto de prueba en promoción N° ${i + 1}`, precio: 1800, precioAnterior: 2200, codigo: '7791234567895',
      })), { formato: 'promo', cfg });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      if (!window.open(url, '_blank')) alert('El navegador bloqueó la ventana emergente. Permití los popups e intentá de nuevo.');
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    });
    ['ci-e-modo', 'ci-e-papel', 'ci-e-cols', 'ci-e-ancho', 'ci-e-alto', 'ci-e-msup', 'ci-e-mizq', 'ci-e-gx', 'ci-e-gy']
      .forEach(id => ge(id).addEventListener('input', refrescarEtiquetas));

    ge('ci-guardar').addEventListener('click', () => {
      const guardada = Impresion.saveConfig(leerForm());
      escribirForm(guardada);
      refrescarEtiquetas(); refrescarPreview();
      mensaje('✓ Configuración guardada en esta computadora');
    });
    ge('ci-reset').addEventListener('click', () => {
      if (!confirm('¿Volver a los valores originales de ticket y etiquetas en esta computadora?')) return;
      escribirForm(Impresion.resetConfig());
      refrescarEtiquetas(); refrescarPreview();
      mensaje('Valores originales restablecidos');
    });

    // Las pruebas imprimen lo que se ve en pantalla, aunque todavía no se haya guardado.
    ge('ci-t-prueba').addEventListener('click', () => {
      Impresion.imprimirHTML(Impresion.buildTicketPruebaHTML(Impresion.normalizar(leerForm())));
    });
    ge('ci-e-prueba').addEventListener('click', () => {
      const html = Impresion.buildEtiquetasPruebaHTML(Impresion.normalizar(leerForm()));
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      if (!window.open(url, '_blank')) alert('El navegador bloqueó la ventana emergente. Permití los popups e intentá de nuevo.');
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    });
  }

  return { init };
})();

export default ConfigImpresion;
