"""
tests/e2e/test_pos_cobro_multiple_saldo_favor.py — En COBRO MÚLTIPLE, el saldo a favor que se
aplica a la venta se descuenta de la cuenta del cliente.

Bug encontrado al revisar el cobro múltiple: con un cliente que tiene crédito, el POS propone
usarlo (el total a cobrar baja) pero, en cobro múltiple, la venta nunca registraba ese crédito
como usado: el cliente pagaba menos y seguía teniendo el saldo a favor completo. En cobro simple
sí se descontaba.

Cubre: cliente con $30 a favor compra por $95 en cobro múltiple (efectivo $40 + MercadoPago $25 =
$65 a cobrar): la venta registra $30 de saldo a favor, la cuenta del cliente queda en $0 y la suma
de los pagos ($40 + $25 + $30) es el total de la venta.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_cobro_multiple_saldo_favor.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta, assert_stock_integro


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS + caja abierta + cliente con $30 a favor ---")
        login_via_seed(page)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        page.evaluate("""() => {
          const now = new Date().toISOString();
          window.SGA_DB.run(`INSERT INTO clientes (id, nombre, apellido, telefono, activo, tope_deuda, sync_status, updated_at)
                             VALUES ('cli-fav', 'Rosa', 'Diaz', '1', 1, 100000, 'pending', ?)`, [now]);
          window.SGA_DB.run(`INSERT INTO cuenta_corriente (id, cliente_id, tipo, monto, descripcion, fecha, sync_status, updated_at)
                             VALUES ('cc-fav', 'cli-fav', 'saldo_favor', -30, 'Saldo a favor previo', ?, 'pending', ?)`, [now, now]);
        }""")
        abrir_caja_si_hace_falta(page, saldo_inicial=1000)

        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_timeout(500)
        page.locator("#btn-nueva-venta").click()
        page.wait_for_timeout(400)
        page.locator("#pos-search-input").click()
        page.keyboard.type("Coca", delay=20)
        page.wait_for_timeout(400)
        page.locator("#pos-search-dropdown .sri").first.click()
        page.wait_for_timeout(400)
        page.locator("#client-search-input").click()
        page.keyboard.type("Rosa", delay=20)
        page.wait_for_timeout(400)
        page.locator("#client-dropdown .cri").first.click()
        page.wait_for_timeout(400)

        print("--- Cobro múltiple: efectivo $40 + MercadoPago $25 (= $95 - $30 de saldo a favor) ---")
        page.evaluate("""() => { const el = document.getElementById('cobro-multiple-toggle');
                                 el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }""")
        page.wait_for_timeout(300)
        page.locator(".mpay-field[data-medio='efectivo']").fill("40")
        page.locator(".mpay-field[data-medio='mercadopago']").fill("25")
        page.wait_for_timeout(300)
        page.locator("#btn-confirm-venta").click()
        page.wait_for_timeout(700)
        page.locator("#btn-ticket-confirmar").click()
        page.wait_for_timeout(600)

        venta = q(page, "SELECT id, total FROM ventas ORDER BY fecha DESC LIMIT 1")[0]
        pagos = q(page, "SELECT medio, monto FROM venta_pagos WHERE venta_id=? ORDER BY medio", [venta["id"]])
        print(f"Pagos de la venta: {pagos}")
        assert pagos == [{"medio": "efectivo", "monto": 40}, {"medio": "mercadopago", "monto": 25}, {"medio": "saldo_favor", "monto": 30}], (
            f"La venta debía registrar el saldo a favor usado ($30): {pagos}")
        assert sum(x["monto"] for x in pagos) == venta["total"], "Los pagos no suman el total de la venta"
        saldo = q(page, "SELECT ROUND(SUM(monto), 2) AS s FROM cuenta_corriente WHERE cliente_id='cli-fav'")[0]["s"]
        print(f"Saldo del cliente después de la venta: {saldo}")
        assert saldo == 0, (
            f"BUG: el saldo a favor se usó en la venta pero no se descontó de la cuenta del cliente (queda {saldo})")

        assert_stock_integro(page, "al final de test_pos_cobro_multiple_saldo_favor.py")
        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - en cobro múltiple el saldo a favor aplicado se descuenta de la cuenta del cliente.")
        browser.close()


if __name__ == "__main__":
    main()
