# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-06-17
Фаза:       Активна розробка (CHANGELOG.md → docs/PHASES.md)
TypeScript: api ✅ 0 errors | web ✅ 0 errors | shared ✅ 0 errors
Тести:      API 908/908 (+26: 22 role-gate + 4 estimate-export) | Web 434/434
Dev-сервери: API ✅ :3000 | Web ✅ :3001 | Docker: запускати вручну
E2E smoke (2026-06-17): WO list "Сума, ₴" → 1 230,00 (NBSP) ✅; OWNER /api/work-orders/:id → costPrice key present ✅; CreateWorkOrderModal "Собів., ₴" + colSpans 9/10 (vatMode) consistent ✅
Останній review: 2026-06-17 (POST-VAT, HEAD fe9c741c) — CRITICAL: PurchaseOrderCreateModal викликав неіснуючий /organisations/my → VAT-рядок ніколи не рендерився; замінено на /settings/organisation + /settings/tax-rates. CRITICAL: reports.vatReport() агрегував ВСІ invoices/POs включаючи DRAFT/CANCELLED → невірний звіт ПДВ; додано status-фільтри (SENT/PAID/OVERDUE для sales, PARTIAL/RECEIVED для purchases). IMPORTANT: SettingsService.getDefaultVatRate() return VatMode enum (не bare string) → drops 2 casts; vat.ts imports VatMode з @prisma/client; reports.service прибрав ugly `(_sum as { totalVat?: unknown })` cast
Останній simplify: 2026-06-17 — recalcTotals: nullish-chain `Number(actualHours ?? normoHours ?? 0)` замість тернарки (semantically identical, 78/78 WO тестів green)
Останній optimize: 2026-06-17 (HEAD 80f02888) — recalcTotals twin-scan→single-pass + tier merger org+uoms у findByShareToken / EstimateExportService.getEstimateData
Останній tester: 2026-06-17 (FULL, HEAD 538ca6e4) — Bug #527-#529 (role-gate regression-guard + estimate-export Bug #508 leak + addPart/updatePart symmetry)
Перший review (today): 2026-06-17 (AUTO, HEAD 6d35157a) — §2.1 CRITICAL: role-gate part.costPrice (MECHANIC/RECEPTIONIST exposure) + UI mode alignment
Останній sync:   2026-06-17 (Cycle 2, HEAD 31ec6313) — WorkOrderPartResponseDto.costPrice optional ✅ | WorkOrder.contractId/contractNumber ✅ | EstimatePublicDto fields ✅ | apiFetch URLs ✅ | tsc 0 errors — 0 розбіжностей
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
fe9c741c  fix(review): VAT report filters + broken endpoint + VatMode typing
60b25347  feat(vat): add VAT accounting to PO, WO, Invoice + VAT report
1e03b509  docs(skills): add twin-scan reduce + post-token sequential lookups to sto-optimize
80f02888  perf(optimize): twin-scan reduce + sequential org/uoms in WO recalc & export
0325a37c  docs(skills): add role-gated DTO field regression-guard pattern to sto-tester
538ca6e4  fix(tester): Bugs #527-#529 — regression-guards for costPrice role-gating + Bug #508 export leak
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
