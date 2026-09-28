"""
tests/e2e/test_stock_ledger_migracion_legacy.py — Regresion del bug de migracion de
`stock_movimientos` a la etapa 2 del ledger (sync), encontrado ANTES de promover esa
etapa a `main` (sigue solo en `dev`).

Contexto (ver CLAUDE.md, "Stock (18-20/9/2026, ledger completo)"): `js/db.js` migra
`stock_movimientos` (100% local hasta la etapa 1) agregandole `sync_status`/`updated_at`
para que la etapa 2 la sincronice como cualquier tabla:

    ALTER TABLE stock_movimientos ADD COLUMN sync_status TEXT DEFAULT 'pending'
    ALTER TABLE stock_movimientos ADD COLUMN updated_at TEXT

En SQLite, `ALTER TABLE ... ADD COLUMN col DEFAULT 'pending'` le pone ese default a
TODAS las filas que ya existian, no solo a las nuevas. En una base que vena de la
etapa 1, ese historial viejo incluye movimientos tipo 'sync' que `aplicarStockSync`
(ya eliminada, ver commit 397106b) creaba SOLO para que la cache local siguiera
cuadrando con la suma de movimientos cuando llegaba el valor absoluto de `stock` por
el canal viejo — no son un hecho de negocio nuevo, son el reflejo local de algo que YA
viajo por otro lado. Si ese historial queda 'pending', el push generico de esta tabla
lo sube por primera vez y la otra compu lo aplica (INSERT OR IGNORE + recalculo de
cache) como si fuera un movimiento REAL nuevo — descontando dos veces algo que ya
estaba reflejado en su numero actual. Confirmado con este mismo simulador y contra
Firestore real (dev-kalulu): un producto con stock fisico real 7 terminaba en 4 en las
dos compus tras un ciclo completo de sync.

El arreglo (mismo commit que este test): en el MISMO try que agrega la columna, un
UPDATE marca 'synced' todo lo que el ALTER acaba de backfillear a 'pending' — en ese
punto exacto lo unico que puede estar pending es el historial viejo (un movimiento de
esta sesion todavia no existe). Una base NUEVA ya trae sync_status en el CREATE TABLE:
el ALTER tira "column already exists" de una y ni el ALTER de updated_at ni este UPDATE
llegan a correr — correcto, no tiene historial que corregir.

Que prueba este archivo:
  1. `verificar_fix_en_codigo()` — chequeo estatico: el UPDATE existe en js/db.js, en el
     mismo try, INMEDIATAMENTE despues del ALTER que agrega sync_status (antes de que
     cualquier otra cosa de esa carga de la app pueda crear un movimiento nuevo).
  2. Dinamico, con el simulador de dos dispositivos (sync_sim.py): se siembra en CADA
     compu, por SQL directo, el estado que dejaba la etapa 1 antes de este fix — un
     'saldo_inicial' (+10, mismo id deterministico en las dos) y un movimiento real
     'venta' (-3) en una, un 'sync' compensatorio (-3) en la otra — las dos con
     stock.cantidad=7 (el fisico real). Dos escenarios sobre productos distintos:
       - "sin el fix" (sync_status='pending', lo que dejaba el ALTER viejo): un ciclo
         de sync HACE CONVERGER MAL, a 4 — reproduce el bug real de punta a punta.
       - "con el fix" (sync_status='synced', lo que deja el ALTER + UPDATE nuevo): el
         mismo ciclo de sync converge BIEN, a 7, en las dos compus, porque el historial
         viejo nunca se sube (la fila ya estaba 'synced' antes del primer push).
     Nota de diseño: el fix vive en el bloque de migracion de esquema, que solo corre
     UNA vez, cuando la columna se agrega por primera vez — no hay forma de volver a
     ejecutarlo sobre una base que ya tiene la columna (ni con el codigo viejo ni con
     el nuevo: `ALTER ... ADD COLUMN` tira "duplicate column" apenas existe). Por eso
     el escenario "con el fix" siembra directamente el estado POSTERIOR al UPDATE
     (sync_status='synced') en vez de ejecutar el ALTER real sobre una base ya
     inicializada (que ya trae las columnas del CREATE TABLE) — el chequeo estatico
     del punto 1 es lo que ata esta simulacion al codigo real de db.js: si alguien
     borra el UPDATE ahi, este test lo nota igual aunque la parte dinamica no pueda
     "correr" la migracion de nuevo.
     CAVEAT REAL para el dueno (no cubierto por este test, ver CLAUDE.md y el informe
     final de la tarea): esto protege a un dispositivo que TODAVIA no corrio el ALTER
     buggy. Un dispositivo que ya lo corrio SIN el fix (columnas ya creadas, filas ya
     'pending' o ya subidas a Firestore) no se autorepara solo actualizando el codigo
     — hace falta una limpieza de datos puntual. En la practica esto nunca llego a
     produccion (la etapa 2 sigue bloqueada en `dev`), pero pudo haber pasado en
     dispositivos de prueba (dev-kalulu) contra los que se verifico el bug.

Correr (server ya levantado, ver README.md):

    python tests/e2e/test_stock_ledger_migracion_legacy.py
"""
import os
import re
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def verificar_fix_en_codigo():
    """El UPDATE que marca 'synced' el historial viejo tiene que estar en el MISMO
    try que agrega sync_status, justo despues del ALTER (antes del ALTER de
    updated_at y de cualquier otra cosa que pudiera crear un movimiento nuevo)."""
    src = open(os.path.join(REPO_ROOT, "js", "db.js"), encoding="utf-8").read()
    patron = re.compile(
        r"ALTER TABLE stock_movimientos ADD COLUMN sync_status TEXT DEFAULT 'pending'`\);"
        r"\s*database\.run\(`UPDATE stock_movimientos SET sync_status\s*=\s*'synced'"
        r"\s*WHERE sync_status\s*=\s*'pending'`\);"
        r"\s*database\.run\(`ALTER TABLE stock_movimientos ADD COLUMN updated_at TEXT`\);",
        re.MULTILINE,
    )
    assert patron.search(src), (
        "BUG: no encontre en js/db.js, en este orden exacto y en el mismo try, el ALTER "
        "que agrega sync_status seguido del UPDATE que marca 'synced' el historial viejo "
        "y despues el ALTER de updated_at. Sin el UPDATE ahi (o si se mueve despues de "
        "otra cosa que pueda crear un movimiento nuevo), el historial viejo (incluidos "
        "los 'sync' compensatorios de la etapa 1) queda 'pending' y se sube como si fuera "
        "nuevo, duplicando el descuento de stock entre las dos compus."
    )


def stock_de(d, pid, suc):
    r = d.q("SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?", [pid, suc])
    return r[0]["cantidad"] if r else None


def sembrar_estado_etapa1(dev, pid, suc, extra_id, extra_tipo, sync_status_inicial):
    """Reproduce lo que la etapa 1 dejaba en ESTA compu antes de este fix: un
    'saldo_inicial' (+10, id deterministico compartido con la otra compu) y un
    movimiento propio (extra_id/extra_tipo, delta -3) que junto con el saldo inicial
    ya sumaba el fisico real (7). `sync_status_inicial` simula el estado en el que
    queda cada fila justo despues del ALTER de la migracion:
      - 'pending'  -> el ALTER viejo, SIN el UPDATE de este fix (el bug real).
      - 'synced'   -> el ALTER + el UPDATE de este fix (lo que se agrego ahora).
    """
    ts = "2026-09-18T00:00:00.000Z"
    dev.run(
        "INSERT INTO stock_movimientos (id, producto_id, sucursal_id, delta, tipo, fecha, sync_status, updated_at) "
        "VALUES ('saldo_inicial:' || ? || ':' || ?, ?, ?, 10, 'saldo_inicial', ?, ?, ?)",
        [pid, suc, pid, suc, ts, sync_status_inicial, ts],
    )
    dev.run(
        "INSERT INTO stock_movimientos (id, producto_id, sucursal_id, delta, tipo, fecha, sync_status, updated_at) "
        "VALUES (?, ?, ?, -3, ?, ?, ?, ?)",
        [extra_id, pid, suc, extra_tipo, ts, sync_status_inicial, ts],
    )
    dev.run(
        "INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at) "
        "VALUES (?, ?, 7, ?, 'synced', ?)",
        [pid, suc, ts, ts],
    )


def ciclo_de_sync(pos, admin, vueltas=2):
    """Push/pull de las dos puntas, un par de vueltas (como haria la app sola con el
    timer de 5 min de cada superficie, varias veces seguidas)."""
    for _ in range(vueltas):
        pos.push()
        admin.push()
        admin.pull()
        pos.pull()


def main():
    print("--- Chequeo estatico: el UPDATE de la migracion esta donde tiene que estar ---")
    verificar_fix_en_codigo()
    print("OK")

    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        suc = pos.js("() => window.SGA_Auth.getCurrentUser().sucursal_id")

        print("--- Escenario SIN el fix: las filas quedan 'pending' (lo que dejaba el ALTER viejo) ---")
        pid_bug = "prod-legacy-bug"
        sembrar_estado_etapa1(pos, pid_bug, suc, "venta-real-bug", "venta", "pending")
        sembrar_estado_etapa1(admin, pid_bug, suc, "sync-comp-bug", "sync", "pending")
        assert stock_de(pos, pid_bug, suc) == 7 and stock_de(admin, pid_bug, suc) == 7, \
            "las dos compus tienen que arrancar en el fisico real, 7"
        ciclo_de_sync(pos, admin)
        final_pos = stock_de(pos, pid_bug, suc)
        final_admin = stock_de(admin, pid_bug, suc)
        assert sim.store.doc("stock_movimientos", "venta-real-bug") is not None, (
            "sin el fix, el movimiento viejo se tiene que haber subido (esa es la causa del bug)")
        assert final_pos == 4 and final_admin == 4, (
            f"BUG REPRODUCIDO (esto es lo esperado en este escenario): sin el fix, el historial "
            f"viejo se sube y se descuenta dos veces -> pos={final_pos} admin={final_admin} "
            f"(el fisico real es 7). Si esto cambia, algo mas en el motor de sync empezo a "
            f"proteger este caso y hay que revisar este test.")
        print(f"   Confirmado: sin el fix converge MAL a {final_pos} (fisico real: 7)")

        print("--- Escenario CON el fix: las filas quedan 'synced' (lo que deja el ALTER + el UPDATE nuevo) ---")
        pid_ok = "prod-legacy-ok"
        sembrar_estado_etapa1(pos, pid_ok, suc, "venta-real-ok", "venta", "synced")
        sembrar_estado_etapa1(admin, pid_ok, suc, "sync-comp-ok", "sync", "synced")
        assert stock_de(pos, pid_ok, suc) == 7 and stock_de(admin, pid_ok, suc) == 7
        ciclo_de_sync(pos, admin)
        final_pos_ok = stock_de(pos, pid_ok, suc)
        final_admin_ok = stock_de(admin, pid_ok, suc)
        assert sim.store.doc("stock_movimientos", "venta-real-ok") is None, (
            "con el fix, el movimiento viejo de pos NUNCA se tiene que subir (ya estaba 'synced')")
        assert sim.store.doc("stock_movimientos", "sync-comp-ok") is None, (
            "con el fix, el 'sync' compensatorio de admin NUNCA se tiene que subir (ya estaba 'synced')")
        assert final_pos_ok == 7 and final_admin_ok == 7, (
            f"con el fix, las dos compus tienen que converger al fisico real (7): "
            f"pos={final_pos_ok} admin={final_admin_ok}")
        print(f"   OK: con el fix converge BIEN a {final_pos_ok} en las dos compus")

        errs = pos.errores + admin.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_stock_ledger_migracion_legacy")


if __name__ == "__main__":
    main()
