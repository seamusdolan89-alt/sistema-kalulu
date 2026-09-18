"""
tests/e2e/test_sync_admin_push_bandera_pulled.py

Bug real, reportado por el usuario (18/9/2026, proveedor "Agua Belen"): desde el
POS se cargo un pago a proveedor (saldo a favor nuestro); mas tarde, en ADMIN
POS, se cargo el gasto y se le imputo ese pago. El gasto y la imputacion NUNCA
llegaron al POS: la cuenta corriente del proveedor mostraba $5.400 a favor en el
POS y $0 en Admin-POS.

Causa: el POS solo descarga los documentos de Firestore que tienen la marca
`_pulled: false` (pullFromFirestore). Admin-POS tiene DOS funciones de push:

  - pushToPos()    -> sube con `_pulled: false`  (correcta para admin)
  - pushPending()  -> es la del POS: hace `delete data._pulled` y sube SIN la
                      marca (correcto en el POS, donde sus docs no deben volver
                      a bajarse a si mismo)

gastos.js (y compras_v2, caja, aprobaciones_pendientes, pos) llaman
`SGA_Sync.pushPending()` despues de guardar. Estando en Admin-POS eso mandaba el
gasto sin la marca Y dejaba la fila como 'synced' -> ni el POS lo descargaba ni
pushToPos() lo volvia a mandar.

Segundo agujero (mismo sintoma en otras tablas): pushToPos() solo subia una
lista fija (ADMIN_PUSH_TABLES) y dejaba afuera 8 tablas para las que el POS SI
tiene receptor (categorias, stock_ajustes, gastos_pagos, devoluciones,
system_config, flujo_*): el POS sabe aplicarlas pero el admin nunca las mandaba.

Este test no pasa por Firebase real: usa `__testForceInitialized()` con un
Firestore falso que registra cada `batch.set()`.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_admin_push_bandera_pulled.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

FAKE_FIRESTORE_JS = """
() => {
  const sets = [];
  const emptySnap = { empty: true, size: 0, docs: [] };
  const fakeDb = {
    collection(name) {
      return {
        where() { return this; }, orderBy() { return this; }, limit() { return this; },
        async get() { return emptySnap; },
        doc(id) { return { id, path: name + '/' + id }; },
      };
    },
    batch() {
      return {
        set(ref, data) {
          sets.push({
            path: ref.path,
            tiene_pulled: '_pulled' in data,
            pulled: data._pulled,
            imputaciones: (data._imputaciones || []).map(i => i.gasto_id),
          });
        },
        async commit() {},
      };
    },
  };
  window.__sets = sets;
  window.SGA_Sync.__testForceInitialized(fakeDb);
}
"""

SETUP_AGUA_BELEN_JS = """
() => {
  const now = new Date().toISOString();
  const db = window.SGA_DB;
  db.run(`INSERT INTO proveedores (id, razon_social, activo) VALUES ('prov-ab', 'Agua Belen Test', 1)`);
  // 1) El pago llego desde el POS (ya sincronizado en la base del admin)
  db.run(`INSERT INTO pagos_proveedores (id, proveedor_id, fecha, sync_status, updated_at)
          VALUES ('pago-ab', 'prov-ab', '2026-09-18', 'synced', ?)`, [now]);
  // 2) El admin carga el gasto (gastos.js -> insertGasto: queda 'pending')
  db.run(`INSERT INTO gastos (id, fecha, categoria, descripcion, monto, proveedor_id, sync_status, updated_at)
          VALUES ('gasto-ab', '2026-09-18', 'servicios', 'Bidon de agua', 5400, 'prov-ab', 'pending', ?)`, [now]);
  // 3) Le imputa el pago (cuenta_corriente_proveedores.js: inserta la imputacion
  //    y marca el pago 'pending' para que se re-sincronice con la imputacion adentro)
  db.run(`INSERT INTO imputaciones_pagos (id, pago_id, gasto_id, monto_imputado, fecha)
          VALUES ('imp-ab', 'pago-ab', 'gasto-ab', 5400, '2026-09-18')`);
  db.run(`UPDATE pagos_proveedores SET sync_status='pending', updated_at=? WHERE id='pago-ab'`, [now]);

  // Filas pendientes en tablas que ANTES no subian desde Admin-POS
  db.run(`INSERT INTO categorias (id, nombre, sync_status, updated_at) VALUES ('cat-ab', 'Categoria Admin Test', 'pending', ?)`, [now]);
  db.run(`INSERT INTO gastos_pagos (id, gasto_id, fecha, metodo_pago, monto, sync_status, updated_at)
          VALUES ('gp-ab', 'gasto-ab', '2026-09-18', 'efectivo', 100, 'pending', ?)`, [now]);
  db.run(`INSERT INTO stock_ajustes (id, tipo, cantidad, motivo, fecha, sync_status, updated_at)
          VALUES ('sa-ab', 'ajuste_positivo', 1, 'test', ?, 'pending', ?)`, [now, now]);
  window.__sets.length = 0;
}
"""


def docs(page, prefijo):
    return [s for s in page.evaluate("() => window.__sets") if s["path"].startswith(prefijo)]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        login_via_seed(page, admin_pos=True, wait_target="productos")
        page.evaluate(FAKE_FIRESTORE_JS)
        page.evaluate(SETUP_AGUA_BELEN_JS)

        print("--- Caso Agua Belen: gastos.js guarda el gasto y llama pushPending() (estando en Admin-POS) ---")
        page.evaluate("() => window.SGA_Sync.pushPending()")

        gasto = docs(page, "gastos/gasto-ab")
        assert len(gasto) == 1, f"El gasto ni siquiera se subio: {gasto}"
        assert gasto[0]["pulled"] is False, (
            f"BUG: el gasto cargado en Admin-POS se subio SIN _pulled:false (tiene_pulled="
            f"{gasto[0]['tiene_pulled']}, valor={gasto[0]['pulled']!r}) -> el POS nunca lo descarga."
        )

        pago = docs(page, "pagos_proveedores/pago-ab")
        assert len(pago) == 1, f"El pago con la imputacion nueva no se subio: {pago}"
        assert pago[0]["pulled"] is False, (
            f"BUG: el pago re-sincronizado con su imputacion se subio SIN _pulled:false "
            f"(valor={pago[0]['pulled']!r}) -> el POS nunca se entera de que se imputo."
        )
        assert pago[0]["imputaciones"] == ["gasto-ab"], (
            f"La imputacion no viajo embebida en el pago: {pago[0]['imputaciones']}"
        )
        estado = page.evaluate("() => window.SGA_DB.query(`SELECT sync_status FROM gastos WHERE id='gasto-ab'`)[0].sync_status")
        assert estado == "synced", f"El gasto deberia quedar synced despues de subir, esta {estado!r}"
        print("OK - el gasto y el pago con su imputacion suben con _pulled:false")

        print("--- Tablas que antes Admin-POS NUNCA mandaba aunque el POS sabe recibirlas ---")
        for prefijo, nombre in [("categorias/cat-ab", "categorias"),
                                ("gastos_pagos/gp-ab", "gastos_pagos"),
                                ("stock_ajustes/sa-ab", "stock_ajustes")]:
            d = docs(page, prefijo)
            assert len(d) == 1, (
                f"BUG: {nombre} pendiente en Admin-POS no se subio: pushToPos() usaba una lista fija "
                f"que dejaba afuera esta tabla."
            )
            assert d[0]["pulled"] is False, f"{nombre} subio sin _pulled:false: {d[0]}"
        print("OK - categorias, gastos_pagos y stock_ajustes tambien suben con _pulled:false")

        assert not errors, f"Errores JS no capturados: {errors}"
        context_ok = True
        browser.close()
        print("\nOK - test_sync_admin_push_bandera_pulled: PASA")


if __name__ == "__main__":
    main()
