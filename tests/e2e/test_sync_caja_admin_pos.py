"""
tests/e2e/test_sync_caja_admin_pos.py — La CAJA tiene que cuadrar igual en el POS y en
Admin-POS cuando los movimientos de plata se cargan desde cualquiera de los dos.

Contexto (18/9/2026): la caja esperada se calcula SUMANDO FILAS (caja.js
getTotalesSesion: saldo inicial + pagos en efectivo de ventas - egresos_caja + ingresos
en efectivo); los contadores sesiones_caja.total_* ya no los lee nadie. Eso esta bien.
El agujero era de sincronizacion: Admin-POS puede escribir esas filas (pagar a un proveedor
en efectivo contra la caja abierta del local -> egresos_caja) pero el POS no tenia receptor
para egresos_caja / ingresos_caja / sesiones_caja / ventas / consumo_interno, asi que la caja
del POS nunca descontaba ese pago y el arqueo del dia daba una diferencia inventada.

Escenarios (con el simulador de dos dispositivos, sync_sim.py):
  1. Un pago en efectivo hecho en Admin-POS baja la caja esperada TAMBIEN en el POS, y las
     dos compus calculan el mismo saldo esperado.
  2. Ese pago NO marca la sesion como 'pending' en Admin-POS (antes incrementaba el
     contador total_egresos): tocar la sesion desde el admin es peligroso porque su copia
     puede estar vieja.
  3. Guarda: una copia vieja de la sesion (abierta) que llega desde el admin NO reabre una
     caja que el POS ya cerro ni le pisa el cierre.
  4. Guarda: una copia del admin sin recuento de billetes NO borra el recuento que la
     cajera tiene en curso en el POS.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_caja_admin_pos.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

CARGAR_MODULOS_JS = """
async () => {
  await import('/js/modules/caja.js');
  await import('/js/modules/cuenta_corriente_proveedores.js');
}
"""


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        for d in (pos, admin):
            d.js(CARGAR_MODULOS_JS)

        print("--- POS: abre caja con $1000 y vende $500 en efectivo ---")
        user = pos.js("() => window.SGA_Auth.getCurrentUser()")
        ses = pos.js("([s, u]) => window.SGA_Caja.abrirCaja(s, u, 1000)", [user["sucursal_id"], user["id"]])
        assert ses["success"], ses
        sesion_id = ses["sesionId"]
        now = "2026-09-18T15:00:00.000Z"
        pos.run("""INSERT INTO ventas (id, sucursal_id, sesion_caja_id, usuario_id, fecha, subtotal, descuento, total,
                     estado, sync_status, updated_at)
                   VALUES ('venta-caja-1', ?, ?, ?, ?, 500, 0, 500, 'completada', 'pending', ?)""",
                [user["sucursal_id"], sesion_id, user["id"], now, now])
        pos.run("INSERT INTO venta_pagos (id, venta_id, medio, monto) VALUES ('vp-caja-1', 'venta-caja-1', 'efectivo', 500)")
        # Un proveedor para pagarle
        pos.run("INSERT INTO proveedores (id, razon_social, activo, sync_status, updated_at) VALUES ('prov-caja-1', 'Proveedor Caja', 1, 'pending', ?)", [now])
        pos.push()
        admin.pull()

        t_pos = pos.js("(id) => window.SGA_Caja.getTotalesSesion(id)", sesion_id)
        t_adm = admin.js("(id) => window.SGA_Caja.getTotalesSesion(id)", sesion_id)
        assert abs(t_pos["saldoEsperado"] - 1500) < 0.01 and abs(t_adm["saldoEsperado"] - 1500) < 0.01, (
            f"punto de partida: esperado 1500 en las dos compus, POS={t_pos['saldoEsperado']} Admin={t_adm['saldoEsperado']}")
        print("   saldo esperado inicial: POS", t_pos["saldoEsperado"], "| Admin", t_adm["saldoEsperado"])

        print("--- Admin-POS: paga $200 en EFECTIVO a un proveedor, contra la caja abierta del local ---")
        admin.run("UPDATE sesiones_caja SET sync_status='synced' WHERE id=?", [sesion_id])  # estado de partida limpio
        r = admin.js("""([prov, ses, uid]) => window.SGA_PagosProveedores.crearPago({
                          proveedor_id: prov, usuario_id: uid, auto_imputar: false,
                          metodos: [{ metodo: 'efectivo', monto: 200, sesion_caja_id: ses }] })""",
                     ["prov-caja-1", sesion_id, user["id"]])
        assert r.get("success"), r

        estado_ses = admin.q("SELECT sync_status FROM sesiones_caja WHERE id=?", [sesion_id])[0]["sync_status"]
        assert estado_ses == "synced", (
            f"BUG: el pago en efectivo desde Admin-POS marco la SESION de caja como '{estado_ses}': "
            f"su copia puede estar vieja y pisar al POS (reabrir una caja cerrada / borrar el recuento).")
        print("   la sesion NO quedo pendiente en Admin-POS (no se toca el contador)")

        admin.push()
        pos.pull()

        t_pos = pos.js("(id) => window.SGA_Caja.getTotalesSesion(id)", sesion_id)
        t_adm = admin.js("(id) => window.SGA_Caja.getTotalesSesion(id)", sesion_id)
        assert abs(t_adm["saldoEsperado"] - 1300) < 0.01, f"Admin: 1000 + 500 - 200 = 1300, es {t_adm['saldoEsperado']}"
        assert abs(t_pos["saldoEsperado"] - 1300) < 0.01, (
            f"BUG: el pago en efectivo de $200 hecho en Admin-POS NO baja la caja esperada del POS "
            f"(POS={t_pos['saldoEsperado']}, Admin={t_adm['saldoEsperado']}): el arqueo del dia da una diferencia inventada.")
        assert abs(t_pos["egresos"] - 200) < 0.01, f"egresos en el POS: {t_pos['egresos']}"
        print("   saldo esperado tras el pago: POS", t_pos["saldoEsperado"], "| Admin", t_adm["saldoEsperado"])

        print("--- Guarda: recuento en curso en el POS y una copia del admin SIN recuento ---")
        pos.run("UPDATE sesiones_caja SET detalle_billetes=?, sync_status='synced' WHERE id=?",
                ['{"1000":1,"500":0}', sesion_id])
        admin.run("UPDATE sesiones_caja SET detalle_billetes=NULL, sync_status='pending', updated_at=? WHERE id=?",
                  ["2026-09-18T16:00:00.000Z", sesion_id])
        admin.push()
        pos.pull()
        billetes = pos.q("SELECT detalle_billetes FROM sesiones_caja WHERE id=?", [sesion_id])[0]["detalle_billetes"]
        assert billetes == '{"1000":1,"500":0}', (
            f"BUG: una copia de la sesion desde Admin-POS le BORRO a la cajera el recuento de billetes en curso: {billetes!r}")
        print("   el recuento en curso del POS se conserva")

        print("--- Guarda: el POS cierra la caja y despues llega una copia vieja 'abierta' del admin ---")
        cierre = pos.js("([id, u]) => window.SGA_Caja.cerrarCaja(id, u, 1300, {})", [sesion_id, user["id"]])
        assert cierre["success"], cierre
        pos.push()
        # el admin todavia tiene la sesion 'abierta' y la toca (ej. autoguarda el recuento)
        admin.run("UPDATE sesiones_caja SET estado='abierta', fecha_cierre=NULL, saldo_final_real=NULL, sync_status='pending', "
                  "updated_at=? WHERE id=?", ["2026-09-18T17:00:00.000Z", sesion_id])
        admin.push()
        pos.pull()
        s = pos.q("SELECT estado, saldo_final_real, fecha_cierre FROM sesiones_caja WHERE id=?", [sesion_id])[0]
        assert s["estado"] == "cerrada" and s["saldo_final_real"] == 1300 and s["fecha_cierre"], (
            f"BUG: una copia vieja 'abierta' desde Admin-POS REABRIO la caja que el POS ya habia cerrado: {s}")
        print("   la caja cerrada sigue cerrada, con su cierre intacto")

        errs = pos.errores + admin.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_sync_caja_admin_pos: la caja cuadra igual en las dos compus y las guardas funcionan.")


if __name__ == "__main__":
    main()
