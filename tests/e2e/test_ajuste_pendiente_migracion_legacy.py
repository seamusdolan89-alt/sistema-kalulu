"""
tests/e2e/test_ajuste_pendiente_migracion_legacy.py — Un ajuste de precios que
quedó pausado ANTES del fix de sincronización (23/9/2026, ver
project_ajuste_precio_pendiente_sync) vivía en localStorage
('compras_resumen_pending') de la compu donde se pausó. El fix hace que todas
las pantallas lean la tabla `ajustes_precio_pendientes` en vez de esa clave —
sin una migración, el propio arreglo hacía DESAPARECER de la vista lo que ya
estaba pausado (sigue en localStorage, pero ninguna pantalla lo lee más ahí).

Caso real que motivó esto: el usuario le pidió a una cajera pausar una compra
de "Vital" en el paso de Ajuste de Precios; ese pausado es justamente el que
había que poder recuperar al promover el fix a producción.

Fix: js/app.js `initNav()` (se llama en cada navegación) migra una sola vez la
clave vieja a `ajustes_precio_pendientes` si existe, y la limpia. Idempotente:
localStorage.getItem devuelve null apenas migra.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ajuste_pendiente_migracion_legacy.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Simular un ajuste de precios pausado ANTES del fix (localStorage crudo) ---")
        legacy_payload = {
            "step": "post-compra",
            "items": [{"productoId": "p1", "nombre": "Coca 2L", "pvActual": 90, "pvSugerido": 95}],
            "herenciaSincs": [],
            "snap": {"proveedorNombre": "Vital", "totalCompra": 516131.157, "neto": 516131.157},
        }
        page.evaluate(
            "(p) => localStorage.setItem('compras_resumen_pending', JSON.stringify(p))",
            legacy_payload,
        )

        print("--- Navegar dispara initNav() -> migracion ---")
        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        suc = page.evaluate("() => window.SGA_Auth.getCurrentUser().sucursal_id")
        row = page.evaluate(
            "(s) => window.SGA_DB.query('SELECT * FROM ajustes_precio_pendientes WHERE sucursal_id = ?', [s])[0] || null",
            suc,
        )
        assert row is not None, "BUG: el ajuste pausado en localStorage no se migro a ajustes_precio_pendientes"
        assert row["sync_status"] == "pending", f"la fila migrada deberia quedar 'pending' para subir: {row}"
        assert "Vital" in row["snapshot"], f"el snapshot migrado no es el esperado: {row}"
        print(f"   OK - se migro el ajuste de 'Vital' a la tabla nueva (id={row['id']})")

        legacy_after = page.evaluate("() => localStorage.getItem('compras_resumen_pending')")
        assert legacy_after is None, f"la clave vieja de localStorage deberia haberse limpiado, sigue: {legacy_after!r}"
        print("   OK - localStorage.compras_resumen_pending quedo limpio")

        print("--- El banner de 'Ajuste pendiente' en el menu se ve con el dato migrado ---")
        nav_text = page.locator("aside.sidebar nav").inner_text()
        assert "Ajuste pendiente" in nav_text, f"el badge del menu no aparece tras migrar: {nav_text!r}"
        print("   OK - el menu ya lo muestra")

        print("--- Navegar de nuevo no duplica la fila (idempotente) ---")
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_timeout(200)
        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_timeout(300)
        rows = page.evaluate(
            "(s) => window.SGA_DB.query('SELECT id FROM ajustes_precio_pendientes WHERE sucursal_id = ?', [s])",
            suc,
        )
        assert len(rows) == 1, f"no deberia duplicarse al re-navegar: {rows}"
        print("   OK - sigue habiendo una sola fila")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_ajuste_pendiente_migracion_legacy: PASA")


if __name__ == "__main__":
    main()
