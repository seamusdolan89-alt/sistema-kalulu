"""
tests/e2e/test_ordenes_exportar_notas.py — La columna "Notas" en el PDF/imagen
exportados de una Orden de Compra (construirTablaOrdenHtml, compartida entre
"Exportar PDF" y "Exportar imagen") debe:

  1. Mostrar la nota de cada item cuando al menos uno de los items de la
     orden tiene una nota cargada.
  2. NO aparecer para nada (ni la columna, ni el header) cuando ningún item
     de la orden tiene notas — pedido explícito del usuario: "solo agregar
     dicha columna si alguno de los productos de la lista tiene un
     comentario. sino, obviar."

Contexto: las notas por item ya persistían correctamente en la orden (ver
test_ordenes_notas_persisten.py), pero construirTablaOrdenHtml() nunca las
incluía — el PDF/imagen que se manda al proveedor por WhatsApp no mostraba
los comentarios aunque estuvieran guardados.

Se usa el export a PDF (abre una pestaña con HTML real, fácil de inspeccionar)
para verificar el contenido de la tabla compartida -- "Exportar imagen" usa
la misma función (construirTablaOrdenHtml), así que cubre ambos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_exportar_notas.py
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
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        context.add_init_script("""
          window.print = () => { window.__printCalled = true; };
        """)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Preparar 2 ordenes 'confirmada': una con notas, otra sin notas ---")
        ids = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-notas-con-a', 'Yerba Playadito 1kg', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?),
                      ('prod-notas-con-b', 'Azucar Ledesma 1kg', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?),
                      ('prod-notas-sin-a', 'Fideos Matarazzo 500g', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now, now, now, now, now, now, now]
            );

            // Orden CON al menos un item con nota
            const ordenConId = 'orden-test-notas-con';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'confirmada', ?, 'pending', ?)`,
              [ordenConId, prov.id, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, cantidad_final, estado, notas)
               VALUES ('item-notas-con-a', ?, 'prod-notas-con-a', 3, 3, 'pendiente', 'Que sea la lata, no el paquete')`,
              [ordenConId]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, cantidad_final, estado, notas)
               VALUES ('item-notas-con-b', ?, 'prod-notas-con-b', 2, 2, 'pendiente', NULL)`,
              [ordenConId]
            );

            // Orden SIN ningun item con nota
            const ordenSinId = 'orden-test-notas-sin';
            window.SGA_DB.run(
              `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
               VALUES (?, '1', ?, 'confirmada', ?, 'pending', ?)`,
              [ordenSinId, prov.id, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, cantidad_final, estado)
               VALUES ('item-notas-sin-a', ?, 'prod-notas-sin-a', 4, 4, 'pendiente')`,
              [ordenSinId]
            );

            return { ordenConId, ordenSinId };
          }
        """)

        def exportar_pdf_y_leer(orden_id):
            # Volver a la lista: si ya hay una orden abierta en un tab, cambiar
            # el hash a 'ordenes' (mismo valor) no dispara navegacion -- hay
            # que usar el boton "Volver" del propio modulo.
            if page.locator("#ord-btn-back").is_visible():
                page.locator("#ord-btn-back").click()
            else:
                page.evaluate("window.location.hash = 'ordenes'")
                page.wait_for_load_state("networkidle")
            page.wait_for_timeout(300)
            page.locator(f'[data-abrir="{orden_id}"]').click()
            page.wait_for_timeout(400)
            with page.expect_popup() as popup_info:
                page.locator("#ord-btn-exportar-pdf").click()
            popup = popup_info.value
            popup.wait_for_load_state("load")
            popup.wait_for_timeout(400)
            html = popup.content()
            texto = popup.locator("body").inner_text()
            popup.close()
            return html, texto

        print("--- Orden CON notas: la columna debe aparecer con el contenido ---")
        html_con, texto_con = exportar_pdf_y_leer(ids["ordenConId"])
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_exportar_notas_con.png"), full_page=True)

        # inner_text() devuelve el texto ya con el text-transform:uppercase
        # del CSS aplicado ("NOTAS") -- se chequea el header en el HTML crudo,
        # que no sufre esa transformacion visual.
        assert ">Notas<" in html_con, (
            f"BUG: la orden tiene un item con nota pero el PDF no muestra la columna Notas: {texto_con[:300]!r}"
        )
        assert "Que sea la lata, no el paquete" in texto_con, (
            f"BUG: el PDF no muestra el contenido de la nota: {texto_con[:400]!r}"
        )
        # El item sin nota de ESTA orden (tiene otro con nota) debe mostrar
        # el placeholder, no dejar la celda en blanco sin indicar nada.
        assert "—" in texto_con, (
            f"El item sin nota de una orden que si tiene notas deberia mostrar '—': {texto_con[:400]!r}"
        )

        print("--- Orden SIN ninguna nota: la columna no debe aparecer ---")
        html_sin, texto_sin = exportar_pdf_y_leer(ids["ordenSinId"])
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_exportar_notas_sin.png"), full_page=True)

        assert ">Notas<" not in html_sin, (
            f"BUG: ningun item de esta orden tiene nota, pero el PDF igual muestra la columna "
            f"Notas (deberia obviarse): {texto_sin[:300]!r}"
        )
        assert "Fideos Matarazzo 500g" in texto_sin, (
            f"El PDF de la orden sin notas deberia seguir mostrando el producto: {texto_sin[:300]!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - La columna Notas del PDF/imagen exportado aparece solo cuando algun item tiene nota cargada.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
