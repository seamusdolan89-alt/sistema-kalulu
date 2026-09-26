'use strict';

/**
 * buscador_productos.js — Motor unico de busqueda de productos.
 *
 * Antes cada pantalla tenia su propia copia de "buscar producto por codigo de
 * barras": POS, Roturas, Vencimientos, Consumo Interno, Compras y Ordenes. Las
 * de Roturas, Vencimientos y Consumo Interno eran identicas byte a byte. El
 * problema de eso no es la repeticion en si, sino que un arreglo hay que
 * acordarse de aplicarlo en seis lugares — y el de los ceros a la izquierda
 * quedo, durante un tiempo, solo en el POS.
 *
 * Expone window.SGA_Buscador. Importar de forma estatica desde el modulo que lo
 * use (no depender del preload de app.js).
 */

const SGA_Buscador = (() => {

  const db = () => window.SGA_DB;

  /**
   * Variantes razonables de un codigo escaneado.
   *
   * El mismo producto puede estar guardado con una cantidad distinta de ceros
   * a la izquierda de la que manda el lector:
   *
   *  - Un EAN-8 (envases chicos, tipo un rollo de Mentos) guardado como
   *    "78916418", pero muchos lectores lo expanden a EAN-13 y mandan
   *    "0000078916418".
   *  - Un UPC-A de 12 digitos que empieza con 0 (por ejemplo Skittles,
   *    "022000018465") importado desde un Excel con la columna en formato
   *    numerico: la conversion pierde el cero y queda "22000018465".
   *  - El mismo UPC-A escaneado como EAN-13, con un cero mas adelante.
   *
   * Solo se generan variantes para codigos puramente numericos: un codigo
   * interno con letras se busca tal cual.
   */
  function variantesCodigo(codigo) {
    const raw = String(codigo ?? '').trim();
    if (!raw) return [];

    const out = [raw];
    if (/^[0-9]+$/.test(raw)) {
      const sinCeros = raw.replace(/^0+/, '');
      if (sinCeros && sinCeros !== raw) out.push(sinCeros);
      out.push('0' + raw);
      if (raw.length === 12) out.push('00' + raw);
    }
    return [...new Set(out)];
  }

  /**
   * Producto por codigo de barras, tolerante a los ceros a la izquierda.
   *
   * Devuelve la fila completa de productos mas `codigo` (el que matcheo) y
   * `stock` de la sucursal indicada, o null. Se devuelve p.* para que cada
   * pantalla use las columnas que necesita sin tener que tocar esta consulta.
   */
  function porCodigo(codigo, { sucursalId = null } = {}) {
    const variantes = variantesCodigo(codigo);
    if (!variantes.length) return null;

    const ph = variantes.map(() => '?').join(',');
    const rows = db().query(`
      SELECT p.*, cb.codigo AS codigo, COALESCE(s.cantidad, 0) AS stock
      FROM productos p
      JOIN codigos_barras cb ON cb.producto_id = p.id
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      WHERE p.activo = 1 AND cb.codigo IN (${ph})
      LIMIT 1
    `, [sucursalId, ...variantes]) || [];

    return rows[0] || null;
  }

  /**
   * Busqueda por nombre o por codigo, para los dropdowns con autocompletado.
   * El nombre va por LIKE; el codigo se compara contra todas las variantes,
   * asi que escanear tambien encuentra al producto desde el buscador de texto.
   */
  function porTexto(q, { sucursalId = null, limite = 20 } = {}) {
    const texto = String(q ?? '').trim();
    if (texto.length < 2) return [];

    const variantes = variantesCodigo(texto);
    const ph = variantes.length ? variantes.map(() => '?').join(',') : "''";
    const minusculas = texto.toLowerCase();

    // Orden: primero el nombre IGUAL a lo tipeado, despues los que EMPIEZAN con
    // eso y por ultimo los que solo lo contienen (cada grupo alfabetico). Con
    // solo `ORDER BY nombre` + LIMIT, un producto llamado exactamente "Naranja"
    // quedaba fuera de los resultados si habia mas de `limite` productos que
    // contienen "naranja" y van antes en el alfabeto (gaseosas, jugos, dulces).
    return db().query(`
      SELECT DISTINCT p.*,
             (SELECT codigo FROM codigos_barras
               WHERE producto_id = p.id AND es_principal = 1 LIMIT 1) AS codigo,
             COALESCE(s.cantidad, 0) AS stock
      FROM productos p
      LEFT JOIN stock s ON s.producto_id = p.id AND s.sucursal_id = ?
      LEFT JOIN codigos_barras cb ON cb.producto_id = p.id
      WHERE p.activo = 1
        AND (LOWER(p.nombre) LIKE ? OR cb.codigo IN (${ph}))
      ORDER BY CASE WHEN LOWER(p.nombre) = ? THEN 0
                    WHEN LOWER(p.nombre) LIKE ? THEN 1
                    ELSE 2 END,
               p.nombre
      LIMIT ${Number(limite) || 20}
    `, [sucursalId, '%' + minusculas + '%', ...variantes, minusculas, minusculas + '%']) || [];
  }

  /**
   * Dibuja los resultados en el dropdown de un carrito.
   *
   * Estaba duplicada byte a byte en los cinco modulos de carrito, con el mismo
   * bug en las cinco copias: mostraban productos.unidad_venta al lado del
   * stock. Esa columna es texto libre y en los datos reales trae cualquier
   * cosa —hay productos con "3550" cargado ahi—, asi que se leia
   * "Stock: 1 3550". El numero solo alcanza; es la misma correccion que el POS
   * ya habia hecho por su lado.
   *
   * @param {HTMLElement} dd        contenedor del dropdown
   * @param {Array}       resultados
   * @param {Function}    alElegir  que hacer con el producto elegido
   * @param {{importe?: Function}} opciones  importe a mostrar a la derecha;
   *        por defecto el costo (compras muestra el precio de venta).
   */
  function pintarDropdown(dd, resultados, alElegir, { importe } = {}) {
    if (!dd) return;
    if (!resultados || !resultados.length) { dd.style.display = 'none'; return; }

    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const plata = (n) => window.SGA_Utils.formatCurrency(n || 0);

    dd.innerHTML = resultados.map(p => {
      const qty = parseFloat(p.stock) || 0;
      const stock = qty <= 0
        ? '<div class="sri-stock-warn">Sin stock</div>'
        : `<div class="sri-codigo">Stock: ${qty.toLocaleString('es-AR', { maximumFractionDigits: 2 })}</div>`;
      return `
        <div class="sri" data-id="${esc(p.id)}">
          <div class="sri-left">
            <div class="sri-nombre">${esc(p.nombre)}</div>
            ${p.codigo ? `<div class="sri-codigo">${esc(p.codigo)}</div>` : ''}
            ${stock}
          </div>
          <div class="sri-costo">${importe ? importe(p) : plata(p.costo)}</div>
        </div>`;
    }).join('');

    dd.style.display = 'block';

    dd.querySelectorAll('.sri').forEach(el => {
      el.addEventListener('click', () => {
        const p = resultados.find(x => String(x.id) === el.dataset.id);
        if (p) alElegir(p);
      });
    });
  }

  /**
   * Navegación con flechas/Enter/Escape sobre un dropdown de resultados.
   *
   * Antes cada pantalla con buscador (Ajuste de stock, Agregar producto de
   * Órdenes, el sustituto de Órdenes, el carrito de Compras...) reimplementaba
   * esto a mano, cada una con su propio índice de resaltado — mismo código,
   * copiado. Se engancha una sola vez sobre el <input> de búsqueda; qué
   * elementos son "navegables" se relee en cada tecla con `getItems()` (el
   * dropdown se vuelve a pintar en cada búsqueda, así que no sirve guardar
   * una lista fija).
   *
   * El propio elemento resaltado es el que recibe el click al confirmar con
   * Enter — no hace falta un callback de selección aparte, alcanza con que
   * cada item ya tenga su propio listener de click (como ya es el caso en
   * todos los dropdowns existentes).
   *
   * @param {HTMLInputElement} input
   * @param {Object}   opts
   * @param {() => (HTMLElement[]|NodeList)} opts.getItems  items navegables, en el orden en que se muestran
   * @param {string}   [opts.highlightClass='cv2-dd-item-hl']  clase para marcar el resaltado
   * @param {Function} [opts.onEscape]              al apretar Escape
   * @param {Function} [opts.onEnterSinResaltado]    Enter sin nada resaltado todavía
   * @returns {{ reset: () => void }} `reset()` hay que llamarlo cada vez que se repinta la lista (nueva búsqueda)
   */
  function attachDropdownKeyboard(input, opts = {}) {
    const {
      getItems,
      highlightClass = 'cv2-dd-item-hl',
      onEscape,
      onEnterSinResaltado,
    } = opts;
    let idx = -1;

    const items = () => Array.from(getItems ? (getItems() || []) : []);

    const pintar = (els) => {
      els.forEach((el, i) => el.classList.toggle(highlightClass, i === idx));
      if (idx >= 0 && els[idx]) els[idx].scrollIntoView({ block: 'nearest' });
    };

    const reset = () => { idx = -1; };

    input.addEventListener('keydown', e => {
      const els = items();

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!els.length) return;
        idx = Math.min(idx + 1, els.length - 1);
        pintar(els);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(idx - 1, -1);
        pintar(els);
        return;
      }
      if (e.key === 'Enter') {
        if (idx >= 0 && els[idx]) {
          e.preventDefault();
          els[idx].click();
          idx = -1;
          return;
        }
        if (onEnterSinResaltado) onEnterSinResaltado();
        return;
      }
      if (e.key === 'Escape') {
        idx = -1;
        if (onEscape) onEscape();
      }
    });

    return { reset };
  }

  return { variantesCodigo, porCodigo, porTexto, pintarDropdown, attachDropdownKeyboard };
})();

window.SGA_Buscador = SGA_Buscador;

export default SGA_Buscador;
