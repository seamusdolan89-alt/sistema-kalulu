"""
tests/e2e/test_productos_buscar_codigo_secundario.py

Bug reportado por el usuario (18/9/2026): un producto con varios códigos de
barras (ej. Lysoform con 3 códigos distintos, uno "principal" y dos
adicionales) SÍ aparecía al escanear/buscar uno de los códigos secundarios
en el buscador del carrito del POS, pero NO aparecía al buscarlo por ese
mismo código en el buscador de la pantalla Productos ("Buscar por nombre o
código...").

Causa raíz: `loadProductos()` (js/modules/productos.js) traía el código de
barras con `LEFT JOIN codigos_barras cb ON ... AND cb.es_principal = 1` —
un solo código por producto. El buscador principal (`applyFilters`), el
dropdown de sugerencias (`renderSearchDropdown`) y el de "Asignar madre"
(`renderAssignMadreDropdown`) filtraban `state.productos` en memoria contra
ese único campo `codigo_barras`, así que un código no-principal nunca podía
matchear. El buscador del carrito del POS (`searchProductos` en pos.js) en
cambio hace el JOIN sin filtrar por `es_principal`, así que sí encuentra
cualquier código.

Fix: `loadProductos()` agrega `todos_codigos_barras` (todos los códigos del
producto, igual que ya hacía la exportación a Excel) y los tres lugares que
filtran por código ahora lo usan en vez de (con fallback a) `codigo_barras`.
La columna del listado sigue mostrando solo el código principal — no
cambia, es la búsqueda la que ahora contempla todos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_productos_buscar_codigo_secundario.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

CODIGO_PRINCIPAL   = "7790520996985"
CODIGO_SECUNDARIO  = "7790520995308"


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Producto con codigo principal + dos secundarios (como Lysoform) ---")
        page.evaluate(f"""
          () => {{
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-multicod-1', 'Lysoform Aerosol Test', 50, 100, 5, 'unidad',
                 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-mc-1', 'prod-multicod-1', '{CODIGO_PRINCIPAL}', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-mc-2', 'prod-multicod-1', '{CODIGO_SECUNDARIO}', 0)`
            );
          }}
        """)

        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print(f"--- Buscar por el codigo SECUNDARIO ({CODIGO_SECUNDARIO}) en el buscador de Productos ---")
        page.fill("#search-productos", CODIGO_SECUNDARIO)
        page.wait_for_timeout(400)

        tabla_html = page.locator(".productos-table, #productos-tbody, tbody").first.inner_text()
        assert "Lysoform Aerosol Test" in tabla_html, (
            f"BUG: buscar por un codigo de barras SECUNDARIO no encuentra el producto en la "
            f"pantalla Productos (aunque el buscador del carrito del POS sí lo encuentra). "
            f"Contenido de la tabla: {tabla_html[:400]!r}"
        )
        print("OK - el buscador principal de Productos encuentra el producto por su codigo secundario")

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_productos_buscar_codigo_secundario: PASA")


if __name__ == "__main__":
    run()
