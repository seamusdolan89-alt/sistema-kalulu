/**
 * editor-producto.js — Full-page Product Editor
 *
 * Replaces the main app shell's aside and header temporarily to render
 * a multi-section product editor. Navigating away restores the shell.
 */

const EditorProducto = (() => {
  'use strict';

  const SECTIONS = [
    { id: 'datos-basicos',  icon: '📋', label: 'Datos Básicos' },
    { id: 'precios',        icon: '💰', label: 'Precios y Costos' },
    { id: 'familia',        icon: '👨‍👩‍👧', label: 'Familia' },
    { id: 'stock',          icon: '📦', label: 'Stock' },
    { id: 'sustitutos',     icon: '🔄', label: 'Sustitutos' },
    { id: 'promociones',    icon: '🏷️', label: 'Promociones' },
    { id: 'vencimientos',   icon: '📅', label: 'Vencimientos' },
    { id: 'transacciones',  icon: '📊', label: 'Transacciones' },
    { id: 'imagen',         icon: '🖼️', label: 'Imagen' },
  ];

  const state = {
    productoId: null,
    producto: null,
    barcodes: [],
    barcodesDeleted: [],
    stock: [],
    sustitutos: [],
    categorias: [],
    proveedores: [],
    sucursales: [],
    currentSection: 'datos-basicos',
    dirty: false,
    imagenBase64: null,
    imagenDeleted: false,
  };

  const ge = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  const escapeHtml = (str) =>
    String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── INIT ───────────────────────────────────────────────────────────────────

  const init = (params) => {
    const productoId = params && params[0];
    if (!productoId) { window.location.hash = '#productos'; return; }
    loadEditorData(productoId);
  };

  const loadEditorData = (productoId) => {
    state.productoId = productoId;

    const rows = window.SGA_DB.query(`
      SELECT p.*,
        cat.nombre AS categoria_nombre,
        prov.razon_social AS proveedor_nombre
      FROM productos p
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      LEFT JOIN proveedores prov ON prov.id = p.proveedor_principal_id
      WHERE p.id = ?
    `, [productoId]);

    if (!rows.length) {
      alert('Producto no encontrado');
      window.location.hash = '#productos';
      return;
    }

    state.producto       = rows[0];
    state.categorias     = window.SGA_DB.query('SELECT id, nombre FROM categorias ORDER BY nombre');
    state.proveedores    = window.SGA_DB.query('SELECT id, razon_social FROM proveedores WHERE activo = 1 ORDER BY razon_social');
    state.sucursales     = window.SGA_DB.query('SELECT id, nombre FROM sucursales WHERE activa = 1 ORDER BY nombre');
    state.barcodes       = window.SGA_DB.query(
      'SELECT id, codigo, es_principal FROM codigos_barras WHERE producto_id = ? ORDER BY es_principal DESC, codigo',
      [productoId]
    );
    state.dirty          = false;
    state.barcodesDeleted = [];
    state.imagenBase64   = null;
    state.imagenDeleted  = false;

    setupAppShell();
    renderContent();
    switchSection('datos-basicos');
    attachEvents();
  };

  // ── APP SHELL ──────────────────────────────────────────────────────────────

  const setupAppShell = () => {
    const p = state.producto;

    // Header
    const h1 = qs('header h1');
    if (h1) {
      h1.innerHTML = `<a href="#productos" class="ed-back-link">← Productos</a> / <span id="ed-header-nombre">${escapeHtml(p.nombre)}</span>`;
    }

    // Replace aside
    const aside = qs('aside.sidebar');
    if (aside) {
      aside.classList.add('editor-mode');
      aside.innerHTML = `
        <div class="editor-sidebar-header">
          <div class="editor-product-name" id="ed-aside-nombre">${escapeHtml(p.nombre)}</div>
          <div class="editor-product-cat">${escapeHtml(p.categoria_nombre || 'Sin categoría')}</div>
        </div>
        <nav>
          <ul>
            ${SECTIONS.map(s => `
              <li>
                <a href="#" class="nav-link editor-nav-link" data-section="${s.id}" style="border-left:3px solid transparent">
                  ${s.icon} ${s.label}
                </a>
              </li>
            `).join('')}
          </ul>
        </nav>
        <div class="editor-sidebar-footer">
          <button id="ed-btn-save" class="btn btn-primary" style="width:100%;margin-bottom:8px">💾 Guardar cambios</button>
          <button id="ed-btn-cancel" class="btn btn-outline" style="width:100%">Cancelar</button>
        </div>
      `;
    }
  };

  // ── CONTENT RENDERING ──────────────────────────────────────────────────────

  const renderContent = () => {
    const app = ge('app');
    if (!app) return;
    app.innerHTML = buildEditorHTML();
  };

  const buildEditorHTML = () => {
    const p   = state.producto;
    const cat = state.categorias;
    const prov = state.proveedores;

    const catOptions = cat.map(c =>
      `<option value="${escapeHtml(c.id)}" ${c.id === p.categoria_id ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`
    ).join('');

    const provOptions = (selectedId) => prov.map(pr =>
      `<option value="${escapeHtml(pr.id)}" ${pr.id === selectedId ? 'selected' : ''}>${escapeHtml(pr.razon_social)}</option>`
    ).join('');

    const margenActual = p.precio_venta > 0
      ? ((p.precio_venta - p.costo) / p.precio_venta * 100).toFixed(2)
      : '0.00';
    const markupActual = p.costo > 0
      ? (p.precio_venta / p.costo).toFixed(2)
      : '0.00';

    const esMadre   = p.es_madre === 1 || p.es_madre === '1';
    const tieneMadre = !!p.producto_madre_id;

    const unidades = ['unidad', 'kg', 'lt', 'mt', 'caja', 'par'];
    const unidadOptions = unidades.map(u =>
      `<option value="${u}" ${(p.unidad_medida || 'unidad') === u ? 'selected' : ''}>${u}</option>`
    ).join('');

    const stockAlerta = p.stock_alerta != null ? p.stock_alerta : (p.stock_minimo || 0);
    const cantPedido  = p.cant_pedido || 0;
    const isActivo    = p.activo === 1 || p.activo === '1';

    const BULK_UNITS  = ['bulto_cerrado', 'pack', 'display', 'bolsa'];
    const BULK_LABEL  = { bulto_cerrado: 'bulto cerrado', pack: 'pack', display: 'display', bolsa: 'bolsa' };
    const BULK_PLURAL = { bulto_cerrado: 'Bultos cerrados', pack: 'Packs', display: 'Displays', bolsa: 'Bolsas' };
    const pedidoUnidad = p.pedido_unidad || 'unidad';
    const isBulkInit   = BULK_UNITS.includes(pedidoUnidad);
    const uppInit      = p.pedido_unidades_por_paquete != null ? p.pedido_unidades_por_paquete : '';
    const showInfoInit = isBulkInit && uppInit !== '' && cantPedido > 0;
    const infoTextInit = showInfoInit
      ? `📦 Pedido sugerido: ${cantPedido} ${BULK_PLURAL[pedidoUnidad]} = ${cantPedido * uppInit} unidades`
      : '';

    return `
<div class="editor-content-area">

  <!-- ── DATOS BÁSICOS ──────────────────────────────────────────── -->
  <div id="section-datos-basicos" class="editor-section">
    <h3 class="ed-section-title">📋 Datos Básicos</h3>

    <div class="form-row">
      <div class="form-group">
        <label for="ed-nombre">Nombre *</label>
        <input type="text" id="ed-nombre" class="input-full" value="${escapeHtml(p.nombre || '')}">
      </div>
      <div class="form-group">
        <label for="ed-descripcion">Descripción</label>
        <input type="text" id="ed-descripcion" class="input-full" value="${escapeHtml(p.descripcion || '')}">
      </div>
    </div>

    <div class="form-group">
      <label>Códigos de barras</label>
      <div id="ed-barcodes-list" class="ed-barcode-tags"></div>
      <div class="ed-barcode-add-row">
        <input type="text" id="ed-barcode-input" class="input-full" placeholder="Escanear o ingresar código..." autocomplete="off">
        <button id="ed-btn-add-barcode" class="btn btn-secondary btn-sm">+ Agregar</button>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="ed-categoria">Categoría</label>
        <select id="ed-categoria" class="select-full">
          <option value="">-- Sin categoría --</option>
          ${catOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="ed-unidad">Unidad de medida</label>
        <select id="ed-unidad" class="select-full">${unidadOptions}</select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="ed-proveedor-principal">Proveedor principal</label>
        <select id="ed-proveedor-principal" class="select-full">
          <option value="">-- Ninguno --</option>
          ${provOptions(p.proveedor_principal_id)}
        </select>
      </div>
      <div class="form-group">
        <label for="ed-proveedor-alternativo">Proveedor alternativo</label>
        <select id="ed-proveedor-alternativo" class="select-full">
          <option value="">-- Ninguno --</option>
          ${provOptions(p.proveedor_alternativo_id)}
        </select>
      </div>
    </div>

    <div class="form-group">
      <div class="ed-toggle-row">
        <span>Estado</span>
        <label class="ed-toggle-switch">
          <input type="checkbox" id="ed-activo" ${isActivo ? 'checked' : ''}>
          <span class="ed-toggle-slider"></span>
        </label>
        <span id="ed-activo-label">${isActivo ? 'Activo' : 'Inactivo'}</span>
      </div>
    </div>
  </div>

  <!-- ── PRECIOS Y COSTOS ───────────────────────────────────────── -->
  <div id="section-precios" class="editor-section" style="display:none">
    <h3 class="ed-section-title">💰 Precios y Costos</h3>

    <div class="ed-precios-grid">
      <div class="form-group">
        <label for="ed-costo">Costo</label>
        <div class="ed-input-prefix-wrap">
          <span class="ed-input-affix">$</span>
          <input type="number" id="ed-costo" class="input-full" step="0.01" min="0" value="${p.costo || 0}">
        </div>
      </div>
      <div class="form-group">
        <label for="ed-precio-venta">Precio de venta</label>
        <div class="ed-input-prefix-wrap">
          <span class="ed-input-affix">$</span>
          <input type="number" id="ed-precio-venta" class="input-full" step="0.01" min="0" value="${p.precio_venta || 0}">
        </div>
      </div>
      <div class="form-group">
        <label for="ed-margen">Margen</label>
        <div class="ed-input-suffix-wrap">
          <input type="number" id="ed-margen" class="input-full" step="0.01" value="${margenActual}">
          <span class="ed-input-affix">%</span>
        </div>
      </div>
      <div class="form-group">
        <label for="ed-markup">Markup</label>
        <input type="number" id="ed-markup" class="input-full" step="0.01" min="0" value="${markupActual}">
      </div>
    </div>

    <div class="ed-calculadora">
      <h4 style="margin:0 0 10px;font-size:14px;color:var(--color-text-secondary)">Calculadora de precio</h4>
      <div style="display:flex;gap:20px;margin-bottom:12px">
        <label class="ed-radio-label">
          <input type="radio" name="ed-calc-mode" value="margen" checked> Quiero margen %
        </label>
        <label class="ed-radio-label">
          <input type="radio" name="ed-calc-mode" value="markup"> Quiero markup
        </label>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label id="ed-calc-valor-label" for="ed-calc-valor">Margen objetivo %</label>
          <input type="number" id="ed-calc-valor" class="input-full" placeholder="ej: 40" min="0">
        </div>
        <div class="form-group">
          <label for="ed-precio-sugerido">Precio sugerido</label>
          <input type="number" id="ed-precio-sugerido" class="input-full" readonly style="background:var(--color-background-secondary)">
        </div>
        <div class="form-group" style="padding-top:22px">
          <button id="ed-btn-aplicar-precio" class="btn btn-secondary btn-sm">Aplicar →</button>
        </div>
      </div>
    </div>

    <div style="margin-top:16px">
      <h4 style="margin:0 0 8px;font-size:14px">Historial de cambios de costo</h4>
      <p class="ed-text-muted ed-text-sm">El historial de costos estará disponible próximamente.</p>
    </div>
  </div>

  <!-- ── FAMILIA ────────────────────────────────────────────────── -->
  <div id="section-familia" class="editor-section" style="display:none">
    <h3 class="ed-section-title">👨‍👩‍👧 Familia</h3>

    <div class="form-group" style="margin-bottom:20px">
      <div class="ed-toggle-row">
        <span style="font-weight:600;font-size:15px">¿Es producto madre?</span>
        <label class="ed-toggle-switch">
          <input type="checkbox" id="ed-es-madre" ${esMadre ? 'checked' : ''}>
          <span class="ed-toggle-slider"></span>
        </label>
        <span id="ed-es-madre-label">${esMadre ? 'Sí' : 'No'}</span>
      </div>
    </div>

    <!-- Panel cuando ES madre -->
    <div id="ed-familia-madre-panel" ${!esMadre ? 'style="display:none"' : ''}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h4 style="margin:0">Hijos de este producto</h4>
        <button id="ed-btn-agregar-hijo" class="btn btn-secondary btn-sm">+ Agregar hijo</button>
      </div>
      <div id="ed-hijos-list"></div>
    </div>

    <!-- Panel cuando NO es madre -->
    <div id="ed-familia-hijo-panel" ${esMadre ? 'style="display:none"' : ''}>
      <div id="ed-current-madre-info" ${!tieneMadre ? 'style="display:none"' : ''}>
        <div class="alert alert-info" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;margin-bottom:12px">
          <span>Actualmente es hijo de: <strong id="ed-current-madre-nombre"></strong></span>
          <button id="ed-btn-desvincular-madre" class="btn btn-danger btn-sm">Desvincular</button>
        </div>
      </div>
      <div class="form-group">
        <label>Buscar madre para este producto</label>
        <div style="position:relative">
          <input type="text" id="ed-buscar-madre-input" class="input-full" placeholder="Escribir nombre de producto madre..." autocomplete="off">
          <div id="ed-buscar-madre-results" class="ed-search-dropdown" style="display:none"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── STOCK ──────────────────────────────────────────────────── -->
  <div id="section-stock" class="editor-section" style="display:none">
    <h3 class="ed-section-title">📦 Stock</h3>

    <table class="table" style="margin-bottom:16px">
      <thead>
        <tr><th>Sucursal</th><th>Cantidad actual</th><th>Ajustar</th></tr>
      </thead>
      <tbody id="ed-stock-tbody"></tbody>
    </table>

    <div class="form-row">
      <div class="form-group">
        <label for="ed-stock-alerta">Stock alerta</label>
        <input type="number" id="ed-stock-alerta" class="input-full" step="1" min="0" value="${stockAlerta}">
        <small class="ed-text-muted">Alerta cuando el stock cae por debajo de este valor</small>
      </div>
      <div class="form-group">
        <label for="ed-cant-pedido">Pedido sugerido</label>
        <div style="display:flex;gap:8px">
          <input type="number" id="ed-cant-pedido" class="input-full" step="1" min="0" placeholder="ej: 2" value="${cantPedido}">
          <select id="ed-pedido-unidad" class="select-full" style="flex:0 0 auto;min-width:130px">
            <option value="unidad"        ${pedidoUnidad === 'unidad'        ? 'selected' : ''}>Unidad</option>
            <option value="kg"            ${pedidoUnidad === 'kg'            ? 'selected' : ''}>Kg</option>
            <option value="bulto_cerrado" ${pedidoUnidad === 'bulto_cerrado' ? 'selected' : ''}>Bulto cerrado</option>
            <option value="pack"          ${pedidoUnidad === 'pack'          ? 'selected' : ''}>Pack</option>
            <option value="display"       ${pedidoUnidad === 'display'       ? 'selected' : ''}>Display</option>
            <option value="bolsa"         ${pedidoUnidad === 'bolsa'         ? 'selected' : ''}>Bolsa</option>
          </select>
        </div>
        <div id="ed-unidades-paquete-wrap" style="display:${isBulkInit ? '' : 'none'};margin-top:8px">
          <label for="ed-pedido-unidades-paquete" style="font-size:12px;color:var(--color-text-secondary);margin-bottom:4px;display:block">¿Cuántas unidades trae cada ${BULK_LABEL[pedidoUnidad] || 'paquete'}?</label>
          <input type="number" id="ed-pedido-unidades-paquete" class="input-full" min="1" step="1" placeholder="ej: 12" value="${uppInit}">
        </div>
        <div id="ed-pedido-info" style="display:${showInfoInit ? '' : 'none'};margin-top:8px;font-size:13px;color:var(--color-text-secondary)">${infoTextInit}</div>
        <small class="ed-text-muted">Cantidad y unidad a pedir al reponer stock</small>
      </div>
    </div>

    <div id="ed-stock-stats" class="ed-text-sm" style="margin-top:14px;padding:10px 14px;background:var(--color-background-secondary);border-radius:6px;color:var(--color-text-secondary)">
      Cargando estadísticas...
    </div>
  </div>

  <!-- ── SUSTITUTOS ─────────────────────────────────────────────── -->
  <div id="section-sustitutos" class="editor-section" style="display:none">
    <h3 class="ed-section-title">🔄 Sustitutos</h3>
    <p class="ed-text-muted">El stock disponible de este producto incluye el stock de los sustitutos activos.</p>

    <div id="ed-sustitutos-list" style="margin-bottom:12px"></div>

    <div class="form-group">
      <label>Agregar sustituto</label>
      <div style="position:relative">
        <input type="text" id="ed-sustituto-search" class="input-full"
               placeholder="🔍 Buscar por nombre o escanear código..." autocomplete="off">
        <div id="ed-sustituto-dropdown" class="ed-search-dropdown" style="display:none"></div>
      </div>
      <small class="ed-text-muted">Escribí el nombre o escaneá un código (Enter para seleccionar)</small>
    </div>
  </div>

  <!-- ── PROMOCIONES ────────────────────────────────────────────── -->
  <div id="section-promociones" class="editor-section" style="display:none">
    <h3 class="ed-section-title">🏷️ Promociones</h3>
    <div id="ed-promociones-list" style="margin-bottom:12px"></div>
    <button class="btn btn-secondary" disabled style="opacity:0.6">
      + Agregar a promoción &nbsp;<span class="badge-proximamente">🔜 Próximamente</span>
    </button>
  </div>

  <!-- ── VENCIMIENTOS ───────────────────────────────────────────── -->
  <div id="section-vencimientos" class="editor-section" style="display:none">
    <h3 class="ed-section-title">📅 Vencimientos</h3>
    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" id="ed-tiene-vencimiento">
        Este producto tiene fecha de vencimiento
      </label>
    </div>
    <div id="ed-vencimientos-panel" style="display:none;margin-top:12px">
      <div id="ed-vencimientos-alerts"></div>
      <table class="table">
        <thead><tr><th>Lote</th><th>Fecha vencimiento</th><th>Cantidad</th><th></th></tr></thead>
        <tbody id="ed-vencimientos-tbody">
          <tr><td colspan="4" class="ed-text-muted" style="text-align:center">Sin lotes registrados</td></tr>
        </tbody>
      </table>
      <button id="ed-btn-agregar-lote" class="btn btn-secondary btn-sm" style="margin-top:8px">+ Agregar lote</button>
    </div>
  </div>

  <!-- ── TRANSACCIONES ──────────────────────────────────────────── -->
  <div id="section-transacciones" class="editor-section" style="display:none">
    <h3 class="ed-section-title">📊 Transacciones</h3>

    <!-- Stock actual + action -->
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px 16px;background:var(--color-background-secondary);border-radius:8px">
      <span style="font-size:14px;color:var(--color-text-secondary)">Stock actual:</span>
      <strong id="ed-tx-stock-actual" style="font-size:18px">—</strong>
      <button id="ed-btn-registrar-movimiento" class="btn btn-secondary btn-sm" style="margin-left:auto">+ Registrar movimiento</button>
    </div>

    <!-- Filters -->
    <div class="form-row" style="margin-bottom:12px;align-items:flex-end">
      <div class="form-group">
        <label>Desde</label>
        <input type="date" id="ed-tx-desde" class="input-full">
      </div>
      <div class="form-group">
        <label>Hasta</label>
        <input type="date" id="ed-tx-hasta" class="input-full">
      </div>
      <div class="form-group">
        <label>Tipo</label>
        <select id="ed-tx-tipo" class="select-full">
          <option value="">Todos</option>
          <option value="venta">Ventas</option>
          <option value="compra">Compras</option>
          <option value="ajuste">Ajustes</option>
          <option value="devolucion">Devoluciones</option>
        </select>
      </div>
      <div id="ed-tx-sucursal-group" class="form-group" style="display:none">
        <label>Sucursal</label>
        <select id="ed-tx-sucursal" class="select-full">
          <option value="">Todas</option>
        </select>
      </div>
      <div class="form-group">
        <button id="ed-btn-tx-filtrar" class="btn btn-secondary btn-sm" style="width:100%">Filtrar</button>
      </div>
    </div>

    <!-- Ledger table -->
    <div style="overflow-x:auto">
      <table class="ed-tx-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Descripción</th>
            <th style="text-align:right;color:#388E3C">Debe (+)</th>
            <th style="text-align:right;color:#d32f2f">Haber (-)</th>
            <th style="text-align:right">Saldo</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="ed-tx-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- ── IMAGEN ─────────────────────────────────────────────────── -->
  <div id="section-imagen" class="editor-section" style="display:none">
    <h3 class="ed-section-title">🖼️ Imagen</h3>
    <div id="ed-imagen-preview" class="ed-imagen-box">
      ${p.imagen ? `<img src="${p.imagen}" alt="Imagen del producto" style="width:100%;height:100%;object-fit:cover">` : '<span class="ed-text-muted">Sin imagen</span>'}
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <input type="file" id="ed-imagen-file" accept="image/*" style="display:none">
      <button id="ed-btn-imagen-upload" class="btn btn-secondary btn-sm">📁 Cargar imagen</button>
      <button id="ed-btn-imagen-delete" class="btn btn-danger btn-sm" ${!p.imagen ? 'style="display:none"' : ''}>🗑️ Eliminar</button>
    </div>
  </div>

</div>

<style>
.editor-content-area { max-width: 820px; }
.ed-section-title {
  font-size: 18px; font-weight: 600; margin: 0 0 20px;
  padding-bottom: 12px; border-bottom: 2px solid var(--color-border);
  color: var(--color-text);
}
.ed-barcode-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; min-height: 28px; }
.ed-barcode-tag {
  display: inline-flex; align-items: center; gap: 4px;
  background: #e8f4fd; border: 1px solid #b8daff; border-radius: 14px;
  padding: 3px 10px; font-size: 13px;
}
.ed-barcode-tag.principal { background: #d4edda; border-color: #c3e6cb; }
.ed-barcode-tag button {
  background: none; border: none; cursor: pointer;
  color: #6c757d; font-size: 15px; padding: 0 0 0 4px; line-height: 1;
}
.ed-barcode-add-row { display: flex; gap: 8px; align-items: center; }
.ed-barcode-add-row input { flex: 1; }
.ed-toggle-row { display: flex; align-items: center; gap: 12px; }
.ed-toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
.ed-toggle-switch input { opacity: 0; width: 0; height: 0; }
.ed-toggle-slider {
  position: absolute; cursor: pointer; inset: 0;
  background: #ccc; transition: .3s; border-radius: 24px;
}
.ed-toggle-slider:before {
  position: absolute; content: ""; height: 18px; width: 18px;
  left: 3px; bottom: 3px; background: white; transition: .3s; border-radius: 50%;
}
.ed-toggle-switch input:checked + .ed-toggle-slider { background: var(--color-success); }
.ed-toggle-switch input:checked + .ed-toggle-slider:before { transform: translateX(20px); }
.ed-precios-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;
}
.ed-input-prefix-wrap,
.ed-input-suffix-wrap {
  display: flex; align-items: stretch;
  border: 1px solid var(--color-border, #ddd); border-radius: 6px; overflow: hidden; background: white;
}
.ed-input-prefix-wrap .input-full,
.ed-input-suffix-wrap .input-full {
  border: none; border-radius: 0; flex: 1; min-width: 0;
  background: transparent; box-shadow: none;
}
.ed-input-prefix-wrap .input-full:focus,
.ed-input-suffix-wrap .input-full:focus { outline: none; box-shadow: none; }
.ed-input-prefix-wrap:focus-within,
.ed-input-suffix-wrap:focus-within { border-color: var(--color-primary, #2196F3); }
.ed-input-affix {
  padding: 0 8px; background: var(--color-background-secondary, #f5f5f5);
  border-right: 1px solid var(--color-border, #ddd);
  color: var(--color-text-secondary); font-size: 13px;
  display: flex; align-items: center; white-space: nowrap; flex-shrink: 0;
}
.ed-input-suffix-wrap .ed-input-affix { border-right: none; border-left: 1px solid var(--color-border, #ddd); }
.ed-calculadora {
  background: var(--color-background-secondary); border: 1px solid var(--color-border);
  border-radius: 8px; padding: 16px; margin: 16px 0;
}
.ed-radio-group { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.ed-radio-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; }
.ed-sust-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border: 1px solid var(--color-border);
  border-radius: 6px; margin-bottom: 6px;
}
.ed-sust-info { font-size: 13px; }
.ed-sust-code { color: var(--color-text-secondary); font-size: 12px; margin-left: 6px; }
.ed-tabs-bar { display: flex; border-bottom: 2px solid var(--color-border); margin-bottom: 12px; }
.ed-tab-btn {
  background: none; border: none; padding: 8px 18px; cursor: pointer;
  font-size: 14px; color: var(--color-text-secondary);
  border-bottom: 2px solid transparent; margin-bottom: -2px;
}
.ed-tab-btn.active { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 600; }
.ed-imagen-box {
  width: 180px; height: 180px; border: 2px dashed var(--color-border);
  border-radius: 8px; display: flex; align-items: center;
  justify-content: center; overflow: hidden; background: var(--color-background-secondary);
}
.ed-text-muted { color: var(--color-text-secondary); }
.ed-text-sm { font-size: 13px; }
.ed-search-dropdown {
  position: absolute; left: 0; right: 0; top: calc(100% + 2px);
  background: white; border: 1px solid var(--color-border);
  border-radius: 6px; box-shadow: var(--shadow-md);
  z-index: 500; max-height: 220px; overflow-y: auto;
}
.ed-search-result-item {
  padding: 9px 14px; cursor: pointer; font-size: 14px;
  border-bottom: 1px solid var(--color-border);
}
.ed-search-result-item:last-child { border-bottom: none; }
.ed-search-result-item:hover { background: var(--color-primary-light); color: var(--color-primary); }
.ed-familia-modal-box {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
  background: white; border-radius: 10px; padding: 24px;
  z-index: 2001; min-width: 380px; max-width: 480px; width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
.ed-familia-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 2000;
}
.fam-hijo-result-item {
  padding: 9px 14px; cursor: pointer; font-size: 14px;
  border-bottom: 1px solid var(--color-border);
}
.fam-hijo-result-item:last-child { border-bottom: none; }
.fam-hijo-result-item:hover { background: var(--color-primary-light); }
.ed-toast {
  position: fixed; bottom: 24px; right: 24px;
  background: var(--color-success); color: white;
  padding: 12px 20px; border-radius: 8px; font-size: 14px;
  z-index: 9999; box-shadow: var(--shadow-md);
  animation: ed-slidein 0.25s ease;
}
@keyframes ed-slidein { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.ed-tx-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ed-tx-table th {
  background: var(--color-background-secondary); padding: 8px 10px;
  text-align: left; font-weight: 600; font-size: 12px;
  border-bottom: 2px solid var(--color-border); white-space: nowrap;
}
.ed-tx-table td { padding: 7px 10px; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.ed-tx-table tr:hover td { background: var(--color-primary-light, #e3f2fd); }
</style>
`;
  };

  // ── SECTION SWITCHING ──────────────────────────────────────────────────────

  const switchSection = (sectionId) => {
    state.currentSection = sectionId;

    SECTIONS.forEach(s => {
      const el = ge('section-' + s.id);
      if (el) el.style.display = s.id === sectionId ? '' : 'none';
    });

    document.querySelectorAll('.editor-nav-link').forEach(a => {
      const isActive = a.dataset.section === sectionId;
      a.classList.toggle('active', isActive);
      a.style.borderLeftColor = isActive ? 'var(--color-primary)' : 'transparent';
      a.style.color = isActive ? 'var(--color-primary)' : '';
      a.style.backgroundColor = isActive ? 'var(--color-primary-light)' : '';
      a.style.fontWeight = isActive ? '600' : '';
    });

    if (sectionId === 'stock')          { renderStock(); renderStockStats(); }
    if (sectionId === 'sustitutos')     renderSustitutos();
    if (sectionId === 'familia')        renderFamilia();
    if (sectionId === 'transacciones')  renderTransacciones();
    if (sectionId === 'promociones')    renderPromociones();
    if (sectionId === 'datos-basicos')  renderBarcodes();
  };

  // ── SECTION RENDERERS ──────────────────────────────────────────────────────

  const renderBarcodes = () => {
    const list = ge('ed-barcodes-list');
    if (!list) return;
    list.innerHTML = state.barcodes.map(bc => `
      <span class="ed-barcode-tag ${bc.es_principal ? 'principal' : ''}" data-id="${escapeHtml(bc.id)}">
        ${escapeHtml(bc.codigo)}${bc.es_principal ? ' ★' : ''}
        <button class="ed-remove-barcode" data-id="${escapeHtml(bc.id)}" title="Eliminar">×</button>
      </span>
    `).join('');

    list.querySelectorAll('.ed-remove-barcode').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (id && !String(id).startsWith('new-')) state.barcodesDeleted.push(id);
        state.barcodes = state.barcodes.filter(b => b.id !== id);
        markDirty();
        renderBarcodes();
      });
    });
  };

  const renderStock = () => {
    const tbody = ge('ed-stock-tbody');
    if (!tbody) return;

    const stockRows = window.SGA_DB.query(`
      SELECT s.id AS sucursal_id, s.nombre AS sucursal_nombre,
        COALESCE(st.cantidad, 0) AS cantidad
      FROM sucursales s
      LEFT JOIN stock st ON st.producto_id = ? AND st.sucursal_id = s.id
      WHERE s.activa = 1
      ORDER BY s.nombre
    `, [state.productoId]);

    tbody.innerHTML = stockRows.map(row => `
      <tr>
        <td>${escapeHtml(row.sucursal_nombre)}</td>
        <td>${row.cantidad}</td>
        <td>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="number" class="ed-stock-input"
              data-sucursal="${escapeHtml(row.sucursal_id)}"
              value="${row.cantidad}"
              style="width:80px;padding:4px 8px;border:1px solid var(--color-border);border-radius:4px"
              step="0.01">
            <button class="btn btn-secondary btn-sm ed-btn-save-stock"
              data-sucursal="${escapeHtml(row.sucursal_id)}">Guardar</button>
          </div>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.ed-btn-save-stock').forEach(btn => {
      btn.addEventListener('click', () => {
        const sucursalId = btn.dataset.sucursal;
        const input = tbody.querySelector(`.ed-stock-input[data-sucursal="${sucursalId}"]`);
        const cantidad = parseFloat(input && input.value) || 0;
        saveStockImmediate(sucursalId, cantidad);
        renderStock();
      });
    });
  };

  const renderStockStats = () => {
    const statsDiv = ge('ed-stock-stats');
    if (!statsDiv) return;
    try {
      const res = window.SGA_DB.query(`
        SELECT COALESCE(SUM(vi.cantidad), 0) AS total_cant
        FROM venta_items vi
        JOIN ventas v ON v.id = vi.venta_id
        WHERE vi.producto_id = ? AND v.fecha >= date('now', '-6 months')
      `, [state.productoId]);
      const total = res.length ? (parseFloat(res[0].total_cant) || 0) : 0;
      if (total === 0) {
        statsDiv.textContent = 'Sin datos de ventas en los últimos 6 meses.';
        return;
      }
      const promedio = (total / 6).toFixed(1);
      statsDiv.innerHTML =
        `📊 Promedio mensual: <strong>${promedio} unidades</strong>` +
        `&nbsp;&nbsp;|&nbsp;&nbsp;⚠️ Quiebres: <span title="Requiere historial de movimientos de stock">Sin historial</span>`;
    } catch (e) {
      statsDiv.textContent = 'Sin datos suficientes.';
    }
  };

  const saveStockImmediate = (sucursalId, cantidad) => {
    const now = window.SGA_Utils.formatISODate(new Date());
    const exists = window.SGA_DB.query(
      'SELECT 1 FROM stock WHERE producto_id = ? AND sucursal_id = ?',
      [state.productoId, sucursalId]
    );
    if (exists.length) {
      window.SGA_DB.run(
        "UPDATE stock SET cantidad = ?, fecha_modificacion = ?, sync_status = 'pending', updated_at = ? WHERE producto_id = ? AND sucursal_id = ?",
        [cantidad, now, now, state.productoId, sucursalId]
      );
    } else {
      window.SGA_DB.run(
        "INSERT INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)",
        [state.productoId, sucursalId, cantidad, now, now]
      );
    }
    showToast('Stock actualizado');
  };

  const renderSustitutos = () => {
    const list = ge('ed-sustitutos-list');
    if (!list) return;

    const sustitutos = window.SGA_DB.query(`
      SELECT ps.sustituto_id, ps.activo, p.nombre,
        cb.codigo AS codigo_barras
      FROM producto_sustitutos ps
      JOIN productos p ON p.id = ps.sustituto_id
      LEFT JOIN codigos_barras cb ON cb.producto_id = ps.sustituto_id AND cb.es_principal = 1
      WHERE ps.producto_id = ?
      ORDER BY p.nombre
    `, [state.productoId]);

    if (!sustitutos.length) {
      list.innerHTML = '<p class="ed-text-muted">Sin sustitutos asignados.</p>';
    } else {
      list.innerHTML = sustitutos.map(s => `
        <div class="ed-sust-row">
          <div class="ed-sust-info">
            <strong>${escapeHtml(s.nombre)}</strong>
            <span class="ed-sust-code">${escapeHtml(s.codigo_barras || '')}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <label class="ed-toggle-switch" title="${s.activo ? 'Activo' : 'Inactivo'}">
              <input type="checkbox" class="ed-sust-toggle" data-id="${escapeHtml(s.sustituto_id)}" ${s.activo ? 'checked' : ''}>
              <span class="ed-toggle-slider"></span>
            </label>
            <button class="btn btn-danger btn-sm ed-sust-remove" data-id="${escapeHtml(s.sustituto_id)}">×</button>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.ed-sust-toggle').forEach(chk => {
        chk.addEventListener('change', () => {
          window.SGA_DB.run(
            'UPDATE producto_sustitutos SET activo = ? WHERE producto_id = ? AND sustituto_id = ?',
            [chk.checked ? 1 : 0, state.productoId, chk.dataset.id]
          );
          showToast('Sustituto actualizado');
        });
      });

      list.querySelectorAll('.ed-sust-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('¿Quitar este sustituto?')) return;
          window.SGA_DB.run(
            'DELETE FROM producto_sustitutos WHERE producto_id = ? AND sustituto_id = ?',
            [state.productoId, btn.dataset.id]
          );
          renderSustitutos();
        });
      });
    }

  };

  const addSustituto = (sustitutoId) => {
    if (!sustitutoId) return;
    const now = window.SGA_Utils.formatISODate(new Date());
    window.SGA_DB.run(
      'INSERT OR IGNORE INTO producto_sustitutos (producto_id, sustituto_id, activo, fecha_asignacion) VALUES (?, ?, 1, ?)',
      [state.productoId, sustitutoId, now]
    );
    renderSustitutos();
  };

  const renderSustitutoDropdown = (q) => {
    const dropdown = ge('ed-sustituto-dropdown');
    if (!dropdown) return;
    if (!q || q.length < 2) { dropdown.style.display = 'none'; return; }

    const existingIds = new Set(
      window.SGA_DB.query(
        'SELECT sustituto_id FROM producto_sustitutos WHERE producto_id = ?',
        [state.productoId]
      ).map(r => r.sustituto_id)
    );
    existingIds.add(state.productoId);

    const results = window.SGA_DB.query(`
      SELECT p.id, p.nombre, cat.nombre AS categoria_nombre,
        cb.codigo AS codigo_barras
      FROM productos p
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      WHERE p.activo = 1 AND (LOWER(p.nombre) LIKE ? OR cb.codigo LIKE ?)
      ORDER BY p.nombre LIMIT 10
    `, ['%' + q.toLowerCase() + '%', '%' + q + '%'])
    .filter(pr => !existingIds.has(pr.id));

    if (!results.length) {
      dropdown.innerHTML = '<div class="ed-search-result-item ed-text-muted">Sin resultados</div>';
      dropdown.style.display = '';
      return;
    }

    dropdown.innerHTML = results.map(pr => `
      <div class="ed-search-result-item" data-id="${escapeHtml(pr.id)}">
        <strong>${escapeHtml(pr.nombre)}</strong>
        ${pr.categoria_nombre ? `<span class="ed-sust-code">${escapeHtml(pr.categoria_nombre)}</span>` : ''}
      </div>
    `).join('');
    dropdown.style.display = '';

    dropdown.querySelectorAll('.ed-search-result-item[data-id]').forEach(item => {
      item.addEventListener('click', () => {
        addSustituto(item.dataset.id);
        const si = ge('ed-sustituto-search');
        if (si) si.value = '';
        dropdown.style.display = 'none';
      });
    });
  };

  // ── FAMILIA SECTION ───────────────────────────────────────────────────────

  const renderFamilia = () => {
    const esMadre = state.producto.es_madre === 1 || state.producto.es_madre === '1';
    const madrePanel = ge('ed-familia-madre-panel');
    const hijoPanel  = ge('ed-familia-hijo-panel');
    if (madrePanel) madrePanel.style.display = esMadre ? '' : 'none';
    if (hijoPanel)  hijoPanel.style.display  = esMadre ? 'none' : '';
    if (esMadre) {
      renderHijosList();
    } else {
      renderMadreInfo();
    }
  };

  const renderHijosList = () => {
    const hijos = window.SGA_DB.query(`
      SELECT p.id, p.nombre, p.activo, p.hereda_costo, p.hereda_precio,
        cb.codigo AS codigo_barras
      FROM productos p
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
      WHERE p.producto_madre_id = ?
      ORDER BY p.nombre
    `, [state.productoId]);

    const list = ge('ed-hijos-list');
    if (!list) return;

    if (!hijos.length) {
      list.innerHTML = '<p class="ed-text-muted">Sin productos hijos asignados.</p>';
      return;
    }

    list.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th style="width:54px;text-align:center">Activo</th>
            <th>Nombre</th>
            <th>Código</th>
            <th style="width:100px;text-align:center">Hereda costo</th>
            <th style="width:100px;text-align:center">Hereda precio</th>
            <th style="width:44px"></th>
          </tr>
        </thead>
        <tbody>
          ${hijos.map(h => {
            const hc = h.hereda_costo == null || h.hereda_costo === 1 || h.hereda_costo === '1';
            const hp = h.hereda_precio == null || h.hereda_precio === 1 || h.hereda_precio === '1';
            return `
            <tr>
              <td style="text-align:center">
                <input type="checkbox" class="ed-hijo-activo-chk"
                  data-id="${escapeHtml(h.id)}" data-nombre="${escapeHtml(h.nombre)}"
                  ${h.activo ? 'checked' : ''}>
              </td>
              <td>${escapeHtml(h.nombre)}</td>
              <td>${escapeHtml(h.codigo_barras || '-')}</td>
              <td style="text-align:center">
                <input type="checkbox" class="ed-hijo-hereda-costo"
                  data-id="${escapeHtml(h.id)}" ${hc ? 'checked' : ''}>
              </td>
              <td style="text-align:center">
                <input type="checkbox" class="ed-hijo-hereda-precio"
                  data-id="${escapeHtml(h.id)}" ${hp ? 'checked' : ''}>
              </td>
              <td>
                <button class="btn btn-sm btn-secondary ed-btn-edit-hijo"
                  data-id="${escapeHtml(h.id)}"
                  data-nombre="${escapeHtml(h.nombre)}"
                  data-hereda-costo="${hc ? 1 : 0}"
                  data-hereda-precio="${hp ? 1 : 0}">✏️</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    list.querySelectorAll('.ed-hijo-activo-chk').forEach(chk => {
      chk.addEventListener('change', () => {
        if (chk.checked) return; // re-activating not supported from this toggle
        if (!confirm(`¿Desvincular "${chk.dataset.nombre}" de esta familia?`)) {
          chk.checked = true;
          return;
        }
        const now = window.SGA_Utils.formatISODate(new Date());
        window.SGA_DB.run(
          "UPDATE productos SET producto_madre_id = NULL, fecha_modificacion = ?, sync_status = 'pending', updated_at = ? WHERE id = ?",
          [now, now, chk.dataset.id]
        );
        showToast('Hijo desvinculado');
        renderHijosList();
      });
    });

    list.querySelectorAll('.ed-hijo-hereda-costo').forEach(chk => {
      chk.addEventListener('change', () => {
        const now = window.SGA_Utils.formatISODate(new Date());
        window.SGA_DB.run(
          'UPDATE productos SET hereda_costo = ?, updated_at = ? WHERE id = ?',
          [chk.checked ? 1 : 0, now, chk.dataset.id]
        );
        showToast('Actualizado');
      });
    });

    list.querySelectorAll('.ed-hijo-hereda-precio').forEach(chk => {
      chk.addEventListener('change', () => {
        const now = window.SGA_Utils.formatISODate(new Date());
        window.SGA_DB.run(
          'UPDATE productos SET hereda_precio = ?, updated_at = ? WHERE id = ?',
          [chk.checked ? 1 : 0, now, chk.dataset.id]
        );
        showToast('Actualizado');
      });
    });

    list.querySelectorAll('.ed-btn-edit-hijo').forEach(btn => {
      btn.addEventListener('click', () => {
        openHijoEditModal(btn.dataset.id, btn.dataset.nombre, btn.dataset.heredaCosto, btn.dataset.heredaPrecio);
      });
    });
  };

  const renderMadreInfo = () => {
    const p = state.producto;
    const tieneMadre = !!p.producto_madre_id;
    const madreInfo = ge('ed-current-madre-info');
    if (madreInfo) {
      madreInfo.style.display = tieneMadre ? '' : 'none';
      if (tieneMadre) {
        const madreRow = window.SGA_DB.query('SELECT nombre FROM productos WHERE id = ?', [p.producto_madre_id]);
        const madreNombre = ge('ed-current-madre-nombre');
        if (madreNombre) madreNombre.textContent = madreRow.length ? madreRow[0].nombre : '(desconocida)';
      }
    }

    // Desvincular
    const desvinBtn = ge('ed-btn-desvincular-madre');
    if (desvinBtn) {
      desvinBtn.onclick = () => {
        if (!confirm('¿Desvincular este producto de su madre?')) return;
        const now = window.SGA_Utils.formatISODate(new Date());
        window.SGA_DB.run(
          "UPDATE productos SET producto_madre_id = NULL, hereda_costo = 0, hereda_precio = 0, fecha_modificacion = ?, sync_status = 'pending', updated_at = ? WHERE id = ?",
          [now, now, state.productoId]
        );
        state.producto.producto_madre_id = null;
        state.producto.hereda_costo = 0;
        state.producto.hereda_precio = 0;
        showToast('Desvinculado de la madre');
        renderMadreInfo();
      };
    }

    // Buscar madre input — re-bind each time to avoid stale closures
    const buscarInput = ge('ed-buscar-madre-input');
    if (buscarInput) {
      buscarInput.value = '';
      const newInput = buscarInput.cloneNode(true);
      buscarInput.parentNode.replaceChild(newInput, buscarInput);
      newInput.addEventListener('input', () => {
        const q = newInput.value.trim().toLowerCase();
        const resultsDiv = ge('ed-buscar-madre-results');
        if (!resultsDiv) return;
        if (!q) { resultsDiv.style.display = 'none'; return; }
        const madres = window.SGA_DB.query(
          "SELECT id, nombre FROM productos WHERE es_madre = 1 AND id != ? AND LOWER(nombre) LIKE ? ORDER BY nombre LIMIT 10",
          [state.productoId, '%' + q + '%']
        );
        if (!madres.length) {
          resultsDiv.innerHTML = '<div class="ed-search-result-item ed-text-muted">Sin resultados</div>';
          resultsDiv.style.display = '';
          return;
        }
        resultsDiv.innerHTML = madres.map(m =>
          `<div class="ed-search-result-item" data-id="${escapeHtml(m.id)}" data-nombre="${escapeHtml(m.nombre)}">${escapeHtml(m.nombre)}</div>`
        ).join('');
        resultsDiv.style.display = '';
        resultsDiv.querySelectorAll('.ed-search-result-item[data-id]').forEach(item => {
          item.addEventListener('click', () => {
            newInput.value = item.dataset.nombre;
            resultsDiv.style.display = 'none';
            confirmAsignarMadre(item.dataset.id, item.dataset.nombre);
          });
        });
      });
    }
  };

  // ── FAMILIA MODALS ─────────────────────────────────────────────────────────

  const openFamiliaModal = (contentHTML, onConfirm) => {
    closeFamiliaModal();
    const overlay = document.createElement('div');
    overlay.id = 'ed-familia-modal-overlay';
    overlay.className = 'ed-familia-overlay';
    const modal = document.createElement('div');
    modal.id = 'ed-familia-modal';
    modal.className = 'ed-familia-modal-box';
    modal.innerHTML = contentHTML;
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    const confirmBtn = ge('fam-btn-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
    const cancelBtn = ge('fam-btn-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeFamiliaModal);
    overlay.addEventListener('click', closeFamiliaModal);
  };

  const closeFamiliaModal = () => {
    ['ed-familia-modal-overlay', 'ed-familia-modal'].forEach(id => {
      const el = ge(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  };

  const openHijoEditModal = (hijoId, hijoNombre, heredaCosto, heredaPrecio) => {
    const hc = heredaCosto === '1' || heredaCosto === 1 || heredaCosto === true;
    const hp = heredaPrecio === '1' || heredaPrecio === 1 || heredaPrecio === true;
    openFamiliaModal(`
      <h4 style="margin:0 0 16px;font-size:16px">✏️ ${escapeHtml(hijoNombre)}</h4>
      <div class="form-group" style="margin-bottom:14px">
        <div class="ed-toggle-row">
          <label class="ed-toggle-switch">
            <input type="checkbox" id="fam-hereda-costo" ${hc ? 'checked' : ''}>
            <span class="ed-toggle-slider"></span>
          </label>
          <span>Hereda costo de la madre</span>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:20px">
        <div class="ed-toggle-row">
          <label class="ed-toggle-switch">
            <input type="checkbox" id="fam-hereda-precio" ${hp ? 'checked' : ''}>
            <span class="ed-toggle-slider"></span>
          </label>
          <span>Hereda precio de la madre</span>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="fam-btn-confirm" class="btn btn-primary btn-sm">Guardar</button>
        <button id="fam-btn-cancel" class="btn btn-outline btn-sm">Cancelar</button>
      </div>
    `, () => {
      const newHC = (ge('fam-hereda-costo') || {}).checked ? 1 : 0;
      const newHP = (ge('fam-hereda-precio') || {}).checked ? 1 : 0;
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        'UPDATE productos SET hereda_costo = ?, hereda_precio = ?, updated_at = ? WHERE id = ?',
        [newHC, newHP, now, hijoId]
      );
      closeFamiliaModal();
      showToast('Herencia actualizada');
      renderHijosList();
    });
  };

  const openAgregarHijoModal = () => {
    openFamiliaModal(`
      <h4 style="margin:0 0 16px;font-size:16px">+ Agregar hijo</h4>
      <div class="form-group">
        <label style="font-size:13px;color:var(--color-text-secondary)">Buscar producto</label>
        <input type="text" id="fam-buscar-hijo" class="input-full" placeholder="Escribir nombre..." autocomplete="off">
      </div>
      <div id="fam-hijo-results" style="border:1px solid var(--color-border);border-radius:6px;max-height:180px;overflow-y:auto;margin:6px 0;display:none"></div>
      <div id="fam-hijo-confirm" style="display:none;margin-top:12px"></div>
      <div style="margin-top:16px">
        <button id="fam-btn-cancel" class="btn btn-outline btn-sm">Cancelar</button>
      </div>
    `, () => {});

    const buscarInput = ge('fam-buscar-hijo');
    if (buscarInput) {
      buscarInput.focus();
      buscarInput.addEventListener('input', () => {
        const q = buscarInput.value.trim().toLowerCase();
        const resultsDiv = ge('fam-hijo-results');
        if (!resultsDiv) return;
        if (!q) { resultsDiv.style.display = 'none'; return; }

        const currentHijoIds = window.SGA_DB.query(
          'SELECT id FROM productos WHERE producto_madre_id = ?', [state.productoId]
        ).map(r => r.id);
        const excludeIds = new Set([state.productoId, ...currentHijoIds]);

        const productos = window.SGA_DB.query(
          "SELECT id, nombre, producto_madre_id, es_madre FROM productos WHERE activo = 1 AND LOWER(nombre) LIKE ? ORDER BY nombre LIMIT 15",
          ['%' + q + '%']
        ).filter(pr => !excludeIds.has(pr.id));

        if (!productos.length) {
          resultsDiv.innerHTML = '<div class="fam-hijo-result-item ed-text-muted">Sin resultados</div>';
          resultsDiv.style.display = '';
          return;
        }
        resultsDiv.innerHTML = productos.map(pr =>
          `<div class="fam-hijo-result-item" data-id="${escapeHtml(pr.id)}"
              data-nombre="${escapeHtml(pr.nombre)}"
              data-has-madre="${pr.producto_madre_id ? 'true' : 'false'}"
              data-madre-id="${escapeHtml(pr.producto_madre_id || '')}">
            ${escapeHtml(pr.nombre)}${pr.es_madre ? ' <span style="font-size:11px;color:var(--color-text-secondary)">(ya es madre)</span>' : ''}
          </div>`
        ).join('');
        resultsDiv.style.display = '';
        resultsDiv.querySelectorAll('.fam-hijo-result-item[data-id]').forEach(item => {
          item.addEventListener('click', () => {
            buscarInput.value = item.dataset.nombre;
            resultsDiv.style.display = 'none';
            showHijoConfirmation(item.dataset.id, item.dataset.nombre,
              item.dataset.hasMadre === 'true', item.dataset.madreId);
          });
        });
      });
    }
  };

  const showHijoConfirmation = (productoId, nombre, hasMadre, madreId) => {
    const confirmDiv = ge('fam-hijo-confirm');
    if (!confirmDiv) return;
    if (hasMadre && madreId) {
      const madreRows = window.SGA_DB.query('SELECT nombre FROM productos WHERE id = ?', [madreId]);
      const nombreMadreActual = madreRows.length ? madreRows[0].nombre : '(desconocida)';
      confirmDiv.innerHTML = `
        <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px 14px;margin-bottom:10px;font-size:13px">
          ⚠️ Este producto ya es hijo de <strong>${escapeHtml(nombreMadreActual)}</strong>
        </div>
        <div style="display:flex;gap:8px">
          <button id="fam-btn-mantener-madre" class="btn btn-outline btn-sm">Mantener madre actual</button>
          <button id="fam-btn-cambiar-madre" class="btn btn-primary btn-sm">Cambiar madre</button>
        </div>`;
      confirmDiv.style.display = '';
      ge('fam-btn-mantener-madre').addEventListener('click', closeFamiliaModal);
      ge('fam-btn-cambiar-madre').addEventListener('click', () => showInheritanceForm(productoId, nombre));
    } else {
      showInheritanceForm(productoId, nombre);
    }
  };

  const showInheritanceForm = (hijoId, hijoNombre) => {
    const confirmDiv = ge('fam-hijo-confirm');
    if (!confirmDiv) return;
    confirmDiv.innerHTML = `
      <p style="margin:0 0 10px;font-size:14px">¿Qué hereda <strong>${escapeHtml(hijoNombre)}</strong>?</p>
      <label class="checkbox-label" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="fam-nuevo-hereda-costo" checked> Heredar costo
      </label>
      <label class="checkbox-label" style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <input type="checkbox" id="fam-nuevo-hereda-precio" checked> Heredar precio
      </label>
      <div style="display:flex;gap:8px">
        <button id="fam-btn-confirmar-hijo" class="btn btn-primary btn-sm">Confirmar</button>
        <button id="fam-btn-cancelar-hijo" class="btn btn-outline btn-sm">Cancelar</button>
      </div>`;
    confirmDiv.style.display = '';
    ge('fam-btn-cancelar-hijo').addEventListener('click', closeFamiliaModal);
    ge('fam-btn-confirmar-hijo').addEventListener('click', () => {
      const heredaCosto  = (ge('fam-nuevo-hereda-costo')  || {}).checked ? 1 : 0;
      const heredaPrecio = (ge('fam-nuevo-hereda-precio') || {}).checked ? 1 : 0;
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        "UPDATE productos SET producto_madre_id = ?, hereda_costo = ?, hereda_precio = ?, es_madre = 0, fecha_modificacion = ?, sync_status = 'pending', updated_at = ? WHERE id = ?",
        [state.productoId, heredaCosto, heredaPrecio, now, now, hijoId]
      );
      closeFamiliaModal();
      showToast('Hijo agregado a la familia');
      renderHijosList();
    });
  };

  const confirmAsignarMadre = (madreId, madreNombre) => {
    openFamiliaModal(`
      <h4 style="margin:0 0 12px;font-size:16px">¿Asignar madre?</h4>
      <p style="margin:0 0 14px;font-size:14px">Asignar <strong>${escapeHtml(madreNombre)}</strong> como madre de este producto.</p>
      <label class="checkbox-label" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="fam-hereda-costo" checked> Heredar costo de la madre
      </label>
      <label class="checkbox-label" style="display:flex;align-items:center;gap:8px;margin-bottom:20px">
        <input type="checkbox" id="fam-hereda-precio" checked> Heredar precio de la madre
      </label>
      <div style="display:flex;gap:8px">
        <button id="fam-btn-confirm" class="btn btn-primary btn-sm">Confirmar</button>
        <button id="fam-btn-cancel" class="btn btn-outline btn-sm">Cancelar</button>
      </div>
    `, () => {
      const hc = (ge('fam-hereda-costo')  || {}).checked ? 1 : 0;
      const hp = (ge('fam-hereda-precio') || {}).checked ? 1 : 0;
      const now = window.SGA_Utils.formatISODate(new Date());
      window.SGA_DB.run(
        "UPDATE productos SET producto_madre_id = ?, hereda_costo = ?, hereda_precio = ?, es_madre = 0, fecha_modificacion = ?, sync_status = 'pending', updated_at = ? WHERE id = ?",
        [madreId, hc, hp, now, now, state.productoId]
      );
      state.producto.producto_madre_id = madreId;
      state.producto.hereda_costo = hc;
      state.producto.hereda_precio = hp;
      closeFamiliaModal();
      showToast('Madre asignada');
      renderMadreInfo();
    });
  };

  // ── TRANSACCIONES LEDGER ───────────────────────────────────────────────────

  const TX_BADGE = {
    venta:             'background:#1565C0;color:white',
    compra:            'background:#2E7D32;color:white',
    ajuste:            'background:#616161;color:white',
    ajuste_positivo:   'background:#616161;color:white',
    ajuste_negativo:   'background:#616161;color:white',
    devolucion_venta:  'background:#E65100;color:white',
    devolucion_compra: 'background:#E65100;color:white',
    consumo_interno:   'background:#6A1B9A;color:white',
    rotura:            'background:#B71C1C;color:white',
  };

  const TX_LABEL = {
    venta:             'Venta',
    compra:            'Compra',
    ajuste:            'Ajuste',
    ajuste_positivo:   'Ajuste +',
    ajuste_negativo:   'Ajuste -',
    devolucion_venta:  'Dev. Venta',
    devolucion_compra: 'Dev. Compra',
    consumo_interno:   'Consumo',
    rotura:            'Rotura',
  };

  const fmtFecha = (str) => {
    if (!str) return '-';
    const d = new Date(str);
    if (isNaN(d)) return str;
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const renderTransacciones = () => {
    // Populate sucursal filter
    const sucSel = ge('ed-tx-sucursal');
    if (sucSel) {
      sucSel.innerHTML = '<option value="">Todas</option>' +
        state.sucursales.map(s =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nombre)}</option>`
        ).join('');
      const grp = ge('ed-tx-sucursal-group');
      if (grp) grp.style.display = state.sucursales.length > 1 ? '' : 'none';
    }
    // Show current stock
    const currentUser = window.SGA_Auth.getCurrentUser();
    const sucId = currentUser?.sucursal_id || '1';
    const stockRow = window.SGA_DB.query(
      'SELECT COALESCE(cantidad,0) AS cant FROM stock WHERE producto_id=? AND sucursal_id=?',
      [state.productoId, sucId]
    );
    const el = ge('ed-tx-stock-actual');
    if (el) el.textContent = (stockRow.length ? stockRow[0].cant : 0) + ' unidades';

    loadLedger();
  };

  const loadLedger = () => {
    const desde   = (ge('ed-tx-desde')    || {}).value || '';
    const hasta   = (ge('ed-tx-hasta')    || {}).value || '';
    const tipoFlt = (ge('ed-tx-tipo')     || {}).value || '';
    const sucFlt  = (ge('ed-tx-sucursal') || {}).value || '';

    const inDateRange = (fecha) => {
      if (!fecha) return true;
      if (desde && fecha < desde) return false;
      if (hasta && fecha.substring(0,10) > hasta) return false;
      return true;
    };

    let movements = [];

    // 1. Ventas
    if (!tipoFlt || tipoFlt === 'venta') {
      try {
        window.SGA_DB.query(`
          SELECT v.id AS venta_id, v.fecha, vi.cantidad, v.sucursal_id,
            COALESCE(c.nombre || ' ' || COALESCE(c.apellido,''), 'Consumidor final') AS cliente,
            COALESCE(u.nombre, '-') AS vendedor
          FROM venta_items vi
          JOIN ventas v ON v.id = vi.venta_id
          LEFT JOIN clientes c ON c.id = v.cliente_id
          LEFT JOIN usuarios u ON u.id = v.usuario_id
          WHERE vi.producto_id = ?
          ORDER BY v.fecha ASC
        `, [state.productoId]).forEach(r => {
          if (!inDateRange(r.fecha)) return;
          if (sucFlt && r.sucursal_id !== sucFlt) return;
          movements.push({
            id: r.venta_id, tipo: 'venta', fecha: r.fecha,
            descripcion: `Venta a ${r.cliente} — Vendedor: ${r.vendedor}`,
            debe: 0, haber: r.cantidad, ref_id: r.venta_id,
          });
        });
      } catch(e) { /* no ventas */ }
    }

    // 2. Compras
    if (!tipoFlt || tipoFlt === 'compra') {
      try {
        window.SGA_DB.query(`
          SELECT c.id AS compra_id, c.fecha, ci.cantidad, c.sucursal_id,
            COALESCE(pr.razon_social, '-') AS proveedor,
            c.numero_factura
          FROM compra_items ci
          JOIN compras c ON c.id = ci.compra_id
          LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
          WHERE ci.producto_id = ?
          ORDER BY c.fecha ASC
        `, [state.productoId]).forEach(r => {
          if (!inDateRange(r.fecha)) return;
          if (sucFlt && r.sucursal_id !== sucFlt) return;
          movements.push({
            id: r.compra_id, tipo: 'compra', fecha: r.fecha,
            descripcion: `Compra a ${r.proveedor}${r.numero_factura ? ' — Factura: ' + r.numero_factura : ''}`,
            debe: r.cantidad, haber: 0, ref_id: r.compra_id,
          });
        });
      } catch(e) { /* no compras */ }
    }

    // 3. Ajustes manuales (stock_ajustes)
    if (!tipoFlt || tipoFlt === 'ajuste') {
      try {
        window.SGA_DB.query(`
          SELECT sa.id, sa.fecha, sa.tipo, sa.cantidad, sa.motivo, sa.sucursal_id
          FROM stock_ajustes sa
          WHERE sa.producto_id = ?
          ORDER BY sa.fecha ASC
        `, [state.productoId]).forEach(r => {
          if (!inDateRange(r.fecha)) return;
          if (sucFlt && r.sucursal_id !== sucFlt) return;
          const isPos = r.tipo === 'ajuste_positivo';
          movements.push({
            id: r.id, tipo: r.tipo, fecha: r.fecha,
            descripcion: `Ajuste manual — ${r.motivo || 'Sin motivo'}`,
            debe: isPos ? r.cantidad : 0,
            haber: isPos ? 0 : r.cantidad,
            ref_id: r.id,
          });
        });
      } catch(e) { /* table may not exist yet */ }
    }

    // Sort chronologically, calculate running saldo
    movements.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    let saldo = 0;
    movements.forEach(m => { saldo += m.debe - m.haber; m.saldo = saldo; });

    renderLedger(movements);
  };

  const renderLedger = (movements) => {
    const tbody = ge('ed-tx-tbody');
    if (!tbody) return;

    if (!movements.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--color-text-secondary);padding:28px">
        Sin movimientos registrados</td></tr>`;
      return;
    }

    tbody.innerHTML = movements.map(m => {
      const badge  = TX_BADGE[m.tipo] || 'background:#9E9E9E;color:white';
      const label  = escapeHtml(TX_LABEL[m.tipo] || m.tipo);
      const shortId = String(m.ref_id || m.id).slice(-8).toUpperCase();
      const debeStr  = m.debe  > 0 ? `<span style="color:#388E3C;font-weight:600">+${m.debe}</span>` : '–';
      const haberStr = m.haber > 0 ? `<span style="color:#d32f2f;font-weight:600">-${m.haber}</span>` : '–';
      const saldoClr = m.saldo >= 0 ? 'inherit' : '#d32f2f';
      return `<tr>
        <td>
          <a href="#" class="ed-tx-link" data-tipo="${escapeHtml(m.tipo)}" data-ref="${escapeHtml(m.ref_id)}"
             style="font-family:monospace;font-size:11px;color:var(--color-primary)">${shortId}</a>
        </td>
        <td style="font-size:12px;white-space:nowrap">${fmtFecha(m.fecha)}</td>
        <td><span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;${badge}">${label}</span></td>
        <td style="font-size:12px">${escapeHtml(m.descripcion)}</td>
        <td style="text-align:right">${debeStr}</td>
        <td style="text-align:right">${haberStr}</td>
        <td style="text-align:right;font-weight:600;color:${saldoClr}">${m.saldo}</td>
        <td>
          <button class="btn btn-sm btn-secondary ed-tx-link" style="padding:2px 6px"
            data-tipo="${escapeHtml(m.tipo)}" data-ref="${escapeHtml(m.ref_id)}" title="Ver detalle">🔍</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.ed-tx-link').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        navegarAOperacion(el.dataset.tipo, el.dataset.ref);
      });
    });
  };

  const navegarAOperacion = (tipo, refId) => {
    if (tipo === 'venta') {
      sessionStorage.setItem('highlight_venta', refId);
      sessionStorage.setItem('highlight_back_producto', state.productoId);
      window.location.hash = '#pos';
    } else if (tipo === 'compra') {
      sessionStorage.setItem('highlight_compra', refId);
      sessionStorage.setItem('highlight_back_producto', state.productoId);
      window.location.hash = '#compras';
    } else {
      showAjusteDetalle(refId);
    }
  };

  const showAjusteDetalle = (ajusteId) => {
    try {
      const rows = window.SGA_DB.query(`
        SELECT sa.*, COALESCE(u.nombre, '-') AS usuario_nombre
        FROM stock_ajustes sa LEFT JOIN usuarios u ON u.id = sa.usuario_id
        WHERE sa.id = ?
      `, [ajusteId]);
      if (!rows.length) { showToast('Ajuste no encontrado'); return; }
      const r = rows[0];
      openFamiliaModal(`
        <h4 style="margin:0 0 16px;font-size:16px">🔍 Detalle de ajuste</h4>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <tr><td style="padding:5px 0;color:#666;width:90px">Tipo</td><td style="padding:5px 0;font-weight:600">${escapeHtml(TX_LABEL[r.tipo] || r.tipo)}</td></tr>
          <tr><td style="padding:5px 0;color:#666">Cantidad</td><td style="padding:5px 0;font-weight:600">${r.cantidad}</td></tr>
          <tr><td style="padding:5px 0;color:#666">Motivo</td><td style="padding:5px 0">${escapeHtml(r.motivo || '–')}</td></tr>
          <tr><td style="padding:5px 0;color:#666">Usuario</td><td style="padding:5px 0">${escapeHtml(r.usuario_nombre)}</td></tr>
          <tr><td style="padding:5px 0;color:#666">Fecha</td><td style="padding:5px 0">${fmtFecha(r.fecha)}</td></tr>
        </table>
        <div style="margin-top:16px">
          <button id="fam-btn-cancel" class="btn btn-outline btn-sm">Cerrar</button>
        </div>
      `, () => {});
    } catch (e) { showToast('Error al cargar detalle'); }
  };

  const openRegistrarMovimientoModal = () => {
    const currentUser = window.SGA_Auth.getCurrentUser();
    const sucId = currentUser?.sucursal_id || '1';
    openFamiliaModal(`
      <h4 style="margin:0 0 16px;font-size:16px">+ Registrar movimiento</h4>
      <div class="form-group" style="margin-bottom:12px">
        <label style="font-size:13px;color:var(--color-text-secondary)">Tipo *</label>
        <select id="fam-ajuste-tipo" class="select-full">
          <option value="ajuste_positivo">Ajuste positivo (+ stock)</option>
          <option value="ajuste_negativo">Ajuste negativo (− stock)</option>
          <option value="consumo_interno">Consumo interno (− stock)</option>
          <option value="rotura">Rotura / merma (− stock)</option>
        </select>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label style="font-size:13px;color:var(--color-text-secondary)">Cantidad *</label>
        <input type="number" id="fam-ajuste-cantidad" class="input-full" min="0.01" step="0.01" placeholder="0">
      </div>
      <div class="form-group" style="margin-bottom:20px">
        <label style="font-size:13px;color:var(--color-text-secondary)">Motivo *</label>
        <input type="text" id="fam-ajuste-motivo" class="input-full" placeholder="Ej: inventario mensual">
      </div>
      <div style="display:flex;gap:8px">
        <button id="fam-btn-confirm" class="btn btn-primary btn-sm">Guardar</button>
        <button id="fam-btn-cancel" class="btn btn-outline btn-sm">Cancelar</button>
      </div>
    `, () => {
      const tipo     = (ge('fam-ajuste-tipo')     || {}).value || 'ajuste_positivo';
      const cantidad = parseFloat((ge('fam-ajuste-cantidad') || {}).value) || 0;
      const motivo   = ((ge('fam-ajuste-motivo')  || {}).value || '').trim();
      if (cantidad <= 0) { alert('La cantidad debe ser mayor a 0'); return; }
      if (!motivo)       { alert('El motivo es obligatorio'); return; }

      const now = window.SGA_Utils.formatISODate(new Date());
      const id  = window.SGA_Utils.generateUUID();
      window.SGA_DB.run(`
        INSERT INTO stock_ajustes
          (id,producto_id,sucursal_id,tipo,cantidad,motivo,usuario_id,fecha,sync_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?)
      `, [id, state.productoId, sucId, tipo, cantidad, motivo, currentUser?.id || null, now, now]);

      const delta = tipo === 'ajuste_positivo' ? cantidad : -cantidad;
      const exists = window.SGA_DB.query(
        'SELECT 1 FROM stock WHERE producto_id=? AND sucursal_id=?',
        [state.productoId, sucId]
      );
      if (exists.length) {
        window.SGA_DB.run(
          "UPDATE stock SET cantidad=cantidad+?,fecha_modificacion=?,sync_status='pending',updated_at=? WHERE producto_id=? AND sucursal_id=?",
          [delta, now, now, state.productoId, sucId]
        );
      } else {
        window.SGA_DB.run(
          "INSERT INTO stock (producto_id,sucursal_id,cantidad,fecha_modificacion,sync_status,updated_at) VALUES (?,?,?,?,'pending',?)",
          [state.productoId, sucId, Math.max(0, delta), now, now]
        );
      }
      closeFamiliaModal();
      showToast('Movimiento registrado');
      renderTransacciones();
    });
  };

  const renderPromociones = () => {
    const list = ge('ed-promociones-list');
    if (!list) return;

    const promos = window.SGA_DB.query(`
      SELECT pr.nombre, pr.tipo, pr.activa
      FROM promocion_items pi
      JOIN promociones pr ON pr.id = pi.promocion_id
      WHERE pi.producto_id = ?
    `, [state.productoId]);

    list.innerHTML = promos.length
      ? promos.map(pr => `
          <div class="ed-sust-row">
            <span>${escapeHtml(pr.nombre)}</span>
            <span class="badge ${pr.activa ? 'badge-success' : 'badge-secondary'}">${pr.activa ? 'Activa' : 'Inactiva'}</span>
          </div>`).join('')
      : '<p class="ed-text-muted">Este producto no pertenece a ninguna promoción activa.</p>';
  };

  // ── PEDIDO UNIDAD UI ───────────────────────────────────────────────────────

  const BULK_UNITS_EV  = ['bulto_cerrado', 'pack', 'display', 'bolsa'];
  const BULK_LABEL_EV  = { bulto_cerrado: 'bulto cerrado', pack: 'pack', display: 'display', bolsa: 'bolsa' };
  const BULK_PLURAL_EV = { bulto_cerrado: 'Bultos cerrados', pack: 'Packs', display: 'Displays', bolsa: 'Bolsas' };

  const updatePedidoInfoLine = () => {
    const infoDiv = ge('ed-pedido-info');
    if (!infoDiv) return;
    const unidad = (ge('ed-pedido-unidad') || {}).value || 'unidad';
    const isBulk = BULK_UNITS_EV.includes(unidad);
    const cant   = parseFloat((ge('ed-cant-pedido') || {}).value) || 0;
    const upp    = parseFloat((ge('ed-pedido-unidades-paquete') || {}).value) || 0;
    if (isBulk && upp > 0 && cant > 0) {
      infoDiv.style.display = '';
      infoDiv.textContent = `📦 Pedido sugerido: ${cant} ${BULK_PLURAL_EV[unidad]} = ${cant * upp} unidades`;
    } else {
      infoDiv.style.display = 'none';
      infoDiv.textContent = '';
    }
  };

  const updatePedidoUnidadUI = () => {
    const unidad = (ge('ed-pedido-unidad') || {}).value || 'unidad';
    const isBulk = BULK_UNITS_EV.includes(unidad);
    const wrap   = ge('ed-unidades-paquete-wrap');
    if (wrap) {
      wrap.style.display = isBulk ? '' : 'none';
      const label = wrap.querySelector('label');
      if (label) label.textContent = `¿Cuántas unidades trae cada ${BULK_LABEL_EV[unidad] || 'paquete'}?`;
    }
    updatePedidoInfoLine();
  };

  // ── EVENTS ─────────────────────────────────────────────────────────────────

  const attachEvents = () => {
    // Sidebar nav
    document.querySelectorAll('.editor-nav-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        switchSection(a.dataset.section);
      });
    });

    // Save / Cancel
    ge('ed-btn-save') && ge('ed-btn-save').addEventListener('click', saveAll);
    ge('ed-btn-cancel') && ge('ed-btn-cancel').addEventListener('click', handleCancel);

    // Dirty tracking
    ['ed-nombre', 'ed-descripcion', 'ed-costo', 'ed-precio-venta', 'ed-stock-alerta', 'ed-cant-pedido', 'ed-pedido-unidades-paquete'].forEach(id => {
      const el = ge(id);
      if (el) el.addEventListener('input', markDirty);
    });
    ['ed-categoria', 'ed-unidad', 'ed-proveedor-principal', 'ed-proveedor-alternativo'].forEach(id => {
      const el = ge(id);
      if (el) el.addEventListener('change', markDirty);
    });

    // Pedido sugerido: Enter to save, live info line
    const cantPedidoEl = ge('ed-cant-pedido');
    if (cantPedidoEl) {
      cantPedidoEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAll(); } });
      cantPedidoEl.addEventListener('input', updatePedidoInfoLine);
    }
    ge('ed-pedido-unidad') && ge('ed-pedido-unidad').addEventListener('change', () => { markDirty(); updatePedidoUnidadUI(); });
    ge('ed-pedido-unidades-paquete') && ge('ed-pedido-unidades-paquete').addEventListener('input', updatePedidoInfoLine);

    // Toggle label
    const activoChk = ge('ed-activo');
    if (activoChk) {
      activoChk.addEventListener('change', () => {
        const label = ge('ed-activo-label');
        if (label) label.textContent = activoChk.checked ? 'Activo' : 'Inactivo';
        markDirty();
      });
    }

    // Barcodes
    ge('ed-btn-add-barcode') && ge('ed-btn-add-barcode').addEventListener('click', addBarcode);
    const bcInput = ge('ed-barcode-input');
    if (bcInput) {
      bcInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBarcode(); } });
    }

    // Precio calculator
    ge('ed-costo') && ge('ed-costo').addEventListener('input', recalcMargen);
    ge('ed-precio-venta') && ge('ed-precio-venta').addEventListener('input', recalcMargen);
    ge('ed-margen') && ge('ed-margen').addEventListener('input', recalcFromMargen);
    ge('ed-markup') && ge('ed-markup').addEventListener('input', recalcFromMarkup);
    ge('ed-calc-valor') && ge('ed-calc-valor').addEventListener('input', recalcPrecioSugerido);
    document.querySelectorAll('input[name="ed-calc-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        const lbl = ge('ed-calc-valor-label');
        if (lbl) lbl.textContent = r.value === 'margen' ? 'Margen objetivo %' : 'Markup objetivo';
        recalcPrecioSugerido();
      });
    });
    ge('ed-btn-aplicar-precio') && ge('ed-btn-aplicar-precio').addEventListener('click', () => {
      const val = ge('ed-precio-sugerido') && ge('ed-precio-sugerido').value;
      if (val) {
        ge('ed-precio-venta').value = val;
        recalcMargen();
        markDirty();
      }
    });

    // Familia: es-madre toggle
    const esMadreToggle = ge('ed-es-madre');
    if (esMadreToggle) {
      esMadreToggle.addEventListener('change', () => {
        const checked = esMadreToggle.checked;
        state.producto.es_madre = checked ? 1 : 0;
        if (checked) {
          // Remove this product as a child of any madre
          if (state.producto.producto_madre_id) {
            window.SGA_DB.run(
              'UPDATE productos SET producto_madre_id = NULL, sync_status = \'pending\' WHERE id = ?',
              [state.productoId]
            );
            state.producto.producto_madre_id = null;
          }
          window.SGA_DB.run(
            'UPDATE productos SET es_madre = 1, sync_status = \'pending\' WHERE id = ?',
            [state.productoId]
          );
        } else {
          window.SGA_DB.run(
            'UPDATE productos SET es_madre = 0, sync_status = \'pending\' WHERE id = ?',
            [state.productoId]
          );
        }
        renderFamilia();
      });
    }

    // Familia: agregar hijo button
    ge('ed-btn-agregar-hijo') && ge('ed-btn-agregar-hijo').addEventListener('click', () => {
      openAgregarHijoModal();
    });

    // Sustitutos — predictive search
    const sustitutoSearch = ge('ed-sustituto-search');
    if (sustitutoSearch) {
      sustitutoSearch.addEventListener('input', () => {
        renderSustitutoDropdown(sustitutoSearch.value.trim());
      });
      sustitutoSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          sustitutoSearch.value = '';
          const dd = ge('ed-sustituto-dropdown');
          if (dd) dd.style.display = 'none';
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const q = sustitutoSearch.value.trim();
          // Barcode scanner: mostly digits → search by exact barcode and auto-select
          if (/^\d{6,}$/.test(q)) {
            const hit = window.SGA_DB.query(
              'SELECT p.id FROM productos p JOIN codigos_barras cb ON cb.producto_id = p.id WHERE cb.codigo = ? AND p.activo = 1 LIMIT 1',
              [q]
            );
            if (hit.length) {
              addSustituto(hit[0].id);
              sustitutoSearch.value = '';
              const dd = ge('ed-sustituto-dropdown');
              if (dd) dd.style.display = 'none';
            }
          }
        }
      });
      document.addEventListener('click', (e) => {
        if (!sustitutoSearch.contains(e.target)) {
          const dd = ge('ed-sustituto-dropdown');
          if (dd) dd.style.display = 'none';
        }
      });
    }

    // Transacciones ledger
    ge('ed-btn-tx-filtrar') && ge('ed-btn-tx-filtrar').addEventListener('click', loadLedger);
    ge('ed-btn-registrar-movimiento') && ge('ed-btn-registrar-movimiento').addEventListener('click', openRegistrarMovimientoModal);

    // Vencimientos toggle
    ge('ed-tiene-vencimiento') && ge('ed-tiene-vencimiento').addEventListener('change', () => {
      const panel = ge('ed-vencimientos-panel');
      if (panel) panel.style.display = ge('ed-tiene-vencimiento').checked ? '' : 'none';
    });

    // Imagen
    ge('ed-btn-imagen-upload') && ge('ed-btn-imagen-upload').addEventListener('click', () => {
      const f = ge('ed-imagen-file');
      if (f) f.click();
    });
    ge('ed-imagen-file') && ge('ed-imagen-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.imagenBase64 = ev.target.result;
        state.imagenDeleted = false;
        const preview = ge('ed-imagen-preview');
        if (preview) preview.innerHTML = `<img src="${state.imagenBase64}" alt="Imagen" style="width:100%;height:100%;object-fit:cover">`;
        const delBtn = ge('ed-btn-imagen-delete');
        if (delBtn) delBtn.style.display = '';
        markDirty();
      };
      reader.readAsDataURL(file);
    });
    ge('ed-btn-imagen-delete') && ge('ed-btn-imagen-delete').addEventListener('click', () => {
      state.imagenBase64 = null;
      state.imagenDeleted = true;
      const preview = ge('ed-imagen-preview');
      if (preview) preview.innerHTML = '<span class="ed-text-muted">Sin imagen</span>';
      const delBtn = ge('ed-btn-imagen-delete');
      if (delBtn) delBtn.style.display = 'none';
      markDirty();
    });
  };

  // ── BARCODE HELPERS ────────────────────────────────────────────────────────

  const addBarcode = () => {
    const input  = ge('ed-barcode-input');
    const codigo = input && input.value.trim();
    if (!codigo) return;

    if (state.barcodes.some(b => b.codigo === codigo)) {
      alert('Este código ya está asignado a este producto');
      return;
    }

    const existing = window.SGA_DB.query(
      'SELECT producto_id FROM codigos_barras WHERE codigo = ?', [codigo]
    );
    if (existing.length && existing[0].producto_id !== state.productoId) {
      alert('Este código ya está asignado a otro producto');
      return;
    }

    state.barcodes.push({
      id: 'new-' + Date.now(),
      codigo,
      es_principal: state.barcodes.length === 0 ? 1 : 0,
      isNew: true,
    });
    if (input) input.value = '';
    markDirty();
    renderBarcodes();
  };

  // ── PRICE CALCULATOR ───────────────────────────────────────────────────────

  const recalcMargen = () => {
    const costo  = parseFloat((ge('ed-costo') || {}).value) || 0;
    const precio = parseFloat((ge('ed-precio-venta') || {}).value) || 0;
    const margen = precio > 0 ? ((precio - costo) / precio * 100).toFixed(2) : '0.00';
    const markup = costo  > 0 ? (precio / costo).toFixed(2) : '0.00';
    const elMargen = ge('ed-margen');
    if (elMargen) elMargen.value = margen;
    const elMarkup = ge('ed-markup');
    if (elMarkup) elMarkup.value = markup;
    recalcPrecioSugerido();
  };

  const recalcFromMargen = () => {
    const costo  = parseFloat((ge('ed-costo') || {}).value) || 0;
    const margen = parseFloat((ge('ed-margen') || {}).value);
    if (isNaN(margen) || margen >= 100 || margen < 0) return;
    const nuevoPrecio = costo > 0 ? costo / (1 - margen / 100) : 0;
    const elPrecio = ge('ed-precio-venta');
    const elMarkup = ge('ed-markup');
    if (elPrecio) elPrecio.value = nuevoPrecio.toFixed(2);
    if (elMarkup) elMarkup.value = costo > 0 ? (nuevoPrecio / costo).toFixed(2) : '0.00';
    recalcPrecioSugerido();
    markDirty();
  };

  const recalcFromMarkup = () => {
    const costo  = parseFloat((ge('ed-costo') || {}).value) || 0;
    const markup = parseFloat((ge('ed-markup') || {}).value);
    if (isNaN(markup) || markup <= 0) return;
    const nuevoPrecio = costo * markup;
    const elPrecio = ge('ed-precio-venta');
    const elMargen = ge('ed-margen');
    if (elPrecio) elPrecio.value = nuevoPrecio.toFixed(2);
    if (elMargen) elMargen.value = nuevoPrecio > 0 ? ((nuevoPrecio - costo) / nuevoPrecio * 100).toFixed(2) : '0.00';
    recalcPrecioSugerido();
    markDirty();
  };

  const recalcPrecioSugerido = () => {
    const costo    = parseFloat((ge('ed-costo') || {}).value) || 0;
    const el       = ge('ed-precio-sugerido');
    if (!el) return;
    const calcMode = document.querySelector('input[name="ed-calc-mode"]:checked');
    const modeVal  = calcMode ? calcMode.value : 'margen';
    const valor    = parseFloat((ge('ed-calc-valor') || {}).value);
    if (modeVal === 'margen') {
      el.value = (!isNaN(valor) && valor >= 0 && valor < 100 && costo > 0)
        ? (costo / (1 - valor / 100)).toFixed(2) : '';
    } else {
      el.value = (!isNaN(valor) && valor > 0 && costo > 0)
        ? (costo * valor).toFixed(2) : '';
    }
  };

  // ── SAVE ALL ───────────────────────────────────────────────────────────────

  const saveAll = () => {
    const nombre = (ge('ed-nombre') || {}).value && ge('ed-nombre').value.trim();
    if (!nombre) { alert('El nombre es obligatorio'); return; }

    const now = window.SGA_Utils.formatISODate(new Date());
    const imagen = state.imagenDeleted ? null
      : (state.imagenBase64 || state.producto.imagen || null);

    const stockAlerta        = parseFloat((ge('ed-stock-alerta')             || {}).value) || 0;
    const cantPedido         = parseFloat((ge('ed-cant-pedido')              || {}).value) || 0;
    const uppRaw             = (ge('ed-pedido-unidades-paquete') || {}).value;
    const unidadesPorPaquete = uppRaw !== '' ? (parseFloat(uppRaw) || null) : null;

    window.SGA_DB.run(`
      UPDATE productos SET
        nombre = ?, descripcion = ?,
        categoria_id = ?, proveedor_principal_id = ?, proveedor_alternativo_id = ?,
        unidad_medida = ?,
        costo = ?, precio_venta = ?,
        stock_minimo = ?, stock_alerta = ?, cant_pedido = ?, pedido_unidad = ?, pedido_unidades_por_paquete = ?,
        activo = ?,
        es_madre = ?, producto_madre_id = ?, precio_independiente = ?,
        imagen = ?,
        fecha_modificacion = ?, sync_status = 'pending', updated_at = ?
      WHERE id = ?
    `, [
      nombre,
      (ge('ed-descripcion') || {}).value || '',
      (ge('ed-categoria') || {}).value || null,
      (ge('ed-proveedor-principal') || {}).value || null,
      (ge('ed-proveedor-alternativo') || {}).value || null,
      (ge('ed-unidad') || {}).value || 'unidad',
      parseFloat((ge('ed-costo') || {}).value) || 0,
      parseFloat((ge('ed-precio-venta') || {}).value) || 0,
      stockAlerta,   // keep stock_minimo in sync for backward compat
      stockAlerta,
      cantPedido,
      (ge('ed-pedido-unidad') || {}).value || 'unidad',
      unidadesPorPaquete,
      (ge('ed-activo') || {}).checked ? 1 : 0,
      state.producto.es_madre ? 1 : 0,
      state.producto.es_madre ? null : (state.producto.producto_madre_id || null),
      (ge('ed-precio-independiente') || {}).checked ? 1 : 0,
      imagen,
      now, now,
      state.productoId,
    ]);

    // Save barcodes: delete removed
    state.barcodesDeleted.forEach(id => {
      window.SGA_DB.run('DELETE FROM codigos_barras WHERE id = ?', [id]);
    });
    state.barcodesDeleted = [];

    // Insert new barcodes
    state.barcodes.forEach(bc => {
      if (bc.isNew) {
        window.SGA_DB.run(
          'INSERT OR IGNORE INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES (?, ?, ?, ?)',
          [window.SGA_Utils.generateUUID(), state.productoId, bc.codigo, bc.es_principal]
        );
        bc.isNew = false;
      }
    });

    // Update in-memory state
    state.producto = Object.assign({}, state.producto, { nombre, imagen });

    // Update header and sidebar name
    const headerNombre = ge('ed-header-nombre');
    if (headerNombre) headerNombre.textContent = nombre;
    const asideNombre = ge('ed-aside-nombre');
    if (asideNombre) asideNombre.textContent = nombre;

    state.dirty = false;
    showToast('✅ Cambios guardados');
  };

  const handleCancel = () => {
    if (state.dirty && !confirm('¿Descartar los cambios sin guardar?')) return;
    window.location.hash = '#productos';
  };

  // ── HELPERS ────────────────────────────────────────────────────────────────

  const markDirty = () => { state.dirty = true; };

  const showToast = (msg) => {
    const toast = document.createElement('div');
    toast.className = 'ed-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3000);
  };

  return { init };
})();

export default EditorProducto;
