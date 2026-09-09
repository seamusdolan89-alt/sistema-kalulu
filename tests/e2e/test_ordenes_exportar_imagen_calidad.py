"""
tests/e2e/test_ordenes_exportar_imagen_calidad.py — "Exportar imagen" de una
orden de compra (botón visible una vez que la orden ya no es editable, ej.
'confirmada') usa scale:3 en html2canvas en vez de scale:2, para que la
imagen quede más nítida al reenviarla por WhatsApp o hacerle zoom (pedido
por el usuario: "hay que mejorar la calidad de la imagen exportada").

Cubre: interceptar la llamada real a window.html2canvas (sin parsear el PNG
resultante en bytes) y verificar que el `scale` que le llega es 3, y que el
export sigue terminando en éxito ("Imagen exportada").

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_exportar_imagen_calidad.py
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
        context = browser.new_context(
            viewport={"width": 1500, "height": 1000},
            accept_downloads=True,
        )
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Preparar una orden 'confirmada' con items (el boton de exportar solo sale asi) ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-exp-1', 'Producto Exportar Calidad', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now]
            );

            const ordenId = 'orden-test-exportar';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'confirmada', ?, 'pending', ?)`,
              [ordenId, prov.id, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, cantidad_final, estado)
               VALUES ('item-exp-1', ?, 'prod-exp-1', 5, 5, 'pendiente')`,
              [ordenId]
            );
            return ordenId;
          }
        """)

        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Abrir la orden y espiar la llamada a html2canvas ---")
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)

        page.evaluate("""
          () => {
            window.__capturedOpts = null;
            const original = window.html2canvas;
            window.html2canvas = async (el, opts) => {
              window.__capturedOpts = opts;
              return original(el, opts);
            };
          }
        """)

        assert page.locator("#ord-btn-exportar").count() == 1, "No aparecio el boton Exportar imagen"
        page.locator("#ord-btn-exportar").click()
        page.wait_for_timeout(1200)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_exportar_calidad.png"), full_page=True)

        scale_usado = page.evaluate("() => window.__capturedOpts && window.__capturedOpts.scale")
        print(f"scale pasado a html2canvas: {scale_usado}")
        assert scale_usado == 3, (
            f"BUG: se esperaba scale:3 para mejorar la calidad de la imagen exportada, "
            f"se uso scale:{scale_usado}"
        )

        # El boton queda disabled con texto "Generando..." mientras exporta (ver
        # exportarImagen) -- que haya vuelto a su estado normal confirma que el
        # export termino sin quedarse colgado ni tirar al catch de error.
        btn_text = page.locator("#ord-btn-exportar").inner_text()
        btn_disabled = page.locator("#ord-btn-exportar").is_disabled()
        assert "Exportar imagen" in btn_text and not btn_disabled, (
            f"El boton no volvio a su estado normal tras exportar (texto={btn_text!r}, disabled={btn_disabled})"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - 'Exportar imagen' usa scale:3 (antes scale:2) y sigue terminando en exito.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
