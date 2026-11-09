"""
tests/e2e/test_precios_historial_caminos.py

Historial de cambios de costo/precio (precios_historial, 9/11/2026, pedido del usuario: "cualquiera
sea el camino debe quedar registro"). Maneja la UI REAL de cada camino y exige que cada cambio
quede anotado con su origen correcto -- y que NINGUNO caiga en 'otro' (un camino que escribe
costo/precio sin pasar por el contexto de origen).

Caminos cubiertos (todos en Admin-POS, un solo dispositivo; la sincronizacion entre dos
dispositivos esta en test_precios_historial_sync.py):
  1. Confirmar una compra que cambia el costo           -> origen 'compra' (con id de la compra)
  2. ... y el markup fijo recalcula el precio solo        -> origen 'markup_fijo'
  3. Editor de producto (costo y precio)                  -> origen 'editor'
  4. Informes -> Precios y Etiquetas (precio inline)      -> origen 'informe_precios'
  5. ... y el wizard de familia actualiza al hijo         -> origen 'familia' (ref = producto origen)
  6. Alta de un producto desde el editor                  -> fila de alta (valores anteriores NULL)
Mas: un guardado del editor SIN cambiar costo/precio no registra nada, y la pestana "Historial de
precios" del editor muestra los cambios con sus origenes y filtra por costo / por precio.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_precios_historial_caminos.py
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
  const now = new Date().toISOString();
  const mk = (id, nombre, costo, precio, extra) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, markup_fijo, stock_minimo, unidad_medida,
       unidad_compra, unidades_por_paquete_compra, unidad_venta,
       es_madre, producto_madre_id, hereda_costo, hereda_precio, precio_independiente, activo,
       fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'unidad', 'Unidad', 1, 'Unidad', ?, ?, ?, ?, 0, 1, ?, ?, 'synced', ?)`,
    [id, nombre, costo, costo, precio, extra.markup ?? null, extra.madre ? 1 : 0, extra.madreId ?? null,
     extra.hereda ?? 1, extra.hereda ?? 1, now, now, now]);
  mk('h-compra',  'Hist Compra Alfa',   100, 130, { markup: 30 });
  mk('h-editor',  'Hist Editor Beta',   100, 150, {});
  mk('h-madre',   'Hist Familia Madre', 100, 150, { madre: true });
  mk('h-hijo',    'Hist Hijo Sub',      100, 150, { madreId: 'h-madre' });
}
"""

HIST = ("SELECT producto_id, origen, ref_tipo, ref_id, detalle, costo_anterior, costo_nuevo, "
        "precio_anterior, precio_nuevo, usuario_id FROM precios_historial WHERE producto_id = ? ORDER BY fecha, rowid")


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def completar_compra_remito(page, nombre_producto, cantidad, costo):
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
    page.wait_for_timeout(900)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1900, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login Admin-POS + 4 productos propios ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)
        assert q(page, "SELECT COUNT(*) AS n FROM precios_historial WHERE producto_id LIKE 'h-%'")[0]["n"] == 0, \
            "Insertar un producto ya sincronizado no debe crear historial (el trigger solo mira UPDATEs)"
        uid = page.evaluate("window.SGA_Auth.getCurrentUser().id")

        print("--- 1 y 2. Compra que sube el costo 100 -> 200: 'compra' + 'markup_fijo' (precio 130 -> 260) ---")
        completar_compra_remito(page, "Hist Compra Alfa", cantidad=10, costo=200)
        h = q(page, HIST, ["h-compra"])
        por_origen = {r["origen"]: r for r in h}
        assert "compra" in por_origen, f"La compra no dejó registro de costo: {h}"
        c = por_origen["compra"]
        assert c["costo_anterior"] == 100 and c["costo_nuevo"] == 200, f"Costo mal registrado: {c}"
        assert c["ref_tipo"] == "compras" and c["ref_id"], f"Debe referenciar la compra: {c}"
        assert q(page, "SELECT COUNT(*) AS n FROM compras WHERE id = ?", [c["ref_id"]])[0]["n"] == 1, "ref_id no es una compra real"
        assert c["usuario_id"] == uid, f"Debe registrar el usuario logueado: {c['usuario_id']} vs {uid}"
        assert "markup_fijo" in por_origen, f"El recálculo por markup fijo no dejó registro: {h}"
        m = por_origen["markup_fijo"]
        assert m["precio_anterior"] == 130 and m["precio_nuevo"] == 260, f"Precio por markup mal registrado: {m}"
        assert m["ref_id"] == c["ref_id"], "El markup debe apuntar a la misma compra"
        print(f"   OK: {[(r['origen'], r['costo_nuevo'], r['precio_nuevo']) for r in h]}")

        print("--- 3. Editor de producto: costo y precio ---")
        page.evaluate("window.location.hash = 'editor-producto/h-editor'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(300)
        page.locator("#ed-costo").fill("110")
        page.locator("#ed-costo").blur()
        page.locator("#ed-precio-venta").fill("170")
        page.locator("#ed-precio-venta").blur()
        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(600)
        final = q(page, "SELECT costo, precio_venta FROM productos WHERE id='h-editor'")[0]
        h = q(page, HIST, ["h-editor"])
        assert len(h) == 1 and h[0]["origen"] == "editor", f"El editor debe dejar UNA fila 'editor': {h}"
        assert h[0]["costo_anterior"] == 100 and h[0]["costo_nuevo"] == final["costo"], f"Costo: {h[0]} vs {final}"
        assert h[0]["precio_anterior"] == 150 and h[0]["precio_nuevo"] == final["precio_venta"], f"Precio: {h[0]} vs {final}"
        assert h[0]["usuario_id"] == uid, "El editor debe registrar el usuario"
        print(f"   OK: costo 100 -> {final['costo']}, precio 150 -> {final['precio_venta']}")

        print("--- 3b. Guardar el editor SIN cambiar costo ni precio no registra nada ---")
        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(500)
        assert len(q(page, HIST, ["h-editor"])) == 1, "Un guardado sin cambios de costo/precio no debe agregar filas"

        print("--- 4 y 5. Informes -> Precios y Etiquetas: precio inline, y el wizard de familia ---")
        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.locator("#inf-sel-reporte").select_option("precios_etiquetas")
        page.locator("#inf-dias-sin-precio").select_option("0")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(400)
        inp = page.locator(".inf-pe-nuevo[data-id='h-madre']")
        inp.fill("250")
        inp.press("Enter")
        page.wait_for_selector(".cv2-her-overlay", timeout=4000)
        page.locator(".cv2-her-btn-apply").click()
        page.wait_for_timeout(500)
        hm = q(page, HIST, ["h-madre"])
        assert len(hm) == 1 and hm[0]["origen"] == "informe_precios" and hm[0]["precio_nuevo"] == 250, f"Informe: {hm}"
        hh = q(page, HIST, ["h-hijo"])
        assert len(hh) == 1 and hh[0]["origen"] == "familia", f"El hijo debe quedar registrado como 'familia': {hh}"
        assert hh[0]["ref_id"] == "h-madre" and hh[0]["precio_anterior"] == 150 and hh[0]["precio_nuevo"] == 250, hh
        assert "Hist Familia Madre" in (hh[0]["detalle"] or ""), f"El detalle debe nombrar de quién se heredó: {hh[0]['detalle']}"

        print("--- 6. Alta de un producto desde el editor: fila de alta (anteriores NULL) ---")
        page.evaluate("window.location.hash = 'editor-producto/new'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        assert page.locator("#ed-nombre").count() == 1, "No abrió el editor de producto nuevo"
        page.locator("#ed-nombre").fill("Hist Alta Gamma")
        page.locator("#ed-categoria").select_option(index=1)
        page.locator("[data-section='precios']").first.click()
        page.wait_for_timeout(200)
        page.locator("#ed-costo").fill("50")
        page.locator("#ed-costo").blur()
        page.locator("#ed-precio-venta").fill("80")
        page.locator("#ed-precio-venta").blur()
        page.locator("#ed-btn-save").click()
        page.wait_for_timeout(800)
        nuevo = q(page, "SELECT id FROM productos WHERE nombre = 'Hist Alta Gamma'")
        assert nuevo, "No se creó el producto de prueba"
        ha = q(page, HIST, [nuevo[0]["id"]])
        assert len(ha) == 1 and ha[0]["origen"] == "alta_editor", f"El alta debe dejar una fila 'alta_editor': {ha}"
        assert ha[0]["costo_anterior"] is None and ha[0]["precio_anterior"] is None, ha
        assert ha[0]["costo_nuevo"] == 50 and ha[0]["precio_nuevo"] == 80, ha

        print("--- Pestaña 'Historial de precios' del editor ---")
        page.evaluate("window.location.hash = 'editor-producto/h-compra'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        tab = page.locator("[data-section='historial-precios']").first
        assert tab.count() > 0, "Falta la pestaña 'Historial de precios' en el editor"
        tab.click()
        page.wait_for_timeout(300)
        texto = page.locator("#ed-hp-tbody").inner_text()
        assert "Compra" in texto and "Markup predeterminado" in texto, f"La pestaña debe mostrar compra y markup: {texto!r}"
        assert page.locator("#ed-hp-tbody tr").count() == 2, "A tiene 2 cambios registrados"
        page.locator("#ed-hp-filtro").select_option("precio")
        page.wait_for_timeout(200)
        solo_precio = page.locator("#ed-hp-tbody").inner_text()
        assert "Markup predeterminado" in solo_precio and page.locator("#ed-hp-tbody tr").count() == 1, \
            f"El filtro 'precio' debe dejar solo el cambio de precio: {solo_precio!r}"
        page.locator("#ed-hp-filtro").select_option("costo")
        page.wait_for_timeout(200)
        assert page.locator("#ed-hp-tbody tr").count() == 1 and "Markup" not in page.locator("#ed-hp-tbody").inner_text(), \
            "El filtro 'costo' debe dejar solo el cambio de costo"

        print("--- Ningun cambio cayó en origen 'otro' ---")
        otros = q(page, "SELECT producto_id, origen FROM precios_historial WHERE origen = 'otro'")
        assert not otros, f"BUG: hay cambios de costo/precio sin origen (algún camino no pasa por conOrigenCambio): {otros}"

        assert not errors, f"Errores JS en pantalla: {errors}"
        context.close()
        browser.close()
        print("\nOK - test_precios_historial_caminos: PASA")


if __name__ == "__main__":
    main()
