"""
tests/e2e/test_informes_accesos_usuarios.py — informe "Accesos de Usuarios" + permisos por informe.

Pedido del dueño (19/11/2026): un informe para ver quién inició/cerró sesión (accesos_usuarios), y
"asegurate de que le pueda dar acceso solo a los informes que yo quiero a cada usuario".

Cubre:
1. El informe arma UNA FILA POR SESION con la UI real (Informes -> Generar):
   - login + logout manual -> "Salir (manual)" con su duracion
   - login sin logout y despues otro login en el MISMO equipo -> "Sin cierre registrado" + siguiente ingreso
   - logout_auto -> "Automático (cambio de jornada)"
   - login en Admin-POS desde otro equipo -> superficie "Admin-POS", sin cierre
   y los KPIs (sesiones, usuarios distintos, con Salir, automáticos, sin cierre) y el CSV.
2. Permisos: desde la pantalla Usuarios se tilda SOLO "Accesos de Usuarios" y el usuario ve ese
   informe y ningun otro; sin el permiso el informe no aparece en el selector.
3. Brecha corregida: el bloque mobile de Admin-POS ("Ventas por Vendedor") solo existe si el usuario
   tiene can_informes_ventas_vendedor — antes se dibujaba con cualquier informe habilitado, es decir,
   mostraba ventas por vendedor a quien solo tenia, por ejemplo, "Precios y Etiquetas".

Correr (server en :8765):  python tests/e2e/test_informes_accesos_usuarios.py
"""
import json
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_direct, login_via_seed

# Todas las claves de informe que existen HOY en auth.js (se leen de la definicion real,
# asi un informe nuevo no queda fuera de la prueba sin que nadie lo note).


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def crear_usuario(page, user_id, nombre, permisos):
    page.evaluate(
        """([userId, nombre, permisosJson]) => (async () => {
            const now = new Date().toISOString();
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pass123'));
            const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            window.SGA_DB.run(
              `INSERT INTO usuarios (id, firebase_uid, nombre, username, password_hash, rol, sucursal_id, activo, permisos_json, sync_status, updated_at)
               VALUES (?, ?, ?, ?, ?, 'cajero', '1', 1, ?, 'synced', ?)`,
              [userId, 'dev-' + userId, nombre, nombre, hash, permisosJson, now]);
          })()""",
        [user_id, nombre, json.dumps(permisos)],
    )
    page.wait_for_timeout(150)


def ir_a_informes(page):
    page.evaluate("window.location.hash = 'informes'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)


def opciones(page):
    return page.locator("#inf-sel-reporte option").all_inner_texts()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1100}, accept_downloads=True)
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=False)

        # Todas las claves can_informes_* reales, en false (hay que declararlas: la migracion de db.js
        # expande un permisos_json legacy con solo can_informes=true a "todos").
        claves = page.evaluate("() => (window.SGA_PERMISOS_DEF || []).map(p => p.key).filter(k => k.startsWith('can_informes_'))")
        assert len(claves) >= 12, f"Esperaba >=12 permisos can_informes_<id> en auth.js, hay {len(claves)}: {claves}"
        print(f"--- {len(claves)} claves can_informes_<id> detectadas en auth.js ---")

        def solo(*activas):
            return {"can_informes": True, **{k: (k in activas) for k in claves}}

        crear_usuario(page, "u-ana", "ana", solo())
        crear_usuario(page, "u-beto", "beto", solo())
        crear_usuario(page, "u-solo-precios", "soloprecios", solo("can_informes_precios_etiquetas"))
        crear_usuario(page, "u-vendedor", "vendedor", solo("can_informes_ventas_vendedor"))

        # ── 1. El informe, como admin, con eventos sembrados ────────────────────────
        print("=== 1) Informe Accesos de Usuarios: una fila por sesion ===")
        page.evaluate("""() => {
          window.SGA_DB.run('DELETE FROM accesos_usuarios');
          const hoy = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
          const adm = window.SGA_Auth.getCurrentUser().id;
          const ev = (id, u, evento, f, sup, disp, motivo) => window.SGA_DB.run(
            `INSERT INTO accesos_usuarios (id, usuario_id, evento, fecha, superficie, dispositivo_id, motivo, sync_status, updated_at)
             VALUES (?,?,?,?,?,?,?,'pending',?)`, [id, u, evento, f, sup, disp, motivo || null, f]);
          // Equipo X (POS): admin 07:00 -> Salir 08:30 (90 min); ana 09:00 sin cierre; beto 10:00 -> automatico 10:20
          ev('e1', adm,     'login',       hoy(7, 0),  'pos', 'AAAAAA11-x');
          ev('e2', adm,     'logout',      hoy(8, 30), 'pos', 'AAAAAA11-x');
          ev('e3', 'u-ana', 'login',       hoy(9, 0),  'pos', 'AAAAAA11-x');
          ev('e4', 'u-beto','login',       hoy(10, 0), 'pos', 'AAAAAA11-x');
          ev('e5', 'u-beto','logout_auto', hoy(10, 20),'pos', 'AAAAAA11-x', 'sesion vencida por cambio de jornada');
          // Equipo Y (Admin-POS): admin 11:00, sin cierre
          ev('e6', adm,     'login',       hoy(11, 0), 'admin-pos', 'BBBBBB22-y');
        }""")
        ir_a_informes(page)
        page.select_option("#inf-sel-reporte", "accesos_usuarios")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(500)
        res = page.locator("#inf-results")
        filas = res.locator("tbody tr")
        assert filas.count() == 4, f"BUG: esperaba 4 sesiones, hay {filas.count()}: {res.inner_text()[:600]}"
        txt = res.inner_text()

        def fila_de(usuario, superficie):
            for i in range(filas.count()):
                t = filas.nth(i).inner_text()
                celdas = t.split(chr(9))
                if celdas[0] == usuario and celdas[1] == superficie:
                    return t
            raise AssertionError(f"No encontre la fila de {usuario}/{superficie} en:\n{txt}")

        f_admin_pos = fila_de("Admin", "POS")   # admin en el POS (equipo X)
        assert "Salir (manual)" in f_admin_pos and "1 h 30 min" in f_admin_pos, f"BUG sesion con Salir: {f_admin_pos}"
        f_ana = fila_de("ana", "POS")
        assert "Sin cierre registrado" in f_ana and "beto" in f_ana, \
            f"BUG: ana no se cerro y el siguiente ingreso en ese equipo fue beto: {f_ana}"
        f_beto = fila_de("beto", "POS")
        assert "Automático (cambio de jornada)" in f_beto and "20 min" in f_beto, f"BUG logout_auto: {f_beto}"
        f_adm_web = fila_de("Admin", "Admin-POS")
        assert "Sin cierre registrado" in f_adm_web, f"BUG: sesion de Admin-POS sin cierre: {f_adm_web}"

        kpis = res.locator(".inf-kpi").all_inner_texts()
        kpis = [k.replace("\n", " ").upper() for k in kpis]
        assert any(k.startswith("SESIONES") and k.endswith(" 4") for k in kpis), f"KPI sesiones: {kpis}"
        assert any(k.startswith("USUARIOS DISTINTOS") and k.endswith(" 3") for k in kpis), f"KPI usuarios: {kpis}"
        assert any(k.startswith("CERRADAS CON SALIR") and k.endswith(" 1") for k in kpis), f"KPI con Salir: {kpis}"
        assert any("AUTOM" in k and k.endswith(" 1") for k in kpis), f"KPI automaticos: {kpis}"
        assert any(k.startswith("SIN CIERRE REGISTRADO") and k.endswith(" 2") for k in kpis), f"KPI sin cierre: {kpis}"
        print("OK - 4 sesiones con su cierre/duracion y KPIs correctos")

        with page.expect_download() as dl:
            page.locator("#inf-btn-csv").click()
        csv = open(dl.value.path(), encoding="utf-8-sig").read()
        assert "Salir (manual)" in csv and "Accesos de Usuarios" in csv, f"CSV sin los datos esperados: {csv[:300]}"
        print("OK - el CSV exporta el informe")

        # ── 2. Permisos: tildar SOLO este informe desde la pantalla Usuarios ───────
        print("=== 2) Desde Usuarios se le da a un usuario SOLO este informe ===")
        page.evaluate("window.location.hash = 'usuarios'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator('.btn-editar-usuario[data-id="u-ana"]').click()
        page.wait_for_timeout(300)
        chk = page.locator("#perm-can_informes_accesos_usuarios")
        assert chk.count() == 1, "BUG: la pantalla Usuarios no ofrece el permiso 'Accesos de Usuarios'"
        assert not chk.is_checked(), "El permiso nuevo tiene que arrancar apagado"
        chk.check()
        page.locator("#btn-guardar-usuario").click()
        page.wait_for_timeout(600)
        permisos = json.loads(q(page, "SELECT permisos_json FROM usuarios WHERE id='u-ana'")[0]["permisos_json"])
        assert permisos.get("can_informes_accesos_usuarios") is True, f"BUG: no se guardo el permiso: {permisos}"
        otros = [k for k, v in permisos.items() if k.startswith("can_informes_") and v and k != "can_informes_accesos_usuarios"]
        assert not otros, f"BUG: tildar un informe encendio otros: {otros}"
        print("OK - se guardo solo can_informes_accesos_usuarios")

        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="ana", password="pass123")
        ir_a_informes(page)
        assert opciones(page) == ["Accesos de Usuarios"], f"BUG: ana deberia ver SOLO este informe: {opciones(page)}"
        print("OK - ana ve solamente 'Accesos de Usuarios'")

        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="beto", password="pass123")  # beto no lo tiene
        ir_a_informes(page)
        assert page.locator("#inf-sel-reporte").count() == 0, "BUG: beto no tiene ningun informe habilitado"
        assert "Accesos de Usuarios" not in page.locator("#app").inner_text()
        print("OK - sin el permiso, el informe no aparece")

        # ── 3. Bloque mobile solo con can_informes_ventas_vendedor ─────────────────
        print("=== 3) El bloque mobile 'Ventas por Vendedor' respeta su permiso ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="soloprecios", password="pass123")
        ir_a_informes(page)
        assert opciones(page) == ["Precios y Etiquetas"], f"opciones: {opciones(page)}"
        assert page.locator(".inf-mobile-only").count() == 0, \
            "BUG: el bloque mobile 'Ventas por Vendedor' se dibuja para alguien SIN ese permiso"
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="vendedor", password="pass123")
        ir_a_informes(page)
        assert page.locator(".inf-mobile-only").count() == 1, "BUG: con el permiso, el bloque mobile tiene que estar"
        print("OK - sin permiso no se dibuja; con permiso si")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_informes_accesos_usuarios")


if __name__ == "__main__":
    main()
