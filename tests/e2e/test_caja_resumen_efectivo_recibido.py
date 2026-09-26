"""
tests/e2e/test_caja_resumen_efectivo_recibido.py — El resumen que se genera al cerrar la
caja muestra TODO el efectivo recibido, desglosado, y los totales coinciden.

Pedido del usuario: en el resumen del turno tiene que haber una sección "Efectivo recibido"
que diferencie cuánto entró por cobranza de ventas (lo normal), cuánto por cobranza de deuda y
cuánto por vuelto dejado a favor. Con todo a la vista los totales coinciden y la caja puede
cerrar sin diferencias.

Cubre (POS, con datos reales de una caja):
  - ventas en efectivo (una con vuelto dejado a favor), un cobro de deuda en efectivo, un
    ingreso extra manual, un egreso, y un cobro de deuda por MercadoPago;
  - pestaña "Egresos e Ingresos": los ingresos en efectivo con su TIPO (cobranza de deuda,
    vuelto dejado a favor, ingreso extra); el cobro por MercadoPago NO figura ahí (no entra al cajón);
  - pestaña Resumen: tarjeta "Ingresos" con el desglose (saldo inicial + ventas + ingresos -
    egresos = saldo esperado);
  - cierre: el esperado de MercadoPago incluye el cobro de deuda (antes solo ventas) y se cierra sin
    diferencias;
  - resumen del turno: "Efectivo recibido" (ventas / deuda / vuelto a favor / otros / total), "Otros
    medios recibidos" y "Saldo de caja" con los mismos totales: inicial + efectivo recibido - egresos
    = esperado = contado.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_caja_resumen_efectivo_recibido.py
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
SALDO_INICIAL = 1000


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def peso(txt):
    """'$ 1.330,00' / '-$ 30,00' -> float"""
    limpio = re.sub(r"[^\d,\-]", "", txt.replace(".", "")).replace(",", ".")
    return float(limpio) if limpio not in ("", "-") else 0.0


def filas(page, selector):
    """{etiqueta: valor numérico} de las .caja-stat-row de un bloque"""
    pares = page.evaluate("""(sel) => [...document.querySelectorAll(sel + ' .caja-stat-row')].map(r => {
        const s = r.querySelectorAll('span'); return [s[0]?.innerText.trim(), s[1]?.innerText.trim()]; })""", selector)
    return {a: peso(b) for a, b in pares if a and b}


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1600, "height": 1300})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS + caja abierta ($1000) + clientes ---")
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
          cli('cli-4', 'Pedro', 'Ruiz');
          window.SGA_DB.run(`INSERT INTO cuenta_corriente (id, cliente_id, tipo, monto, descripcion, fecha, sync_status, updated_at)
                             VALUES ('cc-d2', 'cli-2', 'venta_fiada', 100, 'Deuda previa', ?, 'pending', ?)`, [now, now]);
        }""")
        abrir_caja_si_hace_falta(page, saldo_inicial=SALDO_INICIAL)

        def vender(cliente, recibe, tildar):
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
            page.locator("#recibe-efectivo").fill(str(recibe))
            page.wait_for_timeout(300)
            if tildar:
                page.locator("#chk-saldo-favor").check(force=True)
                page.wait_for_timeout(200)
            page.locator("#btn-confirm-venta").click()
            page.wait_for_timeout(700)
            page.locator("#btn-ticket-confirmar").click()
            page.wait_for_timeout(600)

        print("--- Movimientos: venta exacta $95, venta de $95 pagada con $200 dejando $105 a favor ---")
        vender("Pedro", 95, False)
        vender("Juan", 200, True)

        print("--- Cobro de deuda de Maria: $40 en efectivo y $15 por MercadoPago; ingreso extra $25; egreso $30 ---")
        page.evaluate("async () => { await import('/js/modules/clientes.js'); }")
        page.evaluate("""() => {
          const ses = window.SGA_DB.query(`SELECT id FROM sesiones_caja WHERE estado='abierta'`)[0].id;
          const uid = window.SGA_DB.query(`SELECT id FROM usuarios LIMIT 1`)[0].id;
          window.SGA_Clientes.registrarPago('cli-2', { monto: 40, medio: 'efectivo', usuarioId: uid, sesionCajaId: ses });
          window.SGA_Clientes.registrarPago('cli-2', { monto: 15, medio: 'mercadopago', usuarioId: uid, sesionCajaId: ses });
          const now = new Date().toISOString();
          window.SGA_DB.run(`INSERT INTO ingresos_caja (id, sesion_caja_id, monto, descripcion, fecha, usuario_id, sync_status, updated_at)
                             VALUES ('ing-extra', ?, 25, 'Aporte extra', ?, ?, 'pending', ?)`, [ses, now, uid, now]);
          window.SGA_DB.run(`INSERT INTO egresos_caja (id, sesion_caja_id, monto, descripcion, tipo, fecha, usuario_id, sync_status, updated_at)
                             VALUES ('egr-1', ?, 30, 'Bolsas', 'gasto_operativo', ?, ?, 'pending', ?)`, [ses, now, uid, now]);
        }""")
        # Lo que hay de verdad en el cajón: 1000 + 95 (exacta) + 200 (la de $95 pagada con $200, sin devolver
        # el vuelto) + 40 (deuda) + 25 (extra) - 30 (egreso)
        fisico = SALDO_INICIAL + 95 + 200 + 40 + 25 - 30

        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        print("--- Pestaña 'Egresos e Ingresos': ingresos en efectivo con su tipo; el cobro por MP no figura ---")
        page.get_by_text("Egresos e Ingresos", exact=True).click()
        page.wait_for_timeout(300)
        contenido = page.locator("#caja-tab-content").inner_text()
        print(contenido[:600].replace("\n", " | "))
        for tipo in ("Cobranza de deuda", "Vuelto dejado a favor", "Ingreso extra"):
            assert tipo in contenido, f"Falta el tipo de ingreso {tipo!r} en la lista: {contenido[:500]!r}"
        assert "105,00" in contenido and "40,00" in contenido and "25,00" in contenido, "Faltan importes de los ingresos"
        ingresos_html = page.locator("#caja-tab-content table").nth(1).inner_text()
        assert "15,00" not in ingresos_html, "El cobro por MercadoPago NO debe figurar entre los ingresos en efectivo"
        assert "Bolsas" in contenido, "Falta el egreso"

        print("--- Pestaña Resumen: tarjeta Ingresos con el desglose ---")
        page.get_by_text("Resumen", exact=True).click()
        page.wait_for_timeout(300)
        txt = page.locator("#caja-tab-content").inner_text()
        low = txt.lower()      # las etiquetas de las tarjetas se ven en mayúsculas (CSS)
        assert "ingresos" in low and "170,00" in txt, f"Falta la tarjeta Ingresos (105 + 40 + 25 = 170): {txt[:500]!r}"
        assert "deuda" in low and "vuelto a favor" in low and "extra" in low, "Falta el desglose de ingresos en la tarjeta"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_resumen_ingresos.png"), full_page=True)

        print("--- Cierre de caja: el esperado de MercadoPago incluye el cobro de deuda ---")
        page.locator("#btn-cierre-caja").click()
        page.wait_for_timeout(500)
        esperado = page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.cierre-verificacion-table tbody tr[data-medio]')]
            .map(tr => [tr.dataset.medio, tr.querySelectorAll('td')[1].innerText.trim()]))""")
        print(f"Esperado por medio: {esperado}")
        assert peso(esperado["efectivo"]) == fisico, f"Esperado en efectivo {esperado['efectivo']} vs físico {fisico}"
        assert peso(esperado.get("mercadopago", "0")) == 15, (
            f"BUG: el esperado de MercadoPago no incluye el cobro de deuda de $15: {esperado}")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_cierre_modal_efectivo_recibido.png"), full_page=True)
        assert not page.locator("#btn-cierre-confirm").is_disabled(), "Hay diferencias sin explicar: la caja no cierra"
        page.locator("#btn-cierre-confirm").click()
        page.wait_for_timeout(600)

        print("--- Resumen del turno: Efectivo recibido desglosado y totales que coinciden ---")
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_resumen_turno_efectivo_recibido.png"), full_page=True)
        assert "Resumen del turno" in page.locator("#app").inner_text()
        ef = filas(page, "#postcaja-efectivo-recibido")
        print(f"Efectivo recibido: {ef}")
        assert ef.get("Cobranza de ventas") == 190, f"Cobranza de ventas (95 + 95): {ef}"
        assert ef.get("Cobranza de deuda") == 40, f"Cobranza de deuda: {ef}"
        assert ef.get("Vuelto dejado a favor") == 105, f"Vuelto dejado a favor: {ef}"
        assert ef.get("Otros ingresos") == 25, f"Otros ingresos: {ef}"
        total_ef = ef.get("TOTAL EFECTIVO RECIBIDO")
        assert total_ef == 190 + 40 + 105 + 25, f"El total no es la suma de las partes: {ef}"

        otros = filas(page, "#postcaja-otros-medios")
        print(f"Otros medios: {otros}")
        assert otros.get("Mercado Pago") == 15 and otros.get("TOTAL OTROS MEDIOS") == 15, f"Otros medios: {otros}"
        assert "Cobranza de deuda" in page.locator("#postcaja-otros-medios").inner_text(), "Falta el detalle de la deuda cobrada por MercadoPago"

        saldo = page.evaluate("""() => { const sec = [...document.querySelectorAll('.postcaja-section')].find(s => s.innerText.toLowerCase().includes('saldo de caja'));
            return [...sec.querySelectorAll('.caja-stat-row')].map(r => { const s = r.querySelectorAll('span'); return [s[0].innerText.trim(), s[1].innerText.trim()]; }); }""")
        saldo = {a: peso(b) for a, b in saldo}
        print(f"Saldo de caja: {saldo}")
        inicial = saldo["Saldo inicial"]
        egresos = abs(saldo["− Egresos"])
        assert inicial + total_ef - egresos == saldo["Saldo esperado"] == fisico, (
            f"BUG: los totales no coinciden: inicial {inicial} + recibido {total_ef} - egresos {egresos} "
            f"vs esperado {saldo['Saldo esperado']} vs físico {fisico}")
        assert saldo["Saldo informado (contado)"] == fisico and abs(saldo["Diferencia"]) < 0.005, f"La caja debía cerrar sin diferencia: {saldo}"

        print("--- Historial > Resumen de la sesión cerrada: mismo desglose ---")
        page.locator("#btn-aceptar-resumen").click()
        page.wait_for_timeout(500)
        # Sin caja abierta la pantalla muestra "Cajas anteriores" con su historial
        page.locator(".btn-resumen-sesion").first.click()
        page.wait_for_timeout(300)
        modal = page.locator(".caja-modal").inner_text() if page.locator(".caja-modal").count() else page.locator("#app").inner_text()
        for txt_ in ("cobranza de ventas", "cobranza de deuda", "vuelto dejado a favor"):
            assert txt_ in modal, f"Falta {txt_!r} en el resumen de la sesión del historial: {modal[:500]!r}"

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - el resumen del turno desglosa el efectivo recibido y los totales coinciden con el saldo esperado.")
        browser.close()


if __name__ == "__main__":
    main()
