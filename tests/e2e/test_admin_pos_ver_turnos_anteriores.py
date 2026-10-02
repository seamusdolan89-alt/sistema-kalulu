"""
tests/e2e/test_admin_pos_ver_turnos_anteriores.py — Admin-POS: ver turnos de
caja pasados (ventas de ayer, a quién, cómo pagó) desde Punto de Venta, en
solo lectura.

Pedido del dueño (2/10/2026): poder revisar en detalle qué se vendió ayer,
a quién y con qué medio, no solo los movimientos de efectivo de Cajas.
`pos.js` agrega, solo con window.ADMIN_MODE, un selector de turnos
(`#sesion-vista-select`) en "Ventas del turno".

Correr (server ya levantado en :8765):

    python tests/e2e/test_admin_pos_ver_turnos_anteriores.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """
() => {
  const ayer = new Date(Date.now() - 86400000);
  const f = h => { const d = new Date(ayer); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const now = new Date().toISOString();
  const suc = window.SGA_DB.query(`SELECT id FROM sucursales LIMIT 1`)[0].id;
  const usr = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
  const prod = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre='Coca-Cola 2L'`)[0];
  window.SGA_DB.run(
    `INSERT INTO sesiones_caja (id, sucursal_id, usuario_apertura_id, fecha_apertura, fecha_cierre, saldo_inicial, estado, sync_status, updated_at)
     VALUES ('ses-ayer', ?, ?, ?, ?, 0, 'cerrada', 'pending', ?)`, [suc, usr, f(9), f(20), now]);
  window.SGA_DB.run(
    `INSERT INTO clientes (id, nombre, apellido, activo, sync_status, updated_at)
     VALUES ('cli-ayer', 'Clienta', 'DeAyer', 1, 'pending', ?)`, [now]);
  window.SGA_DB.run(
    `INSERT INTO ventas (id, sucursal_id, sesion_caja_id, cliente_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
     VALUES ('venta-ayer', ?, 'ses-ayer', 'cli-ayer', ?, ?, 4000, 0, 4000, 'completada', 'pending', ?)`, [suc, usr, f(11), now]);
  window.SGA_DB.run(
    `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
     VALUES ('vi-ayer', 'venta-ayer', ?, 2, 2000, 0, 4000)`, [prod.id]);
  window.SGA_DB.run(
    `INSERT INTO venta_pagos (id, venta_id, medio, monto) VALUES ('vp-ayer', 'venta-ayer', 'efectivo', 4000)`);
  // Deuda vieja saldada dentro de ese mismo ticket ($1.000) + un cobro suelto de deuda ($700, transferencia)
  const ing = (id, monto, medio, ventaId) => window.SGA_DB.run(
    `INSERT INTO ingresos_caja (id, sesion_caja_id, monto, descripcion, fecha, usuario_id, medio, tipo, cliente_id, venta_id, sync_status, updated_at)
     VALUES (?, 'ses-ayer', ?, 'Cobranza', ?, ?, ?, 'cobro_cliente', 'cli-ayer', ?, 'pending', ?)`,
    [id, monto, f(15), usr, medio, ventaId, now]);
  ing('ing-ayer-1', 1000, null, 'venta-ayer');
  ing('ing-ayer-2', 700, 'transferencia', null);
  // Un turno anterior más viejo, con otra venta, para probar el cambio con el desplegable
  const antes = new Date(Date.now() - 3 * 86400000);
  const g = h => { const d = new Date(antes); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  window.SGA_DB.run(
    `INSERT INTO sesiones_caja (id, sucursal_id, usuario_apertura_id, fecha_apertura, fecha_cierre, saldo_inicial, estado, sync_status, updated_at)
     VALUES ('ses-antes', ?, ?, ?, ?, 0, 'cerrada', 'pending', ?)`, [suc, usr, g(9), g(20), now]);
  window.SGA_DB.run(
    `INSERT INTO ventas (id, sucursal_id, sesion_caja_id, cliente_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
     VALUES ('venta-antes', ?, 'ses-antes', NULL, ?, ?, 1500, 0, 1500, 'completada', 'pending', ?)`, [suc, usr, g(12), now]);
}
"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(300)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_timeout(800)

        sel = page.locator("#sesion-vista-select")
        assert sel.is_visible(), "El selector de turnos no aparece en Admin-POS"
        # Sin caja abierta en Admin-POS, se ve directamente el último turno
        fila = page.locator("#ventas-tbody tr[data-venta-id='venta-ayer']")
        assert fila.count() == 1, "No se muestra la venta de ayer (último turno)"
        assert "Clienta DeAyer" in fila.inner_text()
        assert "$" in page.locator("#sum-total").inner_text() and "4.000" in page.locator("#sum-total").inner_text()

        # Total turno = solo ventas (4.000), sin la deuda cobrada (1.000 + 700)
        total = page.locator("#sum-total").inner_text()
        assert "4.000" in total and "5.700" not in total and "4.700" not in total, total
        assert "saldó deuda anterior" in fila.inner_text(), "Falta la nota de deuda saldada en la venta"
        resumen = page.locator("#pos-summary-medios").inner_text()
        assert "1.700" in resumen and "aparte" in resumen.lower(), f"Falta 'Deuda cobrada (aparte)': {resumen!r}"
        assert page.locator("#ventas-tbody tr", has_text="Cobro de deuda").count() == 1, "Falta la fila del cobro suelto"
        assert page.locator("#ventas-count-badge").inner_text() == "1", "El cobro de deuda no debe contar como venta"

        fila.click()
        page.wait_for_timeout(300)
        panel = page.locator("#pos-detail-panel").inner_text()
        assert "Coca-Cola 2L" in panel and "Clienta DeAyer" in panel and "4.000" in panel, panel
        assert "Deuda anterior saldada" in panel and "1.000" in panel, panel
        assert page.locator("#dp-btn-anular").is_disabled(), "Anular debe estar deshabilitado en Admin-POS"
        assert page.locator("#dp-btn-editar").is_disabled(), "Editar debe estar deshabilitado en Admin-POS"

        # Cambiar de turno con el desplegable
        page.locator("#btn-close-detail").click()
        sel.select_option("ses-antes")
        page.wait_for_timeout(400)
        assert page.locator("#ventas-tbody tr[data-venta-id='venta-antes']").count() == 1, "No cambió al turno elegido"
        assert page.locator("#ventas-tbody tr[data-venta-id='venta-ayer']").count() == 0
        assert "1.500" in page.locator("#sum-total").inner_text()
        assert "aparte" not in page.locator("#pos-summary-medios").inner_text().lower()

        assert not errors, f"Errores JS: {errors}"
        print("OK - Admin-POS muestra turnos anteriores en solo lectura.")
        browser.close()


def main_pos_no_lo_muestra():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_timeout(800)
        assert not page.locator("#sesion-vista-select").is_visible(), "El POS del local no debe mostrar el selector"
        print("OK - el POS del local no muestra el selector.")
        browser.close()


if __name__ == "__main__":
    main()
    main_pos_no_lo_muestra()
