"""
tests/e2e/test_informes_quiebres_stock.py — Informes -> Quiebres de Stock: cuántas veces se llegó a 0.

Pedido del dueño (27/11/2026): reemplazar "pedido y no recibido" por quiebres reales (stock en 0 o
menos), contados sobre el registro de movimientos, con los grupos de sustitutos en un solo renglón.

El escenario carga movimientos con fechas fijas (relativas a hoy) y verifica:
 A. veces que quebró, días que terminaron sin stock y racha; quiebre y reposición el mismo día.
 B. "venía sin stock" (no cuenta como quiebre del período).
 C. grupo: un renglón (referencia) en negrita, quiebra por la SUMA; detalle por producto; Escape.
 D. negativos: no se toman como 0 y marcan "revisar stock".
 E. pausados: etiqueta y filtro (también en el export). Inactivos y productos nuevos sin stock: fuera.
 F. veces pedido / recibido: órdenes no borrador; remito facturado no cuenta doble.
 G. aviso de historial cuando el rango empieza antes del primer movimiento.

Correr (server en :8765):  python tests/e2e/test_informes_quiebres_stock.py
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
  const dia = (n, h = 12) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const fecha = (n) => { const d = new Date(); d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const ins = (t, o) => db.run(`INSERT INTO ${t} (${Object.keys(o)}) VALUES (${Object.keys(o).map(() => '?')})`, Object.values(o));
  // historial limpio: el escenario define todos los movimientos
  db.run('DELETE FROM stock_movimientos'); db.run('DELETE FROM stock'); db.run('DELETE FROM producto_sustitutos');
  db.run("UPDATE productos SET activo = 0");

  let n = 0;
  const producto = (id, nombre, movs, extra = {}) => {
    ins('productos', Object.assign({ id, nombre, activo: 1, costo: 1, precio_venta: 2, stock_minimo: 2, fecha_alta: dia(60) }, extra));
    let total = 0;
    for (const [hace, delta, hora] of movs) {
      total += delta;
      const inicial = hace === 20;
      ins('stock_movimientos', { id: inicial ? `saldo_inicial:${id}:${suc}` : `m${++n}`, producto_id: id, sucursal_id: suc,
        delta, tipo: inicial ? 'saldo_inicial' : 'ajuste', fecha: dia(hace, hora || 12) });
    }
    ins('stock', { producto_id: id, sucursal_id: suc, cantidad: total });
  };
  // A: 5 -> 0 (hace 15) -> repone (hace 12) -> 0 y repone el mismo dia (hace 8) -> 0 (hace 2) y sigue
  producto('qa', 'Q Alfa', [[20, 5], [15, -5], [12, 4], [8, -4, 9], [8, 3, 18], [2, -3]]);
  // B: arranca el historial en 0 (sin saldo inicial), repone hace 18 y nunca vuelve a quebrar
  producto('qb', 'Q Beta', [[18, 6]]);
  // grupo: referencia en 0 desde hace 10 pero el sustituto cubre hasta hace 4
  producto('qg1', 'Q Grupo Ref', [[20, 2], [10, -2]]);
  producto('qg2', 'Q Grupo Sust', [[20, 3], [4, -3]]);
  window.SGA_GruposSustitutos.definirGrupo({ miembros: ['qg1', 'qg2'], referenciaId: 'qg1', involucrados: ['qg1', 'qg2'] });
  // D: grupo con negativo: -5 + 3 = -2 (quiebre, a revisar)
  producto('qn1', 'Q Neg Ref', [[20, 1], [6, -6]]);
  producto('qn2', 'Q Neg Otro', [[20, 3]]);
  window.SGA_GruposSustitutos.definirGrupo({ miembros: ['qn1', 'qn2'], referenciaId: 'qn1', involucrados: ['qn1', 'qn2'] });
  // E
  producto('qp', 'Q Pausado', [[20, 1], [5, -1]], { pausa_reposicion: 1 });
  producto('qi', 'Q Inactivo', [[20, 1], [5, -1]], { activo: 0 });
  producto('qnuevo', 'Q Nuevo', [], { fecha_alta: dia(3) });
  producto('qok', 'Q Con Stock', [[20, 9]]);

  // F: 3 ordenes (una borrador); entregas: un remito facturado (compra repite el producto) y una compra
  const oc = (id, hace, estado, prod) => { ins('ordenes_compra', { id, sucursal_id: suc, fecha_creacion: dia(hace), estado });
    ins('orden_compra_items', { id: 'i' + id, orden_id: id, producto_id: prod, cantidad_pedida: 6 }); };
  oc('o1', 14, 'enviada', 'qa'); oc('o2', 7, 'cerrada', 'qa'); oc('o3', 1, 'borrador', 'qa'); oc('o4', 9, 'enviada', 'qg2');
  const compra = (id, hace, prods, estado = 'confirmada') => { ins('compras', { id, sucursal_id: suc, fecha: fecha(hace), total: 1, estado });
    prods.forEach((p, i) => ins('compra_items', { id: id + i, compra_id: id, producto_id: p, cantidad: 4 })); };
  compra('c1', 12, ['qa']); compra('c2', 11, ['qa']);   // c2 factura al remito r1
  ins('remitos', { id: 'r1', sucursal_id: suc, fecha: fecha(12), estado: 'facturado', compra_id: 'c2' });
  ins('remito_items', { id: 'ri1', remito_id: 'r1', producto_id: 'qa', cantidad: 4 });
  compra('c3', 5, ['qa'], 'anulada');
  compra('c4', 3, ['qg2']);
  return { desde: fecha(40), desdeCorto: fecha(7), hasta: fecha(0) };
}"""


def generar(page, desde, hasta):
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(250)
    page.evaluate("window.location.hash = 'informes'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.select_option("#inf-sel-reporte", "quiebres_stock")
    page.fill("#inf-desde", desde)
    page.fill("#inf-hasta", hasta)
    page.locator("#inf-btn-generar").click()
    page.wait_for_timeout(700)


def fila(page, pid):
    tr = page.locator(f"#inf-q-tabla tr[data-q-fila='{pid}']")
    if not tr.count():
        return None
    t = [x.strip() for x in tr.locator("td").all_inner_texts()]
    claves = ("veces", "dias", "racha", "stock", "minimo", "pedido", "recibido")
    return dict(zip(claves, t[3:]), nombre=t[1], clase=tr.get_attribute("class") or "")


def numeros(f):
    return (f["veces"], f["dias"], f["racha"], f["stock"], f["pedido"], f["recibido"])


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_timeout(500)
        f = page.evaluate(SEMBRAR)
        generar(page, f["desde"], f["hasta"])
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informe_quiebres.png"), full_page=True)

        a = fila(page, "qa")
        # veces: hace 15, hace 8, hace 2. dias al cierre: 15,14,13 (3) + hace 2, 1 y hoy (3)
        assert a and numeros(a) == ("3", "6", "3", "0", "2", "2"), f"A/F: {a}"
        assert "Venía sin stock" not in a["nombre"]
        print("OK - veces, dias, racha, pedido y recibido")

        b = fila(page, "qb")
        assert b and b["veces"] == "0" and b["dias"] == "2" and "Venía sin stock" in b["nombre"], f"B: {b}"
        print("OK - venia sin stock")

        g = fila(page, "qg1")
        assert g and fila(page, "qg2") is None, f"C: el grupo es un solo renglon: {g}"
        assert numeros(g) == ("1", "5", "5", "0", "1", "1") and "inf-q-grupo" in g["clase"], f"C: {g}"
        page.locator("tr[data-q-fila='qg1'] button[data-q-col='dias']").click()
        modal = page.locator("#inf-q-overlay")
        assert modal.is_visible()
        filas = modal.locator("tbody tr").all_inner_texts()
        assert len(filas) == 2 and any("Q Grupo Sust" in x for x in filas), filas
        ref = modal.locator("tbody tr", has_text="Q Grupo Ref").locator("td").all_inner_texts()
        assert [x.strip() for x in ref[1:4]] == ["1", "11", "11"], f"Detalle de la referencia: {ref}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "informe_quiebres_detalle.png"))
        page.keyboard.press("Escape")
        assert page.locator("#inf-q-overlay").count() == 0, "Escape no cierra el detalle"
        print("OK - grupo y detalle")

        neg = fila(page, "qn1")
        assert neg and neg["stock"] == "-2" and neg["veces"] == "1" and "Revisar stock" in neg["nombre"], f"D: {neg}"
        print("OK - negativos")

        pa = fila(page, "qp")
        assert pa and "PAUSADO" in pa["nombre"], f"E: {pa}"
        for fuera in ("qi", "qnuevo", "qok"):
            assert fila(page, fuera) is None, f"E: {fuera} no deberia figurar"
        page.locator("#inf-q-pausados").check()
        page.wait_for_timeout(300)
        assert fila(page, "qp") is None and fila(page, "qa"), "El filtro de pausados no funciona"
        with page.expect_download() as d:
            page.locator("#inf-btn-csv").click()
        csv = open(d.value.path(), encoding="utf-8-sig").read()
        assert "Q Alfa" in csv and "Q Pausado" not in csv, "El export no respeta el filtro"
        page.locator("#inf-q-pausados").uncheck()
        page.wait_for_timeout(300)
        assert fila(page, "qp")
        print("OK - pausados, inactivos y nuevos")

        assert page.locator(".inf-q-aviso").is_visible(), "G: falta el aviso de inicio del historial"
        generar(page, f["desdeCorto"], f["hasta"])
        assert page.locator(".inf-q-aviso").count() == 0
        a = fila(page, "qa")
        # desde hace 7 dias: ya con stock; quiebra hace 2
        assert a and (a["veces"], a["dias"]) == ("1", "3"), f"Rango corto: {a}"
        g = fila(page, "qn1")
        assert g and g["veces"] == "1", g
        generar(page, f["desdeCorto"], f["hasta"])
        print("OK - historial y rango corto")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_informes_quiebres_stock")


if __name__ == "__main__":
    main()
