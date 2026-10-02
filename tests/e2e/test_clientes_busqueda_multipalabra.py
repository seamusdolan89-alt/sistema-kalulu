"""
tests/e2e/test_clientes_busqueda_multipalabra.py — Buscar un cliente por
nombre + apellido ("mateo b") en Clientes.

Bug real (2/10/2026): la búsqueda comparaba el texto completo contra cada
columna por separado (nombre, apellido, teléfono, lote), así que "mateo" daba
resultados pero "mateo b" no daba ninguno. Fix: `buildSearchCond()` en
`js/modules/clientes.js` — cada palabra debe aparecer en algún campo.

Correr (server ya levantado en :8765):

    python tests/e2e/test_clientes_busqueda_multipalabra.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const ins = (id, nombre, apellido, lote, tel) => window.SGA_DB.run(
    `INSERT INTO clientes (id, nombre, apellido, lote, telefono, activo, sync_status, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)`, [id, nombre, apellido, lote, tel, now]);
  ins('c-bs-1', 'Mateo', 'Aldao', null, null);
  ins('c-bs-2', 'Mateo', 'Bourdieu', '5078', '1156636695');
}
"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'clientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.evaluate(SEMBRAR)

        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(200)
        page.evaluate("window.location.hash = 'clientes'")
        page.wait_for_timeout(400)

        def buscar(texto):
            page.fill("#cl-search-input", texto)
            page.wait_for_timeout(700)  # debounce
            return page.locator("tbody tr", has_text="Mateo").count()

        assert buscar("mateo") == 2, "'mateo' debería traer a los dos Mateo"
        assert buscar("mateo b") == 1, "'mateo b' debería traer solo a Mateo Bourdieu"
        assert buscar("mateo bourdieu") == 1, "'mateo bourdieu' debería traer 1"
        assert buscar("bourdieu mateo") == 1, "el orden de las palabras no debe importar"
        assert buscar("mateo ald") == 1, "'mateo ald' debería traer solo a Mateo Aldao"
        assert buscar("mateo zzz") == 0, "'mateo zzz' no debería traer a nadie"

        # search() (POS / selectores) usa la misma lógica
        n = page.evaluate("window.SGA_Clientes.search('mateo b').length")
        assert n == 1, f"SGA_Clientes.search('mateo b') devolvió {n}"

        assert not errors, f"Errores JS: {errors}"
        print("OK - búsqueda de clientes por varias palabras.")
        browser.close()


if __name__ == "__main__":
    main()
