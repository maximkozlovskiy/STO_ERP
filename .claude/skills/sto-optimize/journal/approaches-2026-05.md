# sto-optimize — журнал підходів, 2026-05

> Не читати цілком — шукати за ключовим словом.

### 2026-05-28 — Довідники без кешу — settings/catalog/infrastructure модулі

**Сигнал:** `findAll()` в сервісах що повертають незмінні reference lists без `CacheService` в constructor
**Фікс:** inject CacheService → get → miss → query → set; інвалідація у кожному mutating методі
**Impact:** settings page: 5 sequential DB queries → 0 (з кешу); ~150ms → ~5ms на повторний...

### 2026-05-28 — Waterfall fetch у settings page — сторінки з декількома незалежними секціями

**Сигнал:** декілька `apiFetch()` у `useEffect([], [])` що не залежать один від одного, але написані послідовно
**Фікс:** Promise.all([...]) → деструктурувати результати → setState для кожного
**Impact:** settings: 5 послідовних fetches (~300ms кожен) → 1 паралельний (~300ms total)
**Де шукати ще:** будь-яка...

### 2026-05-28 — Source/management page не наповнює спільний ref-cache — сторінки що редагують довідники

**Сигнал:** сторінка-власник довідника (CRUD UI для branches/zones/lifts/warehouses/brands/units) фетчить ті самі списки що й consumer-сторінки, але БЕЗ `getCached`/`setCache` — хоча consumer той самий...
**Фікс:** safe-умова обов'язкова — фіксувати ТІЛЬКИ якщо `loadAll()` викликається і на mount, і після КОЖНОЇ мутації (інакше кеш стане джерелом stale). Якщо так: seed з `getCached` для миттєвого...

### 2026-05-28 — `new Intl.DateTimeFormat()` у hot-path хелперах — будь-який компонент з форматуванням дати/часу/чисел у списку

**Сигнал:** хелпер-функція форматування (час, дата, число, валюта) що створює `new Intl.DateTimeFormat()` / `new Intl.NumberFormat()`
**Grep:** `new Intl.`
**Фікс:** винести форматер у module-level `const` (один інстанс на модуль), у хелпері лише `.format()`. Опції статичні — якщо локаль/TZ динамічні, кешувати через Map за...

### 2026-05-28 — Читання `new Date()` / годинника всередині render — компоненти з time-залежним UI

**Сигнал:** `new Date()`, `Date.now()`, `.getMinutes()`/`.getHours()` викликані прямо у JSX або у `.map()` що генерує опції/комірки — особливо для disabled-логіки «минулий час». Це impure render (різний...
**Grep:** `new Date()`
**Фікс:** тримати поточний час у стейті (`nowMs`), оновлювати по інтервалу в `useEffect`; похідні граничні (minHour, minMinute) через `useMemo([nowMs])`; передавати у дочірні як...

### 2026-05-30 — Detail-include vs list-include розрізнення — список з вкладеною колекцією

**Сигнал:** list endpoint робить `include: { children: { orderBy } }` (вкладена one-to-many) — здається O(N×M) і треба «оптимізувати» прибравши include. Перевіряти ПЕРЕД фіксом —...
**Фікс:** **НЕ фіксувати** якщо UI використовує. Якщо preview не потрібен — замінити include на `_count: { select: { children: true } }` для бейджу N і додати окремий `GET /:id` що повертає повний об'єкт з...

### 2026-05-30 — "Pre-mature optimization rejection" — коли НЕ фіксувати знайдене

**Сигнал:** запит містить «чи варто кешувати», «чи потрібен debounce», «чи ефективно» — це питання, не директива. Перед фіксом перевіряй чи проблема
**Фікс:** **записати в звіт "не виправлено, бо X"** замість тихо ігнорувати. Приклади: «GET /user-preferences/:key не кешується бо викликається 1× per mount + apiFetch уже дедуплить...

### 2026-05-30 — Verify-before-fix: коли запит звучить як "чи є cleanup/leak/issue?" — прочитати фактичний код перед діями

**Сигнал:** користувач ставить запитання «чи є cleanup для setTimeout?», «скільки ResizeObserver одночасно?», «чи потрібна virtualization?», «transition при кожному ререндері чи тільки при зміні?».
**Фікс:** якщо верифікація показала що проблеми **немає** — **НЕ робити фікс**. Чесно у звіті «0 проблем — cleanup є / pagination 20 / transition тільки при size change». Це валідно,...

### 2026-05-30 — HAR/DevTools "duplicate" може бути CORS preflight + GET — read curl method before declaring N+1

**Сигнал:** звіт показує що один endpoint викликається «двічі» при відкритті сторінки. У HAR/curl-export перші N — `-X 'OPTIONS'`, наступні N — той самий URL без `-X` (GET).
**Фікс:** реального дубля немає → НЕ чіпай useEffect / StrictMode / dedup. Фіксуй сам preflight: `maxAge` у `enableCors()` (NestJS) щоб браузер кешував OPTIONS. Chrome кепить на...

### 2026-05-30 — Consumer-page без ref-cache seed — сторінки де довідник це side-data, а не основний контент

**Сигнал:** сторінка робить `apiFetch('/branches')` без попереднього `getCached`, і використовує результат тільки для dropdown/select. Першу відкриття показує порожній...
**Grep:** `apiFetch.*/branches\|apiFetch.*/warehouses\|apiFetch.*/zones\|apiFetch.*/lifts\|apiFetch.*/work-categories`
**Фікс:** на початку useEffect: `const cached = getCached<T[]>('cache:X'); if (cached?.length) setState(cached);`. Після fetch: `setCache('cache:X', data)`. Безпечно бо ref-cache живе тільки в...

### 2026-05-30 — Detail-page ref-cache miss — картка сутності тягне ті ж довідники що й список

**Сигнал:** detail-сторінка (`/X/[id]/PageClient.tsx`) робить `apiFetch('/works'/'employees'/'warehouses'/...)` без `getCached`/`setCache`, але parent list-сторінка той самий довідник у cache...
**Фікс:** на початку useEffect: `const cached = getCached<T>(...); if (cached) setState(cached);` для кожного. Після fetch — `setCache(...)`. Кеш ділиться з list-сторінкою через спільний...

### 2026-05-30 — Sequential FK validation у NestJS create/update — будь-який сервіс що приймає DTO з кількома FK полями

**Сигнал:** у `create(orgId, dto)`/`addLine(orgId, dto)` йдуть два-три-чотири `await this.prisma.X.findFirst({ where: { id: dto.xId, orgId, deletedAt: null } })` поспіль — кожен для іншої...
**Grep:** `await this\.prisma\.\w+\.findFirst`
**Фікс:** `const [a, b, c] = await Promise.all([findFirst(...), findFirst(...), findFirst(...)])`; `if (!a) throw` ПІСЛЯ Promise.all — порядок повідомлень не страждає, бо всі...

### 2026-05-30 — Sequential queue.add у фан-аут хендлерах — webhook delivery, sms/notification dispatch

**Сигнал:** `for (const x of list) { await this.queue.add('job', {...}, opts); }` — по черзі N independent jobs у BullMQ/Redis. Кожен `add` робить окремий Redis-PIPELINE round-trip
**Grep:** `for (const \w+ of \w+)`
**Фікс:** `await Promise.all(list.map(x => this.queue.add('job', {...}, opts)))`. Семантика збереглася: всі jobs отримають attempts/backoff; failure одного не ломає...

### 2026-05-30 — Duplicate findFirst для тієї ж сутності з різним select — services що окремо тягнуть проекції

**Сигнал:** в одному методі дві `findFirst({ where: { id: dto.xId, orgId } })` для однієї сутності, але з різним `select`/`include`. Одна тягне `branchId`, інша `status`.
**Фікс:** залишити одну `findFirst` що selectить ОБИДВА поля — Postgres віддасть одним read; видалити дублікат, переписати if-перевірки на властивості об'єкта.

### 2026-05-30 — Sequential file/media upload у формі — будь-який handleUpload з for-await на FormData

**Сигнал:** `for (const file of Array.from(files)) { await apiMultipartFetch(url, fd); }`. Кожен upload блокує наступний на HTTP round-trip.
**Grep:** `for (const \w+ of (Array\.from\()?files\)?)`
**Фікс:** `Promise.allSettled(Array.from(files).map(file => ...))`. Failure count = `results.filter(r => r.status === 'rejected').length`. wall-clock падає до...

### 2026-05-30 — Sequential UPDATE у post-WO hook без транзакції — maintenance, schedules, notifications batch

**Сигнал:** метод після завершення наряду (`updateAfterWorkOrder`, `notifyAll`, `propagateChange`) робить `for (const x of list) { await prisma.X.update(...) }` поза транзакцією.
**Grep:** `for (const \w+ of \w+)`
**Фікс:** `await Promise.all(list.map(x => this.prisma.X.update({ where: { id: x.id }, ... })))`. Failure одного: Promise.all reject — той самий контракт що й перший await-помилка.

### 2026-05-30 — Covering index для WHERE+ORDER BY combo — list endpoints що показують найновіше

**Сигнал:** на вкладці «Аудит»/«Транзакції»/«Історія» Postgres сканує тисячі рядків, потім сортує у пам'яті. Existing index покриває WHERE (orgId+entityType+entityId), але не сортувальний стовпець...
**Фікс:** замінити існуючий індекс на `(orgId, ...filterCols, createdAt)` — covering. Postgres віддасть в індекс-order, sort node зникає. Окремий індекс лише на createdAt лишити (для full-org...

### 2026-05-30 — Per-row N+1 у xlsx/csv line importers — будь-який bulk import з for-await пошуком entity per row

**Сигнал:** import-метод для кожного рядка робить `good.findFirst({ where: { OR: [{ sku }, { name }] } })` + `existingLine.findFirst({ where: { goodId, parentId } })` +...
**Фікс:** helper `lookupEntitiesBulk(orgId, rows)` що робить ОДИН `findMany({ where: { orgId, OR: [{ sku: { in: skus } }, { name: { in: names } }] } })` → Map<key, entity>. Перед циклом.

### 2026-05-30 — Pure compute extraction з async rule resolver — calculateX що внутрішньо тягне правила/конфіг з БД

**Сигнал:** сервіс має `calculateX(orgId, ...inputs): Promise<number>` що
**Grep:** `calculateX(`
**Фікс:** split на дві: `getRulesForOrg(orgId)` (async) + `computeFromRules(rules, ...inputs)` (sync). Existing `calculateX` робить обидві підряд —...

### 2026-05-30 — Backend hot-loop Intl construction — звіти, PDF рендеринг, групування по даті

**Сигнал:** `kyivDate = (d) => new Intl.DateTimeFormat('sv-SE', {...}).format(d)` оголошений у тілі методу, а не module-level. Викликається у `for (const x of rows)` циклі 1000+...
**Grep:** `new Intl\.(DateTimeFormat|NumberFormat)\(`
**Фікс:** module-level `const KYIV_DATE_FMT = new Intl.DateTimeFormat(...)`. У циклі — лише `.format(d)`. Опції статичні. Якщо локаль/TZ з config — кешувати через Map<key,...

### 2026-05-30 — Frontend Intl singletons via dedicated lib helper — масові table-cell `.toLocaleString` у списках

**Сигнал:** на сторінці-списку кожна комірка з ціною/датою має inline `value.toLocaleString('uk-UA', {...})` або `new Date(value).toLocaleDateString('uk-UA')`. Або локальна...
**Фікс:** `apps/web/src/lib/format.ts` з module-level Intl singletons (`MONEY_FMT`, `DATE_FMT`, `DATETIME_FMT`, `SHORT_DATETIME_FMT`, `INT_FMT`) + thin wrappers (`fmtMoney(n)`,...

### 2026-05-30 — Tenant guard + side-entity fetch sequential — assertX() потім findFirst(X-related) у різних таблицях

**Сигнал:** метод починається з `await this.assertCounterparty(orgId, cpId)` (tenant-guard) потім `await this.prisma.loyaltyAccount.findFirst({ where: { counterpartyId, orgId } })`.
**Фікс:** `const [guard, entity] = await Promise.all([assertQuery, entityQuery])`. `if (!guard) throw NotFound` ПІСЛЯ Promise.all — порядок не страждає бо обидва вже...

### 2026-05-31 — SSE/long-poll endpoints без throttle на нові підключення — `@SkipThrottle()` на @Sse()

**Сигнал:** контролер з `@Sse()` або `@Get('stream')`/SSE/long-poll помічений `@SkipThrottle()` щоб throttler не лічив rapid-fire. Логіка коректна за наявності самого з'єднання (вже...
**Grep:** `@SkipThrottle\(\)`
**Фікс:** замінити `@SkipThrottle()` на `@Throttle({ default: { ttl: 60_000, limit: 5 } })`. Throttler рахує тільки нові request'и — вже відкритий...

### 2026-05-31 — Sub-query timeout у Promise.allSettled fan-out — dashboard/aggregated endpoints

**Сигнал:** `getSummary`/`getDashboard`/`getAggregatedReport` робить `Promise.allSettled([q1, q2, q3, q4])` з незалежних DB-запитів. `allSettled` ловить exception per-query, але
**Grep:** `Promise\.allSettled\(`
**Фікс:** приватний helper `withTimeout<T>(p, ms): Promise<T | null>` через `Promise.race([p, timeoutPromise])`. timeoutPromise resolves `null` (НЕ reject — інакше allSettled поверне `rejected`)...

### 2026-05-31 — Прихована відсутність Prisma connection pool sizing — DATABASE_URL без `connection_limit`/`pool_timeout`

**Сигнал:** PrismaService через `new PrismaClient()` без явного `datasourceUrl`. Prisma default = `num_physical_cpus * 2 + 1` connection limit і `pool_timeout=10s`. На багатоядерній...
**Фікс:** helper `withConnectionPool(url): string` через `new URL(url)` + `searchParams.set()` тільки якщо key ще не виставлений (operator override precedence). Рекомендовані дефолти:...

### 2026-05-31 — Same-aggregate parent + child sequential read — addLine/updateLine/removeLine та createFromX

**Сигнал:** `updateLine(orgId, parentId, childId, dto)` чи `removeLine(...)` робить дві послідовні findFirst: `parent.findFirst({ id: parentId, orgId, deletedAt: null })` для...
**Grep:** `await this\.prisma\.\w+\.findFirst`
**Фікс:** `const [parent, child] = await Promise.all([parent.findFirst(...), child.findFirst(...)])`. `if (!parent) throw NotFound` + status-guards ПІСЛЯ Promise.all.

### 2026-05-31 — Local fmt() helper що внутрішньо викликає toLocaleString — page-level «оптимізація» що нічого не оптимізує

**Сигнал:** локальна `function fmt(n: number) { return n.toLocaleString('uk-UA', {...}) + ' ₴' }` (або `fmtDate`/`fmtTime`) у `.map()` cells. Виглядає як...
**Grep:** `function fmt\(`
**Фікс:** імпортувати `fmtMoney`/`fmtInt`/`fmtDate`/`fmtDateTime` з `@/lib/format` і переписати локальний як thin proxy: `function fmt(n) { return \`${fmtMoney(n)} ₴\` }`. Бажано злити з singleton повністю.

### 2026-05-31 — Tiered parallelization stops at first Promise.all — addX/createX де є кілька груп незалежних reads

**Сигнал:** `addX(orgId, parentId, dto)`/`createX(orgId, dto)` вже має один `Promise.all([parent.findFirst, fk.findFirst])`. Але одразу після нього —...
**Фікс:** додати ДРУГИЙ `Promise.all([dup, count, ...])` після першого. Або, якщо обидві хвилі читають за одним ключем (orgId+goodId), злити у ОДИН `Promise.all` коли parent-guard не блокує...

### 2026-05-31 — `include: { fk: true }` для many-to-one relation що використовує 2-3 поля — не лише join-таблиць

**Сигнал:** `include: { unitOfMeasure: true }`, `include: { brand: true }`, `include: { category: true }` у `findMany`/`findFirst`/`create` — single related row. У toDto/.map()...
**Фікс:** `include: { fk: true }` → `select: { ...neededFields, fk: { select: { name: true, ...neededFields } } }`. Якщо кілька relations — увесь top-level стає select. TypeScript авто-наведе...

### 2026-05-31 — Public widget без shared lib доступу — booking/embed сторінки що не імпортують `@/lib/format`

**Сигнал:** публічна сторінка-віджет (booking, signup, reset-password) — чорний-box без авторизації що рендерить `.map()` зі слотами/датами через inline `toLocaleString`/`toLocaleTimeString`.
**Grep:** `toLocaleTimeString\|toLocaleString`
**Фікс:** module-level `const SLOT_TIME_FMT = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' })` **в тому самому файлі** — без імпорту з `lib/format`....

### 2026-05-31 — Private parent-guard helper блокує tier merger — `await this.assertX/getEditableX` як перший рядок hot-path методу

**Сигнал:** приватний helper `getEditableWorkOrder(orgId, id)` / `assertCounterparty(orgId, id)` робить parent.findFirst + business-rule check (status, isActive, deletedAt) і кидає виключення.
**Фікс:** inline parent.findFirst всередину `Promise.all([wo, fk1, fk2])`. `if (!wo) throw NotFound` та business-rule (`if (!EDITABLE.includes(wo.status)) throw`) ПІСЛЯ awaits — порядок...

### 2026-05-31 — Over-fetched many-to-one include для scalar-only consumer — `include: { brand: true }` коли тіло читає лише `entity.brandId`

**Сигнал:** `include: { brand: true }` (або інший fkRelation), але тіло читає лише foreign-key scalar — `line.good.brandId` чи `g.brandId` — без жодного...
**Фікс:** замінити `include` на `select` з narrow projection: явно всі поля parent entity + які FK scalars (brandId, categoryId). Видалити nested include...

### 2026-05-31 — Assignment/bulk-replace методи з findOne+FK guard sequential — `assignX(orgId, id, dto)` де findOne блокує FK перевірку

**Сигнал:** `assignX(orgId, id, dto: {idList: string[]})` починається з `await this.findOne(orgId, id)` (tenant guard) і далі `findMany({ where: { id: { in: dto.idList },...
**Grep:** `await this\.findOne\(orgId, id\)`**Фікс:**`const [parent, items] = await Promise.all([prisma.parent.findFirst({...select: { id: true }}), dto.list.length ? prisma.child.findMany({...}) : Promise.resolve([])])`. Заміна findOne на findFirst з...

### 2026-05-31 — Sequential `tx.X.create` loop у bootstrap/seed/init transaction — `createMany` пропущено для defaults

**Сигнал:** bootstrap/setup (setup.init, seed, fresh-org init) робить `for (const x of defaults) { await tx.X.create({ data: { orgId, ...x } }) }` у `$transaction`.
**Grep:** `for \(const \w+ of \w+\) { await tx\.\w+\.create\(`
**Фікс:** `await tx.X.createMany({ data: defaults.map(d => ({ orgId, ...d })) })`. createMany не повертає рядки (`{count}`) — якщо потрібні IDs для наступних кроків, лишити...

### 2026-05-31 — JS aggregation у post-mutation recalc helpers — `findMany({ select: { amount: true } }).reduce(...)` для перерахунку totals

**Сигнал:** `recalcTotals(parentId, tx)` робить `tx.X.findMany({ where: { parentId, orgId, deletedAt: null }, select: { amount: true }, take: 1000 })` потім `.reduce((s, l) => s +...
**Grep:** `findMany.*select.*amount.*reduce`**Фікс:**`prisma.X.aggregate({ where, _sum: { amount: true } })`замість findMany + JS reduce.`Number(result._sum.amount ?? 0)`. Для кількох...

### 2026-05-31 — Inline Intl.* construction у `useEffect` loadData callback — page-mount setup-функції з 2-4 форматерами підряд

**Сигнал:** на сторінці-дашборді/звіті `useEffect(() => { ... }, [])` (mount-only) робить `const fmt = (d) => new Intl.DateTimeFormat(...).format(d)` всередині callback АБО прямі `new...
**Grep:** `new Intl\.\(DateTimeFormat\|NumberFormat\)`**Фікс:** винести **всі** форматери у module-level`const`блок над компонентом. Local`kyivDate`як thin`.format()` wrapper. Опції константні (TZ, locale, options object повністю...

### 2026-05-31 — Async wrapper-method блокує parallelism викликача — `calculateX(...)` що сам тягне rules перед чистим compute

**Сигнал:** hot-path (`batch.createFromReceipt`) робить `entity = await prisma.X.findFirst(...)` потім `result = await this.other.calculateY(entity.fields, costPrice)`, де `calculateY` внутрішньо...
**Фікс:** `const [entity, rules] = await Promise.all([prisma.X.findFirst(...), this.other.getRulesForY(orgId)])`. Далі sync `this.other.computeYFromRules(rules, entity.fields, costPrice)`. Wrapper-метод...

### 2026-05-31 — 3rd-party UI lib props rebuilt each render — DayPicker/Combobox/Table з inline classNames/disabled/columns

**Сигнал:** обгортка над сторонньою UI-бібліотекою (DayPicker, React-Table, Combobox, MultiSelect) передає inline object/array літерал як props (`classNames={{...}}`, `disabled={[{before:...},...
**Фікс:** statically-known props → module-level `const DAY_PICKER_CLASS_NAMES = {...}`. Props що залежать від render input → `useMemo(() => [...], [dep1, dep2])`.

### 2026-05-31 — List item component без React.memo + inline callback — toggle expansion/selection у списку

**Сигнал:** компонент-рядок у `.map()` приймає stable primitive props (`{batch, expanded, onToggle, depleted}`) і
**Фікс:** `const Row = memo(function Row({...}) {...})`. Inline callback на батьку → `const handleX = useCallback((id) => setX(prev => prev === id ? null : id), [])`. Передавати `id` параметром (не...

### 2026-05-31 — Sequential cron-/scheduler queue.add у onModuleInit — N-orgs scheduler enqueue блокує application bootstrap

**Сигнал:** OnModuleInit hook (`FollowUpScheduler`, `ReminderScheduler`) проходить `for (const org of orgs) { await this.queue.add('job', ..., { repeat: cron, jobId:...
**Фікс:** `await Promise.all(items.map(item => queue.add(..., { jobId: \`x-${item.id}\`, repeat: cron, ... })))`. BullMQ deduplicates by jobId — паралель add = N concurrent Redis multi/exec...

### 2026-05-31 — PDF/export endpoints over-fetch via include — generatePdf методи з повним include для render data

**Сигнал:** `async generatePdf(orgId, id)` / `async exportX()` робить `findFirst({ where, include: { lines: {...}, parts: {...}, counterparty: true, organisation: findFirst({...}) } })`.
**Фікс:** замінити `include` на `select` з точним переліком полів що рендеряться у docDef. organisation findFirst → `select: { name: true, edrpou?: true, address?: true }`. lines/parts → `select: {...

### 2026-05-31 — Clone/duplicate операції з ID-only create патерном — `clone(id)` що include тягне labels що НЕ використовуються у create

**Сигнал:** `async clone(orgId, id, userId)` / `async duplicate(...)` робить `findFirst({ include: { related: { select: { name: true } }, lines: { include: { fk: { select: { name: true } } } } } })`.
**Фікс:** замінити include на narrow select що залишає ЛИШЕ FK scalars + business поля що йдуть у create (price/quantity/normoHours/amount/notes). Видалити related entity nested select. AuditEvent...

### 2026-05-31 — `similarity()` обчислюється кілька разів per row у $queryRaw search — pg_trgm `%` оператор vs `similarity() > threshold`

**Сигнал:** raw SQL search використовує `similarity(col, $q) > 0.1` у WHERE І `ORDER BY similarity(col, $q) DESC` у тому запиті. Postgres не дедуплікує — обчислює `similarity()` двічі per row.
**Grep:** `similarity(`
**Фікс:** subquery/CTE винесе `similarity()` як column → ORDER BY читає pre-computed. WHERE замінити на `col % $q` (set-similarity operator) — planner використовує GIN trgm index для...

### 2026-05-31 — Speculative duplicate-check у tier-merger update — коли значення-для-порівняння живе в existing row

**Сигнал:** `update(orgId, id, dto)` має 2-фазний «оптимізований» паттерн: (1) findFirst для existing, (2) IF dto.field !== existing.field — findFirst для duplicate-check. Друга фаза умовна.
**Фікс:** speculative — запустити duplicate.findFirst у Promise.all з existing.findFirst незалежно від `dto.X !== existing.X`. ПІСЛЯ awaits — `if (dto.X && dto.X !== existing.X &&...

### 2026-05-31 — `findOne + update` 2-RTT pattern для simple soft-delete/update — заміна на `updateMany` з orgId guard

**Сигнал:** простий CRUD `async update(orgId, id, dto)` робить `await this.findOne(orgId, id)` (404 guard через findFirst) → `await prisma.X.update({ where: { id, orgId }, data: {...} })`.
**Фікс:** `await prisma.X.updateMany({ where: { id, orgId, deletedAt: null }, data })` → `if (updated.count === 0) throw NotFoundException`. Для `update` що має повернути updated row — окремий findFirst...

### 2026-05-31 — Навігаційний prefetch при hover — дані готові до кліку (~200 мс)

**Сигнал:** при переході між сторінками помітна пауза — spinner/skeleton після кліку на NavLink. Дані API завантажуються тільки після mount, хоча JS chunk вже prefetch'ений...
**Фікс:** module-level `PREFETCH_MAP: Record<string, (qc) => void>` з `qc.prefetchQuery(...)` для кожного NAV item. `onMouseEnter={() => employee && PREFETCH_MAP[href]?.(queryClient)}`. Обов'язково: (1)...

### 2026-05-31 — TanStack Query міграція list-сторінок — useEffect+apiFetch без кешу

**Сигнал:** при повторному відвідуванні (A→B→A) — знову spinner/skeleton хоча дані щойно були. `useEffect → apiFetch → setState` не кешує нічого між unmount/mount.
**Grep:** `const load = useCallback\|useState.*\[\]\|setLoading.*true`
**Фікс:** (1) `hooks/api/useX.ts` з `useQuery(staleTime:30s, gcTime:5m, placeholderData:keepPreviousData, enabled:!!employee)`; (2) замінити useState/load/useEffect на `const { data, isLoading } =...

### 2026-05-31 — keepPreviousData у useQuery — таблиця не мерехтить при зміні фільтрів

**Сигнал:** при зміні статус-фільтра/search — таблиця зникає (spinner) на 300-500мс. Навіть при швидкій мережі.
**Grep:** `useQuery`
**Фікс:** `import { keepPreviousData } from '@tanstack/react-query'` + `placeholderData: keepPreviousData` у кожному `useQuery` для paginated list.
**Impact:** UX плавний — старі дані...

### 2026-05-31 — Частковий prefetch — сторінка має N hooks, у PREFETCH_MAP покрито лише M<N

**Сигнал:** маршрут є у PREFETCH_MAP, але сторінка викликає кілька useQuery hooks (5 для dashboard, 4 для infrastructure). Покрита тільки частина — інші fetch після...
**Фікс:** додати решту `qc.prefetchQuery` у тому PrefetchFn — паралельно, у тому closure. Для date-залежних (revenue chart з today+weekStart) — module-level KYIV_DATE_FMT singleton...

### 2026-05-31 — keepPreviousData у hooks з form-control параметрами — не лише filter pills, а й from/to/tab dropdowns

**Сигнал:** reports/analytics-сторінка має 2-3 form controls (`from` date, `to` date, `tab` selector) — кожна зміна = новий запит з новим queryKey. Без `keepPreviousData` — графік/таблиця...
**Grep:** `useQuery`
**Фікс:** `import { keepPreviousData }` + `placeholderData: keepPreviousData` у hook. При зміні параметрів React Query повертає `data` попередньої успішної...
