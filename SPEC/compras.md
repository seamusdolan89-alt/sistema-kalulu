# Compras (modo POS-style)

## Concepto
El módulo de compras funciona como un POS invertido.

- misma lógica de carrito
- mismo flujo de interacción
- diferente impacto en datos (stock + costos)

---

## Tablas
- compras
- compra_items
- productos
- cuenta_proveedor

---

## Layout

### Panel izquierdo (carrito)
- búsqueda / escaneo
- tabla de ítems:
  - producto
  - cantidad
  - costo
  - subtotal

### Panel derecho
- proveedor
- total
- forma de pago
- confirmar compra

---

## Flujo

1. Seleccionar proveedor
2. Agregar productos (scan o búsqueda)
3. Editar cantidad y costo
4. Total se actualiza en tiempo real
5. Seleccionar forma de pago
6. Confirmar compra

---

## Input loop

- scan → agregar producto
- foco automático en cantidad
- Enter → pasa a costo
- Enter → vuelve a scan

---

## Reglas clave

- Cada ítem guarda:
  - costo anterior
  - costo nuevo

- Si cambia el costo:
  - marcar como modificado
  - permitir actualizar producto

- Confirmar compra:
  - INSERT compras
  - INSERT compra_items
  - UPDATE stock
  - UPDATE costo (si aplica)

---

## Pagos

- efectivo
- transferencia
- pendiente

Si pendiente:
- registrar en cuenta_proveedor

---

## Función crítica

- registrarCompra()
  - maneja todo en una transacción SQLite