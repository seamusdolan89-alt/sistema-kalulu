/**
 * auth.js — Autenticación local (SQLite + SHA-256)
 *
 * Maneja:
 * - Login con usuario y contraseña almacenados en SQLite
 * - Hashing de contraseñas con Web Crypto API (SHA-256)
 * - Sesión en sessionStorage
 * - Control de permisos por rol
 */

(function() {
  'use strict';

  let currentUser = null;

  const DEV_USER = {
    uid: 'dev-admin',
    id: '1',
    nombre: 'Admin Demo',
    username: 'admin',
    rol: 'admin',
    sucursal_id: '1'
  };

  /**
   * Genera el hash SHA-256 de una cadena (devuelve hex string)
   */
  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Inicialización — restaura la sesión guardada en sessionStorage.
   * Firma compatible con el código anterior que llamaba initialize(firebaseConfig).
   */
  async function initialize(_config) {
    restoreSession();
  }

  /**
   * Login con username + password contra la base SQLite local
   *
   * @param {string} username
   * @param {string} password
   * @returns {Promise<Object>} usuario { uid, id, nombre, username, rol, sucursal_id }
   */
  async function login(username, password) {

    if (!username || !password) {
      throw new Error('Usuario y contraseña requeridos');
    }

    const hash = await hashPassword(password);

    // Normalizar username igual que en el formulario de creación (sin espacios ni caracteres especiales)
    const normalizedUsername = username.trim().toLowerCase().replace(/[^a-z0-9._]/g, '');

    const rows = window.SGA_DB.query(
      `SELECT * FROM usuarios WHERE username = ? AND password_hash = ? AND activo = 1`,
      [normalizedUsername, hash]
    );

    if (rows.length === 0) {
      throw new Error('Usuario o contraseña incorrectos');
    }

    const u = rows[0];
    currentUser = {
      uid: u.id,           // usamos el id local como uid de sesión
      id: u.id,
      nombre: u.nombre,
      username: u.username,
      rol: u.rol,
      sucursal_id: u.sucursal_id,
    };

    sessionStorage.setItem('sga_user', JSON.stringify(currentUser));
    return currentUser;
  }

  /**
   * Cerrar sesión
   */
  async function logout() {
    currentUser = null;
    sessionStorage.removeItem('sga_user');
  }

  /**
   * Obtener el usuario actual
   */
  function getCurrentUser() {
    return currentUser;
  }

  /**
   * Restaurar sesión desde sessionStorage
   */
  function restoreSession() {
    const stored = sessionStorage.getItem('sga_user');
    if (stored) {
      try {
        currentUser = JSON.parse(stored);
      } catch {
        currentUser = null;
      }
    }
  }

  /**
   * ¿Tiene el rol indicado (o superior)?
   */
  function hasRole(requiredRole) {
    if (!currentUser) return false;
    if (currentUser.rol === 'admin') return true;
    return currentUser.rol === requiredRole;
  }

  /**
   * ¿Puede realizar la acción?
   */
  function canDo(action) {
    if (!currentUser) return false;

    const rolePermissions = {
      'admin': ['*'],
      'encargado': [
        'view_products', 'edit_products',
        'view_sales', 'create_sale',
        'view_stock', 'edit_stock',
        'view_purchases', 'create_purchase',
        'view_orders', 'manage_orders',
        'view_reports',
        'create_consumo_interno', 'view_all_consumo_interno',
      ],
      'cajero': [
        'view_products',
        'create_sale',
        'manage_cash',
        'create_consumo_interno',
      ]
    };

    const permissions = rolePermissions[currentUser.rol] || [];
    return permissions.includes('*') || permissions.includes(action);
  }

  /**
   * ¿Está autenticado?
   */
  function isAuthenticated() {
    return currentUser !== null;
  }

  /**
   * Utilidad: hashear una contraseña (expuesta para el módulo de usuarios)
   */
  window.SGA_Auth = {
    initialize,
    login,
    logout,
    getCurrentUser,
    hasRole,
    canDo,
    isAuthenticated,
    hashPassword,   // usado por el módulo de gestión de usuarios
  };
})();
