"""
tests/e2e/test_etiquetas_pausar_borrador.py

Etiquetas: salir a otra pantalla (ej. a atender una venta) y volver no pierde la
selección en curso. Pedido explícito del usuario (29/10/2026): dudaba si abandonar
Etiquetas a mitad de camino para hacer una venta le hacía perder el avance.

El router (app.js) llama `app.currentModule?.destroy?.()` antes de montar el módulo
siguiente — etiquetas.js no tenía `destroy()`, así que nunca se enteraba de que el
usuario se iba. Fix: `destroy()` guarda `_state.items` en localStorage
('etiquetas_draft') solo si hay algo seleccionado, y `init()` lo restaura (mergeado por
cantidad, no pisa lo que venga de 'etiquetas_pending' de Compras) y lo borra. Vive en el
navegador de esa compu — no via sync, es un dato 100% descartable una vez impreso.

Verifica: cantidad exacta restaurada al volver, notificación de recuperación, y que
imprimir o "Limpiar todo" no deja un borrador fantasma para la próxima vez.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_etiquetas_pausar_borrador.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        page.evaluate("window.location.hash = 'etiquetas'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Agregar Coca-Cola 2L, cantidad 3 ---")
        search = page.locator("#etiq-busqueda")
        search.click()
        search.type("Coca", delay=20)
        page.wait_for_timeout(350)
        page.locator(".etiq-drop-item").first.click()
        page.wait_for_timeout(150)
        qty = page.locator(".etiq-qty-input").first
        qty.fill("3")
        qty.dispatch_event("change")
        page.wait_for_timeout(150)

        print("--- Salir a Inicio (dispara destroy -> guarda el borrador) ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        draft = page.evaluate("localStorage.getItem('etiquetas_draft')")
        assert draft and "Coca-Cola" in draft, (
            f"BUG: destroy() debería haber guardado el borrador en localStorage. draft={draft!r}"
        )

        print("--- Volver a Etiquetas: debe restaurar la seleccion con la cantidad exacta ---")
        page.evaluate("window.location.hash = 'etiquetas'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        list_text = page.locator(".etiq-list").inner_text()
        assert "Coca-Cola 2L" in list_text, f"El producto debería reaparecer solo al volver: {list_text[:300]!r}"
        qty_after = page.locator(".etiq-qty-input").first.input_value()
        assert qty_after == "3", f"La cantidad restaurada debería ser 3, no {qty_after!r}"

        draft_after = page.evaluate("localStorage.getItem('etiquetas_draft')")
        assert draft_after is None, (
            f"BUG: el borrador debería borrarse al restaurarlo, no queda pegado para siempre. draft={draft_after!r}"
        )

        print("--- 'Limpiar todo' + salir no debe dejar un borrador fantasma ---")
        search.click()
        search.type("Coca", delay=20)
        page.wait_for_timeout(350)
        page.locator(".etiq-drop-item").first.click()
        page.wait_for_timeout(150)
        page.locator("#etiq-btn-limpiar").click()
        page.wait_for_timeout(150)

        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        draft_vacio = page.evaluate("localStorage.getItem('etiquetas_draft')")
        assert draft_vacio is None, (
            f"BUG: 'Limpiar todo' debería dejar el borrador vacío, no guardar un carrito fantasma: {draft_vacio!r}"
        )

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_etiquetas_pausar_borrador: PASA")


if __name__ == "__main__":
    run()
