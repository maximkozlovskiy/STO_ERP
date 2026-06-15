# Good / Inventory — Dossier

> Товар (Good) + залишки (StockItem) + рухи (StockMovement).

_Stub — заповнити при роботі з inventory модулем._

## Ключові факти

- `StockItem` — агрегат поточного залишку по (orgId, goodId, warehouseId)
- `StockMovement` — append-only: RECEIPT/WRITEOFF/TRANSFER/RESERVATION/RESERVATION_RELEASE
- Мутація ТІЛЬКИ через `InventoryService.createMovement()`
- `deduplicateBy(plan, u => u.goodId)` перед `Promise.all` bulk-update цін

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
