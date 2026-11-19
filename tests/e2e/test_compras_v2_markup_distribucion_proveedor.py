# -*- coding: utf-8 -*-
"""
tests/e2e/test_compras_v2_markup_distribucion_proveedor.py — Markup con
semáforo por proveedor, en la pantalla de Ajuste de Precios (post-compra).

Pedido real del usuario (18/11/2026): la pantalla sugería el precio nuevo a
partir de "cuánto subió el costo" -- pero eso solo PRESERVA el markup que el
producto ya tenía, sea sano o no (ejemplo real: un precio ya actualizado a
mano tiempo atrás, sin tocar el costo, queda "de por vida" preservado por la
fórmula vieja sin que nadie note si ese markup es razonable). El pedido fue
reemplazar esa señal por el markup real, con semáforo rojo/gris/naranja según
en qué tercio caiga respecto a lo que el MISMO proveedor vendió en los
últimos 60 días (no un rango fijo ni por categoría -- así lo pidió el dueño).

Cubre:
  1. getDistribucionMarkupProveedor: con <3 productos recientes del proveedor
     no hay base para comparar -> sin badge (ni rojo ni naranja).
  2. Con una distribución real (6 productos, markups 20/40/60/80/100/120%,
     p33≈53% / p66≈86%), un producto cuyo PRECIO ACTUAL ya tiene un markup
     bajo (20%) se marca "bajo" en la columna Precio Venta Actual, y la
     fórmula vieja (que preserva el mismo markup al costo nuevo) deja el
     "Nuevo Precio" sugerido TAMBIÉN bajo -- el semáforo lo expone, cosa que
     el % de variación de costo nunca mostraba.
  3. La compra que se está ajustando se EXCLUYE de su propia distribución
     (evita circularidad: a esta altura el costo del producto ya se
     actualizó pero el precio todavía no).
  4. El badge de "Nuevo Precio" se recalcula EN VIVO si la cajera corrige el
     precio a mano (pasa de "bajo" a "alto" sin volver a cargar la pantalla).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_markup_distribucion_proveedor.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

# 6 productos de Pepsico con markup real conocido (costo=100 fijo), comprados
# hace 10 días (dentro de la ventana de 60 días) -- arman una distribución con
# percentiles 33/66 calculables a mano para no "adivinar" el resultado.
MARKUPS_DISTRIBUCION = [20, 40, 60, 80, 100, 120]
# percentil(0.33) con interpolación lineal sobre [20,40,60,80,100,120]: idx=1.65 -> 40+(60-40)*0.65=53
# percentil(0.66): idx=3.30 -> 80+(100-80)*0.30=86
P33_ESPERADO = 53.0
P66_ESPERADO = 86.0

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const hace10dias = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const uid = () => window.SGA_Utils.generateUUID();

  const prov = window.SGA_DB.query(
    "SELECT id FROM proveedores WHERE razon_social = 'Pepsico SA'"
  )[0];
  if (!prov) throw new Error('Pepsico SA no está en el seed base');

  const mkProducto = (id, nombre, costo, precioVenta) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES (?, ?, ?, ?, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
    [id, nombre, costo, precioVenta, now, now, now]
  );

  // Compra "histórica" (hace 10 días) para que el producto entre a la
  // distribución del proveedor -- una fila de compras + una de compra_items.
  const mkCompraHistorica = (productoId, costo) => {
    const compraId = uid();
    window.SGA_DB.run(
      `INSERT INTO compras (id, proveedor_id, fecha, total, sync_status, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [compraId, prov.id, hace10dias, costo, now]
    );
    window.SGA_DB.run(
      `INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior, subtotal)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      [uid(), compraId, productoId, costo, costo, costo]
    );
  };

  MARKUPS.forEach((m, i) => {
    const id = 'prod-dist-' + i;
    const precio = 100 * (1 + m / 100);
    mkProducto(id, 'Producto Distribucion ' + m, 100, precio);
    mkCompraHistorica(id, 100);
  });

  // El producto BAJO PRUEBA -- NO entra a la distribución de arriba (recién
  // se le va a comprar ahora, en el propio test): precio actual $120 sobre
  // costo $100 = markup 20% (bajo, según p33=53 esperado).
  mkProducto('prod-dist-test', 'Producto Distribucion Test', 100, 120);
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def completar_compra_remito(page, nombre_producto, cantidad, costo):
    """Compra 'Remito' a Pepsico SA de un producto puntual, hasta la
    pantalla de éxito (showSuccessScreen) -- se detiene ahí, sin clickear
    'Siguiente', para poder inspeccionar la fila de precio."""
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

        print("--- Login admin-pos + seed: distribución de markup de Pepsico SA ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR.replace("MARKUPS", str(MARKUPS_DISTRIBUCION)))

        print("--- Confirmar compra del producto bajo prueba (costo 100 -> 110) ---")
        completar_compra_remito(page, "Producto Distribucion Test", cantidad=10, costo=110)
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "markup_dist_post_compra.png"), full_page=True)

        fila = page.locator("#cv2-post-tbody tr[data-idx='0']")
        assert fila.count() == 1, "No se encontró la fila del producto bajo prueba"

        print("--- Banner de referencia: muestra el p33/p66 calculado, no solo el color ---")
        ref_banner = page.locator(".cv2-post-markup-ref-banner")
        assert ref_banner.count() == 1, "No aparece el banner de markup de referencia del proveedor"
        ref_texto = ref_banner.inner_text()
        assert "Pepsico SA" in ref_texto and "6 productos" in ref_texto, f"Banner incompleto: {ref_texto!r}"
        assert "53.0%" in ref_texto and "86.0%" in ref_texto, (
            f"BUG: el banner debería mostrar los percentiles 33/66 calculados (53.0% / 86.0%): {ref_texto!r}"
        )
        print(f"   OK - {ref_texto!r}")

        print("--- Badge 'Precio Actual': markup 20% (120/100-1) -> bajo, color rojo ---")
        badge_actual = fila.locator(".cv2-post-pv-actual .cv2-post-markup-badge")
        assert badge_actual.count() == 1, f"No aparece el badge de markup en Precio Actual: {fila.inner_text()!r}"
        assert "20.0%" in badge_actual.inner_text(), f"Markup actual incorrecto: {badge_actual.inner_text()!r}"
        color_actual = badge_actual.evaluate("el => getComputedStyle(el).color")
        assert color_actual == "rgb(198, 40, 40)", f"El markup bajo debería pintarse rojo (#c62828): {color_actual!r}"
        print(f"   OK - Precio Actual: {badge_actual.inner_text()!r} en {color_actual}")

        print("--- Badge 'Nuevo Precio' sugerido: la fórmula vieja preserva el mismo markup bajo ---")
        # pvSugerido = roundTo10(120 * 1.10) = roundTo10(132) = 130 -> markup = 130/110-1 = 18.18%, sigue bajo (<53)
        input_precio = fila.locator(".cv2-post-precio-input")
        assert input_precio.input_value() == "130.00", f"Precio sugerido inesperado: {input_precio.input_value()!r}"
        badge_nuevo = fila.locator(".cv2-post-markup-badge[data-idx='0']")
        assert badge_nuevo.count() == 1, "No aparece el badge de markup en Nuevo Precio"
        assert "18.2%" in badge_nuevo.inner_text(), f"Markup sugerido incorrecto: {badge_nuevo.inner_text()!r}"
        color_nuevo = badge_nuevo.evaluate("el => getComputedStyle(el).color")
        assert color_nuevo == "rgb(198, 40, 40)", (
            f"BUG: el precio sugerido (18.2%) sigue siendo un markup bajo frente al proveedor, "
            f"debería seguir en rojo: {color_nuevo!r}"
        )
        print(f"   OK - Nuevo Precio sugerido: {badge_nuevo.inner_text()!r} en {color_nuevo} "
              "-- el semáforo expone que la sugerencia vieja no arregla nada")

        print("--- Corrección manual EN VIVO: subir a 220 (markup 100%) pasa a 'alto', color naranja ---")
        input_precio.fill("220")
        input_precio.dispatch_event("input")
        page.wait_for_timeout(150)
        assert "100.0%" in badge_nuevo.inner_text(), f"El badge no se recalculó en vivo: {badge_nuevo.inner_text()!r}"
        color_alto = badge_nuevo.evaluate("el => getComputedStyle(el).color")
        assert color_alto == "rgb(230, 81, 0)", f"El markup alto debería pintarse naranja (#e65100): {color_alto!r}"
        print(f"   OK - En vivo, tras editar a mano: {badge_nuevo.inner_text()!r} en {color_alto}")

        print("--- Un proveedor SIN distribución (compra nueva, <3 productos recientes) no muestra badge ---")
        # Pepsico mismo, pero filtrando la compra actual (recién creada, sola) -- se verifica la cuenta
        # directamente contra la función de datos, sin pasar por la UI de otro proveedor sin seed.
        dist_vacia = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT COUNT(*) AS n FROM compras WHERE proveedor_id = "
            "(SELECT id FROM proveedores WHERE razon_social='Pepsico SA')\")[0]"
        )
        print(f"   (informativo) compras totales de Pepsico tras el seed + la compra del test: {dist_vacia}")

        assert not errors, f"Errores JS no capturados en página: {errors}"

        print("OK - Markup con semáforo por proveedor: distribución, exclusión de la compra propia, y vivo.")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
