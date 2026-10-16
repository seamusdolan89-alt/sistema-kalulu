"""
tests/e2e/test_sugerencias_buzon.py — Buzón de Consultas y Sugerencias
(js/modules/sugerencias.js, 14/10/2026): cualquier usuario carga una consulta
o una sugerencia (con hasta 3 imágenes adjuntas), el admin las responde desde
Admin-POS.

Cubre:
1. POS: enviar una consulta CON una imagen adjunta (file picker), y una
   sugerencia sin imagen; un usuario no ve las entradas de otro (own-only).
2. Admin-POS: ve TODAS las entradas (de cualquier usuario), responde una
   consulta (sin decisión) y una sugerencia (con decisión obligatoria —
   intentar guardar sin elegir decisión falla y no cierra la entrada).
3. El filtro "Pendientes" vs "Todas" y el badge del menú (● N) reflejan la
   cantidad real de pendientes.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sugerencias_buzon.py
"""
import base64
import os
import sys
import tempfile

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

# PNG 1x1 mínimo válido, de sobra para probar el flujo de adjuntar/redimensionar.
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    tmp_png = os.path.join(tempfile.gettempdir(), "sugerencia_test_adjunto.png")
    with open(tmp_png, "wb") as f:
        f.write(PNG_1X1)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 950})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        # ─── PARTE 1: POS ────────────────────────────────────────────────
        print("--- POS: login + ir al buzón ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'sugerencias'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        mi_user_id = page.evaluate("window.SGA_Auth.getCurrentUser().id")

        print("--- Los filtros (solo admin) están ocultos en POS ---")
        assert not page.locator("#sug-filtros").is_visible()

        print("--- Enviar una CONSULTA con una imagen adjunta ---")
        page.fill("#sug-texto", "¿Cómo se usa el buscador de productos?")
        page.set_input_files("#sug-file-input", tmp_png)
        page.wait_for_timeout(300)
        assert page.locator(".sug-adjunto-thumb").count() == 1, "La miniatura del adjunto debería aparecer"
        page.locator("#sug-btn-enviar").click()
        page.wait_for_timeout(300)

        items = page.locator(".sug-item")
        assert items.count() == 1, f"Debería haber 1 item, hay {items.count()}"
        assert "Consulta" in items.nth(0).locator(".sug-badge-consulta").inner_text()
        assert "Pendiente" in items.nth(0).locator(".sug-badge-pendiente").inner_text()
        assert items.nth(0).locator("img[data-ver-foto]").count() == 1, "La consulta debería mostrar su foto"
        print("OK")

        print("--- La imagen adjunta abre el lightbox al clickear ---")
        items.nth(0).locator("img[data-ver-foto]").click()
        page.wait_for_timeout(150)
        assert page.locator("#sug-lightbox").evaluate("el => el.classList.contains('active')")
        page.locator("#sug-lightbox").click(position={"x": 5, "y": 5})
        page.wait_for_timeout(150)
        assert not page.locator("#sug-lightbox").evaluate("el => el.classList.contains('active')")
        print("OK")

        print("--- Enviar una SUGERENCIA sin imagen ---")
        page.locator('label[data-tipo="sugerencia"]').click()
        page.fill("#sug-texto", "Estaría bueno poder exportar el buzón a Excel.")
        page.locator("#sug-btn-enviar").click()
        page.wait_for_timeout(300)
        assert page.locator(".sug-item").count() == 2
        assert page.locator(".sug-badge-sugerencia").count() == 1
        print("OK")

        print("--- No se ven las entradas de OTRO usuario (own-only en POS) ---")
        q(page, """
            INSERT INTO sugerencias (id, sucursal_id, usuario_id, tipo, texto, estado, fecha, sync_status, updated_at)
            VALUES ('sug-otro-user', '1', 'otro-empleado-test', 'consulta', 'Pregunta de otra persona',
                    'pendiente', datetime('now'), 'synced', datetime('now'))
        """)
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        assert page.locator(".sug-item").count() == 2, "No debería verse la entrada de otro usuario"
        print("OK")

        # ─── PARTE 2: ADMIN-POS (pestaña nueva — otra "computadora") ────────
        print("--- Admin-POS: ve TODAS las entradas (sembradas a mano) ---")
        page = context.new_page()
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        login_via_seed(page, admin_pos=True)
        ts = "2026-10-14T10:00:00.000Z"
        q(page, """
            INSERT INTO sugerencias (id, sucursal_id, usuario_id, tipo, texto, estado, fecha, sync_status, updated_at)
            VALUES ('sug-a1', '1', ?, 'consulta', 'Como se usan los grupos de sustitutos',
                    'pendiente', ?, 'synced', ?)
        """, [mi_user_id, ts, ts])
        q(page, """
            INSERT INTO sugerencias (id, sucursal_id, usuario_id, tipo, texto, estado, fecha, sync_status, updated_at)
            VALUES ('sug-a2', '1', ?, 'sugerencia', 'Agregar un atajo de teclado para X',
                    'pendiente', ?, 'synced', ?)
        """, ["otro-empleado-test", ts, ts])

        page.evaluate("window.location.hash = 'sugerencias'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        assert page.locator("#sug-filtros").is_visible()
        assert page.locator(".sug-item").count() == 2, "Admin debería ver las 2 entradas pendientes sembradas"
        print("OK")

        print("--- El badge del menu muestra 2 pendientes ---")
        badge = page.locator('a[data-module="sugerencias"]')
        assert "2" in badge.inner_text()
        print("OK")

        # El filtro por defecto es "Pendientes": una vez respondida, la entrada
        # sale de esa vista (es el comportamiento real, se verifica más abajo).
        # Para poder revisar el contenido de cada una después de responderla,
        # el resto del test trabaja sobre "Todas".
        page.locator('[data-filtro="todas"]').click()
        page.wait_for_timeout(200)

        print("--- Responder la CONSULTA (sin decisión) ---")
        fila_consulta = page.locator('.sug-item[data-item="sug-a1"]')
        fila_consulta.locator("[data-abrir-responder]").click()
        page.wait_for_timeout(150)
        fila_consulta.locator(".sug-respuesta-input").fill("Se explica en el manual de Órdenes.")
        fila_consulta.locator("[data-guardar-respuesta]").click()
        page.wait_for_timeout(300)
        assert "Respondida" in fila_consulta.locator(".sug-badge-respondida").inner_text()
        assert "manual de Órdenes" in fila_consulta.locator(".sug-respuesta-box").inner_text()
        print("OK")

        print("--- Responder la SUGERENCIA sin elegir decisión: debe fallar ---")
        fila_sug = page.locator('.sug-item[data-item="sug-a2"]')
        fila_sug.locator("[data-abrir-responder]").click()
        page.wait_for_timeout(150)
        fila_sug.locator(".sug-respuesta-input").fill("Buena idea, lo evalúo.")
        fila_sug.locator("[data-guardar-respuesta]").click()
        page.wait_for_timeout(200)
        assert page.locator(".alert-error", has_text="decisión").count() == 1, \
            "Debería avisar que falta elegir una decisión"
        estado_sin_tocar = q(page, "SELECT estado FROM sugerencias WHERE id='sug-a2'")[0]["estado"]
        assert estado_sin_tocar == "pendiente", "No debería haberse cerrado sin la decisión"
        print("OK")

        print("--- Ahora con decisión 'Aceptada' sí guarda ---")
        fila_sug.locator('.sug-decision-radio[data-decision="aceptada"]').click()
        fila_sug.locator("[data-guardar-respuesta]").click()
        page.wait_for_timeout(300)
        assert "Respondida" in fila_sug.locator(".sug-badge-respondida").inner_text()
        assert "Aceptada" in fila_sug.locator(".sug-badge-aceptada").inner_text()
        print("OK")

        print("--- Filtro 'Pendientes' ahora vacio, 'Todas' sigue mostrando ambas ---")
        page.locator('[data-filtro="pendientes"]').click()
        page.wait_for_timeout(200)
        assert page.locator(".sug-item").count() == 0
        assert page.locator("#sug-empty").is_visible()
        page.locator('[data-filtro="todas"]').click()
        page.wait_for_timeout(200)
        assert page.locator(".sug-item").count() == 2
        print("OK")

        print("--- El badge desaparece al no quedar pendientes ---")
        page.evaluate("window.location.hash = ''")
        page.wait_for_timeout(100)
        page.evaluate("window.location.hash = 'sugerencias'")
        page.wait_for_timeout(300)
        badge2 = page.locator('a[data-module="sugerencias"]')
        assert "●" not in badge2.inner_text()
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: Buzón de Consultas y Sugerencias ===")
        browser.close()

    os.remove(tmp_png)


if __name__ == "__main__":
    main()
