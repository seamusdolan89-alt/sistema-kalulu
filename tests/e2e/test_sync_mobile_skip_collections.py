"""
tests/e2e/test_sync_mobile_skip_collections.py

Pedido del usuario (17/9): el celular usa solo 5 áreas de Admin-POS (Inicio,
Productos, Órdenes, Proveedores/Cta Cte, Informes — ver BACKLOG.md, "Admin-POS
responsive") pero el pull inicial y el sync periódico bajaban las ~28
colecciones completas, incluidas varias que ninguna pantalla mobile lee
(Clientes, Configuración, Flujo de Fondos, Consumo Interno,
etc.) — eso hacía que el primer login en un dispositivo nuevo, contra
producción real (meses de datos), tardara mucho.

Fix en js/sync.js: `MOBILE_SKIP_COLLECTIONS` + `isMobileAdminPos()` — en un
celular (`window.ADMIN_MODE` true y `window.innerWidth <= 768`), tanto
`initialSyncFromFirestore()` como `syncMonitoringData()` (el sync periódico
de cada 5 min) saltean esas colecciones. Auditado módulo por módulo antes de
tocar esto (qué tabla lee cada uno de los 5 módulos mobile) — quedan AFUERA
de la lista de saltear (siguen sincronizando igual en mobile) las colecciones
donde un cálculo depende del historial completo sin fecha límite: compras,
gastos, pagos_proveedores (saldo de proveedores, getSaldoProveedor sin
filtro de fecha), ventas, sesiones_caja, ordenes_compra, stock_ajustes.

Este test no puede probar el pull real contra Firestore (block_firebase),
así que verifica la lógica de decisión en sí — expuesta en window.SGA_Sync
para poder testearla sin red (mismo criterio que applyUsuarioFull/
applyOrdenCompra ya expuestos). Confirmado a mano contra dev-kalulu que el
pull real respeta esto (nunca contra producción).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_mobile_skip_collections.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ── 1) Mobile (<=768px): isMobileAdminPos() true, lista de salteo
        #    correcta — trae lo que NO debe tocar el saldo de nadie, deja
        #    afuera lo que sí puede romper un cálculo de plata.
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        login_via_seed(page, wait_target="productos", admin_pos=True)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        is_mobile = page.evaluate("() => window.SGA_Sync.isMobileAdminPos()")
        assert is_mobile is True, f"390px + ADMIN_MODE deberia detectarse como mobile, dio: {is_mobile}"
        print("OK - isMobileAdminPos() true en 390px")

        skip_list = page.evaluate("() => window.SGA_Sync.MOBILE_SKIP_COLLECTIONS")
        print("Colecciones salteadas en mobile:", skip_list)

        must_skip = {
            'clientes', 'consumo_interno', 'system_config',
            'flujo_forecast', 'flujo_liquidar', 'flujo_pagos_prov',
            'cuenta_corriente', 'producto_codigo_proveedor', 'gastos_pagos',
        }
        assert must_skip.issubset(set(skip_list)), (
            f"faltan colecciones que deberian estar salteadas en mobile: {must_skip - set(skip_list)}"
        )

        must_NOT_skip = {
            'compras', 'gastos', 'pagos_proveedores', 'ventas',
            'sesiones_caja', 'ordenes_compra', 'stock_ajustes',
            'productos', 'proveedores', 'usuarios', 'stock', 'categorias',
            'medios_cobro', 'sucursales', 'devoluciones', 'egresos_caja',
            'ingresos_caja', 'promociones', 'remitos',
        }
        overlap = must_NOT_skip.intersection(set(skip_list))
        assert not overlap, (
            f"estas colecciones NO deberian saltearse nunca en mobile (dependen de historial "
            f"completo para saldos/KPIs correctos, o las usa una de las 5 areas mobile): {overlap}"
        )
        print("OK - se resguardan compras/gastos/pagos_proveedores/ventas/sesiones_caja/ordenes_compra "
              "(calculos que dependen del historial completo) y todo lo que sí usan las 5 areas mobile")

        ctx.close()

        # ── 2) Desktop (>768px): isMobileAdminPos() false — nada se saltea,
        #    la compu del dueño sigue trayendo todo como siempre.
        ctx2 = browser.new_context(viewport={"width": 1280, "height": 800})
        ctx2.route("**/*", block_firebase)
        enable_dev_mode(ctx2)
        page2 = ctx2.new_page()
        login_via_seed(page2, wait_target="productos", admin_pos=True)
        page2.wait_for_load_state("networkidle")
        page2.wait_for_timeout(300)

        is_mobile2 = page2.evaluate("() => window.SGA_Sync.isMobileAdminPos()")
        assert is_mobile2 is False, f"1280px deberia NOT detectarse como mobile, dio: {is_mobile2}"
        print("OK - isMobileAdminPos() false en escritorio (1280px) — nada se saltea ahi")

        ctx2.close()
        browser.close()
        print("\n=== TODOS LOS CHECKS DE MOBILE_SKIP_COLLECTIONS PASARON ===")


if __name__ == "__main__":
    run()
