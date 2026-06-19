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
Тести:      API 931/931 | Web 438/438 | E2E 232/232 (13 data-skip)
Dev-сервери: API ✅ :3000 | Web ✅ :3001 | Docker: запускати вручну
Останній sync:   2026-06-19 (HEAD 669a328e) — WorkOrderPart: +goodInternalCode/goodSku/goodBrandName у PageClient + WorkOrderPartsSection (type drift vs toPartDto після internalCode feature) — 6 полів додано | tsc 0 errors
Останній review: 2026-06-20 (focused post-redesign, HEAD 0b60970c) — SupplierReturnCreateModal після PO-style редизайну (0bcc7365): frontend STATUS_TRANSITIONS розходився з backend SR_TRANSITIONS — `DRAFT:[CONFIRMED]` (втрачено CANCELLED) + `CONFIRMED:[CANCELLED]` (CONFIRMED — terminal у бекенді) + хардкод `statusPrevStep = status==='CONFIRMED' ? 'DRAFT' : null` (back-transition не існує). UI пропонувала недопустимі переходи, бекенд відкидав 400. Фікс: вирівняно з SR_TRANSITIONS (DRAFT→[CONFIRMED,CANCELLED]; обидва terminal), prev-step завжди null, next-step prefer не-CANCELLED forward. TS/no-React.X/no-any/no-console/no-BOM ✓.
Останній tester: 2026-06-19 (sweep post-review a50e1484) — 3 баги: #541 LOW backend regression-coverage gap — `PO_LINE_GOOD_INCLUDE`/`PART_GOOD_INCLUDE` drift не ловиться тестами; додано guards у `work-orders.role-gate.spec.ts` (findOne + addPart) і `purchase-orders.service.spec.ts` (transition → findOne) що асертять goodInternalCode/goodSku/goodBrandName потрапляють у DTO. #542 LOW frontend regression-coverage — sub-line рендер у `WorkOrderPartsSection.tsx:121-125` не покритий; новий `WorkOrderPartsSection.test.tsx` (4 кейси: all 3, lone brand, all null no-render, empty parts). #543 MEDIUM frontend dead-code — `onShowBatches` prop у WorkOrderPartsSection ніколи не передавався з PageClient (silent UX click no-op since extraction 2026-06-05); додано: API 928/928 → 931/931 (+3); Web: 434/434 → 438/438 (+4).
Останній optimize: 2026-06-19 (post-internalCode sweep, HEAD 1f60d1b0) — 1 фікс: GIN trgm index `idx_goods_barcode_trgm` для покриття третьої OR-гілки у GoodsService.findAll() search (`name`/`sku` мали trgm з 20260526060945, `barcode` — ні). Verified non-issues: (a) `goods.findAll().include.brand` — Prisma робить batched `IN(brandIds)` по brands.id (PK), не N+1; (b) `PO_LINE_GOOD_INCLUDE`/`PART_GOOD_INCLUDE` `brand: { select: { name } }` — той самий PK-keyed join, безпечно у PO 1000 lines / WO 500 parts; (c) `goods(orgId, internalCode)` `@@unique` створює B-tree, окремий `@@index` зайвий; (d) `goods.brandId` без індексу — використовується лише у `pricing.service.applyPricingRule` (rare admin op, take:5000), додавання індексу не виправдане write-amp tradeoff-ом.
Останній E2E: 2026-06-19 (sto-e2e sonnet auto) — 4 баги: #544 invoices.spec.ts edit-modal title locator stale (Modal title тепер "Рахунок-фактура" замість invNumber після редизайну a14931b0; номер у headerContent); #545 purchase-orders-receive.spec.ts три тести з застарілими селекторами — `button[title="Відкрити деталі"]` → `Редагувати`, `Позначити отриманим`/`Часткове отримання` → `Оприбуткувати` (PO receive тепер inline `receiveMode` у PO-модалці, без окремого `Прийом по замовленню` dialog); #546 status-tooltip.spec.ts дефолтний date-фільтр /work-orders = today → empty state у дні без свіжих WO; тест очищає "З" датою до 01.01.2020; #547 LOW `WorkOrderPartsSection.orgId` dead prop — видалено з інтерфейсу та з PageClient. E2E: 232 passed / 13 skipped / 0 failed (3.4 хв).
```

### Аудит-висновки (2026-06-17 simplify session)

- `COST_PRICE_VISIBLE_ROLES` Set + `canSeeCostPrice()` — дублювання НЕМАЄ. `GOODS_PRICE_VISIBLE_ROLES` не існує; список ролей повторюється у `@Roles('OWNER','ADMIN','STOREKEEPER','ACCOUNTANT')` на `getPriceHistory` (endpoint-level RBAC), але це різні рівні (endpoint vs DTO field mask) — extraction коштує більше ніж економить
- `toPartDto(part, userRole?)` — параметр threaded в усі 3 callsites: `findOne` (line 243), `addPart` (1180), `updatePart` (1263). `duplicate` не повертає parts DTO; `generatePdf` + `findByShareToken` (public share) — навмисно без costPrice
- `recalcTotals()` — спрощено: `Number(actualHours ?? normoHours ?? 0)` замість `actualHours != null ? Number(...) : Number(... ?? 0)`. Semantically identical (Float vs Decimal — для null/0 result same)
- `hasActual` у `work-orders/page.tsx:917` — `Math.abs(totalActualLabor - totalLabor) >= 0.01` мінімально, без зайвих обчислень. Не чіпати
- `CreateWorkOrderModal` colSpans — узгоджені: parts table 9/10 (NONE/VAT), lines table 8/9, tfoot "Разом товарів" 7/6, "Разом робіт" 5, "Факт. роботи" 6/7 — всі парні з колонками colgroup ✓

---

## Останній commit

```
0b60970c  fix(review): align SupplierReturn modal FSM with backend SR_TRANSITIONS
1f60d1b0  perf(optimize): add GIN trgm index for goods.barcode search
a50e1484  fix(review): extract PO/WO `good` include + render goodInternalCode/sku/brand in WO parts list
669a328e  fix(sync): add goodInternalCode/goodSku/goodBrandName to WorkOrderPart interfaces
d1a12539  fix(review): include good.internalCode + brand in PO/WO part create/update + fix brandName drop in picker
9ea58b9e  feat(goods): add internalCode (sequential internal good code)
270de6ab  fix(sync): align WorkOrderPart frontend interfaces with backend DTO
90101494  feat(po): add pricedAt field and Розцінено column in PO list
49f8cd75  feat(goods): add price history tab to GoodEditModal
c4149f4c  feat(ui): apply inline label layout to all document forms
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
