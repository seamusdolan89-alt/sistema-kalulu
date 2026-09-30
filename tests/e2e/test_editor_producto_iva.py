"""
tests/e2e/test_editor_producto_iva.py — Campo IVA (21% / 10,5% / sin discriminar)
en la pestaña "Precios y Costos" del Editor de Producto, y su relación de ida
y vuelta con el carrito de Compras (Factura A, único lugar donde existe un
selector de IVA por línea — ver js/modules/compras_v2.js y
nota_credito_wizard.js, que comparten los mismos 3 valores: '', '10.5', '21').

El pedido del dueño: cada producto tiene su propia alícuota de IVA, que hoy
solo se cargaba línea por línea en cada compra (sin persistir en el
producto). Cubre:

1. Editor de Producto: el select #ed-iva existe en Precios y Costos, se puede
   setear y persiste en productos.iva con sync_status='pending'.
2. Compras (Factura A): al agregar al carrito un producto con IVA ya
   guardado, la línea se pre-carga con ese valor sin que la cajera tenga que
   tocar nada (código YA existente desde antes de esta tarea — selectSearchResult/
   addToCart en compras_v2.js ya leían producto.iva; este test es la primera
   regresión que lo cubre de punta a punta).
3. Al confirmar una compra con un IVA de línea distinto al guardado en el
   producto (corrección real de la cajera/dueño), commitCompra() reescribe
   productos.iva con el último valor cargado — el sistema "aprende" el dato
   con cada compra real, sin pisar nada más del producto.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_iva.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        prod = q(page, "SELECT id, iva FROM productos WHERE nombre='Coca-Cola 2L'")[0]
        prod_id = prod["id"]
        assert not prod["iva"], f"Precondición: Coca-Cola 2L no debería tener IVA seedeado: {prod}"

        print("--- Editor de Producto: la pestaña Precios y Costos tiene el select de IVA ---")
        page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)

        iva_select = page.locator("#ed-iva")
        assert iva_select.count() == 1, "No aparece el select #ed-iva en Precios y Costos"
        assert iva_select.input_value() == "", f"Sin IVA seedeado debería mostrar la opción vacía: {iva_select.input_value()!r}"

        page.select_option("#ed-iva", "21")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "editor_producto_iva.png"), full_page=True)
        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(600)

        row = q(page, "SELECT iva, sync_status FROM productos WHERE id=?", [prod_id])[0]
        assert row["iva"] == "21", f"El IVA no persistió en productos.iva: {row}"
        assert row["sync_status"] == "pending", f"El UPDATE no marcó sync_status='pending': {row}"
        print(f"OK - productos.iva guardado: {row}")

        print("--- Reabrir el editor: el select viene pre-cargado con el IVA guardado ---")
        page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)
        assert page.locator("#ed-iva").input_value() == "21", "El editor no recarga el IVA guardado al reabrir"

        print("--- Compras (Factura A): agregar el producto precarga el IVA de línea desde el producto ---")
        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Factura A")
        page.wait_for_timeout(200)
        page.fill("#cv2-subtotal-neto", "200")
        page.locator("#cv2-subtotal-neto").blur()
        page.fill("#cv2-iva-21", "42")
        page.locator("#cv2-iva-21").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        page.locator("#cv2-search").click()
        page.keyboard.type("Coca-Cola 2L", delay=20)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Coca-Cola 2L").click()
        page.wait_for_timeout(400)

        row_sel = "tr[data-idx='0']"
        cart_iva = page.locator(f"{row_sel} select[data-field='iva']")
        assert cart_iva.count() == 1, "No aparece la columna IVA en el Carrito para Factura A"
        assert cart_iva.input_value() == "21", (
            f"BUG: la línea debería precargarse con el IVA guardado en el producto (21%): {cart_iva.input_value()!r}"
        )
        print("OK - línea de carrito precargada con IVA=21% desde el producto.")

        print("--- La cajera corrige a 10,5% en esta factura puntual y confirma la compra ---")
        page.fill(f"{row_sel} input[data-field='cantidad']", "2")
        page.fill(f"{row_sel} input[data-field='costoNuevo']", "100")
        page.locator(f"{row_sel} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(300)
        page.select_option(f"{row_sel} select[data-field='iva']", "10.5")
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_iva_precargado.png"), full_page=True)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.locator("#cv2-rev-btn-confirmar").click()
        page.wait_for_timeout(800)

        compra = q(page, "SELECT id, estado FROM compras ORDER BY fecha DESC LIMIT 1")[0]
        assert compra["estado"] == "confirmada", f"La compra no quedó confirmada: {compra}"

        row_final = q(page, "SELECT iva, sync_status, updated_at FROM productos WHERE id=?", [prod_id])[0]
        assert row_final["iva"] == "10.5", (
            f"BUG: commitCompra() debería reescribir productos.iva con el valor de la línea confirmada (10,5%): {row_final}"
        )
        assert row_final["sync_status"] == "pending", f"El write-back no marcó sync_status='pending': {row_final}"
        print(f"OK - productos.iva actualizado por la compra confirmada: {row_final}")

        assert not errors, f"Errores JS no capturados en página: {errors}"

        print("OK - IVA por producto: Editor (setear/persistir), precarga en Carrito Factura A, y write-back al confirmar.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
