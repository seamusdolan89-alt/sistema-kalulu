/**
 * caja.js — Cash Register Module
 *
 * Manages cash sessions: apertura, cierre (4-step wizard),
 * egresos/ingresos, movimientos, and session history.
 */

const Caja = (() => {
  'use strict';

  const MEDIOS =['efectivo', 'mercadopago', 'tarjeta', 'transferencia', 'cuenta_corriente'];
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
    activeMedio: 'efectivo',
    cierre: { mediosInformados: {}, explicaciones: {} },
    recuento: { billetes: {} },
    refreshTimer: null,
    user: null,
  };

  const ge = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmtPeso = (n) => window.SGA_Utils.formatCurrency(n);
  const fmtFecha = (str) => window.SGA_Utils.formatFecha(str);

  const fmtHora = (str) => {
    if (!str) return '—';
    const d = new Date(str);
    const hoy = new Date();
    const esHoy = d.getFullYear() === hoy.getFullYear()
      && d.getMonth() === hoy.getMonth()
      && d.getDate() === hoy.getDate();
    return esHoy
      ? d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : fmtFecha(str);
  };

  // ── DENOMINACIONES ────────────────────────────────────────────────────────────

  function getDenominaciones() {
    try {
      const rows = window.SGA_DB.query(
        `SELECT valor FROM system_config WHERE clave = 'denominaciones' LIMIT 1`
      );
      if (rows.length && rows[0].valor) {
        const arr = JSON.parse(rows[0].valor);
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch (e) { /* fallback */ }
    return window.SGA_Utils.DENOMINACIONES.slice();
  }

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

  function getMovimientosDia(sesionId, medio = 'efectivo') {
    // Get ventas that have payments in this medio, with the amount for that medio only
    const ventas = window.SGA_DB.query(
      `SELECT v.id, v.fecha, v.total, v.estado, c.nombre AS cliente,
         COALESCE((SELECT SUM(vp2.monto) FROM venta_pagos vp2
                   WHERE vp2.venta_id = v.id AND vp2.medio = ?), 0) AS monto_medio
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.sesion_caja_id = ?
       ORDER BY v.fecha DESC`,
      [medio, sesionId]
    ).filter(v => parseFloat(v.monto_medio) > 0);

    // All medios per venta (for the tag column)
    const allPagos = window.SGA_DB.query(
      `SELECT vp.venta_id, vp.medio FROM venta_pagos vp
       JOIN ventas v ON v.id = vp.venta_id WHERE v.sesion_caja_id = ?`,
      [sesionId]
    );
    const pagosByVenta = {};
    for (const p of allPagos) {
      if (!pagosByVenta[p.venta_id]) pagosByVenta[p.venta_id] = [];
      if (!pagosByVenta[p.venta_id].includes(p.medio)) pagosByVenta[p.venta_id].push(p.medio);
    }

    // Egresos e ingresos only apply to the efectivo caja
    const egresos = medio === 'efectivo' ? window.SGA_DB.query(
      `SELECT e.id, e.fecha, e.monto, e.descripcion, e.tipo, u.nombre AS usuario
       FROM egresos_caja e LEFT JOIN usuarios u ON u.id = e.usuario_id
       WHERE e.sesion_caja_id = ? ORDER BY e.fecha DESC`,
      [sesionId]
    ) : [];
    const ingresos = medio === 'efectivo' ? window.SGA_DB.query(
      `SELECT i.id, i.fecha, i.monto, i.descripcion, u.nombre AS usuario
       FROM ingresos_caja i LEFT JOIN usuarios u ON u.id = i.usuario_id
       WHERE i.sesion_caja_id = ? ORDER BY i.fecha DESC`,
      [sesionId]
    ) : [];

    const items = [
      ...ventas.map(v => ({
        tipo: 'venta', id: v.id, fecha: v.fecha,
        monto: parseFloat(v.monto_medio) || 0,
        descripcion: v.cliente || 'Consumidor final',
        estado: v.estado,
        medios: pagosByVenta[v.id] || [],
      })),
      ...egresos.map(e => ({
        tipo: 'egreso', id: e.id, fecha: e.fecha,
        monto: -(parseFloat(e.monto) || 0),
        descripcion: e.descripcion || EGRESO_TIPO_LABEL[e.tipo] || 'Egreso',
        subtipo: e.tipo, usuario: e.usuario,
        medios: ['efectivo'],
      })),
      ...ingresos.map(i => ({
        tipo: 'ingreso', id: i.id, fecha: i.fecha,
        monto: parseFloat(i.monto) || 0,
        descripcion: i.descripcion || 'Ingreso extra',
        usuario: i.usuario,
        medios: ['efectivo'],
      })),
    ];
    items.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    return items;
  }

  const MEDIO_ICON = {
    efectivo:         `<span class="mtag mtag-cash">💵 Efectivo</span>`,
    mercadopago:      `<span class="mtag mtag-mp">📲 MP</span>`,
    tarjeta:          `<span class="mtag mtag-card">💳 Tarjeta</span>`,
    transferencia:    `<span class="mtag mtag-transf">🏦 Transf.</span>`,
    cuenta_corriente: `<span class="mtag mtag-cc">Cta. Cte.</span>`,
  };

  function medioTags(medios) {
    if (!medios || !medios.length) return '<span style="color:#ccc">—</span>';
    return medios.map(m => MEDIO_ICON[m] || `<span class="mtag">${esc(m)}</span>`).join('');
  }

  function movTipoBadge(item) {
    if (item.tipo === 'venta') {
      const map = {
        completada: ['mov-venta',    'Venta'],
        anulada:    ['mov-anulada',  'Anulada'],
        pendiente:  ['mov-pendiente','Sin cobrar'],
      };
      const [cls, lbl] = map[item.estado] || ['mov-venta', 'Venta'];
      return `<span class="mov-badge ${cls}">${lbl}</span>`;
    }
    if (item.tipo === 'egreso') {
      const lbl = { pago_proveedor: 'Pago Prov.', retiro: 'Retiro', gasto_operativo: 'Gasto', otro: 'Egreso' };
      return `<span class="mov-badge mov-egreso">${lbl[item.subtipo] || 'Egreso'}</span>`;
    }
    return `<span class="mov-badge mov-ingreso">Ingreso</span>`;
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
      console.error('abrirCaja:', e);
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
      console.error('registrarEgreso:', e);
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
      console.error('registrarIngreso:', e);
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
             saldo_final_esperado = ?,
             diferencia = ?,
             detalle_billetes = ?,
             sync_status = 'pending',
             updated_at = ?
         WHERE id = ?`,
        [usuarioId, now, parseFloat(saldoFinalReal), tot.saldoEsperado, diferencia, JSON.stringify(detalleBilletes), now, sesionId]
      );
      return { success: true, diferencia };
    } catch (e) {
      console.error('cerrarCaja:', e);
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

    let ultimoCierre = null;
    try {
      const rows = window.SGA_DB.query(
        `SELECT saldo_final_real FROM sesiones_caja
         WHERE sucursal_id = ? AND estado = 'cerrada'
         ORDER BY fecha_cierre DESC LIMIT 1`,
        [state.user.sucursal_id]
      );
      if (rows.length) ultimoCierre = parseFloat(rows[0].saldo_final_real) || 0;
    } catch (e) { /* no prev session */ }

    const saldoInputHtml = ultimoCierre !== null
      ? `<div class="caja-input-prefix">
           <span>$</span>
           <input type="number" id="caja-saldo-inicial" value="${ultimoCierre}" min="0" step="1" readonly
             style="background:var(--color-surface);color:var(--color-text-secondary)">
         </div>
         <small style="color:var(--color-text-secondary);font-size:12px;display:block;margin-top:4px">
           Transferido del turno anterior
         </small>`
      : `<div class="caja-input-prefix">
           <span>$</span>
           <input type="number" id="caja-saldo-inicial" value="0" min="0" step="1" placeholder="0">
         </div>`;

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
            ${saldoInputHtml}
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
    const medio = state.activeMedio || 'efectivo';
    const medioLabel = MEDIOS_LABEL[medio] || medio;
    const isEfectivo = medio === 'efectivo';

    // Tabs: egresos/recuento only relevant for efectivo
    const tabsHtml = `
      <button class="caja-tab ${state.currentTab === 'resumen' ? 'active' : ''}" data-tab="resumen">Resumen</button>
      ${isEfectivo ? `<button class="caja-tab ${state.currentTab === 'egresos' ? 'active' : ''}" data-tab="egresos">Egresos e Ingresos</button>` : ''}
      <button class="caja-tab ${state.currentTab === 'historial' ? 'active' : ''}" data-tab="historial">Historial</button>
      ${isEfectivo ? `<button class="caja-tab ${state.currentTab === 'recuento' ? 'active' : ''}" data-tab="recuento">Recuento de dinero</button>` : ''}
      <button class="caja-tab" data-action="medios">Cobranzas por medio de pago</button>
    `;

    root.innerHTML = `
      <div class="caja-toolbar">
        <div>
          <h2>💰 Caja · ${esc(medioLabel)} <span class="badge-abierta">Abierta</span></h2>
          <small class="caja-apertura-info">
            Apertura: ${fmtFecha(state.sesion.fecha_apertura)}
            · ${esc(state.sesion.nombre_apertura || '')}
          </small>
        </div>
        <div class="caja-toolbar-right">
          ${isEfectivo && canManage() ? `<button id="btn-cierre-caja" class="btn btn-danger">Cerrar Caja</button>` : ''}
        </div>
      </div>
      <div class="caja-tabs">${tabsHtml}</div>
      <div id="caja-tab-content" class="caja-tab-content"></div>
    `;

    root.querySelectorAll('.caja-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'medios') { openMediosPagoOverlay(); return; }
        switchTab(btn.dataset.tab);
      });
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
case 'egresos':     renderEgresosIngresos(content);   break;
      case 'historial':   renderHistorial(content);         break;
      case 'recuento':    renderRecuento(content);          break;
    }
  }

  // ── OVERLAY: COBRANZAS POR MEDIO DE PAGO ─────────────────────────────────────

  function openMediosPagoOverlay() {
    const tot = getTotalesSesion(state.sesion.id);
    const mediosRows = MEDIOS
      .filter(m => tot.totPagos[m] > 0)
      .map(m => `
        <div class="caja-stat-row">
          <span>${MEDIOS_LABEL[m]}</span>
          <span>${fmtPeso(tot.totPagos[m])}</span>
        </div>
      `).join('');

    openModal(`
      <button class="caja-modal-close" id="btn-close-medios">✕</button>
      <h3>Cobranzas por medio de pago</h3>
      ${mediosRows
        ? mediosRows + `
          <div class="caja-stat-row total-row" style="margin-top:8px">
            <span>Total</span>
            <span>${fmtPeso(tot.totalVentas)}</span>
          </div>`
        : '<p class="caja-empty">Sin ventas registradas en esta sesión.</p>'}
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-close-medios2">Cerrar</button>
      </div>
    `);

    ge('btn-close-medios').addEventListener('click', closeModal);
    ge('btn-close-medios2').addEventListener('click', closeModal);
  }

  // ── TAB: RESUMEN ──────────────────────────────────────────────────────────────

  function renderResumen(container) {
    const el = container || ge('caja-tab-content');
    if (!el || !state.sesion) return;
    const tot = getTotalesSesion(state.sesion.id);
    state.totales = tot;
    const medio = state.activeMedio || 'efectivo';

    const movimientos = getMovimientosDia(state.sesion.id, medio);
    const movsHtml = movimientos.length
      ? `<div style="max-height:340px;overflow-y:auto">
          <table class="caja-table mov-table">
            <thead>
              <tr>
                <th style="width:70px">Hora</th>
                <th style="width:110px">Tipo</th>
                <th>Descripción</th>
                <th style="width:150px">Medio</th>
                <th style="text-align:right;width:110px">Monto</th>
              </tr>
            </thead>
            <tbody>
              ${movimientos.map(m => {
                const amtClass = m.monto < 0 ? 'text-danger' : '';
                return `
                  <tr class="mov-row" data-tipo="${esc(m.tipo)}" data-id="${esc(m.id)}">
                    <td style="font-weight:600">${fmtHora(m.fecha)}</td>
                    <td>${movTipoBadge(m)}</td>
                    <td>${esc(m.descripcion)}</td>
                    <td>${medioTags(m.medios)}</td>
                    <td style="text-align:right;font-weight:600" class="${amtClass}">
                      ${m.monto < 0 ? '−' : ''}${fmtPeso(Math.abs(m.monto))}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>`
      : '<p class="caja-empty" style="padding:16px 0">Sin movimientos para este medio en esta sesión.</p>';

    let kpisHtml;
    if (medio === 'efectivo') {
      kpisHtml = `
        <div class="caja-stat-card">
          <div class="caja-stat-label">Cobrado en Efectivo</div>
          <div class="caja-stat-value">${fmtPeso(tot.totPagos['efectivo'] || 0)}</div>
          <div class="caja-stat-sub">${movimientos.filter(m => m.tipo === 'venta').length} venta${movimientos.filter(m => m.tipo === 'venta').length !== 1 ? 's' : ''}</div>
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
        </div>`;
    } else {
      const medioTotal = tot.totPagos[medio] || 0;
      const label = MEDIOS_LABEL[medio] || medio;
      const nVentas = movimientos.filter(m => m.tipo === 'venta').length;
      kpisHtml = `
        <div class="caja-stat-card highlight">
          <div class="caja-stat-label">Cobrado por ${label}</div>
          <div class="caja-stat-value">${fmtPeso(medioTotal)}</div>
          <div class="caja-stat-sub">${nVentas} transacción${nVentas !== 1 ? 'es' : ''}</div>
        </div>`;
    }

    el.innerHTML = `
      <div class="caja-resumen-grid">
        ${kpisHtml}
      </div>
      <div class="caja-medios-card">
        <h4>Movimientos del día · ${MEDIOS_LABEL[medio] || medio}</h4>
        ${movsHtml}
      </div>
    `;

    el.querySelectorAll('.mov-row').forEach(row => {
      row.addEventListener('click', () => openMovimientoSidebar(row.dataset.tipo, row.dataset.id));
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
        <div style="display:flex;gap:8px">
          <button id="btn-pago-proveedor" class="btn btn-sm" style="background:#e3f2fd;color:#1565c0;border:1.5px solid #90caf9;font-weight:600">💳 Pago a Proveedor</button>
          ${canManage() ? `<button id="btn-nuevo-egreso" class="btn btn-sm btn-danger">+ Egreso</button>` : ''}
        </div>
      </div>
      ${eHtml}
      <div class="caja-ei-header" style="margin-top:24px">
        <h3>Ingresos extra</h3>
        ${canManage() ? `<button id="btn-nuevo-ingreso" class="btn btn-sm btn-success">+ Ingreso</button>` : ''}
      </div>
      ${iHtml}
    `;

    ge('btn-pago-proveedor').addEventListener('click', openPagoProveedorModal);
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

  // ── SIDEBAR ───────────────────────────────────────────────────────────────────

  function ensureSidebar() {
    if (ge('caja-sidebar')) return;

    if (!ge('caja-sidebar-styles')) {
      const s = document.createElement('style');
      s.id = 'caja-sidebar-styles';
      s.textContent = `
        .caja-sidebar-overlay{position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:1000;opacity:0;pointer-events:none;transition:opacity .25s}
        .caja-sidebar-overlay.visible{opacity:1;pointer-events:all}
        .caja-sidebar{position:fixed;top:0;right:0;width:440px;max-width:95vw;height:100%;background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.18);z-index:1001;transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);overflow-y:auto;display:flex;flex-direction:column}
        .caja-sidebar.open{transform:translateX(0)}
        .caja-sidebar-header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--color-border,#e5e7eb);position:sticky;top:0;background:#fff;z-index:1}
        .caja-sidebar-body{flex:1;padding:20px}
        .btn-sidebar-close{background:none;border:none;font-size:20px;cursor:pointer;color:#888;padding:4px 8px;line-height:1}
        .btn-sidebar-close:hover{color:#333}
        .btn-sidebar-back{background:none;border:none;font-size:13px;cursor:pointer;color:var(--color-primary,#667eea);padding:0 0 14px;display:flex;align-items:center;gap:4px}
        .btn-sidebar-back:hover{text-decoration:underline}
        .mov-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}
        .mov-venta{background:#e8f5e9;color:#2E7D32}.mov-anulada{background:#ffebee;color:#C62828}
        .mov-pendiente{background:#fff8e1;color:#E65100}.mov-egreso{background:#ffebee;color:#C62828}
        .mov-ingreso{background:#e3f2fd;color:#1565C0}
        .mtag{display:inline-flex;align-items:center;gap:2px;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;margin-right:2px}
        .mtag-cash{background:#e8f5e9;color:#1b5e20}.mtag-mp{background:#e3f2fd;color:#0d47a1}
        .mtag-card{background:#e1f5fe;color:#01579b}.mtag-transf{background:#f3e5f5;color:#6a1b9a}
        .mtag-cc{background:#fff3e0;color:#e65100}
        .sb-mov-table{border-collapse:separate;border-spacing:0 3px;width:100%;font-size:13px}
        .sb-mov-table thead th{text-align:left;padding:4px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;color:#888;border-bottom:none}
        .sb-mov-table tbody tr td{padding:8px 10px;background:#f9fafb;border-bottom:none}
        .sb-mov-table tbody tr td:first-child{border-radius:6px 0 0 6px}
        .sb-mov-table tbody tr td:last-child{border-radius:0 6px 6px 0}
        .sb-mov-row{cursor:pointer}.sb-mov-row:hover td{background:#eef2ff}
      `;
      document.head.appendChild(s);
    }

    const overlay = document.createElement('div');
    overlay.id = 'caja-sidebar-overlay';
    overlay.className = 'caja-sidebar-overlay';
    overlay.addEventListener('click', closeSidebar);
    document.body.appendChild(overlay);
    const sidebar = document.createElement('div');
    sidebar.id = 'caja-sidebar';
    sidebar.className = 'caja-sidebar';
    sidebar.innerHTML = `
      <div class="caja-sidebar-header">
        <h3 id="sidebar-title" style="margin:0;font-size:1rem"></h3>
        <button class="btn-sidebar-close" id="btn-sidebar-close">✕</button>
      </div>
      <div class="caja-sidebar-body" id="sidebar-body"></div>
    `;
    document.body.appendChild(sidebar);
    ge('btn-sidebar-close').addEventListener('click', closeSidebar);
  }

  function openSidebar(title, html) {
    ensureSidebar();
    ge('sidebar-title').textContent = title;
    ge('sidebar-body').innerHTML = html;
    ge('caja-sidebar').classList.add('open');
    ge('caja-sidebar-overlay').classList.add('visible');
  }

  function closeSidebar() {
    const s = ge('caja-sidebar');
    const o = ge('caja-sidebar-overlay');
    if (s) s.classList.remove('open');
    if (o) o.classList.remove('visible');
  }

  function openMovimientoSidebar(tipo, id, onBack) {
    const backBtn = onBack
      ? `<button class="btn-sidebar-back" id="btn-sidebar-back">← Volver al turno</button>`
      : '';
    const wireBack = () => {
      const b = ge('btn-sidebar-back');
      if (b) b.addEventListener('click', onBack);
    };

    if (tipo === 'venta') {
      const rows = window.SGA_DB.query(
        `SELECT v.*, c.nombre AS cliente, u.nombre AS usuario
         FROM ventas v
         LEFT JOIN clientes c ON c.id = v.cliente_id
         LEFT JOIN usuarios u ON u.id = v.usuario_id
         WHERE v.id = ?`, [id]
      );
      if (!rows.length) return;
      const v = rows[0];
      const items = window.SGA_DB.query(
        `SELECT vi.*, p.nombre FROM venta_items vi
         LEFT JOIN productos p ON p.id = vi.producto_id WHERE vi.venta_id = ?`, [id]
      );
      const pagos = window.SGA_DB.query(`SELECT * FROM venta_pagos WHERE venta_id = ?`, [id]);
      const estadoCls = { completada: 'mov-venta', anulada: 'mov-anulada', pendiente: 'mov-pendiente' };
      const itemsHtml = items.map(i => `
        <tr>
          <td>${esc(i.nombre || '')}</td>
          <td style="text-align:center">${i.cantidad}</td>
          <td style="text-align:right">${fmtPeso(i.precio_unitario)}</td>
          <td style="text-align:right">${fmtPeso(i.subtotal)}</td>
        </tr>`).join('') || '<tr><td colspan="4" style="color:#999;padding:8px">Sin detalle</td></tr>';
      const pagosHtml = pagos.map(p => `
        <div class="caja-stat-row">
          <span>${MEDIOS_LABEL[p.medio] || esc(p.medio)}</span>
          <span>${fmtPeso(p.monto)}</span>
        </div>`).join('');
      const html = `
        ${backBtn}
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <span class="mov-badge ${estadoCls[v.estado] || 'mov-venta'}" style="font-size:13px;padding:4px 10px">${esc(v.estado)}</span>
          <span style="color:var(--color-text-secondary,#666);font-size:13px">${fmtFecha(v.fecha)}</span>
        </div>
        <div class="caja-stat-row"><span style="color:#666">Cliente</span><span>${esc(v.cliente || 'Consumidor final')}</span></div>
        <div class="caja-stat-row"><span style="color:#666">Vendedor</span><span>${esc(v.usuario || '—')}</span></div>
        <h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#999">Productos</h4>
        <table class="caja-table">
          <thead><tr><th>Producto</th><th style="text-align:center">Cant.</th><th style="text-align:right">Precio</th><th style="text-align:right">Subtotal</th></tr></thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#999">Pagos</h4>
        ${pagosHtml}
        ${(v.descuento || 0) > 0 ? `
        <div class="caja-stat-row" style="color:#e65100;margin-top:6px">
          <span>Subtotal</span><span>${fmtPeso(v.subtotal)}</span>
        </div>
        <div class="caja-stat-row" style="color:#e65100">
          <span>Descuento</span><span>-${fmtPeso(v.descuento)}</span>
        </div>` : ''}
        <div class="caja-stat-row total-row" style="margin-top:6px">
          <span>Total</span><span>${fmtPeso(v.total)}</span>
        </div>
        ${!onBack ? `<div style="margin-top:20px"><button class="btn btn-outline btn-sm" id="btn-sidebar-ir-pos">Ver en POS</button></div>` : ''}
      `;
      openSidebar('Detalle de venta', html);
      wireBack();
      const btnPos = ge('btn-sidebar-ir-pos');
      if (btnPos) btnPos.addEventListener('click', () => {
        closeSidebar();
        sessionStorage.setItem('highlight_venta', id);
        window.location.hash = '#pos';
      });

    } else if (tipo === 'egreso') {
      const rows = window.SGA_DB.query(
        `SELECT e.*, u.nombre AS usuario FROM egresos_caja e
         LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.id = ?`, [id]
      );
      if (!rows.length) return;
      const e = rows[0];
      openSidebar('Detalle de egreso', `
        ${backBtn}
        <div class="caja-stat-row"><span style="color:#666">Tipo</span>
          <span class="mov-badge mov-egreso">${EGRESO_TIPO_LABEL[e.tipo] || esc(e.tipo)}</span>
        </div>
        <div class="caja-stat-row"><span style="color:#666">Descripción</span><span>${esc(e.descripcion || '—')}</span></div>
        <div class="caja-stat-row"><span style="color:#666">Monto</span><span style="color:#C62828">−${fmtPeso(e.monto)}</span></div>
        <div class="caja-stat-row"><span style="color:#666">Fecha</span><span>${fmtFecha(e.fecha)}</span></div>
        <div class="caja-stat-row"><span style="color:#666">Usuario</span><span>${esc(e.usuario || '—')}</span></div>
      `);
      wireBack();

    } else if (tipo === 'ingreso') {
      const rows = window.SGA_DB.query(
        `SELECT i.*, u.nombre AS usuario FROM ingresos_caja i
         LEFT JOIN usuarios u ON u.id = i.usuario_id WHERE i.id = ?`, [id]
      );
      if (!rows.length) return;
      const i = rows[0];
      openSidebar('Detalle de ingreso', `
        ${backBtn}
        <div class="caja-stat-row"><span style="color:#666">Descripción</span><span>${esc(i.descripcion || '—')}</span></div>
        <div class="caja-stat-row"><span style="color:#666">Monto</span><span style="color:#2E7D32">${fmtPeso(i.monto)}</span></div>
        <div class="caja-stat-row"><span style="color:#666">Fecha</span><span>${fmtFecha(i.fecha)}</span></div>
        <div class="caja-stat-row"><span style="color:#666">Usuario</span><span>${esc(i.usuario || '—')}</span></div>
      `);
      wireBack();
    }
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

  // ── PAGO A PROVEEDOR MODAL ───────────────────────────────────────────────────

  async function openPagoProveedorModal() {
    // Lazy-load SGA_PagosProveedores data layer if not already available
    if (!window.SGA_PagosProveedores) {
      try {
        await import('./cuenta_corriente_proveedores.js');
      } catch (e) {
        showToast('Error cargando módulo de pagos', 'error');
        return;
      }
    }

    const proveedores = window.SGA_DB.query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 ORDER BY razon_social COLLATE NOCASE ASC`
    );

    if (!proveedores.length) {
      showToast('No hay proveedores registrados', 'warn');
      return;
    }

    const provOpts = proveedores.map(p =>
      `<option value="${esc(p.id)}">${esc(p.razon_social)}</option>`
    ).join('');

    openModal(`
      <button class="caja-modal-close" id="btn-close-pagoprov">✕</button>
      <h3>💳 Pago a Proveedor</h3>
      <div class="caja-form">
        <label>Proveedor <span style="color:var(--color-danger)">*</span></label>
        <select id="pp-proveedor">
          <option value="">— Seleccionar —</option>
          ${provOpts}
        </select>

        <div id="pp-pendientes-wrap" style="display:none">
          <div id="pp-pendientes-info" style="
            background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;
            padding:8px 12px;font-size:13px;color:#e65100;margin-top:2px
          "></div>
        </div>

        <label>Monto <span style="color:var(--color-danger)">*</span></label>
        <div class="caja-input-prefix">
          <span>$</span>
          <input type="number" id="pp-monto" min="1" step="0.01" placeholder="0">
        </div>

        <label>Observaciones</label>
        <input type="text" id="pp-obs" placeholder="Nro. factura, descripción, etc.">

        <div style="
          background:#e3f2fd;border:1px solid #90caf9;border-radius:6px;
          padding:8px 12px;font-size:12px;color:#1565c0;margin-top:4px
        ">
          💡 El monto se descontará de la caja y se imputará automáticamente
          a los comprobantes pendientes del proveedor (de más antiguo a más nuevo).
          Si no hay comprobantes pendientes, quedará como crédito a favor.
        </div>
      </div>
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-cancel-pagoprov">Cancelar</button>
        <button class="btn" id="btn-confirm-pagoprov"
          style="background:#1565c0;color:white;border:none;font-weight:600">
          Registrar Pago
        </button>
      </div>
    `);

    ge('btn-close-pagoprov').addEventListener('click', closeModal);
    ge('btn-cancel-pagoprov').addEventListener('click', closeModal);

    // When proveedor changes, show pending balance
    ge('pp-proveedor').addEventListener('change', () => {
      const provId = ge('pp-proveedor').value;
      const wrap   = ge('pp-pendientes-wrap');
      const info   = ge('pp-pendientes-info');
      if (!provId) { wrap.style.display = 'none'; return; }

      const pendientes = window.SGA_PagosProveedores.getComprasPendientes(provId);
      const saldo      = window.SGA_PagosProveedores.getSaldoProveedor(provId);

      if (saldo > 0.01) {
        const fmt = n => window.SGA_Utils.formatCurrency(n);
        const lines = pendientes.slice(0, 3).map(c => {
          const ref = [c.factura_pv, c.numero_factura].filter(Boolean).join('-') || '—';
          return `${ref}: ${fmt(c.saldo)}`;
        });
        const resto = pendientes.length > 3 ? ` y ${pendientes.length - 3} más…` : '';
        info.innerHTML = `Deuda total: <strong>${fmt(saldo)}</strong> · ${lines.join(' · ')}${resto}`;
        wrap.style.display = '';
      } else {
        info.innerHTML = 'Sin comprobantes pendientes. El pago quedará como crédito a favor.';
        info.style.background = '#e8f5e9';
        info.style.borderColor = '#a5d6a7';
        info.style.color = '#2e7d32';
        wrap.style.display = '';
      }
    });

    ge('btn-confirm-pagoprov').addEventListener('click', () => {
      const provId = ge('pp-proveedor').value;
      const monto  = parseFloat(ge('pp-monto').value);
      const obs    = ge('pp-obs').value.trim() || null;

      if (!provId) { showToast('Seleccioná un proveedor', 'warn'); return; }
      if (!monto || monto <= 0) { showToast('Ingresá un monto válido', 'warn'); return; }

      const result = window.SGA_PagosProveedores.crearPago({
        proveedor_id:  provId,
        fecha:         new Date().toISOString().slice(0, 10),
        observaciones: obs,
        usuario_id:    state.user.id,
        metodos: [{
          metodo:        'efectivo',
          monto,
          sesion_caja_id: state.sesion.id,
        }],
        auto_imputar: true,
      });

      if (result.success) {
        const sobrante = result.credito_sobrante || 0;
        const msg = sobrante > 0.01
          ? `Pago registrado. Crédito sobrante: ${window.SGA_Utils.formatCurrency(sobrante)}`
          : 'Pago a proveedor registrado';
        showToast(msg, 'success');
        closeModal();
        switchTab('egresos');
      } else {
        showToast('Error: ' + result.error, 'error');
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

  // ── TAB: RECUENTO DE DINERO ───────────────────────────────────────────────────

  function renderRecuento(container) {
    const el = container || ge('caja-tab-content');
    if (!el || !state.sesion) return;

    const denoms = getDenominaciones();

    // Load saved billetes if state is empty
    if (!Object.keys(state.recuento.billetes).length) {
      try {
        const saved = JSON.parse(state.sesion.detalle_billetes || '{}');
        state.recuento.billetes = (saved.billetes && typeof saved.billetes === 'object')
          ? saved.billetes : saved;
      } catch (e) { /* no saved data */ }
    }

    const tot = getTotalesSesion(state.sesion.id);
    const totalContado = denoms.reduce(
      (sum, d) => sum + d * (parseFloat(state.recuento.billetes[d]) || 0), 0
    );
    const diferencia = totalContado - tot.saldoEsperado;
    const difClass = diferencia > 0.005 ? 'text-success' : diferencia < -0.005 ? 'text-danger' : '';

    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <p style="margin:0;font-size:14px;color:#666">
          Contá los billetes y monedas en caja en cualquier momento de la sesión.
        </p>
        ${state.user && state.user.rol === 'admin'
          ? `<button id="btn-editar-denoms" class="btn btn-outline btn-sm" style="white-space:nowrap;margin-left:12px">⚙ Editar denominaciones</button>`
          : ''}
      </div>
      <table class="cierre-billetes-table">
        <thead>
          <tr>
            <th>Denominación</th>
            <th style="text-align:center;width:130px">Cantidad</th>
            <th style="text-align:right">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${denoms.map(d => `
            <tr>
              <td>${fmtPeso(d)}</td>
              <td style="text-align:center">
                <input type="number" class="billete-input recuento-input" data-denom="${d}" min="0"
                  value="${parseFloat(state.recuento.billetes[d]) || 0}">
              </td>
              <td class="billete-subtotal" id="rec-sub-${d}" style="text-align:right">
                ${fmtPeso((parseFloat(state.recuento.billetes[d]) || 0) * d)}
              </td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2"><strong>Total contado</strong></td>
            <td style="text-align:right" id="recuento-total-contado"><strong>${fmtPeso(totalContado)}</strong></td>
          </tr>
        </tfoot>
      </table>
      <div class="cierre-resumen" style="margin-top:16px">
        <div class="caja-stat-row">
          <span>Saldo esperado (efectivo)</span>
          <span>${fmtPeso(tot.saldoEsperado)}</span>
        </div>
        <div class="caja-stat-row highlight-row">
          <span>Diferencia</span>
          <span id="recuento-diferencia" class="${difClass}">
            ${diferencia >= 0 ? '+' : ''}${fmtPeso(diferencia)}
          </span>
        </div>
      </div>
      <div style="margin-top:16px">
        <button id="btn-guardar-recuento" class="btn btn-primary">Guardar recuento</button>
      </div>
    `;

    el.querySelectorAll('.recuento-input').forEach(inp => {
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('input', () => {
        const d = parseFloat(inp.dataset.denom);
        const n = parseFloat(inp.value) || 0;
        state.recuento.billetes[d] = n;
        const subEl = ge(`rec-sub-${inp.dataset.denom}`);
        if (subEl) subEl.textContent = fmtPeso(d * n);
        const total = denoms.reduce(
          (sum, den) => sum + den * (parseFloat(state.recuento.billetes[den]) || 0), 0
        );
        const totEl = ge('recuento-total-contado');
        if (totEl) totEl.innerHTML = `<strong>${fmtPeso(total)}</strong>`;
        const dif = total - tot.saldoEsperado;
        const difEl = ge('recuento-diferencia');
        if (difEl) {
          difEl.textContent = (dif >= 0 ? '+' : '') + fmtPeso(dif);
          difEl.className = dif > 0.005 ? 'text-success' : dif < -0.005 ? 'text-danger' : '';
        }
      });
    });

    const btnGuardar = ge('btn-guardar-recuento');
    if (btnGuardar) btnGuardar.addEventListener('click', () => {
      const billetes = {};
      el.querySelectorAll('.recuento-input').forEach(inp => {
        const n = parseFloat(inp.value) || 0;
        if (n > 0) billetes[inp.dataset.denom] = n;
      });
      try {
        window.SGA_DB.run(
          `UPDATE sesiones_caja SET detalle_billetes = ?, updated_at = ? WHERE id = ?`,
          [JSON.stringify({ billetes }), window.SGA_Utils.formatISODate(new Date()), state.sesion.id]
        );
        state.recuento.billetes = billetes;
        showToast('Recuento guardado', 'success');
      } catch (e) {
        showToast('Error al guardar: ' + e.message, 'error');
      }
    });

    const btnEditDenoms = ge('btn-editar-denoms');
    if (btnEditDenoms) btnEditDenoms.addEventListener('click', openDenomModal);
  }

  // ── EDITAR DENOMINACIONES MODAL ───────────────────────────────────────────────

  function openDenomModal() {
    let denoms = getDenominaciones().slice();

    const renderDenomList = () => {
      const list = ge('denom-list');
      if (!list) return;
      list.innerHTML = denoms.map((d, i) => `
        <div class="denom-row">
          <span style="flex:1;font-weight:500">${fmtPeso(d)}</span>
          <button class="btn btn-xs btn-outline denom-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-xs btn-outline denom-down" data-idx="${i}" ${i === denoms.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-xs btn-danger denom-remove" data-idx="${i}">✕</button>
        </div>
      `).join('');

      list.querySelectorAll('.denom-up').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.idx);
          if (i > 0) { [denoms[i - 1], denoms[i]] = [denoms[i], denoms[i - 1]]; renderDenomList(); }
        });
      });
      list.querySelectorAll('.denom-down').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.idx);
          if (i < denoms.length - 1) { [denoms[i], denoms[i + 1]] = [denoms[i + 1], denoms[i]]; renderDenomList(); }
        });
      });
      list.querySelectorAll('.denom-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          denoms.splice(parseInt(btn.dataset.idx), 1);
          renderDenomList();
        });
      });
    };

    openModal(`
      <button class="caja-modal-close" id="btn-close-denoms">✕</button>
      <h3>Editar denominaciones</h3>
      <div id="denom-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px"></div>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="number" id="denom-nueva" placeholder="Nueva denominación (ej: 200)" min="1" step="1"
          style="flex:1;border:1px solid var(--color-border);border-radius:var(--radius-md);padding:8px 10px;font-size:14px">
        <button class="btn btn-secondary" id="btn-agregar-denom">+ Agregar</button>
      </div>
      <div class="caja-modal-footer">
        <button class="btn btn-outline" id="btn-cancel-denoms">Cancelar</button>
        <button class="btn btn-primary" id="btn-save-denoms">Guardar</button>
      </div>
    `);

    renderDenomList();

    ge('btn-close-denoms').addEventListener('click', closeModal);
    ge('btn-cancel-denoms').addEventListener('click', closeModal);

    ge('btn-agregar-denom').addEventListener('click', () => {
      const val = parseInt(ge('denom-nueva').value);
      if (!val || val <= 0) { showToast('Ingresá un valor válido', 'warn'); return; }
      if (denoms.includes(val)) { showToast('Ya existe esa denominación', 'warn'); return; }
      denoms.push(val);
      denoms.sort((a, b) => b - a);
      ge('denom-nueva').value = '';
      renderDenomList();
    });

    ge('denom-nueva').addEventListener('keydown', e => {
      if (e.key === 'Enter') ge('btn-agregar-denom').click();
    });

    ge('btn-save-denoms').addEventListener('click', () => {
      if (!denoms.length) { showToast('Debe haber al menos una denominación', 'warn'); return; }
      try {
        window.SGA_DB.run(
          `INSERT OR REPLACE INTO system_config (clave, valor, updated_at) VALUES ('denominaciones', ?, datetime('now'))`,
          [JSON.stringify(denoms)]
        );
        // Update in-memory fallback and reset stale bill quantities
        window.SGA_Utils.DENOMINACIONES = denoms.slice();
        state.recuento.billetes = {};
        closeModal();
        switchTab('recuento');
        showToast('Denominaciones guardadas', 'success');
      } catch (e) {
        showToast('Error al guardar: ' + e.message, 'error');
      }
    });
  }

  // ── CIERRE MODAL ──────────────────────────────────────────────────────────────

  function openCierreModal() {
    const tot = getTotalesSesion(state.sesion.id);
    state.totales = tot;
    const denoms = getDenominaciones();

    // Pre-fill efectivo from saved recuento
    const totalContado = denoms.reduce(
      (sum, d) => sum + d * (parseFloat(state.recuento.billetes[d]) || 0), 0
    );

    state.cierre = { mediosInformados: {}, explicaciones: {} };

    // medios to show: efectivo always; others only if they have sales activity
    const mediosCierre = [
      { id: 'efectivo',      label: '💵 Efectivo',      esperado: tot.saldoEsperado },
      { id: 'mercadopago',   label: '📱 Mercado Pago',  esperado: tot.totPagos['mercadopago']   || 0 },
      { id: 'tarjeta',       label: '💳 Tarjeta',       esperado: tot.totPagos['tarjeta']       || 0 },
      { id: 'transferencia', label: '🏦 Transferencia', esperado: tot.totPagos['transferencia'] || 0 },
    ].filter(m => m.id === 'efectivo' || m.esperado > 0);

    // Init informed amounts (efectivo from recuento if available, else saldo esperado)
    mediosCierre.forEach(m => {
      state.cierre.mediosInformados[m.id] = (m.id === 'efectivo' && totalContado > 0)
        ? totalContado : m.esperado;
    });

    const { egresos, ingresos } = getEgresosIngresos(state.sesion.id);
    const totalEgresos = egresos.reduce((s, e) => s + parseFloat(e.monto || 0), 0);
    const totalIngresos = ingresos.reduce((s, i) => s + parseFloat(i.monto || 0), 0);

    const mediosRowsHtml = mediosCierre.map(m => {
      const informado = state.cierre.mediosInformados[m.id];
      const diff = informado - m.esperado;
      const diffClass = diff > 0.005 ? 'text-success' : diff < -0.005 ? 'text-danger' : '';
      return `
        <tr data-medio="${esc(m.id)}">
          <td>${m.label}</td>
          <td style="text-align:right">${fmtPeso(m.esperado)}</td>
          <td style="text-align:right;padding:4px 8px">
            <input type="number" class="billete-input cierre-medio-input"
              data-medio="${esc(m.id)}" data-esperado="${m.esperado}"
              value="${informado}" min="0" step="0.01"
              style="width:110px;text-align:right">
          </td>
          <td style="text-align:right;min-width:80px">
            <span class="cierre-diff ${diffClass}" id="cierre-diff-${esc(m.id)}">
              ${diff >= 0 ? '+' : ''}${fmtPeso(diff)}
            </span>
          </td>
          <td>
            <button class="btn btn-xs btn-outline cierre-btn-explicar"
              data-medio="${esc(m.id)}" id="btn-explicar-${esc(m.id)}"
              style="display:${Math.abs(diff) > 0.005 ? 'inline-flex' : 'none'}">
              💬 Explicar
            </button>
          </td>
        </tr>
        <tr>
          <td colspan="5" style="padding:0">
            <div id="expl-panel-${esc(m.id)}" class="cierre-expl-panel" style="display:none">
              <div class="cierre-expl-header">
                <span id="expl-diff-label-${esc(m.id)}">
                  Diferencia: ${diff >= 0 ? '+' : ''}${fmtPeso(diff)}
                </span>
                <span id="expl-status-${esc(m.id)}" class="expl-status"></span>
              </div>
              <div id="expl-rows-${esc(m.id)}"></div>
              <button class="btn btn-xs btn-outline" id="btn-add-expl-${esc(m.id)}"
                data-medio="${esc(m.id)}" style="margin-top:6px">+ Agregar fila</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    openModal(`
      <button class="caja-modal-close" id="btn-close-cierre">✕</button>
      <h3>Cierre de Caja</h3>

      <h4 class="cierre-section-title">Verificación por medio de pago</h4>
      <table class="cierre-verificacion-table">
        <thead>
          <tr>
            <th>Medio</th>
            <th style="text-align:right">Esperado</th>
            <th style="text-align:right">Informado</th>
            <th style="text-align:right">Diferencia</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${mediosRowsHtml}</tbody>
      </table>

      <h4 class="cierre-section-title" style="margin-top:20px">Egresos e Ingresos</h4>
      <div class="cierre-ei-links">
        <a href="#" id="toggle-cierre-egresos" class="cierre-ei-link">
          📋 Ver egresos del turno
          (${egresos.length} movimiento${egresos.length !== 1 ? 's' : ''} — ${fmtPeso(totalEgresos)})
        </a>
        <div id="cierre-egresos-panel" class="cierre-ei-panel" style="display:none">
          ${egresos.length
            ? `<table class="caja-table">${egresos.map(e =>
                `<tr><td>${fmtFecha(e.fecha)}</td><td>${esc(e.descripcion || '')}</td>
                 <td style="text-align:right;color:var(--color-danger)">${fmtPeso(e.monto)}</td></tr>`
              ).join('')}</table>`
            : '<p style="color:#999;padding:8px 0;font-size:13px">Sin egresos</p>'}
          <small style="color:#999;display:block;margin-top:6px">Si encontrás un error, cerrá este panel y corregilo en el módulo Caja.</small>
        </div>
        <a href="#" id="toggle-cierre-ingresos" class="cierre-ei-link">
          📋 Ver ingresos extra del turno
          (${ingresos.length} movimiento${ingresos.length !== 1 ? 's' : ''} — ${fmtPeso(totalIngresos)})
        </a>
        <div id="cierre-ingresos-panel" class="cierre-ei-panel" style="display:none">
          ${ingresos.length
            ? `<table class="caja-table">${ingresos.map(i =>
                `<tr><td>${fmtFecha(i.fecha)}</td><td>${esc(i.descripcion || '')}</td>
                 <td style="text-align:right;color:var(--color-success)">${fmtPeso(i.monto)}</td></tr>`
              ).join('')}</table>`
            : '<p style="color:#999;padding:8px 0;font-size:13px">Sin ingresos extra</p>'}
          <small style="color:#999;display:block;margin-top:6px">Si encontrás un error, cerrá este panel y corregilo en el módulo Caja.</small>
        </div>
      </div>

      <div class="caja-modal-footer" style="flex-direction:column;align-items:stretch;gap:8px">
        <p id="cierre-warn" style="color:var(--color-danger);font-size:13px;display:none;margin:0">
          ⚠️ Explicá todas las diferencias antes de confirmar.
        </p>
        <button class="btn btn-danger" id="btn-cierre-confirm"
          style="width:100%;justify-content:center;font-size:15px;padding:12px">
          ✓ Confirmar cierre de caja
        </button>
      </div>
    `);

    // ── Helpers ─────────────────────────────────────────────────────────────────

    const validateCierre = () => {
      let allOk = true;
      mediosCierre.forEach(m => {
        const informado = parseFloat(state.cierre.mediosInformados[m.id]) || 0;
        const diff = informado - m.esperado;
        if (Math.abs(diff) > 0.005) {
          const expls = state.cierre.explicaciones[m.id] || [];
          const totalExpl = expls.reduce((s, r) => s + (parseFloat(r.monto) || 0), 0);
          if (Math.abs(totalExpl - Math.abs(diff)) > 0.005) allOk = false;
        }
      });
      const confirmBtn = ge('btn-cierre-confirm');
      const warnEl = ge('cierre-warn');
      if (confirmBtn) confirmBtn.disabled = !allOk;
      if (warnEl) warnEl.style.display = allOk ? 'none' : 'block';
    };

    const updateDiff = (medioId, esperado) => {
      const informado = parseFloat(state.cierre.mediosInformados[medioId]) || 0;
      const diff = informado - esperado;
      const diffEl = ge(`cierre-diff-${medioId}`);
      if (diffEl) {
        diffEl.textContent = (diff >= 0 ? '+' : '') + fmtPeso(diff);
        diffEl.className = `cierre-diff ${diff > 0.005 ? 'text-success' : diff < -0.005 ? 'text-danger' : ''}`;
      }
      const explBtn = ge(`btn-explicar-${medioId}`);
      if (explBtn) explBtn.style.display = Math.abs(diff) > 0.005 ? 'inline-flex' : 'none';
      const lbl = ge(`expl-diff-label-${medioId}`);
      if (lbl) lbl.textContent = `Diferencia: ${diff >= 0 ? '+' : ''}${fmtPeso(diff)}`;
      const panel = ge(`expl-panel-${medioId}`);
      if (panel && Math.abs(diff) <= 0.005) panel.style.display = 'none';
      validateCierre();
    };

    const updateExplStatus = (medioId) => {
      const informado = parseFloat(state.cierre.mediosInformados[medioId]) || 0;
      const mObj = mediosCierre.find(m => m.id === medioId);
      const diff = Math.abs(informado - (mObj ? mObj.esperado : 0));
      const expls = state.cierre.explicaciones[medioId] || [];
      const totalExpl = expls.reduce((s, r) => s + (parseFloat(r.monto) || 0), 0);
      const statusEl = ge(`expl-status-${medioId}`);
      if (!statusEl) return;
      const ok = Math.abs(totalExpl - diff) <= 0.005;
      statusEl.textContent = `Explicado: ${fmtPeso(totalExpl)} / ${fmtPeso(diff)}${ok ? ' ✓' : ''}`;
      statusEl.className = `expl-status ${ok ? 'text-success' : 'text-danger'}`;
    };

    const renderExplRows = (medioId) => {
      const container = ge(`expl-rows-${medioId}`);
      if (!container) return;
      const rows = state.cierre.explicaciones[medioId] || [];
      container.innerHTML = rows.map((r, i) => `
        <div class="expl-row">
          <input type="number" class="billete-input expl-monto"
            data-medio="${esc(medioId)}" data-idx="${i}"
            placeholder="Monto" value="${r.monto || ''}" min="0" step="0.01"
            style="width:100px;text-align:right">
          <input type="text" class="expl-motivo"
            data-medio="${esc(medioId)}" data-idx="${i}"
            placeholder="Motivo" value="${esc(r.motivo || '')}"
            style="flex:1;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:4px 8px;font-size:13px">
          <button class="btn btn-xs btn-danger expl-remove"
            data-medio="${esc(medioId)}" data-idx="${i}">✕</button>
        </div>
      `).join('');

      container.querySelectorAll('.expl-monto').forEach(inp => {
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('input', () => {
          const i = parseInt(inp.dataset.idx);
          state.cierre.explicaciones[inp.dataset.medio][i].monto = parseFloat(inp.value) || 0;
          updateExplStatus(inp.dataset.medio);
          validateCierre();
        });
      });
      container.querySelectorAll('.expl-motivo').forEach(inp => {
        inp.addEventListener('input', () => {
          const i = parseInt(inp.dataset.idx);
          state.cierre.explicaciones[inp.dataset.medio][i].motivo = inp.value;
        });
      });
      container.querySelectorAll('.expl-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          state.cierre.explicaciones[btn.dataset.medio].splice(parseInt(btn.dataset.idx), 1);
          renderExplRows(btn.dataset.medio);
          updateExplStatus(btn.dataset.medio);
          validateCierre();
        });
      });
    };

    // ── Event listeners ──────────────────────────────────────────────────────────

    ge('btn-close-cierre').addEventListener('click', closeModal);

    ge('toggle-cierre-egresos').addEventListener('click', e => {
      e.preventDefault();
      const p = ge('cierre-egresos-panel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });
    ge('toggle-cierre-ingresos').addEventListener('click', e => {
      e.preventDefault();
      const p = ge('cierre-ingresos-panel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });

    document.querySelectorAll('.cierre-medio-input').forEach(inp => {
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('input', () => {
        state.cierre.mediosInformados[inp.dataset.medio] = parseFloat(inp.value) || 0;
        updateDiff(inp.dataset.medio, parseFloat(inp.dataset.esperado));
      });
    });

    document.querySelectorAll('.cierre-btn-explicar').forEach(btn => {
      btn.addEventListener('click', () => {
        const mid = btn.dataset.medio;
        const panel = ge(`expl-panel-${mid}`);
        if (!panel) return;
        const showing = panel.style.display !== 'none';
        panel.style.display = showing ? 'none' : 'block';
        if (!showing) {
          if (!state.cierre.explicaciones[mid] || !state.cierre.explicaciones[mid].length) {
            state.cierre.explicaciones[mid] = [{ monto: 0, motivo: '' }];
          }
          renderExplRows(mid);
          updateExplStatus(mid);
        }
      });
    });

    mediosCierre.forEach(m => {
      const addBtn = ge(`btn-add-expl-${m.id}`);
      if (!addBtn) return;
      addBtn.addEventListener('click', () => {
        if (!state.cierre.explicaciones[m.id]) state.cierre.explicaciones[m.id] = [];
        state.cierre.explicaciones[m.id].push({ monto: 0, motivo: '' });
        renderExplRows(m.id);
      });
    });

    ge('btn-cierre-confirm').addEventListener('click', confirmarCierre);
    validateCierre();
  }

  function confirmarCierre() {
    const sesionId = state.sesion.id;
    const tot = state.totales;
    const saldoReal = parseFloat(state.cierre.mediosInformados['efectivo']) || (tot ? tot.saldoEsperado : 0);
    const detalleCompleto = {
      billetes: state.recuento.billetes,
      medios_informados: state.cierre.mediosInformados,
      explicaciones: state.cierre.explicaciones,
    };
    const result = cerrarCaja(sesionId, state.user.id, saldoReal, detalleCompleto);
    if (result.success) {
      closeModal();
      stopAutoRefresh();
      let sesionCerrada = null;
      try {
        sesionCerrada = window.SGA_DB.query(
          `SELECT * FROM sesiones_caja WHERE id = ?`, [sesionId]
        )[0] || null;
      } catch (e) { /* ignore */ }
      state.sesion = null;
      renderPostCierreSummary(sesionCerrada, tot);
    } else {
      showToast(result.error, 'error');
    }
  }

  // ── POST-CIERRE SUMMARY ───────────────────────────────────────────────────────

  function renderPostCierreSummary(sesion, tot) {
    const root = ge('caja-root');
    if (!root) return;

    const saldoReal     = parseFloat(sesion && sesion.saldo_final_real) || 0;
    const saldoEsperado = tot ? tot.saldoEsperado : 0;
    const diferencia    = saldoReal - saldoEsperado;
    const difClass      = diferencia > 0.005 ? 'text-success' : diferencia < -0.005 ? 'text-danger' : '';

    const MEDIOS_ICON = {
      efectivo: '💵 Efectivo', mercadopago: '📱 Mercado Pago',
      tarjeta: '💳 Tarjeta', transferencia: '🏦 Transferencia',
    };

    const mediosHtml = ['efectivo', 'mercadopago', 'tarjeta', 'transferencia']
      .filter(m => tot && (tot.totPagos[m] || 0) > 0)
      .map(m => `
        <div class="caja-stat-row">
          <span>${MEDIOS_ICON[m]}</span>
          <span>${fmtPeso(tot.totPagos[m])}</span>
        </div>
      `).join('');

    const explEfectivo = (state.cierre.explicaciones && state.cierre.explicaciones['efectivo']) || [];
    const explHtml = explEfectivo
      .filter(r => r.monto)
      .map(r => `
        <div class="caja-stat-row" style="font-size:13px;color:#666">
          <span>→ ${esc(r.motivo || 'Sin detalle')}</span>
          <span>${fmtPeso(r.monto)}</span>
        </div>
      `).join('');

    const summaryLines = [
      '📊 CIERRE DE CAJA',
      `Apertura: ${fmtFecha(sesion ? sesion.fecha_apertura : '')}`,
      `Cierre:   ${fmtFecha(sesion ? sesion.fecha_cierre : '')}`,
      '',
      'VENTAS',
      `Total ventas: ${tot ? fmtPeso(tot.totalVentas) : '-'} (${tot ? tot.nVentas : 0} ventas)`,
      '',
      'SALDO DE CAJA',
      `Saldo inicial:  ${tot ? fmtPeso(tot.saldoInicial) : '-'}`,
      `Ventas efect.:  ${tot ? fmtPeso(tot.totPagos['efectivo'] || 0) : '-'}`,
      tot && tot.ingresos > 0 ? `Ingresos extra: +${fmtPeso(tot.ingresos)}` : null,
      tot && tot.egresos > 0  ? `Egresos:        -${fmtPeso(tot.egresos)}` : null,
      `Saldo esperado: ${fmtPeso(saldoEsperado)}`,
      `Saldo contado:  ${fmtPeso(saldoReal)}`,
      `Diferencia:     ${diferencia >= 0 ? '+' : ''}${fmtPeso(diferencia)}`,
    ].filter(l => l !== null).join('\n');

    root.innerHTML = `
      <div class="caja-toolbar">
        <h2>📊 Resumen del turno</h2>
      </div>
      <div style="max-width:640px;margin:0 auto;padding:24px 20px">
        <p style="font-size:13px;color:var(--color-text-secondary);margin:0 0 20px">
          ${fmtFecha(sesion ? sesion.fecha_apertura : '')}
          → ${fmtFecha(sesion ? sesion.fecha_cierre : '')}
        </p>

        <div class="postcaja-section">
          <h3>Ventas</h3>
          <div class="caja-stat-row">
            <span>Ventas realizadas</span>
            <span>${tot ? tot.nVentas : 0} venta${tot && tot.nVentas !== 1 ? 's' : ''} — ${tot ? fmtPeso(tot.totalVentas) : '-'}</span>
          </div>
        </div>

        <div class="postcaja-section">
          <h3>Valores recibidos por medio de pago</h3>
          ${mediosHtml || '<div class="caja-stat-row"><span style="color:#999">Sin ventas registradas</span></div>'}
          <div class="caja-stat-row total-row">
            <span>TOTAL RECIBIDO</span>
            <span>${tot ? fmtPeso(tot.totalVentas) : '-'}</span>
          </div>
        </div>

        <div class="postcaja-section">
          <h3>Saldo de caja (efectivo)</h3>
          <div class="caja-stat-row"><span>Saldo inicial</span><span>${tot ? fmtPeso(tot.saldoInicial) : '-'}</span></div>
          <div class="caja-stat-row"><span>+ Ventas en efectivo</span><span>${tot ? fmtPeso(tot.totPagos['efectivo'] || 0) : '-'}</span></div>
          ${tot && tot.ingresos > 0 ? `<div class="caja-stat-row"><span>+ Ingresos extra</span><span class="text-success">${fmtPeso(tot.ingresos)}</span></div>` : ''}
          ${tot && tot.egresos > 0  ? `<div class="caja-stat-row"><span>− Egresos</span><span class="text-danger">-${fmtPeso(tot.egresos)}</span></div>` : ''}
          <div class="caja-stat-row highlight-row"><span>Saldo esperado</span><span>${fmtPeso(saldoEsperado)}</span></div>
          <div class="caja-stat-row"><span>Saldo informado (contado)</span><span>${fmtPeso(saldoReal)}</span></div>
          <div class="caja-stat-row ${Math.abs(diferencia) > 0.005 ? 'highlight-row' : ''}">
            <span>Diferencia</span>
            <span class="${difClass}">${diferencia >= 0 ? '+' : ''}${fmtPeso(diferencia)}</span>
          </div>
          ${explHtml ? `
            <div style="padding:6px 0 0">
              <small style="color:#999;font-size:12px;display:block;margin-bottom:4px">Ajustes declarados:</small>
              ${explHtml}
            </div>` : ''}
        </div>

        <div style="display:flex;gap:10px;margin-top:24px;flex-wrap:wrap">
          <button class="btn btn-outline" onclick="window.print()">🖨️ Imprimir resumen</button>
          <button class="btn btn-secondary" id="btn-compartir-resumen">📤 Compartir</button>
          <button class="btn btn-primary" id="btn-aceptar-resumen">✓ Aceptar</button>
        </div>
        <div id="compartir-opciones" style="display:none;margin-top:10px;gap:8px;flex-wrap:wrap">
          <a class="btn btn-outline btn-sm"
            href="mailto:?subject=Cierre%20de%20Caja&body=${encodeURIComponent(summaryLines)}">
            📧 Email
          </a>
          <a class="btn btn-outline btn-sm"
            href="https://wa.me/?text=${encodeURIComponent(summaryLines)}" target="_blank">
            💬 WhatsApp
          </a>
        </div>
      </div>
    `;

    ge('btn-compartir-resumen').addEventListener('click', () => {
      const div = ge('compartir-opciones');
      div.style.display = div.style.display === 'none' ? 'flex' : 'none';
    });

    ge('btn-aceptar-resumen').addEventListener('click', () => {
      state.cierre = { mediosInformados: {}, explicaciones: {} };
      state.recuento = { billetes: {} };
      render();
    });
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
    try { billetes = JSON.parse(s.detalle_billetes || '{}'); } catch (e) { console.warn('parse detalle_billetes:', e); }

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

  // ── OVERVIEW ─────────────────────────────────────────────────────────────────

  function renderOverview() {
    const root = ge('caja-root');
    if (!root) return;

    if (!ge('caja-overview-styles')) {
      const s = document.createElement('style');
      s.id = 'caja-overview-styles';
      s.textContent = `
        .caja-overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;padding:28px 24px}
        .caja-overview-card{
          background:#fff;border-radius:14px;padding:32px 24px;
          box-shadow:0 2px 10px rgba(0,0,0,.08);cursor:pointer;text-align:center;
          border:2px solid transparent;transition:all .2s;user-select:none;
        }
        .caja-overview-card:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(0,0,0,.13);border-color:var(--color-primary)}
        .caja-overview-card.co-efectivo{background:linear-gradient(135deg,#f0f4ff,#e8ecff)}
        .caja-overview-card.co-mercadopago{background:linear-gradient(135deg,#e3f2fd,#d0eafc)}
        .caja-overview-card.co-tarjeta{background:linear-gradient(135deg,#e1f5fe,#ccedfb)}
        .caja-overview-card.co-transferencia{background:linear-gradient(135deg,#f3e5f5,#ead5f7)}
        .caja-overview-icon{font-size:2.2em;margin-bottom:10px}
        .caja-overview-label{font-size:.88em;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#666;margin-bottom:10px}
        .caja-overview-value{font-size:1.7em;font-weight:700;color:#333;margin-bottom:6px}
        .caja-overview-sub{font-size:.82em;color:#888}
        .caja-overview-hint{text-align:center;color:#bbb;font-size:.82em;margin-top:4px;padding-bottom:12px}
      `;
      document.head.appendChild(s);
    }

    const tot = state.sesion ? getTotalesSesion(state.sesion.id) : null;

    const cajas = [
      {
        medio: 'efectivo', icon: '💵', label: 'Efectivo',
        value: tot ? tot.saldoEsperado : 0,
        sub: tot ? `Cobrado: ${fmtPeso(tot.totPagos['efectivo'] || 0)} · Inicial: ${fmtPeso(tot.saldoInicial)}` : 'Sin sesión activa',
      },
      {
        medio: 'mercadopago', icon: '📲', label: 'Mercado Pago',
        value: tot ? (tot.totPagos['mercadopago'] || 0) : 0,
        sub: `${tot ? (tot.totPagos['mercadopago'] > 0 ? 'Cobrado hoy' : 'Sin movimientos') : 'Sin sesión activa'}`,
      },
      {
        medio: 'tarjeta', icon: '💳', label: 'Tarjeta',
        value: tot ? (tot.totPagos['tarjeta'] || 0) : 0,
        sub: `${tot ? (tot.totPagos['tarjeta'] > 0 ? 'Cobrado hoy' : 'Sin movimientos') : 'Sin sesión activa'}`,
      },
      {
        medio: 'transferencia', icon: '🏦', label: 'Transferencia',
        value: tot ? (tot.totPagos['transferencia'] || 0) : 0,
        sub: `${tot ? (tot.totPagos['transferencia'] > 0 ? 'Cobrado hoy' : 'Sin movimientos') : 'Sin sesión activa'}`,
      },
    ];

    root.innerHTML = `
      <div class="caja-toolbar">
        <div>
          <h2>💰 Cajas</h2>
          <small class="caja-apertura-info">
            ${state.sesion
              ? `Sesión abierta desde ${fmtFecha(state.sesion.fecha_apertura)} · ${esc(state.sesion.nombre_apertura || '')}`
              : 'No hay caja abierta — ir a 💵 Efectivo para abrir una sesión'}
          </small>
        </div>
      </div>
      <div class="caja-overview-grid">
        ${cajas.map(c => `
          <div class="caja-overview-card co-${c.medio}" data-medio="${c.medio}">
            <div class="caja-overview-icon">${c.icon}</div>
            <div class="caja-overview-label">${c.label}</div>
            <div class="caja-overview-value">${fmtPeso(c.value)}</div>
            <div class="caja-overview-sub">${c.sub}</div>
          </div>
        `).join('')}
      </div>
      <p class="caja-overview-hint">Doble clic en una caja para ver el detalle</p>
    `;

    root.querySelectorAll('.caja-overview-card').forEach(card => {
      card.addEventListener('dblclick', () => {
        window.location.hash = `#caja/${card.dataset.medio}`;
      });
    });
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────

  const init = (params = []) => {
    state.user = window.SGA_Auth.getCurrentUser();
    if (!state.user) { window.location.hash = '#pos'; return; }

    const VALID_MEDIOS = ['efectivo', 'mercadopago', 'tarjeta', 'transferencia'];
    const medio = params[0];
    state.sesion = getSesionActiva(state.user.sucursal_id);

    if (!medio || !VALID_MEDIOS.includes(medio)) {
      state.activeMedio = null;
      renderOverview();
      return;
    }

    state.activeMedio = medio;
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
