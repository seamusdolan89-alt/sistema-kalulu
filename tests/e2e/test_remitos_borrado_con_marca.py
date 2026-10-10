"""
tests/e2e/test_remitos_borrado_con_marca.py — Encontrado 10/10/2026: el usuario
necesitaba borrar un remito cargado por error (duplicado) y no había forma de
hacerlo -- ni en la UI ni, se descubrió, a nivel de datos: 'remitos' nunca
estuvo registrado en HIJOS_DE (db.js), así que `registrarEliminacion('remitos',
id)` tiraba un warn y no hacía nada. El receptor (`applyRemito`, sync.js) SÍ
chequeaba `fueEliminado('remitos', id)` desde que se creó la tabla -- el gap
era solo del lado de REGISTRAR el borrado, nunca se había usado hasta ahora.

Cubre: registrarEliminacion dentro de HIJOS_DE no tira warning y deja la fila
en `eliminaciones`; aplicarEliminacion borra el remito y sus remito_items;
fueEliminado da true después.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_remitos_borrado_con_marca.py
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

        print("--- Sembrar un remito con items, mal cargado ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;
            const prov = window.SGA_DB.query('SELECT id FROM proveedores LIMIT 1')[0].id;
            window.SGA_DB.run(
              `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
               VALUES ('remito-borrar-test', '1', ?, ?, ?, 'R-ERROR', 'pendiente', 'synced', ?)`,
              [prov, usuarioId, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
               SELECT 'ri-borrar-test', 'remito-borrar-test', id, 3, 'Unidad', 1 FROM productos LIMIT 1`
            );
          }
        """)

        print("--- registrarEliminacion('remitos', ...) NO debe tirar warning ni dejar afuera a remitos ---")
        warns = []
        page.on("console", lambda msg: warns.append(msg.text) if msg.type == "warning" else None)
        page.evaluate("() => window.SGA_DB.registrarEliminacion('remitos', 'remito-borrar-test')")
        page.wait_for_timeout(100)
        warn_relevante = [w for w in warns if "no habilitada" in w and "remitos" in w]
        assert not warn_relevante, f"BUG: registrarEliminacion sigue rechazando 'remitos': {warn_relevante}"

        marca = q(page, "SELECT * FROM eliminaciones WHERE tabla='remitos' AND registro_id='remito-borrar-test'")
        assert len(marca) == 1, f"BUG: no quedo la marca de eliminacion para el remito: {marca}"
        print(f"   OK - marca registrada: {marca[0]}")

        fue_eliminado = page.evaluate("() => window.SGA_DB.fueEliminado('remitos', 'remito-borrar-test')")
        assert fue_eliminado is True, "fueEliminado deberia dar true despues de registrar la marca"

        print("--- aplicarEliminacion('remitos', ...) debe borrar el remito y sus items ---")
        aplicado = page.evaluate("() => window.SGA_DB.aplicarEliminacion('remitos', 'remito-borrar-test')")
        assert aplicado is True, f"aplicarEliminacion deberia devolver true: {aplicado}"

        remito_restante = q(page, "SELECT * FROM remitos WHERE id='remito-borrar-test'")
        items_restantes = q(page, "SELECT * FROM remito_items WHERE remito_id='remito-borrar-test'")
        assert remito_restante == [], f"BUG: el remito no se borro: {remito_restante}"
        assert items_restantes == [], f"BUG: los remito_items no se borraron: {items_restantes}"
        print("   OK - remito y remito_items borrados")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_remitos_borrado_con_marca: PASA "
              "('remitos' ya esta habilitada en HIJOS_DE para borrado-con-marca)")


if __name__ == "__main__":
    main()
