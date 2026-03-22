# Templates de Proveedores para OCR

Esta carpeta contiene los templates JSON guardados localmente para cada proveedor.

## Estructura

Cada archivo JSON utiliza el siguiente formato:

```json
{
  "proveedor_cuit": "20-12345678-9",
  "proveedor_nombre": "Nombre del Proveedor SA",
  "campos": {
    "fecha": {
      "region": [x1, y1, x2, y2],
      "formato": "DD/MM/YYYY"
    },
    "numero_factura": {
      "region": [x1, y1, x2, y2]
    },
    "items_tabla": {
      "region": [x1, y1, x2, y2],
      "columnas": ["codigo", "descripcion", "cantidad", "precio_unit"]
    }
  },
  "ultima_actualizacion": "2025-01-01T12:00:00Z"
}
```

## Flujo de Generación

1. **Primera factura de un proveedor (desconocido):**
   - El sistema envía la imagen a Claude API
   - Claude extrae los datos en JSON
   - Se guarda el template en este directorio

2. **Facturas posteriores del mismo proveedor:**
   - El sistema carga el template guardado
   - Usa Tesseract.js offline para procesar según las regiones definidas
   - No requiere conexión a internet

## Beneficios

- ✅ Reducción de llamadas a Claude API (solo la primera vez por proveedor)
- ✅ Procesamiento offline para facturas de proveedores conocidos
- ✅ Mantenimiento automático de templates

## Actualización Manual

Si los templates necesitan ser actualizados (cambio en formato de factura del proveedor):

1. Editar el archivo JSON correspondiente
2. Actualizar las regiones (x1, y1, x2, y2) según sea necesario
3. El sistema utilizará automáticamente la versión actualizada
