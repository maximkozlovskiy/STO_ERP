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
Тести:      API 850/850 | Web 423/423 | E2E пропущено (Docker DOWN у цій сесії)
Останній tester: 2026-06-15 — Bug #506-#507 — booking SMS shape mismatch після bull→bullmq audit
Останній review: 2026-06-16 (AUTO, HEAD aa3b03c5) — invoice section на WO card: deferred revokeObjectURL + shared INVOICE_STATUS_LABELS + InvoiceRef + InvoiceStatus literal union (4 findings, 0 critical)
```

---

## Останній commit

```
aa3b03c5  fix(review): invoice section — deferred revokeObjectURL + shared
          INVOICE_STATUS_LABELS + InvoiceRef interface + InvoiceStatus literal
          union у findByWorkOrder (WO card invoice block)
523190f2  feat(work-orders): add invoice section to work order card
4ed163b5  fix(review): @Injectable для 4 BullMQ processors (loyalty/sms/checkbox/
          webhooks) — SWC builder consistency; React.ChangeEvent → named import
<pending>  fix(tester): Bug #506-#507 — booking SMS через NotificationsService.send()
          + BOOKING_CONFIRMATION enum + migration + seed; spec full-shape assert
f84132a1  perf(tech): font local (geist), turbopack, swc builder, Promise.all
          для read queries, bull→bullmq міграція (6 processors)
09617df5  perf(optimize): UI-polish files — useMemo/useCallback row & modal
          handlers; PO modal headerChips (filter + warehouses.find на typing);
          SR modal total reduce; calendar isPastDay; 5 файлів, +275/-190
1788dd0a  fix(tester): Bug #504-#505 — dead DetailPanel/Toggle paired-files
c83f8e29  fix(tester): UI-polish follow-up bugs #496-#503 (HIGH+MEDIUM+LOW)
24dc273d  fix(review): a11y + dead code after UI-polish series
```

Latest tester: 2026-06-15 (FULL, post-bullmq) — booking SMS shape mismatch (HIGH) + weak spec (LOW)

Повна історія → [CHANGELOG.md](CHANGELOG.md)

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                        | Що                                                 |
| ------------------------------------------- | -------------------------------------------------- |
| `apps/api/src/common/utils/array.ts`        | `deduplicateBy<T>(arr, key)` — Map last-wins dedup |
| `apps/web/src/lib/utils.ts`                 | `toIdMap<T extends {id}>`, `calcVatTotals`         |
| `packages/shared/src/constants/statuses.ts` | RECEIPT у STOCK_DOC_TYPE_LABELS/BADGE              |

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
