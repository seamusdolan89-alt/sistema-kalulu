/**
 * db.js — Database Layer (SQLite via sql.js + OPFS)
 * 
 * Provides:
 * - SQLite initialization via sql.js CDN with OPFS persistence
 * - LocalStorage fallback if OPFS not available
 * - Table creation and schema initialization
 * - Query and run methods for database operations
 */

(function() {
  'use strict';

  let SQL = null; // sql.js module
  let database = null; // SQLite database instance
  let fileHandle = null; // OPFS file handle

  const db = {
    isInitialized: false,
    usingOPFS: false,
    useFeature: 'opfs', // 'opfs' or 'localstorage'
  };

  /**
   * Load sql.js library from CDN
   */
  async function loadSQL() {
    if (SQL) return SQL;
    
    try {
      // Load sql.js from CDN via dynamic script
      window.SQL = await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js';
        script.onload = async () => {
          try {
            const sqlJs = await window.initSqlJs({
              locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
            });
            resolve(sqlJs);
          } catch (e) {
            reject(e);
          }
        };
        script.onerror = reject;
        document.head.appendChild(script);
      });
      
      SQL = window.SQL;
      console.log('✅ sql.js loaded from CDN');
      return SQL;
    } catch (error) {
      console.error('Failed to load sql.js:', error);
      throw error;
    }
  }

  /**
   * Try to initialize with OPFS, fall back to localStorage
   */
  async function initializeStorage() {
    try {
      // Check if OPFS is available
      if (!navigator.storage || !navigator.storage.getDirectory) {
        console.warn('⚠️ OPFS not available, using localStorage');
        db.useFeature = 'localstorage';
        return;
      }

      // Try to use OPFS
      const root = await navigator.storage.getDirectory();
      fileHandle = await root.getFileHandle('sga.db', { create: true });
      db.usingOPFS = true;
      console.log('✅ OPFS storage initialized');
    } catch (error) {
      console.warn('⚠️ OPFS not available, using localStorage:', error);
      db.useFeature = 'localstorage';
    }
  }

  /**
   * Load database from storage
   */
  async function loadDatabase() {
    try {
      if (db.usingOPFS && fileHandle) {
        const file = await fileHandle.getFile();
        const arrayBuffer = await file.arrayBuffer();
        if (arrayBuffer.byteLength > 0) {
          database = new SQL.Database(new Uint8Array(arrayBuffer));
          console.log('📥 Database loaded from OPFS');
          return;
        }
      }

      // Fall back to localStorage
      const stored = localStorage.getItem('sga_db');
      if (stored) {
        const bytes = JSON.parse(stored);
        database = new SQL.Database(new Uint8Array(bytes));
        console.log('📥 Database loaded from localStorage');
        return;
      }

      // Create new database
      database = new SQL.Database();
      console.log('📦 New database created');
    } catch (error) {
      console.error('Failed to load database:', error);
      throw error;
    }
  }

  /**
   * Save database to storage
   */
  async function saveDatabase() {
    if (!database) return;

    try {
      const data = database.export();
      const bytes = Array.from(data);

      if (db.usingOPFS && fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(new Uint8Array(bytes));
        await writable.close();
      } else {
        localStorage.setItem('sga_db', JSON.stringify(bytes));
      }
    } catch (error) {
      console.error('Failed to save database:', error);
    }
  }

  /**
   * Initialize database connection and create tables
   * 
   * @returns {Promise<void>}
   */
  async function initialize() {
    if (db.isInitialized) return;

    console.log('🔄 Initializing database...');
    
    try {
      // Load sql.js
      await loadSQL();
      
      // Initialize storage
      await initializeStorage();
      
      // Load or create database
      await loadDatabase();
      
      // Create tables
      await createTables();
      
      db.isInitialized = true;
      console.log('✅ Database initialized');
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
      throw error;
    }
  }

  /**
   * Create all tables in SQLite
   */
  async function createTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS sucursales (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        direccion TEXT,
        activa INTEGER DEFAULT 1,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS usuarios (
        id TEXT PRIMARY KEY,
        firebase_uid TEXT UNIQUE,
        nombre TEXT NOT NULL,
        rol TEXT NOT NULL CHECK(rol IN ('admin','encargado','cajero')),
        sucursal_id TEXT REFERENCES sucursales(id),
        activo INTEGER DEFAULT 1,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS categorias (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        comision_pct REAL DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS proveedores (
        id TEXT PRIMARY KEY,
        razon_social TEXT NOT NULL,
        cuit TEXT,
        telefono TEXT,
        email TEXT,
        contacto_nombre TEXT,
        condicion_pago TEXT,
        activo INTEGER DEFAULT 1,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS productos (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        categoria_id TEXT REFERENCES categorias(id),
        proveedor_principal_id TEXT REFERENCES proveedores(id),
        proveedor_alternativo_id TEXT REFERENCES proveedores(id),
        producto_madre_id TEXT REFERENCES productos(id),
        es_madre INTEGER DEFAULT 0,
        precio_independiente INTEGER DEFAULT 0,
        costo REAL NOT NULL DEFAULT 0,
        precio_venta REAL NOT NULL DEFAULT 0,
        comision_pct_override REAL,
        unidad_medida TEXT DEFAULT 'unidad',
        stock_minimo REAL DEFAULT 0,
        stock_alerta REAL DEFAULT 0,
        cant_pedido REAL DEFAULT 0,
        pedido_unidad TEXT DEFAULT 'unidad',
        unidad_compra TEXT DEFAULT 'Unidad',
        unidades_por_paquete_compra REAL DEFAULT 1,
        unidad_venta TEXT DEFAULT 'Unidad',
        costo_paquete REAL DEFAULT 0,
        precio_lista_por TEXT DEFAULT 'Por unidad de compra',
        precio_lista_divisor REAL DEFAULT 1,
        hereda_costo INTEGER DEFAULT 1,
        hereda_precio INTEGER DEFAULT 1,
        es_oferta INTEGER DEFAULT 0,
        oferta_desde TEXT,
        oferta_hasta TEXT,
        imagen TEXT,
        activo INTEGER DEFAULT 1,
        fecha_alta TEXT,
        fecha_modificacion TEXT,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS codigos_barras (
        id TEXT PRIMARY KEY,
        producto_id TEXT NOT NULL REFERENCES productos(id),
        codigo TEXT NOT NULL UNIQUE,
        es_principal INTEGER DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS producto_sustitutos (
        producto_id TEXT REFERENCES productos(id),
        sustituto_id TEXT REFERENCES productos(id),
        referencia_id TEXT REFERENCES productos(id),
        activo INTEGER DEFAULT 1,
        fecha_asignacion TEXT,
        PRIMARY KEY (producto_id, sustituto_id)
      )`,

      `CREATE TABLE IF NOT EXISTS stock (
        producto_id TEXT REFERENCES productos(id),
        sucursal_id TEXT REFERENCES sucursales(id),
        cantidad REAL DEFAULT 0,
        fecha_modificacion TEXT,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT,
        PRIMARY KEY (producto_id, sucursal_id)
      )`,

      `CREATE TABLE IF NOT EXISTS clientes (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        apellido TEXT,
        telefono TEXT,
        email TEXT,
        dni TEXT,
        fecha_alta TEXT,
        activo INTEGER DEFAULT 1,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS cuenta_corriente (
        id TEXT PRIMARY KEY,
        cliente_id TEXT NOT NULL REFERENCES clientes(id),
        sucursal_id TEXT REFERENCES sucursales(id),
        tipo TEXT NOT NULL CHECK(tipo IN ('venta_fiada','pago','saldo_favor','ajuste')),
        monto REAL NOT NULL,
        venta_id TEXT,
        descripcion TEXT,
        fecha TEXT NOT NULL,
        usuario_id TEXT REFERENCES usuarios(id),
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS sesiones_caja (
        id TEXT PRIMARY KEY,
        sucursal_id TEXT REFERENCES sucursales(id),
        usuario_apertura_id TEXT REFERENCES usuarios(id),
        usuario_cierre_id TEXT REFERENCES usuarios(id),
        fecha_apertura TEXT,
        fecha_cierre TEXT,
        saldo_inicial REAL DEFAULT 0,
        total_efectivo REAL DEFAULT 0,
        total_mercadopago REAL DEFAULT 0,
        total_tarjeta REAL DEFAULT 0,
        total_transferencia REAL DEFAULT 0,
        total_cuenta_corriente REAL DEFAULT 0,
        total_egresos REAL DEFAULT 0,
        saldo_final_esperado REAL DEFAULT 0,
        saldo_final_real REAL,
        diferencia REAL,
        detalle_billetes TEXT,
        estado TEXT DEFAULT 'abierta' CHECK(estado IN ('abierta','cerrada')),
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS egresos_caja (
        id TEXT PRIMARY KEY,
        sesion_caja_id TEXT REFERENCES sesiones_caja(id),
        monto REAL NOT NULL,
        descripcion TEXT,
        fecha TEXT,
        usuario_id TEXT REFERENCES usuarios(id)
      )`,

      `CREATE TABLE IF NOT EXISTS ventas (
        id TEXT PRIMARY KEY,
        sucursal_id TEXT REFERENCES sucursales(id),
        sesion_caja_id TEXT REFERENCES sesiones_caja(id),
        cliente_id TEXT REFERENCES clientes(id),
        usuario_id TEXT REFERENCES usuarios(id),
        fecha TEXT NOT NULL,
        subtotal REAL,
        descuento REAL DEFAULT 0,
        total REAL,
        estado TEXT DEFAULT 'completada',
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS venta_items (
        id TEXT PRIMARY KEY,
        venta_id TEXT REFERENCES ventas(id),
        producto_id TEXT REFERENCES productos(id),
        cantidad REAL,
        precio_unitario REAL,
        costo_unitario REAL,
        descuento_item REAL DEFAULT 0,
        subtotal REAL,
        comision_pct REAL DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS venta_pagos (
        id TEXT PRIMARY KEY,
        venta_id TEXT REFERENCES ventas(id),
        medio TEXT NOT NULL CHECK(medio IN ('efectivo','mercadopago','tarjeta','transferencia','cuenta_corriente')),
        monto REAL NOT NULL,
        referencia TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS compras (
        id TEXT PRIMARY KEY,
        sucursal_id TEXT REFERENCES sucursales(id),
        proveedor_id TEXT REFERENCES proveedores(id),
        usuario_id TEXT REFERENCES usuarios(id),
        fecha TEXT,
        numero_factura TEXT,
        total REAL,
        imagen_path TEXT,
        procesado_por TEXT CHECK(procesado_por IN ('template_offline','claude_api')),
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS compra_items (
        id TEXT PRIMARY KEY,
        compra_id TEXT REFERENCES compras(id),
        producto_id TEXT REFERENCES productos(id),
        cantidad REAL,
        costo_unitario REAL,
        costo_anterior REAL,
        subtotal REAL,
        costo_modificado INTEGER DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS ordenes_compra (
        id TEXT PRIMARY KEY,
        sucursal_id TEXT REFERENCES sucursales(id),
        proveedor_id TEXT REFERENCES proveedores(id),
        usuario_id TEXT REFERENCES usuarios(id),
        fecha_creacion TEXT,
        fecha_entrega TEXT,
        estado TEXT DEFAULT 'borrador' CHECK(estado IN ('borrador','enviada','recibiendo','recibida_parcial','cerrada','pendiente_pago')),
        notas TEXT,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS orden_compra_items (
        id TEXT PRIMARY KEY,
        orden_id TEXT REFERENCES ordenes_compra(id),
        producto_id TEXT REFERENCES productos(id),
        cantidad_pedida REAL,
        cantidad_recibida REAL DEFAULT 0,
        estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','recibido','recibido_parcial','no_entregado'))
      )`,

      `CREATE TABLE IF NOT EXISTS promociones (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        tipo TEXT CHECK(tipo IN ('combo','descuento_cantidad','descuento_monto')),
        descripcion TEXT,
        fecha_desde TEXT,
        fecha_hasta TEXT,
        activa INTEGER DEFAULT 1,
        aplica_a TEXT,
        valor_descuento REAL,
        tipo_descuento TEXT CHECK(tipo_descuento IN ('porcentaje','monto_fijo')),
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS promocion_items (
        promocion_id TEXT REFERENCES promociones(id),
        producto_id TEXT REFERENCES productos(id),
        cantidad_requerida REAL DEFAULT 1,
        PRIMARY KEY (promocion_id, producto_id)
      )`,

      `CREATE TABLE IF NOT EXISTS pedidos_abiertos (
        id TEXT PRIMARY KEY,
        sucursal_id TEXT REFERENCES sucursales(id),
        usuario_id TEXT REFERENCES usuarios(id),
        cliente_id TEXT REFERENCES clientes(id),
        items TEXT NOT NULL,
        total REAL NOT NULL,
        fecha TEXT NOT NULL,
        nombre TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS devoluciones (
        id TEXT PRIMARY KEY,
        venta_id TEXT REFERENCES ventas(id),
        sucursal_id TEXT REFERENCES sucursales(id),
        usuario_id TEXT REFERENCES usuarios(id),
        fecha TEXT NOT NULL,
        motivo TEXT,
        sync_status TEXT DEFAULT 'pending',
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS devolucion_items (
        id TEXT PRIMARY KEY,
        devolucion_id TEXT REFERENCES devoluciones(id),
        producto_id TEXT REFERENCES productos(id),
        cantidad REAL NOT NULL,
        precio_unitario REAL NOT NULL
      )`,
    ];

    for (const sql of tables) {
      try {
        database.run(sql);
      } catch (error) {
        console.warn('Table already exists:', error.message.substring(0, 50));
      }
    }

    // stock_ajustes — manual stock movements ledger
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS stock_ajustes (
          id TEXT PRIMARY KEY,
          producto_id TEXT REFERENCES productos(id),
          sucursal_id TEXT REFERENCES sucursales(id),
          tipo TEXT CHECK(tipo IN ('ajuste_positivo','ajuste_negativo','consumo_interno','rotura')),
          cantidad REAL,
          motivo TEXT,
          usuario_id TEXT,
          fecha TEXT,
          sync_status TEXT DEFAULT 'pending',
          updated_at TEXT
        )
      `);
    } catch(e) { console.warn('stock_ajustes:', e.message); }

    // stock_ajustes — add approval columns for pending devolucion adjustments
    const stockAjustesMigrations = [
      `ALTER TABLE stock_ajustes ADD COLUMN estado TEXT DEFAULT 'aprobado'`,
      `ALTER TABLE stock_ajustes ADD COLUMN aprobado_por TEXT`,
      `ALTER TABLE stock_ajustes ADD COLUMN fecha_aprobacion TEXT`,
    ];
    for (const sql of stockAjustesMigrations) {
      try { database.run(sql); } catch(e) { /* column already exists */ }
    }

    // devoluciones — add reintegro_tipo column
    try {
      database.run(`ALTER TABLE devoluciones ADD COLUMN reintegro_tipo TEXT`);
    } catch(e) { /* column already exists */ }

    // ingresos_caja — extra cash received during a session
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS ingresos_caja (
          id TEXT PRIMARY KEY,
          sesion_caja_id TEXT REFERENCES sesiones_caja(id),
          monto REAL NOT NULL,
          descripcion TEXT,
          fecha TEXT,
          usuario_id TEXT REFERENCES usuarios(id),
          sync_status TEXT DEFAULT 'pending',
          updated_at TEXT
        )
      `);
    } catch(e) { console.warn('ingresos_caja:', e.message); }

    // Migrate ordenes_compra: expand estado constraint (add 'recibiendo','pendiente_pago')
    try {
      const schemaStmt = database.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='ordenes_compra'`
      );
      let schemaRow = null;
      if (schemaStmt.step()) schemaRow = schemaStmt.getAsObject();
      schemaStmt.free();
      if (schemaRow && schemaRow.sql && !schemaRow.sql.includes('recibiendo')) {
        database.run(`ALTER TABLE ordenes_compra RENAME TO ordenes_compra_bak`);
        database.run(`CREATE TABLE ordenes_compra (
          id TEXT PRIMARY KEY,
          sucursal_id TEXT REFERENCES sucursales(id),
          proveedor_id TEXT REFERENCES proveedores(id),
          usuario_id TEXT REFERENCES usuarios(id),
          fecha_creacion TEXT,
          fecha_entrega TEXT,
          estado TEXT DEFAULT 'borrador' CHECK(estado IN ('borrador','enviada','recibiendo','recibida_parcial','cerrada','pendiente_pago')),
          notas TEXT,
          sync_status TEXT DEFAULT 'pending',
          updated_at TEXT
        )`);
        database.run(`INSERT INTO ordenes_compra
          SELECT id,sucursal_id,proveedor_id,usuario_id,fecha_creacion,fecha_entrega,estado,notas,sync_status,updated_at
          FROM ordenes_compra_bak`);
        database.run(`DROP TABLE ordenes_compra_bak`);
      }
    } catch(e) { console.warn('ordenes_compra migration:', e.message); }

    // Migrate ordenes_compra: add 'revisada' and 'confirmada' to estado CHECK + new timestamp columns
    try {
      const ocStmt2 = database.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='ordenes_compra'`
      );
      let ocRow2 = null;
      if (ocStmt2.step()) ocRow2 = ocStmt2.getAsObject();
      ocStmt2.free();
      if (ocRow2 && ocRow2.sql && !ocRow2.sql.includes('revisada')) {
        database.run(`ALTER TABLE ordenes_compra RENAME TO ordenes_compra_bak2`);
        database.run(`CREATE TABLE ordenes_compra (
          id TEXT PRIMARY KEY,
          sucursal_id TEXT REFERENCES sucursales(id),
          proveedor_id TEXT REFERENCES proveedores(id),
          usuario_id TEXT REFERENCES usuarios(id),
          fecha_creacion TEXT,
          fecha_entrega TEXT,
          estado TEXT DEFAULT 'borrador' CHECK(estado IN ('borrador','revisada','confirmada','enviada','recibiendo','recibida_parcial','cerrada','pendiente_pago')),
          notas TEXT,
          revisada_en TEXT,
          confirmada_en TEXT,
          sync_status TEXT DEFAULT 'pending',
          updated_at TEXT
        )`);
        database.run(`INSERT INTO ordenes_compra
          (id,sucursal_id,proveedor_id,usuario_id,fecha_creacion,fecha_entrega,estado,notas,sync_status,updated_at)
          SELECT id,sucursal_id,proveedor_id,usuario_id,fecha_creacion,fecha_entrega,estado,notas,sync_status,updated_at
          FROM ordenes_compra_bak2`);
        database.run(`DROP TABLE ordenes_compra_bak2`);
      }
    } catch(e) { console.warn('ordenes_compra revisada migration:', e.message); }

    // Migrate venta_pagos: add 'saldo_favor' to medio CHECK constraint
    try {
      const vpStmt = database.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='venta_pagos'`
      );
      let vpRow = null;
      if (vpStmt.step()) vpRow = vpStmt.getAsObject();
      vpStmt.free();
      if (vpRow && vpRow.sql && !vpRow.sql.includes('saldo_favor')) {
        database.run(`ALTER TABLE venta_pagos RENAME TO venta_pagos_bak`);
        database.run(`CREATE TABLE venta_pagos (
          id TEXT PRIMARY KEY,
          venta_id TEXT REFERENCES ventas(id),
          medio TEXT NOT NULL CHECK(medio IN ('efectivo','mercadopago','tarjeta','transferencia','cuenta_corriente','saldo_favor')),
          monto REAL NOT NULL,
          referencia TEXT
        )`);
        database.run(`INSERT INTO venta_pagos SELECT * FROM venta_pagos_bak`);
        database.run(`DROP TABLE venta_pagos_bak`);
      }
    } catch(e) { console.warn('venta_pagos migration:', e.message); }

    // system_config — key/value store for app-wide settings
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS system_config (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TEXT
        )
      `);
      database.run(`INSERT OR IGNORE INTO system_config VALUES ('tope_deuda_default', '50000', datetime('now'))`);
    } catch(e) { console.warn('system_config:', e.message); }

    // cuenta_proveedor — accounts payable ledger per supplier
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS cuenta_proveedor (
          id TEXT PRIMARY KEY,
          proveedor_id TEXT REFERENCES proveedores(id),
          orden_id TEXT REFERENCES ordenes_compra(id),
          tipo TEXT CHECK(tipo IN ('deuda','pago','ajuste')),
          monto REAL,
          descripcion TEXT,
          fecha TEXT,
          usuario_id TEXT,
          sync_status TEXT DEFAULT 'pending',
          updated_at TEXT
        )
      `);
    } catch(e) { console.warn('cuenta_proveedor:', e.message); }

    // Add new columns to existing databases (safe: fails silently if column exists)
    const columnAlterations = [
      'ALTER TABLE productos ADD COLUMN stock_alerta REAL DEFAULT 0',
      'ALTER TABLE productos ADD COLUMN cant_pedido REAL DEFAULT 0',
      "ALTER TABLE productos ADD COLUMN pedido_unidad TEXT DEFAULT 'unidad'",
      'ALTER TABLE productos ADD COLUMN hereda_costo INTEGER DEFAULT 1',
      'ALTER TABLE productos ADD COLUMN hereda_precio INTEGER DEFAULT 1',
      'ALTER TABLE productos ADD COLUMN imagen TEXT',
      'ALTER TABLE sesiones_caja ADD COLUMN cierre_automatico INTEGER DEFAULT 0',
      'ALTER TABLE egresos_caja ADD COLUMN tipo TEXT',
      "ALTER TABLE egresos_caja ADD COLUMN sync_status TEXT DEFAULT 'pending'",
      'ALTER TABLE egresos_caja ADD COLUMN updated_at TEXT',
      'ALTER TABLE orden_compra_items ADD COLUMN costo_unitario REAL DEFAULT 0',
      'ALTER TABLE orden_compra_items ADD COLUMN costo_anterior REAL DEFAULT 0',
      'ALTER TABLE clientes ADD COLUMN direccion TEXT',
      'ALTER TABLE clientes ADD COLUMN lote TEXT',
      'ALTER TABLE clientes ADD COLUMN tope_deuda REAL DEFAULT 50000',
      'ALTER TABLE clientes ADD COLUMN cliente_master_id TEXT',
      'ALTER TABLE clientes ADD COLUMN es_master INTEGER DEFAULT 0',
      'ALTER TABLE clientes ADD COLUMN ultima_visita TEXT',
      'ALTER TABLE productos ADD COLUMN pedido_unidades_por_paquete REAL DEFAULT NULL',
      // Fix: compras_v2 uses these columns that were missing from the original schema
      "ALTER TABLE compras ADD COLUMN condicion_pago TEXT",
      "ALTER TABLE compras ADD COLUMN estado TEXT DEFAULT 'confirmada'",
      "ALTER TABLE compras ADD COLUMN factura_pv TEXT",
      "ALTER TABLE compra_items ADD COLUMN unidad_compra TEXT DEFAULT 'Unidad'",
      "ALTER TABLE compra_items ADD COLUMN unidades_por_paquete REAL DEFAULT 1",
      // Fix: compras_v2 inserts compra_id into cuenta_proveedor which was missing
      "ALTER TABLE cuenta_proveedor ADD COLUMN compra_id TEXT REFERENCES compras(id)",
      // Fix: egresos_caja needs proveedor_id for pagos adelantados
      "ALTER TABLE egresos_caja ADD COLUMN proveedor_id TEXT REFERENCES proveedores(id)",
      // Ordenes de compra — nuevo módulo
      "ALTER TABLE proveedores ADD COLUMN order_day INTEGER DEFAULT NULL",
      "ALTER TABLE ordenes_compra ADD COLUMN revisada_en TEXT",
      "ALTER TABLE ordenes_compra ADD COLUMN confirmada_en TEXT",
      // orden_compra_items — columnas para el nuevo flujo de sugerencia
      "ALTER TABLE orden_compra_items ADD COLUMN codigo_proveedor TEXT",
      "ALTER TABLE orden_compra_items ADD COLUMN stock_actual REAL",
      "ALTER TABLE orden_compra_items ADD COLUMN stock_minimo REAL",
      "ALTER TABLE orden_compra_items ADD COLUMN cantidad_deseada REAL",
      "ALTER TABLE orden_compra_items ADD COLUMN ventas_30d REAL DEFAULT 0",
      "ALTER TABLE orden_compra_items ADD COLUMN ventas_prom_6m REAL DEFAULT 0",
      "ALTER TABLE orden_compra_items ADD COLUMN dias_sin_stock_6m INTEGER DEFAULT 0",
      "ALTER TABLE orden_compra_items ADD COLUMN cantidad_sugerida REAL",
      "ALTER TABLE orden_compra_items ADD COLUMN cantidad_final REAL",
      "ALTER TABLE orden_compra_items ADD COLUMN unidad_pedida TEXT DEFAULT 'unidad'",
    ];
    for (const sql of columnAlterations) {
      try { database.run(sql); } catch(e) { /* column already exists */ }
    }

    // ── historial_stock — snapshot of stock per product+branch after every change ─
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS historial_stock (
          id TEXT PRIMARY KEY,
          producto_id TEXT NOT NULL REFERENCES productos(id),
          sucursal_id TEXT NOT NULL REFERENCES sucursales(id),
          stock_valor REAL NOT NULL,
          registrado_en TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      database.run(`
        CREATE INDEX IF NOT EXISTS idx_historial_stock
          ON historial_stock(producto_id, sucursal_id, registrado_en)
      `);
    } catch(e) { console.warn('historial_stock:', e.message); }

    // ── Cuenta Corriente Proveedores ──────────────────────────────────────────
    // pagos_proveedores: payment header (who, when, notes)
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS pagos_proveedores (
          id TEXT PRIMARY KEY,
          proveedor_id TEXT NOT NULL REFERENCES proveedores(id),
          fecha TEXT NOT NULL,
          observaciones TEXT,
          usuario_id TEXT REFERENCES usuarios(id),
          sync_status TEXT DEFAULT 'pending',
          updated_at TEXT
        )
      `);
    } catch(e) { console.warn('pagos_proveedores:', e.message); }

    // pagos_proveedores_metodos: breakdown by payment method (one payment can have multiple)
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS pagos_proveedores_metodos (
          id TEXT PRIMARY KEY,
          pago_id TEXT NOT NULL REFERENCES pagos_proveedores(id),
          metodo TEXT NOT NULL CHECK(metodo IN ('efectivo','transferencia')),
          monto REAL NOT NULL,
          referencia TEXT,
          sesion_caja_id TEXT REFERENCES sesiones_caja(id)
        )
      `);
    } catch(e) { console.warn('pagos_proveedores_metodos:', e.message); }

    // imputaciones_pagos: links a payment (or portion) to a specific compra
    // compra_id NULL means the credit is "orphan" (paid in advance, not yet matched)
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS imputaciones_pagos (
          id TEXT PRIMARY KEY,
          pago_id TEXT NOT NULL REFERENCES pagos_proveedores(id),
          compra_id TEXT REFERENCES compras(id),
          monto_imputado REAL NOT NULL,
          fecha TEXT NOT NULL
        )
      `);
    } catch(e) { console.warn('imputaciones_pagos:', e.message); }

    // ── Usuarios — autenticación local (username + password_hash) ─────────────
    const usuariosMigrations = [
      `ALTER TABLE usuarios ADD COLUMN username TEXT`,
      `ALTER TABLE usuarios ADD COLUMN password_hash TEXT`,
    ];
    for (const sql of usuariosMigrations) {
      try { database.run(sql); } catch(e) { /* column already exists */ }
    }

    // Migración: poblar username para usuarios legacy (creados sin username)
    // Usamos database.prepare() directamente (query() exige isInitialized=true, que aún es false aquí)
    try {
      database.run(
        `UPDATE usuarios SET username = 'admin' WHERE (username IS NULL OR username = '') AND firebase_uid = 'dev-admin'`
      );
      // Para cualquier otro usuario sin username, generar uno desde el nombre
      const stmtSinUser = database.prepare(
        `SELECT id, nombre FROM usuarios WHERE username IS NULL OR username = ''`
      );
      const sinUsername = [];
      while (stmtSinUser.step()) sinUsername.push(stmtSinUser.getAsObject());
      stmtSinUser.free();

      for (const u of sinUsername) {
        const generated = (u.nombre || 'usuario')
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
        database.run(
          `UPDATE usuarios SET username = ? WHERE id = ?`,
          [generated || u.id.slice(0, 8), u.id]
        );
      }
    } catch(e) { console.warn('username migration:', e.message); }

    // Migración: asignar contraseña por defecto ('kalulu123') a usuarios sin password_hash
    try {
      const stmtSinPass = database.prepare(
        `SELECT id FROM usuarios WHERE password_hash IS NULL OR password_hash = ''`
      );
      const sinPass = [];
      while (stmtSinPass.step()) sinPass.push(stmtSinPass.getAsObject());
      stmtSinPass.free();

      if (sinPass.length > 0) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kalulu123'));
        const defaultHash = Array.from(new Uint8Array(buf))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        for (const u of sinPass) {
          database.run(
            `UPDATE usuarios SET password_hash = ? WHERE id = ?`,
            [defaultHash, u.id]
          );
        }
        console.log(`🔑 ${sinPass.length} usuario(s) sin contraseña recibieron la clave por defecto: kalulu123`);
      }
    } catch(e) { console.warn('password_hash migration:', e.message); }

    // ── Consumo Interno — tabla dedicada para mayor trazabilidad ──────────────
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS consumo_interno (
          id TEXT PRIMARY KEY,
          producto_id TEXT NOT NULL REFERENCES productos(id),
          sucursal_id TEXT REFERENCES sucursales(id),
          usuario_id TEXT NOT NULL REFERENCES usuarios(id),
          cantidad REAL NOT NULL,
          costo_unitario REAL DEFAULT 0,
          motivo TEXT,
          observaciones TEXT,
          fecha TEXT NOT NULL,
          sync_status TEXT DEFAULT 'pending',
          updated_at TEXT
        )
      `);
    } catch(e) { console.warn('consumo_interno:', e.message); }

    await saveDatabase();
    console.log('✅ All tables created');
  }

  /**
   * Execute a SELECT query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Array} Array of row objects
   */
  function query(sql, params = []) {
    if (!db.isInitialized || !database) {
      throw new Error('Database not initialized');
    }

    try {
      const stmt = database.prepare(sql);
      stmt.bind(params);
      
      const result = [];
      while (stmt.step()) {
        result.push(stmt.getAsObject());
      }
      stmt.free();
      return result;
    } catch (error) {
      console.error('Query error:', error, sql);
      return [];
    }
  }

  /**
   * Execute an INSERT/UPDATE/DELETE statement
   * @param {string} sql - SQL statement
   * @param {Array} params - Statement parameters
   * @returns {Object} {lastID, changes}
   */
  let batchMode = false;

  function run(sql, params = []) {
    if (!db.isInitialized || !database) {
      throw new Error('Database not initialized');
    }

    try {
      const stmt = database.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();

      if (!batchMode) saveDatabase();

      return {
        lastID: null,
        changes: 1
      };
    } catch (error) {
      console.error('Run error:', error, sql);
      return { lastID: null, changes: 0 };
    }
  }

  /**
   * Insert a snapshot of the current stock into historial_stock.
   * Call this immediately after any UPDATE/INSERT to the `stock` table.
   * @param {string} productoId
   * @param {string} sucursalId
   */
  function registrarHistorialStock(productoId, sucursalId) {
    try {
      const rows = query(
        'SELECT cantidad FROM stock WHERE producto_id = ? AND sucursal_id = ?',
        [productoId, sucursalId]
      );
      if (!rows.length) return;
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      run(
        `INSERT INTO historial_stock (id, producto_id, sucursal_id, stock_valor, registrado_en)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [id, productoId, sucursalId, rows[0].cantidad]
      );
    } catch(e) {
      console.warn('registrarHistorialStock error:', e.message);
    }
  }

  /**
   * Count distinct calendar days in the last 6 months where stock was 0
   * for a given product+branch.
   * @param {string} productoId
   * @param {string} sucursalId
   * @returns {number}
   */
  function calcularDiasSinStock6m(productoId, sucursalId) {
    try {
      const rows = query(`
        SELECT COUNT(DISTINCT DATE(registrado_en)) AS dias
        FROM historial_stock
        WHERE producto_id = ?
          AND sucursal_id = ?
          AND stock_valor = 0
          AND registrado_en >= datetime('now', '-6 months')
      `, [productoId, sucursalId]);
      return rows.length ? (rows[0].dias || 0) : 0;
    } catch(e) {
      console.warn('calcularDiasSinStock6m error:', e.message);
      return 0;
    }
  }

  function beginBatch() {
    batchMode = true;
    database.run('BEGIN TRANSACTION');
  }

  function commitBatch() {
    database.run('COMMIT');
    batchMode = false;
    saveDatabase();
  }

  function rollbackBatch() {
    database.run('ROLLBACK');
    batchMode = false;
  }

  // Export functions
  window.SGA_DB = {
    initialize,
    query,
    run,
    beginBatch,
    commitBatch,
    rollbackBatch,
    isInitialized: () => db.isInitialized,
    usingOPFS: () => db.usingOPFS,
    useFeature: () => db.useFeature,
    registrarHistorialStock,
    calcularDiasSinStock6m,
  };
})();
