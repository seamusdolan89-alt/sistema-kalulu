/**
 * usuarios.js — Gestión de Usuarios (solo admin)
 *
 * Permite crear, editar y desactivar usuarios del sistema.
 * Las contraseñas se almacenan como SHA-256 en la columna password_hash.
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

  // ─── Render ───────────────────────────────────────────────────────────────

  function renderTabla() {
    const rows = window.SGA_DB.query(
      `SELECT id, nombre, username, rol, activo FROM usuarios ORDER BY nombre`
    );

    const tbody = document.getElementById('tbody-usuarios');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-secondary);">Sin usuarios registrados.</td></tr>';
      return;
    }

    const rolLabel = { admin: 'Administrador', encargado: 'Encargado', cajero: 'Cajero' };

    tbody.innerHTML = rows.map(u => `
      <tr class="${!u.activo ? 'row-inactivo' : ''}">
        <td>${u.nombre}</td>
        <td><code>${u.username || '—'}</code></td>
        <td>${rolLabel[u.rol] || u.rol}</td>
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
    document.getElementById('modal-usuario').style.display = 'flex';
    document.getElementById('usuario-nombre').focus();
  }

  function abrirModalEditar(id) {
    const rows = window.SGA_DB.query(`SELECT * FROM usuarios WHERE id = ?`, [id]);
    if (!rows.length) return;
    const u = rows[0];

    document.getElementById('modal-usuario-titulo').textContent = 'Editar Usuario';
    document.getElementById('usuario-id').value = u.id;
    document.getElementById('usuario-nombre').value = u.nombre;
    document.getElementById('usuario-username').value = u.username || '';
    document.getElementById('usuario-rol').value = u.rol;
    document.getElementById('usuario-password').value = '';
    document.getElementById('usuario-activo').value = u.activo ? '1' : '0';
    document.getElementById('usuario-password').required = false;
    document.getElementById('label-password').textContent = 'Nueva Contraseña';
    document.getElementById('hint-password').style.display = '';
    document.getElementById('error-usuario').style.display = 'none';
    document.getElementById('modal-usuario').style.display = 'flex';
    document.getElementById('usuario-nombre').focus();
  }

  function cerrarModal() {
    document.getElementById('modal-usuario').style.display = 'none';
  }

  // ─── Guardar ──────────────────────────────────────────────────────────────

  async function guardarUsuario() {
    const id        = document.getElementById('usuario-id').value.trim();
    const nombre    = document.getElementById('usuario-nombre').value.trim();
    const username  = document.getElementById('usuario-username').value.trim().toLowerCase();
    const rol       = document.getElementById('usuario-rol').value;
    const password  = document.getElementById('usuario-password').value;
    const activo    = document.getElementById('usuario-activo').value;
    const errorEl   = document.getElementById('error-usuario');

    // Validaciones básicas
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

    // Verificar username único
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
      const now = new Date().toISOString();
      const sucursal_id = window.SGA_Auth.getCurrentUser().sucursal_id || '1';

      if (id) {
        // Editar
        if (password) {
          const hash = await window.SGA_Auth.hashPassword(password);
          window.SGA_DB.run(
            `UPDATE usuarios SET nombre=?, username=?, password_hash=?, rol=?, activo=?, updated_at=? WHERE id=?`,
            [nombre, username, hash, rol, activo, now, id]
          );
        } else {
          window.SGA_DB.run(
            `UPDATE usuarios SET nombre=?, username=?, rol=?, activo=?, updated_at=? WHERE id=?`,
            [nombre, username, rol, activo, now, id]
          );
        }
      } else {
        // Nuevo
        const hash = await window.SGA_Auth.hashPassword(password);
        const newId = window.SGA_Utils.generateUUID();
        window.SGA_DB.run(
          `INSERT INTO usuarios (id, nombre, username, password_hash, rol, sucursal_id, activo, sync_status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [newId, nombre, username, hash, rol, sucursal_id, activo, now]
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

    // Cerrar al hacer click fuera del modal
    document.getElementById('modal-usuario').addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-usuario')) cerrarModal();
    });

    // Normalizar username mientras se escribe
    document.getElementById('usuario-username').addEventListener('input', (e) => {
      e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
    });
  }

  return { init };
})();

export default UsuariosModule;
