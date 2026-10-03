"""
tests/e2e/test_sustitutos_asociar_y_auditar.py — Paso 2 de la auditoría de sustitutos
(2/10/2026): nunca cambiar la referencia de un producto sin avisar, y poder auditar/reparar
datos viejos desde Informes.

Cubre:
1. Órdenes > Asociar sustituto: si el producto elegido ya pertenece a otro grupo, se muestra
   EXACTAMENTE qué productos cambian de referencia. Cancelar mantiene la actual (no escribe
   nada); aceptar cambia.
2. Editor de producto: si el producto ya es referencia de otros, "una referencia no puede
   apuntar a otro": se elige unir su grupo, agregar el otro a su grupo, o cancelar. Y si el
   producto elegido ya es miembro de su propio grupo, se pregunta si pasa a ser la referencia.
3. Informes > Grupos de Sustitutos > "Auditar integridad": con datos rotos a propósito
   (duplicado, ciclo, cadena, referencia eliminada, referencia sin fila propia, fila de un
   producto inexistente) cada problema se repara desde el panel y el chequeo queda limpio.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sustitutos_asociar_y_auditar.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const suc = window.SGA_DB.query(`SELECT id FROM sucursales LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];
  const mk = (id, nombre, stock) => {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
         es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at,
         proveedor_principal_id)
       VALUES (?, ?, 10, 20, 10, 'unidad', 0, 0, 1, ?, ?, 'synced', ?, ?)`, [id, nombre, now, now, now, prov.id]);
    window.SGA_DB.run(
      `INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, sync_status, updated_at)
       VALUES (?, ?, ?, 'synced', ?)`, [id, suc, stock, now]);
  };
  const fila = (prod, ref) => window.SGA_DB.run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
     VALUES (?, ?, ?, 1, ?)`, [prod, ref, ref, now]);

  // 1) Ordenes: ao-x suelto en la orden; ao-q2 es miembro del grupo ao-q1
  mk('ao-x', 'AO X suelto', 1); mk('ao-q1', 'AO Q1 referencia', 4); mk('ao-q2', 'AO Q2 miembro', 3);
  fila('ao-q1', 'ao-q1'); fila('ao-q2', 'ao-q1');
  window.SGA_DB.run(`INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
                     VALUES ('orden-ao', ?, ?, 'borrador', ?, 'pending', ?)`, [suc, prov.id, now, now]);
  window.SGA_DB.run(`INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado, stock_minimo)
                     VALUES ('it-ao-x', 'orden-ao', 'ao-x', 5, 'pendiente', 10)`);

  // 2) Editor: ao-p referencia de ao-pf; ao-libre suelto
  mk('ao-p', 'AO P referencia', 2); mk('ao-pf', 'AO PF seguidor', 2); mk('ao-libre', 'AO Libre', 1);
  fila('ao-p', 'ao-p'); fila('ao-pf', 'ao-p');
  // referencia IMPLICITA (sin fila propia) con un seguidor: ahi el editor muestra el buscador
  mk('ao-ip', 'AO IP referencia implicita', 2); mk('ao-ipf', 'AO IPF seguidor', 2);
  fila('ao-ipf', 'ao-ip');

  // 3) Datos rotos a proposito para la auditoria
  ['d1','dr1','dr2','c1','c2','h1','h2','h3','g1','g2','s1','s2'].forEach(x => mk('ao-' + x, 'AO ' + x, 1));
  fila('ao-dr1', 'ao-dr1'); fila('ao-dr2', 'ao-dr2');
  fila('ao-d1', 'ao-dr1'); fila('ao-d1', 'ao-dr2');                 // duplicado: d1 con dos referencias
  fila('ao-c1', 'ao-c2'); fila('ao-c2', 'ao-c1');                    // ciclo c1 <-> c2
  fila('ao-h1', 'ao-h2'); fila('ao-h2', 'ao-h3'); fila('ao-h3', 'ao-h3');   // cadena h1 -> h2 -> h3
  fila('ao-g1', 'ghost-ref'); fila('ao-g2', 'ghost-ref');            // referencia eliminada
  fila('ao-s1', 'ao-s2');                                            // s2 sin fila propia
  fila('ghost-prod', 'ao-s2');                                       // fila de un producto que ya no existe
  return { suc };
}
"""

REFS = """() => {
  const r = window.SGA_DB.query(`SELECT producto_id, referencia_id FROM producto_sustitutos
                                 WHERE producto_id LIKE 'ao-%' AND referencia_id IS NOT NULL ORDER BY producto_id`);
  const por = {};
  r.forEach(x => { (por[x.producto_id] = por[x.producto_id] || []).push(x.referencia_id); });
  return por;
}"""


def abrir_panel_orden(page, item_id, tecla):
    page.locator(f'tr[data-item-id="{item_id}"] td').nth(1).click()
    page.wait_for_timeout(150)
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(200)
    page.locator(f'tr[data-item-id="{item_id}"] [data-panel-acc="{tecla}"]').click()
    page.wait_for_timeout(300)


def abrir_sustitutos(page, pid):
    page.evaluate(f"window.location.hash = 'editor-producto/{pid}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)
    page.locator("[data-section='sustitutos']").first.click()
    page.wait_for_timeout(300)


def elegir_ref(page, texto):
    page.fill("#ed-ref-search", texto)
    page.wait_for_timeout(300)
    page.locator("#ed-ref-dropdown .ed-search-result-item[data-id]").first.click()
    page.wait_for_timeout(400)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        dlg = {"accept": True, "mensajes": []}

        def on_dialog(d):
            dlg["mensajes"].append(d.message)
            d.accept() if dlg["accept"] else d.dismiss()

        page.on("dialog", on_dialog)

        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)
        page.evaluate("window.location.hash = 'informes'")   # carga el motor
        page.wait_for_timeout(800)

        # ── 1) Ordenes: cambiar o mantener ────────────────────────────────────────────
        print("--- 1) Ordenes: asociar con un producto de OTRO grupo avisa que cambia y deja mantener ---")
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator('[data-abrir="orden-ao"]').click()
        page.wait_for_timeout(500)

        def asociar_x_con_q2():
            abrir_panel_orden(page, "it-ao-x", "sust")
            page.fill("#ord-sust-search", "AO Q2")
            page.wait_for_timeout(400)
            page.locator("[data-sust-pick='ao-q2']").click()
            page.wait_for_timeout(200)
            page.locator("#ord-sust-ref").select_option("ao-x")        # x pasa a ser la referencia
            page.locator("#ord-sust-ok").click()
            page.wait_for_timeout(500)

        dlg["accept"] = False
        dlg["mensajes"] = []
        asociar_x_con_q2()
        assert dlg["mensajes"], "Deberia avisar que productos ya tenian otra referencia"
        aviso = dlg["mensajes"][0]
        assert "AO Q2" in aviso and "AO Q1" in aviso and "ya tenían otra referencia" in aviso, aviso
        refs = page.evaluate(REFS)
        assert refs["ao-q2"] == ["ao-q1"] and refs["ao-q1"] == ["ao-q1"] and "ao-x" not in refs, \
            f"Cancelar (mantener la actual) no debe cambiar nada: {refs}"
        page.locator("#ord-sust-cancel").click()
        page.wait_for_timeout(300)
        print("OK - cancelar mantiene la referencia actual")

        dlg["accept"] = True
        asociar_x_con_q2()
        refs = page.evaluate(REFS)
        assert refs["ao-q2"] == ["ao-x"] and refs["ao-q1"] == ["ao-x"] and refs["ao-x"] == ["ao-x"], refs
        print("OK - aceptar cambia el grupo entero a la referencia elegida")

        # ── 2) Editor: una referencia no puede apuntar a otro producto ───────────────
        print("--- 2) Editor: P es referencia de otros -> unir / agregar / cancelar ---")
        dlg["accept"] = True
        abrir_sustitutos(page, "ao-p")
        elegir_ref(page, "AO Libre")
        d2 = page.locator("#sg-opciones")
        assert d2.is_visible(), "Deberia preguntar que hacer con el grupo de P"
        assert d2.locator("[data-op='unir']").count() == 1 and d2.locator("[data-op='agregar']").count() == 1
        d2.locator("[data-op='']").click()
        page.wait_for_timeout(300)
        assert "ao-libre" not in page.evaluate(REFS), "Cancelar no escribe nada"
        elegir_ref(page, "AO Libre")
        page.locator("#sg-opciones [data-op='agregar']").click()      # agregar AO Libre al grupo de P
        page.wait_for_timeout(500)
        refs = page.evaluate(REFS)
        assert refs["ao-libre"] == ["ao-p"] and refs["ao-p"] == ["ao-p"] and refs["ao-pf"] == ["ao-p"], refs
        print("OK - 'Agregar al grupo de P' deja a P como referencia y suma a AO Libre")

        print("--- 2b) Editor: elegir a alguien que ya es miembro de MI grupo = cambiar la referencia ---")
        abrir_sustitutos(page, "ao-ip")
        elegir_ref(page, "AO IPF")
        d3 = page.locator("#sg-opciones")
        assert d3.is_visible() and "ya es parte del grupo" in d3.inner_text(), "Deberia preguntar si pasa a ser la referencia"
        d3.locator("[data-op='si']").click()
        page.wait_for_timeout(500)
        refs = page.evaluate(REFS)
        assert refs["ao-ipf"] == ["ao-ipf"] and refs["ao-ip"] == ["ao-ipf"], refs
        print("OK - AO IPF pasa a ser la referencia, AO IP sigue en el grupo")

        # ── 3) Auditoria con datos rotos ──────────────────────────────────────────────
        print("--- 3) Auditar integridad: detecta y repara cada tipo de problema ---")
        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_timeout(800)
        page.locator("#inf-sel-reporte").select_option(label="Grupos de Sustitutos")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(700)
        d0 = page.evaluate("window.SGA_GruposSustitutos.diagnosticar()")
        assert d0["duplicados"] and d0["ciclos"] and d0["cadenas"] and d0["inexistentes"] and d0["sinFilaPropia"], d0

        page.locator("#inf-btn-auditar").click()
        page.wait_for_timeout(400)
        aud = page.locator("#inf-sust-auditoria")
        assert aud.is_visible()
        texto = aud.inner_text()
        for clave in ("Reparación automática", "Referencia que ya no existe", "más de una referencia", "Cadenas", "Ciclos"):
            assert clave in texto, f"Falta la seccion '{clave}': {texto[:500]}"

        aud.locator("[data-aud='auto']").click()
        page.wait_for_timeout(300)
        aud.locator("[data-aud='fantasma']").first.click()
        page.wait_for_timeout(300)
        aud.locator("[data-aud='dup']").first.click()
        page.wait_for_timeout(300)
        aud.locator("[data-aud='cadena']").first.click()
        page.wait_for_timeout(300)
        d1 = page.evaluate("window.SGA_GruposSustitutos.diagnosticar()")
        assert not (d1["duplicados"] or d1["cadenas"] or d1["inexistentes"] or d1["sinFilaPropia"]), d1
        assert d1["ciclos"], "Queda el ciclo: requiere elegir la referencia"

        # el ciclo se resuelve con "Resolver…" (abre el editor de grupo: elegir la referencia)
        aud.locator("[data-aud='editar']").first.click()
        page.wait_for_timeout(400)
        editor = page.locator("#inf-sust-editor")
        assert editor.is_visible(), "Resolver... deberia abrir el editor del grupo"
        editor.locator("#sg-confirmar").click()
        page.wait_for_timeout(500)
        d2 = page.evaluate("window.SGA_GruposSustitutos.diagnosticar()")
        assert d2["ok"], f"Despues de reparar todo, el chequeo tiene que dar limpio: {d2}"

        page.locator("#inf-btn-auditar").click()
        page.wait_for_timeout(300)
        assert "Todo en orden" in page.locator("#inf-sust-auditoria").inner_text()
        print("OK - todos los problemas reparados; la auditoria dice 'Todo en orden'")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: asociar con aviso y auditar/reparar grupos de sustitutos ===")
        browser.close()


if __name__ == "__main__":
    main()
