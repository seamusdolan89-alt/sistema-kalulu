"""
tests/e2e/test_etiquetas_scan_rapido.py

Etiquetas: escanear un código de barras con el lector (tipea rápido + Enter) agrega el
producto directo, en vez de requerir flecha-abajo + Enter o un click con el mouse.

Reportado por el usuario (29/10/2026): "el scanner de código de barras funciona más
lento [en Etiquetas] que en otros como el carrito de compra o de venta". Dos causas
reales, las dos en este módulo:

1. El buscador de Etiquetas tenía su propia búsqueda SIN debounce (a diferencia de
   POS/Compras/Vencimientos, que sí lo tienen) — disparaba una consulta SQL + re-render
   completo del dropdown en CADA tecla, algo que un lector (muy rápido) nota mucho más
   que un usuario tipeando a mano.
2. Más grave: el handler de `Enter` SOLO agregaba el producto si había un resultado
   resaltado con flechas (`focusIdx >= 0`) — un lector no usa flechas, manda el código
   completo + Enter de una. Sin nada resaltado, Enter no hacía nada: el usuario tenía
   que notar que no se agregó y manualmente apretar flecha-abajo + Enter, o clickear
   con el mouse. Eso es lo que se sentía como "más lento" comparado con POS/Compras/
   Vencimientos, donde un Enter sin resaltado cae a una búsqueda por código exacto.

Fix: debounce de 180ms (igual que las otras pantallas) + Enter sin resaltado prueba
código exacto vía el motor único (`buscador_productos.js`, `Buscador.porCodigo`) antes
de no hacer nada. Como ahora hay un debounce, también hay que cancelar el timer
pendiente al agregar un item (en `_addItem`) y al apretar Escape — si no, reaparece el
mismo bug de "sugerencia fantasma" ya visto en POS/Consumo Interno/Vencimientos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_etiquetas_scan_rapido.py
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
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-etiq-1', ?, '{BARCODE}', 1)`,
              [p.id]
            );
          }}
        """)

        page.evaluate("window.location.hash = 'etiquetas'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print(f"--- Escanear codigo {BARCODE} rapido (sin pausas, como un lector real) ---")
        search = page.locator("#etiq-busqueda")
        search.click()
        search.type(BARCODE, delay=0)
        page.keyboard.press("Enter")
        page.wait_for_timeout(100)

        list_text = page.locator(".etiq-list").inner_text()
        assert "Coca-Cola 2L" in list_text, (
            f"BUG: escanear + Enter sin resaltado tendria que agregar el producto directo "
            f"(como en POS/Compras/Vencimientos). Contenido de .etiq-list: {list_text[:300]!r}"
        )

        print("--- Esperar mas que el debounce (180ms) para dejar que un timer fantasma dispare ---")
        page.wait_for_timeout(400)

        dropdown = page.locator(".etiq-dropdown")
        dd_visible = dropdown.count() > 0 and dropdown.first.is_visible()
        dd_html = dropdown.first.inner_html() if dropdown.count() > 0 else ""
        assert not dd_visible, (
            f"BUG: el dropdown de busqueda quedo visible despues de escanear y agregar. "
            f"innerHTML={dd_html!r}"
        )
        assert "Coca-Cola" not in dd_html, (
            f"BUG: el dropdown sigue mostrando el producto escaneado como 'sugerencia' "
            f"fantasma: {dd_html!r}"
        )

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_etiquetas_scan_rapido: PASA")


if __name__ == "__main__":
    run()
