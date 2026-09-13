"""
tests/e2e/test_pos_finalizar_venta_va_a_inicio.py — Al confirmar y finalizar
una venta desde el ticket, la cajera vuelve al dashboard de Inicio, no al
dashboard interno de "ventas realizadas" de pos.js.

Pedido explícito del usuario tras probar el dashboard de Inicio: antes,
`finalizeSaleAndGoDashboard()` (pos.js, disparada por los botones "✕" y "✓
Confirmar y finalizar venta" del ticket) llamaba a `enterDashboard()` +
`loadDashboard()` — el dashboard PROPIO de pos.js. Ahora navega a #inicio
en su lugar; como loadView() hace innerHTML sobre #app en cada navegación,
ese estado interno ni llega a pintarse.

"+ Iniciar nueva venta" (btn-ticket-volver -> finalizeAndNewSale) es un
camino distinto a propósito: sigue entrando derecho a otra venta sin pasar
por ningún dashboard, para la cajera que está cobrando varias seguidas.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_finalizar_venta_va_a_inicio.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


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
        login_via_seed(page, admin_pos=False)  # arranca en #inicio
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

        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_ticket_antes_de_confirmar.png"))

        print("--- Confirmar y finalizar venta -> debe ir a #inicio ---")
        page.locator("#btn-ticket-confirmar").click()
        page.wait_for_timeout(600)
        assert "#inicio" in page.url, f"Deberia volver a #inicio, quedo en: {page.url}"
        assert page.get_by_text("Nueva venta").count() > 0, "No parece haber caido en el dashboard de Inicio"
        print(f"OK - {page.url}")

        browser.close()
        print("\n=== OK — finalizar una venta vuelve a Inicio ===")


if __name__ == "__main__":
    run()
