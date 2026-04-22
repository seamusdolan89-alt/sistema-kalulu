/**
 * informes.js — Reports Module
 */

const Informes = (() => {
  'use strict';

  const REPORTES = [
    { id: 'ventas_producto',    label: 'Ventas por Producto' },
    { id: 'analitica_producto', label: 'Análisis de Productos' },
    { id: 'ventas_transaccion', label: 'Ventas por Transacción' },
    { id: 'quiebres_stock',     label: 'Quiebres de Stock' },
  ];

  const MEDIO_LABEL = {
    efectivo: 'Efectivo', mercadopago: 'MP', tarjeta: 'Tarjeta',
    transferencia: 'Transf.', cuenta_corriente: 'Cta.Cte.', saldo_favor: 'Saldo Fav.',
  };

  const state = {
    reporte: 'ventas_producto',
    desde: '',
    hasta: '',
    sucursalId: null,
    user: null,
    data: null,
  };

  const ge  = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmtPeso = (n) => window.SGA_Utils.formatCurrency(n);
  const fmtNum  = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

  // ── DATE HELPERS ──────────────────────────────────────────────────────────────

  function defaultDesde() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  function defaultHasta() {
    return new Date().toISOString().slice(0, 10);
  }

  function addOneDay(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Local midnight → UTC ISO string, for correct date-boundary filtering.
  function toUTC(dateStr) {
    return new Date(dateStr + 'T00:00:00').toISOString();
  }

  function fmtPeriodo() {
    const [dy, dm, dd] = state.desde.split('-');
    const [hy, hm, hd] = state.hasta.split('-');
    return `${dd}/${dm}/${dy} al ${hd}/${hm}/${hy}`;
  }

  // ── QUERIES ───────────────────────────────────────────────────────────────────

  function queryVentasProducto() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        p.id,
        COALESCE(cb.codigo, '') AS codigo,
        p.nombre,
        COALESCE(cat.nombre, '') AS categoria,
        COALESCE(pr.razon_social, '') AS proveedor,
        p.costo AS costo_actual,
        p.precio_venta AS precio_actual,
        COALESCE(s.cantidad, 0) AS stock_actual,
        p.stock_minimo,
        SUM(vi.cantidad) AS cant_vendida,
        SUM(vi.cantidad * vi.costo_unitario) AS costo_total,
        SUM(vi.subtotal) AS venta_total,
        SUM(vi.subtotal) - SUM(vi.cantidad * vi.costo_unitario) AS utilidad,
        CASE WHEN SUM(vi.subtotal) > 0
          THEN ROUND((SUM(vi.subtotal) - SUM(vi.cantidad * vi.costo_unitario)) * 100.0 / SUM(vi.subtotal), 1)
          ELSE 0
        END AS margen_pct
      FROM venta_items vi
      JOIN ventas v ON vi.venta_id = v.id
        AND v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      JOIN productos p ON vi.producto_id = p.id
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      LEFT JOIN categorias cat ON p.categoria_id = cat.id
      LEFT JOIN proveedores pr ON p.proveedor_principal_id = pr.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      GROUP BY p.id
      ORDER BY venta_total DESC
    `, [sid, desde, hasta, sid]);
  }

  function queryVentasTransaccion() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        v.id,
        v.fecha,
        COALESCE(u.nombre, 'Sistema') AS vendedor,
        v.subtotal,
        v.descuento,
        v.total,
        COALESCE(c.nombre || ' ' || c.apellido, '') AS cliente,
        v.cliente_id,
        GROUP_CONCAT(vp.medio || ':' || vp.monto, '|') AS pagos_raw
      FROM ventas v
      LEFT JOIN usuarios u ON v.usuario_id = u.id
      LEFT JOIN clientes c ON v.cliente_id = c.id
      LEFT JOIN venta_pagos vp ON vp.venta_id = v.id
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY v.id
      ORDER BY v.fecha DESC
    `, [sid, desde, hasta]);
  }

  function queryQuiebresStock() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        p.id,
        COALESCE(cb.codigo, '') AS codigo,
        p.nombre,
        COALESCE(pr.razon_social, '') AS proveedor,
        COALESCE(s.cantidad, 0) AS stock_actual,
        p.stock_minimo,
        SUM(oci.cantidad_pedida) AS total_pedido,
        COALESCE(SUM(oci.cantidad_recibida), 0) AS total_recibido_orden,
        COUNT(DISTINCT oc.id) AS num_ordenes,
        (
          SELECT COALESCE(SUM(ci2.cantidad), 0)
          FROM compra_items ci2
          JOIN compras c2 ON ci2.compra_id = c2.id
          WHERE ci2.producto_id = p.id
            AND c2.sucursal_id = ?
            AND c2.fecha >= ? AND c2.fecha < ?
        ) AS recibido_compras,
        (
          SELECT COUNT(*) FROM producto_sustitutos ps
          WHERE ps.producto_id = p.id AND ps.activo = 1
        ) AS tiene_sustituto
      FROM orden_compra_items oci
      JOIN ordenes_compra oc ON oci.orden_id = oc.id
        AND oc.sucursal_id = ?
        AND oc.fecha_creacion >= ? AND oc.fecha_creacion < ?
        AND oc.estado NOT IN ('borrador')
      JOIN productos p ON oci.producto_id = p.id
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      LEFT JOIN proveedores pr ON p.proveedor_principal_id = pr.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      GROUP BY p.id
      HAVING recibido_compras = 0
      ORDER BY tiene_sustituto ASC, stock_actual ASC, p.nombre
    `, [sid, desde, hasta, sid, desde, hasta, sid]);
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────

  function init() {
    state.user       = window.SGA_Auth.getCurrentUser();
    state.sucursalId = state.user?.sucursal_id || 1;
    state.desde      = defaultDesde();
    state.hasta      = defaultHasta();

    const root = ge('inf-root');
    if (!root) return;

    root.innerHTML = renderShell();
    attachListeners();
  }

  function renderShell() {
    return `
      <div class="inf-toolbar">
        <h2 class="inf-title">📊 Informes</h2>
        <div class="inf-toolbar-controls">
          <div class="inf-control-group">
            <label>Reporte</label>
            <select id="inf-sel-reporte" class="inf-select">
              ${REPORTES.map(r => `<option value="${r.id}"${r.id === state.reporte ? ' selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </div>
          <div class="inf-control-group">
            <label>Desde</label>
            <input type="date" id="inf-desde" class="inf-date" value="${state.desde}">
          </div>
          <div class="inf-control-group">
            <label>Hasta</label>
            <input type="date" id="inf-hasta" class="inf-date" value="${state.hasta}">
          </div>
          <div class="inf-quick-btns">
            <button class="btn btn-xs" data-period="week">Sem.</button>
            <button class="btn btn-xs" data-period="month">Este mes</button>
            <button class="btn btn-xs" data-period="prev-month">Mes ant.</button>
            <button class="btn btn-xs" data-period="year">Este año</button>
          </div>
          <button id="inf-btn-generar" class="btn btn-primary">Generar</button>
        </div>
      </div>
      <div id="inf-results" class="inf-results-area">
        <div class="inf-empty-state">
          <div class="inf-empty-icon">📊</div>
          <p>Seleccioná un reporte y período, luego presioná <strong>Generar</strong>.</p>
        </div>
      </div>
    `;
  }

  function attachListeners() {
    ge('inf-btn-generar')?.addEventListener('click', generar);
    ge('inf-sel-reporte')?.addEventListener('change', e => { state.reporte = e.target.value; });
    ge('inf-desde')?.addEventListener('change', e => { state.desde = e.target.value; });
    ge('inf-hasta')?.addEventListener('change', e => { state.hasta = e.target.value; });

    document.querySelectorAll('[data-period]').forEach(btn => {
      btn.addEventListener('click', () => setQuickPeriod(btn.dataset.period));
    });
  }

  function setQuickPeriod(period) {
    const now = new Date();
    if (period === 'week') {
      const mon = new Date(now);
      mon.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
      state.desde = mon.toISOString().slice(0, 10);
      state.hasta = now.toISOString().slice(0, 10);
    } else if (period === 'month') {
      state.desde = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      state.hasta = now.toISOString().slice(0, 10);
    } else if (period === 'prev-month') {
      const pm     = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const pmLast = new Date(now.getFullYear(), now.getMonth(), 0);
      state.desde  = pm.toISOString().slice(0, 10);
      state.hasta  = pmLast.toISOString().slice(0, 10);
    } else if (period === 'year') {
      state.desde = `${now.getFullYear()}-01-01`;
      state.hasta = now.toISOString().slice(0, 10);
    }
    if (ge('inf-desde')) ge('inf-desde').value = state.desde;
    if (ge('inf-hasta')) ge('inf-hasta').value = state.hasta;
    generar();
  }

  function generar() {
    const resultsEl = ge('inf-results');
    if (!resultsEl) return;

    state.reporte = ge('inf-sel-reporte')?.value || state.reporte;
    state.desde   = ge('inf-desde')?.value       || state.desde;
    state.hasta   = ge('inf-hasta')?.value        || state.hasta;

    if (!state.desde || !state.hasta) {
      resultsEl.innerHTML = `<div class="inf-error">Seleccioná el período completo.</div>`;
      return;
    }
    if (state.desde > state.hasta) {
      resultsEl.innerHTML = `<div class="inf-error">La fecha de inicio debe ser anterior o igual a la fecha de fin.</div>`;
      return;
    }

    resultsEl.innerHTML = `<div class="inf-loading">Generando reporte...</div>`;

    setTimeout(() => {
      try {
        switch (state.reporte) {
          case 'ventas_producto':
            state.data = queryVentasProducto();
            resultsEl.innerHTML = renderVentasProducto(state.data);
            break;
          case 'analitica_producto':
            state.data = queryVentasProducto();
            resultsEl.innerHTML = renderAnaliticaProductos(state.data);
            break;
          case 'ventas_transaccion':
            state.data = queryVentasTransaccion();
            resultsEl.innerHTML = renderVentasTransaccion(state.data);
            break;
          case 'quiebres_stock':
            state.data = queryQuiebresStock();
            resultsEl.innerHTML = renderQuiebresStock(state.data);
            break;
          default:
            resultsEl.innerHTML = `<div class="inf-error">Reporte no reconocido.</div>`;
        }
        attachExportListeners();
      } catch (e) {
        console.error('[Informes]', e);
        resultsEl.innerHTML = `<div class="inf-error">Error al generar el reporte: ${esc(e.message)}</div>`;
      }
    }, 0);
  }

  // ── SHARED COMPONENTS ─────────────────────────────────────────────────────────

  function reportHeader(titulo) {
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>${esc(titulo)}</h3>
          <span class="inf-periodo">Período: ${esc(fmtPeriodo())}</span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
    `;
  }

  // ── REPORT 1: Ventas por Producto ─────────────────────────────────────────────

  function renderVentasProducto(rows) {
    const tot = rows.reduce((acc, r) => ({
      cant:     acc.cant     + (r.cant_vendida || 0),
      costo:    acc.costo    + (r.costo_total  || 0),
      venta:    acc.venta    + (r.venta_total  || 0),
      utilidad: acc.utilidad + (r.utilidad     || 0),
    }), { cant: 0, costo: 0, venta: 0, utilidad: 0 });

    const margenTotal = tot.venta > 0 ? (tot.utilidad / tot.venta * 100).toFixed(1) : '0.0';

    return `
      ${reportHeader('Ventas por Producto')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Productos</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Unidades vendidas</div><div class="inf-kpi-value">${fmtNum(tot.cant)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Costo total</div><div class="inf-kpi-value">${fmtPeso(tot.costo)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Venta total</div><div class="inf-kpi-value">${fmtPeso(tot.venta)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Utilidad bruta</div><div class="inf-kpi-value ${tot.utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.utilidad)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Margen promedio</div><div class="inf-kpi-value">${margenTotal}%</div></div>
      </div>
      ${rows.length === 0
        ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>`
        : `<div class="inf-table-wrap">
            <table class="inf-table">
              <thead>
                <tr>
                  <th>Código</th><th>Nombre</th><th>Categoría</th><th>Proveedor</th>
                  <th class="num">Costo act.</th><th class="num">Precio act.</th>
                  <th class="num">Stock act.</th><th class="num">Cant. vend.</th>
                  <th class="num">Costo total</th><th class="num">Venta total</th>
                  <th class="num">Utilidad</th><th class="num">Margen %</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td class="mono">${esc(r.codigo)}</td>
                    <td>${esc(r.nombre)}</td>
                    <td>${esc(r.categoria)}</td>
                    <td>${esc(r.proveedor)}</td>
                    <td class="num">${fmtPeso(r.costo_actual)}</td>
                    <td class="num">${fmtPeso(r.precio_actual)}</td>
                    <td class="num ${r.stock_actual <= 0 ? 'text-danger' : r.stock_actual <= r.stock_minimo ? 'text-warning' : ''}">${fmtNum(r.stock_actual)}</td>
                    <td class="num">${fmtNum(r.cant_vendida)}</td>
                    <td class="num">${fmtPeso(r.costo_total)}</td>
                    <td class="num bold">${fmtPeso(r.venta_total)}</td>
                    <td class="num ${r.utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(r.utilidad)}</td>
                    <td class="num">${r.margen_pct}%</td>
                  </tr>
                `).join('')}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="7">TOTAL</td>
                  <td class="num">${fmtNum(tot.cant)}</td>
                  <td class="num">${fmtPeso(tot.costo)}</td>
                  <td class="num">${fmtPeso(tot.venta)}</td>
                  <td class="num ${tot.utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.utilidad)}</td>
                  <td class="num">${margenTotal}%</td>
                </tr>
              </tfoot>
            </table>
          </div>`
      }
    `;
  }

  // ── REPORT 2: Análisis de Productos ──────────────────────────────────────────

  function renderAnaliticaProductos(rows) {
    if (!rows.length) {
      return reportHeader('Análisis de Productos') +
        `<div class="inf-empty">No hay ventas en el período seleccionado.</div>`;
    }

    const totalVentas   = rows.reduce((s, r) => s + (r.venta_total || 0), 0);
    const totalCosto    = rows.reduce((s, r) => s + (r.costo_total || 0), 0);
    const utilidad      = totalVentas - totalCosto;
    const margenPct     = totalVentas > 0 ? (utilidad / totalVentas * 100).toFixed(1) : '0.0';
    const totalUnidades = rows.reduce((s, r) => s + (r.cant_vendida || 0), 0);

    const topVentas   = [...rows].sort((a, b) => b.venta_total   - a.venta_total).slice(0, 10);
    const topCantidad = [...rows].sort((a, b) => b.cant_vendida  - a.cant_vendida).slice(0, 10);
    const topMargen   = [...rows].sort((a, b) => b.margen_pct    - a.margen_pct).slice(0, 10);
    const lowMargen   = [...rows].filter(r => r.cant_vendida > 0)
                                 .sort((a, b) => a.margen_pct - b.margen_pct).slice(0, 10);

    const miniTable = (data, cols) => `
      <table class="inf-table inf-table-compact">
        <thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.label}</th>`).join('')}</tr></thead>
        <tbody>
          ${data.map((r, i) => `
            <tr>
              <td class="num text-muted">${i + 1}</td>
              <td>${esc(r.nombre)}</td>
              ${cols.slice(2).map(c => `<td class="num">${c.fmt(r)}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    return `
      ${reportHeader('Análisis de Productos')}
      <div class="inf-kpi-row">
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Venta total</div><div class="inf-kpi-value">${fmtPeso(totalVentas)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Costo total</div><div class="inf-kpi-value">${fmtPeso(totalCosto)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Utilidad bruta</div><div class="inf-kpi-value ${utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(utilidad)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Margen</div><div class="inf-kpi-value">${margenPct}%</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Unidades vendidas</div><div class="inf-kpi-value">${fmtNum(totalUnidades)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Productos distintos</div><div class="inf-kpi-value">${rows.length}</div></div>
      </div>
      <div class="inf-analytics-grid">
        <div class="inf-analytics-panel">
          <h4>🏆 Mayor facturación (top 10)</h4>
          ${miniTable(topVentas, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Unid.', cls: 'num', fmt: r => fmtNum(r.cant_vendida) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
          ])}
        </div>
        <div class="inf-analytics-panel">
          <h4>📦 Más vendidos por cantidad (top 10)</h4>
          ${miniTable(topCantidad, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Unidades', cls: 'num', fmt: r => fmtNum(r.cant_vendida) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
          ])}
        </div>
        <div class="inf-analytics-panel">
          <h4>💚 Mayor rentabilidad (top 10)</h4>
          ${miniTable(topMargen, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
            { label: 'Utilidad', cls: 'num', fmt: r => fmtPeso(r.utilidad) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
          ])}
        </div>
        <div class="inf-analytics-panel">
          <h4>🔴 Menor rentabilidad (top 10)</h4>
          ${miniTable(lowMargen, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
            { label: 'Utilidad', cls: 'num', fmt: r => fmtPeso(r.utilidad) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
          ])}
        </div>
      </div>
    `;
  }

  // ── REPORT 3: Ventas por Transacción ─────────────────────────────────────────

  function parsePagos(pagosRaw) {
    if (!pagosRaw) return [];
    return pagosRaw.split('|').map(p => {
      const [medio, monto] = p.split(':');
      return { medio, monto: parseFloat(monto) || 0 };
    });
  }

  function renderVentasTransaccion(rows) {
    const totSubtotal = rows.reduce((s, r) => s + (r.subtotal || 0), 0);
    const totDesc     = rows.reduce((s, r) => s + (r.descuento || 0), 0);
    const totTotal    = rows.reduce((s, r) => s + (r.total || 0), 0);
    const ticketProm  = rows.length ? totTotal / rows.length : 0;

    return `
      ${reportHeader('Ventas por Transacción')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">N° de ventas</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Subtotal bruto</div><div class="inf-kpi-value">${fmtPeso(totSubtotal)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Descuentos</div><div class="inf-kpi-value text-danger">${totDesc > 0 ? '- ' + fmtPeso(totDesc) : fmtPeso(0)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Total cobrado</div><div class="inf-kpi-value">${fmtPeso(totTotal)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Ticket promedio</div><div class="inf-kpi-value">${rows.length ? fmtPeso(ticketProm) : '—'}</div></div>
      </div>
      ${rows.length === 0
        ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>`
        : `<div class="inf-table-wrap">
            <table class="inf-table">
              <thead>
                <tr>
                  <th>N° Venta</th><th>Fecha</th><th>Hora</th><th>Vendedor</th>
                  <th class="num">Subtotal</th><th class="num">Descuento</th>
                  <th class="num">Total</th><th>Forma de pago</th><th>Cliente</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => {
                  const fecha  = new Date(r.fecha);
                  const pagos  = parsePagos(r.pagos_raw);
                  const pagosTags = pagos.map(p => {
                    const cls = `mtag-${p.medio.replace(/_/g, '-')}`;
                    return `<span class="inf-medio-tag ${cls}">${esc(MEDIO_LABEL[p.medio] || p.medio)} ${fmtPeso(p.monto)}</span>`;
                  }).join('');
                  return `
                    <tr>
                      <td class="mono">#${esc(r.id.slice(-6))}</td>
                      <td>${fecha.toLocaleDateString('es-AR')}</td>
                      <td>${fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</td>
                      <td>${esc(r.vendedor)}</td>
                      <td class="num">${fmtPeso(r.subtotal)}</td>
                      <td class="num ${r.descuento > 0 ? 'text-danger' : ''}">${r.descuento > 0 ? '- ' + fmtPeso(r.descuento) : '—'}</td>
                      <td class="num bold">${fmtPeso(r.total)}</td>
                      <td>${pagosTags || '—'}</td>
                      <td>${r.cliente ? esc(r.cliente.trim()) : '<span class="text-muted">Consumidor final</span>'}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="4">TOTAL (${rows.length} venta${rows.length !== 1 ? 's' : ''})</td>
                  <td class="num">${fmtPeso(totSubtotal)}</td>
                  <td class="num text-danger">${totDesc > 0 ? '- ' + fmtPeso(totDesc) : '—'}</td>
                  <td class="num">${fmtPeso(totTotal)}</td>
                  <td colspan="2"></td>
                </tr>
              </tfoot>
            </table>
          </div>`
      }
    `;
  }

  // ── REPORT 4: Quiebres de Stock ───────────────────────────────────────────────

  function renderQuiebresStock(rows) {
    const sinSustituto = rows.filter(r => !r.tiene_sustituto);
    const conSustituto = rows.filter(r =>  r.tiene_sustituto);

    const thead = `
      <thead>
        <tr>
          <th>Código</th><th>Producto</th><th>Proveedor</th>
          <th class="num">Stock actual</th><th class="num">Stock mínimo</th>
          <th class="num">Pedido (OC)</th><th class="num">Recibido (compras)</th>
          <th class="num">Faltante</th><th class="num">Órdenes</th><th>¿Sustituto?</th>
        </tr>
      </thead>
    `;

    const renderRows = (data) => data.map(r => `
      <tr class="${r.stock_actual <= 0 ? 'row-danger' : ''}">
        <td class="mono">${esc(r.codigo)}</td>
        <td>${esc(r.nombre)}</td>
        <td>${esc(r.proveedor)}</td>
        <td class="num ${r.stock_actual <= 0 ? 'text-danger bold' : r.stock_actual <= r.stock_minimo ? 'text-warning' : ''}">${fmtNum(r.stock_actual)}</td>
        <td class="num">${fmtNum(r.stock_minimo)}</td>
        <td class="num">${fmtNum(r.total_pedido)}</td>
        <td class="num">${fmtNum(r.recibido_compras)}</td>
        <td class="num text-danger bold">${fmtNum(r.total_pedido - r.recibido_compras)}</td>
        <td class="num">${r.num_ordenes}</td>
        <td>${r.tiene_sustituto ? '<span class="badge-si">Sí</span>' : '<span class="badge-no">No</span>'}</td>
      </tr>
    `).join('');

    return `
      ${reportHeader('Quiebres de Stock')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Total quiebres</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi danger"><div class="inf-kpi-label">Sin sustituto — acción requerida</div><div class="inf-kpi-value text-danger">${sinSustituto.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Con sustituto</div><div class="inf-kpi-value">${conSustituto.length}</div></div>
      </div>
      ${rows.length === 0
        ? `<div class="inf-empty">No se encontraron quiebres de stock en el período.<br><span class="text-muted" style="font-size:12px">Tip: los quiebres se detectan cuando un producto fue pedido en una orden de compra confirmada pero el proveedor no realizó entrega efectiva en el período.</span></div>`
        : `
          ${sinSustituto.length > 0 ? `
            <div class="inf-section-label danger">🔴 Requieren acción inmediata — sin sustituto (${sinSustituto.length})</div>
            <div class="inf-table-wrap">
              <table class="inf-table">${thead}<tbody>${renderRows(sinSustituto)}</tbody></table>
            </div>
          ` : ''}
          ${conSustituto.length > 0 ? `
            <div class="inf-section-label">🟡 Con sustituto disponible (${conSustituto.length})</div>
            <div class="inf-table-wrap">
              <table class="inf-table">${thead}<tbody>${renderRows(conSustituto)}</tbody></table>
            </div>
          ` : ''}
        `
      }
    `;
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────────

  function attachExportListeners() {
    ge('inf-btn-excel')?.addEventListener('click', exportExcel);
    ge('inf-btn-csv')?.addEventListener('click',   exportCSV);
  }

  function buildExportRows() {
    const rows  = state.data || [];
    const rep   = state.reporte;
    const title = REPORTES.find(r => r.id === rep)?.label || rep;
    const periodo = `Período: ${fmtPeriodo()}`;

    if (rep === 'ventas_producto' || rep === 'analitica_producto') {
      const headers = ['Código','Nombre','Categoría','Proveedor','Costo actual','Precio actual',
                       'Stock actual','Cant. vendida','Costo total','Venta total','Utilidad','Margen %'];
      const data = rows.map(r => [
        r.codigo, r.nombre, r.categoria, r.proveedor,
        r.costo_actual, r.precio_actual, r.stock_actual, r.cant_vendida,
        r.costo_total, r.venta_total, r.utilidad, r.margen_pct,
      ]);
      return { title, periodo, headers, data };
    }

    if (rep === 'ventas_transaccion') {
      const headers = ['N° Venta','Fecha','Hora','Vendedor','Subtotal','Descuento','Total','Forma de pago','Cliente'];
      const data = rows.map(r => {
        const fecha = new Date(r.fecha);
        const pagos = parsePagos(r.pagos_raw)
          .map(p => `${MEDIO_LABEL[p.medio] || p.medio} $${p.monto.toFixed(2)}`).join(', ');
        return [
          '#' + r.id.slice(-6),
          fecha.toLocaleDateString('es-AR'),
          fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
          r.vendedor, r.subtotal, r.descuento, r.total, pagos,
          r.cliente ? r.cliente.trim() : 'Consumidor final',
        ];
      });
      return { title, periodo, headers, data };
    }

    if (rep === 'quiebres_stock') {
      const headers = ['Código','Producto','Proveedor','Stock actual','Stock mínimo',
                       'Pedido (OC)','Recibido (compras)','Faltante','N° Órdenes','¿Tiene sustituto?'];
      const data = rows.map(r => [
        r.codigo, r.nombre, r.proveedor, r.stock_actual, r.stock_minimo,
        r.total_pedido, r.recibido_compras, r.total_pedido - r.recibido_compras,
        r.num_ordenes, r.tiene_sustituto ? 'Sí' : 'No',
      ]);
      return { title, periodo, headers, data };
    }

    return null;
  }

  function exportExcel() {
    if (!window.XLSX) { alert('Librería XLSX no disponible.'); return; }
    const ed = buildExportRows();
    if (!ed) return;

    const wsData = [
      [ed.title],
      [ed.periodo],
      [],
      ed.headers,
      ...ed.data,
    ];

    const ws = window.XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = ed.headers.map(() => ({ wch: 18 }));

    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, ed.title.slice(0, 31));
    window.XLSX.writeFile(wb, `${ed.title.replace(/\s+/g, '_')}_${state.desde}_${state.hasta}.xlsx`);
  }

  function exportCSV() {
    const ed = buildExportRows();
    if (!ed) return;

    const escapeCell = (cell) => {
      const s = String(cell == null ? '' : cell);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const allRows = [[ed.title], [ed.periodo], [], ed.headers, ...ed.data];
    const csv = allRows.map(row => row.map(escapeCell).join(',')).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${ed.title.replace(/\s+/g, '_')}_${state.desde}_${state.hasta}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { init };
})();

export default Informes;
