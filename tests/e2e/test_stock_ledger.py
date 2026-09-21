"""
tests/e2e/test_stock_ledger.py — Registro de MOVIMIENTOS de stock (ledger).

ETAPA 1 (18/9/2026): hasta entonces `stock.cantidad` era el UNICO dato: 25 sentencias
UPDATE/INSERT repartidas en 12 archivos lo modificaban y nada explicaba "por que tengo 17".
Seis de ellas (auditoria del 16/9/2026) ni marcaban la fila para sincronizar. Se creo UN
solo punto de escritura, `SGA_DB.moverStock()`, que en una transaccion agrega un movimiento
inmutable a `stock_movimientos` (delta, tipo, referencia, quien, cuando), actualiza la cache
`stock.cantidad` y registra la foto de historial_stock — pero el registro era local a cada
compu (sin sync_status).

ETAPA 2 (20/9/2026): `stock_movimientos` sincroniza como cualquier tabla, y `stock`
(la cache, valor absoluto) deja de aplicarse en el ciclo continuo — sigue existiendo SOLO
para el bootstrap rapido de un dispositivo nuevo (ver ESSENTIAL_COLLECTIONS en sync.js).
Cada movimiento tiene su propio id (uuid, o determinístico `saldo_inicial:<producto>:
<sucursal>` para el arranque) y es INMUTABLE: aplicarlo del otro lado es siempre
INSERT OR IGNORE, nunca un UPDATE — dos compus pueden mover el MISMO producto sin verse y
el total final es siempre la suma real, sin importar el orden en que lleguen los
movimientos ("el ultimo que escribe pisa al otro" deja de poder pasar).

Invariante (lo que este test defiende): para todo (producto, sucursal), stock.cantidad ==
SUM(stock_movimientos.delta). `SGA_DB.verificarIntegridadStock()` lista las filas que no cumplen.

Casos:
  - moverStock: crea movimiento + cache; crea la fila si no existia; puede NO crearla
    (`crearSiNoExiste:false`, lo que hacian la venta/devolucion/anulacion); delta 0 no registra
    nada; tira si falta el tipo (los errores dejaron de tragarse).
  - setStockAbsoluto (editor de producto, importacion): "poner el stock en N" se registra como un
    movimiento por la DIFERENCIA.
  - Relleno inicial: una base con stock y sin movimientos recibe un 'saldo_inicial' por fila, y
    una sola vez.
  - Flujos reales del POS con integridad verificada: venta, edicion de venta, anulacion y
    devolucion.
  - Sync (etapa 2): un movimiento sube y baja TAL CUAL (no como 'sync' generico); dos compus
    mueven el mismo producto sin coordinarse y el total converge en las dos; aplicar el mismo
    movimiento dos veces (redelivery real de Firestore) no lo duplica; un dispositivo NUEVO
    arranca con el bootstrap rapido de `stock` y se autocorrige solo cuando le llega el
    historial real, sin generar ningun movimiento 'sync'.
  - Regla estatica: ningun otro archivo escribe la tabla stock.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_stock_ledger.py
"""
import glob
import os
import re
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def integridad(d):
    return d.js("() => window.SGA_DB.verificarIntegridadStock()")


def stock_de(d, pid, suc):
    r = d.q("SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?", [pid, suc])
    return r[0]["cantidad"] if r else None


def movs(d, pid, suc=None):
    return d.q("SELECT delta, tipo, ref_tipo, ref_id, motivo FROM stock_movimientos WHERE producto_id=? "
               "ORDER BY rowid", [pid])


def regla_estatica():
    """Solo js/db.js puede escribir la tabla stock (y la lista de excepciones vacia a proposito)."""
    pat = re.compile(r"(UPDATE\s+stock\b(?!_)|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+stock\b(?!_)|"
                     r"REPLACE\s+INTO\s+stock\b(?!_)|DELETE\s+FROM\s+stock\b(?!_))", re.I)
    infractores = []
    for f in sorted(glob.glob(os.path.join(REPO_ROOT, "js", "**", "*.js"), recursive=True)):
        rel = os.path.relpath(f, REPO_ROOT).replace("\\", "/")
        if rel in ("js/db.js",):
            continue
        src = open(f, encoding="utf-8").read()
        for m in pat.finditer(src):
            infractores.append(f"{rel}:{src.count(chr(10), 0, m.start()) + 1}")
    assert not infractores, (
        "BUG: estas lineas escriben la tabla stock directo en vez de pasar por SGA_DB.moverStock / "
        "setStockAbsoluto / bootstrapStockAbsoluto / aplicarMovimientoStock: " + ", ".join(infractores))


def main():
    print("--- Regla estatica: solo db.js escribe stock ---")
    regla_estatica()
    print("OK")

    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        user = pos.js("() => window.SGA_Auth.getCurrentUser()")
        suc = user["sucursal_id"]

        # Producto propio, con stock inicial cargado por el punto unico
        pos.run("""INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
                     precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                   VALUES ('prod-led', 'Producto Ledger', 50, 100, 1, 'unidad', 0, 0, 1,
                     '2026-09-18T10:00:00.000Z', '2026-09-18T10:00:00.000Z', 'synced', '2026-09-18T10:00:00.000Z')""")

        print("--- moverStock: crea la fila y el movimiento ---")
        mid = pos.js("([p, s]) => window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: 20, tipo: 'compra', refTipo: 'compras', refId: 'c-1', motivo: 'carga'})",
                     ["prod-led", suc])
        assert mid, "moverStock no devolvio el id del movimiento"
        assert stock_de(pos, "prod-led", suc) == 20, stock_de(pos, "prod-led", suc)
        m = movs(pos, "prod-led")
        assert len(m) == 1 and m[0]["delta"] == 20 and m[0]["tipo"] == "compra" and m[0]["ref_id"] == "c-1", m
        assert pos.q("SELECT sync_status FROM stock WHERE producto_id='prod-led'")[0]["sync_status"] == "pending", \
            "la fila de stock tiene que quedar 'pending' para que viaje"
        assert integridad(pos) == [], integridad(pos)
        print("   OK: fila 20, un movimiento 'compra', queda pending")

        print("--- moverStock: resta, y delta 0 no registra nada ---")
        pos.js("([p, s]) => window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: -3, tipo: 'rotura'})", ["prod-led", suc])
        r0 = pos.js("([p, s]) => window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: 0, tipo: 'ajuste_positivo'})", ["prod-led", suc])
        assert r0 is None, f"un delta 0 no deberia registrar movimiento: {r0}"
        assert stock_de(pos, "prod-led", suc) == 17 and len(movs(pos, "prod-led")) == 2
        assert integridad(pos) == []
        print("   OK: 17 y 2 movimientos")

        print("--- crearSiNoExiste:false: como la venta, no crea stock que no existia ---")
        pos.run("""INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
                     precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                   VALUES ('prod-sin-stock', 'Sin stock', 1, 2, 0, 'unidad', 0, 0, 1,
                     '2026-09-18T10:00:00.000Z', '2026-09-18T10:00:00.000Z', 'synced', '2026-09-18T10:00:00.000Z')""")
        r = pos.js("([p, s]) => window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: -2, tipo: 'venta', crearSiNoExiste: false})", ["prod-sin-stock", suc])
        assert r is None and stock_de(pos, "prod-sin-stock", suc) is None and movs(pos, "prod-sin-stock") == [], \
            "con crearSiNoExiste:false no debe crear fila ni movimiento (comportamiento previo de la venta)"
        print("   OK: sin fila, sin movimiento")

        print("--- moverStock tira si falta el tipo (antes los errores se tragaban) ---")
        err = pos.js("""([p, s]) => { try { window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: 1}); return null; }
                                       catch (e) { return e.message; } }""", ["prod-led", suc])
        assert err and "tipo" in err, f"deberia tirar por falta de tipo: {err!r}"
        assert stock_de(pos, "prod-led", suc) == 17, "un movimiento invalido no puede cambiar el stock"
        print("   OK:", err)

        print("--- setStockAbsoluto: 'poner el stock en 12' es un movimiento por la diferencia ---")
        pos.js("([p, s]) => window.SGA_DB.setStockAbsoluto({productoId: p, sucursalId: s, cantidad: 12, tipo: 'ajuste_conteo', motivo: 'conteo'})", ["prod-led", suc])
        assert stock_de(pos, "prod-led", suc) == 12
        ult = movs(pos, "prod-led")[-1]
        assert ult["delta"] == -5 and ult["tipo"] == "ajuste_conteo", ult
        assert integridad(pos) == []
        print("   OK: 17 -> 12 = movimiento -5")

        print("--- Relleno inicial: base con stock y sin movimientos ---")
        pos.run("INSERT OR REPLACE INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at) "
                "VALUES ('prod-viejo', ?, 8, '2026-01-01T00:00:00.000Z', 'synced', '2026-01-01T00:00:00.000Z')", [suc])
        assert len(integridad(pos)) == 1, "un stock cargado por fuera del punto unico tiene que verse como inconsistencia"
        pos.run("DELETE FROM stock_movimientos")
        n = pos.js("() => window.SGA_DB.backfillSaldoInicial()")
        assert n >= 1, f"el relleno deberia crear movimientos: {n}"
        assert integridad(pos) == [], f"despues del relleno tiene que cuadrar: {integridad(pos)}"
        base = pos.q("SELECT delta, tipo FROM stock_movimientos WHERE producto_id='prod-viejo'")
        assert base == [{"delta": 8, "tipo": "saldo_inicial"}], base
        assert pos.js("() => window.SGA_DB.backfillSaldoInicial()") == 0, "el relleno no puede repetirse (taparia errores)"
        print("   OK: un 'saldo_inicial' por fila, una sola vez")

        print("--- Flujos reales del POS: venta, edicion, anulacion, devolucion ---")
        pos.js("async () => { await import('/js/modules/pos.js'); await import('/js/modules/caja.js'); }")
        ses = pos.js("([s, u]) => window.SGA_Caja.abrirCaja(s, u, 0)", [suc, user["id"]])
        assert ses["success"], ses
        venta = pos.js("""([s, u, ses]) => window.SGA_POS.registrarVenta({
              sesionCajaId: ses, sucursalId: s, usuarioId: u, clienteId: null, descuentoGlobal: 0,
              items: [{ productoId: 'prod-led', cantidad: 4, precioUnitario: 100, costoUnitario: 50, descuentoItem: 0 }],
              pagos: [{ medio: 'efectivo', monto: 400 }] })""", [suc, user["id"], ses["sesionId"]])
        assert venta["success"], venta
        assert stock_de(pos, "prod-led", suc) == 8, f"12 - 4 = 8, es {stock_de(pos, 'prod-led', suc)}"
        assert movs(pos, "prod-led")[-1]["tipo"] == "venta" and movs(pos, "prod-led")[-1]["delta"] == -4
        assert integridad(pos) == [], integridad(pos)
        print("   venta: -4 (tipo 'venta')")

        ed = pos.js("""([s, u, ses, vid]) => window.SGA_POS.registrarVenta({
              ventaId: vid, sesionCajaId: ses, sucursalId: s, usuarioId: u, clienteId: null, descuentoGlobal: 0,
              items: [{ productoId: 'prod-led', cantidad: 1, precioUnitario: 100, costoUnitario: 50, descuentoItem: 0 }],
              pagos: [{ medio: 'efectivo', monto: 100 }] })""", [suc, user["id"], ses["sesionId"], venta["ventaId"]])
        assert ed["success"], ed
        assert stock_de(pos, "prod-led", suc) == 11, f"al editar la venta a 1 unidad: 12 - 1 = 11, es {stock_de(pos, 'prod-led', suc)}"
        assert integridad(pos) == [], integridad(pos)
        print("   edicion de venta: 4 -> 1 unidad, stock 11")

        an = pos.js("(id) => window.SGA_POS.anularVenta(id, 'test')", venta["ventaId"])
        assert an["success"], an
        assert stock_de(pos, "prod-led", suc) == 12, f"anular devuelve la unidad: 12, es {stock_de(pos, 'prod-led', suc)}"
        assert integridad(pos) == [], integridad(pos)
        print("   anulacion: vuelve a 12")

        v2 = pos.js("""([s, u, ses]) => window.SGA_POS.registrarVenta({
              sesionCajaId: ses, sucursalId: s, usuarioId: u, clienteId: null, descuentoGlobal: 0,
              items: [{ productoId: 'prod-led', cantidad: 2, precioUnitario: 100, costoUnitario: 50, descuentoItem: 0 }],
              pagos: [{ medio: 'efectivo', monto: 200 }] })""", [suc, user["id"], ses["sesionId"]])
        dv = pos.js("""([vid, ses]) => window.SGA_POS.registrarDevolucion(vid,
              [{ productoId: 'prod-led', cantidad: 1, precio: 100 }], 'arrepentimiento', 'efectivo', { id: ses })""",
                    [v2["ventaId"], ses["sesionId"]])
        assert dv["success"], dv
        assert stock_de(pos, "prod-led", suc) == 11, f"12 - 2 + 1 = 11, es {stock_de(pos, 'prod-led', suc)}"
        assert integridad(pos) == [], integridad(pos)
        print("   devolucion: +1, stock 11")

        print("--- Etapa 2: los movimientos suben y bajan TAL CUAL (no como un 'sync' generico) ---")
        firma = lambda ms: sorted((m["tipo"], round(m["delta"], 4), m["ref_id"]) for m in ms)  # noqa: E731
        antes = firma(movs(pos, "prod-led"))
        pos.push()
        admin.pull()
        assert stock_de(admin, "prod-led", suc) == 11, f"el admin recibe 11: {stock_de(admin, 'prod-led', suc)}"
        assert integridad(admin) == [], f"la invariante tiene que valer del lado admin: {integridad(admin)}"
        despues = firma(movs(admin, "prod-led"))
        assert despues == antes, f"los movimientos que llegaron al admin no son los mismos que los del POS: {despues} vs {antes}"
        assert all(m["tipo"] != "sync" for m in movs(admin, "prod-led")), "ya no deberia crearse el tipo 'sync' (era de la etapa 1)"
        print(f"   OK: los {len(antes)} movimientos llegaron tal cual al admin, con su tipo real; stock=11")

        print("--- Concurrencia: las DOS compus mueven el MISMO producto sin coordinarse ---")
        pos.js("([p, s]) => window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: -2, tipo: 'rotura'})", ["prod-led", suc])
        admin.js("([p, s]) => window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: 5, tipo: 'ajuste_positivo'})", ["prod-led", suc])
        assert stock_de(pos, "prod-led", suc) == 9 and stock_de(admin, "prod-led", suc) == 16, (
            "cada una ve solo su propio cambio antes de sincronizar")
        pos.push()
        admin.push()
        admin.pull()
        pos.pull()
        esperado = stock_de(pos, "prod-led", suc)
        assert esperado == 14, f"11 - 2 + 5 = 14 en las dos compus, sea cual sea el orden en que llegaron; es {esperado}"
        assert stock_de(admin, "prod-led", suc) == esperado, "las dos compus tienen que terminar en el MISMO numero"
        assert integridad(pos) == [] and integridad(admin) == []
        print(f"   OK: las dos compus convergen a {esperado} sin que ninguna se haya pisado")

        print("--- Idempotencia: el mismo movimiento aplicado dos veces (redelivery real de Firestore) no duplica nada ---")
        mov = {"id": "mov-idem-test", "producto_id": "prod-led", "sucursal_id": suc, "delta": 100,
               "tipo": "compra", "ref_tipo": None, "ref_id": None, "motivo": "test idempotencia",
               "usuario_id": None, "fecha": "2026-09-20T00:00:00.000Z", "updated_at": "2026-09-20T00:00:00.000Z"}
        admin.js("(m) => window.SGA_DB.aplicarMovimientoStock(m)", mov)
        una_vez = stock_de(admin, "prod-led", suc)
        admin.js("(m) => window.SGA_DB.aplicarMovimientoStock(m)", mov)  # mismo id, se "reenvia"
        assert una_vez == esperado + 100, f"deberia sumar 100 la primera vez: {esperado} -> {una_vez}"
        assert stock_de(admin, "prod-led", suc) == una_vez, "BUG: aplicar el mismo movimiento dos veces sumo dos veces"
        n_con_ese_id = admin.q("SELECT COUNT(*) AS n FROM stock_movimientos WHERE id='mov-idem-test'")[0]["n"]
        assert n_con_ese_id == 1, f"tiene que quedar UNA sola fila con ese id, hay {n_con_ese_id}"
        assert integridad(admin) == []
        # deshacer el movimiento de prueba para no arrastrarlo al resto del test
        admin.run("DELETE FROM stock_movimientos WHERE id='mov-idem-test'")
        admin.run("UPDATE stock SET cantidad=? WHERE producto_id='prod-led' AND sucursal_id=?", [esperado, suc])
        print("   OK: redelivery del mismo id no duplica el efecto")

        print("--- Dispositivo NUEVO: bootstrap rapido de 'stock' + autocorreccion cuando llega el historial real ---")
        pos.push()
        admin.push()
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        stock_nuevo = stock_de(nuevo, "prod-led", suc)
        assert stock_nuevo == esperado, f"el bootstrap + historial tiene que terminar en {esperado}, dio {stock_nuevo}"
        assert integridad(nuevo) == [], f"tras el historial completo la invariante tiene que valer: {integridad(nuevo)}"
        movs_nuevo = movs(nuevo, "prod-led")
        assert movs_nuevo and all(m["tipo"] != "sync" for m in movs_nuevo), (
            f"el dispositivo nuevo tiene que recibir los movimientos REALES, nunca un 'sync': {movs_nuevo}")
        print(f"   OK: dispositivo nuevo termina en {stock_nuevo} con {len(movs_nuevo)} movimientos reales, sin 'sync'")

        errs = pos.errores + admin.errores + nuevo.errores
        assert not errs, f"Errores JS: {errs}"
        print("\nOK - test_stock_ledger")


if __name__ == "__main__":
    main()
