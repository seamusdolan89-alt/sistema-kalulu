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
        hereda_costo INTEGER DEFAULT 1,
        hereda_precio INTEGER DEFAULT 1,
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
        estado TEXT DEFAULT 'borrador' CHECK(estado IN ('borrador','enviada','recibida_parcial','cerrada')),
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

    // Add new columns to existing databases (safe: fails silently if column exists)
    const columnAlterations = [
      'ALTER TABLE productos ADD COLUMN stock_alerta REAL DEFAULT 0',
      'ALTER TABLE productos ADD COLUMN cant_pedido REAL DEFAULT 0',
      "ALTER TABLE productos ADD COLUMN pedido_unidad TEXT DEFAULT 'unidad'",
      'ALTER TABLE productos ADD COLUMN hereda_costo INTEGER DEFAULT 1',
      'ALTER TABLE productos ADD COLUMN hereda_precio INTEGER DEFAULT 1',
      'ALTER TABLE productos ADD COLUMN imagen TEXT',
    ];
    for (const sql of columnAlterations) {
      try { database.run(sql); } catch(e) { /* column already exists */ }
    }

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
  };
})();
