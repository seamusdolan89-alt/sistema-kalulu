"""
tests/e2e/test_nc_provisoria_no_entregado.py — "Producto no entregado" (ajuste
pedido desde Compras — Revisión) genera una NOTA DE CRÉDITO PROVISORIA con el
proveedor al aprobarse, y NO queda como consumo interno.

Antes, aprobar un "Producto no entregado" bajaba el stock y lo registraba como
consumo interno (una pérdida propia del negocio) cuando en realidad es un
faltante del proveedor: la factura seguía completa en la cuenta corriente y se
debía plata por mercadería que no llegó.

Ahora, al aprobar (Aprobaciones Pendientes):
  - el stock baja igual;
  - NO se crea consumo_interno (Rotura y Consumo siguen creándolo);
  - se le acredita al proveedor costo x cantidad (+ IVA si la factura es A, con la
    alícuota de esa línea) con UNA NC provisoria por compra: las aprobaciones
    siguientes de la misma compra le suman líneas mientras siga provisoria;
  - se aplica sola contra la factura de origen (hasta su saldo);
  - sus líneas NO vuelven a mover stock (ya lo bajó el ajuste).
Cuando llega la NC real, "Completar NC" carga su N° y su importe (puede diferir de lo
calculado), la deja de marcar provisoria y re-aplica contra la factura por el importe
real. Una aprobación posterior de esa misma compra abre una NC provisoria nueva.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_nc_provisoria_no_entregado.py
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
  const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id, razon_social FROM proveedores ORDER BY razon_social LIMIT 1`)[0];
  const mkProd = (id, nombre, costo) => {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
         precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
       VALUES (?, ?, ?, ?, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [id, nombre, costo, costo * 2, now, now, now]);
    window.SGA_DB.moverStock({ productoId: id, sucursalId: '1', delta: 10, tipo: 'ajuste_positivo',
                               refTipo: 'stock_ajustes', refId: 'seed-' + id, fecha: now });
  };
  mkProd('p-ne-a', 'Prod NE A', 100);
  mkProd('p-ne-b', 'Prod NE B', 200);
  const compra = (id, cond, total, items) => {
    window.SGA_DB.run(
      `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
         total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
       VALUES (?, '1', ?, ?, '2026-09-10T10:00:00.000Z', ?, '0001', ?, ?, 'pendiente', ?, 'confirmada', 'pending', ?)`,
      [id, prov.id, uid, id.slice(-2) + '01', total, total, cond, now]);
    for (const it of items) {
      window.SGA_DB.run(
        `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal, iva,
           unidades_por_paquete, tipo) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'producto')`,
        [id + '-' + it.p, id, it.p, it.cant, it.costo, it.cant * it.costo, it.iva]);
      window.SGA_DB.moverStock({ productoId: it.p, sucursalId: '1', delta: it.cant, tipo: 'compra',
                                 refTipo: 'compras', refId: id, fecha: now });
    }
  };
  // Factura A: A 5u a $100 (IVA 21) + B 5u a $200 (IVA 10,5) = 1500 neto + 210 IVA = 1710
  compra('c-ne', 'Factura A', 1710, [{ p: 'p-ne-a', cant: 5, costo: 100, iva: '21' }, { p: 'p-ne-b', cant: 5, costo: 200, iva: '10.5' }]);
  // Factura C (sin IVA discriminado)
  compra('c-ne-c', 'Factura C', 500, [{ p: 'p-ne-a', cant: 5, costo: 100, iva: null }]);
  const aj = (id, prod, cant, costo, motivo, tipo, compraId) => window.SGA_DB.run(
    `INSERT INTO stock_ajustes (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado,
       compra_id, costo_unitario, sync_status, updated_at)
     VALUES (?, ?, '1', ?, ?, ?, ?, ?, 'pendiente_aprobacion', ?, ?, 'pending', ?)`,
    [id, prod, tipo, cant, motivo, uid, now, compraId, costo, now]);
  aj('aj-1', 'p-ne-a', 2, 100, 'Producto no entregado', 'ajuste_negativo', 'c-ne');
  aj('aj-2', 'p-ne-b', 1, 200, 'Producto no entregado', 'ajuste_negativo', 'c-ne');
  aj('aj-3', 'p-ne-a', 1, 100, 'Rotura', 'rotura', 'c-ne');
  aj('aj-4', 'p-ne-a', 1, 100, 'Producto no entregado por proveedor', 'ajuste_negativo', 'c-ne');   // nombre viejo
  aj('aj-5', 'p-ne-b', 1, 200, 'Producto no entregado', 'ajuste_negativo', 'c-ne');
  aj('aj-6', 'p-ne-b', 1, 200, 'Producto no entregado', 'ajuste_negativo', 'c-ne');
  return { provId: prov.id, provNombre: prov.razon_social };
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def stock(page, pid):
    return q(page, "SELECT cantidad FROM stock WHERE producto_id=?", [pid])[0]["cantidad"]


def ncs(page):
    return q(page, """SELECT p.id, p.nc_provisoria, p.numero_comprobante, p.subtotal_neto, p.iva_21, p.iva_105, p.condicion_nc,
                             (SELECT SUM(m.monto) FROM pagos_proveedores_metodos m WHERE m.pago_id = p.id) AS monto,
                             (SELECT COUNT(*) FROM pagos_proveedores_items i WHERE i.pago_id = p.id) AS lineas,
                             (SELECT COALESCE(SUM(ip.monto_imputado), 0) FROM imputaciones_pagos ip WHERE ip.pago_id = p.id) AS imputado
                      FROM pagos_proveedores p WHERE p.tipo='nota_credito' ORDER BY p.rowid""")


def aprobar(page, ajuste_id):
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(150)
    page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
    page.wait_for_timeout(500)
    page.locator(f'tr[data-id="{ajuste_id}"] [data-aprobar]').click()
    page.wait_for_timeout(700)


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
        dialogos = []
        page.on("dialog", lambda d: (dialogos.append(d.message), d.accept()))

        print("--- Login admin-pos + factura A (1710) con 2 productos, y 6 ajustes pendientes ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        info = page.evaluate(SEMBRAR)
        saldo = lambda: round(page.evaluate("(id) => window.SGA_PagosProveedores.getSaldoProveedor(id)", info["provId"]), 2)  # noqa: E731
        page.evaluate("async () => { await import('/js/modules/cuenta_corriente_proveedores.js'); }")
        assert saldo() == 2210, f"Saldo inicial (1710 + 500): {saldo()}"
        stock_a0, stock_b0 = stock(page, "p-ne-a"), stock(page, "p-ne-b")

        print("--- 1) Aprobar 'Producto no entregado' #1 (2 u. de A a $100, IVA 21%): nace la NC provisoria ---")
        aprobar(page, "aj-1")
        assert "nota de crédito provisoria" in dialogos[-1] and "242" in dialogos[-1], f"El aviso no anuncia la NC: {dialogos[-1]!r}"
        n = ncs(page)
        print(f"NC tras la 1ra aprobación: {n}")
        assert len(n) == 1 and n[0]["nc_provisoria"] == 1 and n[0]["condicion_nc"] == "A", f"Debía nacer 1 NC provisoria A: {n}"
        assert n[0]["monto"] == 242 and n[0]["subtotal_neto"] == 200 and n[0]["iva_21"] == 42, f"Importes de la NC: {n[0]}"
        assert n[0]["imputado"] == 242, f"Debía aplicarse sola a la factura de origen: {n[0]}"
        it = q(page, "SELECT mueve_stock, cantidad FROM pagos_proveedores_items WHERE pago_id=?", [n[0]["id"]])
        assert it == [{"mueve_stock": 0, "cantidad": 2}], f"La línea de la NC no debe volver a mover stock: {it}"
        assert stock(page, "p-ne-a") == stock_a0 - 2, "El ajuste debía bajar el stock (una sola vez)"
        assert q(page, "SELECT COUNT(*) AS n FROM consumo_interno")[0]["n"] == 0, "BUG: 'Producto no entregado' quedó como consumo interno"
        assert saldo() == 2210 - 242

        print("--- 2) Aprobar #2 (1 u. de B a $200, IVA 10,5%): se suma a LA MISMA NC ---")
        aprobar(page, "aj-2")
        n = ncs(page)
        assert len(n) == 1, f"BUG: cada aprobación abrió una NC nueva en vez de sumar a la provisoria: {n}"
        assert n[0]["lineas"] == 2 and n[0]["monto"] == 463 and n[0]["subtotal_neto"] == 400, f"NC tras sumar B: {n[0]}"
        assert n[0]["iva_21"] == 42 and n[0]["iva_105"] == 21, f"IVA por alícuota: {n[0]}"
        assert n[0]["imputado"] == 463, f"La diferencia debía aplicarse también a la factura: {n[0]}"

        print("--- 3) 'Rotura' sigue siendo consumo interno y no toca la NC ---")
        aprobar(page, "aj-3")
        assert q(page, "SELECT COUNT(*) AS n FROM consumo_interno")[0]["n"] == 1, "Rotura debía seguir creando consumo interno"
        assert ncs(page)[0]["monto"] == 463, "Una rotura no debe tocar la NC provisoria"

        print("--- 4) El nombre viejo 'Producto no entregado por proveedor' también se reconoce ---")
        aprobar(page, "aj-4")
        n = ncs(page)
        assert len(n) == 1 and n[0]["lineas"] == 3 and n[0]["monto"] == 463 + 121, f"El motivo con nombre viejo no sumó a la NC: {n}"
        assert q(page, "SELECT COUNT(*) AS n FROM consumo_interno")[0]["n"] == 1, "El nombre viejo no debe crear consumo interno"
        assert_stock_integro(page, "tras aprobar 'no entregado'")

        print("--- 5) Ledger: 'NC ... (provisoria)' con su botón Completar ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(150)
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_timeout(500)
        page.locator(f'.btn-ver-detalle[data-id="{info["provId"]}"]').click()
        page.wait_for_timeout(300)
        page.locator("#btn-ledger-plano").click()
        page.wait_for_timeout(200)
        fila = page.locator("#ccprov-ledger-wrap tr.ledger-row-nc")
        assert fila.count() == 1 and "provisoria" in fila.inner_text(), f"La NC provisoria no se ve como tal: {fila.inner_text()!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "nc_provisoria_ledger.png"))
        page.locator("[data-completar-nc]").click()
        page.wait_for_timeout(300)
        modal = page.locator("#ccprov-overlay").inner_text()
        assert "Prod NE A" in modal and "Prod NE B" in modal, f"El modal no lista los productos no entregados: {modal[:300]!r}"

        print("--- 6) Sin N° no deja; con la NC real (N° e importe distinto) queda completa y re-aplicada ---")
        page.locator("#btn-comp-ok").click()
        page.wait_for_timeout(200)
        assert page.locator("#comp-error").is_visible(), "Debía pedir el N° de la NC real"
        assert ncs(page)[0]["nc_provisoria"] == 1
        page.fill("#comp-numero", "0001-00555")
        page.fill("#comp-total", "580")
        page.locator("#btn-comp-ok").click()
        page.wait_for_timeout(500)
        n = ncs(page)[0]
        print(f"NC completada: {n}")
        assert n["nc_provisoria"] == 0 and n["numero_comprobante"] == "0001-00555" and n["monto"] == 580, f"No quedó completa: {n}"
        assert n["imputado"] == 580, f"Debía re-aplicarse por el importe real contra la factura: {n}"
        assert q(page, "SELECT COUNT(*) AS n FROM eliminaciones WHERE tabla='imputaciones_pagos'")[0]["n"] >= 1, (
            "Las imputaciones viejas se borraron sin marca de eliminación")
        assert saldo() == 2210 - 580, f"Saldo tras completar (2210 - 580): {saldo()}"
        page.locator("#btn-ledger-plano").click()
        page.wait_for_timeout(200)
        txt = page.locator("#ccprov-ledger-wrap tr.ledger-row-nc").inner_text()
        assert "0001-00555" in txt and "provisoria" not in txt, f"El ledger debía mostrar la NC ya completa: {txt!r}"
        assert page.locator("[data-completar-nc]").count() == 0, "La NC completa no debe seguir ofreciendo 'Completar'"

        print("--- 7) Otra aprobación de la misma compra abre una NC provisoria NUEVA ---")
        aprobar(page, "aj-5")
        n = ncs(page)
        assert len(n) == 2 and n[1]["nc_provisoria"] == 1 and n[1]["monto"] == 221, f"Debía abrirse una NC provisoria nueva: {n}"

        print("--- 8) Rechazar un 'no entregado' no genera NC ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(150)
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_timeout(500)
        page.locator('tr[data-id="aj-6"] [data-rechazar]').click()
        page.wait_for_timeout(400)
        assert len(ncs(page)) == 2, "Rechazar no debe generar ninguna NC"
        assert stock(page, "p-ne-b") == stock_b0 - 2, "Rechazar no debe tocar el stock (solo bajaron aj-2 y aj-5)"

        print("--- 9) Factura C: se acredita el costo sin IVA ---")
        c = page.evaluate("() => window.SGA_PagosProveedores.calcularNoEntregado({ compraId: 'c-ne-c', productoId: 'p-ne-a', cantidad: 2, costoUnitario: 100 })")
        assert c["success"] and c["letra"] == "C" and c["iva"] is None and c["total"] == 200, f"Factura C no debe sumar IVA: {c}"

        assert_stock_integro(page, "al final de test_nc_provisoria_no_entregado.py")
        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - 'Producto no entregado' acredita al proveedor con una NC provisoria (una por compra, con IVA si es A) y se completa con la real.")
        browser.close()


if __name__ == "__main__":
    main()
