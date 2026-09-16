"""
tests/e2e/test_compras_vincular_remito_barcode_duplicado.py — Regresion:
un producto con dos codigos de barras marcados es_principal=1 (mismo dato
sucio que rompia Ordenes de Compra e Informes, ver
test_ordenes_barcode_duplicado.py y
test_informes_ventas_producto_barcode_duplicado.py) hacia que "Vincular
Factura" desde un remito pendiente DUPLICARA la fila de ese producto en el
carrito -- misma familia de bug, ultimo lugar sin arreglar (quedaba anotado
en memoria como riesgo real, compras_v2.js:3038).

Causa: vincularFacturaDesdeRemito() (compras_v2.js) traia el codigo de
barras con un LEFT JOIN filtrado por es_principal=1 sin GROUP BY -- con dos
"principales", cada fila de remito_items matcheaba dos veces.

Fix: la misma subquery con LIMIT 1 que ya se usa en el resto del codigo, en
vez del JOIN.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_vincular_remito_barcode_duplicado.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Proveedor + producto con codigo de barras duplicado + remito pendiente ---")
        remito_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;

            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_compra, activo)
               VALUES ('prov-cv2-dup', 'Proveedor Remito Duplicado Test', 'Responsable Inscripto', 'Factura B', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-cv2-dup', 'Producto Remito Duplicado Test', 60, 100, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
            // La dirty data real: dos codigos de barras del mismo producto,
            // los dos marcados es_principal=1.
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('bc-cv2-1','prod-cv2-dup','8890000000001',1)`
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('bc-cv2-2','prod-cv2-dup','8890000000002',1)`
            );

            window.SGA_DB.run(
              `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
               VALUES ('remito-cv2-dup', '1', 'prov-cv2-dup', ?, ?, 'R-0001', 'pendiente', 'pending', ?)`,
              [usuarioId, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
               VALUES ('ri-cv2-dup', 'remito-cv2-dup', 'prod-cv2-dup', 7, 'Unidad', 1)`
            );
            return 'remito-cv2-dup';
          }
        """)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Abrir remitos pendientes y vincular factura ---")
        page.locator("#cv2-btn-remitos-pendientes").click()
        page.wait_for_timeout(300)
        page.locator(f"#cv2-remitos-list .cv2-btn-vincular[data-id='{remito_id}']").click()
        page.wait_for_timeout(400)

        page.locator("#cv2-btn-continuar").click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_vincular_remito_barcode_dup.png"), full_page=True)

        filas = page.locator("#cv2-cart-body tr").count()
        print(f"Filas en el carrito para el remito vinculado: {filas}")
        assert filas == 1, (
            f"BUG: el producto con codigo de barras duplicado aparece en {filas} filas del carrito "
            f"al vincular la factura (deberia ser 1)"
        )

        row_text = page.locator("#cv2-cart-body tr").first.inner_text()
        assert "Producto Remito Duplicado Test" in row_text, f"No aparece el producto esperado: {row_text!r}"
        # Cantidad (7) x costo (60) = subtotal $420 -- confirma que la cantidad
        # del remito no se duplico (14) ni se perdio (solo $60, cantidad 1).
        # La cantidad en si vive en un <input>, "inner_text" no lo trae.
        assert "420" in row_text, f"Subtotal deberia reflejar cantidad 7 x $60 = $420: {row_text!r}"
        cantidad_input = page.locator("#cv2-cart-body tr input[data-field='cantidad']").first.input_value()
        assert cantidad_input == "7", f"BUG: la cantidad del remito deberia ser 7, no {cantidad_input!r}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Vincular Factura desde remito no duplica productos con codigo de barras duplicado.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
