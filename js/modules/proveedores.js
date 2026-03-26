/**
 * proveedores.js — Suppliers Module
 */

export default {
  init() {
    const el = document.getElementById('app-content');
    if (!el) return;
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:60vh">
        <div style="background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.10);padding:48px 56px;max-width:520px;width:100%;text-align:center">
          <div style="font-size:48px;margin-bottom:16px">🏢</div>
          <h2 style="margin:0 0 8px;font-size:22px">Proveedores</h2>
          <div style="color:#E65100;font-size:15px;font-weight:600;margin-bottom:20px">🚧 Módulo en desarrollo</div>
          <ul style="text-align:left;color:#555;line-height:1.8;margin:0 0 24px;padding-left:20px">
            <li>ABM de proveedores (razón social, CUIT)</li>
            <li>Contacto: teléfono, email, nombre de contacto</li>
            <li>Condición de pago (contado, 30 días, etc.)</li>
            <li>Historial de compras por proveedor</li>
            <li>Enlace con módulo de Compras y Órdenes</li>
          </ul>
          <div style="color:#999;font-size:13px">Próximamente disponible</div>
        </div>
      </div>
    `;
  }
};
