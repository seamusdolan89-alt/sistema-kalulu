"""
tests/e2e/test_pos_cobro_multiple_medio_custom.py — Regresión: en "Cobro
múltiple", si uno de los medios usados es un medio custom agregado desde
Configuración (ej. "Link de Pago", no está en la lista fija original
['efectivo','mercadopago','tarjeta','transferencia']), la suma de los montos
sí cubría el total (el mensaje "✓ Cubierto" se veía bien, porque ese cálculo
usa la lista dinámica MEDIOS) pero el botón "Confirmar Venta" se quedaba
deshabilitado para siempre, porque `getTotalAsignado()` y la construcción
del array `pagos` en el handler de confirmar usaban esa misma lista fija
hardcodeada y ese medio quedaba afuera de la cuenta.

Reportado por el usuario con una venta real: Mercado Pago $19.000 + Link de
Pago $12.120 = $31.120 (total exacto), "✓ Cubierto" visible, botón inhabilitado.

Cubre: agregar un medio custom a `medios_cobro`, cobrar con Mercado Pago +
ese medio custom por el total exacto, verificar que el botón se habilita,
confirmar, y que ambos pagos queden registrados en `venta_pagos` (no solo
el que estaba en la lista fija).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_cobro_multiple_medio_custom.py
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

        print("--- Agregar medio de pago custom 'Link de Pago' (como desde Configuracion) ---")
        page.evaluate("""
          () => {
            window.SGA_DB.run(
              `INSERT INTO medios_cobro (id, nombre, icono, activo, orden, sync_status, updated_at)
               VALUES ('link_de_pago', 'Link de Pago', '🔗', 1, 2, 'pending', ?)`,
              [new Date().toISOString()]
            );
          }
        """)
        if hasattr(page, "wait_for_timeout"):
            page.wait_for_timeout(100)

        print("--- Reload para que pos.js relea medios_cobro (MEDIOS se arma al importar el modulo) ---")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)

        print("--- Agregar Coca-Cola 2L ($95,00) ---")
        page.locator("#pos-search-input").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#pos-search-dropdown .sri").click()
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

        print("--- Mercado Pago $60 + Link de Pago $35 = $95 (total exacto) ---")
        mp_input = page.locator(".mpay-field[data-medio='mercadopago']")
        mp_input.click()
        mp_input.type("60", delay=20)
        page.wait_for_timeout(200)

        link_input = page.locator(".mpay-field[data-medio='link_de_pago']")
        link_input.click()
        link_input.type("35", delay=20)
        page.wait_for_timeout(300)

        status_text = page.locator("#mpay-status").inner_text()
        assert "Cubierto" in status_text, (
            f"El estado deberia mostrar 'Cubierto' (60+35=95=total): {status_text!r}"
        )

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_medio_custom_cubierto.png"), full_page=True)

        btn = page.locator("text=CONFIRMAR VENTA")
        assert btn.evaluate("el => el.disabled") is False, (
            "BUG: el estado dice 'Cubierto' pero el boton de Confirmar Venta sigue "
            "deshabilitado — getTotalAsignado() no contaba el medio custom 'Link de Pago'"
        )

        print("--- Confirmar venta ---")
        btn.click()
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_medio_custom_ticket.png"), full_page=True)

        ticket_text = page.locator("#app").inner_text()
        assert "Link de Pago" in ticket_text and "35,00" in ticket_text and "60,00" in ticket_text, (
            f"El ticket no muestra el desglose Mercado Pago/Link de Pago esperado: {ticket_text[-400:]!r}"
        )

        print("--- Verificar ambos pagos en venta_pagos ---")
        pagos = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT medio, monto FROM venta_pagos
             WHERE venta_id = (SELECT id FROM ventas ORDER BY fecha DESC LIMIT 1)
             ORDER BY medio`
          )
        """)
        by_medio = {p["medio"]: p["monto"] for p in pagos}
        assert set(by_medio) == {"mercadopago", "link_de_pago"}, (
            f"Se esperaban pagos en 'mercadopago' y 'link_de_pago', hay: {pagos}"
        )
        assert abs(by_medio["mercadopago"] - 60) < 0.01, f"Monto Mercado Pago inesperado: {pagos}"
        assert abs(by_medio["link_de_pago"] - 35) < 0.01, f"Monto Link de Pago inesperado: {pagos}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Cobro multiple con medio custom: Mercado Pago $60 + Link de Pago $35 "
              "registrados correctamente y boton se habilito bien.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
