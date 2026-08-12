"""
tests/e2e/test_pos_smoke.py — Smoke test del modulo POS.

Verifica: login (via seed de datos demo) -> POS carga -> sidebar con los
modulos esperados -> modal de Apertura de Caja aparece cuando no hay sesion
de caja activa.

Correr (desde la raiz del repo, con el server ya levantado en el puerto 8765):

    python -m http.server 8765 --bind 127.0.0.1   # en otra terminal
    python tests/e2e/test_pos_smoke.py

O con el helper with_server.py de la skill webapp-testing:

    python <skills>/webapp-testing/scripts/with_server.py \
        --server "python -m http.server 8765 --bind 127.0.0.1" --port 8765 \
        -- python tests/e2e/test_pos_smoke.py
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
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("console", lambda msg: print(f"[console:{msg.type}] {msg.text}") if msg.type == "error" else None)

        print("--- Login via seed (admin/kalulu123 + datos demo) ---")
        login_via_seed(page)

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_home.png"), full_page=True)

        # --- Assertions basicas ---
        assert "Sistema Kalulu" in page.title(), f"Titulo inesperado: {page.title()}"

        user_label = page.locator("#user-name").inner_text()
        assert "admin" in user_label.lower(), f"Usuario logueado inesperado: {user_label}"

        nav_texts = " ".join(page.locator("aside.sidebar nav").inner_text().split())
        expected_modules = [
            "Punto de Venta", "Productos", "Clientes", "Cajas",
            "Operaciones de Stock", "Proveedores", "Informes", "Usuarios",
        ]
        missing = [m for m in expected_modules if m not in nav_texts]
        assert not missing, f"Modulos faltantes en el sidebar: {missing}"

        # Sin sesion de caja activa, debe aparecer el modal de apertura
        apertura_modal = page.locator("text=Apertura de Caja")
        assert apertura_modal.is_visible(), "No aparecio el modal de Apertura de Caja"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - POS smoke test paso correctamente.")
        print(f"Screenshot: {os.path.join(SCREENSHOT_DIR, 'pos_home.png')}")

        browser.close()


if __name__ == "__main__":
    main()
