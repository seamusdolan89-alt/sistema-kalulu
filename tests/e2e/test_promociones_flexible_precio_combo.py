"""
tests/e2e/test_promociones_flexible_precio_combo.py — Promoción "Flexible
(pool)" con "Precio combo" (ej. "2 de estas variedades por $X") aplica el
descuento de verdad en el POS, no solo el mensaje.

Bug real reportado por el usuario (12/11/2026, con captura): creó una promo
flexible "2 Milka (cualquier variedad) por $40.000" y, al vender 2 unidades,
el mensaje de la promo aparecía pero el precio seguía siendo full price.

Causa: `applyPromos()` en pos.js (el motor que calcula el descuento REAL del
carrito, no solo el que arma el aviso) nunca revisaba `promo.precio_combo`
para la rama Flexible -- solo para la rama de Combo Fijo. Como al guardar un
promo "Precio combo", `valor_descuento` queda en 0 (el valor real vive en la
columna `precio_combo`), la rama flexible caía al `else` final y calculaba
descuento $0 -- el combo SÍ se detectaba (`combos > 0`, por eso el mensaje
aparecía) pero sin ningún descuento real.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_promociones_flexible_precio_combo.py
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

        print("--- Login POS (sga.db) + seed (Coca-Cola 2L $95 + Detergente 500ml $65) ---")
        login_via_seed(page, admin_pos=False)

        print("--- Crear promo Flexible: 2 unidades (cualquiera de las dos) por $100 ---")
        page.evaluate("window.location.hash = 'promociones'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("+ Nueva promoción", exact=True).click()
        page.wait_for_timeout(400)
        page.fill("#promo-nombre", "Pool test 2x$100")
        page.locator("#btn-tipo-flexible").click()
        page.fill("#promo-cantidad-total", "2")
        page.locator("#btn-desc-precio").click()
        page.fill("#promo-valor-descuento", "100")

        for termino in ("Coca", "Detergente"):
            page.locator("#modal-product-search").click()
            page.keyboard.type(termino, delay=20)
            page.wait_for_timeout(400)
            page.locator("#modal-search-dropdown .msri").first.click()
            page.wait_for_timeout(200)

        page.get_by_text("Guardar promoción", exact=True).click()
        page.wait_for_timeout(500)
        promo_list_text = page.locator("#app").inner_text()
        assert "Pool test 2x$100" in promo_list_text, "La promo no aparece en el listado tras guardar"

        print("--- POS: 1 Coca-Cola + 1 Detergente (mezcla de variedades del pool) ---")
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)

        for termino in ("Coca", "Deterg"):
            page.locator("#pos-search-input").click()
            page.keyboard.type(termino, delay=20)
            page.wait_for_timeout(400)
            page.locator("#pos-search-dropdown .sri").first.click()
            page.wait_for_timeout(300)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "promo_flexible_precio_combo.png"), full_page=True)

        cart_text = page.locator("#app").inner_text()
        assert "Pool test 2x$100" in cart_text, f"La promo no aparece aplicada en el carrito: {cart_text[-500:]!r}"
        # 95 + 65 = 160 de base; combo a $100 -> descuento real de $60,00
        assert "60,00" in cart_text, f"Falta el descuento real ($60,00 = 160 - 100): {cart_text[-500:]!r}"
        assert "100,00" in cart_text, f"Falta el total con el precio del combo ($100,00): {cart_text[-500:]!r}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Flexible + Precio combo aplica el descuento real en el POS ($160,00 -> $100,00).")
        browser.close()


if __name__ == "__main__":
    main()
