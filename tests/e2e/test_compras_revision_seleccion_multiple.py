"""
tests/e2e/test_compras_revision_seleccion_multiple.py — "Asociar sustituto"/
"Asignar madre" (Compras-Revisión): selección múltiple con barra espaciadora
+ resaltado de candidatos que ya pertenecen a un grupo/familia.

Pedido del usuario (2/10/2026, probando en dev): "¿será posible que los
productos que aparecen en el listado que pertenecen al grupo de sustitutos
estén resaltados de alguna forma? Sería ideal poder ir marcando (apretando
barra espaciadora) todos los productos que quiero que formen parte del
grupo de sustitutos [...] mismos comentarios para producto madre."

Diseño confirmado con el usuario (AskUserQuestion):
  - Sustituto: se marcan varios candidatos, y en un único paso final se
    elige CUÁL de todos (la fila original + los marcados) queda como
    "producto de referencia" — el resto se repunta hacia ese.
  - Madre: se marcan varios candidatos como "además, estos también van a
    ser hijos" — el que se CLICKEA (no el checkbox) es siempre la madre;
    todos los marcados + la fila original quedan con producto_madre_id
    apuntando a esa madre.

Clickear un resultado directamente (sin marcar nada) sigue funcionando
exactamente igual que antes — eso ya lo cubre test_compras_revision_
acciones_rapidas.py; este archivo cubre específicamente el camino nuevo
(selección múltiple + resaltado).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_revision_seleccion_multiple.py
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
  const mk = (id, nombre, extra) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, producto_madre_id, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
     VALUES (?, ?, 10, 20, 1, 'unidad', ?, ?, 0, 1, ?, ?, 'pending', ?)`,
    [id, nombre, extra?.esMadre ? 1 : 0, extra?.madreId || null, now, now, now]
  );

  // Sustituto: fila original + 2 candidatos a marcar + 1 ya en otro grupo.
  // "Referencia Vieja Botella" NO comparte el prefijo "Jugo Cereza" a
  // proposito -- es solo la referencia de ms-sust-d-en-grupo, no tiene que
  // aparecer en la busqueda de "Jugo Cereza" ni contarse como candidato.
  mk('ms-sust-orig', 'Jugo Cereza Opcion A');
  mk('ms-sust-b', 'Jugo Cereza Opcion B');
  mk('ms-sust-c', 'Jugo Cereza Opcion C');
  mk('ms-sust-ref-vieja', 'Referencia Vieja Botella');
  mk('ms-sust-d-en-grupo', 'Jugo Cereza Opcion D Agrupado');
  window.SGA_DB.run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
     VALUES ('ms-sust-d-en-grupo', 'ms-sust-ref-vieja', 'ms-sust-ref-vieja', 1, ?)`, [now]
  );

  // Madre: fila original + 2 candidatos a marcar + 1 que se clickea como
  // madre + 1 que ya es madre de otro producto (para el badge). "Producto
  // Historico Sin Relacion" NO comparte el prefijo "Yogur Pack" a proposito,
  // mismo motivo que arriba.
  mk('ms-madre-orig', 'Yogur Pack Opcion A');
  mk('ms-madre-b', 'Yogur Pack Opcion B');
  mk('ms-madre-c', 'Yogur Pack Opcion C');
  mk('ms-madre-d', 'Yogur Pack Opcion D');
  mk('ms-madre-e-familia', 'Yogur Pack Opcion E Familia', { esMadre: true });
  mk('ms-madre-hijo-viejo', 'Producto Historico Sin Relacion', { madreId: 'ms-madre-e-familia' });
}
"""


def abrir_familia_menu(page, row_idx, accion):
    page.locator(f'[data-rev-menu="familia"][data-rev-idx="{row_idx}"]').click()
    page.wait_for_timeout(200)
    page.locator(f'[data-rev-accion="{accion}"]').click()
    page.wait_for_timeout(300)


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


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

        print("--- Login admin-pos + seed: candidatos de sustituto/madre ---")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        page.evaluate("window.location.hash = 'compras_v2'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        print("--- Nueva compra Remito: cargar las 2 filas originales ---")
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

        for nombre in ["Jugo Cereza Opcion A", "Yogur Pack Opcion A"]:
            page.locator("#cv2-search").click()
            page.keyboard.type(nombre, delay=15)
            page.wait_for_timeout(350)
            page.locator(".cv2-dd-item:not(.cv2-dd-acciones-row)", has_text=nombre).click()
            page.wait_for_timeout(300)

        page.get_by_text("Siguiente", exact=False).click()
        page.wait_for_timeout(500)
        # idx 0 = Jugo Cereza Opcion A (sustituto) / idx 1 = Yogur Pack Opcion A (madre)

        print("--- SUSTITUTO: resaltado de 'ya en grupo' + marcar 2 con espacio ---")
        abrir_familia_menu(page, 0, "sust")
        page.fill("#cv2-sust-search", "Jugo Cereza")
        page.wait_for_timeout(400)
        assert page.locator("[data-sust-elegir]").count() == 3, "Esperaba 3 candidatos (B, C, D agrupado)"

        badge_d = page.locator('[data-sust-elegir="ms-sust-d-en-grupo"] .cv2-dd-badge-grupo')
        assert badge_d.count() == 1, "El candidato ya agrupado debería mostrar el badge 'en grupo'"
        badge_b = page.locator('[data-sust-elegir="ms-sust-b"] .cv2-dd-badge-grupo')
        assert badge_b.count() == 0, "Un candidato SIN grupo no debería mostrar el badge"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "seleccion_multiple_sust_badge.png"))

        search = page.locator("#cv2-sust-search")
        search.press("ArrowDown")  # resalta B (orden alfabetico: B, C, D Agrupado)
        search.press("Space")
        fila_b = page.locator('[data-sust-elegir="ms-sust-b"]')
        assert fila_b.locator(".cv2-dd-marcar-btn").inner_text() == "☑", "Espacio debería marcar la fila B (checkbox)"
        assert "cv2-dd-item-marcado" in (fila_b.get_attribute("class") or ""), "Espacio debería marcar la fila B (clase)"

        search.press("ArrowDown")  # pasa a C
        search.press("Space")
        fila_c = page.locator('[data-sust-elegir="ms-sust-c"]')
        assert fila_c.locator(".cv2-dd-marcar-btn").inner_text() == "☑", "Espacio debería marcar la fila C"

        bar_txt = page.locator("#cv2-sust-batch-count").inner_text()
        assert "2 marcados" in bar_txt, f"La barra debería mostrar '2 marcados': {bar_txt!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "seleccion_multiple_sust_marcados.png"))

        print("--- SUSTITUTO: 'Agregar marcados' muestra los 3 en el selector de referencia ---")
        page.locator("#cv2-sust-batch-btn").click()
        page.wait_for_timeout(300)
        opciones = page.locator("#cv2-sust-ref option")
        assert opciones.count() == 3, f"Esperaba 3 opciones en el selector de referencia (A, B, C): {opciones.count()}"
        textos = opciones.all_inner_texts()
        assert any("Opcion A" in t for t in textos) and any("Opcion B" in t for t in textos) and any("Opcion C" in t for t in textos), (
            f"Las 3 opciones deberían ser A, B y C (no D, que no se marcó): {textos}"
        )
        page.locator("#cv2-sust-btn-confirm").click()
        page.wait_for_timeout(400)

        ref_de = lambda pid: page.evaluate("(id) => window.SGA_GruposSustitutos.referenciaRealDe(id)", pid)
        ref_a, ref_b, ref_c = ref_de("ms-sust-orig"), ref_de("ms-sust-b"), ref_de("ms-sust-c")
        assert ref_a == ref_b == ref_c == "ms-sust-b", (
            f"Los 3 (A, B marcado, C marcado) deberían terminar apuntando a B (default): "
            f"A={ref_a!r} B={ref_b!r} C={ref_c!r}"
        )
        print(f"   OK - A, B y C quedaron en el mismo grupo, referencia=ms-sust-b")

        print("--- MADRE: resaltado de 'ya en familia' + marcar 2, clickear un 3ro como madre ---")
        abrir_familia_menu(page, 1, "madre")
        page.fill("#cv2-madre-search", "Yogur Pack")
        page.wait_for_timeout(400)
        assert page.locator("[data-madre-elegir]").count() == 4, "Esperaba 4 candidatos (B, C, D, E familia)"

        badge_e = page.locator('[data-madre-elegir="ms-madre-e-familia"] .cv2-dd-badge-grupo')
        assert badge_e.count() == 1, "El candidato que ya es madre debería mostrar el badge 'en familia'"
        badge_b_madre = page.locator('[data-madre-elegir="ms-madre-b"] .cv2-dd-badge-grupo')
        assert badge_b_madre.count() == 0, "Un candidato sin familia no debería mostrar el badge"

        search_m = page.locator("#cv2-madre-search")
        search_m.press("ArrowDown")  # B
        search_m.press("Space")
        search_m.press("ArrowDown")  # C
        search_m.press("Space")
        bar_txt_m = page.locator("#cv2-madre-batch-count").inner_text()
        assert "2 marcados" in bar_txt_m, f"La barra debería mostrar '2 marcados': {bar_txt_m!r}"
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "seleccion_multiple_madre_marcados.png"))

        print("--- MADRE: clickear D (sin marcar) lo designa como la madre de A+B+C ---")
        page.locator('[data-madre-elegir="ms-madre-d"]').click()
        page.wait_for_timeout(300)
        confirm_txt = page.locator("#cv2-madre-confirm").inner_text()
        assert "Opcion D" in confirm_txt, f"El paso de confirmación debería nombrar a D como madre: {confirm_txt!r}"
        assert "estos 3 productos" in confirm_txt, f"Debería listar los 3 hijos (A + B + C marcados): {confirm_txt!r}"
        lis = page.locator("#cv2-madre-confirm li").all_inner_texts()
        assert len(lis) == 3, f"Esperaba 3 <li> con los hijos: {lis}"
        page.locator("#cv2-madre-btn-confirm").click()
        page.wait_for_timeout(400)

        filas = q(page, "SELECT id, producto_madre_id, es_madre FROM productos WHERE id IN (?,?,?,?)",
                  ["ms-madre-orig", "ms-madre-b", "ms-madre-c", "ms-madre-d"])
        por_id = {f["id"]: f for f in filas}
        assert por_id["ms-madre-orig"]["producto_madre_id"] == "ms-madre-d"
        assert por_id["ms-madre-b"]["producto_madre_id"] == "ms-madre-d"
        assert por_id["ms-madre-c"]["producto_madre_id"] == "ms-madre-d"
        assert por_id["ms-madre-d"]["es_madre"] == 1
        print(f"   OK - A, B y C quedaron como hijos de D: {filas}")

        assert not errors, f"Errores JS no capturados en pagina: {errors}"
        browser.close()
        print("\nOK - test_compras_revision_seleccion_multiple: PASA")


if __name__ == "__main__":
    main()
