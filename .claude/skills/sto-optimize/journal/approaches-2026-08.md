# sto-optimize — журнал підходів, 2026-08

> Не читати цілком — шукати за ключовим словом.

### 2026-08-30 (cycle 3/3) — Sibling-drift audit: після нового hot-path fix одразу пройтись по ВСІХ sibling-services/components і зафіксувати у той же коміт

**Сигнал:** попередній цикл фіксив один hot-path патерн (SP_SORT_FIELDS у одному CRUD-модулі), але наступний grep біжить тільки по нещодавно зміненому файлі. Sibling-модулі (invoices/WO/PO/SD — усі мають `findAll(sortBy?)` з `SORT: Record<string,string>` у body) лишаються не-міграцованими (copy-paste-legacy).
**Grep:** після кожного фіксу — ІДЕНТИЧНИЙ grep-signature (той що знайшов original) на ВСІХ файлах шару, не тільки git-diff-scope. Напр. `grep -rn "^\s\+const [A-Z_]\+: Record<" apps/api/src/modules/ --include="*.service.ts"` дає повний список drift. Той підхід для frontend `EMPTY_*` літералів.
**Причина:** розробники копіюють CRUD-модулі; sort-whitelist «в body бо тільки тут» переноситься. Perf-audit рухається fresh по recent changes — legacy не отримує аудиту.
**Фікс:** після «hoist alloc from body» — grep-signature на ВСІХ файлах directory; hits тепер vs до = має бути N-1; якщо >1 — усі fixed у той atomic commit. Prefix консистентний (`<MODULE>_SORT_FIELDS`, `<MODULE>_INCLUDE`). Commit body перераховує sibling. НЕ merge у shared const якщо семантика різна (invoices dueDate vs PO totalAmount) — merge тільки copy-paste identical.
**Impact:** цикл-3 фіксив 8 sibling-drifts за прохід. Без sibling-audit — O(N) circular repetition; atomic protocol = 1 pass, O(1) commits.
**Де шукати ще:** ЛЮБИЙ perf pattern — після fix у 1-му модулі extend grep на весь directory. Особливо: sort-whitelists (10+ CRUD), Prisma include/select shapes, EMPTY__/DEFAULT__ літерали, frontend regex constants, balance/status/discriminator maps.

### 2026-08-30 — Sort-field whitelist Record/tuple-array declared INSIDE service `findAll` body — re-allocated on every list request under polling

**Сигнал:** `findAll(sortBy?, sortDir?)` містить `const SORT_FIELDS: Record<string, string> = {...}` (або tuple/enum-labels) у тілі функції. Кожен list-запит (polling 30s + filter/pagination + tab switch) → alloc заново. Frontend-варіант: той Record у `visibleColumns.map(col => {...})` (N×render). Той підпис для tuple-arrays — static filter options `[['', 'Всі'], ...]` у body.
**Grep:** backend `grep -rn "^\s\+const [A-Z_]\{3,\}: Record<" apps/api/src/modules/ --include="*.service.ts"` (indent-guard забирає module-level). Frontend `grep -rn "^\s\+const [A-Z_]\{3,\}: (Record|Array|\{)" apps/web/src/app/ --include="*.tsx"` + `grep -rn "\.map(.*=> {[\s\S]{0,200}const [A-Z_]" apps/web/src/`. Regex-версія `grep -rn "^\s\+const [A-Z_]\+_RE = /" apps/web/src/`.
**Причина:** whitelist ставлять поруч зі споживачем. Не помічають: (a) backend service метод request-scoped; (b) React re-runs body top-to-bottom; (c) inside `.map()` — N× amplification. Compilation-time constants семантично identical до module-level.
**Фікс:** для public `findAll`/`findMany` — перші 20-30 рядків, `const [A-Z_]+: (Record|Array|readonly) = {...}` з literal values → hoist на module-level з owner-prefix (`SP_SORT_FIELDS`, `INV_SORT_FIELDS`; regex `PO_UUID_RE`). НЕ виносити коли: залежить від reactive prop / useMemo-subresult / містить closure-callbacks.
**Impact:** backend 1 hash+4 strings/call → 0. Frontend inside `.map()`: typing 20 chars @ 7 columns × 20 renders = 140 alloc → 0. Regex compile переноситься з render у module load.
**Де шукати ще:** `findAll`/`findMany`/`search`/`filter` — sort-whitelists, filter-key allowlists, field-alias maps. Frontend SORTABLE Records inside `.map()`; error-message Records у validate(); regex у effect body.

### 2026-08-30 — Multi-scan reduce accumulator у aggregation service — суперSet 2026-06-17 twin-scan для 3+ reduce з різними semantics

**Сигнал:** aggregation service (getSchedule/getSummary/getReport/getBalances) після compute-loop будує totals через 3+ `.reduce()` на тому масиві (`suppliers`/`entities`/`lines`) + loop-with-reduce на 2-му вимірі (`dates` × per-date reduce). Розширення «twin-scan reduce» (2026-06-17) на двовимірну aggregation.
**Grep:** `const \w+ = \{[\s\S]{0,300}\.reduce\([\s\S]{0,200}\.reduce\([\s\S]{0,200}\.reduce\(` (3+ reduce у object-літерал); або `for (const \w+ of \w+) {[\s\S]{0,100}reduce\(` (reduce у for-of). Підтверджуючий: `if (sum > 0) totals.byDate[d] = sum` після reduce.
**Причина:** кожна формула окремо (overdue-sum, planned-sum, per-date-sum). N-times passes; для report з 2+ вимірами.
**Фікс:** single-pass for-of з локальними `let`; для двовимірного — nested for-in по inner keys (plain object швидший для string keys); post-loop prune порожніх buckets; preserve `?? 0`.
**Impact:** getSchedule 50 suppliers × 20 dates: 1150 iter + 23 closures → ~500-800 ops + 0 closures.
**Де шукати ще:** `get{Schedule|Summary|Report|Balances|Statistics}` з двовимірним output (suppliers×dates, customers×months, branches×status). `{items, totals}` → totals кандидат.

### 2026-08-30 — Aggregation-endpoint фільтрує reference-таблицю за discriminator-ом що не є FK — базовий `(orgId, fkId, deletedAt)` не покриває, потрібен `(orgId, discriminator, deletedAt)`

**Сигнал:** aggregation-метод (`getSchedule`/`getSummary`/`getBalances`/`getReport`) читає reference-таблицю (contracts, price-lists, warranties, categories, rates) не через FK, а через SEMANTIC-discriminator: `where: {orgId, contractType: 'PURCHASE', creditLimit: {not: null}, deletedAt: null}`. Базовий `(orgId, fkId, deletedAt)` (CRUD-list) НЕ активується → звуження лише по orgId + heap re-filter. Fetched у Promise.all, час maskується, але polling staleTime=30s × N users. feat-commit додає endpoint БЕЗ супутньої migration.
**Grep:** для методу з `Promise.all([...])` з ≥2 findMany/groupBy — виписати WHERE-shape. Для reference (Contract, PriceList, Rate, Warranty, Category) чи є `(orgId, ...discriminators, deletedAt)` де discriminators = літерал-value fields, не FK. Якщо лише `(orgId, fkId, deletedAt)` + `(orgId, syncVersion)` → drift.
**Причина:** reference-index під «показати X-и цього Y-а» (CRUD). Нова feature читає cross-cutting («всі PURCHASE-контракти org-а»). EXPLAIN: `Bitmap Heap Scan` з `Filter:` по discriminator, або `Seq Scan`.
**Фікс:** `CREATE INDEX IF NOT EXISTS "<table>_orgId_<discriminator>_deletedAt_idx"` — discriminator leftmost після orgId (селективність спадно: contractType раніше ніж isPrimary), deletedAt останнім. НЕ включати `creditLimit: {not: null}` (heap re-filter швидший за partial). Дзеркалити у `@@index`. Одна migration для всіх reference-tables.
**Impact:** counterparty_contracts 1000/org, polling 30s: bitmap heap scan ≈5-15ms → index-narrow ≈0.5-2ms. Endpoint fetch-ає ~5-10 reference-tables → 20-100ms P50.
**Де шукати ще:** aggregation/report/schedule з Promise.all: SupplierPayment.getSchedule (contractType), Report.getPricing (isActive+scope), Report.getWarranties (status+expiring), Dashboard.getSummary (rates by currency), Inventory.getLowStock (category+isActive).

### 2026-08-30 — Reverse-FK axis miss на child-table що не має власного CRUD-endpoint — indexed тільки прямий FK, нема compound з orgId+reverse-fk+deletedAt

**Сигнал:** child-table «документ-attachment» (SupplierPayment, InvoiceLine, StockBatch, WorkOrderPart) до parent (PO, Invoice, SD, WO) читається 3 способами: (1) `findAll(parentId=?)`, (2) nested include `where: {<childFk>: {in: [...]}}`, (3) `groupBy` з `<childFk>: null`. Existing indexes покривають self-CRUD (`orgId,deletedAt`; `orgId,ownerFkId,createdAt`; `orgId,status,createdAt`) але НЕ `(orgId, <parentFkId>, deletedAt)`. Причина: parentFkId був nullable optional discriminator, не primary access path.
**Grep:** для child з nullable FK на parent (`purchaseOrderId String? @db.Uuid`) — чи є `@@index([orgId, <parentFkId>, deletedAt])`. Якщо нема — grep service за (a) `findAll(...parentId?)`, (b) `where: {<childFk>: null | {in:[...]}}`, (c) parent-service include `<childCollection>`. Хоча б один → drift.
**Причина:** child-generator створює index під self-CRUD. Parent detail-view + aggregation пізніше; Prisma nested include генерує `WHERE parentFkId IN (...)` — розробник не бачить query.
**Фікс:** `(orgId, <parentFkId>, deletedAt)` — orgId, parentFkId (equality-narrow), deletedAt (low-card). Не додавати createdAt (include без orderBy). Не partial index — nested include використовує `IN`, не `IS NOT NULL`.
**Impact:** supplier_payments 10k/org, PO деталь: seq-scan ≈15-30ms → index-narrow ≈1-3ms.
**Де шукати ще:** StockBatch.stockDocumentId, WarrantyClaim.workOrderId, Attachment.entityId (polymorphic). Bonus: `groupBy` з `<childFk>: null` майже завжди triggerить drift.
