# Cuenta Corriente

## Tabla
- cuenta_corriente

## Reglas clave
- El cliente nunca puede tener deuda y saldo a favor al mismo tiempo
- El sistema siempre netea automáticamente
- Orden FIFO para cancelar deuda

## Tipos de movimiento
- venta_fiada (positivo)
- pago (negativo)
- saldo_favor (negativo)
- ajuste

## Casos
- Pago con deuda existente → cancela deuda automáticamente
- Sobrepago → genera saldo a favor
- Subpago → genera deuda

## Requisito crítico
- Todo debe ejecutarse en una única transacción SQLite