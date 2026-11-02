"""
tests/e2e/test_informes_redondeo_vuelto.py

Informes -> Resumen Diario de Caja: KPI "Descuento por redondeo de vuelto" (pedido
explícito del dueño, 2/11/2026, junto con la función de redondeo en sí — ver
tests/e2e/test_pos_redondeo_vuelto.py para el circuito completo en el POS). Vive
aparte de `ventas.descuento` (que lo sigue incluyendo, para que el total cobrado siga
cuadrando con la caja como siempre) en su propia columna `ventas.descuento_redondeo`,
justamente para poder auditar cuánto costó el redondeo sin mezclarlo con otros
descuentos — el motivo original de separarlo en dos columnas en vez de una sola.

Este test siembra ventas directamente por SQL (el circuito del POS ya está cubierto
en detalle por test_pos_redondeo_vuelto.py) y verifica que el KPI y la exportación
reflejen la suma correcta.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_redondeo_vuelto.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed ---")
        login_via_seed(page, admin_pos=True)

        print("--- Sembrar 2 ventas con descuento_redondeo + 1 sin redondeo ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const hoy = now.slice(0, 10);
            const mk = (id, subtotal, descRedondeo, descOtro) => {
              const descuento = descRedondeo + descOtro;
              window.SGA_DB.run(
                `INSERT INTO ventas (id, sucursal_id, sesion_caja_id, usuario_id, fecha, subtotal,
                   descuento, descuento_redondeo, total, estado, sync_status, updated_at)
                 VALUES (?, '1', NULL, NULL, ?, ?, ?, ?, ?, 'completada', 'pending', ?)`,
                [id, now, subtotal, descuento, descRedondeo, subtotal - descuento, now]
              );
              window.SGA_DB.run(
                `INSERT INTO venta_pagos (id, venta_id, medio, monto, referencia) VALUES (?, ?, 'efectivo', ?, NULL)`,
                [id + '-pago', id, subtotal - descuento]
              );
            };
            mk('v-red-1', 18570, 70, 0);     // redondeo $70
            mk('v-red-2', 5200, 30, 0);      // redondeo $30
            mk('v-red-3', 1000, 0, 100);     // descuento normal, SIN redondeo
            window.__hoyRedondeo = hoy;
          }
        """)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        page.select_option("#inf-sel-reporte", "resumen_diario")
        page.wait_for_timeout(100)
        hoy = page.evaluate("window.__hoyRedondeo")
        page.fill("#inf-desde", hoy)
        page.fill("#inf-hasta", hoy)
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(300)

        kpi_tile = page.locator(".inf-kpi", has_text="Descuento por redondeo de vuelto")
        assert kpi_tile.count() == 1, "Falta el KPI de redondeo en Resumen Diario"
        kpi_valor = kpi_tile.locator(".inf-kpi-value").inner_text()
        # 70 (venta 1) + 30 (venta 2) = 100 -- el descuento "normal" de la venta 3
        # ($100, sin redondeo) NO debería sumar acá; si diera 200 sería un bug real.
        assert "100,00" in kpi_valor and "200" not in kpi_valor, (
            f"Debería sumar 70+30=100 (sin el descuento normal de la venta 3): {kpi_valor!r}"
        )

        assert not errors, f"Errores JS en pantalla: {errors}"

        context.close()
        browser.close()
        print("\nOK - test_informes_redondeo_vuelto: PASA")


if __name__ == "__main__":
    main()
