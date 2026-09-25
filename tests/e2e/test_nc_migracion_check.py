"""
tests/e2e/test_nc_migracion_check.py — Una base YA existente (con el CHECK viejo de
pagos_proveedores_metodos) se migra sola para aceptar el método 'nota_credito', sin
perder ninguno de sus pagos.

El CHECK de `metodo` estaba fijo en ('efectivo','transferencia','caja_seamus',
'mercadopago'). Una NC es un pago de método 'nota_credito', así que las bases que
ya están en producción (POS del local y Admin-POS) necesitan que db.js reconstruya
la tabla al arrancar — el mismo patrón de migración que ya se usó antes para sumar
caja_seamus y mercadopago. Este test arma una base "vieja" (CHECK viejo + un pago
real adentro), recarga la app y verifica que:
  - la tabla ahora acepta 'nota_credito',
  - los pagos que había siguen intactos,
  - y las columnas / la tabla de líneas de la NC existen.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_nc_migracion_check.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

ARMAR_BASE_VIEJA = """
async () => {
  const db = window.SGA_DB;
  const now = new Date().toISOString();
  const prov = db.query(`SELECT id FROM proveedores LIMIT 1`)[0].id;
  db.run(`INSERT INTO pagos_proveedores (id, proveedor_id, fecha, sync_status, updated_at)
          VALUES ('pago-viejo', ?, '2026-08-01', 'synced', ?)`, [prov, now]);
  // La tabla con el CHECK VIEJO, tal como esta en una instalacion anterior a las NC
  db.run(`ALTER TABLE pagos_proveedores_metodos RENAME TO pagos_proveedores_metodos_bak`);
  db.run(`CREATE TABLE pagos_proveedores_metodos (
    id TEXT PRIMARY KEY,
    pago_id TEXT NOT NULL REFERENCES pagos_proveedores(id),
    metodo TEXT NOT NULL CHECK(metodo IN ('efectivo','transferencia','caja_seamus','mercadopago')),
    monto REAL NOT NULL,
    referencia TEXT,
    sesion_caja_id TEXT REFERENCES sesiones_caja(id)
  )`);
  db.run(`INSERT INTO pagos_proveedores_metodos SELECT * FROM pagos_proveedores_metodos_bak`);
  db.run(`DROP TABLE pagos_proveedores_metodos_bak`);
  db.run(`INSERT INTO pagos_proveedores_metodos (id, pago_id, metodo, monto, referencia)
          VALUES ('met-viejo', 'pago-viejo', 'transferencia', 777, 'ref-vieja')`);
  await db.flush();
  const sql = db.query(`SELECT sql FROM sqlite_master WHERE name='pagos_proveedores_metodos'`)[0].sql;
  return sql.includes('nota_credito');
}
"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        print("--- Login admin-pos y armar una base con el CHECK viejo + un pago real ---")
        login_via_seed(page, admin_pos=True)
        tiene_nc = page.evaluate(ARMAR_BASE_VIEJA)
        assert tiene_nc is False, "La base 'vieja' no quedó con el CHECK viejo: el test no prueba nada"

        print("--- Recargar la app: db.js debe migrar la tabla ---")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1200)

        sql = page.evaluate("() => window.SGA_DB.query(`SELECT sql FROM sqlite_master WHERE name='pagos_proveedores_metodos'`)[0].sql")
        print(f"CHECK actual: {sql[sql.index('CHECK'):sql.index('CHECK') + 110]}")
        assert "nota_credito" in sql, "BUG: db.js no amplió el CHECK: una NC no se podría guardar en una base existente"

        fila = page.evaluate("() => window.SGA_DB.query(`SELECT metodo, monto, referencia FROM pagos_proveedores_metodos WHERE id='met-viejo'`)")
        assert fila == [{"metodo": "transferencia", "monto": 777, "referencia": "ref-vieja"}], (
            f"BUG: la migración perdió o alteró un pago existente: {fila}")

        print("--- La tabla migrada acepta una NC; existen las columnas y la tabla de líneas ---")
        ok = page.evaluate("""() => {
          const db = window.SGA_DB;
          db.run(`INSERT INTO pagos_proveedores (id, proveedor_id, fecha, tipo, numero_comprobante, sync_status, updated_at)
                  VALUES ('nc-mig', (SELECT id FROM proveedores LIMIT 1), '2026-09-01', 'nota_credito', 'X-1', 'pending', ?)`, [new Date().toISOString()]);
          db.run(`INSERT INTO pagos_proveedores_metodos (id, pago_id, metodo, monto) VALUES ('met-nc', 'nc-mig', 'nota_credito', 50)`);
          db.run(`INSERT INTO pagos_proveedores_items (id, pago_id, tipo, concepto, subtotal) VALUES ('it-nc', 'nc-mig', 'concepto', 'x', 50)`);
          return {
            metodo: db.query(`SELECT COUNT(*) AS n FROM pagos_proveedores_metodos WHERE id='met-nc'`)[0].n,
            item: db.query(`SELECT COUNT(*) AS n FROM pagos_proveedores_items WHERE id='it-nc'`)[0].n,
            pagoViejoTipo: db.query(`SELECT tipo FROM pagos_proveedores WHERE id='pago-viejo'`)[0].tipo,
          };
        }""")
        print(f"resultado: {ok}")
        assert ok["metodo"] == 1, "La tabla migrada no acepta el método 'nota_credito'"
        assert ok["item"] == 1, "Falta la tabla de líneas de la NC"
        assert ok["pagoViejoTipo"] == "pago", f"Un pago existente debería quedar con tipo 'pago': {ok['pagoViejoTipo']!r}"

        assert not errors, f"Errores JS no capturados en página: {errors}"
        print("OK - una base existente se migra sola para aceptar notas de crédito, sin perder pagos.")
        browser.close()


if __name__ == "__main__":
    main()
