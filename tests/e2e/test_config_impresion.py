"""
tests/e2e/test_config_impresion.py — pantalla "Configuración de impresión" (engranaje en el menú).

Pedido del dueño (23/11/2026): una sección de configuración en el POS donde se configure el ticket
de venta (rollo térmico de 58 mm, largo según el contenido) y el modelo/tamaño de las etiquetas.

Cubre, con la UI real:
1. El ítem aparece en el menú (con su ícono) y abre la pantalla; valores por defecto 58 / 48 mm y A4 3x10.
2. Cambiar el rollo a 80 mm sugiere 72 mm útil y la vista previa cambia de ancho; Guardar persiste
   (sobrevive a recargar) y la config es POR EQUIPO (localStorage, no se sincroniza).
3. "Imprimir ticket de prueba" manda a imprimir el ticket de calibración (con regla y ancho útil).
4. Etiquetas: elegir un rollo de etiquetas cambia la geometría; un modelo personalizado que no entra en
   la hoja muestra el aviso; la hoja de prueba usa la geometría configurada.
5. La pantalla de Etiquetas IMPRIME con la configuración (por defecto sale igual que siempre: A4 3 x 10
   de 70 x 29,7 mm; con rollo 50 x 30 sale una por página).
6. Permisos: sin `can_config_impresion` el ítem no aparece y la ruta está bloqueada; con el permiso, sí.

Correr (server en :8765):  python tests/e2e/test_config_impresion.py
"""
import json
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_direct, login_via_seed

NAV = 'aside.sidebar nav a[data-module="config_impresion"]'


def ir(page, ruta):
    page.evaluate(f"window.location.hash = '{ruta}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)


def crear_cajero(page, user_id, nombre, permisos):
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


def capturar_blob(page):
    """Reemplaza window.open para leer el HTML de la pestaña que se abriría (blob URL)."""
    page.evaluate("""() => { window.__blobs = []; window.open = (u) => { window.__blobs.push(fetch(u).then(r => r.text())); return {}; }; }""")


def ultimo_blob(page):
    page.wait_for_timeout(300)
    return page.evaluate("async () => (await Promise.all(window.__blobs)).slice(-1)[0] || ''")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=False)
        page.evaluate("() => localStorage.removeItem('sga_print_config')")

        # ── 1. Menu + defaults ──────────────────────────────────────────────────
        print("=== 1) El item de menu abre la pantalla con los valores por defecto ===")
        assert page.locator(NAV).count() == 1, "Falta el item 'Configuración de impresión' en el menu"
        assert page.locator(NAV + " svg").count() == 1, "El item tiene que tener su icono (engranaje)"
        page.locator(NAV).click()
        page.wait_for_timeout(600)
        assert "config_impresion" in page.url
        assert page.locator("#ci-t-papel").input_value() == "58" and page.locator("#ci-t-util").input_value() == "48"
        assert page.locator("#ci-e-preset").input_value() == "a4_3x10"
        assert "30" in page.locator("#ci-e-info").inner_text(), page.locator("#ci-e-info").inner_text()   # 30 por hoja
        print("OK")

        # ── 2. Cambiar, guardar, persistir ──────────────────────────────────────
        print("=== 2) 80 mm sugiere 72 mm; Guardar persiste por equipo ===")
        page.select_option("#ci-t-papel", "80")
        page.wait_for_timeout(200)
        assert page.locator("#ci-t-util").input_value() == "72", "Al elegir 80 mm tiene que sugerir 72 mm utiles"
        ancho_prev = page.evaluate("() => document.getElementById('ci-t-preview').style.width")
        assert ancho_prev == "72mm", f"La vista previa tiene que medir el ancho util: {ancho_prev}"
        page.fill("#ci-t-pie", "Hasta la proxima")
        page.locator("#ci-guardar").click()
        page.wait_for_timeout(300)
        guardado = json.loads(page.evaluate("() => localStorage.getItem('sga_print_config')"))
        assert guardado["ticket"]["anchoPapel"] == 80 and guardado["ticket"]["anchoUtil"] == 72
        assert guardado["ticket"]["pie"] == "Hasta la proxima"
        page.reload(); page.wait_for_load_state("networkidle"); page.wait_for_timeout(600)
        assert page.locator("#ci-t-papel").input_value() == "80" and page.locator("#ci-t-pie").input_value() == "Hasta la proxima"
        print("OK - guardado en localStorage y sobrevive a recargar")

        # ── 3. Ticket de prueba ─────────────────────────────────────────────────
        print("=== 3) Ticket de prueba (calibracion) ===")
        page.evaluate("() => { window.__h = null; window.SGA_Impresion.imprimirHTML = (h) => { window.__h = h; return Promise.resolve(); }; }")
        page.locator("#ci-t-prueba").click()
        page.wait_for_timeout(200)
        h = page.evaluate("window.__h")
        assert h and "TICKET DE PRUEBA" in h and "72 mm de ancho" in h and "size: 80mm auto" in h, "El ticket de prueba no refleja la config"
        print("OK - la prueba muestra el ancho util y usa el rollo configurado")

        # ── 4. Etiquetas: presets, aviso, hoja de prueba ───────────────────────
        print("=== 4) Etiquetas: rollo, aviso de que no entra, hoja de prueba ===")
        page.select_option("#ci-e-preset", "rollo_50x30")
        page.wait_for_timeout(200)
        assert page.locator("#ci-e-ancho").input_value() == "50" and page.locator("#ci-e-alto").input_value() == "30"
        assert "una etiqueta de 50 × 30" in page.locator("#ci-e-info").inner_text()
        assert page.locator("#ci-e-g-cols").is_hidden(), "Columnas no aplica a un rollo"
        capturar_blob(page)
        page.locator("#ci-e-prueba").click()
        html = ultimo_blob(page)
        assert "@page { size: 50mm 30mm" in html and "Etiqueta de prueba N° 1" in html, "La hoja de prueba no usa el rollo 50x30"

        page.select_option("#ci-e-preset", "custom")
        page.select_option("#ci-e-modo", "hoja")
        page.fill("#ci-e-cols", "4"); page.fill("#ci-e-ancho", "70")
        page.locator("#ci-e-ancho").dispatch_event("input")
        page.wait_for_timeout(200)
        assert "se cortaría" in page.locator("#ci-e-info").inner_text(), "Falta el aviso de que 4 x 70 mm no entra en A4"
        print("OK")

        print("=== 4b) Tamaño propio para las etiquetas de promocion ===")
        assert page.locator("#ci-p-preset").input_value() == "a4_3x8", "Por defecto la promo es A4 3x8"
        assert "24" in page.locator("#ci-p-info").inner_text()
        page.select_option("#ci-p-preset", "a4_2x7")
        page.wait_for_timeout(200)
        capturar_blob(page)
        page.locator("#ci-p-prueba").click()
        html = ultimo_blob(page)
        assert "repeat(2, 105mm)" in html and html.count('class="etiq etiq-promo"') == 14, "Hoja de prueba de promo 2x7"
        page.locator("#ci-guardar").click()
        page.wait_for_timeout(300)
        guardado = json.loads(page.evaluate("() => localStorage.getItem('sga_print_config')"))
        assert guardado["etiquetasPromo"]["preset"] == "a4_2x7" and guardado["etiquetasPromo"]["alto"] == 42.4
        print("OK")

        # ── 5. Etiquetas imprime con la config ─────────────────────────────────
        print("=== 5) La pantalla de Etiquetas imprime con la configuracion ===")
        item = [{"id": "p1", "nombre": "Producto de prueba", "precio_venta": 1500, "codigo": "7790001112223", "cantidad": 2}]

        def imprimir_etiquetas():
            page.evaluate("(it) => localStorage.setItem('etiquetas_pending', JSON.stringify(it))", item)
            ir(page, "inicio")      # salir y volver: recien ahi se cargan los pendientes
            ir(page, "etiquetas")
            capturar_blob(page)
            page.locator("#etiq-btn-imprimir").click()
            return ultimo_blob(page)

        page.evaluate("() => localStorage.removeItem('sga_print_config')")           # defaults
        a4 = imprimir_etiquetas()
        assert "repeat(3, 70mm)" in a4 and "grid-auto-rows: 29.7mm" in a4 and "size: A4 portrait" in a4, \
            "Por defecto las etiquetas tienen que salir igual que siempre (A4, 3 columnas x 70 mm, 29,7 mm de alto)"
        assert a4.count('class="etiq"') == 1   # los pendientes entran con cantidad 1

        page.evaluate("() => window.SGA_Impresion.saveConfig({ etiquetas: { preset: 'rollo_50x30', modo: 'rollo', ancho: 50, alto: 30 } })")
        rollo = imprimir_etiquetas()
        assert "@page { size: 50mm 30mm" in rollo and "width: 50mm" in rollo and "repeat(3" not in rollo, \
            "Con rollo 50 x 30 tiene que salir una etiqueta por pagina"
        print("OK - por defecto A4 3x10 identico; con rollo sale 50 x 30 mm por pagina")

        # ── 6. Permisos ─────────────────────────────────────────────────────────
        print("=== 6) Permisos: sin el permiso no se ve ni se entra ===")
        crear_cajero(page, "u-sin", "sinpermiso", {"can_ver_productos": True})
        crear_cajero(page, "u-con", "conpermiso", {"can_ver_productos": True, "can_config_impresion": True})
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="sinpermiso", password="pass123")
        assert page.locator(NAV).count() == 0, "BUG: el item aparece sin tener el permiso"
        ir(page, "config_impresion")
        assert page.locator("#ci-guardar").count() == 0, "BUG: la ruta no esta bloqueada para quien no tiene el permiso"
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="conpermiso", password="pass123")
        assert page.locator(NAV).count() == 1, "Con el permiso el item tiene que aparecer"
        page.locator(NAV).click(); page.wait_for_timeout(600)
        assert page.locator("#ci-guardar").count() == 1
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_config_impresion")


if __name__ == "__main__":
    main()
