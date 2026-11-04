"""
tests/e2e/test_informes_sustitutos_editar_grupo.py

Informes -> "Grupos de Sustitutos", dos mejoras pedidas por el usuario (4/11/2026) tras
usar el sistema para liberar y reasignar productos de un grupo real:

1. El modal "Editar grupo…" ahora también deja SUMAR un producto nuevo al grupo (motor
   único, SGA_Buscador), no solo tildar/destildar los que ya estaban. Si el producto
   elegido es a su vez referencia de otros (tiene seguidores propios), se suman también
   esos seguidores — dejarlo afuera crearía una cadena rota (ver invariante #2 del
   motor, `diagnosticar()`).
2. El reporte puede mostrar también los productos ACTIVOS que no tienen ningún grupo de
   sustitutos (filtro "Mostrar también productos sin grupo"), cada uno con un botón
   "+ Agregar a un grupo" que abre un buscador acotado para elegir la referencia.
3. Esos dos buscadores (sumar al grupo / agregar a un grupo) se navegan con flecha
   arriba/abajo + Enter, como todos los demás buscadores del sistema (motor único,
   `Buscador.attachDropdownKeyboard`) — faltaba conectarlo, pedido explícito del
   usuario al ver el buscador sin esa navegación.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_sustitutos_editar_grupo.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def estado_db(page):
    return page.evaluate("""() => Object.fromEntries(
      window.SGA_DB.query(`SELECT producto_id, referencia_id FROM producto_sustitutos
                           WHERE producto_id LIKE 'eg-%' AND referencia_id IS NOT NULL`)
        .map(r => [r.producto_id, r.referencia_id]))""")


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

        print("--- Login + seed ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const mk = (id, nombre) => window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [id, nombre, now, now, now]
            );
            const sust = (prod, ref) => window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES (?, ?, ?, 1, ?)`, [prod, ref, ref, now]
            );
            mk('eg-ref1',   'EG Grupo Uno Referencia');
            mk('eg-m1',     'EG Grupo Uno Miembro');
            mk('eg-libre',  'EG Producto Libre Sin Grupo');
            mk('eg-ref2',   'EG Referencia Con Seguidor');
            mk('eg-f2',     'EG Seguidor De Ref2');
            mk('eg-standalone', 'EG Standalone Para Filtro');
            mk('eg-kb-standalone', 'EG Teclado Standalone');
            mk('eg-kb-aaa', 'EG Teclado Candidato Aaa');
            mk('eg-kb-bbb', 'EG Teclado Candidato Bbb');
            mk('eg-kb-ccc', 'EG Teclado Candidato Ccc');
            sust('eg-ref1', 'eg-ref1');
            sust('eg-m1',   'eg-ref1');
            sust('eg-ref2', 'eg-ref2');
            sust('eg-f2',   'eg-ref2');
          }
        """)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator("#inf-sel-reporte").select_option(label="Grupos de Sustitutos")
        page.wait_for_timeout(200)
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(500)

        print("--- Abrir 'Editar grupo...' del grupo sano (eg-ref1) ---")
        page.locator('.inf-btn-editar-grupo[data-ref-id="eg-ref1"]').click()
        page.wait_for_timeout(200)
        editor = page.locator("#inf-sust-editor")
        assert editor.is_visible()
        assert editor.locator(".sg-miembro").count() == 2, "Deberian listarse ref1 + m1"

        print("--- Sumar un producto LIBRE (sin seguidores): no deberia avisar nada ---")
        page.fill("#sg-buscar", "EG Producto Libre")
        page.wait_for_timeout(300)
        page.locator("#sg-dd .sri").first.click()
        page.wait_for_timeout(200)
        assert editor.locator(".sg-miembro").count() == 3, "Deberia sumarse eg-libre (total 3)"
        assert editor.locator(".sg-miembro[value='eg-libre']").is_checked()
        nota = page.locator("#sg-nota-extra").inner_text()
        assert "seguidores" not in nota, f"No deberia avisar de seguidores para un producto libre: {nota!r}"

        print("--- Sumar una REFERENCIA con seguidor propio: arrastra tambien al seguidor ---")
        page.fill("#sg-buscar", "EG Referencia Con Seguidor")
        page.wait_for_timeout(300)
        page.locator("#sg-dd .sri").first.click()
        page.wait_for_timeout(200)
        assert editor.locator(".sg-miembro").count() == 5, "Deberian sumarse eg-ref2 Y eg-f2 (total 5)"
        assert editor.locator(".sg-miembro[value='eg-ref2']").is_checked()
        assert editor.locator(".sg-miembro[value='eg-f2']").is_checked(), "El seguidor de ref2 tiene que venir incluido"
        nota2 = page.locator("#sg-nota-extra").inner_text()
        assert "EG Seguidor De Ref2" in nota2, f"Deberia avisar que se sumo el seguidor: {nota2!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informes_sustitutos_editar_grupo.png"), full_page=True)

        print("--- Confirmar: los 5 quedan apuntando a eg-ref1 ---")
        page.locator("#sg-confirmar").click()
        page.wait_for_timeout(500)
        e = estado_db(page)
        for pid in ("eg-ref1", "eg-m1", "eg-libre", "eg-ref2", "eg-f2"):
            assert e.get(pid) == "eg-ref1", f"{pid} debería apuntar a eg-ref1: {e}"
        print("OK")

        print("--- Filtro 'sin grupo': eg-standalone no esta en ningun grupo todavia ---")
        chk = page.locator("#inf-chk-sin-grupo")
        assert chk.count() == 1
        assert not page.locator(".inf-btn-asignar-grupo").count(), "No deberia verse hasta tildar el filtro"
        chk.check()
        page.wait_for_timeout(300)
        texto_sin_grupo = page.locator("#inf-results").inner_text()
        assert "EG Standalone Para Filtro" in texto_sin_grupo, f"Deberia listar eg-standalone: {texto_sin_grupo[-500:]!r}"

        print("--- '+ Agregar a un grupo': lo suma a eg-ref1 ---")
        page.locator('.inf-btn-asignar-grupo[data-id="eg-standalone"]').click()
        page.wait_for_timeout(200)
        asignar = page.locator("#inf-sust-asignar")
        assert asignar.is_visible()
        page.fill("#sa-buscar", "EG Grupo Uno Referencia")
        page.wait_for_timeout(300)
        page.locator("#sa-dd .sri").first.click()
        page.wait_for_timeout(400)
        assert not page.locator("#inf-sust-asignar").count(), "El modal deberia cerrarse solo"
        e2 = estado_db(page)
        assert e2.get("eg-standalone") == "eg-ref1", f"eg-standalone deberia quedar en el grupo de ref1: {e2}"

        # Ojo: eg-standalone ahora SI aparece en el texto de #inf-results -- como miembro
        # del grupo de eg-ref1 en la tabla principal. Lo que hay que chequear es que ya
        # no tiene boton "+ Agregar a un grupo" (es decir, salio de la seccion "sin grupo").
        assert page.locator('.inf-btn-asignar-grupo[data-id="eg-standalone"]').count() == 0, (
            "Ya no deberia listarse en 'sin grupo' despues de asignarlo"
        )
        print("OK")

        print("--- Navegacion con flechas en el buscador (igual que el resto del sistema) ---")
        page.locator('.inf-btn-asignar-grupo[data-id="eg-kb-standalone"]').click()
        page.wait_for_timeout(200)
        page.fill("#sa-buscar", "EG Teclado Candidato")
        page.wait_for_timeout(300)
        items = page.locator("#sa-dd .sri")
        assert items.count() == 3, f"Deberian aparecer los 3 candidatos: {items.count()}"
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(100)
        resaltado = page.locator("#sa-dd .sri.sust-hl")
        assert resaltado.count() == 1 and "Bbb" in resaltado.inner_text(), (
            f"Deberia resaltar el SEGUNDO candidato (Bbb) tras 2x ArrowDown: {resaltado.inner_text() if resaltado.count() else 'ninguno'!r}"
        )
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        assert not page.locator("#inf-sust-asignar").count(), "Enter sobre el resaltado deberia confirmar y cerrar"
        e3 = estado_db(page)
        assert e3.get("eg-kb-standalone") == "eg-kb-bbb", (
            f"Deberia haber elegido el candidato resaltado con flechas (Bbb), no el primero: {e3}"
        )
        print("OK")

        assert not errors, f"Errores JS en pantalla: {errors}"

        print("\n=== OK: editar grupo (sumar productos) + filtro de productos sin grupo ===")
        browser.close()


if __name__ == "__main__":
    main()
