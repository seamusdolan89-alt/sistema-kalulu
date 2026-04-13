/**
 * cuenta_corriente_proveedores.js — Supplier Accounts Payable
 *
 * Exposes window.SGA_PagosProveedores (data layer).
 * Exports default { init } for SPA router (full UI).
 */

// ── DATA LAYER ───────────────────────────────────────────────────────────────

const SGA_PagosProveedores = (() => {
  'use strict';

  const db  = () => window.SGA_DB;
  const uid = () => window.SGA_Utils.generateUUID();
  const now = () => window.SGA_Utils.formatISODate(new Date());

  function _getPagadoDeCompra(compraId) {
    const r = db().query(
      `SELECT COALESCE(SUM(monto_imputado), 0) AS total FROM imputaciones_pagos WHERE compra_id = ?`,
      [compraId]
    );
    return parseFloat(r[0]?.total) || 0;
  }

  function _getCreditoDisponibleDePago(pagoId) {
    const totalPago = db().query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM pagos_proveedores_metodos WHERE pago_id = ?`,
      [pagoId]
    );
    const totalImputado = db().query(
      `SELECT COALESCE(SUM(monto_imputado), 0) AS total FROM imputaciones_pagos WHERE pago_id = ?`,
      [pagoId]
    );
    return (parseFloat(totalPago[0]?.total) || 0) - (parseFloat(totalImputado[0]?.total) || 0);
  }

  function getSaldoProveedor(proveedorId) {
    const deuda = db().query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM compras WHERE proveedor_id = ? AND COALESCE(estado,'confirmada') != 'anulada'`,
      [proveedorId]
    );
    const pagado = db().query(
      `SELECT COALESCE(SUM(m.monto), 0) AS total
       FROM pagos_proveedores_metodos m
       JOIN pagos_proveedores p ON p.id = m.pago_id
       WHERE p.proveedor_id = ?`,
      [proveedorId]
    );
    return (parseFloat(deuda[0]?.total) || 0) - (parseFloat(pagado[0]?.total) || 0);
  }

  function getComprasPendientes(proveedorId) {
    const compras = db().query(
      `SELECT id, fecha, numero_factura, factura_pv, total, condicion_pago
       FROM compras
       WHERE proveedor_id = ? AND COALESCE(estado,'confirmada') != 'anulada'
       ORDER BY fecha ASC, rowid ASC`,
      [proveedorId]
    );
    return compras
      .map(c => ({
        ...c,
        pagado: _getPagadoDeCompra(c.id),
        saldo:  (parseFloat(c.total) || 0) - _getPagadoDeCompra(c.id),
      }))
      .filter(c => c.saldo > 0.01);
  }

  function getCreditosDisponibles(proveedorId) {
    const pagos = db().query(
      `SELECT p.id, p.fecha, p.observaciones,
              COALESCE((SELECT SUM(m.monto) FROM pagos_proveedores_metodos m WHERE m.pago_id = p.id), 0) AS total_pago
       FROM pagos_proveedores p
       WHERE p.proveedor_id = ?
       ORDER BY p.fecha ASC`,
      [proveedorId]
    );
    return pagos
      .map(p => {
        const credito = _getCreditoDisponibleDePago(p.id);
        const metodos = db().query(
          `SELECT metodo, monto, referencia FROM pagos_proveedores_metodos WHERE pago_id = ?`,
          [p.id]
        );
        return { ...p, credito_disponible: credito, metodos };
      })
      .filter(p => p.credito_disponible > 0.01);
  }

  function getLedger(proveedorId) {
    const compras = db().query(
      `SELECT id, fecha, numero_factura, factura_pv, total, condicion_pago, estado
       FROM compras
       WHERE proveedor_id = ? AND COALESCE(estado,'confirmada') != 'anulada'
       ORDER BY fecha ASC, rowid ASC`,
      [proveedorId]
    ).map(c => {
      const pagado = _getPagadoDeCompra(c.id);
      return {
        tipo:           'compra',
        id:             c.id,
        fecha:          c.fecha,
        referencia:     [c.factura_pv, c.numero_factura].filter(Boolean).join('-') || '—',
        debe:           parseFloat(c.total) || 0,
        haber:          0,
        condicion_pago: c.condicion_pago,
        pagado,
        saldo_item:     (parseFloat(c.total) || 0) - pagado,
      };
    });

    const pagos = db().query(
      `SELECT p.id, p.fecha, p.observaciones,
              COALESCE((SELECT SUM(m.monto) FROM pagos_proveedores_metodos m WHERE m.pago_id = p.id), 0) AS total_pago
       FROM pagos_proveedores p
       WHERE p.proveedor_id = ?
       ORDER BY p.fecha ASC`,
      [proveedorId]
    ).map(p => {
      const metodos = db().query(
        `SELECT metodo, monto, referencia FROM pagos_proveedores_metodos WHERE pago_id = ?`,
        [p.id]
      );
      const desc = metodos.map(m =>
        (m.metodo === 'efectivo' ? 'Efectivo' : 'Transferencia')
        + (m.referencia ? ` (${m.referencia})` : '')
      ).join(' + ');
      return {
        tipo:         'pago',
        id:           p.id,
        fecha:        p.fecha,
        referencia:   desc || p.observaciones || 'Pago',
        debe:         0,
        haber:        parseFloat(p.total_pago) || 0,
        observaciones: p.observaciones,
      };
    });

    const entries = [...compras, ...pagos].sort((a, b) =>
      a.fecha.localeCompare(b.fecha) || (a.tipo === 'compra' ? -1 : 1)
    );

    let saldo = 0;
    for (const e of entries) {
      saldo += e.debe - e.haber;
      e.saldo_acumulado = saldo;
    }
    return entries;
  }

  /**
   * Crear pago a proveedor.
   * opts: { proveedor_id, fecha, observaciones, usuario_id, metodos, imputaciones?, auto_imputar? }
   * metodos: [{ metodo: 'efectivo'|'transferencia', monto, referencia?, sesion_caja_id? }]
   * imputaciones: [{ compra_id|id, monto? }]  — si no se pasa y auto_imputar=true → oldest-first
   */
  function crearPago(opts) {
    const {
      proveedor_id,
      fecha,
      observaciones = null,
      usuario_id = null,
      metodos = [],
      imputaciones,
      auto_imputar = true,
    } = opts;

    if (!proveedor_id) return { success: false, error: 'proveedor_id requerido' };
    const metodosFiltrados = metodos.filter(m => parseFloat(m.monto) > 0);
    if (!metodosFiltrados.length) return { success: false, error: 'Ingresá al menos un monto' };

    const totalPago = metodosFiltrados.reduce((s, m) => s + parseFloat(m.monto), 0);
    const pagoId = uid();
    const ts = now();
    const fechaPago = fecha || ts.slice(0, 10);

    try {
      db().beginBatch();

      db().run(
        `INSERT INTO pagos_proveedores (id, proveedor_id, fecha, observaciones, usuario_id, sync_status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [pagoId, proveedor_id, fechaPago, observaciones, usuario_id, ts]
      );

      for (const m of metodosFiltrados) {
        db().run(
          `INSERT INTO pagos_proveedores_metodos (id, pago_id, metodo, monto, referencia, sesion_caja_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uid(), pagoId, m.metodo, parseFloat(m.monto), m.referencia || null, m.sesion_caja_id || null]
        );

        if (m.metodo === 'efectivo' && m.sesion_caja_id) {
          const provRow = db().query(`SELECT razon_social FROM proveedores WHERE id=?`, [proveedor_id])[0];
          const provNombre = provRow?.razon_social || '';
          const desc = observaciones
            ? `Pago ${provNombre} — ${observaciones}`
            : `Pago a proveedor${provNombre ? ' ' + provNombre : ''}`;
          db().run(
            `INSERT INTO egresos_caja
               (id, sesion_caja_id, monto, descripcion, tipo, fecha, usuario_id, proveedor_id, sync_status, updated_at)
             VALUES (?, ?, ?, ?, 'pago_proveedor', ?, ?, ?, 'pending', ?)`,
            [uid(), m.sesion_caja_id, parseFloat(m.monto), desc, fechaPago, usuario_id, proveedor_id, ts]
          );
          db().run(
            `UPDATE sesiones_caja SET total_egresos = COALESCE(total_egresos, 0) + ?, sync_status='pending', updated_at=? WHERE id=?`,
            [parseFloat(m.monto), ts, m.sesion_caja_id]
          );
        }
      }

      // Imputaciones
      let creditoRestante = totalPago;

      // Si se pasan imputaciones explícitas (array con compra_id + monto)
      if (imputaciones !== undefined) {
        for (const imp of imputaciones) {
          if (creditoRestante <= 0.01) break;
          const compraId = imp.compra_id || imp.id;
          if (!compraId) continue; // huérfano explícito
          const monto = Math.min(parseFloat(imp.monto) || 0, creditoRestante);
          if (monto <= 0.01) continue;
          db().run(
            `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, monto_imputado, fecha) VALUES (?, ?, ?, ?, ?)`,
            [uid(), pagoId, compraId, monto, fechaPago]
          );
          creditoRestante -= monto;
        }
      } else if (auto_imputar) {
        // Auto: oldest-first
        const pendientes = getComprasPendientes(proveedor_id);
        for (const c of pendientes) {
          if (creditoRestante <= 0.01) break;
          const monto = Math.min(creditoRestante, c.saldo);
          db().run(
            `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, monto_imputado, fecha) VALUES (?, ?, ?, ?, ?)`,
            [uid(), pagoId, c.id, monto, fechaPago]
          );
          creditoRestante -= monto;
        }
      }

      db().commitBatch();
      return { success: true, id: pagoId, credito_sobrante: Math.max(0, creditoRestante) };

    } catch (e) {
      db().rollbackBatch();
      console.error('SGA_PagosProveedores.crearPago:', e);
      return { success: false, error: e.message };
    }
  }

  function imputar(pagoId, compraId, monto) {
    const credito = _getCreditoDisponibleDePago(pagoId);
    if (credito <= 0.01) return { success: false, error: 'Sin crédito disponible' };
    const compra = db().query(`SELECT total FROM compras WHERE id = ?`, [compraId])[0];
    if (!compra) return { success: false, error: 'Compra no encontrada' };
    const saldoCompra = (parseFloat(compra.total) || 0) - _getPagadoDeCompra(compraId);
    if (saldoCompra <= 0.01) return { success: false, error: 'Compra ya saldada' };
    const montoImp = monto !== undefined
      ? Math.min(parseFloat(monto), credito, saldoCompra)
      : Math.min(credito, saldoCompra);
    if (montoImp <= 0.01) return { success: false, error: 'Monto inválido' };
    try {
      db().run(
        `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, monto_imputado, fecha) VALUES (?, ?, ?, ?, ?)`,
        [uid(), pagoId, compraId, montoImp, now().slice(0, 10)]
      );
      return { success: true, monto_aplicado: montoImp };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function getLedgerAgrupado(proveedorId) {
    const compras = db().query(
      `SELECT id, fecha, numero_factura, factura_pv, total
       FROM compras
       WHERE proveedor_id = ? AND COALESCE(estado,'confirmada') != 'anulada'
       ORDER BY fecha ASC, rowid ASC`,
      [proveedorId]
    ).map(c => {
      const imps = db().query(
        `SELECT ip.fecha, ip.monto_imputado, ip.pago_id, p.observaciones
         FROM imputaciones_pagos ip
         JOIN pagos_proveedores p ON p.id = ip.pago_id
         WHERE ip.compra_id = ?
         ORDER BY ip.fecha ASC`,
        [c.id]
      ).map(i => {
        const metodos = db().query(
          `SELECT metodo, referencia FROM pagos_proveedores_metodos WHERE pago_id = ?`,
          [i.pago_id]
        );
        const desc = metodos.map(m =>
          (m.metodo === 'efectivo' ? 'Efectivo' : 'Transferencia')
          + (m.referencia ? ` (${m.referencia})` : '')
        ).join(' + ') || i.observaciones || 'Pago';
        return { fecha: i.fecha, monto: parseFloat(i.monto_imputado) || 0, desc, pago_id: i.pago_id };
      });
      const pagado = imps.reduce((s, i) => s + i.monto, 0);
      return {
        id:         c.id,
        fecha:      c.fecha,
        referencia: [c.factura_pv, c.numero_factura].filter(Boolean).join('-') || '—',
        total:      parseFloat(c.total) || 0,
        pagado,
        saldo_item: (parseFloat(c.total) || 0) - pagado,
        imputaciones: imps,
      };
    });

    const pagos_sin_imputar = db().query(
      `SELECT p.id, p.fecha, p.observaciones,
              COALESCE((SELECT SUM(m.monto) FROM pagos_proveedores_metodos m WHERE m.pago_id = p.id), 0) AS total_pago
       FROM pagos_proveedores p
       WHERE p.proveedor_id = ?
       ORDER BY p.fecha ASC`,
      [proveedorId]
    ).map(p => {
      const metodos = db().query(
        `SELECT metodo, referencia FROM pagos_proveedores_metodos WHERE pago_id = ?`,
        [p.id]
      );
      const desc = metodos.map(m =>
        (m.metodo === 'efectivo' ? 'Efectivo' : 'Transferencia')
        + (m.referencia ? ` (${m.referencia})` : '')
      ).join(' + ') || p.observaciones || 'Pago';
      return {
        id:                p.id,
        fecha:             p.fecha,
        desc,
        total_pago:        parseFloat(p.total_pago) || 0,
        credito_disponible: _getCreditoDisponibleDePago(p.id),
      };
    }).filter(p => p.credito_disponible > 0.01);

    return { compras, pagos_sin_imputar };
  }

  function getResumenProveedores() {
    const proveedores = db().query(
      `SELECT p.id, p.razon_social, p.condicion_pago, p.telefono, p.contacto_nombre
       FROM proveedores p WHERE p.activo = 1
       ORDER BY p.razon_social COLLATE NOCASE ASC`
    );
    return proveedores.map(p => ({ ...p, saldo: getSaldoProveedor(p.id) }));
  }

  function getSesionActiva(sucursalId) {
    const r = window.SGA_DB.query(
      `SELECT id FROM sesiones_caja WHERE sucursal_id=? AND estado='abierta' LIMIT 1`,
      [sucursalId]
    );
    return r[0] || null;
  }

  return {
    getSaldoProveedor,
    getComprasPendientes,
    getCreditosDisponibles,
    getLedger,
    getLedgerAgrupado,
    crearPago,
    imputar,
    getResumenProveedores,
    getSesionActiva,
  };
})();

window.SGA_PagosProveedores = SGA_PagosProveedores;

// ── UI MODULE ─────────────────────────────────────────────────────────────────

const CuentaCorrienteProveedores = (() => {
  'use strict';

  const ge  = id => document.getElementById(id);
  const esc = s  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt$ = n => {
    if (n == null || isNaN(n)) return '$ 0,00';
    const [i, d] = Math.abs(n).toFixed(2).split('.');
    return '$ ' + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d;
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtFecha = s => {
    if (!s) return '—';
    const [y, m, d] = s.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  };

  const state = {
    view:        'lista',   // 'lista' | 'detalle'
    search:      '',
    soloDeuda:   true,
    proveedorId: null,
    proveedorNombre: '',
    ledgerMode:  'agrupado', // 'agrupado' | 'cronologico'
  };

  const data = () => window.SGA_PagosProveedores;

  // ── SALDO BADGE ──────────────────────────────────────────────────────────────

  function saldoBadge(saldo) {
    if (saldo > 0.01) return `<span class="saldo-badge deuda">${fmt$(saldo)}</span>`;
    if (saldo < -0.01) return `<span class="saldo-badge credito">Crédito ${fmt$(Math.abs(saldo))}</span>`;
    return `<span class="saldo-badge saldado">Sin deuda</span>`;
  }

  // ── VISTA LISTA ──────────────────────────────────────────────────────────────

  // Renders only the table content — called on every filter change, preserves focus
  function renderTabla() {
    const wrap = ge('ccprov-table-wrap');
    if (!wrap) return;

    let proveedores = data().getResumenProveedores();

    if (state.soloDeuda) proveedores = proveedores.filter(p => p.saldo > 0.01);
    if (state.search) {
      const q = state.search.toLowerCase();
      proveedores = proveedores.filter(p =>
        p.razon_social.toLowerCase().includes(q) ||
        (p.contacto_nombre || '').toLowerCase().includes(q)
      );
    }

    proveedores.sort((a, b) => {
      if (b.saldo > 0.01 && !(a.saldo > 0.01)) return 1;
      if (a.saldo > 0.01 && !(b.saldo > 0.01)) return -1;
      return b.saldo - a.saldo;
    });

    const totalDeuda = proveedores.filter(p => p.saldo > 0.01).reduce((s, p) => s + p.saldo, 0);

    // Update subtitle count
    const sub = ge('ccprov-lista-sub');
    if (sub) sub.textContent = `${proveedores.length} proveedor${proveedores.length !== 1 ? 'es' : ''}`;

    wrap.innerHTML = `
      ${totalDeuda > 0.01 ? `
      <div style="padding:14px 0 2px;display:flex;justify-content:flex-end;align-items:center;gap:8px;font-size:13px;color:var(--color-text-secondary)">
        Total adeudado: <strong style="color:#e65100;font-size:15px">${fmt$(totalDeuda)}</strong>
      </div>` : ''}

      ${!proveedores.length ? `
        <div class="ccprov-empty">
          <div class="ccprov-empty-icon">📒</div>
          <p>${state.search ? 'Sin resultados.' : state.soloDeuda ? 'No hay proveedores con deuda pendiente.' : 'No hay proveedores registrados.'}</p>
          ${state.soloDeuda ? `<button class="ccprov-btn-link" id="btn-ver-todos">Ver todos los proveedores</button>` : ''}
        </div>
      ` : `
      <table class="ccprov-table">
        <thead>
          <tr>
            <th>Proveedor</th>
            <th>Contacto</th>
            <th>Cond. pago</th>
            <th class="right">Saldo</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${proveedores.map(p => `
            <tr>
              <td><strong>${esc(p.razon_social)}</strong></td>
              <td>${esc(p.contacto_nombre || '—')}</td>
              <td>${esc(p.condicion_pago || '—')}</td>
              <td class="right">${saldoBadge(p.saldo)}</td>
              <td>
                <div class="ccprov-actions">
                  <button class="ccprov-btn-icon btn-ver-detalle" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Ver cuenta corriente">📋</button>
                  <button class="ccprov-btn-icon btn-pagar" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Registrar pago">💳</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      `}
    `;

    ge('btn-ver-todos')?.addEventListener('click', () => { state.soloDeuda = false; syncToggleBtn(); renderTabla(); });

    wrap.querySelectorAll('.btn-ver-detalle').forEach(btn => {
      btn.addEventListener('click', () => renderDetalle(btn.dataset.id, btn.dataset.nombre));
    });
    wrap.querySelectorAll('.btn-pagar').forEach(btn => {
      btn.addEventListener('click', () => openModalPago(btn.dataset.id, btn.dataset.nombre));
    });
  }

  function syncToggleBtn() {
    ge('btn-toggle-deuda')?.classList.toggle('active', state.soloDeuda);
  }

  // Renders shell (header + filters) once; subsequent filter changes only update the table
  function renderLista() {
    const root = ge('ccprov-root');
    if (!root) return;

    root.innerHTML = `
      <div class="ccprov-header">
        <div class="ccprov-header-left">
          <div>
            <h2>📒 Cuentas Corrientes</h2>
            <span class="ccprov-header-sub" id="ccprov-lista-sub"></span>
          </div>
        </div>
        <div class="ccprov-header-right">
          <button class="ccprov-btn-primary" id="btn-nuevo-pago-general">+ Registrar Pago</button>
        </div>
      </div>

      <div class="ccprov-filters">
        <input type="text" class="ccprov-search" id="ccprov-search"
          placeholder="Buscar proveedor…" autocomplete="off" spellcheck="false">
        <button class="ccprov-toggle ${state.soloDeuda ? 'active' : ''}" id="btn-toggle-deuda">
          Solo con deuda
        </button>
      </div>

      <div class="ccprov-table-wrap" id="ccprov-table-wrap"></div>
    `;

    // Populate table immediately
    renderTabla();

    // Search: debounced, updates only the table — focus never leaves the input
    let searchTimer = null;
    ge('ccprov-search').addEventListener('input', e => {
      state.search = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderTabla(), 180);
    });

    ge('btn-toggle-deuda').addEventListener('click', () => {
      state.soloDeuda = !state.soloDeuda;
      syncToggleBtn();
      renderTabla();
    });

    ge('btn-nuevo-pago-general').addEventListener('click', () => openModalPago(null, null));

    // Auto-focus search
    ge('ccprov-search').focus();
  }

  // ── VISTA DETALLE ────────────────────────────────────────────────────────────

  function buildTablaPlana(ledger, saldo) {
    if (!ledger.length) return `
      <div class="ccprov-empty">
        <div class="ccprov-empty-icon">📋</div>
        <p>Sin movimientos registrados.</p>
      </div>`;
    return `
      <table class="ccprov-table">
        <thead>
          <tr>
            <th>Fecha</th><th>Tipo</th><th>Referencia</th>
            <th class="right">Debe</th><th class="right">Haber</th><th class="right">Saldo</th>
          </tr>
        </thead>
        <tbody>
          ${ledger.map(e => `
            <tr class="ledger-row-${e.tipo}">
              <td>${fmtFecha(e.fecha)}</td>
              <td><span class="ledger-type-badge ledger-type-${e.tipo}">${e.tipo === 'compra' ? 'Compra' : 'Pago'}</span></td>
              <td>
                ${esc(e.referencia)}
                ${e.tipo === 'compra' && e.saldo_item > 0.01 ? `<span class="ledger-saldo-parcial"> · Saldo: ${fmt$(e.saldo_item)}</span>` : ''}
              </td>
              <td class="right">${e.debe > 0 ? `<span class="ledger-debe">${fmt$(e.debe)}</span>` : '—'}</td>
              <td class="right">${e.haber > 0 ? `<span class="ledger-haber">${fmt$(e.haber)}</span>` : '—'}</td>
              <td class="right">
                <span class="${e.saldo_acumulado > 0.01 ? 'ledger-saldo-deuda' : 'ledger-saldo-saldado'}">
                  ${fmt$(Math.abs(e.saldo_acumulado))}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="color:var(--color-text-secondary)">Total</td>
            <td class="right ledger-debe">${fmt$(ledger.reduce((s,e) => s + e.debe, 0))}</td>
            <td class="right ledger-haber">${fmt$(ledger.reduce((s,e) => s + e.haber, 0))}</td>
            <td class="right">
              <span class="${saldo > 0.01 ? 'ledger-saldo-deuda' : 'ledger-saldo-saldado'}">${fmt$(Math.abs(saldo))}</span>
            </td>
          </tr>
        </tfoot>
      </table>`;
  }

  function buildTablaAgrupada(agrupado, saldo) {
    const { compras, pagos_sin_imputar } = agrupado;
    if (!compras.length) return `
      <div class="ccprov-empty">
        <div class="ccprov-empty-icon">📋</div>
        <p>Sin movimientos registrados.</p>
      </div>`;

    const totalDebe  = compras.reduce((s, c) => s + c.total, 0);
    const totalHaber = compras.reduce((s, c) => s + c.pagado, 0)
                     + pagos_sin_imputar.reduce((s, p) => s + p.credito_disponible, 0);

    return `
      <table class="ccprov-table">
        <thead>
          <tr>
            <th>Fecha</th><th>Tipo</th><th>Referencia / Pago</th>
            <th class="right">Debe</th><th class="right">Haber</th><th class="right">Saldo factura</th>
          </tr>
        </thead>
        <tbody>
          ${compras.map(c => `
            <tr class="ledger-row-compra${c.saldo_item < 0.01 ? ' ledger-row-compra-saldada' : ''}">
              <td>${fmtFecha(c.fecha)}</td>
              <td><span class="ledger-type-badge ledger-type-compra">Compra</span></td>
              <td>${esc(c.referencia)}</td>
              <td class="right"><span class="ledger-debe">${fmt$(c.total)}</span></td>
              <td class="right">—</td>
              <td class="right">
                ${c.saldo_item < 0.01
                  ? `<span class="ledger-saldo-cero">Saldada</span>`
                  : `<span class="ledger-saldo-deuda">${fmt$(c.saldo_item)}</span>`}
              </td>
            </tr>
            ${c.imputaciones.length
              ? c.imputaciones.map(i => `
                <tr class="ledger-row-imp">
                  <td>${fmtFecha(i.fecha)}</td>
                  <td><span class="ledger-type-badge ledger-type-pago">Pago</span></td>
                  <td><span class="ledger-imp-ref">${esc(i.desc)}</span></td>
                  <td class="right">—</td>
                  <td class="right"><span class="ledger-haber">${fmt$(i.monto)}</span></td>
                  <td class="right">—</td>
                </tr>`).join('')
              : `<tr class="ledger-row-imp">
                  <td></td><td></td>
                  <td><span class="ledger-sin-pagos">Sin pagos aplicados</span></td>
                  <td></td><td></td><td></td>
                </tr>`}
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="color:var(--color-text-secondary)">Total</td>
            <td class="right ledger-debe">${fmt$(totalDebe)}</td>
            <td class="right ledger-haber">${fmt$(totalHaber)}</td>
            <td class="right">
              <span class="${saldo > 0.01 ? 'ledger-saldo-deuda' : 'ledger-saldo-saldado'}">${fmt$(Math.abs(saldo))}</span>
            </td>
          </tr>
        </tfoot>
      </table>
      ${pagos_sin_imputar.length ? `
        <div class="ledger-orphan-section">
          <div class="ledger-orphan-title">💡 Pagos sin imputar a comprobantes</div>
          <table class="ccprov-table" style="margin-top:0">
            <tbody>
              ${pagos_sin_imputar.map(p => `
                <tr class="ledger-row-orphan">
                  <td style="width:90px">${fmtFecha(p.fecha)}</td>
                  <td><span class="ledger-type-badge ledger-type-pago">Pago</span></td>
                  <td>${esc(p.desc)}</td>
                  <td class="right">—</td>
                  <td class="right"><span class="ledger-haber">${fmt$(p.credito_disponible)}</span></td>
                  <td class="right">Crédito disponible</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}`;
  }

  function renderLedgerContent(proveedorId, saldo) {
    const wrap = ge('ccprov-ledger-wrap');
    if (!wrap) return;
    if (state.ledgerMode === 'agrupado') {
      const agrupado = data().getLedgerAgrupado(proveedorId);
      wrap.innerHTML = buildTablaAgrupada(agrupado, saldo);
    } else {
      const ledger = data().getLedger(proveedorId);
      wrap.innerHTML = buildTablaPlana(ledger, saldo);
    }
    // Sync toggle buttons
    ge('btn-ledger-agrupado')?.classList.toggle('active', state.ledgerMode === 'agrupado');
    ge('btn-ledger-plano')?.classList.toggle('active', state.ledgerMode === 'cronologico');
  }

  function renderDetalle(proveedorId, proveedorNombre) {
    state.view = 'detalle';
    state.proveedorId = proveedorId;
    state.proveedorNombre = proveedorNombre;

    const root = ge('ccprov-root');
    if (!root) return;

    const saldo    = data().getSaldoProveedor(proveedorId);
    const ledger   = data().getLedger(proveedorId);
    const creditos = data().getCreditosDisponibles(proveedorId);
    const totalCredito = creditos.reduce((s, c) => s + c.credito_disponible, 0);

    root.innerHTML = `
      <div class="ccprov-header">
        <div class="ccprov-header-left">
          <button class="ccprov-back-btn" id="btn-back">← Volver</button>
          <div>
            <h2>${esc(proveedorNombre)}</h2>
            <span class="ccprov-header-sub">Cuenta corriente</span>
          </div>
        </div>
        <div class="ccprov-header-right">
          <button class="ccprov-btn-primary" id="btn-registrar-pago">+ Registrar Pago</button>
        </div>
      </div>

      <div class="ccprov-saldo-card">
        <div class="ccprov-saldo-item">
          <span class="ccprov-saldo-label">Saldo actual</span>
          <span class="ccprov-saldo-value ${saldo > 0.01 ? 'deuda' : saldo < -0.01 ? 'credito' : 'saldado'}">
            ${fmt$(Math.abs(saldo))}
          </span>
          <span style="font-size:12px;color:var(--color-text-secondary);margin-top:2px">
            ${saldo > 0.01 ? 'Debemos al proveedor' : saldo < -0.01 ? 'El proveedor nos debe' : 'Cuenta saldada'}
          </span>
        </div>
        <div class="ccprov-saldo-item">
          <span class="ccprov-saldo-label">Comprobantes</span>
          <span class="ccprov-saldo-value" style="color:var(--color-text)">
            ${ledger.filter(e => e.tipo === 'compra').length}
          </span>
          <span style="font-size:12px;color:var(--color-text-secondary);margin-top:2px">compras registradas</span>
        </div>
        <div class="ccprov-saldo-item">
          <span class="ccprov-saldo-label">Pagos</span>
          <span class="ccprov-saldo-value" style="color:var(--color-text)">
            ${ledger.filter(e => e.tipo === 'pago').length}
          </span>
          <span style="font-size:12px;color:var(--color-text-secondary);margin-top:2px">pagos registrados</span>
        </div>
      </div>

      ${totalCredito > 0.01 ? `
      <div class="ccprov-credito-alert">
        💡 Hay <strong>${fmt$(totalCredito)}</strong> en pagos sin imputar (crédito disponible para aplicar a compras)
      </div>` : ''}

      <div class="ccprov-ledger-bar">
        <span class="ccprov-ledger-bar-label">Vista:</span>
        <div class="ccprov-ledger-toggle">
          <button id="btn-ledger-agrupado" class="${state.ledgerMode === 'agrupado' ? 'active' : ''}">Por factura</button>
          <button id="btn-ledger-plano"    class="${state.ledgerMode === 'cronologico' ? 'active' : ''}">Cronológico</button>
        </div>
      </div>

      <div class="ccprov-table-wrap" style="margin-top:8px">
        <div id="ccprov-ledger-wrap"></div>
      </div>
    `;

    renderLedgerContent(proveedorId, saldo);

    ge('btn-back').addEventListener('click', () => {
      state.view = 'lista';
      state.proveedorId = null;
      state.proveedorNombre = '';
      renderLista();
    });
    ge('btn-registrar-pago').addEventListener('click', () => openModalPago(proveedorId, proveedorNombre));
    ge('btn-ledger-agrupado').addEventListener('click', () => {
      state.ledgerMode = 'agrupado';
      renderLedgerContent(proveedorId, saldo);
    });
    ge('btn-ledger-plano').addEventListener('click', () => {
      state.ledgerMode = 'cronologico';
      renderLedgerContent(proveedorId, saldo);
    });
  }

  // ── MODAL PAGO ───────────────────────────────────────────────────────────────

  function openModalPago(proveedorId, proveedorNombre) {
    const overlay = ge('ccprov-overlay');
    if (!overlay) return;

    const user = window.SGA_Auth?.getCurrentUser?.();
    const sesion = user?.sucursal_id
      ? data().getSesionActiva(user.sucursal_id)
      : null;

    // Obtener proveedores para selector
    const proveedores = window.SGA_DB.query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 ORDER BY razon_social COLLATE NOCASE ASC`
    );

    const selProvOpts = proveedores.map(p =>
      `<option value="${esc(p.id)}" ${p.id === proveedorId ? 'selected' : ''}>${esc(p.razon_social)}</option>`
    ).join('');

    overlay.innerHTML = `
      <div class="ccprov-modal">
        <div class="ccprov-modal-hdr">
          <span>💳 Registrar Pago a Proveedor</span>
          <button class="ccprov-modal-close" id="btn-modal-close">✕</button>
        </div>
        <div class="ccprov-modal-body">

          <!-- PROVEEDOR + FECHA -->
          <div class="ccprov-field-row">
            <div class="ccprov-field" style="flex:2">
              <label>Proveedor <span style="color:var(--color-danger)">*</span></label>
              <select class="ccprov-input" id="mp-proveedor">
                <option value="">— Seleccionar —</option>
                ${selProvOpts}
              </select>
            </div>
            <div class="ccprov-field" style="flex:1">
              <label>Fecha</label>
              <input type="date" class="ccprov-input" id="mp-fecha" value="${today()}">
            </div>
          </div>

          <div class="ccprov-field">
            <label>Observaciones</label>
            <input type="text" class="ccprov-input" id="mp-obs" placeholder="Factura, descripción, etc.">
          </div>

          <!-- MÉTODOS DE PAGO -->
          <div>
            <p class="ccprov-section-title">Formas de pago</p>

            <div class="ccprov-metodo-row" id="row-efectivo">
              <input type="checkbox" class="ccprov-metodo-check" id="chk-efectivo">
              <span class="ccprov-metodo-label">💵 Efectivo</span>
              <div class="ccprov-metodo-inputs">
                <input type="number" class="ccprov-input" id="mp-ef-monto"
                  placeholder="$ 0,00" min="0" step="0.01"
                  ${!sesion ? 'disabled title="No hay caja abierta"' : ''}>
                ${!sesion ? '<span style="font-size:12px;color:#999">Sin caja abierta</span>' : ''}
              </div>
            </div>

            <div class="ccprov-metodo-row" id="row-transferencia">
              <input type="checkbox" class="ccprov-metodo-check" id="chk-transferencia">
              <span class="ccprov-metodo-label">🏦 Transferencia</span>
              <div class="ccprov-metodo-inputs">
                <input type="number" class="ccprov-input" id="mp-tr-monto" placeholder="$ 0,00" min="0" step="0.01">
                <input type="text" class="ccprov-input ccprov-metodo-ref" id="mp-tr-ref" placeholder="Nro. comprobante (opcional)">
              </div>
            </div>

            <div class="ccprov-total-row">
              <span>Total del pago:</span>
              <span class="ccprov-total-monto" id="mp-total">$ 0,00</span>
            </div>
          </div>

          <!-- IMPUTACIÓN -->
          <div id="mp-imp-section">
            <p class="ccprov-section-title">Aplicar a comprobantes</p>
            <div id="mp-imp-content">
              <span style="font-size:13px;color:var(--color-text-secondary)">
                Seleccioná un proveedor para ver sus comprobantes pendientes.
              </span>
            </div>
          </div>

          <!-- SOBRANTE / PREVIEW -->
          <div id="mp-sobrante-wrap" style="display:none"></div>

          <!-- ERROR -->
          <div class="ccprov-error" id="mp-error"></div>

        </div>
        <div class="ccprov-modal-ftr">
          <span style="font-size:12px;color:var(--color-text-secondary)" id="mp-sesion-info">
            ${sesion ? '✅ Caja abierta' : '⚠️ Sin caja — los pagos en efectivo no estarán disponibles'}
          </span>
          <div class="ccprov-modal-ftr-right">
            <button class="ccprov-btn-secondary" id="btn-modal-cancel">Cancelar</button>
            <button class="ccprov-btn-primary" id="btn-modal-guardar">Guardar pago</button>
          </div>
        </div>
      </div>
    `;

    overlay.classList.remove('hidden');

    // ── Estado del modal ──────────────────────────────────────────────────────
    let autoImputar = true;
    let comprasPendientes = [];

    // ── Helpers ───────────────────────────────────────────────────────────────
    const close = () => {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    };
    const getTotal = () => {
      let t = 0;
      if (ge('chk-efectivo').checked) t += parseFloat(ge('mp-ef-monto').value) || 0;
      if (ge('chk-transferencia').checked) t += parseFloat(ge('mp-tr-monto').value) || 0;
      return t;
    };
    const showError = msg => {
      const el = ge('mp-error');
      el.textContent = msg;
      el.classList.add('visible');
    };
    const clearError = () => ge('mp-error').classList.remove('visible');

    // ── Actualizar total + sobrante ───────────────────────────────────────────
    // onTotalChanged: hook for renderImpSection to react when total changes
    let onTotalChanged = null;

    const updateTotal = () => {
      const total = getTotal();
      ge('mp-total').textContent = fmt$(total);
      updateSobrante(total);
      if (onTotalChanged) onTotalChanged(total);
    };

    const updateSobrante = (total) => {
      const wrap = ge('mp-sobrante-wrap');
      if (total <= 0) { wrap.style.display = 'none'; return; }

      if (autoImputar) {
        const provId = ge('mp-proveedor').value;
        if (!provId) { wrap.style.display = 'none'; return; }
        // Calcular cuánto quedaría sin imputar
        let restante = total;
        for (const c of comprasPendientes) {
          if (restante <= 0.01) break;
          restante -= Math.min(restante, c.saldo);
        }
        if (restante > 0.01) {
          wrap.style.display = '';
          wrap.innerHTML = `<div class="ccprov-sobrante">
            💡 Quedarán <strong>${fmt$(restante)}</strong> como crédito a favor (pago adelantado)
          </div>`;
        } else {
          wrap.style.display = 'none';
        }
      } else {
        // Manual: calcular diferencia entre total pago y suma de montos manuales
        let imputado = 0;
        document.querySelectorAll('.imp-monto-input').forEach(inp => {
          imputado += parseFloat(inp.value) || 0;
        });
        const diff = total - imputado;
        if (Math.abs(diff) > 0.01) {
          wrap.style.display = '';
          wrap.innerHTML = `<div class="ccprov-sobrante ${diff < 0 ? 'warn' : ''}">
            ${diff > 0
              ? `💡 Quedarán <strong>${fmt$(diff)}</strong> sin imputar (crédito a favor)`
              : `⚠️ Los montos imputados superan el total del pago en <strong>${fmt$(Math.abs(diff))}</strong>`}
          </div>`;
        } else {
          wrap.style.display = 'none';
        }
      }
    };

    // ── Render sección imputación ─────────────────────────────────────────────
    const renderImpSection = () => {
      const provId = ge('mp-proveedor').value;
      const cont = ge('mp-imp-content');
      if (!provId) {
        cont.innerHTML = `<span style="font-size:13px;color:var(--color-text-secondary)">Seleccioná un proveedor.</span>`;
        return;
      }

      comprasPendientes = data().getComprasPendientes(provId);
      const creditos = data().getCreditosDisponibles(provId);
      const totalCredito = creditos.reduce((s, c) => s + c.credito_disponible, 0);

      let html = '';

      if (totalCredito > 0.01) {
        html += `<div class="ccprov-credito-alert" style="margin:0 0 10px">
          💡 Crédito disponible sin imputar: <strong>${fmt$(totalCredito)}</strong>
        </div>`;
      }

      if (!comprasPendientes.length) {
        html += `<div style="font-size:13px;color:var(--color-text-secondary);padding:8px 0">
          ✅ Este proveedor no tiene comprobantes pendientes. El pago quedará como crédito a favor.
        </div>`;
        cont.innerHTML = html;
        updateSobrante(getTotal());
        return;
      }

      html += `
        <label class="ccprov-imp-toggle" style="margin-bottom:10px">
          <input type="checkbox" id="chk-auto-imputar" ${autoImputar ? 'checked' : ''}>
          Aplicar automáticamente por antigüedad
        </label>

        <table class="ccprov-pending-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Comprobante</th>
              <th class="right">Total</th>
              <th class="right">Saldo</th>
              <th class="right">Imputar</th>
            </tr>
          </thead>
          <tbody>
            ${comprasPendientes.map((c, idx) => {
              const ref = [c.factura_pv, c.numero_factura].filter(Boolean).join('-') || c.id.slice(-6).toUpperCase();
              return `
              <tr>
                <td>${fmtFecha(c.fecha)}</td>
                <td>${esc(ref)}</td>
                <td class="right">${fmt$(c.total)}</td>
                <td class="right" style="color:#e65100;font-weight:600">${fmt$(c.saldo)}</td>
                <td class="right">
                  <input type="number" class="ccprov-imp-amount imp-monto-input"
                    data-idx="${idx}"
                    data-saldo="${c.saldo}"
                    data-compra-id="${esc(c.id)}"
                    placeholder="${autoImputar ? '' : '0,00'}"
                    min="0" max="${c.saldo}" step="0.01"
                    ${autoImputar ? 'disabled' : ''}>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `;

      cont.innerHTML = html;

      // Calcula cuánto le corresponde a cada comprobante según oldest-first con el total actual
      const calcAutoMontos = (total) => {
        let restante = total;
        return comprasPendientes.map(c => {
          if (restante <= 0.01) return 0;
          const monto = Math.min(restante, c.saldo);
          restante -= monto;
          return monto;
        });
      };

      // Pobla los inputs con los montos calculados (auto) o los vacía (manual)
      const syncInputValues = () => {
        const inputs = document.querySelectorAll('.imp-monto-input');
        if (autoImputar) {
          const montos = calcAutoMontos(getTotal());
          inputs.forEach((inp, i) => {
            inp.value = montos[i] > 0.001 ? montos[i].toFixed(2) : '';
            inp.disabled = true;
            inp.placeholder = '';
          });
        } else {
          inputs.forEach(inp => {
            inp.value = '';
            inp.disabled = false;
            inp.placeholder = '0,00';
          });
        }
      };

      // Populate initial values if auto is on
      syncInputValues();

      // Toggle auto/manual
      ge('chk-auto-imputar').addEventListener('change', e => {
        autoImputar = e.target.checked;
        syncInputValues();
        updateSobrante(getTotal());
      });

      // Re-calculate auto distribution whenever total changes
      onTotalChanged = () => { if (autoImputar) syncInputValues(); };

      // Actualizar sobrante al cambiar montos manuales
      cont.querySelectorAll('.imp-monto-input').forEach(inp => {
        inp.addEventListener('input', () => updateSobrante(getTotal()));
      });

      updateSobrante(getTotal());
    };

    // ── Checkbox handlers ─────────────────────────────────────────────────────
    const syncCheckboxStyle = (id, rowId) => {
      const checked = ge(id).checked;
      ge(rowId).classList.toggle('active', checked);
    };

    ge('chk-efectivo').addEventListener('change', () => {
      syncCheckboxStyle('chk-efectivo', 'row-efectivo');
      updateTotal();
    });
    ge('chk-transferencia').addEventListener('change', () => {
      syncCheckboxStyle('chk-transferencia', 'row-transferencia');
      updateTotal();
    });
    ge('mp-ef-monto').addEventListener('input', updateTotal);
    ge('mp-tr-monto').addEventListener('input', updateTotal);

    // ── Proveedor change ──────────────────────────────────────────────────────
    ge('mp-proveedor').addEventListener('change', () => {
      renderImpSection();
      updateTotal();
    });

    // Render inicial si ya había proveedor
    if (proveedorId) renderImpSection();

    // ── Close handlers ────────────────────────────────────────────────────────
    ge('btn-modal-close').addEventListener('click', close);
    ge('btn-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // ── Guardar ───────────────────────────────────────────────────────────────
    ge('btn-modal-guardar').addEventListener('click', () => {
      clearError();

      const provId = ge('mp-proveedor').value;
      if (!provId) { showError('Seleccioná un proveedor.'); return; }

      const total = getTotal();
      if (total <= 0) { showError('Ingresá al menos un monto.'); return; }

      // Construir metodos
      const metodos = [];
      if (ge('chk-efectivo').checked) {
        const monto = parseFloat(ge('mp-ef-monto').value) || 0;
        if (monto > 0) {
          metodos.push({
            metodo: 'efectivo',
            monto,
            sesion_caja_id: sesion?.id || null,
          });
        }
      }
      if (ge('chk-transferencia').checked) {
        const monto = parseFloat(ge('mp-tr-monto').value) || 0;
        if (monto > 0) {
          metodos.push({
            metodo: 'transferencia',
            monto,
            referencia: ge('mp-tr-ref').value.trim() || null,
          });
        }
      }
      if (!metodos.length) { showError('Ingresá al menos un monto.'); return; }

      // Construir imputaciones
      let imputaciones;
      if (!autoImputar) {
        imputaciones = [];
        document.querySelectorAll('.imp-monto-input').forEach(inp => {
          const monto = parseFloat(inp.value) || 0;
          if (monto > 0) {
            imputaciones.push({ compra_id: inp.dataset.compraId, monto });
          }
        });
        // Validar que no superen el saldo de cada compra
        for (const inp of document.querySelectorAll('.imp-monto-input')) {
          const monto = parseFloat(inp.value) || 0;
          const saldo = parseFloat(inp.dataset.saldo) || 0;
          if (monto > saldo + 0.01) {
            showError(`El monto imputado no puede superar el saldo del comprobante.`);
            return;
          }
        }
      }

      const result = data().crearPago({
        proveedor_id: provId,
        fecha: ge('mp-fecha').value || today(),
        observaciones: ge('mp-obs').value.trim() || null,
        usuario_id: user?.id || null,
        metodos,
        imputaciones,
        auto_imputar: autoImputar,
      });

      if (!result.success) {
        showError('Error al guardar: ' + result.error);
        return;
      }

      close();

      // Refrescar la vista actual
      if (state.view === 'detalle' && state.proveedorId === provId) {
        renderDetalle(state.proveedorId, state.proveedorNombre);
      } else if (state.view === 'detalle') {
        renderDetalle(state.proveedorId, state.proveedorNombre);
      } else {
        renderLista();
      }

      // Toast
      if (window.SGA_Utils?.showToast) {
        const sobrante = result.credito_sobrante || 0;
        const msg = sobrante > 0.01
          ? `Pago registrado. Crédito disponible: ${fmt$(sobrante)}`
          : 'Pago registrado correctamente.';
        window.SGA_Utils.showToast(msg, 'success');
      }
    });
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────

  const init = () => {
    const root = ge('ccprov-root');
    if (!root) return;

    // Reset state on each load
    state.view = 'lista';
    state.search = '';
    state.soloDeuda = true;
    state.proveedorId = null;
    state.proveedorNombre = '';

    renderLista();
  };

  return { init };
})();

export default CuentaCorrienteProveedores;
