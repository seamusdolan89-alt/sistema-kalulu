"""
tests/e2e/test_compras_eliminar_remito.py — Pedido del usuario (10/10/2026,
tras resolver a mano un remito duplicado por consola): agregar un botón para
eliminar un remito pendiente desde la UI, mismo patrón que "Anular compra" /
anular pago / anular NC — motivo obligatorio, Admin-POS únicamente, y
revierte el stock que el remito sumó al cargarse antes de borrarlo con marca
(requiere 'remitos' en HIJOS_DE, ver fix anterior del mismo día).

Cubre: el botón "🗑️ Eliminar" solo aparece en Admin-POS (igual que "✏️
Editar"); sin motivo no deja confirmar; al confirmar borra el remito+items,
revierte el stock, deja la marca de eliminación pending, y el remito
desaparece de la lista de pendientes.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_eliminar_remito.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def stock_de(page, prod_id):
    return q(page, "SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id='1'", [prod_id])[0]["cantidad"]


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

        print("--- Login admin-pos + remito pendiente duplicado ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;
            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, activo) VALUES ('prov-elim-remito', 'Proveedor Eliminar Remito Test', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, activo,
                 fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('p-elim-remito', 'Producto Eliminar Remito Test', 50, 90, 1, 'unidad', 1, ?, ?, 'synced', ?)`,
              [now, now, now]
            );
            window.SGA_DB.moverStock({ productoId: 'p-elim-remito', sucursalId: '1', delta: 5, tipo: 'compra',
                                       refTipo: 'remitos', refId: 'remito-elim-test', fecha: now });
            window.SGA_DB.run(
              `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
               VALUES ('remito-elim-test', '1', 'prov-elim-remito', ?, ?, 'R-DUP', 'pendiente', 'synced', ?)`,
              [usuarioId, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
               VALUES ('ri-elim-test', 'remito-elim-test', 'p-elim-remito', 5, 'Unidad', 1)`
            );
          }
        """)
        assert stock_de(page, "p-elim-remito") == 5

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Abrir Remitos Pendientes ---")
        page.locator("#cv2-btn-remitos-pendientes").click()
        page.wait_for_timeout(300)

        btn_eliminar = page.locator("#cv2-remitos-list .cv2-btn-eliminar-remito[data-id='remito-elim-test']")
        assert btn_eliminar.count() == 1, "No aparece el boton Eliminar en Admin-POS"
        btn_eliminar.click()
        page.wait_for_timeout(300)

        print("--- Sin motivo, Confirmar debe rechazar ---")
        page.locator("#cv2-elim-remito-confirmar").click()
        page.wait_for_timeout(200)
        assert page.locator("#cv2-elim-remito-error").is_visible(), "Deberia pedir el motivo"
        remito_sigue = q(page, "SELECT id FROM remitos WHERE id='remito-elim-test'")
        assert len(remito_sigue) == 1, "BUG: se elimino sin motivo"

        print("--- Con motivo, confirmar elimina ---")
        page.fill("#cv2-elim-remito-motivo", "Cargado por error, duplicado")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "eliminar_remito_modal.png"), full_page=True)
        page.locator("#cv2-elim-remito-confirmar").click()
        page.wait_for_timeout(400)

        remito_despues = q(page, "SELECT * FROM remitos WHERE id='remito-elim-test'")
        items_despues = q(page, "SELECT * FROM remito_items WHERE remito_id='remito-elim-test'")
        marca = q(page, "SELECT * FROM eliminaciones WHERE tabla='remitos' AND registro_id='remito-elim-test'")
        assert remito_despues == [], f"BUG: el remito no se borro: {remito_despues}"
        assert items_despues == [], f"BUG: los items no se borraron: {items_despues}"
        assert len(marca) == 1 and marca[0]["sync_status"] == "pending", f"BUG: no quedo la marca de eliminacion: {marca}"

        stock_final = stock_de(page, "p-elim-remito")
        assert stock_final == 0, f"BUG: el stock no se revirtio (esperado 0, hay {stock_final})"
        print(f"   OK - remito borrado, marca registrada, stock revertido ({stock_final})")

        assert "No hay remitos pendientes" in page.locator("#cv2-remitos-list").inner_text() or \
               page.locator("#cv2-remitos-list .cv2-remito-item").count() == 0, \
               "El remito deberia haber desaparecido de la lista"

        integridad = page.evaluate("() => window.SGA_DB.verificarIntegridadStock()")
        assert integridad == [], f"El ledger de stock quedo inconsistente: {integridad}"

        print("--- POS del local (no admin): el boton Eliminar NO debe aparecer ---")
        pos = context.new_page()
        pos.on("dialog", lambda d: d.accept())
        login_via_seed(pos, admin_pos=False)
        pos.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;
            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, activo) VALUES ('prov-elim-remito-pos', 'Prov Eliminar Remito POS Test', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
               VALUES ('remito-elim-pos-test', '1', 'prov-elim-remito-pos', ?, ?, 'R-POS', 'pendiente', 'synced', ?)`,
              [usuarioId, now, now]
            );
          }
        """)
        pos.evaluate("window.location.hash = 'compras_v2'")
        pos.wait_for_load_state("networkidle")
        pos.wait_for_timeout(500)
        pos.locator("#cv2-btn-remitos-pendientes").click()
        pos.wait_for_timeout(300)
        assert pos.locator("#cv2-remitos-list .cv2-btn-eliminar-remito").count() == 0, \
            "BUG: el boton Eliminar aparece en el POS del local (no deberia, es solo Admin-POS)"
        print("   OK - el boton no aparece en el POS")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_eliminar_remito: PASA")


if __name__ == "__main__":
    main()
