"""
tests/e2e/test_pos_devolucion_reintegro.py — Devolución de producto: la plata
que sale de caja tiene que quedar registrada SIEMPRE, sin importar si la venta
tenía cliente o no.

Bug real reportado por el usuario (22/9/2026): una cajera hizo una devolución
de dinero por un producto defectuoso, pero la caja nunca reflejó esa salida —
al arqueo apareció como "faltante". Causa raíz encontrada leyendo el código
(js/modules/pos.js), tres problemas en la misma función:

  1. `devStep3` (motivo) saltaba DIRECTO a `devStep5` (confirmar) sin pasar por
     `devStep4` (¿cómo se reintegra?) cuando la venta no tenía cliente_id — el
     caso normal de una venta de mostrador. `reintegroTipo` quedaba `null` y
     `registrarDevolucion` no hacía NADA con la plata, en silencio.
  2. `devStep4` mostraba una lista fija de medios (saldo_favor/efectivo/
     mercadopago/transferencia) en vez de leer `medios_cobro` como el resto
     del sistema (regla de CLAUDE.md) — un medio custom no aparecía.
  3. Aun cuando SÍ se preguntaba, `registrarDevolucion` trataba efectivo/
     mercadopago/transferencia igual, escribiendo los tres en `egresos_caja`
     — pero `caja.js getTotalesSesion()` suma TODA `egresos_caja` sin filtrar
     por medio, así que un reintegro por transferencia habría bajado el
     efectivo esperado sin haber salido plata física (bug latente, nunca
     reportado porque requería tener cliente_id para siquiera llegar ahí).

Fix: `devStep4` siempre se muestra (motivo -> reintegro -> confirmar), lee
`medios_cobro` dinámico y solo ofrece "saldo a favor" si hay cliente;
`registrarDevolucion` valida el reintegro ANTES de escribir nada (venta sin
cliente + saldo_favor, o efectivo sin caja abierta -> error claro, sin dejar
stock/devolución a medias) y solo escribe en `egresos_caja` cuando el medio es
'efectivo' específicamente, con `tipo='reintegro_devolucion'`.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_pos_devolucion_reintegro.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def crear_venta(page, producto_id, sucursal_id, usuario_id, sesion_id, cantidad=1, precio=95):
    r = page.evaluate(
        """([pid, suc, u, ses, cant, precio]) => window.SGA_POS.registrarVenta({
              sesionCajaId: ses, sucursalId: suc, usuarioId: u, clienteId: null, descuentoGlobal: 0,
              items: [{ productoId: pid, cantidad: cant, precioUnitario: precio, costoUnitario: precio / 2, descuentoItem: 0 }],
              pagos: [{ medio: 'efectivo', monto: cant * precio }] })""",
        [producto_id, sucursal_id, usuario_id, sesion_id, cantidad, precio],
    )
    assert r["success"], f"No se pudo crear la venta de prueba: {r}"
    return r["ventaId"]


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: (errors.append(f"alert inesperado: {d.message}"), d.accept()))

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        abrir_caja_si_hace_falta(page)

        ids = page.evaluate("""
          () => ({
            sucursalId: '1',
            usuarioId: window.SGA_Auth.getCurrentUser().id,
            sesion: window.SGA_Caja.getSesionActiva('1'),
            productoId: window.SGA_DB.query(`SELECT id FROM productos WHERE nombre = 'Coca-Cola 2L'`)[0].id,
          })
        """)
        suc, usr, sesion, prod = ids["sucursalId"], ids["usuarioId"], ids["sesion"], ids["productoId"]
        assert sesion, "No hay sesion de caja activa tras abrir_caja_si_hace_falta"

        # ================================================================
        # Escenario 1 (el bug reportado): venta de mostrador, sin cliente,
        # reintegro en EFECTIVO -> tiene que aparecer en egresos_caja.
        # ================================================================
        print("--- Escenario 1: venta sin cliente + devolucion en efectivo ---")
        venta1 = crear_venta(page, prod, suc, usr, sesion["id"], cantidad=1, precio=95)

        egresos_antes = page.evaluate("() => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM egresos_caja`)[0].n")

        page.locator("#btn-devolucion-header").click()
        page.wait_for_timeout(200)

        page.fill("#dev-search-input", venta1)
        page.locator("#btn-dev-buscar").click()
        page.wait_for_timeout(200)
        page.locator(".dev-venta-row").first.click()
        page.wait_for_timeout(200)

        page.fill(".dev-qty-input", "1")
        page.locator("#btn-dev-next2").click()
        page.wait_for_timeout(200)

        page.locator('input[name="dev-motivo"][value="no_queria"]').check()
        page.locator("#btn-dev-next3").click()
        page.wait_for_timeout(200)

        # --- Assert critico: NO debe saltarse a "Confirmar" ---
        titulo = page.locator("#dev-modal-title").inner_text()
        reintegro_inputs = page.locator('input[name="dev-reintegro"]')
        assert reintegro_inputs.count() > 0, (
            f"BUG: la venta no tiene cliente y el modal salto el paso de reintegro "
            f"(titulo actual: {titulo!r}) -- exactamente el bug reportado: la cajera "
            f"nunca llega a elegir como se devuelve la plata."
        )
        print(f"   OK - se muestra el paso de reintegro (titulo: {titulo!r})")

        # --- Medios dinamicos: efectivo + mercadopago (seed), sin saldo_favor (sin cliente) ---
        valores = page.locator('input[name="dev-reintegro"]').evaluate_all("els => els.map(e => e.value)")
        assert set(valores) == {"efectivo", "mercadopago"}, (
            f"Las opciones de reintegro deberian salir de medios_cobro (efectivo, mercadopago) "
            f"y NO incluir 'saldo_favor' (sin cliente): {valores}"
        )
        print(f"   OK - opciones de reintegro dinamicas: {valores}")

        page.locator('input[name="dev-reintegro"][value="efectivo"]').check()
        page.locator("#btn-dev-next4").click()
        page.wait_for_timeout(200)

        page.locator("#btn-dev-confirmar").click()
        page.wait_for_timeout(300)

        egreso = page.evaluate("""
          () => window.SGA_DB.query(
            `SELECT * FROM egresos_caja WHERE tipo = 'reintegro_devolucion' ORDER BY fecha DESC LIMIT 1`
          )[0]
        """)
        assert egreso, "No se creo ninguna fila en egresos_caja con tipo='reintegro_devolucion'"
        assert abs(egreso["monto"] - 95) < 0.01, f"Monto de reintegro inesperado: {egreso}"
        egresos_despues = page.evaluate("() => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM egresos_caja`)[0].n")
        assert egresos_despues == egresos_antes + 1, (
            f"Se esperaba exactamente 1 egreso nuevo, hay {egresos_despues - egresos_antes}"
        )
        print(f"   OK - egresos_caja recibio el reintegro: ${egreso['monto']}")

        # ================================================================
        # Escenario 2: reintegro por un medio NO efectivo -> no debe tocar
        # egresos_caja (esa plata nunca estuvo en el cajon fisico).
        # ================================================================
        print("--- Escenario 2: venta sin cliente + devolucion por Mercado Pago (no debe afectar la caja) ---")
        venta2 = crear_venta(page, prod, suc, usr, sesion["id"], cantidad=1, precio=95)
        egresos_antes2 = page.evaluate("() => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM egresos_caja`)[0].n")

        page.locator("#btn-devolucion-header").click()
        page.wait_for_timeout(200)
        page.fill("#dev-search-input", venta2)
        page.locator("#btn-dev-buscar").click()
        page.wait_for_timeout(200)
        page.locator(".dev-venta-row").first.click()
        page.wait_for_timeout(200)
        page.fill(".dev-qty-input", "1")
        page.locator("#btn-dev-next2").click()
        page.wait_for_timeout(200)
        page.locator('input[name="dev-motivo"][value="no_queria"]').check()
        page.locator("#btn-dev-next3").click()
        page.wait_for_timeout(200)
        page.locator('input[name="dev-reintegro"][value="mercadopago"]').check()
        page.locator("#btn-dev-next4").click()
        page.wait_for_timeout(200)
        page.locator("#btn-dev-confirmar").click()
        page.wait_for_timeout(300)

        egresos_despues2 = page.evaluate("() => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM egresos_caja`)[0].n")
        assert egresos_despues2 == egresos_antes2, (
            f"Un reintegro por Mercado Pago NO deberia crear un egreso de caja "
            f"(esa plata nunca estuvo en el cajon fisico): antes={egresos_antes2}, despues={egresos_despues2}"
        )
        reintegro_tipo = page.evaluate(
            "(vid) => window.SGA_DB.query(`SELECT reintegro_tipo FROM devoluciones WHERE venta_id = ?`, [vid])[0].reintegro_tipo",
            venta2,
        )
        assert reintegro_tipo == "mercadopago", f"reintegro_tipo inesperado: {reintegro_tipo!r}"
        print("   OK - Mercado Pago no afecto egresos_caja, quedo registrado en devoluciones.reintegro_tipo")

        # ================================================================
        # Escenario 3: registrarDevolucion() valida ANTES de escribir nada
        # (llamado directo, sin UI, mismo patron que test_stock_ledger.py).
        # ================================================================
        print("--- Escenario 3: validaciones de registrarDevolucion (sin efectos parciales) ---")
        venta3 = crear_venta(page, prod, suc, usr, sesion["id"], cantidad=1, precio=95)
        stock_antes = page.evaluate(
            "([p, s]) => window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?`, [p, s])[0].cantidad",
            [prod, suc],
        )
        devoluciones_antes = page.evaluate("() => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM devoluciones`)[0].n")

        casos = [
            ("sin reintegroTipo", None, None, "reintegra"),
            ("saldo_favor sin cliente", "saldo_favor", {"id": sesion["id"]}, "saldo a favor"),
            ("efectivo sin caja abierta", "efectivo", None, "caja abierta"),
        ]
        for nombre, reintegro_tipo, ses_arg, fragmento_error in casos:
            r = page.evaluate(
                """([vid, pid, rt, ses]) => window.SGA_POS.registrarDevolucion(
                      vid, [{ productoId: pid, cantidad: 1, precio: 95 }], 'no_queria', rt, ses
                   )""",
                [venta3, prod, reintegro_tipo, ses_arg],
            )
            assert not r["success"], f"Caso {nombre!r} deberia fallar, dio success: {r}"
            assert fragmento_error in r["error"].lower(), f"Caso {nombre!r}: error inesperado: {r['error']!r}"
            print(f"   OK - {nombre}: rechazado con error claro ({r['error']!r})")

        stock_despues = page.evaluate(
            "([p, s]) => window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?`, [p, s])[0].cantidad",
            [prod, suc],
        )
        devoluciones_despues = page.evaluate("() => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM devoluciones`)[0].n")
        assert stock_despues == stock_antes, (
            f"Una devolucion RECHAZADA no deberia tocar el stock: antes={stock_antes}, despues={stock_despues}"
        )
        assert devoluciones_despues == devoluciones_antes, (
            f"Una devolucion RECHAZADA no deberia crear fila en 'devoluciones': "
            f"antes={devoluciones_antes}, despues={devoluciones_despues}"
        )
        print("   OK - ninguno de los 3 casos rechazados dejo stock ni devolucion a medias")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pos_devolucion_reintegro.png"), full_page=True)

        assert not errors, f"Errores JS/alerts inesperados en pagina: {errors}"
        browser.close()
        print("\nOK - test_pos_devolucion_reintegro: PASA")


if __name__ == "__main__":
    main()
