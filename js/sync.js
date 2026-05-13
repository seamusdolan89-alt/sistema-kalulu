/**
 * sync.js — Sincronización bidireccional con Firebase Firestore
 *
 * PUSH (POS → Firestore):
 *   Registros con sync_status = 'pending' se envían a Firestore cada 30s.
 *
 * PULL (Firestore → SQLite):
 *   Registros escritos desde el panel admin (con _pulled: false) se aplican
 *   al SQLite local y se marcan _pulled: true en Firestore.
 *
 * El POS se autentica en Firebase de forma anónima (sin login visible al cajero).
 * Si no hay internet o Firebase no está configurado, falla silenciosamente.
 */

(function() {
  'use strict';

  let firestoreDb = null;
  let syncIntervalId = null;
  let initialized = false;
  let lastSyncAt = null;

  const SYNC_INTERVAL_MS = 30000;
  const BATCH_LIMIT = 50;

  // ─── PUSH: tablas SQLite → Firestore ─────────────────────────────────────────

  const SYNC_SOURCES = [
    { table: 'ventas',            collection: 'ventas',            pk: 'id',   denormalize: denormalizeVenta },
    { table: 'sesiones_caja',     collection: 'sesiones_caja',     pk: 'id',   denormalize: null },
    { table: 'egresos_caja',      collection: 'egresos_caja',      pk: 'id',   denormalize: null },
    { table: 'ingresos_caja',     collection: 'ingresos_caja',     pk: 'id',   denormalize: null },
    { table: 'gastos',            collection: 'gastos',            pk: 'id',   denormalize: null },
    { table: 'compras',           collection: 'compras',           pk: 'id',   denormalize: denormalizeCompra },
    { table: 'ordenes_compra',    collection: 'ordenes_compra',    pk: 'id',   denormalize: denormalizeOrden },
    { table: 'pagos_proveedores', collection: 'pagos_proveedores', pk: 'id',   denormalize: denormalizePagoProveedor },
    { table: 'stock',             collection: 'stock',             pk: null,   compositeKey: ['producto_id', 'sucursal_id'], denormalize: denormalizeStock },
    { table: 'productos',         collection: 'productos',         pk: 'id',   denormalize: null },
    { table: 'cuenta_corriente',  collection: 'cuenta_corriente',  pk: 'id',   denormalize: denormalizeCuentaCorriente },
    { table: 'clientes',          collection: 'clientes',          pk: 'id',   denormalize: null },
    { table: 'promociones',       collection: 'promociones',       pk: 'id',   denormalize: denormalizePromocion },
    { table: 'proveedores',       collection: 'proveedores',       pk: 'id',   denormalize: null },
  ];

  // ─── PULL: colecciones Firestore → SQLite ─────────────────────────────────────
  // Cada entrada define cómo aplicar un documento admin al SQLite local.

  const PULL_SOURCES = [
    { collection: 'compras',           applyFn: applyCompra },
    { collection: 'ordenes_compra',    applyFn: applyOrdenCompra },
    { collection: 'pagos_proveedores', applyFn: applyPagoProveedor },
    { collection: 'gastos',            applyFn: applyGasto },
    { collection: 'productos',         applyFn: applyProductoUpdate },
    { collection: 'promociones',       applyFn: applyPromocion },
  ];

  // ─── Inicialización ──────────────────────────────────────────────────────────

  async function initialize() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || cfg.apiKey.startsWith('REEMPLAZAR')) {
      console.log('⚠️ Firebase no configurado — sync deshabilitado.');
      updateSyncBadge('off');
      return;
    }

    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      firestoreDb = firebase.firestore();
      await firebase.auth().signInAnonymously();

      initialized = true;
      console.log('✅ Firebase Sync inicializado (bidireccional)');
      updateSyncBadge('pending');

      await syncNow();
      syncIntervalId = setInterval(syncNow, SYNC_INTERVAL_MS);
    } catch (err) {
      console.warn('Firebase Sync no disponible:', err.message);
      updateSyncBadge('error');
    }
  }

  // ─── Ciclo principal ─────────────────────────────────────────────────────────

  async function syncNow() {
    if (!initialized || !firestoreDb) return;

    if (window.ADMIN_MODE) {
      // Admin-pos: bajar datos de monitoreo (ventas, sesiones, egresos) + pull de cambios
      await syncMonitoringData();
      await pullFromFirestore();
    } else {
      // POS: primero bajar cambios del admin, luego subir los del POS
      const pulled = await pullFromFirestore();
      let pushed = 0;
      for (const source of SYNC_SOURCES) {
        try { pushed += await syncSource(source); }
        catch (err) { console.warn(`Push error en ${source.table}:`, err.message); }
      }
      if (pulled > 0) console.log(`⬇️  Pull: ${pulled} registros aplicados desde admin`);
      if (pushed > 0) console.log(`⬆️  Push: ${pushed} registros enviados a Firestore`);
    }

    lastSyncAt = new Date();
    updateSyncBadge('ok');
  }

  // ─── PUSH ────────────────────────────────────────────────────────────────────

  async function syncSource({ table, collection, pk, compositeKey, denormalize }) {
    let rows;
    try {
      rows = window.SGA_DB.query(
        `SELECT * FROM ${table} WHERE sync_status = 'pending' LIMIT ${BATCH_LIMIT}`
      );
    } catch (_) { return 0; }

    if (!rows || rows.length === 0) return 0;

    const batch = firestoreDb.batch();
    const sucursalId = window.SK_SUCURSAL_FIREBASE_ID || 'sucursal-1';

    for (const row of rows) {
      const docId = pk ? row[pk] : compositeKey.map(k => row[k]).join('_');
      if (!docId) continue;

      let data = denormalize ? denormalize(row) : { ...row };
      data._sucursal  = sucursalId;
      data._synced_at = new Date().toISOString();
      // Registros del POS NO llevan _pulled para no mezclarse con los del admin
      delete data._pulled;

      batch.set(firestoreDb.collection(collection).doc(docId), data, { merge: true });
    }

    await batch.commit();

    for (const row of rows) {
      try {
        if (pk) {
          window.SGA_DB.run(`UPDATE ${table} SET sync_status = 'synced' WHERE ${pk} = ?`, [row[pk]]);
        } else {
          window.SGA_DB.run(
            `UPDATE ${table} SET sync_status = 'synced' WHERE ${compositeKey.map(k => k + ' = ?').join(' AND ')}`,
            compositeKey.map(k => row[k])
          );
        }
      } catch (_) {}
    }

    return rows.length;
  }

  // ─── PULL ────────────────────────────────────────────────────────────────────

  async function pullFromFirestore() {
    let total = 0;

    for (const { collection, applyFn } of PULL_SOURCES) {
      try {
        const snap = await firestoreDb.collection(collection)
          .where('_pulled', '==', false)
          .limit(50)
          .get();

        if (snap.empty) continue;

        for (const doc of snap.docs) {
          try {
            applyFn(doc.data());
            await doc.ref.update({ _pulled: true, _pulled_at: new Date().toISOString() });
            total++;
          } catch (err) {
            console.warn(`Pull apply error (${collection} ${doc.id}):`, err.message);
          }
        }
      } catch (err) {
        // Índice faltante u otro error: no interrumpir el ciclo
        if (!err.message?.includes('index')) {
          console.warn(`Pull error (${collection}):`, err.message);
        }
      }
    }

    return total;
  }

  // ─── Apply functions (Firestore → SQLite) ────────────────────────────────────

  function applyCompra(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO compras
        (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, total,
         condicion_pago, estado, factura_pv, procesado_por, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.sucursal_id, data.proveedor_id, data.usuario_id, data.fecha,
       data.numero_factura, data.total, data.condicion_pago || null,
       data.estado || 'confirmada', data.factura_pv || null,
       data.procesado_por || null, data.updated_at || now]
    );

    for (const item of (data._items || [])) {
      window.SGA_DB.run(`
        INSERT OR REPLACE INTO compra_items
          (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior,
           subtotal, costo_modificado, unidad_compra, unidades_por_paquete)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [item.id, data.id, item.producto_id, item.cantidad,
         item.costo_unitario, item.costo_anterior || null,
         item.subtotal, item.costo_modificado ? 1 : 0,
         item.unidad_compra || 'Unidad', item.unidades_por_paquete || 1]
      );

      // Actualizar costo del producto si el admin lo marcó como modificado
      if (item.costo_modificado && item.costo_unitario) {
        window.SGA_DB.run(
          `UPDATE productos SET costo = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
          [item.costo_unitario, now, item.producto_id]
        );
      }
    }

    // Registrar deuda en cuenta_proveedor si corresponde
    if (data._registrar_deuda && data.proveedor_id && data.total > 0) {
      const deudaId = data._deuda_id || (`deuda_${data.id}`);
      window.SGA_DB.run(`
        INSERT OR IGNORE INTO cuenta_proveedor
          (id, proveedor_id, compra_id, tipo, monto, descripcion, fecha, usuario_id, sync_status, updated_at)
        VALUES (?,?,?,'deuda',?,?,?,?,'pending',?)`,
        [deudaId, data.proveedor_id, data.id, data.total,
         `Factura ${data.numero_factura || data.id}`, data.fecha,
         data.usuario_id || null, now]
      );
    }
  }

  function applyOrdenCompra(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO ordenes_compra
        (id, sucursal_id, proveedor_id, usuario_id, fecha_creacion, fecha_entrega,
         estado, notas, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.sucursal_id, data.proveedor_id, data.usuario_id,
       data.fecha_creacion, data.fecha_entrega || null,
       data.estado || 'borrador', data.notas || null, data.updated_at || now]
    );

    for (const item of (data._items || [])) {
      window.SGA_DB.run(`
        INSERT OR REPLACE INTO orden_compra_items
          (id, orden_id, producto_id, cantidad_pedida, cantidad_recibida,
           estado, costo_unitario, costo_anterior)
        VALUES (?,?,?,?,?,?,?,?)`,
        [item.id, data.id, item.producto_id,
         item.cantidad_pedida, item.cantidad_recibida || 0,
         item.estado || 'pendiente',
         item.costo_unitario || 0, item.costo_anterior || 0]
      );
    }
  }

  function applyPagoProveedor(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR IGNORE INTO pagos_proveedores
        (id, proveedor_id, fecha, observaciones, usuario_id, sync_status, updated_at)
      VALUES (?,?,?,?,?,'synced',?)`,
      [data.id, data.proveedor_id, data.fecha,
       data.observaciones || null, data.usuario_id || null, data.updated_at || now]
    );

    for (const metodo of (data._metodos || [])) {
      window.SGA_DB.run(`
        INSERT OR IGNORE INTO pagos_proveedores_metodos
          (id, pago_id, metodo, monto, referencia)
        VALUES (?,?,?,?,?)`,
        [metodo.id, data.id, metodo.metodo, metodo.monto, metodo.referencia || null]
      );
    }

    for (const imp of (data._imputaciones || [])) {
      window.SGA_DB.run(`
        INSERT OR IGNORE INTO imputaciones_pagos
          (id, pago_id, compra_id, monto_imputado, fecha)
        VALUES (?,?,?,?,?)`,
        [imp.id, data.id, imp.compra_id, imp.monto_imputado, imp.fecha || data.fecha]
      );
    }
  }

  function applyGasto(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO gastos
        (id, sucursal_id, usuario_id, fecha, categoria, descripcion, monto,
         metodo_pago, proveedor_id, observaciones, periodo, subcategoria,
         sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.sucursal_id, data.usuario_id, data.fecha,
       data.categoria, data.descripcion, data.monto,
       data.metodo_pago || 'efectivo', data.proveedor_id || null,
       data.observaciones || null, data.periodo || null,
       data.subcategoria || null, data.updated_at || now]
    );
  }

  function applyProductoUpdate(data) {
    // Solo actualiza los campos que el admin puede modificar remotamente.
    // No toca stock ni campos calculados por el POS.
    const now = new Date().toISOString();
    const fields = data._fields_updated || [];

    if (fields.length === 0) return; // admin debe especificar qué campos cambió

    const allowed = ['nombre', 'costo', 'precio_venta', 'descripcion',
                     'categoria_id', 'proveedor_principal_id', 'producto_madre_id',
                     'stock_minimo', 'stock_alerta', 'activo', 'es_oferta',
                     'oferta_desde', 'oferta_hasta'];
    const toUpdate = fields.filter(f => allowed.includes(f));
    if (toUpdate.length === 0) return;

    const setClause = toUpdate.map(f => `${f} = ?`).join(', ');
    const values    = toUpdate.map(f => data[f] ?? null);
    values.push('pending', now, data.id);

    window.SGA_DB.run(
      `UPDATE productos SET ${setClause}, sync_status = ?, updated_at = ? WHERE id = ?`,
      values
    );
  }

  function applyPromocion(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO promociones
        (id, nombre, tipo, descripcion, fecha_desde, fecha_hasta,
         activa, aplica_a, valor_descuento, tipo_descuento, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.nombre, data.tipo || null, data.descripcion || null,
       data.fecha_desde || null, data.fecha_hasta || null,
       data.activa !== false ? 1 : 0,
       data.aplica_a || null, data.valor_descuento || null,
       data.tipo_descuento || null, data.updated_at || now]
    );

    // Reemplazar items de la promoción
    window.SGA_DB.run(`DELETE FROM promocion_items WHERE promocion_id = ?`, [data.id]);
    for (const item of (data._items || [])) {
      window.SGA_DB.run(`
        INSERT OR IGNORE INTO promocion_items (promocion_id, producto_id, cantidad_requerida)
        VALUES (?,?,?)`,
        [data.id, item.producto_id, item.cantidad_requerida || 1]
      );
    }
  }

  // ─── Denormalizadores (Push) ─────────────────────────────────────────────────

  function denormalizeVenta(venta) {
    const items = window.SGA_DB.query(
      `SELECT vi.*, p.nombre AS producto_nombre, p.costo AS costo_actual,
              cat.nombre AS categoria_nombre
       FROM venta_items vi
       LEFT JOIN productos p ON p.id = vi.producto_id
       LEFT JOIN categorias cat ON cat.id = p.categoria_id
       WHERE vi.venta_id = ?`,
      [venta.id]
    ) || [];

    const pagos = window.SGA_DB.query(
      `SELECT * FROM venta_pagos WHERE venta_id = ?`, [venta.id]
    ) || [];

    const cliente = venta.cliente_id
      ? (window.SGA_DB.query(`SELECT nombre, apellido FROM clientes WHERE id = ?`, [venta.cliente_id])[0] || null)
      : null;

    const usuario = venta.usuario_id
      ? (window.SGA_DB.query(`SELECT nombre FROM usuarios WHERE id = ?`, [venta.usuario_id])[0] || null)
      : null;

    return {
      ...venta, items, pagos,
      cliente_nombre: cliente ? `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim() : null,
      usuario_nombre: usuario?.nombre || null,
    };
  }

  function denormalizeCompra(compra) {
    const items = window.SGA_DB.query(
      `SELECT ci.*, p.nombre AS producto_nombre
       FROM compra_items ci
       LEFT JOIN productos p ON p.id = ci.producto_id
       WHERE ci.compra_id = ?`,
      [compra.id]
    ) || [];
    const proveedor = compra.proveedor_id
      ? (window.SGA_DB.query(`SELECT razon_social FROM proveedores WHERE id = ?`, [compra.proveedor_id])[0] || null)
      : null;
    return { ...compra, _items: items, proveedor_nombre: proveedor?.razon_social || null };
  }

  function denormalizeOrden(orden) {
    const items = window.SGA_DB.query(
      `SELECT oi.*, p.nombre AS producto_nombre
       FROM orden_compra_items oi
       LEFT JOIN productos p ON p.id = oi.producto_id
       WHERE oi.orden_id = ?`,
      [orden.id]
    ) || [];
    return { ...orden, _items: items };
  }

  function denormalizePagoProveedor(pago) {
    const metodos = window.SGA_DB.query(
      `SELECT * FROM pagos_proveedores_metodos WHERE pago_id = ?`, [pago.id]
    ) || [];
    const imputaciones = window.SGA_DB.query(
      `SELECT * FROM imputaciones_pagos WHERE pago_id = ?`, [pago.id]
    ) || [];
    const proveedor = pago.proveedor_id
      ? (window.SGA_DB.query(`SELECT razon_social FROM proveedores WHERE id = ?`, [pago.proveedor_id])[0] || null)
      : null;
    return { ...pago, _metodos: metodos, _imputaciones: imputaciones, proveedor_nombre: proveedor?.razon_social || null };
  }

  function denormalizeCuentaCorriente(cc) {
    const cliente = cc.cliente_id
      ? (window.SGA_DB.query(`SELECT nombre, apellido, telefono FROM clientes WHERE id = ?`, [cc.cliente_id])[0] || null)
      : null;
    return {
      ...cc,
      cliente_nombre: cliente ? `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim() : null,
      cliente_telefono: cliente?.telefono || null,
    };
  }

  function denormalizeStock(stockRow) {
    const producto = window.SGA_DB.query(
      `SELECT nombre, stock_minimo, stock_alerta FROM productos WHERE id = ?`,
      [stockRow.producto_id]
    )[0] || {};
    return {
      ...stockRow,
      producto_nombre: producto.nombre || null,
      stock_minimo: producto.stock_minimo || 0,
      stock_alerta: producto.stock_alerta || 0,
    };
  }

  function denormalizePromocion(promo) {
    const items = window.SGA_DB.query(
      `SELECT pi.*, p.nombre AS producto_nombre
       FROM promocion_items pi
       LEFT JOIN productos p ON p.id = pi.producto_id
       WHERE pi.promocion_id = ?`,
      [promo.id]
    ) || [];
    return { ...promo, _items: items };
  }

  // ─── Apply functions para sincronización inicial (todas las colecciones) ────────

  function applyCategoria(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO categorias (id, nombre, comision_pct, sync_status, updated_at)
      VALUES (?,?,?,'synced',?)`,
      [data.id, data.nombre || '?', data.comision_pct || 0, data.updated_at || null]
    );
  }

  function applyProveedorFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO proveedores
        (id, razon_social, cuit, telefono, email, contacto_nombre, condicion_pago, activo, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.razon_social || '?', data.cuit || null, data.telefono || null,
       data.email || null, data.contacto_nombre || null, data.condicion_pago || null,
       data.activo !== false ? 1 : 0, data.updated_at || null]
    );
  }

  function applyProductoFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO productos
        (id, nombre, descripcion, categoria_id, proveedor_principal_id, proveedor_alternativo_id,
         producto_madre_id, es_madre, precio_independiente, costo, precio_venta,
         comision_pct_override, unidad_medida, stock_minimo, stock_alerta,
         cant_pedido, pedido_unidad, unidad_compra, unidades_por_paquete_compra,
         unidad_venta, costo_paquete, precio_lista_por, precio_lista_divisor,
         hereda_costo, hereda_precio, es_oferta, oferta_desde, oferta_hasta,
         activo, fecha_alta, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.nombre || '?', data.descripcion || null,
       data.categoria_id || null, data.proveedor_principal_id || null, data.proveedor_alternativo_id || null,
       data.producto_madre_id || null, data.es_madre ? 1 : 0, data.precio_independiente ? 1 : 0,
       data.costo || 0, data.precio_venta || 0,
       data.comision_pct_override || null, data.unidad_medida || 'unidad',
       data.stock_minimo || 0, data.stock_alerta || 0,
       data.cant_pedido || 0, data.pedido_unidad || 'unidad',
       data.unidad_compra || 'Unidad', data.unidades_por_paquete_compra || 1,
       data.unidad_venta || 'Unidad', data.costo_paquete || 0,
       data.precio_lista_por || 'Por unidad de compra', data.precio_lista_divisor || 1,
       data.hereda_costo !== false ? 1 : 0, data.hereda_precio !== false ? 1 : 0,
       data.es_oferta ? 1 : 0, data.oferta_desde || null, data.oferta_hasta || null,
       data.activo !== false ? 1 : 0, data.fecha_alta || null, data.updated_at || null]
    );

    for (const cb of (data.codigos_barras || [])) {
      try {
        window.SGA_DB.run(`
          INSERT OR IGNORE INTO codigos_barras (id, producto_id, codigo, es_principal)
          VALUES (?,?,?,?)`,
          [cb.id, data.id, cb.codigo, cb.es_principal ? 1 : 0]
        );
      } catch (_) {}
    }
  }

  function applyClienteFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO clientes
        (id, nombre, apellido, telefono, email, dni, fecha_alta, activo, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.nombre || '?', data.apellido || null, data.telefono || null,
       data.email || null, data.dni || null, data.fecha_alta || null,
       data.activo !== false ? 1 : 0, data.updated_at || null]
    );
  }

  function applyStockFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at)
      VALUES (?,?,?,?,'synced',?)`,
      [data.producto_id, data.sucursal_id || (window.SK_SUCURSAL_FIREBASE_ID || 'sucursal-1'),
       data.cantidad || 0, data.fecha_modificacion || null, data.updated_at || null]
    );
  }

  function applySesionCajaFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO sesiones_caja
        (id, sucursal_id, usuario_apertura_id, usuario_cierre_id,
         fecha_apertura, fecha_cierre, saldo_inicial,
         total_efectivo, total_mercadopago, total_tarjeta,
         total_transferencia, total_cuenta_corriente,
         total_egresos, saldo_final_esperado, saldo_final_real,
         diferencia, detalle_billetes, estado, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.sucursal_id || null,
       data.usuario_apertura_id || null, data.usuario_cierre_id || null,
       data.fecha_apertura || null, data.fecha_cierre || null,
       data.saldo_inicial || 0,
       data.total_efectivo || 0, data.total_mercadopago || 0,
       data.total_tarjeta || 0, data.total_transferencia || 0,
       data.total_cuenta_corriente || 0, data.total_egresos || 0,
       data.saldo_final_esperado || 0, data.saldo_final_real ?? null,
       data.diferencia ?? null, data.detalle_billetes || null,
       data.estado || 'abierta', data.updated_at || null]
    );
  }

  function applyEgresoCajaFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO egresos_caja
        (id, sesion_caja_id, monto, descripcion, fecha, usuario_id)
      VALUES (?,?,?,?,?,?)`,
      [data.id, data.sesion_caja_id || null,
       data.monto || 0, data.descripcion || null,
       data.fecha || null, data.usuario_id || null]
    );
  }

  function applyVentaFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO ventas
        (id, sucursal_id, sesion_caja_id, cliente_id, usuario_id,
         fecha, subtotal, descuento, total, estado, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.sucursal_id || null, data.sesion_caja_id || null,
       data.cliente_id || null, data.usuario_id || null,
       data.fecha, data.subtotal || 0, data.descuento || 0,
       data.total || 0, data.estado || 'completada', data.updated_at || null]
    );

    for (const item of (data.items || [])) {
      try {
        window.SGA_DB.run(`
          INSERT OR REPLACE INTO venta_items
            (id, venta_id, producto_id, cantidad, precio_unitario,
             costo_unitario, descuento_item, subtotal, comision_pct)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          [item.id, data.id, item.producto_id || null,
           item.cantidad || 0, item.precio_unitario || 0,
           item.costo_unitario || item.costo_actual || 0,
           item.descuento_item || 0, item.subtotal || 0,
           item.comision_pct || 0]
        );
      } catch (_) {}
    }

    for (const pago of (data.pagos || [])) {
      try {
        window.SGA_DB.run(`
          INSERT OR REPLACE INTO venta_pagos (id, venta_id, medio, monto, referencia)
          VALUES (?,?,?,?,?)`,
          [pago.id, data.id, pago.medio, pago.monto || 0, pago.referencia || null]
        );
      } catch (_) {}
    }
  }

  // ─── Sync incremental de datos de monitoreo (solo ADMIN_MODE) ────────────────

  async function syncMonitoringData() {
    if (!firestoreDb) return 0;

    const MONITOR_SOURCES = [
      { name: 'sesiones_caja', applyFn: applySesionCajaFull },
      { name: 'egresos_caja',  applyFn: applyEgresoCajaFull },
      { name: 'ventas',        applyFn: applyVentaFull },
    ];

    const lastSync = localStorage.getItem('admin_monitor_sync_at');
    let total = 0;

    for (const { name, applyFn } of MONITOR_SOURCES) {
      try {
        let q = firestoreDb.collection(name);
        if (lastSync) {
          q = q.where('_synced_at', '>', lastSync).limit(200);
        } else {
          // Primera vez: últimos 90 días
          const desde = new Date();
          desde.setDate(desde.getDate() - 90);
          q = q.where('_synced_at', '>', desde.toISOString()).limit(500);
        }

        const snap = await q.get();
        for (const doc of snap.docs) {
          try { applyFn(doc.data()); total++; }
          catch (err) { console.warn(`Monitor apply error (${name}):`, err.message); }
        }
      } catch (err) {
        console.warn(`Monitor sync skip (${name}):`, err.message);
      }
    }

    localStorage.setItem('admin_monitor_sync_at', new Date().toISOString());
    if (total > 0) console.log(`📡 Monitor sync: ${total} registros actualizados`);
    return total;
  }

  // ─── Sincronización inicial completa (admin-pos primer arranque) ──────────────

  async function initialSyncFromFirestore(progressFn = () => {}) {
    const report = (msg) => { progressFn(msg); console.log('🔄 Initial Sync:', msg); };

    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || cfg.apiKey.startsWith('REEMPLAZAR')) {
      report('Firebase no configurado — se omite sincronización inicial.');
      return;
    }

    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      const db = firebase.firestore();
      if (!firebase.auth().currentUser) {
        await firebase.auth().signInAnonymously();
      }
      firestoreDb = db;
      initialized = true;
    } catch (err) {
      report('Error conectando a Firebase: ' + err.message);
      throw err;
    }

    const COLLECTIONS = [
      { name: 'categorias',        applyFn: applyCategoria,        label: 'Categorías' },
      { name: 'proveedores',       applyFn: applyProveedorFull,    label: 'Proveedores' },
      { name: 'productos',         applyFn: applyProductoFull,     label: 'Productos' },
      { name: 'clientes',          applyFn: applyClienteFull,      label: 'Clientes' },
      { name: 'stock',             applyFn: applyStockFull,        label: 'Stock' },
      { name: 'sesiones_caja',     applyFn: applySesionCajaFull,   label: 'Sesiones de caja' },
      { name: 'egresos_caja',      applyFn: applyEgresoCajaFull,   label: 'Egresos' },
      { name: 'ventas',            applyFn: applyVentaFull,        label: 'Ventas' },
      { name: 'compras',           applyFn: applyCompra,           label: 'Compras' },
      { name: 'ordenes_compra',    applyFn: applyOrdenCompra,      label: 'Órdenes' },
      { name: 'gastos',            applyFn: applyGasto,            label: 'Gastos' },
      { name: 'promociones',       applyFn: applyPromocion,        label: 'Promociones' },
      { name: 'pagos_proveedores', applyFn: applyPagoProveedor,    label: 'Pagos proveedores' },
    ];

    for (const { name, applyFn, label } of COLLECTIONS) {
      report(`Descargando ${label}...`);
      let count = 0;
      let lastDoc = null;

      while (true) {
        let q = firestoreDb.collection(name).orderBy('updated_at', 'desc').limit(500);
        if (lastDoc) q = q.startAfter(lastDoc);

        let snap;
        try {
          snap = await q.get();
        } catch (err) {
          // Si no hay índice u otro error, intentar sin orden
          try {
            let q2 = firestoreDb.collection(name).limit(500);
            if (lastDoc) q2 = q2.startAfter(lastDoc);
            snap = await q2.get();
          } catch (err2) {
            console.warn(`Initial sync skip (${name}):`, err2.message);
            break;
          }
        }

        if (snap.empty) break;

        for (const doc of snap.docs) {
          try { applyFn(doc.data()); count++; }
          catch (err) { console.warn(`Apply error (${name} ${doc.id}):`, err.message); }
        }

        report(`${label}: ${count} registros...`);
        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < 500) break;
      }

      report(`✓ ${label}: ${count}`);
    }

    report('¡Sincronización inicial completa!');
  }

  // ─── Badge visual ─────────────────────────────────────────────────────────────

  function updateSyncBadge(state) {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    const states = {
      off:     { icon: '⚫', title: 'Sync deshabilitado' },
      pending: { icon: '🟡', title: 'Sincronizando...' },
      ok:      { icon: '🟢', title: `Último sync: ${lastSyncAt ? lastSyncAt.toLocaleTimeString() : '—'}` },
      error:   { icon: '🔴', title: 'Error de conexión con Firebase' },
    };
    const s = states[state] || states.off;
    badge.textContent = s.icon;
    badge.title = s.title;
  }

  // ─── API pública ─────────────────────────────────────────────────────────────

  window.SGA_Sync = {
    initialize,
    syncNow,
    initialSyncFromFirestore,
    syncMonitoringData,
    getFirestore: () => firestoreDb,
    isInitialized: () => initialized,
    getStatus: () => ({ initialized, lastSyncAt }),
    queueChange:     async () => {},
    syncPending:     syncNow,
    resolveConflict: (local) => local,
    getQueue:        () => [],
    clearQueue:      () => {},
  };
})();
