# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-09-16
Фаза:       Активна розробка — generic Excel-імпорт товарів + сирий передперегляд (raw-preview) готовий
TypeScript: ✅ 0 errors (api + web, npx tsc --noEmit --incremental false)
Тести:      xlsx api 17/17 (у т.ч. rawPreview +5) · ExcelImportWizard 3/3
HEAD:       aa3d876b fix(review): cellText не протікає «[object Object]» для формули з result-помилкою
Review:     2026-09-16 (auto, коміт 46fab8c9 raw-preview) — 1 Suggestion виправлено:
            cellText для формули з result-об'єктом ({result:{error}}) давав «[object Object]»
            → тепер result рекурсується через cellText; гілку 'error' піднято перед 'result'.
            +тест (#DIV/0!). Решта чисто: RBAC OWNER/ADMIN/XLSX_MANAGER на endpoint, БД/orgId
            не чіпає, limit clamp 1..100, totalRows=actualRowCount, 1-based row.values, XSS
            неможливий (React екранує cells/title), тиха деградація onError, reset rawPreview
            при виборі/відкритті, tabular-nums, множина рядок/рядків, sticky шапка+перший стовпець.
Prev:       d91fe897 (auto) — generic Excel-import FRONTEND: 2 Important
            виправлено. (1) handlePreview/handleApply мали лише disabled={isPending} без
            синх-guard → подвійний клік у одному тіку = дубль preview/apply (Bug #630 клас);
            (2) savedMapping-effect затирав введені колонки при react-query refetch →
            mappingAppliedRef (раз за відкриття). Решта чисто: onClose стабільний (useCallback
            у батьках), cache invalidation коректний (PO/SD keys за docType + mapping detail),
            FormData не шле порожні колонки, apply-payload = whitelist DTO (0 зайвих полів).
            web tsc 0, 15/15 модалок зелені.
            Попередній BACKEND review (HEAD f509cd8b): 0 проблем.
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
Generic Excel-імпорт товарів (FRONTEND) — 2026-09-15, HEAD d91fe897 (3 коміти):
  b913ab48 useExcelImport хуки (preview multipart / apply JSON / counterparty mapping GET+PUT)
           + ExcelImportWizard.tsx (generic ui/, 2-крокова модалка matched/ambiguous/notFound)
  03a098c9 підключення майстра до PurchaseOrderCreateModal + StockDocumentCreateModal
           («Завантажити з Excel» поряд з XlsxImportButton, стабільний onClose)
  d91fe897 review-фікс: синх double-submit guard (handlePreview/handleApply) + once-per-open
           застосування savedMapping (mappingAppliedRef проти react-query refetch-clobber)
web tsc 0 (--incremental false — фантомна PricingRulesClient обходиться), 15/15 модалок зелені.

Generic Excel-імпорт товарів (BACKEND) — 2026-09-15, HEAD 5f3ae56c (3 feature-коміти):
  a4e93da8 normalizeArticle util + skuNormalized/normalizedSynonym SOT + resolveByNameOrSynonym
  228ebadb xlsx adapter registry (PO/SD) + previewImport/applyImport + DTO + controller (DI-drift #724)
  5f3ae56c CounterpartyImportMapping module (GET/PUT /counterparties/:id/import-mapping)
DB-крок був окремим комітом 44e17aba (schema). tsc 0, 297+288 тестів зелені.
Деталі → CHANGELOG.md.
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
| `apps/api/src/common/utils/normalize-article.ts`                                         | `normalizeArticle` — upper + strip non-alnum (SOT skuNormalized/normalizedSynonym)          |
| `apps/api/src/modules/xlsx/document-line-import.adapter.ts`                              | Generic import: PO/StockDocument адаптери + registry (loadDoc/assertDraft/replaceLines)     |
| `apps/api/src/modules/xlsx/import.dto.ts`                                                | PreviewImportDto (multipart) + ApplyImportDto (@ArrayMaxSize 1000)                          |
| `apps/api/src/modules/counterparty-import-mappings/`                                     | Персист мапінгу колонок Excel per-контрагент (GET/PUT, upsert по @unique)                   |

---

## Активні особливості поточного коду

- `StockDocumentType.RECEIPT` — повністю додано: Prisma enum + DTO + service + frontend tabs
- `deduplicateBy(plan, u => u.goodId)` — у PO/xlsx applyPricing ПЕРЕД `Promise.all`
- Generic Excel-імпорт: `XlsxService.previewImport/applyImport` + `DocumentLineImportAdapterRegistry`
  (docType→adapter). skuNormalized/normalizedSynonym пишуться ЛИШЕ у Goods/BrandsService (SOT).
  XlsxService конструктор: Prisma+Pricing+**Goods+Brands+registry** (DI-drift #724 — оновлювати всі специ)
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
