"""
tests/e2e/test_clientes_ultima_visita.py — "Última visita" y "Días sin comprar" salen de las ventas
y los cobros reales.

Bug real (dueño, 25/11/2026, con capturas): un cliente figuraba "Última visita 09/10 — 47 días sin
comprar" habiendo comprado el 22/11. La ficha leía clientes.ultima_visita, una columna que solo se
escribía al cobrar deuda o al usar saldo a favor: una venta común no la tocaba.

Cubre (lista de clientes, ficha -> Estadísticas y tabla de familia):
 A. compras recientes con la columna vieja atrasada -> manda la última compra.
 B. pagó ayer pero no compra hace 10 días -> visita = ayer, días sin comprar = 10.
 C. venta ANULADA ayer (y su pago) -> no cuenta; vale la compra completada anterior.
 D. sin ventas ni pagos (solo la columna vieja) -> "—".
 E. un ajuste (saldo inicial importado / reversión) no cuenta como visita.

Correr (server en :8765):  python tests/e2e/test_clientes_ultima_visita.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """() => {
  const hace = (dias) => { const d = new Date(); d.setDate(d.getDate() - dias); d.setHours(12, 0, 0, 0); return d.toISOString(); };
  const cli = (id, nombre, vieja, extra = {}) => window.SGA_DB.run(
    `INSERT INTO clientes (id, nombre, apellido, activo, es_master, cliente_master_id, ultima_visita, sync_status, updated_at)
     VALUES (?, ?, 'Prueba', 1, ?, ?, ?, 'synced', ?)`,
    [id, nombre, extra.master ? 1 : 0, extra.de || null, vieja, hace(0)]);
  const venta = (id, c, dias, estado = 'completada') => window.SGA_DB.run(
    `INSERT INTO ventas (id, sucursal_id, cliente_id, fecha, subtotal, descuento, total, estado, sync_status, updated_at)
     VALUES (?, '1', ?, ?, 1000, 0, 1000, ?, 'synced', ?)`, [id, c, hace(dias), estado, hace(dias)]);
  const cc = (id, c, tipo, dias, ventaId = null) => window.SGA_DB.run(
    `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, venta_id, descripcion, fecha, sync_status, updated_at)
     VALUES (?, ?, '1', ?, -100, ?, 'prueba', ?, 'synced', ?)`, [id, c, tipo, ventaId, hace(dias), hace(dias)]);

  cli('uv-a', 'Ana', hace(47), { master: true });  venta('v-a1', 'uv-a', 10); venta('v-a2', 'uv-a', 3); cc('cc-a', 'uv-a', 'pago', 20);
  cli('uv-b', 'Beto', null, { de: 'uv-a' });       venta('v-b1', 'uv-b', 10); cc('cc-b', 'uv-b', 'pago', 1);
  cli('uv-c', 'Carla', hace(1));                    venta('v-c1', 'uv-c', 15); venta('v-c2', 'uv-c', 1, 'anulada'); cc('cc-c', 'uv-c', 'pago', 1, 'v-c2');
  cli('uv-d', 'Dario', hace(5));
  cc('cc-d', 'uv-d', 'ajuste', 2);
  const f = (dias) => { const d = new Date(); d.setDate(d.getDate() - dias);
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }); };
  return { d1: f(1), d3: f(3), d15: f(15) };
}"""


def ir_a_clientes(page):
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(250)
    page.evaluate("window.location.hash = 'clientes'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)


def stats(page, nombre):
    ir_a_clientes(page)
    page.locator("tr", has_text=nombre + " Prueba").get_by_text("👁️", exact=True).click()
    page.wait_for_timeout(400)
    page.locator(".ficha-nav-item[data-section='stats']").click()
    page.wait_for_timeout(300)
    cards = page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('#stats-grid .stat-card')]
        .map(c => [c.querySelector('.stat-card-label').innerText, c.querySelector('.stat-card-value').innerText]))""")
    return {k.lower(): v for k, v in cards.items()}


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=False)
        ir_a_clientes(page)
        f = page.evaluate(SEMBRAR)

        print("=== Lista de clientes ===")
        ir_a_clientes(page)
        celda = lambda n: page.locator("tr", has_text=n + " Prueba").first.locator("td").nth(6).inner_text().strip()
        assert celda("Ana") == f["d3"], f"BUG: Ana compró hace 3 días y la lista dice {celda('Ana')!r}"
        assert celda("Beto") == f["d1"], f"Beto pagó ayer: {celda('Beto')!r}"
        assert celda("Carla") == f["d15"], f"BUG: una venta anulada no es una visita: {celda('Carla')!r}"
        assert celda("Dario") == "—", f"Sin ventas ni pagos no hay visita: {celda('Dario')!r}"
        print("OK")

        print("=== Ficha -> Estadísticas ===")
        casos = {"Ana": (f["d3"], "3 días"), "Beto": (f["d1"], "10 días"), "Carla": (f["d15"], "15 días"), "Dario": ("—", "—")}
        for nombre, (visita, dias) in casos.items():
            s = stats(page, nombre)
            assert s["última visita"] == visita and s["días sin comprar"] == dias, f"BUG en {nombre}: {s} (esperaba {visita} / {dias})"
            print(f"OK - {nombre}: {visita} / {dias}")

        print("=== Tabla de familia ===")
        ir_a_clientes(page)
        page.locator("tr", has_text="Ana Prueba").get_by_text("👁️", exact=True).click()
        page.wait_for_timeout(400)
        page.locator(".ficha-nav-item[data-section='familia']").click()
        page.wait_for_timeout(300)
        fila = page.locator(".miembro-table tbody tr", has_text="Beto")
        assert f["d1"] in fila.inner_text(), f"BUG: la tabla de familia no muestra la visita real: {fila.inner_text()!r}"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_clientes_ultima_visita")


if __name__ == "__main__":
    main()
