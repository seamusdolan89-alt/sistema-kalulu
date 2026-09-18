"""
tests/e2e/sync_sim.py — Simulador de DOS dispositivos (POS + Admin-POS) contra un
Firestore falso compartido, para probar la sincronizacion de punta a punta sin
red y sin tocar nunca Firebase real.

Por que existe: hasta ahora cada test de sync usaba un Firestore falso que solo
registraba lo que se enviaba (mira un solo lado). Eso no detecta lo que el
usuario sufre en produccion: "lo cargue en una compu y no aparece en la otra".
Aca hay dos paginas reales (cada una con su SQLite/OPFS: sga.db y sga-admin.db)
y un unico store en memoria; lo que una sube, la otra lo baja con el codigo real
de js/sync.js (pushPending/pushToPos, syncNow/syncMonitoringData).

Fidelidad con Firestore real (lo que el codigo de sync.js realmente usa):
  - where(campo, '==' | '>', valor): un documento SIN ese campo no matchea
    (asi el POS no baja docs que el admin subio sin `_pulled:false`).
  - orderBy(campo): excluye los documentos sin ese campo.
  - batch.set(ref, data, {merge:true}) hace merge recursivo de mapas; los arrays
    se reemplazan. Un `undefined` en data TIRA (Firestore real lo rechaza).
  - ref.update() sobre un documento inexistente tira (NOT_FOUND).

Uso:

    from sync_sim import Simulador
    with Simulador() as sim:
        sim.pos.run("INSERT INTO ...")
        sim.pos.push();  sim.admin.pull()
        sim.admin.q("SELECT ...")
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from playwright.sync_api import sync_playwright
from helpers import block_firebase, enable_dev_mode, login_direct, login_via_seed

INSTALAR_FIRESTORE_FALSO_JS = """
() => {
  const call = async (op, args) => {
    const r = JSON.parse(await window.__fsOp(JSON.stringify({ op, args })));
    if (r && r.__error) throw new Error(r.__error);
    return r;
  };
  const sinUndefined = (v, ruta) => {
    if (v === undefined) throw new Error('Unsupported field value: undefined (campo ' + ruta + ')');
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) sinUndefined(v[k], ruta + '.' + k);
    }
  };
  const mkRef = (col, id) => ({
    id, path: col + '/' + id,
    update: (fields) => call('update', { col, id, fields }),
  });
  const mkDoc = (col, d) => ({
    id: d.id, ref: mkRef(col, d.id), exists: true,
    data: () => JSON.parse(JSON.stringify(d.data)),
  });
  const mkQuery = (col, spec) => ({
    where:      (f, o, v) => mkQuery(col, { ...spec, wheres: [...spec.wheres, [f, o, v]] }),
    orderBy:    (f, dir)  => mkQuery(col, { ...spec, order: [f, dir || 'asc'] }),
    limit:      (n)       => mkQuery(col, { ...spec, lim: n }),
    startAfter: (doc)     => mkQuery(col, { ...spec, after: doc.id }),
    doc:        (id)      => mkRef(col, id),
    get: async () => {
      const filas = await call('query', { col, spec });
      const docs = filas.map(d => mkDoc(col, d));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  window.__fake = {
    collection: (col) => mkQuery(col, { wheres: [] }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => {
          sinUndefined(data, ref.path);
          ops.push({ t: 'set', path: ref.path, data, merge: !!(opts && opts.merge) });
        },
        delete: (ref) => { ops.push({ t: 'delete', path: ref.path }); },
        commit: () => call('commit', { ops }),
      };
    },
  };
  window.SGA_Sync.__testForceInitialized(window.__fake);
}
"""


def _mezclar(dst, src):
    """merge recursivo de mapas, como set(..., {merge:true}); arrays se reemplazan."""
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _mezclar(dst[k], v)
        else:
            dst[k] = json.loads(json.dumps(v))


class FirestoreFalso:
    def __init__(self):
        self.cols = {}      # coleccion -> { id: data }
        self.escrituras = []  # (path, tenia__pulled, valor__pulled) por cada set

    def doc(self, col, id_):
        return self.cols.get(col, {}).get(id_)

    def contar(self, col):
        return len(self.cols.get(col, {}))

    def manejar(self, payload):
        try:
            p = json.loads(payload)
            op, a = p["op"], p["args"]
            if op == "query":
                return json.dumps(self._query(a["col"], a["spec"]))
            if op == "update":
                d = self.cols.get(a["col"], {}).get(a["id"])
                if d is None:
                    return json.dumps({"__error": f"NOT_FOUND: {a['col']}/{a['id']}"})
                _mezclar(d, a["fields"])
                return json.dumps({})
            if op == "commit":
                for o in a["ops"]:
                    col, id_ = o["path"].split("/", 1)
                    if o["t"] == "delete":
                        self.cols.get(col, {}).pop(id_, None)
                        continue
                    tabla = self.cols.setdefault(col, {})
                    self.escrituras.append((o["path"], "_pulled" in o["data"], o["data"].get("_pulled")))
                    if o["merge"] and id_ in tabla:
                        _mezclar(tabla[id_], o["data"])
                    else:
                        tabla[id_] = json.loads(json.dumps(o["data"]))
                return json.dumps({})
            return json.dumps({"__error": f"op desconocida {op}"})
        except Exception as e:  # noqa: BLE001
            return json.dumps({"__error": f"{type(e).__name__}: {e}"})

    def _query(self, col, spec):
        docs = [{"id": i, "data": d} for i, d in sorted(self.cols.get(col, {}).items())]
        for campo, oper, valor in spec.get("wheres", []):
            def ok(d, campo=campo, oper=oper, valor=valor):
                if campo not in d["data"]:
                    return False
                v = d["data"][campo]
                return v == valor if oper == "==" else v > valor
            docs = [d for d in docs if ok(d)]
        if spec.get("order"):
            campo, direccion = spec["order"]
            docs = [d for d in docs if campo in d["data"]]
            # Firestore ordena null antes que cualquier otro valor
            docs.sort(key=lambda d: (d["data"][campo] is not None, d["data"][campo] if d["data"][campo] is not None else ""),
                      reverse=(direccion == "desc"))
        if spec.get("after"):
            ids = [d["id"] for d in docs]
            if spec["after"] in ids:
                docs = docs[ids.index(spec["after"]) + 1:]
        if spec.get("lim"):
            docs = docs[: spec["lim"]]
        return docs


class Dispositivo:
    def __init__(self, page, es_admin, nombre):
        self.page = page
        self.es_admin = es_admin
        self.nombre = nombre
        self.errores = []
        self.consola = []   # (tipo, texto) de console.warn / console.error
        self._consola_leida = 0
        page.on("pageerror", lambda exc: self.errores.append(str(exc)))
        page.on("console", lambda m: self.consola.append((m.type, m.text))
                if m.type in ("warning", "error") else None)

    def consola_nueva(self):
        """Advertencias/errores de consola desde la ultima vez que se pidio."""
        nuevas = self.consola[self._consola_leida:]
        self._consola_leida = len(self.consola)
        return nuevas

    def q(self, sql, params=None):
        return self.page.evaluate("([s, p]) => window.SGA_DB.query(s, p)", [sql, params or []])

    def run(self, sql, params=None):
        self.page.evaluate("([s, p]) => { window.SGA_DB.run(s, p); }", [sql, params or []])

    def js(self, fn, arg=None):
        return self.page.evaluate(fn, arg)

    # Subir lo pendiente, como lo hace cada superficie en produccion
    def push(self):
        if self.es_admin:
            return self.page.evaluate("() => window.SGA_Sync.pushToPos()")
        return self.page.evaluate("() => window.SGA_Sync.pushPending()")

    # Bajar lo del otro (en el POS syncNow() baja y despues sube lo pendiente)
    def pull(self):
        if self.es_admin:
            return self.page.evaluate("() => window.SGA_Sync.syncMonitoringData()")
        return self.page.evaluate("() => window.SGA_Sync.syncNow()")

    def sync_inicial(self):
        """Lo que hace un dispositivo nuevo al entrar: initialSyncFromFirestore + el historial de fondo."""
        self.page.evaluate("""async () => {
          await window.SGA_Sync.initialSyncFromFirestore();
          const h = window.SGA_Sync.getHistoricalSyncPromise();
          if (h) await h;
        }""")

    def sincronizar(self):
        """El ciclo automatico completo de cada superficie (syncNow)."""
        return self.page.evaluate("() => window.SGA_Sync.syncNow()")


class Simulador:
    def __init__(self, ancho=1440, alto=900):
        self.ancho, self.alto = ancho, alto
        self.store = FirestoreFalso()

    def __enter__(self):
        self._pw = sync_playwright().start()
        self.browser = self._pw.chromium.launch(headless=True)
        self.ctx = self.browser.new_context(viewport={"width": self.ancho, "height": self.alto})
        self.ctx.route("**/*", block_firebase)
        enable_dev_mode(self.ctx)
        self.ctx.expose_function("__fsOp", self.store.manejar)

        p_admin = self.ctx.new_page()
        login_via_seed(p_admin, admin_pos=True, wait_target="productos")
        p_pos = self.ctx.new_page()
        login_via_seed(p_pos, admin_pos=False)

        self.admin = Dispositivo(p_admin, True, "Admin-POS")
        self.pos = Dispositivo(p_pos, False, "POS")
        for d in (self.admin, self.pos):
            d.page.evaluate(INSTALAR_FIRESTORE_FALSO_JS)
        return self

    def nuevo_dispositivo(self, es_admin=True, nombre="Dispositivo nuevo"):
        """Un dispositivo con la base VACIA (contexto de navegador nuevo = OPFS nuevo),
        conectado al mismo Firestore falso. Solo tiene el usuario admin por defecto."""
        ctx = self.browser.new_context(viewport={"width": self.ancho, "height": self.alto})
        ctx.route("**/*", block_firebase)
        enable_dev_mode(ctx)
        ctx.expose_function("__fsOp", self.store.manejar)
        page = ctx.new_page()
        login_direct(page, admin_pos=es_admin, wait_target="productos" if es_admin else None)
        d = Dispositivo(page, es_admin, nombre)
        page.evaluate(INSTALAR_FIRESTORE_FALSO_JS)
        return d

    def __exit__(self, *exc):
        try:
            self.browser.close()
        finally:
            self._pw.stop()
        return False
