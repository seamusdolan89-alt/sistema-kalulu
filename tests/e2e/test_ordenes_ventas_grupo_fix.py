"""
tests/e2e/test_ordenes_ventas_grupo_fix.py — generarOrdenCompra/agregarItem:
"Vtas 30d" y "Prom. 6m" de un item agrupado deben sumar TODO el grupo de
sustitutos, no solo la referencia.

Bug real reportado por el usuario (21/10/2026): "Cagnoli Jamon Cocido Genuino
Libre de Gluten 200g" (la referencia del grupo, y a quien se le pide) mostraba
"0" en la columna Vtas 30d de la fila de la orden, pero el popup de detalle
(que sí suma por miembro) mostraba que "Cagnoli Jamon Natural Feteado 120g"
(otro miembro del mismo grupo) vendió 3 unidades — Total del grupo: 3. La fila
y el popup no coincidían porque generarOrdenCompra calculaba ventas_30d con
ventasUltimos(refId, 30) (solo la referencia), mientras que el popup
(openDetalleGrupoOverlay) ya sumaba por miembro. Mismo bug en agregarItem
(agregar producto manualmente a una orden).

Fix: nueva ventasGrupoUltimos(productoId, dias) que suma ventasUltimos sobre
TODOS los miembros del grupo (GruposSustitutos.miembrosDe), igual que ya hace
stockEfectivo con el stock. Usada en los dos lugares que escriben ventas_30d/
ventas_prom_6m: generarOrdenCompra y agregarItem.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_ventas_grupo_fix.py
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
  const suc  = window.SGA_DB.query(`SELECT id FROM sucursales LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

  const mkProd = (id, nombre, stock, stockMin, provPrincipal) => {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, cant_pedido, unidad_medida,
         es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at,
         proveedor_principal_id)
       VALUES (?, ?, 10, 20, ?, 2, 'unidad', 0, 0, 1, ?, ?, 'synced', ?, ?)`,
      [id, nombre, stockMin, now, now, now, provPrincipal]
    );
    window.SGA_DB.run(
      `INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, sync_status, updated_at)
       VALUES (?, ?, ?, 'synced', ?)`, [id, suc, stock, now]
    );
  };

  // Grupo: vg-ref es la referencia Y a quien se le pide (vende de este proveedor).
  // vg-m2 es OTRO miembro del grupo que concentra la venta real.
  // Stock del grupo (1 + 1 = 2) <= stock_minimo (3) -> entra en la orden.
  mkProd('vg-ref', 'VG Referencia', 1, 3, prov.id);
  mkProd('vg-m2',  'VG Miembro Dos', 1, 3, prov.id);
  for (const [p, r] of [['vg-ref', 'vg-ref'], ['vg-m2', 'vg-ref']]) {
    window.SGA_DB.run(
      `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
       VALUES (?, ?, ?, 1, ?)`, [p, r, r, now]
    );
  }

  // Suelto, sin grupo, mismo proveedor -- control: no deberia verse afectado.
  mkProd('vg-solo', 'VG Suelto', 1, 3, prov.id);

  // Venta de HOY: 3 unidades de vg-m2 (NO de la referencia).
  window.SGA_DB.run(
    `INSERT INTO ventas (id, sucursal_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
     VALUES ('venta-vg-hoy', ?, (SELECT id FROM usuarios LIMIT 1), ?, 100, 0, 100, 'completada', 'synced', ?)`,
    [suc, now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
     VALUES ('vi-vg-hoy', 'venta-vg-hoy', 'vg-m2', 3, 10, 5, 30)`
  );
  // Venta de vg-solo (control): 7 unidades hoy.
  window.SGA_DB.run(
    `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
     VALUES ('vi-vg-solo', 'venta-vg-hoy', 'vg-solo', 7, 10, 5, 70)`
  );

  return { suc, provId: prov.id };
}
"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=True)
        info = page.evaluate(SEMBRAR)
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- generarOrdenCompra: ventas_30d del item agrupado suma TODO el grupo ---")
        resultado = page.evaluate(
            "([prov, suc]) => window.SGA_Ordenes.generarOrdenCompra(prov, suc)",
            [info["provId"], info["suc"]],
        )
        assert resultado["success"] and resultado["ordenId"], resultado
        items = page.evaluate(
            "(id) => window.SGA_Ordenes.getOrden(id).items", resultado["ordenId"]
        )
        por_prod = {it["producto_id"]: it for it in items}

        it_ref = por_prod.get("vg-ref")
        assert it_ref is not None, f"vg-ref deberia estar en la orden (stock 2 <= minimo 3): {items}"
        assert it_ref["ventas_30d"] == 3, \
            f"La fila deberia mostrar las 3 unidades vendidas por TODO el grupo (vg-m2 incluido), dio {it_ref['ventas_30d']}"
        assert round(it_ref["ventas_prom_6m"], 2) == 0.5, \
            f"3/6 = 0.5, dio {it_ref['ventas_prom_6m']}"
        print(f"OK - ventas_30d={it_ref['ventas_30d']}, ventas_prom_6m={it_ref['ventas_prom_6m']}")

        it_solo = por_prod.get("vg-solo")
        assert it_solo is not None, "vg-solo tambien deberia estar en la orden"
        assert it_solo["ventas_30d"] == 7, \
            f"El item suelto no deberia verse afectado por el fix de grupos, dio {it_solo['ventas_30d']}"
        print("OK - el item suelto (control) sigue mostrando su propia venta, sin cambios")

        print("--- agregarItem: mismo fix al agregar manualmente ---")
        orden2 = "orden-vg-manual"
        page.evaluate(
            """([orden, suc, prov]) => {
                const now = new Date().toISOString();
                window.SGA_DB.run(
                  `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
                   VALUES (?, ?, ?, 'borrador', ?, 'pending', ?)`, [orden, suc, prov, now, now]
                );
            }""",
            [orden2, info["suc"], info["provId"]],
        )
        ok = page.evaluate(
            "([orden, prod, suc]) => window.SGA_Ordenes.agregarItem(orden, prod, suc)",
            [orden2, "vg-ref", info["suc"]],
        )
        assert ok, "agregarItem deberia devolver true"
        item_manual = page.evaluate(
            "(id) => window.SGA_Ordenes.getOrden(id).items[0]", orden2
        )
        assert item_manual["ventas_30d"] == 3, \
            f"agregarItem deberia sumar el grupo entero tambien, dio {item_manual['ventas_30d']}"
        print(f"OK - agregarItem: ventas_30d={item_manual['ventas_30d']}")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: ventas_30d/ventas_prom_6m de un item agrupado suman TODO el grupo ===")
        browser.close()


if __name__ == "__main__":
    main()
