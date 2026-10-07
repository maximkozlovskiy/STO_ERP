# sto-optimize — db-and-tests

> Частина скіла `sto-optimize`; винесено дослівно, щоб кожен файл влазив в один Read.

## Крок 3 — DB аудит

### 3.1 Відсутні індекси на WHERE колонках

```bash
grep -rn "where.*status\|where.*completedAt\|where.*branchId\|where.*warehouseId\|where.*type\b" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20
grep -n "@@index\|@@unique" packages/database/prisma/schema/*.prisma | head -40
```

| Таблиця       | Колонки                                    | Тип      |
| ------------- | ------------------------------------------ | -------- |
| WorkOrder     | `(orgId, status, branchId, deletedAt)`     | B-tree   |
| WorkOrder     | `(orgId, completedAt, deletedAt)`          | B-tree   |
| StockItem     | `(orgId, warehouseId, deletedAt)`          | B-tree   |
| StockMovement | `(orgId, warehouseId, createdAt)`          | B-tree   |
| text search   | `(number, firstName, lastName, name, sku)` | GIN trgm |

### 3.2 GIN trgm для пошуку

```bash
docker exec stoerp-postgres-1 psql -U sto -d sto_erp -c "SELECT indexname FROM pg_indexes WHERE indexname LIKE '%trgm%';" 2>/dev/null | head -15
```

**Фікс:** `CREATE INDEX IF NOT EXISTS idx_X_col_trgm ON X USING gin (col gin_trgm_ops);`

### 3.3 FK-колонка з `@relation` але БЕЗ `@@index` (Postgres не індексує FK автоматично)

> Пастка: «це ж relation, точно проіндексовано». Ні — PG індексує лише PK і UNIQUE, під FK-constraint — ніколи. Легко пропустити коли нова cross-document фіча (linked-counts, reverse-lookup) додає `groupBy`/`findMany` по `fkColumn: { in: [...] }`.

```bash
grep -rn "groupBy\|findMany" apps/api/src/modules/ --include="*.service.ts" -A3 \
  | grep -E "Id: \{ in:|Id: \{ *in:" | grep -v spec | head -20
grep -n "@@index\|@relation\|model " packages/database/prisma/schema/*.prisma
```

**Особливо небезпечно:** append-only без `deletedAt` (Payment, AuditLog, рухи) — часто немає навіть `(orgId, fk)`. Batched `IN`-груп-бай → org-wide scan.
**Фікс:** covering `@@index([orgId, <fk>])` (+`, <sortKey>` якщо є `orderBy`; для `_count` groupBy sortKey не треба) + additive `CREATE INDEX IF NOT EXISTS`. Ім'я = `<mappedTable>_orgId_<fk>_idx`. Звірити `@@map` — одна назва колонки (`invoiceId`) живе і в parent-lines, і в append-only payments.

### 3.4 Dashboard/summary aggregate по append-only — WHERE без owningFk, індекс веде owningFk (leftmost-prefix miss)

> Пастка: «є `(orgId, fk, createdAt)` — прикрито». Ні: якщо dashboard-гілка не подає `fk`, leading-col між orgId і createdAt вбиває прикриття → org-wide scan.

```bash
grep -rn "\.aggregate(\|\.count(" apps/api/src/modules/dashboard/ apps/api/src/modules/reports/ --include="*.service.ts" -A6 | grep -v spec
grep -n "@@index" packages/database/prisma/schema/*.prisma
# Для кожного: WHERE = (orgId, type|status: '<літерал>', createdAt-range) БЕЗ owningFk? Чи Є @@index що ПОЧИНАЄТЬСЯ (orgId, <discriminator>, ...)?
```

**Фікс:** covering `@@index([orgId, <discriminator>, createdAt])` — discriminator (equality) leftmost після orgId, createdAt (range) останнім. Additive `CREATE INDEX IF NOT EXISTS`. НЕ дублювати якщо discriminator уже leading-col. Кеш дашборду (25s) НЕ знімає потреби — scan болить кожен SSE-інтервал × N users.

### 3.5 Append-only (LOG/AUDIT **АБО CORE ENTITY**) — list/findAll фільтрує по non-FK descriptor (provider/operation/status/fiscalStatus), єдиний індекс веде createdAt-sort

> Пастка: «є `(orgId, createdAt)` під сортування — прикрито». Ні: equality-фільтр по descriptor (не FK, не aggregate — просто `where.provider=x`) не покривається → scan усіх рядків орг у createdAt-порядку + heap-filter.
> **Scope НЕ обмежений `*_logs`:** той самий miss у CORE append-only (`payments.fiscalStatus`, `supplier_payments.status`, `stock_movements.type`) — таблиця без «log» у назві, але монотонна + list зі status-дропдауном. FK-індекси + `(orgId, createdAt)` виглядають покриттям, але жоден не веде descriptor-рівність між orgId і createdAt (2026-09-09 Цикл 2).

```bash
grep -rn "async findAll" apps/api/src/modules/ --include="*.service.ts" -A25 | grep -v spec \
  | grep -E "where\.\w+ = |orderBy: \{ createdAt"
grep -n "model \|@@index\|@@map" packages/database/prisma/schema/*.prisma
# payments/supplier-payments/movements/transactions/receipts — теж кандидати, не тільки logs.
```

**ДОМІНАНТНИЙ фільтр:** відкрити UI-таб — колонка з `<select>`/дропдауном (provider/operation/status/type) = найчастіший equality-фільтр.
**Фікс:** covering `@@index([orgId, <descriptor>, createdAt])` — descriptor leftmost після orgId, createdAt tail → index-range scan + готовий порядок. Additive `CREATE INDEX IF NOT EXISTS`. Zero-risk. Родич 3.4, але тут list-endpoint (не aggregate) і колонка — descriptor (не owningFk).

### 3.6 Default-view index-miss: єдиний sort-індекс веде discriminator/deletedAt як GAP перед sort-ключем, а ДЕФОЛТНИЙ таб-вид — БЕЗ цього фільтра

> Пастка: «є `(orgId, status, deletedAt, sortKey)` — і статус, і дата, і soft-delete прикрито». Ні: у дефолтному «Усі»-виді (status-pill порожній) `where` БЕЗ status → status стає gap-колонкою, leftmost-prefix обривається на `orgId`, sortKey (3-тя/4-та колонка) для ORDER BY недосяжний → scan усіх status-бакетів + external sort. Другий `(orgId, sortKey)` часто Є, але без `deletedAt` → heap-filter.

```bash
# Знайти таби з дефолтом-«Усі» (порожній фільтр на mount) → їх list-запит іде БЕЗ discriminator-а
grep -rn "useState('')" apps/web/src/app/ --include="*Tab.tsx" --include="*page.tsx" | grep -iE "status|type|filter"
# Для таблиці такого табу: чи єдиний sort-індекс має discriminator/deletedAt ПЕРЕД sortKey?
grep -n "@@index" packages/database/prisma/schema/*.prisma
```

**Фікс:** covering `@@index([orgId, deletedAt, <sortKey>])` — deletedAt-рівність (IS NULL) leftmost, sortKey tail → index-range scan з готовим DESC. Additive `CREATE INDEX IF NOT EXISTS`. Filtered-вид лишає свій `(orgId, status, deletedAt, sortKey)` — це ОКРЕМИЙ індекс під дефолтний unfiltered-вид. Тільки схема+міграція (індекс типи не зачіпає → tsc не регресує без prisma generate). Родич 3.4/3.5, але тригер: descriptor ПРИСУТНІЙ як gap, і дефолтний вид його не подає.

---

## Крок 3b — Test-suite performance (vitest/jest)

> Не рантайм продукту, але реальна ціна в CI і в dev-циклі. Перевіряти коли scope включає тести АБО коли ТЗ згадує час набору.

### 3b.1 Vitest isolate — повторна оцінка спільних модулів на кожен файл

```bash
# НЕ grep — вимір. Сам Vitest діагностує у хвості звіту:
pnpm --filter @sto/api exec vitest run --reporter=verbose 2>&1 | tail -5
# Шукати: "evaluated M times" + "~Zs faster with isolate: false". import-частка Duration 70-80% = прапор.
```

**Сигнал:** `Duration` з часткою `import` 70-80% (не `tests`); рядок «Import N modules were evaluated M times» де M ≈ кількість spec-файлів; власна порада Vitest «faster with isolate: false».

**Безпека ПЕРЕД зміною** (shared-worker leak інакше валить тести):

```bash
grep -rln "resetModules\|isolateModules\|vi.doMock" apps/api/src --include="*.spec.ts"   # має бути порожньо
grep -rn "global\.\|globalThis\.\|process\.env\.[A-Z_]* =" apps/api/src --include="*.spec.ts" | grep -v stubEnv  # глоб. monkeypatch без restore
for f in $(grep -rln "useFakeTimers" apps/api/src --include="*.spec.ts"); do grep -q "useRealTimers\|afterEach" "$f" || echo "NO-RESTORE: $f"; done  # має бути порожньо
```

**Фікс:** підтвердити прапорцем `vitest run --no-isolate` (baseline vs no-isolate, обидва green) → лише тоді `isolate: false` у конфізі. Якщо no-isolate валить файли — це leak-и без restore: долагодити ТІ файли, не вертати глобальний isolate. `--no-isolate` — ще й детектор брудної cross-file ізоляції (виявляє тести що тихо залежать від стану іншого файлу). Деталі: «Накопичені підходи» 2026-10-04.

### 3b.2 Vitest isolate:false + ПЕРСИСТЕНТНИЙ transform-cache → одноразовий флейк «стара версія модуля» після зміни файлу

> Пастка (знайдено ЦИКЛ 3, під час ПЕРЕВІРКИ власного isolate:false-фіксу): спек що щойно змінився (новий тест/нова гілка коду) падає ОДИН раз у повному наборі з повідомленням, якого ПОТОЧНИЙ код не продукує (стара рядкова константа, стара формула). Ізольований прогін того ж файлу — зелений. Причина НЕ код і НЕ конфіг: `node_modules/.vite` зберіг transform ПОПЕРЕДНЬОЇ версії файлу, і shared-граф (`isolate:false`) віддав воркеру кешований старий модуль замість перекомпільованого. CI (свіжий контейнер) цього не бачить — лише локальний checkout після того як git-коміт змінив файл поверх теплого кешу.

**Сигнал:** (1) assertion-месседж містить токен (рядок/число), якого `grep` НЕ знаходить у поточному source; (2) падає 1 тест на 4-5 повних прогонів, а ізольовано / з чистим кешем — завжди зелений; (3) падіння саме у спеку/модулі, що недавно змінився у git.

**Діагностика/фікс (НЕ код, НЕ projects-спліт):**

```bash
rm -rf apps/<pkg>/node_modules/.vite node_modules/.vite   # bust stale transform cache
# тоді 3-5 повних прогонів поспіль — мають бути 100% green і месседж = ПОТОЧНИЙ код
```

**Правило для будь-якої cycle-N перевірки isolate:false-набору:** ПЕРЕД заміром стабільності/часу — **завжди** bust `node_modules/.vite`, інакше теплий кеш дає хибний флейк (хибно звинуватиш мок/leak і додаси зайву ізоляцію). Відрізняти від 3b.1-flake (мок+спільний граф → ізолювати файл) і від справжнього cross-file leak (`--no-isolate` детектор): тут файл ЧИСТИЙ в ізоляції І з чистим кешем — лікується лише cache-bust, НЕ зміною конфіга. Деталі: «Накопичені підходи» 2026-10-04 (stale-vite-cache).

---
