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
      sugeridas: [],
      sugeridasFocusIdx: -1,
      sugeridasFiltros: { categorias: new Set(), proveedores: new Set() },
    };
    this._loadPending();
    this._loadSugeridas();
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

        <!-- Sugeridas -->
        <div class="etiq-sugeridas">
          <div class="etiq-section-title">
            Etiquetas sugeridas
            ${this._state.sugeridas.length > 0 ? `<span class="etiq-total-badge etiq-sug-badge">${this._state.sugeridas.length}</span>` : ''}
          </div>
          <div class="etiq-sugeridas-body">${this._buildSugeridas()}</div>
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
      // Solo foco el buscador si el usuario no está navegando sugeridas
      if (this._state.sugeridasFocusIdx < 0) inp.focus();
      inp.addEventListener('focus', () => { this._state.sugeridasFocusIdx = -1; });
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
      if (e.target.id === 'etiq-btn-limpiar' || e.target.id === 'etiq-sug-limpiar') {
        if (!document.contains(e.target)) return;
        this._state.items = [];
        this._state.sugeridasFocusIdx = -1;
        this._render(); this._bind(); return;
      }

      // Slicers: limpiar filtro
      const clearBtn = e.target.closest('.etiq-slicer-clear');
      if (clearBtn) {
        if (!document.contains(clearBtn)) return;
        const key = clearBtn.dataset.clear;
        if (key === 'cat') this._state.sugeridasFiltros.categorias = new Set();
        else this._state.sugeridasFiltros.proveedores = new Set();
        this._renderSugeridas();
        return;
      }
      // Slicers: click exclusivo / Ctrl+click multi-select
      const slicerItem = e.target.closest('.etiq-slicer-item');
      if (slicerItem) {
        if (!document.contains(slicerItem)) return;
        const key = slicerItem.dataset.filter;
        const val = slicerItem.dataset.val;
        const set = key === 'cat' ? this._state.sugeridasFiltros.categorias : this._state.sugeridasFiltros.proveedores;
        if (e.ctrlKey || e.metaKey) {
          if (set.has(val)) set.delete(val); else set.add(val);
        } else {
          if (set.size === 1 && set.has(val)) set.clear();
          else { set.clear(); set.add(val); }
        }
        this._renderSugeridas();
        return;
      }
    });

    // Qty input + sugeridas checkboxes (delegated)
    el.addEventListener('change', e => {
      const qInp = e.target.closest('.etiq-qty-input');
      if (qInp) {
        const idx = +qInp.dataset.idx;
        const val = Math.max(1, Math.min(999, parseInt(qInp.value) || 1));
        this._state.items[idx].cantidad = val;
        this._render(); this._bind();
        return;
      }
      // Sugeridas: select-all → agrega/remueve todos los visibles de items
      if (e.target.id === 'etiq-sug-chk-all') {
        const visible = this._getFilteredSugeridas();
        if (e.target.checked) {
          visible.forEach(r => {
            if (!this._state.items.find(i => i.id === r.id))
              this._state.items.push({ id: r.id, nombre: r.nombre, precio_venta: r.precio_venta, codigo: r.codigo || null, cantidad: 1 });
          });
        } else {
          const visIds = new Set(visible.map(r => r.id));
          this._state.items = this._state.items.filter(i => !visIds.has(i.id));
        }
        this._state.sugeridasFocusIdx = -1;
        this._render(); this._bind();
        return;
      }
      // Sugeridas: checkbox individual → auto-agrega o remueve de items
      const sugChk = e.target.closest('.etiq-sug-chk');
      if (sugChk) {
        if (!document.contains(sugChk)) return; // listener huérfano de render anterior
        const id = sugChk.dataset.id;
        const row = sugChk.closest('.etiq-sug-row');
        if (sugChk.checked) {
          const prod = this._state.sugeridas.find(r => r.id === id);
          if (prod && !this._state.items.find(i => i.id === id))
            this._state.items.push({ id: prod.id, nombre: prod.nombre, precio_venta: prod.precio_venta, codigo: prod.codigo || null, cantidad: 1 });
        } else {
          this._state.items = this._state.items.filter(i => i.id !== id);
        }
        // Preservar foco en la misma fila
        const rows = [...document.querySelectorAll('.etiq-sug-row')];
        this._state.sugeridasFocusIdx = rows.indexOf(row);
        this._render(); this._bind();
      }
    });

    // Sugeridas: navegación por teclado (Arrow + Espacio)
    el.addEventListener('keydown', e => {
      const row = e.target.closest('.etiq-sug-row');
      if (!row || !document.contains(row)) return;
      const rows = [...document.querySelectorAll('.etiq-sug-row')];
      const idx = rows.indexOf(row);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(idx + 1, rows.length - 1);
        this._state.sugeridasFocusIdx = next;
        rows[next].focus();
        rows[next].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(idx - 1, 0);
        this._state.sugeridasFocusIdx = prev;
        rows[prev].focus();
        rows[prev].scrollIntoView({ block: 'nearest' });
      } else if (e.key === ' ') {
        e.preventDefault();
        const chk = row.querySelector('.etiq-sug-chk');
        if (chk) { chk.checked = !chk.checked; chk.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });

    // Trackear qué fila de sugeridas tiene foco
    el.addEventListener('focusin', e => {
      const row = e.target.closest('.etiq-sug-row');
      if (row) {
        const rows = [...document.querySelectorAll('.etiq-sug-row')];
        this._state.sugeridasFocusIdx = rows.indexOf(row);
      }
    });

    this._restoreSugFocus();
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
    this._state.sugeridasFocusIdx = -1;
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

  // ── Sugeridas ──────────────────────────────────────────────────────────
  _loadSugeridas() {
    const rows = this._db().query(`
      SELECT p.id, p.nombre, p.precio_venta, p.ultima_modificacion_precio,
        p.categoria_id, c.nombre AS categoria_nombre,
        p.proveedor_principal_id, pv.razon_social AS proveedor_nombre,
        (SELECT codigo FROM codigos_barras WHERE producto_id = p.id AND es_principal = 1 LIMIT 1) AS codigo
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN proveedores pv ON pv.id = p.proveedor_principal_id
      WHERE p.activo = 1
        AND (p.ultima_impresion_etiqueta IS NULL
             OR p.ultima_modificacion_precio > p.ultima_impresion_etiqueta)
      ORDER BY p.nombre
    `) || [];
    this._state.sugeridas = rows;
  },

  _getFilteredSugeridas() {
    const { sugeridas, sugeridasFiltros } = this._state;
    let list = sugeridas;
    if (sugeridasFiltros.categorias.size > 0)
      list = list.filter(r => sugeridasFiltros.categorias.has(r.categoria_id || '__none__'));
    if (sugeridasFiltros.proveedores.size > 0)
      list = list.filter(r => sugeridasFiltros.proveedores.has(r.proveedor_principal_id || '__none__'));
    return list;
  },

  _buildSlicers() {
    const { sugeridas, sugeridasFiltros } = this._state;

    const buildPanel = (title, keyFn, labelFn, activeSet, filterKey) => {
      const map = new Map();
      sugeridas.forEach(r => {
        const k = keyFn(r);
        if (!map.has(k)) map.set(k, labelFn(r));
      });
      if (map.size < 2) return '';
      const hasActive = activeSet.size > 0;
      const items = [...map.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, label]) => `
          <div class="etiq-slicer-item${activeSet.has(id) ? ' etiq-slicer-item--active' : ''}"
               data-filter="${filterKey}" data-val="${this._esc(id)}">
            ${this._esc(label)}
          </div>`).join('');
      return `
        <div class="etiq-slicer">
          <div class="etiq-slicer-title">
            ${title}
            ${hasActive ? `<span class="etiq-slicer-clear" data-clear="${filterKey}" title="Limpiar filtro">✕</span>` : ''}
          </div>
          <div class="etiq-slicer-list">${items}</div>
        </div>`;
    };

    const catPanel  = buildPanel('Categoría', r => r.categoria_id || '__none__',         r => r.categoria_nombre  || 'Sin categoría',  sugeridasFiltros.categorias,  'cat');
    const provPanel = buildPanel('Proveedor',  r => r.proveedor_principal_id || '__none__', r => r.proveedor_nombre  || 'Sin proveedor',  sugeridasFiltros.proveedores, 'prov');

    if (!catPanel && !provPanel) return '';
    return `<div class="etiq-slicers">${catPanel}${provPanel}</div>`;
  },

  _buildSugeridas() {
    const { sugeridas, sugeridasFocusIdx } = this._state;
    if (sugeridas.length === 0) {
      return `<div class="etiq-sug-empty">Todos los productos tienen sus etiquetas al día.</div>`;
    }
    const visible = this._getFilteredSugeridas();
    const itemIds = new Set(this._state.items.map(i => i.id));
    const allChecked = visible.length > 0 && visible.every(r => itemIds.has(r.id));
    const rows = visible.map((r, i) => `
      <div class="etiq-sug-row" tabindex="0" data-idx="${i}" data-id="${r.id}">
        <input type="checkbox" class="etiq-sug-chk" data-id="${r.id}" ${itemIds.has(r.id) ? 'checked' : ''}>
        <div class="etiq-sug-nombre">${this._esc(r.nombre)}</div>
        <div class="etiq-sug-precio">${this._fmt(r.precio_venta)}</div>
        <div class="etiq-sug-fecha">${r.ultima_modificacion_precio ? r.ultima_modificacion_precio.slice(0, 10) : '—'}</div>
      </div>
    `).join('');
    const listContent = visible.length === 0
      ? `<div class="etiq-sug-empty">Ningún producto coincide con los filtros seleccionados.</div>`
      : `<div class="etiq-sug-list">${rows}</div>`;
    return `
      <div class="etiq-sug-toolbar">
        <label class="etiq-sug-selectall">
          <input type="checkbox" id="etiq-sug-chk-all" ${allChecked ? 'checked' : ''}>
          Seleccionar todo
        </label>
        ${this._state.items.length > 0 ? `<button id="etiq-sug-limpiar" class="etiq-sug-clear-btn">Limpiar todo</button>` : ''}
      </div>
      <div class="etiq-sug-main">
        <div class="etiq-sug-main-list">${listContent}</div>
        ${this._buildSlicers()}
      </div>
    `;
  },

  _restoreSugFocus() {
    const idx = this._state.sugeridasFocusIdx;
    if (idx < 0) return;
    const rows = document.querySelectorAll('.etiq-sug-row');
    const row = rows[Math.min(idx, rows.length - 1)];
    if (row) { row.focus(); row.scrollIntoView({ block: 'nearest' }); }
  },

  _renderSugeridas() {
    const body = document.querySelector('.etiq-sugeridas-body');
    if (body) body.innerHTML = this._buildSugeridas();
    const badge = document.querySelector('.etiq-sug-badge');
    if (badge) badge.textContent = this._state.sugeridas.length;
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
.etiq-logo {
  width: 10mm;
  height: 10mm;
  flex-shrink: 0;
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
    const printedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const printedIds = [...new Set(items.map(i => i.id))];
    printedIds.forEach(id => {
      window.SGA_DB.run(`UPDATE productos SET ultima_impresion_etiqueta=? WHERE id=?`, [printedAt, id]);
    });
    this._loadSugeridas();
    this._renderSugeridas();
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
      <div class="etiq-logo"><img src="data:image/png;base64,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" style="width:100%;height:100%;object-fit:contain;"></div>
      <div class="etiq-precio">${this._esc(precio)}</div>
      ${barcodeCol}
    </div>
  </div>`;
  },

};

export default mod;
