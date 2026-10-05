"""
tests/e2e/test_pos_f2_redondea_sin_blur.py — Tercera etapa de la regla de 2
decimales (5/10/2026): F2 confirma la venta sin que el campo de pago pierda
el foco (ge('btn-confirm-venta')?.click() no dispara blur/focusout en el
input activo) -- el redondeo delegado de app.js (data-money, corre en
'focusout') nunca llega a ejecutarse en ese camino. Mismo riesgo que ya se
encontró y arregló en operaciones_stock.js (Historial de Compras,
4/10/2026): hubo que redondear también en el punto de lectura
(confirmarVenta en pos.js), no solo confiar en el mecanismo de UI.

Ojo con el escenario de prueba: repartirCobro() en pos.js hace
Math.min(total, ventaNeta) -- cualquier pago que IGUALE O SUPERE el total
de la venta queda recortado al total limpio sin importar el ruido de
decimales (lo descarta como "vuelto"), enmascarando el bug. Para que el
monto con ruido viaje intacto hasta venta_pagos hace falta un pago PARCIAL
(menor al total, el resto a cuenta corriente del cliente) -- ahí
Math.min(total, ventaNeta) = total y el valor tipeado pasa sin recortar.

Cubre: cobro múltiple con Mercado Pago $50.004 (parcial, resto a cuenta
corriente) y F2 SIN sacar el foco del campo -- el monto en venta_pagos
tiene que tener 2 decimales.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_f2_redondea_sin_blur.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

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

        print("--- Login POS + seed + abrir caja ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("""
          () => {
            window.SGA_DB.run(
              `INSERT INTO clientes (id, nombre, apellido, telefono, activo, sync_status, updated_at)
               VALUES ('cliente-f2', 'Juan', 'Perez', '1122334455', 1, 'pending', ?)`,
              [new Date().toISOString()]
            );
          }
        """)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
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

        print("--- Tipear Mercado Pago $50.004 (parcial, con 3 decimales) y F2 SIN sacar el foco ---")
        mp_input = page.locator(".mpay-field[data-medio='mercadopago']")
        mp_input.fill("50.004")
        page.wait_for_timeout(200)

        print("--- Marcar 'Registrar como deuda del cliente' (resto $45) ---")
        page.locator("#chk-registrar-deuda").check(force=True)
        page.wait_for_timeout(200)

        # Volver el foco al campo de Mercado Pago (el checkbox se lo llevo) y
        # presionar F2 directo, sin pasar por otro campo -- asi el blur/
        # focusout de app.js nunca llega a correr antes de confirmar.
        mp_input.focus()
        page.keyboard.press("F2")
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_f2_sin_blur.png"), full_page=True)

        print("--- Verificar el monto grabado en venta_pagos ---")
        pagos = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT medio, monto FROM venta_pagos
             WHERE venta_id = (SELECT id FROM ventas ORDER BY fecha DESC LIMIT 1)`
          )
        """)
        print(f"   venta_pagos: {pagos}")
        assert len(pagos) >= 1, f"No se registro ningun pago: {pagos}"
        for p in pagos:
            redondeado = round(p["monto"] * 100) / 100
            assert abs(p["monto"] - redondeado) < 1e-9, (
                f"BUG: el monto de '{p['medio']}' via F2 (sin blur) quedo con mas de 2 decimales: {p}"
            )
        montos_por_medio = {p["medio"]: p["monto"] for p in pagos}
        assert "mercadopago" in montos_por_medio and abs(montos_por_medio["mercadopago"] - 50.0) < 0.5, (
            f"Monto de mercadopago inesperado: {pagos}"
        )

        print("--- Verificar la deuda registrada (95 - 50.00 = 45) ---")
        cc = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT monto FROM cuenta_corriente WHERE cliente_id = 'cliente-f2'"
          )
        """)
        print(f"   cuenta_corriente: {cc}")
        assert len(cc) == 1, f"Deuda no registrada: {cc}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_pos_f2_redondea_sin_blur: PASA "
              "(F2 sin blur tambien redondea el monto antes de grabarlo)")


if __name__ == "__main__":
    main()
