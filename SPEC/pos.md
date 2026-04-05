# POS (Punto de Venta)

## Tablas
- ventas
- venta_items
- venta_pagos
- clientes (opcional)
- cuenta_corriente (si cliente seleccionado)

## Flujo
1. Iniciar venta
2. Agregar productos (barcode o búsqueda)
3. Mantener carrito (sessionStorage)
4. Seleccionar cliente (opcional)
5. Seleccionar medios de pago (soporta pago mixto)
6. Confirmar venta → guardar en DB → imprimir → limpiar carrito

## Reglas clave
- Soporta múltiples medios de pago
- El total debe coincidir con la suma de pagos
- Permite descuentos por ítem y global
- Venta confirmada = transacción SQLite completa

## Integraciones
- Afecta stock
- Puede afectar cuenta corriente
- Impacta caja

## Función crítica
- registrarVenta()
  - inserta en ventas
  - inserta en venta_items
  - inserta en venta_pagos
  - maneja cuenta corriente si aplica