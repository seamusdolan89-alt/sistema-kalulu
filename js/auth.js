/**
 * auth.js — Firebase Authentication & Session Management
 * 
 * Handles:
 * - Firebase Auth login/logout
 * - User session management
 * - Permission checking
 * - Cross-tab session sync
 */

(function() {
  'use strict';

  let firebaseAuth = null;
  let currentUser = null;
  const DEV_USER = {
    uid: 'dev-admin',
    email: 'admin@demo.com',
    id: '1',
    nombre: 'Admin Demo',
    rol: 'admin',
    sucursal_id: '1'
  };

  /**
   * Initialize Firebase Authentication
   * 
   * @param {Object} config - Firebase config
   * @returns {Promise<void>}
   */
  async function initialize(config) {
    try {
      // Check if dev mode is enabled
      if (localStorage.getItem('dev_mode') === 'true') {
        console.log('🔧 DEV MODE ENABLED - Bypassing Firebase');
        currentUser = DEV_USER;
        sessionStorage.setItem('sga_user', JSON.stringify(currentUser));
        return;
      }

      console.log('🔐 Initializing Firebase Authentication...');
      
      // Check if Firebase is loaded
      if (!window.firebase || !window.firebase.auth) {
        throw new Error('Firebase SDK not loaded');
      }

      // Initialize Firebase
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }

      firebaseAuth = firebase.auth();
      
      // Restore session from sessionStorage
      restoreSession();

      console.log('✅ Firebase Auth initialized');
    } catch (error) {
      console.error('Firebase Auth initialization failed:', error);
      throw error;
    }
  }

  /**
   * Sign in with email and password
   * 
   * @param {string} email
   * @param {string} password
   * @returns {Promise<Object>} User object {uid, nombre, rol, sucursal_id}
   */
  async function login(email, password) {
    try {
      // DEV MODE: Skip Firebase entirely
      if (localStorage.getItem('dev_mode') === 'true') {
        console.log('🔧 DEV MODE LOGIN - Skipping Firebase, using dev user');
        currentUser = DEV_USER;
        sessionStorage.setItem('sga_user', JSON.stringify(currentUser));
        console.log('✅ Logged in as:', currentUser.nombre);
        return currentUser;
      }

      console.log('🔄 Attempting login...');

      // Firebase sign in
      const result = await firebaseAuth.signInWithEmailAndPassword(email, password);
      const firebaseUser = result.user;

      // Look up usuario in SQLite by firebase_uid
      const usuarios = window.SGA_DB.query(
        'SELECT * FROM usuarios WHERE firebase_uid = ? AND activo = 1',
        [firebaseUser.uid]
      );

      if (usuarios.length === 0) {
        throw new Error('Usuario no encontrado o inactivo');
      }

      const usuario = usuarios[0];
      
      // Store in session
      currentUser = {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        id: usuario.id,
        nombre: usuario.nombre,
        rol: usuario.rol,
        sucursal_id: usuario.sucursal_id,
      };

      // Save to sessionStorage
      sessionStorage.setItem('sga_user', JSON.stringify(currentUser));
      
      console.log('✅ Logged in as:', currentUser.nombre);
      return currentUser;
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  }

  /**
   * Sign out
   * 
   * @returns {Promise<void>}
   */
  async function logout() {
    try {
      console.log('🔄 Signing out...');
      
      if (firebaseAuth) {
        await firebaseAuth.signOut();
      }

      currentUser = null;
      sessionStorage.removeItem('sga_user');
      
      console.log('✅ Logged out');
    } catch (error) {
      console.error('Logout failed:', error);
      throw error;
    }
  }

  /**
   * Get current user
   * 
   * @returns {Object|null}
   */
  function getCurrentUser() {
    // DEV MODE: Always return dev user if enabled
    if (localStorage.getItem('dev_mode') === 'true') {
      return DEV_USER;
    }
    return currentUser;
  }

  /**
   * Restore session from storage
   */
  function restoreSession() {
    const stored = sessionStorage.getItem('sga_user');
    if (stored) {
      try {
        currentUser = JSON.parse(stored);
        console.log('✅ Session restored for:', currentUser.nombre);
      } catch (error) {
        console.warn('Failed to restore session:', error);
        currentUser = null;
      }
    }
  }

  /**
   * Check if user has required role
   * 
   * @param {string} requiredRole
   * @returns {boolean}
   */
  function hasRole(requiredRole) {
    if (!currentUser) return false;
    if (currentUser.rol === 'admin') return true;
    return currentUser.rol === requiredRole;
  }

  /**
   * Check if user can perform action
   * 
   * @param {string} action
   * @returns {boolean}
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
        'view_reports'
      ],
      'cajero': [
        'view_products',
        'create_sale',
        'manage_cash'
      ]
    };

    const permissions = rolePermissions[currentUser.rol] || [];
    return permissions.includes('*') || permissions.includes(action);
  }

  /**
   * Check if user is authenticated
   * 
   * @returns {boolean}
   */
  function isAuthenticated() {
    return currentUser !== null;
  }

  // Export functions
  window.SGA_Auth = {
    initialize,
    login,
    logout,
    getCurrentUser,
    hasRole,
    canDo,
    isAuthenticated,
  };
})();
