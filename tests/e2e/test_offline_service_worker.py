"""
tests/e2e/test_offline_service_worker.py — La app carga sin internet después
de una visita online (ver CLAUDE.md "Offline / Service Worker", sw.js).

Hasta el 11/11/2026, sw.js era un stub "network-first" sin ningún cache.put
real -- a pesar del <meta description> "100% Offline" del index.html, cerrar
la pestaña (o reiniciar la compu) sin internet dejaba el sistema inutilizable
hasta que volviera la conexión (reportado por el usuario: se quedó sin
internet en el local). La base de datos (SQLite vía OPFS) siempre sobrevivió
sola, offline o no -- lo que faltaba era que el CÓDIGO (HTML/CSS/JS/el motor
SQLite que se carga por CDN) pudiera cargar sin red.

Este test simula el escenario real: login online (con datos demo), espera a
que el Service Worker termine de precachear, corta la red de verdad
(`context.set_offline`, no un mock de rutas) y recarga la página -- tiene que
volver a mostrar la app funcionando con los mismos datos, no una pantalla de
error de red.

Importante: usa el server REAL en 127.0.0.1 (no localhost u otro host) y NO
bloquea gstatic.com/jsdelivr.net/cdnjs.cloudflare.com (block_firebase ya los
deja pasar a propósito, son JS estático) -- son justamente los 3 hosts que
sw.js tiene que haber cacheado de verdad para que esto funcione.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_offline_service_worker.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login online (siembra datos demo, deja el Service Worker precacheando) ---")
        login_via_seed(page)  # POS, sga.db

        print("--- Esperar a que termine la instalación del Service Worker ---")
        page.wait_for_function("""
          async () => {
            const reg = await navigator.serviceWorker.ready;
            if (!reg.active) return false;
            const cache = await caches.open('kalulu-pos-v2');
            const keys = await cache.keys();
            // Suficiente como para confirmar que el precache real corrió
            // (no solo index.html) -- hoy son ~75 entradas (propias + CDN).
            return keys.length > 40;
          }
        """, timeout=30000)
        entradas = page.evaluate("caches.open('kalulu-pos-v2').then(c => c.keys()).then(k => k.length)")
        print(f"Entradas en cache: {entradas}")
        assert entradas > 40, f"Esperaba bastante más que 40 entradas precacheadas, hay {entradas}"

        print("--- Cortar la red de verdad (context.set_offline) y recargar ---")
        context.set_offline(True)
        page.reload()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(1500)

        print("--- La app tiene que seguir funcionando, no una pantalla de error de red ---")
        controller = page.evaluate("!!navigator.serviceWorker.controller")
        assert controller, "El Service Worker debería seguir controlando la pestaña offline"

        # Sigue logueado (la sesión vive en localStorage, no depende de red) y
        # el sidebar/nav de la app real está presente -- no un error de Chrome.
        page.wait_for_selector("#app-sidebar, nav", timeout=10000)
        texto = page.evaluate("document.body.innerText")
        assert "no se pudo conectar" not in texto.lower() and "err_internet" not in texto.lower(), (
            f"Parece una pantalla de error de red, no la app: {texto[:300]!r}"
        )

        print("--- Los datos sembrados siguen ahí (SQLite/OPFS no depende del Service Worker) ---")
        productos = page.evaluate("window.SGA_DB.query('SELECT COUNT(*) AS n FROM productos')[0].n")
        assert productos > 0, "La base local debería seguir teniendo los productos sembrados"
        print(f"Productos en la base local (offline): {productos}")

        assert not errors, f"Errores JS en pantalla estando offline: {errors}"

        context.set_offline(False)
        print("\n=== OK: la app carga y funciona sin internet tras una visita online previa ===")
        browser.close()


if __name__ == "__main__":
    main()
