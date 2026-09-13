"""
tests/e2e/test_pos_nueva_venta_no_pisa_carrito.py — El deep-link
#pos/nueva-venta (botón "Nueva venta" de Inicio) no debe pisar un carrito
huérfano sin preguntar.

Bug real (encontrado en revisión de pares antes de comitear el dashboard de
Inicio): si la cajera deja una venta a mitad de camino y la página se
recarga (corte de luz, F5, cerrar y volver), `pos_cart` se restaura desde
sessionStorage a `state.cart` (en memoria) pero `window.SGA_POS_ACTIVE_SALE`
vuelve a `false` (lo resetea app.js en cada carga de página) — es
exactamente el único caso en que `_hasOrphanCart` puede ser `true`.

`enterSaleMode()` solo pregunta "¿Abandonar la venta actual?" cuando
`SGA_POS_ACTIVE_SALE` es true (pos.js ~1674), así que en este escenario el
confirm() nunca se dispara: con una caja ya abierta (precondición real para
estar "vendiendo"), sigue de largo a `state.cart = []; saveCart()` y entra a
modo venta con el carrito recién vaciado. El banner de recuperación queda
visible pero apuntando a un carrito que ya no existe.

Antes del deep-link esto no podía pasar: el login dejaba a la cajera en el
dashboard de #pos pelado, veía el banner y decidía ella. El botón "Nueva
venta" de Inicio saltea esa decisión llamando a enterSaleMode() de una.

Fix: en el handler de "#pos/nueva-venta", si hay un carrito huérfano NO se
llama a enterSaleMode() — se deja el banner de recuperación ya visible.

AGUJERO CONOCIDO, DISTINTO Y SIN CORREGIR ACÁ (fuera de alcance de este fix):
`enterDashboard()` (pos.js ~1617) borra `sessionStorage.pos_cart` de forma
incondicional apenas se monta el módulo — ANTES de que la cajera llegue a
ver el banner y decidir. La recuperación queda viviendo solo en la variable
`state.cart` en memoria; el respaldo persistido ya no existe. Si la página
se recarga una segunda vez antes de tocar "Retomar" (mismo tipo de salida no
controlada que generó el carrito huérfano en primer lugar — corte, cuelgue,
F5 — así que no es un escenario raro), la venta sin terminar se pierde para
siempre, sin segunda red. Esto NO es a propósito, es un gap real que ya
existía antes de este dashboard — se deja pendiente en BACKLOG.md.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_nueva_venta_no_pisa_carrito.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

CART_SEED = """
() => {
  sessionStorage.setItem('pos_cart', JSON.stringify([
    { productoId: 'x', nombre: 'Producto huerfano', cantidad: 2, precioUnitario: 100, costoUnitario: 50 }
  ]));
}
"""


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        page.on("console", lambda msg: print(f"[console:{msg.type}] {msg.text}") if msg.type == "error" else None)

        print("--- Login POS + seed + abrir caja (la cajera solo puede estar 'vendiendo' con caja abierta) ---")
        login_via_seed(page, admin_pos=False)  # arranca en #inicio
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        abrir_caja_si_hace_falta(page, saldo_inicial=1000)

        # Ojo acá: entrar a #pos (arriba, para abrir caja) ya corre
        # enterDashboard(), que borra sessionStorage.pos_cart de forma
        # incondicional (pos.js ~1617) — este removeItem es en sí un agujero
        # real y separado (ver docstring del módulo), no algo intencional que
        # este test esté validando. Simplemente hay que esquivarlo para poder
        # probar lo que sí es este fix: el carrito huérfano se
        # siembra DESPUÉS de volver a Inicio, no antes de pisar #pos, o el
        # propio setup del test se comería la señal que se quiere probar.
        print("--- Volver a Inicio y simular carrito huerfano (recarga a mitad de venta) ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(400)  # wait_for_load_state("networkidle") no es confiable en cambios de hash puros
        page.evaluate(CART_SEED)

        print("--- Clickear 'Nueva venta' (deep-link #pos/nueva-venta), primera carga de pos.js con ese carrito ---")
        page.get_by_text("Nueva venta").click()
        page.wait_for_timeout(500)
        assert "#pos/nueva-venta" in page.url

        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_nueva_venta_carrito_huerfano.png"))

        print("--- NO debe haber entrado a modo venta directo (eso pisaria el carrito huerfano) ---")
        sale_visible = page.locator("#pos-sale").count() and page.locator("#pos-sale").is_visible()
        assert not sale_visible, \
            "Bug: entro directo a modo venta con el carrito huerfano recien vaciado, sin preguntar"
        print("OK - se quedo en el dashboard, no entro solo a vender")

        print("--- El banner de recuperacion debe estar visible y accionable ---")
        banner = page.locator("#pos-recover-banner")
        assert banner.is_visible(), "El banner de recuperacion deberia estar visible en vez de haberse saltado"
        assert page.locator("#btn-recover-retomar").count() > 0
        assert page.locator("#btn-recover-descartar").count() > 0
        print("OK - banner visible con Retomar/Descartar")

        print("--- Retomar debe recuperar el carrito real, no uno vacio ---")
        page.locator("#btn-recover-retomar").click()
        page.wait_for_timeout(400)
        assert page.locator("#pos-sale").is_visible(), "Retomar deberia entrar a modo venta"
        assert page.get_by_text("Producto huerfano").count() > 0, \
            "El carrito recuperado deberia mostrar el producto huerfano, no estar vacio"
        print("OK - Retomar recupera el carrito con el producto huerfano intacto")

        browser.close()
        print("\n=== OK — el deep-link no pisa un carrito huérfano ===")


if __name__ == "__main__":
    run()
