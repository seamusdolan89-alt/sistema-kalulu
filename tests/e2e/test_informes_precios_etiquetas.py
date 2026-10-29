"""
tests/e2e/test_informes_precios_etiquetas.py

Informes -> "Precios y Etiquetas" (29/10/2026, pedido explícito del usuario): un listado
de Producto / última fecha de impresión de etiqueta / última fecha de modificación de
precio, con un filtro de "sin cambios de precio hace N+ días" (mismo patrón que "Stock
sin Movimiento") que también sirve para el segundo pedido — ver productos que no
tocaron ni costo ni precio en determinado período. Las dos necesidades conviven en la
misma pantalla: value="0" ("Todos los productos") muestra el listado completo sin
filtrar, cualquier otro valor filtra por antigüedad.

No hace falta trackear nada nuevo: ultima_modificacion_precio/ultima_impresion_etiqueta
ya existen en productos y ya se actualizan en Compras, Editor de Producto, Familia y
Operaciones de Stock (ver CLAUDE.md). El reporte también calcula "pendiente_imprimir"
con la MISMA condición que "Etiquetas sugeridas" (etiquetas.js) — precio cambió después
de la última impresión, o nunca se imprimió — para marcar qué etiquetas quedaron
desactualizadas.

Verifica: el reporte aparece en el selector, el filtro "Todos" muestra un producto con
cambio de precio reciente Y uno con cambio viejo, y el filtro "30+ días" excluye el
reciente pero conserva el viejo.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_precios_etiquetas.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login Admin-POS (sga-admin.db) + seed ---")
        login_via_seed(page, admin_pos=True)

        print("--- Producto con cambio de precio reciente + uno con cambio viejo (200d) ---")
        nombres = page.evaluate("""
          () => {
            const prods = window.SGA_DB.query(`SELECT id, nombre FROM productos LIMIT 2`);
            const now = new Date().toISOString();
            const old = new Date(Date.now() - 200 * 86400000).toISOString();
            window.SGA_DB.run(`UPDATE productos SET ultima_modificacion_precio = ? WHERE id = ?`, [now, prods[0].id]);
            window.SGA_DB.run(`UPDATE productos SET ultima_modificacion_precio = ? WHERE id = ?`, [old, prods[1].id]);
            return [prods[0].nombre, prods[1].nombre];
          }
        """)
        p_reciente, p_viejo = nombres

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        sel = page.locator("#inf-sel-reporte")
        opciones = sel.locator("option").all_inner_texts()
        assert "Precios y Etiquetas" in opciones, f"El reporte no aparece en el selector: {opciones}"
        sel.select_option("precios_etiquetas")
        page.wait_for_timeout(100)

        dias_sel = page.locator("#inf-dias-sin-precio")
        assert dias_sel.count() > 0, "Falta el filtro de días sin modificar precio"

        print("--- Filtro 'Todos los productos' ---")
        dias_sel.select_option("0")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(200)
        tabla_todos = page.locator(".inf-table").inner_text()
        assert p_reciente in tabla_todos, f"'Todos' debería incluir el producto con cambio reciente: {p_reciente}"
        assert p_viejo in tabla_todos, f"'Todos' debería incluir el producto con cambio viejo: {p_viejo}"

        print("--- Filtro 'Hace 30+ días' ---")
        dias_sel.select_option("30")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(200)
        tabla_30 = page.locator(".inf-table").inner_text()
        assert p_reciente not in tabla_30, (
            f"BUG: el filtro de 30+ días no debería incluir un producto modificado HOY: {p_reciente}"
        )
        assert p_viejo in tabla_30, (
            f"BUG: el filtro de 30+ días debería incluir un producto modificado hace 200 días: {p_viejo}"
        )

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_informes_precios_etiquetas: PASA")


if __name__ == "__main__":
    run()
