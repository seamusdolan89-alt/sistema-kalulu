"""
tests/e2e/test_precios_historial_origen_estatico.py

Guarda estatica del historial de cambios de costo/precio (precios_historial, 9/11/2026).

El registro lo escribe un TRIGGER de productos (js/db.js), asi que NINGUN camino puede dejar de
registrar un cambio. Lo que si puede pasar es que un camino NUEVO escriba costo/precio sin decir
de donde viene (db.conOrigenCambio) y el cambio quede anotado como origen 'otro': registrado,
pero sin contexto util. Este test falla si algun archivo (fuera de db.js) hace un
`UPDATE productos` que toca costo / costo_paquete / precio_venta sin estar envuelto en
`conOrigenCambio(...)`.

Un SET armado dinamicamente (`UPDATE productos SET ${...}`) se considera que PUEDE tocar costo o
precio, salvo que figure en DINAMICOS_SIN_PRECIO con el motivo.

No usa Playwright ni servidor: analisis estatico, corre en segundos.

    python tests/e2e/test_precios_historial_origen_estatico.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
JS = os.path.join(ROOT, "js")

# (archivo relativo a js/, fragmento unico del SQL) -> por que no toca costo/precio
DINAMICOS_SIN_PRECIO = {
    ("modules/ordenes.js", "campos.join"): "solo cambia proveedor_principal_id / proveedor_alternativo_id",
}

TOCA_PRECIO = re.compile(r"\b(costo|costo_paquete|precio_venta)\s*=")
UPDATE = re.compile(r"UPDATE\s+productos\b", re.I)


def archivos_js():
    for base, _dirs, files in os.walk(JS):
        for f in files:
            if f.endswith(".js"):
                yield os.path.join(base, f)


def main():
    infractores = []
    for path in archivos_js():
        rel = os.path.relpath(path, JS).replace("\\", "/")
        if rel == "db.js":
            continue    # db.js es el que define el trigger, y su UPDATE de etiquetas/es_madre no toca precio
        src = open(path, encoding="utf-8").read()
        for m in UPDATE.finditer(src):
            # Sentencia: hasta el cierre de la cadena/plantilla (backtick o comilla) -- 700 chars alcanzan
            sentencia = src[m.start(): m.start() + 700]
            fin = re.search(r"[`\"']\s*[,)]", sentencia)
            sql = sentencia[: fin.start()] if fin else sentencia
            dinamico = "${" in sql
            if dinamico:
                motivo = next((v for (f, frag), v in DINAMICOS_SIN_PRECIO.items()
                               if f == rel and frag in src[m.start(): m.start() + 400]), None)
                if motivo:
                    continue
            elif not TOCA_PRECIO.search(sql):
                continue
            antes = src[max(0, m.start() - 600): m.start()]
            if "conOrigenCambio" not in antes:
                linea = src.count("\n", 0, m.start()) + 1
                infractores.append(f"{rel}:{linea}  {re.sub(r'\\s+', ' ', sql)[:90]}")

    assert not infractores, (
        "UPDATE productos de costo/precio sin envolver en conOrigenCambio (el cambio quedaría como origen 'otro'):\n  "
        + "\n  ".join(infractores)
        + "\nEnvolvelo con window.SGA_DB.conOrigenCambio({ origen: '...', detalle: '...' }, () => ...) "
          "o, si el SET dinámico no toca costo/precio, sumalo a DINAMICOS_SIN_PRECIO con el motivo."
    )
    print("OK - test_precios_historial_origen_estatico: todo UPDATE de costo/precio declara su origen")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("FALLA:", e)
        sys.exit(1)
