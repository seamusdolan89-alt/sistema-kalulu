"""
tests/e2e/test_operaciones_stock_historial_orden.py — Historial de Compras: dos
compras cargadas el mismo día quedan ordenadas por orden real de carga, no al azar.

Bug reportado por el usuario probando en dev (28/9/2026): `compras.fecha` es la
fecha de la FACTURA (editable, solo el día — `todayDate()` en compras_v2.js), así
que dos compras cargadas el mismo día quedan con el mismo valor. El historial
ordenaba solo por `ORDER BY c.fecha DESC`, sin desempate: con un empate, el orden
que da SQLite no está garantizado — la compra recién cargada podía aparecer
SEGUNDA en vez de primera.

Fix: desempatar por `c.updated_at` (con hora real, se fija al confirmar), sin
tocar `fecha` (que sigue siendo la fecha de factura, editable por el usuario).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_historial_orden.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def facturas_visibles(page):
    return page.evaluate("""
      () => [...document.querySelectorAll('#ops-historial-body tbody tr')]
              .map(tr => tr.querySelectorAll('td')[2].textContent.trim())
    """)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place ---")
        login_via_seed(page, admin_pos=True)

        print("--- Dos compras con la MISMA fecha de factura (mismo día), cargadas en orden distinto ---")
        page.evaluate("""
          () => {
            const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
            const provId = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;
            const compras = [
              // Primera cargada (mas vieja por updated_at), factura 1001
              { id: 'c-orden-1', nro: '1001', updated: '2026-09-28T10:00:00.000Z' },
              // Cargada DESPUES (updated_at mas reciente), factura 1002 -- tiene que verse primero
              { id: 'c-orden-2', nro: '1002', updated: '2026-09-28T10:05:00.000Z' },
            ];
            for (const c of compras) {
              window.SGA_DB.run(
                `INSERT INTO compras
                   (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
                    total, total_factura, condicion_pago, estado, sync_status, updated_at)
                 VALUES (?, '1', ?, ?, '2026-09-28', ?, '0001', 500, 500, 'pendiente', 'confirmada', 'pending', ?)`,
                [c.id, provId, usuarioId, c.nro, c.updated]
              );
              window.SGA_DB.run(
                `INSERT INTO compra_items (id, compra_id, cantidad, costo_unitario, subtotal, tipo)
                 VALUES (?, ?, 1, 500, 500, 'producto')`, [c.id + '-i', c.id]
              );
            }
          }
        """)

        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator('[data-action="historial_compras"]').click()
        page.wait_for_timeout(400)

        facturas = facturas_visibles(page)
        print(f"Orden mostrado: {facturas}")
        idx_1001 = facturas.index("0001-1001")
        idx_1002 = facturas.index("0001-1002")
        assert idx_1002 < idx_1001, (
            f"BUG: la compra cargada DESPUÉS (factura 1002) tiene que verse primero que la 1001, "
            f"aunque compartan la misma fecha de factura: {facturas}")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "historial_orden_mismo_dia.png"), full_page=True)
        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - Historial de Compras desempata por orden real de carga cuando la fecha de factura coincide.")
        browser.close()


if __name__ == "__main__":
    main()
