'use strict';

/**
 * limpieza_prueba.js — Utilidad de una sola vez: borra los datos de prueba
 * antes de la migración real del catálogo. Sin entrada en el menú a
 * propósito (se accede por hash directo #limpieza_prueba); blindada por
 * ROUTE_ADMIN_ONLY en app.js además del chequeo de rol acá abajo.
 */
const LimpiezaPrueba = (() => {

  const ge = id => document.getElementById(id);
  const db = () => window.SGA_DB;

  // Se conservan tal cual. Todo lo demás (incluida cuenta_proveedor, para
  // que los proveedores conservados queden con saldo $0) se borra.
  const PRESERVE_TABLES = ['usuarios', 'sucursales', 'medios_cobro', 'system_config', 'proveedores'];

  function getWipeTables() {
    const rows = db().query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    );
    return rows.map(r => r.name).filter(t => !PRESERVE_TABLES.includes(t));
  }

  function mostrarConteo() {
    const el = ge('lp-conteo');
    if (!el) return;
    try {
      const tables = getWipeTables();
      let total = 0;
      const detalle = [];
      for (const t of tables) {
        try {
          const r = db().query(`SELECT COUNT(*) AS n FROM ${t}`);
          const n = (r[0] && r[0].n) || 0;
          if (n > 0) { detalle.push(`${t}: ${n}`); total += n; }
        } catch (e) { /* tabla sin filas o inexistente en esta base, ignorar */ }
      }
      el.innerHTML = total === 0
        ? 'No hay datos para borrar en este dispositivo (ya está limpio).'
        : `<strong>${total} filas</strong> en total, repartidas en ${detalle.length} tabla${detalle.length !== 1 ? 's' : ''} con datos.<br>` +
          `<span style="font-size:12px">${detalle.join(' · ')}</span>`;
    } catch (e) {
      el.textContent = 'Error al calcular el conteo: ' + e.message;
    }
  }

  function showMsg(el, texto, tipo) {
    if (!el) return;
    el.textContent = texto;
    el.style.color = tipo === 'ok' ? '#2e7d32' : '#c62828';
    el.style.display = '';
  }

  async function borrarLocal() {
    const msgEl = ge('lp-msg-local');
    const tables = getWipeTables();
    if (!tables.length) { showMsg(msgEl, 'No hay nada para borrar.', 'ok'); return; }

    const confirmMsg =
      `⚠️ Esto borra ${tables.length} tablas de ESTE dispositivo (productos, ventas, stock, ` +
      `consumo interno, compras, clientes, etc.).\n\n` +
      `Se conservan: usuarios, cajas, medios de pago y proveedores (sin sus movimientos de cuenta corriente).\n\n` +
      `No se puede deshacer. ¿Confirmar?`;
    if (!confirm(confirmMsg)) return;
    if (!confirm('Segunda confirmación: esto NO afecta a otros dispositivos ni a Firestore — eso se hace por separado. ¿Estás seguro?')) return;

    const btn = ge('lp-btn-local');
    btn.disabled = true;
    btn.textContent = 'Borrando...';

    try {
      db().beginBatch();
      for (const t of tables) {
        db().run(`DELETE FROM ${t}`);
      }
      db().commitBatch();
      // Esperar a que el guardado quede escrito en disco (OPFS) antes de
      // recargar — si no, con miles de filas borradas la recarga puede
      // cortar el guardado a mitad de camino y vuelve a aparecer todo.
      await db().flush().catch(() => {});
      showMsg(msgEl, `Listo. Se vaciaron ${tables.length} tablas locales. Recargando...`, 'ok');
      setTimeout(() => location.reload(), 400);
    } catch (e) {
      db().rollbackBatch();
      showMsg(msgEl, 'Error: ' + e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Borrar datos de prueba (este dispositivo)';
    }
  }

  async function borrarCloud() {
    const msgEl = ge('lp-msg-cloud');
    if (!window.SGA_Sync || !window.SGA_Sync.isInitialized || !window.SGA_Sync.isInitialized()) {
      showMsg(msgEl, 'Firebase no está conectado en este momento.', 'error');
      return;
    }

    const confirmMsg =
      '⚠️ Esto borra los datos de prueba en Firestore (la nube), afectando a TODOS los dispositivos ' +
      'que sincronicen de ahora en más.\n\n' +
      'Ejecutalo UNA SOLA VEZ — no hace falta repetirlo desde cada dispositivo.\n\n' +
      '¿Confirmar?';
    if (!confirm(confirmMsg)) return;
    if (!confirm('Segunda confirmación: esto es irreversible y afecta a la nube compartida. ¿Estás seguro?')) return;

    const btn = ge('lp-btn-cloud');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Borrando en la nube...';

    try {
      const total = await window.SGA_Sync.wipeFirestoreCollections((coleccion, acumulado) => {
        btn.textContent = `Borrando... ${acumulado} (${coleccion})`;
      });
      showMsg(msgEl, `Listo. Se borraron ${total} documentos en Firestore.`, 'ok');
    } catch (e) {
      showMsg(msgEl, 'Error: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    if (!user || user.rol !== 'admin') {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Acceso restringido. Solo administradores.</div>';
      return;
    }
    mostrarConteo();
    ge('lp-btn-local')?.addEventListener('click', borrarLocal);
    ge('lp-btn-cloud')?.addEventListener('click', borrarCloud);
  }

  return { init };
})();

export default LimpiezaPrueba;
