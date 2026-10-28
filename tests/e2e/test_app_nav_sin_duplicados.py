"""
tests/e2e/test_app_nav_sin_duplicados.py — El menú lateral (sidebar) nunca
debería mostrar el mismo módulo dos veces.

Bug real encontrado en producción (22/10/2026, captura del usuario):
"Aprobaciones Pendientes" aparecía DOS veces en el sidebar de Admin-POS —
una vez al lado de "Operaciones de Stock" (su posición actual, correcta,
desde el 28/9/2026) y otra vez pegada a "Configuración" (su posición
VIEJA, de antes de ese cambio). Causa: una promoción histórica a `main`
cherry-pickeó el commit que agregaba la entrada nueva pero nunca el que
sacaba la vieja -- `dev` nunca tuvo el bug (ahí el array moduleList de
app.js siempre tuvo una sola entrada), era un residuo exclusivo de `main`
(fix directo ahí, ver commit 658f25d).

Este test es un guardia general, no específico de "Aprobaciones
Pendientes": verifica que NINGÚN módulo del sidebar (ni en POS admin
logueado como admin, ni en Admin-POS) aparezca repetido — para agarrar
esta MISMA clase de bug (residuo de una promoción a medias) en cualquier
otro ítem del menú, no solo en este.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_app_nav_sin_duplicados.py
"""
import os
import sys
from collections import Counter

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def nombres_del_sidebar(page):
    return page.locator("aside.sidebar nav a[data-module]").evaluate_all(
        "els => els.map(e => e.dataset.module + (e.dataset.medio ? '/' + e.dataset.medio : ''))"
    )


def assert_sin_duplicados(nombres, contexto):
    conteo = Counter(nombres)
    repetidos = {k: v for k, v in conteo.items() if v > 1}
    assert not repetidos, f"BUG: módulo(s) repetidos en el sidebar ({contexto}): {repetidos}\nSidebar completo: {nombres}"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Admin-POS (admin): revisar el sidebar completo ---")
        login_via_seed(page, admin_pos=True)
        nombres_admin_pos = nombres_del_sidebar(page)
        assert "aprobaciones_pendientes" in nombres_admin_pos, \
            f"'Aprobaciones Pendientes' debería estar en el sidebar de Admin-POS: {nombres_admin_pos}"
        assert_sin_duplicados(nombres_admin_pos, "Admin-POS")
        print(f"OK - {len(nombres_admin_pos)} ítems, ninguno repetido")

        print("--- POS local, logueado como admin: revisar el sidebar completo ---")
        page2 = context.new_page()
        page2.on("pageerror", lambda exc: errors.append(str(exc)))
        login_via_seed(page2, admin_pos=False)
        nombres_pos = nombres_del_sidebar(page2)
        assert_sin_duplicados(nombres_pos, "POS (admin)")
        print(f"OK - {len(nombres_pos)} ítems, ninguno repetido")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: el sidebar no repite ningún módulo, en ninguna de las dos superficies ===")
        browser.close()


if __name__ == "__main__":
    main()
