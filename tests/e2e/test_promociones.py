"""
tests/e2e/test_promociones.py — Crear una promoción (10% de descuento sobre
Coca-Cola 2L) desde el módulo Promociones y verificar que se aplica
automáticamente al agregar el producto al carrito en el POS.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_promociones.py
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

        print("--- Crear promocion: 10% sobre Coca-Cola 2L ---")
        page.evaluate("window.location.hash = 'promociones'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("+ Nueva promoción", exact=True).click()
        page.wait_for_timeout(400)
        page.fill("#promo-nombre", "Descuento Coca-Cola test")
        page.fill("#promo-valor-descuento", "10")
        page.locator("#modal-product-search").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#modal-search-dropdown .msri").click()
        page.wait_for_timeout(300)
        page.get_by_text("Guardar promoción", exact=True).click()
        page.wait_for_timeout(500)

        promo_list_text = page.locator("#app").inner_text()
        assert "Descuento Coca-Cola test" in promo_list_text, "La promocion no aparece en el listado tras guardar"

        print("--- Agregar Coca-Cola 2L al carrito del POS ---")
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)
        page.locator("#pos-search-input").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#pos-search-dropdown .sri").click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "promo_aplicada_pos.png"), full_page=True)

        print("--- Verificar que el descuento se aplico automaticamente ---")
        cart_text = page.locator("#app").inner_text()
        assert "Descuento Coca-Cola test" in cart_text, "La promo no aparece indicada en el carrito"
        assert "9,50" in cart_text, f"El descuento esperado ($9,50 = 10% de $95) no aparece: {cart_text[-500:]!r}"
        assert "85,50" in cart_text, f"El total con descuento esperado ($85,50) no aparece: {cart_text[-500:]!r}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Promociones: 10% sobre Coca-Cola 2L se aplica automaticamente en el POS ($95,00 -> $85,50).")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
