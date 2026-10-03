"""
tests/e2e/test_grupos_sustitutos_fuzz.py — Prueba de propiedades del motor de grupos
de sustitutos (js/modules/grupos_sustitutos.js).

Pregunta que responde: "¿cómo nos aseguramos de que NINGÚN camino (importación,
editor, Órdenes, Compras, el reporte) vuelva a generar filas duplicadas, cadenas,
ciclos o referencias inexistentes?". No alcanza con probar casos sueltos: acá se
lanzan cientos de operaciones AL AZAR (con semilla fija, reproducible) imitando cada
camino real, incluida una importación caótica con filas contradictorias, y después
de CADA operación se exige que `diagnosticar()` dé limpio:

  - una sola fila por producto           - ninguna cadena (una referencia no apunta a otro)
  - ningún ciclo                         - toda referencia tiene su fila propia (ref -> ref)
  - ningún producto/referencia inexistente

Si algún camino rompe una invariante, el test imprime la semilla y las últimas
operaciones para reproducirlo.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_grupos_sustitutos_fuzz.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_via_seed

SEMBRAR = """
() => {
  const now = new Date().toISOString();
  for (let i = 0; i < 10; i++) {
    window.SGA_DB.run(
      `INSERT INTO productos (id, nombre, costo, precio_venta, stock_minimo, unidad_medida,
         es_madre, precio_independiente, activo, fecha_alta, fecha_modificacion, sync_status, updated_at)
       VALUES (?, ?, 10, 20, 5, 'unidad', 0, 0, 1, ?, ?, 'synced', ?)`, ['fz-' + i, 'FZ ' + i, now, now, now]);
  }
}
"""

FUZZ = """
(args) => {
  const G = window.SGA_GruposSustitutos;
  const ids = Array.from({ length: 10 }, (_, i) => 'fz-' + i);
  const resultados = [];

  // PRNG con semilla (mulberry32): reproducible.
  const prng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const limpiar = () => window.SGA_DB.run(`DELETE FROM producto_sustitutos WHERE producto_id LIKE 'fz-%'`);

  for (const seed of args.semillas) {
    limpiar();
    const rnd = prng(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const log = [];
    let falla = null, maxFilas = 0, pasosConGrupo = 0;

    for (let n = 0; n < args.pasos && !falla; n++) {
      const a = pick(ids), b = pick(ids);
      const op = Math.floor(rnd() * 9);
      let desc = '';
      try {
        if (op === 0 || op === 1) {            // fila de IMPORTACION (cualquier par, incluso contradictorio)
          desc = `import ${a} -> ${b}`; G.moverMiembro(a, b);
        } else if (op === 2) {                 // editor: "Agregar miembro al grupo"
          desc = `editor.agregar miembro=${b} al grupo de ${a}`;
          if (a === b) { desc += ' (omitida)'; }
          else {
            const hoy = G.referenciaRealDe(b);
            const refA = G.referenciaRealDe(a) || a;
            if (hoy !== refA) {
              if (refA === a) G.aplicarCambioReferencia(a, a);
              G.aplicarCambioReferencia(b, refA);
            }
          }
        } else if (op === 3) {                 // editor: "Asignar producto de referencia" (resuelve la real)
          desc = `editor.setReferencia ${a} -> ${b}`;
          if (a !== b) { const real = G.referenciaRealDe(b); G.aplicarCambioReferencia(a, real || b); }
        } else if (op === 4) {                 // Ordenes: Asociar sustituto
          const opciones = [...new Set([a, b, ...G.miembrosDe(a).map(m => m.id), ...G.miembrosDe(b).map(m => m.id)])];
          const r = pick(opciones);
          desc = `ordenes.asociar [${a},${b}] ref=${r}`;
          if (a !== b) G.agruparConReferencia([a, b], r);
        } else if (op === 5) {                 // reporte: "Editar grupo..." (tildar/destildar + elegir referencia)
          const inv = G.involucradosDe(a);
          const sub = inv.filter(() => rnd() < 0.7);
          if (!sub.length) sub.push(inv[0]);
          const r = pick(sub);
          desc = `reporte.editarGrupo inv=[${inv}] miembros=[${sub}] ref=${r}`;
          G.definirGrupo({ miembros: sub, referenciaId: r, involucrados: inv });
        } else if (op === 6) {                 // reporte: "Aceptar sugerencia"
          desc = `reporte.corregirCadena ${a}`; G.corregirCadena(a);
        } else if (op === 7) {                 // editor: "Quitar del grupo" (solo si NO es referencia)
          desc = `editor.quitarDelGrupo ${a}`;
          const r = G.quitarDelGrupo(a);              // una referencia con miembros se rechaza
          if (!r.ok) desc += ' (bloqueado: es referencia)';
        } else {                               // cambiar la referencia a OTRO miembro (pausa / desactivar)
          const ms = G.miembrosDe(a).map(m => m.id);
          const ref = G.referenciaRealDe(a);
          if (ref && ms.length > 1) {
            const nueva = pick(ms.filter(x => x !== ref));
            const t = rnd();
            if (t < 0.4) { desc = `cambiarReferencia ${ref} -> ${nueva}`; G.migrarReferencia(ref, nueva); }
            else if (t < 0.7) { desc = `desactivar+sacar ${ref} -> ${nueva}`; G.migrarReferencia(ref, nueva, { quitarVieja: true }); }
            else { desc = `eliminar ${ref} (migra a ${nueva} y sale)`; G.migrarReferencia(ref, nueva, { quitarVieja: true }); G.quitarDelGrupo(ref); }
          } else desc = 'migrar (sin grupo)';
        }
      } catch (e) { falla = { desc, error: String(e) }; }
      log.push(desc);
      if (!falla) {
        const d = G.diagnosticar();
        if (!d.ok) falla = { desc, diag: d };
        const filas = window.SGA_DB.query(`SELECT COUNT(*) AS n FROM producto_sustitutos WHERE producto_id LIKE 'fz-%'`)[0].n;
        maxFilas = Math.max(maxFilas, filas);
        if (filas > 1) pasosConGrupo++;
      }
    }
    resultados.push({ seed, falla, ultimas: log.slice(-6), maxFilas, pasosConGrupo });
  }
  return resultados;
}
"""


CONTROL = """
() => {
  const G = window.SGA_GruposSustitutos;
  const run = (sql, p = []) => window.SGA_DB.run(sql, p);
  const ins = (prod, ref) => run(
    `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion) VALUES (?, ?, ?, 1, 'x')`, [prod, ref, ref]);
  const limpiar = () => run(`DELETE FROM producto_sustitutos WHERE producto_id LIKE 'fz-%' OR producto_id = 'fantasma'`);
  const out = {};
  limpiar(); ins('fz-0', 'fz-1'); ins('fz-1', 'fz-1'); ins('fz-0', 'fz-2'); ins('fz-2', 'fz-2');
  out.duplicados = G.diagnosticar().duplicados.map(d => d.producto_id);
  limpiar(); ins('fz-0', 'fz-1'); ins('fz-1', 'fz-0');
  out.ciclos = G.diagnosticar().ciclos.length;
  limpiar(); ins('fz-0', 'fz-1'); ins('fz-1', 'fz-2'); ins('fz-2', 'fz-2');
  out.cadenas = G.diagnosticar().cadenas.map(c => c.producto_id);
  limpiar(); ins('fz-0', 'fantasma'); ins('fz-1', 'fz-1');
  out.inexistentes = G.diagnosticar().inexistentes.length;
  limpiar(); ins('fz-0', 'fz-1');
  out.sinFilaPropia = G.diagnosticar().sinFilaPropia;
  limpiar(); ins('fz-0', 'fz-1'); ins('fz-1', 'fz-1');
  out.sano = G.diagnosticar().ok;
  limpiar();
  return out;
}
"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1300, "height": 900})
        context.route("**/*", block_firebase)
        enable_dev_mode(context)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("dialog", lambda d: d.accept())

        login_via_seed(page, admin_pos=False)
        page.evaluate(SEMBRAR)
        page.evaluate("window.location.hash = 'informes'")   # carga el motor
        page.wait_for_timeout(900)

        print("--- Control: el chequeo detecta cada tipo de problema (y no da falsos positivos) ---")
        c = page.evaluate(CONTROL)
        assert c["duplicados"] == ["fz-0"], c
        assert c["ciclos"] == 1, c
        assert c["cadenas"] == ["fz-0"], c
        assert c["inexistentes"] == 1, c
        assert c["sinFilaPropia"] == ["fz-1"], c
        assert c["sano"] is True, c
        print("OK")

        print("--- Fuzz: operaciones al azar de todos los caminos ---")
        semillas = [1, 2, 3, 4, 5, 6, 7, 8]
        res = page.evaluate(FUZZ, {"semillas": semillas, "pasos": 250})
        malas = [r for r in res if r["falla"]]
        for r in malas:
            print(f"\nSEMILLA {r['seed']} rompio una invariante en: {r['falla']['desc']}")
            print("  detalle:", r["falla"].get("diag") or r["falla"].get("error"))
            print("  ultimas operaciones:", *r["ultimas"], sep="\n    ")
        assert not malas, f"{len(malas)} de {len(semillas)} semillas rompieron invariantes"
        inactivas = [r["seed"] for r in res if r["pasosConGrupo"] < 100]
        assert not inactivas, f"La prueba casi no armo grupos en las semillas {inactivas}: no prueba nada"
        print("Actividad:", [(r["seed"], r["pasosConGrupo"], r["maxFilas"]) for r in res], "(semilla, pasos con grupos, max filas)")
        assert not errors, f"Errores JS: {errors}"
        print(f"OK - {len(semillas)} semillas x 250 operaciones al azar: el chequeo de integridad dio limpio despues de cada una.")
        browser.close()


if __name__ == "__main__":
    main()
