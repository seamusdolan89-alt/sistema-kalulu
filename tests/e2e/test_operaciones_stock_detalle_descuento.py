"""
tests/e2e/test_operaciones_stock_detalle_descuento.py — "Detalle de compra"
(Historial de Compras, Operaciones de Stock): una línea con descuento tiene
que mostrar el costo REAL (neto del descuento), resaltarse, mostrar el % y
calcular el Margen contra ese costo neto -- no contra el costo de lista.

Pedido explícito del usuario (27/10/2026), con captura: "los costos
mostrados no contemplan si el producto tenía algún descuento aplicado...
muéstrame el costo con descuento aplicado y además resalte el producto...
y también indique de qué % es ese descuento."

Causa real (no solo de UI): compra_items.costo_unitario es el costo DE
LISTA (sin descuento) -- se guarda así a propósito, para que la línea
coincida con la factura del proveedor (ver costoUsado()/costoNetoUsado() en
compras_v2.js). El costo REAL de reposición (lo que ya se guarda en
productos.costo al confirmar la compra, vía costoNetoUsado) es
costo_unitario * (1 - descuento_pct/100). "Detalle de compra" mostraba el
de lista tal cual, y el Margen se calculaba contra ESE costo de lista, no
el neto -- subestimando el margen real en cualquier línea con descuento.

Fix: costoNeto = costo_unitario * (1 - descuento_pct/100) cuando hay
descuento. La celda "Costo unit." muestra el de lista tachado + el neto en
negrita; la fila se resalta (fondo ámbar); el nombre del producto lleva un
badge "🏷️ -X% dto."; el Margen (inicial Y al editar el Precio Venta) se
calcula contra el costo neto. El campo oculto que alimenta el chequeo de
"¿coincide con el markup predeterminado?" también pasa a usar el costo
neto (antes comparaba contra el de lista, mismo tipo de desvío).

Ampliación 1 (mismo día, pedido del usuario viendo la pantalla real): el
Margen también muestra, tachado arriba del real, el margen que hubiera
dado SI no hubiera habido descuento (contra el costo de lista) -- mismo
criterio visual que la celda de Costo unit., para ver de un vistazo cuánto
mejora el margen gracias al descuento negociado.

Ampliación 2 (mismo día): 4 columnas nuevas -- IVA (alícuota de la línea),
Costo Final (= Costo Neto × (1+IVA), el costo en la MISMA base que Precio
Venta), Precio Neto (= Precio Venta ÷ (1+IVA) -- Precio Venta es el precio
final al consumidor, CON IVA incluido) y Markup (= Precio Neto ÷ Costo
Neto, un ratio tipo "1.25x" -- por construcción da lo mismo que Precio
Venta ÷ Costo Final, que es como lo verificó el usuario). El modal se
agrandó (720px -> 1480px) para que entren las columnas nuevas sin apretar
las que ya había.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_operaciones_stock_detalle_descuento.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed


def margen_bruto_y_neto(page, idx):
    """Separa el margen 'de lista' (tachado, en un <div> propio) del margen
    real -- comparar por substring en el texto completo de la celda es
    ambiguo (ej. "0.0%" es substring de "20.0%"), así que se aíslan
    estructuralmente los dos números."""
    cell = page.locator('.ops-margen-cell').nth(idx)
    div = cell.locator('div')
    bruto = div.inner_text().strip() if div.count() == 1 else None
    completo = cell.inner_text()
    neto = completo.replace(bruto, '', 1).strip() if bruto else completo.strip()
    return bruto, neto


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

        print("--- Login Admin-POS + seed ---")
        login_via_seed(page, admin_pos=True, wait_target="productos")

        print("--- Compra confirmada: una línea con 20% de descuento, otra sin descuento ---")
        setup = page.evaluate("""
          () => {
            const db = window.SGA_DB;
            const uuid = window.SGA_Utils.generateUUID;
            const now = new Date().toISOString();
            const suc = window.SGA_Auth.getCurrentUser().sucursal_id;
            const usr = window.SGA_Auth.getCurrentUser().id;
            const prov = db.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;

            const prodDto = uuid(); const prodSin = uuid(); const prodIva = uuid();
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, activo, sync_status, updated_at)
                    VALUES (?, 'Producto Con Descuento Test', 800, 1000, 1, 'synced', ?)`, [prodDto, now]);
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, activo, sync_status, updated_at)
                    VALUES (?, 'Producto Sin Descuento Test', 500, 750, 1, 'synced', ?)`, [prodSin, now]);
            db.run(`INSERT INTO productos (id, nombre, costo, precio_venta, activo, sync_status, updated_at)
                    VALUES (?, 'Producto Con IVA Test', 1000, 1210, 1, 'synced', ?)`, [prodIva, now]);

            const compraId = uuid();
            db.run(`INSERT INTO compras (id, proveedor_id, sucursal_id, usuario_id, fecha, estado, total, total_factura, sync_status, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'confirmada', 2910, 2910, 'synced', ?)`,
                   [compraId, prov, suc, usr, now, now]);
            // costo_unitario = costo DE LISTA (1000), descuento_pct=20 -> neto real 800
            // (coincide con productos.costo, que ya se guarda neto al confirmar).
            // Sin IVA cargado en esta línea a propósito -- cubre el caso "—".
            db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, descuento_pct, subtotal)
                    VALUES (?, ?, ?, 1, 1000, 20, 800)`, [uuid(), compraId, prodDto]);
            db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, descuento_pct, subtotal)
                    VALUES (?, ?, ?, 1, 500, 0, 500)`, [uuid(), compraId, prodSin]);
            // Sin descuento, CON IVA 21%: costo neto=1000=costo final/1.21=1000,
            // precio venta=1210 (c/IVA) -> precio neto=1000, markup=1000/1000=1.00x.
            db.run(`INSERT INTO compra_items (id, compra_id, producto_id, cantidad, costo_unitario, descuento_pct, iva, subtotal)
                    VALUES (?, ?, ?, 1, 1000, 0, '21', 1000)`, [uuid(), compraId, prodIva]);

            return { compraId, prodDto, prodSin, prodIva };
          }
        """)

        page.evaluate("window.location.hash = 'operaciones_stock'")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        page.evaluate("() => document.querySelector('[data-action=\"historial_compras\"]')?.click()")
        page.wait_for_timeout(300)
        page.evaluate(
            "(id) => document.querySelector(`[data-ver-compra=\"${id}\"]`)?.click()",
            setup["compraId"],
        )
        page.wait_for_timeout(300)

        # Orden de filas = ORDER BY pr.nombre: "Con Descuento" < "Con IVA" < "Sin Descuento"
        # (índices 0, 1, 2 respectivamente) -- los selectores .nth() de abajo asumen este orden.
        fila_dto = page.locator('tr.ops-detalle-row', has_text="Producto Con Descuento Test")
        fila_iva = page.locator('tr.ops-detalle-row', has_text="Producto Con IVA Test")
        fila_sin = page.locator('tr.ops-detalle-row', has_text="Producto Sin Descuento Test")

        print("--- La línea con descuento muestra el badge '-20% dto.' junto al nombre ---")
        assert "-20.0% dto." in fila_dto.inner_text() or "-20,0% dto." in fila_dto.inner_text(), \
            f"Debería verse el badge del descuento: {fila_dto.inner_text()!r}"
        print("OK")

        print("--- La fila con descuento está resaltada (fondo distinto), la otra no ---")
        bg_dto = fila_dto.evaluate("el => getComputedStyle(el).backgroundColor")
        bg_sin = fila_sin.evaluate("el => getComputedStyle(el).backgroundColor")
        assert bg_dto != bg_sin, f"La fila con descuento debería tener un fondo distinto: dto={bg_dto!r} sin={bg_sin!r}"
        assert bg_sin in ("rgba(0, 0, 0, 0)", "transparent"), \
            f"La fila SIN descuento no debería tener ningún resaltado: {bg_sin!r}"
        print(f"OK - fondo con descuento: {bg_dto}, sin descuento: {bg_sin}")

        print("--- 'Costo unit.' muestra el de lista tachado y el NETO (800) en negrita ---")
        texto_fila_dto = fila_dto.inner_text()
        assert "1.000,00" in texto_fila_dto or "1000,00" in texto_fila_dto, \
            f"Debería verse el costo de lista (1.000): {texto_fila_dto!r}"
        assert "800,00" in texto_fila_dto, f"Debería verse el costo neto (800): {texto_fila_dto!r}"
        print("OK")

        print("--- Margen de la línea CON descuento: real (20%, contra costo neto) Y el 'de lista' tachado (0%) ---")
        # precio_venta=1000, costo neto=800 -> margen real=(1000-800)/1000=20%.
        # Con el bug viejo (costo de lista=1000) hubiera dado 0% -- ahora ESE
        # 0% se muestra igual, pero tachado, al lado del 20% real.
        bruto_dto, neto_dto = margen_bruto_y_neto(page, 0)
        assert bruto_dto in ("0.0%", "0,0%"), f"El margen 'de lista' (tachado) debería ser 0%: {bruto_dto!r}"
        assert neto_dto in ("20.0%", "20,0%"), f"BUG: el margen real debería ser 20% (contra el costo neto): {neto_dto!r}"
        print(f"OK - margen de lista (tachado): {bruto_dto!r}, margen real: {neto_dto!r}")

        print("--- Margen de la línea SIN descuento: sin cambios, SIN el tachado de 'margen de lista' ---")
        # precio_venta=750, costo=500 -> margen=(750-500)/750=33.3%. Al no haber
        # descuento, costo de lista == costo neto -> no corresponde mostrar un
        # segundo margen tachado (sería el mismo número, redundante).
        # Índice 2: "Sin Descuento" quedó tercera alfabéticamente (después de "Con IVA").
        bruto_sin, neto_sin = margen_bruto_y_neto(page, 2)
        assert bruto_sin is None, f"Sin descuento no debería haber un margen 'de lista' aparte: {bruto_sin!r}"
        assert neto_sin in ("33.3%", "33,3%"), f"El margen sin descuento no debería haber cambiado: {neto_sin!r}"
        print(f"OK - margen de la línea sin descuento: {neto_sin!r}")

        print("--- IVA / Costo Final / Precio Neto / Markup: línea SIN iva cargado ---")
        # prodDto no tiene iva en compra_items -> columna IVA = '—', y sin
        # IVA no hay uplift: Costo Final = Costo Neto (800), Precio Neto =
        # Precio Venta (1000), Markup = 1000/800 = 1.25x.
        assert "—" in page.locator('tr.ops-detalle-row').nth(0).locator('td').nth(4).inner_text(), \
            "Sin IVA cargado en la línea, la columna IVA debería mostrar '—'"
        assert "800,00" in page.locator('.ops-costofinal-cell').nth(0).inner_text(), \
            f"Sin IVA, Costo Final debería ser igual al Costo Neto (800): {page.locator('.ops-costofinal-cell').nth(0).inner_text()!r}"
        assert "1.000,00" in page.locator('.ops-precioneto-cell').nth(0).inner_text() or \
               "1000,00" in page.locator('.ops-precioneto-cell').nth(0).inner_text(), \
            f"Sin IVA, Precio Neto debería ser igual al Precio Venta (1000): {page.locator('.ops-precioneto-cell').nth(0).inner_text()!r}"
        markup_dto = page.locator('.ops-markup-cell').nth(0).inner_text()
        assert "1.25x" in markup_dto, f"Markup debería ser Precio Neto(1000) / Costo Neto(800) = 1.25x: {markup_dto!r}"
        print(f"OK - Costo Final=800, Precio Neto=1000, Markup={markup_dto!r}")

        print("--- IVA / Costo Final / Precio Neto / Markup: línea CON iva 21%, sin descuento ---")
        # costo neto=1000 (sin descuento), iva=21% -> Costo Final=1210.
        # precio_venta=1210 (c/IVA) -> Precio Neto = 1210/1.21 = 1000.
        # Markup = Precio Neto(1000) / Costo Neto(1000) = 1.00x.
        assert "21%" in fila_iva.inner_text(), f"Debería verse la alícuota de IVA (21%): {fila_iva.inner_text()!r}"
        assert "1.210,00" in page.locator('.ops-costofinal-cell').nth(1).inner_text() or \
               "1210,00" in page.locator('.ops-costofinal-cell').nth(1).inner_text(), \
            f"Costo Final debería ser 1000 x 1.21 = 1210: {page.locator('.ops-costofinal-cell').nth(1).inner_text()!r}"
        assert "1.000,00" in page.locator('.ops-precioneto-cell').nth(1).inner_text() or \
               "1000,00" in page.locator('.ops-precioneto-cell').nth(1).inner_text(), \
            f"Precio Neto debería ser 1210 / 1.21 = 1000: {page.locator('.ops-precioneto-cell').nth(1).inner_text()!r}"
        markup_iva = page.locator('.ops-markup-cell').nth(1).inner_text()
        assert "1.00x" in markup_iva, \
            f"Markup debería ser Precio Neto(1000) / Costo Neto(1000) = 1.00x -- Precio Venta(1210) / Costo Final(1210) da lo mismo: {markup_iva!r}"
        print(f"OK - Costo Final=1210, Precio Neto=1000, Markup={markup_iva!r}")

        print("--- Editar el Precio Venta de la línea con descuento recalcula LOS DOS márgenes ---")
        input_dto = page.locator('.ops-precio-input').nth(0)
        input_dto.fill("1600")
        input_dto.blur()
        page.wait_for_timeout(300)
        # precio_venta=1600: real contra costo neto (800) = 50%; "de lista"
        # contra costo bruto (1000) = (1600-1000)/1600 = 37.5%.
        bruto_edit, neto_edit = margen_bruto_y_neto(page, 0)
        assert bruto_edit in ("37.5%", "37,5%"), \
            f"BUG: el margen 'de lista' también debería recalcularse (37.5%): {bruto_edit!r}"
        assert neto_edit in ("50.0%", "50,0%"), \
            f"BUG: tras editar el precio, el margen real debería recalcularse contra el costo neto (50%): {neto_edit!r}"
        print(f"OK - margen de lista: {bruto_edit!r}, margen real: {neto_edit!r}")

        print("--- Precio Neto y Markup también se recalculan en vivo al editar el Precio Venta ---")
        # nuevoPrecio=1600 (sin IVA en esta línea) -> Precio Neto=1600,
        # Markup=1600/800=2.00x.
        precioneto_edit = page.locator('.ops-precioneto-cell').nth(0).inner_text()
        assert "1.600,00" in precioneto_edit or "1600,00" in precioneto_edit, \
            f"BUG: Precio Neto no se recalculó al editar el precio: {precioneto_edit!r}"
        markup_edit = page.locator('.ops-markup-cell').nth(0).inner_text()
        assert "2.00x" in markup_edit, f"BUG: Markup no se recalculó al editar el precio (debería ser 2.00x): {markup_edit!r}"
        print(f"OK - Precio Neto={precioneto_edit!r}, Markup={markup_edit!r}")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: Detalle de compra muestra el costo real (neto del descuento), resalta la línea, y el margen es correcto ===")
        browser.close()


if __name__ == "__main__":
    main()
