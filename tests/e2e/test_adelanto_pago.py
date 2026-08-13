"""
tests/e2e/test_adelanto_pago.py — Adelanto de Pago a proveedor (admin only,
POS sga.db): registrar un adelanto (pago sin compra asociada todavía, se
guarda "huérfano" — auto_imputar=false, ver memoria del proyecto) y
verificar que queda en pagos_proveedores/pagos_proveedores_metodos sin
ninguna fila en imputaciones_pagos (listo para aplicarse a la próxima
compra que se cargue).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_adelanto_pago.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed (admin) ---")
        login_via_seed(page, admin_pos=False)

        print("--- Registrar adelanto $1000 (Caja Seamus) a Pepsico SA ---")
        page.evaluate("window.location.hash = 'adelanto_pago'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        page.select_option("#ap-proveedor", label="Pepsico SA")
        page.fill("#ap-monto-caja_seamus", "1000")
        page.fill("#ap-observaciones", "Adelanto para proxima compra")
        page.locator("#ap-btn-registrar").click()
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "adelanto_pago_confirmado.png"), full_page=True)

        confirm_text = page.locator("#app").inner_text()
        assert "1.000,00" in confirm_text and "Pepsico SA" in confirm_text, (
            f"No se ve la confirmacion del adelanto: {confirm_text[:400]!r}"
        )

        print("--- Verificar en la base de datos: pago huerfano, sin imputar ---")
        pagos = page.evaluate("""
          () => window.SGA_DB.query(`
            SELECT p.proveedor_id, p.observaciones, m.metodo, m.monto
            FROM pagos_proveedores p JOIN pagos_proveedores_metodos m ON m.pago_id = p.id
          `)
        """)
        assert len(pagos) == 1, f"Se esperaba 1 pago con 1 metodo, hay: {pagos}"
        assert pagos[0]["metodo"] == "caja_seamus", f"Metodo incorrecto: {pagos[0]}"
        assert abs(pagos[0]["monto"] - 1000) < 0.01, f"Monto incorrecto: {pagos[0]}"

        imputaciones = page.evaluate("() => window.SGA_DB.query('SELECT * FROM imputaciones_pagos')")
        assert imputaciones == [], f"El adelanto no deberia tener ninguna imputacion todavia (es huerfano): {imputaciones}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Adelanto de Pago: se registra correctamente como credito huerfano, listo para aplicar despues.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
