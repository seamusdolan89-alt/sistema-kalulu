"""
tests/e2e/test_sync_admin_push_wired.py

Bug real y grave, reportado por el usuario (18/9/2026): el saldo de un
proveedor (Cuenta Corriente) era distinto entre su computadora (Admin-POS) y
la del local (POS) pese a haber "sincronizado" de los dos lados — un pago ya
cargado y sincronizado desde Admin-POS nunca aparecía en el POS.

Causa raíz: el 16/9/2026 (commit "admin-pos sincroniza sola cada 5 min") se
reemplazaron los botones separados "⬇ Pull" / "⬆ Push POS" de Admin-POS por
uno solo ("Sincronizar", `window.SGA_Sync.syncNow()`), y el timer automático
de 5 min pasó a llamar también solo a `syncNow()`. Pero `syncNow()` en modo
admin quedó llamando SOLO a `syncMonitoringData()` (el pull) — `pushToPos()`
(el push de los cambios propios del admin hacia Firestore/POS) se quedó sin
NINGÚN llamador automático; solo dos flujos puntuales (adelanto_pago.js,
clientes.js) lo siguen llamando ellos mismos. Cualquier otro cambio hecho en
Admin-POS (un pago a proveedor, una compra, etc.) quedaba `sync_status =
'pending'` en la base local para siempre: el botón decía "✓ Al día" y el
punto de sync se ponía verde, pero ese cambio nunca llegaba a Firestore ni,
por lo tanto, al POS del local.

Fix en js/sync.js: `syncNow()` en modo admin ahora llama a
`syncMonitoringData()` (pull) Y a `pushToPos()` (push) en el mismo ciclo,
como el botón y el propio código ya decían que hacía.

Este test no puede pasar por Firebase real (bloqueado por block_firebase,
como el resto de la suite) — usa `__testForceInitialized()` (agregado para
este test) para simular "ya conectado" con un Firestore falso mínimo, y
verifica el comportamiento real de punta a punta: un pago a proveedor
sembrado como 'pending' en la base local queda 'synced' después de llamar a
`syncNow()` en modo admin. Verificado a mano además contra dev-kalulu real
(nunca producción) antes de este test.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_admin_push_wired.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


FAKE_FIRESTORE_JS = """
() => {
  // Firestore falso mínimo: alcanza para que syncMonitoringData() (lecturas
  // encadenadas where/orderBy/limit/get, siempre vacío) y pushToPos()/
  // syncAdminSource() (batch de escritura) no exploten, sin tocar la red.
  const collectionCalls = [];
  const emptySnap = { empty: true, size: 0, docs: [] };
  const fakeDb = {
    collection(name) {
      collectionCalls.push(name);
      return {
        where() { return this; },
        orderBy() { return this; },
        limit() { return this; },
        async get() { return emptySnap; },
        doc(id) { return { id, path: name + '/' + id }; },
      };
    },
    batch() {
      return {
        set() {},
        async commit() {},
      };
    },
  };
  window.__fakeFirestoreCalls = collectionCalls;
  window.SGA_Sync.__testForceInitialized(fakeDb);
}
"""


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()

        login_via_seed(page, admin_pos=True, wait_target="productos")

        print("--- Setup: proveedor + pago 'pending' sin subir, como si se acabara de registrar ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(`DELETE FROM pagos_proveedores WHERE id = 'pago-push-test'`);
            window.SGA_DB.run(`
              INSERT INTO proveedores (id, razon_social, activo)
              VALUES ('prov-push-test', 'Proveedor Push Test', 1)
            `);
            window.SGA_DB.run(`
              INSERT INTO pagos_proveedores (id, proveedor_id, fecha, sync_status, updated_at)
              VALUES ('pago-push-test', 'prov-push-test', ?, 'pending', ?)
            `, [now, now]);
            // Remito editado desde Admin-POS (compras_v2 "✏️ Editar"): tambien tiene
            // que subir. 'remitos' no estaba en ADMIN_PUSH_TABLES (sync.js), asi que
            // un remito corregido en Admin-POS quedaba 'pending' para siempre.
            window.SGA_DB.run(`DELETE FROM remitos WHERE id = 'remito-push-test'`);
            window.SGA_DB.run(`
              INSERT INTO remitos (id, proveedor_id, fecha, numero_remito, estado, sync_status, updated_at)
              VALUES ('remito-push-test', 'prov-push-test', '2026-09-18', 'R-PUSH', 'pendiente', 'pending', ?)
            `, [now]);
          }
        """)

        estado_antes = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT sync_status FROM pagos_proveedores WHERE id='pago-push-test'\")[0].sync_status"
        )
        assert estado_antes == 'pending', f"setup mal armado, ya estaba {estado_antes!r}"

        print("--- Simular conexión (sin red real) y correr syncNow() como lo hace el botón/timer ---")
        page.evaluate(FAKE_FIRESTORE_JS)
        page.evaluate("() => window.SGA_Sync.syncNow()")

        estado_despues = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT sync_status FROM pagos_proveedores WHERE id='pago-push-test'\")[0].sync_status"
        )
        assert estado_despues == 'synced', (
            f"BUG: syncNow() en modo admin no subió el pago 'pending' (sync_status quedó "
            f"{estado_despues!r}) — pushToPos() no se está llamando. Esto es exactamente lo que "
            f"le pasó al usuario: un pago cargado en Admin-POS nunca llegaba al POS del local."
        )
        print("OK - syncNow() en modo admin sube (push) los cambios propios, no solo trae (pull)")

        remito_despues = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT sync_status FROM remitos WHERE id='remito-push-test'\")[0].sync_status"
        )
        assert remito_despues == 'synced', (
            f"BUG: un remito 'pending' en Admin-POS no se sube (sync_status quedó {remito_despues!r}) — "
            f"falta 'remitos' en ADMIN_PUSH_TABLES (js/sync.js): editar o vincular un remito desde "
            f"Admin-POS nunca llegaba al POS del local."
        )
        print("OK - un remito 'pending' de Admin-POS también sube")

        calls = page.evaluate("() => window.__fakeFirestoreCalls")
        assert 'pagos_proveedores' in calls, (
            f"esperaba que syncNow() tocara la colección pagos_proveedores (pull y/o push), "
            f"colecciones tocadas: {calls}"
        )
        print(f"OK - colecciones tocadas por syncNow(): {sorted(set(calls))}")

        context.close()
        browser.close()
        print("\nOK - test_sync_admin_push_wired: PASA")


if __name__ == "__main__":
    run()
