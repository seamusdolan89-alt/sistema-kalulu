"""
tests/e2e/test_compras_v2_resumen_scroll.py — "Resumen de Cambios" (pantalla
final de una compra, antes de "Finalizar · Ir al POS"): cuando hay muchos
productos nuevos, la lista tiene que poder scrollearse para verlos todos.

Bug real reportado por una cajera (22/10/2026), con captura: "En esta parte
del ingreso de productos hay más productos en la parte de nuevos pero la
pantalla no los muestra, sería bueno poder verlos para una última revisión
completa antes de finalizar el ingreso." La captura mostraba la tabla
"PRODUCTOS NUEVOS" cortada justo arriba de la barra de tareas de Windows,
sin ninguna barra de scroll visible.

Causa: .cv2-rf-root (el contenedor de toda la pantalla) es un flex-column
con height:100%, pero las dos secciones de contenido (Cambios de Costo y
Productos Nuevos) iban sueltas ahí adentro, sin ningún wrapper con
overflow-y:auto -- si la suma de filas superaba el alto de la ventana, lo
que no entraba quedaba clipeado en silencio, sin scrollbar. Mismo patrón que
ya usan .cv2-cart-section/.cv2-rev-body en este mismo archivo CSS
(flex:1 + overflow-y:auto + min-height:0), que acá faltaba.

Fix: las dos secciones ahora van adentro de un nuevo contenedor
.cv2-rf-body con flex:1/overflow-y:auto/min-height:0 -- header y footer
quedan fijos (flex-shrink:0, ya lo eran), y el contenido del medio scrollea.

Cubre: una compra con MUCHOS productos nuevos hace que .cv2-rf-body tenga
overflow real (scrollHeight > clientHeight) y que el último producto, no
visible al entrar a la pantalla, se pueda alcanzar scrolleando.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_resumen_scroll.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def en_viewport(locator):
    box = locator.bounding_box()
    if not box:
        return False
    vp = locator.page.viewport_size
    return box["y"] + box["height"] > 0 and box["y"] < vp["height"]

N_PRODUCTOS_NUEVOS = 25


def crear_producto_nuevo(page, nombre, categoria_id):
    page.locator("#cv2-search").click()
    page.keyboard.type(nombre, delay=5)
    page.wait_for_timeout(250)
    page.locator('.cv2-dd-accion[data-action="nuevo"]').click()
    page.wait_for_timeout(150)
    page.fill("#cv2-np-nombre", nombre)
    page.fill("#cv2-np-costo", "100")
    page.select_option("#cv2-np-categoria", value=categoria_id)
    page.locator("#cv2-np-crear").click()
    page.wait_for_timeout(150)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Viewport chico a propósito: asegura que ~25 filas no entren enteras
        # en pantalla, reproduciendo el caso real reportado.
        context = browser.new_context(viewport={"width": 1400, "height": 800})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed ---")
        login_via_seed(page, admin_pos=True)

        categoria_id = page.evaluate(
            "() => window.SGA_DB.query(`SELECT id FROM categorias LIMIT 1`)[0].id"
        )

        print(f"--- Compra Remito a Pepsico SA, agregando {N_PRODUCTOS_NUEVOS} productos nuevos ---")
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
        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.fill("#cv2-total-factura", str(100 * N_PRODUCTOS_NUEVOS))
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        nombres = [f"Producto Scroll Test {i:02d}" for i in range(N_PRODUCTOS_NUEVOS)]
        for nombre in nombres:
            crear_producto_nuevo(page, nombre, categoria_id)

        print("--- Confirmar la compra (pasa por 'Ajuste de Precios') y llegar a 'Resumen de Cambios' ---")
        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.get_by_text("Confirmar Ingreso", exact=False).click()
        page.wait_for_timeout(700)

        # Todo costo nuevo === costo anterior (ambos 100): cae en "Ajuste de
        # Precios" (COMPRAS — AJUSTE DE PRECIOS) antes del resumen final.
        assert page.locator("#cv2-post-btn-finish").count() == 1, \
            "Debería haber caído en la pantalla de Ajuste de Precios post-compra"
        page.locator("#cv2-post-btn-finish").click()
        page.wait_for_timeout(500)

        assert page.locator(".cv2-rf-root").count() == 1, "Debería haber llegado a Resumen de Cambios"

        filas = page.locator(".cv2-rf-body tbody tr")
        assert filas.count() == N_PRODUCTOS_NUEVOS, \
            f"Deberían estar las {N_PRODUCTOS_NUEVOS} filas en el DOM: hay {filas.count()}"
        print(f"OK - las {N_PRODUCTOS_NUEVOS} filas de productos nuevos están en el DOM")

        print("--- .cv2-rf-body tiene overflow real (scrollHeight > clientHeight) ---")
        scroll_h, client_h = page.evaluate("""
          () => {
            const el = document.querySelector('.cv2-rf-body');
            return [el.scrollHeight, el.clientHeight];
          }
        """)
        assert scroll_h > client_h, \
            f"BUG: no hay overflow real para probar el scroll (scrollHeight={scroll_h}, clientHeight={client_h})"
        print(f"OK - scrollHeight={scroll_h} > clientHeight={client_h}")

        ultima_fila = page.locator(".cv2-rf-td-nombre", has_text="Producto Scroll Test 24")
        assert ultima_fila.count() == 1, "La última fila debería existir en el DOM"

        print("--- Antes de scrollear, la última fila NO está en el viewport ---")
        assert not en_viewport(ultima_fila), \
            "BUG: la última fila ya era visible sin scrollear -- el test no está probando overflow real"
        print("OK - confirmado que arranca fuera de vista (como en el reporte real)")

        print("--- Scrolleando .cv2-rf-body hasta el final, la última fila se vuelve visible ---")
        page.evaluate("""
          () => {
            const el = document.querySelector('.cv2-rf-body');
            el.scrollTop = el.scrollHeight;
          }
        """)
        page.wait_for_timeout(200)
        assert en_viewport(ultima_fila), \
            "BUG: scrollear .cv2-rf-body no trajo a la vista la última fila -- el scroll no funciona"
        print("OK - la última fila (antes invisible) ahora se ve")

        print("--- El header y el footer (Pausar/Finalizar) siguen visibles, no se scrollean ---")
        assert en_viewport(page.locator(".cv2-rf-header")), "El header debería seguir visible (fijo arriba)"
        assert en_viewport(page.locator("#cv2-rf-btn-pos")), "El footer debería seguir visible (fijo abajo)"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: Resumen de Cambios scrollea cuando hay muchos productos, sin perder header/footer ===")
        browser.close()


if __name__ == "__main__":
    main()
