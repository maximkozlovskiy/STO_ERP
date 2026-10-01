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
  workOrders PayrollLineWorkOrder[]
  // @@unique([periodId, employeeId]); @@index([orgId,employeeId])
}

model PayrollLineWorkOrder {     // розшифровка нарахування по нарядах (snapshot на COMPUTED)
  id, orgId, payrollLineId
  workOrderId String             // без FK-cascade: snapshot переживає видалення наряду
  workOrderNumber String         // snapshot номера (НРД-2026-0001)
  vehicleName String?            // snapshot авто («Toyota Camry · AA1234BB»)
  worksCount Int                 // к-сть врахованих робіт цього наряду
  normoHours Float               // Σ normoHours робіт наряду
  baseAmount Decimal(12,2)       // Σ amount робіт наряду (частка бази)
  syncVersion, createdAt, updatedAt
  // @@index([orgId,payrollLineId]) [orgId,syncVersion]; FK → payroll_lines RESTRICT
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
- **remove**: soft-delete; заборонено лише для PAID (COMPUTED можна відкинути й перерахувати — ще не виплачено).

---

## API Endpoints (`/api/payroll`)

| Метод  | URL                                       | Дія                                       | Ролі                   |
| ------ | ----------------------------------------- | ----------------------------------------- | ---------------------- |
| GET    | `/api/payroll/preview?from&to&branchId?`  | Попередній розрахунок (без збереження)    | OWNER/ADMIN/ACCOUNTANT |
| GET    | `/api/payroll/periods?page&limit&status?` | Сторінка періодів (lines БЕЗ розшифровки) | OWNER/ADMIN/ACCOUNTANT |
| GET    | `/api/payroll/periods/:id`                | Період + рядки + розшифровка по нарядах   | OWNER/ADMIN/ACCOUNTANT |
| POST   | `/api/payroll/periods`                    | Створити (DRAFT)                          | OWNER/ADMIN/ACCOUNTANT |
| POST   | `/api/payroll/periods/:id/compute`        | Розрахувати (DRAFT→COMPUTED)              | OWNER/ADMIN/ACCOUNTANT |
| POST   | `/api/payroll/periods/:id/pay`            | Виплатити (COMPUTED→PAID)                 | OWNER/ADMIN            |
| DELETE | `/api/payroll/periods/:id`                | Видалити (окрім PAID)                     | OWNER/ADMIN            |

---

**Пагінація списку** (`PayrollPeriodListQueryDto`): `page` (≥1, деф. 1), `limit` (1–200, деф. 20),
`status` (DRAFT|COMPUTED|PAID|CANCELLED, `PAYROLL_PERIOD_STATUSES` — єдине місце правди).
Відповідь — `PaginatedPayrollPeriodsDto { items, total, page, limit }` (контракт `usePaginatedList`);
`page`/`limit` віддаються НОРМАЛІЗОВАНІ (похідні від skip/take), не сирі query-значення.
Сортування: `createdAt desc, periodStart desc` — щойно створений період завжди на 1-й сторінці,
навіть якщо перераховують давній місяць. `count` використовує ТОЙ ЖЕ `where`, що й `findMany`.

---

## Джерело виробітку

Агрегація `payroll.service.aggregate()` (raw SQL): `work_order_lines` JOIN `work_orders`, де
`wo.status IN (COMPLETED, INVOICED, PAID, ARCHIVED)` і `wo.completedAt` у межах періоду (Kyiv-TZ);
групування по **primary** `wol.employeeId`. baseAmount = Σ `wol.amount`, normoHours = Σ `wol.normoHours`.
tenant-isolation: orgId у WHERE на wol/wo.

---

## Розшифровка по нарядах (breakdown)

`payroll.service.aggregateWorkOrders()` — той самий фільтр/період, але `GROUP BY employeeId, workOrderId`
(+ LEFT JOIN `vehicles` для snapshot назви авто). Викликається у `compute()` і пише
`PayrollLineWorkOrder[]` разом із рядками — **розшифровка фіксується як snapshot**, тому ЗАВЖДИ
сходиться з `PayrollLine.baseAmount`, навіть якщо наряди згодом змінили/видалили.

- **Показуємо БАЗУ, не розкидане нарахування.** Схема оплати застосовується до СУМИ бази, а не до
  кожного наряду окремо → по-нарядно `accruedAmount` не розкидається (уникаємо штучного розподілу
  фіксованої частини `fixed_plus_bonus` і копійчаних розбіжностей). Підсумок `tfoot` = `baseAmount`.
- Σ дочірніх `baseAmount` == `PayrollLine.baseAmount` гарантовано: `WorkOrderLine.amount` — вже
  `Decimal(12,2)`, тож `roundMoney` на кожному наряді — no-op (розбіжність округлення неможлива).
- `compute()` створює рядки **по одному** (`create`, не `createMany`) — потрібен `lineId` для дітей.
  Перерахунок: спершу `deleteMany` дітей, потім батьків (FK RESTRICT).
- `findOne()` вантажить `lines.workOrders`; **`findAll()` НЕ вантажить** (важко) → UI при розкритті
  періоду робить окремий `GET /periods/:id`.
- Періоди, розраховані ДО впровадження, розшифровки не мають → UI показує `breakdown.empty`.

---

## UI (Web)

| Компонент                        | Файл                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| Сторінка «Зарплата»              | `app/(app)/payroll/page.tsx` (розрахунок + періоди + виплата + breakdown) |
| Hook                             | `hooks/api/usePayroll.ts`                                                 |
| rateScheme у формі співробітника | `components/ui/EmployeeEditModal.tsx` (3 режими)                          |

Пункт меню «Зарплата» → `/payroll` (розділ «Звіти», OWNER/ADMIN/ACCOUNTANT).

**Drill-down розшифровки:** розкриття періоду → `usePayrollPeriod(id)` (детальний запит); розкриття
рядка співробітника (стан `expandedEmployee = \`${periodId}:${employeeId}\``) → вкладена таблиця
нарядів: № (Link на картку) · авто · робіт · нормо-год · сума робіт, `tfoot`«Разом база».
i18n-ключі`breakdown.*` (uk/en parity).

**List Page pattern** (еталон work-orders): `useListPage<PayrollFilters>('payroll-periods', …)` →
пагінація (`Pagination`, limit 20), фільтр статусу (`filters.*` i18n), `ColumnsDropdown` над
6 колонками (`period`/`note`/`status`/`totalAccrued`/`totalPaid`/`computedAt`, module-level
`PERIOD_COLUMN_DEFS` + labelKey idiom), `useSavedFilters` (пресет = {status}).
**Bulk-select свідомо НЕ підключено** — compute/pay строго по одному періоду (FSM), масові
операції тут шкідливі. Зміна фільтра/сторінки скидає `expanded`/`expandedEmployee` (рядок може
зникнути з поточної сторінки).

**`data-testid` на `<tbody>`, не на `<tr>`:** один `<tbody data-testid="payroll-period-<id>">` тримає
рядок-шапку + розкриту розшифровку під спільним вузлом — E2E скоупить статус-badge, FSM-кнопки й
drill-down на один `getByTestId`. Декілька `<tbody>` в одній `<table>` — валідний HTML.

**E2E:** `apps/web/e2e/payroll.spec.ts` (7 тестів) — сторінка/панелі/nav, preview-розрахунок, повний
FSM через UI (create→compute→pay через модалку виплати), drill-down, FSM-guard. Cleanup-хелпер
читає `?page=1&limit=200` (список paginated).
**Component-тести:** `__tests__/PayrollBreakdown.test.tsx` (5 — drill-down) +
`__tests__/PayrollListPage.test.tsx` (8 — пагінація/фільтр/колонки/testid).

---

## Обмеження v1

- **Асистенти** (`WorkOrderLineEmployee`, M:M) НЕ враховуються — нарахування лише primary виконавцю
  (`WorkOrderLine.employeeId`). Розподіл між асистентами — окремий крок (потребує поля частки у junction).
- **Виплата — готівка або лише фіксація.** З `cashRegisterId` → `CashOperation(OUT, reason=PAYROLL,
employeeId, documentType='PayrollPeriod')` на кожного співробітника у транзакції `pay()`. Без нього —
  лише `paidAmount ← accruedAmount` + AuditEvent (без руху грошей). Безготівкової/банківської виплати
  ЗП немає; `SettlementTransaction`/`Payment` при виплаті НЕ створюються.
- **Податків немає** — ні ЄСВ, ні ПДФО; `accruedAmount` без утримань, `paidAmount == accruedAmount`
  (часткових виплат немає). Брутто/нетто не розділені.
- **`laborCostRatio`** (OrganisationSettings, 0.4) — це ОЦІНКА ФОП для `reports.profitability`, а НЕ
  реальне нарахування. Payroll її не читає: реальна ЗП = rateScheme × фактичний виробіток.
- **CANCELLED** є в enum, але переходу в сервісі немає.

→ [docs/objects/employee.md](employee.md) · [docs/objects/work-order.md](work-order.md)
