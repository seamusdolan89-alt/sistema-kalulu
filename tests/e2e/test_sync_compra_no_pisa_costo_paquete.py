"""
tests/e2e/test_sync_compra_no_pisa_costo_paquete.py — Una compra que cambia el
costo (y el precio de venta) de un producto tiene que llegar COMPLETA al otro
dispositivo, con costo, costo_paquete Y precio_venta correctos.

Bug real reportado por el usuario (3/10/2026, con capturas de un caso real:
"Cebolla"): la cajera cargó una compra en el POS que bajó el costo de Cebolla
de $3.490 a $2.990, y el precio de venta de $5.584 a $4.780 (confirmado en la
pantalla de ajuste de precios). En Admin-POS, al mirar esa compra en Historial
de Compras → Ver, el precio de venta seguía figurando $5.584 (el viejo). En el
Editor de Producto, `costo` (por unidad de venta) sí estaba actualizado a
$2.990, pero `costo_paquete` (por unidad de compra) seguía en $3.490.

Causa raíz (js/sync.js, applyCompra): además de la sincronización propia y
completa de `productos` (applyProductoFull, que SÍ actualiza costo,
costo_paquete, precio_venta y markup_fijo juntos — igual que hacen
commitCompra()/commitCompraEdicion() del lado que confirma la compra),
applyCompra() tenía su PROPIA lógica duplicada y vieja (de mayo/2026, de antes
de que existiera la sincronización completa de productos) que re-derivaba el
costo desde compra_items y lo pisaba con un UPDATE que tocaba SOLO `costo` —
nunca costo_paquete, precio_venta ni markup_fijo.

El daño real no era solo "costo_paquete queda viejo": ese UPDATE parcial
marcaba sync_status='pending' en la fila LOCAL del producto sin que hubiera
ningún cambio real hecho a mano ahí — y como 'compras' se aplica ANTES que
'productos' en cada ciclo de sync (orden fijo, no es una carrera), ese
'pending' fantasma activaba el guard anti-pisada (tienePendienteLocal) de
applyProductoFull() y descartaba en silencio el documento de producto
COMPLETO y correcto que venía en el mismo ciclo. 100% reproducible, no
intermitente: pasa SIEMPRE que una compra con cambio de costo sincroniza.

Fix: se eliminó el UPDATE parcial duplicado de applyCompra() — el costo (con
las 4 columnas) ya viaja solo y completo por la sincronización propia de
'productos'.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_compra_no_pisa_costo_paquete.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador


def uno(d, sql, params=None):
    filas = d.q(sql, params or [])
    return filas[0] if filas else None


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin

        print("--- POS: producto Cebolla, y se sincroniza a Admin-POS ANTES de la compra (ya existía de antes) ---")
        # Clave del bug real: Admin-POS tiene que YA TENER este producto
        # localmente (sync_status='synced', de un sync anterior) para que el
        # UPDATE parcial de applyCompra() encuentre una fila que pisar -- en
        # un producto que Admin-POS nunca vio, ese UPDATE no afecta ninguna
        # fila (no-op) y el INSERT OR REPLACE de applyProductoFull entra
        # igual, sin bug visible. Por eso el escenario real es "producto ya
        # sincronizado de antes + una compra nueva que le cambia el costo".
        pos.js("""() => {
          const now = new Date().toISOString();
          window.SGA_DB.run(
            `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, stock_minimo, unidad_medida,
               unidad_compra, unidades_por_paquete_compra, unidad_venta,
               es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
             VALUES ('prod-sync-cebolla', 'Cebolla', 3490, 3490, 5584, 1, 'unidad',
               'Unidad', 1, 'Unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]);
        }""")
        pos.push()
        admin.pull()
        baseline = uno(admin, "SELECT costo, costo_paquete, precio_venta, sync_status FROM productos WHERE id='prod-sync-cebolla'")
        assert baseline == {"costo": 3490, "costo_paquete": 3490, "precio_venta": 5584, "sync_status": "synced"}, (
            f"Admin-POS debería tener el producto ya sincronizado antes de la compra: {baseline}"
        )
        print(f"   Admin-POS ya tiene el producto (sync previo): {baseline}")

        print("--- POS: cajera confirma una compra que baja el costo y el precio (igual que commitCompra + doSaveRow) ---")
        pos.js("""() => {
          const now = new Date().toISOString();
          const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          window.SGA_DB.run(
            `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_pago, activo, sync_status, updated_at)
             VALUES ('prov-sync-verduleria', 'Verduleria', 'Monotributo', 'Contado', 1, 'pending', ?)`, [now]);
          window.SGA_DB.run(
            `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
               total, total_factura, condicion_pago, condicion_compra, estado, sync_status, updated_at)
             VALUES ('c-sync-cebolla', '1', 'prov-sync-verduleria', ?, ?, '0025', 'B',
                     70432.85, 70432.85, 'efectivo', 'Ticket', 'confirmada', 'pending', ?)`, [uid, now, now]);
          // costo_unitario (de lista) y costo_anterior quedan en compra_items tal
          // cual los carga la cajera -- costo_modificado=1 porque bajó.
          window.SGA_DB.run(
            `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior, subtotal,
               costo_modificado, unidad_compra, unidades_por_paquete, tipo)
             VALUES ('ci-sync-cebolla', 'c-sync-cebolla', 'prod-sync-cebolla', 0.94, 2990, 3490, 2810.60,
                     1, 'Unidad', 1, 'producto')`);
          // Lo que commitCompra() + doSaveRow() dejan en el producto: las 4
          // columnas juntas, en una sola transacción local.
          window.SGA_DB.run(
            `UPDATE productos SET costo=2990, costo_paquete=2990, precio_venta=4780,
               ultima_modificacion_precio=?, sync_status='pending', updated_at=? WHERE id='prod-sync-cebolla'`,
            [now, now]
          );
        }""")
        local = uno(pos, "SELECT costo, costo_paquete, precio_venta FROM productos WHERE id='prod-sync-cebolla'")
        assert local == {"costo": 2990, "costo_paquete": 2990, "precio_venta": 4780}, (
            f"El POS debería tener las 3 columnas ya actualizadas localmente: {local}"
        )

        print("--- Sube al Admin-POS (compras se aplica antes que productos, orden fijo) ---")
        pos.push()
        admin.pull()

        print("--- Verificar que en Admin-POS llegaron las 3 columnas, no solo costo ---")
        remoto = uno(admin, "SELECT costo, costo_paquete, precio_venta, sync_status FROM productos WHERE id='prod-sync-cebolla'")
        print(f"   Admin-POS: {remoto}")
        assert remoto["costo"] == 2990, f"BUG: el costo no llegó actualizado a Admin-POS: {remoto}"
        assert remoto["costo_paquete"] == 2990, (
            f"BUG: costo_paquete se quedó con el valor viejo (3490) -- el UPDATE parcial de applyCompra() "
            f"pisó el documento completo que venía en 'productos': {remoto}"
        )
        assert remoto["precio_venta"] == 4780, (
            f"BUG: precio_venta se quedó con el valor viejo (5584) -- el guard anti-pisada descartó la "
            f"actualización completa del producto: {remoto}"
        )
        assert remoto["sync_status"] == "synced", (
            f"BUG: Admin-POS quedó con sync_status='pending' fantasma (nadie editó nada a mano ahí) -- "
            f"eso dispararía un push de vuelta con datos potencialmente mezclados: {remoto}"
        )

        print("--- La compra en sí también llegó bien (no rompí el resto de applyCompra) ---")
        compra = uno(admin, "SELECT estado, total FROM compras WHERE id='c-sync-cebolla'")
        assert compra["estado"] == "confirmada" and abs(compra["total"] - 70432.85) < 0.01, (
            f"La compra debería haber llegado igual, solo se sacó el UPDATE a productos: {compra}"
        )
        item = uno(admin, "SELECT costo_unitario, costo_modificado FROM compra_items WHERE id='ci-sync-cebolla'")
        assert item and abs(item["costo_unitario"] - 2990) < 0.01 and item["costo_modificado"] == 1, (
            f"compra_items debería seguir viajando completo: {item}"
        )

        errs = admin.errores + pos.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - una compra que cambia costo+precio sincroniza completa (costo, costo_paquete, precio_venta)")


if __name__ == "__main__":
    main()
