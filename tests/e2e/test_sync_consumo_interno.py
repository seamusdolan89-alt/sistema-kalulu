"""
tests/e2e/test_sync_consumo_interno.py — Un Consumo Interno registrado desde
Admin-POS tiene que sincronizar completo al POS del local: el registro en
`consumo_interno`, su espejo en `stock_ajustes`, y sobre todo el movimiento
de stock real (`stock_movimientos`) que hace bajar `stock.cantidad` del
lado del POS.

Pedido del usuario (25/10/2026): "necesito que me confirmes si cuando
registro un consumo interno desde admin pos en mi computadora personal
sincroniza bien con firebase y pos del local, bajando el stock como
corresponde". No es un bug reportado -- es una verificación explícita antes
de confiar en el flujo.

Por qué con sync_sim.py (dos dispositivos reales contra un Firestore falso)
y no solo con la auditoría genérica tabla-por-tabla
(test_sync_convergencia_tablas.py, que ya da 'consumo_interno' y
'stock_movimientos' sin fallas): esa auditoría prueba que CADA TABLA viaja
bien por separado, insertada directo. No prueba que la escritura REAL de
consumo_interno.js (que toca 3 tablas en una sola transacción: consumo_interno
+ stock_movimientos vía moverStock + stock_ajustes) termine bajando el
NÚMERO de stock del otro lado -- exactamente la clase de bug que ya pasó una
vez con 'compras' pisando 'productos' (ver CLAUDE.md, "BUG GRAVE DE
PRECIOS"/Cebolla). Acá se reproduce el mismo código que corre
confirmarConsumo() en consumo_interno.js (líneas ~300-324), no una
re-implementación simplificada.

Dirección probada: Admin-POS -> POS (la que preguntó el usuario). La
dirección inversa y la convergencia genérica de las 3 tablas ya las cubre
test_sync_convergencia_tablas.py.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_consumo_interno.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador


def uno(d, sql, params=None):
    filas = d.q(sql, params or [])
    return filas[0] if filas else None


def stock_de(d, pid, suc):
    r = uno(d, "SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?", [pid, suc])
    return r["cantidad"] if r else None


def main():
    with Simulador() as sim:
        pos, admin = sim.pos, sim.admin
        user = admin.js("() => window.SGA_Auth.getCurrentUser()")
        suc = user["sucursal_id"]

        print("--- Baseline: producto con stock inicial, sincronizado en las DOS compus ---")
        admin.run("""INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida, es_madre,
                       precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
                     VALUES ('prod-ci-sync', 'Producto Consumo Interno Test', 40, 80, 1, 'unidad', 0, 0, 1,
                       '2026-10-25T10:00:00.000Z', '2026-10-25T10:00:00.000Z', 'pending', '2026-10-25T10:00:00.000Z')""")
        admin.js("([p, s]) => window.SGA_DB.moverStock({productoId: p, sucursalId: s, delta: 30, tipo: 'saldo_inicial', motivo: 'seed test'})",
                  ["prod-ci-sync", suc])
        admin.push()
        pos.pull()
        assert stock_de(pos, "prod-ci-sync", suc) == 30, \
            f"El POS debería arrancar con el mismo stock que Admin-POS: {stock_de(pos, 'prod-ci-sync', suc)}"
        print(f"   OK: las dos compus arrancan con stock=30")

        print("--- Admin-POS registra un Consumo Interno de 5 unidades (mismo código que consumo_interno.js) ---")
        # Mirror EXACTO de las 3 escrituras de confirmarConsumo() en
        # js/modules/consumo_interno.js (líneas ~300-324): INSERT consumo_interno,
        # moverStock (delta negativo, tipo='consumo_interno'), INSERT stock_ajustes.
        admin.js("""([productoId, sucursalId, usuarioId]) => {
          const now = new Date().toISOString();
          const consumoId = window.SGA_Utils.generateUUID();
          const ajusteId  = window.SGA_Utils.generateUUID();
          window.SGA_DB.beginBatch();
          window.SGA_DB.run(
            `INSERT INTO consumo_interno
               (id, producto_id, sucursal_id, usuario_id, registrado_por_usuario_id,
                cantidad, costo_unitario, precio_venta_unitario, motivo, observaciones, fecha, sync_status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [consumoId, productoId, sucursalId, usuarioId, usuarioId, 5, 40, 80, 'Uso interno test', null, now, now]
          );
          window.SGA_DB.moverStock({
            productoId, sucursalId, delta: -5,
            tipo: 'consumo_interno', refTipo: 'stock_ajustes', refId: ajusteId,
            motivo: 'Uso interno test', usuarioId, fecha: now,
            crearSiNoExiste: false,
          });
          window.SGA_DB.run(
            `INSERT INTO stock_ajustes
               (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado, sync_status, updated_at)
             VALUES (?, ?, ?, 'consumo_interno', ?, ?, ?, ?, 'aprobado', 'pending', ?)`,
            [ajusteId, productoId, sucursalId, 5, 'Uso interno test', usuarioId, now, now]
          );
          window.SGA_DB.commitBatch();
          window.__consumoId = consumoId;
        }""", ["prod-ci-sync", suc, user["id"]])
        consumo_id = admin.js("() => window.__consumoId")

        assert stock_de(admin, "prod-ci-sync", suc) == 25, \
            f"En Admin-POS el stock debería bajar a 25 de inmediato: {stock_de(admin, 'prod-ci-sync', suc)}"
        assert admin.js("() => window.SGA_DB.verificarIntegridadStock()") == [], \
            "La invariante stock == SUM(movimientos) tiene que valer en Admin-POS"
        print(f"   OK: en Admin-POS el stock ya bajó a 25 (local)")

        print("--- Push (Admin-POS) + Pull (POS) -- el mismo ciclo que corre cada 5 min en producción ---")
        admin.push()
        pos.pull()

        print("--- El registro de Consumo Interno llegó completo al POS ---")
        ci_pos = uno(pos, "SELECT * FROM consumo_interno WHERE id=?", [consumo_id])
        assert ci_pos is not None, "BUG: el registro de consumo_interno nunca llegó al POS"
        assert ci_pos["cantidad"] == 5 and ci_pos["motivo"] == "Uso interno test", f"Datos incompletos: {ci_pos}"
        assert ci_pos["usuario_id"] == user["id"] and ci_pos["registrado_por_usuario_id"] == user["id"], (
            f"La atribución del consumo no llegó bien: {ci_pos}")
        assert ci_pos["sync_status"] == "synced", f"Debería quedar 'synced' del lado receptor: {ci_pos}"
        print(f"   OK: consumo_interno llegó completo: cantidad={ci_pos['cantidad']}, motivo={ci_pos['motivo']!r}")

        print("--- El espejo en stock_ajustes también llegó (lo que ve el Editor de Producto / Informes) ---")
        ajuste_pos = uno(pos, "SELECT * FROM stock_ajustes WHERE producto_id=? AND tipo='consumo_interno' ORDER BY fecha DESC LIMIT 1",
                          ["prod-ci-sync"])
        assert ajuste_pos is not None, "BUG: el espejo en stock_ajustes nunca llegó al POS"
        assert ajuste_pos["cantidad"] == 5 and ajuste_pos["estado"] == "aprobado", f"Datos incompletos: {ajuste_pos}"
        print(f"   OK: stock_ajustes llegó: {ajuste_pos['cantidad']} unidades, estado={ajuste_pos['estado']!r}")

        print("--- Lo que de verdad mueve el número: el movimiento de stock (stock_movimientos) ---")
        mov_pos = uno(pos, "SELECT delta, tipo, ref_tipo FROM stock_movimientos WHERE producto_id=? AND tipo='consumo_interno'",
                       ["prod-ci-sync"])
        assert mov_pos is not None, "BUG: el movimiento de stock del consumo interno nunca llegó al POS"
        assert mov_pos["delta"] == -5 and mov_pos["ref_tipo"] == "stock_ajustes", f"Movimiento incorrecto: {mov_pos}"
        print(f"   OK: movimiento llegó: delta={mov_pos['delta']}, tipo={mov_pos['tipo']}")

        print("--- El stock del POS BAJÓ como corresponde (de 30 a 25) ---")
        stock_final_pos = stock_de(pos, "prod-ci-sync", suc)
        assert stock_final_pos == 25, (
            f"BUG: el stock del POS debería haber bajado a 25 (30 - 5), quedó en {stock_final_pos}")
        assert pos.js("() => window.SGA_DB.verificarIntegridadStock()") == [], (
            "La invariante stock == SUM(movimientos) tiene que valer también en el POS, tras sincronizar")
        print(f"   OK: stock del POS = {stock_final_pos} (30 - 5 = 25), integridad verificada")

        errs = admin.errores + pos.errores
        assert not errs, f"Errores JS: {errs}"
        print("\n=== OK: un Consumo Interno registrado en Admin-POS sincroniza completo y baja el stock en el POS ===")


if __name__ == "__main__":
    main()
