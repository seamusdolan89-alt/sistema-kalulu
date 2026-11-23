"""
tests/e2e/test_ticket_impresion_aislada.py — "Imprimir ticket" imprime SOLO el ticket.

Bug real (reportado por el dueño, 23/11/2026): el botón "Imprimir ticket" del POS hacía
`window.print()` sobre la PANTALLA ENTERA (no había ninguna regla de impresión para el POS), así que
en la térmica salían el menú y los botones "Confirmar y finalizar venta / Imprimir / Iniciar nueva
venta" junto con el ticket.

Ahora el ticket es un documento aislado que se imprime desde un iframe oculto (js/modules/impresion.js),
con `@page` de ancho fijo y alto automático (el largo lo decide el contenido) y el ancho del rollo
configurable.

Cubre, con la UI real (venta de verdad -> modal del ticket -> botón):
1. El botón NO llama a window.print() de la página (la causa raíz del bug).
2. El HTML que se manda a imprimir tiene el ticket (sucursal, ítem, TOTAL, medio de pago) y NINGUNO
   de los botones ni elementos de la pantalla.
3. @page = 58 mm de ancho x alto automático, cuerpo de 48 mm (valores por defecto).
4. La configuración se aplica: 80 mm / 72 mm útil, 2 copias, pie propio, sin vendedor.
5. Camino real sin espías: se crea el iframe oculto con SOLO el ticket (y no revienta nada).
6. Una venta con nombre de producto con HTML no inyecta marcado en el ticket.

Correr (server en :8765):  python tests/e2e/test_ticket_impresion_aislada.py
"""
import json
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, abrir_caja_si_hace_falta

PROHIBIDO_EN_EL_TICKET = ["Confirmar y finalizar", "Iniciar nueva venta", "Imprimir ticket", "btn-ticket", "<button", "<nav", "sidebar"]


def hacer_venta_hasta_el_ticket(page):
    page.evaluate("window.location.hash = 'pos'")
    page.wait_for_timeout(400)
    abrir_caja_si_hace_falta(page, saldo_inicial=1000)
    page.locator("#btn-nueva-venta").click()
    page.wait_for_timeout(400)
    page.locator("#pos-search-input").click()
    page.keyboard.type("Coca", delay=20)
    page.wait_for_timeout(400)
    page.locator("#pos-search-dropdown .sri").first.click()
    page.wait_for_timeout(400)
    recibe = page.locator("#recibe-efectivo")
    total = recibe.get_attribute("placeholder")
    recibe.fill(total.replace(".", "").replace(",", "."))
    page.wait_for_timeout(300)
    page.locator("#btn-confirm-venta").click()
    page.wait_for_timeout(600)
    assert not page.locator("#modal-ticket").is_hidden(), "No aparecio el modal del ticket"


ESPIAS = """() => {
  window.__printPagina = 0;
  window.print = () => { window.__printPagina++; };            // el bug: imprimir la PAGINA
  window.__html = null;
  if (window.SGA_Impresion) window.SGA_Impresion.imprimirHTML = (h) => { window.__html = h; return Promise.resolve(); };
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=False)
        page.evaluate("() => localStorage.removeItem('sga_print_config')")   # defaults
        hacer_venta_hasta_el_ticket(page)

        # ── 1-3. Defaults ───────────────────────────────────────────────────────
        print("=== 1) El boton no imprime la pagina; 2) manda solo el ticket; 3) 58 mm ===")
        page.evaluate(ESPIAS)
        page.locator("#btn-ticket-imprimir").click()
        page.wait_for_timeout(300)
        assert page.evaluate("window.__printPagina") == 0, \
            "BUG: 'Imprimir ticket' llamo a window.print() de la pagina entera (sale el menu y los botones)"
        html = page.evaluate("window.__html")
        assert html, "BUG: el boton no mando ningun documento a imprimir"
        for t in ("TOTAL", "Coca-Cola", "Efectivo"):
            assert t.lower() in html.lower(), f"El ticket impreso no tiene {t!r}"
        for malo in PROHIBIDO_EN_EL_TICKET:
            assert malo.lower() not in html.lower(), f"BUG: el documento a imprimir contiene {malo!r} (es de la pantalla, no del ticket)"
        assert "size: 58mm auto" in html, "Falta @page con el ancho del rollo y alto automatico"
        assert "width: 48mm" in html, "El cuerpo del ticket tiene que medir el ancho util (48 mm)"
        assert html.count('class="copia"') == 1
        print("OK - 0 impresiones de la pagina; el documento es solo el ticket (58 mm, util 48 mm)")

        # ── 4. Configuracion aplicada ───────────────────────────────────────────
        print("=== 4) La configuracion se aplica ===")
        page.evaluate("""() => window.SGA_Impresion.saveConfig({ ticket: {
          anchoPapel: 80, anchoUtil: 72, copias: 2, mostrarVendedor: false, pie: 'Vuelva pronto!!', fuentePx: 14 } })""")
        page.locator("#btn-ticket-imprimir").click()
        page.wait_for_timeout(300)
        html = page.evaluate("window.__html")
        assert "size: 80mm auto" in html and "width: 72mm" in html, "No uso el ancho configurado"
        assert html.count('class="copia"') == 2, "No genero las 2 copias"
        assert "Vuelva pronto!!" in html, "No uso el pie configurado"
        assert "Vendedor:" not in html, "Mostro el vendedor aunque esta desactivado"
        assert "font-size: 14px" in html, "No uso el tamano de letra configurado"
        print("OK - 80 mm / util 72 mm, 2 copias, pie propio, sin vendedor, letra 14")

        # ── 5. Camino real (iframe oculto), sin reemplazar imprimirHTML ─────────
        print("=== 5) Camino real: iframe oculto con SOLO el ticket ===")
        page.evaluate("() => localStorage.removeItem('sga_print_config')")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        res = page.evaluate("""async () => {
          window.__printPagina = 0; window.print = () => { window.__printPagina++; };
          const M = await import('/js/modules/impresion.js');
          const ticket = { fecha: new Date().toISOString(), sucursal: { nombre: 'Kalulu' }, usuario: { nombre: 'Ana' },
            items: [{ nombre: 'Yerba <b>ROTA</b> 1kg', cantidad: 1, precioUnitario: 3000, descuentoItem: 0 }],
            subtotal: 3000, descuentoTotal: 0, total: 3000, pagos: [{ medio: 'efectivo', monto: 3000 }] };
          // El iframe se limpia solo apenas termina de imprimir: se lo captura al cargar.
          let cap = null;
          new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
              if (n.tagName === 'IFRAME') n.addEventListener('load', () => {
                cap = { hayIframe: true, texto: n.contentDocument.body.innerText,
                        hayBoton: !!n.contentDocument.querySelector('button'), html: n.srcdoc };
              });
            }
          }).observe(document.body, { childList: true });
          M.default.imprimirTicket(ticket);
          await new Promise(r => setTimeout(r, 700));
          return Object.assign({ hayIframe: false, texto: '', hayBoton: false, html: '' }, cap, { printPagina: window.__printPagina });
        }""")
        assert res["hayIframe"], "BUG: no se creo el iframe oculto de impresion"
        assert "TOTAL" in res["texto"] and not res["hayBoton"]
        assert res["printPagina"] == 0
        print("OK - se imprime desde un iframe oculto con solo el ticket")

        # ── 6. HTML en el nombre del producto no se inyecta ─────────────────────
        print("=== 6) Nombres con HTML no inyectan marcado ===")
        assert "<b>ROTA</b>" not in res["html"] and "&lt;b&gt;ROTA&lt;/b&gt;" in res["html"], \
            "BUG: el nombre del producto se inserto sin escapar en el ticket"
        print("OK - el nombre se escapa")

        assert not errors, f"Errores JS: {errors}"
        browser.close()
    print("\nTODO OK — test_ticket_impresion_aislada")


if __name__ == "__main__":
    main()
