"""
tests/e2e/test_pos_ticket_escape_no_duplica_venta.py — Con el ticket de venta
en pantalla (la venta YA está registrada), apretar Escape tiene que finalizar
igual que F2/F10/el botón "✕" — no solo cerrar el modal.

Reportado por el usuario con una captura (29/9/2026): confirmó una venta, vio
el ticket, y notó que Escape lo devolvía al carrito CON LOS MISMOS ÍTEMS,
botón "Confirmar venta" incluido — un segundo F2/click ahí registraría la
misma venta de nuevo. F2/F10 ya tenían este mismo bug arreglado (comentario
en pos.js: "es la via mas comun de venta duplicada, porque el cajero usa F2
para cerrar el ticket") — el handler genérico de Escape (que cierra cualquier
modal de encima) nunca se excluyó de esa regla, así que colaba por ahí.

Fix: `pos.js`, el handler de teclado — Escape con el ticket visible ahora
hace lo mismo que F2/F10 (`btn-ticket-confirmar`.click(), que corre
`finalizeSaleAndGoDashboard()`: limpia el carrito, saca el sessionStorage y
navega a #inicio) en vez de caer en la rama genérica que solo esconde el
modal.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_ticket_escape_no_duplica_venta.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        page.on("dialog", lambda d: d.accept())
        page.on("console", lambda msg: print(f"[console:{msg.type}] {msg.text}") if msg.type == "error" else None)

        print("--- Login POS + seed + abrir caja ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_timeout(400)
        abrir_caja_si_hace_falta(page, saldo_inicial=1000)

        print("--- Venta simple: Coca-Cola 2L, efectivo exacto ---")
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)
        page.locator("#pos-search-input").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#pos-search-dropdown .sri").first.click()
        page.wait_for_timeout(400)

        recibe = page.locator("#recibe-efectivo")
        total = recibe.get_attribute("placeholder")
        recibe.fill(total.replace(".", "").replace(",", "."))
        page.wait_for_timeout(300)

        print("--- Confirmar venta -> ticket ---")
        page.locator("#btn-confirm-venta").click()
        page.wait_for_timeout(600)
        ticket = page.locator("#modal-ticket")
        assert ticket.count() and not ticket.is_hidden(), "No aparecio el modal de ticket"

        ventas_tras_confirmar = q(page, "SELECT id FROM ventas")
        assert len(ventas_tras_confirmar) == 1, f"Esperaba 1 venta ya registrada: {ventas_tras_confirmar}"

        print("--- Apretar Escape con el ticket en pantalla ---")
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)

        assert "#inicio" in page.url, f"Escape con el ticket visible tiene que finalizar (ir a #inicio), quedo en: {page.url}"
        assert page.get_by_text("Nueva venta").count() > 0, "No parece haber caido en el dashboard de Inicio"
        assert ticket.is_hidden(), "El modal de ticket debería haberse cerrado"

        cart_guardado = page.evaluate("() => sessionStorage.getItem('pos_cart')")
        assert not cart_guardado or cart_guardado in ("[]", "null"), f"El carrito debería quedar vacío: {cart_guardado!r}"

        ventas_finales = q(page, "SELECT id FROM ventas")
        assert len(ventas_finales) == 1, f"Escape no debería haber duplicado la venta: {ventas_finales}"

        print("--- Volver al POS: no debería quedar nada de esa venta para re-confirmar ---")
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_timeout(400)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(300)
        carrito_vacio = page.locator("#pos-cart-empty, .pos-cart-vacio")
        cart_rows = page.locator("#pos-cart-items tr, .pos-cart-row")
        assert cart_rows.count() == 0, f"El carrito de la nueva venta no debería tener filas viejas: {cart_rows.count()}"

        browser.close()
        print("\n=== OK — Escape con el ticket en pantalla finaliza la venta, no la deja para re-confirmar ===")


if __name__ == "__main__":
    run()
