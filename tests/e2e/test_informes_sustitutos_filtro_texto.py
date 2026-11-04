"""
tests/e2e/test_informes_sustitutos_filtro_texto.py

Informes -> "Grupos de Sustitutos": filtro de texto arriba del todo (pedido del
usuario, 4/11/2026, el mismo día que "Editar grupo..." y el buscador con teclado —
ver test_informes_sustitutos_editar_grupo.py). Escribir, por ejemplo, "arroz" muestra
solo los grupos donde la referencia O CUALQUIER MIEMBRO tiene "arroz" en el nombre o
código — no alcanza con mirar solo el nombre de la referencia, el producto buscado
puede estar como miembro común. También filtra la sección "sin grupo" cuando está
tildada.

El filtro re-renderiza SIN volver a consultar la base (rerenderVistaSustitutos, no
refrescarReporteSustitutos) — como reemplaza el innerHTML del panel en cada tecla,
hay que restaurar foco y posición del cursor a mano o se vuelve imposible tipear.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_sustitutos_filtro_texto.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login + seed: dos grupos ('arroz' y 'fideos') + un producto suelto ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const mk = (id, nombre) => window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [id, nombre, now, now, now]
            );
            const sust = (prod, ref) => window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES (?, ?, ?, 1, ?)`, [prod, ref, ref, now]
            );
            // "arroz" solo aparece en el MIEMBRO, no en el nombre de la referencia --
            // el filtro tiene que buscar en los dos lados, no solo en la referencia.
            mk('ft-ref1', 'FT Primera Marca 1kg');
            mk('ft-arroz-m1', 'FT Arroz Co-Marca 1kg');
            sust('ft-ref1', 'ft-ref1');
            sust('ft-arroz-m1', 'ft-ref1');

            mk('ft-fideos-ref', 'FT Fideos Matarazzo 500g');
            mk('ft-fideos-m1', 'FT Fideos Don Vicente 500g');
            sust('ft-fideos-ref', 'ft-fideos-ref');
            sust('ft-fideos-m1', 'ft-fideos-ref');

            mk('ft-suelto', 'FT Arroz Suelto Standalone');
          }
        """)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator("#inf-sel-reporte").select_option(label="Grupos de Sustitutos")
        page.wait_for_timeout(200)
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(500)

        print("--- Tipear 'arroz' encuentra el grupo por el MIEMBRO, no por la referencia ---")
        filtro = page.locator("#inf-sust-filtro")
        assert filtro.count() == 1, "Falta el input de filtro"
        filtro.click()
        page.keyboard.type("arroz", delay=30)
        page.wait_for_timeout(200)

        assert filtro.input_value() == "arroz", "El input deberia conservar lo tipeado"
        assert page.evaluate("document.activeElement.id") == "inf-sust-filtro", (
            "El foco no deberia perderse al re-renderizar en cada tecla"
        )

        filas = page.locator(".inf-table tbody tr")
        assert filas.count() == 1, f"Deberia quedar un solo grupo (el de 'arroz'): {filas.count()}"
        assert "FT Primera Marca 1kg" in filas.first.inner_text(), (
            "Deberia encontrar el grupo aunque 'arroz' este solo en el nombre del miembro, no de la referencia"
        )
        assert "FT Fideos" not in page.locator("#inf-results").inner_text().split("sin grupo")[0], (
            "El grupo de fideos no deberia aparecer filtrando por 'arroz'"
        )

        kpi_val = page.locator(".inf-kpi-value").first.inner_text()
        assert kpi_val.strip() == "1", f"El KPI 'Grupos' deberia reflejar el filtro: {kpi_val!r}"
        print("OK")

        print("--- La seccion 'sin grupo' tambien respeta el filtro ---")
        page.locator("#inf-chk-sin-grupo").check()
        page.wait_for_timeout(200)
        texto = page.locator("#inf-results").inner_text()
        assert "FT Arroz Suelto Standalone" in texto, "Deberia listarse (contiene 'arroz')"
        assert "FT Fideos" not in texto, "No deberia haber ningun 'fideos' colado en la lista filtrada"
        print("OK")

        print("--- Limpiar el filtro restaura todo ---")
        filtro.fill("")
        page.wait_for_timeout(200)
        filas2 = page.locator(".inf-table tbody tr")
        texto2 = page.locator("#inf-results").inner_text()
        assert "FT Fideos Matarazzo" in texto2, "Deberia reaparecer el grupo de fideos al limpiar el filtro"
        assert filas2.count() >= 2, f"Deberian volver a verse ambos grupos sembrados: {filas2.count()}"
        print("OK")

        assert not errors, f"Errores JS en pantalla: {errors}"

        print("\n=== OK: filtro de texto en Grupos de Sustitutos ===")
        browser.close()


if __name__ == "__main__":
    main()
