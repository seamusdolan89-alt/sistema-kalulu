"""
tests/e2e/test_editor_producto.py — Editor de Producto (página completa,
`js/modules/editor-producto.js` — NO confundir con productos.js, que es
solo la lista/búsqueda; ver memoria del proyecto). Cubre:

1. Crear un producto nuevo (Datos Básicos + Precios y Costos), guardar, y
   verificar que aparece en la lista de Productos con los valores
   correctos.
2. Editar un producto existente: cambiar el precio de venta, verificar
   que el margen se recalcula automáticamente (costo fijo, sube el
   margen al subir el precio), guardar, y verificar que persiste en la DB.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1400})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Crear producto nuevo: Fernet Branca 750ml ---")
        page.evaluate("window.location.hash = 'editor-producto/new'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.fill("#ed-nombre", "Fernet Branca 750ml")
        page.select_option("#ed-categoria", label="Bebidas")
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)
        page.fill("#ed-costo", "3000")
        page.fill("#ed-precio-venta", "5500")
        page.wait_for_timeout(200)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "editor_producto_nuevo.png"), full_page=True)

        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(700)

        nuevo_hash = page.evaluate("() => window.location.hash")
        assert nuevo_hash.startswith("#editor-producto/") and nuevo_hash != "#editor-producto/new", (
            f"Tras guardar deberia quedar en el editor con el ID real, no en /new: {nuevo_hash!r}"
        )

        print("--- Verificar que aparece en la lista de Productos ---")
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        lista_text = page.locator("#app").inner_text()
        assert "Fernet Branca 750ml" in lista_text, f"El producto nuevo no aparece en la lista: {lista_text[:400]!r}"

        prod_db = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT costo, precio_venta FROM productos WHERE nombre='Fernet Branca 750ml'\")"
        )
        assert len(prod_db) == 1, f"No se creo el producto en la DB: {prod_db}"
        assert abs(prod_db[0]["costo"] - 3000) < 0.01, f"Costo incorrecto: {prod_db[0]}"
        assert abs(prod_db[0]["precio_venta"] - 5500) < 0.01, f"Precio incorrecto: {prod_db[0]}"

        print("--- Editar Coca-Cola 2L: cambiar precio y verificar recalculo de margen ---")
        prod_id = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT id FROM productos WHERE nombre='Coca-Cola 2L'\")[0].id"
        )
        page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)

        margen_inicial = page.locator("#ed-margen").input_value()
        assert margen_inicial.startswith("47.3"), f"Margen inicial esperado ~47.37%% (costo 50, precio 95): {margen_inicial!r}"

        page.fill("#ed-precio-venta", "110")
        page.wait_for_timeout(300)
        margen_nuevo = page.locator("#ed-margen").input_value()
        assert margen_nuevo.startswith("54.5"), (
            f"Margen deberia recalcularse a ~54.55%% al subir el precio a $110 (costo sigue en 50): {margen_nuevo!r}"
        )
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "editor_producto_margen.png"), full_page=True)

        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(700)

        precio_final = page.evaluate(f"() => window.SGA_DB.query(\"SELECT precio_venta FROM productos WHERE id='{prod_id}'\")")
        assert abs(precio_final[0]["precio_venta"] - 110) < 0.01, f"El precio nuevo no persistio: {precio_final}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Editor de Producto: crear y editar productos, con recalculo de margen, funcionan bien.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
