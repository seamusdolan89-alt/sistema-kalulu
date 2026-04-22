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
    { id: 'ventas_vendedor',    label: 'Ventas por Vendedor' },
    { id: 'aging_cc',           label: 'Aging Cuenta Corriente' },
    { id: 'resumen_diario',     label: 'Resumen Diario de Caja' },
    { id: 'stock_muerto',       label: 'Stock sin Movimiento' },
  ];

  const MEDIO_LABEL = {
    efectivo: 'Efectivo', mercadopago: 'MP', tarjeta: 'Tarjeta',
    transferencia: 'Transf.', cuenta_corriente: 'Cta.Cte.',
  };

  const state = {
    reporte: 'ventas_producto',
    desde: '',
    hasta: '',
    sucursalId: null,
    user: null,
    data: null,
    diasSinMovimiento: 90,
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
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function addOneDay(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Local midnight → UTC ISO string for correct date-boundary filtering
  function toUTC(dateStr) {
    return new Date(dateStr + 'T00:00:00').toISOString();
  }

  function fmtFechaCorta(isoStr) {
    if (!isoStr) return '—';
    const [y, m, d] = isoStr.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }

  function fmtPeriodo() {
    return `${fmtFechaCorta(state.desde)} al ${fmtFechaCorta(state.hasta)}`;
  }

  function daysSince(isoStr) {
    if (!isoStr) return null;
    return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
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

  function queryVentasVendedor() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;

    const ventas = window.SGA_DB.query(`
      SELECT
        u.id,
        u.nombre AS vendedor,
        COUNT(DISTINCT v.id) AS num_ventas,
        SUM(v.subtotal) AS subtotal_bruto,
        SUM(COALESCE(v.descuento, 0)) AS descuentos,
        SUM(v.total) AS total_ventas
      FROM ventas v
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY u.id
      ORDER BY total_ventas DESC
    `, [sid, desde, hasta]);

    const devs = window.SGA_DB.query(`
      SELECT
        v_orig.usuario_id,
        SUM(di.cantidad * di.precio_unitario) AS total_devuelto,
        COUNT(DISTINCT d.id) AS num_devoluciones
      FROM devoluciones d
      JOIN devolucion_items di ON di.devolucion_id = d.id
      JOIN ventas v_orig ON d.venta_id = v_orig.id
      WHERE d.fecha >= ? AND d.fecha < ?
        AND d.sucursal_id = ?
      GROUP BY v_orig.usuario_id
    `, [desde, hasta, sid]);

    const devMap = {};
    devs.forEach(r => { devMap[r.usuario_id] = r; });

    return ventas.map(r => ({
      ...r,
      total_devuelto:    devMap[r.id]?.total_devuelto    || 0,
      num_devoluciones:  devMap[r.id]?.num_devoluciones  || 0,
      total_neto: r.total_ventas - (devMap[r.id]?.total_devuelto || 0),
    }));
  }

  function queryAgingCC() {
    const sid = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        c.id,
        c.nombre,
        c.apellido,
        COALESCE(c.telefono, '') AS telefono,
        COALESCE(c.tope_deuda, 0) AS tope_deuda,
        SUM(cc.monto) AS balance,
        MIN(CASE WHEN cc.tipo = 'venta_fiada' THEN cc.fecha END) AS primera_deuda,
        MAX(CASE WHEN cc.tipo = 'venta_fiada' THEN cc.fecha END) AS ultima_compra,
        MAX(CASE WHEN cc.tipo = 'pago'        THEN cc.fecha END) AS ultimo_pago
      FROM clientes c
      JOIN cuenta_corriente cc ON cc.cliente_id = c.id AND cc.sucursal_id = ?
      GROUP BY c.id
      HAVING balance > 0.01
      ORDER BY balance DESC
    `, [sid]);
  }

  function queryResumenDiario() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;

    const cobros = window.SGA_DB.query(`
      SELECT
        SUBSTR(v.fecha, 1, 10) AS dia,
        SUM(CASE WHEN vp.medio = 'efectivo'         THEN vp.monto ELSE 0 END) AS efectivo,
        SUM(CASE WHEN vp.medio = 'mercadopago'      THEN vp.monto ELSE 0 END) AS mercadopago,
        SUM(CASE WHEN vp.medio = 'tarjeta'          THEN vp.monto ELSE 0 END) AS tarjeta,
        SUM(CASE WHEN vp.medio = 'transferencia'    THEN vp.monto ELSE 0 END) AS transferencia,
        SUM(CASE WHEN vp.medio = 'cuenta_corriente' THEN vp.monto ELSE 0 END) AS cuenta_corriente,
        SUM(CASE WHEN vp.medio != 'cuenta_corriente' THEN vp.monto ELSE 0 END) AS total_cobrado,
        COUNT(DISTINCT v.id) AS num_ventas
      FROM ventas v
      JOIN venta_pagos vp ON vp.venta_id = v.id
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY SUBSTR(v.fecha, 1, 10)
      ORDER BY dia ASC
    `, [sid, desde, hasta]);

    const egresos = window.SGA_DB.query(`
      SELECT
        SUBSTR(e.fecha, 1, 10) AS dia,
        SUM(e.monto) AS egresos
      FROM egresos_caja e
      JOIN sesiones_caja sc ON e.sesion_caja_id = sc.id
      WHERE sc.sucursal_id = ?
        AND e.fecha >= ? AND e.fecha < ?
      GROUP BY SUBSTR(e.fecha, 1, 10)
    `, [sid, desde, hasta]);

    const egresoMap = {};
    egresos.forEach(r => { egresoMap[r.dia] = r.egresos; });

    return cobros.map(r => ({
      ...r,
      egresos: egresoMap[r.dia] || 0,
      neto: r.total_cobrado - (egresoMap[r.dia] || 0),
    }));
  }

  function queryStockMuerto() {
    const sid    = state.sucursalId;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - state.diasSinMovimiento);
    const cutoffISO = cutoff.toISOString();

    return window.SGA_DB.query(`
      SELECT
        p.id,
        COALESCE(cb.codigo, '') AS codigo,
        p.nombre,
        COALESCE(cat.nombre, '') AS categoria,
        COALESCE(pr.razon_social, '') AS proveedor,
        COALESCE(s.cantidad, 0) AS stock_actual,
        p.costo,
        COALESCE(s.cantidad, 0) * p.costo AS costo_inmovilizado,
        MAX(v.fecha) AS ultima_venta
      FROM productos p
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      LEFT JOIN categorias cat ON p.categoria_id = cat.id
      LEFT JOIN proveedores pr ON p.proveedor_principal_id = pr.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      LEFT JOIN venta_items vi ON vi.producto_id = p.id
      LEFT JOIN ventas v ON vi.venta_id = v.id
        AND v.estado = 'completada'
        AND v.sucursal_id = ?
      WHERE COALESCE(s.cantidad, 0) > 0
      GROUP BY p.id
      HAVING MAX(v.fecha) IS NULL OR MAX(v.fecha) < ?
      ORDER BY costo_inmovilizado DESC, ultima_venta ASC
    `, [sid, sid, cutoffISO]);
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
      <div id="inf-extra-bar"></div>
      <div id="inf-results" class="inf-results-area">
        <div class="inf-empty-state">
          <div class="inf-empty-icon">📊</div>
          <p>Seleccioná un reporte y período, luego presioná <strong>Generar</strong>.</p>
        </div>
      </div>
    `;
  }

  function updateExtraBar() {
    const bar = ge('inf-extra-bar');
    if (!bar) return;
    if (state.reporte === 'stock_muerto') {
      bar.innerHTML = `
        <div class="inf-extra-bar-inner">
          <label>Días sin movimiento</label>
          <select id="inf-dias-sin-mov" class="inf-select" style="min-width:120px">
            ${[30,60,90,180,365].map(d =>
              `<option value="${d}"${d === state.diasSinMovimiento ? ' selected' : ''}>${d} días</option>`
            ).join('')}
          </select>
        </div>
      `;
      ge('inf-dias-sin-mov')?.addEventListener('change', e => {
        state.diasSinMovimiento = Number(e.target.value);
      });
    } else if (state.reporte === 'aging_cc') {
      bar.innerHTML = `
        <div class="inf-extra-bar-inner" style="font-size:13px;color:var(--color-text-secondary)">
          Este reporte no usa filtro de período — muestra el estado actual de todas las cuentas corrientes con saldo deudor.
        </div>
      `;
    } else {
      bar.innerHTML = '';
    }
  }

  function attachListeners() {
    ge('inf-btn-generar')?.addEventListener('click', generar);
    ge('inf-sel-reporte')?.addEventListener('change', e => {
      state.reporte = e.target.value;
      updateExtraBar();
    });
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
      state.hasta = defaultHasta();
    } else if (period === 'prev-month') {
      const pm     = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const pmLast = new Date(now.getFullYear(), now.getMonth(), 0);
      state.desde  = pm.toISOString().slice(0, 10);
      state.hasta  = pmLast.toISOString().slice(0, 10);
    } else if (period === 'year') {
      state.desde = `${now.getFullYear()}-01-01`;
      state.hasta = defaultHasta();
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

    const needsPeriod = !['aging_cc', 'stock_muerto'].includes(state.reporte);
    if (needsPeriod && (!state.desde || !state.hasta)) {
      resultsEl.innerHTML = `<div class="inf-error">Seleccioná el período completo.</div>`;
      return;
    }
    if (needsPeriod && state.desde > state.hasta) {
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
          case 'ventas_vendedor':
            state.data = queryVentasVendedor();
            resultsEl.innerHTML = renderVentasVendedor(state.data);
            break;
          case 'aging_cc':
            state.data = queryAgingCC();
            resultsEl.innerHTML = renderAgingCC(state.data);
            break;
          case 'resumen_diario':
            state.data = queryResumenDiario();
            resultsEl.innerHTML = renderResumenDiario(state.data);
            break;
          case 'stock_muerto':
            state.data = queryStockMuerto();
            resultsEl.innerHTML = renderStockMuerto(state.data);
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

  function reportHeader(titulo, sinExport = false) {
    const exportBtns = sinExport ? '' : `
      <div class="inf-export-btns">
        <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
        <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
      </div>
    `;
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>${esc(titulo)}</h3>
          <span class="inf-periodo">Período: ${esc(fmtPeriodo())}</span>
        </div>
        ${exportBtns}
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
      ${rows.length === 0 ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Código</th><th>Nombre</th><th>Categoría</th><th>Proveedor</th>
              <th class="num">Costo act.</th><th class="num">Precio act.</th>
              <th class="num">Stock act.</th><th class="num">Cant. vend.</th>
              <th class="num">Costo total</th><th class="num">Venta total</th>
              <th class="num">Utilidad</th><th class="num">Margen %</th>
            </tr></thead>
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
            <tfoot><tr>
              <td colspan="7">TOTAL</td>
              <td class="num">${fmtNum(tot.cant)}</td>
              <td class="num">${fmtPeso(tot.costo)}</td>
              <td class="num">${fmtPeso(tot.venta)}</td>
              <td class="num ${tot.utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.utilidad)}</td>
              <td class="num">${margenTotal}%</td>
            </tr></tfoot>
          </table>
        </div>
      `}
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
    const topVentas     = [...rows].sort((a, b) => b.venta_total  - a.venta_total).slice(0, 10);
    const topCantidad   = [...rows].sort((a, b) => b.cant_vendida - a.cant_vendida).slice(0, 10);
    const topMargen     = [...rows].sort((a, b) => b.margen_pct   - a.margen_pct).slice(0, 10);
    const lowMargen     = [...rows].filter(r => r.cant_vendida > 0).sort((a, b) => a.margen_pct - b.margen_pct).slice(0, 10);

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
    return `
      ${reportHeader('Ventas por Transacción')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">N° de ventas</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Subtotal bruto</div><div class="inf-kpi-value">${fmtPeso(totSubtotal)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Descuentos</div><div class="inf-kpi-value text-danger">${totDesc > 0 ? '- ' + fmtPeso(totDesc) : fmtPeso(0)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Total cobrado</div><div class="inf-kpi-value">${fmtPeso(totTotal)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Ticket promedio</div><div class="inf-kpi-value">${rows.length ? fmtPeso(totTotal / rows.length) : '—'}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>N° Venta</th><th>Fecha</th><th>Hora</th><th>Vendedor</th>
              <th class="num">Subtotal</th><th class="num">Descuento</th>
              <th class="num">Total</th><th>Forma de pago</th><th>Cliente</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const fecha     = new Date(r.fecha);
                const pagosTags = parsePagos(r.pagos_raw).map(p => {
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
            <tfoot><tr>
              <td colspan="4">TOTAL (${rows.length} venta${rows.length !== 1 ? 's' : ''})</td>
              <td class="num">${fmtPeso(totSubtotal)}</td>
              <td class="num text-danger">${totDesc > 0 ? '- ' + fmtPeso(totDesc) : '—'}</td>
              <td class="num">${fmtPeso(totTotal)}</td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT 4: Quiebres de Stock ───────────────────────────────────────────────

  function renderQuiebresStock(rows) {
    const sinSustituto = rows.filter(r => !r.tiene_sustituto);
    const conSustituto = rows.filter(r =>  r.tiene_sustituto);
    const thead = `<thead><tr>
      <th>Código</th><th>Producto</th><th>Proveedor</th>
      <th class="num">Stock actual</th><th class="num">Stock mín.</th>
      <th class="num">Pedido (OC)</th><th class="num">Recibido</th>
      <th class="num">Faltante</th><th class="num">Órdenes</th><th>¿Sustituto?</th>
    </tr></thead>`;
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
        <div class="inf-kpi danger"><div class="inf-kpi-label">Sin sustituto</div><div class="inf-kpi-value text-danger">${sinSustituto.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Con sustituto</div><div class="inf-kpi-value">${conSustituto.length}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No se encontraron quiebres en el período.<br>
        <span class="text-muted" style="font-size:12px">Se detectan cuando un producto fue pedido en una OC confirmada pero el proveedor no realizó entrega en el período.</span></div>` : `
        ${sinSustituto.length > 0 ? `
          <div class="inf-section-label danger">🔴 Sin sustituto — requieren acción (${sinSustituto.length})</div>
          <div class="inf-table-wrap"><table class="inf-table">${thead}<tbody>${renderRows(sinSustituto)}</tbody></table></div>
        ` : ''}
        ${conSustituto.length > 0 ? `
          <div class="inf-section-label">🟡 Con sustituto disponible (${conSustituto.length})</div>
          <div class="inf-table-wrap"><table class="inf-table">${thead}<tbody>${renderRows(conSustituto)}</tbody></table></div>
        ` : ''}
      `}
    `;
  }

  // ── REPORT 5: Ventas por Vendedor ─────────────────────────────────────────────

  function renderVentasVendedor(rows) {
    const totVentas = rows.reduce((s, r) => s + (r.total_ventas || 0), 0);
    const totDevs   = rows.reduce((s, r) => s + (r.total_devuelto || 0), 0);
    const totNeto   = rows.reduce((s, r) => s + (r.total_neto || 0), 0);
    const totTxns   = rows.reduce((s, r) => s + (r.num_ventas || 0), 0);
    return `
      ${reportHeader('Ventas por Vendedor', true)}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Vendedores</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Transacciones</div><div class="inf-kpi-value">${fmtNum(totTxns)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Total bruto</div><div class="inf-kpi-value">${fmtPeso(totVentas)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Devoluciones</div><div class="inf-kpi-value text-danger">${totDevs > 0 ? '- ' + fmtPeso(totDevs) : fmtPeso(0)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Neto</div><div class="inf-kpi-value">${fmtPeso(totNeto)}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Vendedor</th>
              <th class="num">Transacciones</th>
              <th class="num">Subtotal bruto</th>
              <th class="num">Descuentos</th>
              <th class="num">Total bruto</th>
              <th class="num">Devoluciones</th>
              <th class="num">Total neto</th>
              <th class="num">Ticket promedio</th>
              <th class="num">% del total</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const ticket = r.num_ventas ? r.total_neto / r.num_ventas : 0;
                const pct    = totNeto > 0 ? (r.total_neto / totNeto * 100).toFixed(1) : '0.0';
                return `
                  <tr>
                    <td><strong>${esc(r.vendedor)}</strong></td>
                    <td class="num">${r.num_ventas}</td>
                    <td class="num">${fmtPeso(r.subtotal_bruto)}</td>
                    <td class="num ${r.descuentos > 0 ? 'text-danger' : ''}">${r.descuentos > 0 ? '- ' + fmtPeso(r.descuentos) : '—'}</td>
                    <td class="num">${fmtPeso(r.total_ventas)}</td>
                    <td class="num ${r.total_devuelto > 0 ? 'text-danger' : 'text-muted'}">${r.total_devuelto > 0 ? '- ' + fmtPeso(r.total_devuelto) : '—'}</td>
                    <td class="num bold">${fmtPeso(r.total_neto)}</td>
                    <td class="num">${fmtPeso(ticket)}</td>
                    <td class="num">${pct}%</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot><tr>
              <td>TOTAL</td>
              <td class="num">${fmtNum(totTxns)}</td>
              <td colspan="2"></td>
              <td class="num">${fmtPeso(totVentas)}</td>
              <td class="num text-danger">${totDevs > 0 ? '- ' + fmtPeso(totDevs) : '—'}</td>
              <td class="num bold">${fmtPeso(totNeto)}</td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
        <p class="inf-nota">* Las comisiones individuales requieren configurar el % general y por producto en el módulo de Configuración (pendiente).</p>
      `}
    `;
  }

  // ── REPORT 6: Aging Cuenta Corriente ─────────────────────────────────────────

  function agingClass(dias) {
    if (dias === null) return '';
    if (dias <= 30)  return 'aging-ok';
    if (dias <= 60)  return 'aging-warn';
    if (dias <= 90)  return 'aging-high';
    return 'aging-crit';
  }

  function agingLabel(dias) {
    if (dias === null) return '—';
    if (dias <= 30)  return `${dias}d`;
    if (dias <= 60)  return `${dias}d`;
    if (dias <= 90)  return `${dias}d`;
    return `${dias}d`;
  }

  function renderAgingCC(rows) {
    const totBalance = rows.reduce((s, r) => s + (r.balance || 0), 0);
    const criticos   = rows.filter(r => daysSince(r.primera_deuda) > 90).length;
    const hoy        = new Date().toLocaleDateString('es-AR');
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>Aging Cuenta Corriente</h3>
          <span class="inf-periodo">Estado al ${hoy}</span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Clientes con deuda</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Deuda total</div><div class="inf-kpi-value">${fmtPeso(totBalance)}</div></div>
        <div class="inf-kpi danger"><div class="inf-kpi-label">Deuda crítica (+90 días)</div><div class="inf-kpi-value text-danger">${criticos}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay clientes con saldo deudor.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Cliente</th><th>Teléfono</th>
              <th class="num">Saldo deudor</th><th class="num">Tope</th>
              <th class="num">% del tope</th>
              <th>Primera deuda</th><th>Última compra</th><th>Último pago</th>
              <th class="num">Días de mora</th><th>Categoría</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const dias = daysSince(r.primera_deuda);
                const pctTope = r.tope_deuda > 0 ? (r.balance / r.tope_deuda * 100).toFixed(0) : '—';
                const sobreTope = r.tope_deuda > 0 && r.balance > r.tope_deuda;
                const cats = ['Reciente','Normal','Alta','Crítica'];
                const catIdx = dias === null ? 0 : dias <= 30 ? 0 : dias <= 60 ? 1 : dias <= 90 ? 2 : 3;
                return `
                  <tr>
                    <td><strong>${esc(r.nombre)} ${esc(r.apellido)}</strong></td>
                    <td>${esc(r.telefono) || '—'}</td>
                    <td class="num bold ${sobreTope ? 'text-danger' : ''}">${fmtPeso(r.balance)}</td>
                    <td class="num text-muted">${r.tope_deuda > 0 ? fmtPeso(r.tope_deuda) : '—'}</td>
                    <td class="num ${sobreTope ? 'text-danger bold' : ''}">${pctTope}${pctTope !== '—' ? '%' : ''}</td>
                    <td>${fmtFechaCorta(r.primera_deuda)}</td>
                    <td>${fmtFechaCorta(r.ultima_compra)}</td>
                    <td>${fmtFechaCorta(r.ultimo_pago)}</td>
                    <td class="num"><span class="aging-badge ${agingClass(dias)}">${agingLabel(dias)}</span></td>
                    <td><span class="aging-badge ${agingClass(dias)}">${cats[catIdx]}</span></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="2">TOTAL</td>
              <td class="num bold">${fmtPeso(totBalance)}</td>
              <td colspan="7"></td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT 7: Resumen Diario de Caja ─────────────────────────────────────────

  function renderResumenDiario(rows) {
    const tot = rows.reduce((acc, r) => ({
      efectivo:        acc.efectivo        + (r.efectivo        || 0),
      mercadopago:     acc.mercadopago     + (r.mercadopago     || 0),
      tarjeta:         acc.tarjeta         + (r.tarjeta         || 0),
      transferencia:   acc.transferencia   + (r.transferencia   || 0),
      cuenta_corriente:acc.cuenta_corriente+ (r.cuenta_corriente|| 0),
      total_cobrado:   acc.total_cobrado   + (r.total_cobrado   || 0),
      egresos:         acc.egresos         + (r.egresos         || 0),
      neto:            acc.neto            + (r.neto            || 0),
      num_ventas:      acc.num_ventas      + (r.num_ventas      || 0),
    }), { efectivo:0, mercadopago:0, tarjeta:0, transferencia:0, cuenta_corriente:0, total_cobrado:0, egresos:0, neto:0, num_ventas:0 });

    return `
      ${reportHeader('Resumen Diario de Caja (Cobranzas)')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Días con actividad</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Ventas totales</div><div class="inf-kpi-value">${fmtNum(tot.num_ventas)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Total cobrado</div><div class="inf-kpi-value">${fmtPeso(tot.total_cobrado)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Egresos</div><div class="inf-kpi-value text-danger">${fmtPeso(tot.egresos)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Neto de caja</div><div class="inf-kpi-value ${tot.neto >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.neto)}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay movimientos en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Fecha</th><th class="num">Ventas</th>
              <th class="num">Efectivo</th><th class="num">Mercado Pago</th>
              <th class="num">Tarjeta</th><th class="num">Transferencia</th>
              <th class="num">Cta. Cte. (fiada)</th>
              <th class="num">Total cobrado</th>
              <th class="num">Egresos</th><th class="num">Neto</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td>${fmtFechaCorta(r.dia)}</td>
                  <td class="num">${r.num_ventas}</td>
                  <td class="num">${r.efectivo     > 0 ? fmtPeso(r.efectivo)     : '—'}</td>
                  <td class="num">${r.mercadopago  > 0 ? fmtPeso(r.mercadopago)  : '—'}</td>
                  <td class="num">${r.tarjeta      > 0 ? fmtPeso(r.tarjeta)      : '—'}</td>
                  <td class="num">${r.transferencia> 0 ? fmtPeso(r.transferencia): '—'}</td>
                  <td class="num text-muted">${r.cuenta_corriente > 0 ? fmtPeso(r.cuenta_corriente) : '—'}</td>
                  <td class="num bold">${fmtPeso(r.total_cobrado)}</td>
                  <td class="num text-danger">${r.egresos > 0 ? '- ' + fmtPeso(r.egresos) : '—'}</td>
                  <td class="num bold ${r.neto >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(r.neto)}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot><tr>
              <td>TOTAL</td>
              <td class="num">${fmtNum(tot.num_ventas)}</td>
              <td class="num">${fmtPeso(tot.efectivo)}</td>
              <td class="num">${fmtPeso(tot.mercadopago)}</td>
              <td class="num">${fmtPeso(tot.tarjeta)}</td>
              <td class="num">${fmtPeso(tot.transferencia)}</td>
              <td class="num text-muted">${fmtPeso(tot.cuenta_corriente)}</td>
              <td class="num bold">${fmtPeso(tot.total_cobrado)}</td>
              <td class="num text-danger">- ${fmtPeso(tot.egresos)}</td>
              <td class="num bold ${tot.neto >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.neto)}</td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT 8: Stock sin Movimiento ────────────────────────────────────────────

  function renderStockMuerto(rows) {
    const totStock    = rows.reduce((s, r) => s + (r.stock_actual || 0), 0);
    const totInmovil  = rows.reduce((s, r) => s + (r.costo_inmovilizado || 0), 0);
    const sinVenta    = rows.filter(r => !r.ultima_venta).length;
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>Stock sin Movimiento</h3>
          <span class="inf-periodo">Sin ventas en los últimos <strong>${state.diasSinMovimiento} días</strong></span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Productos estancados</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi danger"><div class="inf-kpi-label">Nunca vendidos</div><div class="inf-kpi-value text-danger">${sinVenta}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Unidades inmovilizadas</div><div class="inf-kpi-value">${fmtNum(totStock)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Costo inmovilizado</div><div class="inf-kpi-value">${fmtPeso(totInmovil)}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay productos estancados en el umbral seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Código</th><th>Nombre</th><th>Categoría</th><th>Proveedor</th>
              <th class="num">Stock</th><th class="num">Costo unit.</th>
              <th class="num">Costo inmov.</th><th>Última venta</th><th class="num">Días sin venta</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const dias     = daysSince(r.ultima_venta);
                const diasStr  = dias === null ? '<span class="text-danger bold">Nunca</span>' : `<span class="${dias > 180 ? 'text-danger' : dias > 90 ? 'text-warning' : ''}">${dias}d</span>`;
                return `
                  <tr>
                    <td class="mono">${esc(r.codigo)}</td>
                    <td>${esc(r.nombre)}</td>
                    <td>${esc(r.categoria)}</td>
                    <td>${esc(r.proveedor)}</td>
                    <td class="num">${fmtNum(r.stock_actual)}</td>
                    <td class="num">${fmtPeso(r.costo)}</td>
                    <td class="num bold">${fmtPeso(r.costo_inmovilizado)}</td>
                    <td>${r.ultima_venta ? fmtFechaCorta(r.ultima_venta.slice(0,10)) : '<span class="text-danger">Nunca</span>'}</td>
                    <td class="num">${diasStr}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="4">TOTAL</td>
              <td class="num">${fmtNum(totStock)}</td>
              <td></td>
              <td class="num bold">${fmtPeso(totInmovil)}</td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────────

  function attachExportListeners() {
    ge('inf-btn-excel')?.addEventListener('click', exportExcel);
    ge('inf-btn-csv')?.addEventListener('click',   exportCSV);
  }

  function buildExportRows() {
    const rows    = state.data || [];
    const rep     = state.reporte;
    const title   = REPORTES.find(r => r.id === rep)?.label || rep;
    const periodo = rep === 'aging_cc'    ? `Estado al ${new Date().toLocaleDateString('es-AR')}` :
                    rep === 'stock_muerto' ? `Sin ventas en los últimos ${state.diasSinMovimiento} días` :
                    `Período: ${fmtPeriodo()}`;

    if (rep === 'ventas_producto' || rep === 'analitica_producto') {
      const headers = ['Código','Nombre','Categoría','Proveedor','Costo actual','Precio actual',
                       'Stock actual','Cant. vendida','Costo total','Venta total','Utilidad','Margen %'];
      const data = rows.map(r => [r.codigo, r.nombre, r.categoria, r.proveedor,
        r.costo_actual, r.precio_actual, r.stock_actual, r.cant_vendida,
        r.costo_total, r.venta_total, r.utilidad, r.margen_pct]);
      return { title, periodo, headers, data };
    }
    if (rep === 'ventas_transaccion') {
      const headers = ['N° Venta','Fecha','Hora','Vendedor','Subtotal','Descuento','Total','Forma de pago','Cliente'];
      const data = rows.map(r => {
        const fecha = new Date(r.fecha);
        const pagos = parsePagos(r.pagos_raw).map(p => `${MEDIO_LABEL[p.medio]||p.medio} $${p.monto.toFixed(2)}`).join(', ');
        return ['#'+r.id.slice(-6), fecha.toLocaleDateString('es-AR'),
          fecha.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}),
          r.vendedor, r.subtotal, r.descuento, r.total, pagos,
          r.cliente ? r.cliente.trim() : 'Consumidor final'];
      });
      return { title, periodo, headers, data };
    }
    if (rep === 'quiebres_stock') {
      const headers = ['Código','Producto','Proveedor','Stock actual','Stock mín.',
                       'Pedido (OC)','Recibido','Faltante','N° Órdenes','¿Sustituto?'];
      const data = rows.map(r => [r.codigo, r.nombre, r.proveedor, r.stock_actual, r.stock_minimo,
        r.total_pedido, r.recibido_compras, r.total_pedido - r.recibido_compras,
        r.num_ordenes, r.tiene_sustituto ? 'Sí' : 'No']);
      return { title, periodo, headers, data };
    }
    if (rep === 'aging_cc') {
      const headers = ['Cliente','Teléfono','Saldo deudor','Tope crédito',
                       'Primera deuda','Última compra','Último pago','Días de mora','Categoría'];
      const cats = ['Reciente','Normal','Alta','Crítica'];
      const data = rows.map(r => {
        const dias   = daysSince(r.primera_deuda);
        const catIdx = dias === null ? 0 : dias <= 30 ? 0 : dias <= 60 ? 1 : dias <= 90 ? 2 : 3;
        return [`${r.nombre} ${r.apellido}`, r.telefono, r.balance, r.tope_deuda,
          r.primera_deuda ? r.primera_deuda.slice(0,10) : '',
          r.ultima_compra ? r.ultima_compra.slice(0,10) : '',
          r.ultimo_pago   ? r.ultimo_pago.slice(0,10)   : '',
          dias ?? '', cats[catIdx]];
      });
      return { title, periodo, headers, data };
    }
    if (rep === 'resumen_diario') {
      const headers = ['Fecha','Ventas','Efectivo','Mercado Pago','Tarjeta',
                       'Transferencia','Cta. Cte. (fiada)','Total cobrado','Egresos','Neto'];
      const data = rows.map(r => [fmtFechaCorta(r.dia), r.num_ventas,
        r.efectivo, r.mercadopago, r.tarjeta, r.transferencia,
        r.cuenta_corriente, r.total_cobrado, r.egresos, r.neto]);
      return { title, periodo, headers, data };
    }
    if (rep === 'stock_muerto') {
      const headers = ['Código','Nombre','Categoría','Proveedor',
                       'Stock','Costo unitario','Costo inmovilizado','Última venta','Días sin venta'];
      const data = rows.map(r => {
        const dias = daysSince(r.ultima_venta);
        return [r.codigo, r.nombre, r.categoria, r.proveedor,
          r.stock_actual, r.costo, r.costo_inmovilizado,
          r.ultima_venta ? r.ultima_venta.slice(0,10) : 'Nunca', dias ?? 'Nunca'];
      });
      return { title, periodo, headers, data };
    }
    return null;
  }

  function exportExcel() {
    if (!window.XLSX) { alert('Librería XLSX no disponible.'); return; }
    const ed = buildExportRows();
    if (!ed) return;
    const wsData = [[ed.title], [ed.periodo], [], ed.headers, ...ed.data];
    const ws = window.XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = ed.headers.map(() => ({ wch: 18 }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, ed.title.slice(0, 31));
    window.XLSX.writeFile(wb, `${ed.title.replace(/\s+/g, '_')}_${state.desde || 'hoy'}.xlsx`);
  }

  function exportCSV() {
    const ed = buildExportRows();
    if (!ed) return;
    const escCell = (cell) => {
      const s = String(cell == null ? '' : cell);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const allRows = [[ed.title], [ed.periodo], [], ed.headers, ...ed.data];
    const csv = allRows.map(row => row.map(escCell).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${ed.title.replace(/\s+/g, '_')}_${state.desde || 'hoy'}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { init };
})();

export default Informes;
