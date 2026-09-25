"""
tests/e2e/test_aprobaciones_pendientes.py — Circuito completo de "Ajuste de
stock" pendiente de aprobación, pedido desde Compras — Revisión, más la
pantalla nueva "Aprobaciones Pendientes" (Admin-POS) que lo aprueba/rechaza.

Pedido por el usuario (2026-09-17): poder marcar, desde Compras-Revisión,
que un producto tuvo rotura / se consumió / no lo entregó el proveedor —
sin que el stock se descuente al toque: queda pendiente hasta que el admin
lo revisa y aprueba (o rechaza) desde un panel nuevo. Investigando se
encontró que ese circuito de aprobación YA existía a medias: las
devoluciones del POS por producto vencido/defectuoso (pos.js) insertan un
stock_ajustes con estado='pendiente_aprobacion' desde hace tiempo, pero
nunca hubo pantalla para verlas — la pantalla nueva unifica los dos
orígenes.

Cubre:
  1. Pedir un ajuste desde "⋯" en Revisión NO descuenta el stock todavía.
  2. Confirmar la compra tampoco lo descuenta — el ajuste queda en
     stock_ajustes con estado='pendiente_aprobacion', compra_id y
     costo_unitario de esa línea.
  3. "Aprobaciones Pendientes" lista ese ajuste con el contexto de la
     compra, más uno sembrado directo por SQL simulando una devolución del
     POS (sin compra_id) — confirma que unifica ambos orígenes.
  4. Aprobar el de Compras descuenta el stock, crea el consumo_interno, y
     marca estado='aprobado'.
  5. Rechazar el de POS no toca el stock, marca estado='rechazado'.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_aprobaciones_pendientes.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, assert_stock_integro

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1800, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place (sga-admin.db) ---")
        login_via_seed(page, admin_pos=True)

        print("--- Stock inicial del producto a comprar (Coca-Cola 2L) ---")
        stock_antes = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT COALESCE(s.cantidad,0) AS c FROM productos p
             LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = '1'
             WHERE p.nombre = 'Coca-Cola 2L'`
          )[0]?.c
        """)
        print(f"Stock antes: {stock_antes}")

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Nueva compra: Tradicional -> Pepsico SA -> Factura A ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Factura A")
        page.wait_for_timeout(200)
        page.fill("#cv2-subtotal-neto", "200")
        page.locator("#cv2-subtotal-neto").blur()
        page.fill("#cv2-iva-21", "42")
        page.locator("#cv2-iva-21").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        print("--- Agregar Coca-Cola 2L x10 a $50 ---")
        page.locator("#cv2-search").click()
        page.keyboard.type("Coca-Cola 2L", delay=20)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Coca-Cola 2L").click()
        page.wait_for_timeout(400)

        row = "tr[data-idx='0']"
        page.fill(f"{row} input[data-field='cantidad']", "10")
        page.fill(f"{row} input[data-field='costoNuevo']", "50")
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(300)

        print("--- Siguiente -> Revision -> pedir ajuste de stock ---")
        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)

        page.locator('[data-rev-menu="desinc"]').click()
        page.wait_for_timeout(200)
        page.locator('[data-rev-accion="ajuste"]', has_text="Producto no entregado").click()
        page.wait_for_timeout(300)
        assert page.locator("#cv2-ajuste-overlay").is_visible(), "No se abrio el overlay de Ajuste de stock"

        page.fill("#cv2-ajuste-cantidad", "3")
        # El menu "Desincorporar" ya abre el modal con el motivo elegido.
        assert page.locator("#cv2-ajuste-motivo").input_value() == "Producto no entregado", (
            "El modal no abrio con el motivo preseleccionado desde el menu Desincorporar")
        page.locator("#cv2-ajuste-btn-confirm").click()
        page.wait_for_timeout(300)
        assert not page.locator("#cv2-ajuste-overlay").is_visible(), "El overlay de ajuste no se cerro al confirmar"

        chip = page.locator("[data-rev-badge-idx]")
        assert chip.count() == 1, "No aparecio el chip de ajuste pendiente en la fila"
        assert "3" in chip.inner_text(), f"El chip no muestra la cantidad encolada: {chip.inner_text()!r}"

        print("--- El stock NO debe haber cambiado todavia (ni encolar, ni confirmar la compra) ---")
        page.locator("#cv2-rev-btn-confirmar").click()
        page.wait_for_timeout(700)

        stock_tras_confirmar = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT COALESCE(s.cantidad,0) AS c FROM productos p
             LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = '1'
             WHERE p.nombre = 'Coca-Cola 2L'`
          )[0]?.c
        """)
        print(f"Stock tras confirmar la compra (10 ingresados, 3 en ajuste pendiente): {stock_tras_confirmar}")
        assert stock_tras_confirmar == (stock_antes or 0) + 10, (
            f"El stock deberia reflejar los 10 ingresados por la compra, sin descontar el ajuste pendiente "
            f"todavia: antes={stock_antes}, ahora={stock_tras_confirmar}"
        )

        ajuste_compras = page.evaluate("""
          () => window.SGA_DB.query(`
            SELECT sa.*, p.nombre FROM stock_ajustes sa
            JOIN productos p ON p.id = sa.producto_id
            WHERE p.nombre = 'Coca-Cola 2L' AND sa.estado = 'pendiente_aprobacion'
          `)[0]
        """)
        print(f"Ajuste pendiente creado por Compras: {ajuste_compras}")
        assert ajuste_compras is not None, "No se creo el stock_ajustes pendiente al confirmar la compra"
        assert ajuste_compras["compra_id"], "El ajuste deberia tener compra_id (vino de Compras-Revision)"
        assert float(ajuste_compras["costo_unitario"]) == 50.0, (
            f"costo_unitario deberia ser el costo de esa linea (50): {ajuste_compras['costo_unitario']!r}"
        )
        assert ajuste_compras["cantidad"] == 3, f"Cantidad inesperada: {ajuste_compras['cantidad']!r}"

        print("--- Sembrar un pendiente 'tipo POS' (sin compra_id), como una devolucion real ---")
        pos_ajuste_id = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const prod = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre = 'Coca-Cola 2L'`)[0];
            const id = 'ajuste-pos-test';
            window.SGA_DB.run(
              `INSERT INTO stock_ajustes
                 (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado, sync_status, updated_at)
               VALUES (?, ?, '1', 'ajuste_negativo', 1, 'devolucion_defectuoso', ?, ?, 'pendiente_aprobacion', 'pending', ?)`,
              [id, prod.id, window.SGA_Auth.getCurrentUser().id, now, now]
            );
            return id;
          }
        """)

        print("--- Ir a Aprobaciones Pendientes ---")
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        filas = page.locator("#aprob-tbody tr")
        assert filas.count() == 2, f"Esperaba 2 pendientes (Compras + POS), hay {filas.count()}"

        texto_tabla = page.locator("#aprob-table").inner_text()
        assert "Producto no entregado" in texto_tabla, "No aparece el motivo del ajuste de Compras"
        assert "Devolución" in texto_tabla, "No aparece el motivo del ajuste tipo POS"
        assert "Pepsico SA" in texto_tabla, "El origen no muestra el proveedor de la compra"
        assert "Devolución (POS)" in texto_tabla, "El origen del ajuste sin compra_id no se etiqueta como POS"

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "aprobaciones_pendientes_lista.png"), full_page=True)

        print("--- Aprobar el ajuste que vino de Compras ---")
        fila_compras = page.locator(f'tr[data-id="{ajuste_compras["id"]}"]')
        fila_compras.locator("[data-aprobar]").click()
        page.wait_for_timeout(400)

        stock_tras_aprobar = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT COALESCE(s.cantidad,0) AS c FROM productos p
             LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = '1'
             WHERE p.nombre = 'Coca-Cola 2L'`
          )[0]?.c
        """)
        print(f"Stock tras aprobar (deberia bajar 3): {stock_tras_aprobar}")
        assert stock_tras_aprobar == stock_tras_confirmar - 3, (
            f"El stock deberia haber bajado 3 al aprobar: antes={stock_tras_confirmar}, ahora={stock_tras_aprobar}"
        )

        estado_aprobado = page.evaluate("""
          () => window.SGA_DB.query(`SELECT estado, aprobado_por FROM stock_ajustes WHERE id = ?`, [%r])[0]
        """ % ajuste_compras["id"])
        assert estado_aprobado["estado"] == "aprobado", f"Estado inesperado tras aprobar: {estado_aprobado}"
        assert estado_aprobado["aprobado_por"], "aprobado_por deberia quedar seteado"

        consumo = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT * FROM consumo_interno WHERE motivo LIKE '%no entregado%' OR observaciones LIKE '%Aprobaciones Pendientes%'`
          )
        """)
        assert len(consumo) >= 1, "No se creo el registro de consumo_interno al aprobar"
        assert consumo[0]["costo_unitario"] == 50, f"costo_unitario del consumo_interno inesperado: {consumo[0]}"

        print("--- Rechazar el ajuste tipo POS: el stock NO debe cambiar ---")
        stock_pre_rechazo = stock_tras_aprobar
        page.locator(f'tr[data-id="{pos_ajuste_id}"] [data-rechazar]').click()
        page.wait_for_timeout(400)

        stock_post_rechazo = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT COALESCE(s.cantidad,0) AS c FROM productos p
             LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = '1'
             WHERE p.nombre = 'Coca-Cola 2L'`
          )[0]?.c
        """)
        assert stock_post_rechazo == stock_pre_rechazo, (
            f"Rechazar no deberia tocar el stock: antes={stock_pre_rechazo}, despues={stock_post_rechazo}"
        )
        estado_rechazado = page.evaluate(
            "() => window.SGA_DB.query(`SELECT estado FROM stock_ajustes WHERE id = ?`, [%r])[0]?.estado" % pos_ajuste_id
        )
        assert estado_rechazado == "rechazado", f"Estado inesperado tras rechazar: {estado_rechazado!r}"

        print("--- La lista queda vacia ---")
        page.wait_for_timeout(200)
        assert page.locator("#aprob-empty").is_visible(), "Deberia mostrar el estado vacio tras resolver los 2 pendientes"

        assert_stock_integro(page, 'al final de test_aprobaciones_pendientes.py')
        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Circuito de ajuste pendiente + Aprobaciones Pendientes funciona para Compras y para POS/devoluciones.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
