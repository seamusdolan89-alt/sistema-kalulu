"""
tests/e2e/test_promociones_editar.py — Editar una promoción existente, pedido
del usuario (12/11/2026): antes solo se podía eliminar y recrear desde cero.

`openModal(editPromo)` ya existía completo en promociones.js (precarga
nombre, fechas, tipo, descuento, productos del combo) pero no estaba
conectado a ningún botón -- este test cubre el botón "✏️ Editar" nuevo y dos
regresiones que habría introducido conectarlo tal cual estaba: guardar una
edición pisaba `activa` (reactivaba una promo pausada) y `stock_vendido`
(perdía el contador de uso) porque `savePromocion()` los hardcodeaba a 1 y 0
en cada guardado, sin importar si era alta o edición.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_promociones_editar.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login + crear promo: 10% sobre Coca-Cola 2L ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'promociones'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("+ Nueva promoción", exact=True).click()
        page.wait_for_timeout(400)
        page.fill("#promo-nombre", "Editar test original")
        page.fill("#promo-valor-descuento", "10")
        page.locator("#modal-product-search").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#modal-search-dropdown .msri").click()
        page.wait_for_timeout(300)
        page.get_by_text("Guardar promoción", exact=True).click()
        page.wait_for_timeout(500)

        promo_id = page.evaluate(
            "window.SGA_DB.query(`SELECT id FROM promociones WHERE nombre='Editar test original'`)[0].id"
        )

        print("--- Desactivar la promo (igual que el dueño pausando una real) ---")
        page.locator(f'.btn-promo-toggle[data-id="{promo_id}"]').click()
        page.wait_for_timeout(300)
        activa_tras_pausar = page.evaluate(
            f"window.SGA_DB.query(`SELECT activa FROM promociones WHERE id='{promo_id}'`)[0].activa"
        )
        assert activa_tras_pausar == 0, "La promo debería quedar pausada"

        print("--- Simular que ya se vendió 1 vez (stock_vendido) ---")
        page.evaluate(f"window.SGA_DB.run(`UPDATE promociones SET stock_vendido = 3 WHERE id = '{promo_id}'`)")

        print("--- Click en 'Editar' (botón nuevo) y cambiar el nombre + el % ---")
        boton_editar = page.locator(f'.btn-promo-action.btn-promo-editar[data-id="{promo_id}"]')
        assert boton_editar.count() == 1, "Falta el botón '✏️ Editar' en la tarjeta de la promo"
        boton_editar.click()
        page.wait_for_timeout(300)

        assert page.locator("#promo-modal-title").inner_text() == "Editar Promoción"
        assert page.input_value("#promo-nombre") == "Editar test original", "El modal no precargó el nombre existente"
        assert page.input_value("#promo-valor-descuento") == "10", "El modal no precargó el descuento existente"
        assert page.locator(".combo-item-row").count() == 1, "El modal no precargó el producto del combo"

        page.fill("#promo-nombre", "Editar test MODIFICADA")
        page.fill("#promo-valor-descuento", "15")
        page.get_by_text("Guardar promoción", exact=True).click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "promociones_editar.png"), full_page=True)

        print("--- Verificar: mismo id (no se duplicó), nombre y % actualizados ---")
        total_promos = page.evaluate("window.SGA_DB.query(`SELECT COUNT(*) AS n FROM promociones`)[0].n")
        assert total_promos == 1, f"No debería haberse creado una promo nueva, hay {total_promos}"
        fila = page.evaluate(
            f"window.SGA_DB.query(`SELECT * FROM promociones WHERE id='{promo_id}'`)[0]"
        )
        assert fila is not None, "La promo debería seguir existiendo con el mismo id"
        assert fila["nombre"] == "Editar test MODIFICADA", f"El nombre no se actualizó: {fila}"
        assert float(fila["valor_descuento"]) == 15, f"El % no se actualizó: {fila}"

        print("--- Verificar: NO se reactivó sola, y NO se perdió el stock_vendido ---")
        assert fila["activa"] == 0, f"BUG: editar reactivó una promo pausada: {fila}"
        assert fila["stock_vendido"] == 3, f"BUG: editar perdió el contador de unidades vendidas: {fila}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        print("\nOK - Editar una promo existente: precarga todo, no duplica, preserva activa/stock_vendido.")
        browser.close()


if __name__ == "__main__":
    main()
