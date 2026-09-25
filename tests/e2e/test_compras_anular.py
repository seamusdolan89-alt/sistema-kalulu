"""
tests/e2e/test_compras_anular.py — Anular una compra cargada por error
(Historial de compras, solo Admin-POS + admin).

No es una nota de crédito: la factura se cargó mal (monto o proveedor
equivocado, duplicada...). La compra queda como historial (estado 'anulada',
con motivo/quién/cuándo) y se deshace todo lo que hizo:

  - deuda: el saldo del proveedor ya excluye las compras anuladas;
  - stock: se revierte lo que ESTA compra sumó (según el registro de movimientos);
  - pagos aplicados: se libera SOLO la imputación (con marca de borrado); el pago
    sigue y su crédito vuelve a estar disponible;
  - ajustes de stock pendientes de aprobación: se rechazan (si hay uno ya
    aprobado se BLOQUEA: su descuento quedaría duplicado);
  - remito vinculado: vuelve a quedar pendiente de factura;
  - costo del producto: solo se revierte si era su última compra y nada lo movió
    después (nunca el precio de venta).

Cubre: una compra real cargada por el flujo de Compras (Coca-Cola 2L x2 a $100,
Factura A) con un pago imputado y un ajuste pendiente; el modal (efectos,
motivo obligatorio); y el resultado. Además, por SQL: bloqueo por ajuste ya
aprobado, remito reabierto, y que el costo NO se revierte si hay una compra
posterior. Y que el POS del local no puede anular.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_anular.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, assert_stock_integro

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
IMPORTAR_OPS = "async () => { window.__ops = (await import('/js/modules/operaciones_stock.js')).default; }"
IMPORTAR_CC = "async () => { await import('/js/modules/cuenta_corriente_proveedores.js'); }"


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def cargar_compra_real(page):
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
    page.select_option("#cv2-condicion-compra", label="Factura A")
    page.wait_for_timeout(200)
    page.fill("#cv2-subtotal-neto", "200")
    page.locator("#cv2-subtotal-neto").blur()
    page.fill("#cv2-iva-21", "42")
    page.locator("#cv2-iva-21").blur()
    page.wait_for_timeout(200)
    page.get_by_text("Continuar al Carrito", exact=False).click()
    page.wait_for_timeout(400)
    page.locator("#cv2-search").click()
    page.keyboard.type("Coca-Cola 2L", delay=20)
    page.wait_for_timeout(400)
    page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Coca-Cola 2L").click()
    page.wait_for_timeout(400)
    row = "tr[data-idx='0']"
    page.fill(f"{row} input[data-field='cantidad']", "2")
    page.fill(f"{row} input[data-field='costoNuevo']", "100")
    page.locator(f"{row} input[data-field='costoNuevo']").blur()
    page.wait_for_timeout(300)
    page.get_by_text("Siguiente", exact=False).click()
    page.wait_for_timeout(500)
    page.locator("#cv2-rev-btn-confirmar").click()
    page.wait_for_timeout(800)


def abrir_historial(page):
    page.evaluate("window.location.hash = 'operaciones_stock'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.locator('[data-action="historial_compras"]').click()
    page.wait_for_timeout(400)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []

        def nuevo_contexto():
            ctx = browser.new_context(viewport={"width": 1700, "height": 1100})
            ctx.route("**/*", block_firebase)
            enable_dev_mode(ctx)
            page = ctx.new_page()
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.on("dialog", lambda d: d.accept())
            return ctx, page

        ctx, page = nuevo_contexto()
        print("--- Login admin-pos + seed; cargar una compra REAL (Coca-Cola 2L x2 a $100, Factura A) ---")
        login_via_seed(page, admin_pos=True)
        cargar_compra_real(page)

        compra = q(page, "SELECT id, proveedor_id, total, estado, sucursal_id FROM compras")[0]
        prod = q(page, "SELECT id, costo FROM productos WHERE nombre='Coca-Cola 2L'")[0]
        stock_ini = q(page, "SELECT cantidad FROM stock WHERE producto_id=?", [prod["id"]])[0]["cantidad"]
        print(f"compra: {compra} | Coca-Cola: costo={prod['costo']} stock={stock_ini}")
        assert compra["estado"] == "confirmada" and stock_ini == 22 and prod["costo"] == 100, (
            f"La compra real no dejó el estado esperado: stock={stock_ini} costo={prod['costo']}")

        print("--- Un pago de $100 imputado a esa compra y un ajuste de stock pendiente ---")
        page.evaluate(IMPORTAR_CC)
        pago = page.evaluate("""(c) => window.SGA_PagosProveedores.crearPago({
            proveedor_id: c.proveedor_id, fecha: '2026-09-20', metodos: [{ metodo: 'transferencia', monto: 100 }] })""", compra)
        assert pago["success"], pago
        page.evaluate("""(c) => window.SGA_DB.run(
            `INSERT INTO stock_ajustes (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado,
               compra_id, costo_unitario, sync_status, updated_at)
             SELECT 'aj-pend', id, ?, 'ajuste_negativo', 1, 'Producto no entregado', NULL, ?, 'pendiente_aprobacion', ?, 100, 'pending', ?
             FROM productos WHERE nombre='Coca-Cola 2L'`, [c.sucursal_id, new Date().toISOString(), c.id, new Date().toISOString()])""", compra)
        saldo_antes = page.evaluate("(id) => window.SGA_PagosProveedores.getSaldoProveedor(id)", compra["proveedor_id"])
        assert round(saldo_antes, 2) == 142, f"Saldo antes de anular inesperado (242 - 100): {saldo_antes}"

        print("--- Historial: el botón Anular abre el modal con los efectos ---")
        abrir_historial(page)
        btn = page.locator(f'[data-anular-compra="{compra["id"]}"]')
        assert btn.count() == 1, "No aparece el botón Anular en la fila de la compra"
        btn.click()
        page.wait_for_timeout(300)
        modal = page.locator("#ops-anular-body").inner_text()
        print(f"Modal: {modal[:700]!r}")
        assert "Coca-Cola 2L" in modal and "−2" in modal, "El modal no lista el stock que se va a descontar"
        assert "Se liberan" in modal and "100" in modal, "El modal no avisa que se libera el pago aplicado"
        assert "rechazan 1 ajuste" in modal, "El modal no avisa que se rechaza el ajuste pendiente"
        assert "vuelve de" in modal and "50" in modal, "El modal no avisa que se revierte el costo del producto"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "anular_compra_modal.png"))

        print("--- Sin motivo no deja anular ---")
        page.locator("#ops-anular-confirmar").click()
        page.wait_for_timeout(200)
        assert page.locator("#ops-anular-error").is_visible(), "No pidió el motivo"
        assert q(page, "SELECT estado FROM compras WHERE id=?", [compra["id"]])[0]["estado"] == "confirmada", "Anuló sin motivo"

        print("--- Con motivo: se anula ---")
        page.fill("#ops-anular-motivo", "Cargada con el proveedor equivocado")
        page.locator("#ops-anular-confirmar").click()
        page.wait_for_timeout(500)

        c = q(page, "SELECT estado, motivo_anulacion, anulada_por, anulada_en FROM compras WHERE id=?", [compra["id"]])[0]
        print(f"compra tras anular: {c}")
        assert c["estado"] == "anulada" and "proveedor equivocado" in c["motivo_anulacion"], f"Estado/motivo: {c}"
        assert c["anulada_en"], "No quedó la fecha de anulación"

        stock_fin = q(page, "SELECT cantidad FROM stock WHERE producto_id=?", [prod["id"]])[0]["cantidad"]
        assert stock_fin == 20, f"BUG: el stock no volvió a 20 tras anular (queda {stock_fin})"
        assert_stock_integro(page, "tras anular una compra")
        movs = q(page, "SELECT tipo, delta FROM stock_movimientos WHERE ref_tipo='compras' AND ref_id=? ORDER BY fecha", [compra["id"]])
        print(f"movimientos de la compra: {movs}")
        assert [m["tipo"] for m in movs] == ["compra", "anulacion_compra"] and movs[1]["delta"] == -2, (
            f"La reversión tiene que ser un movimiento nuevo de signo contrario: {movs}")

        costo = q(page, "SELECT costo FROM productos WHERE id=?", [prod["id"]])[0]["costo"]
        assert costo == 50, f"El costo no volvió a $50 (era su última compra): {costo}"

        assert q(page, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE compra_id=?", [compra["id"]])[0]["n"] == 0, "Quedó la imputación"
        assert q(page, "SELECT COUNT(*) AS n FROM eliminaciones WHERE tabla='imputaciones_pagos'")[0]["n"] == 1, (
            "La imputación se borró sin marca: volvería del otro dispositivo")
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [pago["id"]])[0]["n"] == 1, "El pago NO debería borrarse, solo su imputación"
        creditos = page.evaluate("(id) => window.SGA_PagosProveedores.getCreditosDisponibles(id)", compra["proveedor_id"])
        assert len(creditos) == 1 and round(creditos[0]["credito_disponible"], 2) == 100, (
            f"El crédito del pago no volvió a estar disponible: {creditos}")
        saldo_desp = page.evaluate("(id) => window.SGA_PagosProveedores.getSaldoProveedor(id)", compra["proveedor_id"])
        assert round(saldo_desp, 2) == -100, f"Saldo tras anular: solo queda el crédito a favor (-100), da {saldo_desp}"

        aj = q(page, "SELECT estado FROM stock_ajustes WHERE id='aj-pend'")[0]["estado"]
        assert aj == "rechazado", f"El ajuste pendiente debería rechazarse: {aj}"

        print("--- La fila queda Anulada, sin Editar ni Anular; Ver muestra el motivo ---")
        fila = page.locator("#ops-historial-body tbody tr").first
        assert "Anulada" in fila.inner_text(), f"La fila no dice Anulada: {fila.inner_text()!r}"
        assert fila.locator("[data-anular-compra]").count() == 0 and fila.locator("[data-editar-compra]").count() == 0, (
            "Una compra anulada no debe poder editarse ni anularse otra vez")
        fila.locator("[data-ver-compra]").click()
        page.wait_for_timeout(300)
        assert "proveedor equivocado" in page.locator("#ops-detalle-body").inner_text(), "El detalle no muestra el motivo de la anulación"

        print("--- Por SQL: bloqueo por ajuste aprobado, remito reabierto, costo con compra posterior ---")
        page.evaluate(IMPORTAR_OPS)
        page.evaluate("""() => {
          const now = new Date().toISOString();
          const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;
          const pid = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre='Coca-Cola 2L'`)[0].id;
          const compra = (id, fecha, costoNuevo, costoAnt) => {
            window.SGA_DB.run(`INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
               total, total_factura, condicion_pago, estado, sync_status, updated_at)
               VALUES (?, '1', ?, ?, ?, ?, '0001', 100, 100, 'pendiente', 'confirmada', 'pending', ?)`, [id, prov, uid, fecha, id, now]);
            window.SGA_DB.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior,
               subtotal, costo_modificado, unidades_por_paquete, tipo) VALUES (?, ?, ?, 1, ?, ?, 100, 1, 1, 'producto')`,
               [id + '-i', id, pid, costoNuevo, costoAnt]);
          };
          // bloqueo: ajuste ya aprobado
          compra('c-bloq', '2026-09-05T10:00:00.000Z', 100, 50);
          window.SGA_DB.run(`INSERT INTO stock_ajustes (id, producto_id, sucursal_id, tipo, cantidad, motivo, fecha, estado, compra_id, sync_status, updated_at)
             VALUES ('aj-apr', ?, '1', 'ajuste_negativo', 1, 'Rotura', ?, 'aprobado', 'c-bloq', 'pending', ?)`, [pid, now, now]);
          // remito vinculado (sin movimientos propios de stock: lo sumo el remito)
          compra('c-remito', '2026-09-06T10:00:00.000Z', 100, 50);
          window.SGA_DB.run(`INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, compra_id, sync_status, updated_at)
             VALUES ('rem-1', '1', ?, ?, '2026-09-06', 'R-77', 'facturado', 'c-remito', 'pending', ?)`, [prov, uid, now]);
          // costo: A (vieja) y B (posterior) tocaron el costo; B dejo el costo actual
          compra('c-vieja',  '2026-09-01T10:00:00.000Z', 30, 10);
          compra('c-nueva',  '2026-09-10T10:00:00.000Z', 40, 30);
          window.SGA_DB.run(`UPDATE productos SET costo=40 WHERE id=?`, [pid]);
        }""")
        bloq = page.evaluate("() => window.__ops.anularCompra('c-bloq', 'prueba')")
        print(f"anularCompra con ajuste aprobado: {bloq}")
        assert not bloq["success"] and "ajuste" in bloq["error"].lower(), f"Debía bloquear por el ajuste aprobado: {bloq}"
        assert q(page, "SELECT estado FROM compras WHERE id='c-bloq'")[0]["estado"] == "confirmada"

        res_r = page.evaluate("() => window.__ops.anularCompra('c-remito', 'prueba remito')")
        assert res_r["success"] and res_r["remitoReabierto"], f"No anuló la compra del remito: {res_r}"
        rem = q(page, "SELECT estado, compra_id FROM remitos WHERE id='rem-1'")[0]
        assert rem["estado"] == "pendiente" and rem["compra_id"] is None, f"El remito no volvió a quedar pendiente: {rem}"
        sin_mov = q(page, "SELECT COUNT(*) AS n FROM stock_movimientos WHERE ref_id='c-remito'")[0]["n"]
        assert sin_mov == 0, "Una factura sin stock propio (vino del remito) no debe generar movimientos"

        res_v = page.evaluate("() => window.__ops.getResumenAnulacionCompra('c-vieja')")
        assert res_v["success"] and res_v["costos"] == [], (
            f"BUG: revertiría el costo de una compra que ya no es la última de ese producto: {res_v['costos']}")
        res_n = page.evaluate("() => window.__ops.getResumenAnulacionCompra('c-nueva')")
        assert len(res_n["costos"]) == 1 and res_n["costos"][0]["a"] == 30, (
            f"La compra más reciente sí debería volver el costo a $30: {res_n['costos']}")
        ctx.close()

        print("--- POS del local: no puede anular ---")
        ctx, page = nuevo_contexto()
        login_via_seed(page)
        page.evaluate(IMPORTAR_OPS)
        page.evaluate("""() => {
          const now = new Date().toISOString();
          const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;
          window.SGA_DB.run(`INSERT INTO compras (id, sucursal_id, proveedor_id, fecha, numero_factura, total, estado, sync_status, updated_at)
             VALUES ('c-pos', '1', ?, ?, '9', 10, 'confirmada', 'pending', ?)`, [prov, now, now]);
        }""")
        r = page.evaluate("() => window.__ops.anularCompra('c-pos', 'x')")
        assert not r["success"], f"BUG: el POS del local pudo anular una compra: {r}"
        ctx.close()

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - Anular compra: stock, pagos, ajustes, remito y costo se deshacen bien; con bloqueos y solo Admin-POS.")
        browser.close()


if __name__ == "__main__":
    main()
