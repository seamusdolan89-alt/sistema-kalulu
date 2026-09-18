"""
tests/e2e/test_consumo_interno_sugerencia_fantasma.py

Regresión: mismo bug que ya se había arreglado en el POS
(tests/e2e/test_pos_buscador_sugerencia_fantasma.py), reportado de nuevo por
el usuario (18/9/2026) pero en Consumo Interno — al escanear un producto con
el lector, el buscador seguía "sugiriendo" ese mismo producto en el dropdown
después de agregarlo, como si se hubiera vuelto a escribir su código.

Causa raíz idéntica a la del POS: el listener de `input` en
`ci-search-input` hace debounce de 180ms antes de pintar el dropdown. El
lector escribe el código completo + Enter en milisegundos, mucho más rápido
que ese debounce. El handler de Enter agregaba el producto al carrito y
vaciaba el input de forma sincrónica, pero — a diferencia del POS, que sí lo
hacía — nunca cancelaba el `setTimeout` pendiente del debounce. Ese timer
disparaba después, con el código ya escaneado en su clausura, y volvía a
mostrar el dropdown con ese mismo producto.

El fix del POS (`clearTimeout(searchTimeout)` dentro de `addToCart`) nunca
se replicó en Consumo Interno porque son dos implementaciones de carrito
completamente separadas (ver conversación 18/9 sobre reutilización de
código) — mismo bug, mismo fix, aplicado ahora también acá.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_consumo_interno_sugerencia_fantasma.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

BARCODE = "7790895000123"


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Asignar codigo de barras a Coca-Cola 2L ---")
        page.evaluate(f"""
          () => {{
            const p = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre = 'Coca-Cola 2L'`)[0];
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-ci-1', ?, '{BARCODE}', 1)`,
              [p.id]
            );
          }}
        """)

        page.evaluate("window.location.hash = 'consumo_interno'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print(f"--- Escanear codigo {BARCODE} rapido (sin pausas, como un lector real) ---")
        search = page.locator("#ci-search-input")
        search.click()
        search.type(BARCODE, delay=0)
        page.keyboard.press("Enter")

        print("--- Esperar mas que el debounce (180ms) para dejar que el timer fantasma dispare ---")
        page.wait_for_timeout(400)

        dd_visible = page.locator("#ci-search-dropdown").is_visible()
        dd_html = page.locator("#ci-search-dropdown").inner_html()
        assert not dd_visible, (
            f"BUG: el dropdown de busqueda quedo visible despues de escanear "
            f"y que el input se vaciara. innerHTML={dd_html!r}"
        )
        assert "Coca-Cola" not in dd_html, (
            f"BUG: el dropdown sigue mostrando el producto escaneado como 'sugerencia' "
            f"fantasma: {dd_html!r}"
        )

        cart_text = page.locator("#ci-cart-body").inner_text()
        assert "Coca-Cola 2L" in cart_text, f"El producto escaneado deberia estar en el carrito: {cart_text[:300]!r}"

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_consumo_interno_sugerencia_fantasma: PASA")


if __name__ == "__main__":
    run()
