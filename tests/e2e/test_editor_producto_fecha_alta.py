"""
tests/e2e/test_editor_producto_fecha_alta.py — Pedido del usuario (20/10/2026):
un producto creado desde Productos -> Nuevo Producto (editor-producto.js, la
pantalla completa, NO el modal rápido de productos.js ni submitNewProduct de
compras_v2.js) quedaba con `fecha_alta` vacía para siempre — el INSERT de
`saveAllCore()` nunca incluía esa columna (solo fecha_modificacion/updated_at).
Encontrado de rebote investigando por qué un producto comprado a "Fumo Bravo"
no tenía proveedor asignado: la fecha_alta vacía fue la pista de que ese
producto se había dado de alta por ESTE camino, no por el carrito de compras.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_fecha_alta.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def set_val(page, el_id, val):
    page.evaluate(
        """([id, v]) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        [el_id, val],
    )


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed ---")
        login_via_seed(page, admin_pos=True, wait_target="productos")

        print("--- Crear un producto nuevo desde el editor completo ---")
        page.evaluate("window.location.hash = 'editor-producto/new'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.fill("#ed-nombre", "EDPROD Fecha Alta Test")
        set_val(page, "ed-costo", "10")
        set_val(page, "ed-precio-venta", "20")
        page.wait_for_timeout(150)
        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(600)

        row = q(page, "SELECT fecha_alta, fecha_modificacion FROM productos WHERE nombre='EDPROD Fecha Alta Test'")[0]
        print(f"Fila guardada: {row}")
        assert row["fecha_alta"], f"fecha_alta debería haber quedado completa: {row}"
        assert row["fecha_modificacion"], f"fecha_modificacion debería haber quedado completa: {row}"
        print("OK - fecha_alta queda completa al crear un producto desde el editor")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: editor-producto.js completa fecha_alta al crear ===")
        browser.close()


if __name__ == "__main__":
    main()
