# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-08-30
Фаза:       Активна розробка (CHANGELOG.md → docs/PHASES.md)
TypeScript: api ✅ 0 errors | web ✅ 0 errors | shared ✅ 0 errors
Тести:      API ✅ 992/992 | Web ✅ 488/488 | E2E 305/307 (2 flaky, попереднє)
Latest optimize: 2026-08-30 (FULL /sto-optimize, HEAD 5858213e, feat/supplier-payments, цикл 2/3) — 4 знайдено, 4 виправлено (усі гарячі alloc-и, без DB). (1) supplier-payments.service.findAll: `SORT_FIELDS: Record<string,string>` декларувався у тілі → module-level `SP_SORT_FIELDS`. Викликається під polling 30s + filter/pagination. (2) getSchedule.totals: 3 послідовні `suppliers.reduce()` + `for (dates) { suppliers.reduce() }` → single-pass for-of з локальними акумуляторами (overdue/planned/total + inner for-in по byDate). 50 suppliers × 20 dates: 1150 iter → ~500 iter, 23 reduce-closure → 0. (3) purchase-orders/page.tsx: UUID_RE regex + `statuses` tuple-array з тіла компонента → module-level `PO_UUID_RE` + `PO_STATUS_FILTER_OPTIONS`. Alloc на кожен render, використовуються один раз (effect on mount) або статично (Filter chips). (4) supplier-payments/page.tsx: `const SORTABLE: Record` декларувався INSIDE `visibleColumns.map()` callback → module-level `SP_SORTABLE_BY_COL`. N-кратна амплітуда (alloc для КОЖНОЇ visible column на КОЖНИЙ render). SKILL.md +2 patterns («sort-field whitelist inside body / inside .map», «multi-scan reduce aggregation extend of twin-scan»). TS: api ✅ 0 | web ✅ 0. Vitest: 992/992 + 488/488. Cycle 1 попереднє: 2026-08-30 (HEAD a5fc685e) — 3 знайдено, 3 виправлено: (1) DB index counterparty_contracts(orgId, contractType, deletedAt); (2) DB index supplier_payments(orgId, purchaseOrderId, deletedAt); (3) purchase-orders.receive Array.find→Map bucket. Migration 20260830120000.
Latest feature: 2026-08-29 (feat/supplier-payments) — «Графік оплат постачальникам». PurchaseOrder.paymentDate (нова колонка, авто-fill у receive() = сьогодні+paymentDeferDays договору; редаговане поле в PO-модалці). GET /supplier-payments/schedule — шахматка боргів по датах (RECEIVED/PARTIAL PO, outstanding=totalAmount−ΣCONFIRMED payments, bucket overdue/дата/planned, кредит-ліміт з найпізніших). Вкладка «Список/Графік оплат» на /supplier-payments (SupplierPaymentScheduleTab). Tests: +5 getSchedule spec, +2 PO receive auto-fill, +1 E2E schedule tab. Live: today+10 auto-fill ✓, 5000−2000ліміт=3000 ✓.
Sync:       2026-07-03 ✅ Dir1 0 missing | Dir2 2 fixed (bank-accounts/cash-registers paginated) | Dir3 2 fixed (deletedAt removed)
Latest review: 2026-08-29 (auto, HEAD ad65c36f, feat/supplier-payments, цикл 1/3) — schedule + PO paymentDate: 5 issues (0 Critical / 3 Important / 2 Suggestion), fixed 5/5. (1) counterpartyContract.findMany без take → OOM guard 5000. (2) getSchedule без from<=to валідації → 400 з cap 100 днів. (3) receive() використовував paymentDeferDays з soft-deleted договору → deletedAt guard. (4) PO Modal «Дата оплати» без disabled={!canEdit} → 400 при PATCH non-DRAFT. (5) purchase-orders/page.tsx receive не інвалідував supplier-payments/counterparties → шахматка/баланси stale 30s. (0) React.ReactNode → import type. TS 0 errors, 992/992 vitest ✓.
Latest tester: 2026-08-30 (FULL /sto-tester, HEAD d5d58af7, feat/supplier-payments, цикл 1/3) — 4 багів (HIGH: 3, MEDIUM: 1), fixed 4/4. Bug #592 HIGH: spec purchase-orders.service.spec.ts:834 порівнював impl-Kyiv-дату з test-UTC-дату → flaky 3h/day (assertion 2026-09-09 vs 2026-09-08 на кордоні Kyiv-північ). Fix: use kyivToday/addDaysKyiv у spec. Bug #593 HIGH: 4 web тести падали "No QueryClient set" після SP modal RQ migration (commit 7e6bfab9); PurchaseOrderCreateModal транзитивно рендерить SP → тест PO теж вражений. Fix: renderWithQueryClient helper у 2 test-файлах. Bug #594 HIGH: SP modal create-branch bypassed useCreateSupplierPayment hook → cache staleness 30s. Fix: import hook, replace raw apiFetch на createMut.mutateAsync. Bug #595 MEDIUM: SupplierPaymentScheduleQueryDto @Matches(YMD_RE) прийнвував invalid "2026-99-99" → NaN → silent empty. Fix: додано @IsDateString({strict:true}). SKILL.md +4 patterns (spec-vs-impl DST parity, QCProvider post-RQ-migration, partial-hook-migration, regex-vs-semantic date). Попереднє: Bug #590 HIGH useConfirmSupplierPayment invalidate counterparties; Bug #591 useSupplierPayments.test.tsx.
Latest E2E: 2026-07-03 (SupplierPayment) — новий `apps/web/e2e/supplier-payments.spec.ts` 7/7 passed. Покриває: рендер сторінки/фільтрів/модалки, create→таблиця→cleanup, FSM DRAFT→CONFIRMED пише settlement PAYMENT + баланс постачальника −amount + documentType=SupplierPayment у transactions + CONFIRMED не видаляється, guard BANK_ACCOUNT без bankAccountId→400, DRAFT→CANCELLED не пише settlement. Тест сам сідить cash register (currency+branch — seed не містить). Related specs (supplier-returns, crud-purchase-order) без регресій.
Dev-сервери: API ✅ :3000 | Web ✅ :3001 | Docker: запускати вручну
Останній commit: 2026-08-30 — e7c18561 docs(skills): +2 patterns у sto-optimize (sort-whitelist inside body / multi-scan reduce). Попередній: 5858213e perf(optimize): hoist hot-path allocations + single-pass schedule totals (cycle 2/3). Попередній: a5fc685e perf(optimize): schedule hot-path indexes + bucket-by-id line lookup у PO.receive (migration 20260830120000 + purchase-orders.service). Попередній: d5d58af7 fix(tester): Bugs #592-#595 (DST-aware spec + QCProvider wrap + SP create hook migration + strict date DTO). Baseline було червоне (API 991/992 + Web 484/488), після коміту зелене (992/992 + 488/488). Попередній: 2026-06-20 — fix(tester): фінальна верифікація 300 E2E тестів. Виправлено 4 failed:
 (1) work-orders.spec.ts:114 + crud-work-order.spec.ts:147/169 — список нарядів не навігує (row click → side-panel, "Відкрити наряд" → edit-modal). Тести очікували URL change. Fix: ID наряду через API + page.goto('/work-orders/<id>').
 (2) vehicles.spec.ts:83 — hardcoded "AA1234BB|2020|Toyota" крихко при E2E-fixture (model "E2E-Model-560110"). Fix: дізнатись make/year/licensePlate авто через API, регенерувати regex.
 (3) invoices.spec.ts:845 — `table tbody tr` матчив skeleton row "Завантаження" → 0 checkbox. Fix: expect.poll на кількість checkbox-ів замість tr.

Bug #572 (HIGH) FIXED: search 500 на pg_trgm `%` оператор — Postgres 42804 "argument of OR must be type boolean, not type text". Prisma надсилав ${q} без типу, planner не міг вирішити operator. Fix: ${qText}::text cast у 3 SQL запитах (counterparties, work-orders, goods).

Bug #573 (CRITICAL) FIXED: API не стартував — @fastify/middie 9.x вимагає fastify 5.x, ми на 4.28. Pin override у pnpm-workspace.yaml до ^8.0.0 (остання fastify-4-сумісна лінія).
```

### Security audit (2026-06-20)

- **CRITICAL fix:** jwt.strategy.ts тепер вимагає JWT_ACCESS_SECRET через `getOrThrow`; fail-fast на старті, fallback на публічно відомий 'dev_access_secret' видалено
- **Перевірено OK:** SQL injection (всі $queryRaw — tagged template Prisma.sql), Auth (bcrypt 12 + refresh httpOnly+sameSite:strict+path:/api/auth), Sensitive data (purchasePrice масковано MECHANIC/RECEPTIONIST у goods.service.ts, SMS phone — `maskPhone()` у sms.processor.ts, EstimatePublicDto guard у work-orders.share-public.spec.ts), Access Control (RolesGuard+JwtAuthGuard глобально, public endpoints тільки booking/setup/work-orders-public), Misconfig (helmet first plugin, ValidationPipe whitelist+forbidNonWhitelisted глобально, CORS WEB_ORIGIN fail-closed, Swagger тільки у dev), XSS (єдиний dangerouslySetInnerHTML у layout.tsx — static literal color-mode boot), CSRF (sameSite:strict на refresh cookie, Bearer-only для mutations), Mass Assignment (whitelist:true strip-ає orgId/role з input), Multi-tenant (orgId з JWT через @OrgContext всюди, ніде з body)
- **Trade-off:** SSE `/dashboard/stream?token=…` — EventSource без custom header API; mitigated throttle 5/min + getOrThrow secret + claims verify
- **HIGH deps:** 28 у залежностях — vitest <3.2.6 (DEV-only RCE), @fastify/middie <=9.3.1 (middleware bypass, у NestJS guards не використовується), undici (jsdom test + Expo mobile), glob (@nestjs/cli dev tool), shell-quote (Expo mobile). Жодна не у production runtime критичного шляху. Окрема ітерація `pnpm update` після sprint.

### Аудит-висновки (2026-06-17 simplify session)

- `COST_PRICE_VISIBLE_ROLES` Set + `canSeeCostPrice()` — дублювання НЕМАЄ. `GOODS_PRICE_VISIBLE_ROLES` не існує; список ролей повторюється у `@Roles('OWNER','ADMIN','STOREKEEPER','ACCOUNTANT')` на `getPriceHistory` (endpoint-level RBAC), але це різні рівні (endpoint vs DTO field mask) — extraction коштує більше ніж економить
- `toPartDto(part, userRole?)` — параметр threaded в усі 3 callsites: `findOne` (line 243), `addPart` (1180), `updatePart` (1263). `duplicate` не повертає parts DTO; `generatePdf` + `findByShareToken` (public share) — навмисно без costPrice
- `recalcTotals()` — спрощено: `Number(actualHours ?? normoHours ?? 0)` замість `actualHours != null ? Number(...) : Number(... ?? 0)`. Semantically identical (Float vs Decimal — для null/0 result same)
- `hasActual` у `work-orders/page.tsx:917` — `Math.abs(totalActualLabor - totalLabor) >= 0.01` мінімально, без зайвих обчислень. Не чіпати
- `CreateWorkOrderModal` colSpans — узгоджені: parts table 9/10 (NONE/VAT), lines table 8/9, tfoot "Разом товарів" 7/6, "Разом робіт" 5, "Факт. роботи" 6/7 — всі парні з колонками colgroup ✓

---

## Останній commit

```
ad65c36f  fix(review): 5 findings on supplier-payments schedule + PO paymentDate (feat/supplier-payments)
          — getSchedule: counterpartyContract.findMany take=5000, from<=to валідація + cap 100 днів
          — receive: перевірка po.contract.deletedAt перед застосуванням paymentDeferDays
          — PO Modal: disabled={!canEdit} на «Дата оплати» (backend PATCH блокує non-DRAFT)
          — purchase-orders page: invalidate supplierPaymentsKeys/counterpartiesKeys після receive
          — PageClient supplier-payments: React.ReactNode → import type { ReactNode }

65064c6a  docs(skills): SupplierPayment Bug #588 → sto-tester paired-FK approach (feat/supplier-payments)
92390dbc  fix(tester): Bug #588 — supplier-payments update() auto-clears orphan PO on supplier change (feat/supplier-payments)
          — API-only clients могли лишити purchaseOrderId від старого постачальника → cross-supplier linkage
          — Fix: shouldClearOrphanPO = supplierChanged && dto.purchaseOrderId===undefined && sp.purchaseOrderId!==null
48ad57a6  feat(supplier-payments): document + endpoint for paying suppliers (feat/supplier-payments)
          — Нова модель SupplierPayment: оплата постачальнику, FSM DRAFT→CONFIRMED пише SettlementTransaction(PAYMENT)
          — Джерело коштів обов'язкове (bank/cash), опц. прив'язка до PurchaseOrder. БЕЗ Checkbox/loyalty (supplier-side)
          — API /supplier-payments (OWNER/ADMIN/ACCOUNTANT) + web список/модалка/nav. Дос'є: docs/objects/supplier-payment.md
          — Міграції 20260703100000 (модель+enums+DocumentType) + 20260703100001 (backfill DocumentNumberConfig ОПП)
951506b7  fix(review): clear paired purchase-order ref when supplier cleared in SupplierPaymentCreateModal (feat/supplier-payments)
          — §8.2 paired FK state: EntityPickerField.onClear supplier тепер скидає обидві пари (supplierId+supplierName, purchaseOrderId+purchaseOrderNumber)
          — Без фіксу залишався orphan PO → backend 400 без пояснення у UI
d699d0ae  fix(sync): align SupplierPaymentCreateModal with bank-accounts/cash-registers API contracts (feat/supplier-payments)
          — /bank-accounts + /cash-registers return { items, total } not bare array; fix apiFetch typing + destructuring
          — Remove client-side deletedAt filter (server returns only active); remove deletedAt from local interfaces
a59a023f  fix(review): strip BOM from 7 inventory/goods files + $transaction timeouts + React namespace types
          — BOM (§1): 7 files after comment-cleanup Windows/PowerShell edit
          — $transaction timeout (§5): 4 blocks — goods.service (barcode primary swap/delete), settings.service (taxRate default create/update) → { timeout: 10_000 }
          — React.X namespace (§1): CalendarSlotModal.tsx → named type imports (Dispatch/SetStateAction/RefObject)
b28f3411  refactor(comments): remove Bug# references and noise comments; document comment policy in sto-dev
          — Strip `// Bug #NNN:` prefixes from ~180 comments across 130+ production files
          — Preserve WHY text (constraints, workarounds, timeouts, race-guards)
          — sto-dev SKILL.md: add ЗАБОРОНЕНО/ДОЗВОЛЕНО examples
6336f201  test(e2e): hard expects замість silent skip + 2 нових spec (bookings, counterparty-detail)
9b9e2ce0  fix(tester): Bug #572 search 500 + Bug #573 fastify/middie API startup crash
26f3895d  docs(memory): update after E2E expansion — 277/284 pass (+39 tests)
c8ccfdad  test(e2e): Add command-palette + supplier-returns coverage, surface Bug #572 (search 500)
bf2f78a6  test(e2e): Add 30 tests across 5 new specs — profile, ndi, sync, vehicles, calendar-views
7575081d  fix(e2e): Eliminate test.skip(true) fake-green in 5 crud specs — Bug #571 follow-up
4c883670  simplify(review): role-gate spec merge + pnpm-workspace placeholder fix
4c62d12d  fix(review): фінальний огляд 3/3 — pnpm overrides + AuthenticatedUser типізація + regression specs
27210eb2  simplify(e2e): Цикл 3/3 step 6 — extract nextWorkingDayIso + openPoEditModal helpers, drop dead enableDetailPanel
3083ae58  fix(tester): Цикл 3/3 step 5 — Bug #571 (e2e fake-green silent skips)
a0149911  docs(skills): add public hot-path multi-field WHERE compound B-tree drift to sto-optimize
bb48063d  perf(optimize): Цикл 3/3 step 4 — covering index booking_requests(orgId,branchId,status,requestedDate)
667f8798  fix(tester): Цикл 3/3 step 3 — Bug #568-#570 (E2E search fill, Throttle contract, WO labels contract)
2d77c7eb  docs(memory): update MemoryManual after review Цикл 3/3 step 2
3f1527f0  fix(review): Цикл 3/3 step 2 — public booking @Throttle + strip BOM from 10 files
4f1f345d  fix(sync): align WO status labels and StockTotal interface with API contracts (Цикл 3/3 step 1)
487fb807  perf(optimize): parallelize pricing-rules tier+main update; memoize PricingRules filter; dynamic-load SupplierReturnCreateModal (Cycle 2/3 step 4)
e4c72a49  fix(tester): bugs #565/#566/#567 — supplierId contract tests, IPv4 E2E, auth escape-hatch (Cycle 2/3 step 3)
488704b2  fix(review): pricing-rules supplierId UUID guard + strip stray BOM (Cycle 2/3 step 2)
4fe1a559  fix(sync): align frontend hook interfaces with backend response DTOs (Cycle 2/3 step 1)
cce4130a  perf(optimize): parallelize supplier + warehouse validation in SupplierReturn.update()
cba69150  fix(tester): Bug #537 validation message Cyrillic + #538 E2E flaky (Цикл 1/3 step 3)
00f6c657  fix(review): remove UTF-8 BOM from 19 DTO files
968e49b0  fix(api): resolve 37 TypeScript errors — Date→string conversions + undefined variable refs
```

Повна історія → [CHANGELOG.md](CHANGELOG.md)

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                                                  | Що                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/api/src/common/utils/array.ts`                                  | `deduplicateBy<T>(arr, key)` — Map last-wins dedup    |
| `apps/web/src/lib/utils.ts`                                           | `toIdMap<T extends {id}>`, `calcVatTotals`            |
| `packages/shared/src/constants/statuses.ts`                           | RECEIPT у STOCK_DOC_TYPE_LABELS/BADGE                 |
| `apps/web/src/app/(app)/work-orders/[id]/InvoiceSection.tsx`          | Extracted invoice block компонент з PageClient.tsx    |
| `packages/shared/tsconfig.cjs.json`                                   | CJS build config (module: commonjs → dist/cjs/)       |
| `apps/api/src/modules/work-orders/work-orders.role-gate.spec.ts`      | 22 регресія-guard тестів матриці userRole × costPrice |
| `apps/api/src/modules/work-orders/work-orders-export.service.spec.ts` | 4 регресія-guard тести Bug #508/#528 (planned amount) |

---

## Активні особливості поточного коду

- `StockDocumentType.RECEIPT` — повністю додано: Prisma enum + DTO + service + frontend tabs
- `deduplicateBy(plan, u => u.goodId)` — у PO/xlsx applyPricing ПЕРЕД `Promise.all`
- `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` — exhaustive (без Partial<>)
- `Promise.all` для per-line writes у SD transition/PO receive (disjoint rows — safe)
- work-orders.service.ts parts loops — **sequential** (shared StockItem composite key — unsafe to parallelize)
- CalendarSlot.parentSlotId — split-day continuation invariant (не колапсувати через updateMany)
- BullMQ API: `@Processor('queue', { concurrency: N })` + `extends WorkerHost` + `async process(job: Job<T>)` (НЕ legacy `@Process({ name, concurrency })`)
- `BullModule.forRootAsync` — `connection: { host, port, password, db }` (НЕ `redis:`)
- `RepeatOptions` — `pattern: '0 9 * * *', tz: 'Europe/Kyiv'` (НЕ `cron:`)
- SMS-канал через `NotificationsService.send(orgId, eventType, payload)` — НЕ прямий `smsQueue.add()`. payload має `branchId` + `phone` + template placeholders. service резолвить branchSettings provider/apiKey + NotificationTemplate.body.
- `NotificationEventType` enum: WO_CREATED/WO_ESTIMATE_READY/WO_APPROVED/WO_IN_PROGRESS/WO_COMPLETED/WO_READY_FOR_PICKUP/PAYMENT_RECEIVED/INVOICE_SENT/LOW_STOCK_ALERT/FOLLOWUP_REMINDER/**BOOKING_CONFIRMATION** (новий)
- **BookingRequest**: публічна сторінка `/booking` (publicFetch, без auth) + адмін `/bookings` (apiFetch + useBookingRequests). Контролер `@Controller('booking')` — GET/PATCH/DELETE захищені JWT, GET branches/availability/request — публічні
- **CalendarSlot.workOrderStatus**: backend DTO + frontend CalendarSlot type + CalendarDayGrid рендер через WO_STATUS_LABELS (@sto/shared)
- **BookingSlot на календарі**: PENDING booking requests відображаються на CalendarDayGrid, assign до першого вільного lift client-side. Тип BookingSlot — client-only
- **GET /goods/stock-totals**: повертає `{ goodId, totalQuantity, byWarehouse[] }[]`, frontend StockTotal читає тільки `{ goodId, totalQuantity }` — byWarehouse ігнорується (валідно)
- **StatusPill компонент**: `apps/web/src/components/ui/status-pill.tsx` — використовується у work-orders, invoices, stock-documents, purchase-orders filter bars
- **`@sto/shared` CJS build**: `packages/shared/package.json` main=`./dist/cjs/index.js`. Запускати `pnpm --filter @sto/shared build:cjs` якщо shared змінювався і API не стартує
- **NestJS SWC на Windows**: SWC не резолвить `tsconfig paths` — вставляє alias як literal string у dist JS. **Рішення: залишити tsc builder** (`nest start --watch` без `--builder swc`). `baseUrl: "."` залишити для SWC compatibility але builder = tsc
- **`rootDir: "src"` у api tsconfig** — обов'язково! Без нього tsc дзеркалить monorepo дерево → `dist/apps/api/src/main.js` замість `dist/main.js` і `node dist/main` падає з MODULE_NOT_FOUND

---

## Довідники (читати за потреби)

| Файл                                                 | Коли читати                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | API модулі (28), Prisma моделі (41), утиліти, sync                             |
| [docs/PATTERNS.md](docs/PATTERNS.md)                 | UI компоненти, hooks, B1-B7, EntityPickerField                                 |
| [docs/BUSINESS-RULES.md](docs/BUSINESS-RULES.md)     | FSM, інвентар, розрахунки, тенант-ізоляція                                     |
| [docs/GOTCHAS.md](docs/GOTCHAS.md)                   | Відомі пастки — читати перед новою фічею                                       |
| [CHANGELOG.md](CHANGELOG.md)                         | Журнал комітів по фічах                                                        |
| [docs/PHASES.md](docs/PHASES.md)                     | Поточна фаза і задачі                                                          |
| [docs/objects/](docs/objects/)                       | Дос'є агрегатів: WO, Invoice, PO, StockDoc, Counterparty, Good, Work, Calendar |
| [docs/specs/\_TEMPLATE.md](docs/specs/_TEMPLATE.md)  | Шаблон специфікації нової фічі                                                 |
| [.claude/memory/MEMORY.md](.claude/memory/MEMORY.md) | User preferences                                                               |

---

## Правило оновлення (для агентів)

Після кожного коміту — оновити **тільки** цей файл:

1. `Останній commit` → нові хеші (5–6 рядків)
2. `Поточний стан` → TypeScript статус, дата, тести
3. `Нові файли/утиліти` → якщо з'явились нові
4. `Активні особливості` → якщо щось змінилось у логіці

**НЕ** додавати сюди деталі рішень, full bug descriptions, список виправлень.  
Деталі → `CHANGELOG.md` (append, 3–5 рядків max per commit).  
Патерн/правило → відповідний довідник (одне місце правди).
