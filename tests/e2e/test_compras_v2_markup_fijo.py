"""
tests/e2e/test_compras_v2_markup_fijo.py — Markup predeterminado por producto:
al confirmar una compra que le cambia el costo a un producto con
`productos.markup_fijo` seteado, el precio de venta se recalcula SOLO
(costo × (1 + markup/100)), sin pasar por el paso de revisar/aceptar precio
sugerido — la fila aparece ya resuelta en la pantalla de éxito, a modo
informativo, con un botón "✎" para corregirla si hiciera falta.

Pedido real del usuario (30/9/2026): quiere que ciertos productos mantengan
siempre el mismo markup, sin tener que revisar precio por precio en cada
compra — pero si alguna vez el precio automático no le sirve, poder
corregirlo, y que el sistema pregunte si eso cambia el markup predeterminado
para siempre o es una excepción puntual de esa factura.

Cubre:
  1. Editor de Producto (Precios y Costos): Markup unificado con la vieja
     "calculadora de precio" (1/10/2026) — un solo campo #ed-markup (en %,
     ya no multiplicador) + el checkbox #ed-markup-fijo-check deciden si ese
     % se persiste en productos.markup_fijo ("predeterminado") o es solo
     para el precio de hoy; destildar borra markup_fijo sin tocar el precio.
  2. Confirmar una compra que le cambia el costo a un producto con markup
     fijo recalcula precio_venta solo (sin click) y la fila de la pantalla
     de éxito aparece con el badge "Markup fijo (30%)", ya resuelta.
  3. Corregir ese precio y responder "Sí, actualizar el markup predeterminado"
     (Aceptar en el confirm) reescribe productos.markup_fijo con el nuevo %.
  4. Corregir un precio en OTRO producto con markup fijo y responder
     "Solo esta vez" (Cancelar en el confirm): el precio cambia pero
     markup_fijo NO se toca — y la PRÓXIMA compra que le cambie el costo a
     ese producto vuelve a aplicar el markup predeterminado de siempre
     (pisando el precio puntual que se había puesto).
  5. Pedido del usuario (30/9/2026): si el producto con markup fijo tiene
     familia (madre/hijo con herencia), el recálculo automático abre SOLO
     el wizard de sincronización (sin que el dueño tenga que tocar nada) —
     y si la pantalla se vuelve a renderizar para los mismos items (acá:
     "Finalizar" -> Resumen Final -> "Volver"), el wizard NO se vuelve a
     abrir una segunda vez para ese mismo producto.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_markup_fijo.py
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
  const mk = (id, nombre, costo, precioVenta, markupFijo) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, markup_fijo, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
    [id, nombre, costo, precioVenta, markupFijo, now, now, now]
  );
  // A: para el escenario "actualizar el markup predeterminado".
  mk('prod-markup-a', 'Producto Markup A', 100, 130, 30);
  // B: para el escenario "solo esta vez".
  mk('prod-markup-b', 'Producto Markup B', 100, 130, 30);

  // C (madre, con markup fijo) + Hijo C (hereda costo y precio): escenario
  // "markup fijo + familia".
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, markup_fijo, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('prod-markup-c', 'Producto Markup C', 100, 130, 30, 1, 'unidad', 1, 0, 1, ?, ?, 'pending', ?)`,
    [now, now, now]
  );
  // Nombre sin el prefijo "Producto Markup C" a propósito -- si lo
  // compartiera, tipear "Producto Markup C" en el buscador matchearía
  // ambos (madre e hijo) por substring y el dropdown quedaría ambiguo.
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, producto_madre_id, hereda_costo, hereda_precio, precio_independiente, activo,
       fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('prod-markup-c-hijo', 'Hijo de Markup C', 100, 130, 1, 'unidad',
       0, 'prod-markup-c', 1, 1, 0, 1, ?, ?, 'pending', ?)`,
    [now, now, now]
  );
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def completar_compra_remito(page, nombre_producto, cantidad, costo):
    """Compra 'Remito' a Pepsico SA de un producto puntual, hasta la
    pantalla de éxito (showSuccessScreen) -- se detiene ahí, sin clickear
    'Siguiente', para poder inspeccionar/editar la fila de precio."""
    page.evaluate("window.location.hash = 'compras_v2'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(300)
    page.get_by_text("Tradicional", exact=True).click()
    page.wait_for_timeout(300)
    page.locator("#cv2-prov-search").click()
    page.keyboard.type("Pepsico", delay=20)
    page.wait_for_timeout(300)
    page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
    page.wait_for_timeout(300)
    page.select_option("#cv2-condicion-compra", label="Remito")
    page.wait_for_timeout(200)
    page.fill("#cv2-total-factura", str(cantidad * costo))
    page.locator("#cv2-total-factura").blur()
    page.wait_for_timeout(200)
    page.get_by_text("Continuar al Carrito", exact=False).click()
    page.wait_for_timeout(400)

    page.locator("#cv2-search").click()
    page.keyboard.type(nombre_producto, delay=20)
    page.wait_for_timeout(400)
    page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=nombre_producto).click()
    page.wait_for_timeout(400)

    row = "tr[data-idx='0']"
    page.fill(f"{row} input[data-field='cantidad']", str(cantidad))
    page.fill(f"{row} input[data-field='costoNuevo']", str(costo))
    page.locator(f"{row} input[data-field='costoNuevo']").blur()
    page.wait_for_timeout(300)

    page.get_by_text("Siguiente", exact=False).click()
    page.wait_for_timeout(500)
    page.get_by_text("Confirmar Ingreso", exact=False).click()
    page.wait_for_timeout(700)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1900, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed: 2 productos con markup_fijo=30% ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        print("--- Editor de Producto: Markup unificado (campo + checkbox 'predeterminado') ---")
        prod_a = q(page, "SELECT id FROM productos WHERE nombre='Producto Markup A'")[0]
        page.evaluate(f"window.location.hash = 'editor-producto/{prod_a['id']}'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)

        # Ya no hay un campo numérico separado "Markup predeterminado": el
        # campo Markup (compartido con la calculadora de precio) viene
        # precargado calculado desde costo/precio_venta -- que acá coincide
        # con el 30% sembrado porque el seed los dejó consistentes a propósito
        # (costo 100, precio_venta 130).
        assert page.locator("#ed-markup-fijo").count() == 0, "El campo viejo #ed-markup-fijo debería haber desaparecido"
        markup_input = page.locator("#ed-markup")
        assert markup_input.count() == 1, "No aparece el campo Markup en Precios y Costos"
        assert markup_input.input_value() == "30.00", f"El Markup debería venir calculado en 30.00% (costo 100, precio 130): {markup_input.input_value()!r}"
        chk = page.locator("#ed-markup-fijo-check")
        assert chk.is_checked(), "El checkbox 'predeterminado' debería venir tildado (el producto tiene markup_fijo=30 seedeado)"

        print("--- Cambiar el Markup actualiza el precio de venta EN VIVO (unificado con la calculadora vieja) ---")
        markup_input.click()
        markup_input.fill("35")
        page.wait_for_timeout(150)
        precio_en_vivo = page.locator("#ed-precio-venta").input_value()
        assert precio_en_vivo == "135.00", f"100 costo x 1.35 = 135, no se recalculó en vivo: {precio_en_vivo!r}"

        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(500)
        row = q(page, "SELECT markup_fijo, precio_venta, sync_status FROM productos WHERE id=?", [prod_a["id"]])[0]
        assert float(row["markup_fijo"]) == 35.0, f"El markup editado no persistió (checkbox seguía tildado): {row}"
        assert abs(float(row["precio_venta"]) - 135.0) < 0.01, f"El precio recalculado en vivo no persistió: {row}"
        assert row["sync_status"] == "pending", f"El UPDATE no marcó sync_status='pending': {row}"
        print(f"OK - markup_fijo + precio_venta editables desde el mismo campo, y persisten juntos: {row}")

        print("--- Destildar 'predeterminado' y guardar: markup_fijo pasa a NULL (precio_venta no se toca) ---")
        # El checkbox real queda con tamaño 0 (es un .ed-toggle-switch con el
        # <input> visualmente oculto detrás del slider) -- Playwright no puede
        # clickearlo/ni forzarlo de forma confiable dentro del viewport, así
        # que se dispara el evento igual que un click real lo haría.
        page.evaluate("""
          () => {
            const chk = document.getElementById('ed-markup-fijo-check');
            chk.checked = false;
            chk.dispatchEvent(new Event('change', { bubbles: true }));
          }
        """)
        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(500)
        row_unchecked = q(page, "SELECT markup_fijo, precio_venta FROM productos WHERE id=?", [prod_a["id"]])[0]
        assert row_unchecked["markup_fijo"] is None, f"BUG: destildar el checkbox debería borrar markup_fijo: {row_unchecked}"
        assert abs(float(row_unchecked["precio_venta"]) - 135.0) < 0.01, f"Destildar no debería tocar el precio: {row_unchecked}"
        print(f"OK - destildar borra markup_fijo sin tocar el precio: {row_unchecked}")

        # Vuelve a 30%/tildado para que el resto del test use el valor sembrado.
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)
        page.locator("#ed-markup").click()
        page.locator("#ed-markup").fill("30")
        page.wait_for_timeout(150)
        page.evaluate("""
          () => {
            const chk = document.getElementById('ed-markup-fijo-check');
            chk.checked = true;
            chk.dispatchEvent(new Event('change', { bubbles: true }));
          }
        """)
        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(500)
        row_restored = q(page, "SELECT markup_fijo, precio_venta FROM productos WHERE id=?", [prod_a["id"]])[0]
        assert float(row_restored["markup_fijo"]) == 30.0 and abs(float(row_restored["precio_venta"]) - 130.0) < 0.01, (
            f"No se pudo restaurar el estado sembrado (markup_fijo=30, precio=130) para el resto del test: {row_restored}"
        )

        print("--- Confirmar compra de A con costo nuevo: precio se recalcula SOLO (sin click) ---")
        completar_compra_remito(page, "Producto Markup A", cantidad=10, costo=200)
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "markup_fijo_post_compra.png"), full_page=True)

        fila = page.locator("#cv2-post-tbody tr[data-idx='0']")
        badge = fila.locator(".cv2-post-badge-markup")
        assert badge.count() == 1, f"No aparece el badge 'Markup fijo': {fila.inner_text()!r}"
        assert "30%" in badge.inner_text(), f"El badge no muestra el % correcto: {badge.inner_text()!r}"
        input_precio = fila.locator(".cv2-post-precio-input")
        assert input_precio.is_disabled(), "El precio debería estar bloqueado (ya se aplicó solo)"
        assert input_precio.input_value() == "260.00", (
            f"BUG: 200 costo x 1.30 = 260, el precio no se recalculó bien: {input_precio.input_value()!r}"
        )

        row_a = q(page, "SELECT costo, precio_venta FROM productos WHERE id=?", [prod_a["id"]])[0]
        assert float(row_a["precio_venta"]) == 260.0, f"productos.precio_venta no se actualizó solo: {row_a}"
        print(f"OK - precio recalculado solo al confirmar la compra: {row_a}")

        print("--- Corregir el precio y responder 'Sí' (actualizar el markup predeterminado) ---")
        fila.locator(".cv2-post-editar-aldia-btn").click()
        page.wait_for_timeout(200)
        page.fill(f"#cv2-post-tbody tr[data-idx='0'] .cv2-post-precio-input", "300")
        page.once("dialog", lambda d: d.accept())
        page.locator("#cv2-post-tbody tr[data-idx='0'] .cv2-post-actualizar-btn").click()
        page.wait_for_timeout(400)

        row_a2 = q(page, "SELECT precio_venta, markup_fijo FROM productos WHERE id=?", [prod_a["id"]])[0]
        assert float(row_a2["precio_venta"]) == 300.0, f"El precio corregido no se guardó: {row_a2}"
        # 300 / 200 - 1 = 0.5 -> 50%
        assert abs(float(row_a2["markup_fijo"]) - 50.0) < 0.01, (
            f"BUG: el markup predeterminado debería haberse actualizado a 50% (300/200): {row_a2}"
        )
        print(f"OK - 'Sí' actualiza el markup predeterminado: {row_a2}")

        badge_final = fila.locator(".cv2-post-badge-guardado")
        assert badge_final.count() == 1, "Tras corregir a mano, el badge debería pasar a '✓ Guardado' (no seguir como automático)"

        print("--- Cerrar el flujo de A antes de arrancar el de B ---")
        page.locator("#cv2-post-btn-finish").click()
        page.wait_for_timeout(400)
        page.locator("#cv2-rf-btn-pos").click()
        page.wait_for_timeout(400)

        print("--- Producto B: corregir el precio y responder 'Cancelar' (solo esta vez) ---")
        completar_compra_remito(page, "Producto Markup B", cantidad=5, costo=120)
        page.wait_for_timeout(300)

        fila_b = page.locator("#cv2-post-tbody tr[data-idx='0']")
        assert fila_b.locator(".cv2-post-badge-markup").count() == 1, "Producto B no muestra el badge de markup fijo"
        prod_b = q(page, "SELECT id FROM productos WHERE nombre='Producto Markup B'")[0]
        row_b0 = q(page, "SELECT precio_venta, markup_fijo FROM productos WHERE id=?", [prod_b["id"]])[0]
        # 120 costo x 1.30 = 156
        assert float(row_b0["precio_venta"]) == 156.0, f"Precio auto tras el primer cambio de costo: {row_b0}"
        assert float(row_b0["markup_fijo"]) == 30.0

        fila_b.locator(".cv2-post-editar-aldia-btn").click()
        page.wait_for_timeout(200)
        page.fill(f"#cv2-post-tbody tr[data-idx='0'] .cv2-post-precio-input", "999")
        page.once("dialog", lambda d: d.dismiss())
        page.locator("#cv2-post-tbody tr[data-idx='0'] .cv2-post-actualizar-btn").click()
        page.wait_for_timeout(400)

        row_b1 = q(page, "SELECT precio_venta, markup_fijo FROM productos WHERE id=?", [prod_b["id"]])[0]
        assert float(row_b1["precio_venta"]) == 999.0, f"El precio puntual no se guardó: {row_b1}"
        assert float(row_b1["markup_fijo"]) == 30.0, (
            f"BUG: 'Cancelar' (solo esta vez) no debería tocar el markup predeterminado: {row_b1}"
        )
        print(f"OK - 'Cancelar' deja el precio puntual sin tocar el markup predeterminado: {row_b1}")

        print("--- La PRÓXIMA compra que le cambie el costo a B vuelve a aplicar el markup de siempre (30%) ---")
        page.locator("#cv2-post-btn-finish").click()
        page.wait_for_timeout(400)
        page.locator("#cv2-rf-btn-pos").click()
        page.wait_for_timeout(400)
        completar_compra_remito(page, "Producto Markup B", cantidad=5, costo=150)
        page.wait_for_timeout(300)

        row_b2 = q(page, "SELECT costo, precio_venta, markup_fijo FROM productos WHERE id=?", [prod_b["id"]])[0]
        # 150 x 1.30 = 195 -- NO 999, y NO una variación calculada sobre el 999 puntual.
        assert float(row_b2["precio_venta"]) == 195.0, (
            f"BUG: la siguiente compra debería volver a aplicar el markup predeterminado (30% de 150 = 195), "
            f"ignorando el precio puntual de la vez anterior: {row_b2}"
        )
        print(f"OK - el precio puntual no persiste: la siguiente compra reaplica el markup de siempre: {row_b2}")

        print("--- Cerrar el flujo de B antes de arrancar el de C ---")
        page.locator("#cv2-post-btn-finish").click()
        page.wait_for_timeout(400)
        page.locator("#cv2-rf-btn-pos").click()
        page.wait_for_timeout(400)

        print("--- Producto C (con familia): el auto-cálculo de markup abre SOLO el wizard de familia ---")
        prod_c      = q(page, "SELECT id FROM productos WHERE nombre='Producto Markup C'")[0]
        prod_c_hijo = q(page, "SELECT id FROM productos WHERE nombre='Hijo de Markup C'")[0]
        completar_compra_remito(page, "Producto Markup C", cantidad=10, costo=200)
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "markup_fijo_familia_auto.png"), full_page=True)

        fila_c = page.locator("#cv2-post-tbody tr[data-idx='0']")
        assert fila_c.locator(".cv2-post-badge-markup").count() == 1, "Producto C no muestra el badge de markup fijo"
        row_c0 = q(page, "SELECT precio_venta FROM productos WHERE id=?", [prod_c["id"]])[0]
        assert float(row_c0["precio_venta"]) == 260.0, f"Precio auto de C (200 x 1.30): {row_c0}"

        assert page.locator(".cv2-her-overlay").is_visible(), (
            "BUG: el producto con markup fijo tiene familia y no se abrió SOLO el wizard de sincronización"
        )
        print("   OK - el wizard de familia se abrió solo, sin click, apenas se auto-aplicó el markup")

        print("--- Sincronizar (Finalizar y aplicar cambios): el hijo hereda costo y precio ---")
        page.locator(".cv2-her-btn-apply").click()
        page.wait_for_timeout(300)
        assert not page.locator(".cv2-her-overlay").is_visible(), "El wizard de familia debería haberse cerrado"

        row_hijo = q(page, "SELECT costo, precio_venta FROM productos WHERE id=?", [prod_c_hijo["id"]])[0]
        assert float(row_hijo["costo"]) == 200.0 and float(row_hijo["precio_venta"]) == 260.0, (
            f"BUG: el hijo debería haber heredado costo=200/precio=260 al sincronizar: {row_hijo}"
        )
        print(f"   OK - el hijo heredó costo/precio: {row_hijo}")

        print("--- Regresión: 'Finalizar' -> Resumen Final -> 'Volver' NO reabre el wizard para el mismo producto ---")
        page.locator("#cv2-post-btn-finish").click()
        page.wait_for_timeout(400)
        page.locator("#cv2-rf-btn-volver").click()
        page.wait_for_timeout(400)
        assert not page.locator(".cv2-her-overlay").is_visible(), (
            "BUG: al volver a renderizar la misma pantalla para los mismos items, el wizard de familia se reabrió "
            "para un producto ya consultado (falta la marca markupFamiliaPreguntado)"
        )
        print("   OK - el wizard no se repite en un re-render de los mismos items")

        assert not errors, f"Errores JS no capturados en página: {errors}"

        print("OK - Markup fijo por producto: Editor, auto-cálculo, override 'Sí'/'Solo esta vez', y no-persistencia del puntual.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
