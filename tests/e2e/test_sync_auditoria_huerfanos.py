"""
tests/e2e/test_sync_auditoria_huerfanos.py — Auditoría y reparación de
documentos "huérfanos": un documento que Firestore marca como ya entregado,
pero que del otro lado NUNCA se llegó a aplicar — invisible para siempre
porque el ciclo normal de sync ya no lo vuelve a pedir.

Confirmado real dos veces en producción (23/9/2026): un pago de Arcor y un
gasto de $400.000 de Hugo Altamirano, ambos de antes del 16/9/2026 (el bug
grave de sync de esos días), quedaron así — el saldo de esos proveedores no
coincidía entre POS y Admin-POS pese a "sincronizar" mil veces.

El mecanismo es distinto según el sentido:
  - Admin -> POS: pullFromFirestore() filtra `_pulled == false`. Un documento
    con `_pulled: true` (aplicado con una guarda vieja, antes del fix de
    ultimoSkipPorPendiente del 16/9) o directamente sin ese campo (push de
    antes de que existiera) nunca vuelve a matchear esa consulta.
  - POS -> Admin: syncMonitoringData() avanza un cursor por `_synced_at`; si
    el documento de una tanda tira una excepción real al aplicarse pero uno
    POSTERIOR de la misma tanda se aplica bien, el cursor avanza igual más
    allá del que falló.

Fix: js/sync.js expone 4 funciones nuevas (auditarHuerfanosPOS/Admin,
repararHuerfanosPOS/Admin) — de solo lectura el diagnóstico, y la reparación
solo actúa sobre la lista que el propio diagnóstico devolvió.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_auditoria_huerfanos.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador


def gasto_dict(id_, suc, usuario_id, updated_at, extra=None):
    d = {
        "id": id_, "sucursal_id": suc, "usuario_id": usuario_id,
        "fecha": "2026-09-01", "categoria": "mantenimiento",
        "descripcion": "Test huerfano", "monto": 400000,
        "metodo_pago": "cuenta_corriente", "proveedor_id": "prov-huerfano-test",
        "comprobante": None, "subtotal_neto": None, "iva_alicuota": None,
        "iva_monto": None, "iibb_monto": None, "periodo": None, "subcategoria": None,
        "observaciones": None,
        "updated_at": updated_at, "sync_status": "synced",
    }
    if extra:
        d.update(extra)
    return d


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin

        user_pos = pos.js("() => window.SGA_Auth.getCurrentUser()")
        user_admin = admin.js("() => window.SGA_Auth.getCurrentUser()")
        suc = user_pos["sucursal_id"]

        print("--- Direccion Admin->POS: plantar un huerfano real (push viejo, SIN _pulled) ---")
        sim.store.cols.setdefault("gastos", {})["gasto-huerfano-sin-pulled"] = gasto_dict(
            "gasto-huerfano-sin-pulled", suc, user_admin["id"], "2026-09-01T10:00:00.000Z"
        )
        print("--- Y otro con _pulled:true puesto a mano (guarda vieja que lo descarto) ---")
        sim.store.cols["gastos"]["gasto-huerfano-pulled-true"] = gasto_dict(
            "gasto-huerfano-pulled-true", suc, user_admin["id"], "2026-09-02T10:00:00.000Z",
            extra={"_pulled": True, "_pulled_at": "2026-09-02T10:05:00.000Z"},
        )
        print("--- Y uno sano: _pulled:false, en cola normal (NO deberia salir como huerfano) ---")
        sim.store.cols["gastos"]["gasto-sano-en-cola"] = gasto_dict(
            "gasto-sano-en-cola", suc, user_admin["id"], "2026-09-03T10:00:00.000Z",
            extra={"_pulled": False},
        )

        huerfanos_pos = pos.js("() => window.SGA_Sync.auditarHuerfanosPOS()")
        ids_encontrados = {h["id"] for h in huerfanos_pos if h["collection"] == "gastos"}
        assert "gasto-huerfano-sin-pulled" in ids_encontrados, (
            f"BUG: no detecto el huerfano sin _pulled: {huerfanos_pos}")
        assert "gasto-huerfano-pulled-true" in ids_encontrados, (
            f"BUG: no detecto el huerfano con _pulled:true: {huerfanos_pos}")
        assert "gasto-sano-en-cola" not in ids_encontrados, (
            f"BUG: marco como huerfano uno que esta sano, en cola normal: {huerfanos_pos}")
        print(f"   OK - detecto los 2 huerfanos reales y NO el sano ({len(huerfanos_pos)} huerfanos totales)")

        print("--- El filtro soloColecciones acota el barrido (para no gastar cuota de mas) ---")
        acotado = pos.js("() => window.SGA_Sync.auditarHuerfanosPOS(['ventas'])")
        assert acotado == [], f"Con soloColecciones=['ventas'] no deberia mirar 'gastos' en absoluto: {acotado}"
        acotado2 = pos.js("() => window.SGA_Sync.auditarHuerfanosPOS(['gastos'])")
        assert {h['id'] for h in acotado2} == ids_encontrados, (
            f"Con soloColecciones=['gastos'] deberia encontrar los mismos huerfanos que el barrido completo: {acotado2}"
        )
        print("   OK - acotar a una coleccion funciona y no rompe el resultado")

        print("--- Reparar: marca _pulled:false, el proximo pull normal los trae ---")
        lista_gastos = [h for h in huerfanos_pos if h["collection"] == "gastos"
                        and h["id"] in ("gasto-huerfano-sin-pulled", "gasto-huerfano-pulled-true")]
        n = pos.js("(lista) => window.SGA_Sync.repararHuerfanosPOS(lista)", lista_gastos)
        assert n == 2, f"deberian repararse 2, reparo {n}"

        pos.pull()
        r1 = pos.q("SELECT id FROM gastos WHERE id = ?", ["gasto-huerfano-sin-pulled"])
        r2 = pos.q("SELECT id FROM gastos WHERE id = ?", ["gasto-huerfano-pulled-true"])
        assert r1 and r2, f"BUG: siguen sin aparecer en el POS tras reparar+pull: {r1} {r2}"
        print("   OK - los dos huerfanos ya estan en el POS despues de reparar")

        print("--- Direccion POS->Admin: plantar un huerfano real (_synced_at viejo, nunca aplicado) ---")
        sim.store.cols["gastos"]["gasto-huerfano-admin-viejo"] = gasto_dict(
            "gasto-huerfano-admin-viejo", suc, user_pos["id"], "2020-01-01T00:00:00.000Z",
            extra={"_synced_at": "2020-01-01T00:00:00.000Z", "_sucursal": "sucursal-1"},
        )
        print("--- Y uno recien pusheado (_synced_at de ahora), todavia sin su ciclo -- NO es huerfano ---")
        ahora = admin.js("() => new Date().toISOString()")
        sim.store.cols["gastos"]["gasto-recien-pusheado"] = gasto_dict(
            "gasto-recien-pusheado", suc, user_pos["id"], ahora,
            extra={"_synced_at": ahora, "_sucursal": "sucursal-1"},
        )

        huerfanos_admin = admin.js("() => window.SGA_Sync.auditarHuerfanosAdmin()")
        ids_admin = {h["id"] for h in huerfanos_admin if h["collection"] == "gastos"}
        assert "gasto-huerfano-admin-viejo" in ids_admin, (
            f"BUG: no detecto el huerfano viejo del lado admin: {huerfanos_admin}")
        assert "gasto-recien-pusheado" not in ids_admin, (
            f"BUG: marco como huerfano uno recien pusheado, todavia dentro de su ventana normal: {huerfanos_admin}")
        print(f"   OK - detecto el huerfano viejo y NO el recien pusheado ({len(huerfanos_admin)} huerfanos totales)")

        print("--- Reparar del lado admin: aplica el documento directo, sin tocar Firestore ---")
        lista_admin = [h for h in huerfanos_admin if h["id"] == "gasto-huerfano-admin-viejo"]
        n2 = admin.js("(lista) => window.SGA_Sync.repararHuerfanosAdmin(lista)", lista_admin)
        assert n2 == 1, f"deberia reparar 1, reparo {n2}"
        row = admin.q("SELECT id, monto FROM gastos WHERE id = ?", ["gasto-huerfano-admin-viejo"])
        assert row and abs(row[0]["monto"] - 400000) < 0.01, f"BUG: no quedo aplicado en Admin-POS: {row}"
        print("   OK - el huerfano ya esta en Admin-POS despues de reparar")

        errs = pos.errores + admin.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_sync_auditoria_huerfanos: detecta y repara huérfanos en los dos sentidos, "
              "sin falsos positivos sobre lo que esta sano o recien pusheado.")


if __name__ == "__main__":
    main()
