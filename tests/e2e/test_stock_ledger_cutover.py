"""
tests/e2e/test_stock_ledger_cutover.py — Herramientas de reconciliacion del saldo inicial
del ledger de stock (`SGA_Sync.diagnosticarSaldoInicial` / `prepararAdopcionLedger`),
necesarias para el corte real de la etapa 2 en produccion.

Contexto: la etapa 1 (18/9/2026) corrio `backfillSaldoInicial()` en CADA compu por
separado, cada una con SU `stock.cantidad` de ese momento — y en ese momento
`stock_movimientos` todavia NO sincronizaba, asi que nadie lo noto. El id de ese
movimiento es DETERMINISTICO ('saldo_inicial:<producto>:<sucursal>', no un uuid al azar):
si en algun producto los dos numeros no coincidian, hoy cada compu tiene su propio
'saldo_inicial' en conflicto, y sincronizar solo no lo arregla — aplicar un movimiento
que llega es siempre INSERT OR IGNORE (nunca pisa uno que ya existe LOCALMENTE).

Ademas: Admin-POS nunca sube su PROPIO 'saldo_inicial' (adminPushWhereExtra en
SYNC_SOURCES) — el POS del local es la fuente autoritativa. Este test lo verifica
directo contra el store del simulador (lo que de verdad quedo en "Firestore").

Casos:
  - Sin divergencia: diagnosticarSaldoInicial() da [].
  - Con divergencia real (simulando lo que paso en produccion: las dos compus corrieron
    backfillSaldoInicial con un stock.cantidad distinto para el mismo producto):
      * Admin-POS empuja su cambio pero el 'saldo_inicial' NUNCA sale hacia Firestore.
      * el diagnostico encuentra la diferencia (local de admin vs. remoto = el del POS).
      * prepararAdopcionLedger() en Admin-POS resuelve: abandona su copia y adopta la
        del POS, dejando la integridad y el diagnostico limpios.
  - Guarda: prepararAdopcionLedger() se niega a correr en el POS.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_stock_ledger_cutover.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador


def stock_de(d, pid, suc):
    r = d.q("SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?", [pid, suc])
    return r[0]["cantidad"] if r else None


def integridad(d):
    return d.js("() => window.SGA_DB.verificarIntegridadStock()")


def sembrar_saldo_inicial(dev, pid, suc, delta):
    """Simula lo que backfillSaldoInicial() ya hizo de verdad en produccion, en la etapa 1,
    ANTES de que stock_movimientos sincronizara — cada compu con su propio numero."""
    ts = "2026-09-18T00:00:00.000Z"
    dev.run(
        "INSERT INTO stock_movimientos (id, producto_id, sucursal_id, delta, tipo, fecha, sync_status, updated_at) "
        "VALUES ('saldo_inicial:' || ? || ':' || ?, ?, ?, ?, 'saldo_inicial', ?, 'pending', ?)",
        [pid, suc, pid, suc, delta, ts, ts],
    )
    dev.run(
        "INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at) "
        "VALUES (?, ?, ?, ?, 'synced', ?)",
        [pid, suc, delta, ts, ts],
    )


def diagnostico(d):
    return d.js("async () => await window.SGA_Sync.diagnosticarSaldoInicial()")


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        suc = pos.js("() => window.SGA_Auth.getCurrentUser().sucursal_id")

        print("--- Sin divergencia: las dos compus ya tenian el mismo saldo inicial ---")
        sembrar_saldo_inicial(pos, "prod-ok", suc, 10)
        sembrar_saldo_inicial(admin, "prod-ok", suc, 10)
        pos.push()
        admin.push()
        diffs = diagnostico(pos)
        assert not any(d["id"].startswith("saldo_inicial:prod-ok:") for d in diffs), (
            f"prod-ok coincide en las dos compus, no deberia aparecer: {diffs}")
        print("   OK: sin diferencias para ese producto")

        print("--- Con divergencia real: POS dice 20, Admin-POS (por su cuenta) dice 15 ---")
        sembrar_saldo_inicial(pos, "prod-div", suc, 20)
        sembrar_saldo_inicial(admin, "prod-div", suc, 15)
        id_div = f"saldo_inicial:prod-div:{suc}"
        pos.push()
        admin.push()

        print("--- Admin-POS nunca sube SU PROPIO saldo inicial (queda el del POS en 'Firestore') ---")
        doc = sim.store.doc("stock_movimientos", id_div)
        assert doc is not None, f"el documento {id_div} tendria que existir (lo subio el POS)"
        assert doc["delta"] == 20, f"BUG: en 'Firestore' quedo {doc['delta']}, tendria que ser 20 (el del POS), nunca 15 (el de admin)"
        print("   OK: en 'Firestore' quedo el 20 del POS")

        print("--- El diagnostico encuentra la divergencia ---")
        diffs = diagnostico(admin)
        fila = next((d for d in diffs if d["id"] == id_div), None)
        assert fila is not None, f"el diagnostico deberia encontrar {id_div}: {diffs}"
        assert fila["local"] == 15 and fila["remoto"] == 20, fila
        print(f"   OK: encontrada -> local(admin)={fila['local']} remoto(POS)={fila['remoto']}")

        print("--- Guarda: prepararAdopcionLedger() se niega a correr en el POS ---")
        err = pos.js("""async () => {
          try { await window.SGA_Sync.prepararAdopcionLedger(); return null; }
          catch (e) { return e.message; }
        }""")
        assert err and "Admin-POS" in err, f"tendria que rechazar correr en el POS: {err!r}"
        assert stock_de(pos, "prod-div", suc) == 20, "no se tiene que haber tocado nada en el POS"
        print(f"   OK: rechazado -> {err!r}")

        print("--- prepararAdopcionLedger() en Admin-POS adopta el saldo inicial del POS ---")
        r = admin.js("async () => await window.SGA_Sync.prepararAdopcionLedger()")
        assert r["saldosAbandonadosLocal"] >= 1, r
        assert stock_de(admin, "prod-div", suc) == 20, (
            f"admin tiene que terminar en 20 (el del POS), es {stock_de(admin, 'prod-div', suc)}")
        fila_local = admin.q("SELECT delta FROM stock_movimientos WHERE id=?", [id_div])
        assert fila_local and fila_local[0]["delta"] == 20, (
            f"la fila local de admin tiene que ser la del POS ahora: {fila_local}")
        assert integridad(admin) == [], integridad(admin)
        print("   OK: admin adopto 20, integridad ok")

        print("--- El diagnostico ya no encuentra diferencias para ese producto ---")
        diffs = diagnostico(admin)
        assert not any(d["id"] == id_div for d in diffs), f"deberia haberse resuelto: {diffs}"
        print("   OK: []")

        errs = pos.errores + admin.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_stock_ledger_cutover")


if __name__ == "__main__":
    main()
