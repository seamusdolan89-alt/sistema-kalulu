"""
tests/e2e/test_ordenes_sustitutos_grupos.py — Revisión de una Orden de Compra:
"Asociar sustituto" (tecla S) y "Pausar reposición" (tecla X) sobre grupos de
sustitutos.

Es un test de CARACTERIZACIÓN: se escribió contra el código viejo de Órdenes
(que tenía su propia lógica de grupos) antes de pasarlo al motor compartido
(js/modules/grupos_sustitutos.js), para comprobar que el comportamiento no
cambia — y que no quedan cadenas rotas, filas duplicadas ni referencias sin fila.

Cubre:
1. Asociar dos productos sueltos: el que se abrió deja de ser referencia -> sale
   de la orden; el grupo queda con una sola referencia (con fila propia).
2. Asociar un producto que es referencia IMPLÍCITA de otros (nadie lo asignó, pero
   le apuntan): sus seguidores no pueden quedar apuntando a un intermediario.
3. Pausar la referencia de un grupo y migrarla a otro miembro: todo el grupo pasa
   a la referencia nueva y cada producto queda con UNA sola fila.
4. El stock efectivo de un grupo suma TODOS sus miembros, referencia incluida.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_sustitutos_grupos.py
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
       VALUES (?, ?, 10, 20, 10, 'unidad', 0, 0, 1, ?, ?, ?, ?, ?)`, [id, nombre, now, now, 'synced', now, prov.id]);
    window.SGA_DB.run(
      `INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, sync_status, updated_at)
       VALUES (?, ?, ?, 'synced', ?)`, [id, suc, stock, now]);
  };
  // 1) dos sueltos
  mk('os-a1', 'OS A1 suelto', 1);  mk('os-a2', 'OS A2 suelto', 2);
  // 2) referencia implicita: os-b1 no tiene fila, os-b2 le apunta; os-b3 es libre
  mk('os-b1', 'OS B1 ref implicita', 4); mk('os-b2', 'OS B2 seguidor', 3); mk('os-b3', 'OS B3 libre', 1);
  window.SGA_DB.run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
     VALUES ('os-b2', 'os-b1', 'os-b1', 1, ?)`, [now]);
  // 3) grupo con fila propia en la referencia: os-c1 (ref) <- os-c2, os-c3
  mk('os-c1', 'OS C1 referencia', 5); mk('os-c2', 'OS C2 miembro', 3); mk('os-c3', 'OS C3 miembro', 2);
  for (const [p, r] of [['os-c1','os-c1'], ['os-c2','os-c1'], ['os-c3','os-c1']]) {
    window.SGA_DB.run(
      `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
       VALUES (?, ?, ?, 1, ?)`, [p, r, r, now]);
  }
  const orden = 'orden-os';
  window.SGA_DB.run(
    `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
     VALUES (?, ?, ?, 'borrador', ?, 'pending', ?)`, [orden, suc, prov.id, now, now]);
  ['os-a1', 'os-b1', 'os-c1'].forEach((p, i) => window.SGA_DB.run(
    `INSERT INTO orden_compra_items (id, orden_id, producto_id, cantidad_pedida, estado, stock_minimo)
     VALUES (?, ?, ?, 5, 'pendiente', 10)`, ['it-' + p, orden, p]));
  return { suc, orden };
}
"""

REFS = """() => {
  const r = window.SGA_DB.query(`SELECT producto_id, referencia_id FROM producto_sustitutos
                                 WHERE producto_id LIKE 'os-%' AND referencia_id IS NOT NULL ORDER BY producto_id`);
  const por = {};
  r.forEach(x => { (por[x.producto_id] = por[x.producto_id] || []).push(x.referencia_id); });
  return por;
}"""


def abrir_accion(page, item_id, tecla):
    # El boton "Mas opciones" solo se ve en la fila enfocada: se enfoca con un clic en la fila
    # (celda del nombre, que no es un input) y se abre el panel con la flecha derecha.
    page.locator(f'tr[data-item-id="{item_id}"] td').nth(1).click()
    page.wait_for_timeout(150)
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(200)
    page.locator(f'tr[data-item-id="{item_id}"] [data-panel-acc="{tecla}"]').click()
    page.wait_for_timeout(300)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=True)
        info = page.evaluate(SEMBRAR)
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.locator(f'[data-abrir="{info["orden"]}"]').click()
        page.wait_for_timeout(500)

        print("--- 4) stock efectivo del grupo = suma de TODOS (referencia incluida) ---")
        total = page.evaluate("(s) => window.SGA_Ordenes.stockEfectivo('os-c1', s)", info["suc"])
        assert total == 10, f"5 + 3 + 2 = 10, dio {total}"
        total_m = page.evaluate("(s) => window.SGA_Ordenes.stockEfectivo('os-c2', s)", info["suc"])
        assert total_m == 10, f"Desde un miembro tambien 10, dio {total_m}"
        implicita = page.evaluate("(s) => window.SGA_Ordenes.stockEfectivo('os-b1', s)", info["suc"])
        assert implicita == 7, f"Referencia implicita: 4 + 3 = 7, dio {implicita}"
        print("OK")

        print("--- 1) Asociar dos sueltos: sale de la orden el que deja de ser referencia ---")
        abrir_accion(page, "it-os-a1", "sust")
        page.fill("#ord-sust-search", "OS A2")
        page.wait_for_timeout(400)
        page.locator("[data-sust-pick='os-a2']").click()
        page.wait_for_timeout(200)
        # por defecto la referencia es el producto recien buscado (os-a2)
        assert page.locator("#ord-sust-ref").input_value() == "os-a2"
        page.locator("#ord-sust-ok").click()
        page.wait_for_timeout(500)
        refs = page.evaluate(REFS)
        assert refs.get("os-a1") == ["os-a2"] and refs.get("os-a2") == ["os-a2"], refs
        assert page.locator('tr[data-item-id="it-os-a1"]').count() == 0, "os-a1 ya no es referencia: sale de la orden"
        print("OK")

        print("--- 2) Asociar una referencia implicita: el seguidor no queda huerfano ---")
        abrir_accion(page, "it-os-b1", "sust")
        page.fill("#ord-sust-search", "OS B3")
        page.wait_for_timeout(400)
        page.locator("[data-sust-pick='os-b3']").click()
        page.wait_for_timeout(200)
        page.locator("#ord-sust-ref").select_option("os-b3")
        page.locator("#ord-sust-ok").click()
        page.wait_for_timeout(500)
        refs = page.evaluate(REFS)
        assert refs.get("os-b1") == ["os-b3"], refs
        assert refs.get("os-b3") == ["os-b3"], refs
        assert refs.get("os-b2") == ["os-b3"], f"El seguidor de la referencia implicita quedo huerfano: {refs}"
        print("OK")

        print("--- 3) Pausar la referencia y migrarla a otro miembro ---")
        abrir_accion(page, "it-os-c1", "pausa")
        # se pausa solo la referencia (viene tildada el producto de la fila)
        assert page.locator("#ord-pausa-ref-wrap").is_visible(), "Deberia pedir a cual miembro migrar la referencia"
        page.locator("#ord-pausa-ref").select_option("os-c2")
        page.locator("#ord-pausa-ok").click()
        page.wait_for_timeout(500)
        refs = page.evaluate(REFS)
        for prod in ("os-c1", "os-c2", "os-c3"):
            assert refs.get(prod) == ["os-c2"], f"{prod} deberia apuntar a os-c2 con UNA sola fila: {refs}"
        pend = page.evaluate("window.SGA_DB.query(\"SELECT sync_status FROM productos WHERE id='os-c3'\")[0].sync_status")
        assert pend == "pending", f"El cambio de grupo tiene que viajar: {pend}"
        print("OK")

        print("--- 4b) despues de todo, las sumas siguen cuadrando ---")
        total = page.evaluate("(s) => window.SGA_Ordenes.stockEfectivo('os-c3', s)", info["suc"])
        assert total == 10, f"El grupo sigue sumando 10, dio {total}"

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: Órdenes y grupos de sustitutos ===")
        browser.close()


if __name__ == "__main__":
    main()
