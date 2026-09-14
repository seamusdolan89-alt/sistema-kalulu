"""
tests/e2e/test_caja_historial_detalle.py — Historial de Caja: dos acciones
distintas por sesion cerrada, y una de ellas exclusiva de admin-pos.

- "Resumen": el modal chico de siempre (6 numeros + detalle de billetes) —
  se ve tanto en POS como en admin-pos, no se perdio, sigue igual.
- "Detalle": abre el mismo nivel de detalle que la caja actual (Resumen con
  movimientos, Egresos e Ingresos, Cobranzas por medio de pago), de solo
  lectura, para revisar movimientos puntuales de un turno pasado. Es
  EXCLUSIVO de admin-pos (pedido explicito del usuario) — en el POS del
  local ese boton ni se renderiza.

Pedido real del usuario: desde Admin-POS poder ver cajas y turnos pasados
"no solamente el resumen, sino todo, como si fuera la caja actual" — pero
sin perder el resumen que ya tenia (son dos usos distintos) y sin que esa
funcion aparezca en el POS del local.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_caja_historial_detalle.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def probar_pos_sin_boton_detalle(context):
    """POS del local: 'Resumen' sigue andando, 'Detalle' no debe existir."""
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("dialog", lambda d: d.accept())

    print("--- POS: abrir caja, registrar egreso, cerrar ---")
    login_via_seed(page, admin_pos=False)
    page.evaluate("window.location.hash = 'pos'")
    page.wait_for_load_state("networkidle")
    abrir_caja_si_hace_falta(page)
    page.evaluate("window.location.hash = 'caja/efectivo'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)

    page.get_by_text("Egresos e Ingresos", exact=True).click()
    page.wait_for_timeout(300)
    page.get_by_text("+ Egreso", exact=True).click()
    page.wait_for_timeout(300)
    page.select_option("#egreso-tipo", "gasto_operativo")
    page.fill("#egreso-monto", "500")
    page.fill("#egreso-descripcion", "Compra de bolsas")
    page.locator("#btn-confirm-egreso").click()
    page.wait_for_timeout(400)

    page.locator("#btn-cierre-caja").click()
    page.wait_for_timeout(400)
    page.locator("#btn-cierre-confirm").click()
    page.wait_for_timeout(500)
    page.locator("#btn-aceptar-resumen").click()
    page.wait_for_timeout(400)

    print("--- POS: en Historial, 'Resumen' existe y 'Detalle' NO ---")
    resumen_btn = page.locator(".btn-resumen-sesion").first
    resumen_btn.wait_for(state="visible", timeout=5000)
    assert page.locator(".btn-detalle-sesion").count() == 0, (
        "El boton 'Detalle' es exclusivo de admin-pos y no deberia verse en el POS del local"
    )

    resumen_btn.click()
    page.wait_for_timeout(300)
    modal_text = page.locator("#app").inner_text()
    assert "Resumen de Sesión" in modal_text, f"No se ve el modal de resumen en POS: {modal_text[:300]!r}"
    page.locator("#btn-close-sesion2").click()
    page.wait_for_timeout(200)

    assert not errors, f"Errores JS no capturados en el POS: {errors}"
    print("OK - POS: Resumen visible, Detalle ausente.")
    page.close()


def probar_admin_pos_con_detalle(context):
    """Admin-POS: 'Detalle' existe y abre la vista completa, de solo lectura."""
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("dialog", lambda d: d.accept())

    print("--- Admin-POS: login + seed de una sesion cerrada con movimientos ---")
    login_via_seed(page, admin_pos=True)

    # admin-pos no abre/cierra su propia caja (esa UI esta deshabilitada ahi
    # a proposito, ver P.cerrarCaja en caja.js) — en producción esta fila
    # llegaria por el pull/monitoring desde el POS; acá la sembramos directo
    # para no depender de Firestore (bloqueado de todas formas en los tests).
    page.evaluate("""
      () => {
        const uid = window.SGA_Auth.getCurrentUser().id;
        const sucursal = window.SGA_Auth.getCurrentUser().sucursal_id || '1';
        const sesId = 'sesion-test-admin-detalle';
        const now = new Date().toISOString();
        window.SGA_DB.run(`INSERT INTO sesiones_caja
          (id, sucursal_id, usuario_apertura_id, usuario_cierre_id, fecha_apertura, fecha_cierre,
           saldo_inicial, saldo_final_esperado, saldo_final_real, diferencia, detalle_billetes,
           estado, sync_status, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, 'cerrada', 'synced', ?)`,
          [sesId, sucursal, uid, uid, now, now, 1000, 850, 850, 0, '{}', now]);
        window.SGA_DB.run(`INSERT INTO egresos_caja
          (id, sesion_caja_id, usuario_id, monto, descripcion, tipo, fecha, sync_status, updated_at)
          VALUES (?,?,?,?,?,?,?, 'synced', ?)`,
          ['egr-test-detalle', sesId, uid, 150, 'Compra de bolsas', 'otro', now, now]);
        window.SGA_DB.run(`INSERT INTO ingresos_caja
          (id, sesion_caja_id, usuario_id, monto, descripcion, tipo, fecha, sync_status, updated_at)
          VALUES (?,?,?,?,?,?,?, 'synced', ?)`,
          ['ing-test-detalle', sesId, uid, 200, 'Aporte extra', 'otro', now, now]);
      }
    """)

    page.evaluate("window.location.hash = 'caja/efectivo'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)

    print("--- Admin-POS: 'Detalle' existe junto a 'Resumen' ---")
    detalle_btn = page.locator(".btn-detalle-sesion").first
    detalle_btn.wait_for(state="visible", timeout=5000)
    assert page.locator(".btn-resumen-sesion").count() >= 1, "El modal 'Resumen' tambien debe seguir disponible en admin-pos"

    detalle_btn.click()
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, "caja_historial_detalle_resumen.png"), full_page=True)

    page_text = page.locator("#app").inner_text()
    assert "Cerrada" in page_text, f"No se ve el badge de sesion cerrada: {page_text[:300]!r}"
    assert "Volver al historial" in page_text, "Falta el boton para volver al historial"
    assert "Compra de bolsas" in page_text, (
        f"El egreso de la sesion cerrada no aparece en el Resumen historico: {page_text[:500]!r}"
    )
    assert "150,00" in page_text, f"Monto del egreso no visible: {page_text[:500]!r}"

    print("--- Tab Egresos e Ingresos: mismo detalle, sin botones de escritura ---")
    page.get_by_text("Egresos e Ingresos", exact=True).click()
    page.wait_for_timeout(300)
    ei_text = page.locator("#app").inner_text()
    assert "Compra de bolsas" in ei_text and "150,00" in ei_text, (
        f"Egreso no listado en la tab Egresos e Ingresos del historico: {ei_text[:500]!r}"
    )
    assert "Aporte extra" in ei_text and "200,00" in ei_text, (
        f"Ingreso no listado en la tab Egresos e Ingresos del historico: {ei_text[:500]!r}"
    )
    assert page.locator("#btn-nuevo-egreso").count() == 0, (
        "El boton '+ Egreso' no deberia existir en modo historico (de solo lectura)"
    )
    assert page.locator("#btn-nuevo-ingreso").count() == 0, (
        "El boton '+ Ingreso' no deberia existir en modo historico (de solo lectura)"
    )
    assert page.locator("#btn-pago-proveedor").count() == 0, (
        "El boton 'Pago a Proveedor' no deberia existir en modo historico (de solo lectura)"
    )

    print("--- Cobranzas por medio de pago (overlay de solo lectura) ---")
    page.get_by_text("Cobranzas por medio de pago", exact=True).click()
    page.wait_for_timeout(300)
    overlay_text = page.locator("#app").inner_text()
    assert "Cobranzas por medio de pago" in overlay_text
    page.locator("#btn-close-medios2").click()
    page.wait_for_timeout(200)

    print("--- Volver al historial ---")
    page.get_by_text("Volver al historial", exact=False).click()
    page.wait_for_timeout(300)
    back_text = page.locator("#app").inner_text()
    assert "Cajas anteriores" in back_text, (
        f"No volvio a la pantalla de apertura/historial: {back_text[:300]!r}"
    )
    assert page.locator(".btn-detalle-sesion").count() >= 1, "La sesion cerrada deberia seguir listada en Historial"

    assert not errors, f"Errores JS no capturados en admin-pos: {errors}"
    print("OK - Admin-POS: Resumen y Detalle conviven, Detalle trae el mismo nivel que la caja actual.")
    page.close()


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1300})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        probar_pos_sin_boton_detalle(context)
        probar_admin_pos_con_detalle(context)

        print(f"Screenshots: {SCREENSHOT_DIR}")
        browser.close()


if __name__ == "__main__":
    main()
