"""
tests/e2e/test_operaciones_stock_editar_precio_historial.py — "Ver" en el
Historial de Compras (Operaciones de Stock, Admin-POS) pasa a ser la
herramienta principal del dueño para revisar/corregir precios de venta
después de una compra — pedido explícito del usuario (23/9/2026): en vez de
depender del frágil "ajuste de precios pendiente" (localStorage / sesión),
quiere poder editar el precio de cualquier producto de cualquier compra ya
confirmada, desde acá, con feedback claro de que se guardó y sin tener que ir
producto por producto al editor.

La función ya existía (columna "Precio Venta" editable, guarda en
productos.precio_venta al perder el foco) pero:
  - No se notaba que era editable (parecía una tabla de solo lectura — "Ver").
  - El único feedback era un toast que desaparece solo — "¿esto se guardó
    de verdad?".
  - No tenía en cuenta "familia de productos" (Coca-Cola 600ml + Sprite
    600ml comparten precio/costo, js/modules/familia.js) — cambiar un precio
    acá dejaba a los hermanos desfasados.
  - No se podía revisar varios productos seguidos solo con el teclado.

Fix: pista visual de que el campo es editable (fondo celeste, título), un
check "✓" que queda a la vista mientras el modal esté abierto (no un toast
que se borra solo), Enter guarda y pasa al siguiente producto, y si el
producto tiene familia se abre el mismo wizard que ya usa compras_v2.js /
editor-producto.js para ofrecer sincronizar a los hermanos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_editar_precio_historial.py
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
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login Admin-POS + seed ---")
        login_via_seed(page, admin_pos=True, wait_target="productos")

        print("--- Preparar datos: 2 productos (uno madre de familia, otro sin familia) + 1 compra confirmada ---")
        setup = page.evaluate("""
          () => {
            const db = window.SGA_DB;
            const uuid = window.SGA_Utils.generateUUID;
            const now = new Date().toISOString();
            const suc = window.SGA_Auth.getCurrentUser().sucursal_id;
            const usr = window.SGA_Auth.getCurrentUser().id;
            const prov = db.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;

            // Producto A: madre de familia (tiene un hijo). Producto B: sin familia.
            const prodA = uuid(); const prodB = uuid(); const prodHijo = uuid();
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, activo, es_madre, sync_status, updated_at)
                    VALUES (?, 'Producto Madre Test', 100, 150, 1, 1, 'synced', ?)`, [prodA, now]);
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, activo, producto_madre_id, hereda_costo, hereda_precio, sync_status, updated_at)
                    VALUES (?, 'Producto Hijo Test', 100, 150, 1, ?, 1, 1, 'synced', ?)`, [prodHijo, prodA, now]);
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, activo, sync_status, updated_at)
                    VALUES (?, 'Producto Sin Familia Test', 50, 80, 1, 'synced', ?)`, [prodB, now]);

            const compraId = uuid();
            db.run(`INSERT INTO compras (id, proveedor_id, sucursal_id, usuario_id, fecha, estado, total, total_factura, sync_status, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'confirmada', 300, 300, 'synced', ?)`,
                   [compraId, prov, suc, usr, now, now]);
            db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, descuento_pct, subtotal)
                    VALUES (?, ?, ?, 2, 100, 0, 200)`, [uuid(), compraId, prodA]);
            db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, descuento_pct, subtotal)
                    VALUES (?, ?, ?, 2, 50, 0, 100)`, [uuid(), compraId, prodB]);

            return { compraId, prodA, prodB, prodHijo };
          }
        """)

        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.evaluate("() => document.querySelector('[data-action=\"historial_compras\"]')?.click()")
        page.wait_for_timeout(300)

        page.evaluate(
            "(id) => document.querySelector(`[data-ver-compra=\"${id}\"]`)?.click()",
            setup["compraId"],
        )
        page.wait_for_timeout(300)

        print("--- El aviso de que el precio es editable esta visible ---")
        detalle_text = page.locator("#ops-detalle-body").inner_text()
        assert "se edita acá mismo" in detalle_text or "editable" in detalle_text.lower(), (
            f"No se ve el aviso de que el precio se puede editar: {detalle_text[:300]!r}"
        )

        inputs = page.locator(".ops-precio-input")
        assert inputs.count() == 2, f"Se esperaban 2 inputs de precio, hay {inputs.count()}"

        print("--- Verificar que el input se ve claramente editable (fondo celeste, no blanco) ---")
        bg = inputs.first.evaluate("el => getComputedStyle(el).backgroundColor")
        assert bg == "rgb(240, 246, 255)", f"El input deberia tener el fondo celeste 'editable', tiene: {bg}"

        print("--- Editar el precio del producto CON familia -> debe aparecer el wizard de familia ---")
        input_madre = page.locator('.ops-precio-input[data-prodid="%s"]' % setup["prodA"])
        input_madre.click()
        input_madre.fill("175")
        input_madre.press("Enter")
        page.wait_for_timeout(400)

        precio_guardado = page.evaluate(
            "(id) => window.SGA_DB.query('SELECT precio_venta, sync_status FROM productos WHERE id=?', [id])[0]",
            setup["prodA"],
        )
        assert abs(precio_guardado["precio_venta"] - 175) < 0.01, f"El precio no se guardo: {precio_guardado}"
        assert precio_guardado["sync_status"] == "pending", f"Deberia quedar pending para sincronizar: {precio_guardado}"
        print("   OK - precio guardado con sync_status='pending'")

        badge_madre = page.locator('.ops-precio-saved[data-idx]').first
        assert page.locator('span.ops-precio-saved:visible').count() >= 1, "El check de 'guardado' no quedo visible"
        print("   OK - el check de guardado queda a la vista (no depende del toast)")

        assert page.locator(".cv2-her-overlay").is_visible(), (
            "BUG: el producto tiene familia y no se abrio el wizard de sincronizacion"
        )
        print("   OK - se abrio el wizard de familia")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ops_historial_precio_familia.png"), full_page=True)

        page.locator(".cv2-her-btn-cancel").click()
        page.wait_for_timeout(200)
        assert not page.locator(".cv2-her-overlay").is_visible(), "El wizard de familia deberia haberse cerrado"

        print("--- Enter tambien mueve el foco al siguiente input (revisión rápida por teclado) ---")
        focused_prodid = page.evaluate("() => document.activeElement?.dataset?.prodid || null")
        assert focused_prodid == setup["prodB"], (
            f"Tras Enter en el primer producto, el foco deberia estar en el segundo (sin familia): {focused_prodid!r}"
        )
        print("   OK - el foco paso al siguiente producto")

        print("--- Editar el precio del producto SIN familia -> NO debe abrirse el wizard ---")
        page.keyboard.type("88", delay=20)
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        assert not page.locator(".cv2-her-overlay").is_visible(), (
            "BUG: se abrio el wizard de familia para un producto que no tiene familia"
        )
        precio_b = page.evaluate(
            "(id) => window.SGA_DB.query('SELECT precio_venta FROM productos WHERE id=?', [id])[0].precio_venta",
            setup["prodB"],
        )
        assert abs(precio_b - 88) < 0.01, f"El precio del segundo producto no se guardo: {precio_b}"
        print("   OK - guardado sin abrir el wizard (no tiene familia)")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_operaciones_stock_editar_precio_historial: PASA")


if __name__ == "__main__":
    main()
