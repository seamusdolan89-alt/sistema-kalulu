"""
tests/e2e/test_clientes_eliminar_cobro.py — Cuenta Corriente de Clientes:
un cobro mal cargado (monto equivocado) se puede eliminar desde ADMIN POS
-- corrige a la vez el saldo del cliente y la caja que lo habia recibido
de mas, sin dejar la plata mal contada en el arqueo.

Reportado por el usuario: anoto mal el monto que le cobro a un cliente,
le quedo un saldo a favor que no corresponde y ademas sumo efectivo a la
caja que no entro realmente. No existia ninguna forma de corregir un
cobro ya cargado -- solo se podia crear, nunca deshacer.

Cubre:
- El boton eliminar (🗑️) en la fila del cobro solo aparece en ADMIN POS.
- Eliminarlo borra el movimiento de cuenta_corriente Y su espejo en
  ingresos_caja (que no tenian FK directa entre si -- se linkean por
  cliente_id + fecha + monto, mismo timestamp exacto que sella
  registrarPago en las dos filas).
- Las dos bajas quedan marcadas en `eliminaciones` para viajar por sync
  (si no, el otro dispositivo podia resucitar el cobro borrado en el
  proximo pull).
- SGA_Clientes.eliminarPago rechaza una fila que no sea tipo 'pago' (ej.
  una venta_fiada, que se corrige anulando la venta, no borrando la
  cuenta corriente sola).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_clientes_eliminar_cobro.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

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

        print("--- Cliente con un cobro mal cargado ($5000 en vez del monto real) ---")
        setup = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            window.SGA_DB.run(
              `INSERT INTO clientes (id, nombre, apellido, telefono, activo, sync_status, updated_at)
               VALUES ('cliente-cobro-1', 'Rosa', 'Diaz', '1133445566', 1, 'pending', ?)`,
              [now]
            );
            window.SGA_DB.run(
              `INSERT INTO sesiones_caja (id, sucursal_id, usuario_apertura_id, fecha_apertura, saldo_inicial, estado, sync_status, updated_at)
               VALUES ('sesion-cobro-1', '1', (SELECT id FROM usuarios LIMIT 1), ?, 0, 'abierta', 'pending', ?)`,
              [now, now]
            );
            // Deuda original de $1000, cobro mal cargado de $5000 -- queda
            // con $4000 de saldo a favor que no corresponde.
            window.SGA_DB.run(
              `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, descripcion, fecha, sync_status, updated_at)
               VALUES ('cc-deuda-1', 'cliente-cobro-1', '1', 'venta_fiada', 1000, 'Venta de prueba', ?, 'pending', ?)`,
              [now, now]
            );
            // registrarPago sella cuenta_corriente e ingresos_caja con el
            // MISMO timestamp exacto -- asi se linkean sin FK.
            const fechaCobro = new Date(Date.now() + 1000).toISOString();
            window.SGA_DB.run(
              `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, descripcion, fecha, medio_pago, sesion_caja_id, sync_status, updated_at)
               VALUES ('cc-cobro-malo', 'cliente-cobro-1', '1', 'pago', -5000, 'Pago', ?, 'efectivo', 'sesion-cobro-1', 'pending', ?)`,
              [fechaCobro, fechaCobro]
            );
            window.SGA_DB.run(
              `INSERT INTO ingresos_caja (id, sesion_caja_id, monto, descripcion, fecha, medio, tipo, cliente_id, sync_status, updated_at)
               VALUES ('ing-cobro-malo', 'sesion-cobro-1', 5000, 'Cobro cta. cte. — Rosa Diaz', ?, 'efectivo', 'cobro_cliente', 'cliente-cobro-1', 'pending', ?)`,
              [fechaCobro, fechaCobro]
            );
            return { clienteId: 'cliente-cobro-1' };
          }
        """)

        page.evaluate("window.location.hash = 'clientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        print("--- Abrir ficha -> Cuenta Corriente: saldo a favor incorrecto de $4000 ---")
        page.locator("tr", has_text="Rosa Diaz").locator("text=👁️").click()
        page.wait_for_timeout(400)
        page.locator(".ficha-nav-item[data-section='cc']").click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "clientes_eliminar_cobro_antes.png"), full_page=True)

        saldo_antes = page.locator("#app").inner_text()
        assert "4.000" in saldo_antes or "4000" in saldo_antes, (
            f"No se ve el saldo a favor incorrecto antes de corregir: {saldo_antes[:400]!r}"
        )

        print("--- El boton eliminar (admin-pos) esta visible en la fila del cobro ---")
        btn = page.locator('[data-eliminar-mov="cc-cobro-malo"]')
        assert btn.count() == 1, "Deberia haber un boton para eliminar el cobro en ADMIN POS"

        print("--- Eliminar el cobro mal cargado ---")
        btn.click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "clientes_eliminar_cobro_despues.png"), full_page=True)

        saldo_despues = page.locator("#app").inner_text()
        assert "1.000" in saldo_despues or "1000" in saldo_despues, (
            f"El saldo deberia volver a la deuda original de $1000: {saldo_despues[:400]!r}"
        )
        assert "4.000" not in saldo_despues, (
            f"El saldo a favor incorrecto no deberia seguir ahi: {saldo_despues[:400]!r}"
        )

        print("--- Verificar en la base: se borraron las dos filas y quedaron marcadas para sync ---")
        check = page.evaluate("""
          () => ({
            cc: window.SGA_DB.query(`SELECT * FROM cuenta_corriente WHERE id = 'cc-cobro-malo'`),
            ingreso: window.SGA_DB.query(`SELECT * FROM ingresos_caja WHERE id = 'ing-cobro-malo'`),
            elimCC: window.SGA_DB.query(`SELECT * FROM eliminaciones WHERE tabla='cuenta_corriente' AND registro_id='cc-cobro-malo'`),
            elimIngreso: window.SGA_DB.query(`SELECT * FROM eliminaciones WHERE tabla='ingresos_caja' AND registro_id='ing-cobro-malo'`),
          })
        """)
        print(f"Chequeo DB: {check}")
        assert len(check["cc"]) == 0, "El movimiento de cuenta_corriente deberia haberse borrado"
        assert len(check["ingreso"]) == 0, (
            "BUG: el espejo en ingresos_caja no se borro -- la caja seguiria mostrando efectivo que no entro"
        )
        assert len(check["elimCC"]) == 1, "Falta la marca de eliminacion de cuenta_corriente (no viajaria por sync)"
        assert len(check["elimIngreso"]) == 1, "Falta la marca de eliminacion de ingresos_caja (no viajaria por sync)"

        print("--- Guarda: no se puede eliminar una venta_fiada desde aca ---")
        rechazo = page.evaluate("""
          () => {
            try {
              window.SGA_Clientes.eliminarPago('cc-deuda-1');
              return 'NO_ERROR';
            } catch (e) {
              return e.message;
            }
          }
        """)
        print(f"Intento sobre venta_fiada: {rechazo!r}")
        assert rechazo != 'NO_ERROR', "eliminarPago no deberia aceptar una fila que no sea tipo 'pago'"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Eliminar un cobro mal cargado corrige el saldo del cliente y la caja, y queda marcado para sync.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
