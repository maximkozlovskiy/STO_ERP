# sto-review — журнал: database

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../sections/database.md`.

### 2026-10-26 — Валюта як аналітика (BR-RPT-029): COALESCE без `bounds` у Prisma; два LIMIT-запити ріжуть різні групи; змішана група сортується як 0 — §6

**Сигнал:** рев'ю `7e27c2b5`. (1) `baseCurrencyMatches` (Prisma-емуляція `COALESCE(код, базова)`) знав `eq/ne/in/contains`, а `gt/gte/lt/lte` на тексті коду дозволені — «код ≥ D» у Prisma губив платежі без валюти, SQL їх рахував. (2) ROLLUP і `GROUPING SETS` розбивки за валютами мали `ORDER BY` лише рівня: на перевищенні лімітів кожен відрізав довільний хвіст найглибших груп, і група з дерева лишалась без розбивки — `maskMixedCurrency({})` нічого не маскував, клітинка показувала суму гривень із доларами. (3) `sortNodes` трактував `null` змішаної групи як 0 — найбільша група опинялась унизу «топу». **Grep:** `grep -n "case '" report-query.builder.ts` проти видів `ReportCond`; `grep -n "ORDER BY" report-sql.builder.ts`. **Фікс:** гілка `bounds`; спільний `levelOrderSql` (рівень, далі ключі) в обох запитах + група без розбивки — без спільного числа; змішані групи в кінець за будь-якого напрямку. **Severity:** IMPORTANT

### 2026-10-25 — ROLLUP + LIMIT без ORDER BY ріже «Разом»; агрегат без GROUP BY — фантомний рядок — §6

**Сигнал:** `report-sql.builder.ts` (BR-RPT-027): `GROUP BY ROLLUP (k0, k1) LIMIT 20001` без `ORDER BY`. EXPLAIN на dev-БД — `MixedAggregate` (хеш), порядок рядків довільний; на перевищенні ліміту губились «Разом» і батьківські групи. Склеювання плоских рядків лише з підсумовуваних колонок: `SELECT SUM(…) … WHERE …` без GROUP BY над порожньою вибіркою давав рядок нулів (JS-еталон — `[]`). Паритет-тест не ловив: матриця не мала ні >20 000 груп, ні конфігу «лише суми + порожньо».
**Grep:** `grep -rn "ROLLUP\|GROUPING SETS" apps/api/src --include="*.ts" | grep -v spec`
**Фікс:** `ORDER BY GROUPING(k0) + … DESC LIMIT …`; `HAVING COUNT(*) > 0`, коли GROUP BY порожній. Тести форми SQL з мутацією (`report-sql.builder.spec.ts`).
**Severity:** IMPORTANT

### 2026-05-28 — schema.prisma enum/поле змінено без міграції — §6

**Сигнал:** diff містить зміну `schema.prisma` (нове enum-значення/поле/модель) але без папки у `migrations/`.
**Фікс:** папка `YYYYMMDDHHMMSS_<desc>/migration.sql`; enum → `ALTER TYPE "Enum" ADD VALUE IF NOT EXISTS 'X';` (окремий файл — Postgres забороняє ADD VALUE + use у одній транзакції).
**Severity:** CRITICAL — TS зелений, runtime fail; tsc мовчить.

### 2026-09-06 — getLinkedCounts рахує FK-наявність, detail фільтрує deletedAt:null → count!=detail — §6/§13

**Сигнал:** новий `getLinkedCounts(orgId, ids)` рахує пов'язані сутності за самою наявністю FK (`X.purchaseOrderId ? 1 : 0`, обов'язковий FK → `1`), тоді як парний `getLinkedDocuments` робить `findFirst({ deletedAt: null })` і повертає `[]` коли реф soft-deleted. FK `ON DELETE SET NULL` спрацьовує ЛИШЕ при hard-delete → soft-delete лишає FK вказувати на мертвий рядок → badge «1», панель порожня (Bug #A/#641 count!=detail). Канонічний патерн у `invoices.getLinkedCounts` (коментар «Bug #A»); нові модулі (stock-documents/supplier-returns) його пропускали.
**Grep:** `grep -rn "getLinkedCounts" apps/api/src/modules --include="*.service.ts"` → для кожного: чи є `findMany` живих реф-id (PO/warehouse/counterparty) + `Set`-membership перед інкрементом, чи безумовне `? 1 : 0` / `= 1`. Обов'язковий FK (`warehouseId`/`supplierId`) ≠ живий → теж gate через liveness.
**Фікс:** зібрати унікальні реф-id → `findMany({ where: { id: { in: [...] }, orgId, deletedAt: null }, select: { id: true } })` → `new Set(...)` → `refId && liveSet.has(refId) ? 1 : 0` (дзеркалить invoices). +spec: soft-deleted реф → count=0.
**Severity:** IMPORTANT — badge/панель розсинхрон; німа degradation (лише коли реф soft-deleted поки документ на нього посилається).

### 2026-10-08 — NOT EXISTS по таблиці-знімку без індексу — §6

**Сигнал:** `NOT EXISTS (… payroll_line_work_orders plw WHERE plw."orgId" = … AND plw."workOrderId" = wo.id …)` при індексах лише `(orgId, payrollLineId)`, `(orgId, syncVersion)`. `EXPLAIN`: `Nested Loop Anti Join` → `Seq Scan on payroll_line_work_orders` на кожен рядок робіт. **Grep:** `grep -rn "NOT EXISTS\|EXISTS (" apps/api/src --include="*.ts" -A8 | grep -v spec` → для кожної колонки кореляції перевірити `@@index` у схемі. **Фікс:** міграція `CREATE INDEX IF NOT EXISTS … ("orgId", "workOrderId")` + `@@index` у схемі; після — `EXPLAIN` показує `Index Scan`. **Severity:** IMPORTANT

### 2026-10-09 — «Порядок введення» за `createdAt` для рядків, створених однією транзакцією — §6

**Сигнал:** Bug #814 додав у друкований наряд і в рахунок з наряду `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]` з коментарем «у порядку введення, як на екрані». Екран (`findOne`) читає рядки з `orderBy: { createdAt: 'asc' }` без другого ключа. На dev-базі є наряди, де кілька рядків мають однаковий `createdAt` (створені разом із нарядом), а `id` — `gen_random_uuid()`. Отже друк упорядковує такі рядки за випадковим UUID, а екран — як віддасть Postgres (зазвичай у порядку вставки, доки рядок не оновили).
**Grep:** `grep -rnE "orderBy: (\[\{ createdAt: 'asc' \}, \{ id: 'asc' \}\]|\{ createdAt: 'asc' \})" apps/api/src/modules/work-orders apps/api/src/modules/invoices --include="*.service.ts"`; перевірка даних: `select "workOrderId" from work_order_lines group by "workOrderId", "createdAt" having count(*) > 1`.
**Фікс:** не зроблено — потрібне рішення власника: колонка позиції рядка (міграція) або один `orderBy` на всі читання. Детермінованість «останнього рядка», що забирає копійку округлення (BR-INV-002), Bug #814 уже дав.
**Severity:** IMPORTANT — документ друкується не в тому порядку, що на екрані; на суми не впливає.

### 2026-10-12 — `equals` + `insensitive` = ILIKE без екранування; унікальність без блокування — §6

**Сигнал:** BR-GOOD-007 (одне написання — один бренд) перевіряв зайнятість через `{ equals: s, mode: 'insensitive' }`. Через API: синонім «REVIEWBRa_c» дістав 409 «уже належить бренду» проти чужого «REVIEWBRaXc», а «REVIEWBR%» — проти будь-якого синоніма з таким початком. Там само: перевірка читала до запису без транзакції, тож два одночасні збереження проходили обидва; `restore` і вкладений `createMany skipDuplicates` у `create` правило оминали; імпорт брендів розпізнавав «уже існує» за словом у тексті помилки й рахував відмову правила як «оновлено».
**Grep:** `grep -rn -B3 "mode: 'insensitive'" apps/api/src --include="*.ts" | grep -v spec | grep "equals"`; для правила унікальності — `grep -rn "<model>\.\(create\|update\|upsert\|createMany\|updateMany\)" apps/api/src --include="*.ts" | grep -v spec` і пройти КОЖЕН писач.
**Фікс:** екранування `\`, `%`, `_` + рішення за ключем у JS; перевірка й запис в одній `$transaction` під `pg_advisory_xact_lock`; виняток у масовому імпорті розпізнається за класом і ключем перекладу, не за підрядком. Лишилось: `works.service.ts` `findCategoryByName` має той самий `equals` + `insensitive` без екранування.
**Severity:** IMPORTANT — хибна відмова у збереженні та мовчазна втрата синоніма.

### 2026-10-14 — Рукописний частковий індекс без сторожа — §6

**Сигнал:** міграція `20261014100000` створює `expense_categories_default_reason_uq`, а в
`schema-integrity.integration.spec.ts` його не було: сторож дрейфу `DROP INDEX` не рахує.
**Grep:** див. пункт секції. **Фікс:** рядок у переліку індексів спеку. **Severity:** IMPORTANT

### 2026-10-16 — `{ not: X }` на nullable FK відкидає NULL — §6

**Сигнал:** `checkConflicts({ excludeWorkOrderId })` (картка наряду) і `syncWorkOrderSlots` фільтрували
`workOrderId: { not: X }`. Prisma будує `"workOrderId" <> $1`, а `NULL <> X` — не істина: записи без
наряду (на dev-БД 194 із 313) випадали з перевірки зайнятості. Наживо: попередження в картці «вільно»,
а збереження наряду (BR-WO-020) — 400 «Підйомник зайнятий». Форм-тест сервісу (`toEqual(where)`)
закріплював саме баг.
**Grep:** `grep -rnE "[a-zA-Z]+Id: \{ not: [a-zA-Z.]+ \}" apps/api/src/modules --include="*.ts" | grep -v spec`
**Фікс:** `AND: [..., { OR: [{ workOrderId: null }, { workOrderId: { not: X } }] }]`; тест на
`buildSlotStorePrisma` (`matchesWhere` моделює SQL-семантику `not`) із записом `workOrderId: null` + контроль
«власний запис — не конфлікт» (`calendar.conflicts.spec.ts`).
**Severity:** IMPORTANT

### 2026-10-18 — Redis-кеш DTO переживає міграцію — §6

**Сигнал:** нові поля `OrganisationSettings.supplier*`, `getOrganisationSettings` кешує змаплений DTO
5 хв під ключем `settings:org:<id>` → перші ≤5 хв після оновлення `supplierOfferTtlMinutes` undefined,
`POST /supplier-offers/search` 400 (знайшов виконавець блоку «Постачальники API»).
**Grep:** `grep -rn "redis.set(" apps/api/src --include="*.ts" | grep -v spec`
**Фікс:** ключ `settings:org:<sha1(ScalarFieldEnum)[0..8]>:<id>` — змінюється сам із кожною колонкою;
регресія в `settings.service.spec.ts` (старий ключ не читається, мутацією перевірено).
**Severity:** IMPORTANT

### 2026-10-18 — Прихований фільтром рядок і далі тримає EXCLUDE — §6

**Сигнал:** BR-WO-022 — скасування наряду позначає його записи календаря видаленими, а для старих
записів додано лише фільтр `OF_LIVE_WORK_ORDER` (`status ≠ CANCELLED`) у `findSlots`/`busyWhere`.
EXCLUDE `calendar_slots_no_overlap` (`WHERE "deletedAt" IS NULL`), `BookingService`, звіт
завантаження постів і sync планшета фільтра не мають: живий запис скасованого наряду невидимий, але
займає підйомник — новий запис отримує 409 «щойно зайняли». Форма календаря ще й дозволяла
прив'язати НОВИЙ запис до скасованого наряду.
**Grep:** `git diff <base> -- apps/api/src | grep -nE "^\+.*status: \{ not:"`; `grep -rn "EXCLUDE" packages/database/prisma/migrations`
**Фікс:** бекфіл-міграція `20261018140000_calendar_slots_of_cancelled_work_orders` (як
`20261016120000_…deleted_work_orders`, з `syncVersion + 1`); `createSlot`/`updateSlot` — 400
`err.calendar.workOrderCancelled`; тести в `calendar.deleted-work-order.spec.ts`.
**Severity:** IMPORTANT

### 2026-10-26 — Деталь відкриває видалене джерело, лічильник — ні — §6

**Сигнал:** техборг (а) L750: `getLinkedDocuments` шести сервісів (рахунок, замовлення, складський
документ, оплата й повернення постачальнику, список купівлі) перестав фільтрувати джерело за
`deletedAt` — картку видаленого документа відкривають на перегляд. `getLinkedCounts` тих самих
сервісів далі шукав джерело з `deletedAt: null`: у списку з «Показати видалені» значки зв'язків
видаленого рядка — нулі, а панель — заповнена (розрив count ≠ detail, клас Bug #A/#641).
**Grep:** `grep -n "async getLinkedCounts" -A12 apps/api/src/modules/*/*.service.ts | grep "id: { in: ids }, orgId, deletedAt: null"`
**Фікс:** пошук джерела в `getLinkedCounts` без `deletedAt` (цілі зв'язків лишаються живими) у п'яти
сервісах; тести з фільтрувальною підробкою в `*.linked-docs.spec.ts`. Список купівлі — окремо: його
позиції видаляються міткою списку, лічильник лишився на живих (кандидат).
**Severity:** SUGGESTION

### 2026-10-29 — `updateMany` за переліком статусів → цикл CAS за прочитаним статусом губить рядки — §6

**Сигнал:** щоб записати `fromStatus` кожного рахунку (BR-AUT-060), каскад скасування наряду замінив
`updateMany({ status: { in: LIVE } })` на «вибірка → CAS `status: from` → `continue` при `count = 0`».
Рахунок, що між вибіркою і CAS перейшов SENT → OVERDUE (нічний job), лишався живим у скасованого
наряду — раніше один `updateMany` під блокуванням рядка перечитував умову й скасовував його. Нічний
OVERDUE так само взяв у CAS лише статус: термін, перенесений між вибіркою і записом, не перевірявся.
**Grep:** `grep -rn -A8 "for (const { id, status: from }" apps/api/src --include="*.ts" | grep -B6 "continue"`
**Фікс:** `count = 0` → перечитати; статус і далі з переліку → повторити CAS з ним (обмежено), інакше
пропустити; CAS несе всі умови вибірки (`dueDate: { not: null, lt: today }`); вибірка `orderBy: { id }`
— той самий порядок блокувань, що в іншого писача пачкою. Тести — таблиця в пам'яті зі зміною рядка
між вибіркою і CAS (`work-orders.domain-events.spec.ts`, `invoice-overdue.processor.spec.ts`).
**Severity:** IMPORTANT
