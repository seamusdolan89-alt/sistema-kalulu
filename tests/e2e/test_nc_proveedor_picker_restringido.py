"""
tests/e2e/test_nc_proveedor_picker_restringido.py — Nota de crédito de proveedor:
con una factura de referencia elegida, el picker de productos deja de ser el
buscador libre y se acota a lo que ESA factura tiene cargado.

Por qué: sin este límite, se podía armar una NC "aplicada a la factura X" que
devolvía un producto que la factura X ni siquiera tenía, o una cantidad mayor a
la comprada — el saldo de esa factura quedaba mal sin ningún aviso. La
restricción vive en `js/modules/nota_credito_wizard.js`
(`cargarProductosDeCompra`/`actualizarModoProductos`/`lineasProdActivas`).
`test_nc_proveedor.py` ya cubre el caso feliz de una sola línea precargada y
tildada; este archivo cubre los bordes: acotar por línea la cantidad máxima,
excluir líneas destildadas del guardado, y que cambiar o quitar la referencia
recargue (o libere) la lista en lugar de acumularla.

Cubre (Admin-POS):
  1. Con una factura de 2 productos como referencia: las 2 líneas vienen
     precargadas y destildadas, el buscador libre está oculto.
  2. Escribir una cantidad mayor a la comprada la recorta al máximo y avisa.
  3. Tildar una sola línea y guardar: solo esa entra a la NC (mueve stock),
     la destildada ni se guarda ni mueve stock.
  4. Tildar una línea y llevarla a 0: guardar la bloquea (mismo mensaje que
     el picker libre).
  5. Cambiar la referencia a OTRA factura recarga la lista (no la acumula).
  6. Volver a "— Sin referencia —" limpia la lista y muestra el buscador libre.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_nc_proveedor_picker_restringido.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, assert_stock_integro

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id FROM proveedores ORDER BY razon_social LIMIT 1`)[0];
  const coca = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre='Coca-Cola 2L'`)[0];
  const deter = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre='Detergente 500ml'`)[0];

  // Factura 1: dos productos (para probar el picker con mas de una linea).
  window.SGA_DB.run(
    `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
       total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
     VALUES ('c-pick-1', '1', ?, ?, '2026-09-01T10:00:00.000Z', '2001', '0001', 1150, 1150, 'pendiente', 'Factura A',
             'confirmada', 'pending', ?)`, [prov.id, usuarioId, now]);
  window.SGA_DB.run(
    `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal, unidades_por_paquete, tipo)
     VALUES ('c-pick-1-a', 'c-pick-1', ?, 10, 100, 1000, 1, 'producto')`, [coca.id]);
  window.SGA_DB.run(
    `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal, unidades_por_paquete, tipo)
     VALUES ('c-pick-1-b', 'c-pick-1', ?, 5, 30, 150, 1, 'producto')`, [deter.id]);

  // Factura 2: un solo producto (para probar que cambiar la referencia recarga, no acumula).
  window.SGA_DB.run(
    `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
       total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
     VALUES ('c-pick-2', '1', ?, ?, '2026-09-05T10:00:00.000Z', '2002', '0001', 200, 200, 'pendiente', 'Factura A',
             'confirmada', 'pending', ?)`, [prov.id, usuarioId, now]);
  window.SGA_DB.run(
    `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal, unidades_por_paquete, tipo)
     VALUES ('c-pick-2-a', 'c-pick-2', ?, 8, 25, 200, 1, 'producto')`, [deter.id]);

  return { provId: prov.id, cocaId: coca.id, deterId: deter.id };
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def stock_de(page, prod_id):
    r = q(page, "SELECT cantidad FROM stock WHERE producto_id=?", [prod_id])
    return r[0]["cantidad"] if r else None


def abrir_wizard(page, info):
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(200)
    page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
    page.wait_for_timeout(500)
    page.locator(f'.btn-ver-detalle[data-id="{info["provId"]}"]').click()
    page.wait_for_timeout(300)
    page.locator("#btn-ledger-agrupado").click()
    page.wait_for_timeout(200)
    page.locator("#btn-registrar-nc").click()
    page.wait_for_timeout(300)
    assert page.locator("#ncw-modal").is_visible(), "No abrió el formulario de NC"


def filas(page):
    return page.locator('#ncw-prod-wrap tr[data-i]')


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed: 2 productos, factura 1 (2 items) y factura 2 (1 item) ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        info = page.evaluate(SEMBRAR)
        stock_coca_inicial = stock_de(page, info["cocaId"])
        stock_deter_inicial = stock_de(page, info["deterId"])

        # 1) referencia con 2 productos ------------------------------------------
        print("--- 1) Factura de referencia con 2 productos: 2 líneas precargadas, buscador oculto ---")
        abrir_wizard(page, info)
        page.select_option("#ncw-ref", value="c-pick-1")
        page.wait_for_timeout(200)
        assert not page.locator("#ncw-buscador-wrap").is_visible(), "El buscador libre debería ocultarse"
        assert filas(page).count() == 2, f"Debería precargar 2 líneas: {filas(page).count()}"
        texto = " ".join(filas(page).all_inner_texts())
        assert "Coca-Cola 2L" in texto and "Detergente 500ml" in texto, f"Faltó algún producto: {texto!r}"
        for i in range(2):
            assert not filas(page).nth(i).locator('input[data-f="checked"]').is_checked(), \
                f"La línea {i} no debería venir tildada por default"

        # 2) tope de cantidad -----------------------------------------------------
        print("--- 2) Escribir más de lo comprado (Detergente: máx. 5) lo recorta y avisa ---")
        fila_deter = filas(page).filter(has_text="Detergente 500ml")
        fila_deter.locator('input[data-f="cantidad"]').fill("9")
        page.wait_for_timeout(150)
        assert fila_deter.locator('input[data-f="cantidad"]').input_value() == "5", \
            "La cantidad tenía que recortarse al máximo comprado (5)"
        assert page.locator("#ncw-error").is_visible() and "máximo 5" in page.locator("#ncw-error").inner_text(), \
            "Debería avisar que no se puede devolver más de lo comprado"

        # 3) solo la línea tildada entra a la NC (mueve stock) --------------------
        print("--- 3) Tildar solo Coca-Cola: solo esa línea se guarda y mueve stock ---")
        fila_coca = filas(page).filter(has_text="Coca-Cola 2L")
        fila_coca.locator('input[data-f="checked"]').check()
        fila_coca.locator('input[data-f="cantidad"]').fill("3")
        page.fill("#ncw-numero", "0001-00200")
        page.wait_for_timeout(200)
        page.locator("#ncw-guardar").click()
        page.wait_for_timeout(500)
        assert not page.locator("#ncw-modal").count(), "El formulario no se cerró al guardar"

        nc = q(page, "SELECT id FROM pagos_proveedores WHERE numero_comprobante='0001-00200'")
        assert len(nc) == 1, f"Esperaba 1 NC guardada: {nc}"
        items = q(page, "SELECT producto_id, cantidad FROM pagos_proveedores_items WHERE pago_id=?", [nc[0]["id"]])
        assert len(items) == 1 and items[0]["producto_id"] == info["cocaId"] and items[0]["cantidad"] == 3, (
            f"Solo la línea tildada (Coca-Cola x3) debía guardarse: {items}")
        assert stock_de(page, info["cocaId"]) == stock_coca_inicial - 3, "El stock de Coca-Cola no bajó lo esperado"
        assert stock_de(page, info["deterId"]) == stock_deter_inicial, (
            "El Detergente no estaba tildado: su stock NO debía moverse")
        assert_stock_integro(page, "tras guardar la NC con una sola línea tildada")

        # 4) tildar y dejar en 0 bloquea el guardado -------------------------------
        print("--- 4) Tildar una línea y ponerla en 0: el guardado se bloquea ---")
        abrir_wizard(page, info)
        page.select_option("#ncw-ref", value="c-pick-1")
        page.wait_for_timeout(200)
        # Coca-Cola aporta importe (para no caer antes en "sin importe") mientras
        # Detergente, también tildado pero en 0, es el que tiene que bloquear.
        fila_coca = filas(page).filter(has_text="Coca-Cola 2L")
        fila_coca.locator('input[data-f="checked"]').check()
        fila_coca.locator('input[data-f="cantidad"]').fill("2")
        fila_deter = filas(page).filter(has_text="Detergente 500ml")
        fila_deter.locator('input[data-f="checked"]').check()
        fila_deter.locator('input[data-f="cantidad"]').fill("0")
        page.fill("#ncw-numero", "0001-00201")
        page.wait_for_timeout(150)
        page.locator("#ncw-guardar").click()
        page.wait_for_timeout(300)
        assert page.locator("#ncw-modal").is_visible(), "No debería haberse guardado con cantidad 0"
        assert "cantidad 0" in page.locator("#ncw-error").inner_text(), "Debería avisar cantidad 0"
        page.locator("#ncw-cancel").click()
        page.wait_for_timeout(200)

        # 5) cambiar de referencia recarga, no acumula -----------------------------
        print("--- 5) Cambiar la referencia a la factura 2 recarga la lista (no la acumula) ---")
        abrir_wizard(page, info)
        page.select_option("#ncw-ref", value="c-pick-1")
        page.wait_for_timeout(200)
        assert filas(page).count() == 2, "Factura 1 debería mostrar 2 líneas"
        page.select_option("#ncw-ref", value="c-pick-2")
        page.wait_for_timeout(200)
        assert filas(page).count() == 1, f"Factura 2 debería reemplazar por 1 sola línea: {filas(page).count()}"
        assert "Detergente 500ml" in filas(page).inner_text() and "Coca-Cola" not in filas(page).inner_text(), (
            "La lista de la factura 1 no debería seguir mezclada con la de la factura 2")
        assert filas(page).locator('input[data-f="cantidad"]').input_value() == "8", "Cantidad de la factura 2 (8)"
        assert filas(page).locator('input[data-f="costo"]').input_value() == "25", "Costo de la factura 2 (25)"

        # 6) volver a "sin referencia" libera el picker ----------------------------
        print("--- 6) Volver a 'Sin referencia' limpia la lista y muestra el buscador libre ---")
        page.select_option("#ncw-ref", value="")
        page.wait_for_timeout(200)
        assert page.locator("#ncw-buscador-wrap").is_visible(), "El buscador libre debería reaparecer sin referencia"
        assert filas(page).count() == 0, "La lista acotada no debería sobrevivir a soltar la referencia"
        assert "Sin productos" in page.locator("#ncw-prod-wrap").inner_text()
        page.locator("#ncw-cancel").click()
        page.wait_for_timeout(200)

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - NC de proveedor: picker de productos acotado a la factura de referencia")
        browser.close()


if __name__ == "__main__":
    main()
