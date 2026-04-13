'use strict';

const OperacionesStock = (() => {

  const ge  = id => document.getElementById(id);
  const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);
  const db   = () => window.SGA_DB;

  // ── HISTORIAL DE COMPRAS ───────────────────────────────────────────────────

  function getHistorialCompras({ fechaDesde, fechaHasta } = {}) {
    const user = window.SGA_Auth.getCurrentUser();
    const where = ['c.sucursal_id = ?'];
    const params = [user.sucursal_id];
    if (fechaDesde) { where.push('c.fecha >= ?'); params.push(fechaDesde); }
    if (fechaHasta) { where.push('c.fecha <= ?'); params.push(fechaHasta + 'T23:59:59'); }
    return db().query(`
      SELECT c.id, c.fecha, c.numero_factura, c.factura_pv, c.total, c.condicion_pago, c.estado,
             p.razon_social AS proveedor_nombre,
             (SELECT COUNT(*) FROM compra_items ci WHERE ci.compra_id = c.id) AS num_items
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.fecha DESC
    `, params);
  }

  function getDetalleCompra(compraId) {
    const compra = db().query(`
      SELECT c.*, p.razon_social AS proveedor_nombre
      FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE c.id = ?
    `, [compraId])[0];
    if (!compra) return null;
    compra.items = db().query(`
      SELECT ci.*, pr.nombre AS producto_nombre
      FROM compra_items ci
      LEFT JOIN productos pr ON pr.id = ci.producto_id
      WHERE ci.compra_id = ?
      ORDER BY pr.nombre
    `, [compraId]);
    return compra;
  }

  function renderHistorial({ fechaDesde, fechaHasta } = {}) {
    const body = ge('ops-historial-body');
    if (!body) return;

    const compras = getHistorialCompras({ fechaDesde, fechaHasta });

    if (!compras.length) {
      body.innerHTML = '<p style="color:#8090a0;text-align:center;padding:30px 0">Sin compras en el período seleccionado.</p>';
      return;
    }

    const ESTADO_LABEL = {
      borrador: 'Borrador', confirmada: 'Confirmada',
      pendiente_pago: 'Pend. pago', anulada: 'Anulada',
    };
    const ESTADO_COLOR = {
      borrador: '#e67e22', confirmada: '#27ae60',
      pendiente_pago: '#2980b9', anulada: '#c0392b',
    };

    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f0f2f5">
            <th style="padding:8px 10px;text-align:left;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Fecha</th>
            <th style="padding:8px 10px;text-align:left;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Proveedor</th>
            <th style="padding:8px 10px;text-align:left;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Factura</th>
            <th style="padding:8px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Items</th>
            <th style="padding:8px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Total</th>
            <th style="padding:8px 10px;text-align:center;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Estado</th>
            <th style="padding:8px 10px;text-align:center;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Pago</th>
            <th style="padding:8px 10px;border-bottom:2px solid #d0d7e3"></th>
          </tr>
        </thead>
        <tbody>
          ${compras.map(c => {
            const estado = c.estado || 'confirmada';
            const color  = ESTADO_COLOR[estado] || '#445566';
            const label  = ESTADO_LABEL[estado]  || estado;
            const factRef = c.factura_pv && c.numero_factura
              ? `${esc(c.factura_pv)}-${esc(c.numero_factura)}`
              : esc(c.numero_factura || '—');
            const pago  = c.condicion_pago === 'efectivo'  ? '✓ Efectivo'
                        : c.condicion_pago === 'pendiente' ? '⏳ Pendiente'
                        : esc(c.condicion_pago || '—');
            const fecha = c.fecha ? c.fecha.slice(0, 10) : '—';
            return `<tr style="border-bottom:1px solid #eef0f3">
              <td style="padding:8px 10px;color:#445566">${esc(fecha)}</td>
              <td style="padding:8px 10px;font-weight:600">${esc(c.proveedor_nombre || '—')}</td>
              <td style="padding:8px 10px;color:#607080">${factRef}</td>
              <td style="padding:8px 10px;text-align:right;color:#607080">${c.num_items || 0}</td>
              <td style="padding:8px 10px;text-align:right;font-weight:700">${fmt$(c.total || 0)}</td>
              <td style="padding:8px 10px;text-align:center">
                <span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;background:${color}22;color:${color}">${esc(label)}</span>
              </td>
              <td style="padding:8px 10px;text-align:center;font-size:12px;color:#607080">${pago}</td>
              <td style="padding:8px 10px;text-align:center">
                <button style="padding:3px 12px;background:#2e7d32;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px" data-ver-compra="${esc(c.id)}">Ver</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    body.querySelectorAll('[data-ver-compra]').forEach(btn => {
      btn.addEventListener('click', () => renderDetalleCompra(btn.dataset.verCompra));
    });
  }

  function renderDetalleCompra(compraId) {
    const compra = getDetalleCompra(compraId);
    const overlay = ge('ops-detalle-overlay');
    const body    = ge('ops-detalle-body');
    if (!overlay || !body) return;
    if (!compra) { window.SGA_Utils.showNotification('Compra no encontrada', 'error'); return; }

    const fecha = compra.fecha ? compra.fecha.slice(0, 10) : '—';
    const factRef = compra.factura_pv && compra.numero_factura
      ? `${esc(compra.factura_pv)}-${esc(compra.numero_factura)}`
      : esc(compra.numero_factura || '—');

    body.innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #e0e6ee">
        <div style="font-weight:700;font-size:15px">${esc(compra.proveedor_nombre || '—')}</div>
        <div style="color:#607080;font-size:13px">${esc(fecha)}</div>
        ${factRef !== '—' ? `<div style="color:#607080;font-size:13px">Fact. ${factRef}</div>` : ''}
        <div style="font-size:13px;color:${compra.condicion_pago === 'efectivo' ? '#27ae60' : '#2980b9'}">
          ${compra.condicion_pago === 'efectivo' ? '✓ Efectivo' : '⏳ Pendiente'}
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
        <thead>
          <tr style="background:#f0f2f5">
            <th style="padding:7px 10px;text-align:left;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Producto</th>
            <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Cant.</th>
            <th style="padding:7px 10px;text-align:left;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Unidad</th>
            <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Costo unit.</th>
            <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${(compra.items || []).map(it => {
            const subtotal = (parseFloat(it.cantidad) || 0)
                           * (parseFloat(it.unidades_por_paquete) || 1)
                           * (parseFloat(it.costo_unitario) || 0);
            return `<tr style="border-bottom:1px solid #eef0f3">
              <td style="padding:7px 10px">${esc(it.producto_nombre || '—')}</td>
              <td style="padding:7px 10px;text-align:right">${it.cantidad}</td>
              <td style="padding:7px 10px;color:#607080">${esc(it.unidad_compra || 'Unidad')}</td>
              <td style="padding:7px 10px;text-align:right">${fmt$(it.costo_unitario)}</td>
              <td style="padding:7px 10px;text-align:right;font-weight:600">${fmt$(subtotal)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <div style="text-align:right;font-size:16px;font-weight:800;color:#1a2e4a">Total: ${fmt$(compra.total || 0)}</div>
    `;

    overlay.style.display = 'flex';
  }

  function init() {
    const root = document.getElementById('ops-root');
    if (!root) return;

    // Mostrar/ocultar card de ajuste pendiente
    const pendingCard = document.getElementById('ops-pending-card');
    if (pendingCard) {
      pendingCard.style.display = localStorage.getItem('compras_resumen_pending') ? 'block' : 'none';
    }

    // Historial overlays
    ge('ops-historial-close')?.addEventListener('click', () => {
      ge('ops-historial-overlay').style.display = 'none';
    });
    ge('ops-historial-overlay')?.addEventListener('click', e => {
      if (e.target === ge('ops-historial-overlay')) ge('ops-historial-overlay').style.display = 'none';
    });
    ge('ops-hist-filtrar')?.addEventListener('click', () => {
      renderHistorial({
        fechaDesde: ge('ops-hist-desde').value || undefined,
        fechaHasta: ge('ops-hist-hasta').value || undefined,
      });
    });
    ge('ops-hist-limpiar')?.addEventListener('click', () => {
      ge('ops-hist-desde').value = '';
      ge('ops-hist-hasta').value = '';
      renderHistorial();
    });
    ge('ops-detalle-close')?.addEventListener('click', () => {
      ge('ops-detalle-overlay').style.display = 'none';
    });
    ge('ops-detalle-overlay')?.addEventListener('click', e => {
      if (e.target === ge('ops-detalle-overlay')) ge('ops-detalle-overlay').style.display = 'none';
    });

    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.classList.contains('ops-btn-disabled')) return;

      const action = btn.dataset.action;

      switch (action) {
        case 'retomar':
          sessionStorage.setItem('compras_v2_retomar', '1');
          window.location.hash = '#compras';
          break;
        case 'descartar-pendiente':
          if (!confirm('¿Descartás el ajuste de precios pendiente? Esta acción no se puede deshacer.')) return;
          localStorage.removeItem('compras_resumen_pending');
          localStorage.removeItem('compras_resumen_editados');
          if (pendingCard) pendingCard.style.display = 'none';
          break;
        case 'compras':
          window.location.hash = '#compras_v2';
          break;
        case 'historial_compras':
          ge('ops-hist-desde').value = '';
          ge('ops-hist-hasta').value = '';
          renderHistorial();
          ge('ops-historial-overlay').style.display = 'flex';
          break;
        case 'devolucion':
          window.location.hash = '#pos/devolucion';
          break;
        case 'ajuste_stock':
          window.SGA_Utils.showNotification('Ajuste de stock — próximamente', 'info');
          break;
        case 'consumo_interno':
          window.location.hash = '#consumo_interno';
          break;
        case 'vencimientos':
          window.location.hash = '#vencimientos';
          break;
        case 'roturas':
          window.location.hash = '#roturas';
          break;
        default:
          break;
      }
    });
  }

  return { init };
})();

export default OperacionesStock;
