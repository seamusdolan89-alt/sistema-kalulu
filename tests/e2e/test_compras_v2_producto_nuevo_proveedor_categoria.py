"""
tests/e2e/test_compras_v2_producto_nuevo_proveedor_categoria.py — Pedido del
usuario (6/10/2026): varios productos quedaban sin proveedor asignado porque
se creaban al vuelo desde el carrito de Compras (código/nombre no encontrado
-> "+ Crear producto nuevo"), formulario que nunca pedía ni asignaba
proveedor_principal_id ni categoria_id.

Investigación de mercado (Square for Retail, Odoo) confirmó el patrón: el
proveedor se auto-asigna SOLO desde el proveedor de la compra en curso, sin
mostrar ningún campo nuevo (fricción cero); categoría SÍ se pide en el
formulario, porque a diferencia del proveedor no hay de dónde inferirla.
Confirmado con el dueño vía pregunta explícita (nunca/casi nunca carga un
producto de un proveedor distinto al de la factura en curso).

Cubre: elegir proveedor, buscar un nombre que no existe en el catálogo,
crear el producto nuevo (categoría ahora es obligatoria), verificar que
queda con proveedor_principal_id = el proveedor de la compra y con la
categoría elegida.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_producto_nuevo_proveedor_categoria.py
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

        print("--- Compra Remito: elegir Pepsico SA ---")
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
        page.fill("#cv2-total-factura", "500")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        prov_id = q(page, "SELECT id FROM proveedores WHERE razon_social='Pepsico SA'")[0]["id"]
        categoria = q(page, "SELECT id, nombre FROM categorias LIMIT 1")[0]

        print(f"--- Buscar un nombre que no existe y crear producto nuevo (categoría: {categoria['nombre']}) ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("Producto Totalmente Inexistente XYZ", delay=15)
        page.wait_for_timeout(400)
        page.locator('.cv2-dd-accion[data-action="nuevo"]').click()
        page.wait_for_timeout(300)

        page.fill("#cv2-np-nombre", "Producto Totalmente Inexistente XYZ")

        print("--- Sin elegir categoría, 'Crear y agregar' debe rechazar ---")
        page.fill("#cv2-np-costo", "100")
        page.locator("#cv2-np-crear").click()
        page.wait_for_timeout(200)
        existe_antes = q(page, "SELECT id FROM productos WHERE nombre='Producto Totalmente Inexistente XYZ'")
        assert len(existe_antes) == 0, "BUG: se creo el producto sin categoria"

        print("--- Elegir categoría y confirmar ---")
        page.select_option("#cv2-np-categoria", value=categoria["id"])
        page.locator("#cv2-np-crear").click()
        page.wait_for_timeout(400)

        prod = q(page, "SELECT categoria_id, proveedor_principal_id, costo FROM productos WHERE nombre='Producto Totalmente Inexistente XYZ'")
        print(f"   producto creado: {prod}")
        assert len(prod) == 1, f"El producto no se creo: {prod}"
        assert prod[0]["categoria_id"] == categoria["id"], f"Categoria incorrecta: {prod}"
        assert prod[0]["proveedor_principal_id"] == prov_id, (
            f"BUG: proveedor_principal_id no quedo asignado al proveedor de la compra en curso: {prod}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_v2_producto_nuevo_proveedor_categoria: PASA "
              "(proveedor se auto-asigna, categoria es obligatoria)")


if __name__ == "__main__":
    main()
