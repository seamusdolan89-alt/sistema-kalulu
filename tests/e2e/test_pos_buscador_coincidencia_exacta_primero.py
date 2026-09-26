"""
tests/e2e/test_pos_buscador_coincidencia_exacta_primero.py — Regresión: un
producto cuyo nombre es EXACTAMENTE lo que se tipeó ("Naranja") no aparecía en
el buscador del carrito del POS.

Causa raíz: searchProductos() (pos.js) filtra con `nombre LIKE '%texto%'`, ordena
alfabéticamente y CORTA en 12 resultados, sin dar prioridad a la coincidencia
exacta ni al que empieza con lo tipeado. Con más de 12 productos que CONTIENEN
"naranja" (gaseosas, jugos, mermeladas, caramelos...) y que alfabéticamente
van antes que "Naranja", el producto "Naranja" quedaba en el puesto 13+ y nunca
se mostraba, por más que se tipeara el nombre completo. Reportado por el dueño
(26/9/2026): "nunca lo encuentro en el buscador del carrito".

El motor compartido (buscador_productos.js -> porTexto, que usan Roturas,
Vencimientos, Consumo Interno, Compras y Ordenes) tenía el mismo orden con
corte en 20.

Fix: ordenar primero la coincidencia exacta, después las que EMPIEZAN con lo
tipeado y por último las que lo contienen (cada grupo alfabético).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_buscador_coincidencia_exacta_primero.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Plantar 20 productos que CONTIENEN 'naranja' y van antes en el alfabeto, mas los que importan ---")
        page.evaluate("""
          () => {
            const ins = (id, nombre) => window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, activo, sync_status, updated_at)
               VALUES (?, ?, 10, 20, 1, 'synced', datetime('now'))`, [id, nombre]);
            for (let i = 1; i <= 20; i++) ins('tst-bebida-' + i, 'Bebida Naranja ' + String(i).padStart(2, '0'));
            ins('tst-naranja', 'Naranja');
            ins('tst-naranja-dulce', 'Naranja Dulce');
            ins('tst-naranjada', 'Naranjada');
          }
        """)

        print("--- Buscar por el motor compartido (porTexto): la coincidencia exacta va primera ---")
        orden = page.evaluate("""
          () => window.SGA_Buscador.porTexto('naranja', { sucursalId: null, limite: 20 }).map(p => p.nombre)
        """)
        print("   porTexto:", orden[:5])
        assert orden[0] == "Naranja", f"BUG (porTexto): la coincidencia exacta no va primera: {orden[:6]}"
        assert orden[1:3] == ["Naranja Dulce", "Naranjada"], (
            f"BUG (porTexto): los que EMPIEZAN con lo tipeado deben ir despues del exacto y antes de los que solo lo contienen: {orden[:6]}")
        assert len(orden) == 20, f"el limite sigue rigiendo: {len(orden)}"

        print("--- Buscar en el carrito del POS tipeando 'naranja' ---")
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)

        search = page.locator("#pos-search-input")
        search.click()
        search.type("naranja", delay=20)
        page.wait_for_timeout(500)

        nombres = page.locator("#pos-search-dropdown .sri-nombre").all_inner_texts()
        print("   carrito:", nombres[:5])
        assert nombres, "el dropdown quedo vacio"
        assert nombres[0] == "Naranja", (
            f"BUG: tipeando 'naranja' el producto 'Naranja' no aparece primero en el carrito: {nombres}")
        assert nombres[1:3] == ["Naranja Dulce", "Naranjada"], f"orden inesperado tras el exacto: {nombres}"
        assert len(nombres) == 12, f"el dropdown sigue cortando en 12: {len(nombres)}"

        print("--- Tipeando solo el comienzo ('naran'), los que empiezan igual van antes que los que lo contienen ---")
        search.fill("")
        search.type("naran", delay=20)
        page.wait_for_timeout(500)
        nombres2 = page.locator("#pos-search-dropdown .sri-nombre").all_inner_texts()
        assert nombres2[:3] == ["Naranja", "Naranja Dulce", "Naranjada"], (
            f"BUG: con 'naran' deberian ir primero los que EMPIEZAN igual: {nombres2}")

        print("--- Un producto exacto sigue apareciendo aunque se tipee en mayusculas ---")
        search.fill("")
        search.type("NARANJA", delay=20)
        page.wait_for_timeout(500)
        nombres3 = page.locator("#pos-search-dropdown .sri-nombre").all_inner_texts()
        assert nombres3[0] == "Naranja", f"BUG con mayusculas: {nombres3}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        print("OK - La coincidencia exacta y las que empiezan con lo tipeado se muestran antes que las que solo lo contienen.")
        browser.close()


if __name__ == "__main__":
    main()
