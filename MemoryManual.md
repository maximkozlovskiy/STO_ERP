# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-06-20
Фаза:       Активна розробка (CHANGELOG.md → docs/PHASES.md)
TypeScript: api ✅ 0 errors | web ✅ 0 errors | shared ✅ 0 errors
Тести:      API 960/960 | Web 471/471 | E2E ~300+ (target 0-2 skipped) ✅ 0 failed
Dev-сервери: API ✅ :3000 | Web ✅ :3001 | Docker: запускати вручну
Останній commit: 2026-06-20 — test(e2e): 6336f201 — hard expects замість silent test.skip(true) у 8 spec-ах + 2 нових spec (bookings 6, counterparty-detail 10). Прибрано ~50 dead-code skip патернів — seed містить усі необхідні entities, тому if(!data)→skip було fake-green. Тепер регресії seed або UI логіки призводять до FAIL.

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
