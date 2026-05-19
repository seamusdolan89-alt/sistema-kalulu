/**
 * adelanto_pago.js — Registrar adelanto de pago a proveedor (admin only)
 *
 * Multi-method form: fill amounts for Caja Seamus, Transferencia, MercadoPago
 * independently. Any combination is supported in a single payment record.
 * Stored as orphan (auto_imputar=false); cashier applies it when loading the purchase.
 */

const AdelantoPagoModule = (() => {
  'use strict';

  const ge = (id) => document.getElementById(id);
  const fmt = (n) => window.SGA_Utils.formatCurrency(n);
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const METODOS = [
    { key: 'caja_seamus',   label: 'Caja Seamus',   hasRef: false },
    { key: 'transferencia', label: 'Transferencia',  hasRef: true  },
    { key: 'mercadopago',   label: 'MercadoPago',    hasRef: true  },
  ];

  async function init() {
    const user = window.SGA_Auth.getCurrentUser();
    if (!user || user.rol !== 'admin') {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Acceso restringido. Solo administradores.</div>';
      return;
    }

    if (!window.SGA_PagosProveedores) {
      await import('./cuenta_corriente_proveedores.js');
    }

    cargarProveedores();
    ge('ap-fecha').value = new Date().toISOString().slice(0, 10);
    bindEvents();
  }

  function cargarProveedores() {
    const sel = ge('ap-proveedor');
    const rows = window.SGA_DB.query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 ORDER BY razon_social COLLATE NOCASE`
    );
    sel.innerHTML = '<option value="">— Seleccionar proveedor —</option>' +
      rows.map(p => `<option value="${esc(p.id)}">${esc(p.razon_social)}</option>`).join('');
  }

  function getMontos() {
    return METODOS.map(m => ({
      metodo:     m.key,
      monto:      parseFloat(ge(`ap-monto-${m.key}`)?.value) || 0,
      referencia: m.hasRef ? (ge(`ap-ref-${m.key}`)?.value.trim() || null) : null,
    })).filter(m => m.monto > 0);
  }

  function actualizarTotal() {
    const total = METODOS.reduce((s, m) => s + (parseFloat(ge(`ap-monto-${m.key}`)?.value) || 0), 0);
    const row = ge('ap-total-row');
    if (total > 0) {
      ge('ap-total-val').textContent = fmt(total);
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
    // Toggle btn label
    const btn = ge('ap-btn-registrar');
    btn.textContent = total > 0 ? `Registrar ${fmt(total)}` : 'Registrar Pago';
  }

  function registrar() {
    const proveedorId   = ge('ap-proveedor').value;
    const fecha         = ge('ap-fecha').value;
    const observaciones = ge('ap-observaciones').value.trim();
    const metodos       = getMontos();
    const errorEl       = ge('ap-error');
    errorEl.style.display = 'none';

    if (!proveedorId) return showError('Seleccioná un proveedor.');
    if (!metodos.length) return showError('Ingresá al menos un monto.');

    const user   = window.SGA_Auth.getCurrentUser();
    const result = window.SGA_PagosProveedores.crearPago({
      proveedor_id:  proveedorId,
      fecha,
      observaciones: observaciones || null,
      usuario_id:    user.id,
      auto_imputar:  false,
      metodos,
    });

    if (!result.success) return showError(result.error || 'Error al registrar el pago.');

    const provNombre = ge('ap-proveedor').selectedOptions[0]?.text || '';
    const total      = metodos.reduce((s, m) => s + m.monto, 0);
    const detalle    = metodos.map(m => {
      const lbl = METODOS.find(x => x.key === m.metodo)?.label || m.metodo;
      return `${lbl}: ${fmt(m.monto)}`;
    }).join(' · ');

    ge('ap-success-msg').innerHTML =
      `<strong>${fmt(total)}</strong> a <strong>${esc(provNombre)}</strong><br>` +
      `<span style="font-size:13px;opacity:.8;">${esc(detalle)}</span><br><br>` +
      `El crédito se aplicará automáticamente cuando se cargue la compra en el local.`;

    ge('ap-form-card').style.display = 'none';
    ge('ap-success').style.display   = '';

    // Push inmediato para que el POS local reciba el pago sin esperar
    if (window.SGA_Sync?.isInitialized()) {
      const pushMsg = document.createElement('div');
      pushMsg.style.cssText = 'font-size:13px;color:#888;margin-top:8px;';
      pushMsg.textContent = '⏳ Enviando al POS local...';
      ge('ap-success').appendChild(pushMsg);
      window.SGA_Sync.pushToPos()
        .then(n => { pushMsg.textContent = '✅ Pago enviado al POS local. La cajera lo recibirá en el próximo pull.'; })
        .catch(() => { pushMsg.textContent = '⚠️ No se pudo enviar automáticamente. Usá el botón Push POS.'; });
    }
  }

  function resetForm() {
    ge('ap-proveedor').value     = '';
    ge('ap-observaciones').value = '';
    ge('ap-error').style.display = 'none';
    METODOS.forEach(m => {
      const inp = ge(`ap-monto-${m.key}`);
      if (inp) inp.value = '';
      if (m.hasRef) {
        const ref  = ge(`ap-ref-${m.key}`);
        const wrap = ge(`ap-ref-${m.key}-wrap`);
        if (ref)  ref.value = '';
        if (wrap) wrap.style.display = 'none';
      }
    });
    actualizarTotal();
  }

  function showError(msg) {
    const el = ge('ap-error');
    el.textContent = msg;
    el.style.display = '';
  }

  function bindEvents() {
    // Show referencia field when amount > 0 for methods that need it
    METODOS.filter(m => m.hasRef).forEach(m => {
      ge(`ap-monto-${m.key}`)?.addEventListener('input', () => {
        const monto = parseFloat(ge(`ap-monto-${m.key}`)?.value) || 0;
        ge(`ap-ref-${m.key}-wrap`).style.display = monto > 0 ? '' : 'none';
        actualizarTotal();
      });
    });

    // Non-ref methods just update total
    ge('ap-monto-caja_seamus')?.addEventListener('input', actualizarTotal);

    ge('ap-btn-registrar')?.addEventListener('click', registrar);
    ge('ap-btn-nuevo')?.addEventListener('click', () => {
      ge('ap-success').style.display   = 'none';
      ge('ap-form-card').style.display = '';
      resetForm();
    });
  }

  return { init };
})();

export default AdelantoPagoModule;
