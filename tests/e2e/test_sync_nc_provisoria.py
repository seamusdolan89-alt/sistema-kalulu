"""
tests/e2e/test_sync_nc_provisoria.py — La NC provisoria de "Producto no entregado"
(que crece con cada aprobación y después se completa con la NC real) llega bien al
otro dispositivo en cada paso.

Escenario (simulador de dos dispositivos, sync_sim.py): la factura A se cargó en el POS;
Admin-POS aprueba dos "Producto no entregado" de esa compra (nace UNA NC provisoria y la
segunda le suma una línea) y después la completa con la NC real (otro N° e importe).

Verifica en el POS, después de cada paso:
  - la provisoria llega con su marca y su importe;
  - al sumarle una línea, el importe nuevo, la línea nueva y la imputación adicional
    llegan (el medio de pago viaja por REPLACE del mismo id: no se duplica);
  - al completarla, el N°, la marca 'no provisoria' y el importe real llegan, y las
    imputaciones viejas (borradas con marca al re-aplicar) NO reaparecen: un Admin-POS
    nuevo tampoco las resucita.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_nc_provisoria.py
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


def estado_nc(d):
    return uno(d, """SELECT p.id, p.nc_provisoria, p.numero_comprobante,
                            (SELECT SUM(m.monto) FROM pagos_proveedores_metodos m WHERE m.pago_id = p.id) AS monto,
                            (SELECT COUNT(*) FROM pagos_proveedores_metodos m WHERE m.pago_id = p.id) AS medios,
                            (SELECT COUNT(*) FROM pagos_proveedores_items i WHERE i.pago_id = p.id) AS lineas,
                            (SELECT COUNT(*) FROM imputaciones_pagos ip WHERE ip.pago_id = p.id) AS imps,
                            (SELECT COALESCE(SUM(ip.monto_imputado), 0) FROM imputaciones_pagos ip WHERE ip.pago_id = p.id) AS imputado
                     FROM pagos_proveedores p WHERE p.tipo = 'nota_credito'""")


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        pos.js(IMPORTAR)
        admin.js(IMPORTAR)

        print("--- POS: factura A de $1210 (10 u. de un producto a $100, IVA 21%) ---")
        pos.js("""() => {
          const now = new Date().toISOString();
          const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          window.SGA_DB.run(
            `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_pago, activo, sync_status, updated_at)
             VALUES ('prov-sync-pr', 'Proveedor Sync Provisoria', 'Responsable Inscripto', 'Cta. Cte.', 1, 'pending', ?)`, [now]);
          window.SGA_DB.run(
            `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
               precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
             VALUES ('prod-sync-pr', 'Producto Sync Prov', 100, 200, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]);
          window.SGA_DB.run(
            `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
               total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
             VALUES ('c-sync-pr', '1', 'prov-sync-pr', ?, '2026-09-20T10:00:00.000Z', '5001', '0001', 1210, 1210,
                     'pendiente', 'Factura A', 'confirmada', 'pending', ?)`, [uid, now]);
          window.SGA_DB.run(
            `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal, iva, unidades_por_paquete, tipo)
             VALUES ('c-sync-pr-i', 'c-sync-pr', 'prod-sync-pr', 10, 100, 1000, '21', 1, 'producto')`);
        }""")
        pos.push()
        admin.pull()

        print("--- Admin-POS: aprueba un 'no entregado' (2 u.): nace la NC provisoria ---")
        r1 = admin.js("""() => window.SGA_PagosProveedores.acreditarNoEntregado(
            { compraId: 'c-sync-pr', productoId: 'prod-sync-pr', cantidad: 2, costoUnitario: 100 })""")
        assert r1["success"] and r1["total"] == 242, f"Primera acreditación: {r1}"
        admin.push()
        pos.pull()
        n = estado_nc(pos)
        print(f"POS tras la 1ra: {n}")
        assert n and n["nc_provisoria"] == 1 and n["monto"] == 242 and n["lineas"] == 1 and n["imputado"] == 242, (
            f"BUG: la NC provisoria no llegó completa al POS: {n}")
        nc_id = n["id"]

        print("--- Segunda aprobación (1 u.): se suma a la MISMA NC ---")
        r2 = admin.js("""() => window.SGA_PagosProveedores.acreditarNoEntregado(
            { compraId: 'c-sync-pr', productoId: 'prod-sync-pr', cantidad: 1, costoUnitario: 100 })""")
        assert r2["success"] and r2["agregada"] and r2["id"] == nc_id and r2["total"] == 363, f"Segunda acreditación: {r2}"
        admin.push()
        pos.pull()
        n = estado_nc(pos)
        print(f"POS tras la 2da: {n}")
        assert n["monto"] == 363 and n["medios"] == 1 and n["lineas"] == 2 and n["imps"] == 2 and n["imputado"] == 363, (
            f"BUG: el POS no vio el importe nuevo / la línea / la imputación adicional (o duplicó el medio): {n}")

        print("--- Admin-POS la completa con la NC real (N° e importe distinto) ---")
        rc = admin.js("""() => window.SGA_PagosProveedores.completarNotaCredito('%s', { numero_comprobante: '0001-00999', total: 350 })""" % nc_id)
        assert rc["success"], f"No se pudo completar: {rc}"
        admin.push()
        pos.pull()
        n = estado_nc(pos)
        print(f"POS tras completar: {n}")
        assert n["nc_provisoria"] == 0 and n["numero_comprobante"] == "0001-00999" and n["monto"] == 350, (
            f"BUG: la NC completada no llegó al POS: {n}")
        assert n["imps"] == 1 and n["imputado"] == 350, (
            f"BUG: las imputaciones viejas reaparecieron en el POS (o la nueva no llegó): {n}")
        saldo = pos.js("() => window.SGA_PagosProveedores.getSaldoProveedor('prov-sync-pr')")
        assert round(saldo, 2) == 1210 - 350, f"Saldo en el POS tras completar: {saldo}"

        print("--- Un Admin-POS NUEVO ve la NC completa y sin imputaciones viejas ---")
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        n = estado_nc(nuevo)
        assert n and n["nc_provisoria"] == 0 and n["monto"] == 350 and n["imps"] == 1 and n["imputado"] == 350, (
            f"BUG: el dispositivo nuevo no ve la NC como quedó (o resucitó imputaciones): {n}")

        errs = admin.errores + pos.errores + nuevo.errores
        assert not errs, f"Errores JS: {errs}"
        print("OK - la NC provisoria crece, se completa y sincroniza bien en cada paso.")


if __name__ == "__main__":
    main()
