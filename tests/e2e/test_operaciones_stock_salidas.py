"""
tests/e2e/test_operaciones_stock_salidas.py — Rotura, Vencimiento y Consumo
Interno (los 3 tipos de "salida de stock sin venta", todos viven en la
tabla consumo_interno distinguidos por `motivo`) y el informe agregado
"Salidas de Stock (no venta)" (commit 7dd1082) que los agrupa por persona,
valuados a costo y a precio de venta, con filtro por tipo.

Regresión implícita del fix de ese mismo commit: el CHECK constraint de
`stock_ajustes` no incluía 'vencimiento', asi que cada vencimiento fallaba
en silencio al guardar su espejo ahi (run() no propaga errores) — si eso
volviera a romperse, el informe seguiria funcionando iguial (lee de
consumo_interno, no de stock_ajustes) asi que este test no lo detectaria
por si solo, pero confirma que el flujo end-to-end de vencimientos no
tira errores de JS al confirmar.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_salidas.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def registrar_salida(page, hash_modulo, query, boton_texto):
    page.evaluate(f"window.location.hash = '{hash_modulo}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.locator("#ci-search-input").click()
    page.keyboard.type(query, delay=20)
    page.wait_for_timeout(400)
    page.locator("#ci-search-dropdown .sri").click()
    page.wait_for_timeout(300)
    if hash_modulo == "consumo_interno":
        page.select_option("#ci-motivo", "uso_interno")
    page.get_by_role("button", name=boton_texto, exact=True).click()
    page.wait_for_timeout(500)


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

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Registrar Rotura: Coca-Cola 2L x1 ($50 costo / $95 venta) ---")
        registrar_salida(page, "roturas", "Coca", "Registrar rotura")

        print("--- Registrar Vencimiento: Detergente 500ml x1 ($30 costo / $65 venta) ---")
        registrar_salida(page, "vencimientos", "Deterg", "Registrar vencimiento")

        print("--- Registrar Consumo Interno: Coca-Cola 2L x1 ($50 costo / $95 venta) ---")
        registrar_salida(page, "consumo_interno", "Coca", "Registrar consumo")

        rows = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT motivo, cantidad FROM consumo_interno ORDER BY fecha"
          )
        """)
        assert [r["motivo"] for r in rows] == ["rotura", "vencimiento", "uso_interno"], (
            f"No se registraron los 3 movimientos esperados: {rows}"
        )

        print("--- Informe: Salidas de Stock (no venta), todos los tipos ---")
        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.select_option("#inf-sel-reporte", "salidas_stock")
        page.wait_for_timeout(300)
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "salidas_stock_todos.png"), full_page=True)

        report_text = page.locator("#app").inner_text()
        # Total: costo 50+30+50=130, venta 95+65+95=255
        assert "130,00" in report_text, f"Valor a costo total esperado $130,00 no aparece: {report_text[:600]!r}"
        assert "255,00" in report_text, f"Valor a venta total esperado $255,00 no aparece: {report_text[:600]!r}"

        print("--- Filtrar por Rotura: debe quedar solo esa fila ---")
        page.select_option("#inf-tipo-salida", "rotura")
        page.wait_for_timeout(200)
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "salidas_stock_rotura.png"), full_page=True)

        filtered_text = page.locator("#app").inner_text()
        assert "50,00" in filtered_text, f"Valor a costo de la rotura ($50,00) no aparece: {filtered_text[:600]!r}"
        assert "95,00" in filtered_text, f"Valor a venta de la rotura ($95,00) no aparece: {filtered_text[:600]!r}"
        assert "130,00" not in filtered_text, "El filtro por Rotura no deberia incluir el total sin filtrar ($130,00)"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Rotura/Vencimiento/Consumo Interno + informe Salidas de Stock funcionan correctamente.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
