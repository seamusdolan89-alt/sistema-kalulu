"""
tests/e2e/test_pestana_unica.py — Una sola pestaña por base.

Cada pestaña carga su copia de la base y al guardar escribe el archivo entero: con dos abiertas, la
que guarda después borra en silencio lo cargado en la otra. Ahora la segunda se bloquea; se puede
elegir "Usar acá", y la anterior queda bloqueada sin volver a escribir.

Cubre: bloqueo de la segunda, POS y Admin-POS siguen conviviendo, cancelar no cambia nada, "Usar acá"
conserva lo que había cargado la otra, la vieja se recarga bloqueada, y cerrar la activa libera.

Correr (server en :8765):  python tests/e2e/test_pestana_unica.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import BASE_URL, block_firebase, enable_dev_mode, login_direct, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
MARCA = "SELECT value FROM system_config WHERE key = ?"


def marcar(page, clave):
    page.evaluate("(k) => window.SGA_DB.run(\"INSERT INTO system_config (key, value) VALUES (?, 'x')\", [k])", clave)


def tiene(page, clave):
    return page.evaluate("([s, k]) => window.SGA_DB.query(s, [k]).length", [MARCA, clave]) == 1


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        errors = []

        a = context.new_page()
        a.on("pageerror", lambda e: errors.append(str(e)))
        login_via_seed(a, admin_pos=False)
        marcar(a, "cargado_en_a")
        assert tiene(a, "cargado_en_a")
        a.evaluate("() => window.SGA_DB.flush()")

        admin = context.new_page()
        login_via_seed(admin, admin_pos=True)
        assert admin.locator("#sga-otra-pestana").count() == 0 and a.locator("#sga-otra-pestana").count() == 0
        print("OK - POS y Admin-POS conviven")

        b = context.new_page()
        b.on("pageerror", lambda e: errors.append(str(e)))
        b.goto(f"{BASE_URL}/index.html")
        capa = b.locator("#sga-otra-pestana")
        capa.wait_for(state="visible", timeout=15000)
        b.screenshot(path=os.path.join(SCREENSHOT_DIR, "pestana_bloqueada.png"))
        b.once("dialog", lambda d: d.dismiss())
        b.locator("#sga-usar-aca").click()
        assert capa.is_visible() and a.locator("#sga-otra-pestana").count() == 0
        marcar(a, "despues_en_a")          # A sigue trabajando
        print("OK - la segunda se bloquea y cancelar no cambia nada")

        b.once("dialog", lambda d: d.accept())
        b.locator("#sga-usar-aca").click()
        capa.wait_for(state="detached", timeout=15000)
        a.locator("#sga-otra-pestana").wait_for(state="visible", timeout=20000)
        b.wait_for_url("**/login.html*", timeout=20000)      # la pestaña nueva no tiene sesion
        login_direct(b)
        assert tiene(b, "cargado_en_a") and tiene(b, "despues_en_a"), "B perdio lo cargado en A"
        marcar(b, "cargado_en_b")
        b.evaluate("() => window.SGA_DB.flush()")
        print("OK - Usar aca: conserva los datos y bloquea la anterior")

        b.close()
        a.reload()
        a.wait_for_function("() => window.SGA_Auth && window.SGA_Auth.getCurrentUser()", timeout=20000)
        a.wait_for_timeout(500)
        assert a.locator("#sga-otra-pestana").count() == 0
        assert tiene(a, "cargado_en_b"), "La pestaña vieja piso lo cargado en la nueva"
        print("OK - al cerrar la activa se libera y no se piso nada")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_pestana_unica")


if __name__ == "__main__":
    main()
