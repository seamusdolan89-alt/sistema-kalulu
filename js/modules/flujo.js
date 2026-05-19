/**
 * flujo.js — Flujo de Fondos (admin-pos only)
 *
 * Columnas = días (últimos 3 + hoy + próximos 10, scrollable hasta +30).
 * Pasado = sombreado (actuals desde DB). Presente/futuro = blanco (forecast manual).
 * Segunda tabla: variación forecast vs real para días pasados con proyección cargada.
 */

const FlujoModule = (() => {
  'use strict';

  const fmt = (n) => (n == null ? '—' : window.SGA_Utils.formatCurrency(Math.round(n)));

  const MEDIOS = ['efectivo', 'mercadopago', 'tarjeta', 'transferencia'];
  const MLBL   = {
    efectivo:      '💵 Efectivo',
    mercadopago:   '📲 MercadoPago',
    tarjeta:       '💳 Tarjeta',
    transferencia: '🏦 Transferencia',
  };
  const DIAS_S = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  // State
  let allDias  = [];   // 33 días (3 past + hoy + 29 future)
  let diasShow = [];   // subset mostrado (14 initial)
  let actuals  = {};   // { 'YYYY-MM-DD': { ventas:{m:n}, gastos:{m:n}, pagos:{m:n} } }
  let forecast = {};   // { 'YYYY-MM-DD': { ingreso:n, egreso:n } }
  let saldoIni = {};   // { 'YYYY-MM-DD': { efectivo:n, mercadopago:n, tarjeta:n, transferencia:n } }

  const HOY = new Date().toISOString().slice(0, 10);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function dateAdd(str, d) {
    const dt = new Date(str + 'T12:00:00');
    dt.setDate(dt.getDate() + d);
    return dt.toISOString().slice(0, 10);
  }

  function dayLabel(dia) {
    const d  = new Date(dia + 'T12:00:00');
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dow = DIAS_S[d.getDay()];
    const isHoy = dia === HOY;
    return `${isHoy ? '<strong>' : ''}${dow}<br><span style="font-size:11px;">${dd}/${mm}</span>${isHoy ? '</strong>' : ''}`;
  }

  function colCls(dia) {
    if (dia < HOY) return 'flujo-col-past';
    if (dia === HOY) return 'flujo-col-today';
    return 'flujo-col-future';
  }
  function cellCls(dia) {
    if (dia < HOY) return 'flujo-cell-past';
    if (dia === HOY) return 'flujo-cell-today';
    return 'flujo-cell-future';
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  function buildRange() {
    const start = dateAdd(HOY, -3);
    allDias = [];
    for (let i = 0; i < 33; i++) allDias.push(dateAdd(start, i));
    diasShow = allDias.slice(0, 14);
  }

  function loadActuals() {
    actuals = {};
    const ensure = (dia) => {
      if (!actuals[dia]) actuals[dia] = { ventas: {}, gastos: {}, pagos: {} };
    };

    const ventas = window.SGA_DB.query(`
      SELECT DATE(v.fecha) as dia, vp.medio, SUM(vp.monto) as monto
      FROM venta_pagos vp
      JOIN ventas v ON v.id = vp.venta_id
      WHERE vp.medio IN ('efectivo','mercadopago','tarjeta','transferencia')
      GROUP BY dia, vp.medio
    `);
    for (const r of ventas) {
      ensure(r.dia);
      actuals[r.dia].ventas[r.medio] = (actuals[r.dia].ventas[r.medio] || 0) + (r.monto || 0);
    }

    const gastos = window.SGA_DB.query(`
      SELECT DATE(fecha) as dia,
             COALESCE(metodo_pago,'efectivo') as medio,
             SUM(monto) as monto
      FROM gastos
      GROUP BY dia, medio
    `);
    for (const r of gastos) {
      ensure(r.dia);
      const m = MEDIOS.includes(r.medio) ? r.medio : 'efectivo';
      actuals[r.dia].gastos[m] = (actuals[r.dia].gastos[m] || 0) + (r.monto || 0);
    }

    const pagos = window.SGA_DB.query(`
      SELECT DATE(pp.fecha) as dia, ppm.metodo as medio, SUM(ppm.monto) as monto
      FROM pagos_proveedores pp
      JOIN pagos_proveedores_metodos ppm ON ppm.pago_id = pp.id
      WHERE ppm.metodo IN ('efectivo','mercadopago','tarjeta','transferencia')
      GROUP BY dia, ppm.metodo
    `);
    for (const r of pagos) {
      ensure(r.dia);
      actuals[r.dia].pagos[r.medio] = (actuals[r.dia].pagos[r.medio] || 0) + (r.monto || 0);
    }
  }

  function loadForecast() {
    forecast = {};
    const rows = window.SGA_DB.query(`SELECT fecha, tipo, monto FROM flujo_forecast`);
    for (const r of rows) {
      if (!forecast[r.fecha]) forecast[r.fecha] = {};
      forecast[r.fecha][r.tipo] = r.monto;
    }
  }

  function saveForecast(fecha, tipo, monto) {
    const now = new Date().toISOString();
    window.SGA_DB.run(
      `INSERT INTO flujo_forecast (id, fecha, tipo, monto, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fecha, tipo) DO UPDATE SET monto = excluded.monto, updated_at = excluded.updated_at`,
      [window.SGA_Utils.generateUUID(), fecha, tipo, monto, now]
    );
    if (!forecast[fecha]) forecast[fecha] = {};
    forecast[fecha][tipo] = monto;
  }

  // ── Saldo computation ──────────────────────────────────────────────────────

  function computeSaldos() {
    const startDia = allDias[0];

    // Baseline: cumulative balance per medio for all history BEFORE startDia
    const running = { efectivo: 0, mercadopago: 0, tarjeta: 0, transferencia: 0 };
    for (const dia of Object.keys(actuals).sort()) {
      if (dia >= startDia) break;
      const d = actuals[dia];
      for (const m of MEDIOS) {
        running[m] += (d.ventas[m] || 0) - (d.gastos[m] || 0) - (d.pagos[m] || 0);
      }
    }

    saldoIni = {};
    let prev = { ...running };

    for (const dia of allDias) {
      saldoIni[dia] = { ...prev };

      const isPastOrToday = dia <= HOY;
      const d = actuals[dia] || { ventas: {}, gastos: {}, pagos: {} };

      if (isPastOrToday) {
        for (const m of MEDIOS) {
          prev[m] += (d.ventas[m] || 0) - (d.gastos[m] || 0) - (d.pagos[m] || 0);
        }
      } else {
        // Future: total cascades via forecast; per-caja allocation stays frozen
        const fcIng = forecast[dia]?.ingreso || 0;
        const fcEgr = forecast[dia]?.egreso  || 0;
        const delta = fcIng - fcEgr;
        // Distribute delta proportionally across medios (or dump to efectivo)
        const posTotal = MEDIOS.reduce((s, m) => s + Math.max(0, prev[m]), 0);
        if (posTotal > 0) {
          for (const m of MEDIOS) prev[m] += delta * (Math.max(0, prev[m]) / posTotal);
        } else {
          prev.efectivo += delta;
        }
      }
    }
  }

  // ── Cell getters ───────────────────────────────────────────────────────────

  function getSaldoTotal(dia) {
    const s = saldoIni[dia] || {};
    return MEDIOS.reduce((sum, m) => sum + (s[m] || 0), 0);
  }

  function getSaldoFinalTotal(dia) {
    const nextDia = dateAdd(dia, 1);
    if (saldoIni[nextDia]) return getSaldoTotal(nextDia);
    // Last day in allDias
    const ini = getSaldoTotal(dia);
    return ini + getTotalIngresos(dia) - getTotalEgresos(dia);
  }

  function getSaldoFinalMedio(dia, m) {
    const nextDia = dateAdd(dia, 1);
    if (saldoIni[nextDia]) return saldoIni[nextDia][m] || 0;
    const isPastOrToday = dia <= HOY;
    if (!isPastOrToday) return null; // no per-caja for future last day
    const d = actuals[dia] || { ventas: {}, gastos: {}, pagos: {} };
    return (saldoIni[dia][m] || 0) + (d.ventas[m] || 0) - (d.gastos[m] || 0) - (d.pagos[m] || 0);
  }

  function getTotalIngresos(dia) {
    const isPastOrToday = dia <= HOY;
    if (isPastOrToday) {
      const d = actuals[dia] || { ventas: {} };
      return MEDIOS.reduce((s, m) => s + (d.ventas[m] || 0), 0);
    }
    return forecast[dia]?.ingreso || 0;
  }

  function getTotalEgresos(dia) {
    const isPastOrToday = dia <= HOY;
    if (isPastOrToday) {
      const d = actuals[dia] || { gastos: {}, pagos: {} };
      return MEDIOS.reduce((s, m) => s + (d.gastos[m] || 0) + (d.pagos[m] || 0), 0);
    }
    return forecast[dia]?.egreso || 0;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const root = document.getElementById('flujo-root');
    if (!root) return;
    root.innerHTML = buildMainTable() + buildVarianceTable();
    bindEditableCells();
    document.getElementById('flujo-btn-expand')?.addEventListener('click', () => {
      diasShow = allDias;
      render();
    });
  }

  function th(dia) {
    return `<th class="${colCls(dia)} flujo-label-col" style="position:sticky;top:0;">${dayLabel(dia)}</th>`;
  }

  function sectionRow(label, n) {
    return `<tr class="flujo-section-header"><td colspan="${n + 1}">${label}</td></tr>`;
  }

  function dataRow(label, cells, cls = '') {
    return `<tr class="flujo-data-row ${cls}">
      <td class="flujo-label-col">${label}</td>${cells.join('')}
    </tr>`;
  }

  function numCell(val, dia, negative = false) {
    const cls = cellCls(dia);
    if (val == null) return `<td class="flujo-cell ${cls}" style="text-align:right;color:#ccc;">—</td>`;
    const v = Math.round(val);
    const color = negative ? '#c62828' : (v < 0 ? '#c62828' : 'inherit');
    const display = v === 0 ? '<span style="color:#ccc;">—</span>' : fmt(v);
    return `<td class="flujo-cell ${cls}" style="text-align:right;color:${color};">${display}</td>`;
  }

  function totalCell(val, dia, negative = false) {
    const v = Math.round(val || 0);
    const color = negative ? '#c62828' : (v < 0 ? '#c62828' : 'inherit');
    return `<td class="flujo-cell ${cellCls(dia)}" style="text-align:right;font-weight:700;color:${color};">${fmt(v)}</td>`;
  }

  function editableCell(fecha, tipo, val) {
    const cls = cellCls(fecha);
    const display = val > 0
      ? `<span style="font-weight:600;">${fmt(val)}</span>`
      : `<span style="color:#bbb;font-size:12px;">ingresar</span>`;
    return `<td class="flujo-cell ${cls} flujo-editable" style="text-align:right;"
              data-fecha="${fecha}" data-tipo="${tipo}" data-val="${val || 0}">${display}</td>`;
  }

  function buildMainTable() {
    const n = diasShow.length;
    const headers = diasShow.map(d => `<th class="${colCls(d)}">${dayLabel(d)}</th>`).join('');

    const rows = [];

    // ── SALDO INICIAL ────────────────────────────────────────────────────────
    rows.push(sectionRow('💰 Saldo inicial', n));
    for (const m of MEDIOS) {
      rows.push(dataRow(
        `<span class="flujo-sub">${MLBL[m]}</span>`,
        diasShow.map(dia => numCell(saldoIni[dia]?.[m] ?? 0, dia)),
        'flujo-row-saldo'
      ));
    }
    rows.push(dataRow(
      '<strong>Total</strong>',
      diasShow.map(dia => totalCell(getSaldoTotal(dia), dia)),
      'flujo-row-total flujo-row-saldo'
    ));

    // ── INGRESOS ─────────────────────────────────────────────────────────────
    rows.push(sectionRow('📈 Ingresos', n));
    for (const m of MEDIOS) {
      rows.push(dataRow(
        `<span class="flujo-sub">${MLBL[m]}</span>`,
        diasShow.map(dia => {
          const isPastOrToday = dia <= HOY;
          const val = isPastOrToday ? (actuals[dia]?.ventas[m] || 0) : null;
          return numCell(val, dia);
        })
      ));
    }
    // Proyección (editable, todos los días — past = histórica, future = principal input)
    rows.push(dataRow(
      '<span class="flujo-sub">📝 Proyección / Otros</span>',
      diasShow.map(dia => editableCell(dia, 'ingreso', forecast[dia]?.ingreso || 0)),
      'flujo-row-otros'
    ));
    rows.push(dataRow(
      '<strong>Total ingresos</strong>',
      diasShow.map(dia => totalCell(getTotalIngresos(dia), dia)),
      'flujo-row-total flujo-row-green'
    ));

    // ── EGRESOS ──────────────────────────────────────────────────────────────
    rows.push(sectionRow('📉 Egresos', n));
    rows.push(dataRow(
      '<span class="flujo-sub">💸 Gastos generales</span>',
      diasShow.map(dia => {
        const isPastOrToday = dia <= HOY;
        const d = actuals[dia] || { gastos: {} };
        const val = isPastOrToday ? MEDIOS.reduce((s, m) => s + (d.gastos[m] || 0), 0) : null;
        return numCell(val, dia, true);
      })
    ));
    rows.push(dataRow(
      '<span class="flujo-sub">🏪 Pagos proveedores</span>',
      diasShow.map(dia => {
        const isPastOrToday = dia <= HOY;
        const d = actuals[dia] || { pagos: {} };
        const val = isPastOrToday ? MEDIOS.reduce((s, m) => s + (d.pagos[m] || 0), 0) : null;
        return numCell(val, dia, true);
      })
    ));
    rows.push(dataRow(
      '<span class="flujo-sub">📝 Proyección / Otros</span>',
      diasShow.map(dia => editableCell(dia, 'egreso', forecast[dia]?.egreso || 0)),
      'flujo-row-otros'
    ));
    rows.push(dataRow(
      '<strong>Total egresos</strong>',
      diasShow.map(dia => totalCell(getTotalEgresos(dia), dia, true)),
      'flujo-row-total flujo-row-red'
    ));

    // ── SALDO FINAL ──────────────────────────────────────────────────────────
    rows.push(sectionRow('💼 Saldo final', n));
    for (const m of MEDIOS) {
      rows.push(dataRow(
        `<span class="flujo-sub">${MLBL[m]}</span>`,
        diasShow.map(dia => {
          const val = getSaldoFinalMedio(dia, m);
          return numCell(val, dia);
        }),
        'flujo-row-saldo'
      ));
    }
    rows.push(dataRow(
      '<strong>Total</strong>',
      diasShow.map(dia => totalCell(getSaldoFinalTotal(dia), dia)),
      'flujo-row-total flujo-row-saldo'
    ));

    const showExpand = diasShow.length < allDias.length;

    return `
      <div id="flujo-scroll-wrapper" style="margin-top:var(--spacing-lg);border-radius:8px;overflow-x:auto;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <table class="flujo-table">
          <thead>
            <tr>
              <th class="flujo-label-col" style="z-index:4;background:var(--color-background,#f5f5f5);">Concepto</th>
              ${headers}
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
      ${showExpand ? `
        <div style="text-align:right;margin-top:8px;">
          <button id="flujo-btn-expand" class="btn btn-secondary"
            style="font-size:13px;padding:5px 14px;">
            Ver más días (hasta +30 días) →
          </button>
        </div>` : ''}`;
  }

  // ── Variance table ─────────────────────────────────────────────────────────

  function buildVarianceTable() {
    const pastWithFc = allDias.filter(d => d < HOY && forecast[d]);
    if (!pastWithFc.length) return '';

    const rows = pastWithFc.map(dia => {
      const d = actuals[dia] || { ventas: {}, gastos: {}, pagos: {} };
      const actualIng = MEDIOS.reduce((s, m) => s + (d.ventas[m] || 0), 0);
      const actualEgr = MEDIOS.reduce((s, m) => s + (d.gastos[m] || 0) + (d.pagos[m] || 0), 0);
      const fcIng = forecast[dia]?.ingreso || 0;
      const fcEgr = forecast[dia]?.egreso  || 0;
      const diffIng = actualIng - fcIng;
      const diffEgr = actualEgr - fcEgr;

      const diffColor = (v, invert = false) => {
        if (v === 0) return '#999';
        return (invert ? v < 0 : v > 0) ? '#2e7d32' : '#c62828';
      };
      const sign = (v) => (v > 0 ? '+' : '') + fmt(Math.round(v));

      return `<tr>
        <td style="white-space:nowrap;padding:6px 12px;color:var(--color-text-secondary);">${dia}</td>
        <td style="text-align:right;">${fmt(fcIng)}</td>
        <td style="text-align:right;">${fmt(actualIng)}</td>
        <td style="text-align:right;font-weight:700;color:${diffColor(diffIng)};">${sign(diffIng)}</td>
        <td style="text-align:right;padding-left:20px;">${fmt(fcEgr)}</td>
        <td style="text-align:right;">${fmt(actualEgr)}</td>
        <td style="text-align:right;font-weight:700;color:${diffColor(diffEgr, true)};">${sign(diffEgr)}</td>
      </tr>`;
    }).join('');

    return `
      <h3 style="margin:32px 0 8px;font-size:1rem;color:var(--color-text);">📊 Variación Forecast vs Real</h3>
      <div style="overflow-x:auto;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <table class="table" style="font-size:13px;margin:0;">
          <thead>
            <tr>
              <th>Fecha</th>
              <th style="text-align:right;">Ing. Forecast</th>
              <th style="text-align:right;">Ing. Real</th>
              <th style="text-align:right;">Δ Ingresos</th>
              <th style="text-align:right;padding-left:20px;">Egr. Forecast</th>
              <th style="text-align:right;">Egr. Real</th>
              <th style="text-align:right;">Δ Egresos</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Editable cells ─────────────────────────────────────────────────────────

  function bindEditableCells() {
    document.querySelectorAll('.flujo-editable').forEach(td => {
      td.addEventListener('click', () => startEdit(td));
    });
  }

  function startEdit(td) {
    if (td.querySelector('input')) return;
    const fecha = td.dataset.fecha;
    const tipo  = td.dataset.tipo;
    const val   = parseFloat(td.dataset.val) || 0;

    td.innerHTML = `<input type="number" min="0" step="1000"
      value="${val || ''}" placeholder="0"
      style="width:90px;text-align:right;font-size:13px;padding:3px 6px;
        border:2px solid var(--color-primary,#0066cc);border-radius:4px;background:#fff;">`;

    const input = td.querySelector('input');
    input.focus();
    input.select();

    const commit = () => {
      const newVal = parseFloat(input.value) || 0;
      saveForecast(fecha, tipo, newVal);
      computeSaldos();
      render();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') render();
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    buildRange();
    loadActuals();
    loadForecast();
    computeSaldos();
    render();
  }

  return { init };
})();

export default FlujoModule;
