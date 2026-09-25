'use strict';

// Import estatico (no window.SGA_Familia): el modulo que necesita el wizard
// se lo trae solo -- evita el bug real de import() dinamico resolviendo a una
// instancia vieja cacheada si otra ruta ya cargo familia.js antes (ver
// CLAUDE.md, "otra excepcion real" del router).
import Familia from './familia.js';
// Import estatico por la misma razon que Familia (ver arriba). El wizard trae su
// propia capa de datos (cuenta_corriente_proveedores.js) cuando la necesita.
import NotaCreditoWizard from './nota_credito_wizard.js';

const OperacionesStock = (() => {

  const ge  = id => document.getElementById(id);
  const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);
  const db   = () => window.SGA_DB;

  // Ajuste de precios pendiente (compras_v2.js post-compra) — un solo pendiente
  // a la vez por sucursal (ids random, no determinísticos — ver comentario en
  // compras_v2.js sobre por qué un id fijo reusable choca con el borrado-con-marca).
  function hayAjustePendiente() {
    const suc = window.SGA_Auth?.getCurrentUser?.()?.sucursal_id;
    if (!suc) return false;
    return !!db().query(
      `SELECT 1 FROM ajustes_precio_pendientes WHERE sucursal_id = ? LIMIT 1`, [suc]
    )[0];
  }
  function descartarAjustePendiente() {
    const suc = window.SGA_Auth?.getCurrentUser?.()?.sucursal_id;
    if (!suc) return;
    for (const row of db().query(`SELECT id FROM ajustes_precio_pendientes WHERE sucursal_id = ?`, [suc])) {
      db().run(`DELETE FROM ajustes_precio_pendientes WHERE id = ?`, [row.id]);
      window.SGA_DB.registrarEliminacion('ajustes_precio_pendientes', row.id);
    }
    window.SGA_Sync?.pushPending?.();
  }

  // Estado de pago REAL de una compra: compras.condicion_pago es un campo fijo
  // que se carga una sola vez al confirmar la compra (siempre 'pendiente' hoy
  // — compras_v2.js no tiene toggle para marcarla pagada en el momento, ver
  // tests/e2e/README.md) y nunca se actualiza después, así que no sirve para
  // saber si la deuda ya se saldó. Lo real está en imputaciones_pagos — el
  // mismo cálculo que ya usa Cuentas Corrientes (_getPagadoDeCompra en
  // cuenta_corriente_proveedores.js) para decidir qué compras siguen abiertas.
  function estadoPagoCompra(total, pagado) {
    total  = parseFloat(total)  || 0;
    pagado = parseFloat(pagado) || 0;
    const saldo = total - pagado;
    if (saldo <= 0.01) return { texto: '✓ Pagada', color: '#27ae60' };
    if (pagado > 0.01) return { texto: `◐ Parcial — debe ${fmt$(saldo)}`, color: '#e67e22' };
    return { texto: '⏳ Pendiente', color: '#2980b9' };
  }

  const ESTADO_LABEL = {
    borrador: 'Borrador', confirmada: 'Confirmada',
    pendiente_pago: 'Pend. pago', anulada: 'Anulada',
  };
  const ESTADO_COLOR = {
    borrador: '#e67e22', confirmada: '#27ae60',
    pendiente_pago: '#2980b9', anulada: '#c0392b',
  };

  // ── HISTORIAL DE COMPRAS ───────────────────────────────────────────────────

  function getHistorialCompras({ fechaDesde, fechaHasta, proveedorId } = {}) {
    const user = window.SGA_Auth.getCurrentUser();
    const where = ['c.sucursal_id = ?'];
    const params = [user.sucursal_id];
    if (fechaDesde) { where.push('c.fecha >= ?'); params.push(fechaDesde); }
    if (fechaHasta) { where.push('c.fecha <= ?'); params.push(fechaHasta + 'T23:59:59'); }
    if (proveedorId) { where.push('c.proveedor_id = ?'); params.push(proveedorId); }
    return db().query(`
      SELECT c.id, c.fecha, c.numero_factura, c.factura_pv, c.total, c.condicion_pago, c.estado,
             c.sesion_caja_id,
             p.razon_social AS proveedor_nombre,
             (SELECT COUNT(*) FROM compra_items ci WHERE ci.compra_id = c.id) AS num_items,
             (SELECT COUNT(*) FROM remitos r WHERE r.compra_id = c.id) AS de_remito,
             (SELECT COALESCE(SUM(monto_imputado), 0) FROM imputaciones_pagos
              WHERE compra_id = c.id) AS pagado
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.fecha DESC
    `, params);
  }

  // Sesión de caja abierta ahora mismo para esta sucursal, y SOLO si se abrió
  // hoy — se usa para decidir, en el POS, qué compras del historial son "de la
  // caja actual" y por lo tanto editables. El chequeo de fecha existe porque
  // una caja que quedó sin cerrar de días anteriores sigue 'abierta': sin él,
  // la cajera podría editar compras de la semana pasada. Se mira la fecha de
  // apertura de la sesión (turno real) y no compras.fecha, que es la fecha de
  // la FACTURA y se carga a mano — una factura de la semana pasada que entra
  // hoy tiene que poder corregirse en el momento.
  function getSesionActivaIdDeHoy() {
    const user = window.SGA_Auth.getCurrentUser();
    const r = db().query(
      `SELECT id, fecha_apertura FROM sesiones_caja
       WHERE sucursal_id=? AND estado='abierta' LIMIT 1`,
      [user.sucursal_id]
    );
    const ses = r[0];
    if (!ses) return null;
    const hoy = new Date().toISOString().slice(0, 10);
    return (ses.fecha_apertura || '').slice(0, 10) === hoy ? ses.id : null;
  }

  function getDetalleCompra(compraId) {
    const compra = db().query(`
      SELECT c.*, p.razon_social AS proveedor_nombre, u.nombre AS usuario_nombre,
             (SELECT COALESCE(SUM(monto_imputado), 0) FROM imputaciones_pagos
              WHERE compra_id = c.id) AS pagado
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      LEFT JOIN usuarios u ON u.id = c.usuario_id
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

  // ── ANULAR UNA COMPRA (cargada por error) ──────────────────────────────────
  //
  // Para facturas mal cargadas (monto o proveedor equivocado, duplicada...). NO
  // es una nota de credito: no hay documento del proveedor de por medio. La
  // compra queda como historial (estado 'anulada', con motivo/quien/cuando) y
  // se deshace todo lo que hizo:
  //  - deuda: las consultas de saldo ya excluyen las compras anuladas;
  //  - stock: se revierte lo que ESTA compra sumo, segun el registro de
  //    movimientos (refTipo 'compras') — sirve igual para una compra editada o
  //    para una vinculada a un remito (lo que vino del remito no lo sumo la
  //    factura). Las compras de antes del registro se revierten por sus items;
  //  - pagos aplicados: se borran SOLO las imputaciones (con marca de borrado);
  //    el pago sigue y su credito vuelve a estar disponible;
  //  - ajustes de stock pendientes de aprobacion: se rechazan;
  //  - remito vinculado: vuelve a quedar pendiente de factura;
  //  - costo: solo se revierte si esta era la ultima compra de ese producto Y
  //    el costo actual es justo el que esta compra puso (nunca el precio de venta).

  function puedeAnularCompras() {
    return !!window.ADMIN_MODE && window.SGA_Auth?.getCurrentUser?.()?.rol === 'admin';
  }

  function getResumenAnulacionCompra(compraId) {
    const compra = db().query(
      `SELECT c.*, p.razon_social AS proveedor_nombre
       FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id
       WHERE c.id = ?`, [compraId]
    )[0];
    if (!compra) return { success: false, error: 'Compra no encontrada' };
    if ((compra.estado || 'confirmada') === 'anulada') return { success: false, error: 'La compra ya está anulada' };

    const remito = db().query(
      `SELECT id, numero_remito FROM remitos WHERE compra_id = ? LIMIT 1`, [compraId]
    )[0] || null;

    // Stock: lo que esta compra sumo de verdad (neto de ediciones)
    const movs = db().query(
      `SELECT m.producto_id, m.sucursal_id, SUM(m.delta) AS neto, pr.nombre AS producto_nombre
       FROM stock_movimientos m LEFT JOIN productos pr ON pr.id = m.producto_id
       WHERE m.ref_tipo = 'compras' AND m.ref_id = ?
       GROUP BY m.producto_id, m.sucursal_id`, [compraId]
    );
    let stock = movs
      .filter(m => Math.abs(parseFloat(m.neto) || 0) > 1e-9)
      .map(m => ({ productoId: m.producto_id, sucursalId: m.sucursal_id,
                   nombre: m.producto_nombre || '(producto eliminado)', cantidad: parseFloat(m.neto) }));
    if (!movs.length && !remito) {
      // Compra de antes del registro de movimientos: se revierte por sus items.
      stock = db().query(
        `SELECT ci.producto_id, SUM(ci.cantidad * COALESCE(ci.unidades_por_paquete, 1)) AS cant, pr.nombre AS producto_nombre
         FROM compra_items ci LEFT JOIN productos pr ON pr.id = ci.producto_id
         WHERE ci.compra_id = ? AND ci.producto_id IS NOT NULL AND COALESCE(ci.tipo, 'producto') IN ('producto', 'muestra')
         GROUP BY ci.producto_id`, [compraId]
      ).map(r => ({ productoId: r.producto_id, sucursalId: compra.sucursal_id,
                    nombre: r.producto_nombre || '(producto eliminado)', cantidad: parseFloat(r.cant) || 0 }))
       .filter(s => s.cantidad > 1e-9);
    }

    // Pagos aplicados a esta factura
    const imputaciones = db().query(
      `SELECT ip.id, ip.pago_id, ip.monto_imputado, p.fecha AS pago_fecha
       FROM imputaciones_pagos ip LEFT JOIN pagos_proveedores p ON p.id = ip.pago_id
       WHERE ip.compra_id = ? ORDER BY ip.fecha ASC`, [compraId]
    ).map(i => ({ id: i.id, pagoId: i.pago_id, monto: parseFloat(i.monto_imputado) || 0, pagoFecha: i.pago_fecha }));

    // Ajustes de stock pedidos desde Revision para esta compra
    const ajustes = db().query(
      `SELECT sa.id, sa.cantidad, sa.motivo, sa.estado, pr.nombre AS producto_nombre
       FROM stock_ajustes sa LEFT JOIN productos pr ON pr.id = sa.producto_id
       WHERE sa.compra_id = ?`, [compraId]
    );
    const ajustesPendientes = ajustes.filter(a => a.estado === 'pendiente_aprobacion');
    const ajustesAprobados  = ajustes.filter(a => a.estado === 'aprobado');

    // Costos que esta compra puso y que se pueden devolver sin pisar nada mas
    const costos = [];
    const vistos = new Set();
    for (const it of db().query(
      `SELECT ci.producto_id, ci.costo_unitario, ci.descuento_pct, ci.costo_anterior,
              COALESCE(ci.unidades_por_paquete, 1) AS uds, pr.nombre, pr.costo AS costo_actual
       FROM compra_items ci JOIN productos pr ON pr.id = ci.producto_id
       WHERE ci.compra_id = ? AND COALESCE(ci.tipo, 'producto') = 'producto' AND ci.costo_modificado = 1`, [compraId]
    )) {
      if (vistos.has(it.producto_id)) continue;
      vistos.add(it.producto_id);
      const desc = Math.min(100, Math.max(0, parseFloat(it.descuento_pct) || 0));
      const costoNeto = (parseFloat(it.costo_unitario) || 0) * (1 - desc / 100);
      const anterior = parseFloat(it.costo_anterior) || 0;
      if (anterior <= 0 || Math.abs((parseFloat(it.costo_actual) || 0) - costoNeto) >= 0.01) continue;
      const posterior = db().query(
        `SELECT 1 FROM compra_items ci2 JOIN compras c2 ON c2.id = ci2.compra_id
         WHERE ci2.producto_id = ? AND c2.id != ? AND c2.fecha > ?
           AND COALESCE(c2.estado, 'confirmada') != 'anulada' LIMIT 1`,
        [it.producto_id, compraId, compra.fecha]
      );
      if (posterior.length) continue;
      costos.push({ productoId: it.producto_id, nombre: it.nombre, de: parseFloat(it.costo_actual) || 0,
                    a: anterior, udsPaq: parseFloat(it.uds) || 1 });
    }

    const bloqueos = [];
    const ncs = db().query(
      `SELECT id FROM pagos_proveedores WHERE tipo = 'nota_credito' AND compra_origen_id = ?`, [compraId]
    );
    if (ncs.length) {
      bloqueos.push(
        `Esta compra tiene ${ncs.length} nota(s) de crédito asociada(s). Anulá primero la nota de crédito ` +
        `(Cuentas Corrientes → Anular) y después la compra.`
      );
    }
    if (ajustesAprobados.length) {
      bloqueos.push(
        `Esta compra tiene ${ajustesAprobados.length} ajuste(s) de stock ya aprobado(s) ` +
        `(${ajustesAprobados.map(a => `${a.motivo || 'ajuste'}: ${a.cantidad} de ${a.producto_nombre || 'producto'}`).join('; ')}). ` +
        `Su stock ya se descontó: devolvelo primero con un "Ajuste de stock positivo" y después anulá la compra, ` +
        `o el descuento quedaría duplicado.`
      );
    }

    return { success: true, compra, remito, stock, imputaciones, ajustesPendientes, ajustesAprobados, costos, bloqueos };
  }

  function anularCompra(compraId, motivo) {
    if (!window.ADMIN_MODE) return { success: false, error: 'Anular una compra solo se puede desde Admin-POS' };
    motivo = String(motivo || '').trim();
    if (!motivo) return { success: false, error: 'El motivo es obligatorio' };

    const r = getResumenAnulacionCompra(compraId);
    if (!r.success) return r;
    if (r.bloqueos.length) return { success: false, error: r.bloqueos.join(' ') };

    const user = window.SGA_Auth.getCurrentUser();
    const ts = new Date().toISOString();

    try {
      db().beginBatch();

      // 1. La compra queda como historial
      db().run(
        `UPDATE compras SET estado = 'anulada', motivo_anulacion = ?, anulada_en = ?, anulada_por = ?,
           sync_status = 'pending', updated_at = ? WHERE id = ?`,
        [motivo, ts, user?.id || null, ts, compraId]
      );

      // 2. Stock: movimiento de signo contrario por lo que la compra sumo
      for (const s of r.stock) {
        db().moverStock({
          productoId: s.productoId, sucursalId: s.sucursalId, delta: -s.cantidad,
          tipo: 'anulacion_compra', refTipo: 'compras', refId: compraId,
          motivo: `Anulación de compra: ${motivo}`, fecha: ts, crearSiNoExiste: false,
        });
      }

      // 3. Pagos aplicados: se libera la imputacion (el pago sigue, su credito vuelve a estar disponible)
      for (const i of r.imputaciones) {
        db().run(`DELETE FROM imputaciones_pagos WHERE id = ?`, [i.id]);
        db().registrarEliminacion('imputaciones_pagos', i.id);
      }

      // 4. Ajustes de stock que esperaban aprobacion: ya no tienen sentido
      db().run(
        `UPDATE stock_ajustes SET estado = 'rechazado', aprobado_por = ?, fecha_aprobacion = ?,
           sync_status = 'pending', updated_at = ?
         WHERE compra_id = ? AND estado = 'pendiente_aprobacion'`,
        [user?.id || null, ts, ts, compraId]
      );

      // 5. Remito vinculado: vuelve a quedar pendiente de factura
      if (r.remito) {
        db().run(
          `UPDATE remitos SET estado = 'pendiente', compra_id = NULL, sync_status = 'pending', updated_at = ? WHERE id = ?`,
          [ts, r.remito.id]
        );
      }

      // 6. Costo: solo donde esta era la ultima compra y nada lo movio despues
      for (const c of r.costos) {
        db().run(
          `UPDATE productos SET costo = ?, costo_paquete = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
          [c.a, c.a * c.udsPaq, ts, c.productoId]
        );
      }

      // db().run() no propaga errores: se comprueba antes de dar la anulacion por buena
      const est = db().query(`SELECT estado FROM compras WHERE id = ?`, [compraId])[0]?.estado;
      const quedan = db().query(`SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE compra_id = ?`, [compraId])[0]?.n || 0;
      if (est !== 'anulada' || quedan) {
        db().rollbackBatch();
        return { success: false, error: 'No se pudo anular la compra (revisá la consola)' };
      }
      db().commitBatch();
    } catch (e) {
      db().rollbackBatch();
      console.error('anularCompra:', e);
      return { success: false, error: e.message };
    }

    window.SGA_Sync?.pushPending?.();
    return {
      success: true,
      unidadesRevertidas: r.stock.reduce((s, x) => s + x.cantidad, 0),
      pagosLiberados: r.imputaciones.length,
      ajustesRechazados: r.ajustesPendientes.length,
      remitoReabierto: !!r.remito,
      costosRevertidos: r.costos.length,
    };
  }

  function abrirAnularCompra(compraId) {
    const overlay = ge('ops-anular-overlay');
    const body = ge('ops-anular-body');
    if (!overlay || !body) return;
    const r = getResumenAnulacionCompra(compraId);
    if (!r.success) { window.SGA_Utils.showNotification(r.error, 'error'); return; }

    const c = r.compra;
    const factRef = c.factura_pv && c.numero_factura ? `${c.factura_pv}-${c.numero_factura}` : (c.numero_factura || '—');
    const fecha = c.fecha ? c.fecha.slice(0, 10) : '—';
    const li = t => `<li style="margin:3px 0">${t}</li>`;
    const efectos = [];

    efectos.push(li(`La deuda con <strong>${esc(c.proveedor_nombre || 'el proveedor')}</strong> baja en <strong>${fmt$(c.total || 0)}</strong>.`));
    if (r.stock.length) {
      efectos.push(li(`Se descuenta el stock que sumó esta compra: ` +
        r.stock.map(s => `${esc(s.nombre)} (−${s.cantidad})`).join(', ') + '.'));
    } else {
      efectos.push(li(`Esta compra no sumó stock propio${r.remito ? ' (el stock ya lo había sumado el remito)' : ''}: no se toca el stock.`));
    }
    if (r.imputaciones.length) {
      const tot = r.imputaciones.reduce((s, i) => s + i.monto, 0);
      efectos.push(li(`Se liberan <strong>${fmt$(tot)}</strong> de pagos aplicados a esta factura: vuelven a quedar como crédito a favor del proveedor.`));
    }
    if (r.ajustesPendientes.length) {
      efectos.push(li(`Se rechazan ${r.ajustesPendientes.length} ajuste(s) de stock que esperaban aprobación.`));
    }
    if (r.remito) {
      efectos.push(li(`El remito <strong>${esc(r.remito.numero_remito || '')}</strong> vuelve a quedar pendiente de factura.`));
    }
    for (const k of r.costos) {
      efectos.push(li(`El costo de <strong>${esc(k.nombre)}</strong> vuelve de ${fmt$(k.de)} a ${fmt$(k.a)} (esta era su última compra).`));
    }

    body.innerHTML = `
      <div style="font-size:13px;color:#2d3748">
        <div style="margin-bottom:10px"><strong>${esc(c.proveedor_nombre || '—')}</strong> · Fact. ${esc(factRef)} · ${esc(fecha)} · <strong>${fmt$(c.total || 0)}</strong></div>
        ${r.bloqueos.length ? `<div style="background:#ffebee;border:1px solid #ef9a9a;color:#b71c1c;border-radius:6px;padding:9px 12px;margin-bottom:10px">${esc(r.bloqueos.join(' '))}</div>` : ''}
        <div style="font-weight:700;margin-bottom:2px">Al anularla:</div>
        <ul style="margin:0 0 12px 18px;padding:0">${efectos.join('')}</ul>
        <label for="ops-anular-motivo" style="display:block;font-size:11px;font-weight:700;color:#607080;text-transform:uppercase;margin-bottom:3px">Motivo (obligatorio)</label>
        <textarea id="ops-anular-motivo" rows="2" placeholder="Ej.: cargada con el proveedor equivocado" style="width:100%;padding:7px 9px;border:1px solid #c8d0dc;border-radius:5px;font-size:13px;font-family:inherit"></textarea>
        <div id="ops-anular-error" style="display:none;color:#c62828;font-size:12px;margin-top:6px"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
          <button id="ops-anular-cancelar" style="padding:7px 16px;background:#eef0f3;color:#445566;border:none;border-radius:5px;cursor:pointer;font-size:13px">Cancelar</button>
          <button id="ops-anular-confirmar" ${r.bloqueos.length ? 'disabled' : ''} style="padding:7px 16px;background:#c62828;color:#fff;border:none;border-radius:5px;cursor:${r.bloqueos.length ? 'not-allowed' : 'pointer'};font-size:13px;font-weight:700;${r.bloqueos.length ? 'opacity:.5' : ''}">Anular compra</button>
        </div>
      </div>`;
    overlay.style.display = 'flex';
    setTimeout(() => ge('ops-anular-motivo')?.focus(), 50);

    const cerrar = () => { overlay.style.display = 'none'; body.innerHTML = ''; };
    ge('ops-anular-cancelar').addEventListener('click', cerrar);
    ge('ops-anular-confirmar').addEventListener('click', () => {
      const motivo = ge('ops-anular-motivo').value.trim();
      const err = ge('ops-anular-error');
      if (!motivo) { err.textContent = 'Escribí el motivo de la anulación.'; err.style.display = 'block'; return; }
      const res = anularCompra(compraId, motivo);
      if (!res.success) { err.textContent = res.error || 'No se pudo anular la compra.'; err.style.display = 'block'; return; }
      cerrar();
      window.SGA_Utils.showNotification('Compra anulada', 'success');
      renderHistorial(leerFiltrosHistorial());
    });
  }

  // Proveedores que tienen al menos una compra en esta sucursal — el filtro no
  // lista todo el catálogo (decenas de proveedores sin compras no aportan).
  // Se rearma cada vez que se abre el historial: una compra recién cargada
  // puede haber sumado un proveedor nuevo a la lista.
  function cargarProveedoresHistorial() {
    const sel = ge('ops-hist-proveedor');
    if (!sel) return;
    const user = window.SGA_Auth.getCurrentUser();
    const previo = sel.value;
    const provs = db().query(
      `SELECT DISTINCT p.id, p.razon_social
       FROM compras c
       JOIN proveedores p ON p.id = c.proveedor_id
       WHERE c.sucursal_id = ?
       ORDER BY p.razon_social COLLATE NOCASE`,
      [user.sucursal_id]
    );
    sel.innerHTML = '<option value="">Todos los proveedores</option>' +
      provs.map(p => `<option value="${esc(p.id)}">${esc(p.razon_social)}</option>`).join('');
    if (previo && provs.some(p => p.id === previo)) sel.value = previo;
  }

  function leerFiltrosHistorial() {
    return {
      fechaDesde:  ge('ops-hist-desde')?.value || undefined,
      fechaHasta:  ge('ops-hist-hasta')?.value || undefined,
      proveedorId: ge('ops-hist-proveedor')?.value || undefined,
    };
  }

  function renderHistorial({ fechaDesde, fechaHasta, proveedorId } = {}) {
    const body = ge('ops-historial-body');
    if (!body) return;

    const compras = getHistorialCompras({ fechaDesde, fechaHasta, proveedorId });

    if (!compras.length) {
      body.innerHTML = '<p style="color:#8090a0;text-align:center;padding:30px 0">Sin compras en el período seleccionado.</p>';
      return;
    }

    // En ADMIN POS, editar no tiene restricción. Desde el POS del local hace
    // falta el permiso puntual Y que la compra se haya cargado en la sesión de
    // caja abierta ahora, abierta hoy (no se toca nada de otro día ni turno).
    const puedeEditarAdmin = !!window.ADMIN_MODE;
    const puedeEditarPos   = !window.ADMIN_MODE && !!window.SGA_Permisos?.can('can_editar_compras_caja');
    const sesionActualId   = puedeEditarPos ? getSesionActivaIdDeHoy() : null;

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
            const pago  = estadoPagoCompra(c.total, c.pagado);
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
              <td style="padding:8px 10px;text-align:center;font-size:12px;font-weight:600;color:${pago.color}">${esc(pago.texto)}</td>
              <td style="padding:8px 10px;text-align:center;white-space:nowrap">
                <button style="padding:3px 12px;background:#2e7d32;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px" data-ver-compra="${esc(c.id)}">Ver</button>
                ${estado !== 'anulada' && !c.de_remito && (puedeEditarAdmin || (puedeEditarPos && c.sesion_caja_id && c.sesion_caja_id === sesionActualId)) ? `
                  <button style="padding:3px 12px;margin-left:4px;background:#fff;color:#1a5c2e;border:1px solid #1a5c2e;border-radius:4px;cursor:pointer;font-size:12px" data-editar-compra="${esc(c.id)}">✏️ Editar</button>
                ` : ''}
                ${estado !== 'anulada' && NotaCreditoWizard.puede() ? `
                  <button style="padding:3px 12px;margin-left:4px;background:#fff;color:#1565c0;border:1px solid #90caf9;border-radius:4px;cursor:pointer;font-size:12px" data-nc-compra="${esc(c.id)}" title="Registrar una nota de crédito de esta factura">🧾 NC</button>
                ` : ''}
                ${estado !== 'anulada' && puedeAnularCompras() ? `
                  <button style="padding:3px 12px;margin-left:4px;background:#fff;color:#c62828;border:1px solid #ef9a9a;border-radius:4px;cursor:pointer;font-size:12px" data-anular-compra="${esc(c.id)}" title="Anular esta compra (cargada por error)">🚫 Anular</button>
                ` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    body.querySelectorAll('[data-ver-compra]').forEach(btn => {
      btn.addEventListener('click', () => renderDetalleCompra(btn.dataset.verCompra));
    });
    body.querySelectorAll('[data-nc-compra]').forEach(btn => {
      btn.addEventListener('click', () => NotaCreditoWizard.abrir({
        compraOrigenId: btn.dataset.ncCompra,
        onSaved: () => renderHistorial(leerFiltrosHistorial()),
      }));
    });
    body.querySelectorAll('[data-anular-compra]').forEach(btn => {
      btn.addEventListener('click', () => abrirAnularCompra(btn.dataset.anularCompra));
    });
    body.querySelectorAll('[data-editar-compra]').forEach(btn => {
      btn.addEventListener('click', () => {
        sessionStorage.setItem('compras_v2_editar_id', btn.dataset.editarCompra);
        window.location.hash = 'compras_v2';
      });
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

    const estadoCompra = compra.estado || 'confirmada';
    const estadoColor  = ESTADO_COLOR[estadoCompra] || '#445566';
    const estadoLabel  = ESTADO_LABEL[estadoCompra]  || estadoCompra;
    const pagoInfo = estadoPagoCompra(compra.total, compra.pagado);

    // Desglose impositivo: solo se pidió para ADMIN POS y solo tiene sentido
    // mostrarlo si algo se cargó (compras a proveedores sin factura A, o
    // cargadas antes de que existiera este desglose, quedan todo en cero).
    const desglose = [];
    if (parseFloat(compra.iva_105)        > 0) desglose.push(`IVA 10,5%: ${fmt$(compra.iva_105)}`);
    if (parseFloat(compra.iva_21)         > 0) desglose.push(`IVA 21%: ${fmt$(compra.iva_21)}`);
    if (parseFloat(compra.imp_interno)    > 0) desglose.push(`Imp. interno: ${fmt$(compra.imp_interno)}`);
    if (parseFloat(compra.percepcion_iva) > 0) desglose.push(`Perc. IVA: ${fmt$(compra.percepcion_iva)}`);
    if (parseFloat(compra.percepcion_iibb)> 0) desglose.push(`Perc. IIBB: ${fmt$(compra.percepcion_iibb)}`);
    // total_factura es lo que dice la factura impresa; total es lo que quedó
    // cargado (puede diferir por redondeo o porque se corrigió a mano) — vale
    // la pena mostrar los dos si no coinciden, para poder detectar el desvío
    // sin tener que ir a Editar.
    const totalFactura = parseFloat(compra.total_factura) || 0;
    const totalCargado = parseFloat(compra.total) || 0;
    const difiereTotal  = totalFactura > 0 && Math.abs(totalFactura - totalCargado) > 0.5;

    body.innerHTML = `
      <div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #e0e6ee">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <div style="font-weight:700;font-size:15px">${esc(compra.proveedor_nombre || '—')}</div>
          <div style="color:#607080;font-size:13px">${esc(fecha)}</div>
          ${factRef !== '—' ? `<div style="color:#607080;font-size:13px">Fact. ${factRef}</div>` : ''}
          <span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;background:${estadoColor}22;color:${estadoColor}">${esc(estadoLabel)}</span>
          <span style="font-size:13px;font-weight:600;color:${pagoInfo.color}">${esc(pagoInfo.texto)}</span>
        </div>
        ${isAdmin ? `
          <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:#607080;margin-top:10px">
            <div>Total: <strong style="color:#1a2e4a">${fmt$(totalCargado)}</strong></div>
            ${difiereTotal ? `<div>Total factura: <strong style="color:#c0392b">${fmt$(totalFactura)}</strong></div>` : ''}
            ${desglose.length ? `<div>${esc(desglose.join(' · '))}</div>` : ''}
            ${compra.condicion_compra ? `<div>Condición: ${esc(compra.condicion_compra)}</div>` : ''}
            <div>Cargada por: <strong>${esc(compra.usuario_nombre || '—')}</strong></div>
          </div>
        ` : ''}
      </div>
      ${estadoCompra === 'anulada' ? `
        <div style="margin:0 0 10px;padding:8px 12px;background:#ffebee;border:1px solid #ef9a9a;border-radius:6px;font-size:12px;color:#b71c1c">
          <strong>Compra anulada</strong>${compra.anulada_en ? ` el ${esc(String(compra.anulada_en).slice(0, 10))}` : ''}${compra.motivo_anulacion ? ` — ${esc(compra.motivo_anulacion)}` : ''}
        </div>
      ` : ''}
      ${isAdmin ? `
        <div style="margin:0 0 10px;padding:7px 12px;background:#f0f6ff;border:1px solid #cfe0fb;border-radius:6px;font-size:12px;color:#2c4a72;display:flex;align-items:center;gap:6px">
          <span style="font-size:14px">✏️</span>
          Esta pantalla es tu revisión de precios de esta compra: el campo <strong>Precio Venta</strong> se edita acá mismo, se guarda solo al salir del campo — <strong>Enter</strong> guarda y pasa directo al siguiente producto.
        </div>
      ` : ''}
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
                  ? `<td style="padding:5px 10px;text-align:right;white-space:nowrap">
                       <input type="number" class="ops-precio-input" data-idx="${idx}" data-prodid="${esc(it.producto_id)}"
                              data-nombre="${esc(it.producto_nombre || '')}" data-costo="${it.costo_unitario || 0}"
                              value="${precioActual.toFixed(2)}" min="0" step="any"
                              title="Precio de venta — editable"
                              style="width:92px;padding:5px 6px;border:1.5px solid #90b8f0;border-radius:4px;text-align:right;font-size:13px;background:#f0f6ff;transition:background .15s,border-color .15s">
                       <span class="ops-precio-saved" data-idx="${idx}" style="display:none;color:#2e7d32;font-weight:700;margin-left:5px;font-size:13px" title="Guardado">✓</span>
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
      const inputsPrecio = Array.from(body.querySelectorAll('.ops-precio-input'));

      // onSettled: cuando termino todo lo relacionado a este precio -- guardado
      // Y, si correspondia, el wizard de familia ya cerrado. Enter lo usa para
      // recien ahi mover el foco al siguiente producto: si se moviera antes,
      // competiria con el wizard (que puede abrirse en el medio) por el foco.
      const guardarPrecio = (inp, { onSettled } = {}) => {
        const settle = () => { if (typeof onSettled === 'function') onSettled(); };
        const idx    = parseInt(inp.dataset.idx);
        const prodId = inp.dataset.prodid;
        const item   = compra.items[idx];
        const nuevoPrecio = parseFloat(inp.value);
        if (isNaN(nuevoPrecio) || nuevoPrecio < 0) {
          inp.value = (parseFloat(item.producto_precio_venta) || 0).toFixed(2);
          settle();
          return;
        }
        if (Math.abs(nuevoPrecio - (parseFloat(item.producto_precio_venta) || 0)) < 0.001) { settle(); return; } // sin cambios

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

        // Guardado consciente: a diferencia de un toast que desaparece solo, este
        // check queda a la vista mientras el modal siga abierto — sirve para ver
        // de un vistazo qué productos de la compra ya se revisaron.
        const savedBadge = body.querySelector(`.ops-precio-saved[data-idx="${idx}"]`);
        if (savedBadge) savedBadge.style.display = 'inline';
        window.SGA_Utils.showNotification('Precio actualizado', 'success', 1500);

        // Familia de productos: si este producto comparte costo/precio con otros
        // (ej. Coca-Cola 600ml + Sprite 600ml), ofrecer sincronizarlos — mismo
        // wizard que ya se abre al confirmar una compra o desde el editor de
        // productos (js/modules/familia.js), ahora también desde acá.
        if (Familia.tieneFamilia(prodId)) {
          Familia.showHerenciaModal({
            prodId,
            prodNombre: inp.dataset.nombre,
            nuevoCosto: parseFloat(inp.dataset.costo) || 0,
            nuevoPrecio,
            onDone: settle,
          });
        } else {
          settle();
        }
      };

      inputsPrecio.forEach((inp, i) => {
        inp.addEventListener('focus', () => {
          inp.style.background = '#fff';
          inp.style.borderColor = '#1565c0';
          inp.select();
        });
        inp.addEventListener('blur', () => {
          inp.style.background = '#f0f6ff';
          inp.style.borderColor = '#90b8f0';
          guardarPrecio(inp);
        });
        inp.addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const next = inputsPrecio[i + 1];
          // No llamar inp.blur() acá: guardarPrecio ya hace todo el trabajo, y
          // mover el foco (más abajo, en settle) dispara el blur natural solo
          // -- así el wizard de familia (si se abre) no compite por el foco.
          guardarPrecio(inp, { onSettled: () => { if (next) next.focus(); } });
        });
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

    // Mostrar/ocultar card de ajuste pendiente (propio o sincronizado de otra compu)
    const pendingCard = document.getElementById('ops-pending-card');
    if (pendingCard) {
      pendingCard.style.display = hayAjustePendiente() ? 'block' : 'none';
    }

    // Historial overlays
    ge('ops-historial-close')?.addEventListener('click', () => {
      ge('ops-historial-overlay').style.display = 'none';
    });
    ge('ops-historial-overlay')?.addEventListener('click', e => {
      if (e.target === ge('ops-historial-overlay')) ge('ops-historial-overlay').style.display = 'none';
    });
    ge('ops-hist-filtrar')?.addEventListener('click', () => {
      renderHistorial(leerFiltrosHistorial());
    });
    // El proveedor filtra apenas se elige (no hace falta apretar "Filtrar"),
    // y respeta el rango de fechas que ya esté cargado.
    ge('ops-hist-proveedor')?.addEventListener('change', () => {
      renderHistorial(leerFiltrosHistorial());
    });
    ge('ops-hist-limpiar')?.addEventListener('click', () => {
      ge('ops-hist-desde').value = '';
      ge('ops-hist-hasta').value = '';
      if (ge('ops-hist-proveedor')) ge('ops-hist-proveedor').value = '';
      renderHistorial();
    });
    ge('ops-anular-close')?.addEventListener('click', () => {
      ge('ops-anular-overlay').style.display = 'none';
    });
    ge('ops-anular-overlay')?.addEventListener('click', e => {
      if (e.target === ge('ops-anular-overlay')) ge('ops-anular-overlay').style.display = 'none';
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
          window.location.hash = '#compras_v2';
          break;
        case 'descartar-pendiente':
          if (!confirm('¿Descartás el ajuste de precios pendiente? Esta acción no se puede deshacer.')) return;
          descartarAjustePendiente();
          localStorage.removeItem('compras_resumen_editados');
          if (pendingCard) pendingCard.style.display = 'none';
          break;
        case 'compras':
          window.location.hash = '#compras_v2';
          break;
        case 'historial_compras':
          ge('ops-hist-desde').value = '';
          ge('ops-hist-hasta').value = '';
          cargarProveedoresHistorial();
          if (ge('ops-hist-proveedor')) ge('ops-hist-proveedor').value = '';
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
        case 'ajuste_stock':
          window.location.hash = '#ajuste_stock';
          break;
        case 'ajuste_stock_positivo':
          window.location.hash = '#ajuste_stock_positivo';
          break;
        default:
          break;
      }
    });
  }

  return { init, getResumenAnulacionCompra, anularCompra };
})();

export default OperacionesStock;
