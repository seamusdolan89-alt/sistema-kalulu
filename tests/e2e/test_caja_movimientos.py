"""
tests/e2e/test_caja_movimientos.py — Caja (Efectivo): registrar egreso e
ingreso, verificar que el Resumen calcula bien el saldo esperado, cerrar
caja con reconciliación en cero, y regresión del bug real encontrado en
la sesión: "Editar denominaciones" usaba columnas `clave`/`valor` que no
existen en `system_config` (la tabla real usa `key`/`value`, como ya usan
correctamente clientes.js/configuracion.js) — el guardado mostraba
"✓ Guardado" pero nunca persistía, así que las denominaciones
personalizadas se perdían al recargar la página.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_caja_movimientos.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

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

        print("--- Login POS (sga.db) + seed + abrir caja ---")
        login_via_seed(page, admin_pos=False)
        abrir_caja_si_hace_falta(page)
        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Registrar egreso $500 ---")
        page.get_by_text("Egresos e Ingresos", exact=True).click()
        page.wait_for_timeout(300)
        page.get_by_text("+ Egreso", exact=True).click()
        page.wait_for_timeout(300)
        page.select_option("#egreso-tipo", "gasto_operativo")
        page.fill("#egreso-monto", "500")
        page.fill("#egreso-descripcion", "Compra de bolsas")
        page.locator("#btn-confirm-egreso").click()
        page.wait_for_timeout(400)

        print("--- Registrar ingreso $200 ---")
        page.get_by_text("+ Ingreso", exact=True).click()
        page.wait_for_timeout(300)
        page.fill("#ingreso-monto", "200")
        page.fill("#ingreso-descripcion", "Aporte extra")
        page.locator("#btn-confirm-ingreso").click()
        page.wait_for_timeout(400)

        print("--- Verificar Resumen: saldo esperado = 0 - 500 + 200 = -$300,00 ---")
        page.get_by_text("Resumen", exact=True).click()
        page.wait_for_timeout(300)
        resumen_text = page.locator("#app").inner_text()
        assert "500,00" in resumen_text, f"No se ve el egreso de $500: {resumen_text[:400]!r}"
        assert "300,00" in resumen_text and "-$" in resumen_text, (
            f"Saldo esperado deberia ser -$300,00: {resumen_text[:400]!r}"
        )

        print("--- Regresion: Editar denominaciones debe persistir de verdad (bug clave/valor vs key/value) ---")
        page.get_by_text("Recuento de dinero", exact=True).click()
        page.wait_for_timeout(300)
        page.get_by_text("Editar denominaciones", exact=False).click()
        page.wait_for_timeout(300)
        page.fill("#denom-nueva", "5000")
        page.locator("#btn-agregar-denom").click()
        page.wait_for_timeout(200)
        page.locator("#btn-save-denoms").click()
        page.wait_for_timeout(400)

        valor_en_db = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT value FROM system_config WHERE key='denominaciones'\")"
        )
        assert len(valor_en_db) == 1, f"No se guardo la fila de denominaciones en system_config: {valor_en_db}"
        assert "5000" in valor_en_db[0]["value"], f"La denominacion 5000 no quedo guardada: {valor_en_db}"

        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("Recuento de dinero", exact=True).click()
        page.wait_for_timeout(300)
        post_reload_text = page.locator("#app").inner_text()
        assert "5.000" in post_reload_text or "5000" in post_reload_text, (
            f"La denominacion 5000 no sobrevivio al reload (regresion del bug clave/valor): {post_reload_text[:400]!r}"
        )

        print("--- Cerrar caja (reconciliacion en cero) ---")
        page.locator("#btn-cierre-caja").click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_modal_cierre.png"), full_page=True)
        assert not page.locator("#btn-cierre-confirm").is_disabled(), (
            "El boton de confirmar cierre no deberia estar deshabilitado con diferencia $0"
        )
        page.locator("#btn-cierre-confirm").click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_post_cierre.png"), full_page=True)

        post_cierre_text = page.locator("#app").inner_text()
        assert "Resumen del turno" in post_cierre_text, f"No se ve la pantalla de resumen post-cierre: {post_cierre_text[:300]!r}"
        assert "Diferencia" in post_cierre_text and "+$\xa00,00" in post_cierre_text, (
            f"La diferencia deberia ser $0,00: {post_cierre_text[:600]!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Caja: egreso/ingreso calculan bien el saldo, denominaciones persisten, cierre concilia en cero.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
