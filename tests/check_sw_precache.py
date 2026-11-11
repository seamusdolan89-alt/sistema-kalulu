"""
tests/check_sw_precache.py — Auditoría estática: todo archivo real de
js/modules/*.js y views/*.html está en la lista OWN_PATHS de sw.js (el
Service Worker que precachea la app para que funcione sin internet, ver
CLAUDE.md "Offline / Service Worker").

Por qué existe: OWN_PATHS es un array escrito a mano (sin build, no hay forma
de generarlo solo) — si se agrega una pantalla nueva y nadie se acuerda de
sumarla ahí, esa pantalla igual queda cacheada la PRIMERA vez que se visita
con internet (el fetch handler de sw.js cachea cualquier fetch exitoso, no
solo lo precacheado en la instalación) — pero NO en una instalación fresca
del Service Worker sin haber visitado esa pantalla antes. Este chequeo evita
que ese olvido pase desapercibido, mismo espíritu que check_sync_tablas.py.

No usa Playwright ni servidor — análisis estático de archivos, corre en
segundos. Se puede correr suelto o como parte de la suite de CI.

Correr:

    python tests/check_sw_precache.py
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW_JS = os.path.join(ROOT, "sw.js")

# Vistas que existen en el filesystem pero a propósito no están ruteadas por
# app.js (código muerto / backup) -- no hace falta precachearlas offline.
VISTAS_EXCLUIDAS = {
    "productos_backup.html",  # backup viejo, no lo referencia ningún módulo activo
}


def own_paths(sw_src):
    m = re.search(r"const OWN_PATHS = \[(.*?)\];", sw_src, re.DOTALL)
    if not m:
        print("FALLÓ: no encontré el array OWN_PATHS en sw.js (¿cambió el nombre o el formato?).")
        sys.exit(1)
    return set(re.findall(r"'([^']+)'", m.group(1)))


def main():
    with open(SW_JS, encoding="utf-8") as f:
        sw_src = f.read()

    precacheadas = own_paths(sw_src)

    modulos_reales = {
        "js/modules/" + os.path.basename(p)
        for p in glob.glob(os.path.join(ROOT, "js", "modules", "*.js"))
    }
    vistas_reales = {
        "views/" + os.path.basename(p)
        for p in glob.glob(os.path.join(ROOT, "views", "*.html"))
        if os.path.basename(p) not in VISTAS_EXCLUIDAS
    }

    faltantes = (modulos_reales | vistas_reales) - precacheadas
    excluidas_que_ya_no_existen = VISTAS_EXCLUIDAS - {
        os.path.basename(p) for p in glob.glob(os.path.join(ROOT, "views", "*.html"))
    }

    if excluidas_que_ya_no_existen:
        print(
            f"AVISO: {sorted(excluidas_que_ya_no_existen)} está(n) en VISTAS_EXCLUIDAS "
            f"de este script pero ya no existe(n) en views/ -- se puede sacar de la lista."
        )

    if faltantes:
        print(
            f"FALLÓ: {sorted(faltantes)} existe(n) en el filesystem pero no está(n) en "
            f"OWN_PATHS de sw.js -- una instalación fresca del Service Worker (ej. "
            f"compu nueva, o cache borrado) no va a poder abrir esa pantalla offline "
            f"hasta visitarla una vez con internet.\n"
            f"Si es intencional (código muerto, no ruteado), agregarla a "
            f"VISTAS_EXCLUIDAS en este archivo con el motivo."
        )
        sys.exit(1)

    print(f"OK - {len(modulos_reales)} módulos + {len(vistas_reales)} vistas, "
          f"todos precacheados en sw.js.")


if __name__ == "__main__":
    main()
