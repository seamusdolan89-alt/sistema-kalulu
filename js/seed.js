/**
 * seed.js — Development Seed Data
 * 
 * Populates the database with demo data for development and testing.
 * Only runs if the sucursales table is empty.
 */

export default async function seed() {
  'use strict';

  console.log('🌱 Seeding database with demo data...');

  // Check if already seeded
  const existing_sucursales = window.SGA_DB.query('SELECT COUNT(*) as count FROM sucursales');
  if (existing_sucursales[0]?.count > 0) {
    console.log('⚠️ Database already seeded, skipping');
    return;
  }

  const now = new Date().toISOString();

  // 1. Insert sucursal (use fixed id='1' for dev user)
  const sucursal_id = '1';
  window.SGA_DB.run(
    `INSERT INTO sucursales (id, nombre, direccion, activa, sync_status, updated_at)
     VALUES (?, ?, ?, 1, 'pending', ?)`,
    [sucursal_id, 'Kalulu Central', 'Av. Principal 123, CABA', now]
  );
  console.log('✅ Sucursal created (id=1)');

  // 2. Insert admin user
  const admin_id = window.SGA_Utils.generateUUID();
  window.SGA_DB.run(
    `INSERT INTO usuarios (id, firebase_uid, nombre, rol, sucursal_id, activo, sync_status, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)`,
    [admin_id, 'dev-admin', 'Admin Demo', 'admin', sucursal_id, now]
  );
  console.log('✅ Admin user created');

  // 3. Insert sample categories
  const categories = [
    { name: 'Bebidas', commission: 0.05 },
    { name: 'Alimentos', commission: 0.03 },
    { name: 'Artículos de Limpieza', commission: 0.08 },
    { name: 'Electrónica', commission: 0.10 },
    { name: 'Ropa y Accesorios', commission: 0.12 },
  ];

  const category_ids = [];
  for (const cat of categories) {
    const cat_id = window.SGA_Utils.generateUUID();
    category_ids.push(cat_id);
    window.SGA_DB.run(
      `INSERT INTO categorias (id, nombre, comision_pct, sync_status, updated_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      [cat_id, cat.name, cat.commission, now]
    );
  }
  console.log(`✅ ${categories.length} categories created`);

  // 4. Insert sample suppliers
  const suppliers = [
    {
      name: 'Pepsico SA',
      cuit: '20-12345678-9',
      email: 'ventas@pepsico.com.ar',
      payment_term: '30 días'
    },
    {
      name: 'Nestlé Argentina',
      cuit: '20-98765432-1',
      email: 'distribucion@nestle.com.ar',
      payment_term: 'Contado'
    },
    {
      name: 'Grupo Sancor Seguros',
      cuit: '20-11223344-5',
      email: 'ventas@sancor.com.ar',
      payment_term: '15 días'
    },
  ];

  const supplier_ids = [];
  for (const sup of suppliers) {
    const sup_id = window.SGA_Utils.generateUUID();
    supplier_ids.push(sup_id);
    window.SGA_DB.run(
      `INSERT INTO proveedores (id, razon_social, cuit, email, condicion_pago, activo, sync_status, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)`,
      [sup_id, sup.name, sup.cuit, sup.email, sup.payment_term, now]
    );
  }
  console.log(`✅ ${suppliers.length} suppliers created`);

  // 5. Insert sample products (optional - can add more later)
  const products = [
    {
      name: 'Coca-Cola 2L',
      category_id: category_ids[0],
      supplier_id: supplier_ids[0],
      cost: 50.00,
      price: 95.00,
      stock_min: 10,
      unit: 'unidad'
    },
    {
      name: 'Detergente 500ml',
      category_id: category_ids[2],
      supplier_id: supplier_ids[1],
      cost: 30.00,
      price: 65.00,
      stock_min: 15,
      unit: 'unidad'
    },
  ];

  for (const prod of products) {
    const prod_id = window.SGA_Utils.generateUUID();
    window.SGA_DB.run(
      `INSERT INTO productos (
        id, nombre, categoria_id, proveedor_principal_id,
        costo, precio_venta, stock_minimo, unidad_medida,
        es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion,
        sync_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, 'pending', ?)`,
      [
        prod_id, prod.name, prod.category_id, prod.supplier_id,
        prod.cost, prod.price, prod.stock_min, prod.unit,
        now, now, now
      ]
    );

    // Create initial stock for this product per sucursal
    window.SGA_DB.run(
      `INSERT INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [prod_id, sucursal_id, 20, now, now]
    );
  }
  console.log(`✅ ${products.length} products created`);

  console.log('✅ Demo data seeded successfully!');
  console.log('📝 Test credentials:');
  console.log('   Email: admin@demo.com');
  console.log('   Password: admin123');
}
