
## Session 2026-05-26 — B12 (WorkOrderMedia), B11 (AuditEvent), B9+F7 (SSE Dashboard), B8 (FollowUp CRON), F9 (DatePickerInput), F4 (Clone WO/Invoice), F5 (Print CSS)

Запуск: FULL `/sto-tester`
Baseline:
- TypeScript: OK (web + api + shared)
- Unit tests: 142/142 passed (16 test files)

---

## Bug #81 — [HIGH] `WorkOrdersService.clone` не перераховує totals

**Файл:** `apps/api/src/modules/work-orders/work-orders.service.ts:228-272`
**Severity:** HIGH
**Категорія:** business-logic

**Опис:**
`clone()` копіює `lines` і `parts` оригіналу (з їх `amount`), але **НЕ копіює і НЕ перераховує** `totalLabor`, `totalParts`, `totalAmount`. WorkOrder.create() пише з Prisma defaults → всі totals == 0.

**Очікувана поведінка:**
Після клонування `totalLabor`, `totalParts`, `totalAmount` повинні відповідати сумам ліній/запчастин.

**Фактична поведінка:**
Користувач бачить новий DRAFT WO з усіма позиціями, але totals = 0,00 ₴. Інформація неконсистентна (UI малює `wo.lines[].amount=1500` поряд з `totalLabor=0`).

**Фікс:**
Після `prisma.workOrder.create(...)` обчислити суми з оригіналу і записати у `update`. Або обернути create+recalc у `$transaction` з викликом `recalcTotals`.

**Статус:** [ ] відкритий

---

## Bug #82 — [HIGH] `InvoicesService.clone` не перераховує VAT totals

**Файл:** `apps/api/src/modules/invoices/invoices.service.ts:150-199`
**Severity:** HIGH
**Категорія:** business-logic / financial

**Опис:**
`clone()` копіює `lines` оригіналу (з `priceWithoutVat`, `vatAmount`, `priceWithVat`) і `original.amount`, але **НЕ записує** `totalWithoutVat`, `totalVat`, `totalWithVat` у нову інвойс-сутність. Prisma defaults → 0.

**Очікувана поведінка:**
Клонована інвойс містить коректні `totalWithoutVat`/`totalVat`/`totalWithVat`, що відповідають копії ліній.

**Фактична поведінка:**
DetailPanel показує "Без ПДВ: 0,00 ₴ / ПДВ: 0,00 ₴ / З ПДВ: 0,00 ₴", але amount = original.amount → візуальна неконсистентність. PDF буде з amount, але без VAT breakdown.

**Фікс:**
Після `prisma.invoice.create(...)` викликати `recalcTotals(orgId, cloned.id)` (приватний метод вже існує).

**Статус:** [ ] відкритий

---

## Bug #83 — [HIGH] `DashboardService.lowStockCount` повертає всі StockItem, не товари з низьким залишком

**Файл:** `apps/api/src/modules/dashboard/dashboard.service.ts:59-65`
**Severity:** HIGH
**Категорія:** business-logic / KPI

**Опис:**
SSE `getSummary` має повертати кількість товарів де `quantity < good.minStock`, але код пише `prisma.stockItem.count({ where: { orgId } })` — повертає **всю кількість StockItem**. Коментар у коді визнає це: «`quantity < good.minStock` неможливо виразити декларативно у Prisma».

**Очікувана поведінка:**
Повернути кількість де `quantity < minStock` (узгоджено з `/stock-items/low` endpoint).

**Фактична поведінка:**
KPI картка "Низький залишок" показує загальну кількість всіх stock-items (іноді тисячі), що цілковито вводить в оману.

**Фікс:**
Використати raw SQL `$queryRaw` з JOIN на Good (camelCase колонки в `"orgId"`/`"minStock"`).

**Статус:** [ ] відкритий

---

## Bug #84 — [HIGH] Frontend settings шле `followUpActive`/`followUpDays`, але бекенд їх не приймає і не повертає

**Файл:**
- `apps/api/src/modules/settings/settings.dto.ts:41-97` (немає полів)
- `apps/api/src/modules/settings/settings.service.ts:186-216` (mapOrgSettings не повертає)
- `apps/web/src/app/settings/page.tsx:586-633` (UI шле в PATCH)

**Severity:** HIGH
**Категорія:** api-contract / data-loss

**Опис:**
Schema містить `OrganisationSettings.followUpActive`/`followUpDays` (додані в коміті e7e0c83), але DTO/сервіс не передають їх ні на запис, ні на читання. `ValidationPipe whitelist: true` мовчки відкидає поля з PATCH. `mapOrgSettings` не повертає ці поля → frontend завжди отримує `undefined`.

**Очікувана поведінка:**
PATCH `/settings/organisation` з `{ followUpActive, followUpDays }` має зберегти у БД; GET повертає ці значення.

**Фактична поведінка:**
Тогл "Включити нагадування" у settings нічого не зберігає. Після reload зникає state. Користувач не знає що нічого не записалось — повідомлення «Збережено» вводить в оману.

**Фікс:**
1. Додати `followUpActive?: boolean` (`@IsOptional() @IsBoolean()`) і `followUpDays?: number` (`@IsInt() @Min(30) @Max(365)`) у `UpdateOrganisationSettingsDto`.
2. Додати поля у `OrganisationSettingsResponseDto`.
3. Додати у `mapOrgSettings` повернення значень.

**Статус:** [ ] відкритий

---

## Bug #85 — [MEDIUM] `WorkOrderMedia` upload не використовує silent refresh — fail при expired access token

**Файл:** `apps/web/src/app/work-orders/[id]/PageClient.tsx:226-255`
**Severity:** MEDIUM
**Категорія:** frontend / UX

**Опис:**
`handleMediaUpload` використовує native `fetch` з Bearer токеном з sessionStorage. Access token живе ~15 хв; після його закінчення upload падає з 401, інкрементується `failures` без розуміння причини. Силент refresh з `api-client.ts` не задіюється.

**Очікувана поведінка:**
При 401 — викликати refresh, повторити upload з новим токеном. Як `apiBlobFetch`.

**Фактична поведінка:**
Користувач отримує абстрактне "Не вдалося завантажити N файл(ів)". Доводиться вручну перелогінитись.

**Фікс:**
Винести multipart upload у новий хелпер `apiMultipartFetch` в `api-client.ts` з тією ж refresh-логікою, що і `apiBlobFetch`. У PageClient.tsx замінити прямий `fetch` на `apiMultipartFetch`.

**Статус:** [ ] відкритий

---

## Bug #86 — [MEDIUM] `WorkOrdersService.update` не пише AuditEvent

**Файл:** `apps/api/src/modules/work-orders/work-orders.service.ts:153-184`
**Severity:** MEDIUM
**Категорія:** business-logic / audit-coverage

**Опис:**
Звичайний `update()` (зміна опису, mileage, priority, repairCategory, plannedAt, dueDate, clientApproval) **не пише AuditEvent**. B11 фіча обіцяла journal of changes. Зараз журналом фіксуються тільки CREATE/DELETE та FSM transition.

**Очікувана поведінка:**
Кожна зміна поля → запис в AuditEvent з diff oldData → newData.

**Фактична поведінка:**
У "Журналі змін" відсутні події редагування. Адмін не може дізнатись хто і коли змінив пробіг або дедлайн.

**Фікс:**
Передати `userId` з контролера у `update()`. Після `prisma.workOrder.update`, викликати `audit.record(orgId, 'WorkOrder', id, 'UPDATE', userId, oldData, newData)` (з catch у warn).

**Статус:** [ ] відкритий

---

## Bug #87 — [MEDIUM] `DatePickerInput.min`/`max` props ігноруються

**Файл:** `apps/web/src/components/ui/date-picker-input.tsx:10-22, 110-138`
**Severity:** MEDIUM
**Категорія:** frontend / contract

**Опис:**
Інтерфейс декларує `min?: string` і `max?: string` (YYYY-MM-DD), але **не передає** їх у `DayPicker` через `disabled={...}` правила. Також `handleInputChange` парсить дату без перевірки меж.

**Очікувана поведінка:**
Дні поза `[min, max]` повинні бути disabled у DayPicker і onChange не повинен викликатися при ручному вводі поза межами.

**Фактична поведінка:**
Користувач може вибрати/вводити будь-яку дату — обмеження невидиме для UI.

**Фікс:**
Перетворити `min`/`max` на Date і передати у DayPicker через `disabled={[{ before: minDate }, { after: maxDate }]}`. У `handleInputChange` після успішного parse — перевірити що дата в межах [min, max].

**Статус:** [ ] відкритий

---

## Bug #88 — [MEDIUM] `AuditService.findByEntity` повертає `total = items.length`, а не справжній count

**Файл:** `apps/api/src/modules/audit/audit.service.ts:41-64`
**Severity:** MEDIUM
**Категорія:** api-contract / pagination

**Опис:**
```ts
const items = await prisma.auditEvent.findMany({ ..., take: 100 });
return { items, total: items.length };
```
Якщо в БД 150 подій, фронт отримує `total: 100` — і думає що це повна кількість. Pagination ніколи не буде доданий, бо frontend думає що бачить все.

**Очікувана поведінка:**
`total` = справжній `prisma.auditEvent.count(where)`. Або хоча б позначка `hasMore: items.length === 100`.

**Фактична поведінка:**
Frontend не знає що деякі події приховані за межею 100.

**Фікс:**
Замінити на `$transaction([findMany, count])` і повернути справжній total.

**Статус:** [ ] відкритий

---

## Bug #89 — [LOW] Lightbox для media — немає Escape handler та a11y role

**Файл:** `apps/web/src/app/work-orders/[id]/PageClient.tsx:818-822`
**Severity:** LOW
**Категорія:** frontend / a11y / UX

**Опис:**
```jsx
{lightboxUrl && (
  <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
       onClick={() => setLightboxUrl(null)}>
    <img src={lightboxUrl} alt="Фото" ... />
  </div>
)}
```
- Немає `role="dialog"`/`aria-modal`/`aria-label`.
- Немає keyboard handler — клавіша Escape не закриває.
- Клавіатурні юзери не можуть закрити модалку.

**Очікувана поведінка:**
Lightbox — модальний; підтримує Escape; має ARIA-роль.

**Фактична поведінка:**
Mouse-only закриття.

**Фікс:**
Додати `role="dialog"`, `aria-modal="true"`, `aria-label="Перегляд фото"` і `useEffect` з `keydown` listener для Escape.

**Статус:** [ ] відкритий

---

## Bug #90 — [LOW] `WorkOrdersService.clone` і `InvoicesService.clone` не перевіряють чи FK-сутності soft-deleted

**Файл:**
- `apps/api/src/modules/work-orders/work-orders.service.ts:201-273`
- `apps/api/src/modules/invoices/invoices.service.ts:150-199`

**Severity:** LOW
**Категорія:** business-logic / error-UX

**Опис:**
Клонування не валідує що `vehicleId`/`counterpartyId`/`branchId` ще існують (не soft-deleted). Якщо оригінал старий — Prisma викине P2003 FK error замість дружнього 404.

**Очікувана поведінка:**
Чітке повідомлення «Контрагент / Авто / Філію видалено — клонування неможливе».

**Фактична поведінка:**
500 з технічним повідомленням Prisma.

**Фікс:**
Додати парне `findFirst({ where: { id, orgId, deletedAt: null } })` для кожного FK перед `create`.

**Статус:** [ ] відкритий

---
