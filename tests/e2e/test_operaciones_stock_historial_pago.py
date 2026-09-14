"""
tests/e2e/test_operaciones_stock_historial_pago.py — Historial de compras
(Operaciones de Stock): regresion de un bug real reportado por el usuario.

La columna "Pago" mostraba SIEMPRE "Pendiente", incluso en compras ya
pagadas. Causa: se leia compras.condicion_pago, un campo que se carga UNA
VEZ al confirmar la compra y nunca se actualiza despues — y compras_v2.js
no tiene ningun toggle para marcarlo "efectivo" al cargar (siempre queda
'pendiente', ver tests/e2e/README.md). El estado real de pago vive en
imputaciones_pagos, el mismo calculo que ya usa Cuentas Corrientes de
Proveedores (_getPagadoDeCompra) para decidir que compras siguen abiertas.

Fix: la columna "Pago" y el header del modal "Ver" ahora comparan
total - SUM(imputaciones_pagos.monto_imputado) en vez de mirar el campo
fijo. Se agrega ademas, solo en ADMIN POS, un header mas completo al
revisar una compra vieja (estado, desglose de IVA/percepciones si hay,
quien la cargo) en vez de solo el listado de productos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_historial_pago.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")  # consola de Windows (cp1252) no imprime los emoji del reporte

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

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- 3 compras: sin pagar, pagada del todo, pagada a medias ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            // OJO: getCurrentUser().id puede no coincidir con la fila real de
            // `usuarios` en una base recien re-seedeada in place (admin_pos=True) —
            // la sesion cachea el id de ANTES del seed. Para el JOIN de
            // "Cargada por" hace falta el id que de verdad esta en la tabla.
            const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
            const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

            const compras = [
              { id: 'compra-sin-pagar', factura: '0001-1001', total: 1000 },
              { id: 'compra-pagada',    factura: '0001-1002', total: 1000 },
              { id: 'compra-parcial',   factura: '0001-1003', total: 1000 },
            ];
            for (const c of compras) {
              window.SGA_DB.run(
                `INSERT INTO compras
                   (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
                    total, total_factura, condicion_pago, estado, sync_status, updated_at)
                 VALUES (?, '1', ?, ?, ?, ?, '0001', ?, ?, 'pendiente', 'confirmada', 'pending', ?)`,
                [c.id, prov.id, usuarioId, now, c.factura.split('-')[1], c.total, c.total, now]
              );
              window.SGA_DB.run(
                `INSERT INTO compra_items (id, compra_id, cantidad, costo_unitario, subtotal, tipo)
                 VALUES (?, ?, 1, ?, ?, 'producto')`,
                [c.id + '-item', c.id, c.total, c.total]
              );
            }

            // Pago de $1000 imputado entero a 'compra-pagada'.
            window.SGA_DB.run(
              `INSERT INTO pagos_proveedores (id, proveedor_id, fecha, usuario_id, sync_status, updated_at)
               VALUES ('pago-1', ?, ?, ?, 'pending', ?)`,
              [prov.id, now, usuarioId, now]
            );
            window.SGA_DB.run(
              `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, monto_imputado, fecha)
               VALUES ('imp-1', 'pago-1', 'compra-pagada', 1000, ?)`,
              [now]
            );

            // Pago de $400 imputado a 'compra-parcial' (queda debiendo $600).
            window.SGA_DB.run(
              `INSERT INTO pagos_proveedores (id, proveedor_id, fecha, usuario_id, sync_status, updated_at)
               VALUES ('pago-2', ?, ?, ?, 'pending', ?)`,
              [prov.id, now, usuarioId, now]
            );
            window.SGA_DB.run(
              `INSERT INTO imputaciones_pagos (id, pago_id, compra_id, monto_imputado, fecha)
               VALUES ('imp-2', 'pago-2', 'compra-parcial', 400, ?)`,
              [now]
            );
          }
        """)

        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Abrir Historial de compras ---")
        page.locator('[data-action="historial_compras"]').click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ops_historial_pago.png"), full_page=True)

        filas = page.evaluate("""
          () => [...document.querySelectorAll('#ops-historial-body tbody tr')].map(tr => {
            const tds = tr.querySelectorAll('td');
            return { factura: tds[2].textContent.trim(), pago: tds[6].textContent.trim() };
          })
        """)
        print(f"Filas del historial: {filas}")

        por_factura = {f['factura']: f['pago'] for f in filas}
        assert '0001-1001' in por_factura and 'Pendiente' in por_factura['0001-1001'], (
            f"Compra sin pagar deberia decir Pendiente: {por_factura}"
        )
        assert '0001-1002' in por_factura and 'Pagada' in por_factura['0001-1002'], (
            f"BUG: compra pagada del todo sigue diciendo Pendiente: {por_factura}"
        )
        assert '0001-1003' in por_factura and 'Parcial' in por_factura['0001-1003'], (
            f"BUG: compra pagada a medias no distingue el pago parcial: {por_factura}"
        )
        assert '600' in por_factura['0001-1003'], (
            f"El saldo pendiente de la compra parcial deberia mostrar $600: {por_factura['0001-1003']!r}"
        )

        print("--- 'Ver' sobre la compra pagada: header enriquecido en ADMIN POS ---")
        page.evaluate("""
          () => {
            const rows = [...document.querySelectorAll('#ops-historial-body tbody tr')];
            const row = rows.find(r => r.textContent.includes('0001-1002'));
            row.querySelector('[data-ver-compra]').click();
          }
        """)
        page.wait_for_timeout(400)
        detalle_text = page.locator("#ops-detalle-body").inner_text()
        print(f"Detalle: {detalle_text[:400]!r}")

        assert 'Confirmada' in detalle_text, f"Falta el estado de la compra en el header: {detalle_text[:400]!r}"
        assert 'Pagada' in detalle_text, f"Falta el estado de pago real en el header: {detalle_text[:400]!r}"
        assert 'Cargada por' in detalle_text and 'Admin' in detalle_text, (
            f"Falta quien cargo la compra en el header (ADMIN POS): {detalle_text[:400]!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Historial de compras: estado de pago real (no el campo fijo) y header completo en Ver (admin-pos).")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
