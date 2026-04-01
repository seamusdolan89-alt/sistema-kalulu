'use strict';

const OperacionesStock = (() => {

  function init() {
    const root = document.getElementById('ops-root');
    if (!root) return;

    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.classList.contains('ops-btn-disabled')) return;

      const action = btn.dataset.action;

      switch (action) {
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
