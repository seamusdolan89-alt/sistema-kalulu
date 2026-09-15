"""
tests/e2e/test_caja_recuento_persiste.py — Caja > Efectivo > Recuento de
dinero: lo que se va tipeando ya no se pierde al navegar a otra pantalla
ni al volver a entrar.

Reportado por el usuario probando 0e92f91 (fix de tamaño de letra del
recuento): "asegurate de paso que la cantidad de billetes ingresados de
cada denominacion queden guardados. No quiero que se reseteen a cero
cada vez que me voy a otra pantalla, ni cuando cierro sesion."

Causa: state.recuento.billetes vivia solo en memoria del modulo. El
router hace destroy() del modulo anterior y monta uno nuevo (con state
limpio) en cada navegacion -- salir de Caja y volver perdia todo lo
tipeado a menos que el usuario se acordara de tocar "Guardar recuento".

Fix: cada tecleo autoguarda (debounced) en sesiones_caja.detalle_billetes
-- la misma columna que ya usa "Guardar recuento" y el cierre de caja, asi
que al re-montar el modulo (renderRecuento ya sabia leer de ahi como
fallback) el conteo se recupera solo.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_caja_recuento_persiste.py
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
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS + abrir caja ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        abrir_caja_si_hace_falta(page)
        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Recuento de dinero: tipear 5 billetes de $1000 ---")
        page.get_by_text("Recuento de dinero", exact=True).click()
        page.wait_for_timeout(300)
        primer_input = page.locator(".recuento-input").first
        denom = primer_input.get_attribute("data-denom")
        primer_input.fill("5")
        page.wait_for_timeout(700)  # deja tiempo al autoguardado debounced (400ms)

        print("--- Verificar en la base: el autoguardado ya escribio detalle_billetes ---")
        detalle = page.evaluate("""
          () => window.SGA_DB.query(`SELECT detalle_billetes FROM sesiones_caja WHERE estado='abierta' LIMIT 1`)[0]
        """)
        print(f"detalle_billetes tras tipear: {detalle}")
        assert detalle and detalle.get("detalle_billetes"), (
            "BUG: el autoguardado no escribio nada en sesiones_caja.detalle_billetes"
        )
        import json
        billetes_guardados = json.loads(detalle["detalle_billetes"]).get("billetes", {})
        assert str(billetes_guardados.get(denom)) == "5", (
            f"BUG: el autoguardado no reflejo el valor tipeado ({denom!r}=5): {billetes_guardados}"
        )

        print("--- Navegar a otra pantalla y volver (simula lo que perdia el conteo) ---")
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("Recuento de dinero", exact=True).click()
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_recuento_persiste.png"), full_page=True)

        valor_recuperado = page.locator(f'.recuento-input[data-denom="{denom}"]').input_value()
        print(f"Valor recuperado tras navegar y volver: {valor_recuperado!r}")
        assert valor_recuperado == "5", (
            f"BUG: el recuento se reseteo a navegar a otra pantalla y volver (quedo en {valor_recuperado!r}, esperaba '5')"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - El recuento de dinero autoguarda y sobrevive a navegar a otra pantalla.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
