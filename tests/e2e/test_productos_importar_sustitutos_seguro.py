"""
tests/e2e/test_productos_importar_sustitutos_seguro.py — La importación de productos
no puede dejar grupos de sustitutos rotos (duplicados, cadenas, ciclos, inexistentes).

Se alimenta la importación REAL (Productos.importarDesdeExcel) con un archivo caótico
a propósito y se exige:
  1. El archivo con filas contradictorias (anillo A<->B, referencia que ya es miembro
     de otro grupo, un producto con dos referencias, una referencia que no existe)
     termina con `diagnosticar()` limpio y con avisos claros para el usuario.
  2. Reasignar la referencia de un producto que ya tenía otra: cambia (no duplica) y avisa.
  3. Red de seguridad: si por un bug futuro la pasada de sustitutos dejara algo
     inconsistente, la importación se CANCELA entera (y no se guarda nada).

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_productos_importar_sustitutos_seguro.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

IMPORTAR = """
(args) => {
  const filas = args.filas;
  const r = window.SGA_Productos.importarDesdeExcel(filas, args.suc);
  return r;
}
"""

DIAG = "() => { const d = window.SGA_GruposSustitutos.diagnosticar(); return { ok: d.ok, d }; }"
REFS = """() => {
  const r = window.SGA_DB.query(`SELECT p.nombre, rp.nombre AS ref FROM producto_sustitutos ps
    JOIN productos p ON p.id = ps.producto_id JOIN productos rp ON rp.id = ps.referencia_id
    WHERE p.nombre LIKE 'IM %' ORDER BY p.nombre`);
  const por = {};
  r.forEach(x => { (por[x.nombre] = por[x.nombre] || []).push(x.ref); });
  return por;
}"""


def fila(cod, nombre, ref=None):
    f = {"codigo_barras": cod, "nombre": nombre, "costo": 10, "precio_venta": 20}
    if ref is not None:
        f["codigo_sustituto_referencia"] = ref
    return f


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=False)
        page.evaluate("window.location.hash = 'informes'")   # carga el motor
        page.wait_for_timeout(700)
        page.evaluate("window.location.hash = 'productos'")
        page.wait_for_timeout(900)
        suc = page.evaluate("window.SGA_DB.query('SELECT id FROM sucursales LIMIT 1')[0].id")

        print("--- 1) Archivo caotico: queda todo consistente y con avisos ---")
        filas = [
            fila("7000001", "IM A", "7000002"),      # A -> B
            fila("7000002", "IM B", "7000001"),      # B -> A  (anillo con la fila anterior)
            fila("7000003", "IM C", "7000002"),      # C -> B
            fila("7000004", "IM D", "7000003"),      # D -> C   (C ya es miembro: se une a la referencia real)
            fila("7000005", "IM E", "7000004"),      # E -> D
            fila("7000005", "IM E", "7000001"),      # E otra vez, con otra referencia (contradictoria)
            fila("7000006", "IM F", "7999999"),      # F -> un codigo que no existe
        ]
        r = page.evaluate(IMPORTAR, {"filas": filas, "suc": suc})
        d = page.evaluate(DIAG)
        assert d["ok"], f"El archivo dejo grupos inconsistentes: {d['d']}"
        avisos = " | ".join(r["sustitutosAvisos"])
        assert "dos referencias distintas" in avisos, avisos
        assert "ciclo" in avisos, avisos
        assert "7999999" in " ".join(r["sustitutosPendientes"]), r["sustitutosPendientes"]
        refs = page.evaluate(REFS)
        # cada producto agrupado tiene UNA sola referencia
        assert all(len(v) == 1 for v in refs.values()), refs
        print("OK -", refs)

        print("--- 2) Reasignar un producto que ya tenia otra referencia: cambia, no duplica, avisa ---")
        otro = page.evaluate("window.SGA_DB.query(\"SELECT id FROM productos WHERE nombre = 'IM C'\")[0].id")
        antes = page.evaluate("(id) => window.SGA_GruposSustitutos.referenciaRealDe(id)", otro)
        filas2 = [fila("7000008", "IM G"), fila("7000003", "IM C", "7000008")]
        r2 = page.evaluate(IMPORTAR, {"filas": filas2, "suc": suc})
        d = page.evaluate(DIAG)
        assert d["ok"], d["d"]
        despues = page.evaluate("(id) => window.SGA_GruposSustitutos.referenciaRealDe(id)", otro)
        assert despues != antes, "La referencia de IM C deberia haber cambiado"
        assert any("ya tenía otra referencia" in a for a in r2["sustitutosAvisos"]), r2["sustitutosAvisos"]
        print("OK")

        print("--- 3) Red de seguridad: si algo dejara los grupos rotos, se cancela la importacion ---")
        page.evaluate("""() => {
          const G = window.SGA_GruposSustitutos;
          window.__moverOriginal = G.moverMiembro;
          // Bug simulado: deja una SEGUNDA fila para el producto (duplicado)
          G.moverMiembro = (prodId, refId) => {
            window.SGA_DB.run(`INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
                               VALUES (?, ?, ?, 1, 'x')`, [prodId, refId, refId]);
            window.SGA_DB.run(`INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
                               VALUES (?, 'otra', 'otra', 1, 'x')`, [prodId]);
            return { estado: 'ok', refEfectiva: refId, antes: null };
          };
        }""")
        resultado = page.evaluate("""(args) => {
          try { window.SGA_Productos.importarDesdeExcel(args.filas, args.suc); return { ok: true }; }
          catch (e) { window.SGA_DB.rollbackBatch(); return { ok: false, error: String(e.message || e) }; }
        }""", {"filas": [fila("7000020", "IM H"), fila("7000021", "IM I", "7000020")], "suc": suc})
        page.evaluate("window.SGA_GruposSustitutos.moverMiembro = window.__moverOriginal")
        assert not resultado["ok"], "La importacion deberia haberse cancelado"
        assert "No se guardó nada" in resultado["error"], resultado
        quedo = page.evaluate("window.SGA_DB.query(\"SELECT COUNT(*) AS n FROM productos WHERE nombre IN ('IM H','IM I')\")[0].n")
        assert quedo == 0, f"El rollback tendria que haber dejado los productos sin guardar: {quedo}"
        assert page.evaluate(DIAG)["ok"], "Y los grupos siguen sanos"
        print("OK")

        assert not errors, f"Errores JS: {errors}"
        print("\n=== OK: la importacion no puede dejar grupos de sustitutos rotos ===")
        browser.close()


if __name__ == "__main__":
    main()
