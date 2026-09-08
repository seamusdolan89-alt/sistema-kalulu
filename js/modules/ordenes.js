/**
 * ordenes.js — Módulo de Órdenes de Compra
 *
 * Flujo: borrador → revisada → confirmada → enviada → recibiendo → recibida_parcial → cerrada
 */

import Buscador from './buscador_productos.js';

const Ordenes = (() => {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const db   = () => window.SGA_DB;
  const uuid = () => window.SGA_Utils.generateUUID();
  const now  = () => window.SGA_Utils.formatISODate(new Date());

  // ── DATA LAYER ───────────────────────────────────────────────────────────────

  /**
   * Devuelve el stock efectivo de un producto en una sucursal.
   * Si el producto pertenece a un grupo de sustitutos, suma el stock de todos los miembros.
   */
  function stockEfectivo(productoId, sucursalId) {
    const inGroup = db().query(
      `SELECT referencia_id FROM producto_sustitutos
       WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`,
      [productoId]
    );
    if (inGroup.length) {
      const r = db().query(`
        SELECT COALESCE(SUM(st.cantidad), 0) AS total
        FROM producto_sustitutos ps
        LEFT JOIN stock st ON st.producto_id = ps.producto_id AND st.sucursal_id = ?
        WHERE ps.referencia_id = ?
      `, [sucursalId, inGroup[0].referencia_id]);
      return r[0]?.total || 0;
    }
    // Producto standalone o que es referencia del grupo — suma todos los miembros si los hay
    const asRef = db().query(
      `SELECT COALESCE(SUM(st.cantidad), 0) AS total
       FROM producto_sustitutos ps
       LEFT JOIN stock st ON st.producto_id = ps.producto_id AND st.sucursal_id = ?
       WHERE ps.referencia_id = ?`,
      [sucursalId, productoId]
    );
    if (asRef.length && (asRef[0].total || 0) > 0) return asRef[0].total;
    // Sin grupo — stock propio
    const own = db().query(
      `SELECT COALESCE(cantidad, 0) AS qty FROM stock WHERE producto_id = ? AND sucursal_id = ?`,
      [productoId, sucursalId]
    );
    return own[0]?.qty || 0;
  }

  /**
   * Unidades vendidas en los últimos N días para un producto.
   * Excluye ventas anuladas.
   */
  function ventasUltimos(productoId, dias) {
    const r = db().query(`
      SELECT COALESCE(SUM(vi.cantidad), 0) AS total
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
      WHERE vi.producto_id = ?
        AND v.estado != 'anulada'
        AND v.fecha >= datetime('now', ? || ' days')
    `, [productoId, String(-dias)]);
    return r[0]?.total || 0;
  }

  /**
   * Genera una orden de compra en estado 'borrador' para un proveedor.
   *
   * Incluye todos los productos del proveedor cuyo stock efectivo
   * sea <= stock_minimo. El stock efectivo considera el grupo de
   * sustitutos para no pedir productos innecesariamente.
   *
   * @param {string} proveedorId
   * @param {string} sucursalId
   * @returns {{ success: boolean, ordenId: string|null, itemCount: number, message?: string }}
   */
  function generarOrdenCompra(proveedorId, sucursalId) {
    const user = window.SGA_Auth.getCurrentUser();

    // 1. Obtener todos los productos del proveedor (principal o alternativo)
    const candidatos = db().query(`
      SELECT p.id,
             COALESCE(ps.referencia_id, p.id) AS ref_id
      FROM productos p
      LEFT JOIN producto_sustitutos ps
             ON ps.producto_id = p.id AND ps.referencia_id IS NOT NULL
      WHERE (p.proveedor_principal_id = ? OR p.proveedor_alternativo_id = ?)
        AND p.activo = 1
    `, [proveedorId, proveedorId]);

    // 2. Deduplicar por ref_id — un solo item por producto/grupo
    const refIds = [...new Set(candidatos.map(c => c.ref_id))];

    // 3. Para cada referencia, evaluar si necesita reposición
    const items = [];

    for (const refId of refIds) {
      const prod = db().query(`
        SELECT id, nombre, stock_minimo, cant_pedido, unidad_medida,
               pedido_unidad, pedido_unidades_por_paquete
        FROM productos WHERE id = ? AND activo = 1
      `, [refId])[0];

      if (!prod) continue;  // referencia inactiva o no existe

      const stockAct  = stockEfectivo(refId, sucursalId);
      const stockMin  = prod.stock_minimo || 0;
      const cantPedido = prod.cant_pedido || 0;

      if (stockAct - stockMin > 0) continue;  // stock suficiente, no pedir

      const v30d    = ventasUltimos(refId, 30);
      const v6m     = ventasUltimos(refId, 180);
      const diasSS  = db().calcularDiasSinStock6m(refId, sucursalId);

      items.push({
        productoId:       refId,
        cantidadPedida:   cantPedido,
        stockActual:      stockAct,
        stockMinimo:      stockMin,
        cantidadDeseada:  cantPedido,
        ventas30d:        v30d,
        ventasProm6m:     Math.round((v6m / 6) * 100) / 100,
        diasSinStock6m:   diasSS,
        cantidadSugerida: cantPedido,
        unidadPedida:     prod.pedido_unidad || 'unidad',
      });
    }

    if (items.length === 0) {
      return {
        success: true,
        ordenId: null,
        itemCount: 0,
        message: 'No hay productos que necesiten reposición para este proveedor.',
      };
    }

    // 4. Crear orden y sus items en una sola transacción
    const ordenId = uuid();
    const ts = now();

    db().beginBatch();
    try {
      db().run(`
        INSERT INTO ordenes_compra
          (id, sucursal_id, proveedor_id, usuario_id, fecha_creacion, estado, notas, sync_status, updated_at)
        VALUES (?, ?, ?, ?, ?, 'borrador', NULL, 'pending', ?)
      `, [ordenId, sucursalId, proveedorId, user.id, ts, ts]);

      for (const it of items) {
        db().run(`
          INSERT INTO orden_compra_items
            (id, orden_id, producto_id, cantidad_pedida, estado,
             stock_actual, stock_minimo, cantidad_deseada,
             ventas_30d, ventas_prom_6m, dias_sin_stock_6m,
             cantidad_sugerida, cantidad_final, unidad_pedida)
          VALUES (?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `, [
          uuid(), ordenId, it.productoId, it.cantidadSugerida, it.stockActual,
          it.stockMinimo, it.cantidadDeseada, it.ventas30d,
          it.ventasProm6m, it.diasSinStock6m, it.cantidadSugerida, it.unidadPedida,
        ]);
      }

      db().commitBatch();
    } catch (e) {
      db().rollbackBatch();
      console.error('generarOrdenCompra error:', e);
      return { success: false, ordenId: null, itemCount: 0, message: e.message };
    }

    return { success: true, ordenId, itemCount: items.length };
  }

  /**
   * Devuelve todas las órdenes de compra de la sucursal, con nombre del proveedor.
   */
  function getOrdenes(sucursalId) {
    return db().query(`
      SELECT oc.id, oc.proveedor_id, oc.estado, oc.fecha_creacion,
             oc.revisada_en, oc.confirmada_en, oc.notas,
             p.razon_social AS proveedor_nombre,
             (SELECT COUNT(*) FROM orden_compra_items oi WHERE oi.orden_id = oc.id) AS num_items
      FROM ordenes_compra oc
      LEFT JOIN proveedores p ON p.id = oc.proveedor_id
      WHERE oc.sucursal_id = ?
      ORDER BY oc.fecha_creacion DESC
    `, [sucursalId]);
  }

  /**
   * Devuelve una orden con todos sus items y datos de producto.
   */
  function getOrden(ordenId) {
    const orden = db().query(`
      SELECT oc.*, p.razon_social AS proveedor_nombre
      FROM ordenes_compra oc
      LEFT JOIN proveedores p ON p.id = oc.proveedor_id
      WHERE oc.id = ?
    `, [ordenId])[0];

    if (!orden) return null;

    orden.items = db().query(`
      SELECT oi.*,
             pr.nombre AS producto_nombre,
             pr.unidad_medida,
             pr.pedido_unidad AS prod_pedido_unidad,
             pr.pedido_unidades_por_paquete AS prod_pedido_upp,
             cb.codigo AS codigo_barras
      FROM orden_compra_items oi
      LEFT JOIN productos pr ON pr.id = oi.producto_id
      LEFT JOIN codigos_barras cb ON cb.producto_id = oi.producto_id AND cb.es_principal = 1
      WHERE oi.orden_id = ?
      ORDER BY pr.nombre
    `, [ordenId]);

    return orden;
  }

  /**
   * Cambia el estado de una orden, registrando timestamps donde corresponde.
   * @param {string} ordenId
   * @param {'revisada'|'confirmada'|'enviada'} nuevoEstado
   */
  function cambiarEstado(ordenId, nuevoEstado) {
    const ts = now();
    const extraCols = {
      revisada:   ', revisada_en = ?',
      confirmada: ', confirmada_en = ?',
    };
    const extra = extraCols[nuevoEstado] || '';
    const params = extra
      ? [nuevoEstado, ts, ts, ordenId]
      : [nuevoEstado, ts, ordenId];

    db().run(
      `UPDATE ordenes_compra SET estado = ?, sync_status = 'pending', updated_at = ?${extra} WHERE id = ?`,
      params
    );
  }

  /**
   * Marca la orden para que el proximo push la suba.
   *
   * Los items NO tienen sync_status propio: viajan embebidos en la orden (ver
   * denormalizeOrden en sync.js), asi que alcanza con marcar el padre. Sin
   * esto, todo lo que se editaba desde el POS —marcarla revisada, sacar un
   * producto, corregir una cantidad— se quedaba en esa maquina: el push
   * selecciona por sync_status y la orden seguia figurando como 'synced'.
   */
  function marcarOrdenPendiente(ordenId) {
    if (!ordenId) return;
    db().run(
      `UPDATE ordenes_compra SET sync_status = 'pending', updated_at = ? WHERE id = ?`,
      [now(), ordenId]
    );
  }

  function ordenDeItem(itemId) {
    const r = db().query(
      `SELECT orden_id FROM orden_compra_items WHERE id = ?`, [itemId]
    )[0];
    return r ? r.orden_id : null;
  }

  /**
   * Guarda cantidad_final y notas de un item.
   */
  function guardarItem(itemId, cantidadFinal, notas) {
    db().run(
      `UPDATE orden_compra_items SET cantidad_final = ?, notas = ? WHERE id = ?`,
      [cantidadFinal, notas || null, itemId]
    );
    marcarOrdenPendiente(ordenDeItem(itemId));
  }

  /**
   * Elimina un item de la orden (solo en borrador/revisada).
   */
  function eliminarItem(itemId) {
    // El id de la orden hay que leerlo ANTES de borrar la fila.
    const ordenId = ordenDeItem(itemId);
    db().run(`DELETE FROM orden_compra_items WHERE id = ?`, [itemId]);
    marcarOrdenPendiente(ordenId);
  }

  /**
   * Agrega un producto manualmente a una orden.
   */
  function agregarItem(ordenId, productoId, sucursalId) {
    const prod = db().query(
      `SELECT id, nombre, stock_minimo, cant_pedido, pedido_unidad FROM productos WHERE id = ?`,
      [productoId]
    )[0];
    if (!prod) return false;

    const stockAct = stockEfectivo(productoId, sucursalId);
    const ts = now();

    db().run(`
      INSERT INTO orden_compra_items
        (id, orden_id, producto_id, cantidad_pedida, estado,
         stock_actual, stock_minimo, cantidad_deseada,
         ventas_30d, ventas_prom_6m, dias_sin_stock_6m,
         cantidad_sugerida, cantidad_final, unidad_pedida)
      VALUES (?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `, [
      uuid(), ordenId, productoId, prod.cant_pedido || 0,
      stockAct, prod.stock_minimo || 0, prod.cant_pedido || 0,
      ventasUltimos(productoId, 30),
      Math.round((ventasUltimos(productoId, 180) / 6) * 100) / 100,
      db().calcularDiasSinStock6m(productoId, sucursalId),
      prod.cant_pedido || 0,
      prod.pedido_unidad || 'unidad',
    ]);

    db().run(
      `UPDATE ordenes_compra SET sync_status = 'pending', updated_at = ? WHERE id = ?`,
      [ts, ordenId]
    );
    return true;
  }

  // ── UI STATE ─────────────────────────────────────────────────────────────────

  const ui = {
    view:          'lista',   // 'lista' | 'orden'
    filtroLista:   'activas',
    tabOrdenIds:   [],        // IDs de órdenes activas mostradas como tabs
    ordenActiva:   null,      // ID de la orden en el tab activo
    user:          null,
    kbHandler:     null,
    focusedItemId: null,      // ID del item con foco de teclado en la tabla
    panelAbierto: false,      // panel de acciones desplegado sobre la fila con foco
  };

  let agHlIdx = -1; // highlight index para el dropdown de agregar producto

  const ge  = id => document.getElementById(id);
  const esc = s  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);
  const fmtN = n => (n == null ? '—' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: 1 }));

  const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

  const PEDIDO_UNIDAD_LABEL = {
    unidad: 'Unidad', kg: 'Kg',
    bulto_cerrado: 'Bulto cerrado', pack: 'Pack', display: 'Display', bolsa: 'Bolsa',
  };
  const PEDIDO_UNIDAD_OPTIONS = [
    { v: 'unidad', l: 'Unidad' }, { v: 'kg', l: 'Kg' },
    { v: 'bulto_cerrado', l: 'Bulto cerrado' }, { v: 'pack', l: 'Pack' },
    { v: 'display', l: 'Display' }, { v: 'bolsa', l: 'Bolsa' },
  ];

  function labelApedir(cant, unidad) {
    const u = PEDIDO_UNIDAD_LABEL[unidad] || unidad || 'Unidad';
    return `${cant != null ? cant : '—'} ${u}`;
  }
  const ESTADO_LABEL = {
    borrador: 'Borrador', revisada: 'Revisada', confirmada: 'Confirmada',
    enviada: 'Enviada', recibiendo: 'Recibiendo',
    recibida_parcial: 'Parcial', cerrada: 'Cerrada',
  };
  const EDITABLE_ESTADOS = new Set(['borrador', 'revisada']);

  function showToast(msg, type = 'success') {
    window.SGA_Utils.showNotification(msg, type);
  }

  // ── VISTA LISTA ──────────────────────────────────────────────────────────────

  function showLista() {
    ui.view = 'lista';
    ge('ord-view-lista').style.display = '';
    ge('ord-view-orden').style.display = 'none';
    ge('ord-btn-back').style.display = 'none';
    ge('ord-header-title').textContent = 'Órdenes de Compra';
    teardownKeyboard();
    renderLista();
  }

  function renderLista() {
    const sucId  = ui.user.sucursal_id;
    const filtro = ui.filtroLista;

    const estadosFiltro = {
      activas:   ['borrador', 'revisada', 'confirmada'],
      enviadas:  ['enviada', 'recibiendo', 'recibida_parcial'],
      historial: ['cerrada'],
    };

    const ordenes = getOrdenes(sucId).filter(o =>
      (estadosFiltro[filtro] || []).includes(o.estado)
    );

    const tbody = ge('ord-lista-tbody');
    const empty = ge('ord-lista-empty');

    if (!ordenes.length) {
      tbody.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = ordenes.map(o => {
      const fecha = o.fecha_creacion ? o.fecha_creacion.slice(0, 10) : '—';
      return `<tr>
        <td>${esc(fecha)}</td>
        <td style="font-weight:600">${esc(o.proveedor_nombre || '—')}</td>
        <td style="text-align:center">${o.num_items || 0}</td>
        <td><span class="ord-badge ord-badge-${esc(o.estado)}">${esc(ESTADO_LABEL[o.estado] || o.estado)}</span></td>
        <td style="display:flex;gap:6px">
          <button class="ord-btn-sm-primary" data-abrir="${esc(o.id)}">Ver</button>
          <button class="ord-btn-sm ord-btn-eliminar" data-eliminar="${esc(o.id)}"
            data-prov="${esc(o.proveedor_nombre || '')}" title="Eliminar orden">🗑</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-abrir]').forEach(btn =>
      btn.addEventListener('click', () => abrirOrden(btn.dataset.abrir))
    );

    tbody.querySelectorAll('[data-eliminar]').forEach(btn =>
      btn.addEventListener('click', () => {
        const prov = btn.dataset.prov || 'esta orden';
        if (!confirm(`¿Eliminar la orden de ${prov}? Esta acción no se puede deshacer.`)) return;
        const ordenId = btn.dataset.eliminar;
        db().run(`DELETE FROM orden_compra_items WHERE orden_id = ?`, [ordenId]);
        db().run(`DELETE FROM ordenes_compra WHERE id = ?`, [ordenId]);
        // Deja la marca para que el borrado llegue a la otra maquina: un DELETE
        // por si solo no se puede sincronizar, la fila deja de existir y no hay
        // nada que pushear.
        db().registrarEliminacion('ordenes_compra', ordenId);
        renderLista();
      })
    );
  }

  // ── VISTA ORDEN ───────────────────────────────────────────────────────────────

  function abrirOrden(ordenId) {
    ui.view = 'orden';

    // Cargar todos los tabs activos (borrador + revisada + confirmada)
    const sucId = ui.user.sucursal_id;
    const activas = getOrdenes(sucId).filter(o =>
      ['borrador', 'revisada', 'confirmada', 'enviada'].includes(o.estado)
    );
    ui.tabOrdenIds = activas.map(o => o.id);

    // Si la orden pedida no está en activas, la agrego al inicio
    if (!ui.tabOrdenIds.includes(ordenId)) ui.tabOrdenIds.unshift(ordenId);
    ui.ordenActiva = ordenId;

    ge('ord-view-lista').style.display = 'none';
    ge('ord-view-orden').style.display = '';
    ge('ord-btn-back').style.display = '';
    ge('ord-header-title').textContent = 'Órdenes de Compra';

    renderTabs();
    renderOrden();
    setupKeyboard();
  }

  function renderTabs() {
    const tabBar = ge('ord-tab-bar');
    const ordenes = getOrdenes(ui.user.sucursal_id).filter(o =>
      ui.tabOrdenIds.includes(o.id)
    );
    // Mantener orden de tabOrdenIds
    const map = Object.fromEntries(ordenes.map(o => [o.id, o]));

    tabBar.innerHTML = ui.tabOrdenIds.map(id => {
      const o = map[id];
      if (!o) return '';
      const active = id === ui.ordenActiva ? ' active' : '';
      return `<button class="ord-tab${active}" data-tab="${esc(id)}">
        ${esc(o.proveedor_nombre || '—')}
        <span class="ord-tab-badge">${o.num_items || 0}</span>
      </button>`;
    }).join('');

    tabBar.querySelectorAll('[data-tab]').forEach(btn =>
      btn.addEventListener('click', () => {
        ui.ordenActiva = btn.dataset.tab;
        renderTabs();
        renderOrden();
      })
    );
  }

  function renderOrden() {
    const orden = getOrden(ui.ordenActiva);
    if (!orden) return;

    const editable = EDITABLE_ESTADOS.has(orden.estado);

    // Info bar
    ge('ord-infobar-proveedor').textContent = orden.proveedor_nombre || '—';
    const badge = ge('ord-infobar-badge');
    badge.textContent = ESTADO_LABEL[orden.estado] || orden.estado;
    badge.className = `ord-badge ord-badge-${orden.estado}`;
    ge('ord-infobar-fecha').textContent = orden.fecha_creacion
      ? 'Creada: ' + orden.fecha_creacion.slice(0, 10) : '';

    const notasInput = ge('ord-notas-input');
    notasInput.value = orden.notas || '';
    notasInput.disabled = !editable;
    notasInput.onblur = () => {
      if (editable) {
        db().run(
          `UPDATE ordenes_compra SET notas = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
          [notasInput.value || null, now(), orden.id]
        );
      }
    };

    // Items table
    renderItems(orden, editable);

    // Action buttons
    renderActionBtns(orden, editable);

    // Agregar producto — solo en editable
    ge('ord-btn-add-item').style.display = editable ? '' : 'none';
  }

  function setRowFocus(itemId) {
    const tbody = ge('ord-items-tbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr[data-item-id]').forEach(r =>
      r.classList.toggle('ord-row-focus', r.dataset.itemId === itemId)
    );
    ui.focusedItemId = itemId;
    tbody.querySelector(`tr[data-item-id="${itemId}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function renderItems(orden, editable) {
    const tbody = ge('ord-items-tbody');
    const thead = ge('ord-items-thead');

    if (editable) {
      thead.innerHTML = `<tr>
        <th style="text-align:left;min-width:90px">Cód. prov.</th>
        <th style="text-align:left">Descripción</th>
        <th>Stock act.</th>
        <th>Stock mín.</th>
        <th style="min-width:120px">A pedir</th>
        <th>Vtas 30d</th>
        <th>Prom. 6m</th>
        <th>Días s/stock</th>
        <th style="text-align:left;min-width:140px">Notas</th>
        <th></th>
      </tr>`;
    } else {
      thead.innerHTML = `<tr>
        <th style="text-align:left;min-width:90px">Cód. prov.</th>
        <th style="text-align:left">Descripción</th>
        <th style="min-width:120px">A pedir</th>
        <th style="text-align:left;min-width:140px">Notas</th>
        <th></th>
      </tr>`;
    }

    if (!orden.items.length) {
      tbody.innerHTML = `<tr><td colspan="${editable ? 10 : 5}" style="text-align:center;padding:24px;color:#8090a0">Sin productos en esta orden.</td></tr>`;
      return;
    }

    // Se reconstruye el tbody: el panel se va con el, asi que la bandera
    // tiene que acompanar o quedan atajos activos sin panel a la vista.
    ui.panelAbierto = false;

    tbody.innerHTML = orden.items.map(it => {
      const dias = it.dias_sin_stock_6m || 0;
      const diasCls = dias === 0 ? 'ord-dias-ok' : dias <= 5 ? 'ord-dias-warn' : 'ord-dias-crit';
      const cantFinal = it.cantidad_final != null ? it.cantidad_final : it.cantidad_sugerida;
      const unidad    = it.unidad_pedida || it.prod_pedido_unidad || 'unidad';

      if (editable) {
        // producto_id y nombre viajan en el <tr> porque el panel los necesita
        // y ya no hay botones por accion de donde leerlos.
        return `<tr data-item-id="${esc(it.id)}" data-prod="${esc(it.producto_id)}"
                    data-nombre="${esc(it.producto_nombre || '')}">
          <td><input class="ord-cell-input ord-cell-input-cod" type="text"
            value="${esc(it.codigo_proveedor || '')}" placeholder="—"
            style="width:80px;text-align:left"></td>
          <td>${esc(it.producto_nombre || '—')}</td>
          <td>${fmtN(it.stock_actual)}</td>
          <td>${fmtN(it.stock_minimo)}</td>
          <td>
            <div class="ord-apedir-wrap">
              <span class="ord-apedir-label">${esc(labelApedir(cantFinal, unidad))}</span>
              <button class="ord-btn-edit-cant" data-edit-cant="${esc(it.id)}"
                data-cant="${cantFinal}" data-unidad="${esc(unidad)}"
                title="Editar cantidad">✏</button>
            </div>
          </td>
          <td>${fmtN(it.ventas_30d)}</td>
          <td>${fmtN(it.ventas_prom_6m)}</td>
          <td class="${diasCls}">${dias}</td>
          <td><input class="ord-cell-input ord-cell-input-text" type="text"
            value="${esc(it.notas || '')}" placeholder="—"></td>
          <td class="ord-acciones-cell" style="white-space:nowrap;text-align:right">
            <button class="ord-mas-opciones" data-mas-opciones="${esc(it.id)}"
              title="Más opciones — flecha derecha">Más opciones <span class="ord-tecla-inline">→</span></button>
          </td>
        </tr>`;
      } else {
        return `<tr>
          <td>${esc(it.codigo_proveedor || '—')}</td>
          <td>${esc(it.producto_nombre || '—')}</td>
          <td style="font-weight:700">${esc(labelApedir(cantFinal, unidad))}</td>
          <td>${esc(it.notas || '—')}</td>
          <td></td>
        </tr>`;
      }
    }).join('');

    if (!editable) return;

    // Restaurar foco de teclado si el item sigue existiendo
    if (ui.focusedItemId) {
      const focusedRow = tbody.querySelector(`tr[data-item-id="${ui.focusedItemId}"]`);
      if (focusedRow) focusedRow.classList.add('ord-row-focus');
      else ui.focusedItemId = null;
    }

    // Click en fila → seleccionar con teclado
    tbody.querySelectorAll('tr[data-item-id]').forEach(r =>
      r.addEventListener('mousedown', () => setRowFocus(r.dataset.itemId))
    );

    // Auto-save notas y código proveedor on blur
    tbody.querySelectorAll('tr[data-item-id]').forEach(row => {
      const itemId  = row.dataset.itemId;
      const inputCod   = row.querySelector('.ord-cell-input-cod');
      const inputNotas = row.querySelector('.ord-cell-input-text');

      const saveRow = () => {
        const notas = inputNotas?.value?.trim() || null;
        const cod   = inputCod?.value?.trim() || null;
        db().run(
          `UPDATE orden_compra_items SET notas = ?, codigo_proveedor = ? WHERE id = ?`,
          [notas, cod, itemId]
        );
        marcarOrdenPendiente(ui.ordenActiva);
      };

      inputNotas?.addEventListener('blur', saveRow);
      inputCod?.addEventListener('blur', saveRow);
    });

    // Botón lápiz → overlay editar cantidad
    tbody.querySelectorAll('[data-edit-cant]').forEach(btn => {
      btn.addEventListener('click', () => {
        openEditCantOverlay(btn.dataset.editCant, Number(btn.dataset.cant), btn.dataset.unidad);
      });
    });

    tbody.querySelectorAll('[data-mas-opciones]').forEach(btn => {
      btn.addEventListener('click', () => {
        setRowFocus(btn.dataset.masOpciones);
        abrirPanelFila();
      });
    });

    // Eliminar item

  }

  // ── OVERLAY: EDITAR CANTIDAD ──────────────────────────────────────────────────

  // ── Panel de acciones de la fila ───────────────────────────────────────────
  //
  // Las tres primeras teclas solo valen con el panel abierto. Con el panel
  // cerrado, cualquier letra sigue yendo al campo Notas de la fila, que es como
  // funcionaba hasta ahora y se usa seguido: si las acciones tuvieran letra
  // suelta, escribir una nota seria imposible.
  const PANEL_ACCIONES = [
    { key: 'P',      tecla: 'P',     label: 'Cambiar proveedor', accion: 'prov' },
    { key: 'S',      tecla: 'S',     label: 'Asociar sustituto', accion: 'sust' },
    { key: 'Enter',  tecla: 'Enter', label: 'Editar cantidad',   accion: 'cant' },
    { key: 'Delete', tecla: 'Supr',  label: 'Quitar',            accion: 'del', peligro: true },
  ];

  /**
   * Quita un item de la orden, con confirmacion, y deja el foco en el que sigue.
   *
   * Vive en un solo lugar porque ahora la piden dos caminos: la tecla Supr y la
   * accion "Quitar" del panel.
   */
  function quitarItemConConfirm(itemId) {
    if (!itemId) return;
    if (!confirm('¿Eliminar este producto de la orden?')) return;

    const antes = Array.from(ge('ord-items-tbody')?.querySelectorAll('tr[data-item-id]') || [])
      .map(r => r.dataset.itemId);
    const pos = antes.indexOf(itemId);

    eliminarItem(itemId);
    ui.focusedItemId = null;
    renderOrden();
    renderTabs();

    const quedan = Array.from(ge('ord-items-tbody')?.querySelectorAll('tr[data-item-id]') || [])
      .map(r => r.dataset.itemId);
    if (quedan.length) setRowFocus(quedan[Math.min(Math.max(pos, 0), quedan.length - 1)]);
  }

  function cerrarPanelFila() {
    const tbody = ge('ord-items-tbody');
    tbody?.querySelector('.ord-panel-fila')?.remove();
    tbody?.querySelectorAll('.ord-panel-open')
      .forEach(c => c.classList.remove('ord-panel-open'));
    ui.panelAbierto = false;
  }

  function abrirPanelFila() {
    cerrarPanelFila();
    if (!ui.focusedItemId) return;
    const celda = ge('ord-items-tbody')
      ?.querySelector(`tr[data-item-id="${ui.focusedItemId}"] .ord-acciones-cell`);
    if (!celda) return;   // orden ya confirmada: la fila no es editable

    const div = document.createElement('div');
    div.className = 'ord-panel-fila';
    div.setAttribute('role', 'group');
    div.setAttribute('aria-label', 'Acciones del producto');
    div.innerHTML = PANEL_ACCIONES.map((a, i) =>
      (i === 2 ? '<span class="ord-panel-sep"></span>' : '') +
      `<button class="ord-panel-acc${a.peligro ? ' peligro' : ''}" data-panel-acc="${a.accion}">` +
        `<span class="ord-panel-tecla">${esc(a.tecla)}</span>${esc(a.label)}</button>`
    ).join('');

    div.querySelectorAll('[data-panel-acc]').forEach(b =>
      b.addEventListener('click', () => ejecutarAccionPanel(b.dataset.panelAcc))
    );
    celda.appendChild(div);
    // El panel tapa la celda: el "Mas opciones" ya no aplica mientras esta abierto.
    celda.classList.add('ord-panel-open');
    ui.panelAbierto = true;
  }

  function ejecutarAccionPanel(accion) {
    const itemId = ui.focusedItemId;
    const row = ge('ord-items-tbody')?.querySelector(`tr[data-item-id="${itemId}"]`);
    if (!row) return;
    const prodId = row.dataset.prod;
    const nombre = row.dataset.nombre;
    cerrarPanelFila();

    if (accion === 'prov')      openCambiarProvOverlay(itemId, prodId, nombre);
    else if (accion === 'sust') openSustitutoOverlay(itemId, prodId, nombre);
    else if (accion === 'del')  quitarItemConConfirm(itemId);
    // Editar cantidad sigue teniendo su propio boton en la columna "A pedir",
    // asi que ahi si conviene reusarlo y no duplicar la lectura de la fila.
    else if (accion === 'cant') row.querySelector('[data-edit-cant]')?.click();
  }

  // ── Asociar sustituto ──────────────────────────────────────────────────────

  /** Miembros del grupo de sustitutos al que pertenece un producto (vacio si no tiene). */
  function miembrosDelGrupo(prodId) {
    const ref = db().query(
      `SELECT referencia_id FROM producto_sustitutos
       WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`,
      [prodId]
    )[0];
    if (!ref) return [];
    return db().query(`
      SELECT DISTINCT ps.producto_id AS id, p.nombre
      FROM producto_sustitutos ps
      JOIN productos p ON p.id = ps.producto_id
      WHERE ps.referencia_id = ?
      ORDER BY p.nombre COLLATE NOCASE ASC
    `, [ref.referencia_id]);
  }

  /**
   * Deja a dos productos en el mismo grupo, con la referencia elegida.
   *
   * Si alguno ya pertenecia a un grupo, ese grupo entero se repunta a la nueva
   * referencia — misma logica que setReferencia() en el editor de producto.
   */
  function asociarAlGrupo(prodA, prodB, refId) {
    const fecha = window.SGA_Utils.formatISODate(new Date());
    const ts    = now();

    const viejas = db().query(
      `SELECT DISTINCT referencia_id FROM producto_sustitutos
       WHERE producto_id IN (?, ?) AND referencia_id IS NOT NULL`,
      [prodA, prodB]
    ).map(r => r.referencia_id).filter(r => r && r !== refId);

    for (const vieja of viejas) {
      db().run(
        `UPDATE producto_sustitutos SET referencia_id = ?, sustituto_id = ?
         WHERE referencia_id = ?`,
        [refId, refId, vieja]
      );
    }

    for (const pid of [prodA, prodB, refId]) {
      db().run(
        `INSERT OR REPLACE INTO producto_sustitutos
           (producto_id, sustituto_id, referencia_id, activo, fecha_asignacion)
         VALUES (?, ?, ?, 1, ?)`,
        [pid, refId, refId, fecha]
      );
    }

    // El grupo viaja embebido en el documento de cada producto (ver
    // applyProductoFull en sync.js), asi que hay que marcarlos pendientes uno
    // por uno: sin esto el agrupamiento se queda en esta maquina.
    const miembros = db().query(
      `SELECT DISTINCT producto_id FROM producto_sustitutos WHERE referencia_id = ?`,
      [refId]
    ).map(r => r.producto_id);

    for (const pid of new Set([...miembros, prodA, prodB, refId])) {
      db().run(
        `UPDATE productos SET sync_status = 'pending', updated_at = ? WHERE id = ?`,
        [ts, pid]
      );
    }
  }

  /**
   * Asocia un sustituto sin salir de la revision de la orden.
   *
   * Al asociar, el grupo pasa a pedirse a traves de una sola referencia y su
   * stock efectivo es la suma del grupo. Por eso, si este producto deja de ser
   * la referencia —o si el stock del grupo ya cubre el minimo— sale de la orden:
   * es exactamente el criterio con que se genero.
   */
  function openSustitutoOverlay(itemId, productoId, productoNombre) {
    const overlay = ge('ord-sustituto-overlay');
    if (!overlay) return;

    const search   = ge('ord-sust-search');
    const results  = ge('ord-sust-results');
    const confirm_ = ge('ord-sust-confirm');
    const selRef   = ge('ord-sust-ref');
    const aviso    = ge('ord-sust-aviso');
    const btnOk    = ge('ord-sust-ok');

    let elegido = null;   // { id, nombre }
    let hl = -1;          // resultado resaltado con las flechas

    const grupo = miembrosDelGrupo(productoId);
    ge('ord-sust-producto').textContent = productoNombre || 'Producto';
    ge('ord-sust-grupo').textContent = grupo.length
      ? 'Ya está agrupado con: ' + grupo.filter(m => m.id !== productoId)
          .map(m => m.nombre).join(', ')
      : 'Todavía no pertenece a ningún grupo de sustitutos.';

    search.value = '';
    results.innerHTML = '';
    confirm_.style.display = 'none';
    btnOk.disabled = true;

    const pintarAviso = () => {
      const refId = selRef.value;
      aviso.textContent = refId === productoId
        ? `Se sigue pidiendo ${productoNombre}, y su stock ahora suma el del grupo. ` +
          'Si con eso ya supera el mínimo, sale de esta orden.'
        : `El grupo pasa a pedirse a través de ${selRef.selectedOptions[0]?.textContent || 'la referencia'}, ` +
          `así que ${productoNombre} sale de esta orden.`;
    };

    const elegir = (id, nombre) => {
      elegido = { id, nombre };
      const opciones = [];
      const vistos = new Set();
      for (const m of [...grupo, ...miembrosDelGrupo(id),
                       { id: productoId, nombre: productoNombre }, { id, nombre }]) {
        if (m.id && !vistos.has(m.id)) { vistos.add(m.id); opciones.push(m); }
      }
      const refActual = grupo.length
        ? db().query(`SELECT referencia_id FROM producto_sustitutos
                      WHERE producto_id = ? AND referencia_id IS NOT NULL LIMIT 1`,
                     [productoId])[0]?.referencia_id
        : null;
      // Por defecto, el producto que acabas de buscar: lo normal es marcar que
      // el de la orden ya esta cubierto por ese otro.
      const porDefecto = refActual || id;
      selRef.innerHTML = opciones
        .map(o => `<option value="${esc(o.id)}"${o.id === porDefecto ? ' selected' : ''}>${esc(o.nombre)}</option>`)
        .join('');
      confirm_.style.display = '';
      btnOk.disabled = false;
      pintarAviso();
      // Elegido el producto, lo que sigue es decidir a cual se le pide.
      setTimeout(() => selRef.focus(), 0);
    };

    const buscar = (q) => {
      hl = -1;
      if (!q.trim()) { results.innerHTML = ''; return; }
      const vars = Buscador.variantesCodigo(q);
      const res = db().query(`
        SELECT DISTINCT p.id, p.nombre, COALESCE(st.cantidad, 0) AS stock
        FROM productos p
        LEFT JOIN stock st ON st.producto_id = p.id AND st.sucursal_id = ?
        LEFT JOIN codigos_barras cb ON cb.producto_id = p.id
        WHERE p.activo = 1 AND p.id != ?
          AND (p.nombre LIKE ? OR cb.codigo IN (${vars.map(() => '?').join(',') || "''"}))
        LIMIT 20
      `, [ui.user.sucursal_id, productoId, `%${q}%`, ...vars]);

      results.innerHTML = res.length
        ? res.map(p => `
            <div class="ord-search-result" data-sust-pick="${esc(p.id)}" data-nom="${esc(p.nombre)}">
              <span style="font-weight:600">${esc(p.nombre)}</span>
              <span style="color:#607080;font-size:11px">Stock: ${fmtN(p.stock)}</span>
            </div>`).join('')
        : '<p style="color:#8090a0;padding:8px 0">Sin resultados.</p>';

      results.querySelectorAll('[data-sust-pick]').forEach(el =>
        el.addEventListener('click', () => {
          results.querySelectorAll('.ord-search-result')
                 .forEach(r => r.classList.toggle('highlighted', r === el));
          elegir(el.dataset.sustPick, el.dataset.nom);
        })
      );
    };

    const cerrar = () => { overlay.style.display = 'none'; };

    const guardar = () => {
      if (!elegido) return;
      const refId = selRef.value;
      asociarAlGrupo(productoId, elegido.id, refId);

      const stockGrupo = stockEfectivo(refId, ui.user.sucursal_id);
      const item = db().query(
        `SELECT stock_minimo FROM orden_compra_items WHERE id = ?`, [itemId]
      )[0] || {};
      const min = item.stock_minimo || 0;

      cerrar();

      // Sale de la orden si ya no es la referencia (el grupo se pide por ella)
      // o si el stock sumado del grupo ya cubre el minimo.
      const yaNoEsReferencia = refId !== productoId;
      const stockAlcanza     = stockGrupo - min > 0;

      if (yaNoEsReferencia || stockAlcanza) {
        eliminarItem(itemId);
        ui.focusedItemId = null;
        renderOrden();
        renderTabs();
        showToast(yaNoEsReferencia
          ? `Agrupado. La orden ahora le pide a ${elegido.nombre}`
          : 'Agrupado. Con el stock del grupo ya no hace falta pedirlo', 'success');
        return;
      }

      // Sigue haciendo falta: al menos que la fila muestre el stock real del grupo.
      db().run(`UPDATE orden_compra_items SET stock_actual = ? WHERE id = ?`,
               [stockGrupo, itemId]);
      marcarOrdenPendiente(ui.ordenActiva);
      renderOrden();
      showToast('Agrupado. Sigue haciendo falta pedirlo', 'success');
    };

    // Navegacion de la lista con el teclado, igual que el buscador de "Agregar
    // producto": las flechas mueven el resaltado y Enter elige.
    const resultados = () => results.querySelectorAll('[data-sust-pick]');
    const resaltar = (i) => {
      const els = resultados();
      hl = Math.max(-1, Math.min(i, els.length - 1));
      els.forEach((el, n) => el.classList.toggle('highlighted', n === hl));
      if (hl >= 0) els[hl].scrollIntoView({ block: 'nearest' });
    };

    overlay.style.display = 'flex';
    setTimeout(() => search.focus(), 60);

    search.oninput  = () => buscar(search.value);
    selRef.onchange = pintarAviso;
    btnOk.onclick   = guardar;
    ge('ord-sust-cancel').onclick = cerrar;
    ge('ord-sust-close').onclick  = cerrar;

    // Clic fuera del cuadro cierra, como en los demas dialogos de la pantalla.
    overlay.onclick = e => { if (e.target === overlay) cerrar(); };

    // Escape desde cualquier parte del dialogo, no solo desde el buscador: si
    // el foco estaba en la lista o en el selector, antes no habia forma de salir
    // con el teclado. stopPropagation para no disparar tambien el de la tabla.
    overlay.onkeydown = e => {
      if (e.key === 'Escape') { e.stopPropagation(); cerrar(); }
    };

    search.onkeydown = e => {
      const els = resultados();
      if (e.key === 'ArrowDown') { e.preventDefault(); if (els.length) resaltar(hl + 1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); resaltar(hl - 1); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (hl >= 0 && els[hl]) els[hl].click();
        else if (elegido) guardar();
      }
    };

    // Con el producto ya elegido, Enter sobre el selector confirma.
    selRef.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); guardar(); }
    };
  }

  /**
   * Cambia el proveedor de un producto desde la revision de una orden.
   *
   * Al confirmar pasan dos cosas: el producto queda asignado al proveedor
   * nuevo y sale de esta orden, que es de otro proveedor y por lo tanto ya no
   * le corresponde.
   */
  function openCambiarProvOverlay(itemId, productoId, productoNombre) {
    const overlay = ge('ord-cambiar-prov-overlay');
    const select   = ge('ord-cambprov-select');
    const aviso    = ge('ord-cambprov-aviso');
    const titulo   = ge('ord-cambprov-producto');
    if (!overlay || !select) return;

    const orden = getOrden(ui.ordenActiva);
    const provOrdenId = orden?.proveedor_id || null;

    const prod = db().query(
      `SELECT proveedor_principal_id, proveedor_alternativo_id FROM productos WHERE id = ?`,
      [productoId]
    )[0] || {};

    const proveedores = db().query(
      `SELECT id, razon_social FROM proveedores WHERE activo = 1
       ORDER BY razon_social COLLATE NOCASE ASC`
    ) || [];

    titulo.textContent = productoNombre || 'Producto';
    select.innerHTML =
      '<option value="">— Seleccionar proveedor —</option>' +
      proveedores
        .filter(p => p.id !== provOrdenId)   // el de esta orden es justamente el que no va
        .map(p => `<option value="${esc(p.id)}">${esc(p.razon_social)}</option>`)
        .join('');

    // Si el proveedor de esta orden figura como alternativo del producto, hay
    // que sacarlo tambien: la orden se arma con
    // (proveedor_principal_id = ? OR proveedor_alternativo_id = ?), asi que si
    // queda, el producto vuelve a aparecer en la proxima orden de este mismo
    // proveedor y el cambio no sirve de nada.
    const eraAlternativo = prod.proveedor_alternativo_id
      && prod.proveedor_alternativo_id === provOrdenId;

    aviso.innerHTML = 'El producto se quita de esta orden y queda asignado al proveedor elegido.'
      + (eraAlternativo
          ? '<br>También se lo va a quitar como proveedor alternativo, porque si no volvería a aparecer en la próxima orden.'
          : '');

    overlay.style.display = 'flex';
    setTimeout(() => select.focus(), 60);

    const cerrar = () => { overlay.style.display = 'none'; };

    const doSave = () => {
      const nuevoProv = select.value;
      if (!nuevoProv) { showToast('Elegí un proveedor', 'error'); return; }

      const ts = now();
      const campos = ['proveedor_principal_id = ?'];
      const vals   = [nuevoProv];
      if (eraAlternativo) { campos.push('proveedor_alternativo_id = NULL'); }
      campos.push("sync_status = 'pending'", 'updated_at = ?');
      vals.push(ts, productoId);

      db().run(`UPDATE productos SET ${campos.join(', ')} WHERE id = ?`, vals);

      // Sale de esta orden (eliminarItem ya marca la orden como pendiente)
      eliminarItem(itemId);

      cerrar();
      renderOrden();
      const nombreProv = proveedores.find(p => p.id === nuevoProv)?.razon_social || 'el nuevo proveedor';
      showToast(`Producto reasignado a ${nombreProv} y quitado de esta orden`, 'success');
    };

    ge('ord-cambprov-ok').onclick     = doSave;
    ge('ord-cambprov-cancel').onclick = cerrar;
    ge('ord-cambprov-close').onclick  = cerrar;
    select.onkeydown = e => {
      if (e.key === 'Enter')  doSave();
      if (e.key === 'Escape') cerrar();
    };
  }

  function openEditCantOverlay(itemId, cantActual, unidadActual) {
    const overlay = ge('ord-edit-cant-overlay');
    const inputCant   = ge('ord-editcant-cant');
    const selectUnidad = ge('ord-editcant-unidad');

    inputCant.value = cantActual != null ? cantActual : '';
    selectUnidad.value = unidadActual || 'unidad';
    overlay.style.display = 'flex';
    setTimeout(() => inputCant.focus(), 60);

    const doSave = () => {
      const cant   = parseFloat(inputCant.value);
      const unidad = selectUnidad.value;
      if (isNaN(cant) || cant < 0) { showToast('Ingresá una cantidad válida', 'error'); return; }
      db().run(
        `UPDATE orden_compra_items SET cantidad_final = ?, unidad_pedida = ? WHERE id = ?`,
        [cant, unidad, itemId]
      );
      marcarOrdenPendiente(ui.ordenActiva);
      overlay.style.display = 'none';
      renderOrden();
    };

    ge('ord-editcant-ok').onclick  = doSave;
    ge('ord-editcant-cancel').onclick = () => { overlay.style.display = 'none'; };
    inputCant.onkeydown = e => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') overlay.style.display = 'none'; };
  }

  function renderActionBtns(orden, editable) {
    const cont = ge('ord-action-btns');
    const btns = [];

    if (editable) {
      btns.push(`<button class="ord-btn-action ord-btn-save" id="ord-btn-guardar">✓ Guardar borrador</button>`);
    }
    if (orden.estado === 'borrador') {
      btns.push(`<button class="ord-btn-action ord-btn-revisar" id="ord-btn-revisar">Marcar revisada - F2</button>`);
    }
    if (orden.estado === 'revisada') {
      btns.push(`<button class="ord-btn-action ord-btn-confirmar" id="ord-btn-confirmar">Confirmar - F2</button>`);
    }
    if (orden.estado === 'confirmada') {
      btns.push(`<button class="ord-btn-action ord-btn-enviar" id="ord-btn-enviar">Enviar</button>`);
    }
    if (!editable) {
      btns.push(`<button class="ord-btn-action ord-btn-exportar" id="ord-btn-exportar">📷 Exportar imagen</button>`);
    }

    cont.innerHTML = btns.join('');

    ge('ord-btn-guardar')?.addEventListener('click', () => {
      showToast('Orden guardada');
    });

    ge('ord-btn-revisar')?.addEventListener('click', () => {
      if (!confirm('¿Marcar esta orden como revisada?')) return;
      cambiarEstado(ui.ordenActiva, 'revisada');
      renderOrden();
      renderTabs();
      showToast('Orden marcada como revisada');
    });

    ge('ord-btn-confirmar')?.addEventListener('click', () => {
      if (!confirm('¿Confirmar esta orden? Quedará en solo lectura hasta el envío.')) return;
      cambiarEstado(ui.ordenActiva, 'confirmada');
      renderOrden();
      renderTabs();
      showToast('Orden confirmada');
    });

    ge('ord-btn-enviar')?.addEventListener('click', () => {
      if (!confirm('¿Marcar esta orden como enviada al proveedor?')) return;
      cambiarEstado(ui.ordenActiva, 'enviada');
      renderOrden();
      renderTabs();
      showToast('Orden enviada');
    });

    ge('ord-btn-exportar')?.addEventListener('click', () => exportarImagen(orden));
  }

  // ── EXPORTAR IMAGEN ───────────────────────────────────────────────────────────

  async function exportarImagen(orden) {
    if (!window.html2canvas) {
      showToast('html2canvas no disponible', 'error');
      return;
    }

    const btn = ge('ord-btn-exportar');
    btn.disabled = true;
    btn.textContent = 'Generando…';

    try {
      const fecha = (orden.fecha_creacion || '').slice(0, 10);
      const prov  = orden.proveedor_nombre || '—';

      // Construir tabla limpia para exportar
      const filas = orden.items.map(it => {
        const cantFinal = it.cantidad_final != null ? it.cantidad_final : it.cantidad_sugerida;
        const unidad    = it.unidad_pedida || it.prod_pedido_unidad || 'unidad';
        return `<tr>
          <td>${esc(it.producto_nombre || '—')}</td>
          <td>${esc(labelApedir(cantFinal, unidad))}</td>
        </tr>`;
      }).join('');

      const html = `
        <div id="ord-export-wrap" style="
          font-family: Arial, sans-serif;
          background: #fff;
          padding: 24px 28px;
          display: inline-block;
          box-sizing: border-box;
        ">
          <div style="margin-bottom: 16px;">
            <div style="font-size: 20px; font-weight: 800; color: #000; margin-bottom: 4px;">${esc(prov)}</div>
            <div style="font-size: 13px; color: #444;">${fecha}</div>
          </div>
          <table style="
            width: auto; border-collapse: collapse;
            font-size: 13px; color: #000; white-space: nowrap;
          ">
            <thead>
              <tr style="background: #1a2e4a;">
                <th style="
                  padding: 9px 12px; text-align: left; color: #fff;
                  font-weight: 700; font-size: 12px; text-transform: uppercase;
                  letter-spacing: 0.04em; border: 1px solid #1a2e4a;
                ">Descripción</th>
                <th style="
                  padding: 9px 12px; text-align: right; color: #fff;
                  font-weight: 700; font-size: 12px; text-transform: uppercase;
                  letter-spacing: 0.04em; border: 1px solid #1a2e4a;
                ">Pedido</th>
              </tr>
            </thead>
            <tbody>
              ${orden.items.map((it, i) => {
                const cantFinal = it.cantidad_final != null ? it.cantidad_final : it.cantidad_sugerida;
                const unidad    = it.unidad_pedida || it.prod_pedido_unidad || 'unidad';
                const bg = i % 2 === 0 ? '#fff' : '#f4f6f9';
                return `<tr style="background:${bg}">
                  <td style="padding: 8px 12px; border: 1px solid #d0d7e3; color: #000;">${esc(it.producto_nombre || '—')}</td>
                  <td style="padding: 8px 12px; border: 1px solid #d0d7e3; color: #000; text-align: right; font-weight: 600;">${esc(labelApedir(cantFinal, unidad))}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;

      // Insertar en DOM oculto, capturar, eliminar
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1';
      container.innerHTML = html;
      document.body.appendChild(container);
      const target = container.querySelector('#ord-export-wrap');

      const canvas = await window.html2canvas(target, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false,
      });

      document.body.removeChild(container);

      const provFile = prov.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ ]/g, '').trim().replace(/\s+/g, '_');
      const filename = `orden_${provFile}_${fecha}.png`;

      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }, 'image/png');

      showToast('Imagen exportada');
    } catch (e) {
      console.error('exportarImagen:', e);
      showToast('Error al exportar imagen', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '📷 Exportar imagen';
    }
  }

  // ── TECLADO ──────────────────────────────────────────────────────────────────

  function setupKeyboard() {
    teardownKeyboard();
    ui.kbHandler = (e) => {
      // Navegación de tabs (siempre activa)
      if (e.ctrlKey) {
        if (e.key === 'PageDown') { e.preventDefault(); moveTab(1); }
        if (e.key === 'PageUp')   { e.preventDefault(); moveTab(-1); }
        return;
      }

      if (ui.view !== 'orden') return;

      // F2 → Marcar revisada (funciona desde cualquier lugar en la vista de orden)
      if (e.key === 'F2') {
        e.preventDefault();
        ge('ord-btn-revisar')?.click();
        ge('ord-btn-confirmar')?.click();
        return;
      }

      // Si hay overlays abiertos, no interceptar más teclas (cada overlay maneja las suyas)
      const overlayAbierto = ['ord-edit-cant-overlay', 'ord-agregar-overlay',
                              'ord-cambiar-prov-overlay', 'ord-sustituto-overlay']
        .some(id => ge(id)?.style.display === 'flex');
      if (overlayAbierto) return;

      const tag     = document.activeElement?.tagName?.toLowerCase();
      const inInput = tag === 'input' || tag === 'select' || tag === 'textarea';

      const getItemIds = () =>
        Array.from(ge('ord-items-tbody')?.querySelectorAll('tr[data-item-id]') || [])
          .map(r => r.dataset.itemId);

      // ArrowDown / ArrowUp — navegar filas (solo si no estamos dentro de un input)
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !inInput) {
        e.preventDefault();
        const ids = getItemIds();
        if (!ids.length) return;
        const idx  = ids.indexOf(ui.focusedItemId);
        const next = e.key === 'ArrowDown'
          ? Math.min(ids.length - 1, idx === -1 ? 0 : idx + 1)
          : Math.max(0, idx === -1 ? 0 : idx - 1);
        cerrarPanelFila();
        setRowFocus(ids[next]);
        return;
      }

      // → abre el panel de acciones de la fila; ← / Esc lo cierran
      if (e.key === 'ArrowRight' && !inInput && ui.focusedItemId && !ui.panelAbierto) {
        e.preventDefault();
        abrirPanelFila();
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'Escape') && !inInput && ui.panelAbierto) {
        e.preventDefault();
        cerrarPanelFila();
        return;
      }

      // Enter — abrir overlay de editar cantidad para la fila seleccionada
      if (e.key === 'Enter' && !inInput && ui.focusedItemId) {
        e.preventDefault();
        cerrarPanelFila();
        const row = ge('ord-items-tbody')?.querySelector(`tr[data-item-id="${ui.focusedItemId}"]`);
        row?.querySelector('[data-edit-cant]')?.click();
        return;
      }

      // Supr — eliminar fila seleccionada
      if (e.key === 'Delete' && !inInput && ui.focusedItemId) {
        e.preventDefault();
        cerrarPanelFila();
        quitarItemConConfirm(ui.focusedItemId);
        return;
      }

      // Con el panel abierto, las letras ejecutan la accion. Va antes del bloque
      // de Notas a proposito: si no, la "P" se escribiria en el campo.
      if (ui.panelAbierto && !inInput && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const acc = PANEL_ACCIONES.find(a => a.key === e.key.toUpperCase());
        if (acc) {
          e.preventDefault();
          ejecutarAccionPanel(acc.accion);
          return;
        }
      }

      // Carácter imprimible → focus al campo Notas de la fila seleccionada
      if (!inInput && ui.focusedItemId && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const row = ge('ord-items-tbody')?.querySelector(`tr[data-item-id="${ui.focusedItemId}"]`);
        const notasInput = row?.querySelector('.ord-cell-input-text');
        if (notasInput) {
          e.preventDefault();
          notasInput.focus();
          notasInput.value += e.key;
          notasInput.setSelectionRange(notasInput.value.length, notasInput.value.length);
        }
        return;
      }
    };
    document.addEventListener('keydown', ui.kbHandler);
  }

  function teardownKeyboard() {
    if (ui.kbHandler) {
      document.removeEventListener('keydown', ui.kbHandler);
      ui.kbHandler = null;
    }
  }

  function moveTab(delta) {
    const idx = ui.tabOrdenIds.indexOf(ui.ordenActiva);
    if (idx === -1) return;
    const next = Math.max(0, Math.min(ui.tabOrdenIds.length - 1, idx + delta));
    if (next === idx) return;
    ui.ordenActiva = ui.tabOrdenIds[next];
    renderTabs();
    renderOrden();
  }

  // ── MODAL: GENERAR ÓRDENES ───────────────────────────────────────────────────

  function openGenerarModal() {
    const sucId = ui.user.sucursal_id;
    const todayWd = (new Date().getDay() + 6) % 7; // 0=Lun…6=Dom

    const proveedores = db().query(`
      SELECT p.id, p.razon_social, p.order_day,
        EXISTS(
          SELECT 1 FROM ordenes_compra oc
          WHERE oc.proveedor_id = p.id AND oc.sucursal_id = ?
            AND oc.estado IN ('borrador','revisada','confirmada','enviada')
            AND date(oc.fecha_creacion) = date('now')
        ) AS tiene_orden_hoy
      FROM proveedores p
      WHERE p.activo = 1
      ORDER BY p.razon_social
    `, [sucId]);

    const body = ge('ord-generar-body');
    if (!proveedores.length) {
      body.innerHTML = '<p style="color:#8090a0;text-align:center;padding:20px 0">No hay proveedores activos.</p>';
    } else {
      body.innerHTML = proveedores.map(p => {
        const esHoy = p.order_day === todayWd && !p.tiene_orden_hoy;
        const dayLabel = p.order_day != null ? DIAS_SEMANA[p.order_day] : '';
        return `<label class="ord-prov-item${esHoy ? ' today' : ''}">
          <input type="checkbox" value="${esc(p.id)}" ${esHoy ? 'checked' : ''}>
          <span class="ord-prov-name">${esc(p.razon_social)}</span>
          ${dayLabel ? `<span class="ord-prov-day">📅 ${dayLabel}</span>` : ''}
          ${p.tiene_orden_hoy ? '<span style="font-size:11px;color:#607080">Ya tiene orden hoy</span>' : ''}
        </label>`;
      }).join('');
    }

    ge('ord-generar-overlay').style.display = 'flex';
  }

  function ejecutarGenerar() {
    const checks = ge('ord-generar-body').querySelectorAll('input[type=checkbox]:checked');
    const ids = [...checks].map(c => c.value);
    if (!ids.length) { showToast('Seleccioná al menos un proveedor', 'error'); return; }

    const sucId = ui.user.sucursal_id;
    const nuevasIds = [];
    const msgs = [];

    for (const provId of ids) {
      const res = generarOrdenCompra(provId, sucId);
      if (!res.success) {
        msgs.push(`Error: ${res.message}`);
      } else if (!res.ordenId) {
        msgs.push(res.message);
      } else {
        nuevasIds.push(res.ordenId);
      }
    }

    ge('ord-generar-overlay').style.display = 'none';

    if (msgs.length) showToast(msgs.join(' | '), 'info');

    if (nuevasIds.length) {
      showToast(`${nuevasIds.length} orden(es) generada(s)`);
      // Abrir la primera orden generada (el resto queda en tabs)
      abrirOrden(nuevasIds[0]);
    }
  }

  // ── MODAL: AGREGAR PRODUCTO ───────────────────────────────────────────────────

  function openAgregarModal() {
    agHlIdx = -1;
    ge('ord-agregar-search').value = '';
    ge('ord-agregar-results').innerHTML = '';
    ge('ord-agregar-overlay').style.display = 'flex';
    setTimeout(() => ge('ord-agregar-search')?.focus(), 80);
  }

  function buscarProductosAgregar(q) {
    agHlIdx = -1;
    if (!q.trim()) { ge('ord-agregar-results').innerHTML = ''; return; }
    const res = db().query(`
      SELECT p.id, p.nombre, COALESCE(st.cantidad, 0) AS stock
      FROM productos p
      LEFT JOIN stock st ON st.producto_id = p.id AND st.sucursal_id = ?
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      WHERE p.activo = 1
        AND (p.nombre LIKE ? OR cb.codigo IN (${Buscador.variantesCodigo(q).map(() => '?').join(',') || "''"}))
      LIMIT 20
    `, [ui.user.sucursal_id, `%${q}%`, ...Buscador.variantesCodigo(q)]);

    ge('ord-agregar-results').innerHTML = res.length
      ? res.map(p => `
          <div class="ord-search-result" data-add-prod="${esc(p.id)}">
            <span style="font-weight:600">${esc(p.nombre)}</span>
            <span style="color:#607080;font-size:11px">Stock: ${fmtN(p.stock)}</span>
          </div>`).join('')
      : '<p style="color:#8090a0;padding:8px 0">Sin resultados.</p>';

    ge('ord-agregar-results').querySelectorAll('[data-add-prod]').forEach(el =>
      el.addEventListener('click', () => {
        const ok = agregarItem(ui.ordenActiva, el.dataset.addProd, ui.user.sucursal_id);
        ge('ord-agregar-overlay').style.display = 'none';
        if (ok) { renderOrden(); renderTabs(); showToast('Producto agregado'); }
        else showToast('Error al agregar producto', 'error');
      })
    );
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────

  function init() {
    ui.user = window.SGA_Auth.getCurrentUser();

    // ── Botones header
    ge('ord-btn-back')?.addEventListener('click', showLista);
    ge('ord-btn-generar')?.addEventListener('click', openGenerarModal);

    // ── Filtros lista
    ge('ord-view-lista')?.querySelectorAll('[data-filter]').forEach(btn =>
      btn.addEventListener('click', () => {
        ui.filtroLista = btn.dataset.filter;
        ge('ord-view-lista').querySelectorAll('[data-filter]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        renderLista();
      })
    );

    // ── Modal generar
    const closeGenerar = () => ge('ord-generar-overlay').style.display = 'none';
    ge('ord-generar-close')?.addEventListener('click', closeGenerar);
    ge('ord-generar-cancel')?.addEventListener('click', closeGenerar);
    ge('ord-generar-overlay')?.addEventListener('click', e => {
      if (e.target === ge('ord-generar-overlay')) closeGenerar();
    });
    ge('ord-generar-ok')?.addEventListener('click', ejecutarGenerar);

    // ── Modal agregar producto
    const closeAgregar = () => ge('ord-agregar-overlay').style.display = 'none';
    ge('ord-agregar-close')?.addEventListener('click', closeAgregar);
    ge('ord-agregar-overlay')?.addEventListener('click', e => {
      if (e.target === ge('ord-agregar-overlay')) closeAgregar();
    });
    ge('ord-agregar-search')?.addEventListener('input', e =>
      buscarProductosAgregar(e.target.value)
    );
    ge('ord-agregar-search')?.addEventListener('keydown', e => {
      const items = ge('ord-agregar-results')?.querySelectorAll('[data-add-prod]') || [];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!items.length) return;
        agHlIdx = Math.min(agHlIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('highlighted', i === agHlIdx));
        items[agHlIdx]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        agHlIdx = Math.max(agHlIdx - 1, -1);
        items.forEach((el, i) => el.classList.toggle('highlighted', i === agHlIdx));
        items[agHlIdx]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (agHlIdx >= 0 && items[agHlIdx]) { items[agHlIdx].click(); agHlIdx = -1; }
        return;
      }
      if (e.key === 'Escape') {
        ge('ord-agregar-overlay').style.display = 'none';
        agHlIdx = -1;
        e.stopPropagation();
      }
    });
    ge('ord-btn-add-item')?.addEventListener('click', openAgregarModal);

    // ── Overlay editar cantidad
    ge('ord-editcant-close')?.addEventListener('click', () => {
      ge('ord-edit-cant-overlay').style.display = 'none';
    });
    ge('ord-edit-cant-overlay')?.addEventListener('click', e => {
      if (e.target === ge('ord-edit-cant-overlay')) ge('ord-edit-cant-overlay').style.display = 'none';
    });

    // ── Vista inicial
    showLista();
  }

  return {
    init,
    // Igual que en compras_v2: la limpieza estaba escrita pero sin exportar.
    destroy: teardownKeyboard,
    // Data API — accesible desde otros módulos si se necesita
    generarOrdenCompra,
    getOrdenes,
    getOrden,
    cambiarEstado,
    guardarItem,
    eliminarItem,
    agregarItem,
    stockEfectivo,
  };
})();

window.SGA_Ordenes = Ordenes;
export default Ordenes;
