# Backlog

Reemplaza la sección "Pendiente de implementar" de `SPEC.md` (que quedó marcada como histórica). Este archivo sí se mantiene al día — cuando algo de acá se implementa, se borra de la lista (el detalle queda en el commit y, si hace falta, en `CLAUDE.md`); cuando surge algo nuevo para más adelante, se agrega.

No es un audit exhaustivo del código — es lo que se sabe pendiente en cada momento. Se arma conversacionalmente: cuando algo queda para después en vez de resolverse en el momento, anotarlo acá.

## Pendiente

### OCR de facturas de compra
- **Estado real (verificado 2026-09):** el lado servidor existe (`functions/index.js`, función `interpretarFacturaCompra`, usa la API de Claude vía `ANTHROPIC_API_KEY` como secret de Firebase) pero **no está deployada** (falta activar el plan Blaze del proyecto Firebase y configurar el secret) **ni conectada a ninguna pantalla** — ningún módulo del cliente la llama todavía.
- La ruta "carga manual" (`compras_v2.js`, flujo tipo POS de 5 pasos) cubre el caso de uso mientras tanto.
- Pendiente también: integración con Tesseract.js para lectura offline por template de proveedor (evita llamar a la API en proveedores ya conocidos).

---

*Agregar acá lo que se sepa pendiente — no hace falta esperar a que esté "bien redactado", una línea alcanza.*
