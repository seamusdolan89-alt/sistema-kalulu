"""
tests/e2e/test_stock_ajustes_sync.py — Regresion critica: ningun ajuste de
stock (Ingreso por Ajuste, Ajuste negativo, Consumo Interno, Rotura,
Vencimiento) marcaba la fila de `stock` como pendiente de sincronizar.

Reportado por el usuario (16/9/2026): hizo un ajuste positivo de stock de
"Kinder Maxi" en POS y al dia siguiente no aparecia reflejado en Admin-POS
(que si mostraba bien el stock desde el POS). Investigando se encontro que
el mismo patron fallaba en LAS CINCO pantallas de ajuste/salida de stock,
no solo en la reportada -- ver [[feedback_buscar_bug_en_todos_lados]].

Causa: cada una de esas pantallas hace `UPDATE stock SET cantidad = cantidad
+/- ?, fecha_modificacion = ? WHERE producto_id = ? AND sucursal_id = ?` SIN
`sync_status = 'pending'` ni `updated_at`. El push (syncSource() en
js/sync.js) solo manda filas de `stock` con `sync_status = 'pending'` -- sin
esa marca, el cambio de cantidad queda guardado localmente pero JAMAS viaja
a la otra maquina. La fila espejo en `stock_ajustes` (el historial que
muestra el editor de producto) si se marcaba pendiente correctamente, por
eso el movimiento aparecia en el historial pero el numero de stock no se
actualizaba -- exactamente el sintoma reportado.

Fix: agregar `sync_status = 'pending', updated_at = ?` a las 5 consultas
(ajuste_stock.js, ajuste_stock_positivo.js, consumo_interno.js, roturas.js,
vencimientos.js).

Este test no valida el viaje real por Firestore (bloqueado por
block_firebase, como el resto de la suite) -- valida la condicion exacta
que syncSource() chequea antes de empujar: `stock.sync_status = 'pending'`
en la fila del producto ajustado, inmediatamente despues de cada accion.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_stock_ajustes_sync.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, assert_stock_integro

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def reset_stock_sync(page, producto_nombre):
    """Simula que la fila ya viajo antes (sync_status='synced'), para poder
    verificar que la ACCION que sigue es la que la vuelve a marcar pending."""
    page.evaluate("""
      (nombre) => window.SGA_DB.run(
        "UPDATE stock SET sync_status = 'synced' WHERE producto_id = (SELECT id FROM productos WHERE nombre = ?)",
        [nombre]
      )
    """, producto_nombre)


def stock_sync_status(page, producto_nombre):
    return page.evaluate("""
      (nombre) => {
        const r = window.SGA_DB.query(
          "SELECT sync_status FROM stock WHERE producto_id = (SELECT id FROM productos WHERE nombre = ?)",
          [nombre]
        );
        return r.length ? r[0].sync_status : null;
      }
    """, producto_nombre)


def registrar_movimiento(page, hash_modulo, query, boton_texto, motivo=None):
    page.evaluate(f"window.location.hash = '{hash_modulo}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.locator("#ci-search-input").click()
    page.keyboard.type(query, delay=20)
    page.wait_for_timeout(400)
    page.locator("#ci-search-dropdown .sri").click()
    page.wait_for_timeout(300)
    if motivo:
        page.select_option("#ci-motivo", motivo)
    page.get_by_role("button", name=boton_texto, exact=True).click()
    page.wait_for_timeout(500)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        casos = [
            ("ajuste_stock_positivo", "Coca", "Registrar ajuste", None),
            ("ajuste_stock",          "Coca", "Registrar ajuste", None),
            ("consumo_interno",       "Coca", "Registrar consumo", "uso_interno"),
            ("roturas",               "Coca", "Registrar rotura", None),
            ("vencimientos",          "Coca", "Registrar vencimiento", None),
        ]

        for hash_modulo, query, boton, motivo in casos:
            print(f"--- {hash_modulo}: reset sync_status y registrar movimiento ---")
            reset_stock_sync(page, "Coca-Cola 2L")
            estado_antes = stock_sync_status(page, "Coca-Cola 2L")
            assert estado_antes == "synced", f"El reset no funciono: {estado_antes!r}"

            registrar_movimiento(page, hash_modulo, query, boton, motivo)

            estado_despues = stock_sync_status(page, "Coca-Cola 2L")
            assert estado_despues == "pending", (
                f"BUG: {hash_modulo} no marco la fila de stock como pendiente de sync "
                f"(quedo {estado_despues!r}) -- el cambio de cantidad nunca viajaria a la otra maquina"
            )
            print(f"OK - {hash_modulo} marca stock.sync_status='pending'")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "stock_ajustes_sync.png"), full_page=True)

        assert_stock_integro(page, 'al final de test_stock_ajustes_sync.py')
        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("\n=== OK: los 5 flujos de ajuste/salida de stock marcan la fila de stock pendiente de sync ===")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
