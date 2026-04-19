'use strict';

const Gastos = (() => {
  const ge = id => document.getElementById(id);
  const db = () => window.SGA_DB;
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);
  const uuid = () => window.SGA_Utils.generateUUID();
  const fmtF = s => window.SGA_Utils.formatFecha(s);

  const CATEGORIAS = [
    { value: 'servicios',     label: 'Servicios',             desc: 'Luz, agua, gas, internet, teléfono' },
    { value: 'sueldos',       label: 'Sueldos y Cargas',      desc: 'Salarios, cargas sociales' },
    { value: 'impuestos',     label: 'Impuestos y Tasas',     desc: 'IIBB, municipales, nacionales' },
    { value: 'alquiler',      label: 'Alquiler',              desc: 'Alquiler del local' },
    { value: 'mantenimiento', label: 'Mantenimiento',         desc: 'Reparaciones, limpieza' },
    { value: 'honorarios',    label: 'Honorarios',            desc: 'Contadores, abogados, etc.' },
    { value: 'publicidad',    label: 'Publicidad',            desc: 'Marketing, publicidad' },
    { value: 'otros',         label: 'Otros',                 desc: 'Gastos varios' },
  ];

  const METODOS_PAGO = [
    { value: 'efectivo',      label: 'Efectivo' },
    { value: 'transferencia', label: 'Transferencia' },
    { value: 'tarjeta',       label: 'Tarjeta' },
    { value: 'cheque',        label: 'Cheque' },
  ];

  const state = {
    tab: 'nuevo',
    sucursalId: null,
    userId: null,
    filtros: { desde: '', hasta: '', categoria: 'todos' },
    resumenFiltros: { desde: '', hasta: '' },
  };

  // ── DATA ──────────────────────────────────────────────────────────────────────

  function getGastos(desde, hasta, categoria) {
    let sql = `
      SELECT g.id, g.fecha, g.categoria, g.descripcion, g.monto, g.metodo_pago,
             g.comprobante, g.observaciones,
             p.razon_social AS proveedor_nombre,
             u.nombre AS usuario_nombre
      FROM gastos g
      LEFT JOIN proveedores p ON p.id = g.proveedor_id
      LEFT JOIN usuarios u ON u.id = g.usuario_id
      WHERE g.sucursal_id = ?
    `;
    const params = [state.sucursalId];
    if (desde) { sql += ` AND DATE(g.fecha) >= DATE(?)`; params.push(desde); }
    if (hasta) { sql += ` AND DATE(g.fecha) <= DATE(?)`; params.push(hasta); }
    if (categoria && categoria !== 'todos') { sql += ` AND g.categoria = ?`; params.push(categoria); }
    sql += ` ORDER BY g.fecha DESC, g.rowid DESC`;
    return db().query(sql, params);
  }

  function getResumen(desde, hasta) {
    let sql = `
      SELECT categoria, COUNT(*) AS cantidad, SUM(monto) AS total
      FROM gastos
      WHERE sucursal_id = ?
    `;
    const params = [state.sucursalId];
    if (desde) { sql += ` AND DATE(fecha) >= DATE(?)`; params.push(desde); }
    if (hasta) { sql += ` AND DATE(fecha) <= DATE(?)`; params.push(hasta); }
    sql += ` GROUP BY categoria ORDER BY total DESC`;
    return db().query(sql, params);
  }

  function getProveedores() {
    return db().query(`SELECT id, razon_social FROM proveedores WHERE activo = 1 ORDER BY razon_social`, []);
  }

  function insertGasto({ fecha, categoria, descripcion, monto, metodo_pago, comprobante, proveedor_id, observaciones }) {
    const id = uuid();
    const now = window.SGA_Utils.formatISODate(new Date());
    db().run(
      `INSERT INTO gastos
         (id, sucursal_id, usuario_id, fecha, categoria, descripcion, monto,
          metodo_pago, comprobante, proveedor_id, observaciones, sync_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, state.sucursalId, state.userId, fecha, categoria, descripcion, monto,
       metodo_pago, comprobante || null, proveedor_id || null, observaciones || null, now]
    );
    return id;
  }

  function deleteGasto(id) {
    db().run(`DELETE FROM gastos WHERE id = ? AND sucursal_id = ?`, [id, state.sucursalId]);
  }

  // ── RENDER TABS ───────────────────────────────────────────────────────────────

  function catBadge(cat) {
    const c = CATEGORIAS.find(x => x.value === cat);
    return `<span class="cat-badge cat-${cat}">${c ? c.label : cat}</span>`;
  }

  function categoriaOptions(selected = '') {
    return CATEGORIAS.map(c =>
      `<option value="${c.value}" ${selected === c.value ? 'selected' : ''}>${c.label}</option>`
    ).join('');
  }

  function metodoPagoOptions(selected = 'efectivo') {
    return METODOS_PAGO.map(m =>
      `<option value="${m.value}" ${selected === m.value ? 'selected' : ''}>${m.label}</option>`
    ).join('');
  }

  function renderNuevo() {
    const proveedores = getProveedores();
    const today = new Date().toISOString().slice(0, 10);

    ge('gastos-content').innerHTML = `
      <div class="gastos-form-card">
        <h3>Registrar Gasto</h3>
        <div class="gastos-form-grid">
          <div class="gastos-field">
            <label>Fecha</label>
            <input type="date" id="gf-fecha" value="${today}">
          </div>
          <div class="gastos-field">
            <label>Monto</label>
            <input type="number" id="gf-monto" min="0" step="0.01" placeholder="0,00">
          </div>
          <div class="gastos-field full">
            <label>Categoría</label>
            <select id="gf-categoria">
              <option value="">Seleccionar...</option>
              ${categoriaOptions()}
            </select>
          </div>
          <div class="gastos-field full">
            <label>Descripción</label>
            <input type="text" id="gf-desc" placeholder="Ej: Factura de luz — Agosto 2026">
          </div>
          <div class="gastos-field">
            <label>Método de Pago</label>
            <select id="gf-metodo">${metodoPagoOptions()}</select>
          </div>
          <div class="gastos-field">
            <label>N° Comprobante <small style="font-weight:400">(opcional)</small></label>
            <input type="text" id="gf-comprobante" placeholder="Ej: 0001-00012345">
          </div>
          <div class="gastos-field full">
            <label>Proveedor / Empresa <small style="font-weight:400">(opcional)</small></label>
            <select id="gf-proveedor">
              <option value="">— Sin proveedor —</option>
              ${proveedores.map(p => `<option value="${p.id}">${p.razon_social}</option>`).join('')}
            </select>
          </div>
          <div class="gastos-field full">
            <label>Observaciones <small style="font-weight:400">(opcional)</small></label>
            <textarea id="gf-obs" placeholder="Notas adicionales..."></textarea>
          </div>
        </div>
        <div class="gastos-error" id="gf-error"></div>
        <div class="gastos-form-actions">
          <button class="btn btn-primary" id="btn-guardar-gasto">Registrar Gasto</button>
          <button class="btn btn-secondary" id="btn-limpiar-gasto">Limpiar</button>
        </div>
      </div>
    `;

    ge('btn-guardar-gasto').addEventListener('click', guardarGasto);
    ge('btn-limpiar-gasto').addEventListener('click', () => {
      ge('gf-monto').value = '';
      ge('gf-categoria').value = '';
      ge('gf-desc').value = '';
      ge('gf-comprobante').value = '';
      ge('gf-obs').value = '';
      ge('gf-proveedor').value = '';
      ge('gf-error').style.display = 'none';
      ge('gf-monto').focus();
    });

    ge('gf-monto').focus();
  }

  function renderListado() {
    const { desde, hasta, categoria } = state.filtros;
    const rows = getGastos(desde, hasta, categoria);
    const total = rows.reduce((s, r) => s + (parseFloat(r.monto) || 0), 0);

    const rowsHtml = rows.length === 0
      ? `<tr><td colspan="8" class="gastos-empty">No hay gastos para el período seleccionado</td></tr>`
      : rows.map(r => `
          <tr>
            <td>${fmtF(r.fecha)}</td>
            <td>${catBadge(r.categoria)}</td>
            <td>${esc(r.descripcion)}</td>
            <td>${r.proveedor_nombre ? esc(r.proveedor_nombre) : '—'}</td>
            <td>${r.comprobante ? esc(r.comprobante) : '—'}</td>
            <td>${METODOS_PAGO.find(m => m.value === r.metodo_pago)?.label || r.metodo_pago}</td>
            <td class="monto-cell">${fmt$(r.monto)}</td>
            <td class="actions-cell">
              <button class="btn-del-gasto" data-id="${r.id}" title="Eliminar">✕</button>
            </td>
          </tr>
        `).join('');

    ge('gastos-content').innerHTML = `
      <div class="gastos-filters">
        <input type="date" id="fl-desde" value="${desde}" placeholder="Desde">
        <input type="date" id="fl-hasta" value="${hasta}" placeholder="Hasta">
        <select id="fl-cat">
          <option value="todos">Todas las categorías</option>
          ${categoriaOptions(categoria)}
        </select>
        <button class="btn btn-secondary" id="btn-filtrar">Filtrar</button>
        <button class="btn btn-ghost" id="btn-limpiar-filtros" title="Limpiar filtros">✕</button>
      </div>
      <div class="gastos-table-wrap">
        <table class="gastos-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Categoría</th>
              <th>Descripción</th>
              <th>Proveedor</th>
              <th>Comprobante</th>
              <th>Pago</th>
              <th style="text-align:right">Monto</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${rows.length > 0 ? `
        <div class="gastos-total-bar">
          <span>Total período:</span>
          <strong>${fmt$(total)}</strong>
        </div>
      ` : ''}
    `;

    ge('btn-filtrar').addEventListener('click', () => {
      state.filtros.desde = ge('fl-desde').value;
      state.filtros.hasta = ge('fl-hasta').value;
      state.filtros.categoria = ge('fl-cat').value;
      renderListado();
    });

    ge('btn-limpiar-filtros').addEventListener('click', () => {
      state.filtros = { desde: '', hasta: '', categoria: 'todos' };
      renderListado();
    });

    ge('gastos-content').addEventListener('click', e => {
      const btn = e.target.closest('.btn-del-gasto');
      if (!btn) return;
      if (!confirm('¿Eliminar este gasto?')) return;
      deleteGasto(btn.dataset.id);
      renderListado();
    });
  }

  function renderResumen() {
    const { desde, hasta } = state.resumenFiltros;

    ge('gastos-content').innerHTML = `
      <div class="gastos-resumen-filters">
        <input type="date" id="rs-desde" value="${desde}" placeholder="Desde">
        <input type="date" id="rs-hasta" value="${hasta}" placeholder="Hasta">
        <button class="btn btn-secondary" id="btn-resumen-filtrar">Ver Resumen</button>
        <button class="btn btn-ghost" id="btn-resumen-limpiar">✕ Limpiar</button>
      </div>
      <div id="resumen-body"></div>
    `;

    ge('btn-resumen-filtrar').addEventListener('click', () => {
      state.resumenFiltros.desde = ge('rs-desde').value;
      state.resumenFiltros.hasta = ge('rs-hasta').value;
      renderResumenBody();
    });

    ge('btn-resumen-limpiar').addEventListener('click', () => {
      state.resumenFiltros = { desde: '', hasta: '' };
      ge('rs-desde').value = '';
      ge('rs-hasta').value = '';
      renderResumenBody();
    });

    renderResumenBody();
  }

  function renderResumenBody() {
    const { desde, hasta } = state.resumenFiltros;
    const rows = getResumen(desde, hasta);
    const grand = rows.reduce((s, r) => s + (parseFloat(r.total) || 0), 0);

    if (rows.length === 0) {
      ge('resumen-body').innerHTML = `<div class="gastos-empty">No hay gastos registrados para el período</div>`;
      return;
    }

    ge('resumen-body').innerHTML = `
      <div class="gastos-resumen-grid">
        ${rows.map(r => {
          const c = CATEGORIAS.find(x => x.value === r.categoria);
          return `
            <div class="gastos-resumen-card">
              <div class="cat-label">${c ? c.label : r.categoria}</div>
              <div class="cat-total">${fmt$(r.total)}</div>
              <div class="cat-count">${r.cantidad} gasto${r.cantidad !== 1 ? 's' : ''}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="gastos-resumen-grand">
        <span class="label">Total General</span>
        <span class="total">${fmt$(grand)}</span>
      </div>
    `;
  }

  // ── ACTIONS ───────────────────────────────────────────────────────────────────

  function guardarGasto() {
    const fecha       = ge('gf-fecha').value;
    const monto       = parseFloat(ge('gf-monto').value);
    const categoria   = ge('gf-categoria').value;
    const descripcion = ge('gf-desc').value.trim();
    const metodo_pago = ge('gf-metodo').value;
    const comprobante = ge('gf-comprobante').value.trim();
    const proveedor_id = ge('gf-proveedor').value;
    const observaciones = ge('gf-obs').value.trim();

    const err = ge('gf-error');
    const showErr = msg => { err.textContent = msg; err.style.display = ''; };

    if (!fecha)          return showErr('Ingresá la fecha');
    if (!monto || monto <= 0) return showErr('El monto debe ser mayor a 0');
    if (!categoria)      return showErr('Seleccioná una categoría');
    if (!descripcion)    return showErr('Ingresá una descripción');

    err.style.display = 'none';

    try {
      insertGasto({ fecha, categoria, descripcion, monto, metodo_pago, comprobante, proveedor_id, observaciones });
      window.SGA_Utils.showNotification('Gasto registrado correctamente', 'success');
      ge('gf-monto').value = '';
      ge('gf-categoria').value = '';
      ge('gf-desc').value = '';
      ge('gf-comprobante').value = '';
      ge('gf-obs').value = '';
      ge('gf-proveedor').value = '';
      ge('gf-monto').focus();
    } catch (e) {
      showErr('Error al guardar: ' + e.message);
    }
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── TAB SWITCH ────────────────────────────────────────────────────────────────

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.gastos-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    if (tab === 'nuevo')    renderNuevo();
    if (tab === 'listado')  renderListado();
    if (tab === 'resumen')  renderResumen();
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────

  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    state.sucursalId = user?.sucursal_id || '1';
    state.userId = user?.id;

    ge('gastos-root').innerHTML = `
      <div class="gastos-header">
        <h2>💸 Gastos Generales</h2>
      </div>
      <div class="gastos-tabs">
        <button class="gastos-tab active" data-tab="nuevo">Nuevo Gasto</button>
        <button class="gastos-tab" data-tab="listado">Listado</button>
        <button class="gastos-tab" data-tab="resumen">Resumen por Categoría</button>
      </div>
      <div id="gastos-content"></div>
    `;

    document.querySelectorAll('.gastos-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    renderNuevo();
  }

  return { init };
})();

export default Gastos;
