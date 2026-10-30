# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:         2026-10-30
Latest review: 2026-10-30 (борг (а) — 1: review 2a8d13d3, tester #1007–#1011).
HEAD:       див. `git log --oneline -1` (хеш тут НЕ дублюється — старіє щокоміту)
Фаза:       PHASES.md 229/231 закрито. Хвости: EAS Build (mobile) + smoke на чистій
            Windows VM — обидва потребують фізичного оточення, не коду.
Борг:       docs/TECH-DEBT.md — S-пункти (а) закриті 2026-10-26; лишились S/M, M, L і
            питання власнику (б). Відкладене ПИСЬМОВО з виміряною ціною: TS 7 (чекає typescript-eslint 7.1),
            api→ESM (1917 помилок; NestJS 12 ESM проти CJS-Prisma/BullMQ —
            перехід ПЕРЕВЕРТАЄ розрив, не усуває), Prisma 8 у RC.
Відкрито:   рішення власника в TECH-DEBT §17.3–4, §18 (ТО при скасуванні, ключ банку, major-залежності,
            MinIO); Release CI змінено — перевірити ручним запуском.
```

**Цифри тут НЕ зберігаються.** Кількість тестів, роутів, розмір бандла старіють
швидше, ніж файл оновлюється: станом на 2026-10-05 тут лежало «301 роут із 422», а
інструмент давав 310 — тобто читач отримував неправду. Міряти:

```bash
bash scripts/measure.sh              # тести + E2E + роути + розміри доків + коміти
bash scripts/verdict.sh --cmd "<мітка>" -- <команда>   # «чисто / не чисто»
bash scripts/prepush.sh             # перед git push (його ж запускає git-хук pre-push), ~2–3 хв
python scripts/count-untyped-routes.py                 # роути без типу
python scripts/check-doc-links.py; python scripts/check-mojibake.py   # посилання; зіпсований UTF-8
```

---

## Останній commit

```
Блок 2026-10-29 (CHANGELOG, 3 записи): UX-огляд (картка в адресі, «Назад», щільність, меню CRM),
  BR-INV-023, звіти BR-RPT-031/033–036 і кнопки «?», палітра й бренд OneService (іконка «OS»,
  назва організації в шапці). Автоматизація (docs/objects/automation.md, план
  ~/.claude/plans/squishy-riding-corbato.md): етап 1 завершено — блоки 1–4 (outbox, двигун, дії, API,
  Telegram-бот, UI `/settings/automation`, серверний дзвіночок). Етап 2 (push, нагадування ТО) — не почато.
  Зарплата BR-PAYR-016 (умови схеми, «Нараховано» по наряду). Інсталятор досі «STO ERP» (окремий крок).

  Схема Prisma — БАГАТОФАЙЛОВА: packages/database/prisma/schema/*.prisma.
  Шляху .../prisma/schema.prisma не існує.
```

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                                                                                                                                                                 | Що                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/dev/{dev-watchdog,setup-dev-autostart}.ps1`                                                                                                                                 | сторож dev-середовища (задача «STO Dev Servers»): Docker-стек, API :3000, web :3001 піднімаються самі; пауза — файл `paused` у `%LOCALAPPDATA%\sto-erp\dev-watchdog\`                                                                                                 |
| `apps/web/src/components/ui/list-toolbar.tsx` `ListStatusRow` / `ListFiltersRow`                                                                                                     | панель списку як у нарядах: статуси кнопками окремим рядком над фільтрами, дії праворуч; стандарт — «Панель списку» в `docs/PATTERNS.md`                                                                                                                              |
| `components/ui/{list-view-actions,list-table-layout,row-delete-button,linked-doc-counters}.tsx`, `table.tsx` `ListTableHeader`                                                       | частини списку документів (`ListToolbar`, каркас таблиці з масовими діями й панеллю, шапка з `sortKeys`); `useListPage` дає `changeFilter`/`filterSetter`/`colSpan` — замість копій, які ловив гейт клонів                                                            |
| `apps/web/src/lib/{url-card,dirty-guards}.ts` `useUrlCard`, `components/ui/help-popover.tsx` `HelpPopover`/`CatalogHelp`                                                             | картка в адресі `?open=` для списків + «Назад» питає при брудній формі; кнопка «?» з поясненням (тексти — каталог `<topic>.blocks` у локалі сторінки, з дос'є)                                                                                                        |
| `components/ui/brand-logo.tsx` `BrandAppIcon`, `hooks/useBrandTheme.ts` (`useRefreshBranding`), `lib/theme.ts` `applyTheme`/`brandThemeBootScript`, api `common/utils/work-hours.ts` | бренд OneService: іконка «OS» і вся шкала brand за палітрою, назва організації (`GET /settings/branding`, усі ролі), скрипт `<head>`; робочий час філії (BR-RPT-033)                                                                                                  |
| `apps/api/src/common/interceptors/idempotency.interceptor.ts` `RequireIdempotencyKey()`                                                                                              | грошовий маршрут без `Idempotency-Key` — 400 (каса, `POST /payments`, сторно); заголовок у Swagger; E2E `apiCall` шле ключ на кожен POST                                                                                                                              |
| `apps/api/src/common/utils/pagination.ts` `findAllInPages`                                                                                                                           | читає ВСІ рядки сторінками за курсором `id` замість `take: N`, що мовчки відрізає хвіст (правила ціноутворення, категорії робіт)                                                                                                                                      |
| `apps/web/src/lib/work-line-executor.ts` + `hooks/api/useLiftMechanics.ts`                                                                                                           | виконавець нової роботи — механік підйомника (BR-WO-030): запис календаря, інакше єдиний підходящий механік                                                                                                                                                           |
| `apps/api/src/modules/goods/good-matcher.service.ts`                                                                                                                                 | єдиний пошук товару за рядком файла (BR-GOOD-008): код → артикул+бренд → штрихкод → артикул → назва; усі завантаження ходять сюди                                                                                                                                     |
| `apps/api/src/modules/xlsx/good-ref-rows.parser.ts`                                                                                                                                  | читає перелік товарів з XLSX/CSV, колонки впізнає за заголовком; `good-matcher.testing.ts` — двійник пошуку для спеків імпорту                                                                                                                                        |
| `apps/api/src/common/utils/confirm-tx-timeout.ts`, `apps/web/src/components/ui/{SupplierOptionsSelect,document-card-header,document-card-actions}.tsx`                               | тайм-аут транзакції проведення за числом рядків; вибір постачальника API (список купівлі, підключення); шапка й дії картки документа — спільні замість клонів                                                                                                         |
| `apps/web/src/hooks/useSelectedRowRefresh.ts`                                                                                                                                        | бокова панель з копією документа перечитує її, коли рядок у списку змінився (картка з вкладки міняє документ на будь-якій сторінці)                                                                                                                                   |
| `scripts/check-schema-drift.py`                                                                                                                                                      | сторож «міграції = schema.prisma» на чистій базі (CI `integration-tests`); `--self-test`                                                                                                                                                                              |
| `.claude/agents/sto-{backend,web,spec-tests,implementer}-agent.md`                                                                                                                   | паралельна реалізація за контрактом; `sto-implementer-agent` — один виконавець api+web зі сталими правилами середовища                                                                                                                                                |
| `apps/web/src/components/ui/list-load-error.tsx`                                                                                                                                     | смуга «список не завантажився» з «Повторити» — збій запиту списку не має виглядати порожнім станом                                                                                                                                                                    |
| `packages/shared/src/schemas/forms/bank-transaction.schema.ts`                                                                                                                       | схеми форм банківських платежів (ручне внесення, рознесення вихідного, скасування) і переліки видів рознесення                                                                                                                                                        |
| `apps/api/src/modules/bank-statements/bank-outgoing-refs.ts`                                                                                                                         | перевірка напряму й посилань виду рознесення ДО захоплення рядка (BR-BANK-025…034)                                                                                                                                                                                    |
| `apps/web/src/lib/download.ts`, `apps/web/src/lib/supplier-cache-rows.ts`                                                                                                            | `downloadBlob`/`downloadUrl` (SOT завантажень); кеш постачальників лише id і назва (BR-CP-014)                                                                                                                                                                        |
| `apps/api/src/common/utils/{pagination,kyiv-date,err,array}.ts`                                                                                                                      | `calculatePagination`; Kyiv-дати (DST); `err(key)` — єдиний `translateError` з локаллю запиту; `groupBy`                                                                                                                                                              |
| `apps/web/src/lib/{idempotency-key,group-by,escape-layers}.ts`, `apiPost`, `useEscapeLayer`, `usePendingOpen`                                                                        | ключ ідемпотентності; групування; POST із JSON; стек шарів Escape — лише верхній шар (GOTCHAS 2026-10-21); картка, що відкривається після запиту, — шар уже під час запиту (Bug #935)                                                                                 |
| `apps/api/src/prisma/schema-integrity.integration.spec.ts`                                                                                                                           | TD2 guard: manual-SQL конструкти (partial-unique/trgm/EXCLUDE/CHECK) живі у БД                                                                                                                                                                                        |
| `apps/api/src/modules/work-orders/work-order-dto.mapper.ts`                                                                                                                          | Винесені WorkOrder DTO-мапери (cost-price role-mask)                                                                                                                                                                                                                  |
| `components/ui/work-order/{InvoiceConflictDialog,PlannedActualMetrics}.tsx`, `components/ui/purchase-order/{types,RulePricerModal}.tsx`                                              | Виділені суб-компоненти CreateWorkOrderModal і PurchaseOrderCreateModal                                                                                                                                                                                               |
| `.claude/skills/<скіл>/{sections,journal}/`                                                                                                                                          | Скіли = ядро `SKILL.md` + секції за типом зміни + журнал; ліміт у КБ — `check-skill-size.py`                                                                                                                                                                          |
| `apps/api/src/common/utils/normalize-article.ts`                                                                                                                                     | `normalizeArticle` — upper + strip non-alnum (SOT skuNormalized/normalizedSynonym)                                                                                                                                                                                    |
| `apps/api/src/modules/xlsx/document-line-import.adapter.ts`                                                                                                                          | Generic import: PO/StockDocument адаптери + registry (loadDoc/assertDraft/replaceLines)                                                                                                                                                                               |
| `apps/api/src/modules/xlsx/import.dto.ts`                                                                                                                                            | PreviewImportDto (multipart) + ApplyImportDto (@ArrayMaxSize 1000)                                                                                                                                                                                                    |
| `apps/api/src/modules/counterparty-import-mappings/`                                                                                                                                 | Персист мапінгу колонок Excel per-контрагент (GET/PUT, upsert по @unique)                                                                                                                                                                                             |
| `packages/config/eslint/sonar.js`, `scripts/check-dupes.sh`, `.github/workflows/codeql.yml`                                                                                          | sonarjs — лише правила класу «баг» (у lint); jscpd — нові клони проти бази (CI `quality`, prepush, `pnpm dupes`); CodeQL — SAST (TECH-DEBT §19)                                                                                                                       |
| `scripts/wsl/{start-docker.sh,setup-docker-autostart.ps1,compact-wsl-disk.ps1}`                                                                                                      | Docker у WSL: один dockerd (flock) + задача «STO WSL Docker», що тримає дистрибутив живим; стискання vhdx (sparse вимкнено)                                                                                                                                           |
| `scripts/mcp/postgres-mcp.sh`, `apps/api/src/common/utils/url-guard.ts` `validatePublicUrlResolved`, `apps/web/src/lib/safe-image-src.ts`                                            | postgres-mcp без сиріт (клієнт з ppid=1 → прибрати); SSRF-перевірка після DNS; схема адреси `<img>`                                                                                                                                                                   |
| `apps/api/src/common/utils/trim-trailing-slashes.ts`                                                                                                                                 | кінцеві `/` адреси без регекса (`/\/+$/` — ReDoS); нове склеювання URL — через нього                                                                                                                                                                                  |
| `apps/api/src/modules/report-builder/{report-condition,report-sql.builder,report-joins,report-sql-result}.ts`                                                                        | конструктор: умови → Prisma (детальні ≤5000) і SQL ROLLUP (групи, «Разом» — точні); паритет — `report-builder.parity.integration.spec.ts` (у списку CI `integration-tests`); сервіс бере базову валюту з `ExchangeRatesService` (порожня валюта = базова, BR-RPT-029) |
| `scripts/verdict.sh`, `scripts/measure.sh`                                                                                                                                           | SOT вердикту «чисто/не чисто» (текст виводу > exit code; невідоме ≠ чисто) і SOT усіх цифр проєкту (tests/e2e/routes/bundle/docs/commits)                                                                                                                             |
| `scripts/audit-claims.py`, `scripts/count-untyped-routes.py`                                                                                                                         | твердження з транскрипту, що потребують доказу (для auditor'а); роути без типу з OpenAPI-документа                                                                                                                                                                    |
| `scripts/hooks/check-claims-verified.py`                                                                                                                                             | Stop-hook: блокує завершення, якщо вердикт/цифра без auditor/verdict.sh/measure.sh                                                                                                                                                                                    |
| `scripts/hooks/_common.py`, `scripts/hooks/test-*.py`                                                                                                                                | Спільне для хуків (stdin, транскрипт); тести хуків ПРОЦЕСОМ — ловлять cp1251-stdin і зіпсовані                                                                                                                                                                        |
| `apps/web/e2e/api-helpers.ts`, `apps/web/src/hooks/useNow.ts`                                                                                                                        | E2E: токен і `apiCall` з повтором на 429; web: поточний час, що оновлюється (лінія «зараз», пікери)                                                                                                                                                                   |
| `.claude/agents/sto-claims-auditor.md`                                                                                                                                               | Агент-аудитор: читає ТРАНСКРИПТ, не мою доповідь; переперевіряє кожну цифру інструментом                                                                                                                                                                              |
| `scripts/check-spec-registry.py`, `scripts/spec-baseline.py`                                                                                                                         | Гейти A–D (втрата кейсів, моноліти, реєстри, BR → тест); baseline — лише через `spec-baseline.py`                                                                                                                                                                     |
| `work-orders/work-order-stock-requirements.ts`, `modules/purchase-lists/`, `modules/supplier-api/`                                                                                   | Резерв наряду (BR-WO-021); списки купівлі (BR-PL); API постачальників, фейки `tools/supplier-fakes` (BR-SCON, BR-SOFR)                                                                                                                                                |
| `.claude/skills/sto-spec/SKILL.md`                                                                                                                                                   | Специфікація агрегату: BR-ID, аспектні спеки, реєстр, гейти; між sto-analyst і sto-feature                                                                                                                                                                            |
| `scripts/affected-tests.py` (+`test-affected-tests.py`)                                                                                                                              | Селектор: готові команди API / WEB / E2E для diff-у; каже, коли потрібен повний прогін; тест — у CI                                                                                                                                                                   |
| `scripts/check-skill-size.py`                                                                                                                                                        | Гейт розміру скілів у КБ (ядро 32, секція 36); у CI job `quality`                                                                                                                                                                                                     |
| `scripts/agent-scopes.py`, `scripts/hooks/require-skill-before-edit.py`                                                                                                              | сфери запису паралельних агентів; PreToolUse-хук: схема/міграції Prisma лише після `/sto-database`                                                                                                                                                                    |
| `.claude/agents/sto-{br-trace,review-finder,tester-finder,fixer}*`                                                                                                                   | Паралельні агенти; НОВІ ТИПИ доступні лише з наступної сесії — перевірити запуск за іменем                                                                                                                                                                            |
| `scripts/qa-bench/seeded.patch`                                                                                                                                                      | Контрольний diff із 4 дефектами — порівнювати QA-агентів на однаковому вході                                                                                                                                                                                          |

---

## Активні особливості поточного коду

- **Марка й модель авто (BR-VEH-006…014):** з довідників `VehicleMake` / `VehicleModel`; клієнт шле
  `makeId` / `modelId`, а `Vehicle.make` / `model` — знімок назви, який пишуть лише сервіси (авто, sync,
  перейменування й злиття в довіднику). Читачі рядків (PDF, зарплата, звіти, нагадування) їх не чіпають.

- **Сума наряду (BR-WO-007):** `totalAmount` — до сплати З ПДВ, `totalNet` — без; ПДВ показувати
  як `totalAmount − totalNet`, НЕ `totalVat` (у нарядів, завершених до 2026-10-08, він застарілий).
  Тотали пише лише `WorkOrderTotalsService.recalc`; рахунок із наряду — `work-order-invoice-lines.ts`
- **CI падає, а локально зелено** → відтворювати кроки CI в чистому Linux-контейнері (`git archive`
  - власні postgres/redis): dev-база й `.env` на диску ховають дефекти чистої інсталяції
- `StockDocumentType.RECEIPT` — повністю додано: Prisma enum + DTO + service + frontend tabs
- `deduplicateBy(plan, u => u.goodId)` — у PO/xlsx applyPricing ПЕРЕД `Promise.all`
- **Ціноутворення:** `PricingService.getPricingContext(orgId, goodIds)` → `resolveRule(ctx, good, cost)`;
  правило зі списком товарів (`PricingRuleGood`) діє лише на список; категорія — з підкатегоріями
  (BR-GOOD-009/010). Пошук товару у файлі — лише через `GoodMatcherService` (BR-GOOD-008)
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
- **Self-re-enqueue у BullMQ — лише під НОВИМ `jobId` на крок** (`payment-poll-<намір>-p<крок>`): `add` з id
  активної задачі мовчки відкидається (Bug #804, docs/GOTCHAS.md). Перевіряється лише на живій черзі —
  `payment-polling.queue.integration.spec.ts` (Redis; у CI `REQUIRE_REDIS=1`). Нова пошта — ще зі старим id
- **Новий `*.integration.spec.ts` дописувати у список job-а `integration-tests`** (`ci.yml`) — список явний
- **Після коміту з новими i18n-ключами — `pnpm --filter @sto/shared build`:** dev-API читає `dist`, без
  перезбирання віддає сирий ключ (`err.payment.…`) замість тексту
- **NestJS SWC на Windows**: залишити tsc builder (`nest start --watch` без `--builder swc`)
- **`rootDir: "src"` у api tsconfig** — обов'язково (інакше dist/apps/api/src/main.js → MODULE_NOT_FOUND)
- **Правило → тест:** над тестом `// guards: BR-XXX-NNN`; гейт D у CI. У дос'є три стани правила:
  мітка, запис у «Чого тут НЕМА», запис у «Розходження з кодом» (18 відкритих — рішення власника)
- **Паралельні агенти** пишуть лише у сферу з `agent-scopes.py plan`, не комітять; після хвилі —
  `verify`. E2E, integration-спеки, повні набори й baseline — лише головний, послідовно
- **Тести локально — лише зачеплені:** `python scripts/affected-tests.py` друкує команди.
  `exit 2` = вибір НЕ зроблено (не «нічого запускати»); рядок «ПОЗА СЕЛЕКТОРОМ» = тесту
  для файлу немає взагалі; E2E для api-модуля враховує й модулі, що імпортують змінений файл,
  і спеки, які самі ходять у його API; `**Маршрути UI:**` у дос'є ДОПОВНЮЄ виведене, не заміняє.
  Рядки «ІНШЕ:» — теж команди (гейти, тест селектора, тести `packages/shared`).
  Повний прогін — CI і раз перед підсумком блоку. E2E ходить на ВЛАСНИЙ сервер `:3002`
  (`.next-e2e`, `NEXT_PUBLIC_E2E=1`); dev-сервер `:3001` заради Playwright не зупиняти
- **CI запускає важкі job-и лише на зміну коду** (job `changes`, `dorny/paths-filter`): правка лише
  `docs/`/скілів — тільки `quality` без типів/тестів. Новий шлях, що впливає на збірку, — дописати у
  фільтр `code`/`docker` у `ci.yml`, інакше його зміна пройде без перевірки. База push — останній успішний
  прогін, не `before` (GOTCHAS 2026-10-23: інакше cancel-in-progress губить код скасованого push)
- **tsc web incremental cache** ламається → використовувати `npx tsc --noEmit --incremental false`
  (голий tsc дає фантомну PricingRulesClient-помилку)

---

## Довідники (читати за потреби)

| Файл                                                 | Коли читати                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | API модулі, Prisma моделі, утиліти, sync                                                    |
| [docs/PATTERNS.md](docs/PATTERNS.md)                 | UI компоненти, hooks, B1-B7, EntityPickerField + Мета-патерни MP-B1..B10/MP-F1..F5          |
| [docs/BUSINESS-RULES.md](docs/BUSINESS-RULES.md)     | FSM, інвентар, розрахунки, тенант-ізоляція                                                  |
| [docs/PROCESS.md](docs/PROCESS.md)                   | Схема процесу: нова задача / доопрацювання, що тримається механічно                         |
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
