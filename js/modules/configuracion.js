/**
 * configuracion.js — Configuración del sistema (solo admin)
 */

const ConfiguracionModule = (() => {
  'use strict';

  const ge = (id) => document.getElementById(id);

  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    if (!user || user.rol !== 'admin') {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Acceso restringido. Solo administradores.</div>';
      return;
    }
    cargarTopeDeuda();
    bindEvents();
  }

  // ─── Tope de deuda ───────────────────────────────────────────────────────

  function cargarTopeDeuda() {
    const rows = window.SGA_DB.query(
      `SELECT value FROM system_config WHERE key = 'tope_deuda_default'`
    );
    if (rows.length && rows[0].value != null) {
      ge('cfg-tope-deuda').value = rows[0].value;
    }
  }

  function guardarTopeDeuda() {
    const val = parseFloat(ge('cfg-tope-deuda').value);
    const msgEl = ge('cfg-tope-msg');

    if (isNaN(val) || val < 0) {
      mostrarMsg(msgEl, 'Ingresá un valor válido (mayor o igual a 0).', 'error');
      return;
    }

    try {
      window.SGA_DB.run(
        `INSERT INTO system_config (key, value, updated_at) VALUES ('tope_deuda_default', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [val]
      );
      mostrarMsg(msgEl, 'Guardado correctamente.', 'ok');
    } catch (e) {
      mostrarMsg(msgEl, 'Error al guardar: ' + e.message, 'error');
    }
  }

  function mostrarMsg(el, texto, tipo) {
    el.textContent = texto;
    el.style.color  = tipo === 'ok' ? 'var(--color-success, #2e7d32)' : '#c62828';
    el.style.display = '';
    setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  // ─── Reset DB ────────────────────────────────────────────────────────────

  async function resetDB() {
    const confirmMsg =
      '⚠️ ATENCIÓN: Esta acción borrará TODA la base de datos (productos, ventas, clientes, stock, etc.).\n\n' +
      'Los proveedores NO se recuperan automáticamente — asegurate de haber exportado el Excel antes.\n\n' +
      '¿Confirmar borrado total?';
    if (!confirm(confirmMsg)) return;
    if (!confirm('Segunda confirmación: ¿Estás seguro? No hay vuelta atrás.')) return;

    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry('sga.db').catch(() => {});
      }
      localStorage.removeItem('sga_db');
      alert('Base de datos borrada. La aplicación se va a recargar.');
      location.reload();
    } catch (e) {
      alert('Error al borrar la base de datos: ' + e.message);
    }
  }

  // ─── Eventos ─────────────────────────────────────────────────────────────

  function bindEvents() {
    ge('cfg-btn-guardar-tope')?.addEventListener('click', guardarTopeDeuda);
    ge('cfg-btn-reset-db')?.addEventListener('click', resetDB);
  }

  return { init };
})();

export default ConfiguracionModule;
