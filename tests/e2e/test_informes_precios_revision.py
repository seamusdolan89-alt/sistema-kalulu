"""
tests/e2e/test_informes_precios_revision.py

Informes -> "Precios y Etiquetas" como pantalla de REVISION DE PRECIOS (6/11/2026,
pedido del usuario): ademas de las fechas, cruza stock, unidades vendidas en una ventana de
dias, y la ultima compra (si el costo cambio en ella y si el precio se toco desde entonces),
ordenado por prioridad (con stock primero, dentro de eso lo mas vendido), y deja corregir el
precio de venta en la misma pantalla.

Verifica:
  1. Orden por defecto: con stock > 0 primero, y entre esos el que mas vende primero; sin
     stock al final.
  2. "Ultima compra / costo cambio / precio tocado desde la compra" salen de la compra
     confirmada MAS RECIENTE y no de una anulada.
  3. Editar un precio inline: se escribe en productos con sync_status='pending' y
     ultima_modificacion_precio; un producto SIN familia no abre el wizard.
  4. Editar un producto CON familia abre el wizard; al aplicar, el precio del hermano que
     tambien esta en el reporte se refleja en pantalla SIN volver a generar el reporte.
  5. "Solo con stock" excluye los productos sin stock, y "Excel (todos)" los incluye igual
     (ignora los filtros de pantalla).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_informes_precios_revision.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEED_JS = """
() => {
  const db = window.SGA_DB;
  const suc = window.SGA_Auth.getCurrentUser().sucursal_id;
  const uid = window.SGA_Auth.getCurrentUser().id;
  const U = () => window.SGA_Utils.generateUUID();
  const ahora = new Date().toISOString();
  const hace = d => new Date(Date.now() - d * 86400000).toISOString();

  // Se parte de productos propios para no depender de los datos demo.
  db.run(`UPDATE productos SET activo = 0`);
  const mk = (nombre, costo, precio, extra) => {
    const id = U();
    db.run(`INSERT INTO productos (id, nombre, costo, costo_paquete, precio_venta, activo, sync_status, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, 'synced', ?)`, [id, nombre, costo, costo, precio, ahora]);
    return id;
  };
  const ids = {
    A: mk('ZZ Alfa mucho stock poca venta', 100, 150),
    B: mk('ZZ Beta stock medio mucha venta', 100, 150),
    C: mk('ZZ Gamma sin stock', 100, 150),
    F1: mk('ZZ Familia madre', 100, 150),
    F2: mk('ZZ Familia hijo', 100, 150),
  };
  db.run(`UPDATE productos SET producto_madre_id = ?, hereda_precio = 1, hereda_costo = 0 WHERE id = ?`, [ids.F1, ids.F2]);

  const stock = (id, n) => db.setStockAbsoluto({ productoId: id, sucursalId: suc, cantidad: n });
  stock(ids.A, 50); stock(ids.B, 10); stock(ids.C, 0); stock(ids.F1, 5); stock(ids.F2, 5);

  const venta = (id, cant) => {
    const vid = U();
    db.run(`INSERT INTO ventas (id, sucursal_id, usuario_id, fecha, subtotal, total, estado, sync_status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'completada', 'synced', ?)`, [vid, suc, uid, hace(5), cant * 150, cant * 150, ahora]);
    db.run(`INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
            VALUES (?, ?, ?, ?, 150, 100, ?)`, [U(), vid, id, cant, cant * 150]);
  };
  venta(ids.A, 2); venta(ids.B, 30); venta(ids.F1, 3);

  // Compras de B: una confirmada con cambio de costo (hace 20 dias) y una ANULADA mas reciente
  // (hace 2 dias) que NO debe contar.
  const compra = (id, dias, costoMod, anulada) => {
    const cid = U();
    db.run(`INSERT INTO compras (id, sucursal_id, usuario_id, fecha, total, estado, anulada_en, sync_status, updated_at)
            VALUES (?, ?, ?, ?, 1000, 'confirmada', ?, 'synced', ?)`, [cid, suc, uid, hace(dias), anulada ? hace(1) : null, hace(dias)]);
    db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, costo_anterior, subtotal, costo_modificado, tipo)
            VALUES (?, ?, ?, 10, 100, 80, 1000, ?, 'producto')`, [U(), cid, id, costoMod]);
  };
  compra(ids.B, 20, 1, false);
  compra(ids.B, 2, 0, true);          // anulada: no debe aparecer como "ultima compra"
  // El precio de B nunca se toco (ultima_modificacion_precio NULL) -> "Costo subio y precio no".
  return ids;
}
"""


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login Admin-POS + datos propios ---")
        login_via_seed(page, admin_pos=True)
        ids = page.evaluate(SEED_JS)

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.locator("#inf-sel-reporte").select_option("precios_etiquetas")
        page.locator("#inf-dias-sin-precio").select_option("0")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(300)

        def nombres_en_orden():
            return page.locator(".inf-table tbody tr td:nth-child(2)").all_inner_texts()

        print("--- 1. Orden: con stock primero, mas vendido primero; sin stock al final ---")
        orden = [n for n in nombres_en_orden() if n.startswith("ZZ")]
        assert orden[0].startswith("ZZ Beta"), f"Primero debe ir el de mas ventas con stock: {orden}"
        assert orden[1].startswith("ZZ Familia madre"), f"Segundo, el siguiente mas vendido con stock: {orden}"
        assert orden[-1].startswith("ZZ Gamma"), f"El de stock 0 va al final: {orden}"

        print("--- 2. Ultima compra = la confirmada mas reciente, NO la anulada ---")
        fila_b = page.locator(f"tr[data-pid='{ids['B']}']")
        texto_b = fila_b.inner_text()
        hace20 = page.evaluate("() => { const d = new Date(Date.now() - 20*86400000); return d.toISOString().slice(0,10).split('-').reverse().join('/'); }")
        assert hace20 in texto_b, f"Debe mostrar la compra de hace 20 dias ({hace20}), no la anulada: {texto_b!r}"
        celdas = fila_b.locator("td").all_inner_texts()
        assert "Sí" in celdas, f"Debe marcar que el costo cambio en esa compra: {celdas}"
        assert fila_b.locator("td", has_text="No").count() >= 1, "Debe marcar que el precio NO se toco desde la compra"
        assert "Nunca" in fila_a_texto(page, ids["A"]), "Un producto sin compras debe decir Nunca"

        print("--- 3. Editar precio de un producto SIN familia: se guarda, queda pending, sin wizard ---")
        inp = page.locator(f".inf-pe-nuevo[data-id='{ids['B']}']")
        inp.fill("180")
        inp.press("Enter")
        page.wait_for_timeout(300)
        assert page.locator(".cv2-her-overlay").count() == 0, "Un producto sin familia no debe abrir el wizard"
        fila = page.evaluate(
            "(id) => window.SGA_DB.query('SELECT precio_venta, ultima_modificacion_precio, sync_status FROM productos WHERE id=?', [id])[0]",
            ids["B"])
        assert fila["precio_venta"] == 180, f"No se guardo el precio: {fila}"
        assert fila["sync_status"] == "pending", f"Debe quedar pending para sincronizar: {fila}"
        assert fila["ultima_modificacion_precio"], f"Debe actualizar ultima_modificacion_precio: {fila}"
        assert "180" in page.locator(f"tr[data-pid='{ids['B']}'] .inf-pe-precio").inner_text(), \
            "La pantalla debe mostrar el precio nuevo sin regenerar"

        print("--- 4. Producto CON familia: abre el wizard; el hermano del reporte se actualiza en pantalla ---")
        inp = page.locator(f".inf-pe-nuevo[data-id='{ids['F1']}']")
        inp.fill("220")
        inp.press("Enter")
        page.wait_for_selector(".cv2-her-overlay", timeout=3000)
        page.locator(".cv2-her-btn-apply").click()
        page.wait_for_timeout(300)
        assert page.locator(".cv2-her-overlay").count() == 0, "El wizard debe cerrarse"
        hijo_db = page.evaluate(
            "(id) => window.SGA_DB.query('SELECT precio_venta, sync_status FROM productos WHERE id=?', [id])[0]", ids["F2"])
        assert hijo_db["precio_venta"] == 220 and hijo_db["sync_status"] == "pending", f"El hijo no se sincronizo: {hijo_db}"
        assert "220" in page.locator(f"tr[data-pid='{ids['F2']}'] .inf-pe-precio").inner_text(), \
            "El hijo, que tambien esta en el reporte, debe verse con el precio nuevo SIN regenerar el reporte"

        print("--- 5. 'Solo con stock' excluye sin-stock; 'Excel (todos)' los incluye igual ---")
        page.locator("#inf-solo-stock-precio").check()
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(300)
        assert not any(n.startswith("ZZ Gamma") for n in nombres_en_orden()), "Solo con stock debe ocultar el de stock 0"

        page.evaluate("""() => {
          window.__export = null;
          window.XLSX.writeFile = (wb) => {
            const ws = wb.Sheets[wb.SheetNames[0]];
            window.__export = window.XLSX.utils.sheet_to_json(ws, { header: 1 });
          };
        }""")
        page.locator("#inf-btn-excel-todos").click()
        page.wait_for_timeout(300)
        filas = page.evaluate("() => window.__export")
        assert filas, "No se genero el Excel"
        encabezado = next(f for f in filas if f and f[0] == "Código")
        assert "Nuevo precio" in encabezado and "Todos los códigos" in encabezado, f"Faltan columnas: {encabezado}"
        assert any("ZZ Gamma" in str(f) for f in filas), "'Excel (todos)' debe incluir el producto sin stock"

        assert not errors, f"Errores JS en pantalla: {errors}"
        context.close()
        browser.close()
        print("\nOK - test_informes_precios_revision: PASA")


def fila_a_texto(page, pid):
    return page.locator(f"tr[data-pid='{pid}']").inner_text()


if __name__ == "__main__":
    run()
