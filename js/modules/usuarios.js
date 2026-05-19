/**
 * usuarios.js — Gestión de Usuarios (solo admin)
 *
 * Permite crear, editar y desactivar usuarios.
 * Cada usuario no-admin tiene permisos individuales configurables con checkboxes.
 */

const UsuariosModule = (() => {
  'use strict';

  function init() {
    const currentUser = window.SGA_Auth.getCurrentUser();
    if (!currentUser || currentUser.rol !== 'admin') {
      document.getElementById('app').innerHTML =
        '<div class="alert alert-danger">Acceso restringido. Solo administradores.</div>';
      return;
    }
    renderTabla();
    bindEvents();
  }

  // ─── Tabla ────────────────────────────────────────────────────────────────

  function renderTabla() {
    const rows = window.SGA_DB.query(
      `SELECT id, nombre, username, rol, activo FROM usuarios ORDER BY nombre`
    );

    const tbody = document.getElementById('tbody-usuarios');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-secondary);">Sin usuarios registrados.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(u => `
      <tr class="${!u.activo ? 'row-inactivo' : ''}">
        <td>${esc(u.nombre)}</td>
        <td><code>${esc(u.username || '—')}</code></td>
        <td>${u.rol === 'admin' ? '<span class="badge badge-primary">Administrador</span>' : '<span class="badge badge-secondary">Colaborador</span>'}</td>
        <td>
          <span class="badge ${u.activo ? 'badge-success' : 'badge-secondary'}">
            ${u.activo ? 'Activo' : 'Inactivo'}
          </span>
        </td>
        <td style="text-align:center;">
          <button class="btn btn-sm btn-secondary btn-editar-usuario" data-id="${u.id}">Editar</button>
        </td>
      </tr>
    `).join('');

    document.querySelectorAll('.btn-editar-usuario').forEach(btn => {
      btn.addEventListener('click', () => abrirModalEditar(btn.dataset.id));
    });
  }

  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ─── Panel de permisos ───────────────────────────────────────────────────

  function renderPermisosSection(permisos, isAdmin) {
    const section = document.getElementById('permisos-section');
    if (!section) return;

    if (isAdmin) {
      section.innerHTML = `
        <div style="padding:14px 16px;background:#e8f5e9;border:1.5px solid #a5d6a7;border-radius:8px;">
          <strong style="color:#1b5e20;">✅ Acceso total</strong>
          <p style="margin:4px 0 0;font-size:13px;color:#388e3c;">Los administradores tienen todos los permisos sin restricciones.</p>
        </div>`;
      return;
    }

    // Agrupar por grupo
    const def = window.SGA_PERMISOS_DEF || [];
    const grupos = [...new Set(def.map(p => p.grupo))];

    const gruposHtml = grupos.map(grupo => {
      const items = def.filter(p => p.grupo === grupo);
      const itemsHtml = items.map(p => {
        if (p.tipo === 'number') {
          const val = permisos[p.key] !== undefined ? permisos[p.key] : p.default;
          return `
            <div class="permiso-row" style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f0f0f0;">
              <label style="flex:1;font-size:14px;color:var(--color-text);">${esc(p.label)}</label>
              <input type="number" class="permiso-input" data-key="${p.key}"
                min="${p.min ?? 0}" max="${p.max ?? 100}" value="${val}"
                style="width:68px;padding:4px 8px;border:1.5px solid #ccc;border-radius:6px;font-size:14px;text-align:center;">
              <span style="font-size:13px;color:#666;">%</span>
            </div>`;
        }
        const checked = permisos[p.key] !== undefined ? permisos[p.key] : p.default;
        return `
          <div class="permiso-row" style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f0f0f0;">
            <input type="checkbox" class="permiso-check" data-key="${p.key}" id="perm-${p.key}" ${checked ? 'checked' : ''}
              style="width:17px;height:17px;cursor:pointer;accent-color:var(--color-primary);">
            <label for="perm-${p.key}" style="flex:1;font-size:14px;color:var(--color-text);cursor:pointer;">${esc(p.label)}</label>
          </div>`;
      }).join('');

      return `
        <div style="margin-bottom:4px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:12px 0 4px;">${esc(grupo)}</div>
          ${itemsHtml}
        </div>`;
    }).join('');

    section.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button type="button" id="btn-check-all" class="btn btn-sm" style="font-size:12px;padding:3px 10px;">Marcar todo</button>
        <button type="button" id="btn-uncheck-all" class="btn btn-sm btn-secondary" style="font-size:12px;padding:3px 10px;">Desmarcar todo</button>
      </div>
      <div style="border:1.5px solid #e0e0e0;border-radius:8px;padding:8px 14px;">
        ${gruposHtml}
      </div>
      <p style="font-size:12px;color:#999;margin:8px 0 0;">Los cambios aplican al próximo inicio de sesión del usuario.</p>`;

    document.getElementById('btn-check-all')?.addEventListener('click', () => {
      section.querySelectorAll('.permiso-check').forEach(cb => { cb.checked = true; });
      section.querySelectorAll('.permiso-input').forEach(inp => { inp.value = inp.max || 100; });
    });
    document.getElementById('btn-uncheck-all')?.addEventListener('click', () => {
      section.querySelectorAll('.permiso-check').forEach(cb => { cb.checked = false; });
      section.querySelectorAll('.permiso-input').forEach(inp => { inp.value = 0; });
    });
  }

  function leerPermisosDesdeForm() {
    const section = document.getElementById('permisos-section');
    if (!section) return null;
    const permisos = {};
    section.querySelectorAll('.permiso-check').forEach(cb => {
      permisos[cb.dataset.key] = cb.checked;
    });
    section.querySelectorAll('.permiso-input').forEach(inp => {
      permisos[inp.dataset.key] = parseFloat(inp.value) || 0;
    });
    return permisos;
  }

  // ─── Modal ────────────────────────────────────────────────────────────────

  function abrirModalNuevo() {
    document.getElementById('modal-usuario-titulo').textContent = 'Nuevo Usuario';
    document.getElementById('usuario-id').value = '';
    document.getElementById('usuario-nombre').value = '';
    document.getElementById('usuario-username').value = '';
    document.getElementById('usuario-rol').value = '';
    document.getElementById('usuario-password').value = '';
    document.getElementById('usuario-activo').value = '1';
    document.getElementById('usuario-password').required = true;
    document.getElementById('label-password').textContent = 'Contraseña *';
    document.getElementById('hint-password').style.display = 'none';
    document.getElementById('error-usuario').style.display = 'none';
    renderPermisosSection({}, false);
    document.getElementById('modal-usuario').style.display = 'flex';
    document.getElementById('usuario-nombre').focus();

    // Actualizar panel según rol seleccionado
    document.getElementById('usuario-rol').onchange = () => actualizarPanelRol({});
  }

  function abrirModalEditar(id) {
    const rows = window.SGA_DB.query(`SELECT * FROM usuarios WHERE id = ?`, [id]);
    if (!rows.length) return;
    const u = rows[0];

    document.getElementById('modal-usuario-titulo').textContent = 'Editar Usuario';
    document.getElementById('usuario-id').value = u.id;
    document.getElementById('usuario-nombre').value = u.nombre;
    document.getElementById('usuario-username').value = u.username || '';
    // Normalizar roles legacy (encargado/cajero) al nuevo sistema
    document.getElementById('usuario-rol').value = u.rol === 'admin' ? 'admin' : 'colaborador';
    document.getElementById('usuario-password').value = '';
    document.getElementById('usuario-activo').value = u.activo ? '1' : '0';
    document.getElementById('usuario-password').required = false;
    document.getElementById('label-password').textContent = 'Nueva Contraseña';
    document.getElementById('hint-password').style.display = '';
    document.getElementById('error-usuario').style.display = 'none';

    let permisos = {};
    if (u.permisos_json) {
      try { permisos = JSON.parse(u.permisos_json); } catch {}
    }
    renderPermisosSection(permisos, u.rol === 'admin');

    document.getElementById('modal-usuario').style.display = 'flex';
    document.getElementById('usuario-nombre').focus();

    document.getElementById('usuario-rol').onchange = () => actualizarPanelRol(permisos);
  }

  function actualizarPanelRol(permisos) {
    const rol = document.getElementById('usuario-rol').value;
    renderPermisosSection(permisos, rol === 'admin');
  }

  function cerrarModal() {
    document.getElementById('modal-usuario').style.display = 'none';
    document.getElementById('usuario-rol').onchange = null;
  }

  // ─── Guardar ──────────────────────────────────────────────────────────────

  async function guardarUsuario() {
    const id       = document.getElementById('usuario-id').value.trim();
    const nombre   = document.getElementById('usuario-nombre').value.trim();
    const username = document.getElementById('usuario-username').value.trim().toLowerCase();
    const rol      = document.getElementById('usuario-rol').value;
    const password = document.getElementById('usuario-password').value;
    const activo   = document.getElementById('usuario-activo').value;
    const errorEl  = document.getElementById('error-usuario');

    if (!nombre || !username || !rol) {
      mostrarError('Completá todos los campos obligatorios.');
      return;
    }
    if (!/^[a-z0-9._]+$/.test(username)) {
      mostrarError('El nombre de usuario solo puede contener letras minúsculas, números, puntos y guiones bajos.');
      return;
    }
    if (!id && !password) {
      mostrarError('La contraseña es obligatoria para usuarios nuevos.');
      return;
    }
    if (password && password.length < 4) {
      mostrarError('La contraseña debe tener al menos 4 caracteres.');
      return;
    }

    const existentes = window.SGA_DB.query(
      `SELECT id FROM usuarios WHERE username = ? AND id != ?`,
      [username, id || '']
    );
    if (existentes.length > 0) {
      mostrarError('Ya existe un usuario con ese nombre de usuario.');
      return;
    }

    const btn = document.getElementById('btn-guardar-usuario');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const now         = new Date().toISOString();
      const sucursal_id = window.SGA_Auth.getCurrentUser().sucursal_id || '1';
      // 'colaborador' es el label UI; internamente se guarda como 'cajero' para respetar el CHECK constraint
      const rolDB       = rol === 'colaborador' ? 'cajero' : rol;
      const permisos    = rol === 'admin' ? null : JSON.stringify(leerPermisosDesdeForm() || {});

      if (id) {
        if (password) {
          const hash = await window.SGA_Auth.hashPassword(password);
          window.SGA_DB.run(
            `UPDATE usuarios SET nombre=?, username=?, password_hash=?, rol=?, activo=?, permisos_json=?, updated_at=? WHERE id=?`,
            [nombre, username, hash, rolDB, activo, permisos, now, id]
          );
        } else {
          window.SGA_DB.run(
            `UPDATE usuarios SET nombre=?, username=?, rol=?, activo=?, permisos_json=?, updated_at=? WHERE id=?`,
            [nombre, username, rolDB, activo, permisos, now, id]
          );
        }
      } else {
        const hash  = await window.SGA_Auth.hashPassword(password);
        const newId = window.SGA_Utils.generateUUID();
        window.SGA_DB.run(
          `INSERT INTO usuarios (id, nombre, username, password_hash, rol, sucursal_id, activo, permisos_json, sync_status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [newId, nombre, username, hash, rolDB, sucursal_id, activo, permisos, now]
        );
      }

      cerrarModal();
      renderTabla();
    } catch (err) {
      mostrarError('Error al guardar: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
  }

  function mostrarError(msg) {
    const el = document.getElementById('error-usuario');
    el.textContent = msg;
    el.style.display = '';
  }

  // ─── Eventos ──────────────────────────────────────────────────────────────

  function bindEvents() {
    document.getElementById('btn-nuevo-usuario').addEventListener('click', abrirModalNuevo);
    document.getElementById('btn-cerrar-modal-usuario').addEventListener('click', cerrarModal);
    document.getElementById('btn-cancelar-usuario').addEventListener('click', cerrarModal);
    document.getElementById('btn-guardar-usuario').addEventListener('click', guardarUsuario);

    document.getElementById('modal-usuario').addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-usuario')) cerrarModal();
    });

    document.getElementById('usuario-username').addEventListener('input', (e) => {
      e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
    });

  }

  return { init };
})();

export default UsuariosModule;
