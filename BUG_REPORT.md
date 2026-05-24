# BUG_REPORT.md — STO ERP

Дата: 2026-05-24
Сесія: /sto-tester цикл після додавання Playwright секції в SKILL.md

---

## Bug #1 — [MEDIUM] Дубль сервісу нумерації документів

**Файл:** `apps/api/src/modules/settings/document-numbering.service.ts`
**Severity:** MEDIUM
**Категорія:** business-logic / dead-code

**Опис:**
У проєкті існує **два** окремих сервіси нумерації документів:
- `apps/api/src/modules/document-number/document-number.service.ts` — `DocumentNumberService` (вживається у `work-orders`, `invoices`, `purchase-orders`, `stock-documents`)
- `apps/api/src/modules/settings/document-numbering.service.ts` — `DocumentNumberingService` (зареєстрований в `settings.module.ts`, але нікуди не імпортується)

Обидва читають одну й ту саму таблицю `document_number_configs`, але алгоритми reset/формат відрізняються (різні стратегії reset, різний date_format). Якщо колись `DocumentNumberingService` випадково підключать — отримаємо неконсистентну нумерацію між модулями. Це потенційна корупція даних (дублікати номерів між WO і Invoice неможливі через окремі `document_type`, але неоднакові правила reset порушать audit trail).

**Очікувана поведінка:**
Один сервіс нумерації — `DocumentNumberService` у `modules/document-number`. Видалити `DocumentNumberingService` з `settings` модуля разом з реєстрацією в `settings.module.ts`.

**Фактична поведінка:**
Дві паралельні реалізації, тільки одна активно вживається.

**Статус:** [x] виправлено

---

## Bug #2 — [LOW] services.service.ts FK-валідація findMany без take safety guard

**Файл:** `apps/api/src/modules/services/services.service.ts:53,60,94,106`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
`tx.work.findMany({ where: { id: { in: dto.works.map(w => w.workId) }, orgId, deletedAt: null } })` і аналогічно для `tx.good.findMany`. DTO задає теоретичний ліміт, але per skill policy потрібен `take: 1000` як safety guard від корумпованих DTO.

**Очікувана поведінка:**
`take: 1000` додано до всіх 4 викликів.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---

## Bug #3 — [LOW] employees.service.ts FK-валідація findMany без take safety guard

**Файл:** `apps/api/src/modules/employees/employees.service.ts:86,106,129`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
`this.prisma.zone.findMany({ where: { id: { in: dto.zoneIds }, orgId, deletedAt: null } })` (і аналогічно для lift, workCategory) — без `take: 1000` safety guard.

**Очікувана поведінка:**
`take: 1000` додано до всіх 3 викликів.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---

## Bug #5 — [LOW] services.service.ts serviceWorks/serviceGoods relation includes без take

**Файл:** `apps/api/src/modules/services/services.service.ts:19,20,33,34,70,71,120,121`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
8 relation includes для `serviceWorks` і `serviceGoods` без `take: 1000` safety guard. Хоча сервіс зазвичай має небагато робіт/товарів, policy вимагає додавати ліміт.

**Очікувана поведінка:**
Додати `take: 1000` до всіх 8 relation includes.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---

## Bug #6 — [HIGH] TopShell не блокує рендер дочірніх сторінок для неавторизованих

**Файл:** `apps/web/src/components/TopShell.tsx`
**Severity:** HIGH
**Категорія:** security / frontend

**Опис:**
Виявлено через Playwright E2E. Коли неавторизований відвідувач відкриває захищену сторінку (`/work-orders`), TopShell виконував `if (!employee) return <>{children}</>` — тобто **рендерив дочірню сторінку без shell, але саму сторінку показував повністю**. Заголовок "Наряди", фільтри по статусах, таблиця, кнопки — все видно. Лише запит даних висне в loading (бо API повертає 401).

Хоча реальних даних з API немає (захист сервера працює), UI скелетон витікає неавторизованому користувачу, оголюючи:
- Назви та структуру функціоналу системи
- Опції фільтрації, кнопки дій
- Layout та можливі ролі/permissions
- На певних сторінках — назви рядків таблиць (статуси, ярлики)

**Очікувана поведінка:**
Для неавторизованого користувача на не-публічному роуті TopShell повинен:
1. Показувати спінер доки `isLoading=true`
2. Робити `router.replace('/login')` при `!employee && !isLoading`
3. Не рендерити дочірню сторінку взагалі

**Фактична поведінка:**
Дочірня сторінка рендериться без auth guard — useRequireAuth в useEffect редиректить тільки **після** першого рендеру.

**Статус:** [x] виправлено — додано `PUBLIC_ROUTES` whitelist у TopShell + render-blocking guard + явний redirect через useEffect

**Виявлено через:** Playwright smoke test `e2e/smoke.spec.ts` — захищена сторінка без токена врешті redirect на /login

---

## Bug #4 — [LOW] purchase-orders.service.ts findOne lines relation include без take

**Файл:** `apps/api/src/modules/purchase-orders/purchase-orders.service.ts:59`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
`lines: { where: { deletedAt: null }, include: { good: ... } }` — пропущений `take` на relation include. Минулий цикл `/sto-tester` (Bug #4 у попередній сесії) додав `take: 1000` до інших викликів, але цей пропустив.

**Очікувана поведінка:**
Додати `take: 1000` до relation include.

**Фактична поведінка:**
Без `take`.

**Статус:** [x] виправлено

---

# Сесія 2026-05-25 — /sto-tester (FULL AUTO)

Сесія: статичний аналіз + перевірка raw SQL колонок проти реальної схеми БД.

---

## Bug #7 — [CRITICAL] DocumentNumberService.next використовує snake_case колонки замість camelCase — всі генерації номерів зламані

**Файл:** `apps/api/src/modules/document-number/document-number.service.ts:15-67`
**Severity:** CRITICAL
**Категорія:** business-logic / database

**Опис:**
`DocumentNumberService.next()` використовує raw SQL з snake_case колонками (`org_id`, `current_seq`, `include_date`, `last_reset_year`, `last_reset_month`, `reset_period`):

```sql
SELECT id, prefix, include_date, separator, padding,
       current_seq, reset_period, last_reset_year, last_reset_month, updated_at
FROM document_number_configs
WHERE org_id = ${orgId}::uuid
  AND document_type = ${documentType}::"DocumentType"
FOR UPDATE
```

Але фактичні колонки в БД — camelCase з лапками (`"orgId"`, `"currentSeq"`, `"includeDate"`, `"lastResetYear"`, `"lastResetMonth"`, `"resetPeriod"`, `"documentType"`). Перевірено через:
```
docker exec stoerp-postgres-1 psql -U sto -d sto_erp -c "SELECT column_name FROM information_schema.columns WHERE table_name='document_number_configs'"
-> orgId, documentType, prefix, includeDate, dateFormat, separator, padding, currentSeq, resetPeriod, updatedAt, lastResetMonth, lastResetYear, syncVersion
```

Це означає що **кожен запит** до генерації номеру наряду / рахунку / закупки / складського документа кидає Postgres error `column "org_id" does not exist`. Створення нарядів / рахунків / закупок / складських документів **повністю зламано**.

Чому unit тести зелені — вони мокають PrismaService.

**Очікувана поведінка:**
Raw SQL використовує camelCase з лапками: `"orgId"`, `"currentSeq"`, `"includeDate"`, `"resetPeriod"`, `"lastResetYear"`, `"lastResetMonth"`, `"documentType"`, `"updatedAt"`.

**Фактична поведінка:**
SQL крашиться, всі сервіси що залежать від `DocumentNumberService.next()` (work-orders, invoices, purchase-orders, stock-documents) не можуть створити записи.

**Виявлено через:** Cross-reference Prisma schema (camelCase без `@map`) проти SQL у `document-number.service.ts`. Підтверджено через `information_schema.columns` у Postgres.

**Статус:** [x] виправлено

---

## Bug #8 — [CRITICAL] InventoryService.findLowStockItems використовує snake_case колонки — endpoint GET /stock-items/low повертає 500

**Файл:** `apps/api/src/modules/inventory/inventory.service.ts:132-156`
**Severity:** CRITICAL
**Категорія:** business-logic / database

**Опис:**
`findLowStockItems()` використовує raw SQL з snake_case колонками (`si.good_id`, `si.org_id`, `si.deleted_at`, `si.min_stock`, `si.warehouse_id`, `g.deleted_at`, `w.deleted_at`):

```sql
FROM stock_items si
JOIN goods g ON g.id = si.good_id
JOIN warehouses w ON w.id = si.warehouse_id
WHERE si.org_id = ${orgId}::uuid
  AND si.deleted_at IS NULL
  ...
```

Але реальні колонки в БД — camelCase (`"orgId"`, `"goodId"`, `"warehouseId"`, `"deletedAt"`, `"minStock"`). Перевірено для `stock_items`:
```
id, orgId, goodId, warehouseId, quantity, reserved, minStock, syncVersion, updatedAt, createdAt, deletedAt
```

**Підтверджено вживу:** запит `GET /api/stock-items/low` з валідним JWT повертає `{"statusCode":500,"message":"Internal server error"}`.

**Очікувана поведінка:**
Raw SQL використовує camelCase з лапками: `si."orgId"`, `si."goodId"`, `si."warehouseId"`, `si."deletedAt"`, `si."minStock"`, `g."deletedAt"`, `w."deletedAt"`.

**Фактична поведінка:**
HTTP 500. Алерти "товари нижче мінімального залишку" не працюють — критична функція для комірника.

**Виявлено через:** Прямий виклик endpoint з валідним JWT.

**Статус:** [x] виправлено

---

## Bug #9 — [LOW] DocumentNumberService.next SELECT FOR UPDATE без LIMIT 1 (defensive)

**Файл:** `apps/api/src/modules/document-number/document-number.service.ts:28-35`
**Severity:** LOW
**Категорія:** database / defense-in-depth

**Опис:**
Skill вимагає `LIMIT N` на всіх raw queries (Prisma `take:` не діє на raw). Хоча `(orgId, documentType)` має UNIQUE index і фактично завжди повертає 0 або 1 рядок, defensive LIMIT 1 потрібен.

**Очікувана поведінка:**
Додати `LIMIT 1` до SELECT FOR UPDATE.

**Фактична поведінка:**
Без LIMIT.

**Статус:** [x] виправлено

---

## Bug #10 — [MEDIUM] Тести покриття: відсутні contract-тести для будь-якого endpoint

**Файл:** `apps/api/src/modules/*` (немає файлів `*.contract.spec.ts`)
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:**
Skill §1.4 вимагає `.contract.spec.ts` для work-orders, inventory, auth, settlements, sync. Жодного contract тесту немає — повна відсутність перевірки HTTP shape між API та фронтендом. Саме такі тести б виявили Bug #7 і #8 (через 500 від реальних endpoints).

**Очікувана поведінка:**
Хоча б 1 contract тест на критичний endpoint (наприклад `GET /stock-items/low` що б упіймало Bug #8).

**Фактична поведінка:**
0 contract тестів.

**Статус:** [ ] відкритий — додаткова робота поза рамками одного циклу /sto-tester (потрібен Supertest + harness setup)

---

## Bug #11 — [MEDIUM] Тести покриття: fast-check не встановлений, немає property-based тестів

**Файл:** `apps/api/package.json`
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:**
`fast-check` не встановлений. Немає property-based тестів для FSM, inventory, settlements інваріантів.

**Очікувана поведінка:**
`fast-check` встановлений + хоча б 1 invariants spec.

**Фактична поведінка:**
Відсутній.

**Статус:** [ ] відкритий — потребує окремого циклу встановлення залежностей

---

## Bug #12 — [MEDIUM] Тести покриття: @testing-library/react не встановлений, немає component тестів

**Файл:** `apps/web/package.json`
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:**
`@testing-library/react` не встановлений. Немає component тестів для Button/Select/Modal/Input/EmptyState.

**Очікувана поведінка:**
Залежність встановлена + хоча б 1 component тест.

**Фактична поведінка:**
Відсутній.

**Статус:** [ ] відкритий — потребує окремого циклу встановлення залежностей

---

## Bug #13 — [LOW] e2e/ містить тільки smoke.spec.ts, відсутні бізнес-flow тести

**Файл:** `apps/web/e2e/`
**Severity:** LOW
**Категорія:** test-coverage

**Опис:**
Skill §1.5 рекомендує `work-orders.spec.ts`, `work-order-flow.spec.ts`, `inventory.spec.ts`, `api-errors.spec.ts`. Тільки smoke є.

**Очікувана поведінка:**
Хоча б `inventory.spec.ts` і `api-errors.spec.ts` для перевірки error resilience.

**Фактична поведінка:**
Тільки smoke.

**Статус:** [ ] відкритий — потребує окремого циклу написання тестів

---
