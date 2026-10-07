# sto-review — журнал: api

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../sections/api.md`.

### 2026-06-19 — relation-include drift: findOne vs create/update — §13

**Сигнал:** новий scalar/relation у `findOne()` include + `toDto()`, але `create/update/addPart/updatePart` include-шейп старий → поле = `null` у POST/PATCH response (purchase-orders `lines.good` без `internalCode/brand`; work-orders `parts.good` без `internalCode/sku/brand`).
**Grep:** `grep -nE "(good|supplier|vehicle|counterparty|warehouse):\s*\{\s*select:" apps/api/src/modules/X/*.service.ts | sort -t: -k3` — звірити shape findOne vs create/update.
**Фікс:** один shared `const GOOD_INCLUDE_SELECT = {...} satisfies Prisma.GoodSelect` → reuse у findOne/create/update/addPart/updatePart.
**Severity:** IMPORTANT — німа degradation, фронт показує null після POST/PATCH до refresh.

### 2026-06-19 — frontend мапер читає неіснуюче поле з DTO — §13

**Сигнал:** frontend type-cast вигадує relation (`brand: { name }`), мапер читає `g.brand?.name ?? null`, а DTO повертає flat scalar (`brandName`). Спред `...g` пише правильний `brandName`, потім bogus мапер перетирає на `null`. TS не ловить (GoodPickerModal — brandName завжди null).
**Grep:** `grep -rnE "apiFetch<\{[^}]*(brand|supplier|good):\s*\{" apps/web/src --include="*.tsx"` — звірити з backend toDto shape.
**Фікс:** прибрати фейковий relation з type-cast; покладатись на spread `...g`; лишити лише поля що потребують перетворення.
**Severity:** IMPORTANT — німа degradation, UI показує null для поля що backend віддає.

### 2026-05-28 — @@unique без deletedAt + create без resurrection — §5.2/§6

**Сигнал:** `@@unique([orgId, X])` де X ≠ `deletedAt`; `create()` має `findFirst({ deletedAt: null })` без resurrection.
**Фікс:** merged `findFirst` (без deletedAt) → JS-перевірка `deletedAt` → resurrect (`update`) або ConflictException.
**Severity:** IMPORTANT — HTTP 500 замість 409. (Bug #152)

### 2026-05-28 — BigInt syncVersion напряму у JSON response — §13

**Сигнал:** `findMany/findFirst` повертається напряму без `toDto()` на моделях з `syncVersion BigInt`.
**Фікс:** `rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }))` або `select` без syncVersion.
**Severity:** CRITICAL — HTTP 500 при будь-якому запиті до endpoint.

### 2026-05-28 — Prisma plural table → singular model — §13

**Сигнал:** dynamic `(prisma as any)[modelName]` де modelName наївно з snake_case plural. (Bug #127)
**Фікс:** explicit `TABLE_TO_MODEL: Record<string,string>` + `if (!model) throw` (fail-fast).
**Severity:** CRITICAL — TypeError на runtime; async `.catch()` не ловить синхронний property access.

### 2026-05-30 — PATCH normalizeScope clear: всі exclusivity-сусіди однаковий null-out — §5

**Сигнал:** exclusive scope (goodId/brandId/goodCategory/goodType) у PATCH: 3 з 4 полів `normalized.X ?? null`, а 4-те `existing.X` fallback → не скидається.
**Фікс:** `<field>: normalized.<field> ?? null` для всіх exclusive; `existing.X` fallback ЛИШЕ для non-exclusive (name, priority, isActive).
**Severity:** CRITICAL — silent data corruption, порушення scope-exclusivity.

### 2026-05-30 — Soft-delete rule з child-таблицею + type-switch → «відродження» дочірніх — §5

**Сигнал:** parent з type-перемикачем має child-relation активний лише для одного типу (`tiers` для `COST_TIER`). PATCH міняє `type`, але не soft-delete-ить orphan children.
**Фікс:** `switchedAway = normalized.type !== undefined && normalized.type !== 'TYPE_X' && existing.type === 'TYPE_X';` → `tx.<child>.deleteMany` у тій же транзакції.
**Severity:** IMPORTANT — data drift при поверненні на тип.

### 2026-05-30 — bulk-apply loop: per-iteration `await $transaction([...])` без timeout + N+1 — §5/§6/§7.1

**Сигнал:** bulk-метод (`applyPricing/recalcAll`) робить `for (const item of children)` з `await service.calculateX()` (сам N+1) + per-iteration `$transaction([...])` (array-form default 5s timeout).
**Фікс:** prefetch pure compute перед loop (`getActiveRulesForOrg(orgId)`) → батчувати updates у ОДИН `$transaction(async tx, { timeout: N })`.
**Severity:** CRITICAL — на 50+ рядках silent default-timeout fail з частково-завершеною операцією.

### 2026-06-02 — restore() з окремим read + non-null assertion — §5.2/§2.2

**Сигнал:** `restore(orgId, id)` робить 3 окремі DB-виклики (existence check → read → update) з non-null assertion між ними → race на concurrent hard-delete/resurrect.
**Grep:** `grep -rn "restore\(.*orgId" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** один atomic `updateMany({ where: { id, orgId, NOT: { deletedAt: null } }, data: { deletedAt: null } })` → `count === 0` → 404 → один `findFirstOrThrow` для relations.
**Severity:** CRITICAL — silent crash / data corruption на concurrent.

### 2026-06-12 — Naive `updateMany` на parent+continuation children колапсує split-day інтервал — §5/§6

**Сигнал:** cascade-update (`syncWorkOrderSlots`) робить `updateMany({ where: { parentRefId }, data: { startAt, endAt } })` без розрізнення parent vs continuation. `CalendarSlot.parentSlotId` розбиває split-day slot → updateMany колапсує обидва на однаковий interval.
**Grep:** `grep -rn "updateMany.*workOrderId\|updateMany.*parentSlotId" apps/api/src/modules/calendar`.
**Фікс:** `$transaction({ timeout })`: (1) soft-delete continuation (`parentSlotId: { not: null }`) → (2) update лише parent (`parentSlotId: null`); + `endAt > startAt` guard.
**Severity:** CRITICAL — silent data corruption на WO зі split-day slot (наряд ввечері → наступний день).

### 2026-06-16 — Backend/frontend `status: string` замість literal union — §13/§1

**Сигнал:** lightweight endpoint повертає `status: string` у explicit return type (Prisma select дає enum, але explicit type губить union). Frontend дзеркалить → `status === 'DRAF'` typo не ловиться.
**Grep:** `grep -rnE "status:\s*string" apps/api/src/modules --include="*.service.ts"`; те саме у `apps/web/src/app --include="*.tsx"`.
**Фікс:** `import { InvoiceStatus } from '@prisma/client'` (backend) / `@sto/shared` (frontend) → `status: InvoiceStatus`.
**Severity:** IMPORTANT — typo-magnet, lost type-safety на UI guards.

### 2026-06-17 — Aggregate-level field (recalcTotals) не пропагований у downstream per-line values — §5/§13

**Сигнал:** parent-агрегат рахується новою формулою (`SUM((actualHours ?? normoHours) × price)`), але стара `line.amount` зберігає планові (`normoHours × price`). Downstream (PDF/Excel/completion-act/refreshFromWorkOrder) пайпить `line.amount` напряму → `5 год × 100 = 300`, `SUM(line) ≠ parent.total`.
**Grep:** `grep -rn "l\.amount\|line\.amount\|Number(l\.amount)" apps/api/src/modules --include="*.ts"`; `grep -rn "wo\.lines\.map\|buildLines" apps/api/src/modules`.
**Фікс:** total з displayed quantity: `const quantity = l.actualHours ?? l.normoHours; const total = quantity * Number(l.price);` (single-source). У refreshFromWorkOrder/buildLines — додати `actualHours: true` у `lines.select`. Дзеркалити у всіх downstream.
**Severity:** CRITICAL — документ з арифметикою що не сходиться; юридично неправильний.

### 2026-06-17 — Aggregation report без status-фільтра → юридично неправильний звіт ПДВ/виручки — §5/§13

**Сигнал:** tax-aware aggregate (`vatReport/revenueReport`) без `status: { in: [...] }` → включає DRAFT/CANCELLED → завищене ПДВ-зобов'язання.
**Grep:** `grep -rnE "\.aggregate\(\{" apps/api/src/modules/reports --include="*.service.ts" -A10 | grep -B5 "_sum\|_count" | grep -v "status:"`; per-model loop для Invoice/PurchaseOrder/WorkOrder/StockDocument.
**Фікс:** `status: { in: [...] }` за бізнес-правилами (документувати inline _чому саме ці статуси_):

- Sales VAT (Invoice): `SENT, PAID, OVERDUE`
- Purchase VAT credit (PurchaseOrder): `PARTIAL, RECEIVED`
- Revenue (WorkOrder): `COMPLETED, INVOICED, PAID, ARCHIVED`
- Inventory (StockDocument): `CONFIRMED`
  **Severity:** CRITICAL — financial/regulatory compliance bug.

### 2026-09-02 — Sentinel empty-string у UUID FK колонку → runtime "invalid input syntax for type uuid" — §5/§6

**Сигнал:** сервіс повертає sentinel `''` у полі-ідентифікаторі (`consumeBatch(AVG_COST)` → `[{batchId: ''}]` = "агрегат по кількох партіях"). Викликач пише `''` у `batchId String? @db.Uuid` → Postgres `invalid input syntax for type uuid: ""` → FSM COMPLETED/CONFIRMED падає лише на org з AVG_COST. Тест з real-UUID мока не reproduce.
**Grep:** `grep -rnE "consumed\[0\]\.batchId|allocations\[0\]\.[a-zA-Z]+Id|results?\[0\]\.[a-zA-Z]+Id" apps/api/src/modules --include="*.ts"` (детектор у §5) — перевірити sentinel-повертайку `''` + чи колонка `@db.Uuid`.
**Фікс:** truthy-guard `consumed[0].batchId ? consumed[0].batchId : null` (порожній рядок falsy, UUID truthy). Або explicit `null` у sentinel. Regression-spec: mock `[{batchId: ''}]` → assert `data: { batchId: null }`.
**Severity:** CRITICAL — runtime blocker на всіх org з AVG_COST; TS зелений, unit з real UUID пропускають.

### 2026-09-06 — provider-агностичне «template-id» поле → inline-канал шле ПОРОЖНІЙ текст — §5/§13

**Сигнал:** нове опц. поле-джерело-контенту (`externalTemplateId`) зберігається per-config незалежно від провайдера, а resolve-фільтр зараховує канал придатним за самою наявністю поля: `filter(c => hasLocalTemplate(c) || c.externalTemplateId)`. Але поле консумить лише ЧАСТИНА провайдерів (eSputnik Viber/Telegram через smartsend); inline-провайдер (SMS усіх, TurboSMS Viber) ігнорує його й шле `message` — який для external-template каналу = `''` (renderTemplate('')). Результат: `sendsms {text:''}` — мовчазна порожня відправка. Прямий API-виклик в обхід UI записує template-id на inline-канал.
**Grep:** `grep -rnE "\|\|\s*c\.(externalTemplateId|templateId|externalId)" apps/api/src/modules --include="*.service.ts"` — фільтр придатності що OR-иться на опц. поле без перевірки провайдера. Плюс: чи `templateBody: ... ?? ''` подається inline-провайдеру.
**Фікс (3 шари):** (1) провайдер декларує які канали template-based — `readonly templateChannels?: NotificationChannel[]` (SSOT, у `registry.list()`); (2) upsert примусово `field = isTemplateChannel ? dto.field ?? null : null` (defence-in-depth); (3) resolve-фільтр: канал без локального шаблону придатний лише якщо `registry.get(provider)?.templateChannels?.includes(channel)`. Frontend derive `needsX` з `provider.templateChannels`, не хардкод-Set. +регрес: inline-канал зі stray-template-id → канал ВИКЛЮЧЕНО / поле=null.
**Severity:** IMPORTANT — мовчазна порожня відправка на mis-config; TS зелений (поле опційне у всіх шарах).

### 2026-09-06 — optional-джерело з config-дефолту валить операцію коли дефолт stale → offline-first — §5/§10

**Сигнал:** сервіс резолвить **опційне** поле (рахунок-призначення платежу, дефолтний склад/шаблон) за пріоритетом «DTO явно → інакше дефолт з config-моделі → інакше null» і **безумовно** кидає `NotFoundException` коли резолвлений id не знайдено (`findFirst({ deletedAt: null })` → null). Проблема: коли id прийшов НЕ з вводу користувача, а з **config-дефолту** (`PaymentMethodConfig.defaultBankAccountId`), а цей рахунок з тих пір soft-delete-нули → **застарілий конфіг валить легітимну грошову операцію** (HTTP 404 на валідному платежі). Порушує offline-first (CLAUDE.md §3). Метадані-лінк (куди фізично лягли гроші) — опційний і не впливає на борг/settlement.
**Grep:** `grep -rnE "default[A-Z][a-zA-Z]*Id|methodConfig\?\.|config\?\.default" apps/api/src/modules --include="*.service.ts" -A6 | grep -iE "NotFoundException|throw"` — для кожного резолвера опційного дефолту чи розрізняється explicit(DTO) vs config-default перед throw.
**Фікс:** розрізнити джерело прапорцем `const fromDto = !!(dto.X || dto.Y || dto.Z)`. **Explicit (DTO)** невалідний/чужий/видалений → строго `throw` (4xx). **Config-default** stale → **degrade to null** (best-effort, операція успішна). Крос-tenant (`orgId` у where) в обох гілках. Sample: `PaymentsService.resolveDestinationAccount` — +2 spec (explicit invalid→throw; config-default deleted→degrade+payment succeeds).
**Severity:** IMPORTANT — offline-first порушено; застарілий адмін-конфіг блокує легітимні гроші; degradation не видима у tsc/тестах поки дефолт не soft-deleted на проді.

### 2026-09-06 — date-only `lte` фільтр = midnight UTC → виключає весь день `dateTo` — §5/§6

**Сигнал:** where-фільтр діапазону дат по date-only рядку (`YYYY-MM-DD` від DatePicker): `createdAt.lte = new Date(opts.dateTo)`. `new Date('2026-09-06')` = **midnight UTC** (00:00:00.000Z), тож `lte` виключає ВСІ рядки пізніше 00:00 того ж дня — фільтр «до 06.09» не показує оплату о 10:00 06.09. Симетрично `gte = new Date(dateFrom)` коректний (початок дня), але TZ-залежний. Еталон вже у `supplier-payments.service` (`+ 'T23:59:59.999Z'`).
**Grep:** `grep -rnE "(lte|lt):\s*new Date\((opts\.|dto\.)?date[A-Za-z]*\)" apps/api/src/modules --include="*.service.ts"` — для кожного `lte: new Date(dateTo)` без `T23:59:59` чи вхід date-only.
**Фікс:** `gte: new Date(dateFrom + 'T00:00:00.000Z')`, `lte: new Date(dateTo + 'T23:59:59.999Z')` (inclusive-of-full-day, UTC-стабільно).
**Severity:** IMPORTANT — silent correctness: фільтр «за період до X» мовчки губить весь останній день; не ловиться tsc.

### 2026-09-07 — CAS-статус закомічено ПЕРЕД money-side-effect → crash-window без реконсиляції — §5

**Сигнал:** money-flow робить `updateMany({where:{status:'PENDING'}, data:{status:'PAID'}})` (CAS-claim) → count===1 → окремим кроком `payments.create()` + запис лінка (`paymentId`). CAS і create — НЕ в одній транзакції. Якщо процес падає МІЖ CAS і create (або create кидає, а код лишає PAID+error БЕЗ re-enqueue), наступний poll робить early-return на `status !== 'PENDING'` → Payment/settlement НЕ створюються НІКОЛИ, хоча гроші у gateway реальні → тиха втрата платежу.
**Grep:** `grep -rnE "updateMany\(\{[^}]*status: 'PENDING'.*data: \{ status: 'PAID'" apps/api/src/modules --include="*.ts"` → для кожного CAS-claim перевірити: (1) гілка `status==='PAID' && linkId===null` що ДОводить side-effect (реконсиляція), (2) чи re-enqueue-иться poll на невдалому create, (3) стеля ретраїв проти вічного циклу.
**Фікс:** гілка реконсиляції на вході process(): `if (status==='PAID'){ if(linkId) return; await finalize(...); return }`. `finalize()` — спільний create+link для CAS-win і reconcile; на помилці re-enqueue (jobId-дедуп = single-flight); лічильник `finalizeAttempts` у job.data з `MAX` стелею → далі PAID+error для ручного розбору. Idempotency: `linkId!=null → стоп`.
**Severity:** CRITICAL — тиха втрата грошей (gateway отримав, обліку немає); tsc + happy-path тест мовчать.

### 2026-09-14 — валютна `dto.amount` накопичується у base-only сіблінг-агрегат (Invoice/WO paidAmount) — §5

**Сигнал:** мультивалютна операція має валюту (`dto.amount` у валюті рахунку/каси), але оновлює сусідню сутність БЕЗ `currencyId` (Invoice/WorkOrder `amount`/`paidAmount`/`totalAmount` — у БАЗОВІЙ валюті org). Код робить `prevPaid + dto.amount`, `paidAmount: { increment: dto.amount }`, `if (dto.amount > remaining)` → змішує валюти (100 USD зрівнюється зі 100 UAH). Симетрично тому, як Payment САМ коректно пише `amountBase`, але забуває, що ЦІЛЬ (Invoice/WO) теж base-only.
**Grep:** `grep -nE "paidAmount.*(increment|decrement).*dto\.amount|prevPaid \+ dto\.amount|dto\.amount > remaining" apps/api/src/modules --include="*.service.ts"` → для кожного match перевірити, чи цільова Prisma-модель має `currencyId` (`awk '/^model X /,/^\}/' schema.prisma | grep currencyId`); якщо ні — має бути `conv.amountBase`.
**Фікс:** усі accumulate/compare проти base-only полів → `conv.amountBase` (у base `conv.amountBase === dto.amount` → BC). Remaining/overpay → `baseCode` (`getBaseCurrency`), не хардкод «грн».
**Severity:** CRITICAL — тихе псування фін-обліку (paidAmount/статус PAID) для не-base оплат; base-only тести не ловлять. Sample: payments.service invoice+WO (12bf3e2d).

> **UPD 2026-09-15 (review цикл 1/3):** Invoice/WorkOrder ПЕРЕЙШЛИ у Фазу 3 — тепер `currencyId NOT NULL` + `amount/paidAmount/totalAmount` у ВАЛЮТІ документа (не base). payments.service тепер коректно: (1) `sameCurrency(payment, invoice)` guard перед алокацією → оплата у тій самій валюті → `dto.amount` накопичується правильно; (2) base-леджер через settlement (`amountBase`); (3) FX_GAIN/FX_LOSS реалізується коли рахунок став PAID у іновалюті. Тобто `dto.amount → paidAmount` тут НЕ баг (обидва у валюті документа). Правило лишається валідним для СПРАВДІ base-only сіблінгів — але спершу перевір `currencyId` у моделі-цілі (може бути Фаза 3), інакше false-positive на payments.service.

### 2026-10-07 — статичний сторож-regex пропускає нелітеральний `data` (fail-open) — §5

**Сигнал:** spec-«сторож», що читає код і шукає заборонений запис (`workOrder.update({ data: { status } })`), перевіряє лише літерал `data: { … }`. Форми `data: updates`, shorthand `data`, `{ ...patch }`, `upsert`, вкладений `workOrder: { update: … }`, сирий `UPDATE work_orders` він мовчки пропускає — а `data: updates` це форма, якою пише сам `transition()`. Контрольний кейс «детектор бачить порушення» був лише на одну форму.
**Grep:** `grep -rn "readFileSync" apps/api/src --include="*.spec.ts" -l` → у кожному сторожі перевірити: що він робить із викликом, чий аргумент НЕ літерал? Має бути порушення, а не `continue`.
**Фікс:** fail-closed — «не можу прочитати → порушення»; контрольний `it.each` на кожну обхідну форму + кейс проти хибних спрацювань; у дос'є «Чого тут НЕМА» назвати форми, яких regex не бачить (псевдонім делегата, динамічний делегат).
**Severity:** IMPORTANT — сторож зелений, а правило обходиться першим же рефакторингом.

### 2026-10-07 — `DocumentType` без `DocumentNumberConfig`: `docNumbers.next()` → 404 на кожній org — §5

**Сигнал:** сервіс кличе `docNumbers.next(orgId, 'X')`, а тип `X` не створюється ні в `seed.ts`, ні в `setup.service.ts`, ні backfill-міграцією. Unit-тести мокають `DocumentNumberService` → зелено; наживо створення документа дає 404. Знайдено живим запитом: `COMPLETION_ACT` (акт виконаних робіт не створюється взагалі).
**Grep:** `for t in $(grep -rhoE "\.next\(orgId, '[A-Z_]+'" apps/api/src --include="*.ts" | grep -oE "[A-Z_]{4,}" | sort -u); do grep -q "$t" apps/api/src/modules/setup/setup.service.ts || echo "setup без $t"; grep -q "$t" packages/database/prisma/seed.ts || echo "seed без $t"; done`
**Фікс:** тип у `seed.ts` + `setup.service.ts` + міграція-backfill окремим файлом (нове enum-значення не можна вжити в тій самій транзакції, взірець — `20260703100001_seed_supplier_payment_doc_numbers`).
**Severity:** CRITICAL — фіча недоступна на кожній інсталяції; потребує міграції.
