"""
tests/e2e/test_clientes_detalle_venta.py — Detalle de venta desde la ficha
del cliente (Cuenta Corriente y Historial de Compras).

Pedido real del usuario (30/9/2026, con una captura): el link "#<id>" de
cada deuda en Cuenta Corriente ya tenía el `data-venta` y el estilo de link
puestos (`js/modules/clientes.js` línea ~666) pero sin ningún listener
enganchado — clickearlo no hacía nada, y el dueño no podía saber qué compró
el cliente para explicarle la deuda. Lo mismo pasaba con cada fila de
Historial de Compras (`.venta-row`, ya tenía `cursor:pointer` en el CSS pero
tampoco estaba wireada).

Fix: un modal "Detalle de venta" (`views/clientes.html`) + `abrirDetalleVenta()`
en `clientes.js`, enganchado desde los dos lugares.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_clientes_detalle_venta.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const prod = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre='Coca-Cola 2L'`)[0];
  window.SGA_DB.run(
    `INSERT INTO clientes (id, nombre, apellido, telefono, activo, sync_status, updated_at)
     VALUES ('cliente-dv-1', 'Belen', 'Bruno', '1155667788', 1, 'pending', ?)`,
    [now]
  );
  window.SGA_DB.run(
    `INSERT INTO ventas (id, sucursal_id, cliente_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
     VALUES ('venta-dv-1', '1', 'cliente-dv-1', (SELECT id FROM usuarios LIMIT 1), ?, 8000, 0, 8000, 'completada', 'pending', ?)`,
    [now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
     VALUES ('vi-dv-1', 'venta-dv-1', ?, 4, 2000, 0, 8000)`,
    [prod.id]
  );
  window.SGA_DB.run(
    `INSERT INTO venta_pagos (id, venta_id, medio, monto)
     VALUES ('vp-dv-1', 'venta-dv-1', 'cuenta_corriente', 8000)`
  );
  window.SGA_DB.run(
    `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, descripcion, venta_id, fecha, sync_status, updated_at)
     VALUES ('cc-dv-1', 'cliente-dv-1', '1', 'venta_fiada', 8000, 'Deuda por venta', 'venta-dv-1', ?, 'pending', ?)`,
    [now, now]
  );
  return { ventaCorta: 'venta-dv-1'.slice(-6) };
}
"""


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login POS + seed: cliente con una venta fiada real ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'clientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        info = page.evaluate(SEMBRAR)

        print("--- Abrir ficha -> Cuenta Corriente -> click en el link de la venta ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(200)
        page.evaluate("window.location.hash = 'clientes'")
        page.wait_for_timeout(400)
        page.locator("tr", has_text="Belen Bruno").get_by_text("👁️", exact=True).click()
        page.wait_for_timeout(400)
        page.locator(".ficha-nav-item[data-section='cc']").click()
        page.wait_for_timeout(400)

        link = page.locator(".mov-link", has_text=info["ventaCorta"])
        assert link.count() == 1, f"No se encontró el link de la venta ({info['ventaCorta']}) en Cuenta Corriente"
        link.click()
        page.wait_for_timeout(300)

        modal = page.locator("#modal-venta-detalle")
        assert modal.is_visible(), "El modal de detalle de venta no se abrió desde Cuenta Corriente"
        detalle = modal.inner_text()
        assert "Coca-Cola 2L" in detalle, f"El detalle no muestra el producto: {detalle!r}"
        assert "4" in detalle, f"El detalle no muestra la cantidad: {detalle!r}"
        assert "8.000,00" in detalle, f"El detalle no muestra el total: {detalle!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "clientes_detalle_venta_cc.png"))
        page.locator("#btn-vd-close").click()
        page.wait_for_timeout(200)
        assert not modal.is_visible(), "El modal no se cerró"

        print("--- Historial de Compras -> click en la fila de la venta ---")
        page.locator(".ficha-nav-item[data-section='compras']").click()
        page.wait_for_timeout(400)
        fila = page.locator(".venta-row")
        assert fila.count() == 1, f"Esperaba 1 venta en Historial de Compras: {fila.count()}"
        fila.click()
        page.wait_for_timeout(300)

        assert modal.is_visible(), "El modal de detalle de venta no se abrió desde Historial de Compras"
        detalle2 = modal.inner_text()
        assert "Coca-Cola 2L" in detalle2 and "8.000,00" in detalle2, (
            f"El detalle desde Historial de Compras no coincide: {detalle2!r}"
        )
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "clientes_detalle_venta_historial.png"))

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Detalle de venta accesible desde Cuenta Corriente e Historial de Compras.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
