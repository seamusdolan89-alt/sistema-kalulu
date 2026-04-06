'use strict';

const OperacionesStock = (() => {

  function init() {
    const root = document.getElementById('ops-root');
    if (!root) return;

    // Mostrar/ocultar card de ajuste pendiente
    const pendingCard = document.getElementById('ops-pending-card');
    if (pendingCard) {
      pendingCard.style.display = localStorage.getItem('compras_resumen_pending') ? 'block' : 'none';
    }

    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.classList.contains('ops-btn-disabled')) return;

      const action = btn.dataset.action;

      switch (action) {
        case 'retomar':
          sessionStorage.setItem('compras_v2_retomar', '1');
          window.location.hash = '#compras_v2';
          break;
        case 'descartar-pendiente':
          if (!confirm('¿Descartás el ajuste de precios pendiente? Esta acción no se puede deshacer.')) return;
          localStorage.removeItem('compras_resumen_pending');
          localStorage.removeItem('compras_resumen_editados');
          if (pendingCard) pendingCard.style.display = 'none';
          break;
        case 'compras':
          window.location.hash = '#compras_v2';
          break;
        case 'devolucion':
          window.location.hash = '#pos/devolucion';
          break;
        case 'ajuste_stock':
          window.SGA_Utils.showNotification('Ajuste de stock — próximamente', 'info');
          break;
        default:
          break;
      }
    });
  }

  return { init };
})();

export default OperacionesStock;
