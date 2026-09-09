"""
tests/e2e/test_ordenes_agregar_orden_insercion.py — Al agregar un producto
manualmente a una orden de compra, debe aparecer AL FINAL del listado (en
el orden en que se agregó), no reordenado alfabéticamente entre los items
existentes.

Reportado por el usuario: "cuando agrego un producto a la orden, ese
producto quiero que aparezca último, al final del listado. Hoy se agrega y
se acomoda alfabéticamente en el listado existente, cosa que lo hace
difícil de encontrar o de corroborar si se agregó o no."

Causa raíz: `getOrden()` en ordenes.js traía los items con
`ORDER BY pr.nombre` — cualquier producto agregado terminaba reordenado
según su nombre en vez de quedar al final.

Cubre: una orden con 2 items ya cargados (nombres que alfabéticamente van
primero), agregar manualmente un tercer producto cuyo nombre alfabéticamente
iría PRIMERO ("AAA ..."), y verificar que de todas formas aparece último.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_agregar_orden_insercion.py
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
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Preparar orden de compra con 2 items (por SQL) ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

            const productos = [
              { id: 'prod-ord-1', nombre: 'Bebida Cola 2L' },
              { id: 'prod-ord-2', nombre: 'Cereal Arroz 1kg' },
              { id: 'prod-ord-3', nombre: 'AAA Agua Mineral 500ml' },
            ];
            for (const p of productos) {
              window.SGA_DB.run(
                `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                   es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                 VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
                [p.id, p.nombre, now, now, now]
              );
            }

            const ordenId = 'orden-test-insercion';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'borrador', ?, 'pending', ?)`,
              [ordenId, prov.id, now, now]
            );
            // Insertados en este orden -- 'prod-ord-1' primero, 'prod-ord-2' despues.
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-1', ?, 'prod-ord-1', 5, 'pendiente')`,
              [ordenId]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-2', ?, 'prod-ord-2', 5, 'pendiente')`,
              [ordenId]
            );
            return ordenId;
          }
        """)

        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Abrir la orden de prueba ---")
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)

        nombres_antes = page.evaluate("""
          () => [...document.querySelectorAll('#ord-items-tbody tr')].map(tr => tr.dataset.nombre)
        """)
        print(f"Orden inicial: {nombres_antes}")

        print("--- Agregar 'AAA Agua Mineral 500ml' (alfabeticamente iria primero) ---")
        page.locator("#ord-btn-add-item").click()
        page.wait_for_timeout(300)
        page.locator("#ord-agregar-search").type("AAA Agua", delay=20)
        page.wait_for_timeout(400)
        page.locator(".ord-search-result", has_text="AAA Agua Mineral").click()
        page.wait_for_timeout(400)

        print("--- Verificar orden de las filas ---")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_agregar_insercion.png"), full_page=True)

        nombres = page.evaluate("""
          () => [...document.querySelectorAll('#ord-items-tbody tr')].map(tr => tr.dataset.nombre)
        """)
        print(f"Orden final: {nombres}")

        assert len(nombres) == 3, f"Esperaba 3 items en la orden, hay {len(nombres)}: {nombres}"
        assert nombres[-1] == 'AAA Agua Mineral 500ml', (
            f"BUG: el producto recien agregado no quedo al final -- quedo reordenado "
            f"alfabeticamente. Orden real: {nombres}"
        )
        assert nombres[0] == 'Bebida Cola 2L' and nombres[1] == 'Cereal Arroz 1kg', (
            f"Los items existentes no deberian cambiar de orden entre si: {nombres}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - El producto agregado manualmente queda al final del listado, no reordenado alfabeticamente.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
