/**
 * caja_admin.js — Caja Seamus (fondo personal del administrador)
 *
 * Se alimenta automáticamente con cada retiro de la caja del local.
 * Permite registrar pagos a proveedores vinculados a compras del sistema.
 * Solo visible para el rol 'admin'.
 */

const CajaAdminModule = (() => {
  'use strict';

  const ge = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt = (n) => window.SGA_Utils.formatCurrency(n);
  const fmtFecha = (s) => window.SGA_Utils.formatFecha(s);

  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    if (!user || user.rol !== 'admin') {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Acceso restringido. Solo administradores.</div>';
      return;
    }
    renderSaldo();
    renderMovimientos();
    bindEvents();
  }

  // ─── Saldo y totales ─────────────────────────────────────────────────────

  function getSaldoData() {
    const rows = window.SGA_DB.query(
      `SELECT tipo, SUM(monto) as total FROM caja_admin GROUP BY tipo`
    );
    let ingresos = 0, egresos = 0;
    for (const r of rows) {
      if (r.tipo === 'ingreso') ingresos = r.total || 0;
      if (r.tipo === 'egreso')  egresos  = r.total || 0;
    }
    return { ingresos, egresos, saldo: ingresos - egresos };
  }

  function renderSaldo() {
    const { ingresos, egresos, saldo } = getSaldoData();
    const saldoEl = ge('caja-admin-saldo');
    if (saldoEl) {
      saldoEl.textContent = fmt(saldo);
      saldoEl.style.color = saldo >= 0 ? 'var(--color-text)' : '#c62828';
    }
    const ingEl = ge('caja-admin-total-ing');
    const egrEl = ge('caja-admin-total-egr');
    if (ingEl) ingEl.textContent = fmt(ingresos);
    if (egrEl) egrEl.textContent = fmt(egresos);
  }

  // ─── Movimientos ─────────────────────────────────────────────────────────

  function renderMovimientos() {
    const container = ge('caja-admin-movimientos');
    if (!container) return;

    const rows = window.SGA_DB.query(`
      SELECT ca.*,
             c.numero_factura, c.fecha as compra_fecha,
             p.razon_social as proveedor_nombre
      FROM caja_admin ca
      LEFT JOIN compras c ON ca.compra_id = c.id
      LEFT JOIN proveedores p ON (ca.proveedor_id = p.id OR c.proveedor_id = p.id)
      ORDER BY ca.fecha DESC
      LIMIT 200
    `);

    if (!rows.length) {
      container.innerHTML = `
        <div style="padding:40px;text-align:center;color:var(--color-text-secondary);">
          Sin movimientos. Los retiros de caja aparecerán acá automáticamente.
        </div>`;
      return;
    }

    const filas = rows.map(r => {
      const esIngreso = r.tipo === 'ingreso';
      const signo     = esIngreso ? '+' : '-';
      const color     = esIngreso ? '#2e7d32' : '#c62828';
      const icono     = esIngreso ? '↑' : '↓';
      const concepto  = r.concepto || (r.tipo === 'ingreso' ? 'Retiro de caja' : 'Pago');
      const ref       = r.proveedor_nombre
        ? `<span style="font-size:12px;color:var(--color-text-secondary);">· ${esc(r.proveedor_nombre)}${r.numero_factura ? ' — Fctura ' + esc(r.numero_factura) : ''}</span>`
        : '';
      return `
        <tr>
          <td style="color:#888;white-space:nowrap;">${fmtFecha(r.fecha)}</td>
          <td>
            <span style="font-weight:600;color:${color};margin-right:6px;">${icono}</span>
            ${esc(concepto)} ${ref}
          </td>
          <td style="text-align:right;font-weight:700;color:${color};white-space:nowrap;">
            ${signo}${fmt(r.monto)}
          </td>
        </tr>`;
    }).join('');

    container.innerHTML = `
      <table class="table" style="margin:0;">
        <thead>
          <tr>
            <th style="width:120px;">Fecha</th>
            <th>Concepto</th>
            <th style="text-align:right;width:140px;">Monto</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>`;
  }

  // ─── Modal: Registrar Pago ────────────────────────────────────────────────

  function abrirModalPago() {
    const { saldo } = getSaldoData();

    // Poblar proveedores
    const proveedores = window.SGA_DB.query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 ORDER BY razon_social COLLATE NOCASE`
    );
    const provSelect = ge('cadmin-proveedor');
    provSelect.innerHTML = '<option value="">— Todos los proveedores —</option>' +
      proveedores.map(p => `<option value="${esc(p.id)}">${esc(p.razon_social)}</option>`).join('');

    // Poblar compras (todas al inicio)
    cargarCompras('');

    // Mostrar saldo disponible
    const saldoDisp = ge('cadmin-saldo-disponible');
    if (saldoDisp) saldoDisp.textContent = `Saldo disponible en Caja Seamus: ${fmt(saldo)}`;

    ge('cadmin-monto').value = '';
    ge('cadmin-concepto').value = '';
    ge('cadmin-error').style.display = 'none';

    ge('modal-caja-admin-pago').style.display = 'flex';

    // Filtrar compras al cambiar proveedor
    provSelect.onchange = () => cargarCompras(provSelect.value);

    // Pre-llenar monto al seleccionar compra
    ge('cadmin-compra').onchange = () => prellenarMonto();
  }

  function cargarCompras(proveedorId) {
    const compraSelect = ge('cadmin-compra');
    const filtro = proveedorId ? `AND c.proveedor_id = '${proveedorId}'` : '';

    const compras = window.SGA_DB.query(`
      SELECT c.id, c.numero_factura, c.fecha, c.total, c.proveedor_id,
             p.razon_social,
             COALESCE((SELECT SUM(ca.monto) FROM caja_admin ca WHERE ca.compra_id = c.id AND ca.tipo = 'egreso'), 0) AS ya_pagado
      FROM compras c
      LEFT JOIN proveedores p ON c.proveedor_id = p.id
      WHERE 1=1 ${filtro}
      ORDER BY c.fecha DESC
      LIMIT 100
    `);

    compraSelect.innerHTML = '<option value="">— Seleccionar compra —</option>' +
      compras.map(c => {
        const pendiente = (c.total || 0) - (c.ya_pagado || 0);
        const label = `${c.razon_social || 'Sin proveedor'} | ${fmtFecha(c.fecha)} | ${c.numero_factura || 'S/N'} | Pendiente: ${fmt(pendiente)}`;
        return `<option value="${esc(c.id)}" data-total="${c.total}" data-pagado="${c.ya_pagado}" data-proveedor="${esc(c.proveedor_id)}">${esc(label)}</option>`;
      }).join('');

    ge('cadmin-compra-info').style.display = 'none';
  }

  function prellenarMonto() {
    const opt = ge('cadmin-compra').selectedOptions[0];
    if (!opt || !opt.value) {
      ge('cadmin-compra-info').style.display = 'none';
      return;
    }
    const total   = parseFloat(opt.dataset.total)  || 0;
    const pagado  = parseFloat(opt.dataset.pagado) || 0;
    const pendiente = Math.max(0, total - pagado);
    ge('cadmin-monto').value = pendiente || '';
    const info = ge('cadmin-compra-info');
    info.textContent = `Total compra: ${fmt(total)} | Ya pagado desde Caja Seamus: ${fmt(pagado)} | Pendiente: ${fmt(pendiente)}`;
    info.style.display = 'block';
  }

  function confirmarPago() {
    const compraOpt  = ge('cadmin-compra').selectedOptions[0];
    const monto      = parseFloat(ge('cadmin-monto').value);
    const concepto   = ge('cadmin-concepto').value.trim();
    const errorEl    = ge('cadmin-error');

    errorEl.style.display = 'none';

    if (!compraOpt || !compraOpt.value) {
      errorEl.textContent = 'Seleccioná una compra.';
      errorEl.style.display = '';
      return;
    }
    if (!monto || monto <= 0) {
      errorEl.textContent = 'Ingresá un monto válido.';
      errorEl.style.display = '';
      return;
    }

    const { saldo } = getSaldoData();
    if (monto > saldo) {
      errorEl.textContent = `El monto supera el saldo disponible (${fmt(saldo)}).`;
      errorEl.style.display = '';
      return;
    }

    const compraId    = compraOpt.value;
    const proveedorId = compraOpt.dataset.proveedor || null;
    const user        = window.SGA_Auth.getCurrentUser();
    const now         = window.SGA_Utils.formatISODate(new Date());
    const id          = window.SGA_Utils.generateUUID();
    const conceptoFinal = concepto || `Pago compra${compraOpt.text ? ' — ' + compraOpt.text.split('|')[0].trim() : ''}`;

    try {
      window.SGA_DB.run(
        `INSERT INTO caja_admin
          (id, tipo, monto, concepto, compra_id, proveedor_id, fecha, usuario_id, sync_status, updated_at)
         VALUES (?, 'egreso', ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [id, monto, conceptoFinal, compraId, proveedorId, now, user.id, now]
      );

      cerrarModal();
      renderSaldo();
      renderMovimientos();
    } catch (e) {
      errorEl.textContent = 'Error al registrar: ' + e.message;
      errorEl.style.display = '';
    }
  }

  function cerrarModal() {
    ge('modal-caja-admin-pago').style.display = 'none';
    const provSelect = ge('cadmin-proveedor');
    if (provSelect) provSelect.onchange = null;
    const compraSelect = ge('cadmin-compra');
    if (compraSelect) compraSelect.onchange = null;
  }

  // ─── Eventos ─────────────────────────────────────────────────────────────

  function bindEvents() {
    ge('btn-registrar-pago')?.addEventListener('click', abrirModalPago);
    ge('btn-cerrar-modal-pago-admin')?.addEventListener('click', cerrarModal);
    ge('btn-cancelar-pago-admin')?.addEventListener('click', cerrarModal);
    ge('btn-confirmar-pago-admin')?.addEventListener('click', confirmarPago);
    ge('modal-caja-admin-pago')?.addEventListener('click', (e) => {
      if (e.target === ge('modal-caja-admin-pago')) cerrarModal();
    });
  }

  return { init };
})();

export default CajaAdminModule;
