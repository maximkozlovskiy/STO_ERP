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
| `OPENING_BALANCE`   | `RECEIPT`            | Встановити початкові залишки `+qty`              | `STOCK_OPENING`  |
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

| Компонент / сторінка  | Файл                                             |
| --------------------- | ------------------------------------------------ |
| Список                | `app/(app)/stock-documents/page.tsx`             |
| Модалка створення     | `components/ui/StockDocumentCreateModal.tsx`     |
| Detail Panel schema   | `lib/panel-schema.ts` → `STOCK_DOC_PANEL_SCHEMA` |
| Hook (TanStack Query) | `hooks/api/useStockDocuments.ts`                 |

---

## Бізнес-правила

- Номер авто-генерується: `DocumentNumberService.next(orgId, documentType)`
- **create/update: `validateLineGoodIds(orgId, lines)`** — усі goodId рядків мусять належати org
  (Good.id глобально унікальний → інакше cross-tenant FK-injection на confirm→createMovement). 404 ДО запису.
- Деdup рядків перед transition: `Set(lineIds)` — duplicate lineId → `BadRequestException`
- Рухи у `Promise.all` (disjoint по `(goodId, warehouseId)` для WRITEOFF ↔ RECEIPT — safe)
- `STOCK_DOC_TYPE_LABELS` у `@sto/shared` — додавати нові типи туди, не хардкодити на фронті
- **PO-джерело (Phase D2):** `purchaseOrderId` — опціональний FK на замовлення постачальнику; задається лише при CREATE (пікер «Замовлення (джерело)» у модалці, у edit-режимі read-only). Guard: якщо передано — має існувати у org (`purchaseOrder.findFirst` orgId+deletedAt:null), інакше `BadRequestException('Замовлення не знайдено')`. Відповідь містить `purchaseOrderId` + `purchaseOrderNumber` (join). Документ без PO створюється нормально.
- Tab-bar фільтр підхоплює нові типи автоматично через `Object.keys(STOCK_DOC_TYPE_LABELS)`

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
