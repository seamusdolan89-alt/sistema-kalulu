"""
tests/e2e/test_sync_nc_proveedor.py — Una nota de crédito de proveedor sincroniza
entre POS y Admin-POS en los dos sentidos (con sus líneas), y anularla también.

Escenario (simulador de dos dispositivos, sync_sim.py):
  1. Admin-POS registra una NC A (una devolución de 3 unidades + un concepto, IVA 21%)
     aplicada a una factura. Sube al POS: el POS ve el pago de método 'nota_credito'
     con TODOS sus datos propios (tipo, comprobante, letra, factura de referencia,
     neto, IVA), sus líneas, su imputación, el movimiento de stock de la devolución
     (el stock del POS baja) y el saldo del proveedor da lo mismo en las dos compus.
  2. Admin-POS la anula: el POS pierde la NC, sus líneas y su imputación, el stock
     vuelve, y un Admin-POS nuevo (base vacía) no la resucita.

Antes de este cambio applyPagoProveedor tenía una lista fija de columnas (sin las de
la NC) y no traía líneas; una NC llegaba al otro lado como un pago "común" sin nada.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_nc_proveedor.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

IMPORTAR = "async () => { await import('/js/modules/cuenta_corriente_proveedores.js'); }"


def uno(d, sql, params=None):
    filas = d.q(sql, params or [])
    return filas[0] if filas else None


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        pos.js(IMPORTAR)
        admin.js(IMPORTAR)

        print("--- POS: proveedor, producto (stock 10) y una factura A de $1210; sube a Admin-POS ---")
        pos.js("""() => {
          const now = new Date().toISOString();
          const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          window.SGA_DB.run(
            `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_pago, activo, sync_status, updated_at)
             VALUES ('prov-sync-nc', 'Proveedor Sync NC', 'Responsable Inscripto', 'Cta. Cte.', 1, 'pending', ?)`, [now]);
          window.SGA_DB.run(
            `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
               precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
             VALUES ('prod-sync-nc', 'Producto Sync NC', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]);
          window.SGA_DB.moverStock({ productoId: 'prod-sync-nc', sucursalId: '1', delta: 10, tipo: 'ajuste_positivo',
                                     refTipo: 'stock_ajustes', refId: 'seed-nc', fecha: now });
          window.SGA_DB.run(
            `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
               total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
             VALUES ('c-sync-nc', '1', 'prov-sync-nc', ?, '2026-09-20T10:00:00.000Z', '9001', '0001', 1210, 1210,
                     'pendiente', 'Factura A', 'confirmada', 'pending', ?)`, [uid, now]);
        }""")
        pos.push()
        admin.pull()
        assert uno(admin, "SELECT COUNT(*) AS n FROM compras WHERE id='c-sync-nc'")["n"] == 1, "Admin no recibió la factura"
        assert uno(admin, "SELECT cantidad FROM stock WHERE producto_id='prod-sync-nc'")["cantidad"] == 10, "Admin no tiene el stock"

        print("--- Admin-POS registra la NC A (3 u. a $100 + concepto $100, IVA 21%) aplicada a la factura ---")
        nc = admin.js("""() => {
          const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          return window.SGA_PagosProveedores.crearNotaCredito({
            proveedor_id: 'prov-sync-nc', fecha: '2026-09-22', usuario_id: uid, sucursal_id: '1',
            numero_comprobante: '0001-00777', condicion_nc: 'A', compra_origen_id: 'c-sync-nc',
            imputar_a_compra_id: 'c-sync-nc',
            items: [ { tipo: 'producto', producto_id: 'prod-sync-nc', cantidad: 3, costo_unitario: 100, iva: '21' },
                     { tipo: 'concepto', concepto: 'Bonificación', subtotal: 100, iva: '21' } ] });
        }""")
        assert nc["success"] and nc["total"] == 484, f"NC inesperada (400+100 + 21%): {nc}"
        nc_id = nc["id"]
        admin.push()
        pos.pull()

        print("--- El POS ve la NC completa ---")
        p = uno(pos, """SELECT tipo, numero_comprobante, condicion_nc, compra_origen_id, nc_provisoria,
                               subtotal_neto, iva_21, iva_105, sucursal_id FROM pagos_proveedores WHERE id=?""", [nc_id])
        print(f"pago en el POS: {p}")
        assert p is not None, "BUG: la NC no llegó al POS"
        assert p["tipo"] == "nota_credito" and p["numero_comprobante"] == "0001-00777" and p["condicion_nc"] == "A", (
            f"BUG: applyPagoProveedor no copió los datos propios de la NC: {p}")
        assert p["compra_origen_id"] == "c-sync-nc" and p["subtotal_neto"] == 400 and p["iva_21"] == 84, f"Fiscales de la NC: {p}"
        m = uno(pos, "SELECT metodo, monto FROM pagos_proveedores_metodos WHERE pago_id=?", [nc_id])
        assert m == {"metodo": "nota_credito", "monto": 484}, f"Medio de la NC en el POS: {m}"
        items = pos.q("SELECT tipo, cantidad, subtotal, iva, mueve_stock FROM pagos_proveedores_items WHERE pago_id=? ORDER BY tipo", [nc_id])
        assert len(items) == 2, f"BUG: las líneas de la NC no llegaron al POS: {items}"
        assert uno(pos, "SELECT monto_imputado FROM imputaciones_pagos WHERE pago_id=? AND compra_id='c-sync-nc'", [nc_id])["monto_imputado"] == 484
        assert uno(pos, "SELECT cantidad FROM stock WHERE producto_id='prod-sync-nc'")["cantidad"] == 7, "El stock de la devolución no llegó al POS"
        saldo_pos = pos.js("() => window.SGA_PagosProveedores.getSaldoProveedor('prov-sync-nc')")
        saldo_adm = admin.js("() => window.SGA_PagosProveedores.getSaldoProveedor('prov-sync-nc')")
        assert round(saldo_pos, 2) == round(saldo_adm, 2) == 726, f"Saldos distintos o mal: POS {saldo_pos} / Admin {saldo_adm} (1210 - 484)"
        ledger_pos = pos.js("() => window.SGA_PagosProveedores.getLedger('prov-sync-nc').map(e => e.tipo)")
        assert ledger_pos == ["compra", "nc"], f"El ledger del POS no muestra la NC: {ledger_pos}"

        print("--- Admin-POS anula la NC ---")
        res = admin.js("(id) => window.SGA_PagosProveedores.anularPago(id)", nc_id)
        assert res["success"] and res["esNC"] and res["unidadesRepuestas"] == 3, f"No anuló como esperaba: {res}"
        admin.push()
        pos.pull()
        assert uno(pos, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [nc_id])["n"] == 0, "BUG: la NC anulada SIGUE en el POS"
        assert uno(pos, "SELECT COUNT(*) AS n FROM pagos_proveedores_items WHERE pago_id=?", [nc_id])["n"] == 0, "El POS conserva las líneas de la NC anulada"
        assert uno(pos, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE pago_id=?", [nc_id])["n"] == 0, "El POS conserva la imputación de la NC anulada"
        assert uno(pos, "SELECT cantidad FROM stock WHERE producto_id='prod-sync-nc'")["cantidad"] == 10, "El stock no volvió a 10 en el POS"
        assert pos.js("() => window.SGA_DB.verificarIntegridadStock()") == [], "El stock del POS no cuadra con sus movimientos"
        assert round(pos.js("() => window.SGA_PagosProveedores.getSaldoProveedor('prov-sync-nc')"), 2) == 1210

        print("--- Un Admin-POS NUEVO no la resucita ---")
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        assert uno(nuevo, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [nc_id])["n"] == 0, "BUG: la NC anulada resucitó en un dispositivo nuevo"
        assert uno(nuevo, "SELECT COUNT(*) AS n FROM pagos_proveedores_items WHERE pago_id=?", [nc_id])["n"] == 0

        errs = admin.errores + pos.errores + nuevo.errores
        assert not errs, f"Errores JS: {errs}"
        print("OK - la NC sincroniza completa (datos, líneas, imputación, stock) y anularla también.")


if __name__ == "__main__":
    main()
