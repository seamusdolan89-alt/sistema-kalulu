"""
tests/e2e/test_sync_anular_compra.py — Anular una compra en Admin-POS llega bien
al POS del local (y a un dispositivo nuevo), sin resucitar nada.

Escenario (simulador de dos dispositivos, sync_sim.py): una compra cargada en el
POS (5 unidades de un producto, costo 10 -> 30, con un pago de $100 imputado) sube
a Admin-POS; el dueño la anula ahí (anularCompra). Tiene que viajar:

  - la compra pasa a 'anulada', con su motivo/quién/cuándo (columnas nuevas de
    compras que applyCompra tiene que copiar: una lista de columnas armada a mano);
  - el movimiento de stock de signo contrario llega al POS (el stock vuelve);
  - la imputación liberada desaparece del POS (con marca de borrado) y el pago
    sigue, con su crédito disponible otra vez;
  - el costo revertido llega al producto del POS;
  - un Admin-POS NUEVO (base vacía) no resucita la imputación aunque el documento
    del pago siga en Firestore con ella adentro (guarda por fila en applyPagoProveedor),
    y ve la compra anulada.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_anular_compra.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

IMPORTAR = """async () => {
  await import('/js/modules/cuenta_corriente_proveedores.js');
  window.__ops = (await import('/js/modules/operaciones_stock.js')).default;
}"""


def uno(d, sql, params=None):
    filas = d.q(sql, params or [])
    return filas[0] if filas else None


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        pos.js(IMPORTAR)
        admin.js(IMPORTAR)

        print("--- POS: producto (costo 10), compra de 5 u. a costo 30 y un pago de $100 imputado ---")
        pos.js("""() => {
          const now = new Date().toISOString();
          const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          window.SGA_DB.run(
            `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_pago, activo, sync_status, updated_at)
             VALUES ('prov-sync-ac', 'Proveedor Sync Compra', 'Responsable Inscripto', 'Cta. Cte.', 1, 'pending', ?)`, [now]);
          window.SGA_DB.run(
            `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
               precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
             VALUES ('prod-sync-ac', 'Producto Sync Compra', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]);
          window.SGA_DB.run(
            `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
               total, total_factura, condicion_pago, estado, sync_status, updated_at)
             VALUES ('c-sync-ac', '1', 'prov-sync-ac', ?, '2026-09-20T10:00:00.000Z', '8001', '0001', 150, 150,
                     'pendiente', 'confirmada', 'pending', ?)`, [uid, now]);
          window.SGA_DB.run(
            `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior, subtotal,
               costo_modificado, unidades_por_paquete, tipo)
             VALUES ('c-sync-ac-i', 'c-sync-ac', 'prod-sync-ac', 5, 30, 10, 150, 1, 1, 'producto')`);
          window.SGA_DB.moverStock({ productoId: 'prod-sync-ac', sucursalId: '1', delta: 5, tipo: 'compra',
                                     refTipo: 'compras', refId: 'c-sync-ac', fecha: now });
          window.SGA_DB.run(`UPDATE productos SET costo = 30, sync_status = 'pending', updated_at = ? WHERE id = 'prod-sync-ac'`, [now]);
          window.SGA_PagosProveedores.crearPago({
            proveedor_id: 'prov-sync-ac', fecha: '2026-09-21', usuario_id: uid,
            metodos: [{ metodo: 'transferencia', monto: 100 }] });
        }""")
        assert uno(pos, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE compra_id='c-sync-ac'")["n"] == 1

        print("--- Sube al Admin-POS ---")
        pos.push()
        admin.pull()
        assert uno(admin, "SELECT estado FROM compras WHERE id='c-sync-ac'")["estado"] == "confirmada", "Admin no recibió la compra"
        assert uno(admin, "SELECT cantidad FROM stock WHERE producto_id='prod-sync-ac'")["cantidad"] == 5, "Admin no tiene el stock de la compra"
        assert uno(admin, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE compra_id='c-sync-ac'")["n"] == 1, "Admin no recibió la imputación"
        assert uno(admin, "SELECT costo FROM productos WHERE id='prod-sync-ac'")["costo"] == 30

        print("--- Admin-POS anula la compra ---")
        res = admin.js("() => window.__ops.anularCompra('c-sync-ac', 'Cargada con el proveedor equivocado')")
        print(f"anularCompra: {res}")
        assert res["success"] and res["pagosLiberados"] == 1 and res["costosRevertidos"] == 1, f"No anuló como esperaba: {res}"

        print("--- Admin sube; el POS baja ---")
        admin.push()
        pos.pull()
        c = uno(pos, "SELECT estado, motivo_anulacion, anulada_en, anulada_por FROM compras WHERE id='c-sync-ac'")
        print(f"compra en el POS: {c}")
        assert c["estado"] == "anulada", f"BUG: la anulación no llegó al POS: {c}"
        assert c["motivo_anulacion"] and "equivocado" in c["motivo_anulacion"] and c["anulada_en"] and c["anulada_por"], (
            f"BUG: applyCompra no copió el motivo/quién/cuándo de la anulación: {c}")
        assert uno(pos, "SELECT cantidad FROM stock WHERE producto_id='prod-sync-ac'")["cantidad"] == 0, (
            "BUG: el stock no volvió a 0 en el POS (no llegó el movimiento de reversión)")
        assert uno(pos, "SELECT COUNT(*) AS n FROM stock_movimientos WHERE ref_id='c-sync-ac' AND tipo='anulacion_compra'")["n"] == 1
        assert uno(pos, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE compra_id='c-sync-ac'")["n"] == 0, (
            "BUG: la imputación liberada en Admin-POS SIGUE en el POS")
        assert uno(pos, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE proveedor_id='prov-sync-ac'")["n"] == 1, "El pago no debía borrarse"
        creditos = pos.js("() => window.SGA_PagosProveedores.getCreditosDisponibles('prov-sync-ac')")
        assert len(creditos) == 1 and round(creditos[0]["credito_disponible"], 2) == 100, f"El crédito del pago no volvió en el POS: {creditos}"
        saldo = pos.js("() => window.SGA_PagosProveedores.getSaldoProveedor('prov-sync-ac')")
        assert round(saldo, 2) == -100, f"Saldo del proveedor en el POS tras anular (solo queda el crédito): {saldo}"
        assert uno(pos, "SELECT costo FROM productos WHERE id='prod-sync-ac'")["costo"] == 10, "El costo revertido no llegó al POS"
        assert pos.js("() => window.SGA_DB.verificarIntegridadStock()") == [], "El stock del POS no cuadra con sus movimientos"

        print("--- Un Admin-POS NUEVO ve la compra anulada y no resucita la imputación ---")
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        assert uno(nuevo, "SELECT estado FROM compras WHERE id='c-sync-ac'")["estado"] == "anulada", "El dispositivo nuevo no ve la compra anulada"
        assert uno(nuevo, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE compra_id='c-sync-ac'")["n"] == 0, (
            "BUG: la imputación liberada resucitó en un dispositivo nuevo (falta la guarda por fila en applyPagoProveedor)")
        assert uno(nuevo, "SELECT costo FROM productos WHERE id='prod-sync-ac'")["costo"] == 10, "El dispositivo nuevo no tiene el costo revertido"

        errs = admin.errores + pos.errores + nuevo.errores
        assert not errs, f"Errores JS: {errs}"
        print("OK - anular una compra viaja al otro dispositivo (estado+motivo, stock, imputación, costo) y no resucita.")


if __name__ == "__main__":
    main()
