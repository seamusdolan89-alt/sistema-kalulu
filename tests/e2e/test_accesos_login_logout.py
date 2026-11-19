"""
tests/e2e/test_accesos_login_logout.py — registro de inicios y cierres de sesion (accesos_usuarios).

Pedido del dueño (19/11/2026): saber quien inicio sesion y quien la cerro, tanto en el POS como en
Admin-POS. Antes no quedaba ningun rastro (solo se podia deducir por la actividad: ventas, caja...).

Verifica, con la UI real (formulario de login, boton "Salir", cambio de jornada):
  1. POS: iniciar sesion deja un evento 'login' con el usuario, la superficie 'pos' y un dispositivo.
  2. POS: tocar "Salir" deja un 'logout' del mismo usuario; volver a entrar deja otro 'login'.
  3. POS: una sesion que quedo abierta de una jornada anterior (pestaña restaurada) deja
     'logout_auto' al abrirse, atribuido al usuario que estaba logueado.
  4. Admin-POS: lo mismo pero con superficie 'admin-pos' (otra base: sga-admin.db).
  5. El id de dispositivo es estable entre eventos (mismo navegador) y los ids de evento son unicos.

Correr (con el server en el puerto 8765):
    python -m http.server 8765 --bind 127.0.0.1
    python tests/e2e/test_accesos_login_logout.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import BASE_URL, block_firebase, enable_dev_mode, login_via_seed, login_direct

SQL = ("SELECT a.evento, a.superficie, a.usuario_id, a.dispositivo_id, a.motivo, a.id, a.sync_status, u.username "
       "FROM accesos_usuarios a LEFT JOIN usuarios u ON u.id = a.usuario_id ORDER BY a.fecha, a.rowid")


def accesos(page):
    return page.evaluate(f"() => window.SGA_DB.query(`{SQL}`)")


def eventos(page):
    return [a["evento"] for a in accesos(page)]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        # ── 1. POS: login ────────────────────────────────────────────────────────
        login_via_seed(page)
        filas = accesos(page)
        logins = [a for a in filas if a["evento"] == "login"]
        assert len(logins) == 1, f"BUG: esperaba 1 evento login tras entrar al POS, hay: {filas}"
        a = logins[0]
        assert a["superficie"] == "pos", f"BUG: superficie esperada 'pos', fue {a['superficie']!r}"
        assert a["username"] == "admin", f"BUG: el login deberia atribuirse a 'admin', fue {a['username']!r}"
        assert a["dispositivo_id"], "BUG: el evento no guardo el id de dispositivo"
        assert a["sync_status"] == "pending", "BUG: el evento nuevo tiene que quedar 'pending' para sincronizar"
        dispositivo = a["dispositivo_id"]
        print("OK 1: POS login registrado (usuario admin, superficie pos, dispositivo)")

        # ── 2. POS: Salir + volver a entrar ──────────────────────────────────────
        page.click("#logout-btn")
        page.wait_for_url("**/views/login.html*", timeout=15000)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        assert eventos(page) == ["login", "logout"], f"BUG: tras Salir esperaba [login, logout], hay: {eventos(page)}"
        lo = accesos(page)[1]
        assert lo["username"] == "admin" and lo["superficie"] == "pos", f"BUG: logout mal atribuido: {lo}"
        login_direct(page)
        assert eventos(page) == ["login", "logout", "login"], f"BUG: tras re-entrar: {eventos(page)}"
        print("OK 2: POS logout (boton Salir) y nuevo login registrados en orden")

        # ── 3. POS: sesion vencida por cambio de jornada, detectada al abrir ─────
        page.evaluate("() => sessionStorage.setItem('sga_login_at', new Date(Date.now() - 3*86400000).toISOString())")
        page.goto(f"{BASE_URL}/index.html")  # init -> restoreSession ve la sesion vieja y la cierra
        page.wait_for_url("**/views/login.html*", timeout=15000)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        ev = accesos(page)
        assert [x["evento"] for x in ev] == ["login", "logout", "login", "logout_auto"], \
            f"BUG: sesion vencida no dejo logout_auto: {[x['evento'] for x in ev]}"
        assert ev[-1]["username"] == "admin" and ev[-1]["motivo"], f"BUG: logout_auto mal atribuido/sin motivo: {ev[-1]}"
        print("OK 3: sesion vencida por jornada deja logout_auto atribuido al usuario")

        # ── 5. dispositivo estable + ids unicos ──────────────────────────────────
        assert {x["dispositivo_id"] for x in ev} == {dispositivo}, "BUG: el id de dispositivo cambio entre eventos"
        assert len({x["id"] for x in ev}) == len(ev), "BUG: ids de evento repetidos"
        print("OK 5: dispositivo estable e ids unicos")

        # ── 4. Admin-POS: superficie 'admin-pos' (otra base de datos) ────────────
        login_direct(page, admin_pos=True)
        filas = accesos(page)
        assert [x["evento"] for x in filas] == ["login"], f"BUG: Admin-POS deberia tener solo su login: {filas}"
        assert filas[0]["superficie"] == "admin-pos", f"BUG: superficie esperada 'admin-pos', fue {filas[0]['superficie']!r}"
        page.click("#logout-btn")
        page.wait_for_url("**/views/login.html*", timeout=15000)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        filas = accesos(page)  # login.html?returnTo=admin-pos abre sga-admin.db
        assert [x["evento"] for x in filas] == ["login", "logout"], f"BUG: Admin-POS logout: {filas}"
        assert all(x["superficie"] == "admin-pos" for x in filas)
        print("OK 4: Admin-POS login/logout registrados con superficie admin-pos")

        assert not errors, f"Errores JS de pagina: {errors}"
        browser.close()
    print("\nTODO OK — test_accesos_login_logout")


if __name__ == "__main__":
    main()
