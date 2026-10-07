# Good / Inventory — Dossier

> Товар (Good) + залишки (StockItem) + рухи (StockMovement) + партії (StockBatch) + собівартість.

> **UI:** сторінка залишків тепер — вкладка **«Залишки»** на сторінці «Склад»
> (`/stock-documents?tab=stock`), компонент `app/(app)/inventory/InventoryTab.tsx`. Маршрут
> `/inventory` — redirect на цю вкладку. Деталі — `docs/objects/stock-document.md` (секція UI).

## Ключові факти

- `StockItem` — агрегат поточного залишку по (orgId, goodId, warehouseId): `quantity`, `reserved`.
- `StockMovement` — append-only: RECEIPT/WRITEOFF/TRANSFER/RESERVATION/RESERVATION_RELEASE/OPENING_BALANCE/RETURN.
  Незмінність ФІЗИЧНА (plpgsql BEFORE ROW тригер `trg_stock_movements_immutable`, міграція 20260917120000):
  DELETE завжди заборонено; UPDATE дозволено ЛИШЕ одноразове `batchId` NULL→value (createMovement single-batch
  трасування) — тригер порівнює цілий рядок через `to_jsonb` (усі інші колонки, включно з `price`, незмінні).
  Реверс WRITEOFF (RETURN) — компенсуючий BatchConsumption, НІКОЛИ DELETE/UPDATE існуючого руху.
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
- **RETURN (реверс WRITEOFF, C2):** повернення на склад при COMPLETED→CANCELLED наряду. Позитивна
  к-сть → інкремент `StockItem.quantity` + `restoreBatchesForReturn`: знаходить негативні
  `BatchConsumption` документа, **агрегує по `batchId` у межах усього документа** й кличе
  `returnToBatch` РАЗ на партію (idempotency-guard `returnToBatch` ігнорує `documentLineId` → по-рядкові
  виклики на спільну партію тихо недоповернули б → злам Σ-інваріанту). 0 рядків (AVG_COST-агрегат /
  списання без партій) → лише StockItem++. Guard: RETURN без documentType/documentId або від'ємна к-сть → 400.
  НЕ створює нову партію (не в `BATCH_CREATING_INFLOW`).

> ⚠️ **Історія:** до 2026-09-02 `consumeBatch` НЕ викликався з розходів («мертвий код») —
> партії лише створювались (RECEIPT), `remainingQty` монотонно ріс, COGS = ціна продажу,
> `batchCostPrice` завжди NULL, налаштування методу ігнорувалось. Виправлено централізацією
> у createMovement + reconcile-міграція `20260902130000` (FIFO-доспоживає надлишок для прод).

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) · [docs/objects/purchase-order.md](purchase-order.md)

---

## Бізнес-правила (BR-INVT)

> Правила виведено з коду 2026-10-07, власником не затверджені.

- **BR-INVT-001**: Залишки й партії змінює лише `InventoryService.createMovement()`: у коді api немає жодного запису в `StockItem`, `StockMovement`, `StockBatch`, `BatchConsumption` поза `inventory.service.ts` і `batch.service.ts` — ні через Prisma, ні сирим SQL, ні через sync push. Єдиний запис повз `createMovement` — `updateMinStock`, що пише лише поріг `minStock`.
- **BR-INVT-002**: Рух із кількістю 0, `NaN` чи нескінченністю або з нечисловою ціною відхиляється (400) до будь-якого запису.
- **BR-INVT-003**: Розхід (від'ємна кількість будь-якого типу, крім `RESERVATION_RELEASE`) дозволений лише в межах доступного `available = quantity − reserved`; інакше 400 і рух не записується.
- **BR-INVT-004**: `RESERVATION` і `RESERVATION_RELEASE` змінюють тільки `reserved`: фізична `quantity` і партії лишаються без змін.
- **BR-INVT-005**: `RESERVATION` відхиляється, якщо кількість більша за `available`; `RESERVATION_RELEASE` приймає лише від'ємну кількість і не може зняти більше, ніж зарезервовано.
- **BR-INVT-006**: Після запису руху перевіряються фактичні значення рядка залишку: `quantity ≥ 0`, `reserved ≥ 0`, `reserved ≤ quantity`. Порушення (конкурентний рух проскочив попередню перевірку) → 400 і відкат усієї транзакції.
- **BR-INVT-007**: Рух атомарний: запис руху, зміна залишку, партії та журнал списань ідуть в одній транзакції; якщо викликач транзакцію не передав, `createMovement` відкриває власну.
- **BR-INVT-008**: Кожен додатний `RECEIPT` і `OPENING_BALANCE` створює партію на всю кількість руху. Собівартість партії — ціна руху (0 — теж ціна), без ціни — `Good.purchasePrice`, без неї — 0.
- **BR-INVT-009**: Фізичний розхід списує партії методом `OrganisationSettings.costMethod` (не задано або налаштування недоступні — FIFO) і повертає зважену собівартість списаного: `Σ(кількість × costPrice) / Σ кількість`.
- **BR-INVT-010**: При методі `AVG_COST` собівартість розходу — зважена середня активних партій (`Σ remainingQty × costPrice / Σ remainingQty`), порахована ДО списання; самі партії зменшуються в порядку FIFO.
- **BR-INVT-011**: Порядок списання партій: FIFO — від найстарішої (`createdAt asc`), LIFO — від найновішої (`createdAt desc`), FEFO — за `expiryDate asc`, партії без терміну придатності останніми.
- **BR-INVT-012**: Партія не йде в мінус: зменшення умовне (`remainingQty ≥ кількість`). Якщо умова не спрацювала (конкурентне списання) або активних партій не вистачило — 400 і відкат.
- **BR-INVT-013**: Кожне списання з партії лишає запис `BatchConsumption` з від'ємною кількістю та посиланням на документ і його рядок.
- **BR-INVT-014**: `RETURN` приймає лише додатну кількість і лише з посиланням на документ-джерело. Він збільшує `quantity`, нової партії не створює, а повертає товар у ті самі партії, з яких документ списував, — один раз на партію, сумою всіх списань документа з неї.
- **BR-INVT-015**: Повернення в партію ідемпотентне за парою (партія, документ) і не може підняти `remainingQty` вище `receivedQty` (інакше 400).
- **BR-INVT-016**: `StockMovement` — append-only: код ніколи не видаляє рух, а єдина зміна наявного руху — проставлення `batchId`, коли розхід списано рівно з однієї партії.
- **BR-INVT-017**: Одиниця виміру, передана в рух, мусить належати організації; чужа або видалена → 400 до будь-якого запису.

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/inventory/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/inventory/`

| Аспект                                                | Тест                                  | Кейсів | Правила                         |
| ----------------------------------------------------- | ------------------------------------- | ------ | ------------------------------- |
| інваріанти партій на моделі у спеку (property-based)  | `batch.invariants.spec.ts`            | 29     | —                               |
| партії: створення, списання, середня, повернення      | `batch.service.spec.ts`               | 21     | BR-INVT-010, 011, 012, 013, 015 |
| HTTP-контракт (DTO, статуси, валідація)               | `batches.contract.spec.ts`            | 4      | —                               |
| by batch                                              | `inventory.by-batch.spec.ts`          | 7      | —                               |
| by document                                           | `inventory.by-document.spec.ts`       | 9      | —                               |
| create movement                                       | `inventory.create-movement.spec.ts`   | 44     | BR-INVT-002…010, 014, 016, 017  |
| find movements                                        | `inventory.find-movements.spec.ts`    | 5      | —                               |
| інваріанти балансу на моделі у спеку (property-based) | `inventory.invariants.spec.ts`        | 8      | —                               |
| єдина точка запису залишків (статичний сторож коду)   | `inventory.single-writer.spec.ts`     | 4      | BR-INVT-001, 016                |
| HTTP-контракт (DTO, статуси, валідація)               | `pricing-rules.contract.spec.ts`      | 25     | —                               |
| сервісна логіка                                       | `pricing.service.spec.ts`             | 34     | —                               |
| WRITEOFF→RETURN на справжніх сервісах, Σ-інваріант    | `return-roundtrip.invariants.spec.ts` | 5      | BR-INVT-013, 014                |
| HTTP-контракт (DTO, статуси, валідація)               | `stock-items.contract.spec.ts`        | 20     | —                               |

Разом: **215** кейсів (цифри з `vitest --reporter=json`, не з grep).

Мітки `// guards: BR-INVT-…` стоять над конкретними `it(`; колонка «Правила» — лише покажчик файла.

**Чого тут НЕМА.** Кожне правило має unit-сторожа, але частину захисту unit-тест із моком Prisma бачити не може:

- Захист на рівні БД — CHECK `stock_items_quantity_nonneg` і `stock_batches_remaining_nonneg`, тригер `trg_stock_movements_immutable` (останній рубіж для правил 006, 012 і 016) — у цьому модулі не перевіряється. Його стережуть integration-спеки на живій БД: `apps/api/src/prisma/schema-integrity.integration.spec.ts` і `append-only-triggers.integration.spec.ts`.
- Справжньої конкурентності (дві паралельні транзакції) немає: перевірки «після запису» (правила 006 і 012) тестуються підставленим результатом `upsert` / `updateMany`, а не гонкою.
- Інваріант `Σ remainingQty(active) == StockItem.quantity` на продукт-коді стережеться лише для циклу WRITEOFF→RETURN (`return-roundtrip.invariants.spec.ts`). `inventory.invariants.spec.ts` і `batch.invariants.spec.ts` перевіряють МОДЕЛЬ, написану в самому спеку, — вони не впадуть, якщо зламати сервіс; для прийому, списання й переміщення наскрізного сторожа інваріанту немає.
- `createMovement` не перевіряє відповідність знака типу руху (крім `RESERVATION_RELEASE` і `RETURN`) і не перевіряє, що `goodId` / `warehouseId` належать організації, — це лишено викликачам, і тест цього не фіксує.
- Сторінка залишків (`InventoryTab`) тут не розглядається: її E2E — `apps/web/e2e/inventory.spec.ts`, опис UI — у `stock-document.md`.
