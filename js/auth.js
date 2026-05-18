/**
 * auth.js — Autenticación local (SQLite + SHA-256) + sistema de permisos granulares
 */

(function() {
  'use strict';

  let currentUser = null;

  // ─── Definición de permisos disponibles ────────────────────────────────────
  // Cada entrada: { key, label, grupo, tipo ('bool'|'number'), default, min?, max? }
  // Los admins siempre tienen todos los permisos. Estos checkboxes aplican solo a no-admins.

  window.SGA_PERMISOS_DEF = [
    // VENTAS
    { key: 'can_anular_venta',       label: 'Anular ventas',                         grupo: 'Ventas',   tipo: 'bool',   default: false },
    { key: 'can_editar_venta',       label: 'Editar ventas pasadas',                  grupo: 'Ventas',   tipo: 'bool',   default: false },
    { key: 'max_descuento_pct',      label: 'Descuento máximo permitido (%)',         grupo: 'Ventas',   tipo: 'number', default: 0, min: 0, max: 100 },
    { key: 'can_sobrepasar_tope_cc', label: 'Sobrepasar tope de crédito de clientes', grupo: 'Ventas',  tipo: 'bool',   default: false },
    // CAJA
    { key: 'can_cerrar_caja',        label: 'Cerrar caja',                            grupo: 'Caja',    tipo: 'bool',   default: false },
    { key: 'can_registrar_egreso',   label: 'Registrar egresos',                      grupo: 'Caja',    tipo: 'bool',   default: false },
    { key: 'can_registrar_ingreso',  label: 'Registrar ingresos extra',               grupo: 'Caja',    tipo: 'bool',   default: false },
    { key: 'can_pago_proveedor',     label: 'Hacer pagos a proveedores desde caja',   grupo: 'Caja',    tipo: 'bool',   default: true  },
    // MÓDULOS (controlan visibilidad en el menú lateral)
    { key: 'can_productos',          label: 'Gestionar productos',                    grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_clientes',           label: 'Gestionar clientes',                     grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_compras',            label: 'Gestionar compras',                      grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_ordenes',            label: 'Órdenes de compra',                      grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_proveedores',        label: 'Ver proveedores y cuentas corrientes',   grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_operaciones_stock',  label: 'Operaciones de stock',                   grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_consumo_interno',    label: 'Registrar consumo interno',              grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_promociones',        label: 'Gestionar promociones',                  grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_informes',           label: 'Ver informes',                           grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_gastos',             label: 'Ver gastos generales',                   grupo: 'Módulos', tipo: 'bool',   default: false },
    { key: 'can_etiquetas',          label: 'Imprimir etiquetas',                     grupo: 'Módulos', tipo: 'bool',   default: false },
  ];

  // ─── Motor de permisos ──────────────────────────────────────────────────────

  window.SGA_Permisos = {
    /** Devuelve true si el usuario actual tiene el permiso indicado */
    can(permiso) {
      const u = currentUser;
      if (!u) return false;
      if (u.rol === 'admin') return true;
      return !!(u.permisos && u.permisos[permiso]);
    },

    /** Devuelve el porcentaje máximo de descuento permitido (0-100) */
    maxDescuento() {
      const u = currentUser;
      if (!u) return 0;
      if (u.rol === 'admin') return 100;
      return parseFloat(u.permisos?.max_descuento_pct ?? 0);
    },
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function parsePermisos(raw) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ─── Inicialización ─────────────────────────────────────────────────────────

  async function initialize(_config) {
    restoreSession();
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  async function login(username, password) {
    if (!username || !password) throw new Error('Usuario y contraseña requeridos');

    const hash = await hashPassword(password);
    const normalizedUsername = username.trim().toLowerCase().replace(/[^a-z0-9._]/g, '');

    const rows = window.SGA_DB.query(
      `SELECT * FROM usuarios WHERE username = ? AND password_hash = ? AND activo = 1`,
      [normalizedUsername, hash]
    );

    if (rows.length === 0) throw new Error('Usuario o contraseña incorrectos');

    const u = rows[0];
    currentUser = {
      uid:        u.id,
      id:         u.id,
      nombre:     u.nombre,
      username:   u.username,
      rol:        u.rol,
      sucursal_id: u.sucursal_id,
      permisos:   parsePermisos(u.permisos_json),
    };

    sessionStorage.setItem('sga_user', JSON.stringify(currentUser));
    return currentUser;
  }

  // ─── Sesión ─────────────────────────────────────────────────────────────────

  async function logout() {
    currentUser = null;
    sessionStorage.removeItem('sga_user');
  }

  function getCurrentUser() {
    return currentUser;
  }

  function restoreSession() {
    const stored = sessionStorage.getItem('sga_user');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        // Garantizar que permisos existe aunque sea objeto vacío
        parsed.permisos = parsed.permisos || {};
        currentUser = parsed;
      } catch {
        currentUser = null;
      }
    }
  }

  // ─── Roles y acciones ───────────────────────────────────────────────────────

  function hasRole(requiredRole) {
    if (!currentUser) return false;
    if (currentUser.rol === 'admin') return true;
    return currentUser.rol === requiredRole;
  }

  /** Compatibilidad retroactiva — preferir SGA_Permisos.can() para código nuevo */
  function canDo(action) {
    if (!currentUser) return false;
    if (currentUser.rol === 'admin') return true;
    const legacyMap = {
      'view_products':        'can_productos',
      'edit_products':        'can_productos',
      'view_sales':           null,
      'create_sale':          null,
      'view_stock':           'can_operaciones_stock',
      'edit_stock':           'can_operaciones_stock',
      'view_purchases':       'can_compras',
      'create_purchase':      'can_compras',
      'view_orders':          'can_ordenes',
      'manage_orders':        'can_ordenes',
      'view_reports':         'can_informes',
      'create_consumo_interno':'can_consumo_interno',
      'view_all_consumo_interno':'can_consumo_interno',
      'manage_cash':          null,
    };
    const mapped = legacyMap[action];
    if (mapped === null) return true;   // acceso sin restricción
    if (mapped) return window.SGA_Permisos.can(mapped);
    return false;
  }

  function isAuthenticated() {
    return currentUser !== null;
  }

  window.SGA_Auth = {
    initialize,
    login,
    logout,
    getCurrentUser,
    hasRole,
    canDo,
    isAuthenticated,
    hashPassword,
  };
})();
