/**
 * cuenta_corriente_proveedores.js — Supplier Accounts Payable
 *
 * Exposes window.SGA_PagosProveedores (data layer).
 * Exports default { init } for SPA router (full UI).
 */

import PagoWizard from './pago_proveedor_wizard.js';
import NotaCreditoWizard from './nota_credito_wizard.js';

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

  // "NC A 0001-00012 (provisoria)" — lo que se ve en el ledger y en los avisos.
  function _refNC(p) {
    return 'NC' + (p.condicion_nc ? ' ' + p.condicion_nc : '')
      + (p.numero_comprobante ? ' ' + p.numero_comprobante : '')
      + (p.nc_provisoria ? ' (provisoria)' : '');
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
      `SELECT p.id, p.fecha, p.observaciones, p.tipo, p.numero_comprobante, p.condicion_nc, p.nc_provisoria,
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
      const METODO_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia', caja_seamus: 'Caja Seamus', mercadopago: 'MercadoPago', nota_credito: 'Nota de crédito' };
      const desc = metodos.map(m =>
        (METODO_LABEL[m.metodo] || m.metodo)
        + (m.referencia ? ` (${m.referencia})` : '')
      ).join(' + ');
      // Una nota de credito es un credito igual que un pago, pero se ve como "NC".
      const esNC = p.tipo === 'nota_credito';
      return {
        tipo:         esNC ? 'nc' : 'pago',
        id:           p.id,
        fecha:        p.fecha,
        referencia:   esNC ? _refNC(p) : (desc || p.observaciones || 'Pago'),
        debe:         0,
        haber:        parseFloat(p.total_pago) || 0,
        observaciones: p.observaciones,
        provisoria:   esNC && !!p.nc_provisoria,
      };
    });

    // Los gastos van con las compras: los dos son comprobantes que suman deuda.
    // El orden dentro de un mismo dia pone primero lo que se debe y despues lo
    // que se pago, para que el saldo acumulado se lea bien.
    const esCredito = e => e.tipo === 'pago' || e.tipo === 'nc';
    const entries = [...compras, ...gastos, ...pagos].sort((a, b) =>
      a.fecha.localeCompare(b.fecha) || (esCredito(a) ? 1 : -1)
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
          // La caja esperada se calcula sumando las filas de egresos_caja
          // (caja.js getTotalesSesion): NO se incrementa sesiones_caja.total_egresos.
          // Ese contador ya no lo lee nadie, y tocarlo marcaba la sesion como
          // 'pending' desde Admin-POS: con una copia vieja de la sesion, el POS
          // podia recibir una caja "abierta" que en realidad ya estaba cerrada.
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

  /**
   * Crear una nota de credito de proveedor. Es un CREDITO igual que un pago: se
   * guarda como un pago de metodo 'nota_credito' (asi el saldo, el credito
   * disponible, "Imputar…" y el ledger la entienden sin cambios) mas sus lineas.
   *
   * opts: {
   *   proveedor_id, fecha, usuario_id, sucursal_id?, observaciones?,
   *   numero_comprobante?, condicion_nc? ('A'|'B'|'C'|''), compra_origen_id?,
   *   items: [ {tipo:'producto', producto_id, cantidad, costo_unitario, iva?, mueve_stock?}     (devolucion)
   *          | {tipo:'concepto', concepto, subtotal, iva?} ],                                     (descuento)
   *   fiscal?: { subtotal_neto?, iva_105?, iva_21?, imp_interno?, percepcion_iva?, percepcion_iibb? },
   *   total?: importe del comprobante (editable: manda sobre lo calculado de las lineas),
   *   provisoria?: NC interna sin comprobante todavia,
   *   imputaciones?: [{compra_id|gasto_id, monto}]  |  imputar_a_compra_id  |  auto_imputar
   * }
   * Las lineas 'producto' con mueve_stock (por defecto si) bajan el stock (moverStock, 'nc_devolucion').
   * NO toca costos ni precios de ningun producto.
   */
  function crearNotaCredito(opts) {
    const {
      proveedor_id, fecha, usuario_id = null, observaciones = null,
      numero_comprobante = null, condicion_nc = '', compra_origen_id = null,
      items = [], fiscal = {}, provisoria = false,
      imputaciones, imputar_a_compra_id = null, auto_imputar = false,
    } = opts;
    if (!proveedor_id) return { success: false, error: 'proveedor_id requerido' };

    const user = window.SGA_Auth?.getCurrentUser?.() || {};
    const sucursalId = opts.sucursal_id || user.sucursal_id || null;
    const letraA = condicion_nc === 'A';
    const num = v => parseFloat(v) || 0;

    // Lineas normalizadas: subtotal NETO de IVA
    const lineas = [];
    for (const it of items) {
      if (it.tipo === 'concepto') {
        const sub = num(it.subtotal);
        if (sub <= 0 && !(it.concepto || '').trim()) continue;
        lineas.push({ tipo: 'concepto', producto_id: null, concepto: (it.concepto || '').trim() || 'Descuento',
                      cantidad: 0, costo_unitario: 0, subtotal: sub, iva: it.iva || null, mueve_stock: 0 });
      } else {
        const cant = num(it.cantidad), costo = num(it.costo_unitario);
        if (!it.producto_id || cant <= 0) continue;
        lineas.push({ tipo: 'producto', producto_id: it.producto_id, concepto: null,
                      cantidad: cant, costo_unitario: costo, subtotal: cant * costo, iva: it.iva || null,
                      mueve_stock: it.mueve_stock === false || it.mueve_stock === 0 ? 0 : 1 });
      }
    }

    const neto = lineas.reduce((s, l) => s + l.subtotal, 0);
    const ivaCalc = r => letraA ? lineas.filter(l => l.iva === r).reduce((s, l) => s + l.subtotal * (parseFloat(r) / 100), 0) : 0;
    const subtotalNeto = fiscal.subtotal_neto != null ? num(fiscal.subtotal_neto) : neto;
    const iva105 = fiscal.iva_105 != null ? num(fiscal.iva_105) : ivaCalc('10.5');
    const iva21  = fiscal.iva_21  != null ? num(fiscal.iva_21)  : ivaCalc('21');
    const impInt = num(fiscal.imp_interno), percIva = num(fiscal.percepcion_iva), percIibb = num(fiscal.percepcion_iibb);
    const totalCalc = letraA ? subtotalNeto + iva105 + iva21 + impInt + percIva + percIibb : neto;
    const total = num(opts.total) > 0 ? num(opts.total) : totalCalc;
    if (total <= 0.01) return { success: false, error: 'La nota de crédito no tiene importe' };

    const pagoId = uid();
    const ts = now();
    const fechaNC = fecha || ts.slice(0, 10);
    const motivoStock = `Devolución a proveedor — NC${numero_comprobante ? ' ' + numero_comprobante : ''}`;

    try {
      db().beginBatch();

      db().run(
        `INSERT INTO pagos_proveedores
           (id, proveedor_id, fecha, observaciones, usuario_id, tipo, numero_comprobante, condicion_nc,
            compra_origen_id, nc_provisoria, subtotal_neto, iva_105, iva_21, imp_interno,
            percepcion_iva, percepcion_iibb, sucursal_id, sync_status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'nota_credito', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [pagoId, proveedor_id, fechaNC, observaciones, usuario_id, numero_comprobante || null, condicion_nc || null,
         compra_origen_id || null, provisoria ? 1 : 0, subtotalNeto, iva105, iva21, impInt, percIva, percIibb,
         sucursalId, ts]
      );
      db().run(
        `INSERT INTO pagos_proveedores_metodos (id, pago_id, metodo, monto, referencia, sesion_caja_id)
         VALUES (?, ?, 'nota_credito', ?, ?, NULL)`,
        [uid(), pagoId, total, numero_comprobante || null]
      );

      for (const l of lineas) {
        db().run(
          `INSERT INTO pagos_proveedores_items
             (id, pago_id, tipo, producto_id, concepto, cantidad, costo_unitario, subtotal, iva, mueve_stock)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uid(), pagoId, l.tipo, l.producto_id, l.concepto, l.cantidad, l.costo_unitario, l.subtotal, l.iva, l.mueve_stock]
        );
        if (l.tipo === 'producto' && l.mueve_stock && sucursalId) {
          db().moverStock({
            productoId: l.producto_id, sucursalId, delta: -l.cantidad,
            tipo: 'nc_devolucion', refTipo: 'pagos_proveedores', refId: pagoId,
            motivo: motivoStock, fecha: ts, crearSiNoExiste: false,
          });
        }
      }

      // Aplicacion a facturas (opcional): igual que un pago.
      let restante = total;
      const imputar = (docId, esGasto, monto) => {
        monto = Math.min(monto, restante);
        if (monto <= 0.01) return;
        db().run(
          `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, gasto_id, monto_imputado, fecha) VALUES (?, ?, ?, ?, ?, ?)`,
          [uid(), pagoId, esGasto ? null : docId, esGasto ? docId : null, monto, fechaNC]
        );
        restante -= monto;
      };
      if (imputaciones !== undefined) {
        for (const imp of imputaciones) {
          const docId = imp.compra_id || imp.gasto_id;
          if (docId) imputar(docId, !imp.compra_id && !!imp.gasto_id, parseFloat(imp.monto) || 0);
        }
      } else if (imputar_a_compra_id) {
        const c = getComprasPendientes(proveedor_id).find(x => x.id === imputar_a_compra_id);
        if (c) imputar(c.id, c.tipo === 'gasto', c.saldo);
      } else if (auto_imputar) {
        for (const c of getComprasPendientes(proveedor_id)) {
          if (restante <= 0.01) break;
          imputar(c.id, c.tipo === 'gasto', c.saldo);
        }
      }

      // db().run() no propaga errores: se comprueba que quedo todo antes de dar la NC por buena
      const okPago = db().query(`SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id = ?`, [pagoId])[0]?.n || 0;
      const okMet = db().query(`SELECT COUNT(*) AS n FROM pagos_proveedores_metodos WHERE pago_id = ?`, [pagoId])[0]?.n || 0;
      const okIt = db().query(`SELECT COUNT(*) AS n FROM pagos_proveedores_items WHERE pago_id = ?`, [pagoId])[0]?.n || 0;
      if (!okPago || !okMet || okIt !== lineas.length) {
        db().rollbackBatch();
        return { success: false, error: 'No se pudo guardar la nota de crédito (revisá la consola)' };
      }
      db().commitBatch();
      return { success: true, id: pagoId, total, credito_sobrante: Math.max(0, restante) };
    } catch (e) {
      db().rollbackBatch();
      console.error('SGA_PagosProveedores.crearNotaCredito:', e);
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
      `SELECT ip.fecha, ip.monto_imputado, ip.pago_id, p.observaciones, p.tipo
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
      const MLBL = { efectivo: 'Efectivo', transferencia: 'Transferencia', caja_seamus: 'Caja Seamus', mercadopago: 'MercadoPago', nota_credito: 'Nota de crédito' };
      const desc = metodos.map(m =>
        (MLBL[m.metodo] || m.metodo) + (m.referencia ? ` (${m.referencia})` : '')
      ).join(' + ') || i.observaciones || 'Pago';
      return { fecha: i.fecha, monto: parseFloat(i.monto_imputado) || 0, desc, pago_id: i.pago_id,
               es_nc: i.tipo === 'nota_credito' };
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
      `SELECT p.id, p.fecha, p.observaciones, p.tipo, p.numero_comprobante, p.condicion_nc, p.nc_provisoria,
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
      const MLBL = { efectivo: 'Efectivo', transferencia: 'Transferencia', caja_seamus: 'Caja Seamus', mercadopago: 'MercadoPago', nota_credito: 'Nota de crédito' };
      const desc = metodos.map(m =>
        (MLBL[m.metodo] || m.metodo)
        + (m.referencia ? ` (${m.referencia})` : '')
      ).join(' + ') || p.observaciones || 'Pago';
      return {
        id:                p.id,
        fecha:             p.fecha,
        desc:              p.tipo === 'nota_credito' ? _refNC(p) : desc,
        es_nc:             p.tipo === 'nota_credito',
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

  // ── Anular un pago ─────────────────────────────────────────────────────────
  //
  // Un pago cargado por error (proveedor equivocado, monto mal) no tenia como
  // revertirse. Anular = BORRAR el pago con sus medios e imputaciones y dejar
  // la marca de borrado para que viaje al otro dispositivo (mismo patron que
  // clientes.js eliminarPago). No se marca "anulado" en vez de borrar porque el
  // saldo y el credito disponible se calculan en varios lugares; con el pago
  // borrado todos se corrigen solos y las facturas que saldaba vuelven a quedar
  // pendientes (sus imputaciones desaparecen con el).
  //
  // Caja (solo un pago en EFECTIVO tiene egreso en la caja):
  //  - caja abierta  -> se borra tambien el egreso: la caja esperada se corrige sola.
  //  - caja cerrada  -> el arqueo ya se hizo con esa plata adentro; reescribirlo
  //    le inventaria una diferencia a un cierre que estaba bien. Se pide
  //    confirmacion explicita y, si se acepta, se anula solo en la cuenta
  //    corriente del proveedor: el egreso queda en esa caja.
  //  - transferencia / MercadoPago / Caja Seamus: no tocan la caja.

  // El egreso no guarda el id del pago (hueco del diseno original), asi que se
  // lo busca por sesion + proveedor + tipo + monto + fecha: crearPago() sella el
  // pago y su egreso con los mismos valores.
  function _buscarEgresoDePago(pago, metodo) {
    if (!metodo.sesion_caja_id) return null;
    const monto = parseFloat(metodo.monto) || 0;
    const estricto = db().query(
      `SELECT id FROM egresos_caja
       WHERE sesion_caja_id = ? AND tipo = 'pago_proveedor' AND proveedor_id = ?
         AND monto = ? AND fecha = ? LIMIT 1`,
      [metodo.sesion_caja_id, pago.proveedor_id, monto, pago.fecha]
    )[0];
    if (estricto) return estricto;
    // Egresos viejos, de antes de que existieran las columnas tipo/proveedor_id.
    return db().query(
      `SELECT id FROM egresos_caja
       WHERE sesion_caja_id = ? AND monto = ? AND fecha = ? AND descripcion LIKE 'Pago%' LIMIT 1`,
      [metodo.sesion_caja_id, monto, pago.fecha]
    )[0] || null;
  }

  function getResumenAnulacionPago(pagoId) {
    const pago = db().query(
      `SELECT p.*, pr.razon_social AS proveedor_nombre
       FROM pagos_proveedores p LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
       WHERE p.id = ?`, [pagoId]
    )[0];
    if (!pago) return { success: false, error: 'Pago no encontrado' };

    const metodos = db().query(
      `SELECT id, metodo, monto, referencia, sesion_caja_id FROM pagos_proveedores_metodos WHERE pago_id = ?`,
      [pagoId]
    );
    const total = metodos.reduce((s, m) => s + (parseFloat(m.monto) || 0), 0);

    // Nota de credito: el stock que bajo la devolucion vuelve al anularla
    const esNC = pago.tipo === 'nota_credito';
    const stockAReponer = !esNC ? [] : db().query(
      `SELECT i.producto_id, SUM(i.cantidad) AS cant, pr.nombre AS producto_nombre
       FROM pagos_proveedores_items i LEFT JOIN productos pr ON pr.id = i.producto_id
       WHERE i.pago_id = ? AND i.tipo = 'producto' AND i.mueve_stock = 1 AND i.producto_id IS NOT NULL
       GROUP BY i.producto_id`, [pagoId]
    ).map(r => ({ productoId: r.producto_id, nombre: r.producto_nombre || '(producto eliminado)',
                  cantidad: parseFloat(r.cant) || 0 })).filter(s => s.cantidad > 1e-9);

    const imputaciones = db().query(
      `SELECT ip.id, ip.compra_id, ip.gasto_id, ip.monto_imputado, ip.fecha,
              c.factura_pv, c.numero_factura, g.comprobante, g.descripcion
       FROM imputaciones_pagos ip
       LEFT JOIN compras c ON c.id = ip.compra_id
       LEFT JOIN gastos  g ON g.id = ip.gasto_id
       WHERE ip.pago_id = ? ORDER BY ip.fecha ASC`, [pagoId]
    ).map(i => ({
      id: i.id,
      tipo: i.gasto_id && !i.compra_id ? 'gasto' : 'compra',
      monto: parseFloat(i.monto_imputado) || 0,
      referencia: i.gasto_id && !i.compra_id
        ? (i.comprobante || i.descripcion || 'Gasto')
        : ([i.factura_pv, i.numero_factura].filter(Boolean).join('-') || '(compra sin número)'),
    }));

    // estado de la caja de la que salio el efectivo: 'abierta' | 'cerrada' | null
    // (null = esa sesion no esta en esta base; se trata como cerrada, no se toca).
    const efectivo = metodos.filter(m => m.metodo === 'efectivo').map(m => {
      const ses = m.sesion_caja_id
        ? db().query(`SELECT id, estado, fecha_apertura FROM sesiones_caja WHERE id = ?`, [m.sesion_caja_id])[0]
        : null;
      const egreso = _buscarEgresoDePago(pago, m);
      return {
        monto: parseFloat(m.monto) || 0,
        sesion_caja_id: m.sesion_caja_id || null,
        sesion_estado: ses ? ses.estado : null,
        sesion_fecha: ses ? ses.fecha_apertura : null,
        egreso_id: egreso ? egreso.id : null,
      };
    });

    return {
      success: true,
      pago: { id: pago.id, proveedor_id: pago.proveedor_id, proveedor_nombre: pago.proveedor_nombre,
              fecha: pago.fecha, observaciones: pago.observaciones,
              sucursal_id: pago.sucursal_id, numero_comprobante: pago.numero_comprobante },
      esNC, stockAReponer,
      metodos, total, imputaciones, efectivo,
      hayCajaCerrada: efectivo.some(e => e.sesion_estado !== 'abierta'),
    };
  }

  function anularPago(pagoId, opts = {}) {
    // Toca plata y a veces la caja: solo desde Admin-POS (la UI ya oculta el
    // boton en el POS del local; esto cierra la puerta por si alguien lo llama).
    if (!window.ADMIN_MODE) return { success: false, error: 'Anular un pago solo se puede desde Admin-POS' };
    const r = getResumenAnulacionPago(pagoId);
    if (!r.success) return r;

    if (r.hayCajaCerrada && !opts.aceptarCajaCerrada) {
      return { success: false, requiereConfirmacionCaja: true,
               error: 'El pago salió de una caja ya cerrada: hace falta confirmar que no se toca la caja' };
    }

    let egresosRevertidos = 0;
    try {
      db().beginBatch();

      // 1. Egreso del efectivo, solo si esa caja sigue abierta.
      for (const e of r.efectivo) {
        if (e.sesion_estado === 'abierta' && e.egreso_id) {
          db().run(`DELETE FROM egresos_caja WHERE id = ?`, [e.egreso_id]);
          db().registrarEliminacion('egresos_caja', e.egreso_id);
          egresosRevertidos++;
        }
      }

      // 1b. Nota de credito: lo que la devolucion saco de stock vuelve (movimiento nuevo de signo contrario).
      if (r.esNC) {
        const suc = r.pago.sucursal_id || window.SGA_Auth?.getCurrentUser?.()?.sucursal_id;
        for (const s of r.stockAReponer) {
          if (!suc) break;
          db().moverStock({
            productoId: s.productoId, sucursalId: suc, delta: s.cantidad,
            tipo: 'nc_anulacion', refTipo: 'pagos_proveedores', refId: pagoId,
            motivo: `Anulación de NC${r.pago.numero_comprobante ? ' ' + r.pago.numero_comprobante : ''}`,
            fecha: now(), crearSiNoExiste: false,
          });
        }
        db().run(`DELETE FROM pagos_proveedores_items WHERE pago_id = ?`, [pagoId]);
      }

      // 2. El pago con sus medios e imputaciones (las facturas vuelven a quedar pendientes).
      db().run(`DELETE FROM imputaciones_pagos WHERE pago_id = ?`, [pagoId]);
      db().run(`DELETE FROM pagos_proveedores_metodos WHERE pago_id = ?`, [pagoId]);
      db().run(`DELETE FROM pagos_proveedores WHERE id = ?`, [pagoId]);
      db().registrarEliminacion('pagos_proveedores', pagoId);

      // db().run() no propaga errores: se comprueba que de verdad se borro antes de dar por buena la anulacion.
      const quedan = db().query(`SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id = ?`, [pagoId])[0]?.n || 0;
      const quedanImp = db().query(`SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE pago_id = ?`, [pagoId])[0]?.n || 0;
      if (quedan || quedanImp) {
        db().rollbackBatch();
        return { success: false, error: 'No se pudo borrar el pago (revisá la consola)' };
      }
      db().commitBatch();
    } catch (e) {
      db().rollbackBatch();
      console.error('SGA_PagosProveedores.anularPago:', e);
      return { success: false, error: e.message };
    }

    return {
      success: true,
      total: r.total,
      esNC: r.esNC,
      facturasLiberadas: r.imputaciones.length,
      egresosRevertidos,
      unidadesRepuestas: r.stockAReponer.reduce((s, x) => s + x.cantidad, 0),
      cajaSinTocar: r.hayCajaCerrada,
    };
  }

  return {
    getSaldoProveedor,
    getComprasPendientes,
    getCreditosDisponibles,
    getLedger,
    getLedgerAgrupado,
    crearPago,
    crearNotaCredito,
    imputar,
    getResumenProveedores,
    getSesionActiva,
    getResumenAnulacionPago,
    anularPago,
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
            <tr data-abrir-fila="${esc(p.id)}" data-nombre-fila="${esc(p.razon_social)}">
              <td><strong>${esc(p.razon_social)}</strong></td>
              <td>${esc(p.contacto_nombre || '—')}</td>
              <td>${esc(p.condicion_pago || '—')}</td>
              <td class="right">${saldoBadge(p.saldo)}</td>
              <td>
                <div class="ccprov-actions">
                  <button class="ccprov-btn-icon btn-ver-detalle" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Ver cuenta corriente">📋</button>
                  <button class="ccprov-btn-icon btn-pagar" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Registrar pago">💳</button>
                  ${NotaCreditoWizard.puede() ? `<button class="ccprov-btn-icon btn-nc" data-id="${esc(p.id)}" data-nombre="${esc(p.razon_social)}" title="Registrar nota de crédito" aria-label="Registrar nota de crédito">🧾</button>` : ''}
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
    // Tocar la card entera abre el extracto — en mobile "Ver detalle" queda
    // oculto (redundante, ver CSS), así que hace falta este camino.
    wrap.querySelectorAll('tr[data-abrir-fila]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        renderDetalle(row.dataset.abrirFila, row.dataset.nombreFila);
      });
    });
    wrap.querySelectorAll('.btn-pagar').forEach(btn => {
      btn.addEventListener('click', () => openModalPago(btn.dataset.id, btn.dataset.nombre));
    });
    wrap.querySelectorAll('.btn-nc').forEach(btn => {
      btn.addEventListener('click', () => openModalNC(btn.dataset.id));
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
          ${NotaCreditoWizard.puede() ? `<button class="ccprov-btn-secondary" id="btn-nueva-nc-general">+ Registrar NC</button>` : ''}
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
    ge('btn-nueva-nc-general')?.addEventListener('click', () => openModalNC(null));

    // Auto-focus search
    ge('ccprov-search').focus();
  }

  // ── VISTA DETALLE ────────────────────────────────────────────────────────────

  // Anular un pago toca plata (y a veces la caja): solo el admin, y solo desde
  // Admin-POS. En el POS del local la cajera no ve el boton.
  function puedeAnularPagos() {
    return !!window.ADMIN_MODE && window.SGA_Auth?.getCurrentUser?.()?.rol === 'admin';
  }
  const btnAnular = (pagoId) => puedeAnularPagos()
    ? `<button class="ledger-btn-anular" data-anular-pago="${esc(pagoId)}" title="Anular este pago">Anular</button>`
    : '';

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
              <td><span class="ledger-type-badge ledger-type-${e.tipo}">${e.tipo === 'compra' ? 'Compra' : e.tipo === 'nc' ? 'NC' : 'Pago'}</span></td>
              <td>
                ${esc(e.referencia)}
                ${e.tipo === 'compra' && e.saldo_item > 0.01 ? `<span class="ledger-saldo-parcial"> · Saldo: ${fmt$(e.saldo_item)}</span>` : ''}
                ${e.tipo === 'pago' || e.tipo === 'nc' ? btnAnular(e.id) : ''}
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
                  <td><span class="ledger-type-badge ${i.es_nc ? 'ledger-type-nc' : 'ledger-type-pago'}">${i.es_nc ? 'NC' : 'Pago'}</span></td>
                  <td><span class="ledger-imp-ref">${esc(i.desc)}</span> ${btnAnular(i.pago_id)}</td>
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
          <div class="ledger-orphan-title">💡 Pagos y notas de crédito sin imputar a comprobantes</div>
          <table class="ccprov-table" style="margin-top:0">
            <tbody>
              ${pagos_sin_imputar.map(p => `
                <tr class="ledger-row-orphan">
                  <td style="width:90px">${fmtFecha(p.fecha)}</td>
                  <td><span class="ledger-type-badge ${p.es_nc ? 'ledger-type-nc' : 'ledger-type-pago'}">${p.es_nc ? 'NC' : 'Pago'}</span></td>
                  <td>${esc(p.desc)}</td>
                  <td class="right">—</td>
                  <td class="right"><span class="ledger-haber">${fmt$(p.credito_disponible)}</span></td>
                  <td class="right">
                    <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
                      <button class="ledger-btn-imputar" data-imputar-pago="${esc(p.id)}"
                              data-credito="${p.credito_disponible}">Imputar…</button>
                      ${btnAnular(p.id)}
                    </div>
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

  // Anular un pago cargado por error. Muestra que se va a deshacer ANTES de
  // hacerlo: las facturas que ese pago saldaba y, si fue en efectivo, que pasa
  // con la caja (abierta: se revierte el egreso; cerrada: no se toca).
  async function openModalAnularPago(pagoId, proveedorId, proveedorNombre) {
    PagoWizard.ensureCss();
    const overlay = ge('ccprov-overlay');
    if (!overlay) return;

    let r = data().getResumenAnulacionPago(pagoId);
    if (!r.success) { alert(r.error); return; }

    // Un pago en efectivo depende del estado REAL de su caja. Si esta compu es
    // Admin-POS, se trae lo ultimo del POS antes de decidir: la caja pudo
    // cerrarse hace un rato y la copia local todavia decir 'abierta'.
    if (r.efectivo.length && window.ADMIN_MODE && window.SGA_Sync?.isInitialized?.()) {
      try {
        await Promise.race([
          window.SGA_Sync.syncMonitoringData(),
          new Promise(res => setTimeout(res, 8000)),
        ]);
        r = data().getResumenAnulacionPago(pagoId);
        if (!r.success) { alert(r.error); return; }
      } catch (e) { console.warn('anular pago: no se pudo refrescar el estado de la caja:', e.message); }
    }

    const LBL = { efectivo: 'Efectivo', transferencia: 'Transferencia', caja_seamus: 'Caja Seamus', mercadopago: 'MercadoPago', nota_credito: 'Nota de crédito' };
    const medios = r.metodos.map(m =>
      `${LBL[m.metodo] || esc(m.metodo)}: ${fmt$(m.monto)}${m.referencia ? ` (${esc(m.referencia)})` : ''}`
    ).join(' · ');

    const impHtml = r.imputaciones.length
      ? `<p style="margin:12px 0 4px">Esto está aplicado a:</p>
         <ul style="margin:0 0 8px 18px;padding:0">
           ${r.imputaciones.map(i => `<li>${i.tipo === 'gasto' ? 'Gasto' : 'Factura'} <strong>${esc(i.referencia)}</strong> — ${fmt$(i.monto)}</li>`).join('')}
         </ul>
         <p style="margin:0">Al anularlo, esos comprobantes <strong>vuelven a quedar pendientes</strong>.</p>`
      : `<p style="margin:12px 0 0">Esto no está aplicado a ningún comprobante: se pierden ${fmt$(r.total)} de crédito a favor.</p>`;

    // Una NC de devolucion bajo stock al cargarse: anularla lo repone.
    const stockHtml = r.stockAReponer.length
      ? `<p style="margin:12px 0 0">Se repone el stock que bajó esta devolución: ${r.stockAReponer.map(s => `${esc(s.nombre)} (+${s.cantidad})`).join(', ')}.</p>`
      : '';

    let cajaHtml;
    if (!r.efectivo.length) {
      cajaHtml = `<div class="ccprov-anular-caja">No afecta la caja.</div>`;
    } else if (!r.hayCajaCerrada) {
      const sinEgreso = r.efectivo.some(e => !e.egreso_id);
      cajaHtml = `<div class="ccprov-anular-caja">Se revierte el egreso en efectivo de la caja abierta: la caja esperada se corrige sola.
        ${sinEgreso ? '<br><strong>No se encontró el egreso de la caja</strong> para este pago; revisalo a mano.' : ''}</div>`;
    } else {
      const fechas = r.efectivo.filter(e => e.sesion_estado !== 'abierta')
        .map(e => e.sesion_fecha ? fmtFecha(e.sesion_fecha) : 'una caja que no está en esta base').join(', ');
      cajaHtml = `<div class="ccprov-anular-caja warn">
        <strong>⚠ Este pago salió en efectivo de una caja que ya se cerró (${esc(fechas)}).</strong><br>
        Si continuás, el pago se anula <strong>solo en la cuenta corriente del proveedor</strong>: la caja no se modifica,
        porque el arqueo ya se hizo con esa plata adentro.<br>
        Si volvés a cargar este pago en efectivo, se generará otro egreso en la caja actual.
      </div>`;
    }

    overlay.innerHTML = `
      <div class="ccprov-modal" style="max-width:560px">
        <div class="ccprov-modal-hdr">
          <span>\u{1F5D1} Anular ${r.esNC ? 'nota de crédito' : 'pago'} \u2014 ${esc(proveedorNombre)}</span>
          <button class="ccprov-modal-close" id="btn-anular-close" aria-label="Cerrar" title="Cerrar">\u2715</button>
        </div>
        <div class="ccprov-modal-body" style="font-size:13px">
          <p style="margin:0">${r.esNC ? 'Nota de crédito' : 'Pago'} del <strong>${fmtFecha(r.pago.fecha)}</strong> por <strong>${fmt$(r.total)}</strong><br>
            <span style="color:var(--color-text-secondary)">${medios}</span></p>
          ${impHtml}
          ${stockHtml}
          ${cajaHtml}
          <div id="anular-error" style="display:none;color:#c62828;font-size:13px;margin-top:8px"></div>
        </div>
        <div class="ccprov-modal-ftr">
          <button class="btn btn-outline" id="btn-anular-cancel">Cancelar</button>
          <button class="btn btn-danger" id="btn-anular-ok">${r.hayCajaCerrada ? 'Anular igualmente (sin tocar la caja)' : (r.esNC ? 'Anular nota de crédito' : 'Anular pago')}</button>
        </div>
      </div>`;
    overlay.classList.remove('hidden');

    const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };
    ge('btn-anular-close').addEventListener('click', close);
    ge('btn-anular-cancel').addEventListener('click', close);
    ge('btn-anular-ok').addEventListener('click', () => {
      const res = data().anularPago(pagoId, { aceptarCajaCerrada: r.hayCajaCerrada });
      if (!res.success) {
        const err = ge('anular-error');
        if (err) { err.textContent = res.error || 'No se pudo anular el pago.'; err.style.display = 'block'; }
        return;
      }
      close();
      window.SGA_Sync?.pushPending?.();
      renderDetalle(proveedorId, proveedorNombre);
      const msg = (res.esNC ? 'Nota de crédito anulada' : 'Pago anulado') + (res.egresosRevertidos ? ' — egreso de caja revertido' : '');
      if (window.SGA_Utils?.showToast) window.SGA_Utils.showToast(msg, 'success');
      else window.SGA_Utils?.showNotification?.(msg, 'success');
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

    wrap.querySelectorAll('[data-anular-pago]').forEach(btn => {
      btn.addEventListener('click', () => openModalAnularPago(
        btn.dataset.anularPago, proveedorId, state.proveedorNombre
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
          ${NotaCreditoWizard.puede() ? `<button class="ccprov-btn-secondary" id="btn-registrar-nc">+ Registrar NC</button>` : ''}
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
          <span style="font-size:12px;color:var(--color-text-secondary);margin-top:2px">pagos registrados${ledger.some(e => e.tipo === 'nc') ? ` · ${ledger.filter(e => e.tipo === 'nc').length} NC` : ''}</span>
        </div>
      </div>

      ${totalCredito > 0.01 ? `
      <div class="ccprov-credito-alert">
        💡 Hay <strong>${fmt$(totalCredito)}</strong> en pagos y notas de crédito sin imputar (crédito disponible para aplicar a compras)
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
    ge('btn-registrar-nc')?.addEventListener('click', () => openModalNC(proveedorId));
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

  // Nota de credito: mismo lugar donde vive el wizard de pago, y se refresca igual.
  function openModalNC(proveedorId) {
    NotaCreditoWizard.abrir({
      proveedorId,
      onSaved: () => {
        if (state.view === 'detalle') renderDetalle(state.proveedorId, state.proveedorNombre);
        else renderLista();
      },
    });
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────

  const init = (params) => {
    const root = ge('ccprov-root');
    if (!root) return;

    // Reset state on each load
    state.view = 'lista';
    state.search = '';
    state.soloDeuda = true;
    state.proveedorId = null;
    state.proveedorNombre = '';

    renderLista();

    // Acceso rápido desde #cuenta_corriente_proveedores/nuevo-pago (botón
    // "Pago a proveedor" de Inicio): abre el modal de pago general de una,
    // sin obligar a buscar el botón en la lista.
    if (params && params[0] === 'nuevo-pago') openModalPago(null, null);
  };

  return { init };
})();

export default CuentaCorrienteProveedores;
