"""
tests/e2e/test_compras_revision_sustituto_corrige_cadenas.py — "Asociar
sustituto" con selección múltiple (ver test_compras_revision_seleccion_
multiple.py) también sirve para CORREGIR cadenas rotas: si uno de los
candidatos marcados ya pertenecía a un grupo de sustitutos distinto, elegir
una referencia final distinta tiene que avisar y, si el dueño quiere,
migrar TODO ese grupo viejo hacia la nueva, no solo al producto marcado.

Pregunta real del usuario (2/10/2026) tras ver el badge "en grupo": "qué
pasa si en sustituto termino eligiendo una referencia nueva a la que ya
existía? se corrige? [...] puede ser una buena herramienta para ir
corrigiendo esos casos en los que los sustitutos se apuntan entre sí."

Primera vuelta (verificación empírica, sin tocar código): se confirmó una
asimetría real de GruposSustitutos.aplicarCambioReferencia() (función
preexistente) — marcar la REFERENCIA de un grupo viejo arrastra a sus
seguidores solo; marcar un SEGUIDOR SUELTO (no la referencia) NO arrastra
a su referencia vieja, que queda huérfana si se quedó sin nadie más.

Segunda vuelta (pedido explícito del usuario, mismo día): "sería prudente
agregar una alerta de 'este producto hoy apunta a X, desea que X (y todo
su grupo) también apunte a la nueva referencia?'" — justo para el caso del
seguidor suelto, donde el dueño no tiene por qué saber de memoria a quién
apunta cada producto. Implementado como un confirm() en el handler de
"Confirmar" (mostrarConfirmSustQuick), uno por cada producto migrado que
sea un seguidor suelto de otra referencia (no la elegida, no él mismo).

Cubre 3 escenarios, cada uno en su propia fila/modal para poder controlar
el diálogo exacto que corresponde a cada uno:
  1. Marcar la REFERENCIA de un grupo viejo -> sus seguidores migran solos,
     SIN preguntar nada (ya resuelto, sin ambigüedad).
  2. Marcar un SEGUIDOR SUELTO y ACEPTAR el aviso -> la referencia vieja
     (y todo su grupo) migra también.
  3. Marcar un SEGUIDOR SUELTO y RECHAZAR el aviso -> solo el marcado
     migra; su referencia vieja queda como estaba (comportamiento default,
     igual que antes de este aviso).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_revision_sustituto_corrige_cadenas.py
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
  const mk = (id, nombre) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`,
    [id, nombre, now, now, now]
  );
  const vincular = (seguidorId, refId) => window.SGA_DB.run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
     VALUES (?, ?, ?, 1, ?)`, [seguidorId, refId, refId, now]
  );

  // Escenario 1: Z1 (fila original, sin grupo) + RY (referencia vieja) + M2 (su seguidor).
  mk('esc1-z', 'Escenario1 Fila Z'); mk('esc1-ry', 'Escenario1 Referencia Vieja RY'); mk('esc1-m2', 'Escenario1 Seguidor M2');
  vincular('esc1-m2', 'esc1-ry');

  // Escenario 2: Z2 (fila original) + M-accept (seguidor suelto de RX-accept).
  mk('esc2-z', 'Escenario2 Fila Z'); mk('esc2-rx', 'Escenario2 Referencia Vieja RX'); mk('esc2-m', 'Escenario2 Seguidor M');
  vincular('esc2-m', 'esc2-rx');

  // Escenario 3: Z3 (fila original) + M-decline (seguidor suelto de RX-decline).
  mk('esc3-z', 'Escenario3 Fila Z'); mk('esc3-rx', 'Escenario3 Referencia Vieja RX'); mk('esc3-m', 'Escenario3 Seguidor M');
  vincular('esc3-m', 'esc3-rx');
}
"""


def abrir_familia_menu(page, row_idx, accion):
    page.locator(f'[data-rev-menu="familia"][data-rev-idx="{row_idx}"]').click()
    page.wait_for_timeout(200)
    page.locator(f'[data-rev-accion="{accion}"]').click()
    page.wait_for_timeout(300)


def ref_de(page, pid):
    return page.evaluate("(id) => window.SGA_GruposSustitutos.referenciaRealDe(id)", pid)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1800, "height": 1200})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos + seed: 3 escenarios independientes ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Nueva compra Remito: cargar las 3 filas originales (Z1, Z2, Z3) ---")
        page.get_by_text("Tradicional", exact=True).click()
        page.wait_for_timeout(300)
        page.locator("#cv2-prov-search").click()
        page.keyboard.type("Pepsico", delay=20)
        page.wait_for_timeout(300)
        page.locator(".cv2-dd-item", has_text="Pepsico SA").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-condicion-compra", label="Remito")
        page.wait_for_timeout(200)
        page.fill("#cv2-total-factura", "100")
        page.locator("#cv2-total-factura").blur()
        page.wait_for_timeout(200)
        page.get_by_text("Continuar al Carrito", exact=False).click()
        page.wait_for_timeout(400)

        for nombre in ["Escenario1 Fila Z", "Escenario2 Fila Z", "Escenario3 Fila Z"]:
            page.locator("#cv2-search").click()
            page.keyboard.type(nombre, delay=15)
            page.wait_for_timeout(350)
            page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=nombre).click()
            page.wait_for_timeout(300)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        # idx 0 = Escenario1 Fila Z / idx 1 = Escenario2 Fila Z / idx 2 = Escenario3 Fila Z

        print("\n=== ESCENARIO 1: marcar la REFERENCIA vieja (RY) -> sin preguntar, arrastra sola ===")
        dialogs_esc1 = []
        def on_dialog_esc1(d):
            dialogs_esc1.append(d.message)
            d.accept()
        page.on("dialog", on_dialog_esc1)
        abrir_familia_menu(page, 0, "sust")
        page.fill("#cv2-sust-search", "Escenario1")
        page.wait_for_timeout(400)
        page.locator('[data-sust-marcar="esc1-ry"]').click()
        page.locator("#cv2-sust-batch-btn").click()
        page.wait_for_timeout(300)
        page.locator("#cv2-sust-btn-confirm").click()  # no debería disparar ningún dialog
        page.wait_for_timeout(300)
        page.remove_listener("dialog", on_dialog_esc1)
        assert not dialogs_esc1, f"No debería haber preguntado nada al marcar la referencia misma: {dialogs_esc1}"
        assert ref_de(page, "esc1-z") == "esc1-z" or ref_de(page, "esc1-ry") == ref_de(page, "esc1-z"), (
            "Z y RY deberían quedar en el mismo grupo"
        )
        r1 = {k: ref_de(page, k) for k in ("esc1-z", "esc1-ry", "esc1-m2")}
        assert r1["esc1-z"] == r1["esc1-ry"] == r1["esc1-m2"], f"Los 3 deberían terminar en el mismo grupo: {r1}"
        print(f"   OK - sin diálogo, RY y su seguidor M2 migraron solos junto con Z: {r1}")

        print("\n=== ESCENARIO 2: marcar un SEGUIDOR SUELTO (M) + ACEPTAR el aviso -> arrastra su referencia vieja ===")
        abrir_familia_menu(page, 1, "sust")
        page.fill("#cv2-sust-search", "Escenario2")
        page.wait_for_timeout(400)
        page.locator('[data-sust-marcar="esc2-m"]').click()
        page.locator("#cv2-sust-batch-btn").click()
        page.wait_for_timeout(300)
        # Por defecto, sin grupo previo en la fila original, queda seleccionado
        # el marcado (esc2-m) como referencia -- para probar "migrar M hacia Z"
        # hay que elegir Z explícitamente.
        page.select_option("#cv2-sust-ref", "esc2-z")
        page.wait_for_timeout(150)

        dialog_msgs = []
        def on_dialog_accept(d):
            dialog_msgs.append(d.message)
            d.accept()
        page.on("dialog", on_dialog_accept)
        page.locator("#cv2-sust-btn-confirm").click()
        page.wait_for_timeout(300)
        page.remove_listener("dialog", on_dialog_accept)

        assert len(dialog_msgs) == 1, f"Debería haber preguntado UNA vez por la referencia vieja de M: {dialog_msgs}"
        assert "Escenario2 Referencia Vieja RX" in dialog_msgs[0], f"El aviso debería nombrar a RX: {dialog_msgs[0]!r}"
        print(f"   Aviso mostrado: {dialog_msgs[0]!r}")
        r2 = {k: ref_de(page, k) for k in ("esc2-z", "esc2-m", "esc2-rx")}
        assert r2["esc2-z"] == r2["esc2-m"] == r2["esc2-rx"], (
            f"Al ACEPTAR, M y su referencia vieja RX deberían migrar junto con Z: {r2}"
        )
        print(f"   OK - al aceptar, RX (la referencia vieja de M) migró también: {r2}")

        print("\n=== ESCENARIO 3: marcar un SEGUIDOR SUELTO (M) + RECHAZAR el aviso -> NO arrastra su referencia vieja ===")
        abrir_familia_menu(page, 2, "sust")
        page.fill("#cv2-sust-search", "Escenario3")
        page.wait_for_timeout(400)
        page.locator('[data-sust-marcar="esc3-m"]').click()
        page.locator("#cv2-sust-batch-btn").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-sust-ref", "esc3-z")
        page.wait_for_timeout(150)

        dialog_msgs2 = []
        def on_dialog_dismiss(d):
            dialog_msgs2.append(d.message)
            d.dismiss()
        page.on("dialog", on_dialog_dismiss)
        page.locator("#cv2-sust-btn-confirm").click()
        page.wait_for_timeout(300)
        page.remove_listener("dialog", on_dialog_dismiss)

        assert len(dialog_msgs2) == 1, f"Debería haber preguntado UNA vez: {dialog_msgs2}"
        r3 = {k: ref_de(page, k) for k in ("esc3-z", "esc3-m", "esc3-rx")}
        assert r3["esc3-z"] == r3["esc3-m"], f"Z y M deberían quedar en el mismo grupo: {r3}"
        assert r3["esc3-rx"] != r3["esc3-z"], (
            f"BUG: al RECHAZAR, la referencia vieja RX no debería haber migrado: {r3}"
        )
        assert r3["esc3-rx"] is None, (
            f"RX se quedó sin su único seguidor (M se fue) -- debería quedar sin grupo: {r3}"
        )
        print(f"   OK - al rechazar, RX quedó sin migrar (sin grupo, como antes): {r3}")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_revision_sustituto_corrige_cadenas: PASA")


if __name__ == "__main__":
    main()
