/**
 * quiebres.js — cuándo un producto (o un grupo de sustitutos) estuvo sin stock.
 *
 * Una sola cuenta para Informes → "Quiebres de Stock" y la columna "Sin stock 30d" de Órdenes de
 * Compra (criterio del dueño, 27/11/2026). Sale del registro de movimientos (stock_movimientos):
 *   - sin stock = saldo <= 0; en un grupo, el saldo es la SUMA del grupo (los negativos no se
 *     toman como 0);
 *   - un día cuenta si TERMINÓ sin stock (hoy: si está sin stock ahora);
 *   - no hay historia anterior al primer movimiento.
 */

export const EPS_STOCK = 0.0001;

// Momento en que se "cierra" cada dia de calendario del rango (hoy: ahora). Se calcula una sola
// vez por consulta: se recorre por cada producto.
export function cierresDeDias(ini, fin) {
  const cierres = [];
  const dia = new Date(ini);
  dia.setHours(0, 0, 0, 0);
  const finD = new Date(fin);
  while (dia < finD) {
    dia.setDate(dia.getDate() + 1);
    cierres.push((dia < finD ? dia : finD).toISOString());
  }
  return cierres;
}

export function inicioHistorial(sucursalId) {
  return window.SGA_DB.query(`
    SELECT COALESCE(MIN(CASE WHEN id LIKE 'saldo_inicial:%' THEN fecha END), MIN(fecha)) AS f
      FROM stock_movimientos WHERE sucursal_id = ?`, [sucursalId])[0]?.f || null;
}

/** Fila de stock_movimientos -> el formato que usa analizarQuiebres. */
export function leerMovimiento(m, inicioHist) {
  // El saldo inicial es el punto de partida del historial, sea cual sea su hora exacta.
  const t = String(m.id).startsWith('saldo_inicial:') ? inicioHist : m.fecha;
  return { t, delta: Number(m.delta) || 0, ref: m.ref_id, prod: m.producto_id };
}

// movs: [{ t, delta, ref, prod }] ordenados por t. ini/fin: ISO. nuevo: dado de alta dentro del
// rango (no "venia sin stock": todavia no existia).
export function analizarQuiebres(movs, ini, fin, cierres, nuevo) {
  let saldo = 0, i = 0;
  const porProd = new Map();
  const negativos = new Set();
  const aplicar = (m) => {
    saldo += m.delta;
    porProd.set(m.prod, (porProd.get(m.prod) || 0) + m.delta);
  };
  const mirarNegativos = () => porProd.forEach((v, id) => { if (v < -EPS_STOCK) negativos.add(id); });

  while (i < movs.length && movs[i].t <= ini) aplicar(movs[i++]);
  mirarNegativos();

  const episodios = [];
  let sinStock = saldo <= EPS_STOCK;
  const venia = sinStock && !nuevo;
  if (venia) episodios.push({ desde: ini, hasta: null });
  let veces = 0;

  while (i < movs.length && movs[i].t < fin) {
    // Los movimientos de un mismo documento se aplican juntos: editar o anular una compra no
    // tiene que inventar un quiebre de un instante entre una linea y la siguiente.
    const primero = movs[i];
    aplicar(movs[i++]);
    while (primero.ref && i < movs.length && movs[i].t < fin && movs[i].ref === primero.ref
           && new Date(movs[i].t) - new Date(primero.t) < 60000) aplicar(movs[i++]);
    mirarNegativos();
    const ahoraSin = saldo <= EPS_STOCK;
    if (ahoraSin && !sinStock) { veces++; episodios.push({ desde: primero.t, hasta: null }); }
    else if (!ahoraSin && sinStock && episodios.length) episodios[episodios.length - 1].hasta = primero.t;
    sinStock = ahoraSin;
  }

  // Dias sin stock = dias de calendario que TERMINARON sin stock (hoy: si sigue sin stock ahora).
  // Quebrar y reponer en el mismo dia suma una vez, pero no un dia.
  // Episodios y cierres vienen en orden: un solo recorrido de cada lista.
  let dias = 0, racha = 0, seguidos = 0, e = 0;
  for (const cierre of episodios.length ? cierres : []) {
    while (e < episodios.length && episodios[e].hasta !== null && episodios[e].hasta < cierre) e++;
    if (e < episodios.length && episodios[e].desde < cierre) {
      dias++; seguidos++; racha = Math.max(racha, seguidos);
    } else seguidos = 0;
  }
  return { veces, venia, dias, racha, negativos, huboQuiebre: episodios.length > 0 };
}

/** Medianoche local del primer dia de "los ultimos N dias" (hoy incluido). */
export function inicioUltimosDias(dias) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (dias - 1));
  return d.toISOString();
}

/**
 * Devuelve una funcion (ids) -> dias sin stock en los ultimos N dias del producto, o de la suma de
 * varios (grupo). null = no se puede saber (nunca tuvo stock ni movimientos).
 */
export function crearCalculadorSinStock(sucursalId, dias = 30) {
  const inicioHist = inicioHistorial(sucursalId);
  const desde = inicioUltimosDias(dias);
  const ini = inicioHist && inicioHist > desde ? inicioHist : desde;
  const fin = new Date().toISOString();
  const cierres = cierresDeDias(ini, fin);

  return (ids) => {
    if (!inicioHist || !ids.length) return null;
    const marcas = ids.map(() => '?').join(',');
    const movs = window.SGA_DB.query(`
      SELECT id, producto_id, delta, ref_id, fecha FROM stock_movimientos
       WHERE sucursal_id = ? AND producto_id IN (${marcas}) ORDER BY fecha, rowid`,
      [sucursalId, ...ids]).map(m => leerMovimiento(m, inicioHist));
    if (!movs.length && !window.SGA_DB.query(
      `SELECT 1 AS x FROM stock WHERE sucursal_id = ? AND producto_id IN (${marcas}) LIMIT 1`,
      [sucursalId, ...ids]).length) return null;
    movs.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    const altas = window.SGA_DB.query(
      `SELECT fecha_alta FROM productos WHERE id IN (${marcas})`, ids);
    const nuevo = altas.length > 0 && altas.every(p => !!p.fecha_alta && new Date(p.fecha_alta) > new Date(ini));
    return analizarQuiebres(movs, ini, fin, cierres, nuevo).dias;
  };
}
