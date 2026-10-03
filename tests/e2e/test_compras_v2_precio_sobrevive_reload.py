"""
tests/e2e/test_compras_v2_precio_sobrevive_reload.py — Pedido explícito del
usuario (3/10/2026): antes de mirar sincronización entre dispositivos, probar
que el cambio de costo/precio hecho en el proceso de compra REALMENTE queda
grabado en disco (OPFS) en la MISMA máquina que carga la compra — sin
sincronizar nada, sin un segundo dispositivo.

`db().run()` dispara el guardado a OPFS "fire and forget" (sin esperarlo,
ver comentario de saveDatabase()/flush() en js/db.js) -- window.SGA_DB.query()
justo después de un UPDATE podría mostrar el valor correcto leyendo de la
base en MEMORIA aunque el guardado a disco hubiera fallado en silencio. La
única forma real de probar que algo quedó persistido de verdad es recargar
la página (fuerza a SGA_DB.initialize() a releer el archivo de OPFS desde
cero) y volver a consultar.

Cubre: compra con cambio de costo (commitCompra), confirmar el precio
sugerido en la pantalla de ajuste (doSaveRow) -- y recién DESPUÉS de un
page.reload() completo, confirmar que costo, costo_paquete y precio_venta
siguen siendo los nuevos. Un solo dispositivo en todo el test.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_precio_sobrevive_reload.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1900, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed: producto 'Cebolla Reload' (unidad de compra = unidad de venta) ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, stock_minimo, unidad_medida,
                 unidad_compra, unidades_por_paquete_compra, unidad_venta,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-reload-cebolla', 'Cebolla Reload', 3490, 3490, 5584, 1, 'unidad',
                 'Unidad', 1, 'Unidad', 0, 0, 1, ?, ?, 'synced', ?)`, [now, now, now]
            );
          }
        """)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Compra Ticket: baja el costo de Cebolla de 3490 a 2990 ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.fill("#cv2-total-factura", "2810.60")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        page.locator("#cv2-search").click()
        page.keyboard.type("Cebolla Reload", delay=15)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Cebolla Reload").click()
        page.wait_for_timeout(400)

        row = "tr[data-idx='0']"
        page.fill(f"{row} input[data-field='cantidad']", "0.94")
        page.fill(f"{row} input[data-field='costoNuevo']", "2990")
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(300)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.get_by_text("Confirmar Ingreso", exact=False).click()
        page.wait_for_timeout(700)

        print("--- Ajuste de precio: aceptar el precio sugerido (4780) con 'Actualizar' ---")
        fila = page.locator("#cv2-post-tbody tr[data-idx='0']")
        sugerido = fila.locator(".cv2-post-precio-input").input_value()
        print(f"   Precio sugerido mostrado en pantalla: {sugerido}")
        fila.locator(".cv2-post-actualizar-btn").click()
        page.wait_for_timeout(400)

        print("--- Verificación INMEDIATA (podría mentir: lee de la base en memoria) ---")
        antes_reload = q(page, "SELECT costo, costo_paquete, precio_venta FROM productos WHERE id='prod-reload-cebolla'")[0]
        print(f"   {antes_reload}")
        assert antes_reload["costo"] == 2990 and antes_reload["costo_paquete"] == 2990 and antes_reload["precio_venta"] == 4780, (
            f"Ya en memoria está mal -- ni siquiera llegó a escribirse bien: {antes_reload}"
        )

        print("--- RECARGAR LA PÁGINA (fuerza a releer el archivo real de OPFS desde cero) ---")
        page.evaluate("async () => { if (window.SGA_DB.flush) await window.SGA_DB.flush(); }")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Verificación REAL, después del reload (esto prueba que quedó en disco) ---")
        despues_reload = q(page, "SELECT costo, costo_paquete, precio_venta FROM productos WHERE id='prod-reload-cebolla'")[0]
        print(f"   {despues_reload}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "precio_sobrevive_reload.png"), full_page=True)

        assert despues_reload["costo"] == 2990, (
            f"BUG LOCAL (sin sync de por medio): el costo no sobrevivió al reload: {despues_reload}"
        )
        assert despues_reload["costo_paquete"] == 2990, (
            f"BUG LOCAL: costo_paquete no sobrevivió al reload: {despues_reload}"
        )
        assert despues_reload["precio_venta"] == 4780, (
            f"BUG LOCAL: el precio actualizado en el proceso de compra NO sobrevivió al reload -- "
            f"esto pasaría en la MISMA máquina, sin sincronizar con nada: {despues_reload}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_v2_precio_sobrevive_reload: PASA (costo, costo_paquete y precio_venta "
              "quedan grabados de verdad en disco, en la misma máquina, sin sincronizar nada)")


if __name__ == "__main__":
    main()
