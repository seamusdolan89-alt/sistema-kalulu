"""
tests/e2e/test_sustitutos_solo_por_motor.py — Guarda estática: TODA escritura en la tabla
`producto_sustitutos` pasa por el motor (js/modules/grupos_sustitutos.js).

No usa navegador: recorre el código y falla si aparece un INSERT / UPDATE / DELETE sobre
`producto_sustitutos` fuera de los archivos permitidos. Es la contracara de
tests/e2e/test_grupos_sustitutos_fuzz.py: el fuzz prueba que las operaciones del motor no
rompen las invariantes (una fila por producto, sin cadenas ni ciclos, referencia con fila
propia, nada inexistente); este test garantiza que NADIE escribe la tabla sin pasar por ellas.
(Mismo patron que tests/e2e/test_stock_ledger.py para la tabla `stock`.)

Archivos permitidos, a propósito:
  - js/modules/grupos_sustitutos.js : el motor.
  - js/db.js    : crea la tabla y autocompleta la fila propia de una referencia al arrancar.
  - js/sync.js  : aplica el documento de un producto que llega de la otra computadora.

Si este test falla porque necesitás una operación nueva sobre grupos de sustitutos:
agregala como función en grupos_sustitutos.js, usala desde tu pantalla, y sumala a la lista de
operaciones del fuzz. NO la excluyas de acá.

Correr (no necesita servidor):

    python tests/e2e/test_sustitutos_solo_por_motor.py
"""
import os
import re
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

PERMITIDOS = {
    "js/modules/grupos_sustitutos.js": None,   # el motor: sin limite
    "js/db.js": 1,                             # INSERT OR IGNORE de la fila propia al arrancar
    "js/sync.js": 2,                           # DELETE + INSERT OR REPLACE al aplicar un producto
}

ESCRITURA = re.compile(
    r"(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+producto_sustitutos\b", re.IGNORECASE)

SALTAR_DIRS = {".git", "node_modules", "tests", ".claude", "capturas", "SPEC"}


def main():
    fallas = []
    contadas = {}
    for base, dirs, files in os.walk(RAIZ):
        dirs[:] = [d for d in dirs if d not in SALTAR_DIRS]
        for f in files:
            if not f.endswith((".js", ".html", ".mjs")):
                continue
            ruta = os.path.join(base, f)
            rel = os.path.relpath(ruta, RAIZ).replace("\\", "/")
            try:
                texto = open(ruta, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            hallazgos = ESCRITURA.findall(texto)
            if not hallazgos:
                continue
            if rel in PERMITIDOS:
                contadas[rel] = len(hallazgos)
                limite = PERMITIDOS[rel]
                if limite is not None and len(hallazgos) > limite:
                    fallas.append(f"{rel}: {len(hallazgos)} escrituras (maximo permitido {limite}) — "
                                  "una escritura nueva va en grupos_sustitutos.js")
            else:
                fallas.append(f"{rel}: escribe `producto_sustitutos` a mano ({len(hallazgos)} sentencia/s). "
                              "Usá una función de GruposSustitutos (js/modules/grupos_sustitutos.js).")

    assert contadas.get("js/modules/grupos_sustitutos.js"), "No encontre las escrituras del motor: ¿cambio la ruta?"
    if fallas:
        print("FALLA: hay escrituras de grupos de sustitutos fuera del motor:")
        for f in fallas:
            print("  -", f)
        sys.exit(1)
    print("OK - producto_sustitutos solo se escribe desde el motor (+ db.js y sync.js, permitidos):", contadas)


if __name__ == "__main__":
    main()
