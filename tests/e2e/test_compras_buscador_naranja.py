"""
tests/e2e/test_compras_buscador_naranja.py — Reportado por el usuario
(13/10/2026): buscando "naran" en el carrito de Compras, el producto
"Naranja" no aparecía entre los resultados, aunque ya se había arreglado
este mismo bug antes (fix(buscador): la coincidencia exacta y las que
empiezan con lo tipeado van antes que las que solo lo contienen, 88ed8b0).

Causa real: compras_v2.js tenía su PROPIA búsqueda por nombre duplicada
(searchProductos), separada del motor único (buscador_productos.js) --
nunca se migró a `Buscador.porTexto()`, así que el fix de ranking nunca
llegó acá. La consulta propia no tenía ORDER BY y cortaba en LIMIT 15 a
secas: con más de 15 productos que CONTENÍAN "naranja" como substring
(jugos, gaseosas, dulces) y "Naranja" devuelto más atrás por el orden
interno de SQLite (sin ORDER BY), el producto exacto quedaba afuera.

Fix: searchProductos() ahora delega a Buscador.porTexto() (motor único),
que ordena coincidencia exacta -> empieza con -> contiene.

Cubre: sembrar 16 productos que CONTIENEN "naranja" (ninguno es
"Naranja" exacto, todos insertados ANTES) + el producto "Naranja" en sí
insertado al final -- buscar "naran" en el carrito de Compras tiene que
devolver "Naranja" entre los resultados.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_buscador_naranja.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Sembrar 16 productos 'naranja' (contienen, no son exactos) + 'Naranja' al final ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const mk = (id, nombre) => window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES (?, ?, 100, 150, 1, 'unidad', 1, ?, ?, 'pending', ?)`,
              [id, nombre, now, now, now]
            );
            const nombres = [
              'Tic Tac Naranja', 'Media Naranja Trapo de Piso', 'Citric Jugo Naranja x750ml',
              'BIC Marking Resaltador naranja', 'Jugo BC Naranja Dulce 7g',
              'Levite Agua Sabor Naranja Botella x 1,5lts', 'BC Jugo Naranja 7g',
              'Cepita Naranja 200ml', 'Ades Naranja 1L', 'Paso de los Toros Naranja',
              'Fanta Naranja 500ml', 'Caramelo Naranja Surtido', 'Mirinda Naranja 1.5L',
              'Alka Seltzer Naranja', 'Gatorade Naranja 500ml', 'Halls Naranja x10',
            ];
            nombres.forEach((n, i) => mk(`naran-dup-${i}`, n));
            // El producto exacto, insertado AL FINAL -- sin ORDER BY, el bug
            // viejo lo dejaba fuera del LIMIT 15 de los 16 anteriores.
            mk('naran-exacto', 'Naranja');
          }
        """)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Compra Ticket: proveedor cualquiera, buscar 'naran' ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.fill("#cv2-total-factura", "100")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        page.locator("#cv2-search").click()
        page.keyboard.type("naran", delay=20)
        page.wait_for_timeout(400)

        nombres_en_dropdown = page.locator("#cv2-dropdown .cv2-dd-nombre").all_inner_texts()
        print(f"   Resultados mostrados: {nombres_en_dropdown}")
        assert "Naranja" in nombres_en_dropdown, (
            f"BUG: 'Naranja' (coincidencia exacta/por prefijo) no aparece entre los resultados: {nombres_en_dropdown}"
        )
        assert nombres_en_dropdown[0] == "Naranja", (
            f"'Naranja' debería ser el PRIMER resultado (coincidencia por prefijo, antes que las que solo contienen): {nombres_en_dropdown}"
        )
        print("   OK - 'Naranja' aparece y es el primer resultado")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_buscador_naranja: PASA "
              "(el carrito de Compras ya usa el motor único de búsqueda, con el ranking correcto)")


if __name__ == "__main__":
    main()
