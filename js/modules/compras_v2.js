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

  // ── State ────────────────────────────────────────────────────────────────────
  const state = {
    proveedorId:        null,
    proveedorNombre:    null,
    proveedorSaldo:     0,      // positive = nosotros le debemos | negative = nos deben
    aplicarSaldo:       false,
    condicionPago:      'efectivo',
    numeroFactura:      '',
    fecha:              todayDate(),
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
  // subtotal = cant × uds_por_paquete × costo_por_unidad
  function itemSubtotal(item) {
    return (parseFloat(item.cantidad)   || 0)
         * (parseFloat(item.udsPaquete) || 1)
         * (parseFloat(item.costoNuevo) || parseFloat(item.costoActual) || 0);
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
          <td class="cv2-cart-nombre" title="${esc(it.nombre)}">
            ${esc(it.nombre)}
            ${costoChanged ? `<span class="cv2-costo-changed" title="Costo modificado">↑</span>` : ''}
          </td>
          <td>
            <input type="number" class="cv2-num-input" value="${it.cantidad}"
                   min="0.001" step="any" style="width:62px"
                   data-idx="${i}" data-field="cantidad">
          </td>
          <td>
            <input type="number" class="cv2-num-input" value="${it.udsPaquete}"
                   min="1" step="1" style="width:52px"
                   data-idx="${i}" data-field="udsPaquete"
                   title="${esc(it.unidadCompra)}">
          </td>
          <td class="cv2-td-right">
            <input type="number" class="cv2-num-input" value="${parseFloat(it.costoNuevo).toFixed(2)}"
                   min="0" step="any" style="width:80px"
                   data-idx="${i}" data-field="costoNuevo">
          </td>
          <td class="cv2-subtotal cv2-td-right">${fmt$(sub)}</td>
          <td>
            <button class="cv2-remove-btn" data-idx="${i}" title="Quitar">×</button>
          </td>
        </tr>
      `;
    }).join('');

    renderTotals();
  }

  function renderTotals() {
    const total         = calcTotal();
    const saldoAplicado = calcSaldoAplicado();
    const neto          = calcNeto();

    const countEl = ge('cv2-item-count');
    if (countEl) countEl.textContent = `${state.items.length} producto${state.items.length !== 1 ? 's' : ''}`;

    const totalEl = ge('cv2-total');
    if (totalEl) totalEl.textContent = fmt$(neto);

    const detalleEl = ge('cv2-total-detalle');
    if (detalleEl) {
      if (saldoAplicado > 0.01) {
        detalleEl.innerHTML =
          `<span class="cv2-total-bruto">Subtotal: ${fmt$(total)}</span>`
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
        productoId:   prod.productoId,
        nombre:       prod.nombre,
        unidadCompra: prod.unidadCompra,
        udsPaquete:   prod.udsPaquete,
        costoActual:  prod.costoActual,
        costoNuevo:   prod.costoNuevo,
        cantidad:     1,
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
    addToCart({ productoId: prodId, nombre, unidadCompra: unidad, udsPaquete: udsPaq, costoActual: costo, costoNuevo: costo });
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
      return;
    }

    const snapshot = JSON.stringify({
      proveedorId:    state.proveedorId,
      proveedorNombre: state.proveedorNombre,
      condicionPago:  state.condicionPago,
      numeroFactura:  state.numeroFactura,
      fecha:          state.fecha,
      items:          state.items,
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
      return;
    }

    window.SGA_Utils.showNotification('Compra pausada', 'success');
    resetToNew();
  }

  function resetToNew() {
    state.proveedorId     = null;
    state.proveedorNombre = null;
    state.proveedorSaldo  = 0;
    state.aplicarSaldo    = false;
    state.condicionPago   = 'efectivo';
    state.numeroFactura   = '';
    state.fecha           = todayDate();
    state.items           = [];
    state.pausadaId       = null;

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

    const facturaInp = ge('cv2-factura');
    if (facturaInp) facturaInp.value = '';
    const fechaInp = ge('cv2-fecha');
    if (fechaInp) fechaInp.value = todayDate();

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

    state.proveedorId     = snap.proveedorId     || null;
    state.proveedorNombre = snap.proveedorNombre || null;
    state.condicionPago   = snap.condicionPago   || 'efectivo';
    state.numeroFactura   = snap.numeroFactura   || '';
    state.fecha           = snap.fecha           || todayDate();
    state.items           = snap.items           || [];
    state.pausadaId       = pausadaId;

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
    const facturaInp = ge('cv2-factura');
    if (facturaInp) facturaInp.value = state.numeroFactura;
    const fechaInp = ge('cv2-fecha');
    if (fechaInp) fechaInp.value = state.fecha;

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
        const desc = `Compra${state.numeroFactura ? ' Fact. ' + state.numeroFactura : ''} — ${state.proveedorNombre}`;
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
            `Compra ${state.numeroFactura || compraId.slice(-6).toUpperCase()}`,
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

  // ── Success screen ───────────────────────────────────────────────────────────
  function showSuccessScreen({ total, neto, saldoAplicado, sesion }) {
    const costChanges = state.items.filter(
      it => Math.abs((parseFloat(it.costoNuevo) || 0) - (parseFloat(it.costoActual) || 0)) > 0.001
    );

    const root = ge('cv2-root');
    if (!root) return;

    root.innerHTML = `
      <div class="cv2-success">
        <div class="cv2-success-icon">✅</div>
        <h2>Compra registrada</h2>

        <div class="cv2-success-details">
          <div class="cv2-success-row"><span>Proveedor</span><strong>${esc(state.proveedorNombre)}</strong></div>
          ${state.numeroFactura
            ? `<div class="cv2-success-row"><span>Factura</span><strong>${esc(state.numeroFactura)}</strong></div>`
            : ''}
          <div class="cv2-success-row"><span>Fecha</span><strong>${esc(state.fecha)}</strong></div>
          <div class="cv2-success-row"><span>Productos</span><strong>${state.items.length}</strong></div>
          ${saldoAplicado > 0.01 ? `
            <div class="cv2-success-row"><span>Subtotal</span><strong>${fmt$(total)}</strong></div>
            <div class="cv2-success-row cv2-success-favor"><span>Saldo aplicado</span><strong>− ${fmt$(saldoAplicado)}</strong></div>
          ` : ''}
          <div class="cv2-success-row cv2-success-total">
            <span>Total</span><strong>${fmt$(neto)}</strong>
          </div>
          <div class="cv2-success-row">
            <span>Pago</span>
            <strong>${state.condicionPago === 'efectivo' ? '💵 Efectivo' : '📋 Pendiente'}</strong>
          </div>
          ${state.condicionPago === 'efectivo' && !sesion
            ? `<div style="padding:8px 16px"><div class="cv2-warning">⚠️ Sin sesión de caja abierta — egreso no registrado.</div></div>`
            : ''}
        </div>

        ${costChanges.length > 0 ? `
          <div class="cv2-success-costos">
            <div class="cv2-success-sub-title">Costos actualizados (${costChanges.length})</div>
            ${costChanges.map(it => `
              <div class="cv2-success-cost-row">
                <span>${esc(it.nombre)}</span>
                <span class="cv2-cost-old">${fmt$(it.costoActual)}</span>
                <span>→</span>
                <span class="cv2-cost-new">${fmt$(it.costoNuevo)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="cv2-success-actions">
          <button class="btn btn-success" id="cv2-btn-ok">OK</button>
        </div>
      </div>
    `;

    ge('cv2-btn-ok')?.addEventListener('click', () => { window.location.hash = '#pos'; });
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

      // Don't steal focus from provider search, factura, fecha, or cart row inputs
      if (active?.id === 'cv2-prov-search' || active?.id === 'cv2-factura' || active?.id === 'cv2-fecha') return;
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
    state.proveedorId  = null;
    state.proveedorNombre = null;
    state.proveedorSaldo  = 0;
    state.aplicarSaldo    = false;
    state.condicionPago   = 'efectivo';
    state.numeroFactura   = '';
    state.fecha           = todayDate();
    state.items           = [];
    state.pausadaId       = null;
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

    // ── Factura / Fecha ──
    ge('cv2-factura')?.addEventListener('input', e => { state.numeroFactura = e.target.value; });
    ge('cv2-fecha')  ?.addEventListener('input', e => { state.fecha = e.target.value; });

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

        // Numeric-only filter for cantidad and costoNuevo
        if (field === 'cantidad' || field === 'costoNuevo') {
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
    ge('cv2-btn-pausar')   ?.addEventListener('click', pausar);
    ge('cv2-btn-confirmar')?.addEventListener('click', confirmar);
    ge('cv2-btn-pausadas') ?.addEventListener('click', showPausadasOverlay);

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
