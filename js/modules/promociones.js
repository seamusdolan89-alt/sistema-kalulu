/**
 * promociones.js — Módulo de Promociones y Combos
 */

export default {
  init() {
    'use strict';

    const ge = id => document.getElementById(id);
    const fmt = v => window.SGA_Utils.formatCurrency(v);
    const uuid = () => window.SGA_Utils.generateUUID();
    const now  = () => window.SGA_Utils.formatISODate(new Date());

    // ── State ─────────────────────────────────────────────────────────
    let comboItems     = [];   // { productoId, nombre, precio, cantidad }
    let tipoCombo      = 'fijo';     // 'fijo' | 'flexible'
    let tipoDescuento  = 'porcentaje'; // 'porcentaje' | 'monto_fijo' | 'precio_combo'
    let searchHlIdx    = -1;
    let lastSearchResults = [];
    let searchTimeout  = null;
    let editingId      = null;   // null = create, string = edit (delete+recreate)

    // ── Data layer ─────────────────────────────────────────────────────
    const getPromociones = () => window.SGA_DB.query(`
      SELECT p.*,
        (SELECT GROUP_CONCAT(pr.nombre || '|' || pi.cantidad_requerida, ';;')
         FROM promocion_items pi
         JOIN productos pr ON pr.id = pi.producto_id
         WHERE pi.promocion_id = p.id
        ) AS items_summary
      FROM promociones p
      ORDER BY p.activa DESC, p.nombre ASC
    `);

    const getPromoItems = (promoId) => window.SGA_DB.query(
      `SELECT pi.*, p.nombre, p.precio_venta
       FROM promocion_items pi
       JOIN productos p ON p.id = pi.producto_id
       WHERE pi.promocion_id = ?`,
      [promoId]
    );

    const searchProductos = (q) => {
      const like = `%${q}%`;
      return window.SGA_DB.query(`
        SELECT DISTINCT p.id, p.nombre, p.precio_venta,
          (SELECT codigo FROM codigos_barras WHERE producto_id = p.id AND es_principal = 1 LIMIT 1) as codigo
        FROM productos p
        LEFT JOIN codigos_barras cb ON cb.producto_id = p.id
        WHERE p.activo = 1 AND (p.nombre LIKE ? OR cb.codigo LIKE ?)
        ORDER BY p.nombre LIMIT 12
      `, [like, like]);
    };

    const savePromocion = (data, items) => {
      const id = data.id || uuid();
      const ts = now();
      window.SGA_DB.run(`
        INSERT OR REPLACE INTO promociones
          (id, nombre, tipo, descripcion, fecha_desde, fecha_hasta, activa,
           aplica_a, valor_descuento, tipo_descuento,
           precio_combo, stock_maximo, stock_vendido,
           flexible, solo_clientes_registrados, cantidad_total_requerida,
           sync_status, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        id,
        data.nombre,
        'combo',
        data.descripcion || '',
        data.fecha_desde || null,
        data.fecha_hasta || null,
        1,
        data.aplica_a || 'todos',
        data.valor_descuento || 0,
        data.tipo_descuento === 'precio_combo' ? 'monto_fijo' : (data.tipo_descuento || 'porcentaje'),
        data.precio_combo || 0,
        data.stock_maximo || 0,
        0,
        data.flexible ? 1 : 0,
        data.solo_clientes_registrados ? 1 : 0,
        data.cantidad_total_requerida || 1,
        'pending',
        ts,
      ]);

      window.SGA_DB.run(`DELETE FROM promocion_items WHERE promocion_id = ?`, [id]);
      for (const item of items) {
        window.SGA_DB.run(
          `INSERT INTO promocion_items (promocion_id, producto_id, cantidad_requerida) VALUES (?,?,?)`,
          [id, item.productoId, item.cantidad || 1]
        );
      }
      return id;
    };

    const toggleActiva = (id, activa) => {
      window.SGA_DB.run(
        `UPDATE promociones SET activa = ?, sync_status = 'pending', updated_at = ? WHERE id = ?`,
        [activa ? 1 : 0, now(), id]
      );
    };

    const deletePromocion = (id) => {
      window.SGA_DB.run(`DELETE FROM promocion_items WHERE promocion_id = ?`, [id]);
      window.SGA_DB.run(`DELETE FROM promociones WHERE id = ?`, [id]);
    };

    // ── Detail panel ──────────────────────────────────────────────────
    const ensureDetailPanel = () => {
      if (document.getElementById('promo-detail-overlay')) return;
      const styles = document.createElement('style');
      styles.id = 'promo-detail-styles';
      styles.textContent = `
        .pd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:flex;align-items:flex-start;justify-content:flex-end}
        .pd-overlay.hidden{display:none}
        .pd-panel{width:520px;max-width:100vw;height:100vh;background:#fff;display:flex;flex-direction:column;box-shadow:-4px 0 32px rgba(0,0,0,.18);overflow:hidden}
        .pd-header{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #f0f0f0;flex-shrink:0}
        .pd-header h3{margin:0;font-size:1em;font-weight:700;color:#222;flex:1}
        .pd-body{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px}
        .pd-sec-title{font-size:.72em;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
        .pd-row{display:flex;justify-content:space-between;align-items:center;font-size:.88em;padding:4px 0;border-bottom:1px solid #fafafa}
        .pd-row span:first-child{color:#888}
        .pd-row span:last-child{font-weight:600;color:#333}
        .pd-pills{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
        .pd-pill{background:#f0f4ff;color:#667eea;font-size:.78em;padding:2px 9px;border-radius:10px;font-weight:600}
        .pd-stat-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
        .pd-stat{background:#f8f9fa;border-radius:8px;padding:12px;text-align:center}
        .pd-stat-val{font-size:1.4em;font-weight:800;color:#333}
        .pd-stat-lbl{font-size:.72em;color:#999;margin-top:2px}
        .pd-progress{height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin-top:6px}
        .pd-progress-bar{height:100%;background:#667eea;border-radius:4px;transition:width .3s}
        .pd-progress-bar.warn{background:#f59e0b}
        .pd-progress-bar.full{background:#ef4444}
        .pd-hist-table{width:100%;border-collapse:collapse;font-size:.84em}
        .pd-hist-table th{padding:6px 8px;text-align:left;color:#999;font-weight:600;font-size:.8em;border-bottom:1px solid #f0f0f0;text-transform:uppercase}
        .pd-hist-table td{padding:7px 8px;border-bottom:1px solid #fafafa;color:#444}
        .pd-hist-table tr:last-child td{border-bottom:none}
        .pd-edit-form{background:#f8f9fa;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}
        .pd-form-row{display:flex;gap:10px;align-items:flex-end}
        .pd-form-group{display:flex;flex-direction:column;gap:4px;flex:1}
        .pd-form-label{font-size:.75em;font-weight:700;color:#666;text-transform:uppercase}
        .pd-form-input{padding:7px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:.88em;outline:none}
        .pd-form-input:focus{border-color:#667eea}
        .pd-btn-save{padding:7px 16px;background:#667eea;color:#fff;border:none;border-radius:6px;font-size:.85em;font-weight:600;cursor:pointer;white-space:nowrap}
        .pd-btn-save:hover{background:#5a6fd6}
        .pd-empty-hist{text-align:center;padding:20px;color:#ccc;font-size:.85em}
      `;
      document.head.appendChild(styles);

      const overlay = document.createElement('div');
      overlay.id = 'promo-detail-overlay';
      overlay.className = 'pd-overlay hidden';
      overlay.innerHTML = `
        <div class="pd-panel">
          <div class="pd-header">
            <h3 id="pd-title">Detalle de promoción</h3>
            <button id="pd-close" style="background:none;border:none;font-size:1.3em;color:#bbb;cursor:pointer;padding:2px 6px;border-radius:4px">✕</button>
          </div>
          <div class="pd-body" id="pd-body"></div>
        </div>`;
      document.body.appendChild(overlay);

      document.getElementById('pd-close').addEventListener('click', closeDetailPanel);
      overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeDetailPanel(); });
    };

    const closeDetailPanel = () => {
      const el = document.getElementById('promo-detail-overlay');
      if (el) el.classList.add('hidden');
    };

    const showDetailPanel = (promoId) => {
      ensureDetailPanel();
      const overlay = document.getElementById('promo-detail-overlay');
      const body    = document.getElementById('pd-body');
      const titleEl = document.getElementById('pd-title');
      if (!overlay || !body) return;

      const rows = window.SGA_DB.query(
        `SELECT p.* FROM promociones p WHERE p.id = ?`, [promoId]
      );
      if (!rows.length) return;
      const p = rows[0];

      const items = window.SGA_DB.query(
        `SELECT pi.*, pr.nombre, pr.precio_venta FROM promocion_items pi
         JOIN productos pr ON pr.id = pi.producto_id WHERE pi.promocion_id = ?`, [promoId]
      );

      const historial = window.SGA_DB.query(
        `SELECT vp.*, v.fecha, v.total AS venta_total,
           COALESCE(c.nombre || ' ' || COALESCE(c.apellido,''), 'Consumidor final') AS cliente
         FROM venta_promociones vp
         JOIN ventas v ON v.id = vp.venta_id
         LEFT JOIN clientes c ON c.id = v.cliente_id
         WHERE vp.promocion_id = ?
         ORDER BY v.fecha DESC LIMIT 50`, [promoId]
      );

      titleEl.textContent = p.nombre;

      // Discount description
      let descuentoDesc = '—';
      if ((p.precio_combo || 0) > 0) descuentoDesc = `Precio combo: ${fmt(p.precio_combo)}`;
      else if (p.tipo_descuento === 'porcentaje') {
        descuentoDesc = `${p.valor_descuento}% ${p.aplica_a === 'item_mas_barato' ? 'sobre el más barato' : 'sobre el total'}`;
      } else if (p.tipo_descuento === 'monto_fijo') descuentoDesc = `${fmt(p.valor_descuento)} fijo`;

      // Stats
      const totalCombos = historial.reduce((s, h) => s + (h.veces || 1), 0);
      const totalDesc   = historial.reduce((s, h) => s + (h.descuento_aplicado || 0), 0);
      const stockPct    = p.stock_maximo > 0 ? Math.min(100, ((p.stock_vendido || 0) / p.stock_maximo) * 100) : 0;
      const barCls      = stockPct >= 100 ? 'full' : stockPct >= 80 ? 'warn' : '';

      // Pills
      const pillsHtml = items.map(i => {
        const qty = p.flexible ? '' : ` ×${i.cantidad_requerida}`;
        return `<span class="pd-pill">${i.nombre}${qty}</span>`;
      }).join('');

      // History table
      const histHtml = historial.length
        ? `<table class="pd-hist-table">
            <thead><tr><th>Fecha</th><th>Cliente</th><th>Combos</th><th>Descuento</th></tr></thead>
            <tbody>${historial.map(h => `
              <tr>
                <td>${new Date(h.fecha).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}</td>
                <td>${h.cliente}</td>
                <td style="text-align:center">${h.veces}</td>
                <td style="text-align:right;color:#166534;font-weight:600">${fmt(h.descuento_aplicado)}</td>
              </tr>`).join('')}
            </tbody>
           </table>`
        : `<div class="pd-empty-hist">Ninguna venta con esta promoción todavía</div>`;

      body.innerHTML = `
        <!-- Config -->
        <div>
          <div class="pd-sec-title">Configuración</div>
          <div class="pd-row"><span>Tipo</span><span>${p.flexible ? 'Flexible (pool)' : 'Combo fijo'}</span></div>
          <div class="pd-row"><span>Estado</span><span style="color:${p.activa ? '#166534' : '#9e9e9e'}">${p.activa ? '● Activa' : '● Inactiva'}</span></div>
          <div class="pd-row"><span>Descuento</span><span>${descuentoDesc}</span></div>
          ${p.flexible ? `<div class="pd-row"><span>Unidades requeridas</span><span>${p.cantidad_total_requerida}</span></div>` : ''}
          <div class="pd-row"><span>Solo clientes registrados</span><span>${p.solo_clientes_registrados ? 'Sí' : 'No'}</span></div>
          <div class="pd-row"><span>Vigencia</span><span>${p.fecha_desde || '—'} → ${p.fecha_hasta || '—'}</span></div>
          ${pillsHtml ? `<div style="margin-top:8px"><div class="pd-sec-title" style="margin-bottom:4px">Productos</div><div class="pd-pills">${pillsHtml}</div></div>` : ''}
        </div>

        <!-- Stats -->
        <div>
          <div class="pd-sec-title">Estadísticas</div>
          <div class="pd-stat-grid">
            <div class="pd-stat"><div class="pd-stat-val">${p.stock_vendido || 0}</div><div class="pd-stat-lbl">Combos vendidos</div></div>
            <div class="pd-stat"><div class="pd-stat-val">${historial.length}</div><div class="pd-stat-lbl">Ventas distintas</div></div>
            <div class="pd-stat"><div class="pd-stat-val">${fmt(totalDesc)}</div><div class="pd-stat-lbl">Descuento otorgado</div></div>
          </div>
          ${p.stock_maximo > 0 ? `
          <div style="margin-top:10px;font-size:.82em;color:#888">
            Stock: ${p.stock_vendido || 0} / ${p.stock_maximo} usados
            <div class="pd-progress"><div class="pd-progress-bar ${barCls}" style="width:${stockPct}%"></div></div>
          </div>` : ''}
        </div>

        <!-- Quick edit -->
        <div>
          <div class="pd-sec-title">Ajustar vigencia y stock</div>
          <div class="pd-edit-form">
            <div class="pd-form-row">
              <div class="pd-form-group">
                <label class="pd-form-label">Fecha desde</label>
                <input type="date" class="pd-form-input" id="pd-fecha-desde" value="${p.fecha_desde || ''}">
              </div>
              <div class="pd-form-group">
                <label class="pd-form-label">Fecha hasta</label>
                <input type="date" class="pd-form-input" id="pd-fecha-hasta" value="${p.fecha_hasta || ''}">
              </div>
              <button class="pd-btn-save" id="pd-save-fechas">Guardar</button>
            </div>
            <div class="pd-form-row">
              <div class="pd-form-group">
                <label class="pd-form-label">Stock máximo (0 = ilimitado)</label>
                <input type="number" class="pd-form-input" id="pd-stock-max" value="${p.stock_maximo || 0}" min="0" step="1">
              </div>
              <div class="pd-form-group">
                <label class="pd-form-label">Stock vendido (manual)</label>
                <input type="number" class="pd-form-input" id="pd-stock-vendido" value="${p.stock_vendido || 0}" min="0" step="1">
              </div>
              <button class="pd-btn-save" id="pd-save-stock">Guardar</button>
            </div>
          </div>
        </div>

        <!-- Historial -->
        <div>
          <div class="pd-sec-title">Historial de uso</div>
          ${histHtml}
        </div>
      `;

      // Save fechas
      document.getElementById('pd-save-fechas')?.addEventListener('click', () => {
        const desde = document.getElementById('pd-fecha-desde')?.value || null;
        const hasta = document.getElementById('pd-fecha-hasta')?.value || null;
        window.SGA_DB.run(
          `UPDATE promociones SET fecha_desde = ?, fecha_hasta = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
          [desde || null, hasta || null, now(), promoId]
        );
        showDetailPanel(promoId);
        renderList();
      });

      // Save stock
      document.getElementById('pd-save-stock')?.addEventListener('click', () => {
        const max     = parseInt(document.getElementById('pd-stock-max')?.value) || 0;
        const vendido = parseInt(document.getElementById('pd-stock-vendido')?.value) || 0;
        window.SGA_DB.run(
          `UPDATE promociones SET stock_maximo = ?, stock_vendido = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
          [max, vendido, now(), promoId]
        );
        showDetailPanel(promoId);
        renderList();
      });

      overlay.classList.remove('hidden');
    };

    // ── Render list ────────────────────────────────────────────────────
    const renderList = () => {
      const promos = getPromociones();
      const grid   = ge('promo-grid');
      const empty  = ge('promo-empty');
      if (!grid || !empty) return;

      if (!promos.length) {
        empty.style.display = 'flex';
        grid.style.display  = 'none';
        return;
      }
      empty.style.display = 'none';
      grid.style.display  = 'grid';

      grid.innerHTML = promos.map(p => {
        const isFlexible = p.flexible;
        const isActiva   = p.activa;
        const items      = p.items_summary
          ? p.items_summary.split(';;').map(s => { const [n, q] = s.split('|'); return { nombre: n, cantidad: parseFloat(q) || 1 }; })
          : [];

        let discHtml = '';
        if (p.precio_combo > 0) {
          discHtml = `Precio combo: <strong>${fmt(p.precio_combo)}</strong>`;
        } else if (p.tipo_descuento === 'porcentaje') {
          discHtml = `${p.valor_descuento}% de descuento`;
          if (p.aplica_a === 'item_mas_barato') discHtml += ' sobre el más barato';
        } else if (p.tipo_descuento === 'monto_fijo') {
          discHtml = `${fmt(p.valor_descuento)} de descuento`;
        }

        let datesHtml = '';
        if (p.fecha_desde || p.fecha_hasta) {
          const desde = p.fecha_desde ? p.fecha_desde : '—';
          const hasta = p.fecha_hasta ? p.fecha_hasta : '—';
          datesHtml = `<div class="promo-card-dates">${desde} → ${hasta}</div>`;
        }
        if (p.stock_maximo > 0) {
          datesHtml += `<div class="promo-card-dates">Stock: ${p.stock_vendido || 0}/${p.stock_maximo} usados</div>`;
        }

        const badges = [
          isFlexible ? `<span class="badge badge-flexible">Flexible</span>` : `<span class="badge badge-combo">Combo fijo</span>`,
          !isActiva  ? `<span class="badge badge-inactiva">Inactiva</span>` : '',
          p.solo_clientes_registrados ? `<span class="badge badge-solo-reg">Solo registrados</span>` : '',
          isFlexible ? `<span class="badge badge-combo">${p.cantidad_total_requerida} unid.</span>` : '',
        ].filter(Boolean).join('');

        const itemPills = items.map(i => {
          const qty = isFlexible ? '' : ` ×${i.cantidad}`;
          return `<span class="promo-item-pill">${i.nombre}${qty}</span>`;
        }).join('');

        return `<div class="promo-card${!isActiva ? ' inactiva' : ''}${isFlexible ? ' flexible' : ''}" data-id="${p.id}">
          <div class="promo-card-top">
            <div class="promo-card-nombre">${p.nombre}</div>
            <div class="promo-card-badges">${badges}</div>
          </div>
          ${p.descripcion ? `<div class="promo-card-desc">${p.descripcion}</div>` : ''}
          ${itemPills ? `<div class="promo-card-items">${itemPills}</div>` : ''}
          ${discHtml ? `<div class="promo-card-discount">${discHtml}</div>` : ''}
          ${datesHtml}
          <div class="promo-card-footer">
            <button class="btn-promo-action btn-promo-ver" data-id="${p.id}" style="background:#f0f4ff;border-color:#c5cdf9;color:#667eea">Ver detalles</button>
            <button class="btn-promo-action btn-promo-toggle" data-id="${p.id}" data-activa="${isActiva ? 1 : 0}">
              ${isActiva ? '⏸ Desactivar' : '▶ Activar'}
            </button>
            <button class="btn-promo-action btn-promo-delete" data-id="${p.id}" title="Elimina permanentemente la promoción y su historial">Eliminar</button>
          </div>
        </div>`;
      }).join('');

      grid.querySelectorAll('.btn-promo-ver').forEach(btn => {
        btn.addEventListener('click', () => showDetailPanel(btn.dataset.id));
      });
      grid.querySelectorAll('.btn-promo-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const activa = +btn.dataset.activa;
          toggleActiva(btn.dataset.id, !activa);
          renderList();
        });
      });
      grid.querySelectorAll('.btn-promo-delete').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('¿Eliminar esta promoción?\nEsta acción es permanente e irreversible.')) return;
          deletePromocion(btn.dataset.id);
          renderList();
        });
      });
    };

    // ── Modal ──────────────────────────────────────────────────────────
    const openModal = (editPromo = null) => {
      resetModal();
      editingId = editPromo ? editPromo.id : null;

      if (editPromo) {
        ge('promo-modal-title').textContent = 'Editar Promoción';
        ge('promo-nombre').value = editPromo.nombre;
        ge('promo-fecha-desde').value = editPromo.fecha_desde || '';
        ge('promo-fecha-hasta').value = editPromo.fecha_hasta || '';
        ge('promo-stock-max').value   = editPromo.stock_maximo || 0;
        ge('promo-solo-registrados').checked = !!editPromo.solo_clientes_registrados;

        setTipo(editPromo.flexible ? 'flexible' : 'fijo');
        if (editPromo.flexible) {
          ge('promo-cantidad-total').value = editPromo.cantidad_total_requerida || 2;
          ge('promo-aplica-a').value = editPromo.aplica_a || 'item_mas_barato';
        }

        if (editPromo.precio_combo > 0) {
          setDescTipo('precio_combo');
          ge('promo-valor-descuento').value = editPromo.precio_combo;
        } else {
          setDescTipo(editPromo.tipo_descuento || 'porcentaje');
          ge('promo-valor-descuento').value = editPromo.valor_descuento || 0;
        }

        const existingItems = getPromoItems(editPromo.id);
        comboItems = existingItems.map(i => ({
          productoId: i.producto_id,
          nombre: i.nombre,
          precio: parseFloat(i.precio_venta) || 0,
          cantidad: parseFloat(i.cantidad_requerida) || 1,
        }));
        renderComboItems();
      }

      ge('promo-modal-backdrop').classList.remove('hidden');
      setTimeout(() => ge('promo-nombre')?.focus(), 80);
    };

    const closeModal = () => {
      ge('promo-modal-backdrop').classList.add('hidden');
      resetModal();
    };

    const resetModal = () => {
      comboItems    = [];
      editingId     = null;
      tipoCombo     = 'fijo';
      tipoDescuento = 'porcentaje';
      searchHlIdx   = -1;
      lastSearchResults = [];

      ge('promo-modal-title').textContent = 'Nueva Promoción';
      ge('promo-nombre').value            = '';
      ge('promo-fecha-desde').value       = '';
      ge('promo-fecha-hasta').value       = '';
      ge('promo-stock-max').value         = '0';
      ge('promo-solo-registrados').checked = false;
      ge('promo-cantidad-total').value    = '2';
      ge('promo-aplica-a').value          = 'item_mas_barato';
      ge('promo-valor-descuento').value   = '';
      ge('modal-product-search').value    = '';

      const dd = ge('modal-search-dropdown');
      if (dd) dd.style.display = 'none';

      setTipo('fijo');
      setDescTipo('porcentaje');
      renderComboItems();
    };

    // ── Tipo toggle ─────────────────────────────────────────────────────
    const setTipo = (tipo) => {
      tipoCombo = tipo;
      const btnFijo     = ge('btn-tipo-fijo');
      const btnFlexible = ge('btn-tipo-flexible');
      const flexOpts    = ge('flexible-opts');
      btnFijo.classList.toggle('active', tipo === 'fijo');
      btnFlexible.classList.toggle('active', tipo === 'flexible');
      flexOpts.style.display = tipo === 'flexible' ? 'flex' : 'none';
    };

    ge('btn-tipo-fijo')?.addEventListener('click',     () => setTipo('fijo'));
    ge('btn-tipo-flexible')?.addEventListener('click', () => setTipo('flexible'));

    // ── Descuento tipo ──────────────────────────────────────────────────
    const setDescTipo = (tipo) => {
      tipoDescuento = tipo;
      ['btn-desc-pct', 'btn-desc-fijo', 'btn-desc-precio'].forEach(id => {
        const btn = ge(id);
        if (btn) btn.classList.toggle('active', btn.dataset.desc === tipo);
      });
      const label = ge('desc-valor-label');
      if (!label) return;
      if (tipo === 'porcentaje')   label.textContent = 'Porcentaje de descuento (%)';
      if (tipo === 'monto_fijo')   label.textContent = 'Monto de descuento ($)';
      if (tipo === 'precio_combo') label.textContent = 'Precio total del combo ($)';
    };

    ['btn-desc-pct', 'btn-desc-fijo', 'btn-desc-precio'].forEach(id => {
      ge(id)?.addEventListener('click', () => setDescTipo(ge(id).dataset.desc));
    });

    // ── Combo items render ──────────────────────────────────────────────
    const renderComboItems = () => {
      const list  = ge('combo-items-list');
      const empty = ge('combo-empty-msg');
      if (!list) return;

      if (!comboItems.length) {
        list.innerHTML = `<div class="combo-empty-msg" id="combo-empty-msg">Buscá y seleccioná los productos del combo</div>`;
        return;
      }

      list.innerHTML = comboItems.map((item, idx) => `
        <div class="combo-item-row" data-idx="${idx}">
          <div class="combo-item-nombre">${item.nombre}</div>
          <div class="combo-item-precio">${fmt(item.precio)}</div>
          <div class="combo-item-qty-wrap" id="qty-wrap-${idx}" style="${tipoCombo === 'flexible' ? 'display:none' : ''}">
            <span class="combo-item-qty-label">×</span>
            <input type="number" class="combo-item-qty" value="${item.cantidad}" min="1" step="1" data-idx="${idx}">
          </div>
          <button class="btn-combo-remove" data-idx="${idx}" title="Quitar">✕</button>
        </div>
      `).join('');

      list.querySelectorAll('.combo-item-qty').forEach(inp => {
        inp.addEventListener('change', () => {
          const idx = +inp.dataset.idx;
          const v   = parseFloat(inp.value);
          if (!isNaN(v) && v > 0 && comboItems[idx]) comboItems[idx].cantidad = v;
        });
      });
      list.querySelectorAll('.btn-combo-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          comboItems.splice(+btn.dataset.idx, 1);
          renderComboItems();
        });
      });
    };

    const addToCombo = (producto) => {
      const exists = comboItems.find(i => i.productoId === producto.id);
      if (exists) {
        exists.cantidad++;
        renderComboItems();
        return;
      }
      comboItems.push({
        productoId: producto.id,
        nombre:     producto.nombre,
        precio:     parseFloat(producto.precio_venta) || 0,
        cantidad:   1,
      });
      renderComboItems();
      ge('modal-product-search').value = '';
      const dd = ge('modal-search-dropdown');
      if (dd) dd.style.display = 'none';
      searchHlIdx = -1;
      setTimeout(() => ge('modal-product-search')?.focus(), 30);
    };

    // ── Product search in modal ─────────────────────────────────────────
    const searchInput = ge('modal-product-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const q  = searchInput.value.trim();
        const dd = ge('modal-search-dropdown');
        if (q.length < 2) { if (dd) dd.style.display = 'none'; return; }

        searchTimeout = setTimeout(() => {
          const results = searchProductos(q);
          lastSearchResults = results;
          searchHlIdx = -1;
          if (!dd) return;
          if (!results.length) { dd.style.display = 'none'; return; }

          dd.innerHTML = results.map(p => `
            <div class="msri" data-id="${p.id}">
              <div class="msri-left">
                <div class="msri-nombre">${p.nombre}</div>
                ${p.codigo ? `<div class="msri-codigo">${p.codigo}</div>` : ''}
              </div>
              <div class="msri-precio">${fmt(p.precio_venta)}</div>
            </div>`).join('');
          dd.style.display = 'block';

          dd.querySelectorAll('.msri').forEach(el => {
            el.addEventListener('click', () => {
              const p = results.find(x => x.id === el.dataset.id);
              if (p) addToCombo(p);
            });
          });
        }, 180);
      });

      searchInput.addEventListener('keydown', e => {
        const dd       = ge('modal-search-dropdown');
        const msriItems = dd ? dd.querySelectorAll('.msri') : [];

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!msriItems.length) return;
          searchHlIdx = Math.min(searchHlIdx + 1, msriItems.length - 1);
          msriItems.forEach((el, i) => el.classList.toggle('highlighted', i === searchHlIdx));
          if (msriItems[searchHlIdx]) msriItems[searchHlIdx].scrollIntoView({ block: 'nearest' });
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          searchHlIdx = Math.max(searchHlIdx - 1, -1);
          msriItems.forEach((el, i) => el.classList.toggle('highlighted', i === searchHlIdx));
          if (msriItems[searchHlIdx]) msriItems[searchHlIdx].scrollIntoView({ block: 'nearest' });
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (searchHlIdx >= 0 && lastSearchResults[searchHlIdx]) {
            addToCombo(lastSearchResults[searchHlIdx]);
            return;
          }
          const q = searchInput.value.trim();
          if (!q) return;
          const results = searchProductos(q);
          if (results.length === 1) { addToCombo(results[0]); return; }
        }
        if (e.key === 'Escape') {
          if (dd && dd.style.display !== 'none') {
            searchInput.value = '';
            dd.style.display  = 'none';
            searchHlIdx = -1;
            e.stopPropagation();
          }
        }
      });
    }

    // Close dropdown on outside click
    document.addEventListener('mousedown', e => {
      const dd = ge('modal-search-dropdown');
      if (dd && !dd.contains(e.target) && e.target !== searchInput) {
        dd.style.display = 'none';
      }
    });

    // ── Save ────────────────────────────────────────────────────────────
    ge('btn-promo-save')?.addEventListener('click', () => {
      const nombre = ge('promo-nombre')?.value.trim();
      if (!nombre) { ge('promo-nombre').focus(); alert('Ingresá un nombre para la promoción.'); return; }
      if (!comboItems.length) { alert('Agregá al menos un producto al combo.'); return; }

      const valDesc = parseFloat(ge('promo-valor-descuento')?.value) || 0;
      const data = {
        id:                       editingId || null,
        nombre,
        descripcion:              ge('promo-nombre')?.value ? '' : '',
        fecha_desde:              ge('promo-fecha-desde')?.value || null,
        fecha_hasta:              ge('promo-fecha-hasta')?.value || null,
        stock_maximo:             parseInt(ge('promo-stock-max')?.value) || 0,
        solo_clientes_registrados: ge('promo-solo-registrados')?.checked ? 1 : 0,
        flexible:                 tipoCombo === 'flexible' ? 1 : 0,
        cantidad_total_requerida: parseInt(ge('promo-cantidad-total')?.value) || 2,
        aplica_a:                 ge('promo-aplica-a')?.value || 'item_mas_barato',
        tipo_descuento:           tipoDescuento,
        valor_descuento:          tipoDescuento !== 'precio_combo' ? valDesc : 0,
        precio_combo:             tipoDescuento === 'precio_combo' ? valDesc : 0,
      };

      savePromocion(data, comboItems);
      closeModal();
      renderList();
    });

    // ── Modal open/close handlers ───────────────────────────────────────
    ge('btn-nueva-promo')?.addEventListener('click',       () => openModal());
    ge('btn-promo-modal-close')?.addEventListener('click', closeModal);
    ge('btn-promo-cancel')?.addEventListener('click',      closeModal);
    ge('promo-modal-backdrop')?.addEventListener('mousedown', e => {
      if (e.target === ge('promo-modal-backdrop')) closeModal();
    });

    // Escape key closes modal
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !ge('promo-modal-backdrop')?.classList.contains('hidden')) {
        const dd = ge('modal-search-dropdown');
        if (dd && dd.style.display !== 'none') return; // let search handle it
        closeModal();
      }
    });

    // ── Initial render ──────────────────────────────────────────────────
    renderList();
  }
};
