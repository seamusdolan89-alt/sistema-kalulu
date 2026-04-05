# Core DB + Sync

## DB
- SQLite via OPFS
- Offline-first

## Sync
- Firebase Firestore

## Reglas
- last-write-wins (general)
- stock usa delta (no overwrite)

## Flujo
1. Guardar cambios localmente
2. Agregar a cola de sync
3. Sincronizar cuando hay internet

## Riesgos
- conflictos de escritura
- consistencia de stock