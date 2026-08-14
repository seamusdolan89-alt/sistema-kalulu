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

  // Persists the user's explicit open/close choice for the Cajas nav group
  let cajasGroupOpen = null;

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
    'caja_admin':      () => import('./modules/caja_admin.js').then(m => m.default),
    'adelanto_pago':   () => import('./modules/adelanto_pago.js').then(m => m.default),
    'configuracion':   () => import('./modules/configuracion.js').then(m => m.default),
    'flujo':           () => import('./modules/flujo.js').then(m => m.default),
  };

  /**
   * Check authentication and redirect if needed
   */
  async function checkAuth() {
    const user = window.SGA_Auth.getCurrentUser();
    
    if (!user) {
      // Not authenticated - redirect to login
      console.log('🔐 Not authenticated, redirecting to login...');
      const loginBase = window.VIEWS_BASE_PATH || './views/';
      const returnTo = window.ADMIN_MODE ? encodeURIComponent('../admin-pos/') : '';
      window.location.href = loginBase + 'login.html' + (returnTo ? '?returnTo=' + returnTo : '');
      return false;
    }

    app.user = user;
    return true;
  }

  /**
   * Router: parse URL hash and load corresponding view
   */
  async function router() {
    const hash = window.location.hash.slice(1) || (window.ADMIN_MODE ? 'productos' : 'pos');
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
    const activeMedio = params[0] || null;
    document.querySelectorAll('aside nav a').forEach(link => {
      link.classList.remove('active');
      if (link.dataset.module === route) {
        if (route === 'caja') {
          if (!activeMedio && !link.dataset.medio) {
            // #caja (overview) — highlight the group label
            link.classList.add('active');
          } else if (activeMedio && link.dataset.medio === activeMedio) {
            // #caja/efectivo etc — highlight the sub-item
            link.classList.add('active');
          }
        } else {
          link.classList.add('active');
        }
      }
    });
    // Load view
    await loadView(route, params);
  }

  /**
   * Load view HTML and initialize corresponding module
   */
  async function loadView(moduleName, params) {
    if (!isRouteAllowed(moduleName)) {
      console.warn(`🔒 Acceso bloqueado a "${moduleName}" — el usuario no tiene el permiso requerido.`);
      document.getElementById('app').innerHTML = `
        <div class="alert alert-danger">
          <strong>Acceso restringido.</strong> No tenés permiso para ver esta sección.
        </div>
      `;
      return;
    }
    try {
      const appContainer = document.getElementById('app');
      const v = Date.now();

      // Always fetch HTML fresh (no cache)
      const viewsBase = window.VIEWS_BASE_PATH || './views/';
      const response = await fetch(`${viewsBase}${moduleName}.html?v=${v}`, { cache: 'no-store' });
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

  // Módulos del admin-pos (panel remoto): siempre completo
  const ADMIN_POS_MODULES = ['pos', 'cajas', 'productos', 'clientes', 'compras_v2', 'operaciones_stock', 'ordenes', 'proveedores', 'cuenta_corriente_proveedores', 'promociones', 'etiquetas', 'informes', 'gastos', 'usuarios', 'vencimientos', 'roturas', 'consumo_interno', 'adelanto_pago', 'caja_admin', 'configuracion', 'flujo'];

  function getAllowedModules() {
    if (window.ADMIN_MODE) return ADMIN_POS_MODULES;
    const u = window.SGA_Auth.getCurrentUser();
    if (!u) return [];
    // Admin: acceso total
    if (u.rol === 'admin') return ['pos', 'cajas', 'productos', 'clientes', 'operaciones_stock', 'ordenes', 'proveedores', 'cuenta_corriente_proveedores', 'promociones', 'etiquetas', 'informes', 'gastos', 'usuarios', 'caja_admin', 'adelanto_pago'];
    // Colaboradores: según permisos individuales
    const P = window.SGA_Permisos;
    const allowed = ['pos', 'cajas']; // siempre visibles
    if (P.can('can_ver_productos'))     allowed.push('productos');
    if (P.can('can_clientes'))          allowed.push('clientes');
    if (P.can('can_compras'))           allowed.push('compras_v2');
    if (P.can('can_ordenes'))           allowed.push('ordenes');
    if (P.can('can_proveedores'))       allowed.push('proveedores');
    if (P.can('can_cta_cte_proveedores')) allowed.push('cuenta_corriente_proveedores');
    if (P.can('can_operaciones_stock')) allowed.push('operaciones_stock');
    if (P.can('can_consumo_interno'))   allowed.push('consumo_interno');
    if (P.can('can_promociones'))       allowed.push('promociones');
    if (P.can('can_informes'))          allowed.push('informes');
    if (P.can('can_gastos'))            allowed.push('gastos');
    if (P.can('can_etiquetas'))         allowed.push('etiquetas');
    return allowed;
  }

  // ── Guard de rutas ───────────────────────────────────────────────────────────
  // initNav() (abajo) ya filtra qué links aparecen en el menú — pero antes de
  // este guard, el router cargaba CUALQUIER hash sin volver a chequear nada,
  // así que un usuario sin el permiso podía acceder igual escribiendo la URL a
  // mano (ej. #productos, #compras_v2, #proveedores, #gastos). isRouteAllowed()
  // se llama en loadView() antes de renderizar cualquier vista, para que el
  // acceso directo por hash respete los mismos permisos que ya decidían qué se
  // ve en el menú.
  //
  // Rutas admin-pos-only: solo alcanzables desde admin-pos/ (nunca desde el
  // POS local), más allá del rol de quien esté logueado ahí.
  const ROUTE_ADMIN_POS_ONLY = ['configuracion', 'flujo'];
  // Rutas que ya se autoprotegen con su propio chequeo de rol==='admin'
  // adentro del módulo (usuarios.js, configuracion.js, caja_admin.js,
  // adelanto_pago.js) — se listan igual acá para blindaje centralizado.
  const ROUTE_ADMIN_ONLY = ['usuarios', 'caja_admin', 'configuracion', 'adelanto_pago'];
  // Ruta -> permiso granular (SGA_PERMISOS_DEF en auth.js) que hace falta para
  // entrar. Rutas ausentes de este mapa (pos, caja, y cualquier módulo nuevo
  // que se agregue sin actualizar esta lista) quedan sin restricción
  // específica una vez logueado — agregar acá cualquier módulo que necesite
  // permiso propio.
  const ROUTE_PERMISSION = {
    productos:                     'can_ver_productos',
    'editor-producto':             'can_editar_productos',
    clientes:                      'can_clientes',
    compras_v2:                    'can_compras',
    ordenes:                       'can_ordenes',
    proveedores:                   'can_proveedores',
    cuenta_corriente_proveedores:  'can_cta_cte_proveedores',
    operaciones_stock:             'can_operaciones_stock',
    roturas:                       'can_roturas_vencimientos',
    vencimientos:                  'can_roturas_vencimientos',
    consumo_interno:               'can_consumo_interno',
    promociones:                   'can_promociones',
    informes:                      'can_informes',
    gastos:                        'can_gastos',
    etiquetas:                     'can_etiquetas',
  };

  function isRouteAllowed(route) {
    if (ROUTE_ADMIN_POS_ONLY.includes(route) && !window.ADMIN_MODE) return false;
    if (window.ADMIN_MODE) return true; // admin-pos: acceso total, igual que ADMIN_POS_MODULES

    const user = window.SGA_Auth.getCurrentUser();
    if (!user) return false;
    if (user.rol === 'admin') return true; // admin en POS local: acceso total

    if (ROUTE_ADMIN_ONLY.includes(route)) return false;

    const key = ROUTE_PERMISSION[route];
    if (!key) return true; // sin restricción específica (pos, caja, etc.)
    return window.SGA_Permisos.can(key);
  }

  /**
   * Initialize navigation
   */
  function initNav() {
    const navContainer = document.querySelector('aside nav ul');
    // icon: nombre en SGA_Icons (js/icons.js) — sidebar migrada de emoji a
    // SVG de línea en el recorrido UX (ver project_ux_pass_ui_ux_pro_max.md).
    // Los sub-items de "Cajas" siguen mostrando el emoji que el usuario
    // carga por medio de cobro (medios_cobro.icono) — eso es contenido
    // configurable, no un ícono de navegación fijo, y queda fuera de esta
    // pasada a propósito.
    const ic = (name) => window.SGA_Icons ? window.SGA_Icons.get(name, { class: 'nav-icon' }) : '';
    const moduleList = [
      { name: 'pos', icon: 'pos', text: 'Punto de Venta' },
      { name: 'productos', icon: 'productos', text: 'Productos' },
      { name: 'clientes', icon: 'clientes', text: 'Clientes' },
      {
        type: 'group', group: 'cajas', icon: 'cajas', text: 'Cajas',
        items: (() => {
          try {
            const medios = window.SGA_DB.query(
              `SELECT id, nombre, icono FROM medios_cobro WHERE activo = 1 ORDER BY orden ASC, nombre ASC`
            );
            if (medios.length) return medios.map(m => ({
              name: 'caja', medio: m.id, label: `${m.icono || ''} ${m.nombre}`.trim()
            }));
          } catch(e) {}
          return [
            { name: 'caja', medio: 'efectivo',    label: '💵 Efectivo' },
            { name: 'caja', medio: 'mercadopago', label: '📲 Mercado Pago' },
          ];
        })(),
      },
      { name: 'operaciones_stock', icon: 'operaciones_stock', text: 'Operaciones de Stock' },
      { name: 'proveedores', icon: 'proveedores', text: 'Proveedores' },
      { name: 'promociones', icon: 'tag', text: 'Promociones' },
      { name: 'etiquetas', icon: 'tag', text: 'Etiquetas' },
      { name: 'informes', icon: 'informes', text: 'Informes' },
      { name: 'gastos', icon: 'gastos', text: 'Gastos Generales' },
      { name: 'caja_admin', icon: 'briefcase', text: 'Caja Seamus', adminOnly: true },
      { name: 'usuarios', icon: 'usuarios', text: 'Usuarios' },
      { name: 'flujo', icon: 'flujo', text: 'Flujo de Fondos', adminPosOnly: true },
      { name: 'configuracion', icon: 'configuracion', text: 'Configuración', adminOnly: true, adminPosOnly: true },
    ];

    const hasPendingResumen = !!localStorage.getItem('compras_resumen_pending');
    const allowedModules = getAllowedModules();
    const currentHash = window.location.hash.slice(1) || '';
    const [currentRoute, currentMedio] = currentHash.split('/');

    const currentUser = window.SGA_Auth.getCurrentUser();
    const isAdmin = currentUser?.rol === 'admin';

    navContainer.innerHTML = moduleList
      .filter(({ name, type, group, adminOnly, adminPosOnly }) => {
        if (adminPosOnly && !window.ADMIN_MODE) return false;
        if (adminOnly && !isAdmin && !window.ADMIN_MODE) return false;
        const key = type === 'group' ? group : name;
        return allowedModules.includes(key) || adminOnly || (adminPosOnly && window.ADMIN_MODE);
      })
      .map((item) => {
        if (item.type === 'group') {
          const isActive = currentRoute === 'caja';
          const isOpen = cajasGroupOpen === true;
          // Sub-item active only when we have a specific medio
          const subItems = item.items.map(sub => {
            const subActive = isActive && currentMedio === sub.medio ? ' active' : '';
            return `<li><a href="#${sub.name}/${sub.medio}" data-module="${sub.name}" data-medio="${sub.medio}" class="nav-link${subActive}">${sub.label}</a></li>`;
          }).join('');
          // Group label active when on #caja with no medio (overview)
          const groupActive = isActive && !currentMedio ? ' active' : '';
          const toggleClasses = [isOpen ? 'open' : '', isActive ? 'has-active' : ''].filter(Boolean).join(' ');
          return `
            <li>
              <div class="nav-group-toggle${toggleClasses ? ' ' + toggleClasses : ''}" data-group="${item.group}" data-href="#${item.items[0]?.name || 'caja'}">
                <a href="#caja" class="nav-group-label${groupActive}" data-module="caja">${ic(item.icon)}${item.text}</a>
                <span class="nav-group-arrow">▶</span>
              </div>
              <ul class="nav-subitems${isOpen ? ' open' : ''}" id="nav-subitems-${item.group}">
                ${subItems}
              </ul>
            </li>`;
        }
        const { name, icon, text } = item;
        const badge = (name === 'operaciones_stock' && hasPendingResumen)
          ? ' <span style="display:inline-block;background:#ff8f00;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;vertical-align:middle;margin-left:4px;white-space:nowrap;">● Ajuste pendiente</span>'
          : '';
        return `<li><a href="#${name}" data-module="${name}" class="nav-link">${ic(icon)}${text}${badge}</a></li>`;
      }).join('');

    // Arrow-only click: toggle expand/collapse without navigating
    navContainer.querySelectorAll('.nav-group-arrow').forEach(arrow => {
      arrow.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const toggle = arrow.closest('.nav-group-toggle');
        const group = toggle.dataset.group;
        const subList = document.getElementById(`nav-subitems-${group}`);
        const isOpen = toggle.classList.contains('open');
        cajasGroupOpen = !isOpen;
        toggle.classList.toggle('open', !isOpen);
        if (subList) subList.classList.toggle('open', !isOpen);
      });
    });
    // Label click also expands (navigation handled by href on <a>)
    navContainer.querySelectorAll('.nav-group-label').forEach(label => {
      label.addEventListener('click', () => {
        const toggle = label.closest('.nav-group-toggle');
        const group = toggle.dataset.group;
        const subList = document.getElementById(`nav-subitems-${group}`);
        cajasGroupOpen = true;
        toggle.classList.add('open', 'has-active');
        if (subList) subList.classList.add('open');
      });
    });
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
        const loginBase = window.VIEWS_BASE_PATH || './views/';
        const returnTo = window.ADMIN_MODE ? encodeURIComponent('../admin-pos/') : '';
        window.location.href = loginBase + 'login.html' + (returnTo ? '?returnTo=' + returnTo : '');
      });
    }

    const backupBtn = document.getElementById('backup-btn');
    const backupDropdown = document.getElementById('backup-dropdown');
    const backupExportBtn = document.getElementById('backup-export-btn');
    const backupImportInput = document.getElementById('backup-import-input');

    if (backupBtn) {
      backupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        backupDropdown.classList.toggle('open');
      });

      document.addEventListener('click', () => {
        backupDropdown.classList.remove('open');
      });

      backupExportBtn.addEventListener('click', async () => {
        backupDropdown.classList.remove('open');
        try {
          await window.SGA_DB.exportarBackup();
        } catch (err) {
          alert('Error al exportar backup: ' + err.message);
        }
      });

      backupImportInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        backupDropdown.classList.remove('open');
        if (!confirm(`¿Restaurar la base de datos desde "${file.name}"?\n\nSe reemplazarán todos los datos actuales. Esta acción no se puede deshacer.`)) {
          backupImportInput.value = '';
          return;
        }
        try {
          await window.SGA_DB.importarBackup(file);
          alert('Base de datos restaurada correctamente. La página se va a recargar.');
          location.reload();
        } catch (err) {
          alert('Error al restaurar backup: ' + err.message);
        }
        backupImportInput.value = '';
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
    const newHash = window.location.hash.slice(1) || (window.ADMIN_MODE ? 'productos' : 'pos');
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

      // En modo admin-pos: sincronización inicial si la BD está vacía
      if (window.ADMIN_MODE) {
        const productCount = window.SGA_DB.query('SELECT COUNT(*) as n FROM productos');
        const isEmpty = !productCount || productCount[0]?.n === 0;
        if (isEmpty && window.SGA_Sync?.initialSyncFromFirestore) {
          const overlay = document.getElementById('initial-sync-overlay');
          const progressEl = document.getElementById('initial-sync-progress');
          if (overlay) overlay.style.display = 'flex';
          try {
            await window.SGA_Sync.initialSyncFromFirestore((msg) => {
              if (progressEl) progressEl.textContent = msg;
            });
          } catch (e) {
            console.error('Initial sync failed:', e);
            if (progressEl) progressEl.textContent = 'Error en sincronización: ' + e.message;
          }
          if (overlay) overlay.style.display = 'none';
        }
        // Sync periódico normal
        window.SGA_Sync.initialize().catch(() => {});
      } else {
        // POS: sincronización inicial desde Firestore si la BD está vacía (dispositivo nuevo)
        const productCount = window.SGA_DB.query('SELECT COUNT(*) as n FROM productos');
        const isEmpty = !productCount || productCount[0]?.n === 0;
        if (isEmpty && window.SGA_Sync?.initialSyncFromFirestore) {
          const overlay = document.getElementById('initial-sync-overlay');
          const progressEl = document.getElementById('initial-sync-progress');
          if (overlay) overlay.style.display = 'flex';
          try {
            await window.SGA_Sync.initialSyncFromFirestore((msg) => {
              if (progressEl) progressEl.textContent = msg;
            });
          } catch (e) {
            console.warn('Initial sync failed:', e.message);
          }
          if (overlay) overlay.style.display = 'none';
        }
        window.SGA_Sync.initialize().catch(() => {});
      }

      // Initialize navigation
      initNav();

      // Update header
      updateHeader();

      // Los cajeros siempre arrancan en el POS; admin-pos arranca en productos
      if (app.user?.rol === 'cajero' && !window.location.hash) {
        window.location.hash = '#pos';
      } else if (window.ADMIN_MODE && !window.location.hash) {
        window.location.hash = '#productos';
      }

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
