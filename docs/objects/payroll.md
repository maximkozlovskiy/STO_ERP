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
  // @@index([orgId,payrollLineId]) [orgId,workOrderId] [orgId,syncVersion]; FK → payroll_lines RESTRICT
  // [orgId,workOrderId] — пошук «наряд уже в іншій відомості» (BR-PAYR-015), міграція 20261008120000
}
```

Employee += `payrollLines PayrollLine[]`; Organisation += `payrollPeriods PayrollPeriod[]`.
SYNC_VERSION_MODELS += PayrollPeriod/PayrollLine; audit whitelist += PayrollPeriod.

---

## rateScheme (Employee.rateScheme, Zod у employees.dto.ts)

| type               | params                           | нарахування                                                                       |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------- |
| `percent_normo`    | `{ percent }`                    | percent% × baseAmount (сума робіт)                                                |
| `per_normo_hour`   | `{ ratePerHour }`                | ratePerHour × normoHours                                                          |
| `fixed_plus_bonus` | `{ fixedMonthly, bonusPercent }` | fixedMonthly × частка періоду в місяці + bonusPercent% × baseAmount (BR-PAYR-006) |

Розрахунок — `payroll.calculator.ts` (`computeAccrued`), гроші через `roundMoney` (half-away-from-zero).
Невалідна/відсутня схема → 0.

---

## FSM

```
DRAFT → COMPUTED → PAID
   ↘ (delete)      (delete заборонено лише на PAID — BR-PAYR-012)
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
- Окладник без робіт за період (`linesCount = 0`, BR-PAYR-001) розшифровки не має за змістом → UI
  показує `breakdown.noWorks` («нараховано лише оклад»), а не `breakdown.empty`.

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
**Component-тести:** `__tests__/PayrollBreakdown.test.tsx` (6 — drill-down, окладник без робіт) +
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

→ [work-order.md](work-order.md) · [work.md](work.md)

> Окремого дос'є Employee немає: `rateScheme` описаний тут, компетенції (зони/підйомники/категорії) — у [work.md](work.md).

---

## Бізнес-правила (BR-PAYR)

> Правила виведено з коду 2026-10-08, власником не затверджені.

- **BR-PAYR-001**: Джерело виробітку. База нарахування — рядки робіт нарядів (`work_order_lines`),
  згруповані за **основним** виконавцем рядка (`WorkOrderLine.employeeId`): `baseAmount = Σ amount`,
  `normoHours = Σ normoHours`, `linesCount` — кількість рядків. Беруться лише невидалені рядки
  невидалених нарядів у статусі `COMPLETED`, `INVOICED`, `PAID` або `ARCHIVED`; запчастини в базу не
  входять, асистенти рядка нічого не отримують, видалений працівник у відомість не потрапляє.
  Працівник на відсотку чи погодинній ставці без жодної роботи за період рядка не має. Працівник
  на окладі (`fixed_plus_bonus`) рядок отримує завжди — з базою 0 і окладом за BR-PAYR-006 — якщо
  він активний (`status = ACTIVE`), не видалений, прийнятий не пізніше кінця періоду й не звільнений
  до його початку; у відомості по філії — лише прив'язаний до неї або з доступом до всіх філій
- **BR-PAYR-002**: Період — календарні дні Києва, обидва включно: від 00:00:00.000 дня початку до 23:59:59.999 дня кінця за київським часом, з урахуванням літнього/зимового часу. З цими межами порівнюється дата завершення наряду (`completedAt`), а не дата створення чи оплати. Початок пізніше кінця → 400 «Дата початку має бути не пізніше дати закінчення» — і в попередньому розрахунку, і при створенні відомості. Розрахунок бере межі зі збережених дат відомості й дає ті самі межі рядкам і розшифровці по нарядах
- **BR-PAYR-003**: Філія. Відомість із філією рахує лише наряди цієї філії (`work_orders.branchId`); без філії — наряди всіх філій організації. Філія мусить існувати в організації й не бути видаленою, інакше 404 «Філію не знайдено» (попередній розрахунок і створення відомості). Розрахунок застосовує філію збереженої відомості і до рядків, і до розшифровки
- **BR-PAYR-004**: Схема `percent_normo` `{ percent }`: нараховано = `baseAmount × percent / 100`. Від нормо-годин не залежить. Відсоток застосовується до суми бази співробітника за період, а не до кожного наряду окремо
- **BR-PAYR-005**: Схема `per_normo_hour` `{ ratePerHour }`: нараховано = `normoHours × ratePerHour`. Від суми робіт не залежить
- **BR-PAYR-006**: Схема `fixed_plus_bonus` `{ fixedMonthly, bonusPercent }`: нараховано =
  `fixedMonthly × частка періоду + baseAmount × bonusPercent / 100`. Частка періоду — сума по
  календарних місяцях, які він зачіпає: `днів періоду в місяці / днів у місяці` (обидві дати
  включно). Повний місяць — повний оклад; тиждень у 30-денному місяці — 7/30; 25.09–05.10 —
  6/30 + 5/31. Тижневі відомості за місяць у сумі дають один оклад. Від розміру бази оклад не
  залежить (база 0 → лише оклад за частку)
- **BR-PAYR-007**: Немає схеми або схема невалідна (не об'єкт, невідомий тип, параметр відсутній чи не скінченне число) → нараховано 0, тип схеми в рядку — `unknown`. Рядок співробітника у відомості лишається (з базою і нормо-годинами); помилки немає
- **BR-PAYR-008**: Округлення. Нарахування округлюється до копійки один раз — від підсумку формули; рівно пів копійки округлюється від нуля (0,125 → 0,13). Від'ємна база чи від'ємні нормо-години рахуються як 0, тож нарахування не буває від'ємним через виробіток і не буває меншим за фіксовану частину. Підсумки відомості («нараховано», «виплачено») і підсумок попереднього розрахунку = сума рядків, округлена до копійки
- **BR-PAYR-009**: Створення й розрахунок. Відомість створюється у статусі `DRAFT` без рядків; створення нічого не рахує. Розрахувати можна лише `DRAFT`, інакше 400 «Розрахувати можна лише період у статусі «Чернетка»». Перехід `DRAFT → COMPUTED` умовний (зміна статусу з умовою «досі DRAFT»); хто програв гонку — 400 «Період уже розраховано або змінено іншим користувачем», рядки не чіпаються. У тій самій транзакції записується знімок: по одному рядку на співробітника з виробітком (тип схеми, база, нормо-години, кількість рядків робіт, нараховано) і розшифровка по нарядах (id і номер наряду, назва авто, кількість робіт, нормо-години, база); фіксуються час і автор розрахунку. Якщо завершених робіт за період немає — відомість усе одно стає `COMPUTED`, без рядків. Далі відомість читається зі знімка; переходу назад у `DRAFT` немає — щоб перерахувати, відомість видаляють і створюють нову
- **BR-PAYR-010**: Виплата. Виплатити можна лише `COMPUTED`, інакше 400 «Виплатити можна лише розрахований період» — зокрема повторна виплата `PAID` відхиляється. Перехід `COMPUTED → PAID` умовний; хто програв гонку — 400 «Період уже виплачено або змінено іншим користувачем», суми не проставляються. Виплата завжди повна й на всіх одразу: у кожному рядку цієї відомості `paidAmount := accruedAmount`; часткової виплати й виплати окремому співробітнику немає. Фіксуються час і автор виплати
- **BR-PAYR-011**: Каса. Якщо при виплаті вказано касу — у тій самій транзакції, після захоплення статусу, на кожного співробітника з нарахуванням більше нуля створюється касова операція: видача (`OUT`), причина `PAYROLL`, сума = нараховане, співробітник, документ `PayrollPeriod` + id відомості, автор — той, хто виплачує. Рядки з нарахуванням 0 пропускаються. Помилка каси (недостатньо готівки, немає відкритої зміни) не ковтається — іде викликачу, і транзакція відкочує всю виплату. Без каси — лише фіксація виплати, касових операцій немає. Взаєморозрахунки (`SettlementTransaction`) виплата не чіпає в жодному з варіантів
- **BR-PAYR-012**: Видалення. Виплачену (`PAID`) відомість видалити не можна → 400 «Не можна видалити виплачений період». `DRAFT`, `COMPUTED` і `CANCELLED` видаляються м'яко (`deletedAt`); рядки й розшифровка при цьому не чіпаються
- **BR-PAYR-013**: Ізоляція організацій. Відомість шукається за `id` + `orgId` викликача + «не видалена» (перегляд, розрахунок, виплата, видалення); чужа або видалена → 404 «Період не знайдено», нічого не пишеться. Список і його лічильник фільтруються тим самим `orgId` + «не видалена». Філія перевіряється в межах організації. Агрегат виробітку отримує `orgId` і для рядків робіт, і для нарядів. Усі записи (відомість, рядки, розшифровка, зміна статусу, чистка старих рядків, касова операція) несуть `orgId` викликача
- **BR-PAYR-014**: Ролі. Попередній розрахунок, список, перегляд, створення і розрахунок відомості — `OWNER`, `ADMIN`, `ACCOUNTANT`. Виплата і видалення — лише `OWNER`, `ADMIN`. `MECHANIC` і `RECEPTIONIST` доступу до маршрутів зарплати не мають. (Саму ставку `Employee.rateScheme` віддає модуль employees — лише `OWNER`/`ADMIN`; це поза цим агрегатом.)
- **BR-PAYR-015**: Наряд входить лише в одну відомість. Розрахунок і попередній розрахунок
  пропускають роботи наряду, якщо пара (наряд, працівник) уже є в розшифровці іншої невидаленої
  відомості у статусі `COMPUTED` або `PAID`. Періоди можуть перетинатись — двічі за ті самі
  роботи не нараховується. Видалена відомість свої наряди звільняє. Розрахунки однієї організації
  виконуються по черзі (транзакційне блокування), тож два одночасні розрахунки перетинних
  відомостей не нарахують той самий наряд обидва

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/payroll/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/payroll/`

| Аспект                                       | Тест                                  | Кейсів |
| -------------------------------------------- | ------------------------------------- | ------ |
| calculator (формули схем, округлення)        | `payroll.calculator.spec.ts`          | 16     |
| сервісна логіка (розшифровка, список)        | `payroll.service.spec.ts`             | 33     |
| межі періоду за Києвом, філія                | `payroll.period-bounds.spec.ts`       | 13     |
| життєвий цикл: створення → розрахунок → каса | `payroll.fsm.spec.ts`                 | 24     |
| ізоляція організацій                         | `payroll.tenant.spec.ts`              | 13     |
| ролі доступу                                 | `payroll.access.spec.ts`              | 8      |
| хто у відомості й частка окладу              | `payroll.accrual.spec.ts`             | 24     |
| нарахування на живій БД (integration)        | `payroll.accrual.integration.spec.ts` | 7      |

Разом: **138** кейсів (цифри з `vitest --reporter=json`, не з grep).

Спільна фікстура нових аспектних спеків — `payroll.spec-fixture.ts` (factory `makePayrollFixture()`);
`payroll.service.spec.ts` лишився на власному `makeMocks()`.

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) немає, хоча агрегат на шляху грошей або статусів: властивості на кшталт «фінальний статус без виходів» не стережуться нічим. Свідома прогалина — кандидат на окремий крок.

HTTP-контракту (`*.contract.spec.ts`) немає: DTO, статуси й валідацію покриває лише E2E.

Джерело виробітку й умову «наряд уже в іншій відомості» виконує сирий
SQL: unit-спеки бачать лише його параметри, результат стереже integration-спек на живій БД
(без БД він пропускається; у CI з `REQUIRE_DB=1` — падає, якщо БД немає).

Прогалини, що не є окремим правилом:

- Незмінність знімка (правило про розрахунок: «далі відомість читається зі знімка») unit-тестом не доведена: перевірено, що знімок ПИШЕТЬСЯ, але «змінили наряд після розрахунку — відомість та сама» потребує integration-спеку.
- Відкат виплати при помилці каси (правило про касу) перевірено лише як «помилка не проковтнута»; сам відкат робить транзакція БД, у unit-тесті її немає.
- `paidAmount := accruedAmount` (правило про виплату) — сирий `UPDATE`; тест стереже його текст і параметри (`orgId`, `periodId`), а не результат у БД.
- Гонка «виплата ‖ видалення»: `remove()` перевіряє статус окремим читанням, а позначку ставить без умови на статус — тесту на це немає (див. знахідки агента 2026-10-08).
