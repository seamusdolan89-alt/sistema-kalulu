/**
 * configuracion.js — Configuración del sistema (solo admin)
 */

const ConfiguracionModule = (() => {
  'use strict';

  const ge = (id) => document.getElementById(id);

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function init() {
    const user = window.SGA_Auth.getCurrentUser();
    if (!user || user.rol !== 'admin') {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Acceso restringido. Solo administradores.</div>';
      return;
    }
    if (!window.ADMIN_MODE) {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Esta sección solo está disponible desde ADMIN POS.</div>';
      return;
    }
    cargarTopeDeuda();
    cargarCajas();
    cargarMedios();
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

  // ─── Cajas (Sucursales) ──────────────────────────────────────────────────

  function cargarCajas() {
    const listEl = ge('cfg-cajas-list');
    if (!listEl) return;
    const rows = window.SGA_DB.query(`SELECT id, nombre, activa FROM sucursales ORDER BY nombre`);
    if (!rows.length) {
      listEl.innerHTML = '<p style="color:#999;font-size:13px;margin:0;">No hay cajas registradas.</p>';
      return;
    }
    listEl.innerHTML = rows.map(r => `
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:8px 12px;background:#f8f9fa;border-radius:6px;margin-bottom:6px;">
        <span style="font-size:14px;font-weight:600;">🏪 ${esc(r.nombre)}</span>
        <span style="font-size:12px;color:${r.activa ? '#2e7d32' : '#c62828'};">
          ${r.activa ? 'Activa' : 'Inactiva'}
        </span>
      </div>
    `).join('');
  }

  function crearCaja() {
    const nombre = (ge('cfg-nueva-caja-nombre')?.value || '').trim();
    const msgEl = ge('cfg-caja-form-msg');
    if (!nombre) { mostrarMsg(msgEl, 'Ingresá un nombre para la caja.', 'error'); return; }
    try {
      const id = window.SGA_Utils.generateUUID();
      window.SGA_DB.run(
        `INSERT INTO sucursales (id, nombre, activa, sync_status, updated_at) VALUES (?, ?, 1, 'pending', datetime('now'))`,
        [id, nombre]
      );
      ge('cfg-nueva-caja-nombre').value = '';
      ge('cfg-nueva-caja-form').style.display = 'none';
      cargarCajas();
      mostrarMsg(ge('cfg-nueva-caja-msg'), 'Caja creada correctamente.', 'ok');
    } catch(e) {
      mostrarMsg(msgEl, 'Error: ' + e.message, 'error');
    }
  }

  // ─── Medios de Cobro ─────────────────────────────────────────────────────

  const MEDIOS_DEFAULT = ['efectivo', 'mercadopago'];

  function cargarMedios() {
    const listEl = ge('cfg-medios-list');
    if (!listEl) return;
    let rows = [];
    try {
      rows = window.SGA_DB.query(
        `SELECT id, nombre, icono, activo FROM medios_cobro ORDER BY orden ASC, nombre ASC`
      );
    } catch(e) {}
    if (!rows.length) {
      listEl.innerHTML = '<p style="color:#999;font-size:13px;margin:0;">No hay medios registrados.</p>';
      return;
    }
    listEl.innerHTML = rows.map(r => `
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:8px 12px;background:#f8f9fa;border-radius:6px;margin-bottom:6px;">
        <span style="font-size:14px;">${esc(r.icono || '')} <strong>${esc(r.nombre)}</strong></span>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:12px;color:${r.activo ? '#2e7d32' : '#c62828'};">
            ${r.activo ? 'Activo' : 'Inactivo'}
          </span>
          <button data-medit="${esc(r.id)}"
            style="font-size:11px;padding:3px 10px;border:1px solid #ccc;
                   background:#fff;border-radius:4px;cursor:pointer;">
            ✏️ Editar
          </button>
          ${!MEDIOS_DEFAULT.includes(r.id) ? `
            <button data-mid="${esc(r.id)}" data-mact="${r.activo}"
              style="font-size:11px;padding:3px 10px;border:1px solid #ccc;
                     background:#fff;border-radius:4px;cursor:pointer;">
              ${r.activo ? 'Desactivar' : 'Activar'}
            </button>` : ''}
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('[data-mid]').forEach(btn => {
      btn.addEventListener('click', () => toggleMedio(btn.dataset.mid, btn.dataset.mact === '1'));
    });
    listEl.querySelectorAll('[data-medit]').forEach(btn => {
      btn.addEventListener('click', () => editarMedio(btn.dataset.medit));
    });
  }

  function editarMedio(id) {
    const rows = window.SGA_DB.query(`SELECT id, nombre, icono FROM medios_cobro WHERE id = ?`, [id]);
    if (!rows.length) return;
    ge('cfg-nuevo-medio-nombre').value = rows[0].nombre;
    ge('cfg-nuevo-medio-icono').value  = rows[0].icono || '';
    ge('cfg-medio-edit-id').value      = rows[0].id;
    ge('cfg-nuevo-medio-form').style.display = 'block';
    ge('cfg-btn-nuevo-medio').style.display  = 'none';
    ge('cfg-nuevo-medio-nombre')?.focus();
  }

  function toggleMedio(id, isActive) {
    try {
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        `UPDATE medios_cobro SET activo = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
        [isActive ? 0 : 1, now, id]
      );
      cargarMedios();
    } catch(e) { alert('Error: ' + e.message); }
  }

  function crearMedio() {
    const nombre = (ge('cfg-nuevo-medio-nombre')?.value || '').trim();
    const icono  = (ge('cfg-nuevo-medio-icono')?.value  || '').trim();
    const editId = (ge('cfg-medio-edit-id')?.value || '').trim();
    const msgEl  = ge('cfg-medio-form-msg');
    if (!nombre) { mostrarMsg(msgEl, 'Ingresá un nombre para el medio.', 'error'); return; }
    try {
      const now = window.SGA_Utils.formatISODate(new Date());
      if (editId) {
        // Edición: no se toca el id (referenciado por ventas ya registradas)
        window.SGA_DB.run(
          `UPDATE medios_cobro SET nombre = ?, icono = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
          [nombre, icono, now, editId]
        );
      } else {
        const id = nombre.toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        const orden = (window.SGA_DB.query(
          `SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM medios_cobro`
        )[0] || {}).n || 10;
        window.SGA_DB.run(
          `INSERT OR IGNORE INTO medios_cobro (id, nombre, icono, activo, orden, sync_status, updated_at) VALUES (?, ?, ?, 1, ?, 'pending', ?)`,
          [id, nombre, icono, orden, now]
        );
      }
      ge('cfg-nuevo-medio-nombre').value = '';
      ge('cfg-nuevo-medio-icono').value  = '';
      ge('cfg-medio-edit-id').value      = '';
      ge('cfg-nuevo-medio-form').style.display = 'none';
      ge('cfg-btn-nuevo-medio').style.display  = '';
      cargarMedios();
      mostrarMsg(ge('cfg-nuevo-medio-msg'), editId ? 'Medio actualizado correctamente.' : 'Medio creado correctamente.', 'ok');
    } catch(e) {
      mostrarMsg(msgEl, 'Error: ' + e.message, 'error');
    }
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
        const dbFileName = window.ADMIN_MODE ? 'sga-admin.db' : 'sga.db';
        await root.removeEntry(dbFileName).catch(() => {});
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

    ge('cfg-btn-nueva-caja')?.addEventListener('click', () => {
      ge('cfg-nueva-caja-form').style.display = 'block';
      ge('cfg-btn-nueva-caja').style.display = 'none';
      ge('cfg-nueva-caja-nombre')?.focus();
    });
    ge('cfg-btn-cancelar-caja')?.addEventListener('click', () => {
      ge('cfg-nueva-caja-form').style.display = 'none';
      ge('cfg-btn-nueva-caja').style.display = '';
      ge('cfg-nueva-caja-nombre').value = '';
    });
    ge('cfg-btn-guardar-caja')?.addEventListener('click', crearCaja);

    ge('cfg-btn-nuevo-medio')?.addEventListener('click', () => {
      ge('cfg-medio-edit-id').value = '';
      ge('cfg-nuevo-medio-form').style.display = 'block';
      ge('cfg-btn-nuevo-medio').style.display = 'none';
      ge('cfg-nuevo-medio-nombre')?.focus();
    });
    ge('cfg-btn-cancelar-medio')?.addEventListener('click', () => {
      ge('cfg-nuevo-medio-form').style.display = 'none';
      ge('cfg-btn-nuevo-medio').style.display = '';
      ge('cfg-nuevo-medio-nombre').value = '';
      ge('cfg-nuevo-medio-icono').value  = '';
      ge('cfg-medio-edit-id').value      = '';
    });
    ge('cfg-btn-guardar-medio')?.addEventListener('click', crearMedio);
  }

  return { init };
})();

export default ConfiguracionModule;
