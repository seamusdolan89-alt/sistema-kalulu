"""
tests/e2e/test_compras_pausar_durante_vinculacion.py — Caveat detectado el
24/9/2026 (ver project_vincular_remito_agregar_items), confirmado como bug
real en producción el 8/10/2026 (caso "La Serenisima" reportado por el
usuario): pausar() nunca guardaba state.vinculandoRemitoId en el snapshot, y
resetToNew() lo resetea a null justo después de pausar -- así que al retomar
una compra pausada a mitad de una vinculación de remito, se confirmaba como
si fuera una compra independiente:
  - El remito quedaba "pendiente" para siempre (nunca se marca facturado).
  - El stock de los ítems que venían del remito se volvía a sumar al
    confirmar (doble conteo -- el remito ya lo había sumado al cargarse).

Fix: vinculandoRemitoId y remitoNumero ahora viajan en el snapshot de pausar
y se restauran en resumir().

Cubre: vincular un remito, pausar a mitad de camino, cerrar sin confirmar
(simula "se fue a otra pantalla"), volver a Compras y retomar desde
Pausadas, confirmar -- el remito debe quedar facturado+vinculado a la compra
correcta, y el stock del producto del remito NO debe duplicarse.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_pausar_durante_vinculacion.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def stock_de(page, prod_id):
    return page.evaluate(
        "(id) => (window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id = ? AND sucursal_id = '1'`, [id])[0] || {cantidad: null}).cantidad",
        prod_id,
    )


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

        login_via_seed(page, admin_pos=False)
        page.wait_for_function("() => window.SGA_Auth && window.SGA_DB && window.SGA_Auth.getCurrentUser()")
        page.wait_for_timeout(300)

        print("--- Remito pendiente con un producto (stock ya sumado al cargarse, en 7) ---")
        remito_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;
            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_compra, activo)
               VALUES ('prov-pausa-vinc', 'Proveedor Pausa Vinculacion Test', 'Responsable Inscripto', 'Factura B', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('p-pausa-vinc', 'Producto Pausa Vinculacion Test', 60, 150, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
            window.SGA_DB.moverStock({ productoId: 'p-pausa-vinc', sucursalId: '1', delta: 7, tipo: 'compra',
                                       refTipo: 'remitos', refId: 'remito-pausa-vinc', fecha: now });
            window.SGA_DB.run(
              `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
               VALUES ('remito-pausa-vinc', '1', 'prov-pausa-vinc', ?, ?, 'R-0099', 'pendiente', 'synced', ?)`,
              [usuarioId, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
               VALUES ('ri-pausa-vinc', 'remito-pausa-vinc', 'p-pausa-vinc', 7, 'Unidad', 1)`
            );
            return 'remito-pausa-vinc';
          }
        """)
        assert stock_de(page, "p-pausa-vinc") == 7

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Vincular factura: cabecera, continuar al carrito ---")
        page.locator("#cv2-btn-remitos-pendientes").click()
        page.wait_for_timeout(300)
        page.locator(f"#cv2-remitos-list .cv2-btn-vincular[data-id='{remito_id}']").click()
        page.wait_for_timeout(400)
        page.fill("#cv2-total-factura", "420")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.locator("#cv2-btn-continuar").click()
        page.wait_for_timeout(400)

        print("--- Pausar A MITAD de la vinculación (antes de confirmar) ---")
        page.locator("#cv2-btn-pausar").click()
        page.wait_for_timeout(400)

        print("--- Simular 'se fue a otra pantalla': navegar afuera y volver a Compras ---")
        page.evaluate("window.location.hash = '#pos'")
        page.wait_for_timeout(300)
        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Retomar desde Pausadas ---")
        page.locator("#cv2-btn-pausadas").click()
        page.wait_for_timeout(300)
        page.locator('.cv2-pausada-item [data-action="resume"]').click()
        page.wait_for_timeout(400)

        print("--- El banner de vinculación debe seguir mostrándose tras retomar ---")
        banner_visible = page.locator("#cv2-vincular-banner").is_visible()
        assert banner_visible, "BUG: el banner de 'vinculando remito' no aparece tras retomar -- se perdió el estado"

        print("--- Confirmar la compra: Siguiente -> Revision -> Confirmar Ingreso ---")
        page.locator("#cv2-btn-confirmar").click()
        page.wait_for_timeout(500)
        page.locator("#cv2-rev-btn-confirmar").click()
        page.wait_for_timeout(1200)

        compra = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT id, total FROM compras WHERE proveedor_id = 'prov-pausa-vinc' ORDER BY fecha DESC LIMIT 1`)[0]
        """)
        assert compra, "No se creo la compra"

        print("--- El remito debe quedar facturado y vinculado a ESTA compra ---")
        remito = page.evaluate(
            "() => window.SGA_DB.query(`SELECT estado, compra_id, sync_status FROM remitos WHERE id = 'remito-pausa-vinc'`)[0]"
        )
        print(f"   remito: {remito}")
        assert remito["estado"] == "facturado" and remito["compra_id"] == compra["id"], (
            f"BUG: el remito no quedo vinculado a la compra retomada (se perdio vinculandoRemitoId al pausar/retomar): {remito}"
        )

        print("--- El stock del producto del remito NO debe duplicarse ---")
        s1 = stock_de(page, "p-pausa-vinc")
        assert s1 == 7, f"BUG: el stock se duplico al confirmar una compra pausada mid-vinculacion (esperado 7, hay {s1})"

        integridad = page.evaluate("() => window.SGA_DB.verificarIntegridadStock()")
        assert integridad == [], f"El ledger de stock quedo inconsistente: {integridad}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_pausar_durante_vinculacion: PASA "
              "(pausar/retomar a mitad de vincular un remito ya no pierde el vínculo)")


if __name__ == "__main__":
    main()
