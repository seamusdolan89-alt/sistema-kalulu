/**
 * app.js — SPA Router and Main Application Entry Point
 * 
 * Handles:
 * - Authentication check (redirect to login if not authenticated)
 * - Route management (hash-based navigation)
 * - View loading and rendering
 * - Module initialization
 * - Global event delegation
 */

(function() {
  'use strict';

  // Application state
  const app = {
    currentRoute: null,
    currentModule: null,
    user: null,
    isOnline: navigator.onLine,
  };

  // Module registry
  const modules = {
    'productos': () => import('./modules/productos.js').then(m => m.default),
    'pos': () => import('./modules/pos.js').then(m => m.default),
    'clientes': () => import('./modules/clientes.js').then(m => m.default),
    'caja': () => import('./modules/caja.js').then(m => m.default),
    'compras_v2': () => import('./modules/compras_v2.js').then(m => m.default),
    'operaciones_stock': () => import('./modules/operaciones_stock.js').then(m => m.default),
    'ordenes': () => import('./modules/ordenes.js').then(m => m.default),
    'proveedores': () => import('./modules/proveedores.js').then(m => m.default),
    'promociones': () => import('./modules/promociones.js').then(m => m.default),
    'etiquetas': () => import('./modules/etiquetas.js').then(m => m.default),
    'informes': () => import('./modules/informes.js').then(m => m.default),
    'editor-producto': () => import('./modules/editor-producto.js').then(m => m.default),
    'cuenta_corriente_proveedores': () => import('./modules/cuenta_corriente_proveedores.js').then(m => m.default),
    'usuarios': () => import('./modules/usuarios.js').then(m => m.default),
    'consumo_interno': () => import('./modules/consumo_interno.js').then(m => m.default),
    'vencimientos':    () => import('./modules/vencimientos.js').then(m => m.default),
    'roturas':         () => import('./modules/roturas.js').then(m => m.default),
    'gastos':          () => import('./modules/gastos.js').then(m => m.default),
  };

  /**
   * Check authentication and redirect if needed
   */
  async function checkAuth() {
    const user = window.SGA_Auth.getCurrentUser();
    
    if (!user) {
      // Not authenticated - redirect to login
      console.log('🔐 Not authenticated, redirecting to login...');
      window.location.href = './views/login.html';
      return false;
    }

    app.user = user;
    return true;
  }

  /**
   * Router: parse URL hash and load corresponding view
   */
  async function router() {
    const hash = window.location.hash.slice(1) || 'pos';
    const [route, ...params] = hash.split('/');

    app.currentRoute = route;

    // Restore app shell when leaving the product editor
    if (route !== 'editor-producto') {
      const h1 = document.querySelector('header h1');
      if (h1) h1.innerHTML = '🏪 Sistema Kalulu';
      const aside = document.querySelector('aside.sidebar');
      if (aside) {
        aside.classList.remove('editor-mode');
        aside.innerHTML = '<nav><ul></ul></nav>';
        initNav();
      }
    }

    // Update active nav link
    document.querySelectorAll('aside nav a').forEach(link => {
      link.classList.remove('active');
      if (link.dataset.module === route) {
        link.classList.add('active');
      }
    });

    // Load view
    await loadView(route, params);
  }

  /**
   * Load view HTML and initialize corresponding module
   */
  async function loadView(moduleName, params) {
    try {
      const appContainer = document.getElementById('app');
      const v = Date.now();

      // Always fetch HTML fresh (no cache)
      const response = await fetch(`./views/${moduleName}.html?v=${v}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`View not found: ${moduleName}`);

      const html = await response.text();
      appContainer.innerHTML = html;

      // Always import JS fresh (bust module registry cache with timestamp)
      if (modules[moduleName]) {
        const mod = await import(`./modules/${moduleName}.js?v=${v}`);
        const module = mod.default;
        app.currentModule = module;

        if (module && typeof module.init === 'function') {
          module.init(params);
        }
      }
    } catch (error) {
      console.error(`Error loading view: ${moduleName}`, error);
      document.getElementById('app').innerHTML = `
        <div class="alert alert-danger">
          <strong>Error:</strong> Could not load module "${moduleName}".
        </div>
      `;
    }
  }

  /**
   * Initialize navigation
   */
  function initNav() {
    const navContainer = document.querySelector('aside nav ul');
    const moduleList = [
      { name: 'pos', label: '💳 Punto de Venta' },
      { name: 'productos', label: '📦 Productos' },
      { name: 'clientes', label: '👥 Clientes' },
      { name: 'caja', label: '💰 Caja' },
      { name: 'compras_v2', label: '📥 Compras' },
      { name: 'operaciones_stock', label: '📦 Operaciones de Stock' },
      { name: 'ordenes', label: '📋 Órdenes' },
      { name: 'proveedores', label: '🏢 Proveedores' },
      { name: 'cuenta_corriente_proveedores', label: '📒 Ctas. Ctes. Proveedores' },
      { name: 'promociones', label: '🏷️ Promociones' },
      { name: 'etiquetas', label: '🏷️ Etiquetas' },
      { name: 'informes', label: '📊 Informes' },
      { name: 'gastos', label: '💸 Gastos Generales' },
      { name: 'usuarios', label: '👤 Usuarios', adminOnly: true },
    ];

    const hasPendingResumen = !!localStorage.getItem('compras_resumen_pending');
    const currentUserRole = app.user?.rol || window.SGA_Auth.getCurrentUser()?.rol;

    navContainer.innerHTML = moduleList
      .filter(({ adminOnly }) => !adminOnly || currentUserRole === 'admin')
      .map(({ name, label }) => {
        const badge = (name === 'operaciones_stock' && hasPendingResumen)
          ? ' <span style="display:inline-block;background:#ff8f00;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;vertical-align:middle;margin-left:4px;white-space:nowrap;">● Ajuste pendiente</span>'
          : '';
        return `<li><a href="#${name}" data-module="${name}" class="nav-link">${label}${badge}</a></li>`;
      }).join('');
  }

  /**
   * Update header with user info
   */
  function updateHeader() {
    const userNameElem = document.getElementById('user-name');
    const logoutBtn = document.getElementById('logout-btn');

    if (app.user) {
      userNameElem.textContent = `${app.user.nombre} (${app.user.rol})`;
      
      logoutBtn.addEventListener('click', async () => {
        await window.SGA_Auth.logout();
        window.location.href = './views/login.html';
      });
    }
  }

  /**
   * Initialize online/offline detection
   */
  function initNetworkDetection() {
    window.addEventListener('online', () => {
      app.isOnline = true;
      console.log('✅ Application is now online');
      document.body.classList.remove('offline');
    });

    window.addEventListener('offline', () => {
      app.isOnline = false;
      console.log('⚠️ Application is now offline');
      document.body.classList.add('offline');
    });

    if (!navigator.onLine) {
      document.body.classList.add('offline');
    }
  }

  /**
   * Handle navigation — with POS sale guard
   */
  window.addEventListener('hashchange', (e) => {
    const newHash = window.location.hash.slice(1) || 'pos';
    const [route] = newHash.split('/');

    // Navigation guard: if POS has an active sale with cart items, block and notify
    if (window.SGA_POS_ACTIVE_SALE && route !== 'pos') {
      try {
        const cart = JSON.parse(sessionStorage.getItem('pos_cart') || '[]');
        if (Array.isArray(cart) && cart.length > 0) {
          // Restore previous URL so the address bar doesn't show the new route
          const oldHash = e.oldURL && e.oldURL.includes('#')
            ? e.oldURL.slice(e.oldURL.indexOf('#'))
            : '#pos';
          history.replaceState(null, '', oldHash);
          window.dispatchEvent(new CustomEvent('navigation-blocked', {
            detail: { targetHash: newHash }
          }));
          return;
        }
      } catch (_) {}
    }

    router();
  });

  /**
   * Main initialization
   */
  async function init() {
    console.log('🚀 Sistema Kalulu iniciando...');

    // Initialize globals before any module loads
    window.SGA_POS_ACTIVE_SALE = false;

    try {
      // Initialize database
      console.log('🔄 Initializing database...');
      await window.SGA_DB.initialize();

      // Restore session (must happen before checkAuth)
      await window.SGA_Auth.initialize();

      // Auto-seed in dev mode if database is empty
      if (localStorage.getItem('dev_mode') === 'true') {
        const hasSucursales = window.SGA_DB.query('SELECT COUNT(*) as count FROM sucursales');
        if (!hasSucursales || hasSucursales[0]?.count === 0) {
          console.log('🌱 No data found, auto-seeding...');
          try {
            const seedModule = await import('./seed.js');
            await seedModule.default();
          } catch (e) {
            console.warn('⚠️ Auto-seeding failed:', e);
          }
        }
      }
      
      // Pre-load caja module so window.SGA_Caja is always available (used by POS data layer)
      await import('./modules/caja.js');

      // Check authentication
      console.log('🔐 Checking authentication...');
      const isAuth = await checkAuth();
      if (!isAuth) return; // Redirect to login handled by checkAuth
      
      // Initialize networking
      initNetworkDetection();
      
      // Initialize navigation
      initNav();
      
      // Update header
      updateHeader();
      
      // Route to initial view
      await router();
      
      console.log('✅ Aplicación lista');
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      document.getElementById('app').innerHTML = `
        <div class="alert alert-danger">
          <strong>Error crítico:</strong> ${error.message}
        </div>
      `;
    }
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export app object for debugging (dev mode only)
  if (localStorage.getItem('dev_mode') === 'true') window.SK_App = app;
})();
