/**
 * ordenes.js — Purchase Orders Module
 *
 * Manages the full purchase order lifecycle:
 * crear → enviar → recibir → confirmar → pagar
 */

const Ordenes = (() => {
  'use strict';

  // ── CONSTANTS ──────────────────────────────────────────────────────────────

  const ESTADO_LABEL = {
    borrador:         'Borrador',
    enviada:          'Enviada',
    recibiendo:       'Recibiendo',
    recibida_parcial: 'Parcial',
    cerrada:          'Cerrada',
    pendiente_pago:   'Pago pendiente',
  };

  const ESTADO_BADGE = {
    borrador:         'ord-badge ord-badge-borrador',
    enviada:          'ord-badge ord-badge-enviada',
    recibiendo:       'ord-badge ord-badge-recibiendo',
    recibida_parcial: 'ord-badge ord-badge-recibida_parcial',
    cerrada:          'ord-badge ord-badge-cerrada',
    pendiente_pago:   'ord-badge ord-badge-pendiente_pago',
  };

  const ITEM_ESTADO_LABEL = {
    pendiente:        'Pendiente',
    recibido:         'Recibido',
    recibido_parcial: 'Parcial',
    no_entregado:     'No entregado',
  };

  // ── STATE ──────────────────────────────────────────────────────────────────

  const state = {
    user: null,
    currentTab: 'activas',
    view: 'lista',          // 'lista' | 'recepcion' | 'pagos'

    nuevaOrden: {
      active: false,
      step: 1,
      proveedorId: null,
      proveedorNombre: '',
      fechaEntrega: '',
      notas: '',
      items: [],            // [{productoId, nombre, cantidadPedida, costoUnitario}]
    },

    recepcion: {
      orden: null,          // full order with items
      costoChanges: [],
    },

    discrepancia: {
      active: false,
      codigo: '',
      productoSeleccionado: null,
      step: 'search',       // 'search' | 'options'
    },

    pago: {
      active: false,
      ordenId: null,
      proveedorNombre: '',
      total: 0,
      pagado: 0,
      modo: 'pendiente',    // 'efectivo' | 'pendiente'
      monto: 0,
    },

    costos: {
      active: false,
      changes: [],          // [{productoId, nombre, costoAnterior, costoNuevo, esMadre, ...}]
      ordenId: null,
    },
  };

  // ── HELPERS ────────────────────────────────────────────────────────────────

  const ge = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmtPeso = (n) =>
    '$' + (parseFloat(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const fmtFecha = (str) => {
    if (!str) return '—';
    const d = new Date(str);
    return d.toLocaleDateString('es-AR');
  };

  const uuid = () => window.SGA_Utils.generateUUID();
  const now  = () => window.SGA_Utils.formatISODate(new Date());

  function showToast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── DATA LAYER ─────────────────────────────────────────────────────────────

  function _getAll(sucursalId, estadoFilter) {
    const params = [];
    const where  = [];
    if (sucursalId) { where.push('o.sucursal_id = ?'); params.push(sucursalId); }
    if (estadoFilter === 'activas') {
      where.push(`o.estado IN ('borrador','enviada','recibiendo','recibida_parcial')`);
    } else if (estadoFilter === 'cerradas') {
      where.push(`o.estado IN ('cerrada','pendiente_pago')`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return window.SGA_DB.query(`
      SELECT o.*, p.razon_social AS proveedor_nombre,
        COUNT(oi.id) AS item_count,
        COALESCE(SUM(oi.cantidad_pedida * oi.costo_unitario), 0) AS total_estimado
      FROM ordenes_compra o
      LEFT JOIN proveedores p ON p.id = o.proveedor_id
      LEFT JOIN orden_compra_items oi ON oi.orden_id = o.id
      ${w}
      GROUP BY o.id
      ORDER BY o.fecha_creacion DESC
    `, params);
  }

  function _getById(id) {
    const orden = window.SGA_DB.query(`
      SELECT o.*, p.razon_social AS proveedor_nombre, p.telefono AS proveedor_tel
      FROM ordenes_compra o
      LEFT JOIN proveedores p ON p.id = o.proveedor_id
      WHERE o.id = ?
    `, [id])[0];
    if (!orden) return null;
    orden.items = window.SGA_DB.query(`
      SELECT oi.*, pr.nombre AS producto_nombre, pr.costo AS costo_actual,
        pr.producto_madre_id, pr.es_madre
      FROM orden_compra_items oi
      LEFT JOIN productos pr ON pr.id = oi.producto_id
      WHERE oi.orden_id = ?
      ORDER BY pr.nombre
    `, [id]);
    return orden;
  }

  function _crear(data) {
    const id = uuid();
    const ts = now();
    try {
      window.SGA_DB.beginBatch();
      window.SGA_DB.run(`
        INSERT INTO ordenes_compra
          (id,sucursal_id,proveedor_id,usuario_id,fecha_creacion,fecha_entrega,estado,notas,sync_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, data.sucursalId, data.proveedorId, data.usuarioId, ts,
          data.fechaEntrega || null, 'borrador', data.notas || null, 'pending', ts]);
      for (const item of data.items) {
        window.SGA_DB.run(`
          INSERT INTO orden_compra_items
            (id,orden_id,producto_id,cantidad_pedida,cantidad_recibida,costo_unitario,costo_anterior,estado)
          VALUES (?,?,?,?,0,?,0,'pendiente')`,
          [uuid(), id, item.productoId, item.cantidadPedida, parseFloat(item.costoUnitario) || 0]);
      }
      window.SGA_DB.commitBatch();
      return { success: true, ordenId: id };
    } catch (e) {
      window.SGA_DB.rollbackBatch();
      return { success: false, error: e.message };
    }
  }

  function _enviar(ordenId) {
    window.SGA_DB.run(
      `UPDATE ordenes_compra SET estado='enviada', updated_at=? WHERE id=?`,
      [now(), ordenId]
    );
  }

  function _iniciarRecepcion(ordenId) {
    window.SGA_DB.run(
      `UPDATE ordenes_compra SET estado='recibiendo', updated_at=? WHERE id=?`,
      [now(), ordenId]
    );
  }

  function _recibirItem(itemId, cantidadRecibida, costoUnitario) {
    const item = window.SGA_DB.query(
      `SELECT * FROM orden_compra_items WHERE id=?`, [itemId]
    )[0];
    if (!item) return;
    const cant  = parseFloat(cantidadRecibida) || 0;
    const costo = parseFloat(costoUnitario)    || 0;
    const est   = cant === 0 ? 'no_entregado'
                : cant >= parseFloat(item.cantidad_pedida) ? 'recibido'
                : 'recibido_parcial';
    window.SGA_DB.run(
      `UPDATE orden_compra_items
       SET cantidad_recibida=?, costo_unitario=?, costo_anterior=?, estado=?
       WHERE id=?`,
      [cant, costo, parseFloat(item.costo_actual || item.costo_unitario) || costo, est, itemId]
    );
  }

  function _confirmarRecepcion(ordenId, modo, montoEfectivo) {
    const orden   = _getById(ordenId);
    const user    = state.user;
    const ts      = now();
    const sucId   = user.sucursal_id;

    const sesion = window.SGA_DB.query(
      `SELECT id FROM sesiones_caja WHERE sucursal_id=? AND estado='abierta' LIMIT 1`,
      [sucId]
    )[0];

    let totalRecibido  = 0;
    const costoChanges = [];

    try {
      window.SGA_DB.beginBatch();

      for (const item of orden.items) {
        const cantR = parseFloat(item.cantidad_recibida) || 0;
        if (cantR <= 0 || item.estado === 'no_entregado') continue;

        // Update stock
        const existing = window.SGA_DB.query(
          `SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?`,
          [item.producto_id, sucId]
        )[0];
        if (existing) {
          window.SGA_DB.run(
            `UPDATE stock SET cantidad=cantidad+?, fecha_modificacion=? WHERE producto_id=? AND sucursal_id=?`,
            [cantR, ts, item.producto_id, sucId]
          );
        } else {
          window.SGA_DB.run(
            `INSERT INTO stock (producto_id,sucursal_id,cantidad,fecha_modificacion) VALUES (?,?,?,?)`,
            [item.producto_id, sucId, cantR, ts]
          );
        }

        const itemCosto   = parseFloat(item.costo_unitario)  || 0;
        const costoActual = parseFloat(item.costo_actual)     || 0;
        totalRecibido    += cantR * itemCosto;

        if (itemCosto > 0 && costoActual > 0 && Math.abs(costoActual - itemCosto) > 0.01) {
          costoChanges.push({
            productoId:       item.producto_id,
            nombre:           item.producto_nombre,
            costoAnterior:    costoActual,
            costoNuevo:       itemCosto,
            esMadre:          item.es_madre,
            productaMadreId:  item.producto_madre_id,
            actualizarCosto:  true,
            actualizarPrecio: false,
            aplicarFamilia:   false,
          });
        }
      }

      // Compra record
      const compraId = uuid();
      window.SGA_DB.run(`
        INSERT INTO compras (id,sucursal_id,proveedor_id,usuario_id,fecha,total,sync_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        [compraId, sucId, orden.proveedor_id, user.id, ts, totalRecibido, 'pending', ts]);

      for (const item of orden.items) {
        const cantR = parseFloat(item.cantidad_recibida) || 0;
        if (cantR <= 0) continue;
        window.SGA_DB.run(`
          INSERT INTO compra_items
            (id,compra_id,producto_id,cantidad,costo_unitario,costo_anterior,subtotal,costo_modificado)
          VALUES (?,?,?,?,?,?,?,?)`,
          [uuid(), compraId, item.producto_id, cantR,
            parseFloat(item.costo_unitario) || 0,
            parseFloat(item.costo_anterior) || 0,
            cantR * (parseFloat(item.costo_unitario) || 0),
            costoChanges.some(c => c.productoId === item.producto_id) ? 1 : 0]);
      }

      // Payment
      const monto = parseFloat(montoEfectivo) || totalRecibido;
      if (modo === 'efectivo' && sesion) {
        window.SGA_DB.run(`
          INSERT INTO egresos_caja
            (id,sesion_caja_id,monto,descripcion,tipo,fecha,usuario_id,sync_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          [uuid(), sesion.id, monto,
            `Pago proveedor — OC ${ordenId.slice(-6).toUpperCase()}`,
            'pago_proveedor', ts, user.id, 'pending', ts]);
      }

      const saldo = totalRecibido - (modo === 'efectivo' ? monto : 0);
      if (saldo > 0.01) {
        window.SGA_DB.run(`
          INSERT INTO cuenta_proveedor
            (id,proveedor_id,orden_id,tipo,monto,descripcion,fecha,usuario_id,sync_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [uuid(), orden.proveedor_id, ordenId, 'deuda', saldo,
            `Deuda OC ${ordenId.slice(-6).toUpperCase()}`, ts, user.id, 'pending', ts]);
        window.SGA_DB.run(
          `UPDATE ordenes_compra SET estado='pendiente_pago', updated_at=? WHERE id=?`,
          [ts, ordenId]
        );
      } else {
        window.SGA_DB.run(
          `UPDATE ordenes_compra SET estado='cerrada', updated_at=? WHERE id=?`,
          [ts, ordenId]
        );
      }

      window.SGA_DB.commitBatch();
      return { success: true, totalRecibido, costoChanges, compraId };
    } catch (e) {
      window.SGA_DB.rollbackBatch();
      return { success: false, error: e.message };
    }
  }

  function _registrarPago(ordenId, monto, usuarioId) {
    const ts = now();
    const user = state.user;
    const sucId = user.sucursal_id;

    const sesion = window.SGA_DB.query(
      `SELECT id FROM sesiones_caja WHERE sucursal_id=? AND estado='abierta' LIMIT 1`,
      [sucId]
    )[0];

    const orden = _getById(ordenId);
    if (!orden) return { success: false, error: 'Orden no encontrada' };

    try {
      window.SGA_DB.beginBatch();

      if (sesion) {
        window.SGA_DB.run(`
          INSERT INTO egresos_caja
            (id,sesion_caja_id,monto,descripcion,tipo,fecha,usuario_id,sync_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          [uuid(), sesion.id, parseFloat(monto),
            `Pago proveedor — OC ${ordenId.slice(-6).toUpperCase()}`,
            'pago_proveedor', ts, usuarioId, 'pending', ts]);
      }

      window.SGA_DB.run(`
        INSERT INTO cuenta_proveedor
          (id,proveedor_id,orden_id,tipo,monto,descripcion,fecha,usuario_id,sync_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), orden.proveedor_id, ordenId, 'pago', parseFloat(monto),
          `Pago OC ${ordenId.slice(-6).toUpperCase()}`, ts, usuarioId, 'pending', ts]);

      // Check if fully paid
      const deudaTotal = (window.SGA_DB.query(
        `SELECT COALESCE(SUM(CASE WHEN tipo='deuda' THEN monto ELSE -monto END),0) AS saldo
         FROM cuenta_proveedor WHERE orden_id=?`,
        [ordenId]
      )[0] || {}).saldo || 0;

      if (deudaTotal <= 0.01) {
        window.SGA_DB.run(
          `UPDATE ordenes_compra SET estado='cerrada', updated_at=? WHERE id=?`,
          [ts, ordenId]
        );
      }

      window.SGA_DB.commitBatch();
      return { success: true };
    } catch (e) {
      window.SGA_DB.rollbackBatch();
      return { success: false, error: e.message };
    }
  }

  function _getConPagoPendiente(sucursalId) {
    return window.SGA_DB.query(`
      SELECT o.*, p.razon_social AS proveedor_nombre,
        COALESCE(SUM(CASE WHEN cp.tipo='deuda' THEN cp.monto ELSE -cp.monto END),0) AS saldo_pendiente,
        COALESCE(SUM(CASE WHEN cp.tipo='pago' THEN cp.monto ELSE 0 END),0) AS total_pagado,
        MAX(o.updated_at) AS fecha_recepcion
      FROM ordenes_compra o
      LEFT JOIN proveedores p ON p.id = o.proveedor_id
      LEFT JOIN cuenta_proveedor cp ON cp.orden_id = o.id
      WHERE o.sucursal_id=? AND o.estado='pendiente_pago'
      GROUP BY o.id
      ORDER BY o.updated_at DESC
    `, [sucursalId]);
  }

  // Expose data layer
  window.SGA_Ordenes = {
    getAll:                  _getAll,
    getById:                 _getById,
    crear:                   _crear,
    enviar:                  _enviar,
    iniciarRecepcion:        _iniciarRecepcion,
    recibirItem:             _recibirItem,
    confirmarRecepcion:      _confirmarRecepcion,
    registrarPagoOrden:      _registrarPago,
    getOrdenesConPagoPendiente: _getConPagoPendiente,
  };

  // ── UI — LISTA ─────────────────────────────────────────────────────────────

  function renderLista() {
    const ordenes = _getAll(state.user.sucursal_id, state.currentTab);
    const tbody   = ge('ord-tbody');
    const empty   = ge('ord-empty');
    if (!tbody) return;

    if (!ordenes.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = ordenes.map(o => {
      const acciones = [];
      acciones.push(`<button class="btn btn-ghost" style="font-size:12px" data-action="ver" data-id="${esc(o.id)}">Ver</button>`);
      if (o.estado === 'enviada') {
        acciones.push(`<button class="btn btn-secondary" style="font-size:12px" data-action="recibir" data-id="${esc(o.id)}">📦 Recibir</button>`);
      }
      if (o.estado === 'recibiendo') {
        acciones.push(`<button class="btn btn-secondary" style="font-size:12px" data-action="recibir" data-id="${esc(o.id)}">📦 Continuar</button>`);
      }
      if (o.estado === 'pendiente_pago') {
        acciones.push(`<button class="btn btn-primary" style="font-size:12px" data-action="pagar" data-id="${esc(o.id)}">💰 Pagar</button>`);
      }
      if (o.estado === 'borrador') {
        acciones.push(`<button class="btn btn-secondary" style="font-size:12px" data-action="enviar" data-id="${esc(o.id)}">Enviar</button>`);
      }
      return `<tr>
        <td>${esc(fmtFecha(o.fecha_creacion))}</td>
        <td>${esc(o.proveedor_nombre || '—')}</td>
        <td>${esc(o.item_count || 0)}</td>
        <td>${esc(fmtPeso(o.total_estimado))}</td>
        <td><span class="${esc(ESTADO_BADGE[o.estado] || 'ord-badge ord-badge-borrador')}">${esc(ESTADO_LABEL[o.estado] || o.estado)}</span></td>
        <td style="white-space:nowrap">${acciones.join(' ')}</td>
      </tr>`;
    }).join('');

    // Pagos pendientes count
    const pending = _getConPagoPendiente(state.user.sucursal_id);
    const countEl = ge('ord-pagos-count');
    if (countEl) countEl.textContent = pending.length;
  }

  // ── UI — NUEVA ORDEN WIZARD ────────────────────────────────────────────────

  function openNuevaOrden() {
    state.nuevaOrden = { active: true, step: 1, proveedorId: null, proveedorNombre: '', fechaEntrega: '', notas: '', items: [] };
    const overlay = ge('ord-nueva-overlay');
    if (overlay) overlay.style.display = 'flex';
    renderNuevaOrdenStep();
  }

  function closeNuevaOrden() {
    state.nuevaOrden.active = false;
    const overlay = ge('ord-nueva-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function renderNuevaOrdenStep() {
    const n = state.nuevaOrden;
    renderStepsIndicator();
    const body   = ge('ord-nueva-body');
    const footer = ge('ord-nueva-footer');
    if (!body || !footer) return;

    if (n.step === 1) {
      body.innerHTML = `
        <div class="ord-form-group">
          <label>Proveedor</label>
          <div class="ord-search-wrap">
            <input id="ord-prov-search" placeholder="Buscar proveedor..." autocomplete="off" value="${esc(n.proveedorNombre)}">
            <div id="ord-prov-dropdown" class="ord-dropdown" style="display:none"></div>
          </div>
          <input type="hidden" id="ord-prov-id" value="${esc(n.proveedorId || '')}">
        </div>
        <div class="ord-form-group">
          <label>Fecha estimada de entrega</label>
          <input type="date" id="ord-fecha-entrega" value="${esc(n.fechaEntrega)}">
        </div>
        <div class="ord-form-group">
          <label>Notas (opcional)</label>
          <textarea id="ord-notas" rows="2" placeholder="Instrucciones especiales...">${esc(n.notas)}</textarea>
        </div>`;

      footer.innerHTML = `
        <button class="btn btn-secondary" id="ord-nueva-cancel-btn">Cancelar</button>
        <button class="btn btn-primary" id="ord-nueva-next1">Siguiente →</button>`;

      attachNuevaOrdenStep1Events();

    } else if (n.step === 2) {
      const subtotal = n.items.reduce((s, i) => s + i.cantidadPedida * i.costoUnitario, 0);
      body.innerHTML = `
        <div class="ord-form-group">
          <label>Buscar producto (nombre o código de barras)</label>
          <div class="ord-search-wrap">
            <input id="ord-prod-search" placeholder="Buscar..." autocomplete="off">
            <div id="ord-prod-dropdown" class="ord-dropdown" style="display:none"></div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:13px">Productos agregados (${n.items.length})</strong>
          <label class="btn btn-ghost" style="font-size:12px;cursor:pointer">
            📥 Importar CSV/Excel
            <input type="file" id="ord-import-file" accept=".csv,.xlsx,.xls" style="display:none">
          </label>
        </div>
        <div class="ord-items-list" id="ord-items-list">
          ${renderItemsList()}
        </div>
        <div class="ord-subtotal">Subtotal estimado: ${esc(fmtPeso(subtotal))}</div>`;

      footer.innerHTML = `
        <button class="btn btn-secondary" id="ord-nueva-back2">← Anterior</button>
        <button class="btn btn-primary" id="ord-nueva-next2">Siguiente →</button>`;

      attachNuevaOrdenStep2Events();

    } else if (n.step === 3) {
      const subtotal = n.items.reduce((s, i) => s + i.cantidadPedida * i.costoUnitario, 0);
      const provRows = n.items.map(i =>
        `<tr>
           <td>${esc(i.nombre)}</td>
           <td style="text-align:right">${esc(i.cantidadPedida)}</td>
           <td style="text-align:right">${esc(fmtPeso(i.costoUnitario))}</td>
           <td style="text-align:right">${esc(fmtPeso(i.cantidadPedida * i.costoUnitario))}</td>
         </tr>`
      ).join('');
      body.innerHTML = `
        <div style="margin-bottom:16px">
          <strong>Proveedor:</strong> ${esc(n.proveedorNombre)}<br>
          <strong>Entrega estimada:</strong> ${esc(n.fechaEntrega ? fmtFecha(n.fechaEntrega) : 'No especificada')}<br>
          ${n.notas ? `<strong>Notas:</strong> ${esc(n.notas)}` : ''}
        </div>
        <table class="ord-table">
          <thead><tr><th>Producto</th><th style="text-align:right">Cant.</th><th style="text-align:right">Costo</th><th style="text-align:right">Subtotal</th></tr></thead>
          <tbody>${provRows}</tbody>
        </table>
        <div class="ord-subtotal" style="margin-top:12px">Total estimado: ${esc(fmtPeso(subtotal))}</div>`;

      footer.innerHTML = `
        <button class="btn btn-secondary" id="ord-nueva-back3">← Anterior</button>
        <button class="btn btn-secondary" id="ord-nueva-borrador">Guardar borrador</button>
        <button class="btn btn-primary" id="ord-nueva-enviar">Enviar orden</button>`;

      attachNuevaOrdenStep3Events();
    }
  }

  function renderStepsIndicator() {
    const n = state.nuevaOrden;
    const steps = [
      { label: 'Proveedor' },
      { label: 'Productos' },
      { label: 'Confirmar' },
    ];
    const stepsEl = ge('ord-nueva-steps');
    if (!stepsEl) return;
    stepsEl.innerHTML = steps.map((s, i) => {
      const idx = i + 1;
      const cls = idx < n.step ? 'done' : idx === n.step ? 'active' : '';
      const num = idx < n.step ? '✓' : idx;
      return `<div class="ord-step-item ${cls}"><span class="ord-step-num">${num}</span>${esc(s.label)}</div>`;
    }).join('');
  }

  function renderItemsList() {
    const items = state.nuevaOrden.items;
    if (!items.length) return '<p style="font-size:13px;color:var(--color-text-secondary);margin:0">No se agregaron productos.</p>';
    return items.map((item, idx) => `
      <div class="ord-item-row">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.nombre)}</span>
        <input type="number" min="1" value="${esc(item.cantidadPedida)}" data-item-qty="${idx}" style="padding:4px 6px;font-size:13px;border:1px solid var(--color-border);border-radius:4px">
        <div style="display:flex;align-items:center;gap:3px;font-size:13px">
          <span style="color:var(--color-text-secondary)">$</span>
          <input type="number" min="0" step="0.01" value="${esc(item.costoUnitario)}" data-item-costo="${idx}" style="width:80px;padding:4px 6px;font-size:13px;border:1px solid var(--color-border);border-radius:4px">
        </div>
        <button class="ord-item-remove" data-item-remove="${idx}">✕</button>
      </div>`).join('');
  }

  function attachNuevaOrdenStep1Events() {
    const provSearch = ge('ord-prov-search');
    const provDd     = ge('ord-prov-dropdown');

    provSearch && provSearch.addEventListener('input', () => {
      const q = provSearch.value.trim();
      if (q.length < 1) { provDd.style.display = 'none'; return; }
      const rows = window.SGA_DB.query(
        `SELECT id, razon_social FROM proveedores WHERE razon_social LIKE ? AND activo=1 ORDER BY razon_social LIMIT 8`,
        [`%${q}%`]
      );
      if (!rows.length) { provDd.style.display = 'none'; return; }
      provDd.innerHTML = rows.map(r =>
        `<div class="ord-dropdown-item" data-prov-id="${esc(r.id)}" data-prov-nombre="${esc(r.razon_social)}">${esc(r.razon_social)}</div>`
      ).join('');
      provDd.style.display = '';
    });

    provDd && provDd.addEventListener('click', (e) => {
      const item = e.target.closest('[data-prov-id]');
      if (!item) return;
      state.nuevaOrden.proveedorId     = item.dataset.provId;
      state.nuevaOrden.proveedorNombre = item.dataset.provNombre;
      provSearch.value     = item.dataset.provNombre;
      ge('ord-prov-id').value = item.dataset.provId;
      provDd.style.display = 'none';
    });

    document.addEventListener('click', function closeProvDd(e) {
      if (!provSearch.contains(e.target) && !provDd.contains(e.target)) {
        provDd.style.display = 'none';
      }
    }, { once: false });

    ge('ord-nueva-cancel-btn') && ge('ord-nueva-cancel-btn').addEventListener('click', closeNuevaOrden);

    ge('ord-nueva-next1') && ge('ord-nueva-next1').addEventListener('click', () => {
      const provId   = ge('ord-prov-id').value;
      const nombre   = ge('ord-prov-search').value.trim();
      const fecha    = ge('ord-fecha-entrega').value;
      const notas    = ge('ord-notas').value.trim();
      if (!provId) { showToast('Seleccioná un proveedor', 'error'); return; }
      state.nuevaOrden.proveedorId     = provId;
      state.nuevaOrden.proveedorNombre = nombre;
      state.nuevaOrden.fechaEntrega    = fecha;
      state.nuevaOrden.notas           = notas;
      state.nuevaOrden.step            = 2;
      renderNuevaOrdenStep();
    });
  }

  function attachNuevaOrdenStep2Events() {
    const prodSearch = ge('ord-prod-search');
    const prodDd     = ge('ord-prod-dropdown');

    prodSearch && prodSearch.addEventListener('input', () => {
      const q = prodSearch.value.trim();
      if (q.length < 2) { prodDd.style.display = 'none'; return; }
      const rows = window.SGA_DB.query(`
        SELECT DISTINCT p.id, p.nombre, p.costo
        FROM productos p
        LEFT JOIN codigos_barras cb ON cb.producto_id = p.id
        WHERE p.activo=1 AND (p.nombre LIKE ? OR cb.codigo LIKE ?)
        ORDER BY p.nombre LIMIT 8
      `, [`%${q}%`, `%${q}%`]);
      if (!rows.length) { prodDd.style.display = 'none'; return; }
      prodDd.innerHTML = rows.map(r =>
        `<div class="ord-dropdown-item"
          data-prod-id="${esc(r.id)}"
          data-prod-nombre="${esc(r.nombre)}"
          data-prod-costo="${esc(r.costo || 0)}">
          ${esc(r.nombre)} <span style="color:var(--color-text-secondary);font-size:12px">${esc(fmtPeso(r.costo))}</span>
        </div>`
      ).join('');
      prodDd.style.display = '';
    });

    prodSearch && prodSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = prodSearch.value.trim();
        if (/^\d{6,}$/.test(q)) {
          const row = window.SGA_DB.query(
            `SELECT p.id, p.nombre, p.costo FROM productos p
             JOIN codigos_barras cb ON cb.producto_id=p.id
             WHERE cb.codigo=? AND p.activo=1 LIMIT 1`,
            [q]
          )[0];
          if (row) { addItemToOrden(row.id, row.nombre, 1, row.costo || 0); prodSearch.value = ''; prodDd.style.display = 'none'; }
        }
      }
    });

    prodDd && prodDd.addEventListener('click', (e) => {
      const item = e.target.closest('[data-prod-id]');
      if (!item) return;
      addItemToOrden(item.dataset.prodId, item.dataset.prodNombre, 1, parseFloat(item.dataset.prodCosto) || 0);
      prodSearch.value     = '';
      prodDd.style.display = 'none';
    });

    // Items list events (qty / costo / remove)
    const list = ge('ord-items-list');
    list && list.addEventListener('change', (e) => {
      const qtyIdx   = e.target.dataset.itemQty;
      const costoIdx = e.target.dataset.itemCosto;
      if (qtyIdx != null) {
        state.nuevaOrden.items[parseInt(qtyIdx)].cantidadPedida = parseFloat(e.target.value) || 1;
        updateSubtotal();
      }
      if (costoIdx != null) {
        state.nuevaOrden.items[parseInt(costoIdx)].costoUnitario = parseFloat(e.target.value) || 0;
        updateSubtotal();
      }
    });

    list && list.addEventListener('click', (e) => {
      const rmBtn = e.target.closest('[data-item-remove]');
      if (rmBtn) {
        state.nuevaOrden.items.splice(parseInt(rmBtn.dataset.itemRemove), 1);
        list.innerHTML = renderItemsList();
        updateSubtotal();
      }
    });

    // Import file
    const importFile = ge('ord-import-file');
    importFile && importFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleImportFile(file);
      importFile.value = '';
    });

    ge('ord-nueva-back2') && ge('ord-nueva-back2').addEventListener('click', () => {
      state.nuevaOrden.step = 1;
      renderNuevaOrdenStep();
    });

    ge('ord-nueva-next2') && ge('ord-nueva-next2').addEventListener('click', () => {
      if (!state.nuevaOrden.items.length) { showToast('Agregá al menos un producto', 'error'); return; }
      state.nuevaOrden.step = 3;
      renderNuevaOrdenStep();
    });
  }

  function updateSubtotal() {
    const subtotal = state.nuevaOrden.items.reduce((s, i) => s + i.cantidadPedida * i.costoUnitario, 0);
    const el = document.querySelector('.ord-subtotal');
    if (el) el.textContent = `Subtotal estimado: ${fmtPeso(subtotal)}`;
  }

  function addItemToOrden(productoId, nombre, cantidadPedida, costoUnitario) {
    const existing = state.nuevaOrden.items.find(i => i.productoId === productoId);
    if (existing) { existing.cantidadPedida += cantidadPedida; }
    else { state.nuevaOrden.items.push({ productoId, nombre, cantidadPedida, costoUnitario: parseFloat(costoUnitario) || 0 }); }
    const list = ge('ord-items-list');
    if (list) list.innerHTML = renderItemsList();
    updateSubtotal();
  }

  function attachNuevaOrdenStep3Events() {
    ge('ord-nueva-back3') && ge('ord-nueva-back3').addEventListener('click', () => {
      state.nuevaOrden.step = 2;
      renderNuevaOrdenStep();
    });
    ge('ord-nueva-borrador') && ge('ord-nueva-borrador').addEventListener('click', () => saveOrden(false));
    ge('ord-nueva-enviar')   && ge('ord-nueva-enviar').addEventListener('click',   () => saveOrden(true));
  }

  function saveOrden(enviar) {
    const n = state.nuevaOrden;
    const result = _crear({
      sucursalId:   state.user.sucursal_id,
      proveedorId:  n.proveedorId,
      usuarioId:    state.user.id,
      fechaEntrega: n.fechaEntrega,
      notas:        n.notas,
      items:        n.items,
    });
    if (!result.success) { showToast('Error al guardar: ' + result.error, 'error'); return; }
    if (enviar) { _enviar(result.ordenId); }
    closeNuevaOrden();
    showToast(enviar ? 'Orden enviada al proveedor ✓' : 'Borrador guardado ✓');
    renderLista();
  }

  async function handleImportFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv' || ext === 'txt') {
      const text = await file.text();
      parseCSVImport(text);
    } else if (ext === 'xlsx' || ext === 'xls') {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js';
          s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        }).catch(() => null);
      }
      if (!window.XLSX) { showToast('No se pudo cargar la librería Excel', 'error'); return; }
      const buf  = await file.arrayBuffer();
      const wb   = window.XLSX.read(buf);
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1 });
      const lines = rows.slice(1).map(r => `${r[0] || ''},${r[1] || ''}`).join('\n');
      parseCSVImport(lines);
    }
  }

  function parseCSVImport(text) {
    let added = 0;
    for (const line of text.split('\n')) {
      const parts = line.split(/[,;\t]/);
      const barcode  = String(parts[0] || '').trim();
      const cantidad = parseFloat(parts[1]) || 1;
      if (!barcode) continue;
      const prod = window.SGA_DB.query(
        `SELECT p.id, p.nombre, p.costo FROM productos p
         JOIN codigos_barras cb ON cb.producto_id=p.id
         WHERE cb.codigo=? AND p.activo=1 LIMIT 1`,
        [barcode]
      )[0];
      if (prod) { addItemToOrden(prod.id, prod.nombre, cantidad, prod.costo || 0); added++; }
    }
    showToast(`${added} producto${added !== 1 ? 's' : ''} importado${added !== 1 ? 's' : ''}`);
  }

  // ── UI — RECEPCIÓN ─────────────────────────────────────────────────────────

  function openRecepcion(ordenId) {
    const orden = _getById(ordenId);
    if (!orden) return;
    _iniciarRecepcion(ordenId);
    orden.estado  = 'recibiendo';
    // Initialize costo_unitario from product costo if missing
    for (const item of orden.items) {
      if (!parseFloat(item.costo_unitario)) {
        item.costo_unitario = item.costo_actual || 0;
      }
    }
    state.recepcion.orden        = orden;
    state.recepcion.costoChanges = [];
    ge('ord-main').style.display           = 'none';
    ge('ord-recepcion-overlay').style.display = 'flex';
    ge('ord-rec-titulo').textContent = `📦 Recepción — ${orden.proveedor_nombre} — OC #${ordenId.slice(-6).toUpperCase()}`;
    renderRecepcion();
    setTimeout(() => ge('ord-scanner-input') && ge('ord-scanner-input').focus(), 100);
  }

  function closeRecepcion() {
    ge('ord-recepcion-overlay').style.display = 'none';
    ge('ord-main').style.display              = '';
    state.recepcion.orden = null;
    renderLista();
  }

  function renderRecepcion() {
    renderRecItems();
    renderRecSummary();
  }

  function renderRecItems() {
    const tbody = ge('ord-rec-tbody');
    if (!tbody || !state.recepcion.orden) return;
    const items = state.recepcion.orden.items;

    tbody.innerHTML = items.map(item => {
      const est  = item.estado || 'pendiente';
      const rowCls = est === 'recibido'          ? 'ord-rec-row-recibido'
                   : est === 'recibido_parcial'   ? 'ord-rec-row-parcial'
                   : est === 'no_entregado'        ? 'ord-rec-row-no_entregado'
                   : '';
      const cantR = parseFloat(item.cantidad_recibida) || 0;
      const costo = parseFloat(item.costo_unitario)    || parseFloat(item.costo_actual) || 0;
      const noEntBtnTxt = est === 'no_entregado' ? '↩' : '✕';
      return `<tr class="${rowCls}" data-item-id="${esc(item.id)}">
        <td>${esc(item.producto_nombre || '—')}</td>
        <td style="text-align:right">${esc(item.cantidad_pedida)}</td>
        <td>
          <div class="ord-rec-qty-ctrl">
            <button data-qty-dec="${esc(item.id)}">−</button>
            <input type="number" min="0" value="${cantR}" data-qty-input="${esc(item.id)}" class="ord-rec-qty-ctrl">
            <button data-qty-inc="${esc(item.id)}">+</button>
          </div>
        </td>
        <td>
          <input type="number" min="0" step="0.01" value="${esc(costo.toFixed(2))}" class="ord-rec-costo-input" data-costo-input="${esc(item.id)}">
        </td>
        <td><span class="ord-badge ${est === 'recibido' ? 'ord-badge-cerrada' : est === 'recibido_parcial' ? 'ord-badge-recibida_parcial' : est === 'no_entregado' ? 'ord-badge-pendiente_pago' : 'ord-badge-borrador'}">${esc(ITEM_ESTADO_LABEL[est] || est)}</span></td>
        <td>
          <button class="btn btn-ghost" style="font-size:11px" data-no-entregado="${esc(item.id)}" title="${est === 'no_entregado' ? 'Restablecer' : 'No entregado'}">${noEntBtnTxt}</button>
        </td>
      </tr>`;
    }).join('');
  }

  function renderRecSummary() {
    const orden = state.recepcion.orden;
    if (!orden) return;
    const items     = orden.items;
    const total     = items.length;
    const recibidos = items.filter(i => i.estado === 'recibido' || i.estado === 'recibido_parcial').length;
    const noEntregados = items.filter(i => i.estado === 'no_entregado').length;
    const pendientes   = items.filter(i => i.estado === 'pendiente').length;
    const totalRecibido = items.reduce((s, i) => {
      const cantR = parseFloat(i.cantidad_recibida) || 0;
      const costo = parseFloat(i.costo_unitario)    || 0;
      return s + cantR * costo;
    }, 0);

    const pct     = total ? Math.round(((recibidos + noEntregados) / total) * 100) : 0;
    const allDone = pendientes === 0;

    const statsEl = ge('ord-rec-stats');
    if (statsEl) statsEl.innerHTML = `
      <div class="ord-rec-stat"><span>Recibidos</span><span class="ord-rec-stat-val">${recibidos} / ${total}</span></div>
      <div class="ord-rec-stat"><span>No entregados</span><span class="ord-rec-stat-val">${noEntregados}</span></div>
      <div class="ord-rec-stat"><span>Pendientes</span><span class="ord-rec-stat-val">${pendientes}</span></div>
      <div class="ord-rec-stat"><span>Total recibido</span><span class="ord-rec-stat-val">${fmtPeso(totalRecibido)}</span></div>`;

    const fill = ge('ord-rec-progress-fill');
    const pctEl = ge('ord-rec-pct');
    if (fill) fill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '% completado';

    // Pending items
    const pendEl = ge('ord-rec-pendientes');
    if (pendEl) {
      const pendItems = items.filter(i => i.estado === 'pendiente');
      pendEl.innerHTML = pendItems.length
        ? pendItems.map(i => `
            <div class="ord-rec-pendiente-item">
              <span>${esc(i.producto_nombre)}</span>
              <div style="display:flex;gap:6px;align-items:center">
                <span style="color:var(--color-text-secondary);font-size:12px">falta ${esc(i.cantidad_pedida - (parseFloat(i.cantidad_recibida) || 0))}</span>
                <button class="btn btn-ghost" style="font-size:11px;padding:2px 6px" data-no-entregado="${esc(i.id)}">✕</button>
              </div>
            </div>`).join('')
        : '<p style="font-size:13px;color:var(--color-text-secondary);margin:0">Todos procesados.</p>';
    }

    const confirmarBtn = ge('ord-rec-confirmar');
    if (confirmarBtn) confirmarBtn.disabled = !allDone;
  }

  function updateItemInState(itemId, fields) {
    if (!state.recepcion.orden) return;
    const item = state.recepcion.orden.items.find(i => i.id === itemId);
    if (!item) return;
    Object.assign(item, fields);
    // Recalculate estado
    const cantR  = parseFloat(item.cantidad_recibida) || 0;
    const cantP  = parseFloat(item.cantidad_pedida)   || 0;
    item.estado  = cantR === 0         ? 'no_entregado'
                 : cantR >= cantP      ? 'recibido'
                 : 'recibido_parcial';
    _recibirItem(itemId, item.cantidad_recibida, item.costo_unitario);
    renderRecItems();
    renderRecSummary();
  }

  function clearScanAlert() {
    const wrap = ge('ord-scan-alert-wrap');
    if (wrap) wrap.innerHTML = '';
  }

  function showScanAlert(html, type) {
    const wrap = ge('ord-scan-alert-wrap');
    if (!wrap) return;
    wrap.innerHTML = `<div class="ord-scan-alert ord-scan-alert-${type}">${html}</div>`;
  }

  function handleScan(e) {
    if (e.key !== 'Enter') return;
    const input = ge('ord-scanner-input');
    const code  = (input ? input.value : '').trim();
    if (!code) return;
    if (input) input.value = '';
    e.preventDefault();
    clearScanAlert();
    processScannedCode(code);
  }

  function processScannedCode(code) {
    const rows = window.SGA_DB.query(
      `SELECT p.id, p.nombre FROM productos p
       JOIN codigos_barras cb ON cb.producto_id=p.id
       WHERE cb.codigo=? AND p.activo=1 LIMIT 1`,
      [code]
    );
    if (!rows.length) {
      // Not in DB → discrepancy
      openDiscrepanciaModal(code);
      return;
    }
    const producto = rows[0];
    const orden    = state.recepcion.orden;
    const item     = orden.items.find(i => i.producto_id === producto.id);
    if (!item) {
      // Product found in DB but not in this order
      showScanAlert(
        `<div><strong>${esc(producto.nombre)}</strong> no estaba en esta orden. ¿Agregarlo?</div>
         <div class="ord-scan-alert-actions">
           <button class="btn btn-secondary" style="font-size:12px" data-add-extra="${esc(producto.id)}" data-add-nombre="${esc(producto.nombre)}">Agregar</button>
           <button class="btn btn-ghost" style="font-size:12px" id="ord-scan-ignorar">Ignorar</button>
         </div>`,
        'yellow'
      );
      return;
    }
    // Increment received quantity
    const newQty = (parseFloat(item.cantidad_recibida) || 0) + 1;
    updateItemInState(item.id, { cantidad_recibida: newQty });
    // Highlight row briefly
    const row = document.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
    if (row) {
      row.style.outline = '2px solid var(--color-primary)';
      setTimeout(() => { row.style.outline = ''; }, 600);
    }
    ge('ord-scanner-input') && ge('ord-scanner-input').focus();
  }

  function addExtraItemToRecepcion(productoId, nombre) {
    const orden = state.recepcion.orden;
    // Add as new item
    const newItem = {
      id:                uuid(),
      orden_id:          orden.id,
      producto_id:       productoId,
      producto_nombre:   nombre,
      cantidad_pedida:   1,
      cantidad_recibida: 1,
      costo_unitario:    0,
      costo_anterior:    0,
      estado:            'recibido',
      costo_actual:      0,
      es_madre:          0,
      producto_madre_id: null,
    };
    // Insert into DB
    window.SGA_DB.run(`
      INSERT INTO orden_compra_items
        (id,orden_id,producto_id,cantidad_pedida,cantidad_recibida,costo_unitario,costo_anterior,estado)
      VALUES (?,?,?,1,1,0,0,'recibido')`,
      [newItem.id, orden.id, productoId]);
    orden.items.push(newItem);
    clearScanAlert();
    renderRecepcion();
  }

  // ── UI — DISCREPANCIA MODAL ────────────────────────────────────────────────

  function openDiscrepanciaModal(codigo) {
    state.discrepancia = { active: true, codigo, productoSeleccionado: null, step: 'search' };
    ge('ord-disc-overlay').style.display = 'flex';
    renderDiscrepanciaModal();
    setTimeout(() => ge('ord-scanner-input') && ge('ord-scanner-input').blur(), 0);
  }

  function closeDiscrepanciaModal() {
    state.discrepancia.active = false;
    ge('ord-disc-overlay').style.display = 'none';
    setTimeout(() => ge('ord-scanner-input') && ge('ord-scanner-input').focus(), 100);
  }

  function renderDiscrepanciaModal() {
    const disc = state.discrepancia;
    const body = ge('ord-disc-body');
    if (!body) return;

    if (disc.step === 'search') {
      body.innerHTML = `
        <p style="margin:0 0 12px;font-size:14px">
          Código escaneado: <strong>${esc(disc.codigo)}</strong>
        </p>
        <p style="font-size:13px;color:var(--color-text-secondary);margin:0 0 8px">¿A qué producto corresponde?</p>
        <div class="ord-form-group" style="margin-bottom:8px">
          <div class="ord-search-wrap">
            <input id="ord-disc-search" placeholder="Buscar producto..." autocomplete="off" style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:8px 10px;width:100%;box-sizing:border-box">
            <div id="ord-disc-dropdown" class="ord-dropdown" style="display:none"></div>
          </div>
        </div>
        <button class="btn btn-ghost" style="width:100%;font-size:13px" id="ord-disc-cancelar">✕ Cancelar — ignorar código</button>`;

      const discSearch = ge('ord-disc-search');
      const discDd     = ge('ord-disc-dropdown');

      discSearch && discSearch.addEventListener('input', () => {
        const q = discSearch.value.trim();
        if (q.length < 2) { discDd.style.display = 'none'; return; }
        const rows = window.SGA_DB.query(`
          SELECT DISTINCT p.id, p.nombre, p.costo
          FROM productos p
          LEFT JOIN codigos_barras cb ON cb.producto_id=p.id
          WHERE p.activo=1 AND (p.nombre LIKE ? OR cb.codigo LIKE ?)
          ORDER BY p.nombre LIMIT 8
        `, [`%${q}%`, `%${q}%`]);
        if (!rows.length) { discDd.style.display = 'none'; return; }
        discDd.innerHTML = rows.map(r =>
          `<div class="ord-dropdown-item" data-disc-prod-id="${esc(r.id)}" data-disc-prod-nombre="${esc(r.nombre)}" data-disc-prod-costo="${esc(r.costo || 0)}">
            ${esc(r.nombre)}
          </div>`
        ).join('');
        discDd.style.display = '';
      });

      discSearch && discSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const q = discSearch.value.trim();
          const row = window.SGA_DB.query(
            `SELECT p.id, p.nombre, p.costo FROM productos p
             JOIN codigos_barras cb ON cb.producto_id=p.id
             WHERE cb.codigo=? AND p.activo=1 LIMIT 1`,
            [q]
          )[0];
          if (row) {
            state.discrepancia.productoSeleccionado = row;
            state.discrepancia.step = 'options';
            renderDiscrepanciaModal();
          }
        }
      });

      discDd && discDd.addEventListener('click', (e) => {
        const item = e.target.closest('[data-disc-prod-id]');
        if (!item) return;
        state.discrepancia.productoSeleccionado = {
          id:     item.dataset.discProdId,
          nombre: item.dataset.discProdNombre,
          costo:  parseFloat(item.dataset.discProdCosto) || 0,
        };
        state.discrepancia.step = 'options';
        renderDiscrepanciaModal();
      });

      ge('ord-disc-cancelar') && ge('ord-disc-cancelar').addEventListener('click', closeDiscrepanciaModal);
      setTimeout(() => discSearch && discSearch.focus(), 50);

    } else if (disc.step === 'options') {
      const prod = disc.productoSeleccionado;

      body.innerHTML = `
        <p style="margin:0 0 4px;font-size:13px;color:var(--color-text-secondary)">Código: <strong>${esc(disc.codigo)}</strong></p>
        <p style="margin:0 0 14px;font-size:14px">Producto: <strong>${esc(prod ? prod.nombre : '—')}</strong></p>
        <div class="ord-disc-options">
          <button class="ord-disc-option" data-disc-opt="mismo_producto_nuevo_codigo">
            <span class="ord-disc-option-icon">📎</span>
            <div>
              <div class="ord-disc-option-label">Es el mismo producto (código alternativo)</div>
              <div class="ord-disc-option-desc">Agrega el código escaneado al producto seleccionado</div>
            </div>
          </button>
          <button class="ord-disc-option" data-disc-opt="sustituto">
            <span class="ord-disc-option-icon">🔄</span>
            <div>
              <div class="ord-disc-option-label">Es un sustituto de otro producto</div>
              <div class="ord-disc-option-desc">Vincula este producto como sustituto</div>
            </div>
          </button>
          <button class="ord-disc-option" data-disc-opt="producto_nuevo">
            <span class="ord-disc-option-icon">✨</span>
            <div>
              <div class="ord-disc-option-label">Es un producto nuevo</div>
              <div class="ord-disc-option-desc">Crea el producto con este código de barras</div>
            </div>
          </button>
          <button class="ord-disc-option" data-disc-opt="cancelar">
            <span class="ord-disc-option-icon">❌</span>
            <div>
              <div class="ord-disc-option-label">Cancelar</div>
              <div class="ord-disc-option-desc">No registrar este código</div>
            </div>
          </button>
        </div>`;

      body.querySelectorAll('[data-disc-opt]').forEach(btn => {
        btn.addEventListener('click', () => resolveDiscrepancia(btn.dataset.discOpt));
      });
    }
  }

  function resolveDiscrepancia(tipo) {
    const disc = state.discrepancia;
    const prod = disc.productoSeleccionado;

    if (tipo === 'cancelar') {
      closeDiscrepanciaModal();
      return;
    }

    if (tipo === 'mismo_producto_nuevo_codigo' && prod) {
      // Add barcode to existing product
      window.SGA_DB.run(
        `INSERT OR IGNORE INTO codigos_barras (id,producto_id,codigo,es_principal) VALUES (?,?,?,0)`,
        [uuid(), prod.id, disc.codigo]
      );
      // Increment received qty for this product in the order
      const orden = state.recepcion.orden;
      const item  = orden.items.find(i => i.producto_id === prod.id);
      if (item) {
        const newQty = (parseFloat(item.cantidad_recibida) || 0) + 1;
        updateItemInState(item.id, { cantidad_recibida: newQty });
      } else {
        addExtraItemToRecepcion(prod.id, prod.nombre);
      }
      showToast(`Código agregado a "${prod.nombre}" ✓`);
      closeDiscrepanciaModal();

    } else if (tipo === 'sustituto' && prod) {
      // Link as substitute
      const orden = state.recepcion.orden;
      if (orden.items.length > 0) {
        const ref = orden.items.find(i => i.producto_id !== prod.id);
        if (ref) {
          window.SGA_DB.run(`
            INSERT OR IGNORE INTO producto_sustitutos (producto_id,sustituto_id,activo,fecha_asignacion)
            VALUES (?,?,1,?)`,
            [ref.producto_id, prod.id, now()]
          );
          showToast(`"${prod.nombre}" vinculado como sustituto ✓`);
        }
      }
      addExtraItemToRecepcion(prod.id, prod.nombre);
      closeDiscrepanciaModal();

    } else if (tipo === 'producto_nuevo') {
      // Mini form for new product
      const body = ge('ord-disc-body');
      body.innerHTML = `
        <p style="font-size:13px;color:var(--color-text-secondary);margin:0 0 12px">
          Código: <strong>${esc(disc.codigo)}</strong>
        </p>
        <div class="ord-form-group"><label>Nombre</label><input id="ord-np-nombre" placeholder="Nombre del producto"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="ord-form-group"><label>Costo ($)</label><input type="number" id="ord-np-costo" min="0" step="0.01" placeholder="0.00"></div>
          <div class="ord-form-group"><label>Precio venta ($)</label><input type="number" id="ord-np-precio" min="0" step="0.01" placeholder="0.00"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-secondary" id="ord-np-cancelar">Cancelar</button>
          <button class="btn btn-primary" id="ord-np-crear">Crear producto</button>
        </div>`;

      ge('ord-np-cancelar') && ge('ord-np-cancelar').addEventListener('click', closeDiscrepanciaModal);
      ge('ord-np-crear') && ge('ord-np-crear').addEventListener('click', () => {
        const nombre = (ge('ord-np-nombre').value || '').trim();
        const costo  = parseFloat(ge('ord-np-costo').value)  || 0;
        const precio = parseFloat(ge('ord-np-precio').value) || 0;
        if (!nombre) { showToast('Ingresá el nombre del producto', 'error'); return; }
        const prodId = uuid();
        const ts = now();
        window.SGA_DB.run(`
          INSERT INTO productos (id,nombre,costo,precio_venta,activo,fecha_alta,fecha_modificacion)
          VALUES (?,?,?,?,1,?,?)`,
          [prodId, nombre, costo, precio, ts, ts]);
        window.SGA_DB.run(`
          INSERT INTO codigos_barras (id,producto_id,codigo,es_principal) VALUES (?,?,?,1)`,
          [uuid(), prodId, disc.codigo]);
        addExtraItemToRecepcion(prodId, nombre);
        showToast(`Producto "${nombre}" creado ✓`);
        closeDiscrepanciaModal();
      });
    }
  }

  // ── UI — PAYMENT MODAL ─────────────────────────────────────────────────────

  function openPaymentModal(ordenId, proveedorNombre, total) {
    state.pago = { active: true, ordenId, proveedorNombre, total, pagado: 0, modo: 'pendiente', monto: total };
    ge('ord-pago-titulo').textContent = `💳 Registrar pago — ${proveedorNombre}`;
    renderPaymentModal();
    ge('ord-pago-overlay').style.display = 'flex';
    // Set confirm handler for this specific call (reception flow)
    ge('ord-pago-confirmar').onclick = confirmarPago;
  }

  function renderPaymentModal() {
    const p    = state.pago;
    const body = ge('ord-pago-body');
    if (!body) return;
    body.innerHTML = `
      <div class="ord-pago-total">Total recepción: ${esc(fmtPeso(p.total))}</div>
      <div class="ord-pago-opts">
        <label class="ord-pago-opt ${p.modo === 'efectivo' ? 'selected' : ''}">
          <input type="radio" name="ord-pago-modo" value="efectivo" ${p.modo === 'efectivo' ? 'checked' : ''}> Pagar ahora en efectivo
        </label>
        <label class="ord-pago-opt ${p.modo === 'pendiente' ? 'selected' : ''}">
          <input type="radio" name="ord-pago-modo" value="pendiente" ${p.modo === 'pendiente' ? 'checked' : ''}> Queda pendiente de pago
        </label>
      </div>
      <div id="ord-pago-monto-wrap" style="${p.modo !== 'efectivo' ? 'display:none' : ''}">
        <div class="ord-pago-monto-row">
          <label>Monto a pagar ($):</label>
          <input type="number" id="ord-pago-monto" min="0" step="0.01" value="${esc(p.total.toFixed(2))}">
        </div>
        <p style="font-size:12px;color:var(--color-text-secondary);margin:6px 0 0">
          Si el monto es menor al total, la diferencia queda como deuda pendiente.
        </p>
      </div>`;

    body.querySelectorAll('[name="ord-pago-modo"]').forEach(radio => {
      radio.addEventListener('change', () => {
        state.pago.modo = radio.value;
        const montoWrap = ge('ord-pago-monto-wrap');
        if (montoWrap) montoWrap.style.display = state.pago.modo === 'efectivo' ? '' : 'none';
        body.querySelectorAll('.ord-pago-opt').forEach(opt => {
          opt.classList.toggle('selected', opt.querySelector('input').value === state.pago.modo);
        });
      });
    });
  }

  function confirmarPago() {
    const p = state.pago;
    const monto = p.modo === 'efectivo' ? parseFloat(ge('ord-pago-monto').value) || p.total : 0;
    const result = _confirmarRecepcion(p.ordenId, p.modo, monto);
    if (!result.success) { showToast('Error: ' + result.error, 'error'); return; }

    ge('ord-pago-overlay').style.display = 'none';
    closeRecepcion();

    if (result.costoChanges && result.costoChanges.length) {
      showCostChangesModal(result.costoChanges, p.ordenId);
    } else {
      showToast('Recepción confirmada ✓');
      renderLista();
    }
  }

  // ── UI — COST CHANGES MODAL ────────────────────────────────────────────────

  function showCostChangesModal(changes, ordenId) {
    state.costos = { active: true, changes, ordenId };
    const body = ge('ord-costos-body');
    if (!body) return;
    body.innerHTML = `
      <p style="font-size:14px;margin:0 0 12px">Los siguientes productos tienen un costo diferente al registrado:</p>
      <table class="ord-costos-table">
        <thead><tr><th>Producto</th><th>Costo anterior</th><th>Costo nuevo</th><th>Diferencia</th><th>Opciones</th></tr></thead>
        <tbody>
          ${changes.map((c, idx) => {
            const diff = c.costoNuevo - c.costoAnterior;
            const pct  = c.costoAnterior ? ((diff / c.costoAnterior) * 100).toFixed(1) : '—';
            const cls  = diff > 0 ? 'ord-costos-diff-pos' : 'ord-costos-diff-neg';
            return `<tr>
              <td>${esc(c.nombre)}</td>
              <td>${esc(fmtPeso(c.costoAnterior))}</td>
              <td>${esc(fmtPeso(c.costoNuevo))}</td>
              <td class="${cls}">${diff > 0 ? '+' : ''}${esc(pct)}%</td>
              <td>
                <div class="ord-costos-check-row">
                  <label><input type="checkbox" data-cost-actualizar="${idx}" checked> Actualizar costo</label>
                </div>
                <div class="ord-costos-check-row">
                  <label><input type="checkbox" data-cost-precio="${idx}"> Actualizar precio venta proporcionalmente</label>
                </div>
                ${(c.esMadre || c.productaMadreId) ? `<div class="ord-costos-check-row"><label><input type="checkbox" data-cost-familia="${idx}"> Aplicar a toda la familia</label></div>` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    ge('ord-costos-overlay').style.display = 'flex';
  }

  function confirmarCostChanges() {
    const changes = state.costos.changes;
    const ts = now();

    for (let idx = 0; idx < changes.length; idx++) {
      const c = changes[idx];
      const actualizarCosto  = document.querySelector(`[data-cost-actualizar="${idx}"]`);
      const actualizarPrecio = document.querySelector(`[data-cost-precio="${idx}"]`);
      const familia          = document.querySelector(`[data-cost-familia="${idx}"]`);

      if (!actualizarCosto || !actualizarCosto.checked) continue;

      const pctChange = c.costoAnterior ? c.costoNuevo / c.costoAnterior : 1;

      if (familia && familia.checked) {
        // Update entire family
        const madreId = c.productaMadreId || c.productoId;
        const ids = window.SGA_DB.query(
          `SELECT id, precio_venta FROM productos WHERE id=? OR producto_madre_id=?`,
          [madreId, madreId]
        );
        for (const p of ids) {
          const nuevoPrecio = actualizarPrecio && actualizarPrecio.checked
            ? (parseFloat(p.precio_venta) || 0) * pctChange : null;
          const setClause = nuevoPrecio != null
            ? 'costo=?, precio_venta=?, fecha_modificacion=?'
            : 'costo=?, fecha_modificacion=?';
          const params = nuevoPrecio != null
            ? [c.costoNuevo, nuevoPrecio, ts, p.id]
            : [c.costoNuevo, ts, p.id];
          window.SGA_DB.run(`UPDATE productos SET ${setClause} WHERE id=?`, params);
        }
      } else {
        const prod = window.SGA_DB.query(`SELECT precio_venta FROM productos WHERE id=?`, [c.productoId])[0];
        const nuevoPrecio = actualizarPrecio && actualizarPrecio.checked && prod
          ? (parseFloat(prod.precio_venta) || 0) * pctChange : null;
        const setClause = nuevoPrecio != null
          ? 'costo=?, precio_venta=?, fecha_modificacion=?'
          : 'costo=?, fecha_modificacion=?';
        const params = nuevoPrecio != null
          ? [c.costoNuevo, nuevoPrecio, ts, c.productoId]
          : [c.costoNuevo, ts, c.productoId];
        window.SGA_DB.run(`UPDATE productos SET ${setClause} WHERE id=?`, params);
      }
    }

    ge('ord-costos-overlay').style.display = 'none';
    showToast('Costos actualizados ✓');
    renderLista();
  }

  // ── UI — PAGOS PENDIENTES VIEW ─────────────────────────────────────────────

  function openPagosPendientes() {
    state.view = 'pagos';
    ge('ord-main').style.display          = 'none';
    ge('ord-pagos-overlay').style.display = 'flex';
    renderPagosPendientes();
  }

  function closePagosPendientes() {
    state.view = 'lista';
    ge('ord-pagos-overlay').style.display = 'none';
    ge('ord-main').style.display          = '';
    renderLista();
  }

  function renderPagosPendientes() {
    const ordenes = _getConPagoPendiente(state.user.sucursal_id);
    const tbody   = ge('ord-pagos-tbody');
    const empty   = ge('ord-pagos-empty');
    if (!tbody) return;
    if (!ordenes.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = ordenes.map(o => {
      const total   = parseFloat(o.total_estimado) || 0;
      const pagado  = parseFloat(o.total_pagado)   || 0;
      const saldo   = parseFloat(o.saldo_pendiente) || 0;
      return `<tr>
        <td>${esc(o.proveedor_nombre || '—')}</td>
        <td>${esc(fmtFecha(o.updated_at))}</td>
        <td>${esc(fmtPeso(total))}</td>
        <td>${esc(fmtPeso(pagado))}</td>
        <td style="color:#C62828;font-weight:600">${esc(fmtPeso(saldo))}</td>
        <td>
          <button class="btn btn-primary" style="font-size:12px" data-pagar-orden="${esc(o.id)}" data-pagar-proveedor="${esc(o.proveedor_nombre)}" data-pagar-saldo="${esc(saldo)}">
            Registrar pago
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  function openPagoOrden(ordenId, proveedorNombre, saldo) {
    state.pago = { active: true, ordenId, proveedorNombre, total: saldo, pagado: 0, modo: 'efectivo', monto: saldo };
    ge('ord-pago-titulo').textContent = `💳 Pago a ${proveedorNombre}`;
    renderPaymentModal();
    ge('ord-pago-overlay').style.display = 'flex';
    // On confirm: call _registrarPago
    ge('ord-pago-confirmar').onclick = () => {
      const monto = parseFloat(ge('ord-pago-monto') ? ge('ord-pago-monto').value : saldo) || saldo;
      const result = _registrarPago(ordenId, monto, state.user.id);
      if (!result.success) { showToast('Error: ' + result.error, 'error'); return; }
      ge('ord-pago-overlay').style.display = 'none';
      showToast('Pago registrado ✓');
      renderPagosPendientes();
    };
  }

  // ── EVENTS ─────────────────────────────────────────────────────────────────

  function attachEvents() {
    // Tab switching
    document.querySelectorAll('.ord-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ord-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.currentTab = btn.dataset.tab;
        renderLista();
      });
    });

    // Nueva orden
    ge('ord-btn-nueva') && ge('ord-btn-nueva').addEventListener('click', openNuevaOrden);
    ge('ord-nueva-close') && ge('ord-nueva-close').addEventListener('click', closeNuevaOrden);

    // Pagos pendientes
    ge('ord-btn-pagos') && ge('ord-btn-pagos').addEventListener('click', openPagosPendientes);
    ge('ord-pagos-volver') && ge('ord-pagos-volver').addEventListener('click', closePagosPendientes);

    // Table row actions (delegated)
    ge('ord-tbody') && ge('ord-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'recibir') { openRecepcion(id); }
      else if (btn.dataset.action === 'enviar') {
        _enviar(id);
        showToast('Orden enviada al proveedor ✓');
        renderLista();
      }
      else if (btn.dataset.action === 'pagar') {
        const orden = _getById(id);
        const saldo = (window.SGA_DB.query(
          `SELECT COALESCE(SUM(CASE WHEN tipo='deuda' THEN monto ELSE -monto END),0) AS s FROM cuenta_proveedor WHERE orden_id=?`,
          [id]
        )[0] || {}).s || 0;
        openPagoOrden(id, orden ? orden.proveedor_nombre : '', saldo);
      }
    });

    // Pagos pendientes table row actions (delegated)
    ge('ord-pagos-tbody') && ge('ord-pagos-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pagar-orden]');
      if (!btn) return;
      openPagoOrden(btn.dataset.pagarOrden, btn.dataset.pagarProveedor, parseFloat(btn.dataset.pagarSaldo) || 0);
    });

    // Reception volver
    ge('ord-rec-volver') && ge('ord-rec-volver').addEventListener('click', () => {
      const hasActivity = state.recepcion.orden &&
        state.recepcion.orden.items.some(i => parseFloat(i.cantidad_recibida) > 0);
      if (hasActivity && !confirm('¿Salir? La recepción quedará en estado "recibiendo".')) return;
      closeRecepcion();
    });

    // Scanner input
    ge('ord-scanner-input') && ge('ord-scanner-input').addEventListener('keydown', handleScan);

    // Reception items (delegated)
    const recLeft = document.querySelector('.ord-rec-left');
    recLeft && recLeft.addEventListener('click', (e) => {
      // qty dec
      const decBtn = e.target.closest('[data-qty-dec]');
      if (decBtn) {
        const id   = decBtn.dataset.qtyDec;
        const item = state.recepcion.orden.items.find(i => i.id === id);
        if (item) {
          const v = Math.max(0, (parseFloat(item.cantidad_recibida) || 0) - 1);
          updateItemInState(id, { cantidad_recibida: v });
        }
        return;
      }
      // qty inc
      const incBtn = e.target.closest('[data-qty-inc]');
      if (incBtn) {
        const id   = incBtn.dataset.qtyInc;
        const item = state.recepcion.orden.items.find(i => i.id === id);
        if (item) {
          const v = (parseFloat(item.cantidad_recibida) || 0) + 1;
          updateItemInState(id, { cantidad_recibida: v });
        }
        return;
      }
      // no entregado
      const noBtn = e.target.closest('[data-no-entregado]');
      if (noBtn) {
        const id   = noBtn.dataset.noEntregado;
        const item = state.recepcion.orden.items.find(i => i.id === id);
        if (item) {
          if (item.estado === 'no_entregado') {
            // Restore to pendiente — bypass updateItemInState (would recalc to no_entregado for qty=0)
            item.estado           = 'pendiente';
            item.cantidad_recibida = 0;
            window.SGA_DB.run(`UPDATE orden_compra_items SET estado='pendiente', cantidad_recibida=0 WHERE id=?`, [id]);
            renderRecItems();
            renderRecSummary();
          } else {
            item.estado           = 'no_entregado';
            item.cantidad_recibida = 0;
            window.SGA_DB.run(`UPDATE orden_compra_items SET estado='no_entregado', cantidad_recibida=0 WHERE id=?`, [id]);
            renderRecItems();
            renderRecSummary();
          }
        }
        return;
      }
      // scan alert buttons
      const addExtra = e.target.closest('[data-add-extra]');
      if (addExtra) {
        addExtraItemToRecepcion(addExtra.dataset.addExtra, addExtra.dataset.addNombre);
        return;
      }
      const ignorar = ge('ord-scan-ignorar');
      if (e.target === ignorar) { clearScanAlert(); ge('ord-scanner-input') && ge('ord-scanner-input').focus(); }
    });

    // Reception qty input (change)
    const recLeftEl = document.querySelector('.ord-rec-left');
    recLeftEl && recLeftEl.addEventListener('change', (e) => {
      const qtyInput   = e.target.dataset.qtyInput;
      const costoInput = e.target.dataset.costoInput;
      if (qtyInput) {
        updateItemInState(qtyInput, { cantidad_recibida: parseFloat(e.target.value) || 0 });
      }
      if (costoInput) {
        updateItemInState(costoInput, { costo_unitario: parseFloat(e.target.value) || 0 });
      }
    });

    // Confirmar recepcion
    ge('ord-rec-confirmar') && ge('ord-rec-confirmar').addEventListener('click', () => {
      const orden = state.recepcion.orden;
      if (!orden) return;
      const total = orden.items.reduce((s, i) => {
        const cantR = parseFloat(i.cantidad_recibida) || 0;
        return cantR > 0 && i.estado !== 'no_entregado' ? s + cantR * (parseFloat(i.costo_unitario) || 0) : s;
      }, 0);
      openPaymentModal(orden.id, orden.proveedor_nombre, total);
    });

    // Payment modal — confirm handler is set per-caller via .onclick (openPaymentModal / openPagoOrden)
    ge('ord-pago-close')    && ge('ord-pago-close').addEventListener('click', () => { ge('ord-pago-overlay').style.display = 'none'; });
    ge('ord-pago-cancelar') && ge('ord-pago-cancelar').addEventListener('click', () => { ge('ord-pago-overlay').style.display = 'none'; });

    // Discrepancia close
    ge('ord-disc-close') && ge('ord-disc-close').addEventListener('click', closeDiscrepanciaModal);

    // Cost changes confirm
    ge('ord-costos-confirmar') && ge('ord-costos-confirmar').addEventListener('click', confirmarCostChanges);

    // Refocus scanner when clicking anywhere in reception left panel
    const recepcionOverlay = ge('ord-recepcion-overlay');
    recepcionOverlay && recepcionOverlay.addEventListener('click', (e) => {
      const scanner = ge('ord-scanner-input');
      const disc    = ge('ord-disc-overlay');
      const pago    = ge('ord-pago-overlay');
      if (!scanner) return;
      if (disc && disc.style.display !== 'none') return;
      if (pago && pago.style.display !== 'none') return;
      if (!e.target.matches('input,button,select,textarea')) {
        scanner.focus();
      }
    });
  }

  // ── INIT ───────────────────────────────────────────────────────────────────

  function init(params) {
    state.user = window.SGA_Auth.getCurrentUser();
    if (!state.user) return;
    attachEvents();
    renderLista();
  }

  return { init };
})();

export default Ordenes;
