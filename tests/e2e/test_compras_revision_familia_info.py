"""
tests/e2e/test_compras_revision_familia_info.py — Los modales "Asociar
sustituto"/"Asignar madre" de Compras-Revisión muestran PRIMERO si el
producto ya pertenece a una familia o a un grupo de sustitutos, antes de
dejar buscar una asignación nueva.

Pedido real del usuario (30/9/2026, con una captura): al abrir "Asignar
madre" para un producto, no sabía si ya pertenecía a alguna familia — el
modal arrancaba directo en el buscador vacío, sin ningún dato previo.

Cubre las 3 situaciones posibles para cada modal:
  - Sustituto: sin grupo todavía / ya pertenece a un grupo (con la
    referencia y quiénes más le apuntan).
  - Madre: sin familia todavía / ya es hija (madre + hermanos) / ya es
    madre de otros productos (con la lista de hijos y el aviso de que
    asignarle una madre no reacomoda a los suyos).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_revision_familia_info.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const mkProd = (id, nombre, esMadre) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES (?, ?, 10, 20, 1, 'unidad', ?, 0, 1, ?, ?, 'pending', ?)`,
    [id, nombre, esMadre ? 1 : 0, now, now, now]
  );

  // 1) Ya pertenece a un grupo de sustitutos: referencia + 1 seguidor.
  mkProd('prod-info-ref', 'Referencia Existente Sprite', false);
  mkProd('prod-info-seg', 'Seguidor Existente Sprite', false);
  window.SGA_DB.run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
     VALUES ('prod-info-seg', 'prod-info-ref', 'prod-info-ref', 1, ?)`, [now]
  );

  // 2) Ya es hija (con un hermano) — para probar "Asociar sustituto"/"Asignar
  //    madre" sobre una hija que todavía no pertenece a ningún grupo de sustitutos.
  mkProd('prod-info-madre-x', 'Madre Existente Fanta', true);
  mkProd('prod-info-hijo', 'Hija Existente Fanta Uno', false);
  mkProd('prod-info-hermano', 'Hija Existente Fanta Dos', false);
  window.SGA_DB.run(`UPDATE productos SET producto_madre_id='prod-info-madre-x', hereda_costo=1, hereda_precio=1 WHERE id='prod-info-hijo'`);
  window.SGA_DB.run(`UPDATE productos SET producto_madre_id='prod-info-madre-x', hereda_costo=1, hereda_precio=1 WHERE id='prod-info-hermano'`);

  // 3) Ya es madre de otro producto (para "Asignar madre" sobre una madre).
  mkProd('prod-info-madre-y', 'Madre Existente Sprite Light', true);
  mkProd('prod-info-hijo-y', 'Hija Existente Sprite Light', false);
  window.SGA_DB.run(`UPDATE productos SET producto_madre_id='prod-info-madre-y' WHERE id='prod-info-hijo-y'`);

  // 4) Sin ninguna relación todavía.
  mkProd('prod-info-nada', 'Producto Suelto Sin Familia', false);
}
"""


def abrir_familia_menu(page, row_idx, accion):
    page.locator(f'[data-rev-menu="familia"][data-rev-idx="{row_idx}"]').click()
    page.wait_for_timeout(200)
    page.locator(f'[data-rev-accion="{accion}"]').click()
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

        print("--- Login admin-pos + seed: grupos/familias ya existentes ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Nueva compra: Tradicional -> Pepsico SA -> Remito (sin Factura A) ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.fill("#cv2-total-factura", "100")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        print("--- Agregar los 4 productos de prueba al carrito ---")
        for nombre in ["Seguidor Existente Sprite", "Hija Existente Fanta Uno",
                       "Madre Existente Sprite Light", "Producto Suelto Sin Familia"]:
            page.locator("#cv2-search").click()
            page.keyboard.type(nombre, delay=15)
            page.wait_for_timeout(350)
            page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=nombre).click()
            page.wait_for_timeout(300)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)

        # idx 0 = Seguidor Existente Sprite (ya en grupo de sustitutos)
        # idx 1 = Hija Existente Fanta Uno (ya es hija, tiene un hermano)
        # idx 2 = Madre Existente Sprite Light (ya es madre de 1 producto)
        # idx 3 = Producto Suelto Sin Familia (sin nada)

        print("--- Sustituto: producto YA en un grupo -> muestra referencia + seguidores (como lista) ---")
        abrir_familia_menu(page, 0, "sust")
        assert page.locator("#cv2-sust-overlay").is_visible(), "No se abrio el overlay de sustituto"
        info_sust = page.locator("#cv2-sust-info").inner_text()
        assert "Referencia Existente Sprite" in info_sust, f"No muestra la referencia del grupo: {info_sust!r}"
        assert "Seguidor Existente Sprite" in info_sust, f"No lista al propio producto entre los que apuntan: {info_sust!r}"
        assert page.locator("#cv2-sust-info li").count() == 1, "Los que apuntan deberían listarse como <li>, no como texto corrido"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "revision_info_sust_con_grupo.png"))

        print("--- ESC cierra ESTE modal, no la pantalla de Revisión de atrás ---")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        assert not page.locator("#cv2-sust-overlay").is_visible(), (
            "BUG: Escape debería haber cerrado el modal de sustituto"
        )
        assert page.locator("#cv2-review-overlay").is_visible(), (
            "BUG: Escape cerró/afectó la pantalla de Revisión de atrás en vez de solo el modal de encima"
        )

        print("--- Sustituto: producto SIN grupo -> 'no pertenece a ningun grupo' ---")
        abrir_familia_menu(page, 3, "sust")
        info_sust_nada = page.locator("#cv2-sust-info").inner_text()
        assert "No pertenece a ningún grupo" in info_sust_nada, f"Debería avisar que no tiene grupo: {info_sust_nada!r}"
        page.locator("#cv2-sust-close").click()
        page.wait_for_timeout(200)

        print("--- Madre: producto YA es hija -> muestra madre + hermanos (como lista) ---")
        abrir_familia_menu(page, 1, "madre")
        assert page.locator("#cv2-madre-overlay").is_visible(), "No se abrio el overlay de madre"
        info_madre_hija = page.locator("#cv2-madre-info").inner_text()
        assert "Madre Existente Fanta" in info_madre_hija, f"No muestra la madre actual: {info_madre_hija!r}"
        assert "Hija Existente Fanta Dos" in info_madre_hija, f"No lista al hermano: {info_madre_hija!r}"
        assert page.locator("#cv2-madre-info li").count() == 1, "Los hermanos deberían listarse como <li>, no como texto corrido"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "revision_info_madre_hija.png"))

        print("--- ESC tambien cierra el modal de madre, no la Revisión de atrás ---")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        assert not page.locator("#cv2-madre-overlay").is_visible(), "BUG: Escape debería haber cerrado el modal de madre"
        assert page.locator("#cv2-review-overlay").is_visible(), "BUG: Escape afectó la Revisión de atrás"

        print("--- Madre: producto YA ES madre -> muestra hijos + aviso ---")
        abrir_familia_menu(page, 2, "madre")
        info_madre_madre = page.locator("#cv2-madre-info").inner_text()
        assert "YA ES madre" in info_madre_madre, f"No avisa que ya es madre: {info_madre_madre!r}"
        assert "Hija Existente Sprite Light" in info_madre_madre, f"No lista su propio hijo: {info_madre_madre!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "revision_info_madre_es_madre.png"))
        page.locator("#cv2-madre-close").click()
        page.wait_for_timeout(200)

        print("--- Madre: producto SIN familia -> 'no pertenece a ninguna familia' ---")
        abrir_familia_menu(page, 3, "madre")
        info_madre_nada = page.locator("#cv2-madre-info").inner_text()
        assert "No pertenece a ninguna familia" in info_madre_nada, f"Debería avisar que no tiene familia: {info_madre_nada!r}"
        page.locator("#cv2-madre-close").click()
        page.wait_for_timeout(200)

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Los modales de Familia muestran la situación previa antes de buscar una asignación nueva.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
