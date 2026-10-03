"""
tests/e2e/test_editor_producto_costo_paquete_oculto.py — El campo "Costo por
unidad de compra" (Precios y Costos) tiene que arrancar OCULTO para un
producto con unidad_compra en {'Unidad','Kg','Lt'} -- antes arrancaba
siempre visible (con el valor guardado, aunque no tuviera sentido mostrarlo)
hasta que el usuario tocara el selector de unidad de compra.

Bug real (3/10/2026): el usuario reportó ver "Costo por unidad de compra:
$3.490" en el Editor para "Cebolla", un producto con unidad_compra=unidad_
venta='Unidad' (confirmado por el usuario) -- ese campo debería estar
oculto en ese caso. Causa: updatePresEditorUI() (la función que
oculta/muestra el campo) solo se llama desde los listeners 'change'/'input'
del selector de unidad de compra, nunca al cargar la pantalla por primera
vez -- el <div id="ed-costo-paquete-wrap"> del HTML no trae ningún estilo
condicional, así que siempre entra visible hasta la primera interacción.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_costo_paquete_oculto.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed: Cebolla (unidad_compra='Unidad', costo_paquete viejo de ejemplo) ---")
        login_via_seed(page, admin_pos=True, wait_target="productos")
        setup = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const id = window.SGA_Utils.generateUUID();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, stock_minimo, unidad_medida,
                 unidad_compra, unidades_por_paquete_compra, unidad_venta,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES (?, 'Cebolla Test', 2990, 3490, 4780, 1, 'unidad',
                 'Unidad', 1, 'Unidad', 0, 0, 1, ?, ?, 'synced', ?)`, [id, now, now, now]
            );
            return { id };
          }
        """)

        print("--- Abrir el editor DIRECTO (sin tocar nada) y entrar a Precios y Costos ---")
        page.evaluate(f"window.location.hash = 'editor-producto/{setup['id']}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)

        print("--- 'Costo por unidad de compra' debe arrancar OCULTO (unidad_compra='Unidad') ---")
        wrap = page.locator("#ed-costo-paquete-wrap")
        assert not wrap.is_visible(), (
            "BUG: el campo 'Costo por unidad de compra' está visible sin que el usuario haya tocado nada, "
            "aunque unidad_compra='Unidad' (debería estar oculto)"
        )
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "editor_costo_paquete_oculto.png"), full_page=True)
        print("   OK - arranca oculto")

        print("--- Cambiar a una unidad con conversión real (ej. 'Bolsa') SÍ lo muestra ---")
        # "¿Cómo lo compro?" vive en la pestaña Datos Básicos, no en Precios y Costos.
        page.locator("[data-section='datos-basicos']").first.click()
        page.wait_for_timeout(200)
        page.select_option("#ed-unidad-compra", "Bolsa")
        page.wait_for_timeout(150)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(200)
        assert wrap.is_visible(), "Con una unidad de compra con conversión, el campo debería mostrarse"
        print("   OK - se muestra al cambiar a una unidad con conversión")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_editor_producto_costo_paquete_oculto: PASA")


if __name__ == "__main__":
    main()
