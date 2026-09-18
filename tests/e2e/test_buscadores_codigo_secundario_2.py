"""
tests/e2e/test_buscadores_codigo_secundario_2.py

Segunda parte de la auditoría de buscadores que solo matcheaban el código
de barras PRINCIPAL (ver test_productos_buscar_codigo_secundario.py y
test_buscadores_codigo_secundario.py para los primeros 6 lugares
encontrados). Este archivo cubre los otros 4:

  - compras_v2.js: buscador del carrito de compras (searchProductos)
  - ordenes.js: buscador de "Agregar producto" dentro de una orden
  - editor-producto.js: buscador de "referencia" en la pestaña Sustitutos
  - editor-producto.js: buscador de "agregar miembro al grupo" (misma pestaña)

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_buscadores_codigo_secundario_2.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

CODIGO_PRINCIPAL  = "7790520996985"
CODIGO_SECUNDARIO = "7790520995308"
PROD_ID = "prod-multicod-bq2"


def sembrar_producto_multicod(page, nombre="Lysoform Buscadores2 Test"):
    page.evaluate(f"""
      () => {{
        const now = new Date().toISOString();
        window.SGA_DB.run(`DELETE FROM productos WHERE id = '{PROD_ID}'`);
        window.SGA_DB.run(
          `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
             es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
           VALUES ('{PROD_ID}', '{nombre}', 50, 100, 5, 'unidad',
             0, 0, 1, ?, ?, 'pending', ?)`,
          [now, now, now]
        );
        window.SGA_DB.run(`DELETE FROM codigos_barras WHERE producto_id = '{PROD_ID}'`);
        window.SGA_DB.run(
          `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-bq2-1', '{PROD_ID}', '{CODIGO_PRINCIPAL}', 1)`
        );
        window.SGA_DB.run(
          `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-bq2-2', '{PROD_ID}', '{CODIGO_SECUNDARIO}', 0)`
        );
      }}
    """)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1800, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)
        sembrar_producto_multicod(page)

        # ── 1) compras_v2: carrito de compras ──────────────────────────────
        print("--- compras_v2: buscar por codigo SECUNDARIO en el carrito de compras ---")
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
        page.fill("#cv2-subtotal-neto", "100")
        page.locator("#cv2-subtotal-neto").blur()
        page.fill("#cv2-iva-21", "21")
        page.locator("#cv2-iva-21").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        page.locator("#cv2-search").click()
        page.keyboard.type(CODIGO_SECUNDARIO, delay=10)
        page.wait_for_timeout(300)
        dd_html = page.locator("#cv2-dropdown").inner_html()
        assert "Lysoform Buscadores2 Test" in dd_html, (
            f"BUG en compras_v2 (carrito): no encuentra por codigo secundario. Dropdown: {dd_html[:300]!r}"
        )
        print("OK - compras_v2 (carrito) encuentra el producto por su codigo secundario")

        # ── 2) ordenes: agregar producto a una orden ───────────────────────
        print("--- ordenes: buscar por codigo SECUNDARIO en 'Agregar producto' ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];
            const ordenId = 'orden-test-bq2';
            window.SGA_DB.run(`DELETE FROM ordenes_compra WHERE id = ?`, [ordenId]);
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'borrador', ?, 'pending', ?)`,
              [ordenId, prov.id, now, now]
            );
            return ordenId;
          }
        """)
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)
        page.locator("#ord-btn-add-item").click()
        page.wait_for_timeout(300)
        page.locator("#ord-agregar-search").type(CODIGO_SECUNDARIO, delay=10)
        page.wait_for_timeout(400)
        results_html = page.locator("#ord-agregar-results").inner_html()
        assert "Lysoform Buscadores2 Test" in results_html, (
            f"BUG en ordenes (agregar producto): no encuentra por codigo secundario. Resultados: {results_html[:300]!r}"
        )
        print("OK - ordenes (agregar producto) encuentra el producto por su codigo secundario")

        # ── 3) editor-producto: buscador de "referencia" en Sustitutos ─────
        print("--- editor-producto: buscar por codigo SECUNDARIO en 'referencia' de Sustitutos ---")
        # Un segundo producto (el que va a buscar) para no auto-referenciarse.
        target_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(`DELETE FROM productos WHERE id = 'prod-target-bq2'`);
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-target-bq2', 'Producto Target BQ2', 10, 20, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
            return 'prod-target-bq2';
          }
        """)
        page.evaluate(f"window.location.hash = 'editor-producto/{target_id}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator("[data-section='sustitutos']").first.click()
        page.wait_for_timeout(300)

        page.fill("#ed-ref-search", CODIGO_SECUNDARIO)
        page.wait_for_timeout(300)
        ref_dd_html = page.locator("#ed-ref-dropdown").inner_html()
        assert "Lysoform Buscadores2 Test" in ref_dd_html, (
            f"BUG en editor-producto (buscador de referencia): no encuentra por codigo secundario. "
            f"Dropdown: {ref_dd_html[:300]!r}"
        )
        print("OK - editor-producto (buscador de referencia) encuentra el producto por su codigo secundario")

        # ── 4) editor-producto: "agregar miembro al grupo" ─────────────────
        print("--- editor-producto: buscar por codigo SECUNDARIO en 'agregar miembro al grupo' ---")
        page.locator("#ed-ref-dropdown .ed-search-result-item[data-id]").first.click()
        page.wait_for_timeout(400)
        # Tras asignar la referencia (Lysoform Buscadores2 Test), la pestaña
        # se re-renderiza mostrando el buscador para agregar mas miembros al
        # mismo grupo -- un TERCER producto, distinto al ya asignado.
        codigo_tercero_sec = "7790520995399"
        page.evaluate(f"""
          () => {{
            const now = new Date().toISOString();
            window.SGA_DB.run(`DELETE FROM productos WHERE id = 'prod-tercero-bq2'`);
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-tercero-bq2', 'Producto Tercero BQ2', 10, 20, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
            window.SGA_DB.run(`DELETE FROM codigos_barras WHERE producto_id = 'prod-tercero-bq2'`);
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-bq2-3p', 'prod-tercero-bq2', '7790520995398', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-bq2-3s', 'prod-tercero-bq2', '{codigo_tercero_sec}', 0)`
            );
          }}
        """)
        page.fill("#ed-sustituto-search", codigo_tercero_sec)
        page.wait_for_timeout(300)
        sust_dd_html = page.locator("#ed-sustituto-dropdown").inner_html()
        assert "Producto Tercero BQ2" in sust_dd_html, (
            f"BUG en editor-producto (agregar miembro al grupo): no encuentra por codigo secundario. "
            f"Dropdown: {sust_dd_html[:300]!r}"
        )
        print("OK - editor-producto (agregar miembro al grupo) encuentra el producto por su codigo secundario")

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_buscadores_codigo_secundario_2: PASA (4 lugares mas)")


if __name__ == "__main__":
    run()
