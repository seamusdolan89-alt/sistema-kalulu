"""
tests/e2e/test_input_number_rueda.py — La rueda del mouse NO debe cambiar el
valor de un campo numérico (cantidad, precio, monto, etc.).

Bug reportado por el usuario: con un campo type="number" enfocado, pasar la
rueda con el mouse encima le sumaba/restaba al valor (y la página no
scrolleaba). Es comportamiento nativo del navegador y un riesgo real: una
cantidad o un precio pueden quedar mal sin que nadie lo note. La rueda se usa
solo para scrollear.

Fix: un listener global de `wheel` en js/app.js que le saca el foco al campo
numérico enfocado — así el navegador no le cambia el valor y el scroll sigue
de largo. Cubre POS y Admin-POS (los dos cargan app.js) y cualquier campo
nuevo, sin tocar cada pantalla.

Cubre: campo numérico enfocado dentro de un contenedor scrolleable; se pasa la
rueda hacia abajo con el mouse encima -> el valor no cambia y el contenedor
scrollea. Se prueba en POS y en Admin-POS.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_input_number_rueda.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

# Un contenedor scrolleable con un campo numérico en el medio y mucho relleno
# abajo; fixed y con z-index alto para que nada de la app se le interponga.
INYECTAR = """
() => {
  document.getElementById('t-rueda')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 't-rueda';
  wrap.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:220px;overflow:auto;z-index:99999;background:#fff';
  wrap.innerHTML = '<div style="height:160px"></div>'
    + '<input id="t-rueda-num" type="number" value="5" style="width:90px;height:30px">'
    + '<div style="height:3000px">relleno</div>';
  document.body.appendChild(wrap);
}
"""


def probar(page, etiqueta):
    page.evaluate(INYECTAR)
    page.click("#t-rueda-num")
    box = page.locator("#t-rueda-num").bounding_box()
    page.mouse.move(box["x"] + 10, box["y"] + 10)
    page.mouse.wheel(0, 120)
    page.mouse.wheel(0, 120)
    page.wait_for_timeout(250)

    valor = page.eval_on_selector("#t-rueda-num", "e => e.value")
    scroll = page.eval_on_selector("#t-rueda", "e => e.scrollTop")
    print(f"[{etiqueta}] valor={valor!r} (inicial '5'), scrollTop del contenedor={scroll}")

    assert valor == "5", (
        f"BUG [{etiqueta}]: la rueda cambió el valor del campo numérico (quedó {valor!r}, era '5')")
    assert scroll > 0, (
        f"[{etiqueta}]: la rueda sobre un campo numérico enfocado no scrolleó el contenedor "
        f"(scrollTop={scroll}) — el campo se traga el scroll")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []

        # Un contexto por superficie: POS y Admin-POS son dos "computadoras"
        # distintas (bases OPFS separadas) y una sesión ya abierta en el mismo
        # contexto hace que login.html redirija sin mostrar el formulario.
        for etiqueta, admin_pos in (("POS", False), ("Admin-POS", True)):
            print(f"--- {etiqueta} ---")
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            context.route("**/*", block_firebase)
            enable_dev_mode(context)
            page = context.new_page()
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.on("dialog", lambda d: d.accept())
            login_via_seed(page, admin_pos=admin_pos)
            probar(page, etiqueta)
            context.close()

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - la rueda no cambia campos numéricos y el scroll sigue funcionando.")
        browser.close()


if __name__ == "__main__":
    main()
