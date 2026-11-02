"""
tests/e2e/test_pos_redondeo_vuelto.py

"Redondeo de vuelto" (pedido del dueño, 2/11/2026): falta de billetes de baja
denominación + el cliente casi nunca los quiere igual. En un pago 100% efectivo con
vuelto, el POS sugiere montos "redondos" armados con hasta 3 billetes de las
denominaciones YA cargadas en el recuento de Caja (window.SGA_Caja.getDenominaciones),
nunca por debajo del vuelto exacto, acotados a un tope % del total de la venta (5%
sugerencia directa, 10% con un paso extra de confirmación "Ver opciones hasta 10%").
Aceptar una sugerencia registra la diferencia como `ventas.descuento_redondeo` —
aparte de `ventas.descuento` (que la sigue incluyendo, para que el total cobrado y el
arqueo de caja cuadren solos) — así Informes puede ver cuánto costó el redondeo aparte
de otros descuentos.

El algoritmo en sí (js/utils.js, sugerirRedondeoVuelto) tiene su propia lógica no
trivial: nunca sugiere el vuelto exacto (sería "gratis" armado con las denominaciones
que EXISTEN, no las que la cajera tiene a mano ahora — justamente el problema a
resolver), limita a 2 la repetición del mismo billete (si falta uno, probablemente
falten varios) y descarta combinaciones de más de 3 billetes (la más barata
matemáticamente puede terminar siendo 4-5 billetes distintos para ahorrar centavos,
mucho menos práctica que una de 2 billetes un poco más cara). Este test cubre el
circuito completo en el POS real, no solo la función.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_redondeo_vuelto.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta, assert_stock_integro

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


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
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")

        print("--- Producto a $18.570, sin cliente (venta a consumidor final) ---")
        page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
                 precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES ('p-redondeo-1', 'Producto Redondeo', 5000, 18570, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
              [now, now, now]);
            window.SGA_DB.moverStock({ productoId: 'p-redondeo-1', sucursalId: '1', delta: 10, tipo: 'ajuste_positivo',
                                       refTipo: 'stock_ajustes', refId: 'seed-p-redondeo-1', fecha: now });
          }
        """)

        abrir_caja_si_hace_falta(page)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)

        print("--- Agregar Producto Redondeo ($18.570) ---")
        page.locator("#pos-search-input").click()
        page.keyboard.type("Producto Redondeo", delay=15)
        page.wait_for_timeout(400)
        page.locator("#pos-search-dropdown .sri").click()
        page.wait_for_timeout(400)

        print("--- Paga con $20.000 en efectivo: vuelto exacto $1.430 ---")
        recibe = page.locator("#recibe-efectivo")
        recibe.click()
        recibe.fill("20000")
        page.wait_for_timeout(300)

        vuelto_text = page.locator("#efectivo-vuelto").inner_text()
        assert "1.430" in vuelto_text, f"Debería mostrar el vuelto exacto $1.430: {vuelto_text!r}"

        print("--- Debe sugerir $1.500 (1x$500 + 1x$1000) como primera opción ---")
        box = page.locator("#redondeo-box")
        assert box.count() == 1 and box.is_visible(), "El bloque de sugerencias de redondeo debería aparecer"
        primera = page.locator(".redondeo-btn").first
        assert "1.500" in primera.inner_text(), f"La primera sugerencia debería ser $1.500: {primera.inner_text()!r}"

        print("--- Aceptar la sugerencia ---")
        primera.click()
        page.wait_for_timeout(150)
        assert "redondeo-btn--sel" in (primera.get_attribute("class") or ""), "El botón elegido debería quedar resaltado"
        aplicado_text = page.locator("#redondeo-aplicado").inner_text()
        assert "1.500" in aplicado_text, f"Debería confirmar el vuelto redondeado: {aplicado_text!r}"

        print("--- Confirmar venta ---")
        btn = page.locator("text=CONFIRMAR VENTA")
        btn.click()
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_redondeo_ticket.png"), full_page=True)

        print("--- Verificar lo guardado en ventas/venta_pagos/caja ---")
        row = page.evaluate("""
          () => window.SGA_DB.query(`
            SELECT v.subtotal, v.descuento, v.descuento_redondeo, v.total,
                   (SELECT monto FROM venta_pagos WHERE venta_id = v.id AND medio = 'efectivo') AS pago_efectivo
            FROM ventas v WHERE v.id IN (
              SELECT venta_id FROM venta_items WHERE producto_id = 'p-redondeo-1'
            )
          `)[0]
        """)
        print(f"Venta guardada: {row}")
        assert abs(row["subtotal"] - 18570) < 0.01, f"Subtotal inesperado: {row}"
        assert abs(row["descuento_redondeo"] - 70) < 0.01, f"descuento_redondeo debería ser 70 (1500-1430): {row}"
        assert abs(row["descuento"] - 70) < 0.01, f"descuento (total) debería incluir el redondeo: {row}"
        assert abs(row["total"] - 18500) < 0.01, f"Total cobrado debería ser 18570-70=18500: {row}"
        assert abs(row["pago_efectivo"] - 18500) < 0.01, (
            f"venta_pagos efectivo debería ser 18500 (lo que queda en caja tras dar $1.500 de vuelto): {row}"
        )

        sesion = page.evaluate("""
          () => window.SGA_DB.query(`SELECT total_efectivo FROM sesiones_caja WHERE estado = 'abierta'`)[0]
        """)
        print(f"Sesión de caja: {sesion}")
        assert abs(sesion["total_efectivo"] - 18500) < 0.01, (
            f"El arqueo esperado tiene que coincidir con lo que realmente queda en caja (18.500): {sesion}"
        )

        assert_stock_integro(page, 'al final de test_pos_redondeo_vuelto.py')
        assert not errors, f"Errores JS en pantalla: {errors}"

        print("\nOK - test_pos_redondeo_vuelto: el redondeo de vuelto se aplica, persiste y cuadra con la caja.")
        browser.close()


if __name__ == "__main__":
    main()
