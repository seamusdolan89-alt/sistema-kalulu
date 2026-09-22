"""
tests/e2e/test_sync_badge_admin.py

Bug real, reportado por el usuario (22/9/2026): en Admin-POS el indicador de sync
(el puntito junto a "Sincronizar") queda PERMANENTEMENTE en 🟡 "Sincronizando...",
nunca pasa a 🟢, aunque la sincronización en si funcione bien (pull/push corren solos
cada 5 min sin problema — esto es solo el indicador, no afecta los datos).

Causa: `initialize()` pone el badge en 'pending' UNA vez, al conectar con Firebase.
`syncNow()` en modo POS sí lo vuelve a poner en 'ok' al terminar cada ciclo — pero la
rama de Admin-POS de `syncNow()` (agregada el 16/9/2026 al unificar los botones
Pull/Push en uno solo) nunca llamaba a `updateSyncBadge('ok')`. Nada, en el uso normal
de Admin-POS (no el bootstrap de un dispositivo nuevo), volvía a tocar el badge.

Fix: la rama admin de `syncNow()` ahora actualiza `lastSyncAt` y llama a
`updateSyncBadge('ok')` al terminar, igual que la rama POS.

Este test no puede pasar por Firebase real (bloqueado por block_firebase) — usa
`__testForceInitialized()` con un Firestore falso mínimo (mismo patrón que
test_sync_admin_push_wired.py) y verifica el DOM real (#sync-badge), no solo que la
función no explote.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_badge_admin.py
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
  const emptySnap = { empty: true, size: 0, docs: [] };
  const fakeDb = {
    collection(name) {
      return {
        where() { return this; }, orderBy() { return this; }, limit() { return this; },
        async get() { return emptySnap; },
        doc(id) { return { id, path: name + '/' + id }; },
      };
    },
    batch() { return { set() {}, async commit() {} }; },
  };
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
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=True, wait_target="productos")

        print("--- Simular conexion (sin red real) y correr syncNow() como el botón / el timer de 5 min ---")
        page.evaluate(FAKE_FIRESTORE_JS)
        page.evaluate("() => window.SGA_Sync.syncNow()")

        badge = page.evaluate("() => document.getElementById('sync-badge').textContent")
        title = page.evaluate("() => document.getElementById('sync-badge').title")
        assert badge == '🟢', (
            f"BUG: el indicador de sync en Admin-POS quedo en {badge!r} ({title!r}) en vez de 🟢 "
            f"tras un ciclo de sincronizacion exitoso — syncNow() en modo admin nunca llama a "
            f"updateSyncBadge('ok')."
        )
        print(f"OK - badge = {badge!r} ({title!r})")

        print("--- Un segundo ciclo (el timer de 5 min) lo mantiene en verde ---")
        page.evaluate("() => window.SGA_Sync.syncNow()")
        badge2 = page.evaluate("() => document.getElementById('sync-badge').textContent")
        assert badge2 == '🟢', f"deberia seguir en verde tras un segundo ciclo, es {badge2!r}"
        print("OK - sigue en verde")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        context.close()
        browser.close()
        print("\nOK - test_sync_badge_admin: PASA")


if __name__ == "__main__":
    run()
