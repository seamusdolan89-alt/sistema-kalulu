"""
tests/e2e/test_productos_familias_desajustadas.py — Botón "👪 Familias con
Precio Distinto" en Productos: lista las familias (madre/hijo vía
producto_madre_id) cuyo precio de venta no coincide, y permite corregirlas
desde ahí reutilizando el wizard de herencia ya existente (familia.js).

Pedido explícito del usuario (23/10/2026): encontró a mano un caso real
("Matarazzo Tirabuzón Sin Gluten 500gr" hijo de "Matarazzo Penne Rigate Sin
Gluten 500gr", precios distintos) y pidió una forma de ver TODOS los casos
así y corregirlos desde la pantalla de Productos, sin escribir SQL cada vez.

Diseño: el botón NO escribe precios directo -- abre
window.SGA_Familia.showHerenciaModal({prodId: madreId, ...}), el mismo
wizard que usan compras_v2.js/operaciones_stock.js/editor-producto.js, con
la familia completa (madre + todos los hijos) para que el dueño decida por
fila qué hereda. El audit modal (z-index 1000) se cierra ANTES de abrir el
wizard (z-index 600) para que no quede tapado, y se reabre (ya actualizado)
cuando el wizard termina.

Permiso (agregado a pedido del usuario, mismo día, tras preguntar "¿lo
armaste para POS también?"): can_familias_desajustadas, APARTE de
can_editar_productos -- en el POS una cajera con permiso de editar
productos sueltos NO ve este botón salvo que el dueño se lo habilite
puntual. En Admin-POS siempre está disponible (ADMIN_MODE).

Cubre:
1. POS, sin ningún permiso: el botón no aparece.
2. POS, CON can_editar_productos pero SIN can_familias_desajustadas: el
   botón sigue sin aparecer (el permiso nuevo es indispensable, no
   alcanza con poder editar productos sueltos).
3. POS, con los dos permisos: el botón aparece.
4. Admin-POS: el botón siempre aparece (ADMIN_MODE), sin importar permisos.
5. La lista muestra SOLO la familia con precio distinto (no una con
   precios ya iguales).
6. "Corregir familia" abre el wizard con la familia completa; aplicar deja
   al hijo con el precio de la madre, sync_status='pending', y el audit
   modal se reabre mostrando "sin familias con precio distinto".

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_productos_familias_desajustadas.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_direct, login_via_seed

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  const mk = (id, nombre, costo, precio, madreId) => window.SGA_DB.run(
    `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
       es_madre, producto_madre_id, precio_independiente, activo, fecha_alta, fecha_modificacion,
       sync_status, updated_at)
     VALUES (?, ?, ?, ?, 1, 'unidad', ?, ?, 0, 1, ?, ?, 'synced', ?)`,
    [id, nombre, costo, precio, madreId ? 0 : 1, madreId || null, now, now, now]
  );
  mk('fd-madre',       'Matarazzo Penne Rigate Sin Gluten 500gr',  100, 500, null);
  mk('fd-hijo-distinto','Matarazzo Tirabuzon Sin Gluten 500gr',     95, 450, 'fd-madre');
  mk('fd-hijo-igual',   'Matarazzo Fusilli Sin Gluten 500gr',      100, 500, 'fd-madre');

  // Familia de control: precios YA iguales, no debería listarse ninguna.
  mk('fd-madre2', 'Familia OK Madre', 50, 200, null);
  mk('fd-hijo2',  'Familia OK Hijo',  50, 200, 'fd-madre2');
}
"""


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def crear_usuario(page, user_id, username, permisos_json):
    page.evaluate(
        """([userId, username, permisosJson]) => {
          return (async () => {
            const now = new Date().toISOString();
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pass123'));
            const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            window.SGA_DB.run(
              `INSERT INTO usuarios (id, firebase_uid, nombre, username, password_hash, rol, sucursal_id, activo, permisos_json, sync_status, updated_at)
               VALUES (?, ?, ?, ?, ?, 'cajero', '1', 1, ?, 'synced', ?)`,
              [userId, 'dev-' + userId, username, username, hash, permisosJson, now]
            );
          })();
        }""",
        [user_id, username, permisos_json],
    )
    page.wait_for_timeout(150)


def boton_visible(page):
    btn = page.locator("#btn-familias-desajustadas")
    return btn.count() > 0 and btn.is_visible()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1700, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        # En Admin-POS window.ADMIN_MODE da acceso total sin importar el
        # usuario (es la superficie del dueño) -- la matriz de permisos solo
        # es observable en el POS llano.
        login_via_seed(page, admin_pos=False)
        crear_usuario(page, "user-prod-sinperm", "prodsinperm", '{"can_ver_productos": true}')
        crear_usuario(page, "user-prod-soloeditar", "prodsoloeditar",
                      '{"can_ver_productos": true, "can_editar_productos": true}')
        crear_usuario(page, "user-prod-familias", "prodfamilias",
                      '{"can_ver_productos": true, "can_editar_productos": true, "can_familias_desajustadas": true}')

        print("--- 1) POS, sin ningún permiso: el botón no aparece ---")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="prodsinperm", password="pass123", admin_pos=False)
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        assert not boton_visible(page), "El botón no debería ser visible sin ningún permiso"
        print("OK")

        print("--- 2) POS, CON can_editar_productos pero SIN can_familias_desajustadas: sigue sin aparecer ---")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="prodsoloeditar", password="pass123", admin_pos=False)
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        assert not boton_visible(page), \
            "BUG: poder editar productos sueltos no debería alcanzar para ver este botón"
        print("OK")

        print("--- 3) POS, con los DOS permisos: el botón aparece ---")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="prodfamilias", password="pass123", admin_pos=False)
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        assert boton_visible(page), "Con los dos permisos el botón debería aparecer"
        print("OK")

        print("--- Login admin-pos + seed: familia con precios distintos + familia OK (control) ---")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_via_seed(page, admin_pos=True)
        page.evaluate(SEMBRAR)

        print("--- 4) Admin-POS: el botón siempre aparece (ADMIN_MODE), lista SOLO la familia desajustada ---")
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)

        btn = page.locator("#btn-familias-desajustadas")
        assert btn.is_visible(), "El botón debería ser visible en Admin-POS"
        btn.click()
        page.wait_for_timeout(300)

        modal = page.locator("#familias-desajustadas-modal")
        assert modal.is_visible(), "El modal debería abrirse"
        texto = modal.inner_text()
        assert "Matarazzo Penne Rigate Sin Gluten 500gr" in texto
        assert "Matarazzo Tirabuzon Sin Gluten 500gr" in texto
        assert "Matarazzo Fusilli Sin Gluten 500gr" not in texto, \
            "El hijo con precio YA igual a la madre no debería listarse"
        assert "Familia OK" not in texto, \
            "La familia de control (precios ya iguales) no debería aparecer"
        print("OK - lista solo la familia con precio distinto")

        print("--- 5) 'Corregir familia' abre el wizard con la familia completa ---")
        page.locator('[data-corregir-madre="fd-madre"]').click()
        page.wait_for_timeout(300)
        assert not modal.is_visible(), "El audit modal debería cerrarse antes de abrir el wizard"
        wizard = page.locator(".cv2-her-overlay")
        assert wizard.is_visible(), "El wizard de herencia debería estar abierto"
        wizard_text = wizard.inner_text()
        assert "Matarazzo Penne Rigate Sin Gluten 500gr" in wizard_text
        assert "Matarazzo Tirabuzon Sin Gluten 500gr" in wizard_text
        assert "Matarazzo Fusilli Sin Gluten 500gr" in wizard_text, \
            "El wizard debería mostrar TODA la familia, no solo los desajustados"
        print("OK - wizard abierto con la familia completa")

        print("--- Aplicar: el hijo desajustado queda con el precio de la madre ---")
        page.locator(".cv2-her-btn-apply").click()
        page.wait_for_timeout(500)

        hijo = q(page, "SELECT precio_venta, sync_status FROM productos WHERE id='fd-hijo-distinto'")[0]
        assert float(hijo["precio_venta"]) == 500.0, f"El hijo debería haber quedado en 500: {hijo}"
        assert hijo["sync_status"] == "pending", f"Tiene que quedar pending para viajar: {hijo}"
        print(f"OK - fd-hijo-distinto: {hijo}")

        print("--- El audit modal se reabre y ya no muestra ninguna familia desajustada ---")
        assert modal.is_visible(), "El audit modal debería haberse reabierto solo"
        page.wait_for_timeout(200)
        assert "no hay familias con precio" in modal.inner_text().lower(), \
            f"Debería mostrar el mensaje de 'sin familias': {modal.inner_text()[:300]!r}"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: Familias con Precio Distinto — lista, filtra, corrige con el wizard existente ===")
        browser.close()


if __name__ == "__main__":
    main()
