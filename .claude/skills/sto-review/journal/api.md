# sto-review — журнал: api

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../sections/api.md`.

### 2026-10-30 — нова ознака довідника (`isCash`) у спільному писачі: внутрішній викликач і відновлення — §5

**Сигнал:** BR-PAY-019 перевели з коду `cash` на ознаку `PaymentMethodConfig.isCash`. `PaymentsService.create`
кличуть людина (`POST /payments`), каса, рознесення виписки й фіналізація онлайн-оплати (`<шлюз>_qr`). Для
людини відмову 400 «вкажіть касу» додали свідомо, а для шлюзу ознака, ввімкнена на QR-способі, давала б ту саму
400 на кожну спробу фіналізації вже прийнятих грошей (раніше код `cash` для QR не траплявся). Друге: гілка
відновлення видаленого способу в `PaymentMethodsService.create` писала `{ ...fields, ...destination }` — без
`isCash` у запиті лишалась ознака видаленого рядка, а призначення перевірялось як для «не готівки».
**Grep:** `grep -rn "<сервіс>\.create(" apps/api/src/modules --include="*.ts" | grep -v spec` → для кожного
внутрішнього викликача: чи може нова відмова спрацювати на ньому; `grep -n "deletedAt: null }" <модуль>.service.ts`
у гілці restore → поля, від яких залежить перевірка, пишуться явно.
**Фікс:** `viaGateway = !opts.fromRequest && !!dto.onlinePaymentIntentId` → ознака не діє (і в `retryFiscal`);
відновлення пише `isCash: dto.isCash ?? false`. Тести з мутацією (`payments.cash-register-required.spec.ts`,
`payment-methods.destination.spec.ts`, `payments.query-dto.spec.ts`). **Severity:** IMPORTANT (гроші, ПРРО)

### 2026-10-24 — рефакторинг спільного каркаса/хелпера зберігає порядок і per-caller guard — §4/§5

**Сигнал:** jscpd-рефактор витягує спільний boilerplate у хелпер — `$extends`-каркас Prisma-розширень
(`extendAllModels`) або дубльований `findX` у сервісі (`findCashRegisterForPayment`). Два місця, де
легко зламати мовчки: (1) **порядок композиції розширень** (tenant-guard МУСИТЬ лишатись OUTERMOST —
застосований ОСТАННІМ у `$extends`-ланцюгу, бо судить оригінальні args до мутації syncVersion/encryption);
(2) **per-caller умова, вкладена у виклик**: `create()` передавав `dto.cashRegisterId`, а `update()` —
`nextSourceType === CASH_REGISTER ? nextCashRegisterId : undefined`. Якщо хелпер зробити «розумним»
(сам читає sourceType) або викликати безумовно, bank-sourced-платіж підтягне СТАРИЙ `cashRegisterId`
(stale з каси, з якої його перемкнули).
**Grep:** `git diff <base> -- apps/api/src/prisma/prisma.service.ts | grep -nE "withTenantGuard\(|withSyncVersion\(|withFieldEncryption\("`
→ композиція `withTenantGuard(withFieldEncryption(withSyncVersion(this)))` незмінна; для хелпера-екстракції
звірити, що кожен викличний сайт зберіг СВІЙ `? : ` навколо аргументу (diff лівої vs правої гілки).
**Фікс:** хелпер приймає ВЖЕ-резолвлений аргумент (guard лишається у викличного коду); handler-логіка
кожного розширення переноситься байт-у-байт (лише boilerplate у каркас). Регрес: тест із
`expect(prisma.cashRegister.findFirst).not.toHaveBeenCalled()` на переході каса→банк (мутант
«викликати хелпер безумовно» падає).
**Severity:** CRITICAL (tenant-leak при зміні порядку / stale FK у фін-записі) — обидва проходять tsc і моки.

### 2026-10-23 — пошук запису об'єкта ще й за змінюваним батьком — §5

**Сигнал:** BR-CASH-027 шукав OPEN-зміну каси за `{ orgId, branchId, cashRegisterId }`, а `PATCH
/cash-registers/:id` дозволяє `branchId`. Касу перевели при відкритій зміні → віджет і обробник
чеків її не бачать, `open()` і касова операція (шукають лише за касою) бачать → «зміна вже
відкрита», закрити нічим, чеки чекають вічно. **Grep:** `grep -n "branchId" <сервіс>` біля
`findFirst` з id об'єкта-власника → чи може батько змінитись (`grep -n "branchId" <модуль>.dto.ts`
в Update-DTO). **Фікс:** у режимі «за об'єктом» фільтр лише `{ orgId, <об'єкт>Id }`, належність
об'єкта філії — окремим запитом (404). **Severity:** IMPORTANT

### 2026-10-15 — «між перевіркою і транзакцією» на memoryTable без знімка — §5

**Сигнал:** спек оплати наряду мав тест «статус змінився на «Виконано» між перевіркою і транзакцією →
PAYMENT», але мутант, що бере статус із читання ДО транзакції, вижив: `memoryTable.findFirst` віддає
сам рядок, і `beforeTx` міняв той самий об'єкт, який тримала перевірка до транзакції. Так само вижив
мутант «прибрати перевірку залишку в транзакції» — тесту «залишок зменшився між перевіркою і
транзакцією» не було. Поруч у коді: шлях рахунку без наряду мав `if (inv) { … }` без `else` —
рахунок, видалений між перевіркою і записом, давав Payment з посиланням на неіснуючий рахунок.
**Grep:** `grep -rl "beforeTx" apps/api/src --include="*.spec.ts" | xargs grep -L "{ ...r }"`;
`grep -rnE "^\s+if \((inv|wo|doc|row)\) \{" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** у harness `findFirst` → `read(args).then(r => (r ? { ...r } : r))` (як у
`work-orders.paid-guards.spec.ts`); тест на кожну авторитетну перевірку в транзакції; `if (!x) throw`.
**Severity:** IMPORTANT — тести «на гонку» зелені без умови, яку стережуть.

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

### 2026-10-08 — Deadlock: дві транзакції пишуть акт і наряд у різному порядку — §4

**Сигнал:** у `transition()` одного агрегату додано `tx.<іншийАгрегат>.updateMany(...)` ПІСЛЯ CAS власного рядка, а сервіс того агрегату в своїй tx спершу блокує свій рядок і лише потім чужий (`CompletionActsService.sign()`: акт → наряд; `WorkOrdersService.transition(CANCELLED)`: наряд → акт). Одночасні «підписати акт» і «скасувати наряд» → Postgres deadlock → 500.
**Grep:** `grep -rnE "tx\.[a-zA-Z]+\.updateMany\(" apps/api/src/modules --include="*.service.ts" | grep -v spec` → для кожної tx, що пише ≥2 моделей, знайти зворотну пару в сервісі другої моделі й порівняти порядок.
**Фікс:** вирівняти порядок (запис у чужий рядок — до CAS власного; відкат tx покриває невдалий CAS) + асерт `mock.invocationCallOrder` у unit-тесті.
**Severity:** IMPORTANT — дані лишаються узгодженими, але користувач отримує 500 на рідкісній гонці.

### 2026-10-08 — Правило додано на create/clone, а update і сусідній документ лишились повз нього — §5

**Сигнал:** нова перевірка FK-контрагента (`assertCounterpartyRole`) стоїть у create/clone, а `update` тієї ж сутності пише `counterpartyId: dto.counterpartyId ?? undefined` без жодного читання контрагента (заразом і без перевірки `orgId` — чужий tenant); сусідній документ тієї ж ролі (`supplier-returns`) не отримав перевірки взагалі; web-пікер і E2E-сід беруть «першого-ліпшого» контрагента й отримують 400.
**Grep:** `grep -rnE "(counterpartyId|supplierId): dto\.(counterpartyId|supplierId)" apps/api/src/modules --include="*.service.ts" | grep -v spec` → кожен запис: чи є вище `findFirst({ where: { id, orgId, deletedAt: null } })` і перевірка ролі. Плюс `grep -rn "counterparties?limit\|counterparties?q=" apps/web/src apps/web/e2e | grep -v types` для пікерів і сідів без фільтра типу.
**Фікс:** перевірка в update лише при ЗМІНІ FK (старі документи лишаються редагованими); рядок у статичному стороже підключення; `types=CLIENT&types=BOTH` у пікері й сідах.
**Severity:** IMPORTANT (обхід правила) / CRITICAL там, де update не перевіряв `orgId` FK.

### 2026-10-08 — Акт звірки з трьох окремих читань — §4

**Сигнал:** `closing = account.balance − Σ(транзакції після періоду)`, де баланс, рядки періоду й агрегат читаються трьома запитами поза транзакцією. Платіж між читаннями потрапляє в агрегат, але не в баланс → закриваючий залишок з'їжджає на його суму; акт зберігається й підписується. **Grep:** `grep -rn "groupBy\|aggregate(" apps/api/src/modules --include="*.service.ts" -B30 | grep "balance"` → чи читання балансу й агрегату в одній транзакції. **Фікс:** `$transaction(async tx => …, { isolationLevel: 'RepeatableRead', timeout })`, баланс перечитати всередині. **Severity:** IMPORTANT

### 2026-10-08 — EXPIRED за годинником при недоступному шлюзі — §4

**Сигнал:** процесор опитування ставив `EXPIRED` щойно `expiresAt < now`, не питаючи шлюз. Разом із «збій getStatus → опитати знову» це давало: інтернет СТО лежить 15 хв, клієнт платить із телефона, намір закривається як «час вичерпано» при списаних грошах. **Grep:** `grep -rn "expiresAt" apps/api/src/modules --include="*.processor.ts" -A4 | grep -i "EXPIRED\|transition"`. **Фікс:** після дедлайну — останній запит статусу; закриває лише відповідь; збій → рідше опитування до стелі з причиною «не підтверджено». **Severity:** IMPORTANT (гроші)

### 2026-10-08 — Правило платника на рахунку, але не на прямій оплаті наряду — §4

**Сигнал:** `inv.counterpartyId !== dto.counterpartyId` додано для `invoiceId`, а гілка `workOrderId` без рахунку лишилась без перевірки (той самий `create`). Це пункт «нове правило на create → сусідні документи тієї ж ролі», тільки сусід — інша гілка того ж методу. **Фікс:** та сама перевірка для наряду, коли рахунку немає. **Severity:** IMPORTANT

### 2026-10-08 — Копійка округлення безумовно в останній рядок → від'ємний рядок рахунку — §5

**Сигнал:** `buildInvoiceLinesFromWorkOrder` вирівнював Σ рядків до тоталів наряду правкою `lines[lines.length - 1]`. Коли останнім стояв рядок на 0 фактичних годин або рядок, чий ПДВ округлився до 0, рахунок отримував рядок `[0, -0.01, -0.01]` чи ПДВ `-0.01`. Property-тест цього не бачив: генератор не давав нульової кількості, а перевіряв лише суми. Знайдено перебором 300 тис. випадкових нарядів проти формули тоталів (0,5% із від'ємним рядком). **Grep:** `grep -rnE "\[[a-zA-Z]+\.length - 1\]" apps/api/src/modules --include="*.ts" | grep -v spec` → для кожного вирівнювання залишку перевірити нульовий/малий останній рядок. **Фікс:** залишок бере останній ненульовий рядок, що лишається ≥ 0 (`residualTarget`), запасний варіант — останній; кейс із нульовим останнім рядком у спеку. **Severity:** IMPORTANT (гроші, друкований документ)

### 2026-10-09 — Перевірки наряду за `&& workOrder` мовчать, коли наряд не знайдено — §4

**Сигнал:** `PaymentsService.create` читав наряд із `deletedAt: null`, а всі правила (статус INVOICED, замовник, валюта, залишок BR-PAY-017) стояли за `dto.workOrderId && workOrder && …`. Для видаленого наряду (DRAFT/CANCELLED) читання давало `null` → правила мовчали, а читання в транзакції було без `deletedAt` → `paidAmount` видаленого наряду зростав. Нова перевірка залишку (03e45456) успадкувала ту саму форму умови. **Grep:** `grep -rnE "dto\.[a-zA-Z]+Id && [a-zA-Z]+ &&" apps/api/src/modules --include="*.service.ts"`. **Фікс:** ранній `if (dto.xId && !x) throw NotFound`; читання в tx з `deletedAt: null`. Та сама форма лишилась для рахунку (`if (inv) {…}` без `else`) — свідомо не чіпали: онлайн-оплата з уже списаними грошима мусить створити Payment. **Severity:** IMPORTANT (гроші)

### 2026-10-09 — Рядок PDF сирим добутком після переходу тоталів на «суму округлених рядків» — §5

**Сигнал:** BR-WO-007 змінив `totalActualLabor` на Σ `money(години × ціна)`, акт уже округлював рядок, а `generatePdf` наряду віддавав `total: quantity * price`. `Intl.NumberFormat` округлює двійкове подання: 0.3 × 100.05 = 30.014999… → «30,01», у підсумку 30.02. Перебір: 24 948 із 800 000 пар (години з кроком 0.01, ціна з кроком 0.25) друкуються інакше, ніж `money()`. **Grep:** `grep -rnE "\b(total|amount|sum): [a-zA-Z.]+ \* [a-zA-Z.]+,?$" apps/api/src/modules --include="*.ts" | grep -v "money(\|spec"`. **Фікс:** `money(quantity * price)` + кейс у `work-orders.pdf-totals.spec.ts`. **Severity:** IMPORTANT (друкований документ)

### 2026-10-09 — Новий спек без рядка в реєстрі дос'є; гейт C зелений — §4

**Сигнал:** `work-orders.complete-recalc.spec.ts` (4 кейси) додано без рядка в `docs/objects/work-order.md`; «Разом» враховував лише +3 сусіднього файла. `--gate-registry` пройшов: він перевіряє, що названі файли існують, а не що всі спеки модуля названі. Поруч: текст «334 у модулі» і «17 фіксованих» не оновлено разом із цифрою «Разом». **Grep:** `git diff --name-status <base> | grep -E "^A.*\.spec\.ts"` → `grep -l <ім'я> docs/objects/*.md`. **Фікс:** рядок у реєстрі, суми з `vitest --reporter=json`. **Severity:** SUGGESTION

### 2026-10-09 — Сторно з перерахунком курсу замість копії початкового проведення — §5

**Сигнал:** `BankReconciliationService.unreconcile` проводив `REFUND_OUT_CANCEL` із `date: operationDate, fallbackToLatest: true`. Курс на дату операції, доданий чи виправлений між рознесенням і скасуванням, давав іншу базову суму — у балансі клієнта лишалась різниця, хоча правило вимагало «ту саму суму в базовій валюті». Тест приймав обидва способи («або валюта рядка з датою, або базова сума») і різницю не бачив. **Grep:** `grep -rnE "type: '[A-Z_]+_CANCEL'" -A8 apps/api/src/modules --include="*.ts" | grep -v spec | grep "fallbackToLatest"`. **Фікс:** сторно читає останнє початкове проведення документа з журналу й передає його `amount` / `currencyId` і `conversion { rateUsed, amountBase }` у `createTransaction`; кейс зі зміненим курсом і кейс «рознесено → скасовано → рознесено знову». **Severity:** CRITICAL (баланс контрагента)

### 2026-10-09 — CAS за самим статусом, а ефект — за даними, прочитаними до нього — §5

**Сигнал:** три місця одного diff-у. (1) `unreconcile`: читання рядка → CAS `status / matchedType` → сторно на прочитаного контрагента чи касу; рядок, який тим часом скасували й рознесли знову тим самим видом, проходив CAS. (2) Нова оплата постачальнику («захоплення → `create` → запис посилання → `confirm` → відкат», кожен крок у своїй транзакції): запис посилання й відкат звіряли лише `status + matchedType + supplierPaymentId`, тож чернетка прив'язувалась до рядка, який звільнили й захопив інший запит, а відкат звільняв чуже рознесення. (3) `SupplierPaymentsService.cancel`: читання статусу → безумовний `update({ where: { id, orgId } })` — паралельний `confirm` лишав проведення при статусі `CANCELLED`. **Grep:** `grep -rnE "\.update\(\{\s*$" -A2 apps/api/src/modules --include="*.service.ts" | grep -B1 -A1 "status:"` — переглянути кожен FSM-перехід без `updateMany` зі статусом у `where`. **Фікс:** мітка операції (`matchedAt`) і посилання ефекту в `where` CAS; `updateMany` зі статусом для `cancel`; тести підміняють стан рядка всередині першого читання (`mockImplementationOnce` поверх справжньої реалізації підробки). **Severity:** CRITICAL (гроші)

### 2026-10-12 — PATCH зливає стан, прочитаний ДО транзакції — §4

**Сигнал:** `pricing-rules.controller.ts update` читав правило, рахував область, а писав у
`$transaction`. Наживо: два одночасні PATCH `goodIds` дали об'єднання списків у 15 із 15 спроб;
PATCH `{ isActive: false }` правила з видаленою пізніше категорією → 404 «Категорію не знайдено».
**Grep:** `grep -rn "existing\._count\|existing\.[a-zA-Z]*Id" apps/api/src/modules --include="*.controller.ts" --include="*.service.ts" | grep -v spec` → чи читання `existing` стоїть усередині тієї самої транзакції, що й запис.
**Фікс:** блокування `pg_advisory_xact_lock` першим рядком транзакції, читання стану після нього; перевірка лише посилань із тіла запиту.
**Severity:** IMPORTANT

### 2026-10-12 — Один `take` на пакетний пошук за неунікальним полем — §6

**Сигнал:** `GoodMatcherService.findGoods` мав `take: IN_CHUNK * 2`: 5000 артикулів, у яких у середньому понад два товари, обрізались, і рядок із двома товарами ставав «знайдено». Код «без регістру» шукався трьома написаннями з JS і не знаходив «Тов-0001» за «ТОВ-0001».
**Grep:** `grep -rn "take: [A-Z_]* \* " apps/api/src/modules --include="*.service.ts" | grep -v spec`
**Фікс:** читання сторінками за курсором `id`; `{ in, mode: 'insensitive' }`.
**Severity:** IMPORTANT

### 2026-10-14 — Конфлікт серіалізації на COMMIT давав 500 — §5

**Сигнал:** дві одночасні видачі з однієї каси: одна проходить, решта отримують 500 замість 400
«каса зайнята» (наживо 21 відповідь 500 із 32). У лозі `DriverAdapterError: TransactionWriteConflict`
зі стеком `commitTransaction`. Перевірка стояла лише на `PrismaClientKnownRequestError` / `P2034`.
**Grep:** `grep -rn "'P2034'" apps/api/src --include="*.ts" | grep -v "spec\|prisma-errors"`
**Фікс:** `isSerializationConflict()` у `common/utils/prisma-errors.ts` (обидві форми); ним користуються
`throwIfSerializationConflict`, `CashService`, `CashDeskService`. **Severity:** IMPORTANT

### 2026-10-14 — Каса йшла в мінус двома оплатами різним постачальникам — §5

**Сигнал:** `SupplierPaymentsService.confirm` кличе `CashService.createOperation` у своїй транзакції
(ReadCommitted). Дві одночасні оплати РІЗНИМ постачальникам по 60 при залишку 100 — обидві 201, каса −20
(6 раундів із 10). З одним постачальником не відтворювалось: запити ставив у чергу рядок його рахунку
взаєморозрахунків. Unit-тести з моком Prisma цього не бачать. **Grep:** читання залишку перед записом у
методі, що приймає `tx`: `grep -rn "getBalance(" apps/api/src/modules --include="*.service.ts"`
**Фікс:** `pg_advisory_xact_lock(hashtext('cash-register:<id>'))` перед читанням залишку для `OUT`.
**Severity:** CRITICAL

### 2026-10-14 — Стаття за приводом дісталась руху власних грошей — §5

**Сигнал:** BR-CASH-022 підставляє статтю за приводом, коли статтю не передано. Рознесення виписки
пише зняття готівки з рахунку приводом `MANUAL_IN` свідомо без статті (BR-BANK-034): зі статтею,
закріпленою за «Внесенням», переміщення стало б доходом у звіті. **Фікс:** прапорець
`withoutCategory` у `CreateCashOperationInput`. **Severity:** IMPORTANT

### 2026-10-14 — Відмова за станом, прочитаним без блокування, обходиться CAS-ом — §5

**Сигнал:** `PaymentsService.reverse` читав `fiscalStatus`, відмовляв на `DONE`, а CAS писав лише `where reversedAt: null` і ставив `SKIPPED`. Обробник Checkbox пише `DONE` без блокування: чек, пробитий між читанням і CAS, проходив повз відмову, і `SKIPPED` затирав `DONE` при наявному `fiscalReceiptId`. Те саме в `retryFiscal`: безумовний `update` → `QUEUED` після сторно лишав сторновану оплату в черзі навічно (обробник її пропускає). **Grep:** див. пункт у `sections/api.md` §5. **Фікс:** у `where` CAS — `fiscalReceiptId: null, fiscalStatus: <прочитане>`; `count = 0` → перечитати й відмовити з точною причиною; `retryFiscal` — `updateMany` з `fiscalStatus: 'FAILED', reversedAt: null`. **Severity:** IMPORTANT

### 2026-10-14 — Аудит рядка, створеного в чужій транзакції, лишався після її відкату — §4/§5

**Сигнал:** `CashService.createOperation(…, tx)` пише аудит best-effort одразу після вставки — окремим з'єднанням, до коміту транзакції викликача. Сторно касової операції пише рядок ПЕРШИМ, а відмови гілок (валюта, чек, архівний наряд) — потім: наживо відмова сторно іноземної оплати постачальнику лишила `audit_events` CREATE на `CashOperation`, якої в `cash_operations` немає. **Grep:** див. пункт у `sections/api.md` §5. **Фікс:** `deferAudit` у вході писача + `recordCreated()` викликача після коміту. **Severity:** IMPORTANT

### 2026-10-14 — Каса з запиту без `sourceType` мовчки губилась — §4

**Сигнал:** `resolveDestinationAccount` брав тип із `dto.sourceType ?? methodConfig.defaultSourceType`. `POST /payments` з `cashRegisterId`, але без `sourceType`: у способу без замовчування тип `null` → каса відкидалась (термінал записувався повз касу, готівка — 400 BR-PAY-019 «вкажіть касу», хоча касу вказано); у способу з замовчуванням «рахунок» → 400 «не вказано рахунок». Резолвер замовчувань способу (`payment-methods.service`) у тому ж diff тип з id виводив. **Grep:** див. пункт у `sections/api.md` §4. **Фікс:** `dto.sourceType ?? <тип з єдиного id> ?? замовчування`. **Severity:** IMPORTANT

### 2026-10-15 — Свідомо пропущений `deletedAt: null` не стерігся тестом — §5

**Сигнал:** `CalendarService.employeeNames` (BR-CAL-011) читає імена механіків без `deletedAt: null`,
щоб звільнений лишався на своїх минулих записах. Спек мокав `employee.findMany` фіксованою
відповіддю — мутант «додати `deletedAt: null`» пройшов усі 26 кейсів. **Grep:**
`git diff <base> -- apps/api/src | grep -nE "^\+.*(Без|без) .deletedAt"`. **Фікс:** кейс на
таблиці працівників, що виконує `where` (orgId, `id in`, `deletedAt`), з видаленим рядком і рядком
чужої організації (`calendar.service.spec.ts`, b72cab2d). **Severity:** SUGGESTION

### 2026-10-16 — Фільтр списку для поля форми поступався `showDeleted` — §4

**Сигнал:** `GET /employees?liftId=` (кандидати поля «Механік», BR-CAL-012) додавав до `where`
закріплення і `status ≠ FIRED`, але `deletedAt` брав із загального прапорця `showDeleted`: із
`showDeleted=true` список віддавав видалених, яких `POST /calendar` відхиляє 400. **Grep:**
`git diff <base> -- apps/api/src | grep -nE "^\+\s+if \(query\.[a-zA-Z]+Id\) \{"` → у гілці
звуження перевірити, чи вона перекриває КОЖЕН загальний прапорець (`showDeleted`, `status`).
**Фікс:** `where.deletedAt = null` у гілці `liftId` + кейс із `showDeleted: 'true'` і контролем
без `liftId` (`employees.lift-filter.spec.ts`, 3c41f6c9). **Severity:** SUGGESTION

### 2026-10-16 — Дос'є без нового E2E і з URL модуля замість префікса контролера — §4

**Сигнал:** коміт 4e06f8f3 додав `apps/web/e2e/calendar-owner-decisions.spec.ts`, а
`docs/objects/calendar.md` перелічував лише `calendar-month-cards.spec.ts`; таблиця «API Endpoints»
того ж дос'є, яку diff доповнив (`dropMechanicNotOnLift`), давала `/api/calendar/:id` при
`@Controller('calendar/slots')`. Гейти C і `check-doc-links` цього не бачать: перший рахує лише
unit-спеки реєстру, другий — посилання, а не текст URL. **Grep:**
`git diff --name-status <base> | grep -E "^A.*e2e/.*\.spec\.ts"` → кожен файл згаданий у
`docs/objects/*.md`; `grep -n "@Controller" apps/api/src/modules/<mod>/<mod>.controller.ts` проти
таблиці. **Фікс:** абзац «E2E:» у дос'є, URL таблиці з префікса контролера (572e4631).
**Severity:** SUGGESTION

### 2026-10-18 — Тест другої 400-перевірки замаскований першою — §5

**Сигнал:** `supplier-orders.send.spec.ts` перевіряв `orderClosed` так: `supplierApiStatus = 'SENT'`,
потім `status = 'CANCELLED'` і `rejects.toThrow(BadRequestException)`. Кидала вже `alreadySent`, тож
мутація `SENDABLE_PO += PARTIALLY_RECEIVED` (і навіть видалення перевірки) лишала тест зеленим; правило
власника «з «Частково» — 400» (BR-SCON-009) і стеля опитування 30 днів (BR-SCON-012) не мали guard-а.
**Grep:** `grep -rn "rejects.toThrow(BadRequestException)" apps/api/src --include=*.spec.ts` → для
кожного: чи не спрацьовує раніше інша перевірка того ж методу. **Фікс:** скинути стан першої
перевірки, чекати текст помилки, кожен статус окремо; межу — 29/31 дні (292ca2fe).
**Severity:** IMPORTANT

### 2026-10-22 — Пошук пари ключів двома IN; новий тест між міткою guards і чужим it — §4

**Сигнал:** `invoices.lineUoMs` (Bug #868) шукав коефіцієнти одиниць рядків рахунку як
`goodId IN (…) AND unitOfMeasureId IN (…)` без `take`: вибірка тягнула й перехресні пари, і
межу під неї не поставити. У тому ж діапазоні `schema-integrity.integration.spec.ts` отримав новий
тест (індекс одного CHARGE на документ) між рядком `// guards: BR-WORK-006` і тестом GIN-індексів:
мітка BR-WORK-006 перейшла на чужий тест, а GIN-тест лишився без неї.
**Grep:** `git diff <base> -- apps/api/src | grep -nE "^\+.*Id: \{ in: "` (два `IN` в одному
`where`); `git diff <base> -U3 -- '*.spec.ts' | grep -A1 "^ .*// guards:" | grep "^+.*it("`.
**Фікс:** точні пари `OR: [...pairs.values()]` + `take: pairs.size` (`@@unique` трійки дає ≤ 1
рядок на пару); мітку повернуто на GIN-тест, новий тест — `// guards: BR-SETL-015` (0403885a).
**Severity:** IMPORTANT (мітка), SUGGESTION (запит)

### 2026-10-22 — Кнопка «Сторнувати» за підмножиною ознак сервера; openapi без нового параметра — §13

**Сигнал:** `reverseNonCash` відхиляв сторно оплати, що лежить у касі, за `sourceType = CASH_REGISTER`,
`cashRegisterId` або рядком каси `documentType = 'Payment'` (стара оплата до BR-PAY-023), а
`paymentReversalFields` у `lib/linked-configs.tsx` дивився лише на `sourceType` — стара готівкова оплата
показувала «Сторнувати» і після причини й підтвердження діставала 400. Окремо: `GET /works?ids=` додано в
DTO без `pnpm gen:api-types` — `openapi.json` і `api-types.ts` лишились без параметра (CI не ловить).
**Grep:** `git diff <base> -- apps/web/src | grep -nE "^\+.*row\.[a-zA-Z]+ === '[A-Z_]+'"` → умова дії
проти відмови сервера; `pnpm gen:api-types && git diff --stat -- packages/shared/openapi.json`.
**Фікс:** `payments/payment-cash-desk.ts` — `paymentsInCashDesk` (одна функція для відмови й ознаки) і
`toLinkedPaymentRows` → `inCashDesk` у рядку оплати «Пов'язаних документів»; web: `inCashDesk ||
sourceType === 'CASH_REGISTER'` → підказка «Сторнується в касі». Тест на таблиці каси, що виконує
`where` (своя org, тип `Payment`), мутації «без orgId» і «без запиту рядків каси» падають.
**Severity:** IMPORTANT

### 2026-10-22 — Обов'язковий `Idempotency-Key`: сирий `fetch` у сід-функції E2E лишився без ключа — §13

**Сигнал:** `d7b07a65` зробив ключ обов'язковим на касі й оплатах і додав його в `apiCall`/`apiRequest`
(`e2e/api-helpers.ts`), але `seedSupplierAndCash` у `e2e/supplier-payments.spec.ts` поповнював касу
сирим `fetch` у `page.evaluate` без ключа й без перевірки відповіді: поповнення мовчки дістало б 400,
а `confirm()` оплати постачальнику з каси падав би далі з «Недостатньо готівки». Вимоги не було і в
Swagger/`openapi.json` — сторонній клієнт дізнавався про неї лише з 400.
**Grep:** `grep -rnE "fetch\(\`\\$\{API\}/(payments|cash-registers/[^\`]_/operations)" apps/web/e2e`→ у кожного`'Idempotency-Key'`; `grep -rn "RequiredIdempotencyInterceptor\|RequireIdempotencyKey" apps/api/src --include=_.controller.ts`.
**Фікс:** ключ `crypto.randomUUID()`+`if (!fund.ok) throw`у сіді; декоратор`RequireIdempotencyKey()`(інтерсептор +`ApiHeader required`) на чотирьох маршрутах, `gen:api-types`, тест метаданих.
**Severity:** IMPORTANT (E2E), SUGGESTION (Swagger)

### 2026-10-23 — Сторно `CREDIT_NOTE` поза детектором `*_CANCEL`; `conversion` з null-полів — §5

**Сигнал:** `returnPartsAndCredit` (скасування наряду з «Виконано» / «Виставлено») писав `CREDIT_NOTE` з `date: documentDate, fallbackToLatest: true` — курс шукався заново (TECH-DEBT §17.1). Детектор пункту «сторно копіює конвертацію» шукав лише `type: '…_CANCEL'` і цей випадок не бачив. Після фіксу (`b75c934f`) рядок CHARGE з `amountBase`/`rateUsed = null` давав би `conversion { 0, 0 }` → 400 «сума має бути додатною» на скасуванні; інші сторно (`supplier-payments`, `bank-reconciliation`) мають перевірку `!= null`. **Grep:** `grep -rnE "type: '([A-Z_]+_CANCEL|CREDIT_NOTE)'" -A12 apps/api/src/modules --include="*.ts" | grep -v spec | grep "fallbackToLatest"`. **Фікс:** дзеркалити лише рядок із повною конвертацією, інакше старий шлях; `workOrder.findFirst` — лише для цього шляху; кейс «CHARGE без конвертації» з мутацією. Перше нарахування (`createdAt asc`), а не сума всіх: дублікати до індексу BR-SETL-015 (Bug #943) компенсує оператор. **Severity:** IMPORTANT

### 2026-10-23 — Довідник марок: відновлення авто й sync push повз нове правило «живий FK» — §4

**Сигнал:** BR-VEH-008 вимагає живих марку й модель на create/update авто, але `VehiclesService.restore`
робив видалене авто живим без перевірки й без блокування довідника: марку видаляють, коли живих авто
немає (видалені авто лишаються на ній), тож відновлене авто посилалось на видалену марку, а одночасне
відновлення прослизало повз перевірку «живі авто» видалення. `SyncService.writeVehicle` писав пару без
скидання кешу `ref:vehicle-makes:<org>`, яке робить web-писач (лічильники авто у вкладці до 5 хв).
**Grep:** `grep -n "async restore" apps/api/src/modules/<модуль>/*.service.ts` → перевірка нових FK-правил;
`grep -rn "cache.del" <модуль>` проти писачів у `sync.service.ts`.
**Фікс:** `assertVehiclePairLive` у транзакції відновлення після `lockVehicleDirectoryShared` (до гаража, як
create) → 400 `err.vehicle.makeModelDeletedRestoreFirst` (BR-VEH-014); `cache.del` після запису пари в sync.
Мутації «без перевірки», «лише марка», «блокування після гаража», «без скидання», «скидання завжди» падають.
**Severity:** IMPORTANT

### 2026-10-26 — CAS переходу задачі звіряв статус, але не видимість виконавця — §5

**Сигнал:** `TasksService.transition` читав задачу з `taskVisibilityWhere(actor)` (виконавець — лише своя), а
`updateMany` CAS-запису мав лише `{ id, orgId, deletedAt: null, status }`: задачу, переназначену між читанням і
записом, колишній виконавець усе одно переводив у DONE. Пункт `sections/api.md` «умова відмови теж іде в `where`
CAS» — той самий клас: умова доступу, з якої рахувалась відмова, теж має бути в `where`.
**Grep:** `grep -n -A12 "VisibilityWhere(actor)" apps/api/src/modules/*/*.service.ts | grep -A3 "updateMany"` →
звірити, що `where` CAS містить ту саму умову видимості.
**Фікс:** `where: { id, orgId, deletedAt: null, status: task.status, ...taskVisibilityWhere(actor) }` + тест гонки
з переназначенням (`tasks.fsm.spec.ts`). **Severity:** IMPORTANT

### 2026-10-29 — Нові `$transaction(async tx => …)` без timeout, які детектор «на файл» не бачив — §5

**Сигнал:** outbox подій (BR-AUT-060) обгорнув у транзакцію 11 записів, що раніше йшли без неї
(рахунок, клон, оплата й повернення постачальнику, онлайн-запис, задачі, нічне OVERDUE пачками), —
усі без `{ timeout }`. Старий детектор рахував `$transaction(async` проти `timeout:` у файлі й мовчав
там, де у файлі вже були інші транзакції з timeout (`invoices.service.ts`). Пачка OVERDUE — до 200
окремих CAS у типових 5 с.
**Grep:** `grep -rnE '\$transaction\((async )?[a-z]+ => \{' apps/api/src --include="*.ts" | grep -v spec`
(prettier тримає колбек на рядку виклику лише тоді, коли він — єдиний аргумент).
**Фікс:** `{ timeout: TRANSACTION_TIMEOUT_MS }`; для пачки — власна стеля (`OVERDUE_TX_TIMEOUT_MS`).
Попутно — `brands.service.ts` `underWritingsLock`. **Severity:** IMPORTANT

### 2026-10-29 — Подія з `fromStatus` поверх запису без CAS за статусом — §5

**Сигнал:** подія outbox бере `fromStatus` із прочитаного рядка; там, де запис статусу не був CAS-ом
(`purchaseOrder.update({ where: { id, orgId } })` у `transition`, `bookingRequest.updateMany` без
`status` у `cancel`, CAS оплати рахунку лише за `paidAmount`), паралельна зміна давала подію з
неправдивим «з якого статусу», а заразом — FSM-обхід (DRAFT → ORDERED і DRAFT → CANCELLED обидва
проходили) і слот, підтверджений паралельно, лишався не звільненим після скасування запису.
**Grep:** `grep -rn -B25 "recordDocumentEvent" apps/api/src/modules --include="*.ts" | grep -E "\.update\(\{ where: \{ id(, orgId)? \}|updateMany\(\{ where: \{ id, orgId, deletedAt: null \}"`
→ для кожного запису статусу поруч із подією в `where` є прочитаний статус.
**Фікс:** CAS `where: { …, status: <прочитаний> }` + решта полів, з яких будується ефект
(`confirmedSlotId`); `count = 0` → 400 «статус змінився» з кидком УСЕРЕДИНІ транзакції (інакше
звільнення слота вище комітиться без скасування). **Severity:** IMPORTANT

### 2026-10-29 — Подія без статусу і правило зі статусом: мовчун; `{{status}}` із поточного документа — §5

**Сигнал:** оплата клієнта писала outbox-подію `CREATED` без `toStatus`, а двигун пропускав правило
з непорожнім `toStatuses`, коли в події статусу немає: правило «оплату створено → у статус …»
зберігалось і ніколи не спрацьовувало. Поруч — `{{status}}` брався з документа на момент обробки
(через ~10 с після події), тож оплата, що одразу переводить наряд «Виконано» → «Оплачено», давала
клієнту в повідомленні про «Виконано» статус «Оплачено».
**Grep:** `grep -rn -A4 "kind: 'CREATED'" apps/api/src/modules --include="*.service.ts" | grep -v spec`
→ у кожного виклику `recordDocumentEvent` є `toStatus`; змінні шаблону зі статусом — з `event.toStatus`.
**Фікс:** `toStatus: AUTOMATION_PAYMENT_ACTIVE_STATUS` у події створення; схема правила відкидає для
«створено» статус поза `AUTOMATION_CREATED_STATUSES`; `eventVars(ctx, occurredAt, event.toStatus)`
(`cb6f44ccb`). **Severity:** IMPORTANT (правило, що зберігається і не працює).
