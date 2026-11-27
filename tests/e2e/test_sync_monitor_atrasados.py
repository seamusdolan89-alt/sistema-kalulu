"""
tests/e2e/test_sync_monitor_atrasados.py — Admin-POS no saltea documentos que llegan atrasados.

El cursor de Admin-POS avanza por `_synced_at`, que pone el reloj de la compu que sube. Un documento
que llega a la nube con una hora anterior al cursor (reloj atrasado, subida demorada) no se pedía
nunca más. Ahora cada ciclo relee los últimos 20 minutos y una vez por día los últimos 3 días.

Correr (server en :8765):  python tests/e2e/test_sync_monitor_atrasados.py
"""
import os
import sys
from datetime import datetime, timedelta, timezone

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador


def hace(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def main():
    with Simulador() as sim:
        prov = sim.pos.q("SELECT id FROM proveedores LIMIT 1")[0]["id"]
        sim.pos.sincronizar()
        sim.admin.sincronizar()
        sim.admin.sincronizar()

        def pago(disp, id_):
            disp.run("INSERT INTO pagos_proveedores (id, proveedor_id, fecha, sync_status, updated_at) "
                     "VALUES (?, ?, '2026-01-01', 'pending', ?)", [id_, prov, hace()])
            disp.run("INSERT INTO pagos_proveedores_metodos (id, pago_id, metodo, monto) VALUES (?, ?, 'transferencia', 1)",
                     ["m-" + id_, id_])
            disp.push()

        def llego(id_):
            return len(sim.admin.q("SELECT 1 AS x FROM pagos_proveedores WHERE id = ?", [id_])) == 1

        # Admin lee un pago propio: el cursor queda en "ahora"
        pago(sim.admin, "propio")
        sim.admin.sincronizar()
        sim.admin.sincronizar()

        pago(sim.pos, "atrasado-10min")
        sim.store.doc("pagos_proveedores", "atrasado-10min")["_synced_at"] = hace(minutes=10)
        sim.admin.sincronizar()
        assert llego("atrasado-10min"), "Un documento 10 minutos atrasado no llego"
        print("OK - reloj atrasado / subida demorada: llega en el ciclo siguiente")

        pago(sim.pos, "atrasado-5h")
        sim.store.doc("pagos_proveedores", "atrasado-5h")["_synced_at"] = hace(hours=5)
        sim.admin.sincronizar()
        assert not llego("atrasado-5h"), "Escenario mal armado: no deberia llegar antes del barrido diario"
        sim.admin.js("(v) => localStorage.setItem('admin_monitor_barrido_at', v)", hace(hours=25))
        sim.admin.sincronizar()
        assert llego("atrasado-5h"), "El barrido diario no trajo el documento atrasado horas"
        assert sim.admin.js("() => localStorage.getItem('admin_monitor_barrido_at')") > hace(minutes=5)
        print("OK - demora larga: llega con el barrido diario")

        # Releer no duplica ni revive
        sim.admin.js("() => window.SGA_PagosProveedores || import('/js/modules/cuenta_corriente_proveedores.js')")
        r = sim.admin.js("() => window.SGA_PagosProveedores.anularPago('atrasado-10min')")
        assert r["success"], r
        sim.admin.sincronizar()
        sim.admin.sincronizar()
        assert not llego("atrasado-10min"), "La relectura revivio un pago anulado"
        n = sim.admin.q("SELECT COUNT(*) AS n FROM pagos_proveedores_metodos WHERE pago_id = 'atrasado-5h'")[0]["n"]
        assert n == 1, n
        print("OK - releer no duplica ni revive anulados")
        assert not sim.admin.errores, sim.admin.errores
    print("\nTODO OK — test_sync_monitor_atrasados")


if __name__ == "__main__":
    main()
