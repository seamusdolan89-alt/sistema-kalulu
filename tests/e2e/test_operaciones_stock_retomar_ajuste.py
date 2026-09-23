"""
tests/e2e/test_operaciones_stock_retomar_ajuste.py — El boton "Retomar ahora"
del banner "Ajuste de precios pendiente" (Operaciones de Stock) llevaba a
un 404 -- reportado por el usuario probando c0bf23c (pausar en Ajuste de
Precios).

Causa: el handler de data-action="retomar" navegaba a `#compras`, la ruta
vieja de antes de que el modulo se renombrara a compras_v2 -- views/compras.html
no existe. El boton hermano ("Compras", en el mismo switch) ya usaba
`#compras_v2` correctamente; el de "retomar" quedo con el hash viejo.
compras_v2.js SI sabe leer sessionStorage.compras_v2_retomar al iniciar
(retoma en el paso de Ajuste de Precios) -- el unico roto era el hash.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_retomar_ajuste.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Simular un ajuste de precios pausado (ajustes_precio_pendientes, ya no localStorage) ---")
        page.evaluate("""
          () => {
            const suc = window.SGA_Auth.getCurrentUser().sucursal_id;
            const snapshot = JSON.stringify({
              step: 'post-compra',
              items: [],
              herenciaSincs: [],
              snap: {
                proveedorNombre: 'Bimbo', facturaPv: '1', numeroFactura: '123',
                totalCompra: 10000, neto: 10000
              }
            });
            window.SGA_DB.run(
              `INSERT OR REPLACE INTO ajustes_precio_pendientes
                 (id, sucursal_id, usuario_id, snapshot, created_at, updated_at, sync_status)
               VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
              [`ajuste_precio_pendiente:${suc}`, suc, window.SGA_Auth.getCurrentUser().id,
               snapshot, new Date().toISOString(), new Date().toISOString()]
            );
          }
        """)

        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- El banner 'Ajuste de precios pendiente' esta visible ---")
        assert page.locator("#ops-pending-card").is_visible(), (
            "El banner de ajuste pendiente deberia mostrarse con la fila de ajustes_precio_pendientes"
        )

        print("--- Click en 'Retomar ahora ->' ---")
        page.locator('[data-action="retomar"]').click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ops_retomar_ajuste.png"), full_page=True)

        hash_actual = page.evaluate("() => window.location.hash")
        print(f"Hash tras Retomar: {hash_actual!r}")
        assert hash_actual == "#compras_v2", (
            f"BUG: deberia navegar a #compras_v2, quedo en {hash_actual!r}"
        )

        page_text = page.locator("#app").inner_text()
        assert "Could not load module" not in page_text and "404" not in page_text, (
            f"BUG: la vista no cargo (regresion del 404 en views/compras.html): {page_text[:300]!r}"
        )
        assert "AJUSTE DE PRECIOS" in page_text.upper(), (
            f"No se ve la pantalla de Ajuste de Precios tras Retomar: {page_text[:300]!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - 'Retomar ahora' lleva a Ajuste de Precios (compras_v2), ya no rompe con 404.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
