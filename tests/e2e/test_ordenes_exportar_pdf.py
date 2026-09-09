"""
tests/e2e/test_ordenes_exportar_pdf.py — Botón "🖨 Exportar PDF" en una orden
de compra: genera un PDF real (vía el diálogo de impresión nativo del
navegador, mismo patrón que etiquetas.js) en vez de una imagen rasterizada.

Motivo (pedido por el usuario): WhatsApp recomprime cualquier imagen
enviada como "Foto" — no importa la resolución de origen, siempre pierde
calidad. Un PDF, en cambio, WhatsApp lo manda siempre como documento
(nunca por la vía de "foto"), así que llega intacto.

Cubre: click en "Exportar PDF" abre una pestaña nueva con el HTML de la
orden (proveedor, fecha, items con su cantidad pedida) y dispara
window.print() sola, sin depender de ninguna librería externa (jsPDF).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_exportar_pdf.py
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
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        # window.print() no hace nada util en headless (no hay impresora real) --
        # lo interceptamos en TODA pagina de este contexto (incluida la pestaña
        # nueva que abre exportarPDF) para poder verificar que se llamo.
        context.add_init_script("""
          window.print = () => { window.__printCalled = true; };
        """)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Preparar una orden 'confirmada' con items ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id, razon_social FROM proveedores LIMIT 1`)[0];

            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-pdf-1', 'Producto Exportar PDF', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now]
            );

            const ordenId = 'orden-test-pdf';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'confirmada', ?, 'pending', ?)`,
              [ordenId, prov.id, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, cantidad_final, estado)
               VALUES ('item-pdf-1', ?, 'prod-pdf-1', 7, 7, 'pendiente')`,
              [ordenId]
            );
            return { ordenId, proveedorNombre: prov.razon_social };
          }
        """)

        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Abrir la orden y clickear 'Exportar PDF' ---")
        page.locator(f'[data-abrir="{orden_id["ordenId"]}"]').click()
        page.wait_for_timeout(400)

        assert page.locator("#ord-btn-exportar-pdf").count() == 1, "No aparecio el boton Exportar PDF"

        with page.expect_popup() as popup_info:
            page.locator("#ord-btn-exportar-pdf").click()
        popup = popup_info.value
        popup.wait_for_load_state("load")
        popup.wait_for_timeout(500)

        popup.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_exportar_pdf.png"), full_page=True)

        contenido = popup.locator("body").inner_text()
        print(f"Contenido de la pestana de PDF: {contenido[:200]!r}")

        assert orden_id["proveedorNombre"] in contenido, (
            f"El PDF no muestra el nombre del proveedor: {contenido[:300]!r}"
        )
        assert "Producto Exportar PDF" in contenido, (
            f"El PDF no muestra el producto de la orden: {contenido[:300]!r}"
        )
        assert "7" in contenido, f"El PDF no muestra la cantidad pedida: {contenido[:300]!r}"

        print_called = popup.evaluate("() => window.__printCalled === true")
        assert print_called, "window.print() no se disparo solo al abrir la pestana del PDF"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - 'Exportar PDF' abre una pestana con el HTML de la orden y dispara window.print() sola.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
