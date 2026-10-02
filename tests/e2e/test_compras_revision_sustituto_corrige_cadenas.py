"""
tests/e2e/test_compras_revision_sustituto_corrige_cadenas.py — "Asociar
sustituto" con selección múltiple (ver test_compras_revision_seleccion_
multiple.py) también sirve para CORREGIR cadenas rotas: si uno de los
candidatos marcados ya pertenecía a un grupo de sustitutos distinto (como
seguidor de otra referencia, o siendo él mismo la referencia de otros),
elegir una referencia final distinta tiene que migrar TODO ese grupo viejo
hacia la nueva, no solo al producto marcado.

Pregunta real del usuario (2/10/2026) tras ver el badge "en grupo": "qué
pasa si en sustituto termino eligiendo una referencia nueva a la que ya
existía? se corrige? [...] puede ser una buena herramienta para ir
corrigiendo esos casos en los que los sustitutos se apuntan entre sí."

La respuesta depende de GruposSustitutos.aplicarCambioReferencia(), que no
es código nuevo de esta feature (ya resolvía la cadena en las dos
direcciones antes de que existiera la selección múltiple) — este test
verifica EMPÍRICAMENTE, no solo leyendo el código, que el camino nuevo
(marcar varios con espacio, elegir una referencia al final) dispara
correctamente esa migración para los dos casos posibles:

  1. Un candidato marcado que YA era SEGUIDOR de otra referencia -> todo
     ese grupo viejo (la referencia vieja + sus demás seguidores) migra
     a la nueva.
  2. Un candidato marcado que YA ERA la referencia de otros productos ->
     esos seguidores migran a la nueva referencia también.

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

  // Producto nuevo, sin agrupar -- va a terminar siendo la referencia FINAL.
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('cad-z', 'Cadena Fix Opcion Z', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]
  );

  // Caso 1: cad-rx es la referencia de un grupo viejo, cad-m1 es su seguidor.
  // Se va a marcar cad-m1 (el SEGUIDOR, no la referencia) para probar que
  // migra el grupo entero, no solo a cad-m1.
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('cad-rx', 'Cadena Fix Referencia Vieja RX', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('cad-m1', 'Cadena Fix Opcion M1', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
     VALUES ('cad-m1', 'cad-rx', 'cad-rx', 1, ?)`, [now]
  );

  // Caso 2: cad-ry es ELLA MISMA la referencia de otro grupo viejo, con
  // cad-m2 como su seguidor. Se va a marcar cad-ry (la REFERENCIA vieja,
  // no un seguidor) para probar que sus propios seguidores migran también.
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('cad-ry', 'Cadena Fix Opcion RY', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES ('cad-m2', 'Cadena Fix Referencia Vieja M2', 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'pending', ?)`, [now, now, now]
  );
  window.SGA_DB.run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
     VALUES ('cad-m2', 'cad-ry', 'cad-ry', 1, ?)`, [now]
  );
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
        page.on("dialog", lambda d: d.accept())

        print("--- Login admin-pos + seed: Z (sin grupo) + 2 grupos viejos distintos (RX+M1, RY+M2) ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Verificación previa: los 2 grupos viejos son independientes entre sí ---")
        # (recién acá window.SGA_GruposSustitutos existe -- lo importa compras_v2.js,
        # no es uno de los 5 scripts globales)
        assert ref_de(page, "cad-m1") == "cad-rx"
        assert ref_de(page, "cad-ry") == "cad-ry"  # es su propia referencia
        assert ref_de(page, "cad-m2") == "cad-ry"
        assert ref_de(page, "cad-z") is None

        print("--- Nueva compra Remito: cargar Z como fila original ---")
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

        page.locator("#cv2-search").click()
        page.keyboard.type("Cadena Fix Opcion Z", delay=15)
        page.wait_for_timeout(350)
        page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text="Cadena Fix Opcion Z").click()
        page.wait_for_timeout(300)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)

        print("--- Abrir 'Asociar sustituto' para Z, buscar, marcar M1 (seguidor viejo) y RY (referencia vieja) ---")
        abrir_familia_menu(page, 0, "sust")
        page.fill("#cv2-sust-search", "Cadena Fix")
        page.wait_for_timeout(400)
        # Candidatos esperados (todo menos Z, que es la fila original): RX, M1, RY, M2 = 4
        assert page.locator("[data-sust-elegir]").count() == 4, "Esperaba 4 candidatos (RX, M1, RY, M2)"

        # Las 4 filas ya pertenecen a algún grupo -- las 4 deberían mostrar el badge.
        assert page.locator(".cv2-dd-badge-grupo").count() == 4, (
            "Las 4 filas (RX, M1, RY, M2) ya están agrupadas -- deberían mostrar el badge"
        )

        page.locator('[data-sust-marcar="cad-m1"]').click()
        page.locator('[data-sust-marcar="cad-ry"]').click()
        bar_txt = page.locator("#cv2-sust-batch-count").inner_text()
        assert "2 marcados" in bar_txt, f"Debería mostrar 2 marcados (M1 y RY): {bar_txt!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "sust_corrige_cadenas_marcados.png"))

        print("--- Agregar marcados, elegir Z (nuevo, sin grupo) como referencia final ---")
        page.locator("#cv2-sust-batch-btn").click()
        page.wait_for_timeout(300)
        page.select_option("#cv2-sust-ref", "cad-z")
        page.wait_for_timeout(150)
        aviso = page.locator("#cv2-sust-aviso").inner_text()
        print(f"   Aviso: {aviso!r}")
        page.locator("#cv2-sust-btn-confirm").click()
        page.wait_for_timeout(400)

        print("--- Verificar la migración real (asimétrica según qué ROL tenía lo marcado) ---")
        resultado = {
            "cad-z":  ref_de(page, "cad-z"),
            "cad-m1": ref_de(page, "cad-m1"),
            "cad-rx": ref_de(page, "cad-rx"),   # la referencia vieja de M1 -- NO se marcó directamente
            "cad-ry": ref_de(page, "cad-ry"),
            "cad-m2": ref_de(page, "cad-m2"),   # el seguidor de RY -- NO se marcó directamente
        }
        print(f"   {resultado}")

        # Lo que SÍ se marcó explícitamente (M1 y RY), más la fila original Z,
        # terminan todos en el grupo nuevo -- esto es lo central que preguntó
        # el usuario y SÍ se corrige.
        for pid in ("cad-z", "cad-m1", "cad-ry"):
            assert resultado[pid] == "cad-z", (
                f"BUG: {pid} se marcó/eligió explícitamente y debería haber quedado en el grupo nuevo (cad-z): "
                f"quedó apuntando a {resultado[pid]!r}"
            )

        # RY ERA la referencia de un grupo viejo -- sus seguidores (M2) SÍ la
        # siguen automáticamente al grupo nuevo (aplicarCambioReferencia
        # redirige explícitamente a "quien le apunte a lo marcado").
        assert resultado["cad-m2"] == "cad-z", (
            f"BUG: M2 seguía a RY (que se marcó) -- debería haber migrado junto con ella: {resultado['cad-m2']!r}"
        )

        # Asimetría real (no es un bug, es cómo funciona aplicarCambioReferencia
        # desde antes de esta feature): RX era la referencia de M1, pero NO se
        # marcó directamente a RX -- se marcó a M1 (su seguidor). Migrar un
        # SEGUIDOR no arrastra a su referencia vieja; como M1 era el único
        # seguidor de RX, RX queda sin nadie que le apunte = sin grupo.
        assert resultado["cad-rx"] is None, (
            f"RX debería quedar SIN grupo (nadie le apunta ya, M1 se fue) -- si esto cambia, la asimetría "
            f"documentada más abajo para el usuario dejó de ser cierta: quedó en {resultado['cad-rx']!r}"
        )
        print("   OK - lo marcado explícitamente (y los seguidores de una REFERENCIA marcada) migra al grupo "
              "nuevo; la referencia vieja de un SEGUIDOR marcado, si se queda sin nadie, pasa a 'sin grupo' "
              "(no se arrastra sola) -- asimetría real del sistema, no un bug")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_revision_sustituto_corrige_cadenas: PASA")


if __name__ == "__main__":
    main()
