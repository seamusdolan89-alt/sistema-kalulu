# SPEC.md — Sistema de Gestión de Almacén (SGA)

> **Versión:** 1.0  
> **Fecha:** 2025  
> **Stack:** HTML5 + CSS3 + JavaScript ES6 + IndexedDB (offline-first) + SQLite via OPFS  
> **Arquitectura:** Single Page Application (SPA) sin frameworks, sin build system, 100% local

---

## 1. VISIÓN GENERAL

Sistema de gestión integral para almacén con soporte multi-sucursal. Diseñado para operar **100% offline** en cada sucursal, con sincronización opcional cuando hay conexión a internet. Una única excepción: el módulo de lectura de facturas por imagen usa la API de Claude la primera vez que se procesa un proveedor nuevo; las siguientes lecturas del mismo proveedor funcionan offline.

---

## 2. STACK TECNOLÓGICO

| Capa | Tecnología | Motivo |
|---|---|---|
| UI | HTML5 + CSS3 + JS ES6 | Sin dependencias, conocido por el equipo |
| Base de datos local | SQLite via OPFS (Origin Private File System) | Consultas relacionales, offline-first, persistente |
| Sincronización | Firebase Firestore (cuando hay internet) | Mismo stack del proyecto anterior |
| Auth | Firebase Authentication | Mismo stack del proyecto anterior |
| OCR offline | Tesseract.js (CDN) | Lectura de facturas sin internet |
| OCR inteligente | API de Claude (Anthropic) | Solo para proveedores nuevos (requiere internet) |
| Impresión tickets | ESC/POS via Web Serial API | Impresora térmica de tickets |
| Impresión etiquetas | HTML/CSS to print (window.print) | Impresora común A4 |
| Lector de código de barras | Input de teclado (HID) | Pistola USB, se comporta como teclado |

---

## 3. ARQUITECTURA MULTI-SUCURSAL

### Modelo de datos
- **Precios:** Globales (iguales en todas las sucursales)
- **Stock:** Independiente por sucursal
- **Caja:** Independiente por sucursal
- **Ventas:** Independientes por sucursal, se sincronizan al servidor
- **Clientes / Cuentas corrientes:** Globales (compartidos entre sucursales)
- **Productos / Proveedores:** Globales

### Sincronización (offline-first)
1. Cada sucursal trabaja con SQLite local (OPFS)
2. Cuando hay internet, se sincroniza con Firestore
3. Conflictos: "last-write-wins" con timestamp, salvo en stock (se suma el delta, no se reemplaza)
4. Cola de cambios pendientes para sincronizar cuando vuelve la conexión

---

## 4. ROLES Y PERMISOS

| Rol | Descripción | Permisos |
|---|---|---|
| `admin` | Dueño | Acceso total a todos los módulos y configuraciones |
| `encargado` | Encargado de sucursal | Ventas, caja, stock, compras, informes de su sucursal |
| `cajero` | Vendedor / cajero | Solo punto de venta y apertura/cierre de caja |

---

## 5. MÓDULOS DEL SISTEMA

### 5.1 MÓDULO: PRODUCTOS

#### Concepto de Producto Madre / Hijo
- Cada producto puede ser **madre** o **hijo**
- Un producto hijo hereda el costo y precio de venta de su madre por defecto
- Al cargar un hijo, se puede optar por precio independiente o heredado
- Cuando cambia el costo de un hijo: el sistema pregunta si se desea actualizar toda la familia
  - Si acepta: actualiza la madre y todos los hijos
  - Si rechaza: actualiza solo ese producto

**Campos de producto:**
```
id (UUID)
codigo_barras[] (array, un producto puede tener múltiples códigos)
nombre
descripcion
categoria_id
proveedor_principal_id
proveedor_alternativo_id
producto_madre_id (null si es madre o independiente)
es_madre (boolean)
costo
precio_venta
margen (calculado)
stock_actual (por sucursal, tabla stock)
stock_minimo (backward compat, igual a stock_alerta)
stock_alerta (dispara alerta cuando stock cae por debajo)
cant_pedido (cantidad sugerida para reposición)
imagen (base64, almacenada en productos.imagen)
unidad_medida (unidad, kg, lt, etc.)
activo (boolean)
fecha_alta
fecha_modificacion
```

#### Concepto de Producto Sustituto
- Un producto puede tener uno o más sustitutos asignados
- El stock disponible de un producto = stock propio + stock de sustitutos activos
- Cuando el sistema evalúa si hay que reponer, considera la suma de sustitutos
- Los sustitutos se desactivan manualmente cuando se agotan

**Tabla producto_sustitutos:**
```
producto_id
sustituto_id
activo (boolean)
fecha_asignacion
```

#### Carga de nuevo producto
Al crear un producto, el sistema pregunta:
1. ¿Es producto madre, hijo de otro, o independiente?
2. ¿Es sustituto de algún producto existente?
3. ¿Tiene proveedor principal y alternativo?
4. ¿Cuál es el stock mínimo?

---

### 5.2 MÓDULO: PUNTO DE VENTA (POS)

#### Flujo de venta
1. Apertura de caja (saldo inicial en efectivo)
2. Escaneo de productos (código de barras o búsqueda)
3. Visualización de carrito con cantidades, precios y subtotales
4. Selección de cliente (opcional, para cuenta corriente)
5. Selección de medio(s) de pago (puede ser pago mixto)
6. Confirmación y emisión de ticket

#### Medios de pago soportados
- **Efectivo** (con cálculo de vuelto; el vuelto puede quedar como saldo a favor del cliente)
- **Mercado Pago** (QR o link; registro manual de confirmación)
- **Tarjeta de crédito/débito** (posnet externo; registro manual)
- **Transferencia bancaria** (registro manual)
- **Cuenta corriente** (registra deuda del cliente)

#### Pago mixto
Una venta puede dividirse entre múltiples medios de pago. Ejemplo: $3.000 en efectivo + $2.000 en Mercado Pago.

#### Descuentos
- Descuento por ítem (porcentaje o monto fijo)
- Descuento global sobre el total
- Aplicación de promociones/combos automáticos

---

### 5.3 MÓDULO: CLIENTES Y CUENTA CORRIENTE

**Campos de cliente:**
```
id (UUID)
nombre
apellido
telefono
email
dni (opcional)
fecha_alta
activo
```

**Tabla cuenta_corriente_movimientos:**
```
id (UUID)
cliente_id
sucursal_id
tipo (venta_fiada | pago | saldo_favor | ajuste)
monto (positivo = debe, negativo = a favor)
venta_id (referencia a la venta que generó la deuda, si aplica)
descripcion
fecha
usuario_id
```

#### Reglas de cuenta corriente
1. CUENTA CORRIENTE — REGLAS DE NETEO
   - Un cliente NUNCA puede tener simultáneamente saldo positivo (deuda) y saldo negativo (crédito a favor).
   - El sistema siempre netea automáticamente los movimientos al registrar cambios.

2. En POS, cuando se selecciona cliente con deuda existente:
   - Mostrar aviso: "Este cliente tiene deuda de $X — se aplicará automáticamente".
   - Mostrar un toggle "Aplicar deuda" (activado por defecto; el cajero puede desactivarlo si el cliente lo pide).
   - Si toggle está ON: el pago entrante debe cubrir:
     - venta actual + deuda existente + remanente como saldo a favor.

3. Cálculo de pagos con "Aplicar deuda" ON:
   - Total a cubrir = total venta actual + deuda cliente
   - Entrada de efectivo (o total de medios) actualiza en tiempo real:
     * "Venta actual: $X"
     * "Cancela deuda: $Y"
     * "Saldo a favor: $Z" (si se sobrepaga) o "Falta: $Z" (si falta)
   - En confirmar: única transacción que registra los 3 movimientos de forma atómica.

4. `registrarVenta()` debe soportar esto en una sola transacción SQLite:
   - INSERT en `ventas`, `venta_items`, `venta_pagos`
   - Si aplica deuda:
     - INSERT en `cuenta_corriente_movimientos` (tipo='pago', monto = deuda, descripcion = 'Cancelación de deuda al momento de venta #ID')
   - Si hay remanente a favor:
     - INSERT en `cuenta_corriente_movimientos` (tipo='saldo_favor', monto = -remanente)
   - Resultado neto: balance cliente siempre un único valor consistente (nunca simultánea deuda y crédito).

5. Orden de aplicación de deuda: FIFO (deudas más antiguas primero).

6. El saldo del cliente mostrado en toda la app debe ser figura neta única:
   - Positivo = debe (rojo)
   - Negativo = a favor (verde)
   - Cero = saldado

---

### 5.4 MÓDULO: CAJA

**Campos de sesión de caja:**
```
id (UUID)
sucursal_id
usuario_apertura_id
usuario_cierre_id
fecha_apertura
fecha_cierre
saldo_inicial_efectivo
total_ventas_efectivo
total_ventas_mercadopago
total_ventas_tarjeta
total_ventas_transferencia
total_ventas_cuentacorriente
total_egresos
saldo_final_esperado
saldo_final_real (ingresado en cierre)
diferencia (calculada)
detalle_billetes (JSON: {1000: n, 2000: n, ...})
estado (abierta | cerrada)
```

#### Arqueo de caja
- Recuento de billetes por denominación
- Comparación automática con saldo esperado
- Registro de egresos (gastos, retiros)
- Informe de cierre imprimible

---

### 5.5 MÓDULO: COMBOS Y PROMOCIONES

**Tipos de promoción:**
- **Combo fijo:** N productos a precio especial (ej: shampoo + acondicionador = $5.000)
- **Descuento por cantidad:** llevá 3 pagá 2
- **Descuento por monto:** 10% off en productos de una categoría
- **Vigencia:** fecha desde/hasta (o sin vencimiento)
- **Por sucursal o global**

**Tabla promociones:**
```
id, nombre, tipo, descripcion
fecha_desde, fecha_hasta
activa (boolean)
aplica_a (global | categoria | producto_especifico)
valor_descuento, tipo_descuento (porcentaje | monto_fijo)
productos[] (para combos)
```

---

### 5.6 MÓDULO: COMPRAS — LECTURA DE FACTURAS POR IMAGEN

#### Flujo completo
1. El usuario abre "Cargar factura de compra"
2. Sube o toma foto de la factura
3. El sistema verifica si hay template guardado para ese proveedor (por CUIT o nombre)
4. **Si hay template:** usa Tesseract.js offline para extraer datos según el template
5. **Si no hay template:** envía imagen a la API de Claude → extrae datos → guarda template para próximas veces
6. El sistema muestra un formulario pre-cargado con:
   - Proveedor identificado
   - Lista de artículos con código, nombre, cantidad, costo unitario
7. El usuario verifica y confirma cada ítem
8. Para cada artículo con costo diferente al registrado:
   - Sistema alerta: "El costo de [producto] cambió de $X a $Y"
   - Si el producto tiene familia: "¿Deseás actualizar toda la familia?"
9. Al confirmar:
   - Se registra la compra en el sistema
   - Se actualiza el stock
   - Se actualizan costos si el usuario lo aprobó
10. **Informe post-carga:** lista de productos con costo modificado + botón "Actualizar precio de venta e imprimir etiqueta"

#### Template de proveedor (guardado localmente)
```json
{
  "proveedor_cuit": "20-12345678-9",
  "proveedor_nombre": "Pepsico SA",
  "campos": {
    "fecha": { "region": [x1, y1, x2, y2], "formato": "DD/MM/YYYY" },
    "numero_factura": { "region": [...] },
    "items_tabla": { "region": [...], "columnas": ["codigo", "descripcion", "cantidad", "precio_unit"] }
  },
  "ultima_actualizacion": "2025-01-01"
}
```

---

### 5.7 MÓDULO: ÓRDENES DE COMPRA

#### Generación de órdenes
- Manual: el usuario selecciona productos y cantidades
- Automática: el sistema sugiere reponer productos bajo stock mínimo

#### Importación desde Excel
- Formato esperado: columnas `codigo_barras | nombre | cantidad`
- El sistema importa el Excel y crea la orden de compra

#### Recepción de mercadería
1. La empleada abre la orden de compra pendiente
2. Escanea o selecciona cada producto recibido
3. Confirma la cantidad real recibida vs. la pedida
4. Productos no entregados quedan en estado "pendiente"
5. Los pendientes aparecen en un listado especial: "Productos a conseguir"

**Estados de una orden:**
- `borrador` → `enviada` → `recibida_parcial` → `cerrada`

---

### 5.8 MÓDULO: PROVEEDORES

**Campos de proveedor:**
```
id (UUID)
razon_social
cuit
telefono
email
contacto_nombre
condicion_pago (contado | 30 días | etc.)
activo
```

---

### 5.9 MÓDULO: ETIQUETAS DE PRECIO

- Diseño de etiqueta configurable (tamaño, campos a mostrar)
- Impresión en hoja A4 (grilla de etiquetas)
- Posibles campos: nombre, precio, código de barras, fecha
- Selección de múltiples productos para imprimir en lote
- Disparo automático desde el módulo de compras cuando cambia el precio

---

### 5.10 MÓDULO: INFORMES

| Informe | Filtros | Descripción |
|---|---|---|
| Ventas por producto | Período, sucursal, categoría | Cantidad vendida y total $ por producto |
| Ventas por vendedor | Período, sucursal, vendedor | Subtotal por vendedor, base para comisiones |
| Comisiones | Período, vendedor | Calcula comisiones según % configurado por producto/categoría |
| Cuenta corriente | Cliente | Historial completo de movimientos |
| Stock actual | Sucursal, categoría | Stock actual vs. mínimo |
| Productos bajo mínimo | Sucursal | Lista de productos a reponer |
| Compras del período | Período, proveedor | Total de compras registradas |
| Cierre de caja | Fecha, sucursal | Resumen de cada sesión de caja |
| Rentabilidad | Período | Costo vs. precio de venta por producto |

#### Comisiones diferenciadas
- Cada producto/categoría puede tener un % de comisión asignado
- El informe de vendedor calcula: Σ (ventas_producto × comision_producto)

---

## 6. ESTRUCTURA DE ARCHIVOS

```
/sga
├── index.html                  # Entry point
├── manifest.json               # PWA manifest (opcional)
├── /css
│   ├── reset.css
│   ├── variables.css           # Design tokens (colores, fuentes, espaciados)
│   ├── layout.css              # Grid, sidebar, header
│   └── components.css          # Botones, tablas, formularios, modales
├── /js
│   ├── app.js                  # Router SPA, inicialización
│   ├── db.js                   # Capa de abstracción SQLite/IndexedDB
│   ├── sync.js                 # Lógica de sincronización con Firestore
│   ├── auth.js                 # Firebase Auth
│   ├── utils.js                # Helpers generales
│   ├── print.js                # Utilidades de impresión
│   └── /modules
│       ├── productos.js
│       ├── pos.js
│       ├── clientes.js
│       ├── caja.js
│       ├── compras.js
│       ├── ordenes.js
│       ├── proveedores.js
│       ├── promociones.js
│       ├── etiquetas.js
│       └── informes.js
├── /views
│   ├── pos.html
│   ├── productos.html
│   ├── clientes.html
│   ├── caja.html
│   ├── compras.html
│   ├── ordenes.html
│   ├── proveedores.html
│   ├── promociones.html
│   ├── etiquetas.html
│   └── informes.html
├── /templates
│   └── facturas/               # Templates OCR por proveedor (JSON)
└── SPEC.md                     # Este archivo
```

---

## 7. ESQUEMA DE BASE DE DATOS (SQLite)

### Tablas principales

```sql
-- SUCURSALES
CREATE TABLE sucursales (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  direccion TEXT,
  activa INTEGER DEFAULT 1
);

-- USUARIOS
CREATE TABLE usuarios (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT UNIQUE,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK(rol IN ('admin','encargado','cajero')),
  sucursal_id TEXT REFERENCES sucursales(id),
  activo INTEGER DEFAULT 1
);

-- CATEGORIAS
CREATE TABLE categorias (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  comision_pct REAL DEFAULT 0
);

-- PROVEEDORES
CREATE TABLE proveedores (
  id TEXT PRIMARY KEY,
  razon_social TEXT NOT NULL,
  cuit TEXT,
  telefono TEXT,
  email TEXT,
  contacto_nombre TEXT,
  condicion_pago TEXT,
  activo INTEGER DEFAULT 1
);

-- PRODUCTOS
CREATE TABLE productos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  categoria_id TEXT REFERENCES categorias(id),
  proveedor_principal_id TEXT REFERENCES proveedores(id),
  proveedor_alternativo_id TEXT REFERENCES proveedores(id),
  producto_madre_id TEXT REFERENCES productos(id),
  es_madre INTEGER DEFAULT 0,
  precio_independiente INTEGER DEFAULT 0,
  costo REAL NOT NULL DEFAULT 0,
  precio_venta REAL NOT NULL DEFAULT 0,
  comision_pct_override REAL,
  unidad_medida TEXT DEFAULT 'unidad',
  stock_minimo REAL DEFAULT 0,
  activo INTEGER DEFAULT 1,
  fecha_alta TEXT,
  fecha_modificacion TEXT
);

-- CODIGOS DE BARRAS (múltiples por producto)
CREATE TABLE codigos_barras (
  id TEXT PRIMARY KEY,
  producto_id TEXT NOT NULL REFERENCES productos(id),
  codigo TEXT NOT NULL UNIQUE,
  es_principal INTEGER DEFAULT 0
);

-- SUSTITUTOS
CREATE TABLE producto_sustitutos (
  producto_id TEXT REFERENCES productos(id),
  sustituto_id TEXT REFERENCES productos(id),
  activo INTEGER DEFAULT 1,
  fecha_asignacion TEXT,
  PRIMARY KEY (producto_id, sustituto_id)
);

-- STOCK POR SUCURSAL
CREATE TABLE stock (
  producto_id TEXT REFERENCES productos(id),
  sucursal_id TEXT REFERENCES sucursales(id),
  cantidad REAL DEFAULT 0,
  fecha_modificacion TEXT,
  PRIMARY KEY (producto_id, sucursal_id)
);

-- CLIENTES
CREATE TABLE clientes (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  apellido TEXT,
  telefono TEXT,
  email TEXT,
  dni TEXT,
  fecha_alta TEXT,
  activo INTEGER DEFAULT 1
);

-- CUENTA CORRIENTE
CREATE TABLE cuenta_corriente (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  sucursal_id TEXT REFERENCES sucursales(id),
  tipo TEXT NOT NULL CHECK(tipo IN ('venta_fiada','pago','saldo_favor','ajuste')),
  monto REAL NOT NULL,
  venta_id TEXT,
  descripcion TEXT,
  fecha TEXT NOT NULL,
  usuario_id TEXT REFERENCES usuarios(id)
);

-- SESIONES DE CAJA
CREATE TABLE sesiones_caja (
  id TEXT PRIMARY KEY,
  sucursal_id TEXT REFERENCES sucursales(id),
  usuario_apertura_id TEXT REFERENCES usuarios(id),
  usuario_cierre_id TEXT REFERENCES usuarios(id),
  fecha_apertura TEXT,
  fecha_cierre TEXT,
  saldo_inicial REAL DEFAULT 0,
  total_efectivo REAL DEFAULT 0,
  total_mercadopago REAL DEFAULT 0,
  total_tarjeta REAL DEFAULT 0,
  total_transferencia REAL DEFAULT 0,
  total_cuenta_corriente REAL DEFAULT 0,
  total_egresos REAL DEFAULT 0,
  saldo_final_esperado REAL DEFAULT 0,
  saldo_final_real REAL,
  diferencia REAL,
  detalle_billetes TEXT,
  estado TEXT DEFAULT 'abierta' CHECK(estado IN ('abierta','cerrada'))
);

-- EGRESOS DE CAJA
CREATE TABLE egresos_caja (
  id TEXT PRIMARY KEY,
  sesion_caja_id TEXT REFERENCES sesiones_caja(id),
  monto REAL NOT NULL,
  descripcion TEXT,
  fecha TEXT,
  usuario_id TEXT REFERENCES usuarios(id)
);

-- VENTAS
CREATE TABLE ventas (
  id TEXT PRIMARY KEY,
  sucursal_id TEXT REFERENCES sucursales(id),
  sesion_caja_id TEXT REFERENCES sesiones_caja(id),
  cliente_id TEXT REFERENCES clientes(id),
  usuario_id TEXT REFERENCES usuarios(id),
  fecha TEXT NOT NULL,
  subtotal REAL,
  descuento REAL DEFAULT 0,
  total REAL,
  estado TEXT DEFAULT 'completada'
);

-- ITEMS DE VENTA
CREATE TABLE venta_items (
  id TEXT PRIMARY KEY,
  venta_id TEXT REFERENCES ventas(id),
  producto_id TEXT REFERENCES productos(id),
  cantidad REAL,
  precio_unitario REAL,
  costo_unitario REAL,
  descuento_item REAL DEFAULT 0,
  subtotal REAL,
  comision_pct REAL DEFAULT 0
);

-- PAGOS DE VENTA
CREATE TABLE venta_pagos (
  id TEXT PRIMARY KEY,
  venta_id TEXT REFERENCES ventas(id),
  medio TEXT NOT NULL CHECK(medio IN ('efectivo','mercadopago','tarjeta','transferencia','cuenta_corriente')),
  monto REAL NOT NULL,
  referencia TEXT
);

-- COMPRAS
CREATE TABLE compras (
  id TEXT PRIMARY KEY,
  sucursal_id TEXT REFERENCES sucursales(id),
  proveedor_id TEXT REFERENCES proveedores(id),
  usuario_id TEXT REFERENCES usuarios(id),
  fecha TEXT,
  numero_factura TEXT,
  total REAL,
  imagen_path TEXT,
  procesado_por TEXT CHECK(procesado_por IN ('template_offline','claude_api'))
);

-- ITEMS DE COMPRA
CREATE TABLE compra_items (
  id TEXT PRIMARY KEY,
  compra_id TEXT REFERENCES compras(id),
  producto_id TEXT REFERENCES productos(id),
  cantidad REAL,
  costo_unitario REAL,
  costo_anterior REAL,
  subtotal REAL,
  costo_modificado INTEGER DEFAULT 0
);

-- ÓRDENES DE COMPRA
CREATE TABLE ordenes_compra (
  id TEXT PRIMARY KEY,
  sucursal_id TEXT REFERENCES sucursales(id),
  proveedor_id TEXT REFERENCES proveedores(id),
  usuario_id TEXT REFERENCES usuarios(id),
  fecha_creacion TEXT,
  fecha_entrega TEXT,
  estado TEXT DEFAULT 'borrador' CHECK(estado IN ('borrador','enviada','recibida_parcial','cerrada')),
  notas TEXT
);

-- ITEMS DE ORDEN DE COMPRA
CREATE TABLE orden_compra_items (
  id TEXT PRIMARY KEY,
  orden_id TEXT REFERENCES ordenes_compra(id),
  producto_id TEXT REFERENCES productos(id),
  cantidad_pedida REAL,
  cantidad_recibida REAL DEFAULT 0,
  estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','recibido','recibido_parcial','no_entregado'))
);

-- PROMOCIONES
CREATE TABLE promociones (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT CHECK(tipo IN ('combo','descuento_cantidad','descuento_monto')),
  descripcion TEXT,
  fecha_desde TEXT,
  fecha_hasta TEXT,
  activa INTEGER DEFAULT 1,
  aplica_a TEXT,
  valor_descuento REAL,
  tipo_descuento TEXT CHECK(tipo_descuento IN ('porcentaje','monto_fijo'))
);

-- ITEMS DE PROMOCION
CREATE TABLE promocion_items (
  promocion_id TEXT REFERENCES promociones(id),
  producto_id TEXT REFERENCES productos(id),
  cantidad_requerida REAL DEFAULT 1,
  PRIMARY KEY (promocion_id, producto_id)
);
```

---

## 8. FLUJOS CRÍTICOS DETALLADOS

### Flujo: Cambio de costo en familia de productos
```
1. Se detecta cambio de costo en producto X
2. ¿X tiene producto_madre_id o es_madre = true?
   → SÍ: "El producto X pertenece a la familia [Nombre Madre]. 
          ¿Deseas actualizar el costo de toda la familia?"
   → Acepta: UPDATE costo WHERE producto_madre_id = madre_id OR id = madre_id
   → Rechaza: UPDATE costo WHERE id = producto_id
3. Mostrar resumen: "Se actualizaron N productos de la familia"
4. Mostrar botón: "¿Actualizar precios de venta e imprimir etiquetas?"
```

### Flujo: Stock con sustitutos
```
stock_disponible(producto_id) =
  stock(producto_id) +
  SUM(stock(sustituto_id)) WHERE activo = 1
  
Para alerta de stock mínimo:
  IF stock_disponible < stock_minimo → alertar reposición
```

### Flujo: Vuelto como saldo a favor
```
1. Total venta = $1.800
2. Cliente paga $2.000 efectivo
3. Vuelto = $200
4. Pregunta: "¿El vuelto de $200 queda como saldo a favor del cliente?"
   → SÍ: INSERT cuenta_corriente (tipo='saldo_favor', monto=-200)
   → NO: registrar entrega de vuelto en efectivo
```

---

## 9. CONVENCIONES DE CÓDIGO

- **IDs:** UUID v4 generados en el cliente (`crypto.randomUUID()`)
- **Fechas:** ISO 8601 en UTC (`new Date().toISOString()`)
- **Montos:** Siempre `REAL` en SQLite, nunca `INTEGER` para evitar errores de redondeo
- **Módulos JS:** Patrón módulo con IIFE o ES Modules nativos
- **Eventos:** Custom Events para comunicación entre módulos
- **Estilos:** Variables CSS en `:root`, sin frameworks CSS
- **Sincronización:** Cada tabla tiene campo `sync_status` ('pending' | 'synced') y `updated_at`

---

## 10. CONFIGURACIÓN DE FIREBASE

```javascript
// config/firebase.js
const firebaseConfig = {
  // Completar con datos del proyecto Firebase
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
```

**Colecciones Firestore (espejo de SQLite para sincronización):**
- `ventas/{sucursal_id}/{venta_id}`
- `stock/{sucursal_id}/{producto_id}`
- `productos/{producto_id}`
- `clientes/{cliente_id}`
- `cuenta_corriente/{cliente_id}/movimientos/{mov_id}`

---

## 11. API DE CLAUDE (OCR DE FACTURAS)

```javascript
// Prompt para Claude al procesar factura nueva
const prompt = `
Analizá esta imagen de factura de compra argentina.
Extraé la siguiente información en formato JSON:
{
  "proveedor_cuit": "",
  "proveedor_nombre": "",
  "numero_factura": "",
  "fecha": "DD/MM/YYYY",
  "items": [
    {
      "codigo": "",
      "descripcion": "",
      "cantidad": 0,
      "precio_unitario": 0,
      "subtotal": 0
    }
  ],
  "total": 0
}
Respondé SOLO con el JSON, sin texto adicional.
`;
```

---

## 12. DECISIONES DE DISEÑO Y RESTRICCIONES

| Decisión | Motivo |
|---|---|
| Sin framework JS | Coherencia con el proyecto anterior del equipo |
| SQLite via OPFS | Consultas relacionales complejas que IndexedDB no soporta bien |
| Tesseract.js para OCR offline | No requiere instalación adicional, funciona en browser |
| Templates por proveedor | Reduce llamadas a API de Claude al mínimo indispensable |
| Precios globales | El dueño decide precios centralmente |
| Stock por sucursal | Cada sucursal maneja su inventario físico |
| Firebase Auth | Reutilizar conocimiento del equipo, robusto y gratuito en este volumen |

---

## 13. FASES DE DESARROLLO SUGERIDAS

### Fase 1 — Base (MVP)
- Setup del proyecto, estructura de archivos, DB SQLite
- Auth (Firebase)
- ABM de productos (con familia y sustitutos)
- ABM de proveedores y clientes
- Punto de venta básico (efectivo)

### Fase 2 — Operaciones
- Todos los medios de pago
- Cuenta corriente completa
- Caja (apertura, cierre, arqueo)
- Combos y promociones

### Fase 3 — Compras
- Órdenes de compra (manual + importación Excel)
- Recepción de mercadería
- Módulo de compras manual

### Fase 4 — OCR de facturas
- Integración Tesseract.js
- Integración API de Claude
- Sistema de templates por proveedor

### Fase 5 — Informes y etiquetas
- Todos los informes
- Módulo de etiquetas
- Impresión de tickets

### Fase 6 — Multi-sucursal y sync
- Lógica de sincronización con Firestore
- Gestión de conflictos
- Dashboard multi-sucursal

---

*Este SPEC.md debe estar presente en la raíz del proyecto y ser referenciado al inicio de cada sesión de Claude Code.*
