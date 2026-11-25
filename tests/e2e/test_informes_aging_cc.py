"""
tests/e2e/test_informes_aging_cc.py — Informes -> Aging Cuenta Corriente: saldo y días de mora reales.

Bug real (dueño, 25/11/2026, con capturas): un cliente debía $62.709 según la pantalla Clientes y el
informe mostraba $250.615. El informe filtraba cuenta_corriente por sucursal_id, y los cobros hechos
desde Clientes (y los saldos importados) se guardan SIN sucursal: se contaba la deuda y no los pagos.
Además los "días de mora" se contaban desde la primera compra fiada de la historia, aunque estuviera paga.

Cubre, usando el cobro REAL (SGA_Clientes.registrarPago):
 A. cobro sin sucursal descontado; saldo igual al de la pantalla Clientes; último pago correcto.
 B. los pagos cancelan primero lo más viejo: "Impaga desde" / días = la compra impaga más antigua.
 C. quien quedó en cero no aparece (y no cuenta en el total).
 D. saldo inicial importado (ajuste sin sucursal) cuenta como deuda.
 E. una venta anulada y su reversión no son ni deuda ni pago.

Correr (server en :8765):  python tests/e2e/test_informes_aging_cc.py
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
  const suc = window.SGA_Auth.getCurrentUser().sucursal_id, uid = window.SGA_Auth.getCurrentUser().id;
  const cli = (id, nombre) => window.SGA_DB.run(
    `INSERT INTO clientes (id, nombre, apellido, activo, tope_deuda, sync_status, updated_at) VALUES (?, ?, 'Aging', 1, 100000, 'synced', ?)`, [id, nombre, hace(0)]);
  const cc = (id, c, tipo, monto, dias, extra = {}) => window.SGA_DB.run(
    `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, venta_id, descripcion, fecha, sync_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
    [id, c, extra.sinSuc ? null : suc, tipo, monto, extra.venta || null, extra.desc || 'prueba', hace(dias), hace(dias)]);

  // A y B: fiado 100 dias (1000), fiado 40 dias (500), fiado 10 dias (300); cobra 1200 desde Clientes
  cli('ag-a', 'Ana'); cc('a1','ag-a','venta_fiada',1000,100); cc('a2','ag-a','venta_fiada',500,40); cc('a3','ag-a','venta_fiada',300,10);
  const r = window.SGA_Clientes.registrarPago('ag-a', { monto: 1200, medio: 'mercadopago', usuarioId: uid, sucursalId: suc });
  if (r && r.success === false) throw new Error(r.error);
  // C: pago todo
  cli('ag-c', 'Carla'); cc('c1','ag-c','venta_fiada',800,60);
  window.SGA_Clientes.registrarPago('ag-c', { monto: 800, medio: 'mercadopago', usuarioId: uid, sucursalId: suc });
  // D: saldo inicial importado, sin sucursal
  cli('ag-d', 'Dario'); cc('d1','ag-d','ajuste',2500,120,{ sinSuc: true, desc: 'Saldo inicial migración' });
  // E: venta anulada (fiado + reversion) vieja, y una compra impaga de hace 5 dias
  cli('ag-e', 'Elsa');
  window.SGA_DB.run(`INSERT INTO ventas (id, sucursal_id, cliente_id, fecha, total, estado, sync_status, updated_at) VALUES ('anul1234-venta', ?, 'ag-e', ?, 700, 'anulada', 'synced', ?)`, [suc, hace(80), hace(80)]);
  cc('e1','ag-e','venta_fiada',700,80,{ venta: 'anul1234-venta' });
  cc('e2','ag-e','ajuste',-700,79,{ desc: 'Reversión anulación venta anul1234: error' });
  cc('e3','ag-e','venta_fiada',900,5);
  const f = (dias) => hace(dias).slice(0, 10).split('-').reverse().join('/');
  return { f40: f(40), f120: f(120), f5: f(5),
    saldoA: window.SGA_Clientes.getSaldoActual('ag-a'),
    sinSuc: window.SGA_DB.query("SELECT COUNT(*) AS n FROM cuenta_corriente WHERE cliente_id='ag-a' AND tipo='pago' AND sucursal_id IS NULL")[0].n };
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'clientes'")
        page.wait_for_timeout(500)
        info = page.evaluate(SEMBRAR)
        assert info["saldoA"] == 600 and info["sinSuc"] == 1, f"Escenario: el cobro real deberia guardarse sin sucursal: {info}"

        page.evaluate("window.location.hash = 'informes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.select_option("#inf-sel-reporte", "aging_cc")
        page.locator("#inf-btn-generar").click()
        page.wait_for_timeout(600)

        def fila(nombre):
            loc = page.locator("#inf-results tbody tr", has_text=nombre + " Aging")
            if not loc.count():
                return None
            c = loc.first.locator("td").all_inner_texts()
            return {"saldo": c[2].strip(), "pct": c[4].strip(), "desde": c[5].strip(), "compra": c[6].strip(),
                    "pago": c[7].strip(), "dias": c[8].strip(), "cat": c[9].strip()}

        a = fila("Ana")
        assert a and "600,00" in a["saldo"], f"BUG: el cobro hecho desde Clientes no se descuenta: {a}"
        assert a["pago"] != "—" and a["pct"] == "1%", f"Ultimo pago / % del tope: {a}"
        # 1200 cubren la de 1000 (100 dias) y parte de la de 500: lo impago mas viejo es de hace 40 dias
        assert a["desde"] == info["f40"] and a["dias"] == "40d" and a["cat"] == "Normal", \
            f"BUG: la mora se cuenta desde una deuda ya pagada: {a} (esperaba {info['f40']} / 40d)"
        print("OK - Ana: saldo 600, impaga desde hace 40 dias")

        assert fila("Carla") is None, "BUG: un cliente que pago todo sigue figurando como deudor"
        d = fila("Dario")
        assert d and "2.500,00" in d["saldo"] and d["desde"] == info["f120"] and d["cat"] == "Crítica", f"Saldo importado: {d}"
        e = fila("Elsa")
        assert e and "900,00" in e["saldo"] and e["desde"] == info["f5"] and e["compra"] == info["f5"], \
            f"Una venta anulada no es deuda ni compra: {e}"
        assert e["pago"] == "—", f"La reversion no es un pago: {e}"
        print("OK - saldados fuera, saldo importado y venta anulada correctos")

        total = page.locator("#inf-results tfoot td.num").first.inner_text()
        esperado = page.evaluate("""() => window.SGA_DB.query(
            "SELECT SUM(s) AS t FROM (SELECT SUM(monto) AS s FROM cuenta_corriente GROUP BY cliente_id HAVING SUM(monto) > 0.01)")[0].t""")
        assert total.replace("$", "").replace(".", "").replace(",", ".").strip() == f"{esperado:.2f}", f"Total {total} vs {esperado}"
        print(f"OK - el total ({total}) es la suma de los saldos reales")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_informes_aging_cc")


if __name__ == "__main__":
    main()
