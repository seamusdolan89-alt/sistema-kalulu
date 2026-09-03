/**
 * auth.js — Autenticación local (SQLite + SHA-256) + sistema de permisos granulares
 */

(function() {
  'use strict';

  let currentUser = null;

  // ─── Definición de permisos disponibles ────────────────────────────────────
  // Cada entrada: { key, label, grupo, riesgo ('alto'|'medio'|'bajo'), tipo
  // ('bool'|'number'), default, min?, max?, requiere? }.
  // `riesgo` es solo para la UI (colorea el grupo en usuarios.js) — no cambia
  // el enforcement. `requiere` es una dependencia blanda: si se tilda este
  // permiso, usuarios.js auto-tilda (y no deja destildar) el permiso base del
  // que depende — tampoco es enforcement real, eso lo hace cada módulo/el
  // router (ver ROUTE_PERMISSION en app.js e isRouteAllowed()).
  // Los admins siempre tienen todos los permisos. Estos checkboxes aplican solo a no-admins.
  //
  // NOTA: can_ver_productos/can_editar_productos/can_ver_costos,
  // can_cta_cte_proveedores y can_roturas_vencimientos son permisos NUEVOS
  // (antes eran can_productos, can_proveedores y can_operaciones_stock sin
  // separar ver/editar). Ver migración de permisos legacy en js/db.js —
  // usuarios ya creados con los permisos viejos se expanden automáticamente
  // para no perder acceso al actualizar.

  window.SGA_PERMISOS_DEF = [
    // ── FINANZAS Y CAJA (🔴 alto riesgo — tocan plata directamente) ──────────
    { key: 'can_cerrar_caja',        label: 'Cerrar caja',                             grupo: 'Finanzas y Caja', riesgo: 'alto', tipo: 'bool',   default: false },
    { key: 'can_registrar_egreso',   label: 'Registrar egresos',                       grupo: 'Finanzas y Caja', riesgo: 'alto', tipo: 'bool',   default: false },
    { key: 'can_registrar_ingreso',  label: 'Registrar ingresos extra',                grupo: 'Finanzas y Caja', riesgo: 'alto', tipo: 'bool',   default: false },
    { key: 'can_pago_proveedor',     label: 'Pagos a proveedores desde caja',          grupo: 'Finanzas y Caja', riesgo: 'alto', tipo: 'bool',   default: true  },
    { key: 'can_gastos',             label: 'Ver y cargar Gastos Generales',           grupo: 'Finanzas y Caja', riesgo: 'alto', tipo: 'bool',   default: false },
    { key: 'max_descuento_pct',      label: 'Descuento máximo permitido (%)',          grupo: 'Finanzas y Caja', riesgo: 'alto', tipo: 'number', default: 0, min: 0, max: 100 },

    // ── VENTAS (🟡 medio — tocan ventas ya cerradas o límites de crédito) ────
    { key: 'can_anular_venta',       label: 'Anular ventas',                           grupo: 'Ventas', riesgo: 'medio', tipo: 'bool', default: false },
    { key: 'can_editar_venta',       label: 'Editar ventas pasadas',                   grupo: 'Ventas', riesgo: 'medio', tipo: 'bool', default: false },
    { key: 'can_sobrepasar_tope_cc', label: 'Sobrepasar tope de crédito de clientes',  grupo: 'Ventas', riesgo: 'medio', tipo: 'bool', default: false },

    // ── PRODUCTOS ─────────────────────────────────────────────────────────
    { key: 'can_ver_productos',      label: 'Ver productos (buscar, stock, precio)',   grupo: 'Productos', riesgo: 'bajo',  tipo: 'bool', default: false },
    { key: 'can_editar_productos',   label: 'Crear, modificar y borrar productos',     grupo: 'Productos', riesgo: 'medio', tipo: 'bool', default: false, requiere: 'can_ver_productos' },
    { key: 'can_ver_costos',         label: 'Ver costos y márgenes',                   grupo: 'Productos', riesgo: 'medio', tipo: 'bool', default: false, requiere: 'can_ver_productos' },

    // ── COMPRAS Y PROVEEDORES ────────────────────────────────────────────
    { key: 'can_compras',             label: 'Gestionar compras',                        grupo: 'Compras y Proveedores', riesgo: 'medio', tipo: 'bool', default: false },
    { key: 'can_editar_compras_caja', label: 'Editar compras de la caja actual',         grupo: 'Compras y Proveedores', riesgo: 'medio', tipo: 'bool', default: false, requiere: 'can_compras' },
    { key: 'can_ordenes',             label: 'Órdenes de compra',                        grupo: 'Compras y Proveedores', riesgo: 'bajo',  tipo: 'bool', default: false },
    { key: 'can_proveedores',         label: 'Ver proveedores',                          grupo: 'Compras y Proveedores', riesgo: 'bajo',  tipo: 'bool', default: false },
    { key: 'can_cta_cte_proveedores', label: 'Cuenta corriente de proveedores (pagos)',  grupo: 'Compras y Proveedores', riesgo: 'alto',  tipo: 'bool', default: false, requiere: 'can_proveedores' },

    // ── STOCK ─────────────────────────────────────────────────────────────
    { key: 'can_operaciones_stock',    label: 'Operaciones de stock (recuentos, ajustes)', grupo: 'Stock', riesgo: 'bajo',  tipo: 'bool', default: false },
    { key: 'can_roturas_vencimientos', label: 'Dar de baja por rotura o vencimiento',      grupo: 'Stock', riesgo: 'medio', tipo: 'bool', default: false },
    { key: 'can_consumo_interno',      label: 'Registrar consumo interno',                 grupo: 'Stock', riesgo: 'medio', tipo: 'bool', default: false },

    // ── OTROS ─────────────────────────────────────────────────────────────
    { key: 'can_clientes',     label: 'Gestionar clientes',    grupo: 'Otros', riesgo: 'bajo',  tipo: 'bool', default: false },
    { key: 'can_promociones',  label: 'Gestionar promociones', grupo: 'Otros', riesgo: 'bajo',  tipo: 'bool', default: false },
    { key: 'can_informes',     label: 'Ver informes',          grupo: 'Otros', riesgo: 'medio', tipo: 'bool', default: false },
    { key: 'can_etiquetas',    label: 'Imprimir etiquetas',    grupo: 'Otros', riesgo: 'bajo',  tipo: 'bool', default: false },
  ];

  // ─── Plantillas de rol ──────────────────────────────────────────────────────
  // Atajos para no tildar los ~23 permisos a mano en cada alta. Al aplicar una
  // plantilla se pisan los checkboxes visibles en el form — el admin puede
  // seguir ajustando antes de guardar, no queda "bloqueado" a la plantilla.

  window.SGA_PERMISOS_PRESETS = [
    {
      id: 'cajera_basica',
      nombre: 'Cajera básica',
      descripcion: 'Vender en el POS: buscar productos y atender clientes. Sin descuentos, sin tocar precios ni caja.',
      permisos: { can_ver_productos: true, can_clientes: true },
    },
    {
      id: 'encargado_stock',
      nombre: 'Encargado de Stock',
      descripcion: 'Gestiona mercadería: productos, costos, recuentos, bajas por rotura/vencimiento y consumo interno.',
      permisos: {
        can_ver_productos: true, can_editar_productos: true, can_ver_costos: true,
        can_operaciones_stock: true, can_roturas_vencimientos: true, can_consumo_interno: true,
        can_proveedores: true,
      },
    },
    {
      id: 'colaborador_confianza',
      nombre: 'Colaborador de confianza',
      descripcion: 'Casi acceso total — todo excepto pagos a proveedores desde caja y Gastos Generales.',
      permisos: {
        can_cerrar_caja: true, can_registrar_egreso: true, can_registrar_ingreso: true,
        max_descuento_pct: 20,
        can_anular_venta: true, can_editar_venta: true, can_sobrepasar_tope_cc: true,
        can_ver_productos: true, can_editar_productos: true, can_ver_costos: true,
        can_compras: true, can_ordenes: true, can_proveedores: true,
        can_operaciones_stock: true, can_roturas_vencimientos: true, can_consumo_interno: true,
        can_clientes: true, can_promociones: true, can_informes: true, can_etiquetas: true,
      },
    },
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

  // ─── Cierre de sesión automático por cambio de jornada ─────────────────────
  // Problema real: sessionStorage no se borra solo al apagar la compu (depende
  // del navegador/SO — a veces restaura la pestaña tal cual estaba). Sin esto,
  // una cajera podía quedar logueada de un turno anterior y la siguiente
  // persona operar sin querer con esa sesión. Se define un corte de "jornada"
  // a una hora fija (7am por defecto, no medianoche, para no cortar turnos
  // nocturnos a mitad de camino): toda sesión iniciada antes del último corte
  // se considera vencida una vez que ese corte ya pasó.

  const SESSION_CUTOFF_HOUR = 7;
  const SESSION_EXPIRY_CHECK_MS = 5 * 60 * 1000; // 5 min
  let expiryIntervalId = null;

  function businessDayOf(date) {
    const d = new Date(date);
    if (d.getHours() < SESSION_CUTOFF_HOUR) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function isSessionExpired() {
    const loginAt = sessionStorage.getItem('sga_login_at');
    if (!loginAt) return false; // sesión de un build viejo sin esta marca: no forzar cierre
    return businessDayOf(loginAt) !== businessDayOf(new Date());
  }

  // ─── Inicialización ─────────────────────────────────────────────────────────

  async function initialize(_config) {
    restoreSession();
    if (!expiryIntervalId) {
      expiryIntervalId = setInterval(() => {
        if (currentUser && isSessionExpired()) {
          logout().then(() => location.reload());
        }
      }, SESSION_EXPIRY_CHECK_MS);
    }
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
    sessionStorage.setItem('sga_login_at', new Date().toISOString());
    return currentUser;
  }

  // ─── Sesión ─────────────────────────────────────────────────────────────────

  async function logout() {
    currentUser = null;
    sessionStorage.removeItem('sga_user');
    sessionStorage.removeItem('sga_login_at');
  }

  function getCurrentUser() {
    return currentUser;
  }

  function restoreSession() {
    if (isSessionExpired()) {
      sessionStorage.removeItem('sga_user');
      sessionStorage.removeItem('sga_login_at');
      currentUser = null;
      return;
    }
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

  /**
   * Valida la contraseña de un usuario puntual SIN tocar la sesión activa.
   * Uso: confirmar que una acción (ej. atribuir un consumo interno a otro
   * usuario) la autoriza esa persona, sin desloguear a quien está operando.
   */
  async function verificarPassword(usuarioId, password) {
    if (!usuarioId || !password) return false;
    const hash = await hashPassword(password);
    const rows = window.SGA_DB.query(
      `SELECT id FROM usuarios WHERE id = ? AND password_hash = ? AND activo = 1`,
      [usuarioId, hash]
    );
    return rows.length > 0;
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
    verificarPassword,
  };
})();
