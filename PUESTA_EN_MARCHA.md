# Puesta en marcha — Admin-POS (casa) + POS (local)

Instrucciones para alinear las dos computadoras y empezar a trabajar de forma real.

## Resumen del sistema

- **POS** — https://seamusdolan89-alt.github.io/sistema-kalulu/views/login.html
  Lo usan las cajeras en el local, para vender.
- **Admin-POS** — https://seamusdolan89-alt.github.io/sistema-kalulu/views/login.html?returnTo=../admin-pos/
  Lo usás vos, desde tu casa, para gestión (productos, compras, proveedores, informes, usuarios). No se vende desde acá.
- Ambos son la misma app, se sincronizan entre sí a través de Firebase de forma **automática cada 5 minutos en los dos sentidos** (más un botón **"⬇⬆ Sincronizar"** en admin-pos para forzarlo ya — ver abajo).

## Paso 1 — Alinear las dos computadoras (una sola vez)

Hoy cada compu tiene su propio usuario "admin" con contraseña distinta, porque `usuarios` nunca sincronizó hasta ahora. Se soluciona así:

1. **En esta PC** (tu casa): botón 💾 (arriba a la derecha) → **Exportar backup**. Se descarga un archivo `kalulu-backup-YYYY-MM-DD.sqlite`.
2. **En la PC del local**: entrar a `login.html` → botón **"Restaurar backup"** → elegir ese archivo.
   - ⚠️ Esto reemplaza *toda* la base local del local (usuarios, productos, stock tal cual estén en esta PC en ese momento). Hacerlo con la app cerrada/sin ventas en curso en el local.
3. Listo: de ahí en adelante, **usás el mismo usuario `admin` en las dos computadoras** (el de esta PC — no el `admin123` de fábrica, que desaparece con el restore).

## Paso 2 — Crear las cuentas de las cajeras

- Andá al módulo **Usuarios** (podés hacerlo desde el local directamente, ya que vas a estar ahí para el Paso 1).
- Si en algún momento creás o editás un usuario **desde admin-pos** (tu casa), se sube solo en unos minutos (automático); si querés que le llegue al local ya, apretá el botón **"⬇⬆ Sincronizar"** (arriba a la derecha en admin-pos).

## Cómo funciona la sincronización, de acá en adelante

| Acción | ¿Cuándo pasa? |
|---|---|
| **Admin-POS → Firestore → POS** (productos, precios, proveedores, clientes, stock, usuarios, compras, gastos, promociones, **cajas y medios de pago**, etc. que cargues desde tu casa) | **Automático cada 5 minutos** (desde 16/9/2026 — antes era manual). El botón **"⬇⬆ Sincronizar"** en admin-pos hace lo mismo al toque, para no esperar: trae lo que pasó en el local Y manda tus cambios, en un solo click. Si trajo algo nuevo, la página se recarga sola (solo con el botón — el ciclo automático de fondo no recarga la pantalla, para no interrumpirte si estás cargando algo). |
| **POS → Firestore → Admin-POS** (ventas, stock, caja, ingresos de caja, compras/gastos, **consumo interno/roturas/vencimientos, cuenta corriente de clientes** cargados en el local) | **100% automático.** La cajera no tiene que hacer nada — sube apenas se completa cada acción, más un respaldo cada 5 minutos. Vos lo ves en admin-pos apretando **"⬇⬆ Sincronizar"** cuando quieras revisarlo ya (si trajo algo nuevo, también se recarga sola). |
| **Cuenta corriente de clientes** (fiado) | Bidireccional, igual que productos/clientes: automático cada 5 min en los dos sentidos, o al toque con "Sincronizar". |
| **Usuarios / contraseñas** | Sincronizan igual que el resto, pero con un límite: una compu **sin ningún usuario local todavía** no puede loguearse para arrancar el sync sola — siempre hace falta restaurar un backup primero en una compu nueva/vacía (ver Paso 1). Una vez que esa compu ya tiene al menos un usuario y pudo loguearse, el resto de los datos (incluidas cajas y medios de pago) se completan solos desde Firestore. |

Si justo edita lo mismo desde las dos puntas casi al mismo tiempo, gana la
copia que todavía no se subió — el otro cambio no se pierde, se reintenta
solo en el próximo ciclo (cada 5 min) hasta que se resuelve. No hace falta
ningún paso manual para eso.

**Cargas masivas** (ej. importar cientos de productos de una vez desde Excel): el sync ya está preparado para vaciar la cola completa en un solo ciclo, no se corta a mitad de camino como pasaba antes.

## Si necesitás resetear la contraseña de una cajera

Entrá como admin **en la misma computadora donde vive ese usuario** (hoy: el local) → módulo Usuarios → editar → poner nueva contraseña (no hace falta la anterior). No se puede hacer a distancia desde admin-pos salvo que antes hayas sincronizado ese usuario (Sincronizar) o restaurado un backup.

## Backups — por qué conviene el hábito

Lo único que **no** se recupera solo desde Firestore ante una rotura de la PC del local son `usuarios` (por el límite explicado arriba: sin login local no arranca ningún sync). Todo lo demás — productos, stock, proveedores, clientes, compras, gastos, cajas, medios de pago, cuenta corriente, etc. — ya vive en Firestore y se puede volver a bajar en cualquier compu nueva, una vez que esa compu pudo loguearse con el usuario restaurado.

- Backup manual (botón 💾 → Exportar) cada tanto — alcanza con hacerlo cuando agregues/edites usuarios, o una vez por semana.
- Guardalo en un lugar que no dependa de esa PC (por ejemplo, tu carpeta de Dropbox de este proyecto).
- Peor caso (se rompe la PC del local sin aviso): restaurás el último backup en la compu de reemplazo (usuarios/sucursal vuelven tal cual estaban) y dejás que el sync automático traiga fresco todo lo demás desde Firestore.

## Antes de migrar el catálogo real: limpiar los datos de prueba

Todo lo cargado hasta ahora (productos, ventas, stock, consumo interno, etc.) fue de prueba. Antes de importar el Excel real, conviene arrancar limpio:

1. Andá a `#limpieza_prueba` en cualquiera de las dos apps (ej. `.../index.html#limpieza_prueba` o `.../admin-pos/index.html#limpieza_prueba`). No está en el menú — hay que escribir la URL a mano. Solo funciona logueado como admin.
2. Botón **"Borrar datos de prueba (este dispositivo)"** — repetirlo en **cada** dispositivo por separado (tu compu y la del local): el sync nunca borra, solo agrega/actualiza, así que hay que vaciar cada base local a mano.
3. Botón **"Borrar también en Firestore"** — correrlo **una sola vez**, desde cualquiera de los dos, después de haber limpiado los locales. Si no se hace esto, los datos de prueba vuelven a bajar solos al primer sync.
4. Se conservan siempre: usuarios, cajas, medios de pago y proveedores (estos últimos quedan con cuenta corriente en $0). Todo lo demás se borra.

Recién después de este paso, importar el Excel real desde el módulo Productos (import masivo).
