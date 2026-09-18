"""
tests/e2e/test_buscadores_codigo_secundario.py

Auditoría pedida por el usuario (18/9/2026) tras encontrar que el buscador
de la pantalla Productos solo matcheaba el código de barras PRINCIPAL de un
producto (ver test_productos_buscar_codigo_secundario.py): "revisa que
todos los buscadores puedan buscar por códigos no principales también".

Se revisó código por código (grep de `es_principal` en todo js/modules/) y
se encontraron 9 lugares más con el mismo patrón (`LEFT JOIN codigos_barras
cb ON ... AND cb.es_principal = 1` reusado también para matchear el texto
buscado, no solo para mostrarlo) — todos corregidos con el mismo patrón que
ya usaban correctamente el POS/Promociones/Etiquetas: la búsqueda usa un
EXISTS sin filtrar por es_principal, y el código PRINCIPAL se muestra aparte
con una subquery propia.

Este archivo cubre los 5 módulos "carrito rápido" (Consumo Interno,
Vencimientos, Roturas, Ajuste de Stock, Ajuste de Stock Positivo) que
comparten exactamente la misma función searchProductos() y el mismo DOM
(#ci-search-input / #ci-search-dropdown, reusado en las 5 pantallas). Los
otros 4 lugares (compras_v2.js, ordenes.js, editor-producto.js x2) tienen
su propio test — ver el mensaje de reporte al usuario para el detalle
completo de qué se revisó y qué no hacía falta tocar.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_buscadores_codigo_secundario.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

CODIGO_PRINCIPAL  = "7790520996985"
CODIGO_SECUNDARIO = "7790520995308"

# hash de ruta -> nombre para los mensajes
MODULOS = ["consumo_interno", "vencimientos", "roturas", "ajuste_stock", "ajuste_stock_positivo"]


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

        print("--- Producto con codigo principal + secundario (como Lysoform) ---")
        page.evaluate(f"""
          () => {{
            const now = new Date().toISOString();
            window.SGA_DB.run(`DELETE FROM productos WHERE id = 'prod-multicod-buscadores'`);
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-multicod-buscadores', 'Lysoform Buscadores Test', 50, 100, 5, 'unidad',
                 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-bq-1', 'prod-multicod-buscadores', '{CODIGO_PRINCIPAL}', 1)`
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('cb-bq-2', 'prod-multicod-buscadores', '{CODIGO_SECUNDARIO}', 0)`
            );
            window.SGA_DB.run(`
              INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad)
              VALUES ('prod-multicod-buscadores', '1', 10)
            `);
          }}
        """)

        for modulo in MODULOS:
            print(f"--- {modulo}: buscar por codigo SECUNDARIO ({CODIGO_SECUNDARIO}) ---")
            page.evaluate(f"window.location.hash = '{modulo}'")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(300)

            search = page.locator("#ci-search-input")
            search.click()
            search.fill(CODIGO_SECUNDARIO)
            page.wait_for_timeout(400)

            dd_html = page.locator("#ci-search-dropdown").inner_html()
            assert "Lysoform Buscadores Test" in dd_html, (
                f"BUG en {modulo}: buscar por el codigo SECUNDARIO no encuentra el producto. "
                f"Dropdown: {dd_html[:300]!r}"
            )
            print(f"OK - {modulo} encuentra el producto por su codigo secundario")

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_buscadores_codigo_secundario: PASA (5 modulos)")


if __name__ == "__main__":
    run()
