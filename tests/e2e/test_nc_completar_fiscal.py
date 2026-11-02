"""
tests/e2e/test_nc_completar_fiscal.py

"Completar NC" (cuenta_corriente_proveedores.js, openModalCompletarNC) ahora deja
indicar el tipo de comprobante (A/B/C) y cargar el desglose fiscal completo (subtotal
neto, IVA 10,5/21, imp. interno, percepciones) de la NC REAL del proveedor — antes solo
pedía N° y un importe total único, sin poder discriminar nada. Pedido real del usuario
(2/11/2026, caso real proveedor "Oslé"): la NC provisoria (generada automático por
"Producto no entregado") traía un neto/IVA calculado de la línea aprobada, pero el
comprobante real que mandó el proveedor tenía un neto e IVA DISTINTOS (otro precio
unitario) — el camino de "Registrar NC desde cero" sí permitía elegir tipo A y cargar
esos campos, pero "Completar NC" (vincular la provisoria con la real) no.

Fix: el modal reusa el mismo bloque de campos fiscales que nota_credito_wizard.js
(exportado ahora como NotaCreditoWizard.ensureCss, mismas clases CSS .ncw-fiscal/
.ncw-es-a/.ncw-solo-a), precargado con lo que ya tenía acumulado la NC provisoria
(editable), y el Importe se recalcula solo de esos campos mientras el usuario no lo
toque a mano — mismo patrón "tocado" que el wizard. completarNotaCredito() ahora
también persiste condicion_nc y los 6 campos fiscales en pagos_proveedores.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_nc_completar_fiscal.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id, razon_social FROM proveedores ORDER BY razon_social LIMIT 1`)[0];
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
       precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('p-ncf-1', 'Huevo Toddy', 2104.65, 4000, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]);
  window.SGA_DB.moverStock({ productoId: 'p-ncf-1', sucursalId: '1', delta: 10, tipo: 'ajuste_positivo',
                             refTipo: 'stock_ajustes', refId: 'seed-p-ncf-1', fecha: now });
  // Total bien por encima de lo que acredita la NC: deja saldo pendiente claro
  // (si la NC pagara casi toda la factura, el proveedor desaparecería del
  // listado por defecto de Cuentas Corrientes, que solo muestra "con deuda").
  window.SGA_DB.run(
    `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
       total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
     VALUES ('c-ncf', '1', ?, ?, '2026-10-19T10:00:00.000Z', '2954', '269', 50000, 50000, 'pendiente',
       'Factura A', 'confirmada', 'pending', ?)`, [prov.id, uid, now]);
  window.SGA_DB.run(
    `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal, iva,
       unidades_por_paquete, tipo) VALUES ('c-ncf-it', 'c-ncf', 'p-ncf-1', 4, 2104.65, 8418.60, '21', 1, 'producto')`);
  window.SGA_DB.moverStock({ productoId: 'p-ncf-1', sucursalId: '1', delta: 4, tipo: 'compra',
                             refTipo: 'compras', refId: 'c-ncf', fecha: now });
  window.SGA_DB.run(
    `INSERT INTO stock_ajustes (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado,
       compra_id, costo_unitario, sync_status, updated_at)
     VALUES ('aj-ncf', 'p-ncf-1', '1', 'ajuste_negativo', 4, 'Producto no entregado', ?, ?, 'pendiente_aprobacion',
       'c-ncf', 2104.65, 'pending', ?)`, [uid, now, now]);
  return { provId: prov.id, provNombre: prov.razon_social };
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def nc_row(page):
    return q(page, """
      SELECT p.condicion_nc, p.nc_provisoria, p.numero_comprobante,
             p.subtotal_neto, p.iva_105, p.iva_21, p.imp_interno, p.percepcion_iva, p.percepcion_iibb,
             (SELECT SUM(m.monto) FROM pagos_proveedores_metodos m WHERE m.pago_id = p.id) AS monto
      FROM pagos_proveedores p WHERE p.tipo = 'nota_credito'
    """)[0]


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

        print("--- Login admin-pos + Factura A, 1 producto, 1 ajuste 'Producto no entregado' ---")
        login_via_seed(page, admin_pos=True)
        info = page.evaluate(SEMBRAR)
        page.evaluate("async () => { await import('/js/modules/cuenta_corriente_proveedores.js'); }")

        print("--- Aprobar: nace la NC provisoria (calculada de la linea: 4 x 2104.65 + IVA 21%) ---")
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_timeout(500)
        page.locator('tr[data-id="aj-ncf"] [data-aprobar]').click()
        page.wait_for_timeout(700)

        antes = nc_row(page)
        print(f"NC provisoria recien nacida: {antes}")
        assert antes["nc_provisoria"] == 1 and antes["condicion_nc"] == "A"
        assert round(antes["subtotal_neto"], 2) == 8418.60 and round(antes["iva_21"], 2) == 1767.91

        print("--- Abrir 'Completar NC' ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(150)
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_timeout(500)
        page.locator(f'.btn-ver-detalle[data-id="{info["provId"]}"]').click()
        page.wait_for_timeout(300)
        page.locator("#btn-ledger-plano").click()
        page.wait_for_timeout(200)
        page.locator("[data-completar-nc]").click()
        page.wait_for_timeout(300)

        print("--- El tipo 'A' viene preseleccionado y los campos fiscales se ven, precargados ---")
        assert page.locator("#comp-letra").input_value() == "A", "Debería traer el tipo A de la compra de origen"
        modal_classes = page.locator("#ccprov-overlay .ccprov-modal").get_attribute("class")
        assert "ncw-es-a" in modal_classes, f"Con tipo A los campos fiscales deberían estar visibles: {modal_classes!r}"
        assert page.locator("#comp-neto").input_value() == "8418.6", f"Neto precargado: {page.locator('#comp-neto').input_value()!r}"
        assert page.locator("#comp-iva21").input_value() == "1767.91", f"IVA 21 precargado: {page.locator('#comp-iva21').input_value()!r}"

        print("--- Cargar los numeros de la NC REAL del proveedor (distintos a lo calculado) ---")
        page.fill("#comp-neto", "24666.72")
        page.fill("#comp-iva21", "5180.01")
        page.wait_for_timeout(100)
        total_calculado = page.locator("#comp-total").input_value()
        assert total_calculado == "29846.73", f"El importe debería recalcularse solo de los campos fiscales: {total_calculado!r}"

        page.fill("#comp-numero", "0269-00000202")
        page.locator("#btn-comp-ok").click()
        page.wait_for_timeout(400)

        despues = nc_row(page)
        print(f"NC completada con los datos reales: {despues}")
        assert despues["nc_provisoria"] == 0
        assert despues["numero_comprobante"] == "0269-00000202"
        assert despues["condicion_nc"] == "A"
        assert round(despues["subtotal_neto"], 2) == 24666.72, f"Neto real guardado: {despues['subtotal_neto']}"
        assert round(despues["iva_21"], 2) == 5180.01, f"IVA 21 real guardado: {despues['iva_21']}"
        assert round(despues["monto"], 2) == 29846.73, f"Importe real guardado: {despues['monto']}"

        print("--- Caso B: una NC provisoria completada como tipo 'B' no guarda desglose fiscal ---")
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_timeout(300)
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
            window.SGA_DB.run(
              `INSERT INTO stock_ajustes (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado,
                 compra_id, costo_unitario, sync_status, updated_at)
               VALUES ('aj-ncf-2', 'p-ncf-1', '1', 'ajuste_negativo', 1, 'Producto no entregado', ?, ?,
                 'pendiente_aprobacion', 'c-ncf', 2104.65, 'pending', ?)`, [uid, now, now]);
          }
        """)
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(150)
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_timeout(500)
        page.locator('tr[data-id="aj-ncf-2"] [data-aprobar]').click()
        page.wait_for_timeout(700)

        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_timeout(500)
        page.locator(f'.btn-ver-detalle[data-id="{info["provId"]}"]').click()
        page.wait_for_timeout(300)
        page.locator("#btn-ledger-plano").click()
        page.wait_for_timeout(200)
        page.locator("[data-completar-nc]").click()
        page.wait_for_timeout(300)
        page.select_option("#comp-letra", "B")
        page.wait_for_timeout(100)
        modal_classes_b = page.locator("#ccprov-overlay .ccprov-modal").get_attribute("class")
        assert "ncw-es-a" not in modal_classes_b, f"Con tipo B los campos fiscales deberían ocultarse: {modal_classes_b!r}"
        page.fill("#comp-numero", "0269-00000300")
        page.fill("#comp-total", "2104.65")
        page.locator("#btn-comp-ok").click()
        page.wait_for_timeout(400)

        fila_b = q(page, """
          SELECT condicion_nc, subtotal_neto, iva_21 FROM pagos_proveedores
          WHERE tipo = 'nota_credito' AND numero_comprobante = '0269-00000300'
        """)[0]
        assert fila_b["condicion_nc"] == "B"
        assert fila_b["subtotal_neto"] == 0 and fila_b["iva_21"] == 0, f"Tipo B no debería guardar desglose fiscal: {fila_b}"

        assert not errors, f"Errores JS en pantalla: {errors}"

        browser.close()
        print("\nOK - test_nc_completar_fiscal: PASA")


if __name__ == "__main__":
    main()
