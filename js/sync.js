/**
 * sync.js — Sincronización bidireccional con Firebase Firestore
 *
 * PUSH (POS → Firestore):
 *   Registros con sync_status = 'pending' se envían a Firestore apenas se completa
 *   la acción que los generó (venta, compra, gasto, movimiento de caja), y además
 *   cada 5 min como respaldo (por si algún flujo no dispara el push puntual).
 *
 * PULL (Firestore → SQLite):
 *   Registros escritos desde el panel admin (con _pulled: false) se aplican
 *   al SQLite local cada 5 min automáticamente y se marcan _pulled: true en Firestore.
 *
 * ADMIN-POS (panel de administración, uso manual):
 *   "⬇ Pull" trae los cambios hechos en el POS (por fecha, no por _pulled).
 *   "⬆ Push POS" manda los cambios pendientes del admin hacia el POS
 *   (marcándolos _pulled: false para que el POS los levante en su próximo ciclo).
 *   Ninguno de los dos corre solo — son a propósito manuales.
 *
 * USUARIOS: sincroniza igual que el resto (login/permisos), pero el login en sí
 *   siempre valida contra la base LOCAL — un dispositivo nuevo sin ningún usuario
 *   local todavía no puede loguearse para disparar ningún pull. Para arrancar un
 *   dispositivo desde cero hace falta restaurar un backup (botón 💾) primero.
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

  const PULL_INTERVAL_MS  = 5 * 60 * 1000;  // 5 min — POS pull automático
  const ADMIN_INTERVAL_MS = 30 * 1000;       // 30 s  — admin monitoring
  const BATCH_LIMIT = 50;

  // ─── PUSH: tablas SQLite → Firestore ─────────────────────────────────────────

  const SYNC_SOURCES = [
    { table: 'usuarios',          collection: 'usuarios',          pk: 'id',   denormalize: null },
    { table: 'producto_codigo_proveedor', collection: 'producto_codigo_proveedor', pk: null,
      compositeKey: ['proveedor_id', 'codigo'], denormalize: null },
    { table: 'ventas',            collection: 'ventas',            pk: 'id',   denormalize: denormalizeVenta },
    { table: 'sesiones_caja',     collection: 'sesiones_caja',     pk: 'id',   denormalize: null },
    { table: 'egresos_caja',      collection: 'egresos_caja',      pk: 'id',   denormalize: null },
    { table: 'ingresos_caja',     collection: 'ingresos_caja',     pk: 'id',   denormalize: null },
    { table: 'gastos',            collection: 'gastos',            pk: 'id',   denormalize: null },
    { table: 'compras',           collection: 'compras',           pk: 'id',   denormalize: denormalizeCompra },
    { table: 'ordenes_compra',    collection: 'ordenes_compra',    pk: 'id',   denormalize: denormalizeOrden },
    { table: 'pagos_proveedores', collection: 'pagos_proveedores', pk: 'id',   denormalize: denormalizePagoProveedor },
    { table: 'stock',             collection: 'stock',             pk: null,   compositeKey: ['producto_id', 'sucursal_id'], denormalize: denormalizeStock },
    { table: 'productos',         collection: 'productos',         pk: 'id',   denormalize: denormalizeProducto },
    { table: 'cuenta_corriente',  collection: 'cuenta_corriente',  pk: 'id',   denormalize: denormalizeCuentaCorriente },
    { table: 'clientes',          collection: 'clientes',          pk: 'id',   denormalize: null },
    { table: 'promociones',       collection: 'promociones',       pk: 'id',   denormalize: denormalizePromocion },
    { table: 'proveedores',       collection: 'proveedores',       pk: 'id',   denormalize: null },
    { table: 'caja_admin',        collection: 'caja_admin',        pk: 'id',   denormalize: null },
    { table: 'consumo_interno',   collection: 'consumo_interno',   pk: 'id',   denormalize: null },
    // posPush:false — son admin-authoritative (solo se crean/editan desde ADMIN POS,
    // ver Configuración). El POS no debe re-pushear su copia local: si lo hiciera,
    // una fila local vieja podría pisar en Firestore un cambio recién hecho desde admin.
    { table: 'medios_cobro',      collection: 'medios_cobro',      pk: 'id',   denormalize: null, posPush: false },
    { table: 'sucursales',        collection: 'sucursales',        pk: 'id',   denormalize: null, posPush: false },
  ];

  // ─── PULL: colecciones Firestore → SQLite ─────────────────────────────────────
  // Cada entrada define cómo aplicar un documento admin al SQLite local.

  const PULL_SOURCES = [
    { collection: 'usuarios',          applyFn: applyUsuarioFull },
    { collection: 'producto_codigo_proveedor', applyFn: applyCodigoProveedorFull },
    { collection: 'compras',           applyFn: applyCompra },
    { collection: 'ordenes_compra',    applyFn: applyOrdenCompra },
    { collection: 'pagos_proveedores', applyFn: applyPagoProveedor },
    { collection: 'gastos',            applyFn: applyGasto },
    { collection: 'productos',         applyFn: applyProductoFull },
    { collection: 'promociones',       applyFn: applyPromocion },
    { collection: 'proveedores',       applyFn: applyProveedorFull },
    { collection: 'clientes',          applyFn: applyClienteFull },
    { collection: 'stock',             applyFn: applyStockFull },
    { collection: 'medios_cobro',      applyFn: applyMedioCobroFull },
    { collection: 'sucursales',        applyFn: applySucursalFull },
    { collection: 'cuenta_corriente',  applyFn: applyCuentaCorriente },
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

      // Fix de una sola vez: en admin-pos, resetear pagos con caja_seamus/mercadopago
      // que quedaron como 'synced' con el CHECK constraint viejo, para que se re-pusheen.
      if (window.ADMIN_MODE && !localStorage.getItem('fix_ppm_check_repush_done')) {
        try {
          window.SGA_DB.run(`
            UPDATE pagos_proveedores SET sync_status = 'pending'
            WHERE id IN (
              SELECT pago_id FROM pagos_proveedores_metodos
              WHERE metodo IN ('caja_seamus', 'mercadopago')
            )
          `);
          localStorage.setItem('fix_ppm_check_repush_done', '1');
          console.log('🔧 Fix pagos_proveedores_metodos: pagos reseteados a pending para re-push');
        } catch(e) { console.warn('Fix pagos_proveedores_metodos:', e.message); }
      }

      await syncNow();

      if (!window.ADMIN_MODE) {
        // POS: pull automático cada 5 minutos. El push es event-driven (se dispara
        // después de cada venta/compra/gasto/movimiento de caja), pero además
        // reforzamos con un push de respaldo en el mismo intervalo, por si algún
        // flujo nuevo no lo dispara — así nunca depende de que el cajero haga nada.
        syncIntervalId = setInterval(() => {
          pullFromFirestore()
            .then(n => { if (n > 0) { console.log(`⬇️  Pull auto: ${n} registros`); updateSyncBadge('ok'); } })
            .catch(() => {});
          pushPending().catch(() => {});
        }, PULL_INTERVAL_MS);
      }
    } catch (err) {
      console.warn('Firebase Sync no disponible:', err.message);
      updateSyncBadge('error');
    }
  }

  // ─── Ciclo principal ─────────────────────────────────────────────────────────

  async function syncNow() {
    if (!initialized || !firestoreDb) return;

    if (window.ADMIN_MODE) {
      // Admin-pos: pull manual (botón Pull) o al iniciar. Push al POS es manual (botón Push POS).
      return await syncMonitoringData();
    } else {
      // POS: primero bajar cambios del admin, luego subir los del POS
      const pulled = await pullFromFirestore();
      let pushed = 0;
      for (const source of SYNC_SOURCES) {
        if (source.posPush === false) continue;
        try { pushed += await drainSource(source, syncSource); }
        catch (err) { console.warn(`Push error en ${source.table}:`, err.message); }
      }
      if (pulled > 0) console.log(`⬇️  Pull: ${pulled} registros aplicados desde admin`);
      if (pushed > 0) console.log(`⬆️  Push: ${pushed} registros enviados a Firestore`);

      lastSyncAt = new Date();
      updateSyncBadge('ok');
      return pulled;
    }
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

  // ─── PUSH desde admin-pos (con _pulled:false para que POS los descargue) ───────

  async function syncAdminSource({ table, collection, pk, compositeKey, denormalize }) {
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
      data._pulled    = false; // POS filtra por este campo para descargar cambios del admin

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

  // Repite syncFn sobre la misma tabla hasta vaciar la cola de pendientes.
  // syncSource/syncAdminSource traen como mucho BATCH_LIMIT filas por llamada;
  // sin este loop, un alta masiva (ej. importación de productos) solo empuja
  // la primera tanda por ciclo y el resto queda pendiente indefinidamente si
  // la app se cierra antes del próximo ciclo automático.
  async function drainSource(source, syncFn) {
    let total = 0;
    let n;
    do {
      n = await syncFn(source);
      total += n;
    } while (n >= BATCH_LIMIT);
    return total;
  }

  // ─── PUSH event-driven desde POS (llamado por módulos al completar acciones) ──

  async function pushPending() {
    if (!initialized || !firestoreDb) return 0;
    let pushed = 0;
    for (const source of SYNC_SOURCES) {
      if (source.posPush === false) continue;
      try { pushed += await drainSource(source, syncSource); }
      catch (err) { console.warn(`Push error (${source.table}):`, err.message); }
    }
    if (pushed > 0) {
      console.log(`⬆️  Push: ${pushed} registros enviados`);
      lastSyncAt = new Date();
      updateSyncBadge('ok');
    }
    return pushed;
  }

  // ─── PUSH manual desde admin-pos al POS ──────────────────────────────────────

  const ADMIN_PUSH_TABLES = ['usuarios', 'productos', 'proveedores', 'clientes', 'compras',
                              'ordenes_compra', 'pagos_proveedores', 'gastos',
                              'promociones', 'stock', 'cuenta_corriente', 'producto_codigo_proveedor',
                              'medios_cobro', 'sucursales'];

  async function pushToPos() {
    if (!initialized || !firestoreDb) throw new Error('Firebase no conectado');

    const adminSources = SYNC_SOURCES.filter(s => ADMIN_PUSH_TABLES.includes(s.table));
    let total = 0;
    for (const source of adminSources) {
      try { total += await drainSource(source, syncAdminSource); }
      catch (err) { console.warn(`Push error (${source.table}):`, err.message); }
    }
    if (total > 0) console.log(`⬆️  Push manual: ${total} registros enviados a Firestore`);
    return total;
  }

  // ─── PULL ────────────────────────────────────────────────────────────────────

  async function pullFromFirestore() {
    let total = 0;

    for (const { collection, applyFn } of PULL_SOURCES) {
      try {
        // Repetir hasta vaciar la cola: una tanda grande desde admin (ej. importación
        // masiva) puede superar los 50 documentos que trae cada get().
        let batchCount;
        do {
          const snap = await firestoreDb.collection(collection)
            .where('_pulled', '==', false)
            .limit(50)
            .get();

          batchCount = snap.size;
          if (batchCount === 0) break;

          for (const doc of snap.docs) {
            try {
              applyFn(doc.data());
              await doc.ref.update({ _pulled: true, _pulled_at: new Date().toISOString() });
              total++;
            } catch (err) {
              console.warn(`Pull apply error (${collection} ${doc.id}):`, err.message);
            }
          }
        } while (batchCount >= 50);
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
         condicion_pago, estado, factura_pv, procesado_por,
         subtotal_neto, iva_105, iva_21, imp_interno, percepcion_iva, percepcion_iibb,
         total_factura, condicion_compra, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.sucursal_id, data.proveedor_id, data.usuario_id, data.fecha,
       data.numero_factura, data.total, data.condicion_pago || null,
       data.estado || 'confirmada', data.factura_pv || null,
       data.procesado_por || null,
       data.subtotal_neto || 0, data.iva_105 || 0, data.iva_21 || 0, data.imp_interno || 0,
       data.percepcion_iva || 0, data.percepcion_iibb || 0,
       data.total_factura || 0, data.condicion_compra || null, data.updated_at || now]
    );

    for (const item of (data._items || [])) {
      window.SGA_DB.run(`
        INSERT OR REPLACE INTO compra_items
          (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior,
           subtotal, costo_modificado, unidad_compra, unidades_por_paquete,
           descuento_pct, descuento_monto, iva)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [item.id, data.id, item.producto_id, item.cantidad,
         item.costo_unitario, item.costo_anterior || null,
         item.subtotal, item.costo_modificado ? 1 : 0,
         item.unidad_compra || 'Unidad', item.unidades_por_paquete || 1,
         item.descuento_pct || 0, item.descuento_monto || 0, item.iva || null]
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
        INSERT OR REPLACE INTO pagos_proveedores_metodos
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

  function applyIngresoCaja(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO ingresos_caja
        (id, sesion_caja_id, monto, descripcion, fecha, usuario_id, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,'synced',?)`,
      [data.id, data.sesion_caja_id || null, data.monto || 0,
       data.descripcion || null, data.fecha || null, data.usuario_id || null,
       data.updated_at || now]
    );
  }

  function applyCuentaCorriente(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO cuenta_corriente
        (id, cliente_id, sucursal_id, tipo, monto, venta_id, descripcion, fecha, usuario_id, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.cliente_id, data.sucursal_id || null, data.tipo,
       data.monto, data.venta_id || null, data.descripcion || null,
       data.fecha, data.usuario_id || null, data.updated_at || now]
    );
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

  function applyConsumoInternoFull(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO consumo_interno
        (id, producto_id, sucursal_id, usuario_id, registrado_por_usuario_id,
         cantidad, costo_unitario, precio_venta_unitario, motivo, observaciones, fecha,
         sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.producto_id, data.sucursal_id, data.usuario_id,
       data.registrado_por_usuario_id || data.usuario_id,
       data.cantidad, data.costo_unitario || 0, data.precio_venta_unitario || 0,
       data.motivo || null, data.observaciones || null, data.fecha,
       data.updated_at || now]
    );
  }

  function applyCajaAdmin(data) {
    const now = new Date().toISOString();
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO caja_admin
        (id, tipo, monto, concepto, egreso_caja_id, compra_id, proveedor_id,
         fecha, usuario_id, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.tipo, data.monto, data.concepto || null,
       data.egreso_caja_id || null, data.compra_id || null,
       data.proveedor_id || null, data.fecha, data.usuario_id,
       data.updated_at || now]
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

  // codigos_barras y producto_sustitutos son tablas propias (no columnas de
  // productos), así que sin esto el push de productos nunca los incluía —
  // applyProductoFull() ya sabía aplicarlos desde data.codigos_barras/
  // producto_sustitutos, pero nunca le llegaba nada porque el lado que
  // pushea (denormalize: null) solo mandaba las columnas propias de la fila.
  function denormalizeProducto(row) {
    const codigos = window.SGA_DB.query(
      `SELECT id, codigo, es_principal FROM codigos_barras WHERE producto_id = ?`,
      [row.id]
    );
    const sustitutos = window.SGA_DB.query(
      `SELECT sustituto_id, referencia_id, activo, fecha_asignacion FROM producto_sustitutos WHERE producto_id = ?`,
      [row.id]
    );
    return {
      ...row,
      codigos_barras: codigos,
      producto_sustitutos: sustitutos,
    };
  }

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

  function applyUsuarioFull(data) {
    // firebase_uid queda fuera a propósito: es un campo vestigial (login es local,
    // no usa Firebase Auth) y evita choques de UNIQUE entre usuarios "demo" viejos.
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO usuarios
        (id, nombre, rol, sucursal_id, activo, username, password_hash, permisos_json,
         sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.nombre || '?', data.rol || 'cajero', data.sucursal_id || null,
       data.activo !== false ? 1 : 0, data.username || null, data.password_hash || null,
       data.permisos_json || null, data.updated_at || new Date().toISOString()]
    );
  }

  function applyCodigoProveedorFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO producto_codigo_proveedor
        (proveedor_id, codigo, producto_id, sync_status, updated_at)
      VALUES (?,?,?,'synced',?)`,
      [data.proveedor_id, data.codigo, data.producto_id, data.updated_at || new Date().toISOString()]
    );
  }

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
        (id, razon_social, cuit, telefono, email, contacto_nombre, condicion_pago,
         tipo_proveedor, alias, condicion_iva, agente_retencion_iva, agente_retencion_iibb,
         condicion_compra, order_day, activo, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [data.id, data.razon_social || '?', data.cuit || null, data.telefono || null,
       data.email || null, data.contacto_nombre || null, data.condicion_pago || null,
       data.tipo_proveedor || 'mercaderia', data.alias || null,
       data.condicion_iva || null, data.agente_retencion_iva ? 1 : 0,
       data.agente_retencion_iibb ? 1 : 0, data.condicion_compra || null,
       data.order_day ?? null, data.activo !== false ? 1 : 0, data.updated_at || null]
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
         activo, fecha_alta, iva, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
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
       data.activo !== false ? 1 : 0, data.fecha_alta || null, data.iva || null, data.updated_at || null]
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

    for (const s of (data.producto_sustitutos || [])) {
      try {
        window.SGA_DB.run(`
          INSERT OR REPLACE INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
          VALUES (?,?,?,?,?)`,
          [data.id, s.sustituto_id, s.referencia_id, s.activo ? 1 : 0, s.fecha_asignacion || null]
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

  function applyMedioCobroFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO medios_cobro (id, nombre, icono, activo, orden, sync_status, updated_at)
      VALUES (?,?,?,?,?,'synced',?)`,
      [data.id, data.nombre || '?', data.icono || '', data.activo !== false ? 1 : 0,
       data.orden || 0, data.updated_at || null]
    );
  }

  function applySucursalFull(data) {
    window.SGA_DB.run(`
      INSERT OR REPLACE INTO sucursales (id, nombre, direccion, activa, sync_status, updated_at)
      VALUES (?,?,?,?,'synced',?)`,
      [data.id, data.nombre || '?', data.direccion || null,
       data.activa !== false ? 1 : 0, data.updated_at || null]
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
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
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
      { name: 'usuarios',          applyFn: applyUsuarioFull },
      { name: 'producto_codigo_proveedor', applyFn: applyCodigoProveedorFull },
      { name: 'sesiones_caja',     applyFn: applySesionCajaFull },
      { name: 'egresos_caja',      applyFn: applyEgresoCajaFull },
      { name: 'ventas',            applyFn: applyVentaFull },
      { name: 'compras',           applyFn: applyCompra },
      { name: 'ordenes_compra',    applyFn: applyOrdenCompra },
      { name: 'pagos_proveedores', applyFn: applyPagoProveedor },
      { name: 'gastos',            applyFn: applyGasto },
      { name: 'productos',         applyFn: applyProductoFull },
      { name: 'clientes',          applyFn: applyClienteFull },
      { name: 'proveedores',       applyFn: applyProveedorFull },
      { name: 'stock',             applyFn: applyStockFull },
      { name: 'promociones',       applyFn: applyPromocion },
      { name: 'caja_admin',        applyFn: applyCajaAdmin },
      { name: 'consumo_interno',   applyFn: applyConsumoInternoFull },
      { name: 'ingresos_caja',     applyFn: applyIngresoCaja },
      { name: 'cuenta_corriente',  applyFn: applyCuentaCorriente },
    ];

    const lastSync = localStorage.getItem('admin_monitor_sync_at');
    let total = 0;

    for (const { name, applyFn } of MONITOR_SOURCES) {
      try {
        let cursor = lastSync;
        if (!cursor) {
          // Primera vez: últimos 90 días
          const desde = new Date();
          desde.setDate(desde.getDate() - 90);
          cursor = desde.toISOString();
        }

        // Paginar con cursor real (orderBy + avanzar al último _synced_at visto) en
        // vez de un solo limit(): un lote grande (ej. importación masiva en POS)
        // puede superar los 200/500 de una sola tanda. Si no se agota acá, al mover
        // el cursor a "ahora" al final, lo que quedó afuera del batch se perdería
        // para siempre (nunca vuelve a matchear un futuro '> cursor').
        let batchSize;
        do {
          const snap = await firestoreDb.collection(name)
            .where('_synced_at', '>', cursor)
            .orderBy('_synced_at')
            .limit(200)
            .get();

          batchSize = snap.size;
          if (batchSize === 0) break;

          for (const doc of snap.docs) {
            try { applyFn(doc.data()); total++; }
            catch (err) { console.warn(`Monitor apply error (${name}):`, err.message); }
          }
          cursor = snap.docs[snap.docs.length - 1].data()._synced_at;
        } while (batchSize >= 200);
      } catch (err) {
        console.warn(`Monitor sync skip (${name}):`, err.message);
      }
    }

    localStorage.setItem('admin_monitor_sync_at', new Date().toISOString());
    if (total > 0) console.log(`📡 Monitor sync: ${total} registros actualizados`);

    // Cerrar sesiones fantasma: abiertas localmente sin ventas, cuando otra sesión abierta sí tiene ventas
    closeOrphanSessions();

    return total;
  }

  function closeOrphanSessions() {
    if (!window.SGA_DB) return;
    try {
      // Si hay múltiples sesiones abiertas, cerrar las que no tienen ventas
      const openSessions = window.SGA_DB.query(
        `SELECT id FROM sesiones_caja WHERE estado = 'abierta'`
      );
      if (openSessions.length <= 1) return;

      // Sesiones abiertas con al menos una venta
      const withVentas = window.SGA_DB.query(
        `SELECT DISTINCT sesion_caja_id AS id FROM ventas
         WHERE sesion_caja_id IN (SELECT id FROM sesiones_caja WHERE estado = 'abierta')`
      );
      if (withVentas.length === 0) return;

      const keepIds = new Set(withVentas.map(r => r.id));
      const toClose = openSessions.filter(r => !keepIds.has(r.id));
      for (const { id } of toClose) {
        window.SGA_DB.run(
          `UPDATE sesiones_caja SET estado = 'cerrada' WHERE id = ?`, [id]
        );
        console.log(`🧹 Sesión fantasma cerrada en admin-pos: ${id}`);
      }
    } catch (e) {
      console.warn('closeOrphanSessions error:', e.message);
    }
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
      { name: 'usuarios',          applyFn: applyUsuarioFull,      label: 'Usuarios' },
      { name: 'producto_codigo_proveedor', applyFn: applyCodigoProveedorFull, label: 'Matcheo códigos proveedor' },
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
      { name: 'caja_admin',        applyFn: applyCajaAdmin,        label: 'Caja Seamus' },
      { name: 'consumo_interno',   applyFn: applyConsumoInternoFull, label: 'Consumo interno' },
      { name: 'ingresos_caja',     applyFn: applyIngresoCaja,      label: 'Ingresos de caja' },
      { name: 'cuenta_corriente',  applyFn: applyCuentaCorriente,  label: 'Cuenta corriente' },
      { name: 'medios_cobro',      applyFn: applyMedioCobroFull,   label: 'Medios de pago' },
      { name: 'sucursales',        applyFn: applySucursalFull,     label: 'Cajas' },
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

    closeOrphanSessions();
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

  // ─── Borrado remoto (herramienta de limpieza pre-migración) ───────────────────
  // No existía ningún borrado en Firestore hasta acá — solo lectura (pull) y
  // escritura (push/merge). Se usa una única vez para vaciar la nube de datos
  // de prueba antes de migrar el catálogo real. Excluye las colecciones que
  // deben conservarse (usuarios, cajas, medios de pago, proveedores).
  const WIPE_PRESERVE_COLLECTIONS = ['usuarios', 'sucursales', 'medios_cobro', 'proveedores'];

  async function wipeFirestoreCollections(onProgress) {
    if (!initialized || !firestoreDb) throw new Error('Firebase no conectado');

    const collections = [...new Set(SYNC_SOURCES.map(s => s.collection))]
      .filter(c => !WIPE_PRESERVE_COLLECTIONS.includes(c));

    let total = 0;
    for (const name of collections) {
      let batchSize;
      do {
        const snap = await firestoreDb.collection(name).limit(400).get();
        batchSize = snap.size;
        if (batchSize === 0) break;
        const batch = firestoreDb.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        total += batchSize;
        onProgress?.(name, total);
      } while (batchSize >= 400);
    }
    return total;
  }

  // ─── API pública ─────────────────────────────────────────────────────────────

  window.SGA_Sync = {
    initialize,
    syncNow,
    pushPending,
    pushToPos,
    initialSyncFromFirestore,
    syncMonitoringData,
    wipeFirestoreCollections,
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
