# sto-tester — §1.1 — Бізнес-логіка Backend

> Частина скіла `sto-tester`. Алгоритм і матриця — у `../SKILL.md`.
> Це ПОВНИЙ перелік пунктів секції: короткі — дослівно, довгі — заголовком із кодом
> `T1.1-NNN`. Прочитай файл цілком, познач пункти, що стосуються diff-у, і дістань їхній
> повний текст (сигнал, grep-детектор, фікс) із `../journal/details-1-1.md`:
>
> ```bash
> awk '/T1.1-(007|012) -->/{f=1;next} /<!-- T1\./{f=0} f' .claude/skills/sto-tester/journal/details-1-1.md
> ```

### §1.1 — Бізнес-логіка Backend

#### FSM нарядів

```bash
# FSM читається з map, не хардкодиться
grep -rn "status.*===\|status.*==\b" apps/api/src/modules/work-orders/work-orders.service.ts | grep -v spec | grep -v "TRANSITIONS\[" | head -10

# IN_PROGRESS → RESERVATION через InventoryService
grep -rn "RESERVATION\|createMovement" apps/api/src/modules/work-orders/work-orders.service.ts | head -10

# COMPLETED → WRITEOFF+CHARGE у $transaction
grep -rn "WRITEOFF\|CHARGE\|prisma\.\$transaction" apps/api/src/modules/work-orders/work-orders.service.ts | head -10
```

- [ ] `transition()` читає з `WORK_ORDER_TRANSITIONS` map — не хардкодить статуси
- [ ] `IN_PROGRESS` → резервування через `InventoryService.createMovement(RESERVATION)`
- [ ] `COMPLETED` → `WRITEOFF` + `RESERVATION_RELEASE` + `SettlementsService.createTransaction(CHARGE)` у `prisma.$transaction`
- [ ] `CANCELLED` зі статусу з резервом → `RESERVATION_RELEASE`
- [ ] Bug #780 (CRITICAL): реверс side-effect, що припускає стан, якого альтернативний ВАЛІДНИЙ шлях не створив. — `T1.1-001`
- [ ] Недозволений перехід → `BadRequestException` українською
- [ ] Зміна семантики denormalized поля (`totalAmount`, `balance`) протікає у share/public endpoint (Bug #508) — `T1.1-002`

#### Інвентар

```bash
# Прямий update stockItem (заборонено поза InventoryService)
grep -rn "stockItem\.update\|stockItem\.upsert" apps/api/src/modules/ --include="*.ts" | grep -v "inventory.service\|spec" | head -10

# Guards у InventoryService
grep -n "available\|quantity\|BadRequestException" apps/api/src/modules/inventory/inventory.service.ts | head -20
```

- [ ] Жодного прямого `prisma.stockItem.update({ quantity })` поза `InventoryService`
- [ ] `RESERVATION`: `available < qty` → `BadRequestException`
- [ ] `WRITEOFF`: `quantity < Math.abs(qty)` → `BadRequestException`
- [ ] `quantity=0` → `BadRequestException`
- [ ] SUM(quantity) у звітах/агрегаторах має виключати RESERVATION/RESERVATION_RELEASE (Bug #619) — `T1.1-003`
- [ ] Bug #621 (CRITICAL): Prisma `upsert` create-гілка × Postgres CHECK-констрейнт. — `T1.1-004`

#### Розрахунки

```bash
# Прямий update balance (заборонено поза SettlementsService)
grep -rn "settlementAccount\.update\|balance.*decrement\|balance.*increment" apps/api/src/modules/ --include="*.ts" | grep -v "settlements.service\|spec" | head -5
```

- [ ] Жодного прямого `prisma.settlementAccount.update({ balance })` поза `SettlementsService`
- [ ] `CHARGE` збільшує баланс; `PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE` — зменшують
- [ ] Bug #733 (HIGH): документ ЗБЕРІГАЄ джерело руху (`cashRegisterId`/`bankAccountId`/`warehouseId`) але при провід-переході НЕ створює сам рух → guard оминається за пропуском. — `T1.1-005`
- [ ] Bug #777/#778 (MEDIUM money): per-line display-amount округлюється ПОКРОКОВО, а stored total — round-once → Σ(рядки) ≠ total на дробовій кількості. — `T1.1-006`
- [ ] Bug #688 (CRITICAL money): reconcile/finalize-гілка створює money-запис без `@unique`-лінку на джерело → sequential double-create. — `T1.1-007`
- [ ] Bug #781 (HIGH): drift-детектор звіряє агрегат проти ОДНОГО джерела, коли агрегат оновлюється КІЛЬКОМА шляхами → фальшивий DRIFT на штатному потоці. — `T1.1-008`
- [ ] Bug #629: похідне money × дріб-коефіцієнт / reduce-Σ / різниця сум БЕЗ roundMoney, що покидає систему сирим (export/JSON). — `T1.1-009`
- [ ] Bug #745 (MEDIUM-HIGH): side-effect на «X досяг статусу S» доданий на ОДИН шлях, пропущений на ДРУГОМУ FSM-шляху до S. — `T1.1-010`
- [ ] Bug #743: multicurrency-aware ЕКРАН + non-aware CSV/XLSX/PDF-експорт — сира per-currency сума у одну «amount»-колонку без валюти й без base. — `T1.1-011`
- [ ] Bug #771 (MEDIUM): хардкод символу «₴» у on-screen суфіксі суми, яка стала мультивалютною (multi-bank USD/EUR). — `T1.1-012`
- [ ] Bug #748 (HIGH): рефакторинг-агрегатор загубив dedup/захисний guard оригіналу → `createMany` дублікатів у таблицю без `@@unique(parentId,childId)`. — `T1.1-013`
- [ ] Bug #749 (MEDIUM): create сутностей ПОЗА транзакцією застосування → сироти при помилці в середині batch. — `T1.1-014`

#### Tenant Isolation

```bash
# findFirst/findMany без orgId
grep -rn "findFirst\|findMany\|findUnique" apps/api/src/modules/ --include="*.service.ts" | grep -v "orgId\|spec\|//.*find" | head -20

# Optional FK у create/update spread без org-scoped перевірки (Bug #161)
# для кожного *Id?: поля у CreateDto перевірити чи сервіс робить findFirst({ id: dto.XId, orgId }) ПЕРЕД create/update
grep -rn "Id?: string\|Id!: string" apps/api/src/modules/ --include="*.dto.ts" | grep -iE "brand|unit|supplier|counterparty|vehicle|branch|warehouse|category|account" | head -20
grep -rn "data: { \.\.\.dto\|data: dto\b" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -10
```

- [ ] Кожен `findFirst` / `findMany` / `update` містить `orgId` у `where`
- [ ] Optional FK у `data: { ...dto }` / `data: dto` — `T1.1-015`
- [ ] Defense-in-depth для `update` (Bug #191) — `T1.1-016`
- [ ] Fail-closed guard судить ПРИСУТНІСТЬ токена, не його ФОРМУ → негація обходить (Bug #721) — `T1.1-017`
- [ ] Публічний/unauth endpoint читає tenant-scoped модель без `runUnscoped` → fail-closed guard кидає 500 (Bug #730) — `T1.1-018`
- [ ] Write-time «X налаштовано?»-guard (X = фіскальний провайдер / платіжний шлюз / канал сповіщень / креди) розходиться семантикою з runtime-резолвером X (Bugs #731/#732) — `T1.1-019`
- [ ] Multi-`updateMany` «exclusive mutation» у `$transaction` — orgId у КОЖНОМУ where (Bug #657) — `T1.1-020`
- [ ] Frontend «only-one-active» toggle-тріада (Bug #657) — `T1.1-021`
- [ ] Узагальнення поля до типізованого locator + per-channel selection + структуровані креди (Bugs #658-#660) — `T1.1-022`
- [ ] FSM transition write-path persistence для new nullable row column (Bug #236) — `T1.1-023`
- [ ] BullMQ processor idempotency guard (Bug #346) — `T1.1-024`

- [ ] Dead-feature integration audit: сервіс із queue/processor-компаньйоном, який жоден trigger-flow (payments/invoices/work-orders) не викликає (Bugs #267, #268) — `T1.1-025`

- [ ] Self-re-enqueue polling: domain-service enqueue-гілки + clamp + zombie-job без прямих тестів (Bugs #696-#698) — `T1.1-026`

- [ ] Hardcoded document-number у auto-create обхід DocumentNumberService (Bug #348) — `T1.1-027`

- [ ] Materialize-on-forward-transition без release-on-cancel/reverse (Bug #699) — `T1.1-028`
- [ ] Soft-delete primary без auto-promote next sibling (Bug #351) — `T1.1-029`

- [ ] restore() вузла ієрархії з soft-deleted батьком → сирота у buildTree (Bug #734) — `T1.1-030`

- [ ] reference-time guard приймає вимкнений (isActive=false) довідниковий запис — payment-method / tax-rate / category / template / account (Bug #735) — `T1.1-031`

- [ ] Backend без depth-guard на self-relation дереві коли UI обмежує глибину (Bug #736) — `T1.1-032`

- [ ] Soft string FK без validation: plain-String поле, що посилається на іншу таблицю (`currencyCode`, `paymentMethodCode`, `eventType`) (Bug #361) — `T1.1-033`

- [ ] Auto-create child resource ignores parent settings inheritance (Bug #360) — `T1.1-034`

- [ ] Case-sensitive lookup vs canonical-form seed data (Bug #359) — `T1.1-035`

- [ ] Нове enum value без regression-guard у contract+service spec (Bugs #478-#480) — `T1.1-036`

- [ ] Shared FE constant без парної backend константи (Bug #432) — `T1.1-037`
- [ ] Стала локальна копія shared-константи у тесті + мок-рівнева асерція замість real-invariant (Bugs #705-#706) — `T1.1-038`
- [ ] PRODUCTION-компонент дублює backend-похідну модель (знак/колір/статус) локальним літералом без cross-layer guard (Bug #715) — `T1.1-039`
- [ ] Journal-row колір/напрям фарбується за ТИПОМ-Set, а не за знаком записаної кількості/суми (Bug #738) — `T1.1-040`
- [ ] Audit-track list ↔ update.data symmetry (Bug #433, family Bug #421) — `T1.1-041`
- [ ] Perf-звужений `select` повторно використаний як audit old-snapshot → фейкові «поле→undefined» diff (Bug #719) — `T1.1-042`
- [ ] Audit arg-correctness БЕЗ жодної assert (test-gap #720) — `T1.1-043`
- [ ] Кешований `_count.<junction>` завищений: junction без `deletedAt`, а parent soft-delete-иться (Bug #723) — `T1.1-044`
- [ ] Кешований filtered-`_count` розсинхронізується від мутації РІДНОЇ сутності, що зсуває фільтр, а не самого link (Bug #725) — `T1.1-045`
- [ ] Захисні гілки перенесеного методу після refactor-extract без прямого тесту (A3 e8ae4d70) — `T1.1-046`
- [ ] Cross-endpoint status-filter inconsistency для одного resource (Bug #415) — `T1.1-047`
- [ ] Фільтр, доданий у `findOne` (`vehicle: { deletedAt: null }`, статус, роль), перевірити в читанні-guard-і `update`/`remove` того ж сервісу: наживо GET і PATCH того самого id мусять давати однаковий 404 (Bug #802: GET 404, PATCH 200 з DTO). Grep: `grep -n "findFirst" <service>` → порівняти `where` усіх читань за id
- [ ] Concurrent-create race for "1 active per parent" resources без unique index (Bug #412) — `T1.1-048`
- [ ] Inner $tx re-check тест для Serializable race fix (Bug #416, paired with #412) — `T1.1-049`

- [ ] `Partial<Record<Enum, V>>` lookup map з runtime fallthrough (Bug #488) — `T1.1-050`

- [ ] Alternate-mutation endpoint обходить canonical guards (Bug #403) — `T1.1-051`

- [ ] DB-constraint error-mapping guard у canonical write, відсутній у alternate-mutation endpoint (Bug #628) — `T1.1-052`

- [ ] Concurrent pre-check → write без row-lock або conditional-decrement (Bug #613) — `T1.1-053`

- [ ] Stale-read status-guard → exactly-once ЗОВНІШНІЙ side-effect → write, без CAS-claim (Bug #711) — `T1.1-054`

- [ ] CAS захищає concurrency, але НЕ бізнес-діапазон/max (Bug #712) — `T1.1-055`

- [ ] Статус пишеться `update({ where: { id } })` після окремого читання-guard-а → конкурентний термінальний перехід мовчки перезаписано; гонку шукати зсувом запитів, а не одночасним стартом (Bug #793) — `T1.1-079`

- [ ] Role-gated sensitive DTO field без regression-guard spec (Bug #527, #529) — `T1.1-056`

- [ ] Secret-redaction regex матчить КОРОТКІ підрядки → over-redaction діагностичних полів (Bug #759) — `T1.1-057`

- [ ] Не-JSON-safe значення (BigInt/Date) у JSONB/лог-payload/`job.data` зривають запис → fail-open тиха втрата рядка, зокрема DLQ-аудиту (Bug #760) — `T1.1-058`

#### Prisma schema ↔ migration parity (release-blocker)

```bash
# Bug #220: schema.prisma модифіковано АЛЕ нема нової migration у migrations/
# tsc green (Prisma client типи генеруються з schema, не з applied DB schema)
# unit tests green (vi.fn() mocks не торкаються DB), runtime — P2021 "table does not exist"
schema_changes=$(git diff HEAD~5 HEAD --name-only -- packages/database/prisma/schema/*.prisma)
new_migrations=$(git diff HEAD~5 HEAD --name-only --diff-filter=A -- packages/database/prisma/migrations/)
if [ -n "$schema_changes" ] && [ -z "$new_migrations" ]; then
  echo "BUG #220: schema.prisma modified but no new migration directory created"
fi

# Для кожної нової `model X` у schema → grep у migrations/ за CREATE TABLE
# Блок моделі береться ЦІЛКОМ (awk до закривної `}`), НЕ `grep -A20`: @@map стоїть у кінці
# моделі, а моделі довші за 20 рядків (Organisation — 47) → вікно його не бачило, і детектор
# давав хибні MISSING майже на половину моделей. Без @@map таблиця зветься як модель (не snake_case).
cat packages/database/prisma/schema/*.prisma | grep -E "^model [A-Z]" | awk '{print $2}' | while read model; do
  tbl=$(cat packages/database/prisma/schema/*.prisma \
    | awk -v m="$model" '$1=="model" && $2==m {f=1} f {print} f && /^}/ {exit}' \
    | grep -oE "@@map\(\"[^\"]+\"\)" | head -1 | sed 's/@@map("//;s/")//')
  [ -z "$tbl" ] && tbl="$model"
  if ! grep -rqE "CREATE TABLE( IF NOT EXISTS)? \"$tbl\"" packages/database/prisma/migrations/; then
    echo "MISSING MIGRATION: model $model (table $tbl) — no CREATE TABLE in migrations/"
  fi
done
```

- [ ] Schema↔migration parity (Bug #220) — `T1.1-059`
- [ ] DocumentType enum + INSERT backfill парність (Bug #533) — `T1.1-060`
- [ ] Набори типів нумерації розійшлись ДАВНО (не в diff-і): enum `DocumentType` ↔ `seed.ts` ↔ `setup.service.ts` ↔ виклики `.next(orgId, '…')`; чиста інсталяція = лише `/setup/init` (Bug #794) — `T1.1-080`
- [ ] Constructor DI drift у \*.service.spec.ts (Bug #534, #536) — `T1.1-061`

#### Soft Delete

```bash
# findFirst без deletedAt: null
grep -rn "findFirst\|findMany" apps/api/src/modules/ --include="*.service.ts" | grep -v "deletedAt\|spec\|StockMovement\|SettlementTransaction\|Payment\|WorkOrderLineEmployee\|EmployeeBranch" | head -20

# Прямий hard delete (заборонено)
grep -rn "prisma\.[a-zA-Z]*\.delete(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -10
```

- [ ] Всі `findFirst` / `findMany` мають `deletedAt: null` (окрім append-only моделей)
- [ ] Append-only без `deletedAt`: `SettlementTransaction`, `StockMovement`, `Payment`, `WorkOrderLineEmployee`
- [ ] Жодного `prisma.X.delete()` на бізнес-сутностях
- [ ] Remove-guard «блокувати якщо є пов'язані активні документи» — повнота набору relations (Bug #631) — `T1.1-062`

- [ ] count/detail консистентність за soft-delete (Bug #641) — `T1.1-063`

**Soft-delete + `@@unique` = P2002 при повторному створенні (Bug #152)**

```bash
# Знайти @@unique без partial WHERE deletedAt IS NULL у міграції
grep -n "@@unique" packages/database/prisma/schema/*.prisma
grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"
```

- [ ] Якщо `@@unique([orgId, X])` без `deletedAt` у partial filter → `create()` має **resurrection pattern**: `findFirst({ NOT: { deletedAt: null } })` → якщо знайшов, `update({ ...dto, deletedAt: null })` замість `create`

**PATCH що змінює unique-поле → ConflictException (Bug #151)**

- [ ] `update()` з `dto.field` що є у `@@unique` → re-check: `findFirst({ orgId, field, NOT: { id } })` → `ConflictException` якщо знайшов
- [ ] Hard-delete на моделі БЕЗ `deletedAt` = НЕ порушення §5 (false-positive guard) — `T1.1-064`
- [ ] CRITICAL для soft-delete + @@unique без partial filter (Bug #297) — `T1.1-065`

**restore() prep-checks (Bug #298, #305)**

- [ ] `restore(orgId, id)` робить prep-check на active duplicate: `findFirst({ orgId, <uniqueField>, deletedAt: null, NOT: { id } })` → якщо знайшов → `ConflictException` (інакше P2002 при `update deletedAt=null`).
- [ ] `restore()` defensive guard: якщо `existing.isSystem` → `BadRequestException` (системні не повинні бути soft-деleted взагалі — це сигнал inconsistency).

**isSystem guard для seed-керованих сутностей у update/remove (Bug #319, #320)**

```bash
# Для кожної моделі що має `isSystem Boolean @default(false)` (catalog seed: WorkCategory,
# GoodCategory, UnitOfMeasure, NotificationTemplate, PaymentMethodConfig...) — service.update()
# і service.remove() повинні блокувати mutation коли `existing.isSystem === true`.
grep -rn "isSystem\s*Boolean" packages/database/prisma/schema/*.prisma | head -10
# Для кожного знайденого models → перевірити service.update/remove:
grep -rn "isSystem" apps/api/src/modules/<module>/<module>.service.ts | grep -v "spec\|toDto\|select"
# Має бути: BadRequestException у update (для name/parentId/code/unique-field) АБО у remove.
```

- [ ] Backend isSystem guard у `update()` (Bug #319) — `T1.1-066`
- [ ] Backend isSystem guard у `remove()` (Bug #320) — `T1.1-067`
- [ ] Contract spec для isSystem guard (Bug #319-#320 regression-guard) — `T1.1-068`

**`orderBy` нульового поля + NULL semantics (Bug #296)**

```bash
# orderBy { col: 'asc' } де col nullable → Postgres NULLS LAST за замовчуванням → сюрприз для soft-delete
grep -rn "orderBy.*deletedAt.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls" | head -10
grep -rn "orderBy.*expiryDate.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls" | head -10
```

- [ ] `orderBy` по nullable полю + soft-delete = ОБОВ'ЯЗКОВО explicit `nulls` — `T1.1-069`

#### List endpoints — API contract

```bash
# findAll що повертають голий масив замість { items, total }
grep -rn "return.*\[\]\|return items\b\|return result\b" apps/api/src/modules/ --include="*.service.ts" | grep -v "spec\|toDto\|map(" | head -10
```

- [ ] Кожен list endpoint → `{ items, total }` (не голий масив)

#### Raw SQL — casing та LIMIT

```bash
# Raw SQL без LIMIT
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" | grep -v spec

# snake_case колонки у raw SQL (має бути camelCase з лапками)
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" -A 20 | grep -E "org_id|deleted_at|created_at|updated_at|good_id|warehouse_id|min_stock" | head -10
```

- [ ] Кожен `$queryRaw` має `LIMIT N` (Prisma `take:` не впливає)
- [ ] Raw SQL ідентифікатори — camelCase у лапках: `"orgId"`, `"deletedAt"` (не `org_id`)

#### Алгоритми ціноутворення та партій

```bash
# FEFO — nulls last обов'язково
grep -n "expiryDate" apps/api/src/modules/inventory/batch.service.ts | head -5

# AVG_COST — зважена, не проста
grep -n "AVG_COST\|avgCost\|totalCost" apps/api/src/modules/inventory/batch.service.ts | head -5

# Decimal cast у recalcTotals
grep -n "Number(l\.\|Number(p\.\|totalLabor\|totalParts" apps/api/src/modules/work-orders/work-orders.service.ts | head -5

# Bug #178: bulk-apply scope-consistency — applyRuleToGoods where має всі scope-поля правила
# Для кожного scope-поля у PricingRule (goodId, goodCategory, goodType, brandId) — є в where?
grep -n "brandId\|goodCategory\|goodType\|goodId" apps/api/src/modules/inventory/pricing.service.ts | grep "where\|rule\." | head -20
```

- [ ] FEFO: `[{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]`
- [ ] `PERCENT` = `cost * (1 + pct/100)`; `FIXED_AMOUNT` = `cost + delta`; `FIXED_PRICE` fallback = `fixedPrice ?? costPrice`
- [ ] Округлення = `Math.round(result / r) * r`; захист від від'ємної ціни = `Math.max(0, result)`
- [ ] `recalcTotals`: `Number(l.amount)` cast (Decimal без cast → рядкова конкатенація)
- [ ] Batch loop: `Math.min(remaining, batch.remainingQty)`; якщо `remaining > 0` після циклу → `BadRequestException`
- [ ] Bulk-apply scope-consistency (Bug #178) — `T1.1-070`
- [ ] Nullable cost-input у calculateSalePrice → data corruption salePrice=0 (Bug #198) — `T1.1-071`

#### $transaction timeout

```bash
# $transaction без timeout
for f in $(grep -rl "\$transaction(async" apps/api/src --include="*.ts" | grep -v spec); do
  tx=$(grep -c "\$transaction(async" "$f")
  to=$(grep -c "timeout:" "$f")
  if [ "$tx" -gt "$to" ]; then echo "MISMATCH $f: $tx transactions, $to timeouts"; fi
done
```

- [ ] Кожен `$transaction(async callback)` має `{ timeout: N }` (5000–15000ms)
- [ ] Фіксований `timeout` транзакції, що в циклі проводить рядки документа, звірити з `@ArrayMaxSize` DTO: провести НАЖИВО документ максимального розміру двічі на тих самих товарах (другий прохід повільніший — накопичились партії). Запас < ×2 → таймаут від кількості рядків (Bug #801: 500 рядків TRANSFER = 14,3 с із 15, вдруге — 500)

#### Deploy / infra (docker-compose, Dockerfile, nginx, reverse-proxy)

```bash
# healthcheck бінарник vs базовий образ + шлях vs globalPrefix
grep -n "healthcheck\|curl\|wget\|/health\|HEALTHCHECK" docker-compose*.yml apps/*/Dockerfile 2>/dev/null
grep -n "setGlobalPrefix\|app.use('/api" apps/api/src/main.ts

# curl/wget healthcheck на образі що їх НЕ містить (minio/minio, node:*-alpine, distroless)
# minio/minio має ЛИШЕ mc — НЕ curl/НЕ wget. Емпірична перевірка наявного образу:
#   docker run --rm --entrypoint sh <image> -c "command -v curl; command -v wget; command -v mc"
grep -nE "curl|wget" docker-compose*.yml | grep -i "healthcheck\|test:" -A1

# root .dockerignore присутній (COPY . . без нього шле node_modules/.git/.env у контекст)
test -f .dockerignore && echo ".dockerignore OK" || echo ".dockerignore MISSING"
grep -c "COPY \. \.\|COPY \./" apps/*/Dockerfile 2>/dev/null

# build-скрипт копіює у шлях що НІХТО не обслуговує (dead output)
grep -rn "apps/api/public\|Copy-Item\|cp -r" scripts/ 2>/dev/null
grep -n "useStaticAssets\|@fastify/static\|express.static" apps/api/src/main.ts

# PowerShell $PSScriptRoot (порожній при dot-source) без fallback
grep -rn "PSScriptRoot" scripts/ installer/ 2>/dev/null | grep -v "MyInvocation\|if (\$PSScriptRoot)"

# Bug #717: .ps1 з кирилицею БЕЗ BOM, викликаний powershell.exe 5.1 → мохібейк логів / parse-крихкість
for f in installer/scripts/*.ps1; do head -c3 "$f"|xxd -p 2>/dev/null|grep -q efbbbf || echo "NO-BOM (5.1 мохібейк ризик): $f"; done
grep -rn "powershell.exe\|pwsh" installer/inno/*.iss installer/scripts/*.ps1 2>/dev/null  # powershell.exe=5.1-семантика (BOM обов'язковий)

# Bug #716: rollback re-pull того самого плаваючого тега = no-op + ігнорований exit-code у rollback
grep -nE "Invoke-Rollback|rollback|docker compose pull" installer/scripts/*.ps1 2>/dev/null
# для кожного pull у rollback-гілці: (а) є $prev==$target guard? (б) $LASTEXITCODE після pull/up?
# (в) rollback тягне з registry (fail офлайн) замість docker load з бандлу як Setup? Звірити .env VERSION дефолт.

# Глобальний APP_GUARD (ThrottlerGuard/IpFilterGuard/тощо) — який endpoint має бути виключений (skip-list)
# Bug #203: global ThrottlerGuard блокує /health → docker healthcheck → cascade restart
grep -n "APP_GUARD\|useClass: ThrottlerGuard\|useClass: IpFilterGuard" apps/api/src/app.module.ts
# для кожного global guard → перевірити skip-list (health, metrics, webhooks, SSE):
grep -rn "@Controller.*health\|@Controller.*metrics\|@Sse\|@Controller.*webhook" apps/api/src --include="*.controller.ts" -l | while read f; do
  if ! grep -q "@SkipThrottle\|SkipThrottle()" "$f"; then
    echo "POSSIBLE SKIP-LIST GAP: $f served by global guard but no skip decorator (verify if intentional)"
  fi
done
```

- [ ] Compose healthcheck: бінарник є в образі (minio → лише `mc`), шлях узгоджений з `/api`-prefix — `T1.1-072`
- [ ] Перевірити blast-radius: сервіси з `depends_on: X: { condition: service_healthy }` не стартують якщо healthcheck X завжди FAIL → CRITICAL
- [ ] Root `.dockerignore` присутній якщо будь-який Dockerfile робить `COPY . .` (інакше node_modules/.git/.env/out у контексті — повільно + ризик leak)
- [ ] Build-скрипт не копіює у мертвий шлях (`apps/api/public` коли API не реєструє `@fastify/static`/`useStaticAssets`)
- [ ] `$PSScriptRoot` має fallback `if ($PSScriptRoot) {...} else { Split-Path -Parent $MyInvocation.MyCommand.Path }` (порожній при dot-source)
- [ ] PowerShell-скрипт UTF-8-БЕЗ-BOM + не-ASCII, викликаний `powershell.exe` 5.1 (не `pwsh` 7.x) (Bug #717) — `T1.1-073`
- [ ] rollback re-pull того самого плаваючого тега = no-op + ігнорований exit-code (Bug #716) — `T1.1-074`
- [ ] nginx Next.js static export: `location /_next/static/` з `expires 1y; immutable`; `gzip_types` включає `text/javascript image/svg+xml application/xml`
- [ ] Global APP_GUARD skip-list audit (Bug #203) — `T1.1-075`
- [ ] Paired logger+middleware request-id link (Bug #216) — `T1.1-076`
- [ ] pino redact list — cross-DTO secret-field audit (Bug #217) — `T1.1-077`

- [ ] redact/mask min-length поріг пропускає найкоротший реальний секрет (Bug #709) — `T1.1-078`

- [ ] BullMQ self-re-enqueue під `jobId` активної задачі — `add` мовчки відкидається, ланцюг опитування обривається після першого кроку (Bug #804) — `T1.1-081`

- [ ] Друкований документ бере суму з рядків, а борг — з тоталу документа-джерела: тотал округлено раз, рядки — кожен окремо, різниця в копійку (Bug #807). Наживо: 3 × (0,3 × 111,11) + 0,07 у КОЖНОМУ режимі ПДВ; звірити PDF з боргом. Grep: `grep -rn "linesTotal\|sumMoney(.*lines" apps/api/src/modules --include=*.service.ts`

- [ ] Raw SQL: `<timestamp без зони> AT TIME ZONE 'Europe/Kyiv'` зсуває UTC-мітку НАЗАД — нічні події йдуть у попередній день (Bug #808). Правильно: `AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv'`. Grep: `grep -rn "AT TIME ZONE" apps/api/src --include=*.ts | grep -v "'UTC' AT TIME ZONE"`

- [ ] Рядки документа (PDF, рахунок із наряду) читаються вкладеним `select` без `orderBy` — порядок рядків випадковий, «останній рядок» із копійкою округлення теж (Bug #814). Наживо: той самий документ надрукувати для 2–3 однакових нарядів і порівняти порядок. Звірити `orderBy` у ВСІХ читаннях рядків одного агрегату

- [ ] Сирий добуток `кількість × ціна` пишеться в `Decimal(12,2)` без `money()` — округлює Postgres за рядком числа (30.014999… → 30,01), а сусідній код рахує `money()` = 30,02 (Bug #813). Grep: `grep -rnE "amount = [a-zA-Z]+ \* [a-zA-Z]+;" apps/api/src/modules --include=*.service.ts`

- [ ] Поділ інтервалу на межі (робочий день, доба, зміна) перевіряє лише КІНЕЦЬ (`end > межа`), а початок уже за межею → частина «до межі» від'ємна: запис із `endAt < startAt` (Bug #819). Наживо: створити інтервал, що ПОЧИНАЄТЬСЯ після межі (слот 23:30–23:50) і до неї (00:30), звірити збережені `startAt`/`endAt`. Grep: `grep -rnE "isSplit|> workDayEnd|> dayEnd" apps/api/src/modules --include=*.service.ts`

- [ ] Імпорт файлом у два кроки (прев'ю → apply): усе, що показало прев'ю, apply мусить ПРИЙНЯТИ. Згодувати файл із сумою менше копійки, з float-хвостом (`0.1+0.2` у XLSX) і трьома знаками: парсер без округлення + `@Min(0.01)` на рядку apply = 400 на весь імпорт (Bug #825)

- [ ] Парсер файлу мовчки пропускає рядок із нерозбірною сумою: згенерувати файл із `(150,00)`, `−200,00` (U+2212), `150,00 грн`, `1.234,56`, `1,234.56` і CSV з `;` — порівняти число рядків файла й прев'ю; зниклий грошовий рядок = баг (Bug #826, #827)

- [ ] Грошове поле DTO з `@Min`, але без `@Max`: послати `1e10` у колонку `Decimal(12,2)` → 500 `numeric field overflow` замість 400 (Bug #828). `grep -n "@Min(0.01)" -A2 apps/api/src/modules/**/*.dto.ts | grep -L "@Max"`

- [ ] Період у ТІЛІ запиту (`periodFrom`/`periodTo`, `periodStart`/`periodEnd`) перевірено на форму дат, але не на порядок: перевернутий період створює документ (201) без рядків (Bug #822). Наживо на кожному POST із періодом: початок пізніше за кінець → 400. Grep: `grep -rnE "period(From|Start)" apps/api/src/modules --include=*.dto.ts`

---
