"""
tests/e2e/test_ordenes_notas_persisten.py — Las notas que se tipean en un
item de una Orden de Compra deben persistir al salir y volver a entrar.

Reportado por el usuario (con captura de una orden confirmada): "en ninguno
se ve comentario, pero cuando genere la orden a algunos productos si les
habia colocado comentario."

Causa raiz: la columna `orden_compra_items.notas` nunca tuvo su
`ALTER TABLE ... ADD COLUMN` en db.js (a diferencia de `codigo_proveedor`,
`stock_actual`, etc., que si la tienen) -- pero ordenes.js si la lee/escribe
como si existiera. `db().run()` traga errores en silencio (los loguea a
consola y devuelve `changes: 0`), asi que el UPDATE de auto-guardado en cada
blur fallaba siempre sin que nada lo mostrara, y la nota jamas se guardaba.
Fix: agregar el ALTER TABLE en db.js (y sumar `notas` a las columnas que
sync.js aplica en un pull, donde tambien faltaba).

Cubre: tipear una nota en un item, salir de la orden, volver a entrar, y
confirmar que la nota sigue ahi (evidencia de que quedo en la base, no solo
en el DOM en memoria).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_notas_persisten.py
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

        print("--- Preparar orden de compra con 1 item (por SQL) ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-notas-1', 'Fideos Matarazzo 500g', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );

            const ordenId = 'orden-test-notas';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'borrador', ?, 'pending', ?)`,
              [ordenId, prov.id, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado)
               VALUES ('item-notas-1', ?, 'prod-notas-1', 5, 'pendiente')`,
              [ordenId]
            );
            return ordenId;
          }
        """)

        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Abrir la orden y tipear una nota en el item ---")
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)

        NOTA = "Pedir sabor clasico, no integral"
        notas_input = page.locator('#ord-items-tbody tr[data-item-id="item-notas-1"] .ord-cell-input-text')
        notas_input.fill(NOTA)
        notas_input.blur()
        page.wait_for_timeout(300)

        # El auto-guardado va por db().run(), que traga errores en silencio --
        # si fallo (como pasaba sin el fix), no hay excepcion ni en la pagina.
        # El chequeo real es leer la base despues de salir y volver a entrar.
        print("--- Salir de la orden y volver a entrar ---")
        page.locator("#ord-btn-back").click()
        page.wait_for_timeout(300)
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_notas_persisten.png"), full_page=True)

        nota_persistida = page.locator(
            '#ord-items-tbody tr[data-item-id="item-notas-1"] .ord-cell-input-text'
        ).input_value()
        print(f"Nota tras reabrir: {nota_persistida!r}")
        assert nota_persistida == NOTA, (
            f"BUG: la nota no persistio -- se tipeo {NOTA!r} y al reabrir la orden quedo "
            f"{nota_persistida!r}. Sintoma tipico de una columna 'notas' que no existe en "
            f"orden_compra_items (el UPDATE falla en silencio)."
        )

        # Chequeo directo en la base, sin pasar por el DOM: confirma que el
        # ALTER TABLE realmente corrio y la columna tiene el valor.
        nota_en_db = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT notas FROM orden_compra_items WHERE id = 'item-notas-1'`
          )[0]?.notas
        """)
        assert nota_en_db == NOTA, (
            f"BUG: la columna orden_compra_items.notas en la base tiene {nota_en_db!r}, "
            f"no la nota tipeada."
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - La nota de un item de Orden de Compra persiste al salir y reabrir la orden.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
