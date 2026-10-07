# sto-optimize — журнал підходів, 2026-06

> Не читати цілком — шукати за ключовим словом.

### 2026-06-20 — Public hot-path multi-field WHERE без супутнього compound B-tree — `(equality_cols, range_col)` index що ставить equality columns першими

**Сигнал:** public-endpoint TTFB-path (`BookingService.getAvailability()` — widget без auth, throttle є, кеша нема) робить `findMany` з multi-field WHERE — 3-5 equality (`orgId`, `branchId`, `status='CONFIRMED'`, `deletedAt IS NULL`) + 1 range (`requestedDate: {gte, lte}`). Existing indexes покривають лише ПРЕФІКС (`(orgId, status, deletedAt)`) — branchId equality + requestedDate range heap re-filter.
**Grep:** для public-route (`@Throttle` без `@UseGuards(JwtAuthGuard)`/`@ApiBearerAuth()`) — `where` у findMany/findFirst/count; equality cols + range cols (`gte`/`lte`/`in`>1). Cross-check `@@index`: чи перші N equality збігаються з ОДНИМ index (equality перші, range останнім)? EXPLAIN: `Bitmap Index Scan` з `Filter:` = heap re-filter.
**Причина:** B-tree leftmost-prefix: WHERE на `(a, c)` без `b` НЕ покриває `(a, b, c)`. Розробник додає equality discriminator (branchId) без розуміння що він має бути перед range column. Throttling маскує.
**Фікс:** `CREATE INDEX IF NOT EXISTS ... ON <table> (tenant-guard orgId[+branchId], equality discriminators у порядку selectivity, range column ОСТАННІМ)`. НЕ включати `deletedAt` у leftmost prefix при tenant-guard (cardinality 2). Дзеркалити у `@@index`.
**Impact:** booking_requests 5k/org, getAvailability: bitmap heap scan ≈5-15ms → index-range scan ≈0.5-2ms.
**Де шукати ще:** public/throttled endpoint з filtered list — getAvailability, findByShareToken + downstream lists, public CalendarSlot, quote-share. Smell test: EXPLAIN `Filter:` rows-removed >0 на public endpoint.

### 2026-06-20 — Ordered sub-sequence + independent cross-table write всередині `$transaction` — wrap sub-sequence у async IIFE, Promise.all з незалежним write

**Сигнал:** `update()`/`replace()` у `$transaction` замінює дочірню колекцію (tiers/lines/parts): `await tx.child.deleteMany` + `await tx.child.createMany`, ОДРАЗУ — `await tx.parent.updateMany({where: {id, orgId}, data: scalars})` (інша таблиця, не залежить від tier). 3 sequential await → 3 RTT. Tier-sequence МУСИТЬ бути ordered (create після delete), але main updateMany ОРТОГОНАЛЬНИЙ. Variant «Disjoint-set updateMany pairs» (2026-06-12) для TRIPLE-await.
**Grep:** `\$transaction\(\s*async tx => \{[\s\S]{0,200}await tx\.\w+\.deleteMany[\s\S]{0,300}await tx\.\w+\.createMany[\s\S]{0,300}await tx\.\w+\.updateMany`. Перші дві на одній таблиці (childTier), третя на ІНШІЙ (parent). Якщо всі три на одній — НЕ цей патерн.
**Причина:** linear-стиль; main update read-залежить ТІЛЬКИ від `id`+`orgId`, не від tier-результату.
**Фікс:** обернути ordered sub-sequence у async IIFE: `const tierWork = (async () => { await tx.child.deleteMany(...); if (data.length) await tx.child.createMany(...); })();`; окремо `tx.parent.updateMany(...)` БЕЗ await; `await Promise.all([tierWork, mainUpdate])`; final `findFirstOrThrow` останнім. Race-safe (РІЗНІ таблиці). НЕ коли main залежить від `tierTotal`.
**Impact:** pricing-rules.update() з tiers + main: 3 await → 2 RTT (33%).
**Де шукати ще:** service-метод що замінює дочірню колекцію + оновлює parent-scalars — invoice.update (lines+totals), workOrder.update (parts+notes), stockDocument.update (lines+warehouseId), PO.update (lines+supplierId), bookingRequest.update (slots+status).

### 2026-06-19 — Trgm index drift у search OR clause — нова/прогаяна колонка у `where.OR = [{ a contains }, ...]` без парного `idx_X_col_trgm`

**Сигнал:** `findAll(query)` має `where.OR = [{colA: {contains: q, mode: 'insensitive'}}, {colB: ...}, {colC: ...}]` (2-5 гілок). Деякі cols покриті GIN trgm, але мінімум один — НІ. PG звужує по `orgId+deletedAt`, потім per-row `LIKE` на non-trgm col.
**Grep:** для таблиці з search — `where.OR` columns vs existing `idx_X_*_trgm`. `goods`: search `[name, sku, barcode]`, trgm = `[name, sku]` → drift на `barcode`. Per column: `grep "_<column>_trgm" packages/database/prisma/migrations/`.
**Причина:** trgm-міграції batched один раз, не re-аудиту-ються. Нова search column працює (tenant-guard index звужує), але план фолбекає на seq+LIKE.
**Фікс:** `CREATE INDEX IF NOT EXISTS "idx_<table>_<column>_trgm" ON <table> USING gin ("<column>" gin_trgm_ops);`. Cross-check `pg_trgm` extension (якщо нема — `CREATE EXTENSION IF NOT EXISTS pg_trgm`). НЕ у Prisma schema (GIN не expressed у DSL). Drift у >1 column → одна migration. НЕ плодити для non-WHERE cols (GIN ≈30% INSERT overhead).
**Impact:** goods 50k/org, `q=ART-001` (barcode): seqscan ≈10-50мс → trgm bitmap ≈1-3мс.
**Де шукати ще:** для КОЖНОЇ моделі з search OR (Good, Counterparty, WorkOrder, Invoice, PO, SD, Employee, Vehicle) — OR колонки vs trgm indexes. WorkOrder.findAll OR=[number, counterparty.*] — counterparty join cols мають свої trgm.

### 2026-06-17 — Twin-scan `reduce()` у backend mutation-hot-path recalc/aggregate helper — single-pass `for…of` з двома акумуляторами

**Сигнал:** service-helper `recalcTotals`/`recomputeAggregates`/`applyDocBalances` (з 6+ mutation entry-points — addLine/updateLine/removeLine/addPart/...) робить `findMany({select})` потім ДВА `.reduce()` по тому масиву (`totalLabor = SUM(amount)`; `totalActualLabor = SUM((actualHours ?? normoHours) × price)`). Backend-варіант «Twin-scan reduce у tfoot» (2026-06-11) — per-mutation CPU/GC.
**Grep:** `\w+\.reduce\([^)]+\);[\s\S]{0,300}\w+\.reduce\(` (той identifier). Допоміжний: `findMany` ВИЩЕ з `select` що містить поля обох reduce.
**Причина:** формула змінилась → нова reduce поряд зі старою. Хибне «1 раз на mutation». Реально: WO 50 ліній × 6 mutation типів = 600 wasted ops; +2× Number() casts (Decimal→Number alloc).
**Фікс:** один `for (const x of array) { acc1 += ...; acc2 += ...; }` з `let acc1=0; let acc2=0;`. Half CPU + half GC. Додати `take: N` у findMany (~1000). Не зливати reduce у DIFFERENT collections (lines vs parts).
**Impact:** WO 50 рядків: 100 iter + 100 casts → 50+50. Edit-сеанс 10 mutations: -500 iter + -500 allocs.
**Де шукати ще:** `recalc*`/`recompute*`/`applyTotals*`/`refreshAggregates*` — WO, invoices, SD, PO, supplier-returns, estimates. Моделі з aggregate-парами (totalLabor+totalActualLabor, totalAmount+totalVat, totalDiscount+totalNet).

### 2026-06-17 — Sequential post-token `wo + org + uoms` lookup у public share-endpoint — 3 RTT ланцюг, merge tail-pair у Promise.all

**Сигнал:** public share-token endpoint (estimate-share, invoice-public, document-view) має 3-step: (1) `findFirst({where: {shareToken}})` → `wo`, (2) `findFirst({where: {id: wo.orgId}})` → `org`, (3) `findMany({where: {id: {in: uomIds}}})` → `uoms`. Перші 2 sequential (org.id=wo.orgId), але 2+3 паралельні (обидва залежать від wo). 3 RTT де можна 2. Sibling-drift: findByShareToken ↔ getEstimateData.
**Grep:** `findFirst\([^)]+shareToken[\s\S]{0,1500}await this\.prisma\.organisation\.findFirst[\s\S]{0,500}await this\.prisma\.\w+\.findMany\(`. Перевіряти export-endpoint-и (PDF/XLSX/DOCX) що викликають shared data-builder.
**Причина:** послідовно бо «спочатку 404-guard, потім все інше». Після if-throw подальші lookups незалежні.
**Фікс:** виlift `const uomIds = wo.X.map(c => c.fkId).filter(...)` ПЕРЕД; `const [org, uoms] = await Promise.all([findFirst(org), uomIds.length ? findMany(uoms) : Promise.resolve([])])`. Map-fill loop ПІСЛЯ. НЕ зливати з token-lookup (pre-guard).
**Impact:** TTFB ~15ms → ~10ms (33%). × 3 export-формати.
**Де шукати ще:** findByShareToken, getEstimateData, invoice-public.findByToken, document-view.getByPublicId, pricing-list-share. Парний паттерн: коли один оптимізовано, sibling майже завжди лишається sequential.

### 2026-06-16 — Settings/config read-endpoint без Redis cache при high-mount-frequency UI — sibling settings.X мають cache, новий тонкий getter НЕ має

**Сигнал:** `getWorkHours`/`getFeatureFlags`/`getQuickConfig` повертає тонке value-object з findFirst на settings/config. Викликається з useEffect `[]` у вкладці (Calendar/Dashboard/PriceListPicker) → DB hit на КОЖЕН mount. Sibling (`getOrganisationSettings`, `getBranchSettings`) мають Redis cache 300s з invalidation, але новий naked («він же тонкий»).
**Grep:** `async get\w+\(orgId.*\): Promise<\{[^}]*Hour\|Days\|Mode\|Enabled` БЕЗ `redis\.get` поряд + `private readonly redis` у constructor. Підтверджуючий: у `updateBranchSettings`/`updateOrganisationSettings` є `invalidate*Cache()`, але нових не додавалось.
**Причина:** copy findFirst з sibling, але `try { redis.get } catch {}` виглядає boilerplate, пропущена. Endpoint «дешевий» — але тригериться 5-20 раз/сесію (tab toggle, modal re-open, nav back/forward).
**Фікс:** (1) cacheKey + TTL (`WORK_HOURS_TTL = 60`, коротший бо quick-change); (2) `try { cached = redis.get(key); if (cached) return JSON.parse } catch {}` → query → `try { redis.set(key, ..., 'EX', TTL) } catch {}`; (3) `invalidateXCache(orgId)`; (4) у update — conditional invalidation ТІЛЬКИ коли relevant fields (workStartTime/End) змінились; (5) cache scope (orgId vs orgId+branchId) = actual scope.
**Impact:** Calendar mount: findFirst з nested orderBy → Redis GET. Per 60s: 1 DB hit замість 5-20.
**Де шукати ще:** settings/config service (settings.service, app-config.service, infrastructure.service) з тонкими getter-ами — UI-features, dashboard-config, quick-stats, notification-defaults, theme-config, default-warehouse.

### 2026-06-16 — Nested loop `outerList.find(o => innerList.some(i => i.fkField === o.id && intervalOverlap(i, slot)))` у hot-path availability/conflict — bucket inner list by FK у Map один раз + pre-parse Date→Ms

**Сигнал:** service-метод (booking.getAvailability, calendar conflict-check, scheduling) генерує candidate windows і для КОЖНОГО `outerArr.find(outer => !innerArr.some(inner => inner.fk === outer.id && new Date(inner.startAt) < window.end && new Date(inner.endAt) > window.start))`. Frontend: `bookings.map(b => lifts.find(lift => !calSlots.some(s => s.liftId === lift.id && ...)))`. Outer T=20-50 × inner N=5-50 × M=100-500 = T×N×M + `new Date()` alloc-heavy.
**Grep:** `\.find\([^)]+=>\s*!\w+\.some\(` АБО `\.find\([^)]+=>\s*\w+\.some\([^)]+\w+Id === \w+\.id[\s\S]{0,200}new Date\(`
**Причина:** декларативно. Колекції малі у dev; production 50 lifts × 500 slots × 20 timeslots = 500_000 ops + 10_000 Date allocs.
**Фікс:** (1) bucket inner by FK у `Map<fkValue, []>` перед outer (O(M) setup, `if (!i.fk) continue`); (2) pre-parse Date→Ms під час bucket (`startMs: new Date(i.startAt).getTime()`); (3) у predicate замість `.some()` — explicit for-loop з числовим порівнянням (`busy = bucketByFk.get(outer.id); for (const p of busy) if (p.startMs < windowEndMs && p.endMs > windowStartMs) return false`). O(T×N×avg(M/N)) + 0 Date allocs.
**Impact:** 50 lifts × 500 slots × 20 timeslots: ~500_000 ops + ~10_000 allocs → ~10_000 ops + ~1000 (50× CPU, 10× GC).
**Де шукати ще:** scheduling/availability/conflict — calendar slot conflicts, booking free-resource, inventory FIFO/LIFO з overlapping reservations, settlements period overlap, pricing overlapping ranges. Frontend: useMemo filtered subset де outer.map → inner.find/.some з FK.

### 2026-06-16 — `useMemo<T[]>(() => [], [])` всередині компонента для stable-empty-array placeholder — module-level const замінює без зміни семантики

**Сигнал:** `const EMPTY_X = useMemo<X[]>(() => [], [])` (або `useMemo(() => new Map(), [])`) — empty-collection placeholder (`slotsByLift.get(id) ?? EMPTY_X`). useMemo `[]` стабільний між render-ами mount, але alloc новий `[]` на КОЖНОМУ mount.
**Grep:** `useMemo<\w+\[\]>\(\(\) => \[\], \[\]\)` АБО `useMemo\(\(\) => new (Map|Set)\(\), \[\]\)`
**Причина:** пам'ятають «literal `[]` у JSX → нова ref → memo скидається», тягнуть useMemo. Empty collection — стале значення; достатньо module-level const.
**Фікс:** `const EMPTY_BOOKINGS: BookingSlot[] = [];` на module-level, видалити useMemo. Не чіпати якщо нова empty-collection при умовах (dynamic-import/feature-flag).
**Impact:** -1 alloc + -1 hook slot на mount. Корисно у grids що re-mount (calendar toggle, modal).
**Де шукати ще:** `EMPTY_*`/`DEFAULT_*` через useMemo `[]` — calendar widgets, DetailPanel, EntityPickerField fallback, useReducer initial empties.

### 2026-06-15 — Collapsible-header `chips` inline IIFE `headerCollapsed ? [...].filter(Boolean) : []` у render — recompute на КОЖЕН keystroke у inner Input

**Сигнал:** form-modal (PO/SD/WO Create) з collapsible header + `headerChips` inline: `const headerChips = headerCollapsed ? [supplierDisplay, form.warehouseId ? warehouses.find(w => w.id === ...)?.name : null, contractNumber ? ...].filter(Boolean) : [];`. На КОЖЕН render (typing → setForm) масив пересоздається, `warehouses.find()` O(N), `.filter()` alloc.
**Grep:** `const \w+Chips = \w+Collapsed \?[\s\S]{0,400}\.find\([\s\S]{0,200}\.filter\(Boolean\)`
**Причина:** «chips — похідне від collapsed» виглядає inline. Не помічають що Inputs фірять setForm на keystroke → chips recompute → JSX-children identity-thrash.
**Фікс:** (1) reference-Map `warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])`; (2) `useMemo` навколо headerChips з deps `[headerCollapsed, supplierDisplay, form.warehouseId, warehouseById, contractNumber]`.
**Impact:** typing у «Примітки» 20-50 keystrokes × 3 find + allocs → 250-300 wasted ops/сесію.
**Де шукати ще:** form-modal з collapsible header (WO, Invoice, Estimate, PO, SD, SR, BookingRequest); breadcrumb-strips, tag-displays, «Recent items».

### 2026-06-15 — Form/modal totals `reduce(...)` поза useMemo — викликається на КОЖЕН render навіть коли lines не змінились

**Сигнал:** form-modal з табличкою рядків має `const total = totalFromLines(lines);` АБО inline `lines.reduce(...)` без useMemo. Поряд controlled Inputs (notes/date) → setState на typing → total recompute O(N) навіть коли lines незмінні. PO CreateModal мав memo, SupplierReturn — НІ (copy-paste-evolve розрив).
**Grep:** `const total = \w+\(\w+\);$` АБО `const total = \w+\.reduce\([\s\S]{0,300}\);[\s\S]{0,100}return \(` (без useMemo між decl і use).
**Причина:** copy-paste; один отримав useMemo, інший inline.
**Фікс:** `const total = useMemo(() => totalFromLines(lines), [lines])`; якщо VAT/discount — single-pass `useMemo(() => { let total=0; let vat=0; for (const l of lines) {...}; return {total, vat}; }, [lines])`.
**Impact:** typing 30 keystrokes × 10 lines = 300 wasted ops; 100+ позицій → 3000.
**Де шукати ще:** парні modal copy-pasted: PO CreateModal ↔ SupplierReturn, Estimate ↔ Invoice, SD Create ↔ Receive, WO Create ↔ Edit.

### 2026-06-15 — Row-handler async `const X = async (item) => {...}` без useCallback у list-page → inline arrow `onClick={() => void markX(item)}` × 20 рядків

**Сигнал:** list-page з 5-10 row-handlers (`handleTransition`, `markDeleted`, `loadDetail`) як `const X = async (po) => {...}` БЕЗ useCallback. У `.map(po => <button onClick={() => void markDeleted(po)}>)` — inline arrow × 20 rows × render. Гальмує майбутнє memo(TableRow).
**Grep:** `const handle\w+ = async \([^)]+\) => \{` без useCallback + `onClick=\{\(\) => void handle\w+\(\w+\)\}` у `.map()`.
**Причина:** великі файли (300-1500 LOC); `const = async` менше boilerplate.
**Фікс:** useCallback з мінімальними deps `useCallback(async (po) => {...}, [confirm, queryClient])`. Для handler→handler порядок declaration (залежний перший). Якщо use `load` (recreated) — eslint-disable з коментарем. Стратегія: усі row-handlers одночасно, один pass.
**Impact:** stable onClick → майбутній memo(TableRow) без identity-thrash. Зараз ≈0мс, інвестиція.
**Де шукати ще:** усі list-page (catalog/inventory/WO/invoices/counterparties/employees).

### 2026-06-15 — Branching ternary `cond ? findFirst(validate-by-id) : findFirst(auto-pick-by-criteria)` всередині Promise.all — single optional FK з двома query shapes у одному слоті

**Сигнал:** create-сервіс приймає optional FK (contractId) з двома гілками ПІСЛЯ Promise.all основних guards: (A) `if (dto.X) findFirst({where:exact-id})` (validate), (B) `else findFirst({where:criteria, orderBy})` (auto-pick primary). Sequential if/else додає 1 RTT.
**Grep:** `let \w+Id = dto\.\w+Id \?\? null;[\s\S]{0,500}if \(\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}\} else \{[\s\S]{0,300}findFirst[\s\S]{0,300}orderBy`
**Причина:** лінійне «дано→validate, ні→auto-pick». Обидві гілки мають синхронно-доступні предикати (dto+scalars).
**Фікс:** (1) `const hasContractId = !!dto.X;` ДО Promise.all; (2) виlift тернарку у Promise.all `hasContractId ? findFirst(exact-id) : findFirst(criteria, orderBy)`; (3) post: `if (hasContractId && !contract) throw NotFound; const contractId = hasContractId ? (contract as {id:string}).id : (contract?.id ?? null)`.
**Impact:** PO create() 3 RTT → 2 RTT (33%).
**Де шукати ще:** create()/addX() з optional FK + auto-pick fallback (primary contract, default warehouse/branch/currency, primary employee/bank-account). Розширення «Auto-pick optional FK ПІСЛЯ parallel guards» на обидві гілки у тому слоті.

### 2026-06-15 — Sequential `findFirst (tenant guard) → create + update` де create і update пишуть у РІЗНІ таблиці але читають той entity.id — settlements/payments/balance триплет

**Сигнал:** сервіс (settlements.createTransaction, balance-mutate): `const account = await db.X.findFirst({tenant guard}); if (!account) throw; await db.Y.create({settlementAccountId: account.id}); await db.X.update({where:{id: account.id}, data:{balance:{increment: delta}}})`. Sequential create (event-log) + update (aggregate balance) — обидва читають `account.id`, РІЗНІ таблиці. Writes resolve concurrently на pinned tx connection.
**Grep:** `await \w+\.\w+\.findFirst[\s\S]{0,200}await \w+\.\w+\.create\([\s\S]{0,400}await \w+\.\w+\.update\(`
**Причина:** event-log «спочатку подія, потім баланс». Порядок не має значення (increment атомарний у $tx).
**Фікс:** (1) sync pre-compute (`balanceDelta` по type-enum) ДО $transaction (fail-fast); (2) findFirst sequential, потім `await Promise.all([X.create(...), X.update(...)])`; (3) `select: {id: true}`.
**Impact:** settlement.createTransaction на WO COMPLETED/invoice PAID/payment.create. 100 WO/day × ~4 → 400 RTT saved/day.
**Де шукати ще:** append-only event-log + aggregate-mutate: payment.create + invoice.balanceDue.decrement, stock-movement.create + stock-item.quantity.increment, audit-event.create + entity.update. ОБЕРЕЖНО коли create+update у ту саму таблицю (race) — завжди РІЗНІ таблиці.

### 2026-06-15 — Chunked bulk-update loop у $transaction де input plan МОЖЕ мати duplicate PK — Promise.all + Map-dedup last-wins

**Сигнал:** bulk-pricing/import (applyRule, applyPricing з PO/xlsx) будує `plan: {goodId, ...}[]`, потім `for (i += CHUNK) { $transaction(tx => for (const u of chunk) await tx.X.update({where: {id: u.goodId}})) }`. Disjoint PK → кандидат на Promise.all. АЛЕ коли ОДИН товар кілька разів (PO кілька ліній того goodId; xlsx multi-SKU→той good) — sequential мав last-write-wins; Promise.all на duplicate PK = race.
**Grep:** `for \(const \w+ of chunk\) \{[\s\S]{0,200}await tx\.\w+\.(update|updateMany)`
**Причина:** chunked bulk pattern; sequential «по одному» безпечно. Не задумувались чи входи унікальні.
**Фікс:** аналіз джерела plan ДО Promise.all: (1) unique PK (findMany.map, IDs з Set) → просто Promise.all; (2) МОЖЕ мати duplicate PK → `const deduped = Array.from(new Map(plan.map(u => [u.pkField, u])).values())` ДО Promise.all. priceHistory.createMany пише унікальні рядки.
**Impact:** chunk=100 × 10 → 1000 sequential await → 10 batches Promise.all.
**Де шукати ще:** chunked update loop у $transaction: pricing rules, list import, bulk discount, mass status change, cleanup workers. Увага коли plan з parent.lines (дублі) vs findMany (PK-unique).

### 2026-06-15 — Inventory-mutation helper + parent-line metadata update — sequential await пара у per-line $transaction loop де writes у РІЗНІ таблиці

**Сигнал:** service applies effect документу (PO receive, SD CONFIRMED, WO complete): `$transaction(tx => for (const line of doc.lines) { await inventory.createMovement(...); await tx.purchaseOrderLine.update({unitOfMeasureId, receivedQty: {increment}}) })`. createMovement пише у StockMovement/StockBatch/StockItem, parentLine.update у PurchaseOrderLine — НЕ перетинаються. Sequential × N. TRANSFER має 2 createMovement (writeoff→receipt, disjoint keys).
**Grep:** `for \(const \w+ of \w+\.lines\) \{[\s\S]{0,500}await this\.inventory\.createMovement[\s\S]{0,300}await tx\.\w+Line\.update`
**Причина:** helper «важкий» → sequential; parentLine.update «продовження». Реально writes у різні composite keys.
**Фікс:** `await Promise.all([inventory.createMovement(...), tx.parentLine.update(...)])`. Conditional UoM: `lineUnitId ? tx.parentLine.update(...) : Promise.resolve()`. TRANSFER: writeoff+receipt+UoM у Promise.all. Loop-carried (receivedAmount +=, results.push) post-await.
**Impact:** PO receive() 10 lines: 20 RTT → 10 (50%). SD CONFIRMED 5 lines: 10→5. TRANSFER: 15→5.
**Де шукати ще:** invoice payment apply (line-update + payment-create), credit note refund, WO complete (createMovement + part.update), PO receive (+settlement.createTransaction), credit-charge reversal.

### 2026-06-15 — N-FK guards у update() з conditional шляхами (if dto.X) — третій FK validation з cross-dependency на dto.supplierId/effective entity

**Сигнал:** update() з кількома optional FK (`dto.supplierId`, `dto.warehouseId`, `dto.contractId`). Три послідовних `if (dto.X) { const X = await findFirst({...}); if (!X) throw }`. Останній FK може мати cross-dependency `effectiveSupplierId = dto.supplierId ?? po.supplierId` — але це scalar lookup, НЕ блокування на попередній findFirst.
**Grep:** `update\(orgId.*dto.*\)[\s\S]{0,200}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst`
**Причина:** «захищаємо кожен FK окремо». Cross-dependency `effectiveSupplierId` маскує що contract validation читає лише скаляр у scope.
**Фікс:** `effectiveXxxId = dto.xxxId ?? po.xxxId` синхронно ДО Promise.all. У Promise.all три тернарки `dto.X ? findFirst({...}) : Promise.resolve(null)`. ПІСЛЯ — `if (dto.X && !result) throw NotFound`.
**Impact:** update() supplier+warehouse+contract у одному PATCH: 3 RTT → 1 (67%).
**Де шукати ще:** invoice.update (counterpartyId+warehouseId+priceListId), workOrder.update (vehicleId+counterpartyId+contractId+liftId), stockDocument.update.

### 2026-06-14 — Detail-panel/Drawer/Modal будівник через IIFE у тілі parent list-page — tabs object identity рекреюється на КОЖЕН render

**Сигнал:** list-page з secondary panel + tabs у JSX через IIFE `(() => { const buildX = item => [...]; return <Panel tabs={selectedItem ? buildX(selectedItem) : undefined} configFields={schemaToConfigFields(...)} /> })()`. tabs+configFields пересоздаються на КОЖЕН render навіть коли selectedItem не мінявся. Якщо panel.useEffect deps містять onClose/tabs identity → re-fires → addEventListener/removeEventListener + Input focus скидається.
**Grep:** `\{\(\(\) =>` у JSX-тілі >300 LoC компонентів поряд з `<DetailPanel|<Modal|<Drawer|<SlidePanel`.
**Причина:** inline закриття дає доступ до state без props drilling. IIFE «нічого не коштує», але tabs.content має controlled `<Input onChange={inline arrow}>` → каскад re-render.
**Фікс:** (1) memo-компонент `XDetailPanel` на module-level з explicit props (selectedItem, editingX, onCloseX, onSaveX, panelConfig); (2) всередині `const tabs = useMemo(() => {...}, [selectedItem, editingX, ...])`, configFields теж useMemo; (3) parent handlers через useCallback. panelConfig type — `ReturnType<typeof useDetailPanelConfig>`.
**Impact:** typing у parent debounce → tabs identity stable → Input focus не зривається.
**Де шукати ще:** list-page з DetailPanel/Drawer/Modal inline (counterparties, WO, invoices, PO, SD).

### 2026-06-14 — Новий list/report endpoint з date sort без covering index — `findMany({orderBy: createdAt, take})` seqscan коли existing index не покриває WHERE

**Сигнал:** новий endpoint робить `findMany({where: {orgId, [optionalCol1], [createdAt range]}, orderBy: {createdAt}, take: N})` на append-only (StockMovement, AuditLog, Notification, BatchConsumption). Existing `(orgId, warehouseId, createdAt)`, але новий WHERE more permissive (warehouseId optional). warehouseId IS NULL → index не вибирається → seqscan + external sort.
**Grep:** `findMany.*orderBy.*createdAt` + `take: \d{3,}` + `grep "@@index" packages/database/prisma/schema/*.prisma`. Якщо найкращий index має >1 col перед `createdAt` що query не фільтрує — гап.
**Причина:** старі індекси під старі endpoint-и; новий звітний з ширшою area.
**Фікс:** covering `@@index([orgId, sortKey])` для unfiltered + `@@index([orgId, optionalCol, sortKey])` для типового фільтру. Не плодити надлишкові (PG бере prefix). Commit з explain trace.
**Impact:** take:3000 на 100k-500k рядків: seqscan ~150-300мс → index scan ~5-15мс.
**Де шукати ще:** після нового report/list на append-only (StockMovement, AuditLog, BatchConsumption, Notification, WorkOrderStatusLog).

### 2026-06-14 — Sequential `await tx.X.update(...); await tx.Y.create(...)` у loop-карриджних батч-операціях — Promise.all всередині ітерації без злому loop-carried стану

**Сигнал:** `for (const x of batches) { await db.X.update(...); await db.Y.create(...); remaining -= take; }` — два writes на ітерацію не залежать (update на batchId, create batchConsumption), але loop-carried (`remaining`) сериальний.
**Grep:** `for \(const .* of .*\)\s*\{[\s\S]{0,300}await .*\.\w+\.update[\s\S]{0,200}await .*\.\w+\.create`
**Причина:** «update partition, потім create record»; результат update нікуди не йде.
**Фікс:** `await Promise.all([db.X.update({...}), db.Y.create({...})])` (race-safe, різні таблиці). Loop-carried post-await. Той для `findFirst → update + create` де update+create залежать лише від `.id`.
**Impact:** consumeBatch 5 partitions: 10 RTT → 5 (50%). returnToBatch 10 parts → 10 RTT.
**Де шукати ще:** batch-consume/release/return у inventory/batch/work-orders.service; settlement reconciliation, invoice payment apply.

### 2026-06-12 — Disjoint-set `tx.X.updateMany()` pairs всередині `$transaction` — Promise.all замість sequential await

**Сигнал:** sync/refresh/cascade у `$transaction` робить 2+ послідовні `await tx.X.updateMany({where:A})` потім `await tx.X.updateMany({where:B})` де A і B DISJOINT (children `parentSlotId: {not: null}` vs parent `parentSlotId: null`). Sequential = 2 RTT.
**Grep:** `await tx\.\w+\.updateMany[\s\S]{0,300}await tx\.\w+\.updateMany`
**Причина:** «soft-delete A, потім update B»; updateMany виглядає «небезпечніше» за розноску у Promise.all.
**Фікс:** `const [, r2] = await Promise.all([tx.X.updateMany({where:A}), tx.X.updateMany({where:B})])`. Prisma parallel у interactive tx на одну connection. Race-safe (WHERE disjoint). Той для tenant-guard + parentSlot lookup у tx.
**Impact:** sync ~30% швидші (2 RTT → 1). 100-RPS: ~50ms savings.
**Де шукати ще:** cascade-update/sync/refresh/propagate/`markAsX`; bulk soft-delete після transition; refresh-totals helpers.

### 2026-06-12 — `kyivToday()`/date helper всередині render `.map()` callback — lift у useMemo на рівень компонента

**Сигнал:** `array.map(item => { const todayKyiv = kyivToday(); const isOverdue = item.date < todayKyiv; ... })` — `kyivToday()` (`new Date() + Intl.format()`) у тілі `.map()`. 8-row → 8× per render.
**Grep:** `\.map\([^)]*=>\s*\{[^}]*kyivToday\(\)|\.map\([^)]*=>\s*\{[^}]*Date\.now\(\)`
**Причина:** kyivToday() виглядає константою; ставлять у map-body.
**Фікс:** `const todayKyiv = useMemo(() => kyivToday(), [])` над JSX (deps `[]` + eslint-disable з коментарем mount-stable). Auto-refresh → useState + useEffect interval. Fix pure-render (race з timer).
**Impact:** 8-row dashboard: 8× → 1×. Для high-render-frequency (15s polling, table cells).
**Де шукати ще:** date-helper з `new Date()` — kyivNow, kyivToday, isoToday, todayMs; `Date.now()`, `new Date()` direct; reports/audit lists з `item.date < today`. Той для `formatXyz` з Intl singleton.

### 2026-06-11 — Dead `Object.keys(MAP)[0]` / `Object.keys(MAP)` в IIFE-render — module-level frozen `*_ORDER` const

**Сигнал:** компонент-форма має `const initialStatus = Object.keys(STATUS_LABELS)[0] ?? 'DRAFT'` (раз на рендер) АБО IIFE-pattern `{(() => { const statusOrder = Object.keys(STATUS_LABELS); const curIdx =...
**Grep:** `Object\.keys\(\w+\_LABELS\)|Object\.keys\(.*\_MAP\)|Object\.keys\(._STATUS._\)`**Фікс:** module-level`const X_ORDER: readonly string[] = Object.freeze(Object.keys(X_LABELS))`поза компонентом. Імпорт у IIFE замість recompute.`[...arr].reverse().find(...)` patterns переписати як reverse...

### 2026-06-11 — Inline status-list literals `['DRAFT', 'X', 'Y'].includes(v)` у render path — module-level frozen sets

**Сигнал:** компонент має `const canX = status === 'A' || status === 'B'` АБО `const canY = isMode && ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(currentStatus)` всередині render body. На КОЖЕН render створюється...
**Grep:** `\['[A-Z_]+'(,\s*'[A-Z_]+')+\]\.includes\(`
**Фікс:** module-level `const EDITABLE_STATUSES = Object.freeze(['DRAFT', 'ESTIMATE', 'APPROVED'] as const)`. У render: `(EDITABLE_STATUSES as readonly string[]).includes(currentStatus)`. Якщо backend має той...

### 2026-06-11 — Race-window guard через двошарову state (useRef + useState) — wrapper-setters замість додавання state у useCallback deps

**Сигнал:** modal/dialog має guard у `onClose`/`handleClose`: `if (saving || transitioning) return` — щоб НЕ закривати під час pending POST. Коли guard читає `saving` через React closure у `useCallback([saving,...
**Фікс:** пара `const xRef = useRef(false); const [x, setX] = useState(false);`+ wrapper-setter`const setXBoth = useCallback((v: boolean) => { xRef.current = v; setX(v); }, [])`. Кожен виклик...

### 2026-06-11 — Twin-scan `reduce()` у tfoot/footer для VAT + total — single-pass useMemo з двома акумуляторами

**Сигнал:** modal/form з таблицею редагування рядків (lines/parts/items) має `<tfoot>` який рендерить підсумок VAT + total. Розробник пише два окремих `lines.reduce(...)` блоки (один для VAT, один для total) у...
**Grep:** `\.reduce\(.*\n.*\.reduce\(`
**Фікс:** один `useMemo(() => { let total = 0; let vat = 0; for (const l of lines) { const h = toNumberOrUndefined(...); ...; if (vatRate > 0) vat += sum * vatRate / 100; } return { total, vat }; }, [lines,...

### 2026-06-11 — Per-row `array.find(x => x.id === row.foreignKey)` у `.map()` і onChange — O(N×M) → useMemo Map.get O(1)

**Сигнал:** компонент має reference-data масиви (employees/warehouses/units/branches/lifts/vehicles) у стейті або prop, і у `lines.map(line => { const emp = employees.find(e => e.id === line.employeeId); ... })`...
**Grep:** `\.find\(.*=>.*\.id\s*===`
**Фікс:** для кожного reference-data масиву — `const xById = useMemo(() => { const m = new Map<string, X>(); for (const x of xArray) m.set(x.id, x); return m; }, [xArray])`. У map / onChange:...

### 2026-06-10 — Overfetch `include: { childRel: take:1000 }` у FSM transition/guard методах де child-rel не читається у тілі — "повний WO для side-effects" що re-fetch внутрішньо

**Сигнал:** FSM/transition метод починається з `findFirst({ include: { childRel: { where: { deletedAt: null }, take: N } } })` де childRel — one-to-many (parts, lines, items, allocations) на...
**Grep:** `wo\.`
**Фікс:** замінити `include: {childRel}` на `select: {...scalar fields actually used...}`. Перерахувати точний набір через grep `wo\.` у тілі. Залишити лише ID/scalar/FK що читаються....

### 2026-06-10 — Inline arrow handlers у row-репитері list-page (status pills, tabs, filter chips) — кліку-кнопки у `.map()` без memo-component

**Сигнал:** list-page має константу типу `STATUS_TABS = [...]` (10-20) і у JSX рендерить через `.map(([v, l]) => <button onClick={() => { setX(v); resetPage(); ... }} className={cn(...)}>{l}</button>)`...
**Фікс:** виокремити module-level memo-component `const StatusPill = memo(function StatusPill({ value, label, active, description, onSelect }: Props) { return description ? <Tooltip>{btn}</Tooltip> : btn })`....

### 2026-06-10 — IIFE `(() => { const builder = ...; return <X tabs={builder(selectedItem)} /> })()` у тілі return батьківського компонента — DetailPanel/Drawer/Modal tabs побудова у render

**Сигнал:** у JSX батьківського компонента (list-page, dashboard, settings) є блок `{(() => { const buildTabs = (item) => [...]; return <Panel tabs={selectedItem ? buildTabs(selectedItem) : undefined} /> })()` —...
**Grep:** `\{\(\(\) =>`
**Фікс:** двофазний refactor: (1) Lift inner function body у `useMemo(() => { if (!selectedItem) return undefined; const item = selectedItem; return [...tabs...]; }, [selectedItem, ...deps])`. Параметер...

### 2026-06-10 — `.some()` + `.filter().map().join()` twin-scan derived string у warning/badge UI — conflict slots, error chips, batch summary

**Сигнал:** UI рендерить попередження/підсумок з derived string з масиву: `{calConflict.conflictSlots.length} слотом(и) {calConflict.conflictSlots.some(s => s.workOrderNumber) && (<>...
**Grep:** `\.some\(._=>._\)\s*(&&|\?)`**Фікс:** useMemo single-pass:`const derived = useMemo(() => { const result: string[] = []; for (const s of array ?? []) { if (s.predicate) result.push(s.field); } return result.join(', '); }, [array])`. Деps...

### 2026-06-10 — Inline React component declared inside parent component body — sidebar/shell/layout композити з вкладеними NavLink/Row/Cell

**Сигнал:** усередині функції-компонента (особливо великих `Shell`/`Layout`/`Wizard`) оголошений локальний підкомпонент через `const NavLink = ({ item }) => (...)` або `function Row(props) { return...
**Фікс:** дві стратегії: **(A) render-helper** — перейменувати на `renderNavLink(item, opts?)`і кликати як **function call**`{renderNavLink(item)}` замість JSX-element. React тоді...

### 2026-06-10 — React Context Provider value object без useMemo — providers що тримають частину state у useState + частину callbacks у useCallback

**Сигнал:** Provider рендерить `<XContext.Provider value={{ state1, state2, callback1, callback2 }}>` — об'єкт-літерал inline у JSX. `state1`/`state2` живуть у useState (стабільні поки не змінюються),...
**Фікс:** обгорнути value у `useMemo(() => ({ state1, state2, callback1, callback2 }), [state1, state2, callback1, callback2])`. callback-и у deps безпечні бо стабільні через useCallback. Якщо у Provider...

### 2026-06-10 — Multiple mount-only useEffect з `[]` deps у одному компоненті — localStorage seeding/window event setup розпорошений по 3+ ефектах

**Сигнал:** великий компонент (Shell/Page/Layout) має 3+ окремих `useEffect(() => {...}, [])` що всі виконуються ОДИН раз при mount. Типово: `localStorage.getItem(KEY1)` + `setStateFromSaved`,...
**Фікс:** об'єднати в один `useEffect(() => { /* all mount-only logic */; return () => { /* cleanups */ } }, [])`. Зберегти `try/catch` навколо кожного localStorage read (один впав не зупиняє інших)....

### 2026-06-10 — `findMany({where: {id: {in:[...]}, take})` для FK-existence замість `count()` — services/validators bulk-FK guard

**Сигнал:** Backend service (типу `create`/`update` що приймає DTO з масивом FK — `dto.works[]`, `dto.goods[]`, `dto.serviceIds[]`) валідує IDs через `findMany({ where: { id: { in: ids },...
**Фікс:** замінити `tx.X.findMany({...})`на`tx.X.count({where})`. Постгрес виконає `COUNT(*) WHERE...`що при composite index`(orgId, id)` дає index-only scan (vs full row...

### 2026-06-10 — Redundant @@index([orgId]) поверх @@unique([orgId, X]) — reference моделі з composite unique key

**Сигнал:** модель Prisma має `@@unique([orgId, X])` (де X = code/rate/eventType+channel/key+...) і
**Фікс:** видалити `@@index` (НЕ `@@unique` — він несе constraint-семантику). Залишити коментар над `@@unique` чому окремий `@@index` не потрібен. `prisma db push...

### 2026-06-10 — Cycle-N gap у дубльованих файлах з однією назвою — settings/PaymentsTab vs ndi/PaymentsTab

**Сигнал:** у різних роутах (`apps/web/src/app/(app)/settings/X.tsx` і `apps/web/src/app/(app)/ndi/X.tsx`) існують
**Фікс:** застосувати ТОЙ самий patтерн (Promise.allSettled, etc.) до sibling-файлу. У commit-message «cycle-N gap — pattern applied to sibling X.tsx». Якщо файли семантично дублікати (один і той...

### 2026-06-10 — Frontend для-await POST у "Import from templates" handlers — bulk-create незалежних reference rows із серійним RTT

**Сигнал:** UI sub-tab (PaymentsTab/CurrenciesTab/UnitsTab/reference-CRUD з "Додати з шаблону") має handler `importFromTemplates(templates)` що ітерує `for (const t of templates) {...
**Grep:** `for \(const \w+ of templates\)`**Фікс:**`Promise.allSettled(templates.map(t => apiFetch(POST, body)))`→ iterate results:`for (const r of results) { if (r.status === 'fulfilled') created.push(r.value) }`. Batch state update в кінці:...

### 2026-06-10 — Duplicate getCached() у парних useState lazy initializers — composable hooks з data+loading pair

**Сигнал:** composable hook (`useCachedRefData`, `useSavedFilters`, `useCachedQuery`): `const [data, setData] = useState<T>(() => getCached<T>(key) ?? fallback); const [loading, setLoading] =...
**Фікс:** `const initialCacheRef = useRef<T | null | undefined>(undefined); const readOnce = (): T | null => { if (initialCacheRef.current === undefined) initialCacheRef.current = getCached<T>(key); return...

### 2026-06-10 — Static toolbar comparison `JSON.stringify(CONSTANTS.map(c => c.key))` у render path — column-config hasCustomization check

**Сигнал:** list-page toolbar (`work-orders/page.tsx`, `invoices/page.tsx`, ... 9 файлів) має `ColumnsDropdown hasCustomization={JSON.stringify(order) !== JSON.stringify(CONSTANTS.map(c => c.key)) || ...}`....
**Grep:** `JSON\.stringify\([^)]*\.map\(`
**Фікс:** двофазний refactor: (1) **лифт CONSTANTS** з useMemo (або in-component) до module-level — `const WO_COLUMNS: Array<{ key: string; label: string; defaultVisible?: boolean }> = [...]`. **Тип явно**, не...

### 2026-06-10 — Sequential conflict checks всередині $transaction для disjoint-where queries у одній таблиці

**Сигнал:** service метод (`calendar.createSlot`, `calendar.updateSlot`) всередині `await this.prisma.$transaction(async tx => { ... })` робить кілька
**Фікс:** обернути конфлікт-перевірки у `const [conflict, empConflict] = await Promise.all([cond1 ? tx.X.findFirst({where:..., select:{id:true}}) : Promise.resolve(null), cond2 ? tx.X.findFirst({where:...,...

### 2026-06-10 — Per-item `$transaction(callback, { timeout })` у row-importer циклах — bulk import окрема транзакція для КОЖНОГО рядка

**Сигнал:** import-метод (`xlsx.applyPricingFromList`, `xlsx.importX`, bulk CRUD imports) має для кожного row окремий `await this.prisma.$transaction(async tx => { ...mutation +...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,500}await this\.prisma\.\$transaction\(`**Фікс:** двофазний refactor: (1) **plan phase** — у циклі зібрати масив`Plan[]` (`{ id, ...changes }`) у пам'яті, без mutations. Filter early-skip (no change, validation failures) у...

### 2026-06-10 — Sequential update/create per-row у post-prefetch row-importer — bulk import де prefetch усуває N+1 reads, але writes sequential

**Сигнал:** import-метод робить bulk prefetch (`goodsByKey`, `existingByGoodId` map) ДО циклу (видалено read N+1). Але всередині `for (const row of rows)` тіло все одно робить `if (existingId)...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,300}existingByGoodId\.get|existingById\.get|await this\.prisma\.\w+\.update[\s\S]{0,200}await this\.prisma\.\w+\.create`**Фікс:** трифазний refactor: (1) **plan phase** —`updatesPlan: {id, ...changes, label}[]`+`createsPlan: Prisma.XCreateManyInput[]`+`seenGoodIds: Set<string>` для dedup. У циклі: dup check, FK resolve,...

### 2026-06-09 — Коментар обіцяє «RepeatableRead/Serializable» але `$transaction(callback, { timeout })` лишається default ReadCommitted — refresh/update методи що переписують агрегатні стани

**Сигнал:** усередині service-методу `await this.prisma.$transaction(async tx => { ... }, { timeout: N })` БЕЗ `isolationLevel`. У коментарях вище — фраза «inside tx (RepeatableRead) to prevent...
**Grep:** `\$transaction\b`
**Фікс:** (1) bump до `isolationLevel: 'Serializable'`; (2) inner re-check критичного інваріанту (status, existence, deletedAt:null) усередині $tx з `select: { ...тільки потрібне }` — двопоясна страховка:...

### 2026-06-09 — Reverse-FK index miss на `(orgId, parentFK, deletedAt[, sortKey])` — list/groupBy endpoints що фільтрують дочірні документи по батьківському FK

**Сигнал:** новий feature додає cross-aggregate query на дочірній таблиці (Invoice/CalendarSlot/Warranty/Payment) фільтруючи по FK на батьківську сутність (workOrderId, counterpartyId, etc.) + tenant guard...
**Фікс:** covering `@@index([orgId, parentFK, deletedAt, sortKey])` де `sortKey` — orderBy колонка (createdAt/startAt/documentDate). Sort key потрібен якщо endpoint має `orderBy` — інакше...

### 2026-06-09 — Manual padStart/concat date formatter як локальна функція — фронт-сторінки де `fmtDate` уже імпортовано

**Сигнал:** на сторінці локальна `function formatDate(iso: string): string { const d = new Date(iso); const day = String(d.getDate()).padStart(2, '0'); const month = String(d.getMonth() +...
**Grep:** `function formatDate\|const formatDate = \|function fmtDt\|function fmtDate `**Фікс:** замінити тіло на`return fmtDate(iso);`— проксі-патерн (як`fmt() = fmtMoney(Number(n))` для LinkedDocumentsPanel). Сигнатура збережена, call-sites не торкаються....

### 2026-06-09 — Auto-pick/auto-select optional FK резолюція ПІСЛЯ parallel FK guards — sequential гілка `if (dto.X) validate; else autoSelect` на create-методах

**Сигнал:** create-метод починається з `Promise.all([fk1, fk2, fk3, fk4])` для tenant-validation FK (branch/vehicle/counterparty/lift), потім послідовний `if (dto.contractId) { provided = await...
**Фікс:** замість `if/else`блоку з двома послідовними`await findFirst`— додати n+1-й елемент у Promise.all:`dto.xId ? prisma.X.findFirst({where composite}) : prisma.X.findFirst({where autoPickKey,...

### 2026-06-09 — Sequential per-item idempotent service.create() у scheduler/job — multi-tenant bootstrap fetchers

**Сигнал:** scheduler/job (nbu-fetch, daily-rate-sync, bulk-import) ітерує колекцію (currencies/orgs/templates) через `for (const x of list) { await this.someService.create(orgId, ...) }`. Кожна...
**Grep:** `for \(const \w+ of \w+\)`
**Фікс:** `const results = await Promise.allSettled(list.map(async x => { ...body... return { ok, code, reason } }));` потім `for (const r of results) { if (r.status === 'fulfilled' && r.value.ok) fetched++;...

### 2026-06-09 — `findOne(dto) + secondary findFirst` partial-overlap pattern — PDF/export endpoints

**Сигнал:** export-endpoint (generatePdf/generateXlsx/exportReport): (1) `const dto = await this.findOne(orgId, id)` — публічний getter повертає DTO з частковим включенням relations,...
**Фікс:** inline'ити повний read всередину generatePdf — БЕЗ findOne — з extended `select`/`include` що покриває ВСІ поля для PDF (включно з phone/address). Promise.all з другим незалежним read...

### 2026-06-08 — Redundant @@index([X]) поверх @@unique([X]) — Prisma schema моделі з композитним unique-ключем

**Сигнал:** модель має одночасно `@@unique([orgId, email])` і `@@index([orgId, email])` — однакові колонки в однаковому порядку. У `pg_indexes` два B-tree на...
**Фікс:** видалити `@@index` (НЕ `@@unique`). У DB `DROP INDEX IF EXISTS "X_col1_col2_idx"` напряму (швидка операція, не вимагає міграції файлу — Prisma не...

### 2026-06-08 — Scroll/resize listeners без `passive:true` у portal-dropdown компонентах — datetime/date pickers, tooltip позиціонери, sticky popovers

**Сигнал:** portal-rendered dropdown (date picker, autocomplete, tooltip) має `useEffect` що `window.addEventListener('scroll', handler, true)` для repositioning через `getBoundingClientRect`....
**Grep:** `addEventListener\(['"]scroll['"]\s*,\s*\w+\s*,\s*(true|false)\b`
**Фікс:** замінити третій аргумент на `{ capture: true, passive: true }` (зберегти capture якщо був). У `removeEventListener` та сама options object (capture повинен матчитись)....

### 2026-06-08 — memo() без stable handler refs — list-item рендерери у формах з частим typing

**Сигнал:** компонент-список елементів (checkbox-list, item-grid, row-list) обгорнутий у `React.memo()`, але батько передає `onChange={ids => { setX(ids); doY(); }}` — inline arrow на кожен...
**Фікс:** перетворити inline handlers на `useCallback`. Якщо handler читає state через сетер (`setX(ids)`) → setX стабільний → deps порожні. Якщо handler читає state value → useRef +...

### 2026-06-05 — Status-guarded soft-delete з sequential findFirst + update — invoices/PO/SD/WO remove()

**Сигнал:** `remove()` має business-rule guard через статус: `findFirst({ where: { id, orgId, deletedAt: null } })` повертає
**Фікс:** **двоступінчатий race-safe patern**: (1) `findFirst({ where: { id, orgId, deletedAt: null }, select: { status: true } })` — narrow, для status guard; (2) `if (!doc) throw NotFound; if (doc.status !==...

### 2026-06-05 — FK guard без narrow projection у Promise.all FK validation — будь-який create/update що валідує >1 FK

**Сигнал:** `Promise.all` з 2-5 паралельних `findFirst({ where: { id: dto.xId, orgId, deletedAt: null } })` для FK validation — БЕЗ `select: { id: true }`. Кожен тягне ВЕСЬ запис цільової...
**Grep:** `findFirst({ where: { id: dto\.`
**Фікс:** для кожного FK guard у Promise.all додати `select: { id: true }`. Якщо одне поле потрібне (`existing.shortName` для post-filter у units.update) — `select: { id: true, shortName: true }`....

### 2026-06-05 — Static tab/option arrays оголошені у тілі компонента — view switchers, period selectors, tab definitions

**Сигнал:** усередині функції-компонента статичний масив: `const TABS: { key, label }[] = [...]` або inline JSX `{[['day', 'День', Icon], ['month', 'Місяць',...
**Фікс:** підняти на module-level як `const X = [...] as const`(для tuple-arrays —`ReadonlyArray<readonly [...]>`). Icon components з lucide-react — pure refs, безпечно capture-ити....

### 2026-06-05 — Detail-в-list × DetailPanel — list endpoint тягне повну дочірню колекцію, хоча UI рендерить її ЛИШЕ для ОДНОГО вибраного row

**Сигнал:** list-endpoint містить `include: { lines/parts/children: { take: 1000, include: {...}}}` для O(20) rows. На фронті UI використовує це у ДВОХ місцях: (1) у table-cell — тільки...
**Фікс:** на backend — замінити `include: { X: { take: N, include: {...}}}` на `_count: { select: { X: { where: { deletedAt: null }}}}` + додати `linesCount?: number` у DTO; у `toDto` — fallback `doc._count?.X...

### 2026-06-05 — Cycle-N gap у міграції паттерну: один сервіс випав із попереднього аудиту, бо grep був неповний

**Сигнал:** новий аудит знаходить ВЖЕ-описаний у "Накопичених підходах" паттерн у конкретному сервісі (X.service.ts), хоча минулий аудит явно фіксав цей паттерн у 7-8 інших. Перевіряєш — так, цей файл...
**Фікс:** застосувати той самий fix-pattern. Зазначити у commit «cycle-N gap — pattern from <prev cycle>». У MemoryManual.md — рядок «Verified non-issues» НЕ...

### 2026-06-05 — Frontend N+1 через per-item GET у nested fetch loop — детальні сторінки що завантажують вкладену колекцію per-row

**Сигнал:** detail-сторінка (`/X/[id]/PageClient.tsx`) має 2-stage fetch — stage 1 завантажує колекцію parents (garages, vehicles, items), stage 2 робить `Promise.all(parents.map(p => apiFetch('/child?parentId='...
**Фікс:** на backend — CSV-параметр `?xIds=`+ parse →`vehicleId: { in: ids }`у where; cap 200 IDs + take 500. Frontend —`apiFetch(\`${url}?xIds=${ids.join(',')}\`)` ОДИН раз. Тип...

### 2026-06-06 — Bulk-filter через GRANDPARENT-relation замість CSV IDs — коли intermediate-FK list (garages, branches) суто проміжний

**Сигнал:** Frontend має триступеневу ієрархію: grandparent (counterparty) → parent (garage) → child (vehicle). API має filter `?parentId=X` (single FK). Frontend робить waterfall: `GET...
**Фікс:** на backend — у child controller `@Query('grandparentId')` (`?counterpartyId=`). У service: `where: { ..., parent: { grandparentId, orgId, deletedAt: null } }` — Prisma nested...

### 2026-06-05 — Bootstrap scheduler з per-org secondary fetch — onModuleInit/cron-init що читає settings/config окремо для кожної org

**Сигнал:** scheduler (`OnModuleInit`) робить `Promise.all(orgs.map(org => this.scheduleForOrg(org.id)))` де `scheduleForOrg` починається з `await prisma.organisationSettings.findUnique({ where: {...
**Фікс:** на onModuleInit — prefetch ВСІХ settings одним `findMany({ select: { orgId, X } })`→ Map<orgId, X>. Helper розбити: public`scheduleForOrg(orgId)` (single-use, тягне settings всередині) +...

### 2026-06-10 — `data: X = {}` destructure default у useQuery — Bug #328 cascade для object literals (не лише arrays)

**Сигнал:** компонент `const { data: linkedCounts = {} } = useQuery<Map>(...)` — fallback empty object при initial-load. Pattern «Fresh `[]` literal у `data?.items ?? []`» уже...
**Grep:** `useQuery.*\n.*data: \w+ = \{\}`
**Фікс:** module-level `const EMPTY_X: T = Object.freeze({}) as T` поза функцією-компонентом. Cast потрібен бо TypeScript не дозволяє `Readonly<{}>` присвоювати до mutable map — runtime семантика...

### 2026-06-05 — Per-render `getCached()`/sessionStorage read — composable hook без lazy state initializer

**Сигнал:** composable hook (`useCachedRefData`) робить `const cached = getCached(cacheKey)` як
**Фікс:** `const [state, setState] = useState<T>(() => getCached<T>(cacheKey) ?? fallback)`. Парні `useState` що залежать від того самого read — переписати кожен як окремий lazy initializer....

### 2026-06-04 — BullMQ processor без `concurrency` — I/O-bound job processors з external HTTP calls

**Сигнал:** `@Processor('queue-name')` + `@Process('job-name')` без `concurrency`. За замовчуванням `@nestjs/bull` обробляє 1 job одночасно. Якщо кожен job — окремий зовнішній HTTP виклик з...
**Grep:** `@Process(`
**Фікс:** `@Process({ name: 'job-name', concurrency: N })`. N = кількість одночасних HTTP connections безпечна для провайдера. Значення: webhook delivery: 5; SMS TurboSMS: 3...

### 2026-06-04 — Shared config fetched per-recipient in N-to-1 broadcast processor — batch notification dispatchers

**Сигнал:** BullMQ processor (або scheduled job) будує список N recipients і для кожного `service.send(orgId, recipientId, event, payload)`, де `send()` всередині тягне
**Фікс:** розбити `sendX()` на (1) `resolveConfig(orgId, branchId, event): Config | null` (async, DB reads) + (2) `sendWithConfig(orgId, recipient, config, vars)` (async, лише queue.add без DB). Processor:...

### 2026-06-03 — Fresh `[]` literal у `data?.items ?? []` → useEffect([items]) фаєрить кожен рендер — Bug-#328 cascade pattern

**Сигнал:** list читає React Query result як `const orders = queryData?.items ?? []` або `const { data: list = [] } = useX()`. Далі `useBulkSelect(orders)` або інший hook з...
**Фікс:** у hook що повертає paginated дані експортувати module-level `export const EMPTY_ITEMS: readonly never[] = Object.freeze([])`. Call-sites → `data?.items ?? (EMPTY_ITEMS as unknown as...

### 2026-06-03 — Bug fix у hook не пропагований на call-sites — `useListPage` приклад

**Сигнал:** comprehensive QA знаходить regression bug (Bug #328: fresh `[]` → useEffect race), виправляє у новому композитному hook (`useListPage`), додає regression test. Але call-sites не...
**Фікс:** опція А — export shared primitive (`EMPTY_ITEMS`, `STABLE_FALLBACK`) з hook; call-sites імпортують до повної міграції. Опція Б — мігрувати негайно (якщо...

### 2026-06-03 — Limit cap на endpoints що приймають user-controlled pagination — DoS hardening для `?limit=999999`

**Сигнал:** controller `@Query('limit') limit = '20'` → service як `+limit` без cap. Service `findMany({ take: limit })`. Захист на limit тільки у деяких endpoints...
**Фікс:** на початку service findAll: `const safeLimit = Math.min(Math.max(limit, 1), 200); limit = safeLimit;`. Опціонально `page = Math.max(page, 1)`. 200 — типовий cap для list...

### 2026-06-03 — Optional guard блокує main aggregation у reports — sequential branch/employee/warehouse findFirst перед raw SQL

**Сигнал:** report-метод (revenue, workOrders, stock, load, profitability) починається з `if (branchId) { const branch = await this.prisma.X.findFirst(...); if (!branch) throw }`, потім тяжкий `$queryRaw`...
**Фікс:** `const [guard, rows] = await Promise.all([X ? findFirst(select:id) : Promise.resolve(null), $queryRaw...])`. ПІСЛЯ: `if (X && !guard) throw NotFound`. Failure mode: aggregation на неіснуючому...

### 2026-06-03 — findOne як guard у update/create методах де update сам повертає DTO — narrow до id-only select

**Сигнал:** `update(orgId, id, dto)` або `createChild(orgId, parentId, dto)` починається з `await this.findOne(orgId, id)` — повертає повний DTO з усіма include relations, але результат
**Фікс:** замінити на `const existing = await this.prisma.X.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } }); if (!existing) throw...

### 2026-06-03 — Weighted SUM у JS reduce замість Postgres aggregate — `findMany(select scalars) + reduce(qty * cost)`

**Сигнал:** helper що рахує середньозважене (avg cost, avg margin, weighted score) робить `findMany({ select: { qty, cost } })` потім `.reduce((s, b) => s + b.qty * b.cost, 0)` + `.reduce((s, b) => s +...
**Фікс:** `$queryRaw<{total_cost, total_qty}[]>SELECT SUM(qty * cost) AS total_cost, SUM(qty) AS total_qty FROM X WHERE...` У CTE зберегти determinism (ORDER BY createdAt DESC + LIMIT N)...

### 2026-06-02 — Soft-delete `remove()` з business-rule guard (isSystem/isLocked) — updateMany з guard у WHERE + fallback на cheap re-read

**Сигнал:** `async remove(orgId, id)` завжди робить (1) `findFirst` для tenant + business-rule guard (isSystem/isLocked/status check), (2) `update` для soft-delete. Існуючий паттерн...
**Grep:** `async remove\(orgId.*id\)`
**Фікс:** `updateMany({ where: { id, orgId, deletedAt: null, isSystem: false }, data: { deletedAt: new Date() } })`. Якщо count===0 → cheap fallback `findFirst({ where: { id, orgId, deletedAt: null }, select:...

### 2026-06-02 — Speculative duplicate-check у update з business-rule перевіркою — паралелити Promise.all навіть коли duplicate check умовна

**Сигнал:** `async update(orgId, id, dto)` робить `findFirst` для tenant guard, потім умовно `if (dto.X && dto.X !== existing.X) { duplicate.findFirst }` — другий запит на основі результату...
**Фікс:** запустити обидва у `Promise.all([existing, dto.X ? duplicate : Promise.resolve(null)])`. ПІСЛЯ: `if (!existing) throw NotFound; if (dto.X && existing.X !== dto.X && duplicate) throw...

### 2026-06-01 — Sequential `tx.X.create` у $transaction callback — runtime hot-path (не bootstrap)

**Сигнал:** `for (const x of list) { await tx.X.create({...}) }` всередині `$transaction(async tx => {...})` де: (a) кожен create незалежний (немає read-залежностей), (b) не...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,200}tx\.\w+\.create\(`
**Фікс:** build `linesData: Prisma.XCreateManyInput[]` array у циклі замість `tx.X.create()`, потім `await tx.X.createMany({ data: linesData })`. createMany робить **один** INSERT з N рядками — найшвидший...

### 2026-06-01 — Dev-only npm package у production bundle — static import гарантує bundle inclusion навіть за runtime гілку

**Сигнал:** компонент-провайдер (QueryProvider, ThemeProvider, FeatureFlagsProvider) робить
**Фікс:** замінити static import на conditional `next/dynamic`:

### 2026-06-01 — Auth-gated UI widgets у root layout — render-blocked для unauthenticated, але код у layout chunk

**Сигнал:** `TopShell`/`AppShell`/`AuthenticatedLayout` (у root `layout.tsx` через `<TopShell>{children}</TopShell>`) робить статичний `import { CommandPalette,...
**Фікс:** замінити статичні імпорти на `next/dynamic` для conditional widgets:

### 2026-06-01 — Heavy modal у page chunk блокує table view — `Modal` із 300+ LOC форми у тому самому файлі що list view

**Сигнал:** сторінка-список (`PricingRulesClient.tsx`, `EmployeesClient.tsx`, `CrmPage.tsx`) має `function XFormModal({...}) { ... 300+ LOC ... }` у тому самому файлі що render таблиці. Modal використовує...
**Фікс:** трикомпонентний refactor:

### 2026-06-01 — Multi-loop sequential fan-out з shared dedup state — notification/email/sms dispatcher методи

**Сигнал:** processor/scheduler має 2+ окремих `for (const x of source) { ... if (!shared.has(key)) shared.add(key); await dispatcher.send(...) }` циклів. Між циклами шарується `Set<string>` для...
**Grep:** `for \(const .* of .*\) \{[\s\S]{0,200}await this\.\w+\.send\(`
**Фікс:** 1-й pass: collect+dedupe → `recipients: Recipient[]` (sync). 2-й pass: `await Promise.allSettled(recipients.map(r => dispatcher.send(...)))`. 3-й pass: iterate `results[]` для error tracking +...

### 2026-06-01 — View-state-gated fetch effects — багатовидові сторінки (day/month/stats, list/grid/calendar)

**Сигнал:** сторінка з тумблером виду (`useState<'day'|'month'|'stats'>`), окремі `useEffect` для кожного виду, АЛЕ один залежить тільки від data-key (`[date]`, `[id]`, `[filters]`) без...
**Фікс:** guard `if (viewMode === 'X') load()` до effect; додати `viewMode` у dep array. При поверненні до виду дані оновляться. Альтернатива — `useQuery({ enabled: viewMode === 'X' })`.

### 2026-06-01 — Object literals як local const у тілі компонента — DEFAULT/EMPTY initializers

**Сигнал:** `const EMPTY_FORM = {...}` або `const DEFAULT_FILTERS = {...}` всередині функції-компонента (capslock = натяк на константу, але scope локальний).
**Фікс:** підняти на module level. Якщо потрібна type-аннотація і тип у тому файлі — перенести оголошення типу вище. Перевірити що значення не залежить від props/state.
