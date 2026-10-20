"""
tests/e2e/test_compras_v2_asigna_proveedor_producto_existente.py — Pedido del
usuario (20/10/2026): el fix del 6/10 (producto nuevo desde el carrito asigna
proveedor_principal_id) solo cubría productos creados AL VUELO desde el
buscador de Compras. Encontró un caso real -- "Café Creme Original" comprado
a "Fumo Bravo" -- de un producto que ya EXISTÍA en el catálogo (dado de alta
suelto, desde Productos, sin proveedor) y que el buscador del carrito solo
encontró y agregó, sin pasar nunca por `submitNewProduct`.

Pedido: que CUALQUIER producto que entra al carrito de una compra, si no
tiene proveedor_principal_id asignado, se le asigne el de esa compra — no
solo a los creados nuevos. El fix vive en `commitCompra`/`commitCompraEdicion`
(al confirmar), no en cada punto de entrada al carrito (buscador, escaneo,
remito vinculado, muestra...) — así cubre los cuatro caminos por los que un
producto YA EXISTENTE puede terminar en `state.items` sin tener que repetir
la lógica en cada uno.

Cubre:
1. Producto SIN proveedor, agregado por búsqueda normal (no "crear nuevo"):
   al confirmar la compra, queda con el proveedor de esa compra.
2. Producto que YA tenía otro proveedor asignado: no se pisa.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_asigna_proveedor_producto_existente.py
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

        print("--- Login admin-pos + seed ---")
        login_via_seed(page, admin_pos=True)

        now = page.evaluate("new Date().toISOString()")
        info = page.evaluate(
            """(now) => {
              const otroProv = window.SGA_DB.query(
                `SELECT id FROM proveedores WHERE razon_social != 'Pepsico SA' LIMIT 1`
              )[0].id;
              const mk = (id, nombre, proveedorId) => window.SGA_DB.run(
                `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                   es_madre, precio_independiente, activo, proveedor_principal_id, sync_status, updated_at)
                 VALUES (?, ?, 50, 100, 1, 'unidad', 0, 0, 1, ?, 'synced', ?)`,
                [id, nombre, proveedorId, now]
              );
              mk('apex-sin-prov', 'APEX Cafe Sin Proveedor Test', null);
              mk('apex-con-prov', 'APEX Con Otro Proveedor Test', otroProv);
              return { otroProv };
            }""",
            now,
        )

        print("--- Compra Remito a Pepsico SA, agregando los dos productos por búsqueda ---")
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
        pepsico_id = q(page, "SELECT id FROM proveedores WHERE razon_social='Pepsico SA'")[0]["id"]
        assert pepsico_id != info["otroProv"], "El otro proveedor sembrado no puede ser Pepsico (invalida el test)"

        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.fill("#cv2-total-factura", "200")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        for nombre in ("APEX Cafe Sin Proveedor Test", "APEX Con Otro Proveedor Test"):
            page.locator("#cv2-search").click()
            page.keyboard.type(nombre, delay=20)
            page.wait_for_timeout(400)
            page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=nombre).click()
            page.wait_for_timeout(300)

        page.fill("tr[data-idx='0'] input[data-field='cantidad']", "1")
        page.fill("tr[data-idx='1'] input[data-field='cantidad']", "1")
        page.locator("tr[data-idx='1'] input[data-field='cantidad']").blur()
        page.wait_for_timeout(300)

        print("--- Confirmar la compra ---")
        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        page.get_by_text("Confirmar Ingreso", exact=False).click()
        page.wait_for_timeout(700)

        sin_prov = q(page, "SELECT proveedor_principal_id, sync_status FROM productos WHERE id='apex-sin-prov'")[0]
        con_prov = q(page, "SELECT proveedor_principal_id FROM productos WHERE id='apex-con-prov'")[0]

        print("--- El que no tenía proveedor ahora tiene el de esta compra (Pepsico) ---")
        assert sin_prov["proveedor_principal_id"] == pepsico_id, \
            f"Debería haber quedado con Pepsico ({pepsico_id}), quedó {sin_prov}"
        assert sin_prov["sync_status"] == "pending", "Tiene que quedar pending para viajar a la otra máquina"
        print("OK")

        print("--- El que ya tenía otro proveedor NO se pisa ---")
        assert con_prov["proveedor_principal_id"] == info["otroProv"], \
            f"No debería haberse tocado, quedó {con_prov} (era {info['otroProv']})"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: productos existentes sin proveedor lo reciben de la compra en curso; "
              "los que ya tenían uno no se pisan ===")
        browser.close()


if __name__ == "__main__":
    main()
