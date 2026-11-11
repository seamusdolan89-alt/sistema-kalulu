"""
tests/e2e/test_editor_producto_ver_operacion.py — "Ver detalle" de una compra o
venta, desde el Editor de Producto (pestañas "Historial de precios" y
"Transacciones"), abre un modal en el lugar en vez de navegar.

Bug real reportado por el usuario (11/11/2026, con captura): clickear el link
de una compra en "Historial de precios" (ej. "Compra a Vital — Factura 14713")
tiraba "Error: Could not load module 'compras'" — `navegarAOperacion()` seteaba
`window.location.hash = '#compras'`, una ruta que no existe desde que el
módulo se renombró a `compras_v2`. Encima, aunque el hash hubiera sido el
correcto, nada leía el `sessionStorage` ('highlight_compra'/'highlight_venta')
que seteaba antes de navegar -- ni pos.js ni compras_v2.js lo consumen en
ningún lado -- así que ni siquiera habría mostrado la operación puntual.

Fix: en vez de navegar, abre un modal de solo lectura ahí mismo (mismo
`openFamiliaModal` que ya usa esta pantalla para el detalle de un ajuste de
stock), con una consulta propia (no depende de que `cuenta_corriente_
proveedores.js`/`clientes.js` ya estén cargados en la sesión).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_ver_operacion.py
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

        print("--- Login admin-pos + producto con una compra y una venta reales ---")
        login_via_seed(page, admin_pos=True)
        prod_id = page.evaluate("""
          () => {
            const u = window.SGA_Auth.getCurrentUser();
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
                 precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('vop-prod', 'Jabon Liquido VerOp', 3700, 5000, 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`,
              [now, now, now]);
            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, activo, sync_status, updated_at)
               VALUES ('vop-prov', 'Vital', 1, 'synced', ?)`, [now]);
            window.SGA_DB.run(
              `INSERT INTO compras (id, proveedor_id, numero_factura, total, condicion_pago, estado,
                 fecha, usuario_id, sucursal_id, sync_status, updated_at)
               VALUES ('vop-compra', 'vop-prov', '14713', 4400, 'pendiente', 'confirmada', ?, ?, ?, 'synced', ?)`,
              [now, u.id, u.sucursal_id, now]);
            window.SGA_DB.run(
              `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario)
               VALUES ('vop-ci', 'vop-compra', 'vop-prod', 10, 4400)`);
            window.SGA_DB.conOrigenCambio(
              { origen: 'compra', refTipo: 'compras', refId: 'vop-compra', detalle: 'Compra a Vital' },
              () => window.SGA_DB.run(
                `UPDATE productos SET costo = 4400, fecha_modificacion = ? WHERE id = 'vop-prod'`, [now])
            );

            window.SGA_DB.run(
              `INSERT INTO ventas (id, sucursal_id, usuario_id, cliente_id, subtotal, descuento,
                 total, estado, fecha, sync_status, updated_at)
               VALUES ('vop-venta', ?, ?, NULL, 5000, 0, 5000, 'completada', ?, 'synced', ?)`,
              [u.sucursal_id, u.id, now, now]);
            window.SGA_DB.run(
              `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, subtotal)
               VALUES ('vop-vi', 'vop-venta', 'vop-prod', 1, 5000, 5000)`);
            window.SGA_DB.run(
              `INSERT INTO venta_pagos (id, venta_id, medio, monto)
               VALUES ('vop-vp', 'vop-venta', 'efectivo', 5000)`);
            window.SGA_DB.moverStock({
              productoId: 'vop-prod', sucursalId: u.sucursal_id, delta: -1, tipo: 'venta',
              refTipo: 'ventas', refId: 'vop-venta', motivo: null, fecha: now
            });
            return 'vop-prod';
          }
        """)

        print("--- Historial de precios: click en el link de la compra ---")
        page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator(".editor-nav-link[data-section='historial-precios']").click()
        page.wait_for_timeout(400)

        link = page.locator(".ed-hp-link")
        assert link.count() >= 1, "Debería haber un link a la compra en Historial de precios"
        assert "Vital" in link.first.inner_text() and "14713" in link.first.inner_text(), (
            f"Texto del link inesperado: {link.first.inner_text()!r}"
        )
        link.first.click()
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "editor_producto_ver_compra.png"), full_page=True)

        hash_tras_click = page.evaluate("window.location.hash")
        assert "editor-producto" in hash_tras_click, (
            f"No debería haber navegado afuera del editor (bug real: iba a '#compras', 404): {hash_tras_click!r}"
        )
        modal = page.locator("#ed-familia-modal")
        assert modal.is_visible(), "Debería abrirse el modal de detalle de compra"
        texto_modal = modal.inner_text()
        assert "Vital" in texto_modal, f"Falta el proveedor en el modal: {texto_modal!r}"
        assert "14713" in texto_modal, f"Falta el número de factura en el modal: {texto_modal!r}"
        assert "Jabon Liquido VerOp" in texto_modal, f"Falta el producto en el detalle: {texto_modal!r}"
        print("OK - modal de compra con proveedor, factura y producto, sin navegar")

        page.locator("#fam-btn-cancel").click()
        page.wait_for_timeout(200)
        assert not page.locator("#ed-familia-modal").count(), "El modal debería cerrarse con Cerrar"

        print("--- Transacciones: click en 'Ver detalle' de la venta ---")
        page.locator(".editor-nav-link[data-section='transacciones']").click()
        page.wait_for_timeout(400)
        btn = page.locator(".ed-tx-link[data-tipo='venta']").last
        assert btn.count() >= 1, "Debería haber un botón de ver detalle para la venta"
        btn.click()
        page.wait_for_timeout(300)

        hash_tras_click2 = page.evaluate("window.location.hash")
        assert "editor-producto" in hash_tras_click2, f"No debería haber navegado al POS: {hash_tras_click2!r}"
        modal2 = page.locator("#ed-familia-modal")
        assert modal2.is_visible(), "Debería abrirse el modal de detalle de venta"
        texto_modal2 = modal2.inner_text()
        assert "Jabon Liquido VerOp" in texto_modal2, f"Falta el producto en el detalle de venta: {texto_modal2!r}"
        assert "efectivo" in texto_modal2.lower(), f"Falta el medio de pago: {texto_modal2!r}"
        print("OK - modal de venta con producto y medio de pago, sin navegar")

        assert not errors, f"Errores JS no capturados: {errors}"
        print("\nOK - Ver compra/venta desde el Editor de Producto abre un modal, no navega a una ruta rota")
        browser.close()


if __name__ == "__main__":
    main()
