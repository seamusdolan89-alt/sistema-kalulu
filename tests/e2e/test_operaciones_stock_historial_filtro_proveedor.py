"""
tests/e2e/test_operaciones_stock_historial_filtro_proveedor.py — Historial de
compras (Operaciones de Stock): filtro por proveedor.

Pedido del usuario: el historial solo filtraba por fecha; para ver todo lo que
se le compró a un proveedor había que recorrer la lista entera.

Cubre: un <select> "Proveedor" junto a Desde/Hasta, que
  - lista solo a los proveedores que tienen compras (no los 30 del catálogo),
  - filtra apenas se elige uno,
  - se combina con el rango de fechas,
  - "Limpiar" lo devuelve a "Todos".

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_historial_filtro_proveedor.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def facturas_visibles(page):
    return page.evaluate("""
      () => [...document.querySelectorAll('#ops-historial-body tbody tr')]
              .map(tr => tr.querySelectorAll('td')[2].textContent.trim())
    """)


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
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed in place ---")
        login_via_seed(page, admin_pos=True)

        print("--- 4 compras: 2 de un proveedor, 1 de otro (en fechas distintas), 1 del tercero sin compras ---")
        info = page.evaluate("""
          () => {
            const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
            const provs = window.SGA_DB.query(`SELECT id, razon_social FROM proveedores ORDER BY razon_social`);
            const [pa, pb, pc] = provs;
            const compras = [
              { id: 'c1', prov: pa.id, fecha: '2026-08-10T10:00:00.000Z', nro: '1001' },
              { id: 'c2', prov: pa.id, fecha: '2026-09-10T10:00:00.000Z', nro: '1002' },
              { id: 'c3', prov: pb.id, fecha: '2026-09-12T10:00:00.000Z', nro: '2001' },
            ];
            for (const c of compras) {
              window.SGA_DB.run(
                `INSERT INTO compras
                   (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
                    total, total_factura, condicion_pago, estado, sync_status, updated_at)
                 VALUES (?, '1', ?, ?, ?, ?, '0001', 500, 500, 'pendiente', 'confirmada', 'pending', ?)`,
                [c.id, c.prov, usuarioId, c.fecha, c.nro, c.fecha]
              );
              window.SGA_DB.run(
                `INSERT INTO compra_items (id, compra_id, cantidad, costo_unitario, subtotal, tipo)
                 VALUES (?, ?, 1, 500, 500, 'producto')`, [c.id + '-i', c.id]
              );
            }
            return { a: pa.razon_social, b: pb.razon_social, c: pc.razon_social, aId: pa.id, bId: pb.id };
          }
        """)
        print(f"Proveedores: {info}")

        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator('[data-action="historial_compras"]').click()
        page.wait_for_timeout(400)

        sel = page.locator("#ops-hist-proveedor")
        assert sel.count() == 1, "Falta el <select id='ops-hist-proveedor'> en el Historial de compras"

        todas = facturas_visibles(page)
        print(f"Sin filtro: {todas}")
        assert len(todas) == 3, f"Sin filtro deberia mostrar las 3 compras, muestra {todas}"

        opciones = sel.locator("option").all_inner_texts()
        print(f"Opciones del select: {opciones}")
        assert opciones[0].strip().lower().startswith("todos"), f"La primera opcion debe ser 'Todos': {opciones}"
        assert info["a"] in opciones and info["b"] in opciones, (
            f"Deben figurar los proveedores con compras ({info['a']}, {info['b']}): {opciones}")
        assert info["c"] not in opciones, (
            f"El proveedor sin compras ({info['c']}) no deberia listarse: {opciones}")

        print("--- Elegir el proveedor A: solo sus 2 compras ---")
        sel.select_option(value=info["aId"])
        page.wait_for_timeout(300)
        vis = facturas_visibles(page)
        print(f"Proveedor A: {vis}")
        assert sorted(vis) == ["0001-1001", "0001-1002"], f"BUG: el filtro no dejo solo las compras de A: {vis}"

        print("--- A + rango de fechas (solo septiembre): 1 compra ---")
        page.fill("#ops-hist-desde", "2026-09-01")
        page.fill("#ops-hist-hasta", "2026-09-30")
        page.locator("#ops-hist-filtrar").click()
        page.wait_for_timeout(300)
        vis = facturas_visibles(page)
        print(f"A + septiembre: {vis}")
        assert vis == ["0001-1002"], f"BUG: proveedor + fechas no se combinan: {vis}"

        print("--- Elegir el proveedor B: la de B (con las mismas fechas) ---")
        sel.select_option(value=info["bId"])
        page.wait_for_timeout(300)
        vis = facturas_visibles(page)
        assert vis == ["0001-2001"], f"BUG: cambiar de proveedor no respeta las fechas: {vis}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "ops_historial_filtro_proveedor.png"), full_page=True)

        print("--- Limpiar: vuelve a Todos y a las 3 compras ---")
        page.locator("#ops-hist-limpiar").click()
        page.wait_for_timeout(300)
        assert sel.input_value() == "", f"Limpiar no reseteo el proveedor: {sel.input_value()!r}"
        vis = facturas_visibles(page)
        assert len(vis) == 3, f"Limpiar deberia mostrar las 3 compras: {vis}"

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        print("OK - Historial de compras: filtro por proveedor (solo con compras), combinable con fechas, Limpiar lo resetea.")
        browser.close()


if __name__ == "__main__":
    main()
