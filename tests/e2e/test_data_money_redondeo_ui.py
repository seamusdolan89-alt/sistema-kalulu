"""
tests/e2e/test_data_money_redondeo_ui.py — Segunda etapa de la regla de 2
decimales (4/10/2026): tras cubrir Compras/Editor de Producto/Historial de
Compras, se agregó data-money="true" a los campos de dinero de Gastos,
Pago a Proveedor, Nota de Crédito y Cuentas Corrientes de Proveedores.

El mecanismo en sí (listener delegado en app.js, redondea cualquier
input[data-money="true"] al salir del campo) ya se probó en Compras/Editor.
Este test verifica que el MARCADO nuevo funciona en un módulo donde nunca
se probó antes (Gastos) -- si el atributo faltara o estuviera mal puesto,
este test lo detecta sin tener que probar los ~15 campos uno por uno.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_data_money_redondeo_ui.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS + seed ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, cuit, activo, tipo_proveedor, sync_status, updated_at)
               VALUES ('prov-luz', 'Edenor', '30-11111111-1', 1, 'servicios', 'pending', ?)`,
              [now]
            );
          }
        """)
        page.wait_for_timeout(200)

        page.evaluate("window.location.hash = 'gastos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Buscar Edenor (el formulario de #gf-monto aparece recien con proveedor elegido) ---")
        page.locator("#gc-prov-inp").click()
        page.keyboard.type("Edenor", delay=20)
        page.wait_for_timeout(400)
        page.locator(".gc-dd-item", has_text="Edenor").click()
        page.wait_for_timeout(400)

        print("--- Confirmar que #gf-monto tiene el atributo data-money ---")
        tiene_marca = page.locator("#gf-monto").get_attribute("data-money")
        assert tiene_marca == "true", f"BUG: #gf-monto no tiene data-money='true' (tiene: {tiene_marca!r})"

        print("--- Tipear un monto con 3 decimales y sacar el foco (blur) ---")
        page.fill("#gf-monto", "1234.567")
        page.locator("#gf-desc").click()  # mover el foco a otro campo -> dispara blur/focusout
        page.wait_for_timeout(150)

        valor_final = page.locator("#gf-monto").input_value()
        print(f"   Valor en el campo despues del blur: {valor_final!r}")
        assert valor_final == "1234.57", (
            f"BUG: el campo de dinero no redondeo a 2 decimales al perder el foco "
            f"(se tipeo 1234.567, se esperaba 1234.57, quedo: {valor_final!r})"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_data_money_redondeo_ui: PASA (el marcado data-money nuevo en Gastos "
              "funciona con el mecanismo compartido de app.js)")


if __name__ == "__main__":
    main()
