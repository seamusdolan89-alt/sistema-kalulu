
import Buscador from './buscador_productos.js';
'use strict';

const ConsumoInterno = (() => {

  const ge  = id => document.getElementById(id);
  const db  = () => window.SGA_DB;
  const fmt$ = n => window.SGA_Utils.formatCurrency(n);

  let cart             = [];   // [{ productoId, nombre, codigo, stock, costo, precioVenta, cantidad }]
  let lastResults      = [];   // últimos resultados de búsqueda
  let searchHlIdx      = -1;   // índice resaltado en el dropdown (-1 = ninguno)
  let searchTimer      = null;
  let sucursalId       = '1';
  let usuarios         = [];   // usuarios activos, para el selector "Consumo de"

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
          <div class="ci-cart-empty-icon">🏠</div>
          Buscá productos para registrar el consumo
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

  // ── Selector "Consumo de" + confirmación con contraseña ─────────────────────

  function cargarUsuarios() {
    usuarios = db().query(`SELECT id, nombre FROM usuarios WHERE activo = 1 ORDER BY nombre`);
  }

  function renderAtribuidoSelect() {
    const sel  = ge('ci-atribuido');
    const user = window.SGA_Auth.getCurrentUser();
    sel.innerHTML = usuarios.map(u => `
      <option value="${u.id}" ${u.id === user.id ? 'selected' : ''}>
        ${u.nombre}${u.id === user.id ? ' (vos)' : ''}
      </option>
    `).join('');
    togglePasswordField();
  }

  /**
   * Muestra el pedido de contraseña solo cuando el consumo se le atribuye a
   * otra persona — y creando el input recien ahi.
   *
   * No alcanza con ocultarlo: mientras el <input type="password"> exista en la
   * pagina, Chrome interpreta la pantalla como un formulario de login, toma el
   * buscador de productos como campo de usuario y lo autocompleta con un mail.
   * Al salir, encima, ofrece guardar la contraseña. Sacandolo del DOM no hay
   * login que detectar.
   *
   * Cuando se crea va con autocomplete="new-password", que es lo que le dice a
   * Chrome que no ofrezca credenciales guardadas: esta clave se escribe cada
   * vez, a proposito, porque es la autorizacion de otra persona.
   */
  function togglePasswordField() {
    const user   = window.SGA_Auth.getCurrentUser();
    const wrap   = ge('ci-password-wrap');
    const isOtro = ge('ci-atribuido').value !== user.id;

    if (!isOtro) {
      wrap.innerHTML = '';           // se va del DOM, no solo de la vista
      wrap.style.display = 'none';
      return;
    }

    if (!ge('ci-password')) {
      // Mientras sea type="password", Chrome lo trata como credencial: lo
      // empareja con el buscador de productos y al navegar ofrece guardar el
      // par (llego a proponer "coca cola" como nombre de usuario). Como esto no
      // es un login sino la autorizacion de otra persona, y tiene que
      // escribirse cada vez, el campo deja de ser una contraseña para el
      // navegador: texto comun enmascarado por CSS.
      //
      // Si el navegador no soporta el enmascarado se vuelve a type="password":
      // preferible el cartel de Chrome antes que la clave a la vista.
      const puedeEnmascarar = typeof CSS !== 'undefined' && CSS.supports
        && (CSS.supports('-webkit-text-security', 'disc')
            || CSS.supports('text-security', 'disc'));

      const campo = puedeEnmascarar
        ? `<input type="text" id="ci-password" class="ci-select"
                  autocomplete="off" autocorrect="off" autocapitalize="off"
                  spellcheck="false" placeholder="Contraseña"
                  style="-webkit-text-security:disc;text-security:disc">`
        : `<input type="password" id="ci-password" class="ci-select"
                  autocomplete="new-password" placeholder="Contraseña">`;

      wrap.innerHTML = `
        <div class="ci-sec-title">Contraseña de esa persona (para confirmar)</div>
        ${campo}
        <div id="ci-password-error"
             style="display:none;color:#c62828;font-size:0.85em;margin-top:4px;"></div>`;
    }
    wrap.style.display = '';
  }

  /** Borra la contraseña apenas deja de hacer falta. */
  function limpiarPassword() {
    const wrap = ge('ci-password-wrap');
    if (!wrap) return;
    const inp = ge('ci-password');
    if (inp) inp.value = '';
    wrap.innerHTML = '';
    wrap.style.display = 'none';
  }

  // ── Confirmar ─────────────────────────────────────────────────────────────

  async function confirmar() {
    const motivo      = ge('ci-motivo').value;
    const obs         = ge('ci-obs').value.trim();
    const atribuidoId = ge('ci-atribuido').value;
    const user        = window.SGA_Auth.getCurrentUser();

    if (!cart.length)  return mostrarError('Agregá al menos un producto.');
    if (!motivo)       return mostrarError('Seleccioná un motivo.');
    if (!atribuidoId)  return mostrarError('Seleccioná a nombre de quién es el consumo.');

    for (const item of cart) {
      if (item.cantidad <= 0)       return mostrarError(`Cantidad inválida: "${item.nombre}".`);
      if (item.cantidad > item.stock) return mostrarError(`Stock insuficiente para "${item.nombre}". Disponible: ${item.stock}`);
    }

    // Si se atribuye a otra persona, esa persona confirma con su propia contraseña
    // (sin desloguear a quien está operando la caja).
    if (atribuidoId !== user.id) {
      const password = ge('ci-password').value;
      const errEl = ge('ci-password-error');
      if (!password) {
        errEl.textContent = 'Ingresá la contraseña para confirmar.';
        errEl.style.display = '';
        return;
      }
      const ok = await window.SGA_Auth.verificarPassword(atribuidoId, password);
      if (!ok) {
        errEl.textContent = 'Contraseña incorrecta.';
        errEl.style.display = '';
        return;
      }
      errEl.style.display = 'none';
      // Validada, no queda dando vueltas: un campo de contraseña con contenido
      // al momento de navegar es lo que dispara el "¿guardar contraseña?".
      limpiarPassword();
    }

    const btn = ge('ci-confirm');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const now  = new Date().toISOString();

      db().beginBatch();

      for (const item of cart) {
        db().run(
          `INSERT INTO consumo_interno
             (id, producto_id, sucursal_id, usuario_id, registrado_por_usuario_id,
              cantidad, costo_unitario, precio_venta_unitario, motivo, observaciones, fecha, sync_status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [window.SGA_Utils.generateUUID(), item.productoId, sucursalId,
           atribuidoId, user.id, item.cantidad, item.costo, item.precioVenta, motivo, obs, now, now]
        );

        db().run(
          `UPDATE stock SET cantidad = cantidad - ?, fecha_modificacion = ?
           WHERE producto_id = ? AND sucursal_id = ?`,
          [item.cantidad, now, item.productoId, sucursalId]
        );

        db().run(
          `INSERT INTO stock_ajustes
             (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id, fecha, estado, sync_status, updated_at)
           VALUES (?, ?, ?, 'consumo_interno', ?, ?, ?, ?, 'aprobado', 'pending', ?)`,
          [window.SGA_Utils.generateUUID(), item.productoId, sucursalId,
           item.cantidad, motivo + (obs ? ': ' + obs : ''), atribuidoId, now, now]
        );
      }

      db().commitBatch();

      for (const item of cart) {
        db().registrarHistorialStock(item.productoId, sucursalId);
      }

      window.SGA_Utils.showNotification('Consumo registrado correctamente', 'success');
      window.location.hash = '#operaciones_stock';

    } catch (err) {
      db().rollbackBatch();
      mostrarError('Error al guardar: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Registrar consumo';
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

    cargarUsuarios();
    renderAtribuidoSelect();
    ge('ci-atribuido').addEventListener('change', togglePasswordField);

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

export default ConsumoInterno;
