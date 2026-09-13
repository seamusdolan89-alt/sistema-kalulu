/**
 * inicio.js — Dashboard de accesos rápidos + KPIs del día a día.
 *
 * Nombrado "inicio" y no "dashboard" a propósito: pos.js ya usa ese nombre
 * para su pantalla de reposo interna (enterDashboard/loadDashboard/
 * finalizeSaleAndGoDashboard) y no tiene relación con esta vista.
 *
 * Landing page del POS del local (ver app.js) — cualquier rol logueado ahí
 * arranca acá, cajera incluida. NO vive en admin-pos: queda afuera de
 * ADMIN_POS_MODULES a propósito (es un panel operativo del día a día del
 * mostrador, no de gestión remota).
 */

const Inicio = (() => {
  'use strict';

  const db = () => window.SGA_DB;
  const ge = (id) => document.getElementById(id);

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtPeso = (n) => window.SGA_Utils.formatCurrency(n);
  const fmtNum = (n) => Number(n || 0).toLocaleString('es-AR');

  // ── PERMISOS ─────────────────────────────────────────────────────────────────
  // Mismo criterio de escalada que isRouteAllowed() en app.js: admin-pos y
  // rol admin pasan siempre, el resto depende del permiso granular puntual.
  function puedeAcceder(permKey) {
    if (window.ADMIN_MODE) return true;
    const user = window.SGA_Auth.getCurrentUser();
    if (user?.rol === 'admin') return true;
    if (!permKey) return true;
    return window.SGA_Permisos.can(permKey);
  }

  function getUser() {
    return window.SGA_Auth.getCurrentUser();
  }

  // ── KPI 1: venta del turno (sesión de caja abierta) ─────────────────────────

  function renderKpiTurno(sucursalId) {
    const sesion = window.SGA_Caja.getSesionActiva(sucursalId);
    if (!sesion) {
      return `
        <a class="inicio-kpi" href="#caja">
          <div class="inicio-kpi-label">💰 Venta del turno</div>
          <div class="inicio-kpi-value inicio-kpi-muted">Sin caja abierta</div>
          <div class="inicio-kpi-sub">Tocá para abrir caja</div>
        </a>`;
    }
    const tot = window.SGA_Caja.getTotalesSesion(sesion.id);
    return `
      <a class="inicio-kpi" href="#caja">
        <div class="inicio-kpi-label">💰 Venta del turno</div>
        <div class="inicio-kpi-value">${fmtPeso(tot.totalVentas)}</div>
        <div class="inicio-kpi-sub">${tot.nVentas} venta${tot.nVentas !== 1 ? 's' : ''} · desde ${fmtHora(sesion.fecha_apertura)}</div>
      </a>`;
  }

  function fmtHora(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
  }

  // ── KPI 2 y 3: más vendidos hoy + reponer en góndola ─────────────────────────
  // Van juntos a propósito: "para reponer" NO es "hay que llamar al
  // proveedor" (eso ya existe en Órdenes de Compra, con stock_minimo +
  // grupos de sustitutos + pausa de reposición — otro criterio, para otra
  // decisión). Acá es más simple y más urgente: de lo que más se vendió HOY,
  // qué le queda poco en el momento — para que la cajera sepa qué traer de
  // depósito a la góndola antes de que se corte la venta. Por eso mira el
  // stock propio del producto (sin grupos ni pausas) contra su stock_minimo.

  function queryMasVendidosHoy(sucursalId, limite) {
    const hoy = new Date();
    const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).toISOString();
    return db().query(`
      SELECT p.nombre, SUM(vi.cantidad) AS cant,
             COALESCE(s.cantidad, 0) AS stock_actual,
             p.stock_minimo
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
        AND v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ?
      JOIN productos p ON p.id = vi.producto_id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      GROUP BY p.id
      ORDER BY cant DESC
      LIMIT ?
    `, [sucursalId, desde, sucursalId, limite]);
  }

  function renderMasVendidosYReponer(sucursalId) {
    // Sin permiso propio a propósito: no muestra plata ni márgenes (solo
    // nombre + cantidad), y el objetivo es justamente que cualquiera en el
    // mostrador —cajera incluida, sin can_informes— vea qué reponer.
    // Top 20 del día como cantera para detectar bajos de stock; se muestran
    // solo los primeros 3 en "Más vendidos".
    const top = queryMasVendidosHoy(sucursalId, 20);
    const masVendidos = top.slice(0, 3);
    const bajos = top.filter(r => r.stock_actual <= (r.stock_minimo || 0)).slice(0, 5);

    const cuerpoVendidos = masVendidos.length
      ? `<ul class="inicio-kpi-lista">
          ${masVendidos.map(r => `<li><span>${esc(r.nombre)}</span><span>${fmtNum(r.cant)}</span></li>`).join('')}
        </ul>`
      : `<div class="inicio-kpi-value inicio-kpi-muted">Sin ventas hoy</div>`;

    const cuerpoReponer = !top.length
      ? `<div class="inicio-kpi-value inicio-kpi-muted">Sin ventas hoy</div>`
      : bajos.length
        ? `<ul class="inicio-kpi-lista">
            ${bajos.map(r => `<li><span>${esc(r.nombre)}</span><span>quedan ${fmtNum(r.stock_actual)}</span></li>`).join('')}
          </ul>`
        : `<div class="inicio-kpi-value inicio-kpi-muted">Ninguno bajo de stock</div>`;

    return `
      <div class="inicio-kpi">
        <div class="inicio-kpi-label">📈 Más vendidos hoy</div>
        ${cuerpoVendidos}
      </div>
      <div class="inicio-kpi inicio-kpi-reponer${bajos.length ? '' : ' inicio-kpi-ok'}">
        <div class="inicio-kpi-label">🔄 Reponer en góndola</div>
        ${cuerpoReponer}
        <div class="inicio-kpi-sub">De lo más vendido hoy</div>
      </div>`;
  }

  // ── Accesos rápidos ──────────────────────────────────────────────────────────

  function renderBotones() {
    const botones = [];

    // Siempre visible: vender no tiene permiso propio (ver ROUTE_PERMISSION en
    // app.js). El param "nueva-venta" hace que pos.js llame a enterSaleMode()
    // directo (mismo mecanismo que "#pos/devolucion") en vez de dejar al
    // usuario en el dashboard de ventas realizadas, que es donde arranca
    // #pos por default. En Admin-POS esto no abre una venta igual — pos.js
    // bloquea enterSaleMode() en ADMIN_MODE a propósito (vender es cosa del
    // POS físico) y se queda en el dashboard de solo lectura, sin romper nada.
    botones.push(`
      <a class="inicio-btn" href="#pos/nueva-venta">
        <span class="inicio-btn-icon">🧾</span>
        Nueva venta
      </a>`);

    if (puedeAcceder('can_cta_cte_proveedores')) {
      botones.push(`
        <a class="inicio-btn inicio-btn--secundario" href="#cuenta_corriente_proveedores/nuevo-pago">
          <span class="inicio-btn-icon">💳</span>
          Pago a proveedor
        </a>`);
    }

    if (puedeAcceder('can_compras')) {
      botones.push(`
        <a class="inicio-btn inicio-btn--terciario" href="#compras_v2">
          <span class="inicio-btn-icon">📦</span>
          Ingresar Compra
        </a>`);
    }

    // Cuarto botón: todavía sin definir. Se deja preparado visualmente (grilla
    // de a 4) para cuando el usuario decida qué va acá.
    botones.push(`
      <div class="inicio-btn inicio-btn--placeholder">
        <span class="inicio-btn-icon">➕</span>
        Próximamente
      </div>`);

    return botones.join('');
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────

  function init() {
    const root = ge('inicio-root');
    if (!root) return;

    const fechaEl = ge('inicio-fecha');
    if (fechaEl) {
      fechaEl.textContent = new Date().toLocaleDateString('es-AR', {
        weekday: 'long', day: 'numeric', month: 'long',
      });
    }

    const sucursalId = getUser()?.sucursal_id || 1;

    const botonesEl = ge('inicio-botones-grid');
    if (botonesEl) botonesEl.innerHTML = renderBotones();

    const kpisEl = ge('inicio-kpis');
    if (kpisEl) {
      kpisEl.innerHTML = [
        renderKpiTurno(sucursalId),
        renderMasVendidosYReponer(sucursalId),
      ].filter(Boolean).join('');
    }
  }

  function destroy() {}

  return { init, destroy };
})();

export default Inicio;
