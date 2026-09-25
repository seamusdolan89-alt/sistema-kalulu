"""
tests/e2e/test_cuenta_corriente_anular_pago.py — Anular un pago a proveedor
cargado por error (Cuentas Corrientes, solo Admin-POS + admin).

Antes no había forma de revertir un pago (ej. uno cargado al proveedor
equivocado). Anular = BORRAR el pago con sus medios e imputaciones y dejar
marca de borrado (mismo patrón que eliminarPago de los cobros de clientes):
el saldo y el crédito se corrigen solos y las facturas que saldaba vuelven a
quedar pendientes.

Reglas de caja (solo un pago en EFECTIVO tiene egreso en la caja):
  - caja abierta -> se revierte el egreso (la caja esperada se corrige sola);
  - caja cerrada -> aviso; si se acepta, se anula solo en la cuenta corriente
    del proveedor y la caja NO se toca (el arqueo ya se hizo);
  - transferencia y demás medios -> no tocan la caja.

Cubre (Admin-POS): pago por transferencia imputado a una factura; pago sin
imputar (crédito); efectivo con caja abierta; efectivo con caja cerrada (la
capa de datos exige confirmación, y al confirmar la caja queda intacta).
Y en el POS del local el botón "Anular" no aparece ni la capa de datos deja.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_cuenta_corriente_anular_pago.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const usuarioId = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
  const prov = window.SGA_DB.query(`SELECT id, razon_social FROM proveedores ORDER BY razon_social LIMIT 1`)[0];
  const compra = (id, nro, total, fecha) => {
    window.SGA_DB.run(
      `INSERT INTO compras (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_factura, factura_pv,
         total, total_factura, condicion_pago, estado, sync_status, updated_at)
       VALUES (?, '1', ?, ?, ?, ?, '0001', ?, ?, 'pendiente', 'confirmada', 'pending', ?)`,
      [id, prov.id, usuarioId, fecha, nro, total, total, now]);
    window.SGA_DB.run(
      `INSERT INTO compra_items (id, compra_id, cantidad, costo_unitario, subtotal, tipo)
       VALUES (?, ?, 1, ?, ?, 'producto')`, [id + '-i', id, total, total]);
  };
  compra('c-anul-1', '1001', 1000, '2026-09-01T10:00:00.000Z');
  compra('c-anul-2', '1002', 200,  '2026-09-02T10:00:00.000Z');   // queda impaga: el proveedor sigue en la lista
  window.SGA_DB.run(
    `INSERT INTO sesiones_caja (id, sucursal_id, usuario_apertura_id, fecha_apertura, saldo_inicial, estado, sync_status, updated_at)
     VALUES ('ses-abierta', '1', ?, ?, 0, 'abierta', 'pending', ?)`, [usuarioId, now, now]);
  return { provId: prov.id, provNombre: prov.razon_social, usuarioId };
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def crear_pago(page, info, metodos, auto_imputar=True):
    r = page.evaluate("""([info, metodos, auto]) => window.SGA_PagosProveedores.crearPago({
        proveedor_id: info.provId, fecha: '2026-09-20', usuario_id: info.usuarioId,
        metodos, auto_imputar: auto })""", [info, metodos, auto_imputar])
    assert r["success"], f"No se pudo crear el pago de prueba: {r}"
    return r["id"]


def saldo(page, info):
    return round(page.evaluate("(id) => window.SGA_PagosProveedores.getSaldoProveedor(id)", info["provId"]), 2)


def abrir_detalle(page, info, modo):
    """Recarga el módulo (estado limpio) y abre el extracto del proveedor en la vista pedida."""
    page.evaluate("window.location.hash = 'inicio'")
    page.wait_for_timeout(200)
    page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
    page.wait_for_timeout(500)
    page.locator(f'.btn-ver-detalle[data-id="{info["provId"]}"]').click()
    page.wait_for_timeout(300)
    page.locator("#btn-ledger-plano" if modo == "plano" else "#btn-ledger-agrupado").click()
    page.wait_for_timeout(200)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []

        def nuevo_contexto():
            ctx = browser.new_context(viewport={"width": 1500, "height": 1000})
            ctx.route("**/*", block_firebase)
            enable_dev_mode(ctx)
            page = ctx.new_page()
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.on("dialog", lambda d: d.accept())
            return ctx, page

        # ── Admin-POS ─────────────────────────────────────────────────────────
        ctx, page = nuevo_contexto()
        print("--- Login admin-pos + seed + 2 facturas y una caja abierta ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        info = page.evaluate(SEMBRAR)
        assert saldo(page, info) == 1200, f"Saldo inicial inesperado: {saldo(page, info)}"

        # 1) Transferencia imputada a una factura ------------------------------
        print("--- 1) Pago por transferencia imputado a la factura 0001-1001 ---")
        pago1 = crear_pago(page, info, [{"metodo": "transferencia", "monto": 1000}])
        assert saldo(page, info) == 200
        assert q(page, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE pago_id=?", [pago1])[0]["n"] == 1
        abrir_detalle(page, info, "plano")
        btn = page.locator(f'[data-anular-pago="{pago1}"]')
        assert btn.count() == 1, "No aparece el botón Anular en la fila del pago (ledger cronológico)"
        btn.click()
        page.wait_for_timeout(300)
        modal = page.locator("#ccprov-overlay").inner_text()
        print(f"Modal: {modal[:300]!r}")
        assert "0001-1001" in modal, "El modal no lista la factura a la que estaba aplicado el pago"
        assert "vuelven a quedar pendientes" in modal, "El modal no avisa que la factura vuelve a quedar pendiente"
        assert "No afecta la caja" in modal, "Una transferencia no debería tocar la caja"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "anular_pago_modal.png"))
        page.locator("#btn-anular-ok").click()
        page.wait_for_timeout(400)
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [pago1])[0]["n"] == 0, "El pago sigue existiendo"
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores_metodos WHERE pago_id=?", [pago1])[0]["n"] == 0, "Quedaron medios huérfanos"
        assert q(page, "SELECT COUNT(*) AS n FROM imputaciones_pagos WHERE pago_id=?", [pago1])[0]["n"] == 0, "Quedaron imputaciones huérfanas"
        assert q(page, "SELECT COUNT(*) AS n FROM eliminaciones WHERE tabla='pagos_proveedores' AND registro_id=?", [pago1])[0]["n"] == 1, (
            "No quedó la marca de borrado: el otro dispositivo resucitaría el pago")
        assert saldo(page, info) == 1200, f"BUG: al anular, la factura no volvió a quedar pendiente (saldo {saldo(page, info)})"

        # 2) Pago sin imputar (crédito) ----------------------------------------
        print("--- 2) Pago sin imputar (crédito a favor) ---")
        pago2 = crear_pago(page, info, [{"metodo": "transferencia", "monto": 500}], auto_imputar=False)
        assert saldo(page, info) == 700
        abrir_detalle(page, info, "agrupado")
        btn = page.locator(f'.ledger-orphan-section [data-anular-pago="{pago2}"]')
        assert btn.count() == 1, "No aparece Anular en 'Pagos sin imputar'"
        btn.click()
        page.wait_for_timeout(300)
        assert "crédito a favor" in page.locator("#ccprov-overlay").inner_text(), "El modal no avisa que se pierde el crédito"
        page.locator("#btn-anular-ok").click()
        page.wait_for_timeout(400)
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [pago2])[0]["n"] == 0
        assert saldo(page, info) == 1200, f"Saldo tras anular el crédito: {saldo(page, info)}"

        # 3) Efectivo con la caja ABIERTA --------------------------------------
        print("--- 3) Pago en efectivo, caja abierta: se revierte el egreso ---")
        pago3 = crear_pago(page, info, [{"metodo": "efectivo", "monto": 300, "sesion_caja_id": "ses-abierta"}])
        egresos = q(page, "SELECT id, monto FROM egresos_caja WHERE sesion_caja_id='ses-abierta'")
        assert len(egresos) == 1 and egresos[0]["monto"] == 300, f"crearPago no dejó su egreso: {egresos}"
        egreso3 = egresos[0]["id"]
        abrir_detalle(page, info, "plano")
        page.locator(f'[data-anular-pago="{pago3}"]').click()
        page.wait_for_timeout(300)
        assert "Se revierte el egreso" in page.locator("#ccprov-overlay").inner_text(), "El modal no explica la reversión de caja"
        page.locator("#btn-anular-ok").click()
        page.wait_for_timeout(400)
        assert q(page, "SELECT COUNT(*) AS n FROM egresos_caja WHERE sesion_caja_id='ses-abierta'")[0]["n"] == 0, (
            "BUG: anulando un pago en efectivo con la caja abierta, el egreso quedó en la caja")
        assert q(page, "SELECT COUNT(*) AS n FROM eliminaciones WHERE tabla='egresos_caja' AND registro_id=?", [egreso3])[0]["n"] == 1, (
            "El egreso se borró sin marca: volvería del otro dispositivo")
        assert saldo(page, info) == 1200

        # 4) Efectivo con la caja CERRADA --------------------------------------
        print("--- 4) Pago en efectivo, caja cerrada: pide confirmación y NO toca la caja ---")
        pago4 = crear_pago(page, info, [{"metodo": "efectivo", "monto": 250, "sesion_caja_id": "ses-abierta"}])
        page.evaluate("window.SGA_DB.run(`UPDATE sesiones_caja SET estado='cerrada', fecha_cierre=? WHERE id='ses-abierta'`, [new Date().toISOString()])")
        sin_ok = page.evaluate("(id) => window.SGA_PagosProveedores.anularPago(id)", pago4)
        print(f"anularPago sin confirmar: {sin_ok}")
        assert not sin_ok["success"] and sin_ok.get("requiereConfirmacionCaja"), (
            f"Con la caja cerrada tiene que pedir confirmación, no anular: {sin_ok}")
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [pago4])[0]["n"] == 1, "Anuló sin que se confirmara"

        abrir_detalle(page, info, "plano")
        page.locator(f'[data-anular-pago="{pago4}"]').click()
        page.wait_for_timeout(300)
        modal = page.locator("#ccprov-overlay").inner_text()
        print(f"Modal caja cerrada: {modal[:400]!r}")
        assert "ya se cerró" in modal and "la caja no se modifica" in modal, "Falta el aviso de caja cerrada"
        assert "otro egreso" in modal, "Falta la advertencia de que recargarlo en efectivo genera otro egreso"
        assert "Anular igualmente" in page.locator("#btn-anular-ok").inner_text(), "El botón debería decir 'Anular igualmente'"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "anular_pago_caja_cerrada.png"))
        page.locator("#btn-anular-ok").click()
        page.wait_for_timeout(400)
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [pago4])[0]["n"] == 0, "El pago no se anuló al confirmar"
        egr = q(page, "SELECT COUNT(*) AS n FROM egresos_caja WHERE sesion_caja_id='ses-abierta'")[0]["n"]
        assert egr == 1, f"BUG: se tocó una caja CERRADA (quedaron {egr} egresos, debía quedar 1 intacto)"
        assert q(page, "SELECT estado FROM sesiones_caja WHERE id='ses-abierta'")[0]["estado"] == "cerrada"
        assert saldo(page, info) == 1200
        ctx.close()

        # ── POS del local: no se puede anular ─────────────────────────────────
        print("--- POS del local: el botón no aparece y la capa de datos no deja ---")
        ctx, page = nuevo_contexto()
        login_via_seed(page)
        page.evaluate("window.location.hash = 'cuenta_corriente_proveedores'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        info_pos = page.evaluate(SEMBRAR)
        pago_pos = crear_pago(page, info_pos, [{"metodo": "transferencia", "monto": 100}])
        abrir_detalle(page, info_pos, "plano")
        assert page.locator("#btn-ledger-plano").count() == 1, "No abrió el extracto en el POS"
        assert page.locator("[data-anular-pago]").count() == 0, "BUG: el POS del local muestra el botón Anular"
        res = page.evaluate("(id) => window.SGA_PagosProveedores.anularPago(id)", pago_pos)
        assert not res["success"], f"BUG: el POS del local pudo anular un pago: {res}"
        assert q(page, "SELECT COUNT(*) AS n FROM pagos_proveedores WHERE id=?", [pago_pos])[0]["n"] == 1
        ctx.close()

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - Anular pago: transferencia, crédito, efectivo con caja abierta y cerrada; el POS no puede.")
        browser.close()


if __name__ == "__main__":
    main()
