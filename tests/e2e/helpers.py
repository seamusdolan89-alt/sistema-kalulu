"""
tests/e2e/helpers.py — Utilidades comunes para los tests de Playwright de
Sistema Kalulu.

SEGURIDAD: `block_firebase` corta toda llamada de red hacia Firebase/GCP
(el proyecto real de producción, kalulu-3139e, está hardcodeado en
js/firebase-config.js). Todos los tests deben registrar esta ruta en el
`BrowserContext` ANTES de navegar, para garantizar que ninguna acción del
test pueda llegar a escribir en producción. Login y seed son 100% locales
(SQLite/OPFS), así que esto no limita lo que se puede probar en UI.

IMPORTANTE — dos bases de datos locales separadas (ver js/db.js ~línea 74):

    const dbFileName = window.ADMIN_MODE ? 'sga-admin.db' : 'sga.db';

POS (`index.html`, login.html sin returnTo) y Admin-POS (`admin-pos/`) usan
archivos OPFS DISTINTOS, a propósito — en producción son dos computadoras
físicas separadas (ver PUESTA_EN_MARCHA.md). `login.html` en sí SIEMPRE
inicializa/escribe en `sga.db`, sin importar el `returnTo`; el archivo
`sga-admin.db` recién se crea/usa cuando el browser carga `admin-pos/`
como documento propio. Consecuencia práctica para testear: el botón
"Cargar Datos Demo" de login.html sólo puebla datos útiles para el POS
(`admin_pos=False`). Para poblar datos en Admin-POS hay que loguearse ahí
primero y correr el seed IN PLACE (`seed_in_place`) — ver `login_via_seed`.

Uso típico de un test (POS):

    from playwright.sync_api import sync_playwright
    from helpers import BASE_URL, block_firebase, enable_dev_mode, login_via_seed

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        login_via_seed(page)   # deja al usuario logueado en index.html#pos
        ...
        browser.close()

Para Admin-POS (Compras, Cuentas Corrientes, Órdenes, etc.):

        login_via_seed(page, admin_pos=True)  # loguea + seedea sga-admin.db in place
        page.evaluate("window.location.hash = 'compras_v2'")

Cómo levantar el server antes de correr un test (desde la raíz del repo):

    python -m http.server 8765 --bind 127.0.0.1

(usar --bind 127.0.0.1 explícito: bindear a "::" a veces deja conexiones
IPv4 rotas en Windows si quedan procesos http.server viejos corriendo en
el mismo puerto — matá procesos python huérfanos si un test cuelga).
"""
import re

BASE_URL = "http://127.0.0.1:8765"

# Credenciales del admin en una base de datos local fresca (creadas por
# js/db.js en la primera inicialización — ver js/db.js ~línea 1176). Tanto
# sga.db como sga-admin.db generan el mismo admin por defecto de forma
# independiente, así que estas credenciales sirven para ambos contextos.
DEV_ADMIN_USER = "admin"
DEV_ADMIN_PASS = "kalulu123"

# Dominios de Firebase/GCP a bloquear. El SDK se carga igual (es JS estático
# desde gstatic.com, no lo bloqueamos), pero ninguna llamada de datos debe
# salir.
_BLOCKED_HOST_RE = re.compile(
    r"(firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|"
    r"securetoken\.googleapis\.com|firebasestorage\.googleapis\.com|"
    r"www\.googleapis\.com|.*\.cloudfunctions\.net|firebaseio\.com)"
)


def block_firebase(route):
    """Handler de context.route("**/*", ...) — aborta llamadas a Firebase/GCP."""
    url = route.request.url
    if _BLOCKED_HOST_RE.search(url):
        route.abort()
    else:
        route.continue_()


def enable_dev_mode(context):
    """Registra un init script que activa localStorage.dev_mode ANTES de que
    cargue cualquier script de la página (necesario para ver el botón
    'Cargar Datos Demo' en login.html y el auto-seed de app.js)."""
    context.add_init_script("window.localStorage.setItem('dev_mode', 'true');")


def seed_in_place(page):
    """Corre js/seed.js directamente sobre la página actual (evaluate), sin
    navegar. Usar cuando ya estás logueado en el documento cuyo OPFS querés
    poblar (p.ej. admin-pos/, donde login.html no sirve porque escribe en
    sga.db en vez de sga-admin.db). Espera a que el guardado a OPFS termine
    (window.SGA_DB.flush()) antes de devolver el control.

    Deja la base de datos local poblada con: sucursal, admin (si no existía),
    5 categorías, 3 proveedores, 2 productos con stock (20 u. c/u) — ver
    js/seed.js.
    """
    page.evaluate("""
      async () => {
        // login.html (/views/) y admin-pos/index.html (/admin-pos/) estan
        // ambos un nivel bajo la raiz, igual que index.html del POS lo
        // referencia con './js/seed.js' -> '../js/seed.js' desde un subdir.
        await import('../js/seed.js').then(m => m.default());
        if (window.SGA_DB?.flush) await window.SGA_DB.flush();
      }
    """)


def login_via_seed(page, wait_target=None, admin_pos=False):
    """Deja al usuario logueado con datos demo cargados.

    - admin_pos=False (default): usa el botón 'Cargar Datos Demo' de
      login.html (escribe en sga.db) -> auto-login -> redirect a
      index.html#<wait_target>.
    - admin_pos=True: login directo a admin-pos/ (sga-admin.db) + seed IN
      PLACE ahí (ver módulo docstring: login.html seedea el archivo
      equivocado para este caso) -> queda en admin-pos/index.html#<wait_target>.

    Requiere que enable_dev_mode() ya se haya llamado sobre el context.
    """
    if admin_pos:
        login_direct(page, wait_target=wait_target, admin_pos=True)
        seed_in_place(page)
        page.wait_for_timeout(200)
        return

    wait_target = wait_target or "pos"
    page.goto(f"{BASE_URL}/views/login.html")
    page.wait_for_load_state("networkidle")

    seed_btn = page.locator("#seed-btn")
    seed_btn.wait_for(state="visible", timeout=5000)
    seed_btn.click()

    page.wait_for_url(re.compile(rf".*(index\.html)?#{re.escape(wait_target)}"), timeout=15000)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(300)  # margen para que el router pinte la vista


def abrir_caja_si_hace_falta(page, saldo_inicial=0):
    """El POS pide abrir una sesión de caja (modal 'Apertura de Caja') si no
    hay una activa para hoy. Puede tardar un instante en aparecer (se decide
    de forma async al montar el módulo pos.js), así que hay que esperarlo
    explícitamente en vez de asumir un estado fijo apenas se llega a #pos."""
    modal = page.locator("text=Apertura de Caja")
    try:
        modal.wait_for(state="visible", timeout=3000)
    except Exception:
        return  # ya había una sesión de caja abierta
    if saldo_inicial:
        page.fill("input[type='number']", str(saldo_inicial))
    page.get_by_text("Abrir Caja", exact=True).click()
    page.wait_for_timeout(300)


def login_direct(page, username=DEV_ADMIN_USER, password=DEV_ADMIN_PASS, wait_target=None, admin_pos=False):
    """Login sin seed (usuario/DB ya existentes). Útil para reusar sesión/DB
    entre pasos de un mismo test sin volver a cargar datos demo."""
    login_url = f"{BASE_URL}/views/login.html"
    if admin_pos:
        login_url += "?returnTo=../admin-pos/"
    if wait_target is None:
        wait_target = "productos" if admin_pos else "pos"

    page.goto(login_url)
    page.wait_for_load_state("networkidle")
    page.fill("#username", username)
    page.fill("#password", password)
    page.click("#login-btn")
    target_re = r"admin-pos/(index\.html)?" if admin_pos else r"(index\.html)?"
    page.wait_for_url(re.compile(rf".*{target_re}#{re.escape(wait_target)}"), timeout=15000)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(300)
