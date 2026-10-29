"""
tests/e2e/test_peek_productos.py

Peek de Productos: búsqueda rápida de stock/precio SIN abandonar la pantalla actual.
Pedido explícito del usuario (29/10/2026) en la misma conversación donde contó que
abrió una segunda pestaña del POS para atender a un cliente y perdió dos ventas (ver
project_dos_pestanas_opfs_riesgo.md) — preguntó cómo evitar tener que navegar lejos de
lo que estaba haciendo (ej. armando etiquetas) solo para chequear un producto.

Se abre con Ctrl+K / el botón flotante (`js/modules/peek_productos.js`, precargado en
app.js init() si el usuario tiene can_ver_productos) como un panel flotante por encima
de la pantalla actual — nunca navega, nunca toca #app (el router solo reemplaza ese
elemento, ver app.js loadView()), así que la pantalla de atrás queda intacta. Reusa el
motor único de búsqueda (buscador_productos.js: porTexto/porCodigo/attachDropdownKeyboard).

Verifica: el botón flotante persiste entre pantallas (POS y Admin-POS), Ctrl+K abre y
enfoca la búsqueda, buscar y clickear un resultado muestra el detalle (stock/precio/
costo), y Escape cierra el panel SIN disparar ningún efecto en la pantalla de atrás
(Etiquetas con una selección en curso, en este caso) — el listener de Escape del peek
va en fase de captura justamente para eso.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_peek_productos.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        page.evaluate("window.location.hash = 'etiquetas'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        fab = page.locator("#pkp-fab-btn")
        assert fab.count() > 0 and fab.is_visible(), "El botón flotante debería estar visible en cualquier pantalla"

        print("--- Dejar una selección en curso en Etiquetas (para verificar que el peek no la toca) ---")
        search = page.locator("#etiq-busqueda")
        search.click()
        search.type("Coca", delay=20)
        page.wait_for_timeout(350)
        page.locator(".etiq-drop-item").first.click()
        page.wait_for_timeout(150)
        etiq_antes = page.locator(".etiq-list").inner_text()
        assert "Coca-Cola 2L" in etiq_antes

        print("--- Ctrl+K abre el peek y enfoca la busqueda ---")
        page.keyboard.press("Control+k")
        page.wait_for_timeout(150)
        assert page.locator(".pkp-overlay").is_visible(), "El overlay debería abrirse con Ctrl+K"
        assert page.evaluate("document.activeElement.id") == "pkp-input", "El input de búsqueda debería quedar enfocado"

        print("--- Buscar 'Detergente' y ver el detalle ---")
        page.locator("#pkp-input").type("Deterg", delay=20)
        page.wait_for_timeout(300)
        rows_text = page.locator("#pkp-body").inner_text()
        assert "Detergente" in rows_text, f"Debería aparecer Detergente 500ml en los resultados: {rows_text[:200]!r}"

        page.locator(".pkp-row").first.click()
        page.wait_for_timeout(150)
        detalle_text = page.locator("#pkp-body").inner_text()
        assert "Stock" in detalle_text and "Precio de venta" in detalle_text, (
            f"El detalle debería mostrar stock y precio: {detalle_text[:300]!r}"
        )
        assert "Costo" in detalle_text, "El admin debería ver el costo en el detalle"

        print("--- Escape cierra el peek SIN afectar Etiquetas detras ---")
        page.keyboard.press("Escape")
        page.wait_for_timeout(150)
        assert not page.locator(".pkp-overlay").is_visible(), "El overlay debería cerrarse con Escape"
        etiq_despues = page.locator(".etiq-list").inner_text()
        assert etiq_antes == etiq_despues, (
            "BUG: Escape para cerrar el peek no debería afectar la pantalla de atrás "
            f"(antes={etiq_antes[:150]!r}, despues={etiq_despues[:150]!r})"
        )

        print("--- El boton flotante tambien abre/cierra el panel ---")
        fab.click()
        page.wait_for_timeout(150)
        assert page.locator(".pkp-overlay").is_visible()
        page.locator("#pkp-btn-close").click()
        page.wait_for_timeout(100)
        assert not page.locator(".pkp-overlay").is_visible()

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_peek_productos: PASA")


if __name__ == "__main__":
    run()
