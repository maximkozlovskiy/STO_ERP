# sto-tester — журнал підходів, 2026-09

> Не читати цілком — шукати за ключовим словом.

### 2026-09-30 — Snapshot/drill-down фіча: чек-ліст edge-cases + інваріант «Σ дітей = батько» (feature b1beca00, 0 багів) — Area: backend + frontend / snapshot / гроші

**Контекст:** bug hunt фічі «розшифровка нарахувань ЗП у розрізі нарядів» (PayrollLine → PayrollLineWorkOrder snapshot, drill-down UI + tfoot «Разом база»). Функціональних багів НЕ знайдено — фіча коректна. Запис фіксує **систематичний підхід до тестування snapshot/breakdown-фіч**, який зробив сесію швидкою; він багаторазовий для будь-якої фічі, що ФІКСУЄ денормалізовану розбивку на момент FSM-переходу.

**Сигнал (де застосовувати):** нова модель-«дитина» без FK-cascade, що зберігає ТЕКСТОВІ snapshot-поля (`workOrderNumber`, `vehicleName`) + Decimal-частку суми, створювана в тій самій $transaction, що й батьківський рядок при FSM-переході (DRAFT→COMPUTED/PROCESSED). Grep-ознаки: `deleteMany(children) … deleteMany(parent)` порядок (FK RESTRICT), `createMany` дітей у циклі по `parent.create({select:{id}})`, `include: { <children>: {...} }` лише в `findOne` (не `findAll`).

**Підхід до виявлення (чек-ліст edge-cases для snapshot-фічі — перевіряти РЕАЛЬНО через live API+БД, не читанням):**

1. **Recompute lifecycle:** повторний FSM-перехід на не-DRAFT → 400; шлях перерахунку = soft-delete→recreate→compute; при перерахунку діти видаляються ПЕРЕД батьком (порядок deleteMany, FK RESTRICT) — spec-тест на `invocationCallOrder`.
2. **Наступний FSM (pay/finalize) не чіпає snapshot:** порахувати к-сть дочірніх рядків ДО і ПІСЛЯ переходу — має збігатись; PAID/фінальний статус показує розбивку.
3. **Батько без дітей:** якщо `aggregate()` (батьки) і `aggregateChildren()` мають ІДЕНТИЧНИЙ WHERE → батько без дітей неможливий; АЛЕ старий рядок (створений до фічі) → `children=[]` → UI має показати empty-заглушку, не спінер/краш.
4. **Головна обіцянка — immutability:** snapshot читається з дочірньої таблиці, НЕ з живих джерел → зміна/видалення джерела після переходу не змінює розбивку. Перевірити реально: перехід → спроба змінити/видалити джерело → BEFORE===AFTER.
5. **Null-текст snapshot:** порожнє джерело (vehicle null / make+model+plate порожні) → formatter має вернути JS `null` (не рядок «null», не « »); UI `{x ?? '—'}`.
6. **Multi-parent no-leak:** ≥2 батьки з різними наборами дітей → кожна дитина на ПРАВИЛЬНОМУ `parentId` (з `parent.create({select:{id}})`, не спільний id).
7. **Tenant isolation:** діти вкладені під org-scoped-батька у `findOne({where:{orgId}})` → крос-org leak неможливий (але `child.orgId` теж проставляти).

**Інваріант «Σ дітей = батько» (tfoot-реконсиляція) — ключовий money-тест:** Σ `child.baseAmount` МУСИТЬ === `parent.baseAmount` (обіцянка «tfoot завжди сходиться»). Rounding-drift можливий ТІЛЬКИ якщо джерело має суб-копійкову точність: `roundMoney(SUM)` ≠ `Σ roundMoney(per-child)`. Перевірити тип колонки-джерела: якщо `Decimal(12,2)` (завжди 2dp) → drift НЕМОЖЛИВИЙ (roundMoney ідемпотентна на 2dp) → інваріант тримається автоматично. Якщо `Float`/довільна точність → drift РЕАЛЬНИЙ → тест обов'язковий. Регресія: unit-тест `Σ dto.children.baseAmount === dto.parent.baseAmount`.

**Підхід до фіксу (профілактика тестового gap):** snapshot-фіча ЧАСТО приходить із повним backend-spec, але БЕЗ component-тесту нової UI-логіки drill-down і БЕЗ E2E на розкриття. Це gap №1 — закривати завжди: (а) service.spec — null-formatter (3 варіанти), multi-parent no-leak (per `created.id`), findOne toDto (null зберігається + Σ=parent інваріант + Decimal→Number), старий рядок `children=[]`; (б) component-тест — drill-down + tfoot=parent, null→«—», old→empty, isLoading→спінер-не-empty, multi-row no-leak; (в) E2E — розкриття рядка → заголовок розбивки + tfoot + клікабельний лінк на джерело.

**Severity:** сама фіча тут 0 багів; підхід — profilактичний. Найвищий ризик у цьому класі — порушення інваріанта «Σ=parent» (money-critical, HIGH) і non-immutable snapshot (втрата головної обіцянки, HIGH). Null→«null»-рядок = LOW (косметика). Тестовий gap (нема component/E2E на drill-down) = MEDIUM (мовчазна регресія).

**Де шукати ще:** будь-яка «розшифровка/breakdown/деталізація» snapshot на момент документа — invoice lines snapshot, reconciliation act `snapshotJson`, stock-document рядки, будь-яке `*LineDetail`/`*Breakdown`/`*Snapshot`-суб-модель. Grep: `grep -rlnE "model \w+(Snapshot|Breakdown|LineWorkOrder|Detail)\b" packages/database/prisma/schema` + для кожної перевірити чи є component/E2E на її drill-down.

### 2026-09-21 — Фікс захардив N-1 з N sibling-гілок одного парсера, лишив native-fallback гілку unguarded (Bug #772, Cycle 2) — Area: backend / date-parse / гроші

**Сигнал (статичний):** Cycle-1-фікс додав rollover-guard у ДЕЯКІ гілки методу `parseDate`, але не в усі. Метод має кілька гілок за форматом: (а) regex `DD.MM.YYYY` → `Date.UTC`+guard ✓, (б) regex `ISO date-only` → `Date.UTC`+guard ✓, **(в) catch-all `const d = new Date(s)` (native parse) → БЕЗ guard ✗**. Guard-фікс зупинився на явно-regex-нутих гілках і пропустив «останній» native-fallback. Grep для будь-якого multi-branch date-парсера: `grep -rnE "new Date\((?!Date\.UTC|[a-z]+ \* 1000)" apps/api/src --include=*.ts | grep -v spec` → для кожного native `new Date(строка)` (не `Date.UTC`, не Unix `*1000`, не `new Date()`) у методі що ПОРУЧ має guarded-гілки → підозра на пропущену гілку. Емпірична перевірка native rollover: `node -e "console.log(new Date('2026-02-31'))"` → `2026-03-02` (НЕ NaN!); `'2024/02/31'`, `'2024-02-31T00:00:00'` (без Z) → ще й локальна tz.

**Причина виникнення:** розробник (або Cycle-1-агент) бачить «датовий баг», знаходить очевидні regex-гілки де сам будує `Date.UTC(y,m,d)`, додає component-звірку — і вважає метод закритим. Native-fallback-гілка `new Date(str)` виглядає «безпечною» (мовляв, невалідне → NaN → null через існуючий `Number.isNaN`-гард). Хибне припущення: JS Date для date-only/slash/tz-форм НЕ дає NaN, а тихо перекочує (`2026-02-31`→`03-02`). `Number.isNaN`-гард ловить лише зовсім сміття, не rollover.

**Підхід до виявлення:** коли валідуєш ПОПЕРЕДНІЙ фікс (Cycle 2 задача «підтвердити фікси тримаються») — не звірятись лише з тим, що фікс torкнув; перелічити ВСІ sibling-гілки того самого методу/switch і спитати «чи КОЖНА має той самий guard?». Метод-парсер з ≥2 гілок, де фікс чіпнув <всі — read повний метод, не diff. Спеціально шукати catch-all/else/останній `return new Date(x)` — саме він найчастіше лишається. Тест-геп як сигнал: `grep` spec по кожній гілці — гілка без жодного кейсу = сліпа зона.

**Підхід до фіксу:** застосувати той самий rollover-guard-патерн, що вже є у sibling-гілках: для date-only витягти компоненти regex-ом → `Date.UTC` → component-звірка (`getUTCFullYear/Month/Date !== вхід → null`); повний ISO з зоною (Z/±hh) лишити нативному парсеру (однозначний). Anchored `$` у regex щоб не перехопити datetime-форми. Regression-тест ОБОВ'ЯЗКОВО на саму пропущену гілку (не лише вже-покриті): невалідна→skip + валідна сусідня→парситься.

**Severity:** залежить від того що робить дата. Тут MEDIUM — гілка (в) defensive fallback (реальна Privat24 йде гілкою (а)), але зіпсована `operationDate`→неправильний курс→неправильний `amountBase` (гроші). Була б HIGH якби гілка на гарячому шляху.

**Де шукати ще:** будь-який parser/normalizer де фікс закрив «частину» — number-parse (`parseAmount` кома-vs-крапка гілки), IBAN/phone-normalize, enum-map з default-гілкою. Загальний meta-принцип Cycle-N валідації: **фікс що торкнув K гілок N-гілкового методу → аудит решти N−K гілок на той самий інваріант**. Sibling-гілки одного switch/if-ланцюга — найдешевше місце де ховається «той самий баг у сусідній гілці».

### 2026-09-21 — Хардкод символу валюти «₴» у ДИСПЛЕЙ-суфіксі суми, яка стала мультивалютною (e4fc5e7c) — Area: frontend + DTO join

**Сигнал (статичний):** JSX рендерить `{fmtMoney(row.amount)} ₴` (літерал «₴» одразу після суми) для рядка, чия сума зберігається у ВАЛЮТІ РАХУНКУ/джерела, а не гарантовано у base. Ознака ризику: у тій самій арці/фічі додано `BankAccount.currencyId` (multi-bank), `amountBase`+`currencyId` у row-моделі, monobank/інший провайдер з USD/EUR-рахунком. Grep: `grep -rnE "fmtMoney\([^)]+\)\s*₴|\}\s*₴" apps/web/src/**/*.tsx` → для кожного хіта перевірити: чи сума (`amount`) може бути НЕ-UAH (join-поле `*CurrencyCode`, `currencyId`, source-рахунок довільної валюти)? Якщо так і суфікс — літерал «₴» → баг. Відрізняти від Bug #743 (той про CSV/export що ДРОПАЄ валюту; цей — про on-screen СИМВОЛ, який #743 хибно вважає «зазвичай коректним»).

**Причина виникнення:** таблиця/модалка написана у до-мультивалютну епоху, коли ВСІ суми були UAH → хардкод «₴» був коректним. Пізніша фіча ретрофітить мультивалюту на рівні рахунку (multi-bank USD/EUR), оновлює backend-облік (amount у валюті рахунку + окремий amountBase у base), але UI-суфікс лишається літералом — silent: UAH-орг нічого не помічає, ламається лише на USD/EUR-рахунку (150 USD малюється «150 ₴»). Review ловить backend/money-invariant і пропускає дисплей-літерал.

**Підхід до виявлення:** трасувати нитку валюти від сховища до піксела. (1) row-модель: чи `amount` — у валюті рахунку/джерела (не base)? (2) чи є join-поле коду валюти у DTO (`*CurrencyCode`)? Якщо НЕМАЄ — сам DTO неповний (треба include `<account>.currency.code` у list() + проброс у mapper). (3) UI: суфікс — функція від коду (`currencySuffix(code)`), а не літерал? Money-invariant окремо: `amount` МУСИТЬ лишитись у валюті рахунку, `amountBase` — окремо у base; currency-fix чіпає ЛИШЕ відображення, ніколи не конвертує amount.

**Підхід до фіксу:** DTO — include `bankAccount.currency.{code}` у list()-запиті → mapper `<field>CurrencyCode: row.<acc>.currency?.code ?? null`; hook-тип + UI: гелпер `currencySuffix(code) = !code || code==='UAH' ? '₴' : code` (₴ лише де base гарантовано UAH або код невідомий/історичний). Дзеркалити у ВСІХ місцях показу тієї суми (список + match/detail-модалка). Тести: API-mapper (USD→'USD' + assert money-invariant: amount у валюті рахунку, amountBase окремо; UAH→'UAH'; null-join→null); web-component (₴ для UAH/null, код для USD/EUR + negative «не N ₴»).

**Severity:** MEDIUM (user-visible фінансова дезінформація на не-UAH рахунку; stored money-invariant НЕ corrupt — amount/amountBase коректні, страждає лише символ). LOW для орг без мультивалюти (не тригериться). Regression-guard обов'язковий: без тесту майбутній рефактор мовчки поверне літерал.

**Де шукати ще:** будь-який список/модалка/PDF-рядок що показує суму з source-рахунку довільної валюти: payments (Payment.currencyId), settlements/transactions (amount у валюті операції + amountBase), cash-operations (CashOperation.amountBase+rateUsed), invoice/PO-рядки з `currencyId`. Крос-чек із Bug #629 (сире money) і #743 (export дропає валюту) — цей додає третій вимір: **on-screen СИМВОЛ хардкоджений** попри мультивалютний backend. Кожна фіча що додає `currencyId`/`amountBase` у row → аудит УСІХ display-суфіксів тієї суми, не лише експорту.

> Формат нижче: **Сигнал** (як знайти, з grep) / **Фікс** / **Severity** / **Де ще**. Старіші розлогі записи стиснуто до цього ж вигляду; усі bug-номери, grep-детектори та ❌/✅ приклади збережено.

### 2026-09-16 — Multi-request submit: header-idempotency-ref рятує шапку, дочірні рядки ре-постяться на ретраї → задвоєна сума (Bug #755) — frontend / partial-failure-retry / гроші / HIGH

**Сигнал:** документ пишеться кількома послідовними запитами (POST шапка → N× POST `/:id/lines` → DELETE видалених) і submit-handler має idempotency-ref ЛИШЕ на шапці (`createdInvoiceRef`/`createdIdRef`, виставляється після await першого POST). При обриві на K-му дочірньому запиті і повторному кліку список рядків для POST щоразу перебудовується з форми (`collectLines()`/`getValues('lines')`/RHF-масив) → уже-збережені рядки #1..#K-1 ре-постяться (бек `addLine`/`createLine` без dedup створює новий рядок на кожен POST) → `recalcTotals` роздуває `amount`. tsc/unit/review зелені: happy-path (без обриву) POST-ить кожен рядок рівно раз; існуючий double-submit-guard (`savingRef`) закриває ЛИШЕ concurrent same-tick, НЕ retry-після-обриву. Хибний сигнал безпеки — коментар у loop «видаляємо зі state після успіху» БЕЗ коду, що прибирає рядок (мутація локального `remaining.shift()` не рахується, форма незмінна); відповідь POST нового рядка відкидається (`id` не захоплюється) → на ретраї рядок усе ще без `id` → знову у `.filter(l => !l.id)`.
**Виявлення:** `grep -rn "createdInvoiceRef\|createdIdRef\|created.*Ref" apps/web/src/components/ui/*Modal.tsx` → для кожної multi-request модалки перевірити чи line-POST-loop звіряється з per-row «уже збережено» ref. Ручна перевірка: у `handleCreate`/`handleSave` line-loop бере ВСІ рядки з форми і НЕ має skip-умови per-row → gap. DELETE-шлях безпечний ЯКЩО після кожного DELETE є `initialLineIdsRef.delete(id)` (інакше retry 404-ить видалений).
**Фікс:** `postedLineKeysRef: Set<string>` — стабільний `_key` per-line (nextKey() при load/append/flush; входить у form-line-схему); loop пропускає рядок, чий `_key` уже у сеті, і додає `_key` ПІСЛЯ успішного POST; ref скидається при open і після повного успіху submit. Не міняти DELETE-шлях, якщо він уже `initialLineIdsRef.delete`-ить.
**Severity:** HIGH для фінансово-облікових документів (Invoice/PurchaseOrder/StockDocument/WorkOrder — задвоєна сума/борг); MEDIUM інакше. Регресія-guard ОБОВ'ЯЗКОВО дискримінує: mock reject 2-го line-POST → після повторного кліку рівно N line-POST (не N+1); revert skip → FAIL «expected 3 to be 2», fix → PASS.
**Де ще:** усі split-flow submit-модалки «create header → attach N items окремими запитами»; парне з double-submit-guard (Bug #630) — це ДВА різні механізми (savingRef проти same-tick; postedLineKeysRef проти retry-після-обриву), потрібні ОБИДВА. Backend-паралель: якщо додаєте idempotency на дочірні POST — `Idempotency-Key` per-line, не per-document.

### 2026-09-16 — class-validator→ZodValidationPipe міграція губить per-field validator → Prisma-типізована колонка недовалідована (Bug #753/#754) — backend / validation-parity / i18n / MEDIUM

**Сигнал:** контролер переходить з `@Body() dto: XDto` (class-validator) на `@Body(new ZodValidationPipe(xSchema))`, а спільна zod-схема мапить поле generic-хелпером (`optionalString()`) і **втрачає точковий валідатор старого DTO**. Небезпечно коли Prisma-колонка НЕ `String`: `DateTime?` (був `@IsDateString()`) як `optionalString()` → `'not-a-date'` проходить схему → `prisma.update({data})` → `PrismaClientValidationError` = **500 замість локалізованого 400** (CLAUDE.md #16/#17); `Int`/`Float` з бізнес-діапазоном (був `@Min/@Max` або HTML `min=/max=` у формі) без `.min/.max` → `year:999999`/`-100` у БД. tsc/unit/review зелені: типи `string|number` збігаються, happy-path з DatePickerInput/number-input дає валідні значення — брехня лише на битому/сирому вводі (raw API, malformed client-стан, mobile/sync). Тут: `vehicleBaseShape` — `insuranceExpiry`/`inspectionExpiry` (DateTime?) як `optionalString()` → 500; `year` як `optionalInt()` без діапазону (стара форма мала `min=1900 max=2100`).
**Виявлення:** для КОЖНОГО `ZodValidationPipe(<schema>)` у контролерах — знайти вихідну схему і звірити КОЖНЕ поле проти Prisma-типу колонки (`grep "<field>" schema.prisma`): `DateTime?`-поле у схемі як `optionalString()` = gap; числове з реальним діапазоном (year/percent/rating/mileage) без `.min/.max` = gap; поле що було `@IsEnum` а стало вільний `optionalString()` = gap. Крос-чек зі старим DTO/формою: `git show <pre-migration-commit>:...dto.ts` / `PageClient.tsx` — які `@IsX`/HTML `min=/max=` існували і чи є zod-дзеркало. Node-probe (shared без vitest — збирати `dist/cjs` і `require`): `schema.safeParse({<dateField>:'not-a-date'})`→має бути FAIL; `safeParse({<yearField>:'999999'})`→FAIL; `safeParse({<dateField>:''})`→OK з полем undefined.
**Фікс:** спільний хелпер у `packages/shared/src/schemas/validators.ts`: `optionalDateString()` = `preprocess(emptyToUndefined, z.string().refine(v=>!Number.isNaN(Date.parse(v)),'Невірний формат дати').optional())`; `optionalYear()` = `preprocess(emptyToUndefined, z.coerce.number().int().min(1900).max(new Date().getFullYear()+1).optional())`. Замінити generic-хелпер у baseShape. Регресія: contract-spec у web-suite (shared без власного vitest) — bad-date→FAIL, valid ISO/`YYYY-MM-DD`→OK, empty→undefined, out-of-range year→FAIL; mutation — повернути `optionalString()`→тест червоний.
**Severity:** MEDIUM (500 + втрата 400-контракту українською); LOW якщо лише діапазон-якість даних без 500.
**Де ще:** КОЖЕН контролер мігрований на ZodValidationPipe (counterparties/vehicles + наступні хвилі); особливо `*Expiry`/`*Date`/`startDate`/`documentDate` (date-поля), `year`/`percent`/`rating`/`deferDays`/`mileage`-cap (bounded-int), будь-яке колишнє `@IsEnum`-поле що стало вільний рядок. Парне з Bug #283 (optional numeric DTO без type-decorator) — той самий клас «поле проходить бо валідатор відсутній», але корінь тут — саме ВТРАТА валідатора при міграції шару валідації.

### 2026-09-14 — side-effect доданий на ОДИН шлях до термінального стану, пропущений на ДРУГОМУ FSM-шляху (Bug #745) — backend / terminal-state-second-path-gap / MEDIUM-HIGH

**Сигнал:** фіча вішає side-effect (realized FX, бали, бонус, авто-документ, повідомлення, аудит) на «X досяг статусу S» і реалізує лише в ОДНОМУ шляху (напр. `payments.service.create()`→invoice PAID), але S досяжний ЩЕ й через `X.service.transition(S)` (ручний FSM-перехід), bulk/import, cron. Другий шлях фічу не отримав → інваріант тихо порушено (tsc/unit/review зелені — дивляться шлях-1). Тут: FX-хук лише у payments.service; `invoices.service.transition(PAID)` (Bug #675 mirror-PAYMENT) курсову різницю не визнавав → іновалютний standalone з частковими оплатами + ручний PAID лишав base-залишок Σчасткові×(r_doc−r_pay)≠0. Друга точка часто предок фічі → поза diff-scope.
**Виявлення:** знайти ВСІ writer-и статусу S: `grep -rn "status:\s*['\"]?TARGET\|status:\s*<Enum>\.TARGET\|newStatus\s*===?\s*['\"]?TARGET" apps/api/src/modules --include=*.service.ts | grep -v spec` — кожен мусить емітити side-effect або мати причину. Крос-чек `<X>_TRANSITIONS`: кожен ручний `transition(S)` — кандидат-пропуск. Money: «чи balance зводиться до 0 якщо S досягнуто ІНШИМ шляхом?».
**Фікс:** дублювати side-effect на другий шлях (з idempotency count-guard на джерело + skip-умовами) АБО спільний хук для обох. Регресія: тест на КОЖНОМУ шляху + перевірка інваріанта; mutation — вимкнути хук шляху-2 → падає.
**Severity:** MEDIUM-HIGH (HIGH якщо corrupt stored balance без cap).
**Де ще:** WO COMPLETED (transition+bulk), invoice PAID (payments+transition+overdue-processor), PO RECEIVED, payment fiscal QUEUED, loyalty, авто-архівація. Парне #733/#688.

### 2026-09-13 — journal-row колір фарбується за ТИПОМ-Set, розходиться зі знаком записаної кількості (Bug #738) — frontend / journal-sign-vs-type-color-drift / MEDIUM

**Сигнал:** плоский журнал (StockMovement/cash/settlements/ledger) де рядок несе ЗНАКОВУ величину (`quantity`/`amount`, +прихід/−витрата) + колір через `const INCOMING/OUTGOING = new Set([...types])`+`.has(m.type)`. Type-Set дрейфує зі знаком: (а) `RESERVATION` зберігається ДОДАТНІМ (createMovement вимагає qty>0) але у OUTGOING → додатнє `5` червоним; (б) нові enum (`RESERVATION_RELEASE` від'ємний, `TRANSFER` обидві ноги) поза Set → від'ємне нейтральним; (в) коментар над Set уже суперечить коду. Детектор: компонент має І сире знакове число (`{m.quantity}`/`{fmtMoney(m.amount)}`) І `Set([...]).has(m.type)` для кольору. Grep: `grep -rnE "new Set\(\[[^]]*(RECEIPT|WRITEOFF|RESERVATION|TRANSFER|CHARGE|PAYMENT)" apps/web/src/**/*.tsx`. Знакова конвенція backend (createMovement/createTransaction) — інша вісь правди, тип не мапиться 1-в-1 на знак.
**Фікс:** фарбувати СТРОГО за знаком: `incoming=v>0`, `outgoing=v<0`, `=0` нейтрально — стійко до нових enum. Виняток: колір НАВМИСНЕ ≠ знак (settlements: CHARGE +до балансу але «борг»→червоний) → Set легітимний, але shared-import+cross-layer guard (#715), не локальний літерал. Регресія mutation-verified: рядок кожного знаку × проблемного типу (RESERVATION+, RESERVATION_RELEASE−, TRANSFER±) → assert за знаком; revert до type-Set → падає.
**Severity:** MEDIUM (HIGH якщо грошовий знак у ledger/export/PDF).
**Де ще:** cash-operations (колір за `direction` — ОК), settlements-tx (type-Set навмисний — перевірити shared-import), будь-який journal/ledger UI з sign-column. Парне #715 (drift від shared-константи), #705 (test-fixture-копія).

### 2026-09-13 — інверсія арифметичного оператора (`/`→`*`) лишає застарілі коментарі-обґрунтування у ІНШОМУ шарі (Bug #737) — frontend / stale-comment-after-operator-inversion / LOW

**Сигнал:** commit інвертує семантику доменного множника/дільника (`qty/coeff`→`qty*coeff`, rate, VAT-дільник, знижка) — арифметику й backend-коментарі оновлено, АЛЕ коментарі-обґрунтування guard-ів у ІНШОМУ шарі (frontend/mobile/shared) лишились зі старою семантикою («divide-by-zero»/«Infinity»/«дільник»). Guard часто ще коректний (`coeff<=0` валідний і для множника) → tsc/тести/review зелені, брехливий лише коментар. Тут: T25 пропустив 2 frontend guard-коментарі у `catalog/UnitsTab.tsx`. Grep ПІСЛЯ будь-якої інверсії оператора по ВСІХ шарах (не лише diff): `grep -rn "divisor\|divide-by-zero\|Infinity\|дільник\|/ *coeff\|qty */ *co" apps packages --include=*.ts --include=*.tsx | grep -iE "coeff|qty_base|base" | grep -iv "множник\|multiplier\|\* *coeff"` — збіг поза diff = кандидат застарілий.
**Фікс:** переписати коментар під нову семантику; логіку не чіпати якщо коректна. Коментар-only (без тесту), але переконатись що guard дійсно коректний під нову формулу.
**Severity:** LOW (MEDIUM якщо застарілий коментар «виправдовує» тепер-НЕкоректний guard — вже логічний баг).
**Де ще:** будь-яка інверсія доменного оператора з наміром у 2+ шарах: coefficient (fixed), currency rate, VAT `/1.2` vs `*0.2`, знижка, half-away-rounding напрям. Парне #715 (frontend дублює backend-модель; тут — backend-намір у коментарі).

### 2026-09-12 — restore() вузла ієрархії з soft-deleted батьком лишає його сиротою (невидимим у buildTree) (Bug #734) — backend / restore-orphan-after-cascade / HIGH

**Сигнал:** self-relation дерево (`parentId`→self, `remove()` каскадить soft-delete нащадків через `getDescendantIds`). Парний `restore(id)` відновлює ЛИШЕ цей рядок (`updateMany({id},{deletedAt:null})`) не чіпаючи `parentId`. Restore однієї дитини після каскадного remove лишає `parentId` на все ще soft-deleted батька → `findAll`(deletedAt:null) читає дитину не батька → `buildTree(items,null)` не покаже ні коренем (parentId≠null) ні під батьком (батька нема) → **стаття зникає з UI, існує в БД, некерована**. tsc+unit зелені (мокають single-row restore). Grep: `grep -rn "async restore" apps/api/src/modules/**/*.service.ts` → на self-relation-моделі перевірити re-parent-логіку.
**Фікс:** у restore перевірити чи батько живий (`findFirst({id:parentId, deletedAt:null})`); мертвий/відсутній → відновити коренем (`parentId:null`, детермінований fallback). Регресія: 2 тести (батько видалений→parentId=null; батько живий→data без parentId).
**Severity:** HIGH (дані зникають з UI без помилки).
**Де ще:** усі self-relation з каскадним soft-delete+restore: `WorkCategory`, `GoodCategory`, `ExpenseCategory` (fixed), будь-який `*Category`/`*Node`/`*Tree` з `parentId`. Парне Bug #373 (інверсія: remove не каскадить).

### 2026-09-12 — reference-time guard приймає посилання на вимкнений (isActive=false) довідниковий запис (Bug #735) — backend / inactive-reference-guard / MEDIUM

**Сигнал:** сервіс валідує FK на довідник ПЕРЕД записом операції ЛИШЕ на `deletedAt:null` (+бізнес-guard) але НЕ на `isActive`. Довідник має toggle-active, фронт ховає вимкнені у select, але пряме API (mobile/sync/curl/застарілий кеш) приймає вимкнутий запис → операція посилається на «архівований» довідник → спотворює звітність. Тут: `cash.createOperation` брав `expenseCategory.findFirst({deletedAt:null})` без `isActive`. Grep: `grep -rn "findFirst.*deletedAt: null" apps/api/src/modules/**/*.service.ts | grep -iE "Category|Method|Config|Rate|Template|Account"` → для lookup довідника з `isActive` у create нової операції перевірити відхилення `!isActive`.
**Фікс:** select += `isActive`, 400 «X вимкнено — оберіть активний» ЛИШЕ на шляху нової операції (історичні недоторкані). ⚠️ оновити наявні мок-lookup у специ (додати `isActive:true`) — новий guard читає поле, якого мок не давав → undefined → хибний блок. Регресія: «isActive=false → 400, .create не викликано».
**Severity:** MEDIUM (HIGH якщо запис маршрутизує гроші — рахунок/податкова ставка).
**Де ще:** споживачі `*Category`/`PaymentMethodConfig`/`TaxRate`/`NotificationTemplate`/`SettlementAccount` з `isActive` у create: cash (fixed), payments (payment-method), payroll, invoices (tax-rate).

### 2026-09-11 — документ ЗБЕРІГАЄ джерело руху (cashRegisterId/bankAccountId/warehouseId) але при провід-переході НЕ створює сам рух → guard оминається за пропуском (Bug #733) — backend / stored-source-but-no-movement / HIGH

**Сигнал:** guard живе у ЄДИНІЙ точці руху (createOperation/createTransaction/createMovement), grep «прямий bypass» (§1.1) чистий — але документ зберігає FK-джерело (`cashRegisterId`/`bankAccountId`/`warehouseId`) і при `confirm/pay/post` пише ЛИШЕ похідний settlement, а первинний рух джерела — НІ. Тут: `SupplierPayment.confirm()` для CASH_REGISTER писав settlement але не `cash.createOperation(OUT)` → готівка не залишала касу + overdraft-guard мертвий. Enum `CashOperationReason.SUPPLIER_PAYMENT` — сирота, ніхто не пише. Детектор: для моделі з FK на register/account/warehouse — чи confirm/pay/post РЕАЛЬНО кличе createOperation/createMovement для ЦЬОГО джерела; крос-чек — enum-reason/movement-type який НІХТО не пише (`grep -rn "REASON_X" --include=*.ts` дає лише визначення = сирота). ⚠️ unit-специ зелені (мокають лише settlements). Live: cash-оплата при порожній касі має дати 400.
**Фікс:** рух у ТІЙ САМІЙ tx що й settlement (`cash.createOperation({direction:'OUT',reason,documentType,documentId}, tx)`) → проходить overdraft/shift-guard, нестача → 400+rollback усього. pre-tx select += поля джерела; Модуль += CashModule/InventoryModule. Регресія: «CASH→рух OUT у тій самій tx»+«overdraft→rejects не проковтнуто»+«BANK→без руху каси».
**Severity:** HIGH (CRITICAL якщо джерело — фіскальна каса/склад під нестачу).
**Де ще:** документи з FK-джерелом на окремому FSM-кроці: `SupplierPayment` (fixed), Payment REFUND cash-out, transfer/write-off акти з warehouseId, будь-який акт/ордер де source-FK на create, рух на confirm. Парне §1.1 «єдина точка руху» (той grep — ПРЯМИЙ bypass, цей — bypass ЗА ПРОПУСКОМ). Парне #688.

### 2026-09-11 — write-time guard перевіряє «є конфіг/креди» ІНАКШЕ ніж runtime-резолвер → приймає нерезолвабельну прив'язку (Bugs #731/#732) — backend / guard-resolver-semantics-divergence / MEDIUM

**Сигнал:** write-guard («провайдер/рахунок налаштований?») перевіряє полегшено, а runtime-резолвер X — суворіше. Тут: `cash-registers.assertFiscalProvider` робив `if (!cfg || !cfg.credentials)` — `credentials` це JSON-рядок, тож `"{}"`/`'{"k":""}'`/`"null"`/битий — truthy → пропускав; але `resolveByCode` вживає `hasCreds(parseCreds())` → повернув би null → чек навічно QUEUED (тихий збій). Родич #732: guard кидав 400 на легітимному «вимкнути фіскальну касу» (isFiscal→false лишав provider) замість авто-реконсиляції. Grep: `grep -rn "assert[A-Z][A-Za-z]*Provider\|assert[A-Z][A-Za-z]*Config\|!.*\.credentials\b" apps/api/src/modules/**/*.service.ts | grep -v spec` → знайти ПАРНИЙ резолвер (`resolve*`/`hasCreds`/`parse*`) і звірити 1-в-1; підозра коли одна гілка читає raw JSON-truthiness, інша парсить.
**Фікс:** guard дзеркалить семантику резолвера — спільний хелпер (`hasUsableCredentials`/`parseCreds`) або виклик самого резолвера. Для «вимкнули feature» — авто-очищати залежні поля у write (`data.provider=null` коли `!isFiscal`), не throw. Регресія: unit з пограничними конфігами (`"{}"`/порожні/битий JSON→400; валідний→pass).
**Severity:** MEDIUM (HIGH якщо блокує гроші/фіскальне зобов'язання без видимої помилки).
**Де ще:** payment-gateways (`assertGateway`/resolveActive), fiscal-providers activate (`hasCreds` вже спільний ✅), delivery-провайдери, notification-канали (token guard vs send-resolver), будь-яка `@unique` FK-прив'язка де write перевіряє існування рядка а use — придатність.

### 2026-09-11 — публічний/unauth endpoint читає tenant-scoped модель без `runUnscoped` → fail-closed guard кидає 500 (Bug #730) — backend / public-endpoint-tenant-guard-500 / HIGH

**Сигнал:** `@Controller`-метод БЕЗ `@UseGuards(JwtAuthGuard)` (booking-віджет, share-token, `/setup`, webhook) читає tenant-scoped модель (TENANT-список `prisma.service.ts`, поза `TENANT_EXEMPT_MODELS`) з where без `orgId`/`branchId` → `$extends` tenant-guard кидає `TenantIsolationError` → **500 на кожен запит**. Тут: `BookingController` кличе `booking.service.findBranchForBooking` що робить `prisma.garageBranch.find*({where:{deletedAt:null}})` без orgId/runUnscoped (без JWT `orgId=undefined`, а orgId резолвиться саме з branch-запиту — курка-яйце). ДЗЕРКАЛО #721 (там guard хибно ПРОПУСКАВ; тут правомірно КИДАЄ, але caller забув `runUnscoped`). Grep: `grep -rLn "UseGuards" apps/api/src/modules/**/*.controller.ts` → у public знайти `prisma.<tenantModel>.find*` без orgId. Live curl > grep: public GET/POST → 500 + лог `TenantIsolationError`. ⚠️ Мок-Prisma unit НЕ ловлять (не проганяють $extends) — spec зелений попри 500 у проді.
**Фікс:** обгорнути легітимний глобальний read у `runUnscoped(async () => await this.prisma...)`. **`await` УСЕРЕДИНІ scope критичний** — lazy `PrismaPromise` назовні (`runUnscoped(() => prisma.find(...))`) НЕ працює: DB-виклик+guard-hook виконаються ПІСЛЯ виходу з ALS-scope → bypass втрачено. Регресія: E2E/contract на кожен public endpoint (200+тіло).
**Severity:** HIGH (публічна фіча мертва); CRITICAL якщо checkout/оплата/share.
**Де ще:** усі `@Controller` без `JwtAuthGuard` до tenant-моделей — booking (fixed), setup-status, публічний прайс/каталог, share-token, webhook що резолвлять org з payload. Парне #721 (guard-side).

### 2026-09-11 — query-хук фаєрить роль-обмежений GET бо `enabled` не гейтиться роллю (UI-видимість гейтнули, fetch — ні) (Bug #729) — frontend / role-gated-fetch-not-gated / MEDIUM

**Сигнал:** компонент видимий нижчій ролі (`roles` включає RECEPTIONIST/MECHANIC, або prop `canOperate=false`) кличе `useQuery`-хук БЕЗ `enabled`-гейта до ендпоінта чий `@Roles` вимагає ВИЩУ роль. Тут: `CashOperationsTab` (видима RECEPTIONIST) безумовно кличе `useExpenseCategories()`, а `GET /expense-categories`=`@Roles(OWNER/ADMIN/ACCOUNTANT)` → 403 на кожен перегляд (×2 через `retry:1`). Дані лише в недоступній модалці → нема банера → tsc/unit/review зелені, але 403-шум+Sentry. Grep: `grep -rnE "use[A-Z][A-Za-z]*\(\)" apps/web/src/app --include="*.tsx" | grep -vE "enabled|useState|useAuth|useRouter|useEffect|useMemo"` → для компонентів з `canOperate/canManage`-prop звірити @Roles; `grep -rnE "@Roles\('OWNER'" apps/api/src/modules --include="*.controller.ts" | grep -vE "RECEPTIONIST"` → «висока роль» ендпоінти. Принцип: гейтити сам fetch (`enabled`), не лише UI-споживач. Live: DB-flip `employee.role=RECEPTIONIST`→login→curl→403 (JwtStrategy бере роль з БД, форжений токен не спрацює).
**Фікс:** `enabled`-параметр у хук (`useX(showDeleted=false, enabled=true)`→`useQuery({...,enabled})`) + передати рольовий prop (`useExpenseCategories(false, canOperate)`). Регресія: component-тест `toHaveBeenCalledWith(..., <roleProp>)` для обох гілок; mutation — прибрати гейт → червоніє.
**Severity:** MEDIUM (403-шум, не витік). LOW якщо кешується/тихий; HIGH якщо помилка хука рендериться банером/toast для viewer.
**Де ще:** `useLowStockItems` у dashboard (той самий патерн, TODO); будь-який `*Tab`/`*Panel` з рольовим prop що кличе довідниковий хук (`useEmployees`/`useBankAccounts`/`useSettings`) з вужчим @Roles ніж контейнер.

### 2026-09-11 — новий тип discriminated-union/enum доданий у backend+read-модель, але WRITE-форма його не підтримує (Bug #728) — frontend / feature-write-path-incompleteness / HIGH

**Сигнал:** backend Zod `z.discriminatedUnion('type', [...])` (або enum) отримав НОВИЙ варіант; калькулятор/сервіс/preview/read-DTO/labels-мапи всі його підтримують — але create/edit **модалка** (write-форма) — ні. Тут: `rateSchemeSchema` має 3 режими (`percent_normo`/`per_normo_hour`/`fixed_plus_bonus`), калькулятор рахує всі 3, `/payroll` та `/employees` мають мітку «Ставка × нормо-год» — а `EmployeeEditModal` не мав `per_normo_hour` у списку схем, у `buildRateScheme()`, в edit-гідрації (`rs.params.ratePerHour`), ні JSX-input. Наслідок: адмін НЕ може створити співробітника з режимом, а edit наявного (створеного seed-ом/API) мовчки скидає тип на дефолт. tsc/review/тести зелені бо форма — валідний підмножинний union. Grep: порахувати `z.literal('...')` у backend dto → звірити з гілками `build*Scheme`/`=== '...'`/LABELS-мапою у модалці (§1.3 grep Bug #728). Живий доказ: `POST /employees` з payload нового типу проходить (201) — але UI не має способу його згенерувати.
**Фікс:** додати варіант у всі 5 точок модалки (LABELS-мапа, EMPTY_FORM, edit-гідрація, build-функція гілка+валідація, JSX-input). READ-шлях повний, WRITE-форма — окремий файл, легко забути, компілятор не сигналить (union-підмножина валідна). Регресія-guard: тест модалки що для кожного backend-варіанта рендерить input і будує коректний payload (revert гілки → червоний).
**Severity:** HIGH (нова можливість недоступна з UI; edit носія губить тип). MEDIUM якщо варіант рідкісний.
**Де ще:** будь-яка модалка що будує discriminated-union payload (`build*Scheme`/`build*Config`, платіжні методи, notification-канали, tax-rate, document-number) після нового enum-варіанта у backend. Парне #401/#432 (там FE/BE status whitelist symmetry; тут write-form completeness).

### 2026-09-10 — кешований `_count.<junction>` завищений: junction без deletedAt, parent soft-delete-иться (Bug #723) — backend / count-accuracy-through-junction / MEDIUM

**Сигнал:** aggregate-лічильник «скільки X мають Y» на M:N довіднику через `_count: { select: { <junction>: true } }` (`CounterpartyStatus.counterpartyCount`, `Tag.usageCount`). Вірний на assign (spec мокає `_count`), завищується після soft-delete батька: junction зазвичай БЕЗ `deletedAt` і не прибирається при `parent.remove()` (link лишається навмисно — restore відновлює) → рахує «мертві» link-и. Grep: `grep -rnE "_count: \{ select: \{ [a-zA-Z]+: true \}" apps/api/src/modules/**/*.service.ts` → для relation на junction чиї parent soft-delete-яться. Live: assign→count=1, `DELETE /parent` (soft, 204)→має стати 0.
**Фікс:** `<rel>: true` → фільтр через parent: `_count: { select: { links: { where: { <parent>: { deletedAt: null } } } } }` (Prisma 5 filtered `_count`; патерн у purchase-orders/stock-documents/supplier-returns з `lines: { where: { deletedAt: null } }`). Винести у спільну `COUNT_INCLUDE`-константу (findAll/findOne/create/update/restore однаково). Регресія: spec асертить фільтрований include (revert до `links: true` → червоний).
**Severity:** MEDIUM (HIGH якщо керує білінгом/лімітом/квотою).
**Де ще:** усі M:N довідники з `<parent>Count`/`usageCount`/`itemCount` де junction без `deletedAt`; будь-який `_count.<rel>: true` на relation до soft-deletable. Дзеркальний до `lines: { where: { deletedAt: null } }` (там junction сам має deletedAt).

### 2026-09-11 — кешований filtered-`_count` розсинхронізується від мутації РІДНОЇ сутності що зсуває поле-фільтр (не самого link) (Bug #725) — backend / cache-coherency-across-aggregates / MEDIUM

**Сигнал:** прямий сіблінг #723. Фікс #723 (filtered `_count`) вводить приховану залежність кешованого `findAll` (`ref:<x>:<orgId>`, TTL 300с) від `<parent>.deletedAt`. `goodCount` залежить від ДВОХ осей: (1) сам link (assign/unassign — уже кличуть `invalidateCache`); (2) `<parent>.deletedAt` — фліпають `GoodsService.remove()/restore()` (інший сервіс!), що про кеш не знають. Live: assign→goodCount=2; `DELETE /goods/:id` (soft,204)→`GET /good-statuses` ЛИШАЄ 2 (DB=1) до TTL. Легко пропустити (свіжий не-кешований запит показує правду) — читати В МЕЖАХ TTL без проміжної статус-CRUD. Grep: `grep -rn "invalidateCache\|ref:.*:\${orgId}" apps/api/src/modules/**/*.service.ts` → для кешованого filtered-`_count` перелічити ВСІ операції що зсувають поле-фільтр (assign, unassign, **parent.remove, parent.restore**, hard-delete/merge) — кожна МУСИТЬ інвалідувати.
**Фікс:** приватний `invalidate<X>CacheIfLabeled(orgId, id)` у parent-сервісі — після remove/restore перевірити `<junction>.findFirst({orgId,<parentId>})`; є link → `<statuses>.invalidateCache(orgId)` (guard уникає churn на parent без міток). Регресія: «parent з міткою→кличе», «без→ні»; mutation — прибрати виклик → червоніє.
**Severity:** MEDIUM (вікно до TTL=300с; HIGH якщо гейтить білінг/ліміт).
**Де ще:** counterparty-statuses — ТОЙ САМИЙ латентний баг у `counterparties.remove/restore`; будь-який `ref:*`-кеш чиє значення з filtered-`_count`/aggregate де фільтр залежить від поля яке мутить ІНШИЙ агрегат. Принцип: кешований похідний лічильник інвалідувати з КОЖНОЇ осі входів.

### 2026-09-10 — refactor-extract «byte-identical» переносить happy-path покриття, але лишає edge-throw/division-fallback без ПРЯМОГО тесту + tenant-fix перевірений лише unit-mock (A3 e8ae4d70) — backend / coverage-gap-after-extraction / MEDIUM

**Сигнал:** commit `refactor(...extract)`/`винести у <NewService>` byte-identical. Happy-path тести лишаються зеленими, АЛЕ захисні гілки перенесеного методу тихо без прямого тесту (ніколи не було, або в іншому describe що не переїхав). Два класи: (1) **edge-throw** (`if (chargeAmount<=0) throw` на COMPLETED) — жодного тесту хоча return-дзеркало мало zero-total-тест; (2) **division-by-zero fallback** (`safeCoeff(coeff)` проти coeff=0) — конверсія тестувалась лише coeff≠0. Плюс: **tenant/guard-фікс у перенесеному private-хелпері** (`goodUoM.findMany`+orgId) — юніт-mock НЕ виконує $extends-guard, «фікс перевірено» = лише mock-shape-assert. Аудит після extract: `git show <sha> --stat` → у новому `.service.ts` знайти `throw`/`safeCoeff`/`?? `/`/ coeff`/`Number.isFinite` → чи кожна має прямий тест у `<new>.service.spec.ts`? Покриття по РЯДКАХ що виконались, edge-рядки виконуються лише на специфічному вході.
**Фікс:** mutation-verified unit на кожну незакриту гілку (edge-throw: невалідний вхід→throw+ефект НЕ стався; fallback: coeff=0→baseQty скінченне не Infinity/NaN) + для guard/tenant-фіксу ІНТЕГРАЦІЙНИЙ тест проти реального guarded-client (дзеркалить `tenant-guard.integration.spec.ts`) з mutation-baseline (revert фіксу→відтворює `TenantIsolationError: GoodUoM findMany без tenant-фільтра` наживо). Джерело не чіпати.
**Severity:** MEDIUM (майбутній тихий refactor гілок пройде CI; для tenant-фіксу без live-тесту HIGH — регресія orgId = крос-tenant/500 без падіння юнітів).
**Де ще:** A-серії God-object split (WorkOrdersService→events/stock-effects/share), витягнуті inventory/settlements-хелпери, extract у invoices/purchase-orders/stock-documents. Парне #705-#706 (mock-рівнева асерція), #429 (stale-mock після extract).

### 2026-09-10 — fail-closed tenant/authz guard рахує токен присутнім за `!== undefined` → НЕГАЦІЯ/діапазон обходить його (Bug #721) — backend / tenant-isolation / CRITICAL

**Сигнал:** fail-closed guard (`whereHasTenantScope`, RBAC where-injector, soft-delete-фільтр) вирішує «where несе токен» за ПРИСУТНІСТЮ ключа (`obj[t]!==undefined`/`t in where`/`!!where[t]`), не за ФОРМОЮ значення. Prisma-токен не лише скаляр рівності — `{not:X}`/`{notIn:[...]}`/`{gt/gte/lt/lte}`/`NOT:{orgId:X}`/`{orgId:null}` (null≠undefined) проходять «ключ присутній» але СЕМАНТИЧНО матчать ЧУЖІ рядки (негація orgId = всі інші tenant) → guard тихо обходиться. Частина-(2): «composite-key scan» трактувала `NOT` як composite-ключ з orgId. Grep: `grep -rnE "!== undefined|\bin\b .*where|Object\.keys\(where\)" apps/api/src/**/*guard*.ts *tenant*.ts` → чи розрізняє позитивну рівність від негації; чи виключає AND/OR/NOT з composite-scan. Mutation-проба: `whereHasTenantScope({orgId:{not:'x'}})`/`({NOT:{orgId:'x'}})` → `true` = leak.
**Фікс:** `isPositiveTenantBinding(v)` — scalar true; `{in:[non-empty]}`/`{equals:scalar}` true; `{not}`/`{notIn}`/діапазон/`null`/`{in:[]}`/невідома → false (fail-closed); composite-scan skip `{AND,OR,NOT}`; зберегти легіт cross-org `{token:{in:[...]}}`. Regression: unit-матриця (leak-форми→throw, positive→pass) mutation-verified + live-DB integration (мокнуті юніти НЕ виконують екстеншн).
**Severity:** CRITICAL (крос-tenant leak; латентний — тригериться майбутнім негованим orgId-фільтром).
**Де ще:** RBAC branch-guard, soft-delete-guard, org-scoped-cache-key builder; будь-де `NOT`/`{not}` торкається tenant/authz-поля. Парний gap: integration-spec без delete/deleteMany/groupBy/upsert-throw кейсів (gap #722 — кожна операція GUARDED_WHERE_OPS має live-покриття).

### 2026-09-09 — perf-звужений `select` reused як audit old-snapshot → фейкові «поле→undefined» diff + audit arg test-gap (Bug #719 / gap #720) — backend / audit-integrity + test-coverage / MEDIUM

**Сигнал:** `service.update()` перечитує `existing` через оптимізований `select:{id,...guard-поля}`, потім передає ВЕСЬ `existing` як old-data у `audit.record(..., existing, dto)`. `buildDiff` порівнює old∪next → поля що є в existing але не в частковому PATCH-dto дають `{from:val, to:undefined}` → аудит ХИБНО стверджує очищення (+`id` завжди спурйозний). ІНВЕРСІЯ #433 (там пропускав, тут пише ЗАЙВІ). Grep `audit.*\.record\([^)]*existing` по `*.service.ts` → (а) existing-select містить id/поля поза dto? (б) old обмежено `Object.keys(dto)`? Test-gap #720: money-critical inline-audit (pricing-rules, TaxRate) має `AuditService` замоканим без arg-assert → тихий refactor ламає аудит; `grep -rln "provide: AuditService" **/*.spec.ts` → чи є `expect(...record).toHaveBeenCalledWith`.
**Фікс:** old-snapshot = перетин existing з `Object.keys(dto)` (`for(k of Object.keys(dto)) if(k in existing) old[k]=existing[k]`); existing-select розширити до повного auditable-набору. Audit-arg regression: (1) позиційні orgId/Entity/id/action/userId; (2) id з WRITE-результату → audit ПІСЛЯ write; (3) fail-path(404/count=0)→no-audit; (4) userId=undefined→no-audit; (5) record() reject НЕ ламає мутацію (best-effort). ⚠️ audit-контролер вимагає мок `req.user.id` (не лише `.sub`) — AuthenticatedUser мапить sub→id. Mutation: `Object.keys(old).toEqual([<змінене>])`.
**Severity:** MEDIUM (HIGH якщо фейкове очищення сум/платника-ПДВ/реквізитів у compliance-експорті).
**Де ще:** усі `*.service.ts` update() з перечит-existing→audit.record (counterparties fixed; invoices/work-orders/purchase-orders/vehicles); controller/service з inline `audit.record` без arg-assert (pricing-rules, settings, payments).

### 2026-09-09 — PowerShell installer-скрипт UTF-8-БЕЗ-BOM + кирилиця, викликаний powershell.exe 5.1 → мохібейк логів / parse-крихкість (Bug #717) — installer / runtime-encoding / MEDIUM

**Сигнал:** `installer/scripts/*.ps1` з не-ASCII (кирилиця у `Write-Log`/`throw`) БЕЗ BOM, викликається через `powershell.exe` (5.1, не `pwsh`). 5.1 без BOM читає `-File` як ANSI-codepage → мохібейк у логах Task Scheduler/Inno (за якими оператор офлайн-СТО діагностує); за крок від парс-краху. Детектор: `for f in installer/scripts/*.ps1; do head -c3 "$f"|xxd -p|grep -q efbbbf || echo "NO-BOM: $f"; done` + `grep -rn "powershell.exe\|pwsh" installer/**/*.iss installer/scripts/*.ps1` (powershell.exe → 5.1). Live: `Р’С–РґРєР°С‚` замість `Відкат` у логах.
**Фікс:** перезаписати всі скрипти з **UTF-8 BOM** (`New-Object System.Text.UTF8Encoding($true)`), контент незмінний. Калібрування: кирилиця лише в логах = MEDIUM; у `Set-Content`/`Out-File`-ЗНАЧЕННЯХ (пише у .env/DB), у `-eq`/`-match`-порівняннях (логіка), у ScheduledTask-НАЗВАХ (task не знайдеться) = HIGH. Mutation: без BOM той самий рядок через `-File` → мохібейк.
**Severity:** MEDIUM (HIGH якщо не-ASCII у persisted-значеннях/порівняннях/task-назвах).
**Де ще:** уся `installer/scripts/` suite (перевіряти ВСІ); будь-який `.ps1`/`.bat`/`.cmd` з локалізованим текстом; F2 «task-назви ASCII».

### 2026-09-09 — rollback re-pull ТОГО САМОГО плаваючого тега = no-op + rollback ігнорує exit-code → фальшивий success-лог (Bug #716) — installer / deploy-rollback / MEDIUM

**Сигнал:** rollback через `docker compose pull <image>:$prev` (`$prev` з `.env`/config). Дві пастки: (1) **плаваючий тег** — shipped-дефолт `VERSION=latest`, update без явної версії → `$prev==$target` → re-pull ТОГО САМОГО тега перетягує зламаний образ → відкату нема, лог каже «виконано». (2) **ігнорований exit-code** — `& pull; & up; Write-Log "success"` без `$LASTEXITCODE` → на офлайн-збої (pull з registry суперечить offline-first) логує успіх попри провал. Детектор: `grep -nE "Invoke-Rollback|rollback|docker compose pull" installer/scripts/*.ps1` → (а) `$prev==$target` guard? (б) `$LASTEXITCODE` після pull/up? (в) rollback тягне з registry (fail офлайн) замість `docker load` з бандлу як Setup? Звірити обіцянку task-опису з поведінкою під SHIPPED-дефолтом.
**Фікс:** same-tag guard → чесне «НЕМОЖЛИВО ВІДКОТИТИ: плаваючий тег» + інструкція + `exit 1` замість фальшивого success. `if ($LASTEXITCODE -ne 0) { throw }` після КОЖНОГО native-виклику → catch дає «ВІДКАТ ТЕЖ ВПАВ». Довгостроково: rollback тягне як forward-install (offline = `docker load` з бандлу).
**Severity:** MEDIUM (HIGH якщо продукт обіцяє unattended auto-rollback без оператора).
**Де ще:** будь-який Update/Deploy/Rollback-скрипт; `image:${VERSION:-latest}`; release.yml білдить `sto-api:$version` (immutable) але compose+`.env` дефолтять на `latest` → mismatch. Клас «обіцянка-vs-shipped-дефолт»: фіча коректна на pinned, дефолтна поставка вимикає мовчки.

### 2026-09-08 — redaction/masking min-length поріг пропускає НАЙКОРОТШИЙ реальний секрет системи (Bug #709) — security / secret-leak / HIGH

**Сигнал:** redact/mask-утиліта (`redactSecrets`/`maskToken`/`scrub`) має нижній поріг довжини (`if (s.length < N) continue;`, `>= 6`), щоб коротка підстрока не замаскувала пів-тексту. Поріг вибрано «щоб не псувати текст» БЕЗ звірки з реальною довжиною секретів → секрет коротший за поріг НЕ маскується. Тут: Checkbox `pin_code = рівно 4 цифри`, `redact:[pinCode]`, поріг `<6` пропускав → провайдер ехо-їть тіло у 4xx → PIN у `response.text()`→`Error.message`→`IntegrationLog.error` (видимий OWNER/ADMIN). Grep: `grep -rnE "length\s*[<>]=?\s*[0-9]|\.length\s*<" apps/api/src/common/utils/*redact* *mask* *scrub*` → для КОЖНОГО секрету у redact-масиві знайти реальну min-довжину (DTO/схема/фікстура) і звірити. Live: `node -e "redactSecrets('pin_code=1234',['1234'])"` — `1234` лишилось → leak.
**Фікс:** знизити поріг до реальної нижньої межі (`<3` — маскує 4-значний PIN, пропускає лише вироджені 0-2 символи). НЕ підіймати «для чистоти» — leak гірший за over-mask. `split/join` (не `new RegExp(secret)`) → спецсимволи безпечні. Регрес: секрет у ехо-body замаскований (`not.toContain(pin)`) + client-рівневий на error-шляху; mutation — revert порогу → червоний.
**Severity:** HIGH (CRITICAL якщо секрет = повний токен/пароль/ключ).
**Де ще:** будь-яка redact/mask з length-порогом; короткі секрети — PIN/OTP/CVV/short-code API-ключі/4-6-значні коди. Перевірка `split/join` vs `new RegExp(secret)` (ReDoS/crash). Пара #710 (shared-утиліта з дефолтом що не покриває крайній вхід).

### 2026-09-08 — стала ЛОКАЛЬНА копія shared-константи у тесті + мок-рівнева асерція замість real-invariant (Bug #705-#706) — test-drift / coverage-gap / MEDIUM

**Сигнал:** дві test-drift пастки лишають suite ЗЕЛЕНОЮ поки money/inventory/FSM-шлях незахищений. (1) **Stale fixture-copy:** тест визначає ЛОКАЛЬНУ копію shared-мапи (`const TRANSITIONS = {...}` дублює `@sto/shared` `WO_STATUS_TRANSITIONS`/`*_STATUSES`/badge-map) → sprint змінює shared, копія стара → нова гілка не покрита + маскує sync-gap. Grep: `grep -rnE "const [A-Z_]+\s*(:\s*Record|=\s*{)" apps/web/src/**/__tests__ apps/api/**/*.spec.ts` → звірити ключі проти shared-export (після sprint що чіпав `packages/shared/src/constants/*`). (2) **Mock-level invariant claim:** spec стверджує money/inventory-інваріант ЛИШЕ через `toHaveBeenCalledTimes/With` на ЗАМОКАНОМУ колабораторі (`batchService.returnToBatch = vi.fn()`) → реальна арифметика (Σ remainingQty==StockItem.quantity, balance net-to-zero, агрегація-по-ключу) не біжить. Детектор: усі асерції на моці + жодна не читає підсумковий стан (remainingQty/quantity/balance).
**Фікс:** (1) синхронізувати фікстуру + guard що ІМПОРТУЄ shared-export і асертить нову поведінку. (2) стейтфул integration-спек з in-memory Prisma-store (CAS `updateMany` з where-предикатом, increment/decrement, findMany-фільтр) + РЕАЛЬНІ сервіси через Nest DI → round-trip + асерт інваріанту. Mutation: відкат shared-мапи → guard падає; заміна агрегації на per-row → stateful падає а мок-тести зелені.
**Severity:** MEDIUM (HIGH якщо шлях рухає гроші/склад і нема іншого real-invariant тесту).
**Де ще:** `__tests__/*.test.tsx` з копією `*_TRANSITIONS`/`*_STATUS_*`; money-специ де Batch/Settlements/Inventory замоканий а асерції лише `toHaveBeenCalled*` (invoice from-WO, PO receive, stock-document, supplier-returns). Парне #398/#434 (contract/interface drift).

### 2026-09-09 — PRODUCTION-компонент дублює backend-похідну модель (знак/колір/статус) ЛОКАЛЬНИМ літералом без cross-layer guard (Bug #715) — frontend / silent-drift / MEDIUM

**Сигнал:** frontend-компонент фарбує/знакує доменні enum-значення ЛОКАЛЬНИМ `const X = new Set([...])`/`Record<...>` виведеним з backend-константи (`BALANCE_SIGN`, FSM-map, sign/tone-мапа), але (а) не імпортованим з `@sto/shared`, (б) без тесту що прив'язує до backend-джерела. Значення вірні на коміт (review/tsc/тести зелені), зміна backend-константи мовчки десинхронізує UI (транзакція «+» замість «−»; badge зникає). Часто дубльований на 2+ екранах → дрейф і між ними. PRODUCTION-дзеркало #705 (там test-фікстура-копія). Grep: `grep -rnE "new Set\(\[|: Record<string" apps/web/src/**/*.tsx | grep -iE "CHARGE|PAYMENT|REFUND|CREDIT_NOTE|SUPPLIER_|STATUS|BALANCE|sign|tone"` → чи є backend-джерело? імпортовано з shared чи локальний літерал? є guard?
**Фікс:** підняти канон у `@sto/shared` (`SETTLEMENT_BALANCE_SIGN` + похідні `SETTLEMENT_BALANCE_UP_TYPES`/`SETTLEMENT_TX_CHARGE_LIKE_TYPES`) + усі екрани import (compile-time guard) + cross-layer invariant-тест у backend-специ (import shared+backend, асерт 1-в-1 по кожному enum + без зайвих ключів). ⚠️ Розрізняти знак (арифметика) від кольору (бізнес-семантика) — навмисне розходяться для постач. типів (SUPPLIER_PAYMENT: sign +1 але success-колір); фіксувати обидва напрями. Mutation: інверсія знаку у shared → cross-layer червоний.
**Severity:** MEDIUM (HIGH якщо грошовий знак у export/PDF).
**Де ще:** `*_STATUS_COLORS`/`*_BADGE`/`sign`/`tone`-літерали що дзеркалять backend без shared-import; WO/invoice/PO status-badge-мапи (перевірити чи ВСІ споживачі імпортують); settlementBalanceTone. Парне #705 (test-fixture-копія), #606/#608 (backend enum-coverage).

### 2026-09-08 / 2026-09-07 — materialize-on-forward без release-on-cancel/reverse → тиха втрата бізнес-потужності (Bug #699) — backend / lifecycle-asymmetry / HIGH

**Сигнал:** sprint додає у forward-метод (`confirm()`/`approve()`/`issue()`/`activate()`) СТВОРЕННЯ дочірнього ресурсу з link-колонкою (`BookingRequest.confirmedSlotId`→`CalendarSlot`; `reservationId`; `fiscalReceiptId`). ДО спринту forward нічого не матеріалізував → cancel/reject/void/remove не мав що прибирати; спринт додає create на forward, зворотний метод незмінний → child лишається `deletedAt:null` без live-parent (блокує ліфт/склад/номер назавжди). Grep: `grep -rn "confirmedSlotId\|materializ\|\.createSlot(\|reservationId\|<link>Id" apps/api/src/modules/<mod>/*.service.ts` → forward пише link, cancel/remove ЧИТАЄ link+soft-delete child? Асиметрія (forward має `create`+`data:{linkId}`, cancel не згадує linkId/child-table) = баг. Live: `confirm`+`cancel`→`getAvailability` все ще зайнято.
**Фікс:** cancel читає link ДО скасування → в одній `$transaction` soft-delete child (`where: OR[{id:linkId},{parentSlotId:linkId}]` — покриває split-child) + скасування parent атомарно. Mutation-verified: (а) cancel БЕЗ link → child-updateMany НЕ викликано; (б) cancel З link → 1× з orgId+deletedAt:null+OR-where; (в) обидва write у одній $transaction; нейтралізувати release → (б) падає.
**Severity:** HIGH (тиха незворотна втрата потужності). MEDIUM якщо child легко перестворюється.
**Де ще:** booking↔CalendarSlot; WO↔reservation; invoice↔fiscal-receipt; будь-яка нова `<parent>.confirm/approve/issue/activate` що materializes і має парний cancel/reject/void/remove. Родина #351.

### 2026-09-07 — self-re-enqueue polling: domain-service enqueue-гілки + clamp + zombie-job без прямих тестів (Bug #696-#698) — backend / coverage-gap / HIGH

**Сигнал:** нова polling-інтеграція зовнішнього API (не webhook): (1) domain-service `create/update` enqueue при появі/зміні поля; (2) `@Processor` self-re-enqueue з delay+термінал+cap; (3) `pollDelayMs` clamp. Специ покривають лише (2). Grep: `grep -rln "enqueueInitial\|reEnqueue\|pollDelayMs\|self-re-enqueue\|removeOnComplete" apps/api/src --include="*.ts" | grep -v spec` → прямі тести на: **(а) domain-service** — create з полем→`status:PENDING`+enqueue РІВНО раз (mutation: прибрати `if(field)`→падає); create без поля→null+НЕ enqueue; trim normalize; update новий→PENDING+`raw:null`+enqueue; update скид(null/'')→scalar null+НЕ enqueue; update той самий→жоден scalar-write+НЕ enqueue (`data not.toHaveProperty('field')`); update undefined→не чіпати; поза-DRAFT-guard ПЕРЕД обробкою. **(б) clamp напряму** (реальний instance, мок settings) — `MIN-1→MIN`,`MAX+1→MAX`,`NaN/Infinity→default`,`throw→default` (mutation: прибрати кожен `Math.min/max`-край→падає). **(в) zombie-job** — enqueueInitial+reEnqueue шлють ОДНАКОВИЙ `jobId`; `job.data not.toHaveProperty('<field>')`; getStatus полем з `findFirst`(БД) не payload.
**Фікс:** переважно tests-only. Реальний баг: payload несе snapshot→прибрати з `job.data`; clamp відсутній→`Math.min(Math.max(v,MIN),MAX)`+`Number.isFinite`+try/catch→default.
**Severity:** HIGH (тихий регрес трекінгу при рефакторингу).
**Де ще:** nova-poshta/monobank/checkbox polling, nbu-rate-fetch, будь-який `getOrganisationSettings`-derived clamp (`nbuFetchHour`/`invoiceDueDays`/`autoArchiveDays`/`slotDurationMinutes`).

### 2026-09-07 — data-міграція сідить «увімкнений але порожній» рядок у registry-таблиці → тінить legacy read-fallback → тихий outage після deploy — backend / db-міграція / CRITICAL

**Сигнал:** registry-рефакторинг (хардкод-провайдер → таблиця конфігів, «нова таблиця = джерело правди, БЕЗ неї — legacy-fallback»). Резолвер 2-крок: `findFirst(new-table, enabled:true)`→повернути; інакше legacy-fallback. Additive-міграція сідить рядки з наявних записів, лишаючи секрет-поле (`credentials`) **NULL** + `enabled=true` → крок 1 знаходить рядок з порожніми кредами (`parseCreds(null)={}`) і НІКОЛИ не доходить до legacy (де реальні секрети) → downstream «не задано ключ» → тихий повний outage раніше-робочих сутностей, лише на `migrate deploy`.

```bash
grep -rn "INSERT INTO.*_config\|enabled.*true\|::\"ProviderKind\"" packages/database/prisma/migrations/ | grep -iv "credentials\|token\|secret\|licenseKey"
grep -n "hasCreds\|parseCreds\|return.*credentials" apps/api/src/modules/**/provider-config.service.ts
# Асиметрія: один метод має if(hasCreds(...)) перед return, інший — return напряму → баг.
```

**Фікс:** резолвер крок-1 після знаходження enabled-рядка перевіряє повноту кредів (`hasCreds(parseCreds(row.credentials))`); порожні → legacy-fallback ДЛЯ ТОГО Ж провайдера (`legacy && legacy.provider===row.provider ? {...legacy, apiUrl/mode з нового} : null`). Дзеркалити захист sibling-методу (`resolveByCode`). Тест: «enabled-рядок + credentials=NULL (сід-стан)» → повертає РЕАЛЬНІ креди з legacy, mutation-verify прибрати hasCreds-guard→падає.
**Severity:** CRITICAL — тихий повний outage, тригер `migrate deploy`, невидимий на dev і unit.
**Де ще:** будь-який registry «хардкод → таблиця активного + legacy-fallback»: `NotificationChannelConfig`, `BranchProviderConfig`, прайс-провайдери, SMS-шлюзи, будь-яка `*_config` з additive-сідом що лишає секрет NULL.

### 2026-09-07 — idempotency-лінк НЕ атомарний з money-write який захищає → sequential re-entry double-create (Bug #688) — backend / money / CRITICAL

**Сигнал:** external-gateway money-flow (QR-оплата, async confirm) з «наміром» що CAS→PAID, потім окремий `payments.create`, потім третій write `intent.update({paymentId})`. Три write НЕ атомарні: create закомітився, link-write упав → намір `PAID+paymentId=null` → наступний reconcile-poll → `create` ВДРУГЕ = тихий double-charge. jobId single-flight НЕ рятує (вікно послідовне). Reconcile-фікс проти ВТРАТИ грошей вводить дзеркальний баг ПОДВОЄННЯ.

```bash
grep -rn "paymentId.*null\|reconcile\|finalize" apps/api/src/modules/**/*.processor.ts | grep -v spec
grep -rn "onlinePaymentIntentId\|@unique" packages/database/prisma/schema/*.prisma | grep -i "payment\|intent\|order"
```

**Фікс:** `@unique` колонка-лінок на джерело (`Payment.onlinePaymentIntentId String? @unique`, additive nullable). У finalize: (1) pre-create `findFirst({orgId,<link>})` — якщо є, лише до-лінковуй; (2) `P2002` з create (гонка) → дістань winner і залінкуй (успіх, не помилка). Тест «create-succeeds-then-link-fails» → assert no second create; mutation-verify вимкнути pre-guard→падає.
**Severity:** CRITICAL — тихий double-charge без cap, виявляється лише звіркою gateway↔Payment.
**Де ще:** monobank QR, card/apple-pay, ПРРО-чек↔Payment, loyalty-earn↔Payment, будь-який BullMQ processor з `X.create` у reconcile/retry-гілці за станом-прапорцем. Контраст: CAS-ідемпотентність безпечна коли create+CAS у ОДНІЙ транзакції.

### 2026-09-06 — list-endpoint query-фільтри (date-range + enum) + retry-action з 0 unit, поки create() покритий (Bug #678-#682) — backend / coverage-gap / HIGH

**Сигнал:** фіча додає `findAll(opts)` з query-фільтрами (date-range, enum-eq, FK org-scoped) + action-метод (`retryX`), а `.spec` покриває лише `create()`. Два підпатерни: **(A) date-only `lte` inclusive-of-day** — `new Date('2026-09-06')`=midnight UTC → голий `createdAt.lte=new Date(dateTo)` виключає записи того ж дня. Правильно `new Date(dateTo+'T23:59:59.999Z')` (+`dateFrom+'T00:00:00.000Z'`). Grep: `grep -rn "lte.*new Date([a-zA-Z].*dateTo\|lte.*new Date(opts" apps/api/src/modules/ | grep -v "T23:59:59"`. **(B) enum-cast без guard → 500** — `where.x=opts.x as EnumType` без валідації → `?x=garbage`→Prisma→HTTP 500. Правильно `new Set(Object.values(Enum))`+`if(VALUES.has(opts.x))`. Grep: `grep -rn "where\.\w* = opts\.\w* as \|as Prisma\.\w*WhereInput" apps/api/src/modules/ | grep -v "\.has("`.
**Фікс:** дістати `findMany.mock.calls[0][0].where`, асертити межі/фільтри: `createdAt.lte.toISOString()==='...T23:59:59.999Z'`, garbage→`'x' in where===false`+`resolves`(no 500), FK cross-org→NotFound+findMany НЕ викликано, where завжди містить orgId. retry-метод: guards (`receiptId set`→400 БЕЗ enqueue; `!=FAILED`→400; queue reject→`.catch` FAILED+resolves; cross-org→NotFound) + порядок (idempotency ПЕРЕД status). Mutation-verify обидва: відкат midnight→inclusivity падає; прибрати `VALUES.has()`→garbage падає.
**Severity:** HIGH (A: пропущені фіндокументи; B: 500 на публічному list-endpoint).
**Де ще:** будь-який `findAll` з `@Query` date-range/enum: payments, supplier-payments, invoices, work-orders, stock-documents, purchase-orders, reports/builder. Спорідн. Bug #595/#616.

### 2026-09-06 — авторитетна denormalized-колонка з derived-Σ фолбеком у toDto + partial-payment CAS money-flow (Bug #668-#677) — backend / coverage-gap / HIGH-MEDIUM

**Сигнал:** нова running-total колонка (`Invoice.paidAmount`, `PurchaseOrder.receivedAmount`, `WorkOrder.paidAmount`) транзакційно оновлюється у money-flow + паралельна derived-сума з дітей (`Σpayments.amount`); `toDto` пише фолбек `col!=null?Number(col):(children?children.reduce(...):undefined)`. CAS-flow (updateMany where col=read-value→count=0 throw) має 1-2 щасливі тести, але БЕЗ: partial→full з ненульової бази; оплата РІВНО залишку (межа `>=amount-epsilon`); overpay поверх часткової; concurrency `count=1→count=0`; status-gate ВСІХ заборонених станів; manual-статус що синхронізує col=amount БЕЗ settlement; toDto-авторитетності (col vs розбіжний Σ / col=null / col=0≠undefined).
**Фікс:** tx-callback mock ($transaction виконує callback з prisma-як-tx). Money-набір: partial→full, exact-remaining→PAID, overpay-from-partial→throw-ПЕРЕД-CAS, concurrency count=1→count=0 (create/settlement РІВНО 1×), кожен заборонений статус→throw, manual-terminal→col=amount+`settlements.createTransaction not.toHaveBeenCalled`, toDto(col vs Σ / null / 0). **Mutation-verify КОЖЕН money-guard** (`false &&` overpay-if, прибрати `col:read-value` з CAS-where, `false &&` count=0-throw, прибрати `col:amount` terminal). Зазвичай tests-only. FE-паралель: optimistic-статус/remaining винести у чистий helper (`lib/invoice-payment.ts`) з тим самим epsilon. Backfill-міграцію нової колонки — idempotency (ADD COLUMN IF NOT EXISTS, backfill з самонейтралізуючим WHERE).
**Severity:** HIGH (CAS/overpay/concurrency/manual-sync — double-charge/застряглий залишок/подвійний облік); MEDIUM (toDto-авторитетність).
**Де ще:** `Invoice.paidAmount`↔payments, `PurchaseOrder.receivedAmount/paidAmount`↔lines, `WorkOrder.paidAmount`↔payments, `SettlementAccount.balance`↔transactions, `StockItem.quantity`↔movements. Спорідн. Bug #508/#613/#629.

### 2026-09-06 — узагальнення поля до типізованого locator (phone→recipient) + per-channel selection + структуровані креди (Bug #658-#660) — backend+frontend / coverage-gap / HIGH

**Сигнал:** фіча узагальнює адресат з одного типу до багатотипного (`phone`→`recipient` де тип залежить від каналу): (A) per-channel селектор `TYPE_SET.has(x.channel)?a:b` що пропускає крок без адресата; (B) mask/format-helper локатора у логах; (C) provider зі структурованими кредами серіалізованими JSON в одне поле (`apiKey=JSON.stringify({host,port,user,pass})`)+multi-field UI+`credsReady=!!(f1&&f2&&f3)`. Тести покривають лише type-A/type-B ОКРЕМО, не змішаний набір з асертом типу у КОЖНОМУ кроці. Grep: `grep -rnE "\.has\([a-z]+\.channel\)\s*\?|JSON\.stringify\(\{[^}]*host" apps/api/src apps/web/src --include="*.ts" --include="*.tsx"`.
**Фікс:** (A) тест ЗМІШАНОГО `[typeA,typeB]` × `{a}`(B відкинуто)/`{b}`(A відкинуто)/`{a,b}`(обидва, recipient КОЖНОГО кроку СВОГО типу — SMS без `@`, EMAIL з `@`)/`{}`(job не ставиться). Mutation: `a??b`→змішані падають. (B) mask-helper email/короткий/порожній/no-@. (C) multi-field форма (не single-token), `credsReady`=усі обов'язкові, save-payload=очікуваний JSON (парсити+`toEqual`), дефолти (порожній порт→587), negative: інший provider лишає single-token; mutation зламати `buildApiKey`→падає. Persist: assert пишеться НОВА колонка (`recipient`) не стара (`phone`). Зазвичай tests-only.
**Severity:** HIGH (селектор/креди); MEDIUM (mask). By-design виняток: caller що передає підмножину (followup лише phone→EMAIL тихо skip) — підтвердити no-crash, задокументувати, НЕ «фіксити».
**Де ще:** push-token/webhook-URL/deviceId залежно від каналу; OAuth `{clientId,secret}`, DB-DSN, S3 `{key,secret,bucket}`. Спорідн. Bug #488, #401/#432.

### 2026-09-06 — «exclusive mutation» через multi-`updateMany` у `$transaction` + frontend «only-one-active» тріада (Bug #657) — backend+frontend / tenant-isolation + coverage-gap / HIGH

**Сигнал:** «активним лише 1» через `activateX(orgId,branchId,code)` з prep-`findFirst({id,orgId})` + `$transaction([updateMany(where:{...,key:{not:code}},{enabled:false}), updateMany(where:{...,key:code},{enabled:true})])`. Prep валідує branch/parent; самі updateMany матчаться по бізнес-полю (`provider`/`type`/`isDefault`) — `orgId` у КОЖНОМУ where окрема відповідальність. Забути в одному (особливо `{not:code}`) → mass-update чужої org. `@@unique([branchId,key])` не рятує (updateMany не через unique). Grep: `grep -rnE "\\\$transaction\(\[" apps/api/src/modules --include="*.service.ts" -A6 | grep -A6 "updateMany"`.
**Фікс:** `orgId`(+`branchId`) у кожен where-клоз. Cross-org spec (in-memory-store): рядок org-2 з тим самим branchId+key; активація org-1 → рядок org-2 НЕДОТОРКАНИЙ + обидва where несуть orgId + exclusivity (рівно 1 набір enabled). Mutation: видалити orgId з одного updateMany→падає. **Frontend «only-one-active» тріада:** (1) **gate** — увімкнути можна лише сумісний item, інакше setError+return; (2) **empty-state guard** перед POST activate — item без конфігу → «спершу налаштуйте», НЕ POST (бек idemp no-op → хибний «активовано»); (3) **disabled** активного/чужого sub-toggle. Всі три mutation-verified. Grep: `grep -rn "activeProvider\|active[A-Z]\|isActive.*===\|only one\|лише один\|ексклюзивн" apps/web/src --include="*.tsx" -l`.
**Severity:** HIGH (backend cross-org corruption; frontend 2 активні → resolver змішує).
**Де ще:** `setDefaultX` (updateMany isDefault:false на решті), status-exclusive switches, priority-reorder через bulk updateMany, будь-який `$transaction([...])` з ≥2 масовими write на org-scoped таблиці. Спорідн. Bug #191, #628.

### 2026-09-06 — review-fix замінив хардкод-набір на metadata-driven gate, regression-guard покрив не КОЖНУ гілку — backend+frontend / coverage-gap / MEDIUM-HIGH

**Сигнал:** `fix(review):` вводить нове поле-метадані як ЄДИНЕ джерело (`NotificationProvider.templateChannels`, `PaymentProvider.supportsRefund`), замінюючи захардкоджені set-и і на бекенді (resolver/валідація) і на фронті (умовний рендер). Читається у 3+ місцях: resolver-gate, upsert-guard, UI-видимість+submit, registry `list()`-мапінг. Тести покривають 1-2 «очевидні» гілки, решту матриці — ні.

```bash
git log --oneline -8 | grep -iE "fix\(review\)|review-fix"
grep -rnE "readonly \w+Channels\??:|readonly supports[A-Z]|\.\w+Channels\?\.includes\(|templateChannels" apps/api/src --include="*.ts" | grep -v spec
ls apps/api/src/modules/<mod>/providers/*registry*.spec.ts   # часто відсутній
grep -n "<field>:" apps/api/src/modules/<mod>/*.processor.ts   # threading у send
grep -n "templateChannels\|<field>" apps/web/src/**/*.test.tsx   # фікстура має provider з полем?
```

**Фікс:** ПОВНА матриця (channel × provider): (1) in-set+джерело→INCLUDED; (2) in-set БЕЗ джерела→EXCLUDED; (3) out-of-set з випадковим метаданим→EXCLUDED; (4) write-guard force-null/reject; (5) `list()`/registry проти РЕАЛЬНИХ impl (не мок) — поле є, out-of-set відсутнє; (6) threading `expect(send.mock.calls[0][0].<field>)`; (7) frontend фікстура З metadata → показ/схов+submit+prefill. Новий `*registry*.spec.ts` проти реальних impl. Тести-only якщо логіка вірна.
**Severity:** MEDIUM-HIGH за blast-radius (сповіщення=MEDIUM, платіж/refund/approval=HIGH).
**Де ще:** будь-який `readonly <x>Channels?`/`supports<X>`/`requires<X>` на provider/strategy; registry `list()` з `?? []`; metadata-поле що гейтить BE-resolver І FE-видимість (спорідн. Bug #401/#432).

### 2026-09-06 — Prisma `$extends` field-encryption відвантажено з 0 інтеграційних тестів наскрізного циклу (Bug #652) — backend / security / at-rest-crypto / HIGH

**Сигнал:** at-rest шифрування секретів як Prisma-розширення `$extends({query:{$allModels:{$allOperations}}})` — мутує write/read payload. Юніт-тести є лише на crypto-хелпер (encrypt/decrypt round-trip), на РОЗШИРЕННЯ (що біжить у проді) — 0. Unit-мок Prisma не виконує `$allOperations` і не б'є Postgres → розширення може: не зашифрувати (plaintext-leak), не дешифрувати, подвійно зашифрувати, зламатись на композиції (`withFieldEncryption(withSyncVersion(client))` — порядок).

```bash
grep -rnE "\\\$extends\(|\\\$allOperations|encryptWriteData|decryptReadResult" apps/api/src/prisma --include="*.ts"
grep -rln "integration.spec\|\\\$queryRawUnsafe.*enc:v1" apps/api/src/prisma
grep -rn "new PrismaClient" apps/api/src --include="*.ts" | grep -v "spec\|prisma.service"   # має бути 0
grep -rniE "queryRaw.*(apiKey|smsApiKey|licenseKey|pinCode|secret|token)" apps/api/src --include="*.ts" | grep -v spec  # raw-read = bypass
```

**Фікс:** live-DB інтеграційний spec (skip якщо БД down, АЛЕ реально біжить коли є — не fake-green); будувати клієнт ТОЧНО як `PrismaService.onModuleInit`. Довести: raw колонка = `enc:v1:`+не plaintext; read через розширення = plaintext; legacy-plaintext (raw INSERT) читається; update без секрету не подвоює шифрування. uuid-bind у raw кастити `$1::uuid`. Статично: 0 `new PrismaClient` поза service, 0 raw-read секретів, response/cache/sync НЕ включають секрет (лише `hasX`). `where`-фільтр на зашифрованій колонці — лише null-checks валідні (equals/contains на ciphertext = завжди-промах).
**Severity:** HIGH — тихий регрес = plaintext-leak або зламаний provider-ланцюг.
**Де ще:** будь-який `$extends` що мутує payload (soft-delete-фільтр, tenant-scoping, syncVersion, audit-stamp); consumer-паті секрету (provider-виклики) — через розширений client.

### 2026-09-06 — review-fix змінив DI-конструктор, sibling `.spec` лишився на старій арності → hidden-red baseline — backend / hidden-red-baseline / HIGH (release-blocker)

**Сигнал:** commit (часто `fix(review):`) додав/переставив параметр конструктора NestJS-сервіса, не оновивши `*.spec.ts` (`new Service(prisma, q)` стара арність). **tsc проходить** бо моки `as unknown as T` вимикають перевірку арності → аргумент їде у сусідній слот → останній параметр `undefined` → `TypeError` у першому методі зсунутої залежності.

```bash
git diff HEAD~3 HEAD -- '*.service.ts' | grep -E "constructor\("
grep -rnE "new \w+Service\(" apps/api/src --include="*.spec.ts"   # порахувати аргументи
# найнадійніше: ПРОГНАТИ цільову suite зміненого модуля (не лише tsc)
```

**Фікс:** оновити конструктор у спеку + мок нової залежності (`{get:vi.fn(),list:vi.fn()} as unknown as Registry`)+import. Крок 0 ЗАВЖДИ прогонить цільову suite (`vitest run src/modules/<mod>`), не лише tsc. Baseline червоний = Bug #0, фіксувати ПЕРШИМ.
**Severity:** HIGH — червоний baseline ховає регресії й блокує сесії.
**Де ще:** будь-який `fix(review):`/`refactor:` що чіпає `constructor(` у сервісі; NestJS-сервіси з ≥2 залежностей + `@InjectQueue`; спеки з `new X(...)` замість `Test.createTestingModule`.

### 2026-09-06 — fallback/retry-engine: config-resolver (chain-builder) з 0 unit, поки worker має часткові — backend / critical-test-gap / meta

**Сигнал:** багатоканальна async-машина розбита на **(A) resolver/builder** (`resolveConfig()`, `buildChain()`, `planSteps()` — читає конфіг, будує впорядкований ланцюг) + **(B) worker/processor** (виконує крок, accept-STOP/reject-next/retry). Тести лише на (B); (A) з усіма edge-case (порожній ланцюг, NULL-креди відфільтровані where, крок без шаблону тихо skip, ВСІ пропущені→null=abort, legacy-fallback, priority-порядок) — 0.

```bash
grep -rnE "async (resolve|build|plan)[A-Z]\w*\(" apps/api/src/modules --include="*.ts" | grep -v spec
ls apps/api/src/modules/<mod>/*.spec.ts   # worker має spec, .service.spec (resolveConfig) відсутній → gap
```

**Фікс:** guard на кожну мовчазну гілку: NULL-креди→legacy/null; крок без шаблону→skip; ВСІ→null (abort, НЕ throw); legacy-гілка (enabled/disabled/no-key/no-template/no-row); priority-порядок. Плюс property-based на processor: max 1 SENT, stop-on-first-accept, throw⟺останній крок транзієнт-reject, Σ(term-логів)=visited (200 runs). Тести-only якщо логіка вірна.
**Severity:** meta (gap=CRITICAL бо ховає регресію у гроше-/сповіщення-шляху; знайдені дефекти можуть=0). Оцінювати за blast-radius: сповіщення=MEDIUM, платіж/склад=HIGH-CRITICAL.
**Де ще:** notifications resolveConfig, будь-який `*.processor.ts`+BullMQ з fallback/retry, multi-provider (payment/ПРРО/SMS), saga/outbox. Правило: є `<x>.processor.spec.ts` але нема `<x>.service.spec.ts` а сервіс має resolve/build → gap.

### 2026-09-06 — «перший-переможець» `.find()` для scan/lookup тихо бере не той запис при неоднозначному ТОЧНОМУ матчі — frontend / silent-wrong-pick / MEDIUM (HIGH якщо фін.документ)

**Сигнал:** resolver робить `items.find(it => it.key === typed)` і повертає перший збіг; ключ ПРИПУСКАЄТЬСЯ унікальним, але у реальних даних дублюється (той самий ШК у `barcode` одного товару і `barcodes[]` іншого) → у фін.документі оператор отримує «не той» товар.

```bash
grep -rnE "\.find\(.*===\s*(code|typed|barcode|sku|key)\b" apps/web/src/lib apps/web/src/components --include="*.ts" --include="*.tsx"
```

**Фікс:** `.find()`→`.filter()`; `length===1`→беремо; `length>1`→`null` (показати список). Дубль у межах ОДНОГО запису (головний==sub) не колізія (фільтр по об'єктах). Тест на колізію: 2 РІЗНІ записи однаковий ключ→`null`.
**Severity:** MEDIUM, HIGH коли живить фінансовий/складський документ.
**Де ще:** `pickScannedGood`, `resolveByCode`/`findBySku`/`matchBarcode`; backend `findFirst({where:{uniqueLike}})` без DB-констрейнта.

### 2026-09-06 — query-DTO не trim'ить рядок → exact-матч (`equals`) промахує при пробілах — backend / whitespace-miss / MEDIUM

**Сигнал:** `@Get` query-param (`q`/`barcode`/`code`) з `@IsString()` без trim-`@Transform`, сервіс будує `where` з `equals: query.x`. Сканер/оператор додає пробіл → `" 4820… "` не збігається → порожня видача → resolver 0 рядків.

```bash
grep -rnE "@IsString\(\)\s+\w+\?:" apps/api/src/modules/**/*.dto.ts | grep -iE "\b(q|barcode|code|sku|search)\b"
grep -rnE "equals:\s*(query|dto)\.(q|barcode|code)" apps/api/src/modules
```

**Фікс:** `@Transform(({value}) => typeof value==='string' ? value.trim() || undefined : value)` на кожному exact-lookup полі. DTO-spec: `plainToInstance(QueryDto,{q:' 999 '})`→`dto.q==='999'`; whitespace-only→`undefined`.
**Severity:** MEDIUM — тиха порожня видача на легітимному скані.
**Де ще:** усі query-DTO з `q`/`barcode`/`code`/`sku` у exact-where; deep-link `?param=` парсери.

### 2026-09-06 — bind-once `useEffect([])` document-listener кличе проп напряму → stale closure (frontend / stale-closure / MEDIUM)

**Сигнал:** shared overlay/popup/modal реєструє `document.addEventListener('keydown',h)` у `useEffect(()=>{...},[])` і всередині `h` кличе проп напряму (`onClose()`). `[]` замикає mount-версію → після ре-рендера батька Escape кличе СТАРИЙ колбек.

```bash
grep -rnE "addEventListener\('(keydown|keyup|click|mousedown)'" apps/web/src/components --include="*.tsx" -A 8 | grep -B4 -E "onClose\(\)|onConfirm\(\)|on[A-Z][a-zA-Z]*\(\)" | grep -v "\.current\("
```

**Фікс:** `const cbRef=useRef(cb); cbRef.current=cb;` (поза ефектом), handler кличе `cbRef.current()`, deps лишаються `[]`. JSX-обробники (onClick) НЕ треба на ref — свіжі на кожен render. Тест: `render(onClose=first)→rerender(onClose=second)→keyDown Escape→second 1×, first 0×`; mutation revert `ref.current()`→`cb()`→червоніє.
**Severity:** MEDIUM (HIGH якщо колбек — submit/delete зі stale id).
**Де ще:** `ConfirmDialog`, `CommandPalette`, `Modal`, `useHotkey`; будь-який bind-once listener/subscription/interval що читає проп/змінний state.

### 2026-09-06 — deep-link виставляє лише `editId`, модалка керується ОКРЕМИМ `open`-прапорцем → deep-link мертвий (frontend / dead-feature / HIGH)

**Сигнал:** сторінка-список має ОДИН інстанс модалки з `open={xCreateOpen}`+`editId={xEditId}` (два незалежні state). row-click виставляє ОБИДВА, а deep-link ефект (`?open=`) — лише `setXEditId(id)` → `open` лишається false → модалка ніколи не відкривається.

```bash
grep -rnE "open=\{[a-zA-Z]+CreateOpen\}" apps/web/src/app/**/page.tsx
grep -rnE "searchParams.get\('open|openReturn'\)" apps/web/src/app/**/page.tsx
# у тілі ефекту має бути і setXEditId, і setXCreateOpen(true) — інакше баг
```

**Фікс:** deep-link ефект виставляє обидва setter-и (дзеркало row-click). Helper `resolveXDeepLink(get)→{openId,modalShouldOpen}` (тест: `?openReturn=<uuid>`→`modalShouldOpen===true`; mutation `false`→падає). Правило-інваріант: якщо модалка керується `open`+`editId` роздільно, КОЖНА точка відкриття виставляє обидва.
**Severity:** HIGH — мертва фіча, тихо (клік нічого не робить).
**Де ще:** усі сторінки-списки з `open={xCreateOpen}`-модалкою + deep-link (purchase-orders `?openReturn=`); будь-який роздільний `visible`+`selectedId` де один код-шлях забуває `visible=true`.

### 2026-09-05 — count/detail розходяться: badge рахує FK, detail фільтрує deletedAt:null → «1» над порожньою секцією (Bug #641) — backend / consistency / MEDIUM

**Сигнал:** count `row.counterpartyId ? 1 : 0` (наявність FK-скаляра), detail `counterparty.findFirst({where:{id,orgId,deletedAt:null}})` → referenced soft-deleted а FK лишився → badge «1», панель порожня. Досяжно коли delete-guard блокує лише за відкритими документами (CP можна видалити під PAID-рахунком).

```bash
grep -rnE "= [a-zA-Z]+\.[a-zA-Z]*Id \? 1 : 0|Id \|\| [a-zA-Z]+\.[a-zA-Z]*Id \? 1 : 0" apps/api/src/modules/**/*.service.ts | grep -iE "count"
grep -rn "getLinked\|LinkedCounts\|LinkedDocuments" apps/api/src/modules/**/*.service.ts
```

**Фікс:** count МУСИТЬ мати ідентичний WHERE до detail. Зібрати унікальні FK, одним `findMany({id:{in},orgId,deletedAt:null})` дістати живий набір, «1» лише якщо `liveSet.has(fkId)` (батч, без N+1). Тести: soft-deleted ref→count=0, duplicate ids (keyed by id), cross-org (нулі), zero-count id (present у мапі). Revert→`1` падає.
**Severity:** MEDIUM — UX-неконсистентність, ховає осиротілий документ.
**Де ще:** `getLinkedCounts`/`getLinkedDocuments`, `_count` у list-DTO vs include у detail, dashboard-плитки з іншим WHERE ніж сторінка.

### 2026-09-05 — Unsaved-guard baseline через `setTimeout(0)` + АСИНХРОННИЙ авто-populate → false-positive «незбережені зміни» (Bug #639) — frontend / trust-erosion / HIGH

**Сигнал:** модалка озброює baseline `setTimeout(()=>{baselineReadyRef.current=true},0)`, dirty-детектор у deps має поле що async авто-populate-иться (`if(warehouses.length===1)setForm(...)` після `apiFetch`). Reference-дані резолвяться ПІЗНІШЕ за 0ms → програмна установка дефолту невідрізнима від правки → відкрити create-модалку з 1 складом, Escape → «Є незбережені зміни». Grep: `grep -rlE "baselineReadyRef|setTimeout\(\s*\(\)\s*=>\s*\{\s*baselineReadyRef" apps/web/src/components/ui/*Modal*.tsx` перетнути з `length === 1` (авто-вибір) + чи авто-вибірне поле у deps dirty-детектора.
**Фікс:** ref-прапорець (`autoWarehouseRef`) виставляється в авто-вибірному ефекті ЛИШЕ коли `baselineReadyRef.current===true`; dirty-детектор пропускає рівно цю зміну (`if(auto!==null && field===auto){auto=null;return;}`), скидати у reset-ефекті. НЕ переозброювати baseline новим `setTimeout` у cleanup (скасує pending-таймер). Тест: 1 елемент, render, wait ~60ms, Escape→onClose 1×+нема діалогу; mutation revert skip→падає; парний «змінив поле→діалог Є».
**Severity:** HIGH — руйнує довіру (guard кричить «вовки» → сліпо «Покинути» → реальні зміни втрачаються).
**Де ще:** усі модалки з async авто-populate ПІСЛЯ baseline-таймера (єдиний ПДВ/валюта/каса/авто). Критерій імунітету: async-populate поля у deps dirty-детектора.

### 2026-09-05 — Component-тест sync-ref-guard через `userEvent.click`×2 (fireEvent×2) — ХИБНО-ЗЕЛЕНИЙ — frontend / test-integrity / MEDIUM

**Сигнал:** double-submit тест через `userEvent.click(btn)`×2 або `fireEvent.click`×2 ПРОХОДИТЬ навіть коли `savingRef`-guard видалено — бо ці API обгортають кожен клік у власний act()/pointer-чергу → React re-renderить `disabled={saving||loading}` МІЖ кліками → фактичний гейт = async `disabled`, не тестований sync-ref.
**Фікс:** реальний same-tick race `(btn as HTMLButtonElement).click(); btn.click();` — native `HTMLElement.click()` двічі СИНХРОННО в одному блоці (без await/act між). Ввід — `fireEvent.change` (синхронний). Розрулити in-flight у фінальному `await act(async()=>resolve())`. **ОБОВ'ЯЗКОВО дискримінація:** revert guard→FAIL «expected 2 to be 1» / fix→PASS. Grep: `grep -rnE "user\.click|fireEvent\.click" apps/web/src/**/__tests__/*double*` + будь-який тест «POST рівно 1×» після ≥2 кліків.
**Severity:** MEDIUM (test-integrity) — майбутній рефактор мовчки знімає guard.
**Де ще:** усі `*Modal.test.tsx` з double-submit; той самий принцип для debounce-ref, request-token ref, idempotency createdRef.

### 2026-09-05 / 2026-09-04 — Concurrent double-submit у create/save-модалці обходить idempotency-ref (Bug #630, #632-#634, #637) — frontend / concurrency / financial-integrity / HIGH

**Сигнал:** async submit-handler (`handleCreate`/`handleSave`/`create`/`save`/`update`) що пише документ АБО master-data, захищений ЛИШЕ `disabled={saving}` (або кнопка `<Button onClick={save} loading={saving} disabled={!field}>` де `disabled` БЕЗ saving). `disabled`/`loading` спирається на re-render МІЖ кліками → два click-и в одному tick (fast double-click, синтетичні a11y-події, Enter-repeat) обидва входять до застосування → 2 POST → 2 документи. Idempotency-ref (`createdIdRef`) рятує лише retry-після-обриву (виставляється ПІСЛЯ await), НЕ concurrent — потрібні ОБИДВА. **Коверідж:** не лише «великі» документні модалки, а Й edit-модалки довідників (Counterparty #632, Employee+auth-акаунт #633, Good #634) + **row-actions у списках** (clone #637: `disabled={cloningId===row.id}` = лише `useState`→2 POST /clone).

```bash
grep -rln "const handleCreate\|const handleSave\|const create =\|const save = async\|const update = async" apps/web/src/components/ui --include="*Modal.tsx" | while read f; do grep -qE "setSaving(Both)?\(true\)" "$f" && ! grep -qE "if \(saving(Ref|_?ref)?\.current" "$f" && echo "RISK (no ref): $f"; done
grep -rln "loading={saving}" apps/web/src/components/ui --include="*Modal.tsx" | while read f; do grep -qE "disabled=\{![^}]*\}" "$f" && ! grep -qE "if \(saving(Ref)?\.current" "$f" && echo "RISK (loading-only gate): $f"; done
grep -rnE "disabled=\{[a-zA-Z]+Id === " apps/web/src/app/**/page.tsx   # row-actions #637
```

**Фікс:** синхронний `if (savingRef.current [|| transitioningRef.current]) return;` ПЕРШИМ рядком, ПЕРЕД будь-яким await; `setSavingBoth(v){savingRef.current=v;setSaving(v)}`, reset у finally. Idempotency-ref лишається (ортогональні механізми). Row-actions — через `apps/web/src/hooks/useSubmitGuard.ts` (`guard.run(async fn)` з sync `inFlightRef`). **Пастка:** модалка часто ВЖЕ має savingRef у edit/transition, але забуває create — split-coverage. Regression-guard: native `btn.click();btn.click();` (НЕ userEvent/fireEvent — маскують), верифікований revert→2 POST/fix→1.
**Severity:** HIGH для фінансово-облікових (SupplierPayment/Invoice/PurchaseOrder/StockDocument/WorkOrder); MEDIUM інших.
**Де ще:** усі create-модалки + `SettlementsTabContent.handleCreateAct` (raw apiFetch без savingRef); quick-add форми, bulk-action кнопки. Backend-двійник: Bug #412 (Serializable $tx).

### 2026-09-05 — Backend-агрегат змішує `Σ(round(x))` і `round(Σ(x))` для тієї самої величини → розходження на копійку — backend / money-precision / LOW

**Сигнал:** сервіс рахує ≥2 denorm money-поля різними стратегіями: `totalLabor=roundMoney(Σ roundMoney(nh×price))` (per-line rounded sum) vs `totalAmount=roundMoney(Σ raw(nh×price))` (raw sum then round) → per-line дрейф 3×2.525→7.59 vs 7.58. FE-preview що дзеркалить одне не збігається з іншим.

```bash
grep -rnE "roundMoney\(.*reduce|\+= Number\(.*price\)" apps/api/src/modules
grep -rn "totalActualLabor\|<newField>" apps/web/src --include="*.ts*"   # denorm-поле має бути у ВСІХ типах aggregate
```

**Фікс:** одна канонічна стратегія (STO-конвенція: per-line `amount` округлюється при записі → агрегат=`Σ(round)`; напр. `totalActualLabor` теж має сумувати округлені per-line). Regression-guard: unit `totalLabor===totalAmount` коли `actualHours===null`. Числова симуляція ×.525.
**Severity:** LOW — ≤1 коп, не stored-corruption, user-visible preview≠charge.
**Де ще:** будь-який `recalc*`/`*Totals` (Invoice, PO, StockDocument, CompletionAct).

### 2026-09-05 — Read-фільтр діапазону дати CONTAINMENT замість OVERLAP → рядки що перетинають межу зникають (CAL-C2) — backend / data-visibility / HIGH

**Сигнал:** `findX(date)` будує UTC-вікно `[dayStart,dayEnd]` і фільтрує `where:{startAt:{gte:dayStart},endAt:{lte:dayEnd}}` (CONTAINMENT) → запис що ПОЧИНАЄТЬСЯ до dayStart але закінчується в дні (split-day, слот через опівніч) випадає → UI показує вільним → double-booking.

```bash
grep -rnE "startAt: \{ (gte|gt):" apps/api/src/modules --include="*.service.ts"
```

Для інтервальної моделі перевірити чи фільтр=half-open OVERLAP `startAt<end AND endAt>start`, не containment. Порівняти з conflict-probe того ж сервісу — мають бути ідентичні.
**Фікс:** `where:{startAt:{lt:end},endAt:{gt:start}}` (`[start,end)`). Regression: `where.startAt.lt`+`where.endAt.gt`; live слот що перетинає межу.
**Severity:** HIGH — прихована зайнятість → double-booking; TS/unit зелені (where синтаксично валідна).
**Де ще:** `BookingRequest`(getAvailability), майбутні `Rental`/`Reservation`/`Shift`; принцип «інтервал⇒overlap, точка⇒containment».

### 2026-09-05 — Cascade-remove-guard для master-data з FK-дітьми (MD-H1 class) — backend / orphan / MEDIUM–HIGH

**Сигнал:** `remove()` master-data (Warehouse/Zone/Employee/Lift) робить `updateMany({deletedAt})` БЕЗ prep-check на активних FK-дітей → parent зникає, діти (StockItem із залишком, Lift у зоні, WorkOrderLine employeeId) вказують на мертвий id. Live: create parent→активну дитину→DELETE parent→204 (мало 400).

```bash
grep -rnE "<entity>Id\b" packages/database/prisma/schema/*.prisma   # моделі з FK на цю сутність
```

**Фікс:** prep-guard `findFirst({where:{<fk>:id,orgId,deletedAt:null,<active-predicate>}})`→`throw BadRequestException(<укр>)` ПЕРЕД soft-delete (не всередині — 400 до мутації). Баланс: `OR:[{quantity:{not:0}},{reserved:{not:0}}]`. Термінальні (ARCHIVED/CANCELLED WO) не блокують (паритет Bug #631). Spec: дитина-`findFirst.mockResolvedValueOnce({id})`→BadRequest+parent.updateMany.not.toHaveBeenCalled; happy null→updateMany; count=0→NotFound.
**Severity:** MEDIUM (Zone/Lift/Employee) до HIGH (Warehouse із залишком).
**Де ще:** Warehouse/Zone/Employee ✅; Lift.remove (майбутні CalendarSlot), GarageBranch.remove, UnitOfMeasure.remove (GoodUoM), WorkCategory.remove (Work).

### 2026-09-05 — TOCTOU: existence/uniqueness check через count() ПОЗА транзакцією → concurrent обидва проходять — backend / concurrency / HIGH

**Сигнал:** `if(await isAlreadyInitialized())throw` / будь-який `count()`/`findFirst()` prep-guard ПОЗА `$transaction` перед create агрегату. Два concurrent обидва читають count=0. Особливо небезпечно коли `@@unique` НЕ ловить (setup: кожна tx має власний `org.id`, `@@unique([orgId,email])` не спрацьовує). Throttle не рятує.

```bash
grep -rnE "await (this\.)?(isAlready|exists|count|findFirst)" apps/api/src/modules --include="*.service.ts"
```

**Фікс (offline-safe):** `tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext('<ключ>'))\``ПЕРШОЮ у`$transaction`, ПОТІМ re-check `count()`ВСЕРЕДИНІ→400. Для не-bootstrap — DB`@@unique`+ловити P2002→409 (якщо ключ покриває інваріант). Unit: `makePrisma(outer=0,inner=1)`→400+advisory-lock 1×+create not called.
**Severity:** HIGH — порушення single-instance/uniqueness; невідтворюване без concurrency-mock.
**Де ще:** setup/init ✅; будь-який «create-if-not-exists» без DB-unique — first-org, singleton-settings, reserve-номера поза `SELECT FOR UPDATE`.

### 2026-09-05 — Public endpoint приймає дату в минулому (booking) → сміття в черзі + SMS на минуле — backend / validation-completeness / MEDIUM

**Сигнал:** public mutation (booking) валідує формат/години/день, але НЕ дату ≥ тепер → curl-bypass створює заявку на вчора.

```bash
grep -rnE "requestedDate|scheduledAt|appointmentDate|plannedAt" apps/api/src/modules --include="*.service.ts"
```

**Фікс:** `if(new Date(dto.date).getTime()<Date.now())throw new BadRequestException('Дата запису не може бути в минулому')` (абсолютні інстанти). Live: past→400, майбутня→201.
**Severity:** MEDIUM — operational-noise + SMS-витрати.
**Де ще:** booking.create ✅; будь-який public scheduler, `POST /appointments`, `/reservations`.

### 2026-09-04 — Remove-guard повнота relations + balance-як-proxy маскує DRAFT (Bug #631) — backend / orphan / MEDIUM

**Сигнал:** `remove()` перевіряє 2 з N однотипних document-relations; balance-guard (`Number(balance)!==0`) здається універсальним, але DRAFT-документ ще без транзакції → `balance=0` → провалюється крізь усі guard-и → активний документ на soft-deleted parent. Live: create parent→DRAFT-документ→DELETE parent→204 (мало 400).

```bash
cat packages/database/prisma/schema/*.prisma | sed -n '/^model Counterparty /,/^}/p' | grep -E "\[\]"   # усі back-relations
```

**Фікс:** кожен document-relation (WorkOrder/Invoice/PurchaseOrder/StockDocument/SupplierReturn) має ВЛАСНИЙ count-guard з `status:{notIn:[<фінальні>]}`, НЕ balance. Append-only (Payment/StockMovement) не блокують. Spec: `<rel>.count.mockResolvedValueOnce(1)→BadRequest+updateMany not called`+happy=0+`where.status=notIn`; додати relation.count у prisma-mock.
**Severity:** MEDIUM — data-integrity + orphan-UX.
**Де ще:** `Counterparty.remove`(WO+PO+Invoice), `Vehicle.remove`(WO), `Good`/`Warehouse.remove`(StockItem≠0). Принцип: guard-completeness=ПОВНИЙ набір relations; balance≠proxy для «є відкриті документи».

### 2026-09-04 — Stale `dist/main`: запущений процес старший за rebuild → guard мовчки не спрацьовує на live (verification-hygiene, рецидив) — process / deployment / CRITICAL-для-верифікації

**Сигнал:** live-проба нового guard дає СТАРУ поведінку хоча unit зелені, tsc чистий, `grep <guard-msg> dist/.../*.js` знаходить код. Парадокс «код є, а не працює» = stale-процес. `node dist/main` завантажує JS раз на старті і НЕ hot-reload; dist перезібрано ПІСЛЯ старту → файл новий, процес старий. (FIN-C2 та MD-C1 — обидва рецидиви цього.)
**Фікс:** ПЕРЕД будь-якою live-верифікацією звірити StartTime процесу порту 3000 з часом білду dist (`Get-CimInstance Win32_Process`/`netstat -ano | grep :3000` vs `ls -la dist/main.js`). Рестарт: `pnpm --filter @sto/api build` → kill PID (`Get-NetTCPConnection -LocalPort 3000 | Stop-Process -Force`) → `node dist/main` у фоні → wait `/api/health`=200 → перелогінитись → повторити пробу. Правило: **unit-зелений + свіжий dist ≠ deployed.**
**Severity:** verification-process (не баг продукту) — критична: без рестарту тестер хибно рапортує баг/пропускає баг, отруює MemoryManual.
**Де ще:** кожна live/E2E-проба проти локального `node dist/main`. Web `next dev` hot-reload-ить (менш вразливий), АЛЕ `.next` cache після route-group rename — окрема пастка (§0 Bug #291).

### 2026-09-14 — Multicurrency-aware екран + non-aware CSV/export → сира per-currency сума у одну колонку без валюти/base (Bug #743) — frontend / multicurrency / export-integrity / MEDIUM

**Сигнал:** фіча додає валюту (`currencyCode`/`amountBase`) у row-модель; on-screen список оновлено (сума у валюті + base-підрядок + символ), а CSV/XLSX/PDF-хендлер у ТОМУ Ж компоненті лишився з до-мультивалютної версії — header `['Дата','Тип','Сума',…]` з однією «Сума»-колонкою, куди кладеться сирий `row.amount` без коду валюти й без `amountBase`. 100 USD і 4150 UAH виглядають як `100`/`4150` → Σ колонки безглузда. Підвид #629 (сире money покидає систему), корінь — змішування ОДИНИЦЬ (валют) не float. Виявлення: перетин двох grep — компоненти з `amountBase`/`currencyCode` ∩ компоненти з export (`escapeCsvCell`/`Blob([csv`/`.xlsx`/`buildCsv`); у перетині звірити header+рядок: чи є окрема колонка валюти І окрема base-колонка? Review/sync фокусуються на backend base-обліку, tsc/тести зелені бо CSV-headers рідко асертяться.
**Фікс:** додати колонку валюти (`row.currencyCode ?? baseCode`) + окрему base-колонку (`row.amountBase ?? row.amount`; історичні = base) — base-колонка єдина коректно-підсумовна. `baseCode` з `useBaseCurrency()`, не хардкод. Регресія важка (немає DOM-асерту на CSV) — не ламати наявні header-тести; де є — асертити нові колонки.
**Severity:** MEDIUM (фінекспорт змішує валюти; stored balance у base → не corrupts).
**Де ще:** payments/settlements/cash/invoice/PO CSV+XLSX-експортери; будь-який `exportReport`/`buildCsv`/xlsx-емітер чий агрегат отримав валютне поле. Родич #629 (float в export), #715 (display-model drift).

### 2026-09-14 — Currency-match guard на ОДНОМУ target-шляху, паралельний шлях без guard-а (лише коментар-твердження) (Bug #744) — backend / multicurrency / financial-integrity / HIGH

**Сигнал:** метод має ДЕКІЛЬКА target-гілок, кожна інкрементує СВОЄ currency-specific поле (`payments.create`→invoice-гілка пише `invoice.paidAmount`, WO-гілка `workOrder.paidAmount`). Одна гілка має явний guard (`sameCurrencyAsBase(paymentCur, targetCur)`→400), інша — замість guard стоїть КОМЕНТАР що СТВЕРДЖУЄ інваріант («оплата має збігатися з валютою наряду»). Виказує себе: незахищена гілка навіть НЕ фетчить `currencyId` target-а у select (нема чого порівнювати). Наслідок: document-поле у валюті документа інкрементиться сумою в ІНШІЙ валюті → змішування одиниць → хибний залишок/статус. Борг у леджері лягає у base коректно (settlement конвертує) → баг тихий. Grep УСІХ мутацій currency-поля: `grep -rnE "paidAmount:\s*\{\s*increment|paidAmount:\s*(newPaid|prevPaid)"` (узагальнити на будь-яке document-currency-scoped поле) → для КОЖНОГО чи є ПЕРЕД мутацією currency-match guard? Сусідня гілка має, ця ні → баг. Червоний прапор: коментар «має збігатися»/«успадковує валюту» БЕЗ парного `throw`; target без `currencyId` у select хоча метод конвертує валюти деінде.
**Фікс:** `currencyId` у select target-а + дзеркалити guard сусідньої гілки (`if (!sameCurrencyAsBase(orgId, paymentCur, target.currencyId)) throw BadRequestException(<укр>)`). NULL currencyId ≡ base. ⚠️ існуючий тест міг кодувати САМЕ баг (мокати target без currencyId + оплату в іновалюті, асертити УСПІХ) — виправити інтент + додати окремий тест крос-валютного 400.
**Severity:** HIGH (currency-mixing → хибний залишок + хибний авто-PAID).
**Де ще:** будь-який метод з ≥2 target-гілками що пишуть валютне поле — supplier-payments (SP vs PO alloc), stock-documents receipt vs return, credit-note allocation; будь-де де фікс валют-guard був точковий а метод має інші входи. Родич #742 (base-облік mixing).

### 2026-09-04 — Похідне money × дріб-коефіцієнт / reduce / різниця БЕЗ roundMoney що покидає систему сирим (Bug #629) — backend / money-precision / report-and-export / LOW-MEDIUM

**Сигнал:** `Number(x)*RATIO` (дробовий RATIO, `LABOR_COST_RATIO=0.4`→`3520.30*0.4=1408.1200000000001`), Σ у `reduce`, або різниця сум (`invoiced-purchases=66.77000000000001`) — IEEE-754 дрейф. Маскується `fmt()` на екрані, але емітиться СИРИМ у CSV/XLSX/PDF-експорт (без fmtMoney для number-детекту) і у JSON API (mobile/sync). Аудит округлення фокусується на DB-write/balance і пропускає «display-only» звіти.

```bash
grep -rnE "Number\([^)]*\)\s*[*/]" apps/api/src/modules/{reports,completion-acts,xlsx}
grep -rnE "reduce\(\(s.*\+.*(amount|balance|revenue|total|cost|vat)"
```

Для кожного — чи результат покидає систему (export/JSON)?
**Фікс:** `roundMoney()` на КОЖНЕ похідне money-поле (НЕ на %/count/hours). Live-guard: report endpoint з фракційними даними → `round(v*100)/100===v` кожне money-поле. Regression: фракційні входи (`totalLabor:3520.3`→`.toBe(1408.12)`, `net.toBe(66.77)`)+`has2Decimals()`. report-сервіси часто 0 unit → закрити test-gap разом.
**Severity:** LOW-MEDIUM — не stored/balance, але user-visible float у фіндокументі. Родич completion-acts PDF float (f7a935db), Bug #621/#613.
**Де ще:** усі report-сервіси; будь-який `*RATIO`/`*rate`/`/divisor` на грошах (markup, знижки, комісії, COGS); frontend-експортери (`exportReport`, `buildCsv`, xlsx) що емітять числові поля БЕЗ fmtMoney.

### 2026-09-04 — DB-constraint error-mapping guard у canonical write, відсутній у alternate-mutation → 500 замість 409 (Bug #628) — backend / error-mapping-symmetry / MEDIUM

**Сигнал:** новий Postgres constraint (EXCLUDE/CHECK/unique partial) + `throwIfExclusionConflict`/`throwIfSerializationConflict` конверсія SQLSTATE→4xx додана у 1-2 write-методи, але resource має alternate-mutation (`syncFromX`/`refreshFromY`/`bulk*`/`by-work-order`) що пише ті самі поля через `return $transaction` без try → concurrent race→raw SQLSTATE→generic 500. ПАСТКА: EXCLUDE/CHECK перевіряються і на **UPDATE** (`update({data:<overlap>})`→23P01).

```bash
grep -rn "throwIfExclusionConflict\|throwIfSerializationConflict" apps/api/src/modules/<mod>/*.service.ts
```

Для кожного alternate-write (`return this.prisma.$transaction` БЕЗ try) — gap.
**Фікс:** `let result:T; try{result=await $transaction(...)}catch(err){throwIfX(err,...)} return result` (throwIfX:never → tsc definite-assign). Regression: (1) `$transaction` mock кидає SQLSTATE-shaped→`rejects ConflictException/BadRequestException`; (2) не-constraint→пробрасується.
**Severity:** MEDIUM — цілісність тримається (constraint блокує), лише 500→4xx UX/observability. Підклас Bug #403.
**Де ще:** CalendarSlot (createSlot/updateSlot/**syncWorkOrderSlots** × EXCLUDE), StockItem (× `stock_*_nonneg`), balance-writers, `@@unique` partial з кількома write-шляхами. Родич Bug #621, #403, #444.

### 2026-09-04 — Fastify content-type-parser помилка (FST*ERR_CTP*\*) не мапиться → 500 замість 4xx (Bug #627) — backend / framework-error-mapping / LOW

**Сигнал:** bodyless POST (`/transition`,`/restore`,`/clone`,`/confirm`,`/cancel`,`/refresh`,`/set-default` — без `@Body`) з `Content-Type: application/json`+порожнім тілом → 500. Fastify content-type-parser кидає `FastifyError`(`FST_ERR_CTP_EMPTY_JSON_BODY`) ДО хендлера — не `HttpException`/не Prisma → `else`-гілка `HttpExceptionFilter`→500+Sentry. Так само `FST_ERR_CTP_INVALID_JSON_BODY`, `FST_ERR_CTP_INVALID_MEDIA_TYPE`(415).

```bash
grep -rn "FST_ERR\|isFastify" apps/api/src/common/filters   # 0 = gap
# live: curl -X POST <bodyless-url> -H "Content-Type: application/json" (порожнє) → має бути 4xx
```

**Фікс:** guard `code.startsWith('FST_ERR_CTP_') && statusCode у 4xx`→чистий 4xx UA+`logger.warn`; 5xx-FastifyError і Node errno (`ECONNREFUSED`) лишаються 500. Regression: fake `{code:'FST_ERR_CTP_EMPTY_JSON_BODY',statusCode:400}`→400+warn; 415→statusCode; 5xx→500; ECONNREFUSED→500.
**Severity:** LOW — веб захищений api-client-ом; Sentry-шум + маскує баги для не-браузерних клієнтів. **ПАСТКА тест-харнеса:** власний probe-клієнт має додавати `Content-Type: application/json` ТІЛЬКИ за наявності тіла — інакше bodyless-виклики дають хибний 500 (імітує неіснуючий баг, як хибний MD-C1 «500»).
**Де ще:** усі catch-all `ExceptionFilter`; будь-який bodyless POST/PATCH; interceptor-и що читають `request.body`. Родич Bug #291 (`.next` cache).

### 2026-09-04 — Слабкий page-scope `button[aria-expanded]` асерт матчить decoy-тоггл (Bug #625) — frontend / e2e-integrity / MEDIUM

**Сигнал:** E2E доказ «з'явився результат» через широкий page-level `page.locator('button[aria-expanded]').first()` / `getByRole('button').first()` / `locator('table').first()` — на сторінці є ІНШИЙ елемент того ж роду (хедер-тоггл, службова кнопка) що матчиться першим → тест пройшов би при плоскому/порожньому результаті.

```bash
grep -rnE "page\.locator\('button\[aria-expanded\]'\)\.first|page\.getByRole\('(button|table|tab|listitem)'\)\.first|page\.locator\('table'\)\.first" apps/web/e2e
```

**Фікс:** scope до контейнера результату (`table.locator(...)`, `resultPanel.getByRole(...)`) + позитивні якорі (`thead th=='Група'`, count>1, очікувані лейбли) + негативний якір анти-стану. Sanity: тимчасово «зламати» очікуваний стан — тест МАЄ почервоніти; якщо зелений→асерт слабкий. Виставити передумову рендеру (drill-down groups потребують `node.rows`→колонку).
**Severity:** MEDIUM — код може працювати, регресія-guard фіктивний.
**Де ще:** будь-який E2E «з'явився X» через широкий селектор при службових контролах: disclosure (`aria-expanded`), tab (`role=tab`), `.first()`/`.last()` на неунікальному локаторі. Родич §5.4.

### 2026-09-04 — Prisma `upsert` create-гілка × Postgres CHECK-констрейнт = 500 на кожній від'ємній дельті (Bug #621) — backend / prisma-postgres-semantics / CRITICAL

**Сигнал:** `X.upsert({where, update:{field:{increment:delta}}, create:{field:delta}})` де `delta` може бути від'ємним (WRITEOFF) І таблиця має `CHECK (field>=0)`. Postgres перевіряє CHECK на INSERT-tuple ПЕРЕД арбітражем ON CONFLICT → валить `23514` **навіть коли рядок існує і DO UPDATE дав би валідне** (100−40=60). Unit-мок не б'є Postgres. **ПАСТКА: баг створюється фіксом Bug #613** (додавання non-neg CHECK як backstop) — ретроактивно ламає кожен upsert-writer з від'ємною create-дельтою.

```bash
grep -rn "\.upsert(" apps/api/src/modules --include="*.service.ts"
grep -rn "CHECK.*>= 0\|_nonneg" packages/database/prisma/migrations/
```

**Фікс:** клампити create-гілку `Math.max(0, delta)` (update лишається `{increment:delta}` — create спрацьовує лише коли рядка нема, тоді від'ємний стан неможливий). Regression: `upsert.mock.calls[0][0].create.<field>`≥0 при від'ємному dto. **Live-probe (не unit)**: після міграції що додає `CHECK(col>=0)` — КОЖЕН upsert-writer з від'ємною дельтою через curl проти живої БД (existing row+від'ємна→2xx не 500). raw-SQL `INSERT...ON CONFLICT` відтворює 23514 (доказ Postgres-семантики).
**Severity:** CRITICAL — блокує весь клас (WRITEOFF/TRANSFER-out/WO-COMPLETED); невидимий unit-CI.
**Де ще:** будь-яка таблиця з non-neg CHECK + upsert-writer зі знаковою дельтою: `stock_items.quantity/reserved` ✅, balance-таблиці (якщо додадуть CHECK), loyaltyAccount.points. Мета: **міграція що додає CHECK на існуючу таблицю = обов'язковий live-probe кожного upsert/insert-writer.**

### 2026-09-04 — Guard-order у inline «add-to-collection» helper: unique-check коротшить перед limit/permission (Bug #606) — frontend / UX / guard-ordering

**Сигнал:** `addToZone(zone,key)`/`addToList(key)` виконує `permission→limit→includes(key)` → повторний add вже-активного → misleading toast «Максимум 5/немає прав».
**Grep:** `grep -rEn "\.includes\(key\)|\.has\(key\)|\.some\(.*===\s*key" apps/web/src --include="*.tsx" -B3 -A3 | grep -B4 -A2 "toast\.warning\|toast\.error"`. Правильно: `if (list.includes(key)) return;` ПЕРШИМ, ЛИШЕ ПОТІМ `if (list.length>=LIMIT) return toast(...)`. Static test: список до ліміту→повторний з наявним ключем→НЕ toast. E2E `waitForTimeout(300)`+`toHaveCount(0)`.
**Severity:** LOW-MEDIUM — критичний UX-signal (user думає що зламано).
**Де ще:** Zone/Palette/Picker з click-shortcut, tag input, multi-select chip, «Add to favorites», filter/sort field pickers з MAX-N.

### 2026-09-04 — Cross-midnight probe protocol: timezone-aware date-bucketing live-верифікація — backend / time-zone / aggregation / verification

**Сигнал:** свіжий fix «UTC→Local-day» (`toISOString().slice(0,10)`→`Intl.DateTimeFormat('sv-SE',{timeZone})`) або зміна `KYIV_YMD`/`localYMD`. Fix проходить unit (mock Date), але seed без cross-midnight записів → live-response ідентичний UTC → регресія прихована.
**Probe (live):**

```
1. curl POST /reports/... columns=[dateField,valueField] groupBy=[] includeRows=true → raw timestamps
2. для кожного ts: utc_day=ts[:10] vs local_day=astimezone(TARGET_TZ).strftime('%Y-%m-%d') → count cross-midnight
3. якщо 0 → створити транзакцію cross-midnight (POST createdAt=<tomorrow-01:30-local>)
4. curl POST /reports/... groupBy=[dateField] aggregations=[SUM(valueField)] → server-agg
5. client: by_local_day[astimezone(TZ).ymd] += value
6. АСЕРТ server.tree[day].SUM == client.by_local_day[day] ∀ день + sum(all)==grandTotal
```

**Grep фіксу:** `toISOString().slice\(0,10\)|toISOString\(\).*substring\(0`; `getUTCHours|getUTCDate|getUTCMonth` разом з `Date`. Усі public export `common/utils/kyiv-date.ts` — один formatter.
**Фікс:** regression tests: DST-boundary літо+зима `T22:30:00Z`; DST-transition day; UTC-day boundary 00:00Z±1s. Anti-pattern: «unit з mock Date проходить→OK».
**Severity:** CRITICAL коли групування впливає на фінансово-звітну logic; MEDIUM UI-sort.
**Де ще:** aggregator з DateTime bucketing (normalizeKey/groupKey/dateGroup), report `{date,value}[]`, cache keys «сьогодні», cron у Docker без TZ, frontend chart labels.

### 2026-09-03 — Semantic aggregation drift: SUM over signed field включає значення що не впливає на ресурс (Bug #619) — backend / aggregation / business-invariant

**Сигнал:** реєстр декларує `signedByType`, aggregator рахує `SUM(field)` без ВИКЛЮЧЕННЯ типів що НЕ змінюють ресурс. StockMovement: RESERVATION/RESERVATION_RELEASE рухають `reserved`, не `quantity`; SettlementTransaction: PREPAYMENT_APPLICATION не змінює `balance` → числа-«привиди».
**Grep:** `signedByType`/`MovementType`/`TransactionType` разом з `SUM|reduce` — чи виключаються NON_PHYSICAL. `grep -n "quantityDelta|balanceDelta" *.service.ts`→delta=0 кандидати. Live: `curl POST /reports/... groupBy=[type]`→`Σ(бакети)==grandTotal` + non-mutation бакети SUM=0.
**Фікс:** whitelist `NON_PHYSICAL_MOVEMENT_TYPES=new Set([...])`; `numericValue` повертає `null` для non-mutation (SUM/AVG/MIN/MAX пропускають). Property-based `sumThroughAggregator(rows)==sumThroughService(rows)`.
**Severity:** HIGH коли поле фінансово-числове у management-звітах.
**Де ще:** SettlementTransaction.amount (PREPAYMENT/CREDIT_NOTE), Payment.amount (cash vs bonus/loyalty), Invoice.paidAmount (refunds), Bookkeeping Debit/Credit sign.

### 2026-09-03 — Formatter-metadata drift: рендер тип-специфічного значення шукає тип у списку який його НЕ містить (Bug #620) — frontend / contract-drift / display

**Сигнал:** формайтер (`fmtValue(alias,cols)`) резолвить тип через lookup у `columns`, але контекст містить поля ПОЗА columns (aggregation-only, footer grand-total). Backend віддає `aggregations:[{field,agg}]` без `type` → fallback (money-format/plain string).
**Grep:** `\.type|colType|fieldType` разом з `\.find\(c\s*=>\s*c\.key`; `grep -rn "cols\.find\|columns\.find" apps/web/src`. Live: `curl POST` з агрегацією що НЕ дублює колонку → чи є type/label у response.aggregations?
**Фікс (backend-first):** backend enrichment `{type,label}` до кожного array item «поля що буде показане». Формайтер приймає ОБИДВА джерела (aggregations, columns), fallback. Regression: backend `response.aggregations[0].type==entity.fields[key]`; frontend formatter з cols_without_field+aggregations_with_field.
**Severity:** HIGH коли розбіжність візуальна (дата як млрд грн, boolean як «0»).
**Де ще:** sortable headers з ONLY-sort полем, chart/dashboard computed metrics, Excel/PDF export з aggregation-only column.

### 2026-09-02 — Concurrent pre-check → write без row-lock → від'ємні лічильники силентно (Bug #613) — backend / concurrency / financial-integrity

**Сигнал:** `findFirst({select:{counter}})→GUARD→upsert/update({counter:{increment:-X}})` в одному `$transaction` без `Serializable`. Read Committed → 2 concurrent проходять guard на stale snapshot → другий декрементує до −N без сигналу (немає CHECK).

```bash
grep -rn "isolationLevel|Serializable" apps/api/src/modules/<hot-path>   # =0
grep -rn "CHECK.*<counter>" packages/database/prisma/migrations/   # =0
```

**Фікс (2 layers):** (Layer 1) `.select({counter})` у upsert + `if(upserted.counter<0)throw` (rollback у $tx); (Layer 2) `X.update({data:{field:{decrement:n}}})`→`X.updateMany({where:{id,field:{gte:n}},data})` (атомарний CHECK+DECREMENT, count=0→throw). Regression: `mockResolvedValueOnce({quantity:-10})→throw`; `mockResolvedValueOnce({count:0})→throw+next not called`; property `totalConsumed<=initial`.
**Severity:** HIGH (quantity/balance/reserved); MEDIUM non-critical counters.
**Де ще:** settlementAccount/cashRegister/bankAccount.balance, deliveryOrder.receivedQty, purchaseOrder.paidAmount — будь-який `findFirst→upsert/update({increment/decrement})` у Read Committed.

### 2026-09-09 — Stale-read status-guard → exactly-once ЗОВНІШНІЙ ефект → write без CAS-claim (Bug #711) — backend / concurrency / fiscal-integrity

**Сигнал:** метод робить `findFirst`+`if(row.status!==OPEN)throw`, потім НЕ-ідемпотентний зовнішній виклик (`provider.closeShift` Z-звіт, `sellReceipt` чек, SMS/gateway), потім `update({where:{id}})` без CAS на статус. Це #613 але для external side-effect (не лічильника): row-lock на фінальному update даремний — ефект стався ДО нього. Два concurrent (double-click/BullMQ retry/2 оператори) → 2 Z-звіти / 2 чеки / 2 SMS.

```bash
grep -rnE "async (close|finalize|issue|void|send)[A-Z]?" apps/api/src/modules --include="*.service.ts" -A20 | grep -B15 "provider\.\|sellReceipt\|closeShift\|fetch(\|axios\." | grep "status !==\|status ==="
```

**Виявлення:** знайти пару (status-guard) + (external exactly-once call) без `updateMany({where:{status}})` МІЖ ними. Еталон-контрприклад — `supplier-*.confirm()` (CAS-flip ПЕРШИМ). #613 навчив CAS для лічильників, для «Z-звіт РІВНО раз» урок не переноситься автоматично.
**Фікс:** CAS-claim `updateMany({where:{id,orgId,status:OPEN,deletedAt:null}, data:{status:CLOSED}})` ПЕРЕД external; `count===0→throw`. Best-effort revert на збої external. Метадані окремим update після успіху.
**Severity:** HIGH (фіскальний/грошовий); MEDIUM (повідомлення).
**Де ще:** cash-shift close/open, `*.processor` з external+status-flip, invoice issue→fiscal, gateway refund/void.

### 2026-09-09 — CAS захищає concurrency, але НЕ бізнес-max/діапазон (Bug #712) — backend / inventory / money-integrity

**Сигнал:** `updateMany({where:{id, counter:<expected>}, data:{increment:delta}})` (CAS проти подвоєння) БЕЗ парного fail-fast `if(existing+delta>max)throw`. DTO має лише `@Min(0)` без `@Max`, а дос'є/бізнес-правило декларує стелю («receivedQty не може перевищити quantity»). Один виклик з роздутим delta (прийом 100 на 10) проходить CAS чисто → over-receipt + роздутий SUPPLIER_CHARGE/RECEIPT.
**Виявлення:** CAS плутають з валідацією діапазону — РІЗНІ рівні (гонка vs межа). Для кожного monotonic-counter з `increment` — чи є fail-fast `existing+delta<=max` ПЕРЕД tx; DTO на `@Max`/кумулятивну; grep дос'є «не може перевищити» (задокументований-але-неіснуючий інваріант).
**Фікс:** fail-fast 4xx перед `$transaction`; для Float толеранс `EPSILON=1e-6` (не пряме `>` — IEEE-754-дрейф дав би хибне 400). Regression mutation-verified: over→400+no-write; boundary рівно-до-max→дозволено.
**Severity:** HIGH коли надлишок рухає склад/гроші.
**Де ще:** `receivedQty≤quantity`, `paidAmount≤amount`, `reserved≤quantity`, `WO.paidAmount≤totalAmount` — будь-який counter з бізнес-стелею.

### 2026-09-02 — 0 нових багів → property-based cross-invariant regression-guard (Bug #612) — backend / financial-integrity / property-based

**Сигнал:** явний bug hunt на фінансовій гілці (FIFO/AVG_COST, BALANCE_SIGN) → 0 нових активних багів. Example-based guards є, але не доводять інваріант для БУДЬ-ЯКОЇ послідовності — refactor `??→||` у cost-carry чи зміна знаку пройде example-based CI зеленим.
**Grep:** у sibling `*.invariants.spec.ts` наявність `fc.property` для КОЖНОГО інваріанту (FIFO span, cost-method порядок, all-or-nothing, AVG_COST sentinel, BALANCE_SIGN cycle, `??` vs `||`). Тільки `it()` = gap.
**Фікс:** новий `<module>.invariants.spec.ts` (10-25 property tests, 200-500 numRuns): **Consume** Σ output==input, нема ресурсу у мінус, all-or-nothing (throw+no mutation), порядок FIFO/LIFO; **Aggregation** Σ bucket==загальне, overflow→excess; **Sign/enum** exhaustive `Object.values(enum).forEach(t=>expect(SIGN[t]).toBeDefined())`; **`??` vs `||`** `expect(0??100).toBe(0); expect(0||100).toBe(100)`. Дзеркалити реалізацію у моделі-функції (`consumeBatchModel`), тестувати ІНВАРІАНТ не Prisma-мок.
**Severity:** MEDIUM (regression-guard). Критично не пропустити turn без внеску — «0 знайдено» без нових тестів лишає регресії відкритими.
**Де ще:** модуль з 3+ Bug'ів (financial cycle, FSM, sync outbox)→після 3-го fix property-based; multi-branch switch 3+; nullable-safe `??`.

### 2026-09-02 — Live-DB probe для DB CHECK/rollback/invariant верифікації — backend / operational-verification / live-evidence

**Сигнал:** попередні цикли додали defensive layers (CHECK, post-upsert re-check, updateMany conditional, self-wrap $transaction) покриті МОКАМИ. Жоден unit не доводить що Postgres ловить CHECK на UPDATE (не тільки INSERT), що `$transaction`відкочує mixed ORM+raw.
**Probe (фінальний цикл):** (1) **DB constraint** —`$executeRaw INSERT/UPDATE` з value що порушує → код (23514 check, 23503 FK, 23505 unique); ОБИДВІ операції. (2) **Rollback** — `$transaction(async tx=>{tx.model.create;tx.$executeRaw INSERT з CHECK-violation})`→count до/після однаковий. (3) **Invariant sweep** — `SELECT si.quantity, (SELECT SUM(sb.remainingQty)...) WHERE ABS(quantity-batchSum)>epsilon` (живі дані). (4) **Semantic map READ, not HARDCODED** — sign-мапу читати з коду (хардкод→false positive гірше за пропущений баг).
**Фікс:** CHECK не спрацював→`DO $$ ... IF NOT EXISTS`; rollback→nested `$transaction`/bare `prisma.`поза tx; invariant розійшовся→не патчити probe, розслідувати→clamp+backfill.
**Severity:** MEDIUM (verification-only) — фінальна валідація перед merge.
**Де ще:** міграція з CHECK/UNIQUE/FK,`createMovement`/`createTransaction` з self-wrap $transaction, recompute-функції з map як джерелом правди.

### 2026-09-02 — inventory cost-method switch + COGS writeback: 3-layer regression protocol (Bugs #609, #610, #611) — backend / financial-integrity

**Сигнал:** `feat: партійне FIFO-списання` — service multi-return (`{movementId,consumed,weightedCostPrice}` замість void), switch `costMethod:'FIFO'|'LIFO'|'FEFO'|'AVG_COST'` різний orderBy, caller записує cost назад. 3 concern у один $transaction: (1) cost-method switch (не-default гілка без тесту→asc↔desc refactor проходить); (2) writeback `if(result.weightedCostPrice!=null)db.workOrderPart.update` (spec не мокає write-side); (3) cost carry TRANSFER SEQUENTIAL `src=await writeoff();await receipt({price:src.weightedCostPrice??base.price})` (Promise.all→target бере lines.price).
**Probe/grep:**

```
- Cost-method matrix: PATCH /settings/organisation {costMethod} → seed 2-3 партії → WRITEOFF → правильна партія (LIFO новіша, FIFO старіша, FEFO createdAt asc null-expiry, AVG weighted)
- Global invariant: Σ StockBatch.remainingQty(active)==StockItem.quantity (raw GROUP BY HAVING <>)
- TRANSFER carry: RECEIPT 5×@40+5×@60→TRANSFER 8→target (5×40+3×60)/8=47.5 НЕ salePrice
- spec: expect(prisma.workOrderPart.update).toHaveBeenCalledWith (0=gap); orderBy per switch-branch
- await Promise.all([writeoff, receipt]) = regression (не carry-cost)
```

**Фікс:** 3 regression tests — writeback (single-batch/span/null-skip/multi-parts/no-price-arg); cost carry (src.weightedCostPrice у target; fallback null); orderBy switch (assert per cost-method `toHaveBeenCalledWith(objectContaining({orderBy:[...]}))`).
**Severity:** HIGH (#609,#610); MEDIUM (#611 silent drift LIFO/FEFO).
**Де ще:** `void→{compound}` service (grep sibling spec за новими компонентами), `createMovement(WRITEOFF)` з writeback, `switch(costMethod/paymentMethod/docType)`, Promise.all→sequential (`expect(callOrder).toEqual(['WRITEOFF','RECEIPT'])`).

### 2026-09-02 — після фінансової migration з backfill: audit invariant через live API (Bug #606, #607, #608) — backend+frontend / financial-integrity / migration-verification

**Сигнал:** `fix(settlements): виправлення знаку` / `add enum + backfill`. Знак балансу=функція типу, але семантика РІЗНА клієнт/постачальник (CHARGE:+1 клієнт «нам винен» ok; постачальник — «ми винні йому»). Old-code `receive()→CHARGE` неправильний знак → баланси постачальників додатні → `getSchedule(balance<0)` порожній. Fix: 3 нові enum (SUPPLIER_CHARGE/PAYMENT/REFUND)+backfill re-type+recompute balance=Σ signed. Міграція 2-стадійна (ADD ENUM окремо; DML backfill). FE знак-код паралельно розходиться (#606).
**Probe:**

```
1. Live invariant: balance==Σ BALANCE_SIGN(tx.type)×tx.amount ∀ акаунт (дзеркальний BALANCE_SIGN); ідемпотентність backfill
2. Cross-source: /reports/settlements totalCredit vs /supplier-payments/schedule totals — має збігатися для активних SUPPLIER/BOTH; різниця→soft-delete filter drift (#607)
3. FE sibling-drift: grep копій balance>0?'destructive':'success' — ≥2 файли; CLIENT vs SUPPLIER РІЗНА шкала
4. Exhaustive: Object.values(SettlementTransactionType).forEach(t=>expect(BALANCE_SIGN[t]).toBeDefined()) + expect(BALANCE_SIGN.CHARGE).toBe(1) (Record<enum> не ловить зміну середнього ключа — #606 root)
5. E2E: receive(X)→partial SP(Y<X)→balance=−(X−Y); SUPPLIER_REFUND(+1)→tx-log `SUPPLIER_REFUND` не `REFUND`
6. Client-regression: 5-10 CLIENT-акаунтів без жодного SUPPLIER_*
```

**Фікс:** тип-aware UI helper `settlementBalanceTone(balance,type)` у `lib/utils.ts` (CLIENT>0=red/<0=warning; SUPPLIER<0=red/>0=warning; BOTH nonzero→red) — ВСІ balance-header з ONE місця; nested soft-delete filter `where.counterparty={deletedAt:null}` у звітах; property `receive(X)−pay(Y)+refund(Z)→−(X−Y−Z)`.
**Severity:** HIGH (гроші, UI/reports узгодженість); backfill 139/139 але наступна зміна знаку→drift.
**Де ще:** Reconciliation act (новий aggregate/export/pdf дублює `type=='CHARGE'`), dashboard KPI «заборгованість», PDF pdfmake, sync-outbox зі старими типами, mobile settlements, share-token публічний акт-звірки PDF.

### 2026-09-01 — restore() без парент-chain guard → silent orphan (Bugs #601, #602, #603) — backend / data-integrity / soft-delete

**Сигнал:** новий `POST /:id/restore` над child (Vehicle→Garage→Counterparty; Contract→CP; Invoice→WO). `restore()` робить `updateMany({where:{id,orgId,NOT:{deletedAt:null}},data:{deletedAt:null}})` БЕЗ prep-check на активність parent-ів, хоча sibling `create/updateX/removeX` мають parent-guard. Live: `DELETE child→DELETE parent→POST child/restore→201`=orphan.

```bash
grep -rn "async restore" apps/api/src/modules --include="*.service.ts" -A5
# чи є findFirst({id:parentId,orgId,deletedAt:null}) ПЕРЕД updateMany? тільки updateMany = gap
```

**Фікс:** ОДИН `findFirst` перед restore: SELECT parent-chain через nested select; distinguisher — child не знайдено/чужа org→`NotFoundException`; double-restore (child активний)→`NotFoundException`; parent chain `deletedAt!==null`→`BadRequestException`(«Контрагента авто видалено. Спочатку відновіть.») з ПРІОРИТЕТОМ найдальшого предка. Vehicle (2 рівні): nested select 4 guards CP>garage>double-restore>tenant.
**Severity:** HIGH (data corruption через public API).
**Де ще:** WorkOrder/Invoice/PurchaseOrder/WorkOrderLine/StockDocument `.restore()`. `grep -rn "@Post.*restore"`. Regression 5 кейсів ∀ restore: happy→201; double→404; parent-CP deleted→400; parent-garage deleted→400; cross-tenant→404 (всі `expect(updateMany).not.toHaveBeenCalled()`).

### 2026-09-06 — Behavior-change fix + stale regression-guard який асертить СТАРУ поведінку (Bug #648) — frontend / test-integrity

**Сигнал:** race/async-фікс змінює що робить handler на подію (Enter тепер ФЛАШИТЬ debounce замість тихо ігнорувати), існуючий `*.test.tsx` досі асертить `expect(scanSubmit).not.toHaveBeenCalled()`/«НЕ викликається» — ДО-фіксну поведінку. Зелений ЛИШЕ за таймінгом (flush `.then()` резолвиться ПІСЛЯ синхронної асерції). **Тіль-тейл:** `Warning: An update to <Component> inside a test was not wrapped in act(...)` у тесті що перевіряє _відсутність_ дії.

```bash
git diff <range> -- 'apps/web/src/components/**/*.tsx' | grep -E "^\+.*(clearTimeout|debounceRef|timeoutRef).*null"
# → grep парні тести на .not.toHaveBeenCalled()/НЕ викликається для тієї ж події
```

**Фікс:** видалити stale тест (хибно-зелений guard шкідливіший за відсутній); замінити дискримінуючими тестами НОВОЇ поведінки з `flushMicrotasks()` (`await act(async()=>{await Promise.resolve();await Promise.resolve();})`) під fake timers. Довести дискримінацію: revert flush-гілки→нові падають.
**Severity:** MEDIUM (test-integrity — приховує майбутню регресію фіксу).
**Де ще:** picker/combobox/autocomplete з debounce+Enter (`search-picker-modal`, `search-combobox`, `GoodPickerModal`); будь-який `fix(review)`/`refactor(simplify)` що чіпає `setTimeout`/`clearTimeout`/AbortController у обробнику.

### 2026-09-09 — Same-data-другий-namespace invalidation gap: dashboard-віджет застаріває (Bug #718) — frontend / react-query

**Сигнал:** мутація ресурсу робить `onSuccess: invalidateQueries({queryKey: xKeys.all})` — але дашборд/summary-віджет тих самих даних живе під ІНШИМ деревом (`dashboardKeys.<widget>()`) і не інвалідується. Не cross-resource (#210 — про серверні side-effects); тут той самий ресурс, другий клієнтський namespace (дашборд свідомо тримає окремий `dashboard-data`-namespace для TopShell-prefetch/SSE). Найгостріше коли віджет фільтрує за станом який мутація змінює (expiring фільтрує `claimedAt=null` → claim мусить прибрати рядок, stale-віджет тримає). TopShell route-prefetch `/dashboard` теж часто не перелічує новий віджет.

```bash
grep -rn "dashboardKeys\.\|SummaryKeys\.\|Keys\.count\b" apps/web/src/hooks/api   # widget-ключ → ресурс-наповнювач → кожна мутація ресурсу інвалідує обидва?
```

**Фікс:** cross-namespace хелпер у `lib/cache-invalidation.ts` (дзеркалить `invalidateStockAffected`/`invalidateBalanceAffected` що вже кидають `dashboardKeys.all`); обидві мутації кличуть його в `onSuccess`. Regression: hook-тест spy на `client.invalidateQueries` → assert widget-ключ (revert→fail).
**Severity:** MEDIUM (UX stale до staleTime); HIGH якщо віджет гейтить фінансове рішення.
**Де шукати ще:** low-stock badge (writeoff/receipt), unpaid-count (payment), upcoming-ТО, notification-count.

### 2026-09-14 — Reference-lookup date WRITTEN Kyiv / READ UTC (курс валюти на дату) — backend / time-zone semantics

**Сигнал:** значення пишеться під Kyiv-датою (`KYIV_YMD.format()` у writer, напр. nbu-fetch), а читається/матчиться під UTC-датою (`instant.toISOString().slice(0,10)` у lookup, напр. `getRateAsOf(date:{lte})`). Розбіжність ЛИШЕ у вікні 00:00–03:00 Kyiv (EEST +03:00): lookup бере попередній день → хибне похідне значення АБО null → спурйозна 400 (вдень тест зелений). Виявлення: для кожного date-only lookup (`{lte/gte/equals: <date>}`, `@db.Date`) знайти ПАРНИЙ writer тієї ж таблиці й звірити базис (Kyiv vs UTC) — МУСЯТЬ збігатися. Grep `toISOString().slice(0, 10)` у сервісах (не тестах) → чи writer вживає `KYIV_YMD`/`kyivToday`/`kyivYmd`. Небезпечно коли balance/леджер НЕ зачеплені (баг тихий, маскується у base-звітності).
**Фікс:** спільний DST-aware helper (`kyivYmd(d)` в `common/utils/kyiv-date.ts`) на ОБОХ кінцях, не дублювати Intl inline. Regression: інстант у нічному вікні (`2026-09-14T22:30:00Z`=01:30 Kyiv 15-го) → lookup межа = Kyiv-дата (15-те), не UTC (14-те).
**Severity:** HIGH (хибне money-значення + спурйозний блок валідної операції).
**Де ще:** будь-який `*.service.ts` що резолвить курс/тариф/ліміт/шаблон «на дату» через `findFirst({date:{lte}})` з `new Date()`; payments/payroll cash-out (успадковують від `getRateAsOf`); мультивалюта (invoices/settlements amountBase по курсу на дату документа).

### 2026-09-03 — Dynamic Prisma include-builder: parent-leaf + parent.child.leaf → PrismaClientValidationError (Bug #617) — backend / dynamic-query

**Сигнал:** білдер (report-builder, dynamic search, saved views) з dot-path. Комбо коли ОДИН родич (`good`) юзається як leaf (`good.name`→select) І як шлях (`good.brand.name`→include)→`{good:{select:{name:true},include:{brand:...}}}` — Prisma не приймає include+select на одному рівні→`PrismaClientValidationError`→400. Unit на ОДИН шлях проходить; комбо норма (groupBy=good.name+good.brand.name).

```bash
grep -rn "select:.*true\s*}" apps/api/src --include="*.builder.ts"
```

Комбінаторний контракт-тест: пара `[parentA.leafA, parentA.subrel.leafB]`; registry-driven fuzz всіх пар/трійок→`POST /run`. Симптом: 400 «Некоректні дані запиту» на POST /dynamic = завжди баг серверного білдера.
**Фікс:** НЕ змішувати include+select на одному рівні — relation-branch з leaf+subrel ТІЛЬКИ через `select` (nested); корінь лишається `include`.
**Severity:** CRITICAL.
**Де ще:** `**/*.builder.ts`, `**/search.service.ts`, `**/saved-view*.ts`, `findMany({include:{...,select}})` з динамічними ключами.

### 2026-09-03 — PrismaClientValidationError мовчки ковтається у 400 без message-логу (Bug #618) — backend / observability

**Сигнал:** filter має `else if(exception instanceof Prisma.PrismaClientValidationError){return 400 "generic"}` БЕЗ `logger.warn/error` → реальна причина («Please either use include or select, but not both») відкидається. 100% — помилка серверного білдера (disguised 500).

```bash
grep -rn "PrismaClientValidationError" apps/api/src   # чи є logger.warn з exception.message?
```

**Фікс:** `logger.warn(\`${method} ${url}: ${lastNonEmptyLineOf(exception.message)}\`)`— ОСТАННІЙ непорожній рядок (Prisma кладе причину у кінець).
**Severity:** LOW user-facing, HIGH DX/observability. Правило: будь-який exception з серверної логіки має лишити слід у логах. Де ще: усі`else if(exception instanceof Prisma.\*)`— логувати`exception.message`навіть при 4xx;`mapPrismaErrorToHttp`(Bug #451-подібні мапінги — чи не втрачається`meta.target`).

### 2026-09-04 — Хардкоджений label службової колонки колізує з користувацьким полем даних (Bug #626) — frontend / dynamic-table / UX-clarity

**Сигнал:** динамічна таблиця-конструктор (Report Builder/pivot, `cols.map(c=><th>{c.label}</th>)`) додає ПОРУЧ службову колонку з хардкодженим label (`<th>Кількість</th>`, count/subtotal), а user вибирає поле даних з таким самим label→дві сусідні «Кількість» (сума vs merge-count). Aggregate-колонки не страждають (Σ/сер./мін./макс. префікс). Дані+вирівнювання коректні (review дає 0, colspan ідеальний).

```bash
grep -rnE "<th[^>]*>\s*(Кількість|Всього|Разом|Сума|Ціна)\s*<" apps/web/src/app --include="*.tsx"
grep -n "label: '<той-же-текст>'" apps/api/src/modules/*/registry*.ts
```

**Фікс:** унікальна назва службовій колонці (merge-count→«Склеєно»); АБО умовний label за режимом (`{hasGroups?'Кількість':'Склеєно'}`).
**Severity:** MEDIUM — вводить в оману у головному сценарії фічі. Виявляється ЛИШЕ живою eyes-on §5.4 — ганяти саме той user-path з фідбеку (з тими самими полями).
**Де ще:** будь-яка pivot/matrix де юзер вибирає колонки + движок домішує обчислені (count/subtotal/rank) з фіксованими назвами.

### 2026-09-06 — BullMQ delivery-status FSM на DB-записі: enqueue-gate + QUEUED→DONE/SKIPPED/FAILED anti-flicker (Bugs #661-#664) — backend / queue / status-machine / test-gap

**Сигнал:** nullable status-enum на DB-запис (`Payment.fiscalStatus`, `Notification.deliveryStatus`) який пише 2 сторони: (а) `create()` ставить QUEUED під гейтом (`willX=config?.requiresX===true`)+`queue.add(...).catch(...)`; (б) `@Processor`/`@OnWorkerEvent('failed')` рухає QUEUED→DONE/SKIPPED/FAILED. Комітиться з 0-1 тестом; 4 load-bearing точки без guard.

```bash
grep -rnE "fiscalStatus|deliveryStatus|\.add\(.*\).catch" apps/api/src/modules --include="*.service.ts"
grep -rn "@OnWorkerEvent\('failed'\)" apps/api/src/modules --include="*.processor.ts"
```

**Фікс:** guard на кожну гілку: (а) **enqueue-gate** true/false/unknown-config (`queue.add` called/not+`create.data.status`); (б) **enqueue-failure** `queue.add.mockRejectedValue`→`service.create` **resolves** (не throw)+`payment.update({status:'FAILED'})` (offline-first: фінансова операція вже повернулась); (в) **skip-конфіг**→`payment.update({status:'SKIPPED'})` (не лише «fetch не викликано»); (г) **anti-flicker** — FAILED ЛИШЕ на термінальній спробі (`attemptsMade>=opts.attempts`), інакше мигає між 288 ретраями. Mutation-verify: gate (`willX=true`)→false/null падають; прибрати `if(attemptsMade<attempts)return`→проміжний падає. verify-сервіс що повертає `{valid,...}` — асертити креди НЕ у поверненому (`JSON.stringify(res)` не містить ключа) на success І error.
**Severity:** HIGH (gate+enqueue-failure); MEDIUM (skip+anti-flicker).
**Де ще:** будь-який `@InjectQueue` з парним DB-status: checkbox/fiscal, sms, webhooks, prro (attempts=288), loyalty, followup. Після `feat: add <status>Status enum`+`ALTER TYPE`. Парне #346.

### 2026-09-06 — Тонкий external-API HTTP-клієнт (fetch-wrapper) з 0 тестів; recipe mock-global-fetch + token-never-logged (Bugs #683-#687) — backend / external-api / security / HIGH

**Сигнал:** новий `*.client.ts`/`*.gateway.ts` що інкапсулює зовнішній API (Checkbox/ПРРО/SMS/OAuth/postal) через `fetch()` — SSRF-guard+`redirect:'manual'`+`AbortController` timeout+reject-3xx+auth-header. Комітиться з **0 тестів** (processor-spec мокає клієнт цілком→жоден рядок не біжить у CI→SSRF/timeout/error-mapping невидимі).

```bash
for f in $(git diff HEAD~N --name-only | grep -E 'client\.ts$|gateway\.ts$'); do [ -f "${f%.ts}.spec.ts" ] || echo "NO SPEC: $f"; done
```

**Фікс (recipe):**

- **mock global fetch:** `vi.stubGlobal('fetch',fetchMock)`+helper `OK(body,status)` `{status,ok,text:()=>Promise.resolve(JSON.stringify(body))}`; `afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})`.
- **auth per method:** `fetchMock.mock.calls[0][1].headers` — Bearer=token на authed, alternate (X-License-Key) на sign-in, `Authorization` undefined на sign-in.
- **SSRF-before-fetch:** localhost/169.254/RFC1918/non-http→`rejects`+`expect(fetchMock).not.toHaveBeenCalled()`.
- **3xx→reject:** [300,301,307,308,399]→reject; `redirect:'manual'` завжди; 401→спец-error-клас.
- **timeout:** happy `signal instanceof AbortSignal`; abort `fetchMock.mockImplementationOnce((_u,opts)=>new Promise((_,rej)=>opts.signal.addEventListener('abort',()=>rej(new DOMException('aborted','AbortError')))))`+`vi.useFakeTimers()`+`vi.advanceTimersByTimeAsync(TIMEOUT+1)`.
- **cents:** `Math.round(amount*100)` (35.2→3520 не 3519).
- **token-never-logged:** у processor spec замокати ВСІ рівні logger (`for lvl of ['log','debug','warn','error']`)→`expect(JSON.stringify(logged)).not.toContain(secretToken)` для success І 401→refresh; sanity `logged.length>0`.
- **секрет не у DTO:** `expect(JSON.stringify(dto)).not.toContain(secret)`+`not.toHaveProperty('<secretField>')` на КОЖНОМУ DTO-виводі.
- **mutation-verify token-lifecycle:** skew-межа кешу (`expiry>now+SKEW`) — тест на межі→re-sign-in + +1ms→кеш; `>`→`>=` валить. tenant-scope refresh (`updateMany where{id,orgId}`) — cross-org→no-op→NotFound. P2002-recovery winner→OK + null→rethrow.
  **Severity:** HIGH (SSRF+auth+money+secret; token-log-leak HIGH).
  **Де ще:** будь-який `*.client.ts`/`*.gateway.ts`/`*.provider.ts` з fetch/axios; token/session-lifecycle (`ensureX`/`refreshX`/`signIn`/`getValidToken`); processor-спеки що мокають клієнт. Парне #273, #652, #661-#664.

### 2026-09-08 — re-sign-in/retry-гілка зі СТАТИЧНИМ токеном + fiscal-мапінг лише 2 методів (Bug #707-#708) — backend / integration-provider / HIGH+MEDIUM

**Сигнал:** provider-abstraction `signIn→openShift→sell→close`, processor на auth-error `refreshToken`→повтор. (1) **Doomed-token re-sign loop:** один провайдер реалізує `signIn` як «повернути той самий статичний токен» (Вчасно — токен у кабінеті) — на відміну від exchange-провайдера (Checkbox: PIN→новий). Якщо статичний токен генуїнно недійсний → `refreshToken`→`signIn` дає ТОЙ САМИЙ поганий → знову 401. Тест покриває лише 401→refresh→2-й-sell-OK, НЕ «падає обмежено (BullMQ attempts-cap) а не вічно». (2) **Fiscal method-мапінг лише 2:** `sell` мапить `method==='cash'?CASH:CASHLESS`+`cents=Math.round(amount*100)`, тест лише cash+card → решта (card_terminal/bank_transfer/privat24_qr/monobank_qr/liqpay_qr) без прицільного регресу; інваріант `goods.price==payment.value` не асертиться.
**Фікс:** (1) processor-spec «doomed-token» — `sellReceipt.mockRejectedValueOnce(AuthErr).mockRejectedValueOnce(AuthErr)`,`refreshToken.mockResolvedValueOnce(sameBadToken)`→`rejects AuthErr`+`refreshToken` 1×+`sellReceipt` 2× (не >2)+`paymentUpdate` НЕ викликано; + «onFailed на attemptsMade=opts.attempts→FAILED рівно раз». (2) provider-spec параметричний money на 8 амаунтів (0.1+0.2→30, 8.61→861, 1.005→100 float, великі) з `goods.price==payment.value` + параметричний мапінг усіх методів seed→CASH/CASHLESS + порожня/wrapped відповідь ({}/text=""/{other:1}→кидає; {fiscal:{id}}→читає). Mutation: обгорнути 2-й sell у власний try/catch+retry→doomed-token падає (refreshToken 2×,sellReceipt 3×); зламати мапінг `method!=='card_terminal'?CASH:CASHLESS`→5 падають.
**Severity:** HIGH doomed-token (нескінченний re-sign вичерпав би rate-limit, завис би job без FAILED); MEDIUM money-мапінг (консистентний з Checkbox, 0 прицільного захисту).
**Де ще:** будь-який `*.provider.ts`/`*.gateway.ts` з `signIn`/`getToken` — розрізнити exchange-token vs static-token; processor з `catch(AuthError){refresh;retry}` — чи retry НЕ у власному loop; fiscal/payment sell-мапінги проти повного `seed.ts` методів + online `_qr`. Додає до #683-#687: «класифікація token-lifecycle провайдера» + «повнота method-enum».

### 2026-09-13 — Non-type-aware required-guard рахує УМОВНО-ПРИХОВАНЕ поле як валідне (Bug #739) — frontend+backend / form-validation / conditional-field / HIGH

**Сигнал:** форма приховує поля залежно від дискримінатора (`{f.type !== 'SUPPLIER' && <Ім'я/>}`, mode/category-based), АЛЕ агрегатний required-guard («є хоч якась назва») перевіряє ті ж поля БЕЗ звірки з дискримінатором (`companyName || firstName || lastName`). При дедупі форм ймовірно: спільний компонент рендерить умовно, guard винесено «загальним». Значення у стані форми (лишок після перемикання type) невидиме користувачу, але guard зараховує. tsc/review/тести зелені (форма — валідна підмножина union; брехня лише при послідовності перемкнути тип→лишок імені→порожня компанія). Виявлення: для кожного умовно-рендереного input чи його значення входить у required-guard і чи guard звіряється з ТИМ САМИМ дискримінатором. Крос-шар: FE-guard (`validate*`/`hasName`) І backend cross-field guard type-aware — сирий API оминає FE. Live: `POST {type:'SUPPLIER', firstName:'Іван'}` (без companyName) проходить = баг.
**Фікс:** type-aware guard у СПІЛЬНИЙ компонент форми (єдине джерело), reuse у всіх write-місцях (модалка+inline-edit) + дзеркалити на backend. Для editable-дискримінатора backend merged-guard бере ЕФЕКТИВНИЙ type (`dto.type ?? existing.type`) — додати дискримінатор у `existing` select. Не «очищати» приховане поле через formToPatch (`''→undefined` не затре БД).
**Severity:** HIGH (тихе порушення інваріанта + осиротіле недоступне поле, масковане displayName-fallback).
**Де ще:** будь-яка форма з type/mode/category-прихованням + агрегатний required-guard: Counterparty (fixed), Good pricing-mode, Employee rate-scheme, WorkOrder vehicle-vs-anonymous, будь-який `discriminatedUnion` write-форма. Сібл #728 (інверсія: там форма не дає створити валідне, тут ПРИЙМАЄ невалідне).

### 2026-09-15 — Component-тест з дефолтним waitFor timeout (1000ms) flaky під повним паралельним suite (Bug #746) — frontend / test-infra / MEDIUM

**Сигнал:** окремий web-spec passes в ізоляції (`vitest run <файл>` → all green), але падає у повному `vitest run src` як `1 failed | N passed` на `await waitFor(() => expect(...))` без явного timeout. Типово це модалка з async-mount (reference-fetch каси/банку/методів через React Query) + POST-round-trip через `mutateAsync`→`apiFetch`. Повний suite має важкий environment/transform setup (сотні секунд) → async microtask-flush окремого тесту голодує під паралельним навантаженням, а дефолтний `waitFor` timeout=1000ms замалий. У repo вже є усталений патерн `{ timeout: 2000 }` (CreateWorkOrderModal.test.tsx, DocumentCreateModals.test.tsx, command-palette.test.tsx) — новий/дедуплікований spec його часто НЕ успадковує.

**Причина виникнення:** розробник копіює тест-скелет без явного timeout бо «в ізоляції зелено»; CI/локальний ізольований прогін маскує проблему. Дедуп модалок (декомпозиція) додає новий async-шар (хук замість inline fetch) → більше awaited-tick-ів до першого render/enable.

**Підхід до виявлення:** якщо повний suite падає, а `vitest run <той-самий-файл>` — ні → це starvation, НЕ продуктовий баг. Підтвердити: тест перевіряє продуктовий інваріант (idempotency/double-submit/rollback), логіку якого можна відтворити в ізоляції. Grep кандидатів: `grep -rLn "timeout:" apps/web/src/**/__tests__/*.tsx` серед файлів що мають `mutateAsync`/`apiFetch` POST + `waitFor`.

**Підхід до фіксу:** фіксувати ТЕСТ (не компонент) — додати `{ timeout: 2000 }` до всіх async `waitFor`/`findBy` у spec-і (дзеркалить усталений repo-патерн). НЕ чіпати компонент: sync-guard/idempotency verify в ізоляції. Верифікувати повторним прогоном ПОВНОГО suite ×2-3 на стабільність.

**Severity:** MEDIUM (flaky false-negative — блокує CI/коміт, маскує реальні падіння шумом, але не продуктовий дефект).

**Де шукати ще:** будь-який web component-spec з async-mount модалки + POST через React Query mutation: SupplierPaymentCreateModal (fixed), PaymentCreateModal, CreateWorkOrderModal (вже має timeout), DocumentCreateModals (вже має), будь-яка `*CreateModal.test.tsx`/`*EditModal.test.tsx` без явного waitFor timeout.

### 2026-09-15 — Рефакторинг-агрегатор загубив інваріант-guard оригіналу (dedup goodId) (Bug #748) — backend / business-logic / data-integrity / HIGH

**Сигнал:** нова generic-абстракція (adapter/registry/pipeline) замінює N спеціалізованих методів, що робили те саме (тут: `applyImport`→`replaceLines` vs легасі `importPOLines`/`importSDLines`/`importWOParts`). Легасі-методи мали ЗАХИСНИЙ guard (`seenGoodIds` Set + помилка «Дублікат товару у файлі»), а нова уніфікована реалізація його НЕ перенесла — будувала writes прямим `.map()` без дедупу. Bulk-write (`createMany`) на таблицю БЕЗ `@@unique(docId, entityId)` тихо створює дублікати → задвоєні кількість/сума. tsc/review/unit зелені: кожен метод дивиться ізольовано, unit-специ дублі не покривають, БД дублі не відхиляє.

**Причина виникнення:** розробник рефакторить «щасливий шлях» (резолв→запис), а захисні guard-и оригіналу — периферійні рядки, які легко проґавити при переписуванні. «Новий код виглядає чистіше» маскує втрату інваріанта.

**Підхід до виявлення:** при заміні спеціалізованого коду на generic — diff СТАРОГО і НОВОГО на _захисні_ конструкції (`seen*`/`Set`/`dedup*`/дублікат-guard/`skipDuplicates`/unique-check), не лише на happy-path. Для КОЖНОГО bulk-write (`createMany`) у нову таблицю: перевірити чи є `@@unique` що ловить дублі-ключі (`grep "@@unique" schema.prisma` по моделі) — якщо НЕМА, дедуп МУСИТЬ бути в коді. Крос-порівняння: `git log`-знайти попередній «спеціалізований» метод що робив те саме, звірити guard-набір.

**Підхід до фіксу:** перенести guard оригіналу у generic-реалізацію (тут: `seenGoodIds` дедуп ПІСЛЯ резолву entity-id — різні вхідні ключі можуть вказувати на один рядок; лишати перше входження, дзеркалити семантику легасі). +регресійний тест на дублікат (два входи→один write).

**Severity:** HIGH (тиха data-corruption: задвоєні document totals, без винятку/логу).

**Де шукати ще:** будь-який adapter/registry/strategy-рефактор що замінив кілька схожих методів; будь-який `createMany` у line/movement/transaction-таблицю без `@@unique(parentId, childId)` — PurchaseOrderLine, StockDocumentLine (обидва без такого unique), будь-який bulk-importer/bulk-copy/duplicate-document.

### 2026-09-15 — Створення сутностей ПОЗА транзакцією застосування (Bug #749) — backend / transactional-integrity / MEDIUM

**Сигнал:** сервіс-метод у циклі створює довготривалі сутності (`Good`/`Brand` через інший сервіс) ДО і ПОЗА `prisma.$transaction`, у якому потім атомарно пишуться залежні рядки. Якщо будь-який рядок циклу кине (Conflict/валідація) — вже створені сутності попередніх ітерацій закомічені, але фінальний запис не відбувся → сироти. Ознака: `await otherService.create(...)` всередині `for` перед окремим `await this.prisma.$transaction(...)`.

**Причина виникнення:** сусідні сервіси (`GoodsService.create`) не приймають `tx: TransactionClient` → неможливо викликати їх усередині транзакції без рефактору; розробник лишає їх зовні «бо так простіше», не помічаючи неатомарність.

**Підхід до виявлення:** grep `await .*Service\.create\(` / `\.upsert\(` у тілі методу що МАЄ окремий `$transaction`; перевірити чи create-виклики поза межами tx-callback. Live-probe: apply із валідним рядком-1 + конфліктним рядком-2 (дубль SKU) → рядок-1 Good створено, документ порожній = сироти.

**Підхід до фіксу:** зробити сусідній сервіс tx-aware (додати опційний `tx` параметр, використати `tx ?? this.prisma`) і перенести create-и всередину `$transaction`; АБО валідувати ВСІ рядки (existence/required) перед будь-яким create, щоб частий клас помилок (валідація) не лишав сиріт. Якщо повний фікс ширший за scope — задокументувати як відомий патерн, не «тихо лишати».

**Severity:** MEDIUM (неатомарність лише при помилці в середині batch; рідкісна оператор-операція).

**Де шукати ще:** будь-який bulk-apply/import/copy що створює довідникові сутності + пише залежні рядки; wizard-apply endpoints; `*.service` методи де `create` іншого агрегату передує локальному `$transaction`.

### 2026-09-16 — Ліміт/пагінація на АБСОЛЮТНОМУ індексі рядка замість кількості ЗІБРАНИХ (Bug #750) — backend / iteration-limit / off-by-domain / HIGH

**Сигнал:** ітератор колекції з розривами (ExcelJS `sheet.eachRow((row, idx) => ...)` пропускає порожні рядки; так само курсор/розріджений масив/Map із дірками) обмежується умовою на `idx` самого ітератора (`if (idx > cap) return`), а НЕ на кількості вже зібраних елементів (`if (out.length >= cap) return`). Коли перший елемент має великий природний індекс (порожні провідні рядки → дані з рядка 30) або є розрив посередині — вся вибірка або обрізається набагато нижче ліміту, або стає ПОРОЖНЬОЮ, попри достатньо даних. Тихий фейл: total-лічильник (`actualRowCount`) правильний, а `rows` порожній → UI «показано 0 з N».

**Причина виникнення:** розробник ототожнює «номер рядка/елемента» з «порядковим номером у результаті», припускаючи щільну нумерацію з 1 без розривів. ExcelJS `eachRow` спеціально пропускає порожні рядки, тож `idx` ≠ ordinal.

**Підхід до виявлення:** grep у файлах з `eachRow`/`forEach.*idx`/розрідженими структурами: умова `idx >`/`idx <`/`idx >=` для ліміту чи startRow разом із `push` у вихідний масив. Live-probe: збудувати книгу де дані починаються з рядка 30 (`sheet.getRow(30).getCell(1).value=...`) АБО з розривом посередині → перевірити що `rows.length === min(cap, dataRows)`, а не 0. Симптом у UI: «показано 0 з N».

**Підхід до фіксу:** накладати обмеження на `out.length >= cap` (кількість зібраних), а не на індекс ітератора; параметр `idx` прибрати з колбека якщо більше не потрібен. Total-count лишати з окремого джерела (`actualRowCount`). Той самий принцип для startRow-зсуву: рахувати від зібраних, не від абсолютного номера, якщо семантика — «перші N рядків даних».

**Severity:** HIGH (тихо ламає ключову функцію для валідного вводу; без винятку й без логів).

**Де шукати ще:** будь-який `eachRow`/`eachCell`/`worksheet.getRows` з обмеженням; parseMappedRows/parse* що фільтрують порожні рядки; пагінація/take над курсором що рахує сирі позиції; будь-який `if (i > limit) break` де `i` — індекс джерела з можливими розривами.

### 2026-09-16 — Сира помилка бібліотеки-парсера не нормалізована → 500 з англомовним стеком (Bug #751) — backend / error-normalization / i18n / MEDIUM

**Сигнал:** `await lib.load(buffer)` / `lib.parse(...)` (ExcelJS `workbook.xlsx.load`, jszip, csv-parse, sharp, pdf-парсери) на невалідному вводі кидає СИРИЙ `Error` бібліотеки (англомовний, з внутрішнім стеком). У методі немає `try/catch` навколо виклику → NestJS віддає 500 замість дружнього 400. Особливо гостро коли ендпоінт викликається автоматично одразу після вибору файлу користувачем (передперегляд) — випадковий .csv/.txt/.pdf дає 500.

**Причина виникнення:** парсер-бібліотеки не нормалізують помилки у доменні винятки; upstream-хелпер (наприклад `getUploadedFile`) ловить лише транспортні помилки (multipart), не помилки парсингу; розробник тестує лише на валідних файлах.

**Підхід до виявлення:** grep виклики `.load(`/`.parse(`/`parseCSV(`/`readFile` парсер-бібліотек, перевірити наявність `try/catch` з `BadRequestException` (українською). Live-probe: подати plain-text/random-binary/порожній буфер → очікувати `BadRequestException`, а не сирий `Error`/500.

**Підхід до фіксу:** обгорнути виклик парсера в `try { await lib.load(...) } catch { throw new BadRequestException('<українське повідомлення>') }`. Не покладатись на upstream-catch — нормалізувати біля точки парсингу. Перевірити, що frontend деградує м'яко (onError), і додати regression-тест з невалідним буфером.

**Severity:** MEDIUM (порушує CLAUDE.md rule #17 «API-помилки українською»; UX-регрес для типової помилки користувача).

**Де шукати ще:** усі `parse*`/`import*` методи xlsx.service (parseGoods/parsePOLines/parseMappedRows — той самий сирий-Error клас, легасі); будь-який upload-ендпоінт що парсить файл; image/pdf/zip-обробники.

---

### 2026-09-16 — Derived-лічильник ≠ action-фільтр (оманливий count + дірявий disabled) — Область: frontend

**Bug #752.** Багатокроковий майстер/список показує «Обрано: N», де `N = items.filter(x => x.included).length`, а submit-handler збирає payload СТРОГІШИМ предикатом (`ambiguous` без обраного товару → skip; `notFound` з порожньою назвою → skip). Disabled-guard кнопки дивиться лише на `includedCount === 0`. Наслідок: «Обрано: 3», кнопка активна, клік → toast «Немає рядків» або «Додано 1» замість 3. POST не битий (silent-skip коректний), але UX бреше і дія no-op-ить.

**Сигнал:** submit-handler-цикл (`for (const row of rows)`) з кількома `continue`, які фільтрують готовність (`!res.selectedGoodId`, `if (!name)`), тоді як user-facing лічильник і `disabled={...Count === 0}` враховують лише перший/жоден із них. Розходження предикатів «показано» vs «реально відправлено».

**Причина виникнення:** «included» здається природним і для лічильника, і для disabled — але це стан НАМІРУ, а не ГОТОВНОСТІ. Готовність вимагає ще й валідних даних рядка (обраний товар / непорожня назва), логіка яких живе лише всередині handler.

**Підхід до виявлення:** для кожного `.filter(x => x.included/selected/checked)`-лічильника знайти submit-handler того ж компонента; звірити його `continue`-умови з предикатом лічильника. Розбіжність → лічильник оманливий + disabled дірявий. Live: обрати рядки, які handler пропустить (ambiguous без вибору / порожня назва) → перевірити, чи кнопка активна і чи клік дає no-op-toast.

**Підхід до фіксу:** винести спільний `isRowApplyable(row, res)` — ЄДИНЕ джерело правди для (1) лічильника готовності `readyCount`, (2) збірки payload у handler, (3) `disabled={readyCount === 0}`. Показати `readyCount` окремо («до імпорту: K») коли `K !== includedCount`, щоб «Обрано» лишалось чесним. Регресія: ambiguous-included-без-товару / notFound-порожній → readyCount=0, кнопка disabled, POST 0×; інверсія×2 → початковий набір.

**Severity:** LOW (UX; без псування даних/падінь/битого POST). Escalate до MEDIUM якщо оманлива дія стосується грошей/списання і користувач впевнений, що відправив більше, ніж пішло.

**Де шукати ще:** будь-який bulk-select / multi-step wizard / кошик де count і submit розходяться: ExcelImportWizard (fixed), масові дії у таблицях (bulk archive/delete/assign), «додати вибрані у документ», reservation-picker, будь-який `selectedCount` поряд з handler-циклом що має `continue`.

---

### 2026-09-17 — Component-тест RHF-модалки зі схемою `.uuid()`: placeholder-id фікстури тихо блокують submit — Область: frontend (test-authoring)

**Фаза 5 WorkOrder bug-hunt (0 продуктових багів; ця пастка з'їла ~3 ітерації тесту).** Коли модалку мігрують value-based useState → RHF+`zodResolver(<formSchema>)`, схема зазвичай тісніша за старий ручний guard: FK-поля стають `z.string().uuid('Оберіть...')`. Component-тест з давніми placeholder-фікстурами (`{ id: 'e1' }`, `prefill:{vehicleId:'v1', counterpartyId:'cp1'}`) тепер **не проходить `safeParse`-гейт** у `create()`/`save()` (`const parsed = schema.safeParse(getValues()); if (!parsed.success) { setError(...); return; }`). Наслідок підступний: submit-handler повертає РАНО — **жодного POST не летить**, `onClose` не викликається, а `setError('Оберіть виконавця')` показує повідомлення, якого широкий регекс тесту (`/не обрано|Помилка|Перевірте/`) НЕ ловить. Тест «зеленіє на дотик» (рендер ок, кнопка enabled) але НІКОЛИ не доходить до idempotency/retry/double-submit логіки, яку нібито перевіряє → хибно-зелений guard критичного money-шляху.

**Сигнал:** у component-тесті RHF-модалки після кліку submit — `apiFetchMock` НЕ отримав POST, `onClose` не викликаний, помилки в DOM немає (або є, але не та, що очікує assert). Особливо коли фікстури — короткі рядки (`'e1'/'v1'/'cp1'/'b1'`), а схема (`git show HEAD:packages/shared/src/schemas/forms/<x>.schema.ts`) має `.uuid()`.

**Причина виникнення:** фікстури писались до RHF-міграції під ручний guard `if (!form.vehicleId)` (будь-який непорожній рядок проходив). Міграція на спільну zod-схему додала `.uuid()`, але тести не оновили — placeholder-id лишились. `safeParse` тихо валить submit ще ДО `setSaving`, і без POST немає що асертити.

**Підхід до виявлення:** перед написанням/оновленням component-тесту RHF-модалки — прочитати її form-схему і виписати КОЖНЕ `.uuid()`-поле; усі відповідні фікстури (prefill + мок-довідники, що заповнюють Select/picker) МУСЯТЬ бути валідними UUID (`xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx`). Швидкий детектор першопричини «тест не постить»: тимчасово залогувати `schema.safeParse(getValues())` або дампнути ВСІ error-тексти (не звужений регекс) — побачиш точну назву поля-порушника. Пікер-обрані значення (employeeId з `<Select value=...>`, workId з picker `onSearchSelect`) теж мусять бути UUID — не лише prefill.

**Підхід до фіксу:** підняти константи-UUID у тесті (`const EMP_UUID='55555555-5555-4555-8555-555555555555'`), заповнити ними мок-довідники (`{items:[{id:EMP_UUID,...}]}`) і prefill. Assert-регекс помилки НЕ звужувати до підмножини повідомлень — або матчити конкретне очікуване, або дампати всі. Після фіксу — переконатись, що POST РЕАЛЬНО летить (`expect(mock).toHaveBeenCalledWith('/<endpoint>', ...)`), інакше guard і далі порожній.

**Супутнє (не баг):** inline-інпути `type="number"` (normoHours/price/quantity/plannedHours) НЕ приймають кому у браузері/jsdom — UA-кома `1,5` не долітає з такого поля. Кома-aware form-схема (`optionalMoneyNumber`/`moneyString`) — захисний backstop для free-text значень і програмного вводу, а не для number-input. UA-кому submit-гейту перевіряй на рівні СХЕМИ (`schema.safeParse({lines:[{normoHours:'1,5'}]}).success===true`), а не набором у number-input компонента.

**Severity:** MEDIUM (сам тест — LOW-код, але хибно-зелений guard критичного money-шляху = release-blocker за §0: ховає майбутні регресії idempotency/double-submit).

**Де шукати ще:** будь-яка `*CreateModal.test.tsx`/`*EditModal.test.tsx` мігрована на `zodResolver` зі спільною `<x>FormSchema` (Invoice/PO/StockDocument/SupplierPayment/SupplierReturn/WorkOrder); будь-який тест що драйвить submit через picker/Select і асертить POST/idempotency; кожен новий тест до RHF-модалки з `.uuid()`-полями у схемі.

### 2026-09-17 — Startup env-схема СТРОГІША за рантайм-споживача, який вона дзеркалить (Bug #757) — Область: backend / config-validation / dev-UX

**Аудит backend #1 «fail-fast env-валідація через zod».** Нова `envSchema` для `ConfigModule.forRoot({validate})` наклала формат-правило `NOTIFICATION_ENC_KEY: z.string().min(32)` у ВСІХ середовищах. Але реальний споживач ключа — `EncryptionService.onModuleInit` — робить `createHash('sha256').update(raw).digest()`, тобто приймає БУДЬ-ЯКУ непорожню довжину й нормалізує у 32 байти. 5-символьний dev-ключ працював у рантаймі, а тепер валить startup dev/test з «має бути ≥ 32». Схема стала строгішою за код, який вона мала лише віддзеркалити → регресія: конфігурація, що працювала, більше не піднімає застосунок.

**Сигнал:** startup-валідатор (zod/Joi у `validate`/`validationSchema`) відхиляє значення, яке фактичний споживач цієї змінної приймає й обробляє. Формат-правило (`.min`/`.regex`/`.url`/`.length`) на змінній, чий сервіс-конструктор/`onModuleInit` нормалізує або толерує ширший діапазон (SHA-нормалізація довільної довжини, `?? default`, try/catch-фолбек, «порожнє → фіча off»). Dev/test-старт падає на конфізі, який раніше працював.

**Причина виникнення:** валідатор писався «щоб було строго й безпечно», з мінімумом узятим з `.env.example` (де ключ довгий), БЕЗ звірки з фактичним контрактом споживача. min-32 — легітимний prod-hardening проти слабкої ентропії, але його наклали як always-on формат, а не prod-gated hardening. Змішали дві осі: FORMAT (валідний скрізь) vs PRESENCE/HARDENING (лише prod) — філософія файлу декларувала розділення, реалізація його порушила саме для цього поля.

**Підхід до виявлення:** для КОЖНОГО поля startup-схеми з формат-обмеженням знайти реального споживача (`grep "<KEY>" src` → сервіс що читає `config.get('<KEY>')`) і звірити: чи сервіс дійсно вимагає це обмеження, чи він толерантніший? Особливо: (1) значення, що хешуються/нормалізуються перед вжитком (SHA/PBKDF будь-яку довжину приймають) → min-length у схемі зайвий поза hardening; (2) поля з рантайм-дефолтом (`?? '...'`) → `.optional()` доречно, але не роби «присутнє АЛЕ коротке» жорсткою помилкою; (3) «порожнє → фіча вимкнена» семантика (як тут empty → encryption off) → формат не має блокувати проміжні валідні стани. Live-probe: `validateEnv({ NODE_ENV:'development', <KEY>:'<коротке-але-робоче>' })` НЕ має кидати, якщо сервіс це значення приймає.

**Підхід до фіксу:** розділити осі. FORMAT-перевірки (тип/coerce/url/enum) — на полі, застосовуються скрізь. HARDENING (min-entropy, min-length сильного секрету) — у prod-gated гілці (`superRefine`/окрема prod-функція), лише коли `NODE_ENV==='production'`. Проміжні стани (empty=off, коротке-але-нормалізоване) лишаються валідними у dev/test. Регрес-тести обов'язково двобічні: коротке у dev/test → НЕ кидає; коротке у prod → кидає; порожнє → дозволене скрізь; рівно-межа у prod → валідне.

**Severity:** MEDIUM (dev-UX регресія: блокує старт на раніше-валідному конфізі; HIGH якщо блокує CI/інсталятор на дефолтних значеннях `.env.example`/`.env.dev`).

**Де шукати ще:** кожне поле env-схеми з `.min`/`.length`/`.regex`, чий сервіс толерантніший (хешовані ключі, `?? default`, try/catch-фолбек, «порожнє → off»): JWT-секрети (використовуються СИРИМИ як HMAC — там min-length легітимний, НЕ послаблювати), MinIO-креди, будь-який `*_ENC_KEY`/`*_SECRET`/`*_TOKEN` що нормалізується. Прогнати `validateEnv` проти фактичних `.env.dev`/`.env.example` при кожній зміні схеми.

### 2026-09-17 — Zod object-level `.refine`/`.superRefine` тихо ПРОПУСКАЄТЬСЯ при base-parse issues → агрегація помилок короткозамикається (Bug #758) — Область: backend / config-validation / error-aggregation / diagnostics

**Той самий аудит.** prod-strict presence реалізовано через `.superRefine` на об'єктній схемі. Zod НЕ виконує object-level refinement, якщо base-parse (парсинг полів) дав хоч один issue. Тобто одна format-помилка (кривий `PORT='nope'` → coerce-fail) короткозамикає ВЕСЬ prod-strict блок: повідомлення містить лише `PORT: Expected number`, а перелік відсутніх prod-секретів (DATABASE_URL/JWT/MINIO/ENC_KEY) зникає. Це нищить сенс агрегованого fail-fast — оператор на ПК СТО фіксить помилки ітеративно, по рестарту на змінну, замість побачити повний перелік одразу.

**Сигнал:** агрегатор помилок валідації, що спирається на `.refine`/`.superRefine`/`.transform` НА ОБ'ЄКТНОМУ рівні для cross-field/presence-перевірок, показує НЕПОВНИЙ перелік, коли одночасно є field-level format-помилка. Тест «повідомлення містить і format-issue, і refine-issue» падає: refine-issue відсутній. Симптом у проді: «виправив одне — вилізло наступне» замість «усі проблеми в одному переліку».

**Причина виникнення:** розробник припускає, що `safeParse` акумулює УСІ issues (field + refine) перед поверненням. Насправді Zod при провалі base-parse об'єкта пропускає його object-level refinements (щоб не бігти по невалідних даних). Для валідатора-агрегатора, де сенс саме у ПОВНОМУ переліку, це прихована втрата діагностики — happy-path тести (усе валідне, або лише presence-issues) зелені, дірка лише на суміші format+presence.

**Підхід до виявлення:** для агрегатора, що обіцяє «повний перелік проблем» — тест зі ЗМІШАНОЮ помилкою: одне поле з невалідним ФОРМАТОМ (провалить base-parse) + інша умова, що ловиться лише refine/superRefine (presence/cross-field) → assert що повідомлення містить ОБИДВІ. Якщо refine-issue зникає при наявності format-issue — короткозамикання підтверджено. Grep патерну ризику: `grep -rn "superRefine\|\.refine(" src/**/*schema*.ts` де той самий валідатор кидає агрегований перелік.

**Підхід до фіксу:** винести cross-field/presence-перевірки з object-level `.superRefine` у НЕЗАЛЕЖНУ функцію, що працює по СИРОМУ input і виконується ЗАВЖДИ (незалежно від результату base-parse); злити її issues з issues base-parse в один агрегований перелік перед throw. Схема лишає ЛИШЕ per-field format-перевірки. Список prod-required лишається одним джерелом правди (масив/функція, не дубль). Регрес-тест: змішана format+presence помилка → обидві у повідомленні.

**Severity:** MEDIUM (діагностика fail-fast: неповний перелік → ітеративні рестарти; сам застосунок коректно НЕ піднімається, тож не CRITICAL, але нищить цінність фічі — особливо для installer-моделі, де конфіг заповнює оператор, а не розробник).

**Де шукати ще:** будь-який zod/Joi-агрегатор з object-level `.superRefine`/`.refine`/`.transform` для cross-field-правил, що очікує повний перелік issues (env-валідація, complex DTO cross-field-guard'и — WorkOrder date-consistency, Invoice line-sum, PO receive-quantity). Правило: presence/cross-field, що МУСИТЬ показатись поряд з format-помилками, не клади у object-level refine — тримай окремо й агрегуй вручну.

### 2026-09-17 — Frontend спільний `publicFetch` форсить версійний префікс на VERSION_NEUTRAL публічний роут → routing-404 (Bug #761) — Область: contract (frontend↔backend) / api-versioning / customer-facing

**Контекст:** URI-версіонування (`app.enableVersioning({type:URI, defaultVersion:'1'})`) робить усі бізнес-роути `/api/v1/*`, АЛЕ окремі контролери лишають `@Controller({path, version: VERSION_NEUTRAL})` — їхній URL НЕ змінюється (`/api/<path>`), бо на них покладаються стабільні зовнішні споживачі: docker healthcheck (`/api/health`), share-лінки кошторису у SMS/email (`/api/public/work-orders/:token`), installer-скрипти. Бек має ДВА публічні контракти: versioned (setup/booking → `/api/v1`) і version-neutral (public/work-orders, health → `/api`).

**Сигнал:** після версіонування — публічна/зовнішня фіча, чий URL мусив лишитись стабільним, ловить **routing-404 «Cannot GET /api/v1/...»** (НЕ app-404 з локалізованим тілом). Frontend має ОДИН спільний хелпер для всіх «публічних» викликів (`publicFetch`), що беззастережно додає `${API_URL}/api/v1`. Live-проба відрізняє: `curl /api/v1/public/... → «Cannot GET»` (роуту нема) vs `curl /api/public/... → app-404 з бізнес-повідомленням` (роут є, доходить до контролера). Юніт/tsc/review зелені — happy-path хелпера коректний для versioned роутів, дірка лише на version-neutral споживачі.

**Причина виникнення:** розробник розумно уніфікує «усі публічні виклики = один префікс `/api/v1`», не розрізняючи що частина публічних роутів на беку навмисно VERSION_NEUTRAL. `sync`-крок вирівнює очевидне (auth cookie-path, `API_BASE`), але спільний публічний хелпер — єдина точка, де versioned і version-neutral контракти зливаються в один, і version-neutral споживач тихо ламається.

**Підхід до виявлення:** після будь-якого коміту що вмикає/міняє `enableVersioning` — (1) `grep -rn "VERSION_NEUTRAL" apps/api/src` → перелік роутів чий URL лишається `/api/<path>`; (2) для КОЖНОГО знайти frontend/mobile-споживача (`grep -rn "public/work-orders\|/health" apps/web/src apps/mobile/src`) і звірити, що клієнт б'є БЕЗ `/v1`; (3) live-battery curl на живому :3000: versioned бізнес-роут → 401 (не 404); голий `/api/<biz>` → 404; version-neutral `/api/health/live` та `/api/public/...` → існують (200/app-404); їхні `/api/v1/...` двійники → routing-404 (мусять НЕ існувати). Регрес без стека: unit-тест що пінить точний URL-префікс кожного публічного хелпера (`publicFetch` МУСИТЬ містити `/api/v1/`; `publicNeutralFetch` НЕ містить `/v1/`).

**Підхід до фіксу:** розділити публічний fetch-хелпер за контрактом: спільне тіло `_publicFetch(base, path)`, `publicFetch` → `${API_URL}/api/v1` (versioned public), `publicNeutralFetch` → `${API_URL}/api` (дзеркалить бекендний VERSION_NEUTRAL). Перевести кожен version-neutral споживач на neutral-хелпер. Не «латати» одноразовим raw-fetch у сторінці — виділений іменований хелпер робить контракт видимим і не дає наступному розробнику знову злити.

**Severity:** HIGH (customer-facing стабільний-URL сценарій зламано — публічний кошторис зі SMS/email не відкривається; це САМЕ той сценарій, заради якого роут зробили version-neutral). CRITICAL якби version-neutral був docker healthcheck `/api/health` (cascade-падіння контейнера).

**Де шукати ще:** усі VERSION_NEUTRAL контролери та їхні клієнти — `public/work-orders` (share-лінк + export pdf/xlsx/docx), `health` (docker/installer/mobile), будь-який майбутній зовнішньо-адресований роут (webhook-callback, ПРРО-редірект, payment-provider return-URL). Клас: «уніфікований клієнтський префікс-хелпер vs частково-версіонований бек». Також дзеркальний ризик у mobile (`apps/mobile/src/lib/*` — тут BASE_URL зашитий `/api/v1`, health/public звідти не викликаються, але перевіряти при кожному новому neutral-споживачі).

### 2026-09-17 — Нове DB-immutability обмеження (BEFORE-тригер/CHECK) на ledger → рантайм-регресія легітимного flow (0 багів цього разу — методологія перевірки) — Область: db / backend / regression-hunt / installer

**Контекст:** до append-only ledger-таблиць (`settlement_transactions` повна заборона UPDATE+DELETE; `stock_movements` DELETE заборонено, UPDATE лише одноразовий `batchId` NULL→value через whole-row `to_jsonb(NEW)-'batchId' = to_jsonb(OLD)-'batchId'`) додано BEFORE-тригери. Незмінність стала ФІЗИЧНОЮ (раніше — лише конвенція коду + guard-тест). Ризик протилежний звичайному: не «дірка лишилась», а «легітимний бізнес-флоу, що досі мутував таблицю, тепер кидає exception на рантаймі».

**Сигнал:** після коміту, що додає тригер/CHECK/EXCLUDE на таблицю з наявними write-флоу — integration-тест (або живий флоу), що пише цю таблицю, падає з текстом обмеження (`append-only`, `violates check constraint`). Це РЕГРЕСІЯ (заблоковано легітимне), НЕ баг застосунку. Дзеркально: якщо тригер занадто вузький — money/audit-колонку можна протягти разом із дозволеною (напр. `price` разом із `batchId` при col-list `IS NOT DISTINCT FROM` замість whole-row `to_jsonb`).

**Причина виникнення:** unit-специ мокають Prisma → тригер НЕ спрацьовує → зелені навіть якщо реальний флоу зламано. Тригер живе у manual-SQL міграції (не в schema.prisma) → tsc/review не бачать взаємодії з кодом. Розробник перевіряє «заборона працює», але не «усі дозволені флоу ще проходять».

**Підхід до виявлення (рецепт для будь-якого нового immutability-обмеження):**

1. `grep -rnE "<model>\.(update|delete|updateMany|deleteMany)" apps/api/src --include=*.service.ts` + raw: `grep -rniE "UPDATE|DELETE|TRUNCATE .*<table>|\\$executeRaw.*<table>"` → повний перелік ВСІХ мутацій таблиці у прод-коді (виключити *.spec.ts). Для append-only очікувано: лише `.create` + рівно один дозволений `.update` (звірити where/data — має міняти САМЕ дозволену колонку й нічого більше).
2. Для КОЖНОГО знайденого мутатора: чи він у whitelisted-переліку тригера? Якщо ні → потенційна регресія (void/correction/reversal через UPDATE/DELETE — типовий сценарій).
3. Реверс/сторно: підтвердити рантаймом що робить КОМПЕНСУЮЧИЙ запис (новий рядок), а не DELETE/UPDATE наявного (`restoreBatchesForReturn`→`returnToBatch` = insert, не delete).
4. Прогнати LIVE-БД integration-специ (не мок-Prisma) що ганяють флоу через тригер: `*.integration.spec.ts` з реальним `new PrismaClient({datasourceUrl})` + повний api-suite проти живої dev-БД. Мок-специ тут БЕЗ ЦІННОСТІ.
5. Верифікувати сам тригер рантаймом: `pg_trigger.tgenabled='O'` (активний), `pg_get_functiondef` містить whole-row-порівняння (не col-list — інакше пропущена колонка мутабельна).
6. Installer-шлях: тригер у manual-SQL міграції відредагований ПІСЛЯ apply → `prisma migrate status` (drift?) + `prisma migrate deploy` проти dev-БД (checksum-error «migration modified after applied»?). Обидва мають бути clean, і migration.sql на диску = актуальна (whole-row) версія, бо `migrate deploy` на СВІЖІЙ installer-БД виконує ФАЙЛ дослівно.

**Підхід до фіксу:** якщо знайдено заблокований легітимний флоу — НЕ вимикати прод-тригер; або (а) переписати флоу на append-only (компенсуючий запис замість mutate), або (б) розширити whitelist тригера точково (як `batchId` NULL→value) зі збереженням whole-row-guard на решту колонок. Кожен реальний фікс + regression-тест проти живої БД.

**Severity:** заблокований легітимний ledger-флоу = HIGH (гроші/склад не проводяться); занадто вузький тригер, що пропускає money-колонку = HIGH (ledger integrity); drift/checksum-помилка на installer = HIGH (свіжа інсталяція не мігрує).

**Де шукати ще:** будь-яка нова immutability-конструкція на таблиці з наявними write-флоу — BEFORE-тригер, CHECK, EXCLUDE, partial-unique, FK ON DELETE RESTRICT. Класи мутаторів під ризиком: void/correction/storno через UPDATE status; batch-cleanup через deleteMany; reversal що DELETE-ить замість компенсувати; adjustment що UPDATE-ить суму. Дзеркально при кожній manual-SQL міграції: чи migration.sql на диску = стан застосований на dev (файл могли правити після apply → installer отримає іншу версію).

---

### 2026-09-18 — i18n-ключ/каталог існує, але не під'єднаний у рендер (dead translation export) — Area: frontend

**Сигнал:** щойно фіча вводить i18n (react-i18next) — grep показує i18n-ключ-мапу (`NAV_SECTION_KEYS: Record<Section, 'section.x'>`) + повні uk/en каталоги для тих ключів, АЛЕ сама мапа ніде не викликається (`grep -rn "NAV_SECTION_KEYS" apps/web/src` → 1 hit = лише визначення). Паралельно JSX рендерить готовий рядок з не-i18n-джерела (`resolveNav().label` = жорсткий `NAV_SECTION_LABELS[id]`, `{group.label}` без `t()`). Sync/review/tsc/818-suite зелені — happy-path (uk) виглядає ідентично, бо fallback-рядок = укр. переклад. Регресія видима ЛИШЕ при перемиканні на en у живому UI: частина піддерева фліпає (де є `t()`), сусідня — ні (де рядок).

**Причина виникнення:** розробник створює повну i18n-інфраструктуру (мапа ключів + каталоги) в одному коміті, але «останню милю» (замінити рядок на `t(key)` у рендері) робить лише для очевидних місць (пункти меню через `t(item.labelKey)`), а похідні через хелпер-резолвер (section headers через `resolveNav`) пропускає — резолвер повертає рядок, і JSX «просто рендерить його», не помітивши що це не-перекладений літерал. Каталоги-для-ключа присипляють пильність: «переклад же є».

**Підхід до виявлення:** для КОЖНОГО нового i18n-namespace/ключ-експорта — grep його ім'я по всьому `apps/web/src`; якщо єдиний hit = визначення (0 споживачів) → dead export = ознака невиведеної гілки рендеру. Далі для КОЖНОГО каталог-ключа (`nav:section.*`, `settings:tabs.*`) знайти хоча б один `t('<key>')`/`t(\`<ns>:${...}\`)`; ключ без жодного `t()`-споживача = не-під'єднаний переклад. Крос-чек: рендер-вирази що беруть рядок з резолвера/константи (`resolveNav().label`, `NAV_SECTION_LABELS[x]`, будь-який `LABELS[x]`) і кладуть прямо в JSX без `t()` — кандидати. Live-доказ (авторизований UI не обов'язковий для мoverклику): перемкнути мову й порівняти дві сусідні групи тексту; або юніт що дзеркалить точний рендер-мапінг і асертить en-вивід.

**Підхід до фіксу:** під'єднати наявну ключ-мапу в точці рендеру через `t(KEY_MAP[id], { defaultValue: <старий рядок> })`; `defaultValue` зберігає fallback-поведінку. Розрізняти системні (перекладні) vs user-визначені сутності — custom-розділи/user-теги НЕ перекладати (гілка `s.custom ? label : t(...)`). Реактивність безкоштовна якщо компонент уже має `useTranslation(ns)` — фліпне на `languageChanged` разом з рештою. Регрес-тест: дзеркалити рендер-мапінг у юніт-тесті (не потребує браузера/auth), асертити uk-вивід і en-вивід через `i18n.getFixedT('en', ns)`; mutation-verify: прибрати `t()` → en-кейс червоний.

**Severity:** MEDIUM (частковий переклад UI — косметика/довіра; не ламає дані). LOW якщо це один текст поза дефолтним режимом; піднімати якщо це видимо на КОЖНІЙ сторінці (nav sidebar) у ДЕФОЛТНОМУ режимі.

**Де шукати ще:** будь-який i18n-namespace з ключами що дзеркалять константну мапу (`*_LABELS`/`*_SECTION_KEYS`/`tabs.*`); резолвери що віддають готовий label у JSX (`resolveNav`, breadcrumb-білдери, badge/tone-мапи що отримали переклад); «Закладки»/секційні заголовки та інші рядки що рендеряться поза `t()` попри наявний ключ. Bug #762.

---

### 2026-09-19 — Generic tree-walk skip-list за іменем ключа збігається з іменем реального поля → піддерево не обходиться (Bug #763) — Area: frontend / i18n / RHF

**Сигнал:** рекурсивна утиліта що обходить структуру (помилки/дані) і має skip-list за ІМЕНЕМ ключа: `if (key === 'type' || key === 'ref' || key === 'message') continue;`. Статичний сигнал — skip-ключ, що збігається з валідним іменем поля форми. Runtime-сигнал — сирий `v.*`-key протікає у UI замість перекладу для конкретного поля.

**Причина виникнення:** розробник додає skip щоб оминути МЕТАдані leaf-ноди (у RHF error-ноді: `type`=назва validation-правила, `ref`=DOM-нода, `message`=текст). Виглядає як безпечна оптимізація. Пастка: namespace метаключів контейнера НЕ ізольований від namespace імен полів — `errors.type` (де `type` = ім'я поля з `type: z.enum`) і `error.type` (де `type` = назва правила) неможливо розрізнити за іменем ключа. Skip батьківського рівня викидає ціле піддерево однойменного поля.

**Підхід до виявлення:** для кожного name-based skip-list — класифікувати кожен skip-ключ: чи МОЖЕ це ім'я бути полем-контейнером? `message`/`ref` — ні (RHF-метадані, не бувають іменами полів); `type`/`name`/`root` — так (`root` спеціальний у RHF v7 `errors.root`; `type`/`name` — звичайні доменні поля). Крос-чек зі схемами: `grep -rnE "\b(type|name|root):\s*z\.(enum|string|literal|object)" packages/shared/src/schemas` — якщо схема має поле з таким іменем → resolver його глушить. Reproduce БЕЗ сервера: викликати resolver на об'єкті що провалює однойменне поле, асертити `errors.<field>.message` перекладений (не сирий key). Загальний принцип: name-based фільтр у рекурсії безпечний ЛИШЕ для ключів чий namespace не перетинається з даними, які обходиш.

**Підхід до фіксу:** прибрати зі skip-списку будь-який ключ що може бути іменем поля. Рекурсія у примітив-leaf (рядок-правило `type`, DOM-`ref` якщо не skip) — безпечний no-op завдяки type-guard на вході (`typeof node !== 'object' → return`), тож skip був непотрібний для коректності. Лишити skip лише для `message` (уже оброблено вище у функції) і `ref` (DOM-нода — рекурсія марна й потенційно циклічна). Загальний принцип: skip-ити метаключі за їх РОЛЛЮ (вже-оброблено / не-структура), а не за іменем що конкурує з даними.

**Severity:** MEDIUM (сирий i18n-key у UI — косметика/довіра; дані не ламаються). HIGH якщо skip-нуте поле критичне у money/FSM-формі де користувач не бачить чому валідація провалилась. У цьому кейсі практично важко досягти через `<select>` з дефолтом, але латентно (programmatic reset, undefined defaultValues, майбутні форми з вільним type-вводом).

**Де шукати ще:** будь-яка recursive translate/redact/mask/serialize-утиліта з name-based skip-list; `i18nZodResolver` покриває всі 12 zodResolver-форм (counterparty/stock-document мають поле `type`); RHF-форми з полями `type`/`name`/`root`. Регрес-тест: `apps/web/src/lib/__tests__/i18nZodResolver.test.ts`. Live-конвеєр (integration, оскільки zod-endpoints за JwtAuthGuard недосяжні анонімно): `apps/api/src/common/pipes/zod-validation.i18n.e2e.spec.ts` — pipe + `runWithTenant({locale})` ALS + shared dist → uk byte-identical / en / no-scope→uk / ALS-ізоляція. Bug #763.

### 2026-09-19 — Новий локалізаційний error-seam без прямого locale-round-trip тесту + inline `@IsX({message})` shadowed generic constraint-мапою (commit 29eaad2f, cv-seam) — Area: backend / i18n / contract

**Сигнал:** commit переписує форматер 400-помилок (class-validator `exceptionFactory` / custom `ValidationPipe` / `http-exception.filter`) з hardcoded-рядків на key-based (`translateError(key, locale, {field})` + `getLocale()` з ALS). Статичні сигнали: (1) поряд із переписаним `*.factory.ts`/`*.pipe.ts` немає spec-у, що робить `runWithTenant({locale:'en'})` і асертить EN-вивід — покриття лише byte-identity (uk==старе) + parity (симетрія ключів); (2) inline `@IsX({message:'err.dto.*'})` у DTO, чий constraint-key присутній у generic `CV_TEMPLATE_KEYS` форматера (`@Matches({message})`→constraint `matches`→мапиться на `err.cv.matches`).

**Причина виникнення:** розробник довіряє byte-identity + parity-guard як достатньому покриттю («uk незмінний, ключі симетричні → готово»). Але byte-identity доводить лише uk-гілку, parity лише наявність ключа — жоден не проганяє EN через сам форматер, ні nested-recursion, ні {{field}}-інтерполяцію, ні empty-errors fallback. Окремо: інлайнячи специфічне повідомлення на `@Matches`/`@IsIn` розробник вважає що воно рендериться, але translateLeaf спершу дивиться у generic-мапу за constraint-іменем → специфічний `err.dto.*` ключ shadowed (dead), користувач бачить generic «некоректний формат». Reachable лише inline-ключі, чий constraint ВІДСУТНІЙ у generic-мапі (`isHexColor`/`isObject`).

**Підхід до виявлення:** `grep -rn "exceptionFactory\|getLocale()\|translateError(" apps/api/src/common/pipes apps/api/src/common/filters` — якщо seam переписано, а прямого round-trip spec-у немає → прогалина. Для shadowed-ключів: `grep -rn "@Is\w*(.*message: *'err.dto" apps/api/src/modules --include="*.dto.ts"` → для КОЖНОГО звірити constraint-ім'я (напр. `matches`, `isIn`) проти generic-мапи форматера; збіг = dead key. Перевірити також contract-специ: `grep -rn "new ValidationPipe(" apps/api/src/**/*.spec.ts` — bare pipe БЕЗ `exceptionFactory: validationExceptionFactory` оминає продакшн-форматер (тест бачить сирий constraint-меседж, не локалізований) → test-fidelity gap; безпечний лише якщо асертить виключно statusCode, не текст. Загальний принцип: byte-identity + parity доводять збереження старого + структурну симетрію, але НЕ поведінку нової (EN) гілки — новий двомовний seam потребує прямого проганяння ОБОХ локалей через реальний форматер.

**Підхід до фіксу:** створити locale-round-trip spec (аналог zod-pipe spec-у) через `runWithTenant({locale})` навколо форматера — покрити representative constraints у uk+en, nested @ValidateNested children (`parentPath.join('.')` → `address.city`/`items.0.qty`), {{field}}-інтерполяцію (немає літерального `{{field}}`), empty-errors→localized fallback (`v.validationFailed`, не сирий key), reachable inline override (не shadowed), unknown-constraint→verbatim, default-locale(без ALS)→uk. Для shadowed inline-ключа: або видалити dead `err.dto.*` з каталогу (parity-spec тримає симетрію), або (якщо специфічний текст справді потрібен) прибрати constraint з generic-мапи форметера щоб inline-ключ став reachable. Прямого тесту на форматер краще тестувати з ЯВНИМ locale-аргументом / `runWithTenant`, а не покладатись на `getLocale()` default (поза request дає 'uk' → EN-гілка не перевіриться).

**Severity:** LOW (i18n-якість; EN-гілка форматера неперевірена, shadowed key = generic-текст замість специфічного). MEDIUM якщо фіча реально багатомовна і EN-вивід форматера повністю без покриття, або якщо shadowed-повідомлення несло критичну для користувача підказку (формат IBAN/дати).

**Де шукати ще:** `http-exception.filter`, будь-який custom pipe/interceptor з `translateError`; майбутні error-seam-міграції на key-based i18n. Shadowed-ризик: усі DTO з inline `@Matches({message})`/`@IsIn({message})` (bank-accounts iban, settings time, supplier-payments date). Test-fidelity: contract-специ що глобально-pipe-ять bare `ValidationPipe` без exceptionFactory (bank-accounts.contract.spec — асертить лише statusCode, тому безпечно, але не дзеркалить прод-форматер на відміну від settings.contract.spec). Регрес-тест: `apps/api/src/common/pipes/validation-error.factory.spec.ts` (14 тестів). Результат сесії: 0 продакшн-багів — seam коректний, прогалину покриття закрито.

### 2026-09-19 — raw `@Query` page/limit → `Math.max/min`-clamp без `Number.isFinite` → NaN у Prisma skip/take = HTTP 500 (Bug #764) — Area: backend / API-validation / pagination

**Сигнал:** новий list-endpoint бере пагінацію з raw query БЕЗ `ParseIntPipe`/DTO — `@Query('page') page = '1'`, `@Query('limit') limit = '50'` — і передає `+page`/`Number(page)` у сервіс. Сервіс «захищає» діапазон через `const take = Math.min(Math.max(limit, 1), 200); const skip = (Math.max(page, 1) - 1) * take;`. Другий сигнал: `findAll`/list-метод БЕЗ жодного unit-тесту на пагінацію (spec покриває лише create/resolve/happy-path). Тут: `DeadLetterController.findAll` → `DeadLetterService.findAll` не мав тесту на malformed page.

**Причина виникнення:** `Math.max/min`-clamp ВИГЛЯДАЄ як повний захист діапазону, тож розробник вважає пагінацію безпечною. Але clamp обмежує лише МЕЖІ, не NaN: `Math.max(NaN, 1) === NaN`, `Math.min(NaN, 200) === NaN` (NaN пропагує крізь усі Math-порівняння). А `+'abc' === NaN` (тонкість: `+'' === 0`, тому порожній limit клампиться коректно до 1 — лише НЕ-числовий рядок дає NaN). Розробник також припускає що клієнт завжди шле числа — web-клієнт (`usePaginatedList`) справді шле числовий page зі стану, тож happy-path/tsc/review зелені, а дефект видимий лише на прямому виклику API (endpoint у Swagger, admin-роль).

**Підхід до виявлення:** дві сторони. Контролер: `grep -rnE "\+(page|limit|skip|take|offset)\b|Number\((page|limit|opts\.(page|limit))\)" apps/api/src/modules/**/*.controller.ts` — raw numeric-coerce query без ParseIntPipe. Сервіс: `grep -rnE "Math\.(max|min)\((page|limit|skip|take|safe(Page|Limit))" apps/api/src/modules/**/*.service.ts` → для КОЖНОГО clamp перевірити наявність сусіднього `Number.isFinite(`/`?? <default>` ПЕРЕД clamp; відсутність = баг. Reproduce (без сервера, unit): `service.findAll('org', Number('abc'), Number('abc'))` → якщо `skip`/`take` = NaN у переданих Prisma-аргументах, продакшн кинув би `PrismaClientValidationError` → 500. Загальний принцип: `Math.max/min`-clamp НЕ санітайзить NaN — будь-який шлях від raw string-query до числового Prisma-аргументу потребує явного `Number.isFinite`-guard, бо range-clamp і NaN-guard — різні захисти.

**Підхід до фіксу:** нормалізувати у сервісі (єдине джерело clamp, захищає всіх викликачів вкл. майбутніх): `const safeLimit = Number.isFinite(limit) ? Math.floor(limit) : <default>; const safePage = Number.isFinite(page) ? Math.floor(page) : 1;` ПЕРЕД `Math.min/max`-clamp. Обов'язково оновити і `page:` у відповіді (`Math.max(safePage, 1)`, не сирий `page`), інакше DTO поверне NaN у payload. НЕ покладатись на default-параметр (`limit = 50`) — він спрацьовує лише на `undefined`, а не на NaN. Альтернатива-профілактика: `ParseIntPipe({ optional: true })` у контролері — але сервісний guard надійніший (ловить і не-HTTP викликачів).

**Severity:** MEDIUM (HTTP 500 замість graceful clamp/локалізований 400 — порушує CLAUDE.md #17; але лише прямий API-виклик з malformed query, admin-роль OWNER/ADMIN, web-клієнт не тригерить). HIGH якщо endpoint публічний/анонімний або пагінація гейтить критичний список.

**Де шукати ще:** КОЖЕН list-endpoint із raw `@Query('page')`/`@Query('limit')` БЕЗ ParseIntPipe (dead-letter — виправлено; майбутні admin/audit/report list-endpoints); будь-який `+`/`Number()`-coerce raw query у числовий аргумент Prisma (`skip`/`take`/`cursor`-offset); також `parseFloat`/`Number` на raw query для сум/фільтрів-діапазонів (`?minAmount=abc`). Споріднений з Bug #679 (raw @Query enum-cast → 500) і #678 (raw date-@Query) — родина «raw @Query доходить до Prisma без валідації». Регрес-тест: `apps/api/src/modules/dead-letter/dead-letter.service.spec.ts` (describe `findAll`, 8 тестів: orgId-scope, фільтри, clamp-200, NaN-guard, empty→1, page<1→1). Component-guard DLQ UI: `apps/web/src/app/(app)/settings/__tests__/DeadLetterTab.test.tsx` (7 тестів, вкл. per-row spinner review-fix).

### 2026-09-20 — Per-item isolation loop guards ЛИШЕ зовнішній network-виклик, а наступні DB-write + cursor-advance НЕ обгорнуті → одне падіння валить решту батчу (Bug #768) — Area: backend / BullMQ-processor / scheduler / resilience

**Сигнал:** BullMQ-процесор (або будь-який `for (const item of items)`-цикл) чий docblock декларує per-item/per-account isolation («помилка одного X не має валити інші»), але у циклі лише ОДИН крок — зазвичай зовнішній `fetch`/API-виклик — у `try/catch { continue }`, а решта хвоста (`applyImport`/`createMany`/`update` у БД, `updateCursor`/`lastPulledAt`-advance, будь-який другий await) — поза catch. Другий сигнал: existing spec доводить isolation ЛИШЕ для network-кроку (`fetchStatements.mockRejectedValueOnce(...)` → «інші обробляються»), але НЕ для DB-кроку (`applyImport.mockRejectedValueOnce(...)`). Тут: `BankStatementPullProcessor.process` обгортав лише `provider.fetchStatements` + авто-матч-блок, а `reconciliation.applyImport` та фінальний `updateCursor` — ні.

**Причина виникнення:** розробник обгортає найімовірніше джерело помилки (мережа/зовнішній API — таймаути, 5xx, TLS), припускаючи що локальні DB-операції «не падають». Але у offline-first / `concurrency>1` транзієнтний збій БД (lock-timeout, deadlock, connection-drop, помилка допоміжного сервісу типу `resolveBaseConversion`) — реальність. Одне таке падіння відкидає весь `process()`-promise → `for`-цикл переривається на поточному item → **усі наступні items батчу мовчки пропускаються** цього прогону (job іде в retry/DLQ, але решта items не обробляється до наступного тіку CRON). Happy-path + review + tsc зелені, бо мок-тести кидають лише з network-кроку.

**Підхід до виявлення:** для КОЖНОГО processor/scheduler-циклу з задекларованою per-item isolation перелічити ВСІ `await`-кроки в тілі ітерації і звірити скільки з них під `try/catch { continue }`. Якщо catch охоплює лише перший (network) крок, а далі є ще DB-write/cursor-update поза ним → isolation зламана. Grep: `grep -rnE "for \(const .+ of .+\) \{" apps/api/src/modules/**/*.processor.ts apps/api/src/modules/**/*.scheduler.ts` → читати тіло, рахувати await поза catch. Reproduce (unit, без сервера): у spec замокати ДРУГИЙ крок (`applyImport`/`updateMany`) `mockRejectedValueOnce` на першому item з ДВОХ і `expect(processor.process(job)).resolves.toBeUndefined()` + assert що другий item оброблено (`applyImport.mock.calls[...].bankAccountId === 'acc-b'`). Загальний принцип: isolation-catch мусить охоплювати ВЕСЬ хвіст обробки одиниці, не лише її найгучніший крок; «обгорнув fetch» ≠ «обгорнув ітерацію».

**Підхід до фіксу:** обгорнути весь per-item хвіст у try/catch що логує і `continue`. Критично для money/staging-потоків: **при падінні write-кроку курсор/прогрес НЕ рухати** (`continue` ПЕРЕД `updateCursor`), інакше вікно/offset «проковтується» без запису → тиха втрата даних; наступний прогін мусить повторити те саме вікно (ідемпотентно — тут через `createMany({skipDuplicates})` на unique-ключі). Cursor-update теж у власний best-effort try/catch (його падіння теж не має валити решту). Зберегти вкладені дрібніші catch (напр. per-row авто-матч) для точнішого логування — зовнішній catch додається, не замінює. Mutation-verify: прибрати доданий catch → новий isolation-тест червоний.

**Severity:** HIGH (доступність фонового процесу + мовчазне недоотримання по частині items до ручного втручання/наступного тіку). CRITICAL якщо цикл рухає гроші і падіння + помилковий cursor-advance = **безповоротна втрата** items (тут пом'якшено skipDuplicates-ідемпотентністю + не-рухом курсора). LOW якщо items незалежні й наступний тік повністю їх наздоганяє без стану.

**Де шукати ще:** усі BullMQ-processor з `for..of` по org/branch/account/register і зовнішнім викликом + DB-write у тілі (`nbu-fetch`, `delivery-poll`, `invoice-overdue`, `idempotency-purge`, майбутні polling-процесори); будь-який scheduler `forEachActiveOrg`/batch-loop що робить кілька await на item; загалом — цикл де catch стоїть на кроці №1, а кроки №2+ (persist/advance/notify) поза ним. Регрес-тест: `apps/api/src/modules/bank-statements/bank-statement-pull.processor.spec.ts` (кейс «per-account isolation: рахунок що кидає applyImport → інші рахунки продовжують курсор» + «ідемпотентність overlapping-window → 0 дубль-Payment»). Пов'язано з money-safety інваріантом auto-match (лише `confidence===1` + `counterpartyId` + `findFirst status:UNMATCHED` перед matchTransaction).

---

### 2026-09-21 — Create/Update DTO-пара: `@Transform(emptyToUndefined)` лише на одному з двох (Bug #769) — backend/contract

**Сигнал (статичний):** commit що додає одне optional-string поле у ДВА окремі DTO-класи (`CreateXDto` + `UpdateXDto`, не через `PartialType`) — і `@Transform(emptyToUndefined)` присутній лише в одному з них. Grep `grep -n "@Transform(emptyToUndefined)" <dto>.ts` показує асиметрію: поле є в обох, трансформ — в одному. Runtime-сигнал: POST з `field: ''` повертає `response.field === ''` (create-шлях), тоді як PATCH з тим самим `''` дає `field === null` (update-шлях).

**Причина виникнення:** розробник копіює нове поле у два паралельні DTO, але `@Transform` дописує лише туди, де його «підказує» контекст — зазвичай у той DTO, де поряд уже стоять інші `@Transform(emptyToUndefined)`-поля (Update часто «старіший»/повніший). Класична copy-paste-асиметрія: тип збігається (`string` в обох) → tsc/review зелені; happy-path UI шле `form.field || undefined` → порожній рядок ніколи не долітає до бага, тому латентно.

**Підхід до виявлення:** для КОЖНОГО optional-поля що з'явилось у diff в обох Create+Update DTO — порахувати входження `@Transform(emptyToUndefined)` НА ПОЛЕ (не на файл): має бути в обох або в жодному (якщо валідатор поля взагалі не відхиляє `''`, напр. голий `@IsString`). Різниця = кандидат. Особливо коли поле — код/enum/FK-натяк (`provider`, `gateway`, `mode`, `scheme`), де порожній рядок семантично = «не задано» = має стати NULL. Крос-чек: `BankAccountResponseDto.field` типізовано `string | null` → БД-колонка nullable → `''` є нелегітимним третім станом поряд з null.

**Підхід до фіксу:** додати відсутній `@Transform(emptyToUndefined)` дзеркально — щоб обидва шляхи давали `''`→undefined→NULL. Не чіпати сервіс-гілку `dto.field !== undefined ? {field: dto.field} : {}` (вона коректна щойно вхід нормалізовано). Регресія: contract-spec `it` «POST з field="" → service отримує undefined» — дзеркально до наявного Bug #244 branchId-guard у тому ж файлі. Mutation-verify: прибрати трансформ → тест ловить `''` у service-аргументі.

**Severity:** LOW типово (контрактна асиметрія; поточний UI не тригерить, `''` як falsy навіть коректно падає у legacy-гілку downstream-роутингу). MEDIUM якщо `''` доходить у бізнес-порівняння/фільтр (не лише persist) або якщо API споживається зовнішнім клієнтом що шле сирий `''`.

**Де шукати ще:** усі довідники/сутності з ОКРЕМИМИ Create/Update DTO-класами (не PartialType-derived) де optional-string/enum/FK-код поле додано в обидва — bank-accounts (fixed); кандидати: cash-registers (`fiscalProvider`), branch-provider-config, будь-яка нова multi-provider/multi-source сутність де «провайдер/джерело per-запис» — дзеркалить CashRegister.fiscalProvider-патерн. Пов'язано з Bug #244/#257-#265 (DTO `emptyToUndefined`-família) — цей запис додає вимір «парність Create↔Update», не лише «сімейство валідаторів».

### 2026-09-21 — E2E `toHaveURL(/…$/)` end-anchor ігнорує `trailingSlash: true` → асерція ніколи не матчить (Bug #770) — Area: frontend / E2E / Playwright

**Сигнал (статичний + runtime):** новий Playwright-тест на «повернення до базового tab / скидання `?tab=`» використовує end-anchored регекс `toHaveURL(/\/<route>$/)` БЕЗ завершального слеша. У застосунку з `next.config.trailingSlash: true` реальний canonical URL завжди має слеш (`/bank-statements/`), тож `…$` після імені маршруту НІКОЛИ не матчить → тест падає (`unexpected value "…/bank-statements/"`). Runtime-сигнал: падіння саме на кроці «клік default-tab → URL без query», тоді як assertion на під-tab (`toHaveURL(/tab=accounts/)` — підрядковий, без anchor) проходить. Fail з'являється у ТОМУ Ж коміті, що додав tab-shell (self-introduced stale test).

**Причина виникнення:** автор пише URL-асерцію «за пам'яттю» (dev-звичка URL без слеша) або копіює з під-tab-асерції, де підрядковий регекс терпимий до слеша. Глобальний `trailingSlash: true` (static-export вимога, ADR офлайн) — невидимий у самому spec-файлі, тож end-anchor `$` мовчки стає недосяжним. tsc/lint зелені (це валідний RegExp); ловиться лише запуском.

**Підхід до виявлення:** класифікувати як STALE TEST (не продуктовий баг), якщо застосунок справді має `trailingSlash: true` і реальна поведінка = скидання `?tab=` (URL стає `/<route>/` без query) — тобто продукт коректний, помиляється лише асерція. Детектор перед запуском: `grep -rnE "toHaveURL\(/[^/]*\\$/" apps/web/e2e` — end-anchored регекс без слеша перед `$` у застосунку де `grep -n "trailingSlash: true" apps/web/next.config.*` дає хіт. Ключове розрізнення: підрядкові патерни (`/tab=X/`, `/\/route\//`) безпечні; ризиковий лише `…<name>$` (кінець рядка одразу після сегмента без слеша).

**Підхід до фіксу:** правити ТЕСТ, не продукт: `/\/<route>$/` → `/\/<route>\/$/` — і це САМЕ те, що треба стверджувати (canonical base без query), а не послаблювати до `/\/<route>\/?/` (останнє пропустило б `?tab=` і перестало б перевіряти скидання query). Додати коментар про trailingSlash поряд. Бонус: якщо fallback-гілка невалідного `?tab=xxx` не має E2E — дописати (перевірити, що рендериться default-tab маркер + відсутній інший-tab маркер).

**Severity:** LOW (тест-регресія у власному коміті; жодна поведінка користувача не зламана, продукт коректний). Стає MEDIUM лише якщо end-anchor маскував БИ реальну регресію роутингу (напр. якби продукт помилково лишав `?tab=` — тоді ослаблений регекс сховав би це; тому фіксувати саме до `\/$`, не до `\/?`).

**Де шукати ще:** будь-який tab-shell/wizard E2E з URL-навігацією у `apps/web/e2e` (cash, ndi, settings-вкладки, invoices/purchase-orders detail-tabs) — усюди де є `router.replace('/route')` → нормалізація у `/route/`. Пов'язано з патерном «tab-shell за cash-зразком» (Suspense+dynamic ssr:false+`?tab=` через useSearchParams+router.replace) — кожна нова сторінка за цим шаблоном приносить ризик end-anchor асерції. Крос-чек із `page.tsx` fallback-рядком `TABS.some(x=>x.key===requested) ? requested : '<default>'` — переконатись, що invalid-tab гілка теж покрита E2E.
