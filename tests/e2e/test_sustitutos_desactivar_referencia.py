"""
tests/e2e/test_sustitutos_desactivar_referencia.py — Desactivar un producto que es
la REFERENCIA de un grupo de sustitutos.

Pedido del dueño (2/10/2026): la orden de compra le pide siempre a la referencia
y descarta el grupo entero si esa referencia está inactiva, así que desactivarla
deja a todo el grupo sin pedirse en silencio. Ahora, al desactivar (editor de
producto, edición rápida de Productos, "Discontinuar"), si es referencia de un
grupo se avisa y se sugiere migrar la referencia a otro miembro activo.

Además se eliminó el toggle "Activo" por miembro de la pestaña Sustitutos (no
afectaba stock ni reposición), y el reporte Informes > Grupos de Sustitutos marca
como problema a los grupos cuya referencia ya está inactiva.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sustitutos_desactivar_referencia.py
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
  const mk = (id, nombre, stock) => {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
         es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
       VALUES (?, ?, 10, 20, 5, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`, [id, nombre, now, now, now]);
    window.SGA_DB.run(
      `INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, sync_status, updated_at)
       VALUES (?, ?, ?, 'synced', ?)`, [id, suc, stock, now]);
  };
  const grupo = (ref, miembros) => {
    [ref, ...miembros].forEach(p => window.SGA_DB.run(
      `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
       VALUES (?, ?, ?, 1, ?)`, [p, ref, ref, now]));
  };
  // grupo 1: da-r1 (ref) con da-m1 (stock 5) y da-m2 (stock 1)
  mk('da-r1', 'DA R1 referencia', 2); mk('da-m1', 'DA M1 miembro stock 5', 5); mk('da-m2', 'DA M2 miembro stock 1', 1);
  grupo('da-r1', ['da-m1', 'da-m2']);
  // grupo 2: da-r2 (ref) con un unico miembro INACTIVO
  mk('da-r2', 'DA R2 referencia', 0); mk('da-m3', 'DA M3 miembro inactivo', 0);
  grupo('da-r2', ['da-m3']);
  window.SGA_DB.run(`UPDATE productos SET activo = 0 WHERE id = 'da-m3'`);
  // grupo 3 para el reporte: referencia YA inactiva
  mk('da-r3', 'DA R3 referencia inactiva', 0); mk('da-m4', 'DA M4 miembro stock 2', 2); mk('da-m5', 'DA M5 miembro stock 9', 9);
  grupo('da-r3', ['da-m4', 'da-m5']);
  window.SGA_DB.run(`UPDATE productos SET activo = 0 WHERE id = 'da-r3'`);
  // grupo 5: referencia pausada que se discontinua desde el listado de Productos
  mk('da-r5', 'DA R5 discontinuar', 0); mk('da-m7', 'DA M7 miembro', 7);
  grupo('da-r5', ['da-m7']);
  window.SGA_DB.run(`UPDATE productos SET pausa_reposicion = 1, pausa_reposicion_motivo = 'x', pausa_reposicion_desde = ? WHERE id = 'da-r5'`, [now]);
  // grupo 6: referencia que se ELIMINA desde el listado de Productos (Admin-POS)
  mk('da-r6', 'DA R6 eliminar', 1); mk('da-m8', 'DA M8 miembro', 6); mk('da-m9', 'DA M9 miembro', 2);
  grupo('da-r6', ['da-m8', 'da-m9']);
  // un producto cualquiera sin grupo
  mk('da-libre', 'DA Libre', 3);
}
"""

REFS = """() => {
  const r = window.SGA_DB.query(`SELECT producto_id, referencia_id FROM producto_sustitutos
                                 WHERE producto_id LIKE 'da-%' AND referencia_id IS NOT NULL ORDER BY producto_id`);
  const por = {};
  r.forEach(x => { (por[x.producto_id] = por[x.producto_id] || []).push(x.referencia_id); });
  return por;
}"""


def activo(page, pid):
    return page.evaluate(f"window.SGA_DB.query(`SELECT activo FROM productos WHERE id='{pid}'`)[0].activo")


def abrir_editor(page, pid):
    page.evaluate(f"window.location.hash = 'editor-producto/{pid}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)


def desactivar_y_guardar(page):
    page.evaluate("""() => {
      const c = document.getElementById('ed-activo');
      c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    page.locator("#ed-btn-save").click()
    page.wait_for_timeout(400)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)
        # cargar el motor (lo importan informes / editor)
        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_timeout(800)

        print("--- Un producto que NO es referencia se desactiva sin avisos ---")
        abrir_editor(page, "da-libre")
        desactivar_y_guardar(page)
        assert page.locator("#sg-desactivar-ref").count() == 0, "No es referencia: no debe avisar"
        assert activo(page, "da-libre") == 0
        print("OK")

        print("--- Referencia con miembros activos: avisa, sugiere al de mas stock ---")
        abrir_editor(page, "da-r1")
        desactivar_y_guardar(page)
        dlg = page.locator("#sg-desactivar-ref")
        assert dlg.is_visible(), "Deberia avisar que es la referencia de un grupo"
        assert "DA R1 referencia" in dlg.inner_text()
        assert dlg.locator("input[name='sg-nueva-ref']").count() == 2, "Dos miembros activos para migrar"
        assert dlg.locator("input[name='sg-nueva-ref']:checked").get_attribute("value") == "da-m1", \
            "Debe sugerir al de mayor stock"
        print("OK")

        print("--- Escape cancela solo el aviso: el producto sigue activo y en su grupo ---")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        assert page.locator("#sg-desactivar-ref").count() == 0
        assert activo(page, "da-r1") == 1, "Cancelar no debe desactivar"
        assert page.evaluate(REFS)["da-m1"] == ["da-r1"], "Cancelar no debe migrar nada"
        print("OK")

        print("--- Migrar y desactivar ---")
        desactivar_y_guardar(page)
        page.locator("#sg-dr-migrar").click()
        page.wait_for_timeout(600)
        assert activo(page, "da-r1") == 0, "Tras migrar, el producto queda desactivado"
        refs = page.evaluate(REFS)
        assert refs.get("da-m1") == ["da-m1"] and refs.get("da-m2") == ["da-m1"], refs
        # Desactivar NO lo saca del grupo (regla del dueño): su stock sigue contando para no pedir de mas
        assert refs.get("da-r1") == ["da-m1"], f"El producto desactivado sigue en el grupo: {refs}"
        pend = page.evaluate("window.SGA_DB.query(\"SELECT sync_status FROM productos WHERE id='da-m2'\")[0].sync_status")
        assert pend == "pending", pend
        total = page.evaluate("""() => window.SGA_GruposSustitutos.stockDelGrupo('da-m2',
            window.SGA_DB.query('SELECT id FROM sucursales LIMIT 1')[0].id)""")
        assert total == 8, f"El stock del producto desactivado sigue sumando (2 + 5 + 1 = 8): {total}"
        print("OK")

        print("--- Sin otros miembros activos: avisa y no ofrece migrar ---")
        abrir_editor(page, "da-r2")
        desactivar_y_guardar(page)
        dlg = page.locator("#sg-desactivar-ref")
        assert dlg.is_visible()
        assert dlg.locator("#sg-dr-migrar").count() == 0, "No hay a quien migrar"
        assert "No quedan otros productos activos" in dlg.inner_text()
        dlg.locator("#sg-dr-sin").click()
        page.wait_for_timeout(400)
        assert activo(page, "da-r2") == 0, "'Desactivar sin migrar' desactiva igual"
        print("OK")

        print("--- Pestaña Sustitutos: ya no hay toggle 'Activo' por miembro ---")
        abrir_editor(page, "da-m1")
        page.locator("[data-section='sustitutos']").first.click()
        page.wait_for_timeout(300)
        assert page.locator(".ed-sust-toggle").count() == 0
        assert "Activo" not in page.locator("#ed-sustitutos-list").inner_text()
        print("OK")

        print("--- Informes: grupo con referencia inactiva se marca y se puede migrar ---")
        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_timeout(800)
        page.locator("#inf-sel-reporte").select_option(label="Grupos de Sustitutos")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(600)
        fila = page.locator(".inf-table tbody tr", has=page.locator("td", has_text="DA R3 referencia inactiva")).first
        assert "inactiva" in fila.inner_text(), fila.inner_text()
        fila.locator(".inf-btn-editar-grupo").click()
        page.wait_for_timeout(300)
        editor = page.locator("#inf-sust-editor")
        assert editor.is_visible()
        assert editor.locator(".sg-ref:checked").get_attribute("value") == "da-m5", \
            "Debe sugerir al activo con mas stock, no a la referencia inactiva"
        assert "(inactivo)" in editor.inner_text()
        editor.locator("#sg-confirmar").click()
        page.wait_for_timeout(500)
        refs = page.evaluate(REFS)
        assert refs.get("da-m4") == ["da-m5"] and refs.get("da-m5") == ["da-m5"], refs
        print("OK")

        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_timeout(800)

        print("--- Productos: 'Discontinuar' desde un pausado tambien avisa ---")
        page.fill("#search-productos", "DA R5")
        page.wait_for_timeout(700)
        page.locator("[data-pausa='da-r5']").first.click()
        page.wait_for_timeout(300)
        page.locator("#btn-pausa-discontinuar").click()
        page.wait_for_timeout(400)
        assert page.locator("#sg-desactivar-ref").is_visible(), "Discontinuar deberia avisar"
        page.locator("#sg-dr-cancelar").click()
        page.wait_for_timeout(300)
        assert activo(page, "da-r5") == 1, "Cancelar no discontinua"
        page.locator("#btn-pausa-discontinuar").click()
        page.wait_for_timeout(400)
        page.locator("#sg-dr-quitar").check()      # casilla opcional: sacarlo tambien del grupo
        page.locator("#sg-dr-migrar").click()
        page.wait_for_timeout(600)
        assert activo(page, "da-r5") == 0
        refs = page.evaluate(REFS)
        assert refs.get("da-m7") == ["da-m7"] and "da-r5" not in refs, f"Con la casilla marcada, sale del grupo: {refs}"
        print("OK")

        print("--- Editor: la referencia no se puede quitar; se cambia primero y recien despues se quita ---")
        abrir_editor(page, "da-m1")      # da-m1 es ahora la referencia (con da-m2 y da-r1 inactivo)
        page.locator("[data-section='sustitutos']").first.click()
        page.wait_for_timeout(300)
        assert page.locator("#ed-btn-quitar-grupo").is_disabled(), "Quitar del grupo debe estar bloqueado en la referencia"
        page.locator("#ed-btn-cambiar-ref-miembro").click()
        page.wait_for_timeout(300)
        dlg = page.locator("#sg-desactivar-ref")
        assert dlg.is_visible()
        assert "Cambiar la referencia" in dlg.inner_text()
        assert dlg.locator("input[name='sg-nueva-ref']").count() == 2, "Aparecen todos los miembros (activos e inactivo)"
        dlg.locator("input[name='sg-nueva-ref'][value='da-m2']").check()
        dlg.locator("#sg-dr-migrar").click()
        page.wait_for_timeout(500)
        refs = page.evaluate(REFS)
        assert refs.get("da-m1") == ["da-m2"] and refs.get("da-m2") == ["da-m2"] and refs.get("da-r1") == ["da-m2"], refs
        # ahora da-m1 es un miembro mas: ya se lo puede quitar y su stock vuelve a contar solo
        abrir_editor(page, "da-m1")
        page.locator("[data-section='sustitutos']").first.click()
        page.wait_for_timeout(300)
        page.locator("#ed-btn-quitar-grupo").click()
        page.wait_for_timeout(400)
        refs = page.evaluate(REFS)
        assert "da-m1" not in refs, f"Despues de cambiar la referencia ya se pudo quitar: {refs}"
        print("OK")

        print("--- Eliminar (Admin-POS): una referencia obliga a elegir la nueva; un miembro sale del grupo ---")
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_timeout(800)
        page.fill("#search-productos", "DA R6")
        page.wait_for_timeout(700)
        page.locator(".btn-delete-product[data-id='da-r6']").click()
        page.wait_for_timeout(400)
        dlg = page.locator("#sg-desactivar-ref")
        assert dlg.is_visible(), "Eliminar una referencia debe pedir la nueva referencia"
        assert dlg.locator("#sg-dr-sin").count() == 0, "No hay 'sin migrar' al eliminar: es obligatorio"
        page.locator("#sg-dr-cancelar").click()
        page.wait_for_timeout(300)
        assert page.evaluate("window.SGA_DB.query(\"SELECT COUNT(*) AS n FROM productos WHERE id='da-r6'\")[0].n") == 1, "Cancelar no elimina"
        page.locator(".btn-delete-product[data-id='da-r6']").click()
        page.wait_for_timeout(400)
        page.locator("#sg-dr-migrar").click()
        page.wait_for_timeout(600)
        assert page.evaluate("window.SGA_DB.query(\"SELECT COUNT(*) AS n FROM productos WHERE id='da-r6'\")[0].n") == 0
        refs = page.evaluate(REFS)
        assert "da-r6" not in refs and refs.get("da-m8") == ["da-m8"] and refs.get("da-m9") == ["da-m8"], refs
        d = page.evaluate("window.SGA_GruposSustitutos.diagnosticar()")
        assert d["ok"] or not d["inexistentes"], f"No debe quedar ninguna referencia inexistente: {d}"
        # un miembro simple: se borra y sale del grupo sin dialogo
        page.fill("#search-productos", "DA M9")
        page.wait_for_timeout(700)
        page.locator(".btn-delete-product[data-id='da-m9']").click()
        page.wait_for_timeout(500)
        assert page.locator("#sg-desactivar-ref").count() == 0, "Un miembro no pide elegir referencia"
        assert "da-m9" not in page.evaluate(REFS)
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: desactivar la referencia de un grupo de sustitutos ===")
        browser.close()


if __name__ == "__main__":
    main()
