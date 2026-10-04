"""
tests/e2e/test_familia_costo_paquete_miembro.py — Auditoría de sync.js del
4/10/2026 (tras el bug de Cebolla, ver CLAUDE.md "BUG GRAVE DE PRECIOS")
encontró un problema hermano en familia.js: al heredar costo de la madre,
`sincRow()` pisaba `costo_paquete` del MIEMBRO con el mismo valor que
`costo` sin multiplicar por las unidades_por_paquete_compra PROPIAS de ese
miembro -- si un hijo tiene una presentación de compra distinta de la madre
(ej. la madre se compra por unidad y el hijo por caja de 6), costo_paquete
quedaba inconsistente con costo*uppc, el mismo síntoma que el bug de sync.

Cubre: producto madre (markup_fijo) + hijo con unidades_por_paquete_compra=4
(hereda_costo=1) -- una compra que le cambia el costo a la madre y se
sincroniza al hijo debe dejar costo_paquete del HIJO = nuevoCosto * 4, no
nuevoCosto a secas.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_familia_costo_paquete_miembro.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, markup_fijo,
       stock_minimo, unidad_medida, unidades_por_paquete_compra,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('prod-fam-madre', 'Familia Costo Paquete Madre', 100, 100, 130, 30, 1, 'unidad', 1,
       1, 0, 1, ?, ?, 'synced', ?)`,
    [now, now, now]
  );
  // Hijo con presentación de compra DISTINTA de la madre (caja de 4) --
  // hereda_costo=1: cuando la madre cambia de costo, este hijo lo recibe.
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta,
       stock_minimo, unidad_medida, unidad_compra, unidades_por_paquete_compra,
       es_madre, producto_madre_id, hereda_costo, hereda_precio, precio_independiente, activo,
       fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('prod-fam-hijo', 'Familia Costo Paquete Hijo', 100, 100, 130,
       1, 'unidad', 'Caja x4', 4,
       0, 'prod-fam-madre', 1, 1, 0, 1, ?, ?, 'synced', ?)`,
    [now, now, now]
  );
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1900, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed: madre (markup fijo) + hijo con uppc=4 (hereda costo) ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        print("--- Compra Remito: baja el costo de la madre de 100 a 80 (dispara markup fijo + wizard) ---")
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
        page.fill("#cv2-total-factura", "800")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        page.locator("#cv2-search").click()
        page.keyboard.type("Familia Costo Paquete Madre", delay=20)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Familia Costo Paquete Madre").click()
        page.wait_for_timeout(400)

        row = "tr[data-idx='0']"
        page.fill(f"{row} input[data-field='cantidad']", "10")
        page.fill(f"{row} input[data-field='costoNuevo']", "80")
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(300)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.get_by_text("Confirmar Ingreso", exact=False).click()
        page.wait_for_timeout(700)

        assert page.locator(".cv2-her-overlay").is_visible(), (
            "El wizard de familia debería haberse abierto solo (markup fijo + familia)"
        )

        print("--- Sincronizar: el hijo hereda costo ---")
        page.locator(".cv2-her-btn-apply").click()
        page.wait_for_timeout(300)
        assert not page.locator(".cv2-her-overlay").is_visible(), "El wizard debería haberse cerrado"

        hijo = q(page, "SELECT costo, costo_paquete FROM productos WHERE id='prod-fam-hijo'")[0]
        print(f"   Hijo: {hijo}")
        assert hijo["costo"] == 80, f"El hijo no heredó el costo nuevo: {hijo}"
        assert hijo["costo_paquete"] == 320, (
            f"BUG: costo_paquete del hijo debería ser costo*uppc propio (80*4=320), no 80 a secas: {hijo}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_familia_costo_paquete_miembro: PASA "
              "(costo_paquete del hijo usa SU PROPIA unidades_por_paquete_compra, no la de la madre)")


if __name__ == "__main__":
    main()
