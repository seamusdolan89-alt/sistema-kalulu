"""
tests/e2e/test_cuenta_corriente_proveedores.py — Flujo completo de cuenta
corriente de proveedores (admin-pos): completar una compra a crédito (toda
compra en este sistema queda "Cta. Cte." — ver compras_v2.js, la condición
de pago está fija) genera el saldo correcto en Cuentas Corrientes, y
registrar un pago parcial lo imputa automáticamente por antigüedad y
descuenta el saldo.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_cuenta_corriente_proveedores.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def completar_compra_pepsico(page, cantidad, costo):
    """Compra 'Remito' (sin factura/IVA) a Pepsico SA de Coca-Cola 2L, la
    confirma y la finaliza. Toda compra queda Cta. Cte. — ver comentario en
    compras_v2.js ~linea 3569 ("Condición de pago fija: siempre cuenta
    corriente"). Devuelve el total esperado (cantidad * costo)."""
    page.evaluate("window.location.hash = 'compras_v2'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(300)
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
    page.fill(f"{row} input[data-field='cantidad']", str(cantidad))
    page.fill(f"{row} input[data-field='costoNuevo']", str(costo))
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

    return cantidad * costo


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
        page.on("dialog", lambda d: d.accept())  # confirm()/alert() nativos

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Completar compra a credito: 5 x $60 = $300 ---")
        total_esperado = completar_compra_pepsico(page, cantidad=5, costo=60)
        assert total_esperado == 300

        print("--- Verificar saldo en Cuentas Corrientes ---")
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "cc_saldo_inicial.png"), full_page=True)

        fila_pepsico = page.locator("tr", has_text="Pepsico SA")
        saldo_text = fila_pepsico.inner_text()
        assert "300,00" in saldo_text, f"Saldo inicial inesperado tras la compra: {saldo_text!r}"
        print("OK - Saldo inicial: $ 300,00")

        print("--- Registrar pago parcial de $100 (Transferencia) ---")
        page.get_by_text("+ Registrar Pago", exact=False).click()
        page.wait_for_timeout(400)
        page.select_option("#mp-proveedor", label="Pepsico SA")
        page.wait_for_timeout(400)
        page.check("#chk-transferencia")
        page.fill("#mp-tr-monto", "100")
        page.wait_for_timeout(300)

        total_pago = page.locator("text=Total del pago:").locator("xpath=following-sibling::*[1]").inner_text().strip()
        assert "100,00" in total_pago, f"Total del pago mostrado inesperado: {total_pago!r}"

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "cc_modal_pago.png"), full_page=True)
        page.get_by_text("Guardar pago", exact=False).click()
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "cc_saldo_post_pago.png"), full_page=True)

        print("--- Verificar saldo tras el pago (300 - 100 = 200) ---")
        fila_pepsico = page.locator("tr", has_text="Pepsico SA")
        saldo_text = fila_pepsico.inner_text()
        assert "200,00" in saldo_text, f"Saldo tras pago parcial inesperado: {saldo_text!r}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Cuentas Corrientes: compra genera saldo correcto y el pago se imputa y descuenta bien.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
