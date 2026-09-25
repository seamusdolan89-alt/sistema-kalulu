'use strict';

/**
 * Wizard de NOTA DE CRÉDITO DE PROVEEDOR.
 *
 * Una NC es un crédito a favor con el proveedor (devolución de mercadería,
 * descuento, error de precio...). Se guarda como un pago de método
 * 'nota_credito' (SGA_PagosProveedores.crearNotaCredito): por eso el saldo, el
 * crédito disponible, "Imputar…" y el ledger la entienden igual que a un pago, y
 * se puede aplicar a una factura.
 *
 * Un solo formulario para las dos cosas:
 *   - líneas de PRODUCTO devuelto (bajan el stock, salvo que se destilde "Baja stock");
 *   - líneas de CONCEPTO (descuento / bonificación: solo plata).
 * Si la NC es "A", discrimina IVA (10,5 / 21) y suma percepciones / imp. interno;
 * el total se puede corregir a mano para que coincida con el comprobante real.
 * No toca costos ni precios de ningún producto.
 *
 * Se abre desde Cuentas Corrientes ("+ Registrar NC") y desde el Historial de
 * compras (con la factura de referencia ya elegida).
 *
 * Expone window.SGA_NotaCreditoWizard.
 */

import PagoWizard from './pago_proveedor_wizard.js';
import './buscador_productos.js';

const SGA_NotaCreditoWizard = (() => {

  const ge   = id => document.getElementById(id);
  const esc  = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                   .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);
  const today = () => new Date().toISOString().slice(0, 10);
  const num  = v => parseFloat(v) || 0;
  const fmtFecha = f => {
    if (!f) return '—';
    const [y, m, d] = String(f).slice(0, 10).split('-');
    return d && m && y ? `${d}/${m}/${y}` : f;
  };

  const STYLE_ID   = 'sga-notacredito-css';
  const OVERLAY_ID = 'sga-notacredito-overlay';

  const CSS = `
  #${OVERLAY_ID} {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    z-index: 720; display: flex; align-items: center; justify-content: center; padding: 12px;
  }
  #${OVERLAY_ID}.hidden { display: none; }
  #${OVERLAY_ID} .ccprov-modal { max-width: 860px; }
  .ncw-lineas { width: 100%; border-collapse: collapse; font-size: 13px; }
  .ncw-lineas th {
    padding: 6px 6px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .03em;
    color: var(--color-text-secondary); border-bottom: 2px solid var(--color-border); font-weight: 600;
  }
  .ncw-lineas th.r, .ncw-lineas td.r { text-align: right; }
  .ncw-lineas td { padding: 5px 6px; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
  .ncw-lineas input[type=number], .ncw-lineas input[type=text], .ncw-lineas select {
    border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 4px 6px; font-size: 13px;
    box-sizing: border-box; background: var(--color-background); color: var(--color-text);
  }
  .ncw-lineas input[type=number] { width: 84px; text-align: right; }
  .ncw-lineas .ncw-concepto { width: 100%; min-width: 160px; }
  .ncw-sin-lineas { padding: 10px 6px; color: var(--color-text-secondary); font-size: 13px; }
  .ncw-del { background: none; border: none; color: #c62828; cursor: pointer; font-size: 15px; padding: 2px 6px; }
  .ncw-buscador { position: relative; }
  .ncw-dd {
    position: absolute; left: 0; right: 0; top: 100%; z-index: 30; display: none; max-height: 220px; overflow-y: auto;
    background: var(--color-background); border: 1px solid var(--color-border); border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
  }
  .ncw-dd .sri { padding: 8px 12px; cursor: pointer; display: flex; justify-content: space-between; gap: 10px;
    border-bottom: 1px solid var(--color-border); font-size: 13px; }
  .ncw-dd .sri:hover, .ncw-dd .sri.ncw-hl { background: var(--color-primary-light, #e8f0fe); }
  .ncw-dd .sri-left { display: flex; flex-direction: column; gap: 1px; }
  .ncw-dd .sri-codigo { font-size: 11px; color: var(--color-text-secondary); }
  .ncw-dd .sri-stock-warn { font-size: 11px; color: #c62828; }
  .ncw-fiscal { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .ncw-fiscal .ccprov-field label { font-size: 12px; }
  .ncw-fiscal .ncw-solo-a { display: none; }
  .ncw-es-a .ncw-solo-a { display: flex; }
  .ncw-lineas .ncw-col-iva { display: none; }
  .ncw-es-a .ncw-lineas .ncw-col-iva { display: table-cell; }
  .ncw-total-box {
    display: flex; justify-content: flex-end; align-items: center; gap: 10px; font-weight: 700; padding: 2px 4px;
  }
  .ncw-total-box input { width: 150px; font-size: 16px; font-weight: 700; text-align: right; }
  .ncw-radio { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .ncw-radio label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .ncw-radio label.ncw-off { opacity: .5; cursor: not-allowed; }
  `;

  function ensureCss() {
    PagoWizard.ensureCss();   // el chrome del modal (ccprov-*) vive en ese modulo
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

  // Quien puede registrar una NC: el mismo permiso que un pago a proveedor.
  function puede() {
    return !!window.SGA_Permisos?.can?.('can_cta_cte_proveedores');
  }

  const IVA_OPTS = `<option value="">—</option><option value="10.5">10,5%</option><option value="21">21%</option>`;

  async function abrir({ proveedorId = null, compraOrigenId = null, onSaved = null } = {}) {
    ensureCss();
    // La capa de datos vive en cuenta_corriente_proveedores.js (window.SGA_PagosProveedores).
    if (!window.SGA_PagosProveedores) await import('./cuenta_corriente_proveedores.js');
    const data = () => window.SGA_PagosProveedores;
    const overlay = ensureOverlay();

    const user = window.SGA_Auth?.getCurrentUser?.() || {};
    const proveedores = window.SGA_DB.query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 ORDER BY razon_social COLLATE NOCASE ASC`
    );

    // Si viene una factura de referencia, de ahi salen el proveedor y la letra.
    let origen = null;
    if (compraOrigenId) {
      origen = window.SGA_DB.query(
        `SELECT id, proveedor_id, condicion_compra FROM compras WHERE id = ?`, [compraOrigenId])[0] || null;
      if (origen) proveedorId = origen.proveedor_id;
    }

    const st = {
      prod: [],          // { productoId, nombre, cantidad, costo, iva, bajaStock }
      conc: [],          // { concepto, monto, iva }
      tocado: new Set(), // campos que el usuario edito a mano y no hay que pisar al recalcular
      aplicarTocado: false, // el usuario eligio a mano "como aplicar": deja de seguir el valor por defecto
    };

    overlay.innerHTML = `
      <div class="ccprov-modal" id="ncw-modal">
        <div class="ccprov-modal-hdr">
          <span>🧾 Registrar Nota de Crédito de Proveedor</span>
          <button class="ccprov-modal-close" id="ncw-close" aria-label="Cerrar" title="Cerrar">✕</button>
        </div>
        <div class="ccprov-modal-body">

          <div class="ccprov-field-row">
            <div class="ccprov-field" style="flex:2">
              <label for="ncw-proveedor">Proveedor <span style="color:var(--color-danger)">*</span></label>
              <select class="ccprov-input" id="ncw-proveedor">
                <option value="">— Seleccionar proveedor —</option>
                ${proveedores.map(p => `<option value="${esc(p.id)}" ${p.id === proveedorId ? 'selected' : ''}>${esc(p.razon_social)}</option>`).join('')}
              </select>
            </div>
            <div class="ccprov-field">
              <label for="ncw-fecha">Fecha</label>
              <input type="date" class="ccprov-input" id="ncw-fecha" value="${today()}">
            </div>
          </div>

          <div class="ccprov-field-row">
            <div class="ccprov-field">
              <label for="ncw-letra">Tipo de NC</label>
              <select class="ccprov-input" id="ncw-letra">
                <option value="">— (sin discriminar IVA)</option>
                <option value="A">NC A (discrimina IVA)</option>
                <option value="B">NC B</option>
                <option value="C">NC C</option>
              </select>
            </div>
            <div class="ccprov-field" style="flex:1.5">
              <label for="ncw-numero">N° de comprobante</label>
              <input type="text" class="ccprov-input" id="ncw-numero" placeholder="0001-00000123" autocomplete="off">
            </div>
            <div class="ccprov-field" style="flex:2">
              <label for="ncw-ref">Factura de referencia</label>
              <select class="ccprov-input" id="ncw-ref"></select>
            </div>
          </div>

          <div id="ncw-cuerpo">
            <div class="ccprov-section-title">Productos devueltos (bajan el stock)</div>
            <div class="ncw-buscador">
              <input type="text" class="ccprov-input" id="ncw-buscar" placeholder="Buscar producto por nombre o código…" autocomplete="off">
              <div class="ncw-dd" id="ncw-dd"></div>
            </div>
            <div id="ncw-prod-wrap" style="margin-top:8px"></div>

            <div class="ccprov-section-title" style="margin-top:14px;display:flex;justify-content:space-between;align-items:center">
              <span>Descuentos / conceptos (solo plata)</span>
              <button type="button" class="ccprov-btn-secondary" id="ncw-add-conc" style="padding:4px 10px;font-size:12px">+ Agregar concepto</button>
            </div>
            <div id="ncw-conc-wrap"></div>
          </div>

          <div class="ncw-fiscal" id="ncw-fiscal">
            <div class="ccprov-field ncw-solo-a"><label for="ncw-neto">Subtotal neto</label>
              <input type="number" class="ccprov-input" id="ncw-neto" readonly tabindex="-1"></div>
            <div class="ccprov-field ncw-solo-a"><label for="ncw-iva105">IVA 10,5%</label>
              <input type="number" class="ccprov-input" id="ncw-iva105" min="0" step="any"></div>
            <div class="ccprov-field ncw-solo-a"><label for="ncw-iva21">IVA 21%</label>
              <input type="number" class="ccprov-input" id="ncw-iva21" min="0" step="any"></div>
            <div class="ccprov-field ncw-solo-a"><label for="ncw-impint">Imp. interno</label>
              <input type="number" class="ccprov-input" id="ncw-impint" min="0" step="any"></div>
            <div class="ccprov-field ncw-solo-a"><label for="ncw-perciva">Percepción IVA</label>
              <input type="number" class="ccprov-input" id="ncw-perciva" min="0" step="any"></div>
            <div class="ccprov-field ncw-solo-a"><label for="ncw-percibb">Percepción IIBB</label>
              <input type="number" class="ccprov-input" id="ncw-percibb" min="0" step="any"></div>
          </div>

          <div class="ncw-total-box">
            <label for="ncw-total">Total de la NC</label>
            <input type="number" class="ccprov-input" id="ncw-total" min="0" step="any">
          </div>
          <div id="ncw-total-hint" style="text-align:right;font-size:12px;color:var(--color-text-secondary);margin-top:-12px"></div>

          <div>
            <div class="ccprov-section-title">¿Aplicarla a una factura?</div>
            <div class="ncw-radio" id="ncw-aplicar">
              <label><input type="radio" name="ncw-aplicar" value="libre"> Dejarla como crédito libre (se aplica después con "Imputar…")</label>
              <label id="ncw-lbl-ref"><input type="radio" name="ncw-aplicar" value="ref"> Aplicarla a la factura de referencia (hasta su saldo)</label>
              <label><input type="radio" name="ncw-aplicar" value="auto"> Aplicarla a las facturas más viejas primero</label>
            </div>
          </div>

          <div class="ccprov-field">
            <label for="ncw-obs">Observaciones</label>
            <input type="text" class="ccprov-input" id="ncw-obs" placeholder="Opcional" autocomplete="off">
          </div>

          <div class="ccprov-error" id="ncw-error"></div>
        </div>
        <div class="ccprov-modal-ftr">
          <button class="ccprov-btn-secondary" id="ncw-cancel">Cancelar</button>
          <button class="ccprov-btn-primary" id="ncw-guardar">Guardar nota de crédito</button>
        </div>
      </div>`;
    overlay.classList.remove('hidden');

    const modal = ge('ncw-modal');
    const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ge('ncw-close').addEventListener('click', close);
    ge('ncw-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // ── Facturas del proveedor (referencia) ─────────────────────────────────
    const llenarReferencias = () => {
      const provId = ge('ncw-proveedor').value;
      const sel = ge('ncw-ref');
      if (!provId) { sel.innerHTML = '<option value="">— Elegí primero el proveedor —</option>'; actualizarAplicar(); return; }
      const saldos = new Map(data().getComprasPendientes(provId).filter(c => c.tipo === 'compra').map(c => [c.id, c.saldo]));
      const compras = window.SGA_DB.query(
        `SELECT id, fecha, numero_factura, factura_pv, total FROM compras
         WHERE proveedor_id = ? AND COALESCE(estado,'confirmada') != 'anulada'
         ORDER BY fecha DESC LIMIT 80`, [provId]);
      sel.innerHTML = '<option value="">— Sin referencia (crédito libre) —</option>' + compras.map(c => {
        const ref = [c.factura_pv, c.numero_factura].filter(Boolean).join('-') || c.id.slice(-6).toUpperCase();
        const saldo = saldos.get(c.id);
        return `<option value="${esc(c.id)}">${esc(ref)} · ${fmtFecha(c.fecha)} · ${fmt$(c.total)}${saldo != null ? ` (saldo ${fmt$(saldo)})` : ' (saldada)'}</option>`;
      }).join('');
      if (compraOrigenId && compras.some(c => c.id === compraOrigenId)) sel.value = compraOrigenId;
      actualizarAplicar();
    };

    // "Aplicar a la factura de referencia" solo tiene sentido si hay una elegida
    const actualizarAplicar = () => {
      const hayRef = !!ge('ncw-ref').value;
      const rRef = modal.querySelector('input[name="ncw-aplicar"][value="ref"]');
      rRef.disabled = !hayRef;
      ge('ncw-lbl-ref').classList.toggle('ncw-off', !hayRef);
      const actual = modal.querySelector('input[name="ncw-aplicar"]:checked')?.value;
      // Por defecto sigue a la factura de referencia (con una elegida: aplicarla; sin ninguna:
      // crédito libre); si el usuario ya eligio a mano, se respeta salvo que 'ref' se quede sin factura.
      if (!actual || !st.aplicarTocado || (actual === 'ref' && !hayRef)) {
        modal.querySelector(`input[name="ncw-aplicar"][value="${hayRef ? 'ref' : 'libre'}"]`).checked = true;
      }
    };

    // ── Lineas ──────────────────────────────────────────────────────────────
    const esA = () => ge('ncw-letra').value === 'A';

    const pintarLineas = () => {
      const pw = ge('ncw-prod-wrap');
      pw.innerHTML = st.prod.length ? `
        <table class="ncw-lineas"><thead><tr>
          <th>Producto</th><th class="r">Cant.</th><th class="r">Costo neto u.</th>
          <th class="ncw-col-iva">IVA</th><th class="r">Subtotal</th><th title="Baja el stock">Baja stock</th><th></th>
        </tr></thead><tbody>
        ${st.prod.map((l, i) => `<tr data-i="${i}">
          <td>${esc(l.nombre)}</td>
          <td class="r"><input type="number" data-f="cantidad" min="0.001" step="any" value="${l.cantidad}" aria-label="Cantidad"></td>
          <td class="r"><input type="number" data-f="costo" min="0" step="any" value="${l.costo}" aria-label="Costo neto unitario"></td>
          <td class="ncw-col-iva"><select data-f="iva" aria-label="IVA">${IVA_OPTS}</select></td>
          <td class="r ncw-sub">${fmt$(l.cantidad * l.costo)}</td>
          <td style="text-align:center"><input type="checkbox" data-f="baja" ${l.bajaStock ? 'checked' : ''} aria-label="Baja el stock"></td>
          <td><button type="button" class="ncw-del" data-del="prod" aria-label="Quitar" title="Quitar">✕</button></td>
        </tr>`).join('')}
        </tbody></table>`
        : `<div class="ncw-sin-lineas">Sin productos: buscá arriba lo que se le devuelve al proveedor.</div>`;
      pw.querySelectorAll('tr[data-i]').forEach(tr => {
        const sel = tr.querySelector('select[data-f="iva"]');
        if (sel) sel.value = st.prod[+tr.dataset.i].iva || '';
      });

      const cw = ge('ncw-conc-wrap');
      cw.innerHTML = st.conc.length ? `
        <table class="ncw-lineas"><thead><tr>
          <th>Concepto</th><th class="r">Monto neto</th><th class="ncw-col-iva">IVA</th><th></th>
        </tr></thead><tbody>
        ${st.conc.map((l, i) => `<tr data-i="${i}">
          <td><input type="text" class="ncw-concepto" data-f="concepto" value="${esc(l.concepto)}" placeholder="Ej.: bonificación por pronto pago" aria-label="Concepto"></td>
          <td class="r"><input type="number" data-f="monto" min="0" step="any" value="${l.monto || ''}" aria-label="Monto neto"></td>
          <td class="ncw-col-iva"><select data-f="iva" aria-label="IVA">${IVA_OPTS}</select></td>
          <td><button type="button" class="ncw-del" data-del="conc" aria-label="Quitar" title="Quitar">✕</button></td>
        </tr>`).join('')}
        </tbody></table>`
        : `<div class="ncw-sin-lineas">Sin conceptos.</div>`;
      cw.querySelectorAll('tr[data-i]').forEach(tr => {
        const sel = tr.querySelector('select[data-f="iva"]');
        if (sel) sel.value = st.conc[+tr.dataset.i].iva || '';
      });
      recalcular();
    };

    // ── Totales ─────────────────────────────────────────────────────────────
    const recalcular = () => {
      modal.classList.toggle('ncw-es-a', esA());
      const lineas = [
        ...st.prod.map(l => ({ sub: l.cantidad * l.costo, iva: l.iva })),
        ...st.conc.map(l => ({ sub: num(l.monto), iva: l.iva })),
      ];
      const neto = lineas.reduce((s, l) => s + l.sub, 0);
      const ivaDe = r => lineas.filter(l => l.iva === r).reduce((s, l) => s + l.sub * parseFloat(r) / 100, 0);
      const setIf = (id, val) => { if (!st.tocado.has(id)) ge(id).value = val ? (Math.round(val * 100) / 100) : ''; };

      ge('ncw-neto').value = neto ? (Math.round(neto * 100) / 100) : '';
      if (esA()) {
        setIf('ncw-iva105', ivaDe('10.5'));
        setIf('ncw-iva21', ivaDe('21'));
      }
      const calculado = esA()
        ? neto + num(ge('ncw-iva105').value) + num(ge('ncw-iva21').value)
              + num(ge('ncw-impint').value) + num(ge('ncw-perciva').value) + num(ge('ncw-percibb').value)
        : neto;
      if (!st.tocado.has('ncw-total')) ge('ncw-total').value = calculado ? (Math.round(calculado * 100) / 100) : '';
      const dif = num(ge('ncw-total').value) - calculado;
      ge('ncw-total-hint').textContent = st.tocado.has('ncw-total') && Math.abs(dif) > 0.01
        ? `Calculado de las líneas: ${fmt$(calculado)} (diferencia ${fmt$(Math.abs(dif))})`
        : '';
    };

    // ── Eventos ─────────────────────────────────────────────────────────────
    ge('ncw-proveedor').addEventListener('change', llenarReferencias);
    ge('ncw-ref').addEventListener('change', () => {
      actualizarAplicar();
      const c = window.SGA_DB.query(`SELECT condicion_compra FROM compras WHERE id = ?`, [ge('ncw-ref').value])[0];
      const letra = { 'Factura A': 'A', 'Factura B': 'B', 'Factura C': 'C' }[c?.condicion_compra];
      if (letra && !ge('ncw-letra').value) { ge('ncw-letra').value = letra; recalcular(); }
    });
    ge('ncw-letra').addEventListener('change', recalcular);
    modal.querySelectorAll('input[name="ncw-aplicar"]').forEach(r => r.addEventListener('change', () => { st.aplicarTocado = true; }));
    ['ncw-iva105', 'ncw-iva21', 'ncw-impint', 'ncw-perciva', 'ncw-percibb', 'ncw-total'].forEach(id => {
      ge(id).addEventListener('input', () => { st.tocado.add(id); recalcular(); });
    });

    // Lineas: edicion delegada (no se repinta la tabla al tipear: se perderia el foco)
    const onEditLinea = (lista, wrapId) => e => {
      const tr = e.target.closest('tr[data-i]');
      const campo = e.target.dataset.f;
      if (!tr || !campo) return;
      const l = lista[+tr.dataset.i];
      if (!l) return;
      if (campo === 'cantidad') l.cantidad = num(e.target.value);
      else if (campo === 'costo') l.costo = num(e.target.value);
      else if (campo === 'iva') l.iva = e.target.value;
      else if (campo === 'baja') l.bajaStock = e.target.checked;
      else if (campo === 'concepto') l.concepto = e.target.value;
      else if (campo === 'monto') l.monto = num(e.target.value);
      const sub = tr.querySelector('.ncw-sub');
      if (sub && lista === st.prod) sub.textContent = fmt$(l.cantidad * l.costo);
      recalcular();
    };
    ge('ncw-prod-wrap').addEventListener('input', onEditLinea(st.prod));
    ge('ncw-prod-wrap').addEventListener('change', onEditLinea(st.prod));
    ge('ncw-conc-wrap').addEventListener('input', onEditLinea(st.conc));
    ge('ncw-conc-wrap').addEventListener('change', onEditLinea(st.conc));
    modal.addEventListener('click', e => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const tr = del.closest('tr[data-i]');
      (del.dataset.del === 'prod' ? st.prod : st.conc).splice(+tr.dataset.i, 1);
      pintarLineas();
    });
    ge('ncw-add-conc').addEventListener('click', () => {
      st.conc.push({ concepto: '', monto: 0, iva: '' });
      pintarLineas();
      ge('ncw-conc-wrap').querySelector('tr:last-child input[data-f="concepto"]')?.focus();
    });

    // Buscador de productos (motor unico SGA_Buscador)
    const dd = ge('ncw-dd');
    const inp = ge('ncw-buscar');
    const nav = window.SGA_Buscador.attachDropdownKeyboard(inp, {
      getItems: () => dd.querySelectorAll('.sri'),
      highlightClass: 'ncw-hl',
      onEscape: () => { dd.style.display = 'none'; },
    });
    inp.addEventListener('input', () => {
      nav.reset();
      const res = window.SGA_Buscador.porTexto(inp.value, { sucursalId: user.sucursal_id || null, limite: 12 });
      window.SGA_Buscador.pintarDropdown(dd, res, p => {
        st.prod.push({
          productoId: p.id, nombre: p.nombre, cantidad: 1,
          costo: num(p.costo), iva: p.iva === '10.5' || p.iva === '21' ? p.iva : '', bajaStock: true,
        });
        inp.value = '';
        dd.style.display = 'none';
        pintarLineas();
        ge('ncw-prod-wrap').querySelector('tr:last-child input[data-f="cantidad"]')?.select();
      });
    });
    // Enter con un solo resultado: lo elige (mismo criterio que el buscador de Compras)
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const items = dd.querySelectorAll('.sri'); if (items.length === 1) items[0].click(); }
    });

    // ── Guardar ─────────────────────────────────────────────────────────────
    const showError = m => { const el = ge('ncw-error'); el.textContent = m; el.classList.add('visible'); };
    ge('ncw-guardar').addEventListener('click', () => {
      ge('ncw-error').classList.remove('visible');
      const provId = ge('ncw-proveedor').value;
      if (!provId) return showError('Seleccioná un proveedor.');
      const total = num(ge('ncw-total').value);
      if (total <= 0.01) return showError('La nota de crédito no tiene importe: cargá líneas o escribí el total.');
      if (st.prod.some(l => l.cantidad <= 0)) return showError('Hay un producto con cantidad 0.');
      if (st.conc.some(l => !String(l.concepto).trim() && num(l.monto) > 0)) return showError('Un concepto tiene monto pero no descripción.');

      const letra = ge('ncw-letra').value;
      const aplicar = modal.querySelector('input[name="ncw-aplicar"]:checked')?.value || 'libre';
      const opts = {
        proveedor_id: provId,
        fecha: ge('ncw-fecha').value || today(),
        usuario_id: user.id || null,
        observaciones: ge('ncw-obs').value.trim() || null,
        numero_comprobante: ge('ncw-numero').value.trim() || null,
        condicion_nc: letra,
        compra_origen_id: ge('ncw-ref').value || null,
        total,
        items: [
          ...st.prod.map(l => ({ tipo: 'producto', producto_id: l.productoId, cantidad: l.cantidad,
                                 costo_unitario: l.costo, iva: l.iva || null, mueve_stock: l.bajaStock })),
          ...st.conc.filter(l => String(l.concepto).trim() || num(l.monto) > 0)
                    .map(l => ({ tipo: 'concepto', concepto: l.concepto, subtotal: num(l.monto), iva: l.iva || null })),
        ],
        imputar_a_compra_id: aplicar === 'ref' ? ge('ncw-ref').value : null,
        auto_imputar: aplicar === 'auto',
      };
      if (letra === 'A') {
        opts.fiscal = {
          subtotal_neto: num(ge('ncw-neto').value),
          iva_105: num(ge('ncw-iva105').value), iva_21: num(ge('ncw-iva21').value),
          imp_interno: num(ge('ncw-impint').value),
          percepcion_iva: num(ge('ncw-perciva').value), percepcion_iibb: num(ge('ncw-percibb').value),
        };
      }

      const res = data().crearNotaCredito(opts);
      if (!res.success) return showError('Error al guardar: ' + res.error);

      close();
      window.SGA_Sync?.pushPending?.();
      if (typeof onSaved === 'function') { try { onSaved(res, provId); } catch (e) { console.warn('onSaved:', e); } }
      const msg = res.credito_sobrante > 0.01
        ? `Nota de crédito registrada. Crédito disponible: ${fmt$(res.credito_sobrante)}`
        : 'Nota de crédito registrada.';
      if (window.SGA_Utils?.showToast) window.SGA_Utils.showToast(msg, 'success');
      else window.SGA_Utils?.showNotification?.(msg, 'success');
    });

    // Estado inicial
    if (origen?.condicion_compra) {
      const l = { 'Factura A': 'A', 'Factura B': 'B', 'Factura C': 'C' }[origen.condicion_compra];
      if (l) ge('ncw-letra').value = l;
    }
    llenarReferencias();
    pintarLineas();
    setTimeout(() => (ge('ncw-proveedor').value ? ge('ncw-buscar') : ge('ncw-proveedor')).focus(), 60);
  }

  return { abrir, puede };
})();

window.SGA_NotaCreditoWizard = SGA_NotaCreditoWizard;

export default SGA_NotaCreditoWizard;
