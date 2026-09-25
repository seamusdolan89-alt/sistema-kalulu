"""
tests/e2e/test_compras_remito_enter_foco.py — Compras "Sin factura" (remito):
al apretar Enter en la cantidad, el foco vuelve al buscador.

Bug reportado por el usuario: cargando un remito sin factura, después de
tipear la cantidad y apretar Enter el foco NO volvía a la barra de búsqueda.

Causa: el handler de Enter en la cantidad (compras_v2.js, cartBody keydown)
buscaba el input "Nuevo costo" de la misma fila, le hacía .focus() y hacía
`return` — pero en modo remito esa columna está `display:none` (el remito no
lleva costos): el input existe en el DOM, .focus() sobre un elemento oculto no
hace nada, y el `return` se saltaba el foco al buscador. El foco se quedaba en
la cantidad.

Cubre:
  1. Remito (Sin Factura): Enter en la cantidad -> foco en #cv2-search.
  2. Compra normal (Factura A): Enter en la cantidad sigue saltando al
     "Nuevo costo" de la misma fila (no se rompe lo que ya andaba).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_remito_enter_foco.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

NOMBRE = "Producto Enter Foco"


def escenario(browser, remito):
    context = browser.new_context(viewport={"width": 1500, "height": 900})
    context.route("**/*", block_firebase)
    enable_dev_mode(context)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("dialog", lambda d: d.accept())

    login_via_seed(page, admin_pos=True)
    page.evaluate(f"""
      () => {{
        const now = new Date().toISOString();
        window.SGA_DB.run(
          `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
             es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
           VALUES ('prod-enter-foco', '{NOMBRE}', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
          [now, now, now]
        );
      }}
    """)

    page.evaluate("window.location.hash = 'compras_v2'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(300)

    page.get_by_text("Tradicional", exact=True).click()
    page.wait_for_timeout(300)
    page.locator("#cv2-prov-search").click()
    page.keyboard.type("Pepsico", delay=20)
    page.wait_for_timeout(300)
    page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
    page.wait_for_timeout(300)
    if remito:
        page.locator("#cv2-btn-sin-factura").click()
        page.wait_for_timeout(200)
    else:
        page.select_option("#cv2-condicion-compra", label="Factura A")
        page.wait_for_timeout(200)
    page.get_by_text("Continuar al Carrito", exact=False).click()
    page.wait_for_timeout(400)

    search = page.locator("#cv2-search")
    search.click()
    search.type(NOMBRE, delay=15)
    page.wait_for_timeout(300)
    page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=NOMBRE).first.click()
    page.wait_for_timeout(200)

    # addToCart deja el foco en la cantidad de la fila recién agregada.
    cant = page.locator("#cv2-cart-body input[data-field='cantidad']")
    assert cant.count() == 1, f"Esperaba 1 fila en el carrito, hay {cant.count()}"
    activo = page.evaluate("document.activeElement?.dataset?.field || document.activeElement?.id")
    assert activo == "cantidad", f"Al agregar el producto el foco debería estar en la cantidad, está en {activo!r}"

    page.keyboard.type("3")
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)

    foco = page.evaluate(
        "({id: document.activeElement?.id, field: document.activeElement?.dataset?.field})")
    assert not errors, f"Errores JS no capturados en página: {errors}"
    context.close()
    return foco


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        print("--- Remito (Sin Factura): Enter en la cantidad ---")
        foco = escenario(browser, remito=True)
        print(f"foco tras Enter: {foco}")
        assert foco["id"] == "cv2-search", (
            f"BUG: en modo remito, Enter en la cantidad no devolvió el foco al buscador "
            f"(quedó en {foco})")

        print("--- Compra normal (Factura A): Enter en la cantidad ---")
        foco = escenario(browser, remito=False)
        print(f"foco tras Enter: {foco}")
        assert foco["field"] == "costoNuevo", (
            f"Regresión: en una compra normal, Enter en la cantidad debe saltar al Nuevo costo "
            f"(quedó en {foco})")

        print("OK - Enter en la cantidad: remito vuelve al buscador; compra normal salta al costo.")
        browser.close()


if __name__ == "__main__":
    main()
