"""
tests/e2e/test_usuarios_rediseno_permisos.py — Rediseño del módulo Usuarios:
permisos más granulares (ver/editar productos separados, costos ocultables,
cuenta corriente de proveedores separada de "ver proveedores", roturas y
vencimientos separados de operaciones de stock genéricas), plantillas de rol,
dependencias blandas en la UI (tildar "editar productos" auto-tilda y
bloquea destildar "ver productos"), y columna de resumen en la tabla.

A diferencia de test_usuarios_permisos.py (que arma usuarios por SQL directo
para probar el guard de rutas), este test pasa por el flujo real de la UI:
crear usuario -> aplicar plantilla -> guardar -> loguearse como ese usuario
-> verificar que el enforcement en productos.js/operaciones_stock.js/app.js
coincide con lo que la plantilla prometía.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_usuarios_rediseno_permisos.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, login_direct

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
RESTRINGIDO = "Acceso restringido"


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin POS + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Crear usuario nuevo con la plantilla 'Encargado de Stock' ---")
        page.evaluate("window.location.hash = 'usuarios'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.get_by_text("+ Nuevo Usuario", exact=True).click()
        page.wait_for_timeout(300)

        page.fill("#usuario-nombre", "Encargado Stock Test")
        page.fill("#usuario-username", "encargado.stock")
        page.select_option("#usuario-rol", "colaborador")
        page.wait_for_timeout(200)
        page.fill("#usuario-password", "stock123")

        page.select_option("#permiso-preset", "encargado_stock")
        page.locator("#btn-aplicar-preset").click()
        page.wait_for_timeout(300)

        print("--- Verificar dependencia: 'Ver productos' queda tildado y bloqueado ---")
        ver_prod = page.locator(".permiso-check[data-key='can_ver_productos']")
        assert ver_prod.is_checked(), "can_ver_productos deberia quedar tildado (lo requiere can_editar_productos)"
        assert ver_prod.is_disabled(), "can_ver_productos deberia estar bloqueado mientras can_editar_productos este tildado"

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "usuarios_preset_aplicado.png"), full_page=True)

        print("--- Guardar usuario ---")
        page.locator("#btn-guardar-usuario").click()
        page.wait_for_timeout(500)

        print("--- Verificar columna 'Permisos' en la tabla ---")
        fila = page.locator("tr", has_text="Encargado Stock Test")
        fila_text = fila.inner_text()
        assert "/" in fila_text and "permisos" in fila_text, f"No se ve el resumen de permisos en la tabla: {fila_text!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "usuarios_tabla_resumen.png"), full_page=True)

        print("--- Login como el usuario recien creado y verificar enforcement real ---")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="encargado.stock", password="stock123")
        page.wait_for_timeout(300)

        # Ver + editar productos + costos: todo permitido
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        text = page.locator("#app").inner_text()
        assert RESTRINGIDO not in text, f"Deberia poder ver productos: {text[:150]!r}"
        assert page.locator("#btn-nuevo-producto").is_visible(), "Deberia poder crear productos (can_editar_productos)"
        primera_fila = page.locator("#productos-tbody tr").first.inner_text()
        assert "🔒" not in primera_fila, f"Deberia ver los costos (can_ver_costos): {primera_fila!r}"

        # Roturas y vencimientos: permitido
        for ruta in ["roturas", "vencimientos", "operaciones_stock", "consumo_interno"]:
            page.evaluate(f"window.location.hash = '{ruta}'")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(300)
            t = page.locator("#app").inner_text()
            assert RESTRINGIDO not in t, f"#{ruta} deberia ser accesible para Encargado de Stock: {t[:150]!r}"

        # Cuenta corriente de proveedores: NO estaba en la plantilla -> bloqueado
        # (aunque "Ver proveedores" si esta incluido)
        page.evaluate("window.location.hash = 'proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        text_prov = page.locator("#app").inner_text()
        assert RESTRINGIDO not in text_prov, f"Deberia poder ver proveedores: {text_prov[:150]!r}"

        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        text_cc = page.locator("#app").inner_text()
        assert RESTRINGIDO in text_cc, (
            f"Cuenta corriente de proveedores NO deberia ser accesible (la plantilla Encargado de Stock no la incluye): {text_cc[:150]!r}"
        )

        # Gastos: tampoco esta en la plantilla
        page.evaluate("window.location.hash = 'gastos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        text_gastos = page.locator("#app").inner_text()
        assert RESTRINGIDO in text_gastos, f"Gastos NO deberia ser accesible: {text_gastos[:150]!r}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Rediseno de Usuarios y Permisos: plantillas, dependencias UI y enforcement real coinciden.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
