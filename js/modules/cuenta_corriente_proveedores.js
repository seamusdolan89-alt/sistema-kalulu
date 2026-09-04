/**
 * cuenta_corriente_proveedores.js — Supplier Accounts Payable
 *
 * Exposes window.SGA_PagosProveedores (data layer).
 * Exports default { init } for SPA router (full UI).
 */

import PagoWizard from './pago_proveedor_wizard.js';

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

  function _getPagadoDeGasto(gastoId) {
    const r = db().query(
      `SELECT COALESCE(SUM(monto_imputado), 0) AS total FROM imputaciones_pagos WHERE gasto_id = ?`,
      [gastoId]
    );
    return parseFloat(r[0]?.total) || 0;
  }

  // Gastos de servicios que entran a la cuenta corriente. Son SOLO los cargados
  // con metodo "queda a pagar": un gasto pagado en el momento (transferencia,
  // efectivo, debito) no es una deuda con el proveedor, y meterlos a todos
  // haria aparecer deuda falsa por cada gasto historico ya saldado.
  function _getGastosCtaCte(proveedorId) {
    return db().query(
      `SELECT id, fecha, comprobante, descripcion, monto
       FROM gastos
       WHERE proveedor_id = ? AND metodo_pago = 'cuenta_corriente'
       ORDER BY fecha ASC, rowid ASC`,
      [proveedorId]
    ) || [];
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
    const deudaGastos = db().query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM gastos
       WHERE proveedor_id = ? AND metodo_pago = 'cuenta_corriente'`,
      [proveedorId]
    );
    const pagado = db().query(
      `SELECT COALESCE(SUM(m.monto), 0) AS total
       FROM pagos_proveedores_metodos m
       JOIN pagos_proveedores p ON p.id = m.pago_id
       WHERE p.proveedor_id = ?`,
      [proveedorId]
    );
    return (parseFloat(deuda[0]?.total) || 0)
         + (parseFloat(deudaGastos[0]?.total) || 0)
         - (parseFloat(pagado[0]?.total) || 0);
  }

  function getComprasPendientes(proveedorId) {
    const compras = db().query(
      `SELECT id, fecha, numero_factura, factura_pv, total, condicion_pago
       FROM compras
       WHERE proveedor_id = ? AND COALESCE(estado,'confirmada') != 'anulada'
       ORDER BY fecha ASC, rowid ASC`,
      [proveedorId]
    );
    const pendientesCompras = compras
      .map(c => ({
        ...c,
        tipo:   'compra',
        pagado: _getPagadoDeCompra(c.id),
        saldo:  (parseFloat(c.total) || 0) - _getPagadoDeCompra(c.id),
      }))
      .filter(c => c.saldo > 0.01);

    // Los gastos "queda a pagar" se comportan igual que una factura: se listan
    // como comprobante pendiente y se les puede imputar un pago. numero_factura
    // toma el N° de comprobante del gasto para que los consumidores que arman
    // la referencia con factura_pv/numero_factura sigan funcionando igual.
    const pendientesGastos = _getGastosCtaCte(proveedorId)
      .map(g => {
        const pagado = _getPagadoDeGasto(g.id);
        return {
          id:             g.id,
          tipo:           'gasto',
          fecha:          g.fecha,
          numero_factura: g.comprobante || null,
          factura_pv:     null,
          descripcion:    g.descripcion || null,
          total:          parseFloat(g.monto) || 0,
          condicion_pago: 'pendiente',
          pagado,
          saldo:          (parseFloat(g.monto) || 0) - pagado,
        };
      })
      .filter(g => g.saldo > 0.01);

    return [...pendientesCompras, ...pendientesGastos]
      .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
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

    const gastos = _getGastosCtaCte(proveedorId).map(g => {
      const pagado = _getPagadoDeGasto(g.id);
      const monto  = parseFloat(g.monto) || 0;
      return {
        tipo:           'gasto',
        id:             g.id,
        fecha:          g.fecha,
        referencia:     g.comprobante || g.descripcion || 'Gasto',
        debe:           monto,
        haber:          0,
        condicion_pago: 'pendiente',
        pagado,
        saldo_item:     monto - pagado,
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
      const METODO_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia', caja_seamus: 'Caja Seamus', mercadopago: 'MercadoPago' };
      const desc = metodos.map(m =>
        (METODO_LABEL[m.metodo] || m.metodo)
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

    // Los gastos van con las compras: los dos son comprobantes que suman deuda.
    // El orden dentro de un mismo dia pone primero lo que se debe y despues lo
    // que se pago, para que el saldo acumulado se lea bien.
    const entries = [...compras, ...gastos, ...pagos].sort((a, b) =>
      a.fecha.localeCompare(b.fecha) || (a.tipo === 'pago' ? 1 : -1)
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

    // Efectivo exige caja abierta. Sin sesion, el pago se registraba igual pero
    // el egreso nunca se creaba (mas abajo esta condicionado a sesion_caja_id):
    // quedaba plata saliendo de la caja sin movimiento que la respalde.
    const efectivoSinCaja = metodosFiltrados.some(
      m => m.metodo === 'efectivo' && !m.sesion_caja_id
    );
    if (efectivoSinCaja) {
      return { success: false, error: 'No hay una caja abierta: no se puede registrar un pago en efectivo' };
    }

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

        if (m.metodo === 'caja_seamus') {
          const provRow = db().query(`SELECT razon_social FROM proveedores WHERE id=?`, [proveedor_id])[0];
          const provNombre = provRow?.razon_social || '';
          const desc = observaciones
            ? `Pago ${provNombre} — ${observaciones}`
            : `Pago a proveedor${provNombre ? ' ' + provNombre : ''}`;
          db().run(
            `INSERT INTO caja_admin
               (id, tipo, monto, concepto, proveedor_id, fecha, usuario_id, sync_status, updated_at)
             VALUES (?, 'egreso', ?, ?, ?, ?, ?, 'pending', ?)`,
            [uid(), parseFloat(m.monto), desc, proveedor_id, fechaPago, usuario_id, ts]
          );
        }
      }

      // Imputaciones
      let creditoRestante = totalPago;

      // Si se pasan imputaciones explícitas (array con compra_id + monto)
      if (imputaciones !== undefined) {
        for (const imp of imputaciones) {
          if (creditoRestante <= 0.01) break;
          const docId = imp.compra_id || imp.gasto_id || imp.id;
          if (!docId) continue; // huérfano explícito
          const monto = Math.min(parseFloat(imp.monto) || 0, creditoRestante);
          if (monto <= 0.01) continue;
          const esGasto = imp.tipo === 'gasto' || (!imp.compra_id && !!imp.gasto_id);
          db().run(
            `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, gasto_id, monto_imputado, fecha) VALUES (?, ?, ?, ?, ?, ?)`,
            [uid(), pagoId, esGasto ? null : docId, esGasto ? docId : null, monto, fechaPago]
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
            `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, gasto_id, monto_imputado, fecha) VALUES (?, ?, ?, ?, ?, ?)`,
            [uid(), pagoId,
             c.tipo === 'gasto' ? null : c.id,
             c.tipo === 'gasto' ? c.id : null,
             monto, fechaPago]
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

  // docId puede ser una compra o un gasto "queda a pagar". Si no se aclara el
  // tipo se deduce: primero se busca como compra y, si no existe, como gasto.
  function imputar(pagoId, docId, monto, tipo) {
    const credito = _getCreditoDisponibleDePago(pagoId);
    if (credito <= 0.01) return { success: false, error: 'Sin crédito disponible' };

    let esGasto = tipo === 'gasto';
    let total   = null;

    if (!esGasto) {
      const compra = db().query(`SELECT total FROM compras WHERE id = ?`, [docId])[0];
      if (compra) {
        total = parseFloat(compra.total) || 0;
      } else if (tipo === undefined) {
        esGasto = true; // no es compra: probamos como gasto
      }
    }
    if (esGasto && total === null) {
      const gasto = db().query(
        `SELECT monto FROM gastos WHERE id = ? AND metodo_pago = 'cuenta_corriente'`, [docId]
      )[0];
      if (!gasto) return { success: false, error: 'Comprobante no encontrado' };
      total = parseFloat(gasto.monto) || 0;
    }
    if (total === null) return { success: false, error: 'Comprobante no encontrado' };

    const pagadoDoc = esGasto ? _getPagadoDeGasto(docId) : _getPagadoDeCompra(docId);
    const saldoDoc  = total - pagadoDoc;
    if (saldoDoc <= 0.01) return { success: false, error: 'Comprobante ya saldado' };

    const montoImp = monto !== undefined
      ? Math.min(parseFloat(monto), credito, saldoDoc)
      : Math.min(credito, saldoDoc);
    if (montoImp <= 0.01) return { success: false, error: 'Monto inválido' };
    try {
      db().run(
        `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, gasto_id, monto_imputado, fecha) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid(), pagoId, esGasto ? null : docId, esGasto ? docId : null, montoImp, now().slice(0, 10)]
      );
      // El pago viaja a la otra maquina con sus imputaciones embebidas (ver
      // denormalizePagoProveedor en sync.js). Como ya estaba 'synced', sin este
      // UPDATE la imputacion se quedaba en la maquina donde se hizo y del otro
      // lado el comprobante seguia figurando impago.
      db().run(
        `UPDATE pagos_proveedores SET sync_status='pending', updated_at=? WHERE id=?`,
        [now(), pagoId]
      );
      return { success: true, monto_aplicado: montoImp };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Imputaciones de un comprobante, ya formateadas. Sirve igual para una compra
  // (columna compra_id) que para un gasto (columna gasto_id).
  function _impsDeComprobante(campo, id) {
    return db().query(
      `SELECT ip.fecha, ip.monto_imputado, ip.pago_id, p.observaciones
       FROM imputaciones_pagos ip
       JOIN pagos_proveedores p ON p.id = ip.pago_id
       WHERE ip.${campo} = ?
       ORDER BY ip.fecha ASC`,
      [id]
    ).map(i => {
      const metodos = db().query(
        `SELECT metodo, referencia FROM pagos_proveedores_metodos WHERE pago_id = ?`,
        [i.pago_id]
      );
      const MLBL = { efectivo: 'Efectivo', transferencia: 'Transferencia', caja_seamus: 'Caja Seamus', mercadopago: 'MercadoPago' };
      const desc = metodos.map(m =>
        (MLBL[m.metodo] || m.metodo) + (m.referencia ? ` (${m.referencia})` : '')
      ).join(' + ') || i.observaciones || 'Pago';
      return { fecha: i.fecha, monto: parseFloat(i.monto_imputado) || 0, desc, pago_id: i.pago_id };
    });
  }

  function getLedgerAgrupado(proveedorId) {
    const compras = db().query(
      `SELECT id, fecha, numero_factura, factura_pv, total
       FROM compras
       WHERE proveedor_id = ? AND COALESCE(estado,'confirmada') != 'anulada'
       ORDER BY fecha ASC, rowid ASC`,
      [proveedorId]
    ).map(c => {
      const imps   = _impsDeComprobante('compra_id', c.id);
      const pagado = imps.reduce((s, i) => s + i.monto, 0);
      return {
        tipo:       'compra',
        id:         c.id,
        fecha:      c.fecha,
        referencia: [c.factura_pv, c.numero_factura].filter(Boolean).join('-') || '—',
        total:      parseFloat(c.total) || 0,
        pagado,
        saldo_item: (parseFloat(c.total) || 0) - pagado,
        imputaciones: imps,
      };
    });

    // Gastos "queda a pagar": mismo tratamiento que una factura. Sin esto, un
    // gasto sumaba al saldo del proveedor pero no figuraba en ningun listado,
    // asi que la cuenta daba bien y aun asi decia "Sin movimientos".
    const gastos = _getGastosCtaCte(proveedorId).map(g => {
      const imps   = _impsDeComprobante('gasto_id', g.id);
      const pagado = imps.reduce((s, i) => s + i.monto, 0);
      const monto  = parseFloat(g.monto) || 0;
      return {
        tipo:       'gasto',
        id:         g.id,
        fecha:      g.fecha,
        referencia: g.comprobante || g.descripcion || 'Gasto',
        total:      monto,
        pagado,
        saldo_item: monto - pagado,
        imputaciones: imps,
      };
    });

    compras.push(...gastos);
    compras.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

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
      const MLBL = { efectivo: 'Efectivo', transferencia: 'Transferencia', caja_seamus: 'Caja Seamus', mercadopago: 'MercadoPago' };
      const desc = metodos.map(m =>
        (MLBL[m.metodo] || m.metodo)
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
  function getRemitosCount(proveedorId) {
    try {
      const r = window.SGA_DB.query(
        `SELECT COUNT(*) AS n FROM remitos WHERE estado='pendiente' AND proveedor_id=?`,
        [proveedorId]
      );
      return parseInt(r[0]?.n) || 0;
    } catch(e) { return 0; }
  }

  function openRemitosProvModal(proveedorId, proveedorNombre) {
    // Create or reuse overlay
    let overlay = document.getElementById('ccprov-remitos-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ccprov-remitos-overlay';
      overlay.className = 'ccprov-remitos-overlay';
      document.body.appendChild(overlay);
    }

    const rows = window.SGA_DB.query(
      `SELECT r.*,
              (SELECT COUNT(*) FROM remito_items ri WHERE ri.remito_id = r.id) as n_items
       FROM remitos r WHERE r.estado='pendiente' AND r.proveedor_id=?
       ORDER BY r.fecha DESC, r.rowid DESC`,
      [proveedorId]
    );

    const rowsHtml = rows.length ? rows.map(r => {
      const [y, m, d] = (r.fecha || '').split('-');
      const fechaFmt = d && m && y ? `${d}/${m}/${y}` : (r.fecha || '—');
      return `
        <div class="ccprov-remito-row">
          <div class="ccprov-remito-info">
            <strong>Remito: ${esc(r.numero_remito || '—')}</strong>
            <span>${r.n_items} producto${r.n_items !== 1 ? 's' : ''} · Fecha: ${fechaFmt}</span>
          </div>
          <button class="ccprov-btn-vincular" data-id="${esc(r.id)}">Vincular Factura →</button>
        </div>`;
    }).join('') : `<div class="ccprov-remitos-empty">No hay remitos pendientes para este proveedor.</div>`;

    overlay.innerHTML = `
      <div class="ccprov-remitos-box">
        <div class="ccprov-remitos-hdr">
          <div>
            <div class="ccprov-remitos-hdr-title">📋 Remitos Pendientes — ${esc(proveedorNombre)}</div>
            <div class="ccprov-remitos-hdr-sub">Seleccioná el remito para vincularle la factura</div>
          </div>
          <button class="ccprov-remitos-close" id="ccprov-remitos-close-btn" aria-label="Cerrar" title="Cerrar">✕</button>
        </div>
        <div class="ccprov-remitos-body">${rowsHtml}</div>
      </div>
    `;

    overlay.style.display = 'flex';

    overlay.querySelector('#ccprov-remitos-close-btn')?.addEventListener('click', () => {
      overlay.style.display = 'none';
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
    overlay.querySelectorAll('.ccprov-btn-vincular').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.style.display = 'none';
        sessionStorage.setItem('compras_v2_vincular_remito', btn.dataset.id);
        window.location.hash = '#compras_v2';
      });
    });
  }

  function renderTabla() {
    const wrap = ge('ccprov-table-wrap');
    if (!wrap) return;

    let proveedores = data().getResumenProveedores();

    if (state.soloDeuda) proveedores = proveedores.filter(p => Math.abs(p.saldo) > 0.01);
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
          <p>${state.search ? 'Sin resultados.' : state.soloDeuda ? 'No hay proveedores con saldo pendiente.' : 'No hay proveedores registrados.'}</p>
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
          ${proveedores.map(p => {
            const remitosN = getRemitosCount(p.id);
            return `
            <tr>
              <td><strong>${esc(p.razon_social)}</strong></td>
              <td>${esc(p.contacto_nombre || '—')}</td>
              <td>${esc(p.condicion_pago || '—')}</td>
              <td class="right">${saldoBadge(p.saldo)}</td>
              <td>
                <div class="ccprov-actions">
                  <button class="ccprov-btn-icon btn-ver-detalle" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Ver cuenta corriente">📋</button>
                  <button class="ccprov-btn-icon btn-pagar" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Registrar pago">💳</button>
                  <button class="ccprov-btn-icon btn-remitos-prov${remitosN > 0 ? ' btn-remitos-active' : ''}" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Remitos pendientes de factura" style="${remitosN === 0 ? 'opacity:0.4' : ''}">
                    📄${remitosN > 0 ? `<span class="ccprov-remito-badge">${remitosN}</span>` : ''}
                  </button>
                </div>
              </td>
            </tr>`;
          }).join('')}
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
    wrap.querySelectorAll('.btn-remitos-prov').forEach(btn => {
      btn.addEventListener('click', () => openRemitosProvModal(btn.dataset.id, btn.dataset.nombre));
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
          Con saldo
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
              <td><span class="ledger-type-badge ${c.tipo === 'gasto' ? 'ledger-type-gasto' : 'ledger-type-compra'}">${c.tipo === 'gasto' ? 'Gasto' : 'Compra'}</span></td>
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
                  <td class="right">
                    <button class="ledger-btn-imputar" data-imputar-pago="${esc(p.id)}"
                            data-credito="${p.credito_disponible}">Imputar…</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}`;
  }

  // Imputar un pago YA registrado contra los comprobantes pendientes. Antes la
  // seccion "Pagos sin imputar" era de solo lectura, asi que un gasto y un pago
  // del mismo monto podian convivir dando saldo 0 sin estar asociados: la cuenta
  // cerraba pero no se sabia que pago cancelo que comprobante.
  function openModalImputar(pagoId, credito, proveedorId, proveedorNombre) {
    PagoWizard.ensureCss();   // el chrome del modal vive ahora en ese modulo
    const overlay = ge('ccprov-overlay');
    if (!overlay) return;

    const pendientes = data().getComprasPendientes(proveedorId);
    if (!pendientes.length) {
      alert('Este proveedor no tiene comprobantes pendientes para imputar.');
      return;
    }

    // Se prellena de mas viejo a mas nuevo hasta agotar el credito, que es el
    // criterio habitual; el usuario puede cambiar cualquier monto.
    let restante = credito;
    const filas = pendientes.map(c => {
      const sug = Math.min(restante, c.saldo);
      restante = Math.max(0, restante - sug);
      const ref = c.tipo === 'gasto'
        ? (c.numero_factura || c.descripcion || 'Gasto')
        : ([c.factura_pv, c.numero_factura].filter(Boolean).join('-') || c.id.slice(-6).toUpperCase());
      return { ...c, ref, sug };
    });

    overlay.innerHTML = `
      <div class="ccprov-modal" style="max-width:620px">
        <div class="ccprov-modal-hdr">
          <span>\u{1F4CE} Imputar pago \u2014 ${esc(proveedorNombre)}</span>
          <button class="ccprov-modal-close" id="btn-imp-close" aria-label="Cerrar" title="Cerrar">\u2715</button>
        </div>
        <div class="ccprov-modal-body">
          <p style="margin:0 0 10px;font-size:13px;color:var(--color-text-secondary)">
            Cr\u00e9dito disponible de este pago: <strong style="color:#2e7d32">${fmt$(credito)}</strong>
          </p>
          <div class="ledger-imputar-box">
            ${filas.map(c => `
              <div class="ledger-imputar-row">
                <span class="ledger-type-badge ${c.tipo === 'gasto' ? 'ledger-type-gasto' : 'ledger-type-compra'}">${c.tipo === 'gasto' ? 'Gasto' : 'Compra'}</span>
                <span class="lir-ref">${esc(c.ref)}</span>
                <span style="color:var(--color-text-secondary)">saldo ${fmt$(c.saldo)}</span>
                <input type="number" class="imp-row-input" data-id="${esc(c.id)}"
                       data-tipo="${esc(c.tipo)}" data-saldo="${c.saldo}"
                       value="${c.sug > 0 ? c.sug.toFixed(2) : ''}" min="0" max="${c.saldo}" step="0.01"
                       placeholder="0,00">
              </div>`).join('')}
          </div>
          <div id="imp-error" style="display:none;color:#c62828;font-size:13px;margin-top:8px"></div>
        </div>
        <div class="ccprov-modal-ftr">
          <button class="btn btn-outline" id="btn-imp-cancel">Cancelar</button>
          <button class="btn btn-primary" id="btn-imp-ok">Imputar</button>
        </div>
      </div>`;
    overlay.classList.remove('hidden');

    const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };
    ge('btn-imp-close').addEventListener('click', close);
    ge('btn-imp-cancel').addEventListener('click', close);

    ge('btn-imp-ok').addEventListener('click', () => {
      const err = ge('imp-error');
      const mostrar = m => { if (err) { err.textContent = m; err.style.display = 'block'; } };

      const aplicar = [];
      let suma = 0;
      for (const inp of overlay.querySelectorAll('.imp-row-input')) {
        const monto = parseFloat(inp.value) || 0;
        if (monto <= 0) continue;
        const saldo = parseFloat(inp.dataset.saldo) || 0;
        if (monto > saldo + 0.01) { mostrar('Un monto supera el saldo del comprobante.'); return; }
        suma += monto;
        aplicar.push({ id: inp.dataset.id, tipo: inp.dataset.tipo, monto });
      }
      if (!aplicar.length) { mostrar('Ingres\u00e1 al menos un monto.'); return; }
      if (suma > credito + 0.01) { mostrar('La suma supera el cr\u00e9dito disponible del pago.'); return; }

      for (const a of aplicar) {
        const r = data().imputar(pagoId, a.id, a.monto, a.tipo);
        if (!r.success) { mostrar('Error al imputar: ' + r.error); return; }
      }

      close();
      renderDetalle(proveedorId, proveedorNombre);
      if (window.SGA_Utils?.showToast) window.SGA_Utils.showToast('Pago imputado', 'success');
    });
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
    wrap.querySelectorAll('[data-imputar-pago]').forEach(btn => {
      btn.addEventListener('click', () => openModalImputar(
        btn.dataset.imputarPago,
        parseFloat(btn.dataset.credito) || 0,
        proveedorId,
        state.proveedorNombre
      ));
    });

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
            ${ledger.filter(e => e.tipo === 'compra' || e.tipo === 'gasto').length}
          </span>
          <span style="font-size:12px;color:var(--color-text-secondary);margin-top:2px">compras y gastos</span>
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

  // El wizard vive en js/modules/pago_proveedor_wizard.js: se comparte con Caja,
  // para que los dos botones de "pago a proveedor" abran exactamente lo mismo.
  function openModalPago(proveedorId, proveedorNombre) {
    PagoWizard.abrir({
      proveedorId,
      proveedorNombre,
      onSaved: () => {
        if (state.view === 'detalle') renderDetalle(state.proveedorId, state.proveedorNombre);
        else renderLista();
      },
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
