"""
tests/e2e/test_usuarios_permisos.py — Regresión del guard de rutas agregado
en app.js (isRouteAllowed / loadView). Antes del fix, el router cargaba
cualquier módulo para cualquier hash sin volver a chequear permisos —
initNav() sólo decidía qué aparecía en el MENÚ, pero escribir la URL a
mano (#productos, #compras_v2, #proveedores, #gastos, etc.) daba acceso
completo sin importar los permisos granulares del usuario. Ver hallazgo
en la sesión: confirmado con un cajero sin ningún permiso accediendo a
Productos, Compras, Proveedores y Gastos completos por URL directa.

Cubre:
1. Cajero SIN permisos: bloqueado en rutas con permiso granular
   (productos, compras_v2, proveedores, gastos) y en rutas admin-only
   (usuarios, caja_admin, configuracion).
2. Cajero CON un permiso puntual (can_productos): accede a esa ruta.
3. Admin en POS local: sigue con acceso total a los módulos que ya usaba
   sin necesitar permiso explícito (compras_v2, consumo_interno, roturas,
   vencimientos, operaciones_stock) — NO debe haber regresión acá.
4. Admin en POS local: configuracion/flujo (adminPosOnly) siguen
   bloqueados incluso para el admin, porque son exclusivos de admin-pos.
5. Admin-pos: acceso total sin restricciones, sin cambios de comportamiento.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_usuarios_permisos.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, login_direct

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

RESTRINGIDO = "Acceso restringido"


def crear_usuario(page, user_id, username, password, permisos_json="{}"):
    page.evaluate(f"""
      async () => {{
        const now = new Date().toISOString();
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{password}'));
        const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        window.SGA_DB.run(
          `INSERT INTO usuarios (id, firebase_uid, nombre, username, password_hash, rol, sucursal_id, activo, permisos_json, sync_status, updated_at)
           VALUES ('{user_id}', 'dev-{user_id}', '{username}', '{username}', ?, 'cajero', '1', 1, '{permisos_json}', 'pending', ?)`,
          [hash, now]
        );
      }}
    """)
    page.wait_for_timeout(200)


def ir_a(page, ruta):
    page.evaluate(f"window.location.hash = '{ruta}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    return page.locator("#app").inner_text()


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Crear cajero SIN ningun permiso ---")
        crear_usuario(page, "user-sinperm", "sinpermisos", "pass123", "{}")

        print("--- Crear cajero CON can_productos=true ---")
        crear_usuario(page, "user-conperm", "conpermisos", "pass123", '{"can_productos": true}')

        print("=== Cajero SIN permisos: rutas con permiso granular deben bloquearse ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="sinpermisos", password="pass123")
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "permisos_sidebar_sin_permisos.png"), full_page=True)

        nav_text = page.locator("aside.sidebar nav").inner_text()
        assert "Productos" not in nav_text, f"El menu no deberia mostrar Productos: {nav_text!r}"

        for ruta in ["productos", "compras_v2", "proveedores", "gastos", "cuenta_corriente_proveedores"]:
            text = ir_a(page, ruta)
            assert RESTRINGIDO in text, f"#{ruta} deberia estar bloqueado para un cajero sin permisos: {text[:150]!r}"

        print("=== Cajero SIN permisos: rutas admin-only tambien bloqueadas ===")
        for ruta in ["usuarios", "caja_admin", "configuracion", "adelanto_pago"]:
            text = ir_a(page, ruta)
            assert RESTRINGIDO in text, f"#{ruta} deberia estar bloqueado (admin-only): {text[:150]!r}"

        print("=== Cajero CON can_productos=true: debe entrar a #productos ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="conpermisos", password="pass123")
        page.wait_for_timeout(300)
        text = ir_a(page, "productos")
        assert RESTRINGIDO not in text, f"#productos deberia ser accesible con can_productos=true: {text[:150]!r}"
        assert "Coca-Cola" in text, f"No se ve el listado de productos esperado: {text[:150]!r}"

        # Pero otras rutas sin permiso siguen bloqueadas para el mismo usuario
        text = ir_a(page, "compras_v2")
        assert RESTRINGIDO in text, f"#compras_v2 deberia seguir bloqueado (sin can_compras): {text[:150]!r}"

        print("=== Admin en POS local: sin regresion en modulos ya usados sin permiso explicito ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="admin", password="kalulu123")
        page.wait_for_timeout(300)
        for ruta in ["compras_v2", "consumo_interno", "roturas", "vencimientos", "operaciones_stock",
                     "proveedores", "gastos", "caja_admin", "usuarios"]:
            text = ir_a(page, ruta)
            assert RESTRINGIDO not in text, f"Regresion: admin en POS ya no puede entrar a #{ruta}: {text[:150]!r}"

        print("=== Admin en POS local: configuracion/flujo siguen exclusivos de admin-pos ===")
        for ruta in ["configuracion", "flujo"]:
            text = ir_a(page, ruta)
            assert RESTRINGIDO in text, f"#{ruta} deberia seguir bloqueado para el admin en POS local (adminPosOnly): {text[:150]!r}"

        print("=== Admin-pos: acceso total sin cambios ===")
        page2 = context.new_page()
        page2.on("pageerror", lambda exc: errors.append(str(exc)))
        login_via_seed(page2, admin_pos=True)
        for ruta in ["configuracion", "flujo", "compras_v2", "usuarios", "gastos"]:
            text = ir_a(page2, ruta)
            assert RESTRINGIDO not in text, f"Regresion en admin-pos: #{ruta} deberia ser accesible: {text[:150]!r}"
        page2.close()

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Guard de rutas: bloquea acceso directo por hash sin permiso, sin romper el acceso legitimo del admin.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
