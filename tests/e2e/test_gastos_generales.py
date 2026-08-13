"""
tests/e2e/test_gastos_generales.py — Gastos Generales (POS, sga.db): buscar
un proveedor de servicios (tipo_proveedor='servicios', distinto de los
proveedores de mercadería que trae el seed), cargar un gasto y verificar
que se guarda y aparece en el historial.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_gastos_generales.py
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

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Crear proveedor de servicios (el seed solo trae de mercaderia) ---")
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

        print("--- Buscar Edenor y cargar un gasto de $5000 ---")
        page.locator("#gc-prov-inp").click()
        page.keyboard.type("Edenor", delay=20)
        page.wait_for_timeout(400)
        page.locator(".gc-dd-item", has_text="Edenor").click()
        page.wait_for_timeout(400)

        page.fill("#gf-monto", "5000")
        page.select_option("#gf-metodo", label="Transferencia")
        page.fill("#gf-desc", "Edenor - factura de luz")
        page.locator("#btn-gc-save").click()
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "gastos_registrado.png"), full_page=True)

        print("--- Verificar que aparece en el historial ---")
        historial_text = page.locator("#app").inner_text()
        assert "5.000,00" in historial_text or "5000,00" in historial_text, (
            f"El gasto de $5000 no aparece en el historial: {historial_text[:500]!r}"
        )
        assert "Edenor - factura de luz" in historial_text, "La descripcion del gasto no aparece en el historial"

        print("--- Verificar en la base de datos ---")
        gastos_db = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT proveedor_id, monto, metodo_pago, descripcion FROM gastos ORDER BY fecha DESC LIMIT 1\")"
        )
        assert len(gastos_db) == 1, f"No se guardo el gasto: {gastos_db}"
        assert gastos_db[0]["proveedor_id"] == "prov-luz", f"proveedor_id incorrecto: {gastos_db[0]}"
        assert abs(gastos_db[0]["monto"] - 5000) < 0.01, f"Monto incorrecto: {gastos_db[0]}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Gastos Generales: buscar proveedor de servicios, cargar gasto y ver historial funcionan bien.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
