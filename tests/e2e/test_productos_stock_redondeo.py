"""
tests/e2e/test_productos_stock_redondeo.py — La columna "Stock" del listado
de Productos redondea a 3 decimales (pedido del usuario, 18/11/2026, con
captura: "6.7860000000000005" en pantalla).

El valor crudo viene de sumar stock_movimientos.delta (ledger de stock) --
con muchos movimientos acumulados, el error de punto flotante de JS deja
colas larguísimas. Es un fix de DISPLAY nada más: la comparación "bajo
mínimo" (bajoMinimo) sigue usando el valor sin redondear, así que este test
también confirma que esa comparación no se rompió.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_productos_stock_redondeo.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + producto con stock con cola de punto flotante ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("""
          () => {
            const u = window.SGA_Auth.getCurrentUser();
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
                 precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('srd-prod', 'Stock Redondeo Test', 10, 20, 5, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]);
            // Mismo valor exacto que mostró la captura real del usuario
            // (cola de punto flotante típica de JS, no es un valor inventado).
            window.SGA_DB.setStockAbsoluto({
              productoId: 'srd-prod', sucursalId: u.sucursal_id, cantidad: 6.7860000000000005,
              tipo: 'ajuste_positivo', motivo: 'seed',
            });
          }
        """)
        cruda = page.evaluate(
            "window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id='srd-prod'`)[0].cantidad"
        )
        print(f"Valor crudo en la base: {cruda!r}")
        assert len(str(cruda).split('.')[-1]) > 3, f"El seed debería reproducir una cola larga de decimales: {cruda!r}"

        print("--- Productos: buscar el producto sembrado ---")
        # admin-pos ya aterriza en #productos (login_via_seed) -- reasignar el
        # mismo hash no dispara un hashchange real, así que no se recarga la
        # lista con el producto recién insertado. Pasar por #inicio primero.
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(300)
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.fill("#search-productos", "Stock Redondeo Test")
        page.wait_for_timeout(700)

        fila = page.locator("#productos-tbody tr", has_text="Stock Redondeo Test")
        assert fila.count() == 1, "Debería listarse el producto sembrado"
        celda_stock = fila.locator("td").nth(6).inner_text().strip()
        print(f"Celda Stock en pantalla: {celda_stock!r}")
        assert celda_stock == "6.786", f"Debería redondear a 3 decimales (6.786), muestra: {celda_stock!r}"

        print("--- 'Bajo mínimo' sigue funcionando con el valor real (6.786 > 5, no debería marcarse) ---")
        assert "bajo-minimo" not in (fila.get_attribute("class") or ""), (
            "No debería marcarse bajo mínimo: 6.786 > 5 (stock_minimo)"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        print("\nOK - El stock se muestra redondeado a 3 decimales, sin romper el chequeo de bajo mínimo.")
        browser.close()


if __name__ == "__main__":
    main()
