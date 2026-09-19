"""
tests/e2e/test_editor_producto_movimientos_stock.py — La pestaña "Transacciones" del Editor de
Producto muestra el registro REAL de movimientos de stock (stock_movimientos).

Antes armaba un pseudo-historial reconstruido desde ventas + compras + ajustes manuales: no
incluia remitos, devoluciones, anulaciones, ediciones ni mermas, y el saldo corrido arrancaba en
cero, asi que nunca terminaba en el stock real ("¿por que tengo 17?" no tenia respuesta).

Ahora cada cambio de stock es un movimiento (tipo, quien, por que) y la columna Saldo es el
stock verdadero: el ultimo saldo tiene que ser igual al stock actual del producto.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_movimientos_stock.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import assert_stock_integro, block_firebase, enable_dev_mode, login_via_seed

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

        print("--- Login admin-pos + un producto con movimientos de distinto tipo ---")
        login_via_seed(page, admin_pos=True)
        prod_id = page.evaluate("""
          () => {
            const u = window.SGA_Auth.getCurrentUser();
            const now = '2026-09-18T10:00:00.000Z';
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
                 precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-mov', 'Producto Movimientos', 50, 100, 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`,
              [now, now, now]);
            const mv = (delta, tipo, refTipo, motivo, fecha) => window.SGA_DB.moverStock({
              productoId: 'prod-mov', sucursalId: u.sucursal_id, delta, tipo, refTipo, refId: refTipo ? 'ref-' + tipo : null,
              motivo, fecha });
            mv(20, 'compra',      'compras',       'Compra a proveedor',   '2026-09-18T10:00:01.000Z');
            mv(-3, 'rotura',      'stock_ajustes', 'Se cayo el estante',   '2026-09-18T11:00:00.000Z');
            mv(6,  'remito',      'remitos',       'Remito R-100',         '2026-09-18T12:00:00.000Z');
            mv(-4, 'venta',       'ventas',        null,                   '2026-09-18T13:00:00.000Z');
            mv(1,  'devolucion',  'devoluciones',  'Arrepentimiento',      '2026-09-18T14:00:00.000Z');
            return 'prod-mov';
          }
        """)
        assert_stock_integro(page, "antes de abrir la pestaña")
        stock = page.evaluate("() => window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id='prod-mov'`)[0].cantidad")
        assert stock == 20, f"20 - 3 + 6 - 4 + 1 = 20, es {stock}"

        print("--- Editor -> Transacciones ---")
        page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator(".editor-nav-link[data-section='transacciones']").click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "editor_producto_movimientos.png"), full_page=True)

        filas = page.locator("#ed-tx-tbody tr")
        assert filas.count() == 5, f"Deberia mostrar los 5 movimientos del registro, hay {filas.count()}"
        textos = [filas.nth(i).inner_text() for i in range(filas.count())]
        for etiqueta in ("Compra", "Rotura", "Remito", "Venta", "Devolución"):
            assert any(etiqueta in t for t in textos), f"Falta el movimiento '{etiqueta}': {textos}"
        assert any("Se cayo el estante" in t for t in textos), "El motivo del movimiento no se muestra"

        saldos = page.evaluate("""() => Array.from(document.querySelectorAll('#ed-tx-tbody tr'))
                                       .map(tr => tr.children[6].textContent.trim())""")
        assert saldos == ["20", "17", "23", "19", "20"], f"Saldo corrido incorrecto: {saldos}"
        assert saldos[-1] == str(int(stock)), "el ultimo saldo tiene que ser el stock actual"
        print("   saldos:", saldos, "-> termina en el stock actual", stock)

        print("--- Filtro por tipo: Devoluciones y Compras (compras incluye remitos) ---")
        page.select_option("#ed-tx-tipo", "devolucion")
        page.locator("#ed-btn-tx-filtrar").click()
        page.wait_for_timeout(300)
        assert page.locator("#ed-tx-tbody tr").count() == 1
        page.select_option("#ed-tx-tipo", "compra")
        page.locator("#ed-btn-tx-filtrar").click()
        page.wait_for_timeout(300)
        assert page.locator("#ed-tx-tbody tr").count() == 2, "Compras deberia incluir la compra y el remito"
        # el saldo de cada fila sigue siendo el verdadero aunque se filtre
        saldos_f = page.evaluate("""() => Array.from(document.querySelectorAll('#ed-tx-tbody tr'))
                                         .map(tr => tr.children[6].textContent.trim())""")
        assert saldos_f == ["20", "23"], f"El filtro no debe recalcular el saldo: {saldos_f}"
        print("   OK: el filtro no altera el saldo real")

        assert not errors, f"Errores JS no capturados: {errors}"
        print("\nOK - La pestaña Transacciones muestra el registro real de movimientos, con saldo verdadero.")
        browser.close()


if __name__ == "__main__":
    main()
