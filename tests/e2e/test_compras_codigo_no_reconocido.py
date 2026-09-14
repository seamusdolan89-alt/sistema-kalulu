"""
tests/e2e/test_compras_codigo_no_reconocido.py — Carrito de Compras: un
código de barras sin match ya no salta derecho a "Crear producto nuevo",
deja elegir también "Vincular a producto existente".

Reportado por el usuario: al ESCANEAR un código inexistente, el sistema
iba directo a crear un producto nuevo; tipeando el mismo código a mano,
aparecían las dos opciones. No es en realidad "escaneo vs. tecleo" -- un
lector de código de barras manda un Enter automático apenas termina de
tipear el código, y el handler de Enter, con cero resultados, saltaba
directo a showNewProductForm() sin pasar por el dropdown que ya venía
mostrando las dos opciones en cada tecleo. Tipeando a mano casi nadie
presiona Enter (mira la pantalla y clickea), así que ese atajo nunca se
disparaba.

Fix: el Enter con cero resultados ya no auto-selecciona "Crear nuevo" --
deja el dropdown abierto con las dos acciones, igual para lector o teclado.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_codigo_no_reconocido.py
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

        print("--- Nueva compra: Tradicional -> Pepsico SA ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Factura A")
        page.wait_for_timeout(200)
        page.fill("#cv2-subtotal-neto", "100")
        page.locator("#cv2-subtotal-neto").blur()
        page.fill("#cv2-iva-21", "21")
        page.locator("#cv2-iva-21").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        print("--- 'Escanear' un codigo que no existe: tipear rapido + Enter (como el lector) ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("7791234567890", delay=10)
        page.wait_for_timeout(150)
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_codigo_no_reconocido.png"), full_page=True)

        nuevo_prod_visible = page.evaluate("""
          () => document.getElementById('cv2-new-prod-form')?.style.display === 'block'
        """)
        assert not nuevo_prod_visible, (
            "BUG: Enter con codigo sin match salto directo a 'Crear producto nuevo' "
            "en vez de dejar elegir tambien 'Vincular a producto existente'"
        )

        dropdown_text = page.locator("#cv2-dropdown").inner_text()
        print(f"Dropdown tras Enter: {dropdown_text!r}")
        assert "Crear producto nuevo" in dropdown_text, (
            f"Deberia seguir ofreciendo Crear producto nuevo: {dropdown_text!r}"
        )
        assert "Vincular a producto existente" in dropdown_text, (
            f"BUG: falta la opcion de vincular tras el Enter: {dropdown_text!r}"
        )

        print("--- Click en 'Vincular a producto existente' funciona ---")
        page.locator('#cv2-dropdown [data-action="vincular"]').click()
        page.wait_for_timeout(300)
        link_text = page.locator("#cv2-new-prod-form").inner_text()
        assert "vincular" in link_text.lower() or "existente" in link_text.lower(), (
            f"No se abrio el formulario de vincular: {link_text[:300]!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Codigo sin match: Enter deja elegir Crear nuevo O Vincular, igual que tipeando.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
