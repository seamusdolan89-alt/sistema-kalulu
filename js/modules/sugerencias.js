/**
 * sugerencias.js — Buzón de Consultas y Sugerencias
 *
 * Cualquier usuario logueado (POS o Admin-POS) puede cargar una consulta
 * ("¿cómo funciona X?") o una sugerencia, con hasta 3 imágenes adjuntas
 * (capturas de pantalla, redimensionadas en el cliente antes de guardarlas
 * para no pasarse del límite de 1 MiB por documento de Firestore).
 *
 * El admin (solo desde Admin-POS) ve TODAS las entradas y responde cada una
 * — la respuesta es obligatoria para cerrarla, aunque sea "no, por este
 * motivo" (ver investigación de mercado, 14/10/2026: el antipatrón universal
 * de un buzón de sugerencias es la entrada que nunca recibe respuesta). Una
 * 'sugerencia' además pide una decisión (aceptada / con cambios / rechazada);
 * una 'consulta' solo queda 'respondida'.
 *
 * Cada usuario no-admin ve solo SUS PROPIAS entradas (y la respuesta, cuando
 * llega). No hay edición ni borrado en esta primera versión — cargar una de
 * más no es grave, y simplifica bastante.
 */

const Sugerencias = (() => {
  'use strict';

  const ge   = id => document.getElementById(id);
  const db   = () => window.SGA_DB;
  const esc  = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const MAX_ADJUNTOS   = 3;
  const MAX_DIM        = 1100;
  const JPEG_QUALITY    = 0.62;
  const MAX_BASE64_TOTAL = 900000; // margen bajo el límite de 1 MiB/doc de Firestore

  const TIPO_LABEL = { consulta: '❓ Consulta', sugerencia: '💡 Sugerencia' };
  const DECISION_LABEL = { aceptada: '✓ Aceptada', con_cambios: '◐ Con cambios', rechazada: '✗ Rechazada' };

  const state = {
    user: null,
    isAdmin: false,
    tipo: 'consulta',
    adjuntos: [],      // [{ base64, mediaType, dataUrl }]
    filtro: 'pendientes', // solo admin: 'pendientes' | 'todas'
  };

  function fmtFecha(f) {
    if (!f) return '—';
    const d = new Date(f);
    return isNaN(d) ? String(f).slice(0, 10) : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function showError(msg) {
    const el = ge('sug-error');
    el.textContent = msg;
    el.style.display = '';
  }
  function ocultarError() {
    const el = ge('sug-error');
    if (el) el.style.display = 'none';
  }

  // ── Imágenes: redimensionar en el cliente antes de guardar ────────────────

  function resizeImageToBase64(file, maxDim = MAX_DIM, quality = JPEG_QUALITY) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
        img.onload = () => {
          let width = img.width, height = img.height;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width  = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width  = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function tamanioTotalAdjuntos(lista) {
    return lista.reduce((s, a) => s + (a.base64?.length || 0), 0);
  }

  async function agregarAdjunto(file) {
    if (!file || !file.type?.startsWith('image/')) return;
    if (state.adjuntos.length >= MAX_ADJUNTOS) {
      showError(`Máximo ${MAX_ADJUNTOS} imágenes.`);
      return;
    }
    let img;
    try {
      img = await resizeImageToBase64(file);
    } catch (e) {
      showError('No se pudo procesar esa imagen: ' + e.message);
      return;
    }
    if (tamanioTotalAdjuntos([...state.adjuntos, img]) > MAX_BASE64_TOTAL) {
      showError('Las imágenes adjuntas son muy pesadas en conjunto — sacá alguna o probá con capturas más chicas.');
      return;
    }
    ocultarError();
    state.adjuntos.push(img);
    renderAdjuntosPreview();
  }

  function renderAdjuntosPreview() {
    const cont = ge('sug-adjuntos-preview');
    cont.innerHTML = state.adjuntos.map((a, i) => `
      <div class="sug-adjunto-thumb">
        <img src="${a.dataUrl}" alt="Adjunto ${i + 1}">
        <button type="button" class="sug-adjunto-quitar" data-quitar="${i}" title="Quitar" aria-label="Quitar imagen">✕</button>
      </div>`).join('');
    cont.querySelectorAll('[data-quitar]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.adjuntos.splice(parseInt(btn.dataset.quitar), 1);
        renderAdjuntosPreview();
      });
    });
  }

  // ── Enviar ──────────────────────────────────────────────────────────────

  function enviar() {
    ocultarError();
    const texto = ge('sug-texto').value.trim();
    if (!texto) { showError('Escribí tu consulta o sugerencia.'); return; }

    const ts = new Date().toISOString();
    const id = window.SGA_Utils.generateUUID();
    db().run(`
      INSERT INTO sugerencias
        (id, sucursal_id, usuario_id, tipo, texto, adjuntos, estado, fecha, sync_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, 'pending', ?)`,
      [id, state.user.sucursal_id || null, state.user.id, state.tipo, texto,
       state.adjuntos.length ? JSON.stringify(state.adjuntos.map(a => ({ base64: a.base64, mediaType: a.mediaType }))) : null,
       ts, ts]
    );
    window.SGA_Sync?.pushPending?.();

    ge('sug-texto').value = '';
    state.adjuntos = [];
    renderAdjuntosPreview();
    window.SGA_Utils.showNotification('Enviado', 'success');
    renderLista();
  }

  // ── Lista ───────────────────────────────────────────────────────────────

  function cargarLista() {
    if (state.isAdmin) {
      const where = state.filtro === 'pendientes' ? `WHERE s.estado = 'pendiente'` : '';
      return db().query(`
        SELECT s.*, u.nombre AS usuario_nombre, r.nombre AS respondida_por_nombre
        FROM sugerencias s
        LEFT JOIN usuarios u ON u.id = s.usuario_id
        LEFT JOIN usuarios r ON r.id = s.respondida_por
        ${where}
        ORDER BY (s.estado = 'pendiente') DESC, s.fecha DESC
      `);
    }
    return db().query(`
      SELECT s.*, u.nombre AS usuario_nombre, r.nombre AS respondida_por_nombre
      FROM sugerencias s
      LEFT JOIN usuarios u ON u.id = s.usuario_id
      LEFT JOIN usuarios r ON r.id = s.respondida_por
      WHERE s.usuario_id = ?
      ORDER BY s.fecha DESC
    `, [state.user.id]);
  }

  function renderItem(it) {
    const adjuntos = (() => { try { return JSON.parse(it.adjuntos || '[]'); } catch (e) { return []; } })();
    const fotosHtml = adjuntos.length ? `
      <div class="sug-item-fotos">
        ${adjuntos.map(a => `<img src="data:${esc(a.mediaType)};base64,${a.base64}" data-ver-foto>`).join('')}
      </div>` : '';

    const estadoBadge = it.estado === 'respondida'
      ? `<span class="sug-badge sug-badge-respondida">Respondida</span>`
      : `<span class="sug-badge sug-badge-pendiente">Pendiente</span>`;
    const decisionBadge = it.decision
      ? `<span class="sug-badge sug-badge-${esc(it.decision)}">${esc(DECISION_LABEL[it.decision] || it.decision)}</span>` : '';

    const respuestaHtml = it.estado === 'respondida' ? `
      <div class="sug-respuesta-box">
        <div>${esc(it.respuesta)}</div>
        <div class="sug-respuesta-meta">— ${esc(it.respondida_por_nombre || 'El dueño')}, ${fmtFecha(it.respondida_en)}</div>
      </div>` : '';

    const puedeResponder = state.isAdmin && it.estado === 'pendiente';
    const accionesHtml = puedeResponder ? `
      <div class="sug-item-acciones">
        <button class="btn btn-outline btn-sm" data-abrir-responder="${esc(it.id)}">Responder</button>
      </div>
      <div class="sug-responder-form" id="sug-responder-${esc(it.id)}">
        ${it.tipo === 'sugerencia' ? `
          <div class="sug-decision-radios" data-decision-group="${esc(it.id)}">
            ${Object.entries(DECISION_LABEL).map(([v, l]) => `
              <label class="sug-decision-radio" data-decision="${v}">
                <input type="radio" name="decision-${esc(it.id)}" value="${v}">${esc(l)}
              </label>`).join('')}
          </div>` : ''}
        <textarea class="sug-respuesta-input" id="sug-respuesta-${esc(it.id)}" rows="2" placeholder="Tu respuesta…"></textarea>
        <div style="margin-top:8px;text-align:right;display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-outline btn-sm" data-cancelar-responder="${esc(it.id)}">Cancelar</button>
          <button class="btn btn-primary btn-sm" data-guardar-respuesta="${esc(it.id)}">Guardar respuesta</button>
        </div>
      </div>` : '';

    return `
      <div class="sug-item" data-item="${esc(it.id)}">
        <div class="sug-item-head">
          <div class="sug-item-meta">
            <strong>${esc(it.usuario_nombre || 'Usuario')}</strong> · ${fmtFecha(it.fecha)}
          </div>
          <div class="sug-badges">
            <span class="sug-badge sug-badge-${esc(it.tipo)}">${esc(TIPO_LABEL[it.tipo] || it.tipo)}</span>
            ${estadoBadge}${decisionBadge}
          </div>
        </div>
        <div class="sug-item-texto">${esc(it.texto)}</div>
        ${fotosHtml}
        ${respuestaHtml}
        ${accionesHtml}
      </div>`;
  }

  function renderLista() {
    const items = cargarLista();
    const list  = ge('sug-list');
    const empty = ge('sug-empty');

    if (!items.length) {
      list.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = items.map(renderItem).join('');

    list.querySelectorAll('[data-ver-foto]').forEach(img => {
      img.addEventListener('click', () => abrirLightbox(img.src));
    });
    list.querySelectorAll('[data-abrir-responder]').forEach(btn => {
      btn.addEventListener('click', () => {
        ge(`sug-responder-${btn.dataset.abrirResponder}`)?.classList.add('abierto');
      });
    });
    list.querySelectorAll('[data-cancelar-responder]').forEach(btn => {
      btn.addEventListener('click', () => {
        ge(`sug-responder-${btn.dataset.cancelarResponder}`)?.classList.remove('abierto');
      });
    });
    list.querySelectorAll('[data-decision-group]').forEach(group => {
      group.querySelectorAll('.sug-decision-radio').forEach(label => {
        label.addEventListener('click', () => {
          group.querySelectorAll('.sug-decision-radio').forEach(l => l.classList.remove('activo', 'aceptada', 'con_cambios', 'rechazada'));
          label.classList.add('activo', label.dataset.decision);
          label.querySelector('input').checked = true;
        });
      });
    });
    list.querySelectorAll('[data-guardar-respuesta]').forEach(btn => {
      btn.addEventListener('click', () => guardarRespuesta(btn.dataset.guardarRespuesta));
    });
  }

  function guardarRespuesta(id) {
    const it = db().query(`SELECT tipo, estado FROM sugerencias WHERE id = ?`, [id])[0];
    if (!it) return;
    if (it.estado !== 'pendiente') { window.SGA_Utils.showNotification('Ya estaba respondida — actualizando la lista.', 'info'); renderLista(); return; }

    const respuesta = ge(`sug-respuesta-${id}`)?.value?.trim() || '';
    if (!respuesta) { window.SGA_Utils.showNotification('Escribí una respuesta antes de guardar.', 'error'); return; }

    let decision = null;
    if (it.tipo === 'sugerencia') {
      const checked = ge(`sug-responder-${id}`)?.querySelector(`input[name="decision-${id}"]:checked`);
      if (!checked) { window.SGA_Utils.showNotification('Elegí una decisión (aceptada / con cambios / rechazada).', 'error'); return; }
      decision = checked.value;
    }

    const ts = new Date().toISOString();
    db().run(`
      UPDATE sugerencias SET estado = 'respondida', decision = ?, respuesta = ?,
        respondida_por = ?, respondida_en = ?, sync_status = 'pending', updated_at = ?
      WHERE id = ?`,
      [decision, respuesta, state.user.id, ts, ts, id]
    );
    window.SGA_Sync?.pushPending?.();
    window.SGA_Utils.showNotification('Respuesta guardada', 'success');
    renderLista();
  }

  // ── Lightbox ────────────────────────────────────────────────────────────

  function abrirLightbox(src) {
    ge('sug-lightbox-img').src = src;
    ge('sug-lightbox').classList.add('active');
  }
  function cerrarLightbox() {
    ge('sug-lightbox').classList.remove('active');
    ge('sug-lightbox-img').src = '';
  }

  // ── Init ────────────────────────────────────────────────────────────────

  function init() {
    state.user    = window.SGA_Auth.getCurrentUser();
    state.isAdmin = !!window.ADMIN_MODE;
    state.tipo    = 'consulta';
    state.adjuntos = [];
    state.filtro  = 'pendientes';

    ge('sug-filtros').style.display = state.isAdmin ? '' : 'none';

    ge('sug-tipo-radios').querySelectorAll('input[name="sug-tipo"]').forEach(inp => {
      inp.addEventListener('change', () => {
        state.tipo = inp.value;
        ge('sug-tipo-radios').querySelectorAll('.sug-tipo-radio').forEach(lbl =>
          lbl.classList.toggle('activo', lbl.dataset.tipo === state.tipo)
        );
      });
    });

    const fileInput = ge('sug-file-input');
    ge('sug-btn-adjuntar').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      for (const f of Array.from(fileInput.files || [])) await agregarAdjunto(f);
      fileInput.value = '';
    });
    ge('sug-texto').addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type?.startsWith('image/')) {
          e.preventDefault();
          agregarAdjunto(item.getAsFile());
        }
      }
    });

    ge('sug-btn-enviar').addEventListener('click', enviar);

    if (state.isAdmin) {
      ge('sug-filtros').querySelectorAll('.sug-filtro-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          state.filtro = btn.dataset.filtro;
          ge('sug-filtros').querySelectorAll('.sug-filtro-tab').forEach(b => b.classList.toggle('activo', b === btn));
          renderLista();
        });
      });
    }

    ge('sug-lightbox').addEventListener('click', cerrarLightbox);

    renderLista();
  }

  function destroy() {}

  return { init, destroy };
})();

window.SGA_Sugerencias = Sugerencias;

export default Sugerencias;
