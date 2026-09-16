"""
tests/e2e/test_inicio_dashboard.py — Vista "Inicio" (dashboard de accesos
rápidos) del POS del local: es el arranque por defecto de CUALQUIER rol que
loguee ahí (cajera incluida) desde que existe, así que un test propio evita
que una navegación futura la rompa en silencio.

Este mismo módulo también vive en Admin-POS (BACKLOG.md, "Admin-POS
responsive" — primer acceso de la barra inferior mobile), pero con KPIs
distintos: ahí no hay nadie parado en el mostrador, así que en vez de "Venta
del turno"/"Más vendidos hoy" se muestran KPIs de gestión remota (saldo por
caja, ventas de hoy, ticket promedio) y no se muestra "Nueva venta" entre los
accesos rápidos. Admin-POS sigue arrancando en #productos en escritorio —
este test deja constancia de que eso no cambió, aunque "Inicio" ya sea
alcanzable desde el menú.

Cubre:
- El POS arranca en #inicio (cualquier rol; acá se prueba con el admin
  seedeado por login_via_seed, que en el POS local NO tiene arranque
  especial propio — ver app.js).
- Admin-POS sigue arrancando en #productos, con "Inicio" ahora sí en el menú
  y sus propios KPIs (saldo por caja, ventas de hoy, ticket promedio),
  sin "Nueva venta" entre los accesos rápidos.
- Los KPIs renderizan sin romper la página, incluso sin caja abierta ni
  ventas hoy (deben avisar del estado vacío, no tirar un error).
- "Más vendidos hoy" y "Reponer en góndola" son solo texto — no navegan a
  ningún lado al hacerles click.
- Los accesos rápidos con destino navegan a donde corresponde: "Ingresar
  Compra" -> #compras_v2, "Pago a proveedor" -> abre el modal de pago solo,
  "Nueva venta" -> entra de una al flujo real de venta (carrito si hay caja
  abierta, o el modal de Apertura de Caja si no) en vez de dejar a la
  cajera en el dashboard interno de ventas realizadas de pos.js.
- El 4to botón, "Órdenes de Compra", navega a #ordenes.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_inicio_dashboard.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()

        # Solo se imprimen (no se assertea que esten vacios): el propio
        # block_firebase hace que la sync inicial falle con un error de red
        # esperado — ver test_pos_smoke.py, mismo criterio.
        page.on("console", lambda msg: print(f"[console:{msg.type}] {msg.text}") if msg.type == "error" else None)

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)

        assert "#inicio" in page.url, f"El POS deberia arrancar en #inicio, quedo en: {page.url}"
        print(f"OK - arranca en {page.url}")

        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "inicio_dashboard.png"))

        print("--- Orden: los botones van primero, los KPIs despues ---")
        botones_y = page.get_by_text("Nueva venta").bounding_box()["y"]
        kpis_y = page.get_by_text("Venta del turno").bounding_box()["y"]
        assert botones_y < kpis_y, "Los botones deberian estar arriba de los KPIs"
        print("OK")

        print("--- KPIs ---")
        for label in ["Venta del turno", "Más vendidos hoy", "Reponer en góndola"]:
            assert page.get_by_text(label).count() > 0, f"Falta el KPI '{label}'"
        # Sin caja abierta / sin ventas (DB recien seedeada): no debe romper, debe avisar.
        assert page.get_by_text("Sin caja abierta").count() > 0, \
            "Sin sesion de caja activa, el KPI de turno deberia decir 'Sin caja abierta'"
        assert page.get_by_text("Sin ventas hoy").count() >= 1, \
            "Sin ventas hoy, 'Más vendidos' y/o 'Reponer' deberian avisarlo en vez de mostrar un numero"
        print("OK - los KPIs renderizan; turno y ventas muestran su estado vacio sin romper")

        print("--- 'Más vendidos hoy' y 'Reponer en góndola' no navegan a ningún lado ---")
        hash_antes = page.evaluate("window.location.hash")
        page.get_by_text("Más vendidos hoy").click()
        page.wait_for_timeout(200)
        assert page.evaluate("window.location.hash") == hash_antes, \
            "'Más vendidos hoy' no deberia ser un link"
        page.get_by_text("Reponer en góndola").click()
        page.wait_for_timeout(200)
        assert page.evaluate("window.location.hash") == hash_antes
        print("OK - son texto plano, no links")

        print("--- Botones grandes ---")
        for label in ["Nueva venta", "Pago a proveedor", "Ingresar Compra", "Órdenes de Compra"]:
            assert page.get_by_text(label).count() > 0, f"Falta el boton '{label}'"
        print("OK - los 4 espacios de la grilla estan presentes")

        print("--- Nueva venta: entra al flujo real, no al dashboard de ventas ---")
        page.get_by_text("Nueva venta").click()
        page.wait_for_timeout(500)
        assert "#pos/nueva-venta" in page.url
        cart_visible = page.locator("#pos-sale").count() and page.locator("#pos-sale").is_visible()
        apertura_visible = page.get_by_text("Apertura de Caja").count() > 0
        assert cart_visible or apertura_visible, \
            "Deberia entrar al carrito (si hay caja abierta) o pedir abrir caja — no quedarse en el dashboard"
        print(f"OK - {page.url}, {'carrito visible' if cart_visible else 'pidio abrir caja'}")

        # NOTA: se evita page.wait_for_url() para estas navegaciones —
        # son solo cambio de hash (sin ida al servidor), a veces terminan
        # antes de que el listener de Playwright llegue a engancharse y el
        # wait tira un timeout aunque la navegacion ya haya pasado. Se
        # confirma con un wait chico + chequeo directo de page.url.
        print("--- volver a Inicio, Ingresar Compra -> #compras_v2 ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(400)
        page.get_by_text("Ingresar Compra").click()
        page.wait_for_timeout(500)
        assert "#compras_v2" in page.url, f"Deberia estar en #compras_v2, quedo en: {page.url}"
        print(f"OK - {page.url}")

        print("--- volver a Inicio, Órdenes de Compra -> #ordenes ---")
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(400)
        page.get_by_text("Órdenes de Compra").click()
        page.wait_for_timeout(500)
        assert "#ordenes" in page.url, f"Deberia estar en #ordenes, quedo en: {page.url}"
        print(f"OK - {page.url}")

        print("--- volver a Inicio, Pago a proveedor -> modal de pago ---")
        # Ultimo antes de cerrar esta pagina: el modal que abre queda tapando
        # la pantalla y no tiene boton de cerrar en este flujo, asi que
        # cualquier chequeo posterior sobre "page" chocaria contra el overlay.
        page.evaluate("window.location.hash = 'inicio'")
        page.wait_for_timeout(400)
        page.get_by_text("Pago a proveedor").click()
        page.wait_for_timeout(500)
        assert "#cuenta_corriente_proveedores/nuevo-pago" in page.url, \
            f"Deberia estar en #cuenta_corriente_proveedores/nuevo-pago, quedo en: {page.url}"
        overlay = page.locator("#sga-pagoprov-overlay")
        overlay.wait_for(state="visible", timeout=5000)
        assert "hidden" not in (overlay.get_attribute("class") or "")
        print(f"OK - {page.url} y el modal de pago se abrio solo")

        print("--- Admin-POS: sigue arrancando en #productos, pero 'Inicio' ya esta en el menu ---")
        # Pagina nueva: la sesion del POS ya autenticada haria que login.html
        # redirija de una sin mostrar el formulario (ver login.html ~linea 264).
        page2 = context.new_page()
        login_via_seed(page2, admin_pos=True)
        assert "#productos" in page2.url, f"Admin-POS deberia arrancar en #productos, quedo en: {page2.url}"
        nav_texts = " ".join(page2.locator("aside.sidebar nav").inner_text().split())
        assert "Inicio" in nav_texts, "Inicio deberia aparecer en el menu de Admin-POS"
        print(f"OK - Admin-POS arranca en {page2.url}, con 'Inicio' en el menu")

        print("--- Admin-POS #inicio: KPIs propios, sin los del POS ni 'Nueva venta' ---")
        page2.evaluate("window.location.hash = 'inicio'")
        page2.wait_for_timeout(400)
        for label in ["Saldo por caja", "Ventas de hoy", "Ticket promedio"]:
            assert page2.get_by_text(label).count() > 0, f"Falta el KPI de Admin-POS '{label}'"
        assert page2.get_by_text("Sin caja abierta").count() > 0, \
            "Sin sesion de caja activa, el KPI de saldo deberia decir 'Sin caja abierta'"
        assert page2.get_by_text("Sin ventas hoy").count() >= 1, \
            "Sin ventas hoy, los KPIs de ventas/ticket deberian avisarlo en vez de mostrar un numero"
        assert page2.get_by_text("Venta del turno").count() == 0, \
            "El KPI operativo del POS ('Venta del turno') no deberia aparecer en Admin-POS"
        assert page2.get_by_text("Nueva venta").count() == 0, \
            "'Nueva venta' no deberia estar entre los accesos rapidos de Admin-POS (vender es cosa del POS fisico)"
        for label in ["Pago a proveedor", "Ingresar Compra", "Órdenes de Compra"]:
            assert page2.get_by_text(label).count() > 0, f"Falta el acceso rapido '{label}' en Admin-POS"
        print("OK - Admin-POS muestra sus propios KPIs y accesos, sin mezclar con el POS")
        page2.close()

        browser.close()
        print("\n=== TODOS LOS CHECKS DE INICIO PASARON ===")


if __name__ == "__main__":
    run()
