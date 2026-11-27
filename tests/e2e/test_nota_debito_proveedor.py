"""
tests/e2e/test_nota_debito_proveedor.py — Nota de débito de proveedor (solo Admin-POS).

Suma deuda con el proveedor; las líneas de producto pueden ingresar stock; los conceptos son solo
plata. Se paga como cualquier comprobante y se puede anular.

Cubre (UI real en Admin-POS + sync contra el POS):
 1. El POS no ofrece cargarla.
 2. Conceptos: suma deuda, no mueve stock, llega al POS con sus líneas.
 3. Con producto y letra A: IVA, sube el stock (o no, destildando), no toca costos; el stock llega al POS.
 4. Se paga desde el POS como un comprobante.
 5. Anular: baja la deuda, saca el stock, libera el pago, y el POS queda igual; no revive.
 6. Cerrar con datos pide confirmación; Gastos Generales no deja editarla.

Correr (server en :8765):  python tests/e2e/test_nota_debito_proveedor.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
SALDO = "(p) => window.SGA_PagosProveedores.getSaldoProveedor(p)"
IMPORTAR = "() => import('/js/modules/cuenta_corriente_proveedores.js').then(() => 1)"


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        prov = pos.q("SELECT id, razon_social FROM proveedores LIMIT 1")[0]
        prod = pos.q("SELECT s.producto_id AS id, p.nombre, p.costo, s.sucursal_id AS suc FROM stock s "
                     "JOIN productos p ON p.id = s.producto_id LIMIT 1")[0]
        pos.sincronizar()
        admin.sincronizar()
        admin.sincronizar()
        page = admin.page
        dialogos, aceptar = [], {"v": True}
        page.on("dialog", lambda d: (dialogos.append(d.message), d.accept() if aceptar["v"] else d.dismiss()))

        for d in (pos, admin):
            d.js(IMPORTAR)
        saldo0 = admin.js(SALDO, prov["id"])
        stock = lambda d: d.q("SELECT cantidad FROM stock WHERE producto_id = ? AND sucursal_id = ?",
                              [prod["id"], prod["suc"]])[0]["cantidad"]
        stock0 = stock(admin)
        nds = lambda d: d.q("SELECT * FROM gastos WHERE tipo = 'nota_debito' ORDER BY rowid")

        # 1. El POS no la ofrece
        pos.page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        pos.page.locator("#btn-nuevo-pago-general").wait_for()
        assert pos.page.locator("#btn-nueva-nd-general").count() == 0
        r = pos.js("(p) => window.SGA_PagosProveedores.crearNotaDebito({ proveedor_id: p, total: 5 })", prov["id"])
        assert not r["success"] and not nds(pos), r
        print("OK - el POS no la carga")

        # 2. Solo conceptos
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.locator("#btn-nueva-nd-general").click()
        modal = page.locator("#ncw-modal")
        modal.wait_for()
        assert "Nota de Débito" in modal.inner_text() and not page.locator("#ncw-aplicar").is_visible()
        page.select_option("#ncw-proveedor", prov["id"])
        page.select_option("#ncw-motivo", "interes")
        page.fill("#ncw-numero", "0001-55")
        page.locator("#ncw-add-conc").click()
        page.fill("#ncw-conc-wrap input[data-f=concepto]", "Recargo por mora")
        page.fill("#ncw-conc-wrap input[data-f=monto]", "1500")
        aceptar["v"] = False
        page.keyboard.press("Escape")
        assert modal.is_visible() and "nota de débito NO está guardada" in dialogos[-1], dialogos
        aceptar["v"] = True
        page.locator("#ncw-guardar").click()
        assert not modal.is_visible()
        nd1 = nds(admin)[0]
        assert nd1["monto"] == 1500 and nd1["metodo_pago"] == "cuenta_corriente" and nd1["categoria"] == "interes", nd1
        assert round(admin.js(SALDO, prov["id"]) - saldo0, 2) == 1500 and stock(admin) == stock0
        pos.sincronizar()
        assert round(pos.js(SALDO, prov["id"]) - saldo0, 2) == 1500
        assert pos.q("SELECT concepto, subtotal FROM gastos_items WHERE gasto_id = ?", [nd1["id"]]) \
            == [{"concepto": "Recargo por mora", "subtotal": 1500}]
        print("OK - conceptos: suma deuda, no mueve stock, llega al POS")

        # 3. Con productos y factura A
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.locator("#ccprov-search").wait_for()
        page.locator("#ccprov-search").fill(prov["razon_social"])
        page.locator(f".btn-nd[data-id='{prov['id']}']").click()
        page.wait_for_function("() => document.activeElement?.id === 'ncw-buscar'")   # foco inicial de la ventana
        page.select_option("#ncw-letra", "A")
        for cant, mueve in (("3", True), ("2", False)):
            page.fill("#ncw-buscar", prod["nombre"])
            page.locator("#ncw-dd .sri", has_text=prod["nombre"]).first.click()
            fila = page.locator("#ncw-prod-wrap tr[data-i]").last
            fila.locator("input[data-f=cantidad]").fill(cant)
            fila.locator("input[data-f=costo]").fill("100")
            fila.locator("select[data-f=iva]").select_option("21")
            if not mueve:
                fila.locator("input[data-f=baja]").uncheck()
        assert "Sube stock" in page.locator("#ncw-prod-wrap").inner_text().replace("SUBE STOCK", "Sube stock")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "nd_wizard.png"))
        page.locator("#ncw-guardar").click()
        nd2 = nds(admin)[-1]
        assert (nd2["monto"], nd2["subtotal_neto"], nd2["iva_21"], nd2["condicion_nd"]) == (605, 500, 105, "A"), (
            nd2["monto"], prod, admin.q("SELECT cantidad, costo_unitario, mueve_stock FROM gastos_items WHERE gasto_id = ?", [nd2["id"]]))
        assert stock(admin) == stock0 + 3
        assert admin.q("SELECT costo FROM productos WHERE id = ?", [prod["id"]])[0]["costo"] == prod["costo"]
        pos.sincronizar()
        pos.sincronizar()
        assert stock(pos) == stock0 + 3 and nds(pos)[-1]["iva_21"] == 105, (stock(pos), stock0)
        print("OK - productos: stock (solo la línea tildada), IVA, sin tocar costos")

        # 4. Se paga desde el POS
        pend = pos.js("(p) => window.SGA_PagosProveedores.getComprasPendientes(p)", prov["id"])
        assert any(c["id"] == nd2["id"] and c["es_nd"] and c["saldo"] == 605 for c in pend), pend
        r = pos.js("""([p, nd]) => window.SGA_PagosProveedores.crearPago({ proveedor_id: p,
            metodos: [{ metodo: 'transferencia', monto: 605 }], imputaciones: [{ gasto_id: nd, tipo: 'gasto', monto: 605 }] })""",
                   [prov["id"], nd2["id"]])
        assert r["success"], r
        pos.push()
        admin.sincronizar()
        admin.page.evaluate("window.location.hash = 'inicio'")
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.locator("#ccprov-search").wait_for()
        page.locator("#btn-toggle-deuda").click()
        page.locator("#ccprov-search").fill(prov["razon_social"])
        page.locator(f".btn-ver-detalle[data-id='{prov['id']}']").click()
        tabla = page.locator("#ccprov-ledger-wrap")
        assert "0001-55" in tabla.inner_text() and "Saldada" in tabla.inner_text()
        page.locator(f"[data-ver-nd='{nd1['id']}']").click()
        assert "Recargo por mora" in page.locator("#nd-detalle").inner_text()
        page.locator("#btn-detnd-ok").click()
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "nd_ledger.png"))
        print("OK - se paga como comprobante y se ve el detalle")

        # 5. Anular la pagada
        page.locator(f"[data-anular-nd='{nd2['id']}']").click()
        aviso = page.locator("#ccprov-overlay").inner_text()
        assert "crédito disponible" in aviso and "(−3)" in aviso, aviso
        page.locator("#btn-andnd-ok").click()
        assert stock(admin) == stock0 and [n["id"] for n in nds(admin)] == [nd1["id"]]
        assert round(admin.js(SALDO, prov["id"]) - saldo0, 2) == 1500 - 605
        pos.sincronizar()
        pos.sincronizar()
        admin.sincronizar()
        assert [n["id"] for n in nds(pos)] == [nd1["id"]] == [n["id"] for n in nds(admin)], "revivio"
        assert stock(pos) == stock0 and round(pos.js(SALDO, prov["id"]) - saldo0, 2) == 1500 - 605
        for d in (pos, admin):
            assert not d.q("SELECT 1 AS x FROM imputaciones_pagos WHERE gasto_id = ?", [nd2["id"]])
        creditos = pos.js("(p) => window.SGA_PagosProveedores.getCreditosDisponibles(p)", prov["id"])
        assert any(c["id"] == r["id"] and c["credito_disponible"] == 605 for c in creditos), creditos
        print("OK - anular: deuda, stock y crédito correctos en las dos compus")

        assert not pos.errores and not admin.errores, (pos.errores, admin.errores)
    print("\nTODO OK — test_nota_debito_proveedor")


if __name__ == "__main__":
    main()
