"""
tests/e2e/test_pos_multiples_medios_pago.py — Regresión del bug "MPAY is not
defined" en pos.js (Cobro múltiple): el checkout con más de un medio de pago
quedaba con el botón "Confirmar Venta" permanentemente deshabilitado y sin
mostrar "Falta"/"Cubierto" ni la opción de registrar la diferencia como
deuda del cliente, porque `updateMpayStatus()` tiraba ReferenceError en
cada render/keystroke (MPAY no existía — el array correcto es MEDIOS).

Cubre el flujo completo: venta con cliente, cobro múltiple (Efectivo
parcial + resto a Cuenta Corriente del cliente), confirmación, y que la
deuda quede bien registrada en `cuenta_corriente`.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_multiples_medios_pago.py
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

        print("--- Insertar cliente de prueba (seed.js no crea clientes) ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO clientes (id, nombre, apellido, telefono, activo, sync_status, updated_at)
               VALUES ('cliente-test-1', 'Juan', 'Perez', '1122334455', 1, 'pending', ?)`,
              [now]
            );
          }
        """)
        page.wait_for_timeout(200)

        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)

        print("--- Agregar Coca-Cola 2L ($95,00) ---")
        page.locator("#pos-search-input").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#pos-search-dropdown .sri").click()
        page.wait_for_timeout(400)

        print("--- Seleccionar cliente ---")
        page.locator("#client-search-input").click()
        page.keyboard.type("Juan", delay=20)
        page.wait_for_timeout(400)
        page.locator("#client-dropdown .cri").click()
        page.wait_for_timeout(400)

        print("--- Activar Cobro Multiple ---")
        page.evaluate("""
          () => {
            const el = document.getElementById('cobro-multiple-toggle');
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        """)
        page.wait_for_timeout(300)

        print("--- Asignar $50 en Efectivo (total $95, falta $45) ---")
        efectivo_input = page.locator(".mpay-field[data-medio='efectivo']")
        efectivo_input.click()
        efectivo_input.type("50", delay=20)
        page.wait_for_timeout(300)

        # Regresion clave: el mensaje de estado y el boton deben reaccionar
        # sin tirar "MPAY is not defined".
        status_text = page.locator("#mpay-status").inner_text()
        assert "45,00" in status_text, f"No aparecio 'Falta $45,00': {status_text!r}"

        btn = page.locator("text=CONFIRMAR VENTA")
        assert btn.evaluate("el => el.disabled") is True, (
            "El boton deberia seguir deshabilitado: falta cubrir $45 o marcar deuda"
        )

        print("--- Marcar 'Registrar como deuda del cliente' ---")
        page.locator("#chk-registrar-deuda").check(force=True)
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_multipago_deuda.png"), full_page=True)

        assert btn.evaluate("el => el.disabled") is False, (
            "El boton deberia habilitarse tras marcar 'Registrar como deuda del cliente'"
        )

        print("--- Confirmar venta ---")
        btn.click()
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_multipago_ticket.png"), full_page=True)

        ticket_text = page.locator("#app").inner_text()
        assert "50,00" in ticket_text and "45,00" in ticket_text, (
            f"El ticket no muestra el desglose Efectivo/Cta.Cte. esperado: {ticket_text[-400:]!r}"
        )

        print("--- Verificar deuda registrada en cuenta_corriente ---")
        cc = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT tipo, monto FROM cuenta_corriente WHERE cliente_id = 'cliente-test-1'"
          )
        """)
        assert len(cc) == 1, f"Se esperaba 1 movimiento de cuenta_corriente, hay {len(cc)}: {cc}"
        assert cc[0]["tipo"] == "venta_fiada", f"Tipo de movimiento inesperado: {cc[0]}"
        assert abs(cc[0]["monto"] - 45) < 0.01, f"Monto de deuda inesperado: {cc[0]}"

        assert not errors, f"Errores JS no capturados en pagina (regresion MPAY?): {errors}"

        print("OK - Cobro multiple: $50 Efectivo + $45 Cta.Cte. registrados correctamente para Juan Perez.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
