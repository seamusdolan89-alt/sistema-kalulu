"""
tests/e2e/test_sync_ajuste_precio_pendiente.py — El "ajuste de precios pendiente"
(compras_v2.js, paso post-compra donde se actualizan precios de venta) ahora
sincroniza entre POS y Admin-POS.

Bug real reportado por el usuario (22-23/9/2026): le pidió explícitamente a una
cajera que pausara una compra ya confirmada en el paso de "Ajuste de Precios"
para poder terminar esa tarea él mismo desde Admin-POS — pero ese estado vivía
SOLO en `localStorage` de la compu donde se pausó (clave 'compras_resumen_pending'),
nunca sincronizaba, así que era literalmente imposible verlo o retomarlo desde
otra máquina. El propio mensaje que veía la cajera al pausar decía "Podés
retomarlo desde Operaciones de Stock" sin aclarar que era "...en esta MISMA
computadora" — eso era la limitación real.

Fix: nueva tabla sincronizable `ajustes_precio_pendientes` (js/db.js), con un id
determinístico `ajuste_precio_pendiente:<sucursal_id>` — un solo pendiente a la
vez por sucursal, mismo comportamiento que tenía la clave única de localStorage
que reemplaza. Registrada en SYNC_SOURCES/PULL_SOURCES/MONITOR_SOURCES/
initialSyncFromFirestore (js/sync.js) y en HIJOS_DE (js/db.js) para que el
borrado (descartar, o consumirlo al terminar) viaje con marca. compras_v2.js y
operaciones_stock.js (banner "Ajuste pendiente") y app.js (badge del menú)
ahora leen/escriben esta tabla en vez de localStorage.

Escenario (simulador de dos dispositivos, sync_sim.py):
  1. El POS pausa un ajuste de precios (como si la cajera lo hiciera) -> Admin-POS
     lo recibe, con el snapshot completo (items, proveedor, totales).
  2. Admin-POS lo descarta -> desaparece del POS también (y de un Admin-POS nuevo
     que hace el sync inicial: no se resucita).
  3. Dirección inversa: Admin-POS pausa uno (confirmó una compra ahí mismo) ->
     el POS lo recibe.
  4. Chequeo estático: el código nuevo en compras_v2.js escribe con
     sync_status='pending' y el DELETE registra la marca de borrado.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_ajuste_precio_pendiente.py
"""
import os
import re
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def cargar_pos(d):
    d.js("async () => { await import('/js/modules/pos.js'); }")


def get_pendiente(d, suc):
    # Un solo pendiente esperado a la vez por sucursal (ver saveAjustePendiente:
    # borra cualquier otro antes de crear uno nuevo) -- id RANDOM, no determinístico
    # (ver comentario en compras_v2.js), así que se busca por sucursal_id.
    rows = d.js(
        "(s) => window.SGA_DB.query('SELECT * FROM ajustes_precio_pendientes WHERE sucursal_id = ?', [s])",
        suc,
    )
    assert len(rows) <= 1, f"debería haber un solo pendiente a la vez por sucursal, hay {len(rows)}: {rows}"
    return rows[0] if rows else None


def escribir_pendiente(d, suc, usuario_id, proveedor):
    import uuid as _uuid
    snapshot = {
        "step": "post-compra",
        "items": [{"productoId": "p1", "nombre": "Coca 2L", "pvActual": 90, "pvSugerido": 95}],
        "herenciaSincs": [],
        "snap": {"proveedorNombre": proveedor, "totalCompra": 1000, "neto": 1000},
    }
    d.js(
        """([id, suc, uid, snap]) => {
              const now = new Date().toISOString();
              window.SGA_DB.run(
                `INSERT OR REPLACE INTO ajustes_precio_pendientes
                   (id, sucursal_id, usuario_id, snapshot, created_at, updated_at, sync_status)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                [id, suc, uid, JSON.stringify(snap), now, now]
              );
           }""",
        [str(_uuid.uuid4()), suc, usuario_id, snapshot],
    )


def descartar_pendiente(d, suc):
    d.js(
        """(s) => {
              const rows = window.SGA_DB.query('SELECT id FROM ajustes_precio_pendientes WHERE sucursal_id = ?', [s]);
              for (const row of rows) {
                window.SGA_DB.run('DELETE FROM ajustes_precio_pendientes WHERE id = ?', [row.id]);
                window.SGA_DB.registrarEliminacion('ajustes_precio_pendientes', row.id);
              }
           }""",
        suc,
    )


def main():
    print("--- Chequeo estatico: compras_v2.js marca 'pending' y registra el borrado ---")
    src = open(os.path.join(REPO_ROOT, "js", "modules", "compras_v2.js"), encoding="utf-8").read()
    save_fn = re.search(r"function saveAjustePendiente.*?\n  \}", src, re.S).group(0)
    clear_fn = re.search(r"function clearAjustePendiente.*?\n  \}", src, re.S).group(0)
    assert "'pending'" in save_fn, f"saveAjustePendiente no marca sync_status='pending': {save_fn}"
    assert "registrarEliminacion('ajustes_precio_pendientes'" in clear_fn, (
        f"clearAjustePendiente no registra la marca de borrado: {clear_fn}"
    )
    assert "DELETE FROM ajustes_precio_pendientes" in clear_fn, clear_fn
    print("OK - saveAjustePendiente/clearAjustePendiente escriben pending y marcan el borrado")

    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        for d in (pos, admin):
            cargar_pos(d)

        user_pos = pos.js("() => window.SGA_Auth.getCurrentUser()")
        suc = user_pos["sucursal_id"]

        print("--- El POS pausa un ajuste de precios (cajera, a pedido del dueño) ---")
        escribir_pendiente(pos, suc, user_pos["id"], "Vital")
        pos.push()

        print("--- Admin-POS lo recibe, con el snapshot completo ---")
        admin.pull()
        row = get_pendiente(admin, suc)
        assert row is not None, "BUG: Admin-POS no recibio el ajuste de precios pendiente del POS"
        assert row["sync_status"] == "synced", f"la fila recibida deberia quedar 'synced': {row}"
        snap = row["snapshot"]
        assert "Vital" in snap, f"el snapshot no trajo el proveedor esperado: {snap}"
        print("   Admin-POS ve el pendiente de 'Vital', con su snapshot completo — ya se puede retomar ahi")

        print("--- Admin-POS lo descarta -> desaparece tambien del POS ---")
        descartar_pendiente(admin, suc)
        admin.push()
        pos.pull()
        assert get_pendiente(pos, suc) is None, "BUG: el POS sigue mostrando un ajuste que Admin-POS ya descarto"
        print("   el POS ya no lo muestra")

        print("--- Un Admin-POS NUEVO (sync inicial) no lo resucita ---")
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        assert get_pendiente(nuevo, suc) is None, "BUG: un dispositivo nuevo recibio un ajuste ya descartado"
        print("   el dispositivo nuevo no lo ve")

        print("--- Direccion inversa: Admin-POS pausa uno (confirmo una compra ahi) -> el POS lo recibe ---")
        user_admin = admin.js("() => window.SGA_Auth.getCurrentUser()")
        escribir_pendiente(admin, suc, user_admin["id"], "Arcor")
        admin.push()
        pos.pull()
        row2 = get_pendiente(pos, suc)
        assert row2 is not None, "BUG: el POS no recibio el ajuste de precios pausado desde Admin-POS"
        assert "Arcor" in row2["snapshot"], row2

        # El del POS anterior ("Vital") ya se habia descartado -- este nuevo
        # ("Arcor") pisa el mismo id (un solo pendiente a la vez por sucursal,
        # mismo comportamiento que la clave unica de localStorage que reemplaza).
        print("   el POS ve el nuevo pendiente de 'Arcor'")

        errs = pos.errores + admin.errores + nuevo.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_sync_ajuste_precio_pendiente: el ajuste de precios pendiente viaja en los dos "
              "sentidos entre POS y Admin-POS, y su borrado tambien.")


if __name__ == "__main__":
    main()
