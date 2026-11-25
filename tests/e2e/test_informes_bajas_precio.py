"""
tests/e2e/test_informes_bajas_precio.py — Informes -> "Bajas de Precio" + etiqueta de promoción.

Pedido del dueño (24/11/2026): un reporte rápido con los productos que bajaron de precio de venta en
un rango, para elegir cuáles etiquetas imprimir, con opción de formato "promoción".

Cubre, con la UI real:
1. Entran solo los que quedaron más baratos que al empezar el período y siguen así hoy: una baja, dos
   bajas seguidas (antes = el primero). No entran: subas, baja que después subió, baja anterior al
   rango, producto inactivo.
2. Selección por fila + cantidad; sin selección no se puede imprimir. Formato promoción: banda OFERTA,
   precio anterior tachado, % de descuento, una etiqueta por cantidad. Marca "última impresión" SOLO de
   los elegidos y "deshacer" la restaura.
3. Formato normal: la etiqueta de siempre. "Solo con stock" oculta y desmarca.
4. Sin permiso "Imprimir etiquetas" se ve el reporte pero no se puede imprimir.

Correr (server en :8765):  python tests/e2e/test_informes_bajas_precio.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """() => {
  const now = new Date().toISOString(), suc = window.SGA_Auth.getCurrentUser().sucursal_id;
  const mk = (id, nombre, precio, stock, activo = 1) => {
    window.SGA_DB.run(`INSERT INTO productos (id, nombre, costo, precio_venta, activo, sync_status, updated_at,
        unidad_medida, unidad_compra, unidades_por_paquete_compra, unidad_venta)
      VALUES (?, ?, 50, ?, ?, 'synced', ?, 'unidad', 'Unidad', 1, 'Unidad')`, [id, nombre, precio, activo, now]);
    window.SGA_DB.run(`INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES (?, ?, ?, 1)`, ['cb-' + id, id, '779000000' + id.slice(-3)]);
    if (stock) window.SGA_DB.moverStock({ productoId: id, sucursalId: suc, delta: stock, tipo: 'saldo_inicial' });
  };
  const precio = (id, p) => window.SGA_DB.conOrigenCambio({ origen: 'editor' }, () => window.SGA_DB.run(
    "UPDATE productos SET precio_venta=?, ultima_modificacion_precio=?, sync_status='pending' WHERE id=?", [p, new Date().toISOString(), id]));
  mk('b-001', 'Baja Simple', 150, 10);   precio('b-001', 120);                       // -20%
  mk('b-002', 'Suba Simple', 100, 10);   precio('b-002', 130);
  mk('b-003', 'Doble Baja', 200, 0);     precio('b-003', 180); precio('b-003', 140); // -30% (sin stock)
  mk('b-004', 'Baja y Suba', 200, 5);    precio('b-004', 150); precio('b-004', 220);
  mk('b-005', 'Baja Vieja', 90, 5);
  window.SGA_DB.run(`INSERT INTO precios_historial (id, producto_id, fecha, precio_anterior, precio_nuevo, origen)
      VALUES ('h-vieja', 'b-005', '2026-01-05T10:00:00.000Z', 120, 90, 'editor')`);
  mk('b-006', 'Baja Inactiva', 100, 5);  precio('b-006', 60);
  window.SGA_DB.run("UPDATE productos SET activo = 0 WHERE id = 'b-006'");
}"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def ir_reporte(page):
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(300)
    page.evaluate("window.location.hash = 'informes'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)
    page.select_option("#inf-sel-reporte", "bajas_precio")
    page.locator("#inf-btn-generar").click()
    page.wait_for_timeout(600)


def nombres(page, visibles=True):
    return page.evaluate("""(v) => [...document.querySelectorAll('#inf-bajas-tabla tbody tr')]
        .filter(tr => !v || tr.style.display !== 'none').map(tr => tr.querySelector('strong').innerText)""", visibles)


def capturar(page):
    page.evaluate("() => { window.__blobs = []; window.open = (u) => { window.__blobs.push(fetch(u).then(r => r.text())); return {}; }; }")


def ultimo_html(page):
    page.wait_for_timeout(300)
    return page.evaluate("async () => (await Promise.all(window.__blobs)).slice(-1)[0] || ''")


def fila(page, pid):
    return page.locator(f"#inf-bajas-tabla tr[data-baja='{pid}']")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=True)
        page.evaluate("() => localStorage.removeItem('sga_print_config')")
        page.evaluate(SEMBRAR)

        print("=== 1) Entran solo las bajas netas del periodo ===")
        ir_reporte(page)
        assert nombres(page) == ["Doble Baja", "Baja Simple"], f"BUG: lista {nombres(page)}"
        t = fila(page, "b-003").inner_text()
        assert "200,00" in t and "140,00" in t and "-30.0%" in t, f"Doble baja mal calculada: {t}"
        print("OK -", nombres(page))

        print("=== 2) Seleccion, formato promocion, marca y deshacer ===")
        boton = page.locator("#inf-bajas-imprimir")
        assert boton.is_disabled(), "Sin seleccion no tiene que dejar imprimir"
        fila(page, "b-001").locator("td").nth(1).click()          # clic en la fila = marcar
        fila(page, "b-001").locator(".inf-bajas-cant").fill("3")
        assert "(3)" in boton.inner_text(), boton.inner_text()
        capturar(page)
        boton.click()
        html = ultimo_html(page)
        assert html.count('class="etiq etiq-promo"') == 3, "Una etiqueta de promo por cantidad"
        assert "Válido" not in html and page.locator("#inf-bajas-vigencia").count() == 0, "Sin fecha de vigencia"
        assert ",00" not in html.split("<body>")[1], "La etiqueta de promocion va sin decimales"
        assert "repeat(3, 70mm)" in html and "grid-auto-rows: 37.1mm" in html, "La promo usa su tamaño (A4 3x8 por defecto)"
        for s in ("OFERTA", "-20%", "Antes <s>$ 150</s>", ">$ 120<", "print-color-adjust: exact"):
            assert s in html, f"Falta {s!r} en la etiqueta de promocion"
        assert "Doble Baja" not in html, "Se imprimio un producto no seleccionado"
        marcas = {r["id"]: r["ultima_impresion_etiqueta"] for r in q(page, "SELECT id, ultima_impresion_etiqueta FROM productos WHERE id IN ('b-001','b-003')")}
        assert marcas["b-001"] and not marcas["b-003"], f"Marca de impresion mal puesta: {marcas}"
        assert "Impresa" in fila(page, "b-001").inner_text()
        page.locator("#inf-bajas-deshacer").click()
        page.wait_for_timeout(600)
        assert q(page, "SELECT ultima_impresion_etiqueta AS m FROM productos WHERE id='b-001'")[0]["m"] is None, "Deshacer no restauro la marca"
        print("OK")

        print("=== 3) Formato normal y 'Solo con stock' ===")
        ir_reporte(page)
        page.locator("#inf-bajas-todos").check()
        assert "(2)" in page.locator("#inf-bajas-imprimir").inner_text()
        page.locator("#inf-bajas-solo-stock").check()
        assert nombres(page) == ["Baja Simple"], nombres(page)
        assert "(1)" in page.locator("#inf-bajas-imprimir").inner_text(), "Lo oculto no puede seguir seleccionado"
        page.locator("input[name='inf-bajas-formato'][value='normal']").check()
        capturar(page)
        page.locator("#inf-bajas-imprimir").click()
        html = ultimo_html(page)
        assert html.count('class="etiq"') == 1 and "etiq-promo" not in html and "OFERTA" not in html
        assert "repeat(3, 70mm)" in html, "Usa la configuracion de etiquetas de este equipo"
        print("OK")

        print("=== 3b) Con centavos se muestran; el tamaño de promo se configura aparte ===")
        res = page.evaluate("""async () => { const E = (await import('/js/modules/etiquetas.js')).default;
            window.SGA_Impresion.saveConfig({ etiquetasPromo: { preset: 'a4_2x5', modo: 'hoja', papel: 'A4', columnas: 2, ancho: 105, alto: 59.4 } });
            const it = [{ nombre: 'Con centavos', precio: 7380.5, precioAnterior: 8000, codigo: '7791234567895' }];
            return { promo: E.construirHTML(it, { formato: 'promo' }), normal: E.construirHTML(it) }; }""")
        assert "$ 7.380,50" in res["promo"] and "$ 8.000</s>" in res["promo"], "Si hay centavos, la etiqueta tiene que decirlos"
        assert "repeat(2, 105mm)" in res["promo"] and "grid-auto-rows: 59.4mm" in res["promo"]
        assert "repeat(3, 70mm)" in res["normal"] and "grid-auto-rows: 29.7mm" in res["normal"], "La normal no cambia"
        page.evaluate("() => localStorage.removeItem('sga_print_config')")
        print("OK")

        print("=== 4) Sin permiso de etiquetas: se ve pero no se imprime ===")
        page.evaluate("""() => { const can = window.SGA_Permisos.can.bind(window.SGA_Permisos);
            window.SGA_Permisos.can = (k) => k === 'can_etiquetas' ? false : can(k); }""")
        ir_reporte(page)
        assert page.locator("#inf-bajas-tabla").count() == 1, "El reporte se tiene que ver"
        assert page.locator("#inf-bajas-imprimir").count() == 0 and page.locator(".inf-bajas-chk").count() == 0, \
            "BUG: sin permiso de etiquetas no se tiene que poder imprimir"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_informes_bajas_precio")


if __name__ == "__main__":
    main()
