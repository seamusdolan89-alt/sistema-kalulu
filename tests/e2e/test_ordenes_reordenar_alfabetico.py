"""
tests/e2e/test_ordenes_reordenar_alfabetico.py — Botón "A→Z" en el header
"Descripción" de una orden de compra: reordena los items alfabéticamente
por nombre de producto, de forma persistente (recargar la orden no vuelve
al orden de inserción).

Pedido por el usuario junto con el fix de "agregar producto queda al
final" (ver test_ordenes_agregar_orden_insercion.py): necesita que los
productos se sumen al final mientras arma el pedido (para confirmar que se
agregaron), pero poder reordenar todo alfabéticamente antes de mandarle la
orden al proveedor, para que le sea más fácil de recorrer.

Cubre: una orden con 3 items cargados en un orden deliberadamente NO
alfabético, click en "A→Z", verificar que quedan alfabéticos, y que
siguen alfabéticos después de salir de la orden y volver a entrar (persiste
en la base, no es un sort de UI nomás).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_reordenar_alfabetico.py
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

        print("--- Preparar orden de compra con 3 items fuera de orden alfabetico ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

            const productos = [
              { id: 'prod-az-1', nombre: 'Zapallo Anco 1kg' },
              { id: 'prod-az-2', nombre: 'Manteca La Serenisima 200g' },
              { id: 'prod-az-3', nombre: 'Arroz Gallo Oro 1kg' },
            ];
            for (const p of productos) {
              window.SGA_DB.run(
                `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                   es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                 VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
                [p.id, p.nombre, now, now, now]
              );
            }

            const ordenId = 'orden-test-az';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'borrador', ?, 'pending', ?)`,
              [ordenId, prov.id, now, now]
            );
            // Insertados en orden Z, M, A -- deliberadamente al reves del alfabeto.
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-az-1', ?, 'prod-az-1', 5, 'pendiente')`, [ordenId]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-az-2', ?, 'prod-az-2', 5, 'pendiente')`, [ordenId]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-az-3', ?, 'prod-az-3', 5, 'pendiente')`, [ordenId]
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

        def nombres_actuales():
            return page.evaluate("""
              () => [...document.querySelectorAll('#ord-items-tbody tr')].map(tr => tr.dataset.nombre)
            """)

        antes = nombres_actuales()
        print(f"Orden antes de reordenar: {antes}")
        assert antes == ['Zapallo Anco 1kg', 'Manteca La Serenisima 200g', 'Arroz Gallo Oro 1kg'], (
            f"La orden inicial (insercion) no es la esperada: {antes}"
        )

        print("--- Click en el boton A->Z ---")
        assert page.locator("#ord-btn-sort-az").count() == 1, "No aparecio el boton A->Z en el header Descripcion"
        page.locator("#ord-btn-sort-az").click()
        page.wait_for_timeout(300)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_reordenar_az.png"), full_page=True)

        despues = nombres_actuales()
        print(f"Orden despues de A->Z: {despues}")
        assert despues == ['Arroz Gallo Oro 1kg', 'Manteca La Serenisima 200g', 'Zapallo Anco 1kg'], (
            f"BUG: no quedo en orden alfabetico tras apretar A->Z: {despues}"
        )

        print("--- Verificar que persiste: salir de la orden y volver a entrar ---")
        page.locator("#ord-btn-back").click()
        page.wait_for_timeout(300)
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)

        persistido = nombres_actuales()
        print(f"Orden al reabrir: {persistido}")
        assert persistido == despues, (
            f"BUG: el reorden alfabetico no persistio -- al reabrir la orden volvio a otro orden: {persistido}"
        )

        print("--- Flujo combinado: tras reordenar, un producto nuevo sigue yendo al final ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-az-4', 'Aceite Natura 900ml', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now]
            );
          }
        """)
        page.locator("#ord-btn-add-item").click()
        page.wait_for_timeout(300)
        page.locator("#ord-agregar-search").type("Aceite Natura", delay=20)
        page.wait_for_timeout(400)
        page.locator(".ord-search-result", has_text="Aceite Natura").click()
        page.wait_for_timeout(400)

        final = nombres_actuales()
        print(f"Orden tras agregar 'Aceite Natura' post-reorden: {final}")
        assert final[-1] == 'Aceite Natura 900ml', (
            f"BUG: tras reordenar A->Z, el siguiente producto agregado deberia seguir yendo al "
            f"final (no alfabetico) -- aunque alfabeticamente 'Aceite' iria primero: {final}"
        )
        assert final[:3] == despues, f"Los items ya reordenados no deberian moverse al agregar uno nuevo: {final}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - El boton A->Z reordena alfabeticamente, persiste, y agregar despues sigue yendo al final.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
