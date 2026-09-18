"""
tests/e2e/test_sync_borradores.py — Los borradores (ventas pausadas del POS y compras
pausadas) se sincronizan y se ven / se borran desde Admin-POS.

Antes pedidos_abiertos y compras_pausadas eran locales a cada compu (sin sync_status ni
fuente de sync). Ademas "Retomar" BORRA el pedido al instante (lo carga al carrito y lo
elimina), asi que el borrado tiene que viajar con marca (registrarEliminacion) o el otro
lado lo seguiria mostrando.

Escenario (simulador de dos dispositivos, sync_sim.py):
  1. La caja pausa una venta -> Admin-POS la ve, con sus items.
  2. Admin-POS la elimina -> desaparece de la caja (y de un Admin-POS nuevo que hace el
     sync inicial: no se resucita).
  3. Compras pausadas: escribe con sync_status='pending' y todo borrado (eliminar o
     consumirla al confirmar la compra) registra la marca de borrado (chequeo sobre el
     codigo: pausar/eliminar viven dentro de una pantalla que no se puede manejar sin UI).

DEUDA CONOCIDA (multi-caja): una SEGUNDA caja POS todavia NO ve lo que pauso la primera.
El motor de sync solo tiene los canales POS->Admin y Admin->POS: el POS solo baja lo que
tiene `_pulled:false` (que solo pone el admin) y sube SIN esa marca, asi que ningun POS
recibe lo de otro POS. Ademas todos los documentos se etiquetan con una sucursal fija
(firebase-config.js SK_SUCURSAL_FIREBASE_ID). Habilitar POS<->POS sin antes tener el
ledger de stock daria stock mal (con dos cajas el ultimo que escribe pisa al otro), asi
que va despues. Este test lo registra: si una segunda caja empieza a ver el borrador, FALLA
para que se saque esta deuda.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_borradores.py
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


def listar(d, sucursal):
    return d.js("(s) => window.SGA_POS.getPedidosAbiertos(s)", sucursal)


def main():
    # --- 4) chequeo estatico de compras pausadas (la UI de compras no es manejable aca) ---
    src = open(os.path.join(REPO_ROOT, "js", "modules", "compras_v2.js"), encoding="utf-8").read()
    ins = re.search(r"INSERT INTO compras_pausadas.*?`", src, re.S).group(0)
    upd = re.search(r"UPDATE compras_pausadas.*?`", src, re.S).group(0)
    assert "sync_status" in ins and "'pending'" in ins, "INSERT de compras_pausadas sin sync_status='pending'"
    assert "sync_status='pending'" in upd, "UPDATE de compras_pausadas sin sync_status='pending' (el cambio no viajaria)"
    borrados = re.findall(r"DELETE FROM compras_pausadas[^\n]*\n([^\n]*)", src)
    assert len(borrados) == 2, f"se esperaban 2 DELETE de compras_pausadas, hay {len(borrados)}"
    assert all("registrarEliminacion('compras_pausadas'" in linea for linea in borrados), (
        f"BUG: un DELETE de compras_pausadas no registra la marca de borrado: {borrados}")
    print("OK compras pausadas: escribe pending y sus 2 borrados (eliminar / consumir al confirmar) llevan marca")

    with Simulador() as sim:
        caja1, admin = sim.pos, sim.admin
        for d in (caja1, admin):
            cargar_pos(d)

        user = caja1.js("() => window.SGA_Auth.getCurrentUser()")
        suc = user["sucursal_id"]

        print("--- La caja pausa una venta ---")
        r = caja1.js("""([s, u]) => window.SGA_POS.pausarVenta({
              sucursalId: s, usuarioId: u, cliente: null, nombre: 'Mesa 4',
              totales: { total: 350 },
              items: [{ productoId: 'p1', nombre: 'Coca 2L', cantidad: 2, precioUnitario: 150 },
                      { productoId: 'p2', nombre: 'Pan', cantidad: 1, precioUnitario: 50 }] })""",
                     [suc, user["id"]])
        assert r["success"], r
        pedido_id = r["pedidoId"]
        caja1.push()

        print("--- Admin-POS la ve, con sus items ---")
        admin.pull()
        lst = listar(admin, suc)
        assert len(lst) == 1 and lst[0]["id"] == pedido_id, (
            f"BUG: Admin-POS no ve la venta pausada en la caja: {lst}")
        assert lst[0]["nombre"] == "Mesa 4" and abs(lst[0]["total"] - 350) < 0.01, lst[0]
        assert [i["nombre"] for i in lst[0]["items"]] == ["Coca 2L", "Pan"], lst[0]["items"]
        print(f"   Admin-POS ve '{lst[0]['nombre']}' con {len(lst[0]['items'])} items")

        print("--- Admin-POS la elimina -> desaparece de la caja ---")
        admin.js("(id) => window.SGA_POS.eliminarPedidoAbierto(id)", pedido_id)
        admin.push()
        caja1.pull()
        lst = listar(caja1, suc)
        assert lst == [], (
            f"BUG: la caja SIGUE mostrando una venta pausada que Admin-POS ya elimino: {lst}")
        print("   la caja ya no la muestra")

        print("--- Un Admin-POS NUEVO (sync inicial) no la resucita ---")
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        cargar_pos(nuevo)
        lst = listar(nuevo, suc)
        assert lst == [], f"BUG: un dispositivo nuevo recibio una venta pausada ya eliminada: {lst}"
        print("   el dispositivo nuevo no la ve")

        print("--- DEUDA multi-caja: una SEGUNDA caja pos ve lo que pauso la primera? ---")
        r2 = caja1.js("""([s, u]) => window.SGA_POS.pausarVenta({
              sucursalId: s, usuarioId: u, cliente: null, nombre: 'Pedido para caja 2',
              totales: { total: 10 }, items: [{ productoId: 'p1', nombre: 'X', cantidad: 1, precioUnitario: 10 }] })""",
                      [suc, user["id"]])
        caja1.push()
        caja2 = sim.nuevo_dispositivo(es_admin=False, nombre="Caja 2")
        cargar_pos(caja2)
        caja2.pull()
        suc2 = caja2.js("() => window.SGA_Auth.getCurrentUser().sucursal_id")
        ve = [p for p in listar(caja2, suc2) if p["id"] == r2["pedidoId"]]
        assert not ve, ("La caja 2 YA recibe los borradores de la caja 1: el canal POS<->POS existe. "
                        "Sacar esta deuda de test_sync_borradores.py y del plan de multi-caja.")
        print("   DEUDA (esperada): la caja 2 todavia no ve el borrador de la caja 1 -> requiere el canal POS<->POS + ledger de stock")

        errs = caja1.errores + admin.errores + nuevo.errores + caja2.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_sync_borradores: los borradores viajan entre la caja y Admin-POS, y su borrado tambien.")


if __name__ == "__main__":
    main()
