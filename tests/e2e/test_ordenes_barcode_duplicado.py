"""
tests/e2e/test_ordenes_barcode_duplicado.py — Regresion de un bug real
reportado por el usuario en Ordenes de Compra: un producto con DOS codigos
de barras marcados es_principal=1 (nada en el schema lo impedia) hacia que
el JOIN de getOrden() (ordenes.js) trajera esa fila de orden DUPLICADA —
mismo item, mismo id, dos <tr> en la tabla. Ademas de verse mal, arrastraba
un segundo bug: la navegacion con flechas (ArrowDown) quedaba TRABADA en
ese par -- indexOf(focusedItemId) siempre devuelve la PRIMERA ocurrencia
de un id repetido, asi que "el siguiente" nunca avanzaba mas alla del
duplicado.

Fix real: el JOIN a codigos_barras pasa a ser una subquery con LIMIT 1
(mismo patron ya usado en otros modulos, ej. buscador_productos.js) --
nunca puede multiplicar filas aunque la data este sucia. Se agrega ademas
un dedup defensivo en la navegacion por si algun otro origen produce ids
repetidos, y una migracion en db.js que limpia el es_principal duplicado
existente (deja el mas antiguo).

Corre con la migracion YA aplicada (se corre en cada init de window.SGA_DB) --
la dirty data se inserta despues del login, asi que representa "la
migracion todavia no vio esto" (ej. llego por sync entre dos ciclos), que
es exactamente el escenario que el fix de la query tiene que cubrir solo.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_barcode_duplicado.py
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

        print("--- Preparar orden con un producto de codigo de barras duplicado ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

            const productos = [
              { id: 'prod-dup-A', nombre: 'Producto A' },
              { id: 'prod-dup-B', nombre: 'Levite Agua Saborizada Pomelo Bot. 500ml' },
              { id: 'prod-dup-C', nombre: 'Producto C' },
            ];
            for (const p of productos) {
              window.SGA_DB.run(
                `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                   es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                 VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
                [p.id, p.nombre, now, now, now]
              );
            }

            // La dirty data real: dos codigos de barras del MISMO producto,
            // los dos marcados es_principal=1 (nada en el schema lo impide).
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES (?, ?, ?, 1)`,
              ['bc-dup-1', 'prod-dup-B', '7790000000001']
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES (?, ?, ?, 1)`,
              ['bc-dup-2', 'prod-dup-B', '7790000000002']
            );

            const ordenId = 'orden-test-barcode-dup';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'borrador', ?, 'pending', ?)`,
              [ordenId, prov.id, now, now]
            );
            // Insertados en este orden: A, B (la del codigo duplicado), C.
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-dup-A', ?, 'prod-dup-A', 5, 'pendiente')`,
              [ordenId]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-dup-B', ?, 'prod-dup-B', 5, 'pendiente')`,
              [ordenId]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-dup-C', ?, 'prod-dup-C', 5, 'pendiente')`,
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
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_barcode_duplicado.png"), full_page=True)

        print("--- La fila del producto con codigo duplicado NO debe aparecer dos veces ---")
        item_ids = page.evaluate("""
          () => [...document.querySelectorAll('#ord-items-tbody tr')].map(tr => tr.dataset.itemId)
        """)
        print(f"Item ids renderizados: {item_ids}")
        assert len(item_ids) == 3, (
            f"BUG: se esperaban 3 filas (una por item), hay {len(item_ids)}: {item_ids} "
            f"-- el JOIN a codigos_barras esta duplicando filas"
        )
        assert len(set(item_ids)) == 3, f"Hay ids repetidos en la tabla: {item_ids}"

        print("--- ArrowDown x4 no debe quedar trabado en el producto duplicado ---")
        # Click en la cabecera de la orden (no en una fila -- cada <tr> tiene
        # su propio mousedown que le da foco, y eso arrancaria la secuencia
        # ya parado en esa fila en vez de arrancar "sin foco" como haria un
        # usuario real que recien entra a la orden).
        page.locator("#ord-items-thead").click()
        page.wait_for_timeout(150)

        focused_sequence = []
        for _ in range(4):
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(120)
            focused = page.evaluate("""
              () => document.querySelector('#ord-items-tbody tr.ord-row-focus')?.dataset.itemId || null
            """)
            focused_sequence.append(focused)
        print(f"Secuencia de foco tras 4x ArrowDown: {focused_sequence}")

        assert focused_sequence[-1] == 'item-dup-C', (
            f"BUG: la navegacion quedo trabada antes de llegar al ultimo item. "
            f"Secuencia: {focused_sequence} (deberia terminar en 'item-dup-C')"
        )
        assert focused_sequence == ['item-dup-A', 'item-dup-B', 'item-dup-C', 'item-dup-C'], (
            f"Secuencia de navegacion inesperada: {focused_sequence}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Producto con codigo de barras duplicado ya no rompe la tabla ni traba la navegacion.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
