"""
tests/e2e/test_editor_producto_sustitutos_agregar_a_referencia.py — Editor de
producto, pestaña Sustitutos: agregar productos que apunten al producto abierto.

Bug real (2/10/2026): un producto que es referencia "implícita" de otros (otros
le apuntan, pero él no tiene fila propia en producto_sustitutos) mostraba
"Sin grupo de sustitutos asignado" y NO mostraba el campo "Agregar miembro al
grupo" (solo se dibujaba con fila propia). Desde esa pantalla no había forma de
sumarle productos. Mismo problema para un producto sin ningún grupo.

Cubre:
1. Referencia implícita: el cartel lo dice bien, aparece el campo y agregar un
   producto libre lo deja apuntando a él, sin perder a los seguidores previos.
2. Agregar un MIEMBRO COMÚN de otro grupo lo mueve solo a él, SIN avisar ni arrastrar
   al resto de su grupo viejo (bug real reportado por el usuario, 3/11/2026: antes
   `addMiembroGrupo` usaba `aplicarCambioReferencia`, pensada para mover un GRUPO
   ENTERO — mover un miembro común de otro grupo arrastraba también a todos sus ex
   compañeros, cuando el usuario solo quería mover ese uno. El fix usa
   `GruposSustitutos.moverMiembro`, la función ya construida para Importación).
2b. Agregar un producto que es A SU VEZ referencia de otros sí avisa (cancelable) —
    ahí no hay forma de moverlo solo, sus seguidores quedarían huérfanos.
3. Producto sin grupo: agregar un miembro lo arma con ese producto de referencia.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_sustitutos_agregar_a_referencia.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def abrir_sustitutos(page, prod_id):
    page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.locator("[data-section='sustitutos']").first.click()
    page.wait_for_timeout(300)


def agregar(page, texto):
    page.fill("#ed-sustituto-search", texto)
    page.wait_for_timeout(300)
    page.locator("#ed-sustituto-dropdown .ed-search-result-item[data-id]").first.click()
    page.wait_for_timeout(400)


def refs(page):
    return page.evaluate("""() => Object.fromEntries(
      window.SGA_DB.query(`SELECT producto_id, referencia_id FROM producto_sustitutos
                           WHERE producto_id LIKE 'ar-%' AND referencia_id IS NOT NULL`)
        .map(r => [r.producto_id, r.referencia_id]))""")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        dlg = {"accept": True, "messages": []}

        def on_dialog(d):
            dlg["messages"].append(d.message)
            d.accept() if dlg["accept"] else d.dismiss()

        page.on("dialog", on_dialog)

        login_via_seed(page, admin_pos=False)
        page.evaluate("""() => {
          const now = new Date().toISOString();
          const mk = (id, nombre) => window.SGA_DB.run(
            `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
               es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
             VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`, [id, nombre, now, now, now]);
          const sust = (prod, ref) => window.SGA_DB.run(
            `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
             VALUES (?, ?, ?, 1, ?)`, [prod, ref, ref, now]);
          mk('ar-bic',   'ARtest Bic Mujer');        // referencia implicita
          mk('ar-maq',   'ARtest Bic Maquina x2');   // ya le apunta a ar-bic
          mk('ar-libre', 'ARtest Producto Libre');   // sin grupo
          mk('ar-solo',  'ARtest Producto Solo');    // sin grupo, va a ser referencia nueva
          mk('ar-ajena', 'ARtest Ajena Ref');        // referencia de otro grupo...
          mk('ar-ajeno', 'ARtest Ajeno Miembro');    // ...y su miembro COMUN (nadie le apunta a el)
          mk('ar-ajena2', 'ARtest Ajena2 Ref');      // otra referencia, CON seguidor propio...
          mk('ar-ajeno2', 'ARtest Ajeno2 Miembro');  // ...que se arrastraria si se mueve ar-ajena2
          mk('ar-nuevo', 'ARtest Nuevo Miembro');
          sust('ar-maq', 'ar-bic');
          sust('ar-ajena', 'ar-ajena');
          sust('ar-ajeno', 'ar-ajena');
          sust('ar-ajena2', 'ar-ajena2');
          sust('ar-ajeno2', 'ar-ajena2');
        }""")

        print("--- 1) Referencia implicita: cartel correcto + campo para agregar ---")
        abrir_sustitutos(page, "ar-bic")
        texto = page.locator("#ed-sustitutos-list").inner_text()
        assert "Sin grupo de sustitutos asignado" not in texto, f"No deberia decir 'Sin grupo': {texto[:300]!r}"
        assert "es la referencia de otros productos" in texto, texto[:300]
        assert page.locator("#ed-sustituto-search").is_visible(), "Falta el campo para agregar productos"

        agregar(page, "Producto Libre")
        r = refs(page)
        assert r.get("ar-libre") == "ar-bic", f"El producto libre deberia apuntar a Bic: {r}"
        assert r.get("ar-maq") == "ar-bic", f"El seguidor previo no se pierde: {r}"
        assert r.get("ar-bic") == "ar-bic", f"Bic queda con fila propia (referencia del grupo): {r}"
        lista = page.locator("#ed-sustitutos-list").inner_text()
        assert "ARtest Producto Libre" in lista and "ARtest Bic Maquina x2" in lista, lista
        print("OK")

        print("--- 2) Agregar un MIEMBRO COMUN de otro grupo lo mueve SOLO a el, sin avisar ni arrastrar ---")
        dlg["messages"] = []
        agregar(page, "Ajeno Miembro")
        assert not dlg["messages"], f"No deberia avisar nada: es un miembro comun, se puede mover solo: {dlg['messages']}"
        r = refs(page)
        assert r.get("ar-ajeno") == "ar-bic", f"Deberia moverse al grupo de Bic: {r}"
        assert r.get("ar-ajena") == "ar-ajena", f"BUG: no deberia arrastrar a su referencia vieja: {r}"
        print("OK")

        print("--- 2b) Agregar un producto que ES referencia de otros si avisa (cancelable) ---")
        dlg["accept"] = False
        dlg["messages"] = []
        agregar(page, "Ajena2 Ref")
        assert dlg["messages"], "Deberia haber avisado que arrastra a sus seguidores"
        assert "ARtest Ajeno2 Miembro" in dlg["messages"][0], dlg["messages"][0]
        assert refs(page).get("ar-ajena2") == "ar-ajena2", "Cancelar no debe mover nada"
        dlg["accept"] = True
        agregar(page, "Ajena2 Ref")
        r = refs(page)
        assert r.get("ar-ajena2") == "ar-bic", f"Al confirmar, se mueve al grupo de Bic: {r}"
        assert r.get("ar-ajeno2") == "ar-bic", f"Arrastra a su seguidor (no se puede dejar huerfano): {r}"
        print("OK")

        print("--- 3) Producto sin grupo: agregar un miembro lo arma con el como referencia ---")
        abrir_sustitutos(page, "ar-solo")
        assert "Sin grupo de sustitutos asignado" in page.locator("#ed-sustitutos-list").inner_text()
        assert "queda como referencia" in page.locator("#ed-sustitutos-list").inner_text()
        agregar(page, "Nuevo Miembro")
        r = refs(page)
        assert r.get("ar-nuevo") == "ar-solo" and r.get("ar-solo") == "ar-solo", r
        pend = page.evaluate("window.SGA_DB.query(\"SELECT sync_status FROM productos WHERE id='ar-nuevo'\")[0].sync_status")
        assert pend == "pending", f"El cambio tiene que marcarse para sincronizar: {pend}"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: agregar productos a la referencia desde el editor ===")
        browser.close()


if __name__ == "__main__":
    main()
