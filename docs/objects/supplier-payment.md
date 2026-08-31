# SupplierPayment — Dossier

> Документ оплати постачальнику. Закриває борг перед постачальником: при проведенні пише `SettlementTransaction(PAYMENT)` зі списанням з банківського рахунку або каси.

---

## Prisma модель

```prisma
model SupplierPayment {
  id              String                @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String                @db.Uuid
  supplierId      String                @db.Uuid    // Counterparty (постачальник)
  purchaseOrderId String?               @db.Uuid    // опціональна прив'язка (аналітика)
  sourceType      PaymentSourceType                 // BANK_ACCOUNT | CASH_REGISTER
  bankAccountId   String?               @db.Uuid    // заповнене якщо sourceType=BANK_ACCOUNT
  cashRegisterId  String?               @db.Uuid    // заповнене якщо sourceType=CASH_REGISTER
  number          String
  status          SupplierPaymentStatus @default(DRAFT)
  amount          Decimal               @db.Decimal(12, 2)
  method          String                            // код з PaymentMethodConfig
  notes           String?
  documentDate    DateTime              @default(now()) @db.Date
  syncVersion     BigInt                @default(0)
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
  deletedAt       DateTime?
}
```

**Enum-и:** `SupplierPaymentStatus` (DRAFT/CONFIRMED/CANCELLED), `PaymentSourceType` (BANK_ACCOUNT/CASH_REGISTER).

**Відносини:** → `Counterparty` (supplier), `PurchaseOrder?`, `BankAccount?`, `CashRegister?`.

---

## FSM

```
DRAFT → CONFIRMED   (пише settlement PAYMENT)
      ↘ CANCELLED
```

| Статус      | Значення                                               |
| ----------- | ------------------------------------------------------ |
| `DRAFT`     | Чернетка — settlement ще не пишеться, можна редагувати |
| `CONFIRMED` | Проведено — settlement PAYMENT записано, борг зменшено |
| `CANCELLED` | Скасовано — settlement не пишеться                     |

Проведення (`confirm`) виконується у `$transaction` з re-read статусу всередині (race-safe проти подвійного PAYMENT).

**Service:** `apps/api/src/modules/supplier-payments/supplier-payments.service.ts`

---

## API Endpoints (`/api/supplier-payments`)

| Метод  | URL                              | Дія                                                           |
| ------ | -------------------------------- | ------------------------------------------------------------- |
| GET    | `/supplier-payments`             | Список (status, supplierId, q, dateFrom/To)                   |
| GET    | `/supplier-payments/schedule`    | Графік оплат (шахматка боргів по датах, FIFO) — BR-SUPPAY-009 |
| GET    | `/supplier-payments/:id`         | Деталь                                                        |
| POST   | `/supplier-payments`             | Створити (DRAFT)                                              |
| PATCH  | `/supplier-payments/:id`         | Оновити (тільки DRAFT)                                        |
| POST   | `/supplier-payments/:id/confirm` | DRAFT→CONFIRMED (+ settlement PAYMENT)                        |
| POST   | `/supplier-payments/:id/cancel`  | DRAFT→CANCELLED                                               |
| DELETE | `/supplier-payments/:id`         | Soft-delete (крім CONFIRMED)                                  |

Ролі: `OWNER`, `ADMIN`, `ACCOUNTANT`.

---

## UI (Web)

| Компонент / сторінка  | Файл                                                    |
| --------------------- | ------------------------------------------------------- |
| Список                | `app/(app)/supplier-payments/page.tsx`                  |
| Модалка створення     | `components/ui/SupplierPaymentCreateModal.tsx`          |
| Detail Panel schema   | `lib/panel-schema.ts` → `SUPPLIER_PAYMENT_PANEL_SCHEMA` |
| Hook (TanStack Query) | `hooks/api/useSupplierPayments.ts`                      |
| Навігація             | `lib/nav.ts` → «Оплати постачальникам» (Документи)      |

---

## Бізнес-правила (BR-SUPPAY)

- **BR-SUPPAY-001**: Settlement PAYMENT пишеться ТІЛЬКИ через `SettlementsService.createTransaction()` при `confirm()`, ніколи при `create()`.
- **BR-SUPPAY-002**: Джерело коштів обов'язкове й ексклюзивне: `BANK_ACCOUNT` ⇒ `bankAccountId` (без `cashRegisterId`); `CASH_REGISTER` ⇒ `cashRegisterId` (без `bankAccountId`).
- **BR-SUPPAY-003**: Контрагент має бути постачальником (`type` ≠ `CLIENT`).
- **BR-SUPPAY-004**: Опціональний `purchaseOrderId` має належати вказаному постачальнику; при зміні `supplierId` через `update()` orphan-PO авто-очищується (Bug #588).
- **BR-SUPPAY-005**: `documentType` у settlement = `'SupplierPayment'` (PascalCase).
- **BR-SUPPAY-006**: Проведену (`CONFIRMED`) оплату не можна редагувати (`update`) чи видаляти (`remove`) — settlement append-only.
- **BR-SUPPAY-007**: Без Checkbox (ПРРО) і без лояльності — це supplier-side, не клієнтський продаж.
- **BR-SUPPAY-008**: `confirm()` race-safe — re-read статусу всередині `$transaction`, подвійний confirm не подвоює PAYMENT.
- **BR-SUPPAY-009** (Графік оплат — `getSchedule`): АВТОРИТЕТНЕ джерело суми боргу — `SettlementAccount.balance` (`payable = |−balance|` для `balance<0`), а НЕ `Σ PurchaseOrder.totalAmount` — баланс враховує ВСІ рухи (повернення, unlinked-платежі, коригування). Фільтр: `counterparty.deletedAt IS NULL` + `type IN (SUPPLIER, BOTH)` (Bug #599 — не показувати клієнтів з prepayment-refund). **FIFO-розподіл**: `payable` наливається на непогашені RECEIVED/PARTIAL PO по черзі від найстарішого (`orderBy paymentDate asc nulls first`), `take = min(po.outstanding, remaining)`; кожен PO лягає у колонку за `paymentDate` (null/<from → overdue; from..to → byDate[дата]; >to → planned) з РЕАЛЬНИМ залишком. PO, до яких борг не дійшов = оплачені (не показуються); надлишок понад ΣPO → overdue. Кредит-ліміт (макс по PURCHASE-договорах) віднімається з найпізніших. **Trade-off (Bug #600)**: `schedule.totals.total ≤ reports.settlements.totalCredit` — звіт НЕ фільтрує deleted/CLIENT, тож розбіжність = борги видалених + CLIENT-типу counterparty.

→ [docs/objects/settlements.md](settlements.md) · [docs/objects/purchase-order.md](purchase-order.md)
