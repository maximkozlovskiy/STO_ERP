# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-06-16
Фаза:       Активна розробка (CHANGELOG.md → docs/PHASES.md)
TypeScript: api ✅ 0 errors | web ✅ 0 errors | shared ✅ 0 errors
Тести:      API 860/860 | Web 434/434 | E2E пропущено (Docker DOWN у цій сесії)
Dev-сервери: API ✅ :3000 | Web ✅ :3001 | Docker: запускати вручну
Останній optimize: 2026-06-16 — bucket busy slots by liftId у getAvailability + load()
Останній tester: 2026-06-16 — Bug #511-#514 — booking DST + race + clamp + workhours guard
Останній review: 2026-06-16 (AUTO, HEAD a0301b36) — calendar split + pxToHours + parseHour(00:00)
Останній sync:   2026-06-16 — BranchSettings/WorkHours+CalendarSlot+BookingRequest+Warehouse/Branch/Zone+GoodPickerModal — 0 розбіжностей
```

---

## Останній commit

```
a0301b36  fix(review): align calendar split with backend + fix pxToHours static TOTAL_HOURS
          SPLIT_DAY_START_H/END_H constants у CalendarSlotModal для overflow detection
          (matches backend calendar.service.ts WORK_DAY_START_H=8/END_H=20); resize
          deltaH тепер dynTotalHoursRef замість pxToHours(static 12); parseHour 00:00 fix.
46b64596  feat(calendar): dynamic work hours from BranchSettings
          GET /settings/work-hours endpoint; useCalendarState reads workStartHour/workEndHour;
          CalendarDayGrid/Modal/StatsTab receive windows as props.
831c7d36  fix(infra): Cache-Control no-cache on branches/zones/warehouses GET
50cd6434  perf(optimize): bucket busy slots by liftId in availability + booking assign
f337e4e9  revert(api): use nest tsc builder instead of swc for dev
```

Latest tester: 2026-06-16 (AUTO) — Bug #508-510 — invoice section test coverage

Повна історія → [CHANGELOG.md](CHANGELOG.md)

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                                         | Що                                                 |
| ------------------------------------------------------------ | -------------------------------------------------- |
| `apps/api/src/common/utils/array.ts`                         | `deduplicateBy<T>(arr, key)` — Map last-wins dedup |
| `apps/web/src/lib/utils.ts`                                  | `toIdMap<T extends {id}>`, `calcVatTotals`         |
| `packages/shared/src/constants/statuses.ts`                  | RECEIPT у STOCK_DOC_TYPE_LABELS/BADGE              |
| `apps/web/src/app/(app)/work-orders/[id]/InvoiceSection.tsx` | Extracted invoice block компонент з PageClient.tsx |
| `packages/shared/tsconfig.cjs.json`                          | CJS build config (module: commonjs → dist/cjs/)    |

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
