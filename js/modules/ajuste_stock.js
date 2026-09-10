/**
 * ajuste_stock.js - Ajuste de stock (egreso)
 *
 * Mismo circuito que Roturas, Vencimientos y Consumo interno: se buscan
 * productos, se arma un carrito y al confirmar se descuenta el stock dejando
 * el rastro en consumo_interno + stock_ajustes. Lo unico que cambia es el
 * motivo, que aca queda como 'ajuste_negativo'.
 *
 * OJO: esto solo DESCUENTA. Un recuento que da de mas necesita un ajuste
 * positivo, que todavia no existe como pantalla (el tipo 'ajuste_positivo' ya
 * existe en stock_ajustes y lo usan las devoluciones).
 */

import Buscador from './buscador_productos.js';
'use strict';

const AjusteStock = (() => {

  const ge  = id => document.getElementById(id);
  const db  = () => window.SGA_DB;
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);

  let cart             = [];   // [{ productoId, nombre, codigo, stock, costo, cantidad }]
  let lastResults      = [];   // últimos resultados de búsqueda
  let searchHlIdx      = -1;   // índice resaltado en el dropdown (-1 = ninguno)
  let searchTimer      = null;
  let sucursalId       = '1';

  // ── Búsqueda ──────────────────────────────────────────────────────────────

  function searchProductos(q) {
    return db().query(`
      SELECT p.id, p.nombre, p.costo, p.precio_venta, p.unidad_venta,
             cb.codigo,
             COALESCE(s.cantidad, 0) AS stock
      FROM productos p
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      WHERE p.activo = 1 AND (p.nombre LIKE ? OR cb.codigo = ?)
      GROUP BY p.id
      ORDER BY p.nombre
      LIMIT 20
    `, [sucursalId, `%${q}%`, q]);
  }

  // Motor unico (buscador_productos.js): tolera las diferencias de ceros a la
  // izquierda entre lo que guarda la base y lo que manda el lector.
  function getProductoByBarcode(q) {
    return Buscador.porCodigo(q, { sucursalId });
  }

  function renderDropdown(results) {
    const dd = ge('ci-search-dropdown');
    // Con la lista vacia se oculta y no se toca lastResults: asi venia
    // funcionando y la navegacion con flechas depende de eso.
    if (!results.length) { dd.style.display = 'none'; return; }

    Buscador.pintarDropdown(dd, results, addToCart);
    lastResults = results;
    searchHlIdx = -1;
  }

  // ── Carrito ───────────────────────────────────────────────────────────────

  function addToCart(p) {
    const existente = cart.find(i => i.productoId === p.id);
    if (existente) {
      existente.cantidad = Math.min(existente.cantidad + 1, p.stock);
    } else {
      cart.push({
        productoId: p.id,
        nombre:     p.nombre,
        codigo:     p.codigo || '',
        stock:      p.stock,
        costo:      p.costo || 0,
        precioVenta: p.precio_venta || 0,
        unidad:     p.unidad_venta || '',
        cantidad:   1,
      });
    }

    // Limpiar búsqueda y foco al input
    const input = ge('ci-search-input');
    const dd    = ge('ci-search-dropdown');
    input.value = '';
    dd.style.display = 'none';
    lastResults = [];
    searchHlIdx = -1;
    input.focus();

    ocultarError();
    renderCart();
  }

  function renderCart() {
    const tbody = ge('ci-cart-body');

    if (!cart.length) {
      tbody.innerHTML = `<tr><td colspan="6">
        <div class="ci-cart-empty">
          <div class="ci-cart-empty-icon">💔</div>
          Buscá los productos rotos o defectuosos para darlos de baja
        </div>
      </td></tr>`;
      ge('ci-confirm').disabled = true;
      ge('ci-total').textContent = '$0';
      return;
    }

    ge('ci-confirm').disabled = false;

    let totalCosto = 0;
    tbody.innerHTML = cart.map((item, idx) => {
      const subtotal = item.cantidad * item.costo;
      totalCosto += subtotal;
      const stockWarn = item.cantidad > item.stock;
      return `<tr data-idx="${idx}">
        <td class="c-idx">${idx + 1}</td>
        <td>
          <div style="font-weight:600;color:#333">${item.nombre}</div>
          ${stockWarn ? `<div style="font-size:0.78em;color:#e53935;font-weight:600">⚠ excede stock (${item.stock})</div>` : ''}
        </td>
        <td class="c-qty">
          <div class="ci-qty-wrap">
            <button class="ci-qty-btn" data-menos="${idx}">−</button>
            <input class="ci-qty-input" type="number" min="0.01" step="0.01"
                   value="${item.cantidad}" data-qty="${idx}">
            <button class="ci-qty-btn" data-mas="${idx}">+</button>
          </div>
        </td>
        <td class="c-costo">${fmt$(item.costo)}</td>
        <td class="c-total">${fmt$(subtotal)}</td>
        <td class="c-del"><button class="ci-del-btn" data-del="${idx}" aria-label="Quitar producto" title="Quitar">✕</button></td>
      </tr>`;
    }).join('');

    ge('ci-total').textContent = fmt$(totalCosto);

    // Eventos del carrito
    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        cart.splice(parseInt(btn.dataset.del), 1);
        renderCart();
      });
    });
    tbody.querySelectorAll('[data-menos]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.menos);
        cart[i].cantidad = Math.max(0.01, Math.round((cart[i].cantidad - 1) * 100) / 100);
        renderCart();
      });
    });
    tbody.querySelectorAll('[data-mas]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.mas);
        cart[i].cantidad = Math.min(cart[i].cantidad + 1, cart[i].stock);
        renderCart();
      });
    });
    tbody.querySelectorAll('[data-qty]').forEach(input => {
      input.addEventListener('change', () => {
        const i   = parseInt(input.dataset.qty);
        const val = parseFloat(input.value);
        if (isNaN(val) || val <= 0) { cart.splice(i, 1); }
        else { cart[i].cantidad = val; }
        renderCart();
      });
    });
  }

  // ── Confirmar ─────────────────────────────────────────────────────────────

  async function confirmar() {
    const motivo = 'ajuste';
    const obs    = ge('ci-obs').value.trim();

    if (!cart.length) return mostrarError('Agregá al menos un producto.');

    for (const item of cart) {
      if (item.cantidad <= 0)         return mostrarError(`Cantidad inválida: "${item.nombre}".`);
      if (item.cantidad > item.stock) return mostrarError(`Stock insuficiente para "${item.nombre}". Disponible: ${item.stock}`);
    }

    const btn = ge('ci-confirm');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const user = window.SGA_Auth.getCurrentUser();
      const now  = new Date().toISOString();

      db().beginBatch();

      for (const item of cart) {
        db().run(
          `INSERT INTO consumo_interno
             (id, producto_id, sucursal_id, usuario_id, registrado_por_usuario_id,
              cantidad, costo_unitario, precio_venta_unitario, motivo, observaciones, fecha, sync_status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [window.SGA_Utils.generateUUID(), item.productoId, sucursalId,
           user.id, user.id, item.cantidad, item.costo, item.precioVenta, motivo, obs, now, now]
        );

        db().run(
          `UPDATE stock SET cantidad = cantidad - ?, fecha_modificacion = ?
           WHERE producto_id = ? AND sucursal_id = ?`,
          [item.cantidad, now, item.productoId, sucursalId]
        );

        db().run(
          `INSERT INTO stock_ajustes
             (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado, sync_status, updated_at)
           VALUES (?, ?, ?, 'ajuste_negativo', ?, ?, ?, ?, 'aprobado', 'pending', ?)`,
          [window.SGA_Utils.generateUUID(), item.productoId, sucursalId,
           item.cantidad, 'Ajuste de stock' + (obs ? ': ' + obs : ''), user.id, now, now]
        );
      }

      db().commitBatch();

      for (const item of cart) {
        db().registrarHistorialStock(item.productoId, sucursalId);
      }

      window.SGA_Utils.showNotification('Ajuste de stock registrado correctamente', 'success');
      window.location.hash = '#operaciones_stock';

    } catch (err) {
      db().rollbackBatch();
      mostrarError('Error al guardar: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Registrar rotura';
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function mostrarError(msg) {
    const el = ge('ci-error');
    el.textContent = msg;
    el.style.display = '';
  }
  function ocultarError() {
    const el = ge('ci-error');
    if (el) el.style.display = 'none';
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    cart        = [];
    lastResults = [];
    searchHlIdx = -1;
    sucursalId  = window.SGA_Auth.getCurrentUser()?.sucursal_id || '1';

    ge('ci-back').addEventListener('click', () => {
      window.location.hash = '#operaciones_stock';
    });

    ge('ci-confirm').addEventListener('click', confirmar);

    // ── Búsqueda: input ────────────────────────────────────────────────────
    const searchInput = ge('ci-search-input');

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q  = searchInput.value.trim();
      const dd = ge('ci-search-dropdown');
      if (q.length < 2) { dd.style.display = 'none'; return; }

      searchTimer = setTimeout(() => {
        const results = searchProductos(q);
        renderDropdown(results);
      }, 180);
    });

    // ── Búsqueda: teclado (igual que POS) ─────────────────────────────────
    searchInput.addEventListener('keydown', e => {
      const dd       = ge('ci-search-dropdown');
      const sriItems = dd ? dd.querySelectorAll('.sri') : [];

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!sriItems.length) return;
        searchHlIdx = Math.min(searchHlIdx + 1, sriItems.length - 1);
        sriItems.forEach((el, i) => el.classList.toggle('highlighted', i === searchHlIdx));
        if (sriItems[searchHlIdx]) sriItems[searchHlIdx].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        searchHlIdx = Math.max(searchHlIdx - 1, -1);
        sriItems.forEach((el, i) => el.classList.toggle('highlighted', i === searchHlIdx));
        if (sriItems[searchHlIdx]) sriItems[searchHlIdx].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        // Seleccionar el item resaltado
        if (searchHlIdx >= 0 && lastResults[searchHlIdx]) {
          addToCart(lastResults[searchHlIdx]);
          searchHlIdx = -1;
          return;
        }
        // Si no hay resaltado, intentar por código exacto o resultado único
        const q = searchInput.value.trim();
        if (!q) return;
        const byBarcode = getProductoByBarcode(q);
        if (byBarcode) { addToCart(byBarcode); return; }
        const byName = searchProductos(q);
        if (byName.length === 1) { addToCart(byName[0]); return; }
        if (byName.length > 1 && dd) renderDropdown(byName);
        return;
      }

      if (e.key === 'Escape') {
        const dd = ge('ci-search-dropdown');
        if (dd && dd.style.display !== 'none') {
          searchInput.value = '';
          dd.style.display = 'none';
          lastResults = [];
          searchHlIdx = -1;
          e.stopPropagation();
        }
      }
    });

    // Foco automático al input al abrir
    searchInput.focus();
  }

  return { init };
})();

export default AjusteStock;
