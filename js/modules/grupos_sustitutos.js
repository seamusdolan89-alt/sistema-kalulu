'use strict';

/**
 * grupos_sustitutos.js — Motor unico para grupos de sustitutos
 * (window.SGA_GruposSustitutos).
 *
 * El modelo (tabla producto_sustitutos: producto_id, referencia_id) no tiene
 * un "grupo" con ID propio -- cada fila dice "mi referencia es X". Un
 * producto puede aparecer como referencia_id de otros SIN tener fila propia
 * (referencia implicita: nadie le puso una referencia, pero otros le
 * apuntan) o CON fila propia (es miembro de OTRO grupo). El bug que esto
 * previene: si a un producto que ya era referencia implicita de otros se lo
 * agrupa despues bajo una referencia distinta, esos otros quedan apuntando a
 * un intermediario que ya dejo de ser la referencia real -- su stock de
 * grupo deja de sumar correctamente y "reponer" pediria el producto
 * equivocado. Caso real: "Maizena" apuntaba a "Chango 500gr" como
 * referencia; cuando Chango se agrupo despues bajo "Dimax 500gr", Maizena
 * nunca se actualizo.
 *
 * aplicarCambioReferencia() es el unico punto de escritura de referencia_id
 * que hay que usar desde las pantallas -- resuelve ambas direcciones de la
 * cadena y marca pendientes de sync los productos afectados (el grupo viaja
 * embebido en el documento de cada producto, ver denormalizeProducto() en
 * js/sync.js -- sin marcar pending, un cambio de grupo nunca sale de esta
 * maquina).
 */

const SGA_GruposSustitutos = (() => {

  const db  = () => window.SGA_DB;
  const now = () => window.SGA_Utils.formatISODate(new Date());

  /**
   * Referencia real de un producto: si tiene fila propia, esa es su
   * referencia. Si no tiene fila propia pero otros le apuntan, el mismo es
   * la raiz (referencia implicita). Si no hay nada de lo anterior, no
   * pertenece a ningun grupo (null).
   */
  function referenciaRealDe(prodId) {
    const propia = db().query(
      `SELECT referencia_id FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`,
      [prodId]
    )[0];
    if (propia) return propia.referencia_id;

    const leApuntan = db().query(
      `SELECT 1 FROM producto_sustitutos WHERE referencia_id = ? AND producto_id != ? LIMIT 1`,
      [prodId, prodId]
    )[0];
    return leApuntan ? prodId : null;
  }

  /** Productos que apuntan a prodId como su referencia (sin incluir a prodId mismo). */
  function seguidoresDe(prodId) {
    return db().query(
      `SELECT ps.producto_id AS id, p.nombre
       FROM producto_sustitutos ps
       JOIN productos p ON p.id = ps.producto_id
       WHERE ps.referencia_id = ? AND ps.producto_id != ?`,
      [prodId, prodId]
    );
  }

  /** Marca pendientes de sync los productos cuyo grupo de sustitutos cambio. */
  function marcarPendientesSync(ids) {
    const ts = now();
    [...new Set(ids)].filter(Boolean).forEach(id => {
      db().run(`UPDATE productos SET sync_status = 'pending', updated_at = ? WHERE id = ?`, [ts, id]);
    });
  }

  /**
   * Punto unico de escritura para cambiar la referencia de grupo de prodId
   * a nuevaRef (ya resuelta -- el caller es responsable de resolverla con
   * referenciaRealDe() y confirmar con el usuario si cambio respecto de lo
   * que eligio, ver editor-producto.js setReferencia()).
   *
   * Cubre las dos direcciones de la cadena:
   *  1. Si prodId ya tenia su propia fila (pertenecia a OTRO grupo, con o
   *     sin referencia implicita), ese grupo entero se repunta a nuevaRef
   *     -- es el comportamiento ya esperado de "Cambiar referencia del
   *     grupo": no mueve solo a prodId, redesigna la referencia de todo el
   *     grupo al que ya pertenecia.
   *  2. Si otros productos apuntaban a prodId como referencia implicita
   *     (prodId no tenia fila propia todavia, pero era la raiz de facto),
   *     esos seguidores se repuntan tambien -- si no, quedan huerfanos
   *     apuntando a un producto que dejo de ser la referencia real.
   */
  function aplicarCambioReferencia(prodId, nuevaRef) {
    const ts = now();
    const afectados = new Set([prodId, nuevaRef]);

    const oldRef = db().query(
      `SELECT referencia_id FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`,
      [prodId]
    )[0]?.referencia_id;
    if (oldRef && oldRef !== nuevaRef) {
      db().query(`SELECT producto_id FROM producto_sustitutos WHERE referencia_id = ?`, [oldRef])
        .forEach(r => afectados.add(r.producto_id));
      db().run(
        `UPDATE producto_sustitutos SET referencia_id = ?, sustituto_id = ? WHERE referencia_id = ?`,
        [nuevaRef, nuevaRef, oldRef]
      );
    }

    seguidoresDe(prodId).forEach(f => afectados.add(f.id));
    db().run(
      `UPDATE producto_sustitutos SET referencia_id = ?, sustituto_id = ?
       WHERE referencia_id = ? AND producto_id != ?`,
      [nuevaRef, nuevaRef, prodId, nuevaRef]
    );

    db().run(
      `INSERT OR REPLACE INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
       VALUES (?, ?, ?, 1, ?)`,
      [prodId, nuevaRef, nuevaRef, ts]
    );

    marcarPendientesSync([...afectados]);
  }

  return { referenciaRealDe, seguidoresDe, marcarPendientesSync, aplicarCambioReferencia };
})();

window.SGA_GruposSustitutos = SGA_GruposSustitutos;

export default SGA_GruposSustitutos;
