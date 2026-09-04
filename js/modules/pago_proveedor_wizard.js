'use strict';

/**
 * Wizard de PAGO A PROVEEDOR.
 *
 * Se llega al mismo pago desde dos lados —Caja > Efectivo > Egresos e Ingresos
 * y Proveedores > Cuenta Corriente— y hasta ahora cada boton abria una pantalla
 * distinta: la de Caja era una version recortada (solo efectivo, imputacion
 * automatica, fecha fija). Los dos escribian bien, con el mismo crearPago(),
 * pero no ofrecian lo mismo. Se unifico en este wizard, que es el completo.
 *
 * Vivia dentro de cuenta_corriente_proveedores.js y dependia del overlay y del
 * CSS de esa pantalla; aca se trae los dos consigo para poder abrirse desde
 * cualquier lugar.
 *
 * Expone window.SGA_PagoProveedorWizard.
 */

const SGA_PagoProveedorWizard = (() => {

  const ge     = id => document.getElementById(id);
  const esc    = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                     .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt$   = n => window.SGA_Utils.formatCurrency(n);
  const today  = () => new Date().toISOString().slice(0, 10);
  const fmtFecha = f => {
    if (!f) return '—';
    const [y, m, d] = String(f).slice(0, 10).split('-');
    return d && m && y ? `${d}/${m}/${y}` : f;
  };

  // ── CSS y overlay propios ──────────────────────────────────────────────────
  const STYLE_ID   = 'sga-pagoprov-css';
  const OVERLAY_ID = 'sga-pagoprov-overlay';

  const CSS = `
  .ccprov-credito-alert {
    margin: 8px 20px 0;
    background: #e3f2fd;
    border: 1px solid #90caf9;
    border-radius: var(--radius-md);
    padding: 10px 16px;
    font-size: 13px;
    color: #1565c0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .ccprov-btn-primary {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 8px 16px;
    background: var(--color-primary);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
    white-space: nowrap;
  }
  .ccprov-btn-primary:hover { opacity: 0.88; }
  .ccprov-btn-secondary {
    padding: 8px 16px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: 14px;
    cursor: pointer;
    transition: background 0.1s;
    white-space: nowrap;
  }
  .ccprov-btn-secondary:hover { background: var(--color-border); }
  .ccprov-modal {
    background: var(--color-background);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 580px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
  }
  .ccprov-modal-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--color-border);
    font-size: 1rem;
    font-weight: 700;
    flex-shrink: 0;
  }
  .ccprov-modal-close {
    background: none;
    border: none;
    font-size: 18px;
    cursor: pointer;
    color: var(--color-text-secondary);
    padding: 2px 6px;
    line-height: 1;
  }
  .ccprov-modal-close:hover { color: var(--color-text); }
  .ccprov-modal-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    flex: 1;
    overflow-y: auto;
  }
  .ccprov-modal-ftr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .ccprov-modal-ftr-right { display: flex; gap: 10px; }
  .ccprov-field { display: flex; flex-direction: column; gap: 5px; }
  .ccprov-field label { font-size: 13px; font-weight: 600; color: var(--color-text); }
  .ccprov-field-row { display: flex; gap: 12px; }
  .ccprov-field-row .ccprov-field { flex: 1; min-width: 0; }
  .ccprov-input {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 8px 10px;
    font-size: 14px;
    width: 100%;
    box-sizing: border-box;
    background: var(--color-background);
    color: var(--color-text);
  }
  .ccprov-input:focus { outline: 2px solid var(--color-primary); border-color: transparent; }
  .ccprov-input:disabled { background: var(--color-surface); color: var(--color-text-secondary); }
  .ccprov-section-title {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: var(--color-text-secondary);
    font-weight: 700;
    margin: 0 0 8px;
  }
  .ccprov-metodo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    margin-bottom: 6px;
  }
  .ccprov-metodo-row.active { border-color: var(--color-primary); background: var(--color-primary-light, #e8f0fe); }
  .ccprov-metodo-check { width: 16px; height: 16px; flex-shrink: 0; cursor: pointer; accent-color: var(--color-primary); }
  .ccprov-metodo-label { font-size: 13px; font-weight: 600; min-width: 100px; flex-shrink: 0; }
  .ccprov-metodo-inputs { display: flex; gap: 8px; flex: 1; align-items: center; }
  .ccprov-metodo-inputs .ccprov-input { flex: 1; }
  .ccprov-metodo-ref { flex: 1.5 !important; }
  .ccprov-total-row {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
    font-size: 15px;
    font-weight: 700;
    padding: 2px 4px;
  }
  .ccprov-total-monto { font-size: 1.3rem; color: var(--color-primary); }
  .ccprov-imp-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }
  .ccprov-imp-toggle input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--color-primary); cursor: pointer; }
  .ccprov-pending-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-top: 8px;
  }
  .ccprov-pending-table th {
    padding: 7px 8px;
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .03em;
    color: var(--color-text-secondary);
    border-bottom: 2px solid var(--color-border);
    font-weight: 600;
  }
  .ccprov-pending-table th.right { text-align: right; }
  .ccprov-pending-table td { padding: 7px 8px; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
  .ccprov-pending-table td.right { text-align: right; font-variant-numeric: tabular-nums; }
  .ccprov-imp-amount {
    width: 110px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    font-size: 13px;
    text-align: right;
    box-sizing: border-box;
    background: var(--color-background);
    color: var(--color-text);
  }
  .ccprov-imp-amount:focus { outline: 2px solid var(--color-primary); border-color: transparent; }
  .ccprov-imp-amount:disabled { background: var(--color-surface); color: var(--color-text-secondary); }
  .ccprov-sobrante {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-radius: var(--radius-md);
    font-size: 13px;
    background: #e3f2fd;
    border: 1px solid #90caf9;
    color: #1565c0;
  }
  .ccprov-sobrante.warn {
    background: #fff3e0;
    border-color: #ffcc80;
    color: #e65100;
  }
  .ccprov-error {
    color: var(--color-danger);
    font-size: 13px;
    padding: 6px 10px;
    background: #ffebee;
    border-radius: var(--radius-sm);
    border: 1px solid #ffcdd2;
    display: none;
  }
  .ccprov-error.visible { display: block; }
  #${OVERLAY_ID} {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    z-index: 700; display: flex; align-items: center; justify-content: center;
  }
  #${OVERLAY_ID}.hidden { display: none; }
`;

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function ensureOverlay() {
    let ov = document.getElementById(OVERLAY_ID);
    if (!ov) {
      ov = document.createElement('div');
      ov.id = OVERLAY_ID;
      ov.className = 'hidden';
      document.body.appendChild(ov);
    }
    return ov;
  }

  function abrir({ proveedorId = null, proveedorNombre = '', onSaved = null } = {}) {
    ensureCss();
    const overlay = ensureOverlay();

    const user = window.SGA_Auth?.getCurrentUser?.();
    const sesion = user?.sucursal_id
      ? window.SGA_PagosProveedores.getSesionActiva(user.sucursal_id)
      : null;

    // Obtener proveedores para selector
    const proveedores = window.SGA_DB.query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 ORDER BY razon_social COLLATE NOCASE ASC`
    );

    const selProvOpts = proveedores.map(p =>
      `<option value="${esc(p.id)}" ${p.id === proveedorId ? 'selected' : ''}>${esc(p.razon_social)}</option>`
    ).join('');

    overlay.innerHTML = `
      <div class="ccprov-modal">
        <div class="ccprov-modal-hdr">
          <span>💳 Registrar Pago a Proveedor</span>
          <button class="ccprov-modal-close" id="btn-modal-close" aria-label="Cerrar" title="Cerrar">✕</button>
        </div>
        <div class="ccprov-modal-body">

          <!-- PROVEEDOR + FECHA -->
          <div class="ccprov-field-row">
            <div class="ccprov-field" style="flex:2">
              <label>Proveedor <span style="color:var(--color-danger)">*</span></label>
              <select class="ccprov-input" id="mp-proveedor">
                <option value="">— Seleccionar —</option>
                ${selProvOpts}
              </select>
            </div>
            <div class="ccprov-field" style="flex:1">
              <label>Fecha</label>
              <input type="date" class="ccprov-input" id="mp-fecha" value="${today()}">
            </div>
          </div>

          <div class="ccprov-field">
            <label>Observaciones</label>
            <input type="text" class="ccprov-input" id="mp-obs" placeholder="Factura, descripción, etc.">
          </div>

          <!-- MÉTODOS DE PAGO -->
          <div>
            <p class="ccprov-section-title">Formas de pago</p>

            <div class="ccprov-metodo-row" id="row-efectivo">
              <input type="checkbox" class="ccprov-metodo-check" id="chk-efectivo">
              <span class="ccprov-metodo-label">💵 Efectivo</span>
              <div class="ccprov-metodo-inputs">
                <input type="number" class="ccprov-input" id="mp-ef-monto"
                  placeholder="$ 0,00" min="0" step="0.01"
                  ${!sesion ? 'disabled title="No hay caja abierta"' : ''}>
                ${!sesion ? '<span style="font-size:12px;color:#999">Sin caja abierta</span>' : ''}
              </div>
            </div>

            <div class="ccprov-metodo-row" id="row-transferencia">
              <input type="checkbox" class="ccprov-metodo-check" id="chk-transferencia">
              <span class="ccprov-metodo-label">🏦 Transferencia</span>
              <div class="ccprov-metodo-inputs">
                <input type="number" class="ccprov-input" id="mp-tr-monto" placeholder="$ 0,00" min="0" step="0.01">
                <input type="text" class="ccprov-input ccprov-metodo-ref" id="mp-tr-ref" placeholder="Nro. comprobante (opcional)">
              </div>
            </div>

            ${window.ADMIN_MODE ? `
            <div class="ccprov-metodo-row" id="row-caja-seamus">
              <input type="checkbox" class="ccprov-metodo-check" id="chk-caja-seamus">
              <span class="ccprov-metodo-label">💼 Caja Seamus</span>
              <div class="ccprov-metodo-inputs">
                <input type="number" class="ccprov-input" id="mp-cs-monto" placeholder="$ 0,00" min="0" step="0.01">
              </div>
            </div>` : ''}

            <div class="ccprov-total-row">
              <span>Total del pago:</span>
              <span class="ccprov-total-monto" id="mp-total">$ 0,00</span>
            </div>
          </div>

          <!-- IMPUTACIÓN -->
          <div id="mp-imp-section">
            <p class="ccprov-section-title">Aplicar a comprobantes</p>
            <div id="mp-imp-content">
              <span style="font-size:13px;color:var(--color-text-secondary)">
                Seleccioná un proveedor para ver sus comprobantes pendientes.
              </span>
            </div>
          </div>

          <!-- SOBRANTE / PREVIEW -->
          <div id="mp-sobrante-wrap" style="display:none"></div>

          <!-- ERROR -->
          <div class="ccprov-error" id="mp-error"></div>

        </div>
        <div class="ccprov-modal-ftr">
          <span style="font-size:12px;color:var(--color-text-secondary)" id="mp-sesion-info">
            ${sesion ? '✅ Caja abierta' : '⚠️ Sin caja — los pagos en efectivo no estarán disponibles'}
          </span>
          <div class="ccprov-modal-ftr-right">
            <button class="ccprov-btn-secondary" id="btn-modal-cancel">Cancelar</button>
            <button class="ccprov-btn-primary" id="btn-modal-guardar">Guardar pago</button>
          </div>
        </div>
      </div>
    `;

    overlay.classList.remove('hidden');

    // ── Estado del modal ──────────────────────────────────────────────────────
    let autoImputar = true;
    let comprasPendientes = [];

    // ── Helpers ───────────────────────────────────────────────────────────────
    const close = () => {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    };
    const getTotal = () => {
      let t = 0;
      if (ge('chk-efectivo').checked) t += parseFloat(ge('mp-ef-monto').value) || 0;
      if (ge('chk-transferencia').checked) t += parseFloat(ge('mp-tr-monto').value) || 0;
      if (ge('chk-caja-seamus')?.checked) t += parseFloat(ge('mp-cs-monto')?.value) || 0;
      return t;
    };
    const showError = msg => {
      const el = ge('mp-error');
      el.textContent = msg;
      el.classList.add('visible');
    };
    const clearError = () => ge('mp-error').classList.remove('visible');

    // ── Actualizar total + sobrante ───────────────────────────────────────────
    // onTotalChanged: hook for renderImpSection to react when total changes
    let onTotalChanged = null;

    const updateTotal = () => {
      const total = getTotal();
      ge('mp-total').textContent = fmt$(total);
      updateSobrante(total);
      if (onTotalChanged) onTotalChanged(total);
    };

    const updateSobrante = (total) => {
      const wrap = ge('mp-sobrante-wrap');
      if (total <= 0) { wrap.style.display = 'none'; return; }

      if (autoImputar) {
        const provId = ge('mp-proveedor').value;
        if (!provId) { wrap.style.display = 'none'; return; }
        // Calcular cuánto quedaría sin imputar
        let restante = total;
        for (const c of comprasPendientes) {
          if (restante <= 0.01) break;
          restante -= Math.min(restante, c.saldo);
        }
        if (restante > 0.01) {
          wrap.style.display = '';
          wrap.innerHTML = `<div class="ccprov-sobrante">
            💡 Quedarán <strong>${fmt$(restante)}</strong> como crédito a favor (pago adelantado)
          </div>`;
        } else {
          wrap.style.display = 'none';
        }
      } else {
        // Manual: calcular diferencia entre total pago y suma de montos manuales
        let imputado = 0;
        document.querySelectorAll('.imp-monto-input').forEach(inp => {
          imputado += parseFloat(inp.value) || 0;
        });
        const diff = total - imputado;
        if (Math.abs(diff) > 0.01) {
          wrap.style.display = '';
          wrap.innerHTML = `<div class="ccprov-sobrante ${diff < 0 ? 'warn' : ''}">
            ${diff > 0
              ? `💡 Quedarán <strong>${fmt$(diff)}</strong> sin imputar (crédito a favor)`
              : `⚠️ Los montos imputados superan el total del pago en <strong>${fmt$(Math.abs(diff))}</strong>`}
          </div>`;
        } else {
          wrap.style.display = 'none';
        }
      }
    };

    // ── Render sección imputación ─────────────────────────────────────────────
    const renderImpSection = () => {
      const provId = ge('mp-proveedor').value;
      const cont = ge('mp-imp-content');
      if (!provId) {
        cont.innerHTML = `<span style="font-size:13px;color:var(--color-text-secondary)">Seleccioná un proveedor.</span>`;
        return;
      }

      comprasPendientes = window.SGA_PagosProveedores.getComprasPendientes(provId);
      const creditos = window.SGA_PagosProveedores.getCreditosDisponibles(provId);
      const totalCredito = creditos.reduce((s, c) => s + c.credito_disponible, 0);

      let html = '';

      if (totalCredito > 0.01) {
        html += `<div class="ccprov-credito-alert" style="margin:0 0 10px">
          💡 Crédito disponible sin imputar: <strong>${fmt$(totalCredito)}</strong>
        </div>`;
      }

      if (!comprasPendientes.length) {
        html += `<div style="font-size:13px;color:var(--color-text-secondary);padding:8px 0">
          ✅ Este proveedor no tiene comprobantes pendientes. El pago quedará como crédito a favor.
        </div>`;
        cont.innerHTML = html;
        updateSobrante(getTotal());
        return;
      }

      html += `
        <label class="ccprov-imp-toggle" style="margin-bottom:10px">
          <input type="checkbox" id="chk-auto-imputar" ${autoImputar ? 'checked' : ''}>
          Aplicar automáticamente por antigüedad
        </label>

        <table class="ccprov-pending-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Comprobante</th>
              <th class="right">Total</th>
              <th class="right">Saldo</th>
              <th class="right">Imputar</th>
            </tr>
          </thead>
          <tbody>
            ${comprasPendientes.map((c, idx) => {
              // Un gasto no tiene punto de venta ni numero de factura: se lo
              // identifica por su comprobante o, si no tiene, su descripcion.
              const esGasto = c.tipo === 'gasto';
              const ref = esGasto
                ? (c.numero_factura || c.descripcion || 'Gasto')
                : ([c.factura_pv, c.numero_factura].filter(Boolean).join('-') || c.id.slice(-6).toUpperCase());
              return `
              <tr>
                <td>${fmtFecha(c.fecha)}</td>
                <td>${esc(ref)}${esGasto ? ' <span style="font-size:11px;color:#8090a0">(gasto)</span>' : ''}</td>
                <td class="right">${fmt$(c.total)}</td>
                <td class="right" style="color:#e65100;font-weight:600">${fmt$(c.saldo)}</td>
                <td class="right">
                  <input type="number" class="ccprov-imp-amount imp-monto-input"
                    data-idx="${idx}"
                    data-saldo="${c.saldo}"
                    data-compra-id="${esc(c.id)}"
                    data-tipo="${esc(c.tipo || 'compra')}"
                    placeholder="${autoImputar ? '' : '0,00'}"
                    min="0" max="${c.saldo}" step="0.01"
                    ${autoImputar ? 'disabled' : ''}>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `;

      cont.innerHTML = html;

      // Calcula cuánto le corresponde a cada comprobante según oldest-first con el total actual
      const calcAutoMontos = (total) => {
        let restante = total;
        return comprasPendientes.map(c => {
          if (restante <= 0.01) return 0;
          const monto = Math.min(restante, c.saldo);
          restante -= monto;
          return monto;
        });
      };

      // Pobla los inputs con los montos calculados (auto) o los vacía (manual)
      const syncInputValues = () => {
        const inputs = document.querySelectorAll('.imp-monto-input');
        if (autoImputar) {
          const montos = calcAutoMontos(getTotal());
          inputs.forEach((inp, i) => {
            inp.value = montos[i] > 0.001 ? montos[i].toFixed(2) : '';
            inp.disabled = true;
            inp.placeholder = '';
          });
        } else {
          inputs.forEach(inp => {
            inp.value = '';
            inp.disabled = false;
            inp.placeholder = '0,00';
          });
        }
      };

      // Populate initial values if auto is on
      syncInputValues();

      // Toggle auto/manual
      ge('chk-auto-imputar').addEventListener('change', e => {
        autoImputar = e.target.checked;
        syncInputValues();
        updateSobrante(getTotal());
      });

      // Re-calculate auto distribution whenever total changes
      onTotalChanged = () => { if (autoImputar) syncInputValues(); };

      // Actualizar sobrante al cambiar montos manuales
      cont.querySelectorAll('.imp-monto-input').forEach(inp => {
        inp.addEventListener('input', () => updateSobrante(getTotal()));
      });

      updateSobrante(getTotal());
    };

    // ── Checkbox handlers ─────────────────────────────────────────────────────
    const syncCheckboxStyle = (id, rowId) => {
      const checked = ge(id).checked;
      ge(rowId).classList.toggle('active', checked);
    };

    ge('chk-efectivo').addEventListener('change', () => {
      syncCheckboxStyle('chk-efectivo', 'row-efectivo');
      updateTotal();
    });
    ge('chk-transferencia').addEventListener('change', () => {
      syncCheckboxStyle('chk-transferencia', 'row-transferencia');
      updateTotal();
    });
    ge('chk-caja-seamus')?.addEventListener('change', () => {
      syncCheckboxStyle('chk-caja-seamus', 'row-caja-seamus');
      updateTotal();
    });
    ge('mp-ef-monto').addEventListener('input', updateTotal);
    ge('mp-tr-monto').addEventListener('input', updateTotal);

    // ── Proveedor change ──────────────────────────────────────────────────────
    ge('mp-proveedor').addEventListener('change', () => {
      renderImpSection();
      updateTotal();
    });

    // Render inicial si ya había proveedor
    if (proveedorId) renderImpSection();

    // ── Close handlers ────────────────────────────────────────────────────────
    ge('btn-modal-close').addEventListener('click', close);
    ge('btn-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // ── Guardar ───────────────────────────────────────────────────────────────
    ge('btn-modal-guardar').addEventListener('click', () => {
      clearError();

      const provId = ge('mp-proveedor').value;
      if (!provId) { showError('Seleccioná un proveedor.'); return; }

      const total = getTotal();
      if (total <= 0) { showError('Ingresá al menos un monto.'); return; }

      // Construir metodos
      const metodos = [];
      if (ge('chk-efectivo').checked) {
        const monto = parseFloat(ge('mp-ef-monto').value) || 0;
        if (monto > 0) {
          metodos.push({
            metodo: 'efectivo',
            monto,
            sesion_caja_id: sesion?.id || null,
          });
        }
      }
      if (ge('chk-transferencia').checked) {
        const monto = parseFloat(ge('mp-tr-monto').value) || 0;
        if (monto > 0) {
          metodos.push({
            metodo: 'transferencia',
            monto,
            referencia: ge('mp-tr-ref').value.trim() || null,
          });
        }
      }
      if (ge('chk-caja-seamus')?.checked) {
        const monto = parseFloat(ge('mp-cs-monto')?.value) || 0;
        if (monto > 0) metodos.push({ metodo: 'caja_seamus', monto, referencia: null });
      }
      if (!metodos.length) { showError('Ingresá al menos un monto.'); return; }

      // Construir imputaciones
      let imputaciones;
      if (!autoImputar) {
        imputaciones = [];
        document.querySelectorAll('.imp-monto-input').forEach(inp => {
          const monto = parseFloat(inp.value) || 0;
          if (monto > 0) {
            // El tipo define si la imputacion se guarda en compra_id o en
            // gasto_id: sin esto, imputar contra un gasto lo dejaba apuntando
            // a una compra que no existe y el gasto seguia impago.
            const tipo = inp.dataset.tipo || 'compra';
            imputaciones.push(tipo === 'gasto'
              ? { gasto_id: inp.dataset.compraId, tipo, monto }
              : { compra_id: inp.dataset.compraId, tipo, monto });
          }
        });
        // Validar que no superen el saldo de cada compra
        for (const inp of document.querySelectorAll('.imp-monto-input')) {
          const monto = parseFloat(inp.value) || 0;
          const saldo = parseFloat(inp.dataset.saldo) || 0;
          if (monto > saldo + 0.01) {
            showError(`El monto imputado no puede superar el saldo del comprobante.`);
            return;
          }
        }
      }

      const result = window.SGA_PagosProveedores.crearPago({
        proveedor_id: provId,
        fecha: ge('mp-fecha').value || today(),
        observaciones: ge('mp-obs').value.trim() || null,
        usuario_id: user?.id || null,
        metodos,
        imputaciones,
        auto_imputar: autoImputar,
      });

      if (!result.success) {
        showError('Error al guardar: ' + result.error);
        return;
      }

      close();

      // Quien abrio el wizard refresca su propia pantalla: cuenta corriente
      // redibuja el detalle del proveedor, caja vuelve a su listado de egresos.
      if (typeof onSaved === 'function') {
        try { onSaved(result, provId); } catch (e) { console.warn('onSaved:', e); }
      }

      // Toast
      if (window.SGA_Utils?.showToast) {
        const sobrante = result.credito_sobrante || 0;
        const msg = sobrante > 0.01
          ? `Pago registrado. Crédito disponible: ${fmt$(sobrante)}`
          : 'Pago registrado correctamente.';
        window.SGA_Utils.showToast(msg, 'success');
      }
    });
  }

  return { abrir, ensureCss };
})();

window.SGA_PagoProveedorWizard = SGA_PagoProveedorWizard;

export default SGA_PagoProveedorWizard;
