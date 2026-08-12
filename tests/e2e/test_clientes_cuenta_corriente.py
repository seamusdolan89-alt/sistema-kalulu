"""
tests/e2e/test_clientes_cuenta_corriente.py — Cuenta corriente de clientes
(POS, sga.db): un cliente con una deuda existente (venta_fiada) muestra el
saldo correcto en la lista y en su ficha, y registrar un pago desde la
ficha (sección "Cuenta Corriente") descuenta el saldo y queda reflejado
en el historial de movimientos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_clientes_cuenta_corriente.py
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

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Cliente con deuda existente ($45, venta_fiada) ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO clientes (id, nombre, apellido, telefono, activo, sync_status, updated_at)
               VALUES ('cliente-test-1', 'Juan', 'Perez', '1122334455', 1, 'pending', ?)`,
              [now]
            );
            window.SGA_DB.run(
              `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, descripcion, fecha, sync_status, updated_at)
               VALUES ('cc-test-1', 'cliente-test-1', '1', 'venta_fiada', 45, 'Venta de prueba', ?, 'pending', ?)`,
              [now, now]
            );
          }
        """)
        page.wait_for_timeout(200)

        page.evaluate("window.location.hash = 'clientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        fila = page.locator("tr", has_text="Juan Perez")
        assert "45,00" in fila.inner_text(), f"Saldo inicial inesperado en la lista: {fila.inner_text()!r}"

        print("--- Abrir ficha del cliente -> Cuenta Corriente ---")
        page.get_by_text("👁️", exact=True).click()
        page.wait_for_timeout(400)
        page.locator(".ficha-nav-item[data-section='cc']").click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "clientes_cc_inicial.png"), full_page=True)

        saldo_text = page.locator("#app").inner_text()
        assert "$\xa045,00" in saldo_text or "$ 45,00" in saldo_text, (
            f"Saldo inicial en la ficha inesperado: {saldo_text[:300]!r}"
        )

        print("--- Registrar pago parcial de $20 ---")
        page.locator("#btn-registrar-pago").click()
        page.wait_for_timeout(300)
        page.fill("#cc-monto-pago", "20")
        page.fill("#cc-desc-pago", "Pago parcial test")
        page.locator("#btn-cc-pago-confirm").click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "clientes_cc_post_pago.png"), full_page=True)

        print("--- Verificar saldo tras el pago (45 - 20 = 25) ---")
        post_text = page.locator("#app").inner_text()
        assert "$\xa025,00" in post_text or "$ 25,00" in post_text, (
            f"Saldo tras pago parcial inesperado: {post_text[:300]!r}"
        )
        assert "Pago parcial test" in post_text, "El movimiento de pago no aparece en el historial"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Cuenta corriente de clientes: saldo inicial y pago parcial correctos ($45 -> $25).")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
