"""
tests/e2e/test_caja_pago_proveedor.py — Pago a Proveedor desde Caja (POS,
sga.db): completar una compra a crédito, pagarla parcialmente desde el
modal "💳 Pago a Proveedor" de Caja (tab Egresos e Ingresos), y verificar
que se registra como egreso de caja Y descuenta el saldo del proveedor en
Cuentas Corrientes — las dos cosas a la vez, en un solo movimiento.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_caja_pago_proveedor.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

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

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Compra a credito: Pepsico SA, 5 x $60 = $300 ---")
        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)
        page.locator("#cv2-search").click()
        page.keyboard.type("Coca", delay=30)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item", has_text="Coca-Cola 2L").click()
        page.wait_for_timeout(400)
        row = "tr[data-idx='0']"
        page.fill(f"{row} input[data-field='cantidad']", "5")
        page.fill(f"{row} input[data-field='costoNuevo']", "60")
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(300)
        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.get_by_text("Confirmar Ingreso", exact=False).click()
        page.wait_for_timeout(700)
        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(600)
        page.get_by_text("Finalizar", exact=False).click()
        page.wait_for_timeout(600)

        print("--- Pago parcial de $150 desde Caja > Pago a Proveedor ---")
        abrir_caja_si_hace_falta(page)
        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("Egresos e Ingresos", exact=True).click()
        page.wait_for_timeout(300)
        page.get_by_text("Pago a Proveedor", exact=False).click()
        page.wait_for_timeout(400)

        page.select_option("#pp-proveedor", label="Pepsico SA")
        page.wait_for_timeout(400)
        pendientes_text = page.locator("#pp-pendientes-info").inner_text()
        assert "300,00" in pendientes_text, f"No se ve la deuda de $300 al seleccionar el proveedor: {pendientes_text!r}"

        page.fill("#pp-monto", "150")
        page.fill("#pp-obs", "Pago parcial desde caja")
        page.locator("#btn-confirm-pagoprov").click()
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_pago_proveedor.png"), full_page=True)

        print("--- Verificar que quedo como egreso de caja ---")
        egresos_text = page.locator("#app").inner_text()
        assert "Pago Proveedor" in egresos_text and "150,00" in egresos_text, (
            f"El pago no aparece como egreso de caja: {egresos_text[:500]!r}"
        )

        print("--- Verificar que el saldo del proveedor bajo a $150 ---")
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        cc_text = page.locator("#app").inner_text()
        assert "150,00" in cc_text, f"El saldo de Pepsico deberia ser $150,00 tras el pago parcial: {cc_text[:400]!r}"
        assert "300,00" not in cc_text, f"No deberia seguir figurando el saldo original de $300,00: {cc_text[:400]!r}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Pago a Proveedor desde Caja: descuenta caja y cuenta corriente del proveedor a la vez.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
