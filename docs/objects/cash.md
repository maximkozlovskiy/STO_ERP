# Cash / Каса — Dossier

> Рух готівки в касах: внесення (cash-in) та видача (cash-out), баланс каси, статті витрат.
> ЄДИНА точка руху готівки — `CashService.createOperation` (аналог `SettlementsService.createTransaction`).

---

## Prisma моделі

```prisma
enum CashDirection { IN OUT }
enum CashOperationReason {
  SALE_PAYMENT    // оплата клієнта готівкою (авто з payments)
  REFUND          // повернення клієнту
  PAYROLL         // виплата ЗП (авто з payroll)
  SUPPLIER_PAYMENT // оплата постачальнику
  EXPENSE         // витрата (стаття витрат)
  COLLECTION      // інкасація / виїмка
  MANUAL_IN MANUAL_OUT
}

model CashRegister {           // + до наявних полів:
  isFiscal       Boolean @default(false)  // фіскальна → операції лише у відкриту зміну + ПРРО
  initialBalance Decimal @default(0) @db.Decimal(12,2)
  operations     CashOperation[]
}

// Append-only (шаблон SettlementTransaction: без deletedAt/updatedAt/syncVersion).
model CashOperation {
  id, orgId, cashRegisterId, cashShiftId?  // cashShiftId — для фіскальної каси
  direction CashDirection, amount Decimal(12,2)   // amount>0, знак з direction
  reason CashOperationReason
  expenseCategoryId?  // стаття (для EXPENSE)
  counterpartyId?, employeeId?  // клієнт/постачальник | співробітник (PAYROLL)
  documentType?, documentId?    // 'Payment' | 'PayrollPeriod'
  notes?, createdBy?, createdAt
  // @@index([orgId,cashRegisterId,createdAt]) [orgId,cashShiftId] [orgId,reason,createdAt]
}

model ExpenseCategory {        // довідник статей витрат (per-org, дзеркалить GoodStatus)
  id, orgId, name, syncVersion, createdAt, updatedAt, deletedAt?
  // @@unique([orgId,name])
}
```

`CashOperation` — append-only, не у SYNC_VERSION_MODELS; у audit-whitelist. `ExpenseCategory` — у SYNC.

---

## Баланс

`balance = initialBalance + Σ(IN.amount) − Σ(OUT.amount)` (SQL-агрегат, `CashService.getBalance`).
Рахується **свіжим поза кешем** (findAll/findOne кешують лише статичну частину каси; balance — завжди актуальний).

---

## Фіскальна / нефіскальна каса

- **Фіскальна** (`isFiscal=true`): операції з готівкою лише у **відкриту зміну** (`CashShift`); createOperation
  знаходить OPEN-зміну каси або кидає 400. Наявний ПРРО-потік (sellReceipt у зміну) не зачеплено.
- **Нефіскальна**: постійний залишок, операції без зміни (`cashShiftId=null`).

---

## API Endpoints

**Каси** (`/api/cash-registers`) — OWNER/ADMIN CRUD; список/баланс/операції — +ACCOUNTANT/RECEPTIONIST:

| Метод             | URL                              | Дія                                            |
| ----------------- | -------------------------------- | ---------------------------------------------- |
| GET               | `/cash-registers`                | Список кас (+ isFiscal/initialBalance/balance) |
| POST/PATCH/DELETE | `/cash-registers[/:id]`          | CRUD (OWNER/ADMIN)                             |
| GET               | `/cash-registers/:id/balance`    | Поточний залишок                               |
| GET               | `/cash-registers/:id/operations` | Історія операцій                               |
| POST              | `/cash-registers/:id/operations` | Ручна IN/OUT (OWNER/ADMIN/ACCOUNTANT)          |

**Статті витрат** (`/api/expense-categories`) — GET OWNER/ADMIN/ACCOUNTANT; CRUD OWNER/ADMIN
(GET/POST/PATCH/DELETE/`:id/restore`).

---

## Інтеграції

- **Payments** (`payments.service.create`): оплата клієнта method=cash (`sourceType=CASH_REGISTER`) →
  авто cash-in `reason=SALE_PAYMENT` у **ту саму `$transaction`** що Payment+settlements. Фіскальна каса
  без зміни → 400 → повний відкат оплати.
- **Payroll** (`payroll.service.pay(cashRegisterId?)`): виплата ЗП → cash-out `reason=PAYROLL` по кожному
  співробітнику у `$transaction`. Без каси — лише фіксація `paidAmount` (без руху готівки).

---

## UI (Web)

Сторінка «Каса» (`/cash`) — вкладки: **Операції** (перемикач кас + баланс + внести/видати + історія +
зміна для фіскальної) · **Каси** (CRUD) · **Статті витрат** (CRUD). Вкладки/кнопки гейтуються за роллю
(RECEPTIONIST — лише перегляд «Операції»). Payroll pay-модалка — вибір каси для видачі ЗП готівкою.

| Компонент        | Файл                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Сторінка/вкладки | `app/(app)/cash/page.tsx` + `CashOperationsTab`/`CashRegistersTab`/`ExpenseCategoriesTab.tsx` |
| Hooks            | `hooks/api/useCash.ts`, `hooks/api/useExpenseCategories.ts`                                   |

---

## Інваріанти

1. **Рух готівки лише через `CashService.createOperation`** — append-only, atomic, приймає зовнішній tx.
   Виправлення — сторно-операцією протилежного напряму (не edit/delete).
2. Гроші: `Decimal(12,2)` + `roundMoney`; `amount>0`; знак з `direction`. Баланс не кешується стейл.
3. Tenant-isolation: orgId у кожному запиті; операція валідує касу/статтю/counterparty належать org.
4. Employee ≠ counterparty → ЗП саме касовою операцією (не через SettlementAccount).

→ [docs/objects/payroll.md](payroll.md) · [docs/objects/settlements.md](settlements.md)
