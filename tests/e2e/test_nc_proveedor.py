"""
tests/e2e/test_nc_proveedor.py — Nota de crédito de proveedor (devolución /
descuento) que se comporta como un pago: crédito libre, aplicable a una factura.

Pedido del usuario: cuando el proveedor emite una NC (devolución de mercadería,
descuento...), registrarla para que la cuenta corriente quede bien tanto
cronológica como por factura, y poder usarla para saldar una factura puntual
(sino queda una factura pendiente y una NC sin aplicar a la vez).

Modelo: la NC es un pago de método 'nota_credito' (+ sus líneas), así el saldo,
el crédito disponible, "Imputar…" y el ledger la entienden sin cambios. NO toca
costos ni precios de ningún producto.

Cubre (Admin-POS):
  1. Formulario desde Cuentas Corrientes: NC A con un producto devuelto (baja
     stock) y un concepto de descuento; el IVA sale de las líneas y el total
     también; aplicada a la factura de referencia.
  2. Saldo, stock, ledger cronológico (insignia NC) y por factura (la NC bajo la
     factura); los costos NO cambian.
  3. Total editable a mano (para igualar el comprobante real) y NC libre que
     queda en "Pagos y notas de crédito sin imputar".
  4. Desde el Historial de compras: botón "NC" con proveedor y factura ya elegidos.
  5. Anular la NC: repone el stock, libera la factura y no deja nada.
  6. No se puede anular una compra que tiene una NC asociada.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_nc_proveedor.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, assert_stock_integro

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id, razon_social FROM proveedores ORDER BY razon_social LIMIT 1`)[0];
  const prod = window.SGA_DB.query(`SELECT id, costo, precio_venta FROM productos WHERE nombre='Coca-Cola 2L'`)[0];
  window.SGA_DB.run(
    `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
       total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
     VALUES ('c-nc-1', '1', ?, ?, '2026-09-01T10:00:00.000Z', '1001', '0001', 1210, 1210, 'pendiente', 'Factura A',
             'confirmada', 'pending', ?)`, [prov.id, usuarioId, now]);
  window.SGA_DB.run(
    `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal, unidades_por_paquete, tipo)
     VALUES ('c-nc-1-i', 'c-nc-1', ?, 10, 100, 1000, 1, 'producto')`, [prod.id]);
  return { provId: prov.id, provNombre: prov.razon_social, prodId: prod.id, costo: prod.costo, precio: prod.precio_venta };
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def saldo(page, info):
    return round(page.evaluate("(id) => window.SGA_PagosProveedores.getSaldoProveedor(id)", info["provId"]), 2)


def stock(page, info):
    return q(page, "SELECT cantidad FROM stock WHERE producto_id=?", [info["prodId"]])[0]["cantidad"]


def abrir_detalle(page, info, modo):
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(200)
    page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
    page.wait_for_timeout(500)
    page.locator(f'.btn-ver-detalle[data-id="{info["provId"]}"]').click()
    page.wait_for_timeout(300)
    page.locator("#btn-ledger-plano" if modo == "plano" else "#btn-ledger-agrupado").click()
    page.wait_for_timeout(200)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed + una factura A de $1210 (Coca-Cola 2L, stock 20) ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        info = page.evaluate(SEMBRAR)
        assert saldo(page, info) == 1210 and stock(page, info) == 20

        # 1) NC desde Cuentas Corrientes ---------------------------------------
        print("--- 1) Registrar NC A: 4 unidades devueltas a $100 + bonificación de $100 (IVA 21%) ---")
        abrir_detalle(page, info, "agrupado")
        page.locator("#btn-registrar-nc").click()
        page.wait_for_timeout(400)
        assert page.locator("#ncw-modal").is_visible(), "No abrió el formulario de NC"
        assert page.locator("#ncw-proveedor").input_value() == info["provId"], "El proveedor no vino elegido"

        page.select_option("#ncw-ref", value="c-nc-1")
        page.wait_for_timeout(200)
        assert page.locator("#ncw-letra").input_value() == "A", "La letra no salió de la factura de referencia (Factura A)"
        aplicar = page.locator('input[name="ncw-aplicar"]:checked').get_attribute("value")
        assert aplicar == "ref", f"Con factura de referencia debería venir 'aplicar a la factura': {aplicar}"
        page.fill("#ncw-numero", "0001-00099")

        page.fill("#ncw-buscar", "Coca-Cola")
        page.wait_for_timeout(300)
        page.locator(".ncw-dd .sri").first.click()
        page.wait_for_timeout(200)
        page.fill('#ncw-prod-wrap input[data-f="cantidad"]', "4")
        page.fill('#ncw-prod-wrap input[data-f="costo"]', "100")
        page.select_option('#ncw-prod-wrap select[data-f="iva"]', "21")
        page.locator("#ncw-add-conc").click()
        page.wait_for_timeout(100)
        page.fill('#ncw-conc-wrap input[data-f="concepto"]', "Bonificación")
        page.fill('#ncw-conc-wrap input[data-f="monto"]', "100")
        page.select_option('#ncw-conc-wrap select[data-f="iva"]', "21")
        page.wait_for_timeout(200)

        assert page.locator("#ncw-neto").input_value() == "500", f"Subtotal neto: {page.locator('#ncw-neto').input_value()}"
        assert page.locator("#ncw-iva21").input_value() == "105", f"IVA 21% calculado: {page.locator('#ncw-iva21').input_value()}"
        assert page.locator("#ncw-total").input_value() == "605", f"Total: {page.locator('#ncw-total').input_value()}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "nc_formulario.png"))
        page.locator("#ncw-guardar").click()
        page.wait_for_timeout(500)
        assert not page.locator("#ncw-modal").count(), "El formulario no se cerró al guardar"

        nc = q(page, "SELECT id, tipo, numero_comprobante, condicion_nc, compra_origen_id, subtotal_neto, iva_21 FROM pagos_proveedores WHERE tipo='nota_credito'")
        assert len(nc) == 1, f"Esperaba 1 NC, hay {len(nc)}"
        nc = nc[0]
        print(f"NC: {nc}")
        assert nc["numero_comprobante"] == "0001-00099" and nc["condicion_nc"] == "A" and nc["compra_origen_id"] == "c-nc-1"
        assert nc["subtotal_neto"] == 500 and nc["iva_21"] == 105
        met = q(page, "SELECT metodo, monto, referencia FROM pagos_proveedores_metodos WHERE pago_id=?", [nc["id"]])
        assert met == [{"metodo": "nota_credito", "monto": 605, "referencia": "0001-00099"}], f"Medio de la NC: {met}"
        assert len(q(page, "SELECT id FROM pagos_proveedores_items WHERE pago_id=?", [nc["id"]])) == 2
        imp = q(page, "SELECT compra_id, monto_imputado FROM imputaciones_pagos WHERE pago_id=?", [nc["id"]])
        assert imp == [{"compra_id": "c-nc-1", "monto_imputado": 605}], f"La NC no se aplicó a la factura: {imp}"

        assert stock(page, info) == 16, f"La devolución tenía que bajar el stock a 16: {stock(page, info)}"
        assert_stock_integro(page, "tras registrar una NC")
        prod = q(page, "SELECT costo, precio_venta FROM productos WHERE id=?", [info["prodId"]])[0]
        assert prod["costo"] == info["costo"] and prod["precio_venta"] == info["precio"], f"BUG: la NC tocó costo/precio: {prod}"
        assert saldo(page, info) == 605, f"Saldo tras la NC (1210 - 605): {saldo(page, info)}"

        # 2) ledger ---------------------------------------------------------------
        print("--- 2) Ledger por factura y cronológico ---")
        abrir_detalle(page, info, "agrupado")
        tabla = page.locator("#ccprov-ledger-wrap").inner_text()
        assert "Nota de crédito (0001-00099)" in tabla, f"La NC no aparece bajo la factura: {tabla[:300]!r}"
        assert page.locator(".ledger-row-imp .ledger-type-nc").count() == 1, "Falta la insignia NC bajo la factura"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "nc_ledger_por_factura.png"))
        page.locator("#btn-ledger-plano").click()
        page.wait_for_timeout(200)
        fila = page.locator("#ccprov-ledger-wrap tr.ledger-row-nc")
        assert fila.count() == 1, "No hay fila NC en el ledger cronológico"
        assert "NC A 0001-00099" in fila.inner_text() and "605" in fila.inner_text(), f"Fila NC: {fila.inner_text()!r}"

        # 3) total editable + NC libre --------------------------------------------
        print("--- 3) NC libre por un total escrito a mano ---")
        page.locator("#btn-registrar-nc").click()
        page.wait_for_timeout(300)
        assert page.locator('input[name="ncw-aplicar"]:checked').get_attribute("value") == "libre", "Sin referencia debería venir 'crédito libre'"
        page.fill("#ncw-total", "50")
        page.fill("#ncw-numero", "0001-00100")
        page.locator("#ncw-guardar").click()
        page.wait_for_timeout(400)
        libre = q(page, "SELECT p.id FROM pagos_proveedores p WHERE p.numero_comprobante='0001-00100'")
        assert len(libre) == 1, "No se guardó la NC libre"
        assert q(page, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE pago_id=?", [libre[0]["id"]])[0]["n"] == 0, "Una NC libre no debe imputarse"
        assert saldo(page, info) == 555, f"Saldo tras la NC libre (605 - 50): {saldo(page, info)}"
        abrir_detalle(page, info, "agrupado")
        assert page.locator(".ledger-orphan-section .ledger-type-nc").count() == 1, "La NC libre no aparece en 'sin imputar'"
        assert page.locator(".ledger-orphan-section .ledger-btn-imputar").count() == 1, "Falta 'Imputar…' en la NC libre"

        # 4) desde el Historial de compras ---------------------------------------
        print("--- 4) Historial de compras: botón NC con la factura ya elegida ---")
        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_timeout(500)
        page.locator('[data-action="historial_compras"]').click()
        page.wait_for_timeout(400)
        btn = page.locator('[data-nc-compra="c-nc-1"]')
        assert btn.count() == 1, "Falta el botón NC en la fila de la compra"
        btn.click()
        page.wait_for_timeout(400)
        assert page.locator("#ncw-proveedor").input_value() == info["provId"], "Desde Historial el proveedor no vino elegido"
        assert page.locator("#ncw-ref").input_value() == "c-nc-1", "Desde Historial la factura no vino elegida"
        page.locator("#ncw-cancel").click()
        page.wait_for_timeout(200)

        # 5) no se puede anular la compra con NC asociada --------------------------
        print("--- 5) Anular la compra con una NC asociada: bloqueado ---")
        page.evaluate("async () => { window.__ops = (await import('/js/modules/operaciones_stock.js')).default; }")
        bloq = page.evaluate("() => window.__ops.anularCompra('c-nc-1', 'prueba')")
        assert not bloq["success"] and "nota" in bloq["error"].lower(), f"Debía bloquear por la NC asociada: {bloq}"

        # 6) anular la NC -----------------------------------------------------------
        print("--- 6) Anular la NC: repone stock, libera la factura y no deja nada ---")
        abrir_detalle(page, info, "plano")
        page.locator(f'[data-anular-pago="{nc["id"]}"]').click()
        page.wait_for_timeout(300)
        modal = page.locator("#ccprov-overlay").inner_text()
        print(f"Modal: {modal[:400]!r}")
        assert "nota de crédito" in modal.lower() and "se repone el stock" in modal.lower() and "Coca-Cola 2L (+4)" in modal, (
            "El modal de anular NC no explica la reposición de stock")
        assert "vuelven a quedar pendientes" in modal, "El modal no avisa que la factura queda pendiente"
        page.locator("#btn-anular-ok").click()
        page.wait_for_timeout(500)
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [nc["id"]])[0]["n"] == 0, "La NC sigue existiendo"
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores_items WHERE pago_id=?", [nc["id"]])[0]["n"] == 0, "Quedaron líneas huérfanas"
        assert stock(page, info) == 20, f"El stock no volvió a 20: {stock(page, info)}"
        assert_stock_integro(page, "tras anular una NC")
        assert saldo(page, info) == 1160, f"Saldo tras anular la NC de $605 (queda la libre de $50): {saldo(page, info)}"
        movs = [m["tipo"] for m in q(page, "SELECT tipo FROM stock_movimientos WHERE ref_id=? ORDER BY fecha", [nc["id"]])]
        assert movs == ["nc_devolucion", "nc_anulacion"], f"Movimientos de la NC: {movs}"

        # ya sin NC referenciada, la compra se puede anular
        libre_ok = page.evaluate("() => window.__ops.getResumenAnulacionCompra('c-nc-1')")
        assert libre_ok["success"] and not libre_ok["bloqueos"], f"Sin la NC ya no debería bloquear: {libre_ok.get('bloqueos')}"

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - NC de proveedor: formulario, IVA/total, aplicación a factura, ledger, historial y anulación.")
        browser.close()


if __name__ == "__main__":
    main()
