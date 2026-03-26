/**
 * clientes.js — Customers & Cuenta Corriente Module
 *
 * Exposes window.SGA_Clientes data layer (used by POS and other modules).
 * Exports default { init } for SPA router.
 */

// ── DATA LAYER ──────────────────────────────────────────────────────────────

const SGA_Clientes = (() => {
  'use strict';

  const db = () => window.SGA_DB;
  const uid = () => window.SGA_Utils.generateUUID();
  const now = () => window.SGA_Utils.formatISODate(new Date());

  // ── HELPERS ───────────────────────────────────────────────────────────────

  function getSaldoActual(clienteId) {
    const r = db().query(
      `SELECT COALESCE(SUM(monto), 0) AS saldo FROM cuenta_corriente WHERE cliente_id = ?`,
      [clienteId]
    );
    return r.length ? (r[0].saldo || 0) : 0;
  }

  function getSaldoLote(masterClienteId) {
    // Master's own saldo + all family members' saldos
    const r = db().query(`
      SELECT COALESCE(SUM(cc.monto), 0) AS saldo
      FROM cuenta_corriente cc
      WHERE cc.cliente_id = ?
        OR cc.cliente_id IN (
          SELECT id FROM clientes WHERE cliente_master_id = ?
        )
    `, [masterClienteId, masterClienteId]);
    return r.length ? (r[0].saldo || 0) : 0;
  }

  function getTopeDisponible(clienteId) {
    const rows = db().query(
      `SELECT tope_deuda, cliente_master_id, es_master FROM clientes WHERE id = ?`,
      [clienteId]
    );
    if (!rows.length) return 0;
    const c = rows[0];
    if (c.cliente_master_id) {
      // Member: use master's tope and lote debt
      const masterRows = db().query(
        `SELECT tope_deuda FROM clientes WHERE id = ?`,
        [c.cliente_master_id]
      );
      const tope = masterRows.length ? (masterRows[0].tope_deuda || 0) : 0;
      const deudaLote = getSaldoLote(c.cliente_master_id);
      return tope - Math.max(0, deudaLote);
    }
    if (c.es_master) {
      const tope = c.tope_deuda || 0;
      const deudaLote = getSaldoLote(clienteId);
      return tope - Math.max(0, deudaLote);
    }
    // Independent
    const tope = c.tope_deuda || 0;
    const saldo = getSaldoActual(clienteId);
    return tope - Math.max(0, saldo);
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────

  function getAll({ search = '', soloConDeuda = false, soloMasters = false, activo = 1 } = {}) {
    const like = `%${search}%`;
    const activoCond = activo === 'todos' ? '' : `AND c.activo = ${activo ? 1 : 0}`;
    const masterCond = soloMasters ? 'AND c.es_master = 1' : '';

    const rows = db().query(`
      SELECT c.*,
        COALESCE((SELECT SUM(cc.monto) FROM cuenta_corriente cc WHERE cc.cliente_id = c.id), 0) AS saldo_actual,
        (SELECT COUNT(*) FROM clientes m WHERE m.cliente_master_id = c.id AND m.activo = 1) AS miembros_count,
        (SELECT u.nombre FROM clientes u WHERE u.id = c.cliente_master_id) AS master_nombre
      FROM clientes c
      WHERE (c.nombre LIKE ? OR c.apellido LIKE ? OR c.telefono LIKE ? OR c.lote LIKE ?)
        ${activoCond}
        ${masterCond}
      ORDER BY c.nombre, c.apellido
    `, [like, like, like, like]);

    if (soloConDeuda) return rows.filter(r => r.saldo_actual > 0);

    // Batch-fetch deuda_lote for all masters in one query instead of N per-row calls
    const masterIds = rows.filter(r => r.es_master).map(r => r.id);
    if (!masterIds.length) return rows;
    const ph = masterIds.map(() => '?').join(',');
    const saldoLoteRows = db().query(`
      SELECT
        CASE WHEN c.cliente_master_id IS NOT NULL THEN c.cliente_master_id ELSE c.id END AS master_id,
        COALESCE(SUM(cc.monto), 0) AS saldo
      FROM cuenta_corriente cc
      JOIN clientes c ON c.id = cc.cliente_id
      WHERE c.cliente_master_id IN (${ph}) OR (c.id IN (${ph}) AND c.es_master = 1)
      GROUP BY master_id
    `, [...masterIds, ...masterIds]);
    const saldoLoteMap = {};
    saldoLoteRows.forEach(r => { saldoLoteMap[r.master_id] = r.saldo; });

    return rows.map(r => {
      if (r.es_master) r.deuda_lote = saldoLoteMap[r.id] || 0;
      return r;
    });
  }

  function getById(id) {
    const rows = db().query(`
      SELECT c.*,
        cat.nombre AS categoria_nombre
      FROM clientes c
      LEFT JOIN clientes cat ON cat.id = c.cliente_master_id
      WHERE c.id = ?
    `, [id]);
    if (!rows.length) return null;
    const c = rows[0];
    c.saldo_actual = getSaldoActual(id);
    c.tope_disponible = getTopeDisponible(id);

    // Family
    if (c.es_master) {
      c.miembros = db().query(`
        SELECT cl.*,
          COALESCE((SELECT SUM(cc.monto) FROM cuenta_corriente cc WHERE cc.cliente_id = cl.id), 0) AS saldo_actual
        FROM clientes cl WHERE cl.cliente_master_id = ? AND cl.activo = 1
        ORDER BY cl.nombre
      `, [id]);
      c.deuda_lote = getSaldoLote(id);
    } else if (c.cliente_master_id) {
      c.master = db().query(
        `SELECT id, nombre, apellido, lote FROM clientes WHERE id = ?`,
        [c.cliente_master_id]
      )[0] || null;
    }

    // Stats
    const mesStart = new Date(); mesStart.setDate(1); mesStart.setHours(0,0,0,0);
    const anioStart = new Date(); anioStart.setMonth(0,1); anioStart.setHours(0,0,0,0);
    const mesStr = mesStart.toISOString().slice(0,10);
    const anioStr = anioStart.toISOString().slice(0,10);

    const statMes = db().query(
      `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n
       FROM ventas WHERE cliente_id = ? AND estado = 'completada' AND fecha >= ?`,
      [id, mesStr]
    )[0] || { total: 0, n: 0 };
    const statAnio = db().query(
      `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n
       FROM ventas WHERE cliente_id = ? AND estado = 'completada' AND fecha >= ?`,
      [id, anioStr]
    )[0] || { total: 0, n: 0 };

    c.stats = {
      total_comprado_mes: statMes.total,
      ventas_mes: statMes.n,
      total_comprado_anio: statAnio.total,
      ventas_anio: statAnio.n,
      ticket_promedio: statAnio.n > 0 ? statAnio.total / statAnio.n : 0,
    };

    c.productos_mas_comprados = db().query(`
      SELECT p.nombre, SUM(vi.cantidad) AS veces,
        MAX(v.fecha) AS ultima_vez
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
      JOIN productos p ON p.id = vi.producto_id
      WHERE v.cliente_id = ? AND v.estado = 'completada'
      GROUP BY vi.producto_id
      ORDER BY veces DESC LIMIT 5
    `, [id]);

    return c;
  }

  function search(query) {
    if (!query || query.length < 1) return [];
    const like = `%${query}%`;
    const rows = db().query(`
      SELECT c.id, c.nombre, c.apellido, c.lote, c.direccion, c.telefono,
        c.es_master, c.cliente_master_id, c.tope_deuda,
        COALESCE((SELECT SUM(cc.monto) FROM cuenta_corriente cc WHERE cc.cliente_id = c.id), 0) AS saldo_actual
      FROM clientes c
      WHERE c.activo = 1
        AND (c.nombre LIKE ? OR c.apellido LIKE ? OR c.telefono LIKE ? OR c.lote LIKE ?)
      ORDER BY c.nombre LIMIT 10
    `, [like, like, like, like]);
    if (!rows.length) return rows;

    // Batch query 1: saldo_lote for all master IDs referenced (masters + member's masters)
    const allMasterIds = [...new Set(
      rows.flatMap(r => r.cliente_master_id ? [r.cliente_master_id] : (r.es_master ? [r.id] : []))
    )];
    let saldoLoteMap = {};
    if (allMasterIds.length) {
      const ph = allMasterIds.map(() => '?').join(',');
      db().query(`
        SELECT
          CASE WHEN c.cliente_master_id IS NOT NULL THEN c.cliente_master_id ELSE c.id END AS master_id,
          COALESCE(SUM(cc.monto), 0) AS saldo
        FROM cuenta_corriente cc
        JOIN clientes c ON c.id = cc.cliente_id
        WHERE c.cliente_master_id IN (${ph}) OR (c.id IN (${ph}) AND c.es_master = 1)
        GROUP BY master_id
      `, [...allMasterIds, ...allMasterIds]).forEach(r => { saldoLoteMap[r.master_id] = r.saldo; });
    }

    // Batch query 2: tope_deuda for masters that appear as members' masters
    const memberMasterIds = [...new Set(rows.filter(r => r.cliente_master_id).map(r => r.cliente_master_id))];
    let masterTopeMap = {};
    if (memberMasterIds.length) {
      const ph = memberMasterIds.map(() => '?').join(',');
      db().query(`SELECT id, tope_deuda FROM clientes WHERE id IN (${ph})`, memberMasterIds)
        .forEach(r => { masterTopeMap[r.id] = r.tope_deuda || 0; });
    }

    return rows.map(r => {
      let tope_disponible;
      if (r.cliente_master_id) {
        const tope = masterTopeMap[r.cliente_master_id] || 0;
        tope_disponible = tope - Math.max(0, saldoLoteMap[r.cliente_master_id] || 0);
      } else if (r.es_master) {
        tope_disponible = (r.tope_deuda || 0) - Math.max(0, saldoLoteMap[r.id] || 0);
      } else {
        tope_disponible = (r.tope_deuda || 0) - Math.max(0, r.saldo_actual || 0);
      }
      return {
        ...r,
        tope_disponible,
        deuda_lote: r.es_master ? (saldoLoteMap[r.id] || 0) : null,
      };
    });
  }

  function crear(data) {
    if (!data.nombre || !data.nombre.trim()) throw new Error('El nombre es obligatorio');
    const topeRow = db().query(
      `SELECT value FROM system_config WHERE key = 'tope_deuda_default'`
    );
    const topeDefault = topeRow.length ? parseFloat(topeRow[0].value) : 50000;
    const id = uid();
    const n = now();
    db().run(`
      INSERT INTO clientes
        (id, nombre, apellido, telefono, email, lote, direccion,
         tope_deuda, cliente_master_id, es_master, activo,
         fecha_alta, sync_status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)
    `, [
      id, data.nombre.trim(), data.apellido || null, data.telefono || null,
      data.email || null, data.lote || null, data.direccion || null,
      data.tope_deuda != null ? data.tope_deuda : topeDefault,
      data.cliente_master_id || null, data.es_master ? 1 : 0,
      n, 'pending', n
    ]);
    return id;
  }

  function actualizar(id, data, userRol) {
    const fields = [];
    const vals = [];
    const allowed = ['nombre','apellido','telefono','email','lote','direccion',
                     'es_master','cliente_master_id','activo'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(`${k} = ?`); vals.push(data[k]); }
    }
    if (data.tope_deuda !== undefined) {
      if (!['admin','encargado'].includes(userRol)) throw new Error('Sin permiso para cambiar el tope');
      fields.push('tope_deuda = ?'); vals.push(data.tope_deuda);
    }
    if (!fields.length) return { success: false, reason: 'no_fields' };
    fields.push('updated_at = ?', "sync_status = 'pending'");
    vals.push(now());
    vals.push(id);
    db().run(`UPDATE clientes SET ${fields.join(', ')} WHERE id = ?`, vals);
    return { success: true };
  }

  function registrarPago(clienteId, monto, descripcion, usuarioId) {
    if (!monto || monto <= 0) throw new Error('Monto inválido');
    const n = now();
    db().run(`
      INSERT INTO cuenta_corriente
        (id, cliente_id, tipo, monto, descripcion, fecha, usuario_id, sync_status, updated_at)
      VALUES (?,?,'pago',?,?,?,?,'pending',?)
    `, [uid(), clienteId, -Math.abs(monto), descripcion || 'Pago', n, usuarioId || null, n]);
    db().run(
      `UPDATE clientes SET ultima_visita = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      [n, n, clienteId]
    );
  }

  function getMovimientos(clienteId, { limit = 50, tipo = '', desde = '', hasta = '' } = {}) {
    const conds = [`cc.cliente_id = ?`];
    const params = [clienteId];
    if (tipo) { conds.push(`cc.tipo = ?`); params.push(tipo); }
    if (desde) { conds.push(`cc.fecha >= ?`); params.push(desde); }
    if (hasta) { conds.push(`cc.fecha <= ?`); params.push(hasta + 'T23:59:59'); }
    return db().query(`
      SELECT cc.*, v.total AS venta_total
      FROM cuenta_corriente cc
      LEFT JOIN ventas v ON v.id = cc.venta_id
      WHERE ${conds.join(' AND ')}
      ORDER BY cc.fecha ASC
      LIMIT ?
    `, [...params, limit]);
  }

  function getVentas(clienteId, { desde = '', hasta = '', limit = 20 } = {}) {
    const conds = [`v.cliente_id = ?`, `v.estado = 'completada'`];
    const params = [clienteId];
    if (desde) { conds.push(`v.fecha >= ?`); params.push(desde); }
    if (hasta) { conds.push(`v.fecha <= ?`); params.push(hasta + 'T23:59:59'); }
    const rows = db().query(`
      SELECT v.*, GROUP_CONCAT(p.nombre, ', ') AS items_preview
      FROM ventas v
      LEFT JOIN venta_items vi ON vi.venta_id = v.id
      LEFT JOIN productos p ON p.id = vi.producto_id
      WHERE ${conds.join(' AND ')}
      GROUP BY v.id
      ORDER BY v.fecha DESC LIMIT ?
    `, [...params, limit]);
    return rows;
  }

  return {
    getAll, getById, search, crear, actualizar,
    getTopeDisponible, getSaldoActual, getSaldoLote,
    registrarPago, getMovimientos, getVentas,
  };
})();

window.SGA_Clientes = SGA_Clientes;

// ── UI ───────────────────────────────────────────────────────────────────────

const ClientesUI = (() => {
  'use strict';

  const ge = (id) => document.getElementById(id);

  // Format helpers (fall through to SGA_Utils if available)
  const fmt = (n) => {
    const v = typeof n === 'number' ? n : parseFloat(n) || 0;
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS',
      minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
    return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
  };
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
  };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const user = () => window.SGA_Auth ? window.SGA_Auth.getCurrentUser() : null;

  // ── FILTERS STATE ──────────────────────────────────────────────────────────
  const filters = { search: '', soloConDeuda: false, soloMasters: false, activo: 1 };
  let currentClienteId = null;

  // ── SALDO BADGE ────────────────────────────────────────────────────────────
  function saldoBadge(saldo, large = false) {
    const cls = large ? 'cc-balance-amount' : 'saldo-b';
    if (saldo > 0.01)  return `<span class="${cls} deuda">Debe ${fmt(saldo)}</span>`;
    if (saldo < -0.01) return `<span class="${cls} favor">A favor ${fmt(Math.abs(saldo))}</span>`;
    return `<span class="${cls} neutro">Sin saldo</span>`;
  }

  // ── LIST RENDERING ─────────────────────────────────────────────────────────
  function renderList() {
    const rows = SGA_Clientes.getAll(filters);
    const tbody = ge('cl-tbody');
    const empty = ge('cl-empty');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = rows.map(c => {
      const saldo = c.saldo_actual || 0;
      const tope = c.tope_deuda || 0;
      const deuda = Math.max(0, saldo);
      const pct = tope > 0 ? Math.min(100, (deuda / tope) * 100) : 0;
      const fillCls = pct >= 80 ? (pct >= 95 ? 'danger' : 'warn') : '';

      let familiaHtml = '<span class="familia-b">—</span>';
      if (c.es_master) {
        familiaHtml = `<span class="familia-b master">👑 ${c.miembros_count || 0} miembros</span>`;
      } else if (c.master_nombre) {
        familiaHtml = `<span class="familia-b miembro">→ ${esc(c.master_nombre)}</span>`;
      }

      const ultimaVisita = c.ultima_visita ? fmtDate(c.ultima_visita) : '—';

      return `<tr data-id="${c.id}">
        <td><strong>${esc(c.nombre)} ${esc(c.apellido || '')}</strong></td>
        <td>${esc(c.lote || '—')}</td>
        <td>${esc(c.telefono || '—')}</td>
        <td>${saldoBadge(saldo)}</td>
        <td>
          <div class="tope-wrap">
            <span class="tope-label">${fmt(deuda)} / ${fmt(tope)}</span>
            <div class="tope-bar"><div class="tope-fill ${fillCls}" style="width:${pct}%"></div></div>
          </div>
        </td>
        <td>${familiaHtml}</td>
        <td class="text-muted">${ultimaVisita}</td>
        <td>
          <div class="cl-actions">
            <button data-action="editar" data-id="${c.id}" title="Editar">✏️</button>
            <button data-action="pago" data-id="${c.id}" title="Registrar pago">💰</button>
            <button data-action="ficha" data-id="${c.id}" title="Ver ficha">👁️</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // ── FICHA COMPLETA ─────────────────────────────────────────────────────────
  function openFicha(clienteId) {
    currentClienteId = clienteId;


    ge('clientes-list-view').style.display = 'none';
    const fichaView = ge('clientes-ficha-view');
    fichaView.classList.add('active');

    // Take over the app aside (same pattern as editor-producto)
    const aside = document.querySelector('aside.sidebar');
    if (aside) aside.classList.add('editor-mode');

    loadFichaData();
    activateFichaSection('datos');
  }

  function closeFicha() {
    ge('clientes-ficha-view').classList.remove('active');
    ge('clientes-list-view').style.display = '';

    const aside = document.querySelector('aside.sidebar');
    if (aside) aside.classList.remove('editor-mode');

    renderList();
  }

  function loadFichaData() {
    const c = SGA_Clientes.getById(currentClienteId);
    if (!c) return;

    // Update sidebar header
    ge('ficha-aside-name').textContent = `${c.nombre} ${c.apellido || ''}`.trim();
    ge('ficha-aside-lote').textContent = c.lote ? `Lote ${c.lote}` : '';
    ge('ficha-aside-saldo').innerHTML = saldoBadge(c.saldo_actual, false);

    // Datos personales
    ge('fi-nombre').value = c.nombre || '';
    ge('fi-apellido').value = c.apellido || '';
    ge('fi-lote').value = c.lote || '';
    ge('fi-direccion').value = c.direccion || '';
    ge('fi-telefono').value = c.telefono || '';
    ge('fi-email').value = c.email || '';
    ge('fi-activo').value = c.activo ? '1' : '0';
    ge('fi-fecha-alta').value = fmtDate(c.fecha_alta);
    ge('fi-tope-deuda').value = c.tope_deuda != null ? c.tope_deuda : 50000;

    // Tope progress
    renderTopeProgress(c);

    // Disable tope field for cajeros
    const u = user();
    if (u && u.rol === 'cajero') ge('fi-tope-deuda').disabled = true;

    // CC section
    renderCCSection(c);

    // Compras section
    renderComprasSection(c);

    // Familia section
    renderFamiliaSection(c);

    // Stats section
    renderStatsSection(c);
  }

  function renderTopeProgress(c) {
    const tope = c.tope_deuda || 0;
    const saldo = Math.max(0, c.saldo_actual || 0);
    const topeDisp = c.tope_disponible != null ? c.tope_disponible : (tope - saldo);
    const pct = tope > 0 ? Math.min(100, (saldo / tope) * 100) : 0;
    const fillCls = pct >= 80 ? (pct >= 95 ? 'danger' : 'warn') : '';
    ge('fi-tope-disponible').innerHTML = `
      <div class="tope-bar-large">
        <div class="tope-fill-large ${fillCls}" style="width:${pct}%"></div>
      </div>
      <div class="tope-disp-text">Disponible: ${fmt(Math.max(0, topeDisp))} de ${fmt(tope)}</div>
    `;
  }

  function renderCCSection(c) {
    const saldo = c.saldo_actual || 0;
    const amtEl = ge('cc-balance-amount');
    const lblEl = ge('cc-balance-label');
    if (amtEl) {
      amtEl.textContent = fmt(Math.abs(saldo));
      amtEl.className = 'cc-balance-amount ' +
        (saldo > 0.01 ? 'deuda' : saldo < -0.01 ? 'favor' : 'neutro');
    }
    if (lblEl) {
      lblEl.textContent = saldo > 0.01 ? 'Debe al almacén'
        : saldo < -0.01 ? 'El almacén le debe'
        : 'Sin saldo pendiente';
    }
    renderMovimientos();
  }

  function renderMovimientos(filters = {}) {
    const movs = SGA_Clientes.getMovimientos(currentClienteId, { limit: 100, ...filters });
    const tbody = ge('cc-mov-tbody');
    const empty = ge('cc-mov-empty');
    if (!tbody) return;

    if (!movs.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      ge('cc-mov-table').style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    ge('cc-mov-table').style.display = '';

    let saldoAcum = 0;
    tbody.innerHTML = movs.map(m => {
      saldoAcum += m.monto;
      const debe = m.monto > 0 ? fmt(m.monto) : '';
      const haber = m.monto < 0 ? fmt(Math.abs(m.monto)) : '';
      const ventaLink = m.venta_id
        ? `<span class="mov-link" data-venta="${m.venta_id}">#${m.venta_id.slice(-6)}</span>`
        : '';
      const desc = esc(m.descripcion || '') + (ventaLink ? ` ${ventaLink}` : '');
      return `<tr>
        <td>${fmtDate(m.fecha)}</td>
        <td><span class="tipo-b ${m.tipo}">${m.tipo.replace('_',' ')}</span></td>
        <td>${desc}</td>
        <td style="text-align:right; color:#c62828">${debe}</td>
        <td style="text-align:right; color:#2e7d32">${haber}</td>
        <td style="text-align:right; font-weight:600; color:${saldoAcum > 0 ? '#c62828' : saldoAcum < 0 ? '#2e7d32' : '#888'}">${fmt(Math.abs(saldoAcum))}</td>
      </tr>`;
    }).join('');
  }

  function renderComprasSection(c) {
    const ventas = SGA_Clientes.getVentas(currentClienteId);
    const list = ge('compras-list');
    const empty = ge('compras-empty');
    if (!list) return;

    const resMes = ge('resumen-mes');
    const resAnio = ge('resumen-anio');
    if (resMes && c.stats) resMes.textContent = `Este mes: ${fmt(c.stats.total_comprado_mes)} (${c.stats.ventas_mes} ventas)`;
    if (resAnio && c.stats) resAnio.textContent = `Este año: ${fmt(c.stats.total_comprado_anio)} (${c.stats.ventas_anio} ventas)`;

    if (!ventas.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = ventas.map(v => {
      const pagos = window.SGA_DB.query(
        `SELECT GROUP_CONCAT(medio, ' + ') AS medios FROM venta_pagos WHERE venta_id = ?`,
        [v.id]
      );
      const medios = pagos.length && pagos[0].medios ? pagos[0].medios : '—';
      return `<div class="venta-row" data-venta="${v.id}">
        <div class="venta-row-top">
          <span class="venta-fecha">${fmtDate(v.fecha)} ${fmtTime(v.fecha)}</span>
          <span class="venta-total">${fmt(v.total)}</span>
          <span class="venta-medio">${esc(medios)}</span>
        </div>
        <div class="venta-items-preview">${esc(v.items_preview || '—')}</div>
      </div>`;
    }).join('');
  }

  function renderFamiliaSection(c) {
    const container = ge('familia-content');
    if (!container) return;

    if (c.es_master) {
      const deudaLote = c.deuda_lote || 0;
      const tope = c.tope_deuda || 0;
      const pct = tope > 0 ? Math.min(100, (Math.max(0, deudaLote) / tope) * 100) : 0;
      const fillCls = pct >= 80 ? (pct >= 95 ? 'danger' : 'warn') : '';
      const miembros = c.miembros || [];

      container.innerHTML = `
        <div class="familia-header">
          👑 <strong>Cliente master del lote ${esc(c.lote || '—')}</strong>
        </div>
        <div class="familia-totals" style="margin-bottom:16px">
          <div style="font-size:0.85em; font-weight:600; color:#555; margin-bottom:6px">
            Deuda total del lote: ${fmt(Math.max(0, deudaLote))} / Tope: ${fmt(tope)}
          </div>
          <div class="tope-bar-large">
            <div class="tope-fill-large ${fillCls}" style="width:${pct}%"></div>
          </div>
        </div>
        ${miembros.length ? `
          <table class="miembro-table">
            <thead><tr>
              <th>Nombre</th><th>Apellido</th><th>Teléfono</th>
              <th>Saldo</th><th>Última visita</th><th></th>
            </tr></thead>
            <tbody>
              ${miembros.map(m => `
                <tr>
                  <td>${esc(m.nombre)}</td>
                  <td>${esc(m.apellido || '—')}</td>
                  <td>${esc(m.telefono || '—')}</td>
                  <td>${saldoBadge(m.saldo_actual || 0)}</td>
                  <td class="text-muted">${fmtDate(m.ultima_visita)}</td>
                  <td>
                    <button class="btn btn-sm btn-outline familia-ficha" data-id="${m.id}">Ver</button>
                    <button class="btn btn-sm btn-danger btn-outline familia-desvincular" data-id="${m.id}">Desvincular</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>` : '<p class="text-muted">Sin miembros de familia registrados.</p>'}
        <div class="mt-12">
          <button class="btn btn-secondary btn-sm" id="btn-agregar-miembro">+ Agregar miembro</button>
        </div>
        <div class="familia-search-wrap mt-8" id="miembro-search-wrap" style="display:none">
          <input type="text" id="miembro-search-input" class="cl-search"
            placeholder="Buscar cliente existente...">
          <div class="familia-dropdown" id="miembro-dropdown"></div>
          <div class="text-muted mt-8">O crear nuevo cliente con este lote:
            <button class="btn btn-primary btn-sm mt-8" id="btn-crear-miembro">+ Crear nuevo</button>
          </div>
        </div>
      `;

      // Wire up
      container.querySelector('#btn-agregar-miembro')?.addEventListener('click', () => {
        const wrap = ge('miembro-search-wrap');
        if (wrap) { wrap.style.display = wrap.style.display === 'none' ? '' : 'none'; }
      });

      const msInput = ge('miembro-search-input');
      const msDrop = ge('miembro-dropdown');
      if (msInput) {
        msInput.addEventListener('input', window.SGA_Utils.debounce(() => {
          const q = msInput.value.trim();
          if (q.length < 2) { msDrop.classList.remove('open'); return; }
          const res = SGA_Clientes.search(q).filter(r => !r.cliente_master_id && r.id !== c.id);
          if (!res.length) { msDrop.classList.remove('open'); return; }
          msDrop.innerHTML = res.map(r =>
            `<div class="fdrop-item" data-id="${r.id}">${esc(r.nombre)} ${esc(r.apellido || '')}${r.lote ? ` · ${esc(r.lote)}` : ''}</div>`
          ).join('');
          msDrop.classList.add('open');
          msDrop.querySelectorAll('.fdrop-item').forEach(el => {
            el.addEventListener('click', () => {
              vincularMiembro(el.dataset.id, c.id, c.lote);
              msDrop.classList.remove('open');
              msInput.value = '';
            });
          });
        }, 250));
      }

      ge('btn-crear-miembro')?.addEventListener('click', () => {
        openModalCliente({ lote: c.lote, cliente_master_id: c.id });
      });

      container.querySelectorAll('.familia-desvincular').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('¿Desvincular este miembro de la familia?')) return;
          window.SGA_DB.run(
            `UPDATE clientes SET cliente_master_id = NULL, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
            [window.SGA_Utils.formatISODate(new Date()), btn.dataset.id]
          );
          loadFichaData();
        });
      });

      container.querySelectorAll('.familia-ficha').forEach(btn => {
        btn.addEventListener('click', () => openFicha(btn.dataset.id));
      });

    } else if (c.master) {
      container.innerHTML = `
        <div class="familia-header" style="border-left-color:#0288d1; background:#e3f2fd">
          Miembro de la familia de
          <strong>${esc(c.master.nombre)} ${esc(c.master.apellido || '')}</strong>
          ${c.master.lote ? `— Lote ${esc(c.master.lote)}` : ''}
        </div>
        <p><button class="btn btn-secondary btn-sm" id="btn-ver-master">Ver ficha del master</button>
        &nbsp;<button class="btn btn-danger btn-sm btn-outline" id="btn-desvincular-self">Desvincular de familia</button></p>
      `;
      ge('btn-ver-master')?.addEventListener('click', () => openFicha(c.master.id));
      ge('btn-desvincular-self')?.addEventListener('click', () => {
        if (!confirm('¿Desvincular este cliente de su familia?')) return;
        window.SGA_DB.run(
          `UPDATE clientes SET cliente_master_id = NULL, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
          [window.SGA_Utils.formatISODate(new Date()), c.id]
        );
        loadFichaData();
      });

    } else {
      container.innerHTML = `
        <p class="text-muted">Cliente independiente.</p>
        <div class="mt-8">
          <button class="btn btn-secondary btn-sm" id="btn-crear-familia">
            + Crear familia / Asignar a lote
          </button>
        </div>
        <div id="familia-asignar-wrap" style="display:none; margin-top:12px">
          <p class="text-muted">Buscar master existente, o convertir este cliente en master:</p>
          <div class="familia-search-wrap">
            <input type="text" id="familia-master-search" class="cl-search"
              placeholder="Buscar master existente...">
            <div class="familia-dropdown" id="familia-master-dropdown"></div>
          </div>
          <div class="mt-8">
            <button class="btn btn-primary btn-sm" id="btn-hacerse-master">
              👑 Convertir en master de un nuevo lote
            </button>
          </div>
        </div>
      `;
      ge('btn-crear-familia')?.addEventListener('click', () => {
        const wrap = ge('familia-asignar-wrap');
        if (wrap) wrap.style.display = wrap.style.display === 'none' ? '' : 'none';
      });

      const fmSearch = ge('familia-master-search');
      const fmDrop = ge('familia-master-dropdown');
      if (fmSearch) {
        fmSearch.addEventListener('input', window.SGA_Utils.debounce(() => {
          const q = fmSearch.value.trim();
          if (q.length < 2) { fmDrop.classList.remove('open'); return; }
          const res = SGA_Clientes.search(q).filter(r => r.es_master && r.id !== c.id);
          if (!res.length) { fmDrop.classList.remove('open'); return; }
          fmDrop.innerHTML = res.map(r =>
            `<div class="fdrop-item" data-id="${r.id}">${esc(r.nombre)} ${esc(r.apellido || '')}${r.lote ? ` · Lote ${esc(r.lote)}` : ''}</div>`
          ).join('');
          fmDrop.classList.add('open');
          fmDrop.querySelectorAll('.fdrop-item').forEach(el => {
            el.addEventListener('click', () => {
              vincularMiembro(c.id, el.dataset.id, null);
              fmDrop.classList.remove('open');
              fmSearch.value = '';
              loadFichaData();
            });
          });
        }, 250));
      }

      ge('btn-hacerse-master')?.addEventListener('click', () => {
        const loteVal = prompt('Ingresá el lote para este nuevo grupo familiar:');
        if (!loteVal) return;
        const n = window.SGA_Utils.formatISODate(new Date());
        window.SGA_DB.run(
          `UPDATE clientes SET es_master = 1, lote = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
          [loteVal.trim(), n, c.id]
        );
        loadFichaData();
      });
    }
  }

  function vincularMiembro(miembroId, masterId, lote) {
    const n = window.SGA_Utils.formatISODate(new Date());
    const fields = lote
      ? `cliente_master_id = ?, lote = ?, updated_at = ?, sync_status = 'pending'`
      : `cliente_master_id = ?, updated_at = ?, sync_status = 'pending'`;
    const params = lote ? [masterId, lote, n, miembroId] : [masterId, n, miembroId];
    window.SGA_DB.run(`UPDATE clientes SET ${fields} WHERE id = ?`, params);
    loadFichaData();
  }

  function renderStatsSection(c) {
    const s = c.stats || {};
    const diasDesdeVisita = c.ultima_visita
      ? Math.floor((Date.now() - new Date(c.ultima_visita)) / 86400000)
      : null;

    const sgrid = ge('stats-grid');
    if (sgrid) {
      sgrid.innerHTML = [
        { label: 'Última visita', value: fmtDate(c.ultima_visita) },
        { label: 'Días sin comprar', value: diasDesdeVisita != null ? `${diasDesdeVisita} días` : '—' },
        { label: 'Compras este mes', value: `${fmt(s.total_comprado_mes)} (${s.ventas_mes || 0} ventas)` },
        { label: 'Compras este año', value: fmt(s.total_comprado_anio) },
        { label: 'Ticket promedio', value: fmt(s.ticket_promedio) },
      ].map(item => `
        <div class="stat-card">
          <div class="stat-card-label">${item.label}</div>
          <div class="stat-card-value">${item.value}</div>
        </div>
      `).join('');
    }

    // Top products
    const topTbody = ge('stats-top-tbody');
    if (topTbody) {
      const top = c.productos_mas_comprados || [];
      if (!top.length) {
        topTbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="padding:10px">Sin datos</td></tr>';
      } else {
        topTbody.innerHTML = top.map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${esc(p.nombre)}</td>
            <td style="text-align:right">${p.veces}</td>
            <td>${fmtDate(p.ultima_vez)}</td>
          </tr>
        `).join('');
      }
    }

    // Bar chart — last 6 months
    renderBarChart(c.id);
  }

  function renderBarChart(clienteId) {
    const svg = ge('bar-chart-svg');
    if (!svg) return;

    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1); d.setHours(0,0,0,0);
      d.setMonth(d.getMonth() - i);
      const desde = d.toISOString().slice(0,7) + '-01';
      const hasta = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0,10);
      const r = window.SGA_DB.query(
        `SELECT COALESCE(SUM(total),0) AS total FROM ventas
         WHERE cliente_id = ? AND estado = 'completada' AND fecha >= ? AND fecha <= ?`,
        [clienteId, desde, hasta + 'T23:59:59']
      );
      months.push({
        label: d.toLocaleDateString('es-AR', { month:'short', year:'2-digit' }),
        total: r.length ? (r[0].total || 0) : 0,
      });
    }

    const max = Math.max(...months.map(m => m.total), 1);
    const W = 480, H = 100, pad = 30, barW = Math.floor((W - pad * 2) / 6) - 8;

    svg.setAttribute('viewBox', `0 0 ${W} ${H + 20}`);
    svg.innerHTML = months.map((m, i) => {
      const x = pad + i * ((W - pad * 2) / 6) + 4;
      const barH = Math.max(2, Math.floor((m.total / max) * H));
      const y = H - barH;
      const fill = m.total > 0 ? '#667eea' : '#e0e0e0';
      return `
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${fill}" rx="2"/>
        <text x="${x + barW / 2}" y="${H + 14}" text-anchor="middle"
          font-size="9" fill="#888">${m.label}</text>
        ${m.total > 0 ? `<text x="${x + barW / 2}" y="${y - 3}" text-anchor="middle"
          font-size="8" fill="#667eea">${fmt(m.total).replace('$','$').slice(0,8)}</text>` : ''}
      `;
    }).join('');
  }

  // ── SECTION SWITCHING ──────────────────────────────────────────────────────
  function activateFichaSection(sectionId) {
    document.querySelectorAll('.ficha-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.ficha-nav-item').forEach(n => n.classList.remove('active'));
    const sec = ge(`ficha-${sectionId}`);
    if (sec) sec.classList.add('active');
    const navItem = document.querySelector(`.ficha-nav-item[data-section="${sectionId}"]`);
    if (navItem) navItem.classList.add('active');
  }

  // ── MODAL: NUEVO / EDITAR ──────────────────────────────────────────────────
  function openModalCliente(prefill = {}) {
    ge('mc-id').value = prefill.id || '';
    ge('mc-nombre').value = prefill.nombre || '';
    ge('mc-apellido').value = prefill.apellido || '';
    ge('mc-lote').value = prefill.lote || '';
    ge('mc-direccion').value = prefill.direccion || '';
    ge('mc-telefono').value = prefill.telefono || '';
    ge('mc-email').value = prefill.email || '';
    ge('mc-tope-deuda').value = prefill.tope_deuda != null ? prefill.tope_deuda : '';
    ge('modal-cliente-title').textContent = prefill.id ? '✏️ Editar Cliente' : '+ Nuevo Cliente';

    // Store master link if provided
    if (prefill.cliente_master_id) {
      ge('mc-id').dataset.masterId = prefill.cliente_master_id;
    } else {
      delete ge('mc-id').dataset.masterId;
    }

    ge('modal-cliente-form').classList.add('open');
    ge('mc-nombre').focus();
  }

  function closeModalCliente() {
    ge('modal-cliente-form').classList.remove('open');
  }

  function saveModalCliente() {
    const nombre = ge('mc-nombre').value.trim();
    if (!nombre) { alert('El nombre es obligatorio'); ge('mc-nombre').focus(); return; }

    const existingId = ge('mc-id').value;
    const masterId = ge('mc-id').dataset.masterId || null;
    const topeVal = ge('mc-tope-deuda').value;
    const tope = topeVal !== '' ? parseFloat(topeVal) : null;
    const u = user();

    const data = {
      nombre,
      apellido: ge('mc-apellido').value.trim() || null,
      lote: ge('mc-lote').value.trim() || null,
      direccion: ge('mc-direccion').value.trim() || null,
      telefono: ge('mc-telefono').value.trim() || null,
      email: ge('mc-email').value.trim() || null,
      tope_deuda: tope,
      cliente_master_id: masterId,
    };

    try {
      if (existingId) {
        SGA_Clientes.actualizar(existingId, data, u ? u.rol : 'cajero');
      } else {
        SGA_Clientes.crear(data);
      }
      closeModalCliente();
      renderList();
    } catch (e) {
      alert(e.message);
    }
  }

  // ── MODAL: TOPE CONFIG ─────────────────────────────────────────────────────
  function openTopeConfig() {
    const r = window.SGA_DB.query(`SELECT value FROM system_config WHERE key = 'tope_deuda_default'`);
    ge('tope-config-input').value = r.length ? r[0].value : '50000';
    ge('modal-tope-config').classList.add('open');
  }

  // ── PAGO RÁPIDO (from list) ────────────────────────────────────────────────
  function pagoRapido(clienteId) {
    const c = window.SGA_DB.query(`SELECT nombre, apellido FROM clientes WHERE id = ?`, [clienteId]);
    const nombre = c.length ? `${c[0].nombre} ${c[0].apellido || ''}`.trim() : 'Cliente';
    const montoStr = prompt(`Registrar pago para ${nombre}\nMonto $:`);
    if (!montoStr) return;
    const monto = parseFloat(montoStr);
    if (!monto || monto <= 0) { alert('Monto inválido'); return; }
    const desc = prompt('Descripción (opcional):') || 'Pago';
    const u = user();
    SGA_Clientes.registrarPago(clienteId, monto, desc, u ? u.id : null);
    renderList();
  }

  // ── INIT ───────────────────────────────────────────────────────────────────
  function init() {
    renderList();
    wireEvents();
  }

  function wireEvents() {
    // Search / filter
    const searchInput = ge('cl-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', window.SGA_Utils.debounce(() => {
        filters.search = searchInput.value.trim();
        renderList();
      }, 250));
    }

    ge('toggle-con-deuda')?.addEventListener('click', function() {
      filters.soloConDeuda = !filters.soloConDeuda;
      this.classList.toggle('active', filters.soloConDeuda);
      renderList();
    });

    ge('toggle-masters')?.addEventListener('click', function() {
      filters.soloMasters = !filters.soloMasters;
      this.classList.toggle('active', filters.soloMasters);
      renderList();
    });

    ge('toggle-activos')?.addEventListener('click', function() {
      if (filters.activo === 1) {
        filters.activo = 'todos';
        this.textContent = 'Activos y no activos';
      } else {
        filters.activo = 1;
        this.textContent = 'Solo activos';
      }
      this.classList.toggle('active', filters.activo === 1);
      renderList();
    });

    // Table row click → ficha / action buttons
    ge('cl-tbody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (btn) {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (btn.dataset.action === 'editar') {
          const c = SGA_Clientes.getById(id);
          if (c) openModalCliente(c);
        } else if (btn.dataset.action === 'pago') {
          pagoRapido(id);
        } else if (btn.dataset.action === 'ficha') {
          openFicha(id);
        }
        return;
      }
      const row = e.target.closest('tr[data-id]');
      if (row) openFicha(row.dataset.id);
    });

    // Nuevo cliente
    ge('btn-nuevo-cliente')?.addEventListener('click', () => openModalCliente());

    // Modal cliente
    ge('btn-mc-cancel')?.addEventListener('click', closeModalCliente);
    ge('btn-mc-save')?.addEventListener('click', saveModalCliente);
    ge('modal-cliente-form')?.addEventListener('click', (e) => {
      if (e.target === ge('modal-cliente-form')) closeModalCliente();
    });

    // Tope config
    ge('btn-tope-config')?.addEventListener('click', () => {
      const u = user();
      if (u && u.rol === 'cajero') { alert('Sin permiso para cambiar esta configuración'); return; }
      openTopeConfig();
    });
    ge('btn-tope-config-cancel')?.addEventListener('click', () => {
      ge('modal-tope-config').classList.remove('open');
    });
    ge('btn-tope-config-save')?.addEventListener('click', () => {
      const val = parseFloat(ge('tope-config-input').value);
      if (isNaN(val) || val < 0) { alert('Valor inválido'); return; }
      const n = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('tope_deuda_default', ?, ?)`,
        [String(val), n]
      );
      ge('modal-tope-config').classList.remove('open');
    });
    ge('modal-tope-config')?.addEventListener('click', (e) => {
      if (e.target === ge('modal-tope-config')) ge('modal-tope-config').classList.remove('open');
    });

    // Ficha back
    ge('ficha-back')?.addEventListener('click', closeFicha);

    // Ficha nav
    ge('ficha-nav')?.addEventListener('click', (e) => {
      const item = e.target.closest('.ficha-nav-item[data-section]');
      if (item) activateFichaSection(item.dataset.section);
    });

    // Ficha guardar datos
    ge('fi-guardar')?.addEventListener('click', () => {
      const nombre = ge('fi-nombre').value.trim();
      if (!nombre) { alert('El nombre es obligatorio'); return; }
      const u = user();
      const topeVal = ge('fi-tope-deuda').value;
      try {
        SGA_Clientes.actualizar(currentClienteId, {
          nombre,
          apellido: ge('fi-apellido').value.trim() || null,
          lote: ge('fi-lote').value.trim() || null,
          direccion: ge('fi-direccion').value.trim() || null,
          telefono: ge('fi-telefono').value.trim() || null,
          email: ge('fi-email').value.trim() || null,
          activo: parseInt(ge('fi-activo').value),
          tope_deuda: topeVal !== '' ? parseFloat(topeVal) : undefined,
        }, u ? u.rol : 'cajero');
        const msg = ge('fi-save-msg');
        if (msg) { msg.textContent = '✓ Guardado'; msg.style.display = 'inline'; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
        loadFichaData();
      } catch(e) { alert(e.message); }
    });

    // CC — Registrar pago
    ge('btn-registrar-pago')?.addEventListener('click', () => {
      ge('cc-pago-form').classList.toggle('open');
      ge('cc-monto-pago').focus();
    });
    ge('btn-cc-pago-cancel')?.addEventListener('click', () => {
      ge('cc-pago-form').classList.remove('open');
    });
    ge('btn-cc-pago-confirm')?.addEventListener('click', () => {
      const monto = parseFloat(ge('cc-monto-pago').value);
      if (!monto || monto <= 0) { alert('Ingresá un monto válido'); return; }
      const desc = ge('cc-desc-pago').value.trim() || 'Pago';
      const u = user();
      SGA_Clientes.registrarPago(currentClienteId, monto, desc, u ? u.id : null);
      ge('cc-pago-form').classList.remove('open');
      ge('cc-monto-pago').value = '';
      ge('cc-desc-pago').value = '';
      loadFichaData();
    });

    ge('btn-cc-filter')?.addEventListener('click', () => {
      renderMovimientos({
        tipo: ge('cc-filter-tipo').value,
        desde: ge('cc-filter-desde').value,
        hasta: ge('cc-filter-hasta').value,
      });
    });

    ge('btn-compras-filter')?.addEventListener('click', () => {
      const c = SGA_Clientes.getById(currentClienteId);
      if (!c) return;
      const ventas = SGA_Clientes.getVentas(currentClienteId, {
        desde: ge('compras-filter-desde').value,
        hasta: ge('compras-filter-hasta').value,
      });
      renderComprasSection({ ...c, ventas_override: ventas });
    });
  }

  return { init };
})();

// ── MODULE EXPORT ────────────────────────────────────────────────────────────

export default {
  init(params) {
    console.log('👥 Clientes module initialized', params);
    ClientesUI.init();
  }
};
