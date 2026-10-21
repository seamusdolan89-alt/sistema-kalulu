"""
tests/e2e/test_informes_permisos_desglosados.py — El permiso único
`can_informes` se desglosó en un permiso por informe (`can_informes_<id>`,
ver auth.js), para que el dueño elija exactamente qué informes ve cada
usuario, en vez de todo-o-nada.

Pedido explícito del usuario (21/10/2026): "ese permiso hay que desglosarlo
y que yo pueda seleccionar qué informes puede ver y cuáles no."

Diseño: `can_informes` sigue siendo el gate de la SECCIÓN (ruta en app.js,
sin cambios); cada informe puntual requiere además su propio permiso
(`requiere: 'can_informes'`, mismo mecanismo ya usado por
can_editar_productos/can_ver_costos). informes.js filtra el selector de
reportes (`#inf-sel-reporte`) por estos permisos.

Cubre:
1. Cajero con can_informes=true y SOLO 2 de los 10 informes tildados: el
   selector muestra únicamente esos 2, ningún otro.
2. Cajero con can_informes=true pero NINGÚN informe puntual tildado: no se
   muestra selector ni botón Generar, aparece un mensaje explicando que no
   tiene ningún informe habilitado.
3. Migración de un usuario con el permiso VIEJO (`{"can_informes": true}`,
   sin ninguna de las claves nuevas): al reiniciar la app (próximo login),
   recibe automáticamente los 10 permisos nuevos en true — no pierde acceso
   a nada que ya tuviera.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_permisos_desglosados.py
"""
import json
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_direct, login_via_seed

TODOS_LOS_INFORMES = [
    'can_informes_ventas_producto', 'can_informes_analitica_producto',
    'can_informes_ventas_transaccion', 'can_informes_quiebres_stock',
    'can_informes_ventas_vendedor', 'can_informes_aging_cc',
    'can_informes_resumen_diario', 'can_informes_stock_muerto',
    'can_informes_salidas_stock', 'can_informes_sustitutos_grupos',
]


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def crear_usuario(page, user_id, username, permisos_json):
    page.evaluate(
        """([userId, username, permisosJson]) => {
          return (async () => {
            const now = new Date().toISOString();
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pass123'));
            const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            window.SGA_DB.run(
              `INSERT INTO usuarios (id, firebase_uid, nombre, username, password_hash, rol, sucursal_id, activo, permisos_json, sync_status, updated_at)
               VALUES (?, ?, ?, ?, ?, 'cajero', '1', 1, ?, 'synced', ?)`,
              [userId, 'dev-' + userId, username, username, hash, permisosJson, now]
            );
          })();
        }""",
        [user_id, username, permisos_json],
    )
    page.wait_for_timeout(150)


def opciones_select(page):
    return page.locator("#inf-sel-reporte option").all_inner_texts()


def ir_a_informes(page):
    page.evaluate("window.location.hash = 'informes'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Crear cajero con SOLO 2 informes habilitados ---")
        crear_usuario(page, "user-inf-parcial", "infparcial",
                      '{"can_informes": true, "can_informes_ventas_producto": true, "can_informes_resumen_diario": true}')

        print("--- Crear cajero con can_informes pero NINGUN informe puntual ---")
        # OJO: hay que declarar las 10 claves nuevas explicitamente en FALSE,
        # no solo omitirlas -- cualquier login_direct() navega de verdad
        # (page.goto), lo que reinicializa SGA_DB.initialize() y korre la
        # migracion de permisos legacy (ver js/db.js): un permisos_json con
        # SOLO can_informes=true y ninguna clave nueva presente se
        # "migraria" solo, expandiendose a los 10 en true -- exactamente lo
        # que se quiere EVITAR en este caso de prueba.
        permisos_vacio = {"can_informes": True, **{k: False for k in TODOS_LOS_INFORMES}}
        crear_usuario(page, "user-inf-vacio", "infvacio", json.dumps(permisos_vacio))

        print("=== 1) Selector muestra SOLO los 2 informes tildados ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="infparcial", password="pass123")
        ir_a_informes(page)

        opciones = opciones_select(page)
        assert opciones == ["Ventas por Producto", "Resumen Diario de Caja"], \
            f"Deberia mostrar solo los 2 informes habilitados: {opciones}"
        print(f"OK - opciones del selector: {opciones}")

        print("--- Generar funciona con uno de los 2 habilitados ---")
        page.select_option("#inf-sel-reporte", "resumen_diario")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(400)
        resultados = page.locator("#inf-results").inner_text()
        assert "Seleccioná un reporte" not in resultados, "Deberia haber generado el reporte, no seguir en el estado vacio"
        print("OK")

        print("=== 2) Cajero con can_informes pero SIN ningun informe puntual: mensaje, sin selector ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="infvacio", password="pass123")
        ir_a_informes(page)

        assert page.locator("#inf-sel-reporte").count() == 0, "No deberia existir el selector"
        assert page.locator("#inf-btn-generar").count() == 0, "No deberia existir el boton Generar"
        texto = page.locator("#app").inner_text()
        assert "No tenés ningún informe habilitado" in texto, f"Deberia mostrar el mensaje de sin informes: {texto[:300]!r}"
        print("OK - mensaje de 'sin informes habilitados' mostrado, sin selector ni boton")

        print("=== 3) Migracion: usuario con el permiso VIEJO no pierde acceso ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page)  # admin por defecto, para poder escribir en usuarios
        crear_usuario(page, "user-inf-legacy", "infviejo", '{"can_informes": true}')

        antes = q(page, "SELECT permisos_json FROM usuarios WHERE id='user-inf-legacy'")[0]
        assert '"can_informes_ventas_producto"' not in antes["permisos_json"], \
            f"Precondicion: todavia NO deberia tener las claves nuevas: {antes}"

        print("--- Reiniciar la app (reload) para que corra la migracion de db.js ---")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        despues = q(page, "SELECT permisos_json FROM usuarios WHERE id='user-inf-legacy'")[0]
        permisos_migrados = json.loads(despues["permisos_json"])
        for key in TODOS_LOS_INFORMES:
            assert permisos_migrados.get(key) is True, \
                f"La migracion deberia haber puesto {key}=true (tenia can_informes=true): {permisos_migrados}"
        print(f"OK - los 10 permisos nuevos quedaron en true tras la migracion: {permisos_migrados}")

        print("--- Y el usuario migrado efectivamente ve los 10 informes en el selector ---")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="infviejo", password="pass123")
        ir_a_informes(page)
        opciones_legacy = opciones_select(page)
        assert len(opciones_legacy) == 10, f"Deberia ver los 10 informes tras la migracion: {opciones_legacy}"
        print(f"OK - {len(opciones_legacy)} informes visibles tras migrar un usuario legacy")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: can_informes desglosado en un permiso por informe, con migracion que preserva el acceso previo ===")
        browser.close()


if __name__ == "__main__":
    main()
