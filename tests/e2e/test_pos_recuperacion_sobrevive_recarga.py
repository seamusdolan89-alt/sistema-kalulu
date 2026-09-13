"""
tests/e2e/test_pos_recuperacion_sobrevive_recarga.py — Una venta sin terminar
tiene que seguir siendo recuperable despues de una SEGUNDA recarga.

El escenario que genera un carrito huerfano es una salida no controlada:
corte de luz, cuelgue, F5, cerrar la pestania a mitad de una venta. Si eso
paso una vez, puede pasar dos — no es un caso raro en una compu de local.

Bug (encontrado en revision de pares, ver tambien
test_pos_nueva_venta_no_pisa_carrito.py): al montar el modulo, el INITIAL
LOAD del POS hace

    state.cart = JSON.parse(sessionStorage.pos_cart)   # pos.js ~680, a memoria
    _hasOrphanCart = state.cart.length > 0             # pos.js ~684
    enterDashboard()                                   # pos.js ~3605
        -> sessionStorage.removeItem('pos_cart')       # pos.js ~1616  <-- aca
    showRecoverBanner()                                # pos.js ~3606, lee state.cart

o sea que el banner "Retomar / Descartar" se dibuja bien, pero el respaldo
persistido ya fue borrado ANTES de que la cajera llegue a decidir nada. La
venta queda viviendo solo en una variable de JS.

Resultado: una segunda recarga se la lleva para siempre, sin segunda red.

Ese removeItem esta bien en los otros 9 call sites de enterDashboard() (la
venta termino, o la cajera eligio salir) — el unico problematico es el del
arranque, que corre antes de cualquier decision. Por eso el fix no toca
enterDashboard: vuelve a persistir el carrito en el call site del init.

Este test falla sin el fix (tras la segunda carga no hay banner: el carrito
ya no existe) y pasa con el.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_recuperacion_sobrevive_recarga.py
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

        print("--- Login POS + seed + abrir caja (solo se puede estar 'vendiendo' con caja abierta) ---")
        login_via_seed(page, admin_pos=False)  # arranca en #inicio
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        abrir_caja_si_hace_falta(page, saldo_inicial=1000)

        # Mismo cuidado que en test_pos_nueva_venta_no_pisa_carrito.py: pisar
        # #pos (recien, para abrir caja) ya corrio enterDashboard() y con el
        # su removeItem. El carrito huerfano se siembra DESPUES de volver a
        # Inicio, o el propio setup se come la senial que se quiere probar.
        print("--- Volver a Inicio y simular venta a medio hacer (recarga a mitad de venta) ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(400)  # networkidle no es confiable en cambios de hash puros
        page.evaluate(CART_SEED)

        print("--- Primera llegada al POS: el banner de recuperacion aparece ---")
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_timeout(600)
        banner = page.locator("#pos-recover-banner")
        assert banner.is_visible(), \
            "Precondicion del test: en la primera carga el banner de recuperacion tiene que estar visible"
        print("OK - banner visible en la primera carga")

        # El corazon del test. Hasta aca el comportamiento es igual con o sin
        # el fix: lo que cambia es si el carrito sigue existiendo en disco.
        print("--- Segunda recarga (otro corte / F5) antes de tocar Retomar ---")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(600)

        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_recuperacion_segunda_recarga.png"))

        print("--- La venta sin terminar tiene que seguir estando ---")
        cart_tras_recarga = page.evaluate("() => sessionStorage.getItem('pos_cart')")
        assert cart_tras_recarga and "Producto huerfano" in cart_tras_recarga, \
            ("Bug: el carrito huerfano se perdio en la segunda recarga. enterDashboard() borro "
             "pos_cart en la primera carga, antes de que la cajera pudiera decidir nada.")

        banner = page.locator("#pos-recover-banner")
        assert banner.is_visible(), \
            "Bug: tras la segunda recarga ya no hay banner de recuperacion — la venta se perdio"
        print("OK - el banner sigue ahi despues de la segunda recarga")

        print("--- Y Retomar sigue recuperando el carrito real, no uno vacio ---")
        page.locator("#btn-recover-retomar").click()
        page.wait_for_timeout(400)
        assert page.locator("#pos-sale").is_visible(), "Retomar deberia entrar a modo venta"
        assert page.get_by_text("Producto huerfano").count() > 0, \
            "El carrito recuperado deberia mostrar el producto huerfano, no estar vacio"
        print("OK - Retomar recupera el carrito intacto")

        print("--- Y una vez retomada, sigue persistida (no se rompio el guardado normal) ---")
        cart_final = page.evaluate("() => sessionStorage.getItem('pos_cart')")
        assert cart_final and "Producto huerfano" in cart_final, \
            "Tras Retomar el carrito deberia seguir persistido para el guard de navegacion"
        print("OK - sigue persistida despues de retomar")

        browser.close()
        print("\n=== OK — la venta sin terminar sobrevive a una segunda recarga ===")


if __name__ == "__main__":
    run()
