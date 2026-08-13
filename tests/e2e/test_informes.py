"""
tests/e2e/test_informes.py — Los 8 reportes de Informes (POS, sga.db):
Ventas por Producto, Análisis de Productos, Ventas por Transacción,
Quiebres de Stock, Ventas por Vendedor, Aging Cuenta Corriente, Resumen
Diario de Caja y Stock sin Movimiento (Salidas de Stock ya tiene su propio
test en test_operaciones_stock_salidas.py).

Genera datos reales (una venta de $190, un egreso de $50, una deuda de
cliente de $500) y verifica que cada reporte calcula los números
correctos — no solo que "no explota".

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def generar_reporte(page, reporte_id):
    page.select_option("#inf-sel-reporte", reporte_id)
    page.wait_for_timeout(200)
    page.locator("#inf-btn-generar").click()
    page.wait_for_timeout(500)
    return page.locator("#app").inner_text()


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

        print("--- Venta: Coca-Cola 2L x2 = $190, efectivo ---")
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)
        for _ in range(2):
            page.locator("#pos-search-input").click()
            page.keyboard.type("Coca", delay=20)
            page.wait_for_timeout(400)
            page.locator("#pos-search-dropdown .sri").click()
            page.wait_for_timeout(300)
        page.fill("#recibe-efectivo", "200")
        page.wait_for_timeout(200)
        page.get_by_text("CONFIRMAR VENTA", exact=False).click()
        page.wait_for_timeout(700)
        page.get_by_text("Iniciar nueva venta", exact=False).click()
        page.wait_for_timeout(400)

        print("--- Egreso de caja $50 ---")
        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.get_by_text("Egresos e Ingresos", exact=True).click()
        page.wait_for_timeout(300)
        page.get_by_text("+ Egreso", exact=True).click()
        page.wait_for_timeout(300)
        page.select_option("#egreso-tipo", "gasto_operativo")
        page.fill("#egreso-monto", "50")
        page.fill("#egreso-descripcion", "Varios")
        page.locator("#btn-confirm-egreso").click()
        page.wait_for_timeout(400)

        print("--- Deuda de cliente $500 (para Aging CC) ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO clientes (id, nombre, apellido, telefono, activo, sync_status, updated_at)
               VALUES ('cliente-aging', 'Maria', 'Lopez', '111', 1, 'pending', ?)`, [now]
            );
            window.SGA_DB.run(
              `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, descripcion, fecha, sync_status, updated_at)
               VALUES ('cc-aging-1', 'cliente-aging', '1', 'venta_fiada', 500, 'Venta fiada test', ?, 'pending', ?)`,
              [now, now]
            );
          }
        """)
        page.wait_for_timeout(200)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Ventas por Producto ---")
        text = generar_reporte(page, "ventas_producto")
        assert "190,00" in text, f"No se ve la venta de $190: {text[:600]!r}"
        assert "Coca-Cola 2L" in text, f"No aparece Coca-Cola 2L: {text[:600]!r}"

        print("--- Analisis de Productos ---")
        text = generar_reporte(page, "analitica_producto")
        assert "90,00" in text, f"Utilidad esperada $90,00 (190-100): {text[:700]!r}"
        assert "47.4%" in text, f"Margen esperado 47.4%: {text[:700]!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informe_analitica.png"), full_page=True)

        print("--- Ventas por Transaccion ---")
        text = generar_reporte(page, "ventas_transaccion")
        assert "Admin" in text and "190,00" in text, f"No se ve la transaccion: {text[:700]!r}"
        assert "Consumidor final" in text, f"Deberia mostrar 'Consumidor final' sin cliente: {text[:700]!r}"

        print("--- Quiebres de Stock (esperado vacio, sin ordenes de compra) ---")
        text = generar_reporte(page, "quiebres_stock")
        assert "No se encontraron quiebres" in text, f"Deberia estar vacio (no hay ordenes de compra): {text[:700]!r}"

        print("--- Ventas por Vendedor ---")
        text = generar_reporte(page, "ventas_vendedor")
        assert "Admin" in text and "100.0%" in text, f"Admin deberia tener el 100%% de las ventas: {text[:700]!r}"

        print("--- Aging Cuenta Corriente ---")
        text = generar_reporte(page, "aging_cc")
        assert "Maria Lopez" in text and "500,00" in text, f"No se ve la deuda de Maria Lopez: {text[:700]!r}"
        assert "Reciente" in text, f"La deuda de hoy deberia categorizarse como 'Reciente': {text[:700]!r}"

        print("--- Resumen Diario de Caja ---")
        text = generar_reporte(page, "resumen_diario")
        assert "190,00" in text and "50,00" in text and "140,00" in text, (
            f"Neto esperado $140,00 (190 cobrado - 50 egreso): {text[:700]!r}"
        )
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informe_resumen_diario.png"), full_page=True)

        print("--- Stock sin Movimiento ---")
        text = generar_reporte(page, "stock_muerto")
        assert "Detergente 500ml" in text, f"Detergente nunca se vendio, deberia aparecer: {text[:700]!r}"
        assert "Coca-Cola 2L" not in text, f"Coca-Cola SI se vendio, no deberia aparecer en stock muerto: {text[:700]!r}"
        assert "600,00" in text, f"Costo inmovilizado esperado $600,00 (20 x $30): {text[:700]!r}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Los 8 reportes de Informes calculan los numeros correctos.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
