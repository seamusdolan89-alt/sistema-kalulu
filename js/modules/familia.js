'use strict';

/**
 * Wizard de FAMILIA DE PRODUCTOS.
 *
 * Una "familia" son productos que comparten comportamiento de costo/precio
 * (Coca-Cola 600ml + Sprite 600ml, por ejemplo), no presentaciones distintas
 * del mismo producto. Se modela con productos.producto_madre_id / es_madre y
 * las banderas hereda_costo / hereda_precio de cada miembro.
 *
 * Vivia adentro de compras_v2.js y solo se abria al confirmar una compra. Se
 * movio aca para poder abrirlo desde cualquier lado que cambie un costo o un
 * precio — hoy tambien el editor de productos. El CSS se inyecta desde este
 * mismo archivo para que el modal se vea igual en cualquier pantalla.
 *
 * Expone window.SGA_Familia.
 */

const SGA_Familia = (() => {

  const db     = () => window.SGA_DB;
  const nowISO = () => new Date().toISOString();
  const esc    = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                     .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt$   = n => window.SGA_Utils.formatCurrency(n);
  const sucursalId = () => window.SGA_Auth?.getCurrentUser()?.sucursal_id || '1';

  // ── CSS ────────────────────────────────────────────────────────────────────
  const STYLE_ID = 'sga-familia-css';
  const CSS = `
  .cv2-her-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    z-index: 600; display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .cv2-her-box {
    background: #fff; border-radius: 12px;
    box-shadow: 0 12px 48px rgba(0,0,0,0.28);
    width: 100%; max-width: 1020px; max-height: 90vh;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .cv2-her-header {
    padding: 14px 20px; border-bottom: 1px solid #e8edf3;
    display: flex; align-items: center; gap: 10px;
    background: #f5f9ff; flex-shrink: 0;
  }
  .cv2-her-header-icon { font-size: 1.4rem; }
  .cv2-her-header-title { font-size: 14px; font-weight: 700; color: #1a2744; }
  .cv2-her-warn {
    margin: 12px 20px 0; padding: 9px 14px;
    background: #fff8e1; border: 1px solid #ffe082; border-radius: 7px;
    font-size: 13px; color: #5f4c00; flex-shrink: 0;
  }
  .cv2-her-warn strong { color: #e65100; }
  .cv2-her-sync-all-wrap {
    padding: 10px 20px 0; display: flex; justify-content: flex-end; flex-shrink: 0;
  }
  .cv2-her-btn-sync-all {
    background: #1565c0; color: white; border: none; border-radius: 6px;
    padding: 7px 18px; font-size: 12px; font-weight: 700; cursor: pointer;
  }
  .cv2-her-btn-sync-all:hover { background: #1976d2; }
  .cv2-her-table-wrap { flex: 1; overflow-y: auto; padding: 10px 20px; min-height: 0; }
  .cv2-her-table {
    width: 100%; border-collapse: collapse; font-size: 13px;
  }
  .cv2-her-table thead tr { background: #f8fafc; }
  .cv2-her-table thead tr:last-child { border-bottom: 2px solid #d0d7e3; }
  .cv2-her-thead-selall th { padding: 4px 8px; background: #eef4ff; }
  .cv2-her-thead-selall input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #1565c0; }
  .cv2-her-table th {
    padding: 7px 8px; text-align: left;
    font-size: 11px; font-weight: 700; color: #607080;
    text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap;
  }
  .cv2-her-table th.c, .cv2-her-table td.c { text-align: center; }
  .cv2-her-table th.r, .cv2-her-table td.r { text-align: right; }
  .cv2-her-table td { padding: 7px 8px; border-bottom: 1px solid #eef0f4; vertical-align: middle; }
  .cv2-her-table tr:last-child td { border-bottom: none; }
  .cv2-her-table tbody tr:hover td { background: #f5f9ff; }
  .cv2-her-td-num { color: #8090a0; font-size: 12px; }
  .cv2-her-td-nombre { font-weight: 500; color: #1a2744; }
  .cv2-her-td-stock { color: #607080; font-weight: 600; }
  .cv2-her-td-readonly { color: #9e9e9e; text-align: right; font-size: 12px; }
  .cv2-her-chk { width: 16px; height: 16px; cursor: pointer; accent-color: #1565c0; }
  .cv2-her-val {
    display: inline-block; padding: 3px 7px;
    background: #e3f2fd; border-radius: 4px; font-weight: 700;
    color: #1565c0; font-size: 12px; min-width: 52px; text-align: right;
  }
  .cv2-her-val.unchanged { background: #f5f5f5; color: #9e9e9e; }
  .cv2-her-btn-sinc {
    background: #1565c0; color: white; border: none; border-radius: 5px;
    padding: 4px 12px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .cv2-her-btn-sinc:hover { background: #1976d2; }
  .cv2-her-btn-sinc.sinc-done { background: #78909c; cursor: default; }
  .cv2-her-footer {
    flex-shrink: 0; padding: 12px 20px;
    border-top: 1px solid #e8edf3; background: #fafbfc;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    flex-wrap: wrap;
  }
  .cv2-her-summary { font-size: 13px; color: #607080; display: flex; flex-direction: column; gap: 3px; }
  .cv2-her-summary-val { color: #1a2744; font-weight: 700; }
  .cv2-her-summary-ganancia { color: #2e7d32; }
  .cv2-her-footer-actions { display: flex; gap: 10px; align-items: center; }
  .cv2-her-btn-cancel {
    background: none; border: none; color: #8090a0; font-size: 13px;
    cursor: pointer; padding: 6px 10px; text-decoration: underline;
  }
  .cv2-her-btn-cancel:hover { color: #c62828; }

  /* Madre/lider row */
  .cv2-her-row-lider td { background: #fffde7; border-bottom: 2px solid #ffe082 !important; }
  .cv2-her-row-lider:hover td { background: #fff9c4 !important; }
  .cv2-her-badge-lider {
    display: inline-block; font-size: 10px; font-weight: 700;
    background: #fff8e1; color: #f57f17; border: 1px solid #ffe082;
    border-radius: 4px; padding: 1px 5px; margin-right: 4px;
    vertical-align: middle; white-space: nowrap;
  }
  .cv2-her-btn-apply {
    background: linear-gradient(135deg, #1565c0, #1976d2);
    color: white; border: none; border-radius: 7px;
    padding: 9px 22px; font-size: 13px; font-weight: 700; cursor: pointer;
    box-shadow: 0 2px 6px rgba(21,101,192,0.3);
  }
  .cv2-her-btn-apply:hover { background: linear-gradient(135deg, #1976d2, #1e88e5); }
`;

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /**
   * True si el producto pertenece a una familia con al menos otro miembro.
   * Sirve para no abrir un wizard vacio.
   */
  function tieneFamilia(prodId) {
    const p = db().query(
      `SELECT es_madre, producto_madre_id FROM productos WHERE id=?`, [prodId]
    )[0];
    if (!p) return false;
    if (p.es_madre == 1) {
      return (db().query(
        `SELECT 1 FROM productos WHERE producto_madre_id=? LIMIT 1`, [prodId]
      ) || []).length > 0;
    }
    return !!p.producto_madre_id;
  }

  function showHerenciaModal({ prodId, prodNombre, nuevoCosto, nuevoPrecio, onDone, onSync }) {
    const done = () => { if (typeof onDone === 'function') onDone(); };
    ensureCss();
    const thisProd = db().query(
      `SELECT es_madre, producto_madre_id FROM productos WHERE id=?`, [prodId]
    )[0];
    if (!thisProd) { done(); return; }

    const esMadre = thisProd.es_madre == 1;
    const madreId = esMadre ? prodId : thisProd.producto_madre_id;

    const madreProd = esMadre
      ? { id: prodId, nombre: prodNombre }
      : db().query(
          `SELECT p.id, p.nombre, p.costo AS costo_actual, p.precio_venta AS precio_actual,
                  COALESCE(s.cantidad, 0) AS stock_actual
           FROM productos p
           LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
           WHERE p.id = ?`,
          [sucursalId(), madreId]
        )[0];

    const familiaNombre = madreProd?.nombre || 'Familia';

    // ── Build miembros list ──
    // When saved product is MADRE  → show only hijos, madre is implicit
    // When saved product is HIJO   → show MADRE first (es_lider=1), then all siblings
    let miembros = [];

    if (esMadre) {
      miembros = db().query(`
        SELECT p.id, p.nombre, p.costo AS costo_actual, p.precio_venta AS precio_actual,
               COALESCE(p.hereda_costo, 1) AS hereda_costo,
               COALESCE(p.hereda_precio, 1) AS hereda_precio,
               COALESCE(s.cantidad, 0) AS stock_actual,
               0 AS es_lider
        FROM productos p
        LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
        WHERE p.producto_madre_id = ?
        ORDER BY p.nombre
      `, [sucursalId(), madreId]);
    } else {
      // Madre goes first, always checked (she has no hereda flags — she IS the source)
      const madreRow = {
        id:           madreProd.id,
        nombre:       madreProd.nombre,
        costo_actual: parseFloat(madreProd.costo_actual) || 0,
        precio_actual: parseFloat(madreProd.precio_actual) || 0,
        hereda_costo:  1,
        hereda_precio: 1,
        stock_actual:  parseFloat(madreProd.stock_actual) || 0,
        es_lider:      1,
      };
      const siblings = db().query(`
        SELECT p.id, p.nombre, p.costo AS costo_actual, p.precio_venta AS precio_actual,
               COALESCE(p.hereda_costo, 1) AS hereda_costo,
               COALESCE(p.hereda_precio, 1) AS hereda_precio,
               COALESCE(s.cantidad, 0) AS stock_actual,
               0 AS es_lider
        FROM productos p
        LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
        WHERE p.producto_madre_id = ? AND p.id != ?
        ORDER BY p.nombre
      `, [sucursalId(), madreId, prodId]);
      miembros = [madreRow, ...siblings];
    }

    if (miembros.length === 0) { done(); return; }

    // ── Row renderer ──
    function buildRow(m, i) {
      const hc      = m.hereda_costo == 1;
      const hp      = m.hereda_precio == 1;
      const liderBadge = m.es_lider
        ? `<span class="cv2-her-badge-lider">👑 MADRE</span> `
        : '';
      return `
        <tr data-mid="${esc(m.id)}" ${m.es_lider ? 'class="cv2-her-row-lider"' : ''}>
          <td class="cv2-her-td-num c">${i + 1}</td>
          <td class="cv2-her-td-nombre">${liderBadge}${esc(m.nombre)}</td>
          <td class="cv2-her-td-stock c">[${m.stock_actual}]</td>
          <td class="cv2-her-td-readonly r">${fmt$(m.costo_actual)}</td>
          <td class="c">
            <input type="checkbox" class="cv2-her-chk cv2-her-chk-costo"
                   data-mid="${esc(m.id)}" ${hc ? 'checked' : ''}>
          </td>
          <td class="cv2-her-td-readonly r">${fmt$(m.precio_actual)}</td>
          <td class="c">
            <input type="checkbox" class="cv2-her-chk cv2-her-chk-precio"
                   data-mid="${esc(m.id)}" ${hp ? 'checked' : ''}>
          </td>
          <td class="c">
            <span class="cv2-her-val cv2-her-nuevo-costo ${hc ? '' : 'unchanged'}">
              ${hc ? fmt$(nuevoCosto) : fmt$(m.costo_actual)}
            </span>
          </td>
          <td class="c">
            <span class="cv2-her-val cv2-her-nuevo-precio ${hp ? '' : 'unchanged'}">
              ${hp ? fmt$(nuevoPrecio) : fmt$(m.precio_actual)}
            </span>
          </td>
          <td>
            <button class="cv2-her-btn-sinc" data-mid="${esc(m.id)}">✓ Sincronizar</button>
          </td>
        </tr>`;
    }

    const rowsHtml = miembros.map((m, i) => buildRow(m, i)).join('');

    // ── Overlay HTML ──
    const overlay = document.createElement('div');
    overlay.className = 'cv2-her-overlay';
    overlay.innerHTML = `
      <div class="cv2-her-box">
        <div class="cv2-her-header">
          <span class="cv2-her-header-icon">👪</span>
          <span class="cv2-her-header-title">Gestión de Herencia por Familia: ${esc(familiaNombre)}</span>
        </div>
        <div class="cv2-her-warn">
          ⚠️ El producto <strong>'${esc(prodNombre)}'</strong> que acabas de modificar pertenece a una familia.
          ¿Deseas sincronizar los costos y precios de los miembros?
        </div>
        <div class="cv2-her-sync-all-wrap">
          <button class="cv2-her-btn-sync-all">✓ SINCRONIZAR SELECCIONADOS</button>
        </div>
        <div class="cv2-her-table-wrap">
          <table class="cv2-her-table">
            <thead>
              <tr class="cv2-her-thead-selall">
                <th colspan="4"></th>
                <th class="c">
                  <input type="checkbox" class="cv2-her-chk cv2-her-chk-all-costo" checked title="Seleccionar todos">
                </th>
                <th></th>
                <th class="c">
                  <input type="checkbox" class="cv2-her-chk cv2-her-chk-all-precio" checked title="Seleccionar todos">
                </th>
                <th colspan="3"></th>
              </tr>
              <tr>
                <th class="c">#</th>
                <th>Descripción</th>
                <th class="c">Stock Actual</th>
                <th class="r">Costo Actual<br><small style="font-weight:400;text-transform:none">(Read-only)</small></th>
                <th class="c">Heredar<br>Costo?</th>
                <th class="r">Precio Actual<br><small style="font-weight:400;text-transform:none">(Read-only)</small></th>
                <th class="c">Heredar<br>Precio?</th>
                <th class="c">Nuevo<br>Costo</th>
                <th class="c">Nuevo<br>Precio</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody id="cv2-her-tbody">${rowsHtml}</tbody>
          </table>
        </div>
        <div class="cv2-her-footer">
          <div class="cv2-her-summary">
            <span>Miembros Sincronizados: <span class="cv2-her-summary-val" id="cv2-her-cnt">0</span></span>
            <span>Ganancia por Revalorización de Stock:
              <span class="cv2-her-summary-val cv2-her-summary-ganancia" id="cv2-her-gan">${fmt$(0)}</span>
            </span>
          </div>
          <div class="cv2-her-footer-actions">
            <button class="cv2-her-btn-cancel">cancel</button>
            <button class="cv2-her-btn-apply">✓ FINALIZAR Y APLICAR CAMBIOS</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // ── Helpers ──
    function getMiembroData(mid) {
      return miembros.find(m => m.id === mid);
    }

    function recalcSummary() {
      let cnt = 0, gan = 0;
      overlay.querySelectorAll('#cv2-her-tbody tr').forEach(tr => {
        const mid = tr.dataset.mid;
        const m   = getMiembroData(mid);
        if (!m) return;
        const hc  = tr.querySelector('.cv2-her-chk-costo')?.checked;
        const hp  = tr.querySelector('.cv2-her-chk-precio')?.checked;
        if (hc || hp) cnt++;
        if (hc) gan += (nuevoCosto - m.costo_actual) * m.stock_actual;
        const ncEl = tr.querySelector('.cv2-her-nuevo-costo');
        const npEl = tr.querySelector('.cv2-her-nuevo-precio');
        if (ncEl) { ncEl.textContent = hc ? fmt$(nuevoCosto) : fmt$(m.costo_actual); ncEl.classList.toggle('unchanged', !hc); }
        if (npEl) { npEl.textContent = hp ? fmt$(nuevoPrecio) : fmt$(m.precio_actual); npEl.classList.toggle('unchanged', !hp); }
      });
      const cntEl = overlay.querySelector('#cv2-her-cnt');
      const ganEl = overlay.querySelector('#cv2-her-gan');
      if (cntEl) cntEl.textContent = cnt;
      if (ganEl) { ganEl.textContent = (gan >= 0 ? '+' : '') + fmt$(gan); ganEl.style.color = gan >= 0 ? '#2e7d32' : '#c62828'; }
    }

    function sincRow(tr) {
      const mid = tr.dataset.mid;
      const m   = getMiembroData(mid);
      if (!m) return;
      const hc  = tr.querySelector('.cv2-her-chk-costo')?.checked;
      const hp  = tr.querySelector('.cv2-her-chk-precio')?.checked;
      const ts  = nowISO();
      const fields = [], vals = [];
      if (hc) { fields.push('costo=?', 'costo_paquete=?'); vals.push(nuevoCosto, nuevoCosto); }
      if (hp) { fields.push('precio_venta=?', 'ultima_modificacion_precio=?'); vals.push(nuevoPrecio, ts); }
      if (!fields.length) return;
      fields.push("sync_status='pending'", 'updated_at=?');
      vals.push(ts, m.id);
      db().run(`UPDATE productos SET ${fields.join(',')} WHERE id=?`, vals);
      // Quien abrio el wizard decide que hacer con lo sincronizado: compras lo
      // usa para el resumen final, el editor de productos no lo necesita.
      if (typeof onSync === 'function') {
        onSync({
          id:        m.id,
          nombre:    m.nombre,
          costoAnt:  m.costo_actual,
          costoNvo:  hc ? nuevoCosto : m.costo_actual,
          pvAnt:     m.precio_actual,
          pvNvo:     hp ? nuevoPrecio : m.precio_actual,
          hc: !!hc,
          hp: !!hp,
        });
      }
      const sincBtn = tr.querySelector('.cv2-her-btn-sinc');
      if (sincBtn) { sincBtn.textContent = '✓ Sincronizado'; sincBtn.classList.add('sinc-done'); sincBtn.disabled = true; }
    }

    // Init
    recalcSummary();

    overlay.querySelectorAll('.cv2-her-chk').forEach(chk => {
      chk.addEventListener('change', recalcSummary);
    });

    // Select-all checkboxes en el thead
    overlay.querySelector('.cv2-her-chk-all-costo')?.addEventListener('change', function() {
      overlay.querySelectorAll('#cv2-her-tbody .cv2-her-chk-costo').forEach(chk => { chk.checked = this.checked; });
      recalcSummary();
    });
    overlay.querySelector('.cv2-her-chk-all-precio')?.addEventListener('change', function() {
      overlay.querySelectorAll('#cv2-her-tbody .cv2-her-chk-precio').forEach(chk => { chk.checked = this.checked; });
      recalcSummary();
    });

    // "Sincronizar seleccionados": aplica solo las filas con al menos un checkbox marcado
    overlay.querySelector('.cv2-her-btn-sync-all')?.addEventListener('click', () => {
      overlay.querySelectorAll('#cv2-her-tbody tr').forEach(tr => {
        const hc = tr.querySelector('.cv2-her-chk-costo')?.checked;
        const hp = tr.querySelector('.cv2-her-chk-precio')?.checked;
        if ((hc || hp) && !tr.querySelector('.cv2-her-btn-sinc')?.classList.contains('sinc-done')) {
          try { sincRow(tr); } catch (e) { /* skip */ }
        }
      });
      recalcSummary();
    });

    overlay.querySelectorAll('.cv2-her-btn-sinc').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('sinc-done')) return;
        try { sincRow(btn.closest('tr')); } catch (e) { alert('Error: ' + e.message); }
        recalcSummary();
      });
    });

    overlay.querySelector('.cv2-her-btn-apply')?.addEventListener('click', () => {
      overlay.querySelectorAll('#cv2-her-tbody tr').forEach(tr => {
        if (!tr.querySelector('.cv2-her-btn-sinc')?.classList.contains('sinc-done')) {
          try { sincRow(tr); } catch (e) { /* skip */ }
        }
      });
      overlay.remove();
      done();
    });

    overlay.querySelector('.cv2-her-btn-cancel')?.addEventListener('click', () => {
      overlay.remove();
      done();
    });
  }

  return { showHerenciaModal, tieneFamilia, ensureCss };
})();

window.SGA_Familia = SGA_Familia;

export default SGA_Familia;
