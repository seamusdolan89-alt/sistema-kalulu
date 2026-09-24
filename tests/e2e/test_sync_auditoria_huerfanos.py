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

        # ------------------------------------------------------------------
        # "Existe pero desactualizado": el caso real de los remitos de Sueño
        # verde y Maschwitz (24/9/2026) — la fila YA esta en el POS, asi que
        # "falta" no la ve, pero el documento de Firestore es mas nuevo y nunca
        # se aplico (Admin lo subio sin _pulled:false).
        # ------------------------------------------------------------------
        print("--- Desactualizado (Admin->POS): la fila existe, el doc es mas nuevo y sin _pulled ---")
        store_gastos = sim.store.cols["gastos"]
        base = store_gastos["gasto-huerfano-sin-pulled"]  # ya aplicado en el POS (monto 400000)
        assert pos.q("SELECT monto FROM gastos WHERE id = ?", ["gasto-huerfano-sin-pulled"])[0]["monto"] == 400000
        base["monto"] = 500000
        base["updated_at"] = "2026-09-10T10:00:00.000Z"
        base.pop("_pulled", None)
        base.pop("_pulled_at", None)

        print("--- Control 1: doc mas nuevo, pero la fila local tiene un cambio propio SIN subir (pending) ---")
        pos.run("UPDATE gastos SET sync_status = 'pending' WHERE id = ?", ["gasto-huerfano-pulled-true"])
        store_gastos["gasto-huerfano-pulled-true"]["updated_at"] = "2026-09-11T10:00:00.000Z"
        store_gastos["gasto-huerfano-pulled-true"].pop("_pulled", None)

        print("--- Control 2: doc IGUAL al local (sincronizado y sano) ---")
        assert pos.q("SELECT 1 FROM gastos WHERE id = ?", ["gasto-sano-en-cola"]), "el sano deberia haberse aplicado en el pull"

        print("--- Control 3: doc faltante pero con marca de borrado local (borrado a proposito) ---")
        store_gastos["gasto-borrado-a-proposito"] = gasto_dict(
            "gasto-borrado-a-proposito", suc, user_admin["id"], "2026-09-04T10:00:00.000Z")
        pos.js("() => window.SGA_DB.registrarEliminacion('gastos', 'gasto-borrado-a-proposito')")

        print("--- Control 4: coleccion sin columna id (system_config es clave/valor) — no es un faltante ---")
        sim.store.cols.setdefault("system_config", {})["tope_test_auditoria"] = {
            "key": "tope_test_auditoria", "value": "1", "updated_at": "2026-09-05T10:00:00.000Z"}

        res = pos.js("() => window.SGA_Sync.auditarHuerfanosPOS()")
        por_id = {h["id"]: h for h in res}
        assert "gasto-huerfano-sin-pulled" in por_id, f"BUG: no detecto el doc desactualizado: {res}"
        assert por_id["gasto-huerfano-sin-pulled"]["tipo"] == "desactualizado", por_id["gasto-huerfano-sin-pulled"]
        assert por_id["gasto-huerfano-sin-pulled"]["updated_at_local"] == "2026-09-01T10:00:00.000Z"
        assert "gasto-huerfano-pulled-true" not in por_id, (
            f"BUG: marco desactualizado una fila con cambio local sin subir (se le pisaria): {res}")
        assert "gasto-sano-en-cola" not in por_id, f"BUG: marco un doc igual al local: {res}"
        assert "gasto-borrado-a-proposito" not in por_id, (
            f"BUG: marco faltante un registro borrado a proposito (lo resucitaria): {res}")
        assert not [h for h in res if h["collection"] == "system_config"], (
            f"BUG: colecciones sin columna id salen como faltantes falsos: {res}")
        print("   OK - detecta el desactualizado; NO marca pending, iguales, borrados ni claves que no son id")

        print("--- Reparar el desactualizado: el proximo pull lo trae y la fila queda al dia ---")
        n3 = pos.js("(lista) => window.SGA_Sync.repararHuerfanosPOS(lista)",
                    [por_id["gasto-huerfano-sin-pulled"]])
        assert n3 == 1, f"deberia reparar 1, reparo {n3}"
        pos.pull()
        fila = pos.q("SELECT monto, updated_at FROM gastos WHERE id = ?", ["gasto-huerfano-sin-pulled"])[0]
        assert abs(fila["monto"] - 500000) < 0.01, f"BUG: el POS no recibio la version nueva: {fila}"
        res2 = pos.js("() => window.SGA_Sync.auditarHuerfanosPOS(['gastos'])")
        assert "gasto-huerfano-sin-pulled" not in {h["id"] for h in res2}, (
            f"BUG: sigue apareciendo despues de repararlo: {res2}")
        print("   OK - el POS ya tiene la version nueva y la auditoria ya no lo lista")

        print("--- Desactualizado (POS->Admin): fila en Admin vieja, doc mas nuevo con _synced_at viejo ---")
        doc_admin = store_gastos["gasto-huerfano-admin-viejo"]  # ya aplicado en Admin (monto 400000, 2020)
        doc_admin["monto"] = 123
        doc_admin["updated_at"] = "2021-06-01T00:00:00.000Z"
        res_a = admin.js("() => window.SGA_Sync.auditarHuerfanosAdmin(['gastos'])")
        fila_a = [h for h in res_a if h["id"] == "gasto-huerfano-admin-viejo"]
        assert fila_a and fila_a[0]["tipo"] == "desactualizado", (
            f"BUG: Admin no detecto el desactualizado: {res_a}")
        n4 = admin.js("(lista) => window.SGA_Sync.repararHuerfanosAdmin(lista)", fila_a)
        assert n4 == 1, f"deberia aplicar 1, aplico {n4}"
        assert abs(admin.q("SELECT monto FROM gastos WHERE id = ?", ["gasto-huerfano-admin-viejo"])[0]["monto"] - 123) < 0.01
        res_a2 = admin.js("() => window.SGA_Sync.auditarHuerfanosAdmin(['gastos'])")
        assert "gasto-huerfano-admin-viejo" not in {h["id"] for h in res_a2}, (
            f"BUG: Admin lo sigue listando despues de aplicarlo: {res_a2}")
        print("   OK - Admin detecta el desactualizado, lo aplica y ya no lo lista")

        errs = pos.errores + admin.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_sync_auditoria_huerfanos: detecta y repara huérfanos y desactualizados en los dos "
              "sentidos, sin falsos positivos sobre lo que esta sano, recien pusheado, pendiente o borrado.")


if __name__ == "__main__":
    main()
