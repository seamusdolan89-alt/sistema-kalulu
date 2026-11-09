/**
 * informes.js — Reports Module
 */

import GruposSustitutos from './grupos_sustitutos.js';
import Buscador from './buscador_productos.js';
// Import estatico (no window.SGA_Familia), igual que compras_v2.js/editor-producto.js/
// operaciones_stock.js: el wizard de familia se abre tambien desde "Precios y Etiquetas".
import Familia from './familia.js';

const Informes = (() => {
  'use strict';

  const REPORTES = [
    { id: 'ventas_producto',    label: 'Ventas por Producto' },
    { id: 'analitica_producto', label: 'Análisis de Productos' },
    { id: 'ventas_transaccion', label: 'Ventas por Transacción' },
    { id: 'quiebres_stock',     label: 'Quiebres de Stock' },
    { id: 'ventas_vendedor',    label: 'Ventas por Vendedor' },
    { id: 'aging_cc',           label: 'Aging Cuenta Corriente' },
    { id: 'resumen_diario',     label: 'Resumen Diario de Caja' },
    { id: 'stock_muerto',       label: 'Stock sin Movimiento' },
    { id: 'salidas_stock',      label: 'Salidas de Stock (no venta)' },
    { id: 'sustitutos_grupos',  label: 'Grupos de Sustitutos' },
    { id: 'precios_etiquetas',  label: 'Precios y Etiquetas' },
  ];

  // can_informes (ruta) es el acceso a la SECCIÓN; cada id de REPORTES tiene
  // además su propio permiso 'can_informes_<id>' (ver auth.js) — el admin
  // (rol='admin') siempre puede todo via SGA_Permisos.can(). Pedido explícito
  // del usuario (21/10/2026): poder elegir qué informes ve cada usuario.
  const reportesPermitidos = () =>
    REPORTES.filter(r => window.SGA_Permisos?.can('can_informes_' + r.id));

  const TIPO_SALIDA_LABEL = {
    consumo:     'Consumo Interno',
    rotura:      'Rotura',
    vencimiento: 'Vencimiento',
  };

  const MEDIO_LABEL = {
    efectivo: 'Efectivo', mercadopago: 'MP', tarjeta: 'Tarjeta',
    transferencia: 'Transf.', cuenta_corriente: 'Cta.Cte.',
  };

  const state = {
    reporte: 'ventas_producto',
    desde: '',
    hasta: '',
    sucursalId: null,
    user: null,
    data: null,
    diasSinMovimiento: 90,
    diasSinModificarPrecio: 90, // 0 = todos los productos (sin filtrar)
    ventasDiasPrecio: 90,       // "Precios y Etiquetas": ventana (en días) de la columna "Cant. vendida"
    soloConStockPrecio: false,  // "Precios y Etiquetas": ocultar productos sin stock
    tipoSalida: 'todos', // 'todos' | 'consumo' | 'rotura' | 'vencimiento'
    sustMostrarSinGrupo: false, // informe "Grupos de Sustitutos": filtro de productos sin grupo
    sustFiltroTexto: '', // informe "Grupos de Sustitutos": filtro por nombre/código
    mobilePeriod: 'mes', // 'hoy' | 'semana' | 'mes' | 'elegir-mes' — solo Admin-POS mobile
  };

  const ge  = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmtPeso = (n) => window.SGA_Utils.formatCurrency(n);
  const fmtNum  = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

  // ── DATE HELPERS ──────────────────────────────────────────────────────────────

  function defaultDesde() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  function defaultHasta() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function addOneDay(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Local midnight → UTC ISO string for correct date-boundary filtering
  function toUTC(dateStr) {
    return new Date(dateStr + 'T00:00:00').toISOString();
  }

  function fmtFechaCorta(isoStr) {
    if (!isoStr) return '—';
    const [y, m, d] = isoStr.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }

  function fmtPeriodo() {
    return `${fmtFechaCorta(state.desde)} al ${fmtFechaCorta(state.hasta)}`;
  }

  function daysSince(isoStr) {
    if (!isoStr) return null;
    return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
  }

  // ── QUERIES ───────────────────────────────────────────────────────────────────

  function queryVentasProducto() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        p.id,
        COALESCE((SELECT codigo FROM codigos_barras
                  WHERE producto_id = p.id AND es_principal = 1 LIMIT 1), '') AS codigo,
        p.nombre,
        COALESCE(cat.nombre, '') AS categoria,
        COALESCE(pr.razon_social, '') AS proveedor,
        p.costo AS costo_actual,
        p.precio_venta AS precio_actual,
        COALESCE(s.cantidad, 0) AS stock_actual,
        p.stock_minimo,
        SUM(vi.cantidad) AS cant_vendida,
        SUM(vi.cantidad * vi.costo_unitario) AS costo_total,
        SUM(vi.subtotal) AS venta_total,
        SUM(vi.subtotal) - SUM(vi.cantidad * vi.costo_unitario) AS utilidad,
        CASE WHEN SUM(vi.subtotal) > 0
          THEN ROUND((SUM(vi.subtotal) - SUM(vi.cantidad * vi.costo_unitario)) * 100.0 / SUM(vi.subtotal), 1)
          ELSE 0
        END AS margen_pct
      FROM venta_items vi
      JOIN ventas v ON vi.venta_id = v.id
        AND v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      JOIN productos p ON vi.producto_id = p.id
      LEFT JOIN categorias cat ON p.categoria_id = cat.id
      LEFT JOIN proveedores pr ON p.proveedor_principal_id = pr.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      GROUP BY p.id
      ORDER BY venta_total DESC
    `, [sid, desde, hasta, sid]);
  }

  function queryVentasTransaccion() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        v.id,
        v.fecha,
        COALESCE(u.nombre, 'Sistema') AS vendedor,
        v.subtotal,
        v.descuento,
        v.total,
        COALESCE(c.nombre || ' ' || c.apellido, '') AS cliente,
        v.cliente_id,
        GROUP_CONCAT(vp.medio || ':' || vp.monto, '|') AS pagos_raw
      FROM ventas v
      LEFT JOIN usuarios u ON v.usuario_id = u.id
      LEFT JOIN clientes c ON v.cliente_id = c.id
      LEFT JOIN venta_pagos vp ON vp.venta_id = v.id
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY v.id
      ORDER BY v.fecha DESC
    `, [sid, desde, hasta]);
  }

  function queryQuiebresStock() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        p.id,
        COALESCE((SELECT codigo FROM codigos_barras
                  WHERE producto_id = p.id AND es_principal = 1 LIMIT 1), '') AS codigo,
        p.nombre,
        COALESCE(pr.razon_social, '') AS proveedor,
        COALESCE(s.cantidad, 0) AS stock_actual,
        p.stock_minimo,
        SUM(oci.cantidad_pedida) AS total_pedido,
        COALESCE(SUM(oci.cantidad_recibida), 0) AS total_recibido_orden,
        COUNT(DISTINCT oc.id) AS num_ordenes,
        (
          SELECT COALESCE(SUM(ci2.cantidad), 0)
          FROM compra_items ci2
          JOIN compras c2 ON ci2.compra_id = c2.id
          WHERE ci2.producto_id = p.id
            AND c2.sucursal_id = ?
            AND COALESCE(c2.estado,'confirmada') != 'anulada'
            AND c2.fecha >= ? AND c2.fecha < ?
        ) AS recibido_compras,
        (
          SELECT COUNT(*) FROM producto_sustitutos ps
          WHERE ps.producto_id = p.id
        ) AS tiene_sustituto
      FROM orden_compra_items oci
      JOIN ordenes_compra oc ON oci.orden_id = oc.id
        AND oc.sucursal_id = ?
        AND oc.fecha_creacion >= ? AND oc.fecha_creacion < ?
        AND oc.estado NOT IN ('borrador')
      JOIN productos p ON oci.producto_id = p.id
      LEFT JOIN proveedores pr ON p.proveedor_principal_id = pr.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      GROUP BY p.id
      HAVING recibido_compras = 0
      ORDER BY tiene_sustituto ASC, stock_actual ASC, p.nombre
    `, [sid, desde, hasta, sid, desde, hasta, sid]);
  }

  function queryVentasVendedor() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;

    const ventas = window.SGA_DB.query(`
      SELECT
        u.id,
        u.nombre AS vendedor,
        COUNT(DISTINCT v.id) AS num_ventas,
        SUM(v.subtotal) AS subtotal_bruto,
        SUM(COALESCE(v.descuento, 0)) AS descuentos,
        SUM(v.total) AS total_ventas
      FROM ventas v
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY u.id
      ORDER BY total_ventas DESC
    `, [sid, desde, hasta]);

    const devs = window.SGA_DB.query(`
      SELECT
        v_orig.usuario_id,
        SUM(di.cantidad * di.precio_unitario) AS total_devuelto,
        COUNT(DISTINCT d.id) AS num_devoluciones
      FROM devoluciones d
      JOIN devolucion_items di ON di.devolucion_id = d.id
      JOIN ventas v_orig ON d.venta_id = v_orig.id
      WHERE d.fecha >= ? AND d.fecha < ?
        AND d.sucursal_id = ?
      GROUP BY v_orig.usuario_id
    `, [desde, hasta, sid]);

    const devMap = {};
    devs.forEach(r => { devMap[r.usuario_id] = r; });

    return ventas.map(r => ({
      ...r,
      total_devuelto:    devMap[r.id]?.total_devuelto    || 0,
      num_devoluciones:  devMap[r.id]?.num_devoluciones  || 0,
      total_neto: r.total_ventas - (devMap[r.id]?.total_devuelto || 0),
    }));
  }

  function queryAgingCC() {
    const sid = state.sucursalId;
    return window.SGA_DB.query(`
      SELECT
        c.id,
        c.nombre,
        c.apellido,
        COALESCE(c.telefono, '') AS telefono,
        COALESCE(c.tope_deuda, 0) AS tope_deuda,
        SUM(cc.monto) AS balance,
        MIN(CASE WHEN cc.tipo = 'venta_fiada' THEN cc.fecha END) AS primera_deuda,
        MAX(CASE WHEN cc.tipo = 'venta_fiada' THEN cc.fecha END) AS ultima_compra,
        MAX(CASE WHEN cc.tipo = 'pago'        THEN cc.fecha END) AS ultimo_pago
      FROM clientes c
      JOIN cuenta_corriente cc ON cc.cliente_id = c.id AND cc.sucursal_id = ?
      GROUP BY c.id
      HAVING balance > 0.01
      ORDER BY balance DESC
    `, [sid]);
  }

  // Resumen diario de CAJA: todo lo que entro cada dia, con su origen y por medio, para que coincida
  // con las cajas del sistema y con el reporte de cada medio (ej. el de MercadoPago). Tres fuentes:
  //   - venta_pagos: lo que pago cada venta (SIN el fiado ni el saldo a favor que el cliente ya tenia:
  //     no son plata que entra hoy);
  //   - ingresos_caja: cobranza de deuda, vuelto que el cliente dejo a favor y otros ingresos, por
  //     el medio con que se cobraron (antes este reporte los ignoraba y no cerraba contra la caja);
  //   - egresos_caja: lo que salio del cajon.
  function queryResumenDiario() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;
    // El dia es el LOCAL, no el UTC de la fecha guardada: una venta de las 22:00 es de ese dia aunque
    // en UTC ya sea el siguiente. Asi cada dia se compara contra el reporte del medio.
    const dia = col => `SUBSTR(DATETIME(${col}, 'localtime'), 1, 10)`;

    const ventas = window.SGA_DB.query(`
      SELECT ${dia('v.fecha')} AS dia, vp.medio AS medio, SUM(vp.monto) AS monto
      FROM ventas v
      JOIN venta_pagos vp ON vp.venta_id = v.id
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY ${dia('v.fecha')}, vp.medio
    `, [sid, desde, hasta]);

    const nVentas = window.SGA_DB.query(`
      SELECT ${dia('v.fecha')} AS dia, COUNT(*) AS n
      FROM ventas v
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY ${dia('v.fecha')}
    `, [sid, desde, hasta]);

    const ingresos = window.SGA_DB.query(`
      SELECT ${dia('i.fecha')} AS dia, COALESCE(i.medio, 'efectivo') AS medio,
             COALESCE(i.tipo, '') AS tipo, SUM(i.monto) AS monto
      FROM ingresos_caja i
      JOIN sesiones_caja sc ON sc.id = i.sesion_caja_id
      WHERE sc.sucursal_id = ?
        AND i.fecha >= ? AND i.fecha < ?
      GROUP BY ${dia('i.fecha')}, COALESCE(i.medio, 'efectivo'), COALESCE(i.tipo, '')
    `, [sid, desde, hasta]);

    const egresos = window.SGA_DB.query(`
      SELECT ${dia('e.fecha')} AS dia, SUM(e.monto) AS egresos
      FROM egresos_caja e
      JOIN sesiones_caja sc ON e.sesion_caja_id = sc.id
      WHERE sc.sucursal_id = ?
        AND e.fecha >= ? AND e.fecha < ?
      GROUP BY ${dia('e.fecha')}
    `, [sid, desde, hasta]);

    // Ya está incluido dentro de cobranza_ventas/total_recibido (reduce el total
    // cobrado como cualquier otro descuento) — esto es solo para poder verlo
    // aparte y auditar que el tope (5-10%) no se esté usando de más.
    const redondeos = window.SGA_DB.query(`
      SELECT ${dia('v.fecha')} AS dia, SUM(v.descuento_redondeo) AS monto
      FROM ventas v
      WHERE v.estado = 'completada'
        AND v.sucursal_id = ?
        AND v.fecha >= ? AND v.fecha < ?
      GROUP BY ${dia('v.fecha')}
    `, [sid, desde, hasta]);

    const dias = {};
    const fila = d => dias[d] || (dias[d] = {
      dia: d, num_ventas: 0,
      cobranza_ventas: 0, cobranza_deuda: 0, vuelto_favor: 0, otros_ingresos: 0,
      efectivo: 0, mercadopago: 0, tarjeta: 0, transferencia: 0,
      // "Otros": cualquier medio_cobro custom agregado desde Configuración (ej. "Link de Pago")
      // que no sea uno de los 4 fijos. Sin este bucket esa plata sumaría al total pero no
      // aparecería en ninguna columna del desglose.
      otros: 0,
      cuenta_corriente: 0, egresos: 0, descuento_redondeo: 0,
    });
    const FIJOS = ['efectivo', 'mercadopago', 'tarjeta', 'transferencia'];
    const porMedio = (r, medio, monto) => { if (FIJOS.includes(medio)) r[medio] += monto; else r.otros += monto; };

    nVentas.forEach(x => { fila(x.dia).num_ventas = x.n; });
    ventas.forEach(x => {
      const r = fila(x.dia);
      const monto = parseFloat(x.monto) || 0;
      if (x.medio === 'cuenta_corriente') { r.cuenta_corriente += monto; return; }   // fiado: no entra plata
      if (x.medio === 'saldo_favor') return;                                          // credito que ya estaba
      r.cobranza_ventas += monto;
      porMedio(r, x.medio, monto);
    });
    ingresos.forEach(x => {
      const r = fila(x.dia);
      const monto = parseFloat(x.monto) || 0;
      if (x.tipo === 'cobro_cliente')        r.cobranza_deuda += monto;
      else if (x.tipo === 'vuelto_a_favor')  r.vuelto_favor   += monto;
      else                                   r.otros_ingresos += monto;
      porMedio(r, x.medio, monto);
    });
    egresos.forEach(x => { fila(x.dia).egresos += parseFloat(x.egresos) || 0; });
    redondeos.forEach(x => { fila(x.dia).descuento_redondeo += parseFloat(x.monto) || 0; });

    return Object.values(dias)
      .sort((a, b) => a.dia.localeCompare(b.dia))
      .map(r => {
        const total_recibido = r.cobranza_ventas + r.cobranza_deuda + r.vuelto_favor + r.otros_ingresos;
        return {
          ...r,
          total_recibido,
          neto: total_recibido - r.egresos,
          // lo que cambia el cajon en el dia: el efectivo que entro menos lo que salio
          efectivo_neto: r.efectivo - r.egresos,
        };
      });
  }

  function queryStockMuerto() {
    const sid    = state.sucursalId;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - state.diasSinMovimiento);
    const cutoffISO = cutoff.toISOString();

    return window.SGA_DB.query(`
      SELECT
        p.id,
        COALESCE((SELECT codigo FROM codigos_barras
                  WHERE producto_id = p.id AND es_principal = 1 LIMIT 1), '') AS codigo,
        p.nombre,
        COALESCE(cat.nombre, '') AS categoria,
        COALESCE(pr.razon_social, '') AS proveedor,
        COALESCE(s.cantidad, 0) AS stock_actual,
        p.costo,
        COALESCE(s.cantidad, 0) * p.costo AS costo_inmovilizado,
        MAX(v.fecha) AS ultima_venta
      FROM productos p
      LEFT JOIN categorias cat ON p.categoria_id = cat.id
      LEFT JOIN proveedores pr ON p.proveedor_principal_id = pr.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      LEFT JOIN venta_items vi ON vi.producto_id = p.id
      LEFT JOIN ventas v ON vi.venta_id = v.id
        AND v.estado = 'completada'
        AND v.sucursal_id = ?
      WHERE COALESCE(s.cantidad, 0) > 0
      GROUP BY p.id
      HAVING MAX(v.fecha) IS NULL OR MAX(v.fecha) < ?
      ORDER BY costo_inmovilizado DESC, ultima_venta ASC
    `, [sid, sid, cutoffISO]);
  }

  // Días sin modificar precio/costo: mismo dato (ultima_modificacion_precio)
  // que ya se actualiza en Compras, Editor de Producto, Familia y Operaciones
  // de Stock cada vez que cambia costo o precio_venta — no hace falta
  // trackear nada nuevo, solo mostrarlo. diasSinModificarPrecio = 0 muestra
  // TODOS los productos (sin filtrar), para ver el listado completo con sus
  // dos fechas sin importar cuándo fue el último cambio.
  //
  // Revisión de precios (pedido del usuario, 6/11/2026): además de las fechas,
  // cruza stock, unidades vendidas en una ventana de días, y la última compra
  // CONFIRMADA y no anulada (con si cambió el costo en esa compra y si el
  // precio se tocó desde entonces). `todos = true` ignora los filtros de
  // pantalla (días sin modificar y "solo con stock") para exportar el catálogo
  // completo. Orden por defecto = prioridad de revisión: con stock primero,
  // dentro de eso lo que más se vende.
  //
  // "Precio modificado desde esa compra" es una aproximación a propósito:
  // el sistema no guarda qué precio cambió en cada compra, solo la fecha del
  // último cambio de precio del producto (ultima_modificacion_precio).
  function queryPreciosEtiquetas(todos = false) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - state.diasSinModificarPrecio);
    const cutoffISO = cutoff.toISOString();
    const sinFiltro = todos || state.diasSinModificarPrecio === 0;
    const soloStock = !todos && state.soloConStockPrecio;
    const desdeVentas = new Date(Date.now() - state.ventasDiasPrecio * 86400000).toISOString();
    const sid = state.sucursalId;

    return window.SGA_DB.query(`
      SELECT
        p.id,
        COALESCE((SELECT codigo FROM codigos_barras
                  WHERE producto_id = p.id AND es_principal = 1 LIMIT 1), '') AS codigo,
        (SELECT GROUP_CONCAT(codigo, ';') FROM (
           SELECT codigo FROM codigos_barras WHERE producto_id = p.id
           ORDER BY es_principal DESC, codigo ASC)) AS todos_codigos,
        p.nombre,
        COALESCE(cat.nombre, '') AS categoria,
        COALESCE(pr.razon_social, '') AS proveedor,
        p.costo,
        p.markup_fijo,
        COALESCE(s.cantidad, 0) AS stock_actual,
        COALESCE(vt.cant, 0) AS cant_vendida,
        lc.fecha AS compra_fecha,
        lci.costo_modificado AS compra_costo_modificado,
        lci.costo_anterior AS compra_costo_anterior,
        lci.costo_unitario AS compra_costo,
        p.precio_venta,
        p.ultima_modificacion_precio,
        p.ultima_impresion_etiqueta,
        -- Misma condición que "Etiquetas sugeridas" (etiquetas.js): el precio
        -- cambió después de la última impresión, o nunca se imprimió. El
        -- REPLACE normaliza las marcas viejas guardadas con espacio en vez
        -- de T (ver CLAUDE.md, "etiquetas: auditoría de impresión...").
        CASE WHEN p.ultima_impresion_etiqueta IS NULL
                  OR p.ultima_modificacion_precio > REPLACE(p.ultima_impresion_etiqueta, ' ', 'T')
             THEN 1 ELSE 0 END AS pendiente_imprimir
      FROM productos p
      LEFT JOIN categorias cat ON p.categoria_id = cat.id
      LEFT JOIN proveedores pr ON p.proveedor_principal_id = pr.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      LEFT JOIN (
        SELECT vi.producto_id, SUM(vi.cantidad) AS cant
        FROM venta_items vi
        JOIN ventas v ON v.id = vi.venta_id
          AND v.estado = 'completada' AND v.sucursal_id = ? AND v.fecha >= ?
        GROUP BY vi.producto_id
      ) vt ON vt.producto_id = p.id
      LEFT JOIN compra_items lci ON lci.id = (
        SELECT ci.id FROM compra_items ci
        JOIN compras c ON c.id = ci.compra_id
        WHERE ci.producto_id = p.id
          AND c.anulada_en IS NULL
          AND COALESCE(c.estado, 'confirmada') = 'confirmada'
          AND COALESCE(ci.tipo, 'producto') = 'producto'
        ORDER BY c.fecha DESC, c.updated_at DESC LIMIT 1)
      LEFT JOIN compras lc ON lc.id = lci.compra_id
      WHERE p.activo = 1
        AND (? OR p.ultima_modificacion_precio IS NULL OR p.ultima_modificacion_precio < ?)
        AND (? = 0 OR COALESCE(s.cantidad, 0) > 0)
      ORDER BY (COALESCE(s.cantidad, 0) > 0) DESC, COALESCE(vt.cant, 0) DESC,
               COALESCE(s.cantidad, 0) DESC, p.nombre
    `, [sid, sid, desdeVentas, sinFiltro ? 1 : 0, cutoffISO, soloStock ? 1 : 0]);
  }

  // ── Precios y Etiquetas: cálculos derivados (los usan la pantalla y el export) ──

  const puedeVerCostos     = () => !!window.SGA_Permisos?.can('can_ver_costos');
  const puedeEditarPrecios = () => !!window.SGA_Permisos?.can('can_editar_productos');

  // true / false / null (null = nunca se compró). Aproximación: ver comentario
  // de queryPreciosEtiquetas().
  function precioTocadoDesdeCompra(r) {
    if (!r.compra_fecha) return null;
    return !!(r.ultima_modificacion_precio &&
              r.ultima_modificacion_precio.slice(0, 10) >= r.compra_fecha.slice(0, 10));
  }

  // Costo cambió en la última compra y el precio no se tocó desde entonces.
  function precioAtrasado(r) {
    return !!r.compra_costo_modificado && precioTocadoDesdeCompra(r) === false;
  }

  function margenPct(costo, precio) {
    const c = parseFloat(costo) || 0, p = parseFloat(precio) || 0;
    if (p <= 0 || c <= 0) return null;
    return (p - c) / p * 100;
  }

  function querySalidasStock() {
    const desde = toUTC(state.desde);
    const hasta = toUTC(addOneDay(state.hasta));
    const sid   = state.sucursalId;

    let tipoFilter = '';
    if (state.tipoSalida === 'consumo')     tipoFilter = `AND ci.motivo NOT IN ('rotura','vencimiento')`;
    else if (state.tipoSalida === 'rotura')      tipoFilter = `AND ci.motivo = 'rotura'`;
    else if (state.tipoSalida === 'vencimiento') tipoFilter = `AND ci.motivo = 'vencimiento'`;

    return window.SGA_DB.query(`
      SELECT
        u.id AS usuario_id,
        u.nombre AS usuario,
        COUNT(*) AS num_movimientos,
        SUM(ci.cantidad) AS cantidad_total,
        SUM(ci.cantidad * ci.costo_unitario) AS costo_total,
        SUM(ci.cantidad * ci.precio_venta_unitario) AS venta_total,
        SUM(CASE WHEN ci.motivo NOT IN ('rotura','vencimiento') THEN ci.cantidad ELSE 0 END) AS cant_consumo,
        SUM(CASE WHEN ci.motivo = 'rotura' THEN ci.cantidad ELSE 0 END) AS cant_rotura,
        SUM(CASE WHEN ci.motivo = 'vencimiento' THEN ci.cantidad ELSE 0 END) AS cant_vencimiento
      FROM consumo_interno ci
      JOIN usuarios u ON u.id = ci.usuario_id
      WHERE ci.sucursal_id = ?
        AND ci.fecha >= ? AND ci.fecha < ?
        ${tipoFilter}
      GROUP BY u.id
      ORDER BY costo_total DESC
    `, [sid, desde, hasta]);
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────

  function init() {
    state.user       = window.SGA_Auth.getCurrentUser();
    state.sucursalId = state.user?.sucursal_id || 1;
    state.desde      = defaultDesde();
    state.hasta      = defaultHasta();

    // state.reporte puede venir de una sesión anterior (otro usuario, u otro
    // permiso) — si no está entre los habilitados para ESTE usuario, se cae
    // al primero que sí lo esté (o queda sin reporte si no tiene ninguno).
    const permitidos = reportesPermitidos();
    if (!permitidos.some(r => r.id === state.reporte)) {
      state.reporte = permitidos[0]?.id || null;
    }

    const root = ge('inf-root');
    if (!root) return;

    root.innerHTML = renderShell();
    attachListeners();

    // Admin-POS mobile — ver renderShell() .inf-mobile-only. Se calcula
    // siempre (no solo si la pantalla es angosta): es CSS quien decide qué
    // bloque se ve, así que no hace falta detectar el ancho acá ni
    // recalcular en un resize.
    state.mobilePeriod = 'mes';
    setMobilePeriod('mes');
    attachMobileListeners();
  }

  // ── ADMIN-POS MOBILE: VENTAS POR VENDEDOR SIMPLIFICADO ──────────────────────

  function setMobilePeriod(period) {
    const now = new Date();
    if (period === 'hoy') {
      state.desde = defaultHasta();
      state.hasta = defaultHasta();
    } else if (period === 'semana') {
      const mon = new Date(now);
      mon.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
      state.desde = mon.toISOString().slice(0, 10);
      state.hasta = defaultHasta();
    } else if (period === 'mes') {
      state.desde = defaultDesde();
      state.hasta = defaultHasta();
    }
    state.mobilePeriod = period;
    const mesInput = ge('inf-m-mes-input');
    if (mesInput) mesInput.style.display = 'none';
    renderMobileVentasVendedor();
    syncMobileChips();
  }

  function syncMobileChips() {
    document.querySelectorAll('.inf-m-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mperiod === state.mobilePeriod);
    });
  }

  function attachMobileListeners() {
    document.querySelectorAll('.inf-m-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mperiod === 'elegir-mes') {
          const input = ge('inf-m-mes-input');
          if (!input) return;
          const now = new Date();
          input.max = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          if (!input.value) input.value = input.max;
          input.style.display = 'block';
          input.focus();
          return; // el período se fija recién con el 'change' del mes elegido
        }
        setMobilePeriod(btn.dataset.mperiod);
      });
    });

    ge('inf-m-mes-input')?.addEventListener('change', (e) => {
      if (!e.target.value) return;
      const [y, m] = e.target.value.split('-').map(Number);
      const first   = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastStr = new Date(y, m, 0).toISOString().slice(0, 10); // día 0 del mes siguiente = último día de este
      const todayStr = defaultHasta();
      state.desde = first;
      state.hasta = lastStr > todayStr ? todayStr : lastStr; // nunca pedir fechas futuras
      state.mobilePeriod = 'elegir-mes';
      renderMobileVentasVendedor();
      syncMobileChips();
    });

    syncMobileChips();
  }

  function renderMobileVentasVendedor() {
    const kpisEl = ge('inf-m-kpis');
    const vendEl = ge('inf-m-vendedores');
    if (!kpisEl || !vendEl) return;

    // queryVentasVendedor() lee state.desde/state.hasta/state.sucursalId —
    // misma función y misma fórmula que el reporte de escritorio, nada
    // nuevo que calcular acá.
    const rows = queryVentasVendedor();
    const totNeto = rows.reduce((s, r) => s + (r.total_neto || 0), 0);
    const totTxns = rows.reduce((s, r) => s + (r.num_ventas || 0), 0);
    const ticketProm = totTxns ? totNeto / totTxns : 0;

    kpisEl.innerHTML = `
      <div class="inf-m-kpi inf-m-kpi-wide"><div class="l">Total neto</div><div class="v">${fmtPeso(totNeto)}</div></div>
      <div class="inf-m-kpi"><div class="l">Transacciones</div><div class="v">${fmtNum(totTxns)}</div></div>
      <div class="inf-m-kpi"><div class="l">Ticket prom.</div><div class="v">${fmtPeso(ticketProm)}</div></div>
    `;

    if (!rows.length) {
      vendEl.innerHTML = `
        <div class="inf-empty-state">
          <div class="inf-empty-icon">📊</div>
          <p>Sin ventas en este período.</p>
        </div>`;
      return;
    }

    vendEl.innerHTML = rows.map(r => {
      const ticket = r.num_ventas ? r.total_neto / r.num_ventas : 0;
      return `
        <div class="inf-m-vend-card">
          <div>
            <div class="nombre">${esc(r.vendedor)}</div>
            <div class="tx">${fmtNum(r.num_ventas)} venta${r.num_ventas !== 1 ? 's' : ''}</div>
          </div>
          <div class="amt">
            <div class="neto">${fmtPeso(r.total_neto)}</div>
            <div class="tick">tkt ${fmtPeso(ticket)}</div>
          </div>
        </div>`;
    }).join('');
  }

  function renderShell() {
    const permitidos = reportesPermitidos();
    if (!permitidos.length) {
      return `
        <div class="inf-toolbar">
          <h2 class="inf-title">📊 Informes</h2>
        </div>
        <div id="inf-results" class="inf-results-area">
          <div class="inf-empty-state">
            <div class="inf-empty-icon">📊</div>
            <p>No tenés ningún informe habilitado. Pedile al administrador que te habilite alguno desde Usuarios.</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="inf-toolbar">
        <h2 class="inf-title">📊 Informes</h2>
        <div class="inf-toolbar-controls">
          <div class="inf-control-group">
            <label>Reporte</label>
            <select id="inf-sel-reporte" class="inf-select">
              ${permitidos.map(r => `<option value="${r.id}"${r.id === state.reporte ? ' selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </div>
          <div class="inf-control-group">
            <label>Desde</label>
            <input type="date" id="inf-desde" class="inf-date" value="${state.desde}">
          </div>
          <div class="inf-control-group">
            <label>Hasta</label>
            <input type="date" id="inf-hasta" class="inf-date" value="${state.hasta}">
          </div>
          <div class="inf-quick-btns">
            <button class="btn btn-xs" data-period="week">Sem.</button>
            <button class="btn btn-xs" data-period="month">Este mes</button>
            <button class="btn btn-xs" data-period="prev-month">Mes ant.</button>
            <button class="btn btn-xs" data-period="year">Este año</button>
          </div>
          <button id="inf-btn-generar" class="btn btn-primary">Generar</button>
        </div>
      </div>
      <div id="inf-extra-bar"></div>
      <div id="inf-results" class="inf-results-area">
        <div class="inf-empty-state">
          <div class="inf-empty-icon">📊</div>
          <p>Seleccioná un reporte y período, luego presioná <strong>Generar</strong>.</p>
        </div>
      </div>

      <!-- Admin-POS mobile: un solo reporte, sin selector — ver CSS
           .inf-mobile-only (BACKLOG.md, "Admin-POS responsive"). -->
      <div class="inf-mobile-only">
        <div class="inf-m-header"><h2>📊 Ventas por Vendedor</h2></div>
        <div class="inf-m-periods">
          <button class="inf-m-chip" data-mperiod="hoy">Hoy</button>
          <button class="inf-m-chip" data-mperiod="semana">Esta semana</button>
          <button class="inf-m-chip" data-mperiod="mes">Este mes</button>
          <button class="inf-m-chip" data-mperiod="elegir-mes">Elegir mes</button>
        </div>
        <input type="month" id="inf-m-mes-input" class="inf-m-mes-input">
        <div id="inf-m-kpis" class="inf-m-kpis"></div>
        <div id="inf-m-vendedores" class="inf-m-vendedores"></div>
      </div>
    `;
  }

  function updateExtraBar() {
    const bar = ge('inf-extra-bar');
    if (!bar) return;
    if (state.reporte === 'stock_muerto') {
      bar.innerHTML = `
        <div class="inf-extra-bar-inner">
          <label>Días sin movimiento</label>
          <select id="inf-dias-sin-mov" class="inf-select" style="min-width:120px">
            ${[30,60,90,180,365].map(d =>
              `<option value="${d}"${d === state.diasSinMovimiento ? ' selected' : ''}>${d} días</option>`
            ).join('')}
          </select>
        </div>
      `;
      ge('inf-dias-sin-mov')?.addEventListener('change', e => {
        state.diasSinMovimiento = Number(e.target.value);
      });
    } else if (state.reporte === 'precios_etiquetas') {
      bar.innerHTML = `
        <div class="inf-extra-bar-inner">
          <label>Sin cambios de precio</label>
          <select id="inf-dias-sin-precio" class="inf-select" style="min-width:180px">
            <option value="0"${state.diasSinModificarPrecio === 0 ? ' selected' : ''}>Todos los productos</option>
            ${[30,60,90,180,365].map(d =>
              `<option value="${d}"${d === state.diasSinModificarPrecio ? ' selected' : ''}>Hace ${d}+ días</option>`
            ).join('')}
          </select>
          <label style="margin-left:16px">Ventas de los últimos</label>
          <select id="inf-dias-ventas-precio" class="inf-select" style="min-width:110px">
            ${[30,60,90,180,365].map(d =>
              `<option value="${d}"${d === state.ventasDiasPrecio ? ' selected' : ''}>${d} días</option>`
            ).join('')}
          </select>
          <label style="margin-left:16px;display:inline-flex;align-items:center;gap:6px">
            <input type="checkbox" id="inf-solo-stock-precio"${state.soloConStockPrecio ? ' checked' : ''}>
            Solo con stock
          </label>
        </div>
      `;
      ge('inf-dias-sin-precio')?.addEventListener('change', e => {
        state.diasSinModificarPrecio = Number(e.target.value);
      });
      ge('inf-dias-ventas-precio')?.addEventListener('change', e => {
        state.ventasDiasPrecio = Number(e.target.value);
      });
      ge('inf-solo-stock-precio')?.addEventListener('change', e => {
        state.soloConStockPrecio = e.target.checked;
      });
    } else if (state.reporte === 'salidas_stock') {
      bar.innerHTML = `
        <div class="inf-extra-bar-inner">
          <label>Tipo de salida</label>
          <select id="inf-tipo-salida" class="inf-select" style="min-width:160px">
            <option value="todos"${state.tipoSalida === 'todos' ? ' selected' : ''}>Todos</option>
            <option value="consumo"${state.tipoSalida === 'consumo' ? ' selected' : ''}>Consumo Interno</option>
            <option value="rotura"${state.tipoSalida === 'rotura' ? ' selected' : ''}>Rotura</option>
            <option value="vencimiento"${state.tipoSalida === 'vencimiento' ? ' selected' : ''}>Vencimiento</option>
          </select>
        </div>
      `;
      ge('inf-tipo-salida')?.addEventListener('change', e => {
        state.tipoSalida = e.target.value;
      });
    } else if (state.reporte === 'aging_cc') {
      bar.innerHTML = `
        <div class="inf-extra-bar-inner" style="font-size:13px;color:var(--color-text-secondary)">
          Este reporte no usa filtro de período — muestra el estado actual de todas las cuentas corrientes con saldo deudor.
        </div>
      `;
    } else {
      bar.innerHTML = '';
    }
  }

  function attachListeners() {
    ge('inf-btn-generar')?.addEventListener('click', generar);
    ge('inf-sel-reporte')?.addEventListener('change', e => {
      state.reporte = e.target.value;
      updateExtraBar();
    });
    ge('inf-desde')?.addEventListener('change', e => { state.desde = e.target.value; });
    ge('inf-hasta')?.addEventListener('change', e => { state.hasta = e.target.value; });
    document.querySelectorAll('[data-period]').forEach(btn => {
      btn.addEventListener('click', () => setQuickPeriod(btn.dataset.period));
    });
  }

  function setQuickPeriod(period) {
    const now = new Date();
    if (period === 'week') {
      const mon = new Date(now);
      mon.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
      state.desde = mon.toISOString().slice(0, 10);
      state.hasta = now.toISOString().slice(0, 10);
    } else if (period === 'month') {
      state.desde = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      state.hasta = defaultHasta();
    } else if (period === 'prev-month') {
      const pm     = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const pmLast = new Date(now.getFullYear(), now.getMonth(), 0);
      state.desde  = pm.toISOString().slice(0, 10);
      state.hasta  = pmLast.toISOString().slice(0, 10);
    } else if (period === 'year') {
      state.desde = `${now.getFullYear()}-01-01`;
      state.hasta = defaultHasta();
    }
    if (ge('inf-desde')) ge('inf-desde').value = state.desde;
    if (ge('inf-hasta')) ge('inf-hasta').value = state.hasta;
    generar();
  }

  function generar() {
    const resultsEl = ge('inf-results');
    if (!resultsEl) return;

    state.reporte = ge('inf-sel-reporte')?.value || state.reporte;
    state.desde   = ge('inf-desde')?.value       || state.desde;
    state.hasta   = ge('inf-hasta')?.value        || state.hasta;

    const needsPeriod = !['aging_cc', 'stock_muerto', 'sustitutos_grupos', 'precios_etiquetas'].includes(state.reporte);
    if (needsPeriod && (!state.desde || !state.hasta)) {
      resultsEl.innerHTML = `<div class="inf-error">Seleccioná el período completo.</div>`;
      return;
    }
    if (needsPeriod && state.desde > state.hasta) {
      resultsEl.innerHTML = `<div class="inf-error">La fecha de inicio debe ser anterior o igual a la fecha de fin.</div>`;
      return;
    }

    resultsEl.innerHTML = `<div class="inf-loading">Generando reporte...</div>`;

    setTimeout(() => {
      try {
        switch (state.reporte) {
          case 'ventas_producto':
            state.data = queryVentasProducto();
            resultsEl.innerHTML = renderVentasProducto(state.data);
            break;
          case 'analitica_producto':
            state.data = queryVentasProducto();
            resultsEl.innerHTML = renderAnaliticaProductos(state.data);
            break;
          case 'ventas_transaccion':
            state.data = queryVentasTransaccion();
            resultsEl.innerHTML = renderVentasTransaccion(state.data);
            break;
          case 'quiebres_stock':
            state.data = queryQuiebresStock();
            resultsEl.innerHTML = renderQuiebresStock(state.data);
            break;
          case 'ventas_vendedor':
            state.data = queryVentasVendedor();
            resultsEl.innerHTML = renderVentasVendedor(state.data);
            break;
          case 'aging_cc':
            state.data = queryAgingCC();
            resultsEl.innerHTML = renderAgingCC(state.data);
            break;
          case 'resumen_diario':
            state.data = queryResumenDiario();
            resultsEl.innerHTML = renderResumenDiario(state.data);
            break;
          case 'stock_muerto':
            state.data = queryStockMuerto();
            resultsEl.innerHTML = renderStockMuerto(state.data);
            break;
          case 'salidas_stock':
            state.data = querySalidasStock();
            resultsEl.innerHTML = renderSalidasStock(state.data);
            break;
          case 'sustitutos_grupos':
            state.data = queryGruposSustitutos();
            resultsEl.innerHTML = renderGruposSustitutos(state.data);
            break;
          case 'precios_etiquetas':
            state.data = queryPreciosEtiquetas();
            resultsEl.innerHTML = renderPreciosEtiquetas(state.data);
            break;
          default:
            resultsEl.innerHTML = `<div class="inf-error">Reporte no reconocido.</div>`;
        }
        attachExportListeners();
      } catch (e) {
        console.error('[Informes]', e);
        resultsEl.innerHTML = `<div class="inf-error">Error al generar el reporte: ${esc(e.message)}</div>`;
      }
    }, 0);
  }

  // ── SHARED COMPONENTS ─────────────────────────────────────────────────────────

  function reportHeader(titulo, sinExport = false) {
    const exportBtns = sinExport ? '' : `
      <div class="inf-export-btns">
        <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
        <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
      </div>
    `;
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>${esc(titulo)}</h3>
          <span class="inf-periodo">Período: ${esc(fmtPeriodo())}</span>
        </div>
        ${exportBtns}
      </div>
    `;
  }

  // ── REPORT 1: Ventas por Producto ─────────────────────────────────────────────

  function renderVentasProducto(rows) {
    const tot = rows.reduce((acc, r) => ({
      cant:     acc.cant     + (r.cant_vendida || 0),
      costo:    acc.costo    + (r.costo_total  || 0),
      venta:    acc.venta    + (r.venta_total  || 0),
      utilidad: acc.utilidad + (r.utilidad     || 0),
    }), { cant: 0, costo: 0, venta: 0, utilidad: 0 });
    const margenTotal = tot.venta > 0 ? (tot.utilidad / tot.venta * 100).toFixed(1) : '0.0';
    return `
      ${reportHeader('Ventas por Producto')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Productos</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Unidades vendidas</div><div class="inf-kpi-value">${fmtNum(tot.cant)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Costo total</div><div class="inf-kpi-value">${fmtPeso(tot.costo)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Venta total</div><div class="inf-kpi-value">${fmtPeso(tot.venta)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Utilidad bruta</div><div class="inf-kpi-value ${tot.utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.utilidad)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Margen promedio</div><div class="inf-kpi-value">${margenTotal}%</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Código</th><th>Nombre</th><th>Categoría</th><th>Proveedor</th>
              <th class="num">Costo act.</th><th class="num">Precio act.</th>
              <th class="num">Stock act.</th><th class="num">Cant. vend.</th>
              <th class="num">Costo total</th><th class="num">Venta total</th>
              <th class="num">Utilidad</th><th class="num">Margen %</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td class="mono">${esc(r.codigo)}</td>
                  <td>${esc(r.nombre)}</td>
                  <td>${esc(r.categoria)}</td>
                  <td>${esc(r.proveedor)}</td>
                  <td class="num">${fmtPeso(r.costo_actual)}</td>
                  <td class="num">${fmtPeso(r.precio_actual)}</td>
                  <td class="num ${r.stock_actual <= 0 ? 'text-danger' : r.stock_actual <= r.stock_minimo ? 'text-warning' : ''}">${fmtNum(r.stock_actual)}</td>
                  <td class="num">${fmtNum(r.cant_vendida)}</td>
                  <td class="num">${fmtPeso(r.costo_total)}</td>
                  <td class="num bold">${fmtPeso(r.venta_total)}</td>
                  <td class="num ${r.utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(r.utilidad)}</td>
                  <td class="num">${r.margen_pct}%</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="7">TOTAL</td>
              <td class="num">${fmtNum(tot.cant)}</td>
              <td class="num">${fmtPeso(tot.costo)}</td>
              <td class="num">${fmtPeso(tot.venta)}</td>
              <td class="num ${tot.utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.utilidad)}</td>
              <td class="num">${margenTotal}%</td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT 2: Análisis de Productos ──────────────────────────────────────────

  function renderAnaliticaProductos(rows) {
    if (!rows.length) {
      return reportHeader('Análisis de Productos') +
        `<div class="inf-empty">No hay ventas en el período seleccionado.</div>`;
    }
    const totalVentas   = rows.reduce((s, r) => s + (r.venta_total || 0), 0);
    const totalCosto    = rows.reduce((s, r) => s + (r.costo_total || 0), 0);
    const utilidad      = totalVentas - totalCosto;
    const margenPct     = totalVentas > 0 ? (utilidad / totalVentas * 100).toFixed(1) : '0.0';
    const totalUnidades = rows.reduce((s, r) => s + (r.cant_vendida || 0), 0);
    const topVentas     = [...rows].sort((a, b) => b.venta_total  - a.venta_total).slice(0, 10);
    const topCantidad   = [...rows].sort((a, b) => b.cant_vendida - a.cant_vendida).slice(0, 10);
    const topMargen     = [...rows].sort((a, b) => b.margen_pct   - a.margen_pct).slice(0, 10);
    const lowMargen     = [...rows].filter(r => r.cant_vendida > 0).sort((a, b) => a.margen_pct - b.margen_pct).slice(0, 10);

    const miniTable = (data, cols) => `
      <table class="inf-table inf-table-compact">
        <thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.label}</th>`).join('')}</tr></thead>
        <tbody>
          ${data.map((r, i) => `
            <tr>
              <td class="num text-muted">${i + 1}</td>
              <td>${esc(r.nombre)}</td>
              ${cols.slice(2).map(c => `<td class="num">${c.fmt(r)}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    return `
      ${reportHeader('Análisis de Productos')}
      <div class="inf-kpi-row">
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Venta total</div><div class="inf-kpi-value">${fmtPeso(totalVentas)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Costo total</div><div class="inf-kpi-value">${fmtPeso(totalCosto)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Utilidad bruta</div><div class="inf-kpi-value ${utilidad >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(utilidad)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Margen</div><div class="inf-kpi-value">${margenPct}%</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Unidades vendidas</div><div class="inf-kpi-value">${fmtNum(totalUnidades)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Productos distintos</div><div class="inf-kpi-value">${rows.length}</div></div>
      </div>
      <div class="inf-analytics-grid">
        <div class="inf-analytics-panel">
          <h4>🏆 Mayor facturación (top 10)</h4>
          ${miniTable(topVentas, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Unid.', cls: 'num', fmt: r => fmtNum(r.cant_vendida) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
          ])}
        </div>
        <div class="inf-analytics-panel">
          <h4>📦 Más vendidos por cantidad (top 10)</h4>
          ${miniTable(topCantidad, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Unidades', cls: 'num', fmt: r => fmtNum(r.cant_vendida) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
          ])}
        </div>
        <div class="inf-analytics-panel">
          <h4>💚 Mayor rentabilidad (top 10)</h4>
          ${miniTable(topMargen, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
            { label: 'Utilidad', cls: 'num', fmt: r => fmtPeso(r.utilidad) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
          ])}
        </div>
        <div class="inf-analytics-panel">
          <h4>🔴 Menor rentabilidad (top 10)</h4>
          ${miniTable(lowMargen, [
            { label: '#', cls: 'num' }, { label: 'Producto' },
            { label: 'Margen', cls: 'num', fmt: r => r.margen_pct + '%' },
            { label: 'Utilidad', cls: 'num', fmt: r => fmtPeso(r.utilidad) },
            { label: 'Venta total', cls: 'num', fmt: r => fmtPeso(r.venta_total) },
          ])}
        </div>
      </div>
    `;
  }

  // ── REPORT 3: Ventas por Transacción ─────────────────────────────────────────

  function parsePagos(pagosRaw) {
    if (!pagosRaw) return [];
    return pagosRaw.split('|').map(p => {
      const [medio, monto] = p.split(':');
      return { medio, monto: parseFloat(monto) || 0 };
    });
  }

  function renderVentasTransaccion(rows) {
    const totSubtotal = rows.reduce((s, r) => s + (r.subtotal || 0), 0);
    const totDesc     = rows.reduce((s, r) => s + (r.descuento || 0), 0);
    const totTotal    = rows.reduce((s, r) => s + (r.total || 0), 0);
    return `
      ${reportHeader('Ventas por Transacción')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">N° de ventas</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Subtotal bruto</div><div class="inf-kpi-value">${fmtPeso(totSubtotal)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Descuentos</div><div class="inf-kpi-value text-danger">${totDesc > 0 ? '- ' + fmtPeso(totDesc) : fmtPeso(0)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Total cobrado</div><div class="inf-kpi-value">${fmtPeso(totTotal)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Ticket promedio</div><div class="inf-kpi-value">${rows.length ? fmtPeso(totTotal / rows.length) : '—'}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>N° Venta</th><th>Fecha</th><th>Hora</th><th>Vendedor</th>
              <th class="num">Subtotal</th><th class="num">Descuento</th>
              <th class="num">Total</th><th>Forma de pago</th><th>Cliente</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const fecha     = new Date(r.fecha);
                const pagosTags = parsePagos(r.pagos_raw).map(p => {
                  const cls = `mtag-${p.medio.replace(/_/g, '-')}`;
                  return `<span class="inf-medio-tag ${cls}">${esc(MEDIO_LABEL[p.medio] || p.medio)} ${fmtPeso(p.monto)}</span>`;
                }).join('');
                return `
                  <tr>
                    <td class="mono">#${esc(r.id.slice(-6))}</td>
                    <td>${fecha.toLocaleDateString('es-AR')}</td>
                    <td>${fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>${esc(r.vendedor)}</td>
                    <td class="num">${fmtPeso(r.subtotal)}</td>
                    <td class="num ${r.descuento > 0 ? 'text-danger' : ''}">${r.descuento > 0 ? '- ' + fmtPeso(r.descuento) : '—'}</td>
                    <td class="num bold">${fmtPeso(r.total)}</td>
                    <td>${pagosTags || '—'}</td>
                    <td>${r.cliente ? esc(r.cliente.trim()) : '<span class="text-muted">Consumidor final</span>'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="4">TOTAL (${rows.length} venta${rows.length !== 1 ? 's' : ''})</td>
              <td class="num">${fmtPeso(totSubtotal)}</td>
              <td class="num text-danger">${totDesc > 0 ? '- ' + fmtPeso(totDesc) : '—'}</td>
              <td class="num">${fmtPeso(totTotal)}</td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT 4: Quiebres de Stock ───────────────────────────────────────────────

  function renderQuiebresStock(rows) {
    const sinSustituto = rows.filter(r => !r.tiene_sustituto);
    const conSustituto = rows.filter(r =>  r.tiene_sustituto);
    const thead = `<thead><tr>
      <th>Código</th><th>Producto</th><th>Proveedor</th>
      <th class="num">Stock actual</th><th class="num">Stock mín.</th>
      <th class="num">Pedido (OC)</th><th class="num">Recibido</th>
      <th class="num">Faltante</th><th class="num">Órdenes</th><th>¿Sustituto?</th>
    </tr></thead>`;
    const renderRows = (data) => data.map(r => `
      <tr class="${r.stock_actual <= 0 ? 'row-danger' : ''}">
        <td class="mono">${esc(r.codigo)}</td>
        <td>${esc(r.nombre)}</td>
        <td>${esc(r.proveedor)}</td>
        <td class="num ${r.stock_actual <= 0 ? 'text-danger bold' : r.stock_actual <= r.stock_minimo ? 'text-warning' : ''}">${fmtNum(r.stock_actual)}</td>
        <td class="num">${fmtNum(r.stock_minimo)}</td>
        <td class="num">${fmtNum(r.total_pedido)}</td>
        <td class="num">${fmtNum(r.recibido_compras)}</td>
        <td class="num text-danger bold">${fmtNum(r.total_pedido - r.recibido_compras)}</td>
        <td class="num">${r.num_ordenes}</td>
        <td>${r.tiene_sustituto ? '<span class="badge-si">Sí</span>' : '<span class="badge-no">No</span>'}</td>
      </tr>
    `).join('');
    return `
      ${reportHeader('Quiebres de Stock')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Total quiebres</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi danger"><div class="inf-kpi-label">Sin sustituto</div><div class="inf-kpi-value text-danger">${sinSustituto.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Con sustituto</div><div class="inf-kpi-value">${conSustituto.length}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No se encontraron quiebres en el período.<br>
        <span class="text-muted" style="font-size:12px">Se detectan cuando un producto fue pedido en una OC confirmada pero el proveedor no realizó entrega en el período.</span></div>` : `
        ${sinSustituto.length > 0 ? `
          <div class="inf-section-label danger">🔴 Sin sustituto — requieren acción (${sinSustituto.length})</div>
          <div class="inf-table-wrap"><table class="inf-table">${thead}<tbody>${renderRows(sinSustituto)}</tbody></table></div>
        ` : ''}
        ${conSustituto.length > 0 ? `
          <div class="inf-section-label">🟡 Con sustituto disponible (${conSustituto.length})</div>
          <div class="inf-table-wrap"><table class="inf-table">${thead}<tbody>${renderRows(conSustituto)}</tbody></table></div>
        ` : ''}
      `}
    `;
  }

  // ── REPORT 5: Ventas por Vendedor ─────────────────────────────────────────────

  function renderVentasVendedor(rows) {
    const totVentas = rows.reduce((s, r) => s + (r.total_ventas || 0), 0);
    const totDevs   = rows.reduce((s, r) => s + (r.total_devuelto || 0), 0);
    const totNeto   = rows.reduce((s, r) => s + (r.total_neto || 0), 0);
    const totTxns   = rows.reduce((s, r) => s + (r.num_ventas || 0), 0);
    return `
      ${reportHeader('Ventas por Vendedor', true)}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Vendedores</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Transacciones</div><div class="inf-kpi-value">${fmtNum(totTxns)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Total bruto</div><div class="inf-kpi-value">${fmtPeso(totVentas)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Devoluciones</div><div class="inf-kpi-value text-danger">${totDevs > 0 ? '- ' + fmtPeso(totDevs) : fmtPeso(0)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Neto</div><div class="inf-kpi-value">${fmtPeso(totNeto)}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay ventas en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Vendedor</th>
              <th class="num">Transacciones</th>
              <th class="num">Subtotal bruto</th>
              <th class="num">Descuentos</th>
              <th class="num">Total bruto</th>
              <th class="num">Devoluciones</th>
              <th class="num">Total neto</th>
              <th class="num">Ticket promedio</th>
              <th class="num">% del total</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const ticket = r.num_ventas ? r.total_neto / r.num_ventas : 0;
                const pct    = totNeto > 0 ? (r.total_neto / totNeto * 100).toFixed(1) : '0.0';
                return `
                  <tr>
                    <td><strong>${esc(r.vendedor)}</strong></td>
                    <td class="num">${r.num_ventas}</td>
                    <td class="num">${fmtPeso(r.subtotal_bruto)}</td>
                    <td class="num ${r.descuentos > 0 ? 'text-danger' : ''}">${r.descuentos > 0 ? '- ' + fmtPeso(r.descuentos) : '—'}</td>
                    <td class="num">${fmtPeso(r.total_ventas)}</td>
                    <td class="num ${r.total_devuelto > 0 ? 'text-danger' : 'text-muted'}">${r.total_devuelto > 0 ? '- ' + fmtPeso(r.total_devuelto) : '—'}</td>
                    <td class="num bold">${fmtPeso(r.total_neto)}</td>
                    <td class="num">${fmtPeso(ticket)}</td>
                    <td class="num">${pct}%</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot><tr>
              <td>TOTAL</td>
              <td class="num">${fmtNum(totTxns)}</td>
              <td colspan="2"></td>
              <td class="num">${fmtPeso(totVentas)}</td>
              <td class="num text-danger">${totDevs > 0 ? '- ' + fmtPeso(totDevs) : '—'}</td>
              <td class="num bold">${fmtPeso(totNeto)}</td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
        <p class="inf-nota">* Las comisiones individuales requieren configurar el % general y por producto en el módulo de Configuración (pendiente).</p>
      `}
    `;
  }

  // ── REPORT 6: Aging Cuenta Corriente ─────────────────────────────────────────

  function agingClass(dias) {
    if (dias === null) return '';
    if (dias <= 30)  return 'aging-ok';
    if (dias <= 60)  return 'aging-warn';
    if (dias <= 90)  return 'aging-high';
    return 'aging-crit';
  }

  function agingLabel(dias) {
    if (dias === null) return '—';
    if (dias <= 30)  return `${dias}d`;
    if (dias <= 60)  return `${dias}d`;
    if (dias <= 90)  return `${dias}d`;
    return `${dias}d`;
  }

  function renderAgingCC(rows) {
    const totBalance = rows.reduce((s, r) => s + (r.balance || 0), 0);
    const criticos   = rows.filter(r => daysSince(r.primera_deuda) > 90).length;
    const hoy        = new Date().toLocaleDateString('es-AR');
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>Aging Cuenta Corriente</h3>
          <span class="inf-periodo">Estado al ${hoy}</span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Clientes con deuda</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Deuda total</div><div class="inf-kpi-value">${fmtPeso(totBalance)}</div></div>
        <div class="inf-kpi danger"><div class="inf-kpi-label">Deuda crítica (+90 días)</div><div class="inf-kpi-value text-danger">${criticos}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay clientes con saldo deudor.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Cliente</th><th>Teléfono</th>
              <th class="num">Saldo deudor</th><th class="num">Tope</th>
              <th class="num">% del tope</th>
              <th>Primera deuda</th><th>Última compra</th><th>Último pago</th>
              <th class="num">Días de mora</th><th>Categoría</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const dias = daysSince(r.primera_deuda);
                const pctTope = r.tope_deuda > 0 ? (r.balance / r.tope_deuda * 100).toFixed(0) : '—';
                const sobreTope = r.tope_deuda > 0 && r.balance > r.tope_deuda;
                const cats = ['Reciente','Normal','Alta','Crítica'];
                const catIdx = dias === null ? 0 : dias <= 30 ? 0 : dias <= 60 ? 1 : dias <= 90 ? 2 : 3;
                return `
                  <tr>
                    <td><strong>${esc(r.nombre)} ${esc(r.apellido)}</strong></td>
                    <td>${esc(r.telefono) || '—'}</td>
                    <td class="num bold ${sobreTope ? 'text-danger' : ''}">${fmtPeso(r.balance)}</td>
                    <td class="num text-muted">${r.tope_deuda > 0 ? fmtPeso(r.tope_deuda) : '—'}</td>
                    <td class="num ${sobreTope ? 'text-danger bold' : ''}">${pctTope}${pctTope !== '—' ? '%' : ''}</td>
                    <td>${fmtFechaCorta(r.primera_deuda)}</td>
                    <td>${fmtFechaCorta(r.ultima_compra)}</td>
                    <td>${fmtFechaCorta(r.ultimo_pago)}</td>
                    <td class="num"><span class="aging-badge ${agingClass(dias)}">${agingLabel(dias)}</span></td>
                    <td><span class="aging-badge ${agingClass(dias)}">${cats[catIdx]}</span></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="2">TOTAL</td>
              <td class="num bold">${fmtPeso(totBalance)}</td>
              <td colspan="7"></td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT 7: Resumen Diario de Caja ─────────────────────────────────────────

  function renderResumenDiario(rows) {
    const CAMPOS = ['num_ventas', 'cobranza_ventas', 'cobranza_deuda', 'vuelto_favor', 'otros_ingresos',
      'total_recibido', 'efectivo', 'mercadopago', 'tarjeta', 'transferencia', 'otros',
      'cuenta_corriente', 'egresos', 'neto', 'efectivo_neto', 'descuento_redondeo'];
    const tot = {};
    CAMPOS.forEach(k => { tot[k] = rows.reduce((a, r) => a + (r[k] || 0), 0); });
    const celda = v => `<td class="num">${v > 0.005 ? fmtPeso(v) : '—'}</td>`;

    return `
      ${reportHeader('Resumen Diario de Caja')}
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Ventas totales</div><div class="inf-kpi-value">${fmtNum(tot.num_ventas)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Total recibido</div><div class="inf-kpi-value">${fmtPeso(tot.total_recibido)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Cobranza de ventas</div><div class="inf-kpi-value">${fmtPeso(tot.cobranza_ventas)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Cobranza de deuda</div><div class="inf-kpi-value">${fmtPeso(tot.cobranza_deuda)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Vuelto dejado a favor</div><div class="inf-kpi-value">${fmtPeso(tot.vuelto_favor)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Egresos</div><div class="inf-kpi-value text-danger">${fmtPeso(tot.egresos)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Neto de caja</div><div class="inf-kpi-value ${tot.neto >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.neto)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Efectivo neto (recibido − egresos)</div><div class="inf-kpi-value ${tot.efectivo_neto >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.efectivo_neto)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Descuento por redondeo de vuelto</div><div class="inf-kpi-value">${fmtPeso(tot.descuento_redondeo)}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay movimientos en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table" id="inf-resumen-diario">
            <thead>
              <tr>
                <th rowspan="2">Fecha</th><th class="num" rowspan="2">N.º ventas</th>
                <th class="num" colspan="4" style="text-align:center">Origen de lo recibido</th>
                <th class="num" rowspan="2">Total recibido</th>
                <th class="num" colspan="5" style="text-align:center">Recibido por medio</th>
                <th class="num" rowspan="2">Fiado</th>
                <th class="num" rowspan="2">Egresos</th><th class="num" rowspan="2">Neto</th>
              </tr>
              <tr>
                <th class="num">Ventas</th><th class="num">Deuda</th>
                <th class="num">Vuelto a favor</th><th class="num">Otros</th>
                <th class="num">Efectivo</th><th class="num">Mercado Pago</th>
                <th class="num">Tarjeta</th><th class="num">Transf.</th>
                <th class="num">Otros</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td>${fmtFechaCorta(r.dia)}</td>
                  <td class="num">${r.num_ventas}</td>
                  ${celda(r.cobranza_ventas)}${celda(r.cobranza_deuda)}${celda(r.vuelto_favor)}${celda(r.otros_ingresos)}
                  <td class="num bold">${fmtPeso(r.total_recibido)}</td>
                  ${celda(r.efectivo)}${celda(r.mercadopago)}${celda(r.tarjeta)}${celda(r.transferencia)}${celda(r.otros)}
                  <td class="num text-muted">${r.cuenta_corriente > 0 ? fmtPeso(r.cuenta_corriente) : '—'}</td>
                  <td class="num text-danger">${r.egresos > 0 ? '- ' + fmtPeso(r.egresos) : '—'}</td>
                  <td class="num bold ${r.neto >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(r.neto)}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot><tr>
              <td>TOTAL</td>
              <td class="num">${fmtNum(tot.num_ventas)}</td>
              <td class="num">${fmtPeso(tot.cobranza_ventas)}</td>
              <td class="num">${fmtPeso(tot.cobranza_deuda)}</td>
              <td class="num">${fmtPeso(tot.vuelto_favor)}</td>
              <td class="num">${fmtPeso(tot.otros_ingresos)}</td>
              <td class="num bold">${fmtPeso(tot.total_recibido)}</td>
              <td class="num">${fmtPeso(tot.efectivo)}</td>
              <td class="num">${fmtPeso(tot.mercadopago)}</td>
              <td class="num">${fmtPeso(tot.tarjeta)}</td>
              <td class="num">${fmtPeso(tot.transferencia)}</td>
              <td class="num">${fmtPeso(tot.otros)}</td>
              <td class="num text-muted">${fmtPeso(tot.cuenta_corriente)}</td>
              <td class="num text-danger">- ${fmtPeso(tot.egresos)}</td>
              <td class="num bold ${tot.neto >= 0 ? 'text-success' : 'text-danger'}">${fmtPeso(tot.neto)}</td>
            </tr></tfoot>
          </table>
        </div>
        <p class="inf-nota" style="font-size:12px;color:var(--color-text-secondary);margin:10px 2px 0">
          Total recibido = cobranza de ventas + cobranza de deuda + vuelto dejado a favor + otros ingresos, y es la
          suma de los medios: cada columna de medio es lo que tiene que coincidir con el reporte de ese medio
          (ej. Mercado Pago) y con su caja. "Fiado" (cuenta corriente) y el saldo a favor que el cliente ya tenía
          no son plata que entra ese día, así que no suman al total. Egresos = lo que salió del cajón en efectivo.
        </p>
      `}
    `;
  }

  // ── REPORT 8: Stock sin Movimiento ────────────────────────────────────────────

  function renderStockMuerto(rows) {
    const totStock    = rows.reduce((s, r) => s + (r.stock_actual || 0), 0);
    const totInmovil  = rows.reduce((s, r) => s + (r.costo_inmovilizado || 0), 0);
    const sinVenta    = rows.filter(r => !r.ultima_venta).length;
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>Stock sin Movimiento</h3>
          <span class="inf-periodo">Sin ventas en los últimos <strong>${state.diasSinMovimiento} días</strong></span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Productos estancados</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi danger"><div class="inf-kpi-label">Nunca vendidos</div><div class="inf-kpi-value text-danger">${sinVenta}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Unidades inmovilizadas</div><div class="inf-kpi-value">${fmtNum(totStock)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Costo inmovilizado</div><div class="inf-kpi-value">${fmtPeso(totInmovil)}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay productos estancados en el umbral seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Código</th><th>Nombre</th><th>Categoría</th><th>Proveedor</th>
              <th class="num">Stock</th><th class="num">Costo unit.</th>
              <th class="num">Costo inmov.</th><th>Última venta</th><th class="num">Días sin venta</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const dias     = daysSince(r.ultima_venta);
                const diasStr  = dias === null ? '<span class="text-danger bold">Nunca</span>' : `<span class="${dias > 180 ? 'text-danger' : dias > 90 ? 'text-warning' : ''}">${dias}d</span>`;
                return `
                  <tr>
                    <td class="mono">${esc(r.codigo)}</td>
                    <td>${esc(r.nombre)}</td>
                    <td>${esc(r.categoria)}</td>
                    <td>${esc(r.proveedor)}</td>
                    <td class="num">${fmtNum(r.stock_actual)}</td>
                    <td class="num">${fmtPeso(r.costo)}</td>
                    <td class="num bold">${fmtPeso(r.costo_inmovilizado)}</td>
                    <td>${r.ultima_venta ? fmtFechaCorta(r.ultima_venta.slice(0,10)) : '<span class="text-danger">Nunca</span>'}</td>
                    <td class="num">${diasStr}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="4">TOTAL</td>
              <td class="num">${fmtNum(totStock)}</td>
              <td></td>
              <td class="num bold">${fmtPeso(totInmovil)}</td>
              <td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT: Precios y Etiquetas ─────────────────────────────────────────────

  function renderPreciosEtiquetas(rows) {
    const verCostos  = puedeVerCostos();
    const editable   = puedeEditarPrecios();
    const nuncaPrecio   = rows.filter(r => !r.ultima_modificacion_precio).length;
    const atrasados     = rows.filter(precioAtrasado).length;
    const pendientes    = rows.filter(r => r.pendiente_imprimir).length;
    const conStock      = rows.filter(r => (r.stock_actual || 0) > 0).length;
    const filtroLabel   = (state.diasSinModificarPrecio === 0
      ? 'Todos los productos'
      : `Sin cambios de precio hace ${state.diasSinModificarPrecio}+ días`)
      + ` · Ventas: últimos ${state.ventasDiasPrecio} días`
      + (state.soloConStockPrecio ? ' · Solo con stock' : '');
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>Precios y Etiquetas</h3>
          <span class="inf-periodo">${esc(filtroLabel)}</span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-excel-todos" class="btn btn-sm" title="Descarga todos los productos activos, sin los filtros de arriba">↓ Excel (todos)</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Productos</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Con stock</div><div class="inf-kpi-value">${conStock}</div></div>
        <div class="inf-kpi danger"><div class="inf-kpi-label">Costo subió y precio no</div><div class="inf-kpi-value text-danger">${atrasados}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Nunca modificaron precio</div><div class="inf-kpi-value">${nuncaPrecio}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Etiqueta desactualizada</div><div class="inf-kpi-value">${pendientes}</div></div>
      </div>
      ${editable ? `<div class="inf-hint" style="font-size:12px;color:var(--color-text-secondary);margin:4px 0 8px">
        Escribí el precio nuevo en la columna <b>Nuevo precio</b> y apretá Enter (o salí del campo) para guardarlo.
        Si el producto es de una familia, te pregunta si querés sincronizar al resto.</div>` : ''}
      ${rows.length === 0 ? `<div class="inf-empty">No hay productos en el filtro seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Código</th><th>Nombre</th><th>Categoría</th><th>Proveedor</th>
              <th class="num">Stock</th><th class="num">Vendidas (${state.ventasDiasPrecio}d)</th>
              ${verCostos ? '<th class="num">Costo</th><th class="num">Margen %</th>' : ''}
              <th>Última compra</th><th>¿Costo cambió?</th><th>¿Precio tocado desde la compra?</th>
              <th class="num">Precio actual</th>
              ${editable ? '<th class="num">Nuevo precio</th>' : ''}
              <th>Última modif. precio</th><th class="num">Días sin modificar</th>
              <th>Última impresión etiqueta</th><th>¿Etiqueta al día?</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const diasPrecio   = daysSince(r.ultima_modificacion_precio);
                const diasPrecioStr = diasPrecio === null
                  ? '<span class="text-danger bold">Nunca</span>'
                  : `<span class="${diasPrecio > 180 ? 'text-danger' : diasPrecio > 90 ? 'text-warning' : ''}">${diasPrecio}d</span>`;
                const tocado = precioTocadoDesdeCompra(r);
                const mg = margenPct(r.costo, r.precio_venta);
                return `
                  <tr data-pid="${esc(r.id)}"${precioAtrasado(r) ? ' style="background:#fff8e1"' : ''}>
                    <td class="mono">${esc(r.codigo)}</td>
                    <td>${esc(r.nombre)}</td>
                    <td>${esc(r.categoria)}</td>
                    <td>${esc(r.proveedor)}</td>
                    <td class="num ${r.stock_actual <= 0 ? 'text-danger' : ''}">${fmtNum(r.stock_actual)}</td>
                    <td class="num">${fmtNum(r.cant_vendida)}</td>
                    ${verCostos ? `
                      <td class="num">${r.costo ? fmtPeso(r.costo) : '—'}</td>
                      <td class="num inf-pe-margen ${mg !== null && mg < 15 ? 'text-danger' : ''}">${mg === null ? '—' : mg.toFixed(1) + '%'}</td>` : ''}
                    <td>${r.compra_fecha ? fmtFechaCorta(r.compra_fecha.slice(0,10)) : '<span class="text-warning">Nunca</span>'}</td>
                    <td>${r.compra_fecha ? (r.compra_costo_modificado ? '<span class="text-danger bold">Sí</span>' : 'No') : '—'}</td>
                    <td>${tocado === null ? '—' : (tocado ? 'Sí' : (r.compra_costo_modificado ? '<span class="text-danger bold">No</span>' : 'No'))}</td>
                    <td class="num inf-pe-precio">${fmtPeso(r.precio_venta)}</td>
                    ${editable ? `<td class="num">
                      <input type="number" class="inf-pe-nuevo" data-id="${esc(r.id)}" min="0" step="10"
                             data-costo="${r.costo || 0}" data-actual="${r.precio_venta || 0}"
                             style="width:90px;text-align:right" aria-label="Nuevo precio de ${esc(r.nombre)}">
                      <div class="inf-pe-prev" style="font-size:11px;color:#8090a0;min-height:14px"></div>
                    </td>` : ''}
                    <td>${r.ultima_modificacion_precio ? fmtFechaCorta(r.ultima_modificacion_precio.slice(0,10)) : '<span class="text-danger">Nunca</span>'}</td>
                    <td class="num">${diasPrecioStr}</td>
                    <td>${r.ultima_impresion_etiqueta ? fmtFechaCorta(r.ultima_impresion_etiqueta.slice(0,10)) : '<span class="text-warning">Nunca</span>'}</td>
                    <td>${r.pendiente_imprimir ? '<span class="text-danger bold">Desactualizada</span>' : '<span class="text-success">Al día</span>'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    `;
  }

  // ── Precios y Etiquetas: edición de precio en la misma pantalla ─────────────

  function attachPreciosListeners() {
    if (state.reporte !== 'precios_etiquetas') return;
    const inputs = [...document.querySelectorAll('.inf-pe-nuevo')];
    inputs.forEach((inp, i) => {
      inp.addEventListener('input', () => mostrarPrevisualizacion(inp));
      inp.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const nextId = inputs[i + 1]?.dataset.id || null;
        guardarPrecioInline(inp, nextId);
      });
      inp.addEventListener('blur', () => guardarPrecioInline(inp, null));
    });
  }

  // Antes/después del margen mientras se escribe -- el cambio todavía no se guardó.
  function mostrarPrevisualizacion(inp) {
    const prev = inp.parentElement.querySelector('.inf-pe-prev');
    if (!prev) return;
    const nuevo = parseFloat(inp.value);
    if (!(nuevo > 0) || !puedeVerCostos()) { prev.textContent = ''; return; }
    const costo = parseFloat(inp.dataset.costo) || 0;
    const mg = margenPct(costo, nuevo);
    prev.textContent = mg === null ? '' : `margen ${mg.toFixed(1)}%`;
    prev.style.color = mg !== null && mg < 0 ? '#c62828' : '#8090a0';
  }

  let guardandoPrecio = false;

  function guardarPrecioInline(inp, focoSiguienteId) {
    if (guardandoPrecio) return;          // Enter dispara blur al re-renderizar: no guardar dos veces
    const id    = inp.dataset.id;
    const nuevo = window.SGA_Utils.roundMoney(parseFloat(inp.value));
    const actual = parseFloat(inp.dataset.actual) || 0;
    if (!(nuevo > 0) || Math.abs(nuevo - actual) < 0.005) {
      if (focoSiguienteId) document.querySelector(`.inf-pe-nuevo[data-id="${focoSiguienteId}"]`)?.focus();
      return;
    }
    if (!puedeEditarPrecios()) { alert('No tenés permiso para modificar precios.'); return; }
    const row = (state.data || []).find(r => r.id === id);
    if (!row) return;

    const costo = parseFloat(row.costo) || 0;
    if (costo > 0 && nuevo < costo) {
      if (!confirm(`${row.nombre}: el precio nuevo (${fmtPeso(nuevo)}) es MENOR que el costo (${fmtPeso(costo)}). ¿Guardar igual?`)) {
        inp.value = '';
        mostrarPrevisualizacion(inp);
        return;
      }
    }

    // El bloqueo dura hasta que termine TODO el flujo (incluido el wizard de familia):
    // al abrirse el wizard el input pierde el foco y su blur volveria a guardar el mismo
    // precio y abriria un segundo wizard.
    guardandoPrecio = true;
    inp.dataset.actual = String(nuevo);
    try {
      // Mismo UPDATE que Compras/Editor/Operaciones de Stock: sync_status='pending'
      // para que viaje al otro dispositivo, y ultima_modificacion_precio para que
      // las etiquetas sugeridas detecten que hay que reimprimir.
      const ts = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.conOrigenCambio({ origen: 'informe_precios', detalle: 'Informes → Precios y Etiquetas' }, () =>
        window.SGA_DB.run(
          `UPDATE productos SET precio_venta=?, ultima_modificacion_precio=?, sync_status='pending', updated_at=? WHERE id=?`,
          [nuevo, ts, ts, id]
        ));
      aplicarPrecioEnFila(row, nuevo, null, ts);
      window.SGA_Utils.showNotification('Precio actualizado', 'success', 1500);
    } catch (e) {
      guardandoPrecio = false;
      alert('No se pudo guardar el precio: ' + e.message);
      return;
    }

    const terminar = () => {
      guardandoPrecio = false;
      rerenderPreciosEtiquetas();
      if (focoSiguienteId) document.querySelector(`.inf-pe-nuevo[data-id="${focoSiguienteId}"]`)?.focus();
    };

    // Familia: mismo wizard que al cambiar un precio en el Editor, en Compras o en
    // Operaciones de Stock. Lo que se sincroniza ahí se refleja en las filas de ESTE
    // reporte (si esos productos están en la lista) sin tener que volver a generarlo.
    if (Familia.tieneFamilia(id)) {
      Familia.showHerenciaModal({
        prodId: id,
        prodNombre: row.nombre,
        nuevoCosto: costo,
        nuevoPrecio: nuevo,
        onSync: s => {
          const hermano = (state.data || []).find(r => r.id === s.id);
          if (hermano) aplicarPrecioEnFila(hermano, s.hp ? s.pvNvo : null, s.hc ? s.costoNvo : null,
                                           window.SGA_Utils.formatISODate(new Date()));
        },
        onDone: terminar,
      });
    } else {
      terminar();
    }
  }

  // Refleja en la fila en memoria lo que ya se escribió en la base.
  function aplicarPrecioEnFila(row, precio, costo, ts) {
    if (precio != null) {
      row.precio_venta = precio;
      row.ultima_modificacion_precio = ts;
      row.pendiente_imprimir = 1;   // el precio cambió después de la última impresión
    }
    if (costo != null) row.costo = costo;
  }

  // Redibuja SIN volver a consultar (no mueve el orden ni pierde el scroll).
  function rerenderPreciosEtiquetas() {
    const resultsEl = ge('inf-results');
    if (!resultsEl || !state.data) return;
    const scroll = resultsEl.scrollTop;
    const wrap = resultsEl.querySelector('.inf-table-wrap');
    const scrollWrap = wrap ? wrap.scrollTop : 0;
    resultsEl.innerHTML = renderPreciosEtiquetas(state.data);
    resultsEl.scrollTop = scroll;
    const wrapNuevo = resultsEl.querySelector('.inf-table-wrap');
    if (wrapNuevo) wrapNuevo.scrollTop = scrollWrap;
    attachExportListeners();
  }

  // ── REPORT 9: Salidas de Stock (no venta) ─────────────────────────────────────

  function renderSalidasStock(rows) {
    const totCant   = rows.reduce((s, r) => s + (r.cantidad_total || 0), 0);
    const totCosto  = rows.reduce((s, r) => s + (r.costo_total || 0), 0);
    const totVenta  = rows.reduce((s, r) => s + (r.venta_total || 0), 0);
    const totMovs   = rows.reduce((s, r) => s + (r.num_movimientos || 0), 0);
    const filtroLabel = TIPO_SALIDA_LABEL[state.tipoSalida] || 'Todos los tipos';
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>Salidas de Stock (no venta)</h3>
          <span class="inf-periodo">Período: ${esc(fmtPeriodo())} · ${esc(filtroLabel)}</span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Personas</div><div class="inf-kpi-value">${rows.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Movimientos</div><div class="inf-kpi-value">${fmtNum(totMovs)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Unidades</div><div class="inf-kpi-value">${fmtNum(totCant)}</div></div>
        <div class="inf-kpi highlight"><div class="inf-kpi-label">Valor a costo</div><div class="inf-kpi-value">${fmtPeso(totCosto)}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Valor a precio de venta</div><div class="inf-kpi-value">${fmtPeso(totVenta)}</div></div>
      </div>
      ${rows.length === 0 ? `<div class="inf-empty">No hay salidas de stock (no venta) en el período seleccionado.</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Persona</th>
              <th class="num">Movimientos</th>
              <th class="num">Unidades</th>
              <th class="num">Consumo</th>
              <th class="num">Rotura</th>
              <th class="num">Vencimiento</th>
              <th class="num">Valor a costo</th>
              <th class="num">Valor a precio de venta</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td><strong>${esc(r.usuario)}</strong></td>
                  <td class="num">${fmtNum(r.num_movimientos)}</td>
                  <td class="num">${fmtNum(r.cantidad_total, 2)}</td>
                  <td class="num">${r.cant_consumo > 0 ? fmtNum(r.cant_consumo, 2) : '—'}</td>
                  <td class="num ${r.cant_rotura > 0 ? 'text-danger' : ''}">${r.cant_rotura > 0 ? fmtNum(r.cant_rotura, 2) : '—'}</td>
                  <td class="num ${r.cant_vencimiento > 0 ? 'text-danger' : ''}">${r.cant_vencimiento > 0 ? fmtNum(r.cant_vencimiento, 2) : '—'}</td>
                  <td class="num bold">${fmtPeso(r.costo_total)}</td>
                  <td class="num">${fmtPeso(r.venta_total)}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot><tr>
              <td>TOTAL</td>
              <td class="num">${fmtNum(totMovs)}</td>
              <td class="num">${fmtNum(totCant, 2)}</td>
              <td colspan="3"></td>
              <td class="num bold">${fmtPeso(totCosto)}</td>
              <td class="num">${fmtPeso(totVenta)}</td>
            </tr></tfoot>
          </table>
        </div>
      `}
    `;
  }

  // ── REPORT 10: Grupos de Sustitutos ─────────────────────────────────────────────
  //
  // Auditoria del modelo producto_sustitutos (producto_id, referencia_id): no hay
  // tabla de "grupo" con ID propio, asi que una referencia_id puede terminar
  // apuntando a un producto que, a su vez, tiene su propia fila con OTRA
  // referencia_id (cadena de dos niveles) — el sistema no la resuelve en ningun
  // lado, asi que el stock/reposicion de esos seguidores queda huerfano. Este
  // reporte detecta esos casos para poder corregirlos a mano.

  function queryGruposSustitutos() {
    const sid = state.sucursalId;
    const rows = window.SGA_DB.query(`
      SELECT
        ps.referencia_id AS ref_id,
        ref_p.nombre     AS ref_nombre,
        ref_p.activo     AS ref_activo,
        ref_cb.codigo    AS ref_codigo,
        ps.producto_id   AS miembro_id,
        m.nombre         AS miembro_nombre,
        mcb.codigo       AS miembro_codigo,
        m.activo         AS miembro_activo,
        COALESCE(st.cantidad, 0) AS miembro_stock,
        (SELECT ps2.referencia_id FROM producto_sustitutos ps2
          WHERE ps2.producto_id = ps.referencia_id
            AND ps2.referencia_id IS NOT NULL
            AND ps2.referencia_id != ps.referencia_id
          LIMIT 1) AS ref_real_id
      FROM producto_sustitutos ps
      JOIN productos m      ON m.id = ps.producto_id
      JOIN productos ref_p  ON ref_p.id = ps.referencia_id
      LEFT JOIN codigos_barras ref_cb ON ref_cb.producto_id = ps.referencia_id AND ref_cb.es_principal = 1
      LEFT JOIN codigos_barras mcb    ON mcb.producto_id    = ps.producto_id  AND mcb.es_principal = 1
      LEFT JOIN stock st ON st.producto_id = ps.producto_id AND st.sucursal_id = ?
      WHERE ps.referencia_id IS NOT NULL
      ORDER BY ref_p.nombre COLLATE NOCASE, m.nombre COLLATE NOCASE
    `, [sid]);

    const refRealIds = [...new Set(rows.map(r => r.ref_real_id).filter(Boolean))];
    const refRealMap = {};
    if (refRealIds.length) {
      window.SGA_DB.query(`
        SELECT p.id, p.nombre, cb.codigo
        FROM productos p
        LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
        WHERE p.id IN (${refRealIds.map(() => '?').join(',')})
      `, refRealIds).forEach(r => { refRealMap[r.id] = r; });
    }

    const grupos = new Map();
    rows.forEach(r => {
      if (!grupos.has(r.ref_id)) {
        grupos.set(r.ref_id, {
          ref_id: r.ref_id, ref_nombre: r.ref_nombre, ref_codigo: r.ref_codigo,
          miembros: [], stock_total: 0, anomalia: false, ref_inactiva: r.ref_activo === 0,
          ref_real_nombre: null, ref_real_codigo: null, ref_real_id: null,
        });
      }
      const g = grupos.get(r.ref_id);
      g.miembros.push({ nombre: r.miembro_nombre, codigo: r.miembro_codigo, stock: r.miembro_stock, activo: r.miembro_activo });
      g.stock_total += (r.miembro_stock || 0);
      // La orden de compra le pide a la referencia y descarta el grupo si esta inactiva.
      if (g.ref_inactiva) g.anomalia = true;
      if (r.ref_real_id && refRealMap[r.ref_real_id]) {
        g.anomalia = true;
        g.ref_real_id = r.ref_real_id;
        g.ref_real_nombre = refRealMap[r.ref_real_id].nombre;
        g.ref_real_codigo = refRealMap[r.ref_real_id].codigo;
      }
    });

    return [...grupos.values()];
  }

  // Productos activos que ni son referencia de nadie ni tienen a nadie apuntándoles —
  // candidatos a sumar a un grupo existente. Filtro aparte del informe principal
  // (pedido del usuario, 4/11/2026): no tiene sentido mezclarlos en la misma tabla,
  // que es por grupo, pero sirve poder verlos para decidir si agruparlos.
  function queryProductosSinGrupo() {
    return window.SGA_DB.query(`
      SELECT p.id, p.nombre, cb.codigo, COALESCE(st.cantidad, 0) AS stock
      FROM productos p
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      LEFT JOIN stock st ON st.producto_id = p.id AND st.sucursal_id = ?
      WHERE p.activo = 1
        AND p.id NOT IN (SELECT producto_id FROM producto_sustitutos)
      ORDER BY p.nombre COLLATE NOCASE
    `, [state.sucursalId]);
  }

  function renderProductosSinGrupo(rows) {
    if (!rows.length) return `<div class="inf-empty" style="margin-top:10px">No hay productos activos sin grupo de sustitutos.</div>`;
    return `
      <div class="inf-table-wrap" style="margin-top:10px">
        <div style="font-weight:700;margin:4px 2px 8px">Productos sin grupo (${rows.length})</div>
        <table class="inf-table">
          <thead><tr><th>Nombre</th><th>Código</th><th class="num">Stock</th><th></th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${esc(r.nombre)}</td>
                <td class="mono">${esc(r.codigo || '—')}</td>
                <td class="num">${fmtNum(r.stock)}</td>
                <td><button class="btn btn-sm inf-btn-asignar-grupo" data-id="${esc(r.id)}" data-nombre="${esc(r.nombre)}">+ Agregar a un grupo</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // Coincide si el texto aparece en el nombre/código de la referencia o de CUALQUIER
  // miembro — buscar "arroz" tiene que encontrar el grupo aunque "arroz" solo esté en
  // el nombre de un miembro, no en el de la referencia.
  const grupoCoincide = (g, needle) => {
    if (!needle) return true;
    const en = (s) => (s || '').toLowerCase().includes(needle);
    return en(g.ref_nombre) || en(g.ref_codigo) || g.miembros.some(m => en(m.nombre) || en(m.codigo));
  };

  function renderGruposSustitutos(grupos) {
    const needle = (state.sustFiltroTexto || '').trim().toLowerCase();
    const gruposFiltrados = needle ? grupos.filter(g => grupoCoincide(g, needle)) : grupos;
    const totMiembros = gruposFiltrados.reduce((s, g) => s + g.miembros.length, 0);
    const conProblema = gruposFiltrados.filter(g => g.anomalia).length;
    let sinGrupo = state.sustMostrarSinGrupo ? queryProductosSinGrupo() : null;
    if (sinGrupo && needle) {
      sinGrupo = sinGrupo.filter(r => (r.nombre || '').toLowerCase().includes(needle) || (r.codigo || '').toLowerCase().includes(needle));
    }
    return `
      <div class="inf-report-header">
        <div class="inf-report-title">
          <h3>Grupos de Sustitutos</h3>
          <span class="inf-periodo">Estado actual — no depende de un período</span>
        </div>
        <div class="inf-export-btns">
          <button id="inf-btn-auditar" class="btn btn-sm" title="Revisa duplicados, ciclos, cadenas y referencias inexistentes en TODOS los grupos">🔎 Auditar integridad</button>
          <button id="inf-btn-excel" class="btn btn-sm inf-btn-excel">↓ Excel</button>
          <button id="inf-btn-csv"   class="btn btn-sm">↓ CSV</button>
        </div>
      </div>
      <input type="text" id="inf-sust-filtro" class="input-full" placeholder="Filtrar por nombre o código (referencia o cualquier miembro)…"
             value="${esc(state.sustFiltroTexto || '')}" autocomplete="off" style="margin:4px 2px 14px">
      <div class="inf-kpi-row">
        <div class="inf-kpi"><div class="inf-kpi-label">Grupos</div><div class="inf-kpi-value">${gruposFiltrados.length}</div></div>
        <div class="inf-kpi"><div class="inf-kpi-label">Productos agrupados</div><div class="inf-kpi-value">${totMiembros}</div></div>
        <div class="inf-kpi ${conProblema > 0 ? 'danger' : ''}"><div class="inf-kpi-label">Con problema</div><div class="inf-kpi-value ${conProblema > 0 ? 'text-danger' : ''}">${conProblema}</div></div>
      </div>
      ${gruposFiltrados.length === 0 ? `<div class="inf-empty">${needle ? `No hay grupos que coincidan con "${esc(state.sustFiltroTexto.trim())}".` : 'No hay grupos de sustitutos armados.'}</div>` : `
        <div class="inf-table-wrap">
          <table class="inf-table">
            <thead><tr>
              <th>Referencia</th><th>Código</th><th>Miembros</th>
              <th class="num">Stock total</th><th>¿Problema?</th><th></th>
            </tr></thead>
            <tbody>
              ${gruposFiltrados.map(g => `
                <tr class="${g.anomalia ? 'row-danger' : ''}">
                  <td><strong>${esc(g.ref_nombre)}</strong></td>
                  <td class="mono">${esc(g.ref_codigo || '—')}</td>
                  <td>${g.miembros.map(m => `${esc(m.nombre)}${m.activo ? '' : ' (inactivo)'}`).join('<br>')}</td>
                  <td class="num">${fmtNum(g.stock_total)}</td>
                  <td>${g.anomalia
                    ? [
                        g.ref_real_nombre
                          ? `<span class="text-danger bold">Sí</span> — "${esc(g.ref_nombre)}" ya no es la referencia real: a su vez apunta a "${esc(g.ref_real_nombre)}". Correspondería que estos miembros formen parte del grupo de "${esc(g.ref_real_nombre)}".`
                          : '',
                        g.ref_inactiva
                          ? `<span class="text-danger bold">Sí</span> — La referencia "${esc(g.ref_nombre)}" está <strong>inactiva</strong>: la orden de compra descarta este grupo. Conviene migrar la referencia a otro miembro.`
                          : '',
                      ].filter(Boolean).join('<br>')
                    : '<span class="text-success">No</span>'}</td>
                  <td>
                    <div style="display:flex;flex-direction:column;gap:6px;min-width:150px">
                      ${g.ref_real_nombre ? `<button class="btn btn-sm btn-primary inf-btn-aceptar-sug" data-ref-id="${esc(g.ref_id)}" title="Pasa estos miembros al grupo de &quot;${esc(g.ref_real_nombre)}&quot;">✔ Aceptar sugerencia</button>` : ''}
                      <button class="btn btn-sm inf-btn-editar-grupo" data-ref-id="${esc(g.ref_id)}" title="Elegir qué productos quedan en el grupo, cuál es la referencia, o sumar uno nuevo">✎ Editar grupo…</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--color-text-secondary);cursor:pointer;margin:14px 2px 0">
        <input type="checkbox" id="inf-chk-sin-grupo" ${state.sustMostrarSinGrupo ? 'checked' : ''}>
        Mostrar también productos activos sin grupo de sustitutos
      </label>
      ${sinGrupo ? renderProductosSinGrupo(sinGrupo) : ''}
    `;
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────────

  function attachExportListeners() {
    ge('inf-btn-excel')?.addEventListener('click', () => exportExcel());
    ge('inf-btn-csv')?.addEventListener('click',   () => exportCSV());
    // "Precios y Etiquetas": catálogo completo, ignorando los filtros de pantalla.
    ge('inf-btn-excel-todos')?.addEventListener('click', () => exportExcel(queryPreciosEtiquetas(true), true));
    attachPreciosListeners();
    ge('inf-chk-sin-grupo')?.addEventListener('change', e => {
      state.sustMostrarSinGrupo = e.target.checked;
      rerenderVistaSustitutos();
    });
    const filtroEl = ge('inf-sust-filtro');
    filtroEl?.addEventListener('input', () => {
      state.sustFiltroTexto = filtroEl.value;
      const cursor = filtroEl.selectionStart;
      rerenderVistaSustitutos();
      // El re-render reemplaza el input entero (innerHTML) — sin esto, cada tecla
      // le hace perder el foco y escribir se vuelve imposible.
      const nuevoFiltro = ge('inf-sust-filtro');
      if (nuevoFiltro) { nuevoFiltro.focus(); nuevoFiltro.setSelectionRange(cursor, cursor); }
    });
    document.querySelectorAll('.inf-btn-asignar-grupo').forEach(btn =>
      btn.addEventListener('click', () => abrirAsignarGrupoSustituto(btn.dataset.id, btn.dataset.nombre)));
    document.querySelectorAll('.inf-btn-aceptar-sug').forEach(btn =>
      btn.addEventListener('click', () => aceptarSugerenciaSustitutos(btn.dataset.refId)));
    document.querySelectorAll('.inf-btn-editar-grupo').forEach(btn =>
      btn.addEventListener('click', () => abrirEditorGrupoSustitutos(btn.dataset.refId)));
    ge('inf-btn-auditar')?.addEventListener('click', abrirAuditoriaSustitutos);
  }

  function refrescarReporteSustitutos() {
    const resultsEl = ge('inf-results');
    const scroll = resultsEl ? resultsEl.scrollTop : 0;
    state.data = queryGruposSustitutos();
    if (resultsEl) {
      resultsEl.innerHTML = renderGruposSustitutos(state.data);
      resultsEl.scrollTop = scroll;
    }
    attachExportListeners();
  }

  // Igual que refrescarReporteSustitutos() pero SIN volver a consultar la base — para el
  // filtro de texto y el checkbox "sin grupo", que no cambian ningún dato, solo qué parte
  // de lo que ya está en memoria (state.data) se muestra. Evita pegarle a SQLite en cada
  // tecla tipeada.
  function rerenderVistaSustitutos() {
    const resultsEl = ge('inf-results');
    if (!resultsEl || !state.data) return;
    const scroll = resultsEl.scrollTop;
    resultsEl.innerHTML = renderGruposSustitutos(state.data);
    resultsEl.scrollTop = scroll;
    attachExportListeners();
  }

  // Asignar un producto SIN grupo a uno existente (o bootstrear uno nuevo con el elegido como
  // referencia). El producto de origen no tiene grupo, así que no puede ser a su vez referencia
  // de nadie (seguidoresDe siempre vacío) — GruposSustitutos.moverMiembro toma siempre el camino
  // simple, sin arrastrar a nadie.
  function abrirAsignarGrupoSustituto(prodId, prodNombre) {
    if (!window.SGA_Permisos?.can('can_editar_productos')) {
      alert('No tenés permiso para modificar grupos de sustitutos.');
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'inf-sust-asignar';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `
      <div role="dialog" aria-label="Agregar a un grupo de sustitutos" style="background:#fff;border-radius:12px;max-width:480px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.3)">
        <div style="padding:16px 20px;border-bottom:1px solid #eee">
          <div style="font-weight:700;font-size:1.05em">Agregar "${esc(prodNombre)}" a un grupo</div>
          <div style="font-size:.85em;color:#667;margin-top:4px">Buscá el producto que ya es (o va a pasar a ser) la referencia del grupo.</div>
        </div>
        <div style="padding:16px 20px">
          <input type="text" id="sa-buscar" class="input-full" placeholder="Buscar por nombre o código…" autocomplete="off">
          <div id="sa-dd" style="display:none;max-height:220px;overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);margin-top:4px"></div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #eee;display:flex;justify-content:flex-end">
          <button class="btn btn-sm" id="sa-cancelar">Cancelar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(); } };
    const cerrar = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('#sa-cancelar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) cerrar(); });

    const buscar = ge('sa-buscar');
    const dd = ge('sa-dd');
    const nav = Buscador.attachDropdownKeyboard(buscar, {
      getItems: () => dd.querySelectorAll('.sri'),
      highlightClass: 'sust-hl',
    });
    buscar.addEventListener('input', () => {
      nav.reset();
      const q = buscar.value.trim();
      if (q.length < 2) { dd.style.display = 'none'; return; }
      const resultados = Buscador.porTexto(q, { sucursalId: state.sucursalId, limite: 12 }).filter(p => p.id !== prodId);
      Buscador.pintarDropdown(dd, resultados, (p) => {
        GruposSustitutos.moverMiembro(prodId, p.id);
        window.SGA_Sync?.pushPending?.();
        cerrar();
        refrescarReporteSustitutos();
      });
    });
    buscar.focus();
  }

  // "Editar grupo…": mismo concepto que el paso de confirmación de Compras (tildar qué productos
  // quedan en el grupo y elegir cuál es la referencia), pero partiendo de los miembros actuales:
  // lo destildado SALE del grupo. Todo se aplica junto con GruposSustitutos.definirGrupo.
  function abrirEditorGrupoSustitutos(refId) {
    if (!window.SGA_Permisos?.can('can_editar_productos')) {
      alert('No tenés permiso para modificar grupos de sustitutos.');
      return;
    }
    const ids = GruposSustitutos.involucradosDe(refId);
    if (!ids.length) return;
    const rows = window.SGA_DB.query(`
      SELECT p.id, p.nombre, p.activo, cb.codigo, COALESCE(st.cantidad, 0) AS stock
      FROM productos p
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      LEFT JOIN stock st ON st.producto_id = p.id AND st.sucursal_id = ?
      WHERE p.id IN (${ids.map(() => '?').join(',')})
      ORDER BY p.nombre COLLATE NOCASE
    `, [state.sucursalId, ...ids]);
    const nombreDe = id => rows.find(r => r.id === id)?.nombre || '—';
    // Referencia sugerida: la raiz de la cadena; si esa esta inactiva, el activo con mas stock.
    let sugerida = GruposSustitutos.raizDe(refId);
    if (rows.find(r => r.id === sugerida)?.activo === 0) {
      const activos = rows.filter(r => r.activo !== 0).sort((a, b) => b.stock - a.stock);
      if (activos.length) sugerida = activos[0].id;
    }

    // Fila de un miembro (tilde + nombre/código/stock + radio de referencia). Reusada
    // tanto en el render inicial como al sumar un producto nuevo por el buscador.
    const filaMiembro = (r) => {
      const hoy = GruposSustitutos.referenciaRealDe(r.id);
      const nota = hoy && hoy !== r.id ? `hoy apunta a "${esc(nombreDe(hoy))}"` : (hoy === r.id ? 'hoy es referencia' : '');
      return `<label style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f3f3f3;cursor:pointer">
        <input type="checkbox" class="sg-miembro" value="${esc(r.id)}" checked>
        <span style="flex:1;min-width:0">
          <span style="font-weight:600">${esc(r.nombre)}${r.activo === 0 ? ' <span style="color:#c62828;font-weight:500">(inactivo)</span>' : ''}</span>
          <span style="display:block;font-size:.78em;color:#889">${esc(r.codigo || 'sin código')} · stock ${fmtNum(r.stock)}${nota ? ' · ' + nota : ''}</span>
        </span>
        <span style="display:flex;align-items:center;gap:4px;font-size:.82em;color:#445;white-space:nowrap">
          <input type="radio" name="sg-ref" class="sg-ref" value="${esc(r.id)}" ${r.id === sugerida ? 'checked' : ''}> Referencia
        </span>
      </label>`;
    };

    const overlay = document.createElement('div');
    overlay.id = 'inf-sust-editor';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `
      <div role="dialog" aria-label="Editar grupo de sustitutos" style="background:#fff;border-radius:12px;max-width:640px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3)">
        <div style="padding:16px 20px;border-bottom:1px solid #eee">
          <div style="font-weight:700;font-size:1.05em">Editar grupo de sustitutos</div>
          <div style="font-size:.85em;color:#667;margin-top:4px">Tildá los productos que forman el grupo y marcá cuál es la <strong>referencia</strong> (el que se pide al proveedor). Los destildados salen del grupo.</div>
        </div>
        <div style="padding:12px 20px 0;border-bottom:1px solid #eee;position:relative">
          <input type="text" id="sg-buscar" class="input-full" placeholder="Sumar un producto al grupo por nombre o código…" autocomplete="off" style="margin-bottom:6px">
          <div id="sg-dd" style="position:absolute;left:20px;right:20px;top:44px;z-index:10;display:none;max-height:220px;overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15)"></div>
          <div id="sg-nota-extra" style="font-size:.78em;color:#e65100;margin-bottom:10px"></div>
        </div>
        <div id="sg-lista" style="padding:8px 20px;overflow-y:auto;flex:1">
          ${rows.map(filaMiembro).join('')}
        </div>
        <div style="padding:12px 20px;border-top:1px solid #eee">
          <div id="sg-aviso" style="font-size:.82em;color:#556;margin-bottom:10px"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-sm" id="sg-cancelar">Cancelar</button>
            <button class="btn btn-sm btn-primary" id="sg-confirmar">Confirmar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // El modal captura su propio teclado: Escape cierra solo esto, nunca la pantalla de atrás.
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(); }
    };
    const cerrar = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };
    document.addEventListener('keydown', onKey, true);

    const chks = () => [...overlay.querySelectorAll('.sg-miembro')];
    const refSel = () => overlay.querySelector('.sg-ref:checked')?.value;
    const pintar = () => {
      const ref = refSel();
      chks().forEach(c => { if (c.value === ref) { c.checked = true; c.disabled = true; } else c.disabled = false; });
      const quedan = chks().filter(c => c.checked);
      const salen = chks().filter(c => !c.checked);
      overlay.querySelector('#sg-aviso').innerHTML =
        `Quedan <strong>${quedan.length}</strong> en el grupo, referencia: <strong>${esc(nombreDe(ref))}</strong>.` +
        (salen.length ? ` Salen del grupo: ${salen.map(c => esc(nombreDe(c.value))).join(', ')}.` : '') +
        (quedan.length < 2 ? ' <span style="color:#c62828">Con un solo producto el grupo se disuelve.</span>' : '');
    };
    overlay.addEventListener('change', pintar);
    pintar();

    // Buscador para sumar un producto nuevo al grupo (motor único, SGA_Buscador). Si lo
    // elegido es a su vez referencia de otros (seguidoresDe), hay que sumar también a esos
    // seguidores — dejarlo afuera crearía una cadena rota (ver diagnosticar/invariante #2).
    const buscar = ge('sg-buscar');
    const dd = ge('sg-dd');
    const nav = Buscador.attachDropdownKeyboard(buscar, {
      getItems: () => dd.querySelectorAll('.sri'),
      highlightClass: 'sust-hl',
    });
    buscar.addEventListener('input', () => {
      nav.reset();
      const q = buscar.value.trim();
      if (q.length < 2) { dd.style.display = 'none'; return; }
      const resultados = Buscador.porTexto(q, { sucursalId: state.sucursalId, limite: 12 })
        .filter(p => !ids.includes(p.id));
      Buscador.pintarDropdown(dd, resultados, (p) => {
        buscar.value = '';
        dd.style.display = 'none';
        const nuevosIds = [p.id, ...GruposSustitutos.seguidoresDe(p.id).map(f => f.id)]
          .filter(id => !ids.includes(id));
        if (!nuevosIds.length) return;
        const nuevasRows = window.SGA_DB.query(`
          SELECT p.id, p.nombre, p.activo, cb.codigo, COALESCE(st.cantidad, 0) AS stock
          FROM productos p
          LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
          LEFT JOIN stock st ON st.producto_id = p.id AND st.sucursal_id = ?
          WHERE p.id IN (${nuevosIds.map(() => '?').join(',')})
        `, [state.sucursalId, ...nuevosIds]);
        ids.push(...nuevosIds);
        rows.push(...nuevasRows);
        ge('sg-lista').insertAdjacentHTML('beforeend', nuevasRows.map(filaMiembro).join(''));
        overlay.querySelector('#sg-nota-extra').innerHTML = nuevosIds.length > 1
          ? `Se sumaron también sus seguidores (si no los movés, quedarían apuntando a una referencia que a su vez apunta a otra): ` +
            `${esc(nuevasRows.filter(r => r.id !== p.id).map(r => r.nombre).join(', '))}.`
          : '';
        pintar();
      });
    });
    overlay.addEventListener('mousedown', e => { if (e.target.closest('#sg-dd') || e.target === buscar) return; dd.style.display = 'none'; });

    overlay.querySelector('#sg-cancelar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) cerrar(); });
    overlay.querySelector('#sg-confirmar').addEventListener('click', () => {
      const referenciaId = refSel();
      const miembros = chks().filter(c => c.checked).map(c => c.value);
      if (miembros.length < 2 && !confirm('Quedaría un solo producto: el grupo se disuelve y todos quedan sueltos. ¿Seguir?')) return;
      try {
        GruposSustitutos.definirGrupo({ miembros, referenciaId, involucrados: ids });
      } catch (e) {
        alert('No se pudo aplicar el cambio: ' + e.message);
        return;
      }
      cerrar();
      window.SGA_Sync?.pushPending?.();
      refrescarReporteSustitutos();
    });
    overlay.querySelector('.sg-ref:checked')?.focus();
  }

  // "Auditar integridad": revisa TODOS los grupos con GruposSustitutos.diagnosticar() y deja
  // reparar cada problema (duplicados, referencias inexistentes, cadenas, ciclos, referencias sin
  // fila propia). Cada reparacion pasa por el motor y marca los productos para sincronizar.
  function abrirAuditoriaSustitutos() {
    if (!window.SGA_Permisos?.can('can_editar_productos')) {
      alert('No tenés permiso para modificar grupos de sustitutos.');
      return;
    }
    const G = GruposSustitutos;
    const nom = (id) => window.SGA_DB.query('SELECT nombre FROM productos WHERE id = ?', [id])[0]?.nombre
      || '(producto eliminado)';

    const overlay = document.createElement('div');
    overlay.id = 'inf-sust-auditoria';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(overlay);

    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(); } };
    const cerrar = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); refrescarReporteSustitutos(); };
    document.addEventListener('keydown', onKey, true);

    const seccion = (titulo, cuerpo) => `<div style="margin:0 0 14px"><div style="font-weight:700;margin-bottom:6px">${titulo}</div>${cuerpo}</div>`;
    const fila = (html, boton) => `<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #f3f3f3"><div style="flex:1;min-width:0">${html}</div>${boton || ''}</div>`;

    const pintar = () => {
      const d = G.diagnosticar();
      const bloques = [];

      const sinProducto = d.inexistentes.filter(x => x.falta === 'producto').length;
      if (sinProducto || d.sinFilaPropia.length) {
        bloques.push(seccion('Reparación automática (segura)', fila(
          `${d.sinFilaPropia.length} referencia(s) sin fila propia (su stock no suma al del grupo) y ` +
          `${sinProducto} fila(s) de productos que ya no existen.`,
          '<button class="btn btn-sm btn-primary" data-aud="auto">Reparar</button>')));
      }

      const fantasmas = {};
      d.inexistentes.filter(x => x.falta === 'referencia').forEach(x => {
        (fantasmas[x.referencia_id] = fantasmas[x.referencia_id] || []).push(x.producto_id);
      });
      const idsFantasma = Object.keys(fantasmas);
      if (idsFantasma.length) {
        bloques.push(seccion('Referencia que ya no existe', idsFantasma.map(fid => fila(
          `Estos productos apuntan a una referencia eliminada: <strong>${esc(fantasmas[fid].map(nom).join(', '))}</strong>.<br>
           Nueva referencia: <select data-aud-nueva="${esc(fid)}" class="input-full" style="max-width:300px">
             ${fantasmas[fid].map(id => `<option value="${esc(id)}">${esc(nom(id))}</option>`).join('')}</select>`,
          `<button class="btn btn-sm btn-primary" data-aud="fantasma" data-id="${esc(fid)}">Reparar</button>`)).join('')));
      }

      if (d.duplicados.length) {
        bloques.push(seccion('Productos con más de una referencia', d.duplicados.map(x => fila(
          `<strong>${esc(nom(x.producto_id))}</strong> tiene ${x.referencias.length} referencias. Dejar solo:<br>
           <select data-aud-dup="${esc(x.producto_id)}" class="input-full" style="max-width:300px">
             ${[...new Set(x.referencias)].map(r => `<option value="${esc(r)}">${esc(nom(r))}</option>`).join('')}</select>`,
          `<button class="btn btn-sm btn-primary" data-aud="dup" data-id="${esc(x.producto_id)}">Dejar solo esta</button>`)).join('')));
      }

      if (d.cadenas.length) {
        const refs = [...new Set(d.cadenas.map(c => c.referencia_id))];
        bloques.push(seccion('Cadenas (una referencia que apunta a otra)', refs.map(r => fila(
          `<strong>${esc(nom(r))}</strong> es referencia de ${esc(d.cadenas.filter(c => c.referencia_id === r).map(c => nom(c.producto_id)).join(', '))}
           pero a su vez apunta a otra referencia.`,
          `<button class="btn btn-sm btn-primary" data-aud="cadena" data-id="${esc(r)}">Corregir</button>
           <button class="btn btn-sm" data-aud="editar" data-id="${esc(r)}">Editar grupo…</button>`)).join('')));
      }

      if (d.ciclos.length) {
        bloques.push(seccion('Ciclos (se apuntan entre sí)', d.ciclos.map(c => fila(
          `${esc(c.map(nom).join(' → '))} → ${esc(nom(c[0]))}. Nadie es la referencia real: elegí cuál lo es.`,
          `<button class="btn btn-sm btn-primary" data-aud="editar" data-id="${esc(c[0])}">Resolver…</button>`)).join('')));
      }

      overlay.innerHTML = `
        <div role="dialog" aria-label="Auditoría de integridad de grupos de sustitutos" style="background:#fff;border-radius:12px;max-width:760px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3)">
          <div style="padding:16px 20px;border-bottom:1px solid #eee;font-weight:700">🔎 Auditoría de integridad de grupos de sustitutos</div>
          <div id="inf-aud-cuerpo" style="padding:14px 20px;overflow-y:auto;flex:1;font-size:.92em">
            ${d.ok
              ? '<div style="color:#2e7d32;font-weight:600">✔ Todo en orden: ningún producto con dos referencias, sin cadenas, sin ciclos y sin referencias inexistentes.</div>'
              : bloques.join('')}
          </div>
          <div style="padding:12px 20px;border-top:1px solid #eee;display:flex;justify-content:flex-end">
            <button class="btn btn-sm" data-aud="cerrar">Cerrar</button>
          </div>
        </div>`;
    };

    overlay.addEventListener('click', (e) => {
      const b = e.target.closest('[data-aud]');
      if (!b) { if (e.target === overlay) cerrar(); return; }
      const accion = b.dataset.aud, id = b.dataset.id;
      try {
        if (accion === 'cerrar') { cerrar(); return; }
        if (accion === 'auto') G.repararAutomatico();
        else if (accion === 'fantasma') G.repararReferenciaInexistente(id, overlay.querySelector(`[data-aud-nueva="${CSS.escape(id)}"]`).value);
        else if (accion === 'dup') G.repararDuplicado(id, overlay.querySelector(`[data-aud-dup="${CSS.escape(id)}"]`).value);
        else if (accion === 'cadena') G.corregirCadena(id);
        else if (accion === 'editar') { cerrar(); abrirEditorGrupoSustitutos(id); return; }
      } catch (err) {
        alert('No se pudo reparar: ' + err.message);
      }
      window.SGA_Sync?.pushPending?.();
      pintar();
    });
    pintar();
  }

  // "Aceptar sugerencia" del reporte Grupos de Sustitutos: repunta los miembros del grupo roto a
  // la referencia real (GruposSustitutos.corregirCadena) y vuelve a armar el reporte.
  function aceptarSugerenciaSustitutos(refId) {
    const g = (state.data || []).find(x => x.ref_id === refId);
    if (!g) return;
    if (!window.SGA_Permisos?.can('can_editar_productos')) {
      alert('No tenés permiso para modificar grupos de sustitutos.');
      return;
    }
    const nombres = g.miembros.map(m => '• ' + m.nombre).join('\n');
    if (!confirm(
      `Pasar al grupo de "${g.ref_real_nombre}":\n\n${nombres}\n\n` +
      `Su referencia pasa de "${g.ref_nombre}" a "${g.ref_real_nombre}".`
    )) return;
    try {
      GruposSustitutos.corregirCadena(refId);
    } catch (e) {
      alert('No se pudo aplicar el cambio: ' + e.message);
      return;
    }
    window.SGA_Sync?.pushPending?.();
    refrescarReporteSustitutos();
  }

  // rowsOverride / sinFiltros: solo "Precios y Etiquetas" -> "Excel (todos)".
  function buildExportRows(rowsOverride = null, sinFiltros = false) {
    const rows    = rowsOverride || state.data || [];
    const rep     = state.reporte;
    const title   = REPORTES.find(r => r.id === rep)?.label || rep;
    const periodo = rep === 'aging_cc'    ? `Estado al ${new Date().toLocaleDateString('es-AR')}` :
                    rep === 'stock_muerto' ? `Sin ventas en los últimos ${state.diasSinMovimiento} días` :
                    rep === 'salidas_stock' ? `Período: ${fmtPeriodo()} · ${TIPO_SALIDA_LABEL[state.tipoSalida] || 'Todos los tipos'}` :
                    rep === 'sustitutos_grupos' ? `Estado al ${new Date().toLocaleDateString('es-AR')}` :
                    rep === 'precios_etiquetas' ? (sinFiltros || state.diasSinModificarPrecio === 0
                      ? 'Todos los productos'
                      : `Sin cambios de precio hace ${state.diasSinModificarPrecio}+ días`)
                      + ` · Ventas: últimos ${state.ventasDiasPrecio} días`
                      + (!sinFiltros && state.soloConStockPrecio ? ' · Solo con stock' : '') :
                    `Período: ${fmtPeriodo()}`;

    if (rep === 'ventas_producto' || rep === 'analitica_producto') {
      const headers = ['Código','Nombre','Categoría','Proveedor','Costo actual','Precio actual',
                       'Stock actual','Cant. vendida','Costo total','Venta total','Utilidad','Margen %'];
      const data = rows.map(r => [r.codigo, r.nombre, r.categoria, r.proveedor,
        r.costo_actual, r.precio_actual, r.stock_actual, r.cant_vendida,
        r.costo_total, r.venta_total, r.utilidad, r.margen_pct]);
      return { title, periodo, headers, data };
    }
    if (rep === 'ventas_transaccion') {
      const headers = ['N° Venta','Fecha','Hora','Vendedor','Subtotal','Descuento','Total','Forma de pago','Cliente'];
      const data = rows.map(r => {
        const fecha = new Date(r.fecha);
        const pagos = parsePagos(r.pagos_raw).map(p => `${MEDIO_LABEL[p.medio]||p.medio} $${p.monto.toFixed(2)}`).join(', ');
        return ['#'+r.id.slice(-6), fecha.toLocaleDateString('es-AR'),
          fecha.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}),
          r.vendedor, r.subtotal, r.descuento, r.total, pagos,
          r.cliente ? r.cliente.trim() : 'Consumidor final'];
      });
      return { title, periodo, headers, data };
    }
    if (rep === 'quiebres_stock') {
      const headers = ['Código','Producto','Proveedor','Stock actual','Stock mín.',
                       'Pedido (OC)','Recibido','Faltante','N° Órdenes','¿Sustituto?'];
      const data = rows.map(r => [r.codigo, r.nombre, r.proveedor, r.stock_actual, r.stock_minimo,
        r.total_pedido, r.recibido_compras, r.total_pedido - r.recibido_compras,
        r.num_ordenes, r.tiene_sustituto ? 'Sí' : 'No']);
      return { title, periodo, headers, data };
    }
    if (rep === 'aging_cc') {
      const headers = ['Cliente','Teléfono','Saldo deudor','Tope crédito',
                       'Primera deuda','Última compra','Último pago','Días de mora','Categoría'];
      const cats = ['Reciente','Normal','Alta','Crítica'];
      const data = rows.map(r => {
        const dias   = daysSince(r.primera_deuda);
        const catIdx = dias === null ? 0 : dias <= 30 ? 0 : dias <= 60 ? 1 : dias <= 90 ? 2 : 3;
        return [`${r.nombre} ${r.apellido}`, r.telefono, r.balance, r.tope_deuda,
          r.primera_deuda ? r.primera_deuda.slice(0,10) : '',
          r.ultima_compra ? r.ultima_compra.slice(0,10) : '',
          r.ultimo_pago   ? r.ultimo_pago.slice(0,10)   : '',
          dias ?? '', cats[catIdx]];
      });
      return { title, periodo, headers, data };
    }
    if (rep === 'resumen_diario') {
      const headers = ['Fecha','Ventas','Cobranza de ventas','Cobranza de deuda','Vuelto a favor','Otros ingresos',
                       'Total recibido','Efectivo','Mercado Pago','Tarjeta','Transferencia','Otros medios',
                       'Cta. Cte. (fiada)','Egresos','Neto','Descuento por redondeo de vuelto'];
      const data = rows.map(r => [fmtFechaCorta(r.dia), r.num_ventas,
        r.cobranza_ventas, r.cobranza_deuda, r.vuelto_favor, r.otros_ingresos,
        r.total_recibido, r.efectivo, r.mercadopago, r.tarjeta, r.transferencia, r.otros,
        r.cuenta_corriente, r.egresos, r.neto, r.descuento_redondeo]);
      return { title, periodo, headers, data };
    }
    if (rep === 'salidas_stock') {
      const headers = ['Persona','Movimientos','Unidades','Consumo','Rotura','Vencimiento','Valor a costo','Valor a precio de venta'];
      const data = rows.map(r => [r.usuario, r.num_movimientos, r.cantidad_total,
        r.cant_consumo, r.cant_rotura, r.cant_vencimiento, r.costo_total, r.venta_total]);
      return { title, periodo, headers, data };
    }
    if (rep === 'stock_muerto') {
      const headers = ['Código','Nombre','Categoría','Proveedor',
                       'Stock','Costo unitario','Costo inmovilizado','Última venta','Días sin venta'];
      const data = rows.map(r => {
        const dias = daysSince(r.ultima_venta);
        return [r.codigo, r.nombre, r.categoria, r.proveedor,
          r.stock_actual, r.costo, r.costo_inmovilizado,
          r.ultima_venta ? r.ultima_venta.slice(0,10) : 'Nunca', dias ?? 'Nunca'];
      });
      return { title, periodo, headers, data };
    }
    if (rep === 'precios_etiquetas') {
      const verCostos = puedeVerCostos();
      const headers = ['Código','Todos los códigos','Nombre','Categoría','Proveedor',
                       'Stock actual', `Cant. vendida (${state.ventasDiasPrecio} días)`,
                       ...(verCostos ? ['Costo actual','Margen %'] : []),
                       'Última compra','¿Costo cambió en esa compra?','¿Precio tocado desde esa compra?',
                       'Precio actual','Nuevo precio',
                       'Última modificación de precio','Días sin modificar',
                       'Última impresión de etiqueta','¿Etiqueta al día?'];
      const data = rows.map(r => {
        const dias = daysSince(r.ultima_modificacion_precio);
        const tocado = precioTocadoDesdeCompra(r);
        const mg = margenPct(r.costo, r.precio_venta);
        return [r.codigo, r.todos_codigos || '', r.nombre, r.categoria, r.proveedor,
          r.stock_actual, r.cant_vendida,
          ...(verCostos ? [r.costo || '', mg === null ? '' : Math.round(mg * 10) / 10] : []),
          r.compra_fecha ? r.compra_fecha.slice(0,10) : 'Nunca',
          r.compra_fecha ? (r.compra_costo_modificado ? 'Sí' : 'No') : '',
          tocado === null ? '' : (tocado ? 'Sí' : 'No'),
          r.precio_venta, '',
          r.ultima_modificacion_precio ? r.ultima_modificacion_precio.slice(0,10) : 'Nunca',
          dias ?? 'Nunca',
          r.ultima_impresion_etiqueta ? r.ultima_impresion_etiqueta.slice(0,10) : 'Nunca',
          r.pendiente_imprimir ? 'Desactualizada' : 'Al día'];
      });
      return { title, periodo, headers, data };
    }
    if (rep === 'sustitutos_grupos') {
      const headers = ['Referencia','Código','Miembros','Stock total','¿Problema?','Detalle'];
      const data = rows.map(r => [r.ref_nombre, r.ref_codigo,
        r.miembros.map(m => m.nombre + (m.activo ? '' : ' (inactivo)')).join(' | '),
        r.stock_total,
        r.anomalia ? 'Sí' : 'No',
        r.anomalia ? `"${r.ref_nombre}" ya no es referencia real, apunta a "${r.ref_real_nombre}"` : '']);
      return { title, periodo, headers, data };
    }
    return null;
  }

  function exportExcel(rowsOverride = null, sinFiltros = false) {
    if (!window.XLSX) { alert('Librería XLSX no disponible.'); return; }
    const ed = buildExportRows(rowsOverride, sinFiltros);
    if (!ed) return;
    const wsData = [[ed.title], [ed.periodo], [], ed.headers, ...ed.data];
    const ws = window.XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = ed.headers.map(() => ({ wch: 18 }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, ed.title.slice(0, 31));
    window.XLSX.writeFile(wb, `${ed.title.replace(/\s+/g, '_')}_${state.desde || 'hoy'}.xlsx`);
  }

  function exportCSV() {
    const ed = buildExportRows();
    if (!ed) return;
    const escCell = (cell) => {
      const s = String(cell == null ? '' : cell);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const allRows = [[ed.title], [ed.periodo], [], ed.headers, ...ed.data];
    const csv = allRows.map(row => row.map(escCell).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${ed.title.replace(/\s+/g, '_')}_${state.desde || 'hoy'}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { init };
})();

export default Informes;
