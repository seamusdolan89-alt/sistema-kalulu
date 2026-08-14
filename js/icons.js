/**
 * icons.js — Set mínimo de íconos SVG de línea (estilo Feather/Lucide:
 * trazo currentColor, sin relleno, esquinas redondeadas) para reemplazar
 * los emoji del sistema operativo en la navegación principal.
 *
 * Alcance de esta primera pasada: sidebar (js/app.js → initNav) + logo de
 * marca en los headers (index.html, admin-pos/index.html, pos.html en modo
 * venta). El resto de los emoji sueltos dentro de cada módulo (botones de
 * Operaciones de Stock, encabezados de vista, etc.) queda para una
 * continuación — ver memoria project_ux_pass_ui_ux_pro_max.md.
 *
 * Uso: window.SGA_Icons.get('productos', { size: 18, class: 'nav-icon' })
 */
(function () {
  'use strict';

  // Solo el contenido interno de cada <svg> — el wrapper (viewBox, stroke,
  // etc.) es común a todos y se arma en get().
  const PATHS = {
    // Punto de Venta — credit-card
    pos: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
    // Productos — caja isométrica
    productos: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12v9"/><path d="M12 12l8-4.5"/><path d="M12 12L4 7.5"/>',
    // Clientes — dos personas
    clientes: '<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.3"/><path d="M15.2 14.3a4.7 4.7 0 0 1 4.3 4.7"/>',
    // Cajas (grupo) — billetera
    cajas: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/><circle cx="17" cy="14.5" r="1.1" fill="currentColor" stroke="none"/>',
    // Efectivo — billete
    efectivo: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><line x1="6" y1="9.2" x2="6" y2="9.21"/><line x1="18" y1="14.8" x2="18" y2="14.81"/>',
    // Mercado Pago / medios electrónicos — smartphone
    smartphone: '<rect x="6.5" y="2" width="11" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>',
    // Operaciones de Stock — capas/inventario (distinto de la caja de Productos)
    operaciones_stock: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    // Proveedores — edificio
    proveedores: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 21v-3h6v3"/><line x1="8" y1="7" x2="8" y2="7.01"/><line x1="12" y1="7" x2="12" y2="7.01"/><line x1="16" y1="7" x2="16" y2="7.01"/><line x1="8" y1="11" x2="8" y2="11.01"/><line x1="12" y1="11" x2="12" y2="11.01"/><line x1="16" y1="11" x2="16" y2="11.01"/><line x1="8" y1="15" x2="8" y2="15.01"/><line x1="16" y1="15" x2="16" y2="15.01"/>',
    // Promociones / Etiquetas — etiqueta
    tag: '<path d="M12.6 2.5H4.5a2 2 0 0 0-2 2v8.1a2 2 0 0 0 .6 1.4l9 9a2 2 0 0 0 2.8 0l7.6-7.6a2 2 0 0 0 0-2.8l-9-9a2 2 0 0 0-1.9-.1z"/><circle cx="7.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/>',
    // Informes — barras
    informes: '<path d="M4 20V11"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M3 20h18"/>',
    // Gastos Generales — recibo
    gastos: '<path d="M6 2.5h12v18l-3-2-3 2-3-2-3 2v-18z"/><line x1="9" y1="7.5" x2="15" y2="7.5"/><line x1="9" y1="11.5" x2="15" y2="11.5"/>',
    // Caja Seamus (personal admin) — maletín
    briefcase: '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="2" y1="13" x2="22" y2="13"/>',
    // Usuarios — una persona
    usuarios: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    // Flujo de Fondos — ondas
    flujo: '<path d="M2 7.5c1.4-1.4 2.9-1.4 4.3 0s2.9 1.4 4.3 0 2.9-1.4 4.3 0 2.9 1.4 4.3 0"/><path d="M2 13c1.4-1.4 2.9-1.4 4.3 0s2.9 1.4 4.3 0 2.9-1.4 4.3 0 2.9 1.4 4.3 0"/><path d="M2 18.5c1.4-1.4 2.9-1.4 4.3 0s2.9 1.4 4.3 0 2.9-1.4 4.3 0 2.9 1.4 4.3 0"/>',
    // Configuración — engranaje (trazado clásico Feather "settings")
    configuracion: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    // Logo de marca — local/vidriera
    store: '<path d="M3 9.5l1.2-5.5h15.6l1.2 5.5"/><path d="M3 9.5a2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.4 0"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6.5h5V20"/>',
  };

  function get(name, opts) {
    opts = opts || {};
    const inner = PATHS[name];
    if (!inner) return '';
    const size = opts.size || 18;
    const cls = opts.class ? ` ${opts.class}` : '';
    const sw = opts.strokeWidth || 1.8;
    return `<svg class="sga-icon${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
  }

  window.SGA_Icons = { get, PATHS };
})();
