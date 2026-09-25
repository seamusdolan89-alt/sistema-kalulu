"""
tests/e2e/test_compras_revision_menu_sin_recorte.py — Compras — Revisión:
los menús de acciones por fila ("Familia" y "Desincorporar") no se recortan.

Bug reportado por el usuario: el menú "⋯" de una fila se leía completo en el
primer producto pero en el segundo (la última fila) la tercera opción quedaba
cortada. Causa: el panel era position:absolute dentro de la celda y la tabla
tiene overflow:hidden (esquinas redondeadas), así que en la última fila lo que
sobresalía de la tabla se recortaba.

Además, el pedido de rediseño: dos botones en vez de un "⋯" que no dejaba claro
qué había adentro:
  - "Familia":        Asociar sustituto · Asignar madre
  - "Desincorporar":  Rotura · Consumo · Producto no entregado
                      (cada opción abre el modal de ajuste con ese motivo ya
                      elegido).

Cubre, con un carrito de 2 productos (la última fila es la que se recortaba):
  1. Cada menú, en cada fila: todas sus opciones son visibles y clickeables
     (elementFromPoint devuelve la propia opción, no otra cosa encima) y el
     menú entra en la ventana.
  2. Con una ventana bajita el menú se abre hacia arriba si abajo no entra.
  3. Segundo click en el mismo botón lo cierra; click afuera, scroll y Escape
     también (Escape cierra solo el menú, no toda la pantalla de Revisión).
  4. "Rotura" abre el modal de ajuste con "Rotura" ya elegido.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_revision_menu_sin_recorte.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
NOMBRES = ["Prod Menu Uno", "Prod Menu Dos"]

ESTADO_MENU = """
() => {
  const panel = document.querySelector('.cv2-rev-panel');
  if (!panel) return null;
  const pr = panel.getBoundingClientRect();
  return {
    dentro: pr.top >= 0 && pr.left >= 0 && pr.bottom <= window.innerHeight && pr.right <= window.innerWidth,
    top: pr.top, bottom: pr.bottom, alto: window.innerHeight,
    items: [...panel.querySelectorAll('.cv2-rev-panel-acc')].map(it => {
      const r = it.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { texto: it.textContent.trim(), clickeable: el === it || it.contains(el) };
    }),
  };
}
"""


def ir_a_revision(page):
    page.evaluate("""(nombres) => {
      const now = new Date().toISOString();
      nombres.forEach((n, i) => window.SGA_DB.run(
        `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
           es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
         VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
        ['prod-menu-' + i, n, now, now, now]));
    }""", NOMBRES)
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
    page.select_option("#cv2-condicion-compra", label="Factura A")
    page.wait_for_timeout(200)
    page.fill("#cv2-subtotal-neto", "20")
    page.locator("#cv2-subtotal-neto").blur()
    page.fill("#cv2-iva-21", "4")
    page.locator("#cv2-iva-21").blur()
    page.wait_for_timeout(200)
    page.get_by_text("Continuar al Carrito", exact=False).click()
    page.wait_for_timeout(400)
    for n in NOMBRES:
        page.locator("#cv2-search").click()
        page.keyboard.type(n, delay=15)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=n).first.click()
        page.wait_for_timeout(250)
    page.get_by_text("Siguiente", exact=False).click()
    page.wait_for_timeout(500)


def abrir(page, menu, fila):
    page.locator(f'[data-rev-menu="{menu}"]').nth(fila).click()
    page.wait_for_timeout(150)
    estado = page.evaluate(ESTADO_MENU)
    assert estado is not None, f"No se abrió el menú {menu} de la fila {fila + 1}"
    return estado


def cerrar_si_abierto(page):
    if page.locator(".cv2-rev-panel").count():
        page.locator("body").click(position={"x": 5, "y": 5})   # click afuera
        page.wait_for_timeout(100)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1560, "height": 700})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + carrito de 2 productos -> Revisión ---")
        login_via_seed(page, admin_pos=True)
        ir_a_revision(page)
        assert page.locator("[data-rev-menu]").count() == 4, (
            f"Esperaba 4 botones (2 por fila), hay {page.locator('[data-rev-menu]').count()}")
        assert page.locator("[data-rev-mas]").count() == 0, "Quedó el botón viejo '⋯'"

        esperado = {
            "familia": ["Asociar sustituto", "Asignar madre"],
            "desinc":  ["Rotura", "Consumo", "Producto no entregado"],
        }

        print("--- Cada menú, en cada fila: completo, visible y clickeable ---")
        for fila in (0, 1):
            for menu in ("familia", "desinc"):
                est = abrir(page, menu, fila)
                textos = [i["texto"] for i in est["items"]]
                print(f"fila {fila + 1} / {menu}: {textos}")
                for esp, txt in zip(esperado[menu], textos):
                    assert esp in txt, f"Opción inesperada en {menu}: {textos}"
                assert len(textos) == len(esperado[menu]), f"Cantidad de opciones inesperada en {menu}: {textos}"
                assert est["dentro"], f"BUG: el menú {menu} de la fila {fila + 1} se sale de la ventana: {est}"
                tapadas = [i["texto"] for i in est["items"] if not i["clickeable"]]
                assert not tapadas, (
                    f"BUG: en la fila {fila + 1} / {menu} hay opciones recortadas o tapadas: {tapadas}")
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, f"rev_menu_{menu}_fila{fila + 1}.png"))
                cerrar_si_abierto(page)

        print("--- Ventana bajita: en la última fila el menú se abre hacia arriba ---")
        page.set_viewport_size({"width": 1560, "height": 380})
        page.wait_for_timeout(200)
        est = abrir(page, "desinc", 1)
        print(f"ventana 380px: {est}")
        assert est["dentro"], f"BUG: con ventana chica el menú se sale de la pantalla: {est}"
        assert not [i for i in est["items"] if not i["clickeable"]], f"Opciones tapadas con ventana chica: {est}"
        cerrar_si_abierto(page)
        page.set_viewport_size({"width": 1560, "height": 700})
        page.wait_for_timeout(200)

        print("--- Toggle: segundo click en el mismo botón lo cierra ---")
        abrir(page, "familia", 0)
        page.locator('[data-rev-menu="familia"]').nth(0).click()
        page.wait_for_timeout(100)
        assert page.locator(".cv2-rev-panel").count() == 0, "El segundo click en el botón no cerró el menú"

        print("--- Escape cierra solo el menú, no la pantalla de Revisión ---")
        abrir(page, "familia", 0)
        page.keyboard.press("Escape")
        page.wait_for_timeout(150)
        assert page.locator(".cv2-rev-panel").count() == 0, "Escape no cerró el menú"
        assert page.locator("#cv2-review-overlay").is_visible(), "Escape cerró toda la pantalla de Revisión"

        print("--- Scroll cierra el menú (es position:fixed, no debe quedar flotando) ---")
        abrir(page, "desinc", 0)
        page.evaluate("document.querySelector('.cv2-rev-body').dispatchEvent(new Event('scroll'))")
        page.wait_for_timeout(100)
        assert page.locator(".cv2-rev-panel").count() == 0, "El scroll no cerró el menú"

        print("--- 'Rotura' abre el modal de ajuste con el motivo ya elegido ---")
        abrir(page, "desinc", 1)
        page.locator('[data-rev-accion="ajuste"]', has_text="Rotura").click()
        page.wait_for_timeout(250)
        assert page.locator("#cv2-ajuste-overlay").is_visible(), "No se abrió el modal de ajuste"
        assert page.locator("#cv2-ajuste-motivo").input_value() == "Rotura", (
            f"El modal no abrió con 'Rotura': {page.locator('#cv2-ajuste-motivo').input_value()!r}")
        assert page.locator(".cv2-rev-panel").count() == 0, "El menú quedó abierto detrás del modal"

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - Revisión: menús Familia / Desincorporar completos en todas las filas, sin recorte.")
        browser.close()


if __name__ == "__main__":
    main()
