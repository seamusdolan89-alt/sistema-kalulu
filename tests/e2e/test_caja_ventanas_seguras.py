"""
tests/e2e/test_caja_ventanas_seguras.py — Egreso e ingreso de caja: no se pierden en silencio.

Misma protección que el pago a proveedor: un clic afuera no cierra la ventana, descartar lo cargado
pide confirmación, al guardar queda un aviso visible y el movimiento sube en el momento.

Correr (server en :8765):  python tests/e2e/test_caja_ventanas_seguras.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from helpers import abrir_caja_si_hace_falta
from sync_sim import Simulador


def main():
    with Simulador() as sim:
        page = sim.pos.page
        dialogos, aceptar = [], {"v": False}
        page.on("dialog", lambda d: (dialogos.append(d.message), d.accept() if aceptar["v"] else d.dismiss()))
        page.evaluate("window.location.hash = 'pos'")
        page.wait_for_load_state("networkidle")
        abrir_caja_si_hace_falta(page)
        sim.pos.sincronizar()
        page.evaluate("window.location.hash = 'caja/efectivo'")
        page.get_by_text("Egresos e Ingresos", exact=True).click()
        overlay = page.locator("#caja-modal-overlay")

        for tipo, tabla, monto in (("egreso", "egresos_caja", 777), ("ingreso", "ingresos_caja", 888)):
            abrir = page.get_by_text(f"+ {tipo.capitalize()}", exact=True)
            cuantos = lambda: sim.pos.q(f"SELECT COUNT(*) AS n FROM {tabla} WHERE monto = ?", [monto])[0]["n"]
            dialogos.clear()
            aceptar["v"] = False
            # vacia: se cierra sin preguntar
            abrir.click()
            page.keyboard.press("Escape")
            assert not overlay.is_visible() and not dialogos, dialogos
            # un clic afuera no cierra, ni siquiera despues de haber usado otra ventana
            abrir.click()
            page.fill(f"#{tipo}-monto", str(monto))
            page.mouse.click(5, 5)
            page.mouse.click(5, 5)
            v = page.locator(f"#{tipo}-monto").input_value() if overlay.is_visible() else None
            assert v is not None and str(monto) in v, (overlay.is_visible(), v)
            page.keyboard.press("Escape")
            page.locator(f"#btn-cancel-{tipo}").click()
            page.locator(f"#btn-close-{tipo}").click()
            assert len(dialogos) == 3 and "NO está guardado" in dialogos[0] and overlay.is_visible(), dialogos
            aceptar["v"] = True
            page.keyboard.press("Escape")
            assert not overlay.is_visible() and cuantos() == 0
            print(f"OK - {tipo}: cierre protegido")

            abrir.click()
            page.fill(f"#{tipo}-monto", str(monto))
            page.fill(f"#{tipo}-descripcion", "prueba <b>")
            page.locator(f"#btn-confirm-{tipo}").dblclick()
            conf = page.locator("#caja-confirmacion")
            conf.wait_for(state="visible", timeout=3000)
            texto = conf.inner_text()
            assert f"{tipo.capitalize()} registrado" in texto and str(monto) in texto and "prueba <b>" in texto, texto
            page.locator("#caja-conf-envio", has_text="Enviado a la nube").wait_for(timeout=5000)
            page.mouse.click(5, 5)
            assert conf.is_visible()
            page.keyboard.press("Enter")
            assert not overlay.is_visible() and cuantos() == 1
            assert any(d["monto"] == monto for d in sim.store.cols.get(tabla, {}).values()), "No subio al guardar"
            print(f"OK - {tipo}: confirmación, un solo movimiento y sube al guardar")

        assert not sim.pos.errores, sim.pos.errores
    print("\nTODO OK — test_caja_ventanas_seguras")


if __name__ == "__main__":
    main()
