"""
tests/e2e/test_sync_skip_no_pierde_cambios.py — Regresion: un documento
entrante descartado por la guarda anti-pisada (tienePendienteLocal, cuando
la copia local tiene un cambio propio sin subir) se daba por "entregado"
igual -- el cursor de syncMonitoringData avanzaba y el _pulled de
pullFromFirestore se marcaba true, así que ese cambio remoto se perdía para
siempre en vez de reintentarse en el próximo ciclo.

Reportado por el usuario (16/9/2026): el estado de una Orden de Compra
"muchas veces no viaja", el listado de "activas" quedaba distinto en cada
dispositivo. Investigando: cada UPDATE a ordenes_compra en ordenes.js SÍ
marca sync_status='pending' correctamente (no es el mismo bug que el de
stock del mismo día) -- el problema está más abajo, en el pull: cuando
Admin-POS tenía un cambio propio sin subir sobre una orden justo en el
momento de sincronizar, el cambio que traía de POS se descartaba (correcto,
gana lo local) pero SE PERDÍA PARA SIEMPRE en vez de reintentarse -- porque
tanto el cursor por fecha (admin-pos) como la marca `_pulled` (POS) se
actualizaban sin importar si el applyFn() realmente aplicó algo.

Fix: `ultimoSkipPorPendiente` (sync.js) -- tienePendienteLocal() lo prende
cuando descarta un documento; los dos loops de pull lo leen justo después de
cada applyFn() para decidir si avanzan el cursor / marcan `_pulled`, o si
dejan el documento "sin resolver" para reintentarlo.

Este test no puede ejercitar los loops completos (requieren Firestore real,
bloqueado por block_firebase como el resto de la suite) -- prueba la señal
en sí, llamando applyOrdenCompra() directo con un documento simulado, igual
que test_sync_usuarios_password.py prueba applyUsuarioFull().

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_skip_no_pierde_cambios.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()

        login_via_seed(page)  # POS, sga.db

        print("--- Setup: proveedor + orden local con un cambio propio sin subir ---")
        setup = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;
            window.SGA_DB.run(`DELETE FROM ordenes_compra WHERE id = 'oc-skip-test'`);
            window.SGA_DB.run(`
              INSERT INTO proveedores (id, razon_social, activo)
              VALUES ('prov-skip-test', 'Proveedor Skip Test', 1)
            `);
            // La orden local ya avanzo a 'confirmada' (ej. la cajera la confirmo
            // en POS) y ese cambio todavia no se empujo a Firestore.
            window.SGA_DB.run(`
              INSERT INTO ordenes_compra
                (id, sucursal_id, proveedor_id, usuario_id, fecha_creacion, estado, sync_status, updated_at)
              VALUES ('oc-skip-test', '1', 'prov-skip-test', ?, ?, 'confirmada', 'pending', ?)
            `, [usuarioId, now, now]);
            return { usuarioId };
          }
        """)

        print("--- Un documento entrante (mas viejo/desactualizado) se descarta -- gana lo local ---")
        result_1 = page.evaluate("""
          (usuarioId) => {
            window.SGA_Sync.applyOrdenCompra({
              id: 'oc-skip-test',
              sucursal_id: '1',
              proveedor_id: 'prov-skip-test',
              usuario_id: usuarioId,
              fecha_creacion: new Date().toISOString(),
              estado: 'borrador',  // estado viejo que traeria un pull stale
              updated_at: new Date().toISOString(),
              _items: [],
            });
            const row = window.SGA_DB.query(
              `SELECT estado FROM ordenes_compra WHERE id = 'oc-skip-test'`
            )[0];
            return {
              estado: row.estado,
              skip: window.SGA_Sync.__testUltimoSkipPorPendiente(),
            };
          }
        """, setup["usuarioId"])

        assert result_1["estado"] == "confirmada", (
            f"BUG: el pull piso el estado local sin subir todavia (quedo: {result_1['estado']!r})"
        )
        assert result_1["skip"] is True, (
            "BUG: la guarda descarto el documento pero no prendio ultimoSkipPorPendiente -- "
            "el cursor/marca de 'ya lo traje' avanzaria igual y este cambio se perderia para siempre"
        )
        print("OK: gana lo local Y queda marcado como 'sin resolver' (se reintentara)")

        print("--- Una vez que lo local ya se subio (sync_status='synced'), el pull SI se aplica ---")
        result_2 = page.evaluate("""
          (usuarioId) => {
            window.SGA_DB.run(`UPDATE ordenes_compra SET sync_status = 'synced' WHERE id = 'oc-skip-test'`);
            // Los loops reales resetean la señal antes de cada applyFn(); al
            // llamarla directo hay que hacer lo mismo para no arrastrar el
            // resultado (true) del paso anterior.
            window.SGA_Sync.__testResetUltimoSkipPorPendiente();
            window.SGA_Sync.applyOrdenCompra({
              id: 'oc-skip-test',
              sucursal_id: '1',
              proveedor_id: 'prov-skip-test',
              usuario_id: usuarioId,
              fecha_creacion: new Date().toISOString(),
              estado: 'enviada',
              updated_at: new Date().toISOString(),
              _items: [],
            });
            const row = window.SGA_DB.query(
              `SELECT estado FROM ordenes_compra WHERE id = 'oc-skip-test'`
            )[0];
            return {
              estado: row.estado,
              skip: window.SGA_Sync.__testUltimoSkipPorPendiente(),
            };
          }
        """, setup["usuarioId"])

        assert result_2["estado"] == "enviada", (
            f"El pull deberia aplicarse una vez que no hay cambio local pendiente (quedo: {result_2['estado']!r})"
        )
        assert result_2["skip"] is False, (
            "ultimoSkipPorPendiente deberia quedar en false cuando el documento SI se aplico -- "
            "si no, el cursor/marca nunca avanzarian ni para los casos normales"
        )
        print("OK: sin choque local, el pull se aplica y queda marcado como 'resuelto'")

        browser.close()
        print("\nOK - test_sync_skip_no_pierde_cambios: PASA")


if __name__ == "__main__":
    run()
