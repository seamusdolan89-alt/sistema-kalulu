"""
tests/e2e/test_compras_v2_imp_interno_control.py — El "≠ carrito" del control
de cabecera (Factura A) ya no salta en falso cuando la factura del proveedor
trae Impuesto Interno cargado.

Pedido real del usuario (29/9/2026, factura de Oslé con jugos): el "Precio"
impreso por línea YA incluye el Impuesto Interno (es lo que de verdad se paga
por unidad, y así tiene que quedar el costo del producto), pero la propia
factura EXCLUYE ese interno del "Subtotal Neto" de la cabecera. Antes de este
fix, el control comparaba el carrito (bruto, con el interno adentro) contra
el Subtotal Neto tipeado (sin el interno) sin restar nada — cualquier compra
con Impuesto Interno marcaba "≠ carrito" para siempre, y la única forma de
que cerrara era simular un descuento que en realidad no existía.

Charla previa (misma sesión) sobre si hacía falta discriminar el interno por
producto: el usuario, Responsable Inscripto, confirmó que el Impuesto Interno
NO da crédito fiscal (a diferencia del IVA) — es un costo de mercadería más,
como el flete. No hace falta trackearlo por línea; alcanza con que el total
de la factura cierre. Por eso el fix es solo a nivel cabecera
(calcNetoParaControl() en compras_v2.js), sin tocar el carrito ni el schema.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_imp_interno_control.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

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

        print("--- Cabecera: Subtotal Neto 950, IVA 21% 199,50, Imp. Interno 50 ---")
        # Factura real: 10 unidades a $100 c/u ($1.000 bruto), de los cuales
        # $50 en total son Impuesto Interno (ya incluido en el $100 de precio
        # de cada unidad) -> Subtotal Neto real = 1.000 - 50 = 950.
        page.fill("#cv2-subtotal-neto", "950")
        page.locator("#cv2-subtotal-neto").blur()
        page.fill("#cv2-iva-21", "199,50")
        page.locator("#cv2-iva-21").blur()
        page.fill("#cv2-imp-interno", "50")
        page.locator("#cv2-imp-interno").blur()
        page.wait_for_timeout(200)

        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        print("--- Cargar Coca-Cola 2L: 10 u. x $100 (precio de factura, con el interno adentro) ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("Coca", delay=30)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item", has_text="Coca-Cola 2L").click()
        page.wait_for_timeout(400)

        row = "tr[data-idx='0']"
        page.fill(f"{row} input[data-field='cantidad']", "10")
        page.fill(f"{row} input[data-field='costoNuevo']", "100")
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.select_option(f"{row} select[data-field='iva']", "21")
        page.wait_for_timeout(300)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_imp_interno_control.png"), full_page=True)

        # El carrito SUMA bruto (con el interno adentro): 10 x $100 = $1.000,00.
        cart_subtotal = page.locator(f"{row} .cv2-subtotal").inner_text().strip()
        assert "1.000,00" in cart_subtotal or "1000,00" in cart_subtotal, (
            f"Subtotal de linea inesperado: {cart_subtotal!r}"
        )

        print("--- El control de cabecera NO debe marcar '≠ carrito' (fix) ---")
        control = page.locator("#cv2-col-control")
        assert control.is_visible(), "El control de cabecera no se muestra"
        control_text = control.inner_text()
        assert "≠ carrito" not in control_text, (
            f"El control marca mismatch: el fix debería restar el Impuesto Interno antes de comparar. {control_text!r}"
        )
        assert control.locator(".cv2-control-badge-ok").count() == 1, (
            f"Esperaba el badge OK ('= carrito'): {control_text!r}"
        )

        btn = page.locator("#cv2-btn-confirmar")
        assert not btn.evaluate("el => el.disabled"), "El botón Confirmar no debería estar deshabilitado"
        assert "cv2-btn-confirmar-alert" not in (btn.get_attribute("class") or ""), (
            "El botón Confirmar no debería estar en estado de alerta (mismatch) con el fix aplicado"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Compras: Impuesto Interno en el header ya no marca falso mismatch contra el carrito.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
