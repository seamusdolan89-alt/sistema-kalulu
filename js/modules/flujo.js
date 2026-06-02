/**
 * flujo.js — Flujo de Fondos
 *
 * Tabla de 14 días (hoy + 13).
 * Filas: Saldo inicial MP · Dinero a liquidar · pagos por proveedor · Saldo Final.
 * Estimados en amarillo, reales/manuales en blanco.
 */

const FlujoModule = (() => {
  'use strict';

  const DB  = () => window.SGA_DB;
  const fmt = (n) => (n == null || isNaN(n) ? '—' : '$ ' + Math.round(n).toLocaleString('es-AR'));

  const DIAS_LABEL = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const DIAS_FULL  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

  const HOY = new Date().toISOString().slice(0, 10);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function dateAdd(base, d) {
    const dt = new Date(base + 'T12:00:00');
    dt.setDate(dt.getDate() + d);
    return dt.toISOString().slice(0, 10);
  }

  function dayOfWeek(fecha) {
    return new Date(fecha + 'T12:00:00').getDay(); // 0=Dom
  }

  // Map JS getDay() (0=Dom) to our dia_entrega storage (1=Lun..7=Dom)
  function jsDoW2stored(jsDay) {
    return jsDay === 0 ? 7 : jsDay;
  }

  function buildDias() {
    const dias = [];
    for (let i = 0; i < 14; i++) dias.push(dateAdd(HOY, i));
    return dias;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let dias        = [];
  let proveedores = [];   // [{id, razon_social, alias, dia_entrega}]
  let comprasProv = {};   // { 'provId|fecha': total }
  let liquidar    = {};   // { 'fecha': monto }
  let pagosManual = {};   // { 'provId|fecha': {monto, es_estimado} }
  let promedios   = {};   // { 'provId': avg_last3 }
  let saldoIniBase = 0;   // saldo inicial del día 0

  // ── Data loading ───────────────────────────────────────────────────────────

  function loadData() {
    dias = buildDias();
    const fechaMin = dias[0];
    const fechaMax = dias[dias.length - 1];

    // Proveedores activos que tienen dia_entrega o compras recientes
    const recentProvIds = new Set(
      DB().query(
        `SELECT DISTINCT proveedor_id FROM compras WHERE fecha >= date('now', '-90 days') AND proveedor_id IS NOT NULL`
      ).map(r => r.proveedor_id)
    );

    const allProv = DB().query(
      `SELECT id, razon_social, alias, dia_entrega FROM proveedores WHERE activo = 1 ORDER BY razon_social`
    );
    proveedores = allProv.filter(p => p.dia_entrega != null || recentProvIds.has(p.id));

    // Compras reales en el rango visible
    comprasProv = {};
    DB().query(
      `SELECT proveedor_id, DATE(fecha) as dia, SUM(total) as total
       FROM compras
       WHERE fecha >= ? AND fecha <= ? AND proveedor_id IS NOT NULL
       GROUP BY proveedor_id, dia`,
      [fechaMin, fechaMax + 'T23:59:59']
    ).forEach(r => { comprasProv[r.proveedor_id + '|' + r.dia] = r.total || 0; });

    // Overrides manuales / estimados guardados
    pagosManual = {};
    DB().query(
      `SELECT proveedor_id, fecha, monto, es_estimado FROM flujo_pagos_prov WHERE fecha >= ? AND fecha <= ?`,
      [fechaMin, fechaMax]
    ).forEach(r => { pagosManual[r.proveedor_id + '|' + r.fecha] = { monto: r.monto, es_estimado: r.es_estimado }; });

    // Dinero a liquidar
    liquidar = {};
    DB().query(
      `SELECT fecha, monto FROM flujo_liquidar WHERE fecha >= ? AND fecha <= ?`,
      [fechaMin, fechaMax]
    ).forEach(r => { liquidar[r.fecha] = r.monto || 0; });

    // Saldo inicial MP (guardado en flujo_liquidar con fecha='__saldo_ini__')
    const saldoRow = DB().query(`SELECT monto FROM flujo_liquidar WHERE fecha = '__saldo_ini__'`);
    saldoIniBase = saldoRow.length ? (saldoRow[0].monto || 0) : 0;

    // Promedio últimas 3 compras por proveedor
    promedios = {};
    proveedores.forEach(p => {
      const rows = DB().query(
        `SELECT total FROM compras WHERE proveedor_id = ? AND total > 0 ORDER BY fecha DESC LIMIT 3`,
        [p.id]
      );
      if (rows.length) {
        promedios[p.id] = rows.reduce((s, r) => s + (r.total || 0), 0) / rows.length;
      }
    });
  }

  // ── Celda de proveedor ─────────────────────────────────────────────────────

  function getProvCell(provId, fecha) {
    // 1. Compra real cargada
    const real = comprasProv[provId + '|' + fecha];
    if (real != null) return { monto: real, tipo: 'real' };

    // 2. Override manual guardado
    const manual = pagosManual[provId + '|' + fecha];
    if (manual != null) return { monto: manual.monto, tipo: manual.es_estimado ? 'estimado' : 'manual' };

    return null;
  }

  function getProvAutoEstimate(provId, fecha) {
    const prov = proveedores.find(p => p.id === provId);
    if (!prov || prov.dia_entrega == null) return null;
    if (jsDoW2stored(dayOfWeek(fecha)) !== prov.dia_entrega) return null;
    return promedios[provId] || null;
  }

  // ── Saldos ─────────────────────────────────────────────────────────────────

  function computeSaldos() {
    const saldos = {};
    let running = saldoIniBase;
    for (const fecha of dias) {
      saldos[fecha] = { ini: running };
      const liq   = liquidar[fecha] || 0;
      const pagos = getTotalPagos(fecha);
      const fin   = running + liq - pagos;
      saldos[fecha].fin = fin;
      running = fin;
    }
    return saldos;
  }

  function getTotalPagos(fecha) {
    return proveedores.reduce((sum, p) => {
      const cell = getProvCell(p.id, fecha);
      if (cell) return sum + (cell.monto || 0);
      const est = getProvAutoEstimate(p.id, fecha);
      if (est) return sum + est;
      return sum;
    }, 0);
  }

  // ── Save helpers ───────────────────────────────────────────────────────────

  function saveLiquidar(fecha, monto) {
    const now = new Date().toISOString();
    DB().run(
      `INSERT INTO flujo_liquidar (fecha, monto, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(fecha) DO UPDATE SET monto = excluded.monto, updated_at = excluded.updated_at`,
      [fecha, monto, now]
    );
    liquidar[fecha] = monto;
  }

  function saveSaldoIni(monto) {
    const now = new Date().toISOString();
    DB().run(
      `INSERT INTO flujo_liquidar (fecha, monto, updated_at) VALUES ('__saldo_ini__', ?, ?)
       ON CONFLICT(fecha) DO UPDATE SET monto = excluded.monto, updated_at = excluded.updated_at`,
      [monto, now]
    );
    saldoIniBase = monto;
  }

  function saveProvPago(provId, fecha, monto) {
    const now = new Date().toISOString();
    const id  = window.SGA_Utils.generateUUID();
    DB().run(
      `INSERT INTO flujo_pagos_prov (id, proveedor_id, fecha, monto, es_estimado, updated_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(proveedor_id, fecha) DO UPDATE SET monto = excluded.monto, es_estimado = 0, updated_at = excluded.updated_at`,
      [id, provId, fecha, monto, now]
    );
    pagosManual[provId + '|' + fecha] = { monto, es_estimado: 0 };
  }

  function clearProvPago(provId, fecha) {
    DB().run(`DELETE FROM flujo_pagos_prov WHERE proveedor_id = ? AND fecha = ?`, [provId, fecha]);
    delete pagosManual[provId + '|' + fecha];
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const root = document.getElementById('flujo-root');
    if (!root) return;
    root.innerHTML = buildTable();
    bindCells();
  }

  function buildTable() {
    const saldos = computeSaldos();
    const n      = dias.length;

    // Header: fechas
    const thDias = dias.map(fecha => {
      const d   = new Date(fecha + 'T12:00:00');
      const dia = String(d.getDate()).padStart(2, '0');
      const mes = d.toLocaleDateString('es-AR', { month: 'short' });
      const dow = DIAS_LABEL[d.getDay()];
      const isHoy = fecha === HOY;
      return `<th class="ff-th${isHoy ? ' ff-th-hoy' : ''}">${dia}-${mes}<br><span class="ff-dow">${dow}</span></th>`;
    }).join('');

    const rows = [];

    // ── SALDO INICIAL MP ──────────────────────────────────────────────────────
    const saldoIniCells = dias.map((fecha, i) => {
      const val = saldos[fecha].ini;
      if (i === 0) {
        return `<td class="ff-cell ff-cell-saldo ff-editable" data-tipo="saldo_ini" data-fecha="${fecha}" data-val="${val}">
          <span class="ff-val">${fmt(val)}</span>
        </td>`;
      }
      return `<td class="ff-cell ff-cell-saldo">${fmt(val)}</td>`;
    }).join('');
    rows.push(`<tr class="ff-row-header">
      <td class="ff-label-col"><strong>Saldo inicial MP</strong></td>${saldoIniCells}
    </tr>`);

    // ── DINERO A LIQUIDAR ─────────────────────────────────────────────────────
    const liquidarCells = dias.map(fecha => {
      const val = liquidar[fecha] || 0;
      return `<td class="ff-cell ff-cell-liquidar ff-editable" data-tipo="liquidar" data-fecha="${fecha}" data-val="${val}">
        <span class="ff-val">${val > 0 ? fmt(val) : '<span class="ff-empty">+</span>'}</span>
      </td>`;
    }).join('');
    rows.push(`<tr class="ff-row-header">
      <td class="ff-label-col"><strong>Dinero a liquidar</strong></td>${liquidarCells}
    </tr>`);

    // ── SEPARADOR ─────────────────────────────────────────────────────────────
    rows.push(`<tr class="ff-section-sep"><td colspan="${n + 1}">Pagos a proveedores</td></tr>`);

    // ── PROVEEDORES ───────────────────────────────────────────────────────────
    proveedores.forEach(prov => {
      const cells = dias.map(fecha => {
        const cell = getProvCell(prov.id, fecha);
        if (cell) {
          const cls = cell.tipo === 'real' ? 'ff-cell-real' : (cell.tipo === 'estimado' ? 'ff-cell-est' : 'ff-cell-manual');
          return `<td class="ff-cell ${cls} ff-editable" data-tipo="prov" data-prov="${prov.id}" data-fecha="${fecha}" data-val="${cell.monto}">
            <span class="ff-val">${fmt(cell.monto)}</span>
          </td>`;
        }
        const est = getProvAutoEstimate(prov.id, fecha);
        if (est) {
          return `<td class="ff-cell ff-cell-est ff-editable" data-tipo="prov" data-prov="${prov.id}" data-fecha="${fecha}" data-val="${est}" data-auto="1">
            <span class="ff-val">${fmt(est)}</span>
          </td>`;
        }
        return `<td class="ff-cell ff-cell-blank ff-editable" data-tipo="prov" data-prov="${prov.id}" data-fecha="${fecha}" data-val="0">
          <span class="ff-val ff-empty">—</span>
        </td>`;
      }).join('');

      const label = prov.alias || prov.razon_social;
      const diaHab = prov.dia_entrega ? `<span class="ff-dia-hab">${DIAS_FULL[prov.dia_entrega === 7 ? 0 : prov.dia_entrega]}</span>` : '';
      rows.push(`<tr class="ff-row-prov">
        <td class="ff-label-col">${escHtml(label)}${diaHab}</td>${cells}
      </tr>`);
    });

    // ── TOTAL PAGOS ───────────────────────────────────────────────────────────
    const totalCells = dias.map(fecha => {
      const tot = getTotalPagos(fecha);
      return `<td class="ff-cell ff-cell-total">${tot > 0 ? fmt(tot) : '<span class="ff-empty">—</span>'}</td>`;
    }).join('');
    rows.push(`<tr class="ff-row-total">
      <td class="ff-label-col"><strong>Total pagos</strong></td>${totalCells}
    </tr>`);

    // ── SALDO FINAL ───────────────────────────────────────────────────────────
    const saldoFinCells = dias.map(fecha => {
      const val = saldos[fecha].fin;
      const cls = val < 0 ? ' ff-negativo' : (val < saldoIniBase * 0.2 ? ' ff-alerta' : '');
      return `<td class="ff-cell ff-cell-saldo${cls}"><strong>${fmt(val)}</strong></td>`;
    }).join('');
    rows.push(`<tr class="ff-row-header ff-row-final">
      <td class="ff-label-col"><strong>Saldo Final</strong></td>${saldoFinCells}
    </tr>`);

    return `
      <div style="overflow-x:auto;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-top:16px;">
        <table class="ff-table">
          <thead><tr>
            <th class="ff-label-col ff-th">Concepto</th>
            ${thDias}
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
      <p style="font-size:12px;color:var(--color-text-secondary);margin-top:10px;">
        💡 Hacé clic en cualquier celda para editar. <span style="background:#fffde7;padding:2px 6px;border-radius:3px;">Amarillo</span> = estimado · Blanco = real/manual · Clic en "—" de proveedor para ingresar un monto.
      </p>`;
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Edición inline ─────────────────────────────────────────────────────────

  function bindCells() {
    document.querySelectorAll('.ff-editable').forEach(td => {
      td.addEventListener('click', () => startEdit(td));
    });
  }

  function startEdit(td) {
    if (td.querySelector('input')) return;
    const tipo  = td.dataset.tipo;
    const fecha = td.dataset.fecha;
    const val   = parseFloat(td.dataset.val) || 0;
    const isAuto = td.dataset.auto === '1';

    // Para celdas reales (compra cargada) no permitir edición directa
    if (td.classList.contains('ff-cell-real')) {
      showToast('Este monto viene de una factura de compra cargada');
      return;
    }

    const input = document.createElement('input');
    input.type        = 'number';
    input.min         = '0';
    input.step        = '1000';
    input.value       = val || '';
    input.placeholder = '0';
    input.style.cssText = 'width:88px;text-align:right;font-size:13px;padding:3px 6px;border:2px solid var(--color-primary,#0066cc);border-radius:4px;background:#fff;';

    const clearBtn = tipo === 'prov' && !isAuto
      ? `<div style="font-size:11px;text-align:center;margin-top:2px;cursor:pointer;color:#999;" class="ff-clear-btn" data-prov="${td.dataset.prov}" data-fecha="${fecha}">borrar</div>`
      : '';

    td.innerHTML = input.outerHTML + clearBtn;
    const inp = td.querySelector('input');
    inp.focus();
    inp.select();

    td.querySelector('.ff-clear-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tipo === 'prov') {
        clearProvPago(td.dataset.prov, fecha);
        computeSaldos();
        render();
      }
    });

    const commit = () => {
      const newVal = parseFloat(inp.value) || 0;
      if (tipo === 'saldo_ini') {
        saveSaldoIni(newVal);
      } else if (tipo === 'liquidar') {
        saveLiquidar(fecha, newVal);
      } else if (tipo === 'prov') {
        if (newVal > 0) saveProvPago(td.dataset.prov, fecha, newVal);
        else clearProvPago(td.dataset.prov, fecha);
      }
      render();
    };

    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') render();
    });
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:9999;pointer-events:none;';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    loadData();
    render();
  }

  return { init };
})();

export default FlujoModule;
