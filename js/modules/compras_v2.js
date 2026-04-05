'use strict';

const ComprasV2 = (() => {

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const ge    = id => document.getElementById(id);
  const fmt$  = n  => window.SGA_Utils.formatCurrency(n);
  const uuid  = () => window.SGA_Utils.generateUUID();
  const nowISO = () => window.SGA_Utils.formatISODate(new Date());
  const todayDate = () => new Date().toISOString().slice(0, 10);
  const db = () => window.SGA_DB;
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const UNIDADES_COMPRA = ['Unidad', 'Pack', 'Caja', 'Display', 'Kg', 'Lt', 'Bolsa', 'Docena'];

  function formatARS(n) {
    const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
    const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return '$ ' + intFormatted + ',' + decPart;
  }
  function parseARS(s) {
    return parseFloat(
      String(s).replace(/\$/g, '').trim().replace(/\./g, '').replace(',', '.')
    ) || 0;
  }

  // ── State ────────────────────────────────────────────────────────────────────
  const state = {
    proveedorId:        null,
    proveedorNombre:    null,
    proveedorSaldo:     0,      // positive = nosotros le debemos | negative = nos deben
    aplicarSaldo:       false,
    condicionPago:      'efectivo',
    facturaPv:          '',
    numeroFactura:      '',
    fecha:              todayDate(),
    fechaVencimiento:   '',
    totalFactura:       0,
    items:              [],     // cart items
    pausadaId:          null,
    sesionActiva:       null,
    currentUser:        null,
    // transient UI
    searchResults:      [],
    searchHighlight:    -1,
    searchQuerySaved:   '',   // typed query before arrow navigation
    provResults:        [],
    provHighlight:      -1,
  };

  // ── DB helpers ───────────────────────────────────────────────────────────────
  function getProveedorSaldo(proveedorId) {
    const r = db().query(
      `SELECT COALESCE(SUM(CASE WHEN tipo='deuda' THEN monto ELSE -monto END),0) AS saldo
       FROM cuenta_proveedor WHERE proveedor_id = ?`,
      [proveedorId]
    );
    return parseFloat(r[0]?.saldo) || 0;
  }

  function getSesionActiva(sucursalId) {
    const r = db().query(
      `SELECT id FROM sesiones_caja WHERE sucursal_id=? AND estado='abierta' LIMIT 1`,
      [sucursalId]
    );
    return r[0] || null;
  }

  // ── Cart math ────────────────────────────────────────────────────────────────
  function itemGross(item) {
    return (parseFloat(item.cantidad)   || 0)
         * (parseFloat(item.udsPaquete) || 1)
         * (parseFloat(item.costoNuevo) || parseFloat(item.costoActual) || 0);
  }

  // subtotal = gross × (1 - descuento%)
  function itemSubtotal(item) {
    const gross = itemGross(item);
    const disc  = Math.min(100, Math.max(0, parseFloat(item.descuento) || 0));
    return gross * (1 - disc / 100);
  }

  function calcGross() {
    return state.items.reduce((s, it) => s + itemGross(it), 0);
  }

  function calcDescuentoTotal() {
    return state.items.reduce((s, it) => s + (itemGross(it) - itemSubtotal(it)), 0);
  }

  function calcTotal() {
    return state.items.reduce((s, it) => s + itemSubtotal(it), 0);
  }

  function calcSaldoAplicado() {
    if (!state.aplicarSaldo || state.proveedorSaldo >= -0.01) return 0;
    return Math.min(Math.abs(state.proveedorSaldo), calcTotal());
  }

  function calcNeto() {
    return Math.max(0, calcTotal() - calcSaldoAplicado());
  }

  // ── Cart render ──────────────────────────────────────────────────────────────
  function renderCart() {
    const tbody = ge('cv2-cart-body');
    const empty = ge('cv2-cart-empty');
    const table = ge('cv2-cart-table');
    if (!tbody) return;

    if (state.items.length === 0) {
      if (empty) empty.style.display = 'flex';
      if (table) table.style.display = 'none';
      renderTotals();
      return;
    }

    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    tbody.innerHTML = state.items.map((it, i) => {
      const sub          = itemSubtotal(it);
      const costoChanged = Math.abs((parseFloat(it.costoNuevo) || 0) - (parseFloat(it.costoActual) || 0)) > 0.001;
      return `
        <tr class="cv2-cart-row" data-idx="${i}">
          <td class="cv2-td-num">${i + 1}</td>
          <td class="cv2-td-cod">${esc(it.barcode || '')}</td>
          <td class="cv2-cart-nombre" title="${esc(it.nombre)}">
            ${esc(it.nombre)}
            ${costoChanged ? `<span class="cv2-costo-changed" title="Costo modificado">↑</span>` : ''}
          </td>
          <td class="cv2-td-present">${parseFloat(it.udsPaquete) || 1} × ${esc(it.unidadCompra || 'Unidad')}</td>
          <td class="cv2-td-right">
            <input type="number" class="cv2-num-input" value="${it.cantidad}"
                   min="0.001" step="any" style="width:62px"
                   data-idx="${i}" data-field="cantidad">
          </td>
          <td class="cv2-td-costo-actual">${fmt$(it.costoActual)}</td>
          <td class="cv2-td-right">
            <input type="number" class="cv2-num-input nuevo-costo" value="${parseFloat(it.costoNuevo).toFixed(2)}"
                   min="0" step="any" style="width:80px"
                   data-idx="${i}" data-field="costoNuevo">
          </td>
          <td class="cv2-td-right">
            <div style="display:flex;gap:3px;justify-content:flex-end">
              <input type="number" class="cv2-num-input" value="${parseFloat(it.descuento || 0).toFixed(1)}"
                     min="0" max="100" step="0.1" style="width:50px" placeholder="%"
                     data-idx="${i}" data-field="descuento" title="Descuento (%)">
              <input type="number" class="cv2-num-input" value="${parseFloat(it.descuentoMonto || 0).toFixed(2)}"
                     min="0" step="any" style="width:66px" placeholder="$"
                     data-idx="${i}" data-field="descuentoMonto" title="Descuento ($)">
            </div>
          </td>
          <td class="cv2-subtotal cv2-td-right">${fmt$(sub)}</td>
          <td class="cv2-td-center">
            <button class="cv2-remove-btn" data-idx="${i}" title="Quitar">×</button>
          </td>
        </tr>
      `;
    }).join('');

    renderTotals();
  }

  function renderTotals() {
    const gross         = calcGross();
    const descuento     = calcDescuentoTotal();
    const total         = calcTotal();
    const saldoAplicado = calcSaldoAplicado();
    const neto          = calcNeto();

    const countEl = ge('cv2-item-count');
    if (countEl) countEl.textContent = `${state.items.length} producto${state.items.length !== 1 ? 's' : ''}`;

    const itemsEl = ge('cv2-summary-items');
    if (itemsEl) itemsEl.textContent = state.items.length;

    const subtotalEl = ge('cv2-summary-subtotal');
    if (subtotalEl) subtotalEl.textContent = fmt$(gross);

    const descEl = ge('cv2-summary-descuento');
    if (descEl) descEl.textContent = descuento > 0.001 ? `− ${fmt$(descuento)}` : fmt$(0);

    const totalEl = ge('cv2-total');
    if (totalEl) totalEl.textContent = fmt$(neto);

    const detalleEl = ge('cv2-total-detalle');
    if (detalleEl) {
      if (saldoAplicado > 0.01) {
        detalleEl.innerHTML =
          `<span class="cv2-total-bruto">Total s/saldo: ${fmt$(total)}</span>`
        + ` <span class="cv2-saldo-desc">Saldo aplicado: −${fmt$(saldoAplicado)}</span>`;
        detalleEl.style.display = 'block';
      } else {
        detalleEl.style.display = 'none';
      }
    }

    updateConfirmBtn();
  }

  // ── Proveedor panel ──────────────────────────────────────────────────────────
  function renderProveedorPanel() {
    const section = ge('cv2-saldo-section');
    if (!section) return;

    if (!state.proveedorId || Math.abs(state.proveedorSaldo) < 0.01) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';

    if (state.proveedorSaldo > 0.01) {
      // We owe them — informational only
      section.innerHTML = `
        <div class="cv2-saldo-badge cv2-saldo-deuda">
          Deuda pendiente con este proveedor: ${fmt$(state.proveedorSaldo)}
        </div>
      `;
    } else {
      // They owe us (saldo a favor)
      const disponible = Math.abs(state.proveedorSaldo);
      const aplicado   = state.aplicarSaldo ? Math.min(disponible, calcTotal()) : 0;

      section.innerHTML = `
        <div class="cv2-saldo-badge cv2-saldo-favor">
          Saldo a favor: ${fmt$(disponible)}
        </div>
        <label class="cv2-checkbox-row">
          <input type="checkbox" id="cv2-chk-saldo" ${state.aplicarSaldo ? 'checked' : ''}>
          Aplicar a esta compra
        </label>
        ${state.aplicarSaldo ? `
          <div class="cv2-saldo-detail">
            <span>Se aplican: ${fmt$(aplicado)}</span>
            ${disponible - aplicado > 0.01
              ? `<span>Saldo restante: ${fmt$(disponible - aplicado)}</span>`
              : ''}
          </div>
        ` : ''}
      `;

      ge('cv2-chk-saldo')?.addEventListener('change', e => {
        state.aplicarSaldo = e.target.checked;
        renderProveedorPanel();
        renderTotals();
      });
    }
  }

  function renderEfectivoInfo() {
    const el = ge('cv2-efectivo-info');
    if (!el) return;
    if (state.condicionPago !== 'efectivo' || state.sesionActiva) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="cv2-warning">⚠️ No hay sesión de caja abierta. El egreso no se registrará.</div>`;
  }

  function updateConfirmBtn() {
    const btn = ge('cv2-btn-confirmar');
    if (!btn) return;
    btn.disabled = !(state.proveedorId && state.items.length > 0);
    // Red alert when control total is set and doesn't match calculated total
    const mismatch = state.totalFactura > 0.001
      && Math.abs(state.totalFactura - calcNeto()) > 0.01;
    btn.classList.toggle('cv2-btn-confirmar-alert', mismatch && !btn.disabled);
  }

  // ── Product search ───────────────────────────────────────────────────────────
  function searchProductos(q) {
    if (!q || !q.trim()) return [];
    const like = `%${q.trim()}%`;
    return db().query(`
      SELECT p.id, p.nombre, p.costo,
             p.unidad_compra, p.unidades_por_paquete_compra,
             cb.codigo AS barcode
      FROM productos p
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      WHERE p.activo = 1 AND (p.nombre LIKE ? OR cb.codigo = ?)
      GROUP BY p.id
      LIMIT 15
    `, [like, q.trim()]);
  }

  function renderSearchDropdown() {
    const dd      = ge('cv2-dropdown');
    const inp     = ge('cv2-search');
    const results = state.searchResults;
    if (!dd) return;

    if (!results.length && !(inp?.value.trim())) {
      dd.style.display = 'none';
      return;
    }

    const rows = results.map((r, i) => `
      <div class="cv2-dd-item ${i === state.searchHighlight ? 'cv2-dd-item-hl' : ''}" data-i="${i}">
        <span class="cv2-dd-nombre">${esc(r.nombre)}</span>
        <span class="cv2-dd-meta">${esc(r.unidad_compra || 'Unidad')} · ${fmt$(r.costo)}</span>
      </div>
    `).join('');

    const val = inp?.value.trim() || '';
    const nuevoBtn = val.length > 0 ? `
      <div class="cv2-dd-item cv2-dd-nuevo" data-action="nuevo">
        <span>+ Crear producto nuevo</span>
        ${val.length >= 3 ? `<span class="cv2-dd-meta">Código: ${esc(val)}</span>` : ''}
      </div>
    ` : '';

    dd.innerHTML = rows + nuevoBtn;
    dd.style.display = (rows || nuevoBtn) ? 'block' : 'none';
  }

  // Toggle highlight class on existing DOM nodes + scroll into view.
  // Does NOT re-render the dropdown, matching the POS pattern.
  function scrollHighlight(ddId, idx) {
    const dd = ge(ddId);
    if (!dd) return;
    const items = dd.querySelectorAll('.cv2-dd-item:not(.cv2-dd-nuevo)');
    items.forEach((el, i) => el.classList.toggle('cv2-dd-item-hl', i === idx));
    if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function clearSearch() {
    state.searchResults   = [];
    state.searchHighlight = -1;
    state.searchQuerySaved = '';
    const inp = ge('cv2-search');
    if (inp) inp.value = '';
    const dd = ge('cv2-dropdown');
    if (dd) dd.style.display = 'none';
  }

  function selectSearchResult(idx) {
    const r = state.searchResults[idx];
    if (!r) return;
    addToCart({
      productoId:   r.id,
      nombre:       r.nombre,
      barcode:      r.barcode || '',
      unidadCompra: r.unidad_compra || 'Unidad',
      udsPaquete:   parseFloat(r.unidades_por_paquete_compra) || 1,
      costoActual:  parseFloat(r.costo) || 0,
      costoNuevo:   parseFloat(r.costo) || 0,
    });
    clearSearch();
  }

  // ── Cart mutations ───────────────────────────────────────────────────────────
  function addToCart(prod) {
    let targetIdx;
    const existing = state.items.findIndex(it => it.productoId === prod.productoId);
    if (existing >= 0) {
      state.items[existing].cantidad = parseFloat(state.items[existing].cantidad) + 1;
      targetIdx = existing;
    } else {
      state.items.push({
        productoId:      prod.productoId,
        nombre:          prod.nombre,
        barcode:         prod.barcode || '',
        unidadCompra:    prod.unidadCompra,
        udsPaquete:      prod.udsPaquete,
        costoActual:     prod.costoActual,
        costoNuevo:      prod.costoNuevo,
        cantidad:        1,
        descuento:       0,
        descuentoMonto:  0,
      });
      targetIdx = state.items.length - 1;
    }
    renderCart();
    if (state.proveedorSaldo < -0.01) renderProveedorPanel();

    // Focus and select the cantidad input of the added/updated row
    const cantInp = document.querySelector(`.cv2-cart-row[data-idx="${targetIdx}"] input[data-field="cantidad"]`);
    if (cantInp) { cantInp.select(); cantInp.focus(); }
    else ge('cv2-search')?.focus();
  }

  function updateItem(idx, field, rawValue) {
    const it = state.items[idx];
    if (!it) return;

    const v = parseFloat(rawValue);
    if (isNaN(v)) return;

    if (field === 'cantidad') {
      if (v <= 0) { state.items.splice(idx, 1); renderCart(); return; }
      it.cantidad = v;
    } else if (field === 'costoNuevo') {
      it.costoNuevo = Math.max(0, v);
    } else if (field === 'udsPaquete') {
      it.udsPaquete = Math.max(1, v);
    } else if (field === 'descuento') {
      it.descuento = Math.min(100, Math.max(0, v));
      it.descuentoMonto = itemGross(it) * it.descuento / 100;
      // Sync the $ input
      const montoInp = document.querySelector(`.cv2-cart-row[data-idx="${idx}"] input[data-field="descuentoMonto"]`);
      if (montoInp) montoInp.value = it.descuentoMonto.toFixed(2);
    } else if (field === 'descuentoMonto') {
      it.descuentoMonto = Math.max(0, v);
      const gross = itemGross(it);
      it.descuento = gross > 0 ? Math.min(100, (it.descuentoMonto / gross) * 100) : 0;
      // Sync the % input
      const pctInp = document.querySelector(`.cv2-cart-row[data-idx="${idx}"] input[data-field="descuento"]`);
      if (pctInp) pctInp.value = it.descuento.toFixed(1);
    }

    // Update just the affected subtotal cell instead of full re-render
    const subEl = document.querySelector(`.cv2-cart-row[data-idx="${idx}"] .cv2-subtotal`);
    if (subEl) subEl.textContent = fmt$(itemSubtotal(it));

    // Refresh cost-changed indicator if costoNuevo changed
    if (field === 'costoNuevo') {
      const nombreTd = document.querySelector(`.cv2-cart-row[data-idx="${idx}"] .cv2-cart-nombre`);
      if (nombreTd) {
        const changed = Math.abs((parseFloat(it.costoNuevo) || 0) - (parseFloat(it.costoActual) || 0)) > 0.001;
        let badge = nombreTd.querySelector('.cv2-costo-changed');
        if (changed && !badge) {
          badge = document.createElement('span');
          badge.className = 'cv2-costo-changed';
          badge.title = 'Costo modificado';
          badge.textContent = '↑';
          nombreTd.appendChild(badge);
        } else if (!changed && badge) {
          badge.remove();
        }
      }
    }

    renderTotals();
    if (state.proveedorSaldo < -0.01) renderProveedorPanel();
  }

  function removeItem(idx) {
    state.items.splice(idx, 1);
    renderCart();
    if (state.proveedorSaldo < -0.01) renderProveedorPanel();
  }

  // ── New product form ─────────────────────────────────────────────────────────
  function showNewProductForm(barcode) {
    const container = ge('cv2-new-prod-form');
    if (!container) return;

    container.style.display = 'block';
    container.innerHTML = `
      <div class="cv2-new-prod-header">
        <span>Nuevo producto</span>
        <button class="cv2-new-prod-close" id="cv2-np-close">×</button>
      </div>
      <div class="cv2-new-prod-body">
        <div class="cv2-field-row">
          <div class="cv2-field cv2-field-wide">
            <label>Nombre *</label>
            <input type="text" id="cv2-np-nombre" placeholder="Nombre del producto" autocomplete="off">
          </div>
        </div>
        <div class="cv2-field-row">
          <div class="cv2-field">
            <label>Unidad compra</label>
            <select id="cv2-np-unidad">
              ${UNIDADES_COMPRA.map(u => `<option value="${u}">${u}</option>`).join('')}
            </select>
          </div>
          <div class="cv2-field">
            <label>Uds/paquete</label>
            <input type="number" id="cv2-np-udspaq" value="1" min="1" step="1" style="width:70px">
          </div>
          <div class="cv2-field">
            <label>Costo/u *</label>
            <input type="number" id="cv2-np-costo" placeholder="0.00" min="0" step="any" style="width:90px">
          </div>
        </div>
        ${barcode ? `<div class="cv2-field-row"><span class="cv2-barcode-hint">Código: ${esc(barcode)}</span></div>` : ''}
        <div class="cv2-new-prod-footer">
          <button class="btn btn-ghost" id="cv2-np-cancel">Cancelar</button>
          <button class="btn btn-primary" id="cv2-np-crear">Crear y agregar</button>
        </div>
      </div>
    `;

    ge('cv2-np-close')  ?.addEventListener('click', hideNewProductForm);
    ge('cv2-np-cancel') ?.addEventListener('click', hideNewProductForm);
    ge('cv2-np-crear')  ?.addEventListener('click', () => submitNewProduct(barcode));
    ge('cv2-np-nombre') ?.focus();
  }

  function hideNewProductForm() {
    const c = ge('cv2-new-prod-form');
    if (c) { c.style.display = 'none'; c.innerHTML = ''; }
    ge('cv2-search')?.focus();
  }

  function submitNewProduct(barcode) {
    const nombre = ge('cv2-np-nombre')?.value.trim();
    const unidad = ge('cv2-np-unidad')?.value || 'Unidad';
    const udsPaq = parseFloat(ge('cv2-np-udspaq')?.value) || 1;
    const costo  = parseFloat(ge('cv2-np-costo')?.value);

    if (!nombre)              { alert('El nombre es obligatorio');  ge('cv2-np-nombre')?.focus(); return; }
    if (isNaN(costo) || costo < 0) { alert('Ingresá un costo válido'); ge('cv2-np-costo')?.focus();  return; }

    const prodId = uuid();
    const ts     = nowISO();
    const user   = state.currentUser;

    try {
      db().run(`
        INSERT INTO productos
          (id, nombre, costo, costo_paquete, unidad_compra, unidades_por_paquete_compra,
           activo, sucursal_id, sync_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?)
      `, [prodId, nombre, costo, costo * udsPaq, unidad, udsPaq, user.sucursal_id, ts]);

      if (barcode && barcode.trim()) {
        db().run(`
          INSERT INTO codigos_barras (id, producto_id, codigo, es_principal, sync_status, updated_at)
          VALUES (?, ?, ?, 1, 'pending', ?)
        `, [uuid(), prodId, barcode.trim(), ts]);
      }
    } catch (e) {
      alert('Error al crear el producto: ' + e.message);
      return;
    }

    hideNewProductForm();
    addToCart({ productoId: prodId, nombre, barcode: barcode || '', unidadCompra: unidad, udsPaquete: udsPaq, costoActual: costo, costoNuevo: costo });
  }

  // ── Proveedor search ─────────────────────────────────────────────────────────
  function searchProveedores(q) {
    if (!q || !q.trim()) return [];
    const like = `%${q.trim()}%`;
    return db().query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 AND razon_social LIKE ? LIMIT 10`,
      [like]
    );
  }

  function renderProvDropdown() {
    const dd      = ge('cv2-prov-dropdown');
    const results = state.provResults;
    if (!dd) return;
    if (!results.length) { dd.style.display = 'none'; return; }
    dd.style.display = 'block';
    dd.innerHTML = results.map((r, i) => `
      <div class="cv2-dd-item ${i === state.provHighlight ? 'cv2-dd-item-hl' : ''}" data-i="${i}">
        ${esc(r.razon_social)}
      </div>
    `).join('');
  }

  function selectProveedor(prov) {
    state.proveedorId     = prov.id;
    state.proveedorNombre = prov.razon_social;
    state.proveedorSaldo  = getProveedorSaldo(prov.id);
    state.aplicarSaldo    = state.proveedorSaldo < -0.01; // auto-apply if they owe us

    state.provResults     = [];
    state.provHighlight   = -1;

    const inp = ge('cv2-prov-search');
    if (inp) { inp.value = ''; inp.style.display = 'none'; }

    const dd = ge('cv2-prov-dropdown');
    if (dd) dd.style.display = 'none';

    const card   = ge('cv2-prov-card');
    const nameEl = ge('cv2-prov-nombre');
    if (card)   card.style.display = 'flex';
    if (nameEl) nameEl.textContent = prov.razon_social;

    renderProveedorPanel();
    renderTotals();
    updateConfirmBtn();
  }

  function clearProveedor() {
    state.proveedorId     = null;
    state.proveedorNombre = null;
    state.proveedorSaldo  = 0;
    state.aplicarSaldo    = false;

    const card = ge('cv2-prov-card');
    if (card) card.style.display = 'none';

    const inp = ge('cv2-prov-search');
    if (inp) { inp.value = ''; inp.style.display = 'block'; inp.focus(); }

    renderProveedorPanel();
    renderTotals();
    updateConfirmBtn();
  }

  // ── Pause / Resume ───────────────────────────────────────────────────────────
  function pausar() {
    if (!state.items.length) {
      window.SGA_Utils.showNotification('No hay productos para pausar', 'warning');
      return false;
    }

    const snapshot = JSON.stringify({
      proveedorId:      state.proveedorId,
      proveedorNombre:  state.proveedorNombre,
      condicionPago:    state.condicionPago,
      facturaPv:        state.facturaPv,
      numeroFactura:    state.numeroFactura,
      fecha:            state.fecha,
      fechaVencimiento: state.fechaVencimiento,
      items:            state.items,
    });

    const ts   = nowISO();
    const user = state.currentUser;

    try {
      if (state.pausadaId) {
        db().run(
          `UPDATE compras_pausadas
           SET snapshot=?, proveedor_nombre=?, num_items=?, total_estimado=?, updated_at=?
           WHERE id=?`,
          [snapshot, state.proveedorNombre || '', state.items.length, calcTotal(), ts, state.pausadaId]
        );
      } else {
        const id = uuid();
        db().run(
          `INSERT INTO compras_pausadas
             (id, sucursal_id, usuario_id, snapshot, proveedor_nombre, num_items, total_estimado, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, user.sucursal_id, user.id, snapshot,
           state.proveedorNombre || '', state.items.length, calcTotal(), ts, ts]
        );
        state.pausadaId = id;
      }
    } catch (e) {
      alert('Error al pausar: ' + e.message);
      return false;
    }

    window.SGA_Utils.showNotification('Compra pausada', 'success');
    resetToNew();
    return true;
  }

  function resetToNew() {
    state.proveedorId      = null;
    state.proveedorNombre  = null;
    state.proveedorSaldo   = 0;
    state.aplicarSaldo     = false;
    state.condicionPago    = 'efectivo';
    state.facturaPv        = '';
    state.numeroFactura    = '';
    state.fecha            = todayDate();
    state.fechaVencimiento = '';
    state.totalFactura     = 0;
    state.items            = [];
    state.pausadaId        = null;

    // Reset UI
    const card = ge('cv2-prov-card');
    if (card) card.style.display = 'none';
    const provInp = ge('cv2-prov-search');
    if (provInp) { provInp.value = ''; provInp.style.display = 'block'; }

    const radioEf = ge('cv2-radio-efectivo');
    if (radioEf) radioEf.checked = true;
    const chipEf  = ge('cv2-chip-efectivo');
    const chipPe  = ge('cv2-chip-pendiente');
    if (chipEf) chipEf.classList.add('cv2-chip-active');
    if (chipPe) chipPe.classList.remove('cv2-chip-active');

    const pvInp = ge('cv2-factura-pv');
    if (pvInp) pvInp.value = '';
    const facturaInp = ge('cv2-factura');
    if (facturaInp) facturaInp.value = '';
    const fechaInp = ge('cv2-fecha');
    if (fechaInp) fechaInp.value = todayDate();
    const vencInp = ge('cv2-fecha-vencimiento');
    if (vencInp) vencInp.value = '';
    const tfInp = ge('cv2-total-factura');
    if (tfInp) tfInp.value = '';

    renderCart();
    renderProveedorPanel();
    renderEfectivoInfo();
    updateConfirmBtn();
    updatePausadasBtn();
    ge('cv2-search')?.focus();
  }

  function loadPausadas() {
    return db().query(
      `SELECT * FROM compras_pausadas WHERE sucursal_id=? ORDER BY updated_at DESC`,
      [state.currentUser.sucursal_id]
    );
  }

  function showPausadasOverlay() {
    const pausadas = loadPausadas();
    if (!pausadas.length) {
      window.SGA_Utils.showNotification('No hay compras pausadas', 'info');
      return;
    }
    const overlay  = ge('cv2-pausadas-overlay');
    const listEl   = ge('cv2-pausadas-list');
    if (!overlay || !listEl) return;

    listEl.innerHTML = pausadas.map(p => {
      const fecha = p.updated_at ? p.updated_at.slice(0, 10) : '';
      return `
        <div class="cv2-pausada-item">
          <div class="cv2-pausada-info">
            <strong>${esc(p.proveedor_nombre || 'Sin proveedor')}</strong>
            <span>${p.num_items} producto${p.num_items !== 1 ? 's' : ''} · ${fmt$(p.total_estimado)}</span>
            <span class="cv2-pausada-date">${fecha}</span>
          </div>
          <div class="cv2-pausada-actions">
            <button class="btn btn-primary btn-sm" data-action="resume" data-id="${p.id}">Retomar</button>
            <button class="btn btn-ghost  btn-sm" data-action="delete" data-id="${p.id}">Eliminar</button>
          </div>
        </div>
      `;
    }).join('');

    overlay.style.display = 'flex';
  }

  function resumir(pausadaId) {
    const row = db().query(`SELECT * FROM compras_pausadas WHERE id=?`, [pausadaId])[0];
    if (!row) return;

    let snap;
    try { snap = JSON.parse(row.snapshot); }
    catch (e) { alert('Error al leer la compra pausada'); return; }

    state.proveedorId      = snap.proveedorId      || null;
    state.proveedorNombre  = snap.proveedorNombre  || null;
    state.condicionPago    = snap.condicionPago    || 'efectivo';
    state.facturaPv        = snap.facturaPv        || '';
    state.numeroFactura    = snap.numeroFactura    || '';
    state.fecha            = snap.fecha            || todayDate();
    state.fechaVencimiento = snap.fechaVencimiento || '';
    state.items            = snap.items            || [];
    state.pausadaId        = pausadaId;

    if (state.proveedorId) {
      state.proveedorSaldo = getProveedorSaldo(state.proveedorId);
      state.aplicarSaldo   = state.proveedorSaldo < -0.01;
    }

    // Restore proveedor card
    const card   = ge('cv2-prov-card');
    const nameEl = ge('cv2-prov-nombre');
    const provInp = ge('cv2-prov-search');
    if (state.proveedorNombre) {
      if (card)    { card.style.display = 'flex'; }
      if (nameEl)  { nameEl.textContent = state.proveedorNombre; }
      if (provInp) { provInp.style.display = 'none'; }
    }

    // Restore payment chip
    const radioEf = ge('cv2-radio-efectivo');
    const radioPe = ge('cv2-radio-pendiente');
    const chipEf  = ge('cv2-chip-efectivo');
    const chipPe  = ge('cv2-chip-pendiente');
    if (state.condicionPago === 'pendiente') {
      if (radioEf) radioEf.checked = false;
      if (radioPe) radioPe.checked = true;
      if (chipEf)  chipEf.classList.remove('cv2-chip-active');
      if (chipPe)  chipPe.classList.add('cv2-chip-active');
    } else {
      if (radioEf) radioEf.checked = true;
      if (radioPe) radioPe.checked = false;
      if (chipEf)  chipEf.classList.add('cv2-chip-active');
      if (chipPe)  chipPe.classList.remove('cv2-chip-active');
    }

    // Restore form fields
    const pvInp = ge('cv2-factura-pv');
    if (pvInp) pvInp.value = state.facturaPv;
    const facturaInp = ge('cv2-factura');
    if (facturaInp) facturaInp.value = state.numeroFactura;
    const fechaInp = ge('cv2-fecha');
    if (fechaInp) fechaInp.value = state.fecha;
    const vencInp = ge('cv2-fecha-vencimiento');
    if (vencInp) vencInp.value = state.fechaVencimiento;

    ge('cv2-pausadas-overlay').style.display = 'none';

    renderCart();
    renderProveedorPanel();
    renderEfectivoInfo();
    updateConfirmBtn();
    updatePausadasBtn();

    window.SGA_Utils.showNotification(`Compra de ${state.proveedorNombre || 'proveedor'} retomada`, 'success');
    ge('cv2-search')?.focus();
  }

  function deletePausada(id) {
    if (!confirm('¿Eliminar esta compra pausada?')) return;
    db().run(`DELETE FROM compras_pausadas WHERE id=?`, [id]);
    if (state.pausadaId === id) state.pausadaId = null;

    const item = document.querySelector(`.cv2-pausada-item:has([data-id="${id}"])`);
    if (item) item.remove();

    updatePausadasBtn();

    const remaining = ge('cv2-pausadas-list')?.querySelectorAll('.cv2-pausada-item').length || 0;
    if (!remaining) ge('cv2-pausadas-overlay').style.display = 'none';
  }

  function updatePausadasBtn() {
    const btn = ge('cv2-btn-pausadas');
    if (!btn) return;
    const count = loadPausadas().length;
    btn.textContent = count > 0 ? `Pausadas (${count})` : 'Pausadas';
  }

  // ── Volver modal ─────────────────────────────────────────────────────────────
  function showVolverModal() {
    if (!state.items.length) {
      window.location.hash = '#pos';
      return;
    }
    const overlay    = ge('cv2-volver-overlay');
    const summaryEl  = ge('cv2-volver-summary');
    if (summaryEl) {
      const n = state.items.length;
      summaryEl.textContent = `${n} ${n === 1 ? 'artículo' : 'artículos'} — ${fmt$(calcTotal())}`;
    }
    if (overlay) overlay.style.display = 'flex';
  }

  function hideVolverModal() {
    const overlay = ge('cv2-volver-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // ── Confirm ──────────────────────────────────────────────────────────────────
  function confirmar() {
    if (!state.proveedorId)   { alert('Seleccioná un proveedor'); ge('cv2-prov-search')?.focus(); return; }
    if (!state.items.length)  { alert('Agregá al menos un producto'); ge('cv2-search')?.focus();   return; }

    const total         = calcTotal();
    const saldoAplicado = calcSaldoAplicado();
    const neto          = calcNeto();
    const user          = state.currentUser;
    const ts            = nowISO();
    const compraId      = uuid();
    const sesion        = getSesionActiva(user.sucursal_id);

    try {
      db().beginBatch();

      // 1. Compra record
      db().run(`
        INSERT INTO compras
          (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura,
           total, condicion_pago, estado, sync_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmada', 'pending', ?)
      `, [compraId, user.sucursal_id, state.proveedorId, user.id,
          state.fecha, state.numeroFactura || null,
          neto, state.condicionPago, ts]);

      // 2. Items: compra_items + stock + cost update
      for (const item of state.items) {
        const cant    = parseFloat(item.cantidad)   || 0;
        const udsPaq  = parseFloat(item.udsPaquete) || 1;
        const cantUds = cant * udsPaq;
        const costoNvo = parseFloat(item.costoNuevo) || parseFloat(item.costoActual) || 0;
        const costoAnt = parseFloat(item.costoActual) || 0;
        const subtotal = cant * udsPaq * costoNvo;

        db().run(`
          INSERT INTO compra_items
            (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior,
             subtotal, costo_modificado, unidad_compra, unidades_por_paquete)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [uuid(), compraId, item.productoId,
            cant, costoNvo, costoAnt, subtotal,
            Math.abs(costoNvo - costoAnt) > 0.001 ? 1 : 0,
            item.unidadCompra || 'Unidad', udsPaq]);

        // Stock: increment by total units
        const stockRow = db().query(
          `SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?`,
          [item.productoId, user.sucursal_id]
        )[0];

        if (stockRow) {
          db().run(
            `UPDATE stock SET cantidad=cantidad+?, fecha_modificacion=?, sync_status='pending', updated_at=?
             WHERE producto_id=? AND sucursal_id=?`,
            [cantUds, ts, ts, item.productoId, user.sucursal_id]
          );
        } else {
          db().run(
            `INSERT INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?)`,
            [item.productoId, user.sucursal_id, cantUds, ts, ts]
          );
        }

        // Cost update (if changed)
        if (costoNvo > 0 && Math.abs(costoNvo - costoAnt) > 0.001) {
          db().run(
            `UPDATE productos SET costo=?, costo_paquete=?, sync_status='pending', updated_at=? WHERE id=?`,
            [costoNvo, costoNvo * udsPaq, ts, item.productoId]
          );
        }
      }

      // 3. Payment
      if (state.condicionPago === 'efectivo' && sesion) {
        const factRef = state.facturaPv && state.numeroFactura
          ? `${state.facturaPv}-${state.numeroFactura}`
          : (state.numeroFactura || state.facturaPv || '');
        const desc = `Compra${factRef ? ' Fact. ' + factRef : ''} — ${state.proveedorNombre}`;
        db().run(`
          INSERT INTO egresos_caja
            (id, sesion_caja_id, monto, descripcion, tipo, fecha, usuario_id, sync_status, updated_at)
          VALUES (?, ?, ?, ?, 'pago_proveedor', ?, ?, 'pending', ?)
        `, [uuid(), sesion.id, neto, desc, ts, user.id, ts]);

        db().run(
          `UPDATE sesiones_caja SET total_egresos=COALESCE(total_egresos,0)+?, sync_status='pending', updated_at=? WHERE id=?`,
          [neto, ts, sesion.id]
        );
      } else if (state.condicionPago === 'pendiente') {
        db().run(`
          INSERT INTO cuenta_proveedor
            (id, proveedor_id, compra_id, tipo, monto, descripcion, fecha, usuario_id, sync_status, updated_at)
          VALUES (?, ?, ?, 'deuda', ?, ?, ?, ?, 'pending', ?)
        `, [uuid(), state.proveedorId, compraId, neto,
            `Compra ${(state.facturaPv && state.numeroFactura ? state.facturaPv + '-' + state.numeroFactura : state.numeroFactura || compraId.slice(-6).toUpperCase())}`,
            ts, user.id, ts]);
      }

      // 4. Saldo a favor aplicado → register as pago in cuenta_proveedor
      if (saldoAplicado > 0.01) {
        db().run(`
          INSERT INTO cuenta_proveedor
            (id, proveedor_id, compra_id, tipo, monto, descripcion, fecha, usuario_id, sync_status, updated_at)
          VALUES (?, ?, ?, 'pago', ?, ?, ?, ?, 'pending', ?)
        `, [uuid(), state.proveedorId, compraId, saldoAplicado,
            `Saldo aplicado — Compra ${state.numeroFactura || compraId.slice(-6).toUpperCase()}`,
            ts, user.id, ts]);
      }

      // 5. Clean up pausada if resuming
      if (state.pausadaId) {
        db().run(`DELETE FROM compras_pausadas WHERE id=?`, [state.pausadaId]);
      }

      db().commitBatch();

      showSuccessScreen({ compraId, total, neto, saldoAplicado, sesion });

    } catch (e) {
      db().rollbackBatch();
      console.error('Error confirming compra:', e);
      alert('Error al confirmar la compra: ' + e.message);
    }
  }

  // ── Post-compra screen ───────────────────────────────────────────────────────
  function showSuccessScreen({ total, neto, saldoAplicado, sesion }) {
    const root = ge('cv2-root');
    if (!root) return;

    // Enrich items with current precio_venta from DB
    const items = state.items.map(it => {
      const row = db().query(
        `SELECT precio_venta FROM productos WHERE id = ?`, [it.productoId]
      )[0];
      const costoAnt  = parseFloat(it.costoActual) || 0;
      const costoNvo  = parseFloat(it.costoNuevo) || costoAnt;
      const pvActual  = parseFloat(row?.precio_venta) || 0;
      const cant      = parseFloat(it.cantidad) || 0;
      const udsPaq    = parseFloat(it.udsPaquete) || 1;
      const cantUds   = cant * udsPaq;
      const varPct    = costoAnt > 0.001
        ? ((costoNvo / costoAnt) - 1)
        : (costoNvo > 0 ? 1 : 0);
      const pvSugerido = pvActual > 0
        ? pvActual * (1 + varPct)
        : costoNvo * 1.3;
      return { ...it, costoAnt, costoNvo, pvActual, cantUds, varPct, pvSugerido };
    });

    const totalArticulos = items.length;
    const totalUds       = items.reduce((s, it) => s + it.cantUds, 0);
    const facturaStr     = state.facturaPv && state.numeroFactura
      ? `${state.facturaPv}-${state.numeroFactura}`
      : (state.numeroFactura || state.facturaPv || '—');
    const condStr        = state.condicionPago === 'efectivo' ? 'Contado' : 'Cta. Cte.';
    const verifyMismatch = state.totalFactura > 0.001 && Math.abs(state.totalFactura - neto) > 0.01;

    // Format date dd/mm/yyyy
    const fechaFmt = (() => {
      const [y, m, d] = state.fecha.split('-');
      return d && m && y ? `${d}/${m}/${y}` : state.fecha;
    })();

    const rowsHtml = items.map((it, i) => {
      const varAbs     = Math.abs(it.varPct * 100);
      const varSign    = it.varPct > 0.001 ? '+' : it.varPct < -0.001 ? '' : '';
      const varClass   = it.varPct > 0.001
        ? 'cv2-post-var-up'
        : it.varPct < -0.001 ? 'cv2-post-var-down' : 'cv2-post-var-zero';
      const varIcon    = it.varPct > 0.001 ? '▲' : it.varPct < -0.001 ? '▼' : '';
      const varText    = Math.abs(it.varPct) < 0.0001
        ? '[0.0%]'
        : `[${varIcon}${varSign}${(it.varPct * 100).toFixed(1)}%]`;
      const pvSugFmt   = it.pvSugerido.toFixed(2);

      return `
        <tr class="cv2-post-tr" data-idx="${i}">
          <td class="cv2-post-td-num">${i + 1}</td>
          <td class="cv2-post-td-cod">${esc(it.barcode || '—')}</td>
          <td class="cv2-post-td-nombre">${esc(it.nombre)}</td>
          <td class="cv2-post-td-cant c">[${it.cantUds}]</td>
          <td class="cv2-post-costo-ant r">${fmt$(it.costoAnt)}</td>
          <td class="cv2-post-costo-nuevo r">${fmt$(it.costoNvo)}</td>
          <td class="c"><span class="${varClass}">${varText}</span></td>
          <td class="cv2-post-pv-actual r">${fmt$(it.pvActual)}</td>
          <td>
            <div class="cv2-post-precio-input-wrap">
              <input type="number" class="cv2-post-precio-input" data-idx="${i}"
                     data-sugerido="${pvSugFmt}" value="${pvSugFmt}" step="0.01" min="0">
              <button class="cv2-post-recalc-btn" data-idx="${i}" title="Recalcular precio sugerido">&#x21bb;</button>
            </div>
          </td>
          <td>
            <button class="cv2-post-save-btn" data-idx="${i}" data-prodid="${esc(it.productoId)}">
              ✓ Guardar Precio
            </button>
          </td>
        </tr>`;
    }).join('');

    root.innerHTML = `
      <div class="cv2-post-root">

        <!-- Header -->
        <div class="cv2-post-header">
          <div>
            <div class="cv2-post-header-title">Compras — Ingreso Confirmado</div>
            <div class="cv2-post-header-sub">Resumen Post-Compra</div>
          </div>
        </div>

        <!-- Form bar: purchase summary -->
        <div class="cv2-post-form-bar">
          <div class="cv2-post-fb-field">
            <div class="cv2-post-fb-label">Proveedor</div>
            <div class="cv2-post-fb-value">${esc(state.proveedorNombre)}</div>
          </div>
          <div class="cv2-post-fb-field">
            <div class="cv2-post-fb-label">Nro. Factura</div>
            <div class="cv2-post-fb-value">${esc(facturaStr)}</div>
          </div>
          <div class="cv2-post-fb-field">
            <div class="cv2-post-fb-label">Fecha Emisión</div>
            <div class="cv2-post-fb-value">${esc(fechaFmt)}</div>
          </div>
          <div class="cv2-post-fb-field">
            <div class="cv2-post-fb-label">Condición de Pago</div>
            <div class="${state.condicionPago === 'efectivo' ? 'cv2-post-chip-contado' : 'cv2-post-chip-cc'}">${esc(condStr)}</div>
          </div>
          <div class="cv2-post-total-block">
            <div class="cv2-post-total-label">Total Compra: <span class="cv2-post-total-amount">${fmt$(neto)}</span></div>
            <div class="${verifyMismatch ? 'cv2-post-verify-warn' : 'cv2-post-verify-ok'}">
              ${verifyMismatch
                ? '⚠ Advertencia: Total no coincide con Factura (Control)'
                : '✓ Ingreso verificado: Coincide con Total Factura (Control)'}
            </div>
            ${state.condicionPago === 'efectivo' && !sesion
              ? `<div class="cv2-post-verify-warn">⚠ Sin sesión de caja abierta — egreso no registrado</div>`
              : ''}
          </div>
        </div>

        <!-- Impact banner -->
        <div class="cv2-post-banner">
          <span class="cv2-post-banner-icon">↻</span>
          <span>
            <strong>RESUMEN DE INGRESO DE STOCK:</strong>
            Se procesaron <strong>${totalArticulos}</strong> artículos distintos,
            sumando <strong>${totalUds} unidades totales</strong> al stock.
          </span>
        </div>

        <!-- Table -->
        <div class="cv2-post-table-section">
          <div class="cv2-post-table-title">Listado de Productos con Cambios Aplicados</div>
          <table class="cv2-post-table">
            <thead>
              <tr>
                <th class="c">#</th>
                <th>Código</th>
                <th>Descripción</th>
                <th class="c">Cant. Ingresada</th>
                <th class="r">Costo Ant.</th>
                <th class="r">Costo Actual</th>
                <th class="c">Variación % Costo</th>
                <th class="r">Precio Venta Actual</th>
                <th class="r">NUEVO PRECIO Venta (Sugerido)</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody id="cv2-post-tbody">
              ${rowsHtml}
            </tbody>
          </table>
        </div>

        <!-- Footer -->
        <div class="cv2-post-footer">
          <button class="cv2-post-btn-save-all" id="cv2-post-btn-save-all">
            ✓ Guardar Todos los Precios
          </button>
          <button class="cv2-post-btn-finish" id="cv2-post-btn-finish">
            Finalizar · Ir al POS
          </button>
        </div>

      </div>
    `;

    // Wire up recalc buttons
    root.querySelectorAll('.cv2-post-recalc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx   = parseInt(btn.dataset.idx, 10);
        const input = root.querySelector(`.cv2-post-precio-input[data-idx="${idx}"]`);
        if (!input) return;
        input.value = parseFloat(input.dataset.sugerido).toFixed(2);
        input.classList.remove('modified');
      });
    });

    // Mark input as modified when user edits it
    root.querySelectorAll('.cv2-post-precio-input').forEach(input => {
      input.addEventListener('input', () => {
        const sugerido = parseFloat(input.dataset.sugerido).toFixed(2);
        input.classList.toggle('modified', input.value !== sugerido);
      });
    });

    // Per-row save
    function markRowSaved(idx) {
      const btn   = root.querySelector(`.cv2-post-save-btn[data-idx="${idx}"]`);
      const input = root.querySelector(`.cv2-post-precio-input[data-idx="${idx}"]`);
      if (btn)  { btn.textContent = '✓ Guardado'; btn.classList.add('saved'); btn.disabled = true; }
      if (input){ input.disabled = true; input.style.opacity = '0.6'; }
    }

    root.querySelectorAll('.cv2-post-save-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('saved')) return;
        const idx       = parseInt(btn.dataset.idx, 10);
        const prodId    = btn.dataset.prodid;
        const input     = root.querySelector(`.cv2-post-precio-input[data-idx="${idx}"]`);
        const nuevoPrecio = parseFloat(input?.value) || 0;
        if (nuevoPrecio <= 0) { alert('Precio inválido'); return; }
        // Get the enriched item to know the new cost
        const item = items[idx];
        const ts   = nowISO();
        try {
          db().run(
            `UPDATE productos SET precio_venta=?, sync_status='pending', updated_at=? WHERE id=?`,
            [nuevoPrecio, ts, prodId]
          );
        } catch (e) {
          alert('Error al guardar precio: ' + e.message);
          return;
        }
        // Check family
        const hasFam = checkHasFamily(prodId);
        if (hasFam) {
          showHerenciaModal({
            prodId,
            prodNombre:  item.nombre,
            nuevoCosto:  item.costoNvo,
            nuevoPrecio,
            onDone: () => markRowSaved(idx),
          });
        } else {
          markRowSaved(idx);
        }
      });
    });

    // Save all
    ge('cv2-post-btn-save-all')?.addEventListener('click', () => {
      root.querySelectorAll('.cv2-post-save-btn:not(.saved)').forEach(btn => btn.click());
    });

    // Finish
    ge('cv2-post-btn-finish')?.addEventListener('click', () => {
      window.location.hash = '#pos';
    });
  }

  // ── Family helpers ───────────────────────────────────────────────────────────
  function checkHasFamily(prodId) {
    const p = db().query(
      `SELECT es_madre, producto_madre_id FROM productos WHERE id=?`, [prodId]
    )[0];
    if (!p) return false;
    if (p.es_madre == 1) {
      // Has children?
      const cnt = db().query(`SELECT COUNT(*) AS n FROM productos WHERE producto_madre_id=?`, [prodId])[0]?.n || 0;
      return cnt > 0;
    }
    return !!p.producto_madre_id;
  }

  function showHerenciaModal({ prodId, prodNombre, nuevoCosto, nuevoPrecio, onDone }) {
    const thisProd = db().query(
      `SELECT es_madre, producto_madre_id FROM productos WHERE id=?`, [prodId]
    )[0];
    if (!thisProd) { onDone(); return; }

    const esMadre = thisProd.es_madre == 1;
    const madreId = esMadre ? prodId : thisProd.producto_madre_id;

    const madreProd = esMadre
      ? { id: prodId, nombre: prodNombre }
      : db().query(
          `SELECT p.id, p.nombre, p.costo AS costo_actual, p.precio_venta AS precio_actual,
                  COALESCE(s.cantidad, 0) AS stock_actual
           FROM productos p
           LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
           WHERE p.id = ?`,
          [state.currentUser.sucursal_id, madreId]
        )[0];

    const familiaNombre = madreProd?.nombre || 'Familia';

    // ── Build miembros list ──
    // When saved product is MADRE  → show only hijos, madre is implicit
    // When saved product is HIJO   → show MADRE first (es_lider=1), then all siblings
    let miembros = [];

    if (esMadre) {
      miembros = db().query(`
        SELECT p.id, p.nombre, p.costo AS costo_actual, p.precio_venta AS precio_actual,
               COALESCE(p.hereda_costo, 1) AS hereda_costo,
               COALESCE(p.hereda_precio, 1) AS hereda_precio,
               COALESCE(s.cantidad, 0) AS stock_actual,
               0 AS es_lider
        FROM productos p
        LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
        WHERE p.producto_madre_id = ?
        ORDER BY p.nombre
      `, [state.currentUser.sucursal_id, madreId]);
    } else {
      // Madre goes first, always checked (she has no hereda flags — she IS the source)
      const madreRow = {
        id:           madreProd.id,
        nombre:       madreProd.nombre,
        costo_actual: parseFloat(madreProd.costo_actual) || 0,
        precio_actual: parseFloat(madreProd.precio_actual) || 0,
        hereda_costo:  1,
        hereda_precio: 1,
        stock_actual:  parseFloat(madreProd.stock_actual) || 0,
        es_lider:      1,
      };
      const siblings = db().query(`
        SELECT p.id, p.nombre, p.costo AS costo_actual, p.precio_venta AS precio_actual,
               COALESCE(p.hereda_costo, 1) AS hereda_costo,
               COALESCE(p.hereda_precio, 1) AS hereda_precio,
               COALESCE(s.cantidad, 0) AS stock_actual,
               0 AS es_lider
        FROM productos p
        LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
        WHERE p.producto_madre_id = ? AND p.id != ?
        ORDER BY p.nombre
      `, [state.currentUser.sucursal_id, madreId, prodId]);
      miembros = [madreRow, ...siblings];
    }

    if (miembros.length === 0) { onDone(); return; }

    // ── Row renderer ──
    function buildRow(m, i) {
      const hc      = m.hereda_costo == 1;
      const hp      = m.hereda_precio == 1;
      const liderBadge = m.es_lider
        ? `<span class="cv2-her-badge-lider">👑 MADRE</span> `
        : '';
      return `
        <tr data-mid="${esc(m.id)}" ${m.es_lider ? 'class="cv2-her-row-lider"' : ''}>
          <td class="cv2-her-td-num c">${i + 1}</td>
          <td class="cv2-her-td-nombre">${liderBadge}${esc(m.nombre)}</td>
          <td class="cv2-her-td-stock c">[${m.stock_actual}]</td>
          <td class="cv2-her-td-readonly r">${fmt$(m.costo_actual)}</td>
          <td class="c">
            <input type="checkbox" class="cv2-her-chk cv2-her-chk-costo"
                   data-mid="${esc(m.id)}" ${hc ? 'checked' : ''}>
          </td>
          <td class="cv2-her-td-readonly r">${fmt$(m.precio_actual)}</td>
          <td class="c">
            <input type="checkbox" class="cv2-her-chk cv2-her-chk-precio"
                   data-mid="${esc(m.id)}" ${hp ? 'checked' : ''}>
          </td>
          <td class="c">
            <span class="cv2-her-val cv2-her-nuevo-costo ${hc ? '' : 'unchanged'}">
              ${hc ? fmt$(nuevoCosto) : fmt$(m.costo_actual)}
            </span>
          </td>
          <td class="c">
            <span class="cv2-her-val cv2-her-nuevo-precio ${hp ? '' : 'unchanged'}">
              ${hp ? fmt$(nuevoPrecio) : fmt$(m.precio_actual)}
            </span>
          </td>
          <td>
            <button class="cv2-her-btn-sinc" data-mid="${esc(m.id)}">✓ Sincronizar</button>
          </td>
        </tr>`;
    }

    const rowsHtml = miembros.map((m, i) => buildRow(m, i)).join('');

    // ── Overlay HTML ──
    const overlay = document.createElement('div');
    overlay.className = 'cv2-her-overlay';
    overlay.innerHTML = `
      <div class="cv2-her-box">
        <div class="cv2-her-header">
          <span class="cv2-her-header-icon">👪</span>
          <span class="cv2-her-header-title">Gestión de Herencia por Familia: ${esc(familiaNombre)}</span>
        </div>
        <div class="cv2-her-warn">
          ⚠️ El producto <strong>'${esc(prodNombre)}'</strong> que acabas de modificar pertenece a una familia.
          ¿Deseas sincronizar los costos y precios de los miembros?
        </div>
        <div class="cv2-her-sync-all-wrap">
          <button class="cv2-her-btn-sync-all">✓ SINCRONIZAR TODA LA FAMILIA</button>
        </div>
        <div class="cv2-her-table-wrap">
          <table class="cv2-her-table">
            <thead>
              <tr>
                <th class="c">#</th>
                <th>Descripción</th>
                <th class="c">Stock Actual</th>
                <th class="r">Costo Actual<br><small style="font-weight:400;text-transform:none">(Read-only)</small></th>
                <th class="c">Heredar<br>Costo?</th>
                <th class="r">Precio Actual<br><small style="font-weight:400;text-transform:none">(Read-only)</small></th>
                <th class="c">Heredar<br>Precio?</th>
                <th class="c">Nuevo<br>Costo</th>
                <th class="c">Nuevo<br>Precio</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody id="cv2-her-tbody">${rowsHtml}</tbody>
          </table>
        </div>
        <div class="cv2-her-footer">
          <div class="cv2-her-summary">
            <span>Miembros Sincronizados: <span class="cv2-her-summary-val" id="cv2-her-cnt">0</span></span>
            <span>Ganancia por Revalorización de Stock:
              <span class="cv2-her-summary-val cv2-her-summary-ganancia" id="cv2-her-gan">${fmt$(0)}</span>
            </span>
          </div>
          <div class="cv2-her-footer-actions">
            <button class="cv2-her-btn-cancel">cancel</button>
            <button class="cv2-her-btn-apply">✓ FINALIZAR Y APLICAR CAMBIOS</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // ── Helpers ──
    function getMiembroData(mid) {
      return miembros.find(m => m.id === mid);
    }

    function recalcSummary() {
      let cnt = 0, gan = 0;
      overlay.querySelectorAll('#cv2-her-tbody tr').forEach(tr => {
        const mid = tr.dataset.mid;
        const m   = getMiembroData(mid);
        if (!m) return;
        const hc  = tr.querySelector('.cv2-her-chk-costo')?.checked;
        const hp  = tr.querySelector('.cv2-her-chk-precio')?.checked;
        if (hc || hp) cnt++;
        if (hc) gan += (nuevoCosto - m.costo_actual) * m.stock_actual;
        const ncEl = tr.querySelector('.cv2-her-nuevo-costo');
        const npEl = tr.querySelector('.cv2-her-nuevo-precio');
        if (ncEl) { ncEl.textContent = hc ? fmt$(nuevoCosto) : fmt$(m.costo_actual); ncEl.classList.toggle('unchanged', !hc); }
        if (npEl) { npEl.textContent = hp ? fmt$(nuevoPrecio) : fmt$(m.precio_actual); npEl.classList.toggle('unchanged', !hp); }
      });
      const cntEl = overlay.querySelector('#cv2-her-cnt');
      const ganEl = overlay.querySelector('#cv2-her-gan');
      if (cntEl) cntEl.textContent = cnt;
      if (ganEl) { ganEl.textContent = (gan >= 0 ? '+' : '') + fmt$(gan); ganEl.style.color = gan >= 0 ? '#2e7d32' : '#c62828'; }
    }

    function sincRow(tr) {
      const mid = tr.dataset.mid;
      const m   = getMiembroData(mid);
      if (!m) return;
      const hc  = tr.querySelector('.cv2-her-chk-costo')?.checked;
      const hp  = tr.querySelector('.cv2-her-chk-precio')?.checked;
      const ts  = nowISO();
      const fields = [], vals = [];
      if (hc) { fields.push('costo=?', 'costo_paquete=?'); vals.push(nuevoCosto, nuevoCosto); }
      if (hp) { fields.push('precio_venta=?'); vals.push(nuevoPrecio); }
      if (!fields.length) return;
      fields.push("sync_status='pending'", 'updated_at=?');
      vals.push(ts, m.id);
      db().run(`UPDATE productos SET ${fields.join(',')} WHERE id=?`, vals);
      const sincBtn = tr.querySelector('.cv2-her-btn-sinc');
      if (sincBtn) { sincBtn.textContent = '✓ Sincronizado'; sincBtn.classList.add('sinc-done'); sincBtn.disabled = true; }
    }

    // Init
    recalcSummary();

    overlay.querySelectorAll('.cv2-her-chk').forEach(chk => {
      chk.addEventListener('change', recalcSummary);
    });

    overlay.querySelector('.cv2-her-btn-sync-all')?.addEventListener('click', () => {
      overlay.querySelectorAll('.cv2-her-chk').forEach(chk => { chk.checked = true; });
      recalcSummary();
    });

    overlay.querySelectorAll('.cv2-her-btn-sinc').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('sinc-done')) return;
        try { sincRow(btn.closest('tr')); } catch (e) { alert('Error: ' + e.message); }
        recalcSummary();
      });
    });

    overlay.querySelector('.cv2-her-btn-apply')?.addEventListener('click', () => {
      overlay.querySelectorAll('#cv2-her-tbody tr').forEach(tr => {
        if (!tr.querySelector('.cv2-her-btn-sinc')?.classList.contains('sinc-done')) {
          try { sincRow(tr); } catch (e) { /* skip */ }
        }
      });
      overlay.remove();
      onDone();
    });

    overlay.querySelector('.cv2-her-btn-cancel')?.addEventListener('click', () => {
      overlay.remove();
      onDone();
    });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  let _docKeydown = null;

  function setupKeyboard() {
    _docKeydown = e => {
      const active = document.activeElement;
      const tag    = active?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.key === 'Escape') {
        if (state.searchResults.length > 0) { e.preventDefault(); clearSearch(); return; }
        if (state.provResults.length > 0) {
          state.provResults = [];
          state.provHighlight = -1;
          renderProvDropdown();
          return;
        }
        return;
      }

      // Don't steal focus from provider search, factura, fecha, total, or cart row inputs
      if (['cv2-prov-search','cv2-factura-pv','cv2-factura','cv2-fecha','cv2-fecha-vencimiento','cv2-total-factura'].includes(active?.id)) return;
      if (isInput && active?.closest?.('.cv2-cart-row')) return;

      // Redirect printable characters to scan input
      if (!isInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        ge('cv2-search')?.focus();
      }
    };
    document.addEventListener('keydown', _docKeydown);
  }

  function teardownKeyboard() {
    if (_docKeydown) { document.removeEventListener('keydown', _docKeydown); _docKeydown = null; }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    teardownKeyboard();

    state.currentUser  = window.SGA_Auth.getCurrentUser();
    state.sesionActiva = getSesionActiva(state.currentUser.sucursal_id);
    state.proveedorId      = null;
    state.proveedorNombre  = null;
    state.proveedorSaldo   = 0;
    state.aplicarSaldo     = false;
    state.condicionPago    = 'efectivo';
    state.facturaPv        = '';
    state.numeroFactura    = '';
    state.fecha            = todayDate();
    state.fechaVencimiento = '';
    state.totalFactura     = 0;
    state.items            = [];
    state.pausadaId        = null;
    state.searchResults    = [];
    state.searchHighlight  = -1;
    state.searchQuerySaved = '';
    state.provResults      = [];
    state.provHighlight    = -1;

    // Set date default
    const fechaInp = ge('cv2-fecha');
    if (fechaInp) fechaInp.value = todayDate();

    // ── Payment chip toggle ──
    document.querySelectorAll('input[name="cv2-pago"]').forEach(radio => {
      radio.addEventListener('change', e => {
        if (!e.target.checked) return;
        state.condicionPago = e.target.value;

        ge('cv2-chip-efectivo') ?.classList.toggle('cv2-chip-active', state.condicionPago === 'efectivo');
        ge('cv2-chip-pendiente')?.classList.toggle('cv2-chip-active', state.condicionPago === 'pendiente');

        renderEfectivoInfo();
        renderTotals();
      });
    });

    // Chip label clicks toggle the radio
    ge('cv2-chip-efectivo') ?.addEventListener('click', () => {
      const r = ge('cv2-radio-efectivo'); if (r) r.click();
    });
    ge('cv2-chip-pendiente')?.addEventListener('click', () => {
      const r = ge('cv2-radio-pendiente'); if (r) r.click();
    });

    // ── Factura / Fecha / Total ──
    ge('cv2-factura-pv')        ?.addEventListener('input', e => { state.facturaPv = e.target.value; });
    ge('cv2-factura')           ?.addEventListener('input', e => { state.numeroFactura = e.target.value; });
    ge('cv2-fecha')             ?.addEventListener('input', e => { state.fecha = e.target.value; });
    ge('cv2-fecha-vencimiento') ?.addEventListener('input', e => { state.fechaVencimiento = e.target.value; });

    // Total factura: format as ARS currency on blur, raw on focus
    const tfInp = ge('cv2-total-factura');
    if (tfInp) {
      tfInp.addEventListener('focus', () => {
        if (state.totalFactura > 0) tfInp.value = String(state.totalFactura).replace('.', ',');
        else tfInp.value = '';
        tfInp.select();
      });
      tfInp.addEventListener('blur', () => {
        const raw = parseARS(tfInp.value);
        state.totalFactura = raw;
        tfInp.value = raw > 0 ? formatARS(raw) : '';
        updateConfirmBtn();
      });
      // Strip anything that's not a digit, comma or period while typing
      tfInp.addEventListener('input', () => {
        tfInp.value = tfInp.value.replace(/[^\d,.]/g, '');
      });
    }

    // ── Product search ──
    const searchInp = ge('cv2-search');
    if (searchInp) {
      searchInp.addEventListener('input', e => {
        const q = e.target.value;
        state.searchQuerySaved  = q;           // track typed value for arrow-nav restore
        state.searchHighlight   = -1;          // reset highlight on new input
        if (!q.trim()) { state.searchResults = []; renderSearchDropdown(); return; }
        state.searchResults = searchProductos(q);
        renderSearchDropdown();
      });

      searchInp.addEventListener('keydown', e => {
        const results = state.searchResults;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!results.length) return;
          state.searchHighlight = Math.min(state.searchHighlight + 1, results.length - 1);
          scrollHighlight('cv2-dropdown', state.searchHighlight);
          searchInp.value = results[state.searchHighlight]?.nombre ?? state.searchQuerySaved;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!results.length) return;
          state.searchHighlight = Math.max(state.searchHighlight - 1, -1);
          scrollHighlight('cv2-dropdown', state.searchHighlight);
          searchInp.value = state.searchHighlight >= 0
            ? (results[state.searchHighlight]?.nombre ?? state.searchQuerySaved)
            : state.searchQuerySaved;
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const val = searchInp.value.trim();
          if (state.searchHighlight >= 0 && results[state.searchHighlight]) {
            selectSearchResult(state.searchHighlight);
          } else if (results.length === 1) {
            selectSearchResult(0);
          } else if (results.length === 0 && val.length > 0) {
            showNewProductForm(val);
            clearSearch();
          }
        } else if (e.key === 'Escape') {
          clearSearch();
        }
      });
    }

    ge('cv2-dropdown')?.addEventListener('click', e => {
      const item = e.target.closest('.cv2-dd-item');
      if (!item) return;
      if (item.dataset.action === 'nuevo') {
        showNewProductForm(ge('cv2-search')?.value.trim() || '');
        clearSearch();
        return;
      }
      const idx = parseInt(item.dataset.i);
      if (!isNaN(idx)) selectSearchResult(idx);
    });

    // ── Cart events (delegated) ──
    const cartBody = ge('cv2-cart-body');
    if (cartBody) {
      cartBody.addEventListener('change', e => {
        const inp = e.target.closest('input.cv2-num-input');
        if (!inp) return;
        const idx   = parseInt(inp.dataset.idx);
        const field = inp.dataset.field;
        if (!isNaN(idx) && field) updateItem(idx, field, inp.value);
      });

      cartBody.addEventListener('keydown', e => {
        const inp = e.target.closest('input.cv2-num-input');
        if (!inp) return;

        const field = inp.dataset.field;
        const idx   = parseInt(inp.dataset.idx);

        // Numeric-only filter for cantidad, costoNuevo, descuento, descuentoMonto
        if (['cantidad','costoNuevo','descuento','descuentoMonto'].includes(field)) {
          const allow = ['Backspace','Delete','Tab','Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','.'];
          if (!allow.includes(e.key) && !/^\d$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
          }
        }

        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();          // prevent _docKeydown from also firing
          updateItem(idx, field, inp.value);

          if (field === 'cantidad' && state.items[idx]) {
            // Jump to costoNuevo of the same row
            const costoInp = document.querySelector(
              `.cv2-cart-row[data-idx="${idx}"] input[data-field="costoNuevo"]`
            );
            if (costoInp) { costoInp.select(); costoInp.focus(); return; }
          }
          // costoNuevo, udsPaquete, or item removed → back to search
          ge('cv2-search')?.focus();
        }
      });

      cartBody.addEventListener('click', e => {
        const btn = e.target.closest('.cv2-remove-btn');
        if (btn) { const idx = parseInt(btn.dataset.idx); if (!isNaN(idx)) removeItem(idx); }
      });
    }

    // ── Proveedor search ──
    const provInp = ge('cv2-prov-search');
    if (provInp) {
      provInp.addEventListener('input', e => {
        const q = e.target.value;
        if (!q.trim()) { state.provResults = []; renderProvDropdown(); return; }
        state.provResults   = searchProveedores(q);
        state.provHighlight = state.provResults.length > 0 ? 0 : -1;
        renderProvDropdown();
      });

      provInp.addEventListener('keydown', e => {
        const results = state.provResults;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!results.length) return;
          state.provHighlight = Math.min(state.provHighlight + 1, results.length - 1);
          scrollHighlight('cv2-prov-dropdown', state.provHighlight);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!results.length) return;
          state.provHighlight = Math.max(state.provHighlight - 1, -1);
          scrollHighlight('cv2-prov-dropdown', state.provHighlight);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (state.provHighlight >= 0 && results[state.provHighlight]) {
            selectProveedor(results[state.provHighlight]);
          } else if (results.length === 1) {
            selectProveedor(results[0]);
          }
        } else if (e.key === 'Escape') {
          state.provResults = []; renderProvDropdown();
        }
      });
    }

    ge('cv2-prov-dropdown')?.addEventListener('click', e => {
      const item = e.target.closest('.cv2-dd-item');
      if (!item) return;
      const idx = parseInt(item.dataset.i);
      if (!isNaN(idx) && state.provResults[idx]) selectProveedor(state.provResults[idx]);
    });

    ge('cv2-prov-clear')?.addEventListener('click', clearProveedor);

    // ── Action buttons ──
    ge('cv2-btn-volver')   ?.addEventListener('click', showVolverModal);
    ge('cv2-btn-pausar')   ?.addEventListener('click', pausar);
    ge('cv2-btn-confirmar')?.addEventListener('click', confirmar);
    ge('cv2-btn-pausadas') ?.addEventListener('click', showPausadasOverlay);

    // ── Volver modal options ──
    ge('cv2-volver-pausar')?.addEventListener('click', () => {
      hideVolverModal();
      if (pausar()) window.location.hash = '#pos';
    });
    ge('cv2-volver-descartar')?.addEventListener('click', () => {
      window.location.hash = '#pos';
    });
    ge('cv2-volver-seguir')?.addEventListener('click', hideVolverModal);
    ge('cv2-volver-overlay')?.addEventListener('click', e => {
      if (e.target === ge('cv2-volver-overlay')) hideVolverModal();
    });

    ge('cv2-pausadas-close')?.addEventListener('click', () => {
      ge('cv2-pausadas-overlay').style.display = 'none';
    });

    ge('cv2-pausadas-overlay')?.addEventListener('click', e => {
      if (e.target === ge('cv2-pausadas-overlay')) {
        ge('cv2-pausadas-overlay').style.display = 'none';
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'resume') resumir(btn.dataset.id);
      else if (btn.dataset.action === 'delete') deletePausada(btn.dataset.id);
    });

    // ── Initial render ──
    setupKeyboard();
    renderCart();
    renderProveedorPanel();
    renderEfectivoInfo();
    updateConfirmBtn();
    updatePausadasBtn();

    ge('cv2-search')?.focus();
  }

  return { init };
})();

export default ComprasV2;
