"""
tests/e2e/test_informes_resumen_otros.py — Regresión: el reporte "Resumen
Diario de Caja" (Informes, POS) sumaba cualquier medio de pago custom (ej.
"Link de Pago", agregado desde Configuración) al "Total cobrado", pero no
lo mostraba en ninguna columna del desglose (Efectivo/Mercado
Pago/Tarjeta/Transferencia eran las únicas 4 columnas, hardcodeadas) — esa
plata quedaba invisible aunque el total cuadrara. Mismo patrón raíz que
`test_pos_cobro_multiple_medio_custom.py`, pero en el reporte en vez del
POS. El panel legacy `admin/app.js` tenía el mismo problema en el mismo
reporte.

Cubre: una venta pagada con Mercado Pago + una venta pagada con un medio
custom, y que el Resumen Diario muestre el custom en la columna "Otros" y
lo sume bien al total y al neto.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_resumen_otros.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def generar_reporte(page, reporte_id):
    page.select_option("#inf-sel-reporte", reporte_id)
    page.wait_for_timeout(200)
    page.locator("#inf-btn-generar").click()
    page.wait_for_timeout(500)
    return page.locator("#app").inner_text()


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

        print("--- Login POS (sga.db) + seed + abrir caja ---")
        login_via_seed(page, admin_pos=False)
        abrir_caja_si_hace_falta(page)

        print("--- Insertar medio custom + 2 ventas directas por SQL "
              "(Mercado Pago $100, Link de Pago $60) ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;

            window.SGA_DB.run(
              `INSERT INTO medios_cobro (id, nombre, icono, activo, orden, sync_status, updated_at)
               VALUES ('link_de_pago', 'Link de Pago', '🔗', 1, 2, 'pending', ?)`,
              [now]
            );

            const ventas = [
              { id: 'venta-mp-1',   total: 100, medio: 'mercadopago',   monto: 100 },
              { id: 'venta-link-1', total: 60,  medio: 'link_de_pago',  monto: 60  },
            ];
            for (const v of ventas) {
              window.SGA_DB.run(
                `INSERT INTO ventas (id, sucursal_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
                 VALUES (?, '1', ?, ?, ?, 0, ?, 'completada', 'pending', ?)`,
                [v.id, usuarioId, now, v.total, v.total, now]
              );
              window.SGA_DB.run(
                `INSERT INTO venta_pagos (id, venta_id, medio, monto, referencia)
                 VALUES (?, ?, ?, ?, NULL)`,
                [v.id + '-pago', v.id, v.medio, v.monto]
              );
            }
          }
        """)
        page.wait_for_timeout(200)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Resumen Diario de Caja ---")
        text = generar_reporte(page, "resumen_diario")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informe_resumen_otros.png"), full_page=True)

        # El header <th> tiene text-transform:uppercase via CSS, e innerText()
        # devuelve el texto ya transformado (visible), no el markup crudo.
        assert "OTROS" in text.upper(), f"Falta la columna 'Otros' en el reporte: {text[:800]!r}"
        assert "100,00" in text, f"No se ve el cobro de Mercado Pago ($100): {text[:800]!r}"
        assert "60,00" in text, (
            f"BUG: el pago con medio custom 'Link de Pago' ($60) no aparece en ninguna "
            f"columna del desglose: {text[:800]!r}"
        )
        assert "160,00" in text, (
            f"Total cobrado esperado $160,00 (100 Mercado Pago + 60 Link de Pago): {text[:800]!r}"
        )

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Resumen Diario de Caja: medio custom 'Link de Pago' aparece en "
              "columna 'Otros' y suma bien al total.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
