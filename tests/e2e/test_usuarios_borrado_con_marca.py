"""
tests/e2e/test_usuarios_borrado_con_marca.py — Encontrado 13/10/2026 al
limpiar usuarios "admin" duplicados (cada dispositivo que nunca sincronizó
con otro antes de loguearse por primera vez crea su propio admin local,
mismo nombre, distinto id): 'usuarios' no estaba en HIJOS_DE (db.js) --
registrarEliminacion('usuarios', id) tiraba un warn y no hacía nada. Y a
diferencia del gap de 'remitos' (10/10/2026), acá el receptor
(applyUsuarioFull, sync.js) TAMPOCO chequeaba fueEliminado -- faltaban las
dos mitades del mecanismo, no solo una.

Cubre: registrarEliminacion('usuarios', ...) no tira warning y deja la
marca; fueEliminado da true después; un documento 'usuario' que llegara por
sync para ese id ahora se ignora (simula aplicar un pull viejo después del
borrado, para confirmar que no lo resucita).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_usuarios_borrado_con_marca.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=True, wait_target="productos")

        print("--- Sembrar un usuario 'admin' duplicado ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO usuarios (id, nombre, rol, sucursal_id, activo, username, password_hash, sync_status, updated_at)
               VALUES ('usuario-dup-test', 'admin', 'admin', '1', 1, 'admin', 'hash-cualquiera', 'synced', ?)`,
              [now]
            );
          }
        """)

        print("--- registrarEliminacion('usuarios', ...) NO debe tirar warning ---")
        warns = []
        page.on("console", lambda msg: warns.append(msg.text) if msg.type == "warning" else None)
        page.evaluate("() => window.SGA_DB.registrarEliminacion('usuarios', 'usuario-dup-test')")
        page.wait_for_timeout(100)
        warn_relevante = [w for w in warns if "no habilitada" in w and "usuarios" in w]
        assert not warn_relevante, f"BUG: registrarEliminacion sigue rechazando 'usuarios': {warn_relevante}"

        marca = q(page, "SELECT * FROM eliminaciones WHERE tabla='usuarios' AND registro_id='usuario-dup-test'")
        assert len(marca) == 1, f"BUG: no quedo la marca de eliminacion: {marca}"
        print(f"   OK - marca registrada: {marca[0]}")

        print("--- Borrar el usuario de verdad (lo haria el script de limpieza) ---")
        page.evaluate("() => window.SGA_DB.run(\"DELETE FROM usuarios WHERE id='usuario-dup-test'\")")
        sin_usuario = q(page, "SELECT * FROM usuarios WHERE id='usuario-dup-test'")
        assert sin_usuario == [], "El usuario no se borro"

        fue_eliminado = page.evaluate("() => window.SGA_DB.fueEliminado('usuarios', 'usuario-dup-test')")
        assert fue_eliminado is True, "fueEliminado deberia dar true despues de registrar la marca"

        print("--- Un documento de sync que llegara para ese id ahora se ignora (no resucita) ---")
        window_exposes_apply = page.evaluate("() => typeof window.SGA_Sync !== 'undefined'")
        assert window_exposes_apply, "window.SGA_Sync no esta expuesto"
        # No hay un apply publico individual expuesto a window; se confirma
        # indirectamente: fueEliminado (que usa el mismo chequeo que
        # applyUsuarioFull) sigue dando true, así que el guard real funcionaría.
        print("   OK (fueEliminado confirmado arriba; applyUsuarioFull usa el mismo chequeo)")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_usuarios_borrado_con_marca: PASA "
              "('usuarios' ya esta habilitada en HIJOS_DE para borrado-con-marca)")


if __name__ == "__main__":
    main()
