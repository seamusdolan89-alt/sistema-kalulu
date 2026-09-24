"""
tests/e2e/test_compras_vincular_remito_agregar_items.py — Al vincular una factura a
un remito se pueden sumar productos que la factura trae de más, y un envío /
descuento — pedido del usuario (24/9/2026).

Antes, al vincular, la barra de búsqueda entera (buscador + "+ Envío" + "+ Descuento"
+ "+ Muestra") se ocultaba, y las cantidades quedaban bloqueadas "porque vienen del
remito". Pero una factura real puede traer un producto que no estaba en el remito, o
sumar un envío / descuento, y no había forma de cargarlo.

El punto delicado es el STOCK: el remito ya sumó el stock de SUS productos al cargarse,
así que al confirmar la factura se saltea para esos (commitCompra: `if (!vinculando)`).
Ese salto era GLOBAL — si se permitía agregar un producto nuevo, su stock nunca se
habría sumado. Ahora cada ítem lleva `deRemito` y solo se saltea el stock de los que
realmente vinieron del remito; lo agregado al vincular sí suma. Los ítems del remito
siguen con la cantidad bloqueada; los agregados se editan y se quitan como siempre.

Cubre: la barra de búsqueda y los botones de envío/descuento se ven al vincular; la línea
del remito queda bloqueada (cantidad readonly, sin ×) y la agregada no; un producto que
ya viene en el remito NO se fusiona con esa línea (va aparte, con aviso); un envío suma;
y al confirmar el stock de lo del remito NO cambia, el del producto agregado sube, el
remito queda facturado y la integridad del stock (ledger) sigue en [].

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_vincular_remito_agregar_items.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def stock_de(page, prod_id):
    return page.evaluate(
        "(id) => (window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id = ? AND sucursal_id = '1'`, [id])[0] || {cantidad: null}).cantidad",
        prod_id,
    )


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=False)
        page.wait_for_function("() => window.SGA_Auth && window.SGA_DB && window.SGA_Auth.getCurrentUser()")
        page.wait_for_timeout(300)

        print("--- Login POS + remito pendiente con UN producto (P1 x7); P2 no viene en el remito ---")
        remito_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;
            window.SGA_DB.run(
              `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_compra, activo)
               VALUES ('prov-rem-add', 'Proveedor Remito Agregar Test', 'Responsable Inscripto', 'Factura B', 1)`
            );
            for (const [id, nombre, costo] of [['p-rem-ok', 'Producto Remito Ok Test', 60], ['p-rem-extra', 'Producto Extra Factura Test', 100]]) {
              window.SGA_DB.run(
                `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                   es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                 VALUES (?, ?, ?, 150, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
                [id, nombre, costo, now, now, now]
              );
            }
            // El remito ya sumo el stock de P1 al cargarse (7). P2 no tiene stock todavia.
            window.SGA_DB.moverStock({ productoId: 'p-rem-ok', sucursalId: '1', delta: 7, tipo: 'compra',
                                       refTipo: 'remitos', refId: 'remito-rem-add', fecha: now });
            window.SGA_DB.run(
              `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
               VALUES ('remito-rem-add', '1', 'prov-rem-add', ?, ?, 'R-0002', 'pendiente', 'synced', ?)`,
              [usuarioId, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
               VALUES ('ri-rem-add', 'remito-rem-add', 'p-rem-ok', 7, 'Unidad', 1)`
            );
            return 'remito-rem-add';
          }
        """)
        assert stock_de(page, "p-rem-ok") == 7 and stock_de(page, "p-rem-extra") is None

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Vincular factura: cabecera con Total Factura, continuar al carrito ---")
        page.locator("#cv2-btn-remitos-pendientes").click()
        page.wait_for_timeout(300)
        page.locator(f"#cv2-remitos-list .cv2-btn-vincular[data-id='{remito_id}']").click()
        page.wait_for_timeout(400)
        page.fill("#cv2-total-factura", "770")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.locator("#cv2-btn-continuar").click()
        page.wait_for_timeout(400)

        print("--- La barra de busqueda y los botones de envio/descuento se ven al vincular ---")
        display_barra = page.evaluate("() => getComputedStyle(document.querySelector('.cv2-search-bar-row')).display")
        assert display_barra != "none", "BUG: al vincular la barra de busqueda sigue oculta, no se pueden agregar productos"
        assert page.locator("#cv2-btn-add-envio").is_visible() and page.locator("#cv2-btn-add-descuento").is_visible(), (
            "BUG: los botones + Envio / + Descuento no se ven al vincular"
        )
        print("   OK - buscador y botones visibles")

        print("--- La linea del remito sigue bloqueada (cantidad readonly, sin quitar) ---")
        fila_remito = "#cv2-cart-body tr[data-idx='0']"
        assert page.locator(f"{fila_remito} input[data-field='cantidad']").get_attribute("readonly") is not None, (
            "La cantidad del producto del remito deberia seguir bloqueada"
        )
        vis = page.locator(f"{fila_remito} .cv2-remove-btn").evaluate("el => getComputedStyle(el).visibility")
        assert vis == "hidden", f"El producto del remito no deberia poder quitarse (visibility={vis})"
        assert page.locator(f"{fila_remito} .cv2-agregado-badge").count() == 0
        print("   OK - la linea del remito esta bloqueada")

        print("--- Agregar un producto que NO venia en el remito: editable, quitable, marcado ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("Extra Factura", delay=25)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item", has_text="Producto Extra Factura Test").click()
        page.wait_for_timeout(300)
        fila_extra = "#cv2-cart-body tr[data-idx='1']"
        assert page.locator(f"{fila_extra} input[data-field='cantidad']").get_attribute("readonly") is None, (
            "BUG: la cantidad del producto agregado deberia poder editarse"
        )
        assert page.locator(f"{fila_extra} .cv2-agregado-badge").count() == 1, "Falta la marca '＋ Agregado'"
        vis2 = page.locator(f"{fila_extra} .cv2-remove-btn").evaluate("el => getComputedStyle(el).visibility")
        assert vis2 != "hidden", "El producto agregado tiene que poder quitarse"
        page.fill(f"{fila_extra} input[data-field='cantidad']", "3")
        page.fill(f"{fila_extra} input[data-field='costoNuevo']", "100")
        page.locator(f"{fila_extra} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(200)
        print("   OK - agregado editable, quitable y marcado")

        print("--- Agregar OTRA VEZ el producto del remito: NO se fusiona con la linea bloqueada ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("Remito Ok", delay=25)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item", has_text="Producto Remito Ok Test").click()
        page.wait_for_timeout(300)
        assert page.locator("#cv2-cart-body tr").count() == 3, (
            f"BUG: el producto ya presente en el remito se fusiono con su linea (filas: {page.locator('#cv2-cart-body tr').count()})"
        )
        assert page.locator(f"{fila_remito} input[data-field='cantidad']").input_value() == "7", (
            "La cantidad de la linea del remito no puede cambiar"
        )
        assert "ya viene en el remito" in page.locator("body").inner_text(), "Falta el aviso de linea aparte"
        page.locator("#cv2-cart-body tr[data-idx='2'] .cv2-remove-btn").click()
        page.wait_for_timeout(200)
        assert page.locator("#cv2-cart-body tr").count() == 2, "No se pudo quitar la linea extra"
        print("   OK - va en linea aparte, con aviso, y se puede quitar")

        print("--- Agregar un envio de $50 ---")
        page.locator("#cv2-btn-add-envio").click()
        page.wait_for_timeout(200)
        page.locator("#cv2-cart-body tr[data-idx='2'] input[data-field='monto']").fill("50")
        page.locator("#cv2-cart-body tr[data-idx='2'] input[data-field='monto']").blur()
        page.wait_for_timeout(200)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_vincular_agregar_items.png"), full_page=True)

        print("--- Confirmar la compra: Siguiente -> Revision -> Confirmar Ingreso ---")
        page.locator("#cv2-btn-confirmar").click()
        page.wait_for_timeout(500)
        page.locator("#cv2-rev-btn-confirmar").click()
        page.wait_for_timeout(1200)

        compra = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT c.id, c.total FROM compras c WHERE c.proveedor_id = 'prov-rem-add' ORDER BY c.fecha DESC LIMIT 1`)[0]
        """)
        assert compra, "No se creo la compra"
        items = page.evaluate(
            "(id) => window.SGA_DB.query(`SELECT producto_id, cantidad, tipo, subtotal FROM compra_items WHERE compra_id = ? ORDER BY tipo`, [id])",
            compra["id"],
        )
        print("   items de la compra:", items)
        assert len(items) == 3, f"Se esperaban 3 lineas (P1, P2, envio): {items}"
        assert abs(compra["total"] - 770) < 0.01, f"Total inesperado: {compra}"

        print("--- STOCK: el del remito NO se duplica, el del producto agregado SI se suma ---")
        s1, s2 = stock_de(page, "p-rem-ok"), stock_de(page, "p-rem-extra")
        assert s1 == 7, f"BUG: el stock del producto del remito cambio ({s1}) -- el remito ya lo habia sumado, no debe duplicarse"
        assert s2 == 3, f"BUG: el producto agregado al vincular no sumo stock (esperado 3, hay {s2})"
        print(f"   OK - P1 sigue en {s1}, P2 quedo en {s2}")

        remito = page.evaluate(
            "() => window.SGA_DB.query(`SELECT estado, compra_id, sync_status FROM remitos WHERE id = 'remito-rem-add'`)[0]"
        )
        assert remito["estado"] == "facturado" and remito["compra_id"] == compra["id"], f"Remito mal vinculado: {remito}"
        assert remito["sync_status"] == "pending", f"El remito facturado tiene que quedar pending para viajar: {remito}"

        integridad = page.evaluate("() => window.SGA_DB.verificarIntegridadStock()")
        assert integridad == [], f"El ledger de stock quedo inconsistente: {integridad}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_vincular_remito_agregar_items: PASA")


if __name__ == "__main__":
    main()
