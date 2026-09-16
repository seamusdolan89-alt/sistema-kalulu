"""
tests/e2e/test_editor_producto_sustitutos_cadena.py — Prevencion de cadenas
rotas en Sustitutos (editor-producto.js + nuevo js/modules/grupos_sustitutos.js).

Motivo: el modelo (tabla producto_sustitutos: producto_id, referencia_id) no
tiene un "grupo" con ID propio. Antes de este fix, elegir como referencia a
un producto que a su vez ya pertenecia a OTRO grupo (o cambiar de grupo a un
producto al que otros ya apuntaban como referencia implicita) escribia la
cadena sin avisar -- exactamente el caso real reportado por el usuario:
"Maizena" apuntaba a "Chango 500gr" como referencia, pero Chango se unio
despues al grupo de "Dimax 500gr"; Maizena quedo huerfano, apuntando a un
intermediario que ya no era la referencia real (ver tambien
test_informes_sustitutos_grupos.py, el reporte que audita este mismo tipo de
cadena en el catalogo existente).

Cubre dos direcciones, cada una con su aviso de confirmacion (cancelable):

1. Elegir como referencia un producto que YA pertenece a otro grupo: en vez
   de escribir la cadena, se ofrece usar la referencia real en su lugar.
2. Cambiar la referencia de un producto al que YA apuntaban otros como
   referencia implicita: se avisa que esos productos tambien se van a
   actualizar para no dejarlos huerfanos.

En los dos casos, cancelar el aviso no escribe nada; confirmar aplica el
cambio Y marca sync_status='pending' en todos los productos afectados (bug
aparte, encontrado en el mismo repaso: ninguna escritura de esta pestaña
marcaba pendiente de sync -- los cambios de grupo nunca viajaban a la otra
maquina).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_editor_producto_sustitutos_cadena.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def abrir_sustitutos(page, prod_id):
    page.evaluate(f"window.location.hash = 'editor-producto/{prod_id}'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.locator("[data-section='sustitutos']").first.click()
    page.wait_for_timeout(300)


def buscar_y_click(page, texto):
    page.fill("#ed-ref-search", texto)
    page.wait_for_timeout(250)
    page.locator("#ed-ref-dropdown .ed-search-result-item[data-id]").first.click()
    page.wait_for_timeout(300)


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1500, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        dialog_state = {"accept": True, "messages": []}

        def handle_dialog(d):
            dialog_state["messages"].append(d.message)
            if dialog_state["accept"]:
                d.accept()
            else:
                d.dismiss()

        page.on("dialog", handle_dialog)

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        print("--- Armar dos escenarios: grupo A/B establecido + raiz implicita C/D ---")
        ids = page.evaluate("""
          () => {
            const now = new Date().toISOString();
            const mk = (id, nombre) => window.SGA_DB.run(
              `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
                 es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
               VALUES (?, ?, 10, 20, 1, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`,
              [id, nombre, now, now, now]
            );
            mk('sc-a',   'SustitutosCadena ReferenciaFinal');
            mk('sc-b',   'SustitutosCadena MiembroDeA');
            mk('sc-c',   'SustitutosCadena RaizImplicita');
            mk('sc-d',   'SustitutosCadena SeguidorDeC');
            mk('sc-new', 'SustitutosCadena ProductoNuevo');

            // Grupo A: A es la referencia real (fila propia), B es miembro.
            window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES ('sc-a', 'sc-a', 'sc-a', 1, ?)`, [now]
            );
            window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES ('sc-b', 'sc-a', 'sc-a', 1, ?)`, [now]
            );
            // C es referencia implicita: no tiene fila propia, pero D le apunta.
            window.SGA_DB.run(
              `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
               VALUES ('sc-d', 'sc-c', 'sc-c', 1, ?)`, [now]
            );
            return { a: 'sc-a', b: 'sc-b', c: 'sc-c', d: 'sc-d', nuevo: 'sc-new' };
          }
        """)

        # ── Direccion 1: elegir como referencia un producto que ya pertenece a otro grupo ──

        print("--- Direccion 1: 'Nuevo' elige a B (miembro de A) como referencia ---")
        abrir_sustitutos(page, ids["nuevo"])
        assert "Sin grupo de sustitutos asignado" in page.locator("#ed-sustitutos-list").inner_text()

        dialog_state["accept"] = False
        dialog_state["messages"] = []
        buscar_y_click(page, "MiembroDeA")
        assert dialog_state["messages"], "Deberia haber disparado un aviso de confirmacion"
        msg = dialog_state["messages"][0]
        assert "MiembroDeA" in msg and "ReferenciaFinal" in msg, (
            f"El aviso deberia mencionar el producto elegido y la referencia real: {msg!r}"
        )
        print(f"OK - aviso mostrado: {msg!r}")

        print("--- Cancelar el aviso no escribe nada ---")
        sin_grupo = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT * FROM producto_sustitutos WHERE producto_id='sc-new'\")"
        )
        assert sin_grupo == [], f"BUG: cancelar el aviso igual escribio una fila: {sin_grupo}"
        print("OK")

        print("--- Confirmar el aviso usa la referencia REAL (A), no la elegida (B) ---")
        dialog_state["accept"] = True
        dialog_state["messages"] = []
        buscar_y_click(page, "MiembroDeA")
        panel_text = page.locator("#ed-sustitutos-list").inner_text()
        assert "ReferenciaFinal" in panel_text, (
            f"Deberia haber quedado agrupado bajo la referencia real (A): {panel_text[:300]!r}"
        )
        fila_nuevo = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT referencia_id FROM producto_sustitutos WHERE producto_id='sc-new'\")"
        )
        assert fila_nuevo and fila_nuevo[0]["referencia_id"] == "sc-a", (
            f"BUG: 'Nuevo' deberia apuntar a A (la referencia real), no a B: {fila_nuevo}"
        )
        print("OK - quedo agrupado bajo la referencia real, sin crear la cadena")

        print("--- Se marcaron pendientes de sync los productos cuya fila realmente cambio (Nuevo y A) ---")
        # B no cambia (ya apuntaba a A, sigue apuntando a A) -- no hace falta
        # marcarlo, su documento no lleva informacion nueva.
        pendientes = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT id, sync_status FROM productos WHERE id IN ('sc-new','sc-a')"
          )
        """)
        no_pending = [r for r in pendientes if r["sync_status"] != "pending"]
        assert not no_pending, f"BUG: estos productos no se marcaron pendientes de sync (no viajarian): {no_pending}"
        print("OK - Nuevo y A quedaron sync_status='pending'")

        # ── Direccion 2: cambiar de grupo a un producto al que otros ya apuntaban ──

        print("--- Direccion 2: C (referencia implicita de D) cambia su propia referencia a A ---")
        abrir_sustitutos(page, ids["c"])
        banner_text = page.locator("#ed-sustitutos-list").inner_text()
        assert "referencia de un grupo" in banner_text and "SeguidorDeC" in banner_text, (
            f"Deberia mostrar que D lo usa como referencia: {banner_text[:400]!r}"
        )

        dialog_state["accept"] = False
        dialog_state["messages"] = []
        buscar_y_click(page, "ReferenciaFinal")
        assert dialog_state["messages"], "Deberia haber disparado un aviso sobre los seguidores"
        msg2 = dialog_state["messages"][0]
        assert "SeguidorDeC" in msg2, f"El aviso deberia mencionar a D, que le apuntaba: {msg2!r}"
        print(f"OK - aviso mostrado: {msg2!r}")

        print("--- Cancelar no deja huerfano a D (sigue apuntando a C, sin cambios) ---")
        fila_d_antes = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT referencia_id FROM producto_sustitutos WHERE producto_id='sc-d'\")"
        )
        assert fila_d_antes[0]["referencia_id"] == "sc-c", f"BUG: D deberia seguir apuntando a C: {fila_d_antes}"
        c_tiene_fila = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT * FROM producto_sustitutos WHERE producto_id='sc-c'\")"
        )
        assert c_tiene_fila == [], f"BUG: cancelar el aviso igual le creo fila propia a C: {c_tiene_fila}"
        print("OK")

        print("--- Confirmar repunta tambien a D (no queda huerfano) ---")
        dialog_state["accept"] = True
        dialog_state["messages"] = []
        buscar_y_click(page, "ReferenciaFinal")
        fila_c = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT referencia_id FROM producto_sustitutos WHERE producto_id='sc-c'\")"
        )
        fila_d = page.evaluate(
            "() => window.SGA_DB.query(\"SELECT referencia_id FROM producto_sustitutos WHERE producto_id='sc-d'\")"
        )
        assert fila_c and fila_c[0]["referencia_id"] == "sc-a", f"BUG: C deberia apuntar ahora a A: {fila_c}"
        assert fila_d and fila_d[0]["referencia_id"] == "sc-a", (
            f"BUG: D deberia haberse repunteado a A junto con C, no quedar huerfano: {fila_d}"
        )
        print("OK - C y D quedaron apuntando a A, D no quedo huerfano")

        print("--- Se marcaron pendientes de sync los 3 productos afectados (C, D, A) ---")
        pendientes2 = page.evaluate("""
          () => window.SGA_DB.query(
            "SELECT id, sync_status FROM productos WHERE id IN ('sc-c','sc-d','sc-a')"
          )
        """)
        no_pending2 = [r for r in pendientes2 if r["sync_status"] != "pending"]
        assert not no_pending2, f"BUG: estos productos no se marcaron pendientes de sync: {no_pending2}"
        print("OK - C, D y A quedaron sync_status='pending'")

        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "editor_producto_sustitutos_cadena.png"), full_page=True)

        assert not errors, f"Errores JS no capturados en pagina: {errors}"

        print("\n=== OK: las dos direcciones de la cadena rota se avisan, se pueden cancelar, y al confirmar no dejan huerfanos ===")
        print(f"Screenshots: {SCREENSHOT_DIR}")

        browser.close()


if __name__ == "__main__":
    main()
