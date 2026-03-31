/**
 * compras.js — Manual Purchase Entry Module
 *
 * 5-step flow: Datos → Carga de productos → Revisión → Ajuste precios → Resumen
 */

const Compras = (() => {
  'use strict';

  // ── HELPERS ────────────────────────────────────────────────────────────────
  const ge   = (id) => document.getElementById(id);
  const esc  = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const uuid = () => window.SGA_Utils.generateUUID();
  const now  = () => window.SGA_Utils.formatISODate(new Date());
  const fmt$ = (n) => window.SGA_Utils.formatCurrency(n);
  const fmtFecha = (s) => window.SGA_Utils.formatFecha(s);
  const todayISO = () => new Date().toISOString().slice(0, 10);

  const UNIDADES_COMPRA = ['Unidad', 'Pack', 'Caja', 'Kg', 'Lt', 'Bolsa', 'Fardo', 'Docena'];
  const UNIDADES_VENTA  = ['Unidad', 'Kg', 'Lt', '100g', '½ kg'];

  const ESTADO_LABEL = {
    borrador:       'Borrador',
    confirmada:     'Confirmada',
    pendiente_pago: 'Pago pendiente',
    pagada:         'Pagada',
  };

  // ── STATE ──────────────────────────────────────────────────────────────────
  const state = {
    user: null,
    view: 'lista',  // 'lista' | 'nueva'
    nueva: null,
    confirmarResult: null,
    priceAdjustments: [],  // [{productoId, precioNuevo, incluir, aplicarFamilia}]
    pendingNavAway: null,  // function to call if user confirms leaving
  };

  function _initNueva() {
    state.nueva = {
      step: 1,
      proveedorId: null,
      proveedorNombre: '',
      numeroFactura: '',
      fecha: todayISO(),
      condicionPago: 'efectivo',
      vinculadaOrdenId: null,
      vinculadaOrdenNombre: '',
      // items: [{productoId, nombre, barcode, unidadCompra, udsPaquete, costoActual, costoNuevo, cantidad}]
      items: [],
      compraId: null,
    };
  }

  // ── DB MIGRATIONS ──────────────────────────────────────────────────────────
  function _migrate() {
    const alters = [
      "ALTER TABLE compras ADD COLUMN condicion_pago TEXT DEFAULT 'efectivo'",
      "ALTER TABLE compras ADD COLUMN estado TEXT DEFAULT 'borrador'",
      'ALTER TABLE compras ADD COLUMN vinculada_orden_id TEXT',
      "ALTER TABLE compra_items ADD COLUMN unidad_compra TEXT DEFAULT 'Unidad'",
      'ALTER TABLE compra_items ADD COLUMN unidades_por_paquete REAL DEFAULT 1',
      'ALTER TABLE cuenta_proveedor ADD COLUMN compra_id TEXT',
    ];
    for (const sql of alters) {
      try { window.SGA_DB.run(sql); } catch(e) { /* already exists */ }
    }
    try {
      window.SGA_DB.run(`
        CREATE TABLE IF NOT EXISTS compras_pausadas (
          id TEXT PRIMARY KEY,
          sucursal_id TEXT NOT NULL,
          usuario_id TEXT NOT NULL,
          snapshot TEXT NOT NULL,
          proveedor_nombre TEXT,
          num_items INTEGER DEFAULT 0,
          total_estimado REAL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    } catch(e) { /* already exists */ }
  }

  // ── DATA LAYER ─────────────────────────────────────────────────────────────

  function _getAll({ proveedorId, fechaDesde, fechaHasta, estado } = {}) {
    const where  = [];
    const params = [];
    const sucId  = state.user?.sucursal_id;
    if (sucId) { where.push('c.sucursal_id = ?'); params.push(sucId); }
    if (proveedorId) { where.push('c.proveedor_id = ?'); params.push(proveedorId); }
    if (fechaDesde)  { where.push("c.fecha >= ?"); params.push(fechaDesde); }
    if (fechaHasta)  { where.push("c.fecha <= ?"); params.push(fechaHasta + 'T23:59:59'); }
    if (estado)      { where.push('c.estado = ?'); params.push(estado); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return window.SGA_DB.query(`
      SELECT c.*, p.razon_social AS proveedor_nombre,
        (SELECT COUNT(*) FROM compra_items ci WHERE ci.compra_id = c.id) AS num_items
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      ${wc}
      ORDER BY c.fecha DESC
    `, params);
  }

  function _getById(id) {
    const compra = window.SGA_DB.query(`
      SELECT c.*, p.razon_social AS proveedor_nombre
      FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE c.id = ?
    `, [id])[0];
    if (!compra) return null;
    compra.items = window.SGA_DB.query(`
      SELECT ci.*, pr.nombre AS producto_nombre, pr.precio,
        cb.codigo AS barcode
      FROM compra_items ci
      LEFT JOIN productos pr ON pr.id = ci.producto_id
      LEFT JOIN codigos_barras cb ON cb.producto_id = ci.producto_id AND cb.es_principal = 1
      WHERE ci.compra_id = ?
    `, [id]);
    return compra;
  }

  function _crear(data) {
    const id = uuid();
    const ts = now();
    try {
      window.SGA_DB.beginBatch();
      window.SGA_DB.run(`
        INSERT INTO compras
          (id,sucursal_id,proveedor_id,usuario_id,fecha,numero_factura,total,condicion_pago,estado,vinculada_orden_id,sync_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `, [id, data.sucursalId, data.proveedorId, data.usuarioId,
          data.fecha, data.numeroFactura || null, data.total,
          data.condicionPago, 'borrador',
          data.vinculadaOrdenId || null, 'pending', ts]);

      for (const item of data.items) {
        const costoNvo = parseFloat(item.costoNuevo) || 0;
        const costoAnt = parseFloat(item.costoActual) || 0;
        const udsPaq = parseFloat(item.udsPaquete) || 1;
        window.SGA_DB.run(`
          INSERT INTO compra_items
            (id,compra_id,producto_id,cantidad,costo_unitario,costo_anterior,subtotal,costo_modificado,unidad_compra,unidades_por_paquete)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `, [uuid(), id, item.productoId,
            parseFloat(item.cantidad),
            costoNvo, costoAnt,
            parseFloat(item.cantidad) * udsPaq * costoNvo,
            Math.abs(costoNvo - costoAnt) > 0.001 ? 1 : 0,
            item.unidadCompra || 'Unidad',
            udsPaq]);
      }
      window.SGA_DB.commitBatch();
      return { success: true, id };
    } catch (e) {
      window.SGA_DB.rollbackBatch();
      return { success: false, error: e.message };
    }
  }

  function _confirmar(compraId) {
    const compra = _getById(compraId);
    if (!compra) return { success: false, error: 'Compra no encontrada' };

    const user  = state.user;
    const sucId = user.sucursal_id;
    const ts    = now();

    const sesion = window.SGA_DB.query(
      `SELECT id FROM sesiones_caja WHERE sucursal_id=? AND estado='abierta' LIMIT 1`, [sucId]
    )[0];

    const productosNuevos = [];
    const cambiosCosto    = [];
    let total = 0;

    try {
      window.SGA_DB.beginBatch();

      for (const item of compra.items) {
        const cant    = parseFloat(item.cantidad) || 0;
        const udsPaq  = parseFloat(item.unidades_por_paquete) || 1;
        const cantUds = cant * udsPaq;

        // Stock
        const existing = window.SGA_DB.query(
          `SELECT cantidad FROM stock WHERE producto_id=? AND sucursal_id=?`,
          [item.producto_id, sucId]
        )[0];
        if (existing) {
          window.SGA_DB.run(
            `UPDATE stock SET cantidad=cantidad+?, fecha_modificacion=? WHERE producto_id=? AND sucursal_id=?`,
            [cantUds, ts, item.producto_id, sucId]
          );
        } else {
          window.SGA_DB.run(
            `INSERT INTO stock (producto_id,sucursal_id,cantidad,fecha_modificacion) VALUES (?,?,?,?)`,
            [item.producto_id, sucId, cantUds, ts]
          );
        }

        const costoAnt = parseFloat(item.costo_anterior) || 0;
        const costoNvo = parseFloat(item.costo_unitario)  || 0;
        total += costoNvo * cant * udsPaq;

        if (costoNvo > 0 && costoAnt > 0 && Math.abs(costoNvo - costoAnt) > 0.001) {
          const prod = window.SGA_DB.query(
            `SELECT nombre, precio, costo_paquete, producto_madre_id FROM productos WHERE id=?`,
            [item.producto_id]
          )[0];
          if (prod) {
            window.SGA_DB.run(
              `UPDATE productos SET costo=?, costo_paquete=?, updated_at=? WHERE id=?`,
              [costoNvo, costoNvo * udsPaq, ts, item.producto_id]
            );
            cambiosCosto.push({
              productoId:     item.producto_id,
              nombre:         item.producto_nombre || prod.nombre,
              costoAnterior:  costoAnt,
              costoNuevo:     costoNvo,
              precioAnterior: parseFloat(item.precio) || 0,
              productaMadreId: prod.producto_madre_id || null,
            });
          }
        }
      }

      // Payment
      if (compra.condicion_pago === 'efectivo' && sesion) {
        window.SGA_DB.run(`
          INSERT INTO egresos_caja
            (id,sesion_caja_id,monto,descripcion,tipo,fecha,usuario_id,sync_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)
        `, [uuid(), sesion.id, compra.total,
            `Compra${compra.numero_factura ? ' Fact. ' + compra.numero_factura : ''} — ${compra.proveedor_nombre}`,
            'pago_proveedor', ts, user.id, 'pending', ts]);
      } else if (compra.condicion_pago === 'pendiente') {
        window.SGA_DB.run(`
          INSERT INTO cuenta_proveedor
            (id,proveedor_id,orden_id,compra_id,tipo,monto,descripcion,fecha,usuario_id,sync_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [uuid(), compra.proveedor_id, null, compraId, 'deuda', compra.total,
            `Compra ${compra.numero_factura || compraId.slice(-6).toUpperCase()}`,
            ts, user.id, 'pending', ts]);
      }

      // Link to orden if set
      if (compra.vinculada_orden_id) {
        const nuevoEstado = compra.condicion_pago === 'pendiente' ? 'pendiente_pago' : 'cerrada';
        window.SGA_DB.run(
          `UPDATE ordenes_compra SET estado=?, updated_at=? WHERE id=?`,
          [nuevoEstado, ts, compra.vinculada_orden_id]
        );
      }

      window.SGA_DB.run(
        `UPDATE compras SET estado='confirmada', total=?, updated_at=? WHERE id=?`,
        [total, ts, compraId]
      );

      window.SGA_DB.commitBatch();
      return { success: true, productosNuevos, cambiosCosto, total };
    } catch (e) {
      window.SGA_DB.rollbackBatch();
      return { success: false, error: e.message };
    }
  }

  function _getResumenParaCompartir(compraId) {
    const compra = _getById(compraId);
    if (!compra) return '';
    const fecha = fmtFecha(compra.fecha);
    let txt = `📦 *Compra registrada - ${fecha}*\n`;
    txt += `Proveedor: ${compra.proveedor_nombre}\n`;
    if (compra.numero_factura) txt += `Factura: ${compra.numero_factura}\n`;
    txt += '\n*Productos:*\n';
    for (const item of compra.items) {
      txt += `• ${item.producto_nombre} x${item.cantidad} ${item.unidad_compra} — ${fmt$(parseFloat(item.cantidad) * parseFloat(item.costo_unitario))}\n`;
    }
    txt += `\nTotal compra: ${fmt$(compra.total)}`;
    return txt;
  }

  // Expose data layer
  window.SGA_Compras = {
    getAll:                  _getAll,
    getById:                 _getById,
    crear:                   _crear,
    confirmar:               _confirmar,
    getResumenParaCompartir: _getResumenParaCompartir,
    pausar:                  _pausarCompra,
    retomar:                 _retomarCompra,
  };

  // ── UI HELPERS ─────────────────────────────────────────────────────────────

  function _calcTotal() {
    return state.nueva.items.reduce((sum, it) => {
      const cant     = parseFloat(it.cantidad)   || 0;
      const udsPaq   = parseFloat(it.udsPaquete) || 1;
      const costoNvo = parseFloat(it.costoNuevo) || parseFloat(it.costoActual) || 0;
      return sum + cant * udsPaq * costoNvo;
    }, 0);
  }

  function _itemSubtotal(it) {
    return (parseFloat(it.cantidad) || 0)
         * (parseFloat(it.udsPaquete) || 1)
         * (parseFloat(it.costoNuevo) || parseFloat(it.costoActual) || 0);
  }

  function _ucOptions(selected) {
    return UNIDADES_COMPRA.map(u =>
      `<option value="${u}"${u === selected ? ' selected' : ''}>${u}</option>`
    ).join('');
  }

  function _unidadVentaOptions(selected) {
    return UNIDADES_VENTA.map(u =>
      `<option value="${u}"${u === selected ? ' selected' : ''}>${u}</option>`
    ).join('');
  }

  // ── LISTA ──────────────────────────────────────────────────────────────────

  function renderLista() {
    state.view = 'lista';
    const sucId   = state.user?.sucursal_id;
    const compras = _getAll();
    const tbody   = ge('cmp-tbody');
    const empty   = ge('cmp-empty');
    if (!tbody) return;

    // Show paused compras if any
    const pausadas = sucId ? window.SGA_DB.query(
      `SELECT * FROM compras_pausadas WHERE sucursal_id=? ORDER BY updated_at DESC`,
      [sucId]
    ) : [];

    const pausadasEl = document.querySelector('.cmp-pausadas-section');
    if (pausadasEl) pausadasEl.remove();

    if (pausadas.length) {
      const section = document.createElement('div');
      section.className = 'cmp-pausadas-section';
      section.innerHTML = `
        <h4>⏸ Compras pausadas (${pausadas.length})</h4>
        ${pausadas.map(p => `
          <div class="cmp-pausada-row">
            <div>
              <strong>${esc(p.proveedor_nombre || '—')}</strong>
              <span> — ${p.num_items} prod. · ${fmt$(p.total_estimado)}</span>
            </div>
            <button class="btn btn-sm btn-primary" data-retomar="${p.id}">Retomar</button>
          </div>
        `).join('')}
      `;
      const wrap = document.querySelector('.cmp-table-wrap');
      if (wrap) wrap.parentNode.insertBefore(section, wrap);
    }

    if (!compras.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = compras.map(c => {
      const estado = c.estado || 'borrador';
      const pago   = c.condicion_pago === 'pendiente' ? '⏳ Pendiente' : '✓ Efectivo';
      return `
        <tr>
          <td>${fmtFecha(c.fecha)}</td>
          <td>${esc(c.proveedor_nombre || '—')}</td>
          <td>${esc(c.numero_factura || '—')}</td>
          <td>${c.num_items || 0}</td>
          <td>${fmt$(c.total || 0)}</td>
          <td><span class="cmp-badge cmp-badge-${estado}">${ESTADO_LABEL[estado] || estado}</span></td>
          <td style="font-size:12px;color:var(--color-text-secondary)">${pago}</td>
          <td>
            ${estado === 'borrador' ? `<button class="btn btn-sm btn-primary" data-confirmar="${c.id}">Confirmar</button>` : ''}
            <button class="btn btn-sm btn-ghost" data-ver="${c.id}">Ver</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ── NUEVA COMPRA ───────────────────────────────────────────────────────────

  function openNuevaCompra() {
    _initNueva();
    state.view = 'nueva';
    ge('cmp-nueva-overlay').style.display = 'flex';
    renderStepIndicators();
    renderStep();
  }

  function closeNuevaCompra(force = false) {
    if (!force && state.nueva?.items?.length > 0 && !state.nueva.compraId) {
      _showNavGuard(null);  // guard handles actions itself
      return;
    }
    document.removeEventListener('keydown', _docKeydownStep2);
    ge('cmp-nueva-overlay').style.display = 'none';
    state.view = 'lista';
    state.nueva = null;
    renderLista();
  }

  function renderStepIndicators() {
    const step = state.nueva.step;
    // Step 3 (review) is removed from visible flow — confirm is now in step 2 right panel
    // Internal: 1=Datos, 2=Productos, 4=Precios, 5=Resumen
    const steps = [
      { n: 1, vis: 1, label: '1. Datos' },
      { n: 2, vis: 2, label: '2. Productos' },
      { n: 4, vis: 3, label: '3. Precios' },
      { n: 5, vis: 4, label: '4. Resumen' },
    ];
    ge('cmp-steps').innerHTML = steps.map(s => {
      let cls = 'cmp-step-ind';
      if (s.n === step) cls += ' active';
      else if (s.n < step) cls += ' done';
      return `<div class="${cls}">${s.n < step ? '✓ ' : ''}${s.label}</div>`;
    }).join('');
  }

  function renderStep() {
    renderStepIndicators();
    const body   = ge('cmp-nueva-body');
    const footer = ge('cmp-nueva-footer');
    if (!body || !footer) return;
    // Reset body padding/overflow for step 2 (POS full-screen, no padding)
    body.style.padding  = state.nueva.step === 2 ? '0' : '24px';
    body.style.overflow = state.nueva.step === 2 ? 'hidden' : '';
    switch (state.nueva.step) {
      case 1: renderStep1(body, footer); break;
      case 2: renderStep2(body, footer); break;
      case 4: renderStep4(body, footer); break;
      case 5: renderStep5(body, footer); break;
    }
  }

  // ── STEP 1 — DATOS ────────────────────────────────────────────────────────

  function renderStep1(body, footer) {
    const n = state.nueva;
    const provs = window.SGA_DB.query(
      `SELECT id, razon_social FROM proveedores WHERE activo=1 ORDER BY razon_social`
    );

    body.innerHTML = `
      <div style="max-width:560px">
        <div class="cmp-form-row">
          <div class="cmp-form-group">
            <label>Proveedor <span class="req">*</span></label>
            <div class="cmp-search-wrap">
              <input type="text" id="cmp-prov-search" autocomplete="off"
                placeholder="Buscar proveedor..." value="${esc(n.proveedorNombre)}">
              <input type="hidden" id="cmp-prov-id" value="${esc(n.proveedorId || '')}">
              <div class="cmp-dropdown" id="cmp-prov-dd"></div>
            </div>
          </div>
          <div class="cmp-form-group">
            <label>Fecha <span class="req">*</span></label>
            <input type="date" id="cmp-fecha" value="${esc(n.fecha)}">
          </div>
        </div>
        <div class="cmp-form-group">
          <label>Vinculada a orden de compra <span style="font-weight:400;color:var(--color-text-secondary)">(opcional)</span></label>
          <div class="cmp-search-wrap">
            <input type="text" id="cmp-orden-search" autocomplete="off"
              placeholder="${n.proveedorId ? '¿Corresponde a una orden previa?' : 'Seleccioná un proveedor primero'}"
              value="${esc(n.vinculadaOrdenNombre)}"
              ${n.proveedorId ? '' : 'disabled style="opacity:.5;cursor:not-allowed"'}>
            <input type="hidden" id="cmp-orden-id" value="${esc(n.vinculadaOrdenId || '')}">
            <div class="cmp-dropdown" id="cmp-orden-dd"></div>
          </div>
        </div>
      </div>
    `;

    footer.innerHTML = `
      <div></div>
      <button class="btn btn-primary" id="cmp-next1">Siguiente →</button>
    `;

    // Proveedor search
    _attachSearch('cmp-prov-search', 'cmp-prov-id', 'cmp-prov-dd', provs, 'id', 'razon_social', (item) => {
      n.proveedorId    = item.id;
      n.proveedorNombre = item.razon_social;
      // Enable orden field now that proveedor is selected
      const ordenSearch = ge('cmp-orden-search');
      if (ordenSearch) {
        ordenSearch.disabled = false;
        ordenSearch.style.opacity = '';
        ordenSearch.style.cursor  = '';
        ordenSearch.placeholder   = '¿Corresponde a una orden previa?';
      }
      _loadOrdenesForProveedor(item.id);
    });

    // Orden search (load if proveedor already selected)
    if (n.proveedorId) _loadOrdenesForProveedor(n.proveedorId);

    ge('cmp-next1').addEventListener('click', () => {
      const provId = ge('cmp-prov-id').value;
      if (!provId) {
        window.SGA_Utils.showNotification('Seleccioná un proveedor', 'error'); return;
      }
      const fecha = ge('cmp-fecha').value;
      if (!fecha) {
        window.SGA_Utils.showNotification('Ingresá la fecha', 'error'); return;
      }
      n.proveedorId          = provId;
      n.proveedorNombre      = ge('cmp-prov-search').value;
      n.fecha                = fecha;
      n.vinculadaOrdenId     = ge('cmp-orden-id').value || null;
      n.vinculadaOrdenNombre = ge('cmp-orden-search').value;
      n.step = 2;
      renderStep();
    });
  }

  function _loadOrdenesForProveedor(provId) {
    const ordenes = window.SGA_DB.query(`
      SELECT id, fecha_creacion, notas
      FROM ordenes_compra
      WHERE proveedor_id=? AND estado IN ('enviada','recibiendo','recibida_parcial')
      ORDER BY fecha_creacion DESC LIMIT 30
    `, [provId]);

    const search = ge('cmp-orden-search');
    const dd     = ge('cmp-orden-dd');
    if (!search || !dd) return;

    const mapped = ordenes.map(o => ({
      id: o.id,
      label: `OC ${o.id.slice(-6).toUpperCase()} — ${fmtFecha(o.fecha_creacion)}${o.notas ? ' — ' + o.notas : ''}`,
    }));

    // Auto-select if exactly one open orden
    if (mapped.length === 1 && !state.nueva.vinculadaOrdenId) {
      search.value = mapped[0].label;
      ge('cmp-orden-id').value = mapped[0].id;
      state.nueva.vinculadaOrdenId   = mapped[0].id;
      state.nueva.vinculadaOrdenNombre = mapped[0].label;
      return;
    }

    _attachSearch('cmp-orden-search', 'cmp-orden-id', 'cmp-orden-dd', mapped, 'id', 'label', (item) => {
      state.nueva.vinculadaOrdenId   = item.id;
      state.nueva.vinculadaOrdenNombre = item.label;
    });
  }

  // ── STEP 2 — CARGA DE PRODUCTOS (POS-STYLE) ───────────────────────────────

  let _scanBuffer       = '';
  let _scanTimer        = null;
  let _scanDdHighlighted = -1;

  function renderStep2(body, footer) {
    const n = state.nueva;

    // Proveedor info & deuda
    const prov = window.SGA_DB.query(
      `SELECT razon_social FROM proveedores WHERE id=?`, [n.proveedorId]
    )[0];
    const deudaRow = window.SGA_DB.query(
      `SELECT COALESCE(SUM(CASE WHEN tipo='deuda' THEN monto ELSE -monto END),0) AS saldo FROM cuenta_proveedor WHERE proveedor_id=?`,
      [n.proveedorId]
    )[0];
    const deuda = deudaRow?.saldo || 0;

    // Pending ordenes for this proveedor
    const ordenes = window.SGA_DB.query(`
      SELECT id, fecha_creacion, notas FROM ordenes_compra
      WHERE proveedor_id=? AND estado IN ('enviada','recibiendo','recibida_parcial')
      ORDER BY fecha_creacion DESC LIMIT 5
    `, [n.proveedorId]);

    if (!n.condicionPago) n.condicionPago = 'efectivo';

    body.innerHTML = `
      <div class="cmp-step2-layout">
        <!-- LEFT: scan bar + items table + footer -->
        <div class="cmp-step2-left">
          <div class="cmp-s2-scan-bar">
            <div class="cmp-scan-input-wrap">
              <input id="cmp-scan-input" type="text" autocomplete="off" spellcheck="false"
                placeholder="Escanear o buscar producto...">
              <div class="cmp-dropdown" id="cmp-scan-dd"></div>
            </div>
          </div>
          <div class="cmp-items-table-wrap" id="cmp-items-wrap">
            <div class="cmp-items-empty" id="cmp-items-empty">
              Escaneá o buscá un producto para comenzar.
            </div>
            <table class="cmp-items-table" id="cmp-items-tbl" style="display:none">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Unidad</th>
                  <th>Cant.</th>
                  <th>Uds/paq.</th>
                  <th>Costo ant.</th>
                  <th>Costo nuevo</th>
                  <th>Subtotal</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="cmp-items-tbody"></tbody>
            </table>
          </div>
          <div class="cmp-items-footer">
            <div id="cmp-items-count" style="color:var(--color-text-secondary)">0 productos</div>
            <div class="cmp-items-total" id="cmp-items-total">${fmt$(0)}</div>
          </div>
        </div>

        <!-- RIGHT: proveedor info + pago + confirm -->
        <div class="cmp-step2-right">
          <div class="cmp-s2-prov-card">
            <div class="cmp-s2-prov-name">${esc(prov?.razon_social || n.proveedorNombre)}</div>
            ${deuda > 0
              ? `<div class="cmp-s2-deuda-badge">Deuda: ${fmt$(deuda)}</div>`
              : `<div class="cmp-s2-saldo-ok">Sin deuda</div>`}
          </div>

          ${ordenes.length ? `
            <div class="cmp-s2-section-label">Órdenes pendientes</div>
            ${ordenes.map(o => `
              <div class="cmp-s2-orden-item${n.vinculadaOrdenId === o.id ? ' selected' : ''}"
                data-orden-id="${o.id}"
                data-orden-label="OC ${o.id.slice(-6).toUpperCase()} — ${fmtFecha(o.fecha_creacion)}">
                OC ${o.id.slice(-6).toUpperCase()} — ${fmtFecha(o.fecha_creacion)}
                ${o.notas ? `<br><small style="color:var(--color-text-secondary)">${esc(o.notas)}</small>` : ''}
              </div>
            `).join('')}
          ` : ''}

          <button class="btn btn-ghost btn-sm" id="cmp-s2-nuevo-prod"
            style="margin-top:8px;width:100%;text-align:left;font-size:12px">
            + Nuevo producto
          </button>
          <div id="cmp-new-prod-wrap" style="display:none;margin-top:6px"></div>

          <div class="cmp-s2-section-label">Forma de pago</div>
          <div class="cmp-s2-pago-chips">
            <button class="cmp-pago-chip${n.condicionPago==='efectivo'?' active':''}" data-pago="efectivo">💵 Efectivo</button>
            <button class="cmp-pago-chip${n.condicionPago==='transferencia'?' active':''}" data-pago="transferencia">🏦 Trans.</button>
            <button class="cmp-pago-chip${n.condicionPago==='pendiente'?' active':''}" data-pago="pendiente">⏳ Pendiente</button>
          </div>

          <div id="cmp-s2-efectivo-wrap" style="display:${n.condicionPago==='efectivo'?'':'none'}">
            <div class="cmp-s2-entrego-row">
              <label>Entregó</label>
              <input type="number" id="cmp-s2-entrego" min="0" step="any" placeholder="0"
                value="${n.entrego || ''}">
            </div>
            <div class="cmp-s2-vuelto-row">
              Vuelto: <strong id="cmp-s2-vuelto">${fmt$(Math.max(0, (n.entrego||0) - _calcTotal()))}</strong>
            </div>
          </div>

          <details class="cmp-s2-factura-details" ${n.numeroFactura ? 'open' : ''}>
            <summary>📄 Datos de factura</summary>
            <div class="cmp-s2-factura-fields">
              <div class="cmp-form-group">
                <label>Número de factura</label>
                <input type="text" id="cmp-s2-factura" placeholder="Ej: A-0001-00012345"
                  value="${esc(n.numeroFactura)}">
              </div>
              <div class="cmp-form-group">
                <label>Fecha</label>
                <input type="date" id="cmp-s2-fecha" value="${esc(n.fecha)}">
              </div>
            </div>
          </details>

          <div class="cmp-s2-confirm-area">
            <div class="cmp-s2-total-line">
              Total: <span id="cmp-s2-total">${fmt$(_calcTotal())}</span>
            </div>
            <button class="btn btn-primary cmp-s2-confirmar-btn" id="cmp-s2-confirmar">
              ✓ CONFIRMAR COMPRA
            </button>
            <button class="btn btn-ghost cmp-s2-pausar-btn" id="cmp-s2-pausar">
              ⏸ Pausar compra
            </button>
          </div>
        </div>
      </div>
    `;

    footer.innerHTML = `
      <button class="btn btn-secondary" id="cmp-back2">← Volver a datos</button>
      <div></div>
    `;

    _renderItemsTable();

    // Scanner input
    const scanInput = ge('cmp-scan-input');
    if (scanInput) {
      scanInput.focus();
      scanInput.addEventListener('input', () => { _scanDdHighlighted = -1; _onScanInput(scanInput.value); });
      scanInput.addEventListener('keydown', e => {
        const dd   = ge('cmp-scan-dd');
        const rows = dd?.querySelectorAll('.cmp-dd-item') || [];
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          _scanDdHighlighted = Math.min(_scanDdHighlighted + 1, rows.length - 1);
          rows.forEach((r, i) => r.classList.toggle('highlighted', i === _scanDdHighlighted));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          _scanDdHighlighted = Math.max(_scanDdHighlighted - 1, -1);
          rows.forEach((r, i) => r.classList.toggle('highlighted', i === _scanDdHighlighted));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (_scanDdHighlighted >= 0 && rows[_scanDdHighlighted]) {
            rows[_scanDdHighlighted].dispatchEvent(new Event('mousedown'));
          } else {
            _onScanEnter(scanInput.value.trim());
          }
          scanInput.value = '';
          _scanDdHighlighted = -1;
          if (dd) { dd.classList.remove('open'); dd.innerHTML = ''; }
        } else if (e.key === 'Escape') {
          scanInput.value = '';
          _scanDdHighlighted = -1;
          if (dd) { dd.classList.remove('open'); }
        }
      });
    }

    // Orden item click
    body.querySelectorAll('.cmp-s2-orden-item').forEach(el => {
      el.addEventListener('click', () => {
        const id    = el.dataset.ordenId;
        const label = el.dataset.ordenLabel;
        if (n.vinculadaOrdenId === id) {
          // Toggle off
          n.vinculadaOrdenId   = null;
          n.vinculadaOrdenNombre = '';
          el.classList.remove('selected');
        } else {
          body.querySelectorAll('.cmp-s2-orden-item').forEach(x => x.classList.remove('selected'));
          n.vinculadaOrdenId   = id;
          n.vinculadaOrdenNombre = label;
          el.classList.add('selected');
        }
      });
    });

    // Payment chips
    body.querySelectorAll('.cmp-pago-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        body.querySelectorAll('.cmp-pago-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        n.condicionPago = btn.dataset.pago;
        ge('cmp-s2-efectivo-wrap').style.display = n.condicionPago === 'efectivo' ? '' : 'none';
        _updateS2Vuelto();
      });
    });

    // Entrego input
    const entregoInp = ge('cmp-s2-entrego');
    if (entregoInp) {
      entregoInp.addEventListener('input', () => {
        n.entrego = parseFloat(entregoInp.value) || 0;
        _updateS2Vuelto();
      });
    }

    // Quick product button
    ge('cmp-s2-nuevo-prod')?.addEventListener('click', () => _showNewProductForm(''));

    // Factura fields sync
    ge('cmp-s2-factura')?.addEventListener('input', e => { n.numeroFactura = e.target.value.trim(); });
    ge('cmp-s2-fecha')?.addEventListener('change', e => { n.fecha = e.target.value; });

    // Back button
    ge('cmp-back2').addEventListener('click', () => {
      document.removeEventListener('keydown', _docKeydownStep2);
      state.nueva.step = 1;
      renderStep();
    });

    // Pause button
    ge('cmp-s2-pausar')?.addEventListener('click', () => _pausarCompra());

    // CONFIRM button
    ge('cmp-s2-confirmar').addEventListener('click', () => _confirmarDesdeStep2());

    // Document-level keydown fallback (barcode scanner redirect)
    document.addEventListener('keydown', _docKeydownStep2);
  }

  function _updateS2Vuelto() {
    const n       = state.nueva;
    const total   = _calcTotal();
    const entrego = parseFloat(n.entrego) || 0;
    const vueltoEl = ge('cmp-s2-vuelto');
    const totalEl  = ge('cmp-s2-total');
    if (vueltoEl) vueltoEl.textContent = fmt$(Math.max(0, entrego - total));
    if (totalEl)  totalEl.textContent  = fmt$(total);
  }

  function _confirmarDesdeStep2() {
    const n = state.nueva;
    if (!n.items.length) {
      window.SGA_Utils.showNotification('Agregá al menos un producto', 'error'); return;
    }
    const btn = ge('cmp-s2-confirmar');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    // Save factura/fecha from right panel
    const facturaInp = ge('cmp-s2-factura');
    const fechaInp   = ge('cmp-s2-fecha');
    if (facturaInp) n.numeroFactura = facturaInp.value.trim();
    if (fechaInp)   n.fecha         = fechaInp.value || n.fecha;

    const total = _calcTotal();
    const crearRes = _crear({
      sucursalId:       state.user.sucursal_id,
      proveedorId:      n.proveedorId,
      usuarioId:        state.user.id,
      fecha:            n.fecha,
      numeroFactura:    n.numeroFactura,
      total,
      condicionPago:    n.condicionPago,
      vinculadaOrdenId: n.vinculadaOrdenId,
      items:            n.items,
    });

    if (!crearRes.success) {
      window.SGA_Utils.showNotification('Error al guardar: ' + crearRes.error, 'error');
      btn.disabled = false;
      btn.textContent = '✓ CONFIRMAR COMPRA';
      return;
    }

    n.compraId = crearRes.id;
    const res  = _confirmar(crearRes.id);

    if (!res.success) {
      window.SGA_Utils.showNotification('Error al confirmar: ' + res.error, 'error');
      btn.disabled = false;
      btn.textContent = '✓ CONFIRMAR COMPRA';
      return;
    }

    document.removeEventListener('keydown', _docKeydownStep2);
    state.confirmarResult = res;
    state.priceAdjustments = res.cambiosCosto.map(c => ({
      ...c,
      precioNuevo:    '',
      incluir:        true,
      aplicarFamilia: false,
    }));

    n.step = res.cambiosCosto.length > 0 ? 4 : 5;
    renderStep();
  }

  function _docKeydownStep2(e) {
    const scanInput = ge('cmp-scan-input');
    if (!scanInput) return;
    if (document.activeElement === scanInput) return;
    // Don't redirect if a number/text input in the items table is focused
    const active = document.activeElement;
    if (active && (active.matches('.cmp-cant, .cmp-udspaq, .cmp-costo-nvo') ||
        active.closest('.cmp-s2-factura-details, #cmp-new-prod-wrap, .cmp-s2-entrego-row'))) return;
    // Ignore modifier-only keys
    if (['Shift','Control','Alt','Meta','Tab','CapsLock'].includes(e.key)) return;
    if (e.key === 'Enter') return;
    scanInput.focus();
  }

  function _onScanInput(val) {
    const dd = ge('cmp-scan-dd');
    if (!dd) return;
    if (val.length < 2) {
      dd.classList.remove('open');
      return;
    }
    const results = window.SGA_DB.query(`
      SELECT p.id, p.nombre, p.costo,
        p.unidad_compra, p.unidades_por_paquete_compra,
        cb.codigo AS barcode
      FROM productos p
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      WHERE p.activo = 1 AND (
        LOWER(p.nombre) LIKE LOWER(?) OR
        EXISTS (SELECT 1 FROM codigos_barras cb2 WHERE cb2.producto_id=p.id AND cb2.codigo LIKE ?)
      )
      ORDER BY p.nombre LIMIT 12
    `, [`%${val}%`, `${val}%`]);

    if (!results.length) { dd.classList.remove('open'); return; }
    _scanDdHighlighted = -1;
    dd.innerHTML = results.map((r, i) =>
      `<div class="cmp-dd-item" data-i="${i}" data-id="${r.id}" data-nombre="${esc(r.nombre)}"
        data-costo="${r.costo}" data-uc="${esc(r.unidad_compra || 'Unidad')}"
        data-udspaq="${r.unidades_por_paquete_compra || 1}"
        data-barcode="${esc(r.barcode || '')}"
      >${esc(r.nombre)}${r.barcode ? ` <small style="color:var(--color-text-secondary)">${esc(r.barcode)}</small>` : ''}</div>`
    ).join('');
    dd.classList.add('open');

    dd.querySelectorAll('.cmp-dd-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        _addItemFromEl(el);
        const inp = ge('cmp-scan-input');
        if (inp) inp.value = '';
        _scanDdHighlighted = -1;
        dd.classList.remove('open');
      });
    });
  }

  function _onScanEnter(val) {
    if (!val) return;
    // Exact barcode lookup first
    const byCode = window.SGA_DB.query(`
      SELECT p.id, p.nombre, p.costo,
        p.unidad_compra, p.unidades_por_paquete_compra,
        cb.codigo AS barcode
      FROM productos p
      JOIN codigos_barras cb ON cb.producto_id = p.id
      WHERE cb.codigo = ? AND p.activo = 1
      LIMIT 1
    `, [val])[0];

    if (byCode) {
      _addItemById(byCode.id, byCode.nombre, byCode.costo, byCode.unidad_compra, byCode.unidades_por_paquete_compra, byCode.barcode || val);
    } else {
      // Not found — show new product form
      _showNewProductForm(val);
    }
  }

  function _addItemFromEl(el) {
    _addItemById(
      el.dataset.id, el.dataset.nombre,
      parseFloat(el.dataset.costo) || 0,
      el.dataset.uc || 'Unidad',
      parseFloat(el.dataset.udspaq) || 1,
      el.dataset.barcode || ''
    );
  }

  function _addItemById(productoId, nombre, costo, unidadCompra, udsPaquete, barcode) {
    const existing = state.nueva.items.find(it => it.productoId === productoId);
    if (existing) {
      existing.cantidad = (parseFloat(existing.cantidad) || 0) + 1;
      _renderItemsTable();
      _focusLastCantidad();
      return;
    }
    state.nueva.items.push({
      productoId,
      nombre,
      barcode:      barcode || '',
      unidadCompra: unidadCompra || 'Unidad',
      udsPaquete:   parseFloat(udsPaquete) || 1,
      costoActual:  parseFloat(costo) || 0,
      costoNuevo:   parseFloat(costo) || 0,
      cantidad:     1,
    });
    _renderItemsTable();
    _focusLastCantidad();
  }

  function _focusLastCantidad() {
    // Focus the cantidad input of the last row, then select its content
    const rows = ge('cmp-items-tbody')?.querySelectorAll('tr');
    if (!rows?.length) return;
    const lastRow = rows[rows.length - 1];
    const inp = lastRow?.querySelector('.cmp-cant');
    if (inp) { inp.focus(); inp.select(); }
  }

  function _renderItemsTable() {
    const items  = state.nueva.items;
    const tbody  = ge('cmp-items-tbody');
    const empty  = ge('cmp-items-empty');
    const tbl    = ge('cmp-items-tbl');
    const count  = ge('cmp-items-count');
    const totalEl = ge('cmp-items-total');
    if (!tbody) return;

    if (!items.length) {
      if (empty) empty.style.display = '';
      if (tbl)   tbl.style.display   = 'none';
      if (count) count.textContent   = '0 productos';
      if (totalEl) totalEl.textContent = fmt$(0);
      return;
    }
    if (empty) empty.style.display = 'none';
    if (tbl)   tbl.style.display   = '';

    const totalUnidades = items.reduce((s, it) => s + (parseFloat(it.cantidad) || 0) * (parseFloat(it.udsPaquete) || 1), 0);
    if (count) count.textContent = `${items.length} prod., ${totalUnidades} uds. totales`;
    if (totalEl) totalEl.textContent = fmt$(_calcTotal());

    tbody.innerHTML = items.map((it, idx) => {
      const costoChanged = Math.abs((parseFloat(it.costoNuevo) || 0) - (parseFloat(it.costoActual) || 0)) > 0.001;
      const subtotal = _itemSubtotal(it);
      const udsTotales = (parseFloat(it.cantidad) || 0) * (parseFloat(it.udsPaquete) || 1);
      return `
        <tr data-idx="${idx}">
          <td>
            <div style="font-size:13px;font-weight:600">${esc(it.nombre)}</div>
            ${it.barcode ? `<div style="font-size:11px;color:var(--color-text-secondary)">${esc(it.barcode)}</div>` : ''}
          </td>
          <td>
            <select class="cmp-uc-sel" data-idx="${idx}">
              ${_ucOptions(it.unidadCompra)}
            </select>
          </td>
          <td>
            <input type="number" class="cmp-cant" data-idx="${idx}"
              min="0.001" step="any" value="${it.cantidad}">
          </td>
          <td>
            <input type="number" class="cmp-udspaq" data-idx="${idx}"
              min="1" step="any" value="${it.udsPaquete}">
            <div style="font-size:10px;color:var(--color-text-secondary);margin-top:2px">= ${udsTotales} uds.</div>
          </td>
          <td style="color:var(--color-text-secondary)">${fmt$(it.costoActual)}</td>
          <td>
            <input type="number" class="cmp-costo-nvo${costoChanged ? ' cmp-costo-changed-input' : ''}"
              data-idx="${idx}" min="0" step="any" value="${it.costoNuevo}"
              style="width:80px">
            ${it.unidadCompra !== 'Unidad' ? `
              <div style="font-size:10px;color:var(--color-text-secondary);margin-top:2px">
                Por ${esc(it.unidadCompra)}: ${fmt$((parseFloat(it.costoNuevo)||0)*(parseFloat(it.udsPaquete)||1))}
              </div>` : ''}
          </td>
          <td>${costoChanged ? `<span class="cmp-costo-changed">${fmt$(subtotal)}</span>` : fmt$(subtotal)}</td>
          <td>
            <button class="btn btn-ghost btn-sm cmp-item-remove" data-idx="${idx}"
              style="color:var(--color-danger,#c62828);padding:2px 6px">✕</button>
          </td>
        </tr>
      `;
    }).join('');

    // Attach events on the table
    tbody.querySelectorAll('.cmp-uc-sel').forEach(sel => {
      sel.addEventListener('change', e => {
        state.nueva.items[+e.target.dataset.idx].unidadCompra = e.target.value;
        _renderItemsTable();
      });
    });
    tbody.querySelectorAll('.cmp-cant').forEach(inp => {
      inp.addEventListener('input', e => {
        state.nueva.items[+e.target.dataset.idx].cantidad = parseFloat(e.target.value) || 0;
        _renderItemsTable();
      });
    });
    tbody.querySelectorAll('.cmp-udspaq').forEach(inp => {
      inp.addEventListener('input', e => {
        state.nueva.items[+e.target.dataset.idx].udsPaquete = parseFloat(e.target.value) || 1;
        _renderItemsTable();
      });
    });
    tbody.querySelectorAll('.cmp-costo-nvo').forEach(inp => {
      inp.addEventListener('input', e => {
        state.nueva.items[+e.target.dataset.idx].costoNuevo = parseFloat(e.target.value) || 0;
        _renderItemsTable();
      });
    });
    tbody.querySelectorAll('.cmp-item-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        state.nueva.items.splice(+e.target.dataset.idx, 1);
        _renderItemsTable();
        ge('cmp-new-prod-wrap') && (ge('cmp-new-prod-wrap').style.display = 'none');
      });
    });

    // Also update the right panel total (step 2 POS)
    _updateS2Vuelto();
  }

  function _showNewProductForm(barcode) {
    const wrap = ge('cmp-new-prod-wrap');
    if (!wrap) return;

    const cats   = window.SGA_DB.query(`SELECT id, nombre FROM categorias ORDER BY nombre`);
    const prods  = window.SGA_DB.query(`SELECT id, nombre FROM productos WHERE activo=1 ORDER BY nombre LIMIT 200`);

    wrap.style.display = '';
    wrap.innerHTML = `
      <div class="cmp-new-prod-form">
        <h4>⚠️ Código no encontrado: ${esc(barcode)}<br>Crear nuevo producto</h4>
        <label>Nombre <span style="color:#c62828">*</span></label>
        <input type="text" id="np-nombre" placeholder="Nombre del producto">
        <label>Categoría</label>
        <select id="np-categoria">
          <option value="">-- Sin categoría --</option>
          ${cats.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
        </select>
        <label>¿Cómo lo compro?</label>
        <select id="np-uc">${_ucOptions('Unidad')}</select>
        <div id="np-udspaq-wrap">
          <label>¿Cuántas unidades por paquete?</label>
          <input type="number" id="np-udspaq" value="1" min="1" step="any">
        </div>
        <label>¿Cómo lo vendo?</label>
        <select id="np-uv">${_unidadVentaOptions('Unidad')}</select>
        <label>Costo nuevo <span style="color:#c62828">*</span></label>
        <input type="number" id="np-costo" value="0" min="0" step="any">
        <label>Precio de venta <span style="color:#c62828">*</span></label>
        <input type="number" id="np-precio" value="0" min="0" step="any">
        <div style="margin-top:8px;display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" id="np-crear">Crear y agregar</button>
          <button class="btn btn-ghost btn-sm" id="np-cancelar">Cancelar</button>
        </div>
      </div>
    `;

    // Show/hide udsPaq based on unidad
    ge('np-uc').addEventListener('change', () => {
      const uc = ge('np-uc').value;
      ge('np-udspaq-wrap').style.display = (uc === 'Unidad' || uc === 'Kg' || uc === 'Lt') ? 'none' : '';
    });
    ge('np-uc').dispatchEvent(new Event('change'));

    ge('np-crear').addEventListener('click', () => {
      const nombre = ge('np-nombre').value.trim();
      if (!nombre) { window.SGA_Utils.showNotification('Ingresá el nombre', 'error'); return; }
      const precio = parseFloat(ge('np-precio').value) || 0;
      if (!precio)  { window.SGA_Utils.showNotification('Ingresá el precio de venta', 'error'); return; }
      const costo  = parseFloat(ge('np-costo').value)  || 0;
      const uc     = ge('np-uc').value;
      const udsPaq = parseFloat(ge('np-udspaq').value) || 1;
      const uv     = ge('np-uv').value;
      const catId  = ge('np-categoria').value || null;

      // Create product in DB
      const pid = uuid();
      const ts  = now();
      const costoP = costo * udsPaq;
      try {
        window.SGA_DB.run(`
          INSERT INTO productos
            (id,nombre,costo,costo_paquete,precio,unidad_compra,unidades_por_paquete_compra,unidad_venta,categoria_id,activo,sync_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,1,'pending',?)
        `, [pid, nombre, costo, costoP, precio, uc, udsPaq, uv, catId, ts]);

        if (barcode) {
          window.SGA_DB.run(`
            INSERT INTO codigos_barras (id,producto_id,codigo,es_principal) VALUES (?,?,?,1)
          `, [uuid(), pid, barcode]);
        }

        _addItemById(pid, nombre, costo, uc, udsPaq, barcode);
        wrap.style.display = 'none';
        window.SGA_Utils.showNotification(`Producto "${nombre}" creado y agregado`, 'success');
      } catch (e) {
        window.SGA_Utils.showNotification('Error al crear: ' + e.message, 'error');
      }
    });

    ge('np-cancelar').addEventListener('click', () => { wrap.style.display = 'none'; });
  }

  // ── STEP 3 — REVISIÓN ─────────────────────────────────────────────────────

  function renderStep3(body, footer) {
    const n     = state.nueva;
    const items = n.items;
    const total = _calcTotal();

    const prov    = window.SGA_DB.query(`SELECT razon_social FROM proveedores WHERE id=?`, [n.proveedorId])[0];
    const provNom = prov?.razon_social || n.proveedorNombre;

    // Caja info
    let cajaInfo = '';
    const sesion = window.SGA_DB.query(
      `SELECT id, saldo_inicial FROM sesiones_caja WHERE sucursal_id=? AND estado='abierta' LIMIT 1`,
      [state.user.sucursal_id]
    )[0];

    if (n.condicionPago === 'efectivo') {
      cajaInfo = `<div class="cmp-pago-info cmp-pago-efectivo">
        💵 Se deducirán <strong>${fmt$(total)}</strong> de la caja actual.
        ${sesion ? '' : '<br><strong>⚠️ No hay una sesión de caja abierta.</strong>'}
      </div>`;
    } else {
      // deuda actual con proveedor
      const deudaRow = window.SGA_DB.query(
        `SELECT COALESCE(SUM(CASE WHEN tipo='deuda' THEN monto ELSE -monto END),0) AS saldo FROM cuenta_proveedor WHERE proveedor_id=?`,
        [n.proveedorId]
      )[0];
      const deudaAct = deudaRow?.saldo || 0;
      cajaInfo = `<div class="cmp-pago-info cmp-pago-pendiente">
        ⏳ Se registrará deuda de <strong>${fmt$(total)}</strong> con ${esc(provNom)}.
        ${deudaAct > 0 ? `<br>Deuda actual: ${fmt$(deudaAct)}` : ''}
      </div>`;
    }

    const totalUds = items.reduce((s,it) => s + (parseFloat(it.cantidad)||0)*(parseFloat(it.udsPaquete)||1), 0);

    body.innerHTML = `
      <h4 style="margin-top:0">Revisión de la compra</h4>
      <table class="cmp-review-table">
        <thead>
          <tr>
            <th>Producto</th>
            <th>Cant.</th>
            <th>Unidad</th>
            <th>Costo</th>
            <th>Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(it => `
            <tr>
              <td>${esc(it.nombre)}</td>
              <td>${it.cantidad}</td>
              <td>${esc(it.unidadCompra)}</td>
              <td>${fmt$(parseFloat(it.costoNuevo)||parseFloat(it.costoActual)||0)}</td>
              <td>${fmt$(_itemSubtotal(it))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="cmp-totals-box">
        <div class="cmp-totals-row"><span>Subtotal</span><span>${fmt$(total)}</span></div>
        <div class="cmp-totals-row grand"><span>Total</span><span>${fmt$(total)}</span></div>
      </div>
      <div style="background:var(--color-surface,#fff);border:1px solid var(--color-border);border-radius:8px;padding:16px;margin-bottom:16px;font-size:14px">
        <div class="cmp-totals-row"><span>Proveedor:</span><span>${esc(provNom)}</span></div>
        ${n.numeroFactura ? `<div class="cmp-totals-row"><span>Factura:</span><span>${esc(n.numeroFactura)}</span></div>` : ''}
        <div class="cmp-totals-row"><span>Fecha:</span><span>${fmtFecha(n.fecha)}</span></div>
        <div class="cmp-totals-row"><span>Pago:</span><span>${n.condicionPago === 'efectivo' ? 'Efectivo' : 'Pendiente'}</span></div>
        <div class="cmp-totals-row"><span>Items:</span><span>${items.length} prod., ${totalUds} uds. totales</span></div>
      </div>
      ${cajaInfo}
    `;

    footer.innerHTML = `
      <button class="btn btn-secondary" id="cmp-back3">← Volver a editar</button>
      <button class="btn btn-primary" id="cmp-confirmar">✓ Confirmar compra</button>
    `;

    ge('cmp-back3').addEventListener('click', () => { n.step = 2; renderStep(); });

    ge('cmp-confirmar').addEventListener('click', async () => {
      ge('cmp-confirmar').disabled = true;
      ge('cmp-confirmar').textContent = 'Guardando...';

      // Save draft first
      const total2 = _calcTotal();
      const crearRes = _crear({
        sucursalId:       state.user.sucursal_id,
        proveedorId:      n.proveedorId,
        usuarioId:        state.user.id,
        fecha:            n.fecha,
        numeroFactura:    n.numeroFactura,
        total:            total2,
        condicionPago:    n.condicionPago,
        vinculadaOrdenId: n.vinculadaOrdenId,
        items:            n.items,
      });

      if (!crearRes.success) {
        window.SGA_Utils.showNotification('Error al guardar: ' + crearRes.error, 'error');
        ge('cmp-confirmar').disabled = false;
        ge('cmp-confirmar').textContent = '✓ Confirmar compra';
        return;
      }

      n.compraId = crearRes.id;
      const res  = _confirmar(crearRes.id);

      if (!res.success) {
        window.SGA_Utils.showNotification('Error al confirmar: ' + res.error, 'error');
        ge('cmp-confirmar').disabled = false;
        ge('cmp-confirmar').textContent = '✓ Confirmar compra';
        return;
      }

      state.confirmarResult = res;
      state.priceAdjustments = res.cambiosCosto.map(c => ({
        ...c,
        precioNuevo: '',
        incluir:     true,
        aplicarFamilia: false,
      }));

      if (res.cambiosCosto.length > 0) {
        n.step = 4;
      } else {
        n.step = 5;
      }
      renderStep();
    });
  }

  // ── STEP 4 — AJUSTE DE PRECIOS ────────────────────────────────────────────

  function renderStep4(body, footer) {
    const changes = state.confirmarResult?.cambiosCosto || [];
    const hasFamily = changes.some(c => c.productaMadreId);

    body.innerHTML = `
      <h4 style="margin-top:0">💰 Cambios de costo detectados</h4>
      <p style="color:var(--color-text-secondary);font-size:14px">
        Estos productos tuvieron cambios de costo. Podés actualizar sus precios de venta ahora.
      </p>
      ${hasFamily ? `
        <div class="cmp-family-banner">
          <span>⚠️ Hay productos con familia. ¿Aplicar ajuste a toda la familia?</span>
          <div>
            <label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" id="cmp-aplicar-familia">
              Aplicar a toda la familia
            </label>
          </div>
        </div>
      ` : ''}
      <table class="cmp-price-table">
        <thead>
          <tr>
            <th>Producto</th>
            <th>Costo ant.</th>
            <th>Costo nuevo</th>
            <th>Var%</th>
            <th>Precio ant.</th>
            <th>Precio nuevo</th>
            <th>Proporcional</th>
            <th>Incluir</th>
          </tr>
        </thead>
        <tbody id="cmp-price-tbody"></tbody>
      </table>
    `;

    footer.innerHTML = `
      <button class="btn btn-ghost" id="cmp-skip-precio">Omitir ajuste de precios</button>
      <button class="btn btn-primary" id="cmp-apply-precio">Aplicar cambios de precio →</button>
    `;

    _renderPriceTable();

    ge('cmp-skip-precio').addEventListener('click', () => { state.nueva.step = 5; renderStep(); });

    ge('cmp-apply-precio').addEventListener('click', () => {
      const aplicarFam = ge('cmp-aplicar-familia')?.checked || false;
      const ts = now();
      try {
        window.SGA_DB.beginBatch();
        for (let i = 0; i < state.priceAdjustments.length; i++) {
          const adj = state.priceAdjustments[i];
          if (!adj.incluir) continue;
          const pNvo = parseFloat(adj.precioNuevo);
          if (!pNvo || pNvo <= 0) continue;
          window.SGA_DB.run(`UPDATE productos SET precio=?, updated_at=? WHERE id=?`, [pNvo, ts, adj.productoId]);
          if (aplicarFam && adj.productaMadreId) {
            // Update siblings
            window.SGA_DB.run(`UPDATE productos SET precio=?, updated_at=? WHERE producto_madre_id=?`, [pNvo, ts, adj.productaMadreId]);
            window.SGA_DB.run(`UPDATE productos SET precio=?, updated_at=? WHERE id=?`, [pNvo, ts, adj.productaMadreId]);
          }
        }
        window.SGA_DB.commitBatch();
        window.SGA_Utils.showNotification('Precios actualizados', 'success');
      } catch (e) {
        window.SGA_DB.rollbackBatch();
        window.SGA_Utils.showNotification('Error: ' + e.message, 'error');
      }
      state.nueva.step = 5;
      renderStep();
    });
  }

  function _renderPriceTable() {
    const tbody = ge('cmp-price-tbody');
    if (!tbody) return;
    tbody.innerHTML = state.priceAdjustments.map((adj, i) => {
      const varPct = adj.costoAnterior > 0
        ? (((adj.costoNuevo - adj.costoAnterior) / adj.costoAnterior) * 100).toFixed(1)
        : '—';
      const varCls = parseFloat(varPct) > 0 ? 'cmp-var-pos' : 'cmp-var-neg';
      return `
        <tr>
          <td>${esc(adj.nombre)}</td>
          <td>${fmt$(adj.costoAnterior)}</td>
          <td><strong>${fmt$(adj.costoNuevo)}</strong></td>
          <td class="${varCls}">${varPct !== '—' ? varPct + '%' : '—'}</td>
          <td>${fmt$(adj.precioAnterior)}</td>
          <td>
            <input type="number" class="cmp-precio-nvo" data-adj="${i}"
              min="0" step="any" value="${adj.precioNuevo}"
              placeholder="Nuevo precio">
          </td>
          <td>
            <button class="btn btn-ghost btn-sm cmp-calc-prop" data-adj="${i}"
              style="font-size:11px">Calcular</button>
          </td>
          <td>
            <input type="checkbox" class="cmp-incluir" data-adj="${i}" ${adj.incluir ? 'checked' : ''}>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.cmp-precio-nvo').forEach(inp => {
      inp.addEventListener('input', e => {
        state.priceAdjustments[+e.target.dataset.adj].precioNuevo = e.target.value;
      });
    });
    tbody.querySelectorAll('.cmp-calc-prop').forEach(btn => {
      btn.addEventListener('click', e => {
        const adj = state.priceAdjustments[+e.target.dataset.adj];
        if (!adj.costoAnterior) return;
        const varFactor = adj.costoNuevo / adj.costoAnterior;
        const pNvo = (adj.precioAnterior * varFactor).toFixed(2);
        adj.precioNuevo = pNvo;
        _renderPriceTable();
      });
    });
    tbody.querySelectorAll('.cmp-incluir').forEach(chk => {
      chk.addEventListener('change', e => {
        state.priceAdjustments[+e.target.dataset.adj].incluir = e.target.checked;
      });
    });
  }

  // ── STEP 5 — RESUMEN ──────────────────────────────────────────────────────

  function renderStep5(body, footer) {
    const n      = state.nueva;
    const res    = state.confirmarResult;
    const compra = _getById(n.compraId);
    const total  = compra?.total || res?.total || 0;

    const prov   = window.SGA_DB.query(`SELECT razon_social FROM proveedores WHERE id=?`, [n.proveedorId])[0];
    const provNom = prov?.razon_social || n.proveedorNombre;

    const nuevos   = res?.productosNuevos || [];
    const cambios  = res?.cambiosCosto    || [];

    body.innerHTML = `
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px">✅</div>
        <h3 style="margin:8px 0 4px">Compra registrada</h3>
        <div style="color:var(--color-text-secondary);font-size:14px">Los cambios ya fueron aplicados al stock.</div>
      </div>

      ${nuevos.length ? `
        <div class="cmp-resumen-section">
          <h4>🆕 Productos nuevos (${nuevos.length})</h4>
          ${nuevos.map(p => `<div class="cmp-resumen-row"><span>${esc(p.nombre)}</span><span>${fmt$(p.precio)}</span></div>`).join('')}
        </div>
      ` : ''}

      ${cambios.length ? `
        <div class="cmp-resumen-section">
          <h4>💰 Cambios de costo (${cambios.length})</h4>
          ${cambios.map(c => {
            const varPct = c.costoAnterior > 0 ? (((c.costoNuevo - c.costoAnterior)/c.costoAnterior)*100).toFixed(1) : '—';
            return `<div class="cmp-resumen-row">
              <span>${esc(c.nombre)}</span>
              <span style="font-size:12px">${fmt$(c.costoAnterior)} → ${fmt$(c.costoNuevo)} (${varPct}%)</span>
            </div>`;
          }).join('')}
        </div>
      ` : ''}

      <div class="cmp-resumen-section">
        <h4>📋 Resumen general</h4>
        <div class="cmp-resumen-row"><span>Proveedor</span><span>${esc(provNom)}</span></div>
        ${n.numeroFactura ? `<div class="cmp-resumen-row"><span>Factura</span><span>${esc(n.numeroFactura)}</span></div>` : ''}
        <div class="cmp-resumen-row"><span>Fecha</span><span>${fmtFecha(n.fecha)}</span></div>
        <div class="cmp-resumen-row"><span>Total</span><span><strong>${fmt$(total)}</strong></span></div>
        <div class="cmp-resumen-row"><span>Pago</span><span>${n.condicionPago === 'efectivo' ? 'Efectivo' : 'Pendiente'}</span></div>
        <div class="cmp-resumen-row"><span>Items</span><span>${n.items.length} productos</span></div>
      </div>

      <div class="cmp-share-buttons">
        <button class="btn btn-secondary" id="cmp-share-wapp">💬 Compartir WhatsApp</button>
        <button class="btn btn-secondary" id="cmp-share-email">📧 Enviar por email</button>
      </div>
    `;

    footer.innerHTML = `
      <div></div>
      <button class="btn btn-primary" id="cmp-finalizar">✓ Finalizar</button>
    `;

    ge('cmp-share-wapp').addEventListener('click', () => {
      const texto = _getResumenParaCompartir(n.compraId);
      window.open('https://wa.me/?text=' + encodeURIComponent(texto));
    });

    ge('cmp-share-email').addEventListener('click', () => {
      const texto = _getResumenParaCompartir(n.compraId);
      const asunto = `Compra registrada — ${provNom} — ${fmtFecha(n.fecha)}`;
      window.location.href = `mailto:?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(texto)}`;
    });

    ge('cmp-finalizar').addEventListener('click', () => {
      ge('cmp-nueva-overlay').style.display = 'none';
      state.view = 'lista';
      state.nueva = null;
      renderLista();
    });
  }

  // ── NAVIGATION GUARD ──────────────────────────────────────────────────────

  function _showNavGuard(onConfirm) {
    state.pendingNavAway = onConfirm;
    ge('cmp-nav-guard').classList.add('open');
  }

  function _hideNavGuard() {
    ge('cmp-nav-guard').classList.remove('open');
    state.pendingNavAway = null;
  }

  // ── SEARCHABLE DROPDOWN HELPER ─────────────────────────────────────────────

  function _attachSearch(inputId, hiddenId, dropdownId, items, valKey, labelKey, onSelect) {
    const inp = ge(inputId);
    const hid = ge(hiddenId);
    const dd  = ge(dropdownId);
    if (!inp || !dd) return;

    let highlighted = -1;

    function show(filtered) {
      if (!filtered.length) { dd.classList.remove('open'); return; }
      dd.innerHTML = filtered.map((item, i) =>
        `<div class="cmp-dd-item" data-val="${esc(item[valKey])}" data-label="${esc(item[labelKey])}"
          data-i="${i}">${esc(item[labelKey])}</div>`
      ).join('');
      dd.classList.add('open');
      highlighted = -1;
      dd.querySelectorAll('.cmp-dd-item').forEach(el => {
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          select(filtered[+el.dataset.i]);
        });
      });
    }

    function select(item) {
      inp.value = item[labelKey];
      hid.value = item[valKey];
      dd.classList.remove('open');
      if (onSelect) onSelect(item);
    }

    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase();
      if (!q) { dd.classList.remove('open'); hid.value = ''; return; }
      const filtered = items.filter(it =>
        String(it[labelKey]).toLowerCase().includes(q)
      ).slice(0, 15);
      show(filtered);
    });

    inp.addEventListener('keydown', e => {
      const rows = dd.querySelectorAll('.cmp-dd-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlighted = Math.min(highlighted + 1, rows.length - 1);
        rows.forEach((r,i) => r.classList.toggle('highlighted', i === highlighted));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlighted = Math.max(highlighted - 1, -1);
        rows.forEach((r,i) => r.classList.toggle('highlighted', i === highlighted));
      } else if (e.key === 'Enter' && highlighted >= 0) {
        e.preventDefault();
        rows[highlighted]?.dispatchEvent(new Event('mousedown'));
      } else if (e.key === 'Escape') {
        dd.classList.remove('open');
      }
    });

    inp.addEventListener('focus', () => {
      if (inp.value.length >= 1) inp.dispatchEvent(new Event('input'));
    });

    document.addEventListener('click', e => {
      if (!inp.contains(e.target) && !dd.contains(e.target)) dd.classList.remove('open');
    });
  }

  // ── PAUSE / RESUME ─────────────────────────────────────────────────────────

  function _pausarCompra() {
    const n = state.nueva;
    if (!n || !n.items.length) {
      window.SGA_Utils.showNotification('No hay productos cargados para pausar', 'error');
      return;
    }
    const id  = uuid();
    const ts  = now();
    try {
      window.SGA_DB.run(`
        INSERT INTO compras_pausadas
          (id, sucursal_id, usuario_id, snapshot, proveedor_nombre, num_items, total_estimado, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `, [id, state.user.sucursal_id, state.user.id,
          JSON.stringify(n),
          n.proveedorNombre, n.items.length, _calcTotal(),
          ts, ts]);
      _hideNavGuard();
      ge('cmp-nueva-overlay').style.display = 'none';
      document.removeEventListener('keydown', _docKeydownStep2);
      state.view = 'lista';
      state.nueva = null;
      renderLista();
      window.SGA_Utils.showNotification('Compra pausada. Podés retomar desde la lista.', 'success');
    } catch(e) {
      window.SGA_Utils.showNotification('Error al pausar: ' + e.message, 'error');
    }
  }

  function _retomarCompra(pausadaId) {
    const row = window.SGA_DB.query(`SELECT * FROM compras_pausadas WHERE id=?`, [pausadaId])[0];
    if (!row) return;
    try {
      const snapshot = JSON.parse(row.snapshot);
      state.nueva = { ...snapshot, step: 2 };
      state.view  = 'nueva';
      ge('cmp-nueva-overlay').style.display = 'flex';
      renderStep();
      window.SGA_DB.run(`DELETE FROM compras_pausadas WHERE id=?`, [pausadaId]);
      window.SGA_Utils.showNotification('Compra retomada', 'success');
    } catch(e) {
      window.SGA_Utils.showNotification('Error al retomar: ' + e.message, 'error');
    }
  }

  // ── DETALLE COMPRA ─────────────────────────────────────────────────────────

  function renderDetalleCompra(compraId) {
    const compra = _getById(compraId);
    if (!compra) { window.SGA_Utils.showNotification('Compra no encontrada', 'error'); return; }

    const overlay = ge('cmp-detalle-overlay');
    const body    = ge('cmp-detalle-body');
    if (!overlay || !body) return;

    const estado = compra.estado || 'borrador';

    body.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px">
        <span class="cmp-badge cmp-badge-${estado}">${ESTADO_LABEL[estado] || estado}</span>
        <span style="font-size:13px;color:var(--color-text-secondary)">
          ${fmtFecha(compra.fecha)} ·
          ${esc(compra.proveedor_nombre || '—')}
          ${compra.numero_factura ? ' · Fact. ' + esc(compra.numero_factura) : ''}
        </span>
        <span style="font-size:13px;color:var(--color-text-secondary)">
          ${compra.condicion_pago === 'pendiente' ? '⏳ Pago pendiente' : '✓ ' + (compra.condicion_pago || 'efectivo')}
        </span>
      </div>

      <table class="cmp-review-table" style="margin-bottom:16px">
        <thead>
          <tr>
            <th>Producto</th>
            <th>Cant.</th>
            <th>Unidad</th>
            <th>Costo unit.</th>
            <th>Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${(compra.items || []).map(it => `
            <tr>
              <td>${esc(it.producto_nombre || '—')}</td>
              <td>${it.cantidad}</td>
              <td>${esc(it.unidad_compra || 'Unidad')}</td>
              <td>${fmt$(it.costo_unitario)}</td>
              <td>${fmt$((parseFloat(it.cantidad)||0) * (parseFloat(it.unidades_por_paquete)||1) * (parseFloat(it.costo_unitario)||0))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="cmp-totals-box">
        <div class="cmp-totals-row grand">
          <span>Total</span><span>${fmt$(compra.total)}</span>
        </div>
      </div>

      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        ${estado === 'borrador'
          ? `<button class="btn btn-primary" id="cmp-detalle-confirmar" data-id="${esc(compraId)}">✓ Confirmar compra</button>`
          : ''}
        ${estado === 'confirmada' && compra.condicion_pago === 'pendiente'
          ? `<button class="btn btn-secondary" id="cmp-detalle-pagar" data-id="${esc(compraId)}">💳 Registrar pago</button>`
          : ''}
      </div>
    `;

    overlay.style.display = 'flex';

    ge('cmp-detalle-confirmar')?.addEventListener('click', () => {
      const res = _confirmar(compraId);
      if (res.success) {
        window.SGA_Utils.showNotification('Compra confirmada', 'success');
        overlay.style.display = 'none';
        renderLista();
      } else {
        window.SGA_Utils.showNotification('Error: ' + res.error, 'error');
      }
    });
  }

  // ── ATTACH EVENTS ─────────────────────────────────────────────────────────

  function attachEvents() {
    document.addEventListener('click', e => {
      // Open nueva compra
      if (e.target.matches('#cmp-nueva-btn, #cmp-empty-nueva-btn')) {
        openNuevaCompra();
      }
      // Close nueva compra
      if (e.target.matches('#cmp-nueva-close')) {
        closeNuevaCompra();
      }
      // Navigation guard — 3 options
      if (e.target.matches('#cmp-guard-stay')) {
        _hideNavGuard();
      }
      if (e.target.matches('#cmp-guard-leave')) {
        // Descartar — force close without saving
        _hideNavGuard();
        document.removeEventListener('keydown', _docKeydownStep2);
        ge('cmp-nueva-overlay').style.display = 'none';
        state.view = 'lista';
        state.nueva = null;
        renderLista();
      }
      if (e.target.matches('#cmp-guard-pausar')) {
        _pausarCompra();
      }
      // Ver detalle
      if (e.target.dataset.ver) {
        renderDetalleCompra(e.target.dataset.ver);
      }
      // Cerrar detalle
      if (e.target.matches('#cmp-detalle-close')) {
        ge('cmp-detalle-overlay').style.display = 'none';
      }
      // Retomar pausada
      if (e.target.dataset.retomar) {
        _retomarCompra(e.target.dataset.retomar);
      }
      // Confirmar desde lista
      if (e.target.dataset.confirmar) {
        const id = e.target.dataset.confirmar;
        if (confirm('¿Confirmar esta compra? Se actualizará el stock y se registrará el pago.')) {
          state.user = state.user || window.SGA_Auth.getCurrentUser();
          const res = _confirmar(id);
          if (res.success) {
            window.SGA_Utils.showNotification('Compra confirmada', 'success');
            renderLista();
          } else {
            window.SGA_Utils.showNotification('Error: ' + res.error, 'error');
          }
        }
      }
    });
  }

  // ── INIT ──────────────────────────────────────────────────────────────────

  function init(params) {
    _migrate();
    state.user = window.SGA_Auth.getCurrentUser();
    if (!state.user) return;
    attachEvents();
    renderLista();
  }

  return { init };
})();

export default Compras;
