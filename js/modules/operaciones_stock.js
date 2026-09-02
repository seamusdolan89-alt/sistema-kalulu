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
      SELECT ci.*, pr.nombre AS producto_nombre, pr.precio_venta AS producto_precio_venta
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

  // Margen de venta: null si no hay precio cargado (no aplica calificación de color).
  function calcMargenPct(costo, precio) {
    costo  = parseFloat(costo)  || 0;
    precio = parseFloat(precio) || 0;
    if (precio <= 0) return null;
    return ((precio - costo) / precio) * 100;
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

    // En ADMIN POS se agregan dos columnas: Precio Venta (editable, escribe
    // directo en productos.precio_venta) y Margen (calculado contra el costo
    // de ESTA compra) — para poder revisar y corregir de una los precios que
    // el sistema sugirió y se aceptaron sin chequear al confirmar la compra.
    const isAdmin = !!window.ADMIN_MODE;

    body.innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #e0e6ee">
        <div style="font-weight:700;font-size:15px">${esc(compra.proveedor_nombre || '—')}</div>
        <div style="color:#607080;font-size:13px">${esc(fecha)}</div>
        ${factRef !== '—' ? `<div style="color:#607080;font-size:13px">Fact. ${factRef}</div>` : ''}
        <div style="font-size:13px;color:${compra.condicion_pago === 'efectivo' ? '#27ae60' : '#2980b9'}">
          ${compra.condicion_pago === 'efectivo' ? '✓ Efectivo' : '⏳ Pendiente'}
        </div>
      </div>
      <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
        <thead>
          <tr style="background:#f0f2f5">
            <th style="padding:7px 10px;text-align:left;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Producto</th>
            <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Cant.</th>
            <th style="padding:7px 10px;text-align:left;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Unidad</th>
            <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Costo unit.</th>
            <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Descuento</th>
            <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Subtotal</th>
            ${isAdmin ? `
              <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Precio Venta</th>
              <th style="padding:7px 10px;text-align:right;font-weight:700;color:#445566;border-bottom:2px solid #d0d7e3">Margen</th>
            ` : ''}
          </tr>
        </thead>
        <tbody>
          ${(compra.items || []).map((it, idx) => {
            const esAjuste = it.tipo === 'envio' || it.tipo === 'descuento';
            if (esAjuste) {
              const sub = parseFloat(it.subtotal) || 0;
              const icon = it.tipo === 'envio' ? '🚚' : '🏷️';
              return `<tr style="border-bottom:1px solid #eef0f3">
                <td style="padding:7px 10px">${icon} ${esc(it.concepto || (it.tipo === 'envio' ? 'Envío' : 'Descuento'))}</td>
                <td style="padding:7px 10px;text-align:right">—</td>
                <td style="padding:7px 10px;color:#607080">—</td>
                <td style="padding:7px 10px;text-align:right">—</td>
                <td style="padding:7px 10px;text-align:right;color:#607080">—</td>
                <td style="padding:7px 10px;text-align:right;font-weight:600">${sub < 0 ? '− ' : ''}${fmt$(Math.abs(sub))}</td>
                ${isAdmin ? `<td style="padding:7px 10px;text-align:right">—</td><td style="padding:7px 10px;text-align:right">—</td>` : ''}
              </tr>`;
            }
            const descPct = parseFloat(it.descuento_pct) || 0;
            const esMuestra = it.tipo === 'muestra';
            const precioActual = parseFloat(it.producto_precio_venta) || 0;
            // Margen contra el costo de ESTA muestra no dice nada (costo casi
            // $0 a propósito) — no calificar con color en ese caso.
            const margen = esMuestra ? null : calcMargenPct(it.costo_unitario, precioActual);
            const margenColor = margen == null ? '#8090a0' : margen < 0 ? '#c62828' : margen < 15 ? '#e65100' : '#445566';
            return `<tr class="ops-detalle-row" data-idx="${idx}" style="border-bottom:1px solid #eef0f3${esMuestra ? ';background:#f6f2ff' : ''}">
              <td style="padding:7px 10px">${esc(it.producto_nombre || '—')}${esMuestra ? ' <span style="font-size:10px;font-weight:700;color:#6a1fc9">🎁 Muestra</span>' : ''}</td>
              <td style="padding:7px 10px;text-align:right">${it.cantidad}</td>
              <td style="padding:7px 10px;color:#607080">${esc(it.unidad_compra || 'Unidad')}</td>
              <td style="padding:7px 10px;text-align:right">${fmt$(it.costo_unitario)}</td>
              <td style="padding:7px 10px;text-align:right;color:#607080">${descPct > 0.001 ? descPct.toFixed(1) + '%' : '—'}</td>
              <td style="padding:7px 10px;text-align:right;font-weight:600">${fmt$(it.subtotal)}</td>
              ${isAdmin ? (
                it.producto_id
                  ? `<td style="padding:5px 10px;text-align:right">
                       <input type="number" class="ops-precio-input" data-idx="${idx}" data-prodid="${esc(it.producto_id)}"
                              value="${precioActual.toFixed(2)}" min="0" step="any"
                              style="width:92px;padding:4px 6px;border:1px solid #c8d0dc;border-radius:4px;text-align:right;font-size:13px">
                     </td>
                     <td class="ops-margen-cell" data-idx="${idx}" style="padding:7px 10px;text-align:right;font-weight:700;color:${margenColor}">
                       ${margen == null ? '—' : margen.toFixed(1) + '%'}
                     </td>`
                  : `<td style="padding:7px 10px;text-align:right">—</td><td style="padding:7px 10px;text-align:right">—</td>`
              ) : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <div style="text-align:right;font-size:16px;font-weight:800;color:#1a2e4a">Total: ${fmt$(compra.total || 0)}</div>
    `;

    overlay.style.display = 'flex';

    if (isAdmin) {
      body.querySelectorAll('.ops-precio-input').forEach(inp => {
        inp.addEventListener('blur', () => {
          const idx    = parseInt(inp.dataset.idx);
          const prodId = inp.dataset.prodid;
          const item   = compra.items[idx];
          const nuevoPrecio = parseFloat(inp.value);
          if (isNaN(nuevoPrecio) || nuevoPrecio < 0) { inp.value = (parseFloat(item.producto_precio_venta) || 0).toFixed(2); return; }
          if (Math.abs(nuevoPrecio - (parseFloat(item.producto_precio_venta) || 0)) < 0.001) return; // sin cambios

          const ts = window.SGA_Utils.formatISODate(new Date());
          db().run(
            `UPDATE productos SET precio_venta=?, ultima_modificacion_precio=?, sync_status='pending', updated_at=? WHERE id=?`,
            [nuevoPrecio, ts, ts, prodId]
          );
          item.producto_precio_venta = nuevoPrecio;
          inp.value = nuevoPrecio.toFixed(2);

          const margenCell = body.querySelector(`.ops-margen-cell[data-idx="${idx}"]`);
          if (margenCell) {
            const esMuestra = item.tipo === 'muestra';
            const margen = esMuestra ? null : calcMargenPct(item.costo_unitario, nuevoPrecio);
            const color = margen == null ? '#8090a0' : margen < 0 ? '#c62828' : margen < 15 ? '#e65100' : '#445566';
            margenCell.style.color = color;
            margenCell.textContent = margen == null ? '—' : margen.toFixed(1) + '%';
          }
          window.SGA_Utils.showNotification('Precio actualizado', 'success', 1500);
        });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      });
    }
  }

  // ── KPIs Y ACTIVIDAD RECIENTE ──────────────────────────────────────────────
  // Antes esta pantalla era solo dos filas de botones sin ningún dato — no
  // había forma de saber si algo estaba pasando sin entrar a cada submódulo.
  // (hallazgo del recorrido UX, ver memoria project_ux_pass_ui_ux_pro_max.md)

  const TIPO_LABEL = {
    rotura: 'Rotura', vencimiento: 'Vencimiento', consumo_interno: 'Consumo interno',
    ajuste_positivo: 'Ajuste (+)', ajuste_negativo: 'Ajuste (−)',
  };

  function renderKpis() {
    const user = window.SGA_Auth.getCurrentUser();
    const sucursalId = user?.sucursal_id || '1';
    const inicioMes = new Date();
    inicioMes.setDate(1);
    const desde = inicioMes.toISOString().slice(0, 10);

    let bajoMinimo = 0;
    try {
      bajoMinimo = db().query(`
        SELECT COUNT(*) AS n
        FROM productos p
        LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
        WHERE p.activo = 1 AND COALESCE(s.cantidad, 0) < p.stock_minimo
      `, [sucursalId])[0]?.n || 0;
    } catch (e) { console.warn('KPI bajo mínimo:', e.message); }

    let porTipo = {};
    try {
      db().query(`
        SELECT tipo, COUNT(*) AS n
        FROM stock_ajustes
        WHERE sucursal_id = ? AND fecha >= ? AND tipo IN ('rotura','vencimiento','consumo_interno')
        GROUP BY tipo
      `, [sucursalId, desde]).forEach(r => { porTipo[r.tipo] = r.n; });
    } catch (e) { console.warn('KPI movimientos del mes:', e.message); }

    if (ge('ops-kpi-bajominimo'))    ge('ops-kpi-bajominimo').textContent    = bajoMinimo;
    if (ge('ops-kpi-roturas'))       ge('ops-kpi-roturas').textContent       = porTipo.rotura || 0;
    if (ge('ops-kpi-vencimientos'))  ge('ops-kpi-vencimientos').textContent  = porTipo.vencimiento || 0;
    if (ge('ops-kpi-consumo'))       ge('ops-kpi-consumo').textContent       = porTipo.consumo_interno || 0;
  }

  function renderActividadReciente() {
    const cont = ge('ops-activity');
    if (!cont) return;
    const user = window.SGA_Auth.getCurrentUser();
    const sucursalId = user?.sucursal_id || '1';

    let rows = [];
    try {
      rows = db().query(`
        SELECT sa.tipo, sa.cantidad, sa.fecha, p.nombre AS producto_nombre
        FROM stock_ajustes sa
        LEFT JOIN productos p ON p.id = sa.producto_id
        WHERE sa.sucursal_id = ?
        ORDER BY sa.fecha DESC
        LIMIT 8
      `, [sucursalId]);
    } catch (e) { console.warn('Actividad reciente:', e.message); }

    if (!rows.length) {
      cont.innerHTML = '<div class="ops-activity-empty">Sin movimientos registrados todavía.</div>';
      return;
    }

    cont.innerHTML = rows.map(r => {
      const fecha = r.fecha ? r.fecha.slice(0, 10) : '—';
      const tag = TIPO_LABEL[r.tipo] || r.tipo || '—';
      return `
        <div class="ops-activity-row">
          <span class="ops-activity-tag ${esc(r.tipo || '')}">${esc(tag)}</span>
          <span class="ops-activity-prod">${esc(r.producto_nombre || '—')}</span>
          <span class="ops-activity-cant">${r.cantidad ?? '—'}</span>
          <span class="ops-activity-fecha">${esc(fecha)}</span>
        </div>`;
    }).join('');
  }

  // Botones de esta pantalla que llevan a otro módulo con su propio permiso
  // (ver auth.js / ROUTE_PERMISSION en app.js) — el router ya bloquea el
  // acceso directo por hash, pero ocultar el botón evita el viaje en falso
  // a "Acceso restringido".
  const BOTONES_CON_PERMISO = {
    compras:          'can_compras',
    consumo_interno:  'can_consumo_interno',
    vencimientos:     'can_roturas_vencimientos',
    roturas:          'can_roturas_vencimientos',
  };

  function ocultarBotonesSinPermiso(root) {
    const perm = window.SGA_Permisos;
    if (window.ADMIN_MODE) return; // admin-pos: siempre acceso total, no ocultar nada
    for (const [action, key] of Object.entries(BOTONES_CON_PERMISO)) {
      if (perm.can(key)) continue;
      root.querySelectorAll(`[data-action="${action}"]`).forEach(btn => { btn.style.display = 'none'; });
    }
  }

  function init() {
    const root = document.getElementById('ops-root');
    if (!root) return;

    ocultarBotonesSinPermiso(root);
    renderKpis();
    renderActividadReciente();

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
      if (!btn) return;

      const action = btn.dataset.action;

      // Todo lo marcado como "ops-btn-disabled" es una función real pero sin
      // implementar todavía — antes clickearlo no hacía nada en absoluto
      // (silencioso, se sentía roto). Ahora avisa igual que "Ajuste de
      // stock" ya venía avisando.
      if (btn.classList.contains('ops-btn-disabled')) {
        window.SGA_Utils.showNotification(`${btn.textContent.trim()} — próximamente`, 'info');
        return;
      }

      switch (action) {
        case 'productos':
          window.location.hash = '#productos';
          break;
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
