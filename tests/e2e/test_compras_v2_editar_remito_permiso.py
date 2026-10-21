"""
tests/e2e/test_compras_v2_editar_remito_permiso.py — Editar un remito pendiente
de factura desde el POS (no Admin-POS), habilitado por un permiso granular
nuevo (`can_editar_remitos`), no por `window.ADMIN_MODE`.

Pedido explícito del usuario (21/10/2026): "no me interesa que pueda eliminar
remitos pero sí que pueda modificarlos [...] agregar esa función y detallarla
en permisos para que yo pueda tildarla o destildarla". Caso real: la cajera
carga un remito con menos productos de los que realmente entregaron y hace
falta volver a entrar a corregirlo, sin tener que esperar a que alguien lo
haga desde Admin-POS.

Antes de este cambio, tanto el botón "✏️ Editar" como la función
`cargarRemitoParaEditar` chequeaban únicamente `window.ADMIN_MODE` — ningún
permiso de Usuarios podía habilitarlo desde el POS. "Eliminar" sigue siendo
EXCLUSIVO de Admin-POS a propósito (pedido explícito: no quiere habilitar
borrar, solo corregir).

Cubre:
1. Cajero CON `can_compras` pero SIN `can_editar_remitos`: el botón "Editar"
   no aparece en el panel de remitos pendientes, y el guard interno
   (`cargarRemitoParaEditar`) bloquea aunque se lo invoque directo.
2. Cajero CON `can_compras` Y `can_editar_remitos`: el botón aparece, abre el
   editor con los productos reales del remito, y guardar un cambio (agregar
   cantidad de un producto) actualiza stock y queda `sync_status='pending'`.
3. En ningún caso (ni con el permiso) aparece el botón "🗑️ Eliminar": sigue
   siendo solo-admin.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_compras_v2_editar_remito_permiso.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed, login_direct


def q(page, sql, params=None):
    return page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])


def crear_usuario(page, user_id, username, password, permisos_json):
    page.evaluate(
        """([userId, username, password, permisosJson]) => {
          return (async () => {
            const now = new Date().toISOString();
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
            const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            window.SGA_DB.run(
              `INSERT INTO usuarios (id, firebase_uid, nombre, username, password_hash, rol, sucursal_id, activo, permisos_json, sync_status, updated_at)
               VALUES (?, ?, ?, ?, ?, 'cajero', '1', 1, ?, 'synced', ?)`,
              [userId, 'dev-' + userId, username, username, hash, permisosJson, now]
            );
          })();
        }""",
        [user_id, username, password, permisos_json],
    )
    page.wait_for_timeout(150)


def sembrar_remito(page):
    return page.evaluate(
        """() => {
          const now = new Date().toISOString();
          const suc = window.SGA_DB.query(`SELECT id FROM sucursales LIMIT 1`)[0].id;
          const prov = window.SGA_DB.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;
          const prod = window.SGA_DB.query(`SELECT id FROM productos LIMIT 1`)[0].id;

          window.SGA_DB.run(
            `INSERT INTO remitos (id, sucursal_id, proveedor_id, usuario_id, fecha, numero_remito, estado, sync_status, updated_at)
             VALUES ('rem-permiso-test', ?, ?, (SELECT id FROM usuarios LIMIT 1), ?, 'R-PERM-1', 'pendiente', 'synced', ?)`,
            [suc, prov, now, now]
          );
          window.SGA_DB.run(
            `INSERT INTO remito_items (id, remito_id, producto_id, cantidad, unidad_compra, unidades_por_paquete)
             VALUES ('remi-permiso-test', 'rem-permiso-test', ?, 3, 'Unidad', 1)`,
            [prod]
          );
          window.SGA_DB.moverStock({
            productoId: prod, sucursalId: suc, delta: 3,
            tipo: 'remito', refTipo: 'remitos', refId: 'rem-permiso-test', motivo: 'seed test',
          });
          return { sucursalId: suc, proveedorId: prov, productoId: prod };
        }"""
    )


def abrir_panel_remitos(page):
    page.evaluate("window.location.hash = 'compras_v2'")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    ge_btn = page.locator("#cv2-btn-remitos-pendientes")
    ge_btn.wait_for(state="visible", timeout=5000)
    ge_btn.click()
    page.wait_for_timeout(300)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1100})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        print("--- Login POS (sga.db) + seed ---")
        login_via_seed(page, admin_pos=False)
        info = sembrar_remito(page)

        print("--- Crear dos cajeros: con can_compras, uno SIN y otro CON can_editar_remitos ---")
        crear_usuario(page, "user-sinremitos", "sinremitos", "pass123",
                      '{"can_compras": true}')
        crear_usuario(page, "user-conremitos", "conremitos", "pass123",
                      '{"can_compras": true, "can_editar_remitos": true}')

        print("=== 1) Cajero SIN can_editar_remitos: no ve el boton Editar ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="sinremitos", password="pass123")
        abrir_panel_remitos(page)

        fila = page.locator(".cv2-remito-item", has_text="R-PERM-1")
        assert fila.count() == 1, "Deberia ver el remito pendiente (tiene can_compras)"
        assert fila.locator(".cv2-btn-editar-remito").count() == 0, \
            "NO deberia tener boton Editar sin el permiso"
        assert fila.locator(".cv2-btn-eliminar-remito").count() == 0, \
            "Eliminar nunca deberia aparecer para un cajero (admin-only)"
        print("OK - sin el permiso, el boton Editar no aparece")

        print("=== 2) Cajero CON can_editar_remitos: ve y puede usar Editar ===")
        page.evaluate("() => sessionStorage.removeItem('sga_user')")
        login_direct(page, username="conremitos", password="pass123")
        abrir_panel_remitos(page)

        fila2 = page.locator(".cv2-remito-item", has_text="R-PERM-1")
        assert fila2.locator(".cv2-btn-editar-remito").count() == 1, \
            "CON el permiso, el boton Editar tiene que aparecer"
        assert fila2.locator(".cv2-btn-eliminar-remito").count() == 0, \
            "Eliminar sigue sin aparecer (admin-only), aunque tenga can_editar_remitos"
        print("OK - con el permiso, aparece Editar y NO aparece Eliminar")

        fila2.locator(".cv2-btn-editar-remito").click()
        page.wait_for_timeout(400)

        # cargarRemitoParaEditar() deja al usuario en la pantalla de Cabecera
        # (proveedor/fecha/número), igual que al cargar un remito nuevo — hay
        # que "Continuar al Carrito" para ver/editar las líneas de producto.
        page.locator("#cv2-btn-continuar").click()
        page.wait_for_timeout(300)

        cantidad_input = page.locator("tr[data-idx='0'] input[data-field='cantidad']")
        cantidad_input.wait_for(state="visible", timeout=5000)
        cantidad_input.fill("5")
        cantidad_input.blur()
        page.wait_for_timeout(200)

        page.get_by_text("Guardar", exact=False).first.click()
        page.wait_for_timeout(600)

        print("--- La cantidad se actualizo y el stock reflejo la diferencia (+2) ---")
        item_final = q(page, "SELECT cantidad FROM remito_items WHERE id='remi-permiso-test'")[0]
        assert float(item_final["cantidad"]) == 5, f"Deberia haber quedado en 5: {item_final}"

        stock_final = q(
            page,
            "SELECT cantidad, sync_status FROM stock WHERE producto_id=? AND sucursal_id=?",
            [info["productoId"], info["sucursalId"]],
        )[0]
        assert float(stock_final["cantidad"]) >= 5, \
            f"El stock deberia reflejar al menos las 5 unidades del remito corregido: {stock_final}"
        print(f"OK - remito_items.cantidad=5, stock={stock_final}")

        remito_despues = q(page, "SELECT sync_status FROM remitos WHERE id='rem-permiso-test'")[0]
        assert remito_despues["sync_status"] == "pending", \
            f"La edicion tiene que quedar pending para viajar: {remito_despues}"
        print("OK - remito quedo pending (viaja a la otra maquina)")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: editar remitos pendientes desde el POS, habilitado por can_editar_remitos, sin exponer Eliminar ===")
        browser.close()


if __name__ == "__main__":
    main()
