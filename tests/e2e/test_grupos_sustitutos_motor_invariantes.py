"""
tests/e2e/test_grupos_sustitutos_motor_invariantes.py — Invariantes del motor de
grupos de sustitutos (js/modules/grupos_sustitutos.js).

Auditoría del 2/10/2026 encontró dos bugs reales:

1. aplicarCambioReferencia(b, a) dejaba a la referencia `a` SIN fila propia
   (a -> a). Todas las sumas de stock del grupo son "filas con referencia_id = a",
   así que el stock propio de `a` no contaba: un grupo con a=5 y b=3 daba 3 en vez
   de 8 en Órdenes (stockEfectivo) y en Productos (getStockDisponible), y se
   sugería reponer de más. db.js lo autocompletaba recién al próximo arranque.
2. definirGrupo (Informes > "Editar grupo") hacía INSERT OR REPLACE con clave
   (producto_id, sustituto_id): un producto que ya apuntaba a otra referencia
   quedaba con DOS filas, y toda consulta que asume una sola (LIMIT 1) devolvía
   cualquiera de las dos.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_grupos_sustitutos_motor_invariantes.py
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
  const mk = (id, n, q) => {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
         es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
       VALUES (?, ?, 10, 20, 5, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`, [id, n, now, now, now]);
    window.SGA_DB.run(
      `INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, sync_status, updated_at)
       VALUES (?, ?, ?, 'synced', ?)`, [id, suc, q, now]);
  };
  mk('mi-a', 'MI a', 5); mk('mi-b', 'MI b', 3); mk('mi-c', 'MI c', 7); mk('mi-d', 'MI d', 2);
  return suc;
}
"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=False)
        suc = page.evaluate(SEMBRAR)
        # Cargar los módulos que exponen window.SGA_*
        for ruta in ("informes", "ordenes", "productos"):
            page.evaluate(f"window.location.hash = '{ruta}'")
            page.wait_for_timeout(900)

        print("--- 1) aplicarCambioReferencia deja a la referencia con fila propia y suma su stock ---")
        page.evaluate("window.SGA_GruposSustitutos.aplicarCambioReferencia('mi-b', 'mi-a')")
        propia = page.evaluate(
            "window.SGA_DB.query(`SELECT referencia_id FROM producto_sustitutos WHERE producto_id='mi-a'`)")
        assert propia == [{"referencia_id": "mi-a"}], f"La referencia deberia tener su fila a->a: {propia}"
        for nombre, expr in (
            ("Ordenes.stockEfectivo(ref)", "window.SGA_Ordenes.stockEfectivo('mi-a', s)"),
            ("Ordenes.stockEfectivo(miembro)", "window.SGA_Ordenes.stockEfectivo('mi-b', s)"),
            ("Productos.getStockDisponible(miembro)", "window.SGA_Productos.getStockDisponible('mi-b', s)"),
        ):
            v = page.evaluate(f"(s) => {expr}", suc)
            assert v == 8, f"{nombre} deberia sumar 5 + 3 = 8, dio {v}"
        print("OK")

        print("--- 2) definirGrupo deja UNA sola fila por producto ---")
        page.evaluate("""() => {
          const G = window.SGA_GruposSustitutos;
          G.aplicarCambioReferencia('mi-d', 'mi-c');   // grupo viejo c <- d
          G.definirGrupo({ miembros: ['mi-a','mi-b','mi-d'], referenciaId: 'mi-a',
                           involucrados: ['mi-a','mi-b','mi-c','mi-d'] });
        }""")
        filas = page.evaluate(
            "window.SGA_DB.query(`SELECT producto_id, referencia_id FROM producto_sustitutos WHERE producto_id LIKE 'mi-%' ORDER BY producto_id`)")
        por_prod = {}
        for f in filas:
            por_prod.setdefault(f["producto_id"], []).append(f["referencia_id"])
        assert all(len(v) == 1 for v in por_prod.values()), f"Hay productos con mas de una fila: {por_prod}"
        assert por_prod == {"mi-a": ["mi-a"], "mi-b": ["mi-a"], "mi-d": ["mi-a"]}, por_prod
        print("OK")

        print("--- 3) definirGrupo: la referencia nueva queda con fila propia (suma su stock) ---")
        page.evaluate("""() => window.SGA_GruposSustitutos.definirGrupo({
          miembros: ['mi-a','mi-b','mi-d'], referenciaId: 'mi-d', involucrados: ['mi-a','mi-b','mi-d'] })""")
        propia = page.evaluate(
            "window.SGA_DB.query(`SELECT referencia_id FROM producto_sustitutos WHERE producto_id='mi-d'`)")
        assert propia == [{"referencia_id": "mi-d"}], propia
        total = page.evaluate("(s) => window.SGA_Ordenes.stockEfectivo('mi-d', s)", suc)
        assert total == 10, f"5 + 3 + 2 = 10, dio {total}"
        print("OK")

        print("--- 4) moverMiembro (importacion): mueve UN producto sin arrastrar su grupo viejo ---")
        page.evaluate("""() => {
          const now = new Date().toISOString();
          const mk = (id) => window.SGA_DB.run(
            `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
               es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
             VALUES (?, ?, 10, 20, 5, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`, [id, 'MI ' + id, now, now, now]);
          ['mi-x', 'mi-y', 'mi-z', 'mi-w'].forEach(mk);
          const G = window.SGA_GruposSustitutos;
          G.moverMiembro('mi-y', 'mi-x');          // y -> x (x queda con su fila propia)
          G.moverMiembro('mi-z', 'mi-x');          // z -> x
          G.moverMiembro('mi-z', 'mi-w');          // z se muda a w, sin arrastrar a x ni a y
        }""")
        r = page.evaluate(
            "window.SGA_DB.query(`SELECT producto_id, referencia_id FROM producto_sustitutos WHERE producto_id IN ('mi-x','mi-y','mi-z','mi-w') ORDER BY producto_id`)")
        por = {}
        for f in r:
            por.setdefault(f["producto_id"], []).append(f["referencia_id"])
        assert por == {"mi-x": ["mi-x"], "mi-y": ["mi-x"], "mi-z": ["mi-w"], "mi-w": ["mi-w"]}, por
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: invariantes del motor de grupos de sustitutos ===")
        browser.close()


if __name__ == "__main__":
    main()
