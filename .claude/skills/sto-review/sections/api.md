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
- [ ] **Новий E2E `apps/web/e2e/*.spec.ts` → абзац «E2E:» у дос'є агрегату; рядок «API Endpoints» дос'є, що зачіпає diff, → URL = префікс `@Controller(...)`, не назва модуля.** Гейти C і `check-doc-links` цього не бачать. Grep: `git diff --name-status <base> | grep -E "^A.*e2e/.*\.spec\.ts"` → кожен файл згаданий у `docs/objects/*.md`; `grep -n "@Controller" <модуль>.controller.ts` проти таблиці (`journal/api.md`, 2026-10-16)

- [ ] **PATCH, що зливає тіло запиту з наявним станом («прочитав → злив → записав»), читає стан
      У ТІЙ САМІЙ транзакції під блокуванням рядка** (`pg_advisory_xact_lock(hashtext('<агрегат>:<id>'))`).
      Читання до транзакції дає двом одночасним PATCH однаковий стан: заміщення дочірнього списку
      (`deleteMany` + `createMany`) перетворюється на об'єднання двох списків. І перевіряти лише
      посилання, які прийшли в ЦЬОМУ запиті: перевірка FK з наявного стану робить запис
      нередагованим, щойно пов'язану сутність видалили (`journal/api.md`, 2026-10-12)
- [ ] **Пакетний пошук `findMany({ where: { X: { in } }, take: N })` за НЕунікальним полем —
      сторінками до кінця, не одним `take`.** Обрізана вибірка лишає від двох збігів один, і
      «неоднозначно» мовчки стає «знайдено». Без регістру — `{ in, mode: 'insensitive' }`
      (Prisma дає `LOWER(col) IN (LOWER($1)…)`, не `LIKE`), а не варіанти регістру з JS
      (`journal/api.md`, 2026-10-12)
- [ ] **Пошук за ПАРОЮ ключів двома незалежними `IN` (`goodId: { in }` + `unitOfMeasureId: { in }`)
      тягне перехресні пари, і `take` під нього не порахувати** → унікальні пари через
      `OR: [...pairs]` з `take: pairs.size` (`sto-dev` sections/api.md, «Запобігання N+1»). Grep:
      `git diff <base> -- apps/api/src | grep -nE "^\+.*Id: \{ in: " ` → два `IN` в одному `where`
      (`journal/api.md`, 2026-10-22)
- [ ] **Новий тест, вставлений між міткою `// guards: BR-…` і чужим `it(`, краде мітку:** правило
      сусіда лишається без сторожа, а новий тест стереже не своє. Grep:
      `git diff <base> -U3 -- '*.spec.ts' | grep -A1 "^ .*// guards:" | grep "^+.*it("` → кожен збіг
      звірити з текстом правила в дос'є (`journal/api.md`, 2026-10-22)
- [ ] **`csv-parse` з `delimiter: [',', ';']` ділить по обох знаках одразу** — роздільник
      визначати один на файл (деталі — `docs/GOTCHAS.md`, 2026-10-12)
- [ ] **Грошовий документ, зібраний із КІЛЬКОХ читань (баланс + журнал + агрегат) → одне `$transaction` з `isolationLevel: 'RepeatableRead'`.** Окремі читання дають документ, що не сходиться сам із собою: проводка між ними потрапляє в одне читання й не потрапляє в інше (`journal/api.md`, 2026-10-08, акт звірки)
- [ ] **Термінальний статус «не сталося» (EXPIRED/FAILED) для зовнішньої операції ставиться лише на ВІДПОВІДЬ зовнішньої системи, не за годинником.** Таймаут + недоступний шлюз = «невідомо», а не «не оплачено»: спершу останній запит, і лише його відповідь закриває (`journal/api.md`, 2026-10-08, онлайн-оплата)

- [ ] **Пара «тип + id» (`sourceType` + `cashRegisterId`): id без типу не губиться мовчки.** Тип
      береться з єдиного переданого id або відповідь 400; два резолвери тієї самої пари
      (налаштування й операція) мають одну семантику. Grep:
      `grep -rn "dto.sourceType ??" apps/api/src/modules --include="*.service.ts"` (`journal/api.md`, 2026-10-14)

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
- [ ] **Кількість днів періоду — з календарних дат, не з різниці меж київської доби.** `Math.ceil((toDate − fromDate) / 86_400_000)` на межах `kyivDayStart`/`kyivDayEnd` дає зайвий день для кожного періоду з 25-годинною добою (остання неділя жовтня): один день → 2. Рахувати `(Date.parse(to + 'T00:00:00Z') − Date.parse(from + 'T00:00:00Z')) / 86_400_000 + 1`. Grep: `grep -rnE "(toDate|to)\.getTime\(\) - (fromDate|from)\.getTime\(\)\) / 86_400_000" apps/api/src/modules --include="*.ts" | grep -v spec` (`reports.service` `load`, review 2026-10-09)
- [ ] **Твердження «запит вимкнено» у тесті — лише після того, як тест його ВВІМКНУВ.** `expect(args.enabled).toBe(false)` на стані, де `enabled` і так false з першого рендера (кнопку «Розрахувати» ще не тиснули), лишається зеленим без умови, яку нібито стереже. Мутацію робити по ОДНІЙ умові, не двома разом (`PayrollListPage.test.tsx`, review 2026-10-09)
- [ ] **Сторно проведення копіює `amount` / `currencyId` / `rateUsed` / `amountBase` ПОЧАТКОВОГО запису з журналу, а не рахує базову суму заново.** Курс на ту саму дату могли додати чи виправити вже після проведення (а з `fallbackToLatest` він і так «останній відомий») — перерахунок лишає в балансі різницю. `createTransaction` приймає явну `conversion`. Grep: `grep -rnE "type: '[A-Z_]+_CANCEL'" -A8 apps/api/src/modules --include="*.ts" | grep -v spec | grep "fallbackToLatest"` → кожен збіг — сторно з перерахунком (`journal/api.md`, 2026-10-09)
- [ ] **CAS у «скасуванні» звіряє не лише статус, а й те, з чого будується зворотний ефект.** «Прочитав рядок → CAS за `status` → сторно на прочитані дані»: між читанням і CAS рядок могли скасувати й рознести знову тим самим видом на іншого контрагента — статус той самий, сторно йде на старі дані. У `where` — мітка операції (`matchedAt`) і посилання, що визначають ефект. Те саме для «захоплення → дія в чужій транзакції → відкат»: кожен наступний запис і відкат прив'язані до мітки СВОГО захоплення. Безумовний `update({ where: { id } })` після читання статусу (FSM `cancel`) — та сама діра (`journal/api.md`, 2026-10-09)
- [ ] **Умова ВІДМОВИ, прочитана без блокування, теж іде в `where` CAS-запису.** «Прочитав → `if (стан X) throw` → `updateMany({ where: { id, reversedAt: null } })`»: стан X міг змінити інший писар без блокування (обробник черги пише `DONE`), і запис проходить повз відмову, а ще й затирає X своїм значенням. У `where` — усі поля, з яких рахувалась відмова чи нове значення; `count = 0` → перечитати й дати точну причину. Grep: `grep -rn -B30 "updateMany" apps/api/src/modules --include="*.service.ts" | grep -E "if \(.*\.(fiscalStatus|status) ===.*\) \{"` → для кожної відмови звірити `where` наступного CAS (`journal/api.md`, 2026-10-14, сторно оплати)
- [ ] **Тест «змінилось між перевіркою і транзакцією» на таблиці в пам'яті → читання віддають ЗНІМОК
      рядка (`{ ...row }`), а не посилання.** `memoryTable.findFirst` повертає сам рядок: зміна в
      `beforeTx` видна й об'єкту, прочитаному ДО транзакції, тож тест не відрізняє перевірку до
      транзакції від читання в ній — мутанти «тип проводки за статусом до транзакції» і «прибрати
      перевірку залишку в транзакції» вижили (`payments.work-order.spec.ts`, review 2026-10-15).
      Grep: `grep -rl "beforeTx" apps/api/src --include="*.spec.ts" | xargs grep -L "{ ...r }"` →
      кожен файл перевірити. Та сама пастка в коді — `if (x) { … }` у транзакції без `else throw`:
      документ, що зник між перевіркою і записом, мовчки пропускає всі свої перевірки
- [ ] **Best-effort аудит усередині спільного писача, викликаного з ЧУЖОЮ транзакцією, пишеться до її коміту.** `audit.record` іде окремим з'єднанням: відмова викликача ПІСЛЯ виклику писача відкочує рядок, а подія «створено» лишається про рядок, якого немає. Викликач, у якого після запису ще можливі відмови, відкладає аудит (`deferAudit`) і пише його після коміту. Grep: `grep -rn "createOperation(" apps/api/src/modules --include="*.ts" | grep -v spec` → для кожного виклику з `tx` перевірити, чи є після нього `throw` у тій самій транзакції (`journal/api.md`, 2026-10-14)
- [ ] **Конфлікт `Serializable`-транзакції ловити через `isSerializationConflict()` (`common/utils/prisma-errors.ts`), не через `code === 'P2034'`.** Конфлікт, помічений на COMMIT, драйвер-адаптер віддає як `DriverAdapterError` (`cause.kind = 'TransactionWriteConflict'`), і перевірка лише на `P2034` дає 500. Grep: `grep -rn "'P2034'" apps/api/src --include="*.ts" | grep -v "spec\|prisma-errors"` → має бути порожньо (`journal/api.md`, 2026-10-14)
- [ ] **Запобіжник «прочитав залишок → записав» (каса не в мінус, ліміт, квота) у ЧУЖІЙ транзакції → блокування ресурсу перед читанням** (`pg_advisory_xact_lock(hashtext('<ресурс>:<id>'))`). Транзакція викликача зазвичай ReadCommitted: два одночасні записи читають той самий залишок і обидва проходять. Рядкове блокування суміжної сутності (рахунок взаєморозрахунків контрагента) рятує лише запити з ТИМ САМИМ контрагентом — гонку перевіряти наживо з різними (`journal/api.md`, 2026-10-14)
- [ ] **Нове правило «підстав значення за замовчуванням, якщо не передано» у спільному писачі → пройти ВСІХ його викликачів.** Той, хто свідомо не передавав значення («без статті — це переміщення, а не дохід»), мовчки отримає підставлене; йому потрібен явний прапорець відмови. Grep викликачів: `grep -rn "createOperation(" apps/api/src/modules --include="*.ts" | grep -v spec` (`journal/api.md`, 2026-10-14)
- [ ] **Свідомо пропущений фільтр (`findMany` без `deletedAt: null`, бо звільнений працівник
      лишається на своїх минулих записах) → тест на моку, що ВИКОНУЄ `where`, з видаленим рядком.**
      Мок із фіксованою відповіддю (`mockResolvedValue([...])`) не відрізняє запит із фільтром від
      запиту без нього: мутант «додати `deletedAt: null`» виживає, і рішення тримається лише на
      коментарі. Grep: `git diff <base> -- apps/api/src | grep -nE "^\+.*(Без|без) .deletedAt"` →
      для кожного — кейс із рядком `deletedAt: <дата>` (`journal/api.md`, 2026-10-15)
- [ ] **Фільтр списку «кандидати для поля форми» (`?liftId=`) повторює правило сервера запису
      цілком і перекриває загальні прапорці списку (`showDeleted`)** — інакше список пропонує те,
      що запис відхилить 400 (`journal/api.md`, 2026-10-16)
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

#### §5.3 Тест guard-а, замаскований попереднім guard-ом (2026-10-18)

```bash
# Тест, що чекає лише клас помилки (BadRequestException) для другої перевірки підряд
grep -rn "rejects.toThrow(BadRequestException)" apps/api/src --include=*.spec.ts
```

- [ ] Метод має кілька послідовних 400-перевірок (статус документа → стан відправки → …), а тест
      другої лише `rejects.toThrow(BadRequestException)` і лишає стан, на якому спрацює ПЕРША →
      тест зелений і без другої перевірки. Скинути стан першої (`supplierApiStatus = 'NOT_SENT'`)
      і чекати ТЕКСТ саме цієї помилки; кожен статус правила — окремо (не лише CANCELLED).
- [ ] Правило з числовою межею (30 днів, ліміт, стеля) у дос'є → тест по обидва боки межі
      (29 / 31 дні), доведений мутацією константи.

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

## Спеки: підміна спільного модуля цілком (повний прогін, 2026-10-12)

```bash
# vi.mock спільного модуля фабрикою БЕЗ importOriginal — підозра на витік у чужі спеки
grep -rn "vi.mock('\.\./\.\./common/" apps/api/src --include="*.spec.ts" | grep -v importOriginal
```

- [ ] `vi.mock` модуля з `common/` (особливо `tenant/tenant-context`) — лише частковий
      (`async importOriginal => ({ ...(await importOriginal()), … })`) або відсутній, якщо типова
      поведінка годиться. Проєкт `shared` у vitest не ізолює модулі між файлами: мок без
      `runUnscoped` / `isTenantBypassed` валить `field-encryption.extension.spec.ts` і
      `for-each-active-org.spec.ts` — і лише в ПОВНОМУ прогоні (деталі — `docs/GOTCHAS.md`).
