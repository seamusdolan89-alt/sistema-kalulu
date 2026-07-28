'use strict';

/**
 * interpretarFacturaCompra — Cloud Function (callable)
 *
 * Recibe la foto de una factura de compra (base64) y le pide a Claude que
 * transcriba (NO que convierta ni calcule) proveedor, cabecera e ítems.
 * La conversión bulto→unidad y el matcheo contra productos existentes se
 * hacen del lado del cliente (compras_v2.js), usando datos que el modelo
 * no tiene (unidades_por_paquete_compra de cada producto).
 *
 * Deploy pendiente de que el proyecto de Firebase tenga el plan Blaze
 * activo y el secret ANTHROPIC_API_KEY configurado:
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *   firebase deploy --only functions
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const Anthropic = require('@anthropic-ai/sdk');

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

const FACTURA_SCHEMA = {
  type: 'object',
  properties: {
    proveedor_nombre:  { type: 'string' },
    proveedor_cuit:    { type: 'string' },
    condicion_compra:  { type: 'string', enum: ['Factura A', 'Factura B', 'Factura C', 'Remito', 'Ticket', ''] },
    factura_pv:        { type: 'string' },
    numero_factura:    { type: 'string' },
    fecha:             { type: 'string', description: 'YYYY-MM-DD si se puede leer, si no string vacío' },
    condicion_pago:    { type: 'string', enum: ['efectivo', 'cuenta_corriente', ''] },
    subtotal_neto:     { type: 'number' },
    iva_105:           { type: 'number' },
    iva_21:            { type: 'number' },
    imp_interno:       { type: 'number' },
    percepcion_iva:    { type: 'number' },
    percepcion_iibb:   { type: 'number' },
    total_factura:     { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          codigo_proveedor: { type: 'string', description: 'Código interno del proveedor tal cual figura en la factura, NO un código de barras' },
          descripcion:      { type: 'string' },
          cantidad:         { type: 'number', description: 'Tal cual figura impresa — NO convertir bultos a unidades' },
          costo_unitario:   { type: 'number', description: 'Precio de esa línea tal cual figura — NO dividir por unidades del bulto' },
          iva:              { type: 'string', enum: ['10.5', '21', '0', ''] },
          subtotal:         { type: 'number' },
        },
        required: ['descripcion', 'cantidad', 'costo_unitario', 'subtotal'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const PROMPT = `Sos un asistente que interpreta facturas de compra argentinas para un sistema de gestión de almacén. Se te muestra la foto de una factura de un proveedor.

Extraé EXACTAMENTE lo que está impreso — no calcules, no conviertas, no dividas nada, solo transcribí:

- Datos del proveedor (nombre, CUIT) y de la factura (tipo — Factura A/B/C/Remito/Ticket, punto de venta, número, fecha, condición de venta: contado/efectivo → "efectivo", cuenta corriente → "cuenta_corriente").
- Si es Factura A, el desglose de importes de la cabecera (subtotal neto, IVA 10,5%, IVA 21%, impuesto interno, percepción IVA, percepción IIBB, total factura). Si algún campo no aparece impreso, poné 0.
- Por cada línea de productos: el código que usa el PROVEEDOR en su columna de código (no es un código de barras — es un código interno del proveedor), la descripción tal cual figura, la CANTIDAD tal cual está impresa (si la factura dice "4" bultos, poné 4 — NO la multipliques por unidades por bulto), el COSTO UNITARIO tal cual está impreso en la columna de precio de esa línea (si es el precio de un bulto/display, poné ese precio tal cual — NO lo dividas por la cantidad de unidades del bulto), la alícuota de IVA de esa línea si está indicada, y el subtotal de esa línea tal cual está impreso.

Si un dato no está presente en la imagen, usá 0 para números o string vacío para texto — no inventes valores. La cantidad de bultos, el precio del bulto y la conversión a unidades individuales las hace otro sistema después, con datos que vos no tenés — tu única tarea es transcribir lo que está impreso en el papel.`;

exports.interpretarFacturaCompra = onCall(
  { secrets: [anthropicApiKey], region: 'us-central1', timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Debe iniciar sesión para usar esta función.');
    }

    const { imageBase64, mediaType } = request.data || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new HttpsError('invalid-argument', 'Falta imageBase64.');
    }

    // Por las dudas venga con el prefijo "data:image/jpeg;base64,...", lo saco.
    const rawBase64 = imageBase64.includes(',') ? imageBase64.split(',').pop() : imageBase64;
    const media = typeof mediaType === 'string' && mediaType ? mediaType : 'image/jpeg';

    const client = new Anthropic({ apiKey: anthropicApiKey.value() });

    let response;
    try {
      response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 8000,
        output_config: { format: { type: 'json_schema', schema: FACTURA_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media, data: rawBase64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      });
    } catch (err) {
      throw new HttpsError('internal', 'Error llamando a Claude: ' + err.message);
    }

    if (response.stop_reason === 'refusal') {
      throw new HttpsError('internal', 'Claude no pudo procesar esta imagen (rechazada por políticas de contenido).');
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) {
      throw new HttpsError('internal', 'Claude no devolvió un resultado interpretable.');
    }

    try {
      return JSON.parse(textBlock.text);
    } catch (err) {
      throw new HttpsError('internal', 'La respuesta de Claude no fue JSON válido: ' + err.message);
    }
  }
);
