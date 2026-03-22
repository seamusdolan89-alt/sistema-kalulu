/**
 * pos.js — Point of Sale (POS) Module - DATA LAYER ONLY
 * 
 * Provides data layer functions for:
 * - Cash register session management
 * - Sales registration with transactional integrity
 * - Payment method handling
 * - Client account (cuenta corriente) integration
 * - Paused orders management
 * - Returns and void sales handling
 */

export const POS = (() => {
  'use strict';

  /**
   * Get active caja session for a sucursal
   * 
   * @param {string} sucursalId - Sucursal ID
   * @returns {Object} Session object or null
   */
  function getSesionActiva(sucursalId) {
    const sql = `
      SELECT * FROM sesiones_caja
      WHERE sucursal_id = ? AND estado = 'abierta'
      ORDER BY fecha_apertura DESC
      LIMIT 1
    `;
    const results = window.SGA_DB.query(sql, [sucursalId]);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Open a new caja session
   * 
   * @param {string} sucursalId - Sucursal ID
   * @param {string} usuarioId - User (cajero) ID
   * @param {number} saldoInicial - Initial cash balance
   * @returns {Object} { success: boolean, sesionId?: string }
   */
  function abrirCaja(sucursalId, usuarioId, saldoInicial) {
    try {
      // Check if there's already an open session
      const activeSql = `SELECT id FROM sesiones_caja WHERE sucursal_id = ? AND estado = 'abierta'`;
      const active = window.SGA_DB.query(activeSql, [sucursalId]);
      if (active.length) {
        return { success: false, error: 'Ya existe una sesión de caja abierta' };
      }

      const sesionId = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());

      const insertSql = `
        INSERT INTO sesiones_caja (
          id, sucursal_id, usuario_apertura_id, fecha_apertura,
          saldo_inicial, estado, sync_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      window.SGA_DB.run(insertSql, [
        sesionId,
        sucursalId,
        usuarioId,
        now,
        parseFloat(saldoInicial),
        'abierta',
        'pending',
        now
      ]);

      console.log('✅ Caja abierta:', sesionId);
      return { success: true, sesionId };
    } catch (error) {
      console.error('❌ Error opening caja:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Register or update a sale with items, payments, and stock deduction
   * 
   * @param {Object} ventaData - Sale data {
   *   ventaId?, sesionCajaId, sucursalId, clienteId?, usuarioId,
   *   items: [{productoId, cantidad, precioUnitario, descuentoItem, costoUnitario}, ...],
   *   pagos: [{medio, monto, referencia?}, ...],
   *   descuentoGlobal: 0,
   *   aplicarSaldoFavor: boolean
   * }
   * @returns {Object} { success: boolean, ventaId?: string, ticketData?: {} }
   */
  function registrarVenta(ventaData) {
    try {
      const {
        ventaId: existingVentaId, // optional for updates
        sesionCajaId,
        sucursalId,
        clienteId,
        usuarioId,
        items,
        pagos,
        descuentoGlobal = 0,
        aplicarSaldoFavor = false
      } = ventaData;

      const now = window.SGA_Utils.formatISODate(new Date());
      const ventaId = existingVentaId || window.SGA_Utils.generateUUID();

      // Calculate totals
      let subtotal = 0;
      let descuentoTotal = descuentoGlobal;

      for (const item of items) {
        const itemSubtotal = item.cantidad * item.precioUnitario;
        subtotal += itemSubtotal;
        descuentoTotal += (item.descuentoItem || 0);
      }

      const total = subtotal - descuentoTotal;

      // INSERT or UPDATE venta
      const ventaSql = existingVentaId ? `
        UPDATE ventas SET
          sucursal_id = ?, sesion_caja_id = ?, cliente_id = ?, usuario_id = ?,
          fecha = ?, subtotal = ?, descuento = ?, total = ?, estado = ?, sync_status = ?, updated_at = ?
        WHERE id = ?
      ` : `
        INSERT INTO ventas (
          id, sucursal_id, sesion_caja_id, cliente_id, usuario_id,
          fecha, subtotal, descuento, total, estado, sync_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      window.SGA_DB.run(ventaSql, existingVentaId ? [
        sucursalId,
        sesionCajaId,
        clienteId || null,
        usuarioId,
        now,
        subtotal,
        descuentoTotal,
        total,
        'completada', // set to completada on confirm
        'pending',
        now,
        ventaId
      ] : [
        ventaId,
        sucursalId,
        sesionCajaId,
        clienteId || null,
        usuarioId,
        now,
        subtotal,
        descuentoTotal,
        total,
        'completada',
        'pending',
        now
      ]);

      // If updating, delete old items and payments, and restore stock (simplified, no stock adjustment for now)
      if (existingVentaId) {
        window.SGA_DB.run('DELETE FROM venta_items WHERE venta_id = ?', [ventaId]);
        window.SGA_DB.run('DELETE FROM venta_pagos WHERE venta_id = ?', [ventaId]);
        // TODO: restore stock from old items
      }

      // INSERT venta_items
      for (const item of items) {
        const itemId = window.SGA_Utils.generateUUID();
        const itemSubtotal = item.cantidad * item.precioUnitario - (item.descuentoItem || 0);
        
        const itemSql = `
          INSERT INTO venta_items (
            id, venta_id, producto_id, cantidad, precio_unitario,
            costo_unitario, descuento_item, subtotal, comision_pct
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        window.SGA_DB.run(itemSql, [
          itemId,
          ventaId,
          item.productoId,
          item.cantidad,
          item.precioUnitario,
          item.costoUnitario,
          item.descuentoItem || 0,
          itemSubtotal,
          item.comisionPct || 0
        ]);

        // Deduct stock for each sucursal (this sucursal only)
        const updateStockSql = `
          UPDATE stock
          SET cantidad = cantidad - ?, fecha_modificacion = ?, sync_status = ?, updated_at = ?
          WHERE producto_id = ? AND sucursal_id = ?
        `;

        window.SGA_DB.run(updateStockSql, [
          item.cantidad,
          now,
          'pending',
          now,
          item.productoId,
          sucursalId
        ]);
      }

      // INSERT venta_pagos and update payment method totals
      let efectivoTotal = 0;
      let mercadopagoTotal = 0;
      let tarjetaTotal = 0;
      let transferenciaTotal = 0;
      let cuentacorrienteTotal = 0;

      for (const pago of pagos) {
        const pagoId = window.SGA_Utils.generateUUID();
        
        const pagoSql = `
          INSERT INTO venta_pagos (id, venta_id, medio, monto, referencia)
          VALUES (?, ?, ?, ?, ?)
        `;

        window.SGA_DB.run(pagoSql, [
          pagoId,
          ventaId,
          pago.medio,
          pago.monto,
          pago.referencia || null
        ]);

        // Track totals by payment method
        switch (pago.medio) {
          case 'efectivo': efectivoTotal += pago.monto; break;
          case 'mercadopago': mercadopagoTotal += pago.monto; break;
          case 'tarjeta': tarjetaTotal += pago.monto; break;
          case 'transferencia': transferenciaTotal += pago.monto; break;
          case 'cuenta_corriente': cuentacorrienteTotal += pago.monto; break;
        }

        // If cuenta_corriente payment, register credit movement
        if (pago.medio === 'cuenta_corriente' && clienteId) {
          const ccId = window.SGA_Utils.generateUUID();
          const ccSql = `
            INSERT INTO cuenta_corriente (
              id, cliente_id, sucursal_id, tipo, monto, venta_id,
              descripcion, fecha, usuario_id, sync_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;

          window.SGA_DB.run(ccSql, [
            ccId,
            clienteId,
            sucursalId,
            'venta_fiada',
            pago.monto, // positive = owes
            ventaId,
            `Venta ${ventaId}`,
            now,
            usuarioId,
            'pending',
            now
          ]);
        }
      }

      // Update sesion totals
      const updateSesionSql = `
        UPDATE sesiones_caja SET
          total_efectivo = total_efectivo + ?,
          total_mercadopago = total_mercadopago + ?,
          total_tarjeta = total_tarjeta + ?,
          total_transferencia = total_transferencia + ?,
          total_cuenta_corriente = total_cuenta_corriente + ?,
          sync_status = ?, updated_at = ?
        WHERE id = ?
      `;

      window.SGA_DB.run(updateSesionSql, [
        efectivoTotal,
        mercadopagoTotal,
        tarjetaTotal,
        transferenciaTotal,
        cuentacorrienteTotal,
        'pending',
        now,
        sesionCajaId
      ]);

      // Build ticket data
      const ticketData = {
        ventaId,
        fecha: now,
        cliente: clienteId ? getClienteInfo(clienteId) : null,
        items,
        subtotal,
        descuentoTotal,
        total,
        pagos,
        sucursal: getSucursalInfo(sucursalId),
        usuario: getUsuarioInfo(usuarioId)
      };

      console.log('✅ Venta registrada:', ventaId);
      return { success: true, ventaId, ticketData };
    } catch (error) {
      console.error('❌ Error registering venta:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate change for cash payment
   * 
   * @param {number} total - Sale total
   * @param {number} pagoCash - Cash payment amount
   * @returns {Object} { vuelto: number, alcanza: boolean }
   */
  function calcularVuelto(total, pagoCash) {
    const vuelto = pagoCash - total;
    return {
      vuelto: Math.max(0, vuelto),
      alcanza: pagoCash >= total
    };
  }

  /**
   * Apply active promotions to cart items
   * 
   * @param {Array} items - Cart items
   * @returns {Object} { items: updated items, promociones: applied list }
   */
  function aplicarPromociones(items) {
    try {
      const now = window.SGA_Utils.formatISODate(new Date());
      const promocionesSql = `
        SELECT * FROM promociones
        WHERE activa = 1
        AND (fecha_desde IS NULL OR fecha_desde <= ?)
        AND (fecha_hasta IS NULL OR fecha_hasta >= ?)
      `;

      const promociones = window.SGA_DB.query(promocionesSql, [now, now]);
      const aplicadas = [];
      const updatedItems = JSON.parse(JSON.stringify(items)); // Deep copy

      for (const promo of promociones) {
        if (promo.tipo === 'descuento_cantidad') {
          // Lleva N paga M: find qualifying items
          const productosSql = `
            SELECT producto_id FROM promocion_items WHERE promocion_id = ?
          `;
          const productosPromo = window.SGA_DB.query(productosSql, [promo.id]);
          
          for (const pp of productosPromo) {
            const cartItem = updatedItems.find(i => i.productoId === pp.producto_id);
            if (cartItem) {
              const cantidadRequerida = productosPromo[0].cantidad_requerida || 1; // TODO: fix
              const descuentoPorUni = (cartItem.precioUnitario * promo.valor_descuento) / 100;
              cartItem.descuentoPromo = descuentoPorUni * cartItem.cantidad;
              aplicadas.push({ promoId: promo.id, nombre: promo.nombre });
            }
          }
        }
      }

      return { items: updatedItems, promociones: aplicadas };
    } catch (error) {
      console.error('❌ Error applying promotions:', error);
      return { items, promociones: [] };
    }
  }

  /**
   * Get customer current balance
   * 
   * @param {string} clienteId - Cliente ID
   * @returns {number} Balance (positive = owes, negative = we owe)
   */
  function getClienteSaldo(clienteId) {
    try {
      const sql = `
        SELECT COALESCE(SUM(monto), 0) as saldo FROM cuenta_corriente
        WHERE cliente_id = ?
      `;
      const result = window.SGA_DB.query(sql, [clienteId]);
      return result.length > 0 ? result[0].saldo : 0;
    } catch (error) {
      console.error('❌ Error getting cliente saldo:', error);
      return 0;
    }
  }

  /**
   * Close caja session with final balance and bill count
   * 
   * @param {string} sesionId - Session ID
   * @param {number} saldoFinalReal - Actual counted cash
   * @param {Object} detalleBilletes - Bill count {1000: n, 2000: n, ...}
   * @returns {Object} { success: boolean, resumen?: {} }
   */
  function cerrarCaja(sesionId, saldoFinalReal, detalleBilletes) {
    try {
      const now = window.SGA_Utils.formatISODate(new Date());
      
      // Get session data
      const sesionSql = `SELECT * FROM sesiones_caja WHERE id = ?`;
      const sesion = window.SGA_DB.query(sesionSql, [sesionId]);
      if (!sesion.length) {
        return { success: false, error: 'Sesión no encontrada' };
      }

      const s = sesion[0];
      const saldoEsperado = s.saldo_inicial + s.total_efectivo - (s.total_egresos || 0);
      const diferencia = saldoFinalReal - saldoEsperado;

      // Update session with close data
      const updateSql = `
        UPDATE sesiones_caja SET
          usuario_cierre_id = ?, fecha_cierre = ?,
          saldo_final_real = ?, saldo_final_esperado = ?, diferencia = ?,
          detalle_billetes = ?, estado = ?, sync_status = ?, updated_at = ?
        WHERE id = ?
      `;

      window.SGA_DB.run(updateSql, [
        window.SGA_Auth.getCurrentUser().id,
        now,
        saldoFinalReal,
        saldoEsperado,
        diferencia,
        JSON.stringify(detalleBilletes),
        'cerrada',
        'pending',
        now,
        sesionId
      ]);

      const resumen = {
        fechaApertura: s.fecha_apertura,
        fechaCierre: now,
        saldoInicial: s.saldo_inicial,
        totalVentas: s.total_efectivo + s.total_mercadopago + s.total_tarjeta + s.total_transferencia + s.total_cuenta_corriente,
        totalEgresos: s.total_egresos || 0,
        saldoEsperado,
        saldoReal: saldoFinalReal,
        diferencia,
        detalleBilletes
      };

      console.log('✅ Caja cerrada:', sesionId);
      return { success: true, resumen };
    } catch (error) {
      console.error('❌ Error closing caja:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Register cash withdrawal/expense in caja
   * 
   * @param {string} sesionId - Session ID
   * @param {number} monto - Amount
   * @param {string} descripcion - Description
   * @param {string} usuarioId - User ID
   * @returns {Object} { success: boolean, egresoId?: string }
   */
  function registrarEgreso(sesionId, monto, descripcion, usuarioId) {
    try {
      const egresoId = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());

      const insertSql = `
        INSERT INTO egresos_caja (id, sesion_caja_id, monto, descripcion, fecha, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `;

      window.SGA_DB.run(insertSql, [egresoId, sesionId, monto, descripcion, now, usuarioId]);

      // Update session total egresos
      const updateSql = `
        UPDATE sesiones_caja SET total_egresos = COALESCE(total_egresos, 0) + ? WHERE id = ?
      `;

      window.SGA_DB.run(updateSql, [monto, sesionId]);

      console.log('✅ Egreso registrado:', egresoId);
      return { success: true, egresoId };
    } catch (error) {
      console.error('❌ Error registering egreso:', error);
      return { success: false, error: error.message };
    }
  }

  // Helper functions
  function getClienteInfo(clienteId) {
    const sql = `SELECT id, nombre, apellido, telefono FROM clientes WHERE id = ?`;
    const result = window.SGA_DB.query(sql, [clienteId]);
    return result.length > 0 ? result[0] : null;
  }

  function getSucursalInfo(sucursalId) {
    const sql = `SELECT id, nombre, direccion FROM sucursales WHERE id = ?`;
    const result = window.SGA_DB.query(sql, [sucursalId]);
    return result.length > 0 ? result[0] : null;
  }

  function getUsuarioInfo(usuarioId) {
    const sql = `SELECT id, nombre, rol FROM usuarios WHERE id = ?`;
    const result = window.SGA_DB.query(sql, [usuarioId]);
    return result.length > 0 ? result[0] : null;
  }

  /**
   * Module initialization
   */
  function init(params = []) {
    console.log('💳 POS module initialized');

    // Always clear sessionStorage cart on init
    sessionStorage.removeItem('pos_cart');

    // ── STATE ──────────────────────────────────────────────────────
    const state = {
      mode: 'dashboard',       // 'dashboard' | 'sale'
      cart: [],
      clienteId: null,
      clienteNombre: null,
      clienteSaldo: 0,
      sesionActiva: null,
      activeMedios: new Set(['efectivo']),
      pagosAmounts: { efectivo: 0, mercadopago: 0, tarjeta: 0, transferencia: 0, cuenta_corriente: 0 },
      recibeEfectivo: 0,
      descuentoGlobal: 0,
      descItemIdx: null,
      descTipo: 'monto',
      ccCobrarDeuda: false,
      ccAplicarFavor: false,
      ccRegistrarDeuda: false,
      currentUser: window.SGA_Auth.getCurrentUser(),
      currentSucursal: null,
      editingVentaId: null,
    };

    // ── UTILS ──────────────────────────────────────────────────────
    const ge = id => document.getElementById(id);
    const formatCurrency = v => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 }).format(v || 0);
    const formatTime = iso => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    const MEDIOS = [
      { id: 'efectivo',      nombre: 'Efectivo',     icon: '💵' },
      { id: 'mercadopago',   nombre: 'Mercado Pago', icon: '📱' },
      { id: 'tarjeta',       nombre: 'Tarjeta',      icon: '💳' },
      { id: 'transferencia', nombre: 'Transferencia', icon: '🏦' },
    ];

    const DENOMINACIONES = [1000, 2000, 5000, 10000, 20000, 50000];

    // ── SUCURSAL LOAD ───────────────────────────────────────────────
    if (state.currentUser && state.currentUser.sucursal_id) {
      try {
        const sucSql = `SELECT * FROM sucursales WHERE id = ?`;
        const suc = window.SGA_DB.query(sucSql, [state.currentUser.sucursal_id]);
        state.currentSucursal = suc.length > 0 ? suc[0] : null;
      } catch (e) {
        console.error('Error loading sucursal:', e);
        state.currentSucursal = null;
      }
    }

    // Check if we have a valid sucursal
    if (!state.currentSucursal) {
      ge('app') && (ge('app').innerHTML = `
        <div style="padding:40px;text-align:center;color:#f44336">
          <h2>❌ Error de Configuración</h2>
          <p>El usuario no tiene sucursal asignada.</p>
          <button onclick="location.reload()" style="margin-top:16px;padding:10px 20px;background:#667eea;color:white;border:none;border-radius:4px;cursor:pointer">Reintentar</button>
        </div>`);
      return;
    }

    // ── CART UTILS ─────────────────────────────────────────────────
    const saveCart = () => sessionStorage.setItem('pos_cart', JSON.stringify(state.cart));

    const getCartSubtotal = () => state.cart.reduce((s, i) => s + i.cantidad * i.precioUnitario, 0);
    const getCartDescuento = () => state.cart.reduce((s, i) => s + (i.descuentoItem || 0), 0) + state.descuentoGlobal;
    const getCartTotal = () => Math.max(0, getCartSubtotal() - getCartDescuento());
    const getTotalAsignado = () => [...state.activeMedios].reduce((s, m) => s + (state.pagosAmounts[m] || 0), 0);

    const getEffectiveTotal = () => {
      const base = getCartTotal();
      if (state.ccAplicarFavor && state.clienteSaldo < 0) {
        return Math.max(0, base + state.clienteSaldo); // clienteSaldo is negative
      }
      return base;
    };

    let lastSearchResults = [];
    let searchHlIdx = -1;

    // Restore cart from sessionStorage
    try {
      const saved = sessionStorage.getItem('pos_cart');
      if (saved) state.cart = JSON.parse(saved);
    } catch(e) { /* ignore */ }

    // ── PRODUCT SEARCH ─────────────────────────────────────────────
    const searchProductos = (q) => {
      const like = `%${q}%`;
      return window.SGA_DB.query(`
        SELECT DISTINCT p.id, p.nombre, p.precio_venta, p.costo,
          (SELECT codigo FROM codigos_barras WHERE producto_id = p.id AND es_principal = 1 LIMIT 1) as codigo
        FROM productos p
        LEFT JOIN codigos_barras cb ON cb.producto_id = p.id
        WHERE p.activo = 1 AND (p.nombre LIKE ? OR cb.codigo LIKE ?)
        ORDER BY p.nombre LIMIT 12
      `, [like, like]);
    };

    const getProductoByBarcode = (codigo) => {
      const r = window.SGA_DB.query(`
        SELECT p.* FROM productos p
        JOIN codigos_barras cb ON cb.producto_id = p.id
        WHERE cb.codigo = ? AND p.activo = 1 LIMIT 1
      `, [codigo]);
      return r.length ? r[0] : null;
    };

    // ── ADD TO CART ────────────────────────────────────────────────
    const addToCart = (producto) => {
      if (!state.sesionActiva) { showModalApertura(); return; }
      const existIdx = state.cart.findIndex(i => i.productoId === producto.id);
      if (existIdx >= 0) {
        state.cart[existIdx].cantidad++;
      } else {
        state.cart.push({
          productoId: producto.id,
          nombre: producto.nombre,
          precioUnitario: parseFloat(producto.precio_venta) || 0,
          costoUnitario: parseFloat(producto.costo) || 0,
          cantidad: 1,
          descuentoItem: 0,
          comisionPct: 0,
        });
      }
      saveCart();
      renderCart();
      renderSaleTotals();
      autoFillPayment();
      // FIX 2: focus qty input of added item
      const addedIdx = state.cart.findIndex(i => i.productoId === producto.id);
      if (addedIdx >= 0) {
        const qtyInp = document.querySelector(`.qty-input[data-idx="${addedIdx}"]`);
        if (qtyInp) { qtyInp.select(); qtyInp.focus(); }
      }
      const si = ge('pos-search-input');
      if (si) si.value = '';
      const dd = ge('pos-search-dropdown');
      if (dd) dd.style.display = 'none';
      searchHlIdx = -1;
    };

    // ── RENDER CART ────────────────────────────────────────────────
    const renderCart = () => {
      const tbody = ge('cart-tbody');
      if (!tbody) return;

      if (!state.cart.length) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="cart-empty"><div class="cart-empty-icon">🛍️</div><div>Escaneá o buscá un producto para comenzar</div></div></td></tr>`;
        return;
      }

      tbody.innerHTML = state.cart.map((item, idx) => {
        const sub = item.cantidad * item.precioUnitario - (item.descuentoItem || 0);
        const hasDisc = (item.descuentoItem || 0) > 0;
        return `<tr>
          <td class="c-idx">${idx + 1}</td>
          <td>${item.nombre}</td>
          <td class="c-qty"><input type="number" class="qty-input" value="${item.cantidad}" min="0.01" step="0.01" data-idx="${idx}"></td>
          <td class="c-price">${formatCurrency(item.precioUnitario)}</td>
          <td class="c-disc"><button class="disc-btn ${hasDisc ? 'active' : ''}" data-idx="${idx}">${hasDisc ? formatCurrency(item.descuentoItem) : '—'}</button></td>
          <td class="c-sub">${formatCurrency(sub)}</td>
          <td class="c-del"><button class="del-btn" data-idx="${idx}" title="Quitar">✕</button></td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('.qty-input').forEach(inp => {
        const idx = +inp.dataset.idx;
        inp.addEventListener('keydown', e => {
          // Allow backspace, delete, tab, escape, enter, arrows, home, end
          const allowedKeys = [8, 9, 13, 27, 37, 38, 39, 40, 46, 110, 190]; // 110=., 190=.
          if (allowedKeys.includes(e.keyCode) || (e.keyCode >= 48 && e.keyCode <= 57) || (e.keyCode >= 96 && e.keyCode <= 105)) {
            // Allow
          } else {
            e.preventDefault();
          }
        });
        inp.addEventListener('change', e => {
          const item = state.cart[idx];
          if (!item) return;
          const v = parseFloat(e.target.value);
          if (isNaN(v) || v <= 0) { state.cart.splice(idx, 1); }
          else { item.cantidad = v; }
          saveCart(); renderCart(); renderSaleTotals(); autoFillPayment();
        });
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const v = parseFloat(inp.value);
            if (isNaN(v) || v <= 0) { state.cart.splice(idx, 1); }
            else if (state.cart[idx]) { state.cart[idx].cantidad = v; }
            saveCart(); renderCart(); renderSaleTotals(); autoFillPayment();
            ge('pos-search-input')?.focus();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            if (state.cart[idx]) inp.value = state.cart[idx].cantidad;
            ge('pos-search-input')?.focus();
          }
        });
      });
      tbody.querySelectorAll('.disc-btn').forEach(btn => {
        btn.addEventListener('click', () => showDescModal(+btn.dataset.idx));
      });
      tbody.querySelectorAll('.del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          state.cart.splice(+btn.dataset.idx, 1);
          saveCart(); renderCart(); renderSaleTotals(); autoFillPayment();
        });
      });
    };

    // ── SALE TOTALS ────────────────────────────────────────────────
    const renderSaleTotals = () => {
      const sub  = getCartSubtotal();
      const disc = getCartDescuento();
      const tot  = getCartTotal();
      const el = id => ge(id);
      if (el('cart-subtotal'))  el('cart-subtotal').textContent  = formatCurrency(sub);
      if (el('cart-descuento')) el('cart-descuento').textContent = formatCurrency(disc);
      if (el('cart-total'))     el('cart-total').textContent     = formatCurrency(tot);
      updateConfirmBtn();
    };

    // ── PAYMENT CHIPS ──────────────────────────────────────────────
    const renderPaymentChips = () => {
      const container = ge('payment-chips');
      if (!container) return;
      container.innerHTML = MEDIOS.map(m => `
        <div class="pchip ${state.activeMedios.has(m.id) ? 'active' : ''} pc-${m.id}" data-medio="${m.id}">
          ${m.icon} ${m.nombre}
        </div>
      `).join('');
      container.querySelectorAll('.pchip').forEach(chip => {
        chip.addEventListener('click', () => {
          const mid = chip.dataset.medio;
          // FIX 3: single-select
          state.activeMedios = new Set([mid]);
          Object.keys(state.pagosAmounts).forEach(k => { state.pagosAmounts[k] = 0; });
          renderPaymentChips();
          autoFillPayment();
        });
      });
    };

    // Auto-fill active payment method with effective total
    const autoFillPayment = () => {
      const mid = [...state.activeMedios][0];
      if (mid) state.pagosAmounts[mid] = getEffectiveTotal();
      renderPaymentInputs();
    };

    const renderVuelto = () => {
      const effTotal = getEffectiveTotal();
      const recibe = state.recibeEfectivo;
      const vuelto = recibe > 0 ? Math.max(0, recibe - effTotal) : 0;
      const falta  = recibe > 0 ? Math.max(0, effTotal - recibe) : 0;
      const el = ge('efectivo-vuelto');
      if (!el) return;
      if (vuelto > 0) {
        el.className = 'pinput-vuelto ok';
        el.innerHTML = `💵 Vuelto: ${formatCurrency(vuelto)}` +
          (state.clienteId ? `<div class="saldo-favor-row" style="margin-top:4px"><label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="chk-saldo-favor"> Dejar ${formatCurrency(vuelto)} como saldo a favor</label></div>` : '');
        el.style.display = 'block';
      } else if (falta > 0) {
        el.className = 'pinput-vuelto falta';
        el.textContent = `⚠ Falta: ${formatCurrency(falta)}`;
        el.style.display = 'block';
      } else {
        el.style.display = 'none';
      }
    };

    const renderPaymentInputs = () => {
      const container = ge('payment-inputs');
      if (!container) return;

      const effTotal = getEffectiveTotal();
      let html = '';
      for (const mid of state.activeMedios) {
        const m = MEDIOS.find(x => x.id === mid);
        if (!m) continue;
        if (mid === 'efectivo') {
          html += `<div class="pinput-row" data-medio="efectivo">
            <div class="pinput-label">${m.icon} ${m.nombre}</div>
            <div class="pinput-sub-lbl">Total a cobrar</div>
            <div class="pinput-total-ro">${formatCurrency(effTotal)}</div>
            <div class="recibe-row" style="margin-top:8px">
              <span>Recibe $</span>
              <input type="number" class="recibe-field" id="recibe-efectivo" value="${state.recibeEfectivo > 0 ? state.recibeEfectivo.toFixed(2) : ''}" min="0" step="0.01" placeholder="${effTotal.toFixed(2)}" autocomplete="off">
            </div>
            <div id="efectivo-vuelto" class="pinput-vuelto" style="display:none"></div>
          </div>`;
        } else {
          const amount = effTotal;
          html += `<div class="pinput-row">
            <div class="pinput-label">${m.icon} ${m.nombre}</div>
            <div class="pinput-sub-lbl">Total a cobrar</div>
            <div class="pinput-total-ro">${formatCurrency(effTotal)}</div>
            <div class="pinput-sub-lbl">Monto recibido</div>
            <input type="number" class="pinput-field" data-medio="${mid}" value="${amount.toFixed(2)}" min="0" step="0.01">
          </div>`;
        }
      }
      container.innerHTML = html;

      container.querySelectorAll('.pinput-field').forEach(inp => {
        inp.addEventListener('input', () => {
          state.pagosAmounts[inp.dataset.medio] = parseFloat(inp.value) || 0;
          renderPaymentRunning();
          updateConfirmBtn();
        });
      });

      const recibeEl = ge('recibe-efectivo');
      if (recibeEl) {
        recibeEl.addEventListener('input', () => {
          state.recibeEfectivo = parseFloat(recibeEl.value) || 0;
          renderVuelto();
        });
        // Trigger initial vuelto render
        renderVuelto();
      }

      renderPaymentRunning();
      updateConfirmBtn();
      renderDebtToggle();
    };

    const renderPaymentRunning = () => {
      const asig = getTotalAsignado();
      const tot  = getEffectiveTotal();
      const diff = asig - tot;
      const el   = ge('payment-running');
      const txt  = ge('payment-running-text');
      if (!el || !txt) return;
      txt.textContent = `${formatCurrency(asig)} / ${formatCurrency(tot)}`;
      el.className = 'payment-running ' + (asig >= tot ? 'ok' : 'pending');
    };

    const updateConfirmBtn = () => {
      const btn = ge('btn-confirm-venta');
      if (!btn) return;
      const asig = getTotalAsignado();
      const tot  = getEffectiveTotal();
      const canProceed = state.sesionActiva && state.cart.length > 0 && (asig >= tot || state.ccRegistrarDeuda);
      btn.disabled = !canProceed;
    };

    // ── CLIENT SEARCH ──────────────────────────────────────────────
    const searchClientes = (q) => {
      const like = `%${q}%`;
      return window.SGA_DB.query(
        `SELECT id, nombre, apellido, telefono FROM clientes WHERE activo = 1 AND (nombre LIKE ? OR apellido LIKE ? OR telefono LIKE ?) ORDER BY nombre LIMIT 8`,
        [like, like, like]
      );
    };

    const selectCliente = (c) => {
      state.clienteId = c.id;
      state.clienteNombre = `${c.nombre} ${c.apellido || ''}`.trim();
      state.clienteSaldo = getClienteSaldo(c.id);

      const card = ge('client-card');
      const nameEl = ge('client-card-name');
      const badgeEl = ge('client-saldo-badge');
      const inp = ge('client-search-input');
      const dd = ge('client-dropdown');

      if (inp) inp.value = '';
      if (dd) dd.style.display = 'none';
      if (nameEl) nameEl.textContent = state.clienteNombre;
      if (card) card.style.display = 'flex';

      if (badgeEl) {
        const s = state.clienteSaldo;
        if (s > 0) {
          badgeEl.textContent = `Debe ${formatCurrency(s)}`;
          badgeEl.className = 'saldo-badge deuda';
        } else if (s < 0) {
          badgeEl.textContent = `A favor ${formatCurrency(Math.abs(s))}`;
          badgeEl.className = 'saldo-badge favor';
        } else {
          badgeEl.textContent = 'Sin saldo';
          badgeEl.className = 'saldo-badge neutro';
        }
      }

      const deudaRow = ge('client-deuda-row');
      if (deudaRow && state.clienteSaldo > 0) {
        const deudaAmt = ge('client-deuda-amount');
        if (deudaAmt) deudaAmt.textContent = formatCurrency(state.clienteSaldo);
        deudaRow.style.display = 'flex';
      } else if (deudaRow) {
        deudaRow.style.display = 'none';
      }
      renderCCSection();
    };

    const clearCliente = () => {
      state.clienteId = null;
      state.clienteNombre = null;
      state.clienteSaldo = 0;
      state.ccCobrarDeuda = false;
      state.ccAplicarFavor = false;
      const card = ge('client-card');
      if (card) card.style.display = 'none';
      const deudaRow = ge('client-deuda-row');
      if (deudaRow) deudaRow.style.display = 'none';
      const inp = ge('client-search-input');
      if (inp) inp.value = '';
      renderCCSection();
      autoFillPayment();
    };

    // ── CC SECTION ─────────────────────────────────────────────────
    const renderDebtToggle = () => {
      const row = ge('debt-toggle-row');
      const chk = ge('chk-registrar-deuda');
      const warn = ge('debt-warning');
      if (!row || !chk || !warn) return;
      row.style.display = 'block';
      chk.checked = state.ccRegistrarDeuda;
      if (chk.checked && !state.clienteId) {
        warn.style.display = 'block';
      } else {
        warn.style.display = 'none';
      }
    };

    // ── HEADER STATUS ──────────────────────────────────────────────
    const updateHeaderStatus = () => {
      const badge = ge('pos-caja-badge');
      if (!badge) return;
      if (state.sesionActiva) {
        badge.textContent = `● Caja abierta desde ${formatTime(state.sesionActiva.fecha_apertura)}`;
        badge.className = 'pos-caja-badge open';
      } else {
        badge.textContent = '● Caja cerrada';
        badge.className = 'pos-caja-badge closed';
      }
    };

    const checkSesion = () => {
      try {
        state.sesionActiva = getSesionActiva(state.currentSucursal.id);
        updateHeaderStatus();
      } catch(e) {
        console.error('checkSesion:', e);
        updateHeaderStatus();
      }
    };

    // ── MODE SWITCHING ─────────────────────────────────────────────
    const enterDashboard = () => {
      state.mode = 'dashboard';
      const dash = ge('pos-dashboard');
      const sale = ge('pos-sale');
      if (dash) dash.style.display = 'flex';
      if (sale) sale.classList.add('hidden');
      loadDashboard();
      // Clear sessionStorage cart on exit from sale mode
      sessionStorage.removeItem('pos_cart');
    };

    const enterSaleMode = () => {
      if (!state.sesionActiva) { showModalApertura(); return; }
      // Check if there's an active cart in sessionStorage with items (skip if editing)
      if (!state.editingVentaId) {
        let hasActiveCart = false;
        try {
          const saved = sessionStorage.getItem('pos_cart');
          if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0) {
              hasActiveCart = true;
            }
          }
        } catch(e) {}
        if (hasActiveCart) {
          if (!confirm('¿Abandonar la venta actual?')) return;
        }
      }
      // Start with empty cart unless editing
      if (!state.editingVentaId) {
        state.cart = [];
        saveCart();
      }
      state.mode = 'sale';
      const dash = ge('pos-dashboard');
      const sale = ge('pos-sale');
      if (dash) dash.style.display = 'none';
      if (sale) sale.classList.remove('hidden');
      renderPaymentChips();
      renderCart();
      renderSaleTotals();
      autoFillPayment();
      setTimeout(() => ge('pos-search-input')?.focus(), 80);
    };

    // ── DASHBOARD ──────────────────────────────────────────────────
    const loadDashboard = () => {
      if (!state.sesionActiva) {
        ge('ventas-tbody').innerHTML = `<tr><td colspan="7"><div class="dash-empty"><div class="dash-empty-icon">💰</div><div>Abrí la caja para comenzar</div></div></td></tr>`;
        updateSummaryBar(null);
        ge('ventas-count-badge').textContent = '0';
        return;
      }

      const sid = state.sesionActiva.id;

      // Get ventas for this session
      const ventas = window.SGA_DB.query(`
        SELECT v.id, v.fecha, v.total, v.subtotal, v.descuento, v.estado,
          COALESCE(c.nombre || ' ' || COALESCE(c.apellido,''), 'Sin cliente') as cliente_nombre,
          COUNT(vi.id) as articulos
        FROM ventas v
        LEFT JOIN clientes c ON v.cliente_id = c.id
        LEFT JOIN venta_items vi ON v.id = vi.venta_id
        WHERE v.sesion_caja_id = ?
        GROUP BY v.id ORDER BY v.fecha DESC
      `, [sid]);

      // Get all payment methods for these ventas
      const pagosMap = {};
      if (ventas.length) {
        const ids = ventas.map(v => `'${v.id}'`).join(',');
        const pagos = window.SGA_DB.query(`SELECT venta_id, GROUP_CONCAT(medio) as medios FROM venta_pagos WHERE venta_id IN (${ids}) GROUP BY venta_id`);
        pagos.forEach(p => { pagosMap[p.venta_id] = p.medios; });
      }

      const MEDIO_ICONS = { efectivo: '💵', mercadopago: '📱', tarjeta: '💳', transferencia: '🏦', cuenta_corriente: '📒' };
      const MEDIO_NAMES = { efectivo: 'Efectivo', mercadopago: 'Mercado Pago', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cuenta_corriente: 'Cta. Cte.' };

      const tbody = ge('ventas-tbody');
      if (!ventas.length) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="dash-empty"><div class="dash-empty-icon">🛒</div><div>No hay ventas en este turno todavía</div></div></td></tr>`;
      } else {
        tbody.innerHTML = ventas.map(v => {
          const mediosStr = pagosMap[v.id] || '';
          const mediosArr = [...new Set(mediosStr.split(',').filter(Boolean))];
          const medioChips = mediosArr.length > 1
            ? `<span class="medio-chip">🔀 Mixto</span>`
            : mediosArr.map(m => `<span class="medio-chip">${MEDIO_ICONS[m] || ''} ${MEDIO_NAMES[m] || m}</span>`).join('');
          return `<tr data-venta-id="${v.id}">
            <td>${formatTime(v.fecha)}</td>
            <td>${v.cliente_nombre}</td>
            <td style="text-align:center">${v.articulos}</td>
            <td style="font-weight:700">${formatCurrency(v.total)}</td>
            <td>${medioChips}</td>
            <td><span class="estado-badge ${v.estado}">${v.estado === 'completada' ? 'Completada' : 'Anulada'}</span></td>
            <td style="color:#bbb;font-size:1.1em;text-align:center">›</td>
          </tr>`;
        }).join('');

        tbody.querySelectorAll('tr[data-venta-id]').forEach(tr => {
          tr.addEventListener('click', () => openDetailPanel(tr.dataset.ventaId));
        });
      }

      ge('ventas-count-badge').textContent = ventas.filter(v => v.estado === 'completada').length;
      updateSummaryBar(state.sesionActiva);

      // Add dev clear button if in dev mode
      if (localStorage.getItem('dev_mode') === 'true') {
        const dashBody = ge('pos-dashboard').querySelector('.dashboard-body');
        const existingBtn = dashBody.querySelector('.dev-clear-btn');
        if (existingBtn) existingBtn.remove();
        const btn = document.createElement('button');
        btn.className = 'dev-clear-btn';
        btn.style.cssText = 'position:absolute;bottom:10px;right:10px;padding:8px 12px;background:#f44336;color:white;border:none;border-radius:4px;cursor:pointer;font-size:0.85em;';
        btn.textContent = '🗑️ Limpiar ventas pendientes';
        btn.addEventListener('click', () => {
          sessionStorage.clear();
          window.SGA_DB.run('DELETE FROM pedidos_abiertos');
          showToast('Ventas pendientes eliminadas');
          loadDashboard();
        });
        dashBody.appendChild(btn);
      }
    };

    const updateSummaryBar = (sesion) => {
      const set = (id, v) => { const el = ge(id); if (el) el.textContent = formatCurrency(v); };
      if (!sesion) {
        ['sum-total','sum-efectivo','sum-mp','sum-tarjeta','sum-transf','sum-cc'].forEach(id => set(id, 0));
        return;
      }
      const total = (sesion.total_efectivo || 0) + (sesion.total_mercadopago || 0) + (sesion.total_tarjeta || 0) + (sesion.total_transferencia || 0) + (sesion.total_cuenta_corriente || 0);
      set('sum-total',    total);
      set('sum-efectivo', sesion.total_efectivo || 0);
      set('sum-mp',       sesion.total_mercadopago || 0);
      set('sum-tarjeta',  sesion.total_tarjeta || 0);
      set('sum-transf',   sesion.total_transferencia || 0);
      set('sum-cc',       sesion.total_cuenta_corriente || 0);
    };

    // ── DETAIL PANEL ───────────────────────────────────────────────
    const openDetailPanel = (ventaId) => {
      const venta = getVentaDetail(ventaId);
      if (!venta) return;

      const panel = ge('pos-detail-panel');
      const body  = ge('dp-body');
      const footer = ge('dp-footer');
      const titleEl = ge('dp-title');
      if (!panel || !body || !footer) return;

      if (titleEl) titleEl.textContent = `Venta · ${formatTime(venta.fecha)}`;

      const clienteNombre = venta.cliente_id
        ? (window.SGA_DB.query('SELECT nombre, apellido FROM clientes WHERE id = ?', [venta.cliente_id])[0] || {})
        : null;
      const usuarioInfo = getUsuarioInfo(venta.usuario_id);

      body.innerHTML = `
        <div class="dp-section">
          <div class="dp-section-label">Información</div>
          <div class="dp-info-row"><span>Fecha</span><strong>${new Date(venta.fecha).toLocaleString('es-AR')}</strong></div>
          <div class="dp-info-row"><span>Vendedor</span><strong>${usuarioInfo?.nombre || '—'}</strong></div>
          <div class="dp-info-row"><span>Cliente</span><strong>${clienteNombre ? `${clienteNombre.nombre} ${clienteNombre.apellido||''}`.trim() : 'Sin cliente'}</strong></div>
        </div>

        <div class="dp-section">
          <div class="dp-section-label">Artículos</div>
          <table class="dp-items-table">
            ${(venta.items || []).map(i => `
              <tr>
                <td>${i.producto_nombre || i.nombre || '—'}</td>
                <td class="td-r">${i.cantidad} × ${formatCurrency(i.precio_unitario)}</td>
                <td class="td-r">${formatCurrency(i.subtotal)}</td>
              </tr>`).join('')}
          </table>
        </div>

        <div class="dp-section">
          <div class="dp-section-label">Pago</div>
          ${(venta.pagos || []).map(p => {
            const m = MEDIOS.find(x => x.id === p.medio);
            return `<div class="dp-info-row"><span>${m ? `${m.icon} ${m.nombre}` : p.medio}</span><strong>${formatCurrency(p.monto)}</strong></div>`;
          }).join('')}
        </div>

        <div>
          <div class="dp-total-row"><span>Subtotal</span><span>${formatCurrency(venta.subtotal)}</span></div>
          <div class="dp-total-row"><span>Descuento</span><span>-${formatCurrency(venta.descuento)}</span></div>
          <div class="dp-total-row grand"><span>TOTAL</span><span>${formatCurrency(venta.total)}</span></div>
        </div>
      `;

      const rol = state.currentUser?.rol;
      const canAnular = (rol === 'admin' || rol === 'encargado') && venta.estado === 'completada';
      const canEditar = venta.estado === 'completada';
      footer.innerHTML = `
        <button class="dp-btn" id="dp-btn-reimprimir">🖨️ Reimprimir</button>
        <button class="dp-btn danger" id="dp-btn-anular" ${canAnular ? '' : 'disabled'} title="${canAnular ? '' : 'Sin permiso o ya anulada'}">↩ Anular</button>
        <button class="dp-btn" id="dp-btn-editar" ${canEditar ? '' : 'disabled'} title="${canEditar ? '' : 'Editar venta'}">✏️ Editar</button>
      `;

      ge('dp-btn-reimprimir')?.addEventListener('click', () => {
        const ticketData = {
          ventaId: venta.id,
          fecha: venta.fecha,
          items: venta.items.map(i => ({ nombre: i.producto_nombre || '—', cantidad: i.cantidad, precioUnitario: i.precio_unitario, descuentoItem: 0 })),
          subtotal: venta.subtotal,
          descuentoTotal: venta.descuento,
          total: venta.total,
          pagos: venta.pagos,
          sucursal: getSucursalInfo(state.currentSucursal.id),
          usuario: usuarioInfo,
        };
        showModalTicket(ticketData);
      });

      if (canAnular) {
        ge('dp-btn-anular')?.addEventListener('click', () => {
          if (!confirm('¿Anular esta venta? Se restaurará el stock.')) return;
          const result = anularVenta(venta.id, 'Anulación manual');
          if (result.success) {
            closeDetailPanel();
            checkSesion();
            loadDashboard();
          } else {
            alert('Error: ' + result.error);
          }
        });
      }

      if (canEditar) {
        ge('dp-btn-editar')?.addEventListener('click', () => {
          // Load sale into cart
          state.cart = venta.items.map(i => ({
            productoId: i.producto_id,
            nombre: i.producto_nombre || i.nombre,
            precioUnitario: i.precio_unitario,
            costoUnitario: i.costo_unitario || 0,
            cantidad: i.cantidad,
            descuentoItem: i.descuento_item || 0,
            comisionPct: i.comision_pct || 0,
          }));
          saveCart();
          // Update venta status to 'editando'
          window.SGA_DB.run('UPDATE ventas SET estado = ? WHERE id = ?', ['editando', venta.id]);
          // Set editing mode
          state.editingVentaId = venta.id;
          // Enter sale mode
          closeDetailPanel();
          enterSaleMode();
        });
      }

      panel.classList.add('open');
    };

    const closeDetailPanel = () => {
      ge('pos-detail-panel')?.classList.remove('open');
    };

    // ── TOAST NOTIFICATIONS ───────────────────────────────────────
    const showToast = (message, type = 'success') => {
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.style.cssText = `
        position: fixed; top: 20px; right: 20px; background: ${type === 'success' ? '#4CAF50' : '#f44336'}; color: white;
        padding: 12px 16px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 1000; font-weight: 600; max-width: 300px; word-wrap: break-word;
        opacity: 0; transition: opacity 0.3s;
      `;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.style.opacity = '1', 10);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    };

    // ── MODALS ─────────────────────────────────────────────────────
    const showModal  = id => ge(id)?.classList.remove('hidden');
    const hideModal  = id => ge(id)?.classList.add('hidden');

    const showModalApertura = () => {
      showModal('modal-apertura');
      setTimeout(() => ge('apertura-saldo-input')?.focus(), 80);
    };

    const showModalTicket = (ticketData) => {
      const suc = ticketData.sucursal || {};
      ge('ticket-content').innerHTML = `
        <div class="ticket-center"><strong>${suc.nombre || 'Sistema Kalulu'}</strong><br>
          <small>${suc.direccion || ''}</small></div>
        <hr class="ticket-hr">
        <div style="font-size:0.82em">
          ${new Date(ticketData.fecha).toLocaleString('es-AR')}<br>
          Vendedor: ${ticketData.usuario?.nombre || '—'}
          ${ticketData.cliente ? `<br>Cliente: ${ticketData.cliente.nombre}` : ''}
        </div>
        <hr class="ticket-hr">
        <table class="ticket-tbl">
          ${ticketData.items.map(i => {
            const sub = i.cantidad * i.precioUnitario - (i.descuentoItem || 0);
            return `<tr><td>${i.nombre}</td><td class="tr">${i.cantidad}×${formatCurrency(i.precioUnitario)}</td><td class="tr">${formatCurrency(sub)}</td></tr>`;
          }).join('')}
        </table>
        <hr class="ticket-hr">
        <div class="ticket-trow"><span>Subtotal</span><span>${formatCurrency(ticketData.subtotal)}</span></div>
        ${ticketData.descuentoTotal > 0 ? `<div class="ticket-trow"><span>Descuento</span><span>-${formatCurrency(ticketData.descuentoTotal)}</span></div>` : ''}
        <div class="ticket-trow ticket-grand"><span>TOTAL</span><span>${formatCurrency(ticketData.total)}</span></div>
        <hr class="ticket-hr">
        ${ticketData.pagos.map(p => { const m = MEDIOS.find(x => x.id === p.medio); return `<div class="ticket-trow"><span>${m ? `${m.icon} ${m.nombre}` : p.medio}</span><span>${formatCurrency(p.monto)}</span></div>`; }).join('')}
        <hr class="ticket-hr">
        <div class="ticket-center"><small>¡Gracias por su compra!</small></div>
      `;
      // For reimprimir, change footer buttons
      const footer = ge('modal-ticket').querySelector('.pmodal-ftr');
      if (footer) {
        footer.innerHTML = `
          <button class="mbtn mbtn-secondary" id="btn-ticket-cerrar">Cerrar</button>
          <button class="mbtn mbtn-secondary" id="btn-ticket-imprimir">🖨️ Imprimir ticket</button>
        `;
        // Add listener for cerrar
        ge('btn-ticket-cerrar')?.addEventListener('click', () => hideModal('modal-ticket'), { once: true });
      }
      showModal('modal-ticket');
      setTimeout(() => ge('btn-ticket-imprimir')?.focus(), 80);
    };

    const showModalCierre = () => {
      if (!state.sesionActiva) return;
      const s = state.sesionActiva;

      // Resumen tab
      const totalVentas = (s.total_efectivo || 0) + (s.total_mercadopago || 0) + (s.total_tarjeta || 0) + (s.total_transferencia || 0) + (s.total_cuenta_corriente || 0);
      ge('ctab-resumen').innerHTML = `
        <div class="cierre-resumen-grid">
          <div class="crs-card"><div class="crs-card-label">Ventas totales</div><div class="crs-card-value">${formatCurrency(totalVentas)}</div></div>
          <div class="crs-card"><div class="crs-card-label">Saldo inicial</div><div class="crs-card-value">${formatCurrency(s.saldo_inicial)}</div></div>
          <div class="crs-card"><div class="crs-card-label">Egresos</div><div class="crs-card-value">${formatCurrency(s.total_egresos || 0)}</div></div>
          <div class="crs-card"><div class="crs-card-label">Efectivo esperado</div><div class="crs-card-value">${formatCurrency((s.saldo_inicial || 0) + (s.total_efectivo || 0) - (s.total_egresos || 0))}</div></div>
        </div>`;

      // Medios tab
      ge('ctab-medios').innerHTML = `
        ${MEDIOS.map(m => {
          const key = `total_${m.id === 'mercadopago' ? 'mercadopago' : m.id === 'cuenta_corriente' ? 'cuenta_corriente' : m.id}`;
          const v = s[key] || 0;
          return `<div class="ct-row"><span>${m.icon} ${m.nombre}</span><strong>${formatCurrency(v)}</strong></div>`;
        }).join('')}
        <div class="ct-row bold" style="border-top:1px solid #eee;margin-top:8px;padding-top:8px">
          <span>Total ventas</span><strong>${formatCurrency(totalVentas)}</strong>
        </div>`;

      // Recuento tab: billetes
      const saldoEsperado = (s.saldo_inicial || 0) + (s.total_efectivo || 0) - (s.total_egresos || 0);
      ge('billetes-grid').innerHTML = DENOMINACIONES.map(d => `
        <div class="billet-lbl">$${d.toLocaleString('es-AR')}</div>
        <input type="number" class="billet-inp" data-denom="${d}" min="0" value="0">
        <div class="billet-x">×</div>
        <div class="billet-sub" data-denom-sub="${d}">$0</div>
      `).join('');
      ge('cierre-recuento-totals').innerHTML = `
        <div class="ct-row"><span>Efectivo esperado</span><strong>${formatCurrency(saldoEsperado)}</strong></div>
        <div class="ct-row bold"><span>Contado</span><strong id="cierre-contado">$0,00</strong></div>
        <div class="ct-row dif-pos" id="cierre-dif-row"><span>Diferencia</span><strong id="cierre-diferencia">$0,00</strong></div>`;

      // Egresos tab
      const egresos = window.SGA_DB.query(`SELECT * FROM egresos_caja WHERE sesion_caja_id = ? ORDER BY fecha DESC`, [state.sesionActiva.id]);
      ge('ctab-egresos').innerHTML = egresos.length
        ? `<table style="width:100%;font-size:0.9em;border-collapse:collapse">${egresos.map(e => `<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">${formatTime(e.fecha)} — ${e.descripcion || ''}</td><td style="text-align:right;font-weight:700;padding:6px 0">${formatCurrency(e.monto)}</td></tr>`).join('')}</table>`
        : `<p style="color:#aaa;text-align:center;padding:20px">Sin egresos registrados</p>`;

      showModal('modal-cierre');
      recalcBilletes(saldoEsperado);
    };

    const recalcBilletes = (saldoEsperado) => {
      let total = 0;
      const billetes = {};
      document.querySelectorAll('.billet-inp').forEach(inp => {
        const d = parseInt(inp.dataset.denom);
        const n = parseInt(inp.value) || 0;
        const sub = d * n;
        total += sub;
        billetes[d] = n;
        const subEl = document.querySelector(`[data-denom-sub="${d}"]`);
        if (subEl) subEl.textContent = formatCurrency(sub);
      });
      const dif = total - saldoEsperado;
      const contEl = ge('cierre-contado');
      const difEl  = ge('cierre-diferencia');
      const difRow = ge('cierre-dif-row');
      if (contEl) contEl.textContent = formatCurrency(total);
      if (difEl) difEl.textContent = formatCurrency(dif);
      if (difRow) difRow.className = `ct-row ${dif < 0 ? 'dif-neg' : 'dif-pos'}`;
      ge('billetes-json').value = JSON.stringify({ billetes, total });
    };

    const showModalPedidos = () => {
      if (!state.currentSucursal) return;
      const pedidos = getPedidosAbiertos(state.currentSucursal.id);
      const grid = ge('pedidos-grid');
      if (!grid) return;

      if (!pedidos.length) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#aaa">No hay pedidos abiertos</div>`;
      } else {
        grid.innerHTML = pedidos.map(p => {
          const items = Array.isArray(p.items) ? p.items : [];
          return `<div class="pedido-card">
            <div class="pedido-card-name">${p.nombre || 'Pedido sin nombre'}</div>
            <div class="pedido-card-meta">${items.length} artículos · ${formatTime(p.fecha)}</div>
            <div class="pedido-card-total">${formatCurrency(p.total)}</div>
            <div class="pedido-card-btns">
              <button class="pedido-btn retomar" data-id="${p.id}">Retomar</button>
              <button class="pedido-btn eliminar" data-id="${p.id}">Eliminar</button>
            </div>
          </div>`;
        }).join('');

        grid.querySelectorAll('.pedido-btn.retomar').forEach(btn => {
          btn.addEventListener('click', () => {
            const pedido = retomarPedido(btn.dataset.id);
            if (!pedido) return;
            state.cart = pedido.items;
            saveCart();
            eliminarPedidoAbierto(btn.dataset.id);
            hideModal('modal-pedidos');
            enterSaleMode();
          });
        });
        grid.querySelectorAll('.pedido-btn.eliminar').forEach(btn => {
          btn.addEventListener('click', () => {
            if (!confirm('¿Eliminar este pedido?')) return;
            eliminarPedidoAbierto(btn.dataset.id);
            showModalPedidos();
          });
        });
      }

      showModal('modal-pedidos');
    };

    const showModalDevolucion = () => {
      ge('devolucion-venta-id').value = '';
      ge('devolucion-detail').style.display = 'none';
      ge('devolucion-motivo-wrap').style.display = 'none';
      ge('btn-devolucion-confirm').style.display = 'none';
      showModal('modal-devolucion');
      setTimeout(() => ge('devolucion-venta-id')?.focus(), 80);
    };

    const showDescModal = (idx) => {
      state.descItemIdx = idx;
      state.descTipo = 'monto';
      const item = state.cart[idx];
      if (!item) return;
      ge('desc-item-name').textContent = item.nombre;
      ge('desc-amount-input').value = item.descuentoItem || '';
      ge('desc-input-label').textContent = 'Descuento ($)';
      ge('btn-desc-pct').classList.remove('active');
      ge('btn-desc-monto').classList.add('active');
      showModal('modal-desc');
      setTimeout(() => ge('desc-amount-input')?.focus(), 80);
    };

    // ── CIERRE TAB SWITCHING ────────────────────────────────────────
    document.querySelectorAll('.ctab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.ctab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.ctab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const target = ge(`ctab-${tab.dataset.ctab}`);
        if (target) target.classList.add('active');
      });
    });

    // ── EVENT LISTENERS ────────────────────────────────────────────

    // Header buttons
    ge('btn-nueva-venta')?.addEventListener('click', enterSaleMode);
    ge('btn-pedidos-header')?.addEventListener('click', showModalPedidos);
    ge('btn-devolucion-header')?.addEventListener('click', showModalDevolucion);
    ge('btn-cerrar-caja')?.addEventListener('click', showModalCierre);

    // Sale mode: back button
    ge('btn-volver-dashboard')?.addEventListener('click', () => {
      if (state.editingVentaId) {
        if (!confirm('¿Cancelar edición? La venta volverá a su estado original.')) return;
        // Revert status
        window.SGA_DB.run('UPDATE ventas SET estado = ? WHERE id = ?', ['completada', state.editingVentaId]);
        state.editingVentaId = null;
      }
      // Clear cart and sessionStorage silently
      state.cart = [];
      saveCart();
      enterDashboard();
    });

    // Detail panel close
    ge('btn-close-detail')?.addEventListener('click', closeDetailPanel);

    // Apertura confirm
    ge('btn-apertura-confirm')?.addEventListener('click', () => {
      const saldo = parseFloat(ge('apertura-saldo-input')?.value) || 0;
      const result = abrirCaja(state.currentSucursal.id, state.currentUser.id, saldo);
      if (result.success) {
        state.sesionActiva = getSesionActiva(state.currentSucursal.id);
        hideModal('modal-apertura');
        updateHeaderStatus();
        loadDashboard();
      } else {
        alert('Error: ' + result.error);
      }
    });

    ge('apertura-saldo-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') ge('btn-apertura-confirm')?.click();
    });

    // Ticket
    ge('btn-ticket-imprimir')?.addEventListener('click', () => window.print());
    ge('btn-ticket-close')?.addEventListener('click',   () => hideModal('modal-ticket'));
    ge('btn-ticket-volver')?.addEventListener('click',  () => hideModal('modal-ticket'));
    ge('btn-ticket-confirmar')?.addEventListener('click', () => {
      hideModal('modal-ticket');
      showToast('Venta registrada ✓');
      state.cart = [];
      state.pagosAmounts = { efectivo: 0, mercadopago: 0, tarjeta: 0, transferencia: 0 };
      state.activeMedios = new Set(['efectivo']);
      state.recibeEfectivo = 0;
      state.ccCobrarDeuda = false;
      state.ccAplicarFavor = false;
      clearCliente();
      saveCart();
      checkSesion();
      enterDashboard();
    });

    // Cierre
    ge('btn-cierre-close')?.addEventListener('click',   () => hideModal('modal-cierre'));
    ge('btn-cierre-cancel')?.addEventListener('click',  () => hideModal('modal-cierre'));
    ge('btn-cierre-confirm')?.addEventListener('click', () => {
      const billJson = JSON.parse(ge('billetes-json')?.value || '{}');
      const saldoReal = billJson.total || 0;
      const result = cerrarCaja(state.sesionActiva.id, saldoReal, billJson.billetes || {});
      if (result.success) {
        state.sesionActiva = null;
        hideModal('modal-cierre');
        updateHeaderStatus();
        loadDashboard();
      } else {
        alert('Error: ' + result.error);
      }
    });

    // Billetes live calculation
    document.addEventListener('input', e => {
      if (e.target.classList.contains('billet-inp') && state.sesionActiva) {
        const s = state.sesionActiva;
        const saldoEsperado = (s.saldo_inicial || 0) + (s.total_efectivo || 0) - (s.total_egresos || 0);
        recalcBilletes(saldoEsperado);
      }
    });

    // Pedidos
    ge('btn-pedidos-close')?.addEventListener('click', () => hideModal('modal-pedidos'));

    // Pausar venta
    ge('btn-pausar-venta')?.addEventListener('click', () => {
      if (!state.cart.length) return;
      const nombre = prompt('Nombre para el pedido (opcional):') || '';
      const result = pausarVenta({
        items: state.cart,
        sucursalId: state.currentSucursal.id,
        usuarioId: state.currentUser.id,
        cliente: state.clienteId ? { id: state.clienteId } : null,
        totales: { total: getCartTotal() },
        nombre,
      });
      if (result.success) {
        state.cart = [];
        saveCart();
        clearCliente();
        enterDashboard();
      }
    });

    // Product search input
    const searchInput = ge('pos-search-input');
    let searchTimeout = null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const q = searchInput.value.trim();
        const dd = ge('pos-search-dropdown');
        if (q.length < 2) { if (dd) dd.style.display = 'none'; return; }

        searchTimeout = setTimeout(() => {
          const results = searchProductos(q);
          if (!dd) return;
          if (!results.length) { dd.style.display = 'none'; return; }
          dd.innerHTML = results.map(p => `
            <div class="sri" data-id="${p.id}">
              <div class="sri-left">
                <div class="sri-nombre">${p.nombre}</div>
                ${p.codigo ? `<div class="sri-codigo">${p.codigo}</div>` : ''}
              </div>
              <div class="sri-precio">${formatCurrency(p.precio_venta)}</div>
            </div>`).join('');
          dd.style.display = 'block';
          lastSearchResults = results;
          searchHlIdx = -1;
          dd.querySelectorAll('.sri').forEach(el => {
            el.addEventListener('click', () => {
              const p = results.find(x => x.id === el.dataset.id);
              if (p) addToCart(p);
            });
          });
        }, 180);
      });

      searchInput.addEventListener('keydown', e => {
        const dd = ge('pos-search-dropdown');
        const sriItems = dd ? dd.querySelectorAll('.sri') : [];

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!sriItems.length) return;
          searchHlIdx = Math.min(searchHlIdx + 1, sriItems.length - 1);
          sriItems.forEach((el, i) => el.classList.toggle('highlighted', i === searchHlIdx));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          searchHlIdx = Math.max(searchHlIdx - 1, -1);
          sriItems.forEach((el, i) => el.classList.toggle('highlighted', i === searchHlIdx));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          // If item is highlighted, select it
          if (searchHlIdx >= 0 && lastSearchResults[searchHlIdx]) {
            addToCart(lastSearchResults[searchHlIdx]);
            searchHlIdx = -1;
            return;
          }
          const q = searchInput.value.trim();
          if (!q) return;
          const byBarcode = getProductoByBarcode(q);
          if (byBarcode) { addToCart(byBarcode); return; }
          const byName = searchProductos(q);
          if (byName.length === 1) { addToCart(byName[0]); return; }
          if (byName.length > 1 && dd) dd.style.display = dd.style.display === 'none' ? 'block' : dd.style.display;
        }
        if (e.key === 'Escape') {
          if (dd && dd.style.display !== 'none') {
            searchInput.value = '';
            dd.style.display = 'none';
            searchHlIdx = -1;
            e.stopPropagation();
            return;
          }
          if (!searchInput.value.trim()) {
            // Let global handler exit
          } else {
            e.stopPropagation();
          }
        }
      });
    }

    // Client search
    const clientInput = ge('client-search-input');
    let clientTimeout = null;
    if (clientInput) {
      clientInput.addEventListener('input', () => {
        clearTimeout(clientTimeout);
        const q = clientInput.value.trim();
        const dd = ge('client-dropdown');
        if (q.length < 2) { if (dd) dd.style.display = 'none'; return; }
        clientTimeout = setTimeout(() => {
          const results = searchClientes(q);
          if (!dd) return;
          if (!results.length) { dd.style.display = 'none'; return; }
          dd.innerHTML = results.map(c => `<div class="cri" data-id="${c.id}">${c.nombre} ${c.apellido || ''} ${c.telefono ? `· ${c.telefono}` : ''}</div>`).join('');
          dd.style.display = 'block';
          dd.querySelectorAll('.cri').forEach(el => {
            el.addEventListener('click', () => {
              const c = results.find(x => x.id === el.dataset.id);
              if (c) selectCliente(c);
            });
          });
        }, 180);
      });
    }

    ge('chk-registrar-deuda')?.addEventListener('change', e => {
      state.ccRegistrarDeuda = e.target.checked;
      renderDebtToggle();
      updateConfirmBtn();
    });

    // Cliente rápido
    ge('btn-cliente-rapido')?.addEventListener('click', () => showModal('modal-cliente-rapido'));
    ge('btn-crapido-close')?.addEventListener('click',  () => hideModal('modal-cliente-rapido'));
    ge('btn-crapido-cancel')?.addEventListener('click', () => hideModal('modal-cliente-rapido'));
    ge('btn-crapido-confirm')?.addEventListener('click', () => {
      const nombre = ge('crapido-nombre')?.value.trim();
      if (!nombre) { alert('El nombre es obligatorio'); return; }
      const id = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        `INSERT INTO clientes (id, nombre, apellido, telefono, fecha_alta, activo, sync_status, updated_at) VALUES (?,?,?,?,?,1,'pending',?)`,
        [id, nombre, ge('crapido-apellido')?.value.trim() || null, ge('crapido-telefono')?.value.trim() || null, now, now]
      );
      selectCliente({ id, nombre, apellido: ge('crapido-apellido')?.value.trim() || '', telefono: '' });
      hideModal('modal-cliente-rapido');
    });

    // Confirm venta
    ge('btn-confirm-venta')?.addEventListener('click', () => {
      if (!state.sesionActiva || !state.cart.length) return;
      const asig = getTotalAsignado();
      const effTotal = getEffectiveTotal();
      if (Math.abs(asig - effTotal) > 0.01) { alert('El monto asignado no coincide con el total'); return; }

      const pagos = [...state.activeMedios]
        .filter(m => (state.pagosAmounts[m] || 0) > 0)
        .map(m => ({ medio: m, monto: state.pagosAmounts[m], referencia: null }));

      const ventaData = {
        ventaId: state.editingVentaId || undefined,
        sesionCajaId: state.sesionActiva.id,
        sucursalId: state.currentSucursal.id,
        clienteId: state.clienteId || null,
        usuarioId: state.currentUser.id,
        items: state.cart,
        pagos,
        descuentoGlobal: state.descuentoGlobal,
        aplicarSaldoFavor: false,
      };

      const result = registrarVenta(ventaData);
      if (!result.success) {
        alert('Error al registrar venta: ' + result.error);
        return;
      }

      // Post-sale CC operations
      if (state.clienteId) {
        const now = window.SGA_Utils.formatISODate(new Date());
        const ccInsert = (tipo, monto, desc) => {
          window.SGA_DB.run(
            `INSERT INTO cuenta_corriente (id, cliente_id, sucursal_id, tipo, monto, venta_id, descripcion, fecha, usuario_id, sync_status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
            [window.SGA_Utils.generateUUID(), state.clienteId, state.currentSucursal.id, tipo, monto, result.ventaId, desc, now, state.currentUser.id, now]
          );
        };
        // FIX 4: aplicar saldo a favor (saldo < 0 = store owes client)
        if (state.ccAplicarFavor && state.clienteSaldo < 0) {
          const applied = Math.min(Math.abs(state.clienteSaldo), getCartTotal());
          ccInsert('ajuste', applied, 'Aplicación de saldo a favor en compra');
        }
        // FIX 4: cobrar deuda (saldo > 0 = client owes store)
        if (state.ccCobrarDeuda && state.clienteSaldo > 0) {
          ccInsert('pago', -state.clienteSaldo, 'Cobro de deuda pendiente');
        }
        // FIX 4: registrar diferencia como deuda
        if (state.ccRegistrarDeuda) {
          const faltante = Math.max(0, getEffectiveTotal() - getTotalAsignado());
          if (faltante > 0) {
            ccInsert('venta_fiada', faltante, 'Diferencia registrada como deuda');
          }
        }
        // FIX 5: vuelto como saldo a favor
        if (ge('chk-saldo-favor')?.checked) {
          const recibe = state.recibeEfectivo || 0;
          const vuelto = Math.max(0, recibe - getEffectiveTotal());
          if (vuelto > 0) {
            ccInsert('saldo_favor', -vuelto, 'Vuelto dejado como saldo a favor');
          }
        }
      }

      // Reset editing state
      state.editingVentaId = null;

      // Show success toast and return to dashboard
      showToast('Venta registrada ✓');
      state.cart = [];
      state.pagosAmounts = { efectivo: 0, mercadopago: 0, tarjeta: 0, transferencia: 0 };
      state.activeMedios = new Set(['efectivo']);
      state.recibeEfectivo = 0;
      state.ccCobrarDeuda = false;
      state.ccAplicarFavor = false;
      clearCliente();
      saveCart();
      checkSesion();
      enterDashboard();
    });

    // Discount modal
    ge('btn-desc-close')?.addEventListener('click',   () => hideModal('modal-desc'));
    ge('btn-desc-cancel')?.addEventListener('click',  () => hideModal('modal-desc'));
    ge('btn-desc-pct')?.addEventListener('click', () => {
      state.descTipo = 'pct';
      ge('btn-desc-pct').classList.add('active');
      ge('btn-desc-monto').classList.remove('active');
      ge('desc-input-label').textContent = 'Descuento (%)';
    });
    ge('btn-desc-monto')?.addEventListener('click', () => {
      state.descTipo = 'monto';
      ge('btn-desc-monto').classList.add('active');
      ge('btn-desc-pct').classList.remove('active');
      ge('desc-input-label').textContent = 'Descuento ($)';
    });
    ge('btn-desc-confirm')?.addEventListener('click', () => {
      const idx  = state.descItemIdx;
      const item = state.cart[idx];
      if (!item) { hideModal('modal-desc'); return; }
      const raw = parseFloat(ge('desc-amount-input')?.value) || 0;
      if (state.descTipo === 'pct') {
        item.descuentoItem = (item.cantidad * item.precioUnitario) * (raw / 100);
      } else {
        item.descuentoItem = raw;
      }
      saveCart(); renderCart(); renderSaleTotals(); autoFillPayment();
      hideModal('modal-desc');
    });

    // Devolucion
    ge('btn-devolucion-close')?.addEventListener('click',  () => hideModal('modal-devolucion'));
    ge('btn-devolucion-cancel')?.addEventListener('click', () => hideModal('modal-devolucion'));
    ge('btn-devolucion-buscar')?.addEventListener('click', () => {
      const vid = ge('devolucion-venta-id')?.value.trim();
      if (!vid) return;
      const venta = getVentaDetail(vid);
      const detEl = ge('devolucion-detail');
      const motivoWrap = ge('devolucion-motivo-wrap');
      const confirmBtn = ge('btn-devolucion-confirm');
      if (!venta) {
        detEl.innerHTML = '<p style="color:#f44336">Venta no encontrada</p>';
        detEl.style.display = 'block';
        motivoWrap.style.display = 'none';
        confirmBtn.style.display = 'none';
        return;
      }
      const rol = state.currentUser?.rol;
      if (rol !== 'admin' && rol !== 'encargado') {
        detEl.innerHTML = '<p style="color:#f44336">Sin permisos para anular ventas</p>';
        detEl.style.display = 'block';
        motivoWrap.style.display = 'none';
        confirmBtn.style.display = 'none';
        return;
      }
      if (venta.estado === 'anulada') {
        detEl.innerHTML = '<p style="color:#888">Esta venta ya fue anulada</p>';
        detEl.style.display = 'block';
        motivoWrap.style.display = 'none';
        confirmBtn.style.display = 'none';
        return;
      }
      detEl.innerHTML = `<strong>${formatTime(venta.fecha)}</strong> — ${formatCurrency(venta.total)}<br><small>${(venta.items||[]).length} artículos</small>`;
      detEl.style.display = 'block';
      motivoWrap.style.display = 'block';
      confirmBtn.style.display = 'inline-flex';
      confirmBtn.dataset.ventaId = venta.id;
    });
    ge('btn-devolucion-confirm')?.addEventListener('click', () => {
      const vid = ge('btn-devolucion-confirm').dataset.ventaId;
      const motivo = ge('devolucion-motivo')?.value.trim() || 'Anulación';
      const result = anularVenta(vid, motivo);
      if (result.success) {
        hideModal('modal-devolucion');
        checkSesion();
        loadDashboard();
      } else {
        alert('Error: ' + result.error);
      }
    });

    // ── KEYBOARD SHORTCUTS ─────────────────────────────────────────
    document.addEventListener('keydown', e => {
      if (e.key === 'F3') { e.preventDefault(); enterSaleMode(); }
      if (e.key === 'F4') { e.preventDefault(); showModalPedidos(); }
      if (e.key === 'F10' && state.mode === 'sale') { e.preventDefault(); ge('btn-confirm-venta')?.click(); }
      if (e.key === 'F2'  && state.mode === 'sale') { e.preventDefault(); ge('pos-search-input')?.focus(); }
      if (e.key === 'Escape') {
        // Close any open modal first
        const openModal = document.querySelector('.pbackdrop:not(.hidden)');
        if (openModal) { openModal.classList.add('hidden'); return; }
        // Close detail panel
        if (ge('pos-detail-panel')?.classList.contains('open')) { closeDetailPanel(); return; }
        // Exit sale mode
        if (state.mode === 'sale') {
          if (state.editingVentaId) {
            if (!confirm('¿Cancelar edición? La venta volverá a su estado original.')) return;
            // Revert status
            window.SGA_DB.run('UPDATE ventas SET estado = ? WHERE id = ?', ['completada', state.editingVentaId]);
            state.editingVentaId = null;
          }
          // Clear cart and sessionStorage silently
          state.cart = [];
          saveCart();
          enterDashboard();
        }
      }
      // Barcode scanner fallback in sale mode: redirect keystrokes to search input
      if (state.mode === 'sale') {
        const active = document.activeElement;
        const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
        if (!isInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const si = ge('pos-search-input');
          if (si) { si.focus(); }
        }
      }
    });

    // ── INITIAL LOAD ───────────────────────────────────────────────
    checkSesion();
    enterDashboard();
    if (!state.sesionActiva) showModalApertura();
  }

  /**
   * Pause current cart to pedidos_abiertos
   */
  function pausarVenta(cartData) {
    try {
      if (!cartData.items || cartData.items.length === 0) {
        return { success: false, error: 'Carrito vacío' };
      }

      const pedidoId = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());

      const sql = `
        INSERT INTO pedidos_abiertos (
          id, sucursal_id, usuario_id, cliente_id, items, total, fecha, nombre
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      window.SGA_DB.run(sql, [
        pedidoId,
        cartData.sucursalId,
        cartData.usuarioId,
        cartData.cliente ? cartData.cliente.id : null,
        JSON.stringify(cartData.items),
        cartData.totales.total,
        now,
        cartData.nombre || `Pedido ${pedidoId.substring(0, 8)}`
      ]);

      console.log('✅ Venta pausada:', pedidoId);
      return { success: true, pedidoId };
    } catch (error) {
      console.error('❌ Error pausing venta:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all paused orders for a sucursal
   */
  function getPedidosAbiertos(sucursalId) {
    try {
      const sql = `
        SELECT * FROM pedidos_abiertos WHERE sucursal_id = ? ORDER BY fecha DESC
      `;
      const results = window.SGA_DB.query(sql, [sucursalId]);
      return results.map(r => ({
        ...r,
        items: JSON.parse(r.items)
      }));
    } catch (error) {
      console.error('❌ Error getting paused orders:', error);
      return [];
    }
  }

  /**
   * Resume a paused order
   */
  function retomarPedido(pedidoId) {
    try {
      const sql = `SELECT * FROM pedidos_abiertos WHERE id = ?`;
      const results = window.SGA_DB.query(sql, [pedidoId]);
      
      if (results.length === 0) return null;

      const pedido = results[0];
      return {
        ...pedido,
        items: JSON.parse(pedido.items)
      };
    } catch (error) {
      console.error('❌ Error resuming pedido:', error);
      return null;
    }
  }

  /**
   * Delete a paused order
   */
  function eliminarPedidoAbierto(pedidoId) {
    try {
      const sql = `DELETE FROM pedidos_abiertos WHERE id = ?`;
      window.SGA_DB.run(sql, [pedidoId]);
      console.log('✅ Pedido eliminado:', pedidoId);
      return { success: true };
    } catch (error) {
      console.error('❌ Error deleting paused order:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Register a return
   */
  function registrarDevolucion(ventaId, items, motivo) {
    try {
      const ventaSql = `SELECT * FROM ventas WHERE id = ?`;
      const ventaResults = window.SGA_DB.query(ventaSql, [ventaId]);
      if (ventaResults.length === 0) {
        return { success: false, error: 'Venta no encontrada' };
      }

      const venta = ventaResults[0];
      const devolucionId = window.SGA_Utils.generateUUID();
      const now = window.SGA_Utils.formatISODate(new Date());

      const devSql = `
        INSERT INTO devoluciones (
          id, venta_id, sucursal_id, usuario_id, fecha, motivo, sync_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      window.SGA_DB.run(devSql, [
        devolucionId,
        ventaId,
        venta.sucursal_id,
        window.SGA_Auth.getCurrentUser().id,
        now,
        motivo,
        'pending',
        now
      ]);

      // Get original venta items
      let totalDevuelto = 0;
      const itemsSql = `SELECT * FROM venta_items WHERE venta_id = ?`;
      const ventaItems = window.SGA_DB.query(itemsSql, [ventaId]);

      // Add returned items and restore stock
      for (const item of items) {
        const devItemId = window.SGA_Utils.generateUUID();
        const origItem = ventaItems.find(vi => vi.producto_id === item.productoId);
        if (!origItem) continue;

        const devItemSql = `
          INSERT INTO devolucion_items (
            id, devolucion_id, producto_id, cantidad, precio_unitario
          ) VALUES (?, ?, ?, ?, ?)
        `;

        window.SGA_DB.run(devItemSql, [
          devItemId,
          devolucionId,
          item.productoId,
          item.cantidad,
          origItem.precio_unitario
        ]);

        // Restore stock
        const restoreStockSql = `
          UPDATE stock SET cantidad = cantidad + ?, fecha_modificacion = ?, sync_status = ?
          WHERE producto_id = ? AND sucursal_id = ?
        `;
        window.SGA_DB.run(restoreStockSql, [
          item.cantidad,
          now,
          'pending',
          item.productoId,
          venta.sucursal_id
        ]);

        totalDevuelto += item.cantidad * origItem.precio_unitario;
      }

      // Handle cuenta_corriente reversal if applicable
      const pagosCCSql = `SELECT * FROM venta_pagos WHERE venta_id = ? AND medio = ?`;
      const pagosCC = window.SGA_DB.query(pagosCCSql, [ventaId, 'cuenta_corriente']);

      if (pagosCC.length > 0 && venta.cliente_id) {
        const movId = window.SGA_Utils.generateUUID();
        const movSql = `
          INSERT INTO cuenta_corriente (
            id, cliente_id, sucursal_id, tipo, monto, descripcion,
            fecha, usuario_id, sync_status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        window.SGA_DB.run(movSql, [
          movId,
          venta.cliente_id,
          venta.sucursal_id,
          'saldo_favor',
          -totalDevuelto, // negative = a favor
          `Devolución venta ${ventaId.substring(0, 8)}`,
          now,
          window.SGA_Auth.getCurrentUser().id,
          'pending',
          now
        ]);
      }

      console.log('✅ Devolución registrada:', devolucionId);
      return { success: true, devolucionId };
    } catch (error) {
      console.error('❌ Error registering devolucion:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Void a sale
   */
  function anularVenta(ventaId, motivo) {
    try {
      const ventaSql = `SELECT * FROM ventas WHERE id = ?`;
      const ventaResults = window.SGA_DB.query(ventaSql, [ventaId]);
      if (ventaResults.length === 0) {
        return { success: false, error: 'Venta no encontrada' };
      }

      const venta = ventaResults[0];
      const now = window.SGA_Utils.formatISODate(new Date());

      // Mark as anulada
      const updateSql = `
        UPDATE ventas SET estado = ?, sync_status = ?, updated_at = ? WHERE id = ?
      `;
      window.SGA_DB.run(updateSql, ['anulada', 'pending', now, ventaId]);

      // Restore stock
      const itemsSql = `SELECT * FROM venta_items WHERE venta_id = ?`;
      const items = window.SGA_DB.query(itemsSql, [ventaId]);

      for (const item of items) {
        const restoreStockSql = `
          UPDATE stock SET cantidad = cantidad + ?, fecha_modificacion = ?, sync_status = ?
          WHERE producto_id = ? AND sucursal_id = ?
        `;
        window.SGA_DB.run(restoreStockSql, [
          item.cantidad,
          now,
          'pending',
          item.producto_id,
          venta.sucursal_id
        ]);
      }

      // Reverse cuenta_corriente
      if (venta.cliente_id) {
        const movsSql = `SELECT * FROM cuenta_corriente WHERE venta_id = ?`;
        const movs = window.SGA_DB.query(movsSql, [ventaId]);

        for (const mov of movs) {
          const revMovId = window.SGA_Utils.generateUUID();
          const revMovSql = `
            INSERT INTO cuenta_corriente (
              id, cliente_id, sucursal_id, tipo, monto, descripcion,
              fecha, usuario_id, sync_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;

          window.SGA_DB.run(revMovSql, [
            revMovId,
            mov.cliente_id,
            mov.sucursal_id,
            'ajuste',
            -mov.monto,
            `Reversión anulación venta ${ventaId.substring(0, 8)}: ${motivo}`,
            now,
            window.SGA_Auth.getCurrentUser().id,
            'pending',
            now
          ]);
        }
      }

      console.log('✅ Venta anulada:', ventaId);
      return { success: true };
    } catch (error) {
      console.error('❌ Error voiding venta:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get enabled payment methods
   */
  function getMediosHabilitados() {
    return [
      { id: 'efectivo', nombre: 'Efectivo', icon: '💵' },
      { id: 'mercadopago', nombre: 'Mercado Pago', icon: '📱' },
      { id: 'tarjeta', nombre: 'Tarjeta', icon: '💳' },
      { id: 'transferencia', nombre: 'Transferencia', icon: '🏦' },
      { id: 'cuenta_corriente', nombre: 'Cuenta Corriente', icon: '📋' }
    ];
  }

  /**
   * Get sales history
   */
  function getHistoricoVentas(sucursalId, fechaDesde, fechaHasta) {
    try {
      const sql = `
        SELECT 
          v.id, v.fecha, v.total, v.estado, v.cliente_id,
          c.nombre as cliente_nombre, u.nombre as usuario_nombre,
          COUNT(vi.id) as cantidad_items
        FROM ventas v
        LEFT JOIN clientes c ON v.cliente_id = c.id
        LEFT JOIN usuarios u ON v.usuario_id = u.id
        LEFT JOIN venta_items vi ON v.id = vi.venta_id
        WHERE v.sucursal_id = ? AND v.fecha >= ? AND v.fecha <= ?
        GROUP BY v.id
        ORDER BY v.fecha DESC
      `;

      return window.SGA_DB.query(sql, [sucursalId, fechaDesde, fechaHasta]);
    } catch (error) {
      console.error('❌ Error getting sales history:', error);
      return [];
    }
  }

  /**
   * Get full venta detail
   */
  function getVentaDetail(ventaId) {
    try {
      const sql = `SELECT * FROM ventas WHERE id = ?`;
      const results = window.SGA_DB.query(sql, [ventaId]);
      if (results.length === 0) return null;

      const venta = results[0];

      // Get items
      const itemsSql = `
        SELECT vi.*, p.nombre as producto_nombre
        FROM venta_items vi
        JOIN productos p ON vi.producto_id = p.id
        WHERE vi.venta_id = ?
      `;
      venta.items = window.SGA_DB.query(itemsSql, [ventaId]);

      // Get pagos
      const pagosSql = `SELECT * FROM venta_pagos WHERE venta_id = ?`;
      venta.pagos = window.SGA_DB.query(pagosSql, [ventaId]);

      return venta;
    } catch (error) {
      console.error('❌ Error getting venta detail:', error);
      return null;
    }
  }

  /**
   * Get current stock for product at sucursal
   */
  function getStockActual(productoId, sucursalId) {
    try {
      const sql = `SELECT cantidad FROM stock WHERE producto_id = ? AND sucursal_id = ?`;
      const results = window.SGA_DB.query(sql, [productoId, sucursalId]);
      return results.length > 0 ? results[0].cantidad : 0;
    } catch (error) {
      console.error('❌ Error getting stock:', error);
      return 0;
    }
  }

  // Public API
  return {
    getSesionActiva,
    abrirCaja,
    registrarVenta,
    calcularVuelto,
    aplicarPromociones,
    getClienteSaldo,
    cerrarCaja,
    registrarEgreso,
    pausarVenta,
    getPedidosAbiertos,
    retomarPedido,
    eliminarPedidoAbierto,
    registrarDevolucion,
    anularVenta,
    getMediosHabilitados,
    getHistoricoVentas,
    getVentaDetail,
    getStockActual,
    init
  };

  // Attach to window for global access
  window.SGA_POS = POS;
  console.log('💳 SGA_POS attached to window');

  return POS;
})();

// Also export as module default
export default POS;
