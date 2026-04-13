/**
 * etiquetas.js — Price Labels Module
 *
 * Generates and prints A4 price labels: 3 columns × 10 rows = 30 per sheet.
 * Each label: product name + price on the left, EAN barcode (rotated 90°) on the right.
 *
 * Print flow: builds a self-contained HTML page (Blob URL), opens in new tab,
 * JsBarcode renders all SVGs, then window.print() fires automatically.
 *
 * Compras integration: if localStorage has 'etiquetas_pending' (JSON array of
 * { id, nombre, precio_venta, codigo, cantidad }), those items are pre-loaded.
 */

const JSBARCODE_CDN = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';

const mod = {

  _state: null,

  init() {
    this._state = {
      items: [],       // [{ id, nombre, precio_venta, codigo, cantidad }]
      query: '',
      results: [],
      showDrop: false,
      focusIdx: -1,    // keyboard-focused dropdown row (-1 = none)
    };
    this._loadPending();
    this._render();
    this._bind();
  },

  _db() { return window.SGA_DB; },

  // ── Pending items from Compras ─────────────────────────────────────────
  _loadPending() {
    try {
      const raw = localStorage.getItem('etiquetas_pending');
      if (!raw) return;
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(p => this._addItem(p));
        localStorage.removeItem('etiquetas_pending');
      }
    } catch (_) {}
  },

  // ── Formatting ─────────────────────────────────────────────────────────
  _fmt(price) {
    return '$ ' + Number(price).toLocaleString('es-AR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  },

  // ── Render ─────────────────────────────────────────────────────────────
  _render() {
    const el = document.getElementById('app-content');
    if (!el) return;

    const { items, query, results, showDrop } = this._state;
    const totalEtiq = items.reduce((s, i) => s + i.cantidad, 0);

    el.innerHTML = `
      <div class="etiq-root">
        <div class="etiq-header">
          <h2>🏷️ Etiquetas de Precio</h2>
          <div class="etiq-header-actions">
            ${items.length > 0 ? `<button class="btn-clear" id="etiq-btn-limpiar">Limpiar todo</button>` : ''}
            <button class="btn-print" id="etiq-btn-imprimir" ${totalEtiq === 0 ? 'disabled' : ''}>
              🖨️ Imprimir${totalEtiq > 0 ? ` (${totalEtiq})` : ''}
            </button>
          </div>
        </div>

        <div class="etiq-body">
          <!-- Search column -->
          <div class="etiq-col-search">
            <div class="etiq-section-title">Agregar productos</div>
            <div class="etiq-search-wrap">
              <input type="text" id="etiq-busqueda"
                     value="${this._esc(query)}"
                     placeholder="Nombre o código de barras..."
                     autocomplete="off">
              ${showDrop ? this._buildDropdown(results, query) : ''}
            </div>
            <div style="font-size:0.78rem;color:#aaa;margin-top:2px;">
              Buscar por nombre o escanear/ingresar código de barras
            </div>
          </div>

          <!-- List column -->
          <div class="etiq-col-list">
            <div class="etiq-section-title">
              Seleccionados
              ${items.length > 0 ? `<span class="etiq-total-badge">${items.length} prod · ${totalEtiq} etiq</span>` : ''}
            </div>
            ${items.length === 0
              ? `<div class="etiq-empty">Ningún producto seleccionado.<br>Usá el buscador para agregar.</div>`
              : `<div class="etiq-list">${items.map((it, idx) => this._buildItem(it, idx)).join('')}</div>`
            }
          </div>
        </div>
      </div>
    `;
  },

  _buildDropdown(results, query, focusIdx = -1) {
    if (results.length === 0) {
      return query.length > 1
        ? `<div class="etiq-dropdown"><div class="etiq-no-results">Sin resultados para "${this._esc(query)}"</div></div>`
        : '';
    }
    const rows = results.map((r, i) => `
      <div class="etiq-drop-item${i === focusIdx ? ' etiq-drop-item--focused' : ''}" data-id="${r.id}">
        <div style="flex:1;min-width:0;">
          <div class="etiq-drop-nombre">${this._esc(r.nombre)}</div>
          ${r.codigo ? `<div class="etiq-drop-cod">${r.codigo}</div>` : ''}
        </div>
        <div class="etiq-drop-precio">${this._fmt(r.precio_venta)}</div>
      </div>
    `).join('');
    return `<div class="etiq-dropdown">${rows}</div>`;
  },

  _buildItem(it, idx) {
    return `
      <div class="etiq-item" data-idx="${idx}">
        <div style="flex:1;min-width:0;">
          <div class="etiq-item-nombre">${this._esc(it.nombre)}</div>
          ${it.codigo ? `<div class="etiq-item-cod">${it.codigo}</div>` : ''}
        </div>
        <div class="etiq-item-precio">${this._fmt(it.precio_venta)}</div>
        <div class="etiq-item-qty">
          <button class="etiq-qty-dec" data-idx="${idx}">−</button>
          <input type="number" class="etiq-qty-input" data-idx="${idx}"
                 value="${it.cantidad}" min="1" max="999">
          <button class="etiq-qty-inc" data-idx="${idx}">+</button>
        </div>
        <button class="etiq-item-remove" data-idx="${idx}" title="Quitar">✕</button>
      </div>
    `;
  },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // ── Event binding ──────────────────────────────────────────────────────
  _bind() {
    const el = document.getElementById('app-content');

    // Search input
    const inp = document.getElementById('etiq-busqueda');
    if (inp) {
      inp.addEventListener('input', e => this._onSearch(e.target.value));
      inp.addEventListener('keydown', e => {
        const { showDrop, results } = this._state;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (showDrop && results.length) this._moveFocus(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          this._selectFocused();
          return;
        }
        if (e.key === 'Escape') {
          this._state.showDrop = false;
          this._state.focusIdx = -1;
          this._render();
          this._bind();
        }
      });
      // Re-focus after render
      inp.focus();
    }

    // Click outside to close dropdown
    document.addEventListener('click', this._outsideClick.bind(this), { once: true });

    // Dropdown item click (delegated)
    el.addEventListener('click', e => {
      const dropItem = e.target.closest('.etiq-drop-item');
      if (dropItem) {
        const id = dropItem.dataset.id;
        const prod = this._state.results.find(r => r.id === id);
        if (prod) { this._addItem(prod); }
        return;
      }

      // Qty controls
      const dec = e.target.closest('.etiq-qty-dec');
      if (dec) { this._adjustQty(+dec.dataset.idx, -1); return; }
      const inc = e.target.closest('.etiq-qty-inc');
      if (inc) { this._adjustQty(+inc.dataset.idx, +1); return; }

      // Remove
      const rem = e.target.closest('.etiq-item-remove');
      if (rem) { this._removeItem(+rem.dataset.idx); return; }

      // Buttons
      if (e.target.id === 'etiq-btn-imprimir') { this._print(); return; }
      if (e.target.id === 'etiq-btn-limpiar') { this._state.items = []; this._render(); this._bind(); return; }
    });

    // Qty input change (delegated)
    el.addEventListener('change', e => {
      const qInp = e.target.closest('.etiq-qty-input');
      if (qInp) {
        const idx = +qInp.dataset.idx;
        const val = Math.max(1, Math.min(999, parseInt(qInp.value) || 1));
        this._state.items[idx].cantidad = val;
        this._render(); this._bind();
      }
    });
  },

  _outsideClick(e) {
    if (!e.target.closest('.etiq-search-wrap') && !e.target.closest('.etiq-dropdown')) {
      if (this._state.showDrop) {
        this._state.showDrop = false;
        this._render();
        this._bind();
      }
    }
  },

  _focusSearch() {
    const inp = document.getElementById('etiq-busqueda');
    if (inp) { inp.focus(); inp.select(); }
  },

  // ── Search ─────────────────────────────────────────────────────────────
  _onSearch(q) {
    this._state.query = q;
    if (q.length < 2) {
      this._state.results = [];
      this._state.showDrop = false;
      this._renderDropdown();
      return;
    }
    const like = `%${q.toLowerCase()}%`;
    const rows = this._db().query(`
      SELECT p.id, p.nombre, p.precio_venta,
        (SELECT codigo FROM codigos_barras
         WHERE producto_id = p.id AND es_principal = 1 LIMIT 1) AS codigo
      FROM productos p
      WHERE p.activo = 1
        AND (LOWER(p.nombre) LIKE ?
             OR EXISTS (SELECT 1 FROM codigos_barras WHERE producto_id = p.id AND codigo LIKE ?))
      ORDER BY p.nombre
      LIMIT 20
    `, [like, like]) || [];

    this._state.results = rows;
    this._state.showDrop = true;
    this._state.focusIdx = -1;
    this._renderDropdown();
    // Re-attach outside listener
    document.addEventListener('click', this._outsideClick.bind(this), { once: true });
  },

  // Partial re-render: only swap the dropdown DOM without touching the rest of the UI
  _renderDropdown() {
    const wrap = document.querySelector('.etiq-search-wrap');
    if (!wrap) return;
    const old = wrap.querySelector('.etiq-dropdown');
    if (old) old.remove();
    const { results, query, showDrop, focusIdx } = this._state;
    if (!showDrop) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this._buildDropdown(results, query, focusIdx);
    const newDrop = tmp.firstElementChild;
    if (newDrop) wrap.appendChild(newDrop);
  },

  // Move keyboard focus up/down inside the open dropdown (no re-render)
  _moveFocus(delta) {
    const { results } = this._state;
    if (!results.length) return;
    const max = results.length - 1;
    let next = this._state.focusIdx + delta;
    if (next < 0) next = max;
    if (next > max) next = 0;
    this._state.focusIdx = next;

    // Toggle class directly — avoids full re-render and preserves scroll position
    document.querySelectorAll('.etiq-drop-item').forEach((el, i) => {
      el.classList.toggle('etiq-drop-item--focused', i === next);
    });

    // Keep focused item visible inside the scrollable dropdown
    const focused = document.querySelectorAll('.etiq-drop-item')[next];
    if (focused) focused.scrollIntoView({ block: 'nearest' });
  },

  // Confirm the currently focused dropdown row (or do nothing if none focused)
  _selectFocused() {
    const { results, focusIdx, showDrop } = this._state;
    if (!showDrop || focusIdx < 0 || focusIdx >= results.length) return;
    this._addItem(results[focusIdx]);
  },

  // ── Item management ────────────────────────────────────────────────────
  _addItem(prod) {
    const existing = this._state.items.find(i => i.id === prod.id);
    if (existing) {
      existing.cantidad = Math.min(999, existing.cantidad + 1);
    } else {
      this._state.items.push({
        id: prod.id,
        nombre: prod.nombre,
        precio_venta: prod.precio_venta,
        codigo: prod.codigo || null,
        cantidad: 1,
      });
    }
    this._state.query = '';
    this._state.results = [];
    this._state.showDrop = false;
    this._render();
    this._bind();
  },

  _removeItem(idx) {
    this._state.items.splice(idx, 1);
    this._render();
    this._bind();
  },

  _adjustQty(idx, delta) {
    const it = this._state.items[idx];
    if (!it) return;
    it.cantidad = Math.max(1, Math.min(999, it.cantidad + delta));
    this._render();
    this._bind();
  },

  // ── Print ──────────────────────────────────────────────────────────────
  _print() {
    const { items } = this._state;
    if (items.length === 0) return;

    // Expand items by quantity into a flat label array
    const labels = [];
    items.forEach(it => {
      for (let i = 0; i < it.cantidad; i++) {
        labels.push({ nombre: it.nombre, precio: it.precio_venta, codigo: it.codigo });
      }
    });

    const labelsHTML = labels.map(l => this._buildLabelHTML(l)).join('\n');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Etiquetas de Precio</title>
<script src="${JSBARCODE_CDN}"><\/script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
@page { size: A4 portrait; margin: 0; }
html, body {
  width: 210mm;
  font-family: Arial, Helvetica, sans-serif;
  background: white;
}
.grid {
  width: 210mm;
  display: grid;
  grid-template-columns: repeat(3, 70mm);
  grid-auto-rows: 29.7mm;
}
/* ── Label shell ── */
.etiq {
  width: 70mm;
  height: 29.7mm;
  border: 0.3pt solid #aaa;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* ── Top: product name ── */
.etiq-top {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2mm 3mm 0.5mm 3mm;
  overflow: hidden;
}
.etiq-nombre {
  font-size: 9.5pt;
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
  height: 14.5mm;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 2mm 1.5mm 2mm;
  gap: 1.5mm;
}
/* Reserved logo space — faint border as guide */
.etiq-logo {
  width: 10mm;
  height: 10mm;
  flex-shrink: 0;
  border: 0.4pt dashed #ccc;
  border-radius: 1mm;
}
.etiq-precio {
  flex: 1;
  font-size: 11pt;
  font-weight: 900;
  text-align: center;
  white-space: nowrap;
  letter-spacing: -0.3pt;
}
/* Barcode area — horizontal, no rotation */
.etiq-barcode {
  width: 30mm;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.bc-svg {
  display: block;
  width: 30mm;   /* forces SVG to scale to this width */
  height: auto;  /* aspect ratio preserved via viewBox */
  max-height: 12mm;
}
</style>
</head>
<body>
<div class="grid">
${labelsHTML}
</div>
<script>
(function() {
  document.querySelectorAll('.bc-svg').forEach(function(svg) {
    var code = svg.dataset.code;
    if (!code) return;
    try {
      JsBarcode(svg, code, {
        width: 1.3,
        height: 36,
        displayValue: true,
        fontSize: 8,
        margin: 3,
        textMargin: 0,
        background: '#ffffff',
        lineColor: '#000000'
      });
      /* CSS overrides JsBarcode's inline width/height attrs */
      svg.style.cssText = 'display:block;width:30mm;height:auto;max-height:12mm';
    } catch(e) {
      svg.closest('.etiq-barcode').innerHTML =
        '<div style="font-size:6pt;color:#bbb;word-break:break-all;padding:1mm;text-align:center">' + code + '</div>';
    }
  });
  setTimeout(function() { window.print(); }, 400);
})();
<\/script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) {
      alert('El navegador bloqueó la ventana emergente. Permití los popups para esta página e intentá de nuevo.');
    }
    // Revoke after 2 minutes
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  },

  _buildLabelHTML(label) {
    const precio = this._fmt(label.precio);
    const barcodeCol = label.codigo
      ? `<div class="etiq-barcode"><svg class="bc-svg" data-code="${this._esc(label.codigo)}"></svg></div>`
      : '';
    return `
  <div class="etiq">
    <div class="etiq-top">
      <div class="etiq-nombre">${this._esc(label.nombre)}</div>
    </div>
    <div class="etiq-bottom">
      <div class="etiq-logo"></div>
      <div class="etiq-precio">${this._esc(precio)}</div>
      ${barcodeCol}
    </div>
  </div>`;
  },

};

export default mod;
