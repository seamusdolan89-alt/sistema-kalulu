/**
 * admin/app.js — Panel de Administración Kalulu
 *
 * - Autenticación con Firebase Auth (email/password)
 * - Lectura en tiempo real de Firestore
 * - Pestañas: Dashboard, Ventas, Caja, Stock, Informes
 */

(function() {
  'use strict';

  let db = null;
  let activeTab = 'dashboard';
  const listeners = []; // unsubscribe functions para limpiar entre tabs

  // ─── Utilidades ──────────────────────────────────────────────────────────────

  function fmt$(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function fmtHora(isoStr) {
    if (!isoStr) return '—';
    try { return new Date(isoStr).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); }
    catch { return isoStr; }
  }

  function fmtFecha(isoStr) {
    if (!isoStr) return '—';
    try { return new Date(isoStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }); }
    catch { return isoStr; }
  }

  function hoyISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function inicioSemanaISO() {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  }

  function inicioMesISO() {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  }

  function clearListeners() {
    listeners.forEach(unsub => { try { unsub(); } catch (_) {} });
    listeners.length = 0;
  }

  function medioLabel(medio) {
    return { efectivo: 'Efectivo', mercadopago: 'Mercado Pago', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cuenta_corriente: 'Cta. Cte.' }[medio] || medio;
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────────

  function init() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || cfg.apiKey.startsWith('REEMPLAZAR')) {
      document.getElementById('login-screen').innerHTML = `
        <div class="login-card">
          <div class="login-logo">⚙️</div>
          <h1 class="login-title">Configuración pendiente</h1>
          <p class="login-subtitle">Completar <code>js/firebase-config.js</code> con las credenciales del proyecto Firebase antes de usar el panel admin.</p>
        </div>`;
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(cfg);
    }
    db = firebase.firestore();

    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        showApp();
      } else {
        showLogin();
      }
    });
  }

  // ─── Login ───────────────────────────────────────────────────────────────────

  function showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    navigateTo('dashboard');
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const errDiv = document.getElementById('login-error');
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-password').value;

    btn.disabled = true;
    btn.textContent = 'Ingresando...';
    errDiv.style.display = 'none';

    try {
      await firebase.auth().signInWithEmailAndPassword(email, pass);
      // onAuthStateChanged se encarga del resto
    } catch (err) {
      errDiv.textContent = err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found'
        ? 'Email o contraseña incorrectos'
        : err.message;
      errDiv.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Ingresar';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    firebase.auth().signOut();
  });

  // ─── Navegación entre tabs ───────────────────────────────────────────────────

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.tab);
    });
  });

  function navigateTo(tab) {
    activeTab = tab;
    clearListeners();

    document.querySelectorAll('.nav-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });

    const tpl = document.getElementById(`tpl-${tab}`);
    const main = document.getElementById('main-content');
    main.innerHTML = '';
    main.appendChild(tpl.content.cloneNode(true));

    switch (tab) {
      case 'dashboard': loadDashboard(); break;
      case 'ventas':    loadVentas('hoy'); break;
      case 'caja':      loadCaja(); break;
      case 'stock':     loadStock(); break;
      case 'informes':  initInformes(); break;
    }
  }

  // ─── DASHBOARD ───────────────────────────────────────────────────────────────

  function loadDashboard() {
    const hoy = hoyISO();

    document.getElementById('dash-fecha').textContent =
      new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

    // Ventas del día — listener en tiempo real
    const unsubVentas = db.collection('ventas')
      .where('fecha', '>=', hoy)
      .where('estado', '==', 'completada')
      .orderBy('fecha', 'desc')
      .onSnapshot(snap => {
        const ventas = snap.docs.map(d => d.data());

        const totalVentas = ventas.reduce((s, v) => s + (v.total || 0), 0);
        const ticketProm  = ventas.length > 0 ? totalVentas / ventas.length : 0;

        document.getElementById('kpi-ventas-total').textContent  = fmt$(totalVentas);
        document.getElementById('kpi-ventas-count').textContent  = `${ventas.length} transacciones`;
        document.getElementById('kpi-ticket-prom').textContent   = fmt$(ticketProm);

        // Últimas 5
        const recientes = ventas.slice(0, 5);
        const container = document.getElementById('dash-ventas-recientes');
        if (!container) return;
        container.innerHTML = recientes.length === 0
          ? '<div class="empty-state">Sin ventas hoy</div>'
          : recientes.map(v => renderVentaCard(v)).join('');
      }, err => console.error('dash ventas:', err));

    listeners.push(unsubVentas);

    // Sesión de caja activa
    const unsubCaja = db.collection('sesiones_caja')
      .where('estado', '==', 'abierta')
      .limit(1)
      .onSnapshot(snap => {
        const el = document.getElementById('kpi-caja-efectivo');
        const sub = document.getElementById('kpi-caja-estado');
        if (!el) return;
        if (snap.empty) {
          el.textContent = '—';
          sub.textContent = 'Caja cerrada';
          sub.style.color = 'var(--color-danger)';
        } else {
          const s = snap.docs[0].data();
          el.textContent = fmt$(s.total_efectivo || 0);
          sub.textContent = `Abierta ${fmtHora(s.fecha_apertura)}`;
          sub.style.color = 'var(--color-success)';
        }
      }, err => console.error('dash caja:', err));

    listeners.push(unsubCaja);

    // Stock en alerta
    const unsubStock = db.collection('stock')
      .onSnapshot(snap => {
        const el = document.getElementById('kpi-stock-alertas');
        if (!el) return;
        const alertas = snap.docs.filter(d => {
          const s = d.data();
          return s.stock_alerta > 0 && (s.cantidad || 0) <= s.stock_alerta;
        });
        el.textContent = alertas.length;
        el.parentElement.style.background = alertas.length > 0 ? 'var(--accent-orange)' : 'var(--card-bg)';
      }, err => console.error('dash stock:', err));

    listeners.push(unsubStock);
  }

  // ─── VENTAS ──────────────────────────────────────────────────────────────────

  function loadVentas(periodo) {
    const desde = periodo === 'hoy' ? hoyISO() : periodo === 'semana' ? inicioSemanaISO() : inicioMesISO();

    // Chips de filtro
    document.querySelectorAll('.chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.periodo === periodo);
      chip.addEventListener('click', () => {
        clearListeners();
        loadVentas(chip.dataset.periodo);
      });
    });

    const unsub = db.collection('ventas')
      .where('fecha', '>=', desde)
      .where('estado', '==', 'completada')
      .orderBy('fecha', 'desc')
      .limit(100)
      .onSnapshot(snap => {
        const ventas = snap.docs.map(d => d.data());
        const totalGral = ventas.reduce((s, v) => s + (v.total || 0), 0);

        const resumen = document.getElementById('ventas-resumen');
        if (resumen) {
          resumen.innerHTML = `
            <div class="resumen-item"><span class="resumen-label">Total</span><span class="resumen-val">${fmt$(totalGral)}</span></div>
            <div class="resumen-item"><span class="resumen-label">Cantidad</span><span class="resumen-val">${ventas.length}</span></div>
          `;
        }

        const list = document.getElementById('ventas-list');
        if (!list) return;
        list.innerHTML = ventas.length === 0
          ? '<div class="empty-state">Sin ventas en este período</div>'
          : ventas.map(v => renderVentaCard(v, true)).join('');
      }, err => console.error('ventas:', err));

    listeners.push(unsub);
  }

  function renderVentaCard(v, showFecha = false) {
    const pagos = (v.pagos || []).map(p => `${medioLabel(p.medio)} ${fmt$(p.monto)}`).join(' · ');
    const fecha = showFecha ? `${fmtFecha(v.fecha)} ` : '';
    const cliente = v.cliente_nombre ? `<span class="tag">${v.cliente_nombre}</span>` : '';
    return `
      <div class="list-card">
        <div class="list-card-main">
          <span class="list-card-title">${fmt$(v.total)}</span>
          ${cliente}
        </div>
        <div class="list-card-sub">${fecha}${fmtHora(v.fecha)} · ${pagos || '—'}</div>
      </div>`;
  }

  // ─── CAJA ────────────────────────────────────────────────────────────────────

  function loadCaja() {
    const hoy = hoyISO();

    const unsub = db.collection('sesiones_caja')
      .where('fecha_apertura', '>=', hoy)
      .orderBy('fecha_apertura', 'desc')
      .limit(1)
      .onSnapshot(snap => {
        const badge = document.getElementById('caja-estado-badge');
        const grid  = document.getElementById('caja-medios-grid');
        if (!badge || !grid) return;

        if (snap.empty) {
          badge.textContent = 'Cerrada';
          badge.className = 'badge badge-red';
          grid.innerHTML = '<div class="empty-state">No hay sesión de caja abierta hoy</div>';
          return;
        }

        const s = snap.docs[0].data();
        const abierta = s.estado === 'abierta';
        badge.textContent = abierta ? `Abierta ${fmtHora(s.fecha_apertura)}` : `Cerrada ${fmtHora(s.fecha_cierre)}`;
        badge.className = `badge ${abierta ? 'badge-green' : 'badge-gray'}`;

        const medios = [
          { key: 'total_efectivo',       label: 'Efectivo',       icon: '💵' },
          { key: 'total_mercadopago',    label: 'Mercado Pago',   icon: '📲' },
          { key: 'total_tarjeta',        label: 'Tarjeta',        icon: '💳' },
          { key: 'total_transferencia',  label: 'Transferencia',  icon: '🏦' },
          { key: 'total_cuenta_corriente', label: 'Cta. Cte.',   icon: '📒' },
        ];

        const total = medios.reduce((sum, m) => sum + (s[m.key] || 0), 0);

        grid.innerHTML = `
          ${medios.map(m => `
            <div class="medio-card">
              <div class="medio-icon">${m.icon}</div>
              <div class="medio-label">${m.label}</div>
              <div class="medio-val">${fmt$(s[m.key] || 0)}</div>
            </div>`).join('')}
          <div class="medio-card medio-total">
            <div class="medio-icon">Σ</div>
            <div class="medio-label">Total</div>
            <div class="medio-val">${fmt$(total)}</div>
          </div>
        `;

        // Egresos
        loadEgresos(snap.docs[0].id);
      }, err => console.error('caja:', err));

    listeners.push(unsub);
  }

  function loadEgresos(sesionId) {
    const unsubEg = db.collection('egresos_caja')
      .where('sesion_caja_id', '==', sesionId)
      .orderBy('fecha', 'desc')
      .onSnapshot(snap => {
        const list = document.getElementById('caja-egresos-list');
        if (!list) return;
        const egresos = snap.docs.map(d => d.data());
        list.innerHTML = egresos.length === 0
          ? '<div class="empty-state">Sin egresos</div>'
          : egresos.map(e => `
              <div class="list-card">
                <div class="list-card-main">
                  <span class="list-card-title">${fmt$(e.monto)}</span>
                  <span class="list-card-sub">${e.descripcion || ''}</span>
                </div>
                <div class="list-card-time">${fmtHora(e.fecha)}</div>
              </div>`).join('');
      }, err => console.error('egresos:', err));

    listeners.push(unsubEg);
  }

  // ─── STOCK ───────────────────────────────────────────────────────────────────

  function loadStock() {
    const unsub = db.collection('stock')
      .onSnapshot(snap => {
        const list = document.getElementById('stock-list');
        if (!list) return;

        const alertas = snap.docs
          .map(d => d.data())
          .filter(s => s.stock_alerta > 0 && (s.cantidad || 0) <= s.stock_alerta)
          .sort((a, b) => (a.cantidad || 0) - (b.cantidad || 0));

        list.innerHTML = alertas.length === 0
          ? '<div class="empty-state">No hay productos con stock bajo</div>'
          : alertas.map(s => {
              const pct = s.stock_alerta > 0 ? Math.max(0, Math.round((s.cantidad / s.stock_alerta) * 100)) : 0;
              const color = s.cantidad <= 0 ? 'bar-red' : pct < 50 ? 'bar-orange' : 'bar-yellow';
              return `
                <div class="list-card">
                  <div class="list-card-main">
                    <span class="list-card-title">${s.producto_nombre || s.producto_id}</span>
                    <span class="stock-qty ${s.cantidad <= 0 ? 'qty-zero' : ''}">${s.cantidad}</span>
                  </div>
                  <div class="stock-bar-wrap">
                    <div class="stock-bar ${color}" style="width:${Math.min(100, pct)}%"></div>
                  </div>
                  <div class="list-card-sub">Mínimo: ${s.stock_minimo} · Alerta: ${s.stock_alerta}</div>
                </div>`;
            }).join('');
      }, err => console.error('stock:', err));

    listeners.push(unsub);
  }

  // ─── INFORMES ────────────────────────────────────────────────────────────────

  const infState = {
    reporte: 'resumen_diario',
    desde: '',
    hasta: '',
  };

  function infDefaultDesde() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
  }
  function infDefaultHasta() {
    return new Date().toISOString().slice(0, 10);
  }
  function infAddDay(dateStr, n = 1) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function infFmtFecha(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  function infEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function infFmt$(n) { return fmt$(n); }
  function infFmtN(n, d = 0) {
    return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function initInformes() {
    infState.desde = infDefaultDesde();
    infState.hasta = infDefaultHasta();

    const desdeEl = document.getElementById('inf-desde');
    const hastaEl = document.getElementById('inf-hasta');
    if (desdeEl) desdeEl.value = infState.desde;
    if (hastaEl) hastaEl.value = infState.hasta;

    document.getElementById('inf-generar')?.addEventListener('click', runInforme);
    document.getElementById('inf-reporte')?.addEventListener('change', e => { infState.reporte = e.target.value; });
    desdeEl?.addEventListener('change', e => { infState.desde = e.target.value; });
    hastaEl?.addEventListener('change', e => { infState.hasta = e.target.value; });

    document.querySelectorAll('.inf-quick-row .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.inf-quick-row .chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setInfPeriod(btn.dataset.period);
      });
    });
  }

  function setInfPeriod(period) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    if (period === 'hoy') {
      infState.desde = infState.hasta = now.toISOString().slice(0, 10);
    } else if (period === 'semana') {
      const mon = new Date(now);
      mon.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
      infState.desde = mon.toISOString().slice(0, 10);
      infState.hasta = now.toISOString().slice(0, 10);
    } else if (period === 'mes') {
      infState.desde = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
      infState.hasta = now.toISOString().slice(0, 10);
    } else if (period === 'mes_ant') {
      const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const ul = new Date(now.getFullYear(), now.getMonth(), 0);
      infState.desde = pm.toISOString().slice(0, 10);
      infState.hasta = ul.toISOString().slice(0, 10);
    } else if (period === 'anio') {
      infState.desde = `${now.getFullYear()}-01-01`;
      infState.hasta = now.toISOString().slice(0, 10);
    }
    const desdeEl = document.getElementById('inf-desde');
    const hastaEl = document.getElementById('inf-hasta');
    if (desdeEl) desdeEl.value = infState.desde;
    if (hastaEl) hastaEl.value = infState.hasta;
  }

  async function runInforme() {
    infState.reporte = document.getElementById('inf-reporte')?.value || infState.reporte;
    infState.desde   = document.getElementById('inf-desde')?.value  || infState.desde;
    infState.hasta   = document.getElementById('inf-hasta')?.value  || infState.hasta;

    const results = document.getElementById('inf-results');
    if (!results) return;
    results.innerHTML = `<div class="inf-loading">Generando reporte...</div>`;

    try {
      switch (infState.reporte) {
        case 'resumen_diario':    await infResumenDiario(results); break;
        case 'ventas_producto':   await infVentasProducto(results); break;
        case 'ventas_transaccion':await infVentasTransaccion(results); break;
        case 'ventas_vendedor':   await infVentasVendedor(results); break;
        case 'gastos':            await infGastos(results); break;
        case 'aging_cc':          await infAgingCC(results); break;
        case 'stock_actual':      await infStockActual(results); break;
        default: results.innerHTML = '<div class="inf-error">Reporte no reconocido</div>';
      }
    } catch (err) {
      console.error('Informe error:', err);
      results.innerHTML = `<div class="inf-error">Error: ${infEsc(err.message)}</div>`;
    }
  }

  // Helper: fetch ventas en período
  async function fetchVentas(desde, hasta) {
    const desdeISO = desde + 'T00:00:00.000Z';
    const hastaISO = infAddDay(hasta) + 'T00:00:00.000Z';
    const snap = await db.collection('ventas')
      .where('estado', '==', 'completada')
      .where('fecha', '>=', desdeISO)
      .where('fecha', '<', hastaISO)
      .orderBy('fecha', 'desc')
      .get();
    return snap.docs.map(d => d.data());
  }

  function infReportHeader(titulo, rows, exportFn) {
    const periodo = `${infFmtFecha(infState.desde)} al ${infFmtFecha(infState.hasta)}`;
    return `
      <div class="inf-report-header">
        <div>
          <div class="inf-report-title">${infEsc(titulo)}</div>
          <div class="inf-report-periodo">Período: ${periodo} · ${rows} registros</div>
        </div>
        <button class="inf-excel-btn" id="inf-export-btn">↓ Excel</button>
      </div>`;
  }

  // ── Resumen Diario ────────────────────────────────────────────────────────────

  async function infResumenDiario(container) {
    const ventas = await fetchVentas(infState.desde, infState.hasta);
    const desdeISO = infState.desde + 'T00:00:00.000Z';
    const hastaISO = infAddDay(infState.hasta) + 'T00:00:00.000Z';

    const egSnap = await db.collection('egresos_caja')
      .where('fecha', '>=', desdeISO)
      .where('fecha', '<', hastaISO)
      .get();
    const egresos = egSnap.docs.map(d => d.data());

    // Agrupar por día
    const diasMap = {};
    ventas.forEach(v => {
      const dia = v.fecha.slice(0, 10);
      if (!diasMap[dia]) diasMap[dia] = { dia, efectivo: 0, mercadopago: 0, tarjeta: 0, transferencia: 0, cta_cte: 0, total_cobrado: 0, num_ventas: 0, egresos: 0 };
      diasMap[dia].num_ventas++;
      (v.pagos || []).forEach(p => {
        if (p.medio === 'efectivo')        diasMap[dia].efectivo       += p.monto;
        else if (p.medio === 'mercadopago') diasMap[dia].mercadopago   += p.monto;
        else if (p.medio === 'tarjeta')     diasMap[dia].tarjeta       += p.monto;
        else if (p.medio === 'transferencia') diasMap[dia].transferencia += p.monto;
        else if (p.medio === 'cuenta_corriente') diasMap[dia].cta_cte  += p.monto;
        if (p.medio !== 'cuenta_corriente') diasMap[dia].total_cobrado += p.monto;
      });
    });
    egresos.forEach(e => {
      const dia = (e.fecha || '').slice(0, 10);
      if (diasMap[dia]) diasMap[dia].egresos += e.monto || 0;
    });

    const rows = Object.values(diasMap).sort((a, b) => a.dia < b.dia ? -1 : 1);
    const tot = rows.reduce((s, r) => ({
      efectivo: s.efectivo + r.efectivo, mercadopago: s.mercadopago + r.mercadopago,
      tarjeta: s.tarjeta + r.tarjeta, transferencia: s.transferencia + r.transferencia,
      cta_cte: s.cta_cte + r.cta_cte, total_cobrado: s.total_cobrado + r.total_cobrado,
      egresos: s.egresos + r.egresos, num_ventas: s.num_ventas + r.num_ventas,
    }), { efectivo: 0, mercadopago: 0, tarjeta: 0, transferencia: 0, cta_cte: 0, total_cobrado: 0, egresos: 0, num_ventas: 0 });

    container.innerHTML = infReportHeader('Resumen Diario de Caja', rows.length, null) + `
      <div class="inf-table-wrap">
        <table class="inf-table">
          <thead><tr>
            <th>Fecha</th><th>Ventas</th><th class="num">Efectivo</th>
            <th class="num">M.Pago</th><th class="num">Tarjeta</th>
            <th class="num">Transfer.</th><th class="num">Cta.Cte.</th>
            <th class="num">Egresos</th><th class="num bold">Total cobrado</th>
            <th class="num">Neto</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${infFmtFecha(r.dia)}</td>
              <td class="num">${r.num_ventas}</td>
              <td class="num">${infFmt$(r.efectivo)}</td>
              <td class="num">${infFmt$(r.mercadopago)}</td>
              <td class="num">${infFmt$(r.tarjeta)}</td>
              <td class="num">${infFmt$(r.transferencia)}</td>
              <td class="num">${infFmt$(r.cta_cte)}</td>
              <td class="num text-danger">${infFmt$(r.egresos)}</td>
              <td class="num bold">${infFmt$(r.total_cobrado)}</td>
              <td class="num ${r.total_cobrado - r.egresos >= 0 ? 'text-success' : 'text-danger'}">${infFmt$(r.total_cobrado - r.egresos)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td>TOTAL</td><td class="num">${tot.num_ventas}</td>
            <td class="num">${infFmt$(tot.efectivo)}</td>
            <td class="num">${infFmt$(tot.mercadopago)}</td>
            <td class="num">${infFmt$(tot.tarjeta)}</td>
            <td class="num">${infFmt$(tot.transferencia)}</td>
            <td class="num">${infFmt$(tot.cta_cte)}</td>
            <td class="num text-danger">${infFmt$(tot.egresos)}</td>
            <td class="num bold">${infFmt$(tot.total_cobrado)}</td>
            <td class="num bold">${infFmt$(tot.total_cobrado - tot.egresos)}</td>
          </tr></tfoot>
        </table>
      </div>`;

    document.getElementById('inf-export-btn')?.addEventListener('click', () => {
      exportExcel('Resumen_Diario', [
        ['Fecha','Ventas','Efectivo','MercadoPago','Tarjeta','Transferencia','Cta.Cte.','Egresos','Total Cobrado','Neto'],
        ...rows.map(r => [r.dia, r.num_ventas, r.efectivo, r.mercadopago, r.tarjeta, r.transferencia, r.cta_cte, r.egresos, r.total_cobrado, r.total_cobrado - r.egresos]),
        ['TOTAL', tot.num_ventas, tot.efectivo, tot.mercadopago, tot.tarjeta, tot.transferencia, tot.cta_cte, tot.egresos, tot.total_cobrado, tot.total_cobrado - tot.egresos],
      ]);
    });
  }

  // ── Ventas por Producto ───────────────────────────────────────────────────────

  async function infVentasProducto(container) {
    const ventas = await fetchVentas(infState.desde, infState.hasta);

    const prodMap = {};
    ventas.forEach(v => {
      (v.items || []).forEach(item => {
        const pid = item.producto_id;
        if (!pid) return;
        if (!prodMap[pid]) prodMap[pid] = {
          nombre: item.producto_nombre || pid,
          categoria: item.categoria_nombre || '—',
          cant: 0, costo_total: 0, venta_total: 0,
        };
        prodMap[pid].cant        += item.cantidad || 0;
        prodMap[pid].costo_total += (item.cantidad || 0) * (item.costo_unitario || 0);
        prodMap[pid].venta_total += item.subtotal || 0;
      });
    });

    const rows = Object.values(prodMap)
      .map(r => ({ ...r, utilidad: r.venta_total - r.costo_total, margen: r.venta_total > 0 ? ((r.venta_total - r.costo_total) / r.venta_total * 100) : 0 }))
      .sort((a, b) => b.venta_total - a.venta_total);

    const tot = rows.reduce((s, r) => ({ cant: s.cant + r.cant, costo: s.costo + r.costo_total, venta: s.venta + r.venta_total, util: s.util + r.utilidad }), { cant: 0, costo: 0, venta: 0, util: 0 });

    container.innerHTML = infReportHeader('Ventas por Producto', rows.length, null) + `
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Productos</div><div class="inf-kpi-val">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Venta total</div><div class="inf-kpi-val">${infFmt$(tot.venta)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Costo total</div><div class="inf-kpi-val">${infFmt$(tot.costo)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Utilidad</div><div class="inf-kpi-val ${tot.util>=0?'text-success':'text-danger'}">${infFmt$(tot.util)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Margen prom.</div><div class="inf-kpi-val">${tot.venta>0?((tot.util/tot.venta)*100).toFixed(1):0}%</div></div>
      </div>
      <div class="inf-table-wrap">
        <table class="inf-table">
          <thead><tr>
            <th>Producto</th><th>Categoría</th>
            <th class="num">Cant.</th><th class="num">Costo total</th>
            <th class="num">Venta total</th><th class="num">Utilidad</th><th class="num">Margen</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${infEsc(r.nombre)}</td>
              <td>${infEsc(r.categoria)}</td>
              <td class="num">${infFmtN(r.cant, 0)}</td>
              <td class="num">${infFmt$(r.costo_total)}</td>
              <td class="num bold">${infFmt$(r.venta_total)}</td>
              <td class="num ${r.utilidad>=0?'text-success':'text-danger'}">${infFmt$(r.utilidad)}</td>
              <td class="num">${r.margen.toFixed(1)}%</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="2">TOTAL</td>
            <td class="num">${infFmtN(tot.cant,0)}</td>
            <td class="num">${infFmt$(tot.costo)}</td>
            <td class="num bold">${infFmt$(tot.venta)}</td>
            <td class="num bold ${tot.util>=0?'text-success':'text-danger'}">${infFmt$(tot.util)}</td>
            <td class="num">${tot.venta>0?((tot.util/tot.venta)*100).toFixed(1):0}%</td>
          </tr></tfoot>
        </table>
      </div>`;

    document.getElementById('inf-export-btn')?.addEventListener('click', () => {
      exportExcel('Ventas_por_Producto', [
        ['Producto','Categoría','Cantidad','Costo Total','Venta Total','Utilidad','Margen %'],
        ...rows.map(r => [r.nombre, r.categoria, r.cant, r.costo_total, r.venta_total, r.utilidad, r.margen.toFixed(1)]),
      ]);
    });
  }

  // ── Ventas por Transacción ────────────────────────────────────────────────────

  async function infVentasTransaccion(container) {
    const ventas = await fetchVentas(infState.desde, infState.hasta);

    const tot = ventas.reduce((s, v) => s + (v.total || 0), 0);

    container.innerHTML = infReportHeader('Ventas por Transacción', ventas.length, null) + `
      <div class="inf-table-wrap">
        <table class="inf-table">
          <thead><tr>
            <th>Fecha</th><th>Hora</th><th>Vendedor</th><th>Cliente</th>
            <th class="num">Subtotal</th><th class="num">Descuento</th>
            <th class="num bold">Total</th><th>Medios de pago</th>
          </tr></thead>
          <tbody>
            ${ventas.map(v => {
              const pagosStr = (v.pagos||[]).map(p => `${medioLabel(p.medio)} ${infFmt$(p.monto)}`).join(' · ');
              return `<tr>
                <td>${infFmtFecha(v.fecha)}</td>
                <td>${fmtHora(v.fecha)}</td>
                <td>${infEsc(v.usuario_nombre || '—')}</td>
                <td>${infEsc(v.cliente_nombre || '—')}</td>
                <td class="num">${infFmt$(v.subtotal)}</td>
                <td class="num">${infFmt$(v.descuento || 0)}</td>
                <td class="num bold">${infFmt$(v.total)}</td>
                <td class="small">${infEsc(pagosStr)}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="6">TOTAL (${ventas.length} ventas)</td>
            <td class="num bold">${infFmt$(tot)}</td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>`;

    document.getElementById('inf-export-btn')?.addEventListener('click', () => {
      exportExcel('Ventas_por_Transaccion', [
        ['Fecha','Hora','Vendedor','Cliente','Subtotal','Descuento','Total','Medios de pago'],
        ...ventas.map(v => [
          v.fecha.slice(0,10), fmtHora(v.fecha),
          v.usuario_nombre || '', v.cliente_nombre || '',
          v.subtotal, v.descuento || 0, v.total,
          (v.pagos||[]).map(p => `${p.medio}: ${p.monto}`).join(' | '),
        ]),
      ]);
    });
  }

  // ── Ventas por Vendedor ───────────────────────────────────────────────────────

  async function infVentasVendedor(container) {
    const ventas = await fetchVentas(infState.desde, infState.hasta);

    const vendMap = {};
    ventas.forEach(v => {
      const uid = v.usuario_id || 'unknown';
      if (!vendMap[uid]) vendMap[uid] = { nombre: v.usuario_nombre || uid, num: 0, total: 0, descuentos: 0 };
      vendMap[uid].num++;
      vendMap[uid].total      += v.total || 0;
      vendMap[uid].descuentos += v.descuento || 0;
    });

    const rows = Object.values(vendMap).sort((a, b) => b.total - a.total);
    const tot = rows.reduce((s, r) => ({ num: s.num + r.num, total: s.total + r.total, desc: s.desc + r.descuentos }), { num: 0, total: 0, desc: 0 });

    container.innerHTML = infReportHeader('Ventas por Vendedor', rows.length, null) + `
      <div class="inf-table-wrap">
        <table class="inf-table">
          <thead><tr>
            <th>Vendedor</th><th class="num">Nº ventas</th>
            <th class="num">Descuentos</th><th class="num bold">Total vendido</th>
            <th class="num">Ticket prom.</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${infEsc(r.nombre)}</td>
              <td class="num">${r.num}</td>
              <td class="num">${infFmt$(r.descuentos)}</td>
              <td class="num bold">${infFmt$(r.total)}</td>
              <td class="num">${infFmt$(r.num > 0 ? r.total / r.num : 0)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td>TOTAL</td>
            <td class="num">${tot.num}</td>
            <td class="num">${infFmt$(tot.desc)}</td>
            <td class="num bold">${infFmt$(tot.total)}</td>
            <td class="num">${infFmt$(tot.num > 0 ? tot.total / tot.num : 0)}</td>
          </tr></tfoot>
        </table>
      </div>`;

    document.getElementById('inf-export-btn')?.addEventListener('click', () => {
      exportExcel('Ventas_por_Vendedor', [
        ['Vendedor','Nº Ventas','Descuentos','Total Vendido','Ticket Promedio'],
        ...rows.map(r => [r.nombre, r.num, r.descuentos, r.total, r.num > 0 ? r.total / r.num : 0]),
      ]);
    });
  }

  // ── Gastos ────────────────────────────────────────────────────────────────────

  async function infGastos(container) {
    const desdeISO = infState.desde + 'T00:00:00.000Z';
    const hastaISO = infAddDay(infState.hasta) + 'T00:00:00.000Z';
    const snap = await db.collection('gastos')
      .where('fecha', '>=', desdeISO)
      .where('fecha', '<', hastaISO)
      .orderBy('fecha', 'desc')
      .get();
    const rows = snap.docs.map(d => d.data());

    // Agrupar por categoría
    const catMap = {};
    rows.forEach(g => {
      const c = g.categoria || 'Sin categoría';
      catMap[c] = (catMap[c] || 0) + (g.monto || 0);
    });
    const catRows = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    const tot = rows.reduce((s, g) => s + (g.monto || 0), 0);

    container.innerHTML = infReportHeader('Gastos del Período', rows.length, null) + `
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Total gastos</div><div class="inf-kpi-val text-danger">${infFmt$(tot)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Categorías</div><div class="inf-kpi-val">${catRows.length}</div></div>
      </div>
      <div class="inf-table-wrap">
        <table class="inf-table">
          <thead><tr>
            <th>Fecha</th><th>Categoría</th><th>Descripción</th>
            <th>Método pago</th><th class="num bold">Monto</th>
          </tr></thead>
          <tbody>
            ${rows.map(g => `<tr>
              <td>${infFmtFecha(g.fecha)}</td>
              <td>${infEsc(g.categoria || '—')}</td>
              <td>${infEsc(g.descripcion || '—')}</td>
              <td>${infEsc(g.metodo_pago || '—')}</td>
              <td class="num text-danger">${infFmt$(g.monto)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="4">TOTAL</td>
            <td class="num bold text-danger">${infFmt$(tot)}</td>
          </tr></tfoot>
        </table>
      </div>`;

    document.getElementById('inf-export-btn')?.addEventListener('click', () => {
      exportExcel('Gastos', [
        ['Fecha','Categoría','Descripción','Método pago','Monto'],
        ...rows.map(g => [g.fecha?.slice(0,10), g.categoria, g.descripcion, g.metodo_pago, g.monto]),
        ['TOTAL','','','', tot],
      ]);
    });
  }

  // ── Aging Cuenta Corriente ────────────────────────────────────────────────────

  async function infAgingCC(container) {
    const snap = await db.collection('cuenta_corriente').get();
    const movs = snap.docs.map(d => d.data());

    // Agrupar por cliente
    const clienteMap = {};
    movs.forEach(m => {
      const cid = m.cliente_id;
      if (!cid) return;
      if (!clienteMap[cid]) clienteMap[cid] = {
        nombre: m.cliente_nombre || cid,
        telefono: m.cliente_telefono || '',
        balance: 0,
        ultima_compra: null,
        ultimo_pago: null,
      };
      clienteMap[cid].balance += m.monto || 0;
      if (m.tipo === 'venta_fiada') {
        if (!clienteMap[cid].ultima_compra || m.fecha > clienteMap[cid].ultima_compra)
          clienteMap[cid].ultima_compra = m.fecha;
      }
      if (m.tipo === 'pago') {
        if (!clienteMap[cid].ultimo_pago || m.fecha > clienteMap[cid].ultimo_pago)
          clienteMap[cid].ultimo_pago = m.fecha;
      }
    });

    const rows = Object.values(clienteMap)
      .filter(r => r.balance > 0.01)
      .sort((a, b) => b.balance - a.balance);

    const tot = rows.reduce((s, r) => s + r.balance, 0);

    container.innerHTML = infReportHeader('Aging Cuenta Corriente', rows.length, null) + `
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Clientes deudores</div><div class="inf-kpi-val">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Deuda total</div><div class="inf-kpi-val text-danger">${infFmt$(tot)}</div></div>
      </div>
      <div class="inf-table-wrap">
        <table class="inf-table">
          <thead><tr>
            <th>Cliente</th><th>Teléfono</th>
            <th class="num bold">Saldo deudor</th>
            <th>Última compra</th><th>Último pago</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${infEsc(r.nombre)}</td>
              <td>${infEsc(r.telefono)}</td>
              <td class="num bold text-danger">${infFmt$(r.balance)}</td>
              <td>${infFmtFecha(r.ultima_compra?.slice(0,10))}</td>
              <td>${infFmtFecha(r.ultimo_pago?.slice(0,10))}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="2">TOTAL</td>
            <td class="num bold text-danger">${infFmt$(tot)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
      </div>`;

    document.getElementById('inf-export-btn')?.addEventListener('click', () => {
      exportExcel('Aging_CuentaCorriente', [
        ['Cliente','Teléfono','Saldo Deudor','Última Compra','Último Pago'],
        ...rows.map(r => [r.nombre, r.telefono, r.balance, r.ultima_compra?.slice(0,10), r.ultimo_pago?.slice(0,10)]),
        ['TOTAL','', tot,'',''],
      ]);
    });
  }

  // ── Stock Actual ──────────────────────────────────────────────────────────────

  async function infStockActual(container) {
    const snap = await db.collection('stock').get();
    const rows = snap.docs.map(d => d.data())
      .filter(s => s.producto_nombre)
      .sort((a, b) => (a.producto_nombre || '').localeCompare(b.producto_nombre || ''));

    const sinStock   = rows.filter(r => (r.cantidad || 0) <= 0).length;
    const enAlerta   = rows.filter(r => r.stock_alerta > 0 && (r.cantidad || 0) <= r.stock_alerta && (r.cantidad || 0) > 0).length;
    const conStock   = rows.filter(r => (r.cantidad || 0) > 0).length;

    container.innerHTML = infReportHeader('Stock Actual', rows.length, null) + `
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Con stock</div><div class="inf-kpi-val text-success">${conStock}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">En alerta</div><div class="inf-kpi-val text-warning">${enAlerta}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Sin stock</div><div class="inf-kpi-val text-danger">${sinStock}</div></div>
      </div>
      <div class="inf-table-wrap">
        <table class="inf-table">
          <thead><tr>
            <th>Producto</th>
            <th class="num">Stock actual</th><th class="num">Stock mínimo</th><th class="num">Alerta</th>
            <th>Estado</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => {
              const qty = r.cantidad || 0;
              const estado = qty <= 0 ? '<span class="badge-inf danger">Sin stock</span>'
                : r.stock_alerta > 0 && qty <= r.stock_alerta ? '<span class="badge-inf warning">Alerta</span>'
                : '<span class="badge-inf ok">OK</span>';
              return `<tr>
                <td>${infEsc(r.producto_nombre)}</td>
                <td class="num ${qty <= 0 ? 'text-danger' : qty <= (r.stock_alerta||0) ? 'text-warning' : ''}">${infFmtN(qty,0)}</td>
                <td class="num">${infFmtN(r.stock_minimo||0,0)}</td>
                <td class="num">${infFmtN(r.stock_alerta||0,0)}</td>
                <td>${estado}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    document.getElementById('inf-export-btn')?.addEventListener('click', () => {
      exportExcel('Stock_Actual', [
        ['Producto','Stock Actual','Stock Mínimo','Stock Alerta'],
        ...rows.map(r => [r.producto_nombre, r.cantidad||0, r.stock_minimo||0, r.stock_alerta||0]),
      ]);
    });
  }

  // ── Exportar Excel ────────────────────────────────────────────────────────────

  function exportExcel(nombre, data) {
    if (typeof XLSX === 'undefined') { alert('SheetJS no disponible'); return; }
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, nombre.slice(0, 31));
    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `${nombre}_${fecha}.xlsx`);
  }

  // ─── Start ───────────────────────────────────────────────────────────────────

  init();

})();
