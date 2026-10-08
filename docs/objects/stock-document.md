# StockDocument — Dossier

> Складський документ: списання, переміщення, початкові залишки, оприбуткування.
> Підтверджений документ створює StockMovement-и та змінює залишки.

---

## Prisma модель

```prisma
model StockDocument {
  id                String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId             String              @db.Uuid
  branchId          String              @db.Uuid
  number            String
  type              StockDocumentType
  status            StockDocumentStatus @default(DRAFT)
  warehouseId       String              @db.Uuid    // source warehouse
  targetWarehouseId String?             @db.Uuid    // тільки для TRANSFER
  purchaseOrderId   String?             @db.Uuid    // опц. замовлення-джерело (Phase D2)
  notes             String?
  confirmedAt       DateTime?
  confirmedBy       String?             @db.Uuid
  documentDate      DateTime            @default(now()) @db.Date
  syncVersion       BigInt              @default(0)
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt
  deletedAt         DateTime?
}

model StockDocumentLine {
  stockDocumentId String    @db.Uuid
  goodId          String    @db.Uuid
  quantity        Float
  price           Decimal?  @db.Decimal(12, 2)
  unitOfMeasureId String?   @db.Uuid
}
```

---

## FSM

```
DRAFT → CONFIRMED
      ↘ CANCELLED
```

Підтвердження документу (`→ CONFIRMED`) → атомарно в `$transaction` створює StockMovement-и.

---

## Типи документів

| `StockDocumentType` | StockMovementType(s) | Поведінка                                        | `DocumentType`   |
| ------------------- | -------------------- | ------------------------------------------------ | ---------------- |
| `WRITEOFF`          | `WRITEOFF`           | Списати `-qty` з `warehouseId`                   | `STOCK_WRITEOFF` |
| `TRANSFER`          | `WRITEOFF + RECEIPT` | WRITEOFF з source, RECEIPT у `targetWarehouseId` | `STOCK_TRANSFER` |
| `OPENING_BALANCE`   | `OPENING_BALANCE`    | Встановити початкові залишки `+qty`              | `STOCK_OPENING`  |
| `RECEIPT`           | `RECEIPT`            | Оприбуткування без PO — `+qty` у `warehouseId`   | `STOCK_RECEIPT`  |

**TRANSFER:** `targetWarehouseId` обов'язковий. Два рухи у `Promise.all` (disjoint rows — safe).

---

## API Endpoints (`/api/stock-documents`)

| Метод  | URL                                   | Дія                                                                 |
| ------ | ------------------------------------- | ------------------------------------------------------------------- |
| GET    | `/api/stock-documents`                | Список (фільтри: type, status, branchId, warehouseId, dateFrom/To)  |
| GET    | `/api/stock-documents/:id`            | Деталь з lines                                                      |
| POST   | `/api/stock-documents`                | Створити (lines у body; опц. `purchaseOrderId` — джерело, Phase D2) |
| PATCH  | `/api/stock-documents/:id`            | Оновити (тільки DRAFT)                                              |
| DELETE | `/api/stock-documents/:id`            | Soft-delete (тільки DRAFT)                                          |
| POST   | `/api/stock-documents/:id/transition` | FSM перехід (DRAFT → CONFIRMED або CANCELLED)                       |

---

## UI (Web)

Сторінка меню **«Склад»** (`/stock-documents`) — список складських документів з одним рядком
вкладок: типи документів (з `STOCK_DOC_TYPE_LABELS`, BR-SDOC-007) і праворуч — **«Рухи»**
(`?tab=movements`, журнал рухів замість таблиці документів). Окремої верхньої смуги
«Документи складу / Залишки / Рухи» немає (рішення власника 2026-10-08). Guard сторінки —
OWNER/ADMIN/STOREKEEPER (документи й рухи містять ціни та собівартість; так само обмежує backend).

**«Залишки»** живуть у «Звітах»: `/reports?tab=inventory` рендерить той самий `InventoryTab`.
Комірник і приймальник заходять у «Звіти» лише заради цієї вкладки — інших вкладок не бачать, і
запит фінансового звіту для них не йде; бухгалтер бачить залишки разом із рештою звітів (API:
`GET /stock-items`, `/stock-items/by-batch`, `/stock-items/by-document`, `/warehouses`).
Старі адреси `/inventory` і `/stock-documents?tab=stock` — **redirect** на `/reports?tab=inventory`.

| Компонент / сторінка  | Файл                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| Сторінка «Склад»      | `app/(app)/stock-documents/page.tsx` (StockPageShell, StockTypeTabs)    |
| Список документів     | `app/(app)/stock-documents/page.tsx` (StockDocumentsPageClient)         |
| Вкладка «Рухи»        | `app/(app)/stock-documents/StockMovementsTab.tsx`                       |
| Вкладка «Залишки»     | `app/(app)/inventory/InventoryTab.tsx` (у `app/(app)/reports/page.tsx`) |
| Redirect /inventory   | `app/(app)/inventory/page.tsx`                                          |
| Модалка створення     | `components/ui/StockDocumentCreateModal.tsx`                            |
| Detail Panel schema   | `lib/panel-schema.ts` → `STOCK_DOC_PANEL_SCHEMA`                        |
| Hook (TanStack Query) | `hooks/api/useStockDocuments.ts`                                        |

---

## Бізнес-правила (BR-SDOC)

- **BR-SDOC-001**: Номер авто-генерується: `DocumentNumberService.next(orgId, documentType)`
- **BR-SDOC-002**: **create/update: `validateLineGoodIds(orgId, lines)`** — усі goodId рядків мусять належати org
  (Good.id глобально унікальний → інакше cross-tenant FK-injection на confirm→createMovement). 404 ДО запису.
- **BR-SDOC-003**: Один товар може стояти в документі кількома рядками — це різні партії з
  різною ціною (собівартість партії фіксується рядком). Рядки не дедуплікуються й не
  зливаються: кожен рядок дає окремий рух зі своєю кількістю й ціною
- **BR-SDOC-004**: Рядки проводяться послідовно, не через `Promise.all`: рядки одного товару
  ділять `StockItem` і партії FIFO. У `TRANSFER` списання зі складу-джерела йде перед
  оприбуткуванням на цільовий, і собівартість списаних партій переноситься в нову (Bug #610)
- **BR-SDOC-005**: `STOCK_DOC_TYPE_LABELS` у `@sto/shared` — додавати нові типи туди, не хардкодити на фронті
- **BR-SDOC-006**: **PO-джерело (Phase D2):** `purchaseOrderId` — опціональний FK на замовлення постачальнику; задається лише при CREATE (пікер «Замовлення (джерело)» у модалці, у edit-режимі read-only). Guard: якщо передано — має існувати у org (`purchaseOrder.findFirst` orgId+deletedAt:null), інакше `BadRequestException('Замовлення не знайдено')`. Відповідь містить `purchaseOrderId` + `purchaseOrderNumber` (join). Документ без PO створюється нормально.
- **BR-SDOC-007**: Tab-bar фільтр підхоплює нові типи автоматично через `Object.keys(STOCK_DOC_TYPE_LABELS)`
- **BR-SDOC-008**: Таймаут транзакції проведення росте з кількістю рядків:
  `confirmTxTimeoutMs(n) = max(15 с, n × 120 мс)` — 500 рядків (стільки пропускає DTO) → 60 с.
  Фіксовані 15 с документ `TRANSFER` на 500 рядків не проходив: 500 через 15,1 с, усі рухи
  відкочено (Bug #801, заміряно на dev-БД через `127.0.0.1`: ≈ 28 мс/рядок і більше, коли в
  товару накопичились партії)

---

## Аспекти і тести, що їх стережуть

Спек `stock-documents.service.spec.ts` був 1040 рядків із 4 незалежними top-level
describe; 2026-10-05 розбито за аспектами — 54 кейси модуля до і після, кожне
`fullName` збереглося (перевірено порівнянням множин проти `test-baseline.json`).

**Модуль:** `apps/api/src/modules/stock-documents/`

| Аспект                                                                       | Тест                                             | Кейсів | Правила                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | ------ | -------------------------------------------------- |
| RECEIPT-тип: transition→CONFIRMED, else-гілка, позитивна quantity (Bug #480) | `stock-documents.receipt-type.spec.ts`           | 19     | BR-SDOC-001, BR-SDOC-002, BR-SDOC-004, BR-SDOC-008 |
| Нумерація: кожен тип → свій лічильник, номер лише з лічильника               | `stock-documents.numbering.spec.ts`              | 5      | BR-SDOC-001                                        |
| Tenant-guard goodId рядків на update                                         | `stock-documents.line-goods-tenant.spec.ts`      | 2      | BR-SDOC-002                                        |
| Пов'язані документи (Phase D3)                                               | `stock-documents.linked-docs.spec.ts`            | 8      | —                                                  |
| `purchaseOrderId` на create і update (Phase D2)                              | `stock-documents.purchase-order-link.spec.ts`    | 4      | BR-SDOC-006                                        |
| HTTP-контракт (DTO, статуси, валідація)                                      | `stock-documents.contract.spec.ts`               | 23     | —                                                  |
| Асиметричний reverse рухів                                                   | `asymmetric-reverse.invariants.spec.ts`          | 7      | BR-SDOC-004                                        |
| Інваріант `STOCK_DOC_TYPE_LABELS` ↔ Prisma `StockDocumentType`               | `stock-documents.type-labels.invariants.spec.ts` | 2      | BR-SDOC-005                                        |

Web-тест таб-бару типів (`BR-SDOC-007`) лежить поза модулем:
`apps/web/src/app/(app)/stock-documents/__tests__/StockDocTypeTabs.test.tsx` — 4 кейси. У
мапу shared підкладено п'ятий тип, якого сторінка «не знає»: він мусить стати вкладкою і
прийматись із `?type=`.

**Чого тут НЕМА.** Прогалин за ідентифікатором не лишилось — нижче те, що покрите лише
частково.

- Перелік типів у модалці створення (`StockDocumentCreateModal`) теж читає ключі мапи
  shared, але компонентного тесту на це немає: інваріантний спек стереже саму мапу, web-тест —
  лише таб-бар і `?type=` на сторінці.
- UI-половина PO-джерела (пікер «Замовлення (джерело)» у модалці, read-only в edit-режимі)
  unit-тестом не покрита — спек стереже лише сервіс.
- Повідомлення помилок у сервісних спеках звіряються за класом винятку, а не за текстом
  (виняток — «Товар не знайдено» на create).

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
