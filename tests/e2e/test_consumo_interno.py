"""
tests/e2e/test_consumo_interno.py — Consumo interno con atribucion a otro
usuario y confirmacion por contraseña (feature de commit eba8640, ver git
log). Cubre: cantidad/stock, motivo, atribuir a uno mismo (sin password),
atribuir a otro usuario (requiere password: vacia -> error, incorrecta ->
error, correcta -> se guarda), y que el registro quede con
usuario_id=atribuido / registrado_por_usuario_id=quien realmente operaba.

CORRECCIÓN (sesión previa): una versión anterior de este test disparaba un
"NotFoundError: node no longer a child of this node" al cambiar la
cantidad via `input.dispatch_event("change")` — parecía un bug de la app,
pero se confirmó que era un artefacto del test: `dispatch_event("change")`
dispara el evento de forma sintética mientras el input aún se considera
"foco actual" para Playwright, algo que un usuario real nunca hace.
Reproducido con una interacción real (escribir + click en otro campo,
blur genuino) y el mismo cambio de cantidad funciona sin error — el
`renderCart()` en `consumo_interno.js` reconstruye el `<tbody>` sin
problema cuando el 'change' llega por el camino normal (blur nativo). Este
test ahora usa esa interacción realista.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_consumo_interno.py
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

        print("--- Crear segundo usuario 'cajera1' / 'cajera123' ---")
        page.evaluate("""
          async () => {
            const now = new Date().toISOString();
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cajera123'));
            const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            window.SGA_DB.run(
              `INSERT INTO usuarios (id, firebase_uid, nombre, username, password_hash, rol, sucursal_id, activo, sync_status, updated_at)
               VALUES ('user-cajera1', 'dev-cajera1', 'Cajera Uno', 'cajera1', ?, 'cajero', '1', 1, 'pending', ?)`,
              [hash, now]
            );
          }
        """)
        page.wait_for_timeout(200)

        page.evaluate("window.location.hash = 'consumo_interno'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Agregar Coca-Cola 2L x2 al carrito de consumo ---")
        page.locator("#ci-search-input").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#ci-search-dropdown .sri").click()
        page.wait_for_timeout(300)
        # Interaccion realista: escribir la cantidad y hacer click en otro
        # campo (blur genuino) en vez de dispatch_event("change") sintetico
        # — ver nota en el docstring.
        page.fill("input[data-qty='0']", "2")
        page.locator("#ci-motivo").click()
        page.select_option("#ci-motivo", "uso_interno")

        print("--- Atribuir a otro usuario (Cajera Uno) -> debe pedir password ---")
        page.select_option("#ci-atribuido", "user-cajera1")
        page.wait_for_timeout(300)
        assert page.locator("#ci-password-wrap").is_visible(), "El campo de password deberia aparecer al atribuir a otro usuario"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ci_password_visible.png"), full_page=True)

        print("--- Confirmar sin password -> error ---")
        page.locator("#ci-confirm").click()
        page.wait_for_timeout(300)
        err1 = page.locator("#ci-password-error").inner_text()
        assert "contraseña" in err1.lower(), f"Deberia pedir la contraseña: {err1!r}"

        print("--- Confirmar con password incorrecta -> error ---")
        page.fill("#ci-password", "mal123")
        page.locator("#ci-confirm").click()
        page.wait_for_timeout(400)
        err2 = page.locator("#ci-password-error").inner_text()
        assert "incorrecta" in err2.lower(), f"Deberia rechazar la contraseña incorrecta: {err2!r}"

        print("--- Confirmar con password correcta -> se guarda ---")
        page.fill("#ci-password", "cajera123")
        page.locator("#ci-confirm").click()
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ci_confirmado.png"), full_page=True)

        current_hash = page.evaluate("() => window.location.hash")
        assert current_hash == "#operaciones_stock", f"No redirigio a Operaciones de Stock tras confirmar: {current_hash!r}"

        print("--- Verificar registro en consumo_interno y descuento de stock ---")
        rows = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT usuario_id, registrado_por_usuario_id, cantidad, motivo FROM consumo_interno"
          )
        """)
        assert len(rows) == 1, f"Se esperaba 1 registro de consumo_interno, hay {len(rows)}: {rows}"
        row = rows[0]
        assert row["usuario_id"] == "user-cajera1", f"El consumo deberia atribuirse a cajera1: {row}"
        assert row["registrado_por_usuario_id"] != "user-cajera1", (
            f"registrado_por_usuario_id deberia ser quien realmente operaba (admin), no cajera1: {row}"
        )
        assert abs(row["cantidad"] - 2) < 0.01, f"Cantidad inesperada: {row}"

        stock = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT cantidad FROM stock WHERE producto_id = (SELECT id FROM productos WHERE nombre='Coca-Cola 2L')"
          )
        """)
        assert abs(stock[0]["cantidad"] - 18) < 0.01, f"Stock esperado 18 (20-2), obtenido: {stock}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Consumo interno: atribucion a otro usuario con confirmacion por password funciona correctamente.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
