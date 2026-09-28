"""
tests/e2e/test_aprobaciones_pendientes_doble.py — Aprobar (o rechazar) un ajuste de
stock que otra pestaña/compu YA resolvió no vuelve a tocar el stock.

Bug reportado: el dueño suele tener varias pestañas de Admin-POS abiertas a la vez.
aprobar()/rechazar() en aprobaciones_pendientes.js nunca chequeaban que el
stock_ajustes.estado siguiera 'pendiente_aprobacion' antes de actuar — si dos
pestañas (o una lista sin refrescar tras un sync) mostraban el mismo ítem como
pendiente y las dos lo aprobaban, el stock se descontaba DOS VECES para el mismo
movimiento real.

Cubre:
  1. Aprobar un ajuste descuenta el stock una vez y crea un consumo_interno.
  2. Volver a "aprobar" el MISMO id (la pestaña vieja, sin refrescar) avisa que ya
     se resolvió y NO descuenta el stock de nuevo ni crea un segundo consumo_interno.
  3. Rechazar un ajuste ya aprobado por otro lado tampoco hace nada (ni al revés:
     aprobar uno ya rechazado).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_aprobaciones_pendientes_doble.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, assert_stock_integro

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def sembrar_ajuste(page, id_, cantidad):
    return page.evaluate("""([id, cantidad]) => {
        const now = new Date().toISOString();
        const prod = window.SGA_DB.query(`SELECT id FROM productos WHERE nombre = 'Coca-Cola 2L'`)[0];
        window.SGA_DB.run(
          `INSERT INTO stock_ajustes
             (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado, sync_status, updated_at)
           VALUES (?, ?, '1', 'ajuste_negativo', ?, 'devolucion_defectuoso', ?, ?, 'pendiente_aprobacion', 'pending', ?)`,
          [id, prod.id, cantidad, window.SGA_Auth.getCurrentUser().id, now, now]
        );
        return prod.id;
    }""", [id_, cantidad])


def stock_de(page, prod_id):
    return page.evaluate(
        "(id) => window.SGA_DB.query(`SELECT cantidad FROM stock WHERE producto_id=?`, [id])[0].cantidad", prod_id)


def n_consumo_interno(page, prod_id):
    return page.evaluate(
        "(id) => window.SGA_DB.query(`SELECT COUNT(*) AS n FROM consumo_interno WHERE producto_id=?`, [id])[0].n",
        prod_id)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        dialogos = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: (dialogos.append(d.message), d.accept()))

        print("--- Login admin-pos + seed in place ---")
        login_via_seed(page, admin_pos=True)

        print("--- Sembrar un ajuste pendiente (2 unidades) y aprobarlo desde la UI (pestaña 1) ---")
        prod_id = sembrar_ajuste(page, "ajuste-doble-1", 2)
        stock_antes = stock_de(page, prod_id)
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        page.locator('[data-aprobar="ajuste-doble-1"]').click()
        page.wait_for_timeout(300)
        assert stock_de(page, prod_id) == stock_antes - 2, "El stock no bajó tras aprobar la primera vez"
        assert n_consumo_interno(page, prod_id) == 1, "Debía crear un consumo_interno"
        estado1 = page.evaluate("() => window.SGA_DB.query(`SELECT estado FROM stock_ajustes WHERE id='ajuste-doble-1'`)[0].estado")
        assert estado1 == "aprobado"

        print("--- 'Pestaña 2', sin refrescar: intenta aprobar el MISMO ajuste otra vez ---")
        n_dialogos_antes = len(dialogos)
        page.evaluate("() => window.SGA_AprobacionesPendientes.aprobar('ajuste-doble-1')")
        page.wait_for_timeout(200)
        nuevos = dialogos[n_dialogos_antes:]
        print(f"Diálogos nuevos: {nuevos}")
        assert nuevos and "ya se aprobó" in nuevos[-1], f"Debía avisar que ya se aprobó: {nuevos}"
        assert stock_de(page, prod_id) == stock_antes - 2, (
            f"BUG: el stock se descontó una segunda vez (quedó en {stock_de(page, prod_id)}, "
            f"debía seguir en {stock_antes - 2})")
        assert n_consumo_interno(page, prod_id) == 1, "BUG: se creó un segundo consumo_interno para el mismo ajuste"

        print("--- Rechazar un ajuste ya aprobado (por 'otra compu'): no debe hacer nada ---")
        n_dialogos_antes = len(dialogos)
        page.evaluate("() => window.SGA_AprobacionesPendientes.rechazar('ajuste-doble-1')")
        page.wait_for_timeout(200)
        nuevos = dialogos[n_dialogos_antes:]
        assert nuevos and "ya se aprobó" in nuevos[-1], f"Rechazar sobre un ya-aprobado debía avisarlo: {nuevos}"
        estado2 = page.evaluate("() => window.SGA_DB.query(`SELECT estado FROM stock_ajustes WHERE id='ajuste-doble-1'`)[0].estado")
        assert estado2 == "aprobado", "El estado no debía cambiar a rechazado"

        print("--- Simétrico: aprobar un ajuste ya rechazado (por 'otra compu') tampoco descuenta stock ---")
        prod_id2 = sembrar_ajuste(page, "ajuste-doble-2", 5)
        stock_antes2 = stock_de(page, prod_id2)
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(150)
        page.evaluate("window.location.hash = 'aprobaciones_pendientes'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.locator('[data-rechazar="ajuste-doble-2"]').click()
        page.wait_for_timeout(300)
        assert stock_de(page, prod_id2) == stock_antes2, "Rechazar no debía tocar el stock"

        n_dialogos_antes = len(dialogos)
        page.evaluate("() => window.SGA_AprobacionesPendientes.aprobar('ajuste-doble-2')")
        page.wait_for_timeout(200)
        nuevos = dialogos[n_dialogos_antes:]
        assert nuevos and "ya se rechazó" in nuevos[-1], f"Aprobar sobre un ya-rechazado debía avisarlo: {nuevos}"
        assert stock_de(page, prod_id2) == stock_antes2, (
            "BUG: aprobar un ajuste que otra compu ya había rechazado descontó el stock igual")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "aprobaciones_doble_resuelto.png"), full_page=True)
        assert_stock_integro(page, "al final de test_aprobaciones_pendientes_doble.py")
        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - aprobar/rechazar un ajuste que otra pestaña/compu ya resolvió no vuelve a tocar el stock.")
        browser.close()


if __name__ == "__main__":
    main()
