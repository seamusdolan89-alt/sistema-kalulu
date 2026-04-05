# Productos

## Tablas
- productos
- stock
- producto_sustitutos
- codigos_barras

## Conceptos clave

### Producto madre/hijo
- Los hijos pueden heredar costo y precio
- Cambios pueden propagarse a toda la familia

### Sustitutos (grupo)
- Un producto referencia agrupa varios
- Stock disponible = suma del grupo

## Reglas
- stock_alerta solo en producto referencia
- miembros no tienen alerta propia

## Función clave
- getStockDisponible(producto_id, sucursal_id)