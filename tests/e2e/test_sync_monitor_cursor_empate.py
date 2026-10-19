"""
tests/e2e/test_sync_monitor_cursor_empate.py — valida el fix de syncMonitoringData
(19/10/2026): antes, dos documentos con el MISMO `_synced_at` exacto (frecuente —
varios movimientos de stock de una sola compra se pushean en el mismo
batch.commit(), todos con igual timestamp) podían quedar perdidos PARA SIEMPRE si
el cursor guardado terminaba empatando con ese valor, porque el filtro
`where('_synced_at', '>', cursor)` excluye los empates sin ningún aviso.

Caso real que destapó esto (19/10/2026): 20 stock_movimientos de 3 compras
distintas nunca habían llegado a Admin-POS — encontrado con
`SGA_Sync.auditarHuerfanosAdmin(['stock_movimientos'])`, ver CLAUDE.md.

El fix agrega un desempate por id de documento (FieldPath.documentId(), único
por definición) al orderBy + startAfter.

Este test corre CONTRA FIRESTORE REAL (proyecto dev-kalulu, nunca producción —
el hostname `localhost` lo selecciona solo, ver firebase-config.js) porque el
bug depende de la semántica exacta de paginación con valores empatados, que el
simulador en Python (sync_sim.py) no reproduce con la misma fidelidad que el
SDK real. A diferencia del resto de la suite, este test NO usa block_firebase
a propósito — y limpia los documentos que crea al terminar.

Correr (server ya levantado en :8765, ver README.md):
    python tests/e2e/test_sync_monitor_cursor_empate.py
"""
import os
import sys
import time

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

import re

from playwright.sync_api import sync_playwright
from helpers import BASE_URL, DEV_ADMIN_PASS, DEV_ADMIN_USER, enable_dev_mode, seed_in_place


def login_admin_pos_sin_networkidle(page):
    """Como login_via_seed(admin_pos=True), pero sin esperar 'networkidle': con
    Firestore real conectado (este test no usa block_firebase) la conexión
    persistente de Firestore nunca deja la red "quieta", así que ese wait
    cuelga 30s y revienta. Se espera la URL/el selector concreto en su lugar."""
    page.goto(f"{BASE_URL}/views/login.html?returnTo=../admin-pos/")
    page.wait_for_selector("#username", timeout=15000)
    page.fill("#username", DEV_ADMIN_USER)
    page.fill("#password", DEV_ADMIN_PASS)
    page.click("#login-btn")
    page.wait_for_url(re.compile(r".*admin-pos/(index\.html)?#productos"), timeout=15000)
    page.wait_for_timeout(500)
    seed_in_place(page)
    page.wait_for_timeout(200)

RUN_ID = str(int(time.time() * 1000))
DOC_A_ID = f"test-empate-{RUN_ID}-a"
DOC_B_ID = f"test-empate-{RUN_ID}-b"  # ids elegidos para que A < B < C alfabéticamente
DOC_C_ID = f"test-empate-{RUN_ID}-c"
PROD_A = f"prod-empate-{RUN_ID}-a"
PROD_B = f"prod-empate-{RUN_ID}-b"
PROD_C = f"prod-empate-{RUN_ID}-c"
assert DOC_A_ID < DOC_B_ID < DOC_C_ID

CURSOR_KEY = "admin_monitor_sync_at:stock_movimientos"


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Sin block_firebase a propósito: este test necesita Firestore real (dev-kalulu).
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_admin_pos_sin_networkidle(page)

        print("--- Esperar a que Firestore (dev-kalulu) esté conectado ---")
        page.wait_for_function("window.SGA_Sync && window.SGA_Sync.isInitialized()", timeout=15000)
        print("OK")

        print("--- Esperar a que termine el sync histórico de fondo (dispositivo nuevo) ---")
        # Sin esto, el bootstrap de un admin-pos recién logueado (initialSyncFromFirestore,
        # que trae stock_movimientos por OTRO mecanismo, ya seguro -- paginación por
        # snapshot, no por cursor de texto) puede seguir corriendo en paralelo y
        # contaminar el aislamiento de este test.
        page.evaluate("async () => { await (window.SGA_Sync.getHistoricalSyncPromise() || Promise.resolve()); }")
        print("OK")

        # Fechas absurdas a propósito: nunca van a empatar con datos reales de dev-kalulu,
        # y caen muy por encima del fallback de 90 días con el que arranca un cursor vacío
        # -- no hace falta pre-fijar nada, que el cursor avance solo deja ver el bug real.
        synced_at_empatado = "2099-01-01T00:00:00.000Z"
        synced_at_c = "2099-01-01T00:00:01.000Z"

        def escribir_doc(doc_id, prod_id, synced_at):
            page.evaluate(
                """([docId, prodId, syncedAt]) => {
                  const db = window.SGA_Sync.getFirestore();
                  return db.collection('stock_movimientos').doc(docId).set({
                    id: docId, producto_id: prodId, sucursal_id: '1', delta: 1,
                    tipo: 'ajuste_conteo', motivo: 'test cursor empate (borrar si sobrevive)',
                    usuario_id: null, fecha: syncedAt, updated_at: syncedAt, sync_status: 'synced',
                    _synced_at: syncedAt, _sucursal: 'sucursal-1',
                  });
                }""",
                [doc_id, prod_id, synced_at],
            )

        try:
            print("--- Arrancar con el cursor limpio (sin ningún valor guardado todavía) ---")
            page.evaluate("(key) => localStorage.removeItem(key)", CURSOR_KEY)

            print("--- Escribir el documento A (synced_at empatado) y sincronizar ---")
            escribir_doc(DOC_A_ID, PROD_A, synced_at_empatado)
            page.evaluate("async () => { await window.SGA_Sync.syncMonitoringData(); }")
            page.wait_for_timeout(500)
            assert q(page, "SELECT 1 FROM stock_movimientos WHERE id=?", [DOC_A_ID]), \
                "El documento A debería haberse aplicado"
            cursor_tras_a = page.evaluate("(key) => localStorage.getItem(key)", CURSOR_KEY)
            print(f"OK - documento A aplicado, cursor quedó en {cursor_tras_a!r}")

            print("--- Escribir el documento B, MISMO synced_at que A, y sincronizar de nuevo ---")
            escribir_doc(DOC_B_ID, PROD_B, synced_at_empatado)
            page.evaluate("async () => { await window.SGA_Sync.syncMonitoringData(); }")
            page.wait_for_timeout(500)
            aplicado_b = q(page, "SELECT 1 FROM stock_movimientos WHERE id=?", [DOC_B_ID])
            assert aplicado_b, (
                "BUG REPRODUCIDO: el documento B (mismo _synced_at que A, cursor ya en A) "
                "nunca se aplicó -- el filtro '>' sobre un valor empatado lo excluye para siempre."
            )
            print("OK - documento B (empatado con A) SÍ se aplicó -- el desempate por id funciona")

            print("--- Un documento posterior (synced_at distinto) también sigue sincronizando ---")
            escribir_doc(DOC_C_ID, PROD_C, synced_at_c)
            page.evaluate("async () => { await window.SGA_Sync.syncMonitoringData(); }")
            page.wait_for_timeout(500)
            assert q(page, "SELECT 1 FROM stock_movimientos WHERE id=?", [DOC_C_ID]), \
                "El documento C (posterior) también debería haberse aplicado"
            print("OK - el sync sigue avanzando con normalidad después de resolver el empate")

            assert not errors, f"Errores JS: {errors}"
            print("\n=== OK: el cursor de syncMonitoringData ya no pierde documentos empatados (contra Firestore real, dev-kalulu) ===")
        finally:
            print("--- Limpieza: borrando los documentos de prueba de Firestore ---")
            page.evaluate(
                """(ids) => {
                  const db = window.SGA_Sync.getFirestore();
                  return Promise.all(ids.map(id => db.collection('stock_movimientos').doc(id).delete()));
                }""",
                [DOC_A_ID, DOC_B_ID, DOC_C_ID],
            )
            page.evaluate("(key) => localStorage.removeItem(key)", CURSOR_KEY)
            browser.close()


if __name__ == "__main__":
    main()
