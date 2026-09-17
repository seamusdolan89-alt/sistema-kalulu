/**
 * aprobaciones_pendientes.js — Aprobaciones Pendientes (solo Admin-POS + admin)
 *
 * Lista los `stock_ajustes` en estado 'pendiente_aprobacion' y deja
 * aprobarlos o rechazarlos. Unifica dos orígenes que ya escribían ese
 * estado sin que hubiera pantalla para verlo:
 *
 *  - Devoluciones del POS por producto vencido/defectuoso (pos.js) — existe
 *    desde antes, quedaban invisibles acumulándose.
 *  - Ajuste de stock pedido desde "⋯" en Compras — Revisión (compras_v2.js,
 *    motivos Rotura / Consumo / Producto no entregado por proveedor),
 *    encolado en el momento y recién escrito a la base al confirmar el
 *    ingreso de la compra.
 *
 * El stock NO se toca al pedir el ajuste, solo acá, al aprobar -- si se
 * rechaza, no pasa nada. Aprobar además crea el registro en
 * consumo_interno (mismo patrón que ajuste_stock.js) para que quede en el
 * historial de movimientos de stock y en los reportes que ya lo leen.
 */

const AprobacionesPendientes = (() => {
  'use strict';

  const ge   = id => document.getElementById(id);
  const db   = () => window.SGA_DB;
  const esc  = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);
  const nowISO = () => window.SGA_Utils.formatISODate(new Date());

  const MOTIVO_LABEL = {
    devolucion_vencido:    'Devolución — producto vencido',
    devolucion_defectuoso: 'Devolución — producto defectuoso',
  };

  function fmtFecha(f) {
    if (!f) return '—';
    const d = new Date(f);
    return isNaN(d) ? String(f).slice(0, 10) : d.toLocaleDateString('es-AR');
  }

  function cargarPendientes() {
    return db().query(`
      SELECT sa.*,
             p.nombre AS producto_nombre, p.costo AS producto_costo_actual,
             p.precio_venta AS producto_precio_venta,
             u.nombre AS usuario_nombre,
             c.numero_factura, c.factura_pv,
             prov.razon_social AS proveedor_nombre
      FROM stock_ajustes sa
      LEFT JOIN productos p   ON p.id = sa.producto_id
      LEFT JOIN usuarios u    ON u.id = sa.usuario_id
      LEFT JOIN compras c     ON c.id = sa.compra_id
      LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
      WHERE sa.estado = 'pendiente_aprobacion'
      ORDER BY sa.fecha ASC
    `);
  }

  function renderLista() {
    const pendientes = cargarPendientes();
    const tabla = ge('aprob-table');
    const vacio = ge('aprob-empty');
    const cont  = ge('aprob-count');

    if (cont) cont.textContent = pendientes.length ? `(${pendientes.length})` : '';

    if (!pendientes.length) {
      if (tabla) tabla.style.display = 'none';
      if (vacio) vacio.style.display = '';
      return;
    }
    if (vacio) vacio.style.display = 'none';
    if (tabla) tabla.style.display = '';

    const tbody = ge('aprob-tbody');
    tbody.innerHTML = pendientes.map(a => {
      const origen = a.compra_id
        ? `Compra ${esc([a.factura_pv, a.numero_factura].filter(Boolean).join('-') || '')}${a.proveedor_nombre ? ' — ' + esc(a.proveedor_nombre) : ''}`
        : '<span class="aprob-origen-pos">Devolución (POS)</span>';
      const costo = a.costo_unitario != null ? parseFloat(a.costo_unitario) : parseFloat(a.producto_costo_actual) || 0;
      return `
        <tr data-id="${esc(a.id)}">
          <td>${fmtFecha(a.fecha)}</td>
          <td class="aprob-td-prod">${esc(a.producto_nombre || '(producto eliminado)')}</td>
          <td class="c">${a.cantidad}</td>
          <td>${esc(MOTIVO_LABEL[a.motivo] || a.motivo || '—')}</td>
          <td>${esc(a.usuario_nombre || '—')}</td>
          <td>${origen}</td>
          <td class="r">${fmt$(costo * (parseFloat(a.cantidad) || 0))}</td>
          <td class="aprob-td-acciones">
            <button class="btn btn-primary btn-sm" data-aprobar="${esc(a.id)}">✓ Aprobar</button>
            <button class="btn btn-outline btn-sm" data-rechazar="${esc(a.id)}">✗ Rechazar</button>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-aprobar]').forEach(btn =>
      btn.addEventListener('click', () => aprobar(btn.dataset.aprobar))
    );
    tbody.querySelectorAll('[data-rechazar]').forEach(btn =>
      btn.addEventListener('click', () => rechazar(btn.dataset.rechazar))
    );
  }

  function aprobar(id) {
    const a = db().query('SELECT * FROM stock_ajustes WHERE id = ?', [id])[0];
    if (!a) return;
    if (!confirm(`¿Aprobar este ajuste? Se van a descontar ${a.cantidad} unidad(es) del stock.`)) return;

    const admin = window.SGA_Auth.getCurrentUser();
    const ts = nowISO();
    const prod = db().query('SELECT costo, precio_venta FROM productos WHERE id = ?', [a.producto_id])[0] || {};
    const costo = a.costo_unitario != null ? parseFloat(a.costo_unitario) : (parseFloat(prod.costo) || 0);

    db().beginBatch();
    try {
      db().run(
        `UPDATE stock SET cantidad = cantidad - ?, fecha_modificacion = ?, sync_status = 'pending', updated_at = ?
         WHERE producto_id = ? AND sucursal_id = ?`,
        [a.cantidad, ts, ts, a.producto_id, a.sucursal_id]
      );
      db().run(
        `INSERT INTO consumo_interno
           (id, producto_id, sucursal_id, usuario_id, registrado_por_usuario_id,
            cantidad, costo_unitario, precio_venta_unitario, motivo, observaciones, fecha, sync_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [window.SGA_Utils.generateUUID(), a.producto_id, a.sucursal_id,
         a.usuario_id, admin.id, a.cantidad, costo, parseFloat(prod.precio_venta) || 0,
         MOTIVO_LABEL[a.motivo] || a.motivo || 'Ajuste de stock', 'Aprobado desde Aprobaciones Pendientes', ts, ts]
      );
      db().run(
        `UPDATE stock_ajustes SET estado = 'aprobado', aprobado_por = ?, fecha_aprobacion = ?,
           sync_status = 'pending', updated_at = ? WHERE id = ?`,
        [admin.id, ts, ts, id]
      );
      db().commitBatch();
    } catch (e) {
      db().rollbackBatch();
      alert('Error al aprobar: ' + e.message);
      return;
    }

    db().registrarHistorialStock(a.producto_id, a.sucursal_id);
    window.SGA_Utils.showNotification('Ajuste aprobado', 'success');
    window.SGA_Sync?.pushPending?.();
    renderLista();
  }

  function rechazar(id) {
    if (!confirm('¿Rechazar este ajuste? El stock no se modifica.')) return;
    const admin = window.SGA_Auth.getCurrentUser();
    const ts = nowISO();
    db().run(
      `UPDATE stock_ajustes SET estado = 'rechazado', aprobado_por = ?, fecha_aprobacion = ?,
         sync_status = 'pending', updated_at = ? WHERE id = ?`,
      [admin.id, ts, ts, id]
    );
    window.SGA_Utils.showNotification('Ajuste rechazado', 'success');
    window.SGA_Sync?.pushPending?.();
    renderLista();
  }

  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    if (!user || user.rol !== 'admin') {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Acceso restringido. Solo administradores.</div>';
      return;
    }
    if (!window.ADMIN_MODE) {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Esta sección solo está disponible desde ADMIN POS.</div>';
      return;
    }
    renderLista();
  }

  return { init };
})();

window.SGA_AprobacionesPendientes = AprobacionesPendientes;

export default AprobacionesPendientes;
