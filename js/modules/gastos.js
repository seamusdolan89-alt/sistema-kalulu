'use strict';

const Gastos = (() => {
  const ge  = id => document.getElementById(id);
  const db  = ()  => window.SGA_DB;
  const fmt$= n   => window.SGA_Utils.formatCurrency(n);
  const uid = ()  => window.SGA_Utils.generateUUID();
  const esc = s   => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const today = () => new Date().toISOString().slice(0, 10);

  // ── CONSTANTS ─────────────────────────────────────────────────────────────────

  const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  const CATEGORIAS = [
    { value: 'servicios',     label: 'Servicios'           },
    { value: 'impuestos',     label: 'Impuestos y Tasas'   },
    { value: 'alquiler',      label: 'Alquiler / Expensas' },
    { value: 'comisiones',    label: 'Comisiones'          },
    { value: 'mantenimiento', label: 'Mantenimiento'       },
    { value: 'viaticos',      label: 'Viáticos y Fletes'   },
    { value: 'suministros',   label: 'Suministros'         },
    { value: 'sueldos',       label: 'Sueldos y Cargas'    },
    { value: 'honorarios',    label: 'Honorarios'          },
    { value: 'otros',         label: 'Otros'               },
  ];

  const SUBCATS = [
    { value: 'fijo',        label: 'Sueldo Fijo'            },
    { value: 'variable',    label: 'Variable / Comisión'    },
    { value: 'horas_extra', label: 'Horas Extra'            },
    { value: 'reemplazo',   label: 'Reemplazo / Vacaciones' },
    { value: 'aguinaldo',   label: 'Aguinaldo (SAC)'        },
  ];

  const METODOS = [
    { value: 'transferencia',     label: 'Transferencia'     },
    { value: 'debito_automatico', label: 'Débito Automático' },
    { value: 'efectivo',          label: 'Efectivo'          },
    { value: 'cheque',            label: 'Cheque'            },
    { value: 'tarjeta',           label: 'Tarjeta'           },
  ];

  const IVA_OPTS = [
    { value: '',     label: 'Sin IVA'  },
    { value: '10.5', label: '10,5 %'  },
    { value: '21',   label: '21 %'    },
    { value: '27',   label: '27 %'    },
  ];

  // ── STATE ─────────────────────────────────────────────────────────────────────

  const state = {
    tab: 'cargar',
    sucursalId: null,
    userId: null,
    cargar:  { provId: null, provNombre: null },
    sueldos: { provId: null, provNombre: null, pagoRows: [] },
  };

  // ── PERIOD HELPERS ────────────────────────────────────────────────────────────

  function pLabel(p) {
    if (!p) return '—';
    const [y, m] = p.split('-');
    return `${MESES[parseInt(m, 10) - 1]}-${y}`;
  }
  function pNow() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function pShift(p, n) {
    const [y, m] = p.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function pOptions(sel) {
    const opts = [];
    for (let i = 3; i >= -23; i--) {
      const v = pShift(pNow(), i);
      opts.push(`<option value="${v}"${v === sel ? ' selected' : ''}>${pLabel(v)}</option>`);
    }
    return opts.join('');
  }
  function pSuggested(provId) {
    if (!provId) return pNow();
    const r = db().query(
      `SELECT periodo FROM gastos WHERE proveedor_id=? AND sucursal_id=? AND periodo IS NOT NULL ORDER BY periodo DESC LIMIT 1`,
      [provId, state.sucursalId]
    );
    return r.length && r[0].periodo ? pShift(r[0].periodo, 1) : pNow();
  }

  // ── DATA ──────────────────────────────────────────────────────────────────────

  function searchProvs(q) {
    if (!q?.trim()) return [];
    const like = `%${q.trim()}%`;
    return db().query(
      `SELECT id, razon_social, alias FROM proveedores
       WHERE activo=1 AND COALESCE(tipo_proveedor,'mercaderia')='servicios'
         AND (razon_social LIKE ? OR alias LIKE ?)
       LIMIT 10`,
      [like, like]
    );
  }

  function getHistorial(provId, limit = 8) {
    return db().query(
      `SELECT g.id, g.periodo, g.categoria, g.subcategoria, g.descripcion,
              g.monto, g.metodo_pago, g.comprobante,
              g.subtotal_neto, g.iva_alicuota, g.iva_monto, g.iibb_monto,
              COALESCE((SELECT SUM(p.monto) FROM gastos_pagos p WHERE p.gasto_id=g.id), 0) AS total_pagado
       FROM gastos g
       WHERE g.proveedor_id=? AND g.sucursal_id=?
       ORDER BY COALESCE(g.periodo,'0') DESC, g.rowid DESC
       LIMIT ?`,
      [provId, state.sucursalId, limit]
    );
  }

  function getAllProvServicios() {
    return db().query(
      `SELECT id, razon_social FROM proveedores
       WHERE activo=1 AND COALESCE(tipo_proveedor,'mercaderia')='servicios'
       ORDER BY razon_social COLLATE NOCASE`,
      []
    );
  }

  function getResumenGrid(periodos) {
    if (!periodos.length) return [];
    const ph = periodos.map(() => '?').join(',');
    return db().query(
      `SELECT g.proveedor_id, g.periodo, SUM(g.monto) AS total, COUNT(*) AS n
       FROM gastos g
       JOIN proveedores p ON p.id = g.proveedor_id
       WHERE p.tipo_proveedor='servicios' AND g.sucursal_id=?
         AND g.periodo IN (${ph})
       GROUP BY g.proveedor_id, g.periodo`,
      [state.sucursalId, ...periodos]
    );
  }

  function insertGasto(data) {
    const id  = uid();
    const now = window.SGA_Utils.formatISODate(new Date());
    db().run(
      `INSERT INTO gastos
         (id, sucursal_id, usuario_id, fecha, periodo, categoria, subcategoria,
          descripcion, monto, metodo_pago, comprobante, proveedor_id,
          subtotal_neto, iva_alicuota, iva_monto, iibb_monto,
          sync_status, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
      [
        id, state.sucursalId, state.userId,
        today(), data.periodo,
        data.categoria, data.subcategoria || null,
        data.descripcion || null, data.monto,
        data.metodo_pago || null, data.comprobante || null,
        data.provId,
        data.subtotal_neto || null, data.iva_alicuota || null,
        data.iva_monto || null, data.iibb_monto || null,
        now,
      ]
    );
    return id;
  }

  function insertPagos(gastoId, rows) {
    const now = window.SGA_Utils.formatISODate(new Date());
    rows.forEach(p => {
      const monto = parseFloat(p.monto) || 0;
      if (monto <= 0) return;
      db().run(
        `INSERT INTO gastos_pagos (id, gasto_id, fecha, metodo_pago, monto, sync_status, updated_at)
         VALUES (?,?,?,?,?,'pending',?)`,
        [uid(), gastoId, p.fecha || today(), p.metodo, monto, now]
      );
    });
  }

  function updateGasto(id, data) {
    const now = window.SGA_Utils.formatISODate(new Date());
    db().run(
      `UPDATE gastos SET
         periodo=?, categoria=?, subcategoria=?, descripcion=?, monto=?,
         metodo_pago=?, comprobante=?,
         subtotal_neto=?, iva_alicuota=?, iva_monto=?, iibb_monto=?,
         sync_status='pending', updated_at=?
       WHERE id=? AND sucursal_id=?`,
      [
        data.periodo, data.categoria, data.subcategoria || null,
        data.descripcion || null, data.monto,
        data.metodo_pago || null, data.comprobante || null,
        data.subtotal_neto || null, data.iva_alicuota || null,
        data.iva_monto || null, data.iibb_monto || null,
        now, id, state.sucursalId,
      ]
    );
  }

  function editGastoFromRow(row, tabKey) {
    const s         = state[tabKey];
    const isSueldos = tabKey === 'sueldos';
    s.editingId     = row.id;

    // Highlight the row being edited
    document.querySelectorAll('.gc-hist-table tr[data-gasto-id]').forEach(tr => {
      tr.classList.toggle('gc-row-editing', tr.dataset.gastoId === row.id);
    });

    // Populate form fields
    if (ge('gf-periodo'))    ge('gf-periodo').value    = row.periodo || '';
    if (ge('gf-monto'))      ge('gf-monto').value      = row.monto  || '';
    if (ge('gf-desc'))       ge('gf-desc').value       = row.descripcion  || '';
    if (ge('gf-comprobante')) ge('gf-comprobante').value = row.comprobante || '';

    if (isSueldos) {
      if (ge('gf-subcat')) ge('gf-subcat').value = row.subcategoria || '';
    } else {
      if (ge('gf-categoria')) ge('gf-categoria').value = row.categoria   || '';
      if (ge('gf-metodo'))    ge('gf-metodo').value    = row.metodo_pago || '';

      // Factura A: restore if the row had breakdown data
      if (row.subtotal_neto) {
        const toggle = ge('gf-facta-toggle');
        if (toggle && !toggle.checked) {
          toggle.checked = true;
          toggle.dispatchEvent(new Event('change'));
        }
        setTimeout(() => {
          if (ge('gf-subtotal'))     ge('gf-subtotal').value     = row.subtotal_neto || '';
          if (ge('gf-iva-alicuota')) ge('gf-iva-alicuota').value = row.iva_alicuota  || '';
          if (ge('gf-iva-monto'))    ge('gf-iva-monto').value    = row.iva_monto     || '';
          if (ge('gf-iibb'))         ge('gf-iibb').value         = row.iibb_monto    || '';
          ge('gf-iva-alicuota')?.dispatchEvent(new Event('change'));
        }, 30);
      }
    }

    // Show edit banner
    const banner = ge('gc-edit-banner');
    if (banner) {
      banner.classList.remove('hidden');
      const lbl = ge('gc-edit-label');
      if (lbl) lbl.textContent = `${pLabel(row.periodo)} — ${fmt$(row.monto)}`;
    }

    // Change save button text
    const btn = ge('btn-gc-save');
    if (btn) btn.textContent = 'Guardar cambios';

    // Cancel edit button
    const cancelBtn = ge('btn-gc-cancel-edit');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        s.editingId = null;
        renderProvTab(tabKey);
      };
    }

    // Scroll form into view
    document.querySelector('.gc-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ge('gf-periodo')?.focus();
  }

  function insertPagoSingle(gastoId, fecha, metodo, monto) {
    const now = window.SGA_Utils.formatISODate(new Date());
    db().run(
      `INSERT INTO gastos_pagos (id, gasto_id, fecha, metodo_pago, monto, sync_status, updated_at)
       VALUES (?,?,?,?,?,'pending',?)`,
      [uid(), gastoId, fecha, metodo, monto, now]
    );
  }

  // ── SHARED: PROV TAB (Cargar + Sueldos) ──────────────────────────────────────

  function renderProvTab(tabKey, opts = {}) {
    const isSueldos    = tabKey === 'sueldos';
    const s            = state[tabKey];
    s.editingId        = null;
    const provSelected = !!s.provId;
    const suggested    = opts.periodo || (provSelected ? pSuggested(s.provId) : pNow());
    const histRows     = provSelected ? getHistorial(s.provId) : [];

    // Reset pago rows when rendering fresh (after save or provider change)
    if (isSueldos) {
      s.pagoRows = [{ fecha: today(), metodo: 'transferencia', monto: '' }];
    }

    const autoDesc = provSelected
      ? `Ej: ${esc(s.provNombre)} — ${pLabel(suggested)}`
      : '';

    ge('gastos-content').innerHTML = `
      <div class="gc-wrap">

        <!-- Buscador -->
        <div class="gc-search-row">
          <div class="gc-search-box" id="gc-search-box">
            <span class="gc-search-icon">🔍</span>
            <input type="text" id="gc-prov-inp" class="gc-prov-inp"
              autocomplete="off"
              placeholder="${isSueldos ? 'Buscar empleado / proveedor...' : 'Buscar proveedor de servicios...'}"
              value="${esc(s.provNombre || '')}">
            <div class="gc-dd hidden" id="gc-dd"></div>
          </div>
          ${provSelected ? `<button class="gc-btn-cambiar" id="gc-btn-cambiar">✕ cambiar</button>` : ''}
        </div>

        ${provSelected ? `

          <!-- Historial (top) -->
          <div class="gc-historial">
            <div class="gc-panel-hdr">
              Historial: <strong>${esc(s.provNombre)}</strong>
              <span class="gc-hist-count">${histRows.length} registro${histRows.length !== 1 ? 's' : ''}</span>
            </div>
            ${buildHistorialTable(histRows, isSueldos)}
            <div class="gc-inline-pago hidden" id="gc-inline-pago"></div>
          </div>

          <!-- Formulario (bottom) -->
          <div class="gc-form">
            <div class="gc-panel-hdr">${isSueldos ? 'Registrar Sueldo' : 'Registrar Gasto'}</div>
            <div class="gc-form-grid">

              <div class="gc-field">
                <label>Período</label>
                <select id="gf-periodo" class="gc-select">${pOptions(suggested)}</select>
              </div>

              <div class="gc-field">
                <label>Monto${isSueldos ? ' del sueldo' : ''}</label>
                <input type="number" id="gf-monto" class="gc-input" min="0" step="0.01" placeholder="0,00">
              </div>

              ${isSueldos ? `
                <div class="gc-field">
                  <label>Tipo de sueldo</label>
                  <select id="gf-subcat" class="gc-select">
                    ${SUBCATS.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}
                  </select>
                </div>
                <div class="gc-field"></div>
              ` : `
                <div class="gc-field">
                  <label>Categoría</label>
                  <select id="gf-categoria" class="gc-select">
                    ${CATEGORIAS.filter(c => c.value !== 'sueldos').map(c =>
                      `<option value="${c.value}">${c.label}</option>`
                    ).join('')}
                  </select>
                </div>
                <div class="gc-field">
                  <label>Método de pago</label>
                  <select id="gf-metodo" class="gc-select">
                    ${METODOS.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
                  </select>
                </div>
              `}

              <div class="gc-field">
                <label>N° Comprobante <small>(opc.)</small></label>
                <input type="text" id="gf-comprobante" class="gc-input" placeholder="">
              </div>

              <div class="gc-field ${isSueldos ? '' : 'gc-field-full'}">
                <label>Descripción${isSueldos ? ' <small>(opc.)</small>' : ''}</label>
                <input type="text" id="gf-desc" class="gc-input" placeholder="${autoDesc}">
              </div>

              ${!isSueldos ? `
                <!-- Factura A toggle -->
                <div class="gc-field gc-field-full" style="margin-top:2px">
                  <label class="gc-facta-toggle">
                    <input type="checkbox" id="gf-facta-toggle">
                    Factura A — discriminar subtotal, IVA e IIBB
                  </label>
                </div>
                <!-- Factura A breakdown (hidden by default) -->
                <div class="gc-facta-section hidden" id="gc-facta-section">
                  <div class="gc-field">
                    <label>Subtotal neto</label>
                    <input type="number" id="gf-subtotal" class="gc-input" min="0" step="0.01" placeholder="0,00">
                  </div>
                  <div class="gc-field">
                    <label>Alícuota IVA</label>
                    <select id="gf-iva-alicuota" class="gc-select">
                      ${IVA_OPTS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
                    </select>
                  </div>
                  <div class="gc-field">
                    <label>IVA ($)</label>
                    <input type="number" id="gf-iva-monto" class="gc-input" readonly placeholder="auto">
                  </div>
                  <div class="gc-field">
                    <label>Perc. IIBB ($)</label>
                    <input type="number" id="gf-iibb" class="gc-input" min="0" step="0.01" placeholder="0,00">
                  </div>
                  <div class="gc-facta-total">
                    Total: <strong id="gc-facta-total-val">—</strong>
                  </div>
                </div>
              ` : `
                <!-- Pagos (sueldos) -->
                <div class="gc-pago-section">
                  <div class="gc-pago-section-label">Pago</div>
                  <div id="gc-pago-rows"></div>
                  <button type="button" class="gc-btn-add-pago" id="gc-btn-add-pago">+ Agregar método de pago</button>
                </div>
              `}

            </div>
            <div class="gc-edit-banner hidden" id="gc-edit-banner">
              ✏️ Editando registro — <span id="gc-edit-label"></span>
              <button class="gc-edit-cancel-btn" id="btn-gc-cancel-edit">✕ Cancelar</button>
            </div>
            <div class="gc-error hidden" id="gc-error"></div>
            <div class="gc-form-actions">
              <button class="btn btn-primary" id="btn-gc-save">
                ${isSueldos ? 'Registrar Sueldo' : 'Registrar Gasto'}
              </button>
            </div>
          </div>

        ` : `
          <div class="gc-empty-hint">
            Buscá un proveedor para ver su historial y registrar un gasto
          </div>
        `}
      </div>
    `;

    wireProvSearch(tabKey);

    if (provSelected) {
      if (isSueldos) {
        renderPagoRows(tabKey);
        wirePagoRows(tabKey);
      } else {
        wireFacturaA();
      }
      wireHistorialPago(tabKey);
      ge('btn-gc-save').addEventListener('click', () => doSave(tabKey));
      setTimeout(() => ge('gf-monto')?.focus(), 40);
    } else {
      setTimeout(() => ge('gc-prov-inp')?.focus(), 40);
    }
  }

  // ── PROVIDER SEARCH ───────────────────────────────────────────────────────────

  function wireProvSearch(tabKey) {
    const inp = ge('gc-prov-inp');
    const dd  = ge('gc-dd');
    if (!inp) return;

    inp.addEventListener('input', () => {
      const q = inp.value.trim();
      if (!q) { dd.classList.add('hidden'); return; }
      const results = searchProvs(q);
      dd.innerHTML = results.length
        ? results.map(r =>
            `<div class="gc-dd-item" data-id="${esc(r.id)}" data-nombre="${esc(r.razon_social)}">
              ${esc(r.razon_social)}
              ${r.alias ? `<span class="gc-dd-alias">${esc(r.alias)}</span>` : ''}
            </div>`
          ).join('')
        : `<div class="gc-dd-empty">Sin resultados</div>`;
      dd.classList.remove('hidden');
    });

    dd.addEventListener('mousedown', e => {
      const item = e.target.closest('.gc-dd-item');
      if (!item) return;
      e.preventDefault();
      state[tabKey].provId     = item.dataset.id;
      state[tabKey].provNombre = item.dataset.nombre;
      renderProvTab(tabKey);
    });

    inp.addEventListener('blur', () => { setTimeout(() => dd.classList.add('hidden'), 150); });

    const btnCambiar = ge('gc-btn-cambiar');
    if (btnCambiar) {
      btnCambiar.addEventListener('click', () => {
        state[tabKey].provId     = null;
        state[tabKey].provNombre = null;
        renderProvTab(tabKey);
      });
    }
  }

  // ── FACTURA A ─────────────────────────────────────────────────────────────────

  function wireFacturaA() {
    const toggle  = ge('gf-facta-toggle');
    const section = ge('gc-facta-section');
    const montoEl = ge('gf-monto');
    if (!toggle) return;

    const recalc = () => {
      const sub  = parseFloat(ge('gf-subtotal')?.value) || 0;
      const ali  = parseFloat(ge('gf-iva-alicuota')?.value) || 0;
      const iibb = parseFloat(ge('gf-iibb')?.value) || 0;
      const iva  = sub * ali / 100;
      if (ge('gf-iva-monto')) ge('gf-iva-monto').value = iva > 0 ? iva.toFixed(2) : '';
      const total = sub + iva + iibb;
      if (ge('gc-facta-total-val')) ge('gc-facta-total-val').textContent = total > 0 ? fmt$(total) : '—';
      if (montoEl) montoEl.value = total > 0 ? total.toFixed(2) : '';
    };

    toggle.addEventListener('change', () => {
      const on = toggle.checked;
      section.classList.toggle('hidden', !on);
      montoEl.readOnly = on;
      montoEl.style.background = on ? '' : '';
      if (on) {
        ge('gf-subtotal')?.focus();
        recalc();
      } else {
        montoEl.value = '';
        montoEl.readOnly = false;
        montoEl.focus();
      }
    });

    ['gf-subtotal', 'gf-iva-alicuota', 'gf-iibb'].forEach(id => {
      ge(id)?.addEventListener('input', recalc);
      ge(id)?.addEventListener('change', recalc);
    });
  }

  // ── PAGO ROWS (sueldos) ───────────────────────────────────────────────────────

  function renderPagoRows(tabKey) {
    const container = ge('gc-pago-rows');
    if (!container) return;
    const rows = state[tabKey].pagoRows;
    container.innerHTML = rows.map((r, i) => `
      <div class="gc-pago-row" data-idx="${i}">
        <input type="date" class="gc-input gc-pago-fecha" value="${esc(r.fecha)}" title="Fecha del pago">
        <select class="gc-select gc-pago-metodo">
          ${METODOS.map(m => `<option value="${m.value}"${m.value === r.metodo ? ' selected' : ''}>${m.label}</option>`).join('')}
        </select>
        <input type="number" class="gc-input gc-pago-monto" min="0" step="0.01"
          placeholder="0,00" value="${r.monto}" title="Monto a abonar">
        ${rows.length > 1
          ? `<button class="gc-btn-del-pago" data-idx="${i}" title="Quitar">✕</button>`
          : `<div></div>`}
      </div>
    `).join('');
    wirePagoRows(tabKey);
  }

  function wirePagoRows(tabKey) {
    const container = ge('gc-pago-rows');
    const addBtn    = ge('gc-btn-add-pago');
    if (!container) return;

    container.addEventListener('click', e => {
      const btn = e.target.closest('.gc-btn-del-pago');
      if (!btn) return;
      const idx = parseInt(btn.dataset.idx);
      state[tabKey].pagoRows.splice(idx, 1);
      renderPagoRows(tabKey);
    });

    if (addBtn) {
      // remove old listener by replacing button
      const fresh = addBtn.cloneNode(true);
      addBtn.replaceWith(fresh);
      fresh.addEventListener('click', () => {
        state[tabKey].pagoRows.push({ fecha: today(), metodo: 'transferencia', monto: '' });
        renderPagoRows(tabKey);
      });
    }
  }

  function readPagoRows() {
    const rows = [];
    document.querySelectorAll('.gc-pago-row').forEach(row => {
      rows.push({
        fecha:  row.querySelector('.gc-pago-fecha')?.value  || today(),
        metodo: row.querySelector('.gc-pago-metodo')?.value || 'transferencia',
        monto:  row.querySelector('.gc-pago-monto')?.value  || '0',
      });
    });
    return rows;
  }

  // ── HISTORIAL TABLE ───────────────────────────────────────────────────────────

  function buildHistorialTable(rows, isSueldos) {
    if (!rows.length) return `<div class="gc-hist-empty">Sin registros previos para este proveedor</div>`;
    return `
      <div class="gc-hist-table-wrap">
        <table class="gc-hist-table">
          <thead>
            <tr>
              <th>Período</th>
              <th>Categoría</th>
              <th>Descripción</th>
              <th>Comprobante</th>
              <th class="gc-th-r">Monto</th>
              <th class="gc-th-r">Estado pago</th>
              <th style="width:80px"></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const pendiente = Math.max(0, r.monto - (r.total_pagado || 0));
              const isSueldo  = r.categoria === 'sueldos';
              let badge = '';
              if (isSueldo) {
                if (pendiente < 0.01)       badge = `<span class="gc-pago-badge gc-pago-badge-ok">✓ Pagado</span>`;
                else if (r.total_pagado > 0) badge = `<span class="gc-pago-badge gc-pago-badge-parcial">Parcial — debe ${fmt$(pendiente)}</span>`;
                else                         badge = `<span class="gc-pago-badge gc-pago-badge-none">Sin pago</span>`;
              } else {
                badge = metodoLabel(r.metodo_pago);
              }
              const addPagoBtn = (isSueldo && pendiente > 0.01)
                ? `<button class="gc-btn-add-pago-hist" data-gasto-id="${r.id}" data-pendiente="${pendiente.toFixed(2)}" title="Registrar pago">+ Pago</button>`
                : '';
              const editBtn = `<button class="gc-btn-edit-hist" data-gasto-id="${r.id}" title="Editar">✏️</button>`;
              return `
                <tr data-gasto-id="${r.id}">
                  <td><strong>${pLabel(r.periodo)}</strong></td>
                  <td class="gc-td-cat">
                    ${catLabel(r.categoria)}
                    ${r.subcategoria ? `<br><small>${subcatLabel(r.subcategoria)}</small>` : ''}
                  </td>
                  <td>${esc(r.descripcion || '—')}</td>
                  <td>${esc(r.comprobante || '—')}</td>
                  <td class="gc-td-monto">${fmt$(r.monto)}</td>
                  <td style="text-align:right">${badge}</td>
                  <td style="text-align:right;white-space:nowrap">${addPagoBtn} ${editBtn}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ── INLINE PAGO (from historial) ──────────────────────────────────────────────

  function wireHistorialPago(tabKey) {
    const histEl = document.querySelector('.gc-historial');
    if (!histEl) return;

    histEl.addEventListener('click', e => {
      // + Pago
      const pagoBtn = e.target.closest('.gc-btn-add-pago-hist');
      if (pagoBtn) {
        openInlinePago(pagoBtn.dataset.gastoId, parseFloat(pagoBtn.dataset.pendiente), tabKey);
        return;
      }
      // ✏️ Editar
      const editBtn = e.target.closest('.gc-btn-edit-hist');
      if (editBtn) {
        const gastoId = editBtn.dataset.gastoId;
        const rows    = getHistorial(state[tabKey].provId);
        const row     = rows.find(r => r.id === gastoId);
        if (row) editGastoFromRow(row, tabKey);
      }
    });
  }

  function openInlinePago(gastoId, pendiente, tabKey) {
    const panel = ge('gc-inline-pago');
    if (!panel) return;

    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="gc-inline-pago-hdr">Registrar Pago — saldo pendiente: ${fmt$(pendiente)}</div>
      <div class="gc-inline-pago-row">
        <input type="date" id="ip-fecha" class="gc-input" value="${today()}">
        <select id="ip-metodo" class="gc-select">
          ${METODOS.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
        </select>
        <input type="number" id="ip-monto" class="gc-input" min="0" step="0.01" value="${pendiente.toFixed(2)}" placeholder="0,00">
        <button class="btn btn-primary btn-sm" id="btn-ip-save">Registrar</button>
        <button class="btn btn-secondary btn-sm" id="btn-ip-cancel">Cancelar</button>
      </div>
      <div class="gc-inline-saldo">El monto a abonar puede ser menor al saldo pendiente (pago parcial)</div>
    `;

    ge('btn-ip-cancel').addEventListener('click', () => {
      panel.classList.add('hidden');
      panel.innerHTML = '';
    });

    ge('btn-ip-save').addEventListener('click', () => {
      const fecha  = ge('ip-fecha').value;
      const metodo = ge('ip-metodo').value;
      const monto  = parseFloat(ge('ip-monto').value) || 0;
      if (monto <= 0) { ge('ip-monto').focus(); return; }
      try {
        insertPagoSingle(gastoId, fecha, metodo, monto);
        window.SGA_Utils.showNotification('Pago registrado', 'success');
        renderProvTab(tabKey, {});
      } catch(e) {
        window.SGA_Utils.showNotification('Error: ' + e.message, 'error');
      }
    });

    setTimeout(() => ge('ip-monto')?.select(), 40);
  }

  // ── SAVE ──────────────────────────────────────────────────────────────────────

  function doSave(tabKey) {
    const isSueldos  = tabKey === 'sueldos';
    const s          = state[tabKey];
    const periodo    = ge('gf-periodo')?.value;
    const monto      = parseFloat(ge('gf-monto')?.value);
    const desc       = (ge('gf-desc')?.value || '').trim();
    const categoria  = isSueldos ? 'sueldos' : (ge('gf-categoria')?.value || '');
    const subcategoria = isSueldos ? (ge('gf-subcat')?.value || null) : null;
    const comprobante  = (ge('gf-comprobante')?.value || '').trim();

    const errEl = ge('gc-error');
    const fail  = msg => { errEl.textContent = msg; errEl.classList.remove('hidden'); ge('gc-error').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };

    if (!periodo)             return fail('Seleccioná un período');
    if (!monto || monto <= 0) return fail('El monto debe ser mayor a 0');
    if (!isSueldos && !desc)  return fail('Ingresá una descripción');

    errEl.classList.add('hidden');

    // Factura A fields (solo cargar)
    let subtotal_neto = null, iva_alicuota = null, iva_monto = null, iibb_monto = null;
    const factaOn = ge('gf-facta-toggle')?.checked;
    if (factaOn) {
      subtotal_neto = parseFloat(ge('gf-subtotal')?.value) || null;
      iva_alicuota  = ge('gf-iva-alicuota')?.value || null;
      iva_monto     = parseFloat(ge('gf-iva-monto')?.value) || null;
      iibb_monto    = parseFloat(ge('gf-iibb')?.value) || null;
    }

    // Metodo pago: solo cargar (sueldos usa pago rows)
    const metodo_pago = !isSueldos ? (ge('gf-metodo')?.value || null) : null;

    try {
      const data = {
        provId: s.provId, periodo, categoria, subcategoria,
        descripcion: desc, monto, metodo_pago, comprobante,
        subtotal_neto, iva_alicuota, iva_monto, iibb_monto,
      };

      if (s.editingId) {
        // ── EDICIÓN ──
        updateGasto(s.editingId, data);
        window.SGA_Utils.showNotification('Cambios guardados', 'success');
        renderProvTab(tabKey);
      } else {
        // ── NUEVO ──
        const gastoId = insertGasto(data);
        if (isSueldos) {
          const pagoRows = readPagoRows().filter(p => parseFloat(p.monto) > 0);
          if (pagoRows.length) insertPagos(gastoId, pagoRows);
        }
        window.SGA_Utils.showNotification(isSueldos ? 'Sueldo registrado' : 'Gasto registrado', 'success');
        renderProvTab(tabKey, { periodo: pShift(periodo, 1) });
      }
    } catch (e) {
      fail('Error: ' + e.message);
    }
  }

  // ── SEGUIMIENTO ───────────────────────────────────────────────────────────────

  function renderSeguimiento() {
    const NUM_MESES = 12;
    const meses = [];
    for (let i = NUM_MESES - 1; i >= 0; i--) meses.push(pShift(pNow(), -i));

    const provs   = getAllProvServicios();
    const resumen = getResumenGrid(meses);

    const idx = {};
    resumen.forEach(g => { idx[`${g.proveedor_id}|${g.periodo}`] = g; });

    const now = pNow();

    const colHeaders = meses.map(p =>
      `<th class="gc-seg-th${p === now ? ' gc-seg-th-cur' : ''}">${pLabel(p)}</th>`
    ).join('');

    const rows = provs.map(p => {
      const cells = meses.map(periodo => {
        const g = idx[`${p.id}|${periodo}`];
        if (g) {
          return `<td class="gc-seg-cell gc-seg-ok"
                    data-pid="${p.id}" data-periodo="${periodo}"
                    title="${pLabel(periodo)} · ${fmt$(g.total)}${g.n > 1 ? ` (${g.n} registros)` : ''}">
                    <span class="gc-seg-val">${fmt$(g.total)}</span>
                  </td>`;
        }
        const isPast = periodo < now;
        return `<td class="gc-seg-cell ${isPast ? 'gc-seg-miss' : 'gc-seg-open'}"
                  data-pid="${p.id}" data-periodo="${periodo}"
                  title="${isPast ? '⚠ Sin registro — ' : ''}${pLabel(periodo)}">
                  <span class="gc-seg-plus">+</span>
                </td>`;
      }).join('');
      return `<tr><td class="gc-seg-prov">${esc(p.razon_social)}</td>${cells}</tr>`;
    }).join('');

    if (!provs.length) {
      ge('gastos-content').innerHTML = `
        <div class="gastos-empty">
          No hay proveedores de servicios.<br>
          Creá proveedores con tipo "Gastos y Servicios" para verlos aquí.
        </div>`;
      return;
    }

    ge('gastos-content').innerHTML = `
      <div class="gc-seg-wrap">
        <div class="gc-seg-legend">
          <span class="gc-leg gc-leg-ok">Con registro</span>
          <span class="gc-leg gc-leg-miss">Falta registro</span>
          <span class="gc-leg gc-leg-open">Período abierto</span>
          <span style="margin-left:auto;font-size:11px;color:var(--color-text-secondary)">
            Hacé click en una celda para cargar o ver el gasto
          </span>
        </div>
        <div class="gc-seg-table-wrap">
          <table class="gc-seg-table">
            <thead>
              <tr>
                <th class="gc-seg-prov-th">Proveedor</th>
                ${colHeaders}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    ge('gastos-content').addEventListener('click', e => {
      const cell = e.target.closest('.gc-seg-cell');
      if (!cell) return;
      const prov = provs.find(p => p.id === cell.dataset.pid);
      if (!prov) return;
      state.cargar.provId     = cell.dataset.pid;
      state.cargar.provNombre = prov.razon_social;
      switchTab('cargar', { periodo: cell.dataset.periodo });
    });
  }

  // ── LABEL HELPERS ─────────────────────────────────────────────────────────────

  function catLabel(v)    { return CATEGORIAS.find(c => c.value === v)?.label || v || '—'; }
  function subcatLabel(v) { return SUBCATS.find(s => s.value === v)?.label    || v || ''; }
  function metodoLabel(v) { return METODOS.find(m => m.value === v)?.label    || v || '—'; }

  // ── TAB SWITCH ────────────────────────────────────────────────────────────────

  function switchTab(tab, opts = {}) {
    state.tab = tab;
    document.querySelectorAll('.gastos-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    if (tab === 'cargar')      renderProvTab('cargar', opts);
    if (tab === 'seguimiento') renderSeguimiento();
    if (tab === 'sueldos')     renderProvTab('sueldos', opts);
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────

  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    state.sucursalId = user?.sucursal_id || '1';
    state.userId     = user?.id;
    state.cargar     = { provId: null, provNombre: null, editingId: null };
    state.sueldos    = { provId: null, provNombre: null, pagoRows: [], editingId: null };

    ge('gastos-root').innerHTML = `
      <div class="gastos-header">
        <h2>💸 Gastos Generales</h2>
      </div>
      <div class="gastos-tabs">
        <button class="gastos-tab active" data-tab="cargar">Cargar Gasto</button>
        <button class="gastos-tab" data-tab="seguimiento">Seguimiento</button>
        <button class="gastos-tab" data-tab="sueldos">Sueldos</button>
      </div>
      <div id="gastos-content"></div>
    `;

    document.querySelectorAll('.gastos-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    renderProvTab('cargar');
  }

  return { init };
})();

export default Gastos;
