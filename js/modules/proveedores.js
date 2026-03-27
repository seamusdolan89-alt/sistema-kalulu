/**
 * proveedores.js — Suppliers Module
 *
 * Exposes window.SGA_Proveedores data layer (used by Compras and Ordenes).
 * Exports default { init } for SPA router.
 */

// ── DATA LAYER ──────────────────────────────────────────────────────────────

const SGA_Proveedores = (() => {
  'use strict';

  const db  = () => window.SGA_DB;
  const uid = () => window.SGA_Utils.generateUUID();
  const now = () => window.SGA_Utils.formatISODate(new Date());

  function getAll({ search = '', activo = 1 } = {}) {
    const like = `%${search}%`;
    const activoCond = activo === 'todos' ? '' : `AND p.activo = ${activo ? 1 : 0}`;
    return db().query(`
      SELECT p.*,
        (SELECT COUNT(*) FROM productos pr
          WHERE pr.proveedor_principal_id = p.id
             OR pr.proveedor_alternativo_id = p.id) AS productos_count
      FROM proveedores p
      WHERE (
        LOWER(p.razon_social)                    LIKE LOWER(?)
        OR LOWER(COALESCE(p.cuit,''))            LIKE LOWER(?)
        OR LOWER(COALESCE(p.contacto_nombre,'')) LIKE LOWER(?)
        OR LOWER(COALESCE(p.telefono,''))        LIKE LOWER(?)
      )
      ${activoCond}
      ORDER BY p.razon_social COLLATE NOCASE ASC
    `, [like, like, like, like]);
  }

  function getById(id) {
    const rows = db().query(`SELECT * FROM proveedores WHERE id = ?`, [id]);
    return rows[0] || null;
  }

  function crear(data) {
    try {
      const id = uid();
      db().run(`
        INSERT INTO proveedores
          (id, razon_social, cuit, telefono, email, contacto_nombre,
           condicion_pago, activo, sync_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?)
      `, [
        id,
        (data.razon_social    || '').trim(),
        (data.cuit            || '').trim() || null,
        (data.telefono        || '').trim() || null,
        (data.email           || '').trim() || null,
        (data.contacto_nombre || '').trim() || null,
        data.condicion_pago || null,
        now(),
      ]);
      return { success: true, id };
    } catch (e) {
      console.error('SGA_Proveedores.crear:', e);
      return { success: false, error: e.message };
    }
  }

  function actualizar(id, data) {
    try {
      db().run(`
        UPDATE proveedores SET
          razon_social    = ?,
          cuit            = ?,
          telefono        = ?,
          email           = ?,
          contacto_nombre = ?,
          condicion_pago  = ?,
          sync_status     = 'pending',
          updated_at      = ?
        WHERE id = ?
      `, [
        (data.razon_social    || '').trim(),
        (data.cuit            || '').trim() || null,
        (data.telefono        || '').trim() || null,
        (data.email           || '').trim() || null,
        (data.contacto_nombre || '').trim() || null,
        data.condicion_pago || null,
        now(),
        id,
      ]);
      return { success: true };
    } catch (e) {
      console.error('SGA_Proveedores.actualizar:', e);
      return { success: false, error: e.message };
    }
  }

  function desactivar(id) {
    try {
      db().run(
        `UPDATE proveedores SET activo = 0, sync_status = 'pending', updated_at = ? WHERE id = ?`,
        [now(), id]
      );
      return { success: true };
    } catch (e) {
      console.error('SGA_Proveedores.desactivar:', e);
      return { success: false, error: e.message };
    }
  }

  return { getAll, getById, crear, actualizar, desactivar };
})();

window.SGA_Proveedores = SGA_Proveedores;

// ── CONSTANTS ────────────────────────────────────────────────────────────────

const CONDICION_PAGO_OPTS = ['Contado', '15 días', '30 días', '60 días', 'Consignación'];

// ── UI MODULE ────────────────────────────────────────────────────────────────

const Proveedores = (() => {
  'use strict';

  const ge  = id => document.getElementById(id);
  const esc = s  => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const state = { search: '', showInactivos: false };

  // ── RENDER LIST ────────────────────────────────────────────────────────────

  function renderList() {
    const tbodyEl = ge('prov-tbody');
    const countEl = ge('prov-count');
    if (!tbodyEl) return;

    const activo = state.showInactivos ? 'todos' : 1;
    const rows = SGA_Proveedores.getAll({ search: state.search, activo });

    countEl.textContent = `${rows.length} proveedor${rows.length !== 1 ? 'es' : ''}`;

    if (!rows.length) {
      tbodyEl.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center;color:#999;padding:40px 0;font-size:14px">
            ${state.search ? 'Sin resultados para la búsqueda.' : 'No hay proveedores registrados.'}
          </td>
        </tr>
      `;
      return;
    }

    tbodyEl.innerHTML = rows.map(p => `
      <tr>
        <td>
          <strong>${esc(p.razon_social)}</strong>
          ${p.productos_count > 0
            ? `<span class="prov-prod-count">${p.productos_count} prod.</span>`
            : ''}
        </td>
        <td>${esc(p.cuit || '—')}</td>
        <td>${esc(p.telefono || '—')}</td>
        <td>${esc(p.contacto_nombre || '—')}</td>
        <td>${esc(p.condicion_pago || '—')}</td>
        <td>
          ${p.activo
            ? `<span class="prov-badge active">Activo</span>`
            : `<span class="prov-badge inactive">Inactivo</span>`}
        </td>
        <td>
          <div class="prov-actions">
            <button class="prov-btn-icon prov-btn-edit" data-id="${esc(p.id)}" title="Editar">✏️</button>
            ${p.activo
              ? `<button class="prov-btn-icon prov-btn-deact" data-id="${esc(p.id)}" title="Desactivar">🚫</button>`
              : ''}
          </div>
        </td>
      </tr>
    `).join('');

    tbodyEl.querySelectorAll('.prov-btn-edit').forEach(btn => {
      btn.addEventListener('click', () => openModal(btn.dataset.id));
    });
    tbodyEl.querySelectorAll('.prov-btn-deact').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('¿Desactivar este proveedor? Los productos vinculados no se verán afectados.')) return;
        const res = SGA_Proveedores.desactivar(btn.dataset.id);
        if (res.success) renderList();
        else alert('Error: ' + res.error);
      });
    });
  }

  // ── MODAL FORM ─────────────────────────────────────────────────────────────

  function openModal(id) {
    const prov  = id ? SGA_Proveedores.getById(id) : null;
    const title = prov ? 'Editar Proveedor' : 'Nuevo Proveedor';

    const condOpts = CONDICION_PAGO_OPTS.map(o =>
      `<option value="${esc(o)}" ${prov && prov.condicion_pago === o ? 'selected' : ''}>${esc(o)}</option>`
    ).join('');

    const overlay = ge('prov-modal-overlay');
    overlay.innerHTML = `
      <div class="prov-modal">
        <div class="prov-modal-hdr">
          <span>${esc(title)}</span>
          <button id="btn-prov-close" class="prov-modal-close">✕</button>
        </div>
        <div class="prov-modal-body">
          <div class="prov-field">
            <label>Razón social <span class="prov-req">*</span></label>
            <input type="text" id="pf-razon" class="prov-input"
              value="${esc(prov ? prov.razon_social : '')}"
              placeholder="Nombre del proveedor">
          </div>
          <div class="prov-field-row">
            <div class="prov-field">
              <label>CUIT</label>
              <input type="text" id="pf-cuit" class="prov-input"
                value="${esc(prov ? (prov.cuit || '') : '')}"
                placeholder="20-12345678-9">
            </div>
            <div class="prov-field">
              <label>Condición de pago</label>
              <select id="pf-condicion" class="prov-input">
                <option value="">— Sin definir —</option>
                ${condOpts}
              </select>
            </div>
          </div>
          <div class="prov-field-row">
            <div class="prov-field">
              <label>Teléfono</label>
              <input type="text" id="pf-telefono" class="prov-input"
                value="${esc(prov ? (prov.telefono || '') : '')}"
                placeholder="011 4444-5555">
            </div>
            <div class="prov-field">
              <label>Email</label>
              <input type="email" id="pf-email" class="prov-input"
                value="${esc(prov ? (prov.email || '') : '')}"
                placeholder="ventas@proveedor.com">
            </div>
          </div>
          <div class="prov-field">
            <label>Nombre de contacto</label>
            <input type="text" id="pf-contacto" class="prov-input"
              value="${esc(prov ? (prov.contacto_nombre || '') : '')}"
              placeholder="Nombre del vendedor">
          </div>
          <p id="prov-form-error" style="color:#f44336;font-size:13px;margin:6px 0 0;display:none"></p>
        </div>
        <div class="prov-modal-ftr">
          <button class="prov-btn-secondary" id="btn-prov-cancel">Cancelar</button>
          <button class="prov-btn-primary" id="btn-prov-save">
            ${prov ? 'Guardar cambios' : '+ Crear proveedor'}
          </button>
        </div>
      </div>
    `;
    overlay.classList.remove('hidden');
    setTimeout(() => ge('pf-razon') && ge('pf-razon').focus(), 60);

    const close = () => {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    };

    ge('btn-prov-close').addEventListener('click', close);
    ge('btn-prov-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const save = () => {
      const razon = (ge('pf-razon').value || '').trim();
      const errEl = ge('prov-form-error');
      if (!razon) {
        errEl.textContent = 'La razón social es obligatoria.';
        errEl.style.display = 'block';
        ge('pf-razon').focus();
        return;
      }
      errEl.style.display = 'none';

      const data = {
        razon_social:    razon,
        cuit:            ge('pf-cuit').value,
        telefono:        ge('pf-telefono').value,
        email:           ge('pf-email').value,
        contacto_nombre: ge('pf-contacto').value,
        condicion_pago:  ge('pf-condicion').value || null,
      };

      const res = prov
        ? SGA_Proveedores.actualizar(prov.id, data)
        : SGA_Proveedores.crear(data);

      if (res.success) {
        close();
        renderList();
      } else {
        errEl.textContent = 'Error: ' + res.error;
        errEl.style.display = 'block';
      }
    };

    ge('btn-prov-save').addEventListener('click', save);
    overlay.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    });
  }

  // ── INIT ───────────────────────────────────────────────────────────────────

  const init = () => {
    const root = ge('prov-root');
    if (!root) return;

    root.innerHTML = `
      <div class="prov-header">
        <div>
          <h2>🏢 Proveedores</h2>
          <span id="prov-count" class="prov-count-label"></span>
        </div>
        <div class="prov-header-right">
          <button id="btn-nuevo-prov" class="prov-btn-primary">+ Nuevo Proveedor</button>
        </div>
      </div>
      <div class="prov-filters">
        <input type="text" id="prov-search" class="prov-search"
          placeholder="Buscar por razón social, CUIT o contacto…"
          value="${esc(state.search)}">
        <button id="btn-prov-inactivos"
          class="prov-toggle ${state.showInactivos ? 'active' : ''}">
          Ver inactivos
        </button>
      </div>
      <div class="prov-table-wrap">
        <table class="prov-table">
          <thead>
            <tr>
              <th>Razón social</th>
              <th>CUIT</th>
              <th>Teléfono</th>
              <th>Contacto</th>
              <th>Cond. pago</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="prov-tbody"></tbody>
        </table>
      </div>
    `;

    let searchTimer = null;
    ge('prov-search').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value.trim();
        renderList();
      }, 220);
    });

    ge('btn-prov-inactivos').addEventListener('click', () => {
      state.showInactivos = !state.showInactivos;
      ge('btn-prov-inactivos').classList.toggle('active', state.showInactivos);
      renderList();
    });

    ge('btn-nuevo-prov').addEventListener('click', () => openModal(null));

    renderList();
  };

  return { init };
})();

export default Proveedores;
