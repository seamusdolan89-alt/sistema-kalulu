"""
tests/e2e/test_sync_convergencia_tablas.py — Auditoria de sincronizacion, TABLA POR
TABLA y en LOS DOS SENTIDOS, con dispositivos reales (POS y Admin-POS) contra un
Firestore falso compartido (ver sync_sim.py).

Criterio (del dueno del sistema, 18/9/2026): "sincroniza TODO salvo alguna
excepcion". Nada de ir sumando tablas a una lista: las tablas se descubren del
esquema REAL de la base (sqlite_master), y toda tabla tiene que viajar en ambos
sentidos con TODAS sus columnas. Lo que no cumple tiene que estar escrito abajo,
en UNA de dos listas, con su motivo:

  EXCEPCIONES_DISENO  decision consciente, justificada (ej. solo se edita desde una
                      pantalla exclusiva de Admin-POS)
  DEUDA               falla hoy y tiene plan; la suite la muestra SIEMPRE, y falla si
                      una entrada ya se resolvio (asi la lista solo puede encogerse)

Fases, para cada tabla real y cada sentido:
  1. ALTA: fila con TODAS las columnas pobladas con valores distintos del default (y
     dos filas por cada hijo embebido). Se sube, se baja y se compara columna por
     columna: ausente = NO_LLEGA, columna distinta = COLUMNAS.
  2. ACTUALIZACION: se cambia una columna en el origen y se re-sube; el destino tiene
     que reflejarlo (detecta INSERT OR IGNORE y similares).
  3. HIJOS: para los hijos que la app realmente borra (lista verificada contra los
     DELETE del codigo), borrar uno y re-subir el padre no puede dejarlo "vivo" del
     otro lado.
  4. BORRADO DE PADRE: las tablas con marca de borrado (registrarEliminacion) tienen
     que borrarse tambien del otro lado.
  5. DISPOSITIVO NUEVO: un Admin-POS con la base vacia hace el sync inicial y tiene
     que terminar con TODO lo que existe, sin resucitar lo borrado.

Correr (server ya levantado en :8765, ver README.md):

    python tests/e2e/test_sync_convergencia_tablas.py             # estricto (CI)
    python tests/e2e/test_sync_convergencia_tablas.py --informe   # solo informe, sin fallar
"""
import os
import re
import sys
import time

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# padre -> [(hijo, columna que lo enlaza con el padre)]. Se VALIDA contra el
# codigo de sync.js (validar_mapa_hijos) para que no dependa de una lectura mia.
HIJOS_EMBEBIDOS = {
    "productos":         [("codigos_barras", "producto_id"), ("producto_sustitutos", "producto_id")],
    "ventas":            [("venta_items", "venta_id"), ("venta_pagos", "venta_id"), ("venta_promociones", "venta_id")],
    "compras":           [("compra_items", "compra_id")],
    "devoluciones":      [("devolucion_items", "devolucion_id")],
    "remitos":           [("remito_items", "remito_id")],
    "ordenes_compra":    [("orden_compra_items", "orden_id")],
    "pagos_proveedores": [("pagos_proveedores_metodos", "pago_id"), ("imputaciones_pagos", "pago_id")],
    "promociones":       [("promocion_items", "promocion_id")],
}

# Hijos que la app REALMENTE borra (DELETE FROM <hijo> en js/, verificado leyendo
# el codigo el 18/9/2026). imputaciones_pagos, pagos_proveedores_metodos,
# devolucion_items y venta_promociones nunca se borran: son de solo-agregar.
HIJOS_CON_BORRADO_REAL = {
    ("ventas", "venta_items"), ("ventas", "venta_pagos"),          # pos.js:177 (editar venta)
    ("compras", "compra_items"),                                   # compras_v2.js (editar compra)
    ("remitos", "remito_items"),                                   # compras_v2.js (editar remito)
    ("ordenes_compra", "orden_compra_items"),                      # ordenes.js
    ("productos", "codigos_barras"), ("productos", "producto_sustitutos"),  # editor-producto.js
    ("promociones", "promocion_items"),                            # promociones.js
}

# Tablas cuyo borrado el codigo realmente registra con registrarEliminacion().
BORRADO_CON_MARCA = ["productos", "promociones", "ordenes_compra", "cuenta_corriente", "ingresos_caja",
                     "pedidos_abiertos", "compras_pausadas"]

# --- Excepciones ----------------------------------------------------------------
# clave: (tabla, sentido). Valor: motivo.
EXCEPCIONES_DISENO = {
    ("medios_cobro", "POS -> Admin"): "solo se escribe desde Configuracion, ruta exclusiva de Admin-POS "
                                      "(app.js ROUTE_ADMIN_POS_ONLY) y posPush:false en sync.js",
    ("sucursales", "POS -> Admin"):   "idem medios_cobro",
}
# Columnas que NO viajan a proposito: (tabla, columna) -> motivo.
EXCEPCIONES_COLUMNA = {
    ("usuarios", "firebase_uid"): "vestigial: el login es 100% local (comentado en sync.js applyUsuarioFull)",
}
DEUDA = {
    # (Caja resuelta el 18/9/2026: la caja esperada se suma desde las filas y el POS ya recibe
    #  sesiones_caja/egresos_caja/ingresos_caja/ventas/consumo_interno del admin, con guardas
    #  para no reabrir una caja cerrada ni pisar el recuento en curso — ver test_sync_caja_admin_pos.py)
    # Decisiones que son del dueno:
    ("historial_stock", "POS -> Admin"): "sin sync_status/updated_at ni fuente; se reemplaza por el ledger de stock (informe 'dias sin stock' incompleto en Admin)",
    ("historial_stock", "Admin -> POS"): "idem",
    # (Borradores resueltos el 18/9/2026: pedidos_abiertos y compras_pausadas sincronizan y su borrado
    #  viaja con marca — ver test_sync_borradores.py)
}

SENTIDOS = [("POS -> Admin", "pos", "admin", "p2a"), ("Admin -> POS", "admin", "pos", "a2p")]

GENERAR_FILA_JS = """
([tabla, sufijo, overrides]) => {
  const q = (s, p) => window.SGA_DB.query(s, p || []);
  const cols = q(`PRAGMA table_info(${tabla})`);
  const sql = (q(`SELECT sql FROM sqlite_master WHERE name=?`, [tabla])[0] || {}).sql || '';
  const checks = {};
  for (const m of sql.matchAll(/CHECK\\s*\\(\\s*(\\w+)\\s+IN\\s*\\(([^)]*)\\)\\s*\\)/gi)) {
    checks[m[1]] = m[2].split(',').map(x => x.trim().replace(/^'|'$/g, ''));
  }
  const p2a = sufijo.startsWith('p2a');
  const fila = {};
  for (const c of cols) {
    const n = c.name, t = (c.type || '').toUpperCase();
    const d = c.dflt_value == null ? null : String(c.dflt_value).replace(/^'|'$/g, '');
    const boolish = /^(activo|activa|hereda_|es_|pausado|habilitad|visible|tiene_|permite_|puede_|can_)/.test(n);
    let v;
    if (n === 'sync_status') v = 'pending';
    else if (checks[n]) {
      v = checks[n].find(x => x !== d);
      if (v === undefined) v = checks[n][0];
      if (t.includes('INT') || t.includes('REAL')) v = Number(v);
    }
    else if (c.pk > 0 && /fecha/.test(n)) v = p2a ? '2031-01-01' : '2031-02-02';
    else if (t.includes('INT')) v = (d === '1') ? (boolish ? 0 : 2) : 1;
    else if (t.includes('REAL')) v = p2a ? 12.5 : 13.5;
    else if (/fecha|_at$|periodo|registrado_en|created/.test(n)) v = p2a ? '2026-09-18T12:00:00.000Z' : '2026-09-19T12:00:00.000Z';
    else v = `${tabla}.${n}.${sufijo}`;
    fila[n] = v;
  }
  Object.assign(fila, overrides || {});
  const nombres = Object.keys(fila);
  window.SGA_DB.run(
    `INSERT INTO ${tabla} (${nombres.join(',')}) VALUES (${nombres.map(() => '?').join(',')})`,
    nombres.map(k => fila[k]));
  const pk = {};
  for (const c of cols) if (c.pk > 0) pk[c.name] = fila[c.name];
  const donde = Object.keys(pk).length ? Object.keys(pk).map(k => `${k}=?`).join(' AND ') : '1=0';
  const existe = Object.keys(pk).length
    ? q(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${donde}`, Object.values(pk))[0].n : -1;
  const err = existe === 0 && window.SGA_DB.getLastError ? window.SGA_DB.getLastError() : null;
  return { fila, pk, existe, checks: Object.keys(checks), err: err ? (err.message || String(err)) : null };
}
"""


def validar_mapa_hijos():
    """Cada (padre, hijo, columna) declarado arriba tiene que estar en el denormalize
    del padre: 'FROM hijo ... <columna> = ?'. Si no, el mapa esta mal y la auditoria mentiria."""
    src = open(os.path.join(REPO_ROOT, "js", "sync.js"), encoding="utf-8").read()
    fuente_a_fn = dict(re.findall(r"table:\s*'(\w+)'[^}]*?denormalize:\s*(denormalize\w+)", src))
    errores = []
    for padre, hijos in HIJOS_EMBEBIDOS.items():
        fn = fuente_a_fn.get(padre)
        if not fn:
            errores.append(f"{padre}: no tiene denormalize en SYNC_SOURCES")
            continue
        ini = src.index(f"function {fn}(")
        cuerpo = src[ini:src.index("\n  }\n", ini)]
        for hijo, col in hijos:
            if not re.search(rf"FROM\s+{hijo}\b", cuerpo) or not re.search(rf"\b{col}\s*=\s*\?", cuerpo):
                errores.append(f"{padre}: {fn}() no consulta '{hijo}' por '{col}'")
    return errores


def iguales(a, b):
    if a is None and b is None:
        return True
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(float(a) - float(b)) < 1e-9
    return a == b


def comparar_fila(fila_a, fila_b, tabla=None, ignorar=("sync_status",)):
    difs = []
    for col, va in fila_a.items():
        if col in ignorar or (tabla, col) in EXCEPCIONES_COLUMNA:
            continue
        if col not in fila_b:
            difs.append(f"{col}: falta en el otro lado")
        elif not iguales(va, fila_b[col]):
            difs.append(f"{col}: {va!r} -> {fila_b[col]!r}")
    return difs


def donde_pk(pk):
    return " AND ".join(f"{k}=?" for k in pk), list(pk.values())


def intercambiar(A, B):
    time.sleep(0.02)
    A.push()
    time.sleep(0.02)
    B.pull()


def probar_tabla(sim, tabla, origen, destino, sufijo):
    """Devuelve (estado, detalle, pk). estado: OK | SIN_FILA | NO_LLEGA | COLUMNAS | ACTUALIZACION | HIJOS"""
    A, B = getattr(sim, origen), getattr(sim, destino)
    hijos = HIJOS_EMBEBIDOS.get(tabla, [])

    gen = A.js(GENERAR_FILA_JS, [tabla, sufijo, {}])
    if gen["existe"] != 1:
        return "SIN_FILA", f"no se pudo insertar la fila de prueba en {A.nombre}: {gen.get('err')}", None
    pk = gen["pk"]
    w, params = donde_pk(pk)
    pk_val = list(pk.values())[0]
    hijos_gen = []
    for hijo, enlace in hijos:
        for k in ("a", "b"):
            g = A.js(GENERAR_FILA_JS, [hijo, f"{sufijo}{k}", {enlace: pk_val}])
            hijos_gen.append((hijo, enlace, g))

    A.consola_nueva(); B.consola_nueva()
    intercambiar(A, B)
    notas = [f"[{d.nombre}] {t}: {x[:160]}" for d in (A, B) for t, x in d.consola_nueva()]

    # 1) ALTA
    en_b = B.q(f"SELECT * FROM {tabla} WHERE {w}", params)
    if not en_b:
        return "NO_LLEGA", " | ".join(notas) or "el documento nunca aparecio del otro lado", pk
    problemas = comparar_fila(gen["fila"], en_b[0], tabla)
    for hijo, enlace, g in hijos_gen:
        if g["existe"] in (1, -1):
            if g["pk"]:
                w2, p2 = donde_pk(g["pk"])
                hb = B.q(f"SELECT * FROM {hijo} WHERE {w2}", p2)
            else:
                hb = B.q(f"SELECT * FROM {hijo} WHERE {enlace}=?", [pk_val])
            if not hb:
                problemas.append(f"hijo {hijo}: NO LLEGA")
            else:
                problemas += [f"hijo {hijo}.{d}" for d in comparar_fila(g["fila"], hb[0], hijo)]
    if problemas:
        return "COLUMNAS", "; ".join(problemas) + ((" | " + " | ".join(notas)) if notas else ""), pk

    # 2) ACTUALIZACION: cambiar UNA columna en el origen y re-subir
    cambiable = None
    for col, v in gen["fila"].items():
        if col in pk or col in ("sync_status", "updated_at") or col in gen["checks"] or (tabla, col) in EXCEPCIONES_COLUMNA:
            continue
        if isinstance(v, str) and not v.startswith("20") and not col.endswith("_id"):
            cambiable = (col, "ACTUALIZADO"); break
        if isinstance(v, (int, float)) and cambiable is None:
            cambiable = (col, v + 5)
    if cambiable:
        col, nuevo = cambiable
        A.run(f"UPDATE {tabla} SET {col}=?, sync_status='pending', updated_at=? WHERE {w}",
              [nuevo, "2026-09-20T00:00:00.000Z"] + params)
        intercambiar(A, B)
        despues = B.q(f"SELECT {col} FROM {tabla} WHERE {w}", params)
        if not despues or not iguales(despues[0][col], nuevo):
            return "ACTUALIZACION", (f"un cambio en {col} hecho en {A.nombre} NO se refleja en {B.nombre} "
                                     f"(quedo {despues[0][col] if despues else 'sin fila'!r}, esperado {nuevo!r})"), pk

    # 3) HIJOS: borrar uno de los que la app realmente borra
    for hijo, enlace, g in hijos_gen[1::2]:
        if (tabla, hijo) not in HIJOS_CON_BORRADO_REAL or not g["pk"]:
            continue
        w2, p2 = donde_pk(g["pk"])
        A.run(f"DELETE FROM {hijo} WHERE {w2}", p2)
        A.run(f"UPDATE {tabla} SET sync_status='pending', updated_at=? WHERE {w}", ["2026-09-21T00:00:00.000Z"] + params)
        intercambiar(A, B)
        if B.q(f"SELECT COUNT(*) AS n FROM {hijo} WHERE {w2}", p2)[0]["n"]:
            return "HIJOS", f"un {hijo} borrado en {A.nombre} SIGUE existiendo en {B.nombre} (la linea resucita / se duplica)", pk
    return "OK", "", pk


def probar_borrado_padre(sim, tabla, origen, destino):
    A, B = getattr(sim, origen), getattr(sim, destino)
    gen = A.js(GENERAR_FILA_JS, [tabla, "del" + origen[0], {}])
    if gen["existe"] != 1:
        return "SIN_FILA", f"no se pudo insertar: {gen.get('err')}", None
    pk = gen["pk"]
    w, params = donde_pk(pk)
    intercambiar(A, B)
    if not B.q(f"SELECT 1 FROM {tabla} WHERE {w}", params):
        return "OK", "el alta no llega (ya reportado en la fase 1)", None
    rid = list(pk.values())[0]
    A.js("([t, id]) => { window.SGA_DB.aplicarEliminacion(t, id); window.SGA_DB.registrarEliminacion(t, id); }", [tabla, rid])
    intercambiar(A, B)
    if B.q(f"SELECT 1 FROM {tabla} WHERE {w}", params):
        return "BORRADO", f"borrado en {A.nombre} (con marca de eliminacion) pero SIGUE existiendo en {B.nombre}", pk
    return "OK", "", pk


def main():
    informe = "--informe" in sys.argv
    errores_mapa = validar_mapa_hijos()
    assert not errores_mapa, "El mapa de hijos embebidos no coincide con sync.js:\n  " + "\n  ".join(errores_mapa)

    with Simulador() as sim:
        tablas = [r["name"] for r in sim.admin.q(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        embebidas = {h for hs in HIJOS_EMBEBIDOS.values() for h, _ in hs}
        raices = [t for t in tablas if t not in embebidas]
        print(f"Tablas reales: {len(tablas)} | raices: {len(raices)} | hijos embebidos (se prueban con su padre): {len(embebidas)}")
        print("Mapa de hijos embebidos validado contra js/sync.js.\n")

        res = {}          # (tabla, sentido) -> (estado, detalle)
        creadas = []      # (tabla, pk) que llegaron OK, para la fase de dispositivo nuevo
        borradas = []     # (tabla, pk) borradas con marca
        for nombre, origen, destino, suf in SENTIDOS:
            for tabla in raices:
                try:
                    estado, detalle, pk = probar_tabla(sim, tabla, origen, destino, suf)
                except Exception as e:  # noqa: BLE001
                    estado, detalle, pk = "ERROR", f"{type(e).__name__}: {str(e)[:200]}", None
                res[(tabla, nombre)] = (estado, detalle)
                if estado == "OK" and pk:
                    creadas.append((tabla, pk))
            for tabla in BORRADO_CON_MARCA:
                if res.get((tabla, nombre), ("", ""))[0] != "OK":
                    continue  # si el alta ni llega, el borrado es consecuencia
                try:
                    estado, detalle, pk = probar_borrado_padre(sim, tabla, origen, destino)
                except Exception as e:  # noqa: BLE001
                    estado, detalle, pk = "ERROR", f"{type(e).__name__}: {str(e)[:200]}", None
                if estado != "OK":
                    res[(tabla, nombre)] = (estado, detalle)
                elif pk:
                    borradas.append((tabla, pk))

        # 5) DISPOSITIVO NUEVO (Admin-POS con la base vacia)
        nuevo = sim.nuevo_dispositivo(es_admin=True, nombre="Admin-POS nuevo")
        nuevo.sync_inicial()
        faltan = {}
        for tabla, pk in creadas:
            w, params = donde_pk(pk)
            if not nuevo.q(f"SELECT 1 FROM {tabla} WHERE {w}", params):
                faltan.setdefault(tabla, 0)
                faltan[tabla] += 1
        resucitan = {}
        for tabla, pk in borradas:
            w, params = donde_pk(pk)
            if nuevo.q(f"SELECT 1 FROM {tabla} WHERE {w}", params):
                resucitan[tabla] = resucitan.get(tabla, 0) + 1
        for tabla, n in faltan.items():
            res[(tabla, "Dispositivo nuevo")] = ("NUEVO_FALTA", f"{n} fila(s) que existen en Firestore no llegaron con el sync inicial")
        for tabla, n in resucitan.items():
            res[(tabla, "Dispositivo nuevo")] = ("NUEVO_RESUCITA", f"{n} fila(s) BORRADA(S) reaparecen con el sync inicial")
        for tabla in raices:
            res.setdefault((tabla, "Dispositivo nuevo"), ("OK", ""))

        # --- informe -------------------------------------------------------------
        print(f"{'':2} {'sentido':17} {'tabla':28} estado")
        print("-" * 110)
        fallas, toleradas, obsoletas = [], [], []
        for (tabla, sentido), (estado, detalle) in sorted(res.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            clave = (tabla, sentido)
            motivo = EXCEPCIONES_DISENO.get(clave) or DEUDA.get(clave)
            tipo = "DISENO" if clave in EXCEPCIONES_DISENO else ("DEUDA" if clave in DEUDA else None)
            if estado == "OK":
                if tipo:
                    obsoletas.append((clave, tipo))
                    print(f"?? {sentido:17} {tabla:28} OK  <-- ya converge: sacar de {tipo}")
                continue
            marca = "~~" if tipo else "!!"
            print(f"{marca} {sentido:17} {tabla:28} {estado}" + (f"  — {detalle}" if detalle else "") +
                  (f"\n{'':22}[{tipo}] {motivo}" if tipo else ""))
            (toleradas if tipo else fallas).append((clave, estado))

        total = len(res)
        ok = sum(1 for v in res.values() if v[0] == "OK")
        print(f"\n{ok}/{total} combinaciones tabla x sentido convergen | "
              f"excepciones de diseno: {len([1 for c, _ in toleradas if c in EXCEPCIONES_DISENO])} | "
              f"DEUDA conocida: {len([1 for c, _ in toleradas if c in DEUDA])} | "
              f"FALLAS SIN JUSTIFICAR: {len(fallas)}")
        errs_js = sim.admin.errores + sim.pos.errores + nuevo.errores
        if errs_js:
            print("Errores JS no capturados:", errs_js[:5])
        if not informe:
            assert not fallas, f"{len(fallas)} combinaciones no convergen y no estan justificadas: {fallas}"
            assert not obsoletas, f"Excepciones que ya no hacen falta (sacarlas de la lista): {obsoletas}"
            assert not errs_js, f"Errores JS: {errs_js}"
            print("OK - todo converge en ambos sentidos, salvo las excepciones y la deuda listadas.")


if __name__ == "__main__":
    main()
