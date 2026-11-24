"""
tests/e2e/test_detalle_compra_resalta_precios.py — "Detalle de compra" resalta los productos cuyo
precio de venta se modificó al cargar la compra.

Pedido del dueño (24/11/2026): en Admin-POS -> Operaciones de Stock -> Historial de Compras -> Ver
(la vista donde revisa precios), resaltar el renglón de cada producto que sufrió un cambio de precio
de venta durante ese proceso de compra (lo que la cajera ve en "Resumen de Cambios").

Con la UI real: compra -> ajuste de precios (precio a mano + familia sincronizada) -> PAUSAR ->
RETOMAR -> otro precio a mano -> Detalle de compra. Cubre:
1. Se resaltan: markup predeterminado, precio revisado a mano, hijo sincronizado por el wizard de
   familia y precio revisado DESPUÉS de pausar y retomar. No se resaltan los que no cambiaron.
2. Pausar/retomar ya no pierde el id de la compra en el historial (antes quedaba sin referencia).
3. Editar un precio desde ESTA vista (el dueño revisando) NO lo resalta.
4. Datos viejos (ajuste retomado guardado sin referencia) se atribuyen a la compra; si hubo después
   otra compra del producto, el cambio es de esa y no de esta.

Correr (server en :8765):  python tests/e2e/test_detalle_compra_resalta_precios.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """() => {
  const now = new Date().toISOString();
  const prov = window.SGA_DB.query("SELECT id FROM proveedores WHERE razon_social = 'Pepsico SA'")[0].id;
  const suc = window.SGA_Auth.getCurrentUser().sucursal_id;
  const mk = (id, nombre, precio, extra = {}) => {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, proveedor_principal_id, activo,
         unidad_medida, unidad_compra, unidades_por_paquete_compra, unidad_venta, markup_fijo, es_madre,
         producto_madre_id, hereda_costo, hereda_precio, precio_independiente, sync_status, updated_at)
       VALUES (?, ?, 100, 100, ?, ?, 1, 'unidad', 'Unidad', 1, 'Unidad', ?, ?, ?, 1, 1, 0, 'synced', ?)`,
      [id, nombre, precio, prov, extra.markup ?? null, extra.madre ? 1 : 0, extra.madreId ?? null, now]);
    window.SGA_DB.run(`INSERT OR IGNORE INTO stock (producto_id, sucursal_id, cantidad) VALUES (?, ?, 0)`, [id, suc]);
  };
  mk('r-markup', 'Resal Markup Alfa', 130, { markup: 30 });
  mk('r-manual', 'Resal Manual Beta', 150);
  mk('r-madre',  'Resal Madre Gama', 150, { madre: true });
  mk('r-hijo',   'Resal Hijo Delta', 150, { madreId: 'r-madre' });
  mk('r-igual',  'Resal Igual Epsilon', 150);
  mk('r-otra',   'Resal Otra Zeta', 150);
}"""

CARRITO = [  # (nombre, costo nuevo)
    ("Resal Markup Alfa", 200), ("Resal Manual Beta", 150), ("Resal Madre Gama", 120),
    ("Resal Hijo Delta", 100), ("Resal Igual Epsilon", 100), ("Resal Otra Zeta", 100),
]


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def ir(page, ruta):
    page.evaluate(f"window.location.hash = '{ruta}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)


def cargar_compra(page):
    ir(page, "compras_v2")
    page.get_by_text("Tradicional", exact=True).click()
    page.wait_for_timeout(300)
    page.locator("#cv2-prov-search").click()
    page.keyboard.type("Pepsico", delay=20)
    page.wait_for_timeout(300)
    page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
    page.wait_for_timeout(300)
    page.select_option("#cv2-condicion-compra", label="Remito")
    page.fill("#cv2-total-factura", str(sum(c for _, c in CARRITO)))
    page.locator("#cv2-total-factura").blur()
    page.wait_for_timeout(200)
    page.get_by_text("Continuar al Carrito", exact=False).click()
    page.wait_for_timeout(400)
    for i, (nombre, costo) in enumerate(CARRITO):
        page.locator("#cv2-search").click()
        page.locator("#cv2-search").fill("")
        page.keyboard.type(nombre, delay=10)
        page.wait_for_timeout(400)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=nombre).click()
        page.wait_for_timeout(350)
        row = f"tr[data-idx='{i}']"
        page.fill(f"{row} input[data-field='cantidad']", "1")
        page.fill(f"{row} input[data-field='costoNuevo']", str(costo))
        page.locator(f"{row} input[data-field='costoNuevo']").blur()
        page.wait_for_timeout(250)
    page.get_by_text("Siguiente", exact=False).click()
    page.wait_for_timeout(500)
    page.get_by_text("Confirmar Ingreso", exact=False).click()
    page.wait_for_timeout(900)


def guardar_precio(page, prod_id, precio):
    boton = page.locator(f".cv2-post-actualizar-btn[data-prodid='{prod_id}']")
    assert boton.count() == 1, f"No esta el boton Actualizar de {prod_id}"
    idx = boton.get_attribute("data-idx")
    page.fill(f".cv2-post-precio-input[data-idx='{idx}']", str(precio))
    boton.click()
    page.wait_for_timeout(600)


def abrir_detalle(page, compra_id):
    ir(page, "inicio")
    ir(page, "operaciones_stock")
    page.get_by_text("Historial de Compras", exact=False).first.click()
    page.wait_for_timeout(600)
    page.locator(f"[data-ver-compra='{compra_id}']").click()
    page.wait_for_timeout(600)


def resaltados(page):
    return sorted(page.evaluate("""() => [...document.querySelectorAll('#ops-detalle-body tr.ops-precio-cambiado')]
        .map(tr => tr.cells[0].innerText.trim().split('\\n')[0])"""))


def cambiar_sin_referencia(page, prod_id, precio):
    """Como guardaba el ajuste retomado ANTES del arreglo: origen 'compra' sin id de compra."""
    page.evaluate("""([id, p]) => window.SGA_DB.conOrigenCambio({ origen: 'compra', refTipo: 'compras', refId: null },
        () => window.SGA_DB.run("UPDATE productos SET precio_venta = ?, sync_status = 'pending' WHERE id = ?", [p, id]))""",
                  [prod_id, precio])
    page.wait_for_timeout(100)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        print("--- Compra + ajuste: precio de la madre (+ familia), pausar, retomar, otro precio ---")
        cargar_compra(page)
        compra_id = q(page, "SELECT compra_id FROM compra_items WHERE producto_id = 'r-manual'")[0]["compra_id"]

        guardar_precio(page, "r-madre", 200)
        sinc = page.locator(".cv2-her-btn-sinc[data-mid='r-hijo']")
        assert sinc.count() == 1, "No aparecio el wizard de familia con el hijo"
        page.locator(".cv2-her-chk-precio[data-mid='r-hijo']").check()
        sinc.click()
        page.wait_for_timeout(300)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        page.locator("#cv2-post-btn-pausar").click()
        page.wait_for_timeout(1800)
        page.evaluate("() => sessionStorage.setItem('compras_v2_retomar', '1')")
        ir(page, "compras_v2")
        guardar_precio(page, "r-manual", 190)

        h = q(page, "SELECT ref_tipo, ref_id FROM precios_historial WHERE producto_id = 'r-manual' AND precio_nuevo = 190")
        assert len(h) == 1 and h[0]["ref_id"] == compra_id, \
            f"BUG: el precio revisado despues de Pausar/Retomar quedo sin referencia a la compra: {h}"
        print("OK - pausar y retomar conserva el id de la compra en el historial")

        print("=== 1) Detalle de compra resalta solo los que cambiaron de precio ===")
        abrir_detalle(page, compra_id)
        esperado = sorted(["Resal Markup Alfa", "Resal Manual Beta", "Resal Madre Gama", "Resal Hijo Delta"])
        assert resaltados(page) == esperado, f"BUG: resaltados {resaltados(page)} != {esperado}"
        fila = page.locator("#ops-detalle-body tr.ops-precio-cambiado", has_text="Resal Manual Beta")
        assert "150" in fila.get_attribute("title") and "190" in fila.get_attribute("title"), fila.get_attribute("title")
        fondo = fila.evaluate("e => getComputedStyle(e).backgroundColor")
        assert fondo.startswith("rgba(33, 150, 243"), f"El renglon no tiene el fondo semitransparente: {fondo}"
        assert "4 productos cambiaron" in page.locator("#ops-detalle-body .ops-leyenda-precio").inner_text()
        print(f"OK - {resaltados(page)}")

        print("=== 3) Un precio editado desde esta misma vista no se resalta ===")
        inp = page.locator("#ops-detalle-body .ops-precio-input[data-prodid='r-igual']")
        inp.fill("175")
        inp.press("Tab")
        page.wait_for_timeout(500)
        assert q(page, "SELECT precio_venta FROM productos WHERE id='r-igual'")[0]["precio_venta"] == 175
        abrir_detalle(page, compra_id)
        assert resaltados(page) == esperado, f"BUG: la edicion del dueño en esta vista no tiene que resaltar: {resaltados(page)}"
        print("OK")

        print("=== 4) Datos viejos sin referencia: se atribuyen a la compra que corresponde ===")
        cambiar_sin_referencia(page, "r-igual", 180)
        abrir_detalle(page, compra_id)
        assert "Resal Igual Epsilon" in resaltados(page), "BUG: un cambio viejo sin referencia no se atribuyo a la compra"

        page.evaluate("""() => {
          const ts = new Date().toISOString(), suc = window.SGA_Auth.getCurrentUser().sucursal_id;
          const prov = window.SGA_DB.query("SELECT id FROM proveedores WHERE razon_social = 'Pepsico SA'")[0].id;
          window.SGA_DB.run(`INSERT INTO compras (id, sucursal_id, proveedor_id, fecha, total, estado) VALUES ('r-c2', ?, ?, ?, 100, 'confirmada')`, [suc, prov, ts.slice(0,10)]);
          window.SGA_DB.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, subtotal) VALUES ('r-i2','r-c2','r-otra',1,100,100)`);
          window.SGA_DB.moverStock({ productoId: 'r-otra', sucursalId: suc, delta: 1, tipo: 'compra', refTipo: 'compras', refId: 'r-c2', fecha: ts });
        }""")
        page.wait_for_timeout(100)
        cambiar_sin_referencia(page, "r-otra", 222)
        abrir_detalle(page, compra_id)
        assert "Resal Otra Zeta" not in resaltados(page), \
            "BUG: el cambio posterior a OTRA compra del producto se atribuyo a la compra vieja"
        abrir_detalle(page, "r-c2")
        assert resaltados(page) == ["Resal Otra Zeta"], f"En la compra nueva tiene que resaltarse: {resaltados(page)}"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_detalle_compra_resalta_precios")


if __name__ == "__main__":
    main()
