# BUSINESS-RULES — STO ERP

> Критичні бізнес-правила, FSM, інвентар, розрахунки.
> Читати перед будь-якими змінами у сервісах.

---

## FSM — Work Orders

Файл: `apps/api/src/modules/work-orders/work-orders.fsm.ts`

```
DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → ON_HOLD → COMPLETED → INVOICED → PAID → ARCHIVED
                 ↘ CANCELLED    ↘ CANCELLED    ↘ CANCELLED    ↘ CANCELLED (C2: реверс складу+боргу)
```

**COMPLETED→CANCELLED (C2):** дозволено; повертає списані запчастини й сторнує борг (див.
side-effects). INVOICED/PAID/ARCHIVED **незворотні** — там уже рахунок/гроші.

| Константа                 | Значення                  |
| ------------------------- | ------------------------- |
| `WO_EDITABLE_STATUSES`    | DRAFT, ESTIMATE, APPROVED |
| `WO_SHAREABLE_STATUSES`   | DRAFT, ESTIMATE, APPROVED |
| `WO_INVOICEABLE_STATUSES` | COMPLETED, INVOICED       |
| `WO_DELETABLE_STATUSES`   | DRAFT, CANCELLED          |

**Правило:** зміна статусу — тільки через `WORK_ORDER_TRANSITIONS` map. Ніколи прямий `prisma.workOrder.update({ status })`.

**FE↔BE symmetry:** `WO_*_STATUSES` у `@sto/shared` МАЮТЬ МАТЧИТИ backend constants. Верифікується у `work-orders.fsm.invariants.spec.ts` (Bug #439).

### Side-effects FSM transitions

| Перехід                        | Side-effects (у `$transaction`)                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| → `IN_PROGRESS`                | `createMovement(RESERVATION)` для кожної запчастини                                                                                                                                             |
| → `COMPLETED`                  | `createMovement(RESERVATION_RELEASE)` + `createMovement(WRITEOFF)` + `createTransaction(CHARGE)`                                                                                                |
| → `CANCELLED` з IN_PROGRESS    | `createMovement(RESERVATION_RELEASE)` для кожної запчастини                                                                                                                                     |
| → `CANCELLED` з ON_HOLD        | `createMovement(RESERVATION_RELEASE)` для кожної запчастини                                                                                                                                     |
| → `CANCELLED` з COMPLETED (C2) | `returnPartsAndCredit`: per part `createMovement(RETURN, +baseQty)` (StockItem++ + `returnToBatch`) + `createTransaction(CREDIT_NOTE)` = сума CHARGE. Реверс COMPLETED. Резерв НЕ відновлюється |

**Порядок у COMPLETED:** RESERVATION_RELEASE **перед** WRITEOFF (щоб `available >= qty` guard пройшов).

**C2 реверс (COMPLETED→CANCELLED):** RETURN дзеркалить WRITEOFF (StockItem++ + повернення у ті самі
партії, агрегація по batchId), CREDIT_NOTE (−1) нетить CHARGE (+1) до нуля. Single-shot через in-tx
status re-read + термінальний CANCELLED (та сама гарантія, що не дає подвійного CHARGE).

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

### 0. Guards у `inventory.service.ts`

| Умова                                | Результат             |
| ------------------------------------ | --------------------- |
| `qty = 0`                            | `BadRequestException` |
| `RESERVATION_RELEASE` з `qty > 0`    | `BadRequestException` |
| `RESERVATION` якщо `available < qty` | `BadRequestException` |
| `WRITEOFF` якщо `quantity < \|qty\|` | `BadRequestException` |

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

> Джерело правди — `apps/api/src/modules/settlements/settlements.service.ts` (`BALANCE_SIGN`);
> копія для фронту — `SETTLEMENT_BALANCE_SIGN` у `@sto/shared`. Вісь одна: **`balance > 0` —
> контрагент винен нам, `balance < 0` — ми винні контрагенту.** Клієнтські й постачальницькі типи
> розділені, бо семантика протилежна.

```typescript
const BALANCE_SIGN: Record<SettlementTransactionType, 1 | -1> = {
  CHARGE: 1, // клієнт винен нам (наряд/рахунок)
  PAYMENT: -1, // клієнт заплатив нам
  PREPAYMENT: -1,
  REFUND: -1,
  CREDIT_NOTE: -1,
  SUPPLIER_CHARGE: -1, // отримали товар → ми винні постачальнику
  SUPPLIER_PAYMENT: 1, // заплатили постачальнику → наш борг меншає
  SUPPLIER_REFUND: 1, // повернули товар постачальнику → наш борг меншає
  FX_GAIN: 1, // курсові різниці гасять base-залишок повністю сплаченого іновалютного документа
  FX_LOSS: -1,
  REFUND_OUT: 1, // повернули гроші клієнту (банк BR-BANK-030, каса BR-CASH-018) → він знову винен
  REFUND_OUT_CANCEL: -1, // сторно REFUND_OUT при скасуванні рознесення (BR-BANK-039)
  SUPPLIER_PAYMENT_RETURN: -1, // постачальник повернув гроші готівкою (каса BR-CASH-019)
  // Сторно касової операції (BR-CASH-023…025) — знак протилежний до оригіналу:
  PAYMENT_CANCEL: 1, // сторно PAYMENT
  PREPAYMENT_CANCEL: 1, // сторно PREPAYMENT
  SUPPLIER_PAYMENT_CANCEL: -1, // сторно SUPPLIER_PAYMENT
  SUPPLIER_PAYMENT_RETURN_CANCEL: 1, // сторно SUPPLIER_PAYMENT_RETURN
};
```

### Типи транзакцій

| Тип                            | Знак  | Коли                                                                                    |
| ------------------------------ | ----- | --------------------------------------------------------------------------------------- |
| CHARGE                         | +1    | Борг клієнта: завершення наряду (`WorkOrder` COMPLETED), виставлення рахунку            |
| PAYMENT                        | -1    | Клієнт оплатив (`Payment`; готівкою — з каси, BR-CASH-017)                              |
| PREPAYMENT                     | -1    | Передоплата                                                                             |
| REFUND                         | -1    | Вхідний банківський платіж з видом «повернення»                                         |
| CREDIT_NOTE                    | -1    | Кредит-нота                                                                             |
| SUPPLIER_CHARGE                | -1    | Отримання товару від постачальника (`PurchaseOrder.receive`) → ми винні                 |
| SUPPLIER_PAYMENT               | +1    | Ми оплатили постачальнику (`SupplierPayment.confirm`; з каси — BR-CASH-019) → борг ↓    |
| SUPPLIER_REFUND                | +1    | Повернення ТОВАРУ постачальнику (`SupplierReturn.confirm`) → борг ↓                     |
| SUPPLIER_PAYMENT_RETURN        | -1    | Постачальник повернув ГРОШІ готівкою (каса) → його борг перед нами / наша передоплата ↓ |
| REFUND_OUT / _CANCEL           | +1/-1 | Повернення коштів клієнту (банк / каса) і його сторно                                   |
| PAYMENT_CANCEL                 | +1    | Сторно оплати контрагента з каси (BR-CASH-024)                                          |
| PREPAYMENT_CANCEL              | +1    | Сторно авансу контрагента з каси (BR-CASH-024)                                          |
| SUPPLIER_PAYMENT_CANCEL        | -1    | Сторно оплати постачальнику з каси (BR-CASH-024) → наш борг знову ↑                     |
| SUPPLIER_PAYMENT_RETURN_CANCEL | +1    | Сторно повернення від постачальника (BR-CASH-025)                                       |
| FX_GAIN / FX_LOSS              | +1/-1 | Курсові різниці при повній оплаті іновалютного рахунку                                  |

> Старий опис цієї таблиці (лише 5 типів і постачальницькі `CHARGE`/`PAYMENT`) розходився з кодом —
> звірено з `settlements.service.ts` 2026-10-14.

---

## Доступ працівника і перегляд видалених документів

- Звільнений працівник не входить у систему, його сесії гаснуть — [docs/objects/employee.md](objects/employee.md), BR-EMP-001.
- Документ, позначений на видалення, відкривається лише на перегляд — [docs/objects/work-order.md](objects/work-order.md), BR-WO-012.
- Повернення постачальнику зберігає повтори товару окремими рядками — [docs/objects/purchase-order.md](objects/purchase-order.md), BR-PO-008.

---

## Зведення по табличних частинах документа

Рядків, найменувань і суми по таблицях документа та виконавці наряду — для бокової панелі списків. Одне місце правди — [docs/objects/work-order.md](objects/work-order.md), BR-WO-009 / BR-WO-010.

---

## Ціноутворення — PricingService.resolveRule

Ієрархія й правила області (список товарів, категорія з підкатегоріями) — [docs/objects/good.md](objects/good.md), BR-GOOD-009 / BR-GOOD-010.

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

**Реальні застосування** (детальні правила — у дос'є):

- **Фіскалізація (ПРРО)** — черга `checkbox`, `attempts: 288`, backoff 5 хв (≈24 год). `fiscalStatus`
  FSM `QUEUED → DONE/FAILED/SKIPPED`. Онлайн-оплата (QR-еквайринг) — черга `payment-polling`
  (PENDING→PAID через CAS + idempotency по `onlinePaymentIntentId`). Каса — cash-shift open/close з
  CAS-claim проти подвійного Z-звіту. Провайдери: Checkbox/Вчасно (FISCAL), monobank/LiqPay (PAYMENT).
  → [objects/payments.md](objects/payments.md)
- **Лояльність (earn)** — черга `loyalty`, `attempts: 10`; idempotency «один EARN на документ»
  (partial-unique + read-then-write); redeem — атомарний check-and-decrement. → [objects/loyalty.md](objects/loyalty.md)
- **Нагадування про ТО** — follow-up cron 09:00 Kyiv; горизонт `maintenanceForecastDays`;
  графіки авто-оновлюються при завершенні MAINTENANCE-наряду. → [objects/maintenance-schedules.md](objects/maintenance-schedules.md)

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
