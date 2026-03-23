/**
 * caja.js — Cash Register Module
 *
 * Manages cash sessions: apertura, cierre (4-step wizard),
 * egresos/ingresos, movimientos, and session history.
 */

const Caja = (() => {
  'use strict';

  const DENOMINATIONS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100];
  const MEDIOS = ['efectivo', 'mercadopago', 'tarjeta', 'transferencia', 'cuenta_corriente'];
  const MEDIOS_LABEL = {
    efectivo: 'Efectivo',
    mercadopago: 'Mercado Pago',
    tarjeta: 'Tarjeta',
    transferencia: 'Transferencia',
    cuenta_corriente: 'Cta. Corriente',
  };
  const EGRESO_TIPOS = ['retiro', 'gasto_operativo', 'pago_proveedor', 'otro'];
  const EGRESO_TIPO_LABEL = {
    retiro: 'Retiro',
    gasto_operativo: 'Gasto Operativo',
    pago_proveedor: 'Pago Proveedor',
    otro: 'Otro',
  };

  const state = {
    sesion: null,
    totales: null,
    currentTab: 'resumen',
    cierreStep: 1,
    cierre: { billetes: {}, otrosMedios: {}, observaciones: '' },
    refreshTimer: null,
    user: null,
  };

  const ge = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmtPeso = (n) =>
    '$' + (parseFloat(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const fmtFecha = (str) => {
    if (!str) return '—';
    const d = new Date(str);
    return d.toLocaleDateString('es-AR') + ' ' + d.toTimeString().slice(0, 5);
  };

  // ── PERMISSION ───────────────────────────────────────────────────────────────

  function canManage() {
    return ['admin', 'encargado'].includes(state.user && state.user.rol);
  }

  // ── DATA LAYER ────────────────────────────────────────────────────────────────

  function getSesionActiva(sucursalId) {
    const rows = window.SGA_DB.query(
      `SELECT s.*, u.nombre AS nombre_apertura
       FROM sesiones_caja s
       LEFT JOIN usuarios u ON u.id = s.usuario_apertura_id
       WHERE s.sucursal_id = ? AND s.estado = 'abierta'
       ORDER BY s.fecha_apertura DESC LIMIT 1`,
      [sucursalId]
    );
    return rows[0] || null;
  }

  function getTotalesSesion(sesionId) {
    const pagos = window.SGA_DB.query(
      `SELECT vp.medio, SUM(vp.monto) AS total
       FROM ventas v
       JOIN venta_pagos vp ON vp.venta_id = v.id
       WHERE v.sesion_caja_id = ? AND v.estado = 'completada'
       GROUP BY vp.medio`,
      [sesionId]
    );
    const totPagos = {};
    for (const r of pagos) totPagos[r.medio] = r.total;

    const totalVentas = (window.SGA_DB.query(
      `SELECT COALESCE(SUM(total), 0) AS t FROM ventas WHERE sesion_caja_id = ? AND estado = 'completada'`,
      [sesionId]
    )[0] || {}).t || 0;

    const egresos = (window.SGA_DB.query(
      `SELECT COALESCE(SUM(monto), 0) AS t FROM egresos_caja WHERE sesion_caja_id = ?`,
      [sesionId]
    )[0] || {}).t || 0;

    const ingresos = (window.SGA_DB.query(
      `SELECT COALESCE(SUM(monto), 0) AS t FROM ingresos_caja WHERE sesion_caja_id = ?`,
      [sesionId]
    )[0] || {}).t || 0;

    const nVentas = (window.SGA_DB.query(
      `SELECT COUNT(*) AS n FROM ventas WHERE sesion_caja_id = ? AND estado = 'completada'`,
      [sesionId]
    )[0] || {}).n || 0;

    const saldoInicial = parseFloat((state.sesion && state.sesion.saldo_inicial) || 0);
    const efectivo = parseFloat(totPagos['efectivo'] || 0);
    const saldoEsperado = saldoInicial + efectivo - parseFloat(egresos) + parseFloat(ingresos);

    return { totPagos, totalVentas, egresos, ingresos, nVentas, saldoInicial, saldoEsperado };
  }

  function getMovimientos(sesionId) {
    return window.SGA_DB.query(
      `SELECT v.id, v.fecha, v.total, v.estado, c.nombre AS cliente
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.sesion_caja_id = ?
       ORDER BY v.fecha DESC`,
      [sesionId]
    );
  }

  function getEgresosIngresos(sesionId) {
    const egresos = window.SGA_DB.query(
      `SELECT e.id, e.monto, e.descripcion, e.fecha, e.tipo, u.nombre AS usuario
       FROM egresos_caja e
       LEFT JOIN usuarios u ON u.id = e.usuario_id
       WHERE e.sesion_caja_id = ? ORDER BY e.fecha DESC`,
      [sesionId]
    );
    const ingresos = window.SGA_DB.query(
      `SELECT i.id, i.monto, i.descripcion, i.fecha, u.nombre AS usuario
       FROM ingresos_caja i
       LEFT JOIN usuarios u ON u.id = i.usuario_id
       WHERE i.sesion_caja_id = ? ORDER BY i.fecha DESC`,
      [sesionId]
    );
    return { egresos, ingresos };
  }

  function getHistorial(sucursalId) {
    return window.SGA_DB.query(
      `SELECT s.*,
         u1.nombre AS nombre_apertura,
         u2.nombre AS nombre_cierre
       FROM sesiones_caja s
       LEFT JOIN usuarios u1 ON u1.id = s.usuario_apertura_id
       LEFT JOIN usuarios u2 ON u2.id = s.usuario_cierre_id
       WHERE s.sucursal_id = ? AND s.estado = 'cerrada'
       ORDER BY s.fecha_cierre DESC LIMIT 30`,
      [sucursalId]
    );
  }

  function abrirCaja(sucursalId, usuarioId, saldoInicial) {
    try {
      const existing = window.SGA_DB.query(
        `SELECT id FROM sesiones_caja WHERE sucursal_id = ? AND estado = 'abierta'`,
        [sucursalId]
      );
      if (existing.length) return { success: false, error: 'Ya existe una sesión de caja abierta' };

      const id = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        `INSERT INTO sesiones_caja
          (id, sucursal_id, usuario_apertura_id, fecha_apertura, saldo_inicial, estado, sync_status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'abierta', 'pending', ?)`,
        [id, sucursalId, usuarioId, now, parseFloat(saldoInicial) || 0, now]
      );
      return { success: true, sesionId: id };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function registrarEgreso(sesionId, monto, descripcion, tipo, usuarioId) {
    try {
      const id = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        `INSERT INTO egresos_caja
          (id, sesion_caja_id, monto, descripcion, tipo, fecha, usuario_id, sync_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [id, sesionId, parseFloat(monto), descripcion, tipo, now, usuarioId, now]
      );
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function registrarIngreso(sesionId, monto, descripcion, usuarioId) {
    try {
      const id = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        `INSERT INTO ingresos_caja
          (id, sesion_caja_id, monto, descripcion, fecha, usuario_id, sync_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [id, sesionId, parseFloat(monto), descripcion, now, usuarioId, now]
      );
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function cerrarCaja(sesionId, usuarioId, saldoFinalReal, detalleBilletes) {
    try {
      const tot = getTotalesSesion(sesionId);
      const now = window.SGA_Utils.formatISODate(new Date());
      const diferencia = parseFloat(saldoFinalReal) - tot.saldoEsperado;
      window.SGA_DB.run(
        `UPDATE sesiones_caja
         SET estado = 'cerrada',
             usuario_cierre_id = ?,
             fecha_cierre = ?,
             saldo_final_real = ?,
             diferencia = ?,
             detalle_billetes = ?,
             sync_status = 'pending',
             updated_at = ?
         WHERE id = ?`,
        [usuarioId, now, parseFloat(saldoFinalReal), diferencia, JSON.stringify(detalleBilletes), now, sesionId]
      );
      return { success: true, diferencia };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ── TOAST ─────────────────────────────────────────────────────────────────────

  function showToast(msg, type) {
    const colors = { info: '#1565C0', success: '#2E7D32', error: '#C62828', warn: '#E65100' };
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:24px;right:24px;background:${colors[type] || colors.info};color:#fff;padding:12px 20px;border-radius:6px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.3);`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── AUTO REFRESH ──────────────────────────────────────────────────────────────

  function startAutoRefresh() {
    stopAutoRefresh();
    state.refreshTimer = setInterval(() => {
      if (state.sesion && state.currentTab === 'resumen') renderResumen();
    }, 60000);
  }

  function stopAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  // ── RENDER ROOT ───────────────────────────────────────────────────────────────

  function render() {
    if (!state.sesion) {
      renderApertura();
    } else {
      renderCajaActiva();
    }
  }

  // ── APERTURA ──────────────────────────────────────────────────────────────────

  function renderApertura() {
    const root = ge('caja-root');
    if (!root) return;
    root.innerHTML = `
      <div class="caja-toolbar">
        <h2>💰 Caja</h2>
      </div>
      <div class="caja-apertura-wrap">
        <div class="caja-apertura-card">
          <div class="caja-apertura-icon">💰</div>
          <h3>No hay caja abierta</h3>
          <p>Para comenzar a registrar ventas, debés abrir una sesión de caja.</p>
          <div class="caja-apertura-field">
            <label for="caja-saldo-inicial">Saldo inicial en efectivo</label>
            <div class="caja-input-prefix">
              <span>$</span>
              <input type="number" id="caja-saldo-inicial" value="0" min="0" step="1" placeholder="0">
            </div>
          </div>
          <button id="btn-abrir-caja" class="btn btn-primary btn-lg">Abrir Caja</button>
        </div>
      </div>
    `;

    ge('btn-abrir-caja').addEventListener('click', () => {
      const saldo = parseFloat(ge('caja-saldo-inicial').value) || 0;
      const result = abrirCaja(state.user.sucursal_id, state.user.id, saldo);
      if (result.success) {
        state.sesion = getSesionActiva(state.user.sucursal_id);
        state.currentTab = 'resumen';
        render();
        startAutoRefresh();
      } else {
        showToast(result.error, 'error');
      }
    });
  }

  // ── CAJA ACTIVA ───────────────────────────────────────────────────────────────

  function renderCajaActiva() {
    const root = ge('caja-root');
    if (!root) return;

    root.innerHTML = `
      <div class="caja-toolbar">
        <div>
          <h2>💰 Caja <span class="badge-abierta">Abierta</span></h2>
          <small class="caja-apertura-info">
            Apertura: ${fmtFecha(state.sesion.fecha_apertura)}
            · ${esc(state.sesion.nombre_apertura || '')}
          </small>
        </div>
        <div class="caja-toolbar-right">
          ${canManage() ? `<button id="btn-cierre-caja" class="btn btn-danger">Cerrar Caja</button>` : ''}
        </div>
      </div>
      <div class="caja-tabs">
        <button class="caja-tab ${state.currentTab === 'resumen' ? 'active' : ''}" data-tab="resumen">Resumen</button>
        <button class="caja-tab ${state.currentTab === 'movimientos' ? 'active' : ''}" data-tab="movimientos">Movimientos</button>
        <button class="caja-tab ${state.currentTab === 'egresos' ? 'active' : ''}" data-tab="egresos">Egresos e Ingresos</button>
        <button class="caja-tab ${state.currentTab === 'historial' ? 'active' : ''}" data-tab="historial">Historial</button>
      </div>
      <div id="caja-tab-content" class="caja-tab-content"></div>
    `;

    root.querySelectorAll('.caja-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    if (canManage()) {
      const btnCierre = ge('btn-cierre-caja');
      if (btnCierre) btnCierre.addEventListener('click', openCierreModal);
    }

    switchTab(state.currentTab);
  }

  function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.caja-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    const content = ge('caja-tab-content');
    if (!content) return;
    switch (tab) {
      case 'resumen':     renderResumen(content);          break;
      case 'movimientos': renderMovimientos(content);       break;
      case 'egresos':     renderEgresosIngresos(content);   break;
      case 'historial':   renderHistorial(content);         break;
    }
  }

  // ── TAB: RESUMEN ──────────────────────────────────────────────────────────────

  function renderResumen(container) {
    const el = container || ge('caja-tab-content');
    if (!el || !state.sesion) return;
    const tot = getTotalesSesion(state.sesion.id);
    state.totales = tot;

    const mediosHtml = MEDIOS
      .filter(m => tot.totPagos[m] > 0)
      .map(m => `
        <div class="caja-stat-row">
          <span>${MEDIOS_LABEL[m]}</span>
          <span>${fmtPeso(tot.totPagos[m])}</span>
        </div>
      `).join('');

    el.innerHTML = `
      <div class="caja-resumen-grid">
        <div class="caja-stat-card">
          <div class="caja-stat-label">Ventas del día</div>
          <div class="caja-stat-value">${fmtPeso(tot.totalVentas)}</div>
          <div class="caja-stat-sub">${tot.nVentas} venta${tot.nVentas !== 1 ? 's' : ''}</div>
        </div>
        <div class="caja-stat-card">
          <div class="caja-stat-label">Saldo inicial</div>
          <div class="caja-stat-value">${fmtPeso(tot.saldoInicial)}</div>
        </div>
        <div class="caja-stat-card">
          <div class="caja-stat-label">Egresos</div>
          <div class="caja-stat-value text-danger">${fmtPeso(tot.egresos)}</div>
        </div>
        <div class="caja-stat-card highlight">
          <div class="caja-stat-label">Saldo esperado (efectivo)</div>
          <div class="caja-stat-value">${fmtPeso(tot.saldoEsperado)}</div>
        </div>
      </div>
      ${mediosHtml ? `<div class="caja-medios-card"><h4>Ventas por medio de pago</h4>${mediosHtml}</div>` : ''}
    `;
  }

  // ── TAB: MOVIMIENTOS ──────────────────────────────────────────────────────────

  function renderMovimientos(container) {
    const el = container || ge('caja-tab-content');
    if (!el || !state.sesion) return;
    const movs = getMovimientos(state.sesion.id);

    if (!movs.length) {
      el.innerHTML = '<div class="caja-empty">Sin ventas registradas en esta sesión.</div>';
      return;
    }

    el.innerHTML = `
      <table class="caja-table">
        <thead>
          <tr>
            <th>Fecha</th><th>ID Venta</th><th>Cliente</th><th>Total</th><th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${movs.map(v => `
            <tr>
              <td>${fmtFecha(v.fecha)}</td>
              <td><a href="#" class="caja-link-venta" data-id="${esc(v.id)}">${v.id.slice(0, 8)}…</a></td>
              <td>${esc(v.cliente || 'Consumidor final')}</td>
              <td>${fmtPeso(v.total)}</td>
              <td><span class="badge-estado ${esc(v.estado)}">${esc(v.estado)}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    el.querySelectorAll('.caja-link-venta').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); showVentaDetalle(a.dataset.id); });
    });
  }

  // ── TAB: EGRESOS E INGRESOS ───────────────────────────────────────────────────

  function renderEgresosIngresos(container) {
    const el = container || ge('caja-tab-content');
    if (!el || !state.sesion) return;
    const { egresos, ingresos } = getEgresosIngresos(state.sesion.id);

    const eHtml = egresos.length ? `
      <table class="caja-table">
        <thead>
          <tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Monto</th><th>Usuario</th></tr>
        </thead>
        <tbody>
          ${egresos.map(e => `
            <tr>
              <td>${fmtFecha(e.fecha)}</td>
              <td>${esc(EGRESO_TIPO_LABEL[e.tipo] || e.tipo || '—')}</td>
              <td>${esc(e.descripcion || '')}</td>
              <td class="text-danger">${fmtPeso(e.monto)}</td>
              <td>${esc(e.usuario || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '<p class="caja-empty">Sin egresos registrados.</p>';

    const iHtml = ingresos.length ? `
      <table class="caja-table">
        <thead>
          <tr><th>Fecha</th><th>Descripción</th><th>Monto</th><th>Usuario</th></tr>
        </thead>
        <tbody>
          ${ingresos.map(i => `
            <tr>
              <td>${fmtFecha(i.fecha)}</td>
              <td>${esc(i.descripcion || '')}</td>
              <td class="text-success">${fmtPeso(i.monto)}</td>
              <td>${esc(i.usuario || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '<p class="caja-empty">Sin ingresos extra registrados.</p>';

    el.innerHTML = `
      <div class="caja-ei-header">
        <h3>Egresos</h3>
        ${canManage() ? `<button id="btn-nuevo-egreso" class="btn btn-sm btn-danger">+ Egreso</button>` : ''}
      </div>
      ${eHtml}
      <div class="caja-ei-header" style="margin-top:24px">
        <h3>Ingresos extra</h3>
        ${canManage() ? `<button id="btn-nuevo-ingreso" class="btn btn-sm btn-success">+ Ingreso</button>` : ''}
      </div>
      ${iHtml}
    `;

    if (canManage()) {
      const btnE = ge('btn-nuevo-egreso');
      const btnI = ge('btn-nuevo-ingreso');
      if (btnE) btnE.addEventListener('click', openEgresoModal);
      if (btnI) btnI.addEventListener('click', openIngresoModal);
    }
  }

  // ── TAB: HISTORIAL ────────────────────────────────────────────────────────────

  function renderHistorial(container) {
    const el = container || ge('caja-tab-content');
    if (!el) return;
    const hist = getHistorial(state.user.sucursal_id);

    if (!hist.length) {
      el.innerHTML = '<div class="caja-empty">Sin sesiones cerradas anteriores.</div>';
      return;
    }

    el.innerHTML = `
      <table class="caja-table">
        <thead>
          <tr>
            <th>Apertura</th><th>Cierre</th><th>Total ventas</th>
            <th>Saldo inicial</th><th>Saldo real</th><th>Diferencia</th>
            <th>Usuario</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${hist.map(s => {
            const dif = parseFloat(s.diferencia) || 0;
            const difClass = dif > 0 ? 'text-success' : dif < 0 ? 'text-danger' : '';
            const totalVentas =
              (parseFloat(s.total_efectivo) || 0) +
              (parseFloat(s.total_mercadopago) || 0) +
              (parseFloat(s.total_tarjeta) || 0) +
              (parseFloat(s.total_transferencia) || 0) +
              (parseFloat(s.total_cuenta_corriente) || 0);
            return `
              <tr>
                <td>${fmtFecha(s.fecha_apertura)}</td>
                <td>${fmtFecha(s.fecha_cierre)}</td>
                <td>${fmtPeso(totalVentas)}</td>
                <td>${fmtPeso(s.saldo_inicial)}</td>
                <td>${fmtPeso(s.saldo_final_real)}</td>
                <td class="${difClass}">${dif >= 0 ? '+' : ''}${fmtPeso(dif)}</td>
                <td>${esc(s.nombre_apertura || '')}</td>
                <td><button class="btn btn-xs btn-outline btn-ver-sesion" data-id="${esc(s.id)}">Ver</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    el.querySelectorAll('.btn-ver-sesion').forEach(btn => {
      btn.addEventListener('click', () => showSesionDetalle(btn.dataset.id));
    });
  }

  // ── MODAL HELPERS ─────────────────────────────────────────────────────────────

  function openModal(html) {
    const overlay = ge('caja-modal-overlay');
    if (!overlay) return;
    overlay.innerHTML = `<div class="caja-modal">${html}</div>`;
    overlay.classList.remove('hidden');
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal();
    }, { once: true });
  }

  function closeModal() {
    const overlay = ge('caja-modal-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  }

  // ── EGRESO MODAL ──────────────────────────────────────────────────────────────

  function openEgresoModal() {
    openModal(`
      <button class="caja-modal-close" id="btn-close-egreso">✕</button>
      <h3>Registrar Egreso</h3>
      <div class="caja-form">
        <label>Tipo</label>
        <select id="egreso-tipo">
          ${EGRESO_TIPOS.map(t => `<option value="${t}">${EGRESO_TIPO_LABEL[t]}</option>`).join('')}
        </select>
        <label>Monto</label>
        <div class="caja-input-prefix">
          <span>$</span>
          <input type="number" id="egreso-monto" min="1" placeholder="0">
        </div>
        <label>Descripción</label>
        <input type="text" id="egreso-descripcion" placeholder="Motivo del egreso">
      </div>
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-cancel-egreso">Cancelar</button>
        <button class="btn btn-danger" id="btn-confirm-egreso">Registrar Egreso</button>
      </div>
    `);

    ge('btn-close-egreso').addEventListener('click', closeModal);
    ge('btn-cancel-egreso').addEventListener('click', closeModal);
    ge('btn-confirm-egreso').addEventListener('click', () => {
      const monto = parseFloat(ge('egreso-monto').value);
      if (!monto || monto <= 0) { showToast('Ingresá un monto válido', 'warn'); return; }
      const tipo = ge('egreso-tipo').value;
      const desc = ge('egreso-descripcion').value.trim();
      const result = registrarEgreso(state.sesion.id, monto, desc, tipo, state.user.id);
      if (result.success) {
        showToast('Egreso registrado', 'success');
        closeModal();
        switchTab('egresos');
      } else {
        showToast(result.error, 'error');
      }
    });
  }

  // ── INGRESO MODAL ─────────────────────────────────────────────────────────────

  function openIngresoModal() {
    openModal(`
      <button class="caja-modal-close" id="btn-close-ingreso">✕</button>
      <h3>Registrar Ingreso extra</h3>
      <div class="caja-form">
        <label>Monto</label>
        <div class="caja-input-prefix">
          <span>$</span>
          <input type="number" id="ingreso-monto" min="1" placeholder="0">
        </div>
        <label>Descripción</label>
        <input type="text" id="ingreso-descripcion" placeholder="Motivo del ingreso">
      </div>
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-cancel-ingreso">Cancelar</button>
        <button class="btn btn-success" id="btn-confirm-ingreso">Registrar Ingreso</button>
      </div>
    `);

    ge('btn-close-ingreso').addEventListener('click', closeModal);
    ge('btn-cancel-ingreso').addEventListener('click', closeModal);
    ge('btn-confirm-ingreso').addEventListener('click', () => {
      const monto = parseFloat(ge('ingreso-monto').value);
      if (!monto || monto <= 0) { showToast('Ingresá un monto válido', 'warn'); return; }
      const desc = ge('ingreso-descripcion').value.trim();
      const result = registrarIngreso(state.sesion.id, monto, desc, state.user.id);
      if (result.success) {
        showToast('Ingreso registrado', 'success');
        closeModal();
        switchTab('egresos');
      } else {
        showToast(result.error, 'error');
      }
    });
  }

  // ── CIERRE WIZARD ─────────────────────────────────────────────────────────────

  function openCierreModal() {
    state.cierreStep = 1;
    state.cierre = { billetes: {}, otrosMedios: {}, observaciones: '' };
    renderCierreStep();
  }

  function renderCierreStep() {
    const tot = getTotalesSesion(state.sesion.id);
    state.totales = tot;

    const STEPS = [
      { n: 1, label: 'Resumen' },
      { n: 2, label: 'Arqueo' },
      { n: 3, label: 'Otros medios' },
      { n: 4, label: 'Confirmar' },
    ];

    const stepsHtml = STEPS.map((s, i) => {
      const cls = state.cierreStep === s.n ? 'active' : state.cierreStep > s.n ? 'done' : '';
      return (i > 0 ? '<div class="cierre-step-sep">›</div>' : '') +
        `<div class="cierre-step-indicator ${cls}"><span>${s.n}</span> ${s.label}</div>`;
    }).join('');

    let bodyHtml = '';

    if (state.cierreStep === 1) {
      bodyHtml = `
        <div class="cierre-resumen">
          ${MEDIOS.map(m => `
            <div class="caja-stat-row">
              <span>${MEDIOS_LABEL[m]}</span>
              <span>${fmtPeso(tot.totPagos[m] || 0)}</span>
            </div>
          `).join('')}
          <div class="caja-stat-row total-row"><span>Total ventas</span><span>${fmtPeso(tot.totalVentas)}</span></div>
          <div class="caja-stat-row"><span>Egresos</span><span class="text-danger">-${fmtPeso(tot.egresos)}</span></div>
          <div class="caja-stat-row"><span>Ingresos extra</span><span class="text-success">+${fmtPeso(tot.ingresos)}</span></div>
          <div class="caja-stat-row highlight-row"><span>Saldo esperado (efectivo)</span><span>${fmtPeso(tot.saldoEsperado)}</span></div>
        </div>
      `;
    } else if (state.cierreStep === 2) {
      const totalContado = DENOMINATIONS.reduce((sum, d) => sum + d * (parseFloat(state.cierre.billetes[d]) || 0), 0);
      bodyHtml = `
        <p style="margin:0 0 12px;font-size:14px;color:#666">Contá los billetes y monedas en caja.</p>
        <table class="cierre-billetes-table">
          <thead><tr><th>Denominación</th><th>Cantidad</th><th style="text-align:right">Subtotal</th></tr></thead>
          <tbody>
            ${DENOMINATIONS.map(d => `
              <tr>
                <td>${fmtPeso(d)}</td>
                <td><input type="number" class="billete-input" data-denom="${d}" min="0" value="${parseFloat(state.cierre.billetes[d]) || 0}"></td>
                <td class="billete-subtotal" id="sub-${d}" style="text-align:right">${fmtPeso((parseFloat(state.cierre.billetes[d]) || 0) * d)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2"><strong>Total contado</strong></td>
              <td style="text-align:right" id="cierre-total-contado"><strong>${fmtPeso(totalContado)}</strong></td>
            </tr>
          </tfoot>
        </table>
      `;
    } else if (state.cierreStep === 3) {
      const mediosExtra = MEDIOS.filter(m => m !== 'efectivo');
      bodyHtml = `
        <p style="margin:0 0 12px;font-size:14px;color:#666">Verificá los montos por medio de pago.</p>
        <table class="caja-table">
          <thead><tr><th>Medio</th><th>Esperado</th><th>Observaciones</th></tr></thead>
          <tbody>
            ${mediosExtra.map(m => `
              <tr>
                <td>${MEDIOS_LABEL[m]}</td>
                <td>${fmtPeso(tot.totPagos[m] || 0)}</td>
                <td><input type="text" class="otros-medios-obs" data-medio="${m}" placeholder="Opcional" value="${esc(state.cierre.otrosMedios[m] || '')}"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div class="caja-form" style="margin-top:16px">
          <label>Observaciones generales</label>
          <textarea id="cierre-observaciones" rows="3" placeholder="Notas del cierre">${esc(state.cierre.observaciones)}</textarea>
        </div>
      `;
    } else if (state.cierreStep === 4) {
      const totalContado = DENOMINATIONS.reduce((sum, d) => sum + d * (parseFloat(state.cierre.billetes[d]) || 0), 0);
      const diferencia = totalContado - tot.saldoEsperado;
      const difClass = diferencia > 0 ? 'text-success' : diferencia < 0 ? 'text-danger' : '';
      bodyHtml = `
        <div class="cierre-confirm-grid">
          <div class="caja-stat-row"><span>Saldo esperado</span><span>${fmtPeso(tot.saldoEsperado)}</span></div>
          <div class="caja-stat-row"><span>Total contado</span><span>${fmtPeso(totalContado)}</span></div>
          <div class="caja-stat-row highlight-row">
            <span>Diferencia</span>
            <span class="${difClass}">${diferencia >= 0 ? '+' : ''}${fmtPeso(diferencia)}</span>
          </div>
        </div>
        <p style="margin-top:16px;color:#666;font-size:13px">Al confirmar, la sesión de caja se cerrará y no podrá modificarse.</p>
      `;
    }

    const isFirst = state.cierreStep === 1;
    const isLast  = state.cierreStep === 4;

    openModal(`
      <button class="caja-modal-close" id="btn-close-cierre">✕</button>
      <h3>Cierre de Caja</h3>
      <div class="cierre-steps-nav">${stepsHtml}</div>
      <div class="cierre-body">${bodyHtml}</div>
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-cierre-prev" ${isFirst ? 'disabled' : ''}>← Anterior</button>
        ${isLast
          ? `<button class="btn btn-danger" id="btn-cierre-confirm">Confirmar Cierre</button>`
          : `<button class="btn btn-primary" id="btn-cierre-next">Siguiente →</button>`
        }
      </div>
    `);

    ge('btn-close-cierre').addEventListener('click', closeModal);

    if (!isFirst) {
      ge('btn-cierre-prev').addEventListener('click', () => {
        saveCierreStepData();
        state.cierreStep--;
        renderCierreStep();
      });
    }

    if (!isLast) {
      ge('btn-cierre-next').addEventListener('click', () => {
        saveCierreStepData();
        state.cierreStep++;
        renderCierreStep();
      });
    } else {
      ge('btn-cierre-confirm').addEventListener('click', confirmarCierre);
    }

    // Live billete subtotals (step 2)
    if (state.cierreStep === 2) {
      document.querySelectorAll('.billete-input').forEach(inp => {
        inp.addEventListener('input', () => {
          const d = parseFloat(inp.dataset.denom);
          const n = parseFloat(inp.value) || 0;
          state.cierre.billetes[d] = n;
          const subEl = ge(`sub-${inp.dataset.denom}`);
          if (subEl) subEl.textContent = fmtPeso(d * n);
          const total = DENOMINATIONS.reduce((sum, den) => sum + den * (parseFloat(state.cierre.billetes[den]) || 0), 0);
          const totEl = ge('cierre-total-contado');
          if (totEl) totEl.innerHTML = `<strong>${fmtPeso(total)}</strong>`;
        });
      });
    }
  }

  function saveCierreStepData() {
    if (state.cierreStep === 2) {
      document.querySelectorAll('.billete-input').forEach(inp => {
        state.cierre.billetes[inp.dataset.denom] = parseFloat(inp.value) || 0;
      });
    } else if (state.cierreStep === 3) {
      document.querySelectorAll('.otros-medios-obs').forEach(inp => {
        state.cierre.otrosMedios[inp.dataset.medio] = inp.value;
      });
      const obsEl = ge('cierre-observaciones');
      if (obsEl) state.cierre.observaciones = obsEl.value;
    }
  }

  function confirmarCierre() {
    saveCierreStepData();
    const totalContado = DENOMINATIONS.reduce((sum, d) => sum + d * (parseFloat(state.cierre.billetes[d]) || 0), 0);
    const result = cerrarCaja(state.sesion.id, state.user.id, totalContado, state.cierre.billetes);
    if (result.success) {
      closeModal();
      showToast('Caja cerrada correctamente', 'success');
      stopAutoRefresh();
      state.sesion = null;
      render();
    } else {
      showToast(result.error, 'error');
    }
  }

  // ── SESION DETALLE MODAL ──────────────────────────────────────────────────────

  function showSesionDetalle(sesionId) {
    const rows = window.SGA_DB.query(
      `SELECT s.*, u1.nombre AS nombre_apertura, u2.nombre AS nombre_cierre
       FROM sesiones_caja s
       LEFT JOIN usuarios u1 ON u1.id = s.usuario_apertura_id
       LEFT JOIN usuarios u2 ON u2.id = s.usuario_cierre_id
       WHERE s.id = ?`,
      [sesionId]
    );
    if (!rows.length) return;
    const s = rows[0];

    let billetes = {};
    try { billetes = JSON.parse(s.detalle_billetes || '{}'); } catch (e) { /* ignore */ }

    const totalVentas = ((window.SGA_DB.query(
      `SELECT COALESCE(SUM(total), 0) AS t FROM ventas WHERE sesion_caja_id = ? AND estado = 'completada'`,
      [sesionId]
    )[0]) || {}).t || 0;

    const billetesHtml = Object.entries(billetes)
      .filter(([, n]) => parseFloat(n) > 0)
      .map(([d, n]) => `<div class="caja-stat-row"><span>${fmtPeso(d)} × ${n}</span><span>${fmtPeso(parseFloat(d) * parseFloat(n))}</span></div>`)
      .join('') || '<p style="color:#999;font-size:13px">Sin detalle de billetes</p>';

    const dif = parseFloat(s.diferencia) || 0;
    const difClass = dif > 0 ? 'text-success' : dif < 0 ? 'text-danger' : '';

    openModal(`
      <button class="caja-modal-close" id="btn-close-sesion">✕</button>
      <h3>Detalle de Sesión</h3>
      <div class="caja-stat-row"><span>Apertura</span><span>${fmtFecha(s.fecha_apertura)}</span></div>
      <div class="caja-stat-row"><span>Cierre</span><span>${fmtFecha(s.fecha_cierre)}</span></div>
      <div class="caja-stat-row"><span>Abrió</span><span>${esc(s.nombre_apertura || '—')}</span></div>
      <div class="caja-stat-row"><span>Cerró</span><span>${esc(s.nombre_cierre || '—')}</span></div>
      <div class="caja-stat-row"><span>Total ventas</span><span>${fmtPeso(totalVentas)}</span></div>
      <div class="caja-stat-row"><span>Saldo inicial</span><span>${fmtPeso(s.saldo_inicial)}</span></div>
      <div class="caja-stat-row"><span>Saldo esperado</span><span>${fmtPeso(s.saldo_final_esperado)}</span></div>
      <div class="caja-stat-row"><span>Saldo real (contado)</span><span>${fmtPeso(s.saldo_final_real)}</span></div>
      <div class="caja-stat-row highlight-row"><span>Diferencia</span><span class="${difClass}">${dif >= 0 ? '+' : ''}${fmtPeso(dif)}</span></div>
      <h4 style="margin:16px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.03em;color:#666">Detalle billetes</h4>
      ${billetesHtml}
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-close-sesion2">Cerrar</button>
      </div>
    `);

    ge('btn-close-sesion').addEventListener('click', closeModal);
    ge('btn-close-sesion2').addEventListener('click', closeModal);
  }

  // ── VENTA DETALLE MODAL ───────────────────────────────────────────────────────

  function showVentaDetalle(ventaId) {
    const rows = window.SGA_DB.query(
      `SELECT v.*, c.nombre AS cliente, u.nombre AS usuario
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.id = ?`,
      [ventaId]
    );
    if (!rows.length) return;
    const v = rows[0];

    const items = window.SGA_DB.query(
      `SELECT vi.*, p.nombre FROM venta_items vi LEFT JOIN productos p ON p.id = vi.producto_id WHERE vi.venta_id = ?`,
      [ventaId]
    );
    const pagos = window.SGA_DB.query(
      `SELECT * FROM venta_pagos WHERE venta_id = ?`,
      [ventaId]
    );

    const itemsHtml = items.map(i => `
      <tr>
        <td>${esc(i.nombre || '')}</td>
        <td>${i.cantidad}</td>
        <td>${fmtPeso(i.precio_unitario)}</td>
        <td>${fmtPeso(i.subtotal)}</td>
      </tr>
    `).join('');

    const pagosHtml = pagos.map(p => `
      <div class="caja-stat-row">
        <span>${MEDIOS_LABEL[p.medio] || esc(p.medio)}</span>
        <span>${fmtPeso(p.monto)}</span>
      </div>
    `).join('');

    openModal(`
      <button class="caja-modal-close" id="btn-close-venta">✕</button>
      <h3>Venta <span style="font-family:monospace;font-size:.9em">${ventaId.slice(0, 8)}…</span></h3>
      <div class="caja-stat-row"><span>Fecha</span><span>${fmtFecha(v.fecha)}</span></div>
      <div class="caja-stat-row"><span>Cliente</span><span>${esc(v.cliente || 'Consumidor final')}</span></div>
      <div class="caja-stat-row"><span>Usuario</span><span>${esc(v.usuario || '')}</span></div>
      <table class="caja-table" style="margin:16px 0">
        <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <h4 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:#666">Pagos</h4>
      ${pagosHtml}
      <div class="caja-stat-row total-row"><span>Total</span><span>${fmtPeso(v.total)}</span></div>
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-close-venta2">Cerrar</button>
        <button class="btn btn-secondary" id="btn-ir-pos">Ver en POS</button>
      </div>
    `);

    ge('btn-close-venta').addEventListener('click', closeModal);
    ge('btn-close-venta2').addEventListener('click', closeModal);
    ge('btn-ir-pos').addEventListener('click', () => {
      sessionStorage.setItem('highlight_venta', ventaId);
      window.location.hash = '#pos';
    });
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────

  const init = () => {
    state.user = window.SGA_Auth.getCurrentUser();
    if (!state.user) { window.location.hash = '#pos'; return; }

    state.sesion = getSesionActiva(state.user.sucursal_id);
    state.currentTab = 'resumen';
    render();

    if (state.sesion) startAutoRefresh();
  };

  // ── WINDOW DATA LAYER ─────────────────────────────────────────────────────────

  window.SGA_Caja = {
    getSesionActiva,
    abrirCaja,
    cerrarCaja,
    registrarEgreso,
    registrarIngreso,
    getTotalesSesion,
  };

  return { init };
})();

export default Caja;
