# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-10-05
HEAD:       див. `git log --oneline -1` (хеш тут НЕ дублюється — старіє щокоміту)
Фаза:       PHASES.md 229/231 закрито. Хвости: EAS Build (mobile) + smoke на чистій
            Windows VM — обидва потребують фізичного оточення, не коду.
Борг:       docs/TECH-DEBT.md — усі пункти, що були боргом, закриті. Відкладене
            ПИСЬМОВО з виміряною ціною: TS 7 (чекає typescript-eslint 7.1),
            api→ESM (1917 помилок; NestJS 12 ESM проти CJS-Prisma/BullMQ —
            перехід ПЕРЕВЕРТАЄ розрив, не усуває), Prisma 8 у RC.
```

**Цифри тут НЕ зберігаються.** Кількість тестів, роутів, розмір бандла старіють
швидше, ніж файл оновлюється: станом на 2026-10-05 тут лежало «301 роут із 422», а
інструмент давав 310 — тобто читач отримував неправду. Міряти:

```bash
bash scripts/measure.sh              # тести + E2E + роути + розміри доків + коміти
bash scripts/verdict.sh --cmd "<мітка>" -- <команда>   # «чисто / не чисто»
python scripts/count-untyped-routes.py                 # роути без типу
python scripts/check-doc-links.py                      # посилання між доками
```

---

## Останній commit

```
Спец-орієнтовані тести — 2026-10-07, HEAD 092321bc:
  Фаза 1: 6f47be6e baseline+гейти / 8 комітів розбиття / b62ed9dc реєстри / b4920d66 BR-ID.
  Фаза 2: 48c7450a spec-first у скілах і агентах / def15ec3 новий /sto-spec.

  МОДЕЛЬ: 1 аспект = 1 спек-файл (не 1 правило = 1 файл — зміряно: при правилі-на-файл
  правка transition торкалася б 8-10 файлів замість 3, а DI-обв'язка переважила б асерти).
  Правило має BR-ID у дос'є; реєстр у дос'є каже, який файл ганяти; гейти стережуть.

  ГЕЙТИ (scripts/check-spec-registry.py):
    A втрата кейсів — МНОЖИНИ fullName проти test-baseline.json, не суми
    B нові моноліти — >900 рядків І >=2 top-level describe
    C цілісність реєстрів — файли з дос'є існують
  Baseline оновлюється ЛИШЕ scripts/spec-baseline.py (detермінований, у .prettierignore).

  ПАСТКИ, що коштували часу і тепер у /sto-spec:
    - колізія імені знищила 593-рядковий спек -> ls перед записом, не пам'ять;
    - межі блоків зсувати через коментарі (заголовок наступного блоку стоїть ПІСЛЯ
      закриття попереднього) — інакше коментар осиротіє у чужому файлі;
    - фікстуру КОПІЮВАТИ з оригіналу: написана з пам'яті втратила sameCurrency (4 падіння);
    - деструктуризація у ТІ САМІ імена, інакше правиться кожен it();
    - коментарі перевіряти ОКРЕМО: множини fullName до них сліпі (втрати у 5 із 8 модулів).

  ВІДКРИТЕ: field-encryption.integration.spec залежить від порядку тестів (shuffle дає
  2 падіння) — передіснуюче, фікс поза обсягом, деталі у docs/GOTCHAS.md.
```

Раніше тут лежав журнал на 272 рядки: кожна сесія дописувала свій блок, хоча правило
в цьому ж файлі казало «ЗАМІНИТИ старі, не додавати». Історія живе у `CHANGELOG.md`,
баги — у `BUG_REPORT.md`, пастки — у `docs/GOTCHAS.md`. Дублювати її тут означало
читати те саме двічі на старті кожної сесії.

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                                                                     | Що                                                                                                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/download.ts`                                                           | `downloadBlob`/`downloadUrl` — SOT браузер-завантаження (attached anchor + deferred revoke)                           |
| `apps/api/src/common/utils/pagination.ts`                                                | `calculatePagination` (NaN-guard + cap)                                                                               |
| `apps/api/src/common/utils/kyiv-date.ts`                                                 | Kyiv-date утиліти (DST-aware)                                                                                         |
| `apps/api/src/prisma/schema-integrity.integration.spec.ts`                               | TD2 guard: manual-SQL конструкти (partial-unique/trgm/EXCLUDE/CHECK) живі у БД                                        |
| `apps/api/src/modules/work-orders/work-order-dto.mapper.ts`                              | Винесені WorkOrder DTO-мапери (cost-price role-mask)                                                                  |
| `apps/web/src/components/ui/work-order/{InvoiceConflictDialog,PlannedActualMetrics}.tsx` | Виділені суб-компоненти CreateWorkOrderModal                                                                          |
| `apps/web/src/components/ui/purchase-order/{types,RulePricerModal}.tsx`                  | Виділені з PurchaseOrderCreateModal                                                                                   |
| `.claude/skills/sto-tester/sto-tester-approaches.md`                                     | Журнал патернів багів (винесено зі SKILL.md)                                                                          |
| `apps/api/src/common/utils/normalize-article.ts`                                         | `normalizeArticle` — upper + strip non-alnum (SOT skuNormalized/normalizedSynonym)                                    |
| `apps/api/src/modules/xlsx/document-line-import.adapter.ts`                              | Generic import: PO/StockDocument адаптери + registry (loadDoc/assertDraft/replaceLines)                               |
| `apps/api/src/modules/xlsx/import.dto.ts`                                                | PreviewImportDto (multipart) + ApplyImportDto (@ArrayMaxSize 1000)                                                    |
| `apps/api/src/modules/counterparty-import-mappings/`                                     | Персист мапінгу колонок Excel per-контрагент (GET/PUT, upsert по @unique)                                             |
| `scripts/verdict.sh`                                                                     | SOT вердикту «чисто/не чисто» (текст виводу > exit code; невідоме ≠ чисто)                                            |
| `scripts/measure.sh`                                                                     | SOT усіх цифр проєкту (tests/e2e/routes/bundle/docs/commits, фіксована база)                                          |
| `scripts/audit-claims.py`                                                                | Витягує з транскрипту мої твердження, що потребують доказу (для auditor'а)                                            |
| `scripts/count-untyped-routes.py`                                                        | Роути без типу з OpenAPI-документа (не grep по контролерах)                                                           |
| `scripts/hooks/check-claims-verified.py`                                                 | Stop-hook: блокує завершення, якщо вердикт/цифра без auditor/verdict.sh/measure.sh                                    |
| `scripts/hooks/test-check-claims.py`                                                     | Тест hook'а ПРОЦЕСОМ (18 кейсів) — ловить cp1251-stdin і зіпсовані \b, яких не видно в grep                           |
| `.claude/agents/sto-claims-auditor.md`                                                   | Агент-аудитор: читає ТРАНСКРИПТ, не мою доповідь; переперевіряє кожну цифру інструментом                              |
| `scripts/check-spec-registry.py`                                                         | Три гейти: втрата кейсів (множини fullName), нові моноліти (>900 і >=2 describe), цілісність реєстрів дос'є           |
| `scripts/spec-baseline.py`                                                               | Дистилює vitest-звіт у стабільний `apps/api/test-baseline.json` (файл -> fullName); детермінований, у .prettierignore |
| `.claude/skills/sto-spec/SKILL.md`                                                       | Специфікація агрегату: BR-ID, аспектні спеки, реєстр, гейти; між sto-analyst і sto-feature                            |

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

Після кожного коміту:

1. **`Нові файли/утиліти`** → додати рядок, якщо з'явилась нова утиліта/скрипт/агент
2. **`Активні особливості`** → правити, якщо змінилась логіка, яку не видно з коду
3. **`Поточний стан`** → лише дата і фаза; **хеші й цифри тут НЕ зберігати**
4. Деталі зміни → `CHANGELOG.md` (append). Баг → `BUG_REPORT.md`. Пастка → `docs/GOTCHAS.md`.
   Патерн → `docs/PATTERNS.md`. Одне місце правди, без дублювання.

**ЧОМУ так.** Попередня версія правила казала «`Останній commit` → нові хеші (ЗАМІНИТИ
старі, не додавати)» — і саме це правило порушувалось: секція доросла до 272 рядків
журналом, а `Поточний стан` — до 524. Файл, що мав бути ~150 рядків, читався на старті
кожної сесії у 886. Тому хеш більше не зберігається (`git log` точніший), а цифри
беруться з `scripts/measure.sh` (тут лежало «301 роут», інструмент давав 310).

Поріг: якщо файл перейшов **200 рядків** — щось дописується замість заміни, перечитати
це правило.
