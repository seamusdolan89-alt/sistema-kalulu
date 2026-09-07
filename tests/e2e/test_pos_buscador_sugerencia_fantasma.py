"""
tests/e2e/test_pos_buscador_sugerencia_fantasma.py — Regresión: al escanear
un producto con el lector de código de barras, el buscador del POS
"sugería" el último producto agregado aunque el campo de búsqueda ya
estuviera vacío. También aparecía apenas se abría una venta nueva,
mostrando el último producto de la venta anterior.

Causa raíz: el listener de `input` en `pos-search-input` hace debounce de
180ms antes de renderizar el dropdown de resultados. El lector de código de
barras escribe el código completo + Enter en pocos milisegundos — mucho más
rápido que ese debounce — y el handler de Enter agregaba el producto al
carrito y limpiaba el input de forma sincrónica, pero nunca cancelaba el
`setTimeout` pendiente del debounce. Ese timer terminaba disparándose
DESPUÉS, con el código ya escaneado en su clausura, y volvía a mostrar el
dropdown con ese mismo producto aunque el input ya estuviera vacío. Como el
dropdown es el mismo nodo del DOM entre una venta y la siguiente, ese
resultado fantasma sobrevivía hasta la próxima venta.

Al tipear el nombre a mano nunca pasaba: un humano tarda bien más de 180ms
entre la última tecla y el Enter, así que el debounce ya se había disparado
(y resuelto) antes de que el Enter limpiara el input.

Cubre: escanear un código de barras rápido (sin pausas), verificar que el
dropdown queda oculto y vacío después, y que tampoco reaparece al abrir una
venta nueva.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_buscador_sugerencia_fantasma.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
BARCODE = "7790895000123"


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

        print("--- Login POS (sga.db) + seed + abrir caja ---")
        login_via_seed(page, admin_pos=False)

        print("--- Asignar codigo de barras a Coca-Cola 2L ---")
        page.evaluate(f"""
          () => {{
            const p = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre = 'Coca-Cola 2L'`)[0];
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-1', ?, '{BARCODE}', 1)`,
              [p.id]
            );
          }}
        """)

        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)

        print(f"--- Escanear codigo {BARCODE} rapido (sin pausas, como un lector real) ---")
        search = page.locator("#pos-search-input")
        search.click()
        search.type(BARCODE, delay=0)
        page.keyboard.press("Enter")

        print("--- Esperar mas que el debounce (180ms) para dejar que el timer fantasma dispare ---")
        page.wait_for_timeout(400)

        dd_visible = page.locator("#pos-search-dropdown").is_visible()
        dd_html = page.locator("#pos-search-dropdown").inner_html()
        assert not dd_visible, (
            f"BUG: el dropdown de busqueda quedo visible despues de escanear "
            f"y que el input se vaciara. innerHTML={dd_html!r}"
        )
        assert "Coca-Cola" not in dd_html, (
            f"BUG: el dropdown sigue mostrando el producto escaneado como 'sugerencia' "
            f"fantasma: {dd_html!r}"
        )

        cart_rows = page.locator("#cart-body tr, .cart-row, table tbody tr")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_scan_sin_fantasma.png"), full_page=True)

        cart_text = page.locator("#pos-sale").inner_text()
        assert "Coca-Cola 2L" in cart_text, f"El producto escaneado deberia estar en el carrito: {cart_text[:400]!r}"

        print("--- Confirmar la venta y abrir una venta nueva ---")
        page.fill("#recibe-efectivo", "95")
        page.wait_for_timeout(200)
        page.get_by_text("CONFIRMAR VENTA", exact=False).click()
        page.wait_for_timeout(700)
        page.get_by_text("Iniciar nueva venta", exact=False).click()
        page.wait_for_timeout(400)

        dd_visible_2 = page.locator("#pos-search-dropdown").is_visible()
        dd_html_2 = page.locator("#pos-search-dropdown").inner_html()
        assert not dd_visible_2, (
            f"BUG: al abrir una venta nueva reaparece la sugerencia fantasma de la "
            f"venta anterior: {dd_html_2!r}"
        )

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_nueva_venta_sin_fantasma.png"), full_page=True)

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - El buscador no sugiere nada fantasma tras escanear ni al abrir una venta nueva.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
