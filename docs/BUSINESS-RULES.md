# BUSINESS-RULES — STO ERP

> Критичні бізнес-правила, FSM, інвентар, розрахунки.
> Читати перед будь-якими змінами у сервісах.

---

## FSM — Work Orders

Файл: `apps/api/src/modules/work-orders/work-orders.fsm.ts`

```
DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → ON_HOLD → COMPLETED → INVOICED → PAID → ARCHIVED
                 ↘ CANCELLED    ↘ CANCELLED    ↘ CANCELLED    ↘ CANCELLED
```

| Константа                 | Значення                  |
| ------------------------- | ------------------------- |
| `WO_EDITABLE_STATUSES`    | DRAFT, ESTIMATE, APPROVED |
| `WO_SHAREABLE_STATUSES`   | DRAFT, ESTIMATE, APPROVED |
| `WO_INVOICEABLE_STATUSES` | COMPLETED, INVOICED       |
| `WO_DELETABLE_STATUSES`   | DRAFT, CANCELLED          |

**Правило:** зміна статусу — тільки через `WORK_ORDER_TRANSITIONS` map. Ніколи прямий `prisma.workOrder.update({ status })`.

**FE↔BE symmetry:** `WO_*_STATUSES` у `@sto/shared` МАЮТЬ МАТЧИТИ backend constants. Верифікується у `work-orders.fsm.invariants.spec.ts` (Bug #439).

---

## FSM — Stock Documents

```
DRAFT → CONFIRMED
      ↘ CANCELLED
```

Файл: `apps/api/src/modules/stock-documents/stock-documents.service.ts`

### MOVEMENT_TYPES map

| StockDocumentType | StockMovementType  | Поведінка                                    |
| ----------------- | ------------------ | -------------------------------------------- |
| WRITEOFF          | WRITEOFF           | `-quantity` з `warehouseId`                  |
| TRANSFER          | WRITEOFF + RECEIPT | WRITEOFF з source, RECEIPT у target          |
| OPENING_BALANCE   | RECEIPT            | `+quantity` у `warehouseId`                  |
| RECEIPT           | RECEIPT            | `+quantity` у `warehouseId` (Оприбуткування) |

### docTypeMap

| StockDocumentType | DocumentType    |
| ----------------- | --------------- |
| WRITEOFF          | STOCK_WRITEOFF  |
| TRANSFER          | STOCK_TRANSFER  |
| OPENING_BALANCE   | OPENING_BALANCE |
| RECEIPT           | STOCK_RECEIPT   |

**TRANSFER:** `targetWarehouseId` — обов'язковий. Два рухи у `Promise.all` (disjoint rows, race-safe).  
**Деdup перед transition:** `Set(lineIds)` — duplicate lineId → `BadRequestException`.

---

## FSM — Purchase Orders

```
DRAFT → ORDERED → PARTIAL → RECEIVED
      ↘ CANCELLED  ↘ CANCELLED  ↘ CANCELLED
```

Файл: `apps/api/src/modules/purchase-orders/purchase-orders.service.ts`

### receive() інваріанти

- `activeLines`: тільки рядки де `line.quantity - line.receivedQty > 0`
- `deduplicateBy(receivedLines, l => l.lineId)` ПЕРЕД `$transaction` (Bug #483)
- `receivedQty` не може перевищити `line.quantity` (guard у DTO)
- Після receive: `createMovement(RECEIPT)` + `purchaseOrderLine.update(receivedQty)` у `Promise.all`

### update() — contract resolution

```
shouldValidateContract = !!dto.contractId  // null/undefined/'' → false
supplierChanged = dto.supplierId && dto.supplierId !== po.supplierId

if (dto.contractId === null) → newContractId = null  // explicit clear
else if (supplierChanged && po.contractId) → newContractId = null  // auto-clear stale
else if (dto.contractId) → validate counterpartyId = effectiveSupplierId
else → newContractId = po.contractId  // unchanged
```

---

## FSM — Invoices

```
DRAFT → SENT → PAID
      ↘ CANCELLED  ↘ CANCELLED
OVERDUE → PAID / CANCELLED
```

---

## Інвентар — обов'язковий порядок операцій

### 1. Завжди через InventoryService.createMovement()

```typescript
// ❌
await prisma.stockItem.update({ data: { quantity: { decrement: qty } } });
// ✅
await this.inventoryService.createMovement(orgId, {
  type: 'WRITEOFF',
  goodId,
  warehouseId,
  quantity: -qty,
});
```

### 2. RELEASE перед WRITEOFF (WO completion)

```
available = quantity - reserved
```

Якщо WO зарезервував залишок: `available=0` → WRITEOFF падає.  
**Порядок:** (1) `RESERVATION_RELEASE -baseQty` → (2) `WRITEOFF -baseQty`.  
НЕ послаблювати guard `available >= 0` (property-based invariant у `inventory.invariants.spec.ts`).

### 3. Parallel writes ТІЛЬКИ для disjoint StockItem rows

`work-orders.service.ts` reserveParts/releasePartReservations/writeOffPartsAndCharge мають **sequential** for-loop — різні parts можуть ділити `(goodId, warehouseId)` composite key StockItem. Race-unsafe.

---

## Розрахунки — SettlementsService

**Завжди через** `SettlementsService.createTransaction()`:

```typescript
// ❌
await prisma.settlementAccount.update({ data: { balance: { decrement: amount } } });
// ✅
await this.settlementsService.createTransaction(orgId, {
  counterpartyId,
  type: 'CHARGE',
  amount,
  documentType: 'WorkOrder',
  documentId: wo.id,
});
```

### BALANCE_SIGN map

```typescript
const BALANCE_SIGN: Record<SettlementTransactionType, 1 | -1> = {
  PAYMENT: 1, // гроші надходять
  CHARGE: -1, // борг створюється
  // ... всі варіанти (exhaustive Record, не Partial)
};
```

### Типи транзакцій

| Тип     | Знак | Коли                                                          |
| ------- | ---- | ------------------------------------------------------------- |
| PAYMENT | +1   | Клієнт оплатив / ми отримали гроші                            |
| CHARGE  | -1   | Борг: отримання товару від постачальника, виставлення рахунку |

---

## Ціноутворення — calculateSalePrice

**Guard перед викликом:** `if (!costPrice || costPrice <= 0) skip`.  
Без guard: `0 * (1 + p/100) = 0` → silent data corruption `Good.salePrice` (Bug #198).

### deduplicateBy перед bulk update

```typescript
// PO/xlsx можуть мати кілька рядків з однаковим goodId
const dedupedPlan = deduplicateBy(plan, u => u.goodId); // last-wins
await Promise.all(dedupedPlan.map(u => tx.good.updateMany({ where: { id: u.goodId, orgId } })));
```

---

## Тенант-ізоляція (Critical §2.2)

**Кожен запит** фільтрується по `orgId`:

```typescript
// ❌
const wo = await prisma.workOrder.findUnique({ where: { id } });
// ✅
const wo = await prisma.workOrder.findFirst({
  where: { id, orgId, deletedAt: null },
});
if (!wo) throw new NotFoundException('Наряд не знайдено');
```

**Кожен write у $transaction:**

```typescript
// ❌
tx.stockDocumentLine.update({ where: { id: line.id } });
// ✅
tx.stockDocumentLine.update({ where: { id: line.id, orgId } });
```

---

## Soft Delete

**Ніколи** `prisma.X.delete()`. Тільки:

```typescript
await prisma.workOrder.update({
  where: { id, orgId },
  data: { deletedAt: new Date() },
});
```

### Promote при soft-delete isPrimary entity

При soft-delete сутності з `isPrimary/isDefault` (Contract, CustomerGarage, UoM, PaymentMethod):

```typescript
// У $transaction — після soft-delete, promote наступного
const next = await tx.X.findFirst({
  where: { parentId, isPrimary: false, deletedAt: null },
  orderBy: { createdAt: 'asc' },
});
if (next) await tx.X.update({ where: { id: next.id }, data: { isPrimary: true } });
```

---

## Конфігурація — без magic numbers у коді

| Тип                                                                | Зберігається у                                    |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| Терміни, ліміти                                                    | `OrganisationSettings`, `BranchSettings`          |
| invoiceDueDays, autoArchiveDays, warrantyDays, slotDurationMinutes | `SettingsService.get(orgId)`                      |
| ПРРО та SMS                                                        | `BranchSettings` (per branch)                     |
| Нумерація документів                                               | `DocumentNumberConfig` — format: prefix + counter |
| Шаблони повідомлень                                                | `NotificationTemplate` (SMS/Viber/Email)          |
| Способи оплати                                                     | `PaymentMethodConfig`                             |

**DocumentNumberService.next(orgId, documentType)** — завжди для auto-create документів.

---

## Зовнішні API — тільки через BullMQ

```typescript
// ❌ Прямий виклик
await smsClient.send(phone, message);

// ✅ BullMQ черга (offline-safe)
await this.smsQueue.add(
  'send',
  { phone, message },
  {
    attempts: 10,
    backoff: { type: 'exponential', delay: 60_000 },
  },
);
// ПРРО: attempts: 288 (24 год)
```

---

## Kyiv Timezone

```typescript
// ❌ Hardcode offset
new Date().toISOString().replace('Z', '+03:00');

// ✅ DST-aware
import { kyivOffsetMs, kyivToday } from '@/lib/format';
const todayKyiv = kyivToday(); // 'YYYY-MM-DD'

// Порівняння дат — string, не getTime():
dateStr.slice(0, 10) < kyivToday(); // ✅
new Date(dateStr).getTime() < Date.now(); // ❌ UTC vs Kyiv mismatch

// Module-level Intl singleton:
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Kyiv', hour: 'numeric' });
```

---

## CalendarSlot — split-day continuation invariant

`parentSlotId` — child slot для WO що перетинає опівніч.  
Інваріант: `parent.endAt < child.startAt`.

При cascade-update (syncWorkOrderSlots):

1. Soft-delete continuations (`parentSlotId IS NOT NULL`)
2. Update тільки parent (`parentSlotId IS NULL`)
3. Recreate child якщо range перевищує `WORK_DAY_END_H (20:00)`

**Conflict check обов'язковий** для БУДЬ-ЯКОГО методу що мутує `startAt/endAt` слота.
