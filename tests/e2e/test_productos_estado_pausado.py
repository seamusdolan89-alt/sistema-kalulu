"""
tests/e2e/test_productos_estado_pausado.py — Listado de Productos: un
producto con la reposición pausada ahora muestra "Pausado" también en la
columna Estado, no solo como distintivo chico al lado del nombre.

Pedido del usuario viendo el listado real: "pausado debería ser un
estado para mostrar en el listado de productos así como se muestra
activo". El badge junto al nombre ya existía (ver memoria
project_pausar_reposicion.md) pero quedaba fuera de la columna Estado,
que es donde el usuario lo busca con la mirada.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_productos_estado_pausado.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")  # consola de Windows (cp1252) no imprime el emoji ⏸

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Producto activo con la reposicion pausada + producto activo normal ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, pausa_reposicion, pausa_reposicion_motivo,
                 pausa_reposicion_desde, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-pausado-1', 'Producto Pausado Test', 50, 100, 5, 'unidad',
                 0, 0, 1, 1, 'Proveedor sin stock', ?, ?, ?, 'pending', ?)`,
              [now, now, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-normal-1', 'Producto Normal Test', 50, 100, 5, 'unidad',
                 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
          }
        """)

        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.fill("#search-productos", "Test")
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "productos_estado_pausado.png"), full_page=True)

        print("--- Columna Estado: el pausado dice 'Pausado', el normal no ---")
        estados = page.evaluate("""
          () => [...document.querySelectorAll('#productos-tbody tr')].map(tr => {
            const tds = tr.querySelectorAll('td');
            return { nombre: tds[1].textContent.trim(), estado: tds[9].innerText.trim() };
          })
        """)
        print(f"Filas: {estados}")

        pausado = next((f for f in estados if 'Pausado Test' in f['nombre']), None)
        normal  = next((f for f in estados if 'Normal Test' in f['nombre']), None)
        assert pausado, f"No se encontro la fila del producto pausado: {estados}"
        assert normal,  f"No se encontro la fila del producto normal: {estados}"

        assert 'Activo' in pausado['estado'] and 'Pausado' in pausado['estado'], (
            f"BUG: la columna Estado del producto pausado no muestra 'Pausado': {pausado['estado']!r}"
        )
        assert 'Pausado' not in normal['estado'], (
            f"El producto sin pausar no deberia decir Pausado en Estado: {normal['estado']!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Columna Estado del listado de Productos distingue Pausado, igual que Activo/Inactivo.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
