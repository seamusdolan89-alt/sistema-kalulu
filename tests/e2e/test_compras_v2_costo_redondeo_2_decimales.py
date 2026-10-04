"""
tests/e2e/test_compras_v2_costo_redondeo_2_decimales.py — Pedido explícito del
usuario (4/10/2026): tras encontrar costos en producción con ruido de punto
flotante (ej. $663,629 o $2954,7769999999996), ningún costo/costo_paquete
calculado (costoNuevo * (1 - descuento/100), costo * unidades_por_paquete)
debe guardarse con más de 2 decimales. window.SGA_Utils.roundMoney() se
agregó para esto y se aplicó en costoNetoUsado() y los dos sitios que
escriben productos.costo_paquete en compras_v2.js.

Repro: producto con unidades_por_paquete_compra=3 (fraccionario, no divide
exacto), costoNuevo=99.90 y descuento=15% -- sin redondear, costo neto da
84.915 (3 decimales) y costo_paquete da 254.745 (3 decimales). Con el fix,
ambos quedan en 2 decimales exactos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_costo_redondeo_2_decimales.py
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


def tiene_mas_de_2_decimales(valor):
    redondeado = round(valor * 100) / 100
    return abs(valor - redondeado) > 1e-9


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

        print("--- Login admin-pos + seed: producto con unidades_por_paquete_compra=3 (fraccionario) ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, stock_minimo, unidad_medida,
                 unidad_compra, unidades_por_paquete_compra, unidad_venta,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-redondeo-test', 'Producto Redondeo Test', 50, 150, 90, 1, 'unidad',
                 'Pack x3', 3, 'Unidad', 0, 0, 1, ?, ?, 'synced', ?)`, [now, now, now]
            );
          }
        """)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Compra Ticket: costoNuevo=99.90, descuento=15% (sin redondear da 84.915) ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.fill("#cv2-total-factura", "72.18")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        page.locator("#cv2-search").click()
        page.keyboard.type("Producto Redondeo Test", delay=15)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Producto Redondeo Test").click()
        page.wait_for_timeout(400)

        row = "tr[data-idx='0']"
        page.fill(f"{row} input[data-field='cantidad']", "1")
        page.fill(f"{row} input[data-field='costoNuevo']", "99.90")
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(200)
        page.fill(f"{row} input[data-field='descuento']", "15")
        page.locator(f"{row} input[data-field='descuento']").blur()
        page.wait_for_timeout(300)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.get_by_text("Confirmar Ingreso", exact=False).click()
        page.wait_for_timeout(700)

        print("--- Verificar costo y costo_paquete en productos (deben tener <= 2 decimales) ---")
        prod = q(page, "SELECT costo, costo_paquete FROM productos WHERE id='prod-redondeo-test'")[0]
        print(f"   productos: {prod}")
        assert prod["costo"] == 84.92 or prod["costo"] == 84.91, (
            f"costo inesperado (se esperaba ~84.915 redondeado a 2 decimales): {prod['costo']}"
        )
        assert not tiene_mas_de_2_decimales(prod["costo"]), (
            f"BUG: productos.costo quedó con más de 2 decimales: {prod['costo']}"
        )
        assert not tiene_mas_de_2_decimales(prod["costo_paquete"]), (
            f"BUG: productos.costo_paquete quedó con más de 2 decimales: {prod['costo_paquete']}"
        )
        # costo_paquete = costo (ya redondeado) * 3 -- también debe ser limpio
        esperado_paquete = round(prod["costo"] * 3 * 100) / 100
        assert abs(prod["costo_paquete"] - esperado_paquete) < 0.01, (
            f"costo_paquete no es costo*uppc: {prod}"
        )

        item = q(page, """
          SELECT ci.costo_unitario, ci.costo_anterior FROM compra_items ci
          JOIN compras c ON c.id = ci.compra_id
          WHERE ci.producto_id='prod-redondeo-test' ORDER BY c.fecha DESC LIMIT 1
        """)[0]
        print(f"   compra_items: {item}")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_v2_costo_redondeo_2_decimales: PASA "
              "(costo y costo_paquete calculados quedan con 2 decimales, sin ruido de punto flotante)")


if __name__ == "__main__":
    main()
