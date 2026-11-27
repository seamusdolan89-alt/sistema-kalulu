"""
tests/e2e/test_ordenes_sin_stock_30d.py — Órdenes de Compra: columna "Sin stock 30d".

Pedido del dueño (27/11/2026): la columna de Órdenes usa la misma cuenta que Informes → Quiebres
de Stock, sobre los últimos 30 días (hoy y los 29 anteriores). En un grupo de sustitutos cuenta la
SUMA del grupo, y el detalle muestra cada producto. El número queda guardado en la orden.

Mismo día, columna "Vencidos 30d": unidades dadas de baja por vencimiento en esa ventana.

Correr (server en :8765):  python tests/e2e/test_ordenes_sin_stock_30d.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

SEMBRAR = """() => {
  const db = window.SGA_DB, suc = window.SGA_Auth.getCurrentUser().sucursal_id;
  const prov = db.query('SELECT id FROM proveedores LIMIT 1')[0].id;
  const dia = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 1, 0, 0); return d.toISOString(); };
  const ins = (t, o) => db.run(`INSERT INTO ${t} (${Object.keys(o)}) VALUES (${Object.keys(o).map(() => '?')})`, Object.values(o));
  db.run('DELETE FROM stock_movimientos'); db.run('DELETE FROM stock'); db.run('DELETE FROM producto_sustitutos');
  db.run('UPDATE productos SET activo = 0');
  let n = 0;
  const producto = (id, nombre, movs) => {
    ins('productos', { id, nombre, activo: 1, costo: 1, precio_venta: 2, stock_minimo: 50, cant_pedido: 6,
      proveedor_principal_id: prov, fecha_alta: dia(90) });
    let total = 0;
    movs.forEach(([hace, delta], i) => {
      total += delta;
      ins('stock_movimientos', { id: i === 0 ? `saldo_inicial:${id}:${suc}` : `m${++n}`, producto_id: id, sucursal_id: suc,
        delta, tipo: 'ajuste', fecha: dia(hace) });
    });
    if (movs.length) ins('stock', { producto_id: id, sucursal_id: suc, cantidad: total });
  };
  // Suelto: sin stock de hace 50 a hace 40 (fuera de la ventana), y desde hace 5 (6 dias: 5..0)
  producto('s1', 'S Suelto', [[60, 4], [50, -4], [40, 2], [5, -2]]);
  // Grupo: la referencia sin stock desde hace 20; el sustituto cubre hasta hace 2 -> grupo 3 dias
  producto('g1', 'S Grupo Ref', [[60, 3], [20, -3]]);
  producto('g2', 'S Grupo Sust', [[60, 2], [2, -2]]);
  window.SGA_GruposSustitutos.definirGrupo({ miembros: ['g1', 'g2'], referenciaId: 'g1', involucrados: ['g1', 'g2'] });
  producto('s2', 'S Sin Historial', []);
  producto('s3', 'S Agregado', [[60, 1], [9, -1]]);
  db.run("UPDATE productos SET stock_minimo = -1 WHERE id = 's3'");
  const baja = (producto_id, cantidad, motivo, hace) => ins('consumo_interno', { id: `ci${++n}`, producto_id,
    sucursal_id: suc, usuario_id: window.SGA_Auth.getCurrentUser().id, cantidad, motivo, fecha: dia(hace) });
  baja('s1', 2, 'vencimiento', 29);                      // primer dia de la ventana: cuenta
  baja('s1', 7, 'vencimiento', 30);                      // afuera
  baja('s1', 5, 'rotura', 3);                            // otro motivo
  baja('s1', 1, 'Devolución — producto vencido', 3);     // devolucion aprobada
  baja('s1', 9, 'Devolución — producto defectuoso', 3);
  baja('g1', 4, 'vencimiento', 10);
  baja('g2', 1.5, 'vencimiento', 1);
  baja('s3', 3, 'vencimiento', 0);
  return { suc, prov };
}"""


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=True)
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        info = page.evaluate(SEMBRAR)

        orden = page.evaluate("([p, s]) => window.SGA_Ordenes.generarOrdenCompra(p, s)",
                              [info["prov"], info["suc"]])
        assert orden["success"] and orden["ordenId"], orden
        oid = orden["ordenId"]
        page.evaluate("([o, s]) => window.SGA_Ordenes.agregarItem(o, 's3', s)", [oid, info["suc"]])
        dias = {r["producto_id"]: r["d"] for r in page.evaluate(
            "(o) => window.SGA_DB.query('SELECT producto_id, dias_sin_stock_30d AS d FROM orden_compra_items WHERE orden_id = ?', [o])", oid)}
        assert dias == {"s1": 6, "g1": 3, "s2": None, "s3": 10}, dias
        print("OK - cuenta de 30 dias (suelto, grupo, sin historial, agregado a mano)")
        venc = {r["producto_id"]: r["v"] for r in page.evaluate(
            "(o) => window.SGA_DB.query('SELECT producto_id, vencidos_30d AS v FROM orden_compra_items WHERE orden_id = ?', [o])", oid)}
        assert venc == {"s1": 3, "g1": 5.5, "s2": 0, "s3": 3}, venc
        print("OK - vencidos de 30 dias")

        # Un item de una orden vieja (sin el dato) muestra "—", no 0
        page.evaluate("""(o) => window.SGA_DB.run("INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado, dias_sin_stock_6m) VALUES ('viejo', ?, 'g2', 1, 'pendiente', 25)", [o])""", oid)
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(300)
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator(f'[data-abrir="{oid}"]').click()
        page.wait_for_timeout(500)
        encabezados = [t.strip().lower() for t in page.locator("#ord-items-thead th").all_inner_texts()]
        col = encabezados.index("sin stock 30d")
        celda = lambda pid: page.locator(f"#ord-items-tbody tr[data-prod='{pid}'] td").nth(col)
        assert celda("s1").inner_text().strip() == "6"
        assert celda("s2").inner_text().strip() == "—"
        assert page.locator("tr[data-item-id='viejo'] td").nth(col).inner_text().strip() == "—"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ordenes_sin_stock_30d.png"))
        celda("g1").locator("button.ord-valor-grupo").click()
        page.wait_for_timeout(200)
        filas = page.locator(".ord-grupo-tabla tbody tr").all_inner_texts()
        ref = [f for f in filas if "S Grupo Ref" in f][0].split()
        sust = [f for f in filas if "S Grupo Sust" in f][0].split()
        assert ref[-1] == "21" and sust[-1] == "3", filas
        pie = page.locator(".ord-grupo-tabla tfoot").inner_text()
        assert "grupo entero" in pie and pie.split()[-1] == "3", pie
        page.keyboard.press("Escape")
        print("OK - columna, ordenes viejas y detalle del grupo")

        cv = encabezados.index("vencidos 30d")
        celda_v = lambda pid: page.locator(f"#ord-items-tbody tr[data-prod='{pid}'] td").nth(cv)
        assert celda_v("s1").inner_text().strip() == "3" and celda_v("s2").inner_text().strip() == "0"
        assert page.locator("tr[data-item-id='viejo'] td").nth(cv).inner_text().strip() == "—"
        assert len(page.locator("tr[data-item-id='viejo'] td").all()) == len(encabezados)
        celda_v("g1").locator("button.ord-valor-grupo").click()
        page.wait_for_timeout(200)
        filas = page.locator(".ord-grupo-tabla tbody tr").all_inner_texts()
        assert [f for f in filas if "S Grupo Ref" in f][0].split()[-1] == "4", filas
        pie = page.locator(".ord-grupo-tabla tfoot").inner_text()
        assert "Total del grupo" in pie and pie.split()[-1] in ("5,5", "5.5"), pie
        page.keyboard.press("Escape")
        print("OK - columna y detalle de vencidos")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_ordenes_sin_stock_30d")


if __name__ == "__main__":
    main()
