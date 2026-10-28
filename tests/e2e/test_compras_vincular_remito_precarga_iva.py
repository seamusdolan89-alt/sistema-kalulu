"""
tests/e2e/test_compras_vincular_remito_precarga_iva.py — Reportado por el
usuario (13/10/2026): al vincular una factura a un remito, casi todos los
productos (los que venían del remito) arrancaban con el IVA en blanco,
obligando a elegirlo a mano aunque el producto ya tuviera un IVA guardado de
una compra anterior. Los únicos que SÍ venían con el IVA precargado eran los
agregados aparte (no del remito) -- consistente con la causa real:
vincularFacturaDesdeRemito() arma cada línea desde remito_items + productos,
pero ni la consulta ni el objeto del ítem incluían productos.iva.

Fix: la consulta ahora trae pr.iva y cada ítem lo precarga, igual que ya
hacía el camino de agregar por buscador.

Cubre: producto con iva='21' ya guardado, remito pendiente con ese producto,
vincular factura -- el select de IVA de esa línea debe mostrar "21%" ya
elegido, no en blanco.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_vincular_remito_precarga_iva.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login + remito pendiente con un producto que ya tiene iva='21' guardado ---")
        login_via_seed(page, admin_pos=False)
        remito_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;
            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_compra, activo)
               VALUES ('prov-iva-remito', 'Proveedor IVA Remito Test', 'Responsable Inscripto', 'Factura B', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, iva, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('p-iva-remito', 'Producto IVA Remito Test', 100, 150, '21', 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`,
              [now, now, now]
            );
            window.SGA_DB.moverStock({ productoId: 'p-iva-remito', sucursalId: '1', delta: 5, tipo: 'compra',
                                       refTipo: 'remitos', refId: 'remito-iva-test', fecha: now });
            window.SGA_DB.run(
              `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
               VALUES ('remito-iva-test', '1', 'prov-iva-remito', ?, ?, 'R-IVA', 'pendiente', 'synced', ?)`,
              [usuarioId, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
               VALUES ('ri-iva-test', 'remito-iva-test', 'p-iva-remito', 5, 'Unidad', 1)`
            );
            return 'remito-iva-test';
          }
        """)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Vincular factura desde el remito ---")
        page.locator("#cv2-btn-remitos-pendientes").click()
        page.wait_for_timeout(300)
        page.locator(f"#cv2-remitos-list .cv2-btn-vincular[data-id='{remito_id}']").click()
        page.wait_for_timeout(400)
        page.fill("#cv2-total-factura", "605")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.locator("#cv2-btn-continuar").click()
        page.wait_for_timeout(400)

        print("--- El IVA de la línea del remito debe venir precargado en 21%, no en blanco ---")
        iva_select = page.locator("tr[data-idx='0'] select[data-field='iva']")
        valor = iva_select.input_value()
        print(f"   IVA mostrado: {valor!r}")
        assert valor == "21", f"BUG: el IVA no vino precargado desde el producto (esperado '21', vino {valor!r})"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_vincular_remito_precarga_iva: PASA "
              "(el IVA ya guardado en el producto se precarga al vincular un remito)")


if __name__ == "__main__":
    main()
