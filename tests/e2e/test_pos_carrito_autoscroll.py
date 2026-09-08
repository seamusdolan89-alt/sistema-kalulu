"""
tests/e2e/test_pos_carrito_autoscroll.py — Autoscroll del carrito del POS:
al agregar un producto nuevo con el carrito ya lleno (más de ~7 ítems, que
es cuando .cart-scroll empieza a recortar), la fila recién agregada debe
quedar visible sin que la cajera tenga que scrollear a mano para confirmar
que se agregó.

Reportado por el usuario: "a la hora de realizar una venta de muchos
artículos, luego del item 7 quedan 'ocultos', o me obliga a scrolear para
ver si se agregó o no."

Cubre: agregar 9 productos distintos y verificar que la última fila
agregada está dentro del área visible de `.cart-scroll` (no requiere
scroll manual).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_carrito_autoscroll.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
N_PRODUCTOS = 9


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Viewport chico a proposito para forzar el recorte del carrito antes.
        context = browser.new_context(viewport={"width": 1400, "height": 750})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed + abrir caja ---")
        login_via_seed(page, admin_pos=False)

        print(f"--- Insertar {N_PRODUCTOS} productos distintos por SQL ---")
        page.evaluate(f"""
          () => {{
            const now = new Date().toISOString();
            for (let i = 1; i <= {N_PRODUCTOS}; i++) {{
              const id = 'prod-scroll-' + i;
              window.SGA_DB.run(
                `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                   es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                 VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
                [id, 'Producto Scroll ' + i, now, now, now]
              );
              window.SGA_DB.run(
                `INSERT INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at)
                 VALUES (?, '1', 50, ?, 'pending', ?)`,
                [id, now, now]
              );
            }}
          }}
        """)

        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)

        print(f"--- Agregar los {N_PRODUCTOS} productos uno por uno ---")
        for i in range(1, N_PRODUCTOS + 1):
            search = page.locator("#pos-search-input")
            search.click()
            search.fill("")
            search.type(f"Producto Scroll {i}", delay=15)
            page.wait_for_timeout(250)
            page.locator("#pos-search-dropdown .sri").first.click()
            page.wait_for_timeout(150)

        print("--- Verificar que la ultima fila agregada esta visible sin scrollear a mano ---")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_carrito_autoscroll.png"), full_page=True)

        visible = page.evaluate("""
          () => {
            const scroller = document.querySelector('.cart-scroll');
            const rows = scroller.querySelectorAll('#cart-tbody tr');
            const lastRow = rows[rows.length - 1];
            const scRect = scroller.getBoundingClientRect();
            const rowRect = lastRow.getBoundingClientRect();
            return {
              scrollerBottom: scRect.bottom,
              scrollerTop: scRect.top,
              rowTop: rowRect.top,
              rowBottom: rowRect.bottom,
              nRows: rows.length,
              lastRowText: lastRow.innerText,
            };
          }
        """)

        assert visible["nRows"] == N_PRODUCTOS, f"Esperaba {N_PRODUCTOS} filas, hay {visible['nRows']}"
        assert f"Producto Scroll {N_PRODUCTOS}" in visible["lastRowText"], (
            f"La ultima fila no es el ultimo producto agregado: {visible['lastRowText']!r}"
        )
        assert visible["rowBottom"] <= visible["scrollerBottom"] + 1, (
            f"BUG: la fila del ultimo producto agregado queda por debajo del area visible del "
            f"carrito (rowBottom={visible['rowBottom']}, scrollerBottom={visible['scrollerBottom']}) "
            f"-- haria falta scrollear a mano para verla."
        )
        assert visible["rowTop"] >= visible["scrollerTop"] - 1, (
            f"La fila del ultimo producto queda por encima del area visible del carrito: {visible}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - El carrito del POS hace autoscroll: el ultimo producto agregado queda visible.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
