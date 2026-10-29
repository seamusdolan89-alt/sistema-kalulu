'use strict';

/**
 * Peek de Productos — búsqueda rápida de stock/precio SIN abandonar la
 * pantalla actual.
 *
 * Pedido explícito del usuario (29/10/2026): a veces hace falta mirar un
 * producto puntual (¿cuánto stock queda?, ¿a qué precio está?) estando en el
 * medio de otra tarea (ej. armando etiquetas, cargando una compra) — hasta
 * ahora la única forma era navegar a Productos y perder lo que estaba
 * haciendo ahí (el router destruye el módulo anterior en cada navegación,
 * ver app.js loadView()).
 *
 * Se abre con Ctrl+K / Cmd+K o el botón flotante, desde CUALQUIER pantalla
 * (POS y Admin-POS), como un panel flotante por ENCIMA de la pantalla
 * actual — nunca navega, nunca toca #app, así que la pantalla de atrás
 * queda intacta. Es de solo lectura: para editar hay que ir a Productos.
 *
 * Precargado una sola vez en app.js (init(), después de checkAuth) si el
 * usuario tiene can_ver_productos — el botón flotante y el atajo no
 * aparecen para quien no puede ver productos. El CSS se inyecta desde este
 * mismo archivo (mismo patrón que familia.js) para no depender de qué
 * pantalla lo abrió.
 *
 * Expone window.SGA_PeekProductos.
 */

import Buscador from './buscador_productos.js';

const SGA_PeekProductos = (() => {

  const db  = () => window.SGA_DB;
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                   .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);
  const sucursalId = () => window.SGA_Auth?.getCurrentUser()?.sucursal_id || '1';
  const puedeVerCostos = () => !!(window.ADMIN_MODE || window.SGA_Permisos?.can('can_ver_costos'));

  // ── CSS ────────────────────────────────────────────────────────────────────
  const STYLE_ID = 'sga-peek-productos-css';
  const CSS = `
  .pkp-fab {
    position: fixed; right: 20px; bottom: 20px; z-index: 580;
    width: 48px; height: 48px; border-radius: 50%; border: none;
    background: linear-gradient(135deg, #1565c0, #1976d2); color: #fff;
    font-size: 20px; cursor: pointer; display: flex; align-items: center;
    justify-content: center; box-shadow: 0 3px 10px rgba(21,101,192,0.4);
  }
  .pkp-fab:hover { background: linear-gradient(135deg, #1976d2, #1e88e5); }
  .pkp-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    z-index: 650; display: flex; align-items: flex-start; justify-content: center;
    padding: 10vh 16px 16px;
  }
  .pkp-panel {
    background: #fff; border-radius: 10px; width: 100%; max-width: 480px;
    max-height: 70vh; display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 8px 30px rgba(0,0,0,0.3);
  }
  .pkp-search-row { display: flex; align-items: center; border-bottom: 1px solid #e8edf3; padding: 4px 6px; }
  .pkp-search-row input {
    flex: 1; border: none; outline: none; font-size: 15px; padding: 12px 8px;
  }
  .pkp-close-btn {
    border: none; background: none; color: #8090a0; font-size: 18px;
    cursor: pointer; padding: 6px 10px;
  }
  .pkp-close-btn:hover { color: #c62828; }
  .pkp-body { overflow-y: auto; flex: 1; }
  .pkp-hint { padding: 16px; color: #8090a0; font-size: 13px; text-align: center; }
  .pkp-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 10px; padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f2f5f8;
  }
  .pkp-row:hover, .pkp-row.pkp-row-hl { background: #f4f8ff; }
  .pkp-row-nombre { font-weight: 600; color: #1a2744; font-size: 14px; }
  .pkp-row-sub { font-size: 12px; color: #8090a0; margin-top: 2px; }
  .pkp-row-precio { font-weight: 700; color: #1a2744; white-space: nowrap; }
  .pkp-detalle { padding: 16px; }
  .pkp-detalle-back {
    border: none; background: none; color: #1976d2; font-size: 13px;
    cursor: pointer; padding: 0 0 12px; display: block;
  }
  .pkp-detalle-nombre { font-size: 17px; font-weight: 700; color: #1a2744; margin-bottom: 10px; }
  .pkp-detalle-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; font-size: 13px;
  }
  .pkp-detalle-label { color: #8090a0; }
  .pkp-detalle-val { font-weight: 700; color: #1a2744; margin-top: 2px; }
  .pkp-detalle-val.pkp-stock-cero { color: #c62828; }
  `;

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ── Estado ─────────────────────────────────────────────────────────────────
  let elOverlay = null;
  let elInput   = null;
  let elBody    = null;
  let kbNav     = null; // { reset } de Buscador.attachDropdownKeyboard
  let searchTimer = null;
  let isOpen = false;

  function sucFiltro() { return sucursalId(); }

  function buscar(q) {
    elBody.innerHTML = '';
    if (q.length < 2) {
      elBody.innerHTML = `<div class="pkp-hint">Escribí un nombre o escaneá un código.</div>`;
      kbNav?.reset();
      return;
    }
    const resultados = Buscador.porTexto(q, { sucursalId: sucFiltro(), limite: 15 });
    if (!resultados.length) {
      elBody.innerHTML = `<div class="pkp-hint">Sin resultados para "${esc(q)}".</div>`;
      kbNav?.reset();
      return;
    }
    elBody.innerHTML = resultados.map(p => {
      const stockTxt = (parseFloat(p.stock) || 0) <= 0
        ? '<span style="color:#c62828">Sin stock</span>'
        : `Stock: ${Number(p.stock).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
      return `
        <div class="pkp-row" data-id="${esc(p.id)}">
          <div style="min-width:0">
            <div class="pkp-row-nombre">${esc(p.nombre)}</div>
            <div class="pkp-row-sub">${p.codigo ? esc(p.codigo) + ' · ' : ''}${stockTxt}</div>
          </div>
          <div class="pkp-row-precio">${fmt$(p.precio_venta)}</div>
        </div>
      `;
    }).join('');
    elBody.querySelectorAll('.pkp-row').forEach(row => {
      row.addEventListener('click', () => mostrarDetalle(row.dataset.id));
    });
    kbNav?.reset();
  }

  function mostrarDetalle(productoId) {
    const row = db().query(`
      SELECT p.*, cat.nombre AS categoria, pr.razon_social AS proveedor,
        (SELECT codigo FROM codigos_barras WHERE producto_id = p.id AND es_principal = 1 LIMIT 1) AS codigo,
        COALESCE(s.cantidad, 0) AS stock
      FROM productos p
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      LEFT JOIN proveedores pr ON pr.id = p.proveedor_principal_id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      WHERE p.id = ?
    `, [sucFiltro(), productoId])[0];
    if (!row) return;

    const stockBajo = (parseFloat(row.stock) || 0) <= 0;
    const costoRow = puedeVerCostos() ? `
      <div>
        <div class="pkp-detalle-label">Costo</div>
        <div class="pkp-detalle-val">${fmt$(row.costo)}</div>
      </div>
    ` : '';

    elBody.innerHTML = `
      <div class="pkp-detalle">
        <button type="button" class="pkp-detalle-back" id="pkp-btn-volver">← Volver a la búsqueda</button>
        <div class="pkp-detalle-nombre">${esc(row.nombre)}</div>
        <div class="pkp-detalle-grid">
          <div>
            <div class="pkp-detalle-label">Código</div>
            <div class="pkp-detalle-val">${row.codigo ? esc(row.codigo) : '—'}</div>
          </div>
          <div>
            <div class="pkp-detalle-label">Stock</div>
            <div class="pkp-detalle-val${stockBajo ? ' pkp-stock-cero' : ''}">${Number(row.stock).toLocaleString('es-AR', { maximumFractionDigits: 2 })}</div>
          </div>
          <div>
            <div class="pkp-detalle-label">Precio de venta</div>
            <div class="pkp-detalle-val">${fmt$(row.precio_venta)}</div>
          </div>
          ${costoRow}
          <div>
            <div class="pkp-detalle-label">Categoría</div>
            <div class="pkp-detalle-val">${row.categoria ? esc(row.categoria) : '—'}</div>
          </div>
          <div>
            <div class="pkp-detalle-label">Proveedor</div>
            <div class="pkp-detalle-val">${row.proveedor ? esc(row.proveedor) : '—'}</div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('pkp-btn-volver')?.addEventListener('click', () => {
      buscar(elInput.value.trim());
      elInput.focus();
    });
  }

  function _onInput() {
    clearTimeout(searchTimer);
    const q = elInput.value.trim();
    searchTimer = setTimeout(() => buscar(q), 180);
  }

  function buildUI() {
    ensureCss();

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'pkp-fab';
    fab.id = 'pkp-fab-btn';
    fab.title = 'Buscar producto (Ctrl+K)';
    fab.textContent = '🔍';
    fab.addEventListener('click', () => (isOpen ? close() : open()));
    document.body.appendChild(fab);

    elOverlay = document.createElement('div');
    elOverlay.className = 'pkp-overlay';
    elOverlay.style.display = 'none';
    elOverlay.innerHTML = `
      <div class="pkp-panel">
        <div class="pkp-search-row">
          <input type="text" id="pkp-input" placeholder="Nombre o código de barras..." autocomplete="off">
          <button type="button" class="pkp-close-btn" id="pkp-btn-close" aria-label="Cerrar" title="Cerrar (Esc)">✕</button>
        </div>
        <div class="pkp-body" id="pkp-body">
          <div class="pkp-hint">Escribí un nombre o escaneá un código.</div>
        </div>
      </div>
    `;
    document.body.appendChild(elOverlay);

    elInput = elOverlay.querySelector('#pkp-input');
    elBody  = elOverlay.querySelector('#pkp-body');

    elInput.addEventListener('input', _onInput);
    elOverlay.querySelector('#pkp-btn-close').addEventListener('click', close);
    // Clic en el fondo (no en el panel) cierra, como cualquier modal.
    elOverlay.addEventListener('click', e => { if (e.target === elOverlay) close(); });

    kbNav = Buscador.attachDropdownKeyboard(elInput, {
      getItems: () => elBody.querySelectorAll('.pkp-row'),
      highlightClass: 'pkp-row-hl',
      onEscape: close,
      onEnterSinResaltado: () => {
        // Un solo resultado visible + Enter: mismo atajo que el resto de
        // los buscadores del sistema (código exacto escaneado).
        const q = elInput.value.trim();
        if (!q) return;
        const exacto = Buscador.porCodigo(q, { sucursalId: sucFiltro() });
        if (exacto) { mostrarDetalle(exacto.id); return; }
        const rows = elBody.querySelectorAll('.pkp-row');
        if (rows.length === 1) mostrarDetalle(rows[0].dataset.id);
      },
    });

    // Escape en fase de CAPTURA: el panel tiene que comerse la tecla antes
    // de que le llegue a la pantalla de atrás (ver memoria "modal debe
    // capturar su propio teclado") — si no, un Escape para cerrar este peek
    // también podría disparar el handler de Escape de, por ejemplo, un
    // carrito de venta en curso.
    document.addEventListener('keydown', e => {
      if (!isOpen) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }, { capture: true });
  }

  function open() {
    if (!elOverlay) return;
    isOpen = true;
    elOverlay.style.display = 'flex';
    elInput.value = '';
    buscar('');
    elInput.focus();
  }

  function close() {
    if (!elOverlay) return;
    isOpen = false;
    clearTimeout(searchTimer);
    elOverlay.style.display = 'none';
  }

  function initFloatingButton() {
    if (document.getElementById('pkp-fab-btn')) return; // ya inicializado
    buildUI();
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        isOpen ? close() : open();
      }
    });
  }

  return { initFloatingButton, open, close };
})();

window.SGA_PeekProductos = SGA_PeekProductos;

export default SGA_PeekProductos;
