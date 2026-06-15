# PurchaseOrder — Dossier

> Замовлення постачальнику. Фіксує що і за якою ціною закупили, ініціює надходження товару на склад.

---

## Prisma модель

```prisma
model PurchaseOrder {
  id           String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String              @db.Uuid
  supplierId   String              @db.Uuid    // контрагент-постачальник
  warehouseId  String              @db.Uuid    // куди приймаємо товар
  contractId   String?             @db.Uuid    // договір з постачальником (optional)
  number       String
  status       PurchaseOrderStatus @default(DRAFT)
  totalAmount  Decimal             @default(0) @db.Decimal(12, 2)
  notes        String?
  documentDate DateTime            @default(now()) @db.Date
  syncVersion  BigInt              @default(0)
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt
  deletedAt    DateTime?
}

model PurchaseOrderLine {
  purchaseOrderId String    @db.Uuid
  goodId          String    @db.Uuid
  quantity        Float
  price           Decimal   @db.Decimal(12, 2)
  receivedQty     Float     @default(0)      // скільки вже прийнято
  unitOfMeasureId String?   @db.Uuid
}
```

**Відносини:**

- → `Counterparty` (supplier)
- → `Warehouse` (куди)
- → `CounterpartyContract` (optional)
- ← `PurchaseOrderLine[]`

---

## FSM

```
DRAFT → ORDERED → PARTIAL → RECEIVED
      ↘ CANCELLED  ↘ CANCELLED  ↘ CANCELLED
```

| Статус      | Значення                                      |
| ----------- | --------------------------------------------- |
| `DRAFT`     | Чернетка, редагується                         |
| `ORDERED`   | Відправлено постачальнику, очікуємо           |
| `PARTIAL`   | Часткове надходження (receivedQty < quantity) |
| `RECEIVED`  | Повністю прийнято                             |
| `CANCELLED` | Скасовано                                     |

**FSM файл:** `apps/api/src/modules/purchase-orders/purchase-orders.service.ts`

---

## API Endpoints (`/api/purchase-orders`)

| Метод  | URL                                      | Дія                                                    |
| ------ | ---------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/purchase-orders`                   | Список (фільтри: status, supplierId, dateFrom, dateTo) |
| GET    | `/api/purchase-orders/:id`               | Деталь з lines                                         |
| POST   | `/api/purchase-orders`                   | Створити (lines у body)                                |
| PATCH  | `/api/purchase-orders/:id`               | Оновити (тільки DRAFT)                                 |
| DELETE | `/api/purchase-orders/:id`               | Soft-delete (тільки DRAFT/CANCELLED)                   |
| POST   | `/api/purchase-orders/:id/transition`    | FSM перехід (DRAFT → ORDERED)                          |
| POST   | `/api/purchase-orders/:id/receive`       | Приймання товару → StockMovement(RECEIPT) + CHARGE     |
| POST   | `/api/purchase-orders/:id/apply-pricing` | Застосувати ціни закупки до Good.purchasePrice         |

---

## UI (Web)

| Компонент / сторінка  | Файл                                                  |
| --------------------- | ----------------------------------------------------- |
| Список                | `app/(app)/purchase-orders/page.tsx`                  |
| Модалка створення     | `components/ui/PurchaseOrderCreateModal.tsx`          |
| Detail Panel schema   | `lib/panel-schema.ts` → `PURCHASE_ORDER_PANEL_SCHEMA` |
| Hook (TanStack Query) | `hooks/api/usePurchaseOrders.ts`                      |

---

## Бізнес-правила: receive() інваріанти

1. `activeLines` = лише рядки де `line.quantity - line.receivedQty > 0`
2. `deduplicateBy(receivedLines, l => l.lineId)` ПЕРЕД `$transaction` — запобігає дублям
3. `receivedQty` не може перевищити `line.quantity` (guard у DTO)
4. Після receive у `$transaction`:
   - `InventoryService.createMovement(RECEIPT)` для кожного рядка
   - `purchaseOrderLine.update({ receivedQty: += received })` у `Promise.all` (disjoint rows — safe)
   - `SettlementsService.createTransaction(CHARGE)` — борг перед постачальником

### update() — contract resolution

```
shouldValidateContract = !!dto.contractId      // null/undefined/'' → false
supplierChanged = dto.supplierId && dto.supplierId !== po.supplierId

if (dto.contractId === null) → newContractId = null          // explicit clear
else if (supplierChanged && po.contractId) → newContractId = null  // auto-clear stale
else if (dto.contractId) → validate counterpartyId = effectiveSupplierId
else → newContractId = po.contractId                         // unchanged
```

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
