"""
tests/e2e/test_sync_usuarios_password.py

Regresión del bug real: ninguna cajera podía loguearse después de que el
admin tocara CUALQUIER campo de un usuario (ej. un permiso) desde admin-pos.

Causa: POS y admin-pos tienen cada uno su propia copia local de `usuarios`
(bases OPFS distintas). El push manda la fila ENTERA por `SELECT *`, así que
editar un permiso desde admin-pos volvía a subir también el password_hash
que esa compu tenía guardado — que podía ser viejo si esa compu nunca había
recibido el cambio de contraseña real hecho en el POS. Eso pisaba en
Firestore la contraseña vigente, y el POS la bajaba en el próximo pull
automático (cada 5 min) sin que nadie tocara nada ahí.

Fix: `password_updated_at` se sella SOLO cuando de verdad se cambia la
contraseña (usuarios.js). `applyUsuarioFull` (sync.js) usa ese sello para
decidir si el password_hash que llega es realmente más nuevo que el local
antes de pisarlo — si no, conserva la contraseña local, aunque el resto de
la fila (nombre, permisos, etc.) sí se actualice con lo que llega.

Se prueba llamando `window.SGA_Sync.applyUsuarioFull(...)` directo con un
documento simulado — no hace falta Firestore real (bloqueado de todas
formas por block_firebase) porque la función solo toca SQLite local.
"""
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from helpers import block_firebase, enable_dev_mode, login_via_seed  # noqa: E402


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()

        login_via_seed(page)  # POS, sga.db

        # 1) Crear una "cajera" local con una contraseña vigente, ya sincronizada
        #    (sync_status='synced' — no hay edición local pendiente que la proteja
        #    por la otra guarda, tienePendienteLocal).
        setup = page.evaluate("""
          () => {
            const id = 'test-cajera-1';
            const now = new Date().toISOString();
            window.SGA_DB.run(`DELETE FROM usuarios WHERE id = ?`, [id]);
            window.SGA_DB.run(`
              INSERT INTO usuarios
                (id, nombre, rol, activo, username, password_hash, password_updated_at,
                 permisos_json, sync_status, updated_at)
              VALUES (?, 'Cajera Test', 'cajero', 1, 'cajera.test', 'HASH_VIGENTE', ?, '{}', 'synced', ?)
            `, [id, now, now]);
            return { id, password_updated_at: now };
          }
        """)
        user_id = setup["id"]

        # 2) Simular lo que admin-pos empujaría a Firestore tras cambiar SOLO un
        #    permiso: la fila entera, con el password_hash viejo que esa otra
        #    compu tenía guardada (sin password_updated_at, porque esa edición
        #    no tocó la contraseña).
        result_1 = page.evaluate("""
          (userId) => {
            window.SGA_Sync.applyUsuarioFull({
              id: userId,
              nombre: 'Cajera Test',
              rol: 'cajero',
              activo: true,
              username: 'cajera.test',
              password_hash: 'HASH_VIEJO_DE_ADMIN',
              // sin password_updated_at: este pull no representa un cambio de clave
              permisos_json: '{"can_ver_productos": true}',
              updated_at: new Date().toISOString(),
            });
            const row = window.SGA_DB.query(`SELECT password_hash, permisos_json FROM usuarios WHERE id = ?`, [userId])[0];
            return row;
          }
        """, user_id)

        assert result_1["password_hash"] == "HASH_VIGENTE", (
            f"BUG: un pull que solo cambiaba un permiso pisó la contraseña vigente "
            f"con la copia vieja del otro dispositivo (quedó: {result_1['password_hash']!r})"
        )
        assert result_1["permisos_json"] == '{"can_ver_productos": true}', (
            "El resto de la fila (permisos) debe actualizarse igual — la guarda es solo para password_hash"
        )
        print("OK: permiso actualizado, contrasena vigente NO pisada por el pull")

        # 3) Ahora simular un cambio de contraseña real y más nuevo desde la otra
        #    compu (con password_updated_at posterior al local) — este SÍ debe
        #    aplicarse.
        result_2 = page.evaluate("""
          (userId) => {
            const futuro = new Date(Date.now() + 60000).toISOString();
            window.SGA_Sync.applyUsuarioFull({
              id: userId,
              nombre: 'Cajera Test',
              rol: 'cajero',
              activo: true,
              username: 'cajera.test',
              password_hash: 'HASH_NUEVO_DE_VERDAD',
              password_updated_at: futuro,
              permisos_json: '{"can_ver_productos": true}',
              updated_at: futuro,
            });
            return window.SGA_DB.query(`SELECT password_hash FROM usuarios WHERE id = ?`, [userId])[0];
          }
        """, user_id)

        assert result_2["password_hash"] == "HASH_NUEVO_DE_VERDAD", (
            f"Un cambio de contraseña real y más nuevo debe aplicarse (quedó: {result_2['password_hash']!r})"
        )
        print("OK: un cambio de contrasena real y mas nuevo si se aplica")

        browser.close()
        print("\nOK - test_sync_usuarios_password: PASA")


if __name__ == "__main__":
    run()
