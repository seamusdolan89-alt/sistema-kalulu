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
        OR LOWER(COALESCE(p.alias,''))           LIKE LOWER(?)
        OR LOWER(COALESCE(p.cuit,''))            LIKE LOWER(?)
        OR LOWER(COALESCE(p.contacto_nombre,'')) LIKE LOWER(?)
        OR LOWER(COALESCE(p.telefono,''))        LIKE LOWER(?)
      )
      ${activoCond}
      ORDER BY p.razon_social COLLATE NOCASE ASC
    `, [like, like, like, like, like]);
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
          (id, razon_social, alias, cuit, condicion_iva,
           agente_retencion_iva, agente_retencion_iibb,
           telefono, email, contacto_nombre,
           condicion_pago, condicion_compra, tipo_proveedor, activo, sync_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?)
      `, [
        id,
        (data.razon_social    || '').trim(),
        (data.alias           || '').trim() || null,
        (data.cuit            || '').trim() || null,
        data.condicion_iva    || null,
        data.agente_retencion_iva  ? 1 : 0,
        data.agente_retencion_iibb ? 1 : 0,
        (data.telefono        || '').trim() || null,
        (data.email           || '').trim() || null,
        (data.contacto_nombre || '').trim() || null,
        data.condicion_pago   || null,
        data.condicion_compra || null,
        data.tipo_proveedor   || 'mercaderia',
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
          razon_social          = ?,
          alias                 = ?,
          cuit                  = ?,
          condicion_iva         = ?,
          agente_retencion_iva  = ?,
          agente_retencion_iibb = ?,
          telefono              = ?,
          email                 = ?,
          contacto_nombre       = ?,
          condicion_pago        = ?,
          condicion_compra      = ?,
          tipo_proveedor        = ?,
          sync_status           = 'pending',
          updated_at            = ?
        WHERE id = ?
      `, [
        (data.razon_social    || '').trim(),
        (data.alias           || '').trim() || null,
        (data.cuit            || '').trim() || null,
        data.condicion_iva    || null,
        data.agente_retencion_iva  ? 1 : 0,
        data.agente_retencion_iibb ? 1 : 0,
        (data.telefono        || '').trim() || null,
        (data.email           || '').trim() || null,
        (data.contacto_nombre || '').trim() || null,
        data.condicion_pago   || null,
        data.condicion_compra || null,
        data.tipo_proveedor   || 'mercaderia',
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

const CONDICION_PAGO_OPTS   = ['Contado', '15 días', '30 días', '60 días', 'Consignación'];
const CONDICION_COMPRA_OPTS = ['Factura A', 'Factura B', 'Factura C', 'Remito', 'Ticket'];
const CONDICION_IVA_OPTS  = [
  'Responsable Inscripto',
  'Monotributista',
  'Exento',
  'No Responsable',
  'Consumidor Final',
];

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
          <td colspan="8" style="text-align:center;color:#999;padding:40px 0;font-size:14px">
            ${state.search ? 'Sin resultados para la búsqueda.' : 'No hay proveedores registrados.'}
          </td>
        </tr>
      `;
      return;
    }

    const IVA_SHORT = {
      'Responsable Inscripto': 'Resp. Inscripto',
      'Monotributista':        'Monotrib.',
      'Exento':                'Exento',
      'No Responsable':        'No Resp.',
      'Consumidor Final':      'Cons. Final',
    };

    tbodyEl.innerHTML = rows.map(p => `
      <tr>
        <td>
          <strong>${esc(p.razon_social)}</strong>
          ${p.alias ? `<span class="prov-alias">${esc(p.alias)}</span>` : ''}
          ${p.productos_count > 0
            ? `<span class="prov-prod-count">${p.productos_count} prod.</span>`
            : ''}
        </td>
        <td>
          ${esc(p.cuit || '—')}
          ${p.condicion_iva
            ? `<div class="prov-iva-label">${esc(IVA_SHORT[p.condicion_iva] || p.condicion_iva)}</div>`
            : ''}
        </td>
        <td>${esc(p.telefono || '—')}</td>
        <td>${esc(p.contacto_nombre || '—')}</td>
        <td>${esc(p.condicion_pago || '—')}</td>
        <td>${esc(p.condicion_compra || '—')}</td>
        <td>
          ${p.activo
            ? `<span class="prov-badge active">Activo</span>`
            : `<span class="prov-badge inactive">Inactivo</span>`}
          ${p.tipo_proveedor === 'servicios'
            ? `<span class="prov-badge prov-badge-svc">Servicios</span>`
            : `<span class="prov-badge prov-badge-merc">Mercadería</span>`}
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

    const ivaOpts = CONDICION_IVA_OPTS.map(o =>
      `<option value="${esc(o)}" ${prov && prov.condicion_iva === o ? 'selected' : ''}>${esc(o)}</option>`
    ).join('');

    const pagoOpts = CONDICION_PAGO_OPTS.map(o =>
      `<option value="${esc(o)}" ${prov && prov.condicion_pago === o ? 'selected' : ''}>${esc(o)}</option>`
    ).join('');

    const compraOpts = CONDICION_COMPRA_OPTS.map(o =>
      `<option value="${esc(o)}" ${prov && prov.condicion_compra === o ? 'selected' : ''}>${esc(o)}</option>`
    ).join('');

    const chkIva  = prov && prov.agente_retencion_iva  ? 'checked' : '';
    const chkIibb = prov && prov.agente_retencion_iibb ? 'checked' : '';

    const overlay = ge('prov-modal-overlay');
    overlay.innerHTML = `
      <div class="prov-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="prov-modal-hdr">
          <span>${esc(title)}</span>
          <button id="btn-prov-close" class="prov-modal-close" title="Cerrar (Esc)">✕</button>
        </div>
        <div class="prov-modal-body">

          <!-- ── TIPO DE PROVEEDOR ── -->
          <div class="prov-tipo-toggle-wrap">
            <span class="prov-tipo-opt ${(!prov || prov.tipo_proveedor === 'mercaderia') ? 'prov-tipo-active' : ''}">
              📦 Mercadería
            </span>
            <label class="prov-tipo-switch">
              <input type="checkbox" id="pf-tipo-toggle"
                ${prov && prov.tipo_proveedor === 'servicios' ? 'checked' : ''}>
              <span class="prov-tipo-track"></span>
            </label>
            <span class="prov-tipo-opt ${prov && prov.tipo_proveedor === 'servicios' ? 'prov-tipo-active prov-tipo-active-svc' : ''}">
              🧾 Gastos y Servicios
            </span>
          </div>

          <!-- ── IDENTIFICACIÓN ── -->
          <div class="prov-section-sep">Identificación</div>
          <div class="prov-field">
            <label for="pf-razon">Razón social <span class="prov-req">*</span></label>
            <input type="text" id="pf-razon" class="prov-input"
              value="${esc(prov ? prov.razon_social : '')}"
              placeholder="Nombre legal del proveedor"
              autocomplete="off">
          </div>
          <div class="prov-field">
            <label for="pf-alias">Alias</label>
            <input type="text" id="pf-alias" class="prov-input"
              value="${esc(prov ? (prov.alias || '') : '')}"
              placeholder="Nombre corto para búsquedas rápidas"
              autocomplete="off">
          </div>

          <!-- ── FISCAL ── -->
          <div class="prov-section-sep">Datos fiscales</div>
          <div class="prov-field-row">
            <div class="prov-field">
              <label for="pf-cuit">CUIT</label>
              <input type="text" id="pf-cuit" class="prov-input"
                value="${esc(prov ? (prov.cuit || '') : '')}"
                placeholder="20-12345678-9"
                autocomplete="off">
            </div>
            <div class="prov-field">
              <label for="pf-condiva">Condición IVA</label>
              <select id="pf-condiva" class="prov-input">
                <option value="">— Sin definir —</option>
                ${ivaOpts}
              </select>
            </div>
          </div>
          <div class="prov-check-group">
            <label class="prov-check-row" tabindex="0" id="lbl-ret-iva">
              <input type="checkbox" id="pf-ret-iva" ${chkIva}>
              <span class="prov-check-box" aria-hidden="true"></span>
              <span class="prov-check-text">Agente de retención IVA</span>
            </label>
            <label class="prov-check-row" tabindex="0" id="lbl-ret-iibb">
              <input type="checkbox" id="pf-ret-iibb" ${chkIibb}>
              <span class="prov-check-box" aria-hidden="true"></span>
              <span class="prov-check-text">Agente de retención IIBB</span>
            </label>
          </div>

          <!-- ── CONTACTO ── -->
          <div class="prov-section-sep">Contacto</div>
          <div class="prov-field-row">
            <div class="prov-field">
              <label for="pf-telefono">Teléfono</label>
              <input type="text" id="pf-telefono" class="prov-input"
                value="${esc(prov ? (prov.telefono || '') : '')}"
                placeholder="011 4444-5555"
                autocomplete="off">
            </div>
            <div class="prov-field">
              <label for="pf-email">Email</label>
              <input type="email" id="pf-email" class="prov-input"
                value="${esc(prov ? (prov.email || '') : '')}"
                placeholder="ventas@proveedor.com"
                autocomplete="off">
            </div>
          </div>
          <div class="prov-field">
            <label for="pf-contacto">Nombre de contacto</label>
            <input type="text" id="pf-contacto" class="prov-input"
              value="${esc(prov ? (prov.contacto_nombre || '') : '')}"
              placeholder="Nombre del vendedor o referente"
              autocomplete="off">
          </div>

          <!-- ── COMERCIAL ── -->
          <div class="prov-section-sep">Condiciones comerciales</div>
          <div class="prov-field-row">
            <div class="prov-field">
              <label for="pf-condpago">Condición de pago</label>
              <select id="pf-condpago" class="prov-input">
                <option value="">— Sin definir —</option>
                ${pagoOpts}
              </select>
            </div>
            <div class="prov-field">
              <label for="pf-condcompra">Condición de compra</label>
              <select id="pf-condcompra" class="prov-input">
                <option value="">— Sin definir —</option>
                ${compraOpts}
              </select>
            </div>
          </div>

          <p id="prov-form-error" class="prov-form-error" style="display:none"></p>
        </div>
        <div class="prov-modal-ftr">
          <span class="prov-kbd-hint">Tab para navegar · Enter para guardar · Esc para cerrar</span>
          <button class="prov-btn-secondary" id="btn-prov-cancel">Cancelar</button>
          <button class="prov-btn-primary" id="btn-prov-save">
            ${prov ? 'Guardar cambios' : '+ Crear proveedor'}
          </button>
        </div>
      </div>
    `;
    overlay.classList.remove('hidden');
    setTimeout(() => ge('pf-razon') && ge('pf-razon').focus(), 60);

    // ── CLOSE ──
    const close = () => {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    };

    ge('btn-prov-close').addEventListener('click', close);
    ge('btn-prov-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Toggle tipo visual feedback
    ge('pf-tipo-toggle').addEventListener('change', () => {
      const esSvc = ge('pf-tipo-toggle').checked;
      const opts = overlay.querySelectorAll('.prov-tipo-opt');
      opts[0].classList.toggle('prov-tipo-active', !esSvc);
      opts[0].classList.remove('prov-tipo-active-svc');
      opts[1].classList.toggle('prov-tipo-active', esSvc);
      opts[1].classList.toggle('prov-tipo-active-svc', esSvc);
    });

    // ── SAVE ──
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
        razon_social:          razon,
        alias:                 ge('pf-alias').value,
        cuit:                  ge('pf-cuit').value,
        condicion_iva:         ge('pf-condiva').value || null,
        agente_retencion_iva:  ge('pf-ret-iva').checked,
        agente_retencion_iibb: ge('pf-ret-iibb').checked,
        telefono:              ge('pf-telefono').value,
        email:                 ge('pf-email').value,
        contacto_nombre:       ge('pf-contacto').value,
        condicion_pago:        ge('pf-condpago').value   || null,
        condicion_compra:      ge('pf-condcompra').value || null,
        tipo_proveedor:        ge('pf-tipo-toggle').checked ? 'servicios' : 'mercaderia',
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

    // ── KEYBOARD NAVIGATION ──

    // Enter on text inputs and selects → save
    const modal = overlay.querySelector('.prov-modal');
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Enter') {
        const tag  = e.target.tagName;
        const type = e.target.type;
        // Enter on checkbox: let it toggle natively (don't save)
        if (type === 'checkbox') return;
        // Enter on select: don't save — let arrow keys change value
        if (tag === 'SELECT') { e.preventDefault(); save(); return; }
        // Enter on button: let it fire normally
        if (tag === 'BUTTON') return;
        // Enter on any input text/email → save
        e.preventDefault();
        save();
      }
    });

    // Keyboard support for styled <label tabindex="0"> wrappers around checkboxes:
    // Space or Enter while the label is focused → toggle the checkbox
    ['lbl-ret-iva', 'lbl-ret-iibb'].forEach(lblId => {
      ge(lblId).addEventListener('keydown', e => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          const chk = ge(lblId).querySelector('input[type="checkbox"]');
          chk.checked = !chk.checked;
        }
      });
    });
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────

  function exportarProveedores() {
    const rows = SGA_Proveedores.getAll({ activo: 'todos' });

    const headers = [
      'razon_social', 'alias', 'cuit', 'condicion_iva',
      'agente_retencion_iva', 'agente_retencion_iibb',
      'telefono', 'email', 'contacto_nombre',
      'condicion_pago', 'condicion_compra', 'tipo_proveedor', 'activo',
    ];

    const instrRow = [
      '* Obligatorio', '', '', '→ Ver opciones válidas abajo',
      '→ 1=sí, 0=no', '→ 1=sí, 0=no',
      '', '', '',
      '→ Ver opciones válidas abajo', '→ Ver opciones válidas abajo',
      '→ mercaderia | servicios', '→ 1=activo, 0=inactivo',
    ];

    let dataRows, filename;
    if (rows.length > 0) {
      dataRows = rows.map(p => [
        p.razon_social || '',
        p.alias || '',
        p.cuit || '',
        p.condicion_iva || '',
        p.agente_retencion_iva ? 1 : 0,
        p.agente_retencion_iibb ? 1 : 0,
        p.telefono || '',
        p.email || '',
        p.contacto_nombre || '',
        p.condicion_pago || '',
        p.condicion_compra || '',
        p.tipo_proveedor || 'mercaderia',
        p.activo != null ? p.activo : 1,
      ]);
      filename = 'proveedores_exportados.xlsx';
    } else {
      dataRows = [
        ['Distribuidora Ejemplo S.A.', 'DistrEjemplo', '30-12345678-9', 'Responsable Inscripto', 1, 0, '011 4444-5555', 'ventas@ejemplo.com', 'Juan García', 'Contado', 'Factura A', 'mercaderia', 1],
      ];
      filename = 'plantilla_proveedores.xlsx';
    }

    const ws = XLSX.utils.aoa_to_sheet([headers, instrRow, ...dataRows]);
    ws['!cols'] = [
      { wch: 28 }, { wch: 16 }, { wch: 16 }, { wch: 22 },
      { wch: 20 }, { wch: 22 },
      { wch: 16 }, { wch: 26 }, { wch: 20 },
      { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 10 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Proveedores');
    XLSX.writeFile(wb, filename);
  }

  // ── IMPORT ────────────────────────────────────────────────────────────────

  let importData = { filas: [] };

  function openImportModal() {
    importData = { filas: [] };
    const overlay = ge('prov-import-overlay');
    overlay.innerHTML = `
      <div class="prov-modal" role="dialog" aria-modal="true" aria-label="Importar Proveedores">
        <div class="prov-modal-hdr">
          <span>Importar Proveedores desde Excel</span>
          <button id="btn-prov-imp-close" class="prov-modal-close" title="Cerrar">✕</button>
        </div>
        <div class="prov-modal-body">
          <div id="prov-imp-step1">
            <p style="font-size:13px;color:var(--color-text-secondary);margin:0 0 12px">
              Seleccioná un archivo Excel (.xlsx) exportado desde este sistema.<br>
              Columna obligatoria: <strong>razon_social</strong>. Si ya existe un proveedor con la misma razón social, será actualizado.
            </p>
            <input type="file" id="prov-imp-file" accept=".xlsx,.xls" style="font-size:13px">
          </div>
          <div id="prov-imp-step2" style="display:none">
            <div id="prov-imp-preview"></div>
            <div id="prov-imp-summary" style="margin-top:10px"></div>
          </div>
        </div>
        <div class="prov-modal-ftr">
          <button class="prov-btn-secondary" id="btn-prov-imp-back" style="display:none">Volver</button>
          <button class="prov-btn-secondary" id="btn-prov-imp-cancel">Cancelar</button>
          <button class="prov-btn-primary" id="btn-prov-imp-confirm" style="display:none">Importar</button>
          <button class="prov-btn-primary" id="btn-prov-imp-done" style="display:none">Listo</button>
        </div>
      </div>
    `;
    overlay.classList.remove('hidden');

    const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };

    ge('btn-prov-imp-close').addEventListener('click', close);
    ge('btn-prov-imp-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    ge('prov-imp-file').addEventListener('change', e => {
      if (e.target.files[0]) handleImportFile(e.target.files[0]);
    });

    ge('btn-prov-imp-back').addEventListener('click', () => {
      ge('prov-imp-step1').style.display = '';
      ge('prov-imp-step2').style.display = 'none';
      ge('btn-prov-imp-back').style.display = 'none';
      ge('btn-prov-imp-confirm').style.display = 'none';
      ge('btn-prov-imp-done').style.display = 'none';
      ge('prov-imp-file').value = '';
      ge('prov-imp-preview').innerHTML = '';
      ge('prov-imp-summary').innerHTML = '';
    });

    ge('btn-prov-imp-confirm').addEventListener('click', confirmarImport);
    ge('btn-prov-imp-done').addEventListener('click', close);
  }

  function handleImportFile(file) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      alert('Por favor seleccioná un archivo Excel (.xlsx o .xls)');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (jsonData.length < 2) { alert('El archivo no tiene datos suficientes'); return; }

        const headerRow = jsonData[0].map(h => String(h || '').trim().toLowerCase());
        const idxOf = name => headerRow.indexOf(name);
        const idx = {
          razon_social:          idxOf('razon_social'),
          alias:                 idxOf('alias'),
          cuit:                  idxOf('cuit'),
          condicion_iva:         idxOf('condicion_iva'),
          agente_retencion_iva:  idxOf('agente_retencion_iva'),
          agente_retencion_iibb: idxOf('agente_retencion_iibb'),
          telefono:              idxOf('telefono'),
          email:                 idxOf('email'),
          contacto_nombre:       idxOf('contacto_nombre'),
          condicion_pago:        idxOf('condicion_pago'),
          condicion_compra:      idxOf('condicion_compra'),
          tipo_proveedor:        idxOf('tipo_proveedor'),
          activo:                idxOf('activo'),
        };

        importData.filas = jsonData.slice(1)
          .filter(row => row.some(c => c !== null && c !== undefined && String(c).trim() !== ''))
          .map(row => {
            const rawTipo = idx.tipo_proveedor >= 0 ? String(row[idx.tipo_proveedor] || '').trim().toLowerCase() : '';
            return {
              razon_social:          idx.razon_social >= 0          ? String(row[idx.razon_social] || '').trim() : '',
              alias:                 idx.alias >= 0                 ? String(row[idx.alias] || '').trim() : '',
              cuit:                  idx.cuit >= 0                  ? String(row[idx.cuit] || '').trim() : '',
              condicion_iva:         idx.condicion_iva >= 0         ? String(row[idx.condicion_iva] || '').trim() : '',
              agente_retencion_iva:  idx.agente_retencion_iva >= 0  ? (parseInt(row[idx.agente_retencion_iva]) === 1 ? 1 : 0) : 0,
              agente_retencion_iibb: idx.agente_retencion_iibb >= 0 ? (parseInt(row[idx.agente_retencion_iibb]) === 1 ? 1 : 0) : 0,
              telefono:              idx.telefono >= 0              ? String(row[idx.telefono] || '').trim() : '',
              email:                 idx.email >= 0                 ? String(row[idx.email] || '').trim() : '',
              contacto_nombre:       idx.contacto_nombre >= 0       ? String(row[idx.contacto_nombre] || '').trim() : '',
              condicion_pago:        idx.condicion_pago >= 0        ? String(row[idx.condicion_pago] || '').trim() : '',
              condicion_compra:      idx.condicion_compra >= 0      ? String(row[idx.condicion_compra] || '').trim() : '',
              tipo_proveedor:        rawTipo === 'servicios' ? 'servicios' : 'mercaderia',
              activo:                idx.activo >= 0                ? (parseInt(row[idx.activo]) === 0 ? 0 : 1) : 1,
            };
          })
          .filter(r => r.razon_social);

        if (!importData.filas.length) {
          alert('No se encontraron filas válidas (la columna "razon_social" es obligatoria)');
          return;
        }

        showImportPreview();
      } catch (err) {
        alert('Error al leer el archivo: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function showImportPreview() {
    const filas = importData.filas;
    const preview = filas.slice(0, 6);
    let html = `<p style="font-size:13px;margin:0 0 8px"><strong>${filas.length}</strong> proveedor(es) detectados. Vista previa:</p>`;
    html += '<table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr>';
    ['Razón social', 'Alias', 'CUIT', 'Condición IVA', 'Teléfono'].forEach(h => {
      html += `<th style="text-align:left;padding:4px 8px;border-bottom:2px solid var(--color-border)">${h}</th>`;
    });
    html += '</tr></thead><tbody>';
    preview.forEach(r => {
      html += `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid var(--color-border)">${esc(r.razon_social)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--color-border)">${esc(r.alias)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--color-border)">${esc(r.cuit)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--color-border)">${esc(r.condicion_iva)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--color-border)">${esc(r.telefono)}</td>
      </tr>`;
    });
    if (filas.length > 6) {
      html += `<tr><td colspan="5" style="padding:6px 8px;color:var(--color-text-secondary);font-size:12px">… y ${filas.length - 6} más</td></tr>`;
    }
    html += '</tbody></table>';

    ge('prov-imp-preview').innerHTML = html;
    ge('prov-imp-step1').style.display = 'none';
    ge('prov-imp-step2').style.display = '';
    ge('btn-prov-imp-back').style.display = '';
    ge('btn-prov-imp-confirm').style.display = '';
  }

  function confirmarImport() {
    const filas = importData.filas;
    const n = window.SGA_Utils.formatISODate(new Date());
    let nuevos = 0, actualizados = 0;
    const errores = [];

    filas.forEach((fila, i) => {
      try {
        const existing = window.SGA_DB.query(
          `SELECT id FROM proveedores WHERE LOWER(TRIM(razon_social)) = LOWER(?) LIMIT 1`,
          [fila.razon_social]
        );
        if (existing.length) {
          window.SGA_DB.run(`
            UPDATE proveedores SET
              alias = ?, cuit = ?, condicion_iva = ?,
              agente_retencion_iva = ?, agente_retencion_iibb = ?,
              telefono = ?, email = ?, contacto_nombre = ?,
              condicion_pago = ?, condicion_compra = ?, tipo_proveedor = ?, activo = ?,
              sync_status = 'pending', updated_at = ?
            WHERE id = ?
          `, [
            fila.alias || null, fila.cuit || null, fila.condicion_iva || null,
            fila.agente_retencion_iva, fila.agente_retencion_iibb,
            fila.telefono || null, fila.email || null, fila.contacto_nombre || null,
            fila.condicion_pago || null, fila.condicion_compra || null,
            fila.tipo_proveedor || 'mercaderia', fila.activo,
            n, existing[0].id,
          ]);
          actualizados++;
        } else {
          window.SGA_DB.run(`
            INSERT INTO proveedores
              (id, razon_social, alias, cuit, condicion_iva,
               agente_retencion_iva, agente_retencion_iibb,
               telefono, email, contacto_nombre,
               condicion_pago, condicion_compra, tipo_proveedor, activo, sync_status, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)
          `, [
            uid(), fila.razon_social,
            fila.alias || null, fila.cuit || null, fila.condicion_iva || null,
            fila.agente_retencion_iva, fila.agente_retencion_iibb,
            fila.telefono || null, fila.email || null, fila.contacto_nombre || null,
            fila.condicion_pago || null, fila.condicion_compra || null,
            fila.tipo_proveedor || 'mercaderia', fila.activo,
            n,
          ]);
          nuevos++;
        }
      } catch (e) {
        errores.push(`Fila ${i + 2}: ${e.message}`);
      }
    });

    let html = '';
    if (nuevos > 0)      html += `<div style="padding:6px 10px;background:#e8f5e9;border-radius:4px;margin-bottom:6px;font-size:13px">✅ ${nuevos} proveedor(es) nuevos importados</div>`;
    if (actualizados > 0) html += `<div style="padding:6px 10px;background:#e8f5e9;border-radius:4px;margin-bottom:6px;font-size:13px">✏️ ${actualizados} proveedor(es) actualizados</div>`;
    errores.forEach(e => { html += `<div style="padding:6px 10px;background:#fff0f0;border-radius:4px;margin-bottom:6px;font-size:13px;color:#c62828">⚠️ ${esc(e)}</div>`; });

    ge('prov-imp-summary').innerHTML = html;
    ge('btn-prov-imp-confirm').style.display = 'none';
    ge('btn-prov-imp-back').style.display = 'none';
    ge('btn-prov-imp-done').style.display = '';
    renderList();
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
          <button id="btn-exportar-prov" class="prov-btn-secondary">↓ Exportar Excel</button>
          <button id="btn-importar-prov" class="prov-btn-secondary">↑ Importar Excel</button>
          <button id="btn-nuevo-prov" class="prov-btn-primary">+ Nuevo Proveedor</button>
        </div>
      </div>
      <div class="prov-filters">
        <input type="text" id="prov-search" class="prov-search"
          placeholder="Buscar por razón social, alias, CUIT o contacto…"
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
              <th>CUIT / IVA</th>
              <th>Teléfono</th>
              <th>Contacto</th>
              <th>Cond. pago</th>
              <th>Cond. compra</th>
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

    ge('btn-exportar-prov').addEventListener('click', exportarProveedores);
    ge('btn-importar-prov').addEventListener('click', openImportModal);
    ge('btn-nuevo-prov').addEventListener('click', () => openModal(null));

    renderList();
  };

  return { init };
})();

export default Proveedores;
