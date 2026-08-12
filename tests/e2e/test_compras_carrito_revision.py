"""
tests/e2e/test_compras_carrito_revision.py — Regresión del fix
"compras-v2-descuento-iva" (ver memoria del proyecto): el subtotal de línea
del Carrito (con descuento aplicado) debe coincidir exactamente con el
subtotal que muestra la pantalla de Revisión antes de confirmar el ingreso.
Antes del fix, Revisión recalculaba cantidad × costo ignorando el
descuento, y no coincidía con el Carrito.

También cubre: aparición de la columna IVA en el Carrito solo para
Factura A, y que el cálculo de IVA 21% sobre el subtotal neto sea correcto.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_carrito_revision.py
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
        context = browser.new_context(viewport={"width": 1800, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Nueva compra: Tradicional -> Pepsico SA -> Factura A ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Factura A")
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        print("--- Agregar Coca-Cola 2L y cargar cantidad/costo/descuento/IVA ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("Coca", delay=30)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item", has_text="Coca-Cola 2L").click()
        page.wait_for_timeout(400)

        row = "tr[data-idx='0']"
        # Columna IVA debe existir en el Carrito porque la condicion es Factura A
        iva_select = page.locator(f"{row} select[data-field='iva']")
        assert iva_select.count() == 1, "No aparecio la columna IVA en el Carrito para Factura A"

        page.fill(f"{row} input[data-field='cantidad']", "3")
        page.fill(f"{row} input[data-field='costoNuevo']", "100")
        page.fill(f"{row} input[data-field='descuento']", "10")
        page.locator(f"{row} input[data-field='descuento']").blur()
        page.wait_for_timeout(300)
        page.select_option(f"{row} select[data-field='iva']", "21")
        page.wait_for_timeout(300)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_carrito.png"), full_page=True)

        # 3 x $100 con 10% de descuento = $270,00
        EXPECTED_SUBTOTAL = "$\xa0270,00"
        cart_subtotal = page.locator(f"{row} .cv2-subtotal").inner_text().strip()
        assert cart_subtotal == EXPECTED_SUBTOTAL, (
            f"Subtotal de linea en Carrito inesperado: {cart_subtotal!r} (esperado {EXPECTED_SUBTOTAL!r})"
        )

        # IVA 21% calculado sobre el subtotal neto (270 * 0.21 = 56.70)
        iva21_calc = page.locator("text=IVA 21% (CALC.)").locator("xpath=following-sibling::*[1]").inner_text().strip()
        assert "56,70" in iva21_calc, f"IVA 21% calculado inesperado: {iva21_calc!r}"

        print(f"OK - Subtotal Carrito: {cart_subtotal}, IVA 21% calc: {iva21_calc}")

        print("--- Siguiente -> pantalla de Revision ---")
        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_revision.png"), full_page=True)

        # Regresion clave: el subtotal de la fila en Revision debe ser IGUAL
        # al del Carrito (antes del fix, Revision ignoraba el descuento).
        revision_row_text = page.locator("table", has_text="COSTO UNIT.").locator("tbody tr").first.inner_text()
        assert "270,00" in revision_row_text, (
            f"Subtotal en Revision no coincide con el Carrito (esperado 270,00): {revision_row_text!r}"
        )
        assert "10.0%" in revision_row_text or "10,0%" in revision_row_text, (
            f"Revision no muestra el descuento de la linea: {revision_row_text!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Compras: subtotal con descuento coincide entre Carrito y Revision (fix compras-v2-descuento-iva).")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
