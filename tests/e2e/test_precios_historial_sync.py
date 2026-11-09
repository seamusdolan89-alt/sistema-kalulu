"""
tests/e2e/test_precios_historial_sync.py

Historial de cambios de costo/precio (precios_historial, 9/11/2026) entre DOS dispositivos reales
(POS + Admin-POS) sobre un Firestore falso. Es un test de ESCENARIO, no de tabla suelta: el riesgo
de este registro es justo la interaccion con la sincronizacion de `productos`.

Lo que NO puede pasar (y lo que si):
  1. Un cambio de precio hecho en el POS se registra UNA vez, en el POS.
  2. Al llegar a Admin-POS el producto (INSERT OR REPLACE, sin disparar el trigger) y el registro
     (INSERT OR IGNORE), Admin-POS tiene EXACTAMENTE esa fila -- con el mismo id --, no una
     segunda "inventada" por aplicar el cambio de producto.
  3. Sincronizar de nuevo, en cualquier direccion, no duplica nada.
  4. Un cambio hecho en Admin-POS viaja al POS igual (los dos lados terminan con las mismas filas).
  5. Un dispositivo NUEVO (base vacia) recibe todo el historial en el sync inicial.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_precios_historial_sync.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

HIST = ("SELECT id, producto_id, origen, ref_tipo, ref_id, precio_anterior, precio_nuevo, "
        "costo_anterior, costo_nuevo, sync_status FROM precios_historial "
        "WHERE producto_id = 'prod-hist' ORDER BY fecha, id")


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin

        print("--- POS: producto nuevo (sin historial todavia), sincronizado a Admin-POS ---")
        pos.js("""() => {
          const now = new Date().toISOString();
          window.SGA_DB.run(
            `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, stock_minimo, unidad_medida,
               unidad_compra, unidades_por_paquete_compra, unidad_venta,
               es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
             VALUES ('prod-hist', 'Producto historial', 100, 100, 150, 1, 'unidad',
               'Unidad', 1, 'Unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]);
        }""")
        pos.push()
        admin.pull()
        assert admin.q("SELECT COUNT(*) AS n FROM productos WHERE id='prod-hist'")[0]["n"] == 1, "Admin-POS no recibio el producto"
        assert admin.q(HIST) == [], f"Alta por sync no debe generar historial en Admin-POS: {admin.q(HIST)}"

        print("--- POS: cambia el precio (150 -> 200) con origen 'editor' ---")
        pos.js("""() => window.SGA_DB.conOrigenCambio({ origen: 'editor', detalle: 'prueba' }, () =>
          window.SGA_DB.run(`UPDATE productos SET precio_venta = 200, sync_status='pending', updated_at=? WHERE id='prod-hist'`,
                            [new Date().toISOString()]))""")
        en_pos = pos.q(HIST)
        assert len(en_pos) == 1, f"El POS debe registrar el cambio UNA vez: {en_pos}"
        assert en_pos[0]["origen"] == "editor" and en_pos[0]["precio_anterior"] == 150 and en_pos[0]["precio_nuevo"] == 200, en_pos
        assert en_pos[0]["sync_status"] == "pending", f"Debe quedar pendiente de subir: {en_pos}"

        print("--- Sube al Admin-POS: el producto cambia SIN generar un registro propio ---")
        pos.push()
        admin.pull()
        precio_admin = admin.q("SELECT precio_venta FROM productos WHERE id='prod-hist'")[0]["precio_venta"]
        assert precio_admin == 200, f"El precio no llego a Admin-POS: {precio_admin}"
        en_admin = admin.q(HIST)
        assert len(en_admin) == 1, (
            f"BUG: Admin-POS tiene {len(en_admin)} filas de historial (debe tener exactamente la 1 que "
            f"vino del POS). Aplicar el producto (INSERT OR REPLACE) no deberia crear un registro propio: {en_admin}")
        assert en_admin[0]["id"] == en_pos[0]["id"], f"Debe ser la MISMA fila (mismo id): {en_admin[0]['id']} vs {en_pos[0]['id']}"
        assert en_admin[0]["sync_status"] == "synced", en_admin

        print("--- Ciclos repetidos en las dos direcciones: no se duplica nada ---")
        for _ in range(2):
            admin.push(); pos.pull(); pos.push(); admin.pull()
        assert len(pos.q(HIST)) == 1 and len(admin.q(HIST)) == 1, (
            f"BUG: sincronizar de nuevo duplico filas: POS={len(pos.q(HIST))} Admin={len(admin.q(HIST))}")

        print("--- Admin-POS cambia el COSTO (100 -> 120) con origen 'compra' y sube al POS ---")
        admin.js("""() => window.SGA_DB.conOrigenCambio({ origen: 'compra', refTipo: 'compras', refId: 'c-hist' }, () =>
          window.SGA_DB.run(`UPDATE productos SET costo = 120, costo_paquete = 120, sync_status='pending', updated_at=? WHERE id='prod-hist'`,
                            [new Date().toISOString()]))""")
        assert len(admin.q(HIST)) == 2, f"Admin-POS debe registrar su propio cambio: {admin.q(HIST)}"
        admin.push()
        pos.pull()
        en_pos = pos.q(HIST)
        en_admin = admin.q(HIST)
        assert len(en_pos) == 2 and len(en_admin) == 2, f"Los dos lados deben tener 2 filas: POS={len(en_pos)} Admin={len(en_admin)}"
        assert [r["id"] for r in en_pos] == [r["id"] for r in en_admin], "Las dos compus deben tener las MISMAS filas (mismos ids)"
        compra = [r for r in en_pos if r["origen"] == "compra"]
        assert compra and compra[0]["ref_id"] == "c-hist" and compra[0]["costo_anterior"] == 100 and compra[0]["costo_nuevo"] == 120, en_pos
        assert pos.q("SELECT costo FROM productos WHERE id='prod-hist'")[0]["costo"] == 120, "El costo nuevo debe llegar al POS"

        print("--- Un dispositivo NUEVO (base vacia) recibe todo el historial en el sync inicial ---")
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin nuevo")
        nuevo.sync_inicial()
        en_nuevo = nuevo.q(HIST)
        assert [r["id"] for r in en_nuevo] == [r["id"] for r in en_pos], (
            f"El dispositivo nuevo debe tener las mismas 2 filas: {[r['id'] for r in en_nuevo]}")

        for d in (pos, admin, nuevo):
            assert not d.errores, f"Errores JS en {d.nombre}: {d.errores}"

        print("\nOK - test_precios_historial_sync: PASA")


if __name__ == "__main__":
    main()
