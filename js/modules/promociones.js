/**
 * promociones.js — Promotions Module
 */

export default {
  init() {
    const el = document.getElementById('app-content');
    if (!el) return;
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:60vh">
        <div style="background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.10);padding:48px 56px;max-width:520px;width:100%;text-align:center">
          <div style="font-size:48px;margin-bottom:16px">🎁</div>
          <h2 style="margin:0 0 8px;font-size:22px">Combos y Promociones</h2>
          <div style="color:#E65100;font-size:15px;font-weight:600;margin-bottom:20px">🚧 Módulo en desarrollo</div>
          <ul style="text-align:left;color:#555;line-height:1.8;margin:0 0 24px;padding-left:20px">
            <li>Combo fijo: N productos a precio especial</li>
            <li>Descuento por cantidad (llevá 3, pagá 2)</li>
            <li>Descuento por monto (% off por categoría)</li>
            <li>Vigencia: fecha desde/hasta o sin vencimiento</li>
            <li>Aplicación automática en el Punto de Venta</li>
          </ul>
          <div style="color:#999;font-size:13px">Próximamente disponible</div>
        </div>
      </div>
    `;
  }
};
