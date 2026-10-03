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
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ REGLA: TODA escritura en la tabla `producto_sustitutos` (INSERT / UPDATE ║
 * ║ / DELETE) pasa por las funciones de ESTE archivo. Ninguna pantalla,      ║
 * ║ importacion ni modulo nuevo escribe esa tabla a mano.                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * Por que: cada camino que escribia "a mano" (editor, Ordenes, importacion) termino
 * dejando filas duplicadas, cadenas rotas, ciclos o referencias sin fila propia, y
 * cada uno hubo que arreglarlo por separado (auditoria del 2/10/2026). Las
 * invariantes que el motor garantiza (las verifica diagnosticar()):
 *   1. UNA sola fila por producto;
 *   2. una referencia nunca apunta a otro producto (ni cadenas ni ciclos);
 *   3. toda referencia tiene su propia fila (ref -> ref), asi su stock cuenta en el grupo;
 *   4. ninguna fila apunta a un producto que no existe.
 * Si necesitas una operacion nueva sobre grupos: agregala ACA (escribiendo solo con
 * estas primitivas o con SQL que respete las 4 invariantes, y marcando los productos
 * afectados con marcarPendientesSync), y sumala a la lista de operaciones de
 * tests/e2e/test_grupos_sustitutos_fuzz.py: si una operacion nueva rompe una
 * invariante, ese test la atrapa con la semilla y los pasos exactos.
 * Los unicos otros lugares que tocan la tabla, a proposito: js/db.js (crear la tabla y
 * autocompletar filas propias al arrancar) y js/sync.js (aplicar el documento de un
 * producto que llega de la otra computadora). tests/e2e/test_sustitutos_solo_por_motor.py
 * falla si aparece cualquier otro archivo escribiendo la tabla.
 *
 * Lectura: `stockDelGrupo` es la UNICA formula de stock de un grupo; `miembrosDe` /
 * `referenciaRealDe` / `seguidoresDe` son las unicas formas de preguntar "de que grupo
 * es este producto". No reimplementes esas consultas en una pantalla.
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
    asegurarFilaPropia(nuevaRef);

    marcarPendientesSync([...afectados]);
  }

  /**
   * La referencia de un grupo tiene que tener su PROPIA fila (ref -> ref). Sin ella el stock del
   * grupo se suma sin contar el de la referencia (las sumas son "filas con referencia_id = X", y
   * la referencia no figuraba entre ellas) hasta que db.js la autocompleta al proximo arranque.
   * No toca a un producto que ya tiene fila (aunque apunte a otro grupo).
   */
  function asegurarFilaPropia(id) {
    const tiene = db().query(
      `SELECT 1 FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`, [id]
    )[0];
    if (tiene) return;
    db().run(
      `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
       VALUES (?, ?, ?, 1, ?)`,
      [id, id, id, now()]
    );
  }

  /**
   * Referencia raiz de refId siguiendo la cadena de filas propias (X -> Y -> Z ...).
   * Devuelve refId mismo si no tiene fila propia con otra referencia. Corta ante un ciclo.
   */
  function raizDe(refId) {
    const visto = new Set([refId]);
    let actual = refId;
    for (;;) {
      const sig = db().query(
        `SELECT referencia_id FROM producto_sustitutos
         WHERE producto_id = ? AND referencia_id IS NOT NULL AND referencia_id != producto_id LIMIT 1`,
        [actual]
      )[0]?.referencia_id;
      if (!sig || visto.has(sig)) return actual;
      visto.add(sig);
      actual = sig;
    }
  }

  /**
   * Corrige una cadena rota: refId es la referencia de un grupo, pero a su vez es miembro de
   * OTRO grupo (tiene fila propia apuntando a Y). Repunta todos sus seguidores a la referencia
   * raiz real. NO toca la fila propia de refId (conserva su estado activo/inactivo).
   * Devuelve { raizId, cambiados } (cambiados = cuantos productos se movieron).
   */
  function corregirCadena(refId) {
    const raizId = raizDe(refId);
    if (!raizId || raizId === refId) return { raizId: refId, cambiados: 0 };
    const seguidores = seguidoresDe(refId).filter(f => f.id !== raizId);
    if (!seguidores.length) return { raizId, cambiados: 0 };
    db().run(
      `UPDATE producto_sustitutos SET referencia_id = ?, sustituto_id = ?
       WHERE referencia_id = ? AND producto_id != ?`,
      [raizId, raizId, refId, raizId]
    );
    asegurarFilaPropia(raizId);
    marcarPendientesSync([raizId, refId, ...seguidores.map(f => f.id)]);
    return { raizId, cambiados: seguidores.length };
  }

  /**
   * Todos los productos involucrados en el grupo roto de refId: la referencia, su referencia real
   * (raiz de la cadena) y cualquiera que apunte a alguno de ellos. Es el universo que el usuario
   * puede tildar/destildar en "Editar grupo" (informes).
   */
  function involucradosDe(refId) {
    const ids = new Set([refId, raizDe(refId)]);
    let crecio = true;
    while (crecio) {
      crecio = false;
      for (const id of [...ids]) {
        seguidoresDe(id).forEach(f => { if (!ids.has(f.id)) { ids.add(f.id); crecio = true; } });
      }
    }
    return [...ids];
  }

  /**
   * Arma el grupo exactamente como lo definio el usuario: `miembros` (ids) quedan juntos bajo
   * `referenciaId` (tiene que estar entre ellos); cada id de `involucrados` que NO esta en
   * `miembros` se saca del grupo. La referencia queda con su propia fila (ref -> ref). Cada
   * producto queda con UNA sola fila (la tabla admite varias por producto, pero toda consulta
   * asume una) y conserva su estado activo.
   */
  function definirGrupo({ miembros, referenciaId, involucrados }) {
    if (!miembros.includes(referenciaId)) throw new Error('La referencia tiene que ser parte del grupo');
    const ts = now();
    const quedan = new Set(miembros);

    involucrados.filter(id => !quedan.has(id)).forEach(id => {
      db().run(`DELETE FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL`, [id]);
    });

    miembros.forEach(id => {
      const activo = db().query(
        `SELECT activo FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`, [id]
      )[0]?.activo;
      db().run(`DELETE FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL`, [id]);
      db().run(
        `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
         VALUES (?, ?, ?, ?, ?)`,
        [id, referenciaId, referenciaId, activo == null ? 1 : activo, ts]
      );
    });

    marcarPendientesSync([...involucrados, ...miembros, referenciaId]);
  }

  /**
   * Miembros del grupo de un producto, referencia incluida: [{ id, nombre }] ordenados por
   * nombre. Vacio si no tiene grupo. Mira las dos direcciones (ver referenciaRealDe).
   */
  function miembrosDe(prodId) {
    const refId = referenciaRealDe(prodId);
    if (!refId) return [];
    const filas = db().query(`
      SELECT DISTINCT ps.producto_id AS id, p.nombre
      FROM producto_sustitutos ps
      JOIN productos p ON p.id = ps.producto_id
      WHERE ps.referencia_id = ?
    `, [refId]);
    if (!filas.some(f => f.id === refId)) {
      const propia = db().query(`SELECT id, nombre FROM productos WHERE id = ?`, [refId])[0];
      if (propia) filas.push(propia);
    }
    return filas.sort((a, b) =>
      String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', { sensitivity: 'base' }));
  }

  /**
   * Stock disponible de un producto en una sucursal: el de todo su grupo (referencia incluida,
   * tenga o no fila propia) o el propio si no tiene grupo. UNICA formula de stock de grupo: no
   * duplicarla en cada pantalla.
   */
  function stockDelGrupo(prodId, sucursalId) {
    const refId = referenciaRealDe(prodId);
    if (!refId) {
      return db().query(
        `SELECT COALESCE(cantidad, 0) AS q FROM stock WHERE producto_id = ? AND sucursal_id = ?`,
        [prodId, sucursalId]
      )[0]?.q || 0;
    }
    return db().query(`
      SELECT COALESCE(SUM(st.cantidad), 0) AS total
      FROM (SELECT ? AS id UNION SELECT producto_id FROM producto_sustitutos WHERE referencia_id = ?) m
      LEFT JOIN stock st ON st.producto_id = m.id AND st.sucursal_id = ?
    `, [refId, refId, sucursalId])[0]?.total || 0;
  }

  /**
   * Mueve UN producto a la referencia refId sin tocar al resto de su grupo viejo (lo usa la
   * importacion: una fila del archivo habla de un solo producto). Si el producto era referencia
   * de otros, no se pueden dejar atras: se mueve con todo su grupo.
   *
   * Nunca deja una cadena: si refId es a su vez miembro de otro grupo, se usa la referencia real
   * de ese grupo. Devuelve { estado, refEfectiva, antes }:
   *   'ok'            -> se movio al grupo de refEfectiva (antes = su referencia anterior, o null)
   *   'redirigida'    -> igual que 'ok', pero refId no era referencia y se uso la real
   *   'sin_cambio'    -> ya estaba en ese grupo, o es la propia referencia
   *   'ciclo_ignorado'-> refId es miembro de un grupo que el propio producto encabeza: aplicarla
   *                      armaria un ciclo, se ignora
   */
  function moverMiembro(prodId, refId) {
    const res = { estado: 'sin_cambio', refEfectiva: refId, antes: null };
    if (!prodId || !refId || prodId === refId) return res;

    const real = referenciaRealDe(refId);
    if (real === prodId) return { ...res, estado: 'ciclo_ignorado', refEfectiva: prodId };
    if (real && real !== refId) { res.refEfectiva = real; refId = real; res.estado = 'redirigida'; }

    const antes = referenciaRealDe(prodId);
    res.antes = antes;
    if (antes === refId) return { ...res, estado: 'sin_cambio' };

    if (seguidoresDe(prodId).length) {
      aplicarCambioReferencia(prodId, refId);
    } else {
      db().run(`DELETE FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL`, [prodId]);
      db().run(
        `INSERT INTO producto_sustitutos (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
         VALUES (?, ?, ?, 1, ?)`,
        [prodId, refId, refId, now()]
      );
      asegurarFilaPropia(refId);
      marcarPendientesSync([prodId, refId, antes]);
    }
    if (res.estado === 'sin_cambio') res.estado = 'ok';
    return res;
  }

  /**
   * Chequeo de integridad de TODOS los grupos (solo lectura). Un grupo sano cumple:
   *  - cada producto tiene UNA sola fila (duplicados);
   *  - la referencia existe y el producto tambien (inexistentes);
   *  - una referencia no apunta a otro producto (cadenas) ni se cierra un anillo (ciclos);
   *  - toda referencia tiene su propia fila ref -> ref (sinFilaPropia).
   * Devuelve { duplicados, inexistentes, cadenas, ciclos, sinFilaPropia, ok }.
   */
  function diagnosticar() {
    const filas = db().query(`
      SELECT ps.producto_id, ps.referencia_id,
             EXISTS(SELECT 1 FROM productos p WHERE p.id = ps.producto_id)    AS prod_ok,
             EXISTS(SELECT 1 FROM productos p WHERE p.id = ps.referencia_id)  AS ref_ok
      FROM producto_sustitutos ps WHERE ps.referencia_id IS NOT NULL
    `);
    const porProd = new Map();
    filas.forEach(f => {
      if (!porProd.has(f.producto_id)) porProd.set(f.producto_id, []);
      porProd.get(f.producto_id).push(f.referencia_id);
    });

    const duplicados = [...porProd].filter(([, refs]) => refs.length > 1)
      .map(([producto_id, refs]) => ({ producto_id, referencias: refs }));
    const inexistentes = filas.filter(f => !f.prod_ok || !f.ref_ok)
      .map(f => ({ producto_id: f.producto_id, referencia_id: f.referencia_id, falta: !f.prod_ok ? 'producto' : 'referencia' }));

    const sig = id => (porProd.get(id) || []).find(r => r !== id) || null;   // su referencia, si apunta a OTRO
    const cadenas = [], ciclos = [], vistoCiclo = new Set();
    for (const [producto_id, refs] of porProd) {
      const ref = refs.find(r => r !== producto_id);
      if (!ref) continue;
      const sigRef = sig(ref);
      if (sigRef && sigRef !== producto_id) cadenas.push({ producto_id, referencia_id: ref, apunta_a: sigRef });
      // anillo: seguir la cadena hasta repetir
      const camino = [producto_id]; let cur = ref;
      while (cur && !camino.includes(cur)) { camino.push(cur); cur = sig(cur); }
      if (cur && camino.includes(cur)) {
        const anillo = camino.slice(camino.indexOf(cur));
        const clave = [...anillo].sort().join('|');
        if (!vistoCiclo.has(clave)) { vistoCiclo.add(clave); ciclos.push(anillo); }
      }
    }
    const sinFilaPropia = [...new Set(filas.map(f => f.referencia_id))]
      .filter(r => !porProd.has(r) && filas.some(f => f.referencia_id === r && f.producto_id !== r));

    const ok = !duplicados.length && !inexistentes.length && !cadenas.length && !ciclos.length && !sinFilaPropia.length;
    return { duplicados, inexistentes, cadenas, ciclos, sinFilaPropia, ok };
  }

  /**
   * Junta a `prodIds` bajo la referencia `refId`. Cada uno se mueve CON su grupo (y con los que
   * le apuntaban aunque no tuviera fila propia), y si refId era miembro de otro grupo, ese grupo
   * entero pasa a refId. Nunca deja cadenas rotas ni una referencia sin fila propia.
   */
  function agruparConReferencia(prodIds, refId) {
    const refReal = referenciaRealDe(refId);
    if (refReal && refReal !== refId) aplicarCambioReferencia(refId, refId);
    [...new Set(prodIds)].filter(id => id !== refId).forEach(id => aplicarCambioReferencia(id, refId));
    asegurarFilaPropia(refId);
    marcarPendientesSync([...prodIds, refId]);
  }

  // ── Quitar, cambiar, desactivar y eliminar productos que son referencia ──────────
  //
  // Reglas del negocio (acordadas con el dueño, 2/10/2026):
  //  - Una REFERENCIA no se puede quitar de su grupo: primero se cambia la referencia a otro
  //    miembro, y recien despues se la puede quitar como a cualquier miembro (quitarDelGrupo).
  //  - DESACTIVAR un producto no lo saca del grupo: su stock sigue sumando (si no, se pediria de
  //    mas lo que todavia hay). Si es la referencia, la orden de compra descarta el grupo entero
  //    (generarOrdenCompra), asi que se avisa y se ofrece migrar la referencia a otro miembro.
  //  - ELIMINAR un producto que es referencia obliga a elegir antes la nueva referencia; un
  //    miembro simplemente sale del grupo.

  /**
   * Si prodId es la referencia de un grupo con otros miembros, devuelve esos miembros
   * ([{ id, nombre, activo, stock }], activos y con mas stock primero). null si no es
   * referencia de nadie. `soloActivos` descarta los desactivados (para migrar la referencia al
   * desactivar: no tiene sentido pasarla a otro inactivo).
   */
  function candidatosReferencia(prodId, sucursalId, soloActivos) {
    if (referenciaRealDe(prodId) !== prodId) return null;
    const seguidores = seguidoresDe(prodId);
    if (!seguidores.length) return null;
    return db().query(`
      SELECT p.id, p.nombre, p.activo, COALESCE(st.cantidad, 0) AS stock
      FROM productos p
      LEFT JOIN stock st ON st.producto_id = p.id AND st.sucursal_id = ?
      WHERE p.id IN (${seguidores.map(() => '?').join(',')})
        ${soloActivos ? 'AND p.activo = 1' : ''}
      ORDER BY p.activo DESC, stock DESC, p.nombre COLLATE NOCASE
    `, [sucursalId, ...seguidores.map(f => f.id)]);
  }

  /**
   * Pasa el grupo de `viejaId` a `nuevaId`. Por defecto `viejaId` SIGUE en el grupo (como un
   * miembro mas y con su stock contando); con { quitarVieja: true } sale del grupo.
   */
  function migrarReferencia(viejaId, nuevaId, { quitarVieja = false } = {}) {
    const seguidores = seguidoresDe(viejaId).map(f => f.id);
    aplicarCambioReferencia(viejaId, nuevaId);
    if (quitarVieja) {
      db().run(`DELETE FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL`, [viejaId]);
    }
    marcarPendientesSync([viejaId, nuevaId, ...seguidores]);
  }

  /**
   * Saca a un MIEMBRO de su grupo (su stock deja de sumar al del grupo y vuelve a contar solo).
   * Una referencia con miembros no se puede quitar: devuelve { ok: false, motivo: 'es_referencia' }
   * y hay que cambiar antes la referencia (migrarReferencia / pedirNuevaReferencia).
   */
  function quitarDelGrupo(prodId) {
    if (seguidoresDe(prodId).length) return { ok: false, motivo: 'es_referencia' };
    const ref = db().query(
      `SELECT referencia_id FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`,
      [prodId]
    )[0]?.referencia_id;
    db().run(`DELETE FROM producto_sustitutos WHERE producto_id = ? AND referencia_id IS NOT NULL`, [prodId]);
    marcarPendientesSync([prodId, ref]);
    return { ok: true };
  }

  /**
   * Dialogo para elegir la nueva referencia de un grupo. Devuelve una promesa con true si el
   * caller puede seguir con lo que iba a hacer y false si el usuario cancela. Modos:
   *  - 'cambiar'    : cambiar la referencia del grupo a otro miembro (el actual sigue en el grupo).
   *  - 'desactivar' : se va a desactivar la referencia; migrar es opcional y casilla "sacarlo del grupo".
   *  - 'eliminar'   : se va a eliminar la referencia; elegir la nueva es obligatorio.
   * Si el producto no es referencia de nadie, resuelve true sin mostrar nada.
   * Toda la escritura de grupos la hace el motor (migrarReferencia).
   */
  function pedirNuevaReferencia(prodId, nombre, modo) {
    const sucursalId = window.SGA_Auth?.getCurrentUser()?.sucursal_id || '1';
    const candidatos = candidatosReferencia(prodId, sucursalId, modo === 'desactivar');
    if (!candidatos) return Promise.resolve(true);

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const hayOtros = candidatos.length > 0;
    const T = {
      cambiar: {
        titulo: `Cambiar la referencia del grupo de "${esc(nombre)}"`,
        intro: 'La orden de compra le pide siempre a la referencia. Elegí cuál de los miembros pasa a serlo.',
        nota: `"${esc(nombre)}" sigue en el grupo como un miembro más.`,
        ok: 'Cambiar referencia',
      },
      desactivar: {
        titulo: `⚠ "${esc(nombre)}" es la referencia de un grupo de sustitutos`,
        intro: 'La orden de compra le pide siempre a la referencia. Si la desactivás, <strong>el grupo entero deja de pedirse</strong>.',
        nota: `"${esc(nombre)}" sigue en el grupo y su stock sigue contando.`,
        ok: 'Migrar y desactivar',
      },
      eliminar: {
        titulo: `⚠ "${esc(nombre)}" es la referencia de un grupo de sustitutos`,
        intro: 'Para eliminarlo hay que elegir antes la <strong>nueva referencia</strong> del grupo. "' + esc(nombre) + '" sale del grupo.',
        nota: '',
        ok: 'Migrar y eliminar',
      },
    }[modo];

    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'sg-desactivar-ref';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
      overlay.innerHTML = `
        <div role="alertdialog" aria-label="Referencia de un grupo de sustitutos" style="background:#fff;border-radius:12px;max-width:560px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.35)">
          <div style="padding:16px 20px;border-bottom:1px solid #eee;background:#fff3e0;border-radius:12px 12px 0 0">
            <div style="font-weight:700;color:#e65100">${T.titulo}</div>
          </div>
          <div style="padding:14px 20px;font-size:.92em;color:#334">
            <p style="margin:0 0 10px">${T.intro}</p>
            ${hayOtros ? `
              <p style="margin:0 0 6px;font-weight:600">Nueva referencia:</p>
              <div style="max-height:220px;overflow-y:auto;margin-bottom:10px">
                ${candidatos.map((c, i) => `
                  <label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f3f3f3;cursor:pointer">
                    <input type="radio" name="sg-nueva-ref" value="${esc(c.id)}" ${i === 0 ? 'checked' : ''}>
                    <span style="flex:1">${esc(c.nombre)}${c.activo === 0 ? ' <span style="color:#c62828">(inactivo)</span>' : ''}</span>
                    <span style="color:#889;font-size:.85em">stock ${c.stock}</span>
                  </label>`).join('')}
              </div>
              ${T.nota ? `<p style="margin:0 0 8px;font-size:.82em;color:#667">${T.nota}</p>` : ''}
              ${modo === 'desactivar' ? `
                <label style="display:flex;align-items:center;gap:8px;font-size:.88em;cursor:pointer">
                  <input type="checkbox" id="sg-dr-quitar"> Sacarlo también del grupo (su stock deja de sumarse al del grupo)
                </label>` : ''}`
            : `<p style="margin:0;color:#c62828">No quedan otros productos ${modo === 'desactivar' ? 'activos ' : ''}en el grupo para migrar la referencia.</p>`}
          </div>
          <div style="padding:12px 20px;border-top:1px solid #eee;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
            <button class="btn btn-sm" id="sg-dr-cancelar">Cancelar</button>
            ${modo === 'desactivar' ? '<button class="btn btn-sm" id="sg-dr-sin">Desactivar sin migrar</button>' : ''}
            ${hayOtros ? `<button class="btn btn-sm btn-primary" id="sg-dr-migrar">${T.ok}</button>` : ''}
          </div>
        </div>`;
      document.body.appendChild(overlay);

      // El dialogo captura su propio teclado: Escape cancela solo esto, nunca la pantalla de atras.
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(false); } };
      const fin = (ok) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(ok);
      };
      document.addEventListener('keydown', onKey, true);

      overlay.querySelector('#sg-dr-cancelar').addEventListener('click', () => fin(false));
      overlay.querySelector('#sg-dr-sin')?.addEventListener('click', () => fin(true));
      overlay.querySelector('#sg-dr-migrar')?.addEventListener('click', () => {
        const nuevaId = overlay.querySelector('input[name="sg-nueva-ref"]:checked')?.value;
        if (nuevaId) {
          // Eliminar: el producto va a desaparecer, asi que sale del grupo siempre.
          const quitar = modo === 'eliminar' || !!overlay.querySelector('#sg-dr-quitar')?.checked;
          migrarReferencia(prodId, nuevaId, { quitarVieja: quitar });
        }
        fin(true);
      });
      (overlay.querySelector('#sg-dr-migrar') || overlay.querySelector('#sg-dr-cancelar')).focus();
    });
  }

  /** Antes de DESACTIVAR un producto (ver pedirNuevaReferencia). */
  const confirmarDesactivacion = (prodId, nombre) => pedirNuevaReferencia(prodId, nombre, 'desactivar');

  /**
   * Antes de ELIMINAR un producto: si es referencia obliga a elegir la nueva; si es miembro lo
   * saca del grupo (no puede quedar una fila apuntando a un producto que ya no existe).
   * Devuelve una promesa con true si se puede eliminar.
   */
  async function liberarParaEliminar(prodId, nombre) {
    if (seguidoresDe(prodId).length) {
      const ok = await pedirNuevaReferencia(prodId, nombre, 'eliminar');
      if (!ok) return false;
    }
    quitarDelGrupo(prodId);
    return true;
  }

  return {
    // Escritura de grupos: SOLO estas funciones (ver la regla al principio del archivo).
    referenciaRealDe, seguidoresDe, marcarPendientesSync, aplicarCambioReferencia, asegurarFilaPropia,
    raizDe, corregirCadena, involucradosDe, definirGrupo,
    miembrosDe, stockDelGrupo, moverMiembro, agruparConReferencia, diagnosticar,
    candidatosReferencia, migrarReferencia, quitarDelGrupo,
    pedirNuevaReferencia, confirmarDesactivacion, liberarParaEliminar,
  };
})();

window.SGA_GruposSustitutos = SGA_GruposSustitutos;

export default SGA_GruposSustitutos;
