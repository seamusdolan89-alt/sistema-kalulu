"""
tests/e2e/test_ordenes_agregar_texto_libre.py — Agregar a una Orden de
Compra un producto que todavia no existe en el catalogo (una novedad que
ofrece el proveedor), sin tener que cargarlo antes como producto.

Pedido por el usuario: "necesito poder agregar productos que ni siquiera
existen en nuestro sistema (por ejemplo para pedir una novedad) [...] dentro
de agregar producto, [una] opcion [...] de texto libre."

Implementacion: en el modal "Agregar producto" (buscarProductosAgregar en
ordenes.js), ademas de los resultados del catalogo aparece siempre una
opcion "+ Agregar "<texto>" como producto nuevo" -- crea un item con
producto_id NULL y la descripcion en la columna nueva
orden_compra_items.descripcion_libre (agregarItemLibre).

Cubre:
  1. Buscar un texto que no matchea ningun producto -> aparece la opcion
     libre, clickearla agrega el item con esa descripcion y una cantidad
     editable (por defecto 1 unidad).
  2. El item de texto libre persiste al salir y reabrir la orden.
  3. El panel "Mas opciones" de esa fila NO ofrece Cambiar proveedor /
     Asociar sustituto / Pausar reposicion (no aplican sin producto real).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_agregar_texto_libre.py
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

        print("--- Preparar una orden de compra vacia (por SQL) ---")
        orden_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];
            const ordenId = 'orden-test-libre';
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

        print("--- Abrir la orden y buscar un producto que no existe ---")
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)

        DESCRIPCION = "Skip Jabon Liquido dilucion Sachet 3L"
        page.locator("#ord-btn-add-item").click()
        page.wait_for_timeout(300)
        page.locator("#ord-agregar-search").type(DESCRIPCION, delay=10)
        page.wait_for_timeout(400)

        assert page.locator(".ord-search-result[data-add-prod]").count() == 0, (
            "No deberia haber resultados de catalogo para un texto inventado"
        )
        libre_opt = page.locator("[data-add-libre]")
        assert libre_opt.count() == 1, "No aparecio la opcion de agregar como texto libre"
        assert DESCRIPCION in libre_opt.inner_text(), (
            "La opcion de texto libre no muestra el texto tipeado"
        )

        libre_opt.click()
        page.wait_for_timeout(400)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_agregar_texto_libre.png"), full_page=True)

        filas = page.evaluate("""
          () => [...document.querySelectorAll('#ord-items-tbody tr[data-item-id]')].map(tr => ({
            id: tr.dataset.itemId,
            prod: tr.dataset.prod,
            desc: tr.querySelector('td:nth-child(2)')?.textContent.trim(),
          }))
        """)
        print(f"Items tras agregar texto libre: {filas}")
        assert len(filas) == 1, f"Esperaba 1 item en la orden, hay {len(filas)}: {filas}"
        assert filas[0]["prod"] == "", f"El item de texto libre no deberia tener producto_id: {filas[0]}"
        assert DESCRIPCION in filas[0]["desc"], (
            f"La descripcion del item no coincide con lo tipeado: {filas[0]['desc']!r}"
        )

        cantidad_label = page.locator('#ord-items-tbody tr[data-item-id] .ord-apedir-label').inner_text()
        print(f"Cantidad a pedir del item de texto libre: {cantidad_label!r}")
        assert "1" in cantidad_label, f"Esperaba una cantidad por defecto de 1: {cantidad_label!r}"

        print("--- Verificar que 'Mas opciones' no ofrece acciones de producto de catalogo ---")
        item_row = page.locator("#ord-items-tbody tr[data-item-id]")
        # El boton "Mas opciones" solo es visible en la fila con foco (CSS
        # visibility, ver ordenes.html) -- primero hay que enfocar la fila.
        item_row.locator("td:nth-child(2)").click()
        page.wait_for_timeout(150)
        item_row.locator("[data-mas-opciones]").click()
        page.wait_for_timeout(200)
        acciones = page.evaluate("""
          () => [...document.querySelectorAll('.ord-panel-fila [data-panel-acc]')].map(b => b.dataset.panelAcc)
        """)
        print(f"Acciones disponibles: {acciones}")
        for no_deberia in ("prov", "sust", "pausa"):
            assert no_deberia not in acciones, (
                f"BUG: el panel de un item sin producto ofrece '{no_deberia}', que no aplica"
            )
        assert "cant" in acciones and "del" in acciones, (
            f"Editar cantidad y Quitar si deberian seguir disponibles: {acciones}"
        )

        print("--- Verificar que persiste: salir de la orden y volver a entrar ---")
        page.keyboard.press("Escape")
        page.locator("#ord-btn-back").click()
        page.wait_for_timeout(300)
        page.locator(f'[data-abrir="{orden_id}"]').click()
        page.wait_for_timeout(400)

        desc_persistida = page.evaluate("""
          () => document.querySelector('#ord-items-tbody tr[data-item-id] td:nth-child(2)')?.textContent.trim()
        """)
        print(f"Descripcion tras reabrir: {desc_persistida!r}")
        assert DESCRIPCION in desc_persistida, (
            f"BUG: el item de texto libre no persistio -- tras reabrir la orden quedo {desc_persistida!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Se puede agregar a una orden un producto que no existe en el catalogo, como texto libre.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
