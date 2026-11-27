"""
tests/e2e/test_pago_proveedor_seguro.py — Pago a proveedor: no se pierde en silencio.

Caso real (27/11/2026): un pago por transferencia cargado en el POS no apareció en ninguna compu ni
en la nube. La ventana se cerraba con un clic afuera sin avisar, al guardar no mostraba ninguna
confirmación (llamaba a una función que no existe) y el pago no subía hasta la próxima venta o el
ciclo de 5 minutos.

Cubre:
 1. Clic fuera de la ventana: no la cierra. Cancelar / Escape con datos: piden confirmación.
 2. Al guardar: confirmación visible con proveedor e importe, un solo pago aunque se insista.
 3. El pago sube apenas se guarda (sin llamar a push a mano) y llega a Admin-POS.
 4. Sin conexión: la confirmación dice que todavía no se envió.
 5. Fallo al guardar en disco: cartel visible.

Correr (server en :8765):  python tests/e2e/test_pago_proveedor_seguro.py
"""
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))

from sync_sim import Simulador

ABRIR = """async (prov) => {
  await import('/js/modules/cuenta_corriente_proveedores.js');
  const W = (await import('/js/modules/pago_proveedor_wizard.js')).default;
  W.abrir({ proveedorId: prov });
}"""

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "screenshots")


def cuantos(d, monto):
    return d.q("SELECT COUNT(*) AS n FROM pagos_proveedores_metodos WHERE monto = ?", [monto])[0]["n"]


def cargar(page, monto):
    page.locator("#chk-transferencia").check()
    page.locator("#mp-tr-monto").fill(str(monto))


def main():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    with Simulador() as sim:
        page = sim.pos.page
        dialogos, aceptar = [], {"v": False}
        page.on("dialog", lambda d: (dialogos.append(d.message), d.accept() if aceptar["v"] else d.dismiss()))
        prov = sim.pos.q("SELECT id, razon_social FROM proveedores LIMIT 1")[0]
        sim.pos.sincronizar()
        sim.admin.sincronizar()
        overlay = page.locator("#sga-pagoprov-overlay")

        sim.pos.js(ABRIR, prov["id"])
        cargar(page, 370000)
        page.mouse.click(5, 5)
        assert overlay.is_visible() and page.locator("#mp-tr-monto").input_value(), "Un clic afuera cerro la ventana"
        page.keyboard.press("Escape")
        page.locator("#btn-modal-cancel").click()
        page.locator("#btn-modal-close").click()
        assert len(dialogos) == 3 and "NO está guardado" in dialogos[0], dialogos
        assert overlay.is_visible(), "Con 'Cancelar' en la confirmacion no debe cerrarse"
        aceptar["v"] = True
        page.keyboard.press("Escape")
        assert not overlay.is_visible() and cuantos(sim.pos, 370000) == 0
        # sin nada cargado cierra directo
        n = len(dialogos)
        sim.pos.js(ABRIR, prov["id"])
        page.keyboard.press("Escape")
        assert not overlay.is_visible() and len(dialogos) == n
        print("OK - cierre protegido")

        sim.pos.js(ABRIR, prov["id"])
        cargar(page, 370000)
        page.locator("#btn-modal-guardar").dblclick()
        conf = page.locator("#mp-confirmacion")
        conf.wait_for(state="visible", timeout=3000)
        texto = conf.inner_text()
        assert "Pago registrado" in texto and prov["razon_social"] in texto and "370.000" in texto, texto
        page.locator("#mp-envio", has_text="Enviado a la nube").wait_for(timeout=5000)
        page.screenshot(path=os.path.join(SCREENSHOT_DIR, "pago_confirmacion.png"))
        page.mouse.click(5, 5)
        assert conf.is_visible()
        page.keyboard.press("Enter")
        assert not overlay.is_visible() and cuantos(sim.pos, 370000) == 1
        print("OK - confirmacion y un solo pago")

        subidos = sim.store.cols.get("pagos_proveedores", {})
        assert any(m["monto"] == 370000 for d in subidos.values() for m in d["_metodos"]), "No subio al guardar"
        sim.admin.sincronizar()
        assert cuantos(sim.admin, 370000) == 1, "No llego a Admin-POS"
        print("OK - sube apenas se guarda y llega a Admin")

        sim.pos.js("() => window.SGA_Sync.__testForceInitialized(null)")
        sim.pos.js(ABRIR, prov["id"])
        cargar(page, 4321)
        page.locator("#btn-modal-guardar").click()
        page.locator("#mp-envio", has_text="Todavía no se envió").wait_for(timeout=5000)
        page.locator("#mp-aceptar").click()
        print("OK - sin conexion lo dice")

        sim.pos.js("""() => { FileSystemFileHandle.prototype.__orig = FileSystemFileHandle.prototype.createWritable;
          FileSystemFileHandle.prototype.createWritable = () => Promise.reject(new Error('disco lleno (prueba)')); }""")
        sim.pos.js(ABRIR, prov["id"])
        cargar(page, 555)
        page.locator("#btn-modal-guardar").click()
        page.locator("#sga-error-guardado").wait_for(state="visible", timeout=5000)
        page.locator("#mp-confirmacion", has_text="no se pudo guardar en el disco").wait_for(timeout=5000)
        sim.pos.js("() => { FileSystemFileHandle.prototype.createWritable = FileSystemFileHandle.prototype.__orig; }")
        page.locator("#mp-aceptar").click()
        sim.pos.run("UPDATE proveedores SET updated_at = updated_at")
        page.locator("#sga-error-guardado").wait_for(state="detached", timeout=5000)
        print("OK - fallo de disco visible")

        assert not sim.pos.errores and not sim.admin.errores, (sim.pos.errores, sim.admin.errores)
    print("\nTODO OK — test_pago_proveedor_seguro")


if __name__ == "__main__":
    main()
