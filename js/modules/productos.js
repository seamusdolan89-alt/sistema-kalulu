const Productos = (() => {
  'use strict';


  const state = {
    productos: [],
    categorias: [],
    proveedores: [],
    sustitutos: [],
    page: 1,
    perPage: 12,
    totalPages: 1,
    filters: {
      query: '',
      categoria: '',
      soloMadres: false,
      activo: '',
      // advanced filters
      proveedor: '',
      tipo: '',
      precioMin: null,
      precioMax: null,
      costoMin: null,
      costoMax: null,
      margenMin: null,
      margenMax: null,
      stockMin: null,
      stockMax: null,
      soloBajoMinimo: false
    },
    sort: { field: 'nombre', dir: 'asc' },
    editingProduct: null,
    barcodes: [],
    substitutes: []
  };


  const formatCurrency = (value) => {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 }).format(value);
  };


  const getElement = (id) => document.getElementById(id);


  const loadCategorias = () => {
    try {
      state.categorias = window.SGA_DB.query('SELECT id, nombre FROM categorias ORDER BY nombre');
    } catch (error) {
      console.warn('No hay tabla categorias:', error.message);
      state.categorias = [];
    }


    const filterCategoria = getElement('filter-categoria');
    const productCategoria = getElement('product-categoria');
    if (!filterCategoria || !productCategoria) return;


    const createOption = (cat) => `<option value="${cat.id}">${cat.nombre}</option>`;


    filterCategoria.innerHTML = '<option value="">Todas las categorías</option>' + state.categorias.map(createOption).join('');
    productCategoria.innerHTML = '<option value="">-- Seleccionar --</option>' + state.categorias.map(createOption).join('');
  };


  const loadProveedores = () => {
    try {
      state.proveedores = window.SGA_DB.query('SELECT id, razon_social FROM proveedores WHERE activo = 1 ORDER BY razon_social');
    } catch (error) {
      console.warn('No hay tabla proveedores:', error.message);
      state.proveedores = [];
    }


    const prin = getElement('product-proveedor-principal');
    const alt = getElement('product-proveedor-alternativo');


    if (!prin || !alt) return;
    const option = (p) => `<option value="${p.id}">${p.razon_social}</option>`;
    prin.innerHTML = '<option value="">-- Seleccionar --</option>' + state.proveedores.map(option).join('');
    alt.innerHTML = '<option value="">-- Seleccionar --</option>' + state.proveedores.map(option).join('');
  };


  const loadProductos = () => {
    try {
      const currentUser = window.SGA_Auth.getCurrentUser();
      const sucursal_id = currentUser?.sucursal_id || '1';
      state.productos = window.SGA_DB.query(`
        SELECT p.*,
          cb.codigo AS codigo_barras,
          cat.nombre AS categoria_nombre,
          prov.razon_social AS proveedor_nombre,
          COALESCE(st.cantidad, 0) AS stock_actual
        FROM productos p
        LEFT JOIN codigos_barras cb ON cb.producto_id = p.id AND cb.es_principal = 1
        LEFT JOIN categorias cat ON cat.id = p.categoria_id
        LEFT JOIN proveedores prov ON prov.id = p.proveedor_principal_id
        LEFT JOIN stock st ON st.producto_id = p.id AND st.sucursal_id = ?
        ORDER BY p.nombre
      `, [sucursal_id]);
    } catch (error) {
      console.warn('Error cargando productos:', error.message);
      state.productos = [];
    }
    applyFilters();
  };


  const updateSortHeaders = () => {
    document.querySelectorAll('.productos-table thead th[data-sort]').forEach(th => {
      th.classList.remove('sort-active', 'sort-desc');
      if (th.dataset.sort === state.sort.field) {
        th.classList.add('sort-active');
        if (state.sort.dir === 'desc') th.classList.add('sort-desc');
      }
    });
  };

  const applyFilters = () => {
    let filtered = [...state.productos];


    const q = state.filters.query.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(p =>
        (p.nombre || '').toLowerCase().includes(q) ||
        (p.codigo_barras || '').toLowerCase().includes(q)
      );
    }


    if (state.filters.categoria) {
      filtered = filtered.filter(p => String(p.categoria_id) === String(state.filters.categoria));
    }


    if (state.filters.soloMadres) {
      filtered = filtered.filter(p => p.es_madre === 1 || p.es_madre === '1');
    }


    if (state.filters.activo !== '') {
      filtered = filtered.filter(p => String(p.activo) === String(state.filters.activo));
    }

    if (state.filters.proveedor) {
      filtered = filtered.filter(p => String(p.proveedor_principal_id) === String(state.filters.proveedor));
    }

    if (state.filters.tipo) {
      filtered = filtered.filter(p => {
        const esMadre = p.es_madre === 1 || p.es_madre === '1';
        const esHijo  = !!p.producto_madre_id;
        if (state.filters.tipo === 'madre') return esMadre;
        if (state.filters.tipo === 'hijo')  return esHijo;
        return !esMadre && !esHijo;
      });
    }

    if (state.filters.precioMin != null) filtered = filtered.filter(p => (p.precio_venta || 0) >= state.filters.precioMin);
    if (state.filters.precioMax != null) filtered = filtered.filter(p => (p.precio_venta || 0) <= state.filters.precioMax);
    if (state.filters.costoMin  != null) filtered = filtered.filter(p => (p.costo || 0) >= state.filters.costoMin);
    if (state.filters.costoMax  != null) filtered = filtered.filter(p => (p.costo || 0) <= state.filters.costoMax);
    if (state.filters.margenMin != null || state.filters.margenMax != null) {
      filtered = filtered.filter(p => {
        const margen = p.precio_venta > 0 ? (p.precio_venta - p.costo) / p.precio_venta * 100 : 0;
        if (state.filters.margenMin != null && margen < state.filters.margenMin) return false;
        if (state.filters.margenMax != null && margen > state.filters.margenMax) return false;
        return true;
      });
    }
    if (state.filters.stockMin != null) filtered = filtered.filter(p => (p.stock_actual || 0) >= state.filters.stockMin);
    if (state.filters.stockMax != null) filtered = filtered.filter(p => (p.stock_actual || 0) <= state.filters.stockMax);
    if (state.filters.soloBajoMinimo) {
      filtered = filtered.filter(p => (p.stock_actual || 0) < (p.stock_minimo || 0));
    }

    const total = filtered.length;
    state.totalPages = Math.max(1, Math.ceil(total / state.perPage));
    if (state.page > state.totalPages) state.page = state.totalPages;


    // Sort
    const { field, dir } = state.sort;
    filtered.sort((a, b) => {
      let av, bv;
      if (field === 'margen') {
        av = a.precio_venta > 0 ? (a.precio_venta - a.costo) / a.precio_venta * 100 : 0;
        bv = b.precio_venta > 0 ? (b.precio_venta - b.costo) / b.precio_venta * 100 : 0;
      } else if (field === 'familia') {
        av = a.es_madre === 1 || a.es_madre === '1' ? 'Madre' : (a.producto_madre_id ? 'Hijo' : 'Independiente');
        bv = b.es_madre === 1 || b.es_madre === '1' ? 'Madre' : (b.producto_madre_id ? 'Hijo' : 'Independiente');
      } else {
        av = a[field] ?? '';
        bv = b[field] ?? '';
      }
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      av = String(av).toLowerCase();
      bv = String(bv).toLowerCase();
      return dir === 'asc' ? av.localeCompare(bv, 'es') : bv.localeCompare(av, 'es');
    });

    const from = (state.page - 1) * state.perPage;
    const to = from + state.perPage;
    const pageItems = filtered.slice(from, to);

    renderProductosTable(pageItems, total);
    updateSortHeaders();
  };


  const renderProductosTable = (items, total) => {
    const tbody = getElement('productos-tbody');
    const info = getElement('pagination-info');


    if (!tbody) return;


    tbody.innerHTML = items.map(producto => {
      const categoria = producto.categoria_nombre || '-';
      const stock = producto.stock_actual != null ? producto.stock_actual : 0;
      const margen = producto.precio_venta > 0 ? ((producto.precio_venta - producto.costo) / producto.precio_venta * 100).toFixed(2) : '0.00';
      const familia = producto.es_madre === 1 || producto.es_madre === '1' ? 'Madre' : (producto.producto_madre_id ? 'Hijo' : 'Independiente');
      return `
        <tr data-id="${producto.id}">
          <td>${producto.codigo_barras || ''}</td>
          <td>${producto.nombre || ''}</td>
          <td>${categoria}</td>
          <td>${formatCurrency(producto.costo || 0)}</td>
          <td>${formatCurrency(producto.precio_venta || 0)}</td>
          <td>${margen}%</td>
          <td>${stock}</td>
          <td>${producto.stock_minimo || 0}</td>
          <td>${familia}</td>
          <td>
            <button data-id="${producto.id}" class="btn btn-small btn-secondary btn-edit-product">✏️</button>
            <button data-id="${producto.id}" class="btn btn-small btn-danger btn-delete-product">🗑️</button>
          </td>
        </tr>
      `;
    }).join('');


    if (info) {
      info.textContent = `Página ${state.page} de ${state.totalPages} (Total ${total})`;
    }


    attachTableActions();
  };


  const attachTableActions = () => {
    document.querySelectorAll('.btn-edit-product').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(btn.dataset.id);
      });
    });


    document.querySelectorAll('.btn-delete-product').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm('¿Seguro que desea eliminar este producto?')) return;


        try {
          window.SGA_DB.run('DELETE FROM productos WHERE id = ?', [id]);
          loadProductos();
        } catch (error) {
          alert('Error al eliminar producto: ' + error.message);
        }
      });
    });
  };


  // ── EDIT PRODUCT — navigate to full-page editor ───────────────────────────

  const openEditModal = (productId) => {
    window.location.hash = `#editor-producto/${productId}`;
  };

  const closeEditModal = () => {
    getElement('edit-modal').classList.add('hidden');
    getElement('modal-backdrop').classList.add('hidden');
    state.editingProduct = null;
  };

  const saveEditModal = () => {
    if (!state.editingProduct) return;
    const nombre = getElement('edit-nombre').value.trim();
    if (!nombre) { alert('El nombre es obligatorio'); return; }

    const now = window.SGA_Utils.formatISODate(new Date());
    window.SGA_DB.run(`
      UPDATE productos SET
        nombre = ?, categoria_id = ?, proveedor_principal_id = ?,
        costo = ?, precio_venta = ?, stock_minimo = ?, activo = ?,
        fecha_modificacion = ?, sync_status = 'pending', updated_at = ?
      WHERE id = ?
    `, [
      nombre,
      getElement('edit-categoria').value || null,
      getElement('edit-proveedor').value || null,
      parseFloat(getElement('edit-costo').value) || 0,
      parseFloat(getElement('edit-precio_venta').value) || 0,
      parseFloat(getElement('edit-stock_minimo').value) || 0,
      getElement('edit-activo').checked ? 1 : 0,
      now, now,
      state.editingProduct.id
    ]);

    const newBarcode = getElement('edit-codigo_barras').value.trim();
    const oldBarcode = state.editingProduct.codigo_barras;
    if (newBarcode !== oldBarcode) {
      if (oldBarcode) {
        window.SGA_DB.run('DELETE FROM codigos_barras WHERE producto_id = ? AND es_principal = 1', [state.editingProduct.id]);
      }
      if (newBarcode) {
        const exists = window.SGA_DB.query('SELECT 1 FROM codigos_barras WHERE codigo = ? AND producto_id != ?', [newBarcode, state.editingProduct.id]);
        if (!exists.length) {
          window.SGA_DB.run(
            'INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES (?, ?, ?, 1)',
            [window.SGA_Utils.generateUUID(), state.editingProduct.id, newBarcode]
          );
        }
      }
    }

    closeEditModal();
    loadProductos();
  };

  const openProductModal = (producto = null) => {
    state.editingProduct = producto;
    state.barcodes = (producto && producto.codigos_barras) ? [...producto.codigos_barras] : [];
    state.substitutes = (producto && producto.sustitutos) ? [...producto.sustitutos] : [];


    getElement('modal-title').textContent = producto ? 'Editar Producto' : 'Nuevo Producto';
    getElement('product-nombre').value = producto?.nombre || '';
    getElement('product-descripcion').value = producto?.descripcion || '';
    getElement('product-costo').value = producto?.costo ?? 0;
    getElement('product-precio').value = producto?.precio_venta ?? 0;
    getElement('product-margen').value = producto ? ((producto.precio_venta > 0) ? (((producto.precio_venta - producto.costo)/producto.precio_venta*100).toFixed(2)) : '0.00') : '0.00';
    getElement('product-stock-minimo').value = producto?.stock_minimo ?? 0;


    const checkedType = producto ? (producto.es_madre ? 'madre' : (producto.producto_madre_id ? 'hijo' : 'independiente')) : 'independiente';
    document.querySelectorAll('input[name="product-type"]').forEach(r => { r.checked = (r.value === checkedType); });


    getElement('product-categoria').value = producto?.categoria_id || '';
    getElement('product-unidad').value = producto?.unidad_medida || 'unidad';
    getElement('product-proveedor-principal').value = producto?.proveedor_principal_id || '';
    getElement('product-proveedor-alternativo').value = producto?.proveedor_alternativo_id || '';


    getElement('barcodes-list').innerHTML = state.barcodes.map(c => `<div>${c}</div>`).join('');
    getElement('sustitutos-list').innerHTML = state.substitutes.map(s => `<div>${s}</div>`).join('');


    // reset steps
    goToStep(1);
    getElement('product-modal').classList.remove('hidden');
  };


  const closeProductModal = () => {
    getElement('product-modal').classList.add('hidden');
    state.editingProduct = null;
    state.barcodes = [];
    state.substitutes = [];
  };


  const goToStep = (step) => {
    for (let i = 1; i <= 5; i++) {
      const stepEl = getElement(`step${i}`);
      if (!stepEl) continue;
      stepEl.classList.toggle('hidden', i !== step);
      stepEl.classList.toggle('active', i === step);
    }
  };


  const calculateMargin = () => {
    const costo = parseFloat(getElement('product-costo').value) || 0;
    const precio = parseFloat(getElement('product-precio').value) || 0;
    if (precio > 0) {
      getElement('product-margen').value = (((precio - costo) / precio) * 100).toFixed(2);
    } else {
      getElement('product-margen').value = '0.00';
    }
  };


  const saveProduct = () => {
    const nombre = getElement('product-nombre').value.trim();
    if (!nombre) {
      alert('El nombre es obligatorio');
      return;
    }


    const prod = {
      id: state.editingProduct ? state.editingProduct.id : window.SGA_Utils.generateUUID(),
      nombre,
      descripcion: getElement('product-descripcion').value.trim(),
      categoria_id: getElement('product-categoria').value || null,
      proveedor_principal_id: getElement('product-proveedor-principal').value || null,
      proveedor_alternativo_id: getElement('product-proveedor-alternativo').value || null,
      unidad_medida: getElement('product-unidad').value || 'unidad',
      costo: parseFloat(getElement('product-costo').value) || 0,
      precio_venta: parseFloat(getElement('product-precio').value) || 0,
      stock_minimo: parseFloat(getElement('product-stock-minimo').value) || 0,
      es_madre: document.querySelector('input[name="product-type"]:checked')?.value === 'madre' ? 1 : 0,
      producto_madre_id: document.querySelector('input[name="product-type"]:checked')?.value === 'hijo' ? (getElement('select-madre')?.value || null) : null,
      precio_independiente: document.getElementById('precio-independiente')?.checked ? 1 : 0,
      fecha_modificacion: window.SGA_Utils.formatISODate(new Date()),
      fecha_alta: state.editingProduct ? state.editingProduct.fecha_alta : window.SGA_Utils.formatISODate(new Date()),
      activo: 1,
      sync_status: 'pending',
      updated_at: window.SGA_Utils.formatISODate(new Date())
    };


    const existe = state.productos.find(p => p.id === prod.id);


    try {
      if (existe) {
        window.SGA_DB.run(`
          UPDATE productos SET
            nombre = ?, descripcion = ?, categoria_id = ?, proveedor_principal_id = ?,
            proveedor_alternativo_id = ?, unidad_medida = ?, costo = ?, precio_venta = ?,
            stock_minimo = ?, es_madre = ?, producto_madre_id = ?, precio_independiente = ?,
            fecha_modificacion = ?, sync_status = ?, updated_at = ?, activo = ?
          WHERE id = ?
        `,[
          prod.nombre, prod.descripcion, prod.categoria_id, prod.proveedor_principal_id,
          prod.proveedor_alternativo_id, prod.unidad_medida, prod.costo, prod.precio_venta,
          prod.stock_minimo, prod.es_madre, prod.producto_madre_id, prod.precio_independiente,
          prod.fecha_modificacion, prod.sync_status, prod.updated_at, prod.activo,
          prod.id
        ]);
      } else {
        window.SGA_DB.run(`
          INSERT INTO productos (
            id, nombre, descripcion, categoria_id, proveedor_principal_id,
            proveedor_alternativo_id, unidad_medida, costo, precio_venta,
            stock_minimo, es_madre, producto_madre_id, precio_independiente,
            fecha_alta, fecha_modificacion, activo, sync_status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          prod.id, prod.nombre, prod.descripcion, prod.categoria_id, prod.proveedor_principal_id,
          prod.proveedor_alternativo_id, prod.unidad_medida, prod.costo, prod.precio_venta,
          prod.stock_minimo, prod.es_madre, prod.producto_madre_id, prod.precio_independiente,
          prod.fecha_alta, prod.fecha_modificacion, prod.activo, prod.sync_status, prod.updated_at
        ]);
      }


      closeProductModal();
      loadProductos();
      alert('Producto guardado correctamente');
    } catch (error) {
      console.error('Error guardando producto:', error);
      alert('Error guardando producto: ' + error.message);
    }
  };


  const updateMadreSelector = () => {
    const cont = getElement('madre-selector-container');
    const selected = document.querySelector('input[name="product-type"]:checked')?.value;
    if (selected === 'hijo') {
      cont.classList.remove('hidden');
    } else {
      cont.classList.add('hidden');
    }
  };


  const populateMadres = () => {
    const madres = state.productos.filter(p => p.es_madre === 1 || p.es_madre === '1');
    const select = getElement('select-madre');
    if (!select) return;
    select.innerHTML = '<option value="">-- Seleccionar --</option>' + madres.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
  };


  // ── EXPORT TEMPLATE ───────────────────────────────────────────────────────

  const downloadTemplate = () => {
    const headers = [
      'codigo_barras', 'nombre', 'costo', 'precio_venta',
      'stock_actual', 'stock_minimo', 'categoria', 'proveedor', 'codigo_sustituto'
    ];
    const colFormats = {
      0: { t: 's', z: '@' },
      1: { t: 's', z: '@' },
      2: { t: 'n', z: '#,##0.00' },
      3: { t: 'n', z: '#,##0.00' },
      4: { t: 'n', z: '0' },
      5: { t: 'n', z: '0' },
      6: { t: 's', z: '@' },
      7: { t: 's', z: '@' },
      8: { t: 's', z: '@' },
    };

    let dataRows;
    let filename;
    if (state.productos.length > 0) {
      dataRows = state.productos.map(p => [
        p.codigo_barras || '',
        p.nombre || '',
        p.costo || 0,
        p.precio_venta || 0,
        p.stock_actual || 0,
        p.stock_minimo || 0,
        p.categoria_nombre || '',
        p.proveedor_nombre || '',
        ''
      ]);
      filename = 'productos_exportados.xlsx';
    } else {
      dataRows = [['7790001234567', 'Coca Cola 500ml', 350, 550, 24, 6, 'Bebidas', 'Pepsico SA', '']];
      filename = 'plantilla_productos.xlsx';
    }

    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let row = 1; row <= range.e.r; row++) {
      Object.keys(colFormats).forEach(c => {
        const cell = ws[XLSX.utils.encode_cell({ r: row, c: Number(c) })];
        if (cell) { cell.t = colFormats[c].t; cell.z = colFormats[c].z; }
      });
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    XLSX.writeFile(wb, filename);
  };

  // ── IMPORT EXCEL ──────────────────────────────────────────────────────────

  let importData = {
    workbook: null,
    worksheet: null,
    columns: [],
    rows: [],
    mapping: {}
  };

  const openImportModal = () => {
    resetImportModal();
    getElement('import-modal').classList.remove('hidden');
    getElement('modal-backdrop').classList.remove('hidden');
  };

  const hideImportModal = () => {
    getElement('import-modal').classList.add('hidden');
    getElement('modal-backdrop').classList.add('hidden');
  };

  const resetImportModal = () => {
    importData = { workbook: null, worksheet: null, columns: [], rows: [], mapping: {} };
    goToImportStep(1);
    getElement('file-preview').classList.add('hidden');
    getElement('file-name').textContent = '';
    getElement('preview-table').innerHTML = '';
    getElement('btn-import-next1').disabled = true;
    document.querySelectorAll('.mapping-select').forEach(s => {
      s.innerHTML = '<option value="">-- Seleccionar --</option>';
    });
    getElement('preview-count').textContent = '0';
    getElement('confirm-table').innerHTML = '';
    getElement('update-existing').checked = true;
    getElement('create-categories').checked = true;
    getElement('create-providers').checked = true;
    getElement('import-summary').innerHTML = '';
  };

  const handleFileSelect = (file) => {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      alert('Por favor selecciona un archivo Excel (.xlsx o .xls)');
      return;
    }
    getElement('file-name').textContent = file.name;
    getElement('file-preview').classList.remove('hidden');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        importData.workbook = XLSX.read(e.target.result, { type: 'array' });
        const sheetName = importData.workbook.SheetNames[0];
        importData.worksheet = importData.workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(importData.worksheet, { header: 1 });
        if (jsonData.length < 2) {
          alert('El archivo debe tener al menos una fila de encabezados y una fila de datos');
          return;
        }
        importData.columns = jsonData[0].map(col => String(col || '').trim());
        const textCols = new Set(['codigo_barras', 'nombre', 'categoria', 'proveedor', 'codigo_sustituto']);
        const numCols  = new Set(['costo', 'precio_venta', 'stock_actual', 'stock_minimo']);
        importData.rows = jsonData.slice(1)
          .filter(row => row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== ''))
          .map(row => {
            const obj = {};
            importData.columns.forEach((col, idx) => {
              const val = row[idx] ?? '';
              if (textCols.has(col))     obj[col] = typeof val === 'number' ? String(Math.round(val)) : String(val).trim();
              else if (numCols.has(col)) obj[col] = parseFloat(val) || 0;
              else                       obj[col] = val;
            });
            return obj;
          });
        showFilePreview();
        getElement('btn-import-next1').disabled = false;
      } catch (error) {
        alert('Error al leer el archivo: ' + error.message);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const showFilePreview = () => {
    const table = getElement('preview-table');
    const previewRows = importData.rows.slice(0, 5);
    let html = '<thead><tr>';
    importData.columns.forEach(col => { html += '<th>' + col + '</th>'; });
    html += '</tr></thead><tbody>';
    previewRows.forEach(row => {
      html += '<tr>';
      importData.columns.forEach(col => { html += '<td>' + String(row[col] || '').substring(0, 50) + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
  };

  const goToImportStep = (step) => {
    if (step === 2) {
      setupColumnMapping();
    } else if (step === 3) {
      if (!validateMapping()) {
        alert('Debes mapear al menos los campos obligatorios: Codigo de barras y Nombre');
        return;
      }
      showPreview();
    }
    document.querySelectorAll('#import-modal .modal-step').forEach(s => s.classList.remove('active'));
    getElement('import-step' + step).classList.add('active');
  };

  const setupColumnMapping = () => {
    document.querySelectorAll('.mapping-select').forEach(select => {
      select.innerHTML = '<option value="">-- Seleccionar --</option>';
      importData.columns.forEach(col => { select.appendChild(new Option(col, col)); });
    });
    const autoMappings = {
      'codigo_barras': ['codigo', 'cod', 'barras', 'ean', 'codigo barras'],
      'nombre': ['nombre', 'descripcion', 'producto', 'articulo'],
      'costo': ['costo', 'precio costo', 'p.costo', 'costo unitario'],
      'precio_venta': ['precio', 'precio venta', 'p.venta', 'precio final', 'venta'],
      'stock_actual': ['stock', 'cantidad', 'existencia', 'inventario'],
      'stock_minimo': ['minimo', 'stock min', 'min', 'stock minimo'],
      'categoria': ['categoria', 'rubro', 'familia', 'tipo'],
      'proveedor': ['proveedor', 'prov', 'fabricante', 'marca'],
      'codigo_sustituto': ['sustituto', 'cod sustituto', 'reemplaza', 'alternativo']
    };
    Object.keys(autoMappings).forEach(field => {
      const select = getElement('map-' + field);
      if (!select) return;
      for (const col of importData.columns) {
        if (autoMappings[field].some(kw => col.toLowerCase().includes(kw))) {
          select.value = col;
          break;
        }
      }
    });
  };

  const validateMapping = () => {
    return ['codigo_barras', 'nombre'].every(field => getElement('map-' + field)?.value);
  };

  const showPreview = () => {
    importData.mapping = {};
    document.querySelectorAll('.mapping-select').forEach(select => {
      const field = select.id.replace('map-', '');
      if (select.value) importData.mapping[field] = select.value;
    });
    const transformedRows = importData.rows.map(row => {
      const transformed = {};
      Object.keys(importData.mapping).forEach(field => {
        transformed[field] = row[importData.mapping[field]] || '';
      });
      return transformed;
    });
    getElement('preview-count').textContent = transformedRows.length;
    const previewRows = transformedRows.slice(0, 10);
    let html = '<thead><tr>';
    Object.keys(importData.mapping).forEach(field => {
      const label = field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      html += '<th>' + label + '</th>';
    });
    html += '</tr></thead><tbody>';
    previewRows.forEach(row => {
      html += '<tr>';
      Object.keys(importData.mapping).forEach(field => {
        html += '<td>' + String(row[field] || '').substring(0, 30) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody>';
    getElement('confirm-table').innerHTML = html;
  };

  // Dry-run: analyze rows against DB without writing anything.
  // Stores transformed filas in importData.filas for use by confirmImport.
  const performImport = () => {
    try {
      const currentUser = window.SGA_Auth.getCurrentUser();
      if (!currentUser || !currentUser.sucursal_id) {
        throw new Error('No se pudo determinar la sucursal actual');
      }

      const filas = importData.rows.map(row => {
        const transformed = {};
        Object.keys(importData.mapping).forEach(field => {
          transformed[field] = row[importData.mapping[field]] ?? '';
        });
        return transformed;
      });
      importData.filas = filas;
      importData.sucursal_id = currentUser.sucursal_id;

      const updateExisting = getElement('update-existing')?.checked !== false;
      const createCats     = getElement('create-categories')?.checked !== false;
      const createProvs    = getElement('create-providers')?.checked !== false;

      const summary = { nuevos: 0, actualizados: 0, ignoradas: 0,
        categoriasNuevas: [], proveedoresNuevos: [], sustitutos: 0 };
      const catSeen  = {};
      const provSeen = {};

      for (const fila of filas) {
        const codigo = String(fila.codigo_barras || '').trim();
        const nombre = String(fila.nombre || '').trim();

        if (!nombre && !codigo) { summary.ignoradas++; continue; }

        if (fila.categoria && createCats) {
          const key = fila.categoria.toLowerCase().trim();
          if (!catSeen[key]) {
            catSeen[key] = true;
            const exists = window.SGA_DB.query('SELECT id FROM categorias WHERE LOWER(nombre) = ?', [key]);
            if (!exists.length) summary.categoriasNuevas.push(fila.categoria.trim());
          }
        }

        if (fila.proveedor && createProvs) {
          const key = fila.proveedor.toLowerCase().trim();
          if (!provSeen[key]) {
            provSeen[key] = true;
            const exists = window.SGA_DB.query('SELECT id FROM proveedores WHERE LOWER(razon_social) = ?', [key]);
            if (!exists.length) summary.proveedoresNuevos.push(fila.proveedor.trim());
          }
        }

        let found = false;
        if (codigo) {
          const cb = window.SGA_DB.query('SELECT 1 FROM codigos_barras WHERE codigo = ?', [codigo]);
          if (cb.length) found = true;
        }
        if (!found && nombre) {
          const pn = window.SGA_DB.query('SELECT 1 FROM productos WHERE LOWER(nombre) = ?', [nombre.toLowerCase()]);
          if (pn.length) found = true;
        }

        if (found) {
          if (updateExisting) summary.actualizados++;
          else summary.ignoradas++;
        } else {
          summary.nuevos++;
        }

        if (String(fila.codigo_sustituto || '').trim()) summary.sustitutos++;
      }

      let html = '';
      html += '<div class="result-item result-success">📦 ' + summary.nuevos + ' producto' + (summary.nuevos !== 1 ? 's' : '') + ' nuevos a importar</div>';
      if (summary.actualizados > 0)
        html += '<div class="result-item result-success">🔄 ' + summary.actualizados + ' producto' + (summary.actualizados !== 1 ? 's' : '') + ' existentes a actualizar</div>';
      if (summary.categoriasNuevas.length > 0)
        html += '<div class="result-item result-info">🏷️ ' + summary.categoriasNuevas.length + ' categoría' + (summary.categoriasNuevas.length !== 1 ? 's' : '') + ' nueva' + (summary.categoriasNuevas.length !== 1 ? 's' : '') + ': ' + summary.categoriasNuevas.join(', ') + '</div>';
      if (summary.proveedoresNuevos.length > 0)
        html += '<div class="result-item result-info">🏢 ' + summary.proveedoresNuevos.length + ' proveedor' + (summary.proveedoresNuevos.length !== 1 ? 'es' : '') + ' nuevo' + (summary.proveedoresNuevos.length !== 1 ? 's' : '') + ': ' + summary.proveedoresNuevos.join(', ') + '</div>';
      if (summary.sustitutos > 0)
        html += '<div class="result-item result-info">🔗 ' + summary.sustitutos + ' sustituto' + (summary.sustitutos !== 1 ? 's' : '') + ' a vincular</div>';
      if (summary.ignoradas > 0)
        html += '<div class="result-item result-warning">⚠️ ' + summary.ignoradas + ' fila' + (summary.ignoradas !== 1 ? 's' : '') + ' omitida' + (summary.ignoradas !== 1 ? 's' : '') + ' (sin código de barras ni nombre)</div>';

      getElement('import-summary').innerHTML = html;
      goToImportStep(4);

    } catch (error) {
      console.error('❌ Analyze error:', error);
      alert('Error al analizar el archivo: ' + error.message);
    }
  };

  // Actually write to DB after user confirms in step 4
  const confirmImport = () => {
    const btn = getElement('btn-import-do-confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
    try {
      const results = importarDesdeExcel(importData.filas, importData.sucursal_id);
      console.log('✅ Import confirmed:', results);
      hideImportModal();
      loadProductos();
    } catch (error) {
      window.SGA_DB.rollbackBatch();
      console.error('❌ Confirm error:', error);
      alert('Error al guardar: ' + error.message);
      if (btn) { btn.disabled = false; btn.textContent = '✓ Confirmar importación'; }
    }
  };

  // ── IMPORT ENGINE ─────────────────────────────────────────────────────────

  const importarDesdeExcel = (filas, sucursal_id) => {
    console.log('🔄 Importing', filas.length, 'rows for sucursal', sucursal_id);
    window.SGA_DB.beginBatch();
    const updateExisting  = getElement('update-existing')?.checked !== false;
    const createCats      = getElement('create-categories')?.checked !== false;
    const createProvs     = getElement('create-providers')?.checked !== false;

    const results = {
      importados: 0,
      actualizados: 0,
      categoriasCreadas: [],
      proveedoresCreados: [],
      sustitutosResueltos: 0,
      sustitutosPendientes: [],
      errores: []
    };

    const now = window.SGA_Utils.formatISODate(new Date());

    // Cache lookups to avoid repeated queries within the same import
    const catCache  = {};
    const provCache = {};

    const getOrCreateCategoria = (nombre) => {
      if (!nombre) return null;
      const key = nombre.toLowerCase().trim();
      if (catCache[key] !== undefined) return catCache[key];
      const rows = window.SGA_DB.query('SELECT id FROM categorias WHERE LOWER(nombre) = ?', [key]);
      if (rows.length) { catCache[key] = rows[0].id; return rows[0].id; }
      if (!createCats) { catCache[key] = null; return null; }
      const id = window.SGA_Utils.generateUUID();
      window.SGA_DB.run(
        'INSERT INTO categorias (id, nombre, sync_status, updated_at) VALUES (?, ?, ?, ?)',
        [id, nombre.trim(), 'pending', now]
      );
      catCache[key] = id;
      results.categoriasCreadas.push(nombre.trim());
      return id;
    };

    const getOrCreateProveedor = (nombre) => {
      if (!nombre) return null;
      const key = nombre.toLowerCase().trim();
      if (provCache[key] !== undefined) return provCache[key];
      const rows = window.SGA_DB.query('SELECT id FROM proveedores WHERE LOWER(razon_social) = ?', [key]);
      if (rows.length) { provCache[key] = rows[0].id; return rows[0].id; }
      if (!createProvs) { provCache[key] = null; return null; }
      const id = window.SGA_Utils.generateUUID();
      window.SGA_DB.run(
        'INSERT INTO proveedores (id, razon_social, activo, sync_status, updated_at) VALUES (?, ?, 1, ?, ?)',
        [id, nombre.trim(), 'pending', now]
      );
      provCache[key] = id;
      results.proveedoresCreados.push(nombre.trim());
      return id;
    };

    for (const fila of filas) {
      const codigo  = String(fila.codigo_barras || '').trim();
      const nombre  = String(fila.nombre || '').trim();

      if (!nombre && !codigo) continue;

      try {
        const categoria_id   = getOrCreateCategoria(fila.categoria);
        const proveedor_id   = getOrCreateProveedor(fila.proveedor);
        const costo          = parseFloat(fila.costo)        || 0;
        const precio_venta   = parseFloat(fila.precio_venta) || 0;
        const stock_actual   = parseFloat(fila.stock_actual) || 0;
        const stock_minimo   = parseFloat(fila.stock_minimo) || 0;

        // Find existing product by barcode
        let producto_id = null;
        if (codigo) {
          const cb = window.SGA_DB.query('SELECT producto_id FROM codigos_barras WHERE codigo = ?', [codigo]);
          if (cb.length) producto_id = cb[0].producto_id;
        }
        // Fallback: find by exact name
        if (!producto_id && nombre) {
          const pn = window.SGA_DB.query('SELECT id FROM productos WHERE LOWER(nombre) = ?', [nombre.toLowerCase()]);
          if (pn.length) producto_id = pn[0].id;
        }

        if (producto_id) {
          // UPDATE existing
          if (!updateExisting) continue;
          window.SGA_DB.run(`
            UPDATE productos SET
              nombre = ?, categoria_id = ?, proveedor_principal_id = ?,
              costo = ?, precio_venta = ?, stock_minimo = ?,
              fecha_modificacion = ?, sync_status = 'pending', updated_at = ?
            WHERE id = ?
          `, [nombre, categoria_id, proveedor_id, costo, precio_venta, stock_minimo, now, now, producto_id]);
          results.actualizados++;
        } else {
          // INSERT new
          producto_id = window.SGA_Utils.generateUUID();
          window.SGA_DB.run(`
            INSERT INTO productos (
              id, nombre, categoria_id, proveedor_principal_id,
              costo, precio_venta, stock_minimo,
              es_madre, precio_independiente, unidad_medida, activo,
              fecha_alta, fecha_modificacion, sync_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'unidad', 1, ?, ?, 'pending', ?)
          `, [producto_id, nombre, categoria_id, proveedor_id, costo, precio_venta, stock_minimo, now, now, now]);
          results.importados++;
        }

        // Upsert barcode
        if (codigo) {
          const existing = window.SGA_DB.query('SELECT id FROM codigos_barras WHERE codigo = ?', [codigo]);
          if (!existing.length) {
            window.SGA_DB.run(
              'INSERT INTO codigos_barras (id, producto_id, codigo, es_principal) VALUES (?, ?, ?, 1)',
              [window.SGA_Utils.generateUUID(), producto_id, codigo]
            );
          }
        }

        // Upsert stock
        const existingStock = window.SGA_DB.query(
          'SELECT 1 FROM stock WHERE producto_id = ? AND sucursal_id = ?',
          [producto_id, sucursal_id]
        );
        if (existingStock.length) {
          window.SGA_DB.run(
            'UPDATE stock SET cantidad = ?, fecha_modificacion = ?, sync_status = \'pending\', updated_at = ? WHERE producto_id = ? AND sucursal_id = ?',
            [stock_actual, now, now, producto_id, sucursal_id]
          );
        } else {
          window.SGA_DB.run(
            'INSERT INTO stock (producto_id, sucursal_id, cantidad, fecha_modificacion, sync_status, updated_at) VALUES (?, ?, ?, ?, \'pending\', ?)',
            [producto_id, sucursal_id, stock_actual, now, now]
          );
        }

        // Sustituto
        const codSustituto = String(fila.codigo_sustituto || '').trim();
        if (codSustituto) {
          const sust = window.SGA_DB.query('SELECT producto_id FROM codigos_barras WHERE codigo = ?', [codSustituto]);
          if (sust.length) {
            const sust_id = sust[0].producto_id;
            const existsRel = window.SGA_DB.query(
              'SELECT 1 FROM producto_sustitutos WHERE producto_id = ? AND sustituto_id = ?',
              [producto_id, sust_id]
            );
            if (!existsRel.length) {
              window.SGA_DB.run(
                'INSERT INTO producto_sustitutos (producto_id, sustituto_id, activo, fecha_asignacion) VALUES (?, ?, 1, ?)',
                [producto_id, sust_id, now]
              );
            }
            results.sustitutosResueltos++;
          } else {
            results.sustitutosPendientes.push(codSustituto);
          }
        }

      } catch (err) {
        results.errores.push(`${nombre || codigo}: ${err.message}`);
      }
    }

    window.SGA_DB.commitBatch();

    // Refresh in-memory state
    state.productos = window.SGA_DB.query('SELECT * FROM productos ORDER BY nombre');

    return results;
  };

  // ── ADVANCED SEARCH MODAL ─────────────────────────────────────────────────

  const updateAdvancedBadge = () => {
    const f = state.filters;
    let count = 0;
    if (f.proveedor)        count++;
    if (f.tipo)             count++;
    if (f.precioMin != null) count++;
    if (f.precioMax != null) count++;
    if (f.costoMin  != null) count++;
    if (f.costoMax  != null) count++;
    if (f.margenMin != null) count++;
    if (f.margenMax != null) count++;
    if (f.stockMin  != null) count++;
    if (f.stockMax  != null) count++;
    if (f.soloBajoMinimo)   count++;

    const badge = getElement('adv-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  };

  const openAdvancedModal = () => {
    // Populate proveedores select
    const sel = getElement('adv-proveedor');
    if (sel) {
      sel.innerHTML = '<option value="">Todos los proveedores</option>' +
        state.proveedores.map(p => `<option value="${p.id}" ${p.id === state.filters.proveedor ? 'selected' : ''}>${p.razon_social}</option>`).join('');
    }

    // Restore current filter values into inputs
    const set = (id, val) => { const el = getElement(id); if (el) el.value = val ?? ''; };
    const setChk = (id, val) => { const el = getElement(id); if (el) el.checked = !!val; };
    set('adv-tipo',       state.filters.tipo);
    set('adv-precio-min', state.filters.precioMin ?? '');
    set('adv-precio-max', state.filters.precioMax ?? '');
    set('adv-costo-min',  state.filters.costoMin  ?? '');
    set('adv-costo-max',  state.filters.costoMax  ?? '');
    set('adv-margen-min', state.filters.margenMin ?? '');
    set('adv-margen-max', state.filters.margenMax ?? '');
    set('adv-stock-min',  state.filters.stockMin  ?? '');
    set('adv-stock-max',  state.filters.stockMax  ?? '');
    setChk('adv-solo-bajo-minimo', state.filters.soloBajoMinimo);

    getElement('advanced-search-modal').classList.remove('hidden');
    getElement('modal-backdrop').classList.remove('hidden');
  };

  const closeAdvancedModal = () => {
    getElement('advanced-search-modal').classList.add('hidden');
    getElement('modal-backdrop').classList.add('hidden');
  };

  const applyAdvancedFilters = () => {
    const num = (id) => { const v = getElement(id)?.value; return v !== '' && v != null ? parseFloat(v) : null; };
    state.filters.proveedor     = getElement('adv-proveedor')?.value || '';
    state.filters.tipo          = getElement('adv-tipo')?.value || '';
    state.filters.precioMin     = num('adv-precio-min');
    state.filters.precioMax     = num('adv-precio-max');
    state.filters.costoMin      = num('adv-costo-min');
    state.filters.costoMax      = num('adv-costo-max');
    state.filters.margenMin     = num('adv-margen-min');
    state.filters.margenMax     = num('adv-margen-max');
    state.filters.stockMin      = num('adv-stock-min');
    state.filters.stockMax      = num('adv-stock-max');
    state.filters.soloBajoMinimo = getElement('adv-solo-bajo-minimo')?.checked || false;
    state.page = 1;
    closeAdvancedModal();
    updateAdvancedBadge();
    applyFilters();
  };

  const clearAdvancedFilters = () => {
    state.filters.proveedor = '';
    state.filters.tipo = '';
    state.filters.precioMin = null;
    state.filters.precioMax = null;
    state.filters.costoMin  = null;
    state.filters.costoMax  = null;
    state.filters.margenMin = null;
    state.filters.margenMax = null;
    state.filters.stockMin  = null;
    state.filters.stockMax  = null;
    state.filters.soloBajoMinimo = false;
    ['adv-proveedor','adv-tipo','adv-precio-min','adv-precio-max',
     'adv-costo-min','adv-costo-max','adv-margen-min','adv-margen-max',
     'adv-stock-min','adv-stock-max'].forEach(id => { const el = getElement(id); if (el) el.value = ''; });
    const chk = getElement('adv-solo-bajo-minimo');
    if (chk) chk.checked = false;
    state.page = 1;
    updateAdvancedBadge();
    applyFilters();
  };

  // ── EVENTS ────────────────────────────────────────────────────────────────

  const setUpEvents = () => {
    // Sort column headers
    document.querySelectorAll('.productos-table thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (state.sort.field === field) {
          state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort.field = field;
          state.sort.dir = 'asc';
        }
        state.page = 1;
        applyFilters();
      });
    });

    // Row click → open edit (ignore clicks on action buttons)
    getElement('productos-tbody')?.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const row = e.target.closest('tr[data-id]');
      if (row) openEditModal(row.dataset.id);
    });

    // Advanced search modal
    getElement('btn-busqueda-avanzada')?.addEventListener('click', (e) => {
      e.preventDefault();
      openAdvancedModal();
    });
    getElement('btn-adv-close')?.addEventListener('click', closeAdvancedModal);
    getElement('btn-adv-apply')?.addEventListener('click', applyAdvancedFilters);
    getElement('btn-adv-clear')?.addEventListener('click', clearAdvancedFilters);

    // Edit modal buttons
    getElement('btn-close-edit')?.addEventListener('click', closeEditModal);
    getElement('btn-edit-cancel')?.addEventListener('click', closeEditModal);
    getElement('btn-edit-save')?.addEventListener('click', saveEditModal);

    getElement('btn-descargar-plantilla')?.addEventListener('click', downloadTemplate);
    getElement('btn-nuevo-producto')?.addEventListener('click', () => openProductModal());
    getElement('btn-importar-excel')?.addEventListener('click', () => openImportModal());
    getElement('btn-bajo-minimo')?.addEventListener('click', () => {
      state.filters.soloMadres = false;
      state.filters.activo = '';
      state.filters.categoria = '';
      state.filters.query = '';
      getElement('search-productos').value = '';
      getElement('filter-categoria').value = '';
      getElement('filter-solo-madres').checked = false;
      getElement('filter-activo').value = '';


      const bajos = state.productos.filter(p => {
        const stock = p.stock_actual != null ? p.stock_actual : 0;
        return stock < (p.stock_minimo || 0);
      });
      state.totalPages = Math.max(1, Math.ceil(bajos.length / state.perPage));
      state.page = 1;
      renderProductosTable(bajos.slice(0, state.perPage), bajos.length);
    });


    getElement('btn-prev-page')?.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        applyFilters();
      }
    });


    getElement('btn-next-page')?.addEventListener('click', () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        applyFilters();
      }
    });


    getElement('search-productos')?.addEventListener('input', (e) => {
      state.filters.query = e.target.value;
      state.page = 1;
      applyFilters();
    });


    getElement('filter-categoria')?.addEventListener('change', (e) => {
      state.filters.categoria = e.target.value;
      state.page = 1;
      applyFilters();
    });


    getElement('filter-solo-madres')?.addEventListener('change', (e) => {
      state.filters.soloMadres = e.target.checked;
      state.page = 1;
      applyFilters();
    });


    getElement('filter-activo')?.addEventListener('change', (e) => {
      state.filters.activo = e.target.value;
      state.page = 1;
      applyFilters();
    });


    getElement('product-costo')?.addEventListener('input', calculateMargin);
    getElement('product-precio')?.addEventListener('input', calculateMargin);


    document.querySelectorAll('input[name="product-type"]').forEach(radio => {
      radio.addEventListener('change', () => {
        updateMadreSelector();
        populateMadres();
      });
    });


    getElement('btn-close-detail')?.addEventListener('click', () => getElement('detail-panel')?.classList.add('hidden'));


    getElement('product-modal').querySelector('.btn-close')?.addEventListener('click', closeProductModal);


    getElement('btn-next-step1')?.addEventListener('click', () => goToStep(2));
    getElement('btn-prev-step2')?.addEventListener('click', () => goToStep(1));
    getElement('btn-next-step2')?.addEventListener('click', () => goToStep(3));
    getElement('btn-prev-step3')?.addEventListener('click', () => goToStep(2));
    getElement('btn-next-step3')?.addEventListener('click', () => goToStep(4));
    getElement('btn-prev-step4')?.addEventListener('click', () => goToStep(3));
    getElement('btn-next-step4')?.addEventListener('click', () => goToStep(5));


    getElement('btn-add-barcode')?.addEventListener('click', () => {
      const text = getElement('barcode-input')?.value.trim();
      if (!text) return;
      if (!state.barcodes.includes(text)) {
        state.barcodes.push(text);
      }
      getElement('barcodes-list').innerHTML = state.barcodes.map(c => `<div>${c}</div>`).join('');
      getElement('barcode-input').value = '';
      getElement('barcode-input').focus();
    });


    getElement('btn-add-sustituto')?.addEventListener('click', () => {
      const select = getElement('select-sustituto');
      const selected = select?.value;
      if (!selected || state.substitutes.includes(selected)) return;
      const item = state.productos.find(p => p.id === selected);
      if (!item) return;
      state.substitutes.push(selected);
      getElement('sustitutos-list').innerHTML = state.substitutes.map(id => {
        const p = state.productos.find(item => item.id === id);
        return `<div>${p ? p.nombre : id}</div>`;
      }).join('');
    });


    getElement('btn-save-producto')?.addEventListener('click', saveProduct);
    getElement('btn-family-cancel')?.addEventListener('click', () => getElement('family-modal').classList.add('hidden'));
    getElement('btn-family-confirm')?.addEventListener('click', () => getElement('family-modal').classList.add('hidden'));


    // Close modal when clicking backdrop area; a very simple implementation
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });

    // Import modal events
    getElement('import-modal')?.querySelector('.btn-close')?.addEventListener('click', hideImportModal);
    getElement('btn-import-cancel')?.addEventListener('click', hideImportModal);
    getElement('btn-import-do-confirm')?.addEventListener('click', confirmImport);
    getElement('modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target === getElement('modal-backdrop')) hideImportModal();
    });

    const dropZone = getElement('file-drop-zone');
    const fileInput = getElement('file-input');
    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
      dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
      });
    }

    getElement('btn-import-next1')?.addEventListener('click', () => goToImportStep(2));
    getElement('btn-import-prev2')?.addEventListener('click', () => goToImportStep(1));
    getElement('btn-import-next2')?.addEventListener('click', () => goToImportStep(3));
    getElement('btn-import-prev3')?.addEventListener('click', () => goToImportStep(2));
    getElement('btn-import-confirm')?.addEventListener('click', performImport);
  };


  const init = () => {
    setUpEvents();
    loadCategorias();
    loadProveedores();
    loadProductos();
    updateMadreSelector();
    populateMadres();
    console.log('Productos module initialized');
  };


  return {
    init,
    loadProductos
  };
})();


export default Productos;
