"""
tests/check_sync_tablas.py — Auditoría estática: toda tabla de js/db.js que
tiene columna `sync_status` (la señal de que se diseñó para sincronizar)
tiene que estar registrada en js/sync.js — como fuente propia en la lista
principal, o embebida como sub-documento dentro del denormalize() de su
tabla padre.

Por qué existe: ya pasó al menos 4 veces que una tabla nueva se creó con
sync_status/updated_at pero nunca se agregó a sync.js, así que sus datos
nunca viajaban entre el POS del local y Admin-POS — el síntoma lo veía el
usuario semanas después ("cargué esto acá y no aparece en la otra
máquina"). Ver memoria del proyecto / commits:
  - fix(sync): categorías nunca viajaba en ninguna dirección
  - fix(sync): los remitos nunca viajaron entre máquinas
  - fix(sync): cuatro tablas más que nunca viajaron entre máquinas
  - fix(sync): los permisos de usuario no viajaban, y suman config y Flujo

No usa Playwright ni servidor — es análisis estático de los dos archivos
fuente, así que corre en segundos. Se puede correr suelto o como parte de
la suite de CI.

Correr:

    python tests/check_sync_tablas.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_JS = os.path.join(ROOT, "js", "db.js")
SYNC_JS = os.path.join(ROOT, "js", "sync.js")

# Tablas confirmadas como intencionalmente locales (borrador/estado por
# dispositivo, o auditoría que nunca tuvo columnas de sync) -- verificado a
# mano el 2026-09-11. Si alguna de estas alguna vez necesita viajar entre
# máquinas, sacarla de esta lista Y agregarle sync_status/updated_at en
# db.js antes de registrarla en sync.js.
TABLAS_LOCALES_A_PROPOSITO = {
    "pedidos_abiertos",   # venta pausada -- se retoma en la misma caja
    "compras_pausadas",   # compra pausada -- se retoma en la misma máquina
    "historial_stock",    # snapshot de auditoría, nunca tuvo sync_status
}


def tablas_con_sync_status(db_js_src):
    """Nombre de cada CREATE TABLE de db.js cuyo cuerpo contiene sync_status."""
    tablas = []
    for m in re.finditer(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\(", db_js_src):
        nombre = m.group(1)
        inicio = m.end()
        # Cuerpo de la tabla: hasta la primera línea que es solo ")" (mismo
        # criterio de indentación que usa este archivo de forma consistente).
        cierre = re.search(r"\n\s*\)", db_js_src[inicio:])
        cuerpo = db_js_src[inicio: inicio + cierre.start()] if cierre else db_js_src[inicio:inicio + 2000]
        if "sync_status" in cuerpo:
            tablas.append(nombre)
    return set(tablas)


def tablas_registradas(sync_js_src):
    """Tablas con entrada propia en las listas de fuentes de sync.js
    (`{ table: 'xxx', ... }`) más las que viajan embebidas dentro de un
    denormalize() de otra tabla (`FROM xxx_items`, `FROM xxx_pagos`, etc.
    dentro de una función denormalize*)."""
    registradas = set(re.findall(r"\{\s*table:\s*'(\w+)'", sync_js_src))

    embebidas = set()
    for m in re.finditer(r"function denormalize\w*\([^)]*\)\s*\{", sync_js_src):
        inicio = m.end()
        cierre = sync_js_src.find("\n  }", inicio)
        cuerpo = sync_js_src[inicio: cierre if cierre != -1 else inicio + 3000]
        embebidas.update(re.findall(r"FROM (\w+)", cuerpo))

    return registradas | embebidas


def main():
    with open(DB_JS, encoding="utf-8") as f:
        db_src = f.read()
    with open(SYNC_JS, encoding="utf-8") as f:
        sync_src = f.read()

    con_sync = tablas_con_sync_status(db_src)
    registradas = tablas_registradas(sync_src)

    faltantes = con_sync - registradas - TABLAS_LOCALES_A_PROPOSITO
    ya_no_locales = TABLAS_LOCALES_A_PROPOSITO & registradas

    if ya_no_locales:
        print(
            f"AVISO: {sorted(ya_no_locales)} está(n) marcada(s) como local-a-propósito "
            f"en este script pero YA aparece(n) registrada(s) en sync.js -- "
            f"sacarla(s) de TABLAS_LOCALES_A_PROPOSITO, ya no hace falta la excepción."
        )

    if faltantes:
        print(
            f"FALLÓ: {sorted(faltantes)} tiene(n) columna sync_status en db.js "
            f"pero no aparece(n) registrada(s) en sync.js (ni como fuente propia "
            f"ni embebida en el denormalize() de otra tabla) -- sus datos no "
            f"viajan entre el POS del local y Admin-POS.\n"
            f"Si es intencional (una tabla nueva local-a-propósito), agregarla a "
            f"TABLAS_LOCALES_A_PROPOSITO en este archivo con el motivo."
        )
        sys.exit(1)

    print(f"OK - {len(con_sync)} tablas con sync_status, todas registradas en sync.js "
          f"o embebidas en el denormalize() de su tabla padre.")


if __name__ == "__main__":
    main()
