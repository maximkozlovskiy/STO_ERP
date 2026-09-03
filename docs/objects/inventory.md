# Good / Inventory — Dossier

> Товар (Good) + залишки (StockItem) + рухи (StockMovement) + партії (StockBatch) + собівартість.

## Ключові факти

- `StockItem` — агрегат поточного залишку по (orgId, goodId, warehouseId): `quantity`, `reserved`.
- `StockMovement` — append-only: RECEIPT/WRITEOFF/TRANSFER/RESERVATION/RESERVATION_RELEASE/OPENING_BALANCE.
- Мутація залишків ТІЛЬКИ через `InventoryService.createMovement()` (єдина точка правди).
- `deduplicateBy(plan, u => u.goodId)` перед `Promise.all` bulk-update цін.

## Партії та собівартість (batch/COGS)

- **`StockBatch`** — партія: `costPrice` (собівартість одиниці), `salePrice`, `receivedQty`/`remainingQty`,
  `expiryDate`, `isActive`, `createdAt` (FIFO-впорядкування), `stockMovementId` @unique (1:1 з RECEIPT).
- **Надходження:** `createMovement(RECEIPT)` → `batchService.createFromReceipt` створює партію з
  `costPrice` = ціна рядка PO (fallback `Good.purchasePrice`, або 0 для безкоштовних зразків).
- **Списання (COGS) — ЦЕНТРАЛІЗОВАНО у `createMovement`:** для розходу (`quantityDelta<0`, не reservation)
  викликається `batchService.consumeBatch` за **методом обліку з налаштувань**
  (`OrganisationSettings.costMethod`: FIFO/FEFO/LIFO/AVG_COST, редагується у НДІ→Організація «Метод
  списання партій»). Повертає `weightedCostPrice` (зважена COGS зі списаних партій).
  - **FIFO** — найстаріша партія перша (`createdAt asc`); **LIFO** — найновіша (`createdAt desc`);
    **FEFO** — за `expiryDate asc nulls:last`; **AVG_COST** — `weightedCostPrice=getAvgCost`, але
    фізичний декремент партій усе одно FIFO (щоб `remainingQty` спадав).
  - Span через кілька партій підтримано (while-пагінація); нестача → BadRequest (гейт `available`
    кидає ДО consume). Кожне списання → `BatchConsumption` (append-only лог).
- **COGS у наряді:** `writeOffPartsAndCharge` фіксує `weightedCostPrice` у `WorkOrderPart.batchCostPrice`
  (+`batchId` при single-batch, NULL при span). Звіт рентабельності (`reports.profitability`) бере
  `COALESCE(batchCostPrice, Good.purchasePrice)` → маржа точна.
- **TRANSFER:** writeoff зі складу-джерела списує партії FIFO; цільова партія створюється з **собівартістю
  джерела** (`weightedCostPrice`), не з ціною продажу.
- **ІНВАРІАНТ:** `Σ remainingQty(active) == StockItem.quantity` — тримається за конструкцією
  (consume + upsert StockItem в одній `$transaction`).
- **НЕ-ВІДʼЄМНІСТЬ (Bug #613, 3 рівні захисту):** concurrent WRITEOFF того самого товару міг лишити
  `quantity`/`remainingQty` від'ємними (pre-check `available>=|qty|` читає STALE snapshot без row-lock).
  Захист: (1) pre-check (рання відмова); (2) **post-upsert re-check** `quantity>=0 && reserved>=0` через
  `.select` (RETURNING, 0 RTT) → throw → rollback + **conditional `updateMany({remainingQty:{gte:take}})`**
  (CAS: count=0 при програній гонці → throw); (3) **DB CHECK** `stock_items_quantity_nonneg` +
  `stock_batches_remaining_nonneg` (міграція `20260902210000`) — джерело-правди backstop для будь-якого
  забутого/майбутнього writer (sync-merge). App-throw дає локалізоване повідомлення, CHECK — 23514.
- **АТОМАРНІСТЬ:** `createMovement` без переданого `tx` самообгортається у `$transaction` (no-tx self-wrap),
  щоб multi-write (movement + consume + upsert + BatchConsumption) відкочувався цілком при throw.

> ⚠️ **Історія:** до 2026-09-02 `consumeBatch` НЕ викликався з розходів («мертвий код») —
> партії лише створювались (RECEIPT), `remainingQty` монотонно ріс, COGS = ціна продажу,
> `batchCostPrice` завжди NULL, налаштування методу ігнорувалось. Виправлено централізацією
> у createMovement + reconcile-міграція `20260902130000` (FIFO-доспоживає надлишок для прод).

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) · [docs/objects/purchase-order.md](purchase-order.md)
