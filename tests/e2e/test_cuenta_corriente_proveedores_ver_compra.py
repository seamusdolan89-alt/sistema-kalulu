"""
tests/e2e/test_cuenta_corriente_proveedores_ver_compra.py — Botón "Ver" en el
ledger de Cuentas Corrientes de proveedores, al lado de cada fila "Compra":
abre el detalle de esa compra (productos, cantidades, costos) sin tener que
ir a Historial de Compras.

Pedido real del usuario (30/9/2026), mismo día y misma idea que el detalle de
venta agregado en la ficha de clientes: "en la cuenta corriente de los
proveedores aplicar el mismo concepto... un botón de 'ver' al lado de
'compra' en la columna 'tipo'".

Cubre las dos vistas del ledger (Cronológico y Por factura) — cada una tiene
su propia función de armado de filas (`buildTablaPlana`/`buildTablaAgrupada`
en cuenta_corriente_proveedores.js) y necesitaba el botón por separado.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_cuenta_corriente_proveedores_ver_compra.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def completar_compra_pepsico(page, cantidad, costo):
    """Copiado de test_cuenta_corriente_proveedores.py: compra 'Remito' a
    Pepsico SA de Coca-Cola 2L, la confirma y finaliza."""
    page.evaluate("window.location.hash = 'compras_v2'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(300)
    page.get_by_text("Tradicional", exact=True).click()
    page.wait_for_timeout(300)
    page.locator("#cv2-prov-search").click()
    page.keyboard.type("Pepsico", delay=20)
    page.wait_for_timeout(300)
    page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
    page.wait_for_timeout(300)
    page.select_option("#cv2-condicion-compra", label="Remito")
    page.wait_for_timeout(200)
    page.fill("#cv2-total-factura", str(cantidad * costo))
    page.locator("#cv2-total-factura").blur()
    page.wait_for_timeout(200)
    page.get_by_text("Continuar al Carrito", exact=False).click()
    page.wait_for_timeout(400)

    page.locator("#cv2-search").click()
    page.keyboard.type("Coca", delay=30)
    page.wait_for_timeout(400)
    page.locator(".cv2-dd-item", has_text="Coca-Cola 2L").click()
    page.wait_for_timeout(400)

    row = "tr[data-idx='0']"
    page.fill(f"{row} input[data-field='cantidad']", str(cantidad))
    page.fill(f"{row} input[data-field='costoNuevo']", str(costo))
    page.locator(f"{row} input[data-field='costoNuevo']").blur()
    page.wait_for_timeout(300)

    page.get_by_text("Siguiente", exact=False).click()
    page.wait_for_timeout(500)
    page.get_by_text("Confirmar Ingreso", exact=False).click()
    page.wait_for_timeout(700)
    page.get_by_text("Siguiente", exact=False).click()
    page.wait_for_timeout(600)
    page.get_by_text("Finalizar", exact=False).click()
    page.wait_for_timeout(600)

    return cantidad * costo


def abrir_detalle_proveedor(page):
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(200)
    page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    fila = page.locator("tr", has_text="Pepsico SA")
    fila.locator(".btn-ver-detalle").click()
    page.wait_for_timeout(300)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1800, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Completar compra real a Pepsico SA: 5 x Coca-Cola 2L a $60 ---")
        completar_compra_pepsico(page, cantidad=5, costo=60)

        print("--- Vista Cronológico: botón 'Ver' junto a la fila Compra ---")
        abrir_detalle_proveedor(page)
        page.locator("#btn-ledger-plano").click()
        page.wait_for_timeout(300)
        ver_btn = page.locator("tr.ledger-row-compra [data-ver-compra]")
        assert ver_btn.count() == 1, f"Esperaba 1 botón Ver en la fila de compra (cronológico): {ver_btn.count()}"
        ver_btn.click()
        page.wait_for_timeout(300)

        overlay = page.locator("#ccprov-overlay")
        assert overlay.locator(".ccprov-modal").count() == 1, "El modal de detalle de compra no se abrió (cronológico)"
        detalle = overlay.inner_text()
        assert "Coca-Cola 2L" in detalle, f"El detalle no muestra el producto: {detalle!r}"
        assert "300,00" in detalle, f"El detalle no muestra el total: {detalle!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ccprov_ver_compra_cronologico.png"))
        page.locator("#btn-detcompra-ok").click()
        page.wait_for_timeout(200)
        assert overlay.locator(".ccprov-modal").count() == 0, "El modal no se cerró"

        print("--- Vista Por factura: botón 'Ver' junto a la fila Compra ---")
        page.locator("#btn-ledger-agrupado").click()
        page.wait_for_timeout(300)
        ver_btn2 = page.locator("tr.ledger-row-compra [data-ver-compra]")
        assert ver_btn2.count() == 1, f"Esperaba 1 botón Ver en la fila de compra (por factura): {ver_btn2.count()}"
        ver_btn2.click()
        page.wait_for_timeout(300)
        assert overlay.locator(".ccprov-modal").count() == 1, "El modal de detalle de compra no se abrió (por factura)"
        detalle2 = overlay.inner_text()
        assert "Coca-Cola 2L" in detalle2 and "300,00" in detalle2, (
            f"El detalle desde la vista por factura no coincide: {detalle2!r}"
        )
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ccprov_ver_compra_agrupado.png"))

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - 'Ver' compra desde Cuentas Corrientes de proveedores, en las dos vistas del ledger.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
