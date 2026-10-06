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
  currencyId      String?               @db.Uuid   // мультивалюта Фаза 3: валюта оплати (з source-рахунку)
  totalAmountBase Decimal?              @db.Decimal(12, 2) // у БАЗОВІЙ валюті по курсу на дату confirm
  rateUsed        Decimal?              @db.Decimal(18, 6)
  method          String                            // код з PaymentMethodConfig
  notes           String?
  documentDate    DateTime              @default(now()) @db.Date
  syncVersion     BigInt                @default(0)
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
  deletedAt       DateTime?
}
```

> **Мультивалюта (Фаза 3, 2026-09-14):** `amount` у **валюті source-рахунку** (bank/cash `currencyId`);
> `currencyId` фіксується при create. На `confirm()` рахується `totalAmountBase`/`rateUsed` по курсу на
> дату проведення (fallbackToLatest), і SUPPLIER_PAYMENT пробрасує `currencyId`+`date` → борг постачальнику
> ↓ у base. cash-out конвертує CashService сам (Фаза 1).

> **Payables FX (Фаза 5, 2026-09-14):** `confirm()` для привʼязаної до PO оплати: (1) валютний guard
> — валюта SP == валюта PO (інакше 400); (2) інкрементує `PurchaseOrder.paidAmount` (CAS, у валюті PO);
> (3) при першій повній оплаті (paidAmount>=totalAmount−0.005) в іновалюті визнає realized FX однією
> проводкою що обнуляє base-залишок PO. **⚠️ ЗНАК ІНВЕРТОВАНИЙ vs клієнт** (SUPPLIER_CHARGE=−1/
> SUPPLIER_PAYMENT=+1 → залишок=paidBase−chargeBase): fx=chargeBase−paidBase → `fx>0 ⇒ FX_GAIN`,
> `fx<0 ⇒ FX_LOSS`. chargeBase = Σ SUPPLIER_CHARGE.amountBase (ledger, PO); paidBase = Σ
> SUPPLIER_PAYMENT.amountBase (CONFIRMED SP цього PO). Skip: base / |fx|<0.005 / idempotency count-guard.
> cancel N/A (CONFIRMED термінальний → paidAmount монотонний).

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

| Метод  | URL                                     | Дія                                                           |
| ------ | --------------------------------------- | ------------------------------------------------------------- |
| GET    | `/supplier-payments`                    | Список (status, supplierId, q, dateFrom/To)                   |
| GET    | `/supplier-payments/schedule`           | Графік оплат (шахматка боргів по датах, FIFO) — BR-SUPPAY-009 |
| GET    | `/supplier-payments/schedule/documents` | Drill-down: документи (PO) клітинки графіка — BR-SUPPAY-010   |
| GET    | `/supplier-payments/:id`                | Деталь                                                        |
| POST   | `/supplier-payments`                    | Створити (DRAFT)                                              |
| PATCH  | `/supplier-payments/:id`                | Оновити (тільки DRAFT)                                        |
| POST   | `/supplier-payments/:id/confirm`        | DRAFT→CONFIRMED (+ settlement PAYMENT)                        |
| POST   | `/supplier-payments/:id/cancel`         | DRAFT→CANCELLED                                               |
| DELETE | `/supplier-payments/:id`                | Soft-delete (крім CONFIRMED)                                  |

Ролі: `OWNER`, `ADMIN`, `ACCOUNTANT`.

---

## UI (Web)

| Компонент / сторінка  | Файл                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Список                | `app/(app)/supplier-payments/page.tsx`                                                   |
| Графік + drill-down   | `app/(app)/supplier-payments/SupplierPaymentScheduleTab.tsx` (клік клітинки → панель PO) |
| Модалка створення     | `components/ui/SupplierPaymentCreateModal.tsx`                                           |
| Detail Panel schema   | `lib/panel-schema.ts` → `SUPPLIER_PAYMENT_PANEL_SCHEMA`                                  |
| Hook (TanStack Query) | `hooks/api/useSupplierPayments.ts`                                                       |
| Навігація             | `lib/nav.ts` → «Оплати постачальникам» (Документи)                                       |

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
- **BR-SUPPAY-010** (Drill-down — `getScheduleDocuments`): документи (PO) конкретної клітинки/бакета шахматки. Спільний private `computeScheduleAllocations` — ЄДИНЕ джерело FIFO-наливу + кредит-ліміту зі збереженням per-PO алокацій; `getSchedule` сумує їх у бакети, `getScheduleDocuments` фільтрує по цільовому бакету. **Інваріант консистентності**: `Σ allocated документів у бакеті == значення клітинки getSchedule` (за конструкцією — один helper, немає sibling-drift). Кредит-ліміт зменшує `allocated` з найпізніших PO (planned → byDate спадно → overdue), дзеркалить порядок getSchedule. Синтетичний рядок «борг без документа» (`poId=''`, коли balance > ΣPO) → overdue, некликабельний у UI. Query: `date` XOR `target` (overdue/planned), обидва з `@IsDateString({strict})+@Matches(YMD_RE)` (Bug #616); `supplierId` опційний (без нього — усі постачальники, клік по рядку «Разом»).

→ [docs/objects/settlements.md](settlements.md) · [docs/objects/purchase-order.md](purchase-order.md)

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/supplier-payments/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/supplier-payments/`

| Аспект                                  | Тест                                      | Кейсів |
| --------------------------------------- | ----------------------------------------- | ------ |
| cancel remove                           | `supplier-payments.cancel-remove.spec.ts` | 3      |
| confirm                                 | `supplier-payments.confirm.spec.ts`       | 5      |
| HTTP-контракт (DTO, статуси, валідація) | `supplier-payments.contract.spec.ts`      | 18     |
| create                                  | `supplier-payments.create.spec.ts`        | 4      |
| пов'язані документи                     | `supplier-payments.linked-docs.spec.ts`   | 8      |
| payables fx                             | `supplier-payments.payables-fx.spec.ts`   | 10     |
| schedule                                | `supplier-payments.schedule.spec.ts`      | 22     |
| сортування (whitelist orderBy)          | `supplier-payments.sort.spec.ts`          | 6      |
| update guards                           | `supplier-payments.update-guards.spec.ts` | 6      |

Разом: **82** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) немає, хоча агрегат на шляху грошей або статусів: властивості на кшталт «фінальний статус без виходів» не стережуться нічим. Свідома прогалина — кандидат на окремий крок.
