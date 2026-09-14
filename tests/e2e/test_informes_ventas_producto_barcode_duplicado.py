"""
tests/e2e/test_informes_ventas_producto_barcode_duplicado.py — Regresion:
un producto con dos codigos de barras marcados es_principal=1 (mismo dato
sucio que rompia Ordenes de Compra, ver test_ordenes_barcode_duplicado.py)
hacia que "Ventas por Producto" en Informes DUPLICARA cada linea de venta
de ese producto ANTES de sumar -- el reporte mostraba el doble de unidades
vendidas y el doble de facturacion para ese producto. A diferencia del bug
de Ordenes (una fila duplicada, visible), este era invisible: el numero
del reporte simplemente estaba mal.

Causa: queryVentasProducto() (informes.js) hace SUM(vi.subtotal) con
GROUP BY p.id, pero el codigo de barras se traia con un LEFT JOIN filtrado
por es_principal=1 -- con dos "principales", cada linea de venta matcheaba
dos veces antes del SUM.

Fix: la misma subquery con LIMIT 1 que ya se usa en otros modulos, en vez
del JOIN. No afecta el calculo (el codigo mostrado es solo informativo),
elimina el fan-out.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_ventas_producto_barcode_duplicado.py
"""
import os
import sys

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

        print("--- Producto con codigo de barras duplicado + una venta de 3 unidades ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_Auth.getCurrentUser().id;

            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('prod-inf-dup', 'Producto Duplicado Test', 60, 100, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]
            );
            // La dirty data real: dos codigos de barras del mismo producto,
            // los dos marcados es_principal=1.
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('bc-inf-1','prod-inf-dup','8880000000001',1)`
            );
            window.SGA_DB.run(
              `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES ('bc-inf-2','prod-inf-dup','8880000000002',1)`
            );

            // Una venta completada: 3 unidades a $100 = $300, costo $60 c/u.
            window.SGA_DB.run(
              `INSERT INTO ventas (id, sucursal_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
               VALUES ('venta-inf-dup', '1', ?, ?, 300, 0, 300, 'completada', 'pending', ?)`,
              [usuarioId, now, now]
            );
            window.SGA_DB.run(
              `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
               VALUES ('vi-inf-dup', 'venta-inf-dup', 'prod-inf-dup', 3, 100, 60, 300)`
            );
            window.SGA_DB.run(
              `INSERT INTO venta_pagos (id, venta_id, medio, monto) VALUES ('vp-inf-dup', 'venta-inf-dup', 'efectivo', 300)`
            );
          }
        """)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Ampliar el rango de fechas para asegurar que la venta cae adentro ---")
        page.evaluate("""
          () => {
            const desde = document.getElementById('inf-desde');
            if (desde) desde.value = '2020-01-01';
          }
        """)

        print("--- Generar 'Ventas por Producto' (reporte por default) ---")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informes_ventas_producto_barcode_dup.png"), full_page=True)

        report_text = page.locator("#app").inner_text()
        assert "Producto Duplicado Test" in report_text, (
            f"El producto de prueba no aparece en el reporte: {report_text[:600]!r}"
        )

        filas = page.evaluate("""
          () => [...document.querySelectorAll('.inf-table tbody tr')]
            .filter(tr => tr.textContent.includes('Producto Duplicado Test')).length
        """)
        assert filas == 1, (
            f"BUG: el producto con codigo duplicado aparece en {filas} filas del reporte (deberia ser 1)"
        )

        cant_vendida = page.evaluate("""
          () => {
            const row = [...document.querySelectorAll('.inf-table tbody tr')]
              .find(tr => tr.textContent.includes('Producto Duplicado Test'));
            if (!row) return null;
            const cells = row.querySelectorAll('td');
            return cells[7].textContent.trim(); // Cant. vend.
          }
        """)
        print(f"Cant. vendida en el reporte: {cant_vendida!r}")
        assert cant_vendida == '3', (
            f"BUG: el reporte muestra {cant_vendida!r} unidades vendidas, deberian ser 3 "
            f"(el codigo de barras duplicado esta doblando el SUM)"
        )

        venta_total = page.evaluate("""
          () => {
            const row = [...document.querySelectorAll('.inf-table tbody tr')]
              .find(tr => tr.textContent.includes('Producto Duplicado Test'));
            const cells = row.querySelectorAll('td');
            return cells[9].textContent.trim(); // Venta total
          }
        """)
        print(f"Venta total en el reporte: {venta_total!r}")
        assert '300' in venta_total and '600' not in venta_total, (
            f"BUG: venta total deberia reflejar $300, no el doble: {venta_total!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Ventas por Producto no duplica ventas de un producto con codigo de barras duplicado.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
