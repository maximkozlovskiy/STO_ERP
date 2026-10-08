# sto-review — секція: API: архітектура, бізнес-правила, контракт (§4, §5, §13)

> Частина скіла `sto-review`. Алгоритм і матриця «тип зміни → секції» — у `../SKILL.md`.
> Читати цілком, коли матриця призначила хоч один § цього файла.
> Реальні випадки з детекторами: `../journal/api.md` (шукати, не читати цілком).

### §4 Architecture

```bash
# Бізнес-логіка у контролері
grep -rn "prisma\.\|NotFoundException\|BadRequestException" apps/api/src/ --include="*.controller.ts" | grep -v "spec\|ParseUUID"
# List endpoint без { items, total } wrapper
grep -rn "async findAll\|async getAll" apps/api/src/modules/ --include="*.service.ts" | grep -v "ResponseDto\[\]\|Dto\[\]>\|Paginated" | head -10
```

- [ ] Controller: HTTP layer тільки (ніяких Prisma, бізнес-логіки, `if/else`)
- [ ] Service: вся логіка + Prisma (ніяких `req`, `res`)
- [ ] `toResponseDto()` / `toDto()` — жоден Prisma об'єкт не повертається напряму
- [ ] List endpoints → `{ items, total }` (не bare array)
- [ ] Нові модулі → зареєстровані в `app.module.ts`
- [ ] Cross-service `.catch(() => {})` → `.catch(e => { if (!expected) logger.warn(...) })`
- [ ] FSM auto-transition у tx → re-read entity всередині tx + перевірка `status === expected`
- [ ] **Новий запис у ЧУЖИЙ агрегат усередині tx → порядок блокувань той самий, що в сервісі-власнику.** Два сервіси, що в одній tx пишуть ті самі два рядки у різному порядку (A: акт → наряд, B: наряд → акт), дають deadlock → 500 замість 400 «статус змінився». Unit-тести з моками цього не бачать (`journal/api.md`, 2026-10-08)
- [ ] **Нове правило на `create` → перевір `update` тієї ж сутності і сусідні документи тієї ж ролі.** FK з тіла PATCH (`counterpartyId`, `supplierId`) має пройти ту саму перевірку, що на create, і статичний сторож підключення має рахувати й ці виклики (`journal/api.md`, 2026-10-08)
- [ ] **Перевірки пов'язаної сутності за `if (dto.xId && x && …)` → окрема гілка «`dto.xId` є, а `x` не знайдено» кидає 404.** Інакше для чужого чи видаленого `x` мовчать УСІ правила разом (статус, власник, валюта, ліміт), а запис далі в транзакції все одно йде. Читання в tx — з тим самим `deletedAt: null`, що й до неї. Grep: `grep -rnE "dto\.[a-zA-Z]+Id && [a-zA-Z]+ &&" apps/api/src/modules --include="*.service.ts"` (`journal/api.md`, 2026-10-09)
- [ ] **Новий `*.spec.ts` у коміті → рядок у реєстрі дос'є; гейт C цього НЕ ловить** (він перевіряє лише, що названі файли існують). Grep: `git diff --name-status <base> | grep -E "^A.*\.spec\.ts"` → кожен файл згаданий у `docs/objects/*.md`; і текст під таблицею («N у модулі + M поза ним») сходиться з сумою рядків (`journal/api.md`, 2026-10-09)

- [ ] **Грошовий документ, зібраний із КІЛЬКОХ читань (баланс + журнал + агрегат) → одне `$transaction` з `isolationLevel: 'RepeatableRead'`.** Окремі читання дають документ, що не сходиться сам із собою: проводка між ними потрапляє в одне читання й не потрапляє в інше (`journal/api.md`, 2026-10-08, акт звірки)
- [ ] **Термінальний статус «не сталося» (EXPIRED/FAILED) для зовнішньої операції ставиться лише на ВІДПОВІДЬ зовнішньої системи, не за годинником.** Таймаут + недоступний шлюз = «невідомо», а не «не оплачено»: спершу останній запит, і лише його відповідь закриває (`journal/api.md`, 2026-10-08, онлайн-оплата)

#### §4.1 Circular DI

```bash
grep -rn "forwardRef" apps/api/src/ --include="*.module.ts" | head -5
```

- [ ] Circular DI → `forwardRef(() => ServiceB)`
- [ ] `EventEmitter2.on()` тільки у `onModuleInit()` або `constructor` (не в request handler)

---

### §5 Business Rules

```bash
# Прямий update stockItem поза InventoryService
grep -rn "stockItem\.update\|stockItem\.upsert" apps/api/src/modules/ --include="*.ts" | grep -v "inventory.service\|spec"
# Прямий update balance поза SettlementsService
grep -rn "settlementAccount\.update" apps/api/src/modules/ --include="*.ts" | grep -v "settlements.service\|spec"
# Прямий delete (hard delete)
grep -rn "prisma\.[a-zA-Z]*\.delete(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# findFirst/findMany без deletedAt: null
grep -rn "findFirst\|findMany" apps/api/src/modules/ --include="*.service.ts" \
  | grep -v "deletedAt\|spec\|StockMovement\|SettlementTransaction\|Payment\|WorkOrderLineEmployee\|BatchConsumption\|PriceHistory\|Comment\|EmployeeBranch" | head -20
# $transaction без timeout
for f in $(grep -rl "\$transaction(async" apps/api/src --include="*.ts" | grep -v spec); do
  tx=$(grep -c "\$transaction(async" "$f"); to=$(grep -c "timeout:" "$f")
  [ "$tx" -gt "$to" ] && echo "MISMATCH $f: $tx tx, $to timeouts"
done
# Sentinel empty-string у UUID FK write (AVG_COST/aggregate branch → '' → Postgres invalid uuid)
grep -rnE "consumed\[0\]\.batchId|allocations\[0\]\.[a-zA-Z]+Id|results?\[0\]\.[a-zA-Z]+Id" apps/api/src/modules --include="*.ts" | grep -v spec | head
# Fix: if (results[0].id) db.X.update({...}) або truthy ternary: results[0].id ? results[0].id : null
# Валютна dto.amount накопичується у base-only сіблінг-агрегат (Invoice/WO paidAmount)
grep -nE "paidAmount.*(increment|decrement).*dto\.amount|prevPaid \+ dto\.amount|dto\.amount > remaining" apps/api/src/modules --include="*.service.ts"
```

- [ ] FSM: `transition()` читає з `WORK_ORDER_TRANSITIONS` map
- [ ] Stock: тільки через `InventoryService.createMovement()`
- [ ] Settlements: тільки через `SettlementsService.createTransaction()`
- [ ] **Мультивалюта: `amountBase`/`rateUsed` ТІЛЬКИ через `ExchangeRatesService.resolveBaseConversion(orgId, currencyId, date, amount)`.** Грошовий агрегат у не-базовій валюті (CashOperation, Payment…) пише пару `(amountBase, rateUsed)`. Base-валюта (`OrganisationSettings.currency` за КОДОМ) → `{rateUsed:1, amountBase:amount}` БЕЗ читання курсу; інша без курсу на дату → **400** (НІКОЛИ тихо `rate=1` — спотворить base-облік); `getRateAsOf` бере найближчий `date ≤ операції` (НЕ майбутній). `convertToBase = roundMoney(amount*rate/safeCoeff(coefficient))`. ❌ `amountBase=amount` для валютної операції; ❌ fallback `rate=1` коли курсу немає. Баланс/overdraft каси лишаються у ВАЛЮТІ каси (`amount`, не base — каса моно-валютна). Помилки про суми каси — БЕЗ хардкоду `₴` (каса може бути USD/EUR); `₴` лише де base гарантовано UAH
- [ ] **Мультивалюта: валютна `dto.amount` НІКОЛИ не накопичується/порівнюється проти base-only сіблінг-агрегату — використати `conv.amountBase`.** Коли грошова операція має валюту (Payment `dto.amount` у валюті рахунку), а сусідня сутність БЕЗ `currencyId` (Invoice/WorkOrder `amount`/`paidAmount`/`totalAmount` — у БАЗОВІЙ валюті org), то `paidAmount + dto.amount`, `paidAmount: { increment: dto.amount }`, `if (dto.amount > remaining)` **змішують валюти** (100 USD зрівнялось би зі 100 UAH). Fix: усі accumulate/compare проти base-only полів → `conv.amountBase` (BC: у base `conv.amountBase === dto.amount`). Overpay/remaining → `baseCode` (`getBaseCurrency`), НЕ хардкод «грн». Grep: детектор вище → для кожного перевірити, чи цільова модель має `currencyId`. Sample: payments.service invoice/WO paidAmount (12bf3e2d). Severity: CRITICAL. (Деталі: запис 2026-09-14)
- [ ] **Money-critical date-parse → rollover-guard; НІКОЛИ голий `new Date(str)` на дату, що визначає курс/amountBase.** `new Date('2026-02-31')` НЕ дає NaN — тихо перекочує у 03-02 (а `'2026-02-31T00:00:00'`/`'2026/02/31'` — ще й у локальну tz) → зіпсована `operationDate` → неправильний `getRateAsOf` → спотворений `amountBase` (мовчки, без помилки). Guard: для `^YYYY-MM-DD$` парсити компоненти через `Date.UTC` + звіряти (`getUTCFullYear/Month/Date`), відкидати rollover; повний ISO з часом/зоною (`^\d{4}-\d{2}-\d{2}[T ]`) → нативний парсер (V8 дає NaN на неможливих компонентах). **Особлива увага: re-parse DTO-поля у public POST, навіть якщо upstream-парсер (file-import/provider) guarded** — endpoint приймає й сирий client-JSON (`@IsString operationDate`), тож guard МУСИТЬ бути й на write-стороні (`applyImport`), не лише у провайдері; невалідна → **400**, не тихе спотворення. Grep: `grep -rnE "new Date\((row\.|dto\.|[a-z]+\.operationDate|str|s)\)" apps/api/src/modules --include="*.ts" | grep -v spec` → кожен без сусіднього `getUTCFullYear`/`Number.isNaN`-guard = money-critical, якщо дата йде у `resolveBaseConversion`/`getRateAsOf`. Sample: bank-reconciliation.applyManImport (Cycle-3), privat24/parser parseDate (Bug #767/#772). Severity: CRITICAL (FX-облік)
- [ ] `IN_PROGRESS` → `RESERVATION`; `COMPLETED` → `WRITEOFF+RESERVATION_RELEASE+CHARGE` у `$transaction`
- [ ] `CANCELLED` зі статусу з резервом → `RESERVATION_RELEASE`
- [ ] Soft delete скрізь; **без deletedAt** (append-only): `SettlementTransaction`, `StockMovement`, `StockBatch`, `BatchConsumption`, `PriceHistory`, `Payment`, `CashOperation`, `WorkOrderLineEmployee`, `Comment`, `EmployeeBranch`
- [ ] Кожен `$transaction(async cb)` → `{ timeout: N }` (5s–15s). Детектор вище шукає лише `$transaction(async` — форму `$transaction(tx => …)` без `async` перевір окремо: `grep -rnE '\$transaction\([a-z]+ =>' apps/api/src --include="*.ts" | grep -v spec`
- [ ] **Залишок округлення «в останній рядок» → перевір, що рядок може його вмістити.** Вирівнювання Σ рядків до суми документа, яке безумовно править `lines[lines.length - 1]`, дає від'ємну суму чи ПДВ, коли останній рядок нульовий (робота з 0 годин) або замалий. Залишок бере останній ненульовий рядок, що лишається ≥ 0; у тесті — кейс із нульовим останнім рядком (`journal/api.md`, 2026-10-08)
- [ ] **Змінив формулу суми рядка в тоталах → кожен документ, що друкує цей рядок, округлює його тим самим `money()`.** Сирий добуток, відданий форматеру (`Intl.NumberFormat`, `toFixed`), округлюється за двійковим поданням: `0.3 × 100.05 = 30.014999…` друкується «30,01», а в підсумок увійшло 30.02. Grep: `grep -rnE "\b(total|amount|sum): [a-zA-Z.]+ \* [a-zA-Z.]+,?$" apps/api/src/modules --include="*.ts" | grep -v "money(\|spec"` (`journal/api.md`, 2026-10-09)
- [ ] `SettlementsService.createTransaction` → internal `amount > 0 && Number.isFinite(amount)` guard
- [ ] **Новий виклик `docNumbers.next(orgId, 'X')` → тип `X` є в `seed.ts`, `setup.service.ts` І в backfill-міграції.** Інакше створення документа дає 404 на кожній org, а unit-тести (мок `DocumentNumberService`) зелені. Детектор і взірець міграції — `journal/api.md`, запис 2026-10-07. Severity: CRITICAL
- [ ] **Статичний сторож у spec (читає код regex-ом) — fail-closed:** аргумент, який він не може прочитати як літерал (`data: updates`, shorthand, spread), має бути порушенням, і на кожну обхідну форму є контрольний кейс (`journal/api.md`, 2026-10-07)

#### §5.1 Pricing & Batches

```bash
grep -n "PERCENT\|FIXED_AMOUNT\|FIXED_PRICE\|roundTo\|Math.max\|Math.round\|nulls.*last\|AVG_COST" \
  apps/api/src/modules/inventory/pricing.service.ts \
  apps/api/src/modules/inventory/batch.service.ts 2>/dev/null
```

- [ ] `PERCENT` = `cost * (1 + pct/100)`; `FIXED_AMOUNT` = `cost + delta`; `FIXED_PRICE` fallback = `fixedPrice ?? costPrice`
- [ ] Округлення = `Math.round(result / r) * r`; захист = `Math.max(0, result)`
- [ ] FEFO: `[{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]`
- [ ] AVG_COST: `SUM(remainingQty * costPrice) / SUM(remainingQty)` (не `SUM(price) / count`)
- [ ] Batch loop: `Math.min(remaining, batch.remainingQty)`; після циклу `remaining > 0` → `throw`
- [ ] `Number(l.amount)` cast у `recalcTotals` (Decimal без cast → рядкова конкатенація)

#### §5.2 Soft-delete + @@unique = resurrection (Bug #152)

```bash
grep -n "@@unique" packages/database/prisma/schema/*.prisma | grep -v "deletedAt"
grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"
```

- [ ] Модель з `@@unique([orgId, X])` де X не `deletedAt` → `create()` має resurrection pattern:
      `findFirst({ orgId, X })` (без `deletedAt` filter) → якщо `deletedAt !== null` → `update({ ...dto, deletedAt: null })` замість `create`; якщо active → `ConflictException`
- [ ] `update()` що змінює unique-поле → re-check: `findFirst({ orgId, X, NOT: { id } })` → `ConflictException`

---

### §13 API Contract

```bash
# Frontend інтерфейси
grep -rn "^interface \|^type [A-Z]" apps/web/src/app/ --include="*.tsx" | grep -v "Props\b"
# Backend toResponseDto
grep -rn "toResponseDto\|toDto\|toDetailDto" apps/api/src/modules/ --include="*.ts" | grep -v spec
# syncVersion BigInt напряму у response
grep -rn "return\s*await\s*this\.prisma\.[a-zA-Z]\+\.\(findMany\|findFirst\|create\|update\)" \
  apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# Payload spread з BigInt (Bug #128)
grep -rn "payload.*\.\.\.row\|payload:\s*row" apps/api/src/modules/ --include="*.ts" | grep -v spec
# Dynamic model lookup plural→singular (Bug #127)
grep -rn "toCamel\|snakeToCamel\|snake_to_camel" apps/api/src/ --include="*.ts" | grep -v spec
```

- [ ] Кожне обов'язкове поле frontend-`interface` повертається у `toResponseDto()`
- [ ] `Decimal` → `Number(x)` у DTO; `createdAt`: `string` (не `Date`) у фронті
- [ ] `syncVersion BigInt` **ніколи** напряму у response — `Number(row.syncVersion)` або `select` без нього
- [ ] `payload = { ...row }` → normalize loop: `if (typeof v === 'bigint') Number(v)`
- [ ] Dynamic `(prisma as any)[modelName]` → explicit `TABLE_TO_MODEL: Record<string,string>` + `if (!model) throw`
- [ ] Polymorphic `entityType` → `IsIn([...ENTITY_TYPES])` + фронт використовує ті самі константи

---
