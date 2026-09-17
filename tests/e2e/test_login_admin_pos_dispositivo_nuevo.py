"""
tests/e2e/test_login_admin_pos_dispositivo_nuevo.py

Bug real: en un dispositivo que nunca había entrado a Admin-POS (ej. un
celular por primera vez), `login.html` siempre inicializaba y chequeaba
`sga.db` (la base del POS), nunca `sga-admin.db` — sin importar el `returnTo`.
Como cada base local arranca vacía en un dispositivo nuevo y recién ahí
`db.js` crea el admin por defecto (`admin`/`kalulu123`, ver "Primera vez" en
`js/db.js`), el resultado era que nadie podía entrar a Admin-POS con su
contraseña real desde un dispositivo nuevo — la sincronización completa que
trae los usuarios reales desde Firestore corría recién DESPUÉS de loguearse,
adentro de `admin-pos/index.html`.

Fix en `views/login.html`:
1. Si `returnTo` apunta a admin-pos, `window.ADMIN_MODE = true` ANTES de
   `SGA_DB.initialize()` — abre `sga-admin.db`, la base correcta.
2. Si esa base está vacía, corre `SGA_Sync.pullUsuariosOnly()` (trae SOLO
   `usuarios`, no initialSyncFromFirestore completo — ver nota 16/9 más
   abajo) ANTES de dejar intentar el login.
3. El listener de submit del `<form>` se engancha de forma SÍNCRONA, antes de
   arrancar ese trabajo async — si no, un click en "Ingresar" mientras el
   pre-sync todavía está en curso no encuentra ningún handler y el `<form>`
   (sin `action`) hace un submit NATIVO: recarga la página a mitad de camino
   y vuelve a sembrar un admin por defecto (con un id random nuevo) cada vez.

Nota 16/9: la primera versión de este fix llamaba a
`initialSyncFromFirestore()` completo (~28 colecciones) antes del login. En
`dev-kalulu` no se notaba, pero contra producción real (meses de
ventas/compras acumuladas) tardaba minutos en una conexión de celular antes
de mostrar siquiera el formulario — el usuario lo reportó probándolo en su
teléfono. Se acotó a `pullUsuariosOnly()` (solo la colección `usuarios`); el
resto de los datos sigue llegando igual que siempre, pero DESPUÉS de
loguearse (el overlay ya existente de admin-pos/index.html).

Este test corre con `block_firebase` activo (como el resto de la suite), así
que NO puede probar el pull real contra Firestore — eso se verificó a mano
contra `dev-kalulu` (nunca contra producción). Lo que sí cubre sin salir de
la red local:

1. Un dispositivo nuevo que entra a Admin-POS termina usando `sga-admin.db`
   (no `sga.db`) — el usuario creado vía login.html es visible después desde
   adentro de admin-pos/index.html, que siempre lee esa base.
2. Clickear "Ingresar" apenas aparece el botón (antes de que el pre-sync,
   bloqueado, llegue a resolverse) no dispara un submit nativo del `<form>`
   ni duplica el admin por defecto.
3. El pre-login llama a `pullUsuariosOnly()`, NO a `initialSyncFromFirestore()`
   completo — regresión del problema de lentitud del 16/9.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_login_admin_pos_dispositivo_nuevo.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, BASE_URL


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ── 1) Dispositivo nuevo -> login.html debe usar sga-admin.db ──────
        context = browser.new_context(viewport={"width": 390, "height": 844})
        context.route("**/*", block_firebase)
        page = context.new_page()

        # Espia SGA_Sync.pullUsuariosOnly / initialSyncFromFirestore ANTES de
        # que js/sync.js siquiera exista (window.SGA_Sync se define recien
        # cuando ese script corre) -- un defineProperty en window intercepta
        # la asignacion real y envuelve los dos metodos, sin tocar el resto
        # de la API. Corre en cada navegacion (add_init_script).
        page.add_init_script("""
          window.__syncCalls = [];
          let _sgaSync;
          Object.defineProperty(window, 'SGA_Sync', {
            configurable: true,
            get() { return _sgaSync; },
            set(obj) {
              if (obj && typeof obj.pullUsuariosOnly === 'function' && !obj.__spied) {
                const origPull = obj.pullUsuariosOnly.bind(obj);
                const origFull = obj.initialSyncFromFirestore.bind(obj);
                obj.pullUsuariosOnly = (...args) => { window.__syncCalls.push('pullUsuariosOnly'); return origPull(...args); };
                obj.initialSyncFromFirestore = (...args) => { window.__syncCalls.push('initialSyncFromFirestore'); return origFull(...args); };
                obj.__spied = true;
              }
              _sgaSync = obj;
            }
          });
        """)

        page.goto(f"{BASE_URL}/admin-pos/")
        page.wait_for_url(lambda u: "login.html" in u, timeout=15000)
        page.wait_for_load_state("networkidle")

        admin_mode = page.evaluate("() => window.ADMIN_MODE")
        assert admin_mode is True, (
            f"returnTo=../admin-pos/ deberia setear window.ADMIN_MODE=true en login.html "
            f"ANTES de inicializar la DB (quedo: {admin_mode!r})"
        )
        print("OK - login.html detecta el destino admin-pos y setea ADMIN_MODE")

        # El pre-sync (bloqueado por block_firebase) falla rapido y cae al
        # fallback local -> el admin por defecto queda en la base que
        # login.html abrio para este returnTo (sga-admin.db).
        page.wait_for_timeout(1500)
        local_admin = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT username FROM usuarios WHERE username='admin'\")"
        )
        assert len(local_admin) == 1, f"esperaba el admin por defecto ya sembrado, hay: {local_admin}"

        sync_calls = page.evaluate("() => window.__syncCalls")
        assert sync_calls == ['pullUsuariosOnly'], (
            f"el pre-login de un dispositivo nuevo deberia llamar solo a pullUsuariosOnly "
            f"(no a initialSyncFromFirestore completo, ~28 colecciones — eso es lo que lo hacia "
            f"lento en produccion real). Llamadas registradas: {sync_calls}"
        )
        print("OK - el pre-login usa pullUsuariosOnly (liviano), no initialSyncFromFirestore completo")

        page.fill("#username", "admin")
        page.fill("#password", "kalulu123")
        page.click("#login-btn")
        page.wait_for_url(lambda u: "admin-pos" in u and "login.html" not in u, timeout=15000)
        page.wait_for_load_state("networkidle")
        print(f"OK - login admin/kalulu123 en dispositivo nuevo entra a Admin-POS ({page.url})")

        # Si login.html hubiera escrito en sga.db (el bug original), esta
        # query DESDE admin-pos/index.html (que siempre usa sga-admin.db) no
        # encontraria a este usuario.
        seen_from_admin_pos = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT username FROM usuarios WHERE username='admin'\")"
        )
        assert len(seen_from_admin_pos) == 1, (
            "admin-pos/index.html (sga-admin.db) no ve al usuario creado por login.html -> "
            "login.html sigue escribiendo en la base equivocada"
        )
        print("OK - admin-pos/index.html ve el mismo usuario: login.html usó sga-admin.db, no sga.db")

        context.close()

        # ── 2) Click prematuro en "Ingresar" no dispara un submit nativo ───
        context2 = browser.new_context(viewport={"width": 390, "height": 844})
        context2.route("**/*", block_firebase)
        page2 = context2.new_page()

        page2.goto(f"{BASE_URL}/admin-pos/")
        page2.wait_for_url(lambda u: "login.html" in u, timeout=15000)
        # Sin esperar a que termine el pre-sync (bloqueado): tipear y
        # clickear apenas el form esta en el DOM, lo mas rapido posible.
        page2.wait_for_selector("#login-btn", state="visible")
        page2.fill("#username", "admin")
        page2.fill("#password", "kalulu123")
        page2.click("#login-btn")

        page2.wait_for_timeout(500)
        url_after_quick_click = page2.url
        assert "username=" not in url_after_quick_click and "password=" not in url_after_quick_click, (
            f"el click parece haber disparado un submit NATIVO del <form> (sin preventDefault) — "
            f"URL quedo: {url_after_quick_click}"
        )
        print("OK - el click prematuro no disparo un submit nativo del <form>")

        # Dejar terminar todo (login real, una vez que el listener ya estaba
        # enganchado desde el arranque, deberia entrar igual)
        page2.wait_for_url(lambda u: "admin-pos" in u and "login.html" not in u, timeout=15000)
        page2.wait_for_load_state("networkidle")

        admins_count = page2.evaluate(
            "() => window.SGA_DB.query(\"SELECT COUNT(*) as n FROM usuarios WHERE username='admin'\")[0].n"
        )
        assert admins_count == 1, (
            f"el click prematuro no deberia haber re-sembrado admins por defecto duplicados "
            f"(hay {admins_count})"
        )
        print("OK - un solo admin por defecto, sin duplicados por el click prematuro")

        context2.close()
        browser.close()
        print("\n=== TODOS LOS CHECKS DE LOGIN ADMIN-POS (DISPOSITIVO NUEVO) PASARON ===")


if __name__ == "__main__":
    run()
