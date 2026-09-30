"""
tests/e2e/test_operaciones_stock_markup_fijo.py — "Historial de Compras → Ver"
(Operaciones de Stock, Admin-POS) ahora avisa si el producto tiene un markup
predeterminado (productos.markup_fijo, ver test_compras_v2_markup_fijo.py) y,
al corregir el precio a mano desde acá, pregunta lo mismo que la pantalla de
éxito post-compra: ¿esto actualiza el markup predeterminado o es una
excepción puntual de esta factura?

Pedido del usuario (30/9/2026): "en historial de compras, ver, es importante
que yo sepa si el producto tiene un marckup determinado o no y en caso de
cambiarlo que me pregunte lo msimo. si deseo cambiar el marckup o es una
exepcion." — antes de este fix, esta pantalla dejaba editar el precio de un
producto con markup fijo sin avisar nada (se comportaba como "solo esta vez"
implícito, sin que el dueño supiera que ese producto tenía un markup
configurado).

Cubre:
  1. La fila de un producto con markup_fijo muestra el badge "Markup X%"
     junto al precio, y el input lleva el dato (data-markup) para poder
     comparar contra el costo de ESA línea de compra (no el costo actual
     del producto, que puede haber cambiado desde entonces).
  2. Guardar un precio que SÍ coincide con lo que el markup calcularía no
     dispara ningún confirm() — no hay nada que preguntar.
  3. Guardar un precio que NO coincide dispara un confirm(); "Aceptar"
     recalcula productos.markup_fijo a partir del precio tipeado y el badge
     se actualiza en vivo, sin recargar la pantalla.
  4. "Cancelar" (solo esta vez) guarda el precio puntual sin tocar
     productos.markup_fijo.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_markup_fijo.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        dialogs = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login Admin-POS + seed ---")
        login_via_seed(page, admin_pos=True, wait_target="productos")

        print("--- Preparar datos: 2 productos con markup fijo (sin familia) + 1 compra confirmada ---")
        setup = page.evaluate("""
          () => {
            const db = window.SGA_DB;
            const uuid = window.SGA_Utils.generateUUID;
            const now = new Date().toISOString();
            const suc = window.SGA_Auth.getCurrentUser().sucursal_id;
            const usr = window.SGA_Auth.getCurrentUser().id;
            const prov = db.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;

            // D: markup 30%. E: markup 20%. Ninguno tiene familia.
            const prodD = uuid(); const prodE = uuid();
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, markup_fijo, activo, sync_status, updated_at)
                    VALUES (?, 'Producto Historial Markup D', 100, 130, 30, 1, 'synced', ?)`, [prodD, now]);
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, markup_fijo, activo, sync_status, updated_at)
                    VALUES (?, 'Producto Historial Markup E', 50, 60, 20, 1, 'synced', ?)`, [prodE, now]);

            const compraId = uuid();
            db.run(`INSERT INTO compras (id, proveedor_id, sucursal_id, usuario_id, fecha, estado, total, total_factura, sync_status, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'confirmada', 500, 500, 'synced', ?)`,
                   [compraId, prov, suc, usr, now, now]);
            // Costo de ESTA línea de compra: 200 para D (distinto del costo
            // actual del producto, 100) -- el markup se compara contra el
            // costo de la línea, no contra productos.costo.
            db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, descuento_pct, subtotal)
                    VALUES (?, ?, ?, 2, 200, 0, 400)`, [uuid(), compraId, prodD]);
            db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, descuento_pct, subtotal)
                    VALUES (?, ?, ?, 2, 50, 0, 100)`, [uuid(), compraId, prodE]);

            return { compraId, prodD, prodE };
          }
        """)

        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.evaluate("() => document.querySelector('[data-action=\"historial_compras\"]')?.click()")
        page.wait_for_timeout(300)
        page.evaluate(
            "(id) => document.querySelector(`[data-ver-compra=\"${id}\"]`)?.click()",
            setup["compraId"],
        )
        page.wait_for_timeout(300)

        print("--- El badge 'Markup 30%' esta visible junto al precio de D ---")
        input_d = page.locator('.ops-precio-input[data-prodid="%s"]' % setup["prodD"])
        assert input_d.get_attribute("data-markup") == "30", (
            f"data-markup debería venir con el markup del producto: {input_d.get_attribute('data-markup')!r}"
        )
        fila_d = input_d.locator("xpath=..")
        badge_d = fila_d.locator("span", has_text="Markup")
        assert badge_d.count() == 1 and "30%" in badge_d.inner_text(), (
            f"No se ve el badge 'Markup 30%' junto al precio de D: {fila_d.inner_text()!r}"
        )
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ops_historial_markup_badge.png"), full_page=True)
        print("   OK - badge visible con el % correcto")

        print("--- Guardar un precio que SI coincide con el markup (200 x 1.30 = 260): sin confirm() ---")
        def accept_and_log(d):
            dialogs.append(d.message)
            d.accept()
        page.on("dialog", accept_and_log)
        input_d.click()
        input_d.fill("260")
        input_d.press("Enter")
        page.wait_for_timeout(300)
        assert not dialogs, f"BUG: no debería haber preguntado nada, el precio coincide con el markup: {dialogs}"
        row_d0 = q(page, "SELECT precio_venta, markup_fijo FROM productos WHERE id=?", [setup["prodD"]])[0]
        assert abs(row_d0["precio_venta"] - 260) < 0.01 and float(row_d0["markup_fijo"]) == 30.0
        print("   OK - guardado directo, sin preguntar nada")

        print("--- Guardar un precio que NO coincide (300) y responder 'Aceptar': actualiza el markup ---")
        input_d.click()
        input_d.fill("300")
        input_d.press("Enter")
        page.wait_for_timeout(300)
        assert len(dialogs) == 1 and "markup predeterminado" in dialogs[0], (
            f"Debería haber preguntado por el markup predeterminado: {dialogs}"
        )
        row_d1 = q(page, "SELECT precio_venta, markup_fijo FROM productos WHERE id=?", [setup["prodD"]])[0]
        assert abs(row_d1["precio_venta"] - 300) < 0.01, f"El precio no se guardó: {row_d1}"
        # 300 / 200 - 1 = 0.5 -> 50%
        assert abs(float(row_d1["markup_fijo"]) - 50.0) < 0.01, (
            f"BUG: el markup predeterminado debería haberse actualizado a 50% (300/200): {row_d1}"
        )
        assert input_d.get_attribute("data-markup") == "50", (
            f"El data-markup debería haberse actualizado en vivo: {input_d.get_attribute('data-markup')!r}"
        )
        assert "50%" in badge_d.inner_text(), f"El badge debería mostrar el nuevo markup sin recargar: {badge_d.inner_text()!r}"
        print(f"   OK - 'Aceptar' actualiza markup_fijo y el badge en vivo: {row_d1}")

        print("--- Producto E: precio que NO coincide y responder 'Cancelar' (solo esta vez) ---")
        dialogs.clear()
        page.remove_listener("dialog", accept_and_log)
        def dismiss_and_log(d):
            dialogs.append(d.message)
            d.dismiss()
        page.once("dialog", dismiss_and_log)
        input_e = page.locator('.ops-precio-input[data-prodid="%s"]' % setup["prodE"])
        input_e.click()
        input_e.fill("999")
        input_e.press("Enter")
        page.wait_for_timeout(300)
        assert len(dialogs) == 1, f"Debería haber preguntado por el markup de E también: {dialogs}"
        row_e = q(page, "SELECT precio_venta, markup_fijo FROM productos WHERE id=?", [setup["prodE"]])[0]
        assert abs(row_e["precio_venta"] - 999) < 0.01, f"El precio puntual no se guardó: {row_e}"
        assert float(row_e["markup_fijo"]) == 20.0, (
            f"BUG: 'Cancelar' (solo esta vez) no debería tocar el markup predeterminado: {row_e}"
        )
        print(f"   OK - 'Cancelar' deja el precio puntual sin tocar el markup predeterminado: {row_e}")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_operaciones_stock_markup_fijo: PASA")


if __name__ == "__main__":
    main()
