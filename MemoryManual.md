# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-09-15
Фаза:       Активна розробка — backlog TD1–TD3 ЗАКРИТО; 3 повні QA-цикли пройдено
TypeScript: ✅ 0 errors (api + web, --incremental false)
Тести:      API 2313/2313 · web component 754/754 · property/contract у складі suite ·
            E2E 337 passed (0 hard fail, 1 skip=#747, live БД) · schema-integrity guard 7/7
HEAD:       26706372 fix(code-review): цикл 3/3 — updateSaved порушував A1 tenant-guard
```

**Backlog тех-боргу (усе 🟢):** TD1 currencyId NOT NULL + seed base-валюти; TD2 schema-integrity
guard + self-heal trgm проти db push; TD3 консолідація (pagination/kyiv-date utils, DTO-мапери,
4 скіли стиснуто, декомпозиції CreateWorkOrderModal + PurchaseOrderCreateModal, sto-tester split).

**3 QA-цикли (sto-sync→review→tester→optimize→e2e→simplify→code-review→security-review):**
знайдено+виправлено ~30 issue (найвагоміше — цикл-3 code-review зловив, що optimize-RTT-фікс
`updateSaved` порушив A1 tenant-guard → feature dead-on-arrival, виправлено `where:{id,orgId,
deletedAt:null}` + перевірено наживо). 0 security-вразливостей у всіх 3 циклах. Нові фічі, дороблені
у циклах: XLSX-import UI, pricing apply-all, maintenance-schedule edit, expense-category restore,
saved-report rename. Спільний `lib/download.ts` helper. Відкладено: Bug #747 (WorkOrder-модалка не
закривається на dirty-on-open, передіснуючий, test.fixme + BUG_REPORT).

---

## Останній commit

```
3 QA-цикли (повний ланцюг ×3) — 2026-09-15, HEAD 26706372:
  цикл 1: sync(7) review(8) tester(1) optimize(1) e2e(4 розібрано) simplify(1) code-review(1) sec(0)
  цикл 2: sync(3) review(0) tester(0) optimize(1) e2e(0) simplify(1) code-review(1) sec(0)
  цикл 3: sync(1) review(0) tester(0) optimize(3) e2e(0) simplify(1) code-review(2 вкл. CRITICAL) sec(0)
Деталі кожного коміту → CHANGELOG.md.
```

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                                                                     | Що                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/download.ts`                                                           | `downloadBlob`/`downloadUrl` — SOT браузер-завантаження (attached anchor + deferred revoke) |
| `apps/api/src/common/utils/pagination.ts`                                                | `calculatePagination` (NaN-guard + cap)                                                     |
| `apps/api/src/common/utils/kyiv-date.ts`                                                 | Kyiv-date утиліти (DST-aware)                                                               |
| `apps/api/src/prisma/schema-integrity.integration.spec.ts`                               | TD2 guard: manual-SQL конструкти (partial-unique/trgm/EXCLUDE/CHECK) живі у БД              |
| `apps/api/src/modules/work-orders/work-order-dto.mapper.ts`                              | Винесені WorkOrder DTO-мапери (cost-price role-mask)                                        |
| `apps/web/src/components/ui/work-order/{InvoiceConflictDialog,PlannedActualMetrics}.tsx` | Виділені суб-компоненти CreateWorkOrderModal                                                |
| `apps/web/src/components/ui/purchase-order/{types,RulePricerModal}.tsx`                  | Виділені з PurchaseOrderCreateModal                                                         |
| `.claude/skills/sto-tester/sto-tester-approaches.md`                                     | Журнал патернів багів (винесено зі SKILL.md)                                                |

---

## Активні особливості поточного коду

- `StockDocumentType.RECEIPT` — повністю додано: Prisma enum + DTO + service + frontend tabs
- `deduplicateBy(plan, u => u.goodId)` — у PO/xlsx applyPricing ПЕРЕД `Promise.all`
- `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` — exhaustive (з FX_GAIN:+1/FX_LOSS:−1)
- Мультивалюта: money-рядки carry amount+currencyId+amountBase+rateUsed; баланс/звіти у base;
  `requireBaseCurrencyId` fail-closed у WO/Invoice/PO create; currencyId NOT NULL на 4 документних таблицях
- `Promise.all` для per-line writes у SD transition/PO receive (disjoint rows — safe)
- work-orders.service.ts parts loops — **sequential** (shared StockItem composite key — unsafe to parallelize)
- **A1 tenant-guard** ($extends fail-closed): кожен guarded Prisma-виклик МУСИТЬ нести orgId/branchId
  у where (інакше TenantIsolationError) — і для update({where:{id,orgId}}), не лише findMany
- CalendarSlot.parentSlotId — split-day continuation invariant (не колапсувати через updateMany)
- BullMQ API: `@Processor('queue', { concurrency: N })` + `extends WorkerHost` + `async process(job: Job<T>)`
- SMS-канал через `NotificationsService.send(orgId, eventType, payload)` — НЕ прямий `smsQueue.add()`
- **NestJS SWC на Windows**: залишити tsc builder (`nest start --watch` без `--builder swc`)
- **`rootDir: "src"` у api tsconfig** — обов'язково (інакше dist/apps/api/src/main.js → MODULE_NOT_FOUND)
- **tsc web incremental cache** ламається → використовувати `npx tsc --noEmit --incremental false`
  (голий tsc дає фантомну PricingRulesClient-помилку)

---

## Довідники (читати за потреби)

| Файл                                                 | Коли читати                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | API модулі, Prisma моделі, утиліти, sync                                                    |
| [docs/PATTERNS.md](docs/PATTERNS.md)                 | UI компоненти, hooks, B1-B7, EntityPickerField + Мета-патерни MP-B1..B10/MP-F1..F5          |
| [docs/BUSINESS-RULES.md](docs/BUSINESS-RULES.md)     | FSM, інвентар, розрахунки, тенант-ізоляція                                                  |
| [docs/GOTCHAS.md](docs/GOTCHAS.md)                   | Відомі пастки — читати перед новою фічею                                                    |
| [docs/GAPS.md](docs/GAPS.md)                         | Реєстр прогалин/ризиків (G1-G15 бізнес, TD1-TD3 тех-борг)                                   |
| [CHANGELOG.md](CHANGELOG.md)                         | Журнал комітів по фічах                                                                     |
| [BUG_REPORT.md](BUG_REPORT.md)                       | Відкриті/закриті баги (#747 відкритий)                                                      |
| [docs/objects/](docs/objects/)                       | Дос'є агрегатів: WO, Invoice, PO, StockDoc, Counterparty, Good, Work, Calendar, Settlements |
| [.claude/memory/MEMORY.md](.claude/memory/MEMORY.md) | User preferences                                                                            |

---

## Правило оновлення (для агентів)

Після кожного коміту — оновити **тільки** цей файл:

1. `Останній commit` → нові хеші (5–6 рядків, ЗАМІНИТИ старі, не додавати)
2. `Поточний стан` → TypeScript статус, дата, тести
3. `Нові файли/утиліти` → якщо з'явились нові
4. `Активні особливості` → якщо щось змінилось у логіці

**НЕ** додавати сюди деталі рішень, full bug descriptions, список виправлень (файл має лишатись
~150 рядків). Деталі → `CHANGELOG.md` (append, 3–5 рядків max per commit).
Патерн/правило → відповідний довідник (одне місце правди).
