"""
tests/e2e/test_compras_editar_remito.py — "✏️ Editar" en Remitos Pendientes
de Factura (Compras, solo Admin-POS).

Antes no habia forma de corregir un remito ya cargado (producto equivocado,
cantidad mal): el panel de remitos pendientes solo ofrecia "Vincular Factura",
y como el stock se suma al GUARDAR el remito (commitRemito) y no al vincular la
factura, corregir el carrito al vincular no arreglaba el stock.

Diseno que se prueba (igual que la edicion de compras confirmadas): el stock
se mueve por la DIFERENCIA neta por producto contra lo que el remito tenia
antes de abrir el editor -- no "revertir todo y recargar". Casos:
  - producto equivocado sacado del remito  -> devuelve su stock
  - producto correcto agregado             -> suma su stock
  - cantidad cambiada en una linea         -> ajusta solo la diferencia, y esa
    linea conserva su remito_items.id (el sync no la duplica)
  - sacar una linea cuyo stock ya se vendio -> avisa (confirm) antes de dejar
    stock negativo
  - el remito queda sync_status='pending' y Editar no aparece fuera de
    Admin-POS

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_editar_remito.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import assert_stock_integro, block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

SEED_JS = """
() => {
  const now = new Date().toISOString();
  const usuarioId  = window.SGA_Auth.getCurrentUser().id;
  const sucursalId = window.SGA_Auth.getCurrentUser().sucursal_id;

  window.SGA_DB.run(
    `INSERT INTO proveedores (id, razon_social, condicion_iva, condicion_compra, activo)
     VALUES ('prov-er', 'Proveedor Editar Remito', 'Responsable Inscripto', 'Factura B', 1)`
  );
  for (const [id, nombre, cod] of [
    ['prod-er-mal', 'Producto Equivocado ER', '7770000000001'],
    ['prod-er-ok',  'Producto Correcto ER',   '7770000000002'],
    ['prod-er-qty', 'Producto Cantidad ER',   '7770000000003'],
  ]) {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
         es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
       VALUES (?, ?, 50, 100, 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`,
      [id, nombre, now, now, now]
    );
    window.SGA_DB.run(
      `INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES (?, ?, ?, 1)`,
      ['bc-' + id, id, cod]
    );
  }

  // Stock DESPUES de haber cargado el remito original: mal=10 (+6 del remito),
  // ok=5 (no estaba en el remito), qty=20 (+3 del remito).
  // Por el punto unico de escritura (SGA_DB.moverStock), como el resto de la app: si no, el
  // registro de movimientos no cuadraria con la cache de stock.
  for (const [pid, cant] of [['prod-er-mal', 16], ['prod-er-ok', 5], ['prod-er-qty', 23]]) {
    window.SGA_DB.moverStock({ productoId: pid, sucursalId, delta: cant, tipo: 'saldo_inicial',
                               motivo: 'seed del test', usuarioId: null, fecha: now });
  }

  window.SGA_DB.run(
    `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
     VALUES ('remito-er', ?, 'prov-er', ?, '2026-09-18', 'R-ER-1', 'pendiente', 'synced', ?)`,
    [sucursalId, usuarioId, now]
  );
  window.SGA_DB.run(
    `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
     VALUES ('ri-er-mal', 'remito-er', 'prod-er-mal', 6, 'Unidad', 1)`
  );
  window.SGA_DB.run(
    `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
     VALUES ('ri-er-qty', 'remito-er', 'prod-er-qty', 3, 'Unidad', 1)`
  );
  return sucursalId;
}
"""


def stock_de(page, pid):
    return page.evaluate(
        "(pid) => window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id=?`, [pid])[0]?.cantidad",
        pid,
    )


def abrir_lista_remitos(page):
    page.locator("#cv2-btn-remitos-pendientes").click()
    page.wait_for_timeout(300)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        dialogos = []
        page.on("dialog", lambda d: (dialogos.append(d.message), d.accept()))

        print("--- Login admin-pos + remito pendiente con un producto equivocado ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEED_JS)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Remitos pendientes: aparece Editar junto a Vincular Factura ---")
        abrir_lista_remitos(page)
        editar_btn = page.locator("#cv2-remitos-list .cv2-btn-editar-remito[data-id='remito-er']")
        assert editar_btn.count() == 1, "No aparece el boton ✏️ Editar del remito en Admin-POS"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_editar_remito_lista.png"), full_page=True)

        print("--- Editar: cabecera precargada, cambiar nro de remito ---")
        editar_btn.click()
        page.wait_for_timeout(400)
        assert page.locator("#cv2-remito-numero").input_value() == "R-ER-1", "Nro de remito no vino precargado"
        banner = page.locator("#cv2-editando-banner").inner_text()
        assert "Editando remito" in banner, f"Falta el banner de edicion: {banner!r}"
        page.fill("#cv2-remito-numero", "R-ER-2")
        page.locator("#cv2-btn-continuar").click()
        page.wait_for_timeout(400)

        filas = page.locator("#cv2-cart-body tr").count()
        assert filas == 2, f"Se esperaban 2 lineas del remito en el carrito, hay {filas}"

        print("--- Sacar el producto equivocado, subir cantidad de la otra linea a 5, agregar el correcto x4 ---")
        page.locator("#cv2-cart-body tr", has_text="Producto Equivocado ER").locator(".cv2-remove-btn").click()
        page.wait_for_timeout(300)
        fila_qty = page.locator("#cv2-cart-body tr", has_text="Producto Cantidad ER")
        fila_qty.locator("input[data-field='cantidad']").fill("5")
        fila_qty.locator("input[data-field='cantidad']").blur()
        page.wait_for_timeout(300)

        page.locator("#cv2-search").click()
        page.keyboard.type("Correcto ER", delay=30)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item", has_text="Producto Correcto ER").click()
        page.wait_for_timeout(400)
        fila_ok = page.locator("#cv2-cart-body tr", has_text="Producto Correcto ER")
        fila_ok.locator("input[data-field='cantidad']").fill("4")
        fila_ok.locator("input[data-field='cantidad']").blur()
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_editar_remito_carrito.png"), full_page=True)

        boton = page.locator("#cv2-btn-confirmar")
        assert "Guardar Cambios" in boton.inner_text(), f"El boton deberia decir Guardar Cambios: {boton.inner_text()!r}"
        boton.click()
        page.wait_for_timeout(600)

        print("--- Verificar stock, lineas y remito ---")
        assert stock_de(page, "prod-er-mal") == 10, f"Equivocado: deberia volver a 10, es {stock_de(page, 'prod-er-mal')}"
        assert stock_de(page, "prod-er-ok") == 9, f"Correcto: deberia ser 5+4=9, es {stock_de(page, 'prod-er-ok')}"
        assert stock_de(page, "prod-er-qty") == 25, f"Cantidad: 23 + (5-3) = 25, es {stock_de(page, 'prod-er-qty')}"

        items = page.evaluate(
            "() => window.SGA_DB.query(`SELECT id, producto_id, cantidad FROM remito_items WHERE remito_id='remito-er' ORDER BY producto_id`)"
        )
        assert len(items) == 2, f"El remito deberia tener 2 lineas, tiene {len(items)}: {items}"
        por_prod = {r["producto_id"]: r for r in items}
        assert set(por_prod) == {"prod-er-ok", "prod-er-qty"}, f"Productos del remito inesperados: {list(por_prod)}"
        assert por_prod["prod-er-qty"]["id"] == "ri-er-qty", "La linea editada perdio su id (el sync la duplicaria)"
        assert por_prod["prod-er-qty"]["cantidad"] == 5 and por_prod["prod-er-ok"]["cantidad"] == 4

        remito = page.evaluate("() => window.SGA_DB.query(`SELECT numero_remito, estado, sync_status FROM remitos WHERE id='remito-er'`)[0]")
        assert remito["numero_remito"] == "R-ER-2", f"Nro de remito no se guardo: {remito}"
        assert remito["estado"] == "pendiente", f"El remito no deberia cambiar de estado: {remito}"
        assert remito["sync_status"] == "pending", f"BUG: el remito editado no quedo pending, no viajaria por sync: {remito}"
        assert not dialogos, f"No deberia haber pedido confirmacion (no hay stock negativo): {dialogos}"
        assert_stock_integro(page, 'despues de editar el remito (diferencia por producto)')

        print("--- Al guardar cae en Operaciones de Stock (no en la lista de remitos) ---")
        assert page.evaluate("() => window.location.hash").endswith("operaciones_stock"), \
            f"Deberia caer en Operaciones de Stock, esta en {page.evaluate('() => window.location.hash')!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "compras_editar_remito_despues.png"), full_page=True)

        print("--- Volver a Compras: pantalla limpia de 'Nueva compra', y el remito sigue en la lista con 2 productos ---")
        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        assert not page.locator("#cv2-editando-banner").is_visible(), "El banner de edicion quedo visible"
        # text_content y no inner_text: el CSS del titulo es text-transform: uppercase
        assert "Nueva Compra" in page.locator(".cv2-header-title").text_content(), "El titulo no volvio a 'Nueva Compra'"
        assert page.locator(".cv2-sinf-toggle-wrap").evaluate("e => e.style.display") == "", \
            "El toggle Sin factura quedo oculto despues de editar"
        abrir_lista_remitos(page)
        assert "2 productos" in page.locator("#cv2-remitos-list").inner_text(), "La lista no refleja los 2 productos"

        print("--- Sacar una linea cuyo stock ya se vendio: pide confirmacion antes de dejar stock negativo ---")
        page.evaluate(
            "() => window.SGA_DB.run(`UPDATE stock SET cantidad=1 WHERE producto_id='prod-er-qty'`)"
        )
        page.locator("#cv2-remitos-list .cv2-btn-editar-remito[data-id='remito-er']").click()
        page.wait_for_timeout(400)
        page.locator("#cv2-btn-continuar").click()
        page.wait_for_timeout(400)
        page.locator("#cv2-cart-body tr", has_text="Producto Cantidad ER").locator(".cv2-remove-btn").click()
        page.wait_for_timeout(300)
        page.locator("#cv2-btn-confirmar").click()
        page.wait_for_timeout(600)

        assert len(dialogos) == 1, f"Deberia haber pedido UNA confirmacion por stock negativo: {dialogos}"
        assert "Producto Cantidad ER" in dialogos[0] and "-4" in dialogos[0], f"Mensaje inesperado: {dialogos[0]!r}"
        assert stock_de(page, "prod-er-qty") == -4, f"1 - 5 = -4, es {stock_de(page, 'prod-er-qty')}"
        n = page.evaluate("() => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM remito_items WHERE remito_id='remito-er'`)[0].n")
        assert n == 1, f"Deberia quedar 1 linea, hay {n}"
        # el UPDATE manual de stock a 1 (simula que ya se vendio) rompe la invariante a proposito:
        # se comprueba que el editor mueve por diferencia y que los movimientos del remito son coherentes
        movs = page.evaluate("() => window.SGA_DB.query(`SELECT tipo, delta FROM stock_movimientos WHERE producto_id='prod-er-qty' ORDER BY rowid`)")
        tipos = [m['tipo'] for m in movs]
        assert tipos[-2:] == ['remito_edicion', 'remito_edicion'] or tipos[-1] == 'remito_edicion', f"movimientos de la edicion: {tipos}"

        print("--- POS del local (no admin): el remito aparece pero SIN boton Editar ---")
        pos = context.new_page()
        pos.on("pageerror", lambda exc: errors.append(str(exc)))
        pos.on("dialog", lambda d: d.accept())
        login_via_seed(pos, admin_pos=False)
        pos.evaluate(SEED_JS)
        pos.evaluate("window.location.hash = 'compras_v2'")
        pos.wait_for_load_state("networkidle")
        pos.wait_for_timeout(500)
        abrir_lista_remitos(pos)
        assert pos.locator("#cv2-remitos-list .cv2-btn-vincular[data-id='remito-er']").count() == 1, \
            "En el POS deberia seguir apareciendo el remito con Vincular Factura"
        assert pos.locator("#cv2-remitos-list .cv2-btn-editar-remito").count() == 0, \
            "El boton Editar no deberia aparecer fuera de Admin-POS"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("OK - Editar remito: el stock se mueve por la diferencia, conserva ids y avisa stock negativo.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
