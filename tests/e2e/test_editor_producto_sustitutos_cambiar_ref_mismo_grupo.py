"""
tests/e2e/test_editor_producto_sustitutos_cambiar_ref_mismo_grupo.py — Editor de
Producto, pestaña Sustitutos: cambiar la referencia del grupo a OTRO MIEMBRO del
MISMO grupo, abriendo el buscador desde un producto que NO es la referencia
actual (un miembro común).

Bug real reportado por el usuario (21/10/2026), con captura: grupo de 4
("Bahia Choclo...", "Bonmar Choclo...", "Inca Choclo..." [referencia actual],
"La Campagnola Choclo..."). Desde el editor de "Bahia Choclo" (un miembro
cualquiera, NO la referencia), buscó "la campag" para elegir a "La
Campagnola..." como nueva referencia. En vez del diálogo esperado ("¿Pasa a
ser la referencia?"), apareció: "Ese producto ya pertenece a OTRO grupo —
¿Usar 'Inca Choclo...' [la referencia ACTUAL] como referencia en su lugar?"
— un callejón sin salida, porque esa es justo la referencia que se quería
reemplazar.

Causa: setReferencia() (editor-producto.js) sólo reconocía "R ya está en el
grupo de P" cuando P era LITERALMENTE la referencia formal del grupo
(G.referenciaRealDe(R) === P). Si P era un miembro común (como Bahia Choclo,
cuya propia referencia real es Inca Choclo), esa condición daba falso y el
código caía al caso pensado para grupos DISTINTOS ("R pertenece a otro
grupo"), con un diálogo que no tiene forma de llegar a "usar R como nueva
referencia".

Fix: la condición ahora compara la referencia real de P con la de R
(G.referenciaRealDe(P) === G.referenciaRealDe(R)), no "R apunta a P" —
cubre tanto "P es la referencia formal" (caso ya andaba) como "P es un
miembro común del mismo grupo que R" (el caso roto). migrarReferencia(P, R)
ya funcionaba para cualquier P del grupo (aplicarCambioReferencia lee la
referencia ACTUAL de P, no asume que P mismo sea la referencia), así que no
hizo falta tocar esa función.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_sustitutos_cambiar_ref_mismo_grupo.py
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
  const mk = (id, nombre) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`,
    [id, nombre, now, now, now]
  );
  // Grupo de 3: crm-ref es la referencia ACTUAL; crm-m1 y crm-m2 son miembros comunes.
  mk('crm-ref', 'CRM Choclo Referencia Actual');
  mk('crm-m1',  'CRM Choclo Miembro Uno');
  mk('crm-m2',  'CRM Choclo Miembro Dos Elegido');
  for (const [p, r] of [['crm-ref','crm-ref'], ['crm-m1','crm-ref'], ['crm-m2','crm-ref']]) {
    window.SGA_DB.run(
      `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
       VALUES (?, ?, ?, 1, ?)`, [p, r, r, now]
    );
  }
  return { ref: 'crm-ref', m1: 'crm-m1', m2: 'crm-m2' };
}
"""


def abrir_sustitutos(page, prod_id):
    page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.locator("[data-section='sustitutos']").first.click()
    page.wait_for_timeout(300)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        # setReferencia() muestra, ademas del dialogo propio (#sg-opciones), un
        # confirm() nativo de "vista previa" con los demas productos que tambien
        # cambian de referencia (previsualizar) -- hay que aceptarlo para que la
        # operacion se aplique.
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=False)
        ids = page.evaluate(SEMBRAR)

        print("--- Desde el editor de un MIEMBRO comun (no la referencia), elegir a OTRO miembro como nueva referencia ---")
        abrir_sustitutos(page, ids["m1"])
        panel_antes = page.locator("#ed-sustitutos-list").inner_text()
        assert "CRM Choclo Referencia Actual" in panel_antes, \
            f"Deberia mostrar la referencia actual del grupo: {panel_antes[:300]!r}"

        page.locator("#ed-btn-cambiar-ref").click()
        page.wait_for_timeout(150)
        page.fill("#ed-ref-search", "Miembro Dos Elegido")
        page.wait_for_timeout(300)
        page.locator("#ed-ref-dropdown .ed-search-result-item[data-id]").first.click()
        page.wait_for_timeout(300)

        dlg = page.locator("#sg-opciones")
        assert dlg.is_visible(), "Deberia aparecer un dialogo de confirmacion"
        msg = dlg.inner_text()
        print(f"Dialogo mostrado: {msg!r}")

        assert "ya pertenece a otro grupo" not in msg.lower(), (
            "BUG REGRESION: volvio a mostrar el dialogo de 'grupo distinto' "
            f"para dos productos que ya estan en el MISMO grupo: {msg!r}"
        )
        assert "Miembro Dos Elegido" in msg and "referencia" in msg.lower(), (
            f"El dialogo deberia ofrecer pasar la referencia al producto elegido: {msg!r}"
        )
        assert dlg.locator("[data-op='si']").count() == 1, \
            f"Deberia tener la opcion 'Si, cambiar la referencia': {msg!r}"
        print("OK - aparece el dialogo correcto (cambiar la referencia dentro del mismo grupo)")

        dlg.locator("[data-op='si']").click()
        page.wait_for_timeout(400)

        print("--- Los 3 miembros del grupo ahora apuntan al nuevo elegido (m2) ---")
        filas = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT producto_id, referencia_id FROM producto_sustitutos WHERE producto_id IN ('crm-ref','crm-m1','crm-m2') ORDER BY producto_id"
          )
        """)
        por_id = {f["producto_id"]: f["referencia_id"] for f in filas}
        assert por_id == {"crm-ref": "crm-m2", "crm-m1": "crm-m2", "crm-m2": "crm-m2"}, \
            f"Los 3 deberian apuntar a crm-m2 (incluida crm-m2 con fila propia ref->ref): {por_id}"
        print(f"OK - {por_id}")

        print("--- Los 3 quedaron pendientes de sync ---")
        pendientes = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT id, sync_status FROM productos WHERE id IN ('crm-ref','crm-m1','crm-m2')"
          )
        """)
        no_pending = [r for r in pendientes if r["sync_status"] != "pending"]
        assert not no_pending, f"BUG: no quedaron todos pendientes de sync: {no_pending}"
        print("OK")

        print("--- El panel de Sustitutos ahora muestra a m2 como la referencia ---")
        panel_despues = page.locator("#ed-sustitutos-list").inner_text()
        assert "CRM Choclo Miembro Dos Elegido" in panel_despues
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: cambiar la referencia a un miembro ya agrupado, desde OTRO miembro, funciona sin pasar por el dialogo de 'otro grupo' ===")
        browser.close()


if __name__ == "__main__":
    main()
