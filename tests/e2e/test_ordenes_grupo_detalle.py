"""
tests/e2e/test_ordenes_grupo_detalle.py — Órdenes de Compra: cuando un producto
de la orden pertenece a un grupo de sustitutos, su nombre se muestra en negrita
y los campos "Stock act.", "Vtas 30d" y "Prom. 6m" (que muestran el TOTAL del
grupo, ver stockEfectivo/generarOrdenCompra) se vuelven un botón que abre un
popup de solo lectura con el desglose por miembro.

Pedido explícito del usuario (14/10/2026), con captura de la pantalla de
armar una orden ("ÓRDENES DE COMPRA" / tabla editable en borrador).

Cubre:
1. Nombre en negrita (<strong class="ord-nombre-grupo">) solo para el item
   agrupado; el item suelto queda como texto plano.
2. El número de "Stock act." del item agrupado es un botón; al clickearlo,
   el popup muestra cada miembro con su stock individual, marca cuál es la
   referencia ("se le pide a este") y el total coincide con la suma real.
3. Mismo comportamiento para "Vtas 30d" y "Prom. 6m".
4. El item suelto (sin grupo) NO tiene botón en ninguna de esas 3 columnas:
   son texto plano, igual que antes de este cambio.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_ordenes_grupo_detalle.py
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
  const hoy90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const suc  = window.SGA_DB.query(`SELECT id FROM sucursales LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0];

  const mkProd = (id, nombre, stock) => {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
         es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at,
         proveedor_principal_id)
       VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?, ?)`,
      [id, nombre, now, now, now, prov.id]
    );
    window.SGA_DB.run(
      `INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, sync_status, updated_at)
       VALUES (?, ?, ?, 'synced', ?)`, [id, suc, stock, now]
    );
  };

  // Grupo: ogd-ref (referencia, stock 5) + ogd-m2 (stock 3) + ogd-m3 (stock 2) = 10
  mkProd('ogd-ref', 'OGD Referencia', 5);
  mkProd('ogd-m2',  'OGD Miembro Dos', 3);
  mkProd('ogd-m3',  'OGD Miembro Tres', 2);
  for (const [p, r] of [['ogd-ref', 'ogd-ref'], ['ogd-m2', 'ogd-ref'], ['ogd-m3', 'ogd-ref']]) {
    window.SGA_DB.run(
      `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
       VALUES (?, ?, ?, 1, ?)`, [p, r, r, now]
    );
  }

  // Suelto, sin grupo
  mkProd('ogd-solo', 'OGD Suelto', 7);

  // Ventas: ogd-ref vende 6 HOY (cuenta en 30d y en 6m); ogd-m2 vende 12 hace
  // 90 dias (cuenta solo en 6m); ogd-m3 no vende nada.
  window.SGA_DB.run(
    `INSERT INTO ventas (id, sucursal_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
     VALUES ('venta-ogd-hoy', ?, (SELECT id FROM usuarios LIMIT 1), ?, 100, 0, 100, 'completada', 'synced', ?)`,
    [suc, now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
     VALUES ('vi-ogd-hoy', 'venta-ogd-hoy', 'ogd-ref', 6, 10, 5, 60)`
  );
  window.SGA_DB.run(
    `INSERT INTO ventas (id, sucursal_id, usuario_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
     VALUES ('venta-ogd-90d', ?, (SELECT id FROM usuarios LIMIT 1), ?, 100, 0, 100, 'completada', 'synced', ?)`,
    [suc, hoy90, now]
  );
  window.SGA_DB.run(
    `INSERT INTO venta_items (id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
     VALUES ('vi-ogd-90d', 'venta-ogd-90d', 'ogd-m2', 12, 10, 5, 120)`
  );

  // Orden en borrador con los dos items: el agrupado (referencia) y el suelto.
  const orden = 'orden-ogd';
  window.SGA_DB.run(
    `INSERT INTO ordenes_compra (id, sucursal_id, proveedor_id, estado, fecha_creacion, sync_status, updated_at)
     VALUES (?, ?, ?, 'borrador', ?, 'pending', ?)`, [orden, suc, prov.id, now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO orden_compra_items
       (id, orden_id, producto_id, cantidad_pedida, estado, stock_actual, stock_minimo,
        ventas_30d, ventas_prom_6m)
     VALUES ('it-ogd-ref', ?, 'ogd-ref', 5, 'pendiente', 10, 1, 6, 3)`, [orden]
  );
  window.SGA_DB.run(
    `INSERT INTO orden_compra_items
       (id, orden_id, producto_id, cantidad_pedida, estado, stock_actual, stock_minimo,
        ventas_30d, ventas_prom_6m)
     VALUES ('it-ogd-solo', ?, 'ogd-solo', 5, 'pendiente', 7, 1, 2, 1)`, [orden]
  );

  return { suc, orden };
}
"""


def fila_texto(page, nombre):
    """Texto completo de la fila del popup que contiene `nombre` (nombre + valor)."""
    return page.locator(".ord-grupo-tabla tbody tr", has_text=nombre).inner_text()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
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
        page.locator(f'[data-abrir="{info["orden"]}"]').click()
        page.wait_for_timeout(500)

        print("--- 1) Nombre en negrita solo para el item agrupado ---")
        fila_ref = page.locator('tr[data-item-id="it-ogd-ref"]')
        fila_solo = page.locator('tr[data-item-id="it-ogd-solo"]')
        assert fila_ref.locator("td").nth(1).locator("strong.ord-nombre-grupo").count() == 1, \
            "El item del grupo deberia tener el nombre en negrita"
        assert fila_solo.locator("td").nth(1).locator("strong.ord-nombre-grupo").count() == 0, \
            "El item suelto NO deberia tener negrita"
        print("OK")

        print("--- 2) El item suelto no tiene botones en Stock/Vtas 30d/Prom 6m ---")
        for col in (2, 5, 6):  # Stock act., Vtas 30d, Prom. 6m (0-index de <td>)
            assert fila_solo.locator("td").nth(col).locator("button.ord-valor-grupo").count() == 0, \
                f"Columna {col} del item suelto no deberia ser un boton"
        assert fila_solo.locator("td").nth(2).inner_text().strip() == "7"
        assert fila_solo.locator("td").nth(5).inner_text().strip() == "2"
        assert fila_solo.locator("td").nth(6).inner_text().strip() == "1"
        print("OK")

        print("--- 3) Popup de Stock actual: desglose por miembro + total ---")
        fila_ref.locator("td").nth(2).locator("button.ord-valor-grupo").click()
        page.wait_for_timeout(200)
        overlay = page.locator("#ord-grupo-overlay")
        assert overlay.is_visible()
        assert page.locator("#ord-grupo-titulo").inner_text() == "Stock actual del grupo"
        assert "5" in fila_texto(page, "OGD Referencia")
        assert "se le pide a este" in fila_texto(page, "OGD Referencia"), \
            "La referencia del grupo deberia estar marcada"
        assert "3" in fila_texto(page, "OGD Miembro Dos")
        assert "2" in fila_texto(page, "OGD Miembro Tres")
        cuerpo = page.locator("#ord-grupo-cuerpo").inner_text()
        assert "Total del grupo" in cuerpo and "10" in cuerpo.split("Total del grupo")[1]
        print("OK")

        print("--- 4) Escape cierra el popup (y no se filtra a la navegacion de la orden) ---")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        assert not overlay.is_visible(), "Escape deberia cerrar el popup"
        print("OK")

        print("--- 5) Popup de Vtas 30d: solo cuenta la venta de HOY ---")
        fila_ref.locator("td").nth(5).locator("button.ord-valor-grupo").click()
        page.wait_for_timeout(200)
        assert page.locator("#ord-grupo-titulo").inner_text() == "Ventas de los últimos 30 días del grupo"
        assert "6" in fila_texto(page, "OGD Referencia")
        assert "0" in fila_texto(page, "OGD Miembro Dos"), "La venta de hace 90 dias no cuenta en 30d"
        assert "0" in fila_texto(page, "OGD Miembro Tres")
        cuerpo = page.locator("#ord-grupo-cuerpo").inner_text()
        assert "6" in cuerpo.split("Total del grupo")[1]
        page.locator("#ord-grupo-cerrar-btn").click()
        page.wait_for_timeout(150)
        print("OK")

        print("--- 6) Popup de Prom. 6m: la venta de hace 90 dias SI cuenta ---")
        fila_ref.locator("td").nth(6).locator("button.ord-valor-grupo").click()
        page.wait_for_timeout(200)
        assert page.locator("#ord-grupo-titulo").inner_text() == "Promedio mensual (6 meses) del grupo"
        assert "1" in fila_texto(page, "OGD Referencia")   # 6/6 = 1
        assert "2" in fila_texto(page, "OGD Miembro Dos")  # 12/6 = 2
        cuerpo = page.locator("#ord-grupo-cuerpo").inner_text()
        assert "3" in cuerpo.split("Total del grupo")[1]  # 1 + 2 + 0
        page.locator("#ord-grupo-close").click()
        page.wait_for_timeout(150)
        print("OK")

        print("--- 7) Tambien funciona en la vista de solo lectura (orden confirmada) ---")
        page.evaluate("(id) => window.SGA_Ordenes.cambiarEstado(id, 'confirmada')", info["orden"])
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_timeout(300)
        page.evaluate("window.location.hash = ''")
        page.wait_for_timeout(100)
        page.evaluate("window.location.hash = 'ordenes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator(f'[data-abrir="{info["orden"]}"]').click()
        page.wait_for_timeout(500)
        fila_ref_ro = page.locator('tr', has=page.locator('strong.ord-nombre-grupo', has_text="OGD Referencia"))
        assert fila_ref_ro.locator("button.ord-valor-grupo").count() == 1, \
            "El stock compuesto deberia seguir siendo un boton en la vista de solo lectura"
        fila_ref_ro.locator("button.ord-valor-grupo").click()
        page.wait_for_timeout(200)
        assert page.locator("#ord-grupo-overlay").is_visible()
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: negrita + detalle de grupo en Ordenes de Compra ===")
        browser.close()


if __name__ == "__main__":
    main()
