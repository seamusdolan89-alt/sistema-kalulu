"""
tests/e2e/test_compras_revision_acciones_rapidas.py — Acciones rápidas por
fila en Compras — Revisión: "Asociar sustituto" y "Asignar madre" sobre un
producto recién cargado, sin salir de la pantalla.

Pedido por el usuario (2026-09-17): en la pantalla de Revisión (paso final
antes de "Confirmar Ingreso", hasta ahora de solo lectura) poder resolver
ahí mismo, para los productos recién ingresados, dos tareas que hoy obligan
a ir a otra pantalla: asignar un producto de referencia (sustituto) y
asignar una madre.

Cubre:
  1. El botón "⋯" de una fila abre un panel con "Asociar sustituto" y
     "Asignar madre".
  2. "Asociar sustituto": buscar un producto existente y elegirlo asocia de
     inmediato (sin pasos extra) vía producto_sustitutos/referencia_id.
  3. "Asignar madre": buscar, elegir, confirmar con las 2 casillas de
     herencia (default marcadas) setea productos.producto_madre_id.
  4. Confirmar el ingreso de la compra funciona con normalidad después de
     usar ambas acciones (no rompe el flujo de commitCompra).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_revision_acciones_rapidas.py
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
        context = browser.new_context(viewport={"width": 1800, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Sembrar productos candidatos a sustituto/madre (por SQL) ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const productos = [
              { id: 'prod-rar-sust-ref',  nombre: 'Sprite 600ml Referencia' },
              { id: 'prod-rar-madre',     nombre: 'Coca-Cola Familia Madre' },
            ];
            for (const p of productos) {
              window.SGA_DB.run(
                `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                   es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                 VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
                [p.id, p.nombre, now, now, now]
              );
            }
          }
        """)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Nueva compra: Tradicional -> Pepsico SA -> Factura A ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Factura A")
        page.wait_for_timeout(200)

        page.fill("#cv2-subtotal-neto", "200")
        page.locator("#cv2-subtotal-neto").blur()
        page.fill("#cv2-iva-21", "42")
        page.locator("#cv2-iva-21").blur()
        page.wait_for_timeout(200)

        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        print("--- Agregar Coca-Cola 2L (unico item, evita ambiguedad de filas) ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("Coca-Cola 2L", delay=20)
        page.wait_for_timeout(400)
        # ":not(.cv2-dd-acciones-row)" excluye la fila fija "Crear producto
        # nuevo / Vincular a producto existente", que para busquedas de 3+
        # caracteres muestra "Codigo: <lo tipeado>" y por eso matcheaba
        # tambien por has_text.
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Coca-Cola 2L").click()
        page.wait_for_timeout(400)

        row = "tr[data-idx='0']"
        page.fill(f"{row} input[data-field='cantidad']", "2")
        page.fill(f"{row} input[data-field='costoNuevo']", "100")
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(300)

        print("--- Siguiente -> Revision ---")
        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)

        print("--- Abrir el panel de acciones rapidas de la fila ---")
        assert page.locator("[data-rev-mas]").count() == 1, "No aparecio el boton de acciones rapidas en Revision"
        page.locator("[data-rev-mas]").click()
        page.wait_for_timeout(200)
        assert page.locator(".cv2-rev-panel").count() == 1, "El panel de acciones rapidas no se abrio"

        print("--- Asociar sustituto ---")
        page.locator('[data-rev-accion="sust"]').click()
        page.wait_for_timeout(300)
        assert page.locator("#cv2-sust-overlay").is_visible(), "No se abrio el overlay de Asociar sustituto"
        page.fill("#cv2-sust-search", "Sprite 600ml Referencia")
        page.wait_for_timeout(400)
        page.locator("[data-sust-elegir]").click()
        page.wait_for_timeout(300)
        assert not page.locator("#cv2-sust-overlay").is_visible(), "El overlay de sustituto no se cerro al elegir"

        referencia = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT referencia_id FROM producto_sustitutos WHERE producto_id = (
               SELECT id FROM productos WHERE nombre = 'Coca-Cola 2L' LIMIT 1
             )`
          )[0]?.referencia_id
        """)
        print(f"referencia_id asignada: {referencia}")
        assert referencia == 'prod-rar-sust-ref', (
            f"No quedo asociado el sustituto elegido: referencia_id={referencia!r}"
        )

        print("--- Asignar madre ---")
        page.locator("[data-rev-mas]").click()
        page.wait_for_timeout(200)
        page.locator('[data-rev-accion="madre"]').click()
        page.wait_for_timeout(300)
        assert page.locator("#cv2-madre-overlay").is_visible(), "No se abrio el overlay de Asignar madre"
        page.fill("#cv2-madre-search", "Coca-Cola Familia Madre")
        page.wait_for_timeout(400)
        page.locator("[data-madre-elegir]").click()
        page.wait_for_timeout(300)

        # Las 2 casillas de herencia deben venir marcadas por defecto
        chk_costo  = page.locator("#cv2-madre-hereda-costo")
        chk_precio = page.locator("#cv2-madre-hereda-precio")
        assert chk_costo.is_checked() and chk_precio.is_checked(), (
            "Las casillas de herencia deberian venir marcadas por defecto"
        )
        page.locator("#cv2-madre-btn-confirm").click()
        page.wait_for_timeout(300)
        assert not page.locator("#cv2-madre-overlay").is_visible(), "El overlay de madre no se cerro al confirmar"

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_revision_acciones_rapidas.png"), full_page=True)

        madre_info = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT producto_madre_id, hereda_costo, hereda_precio FROM productos WHERE nombre = 'Coca-Cola 2L'`
          )[0]
        """)
        print(f"producto_madre_id / herencia: {madre_info}")
        assert madre_info["producto_madre_id"] == "prod-rar-madre", (
            f"No quedo asignada la madre elegida: {madre_info}"
        )
        assert madre_info["hereda_costo"] == 1 and madre_info["hereda_precio"] == 1, (
            f"La herencia por defecto (costo y precio) no quedo marcada: {madre_info}"
        )

        madre_convertida = page.evaluate("""
          () => window.SGA_DB.query(`SELECT es_madre FROM productos WHERE id = 'prod-rar-madre'`)[0]?.es_madre
        """)
        assert madre_convertida == 1, "El producto elegido como madre no quedo marcado es_madre=1"

        print("--- Confirmar el ingreso normalmente (las acciones rapidas no deben romper el flujo) ---")
        page.locator("#cv2-rev-btn-confirmar").click()
        page.wait_for_timeout(700)

        compra_ok = page.evaluate("""
          () => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM compras`)[0].n
        """)
        assert compra_ok >= 1, "La compra no quedo confirmada tras usar las acciones rapidas"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - 'Asociar sustituto' y 'Asignar madre' funcionan desde Compras-Revision y no rompen el commit.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
