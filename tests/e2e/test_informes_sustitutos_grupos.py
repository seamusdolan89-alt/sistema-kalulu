"""
tests/e2e/test_informes_sustitutos_grupos.py — Nuevo reporte "Grupos de
Sustitutos" en Informes: auditoria de producto_sustitutos para detectar
cadenas rotas.

Motivo: el modelo no tiene una tabla de "grupo" con ID propio -- cada fila es
(producto_id, referencia_id). Un producto puede terminar apuntando como
referencia a otro producto que, a su vez, ya tiene su PROPIA fila con una
referencia distinta (se unio a otro grupo despues). El sistema no resuelve
esa cadena en ningun lado -- el stock/reposicion del primer producto queda
huerfano, apuntando a un producto que ya no es la referencia real del grupo.
Caso real reportado por el usuario: "Maizena Almidon de Maiz x220g" -> tenia
como referencia a "Chango Almidon de Maiz 500gr", pero Chango se unio despues
al grupo de "Dimax Almidon de Maiz 500gr" como miembro. Maizena se quedo
apuntando a un intermediario que ya no es la referencia real.

Este reporte no arregla el dato -- lo expone para que se pueda auditar el
resto del catalogo antes de decidir un fix del flujo que lo permite
(editor-producto.js, setReferencia/addMiembroGrupo).

Cubre:
- El reporte aparece en el combo de Informes.
- No pide periodo (a diferencia de los reportes por fecha).
- Detecta la cadena de 2 niveles del caso de arriba: el grupo de la
  referencia real (sin problema) y el grupo del intermediario (con problema,
  mencionando cual es la referencia real a la que deberia apuntar).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_sustitutos_grupos.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Armar la cadena rota: Referencia Real <- Intermedio <- Seguidor ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const mk = (id, nombre) => window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [id, nombre, now, now, now]
            );
            mk('sust-ref-real',  'Producto Sustituto Test - Referencia Real');
            mk('sust-intermed',  'Producto Sustituto Test - Intermedio');
            mk('sust-seguidor',  'Producto Sustituto Test - Seguidor');

            // Grupo real: la referencia real y el intermedio (miembro).
            window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES ('sust-ref-real', 'sust-ref-real', 'sust-ref-real', 1, ?)`, [now]
            );
            window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES ('sust-intermed', 'sust-ref-real', 'sust-ref-real', 1, ?)`, [now]
            );
            // El seguidor quedo apuntando al intermedio, que ya no es la referencia real.
            window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES ('sust-seguidor', 'sust-intermed', 'sust-intermed', 1, ?)`, [now]
            );
          }
        """)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- El reporte esta en el combo ---")
        opciones = page.locator("#inf-sel-reporte option").all_inner_texts()
        assert "Grupos de Sustitutos" in opciones, f"Falta el reporte en el combo: {opciones}"
        print("OK")

        page.locator("#inf-sel-reporte").select_option(label="Grupos de Sustitutos")
        page.wait_for_timeout(200)

        print("--- No pide periodo ---")
        assert page.locator("#inf-error, .inf-error").count() == 0
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informes_sustitutos_grupos.png"), full_page=True)

        report_text = page.locator("#app").inner_text()
        assert "no depende de un período" in report_text or "Estado al" in report_text, (
            f"Deberia generar sin pedir periodo: {report_text[:400]!r}"
        )
        print("OK - genero sin pedir rango de fechas")

        print("--- Detecta la cadena rota ---")
        filas = page.locator(".inf-table tbody tr")
        n = filas.count()
        textos = [filas.nth(i).inner_text() for i in range(n)]

        # Primera celda de la fila = nombre de la referencia de ESE grupo (no
        # alcanza con "contains": el intermedio tambien aparece listado como
        # miembro dentro de la fila de la referencia real).
        fila_intermedio = next((t for t in textos if t.split("\t")[0] == "Producto Sustituto Test - Intermedio"), None)
        assert fila_intermedio, f"No aparece el grupo del intermedio: {textos}"
        assert "Sí" in fila_intermedio and "Referencia Real" in fila_intermedio, (
            f"Deberia marcar problema y mencionar la referencia real: {fila_intermedio!r}"
        )
        assert "Seguidor" in fila_intermedio, (
            f"El seguidor deberia listarse como miembro del grupo del intermedio: {fila_intermedio!r}"
        )
        print("OK - fila del intermedio marca el problema y menciona la referencia real")

        fila_real = next((t for t in textos if t.split("\t")[0] == "Producto Sustituto Test - Referencia Real"), None)
        assert fila_real, f"No aparece el grupo de la referencia real: {textos}"
        assert "No" in fila_real, f"El grupo de la referencia real no deberia marcar problema: {fila_real!r}"
        print("OK - fila de la referencia real no marca problema")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("\n=== OK: reporte 'Grupos de Sustitutos' detecta la cadena rota ===")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
