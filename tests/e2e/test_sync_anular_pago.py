"""
tests/e2e/test_sync_anular_pago.py — Anular un pago a proveedor TAMBIÉN se anula
en el otro dispositivo (POS <-> Admin-POS), y no resucita.

El pago se carga en el POS del local (efectivo, con su egreso en la caja abierta
y aplicado a una factura), sube a Admin-POS, y el dueño lo anula desde Admin-POS
(SGA_PagosProveedores.anularPago). El borrado tiene que viajar con marca:

  - el POS pierde el pago, sus medios, su imputación Y el egreso de su caja;
  - la factura vuelve a figurar pendiente en el POS;
  - un Admin-POS NUEVO (base vacía) que hace el sync inicial no lo resucita, aunque
    el documento viejo siga en Firestore.

Antes las tablas pagos_proveedores y egresos_caja no tenían borrado sincronizado
(ni marca ni guarda `fueEliminado` en su apply*), así que un pago borrado en una
compu reaparecía desde la otra.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_anular_pago.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

CARGAR_MODULO = "async () => { await import('/js/modules/cuenta_corriente_proveedores.js'); }"


def contar(d, tabla, donde="1=1", params=None):
    return d.q(f"SELECT COUNT(*) AS n FROM {tabla} WHERE {donde}", params or [])[0]["n"]


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        pos.js(CARGAR_MODULO)
        admin.js(CARGAR_MODULO)

        print("--- POS: proveedor, factura de $1000, caja abierta y un pago en efectivo de $300 ---")
        info = pos.js("""() => {
          const now = new Date().toISOString();
          const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          window.SGA_DB.run(
            `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_pago, activo, sync_status, updated_at)
             VALUES ('prov-sync-anul', 'Proveedor Sync Anular', 'Responsable Inscripto', 'Cta. Cte.', 1, 'pending', ?)`, [now]);
          window.SGA_DB.run(
            `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
               total, total_factura, condicion_pago, estado, sync_status, updated_at)
             VALUES ('c-sync-anul', '1', 'prov-sync-anul', ?, '2026-09-01T10:00:00.000Z', '7001', '0001', 1000, 1000,
                     'pendiente', 'confirmada', 'pending', ?)`, [usuarioId, now]);
          window.SGA_DB.run(
            `INSERT INTO compra_items (id, compra_id, cantidad, costo_unitario, subtotal, tipo)
             VALUES ('c-sync-anul-i', 'c-sync-anul', 1, 1000, 1000, 'producto')`);
          window.SGA_DB.run(
            `INSERT INTO sesiones_caja (id, sucursal_id, usuario_apertura_id, fecha_apertura, saldo_inicial, estado, sync_status, updated_at)
             VALUES ('ses-sync-anul', '1', ?, ?, 0, 'abierta', 'pending', ?)`, [usuarioId, now, now]);
          const r = window.SGA_PagosProveedores.crearPago({
            proveedor_id: 'prov-sync-anul', fecha: '2026-09-20', usuario_id: usuarioId,
            metodos: [{ metodo: 'efectivo', monto: 300, sesion_caja_id: 'ses-sync-anul' }],
          });
          return { pagoId: r.id, ok: r.success };
        }""")
        assert info["ok"], f"No se pudo crear el pago en el POS: {info}"
        pago = info["pagoId"]
        assert contar(pos, "egresos_caja", "sesion_caja_id='ses-sync-anul'") == 1, "crearPago no dejó el egreso en el POS"

        print("--- POS sube; Admin-POS baja: tiene el pago, su imputación y el egreso ---")
        pos.push()
        admin.pull()
        assert contar(admin, "pagos_proveedores", "id=?", [pago]) == 1, "Admin-POS no recibió el pago"
        assert contar(admin, "imputaciones_pagos", "pago_id=?", [pago]) == 1, "Admin-POS no recibió la imputación"
        assert contar(admin, "egresos_caja", "sesion_caja_id='ses-sync-anul'") == 1, "Admin-POS no recibió el egreso"
        assert contar(admin, "sesiones_caja", "id='ses-sync-anul' AND estado='abierta'") == 1, "Admin-POS no vio la caja abierta"

        print("--- Admin-POS anula el pago (caja abierta: también el egreso) ---")
        res = admin.js("(id) => window.SGA_PagosProveedores.anularPago(id)", pago)
        print(f"anularPago: {res}")
        assert res["success"] and res["egresosRevertidos"] == 1, f"No anuló como esperaba: {res}"
        assert contar(admin, "pagos_proveedores", "id=?", [pago]) == 0
        assert contar(admin, "egresos_caja", "sesion_caja_id='ses-sync-anul'") == 0

        print("--- Admin sube; el POS baja: pierde pago, medios, imputación y egreso ---")
        admin.push()
        pos.pull()
        assert contar(pos, "pagos_proveedores", "id=?", [pago]) == 0, "BUG: el pago anulado en Admin-POS SIGUE en el POS"
        assert contar(pos, "pagos_proveedores_metodos", "pago_id=?", [pago]) == 0, "El POS conserva los medios del pago anulado"
        assert contar(pos, "imputaciones_pagos", "pago_id=?", [pago]) == 0, "El POS conserva la imputación del pago anulado"
        assert contar(pos, "egresos_caja", "sesion_caja_id='ses-sync-anul'") == 0, (
            "BUG: el egreso de caja del pago anulado SIGUE en el POS (la caja esperada quedaría mal)")
        saldo_pos = pos.js("() => window.SGA_PagosProveedores.getSaldoProveedor('prov-sync-anul')")
        assert round(saldo_pos, 2) == 1000, f"En el POS la factura no volvió a quedar pendiente (saldo {saldo_pos})"

        print("--- Un Admin-POS NUEVO no lo resucita (los documentos viejos siguen en Firestore) ---")
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        assert contar(nuevo, "pagos_proveedores", "id=?", [pago]) == 0, "BUG: el pago anulado resucitó en un dispositivo nuevo"
        assert contar(nuevo, "egresos_caja", "sesion_caja_id='ses-sync-anul'") == 0, "BUG: el egreso anulado resucitó en un dispositivo nuevo"

        errs = admin.errores + pos.errores + nuevo.errores
        assert not errs, f"Errores JS: {errs}"
        print("OK - anular un pago viaja al otro dispositivo (pago, imputación y egreso) y no resucita.")


if __name__ == "__main__":
    main()
