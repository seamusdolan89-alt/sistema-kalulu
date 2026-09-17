"""
tests/e2e/test_sync_historial_fondo.py

Pedido del usuario (17/9): un celular que entra por primera vez a Admin-POS
(dispositivo nuevo) se quedaba en "Descargando datos..." indefinidamente
contra producción real — `initialSyncFromFirestore()` bloqueaba TODA la app
detrás del overlay hasta terminar de bajar las ~28 colecciones completas
(incluidas ventas/compras/movimientos de stock de meses o años, ya
acotadas por MOBILE_SKIP_COLLECTIONS pero igual grandes).

Fix en js/sync.js: `initialSyncFromFirestore()` separa las colecciones en
dos lotes:
  - `ESSENTIAL_COLLECTIONS` (usuarios, categorías, proveedores, productos,
    stock, medios_cobro, sucursales) — catálogo cuyo tamaño depende de
    CUÁNTOS productos/proveedores existen, no de cuánto tiempo lleva
    operando el negocio. Se espera (bloqueante) antes de cerrar el overlay.
  - El resto (ventas, compras, movimientos de stock, órdenes, etc.) —
    crece con el TIEMPO de uso real, es lo que se volvía lento. Se dispara
    con `syncHistoricalInBackground()` SIN esperarlo (fire-and-forget): el
    usuario ya puede entrar y usar Productos/Inicio mientras ese resto sigue
    bajando solo, con el badge de sync (🟡→🟢) como único indicador.

Verificado a mano contra dev-kalulu (nunca contra producción) con un
producto (esencial) y una venta (histórico) recién escritos: al cerrarse el
overlay el producto ya estaba, la venta no — recién apareció tras esperar
`window.SGA_Sync.getHistoricalSyncPromise()`.

Este test corre con `block_firebase` (como el resto de la suite), así que no
puede reproducir esa espera real — verifica la lista de decisión en sí
(expuesta en window.SGA_Sync, mismo criterio que MOBILE_SKIP_COLLECTIONS) y
que `initialSyncFromFirestore` no rompe nada cuando Firestore está
bloqueado (cae al catch existente, el overlay igual se cierra).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_historial_fondo.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        login_via_seed(page, wait_target="productos", admin_pos=True)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        essential = page.evaluate("() => Array.from(window.SGA_Sync.ESSENTIAL_COLLECTIONS)")
        print("ESSENTIAL_COLLECTIONS:", essential)

        must_be_essential = {
            'usuarios', 'categorias', 'proveedores', 'productos', 'stock',
            'medios_cobro', 'sucursales',
        }
        assert set(essential) == must_be_essential, (
            f"ESSENTIAL_COLLECTIONS cambió respecto de lo esperado — si agregaste una "
            f"colección nueva de catálogo (chica, no depende del tiempo de uso), sumala "
            f"acá también. Actual: {set(essential)} | Esperado: {must_be_essential}"
        )
        print("OK - ESSENTIAL_COLLECTIONS son exactamente las de catálogo (rápidas, bloqueantes)")

        must_NOT_be_essential = {
            'ventas', 'compras', 'stock_ajustes', 'ordenes_compra',
            'pagos_proveedores', 'gastos', 'sesiones_caja', 'remitos',
            'devoluciones', 'promociones', 'egresos_caja', 'ingresos_caja',
        }
        overlap = must_NOT_be_essential.intersection(set(essential))
        assert not overlap, (
            f"estas colecciones crecen con el TIEMPO de uso real (historial) — no deberían "
            f"esperarse antes de cerrar el overlay, van en el lote de fondo: {overlap}"
        )
        print("OK - las colecciones de historial (ventas/compras/etc.) quedan afuera de lo esencial")

        # getHistoricalSyncPromise existe y no explota si todavía no corrió
        # ningún sync (caso normal: este seed no pasa por initialSyncFromFirestore)
        promise_ok = page.evaluate("() => typeof window.SGA_Sync.getHistoricalSyncPromise === 'function'")
        assert promise_ok, "getHistoricalSyncPromise debería estar expuesto en window.SGA_Sync"
        initial_value = page.evaluate("() => window.SGA_Sync.getHistoricalSyncPromise()")
        assert initial_value is None, (
            f"antes de que corra initialSyncFromFirestore, getHistoricalSyncPromise() debería "
            f"dar null (todavía no se disparó nada de fondo), dio: {initial_value}"
        )
        print("OK - getHistoricalSyncPromise() expuesto y en null antes de cualquier sync")

        ctx.close()
        browser.close()
        print("\n=== TODOS LOS CHECKS DE SYNC ESENCIAL/HISTORIAL DE FONDO PASARON ===")


if __name__ == "__main__":
    run()
