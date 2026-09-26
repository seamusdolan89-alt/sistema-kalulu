"""
tests/e2e/test_pos_vuelto_a_favor_caja.py — El EFECTIVO que el cliente deja de más
(vuelto dejado a favor, o vuelto con el que cancela deuda) ENTRA a la caja.

Bug reportado por el usuario: las cajas le daban diferencias cuando un cliente dejaba
saldo a favor. Causa: en una venta cobrada en efectivo, la venta solo registra su total
como efectivo; si el cliente paga $20.000 una venta de $15.000 y se deja el vuelto a
favor, en el cajón hay $20.000 pero el saldo esperado solo contaba $15.000 (la cuenta
corriente anotaba el crédito de $5.000 y la caja nada) -> sobrante al cerrar.

Ahora ese efectivo queda registrado como INGRESO de caja ligado a la venta:
  - vuelto dejado a favor      -> tipo 'vuelto_a_favor'
  - vuelto que cancela deuda   -> tipo 'cobro_cliente' (cobranza de deuda)
y el saldo esperado coincide con el efectivo físico.

Cubre (POS, flujo real de la pantalla de venta):
  A.  cliente sin deuda: recibe $200 por $95, deja $105 a favor -> ingreso 'vuelto_a_favor' 105.
  B1. cliente con deuda de $60 y "cobrar deuda" (lo que el POS propone por defecto): la deuda
      va dentro de la venta ($155); recibe $200 y deja $45 a favor -> ingreso 'vuelto_a_favor' 45.
  B2. cliente con deuda de $60 SIN cobrarla en la venta: el vuelto de $105 cancela los $60 y
      deja $45 -> $60 de 'cobro_cliente' + $45 de 'vuelto_a_favor'.
  C. pago exacto y D. vuelto devuelto en mano (sin tildar): no generan ingresos.
  E. excedente con MercadoPago dejado a favor: NO toca el efectivo (ya va dentro del pago).
  En A-D el saldo esperado == efectivo físico (saldo inicial + lo recibido - vuelto devuelto).
  F. anular la venta A devuelve ese efectivo (borra el ingreso, con marca de eliminación).
  G. editar una venta re-crea sus movimientos: los de antes (ingresos y cuenta corriente) se sacan.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_vuelto_a_favor_caja.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta, assert_stock_integro

SALDO_INICIAL = 1000

ESPERADO = """() => {
  const q = (s, p) => window.SGA_DB.query(s, p || []);
  const ses = q(`SELECT id, saldo_inicial FROM sesiones_caja WHERE estado='abierta' LIMIT 1`)[0];
  const efectivo = q(`SELECT COALESCE(SUM(vp.monto),0) AS t FROM ventas v JOIN venta_pagos vp ON vp.venta_id=v.id
                      WHERE v.sesion_caja_id=? AND v.estado='completada' AND vp.medio='efectivo'`, [ses.id])[0].t;
  const egresos = q(`SELECT COALESCE(SUM(monto),0) AS t FROM egresos_caja WHERE sesion_caja_id=?`, [ses.id])[0].t;
  const ingresos = q(`SELECT COALESCE(SUM(monto),0) AS t FROM ingresos_caja WHERE sesion_caja_id=? AND (medio IS NULL OR medio='efectivo')`, [ses.id])[0].t;
  return ses.saldo_inicial + efectivo - egresos + ingresos;
}"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS + caja abierta ($1000) + 4 clientes (dos con deuda de $60) ---")
        login_via_seed(page)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        page.evaluate("""() => {
          const now = new Date().toISOString();
          const cli = (id, nombre, apellido) => window.SGA_DB.run(
            `INSERT INTO clientes (id, nombre, apellido, telefono, activo, tope_deuda, sync_status, updated_at)
             VALUES (?, ?, ?, '1', 1, 100000, 'pending', ?)`, [id, nombre, apellido, now]);
          cli('cli-1', 'Juan', 'Perez');
          cli('cli-2', 'Maria', 'Gomez');
          cli('cli-3', 'Carlos', 'Lopez');
          cli('cli-4', 'Pedro', 'Ruiz');       // sin deuda ni saldo a favor: para los cobros "normales"
          for (const id of ['cli-2', 'cli-3']) {
            window.SGA_DB.run(`INSERT INTO cuenta_corriente (id, cliente_id, tipo, monto, descripcion, fecha, sync_status, updated_at)
                               VALUES (?, ?, 'venta_fiada', 60, 'Deuda previa', ?, 'pending', ?)`, ['cc-' + id, id, now, now]);
          }
        }""")
        abrir_caja_si_hace_falta(page, saldo_inicial=SALDO_INICIAL)
        fisico = SALDO_INICIAL          # lo que hay de verdad en el cajón

        def vender(cliente, recibe, tildar, medio=None, cobrar_deuda=True):
            # Al finalizar una venta el POS vuelve a Inicio: se entra de nuevo a la pantalla de venta.
            page.evaluate("window.location.hash = 'pos'")
            page.wait_for_timeout(500)
            page.locator("#btn-nueva-venta").click()
            page.wait_for_timeout(400)
            page.locator("#pos-search-input").click()
            page.keyboard.type("Coca", delay=20)
            page.wait_for_timeout(400)
            page.locator("#pos-search-dropdown .sri").first.click()
            page.wait_for_timeout(400)
            page.locator("#client-search-input").click()
            page.keyboard.type(cliente, delay=20)
            page.wait_for_timeout(400)
            page.locator("#client-dropdown .cri").first.click()
            page.wait_for_timeout(400)
            if not cobrar_deuda:
                # Con un cliente deudor el POS propone cobrar la deuda dentro de la venta; acá NO.
                page.locator("#chk-aplicar-deuda").uncheck(force=True)
                page.wait_for_timeout(300)
            if medio:
                page.locator(f'.pchip[data-medio="{medio}"]').click()
                page.wait_for_timeout(300)
                page.locator(f'.pinput-field[data-medio="{medio}"]').fill(str(recibe))
            else:
                page.locator("#recibe-efectivo").fill(str(recibe))
            page.wait_for_timeout(300)
            if tildar:
                page.locator("#chk-saldo-favor").check(force=True)
                page.wait_for_timeout(200)
            page.locator("#btn-confirm-venta").click()
            page.wait_for_timeout(700)
            page.locator("#btn-ticket-confirmar").click()
            page.wait_for_timeout(600)

        def ingresos_de_venta(venta_id):
            return q(page, "SELECT tipo, monto, medio, cliente_id FROM ingresos_caja WHERE venta_id=? ORDER BY monto DESC", [venta_id])

        def venta_id_n(n):
            return q(page, "SELECT id FROM ventas ORDER BY fecha, rowid")[n]["id"]

        def verificar(etiqueta):
            esp = page.evaluate(ESPERADO)
            print(f"[{etiqueta}] saldo esperado {esp} vs efectivo físico {fisico}")
            assert esp == fisico, f"BUG [{etiqueta}]: la caja cerraría con {fisico - esp:+} de diferencia (esperado {esp}, físico {fisico})"

        print("--- A) Juan (sin deuda): $95 pagados con $200, deja $105 a favor ---")
        vender("Juan", 200, True)
        fisico += 200
        va = venta_id_n(0)
        ing = ingresos_de_venta(va)
        print(f"ingresos de la venta A: {ing}")
        assert ing == [{"tipo": "vuelto_a_favor", "monto": 105, "medio": "efectivo", "cliente_id": "cli-1"}], (
            f"BUG: el vuelto dejado a favor no entró a la caja como ingreso: {ing}")
        assert q(page, "SELECT tipo, monto FROM cuenta_corriente WHERE venta_id=?", [va]) == [{"tipo": "saldo_favor", "monto": -105}]
        verificar("A")

        print("--- B1) Maria (debe $60), deuda cobrada dentro de la venta ($155): recibe $200, deja $45 a favor ---")
        vender("Maria", 200, True)
        fisico += 200
        vb1 = venta_id_n(1)
        assert q(page, "SELECT medio, monto FROM venta_pagos WHERE venta_id=?", [vb1]) == [{"medio": "efectivo", "monto": 155}], (
            "La deuda cobrada dentro de la venta debía ir en el efectivo de la venta ($95 + $60)")
        ing = ingresos_de_venta(vb1)
        assert ing == [{"tipo": "vuelto_a_favor", "monto": 45, "medio": "efectivo", "cliente_id": "cli-2"}], f"Ingresos de B1: {ing}"
        verificar("B1")

        print("--- B2) Carlos (debe $60), SIN cobrar la deuda en la venta: el vuelto de $105 cancela $60 y deja $45 ---")
        vender("Carlos", 200, True, cobrar_deuda=False)
        fisico += 200
        vb2 = venta_id_n(2)
        ing = ingresos_de_venta(vb2)
        print(f"ingresos de la venta B2: {ing}")
        assert ing == [{"tipo": "cobro_cliente", "monto": 60, "medio": "efectivo", "cliente_id": "cli-3"},
                       {"tipo": "vuelto_a_favor", "monto": 45, "medio": "efectivo", "cliente_id": "cli-3"}], (
            f"El vuelto debía partirse en $60 de cobranza de deuda + $45 a favor: {ing}")
        cc = q(page, "SELECT tipo, monto FROM cuenta_corriente WHERE venta_id=? ORDER BY monto", [vb2])
        assert cc == [{"tipo": "pago", "monto": -60}, {"tipo": "saldo_favor", "monto": -45}], f"Cuenta corriente de la venta B2: {cc}"
        verificar("B2")

        print("--- C) pago exacto y D) vuelto devuelto en mano: no generan ingresos ---")
        vender("Pedro", 95, False)
        fisico += 95
        vender("Pedro", 200, False)
        fisico += 95            # entraron $200 pero $105 se devolvieron
        assert q(page, "SELECT COUNT(*) AS n FROM ingresos_caja WHERE venta_id IN (?, ?)", [venta_id_n(3), venta_id_n(4)])[0]["n"] == 0, (
            "Un pago exacto / vuelto devuelto no debería generar ningún ingreso")
        verificar("C y D")

        print("--- E) excedente con MercadoPago dejado a favor: no toca el efectivo ---")
        vender("Pedro", 200, True, medio="mercadopago")
        ve = venta_id_n(5)
        assert ingresos_de_venta(ve) == [], "El excedente por MercadoPago no debe generar ingreso de caja (ya va dentro del pago)"
        assert q(page, "SELECT medio, monto FROM venta_pagos WHERE venta_id=?", [ve]) == [{"medio": "mercadopago", "monto": 200}]
        verificar("E")

        print("--- F) anular la venta A: se devuelve ese efectivo (ingreso borrado, con marca) ---")
        ing_id = q(page, "SELECT id FROM ingresos_caja WHERE venta_id=?", [va])[0]["id"]
        res = page.evaluate("(id) => window.SGA_POS.anularVenta(id, 'prueba')", va)
        assert res["success"], f"No pudo anular: {res}"
        assert ingresos_de_venta(va) == [], "Al anular la venta, su ingreso por vuelto tiene que desaparecer"
        assert q(page, "SELECT COUNT(*) AS n FROM eliminaciones WHERE tabla='ingresos_caja' AND registro_id=?", [ing_id])[0]["n"] == 1, (
            "El ingreso se borró sin marca de eliminación")
        fisico -= 200            # se le devuelve al cliente todo lo que había entregado
        verificar("F")

        print("--- G) editar la venta B2: sus movimientos de antes se sacan (después se recrean al confirmar) ---")
        prod = q(page, "SELECT id, precio_venta, costo FROM productos WHERE nombre='Coca-Cola 2L'")[0]
        ses = q(page, "SELECT id FROM sesiones_caja WHERE estado='abierta'")[0]["id"]
        user_id = q(page, "SELECT id FROM usuarios LIMIT 1")[0]["id"]
        r = page.evaluate("""([vid, prod, ses, uid]) => window.SGA_POS.registrarVenta({
            ventaId: vid, sesionCajaId: ses, sucursalId: '1', clienteId: 'cli-3', usuarioId: uid,
            items: [{ productoId: prod.id, cantidad: 1, precioUnitario: prod.precio_venta, costoUnitario: prod.costo, descuentoItem: 0 }],
            pagos: [{ medio: 'efectivo', monto: prod.precio_venta }] })""", [vb2, prod, ses, user_id])
        assert r["success"], f"No pudo re-registrar la venta: {r}"
        assert ingresos_de_venta(vb2) == [], "BUG: al editar la venta quedaron sus ingresos viejos (se duplicarían al confirmar)"
        assert q(page, "SELECT COUNT(*) AS n FROM cuenta_corriente WHERE venta_id=?", [vb2])[0]["n"] == 0, (
            "BUG: al editar la venta quedaron sus movimientos de cuenta corriente viejos (se duplicarían al confirmar)")

        assert_stock_integro(page, "al final de test_pos_vuelto_a_favor_caja.py")
        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - el efectivo que se deja a favor (o cancela deuda) entra a la caja y el saldo esperado coincide con el físico.")
        browser.close()


if __name__ == "__main__":
    main()
