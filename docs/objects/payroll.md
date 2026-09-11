# Payroll / Зарплата — Dossier

> Розрахунок і проведення заробітної плати співробітникам на основі виробітку та rateScheme.
> Джерело виробітку — завершені роботи нарядів. Виплата фіксується у PayrollLine (НЕ через SettlementAccount).

---

## Prisma моделі

```prisma
enum PayrollPeriodStatus { DRAFT COMPUTED PAID CANCELLED }

model PayrollPeriod {
  id, orgId, branchId?          // branchId null = усі філії
  periodStart @db.Date, periodEnd @db.Date
  status PayrollPeriodStatus @default(DRAFT)
  note?, computedAt?, computedBy?, paidAt?, paidBy?
  syncVersion, createdAt, updatedAt, deletedAt?
  lines PayrollLine[]
  // @@index([orgId,deletedAt]) [orgId,status] [orgId,syncVersion]
}

model PayrollLine {              // нарахування співробітнику (snapshot на COMPUTED)
  id, orgId, periodId, employeeId
  rateSchemeType String          // snapshot типу схеми
  baseAmount Decimal(12,2)       // Σ amount завершених робіт (база %)
  normoHours Float               // Σ normoHours
  linesCount Int
  accruedAmount Decimal(12,2)    // нараховано
  paidAmount Decimal(12,2) @default(0)  // виплачено (←accrued на PAID)
  syncVersion, createdAt, updatedAt
  // @@unique([periodId, employeeId]); @@index([orgId,employeeId])
}
```

Employee += `payrollLines PayrollLine[]`; Organisation += `payrollPeriods PayrollPeriod[]`.
SYNC_VERSION_MODELS += PayrollPeriod/PayrollLine; audit whitelist += PayrollPeriod.

---

## rateScheme (Employee.rateScheme, Zod у employees.dto.ts)

| type               | params                           | нарахування                               |
| ------------------ | -------------------------------- | ----------------------------------------- |
| `percent_normo`    | `{ percent }`                    | percent% × baseAmount (сума робіт)        |
| `per_normo_hour`   | `{ ratePerHour }`                | ratePerHour × normoHours                  |
| `fixed_plus_bonus` | `{ fixedMonthly, bonusPercent }` | fixedMonthly + bonusPercent% × baseAmount |

Розрахунок — `payroll.calculator.ts` (`computeAccrued`), гроші через `roundMoney` (half-away-from-zero).
Невалідна/відсутня схема → 0.

---

## FSM

```
DRAFT → COMPUTED → PAID
   ↘ (delete)      (delete заборонено на COMPUTED/PAID)
```

- **compute** (DRAFT→COMPUTED): рахує та ФІКСУЄ PayrollLine[] (snapshot) у `$transaction` з atomic claim
  (`updateMany where status:DRAFT`, count===0 → 400). Після цього зміни нарядів НЕ впливають на період.
- **pay** (COMPUTED→PAID): `paidAmount ← accruedAmount` по всіх рядках, atomic claim.
- **remove**: soft-delete, лише DRAFT/CANCELLED.

---

## API Endpoints (`/api/payroll`)

| Метод  | URL                                      | Дія                                    | Ролі                   |
| ------ | ---------------------------------------- | -------------------------------------- | ---------------------- |
| GET    | `/api/payroll/preview?from&to&branchId?` | Попередній розрахунок (без збереження) | OWNER/ADMIN/ACCOUNTANT |
| GET    | `/api/payroll/periods`                   | Список періодів (з lines)              | OWNER/ADMIN/ACCOUNTANT |
| GET    | `/api/payroll/periods/:id`               | Період з рядками                       | OWNER/ADMIN/ACCOUNTANT |
| POST   | `/api/payroll/periods`                   | Створити (DRAFT)                       | OWNER/ADMIN/ACCOUNTANT |
| POST   | `/api/payroll/periods/:id/compute`       | Розрахувати (DRAFT→COMPUTED)           | OWNER/ADMIN/ACCOUNTANT |
| POST   | `/api/payroll/periods/:id/pay`           | Виплатити (COMPUTED→PAID)              | OWNER/ADMIN            |
| DELETE | `/api/payroll/periods/:id`               | Видалити (лише DRAFT/CANCELLED)        | OWNER/ADMIN            |

---

## Джерело виробітку

Агрегація `payroll.service.aggregate()` (raw SQL): `work_order_lines` JOIN `work_orders`, де
`wo.status IN (COMPLETED, INVOICED, PAID, ARCHIVED)` і `wo.completedAt` у межах періоду (Kyiv-TZ);
групування по **primary** `wol.employeeId`. baseAmount = Σ `wol.amount`, normoHours = Σ `wol.normoHours`.
tenant-isolation: orgId у WHERE на wol/wo.

---

## UI (Web)

| Компонент                        | Файл                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| Сторінка «Зарплата»              | `app/(app)/payroll/page.tsx` (розрахунок за період + періоди + виплата) |
| Hook                             | `hooks/api/usePayroll.ts`                                               |
| rateScheme у формі співробітника | `components/ui/EmployeeEditModal.tsx` (3 режими)                        |

Пункт меню «Зарплата» → `/payroll` (розділ «Звіти», OWNER/ADMIN/ACCOUNTANT).

---

## Обмеження v1

- **Асистенти** (`WorkOrderLineEmployee`, M:M) НЕ враховуються — нарахування лише primary виконавцю
  (`WorkOrderLine.employeeId`). Розподіл між асистентами — окремий крок (потребує поля частки у junction).
- **Виплата не через касу/розрахунки** — фіксується у `PayrollLine.paidAmount` + AuditEvent. Видаток
  готівки з каси (cash-out) — окрема майбутня робота (у CashShift зараз немає механізму видатку).

→ [docs/objects/employee.md](employee.md) · [docs/objects/work-order.md](work-order.md)
