---
name: sto-tester
description: >
  Тестувальник STO ERP. Знаходить баги в бек- і фронт-частині, фіксує їх у BUG_REPORT.md,
  після чого автоматично виправляє кожен баг. Враховує бізнес-логіку: FSM нарядів,
  резервування запчастин, розрахунки балансів, tenant isolation, soft delete.
  Запускай командою /sto-tester після реалізації фічі або перед релізом.
model: claude-opus-4-7
bypassPermissions: true
---

# sto-tester — Автоматичний тестувальник STO ERP

## Режим Auto (ОБОВ'ЯЗКОВО)

**Все виконується без питань.** Алгоритм:

```
1. Крок 0 — підготовка (tsc + unit tests + scope)
2. Крок 1 — статичний аналіз (7 секцій grep)
3. Крок 2 — записати BUG_REPORT.md
4. Крок 3 — виправити всі баги (CRITICAL → LOW)
5. Крок 4 — верифікація (tsc + unit + contract)
6. Крок 5 — розширені тести (property / E2E / component)
7. Крок 6 — git commit + оновити MemoryManual.md
8. Крок 7 — самовдосконалення: записати нові підходи
```

> Не питай дозволу між кроками. Фіксуй одним реченням що робиш.

**AUTO vs FULL:**

- **AUTO** (після кожного commit, CLAUDE.md правило) → Кроки 0–4, 6–7; Крок 1 тільки змінені файли; Крок 5 пропустити
- **FULL** (явний `/sto-tester`) → Всі кроки 0–7; Крок 1 повний аналіз

---

## Крок 0 — Підготовка

```bash
# TypeScript — нульова точка відліку
pnpm --filter @sto/api exec tsc --noEmit
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false 2>&1 | tail -20
pnpm --filter @sto/shared exec tsc --noEmit

# Unit tests
pnpm --filter @sto/api test --run 2>&1 | tail -30

# ОБОВ'ЯЗКОВО: web component suite ТАКОЖ у baseline (не лише API).
# Червоний web-тест невидимий якщо запускати лише @sto/api → виявиться аж на Кроці 4.
# Стале component-vs-test drift (тест асертить текст/поведінку якої компонент не має) ловиться ЛИШЕ тут.
pnpm --filter @sto/web exec vitest run 2>&1 | tail -10

# Scope (AUTO: тільки змінені файли; FULL: весь проєкт)
git diff HEAD --name-only | head -30
cat MemoryManual.md | head -50
```

TS або unit (API **і** web) червоні → зафіксуй як Bug #0, виправ ПЕРШИМ. Червоний baseline-тест (навіть не зачеплений scope-коммітами) — release-blocker: ховає регресії за шумом і блокує наступні сесії.

**ОБОВ'ЯЗКОВО: перевірити `[x]`-маркери попередніх сесій проти реального стану файлів.**
Попередня сесія могла позначити баги `[x] виправлено`, але закомітити лише docs (`MemoryManual.md`/`BUG_REPORT.md`) — фікси у коді відсутні. `[x]` без парного diff = хибно-зелений, гірший за відкритий баг (приховує блокер).

```bash
# Для кожного нещодавнього [x]-бага у BUG_REPORT.md що згадує конкретний файл:рядок —
# перевірити чи фікс РЕАЛЬНО у файлі (не довіряти статусу).
git log --oneline -5 --stat   # останній "fix(tester)" commit змінив код, чи лише *.md?
# якщо останній tester-commit чіпає ТІЛЬКИ MemoryManual.md/BUG_REPORT.md → фікси не застосовані
grep -n "Статус.*\[x\]" BUG_REPORT.md | tail -10   # звірити кожен з grep по реальному файлу
```

Якщо `[x]`-баг не виправлений у коді → переклас на відкритий, виправити РЕАЛЬНО, додати meta-bug про хибний маркер.

**AUTO: матриця що перевіряти за типом зміни**

| Тип зміни                      | Секції Кроку 1                                                            |
| ------------------------------ | ------------------------------------------------------------------------- |
| Новий `@Controller` / endpoint | §1.1 (tenant, soft delete), §1.2 (TS, API contract), §1.5 (contract spec) |
| Змінений `*.service.ts`        | §1.1 (business logic, FSM, inventory, settlements)                        |
| Нова `page.tsx` / зміна UI     | §1.3 (frontend стани, hydration, routing)                                 |
| Новий `*.dto.ts`               | §1.2 (validation guards, @IsUUID версія)                                  |
| `prisma/schema.prisma`         | §1.1 (soft delete fields, orgId), §1.2 (TS)                               |
| `components/ui/` only          | §1.3 (стани), §1.6 (a11y)                                                 |
| Config / docs / тести          | §0 (tsc) — більше нічого                                                  |

---

## Крок 1 — Статичний аналіз (збір багів)

> AUTO: аналізуй ТІЛЬКИ файли з `git diff HEAD --name-only`.
> FULL: повний аналіз всіх секцій.

Кожен знайдений баг → запиши в BUG_REPORT.md (Крок 2 — шаблон нижче).

---

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
- [ ] Недозволений перехід → `BadRequestException` українською

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

#### Розрахунки

```bash
# Прямий update balance (заборонено поза SettlementsService)
grep -rn "settlementAccount\.update\|balance.*decrement\|balance.*increment" apps/api/src/modules/ --include="*.ts" | grep -v "settlements.service\|spec" | head -5
```

- [ ] Жодного прямого `prisma.settlementAccount.update({ balance })` поза `SettlementsService`
- [ ] `CHARGE` збільшує баланс; `PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE` — зменшують

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
- [ ] **Optional FK у `data: { ...dto }` / `data: dto`** (`brandId`, `unitId`, `preferredSupplierId`, `vehicleId`, `branchId`...) → сервіс валідує КОЖЕН наданий FK через `findFirst({ id: dto.XId, orgId, deletedAt: null })` ПЕРЕД write (патерн Bug #90). Сирий DB FK перевіряє лише глобальне існування `id`, НЕ `orgId` → FK з чужої org проходить → cross-tenant linkage. P2003 ловить ТІЛЬКИ неіснуючий ID, не cross-tenant — тому «P2003 прийнятний» НЕ закриває tenant-isolation. Severity HIGH
- [ ] **Defense-in-depth для `update` (Bug #191):** жоден `prisma.X.update({ where: { id } })` на org-scoped таблиці без `orgId` у `where`. Prisma не підтримує `update({ where: { id, orgId } })` для primary-key (TS error) → використовувати `updateMany({ where: { id, orgId, deletedAt: null } })` + опціонально `if (count === 0) throw NotFoundException(...)`. Локально безпечно якщо `id` отриманий через org-scoped read, АЛЕ майбутній рефактор/copy-paste у controller без org-check = cross-tenant write без error. Grep: `grep -rn "\.update({ where: { id:" apps/api/src/modules/` — кожен match без `orgId` у where = LOW (profilatic), HIGH якщо викликається з prep-неперевіреним `id`
- [ ] **FSM transition write-path persistence для new nullable row column (Bug #236):** sprint що додає `nullable colX?: TypeX` у row-модель (`PurchaseOrderLine`/`StockDocumentLine`/`InvoiceLine`/`WorkOrderPart`) + mapping `colX: l.colX ?? null` у `toDto` → у кожному `transition(STATE)` / `receive()` / `applyPricing()` / FSM-обчислювальному методі, де обчислюється resolved value (наприклад `lineUnitId = good.unitId`) і пропагується у side-effect resource (`inventory.createMovement(colX: lineUnitId)`/`stockMovement.create({ colX })`), ОБОВ'ЯЗКОВО має бути парний `tx.<rowTable>.update({ where: { id: line.id }, data: { colX: resolvedValue } })` для самого row, всередині $transaction. Інакше `findOne(id).lines[i].colX === null` назавжди → cross-resource inconsistency: history (movements) має X, current state (line) має NULL → audit/sync/export ламається. Symmetric-write для Bug #232 (read-side missing include). Grep: `grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"` → для кожного match у відповідному `transition()`/`receive()`/`applyPricing()` шукати `tx.<row>.update.*data.*colX`. Severity HIGH (silent data integrity)

#### Prisma schema ↔ migration parity (release-blocker)

```bash
# Bug #220: schema.prisma модифіковано АЛЕ нема нової migration у migrations/
# tsc green (Prisma client типи генеруються з schema, не з applied DB schema)
# unit tests green (vi.fn() mocks не торкаються DB), runtime — P2021 "table does not exist"
schema_changes=$(git diff HEAD~5 HEAD --name-only -- packages/database/prisma/schema.prisma)
new_migrations=$(git diff HEAD~5 HEAD --name-only --diff-filter=A -- packages/database/prisma/migrations/)
if [ -n "$schema_changes" ] && [ -z "$new_migrations" ]; then
  echo "BUG #220: schema.prisma modified but no new migration directory created"
fi

# Для кожної нової `model X` у schema → grep у migrations/ за CREATE TABLE
grep -E "^model [A-Z]" packages/database/prisma/schema.prisma | awk '{print $2}' | while read model; do
  tbl=$(grep -A20 "^model $model " packages/database/prisma/schema.prisma | grep -oE "@@map\(\"[^\"]+\"\)" | head -1 | sed 's/@@map("//;s/")//')
  [ -z "$tbl" ] && tbl=$(echo "$model" | sed 's/\([A-Z]\)/_\L\1/g' | sed 's/^_//')
  if ! grep -rq "CREATE TABLE.*\"$tbl\"" packages/database/prisma/migrations/; then
    echo "MISSING MIGRATION: model $model (table $tbl) — no CREATE TABLE in migrations/"
  fi
done
```

- [ ] **Schema↔migration parity (Bug #220)** — будь-який commit що модифікує `packages/database/prisma/schema.prisma` має закомітити **парний** SQL-файл у `packages/database/prisma/migrations/<timestamp>_<feature>/migration.sql`. Це CRITICAL release-blocker (фіча мертва у runtime з `P2021 table does not exist`). tsc green бо Prisma client типи генеруються з декларативної schema. Unit tests green бо vi.fn() mocks не торкаються DB. Ловиться ТІЛЬКИ статичним аудитом `git diff schema.prisma` ↔ `migrations/`. Перевіряти для: (а) нової `model X` → `CREATE TABLE`; (б) додавання field → `ALTER TABLE ADD COLUMN`; (в) нового `@@index` → `CREATE INDEX` (silent perf regression замість CRITICAL crash); (г) `@@unique` → `CREATE UNIQUE INDEX`. Не покладатись на `prisma migrate dev` (потребує live DB + interactive prompt); писати migration SQL вручну за шаблоном з найближчого попереднього migration з аналогічним relation pattern.

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

**Soft-delete + `@@unique` = P2002 при повторному створенні (Bug #152)**

```bash
# Знайти @@unique без partial WHERE deletedAt IS NULL у міграції
grep -n "@@unique" packages/database/prisma/schema.prisma
grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"
```

- [ ] Якщо `@@unique([orgId, X])` без `deletedAt` у partial filter → `create()` має **resurrection pattern**: `findFirst({ NOT: { deletedAt: null } })` → якщо знайшов, `update({ ...dto, deletedAt: null })` замість `create`

**PATCH що змінює unique-поле → ConflictException (Bug #151)**

- [ ] `update()` з `dto.field` що є у `@@unique` → re-check: `findFirst({ orgId, field, NOT: { id } })` → `ConflictException` якщо знайшов

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
- [ ] **Bulk-apply scope-consistency (Bug #178):** `applyRuleToGoods` `where`-умова містить ВСІ scope-поля правила (`goodId`, `goodCategory`, `goodType`, `brandId`). Будь-яке нове scope-поле у `PricingRule` → одразу оновити `where` у bulk-apply. Відсутнє scope-поле = правило застосовується до зайвих товарів → неправильна salePrice у БД без помилки.
- [ ] **Nullable cost-input у calculateSalePrice → data corruption salePrice=0 (Bug #198):** будь-який сервіс що передає `costPrice` у `pricingService.calculateSalePrice` має ПЕРЕД викликом перевірити: `if (good.purchasePrice == null || Number(good.purchasePrice) <= 0)` → пропустити цей good (push у `notFound`/`skipped`, НЕ оновлювати salePrice). Інакше для `PERCENT`/`COMPETITOR_PLUS`/`COST_TIER` правил отримаєш `0 * (1 + p/100) = 0` → `Good.salePrice` **затирається у 0** без помилки. `Good.purchasePrice` у схемі nullable — будь-який новий код що читає його як `Number(good.purchasePrice ?? 0)` робить **silent data corruption** для товарів без собівартості. Виключення: `FIXED_PRICE` правило безпечне (повертає фіксовану ціну незалежно від cost). Grep: `grep -rn "calculateSalePrice\|purchasePrice ?? 0\|purchasePrice ?? null" apps/api/src/modules/ --include="*.ts"` — кожен виклик у сервісі що пише `salePrice` має мати prep-guard.

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

- [ ] Кожен compose healthcheck: бінарник є у базовому образі (alpine → НЕ curl; node → `node -e http.get`; **minio/minio → НЕ curl/НЕ wget, лише `mc` → `["CMD","mc","ready","local"]`**); шлях узгоджений з `setGlobalPrefix`/proxy-prefix (`/api/health` не `/health`). Не довіряти «alpine/curl» евристиці для НЕ-alpine образів (minio, distroless, mongo тощо) — перевіряти емпірично `docker run --rm --entrypoint sh <image> -c "command -v curl wget mc"`
- [ ] Перевірити blast-radius: сервіси з `depends_on: X: { condition: service_healthy }` не стартують якщо healthcheck X завжди FAIL → CRITICAL
- [ ] Root `.dockerignore` присутній якщо будь-який Dockerfile робить `COPY . .` (інакше node_modules/.git/.env/out у контексті — повільно + ризик leak)
- [ ] Build-скрипт не копіює у мертвий шлях (`apps/api/public` коли API не реєструє `@fastify/static`/`useStaticAssets`)
- [ ] `$PSScriptRoot` має fallback `if ($PSScriptRoot) {...} else { Split-Path -Parent $MyInvocation.MyCommand.Path }` (порожній при dot-source)
- [ ] nginx Next.js static export: `location /_next/static/` з `expires 1y; immutable`; `gzip_types` включає `text/javascript image/svg+xml application/xml`
- [ ] **Global APP_GUARD skip-list audit (Bug #203):** будь-яке введення global guard через `{ provide: APP_GUARD, useClass: XGuard }` потребує аудиту endpoint-ів які мають бути виключені: (а) `/health` — docker healthcheck/nginx upstream/моніторинг опитують часто, ліміт швидко перетинається → cascade restart; (б) `/metrics` — Prometheus scrape кожні 15s; (в) SSE-streams (`@Sse`) — довгоживучі з'єднання повторно retry-ються EventSource при втраті; (г) webhooks з зовнішніх систем (PRRO, payment provider) — клієнт не контролює rate; (д) batch/cron-endpoints. Кожен такий контролер потребує парний skip-декоратор (`@SkipThrottle()`, `@Public()`, `@SkipGuard()`). tsc не ловить, тести не ловять (HEALTH spec звичайно не запускає AppModule з APP_GUARD). Виявляється лише у проді коли docker healthcheck отримує `429` → restart loop.
- [ ] **Paired logger+middleware request-id link (Bug #216):** коли проєкт додає одночасно (а) HTTP correlation middleware що сетить `x-request-id` header, і (б) structured logger (`nestjs-pino`/`pino-http`) — пересвідчись що ДВА компоненти **поділяють той самий ID source**. Дефолтний `pino-http.genReqId` повертає sequential integers (`1, 2, 3, ...`) — НЕ читає header. Middleware сетить header один UUID, pino пише інший integer у `reqId` лога → cross-correlation мертва. Grep: `grep -n "genReqId\|reqId" apps/api/src` — якщо середовище має CorrelationIdMiddleware АЛЕ нема `genReqId` у pino config → bug. Фікс: `genReqId: req => req.headers['x-request-id']`-based з fallback `randomUUID()`. Захист: контракт-тест що шле `X-Request-Id: <UUID>` і асертить `JSON.parse(stdout).reqId === <UUID>`. Аналогічна перевірка: `customLogLevel`, `customSuccessMessage`, `serializers` що ховають correlation поля. Severity: HIGH (не runtime crash, але feature що додається саме для production-моніторингу — не працює).
- [ ] **pino redact list — cross-DTO secret-field audit (Bug #217):** після додавання `pino` `redact: [...]` пройти кожен `*.dto.ts` у `apps/api/src/modules/` і знайти ВСІ plaintext-secret поля (`password`, `*Password`, `*Token`, `*Secret`, `*Key`, `*PrivateKey`, `apiKey`, `webhookSecret`). Кожне таке поле має `req.body.X` АБО `req.body.*Password`-glob у redact. Grep: `grep -rnE "(password|Token|Secret|apiKey|webhookSecret)!?\??:.*string" apps/api/src/modules/**/*.dto.ts` → cross-check проти `redact: [...]`. SKILL §1.4 раніше згадував лише `password`/`refreshToken`/`accessToken`; реальні DTO мають теж `ownerPassword` (setup), `prroApiKey` (POS), `webhookSecret` (webhooks). Без full аудиту перший review-раунд накладає redact лише для очевидних auth-полів, а решта secret-полів лишається непокритими — log statement з spread `req.body` витече їх. Severity: MEDIUM (поки немає log statement що spread-ить body — нема leak; додавання stmt стає HIGH).

---

### §1.2 — TypeScript / API якість

```bash
# Dead imports after page/module split (Bug #204-#205)
# tsconfig зазвичай має noUnusedLocals: false → tsc мовчить про неіснуючий runtime impact,
# але мертві імпорти псують tree-shaking + плутають code review + ламаються коли helper переноситься
# у privately-renamed export. Шукати кожен imported symbol чи реально вживається у файлі-споживачі.
for f in $(git diff HEAD --name-only | grep -E "\.(ts|tsx)$"); do
  [ -f "$f" ] || continue
  # extract imported names from { ... } imports
  for sym in $(grep -oE "^import \{[^}]+\}" "$f" | grep -oE "[A-Za-z_][A-Za-z0-9_]+" | grep -v "^import$\|^from$" | sort -u); do
    # count occurrences excluding import line itself
    count=$(grep -c "\b$sym\b" "$f")
    importLines=$(grep -c "^import.*\b$sym\b" "$f")
    used=$((count - importLines))
    if [ "$used" -le 0 ]; then echo "DEAD IMPORT in $f: $sym"; fi
  done
done

# any без виправданого cast
grep -rn ": any\b\|as any\b" apps/api/src/modules/ --include="*.ts" | grep -v "as unknown as\|spec" | head -10

# Prisma model напряму в response
grep -rn "return.*await.*prisma\|res\.json.*prisma\|return prisma" apps/api/src/modules/ --include="*.controller.ts" | grep -v spec | head -10

# BigInt у response без Number() cast
grep -rn "syncVersion\b" apps/api/src/modules/ --include="*.service.ts" | grep -v "Number(\|toNumber()\|spec\|where\|select\|BigInt" | head -10

# @IsUUID без версії — відхиляє nil-UUID (test-only баг)
grep -rn "@IsUUID()" apps/api/src/modules/ --include="*.dto.ts" | head -5

# ParseUUIDPipe відсутній
grep -rn "@Param('id')" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe" | head -10

# Ukrainian error messages
grep -rn "throw new.*Exception\|throw new.*Error" apps/api/src/modules/ --include="*.ts" \
  | grep -E "['\"](Cannot|Invalid|Not found|Already|Forbidden|Unauthorized|Failed)" | grep -v spec | head -10

# JSON/Record DTO поля без @IsObject() → знімаються whitelist:true → undefined в сервісі (Bug #182)
# КОЖНЕ поле DTO (включно з non-primitive типами) потребує хоча б одного декоратора
grep -rn "Record<string\|: object\b\|: Json\b" apps/api/src/modules/ --include="*.dto.ts" | grep -v "//\|spec" | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  lineno=$(echo "$line" | cut -d: -f2)
  # перевірити чи є будь-який @Is decorator на попередніх 3 рядках
  startline=$((lineno > 3 ? lineno - 3 : 1))
  if ! sed -n "${startline},$((lineno-1))p" "$file" | grep -q "@Is\|@Validate\|@Allow"; then
    echo "MISSING DECORATOR on $file:$lineno"
  fi
done
```

- [ ] Немає `any` (крім `as unknown as T`)
- [ ] `toResponseDto()` — жоден Prisma model не повертається напряму
- [ ] `syncVersion: Number(row.syncVersion)` у всіх DTO (Decimal/BigInt → Number)
- [ ] `@Param(':id')` → `ParseUUIDPipe`
- [ ] `throw new XxxException('...')` — повідомлення українською
- [ ] `@IsUUID()` без версії ('all') відхиляє nil-UUID → у **тестах** для UUID-полів: `11111111-1111-4111-8111-111111111111` (v4 layout)
- [ ] **JSON/Record DTO поля** (`Record<string, unknown>`, `object`, `Json`) → обов'язково `@IsObject()` або `@ValidateNested()`. Без декоратора `whitelist: true` знімає поле мовчки → `dto.value === undefined` → сервіс записує `undefined/null` у БД без помилки (Bug #182). Перевіряти: `grep -A2 "!: Record\|?: Record\|!: object\|?: object" *.dto.ts | grep -v "@Is"`
- [ ] **Multipart `await req.file()` обгорнутий у try/catch** (Bug #192): `fastify-multipart` кидає FastifyError "the request is not multipart" що мапиться у HTTP **406** з англ. messageом якщо клієнт відправляє НЕ-multipart body. Helper має ловити це і re-throw `BadRequestException` українською. Grep: `grep -rn "await req.file()" apps/api/src/modules/ --include="*.controller.ts"` — кожен виклик у try/catch АБО у helper з try/catch. Contract spec для нового multipart-endpoint вимагає тест `POST без multipart → 400 + укр. msg`
- [ ] **Mass DTO migration completeness — grep variant audit (Bug #215):** sprint-wide refactor (наприклад «змінити `@Matches(uuid-regex)` → `@IsUUID()` у всіх DTO», «додати `@IsOptional()` до всіх `?:` полів», «замінити `string` → `string | null` для nullable DB полів») часто пропускає **варіантні форми** оригінального паттерну. Розробник grep-ить простий case (`@IsUUID('4')`) і пропускає декорації з додатковими args (`@IsUUID('4', { each: true })`, `@IsUUID('4', { message: '...' })`). Після sprint лишається 2-5 file-points з СТАРОЮ строгістю — тестові fixtures з ТОГО ж sprint можуть пройти бо їх теж зробили v4-layout, але production seeds/demo data з не-v4 UUID (e.g. `00000000-0000-0000-0000-000000000002`) ловлять 400 у dev. Grep: для кожного sprint-wide refactor — пройти ОБИДВА варіанти `@X()` і `@X(arg1, { each|message|... })`. Приклад для UUID: `grep -rn "@IsUUID(" apps/api/src/modules/ --include="*.dto.ts"` (NOT `@IsUUID('4')$`). Severity: HIGH коли блокує dev/seed workflow.

---

### §1.3 — Frontend (Next.js)

```bash
# .catch(() => {}) на fetch — ховає помилки
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx"

# loading оголошений але setLoading(true) відсутній
grep -rn "const \[loading.*false" apps/web/src/app --include="*.tsx" | head -10
# → для кожного перевірити чи є setLoading(true) перед fetch

# cancelled flag відсутній
grep -rn "useEffect" apps/web/src/app --include="*.tsx" -A 10 | grep "apiFetch\|apiMultipartFetch" | grep -v "cancelled\|mounted" | head -10

# Async-init Select race
grep -rn "value=\{form\." apps/web/src/app --include="*.tsx" | grep -v "//\|onChange" | head -20
# Для кожного — перевірити що опції завантажуються async і є sync useEffect автовибору

# SSR-safe date (new Date() у render = hydration mismatch)
grep -rn "new Date()\|Date\.now()" apps/web/src/app --include="*.tsx" | grep -v "useEffect\|getTime\|setDate\|//\|spec" | head -10

# key={i} у списках з filter/sort
grep -rn "key={i}\|key={index}" apps/web/src/app --include="*.tsx" | head -10

# apiFetch у PUBLIC_ROUTES сторінках (public pages мають publicFetch)
grep -rn "apiFetch\|apiBlobFetch" apps/web/src/app --include="*.tsx" | grep -E "booking|setup" | head -5

# React.X без named import
grep -rn "React\.\(ReactNode\|CSSProperties\|ChangeEvent\|MouseEvent\|FormEvent\)" apps/web/src/ --include="*.tsx" | grep -v "//\|spec" | head -10

# Timeline/drag px→time converter без clamp у видиме вікно → Invalid Date (Bug #157)
grep -rn "decimalHoursTo\|pxToHours\|pxToDecimal\|clientX.*-.*rect\|getBoundingClientRect" apps/web/src/app --include="*.tsx" -l | head -10
# → для кожного timeline/calendar/gantt: чи resize/drag clamp-ить результат у [WINDOW_START, WINDOW_END] ПЕРЕД new Date()
grep -rn "new Date(\`\${.*}T\${\|toISOString()" apps/web/src/app --include="*.tsx" | grep -iE "calendar|timeline|slot|gantt|schedule" | head -10

# Swallowed-fetch що годує ОБОВ'ЯЗКОВИЙ select / disabled-guard (Bug #159) — escalate severity
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx" -B3
# → для кожного: чи setX(...) у .then() рендериться у <Select required> АБО у disabled={!state}?
#   якщо так — порожня помилка блокує workflow без feedback (MEDIUM, не LOW)

# Мертвий стан/handler після рефактору inline→shared-component (Bug #160)
# для кожного useState/useCallback з префіксом фічі (woSearch/woOptions...) перевірити чи setter
# викликається ПОЗА reset-ефектом і чи value читається у JSX. tsc без noUnusedLocals НЕ ловить.
grep -rn "const \[\(wo\|cp\|search\|inline\)[A-Za-z]*," apps/web/src/app --include="*.tsx" | head -20

# apiFetch generic type mismatch — fetch<T[]> але endpoint повертає {items,total} (Bug #181)
# Стандарт STO ERP list endpoint = { items, total }. Виняток: /branches = bare array.
# Шукати apiFetch<X[]> де X — не пагінований примітив; перевірити контролер.
grep -rn "apiFetch<[A-Za-z]*\[\]>" apps/web/src/app --include="*.tsx" | grep -v "//\|spec" | head -20
# → для кожного: прочитати controller.ts endpoint — повертає масив чи {items,total}?
# Known bare-array endpoints: /branches (fbe66ad — спеціальний випадок, довідник)
# Known {items,total} endpoints: /brands, /goods, /pricing-rules, /work-orders, /invoices, /counterparties, ...

# FormData надсилається через apiFetch (а не apiMultipartFetch) → CRITICAL (Bug #197) — фіча мертва
# apiFetch ЖОРСТКО ставить Content-Type: application/json → browser НЕ може автоматично виставити multipart boundary
# → fastify-multipart кидає "the request is not multipart" → upload завжди валиться
grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx" | head -10
grep -rn "body: \(fd\|formData\)" apps/web/src --include="*.tsx" -B3 | grep -E "apiFetch\b" | head -10
# → кожен match — обов'язково замінити на apiMultipartFetch

# Next.js App Router error.tsx з bare `error: Error` без `& { digest?: string }` (Bug #206)
# Docs: https://nextjs.org/docs/app/api-reference/file-conventions/error
grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx" | grep -v "digest" | head -5

# Нова browser-API залежність без jsdom-стабу (Bug #177) → каскадне падіння всіх тестів які монтують shared-компонент
# tsc мовчить (типи в lib.dom.d.ts), prod працює (браузер має API), jsdom — НІ.
grep -rnE "new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver)\(|window\.matchMedia\(|navigator\.(clipboard|share|wakeLock|geolocation|mediaDevices)|crypto\.subtle|new Notification\(" apps/web/src/components/ui apps/web/src/app --include="*.tsx" -l | while read f; do
  # для кожного знайденого API — перевірити чи setup.ts його стабає
  for api in ResizeObserver IntersectionObserver MutationObserver PerformanceObserver matchMedia; do
    if grep -q "$api" "$f" && ! grep -q "$api" apps/web/src/__tests__/setup.ts; then
      echo "JSDOM STUB MISSING: $f uses $api but apps/web/src/__tests__/setup.ts does not stub it"
    fi
  done
done
```

- [ ] Кожен list-fetch в `useEffect` має: `let cancelled=false` + `return () => {cancelled=true}`; `setLoading(true)` перед; `.finally(() => !cancelled && setLoading(false))`; `.catch((e) => !cancelled && setError(...))`; у JSX `{loading && <Spinner/>}` + `{!loading && items.length===0 && <Empty/>}`
- [ ] `new Date()` у render path → `useState<Date|null>(null)` + `useEffect(() => setToday(new Date()), [])`
- [ ] `key={i}` у списках де можлива re-order/filter → `key={item.id}` або stable derived key
- [ ] PUBLIC_ROUTES (`/booking`, `/setup`, `/login`, `/403`) → `publicFetch`, не `apiFetch`
- [ ] `import type { ReactNode, ChangeEvent, MouseEvent } from 'react'` (не `React.ReactNode`)
- [ ] `setTimeout` / `setInterval` у `useEffect` → `clearTimeout` / `clearInterval` у cleanup
- [ ] Timeline/gantt drag/resize: кожен px→decimal-hours converter clamp-ить результат у `[WINDOW_START, WINDOW_END]` ПЕРЕД побудовою `new Date(...).toISOString()` (інакше `endH>maxHour`/`startH<0` → `"24:30"`/`"-1:00"` → Invalid Date → RangeError у `toISOString()` → handler мовчки падає). Resize-гілка ОКРЕМО від draw-гілки — draw зазвичай clamp-ить через `pxToDecimalHours`, resize рахує delta і clamp-ить тільки проти протилежного краю
- [ ] Swallowed-fetch що годує **обов'язковий** контрол → MEDIUM (не LOW): якщо `.catch(() => {})`/`.catch(noop)` ховає помилку завантаження списку, який рендериться у `<Select required>` або гейтить `disabled={!state}` submit-кнопку — порожній список = назавжди заблокований workflow без feedback. Фікс: `errorState` + inline `<p>` під контролом
- [ ] Мертвий стан після inline→shared-component рефактору: коли inline-патерн (dropdown/picker/search) замінюють на shared-компонент (`SearchPickerModal` тощо), старі `useState`/`useCallback`/`useRef` лишаються «сиротами». Ознака: setter викликається ТІЛЬКИ в reset-ефекті (`if (!open) setX('')`), а value НІКОЛИ не читається у JSX; handler (`searchX`) визначено але не викликано. `tsc` без `noUnusedLocals` мовчить. Видалити повністю (включно з cleanup-ефектом orphaned `timeoutRef`)
- [ ] **Next.js App Router convention-файли — точна сигнатура (Bug #206):** `app/**/error.tsx` має приймати `{ error: Error & { digest?: string }; reset: () => void }` — bare `Error` валідний у tsc але блокує майбутній моніторинг (Sentry/Datadog) що читає `error.digest`. Перевіряти сигнатуру кожного нового error.tsx проти Next.js docs (`https://nextjs.org/docs/app/api-reference/file-conventions/error`). Аналогічно для `layout.tsx` (`{ children, params }`), `page.tsx` (`{ params, searchParams }`), `loading.tsx` (no props). Grep: `grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx"` — кожен match без `digest` = Bug
- [ ] **Decorative SVG/icon без `aria-hidden="true"` (Bug #207):** SVG-іконки що дублюють semantic-сигнал поряд (warning-icon біля заголовка "Помилка", info-icon біля banner-тексту) → `aria-hidden="true"` обов'язково, інакше screen-reader озвучує "image" перед текстом. Іконки-кнопки без тексту → `aria-label` (вже у §1.7). Іконки з текстом-аналогом поряд → `aria-hidden="true"`
- [ ] **App Router convention-файли з інтерактивом (`useEffect`/`onClick`/`'use client'`) → парний `*.test.tsx` (Bug #208):** `error.tsx`/`not-found.tsx`/кастомний `global-error.tsx` потребують компонент-тестів. Шаблон: `apps/web/src/app/__tests__/error.test.tsx` — heading render, error.message render, fallback при empty, reset callback клік, navigate link/button, console.error effect, type-regression test (digest support), aria-hidden SVG. `loading.tsx` без логіки skip
- [ ] **FormData upload через `apiFetch` замість `apiMultipartFetch` (Bug #197) → CRITICAL**: `apiFetch` ЖОРСТКО додає `Content-Type: application/json` до КОЖНОГО запиту → коли тіло — `FormData`, browser НЕ може автоматично виставити правильний `multipart/form-data; boundary=...`. Сервер отримує binary FormData з JSON content-type → `fastify-multipart` кидає `the request is not multipart` → upload завжди валиться 400/406. **Фіча повністю мертва у проді.** Grep: `grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx"` — кожен match замінити на `apiMultipartFetch(path, formData)` (БЕЗ ручного `method: POST` — функція сама POST). Особливо при додаванні нової upload-фічі: «нагуглив схожий аплоад» → `apiFetch` looks similar → CRITICAL регресія
- [ ] **React Query cross-resource invalidation audit (Bug #210-#212):** для КОЖНОГО `await apiFetch(/X/:id/Y, { method: 'POST'|'PATCH'|'DELETE' })` у migrated page → прочитати **серверний** controller+service цього endpoint і знайти всі side-effect updates на ІНШИХ resource-ах: (1) `inventory.createMovement(...)` → invalidate `inventoryKeys.all`; (2) `workOrders.transition(...)` → invalidate `workOrdersKeys.all`; (3) `settlements.createTransaction(...)` → invalidate `counterpartiesKeys.all` (якщо list показує balance); (4) `priceHistory.create(...)` + `good.update({ salePrice })` → invalidate `inventoryKeys.all` / `goodsKeys.all`. Same-resource invalidation (own-keys.all) — звичайна; cross-resource — невидимий gap бо клієнт не знає що endpoint мутує сторонній resource. Не покладатись на `staleTime=30s` — користувач може мати другий tab з відповідним list-view або переходити швидше за staleTime. Grep: `grep -B2 -A5 "method: 'POST'\|method: 'PATCH'\|method: 'DELETE'" apps/web/src/app/<migrated-page>` → кожен endpoint pair-check проти `apps/api/src/modules/<resource>/<resource>.service.ts`. Severity: MEDIUM коли впливає на бізнес-метрику (залишки/ціни/балансу); LOW коли лише UX (new row не з'являється у list до router.back)
- [ ] **React Query migration completeness: mutation hooks експортовані але не використовуються (Bug #213):** після `feat(rq): migrate X` commits — grep usage `useXMutation`/`useDeleteX`/`useUpdateX` у `apps/web/src/app` (поза tests). Якщо count === 0 → migration зробила лише READ-path, WRITE-path лишається raw `apiFetch` + manual invalidate. Це **не runtime-bug**, але: (1) bundle bloat; (2) misleading commit-message; (3) maintenance burden (invalidation у двох місцях). Severity LOW; фікс: задокументувати у MemoryManual як known-state АБО видалити hooks; full migration = окремий sprint
- [ ] **React Query custom hook без `*.test.tsx` (Bug #214):** новий `apps/web/src/hooks/api/use*.ts` з `useQuery`/`useMutation` потребує парний `*.test.tsx`. Тести покривають: (1) queryKey factory ізоляція (різні фільтри → різні ключі); (2) enabled-gate (`employee=null` → no fetch); (3) URLSearchParams build (кожне опціональне поле → відповідний URL param АБО відсутній якщо false-y); (4) signal abort (apiFetch отримує signal). Шаблон: `useWorkOrders.test.tsx`. Mock `apiFetch` + `useAuth`. Не використовувати реальний `QueryClientProvider` — створити свіжий `QueryClient` per-test з `retry: false`. Без цих тестів — silent URL param drift (як 3d5136d repairCategory regression) пройде CI зеленим
- [ ] **UoM display-vs-base mismatch на submit (Bug #231):** будь-який `<Select>` що дозволяє перемикати UoM з recalc display quantity (Krok 5 patten: `coefficient` + `unitId` + `unitShortName` у local lines state) ОБОВ'ЯЗКОВО має у submit-функції конвертувати display→base: `quantity: parseFloat(l.quantity) * (l.coefficient || 1)` і `price: parseFloat(l.price) / (l.coefficient || 1)`. Display-transition formula `newDisplay = oldDisplay * oldCoeff / newCoeff` зберігає інваріант між двома UoMs, АЛЕ submit потребує **окремої** конверсії до base. Якщо submit шле `parseFloat(l.quantity)` як-є → backend (що очікує base units) отримує display value → silent data corruption у stock movement / payable / applyPricing. Видно ЛИШЕ коли coefficient != 1; happy-path з default UoM (coeff=1) — без регресії. Grep: `grep -rnE "quantity:\s*parseFloat\(l\.quantity\)[^*]" apps/web/src/app --include="*.tsx" -B5 | grep -B5 "coefficient"` — кожен match без `* coeff`/`* (l.coefficient` = CRITICAL bug. Backend пара: `inventory.createMovement(quantity: l.quantity)` без UoM-conversion — підтвердження що quantity ОЧІКУЄТЬСЯ у base units. Severity: CRITICAL (release-blocker)
- [ ] **Mass DTO field migration completeness — include audit (Bug #232):** додавання нового поля (`unitShortName`/`coefficient`) у `*.dto.ts` `LineResponseDto` + `toLineDto`-mapping без оновлення Prisma `include` queries → поле завжди undefined у API response. Розробник додав `select: { unitOfMeasure: { select: { shortName, coefficient } } }` у service X, забув у service Y. Grep: для кожного `unitShortName`/`coefficient`/інше нове DTO-поле — для кожного `prisma.X.findFirst/findMany/findFirstOrThrow/create/update` що повертається через `toLineDto`/`toDto` → перевірити що relevant `include` присутній. Pair-check: `grep -n "good?.unitOfMeasure" apps/api/src/modules/**/*.service.ts` (consumer) vs `grep -n "unitOfMeasure:" apps/api/src/modules/**/*.service.ts | grep -v ".dto.ts"` (producer/include). Якщо consumer-count > producer-count за модулем — bug. Severity: MEDIUM (data display, не runtime crash; але feature що додано саме для UX — мертвий)
- [ ] **Sub-resource default-flag mutation → parent-list staleness (Bug #226-#227):** для будь-якого sub-resource CRUD у modal-табі (`addX`/`setDefaultX`/`removeX` що викликають `/<parent>/:id/<sub>` ендпоінти) — pair-check проти backend service: чи endpoint виконує `prisma.<Parent>.update/updateMany({...})` (наприклад `Good.unitId` оновлюється коли default UoM змінюється)? Якщо так, success-handler frontend ОБОВ'ЯЗКОВО викликає `load()` для parent-table АБО invalidate `<parentKeys>.all`. Conditional: `addX` тільки коли `isFirst === true` (зчитати з backend → у response `created.isDefault`); `setDefaultX` завжди; `removeX` тільки якщо видаляли default (capture `wasDefault` перед DELETE). **Auto-promote next-default:** коли backend `removeX` логіка пише `findFirst({orderBy:createdAt asc}) + update({isDefault:true})` (наприклад `removeUoM` у `goods.service.ts`), оптимістичний `setModalXs(prev => prev.filter(...))` у клієнті НЕВІРНИЙ — replace optimistic filter на `refreshXs(parentId)` (race-guarded через існуючий reqRef). Grep: `grep -rn "apiFetch.*method:.*'POST\|PATCH\|DELETE'" apps/web/src/app --include="*.tsx" | grep -E "/uoms|/barcodes|/categories|/tax-rates|/warranties|/contacts|/services"` — pair-check проти backend. Severity: MEDIUM коли стале значення впливає на бізнес-сприйняття; HIGH коли стале значення гейтить наступну дію

---

### §1.4 — Security (FULL режим)

```bash
# SSRF guard на webhook/external URL
grep -rn "validatePublicUrl\|url-guard" apps/api/src/modules/ --include="*.ts" | grep -v spec | head -10

# fetch без redirect: 'manual' на user-supplied URL
grep -rn "fetch(.*url\|fetch(dto\." apps/api/src/modules/ --include="*.ts" | grep -v "redirect:\|spec" | head -5

# @IsArray без @ArrayMaxSize
grep -rn "@IsArray()" apps/api/src/modules/ --include="*.dto.ts" -A 2 | grep -v "ArrayMaxSize" | head -10

# @IsString без @MaxLength (DoS)
grep -rn "@IsString()" apps/api/src/modules/ --include="*.dto.ts" | grep -v "MaxLength\|IsIn\|IsEmail\|IsUrl\|Matches\|spec" | head -20
```

- [ ] User-supplied URL що server fetch-ить → `validatePublicUrl()` (`apps/api/src/common/utils/url-guard.ts`)
- [ ] `fetch(userUrl)` → `{ redirect: 'manual' }` + перевірка 3xx → block
- [ ] `@IsArray()` → `@ArrayMaxSize(N)` (N = реалістичний бізнес-ліміт)
- [ ] Вільний `@IsString()` → `@MaxLength(N)` (anti-DoS)
- [ ] `@IsIn(['A','B','C'])` для union-string типів (`'OK' | 'WARN' | 'CRITICAL'`)

---

### §1.5 — Тест-покриття Backend

```bash
# Contract тести
find apps/api/src -name "*.contract.spec.ts" | sort

# Property-based тести
find apps/api/src -name "*.invariants.spec.ts" | sort

# Unit тести нових сервісів
git diff HEAD --name-only | grep "service.ts" | while read f; do
  spec="${f%.ts}.spec.ts"
  [ -f "$spec" ] && echo "OK: $spec" || echo "MISSING spec: $spec"
done

# Стала spec після рефактору — нова constructor-залежність не замокана у TestingModule
# (NestJS DI fail "Nest can't resolve dependencies ... at index [N]")
for svc in $(git log --oneline -10 --name-only | grep "service.ts$" | sort -u); do
  spec="${svc%.ts}.spec.ts"
  [ -f "$spec" ] || continue
  # кожен private readonly у конструкторі сервісу має бути provided у спеці
  deps=$(grep -oE "private readonly [a-zA-Z]+: [A-Z][a-zA-Z]+" "$svc" | grep -oE ": [A-Z][a-zA-Z]+" | tr -d ': ')
  for d in $deps; do
    grep -q "$d" "$spec" || echo "STALE SPEC $spec: missing provider/mock for $d (constructor dep of $svc)";
  done
done

# Застарілий mock-call-count: сервіс спрощено до 1 findFirst, але spec мокає двічі
grep -rn "mockResolvedValueOnce(null)" apps/api/src --include="*.spec.ts" -A1 | grep "mockResolvedValueOnce" | head -10
# → для кожного звірити кількість findFirst у відповідному service.create()/update()

# Query-shape фікс (relation-ім'я / nested where) БЕЗ service-spec (Bug #163)
# fix-commit що змінює relation-ім'я або форму вкладеного where → contract spec мокає сервіс → НЕ ловить
git log --oneline -15 | grep -iE "PrismaClientValidationError|relation|nested|where|search|q=" | head
# для кожного fix що чіпав where/include/relation: чи є service-spec що асертить реальний where через Prisma-мок?
for svc in $(git log --oneline -15 --name-only | grep "service.ts$" | sort -u); do
  spec="${svc%.ts}.spec.ts"
  if grep -lq "PrismaService, useValue: {}" "${svc%/*}"/*.contract.spec.ts 2>/dev/null && [ ! -f "$spec" ]; then
    echo "QUERY-SHAPE GAP: $svc змінено, contract мокає сервіс, service-spec відсутній";
  fi
done
```

**Стала spec після рефактору сервісу (Bug #153-#155):**

- [ ] Кожен `private readonly X: Type` у конструкторі сервісу → є `{ provide: Type, useValue: mock }` у `Test.createTestingModule({ providers })` спеки (інакше NestJS DI fail на всіх тестах файлу)
- [ ] Кеш-мок: `CacheService.get` → `mockResolvedValue(null)` (cache miss → fallthrough на БД); `set/del/delPattern` → no-op
- [ ] Якщо `service.create()/update()` спрощено з N `findFirst` до 1 (single round-trip resurrection/dup-check) → spec мокає `findFirst` РІВНО стільки разів скільки реальних викликів (не успадкований `mockResolvedValueOnce(null).mockResolvedValueOnce(...)`)
- [ ] **Defense-in-depth status guard + stale fixtures (Bug #200):** review-фікс додав `if (entity.status !== ALLOWED_A && entity.status !== ALLOWED_B) throw BadRequestException(...)` у сервісі, але парний spec мокає `findFirst` БЕЗ поля `status` → undefined ≠ ALLOWED → guard кидає на ВСЕ існуючих тестах → release-blocker baseline. Grep: `grep -n "findFirst.mockResolvedValueOnce({" *.spec.ts` → для кожного мока у сервісі що додав status guard → перевірити чи fixture містить `status: <ALLOWED_STATUS>`. Якщо нове guard перевіряє додаткові поля (deletedAt, isActive, ownerId) — той самий патерн. Профілактично після кожного review-commit що додав early-throw guard у service.X — пройти всі `findFirst.mockResolvedValueOnce(...)` у відповідній spec і додати потрібні поля.
- [ ] **Refactored public method usage + stale mock (Bug #200):** рефактор сервісу замінив виклик `private/inline X()` на нову public method `Y()` (наприклад `calculateSalePrice` → `getActiveRulesForOrg + computePriceFromRules`). Парний spec ще мокає СТАРИЙ виклик (`pricingService.calculateSalePrice.mockResolvedValueOnce(...)`) — тест проходить **випадково** бо `Y` не викликається насправді. Регресія: майбутній рефактор поверне виклик `X` → тест зелений але реальна логіка зламана. Grep: `git diff HEAD~1 -- service.ts` шукає `+ this.X.Y(` + перевірити що spec мок названо `Y` а не `Z`. Принцип: spec повинна мокати ТЕ ЩО СПРАВДІ викликається — не успадковане.

**Query-shape фікс потребує service-spec, не contract-spec (Bug #163):**

- [ ] Fix що змінив **relation-ім'я** (`customerGarage`→`customerGarages`), **форму вкладеного `where`** (`some`/`every`/nested `OR`), `include`/`select` shape, або `mode: 'insensitive'` → це **runtime `PrismaClientValidationError`**, який mock-based contract spec (`{ provide: Service, useValue: serviceMock }`) НЕ виконує. Потрібен **service-spec** який будує реальний `where` через `{ provide: PrismaService, useValue: { model: { findMany: vi.fn() }, $transaction: ops => Promise.all(ops) } }` і асертить форму `findMany.mock.calls[0][0].where` (правильні relation-імена + nested `deletedAt: null` + tenant `orgId`). Перевіряти ОБИДВА напрями: правильне ім'я присутнє AND singular/старе ім'я відсутнє

**Обов'язкові contract тести для нових endpoints:**

- `GET /X` → 200 + `{ items, total }`; 401 без токена
- `POST /X` без обов'язкових полів → 400
- `PATCH /X/:id` з чужим orgId → 404

**Обов'язкові unit тести:**
| Сервіс | Критичні кейси |
|---|---|
| `work-orders.service` | create→DRAFT; FSM invalid→throws; IN_PROGRESS→RESERVATION; COMPLETED→WRITEOFF+CHARGE |
| `inventory.service` | RECEIPT +qty; RESERVATION -available; WRITEOFF insufficient→throws; qty=0→throws |
| `settlements.service` | CHARGE +balance; PAYMENT -balance; no account→NotFoundException |
| `auth.service` | login OK; wrong password→401; deleted employee→401; invalid refresh→401 |
| `pricing.service` COST_TIER | tiers=[]; cost=0; cost===tier.costMax (boundary half-open); cost<минімального costMin |

- [ ] Нові `*.service.ts` → парний `*.spec.ts` з мінімальними кейсами вище
- [ ] Нові `@Controller` → парний `*.contract.spec.ts`
- [ ] **Boundary-кейси для діапазонних правил (COST_TIER, sliding-scale, age-brackets, tax-brackets):** будь-яке правило з `min <= x < max` (або `<=`/`>=`) має тести точно НА межі (`x === min`, `x === max`), на нулі (`x === 0`), і за межами (`x < минімум`, `x > максимум`). Реалізація працює, але регресія `<=`/`<` беззвучно змінить semantics — рідко-проходимий код. Boundary-тест документує contract і ловить інверсію оператора (Bug #184)
- [ ] **Cross-tenant FK contract test для optional FK у payload:** якщо контролер валідує optional FK через `findFirst({id, orgId})` перед write (Bug #161 патерн) → contract spec має асертити: (а) POST з FK з ЦІЄЇ org → 201 + `findFirst` викликаний з правильним `{id, orgId, deletedAt:null}`; (б) POST з FK з ЧУЖОЇ org → 404 + `create` НЕ викликаний; (в) PATCH з FK з ЧУЖОЇ org → 404 + `update` НЕ викликаний. Без цих тестів регресія (видалення org-scoped перевірки під рефактор) пройде CI зеленою → cross-tenant linkage у проді без error (Bug #186)

---

### §1.6 — Frontend тест-покриття (FULL режим)

```bash
# Component тести
find apps/web/src -name "*.test.tsx" | sort

# E2E тести
find apps/web/e2e -name "*.spec.ts" | sort

# Playwright config
test -f apps/web/playwright.config.ts && echo "playwright OK" || echo "playwright MISSING"
```

- [ ] `Button`, `Select`, `Modal`, `Input`, `EmptyState`, `ModalTabs` — component тести існують
- [ ] Кожен **новий shared UI-компонент** (`components/ui/`) → парний `*.test.tsx` (render, інтерактив-стани, edge: порожні дані/`null`-render, badge з `0`)
- [ ] Кожен **новий custom hook** (`apps/web/src/hooks/use*.ts`) що містить `useEffect`/`useState` АБО викликає `apiFetch`/`localStorage`/`fetch` → парний `*.test.tsx` (renderHook + act). Шаблон: `useSavedFilters.test.tsx`. Обов'язкові кейси: початковий стан → loading; resolve API → setState; reject API → error/fallback; cleanup на unmount; race-protection (AbortController/cancelled-flag); різні pageKey/instance ізольовані. Бо hook керує persistence/network — регресія без тесту мовчки втрачає дані. tsc не ловить runtime-race, code review не ловить (locally виглядає валідно), баг виявиться лише через user-bug-report (Bug #185)
- [ ] `smoke.spec.ts` — обов'язковий: `/`, `/login`, `/setup` без auth, auth redirect
- [ ] **Component-vs-test drift:** якщо component-тест падає у baseline на `getByText(...)`/`getByRole(...)` — звірити чи компонент реально рендерить цей елемент. Тест може документувати UX-намір, від якого компонент розійшовся (видалили hint/label). Якщо намір легітимний → виправити КОМПОНЕНТ (повернути елемент); якщо застарів → виправити тест. НЕ ігнорувати «червоне і так було»
- [ ] **Новий optional boolean prop у existing UI component (Bug #194):** будь-який diff що додає `propX?: boolean` до `InterfaceProps` у `components/ui/*.tsx` → парний `*.test.tsx` має МІНІМУМ 2 кейси для цього prop: (а) inverse-стан (`propX=true`) активує/блокує очікувану поведінку; (б) inverse-стан **не зачіпає інших елементів** (захист від занадто-широкого guard, copy-paste помилок). Default-стан зазвичай покрито existing-тестами, але inverse-стан без явного тесту = «mute regression»: інверсія guard (`!hideX` → `!!hideX`, `showX` → `!showX`) проходить зеленою. Особливо критично для prop, що впроваджується для увімкнення нового UX-режиму у N сторінках одночасно (як `hideSaveButton` у 8 page.tsx) — інверсія ламає UX на всіх 8 одночасно. Grep: `grep -nE "^\s+\w+\?: boolean" apps/web/src/components/ui/*.tsx` після diff
- [ ] **jsdom browser-API стаби в `apps/web/src/__tests__/setup.ts`:** якщо diff чіпає `components/ui/` АБО `app/**/page.tsx` і додає `new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver)\(`, `window.matchMedia(`, `navigator.(clipboard|share|wakeLock|geolocation|mediaDevices)`, `crypto.subtle`, `Notification(` — перевірити що setup.ts стабає це API. tsc мовчить (типи у `lib.dom.d.ts`), prod працює (браузер має API), але jsdom падає → каскадне падіння всіх тестів які монтують компонент (включно з тестами далеких компонентів якщо shared-компонент усередині них). Фікс: noop-стаб під guard `typeof globalThis.X === 'undefined'`. Не стабати в самому компоненті, не вимикати тест

---

### §1.7 — Accessibility та i18n (FULL режим)

```bash
# Іконкові кнопки без aria-label
grep -rn "<Button\b\|<button\b" apps/web/src/ --include="*.tsx" | grep -E "Icon|lucide|Trash|Pencil|Eye" | grep -v "aria-label\|aria-describedby\|sr-only\|spec" | head -15

# onClick на не-інтерактивних елементах
grep -rn "onClick" apps/web/src/ --include="*.tsx" | grep -E "<div|<span|<p " | grep -v "role=" | head -10

# Англійські placeholder
grep -rn "placeholder=" apps/web/src/ --include="*.tsx" | grep -E '"[A-Z][a-z]' | head -10

# Англійські exception messages
grep -rn "throw new.*Exception\|throw new.*Error" apps/api/src/modules/ --include="*.ts" \
  | grep -E "['\"](Cannot|Invalid|Not found|Already|Forbidden)" | grep -v spec | head -10

# Формат дати: toISOString у render path
grep -rn "toISOString\|toLocaleDateString" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|split\|//\|spec" | head -10
```

- [ ] Іконкові кнопки (без тексту) → `aria-label="Дієслово"`
- [ ] `onClick` на `<div>`/`<span>` → `role="button"` + `tabIndex={0}` + `onKeyDown`
- [ ] Всі placeholder → кирилицею (`Введіть...`, не `Enter...`)
- [ ] Всі `throw new XxxException(...)` → українською
- [ ] Дати у форматі `DD.MM.YYYY` (date-fns `uk` або `toLocaleDateString('uk-UA')`)
- [ ] Тиждень починається з понеділка (`weekStartsOn: 1`)

---

## Крок 2 — Фіксація в BUG_REPORT.md

Записуй **зразу після аналізу**, до виправлень:

```markdown
# BUG_REPORT.md — STO ERP

Дата: YYYY-MM-DD
Сесія: <коротко що тестувалось>

---

## Bug #N — [CRITICAL|HIGH|MEDIUM|LOW] Заголовок

**Файл:** `apps/api/src/modules/X/X.service.ts:145`
**Severity:** CRITICAL | HIGH | MEDIUM | LOW
**Категорія:** business-logic | security | typescript | frontend | test-coverage

**Опис:** Що не так і чому це баг.
**Очікувана поведінка:** Що має бути.
**Фактична поведінка:** Що є зараз.
**Статус:** [ ] відкритий / [x] виправлено
```

**Severity:**

- `CRITICAL` — втрата даних, неправильні фінанси, cross-tenant витік
- `HIGH` — порушення бізнес-правила (FSM, резерви), security
- `MEDIUM` — TypeScript помилка, відсутній тест критичної гілки
- `LOW` — UI стан (loading/empty), незручність

---

## Крок 3 — Автоматичне виправлення

```
Для кожного Bug #N (від CRITICAL до LOW):
  1. Прочитай файл з багом
  2. Застосуй мінімальний точковий фікс (не рефактор)
  3. pnpm --filter <package> exec tsc --noEmit → 0 errors
  4. Якщо відсутній тест → додай кейс у .spec.ts
  5. Відмітити [x] у BUG_REPORT.md
  6. git add <змінені файли> && git commit -m "fix(tester): Bug #N — <заголовок>"

Після останнього Bug:
  7. Оновити MemoryManual.md — одразу, без запиту
```

**Правила:**

- Мінімальний diff — не чіпай нічого крім проблемного місця
- Фікс потребує міграції БД → CRITICAL, повідоми користувача
- Фікс потребує змін у `@sto/shared` → оновлюй синхронно

---

## Крок 4 — Верифікація

```bash
# TypeScript — 0 errors
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/web exec tsc --noEmit --incremental false
pnpm --filter @sto/shared exec tsc --noEmit

# Unit тести
pnpm --filter @sto/api test --run 2>&1 | tail -30

# Build
pnpm --filter @sto/api build 2>&1 | tail -10

# Contract тести
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "contract|PASS|FAIL"
```

---

## Крок 5 — Розширені тести (FULL режим)

### 5.1 — Property-based (fast-check)

```bash
grep "fast-check" apps/api/package.json || pnpm --filter @sto/api add -D fast-check
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "invariant|property|PASS|FAIL"
find apps/api/src -name "*.invariants.spec.ts" | sort
```

| Модуль            | Інваріанти                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `work-orders.fsm` | всі пари (from, to) → blocked; ARCHIVED/CANCELLED = порожні                   |
| `inventory`       | quantity≥0, reserved≥0, available≥0 після валідних рухів                      |
| `settlements`     | CHARGE ↑balance; PAYMENT/REFUND/CREDIT_NOTE ↓balance                          |
| `pricing`         | PERCENT = `cost*(1+pct/100)`; округлення кратне roundTo; `Math.max(0,result)` |

### 5.2 — E2E (Playwright)

```bash
# Перевірити dev-сервери
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|redis|minio"
curl -s http://localhost:3000/api/docs > /dev/null && echo "API:UP" || echo "API:DOWN"
curl -s http://localhost:3001 > /dev/null && echo "WEB:UP" || echo "WEB:DOWN"

# Якщо API:DOWN
pnpm --filter @sto/api dev > /tmp/sto-api-dev.log 2>&1 &
until curl -s http://localhost:3000/api/docs > /dev/null; do sleep 3; done && echo "API ready"

# Запуск
test -f apps/web/playwright.config.ts && \
  pnpm --filter @sto/web exec playwright test --reporter=list 2>&1 | tail -40 || \
  echo "⏭ Playwright не встановлений"
```

**⚠️ STALE DEV API = false-positive.** `404 "Cannot GET /api/X"` при роботі routes у коді = stale server (не перезапущений після нового модуля). Діагностика: `curl localhost:3000/api/<route>` → 404 = stale; 401 = route OK (auth). Фікс: вбити процес на порту 3000 і перезапустити.

### 5.3 — Component-тести (Testing Library)

```bash
grep "@testing-library" apps/web/package.json || \
  pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
find apps/web/src -name "*.test.tsx" | sort
pnpm --filter @sto/web exec vitest run --reporter=verbose 2>&1 | tail -30
```

---

## Крок 6 — Commit + MemoryManual.md

```bash
git add apps/ packages/ BUG_REPORT.md
git commit -m "fix(tester): <короткий підсумок всіх багів>"
```

Оновити `MemoryManual.md`:

```markdown
## Останній commit

<hash> fix(tester): <message>
Дата: YYYY-MM-DD
Latest tester: YYYY-MM-DD (<режим>, HEAD <hash>) — <N> баги: <перелік>.

## Поточний стан проєкту

TypeScript: ✅ 0 errors
Unit+Contract: ✅ N/N passed
Property-based: ✅ N passed (або ⏭ fast-check не встановлений)
Components: ✅ N passed (або ⏭ @testing-library не встановлений)
E2E (Playwright):✅ N passed (або ⏭ Playwright не встановлений)
```

---

## Крок 7 — Самовдосконалення (ОБОВ'ЯЗКОВО після кожного запуску)

Після виправлення кожного Bug #N — запитай себе:

> **"Цей баг передбачений існуючим пунктом §1.1–§1.7?"**

Якщо **НІ** — одразу оновити цей файл:

1. Додати новий пункт у відповідний розділ з grep-командою
2. Записати підхід у "Накопичені підходи" нижче
3. Commit: `docs(skills): add <баг> to sto-tester checklist`

**Що записувати:**

- Новий **тип бага** якого не було в чеклісті
- Новий **grep-сигнал** для автовиявлення
- **Причину** чому баг виникає (щоб знати де шукати наступного разу)
- **Severity** для калібрування пріоритетів

**Не записувати:** конкретні файли/рядки (вони змінюються); ready-made фікси (для цього є Крок 3).

### Формат запису

```
### [Дата] — [Тип бага] — [Область: backend / frontend / db / security]

**Сигнал:** ознака за якою баг можна знайти або відтворити
**Причина виникнення:** типова помилка розробника або edge case
**Підхід до виявлення:** загальний принцип пошуку (не grep, не файл)
**Підхід до фіксу:** загальний принцип виправлення
**Severity:** CRITICAL / HIGH / MEDIUM / LOW
**Де шукати ще:** суміжні модулі де той самий патерн може повторитись
```

---

## Накопичені підходи (оновлюється автоматично)

### 2026-05-31 — DTO write-side asymmetry: column declared, FSM transition не persists її у row (Bug #236) — backend, data-integrity, state-machine

**Сигнал:** sprint додає nullable FK/scalar колонку у `*.prisma` модель + `unitOfMeasureId?: string | null` у `XLineResponseDto` + mapping `unitOfMeasureId: l.unitOfMeasureId ?? null` у `toDto`. FSM transition (CONFIRMED, RECEIVED, IN_PROGRESS) обчислює resolved value (`lineUnitId = good.unitId`) і пропагує його у **side-effect resource** (StockMovement через `inventory.createMovement(unitOfMeasureId)`), АЛЕ забуває оновити **сам поточний row** (`tx.stockDocumentLine.update({ data: { unitOfMeasureId: lineUnitId } })`). Симптом: `findOne(id)` ПІСЛЯ transition повертає `lines[i].unitOfMeasureId === null` навіть коли StockMovement рядки мають коректне значення. tsc green (поле nullable, no compile pressure), unit tests green (немає spec для transition), code review зосереджується на side-effect (movement) а не на самому row. **Cross-resource inconsistency**: history (movements) має X, current state (line.row) має NULL → audit/sync/export ламається.

**Причина виникнення:** symmetric до Bug #232 (read-side: column declared у DTO, але Prisma `include` не fetch-ить — DTO віддає undefined). Write-side версія: розробник пише код side-effect rich operation і думає що головне — створити правильний StockMovement (це йде у history, append-only). Сам "owner" rowу (StockDocumentLine, PurchaseOrderLine) — це **поточний стан**, його теж треба оновити при transition. Логіка створення rowу (create) уже встановлювала всі поля одразу (тоді колонки ще не існували — backward compat), тому write-path не звичний. SKILL Bug #232 фікс додав `include` у read path; write path лишився непокритий.

**Підхід до виявлення:** на Кроці 1 §1.1 — для будь-якого diff що додає nullable колонку у row-модель (`PurchaseOrderLine`, `StockDocumentLine`, `InvoiceLine`, `WorkOrderPart`) і **mapping `l.<field> ?? null` у toDto**:

1. Знайти всі FSM transitions для цієї моделі (`transition(CONFIRMED|RECEIVED|IN_PROGRESS)`, `receive()`, `applyPricing()`, …).
2. Для кожної — у тілі циклу `for (const line of doc.lines)` шукати чи resolved value (наприклад `lineUnitId = good.unitId`) пишеться у `tx.<row>.update({ data: { <field> } })`. Якщо передається лише у side-effect resource (`inventory.createMovement(<field>)`) — bug.
3. Особлива увага: створення row через `create`/`createMany` без поля (поле залишається NULL) + transition не оновлює → row назавжди NULL.

Grep-сигнатура (по diff):

```bash
# Знайти всі toDto що мапять l.<field> ?? null без update у transition
grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"
# Для кожного — у тому ж файлі знайти transition/receive/transitionToConfirm:
grep -B5 "stockMovement.create\|inventory.createMovement\|workOrderPart.update" apps/api/src/modules/<module>/<module>.service.ts | grep -v "tx\.<row>\.update"
```

Property-test invariant: ПІСЛЯ transition `findOne(id).lines.every(l => l.unitOfMeasureId === movements[lineIdx].unitOfMeasureId)`.

**Підхід до фіксу:** у `for (const line of doc.lines)` циклу transition додати explicit `update` для самого row перед/після side-effect:

```ts
if (resolvedValue) {
  await tx.<row>.update({
    where: { id: line.id },
    data: { <field>: resolvedValue },
  });
}
```

Guard `if (resolvedValue)` пропускає null no-op коли fallback не знайшов значення. Розмістити після всіх side-effect creates (StockMovement) у тому ж блоці — атомарно у $transaction. **Не** робити окремий повторний цикл (зайвий round-trip + race-window). Якщо decision-table велика — окремий helper `await updateLineWithUom(tx, line.id, resolvedValue)`.

**Severity:** HIGH — silent data integrity gap (UI/PDF/sync/audit показує NULL замість коректного UoM). Cross-resource consistency порушено (StockMovement.uomId ≠ StockDocumentLine.uomId). Дані у БД технічно "коректні" (NULL = backward-compat allowed), але feature що додавалась саме для display/audit — **мертва на write-path**.

**Де шукати ще:** будь-який майбутній sprint що додає nullable колонку у row-модель з FSM transitions:

- `WorkOrderPart.unitOfMeasureId` (якщо колись додасться) → transition(COMPLETED) має пропагувати у row;
- `InvoiceLine.discountAppliedAmount` → transition(PAID) має зафіксувати застосовану знижку у row;
- `BatchConsumption.consumedAt` → confirm-consumption має зафіксувати у row;
- будь-який field з patterns "resolved при transition", "computed на CONFIRMED", "applied at FSM event".

Профілактика: SKILL §1.1 тепер вимагає write-path audit для кожної nullable колонки що з'являється у `toDto` маппінгу — не лише read-path `include` (Bug #232).

---

### 2026-05-31 — UoM/coefficient conversion missing на submit (Bug #231) — frontend, business-logic, data-corruption

**Сигнал:** фронт-формула `newQty = currentQty * (oldCoeff / newCoeff)` при переключенні Select UoM (Krok 5 patten) **зберігає інваріант** `qty_base = display × coeff` у локальному state, але `handleCreate` / submit-функція шле `parseFloat(l.quantity)` як-є — БЕЗ множення на `coefficient`. Backend очікує quantity у **базових одиницях** Good (`Good.unit`), а отримує display-value у обраній UoM → silent data corruption: stock movement, payable, applyPricing — все спотворюється на множник coefficient. Видно ЛИШЕ коли користувач реально перемикає UoM (coeff != 1); coeff = 1 (default UoM, або відсутні UoMs) — happy-path працює, регресія приходить у прод коли власник СТО заводить реальні UoMs. tsc green, unit tests green, ручне QA з default UoM green.

**Причина виникнення:** Krok 5 спека описує лише **display-transition formula** ("newQty = currentQty * oldCoeff/newCoeff"). Розробник реалізує саме її і додає коментар `// Перерахована кількість з урахуванням коефіцієнта` думаючи що formula виконує **і** display-перехід **і** display→base конверсію. Але формула — це маса-балансна формула між двома UoMs (qty1*coeff1 = qty2*coeff2 при коефіцієнтах base_units_per_uom), вона **не зводить до base unit** — вона зберігає інваріант. Submit потребує **окремої** конверсії `qty_base = display * coeff` АБО backend має зберігати UoM ID разом з quantity і конвертувати на stock-movement. Спека "Backend отримує тільки перераховану quantity, без unitId" → frontend MUST конвертувати.

**Підхід до виявлення:** на Кроці 1 §1.1 / §1.3 — для будь-якого UoM/unit-conversion patten (Select з coefficient, custom unit picker) перевірити **обидва кінця**:

1. **Display transition** (Select onChange): formula `newDisplay = oldDisplay * oldCoeff / newCoeff` — invariant preservation. ✓
2. **Submit conversion** (handleCreate/save): чи `parseFloat(displayQty) * coefficient` подається у API (база units)? Якщо submit шле raw display value БЕЗ множення — **data corruption**.

Grep-сигнатура: для UoM-aware Select-fields знайти submit-функцію та перевірити чи `quantity * coefficient` обчислюється:

```bash
# 1. Знайти всі local state з UoM-fields (coefficient + display quantity у одному рядку)
grep -rn "coefficient:\s*number\|coefficient:\s*1\b" apps/web/src/app --include="*.tsx" -l

# 2. Для кожного — знайти submit-функцію (handleCreate/handleSave/handleSubmit) і перевірити mapping
grep -rn "handleCreate\|handleSave\|handleSubmit" apps/web/src/app --include="*.tsx" -l | xargs grep -l "coefficient"

# 3. Червоний прапор: parseFloat(l.quantity) у submit БЕЗ * coefficient — баг
grep -rn "quantity:\s*parseFloat" apps/web/src/app --include="*.tsx" -B5 | grep -B5 "coefficient" | grep -v "coefficient ||\|\* coeff\|\* (l\.coefficient"
```

Property-test invariant: для будь-якої комбінації (qty, coeff) ∈ [0.001, 10000] × [0.001, 1000] — `submit_quantity = display_quantity * coefficient` повинен зберігати інваріант з backend's expected base-unit value. Перевіряти і `price`: backend's expected price-per-base-unit = display_price / coefficient.

**Підхід до фіксу:** у submit-функції додати explicit конверсію:

```ts
const coeff = l.coefficient || 1;
const displayQty = parseFloat(l.quantity);
const displayPrice = parseFloat(l.price);
return {
  goodId: l.goodId,
  quantity: displayQty * coeff, // base units
  price: displayPrice / coeff, // per base unit
};
```

`totalAmount` зберігається (qty_base × price_base = qty_display × price_display). Backward-compat: coeff=1 → ідентична поведінка. Якщо backend має RECEIVE-form чи інші surface-ди що приймають qty без UoM — узгодити їх теж на base unit.

**Severity:** CRITICAL (data corruption у stock-движенні, неможлива partial fulfillment-tracking, applyPricing з невірним cost-per-unit) — release-blocker.

**Де шукати ще:** будь-який form/modal у `apps/web/src/app/` що:

1. Має `coefficient: number` + `unitId: string` + `unitShortName: string` поля у local lines state;
2. Має `<Select>` що дозволяє перемикати UoM з recalc display quantity;
3. Має submit-функцію що мапить `validLines` → API payload.

Конкретно: `purchase-orders/page.tsx`, `stock-documents/page.tsx`, потенційно `work-orders/page.tsx` (parts-tab), `invoices/page.tsx` (якщо колись додасться UoM Select у line-form), POS / Кас mobile/web — будь-який surface що бере display-qty і шле у API.

---

### 2026-05-31 — Prisma schema mutation без парного migration (Bug #220) — database, release-blocker, schema-migration

**Сигнал:** commit з `feat(X)` що додає або змінює модель у `packages/database/prisma/schema.prisma` (нова `model X { ... }`, додатковий field у існуючій моделі, новий `@@unique`/`@@index`) АЛЕ **не створює** парного SQL-файлу у `packages/database/prisma/migrations/<timestamp>_X/migration.sql`. tsc green (Prisma client типи генеруються з schema, не з applied DB schema), unit tests green (vi.fn() mocks не торкаються DB), API webpack build green. У runtime — `PrismaClientKnownRequestError P2021` ("The table `X` does not exist") при першому виклику нового endpoint. Прикладий випадок STO ERP: `0227c44 feat(uom): krok 1+2 — GoodUoM model + /goods/:id/uoms CRUD endpoints` додав `model GoodUoM { ... }` (18 рядків у schema) + 113 рядків service-логіки + 54 рядки controller, але міграцію забув — таблиця `good_uom` не існує у БД.

**Причина виникнення:** Prisma toolchain розділяє **declarative schema** (`schema.prisma`) і **applied migrations** (`migrations/*.sql`). Розробник у момент дизайну фічі думає у термінах schema (Prisma client автоматично типизує `prisma.goodUoM.findMany()` після `prisma generate`), забуває що це **TypeScript-only ефект**. CI/dev workflow зазвичай має `prisma migrate dev` команду яка автоматично генерує migration від schema diff, але у безперервній CI/auto-mode розробника-AI ця команда не запускається (бо потребує live DB connection + interactive prompt для імені migration). Закомічено лише `schema.prisma` → reviewer (включно з sto-review) перевіряє правильність моделі, бачить індекси і FK у schema → схвалює → release-blocker проходить.

**Підхід до виявлення:** на Кроці 1 §1.1 — для кожного commit що зачіпає `packages/database/prisma/schema.prisma`, перевірити `git diff HEAD~N HEAD -- packages/database/prisma/`:

```bash
# Якщо schema.prisma додав/змінив модель → має бути новий каталог у migrations/
schema_changes=$(git diff HEAD~3 HEAD --name-only -- packages/database/prisma/schema.prisma)
new_migrations=$(git diff HEAD~3 HEAD --name-only --diff-filter=A -- packages/database/prisma/migrations/)
if [ -n "$schema_changes" ] && [ -z "$new_migrations" ]; then
  echo "BUG: schema.prisma modified but no new migration directory created"
fi

# Конкретніше: кожна нова `model X` у schema → grep у migrations/ за CREATE TABLE "x_table"
grep -E "^model [A-Z]" packages/database/prisma/schema.prisma | awk '{print $2}' | while read model; do
  # convert PascalCase to snake_case (rough heuristic — better to check @@map)
  table=$(echo "$model" | sed 's/\([A-Z]\)/_\L\1/g' | sed 's/^_//')
  if ! grep -rq "CREATE TABLE.*\"$table\"\|CREATE TABLE.*${model}" packages/database/prisma/migrations/; then
    echo "POSSIBLE MISSING MIGRATION: model $model has no CREATE TABLE in migrations/"
  fi
done
```

**Підхід до фіксу:** створити вручну `packages/database/prisma/migrations/<YYYYMMDDHHMMSS>_<feature>/migration.sql` з:

1. `CREATE TABLE "table_name" (...)` — всі колонки з schema, дефолти, `NOT NULL` де треба;
2. `CREATE UNIQUE INDEX` для кожного `@@unique([...])` (з суфіксом `_key` за конвенцією Prisma);
3. `CREATE INDEX` для кожного `@@index([...])` (з суфіксом `_idx`);
4. `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ... ON DELETE X ON UPDATE Y` для кожного `@relation` — cascade тільки для child-таблиць parent→child (наприклад `goodId` ON DELETE CASCADE), `ON DELETE RESTRICT` для довідникових relations (`unitOfMeasureId` — не можна видалити одиницю якщо хтось її використовує).

Шаблон копіюється з найближчого попереднього migration з аналогічним relation pattern (`grep -l "<related_table>" packages/database/prisma/migrations/*/migration.sql`).

**НЕ запускати `prisma migrate dev`** — це **side-effect** (auto-apply до dev DB + перегенерація client + auto-name через interactive prompt). У AUTO-режимі агенту краще вручну писати SQL і покладатись на наступний deploy щоб `prisma migrate deploy` його застосував.

**Severity:** CRITICAL — release-blocker. Фіча мертва у runtime; unit tests з mocks не ловлять; smoke-test через curl показує 500 на першому ж API call.

**Де шукати ще:** будь-який commit з `feat(*)` що модифікує `schema.prisma`. Особлива увага: (а) розробник додає **колонку** у існуючу модель (`ALTER TABLE X ADD COLUMN Y` migration пропущений → SELECT з нової колонки кидає `column "Y" does not exist`); (б) додано `@@index` для performance — без migration index не створиться, queries працюватимуть але повільно (silent regression замість CRITICAL crash); (в) перейменовано field (Prisma може mapnути через `@map("old_name")` → migration не потрібен, але якщо @map немає — runtime crash). Профілактика: SKILL §1.1 тепер вимагає schema↔migration diff audit у Кроці 1 для кожного commit що зачіпає `schema.prisma`.

---

### 2026-05-31 — UoM/довідникові sub-resource: parent-list staleness після default-switching mutation (Bug #226-#227) — frontend, state-sync, react-query

**Сигнал:** sub-resource CRUD у modal-табі (одиниці виміру/штрихкоди/гарантії/категорії) має «default flag» — одна з рядків — `isDefault: true`, решта `false`. Mutation що змінює default (`setDefaultUoM`, `setPrimaryBarcode`, `setActiveTaxRate`) на backend синхронізує **parent entity** (`Good.unitId`/`Good.unit`/`Vehicle.activeTaxRateId`). Frontend optimistic-update оновлює тільки modal-state (`setModalUoMs(prev => prev.map(u => ({ ...u, isDefault: u.id === uomId })))`) — забуває оновити **parent list** (`load()` для goods/vehicles table). Користувач закриває modal → у списку goods все ще старий unit. Розбіжність зникає лише після reload або refetch goods. Окремий subcase — auto-promote next default при `removeUoM`: optimistic `filter(u => u.id !== uomId)` не знає що backend підняв наступний UoM у default → UI показує жоден як default, DB — новий обраний.

**Причина виникнення:** modal-таб (Edit Good) і parent table (Goods Tab) live в одному компоненті, але стейт-вузли роздільні (`modalUoMs` vs `goods`). Розробник, фокусуючись на UX модалу, реалізує всі CRUD-операції з оптимістичним оновленням `modalUoMs` (швидкий feedback у модалі) і пропускає крок «invalidate parent list». TypeScript і tests не ловлять — `load()` опціональний, не примусовий. У React Query era це класична **cross-cache invalidation gap** (Bug #210-#212 для sibling resources, але тут — для same-page parent state).

**Підхід до виявлення:** у §1.3 frontend audit — для кожного sub-resource CRUD у modal-табі (`addX`/`setDefaultX`/`removeX` функції що викликають backend endpoints які можуть зачепити **parent** entity):

1. Прочитати backend service для відповідного endpoint — знайти всі `prisma.<Parent>.update({...})` АБО `prisma.<Parent>.updateMany({...})` поза собою (тобто не на самому sub-resource).
2. Для кожного знайденого parent-update — перевірити чи frontend success-handler викликає `load()` для parent table АБО invalidate `<parentKeys>.all` (для React Query).
3. Auto-promote scenarios: коли backend `removeX` логіка пише `findFirst({ orderBy: createdAt asc })` + `update({ isDefault: true })` (auto-promote next-default) → optimistic `filter()` на клієнті НЕ ЗНАЄ про це → refetch sub-resource list після DELETE замість optimistic.

```bash
# Знайти sub-resource CRUD у modal-табах
grep -rn "apiFetch.*method:.*'POST\|PATCH\|DELETE'" apps/web/src/app --include="*.tsx" | grep -E "/uoms|/barcodes|/categories|/tax-rates|/warranties" | head -10
# Для кожного — pair-check проти backend service на parent-update side-effects
```

**Підхід до фіксу:** дві дисципліни:

1. **Parent table refresh:** після успіху sub-resource mutation що може змінити parent — викликати `load()` (raw state) АБО `queryClient.invalidateQueries({ queryKey: parentKeys.all })` (React Query). Conditional: тільки коли реально був parent-side-effect (наприклад, `addUoM` оновлює Good лише якщо `isFirst === true` — invalidate тільки тоді; `setDefaultUoM` завжди — invalidate завжди; `removeUoM` тільки якщо видаляли default — capture `wasDefault` перед DELETE).
2. **Sub-resource list refetch замість optimistic filter:** коли backend logic може зробити **state transitions** на інших рядках (auto-promote next default після delete) — оптимістичний `prev.filter(...)` НЕВІРНИЙ; робити `refreshXs(parentId)` (race-guarded через існуючий reqRef).

**Severity:** MEDIUM — стале UI впливає на бізнес-сприйняття (користувач думає що unit не змінився); LOW коли немає бізнес-сенсу (декоративні badges); HIGH якщо стале значення гейтить наступну дію (наприклад, default tax rate у invoice creation).

**Де шукати ще:** будь-який «sub-resource з default-flag» патерн — `/goods/:id/uoms`, `/goods/:id/barcodes` (`isPrimary`), `/counterparties/:id/contacts` (`isMain`), `/vehicles/:id/services` (`isPreferred`), `/employees/:id/branches` (default branch). Профілактика: SKILL §1.3 тепер вимагає parent-list-refresh audit для default-mutating sub-resource operations + refetch-on-delete для auto-promote scenarios.

---

### 2026-05-31 — Paired correlation middleware + structured logger без спільного req-id source (Bug #216) — backend, logging, observability

**Сигнал:** додано в одному sprint (а) HTTP correlation middleware (`CorrelationIdMiddleware` — сетить `x-request-id` header) і (б) structured logger (`nestjs-pino`/`pino-http` з JSON-форматом). У браузері видно `x-request-id: 7f3d-...-uuid` у response, але JSON-лог пише `{"reqId": 1, ...}` (sequential integer). Перевірка `pino-http@*/logger.js`: `function reqIdGenFactory(func) { ... let nextReqId = 0; return function (req, res) { return req.id || (nextReqId = (nextReqId + 1) & maxInt) } }` — дефолт. Ні tsc, ні existing tests не ловлять (logger output не асертиться; smoke-test перевіряє лише HTTP status code).

**Причина виникнення:** обидва компоненти **окремо валідні**. Розробник реалізує middleware першим — testing-через-curl показує header в response → OK. Потім додає logger — JSON логи виглядають правильно (рівні, redact, формат) → OK. Але **інтеграційна точка** (`pino-http.genReqId` має читати той самий header що middleware сетить) ніде не задокументована як обов'язкова. Розробник вважає що **порядок** (middleware першим → pino другим) автоматично робить лінк, але насправді pino-http реєструється як Fastify `onRequest` hook ВПЕРЕД Nest middleware → pino вже зафіксував `req.id = 1` до того як middleware виставить header.

**Підхід до виявлення:** для будь-якого sprint що додає одночасно correlation middleware + structured logger — перевірити чи pino config має `genReqId: req => req.headers['x-request-id']`-based reader. Grep: `grep -rn "genReqId\|reqId" apps/api/src --include="*.ts"`. Якщо нема `genReqId` і є CorrelationIdMiddleware → gap. Альтернативно — sprint review-checklist має «logger ↔ correlation tested end-to-end?» питання: запит з `X-Request-Id: deadbeef-...` має пройти у логах як `reqId: deadbeef-...`.

**Підхід до фіксу:** `pinoHttp.genReqId = req => { const raw = req.headers['x-request-id']; const c = Array.isArray(raw) ? raw[0] : raw; return (typeof c === 'string' && VALID_RE.test(c)) ? c : randomUUID() }`. Middleware тепер додатково гарантує: (а) inbound header валідовано і нормалізовано перед pino; (б) response header echo з того ж source. Альтернатива: видалити middleware і використовувати лише pino з custom genReqId + onResponse hook що echo-ить `req.id` у response. Гірше — суто на боці middleware (бо тоді треба переписати порядок Fastify hooks щоб middleware впав РАНІШЕ pino).

**Severity:** HIGH — feature що додається для production-моніторингу (Sentry, Loki, ELK) не працює. Не runtime crash; ловиться лише вручну при першому incident-debug коли інженер копіює header value з Sentry і не може знайти точний лог у production.

**Де шукати ще:** будь-яке поєднання `nestjs-pino` + middleware (audit-trail, tenant-context, user-id propagation); інші pairings де (а) public-contract компонент і (б) логуючий компонент мають ділити state — наприклад tenant id, employee id у audit logs. Профілактика: SKILL §1.1 Deploy/infra тепер вимагає paired-component req-id link audit при кожному введенні pino + correlation middleware.

---

### 2026-05-31 — Mass DTO migration completeness: incomplete grep variant coverage (Bug #215) — backend, refactor, sprint-wide

**Сигнал:** sprint-wide commit з повідомленням «змінити X у всіх DTO» (`@IsUUID('4')` → `@IsUUID()`, `@Matches(regex)` → `@IsX()`, `@IsString()` → `@IsString() @MaxLength(N)`) — закомічено 20-30 DTO files. Grep по новому паттерну (`@IsUUID()` без args) показує що всюди застосовано, АЛЕ 2-5 file-points у тому ж проєкті лишаються зі СТАРИМ варіантом тому що grep розробника шукав літерально `@IsUUID('4')` і пропустив:

- `@IsUUID('4', { each: true })` — array-форма
- `@IsUUID('4', { message: '...' })` — кастомна error message
- `@IsUUID('4', { groups: [...] })` — validation groups

Кейс з Sprint C4 STO ERP: 22 DTO мігровано, 4 рядки у `employees.dto.ts` (`AssignBranchesDto.branchIds`, `AssignZonesDto.zoneIds`, `AssignLiftsDto.liftIds`, `AssignWorkCategoriesDto.workCategoryIds`) лишилися з `@IsUUID('4', { each: true })`. Тести проходять бо fixtures робилися v4-layout у тій самій сесії. Виявляється лише через dev/seed UUIDs з non-v4 layout (`00000000-0000-0000-0000-000000000002` — BRANCH_ID seed).

**Причина виникнення:** автоматизована migration сесія використовує grep як інструмент знаходження + Edit для заміни. Простий grep (`@IsUUID('4')` як literal) знаходить більшість, але **варіантні форми** з extra args вимагають **regex-grep** або `grep -E "@IsUUID\('4'.*\)"`. Sprint planning описує «замінити X на Y» без явного перерахунку всіх варіантних форм X. Code review зосереджується на правильності нової форми у видимому diff, не аудитує **залишкових** старих форм у inconsистентних file-points.

**Підхід до виявлення:** після кожного sprint-wide refactor — повторити grep з **regex** замість literal. Для UUID: `grep -rnE "@IsUUID\('4'[^)]*\)" apps/api/src/modules/ --include="*.dto.ts"` — кожен match = пропущений file-point. Для `@Matches(uuid-regex)` → `grep -rnE "@Matches\(.*uuid.*\)"`. Для `@IsString()` без `@MaxLength` → bash loop через DTO. Альтернативно: ESLint custom rule («no `@IsUUID('4')` — use `@IsUUID()`») + lint-staged → блокує commit з невирішеним residue. Або: codemod-instrument (`jscodeshift`) який обходить AST і знає про варіантні форми decoratorа.

**Підхід до фіксу:** додати `@IsUUID(undefined, { each: true })` (явний `undefined` як perfix arg) — узгоджує з рештою проєкту. Не міняти `{ each: true }` на лінивий `@IsUUID()` бо це втратить array-validation. Перевірити `@IsUUID('4', { message })` — лишити `message` (i18n)`@IsUUID(undefined, { message })`. Видалити стале коментар у specях що референсить старий стан.

**Severity:** HIGH коли блокує dev/seed workflow (як Bug #215 з branchIds seed); MEDIUM коли блокує лише edge-кейси (v3 UUID з legacy import); LOW коли семантично еквівалентно (рідко — більшість variant forms мають практичні наслідки).

**Де шукати ще:** будь-яка sprint-wide міграція декораторів/типів (validation, swagger, prisma). Особлива увага: Sprint X3-X5 review-сесії що говорять «зробив консистентно у всіх DTO» — review-агент часто не пере-перевіряє повний grep після свого ж фіксу. Профілактика: SKILL §1.2 тепер вимагає regex-grep variant audit після mass DTO refactor.

---

### 2026-05-30 — React Query migration: cache invalidation gaps між cross-resource mutations (Bug #210-#212) — frontend, react-query, cache-invalidation, sprint-B

**Сигнал:** Sprint commit з `feat(rq): migrate X to useQuery` пагується (1) сторінкою що читає через `useQuery` + (2) КОЖНИЙ існуючий mutation (POST/PATCH/DELETE через `apiFetch`) лишається raw з manual `queryClient.invalidateQueries({ queryKey: xKeys.all })`. Розробник перевіряє: «після X mutation я інвалідую X cache» — це коректно для **same-resource** invalidation, але **cross-resource** залежності пропускаються. Приклади з STO ERP:

- `POST /purchase-orders/:id/receive` → server-side створює `RECEIPT` stock movement → `StockItem.quantity` оновлено → `/inventory` cache stale. Frontend інвалідує лише `purchaseOrdersKeys.all`. Користувач відкриває `/inventory` через 5s — бачить старі залишки.
- `POST /purchase-orders/:id/apply-pricing` → server оновлює `Good.salePrice` → `findStockItems` include-ить `salePrice` → `/inventory` grid показує старі sale prices.
- `POST /payments` (з `workOrderId`) → server увеличує `WorkOrder.paidAmount` + транзитує WO статус → `workOrdersKeys.all` cache stale. Frontend інвалідує лише `invoicesKeys.all`.
- `POST /work-orders` (create) → frontend `router.push(/work-orders/:id)` БЕЗ invalidate → юзер `router.back()` у межах staleTime бачить список без щойно створеного наряду.

Регресія не runtime-bug, але **silent UX break** — користувач бачить «застарілі» цифри і не розуміє чому. Усе виправляється ручним refresh, тому bug-report з продакшну зазвичай не приходить — невдоволення лишається.

**Причина виникнення:** React Query migration зосереджується на «один запит — один хук» — це фасадний дизайн. Розробник перевіряє success-path (mutation повертається ОК) і invalidate-path (related list freshens), не моделює side-effects на сервері. Якщо backend контролер виконує `inventory.createMovement` АБО `workOrders.transition` АБО `good.update` АБО `priceHistory.create` — це **транзитивна залежність** яка не видна у клієнтському коді. SKILL раніше казав «mutation → invalidate», але не вимагав читання server-side service для виявлення cross-resource side-effects.

**Підхід до виявлення:** на Кроці 1 §1.3, для **кожного** raw `apiFetch` mutation (POST/PATCH/DELETE) у migrated page → прочитати **серверний** controller+service цього endpoint, і знайти:

1. Всі `prisma.X.update/create/upsert/delete` поза own-resource (наприклад, payments.service updates `workOrder`/`invoice`).
2. Всі виклики `inventoryService.createMovement(...)` (змінює stockItem.quantity → invalidate `inventoryKeys.all`).
3. Всі виклики `workOrdersService.transition(...)` (змінює WO status → invalidate `workOrdersKeys.all`).
4. Всі виклики `settlementsService.createTransaction(...)` (змінює counterparty.balance → invalidate `counterpartiesKeys.all` якщо list endpoint показує balance).
5. Всі виклики `priceHistory.create(...)` (змінює goods.salePrice → invalidate `inventoryKeys.all`/`goodsKeys.all` якщо є).

Для КОЖНОЇ side-effect target — перевірити чи відповідний queryKey інвалідовано у frontend success-handler. Якщо ні → gap. Grep по `await apiFetch.*method:.*'POST\|PATCH\|DELETE'` у migrated сторінці і pair-check проти service-method.

**Підхід до фіксу:** додати додаткові `queryClient.invalidateQueries({ queryKey: Ykeys.all })` для КОЖНОЇ зачепленої resource. Multi-resource invalidation = звичайна mutation success-handler, без структурних змін. Альтернатива (краще): використовувати ВЛАСНІ mutation hooks (`useReceivePO`, `useApplyPricing`) з invalidation у `onSuccess` — централізує знання про side-effects у hook (single source of truth). НЕ покладатись на staleTime=30s бо: (а) пагінований grid може бути на іншій сторінці що користувач уже бачить; (б) DevTools з React Query показує stale-час але звичайний user не моніторить.

**Severity:** MEDIUM коли invalidate gap впливає на бізнес-метрику (залишки/ціни/балансu) — користувач приймає рішення на основі stale-цифр; LOW коли invalidate gap впливає лише на UX (новий запис не з'являється у списку до router.back). Не CRITICAL бо дані у БД коректні; UX recovery — F5 / навігація.

**Де шукати ще:** будь-яка React Query migration сесія (Sprint B-style). Інші likely-точки: `POST /work-orders/:id/transition` COMPLETED → WRITEOFF створює `stock movements` (inventoryKeys) + CHARGE створює settlement (counterpartiesKeys якщо balance показано); `POST /invoices/:id/clone` створює invoice (invoicesKeys ✓) але може зачіпати work-order (workOrdersKeys); `DELETE /work-orders/:id` soft-delete може закрити пов'язаний invoice. Профілактика: SKILL §1.3 тепер вимагає cross-resource invalidation audit для кожного raw mutation у migrated page.

---

### 2026-05-30 — React Query migration incomplete: reads migrated, mutations лишилися raw → mutation hooks dead-code (Bug #213) — frontend, react-query, dead-code, sprint-B

**Сигнал:** commit з `feat(rq): sprint-B3 X — migrate to useX + useXMutation` додає ОБА хуки `useX` (query) і `useXMutation` (mutation з invalidate у `onSuccess`). Сторінка use-ить лише `useX` для читання; усі mutations (`POST/PATCH/DELETE`) залишаються raw `apiFetch` з manual `queryClient.invalidateQueries`. `useXMutation` ніколи не викликається — мертвий export. tsc валідний (export використовується у `index.ts` re-export), runtime ОК, bundle включає dead code, commit message **вводить в оману**. Маса прикладів у Sprint B STO ERP: `useInvoiceTransition`/`useCreatePayment`/`useDeleteInvoice`/`useDeleteCounterparty`/`useDeletePurchaseOrder`/`useApplyPricing`/`useWorkOrderTransition`/`useDeleteWorkOrder` — усі експортовані, **ніде не використовуються**.

**Причина виникнення:** Sprint planning часто має «query + mutation hooks» як один deliverable, але migration story зосереджена на ЧИТАННІ — write-path більш ризикований (FSM, валідація, error-recovery, optimistic updates). Розробник пише hooks завчасно («буде як queries готові»), мігрує сторінки на queries, не доходить до mutations через дедлайн → hooks лишаються «зомбі». Технічно НЕ runtime-bug, але:

- Bundle bloat (8 невикористаних hooks × ~200 bytes each)
- Misleading commit-message → майбутні розробники довіряють «hook налаштовано» і копіюють патерн (дублюючи raw fetch замість використання hook)
- Maintenance дублікат: invalidation логіка живе у двох місцях (hook `onSuccess` + page success-handler)

**Підхід до виявлення:** після кожного React Query migration sprint — grep кожен `export function useX` з `useMutation` у `hooks/api/` і шукати споживачів через `grep -rn "useX" apps/web/src/app --include="*.tsx"`. Якщо count === 0 (поза тестами) → dead hook. Альтернативно: scan `hooks/api/index.ts` re-exports проти actual page imports.

**Підхід до фіксу:** **на tester-сесії** — задокументувати у MemoryManual як incomplete migration (known-state); не видаляти hooks тому що вони можуть знадобитись Sprint B4 і їх краще лишити як reference-implementation. **Альтернатива**: повна міграція pages на mutation hooks — це окремий sprint (B4), не tester scope. Якщо рішення «не мігруємо» — видалити hooks і прибрати з `index.ts` (cleanup commit).

**Severity:** LOW — bundle bloat + maintenance burden + misleading messages, але runtime OK. Може стати MEDIUM якщо invalidation у hook розходиться з invalidation у page success-handler (різна логіка → cache desync).

**Де шукати ще:** будь-яка React Query / SWR / Apollo migration; будь-який abstraction layer що готують «наперед» (DAO classes, repository pattern, command pattern) — особливо у monorepo з декількома team-ами де код пише одна team, споживає інша. Профілактика: коли SKILL §1.3 знаходить dead mutation hooks — або одразу мігрувати (B4), або одразу видалити (cleanup commit); НЕ лишати "поки що".

---

### 2026-05-30 — React Query custom hook без `*.test.tsx`: queryKey factory / enabled-gate / URLSearchParams без regression-захисту (Bug #214) — frontend, test-coverage, react-query

**Сигнал:** новий `apps/web/src/hooks/api/use*.ts` що (а) типизує параметри через `Filter`-interface і будує `URLSearchParams` з нього; (б) має queryKey factory (`xKeys.all`/`.list(filters)`/`.detail(id)`); (в) використовує `enabled: !!employee` для гейту. Без `*.test.tsx` нуль захисту від:

- **queryKey identity-collision:** якщо два різних фільтри-стани випадково отримують один queryKey (наприклад через JSON.stringify-серіалізацію з неоднаковим порядком ключів), React Query показує дані для ОДНОЇ фільтр-комбінації у місці іншої.
- **URLSearchParams gaps:** новий фільтр (`repairCategory`) додано до UI, але в `useX` забуто `if (filters.repairCategory) params.set(...)` → silent filter ignore (точна регресія яка трапилась у 3d5136d під ревью).
- **enabled-gate інверсія:** `enabled: !!employee` → `enabled: !employee` (друкарська помилка) → fetch до auth → 401 у консолі.
- **signal-abort gap:** не пробросити `signal` у `apiFetch` → fetch продовжується після unmount → race на stale state.

**Причина виникнення:** React Query hooks виглядають як «trivial wrappers» — розробник вважає що `useQuery` сам себе тестує. Але фасад навколо `useQuery` (filter→queryString→queryKey→fetch) містить НЕ-тривіальну логіку: URL params серіалізацію, queryKey identity (для cache lookup), enabled gate. Кожна з цих гілок — потенційна регресія.

**Підхід до виявлення:** для кожного нового `hooks/api/use*.ts` що містить `useQuery` АБО `useMutation` → перевірити наявність парного `*.test.tsx`. Шаблон тесту: `useWorkOrders.test.tsx` — 4 describe-блоки: (1) queryKey factory (ізоляція ключів для різних фільтрів); (2) enabled-gate (employee=null → no fetch); (3) URLSearchParams (кожне опціональне поле → відповідний URL param АБО відсутній якщо false-y); (4) signal abort (apiFetch отримує signal від queryFn context).

**Підхід до фіксу:** створити `use<Name>.test.tsx` за шаблоном з мінімальними кейсами (12-15 it-блоків). Mock `apiFetch` через `vi.mock('@/lib/api-client')`, mock `useAuth` через `vi.mock('@/lib/auth')`. Тест НЕ потребує реального QueryClientProvider — створити `wrapper` factory що передає свіжий `QueryClient({ defaultOptions: { queries: { retry: false } } })`.

**Severity:** LOW — runtime коректний на момент написання, але регресії беззвучні (URL param drift = silent filter ignore — точно як Bug 3d5136d).

**Де шукати ще:** усі майбутні React Query hooks (Sprint B4+ — mutation hooks); SWR hooks; Apollo `useQuery`. Профілактика: SKILL §1.6 тепер явно покриває React Query custom hooks (раніше згадувалось `useEffect`+`apiFetch` як trigger — query hooks могли проскакувати бо `useEffect` у самого `useQuery` не у hook-споживача).

---

### 2026-05-30 — Next.js App Router `error.tsx` props без `digest` — incomplete type breaks monitoring (Bug #206) — frontend, typescript, next-js-convention

**Сигнал:** новий `apps/web/src/app/error.tsx` (Next.js App Router error boundary) з сигнатурою `({ error, reset }: { error: Error; reset: () => void })`. Поточний bare `Error` НЕ дозволяє типобезпечно прочитати `error.digest` — server-attached identifier що Next.js додає до помилок з Server Components (для крос-кореляції з логами / Sentry / Datadog). У runtime поле присутнє, але TypeScript reject будь-який майбутній код типу `Sentry.captureException(error, { tags: { digest: error.digest } })` → tsc error → розробник або змушений робити `(error as any).digest` (порушує §1.2), або забуває моніторинг взагалі. Документація Next.js (`https://nextjs.org/docs/app/api-reference/file-conventions/error`) явно показує `error: Error & { digest?: string }` як канонічний type. tsc сам по собі не ловить — bare `Error` валідний; ловиться лише через перегляд проти Next.js docs АБО через первинний пробіг tester-агента на новій error-boundary.
**Причина виникнення:** copy-paste з generic React error-boundary прикладу де `Error` достатньо. Next.js convention специфічна — `digest` як проп є лише у App Router error.tsx, не у звичайних component-error-handler-ах. Розробник пише сигнатуру з пам'яті/loose-копії, не звертаючись до Next.js docs. Якщо проект не використовує Sentry/Datadog зараз — мотивації немає (`digest` зайвий); але майбутній моніторинговий sprint буде заблокований tsc-помилкою. Симетрично з іншими Next.js convention-файлами: `layout.tsx` приймає `params: { [key: string]: string | string[] }`, `page.tsx` — `searchParams: { [key: string]: ... }` — і кожен має точний type-signature у docs.
**Підхід до виявлення:** при будь-якому новому `app/**/error.tsx` (включно з route-level error boundaries — `app/work-orders/error.tsx` тощо) — перевірити що сигнатура `error: Error & { digest?: string }`, не bare `Error`. Grep: `grep -rn "export default function.*error.*Error" apps/web/src/app --include="error.tsx"` → кожен match має `& { digest`. Перевірка через Next.js docs: error.js page → "Props" section явно показує `Error & { digest?: string }`. Не довіряти `tsc` (bare `Error` валідний); не довіряти eslint (no-unused-locals на `digest` бо поле опціональне).
**Підхід до фіксу:** оновити сигнатуру: `({ error, reset }: { error: Error & { digest?: string }; reset: () => void })`. Додати regression-тест у парний `*.test.tsx`: `const error: Error & { digest?: string } = Object.assign(new Error('X'), { digest: 'abc' }); render(<GlobalError error={error} reset={...} />);` — якщо тип регресне на bare `Error`, тест перестане компілюватись.
**Severity:** LOW — у поточному коді жоден споживач не читає `digest`, runtime коректний. Стає HIGH коли додасться моніторинговий interceptor / Sentry SDK що очікує `error.digest` як tag.
**Де шукати ще:** будь-який майбутній route-level error boundary (`app/{calendar,crm,invoices,work-orders,...}/error.tsx`); будь-який Next.js convention-файл з documented type-signature (`app/**/{layout,page,template,not-found,error,loading}.tsx`). Профілактика: SKILL §1.3 тепер вимагає перевірки точної сигнатури проти Next.js docs для convention-файлів.

---

### 2026-05-30 — Next.js App Router convention-файли (`error.tsx`/`not-found.tsx`) без component-тесту → беззвучна регресія UI-контракту (Bug #208) — frontend, test-coverage

**Сигнал:** новий `apps/web/src/app/error.tsx` (Next.js App Router error boundary з interactive логікою: `reset()` callback, `console.error` effect у `useEffect`, fallback message при empty `error.message`, navigate button на `/dashboard`) АБО `not-found.tsx` (link на `/dashboard`, кириличні тексти) — без жодного `*.test.tsx`. SKILL §1.6 вимагає тестів для нових shared UI-компонентів у `components/ui/`, але App Router convention-файли формально не в "shared UI", тому правило часто пропускається. Регресії, які стають беззвучними:

- зміна fallback від `||` на `??` (різна поведінка для empty string)
- видалення `console.error` effect → втрата моніторингу без сигналу
- зміна link з `/dashboard` на `/` після рефакторингу нав
- зміна кириличного тексту на англійський або з друкарською помилкою
- регресія a11y (видалення `aria-hidden` з декоративної SVG, зміна heading level)
- регресія типу (Bug #206): bare `Error` замість `Error & { digest?: string }`

**Причина виникнення:** App Router convention-файли (`error.tsx`/`loading.tsx`/`not-found.tsx`/`template.tsx`) виглядають як "framework infrastructure" — розробник вважає їх "тестує сам Next.js" або "слугують лише як fallback". Реально вони мають bizness-логіку (текст українською, навігація на правильний route, моніторинговий effect, a11y-контракт). SKILL §1.6 формулювання "shared UI-компонент `components/ui/`" буквально не включає `app/**/(convention).tsx` → пропускається.
**Підхід до виявлення:** при будь-якому новому `apps/web/src/app/**/{error,not-found}.tsx` (root-level АБО route-level) — створити парний `apps/web/src/app/__tests__/<name>.test.tsx` (АБО локально-розміщений `*.test.tsx`). Мінімум 4-8 кейсів: heading render, основний CTA (reset/link) клік, fallback при empty input, a11y перевірки (aria-hidden на декоративній SVG), regression на type-signature (Bug #206). `loading.tsx` — pure skeleton, можна skip (нема інтерактиву); але якщо `loading.tsx` має суттєву анімацію/dark-mode логіку — теж тест.
**Підхід до фіксу:** створити `app/__tests__/error.test.tsx` за шаблоном `useSavedFilters.test.tsx` — `render(<GlobalError error={new Error('X')} reset={vi.fn()} />)` + `screen.getByRole('heading', { name: 'Виникла помилка' })` + `userEvent.click(getByRole('button', { name: 'Спробувати знову' }))` + `expect(reset).toHaveBeenCalledTimes(1)`. `console.error` mock через `vi.spyOn(console, 'error').mockImplementation(() => {})` у `beforeEach`. Для `not-found.tsx` — `screen.getByRole('link', { name: 'На головну' })` + `.getAttribute('href')` асерт.
**Severity:** LOW — production коректний на момент написання, але нуль захисту від регресії UX-контракту. Може стати HIGH коли App Router convention-файл починає використовуватись для критичної UX-сигналізації (наприклад, error.tsx що показує `Sentry.lastEventId()` для support-тікетів — регресія "втратить" id без warning).
**Де шукати ще:** будь-який майбутній route-level error/not-found (`app/work-orders/error.tsx`, `app/booking/not-found.tsx`); `template.tsx` (rare); `default.tsx` (parallel routes); кастомний `global-error.tsx`. Профілактика: SKILL §1.6 розширено — нові App Router convention-файли з ANY інтерактивом (`useEffect`, `onClick`, `'use client'`) → парний тест обов'язковий.

---

### 2026-05-30 — Global APP_GUARD без skip-list для healthcheck/SSE/webhooks → docker cascade restart (Bug #203) — backend, deploy

**Сигнал:** новий `{ provide: APP_GUARD, useClass: XGuard }` додаваний у `app.module.ts` (rate-limiter, IP-allowlist, custom global guard). У тому ж комміті review-агент додає `@SkipThrottle()`/`@Public()` на очевидні endpoint-и (SSE streams, login throttle override), АЛЕ пропускає неочевидні: `/health`, `/metrics`, webhook-endpoint-и, batch endpoints. Production-симптоми (від найшвидших до найповільніших): (а) `429 Too Many Requests` на `/health` від docker healthcheck → контейнер позначається `unhealthy` → `depends_on: condition: service_healthy` валиться → cascade restart по compose-стеку; (б) Prometheus scrape втрачає метрики (silent — графіки виглядають порожніми); (в) webhook від PRRO/payment провайдера не доходить → ПРРО не отримує підтвердження → користувацька проблема. tsc мовчить (декоратори опціональні). Існуючі unit/contract тести зазвичай НЕ запускають AppModule з APP_GUARD, тому моки guard-у пропускають проблему. E2E `smoke.spec` без healthcheck-spam теж пропускає.
**Причина виникнення:** APP_GUARD виглядає як невинне додавання у `providers: []` — без зміни жодного контролера. Розробник зосереджується на «нових бізнес-сценаріях» (login rate, upload rate), не аудитує існуючі «незмінні» endpoint-и які тепер теж під guard. Бар'єр входу високий: треба знати які endpoint-и часто опитуються зовнішніми системами (docker, nginx, monitoring) і які мають бути виключені. `@nestjs/throttler` документація показує лише `@Throttle()` (більш обмежувальний) і `@SkipThrottle()` (виключний), але не дає шаблон skip-листа.
**Підхід до виявлення:** при будь-якому новому global APP_GUARD у `app.module.ts` — одразу пройти **skip-list checklist**: (1) `/health` — `@SkipThrottle()` на класі; (2) `/metrics` — те саме; (3) `@Sse()` endpoint-и — `@SkipThrottle()` на методі (бо EventSource retry-ється при дисконекті); (4) webhook controllers (`@Controller('webhooks/X')`) — guard-залежно (`@SkipThrottle()` для зовнішнього source); (5) batch/cron-trigger endpoints. Grep: `grep -n "APP_GUARD" apps/api/src/app.module.ts` → для кожного знайденого guard перевірити `@SkipX()` декоратори у вищезгаданих контролерах. Виявляється лише через runtime healthcheck failures у проді або у CI smoke-test що робить >200 запитів за хвилину.
**Підхід до фіксу:** додати `@SkipThrottle()` (або відповідний `@Skip*Guard()`) на рівні класу контролерів зі skip-листа. Симетрично з `dashboard/stream` (SSE) у STO ERP. Якщо guard не має built-in skip-декоратора — створити кастомний (`@Public()`-патерн з `Reflector` + `SetMetadata`).
**Severity:** HIGH — production deploy blocker. У dev/CI працює (без cascade docker depends_on); виявляється лише у проді або e2e smoke-тесті що швидко spam-ить health.
**Де шукати ще:** будь-який майбутній global guard (IP allowlist, RBAC-by-tenant, кастомний rate-limiter, audit guard). Профілактика: SKILL §1.1 Deploy/infra тепер вимагає `APP_GUARD skip-list audit` при кожному новому global guard. Аналогічна логіка для `APP_INTERCEPTOR`/`APP_FILTER` що змінюють response shape (наприклад, інтерсептор що додає `cache-control: no-cache` ламає Cloudflare edge caching для `/static/*` endpoint-у).

---

### 2026-05-30 — Dead imports після page-split рефакторингу — tsc мовчить через noUnusedLocals: false (Bug #204-#205) — frontend, typescript, dead-code

**Сигнал:** великий `page.tsx`/`*Tab.tsx`/`*Modal.tsx` сплітнули на 3-5 sibling файлів. Утиліти (наприклад `parseHHMM`, `KYIV_TZ`) переїхали разом з логікою у новий файл, але ОРИГІНАЛЬНИЙ `page.tsx` лишається з `import { ..., parseHHMM, ... }` де `parseHHMM` вже не викликається. `tsc` мовчить через `noUnusedLocals: false` у `apps/web/tsconfig.json`. Vite/Next.js dev і prod збираються без warning. Code review пропускає бо diff показує ВЕЛИКИЙ split — глобально файл скорочений з 1500 до 200 рядків, мертвий імпорт у 5 рядках імпорт-списку невидимий за зменшенням обсягу. Регресія виявляється коли утиліту згодом реіменують у sibling-файлі: пере-export-ять як `parseTime`, а у `page.tsx` лишається `parseHHMM` → run-time error `parseHHMM is not a function` після того як хтось викличе цей мертвий код (наприклад, через autocomplete у IDE).
**Причина виникнення:** при split-рефакторингу спочатку **копіюють** імпорти у новий файл, потім видаляють використання з оригіналу — але імпорти оригіналу не чистять (нудно, риск чогось зламати). Сучасний інструмент рефакторингу (VSCode "Move to file") видаляє імпорти автоматично, але **ручний** split (особливо коли частину коду треба адаптувати під нові props) обходить інструмент → імпорти лишаються мертвими.
**Підхід до виявлення:** для кожного файлу з `git diff HEAD` що **зменшився** на >30% або був split (один файл → два сиблінги) — пройти імпорт-список і для кожного `import { X, Y, Z }` грепати `\bX\b` у решті файлу: якщо count <= 1 (тільки сам імпорт) → мертвий імпорт. Автоматизація: bash-цикл який витягує impоrted names через `grep -oE "^import \{[^}]+\}"` + `grep -oE "[A-Za-z_][A-Za-z0-9_]+"` і рахує occurrences. Альтернатива: увімкнути `noUnusedLocals: true` у tsconfig — але це масивна зміна що ламає інші файли.
**Підхід до фіксу:** видалити неживі імпорти. Один рядок diff на файл — мінімальний ризик. Зазвичай batch-cleanup після split-серії — окремий комміт «cleanup dead imports after split».
**Severity:** LOW — runtime не зламаний (просто мертвий код), tree-shaking тимчасово страждає (bundle на кілька байт більше — не критично з urgent точки зору). Може стати HIGH якщо утиліту реіменують у sibling без перевірки споживачів.
**Де шукати ще:** кожен великий split-рефакторинг у STO ERP (`page.tsx` → `Tab*.tsx`, `service.ts` → split modules). Профілактика: SKILL §1.2 тепер містить bash-loop для dead-import detection; після кожного split-комміту проганяти.

---

### 2026-05-30 — Defense-in-depth status guard у service-ревью без оновлення fixtures → release-blocker baseline (Bug #200) — backend, test-coverage, process

**Сигнал:** review-сесія додала рядки на кшталт `if (entity.status !== ALLOWED_A && entity.status !== ALLOWED_B) throw BadRequestException('...')` у початку методу сервісу (приклад: PO `applyPricing` → guard RECEIVED/PARTIAL). Парний `*.service.spec.ts` має fixtures де `prisma.X.findFirst.mockResolvedValueOnce({...})` НЕ містять поле `status` → undefined ≠ ALLOWED_A → guard кидає на ВСЕ існуючих тестах → файл фейлить N з N+1 тестів (зазвичай лише `NotFound` кейс виживає бо findFirst поверне null). При цьому review-commit залишається docs-only / code-only без spec-update → baseline стає хибно-червоний → наступна tester-сесія не може розрізнити нові регресії від шуму. Симетрично з Bug #200: рефактор замінив `pricingService.calculateSalePrice` на нові public `getActiveRulesForOrg + computePriceFromRules` — spec ще мокає старий метод, тест проходить **випадково** бо новий метод не викликається насправді.
**Причина виникнення:** автоматизована code-review-сесія фокусується на діффі ВЕЛИКОГО файлу (service.ts), вживає мінімальний defense-in-depth fix і коментує-документує його, але не запускає парний spec → не бачить що 5 тестів зламано. Process-причина: review-агент не виконує тест-прохід після свого ж фіксу. Якщо новий guard перевіряє додаткові поля (deletedAt, isActive, ownerId, currency) — той самий патерн поширюється.
**Підхід до виявлення:** при будь-якому review-commit що додає early-throw guard у service (грепати `+    if (.+\.status !== \|+    throw new BadRequestException\|+    throw new ForbiddenException` у git diff після review) → одразу пройти парний spec і додати потрібне поле у ВСІ fixtures `findFirst.mockResolvedValueOnce({...})`. На Кроці 0 — якщо `[x] виправлено` review-bug додав guard АБО рефактор public-API сервісу, перевірити чи парна spec оновлена; якщо ні — це Bug #0 baseline-blocker, виправити ПЕРШИМ перед новим аналізом.
**Підхід до фіксу:** додати поле у кожен мок (`status: PurchaseOrderStatus.RECEIVED`, `deletedAt: null` тощо). Якщо рефактор замінив old method на new — оновити mock-ім'я (`pricingService.calculateSalePrice` → `pricingService.computePriceFromRules`). Додати окремі **boundary** тести для нової логіки guard (`status: DRAFT → throws`, `status: PARTIAL → success` — обидва стани boolean-guard як з Bug #194 inverse-condition).
**Severity:** HIGH — release-blocker через хибно-червоний baseline; ховає реальні регресії та блокує наступні AUTO-сесії.
**Де шукати ще:** будь-який майбутній defense-in-depth guard додаваний у review-агентом (FSM transition guard, tenant guard, permission guard, status guard, soft-delete guard); будь-який рефактор що замінює private method на public + старий метод видаляється. Профілактика: process — review-агент має ЗАВЖДИ пробігти парний `*.spec.ts` після свого фіксу; tester-агент на Кроці 0 — звіряти `[x]`-маркери попередніх review-сесій проти реального стану spec-файлів (не лише service-файлів).

---

### 2026-05-30 — FormData upload через `apiFetch` (а не `apiMultipartFetch`) → upload завжди валиться 400/406 — frontend, api-contract

**Сигнал:** новий код у `apps/web/src/app/**/*.tsx` що формує `FormData` (`new FormData()`/`fd.append('file', f)`) і відправляє через `apiFetch(path, { method: 'POST', body: fd })` замість `apiMultipartFetch(path, fd)`. `tsc` НЕ ловить (типи `RequestInit.body` приймають `FormData`). Browser DevTools показує що запит йде з `Content-Type: application/json` замість очікуваного `multipart/form-data; boundary=...`. Сервер відповідає 400 «Файл не завантажено: очікується multipart/form-data» (після фіксу Bug #192) АБО 406 «the request is not multipart» (без цього фіксу). Користувач натискає upload → бачить помилку → нічого не зберігається. **Уся клієнтська upload-фіча мертва у проді.**
**Причина виникнення:** `apiFetch` (api-client.ts) ЖОРСТКО додає `'Content-Type': 'application/json'` до КОЖНОГО запиту через `headers: { 'Content-Type': 'application/json', ... }`. Розробник додає upload-фічу і copy-paste з найближчого fetch-handler-а (POST/PATCH/DELETE), не помічаючи що для FormData потрібен інший helper. Окремий `apiMultipartFetch` створено саме для цього (Bug #85), але його легко пропустити: дві функції в одному файлі з однаковими підписами `(path, ...)` — потрібен код-ревью. Інші upload-точки (`xlsx-import-button.tsx`, `settings/page.tsx`, `work-orders/[id]/PageClient.tsx`) використовують `apiMultipartFetch`. Регресія з'являється коли нова фіча додає upload не через переюзаний компонент.
**Підхід до виявлення:** після кожного diff що додає `new FormData()` АБО `formData.append('file'`, шукати чи відправка йде через `apiMultipartFetch`. Grep: `grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx"`. Альтернатива (через інспекцію diff): кожен `formData.append('file', ...)` має наступним викликом `apiMultipartFetch(...)`, НЕ `apiFetch(...)`.
**Підхід до фіксу:** заміна `apiFetch<T>(path, { method: 'POST', body: fd })` → `apiMultipartFetch<T>(path, fd)`. Додати `apiMultipartFetch` в імпорт. `apiMultipartFetch` сам встановлює `method: POST`, не передавати у init.
**Severity:** CRITICAL — фіча повністю мертва у проді (upload завжди 400/406); виявляється лише через user-bug-report АБО E2E. tsc мовчить.
**Де шукати ще:** будь-який майбутній файловий аплоад (avatars, attachments, photos на mobile screens, batch imports, CSV/XLSX upload). Профілактика: SKILL §1.3 тепер вимагає grep на «apiFetch + body: FormData» патерн; новий загальний шаблон upload — завжди `apiMultipartFetch`.

### 2026-05-30 — Nullable cost-input у calculateSalePrice → salePrice=0 затирання — backend, business-logic, data-corruption

**Сигнал:** новий сервіс/метод що (а) читає `purchasePrice` товару з БД (де поле `Decimal?` nullable), (б) передає це значення у `pricingService.calculateSalePrice(orgId, goodId, ..., costPrice)`, (в) пише результат у `Good.salePrice`. Розробник пише `const costPrice = Number(good.purchasePrice ?? 0)` — здається безпечним fallback. Реально: `calculateSalePrice` для PERCENT/COMPETITOR_PLUS/COST_TIER повертає `0 * (1 + p/100) = 0`. Сервіс пише 0 у `salePrice` (non-nullable у схемі) → товар отримує нульову ціну продажу без помилки/попередження. PriceHistory зафіксує `oldPrice=130, newPrice=0` — post-mortem можлива, але дані відновлюються вручну.
**Причина виникнення:** `??  0` як defensive fallback інтуїтивний (Number(null) = NaN, тому fallback). Розробник не думає про **семантичні наслідки** costPrice=0 для multiplicative rules. Кейс "немає purchasePrice" виглядає edge (зазвичай товари створюються з purchasePrice), але реально присутній: новий товар з фронту (тільки name + salePrice), імпорт з прайсу без cost, історичні товари з пустим полем. PERCENT/COMPETITOR_PLUS правила (найпоширеніші у STO ERP) повертають 0 → масове знищення цін при першому ж списковому імпорті.
**Підхід до виявлення:** для будь-якого нового виклику `pricingService.calculateSalePrice(...)` — переконатись що ПЕРЕД викликом є guard `if (X.purchasePrice == null || Number(X.purchasePrice) <= 0) { /* skip */ }`. Grep: `grep -rn "calculateSalePrice\|purchasePrice ?? 0" apps/api/src/modules/ --include="*.ts"`. Особлива увага: list-import endpoints де input — лише ідентифікатор товару (sku/barcode), а cost береться з БД (а не з ряду файлу).
**Підхід до фіксу:** `if (good.purchasePrice == null || Number(good.purchasePrice) <= 0) { notFound.push(\`${sku} (без собівартості)\`); continue; }`ПЕРЕД`calculateSalePrice`. Тест-кейси: (а) `purchasePrice=null → notFound + calculateSalePrice не викликаний + good.updateMany не викликаний`; (б) `purchasePrice=0 → notFound + калькуляція пропущена` (захист від ділення на нуль у майбутніх правилах).
**Severity:** HIGH — silent data corruption на фінансовому полі (`salePrice`); виявляється лише через скаргу користувача «у мене ціни стали 0»; повернення цін вручну з PriceHistory.
**Де шукати ще:** будь-який майбутній сервіс що пише `Good.salePrice`на основі обчислення з nullable input — bulk-recalc CRON (якщо буде), price-sync endpoints для зовнішніх прайсів (Magento/1С), markup-recalc після зміни currency exchange rate. Профілактика: SKILL §1.1 тепер вимагає prep-guard для будь-якого виклику`calculateSalePrice` коли costPrice читається з nullable джерела (Good.purchasePrice, Batch.cost, StockMovement.price).

### 2026-05-30 — Новий boolean prop на існуючому компоненті без inverse-condition тесту → інверсія guard беззвучна — frontend, test-coverage

**Сигнал:** diff додає опціональний boolean prop (`hideSaveButton?: boolean`, `disabled?: boolean`, `showFooter?: boolean`, `collapsible?: boolean`) до існуючого shared UI-компонента. Прод-код використовує prop через guard `{!hideX && <Element />}` або `{showX && <Element />}`. Існуючий `*.test.tsx` тестує ТІЛЬКИ default-режим (prop undefined / прохідний шлях), inverse-режим (prop=true / альтернативний шлях) — нуль покриття. Регресія типу `!hideX` → `!!hideX` (мінорний друкарська помилка під рефактор) проходить зеленою бо жоден тест не активує inverse-стан.
**Причина виникнення:** новий prop додається як «розширення» — розробник думає «я не зламав default-поведінку, існуючі тести зелені». Не усвідомлює що **бінарний guard має ДВА стани** і кожен потребує окремого тесту. Inverse-стан зазвичай не описаний в acceptance-criteria («приховує save-button коли treba») — лише в head-розробника. Якщо prop впроваджується щоб увімкнути новий UX-режим в N сторінках (як `hideSaveButton` для 8 page.tsx), регресія guard-інверсії зламає UX на всіх 8 page одночасно, але існуючі тести всі зелені.
**Підхід до виявлення:** для кожного diff у `apps/web/src/components/ui/*.tsx` що додає новий optional boolean prop у InterfaceProps — переконатись що парний `*.test.tsx` має МІНІМУМ 2 кейси для цього prop: (а) default/false-режим (інколи покрито існуючими тестами) + (б) true-режим (інверсна-перевірка). Бажано також кейс «true-режим залишає інші елементи компонента видимими» (захист від занадто-широкого guard з copy-paste). Grep: `grep -nE "^\s+\w+\?: boolean" apps/web/src/components/ui/*.tsx` після diff — кожен новий prop = +2-3 тести.
**Підхід до фіксу:** додати inverse-condition тести у тому ж describe-блоку. Шаблон: `it('XProp=true приховує/показує Y') + it('XProp=true приховує/показує Z') + it('XProp=true залишає W видимим')`. Не покладатись на page-level integration тести (їх часто немає, а навіть якщо є — мокають саме prop через page-options, не сам компонент).
**Severity:** MEDIUM — регресія мовчазна; UX на N сторінках одночасно поломаний; виявляється лише через user-bug-report.
**Де шукати ще:** будь-який майбутній компонент з опціональним boolean (Modal `hideClose`, EmptyState `compact`, Button `loading`, Select `searchable`, Table `striped`). Профілактика: SKILL §1.6 тепер вимагає inverse-condition тестів для нових boolean props.

### 2026-05-30 — fastify-multipart `req.file()` кидає FastifyError → leak 406 з англ. повідомленням замість 400 українською — backend, api-contract, i18n

**Сигнал:** новий controller endpoint з `@ApiConsumes('multipart/form-data')` що викликає `await req.file()` напряму (без try/catch). Helper зазвичай має заглушку `if (!data) throw new BadRequestException('Файл не завантажено')`, що **обробляє лише nullish-результат, НЕ thrown FastifyError**. Якщо клієнт (curl без `-F`, фронт що забув `FormData`, не той content-type) НЕ присилає multipart-payload — `fastify-multipart` кидає `FastifyError: the request is not multipart` що мапиться у HTTP **406 Not Acceptable** з англомовним messageом. Користувач (або фронт) бачить 406 замість 400 + не отримує українського пояснення.
**Причина виникнення:** документація `fastify-multipart` показує лише happy-path (`await req.file()` + `await data.toBuffer()`). Кейс "request НЕ multipart" не описаний — розробник інтуїтивно припускає що `req.file()` поверне `undefined`, тому ставить лише `if (!data) throw`. Насправді `req.file()` кидає, бо плагін різко відрізняє "файл не присутній у multipart" від "request взагалі не multipart". `tsc` мовчить (тип повертає `Promise<MultipartFile | undefined>` — кидок не у типах). Code review пропускає бо happy-path виглядає валідним. Виявляється лише contract-spec що шле запит БЕЗ multipart-body.
**Підхід до виявлення:** для кожного `*.controller.ts` з `@ApiConsumes('multipart/form-data')` ↔ переконатись що helper для отримання файлу (`getUploadedFile`, `extractFile`, тощо) обгорнутий у try/catch + мапить помилку у `BadRequestException` українською. Grep: `grep -rn "await req.file()" apps/api/src/modules/` — кожен виклик має бути всередині try/catch АБО у helper що це робить. Contract spec має кейс «POST без multipart → 400».
**Підхід до фіксу:** try/catch навколо `await req.file()` що мапить FastifyError у `BadRequestException(\`Файл не завантажено: <локалізована причина>\`)`. Особлива деталізація для `'not multipart'` випадку: «очікується multipart/form-data» (підказка фронт-розробнику). Фікс у helper покриває ВСІ endpoint-и одночасно — не потрібно правити кожен метод.
**Severity:** MEDIUM — функціональна i18n-помилка (406+EN замість 400+UA); ймовірне з міграції фронтенду на нову форму завантаження (хибний content-type) → користувач бачить "the request is not multipart" українським UI. Не втрата даних, але псує UX і моніторинг (406 на DataDog/Sentry виглядає як "клієнтський баг" замість "наш UX").
**Де шукати ще:** будь-який майбутній endpoint з multipart upload (інші файлові імпорти, аватари, attachments); будь-який FastifyError що мапиться у НЕ-400 (`FST_ERR_PAYLOAD_TOO_LARGE`→ 413,`FST_ERR_VALIDATION`→ 400 OK,`FST_ERR_INVALID_URL` → 400). Профілактика: helper для multipart завжди з try/catch; SKILL §1.5 contract-spec для нових import-endpoints вимагає кейсу «POST без multipart → 400 + укр. msg».

### 2026-05-30 — `prisma.X.update({ where: { id } })` без `orgId` у `data: { ...dto }`-вільному коді → defense-in-depth gap навіть коли потік org-trusted — backend, tenant-isolation

**Сигнал:** новий метод сервісу що пише у org-scoped таблицю (`good`, `counterparty`, `workOrder`...) через `prisma.X.update({ where: { id } })` де `id` отриманий через раніше org-scoped read (`findFirst({ orgId })` АБО з parent-relation що org-scoped). Потік **локально безпечний** (id вже org-trusted), але `where` не містить `orgId`. Якщо хтось у майбутньому скопіює патерн у controller з прямим `body.goodId` (без org-перевірки) — буде cross-tenant write **БЕЗ помилки** бо Prisma `update({ where: { id } })` працює для будь-якого id який існує. Симетрично з Bug #161 (FK у `data: { ...dto }`) — але тут не FK, а primary key самого об'єкта.
**Причина виникнення:** Prisma не дозволяє compound where на primary key (`update({ where: { id, orgId } })` — TS error: `id` має бути окремо). Тому розробник пише `update({ where: { id } })` бо так працює. Альтернатива (`updateMany({ where: { id, orgId } })`) повертає `{ count }` замість `T` — менш зручно. У результаті розробник вибирає простий `update` і покладається на «id уже org-trusted».
**Підхід до виявлення:** після кожного diff що додає `prisma.X.update({ where: { id`... у new feature service → запитати: «якщо рефакторити цей сервіс і витягти `update`-логіку в окремий метод що приймає `id` напряму від API без org-перевірки — що станеться?». Якщо **cross-tenant write пройде без error** — це defense-in-depth gap. Grep: `grep -rn "\.update({ where: { id:" apps/api/src/modules/` → кожен match перевірити чи `where` містить `orgId`.
**Підхід до фіксу:** замінити `update({ where: { id } })` на `updateMany({ where: { id, orgId, deletedAt: null } })`. Втрачаємо повернений `T`, але отримуємо `{ count }` — можна додати `if (count === 0) throw new NotFoundException(...)` як перевірку результату. Якщо сервіс потребує оновлений запис — додатковий `findFirst` після `updateMany` (1 додатковий запит). Для batch — `updateMany` зазвичай і так використовувався, не потрібно міняти.
**Severity:** LOW — поточний код безпечний; це **profilatic defense-in-depth**. Може стати CRITICAL якщо хтось скопіює патерн у контролер без org-check.
**Де шукати ще:** будь-який `update`/`upsert` на org-scoped таблиці (Good, Counterparty, WorkOrder, Invoice, StockItem, PriceHistory, Payment, тощо); особливо service-методи що пишуть у "довідник" (`Brand`, `Unit`, `Warehouse`) — там часто id з body напряму. Профілактика: SKILL §1.1 тепер вимагає `updateMany({ where: { id, orgId } })` для defense-in-depth, навіть коли локальний потік org-trusted.

### 2026-05-30 — Boundary-кейси відсутні для діапазонних правил (COST_TIER half-open) → регресія `<=`/`<` беззвучна — backend, test-coverage

**Сигнал:** новий backend-feature з range-based logic (`min <= x < max`, `<=`/`<` boundary) — pricing tiers (COST_TIER), age brackets, tax brackets, sliding-scale discount. Spec покриває «typical» кейси (`x` посередині діапазону), пропускає **граничні** значення (`x === min`, `x === max`, `x === 0`, `x < найменшого min`). Реалізація працює бо boundary рідко проходимий код; регресія типу `>=` → `>` АБО `<` → `<=` змінює semantics беззвучно — жоден існуючий тест не падає.
**Причина виникнення:** розробник пише spec за «прикладами з вимог» — клієнт каже «50 у тірі [0,100]», «200 у тірі [100,500]» — це є у specі. Boundary («що буде з cost=100 — у нижньому чи верхньому тірі?») формально не описано, тому й тест не пишеться. Це навіть НЕ defensive omission — це просто «не подумали». В оригінальних вимогах часто пишуть «від X до Y» без уточнення inclusive/exclusive, що залишає простір для регресії.
**Підхід до виявлення:** для кожного нового сервісу/функції що містить range comparison (`>= min && < max` або варіанти) — переконатись що spec має ВСІ 4 boundary тести: (1) `x === min` тіру (найнижча точка діапазону, нижня межа включена); (2) `x === max` тіру (точна верхня межа, має перейти у наступний тір якщо half-open); (3) `x === 0` (для non-negative величин — баг типу `cost > 0` замість `cost >= 0` мовчки виключить нуль); (4) `x` поза будь-яким діапазоном (`< найменшого min` АБО `> найбільшого max` коли немає null-tail) → fallback на raw value. Без цих 4 тестів — спека не покриває core semantics, лише happy path.
**Підхід до фіксу:** додати 4 окремих `it()` у відповідний `describe` блок. КОЖЕН boundary — окремий тест (не один з 4 expects), щоб при майбутньому падінні було видно ЯКА саме межа зламана. Назви тестів літерально містять `cost=0`, `cost точно на верхній межі`, `cost===costMin`, `tiers=[]` — це документація.
**Severity:** MEDIUM — production-код працює, але регресія потенційно псує дані в БД (неправильна ціна, неправильний податок) без жодного error/warning.
**Де шукати ще:** будь-який сервіс ціноутворення/скидок/податків з tier-based або bracket-based логікою; age-based pricing у insurance/booking; volume-based shipping; quantity-based discounts; будь-яке `if (x >= A && x < B)` у бізнес-логіці. Профілактика: SKILL §1.5 unit-test матриця тепер вимагає boundary-кейсів для діапазонних правил.

### 2026-05-30 — Cross-tenant FK у contract-spec не покритий для optional payload FK (новий FK у DTO без regression-захисту на HTTP-рівні) — backend, test-coverage, security

**Сигнал:** новий optional FK у `*.dto.ts` (`brandId?: string`, `vehicleId?: string`...) + новий патерн у контролері `if (dto.XId) { const x = await prisma.X.findFirst({id: dto.XId, orgId, deletedAt:null}); if (!x) throw new NotFoundException(...) }` (Bug #161 захисний патерн). Контролер коректний, але contract spec для цього controller-endpoint НЕ асертить (а) що `findFirst` справді викликаний з `orgId`, (б) що 404 для cross-tenant FK, (в) що `prisma.X.create/update` НЕ викликаний при failed FK-перевірці. Регресія (видалення `if (dto.XId)`-блоку під «спрощення», прибрання `orgId` з findFirst-where, заміна `NotFoundException` на early return) пройде усіх існуючих тестів зеленою → cross-tenant linkage у production без error/warning.
**Причина виникнення:** розробник пише FK-валідацію у контролері і думає «це service-логіка, contract spec тестує HTTP-shape». Contract spec мокає Prisma (`prismaMock`) — додавання тесту вимагає налаштувати `prismaMock.brand.findFirst.mockResolvedValueOnce(null)` для cross-tenant сценарію + `expect(prismaMock.X.create).not.toHaveBeenCalled()` — це додаткова робота. Service-spec теж не покриває бо валідація живе у КОНТРОЛЕРІ (через `prisma` injected у controller), не у service. Між service-spec і contract-spec випадає вікно — controller validate logic без покриття.
**Підхід до виявлення:** на Кроці 1 §1.5 — для кожного `*.controller.ts` що містить `if (dto.XId) { const x = await this.prisma.X.findFirst(...); throw new NotFoundException(...) }` патерн → перевірити чи `*.contract.spec.ts` має 3 тести для КОЖНОГО таким захищеного FK: own-org→success, other-org→404, PATCH-other-org→404. Grep: `grep -n "if (dto\.[a-zA-Z]*Id)" apps/api/src/modules/**/*.controller.ts`; для кожного match шукати у відповідному `*.contract.spec.ts` тест зі `mockResolvedValueOnce(null)` на цьому моделі і `expect(prismaMock.X.create).not.toHaveBeenCalled()`. Якщо немає — gap.
**Підхід до фіксу:** додати 3 контракт-тести з мок-схемою:

```typescript
prismaMock.brand.findFirst.mockResolvedValueOnce(null); // інша org
const res = await app.inject({
  method: 'POST',
  url: '/...',
  payload: { brandId: 'cross-tenant-uuid' },
});
expect(res.statusCode).toBe(404);
expect(res.json().message).toMatch(/Бренд не знайдено/);
expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
```

Кожен FK = +3 тести (POST own, POST other, PATCH other). Документує contract і ловить регресію.
**Severity:** MEDIUM — production коректний на момент написання, але нуль захисту від регресії. Якщо регресія станеться у tenant-isolation — це HIGH (cross-tenant data linkage). MEDIUM = profileactic.
**Де шукати ще:** будь-який модуль з optional FK у DTO + `findFirst(orgId)` у controller (не service): pricing-rules brandId/goodId (POST+PATCH), invoices counterpartyId/vehicleId, work-orders branchId, purchase-orders supplierId, будь-який майбутній модуль що додає preferredSupplierId/warehouseId. Профілактика: SKILL §1.5 тепер вимагає cross-tenant FK тестів у contract-spec.

### 2026-05-30 — Custom hook з useEffect/apiFetch/localStorage без unit-тесту → беззвучна регресія persistence/race-protection — frontend, test-coverage

**Сигнал:** новий `apps/web/src/hooks/use*.ts` що: (а) має `useEffect` що викликає `apiFetch`/`fetch`/`localStorage`; (б) повертає imperative API (`toggle`, `reset`, `save`); (в) використовує `AbortController`/`cancelled`-flag/`mountedRef` для race-protection. Без `*.test.tsx` — нуль захисту від регресії: AbortController можна видалити «під спрощення», cancelled-flag можна забути після рефактору effect, mountedRef можна викинути коли «здається не потрібним». Усі ці регресії — runtime races що НЕ ловить tsc, code review (locally виглядає валідно), і ловить лише user-bug-report.
**Причина виникнення:** розробник пише hook як «звичайну логіку» і думає що component-тест pages що використовують hook покриє його. Але component-тест для page що використовує hook — мокає сам hook (інакше потрібно мокати весь fetch ланцюг). Тому hook сам залишається непокритий. Хук «надто маленький» для окремого тесту згідно з інтуїцією, але `useEffect` + `apiFetch` + `localStorage` + `AbortController` = 4 окремих race-гілки які треба перевірити.
**Підхід до виявлення:** при будь-якому новому `apps/web/src/hooks/use*.ts` — переконатись що існує парний `use*.test.tsx`. Шаблон: `useSavedFilters.test.tsx` (`renderHook` + `act`, `localStorage.clear()` у `beforeEach`, mock `apiFetch` через `vi.mock('@/lib/api-client', ...)`). Мінімум тестів: (1) початковий стан; (2) optimistic read з localStorage до резолву API; (3) resolve API → state оновлюється; (4) reject API → fallback зостається; (5) imperative API (toggle/save/reset) працює; (6) race-protection (rapid call → попередній abort-нутий АБО signal.aborted=true); (7) різні pageKey/instance ізольовані.
**Підхід до фіксу:** створити `use<Name>.test.tsx` за шаблоном. Mock `apiFetch` через `vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn() }))`. Для AbortController-тесту: захопити signals через `apiFetchMock.mockImplementation((url, init) => { signals.push(init.signal); return new Promise(() => {}); })` — це показує що `signal.aborted` справді змінюється при rapid sequential calls.
**Severity:** MEDIUM — production-код може бути коректним, але hook керує persistence/network — регресія беззвучна і виявиться лише через втрачені дані або memory-leak warning у консолі.
**Де шукати ще:** будь-який майбутній hook з мережею (useGoodsAutocomplete, useNotifications, usePolling) АБО з persistence (useColumnConfig, useTablePagination, useFilters). Профілактика: SKILL §1.6 тепер вимагає `*.test.tsx` для нових hooks з `useEffect`/`apiFetch`/`localStorage`.

### 2026-05-30 — JSON/Record DTO поле без @IsObject() → знімається whitelist:true → undefined в сервісі — backend

**Сигнал:** `UpsertXDto.value: Record<string, unknown>` (або будь-яке JSON/object поле) без жодного class-validator декоратора. `ValidationPipe({ whitelist: true })` видаляє з body будь-яку властивість що НЕ має принаймні одного decorator — навіть якщо поле TypeScript-типізоване. Сервіс отримує `dto.value === undefined` → Prisma `upsert`/`create` з `value: undefined` → TypeError або запис `null` замість реального конфігу.
**Причина виникнення:** розробник типізує поле через TypeScript (`value!: Record<string, unknown>`) вважаючи що тип = гарантія. `tsc` не скаржиться. Тест з MockService не доходить до ValidationPipe. Баг виявляється лише через `PUT /user-preferences/:key` у runtime — сервер приймає 204 але записує `null`/`undefined`. Особливо часто на JSON/blob полях де немає природного `@IsString()` / `@IsNumber()` / `@IsBoolean()` — розробник не думає "треба @IsObject()".
**Підхід до виявлення:** для кожного нового `*.dto.ts` — переконатись що КОЖНЕ поле класу (не тільки string/number) має принаймні один `class-validator` декоратор. Спеціально шукати поля типу `Record<string, unknown>`, `object`, `Json`, `T extends object` — вони найчастіше залишаються без декоратора. Grep: `grep -A1 "value!:\|value?:" apps/api/src/modules --include="*.dto.ts" | grep -v "@Is\|@Max\|@Min\|@Array\|@Validate\|class-validator"`. Також: contract spec з `PUT /... payload: { key: 'x' }` (без `value`) повинен повертати 400 — це ловить відсутній `@IsObject()`.
**Підхід до фіксу:** `@IsObject({ message: 'Значення має бути об\'єктом' })` перед `value`. Якщо поле опціональне — додати `@IsOptional()` перед `@IsObject()`. Для вкладених об'єктів із відомою структурою — `@ValidateNested()` + `@Type(() => XClass)`. Для довільного JSON без схеми — `@IsObject()` достатньо (гарантує що це об'єкт, не примітив/масив).
**Severity:** HIGH — функціональний баг: PUT приймається (204) але нічого не зберігається; без `@IsObject()` whitelist знімає поле мовчки → данні псуються без будь-якого сигналу.
**Де шукати ще:** будь-який DTO з JSON-полем (rateScheme, uiFeatures, metadata, config, settings, payload, extra); webhooks DTO з payload; будь-який новий DTO де field-тип не є примітивом string/number/boolean/Date. Особливо: `settings.dto.ts` вже має `@IsObject()` на `uiFeatures` — використати як зразок.

### 2026-05-30 — apiFetch generic type mismatch: очікує масив, endpoint повертає {items,total} — frontend

**Сигнал:** `apiFetch<X[]>('/endpoint').then(setX)` де `setX` — `Dispatch<SetStateAction<X[]>>`. При монтуванні `X[]` фактично отримує об'єкт `{ items: X[], total: number }` → `x.map is not a function` TypeError → Select порожній або fetch-помилка ковтається. `tsc` мовчить бо generic параметр `T` у `apiFetch<T>` — лише assertion, не runtime validation. Баг виявляється лише у runtime.
**Причина виникнення:** STO ERP має дві конвенції для довідникових endpoints: (1) `{ items, total }` — стандарт (brands, goods, pricing-rules, тощо); (2) bare array — виняток для деяких `/branches` (спеціальний endpoint). Розробник, знаючи про `/branches → bare`, помилково поширює цей патерн на `/brands`, або навпаки — знаючи про `{items}` стандарт, не перевіряє конкретний контролер. `tsc` не ловить (`apiFetch<T>` довіряє generic T без runtime-перевірки).
**Підхід до виявлення:** для кожного нового `apiFetch<X[]>('/endpoint')` (де X — не пагінований тип) — прочитати `*.controller.ts` endpoint-а і перевірити що саме повертає сервіс (bare array або object). Grep `apiFetch<[A-Za-z]*\[\]>` у всіх page.tsx і звірити кожне. Known виняток: `/branches` → bare array (fbe66ad); всі решта list-endpoints → `{ items, total }`.
**Підхід до фіксу:** `apiFetch<{ items: X[]; total: number }>('/endpoint').then(r => setX(r.items))`. Якщо endpoint реально повертає bare array — типизувати правильно і не чіпати; якщо потрібен `total` для пагінації — додати у state.
**Severity:** MEDIUM — brands Select порожній без feedback; якщо fetch у `Promise.all` — падіння ковтає також сусідній goods-fetch.
**Де шукати ще:** будь-яка нова довідникова сутність що додається до форми (units, warehouses, employees, payment-methods); будь-яка сторінка де `apiFetch<T[]>` на endpoint що не `/branches`.

### 2026-05-30 — Bulk-apply scope-inconsistency після додавання нового scope-поля — backend, business-logic

**Сигнал:** метод `applyRuleToGoods` / `applyRuleToAll` / `bulkRecalc` будує `where`-умову для `findMany` що відображає scope правила (`goodId`/`goodCategory`/`goodType`), але не включає нове щойно-додане scope-поле (`brandId`). Результат: правило brand-scoped застосовується до ВСІХ товарів org замість лише тих що мають цей бренд.
**Причина виникнення:** нове scope-поле додають до моделі та до `calculateSalePrice` (яка правильно фільтрує через OR+find), але `applyRuleToGoods` має свою `where`-умову окремо — її не оновлюють синхронно. Розробник думає «логіку ціноутворення виправив», але bulk-apply ще досі широкий. Ніякого TS-error нема (Prisma where-об'єкт валідний без нового поля). Тест `applyRuleToGoods` мокає `findMany` і не перевіряє форму `where`.
**Підхід до виявлення:** після будь-якого commit що додає нове scope-поле у `PricingRule` (або аналогічну ruling-модель) — знайти в тому ж сервісі всі методи що будують `where`-умову для `findMany` по сутності якою правило управляє. Звірити `where`-поля зі scope-полями правила. Будь-яке scope-поле відсутнє у `where` = bug.
**Підхід до фіксу:** `...(rule.newScopeField && !rule.higherPriorityField ? { newScopeField: rule.newScopeField } : {})` — аналогічно існуючим scope-полям. Додати service-spec що мокає `findMany` і асертить форму `where.brandId` для brand-scoped правила.
**Severity:** HIGH — перерахунок ціни для невідповідних товарів → неправильна salePrice у БД; дані псуються без будь-якого error.
**Де шукати ще:** будь-який bulk-apply метод у pricing, promotion, discount, tax-rate сервісах що мають multi-field scope; будь-який `applyToAll` / `recalculateAll` що самостійно будує `where` замість делегування у `calculateX`.

### 2026-05-30 — Нова browser-API залежність у shared-компоненті без jsdom-стабу → каскадне падіння всіх тестів які монтують компонент — frontend, test-coverage

**Сигнал:** після введення `new ResizeObserver(...)` / `new IntersectionObserver(...)` / `new MutationObserver(...)` / `matchMedia(...)` у `useEffect` shared-компонента (Modal, Drawer, Tooltip, Combobox, будь-що з `components/ui/`) — раптово N component-тестів які раніше були зеленими падають з `ReferenceError: X is not defined`. Падіння — НЕ у тесті самого компонента, а у тестах ДОВКОЛА (`getByText` → "not found", бо React error-boundary unmount-ить дерево після useEffect-exception). Виявляється ТІЛЬКИ при повному прогоні web-suite на Кроці 0, бо TypeScript мовчить (типи `ResizeObserver`/`IntersectionObserver` живуть у `lib.dom.d.ts` — завжди present), а dev/prod сервер коректний (браузер має API нативно).
**Причина виникнення:** розробник додає browser-API у компонент щоб реалізувати "розумну" поведінку (анімація висоти за scrollHeight, lazy-load при появі в viewport, реакція на theme-change). Локально все працює бо браузер має API. jsdom (environment Vitest для web) — мінімальна реалізація DOM що НЕ містить більшості Observer API. Setup-файл історично стабав лише те що падало раніше (`scrollIntoView`); новий API не покритий — повторюється історія "jsdom doesn't implement X" з кожним новим Observer. Code review пропускає бо локально файл валідний; `tsc` пропускає бо типи в `lib.dom`. Падіння виявляється аж на повному `vitest run`.
**Підхід до виявлення:** при будь-якому diff у `components/ui/` шукати `new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver|BroadcastChannel)\(`, `window\.matchMedia\(`, `navigator\.(clipboard|share|wakeLock|geolocation|mediaDevices)`, `crypto\.subtle`, `IndexedDB`, `Notification\(`. Для кожного співпадіння — перевірити чи `apps/web/src/__tests__/setup.ts` стабає це API. Якщо ні → preempt-fix (додати стаб ДО того як тест впаде у baseline). Альтернативно: ЗАВЖДИ ганяти web-suite на Кроці 0 (вже у SKILL з 2026-05-29) — це ловить пропуск.
**Підхід до фіксу:** додати noop-клас-стаб у setup.ts під guard-ом `typeof globalThis.X === 'undefined'` (захист щоб у jsdom-версіях що отримають реальну реалізацію не перетирати). Не стабати у самому компоненті (захаращує prod-код); не вимикати тест (приховує реальні регресії). Для observable API (ResizeObserver, IntersectionObserver) — noop observe/unobserve/disconnect достатньо: тест перевіряє render-логіку, не саму анімацію.
**Severity:** HIGH — release-blocker через червоний baseline; ховає реальні регресії за шумом і блокує наступні AUTO-сесії (баг "хибно-червоний" симетричний до "хибно-зеленого" з 2026-05-29).
**Де шукати ще:** будь-який майбутній компонент з нативним browser-API; модальні/drawer/tooltip-системи (часто додають Observer-based layout); календарі/timeline (як calendar/page.tsx); virtual-list/auto-scroll; реактивні до viewport компоненти (responsive nav, sticky header). Профілактика: тримати у setup.ts ВСІ стандартні Observer-стаби незалежно від того чи використовуються — preempt-cost ~30 рядків, ловить весь клас багів.

### 2026-05-29 — Component-vs-test drift + web-suite поза baseline → червоний тест невидимий до Кроку 4 — frontend, test-coverage, process

**Сигнал:** на повному прогоні web-suite (Крок 4) падає component-тест на `getByText('...')`/`getByRole(...)` — елемент не знайдено. Тест НЕ зачеплений scope-коммітами поточної сесії (інший компонент). Часто: тест асертить empty-state hint / label / placeholder, якого компонент при певному стані (`saved=[]`, `items.length===0`) НЕ рендерить. Прихований під час Кроку 0 якщо baseline ганяв лише `pnpm --filter @sto/api test` і пропустив `@sto/web vitest run`.
**Причина виникнення:** дві накладені причини. (1) Крок 0 у старій версії SKILL запускав тільки API-suite → web-регресії невидимі до фінальної верифікації. (2) Компонент і його тест розійшлися: розробник прибрав/змінив UI-елемент (hint, бейдж, текст) у компоненті, але тест лишився асертити старий стан — АБО тест написали наперед під намір, який у компоненті так і не реалізували. `tsc` мовчить (типи цілі). Code review пропускає (кожен файл локально валідний). Виявляється лише запуском саме цього тесту.
**Підхід до виявлення:** ЗАВЖДИ ганяти ОБИДВА suite у Кроці 0 (API + web), навіть для docs-only/backend-only scope — червоний web-baseline блокує сесію так само як API. При падінні component-тесту — прочитати І тест, І компонент: чи компонент справді рендерить очікуваний елемент у тому стані що тестується? Якщо ні — це drift, не flaky.
**Підхід до фіксу:** вирішити чий намір правильний. Якщо тест документує легітимний UX (показати «Немає X» коли список порожній) → виправити КОМПОНЕНТ (повернути елемент під правильною умовою — звернути увагу на додаткові гейти у назві тесту, напр. «...і не відкритий save dialog» → умова `empty && !saveOpen`). Якщо UX свідомо прибрали → оновити тест. Не глушити тест і не лишати червоним.
**Severity:** MEDIUM — не runtime-bug на момент, але червоний baseline ховає реальні регресії за шумом і блокує наступні сесії (як docs-only хибно-зелений, лише навпаки — хибно-червоний).
**Де шукати ще:** будь-який `components/ui/*.test.tsx` після рефактору компонента (видалення/перейменування елементів, зміна умов рендеру); empty-state/loading hint-и; будь-який тест з `getByText`-літералом який легко розсинхронити з компонентом. Профілактика: Крок 0 завжди ганяє web-suite.

### 2026-05-29 — `[x] виправлено` без парного code-diff (docs-only commit) → хибно-зелений приховує release-blocker — process, test-coverage

**Сигнал:** BUG_REPORT.md має нещодавні баги з `**Статус:** [x] виправлено`, але `git log --stat` останнього `fix(tester)`/tester-commit показує що змінено ЛИШЕ `MemoryManual.md`/`BUG_REPORT.md` (docs-only) — жодного файлу з коду/конфігу. Перевірка реального файлу за вказаним `Файл: ...:рядок` показує що дефект ЖИВИЙ (healthcheck все ще `/health`, `.dockerignore` все ще відсутній тощо). Часто з'являється коли попередня сесія коректно ПРОаналізувала баги, написала фікс-опис, але через переривання/rate-limit/помилку не застосувала Edit/Write і одразу перейшла до фінального docs-commit, поставивши `[x]` «за планом».
**Причина виникнення:** агент-тестувальник ставить `[x]` на основі НАМІРУ виправити (фікс описаний у звіті), а не на основі застосованого diff. Якщо між «записати звіт» і «застосувати фікс» стається переривання, або кроки переплутані місцями, статус і робоче дерево розходяться. Наступні сесії читають `[x]` + MemoryManual «5 bugs fixed» і вважають стек готовим — особливо небезпечно для CRITICAL deploy-блокерів, які ніхто більше не перевіряє бо «вже вирішено».
**Підхід до виявлення:** на Кроці 0, ПЕРЕД новим аналізом — пройти останні N `[x]`-багів BUG_REPORT і для кожного звірити реальний файл проти опису. Не довіряти статусу. Швидкий тест: чи останній tester-commit змінив код, чи лише `*.md`? Docs-only tester-commit з купою `[x]` поряд = червоний прапор. `[x]` = «diff застосовано І верифіковано (tsc/test/`docker compose config`)», не «фікс описано».
**Підхід до фіксу:** реально застосувати кожен втрачений фікс (аналіз попередньої сесії зазвичай коректний — переюзати його); додати окремий meta-bug HIGH про хибний маркер щоб слід лишився; правило самій собі — ставити `[x]` ТІЛЬКИ після Edit/Write + проходження верифікації, ніколи «наперед».
**Severity:** HIGH (а якщо приховані баги CRITICAL — фактично CRITICAL): хибно-зелений гірший за відкритий баг бо знімає увагу з блокера.
**Де шукати ще:** будь-яка сесія що завершилась docs-only commit-ом при наявності щойно-доданих `[x]`; будь-який HEAD що вказаний у завданні РАНІШЕ за останній «fix»-commit (ознака що «фікс» був лише записом); infra/deploy багами особливо (їх не перевіряють unit-тести → легко лишити невиправленими непомітно).

### 2026-05-29 — Container healthcheck шлях/бінарник не узгоджений з образом і globalPrefix → стек не стартує — backend, deploy

**Сигнал:** `docker-compose.yml` healthcheck `test: ["CMD", "curl", "-f", "http://localhost:PORT/health"]` для сервісу чий образ — `node:20-alpine` (немає curl) АБО чий застосунок робить `setGlobalPrefix('api')` (реальний шлях `/api/health`, не `/health`). Інші сервіси мають `depends_on: <api>: { condition: service_healthy }` → якщо healthcheck назавжди FAIL, залежні сервіси НІКОЛИ не стартують → уся production-топологія мертва.
**Причина виникнення:** healthcheck пишуть «за звичкою» (`curl -f /health`) без перевірки (а) чи бінарник curl є у базовому образі (alpine-варіанти його НЕ містять), (б) чи шлях збігається з реальним роутом після `setGlobalPrefix`/router-mount. Healthcheck не покривається unit-тестами і не запускається локально без `docker compose up` → дефект невидимий до спроби деплою.
**Підхід до виявлення:** для кожного healthcheck у compose — звірити (1) бінарник проти базового образу сервісу (alpine → НЕ curl/wget-gnu; node-образ → є `node`); (2) шлях проти `setGlobalPrefix`/router prefix застосунку (grep `setGlobalPrefix`, `app.use('/api'`, mount-prefix). Перевірити blast-radius: хто `depends_on ... service_healthy`?
**Підхід до фіксу:** для node-образів — list-form healthcheck через вбудований `http`: `["CMD","node","-e","require('http').get('http://localhost:PORT/REAL_PATH',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]` (без зовнішніх бінарників, offline-safe). Завжди узгодити шлях з globalPrefix. Додати `timeout`+`retries`.
**Severity:** CRITICAL — release-blocker; уся система не піднімається у production.
**Де шукати ще:** будь-який compose healthcheck на alpine-образі; `Dockerfile` `HEALTHCHECK` директива; `Update.ps1`/installer health-probe; будь-який сервіс за reverse-proxy з префіксом.

### 2026-05-29 — curl/wget healthcheck на НЕ-alpine образі без цих бінарників (minio/minio) → сервіс ніколи не healthy → каскад мертвий — backend, deploy

**Сигнал:** compose healthcheck `["CMD","curl","-f","http://localhost:9000/minio/health/live"]` (або `wget`) на сервісі чий образ — `minio/minio`. Емпірично: `minio/minio:RELEASE.2024-*` має ЛИШЕ `/usr/bin/mc`, НЕ curl, НЕ wget. curl → command-not-found → healthcheck назавжди FAIL → minio `unhealthy` → `api` (depends_on minio: service_healthy) НІКОЛИ не стартує → web→caddy каскад мертвий. Той самий blast-radius, що node-alpine+curl, але пропускається бо minio — НЕ alpine, тому «alpine→немає curl»-евристика на нього не спрацьовує.
**Причина виникнення:** popular minio docker-compose приклади з мережі досі показують `curl -f /minio/health/live` — копіюється «як є». Раніше старі minio-образи містили curl; сучасні distroless-варіанти його викинули, але healthcheck лишився. Попередня deploy-аудит-сесія перевірила node/alpine образи (Bug #164/#165), але minio пропустила бо не alpine. tsc/unit/`docker compose config` НЕ ловлять (config валідний, бінарник перевіряється лише при реальному `up`).
**Підхід до виявлення:** для КОЖНОГО compose healthcheck що використовує curl/wget — НЕ покладатись на «alpine vs не-alpine», а емпірично перевірити образ: `docker run --rm --entrypoint sh <image> -c "command -v curl; command -v wget; command -v mc"`. minio/minio, distroless, scratch-based, деякі mongo/redis-варіанти можуть не мати http-клієнта. Перевірити blast-radius: хто `depends_on … service_healthy`?
**Підхід до фіксу:** для minio — офіційний `["CMD","mc","ready","local"]` (mc бандлиться у server-образі, `local`-alias вбудований у самому контейнері minio — alias-setup НЕ потрібен; перевірено: exit 0 «The cluster is ready»). Запінити образ конкретним RELEASE-тегом для offline-відтворюваності (latest може знову змінити набір бінарників). Для інших образів без http-клієнта — TCP-probe або вбудований інструмент образу.
**Severity:** CRITICAL — release-blocker; уся production-топологія не піднімається.
**Де шукати ще:** будь-який compose healthcheck з curl/wget на НЕ-node образі (minio, mongo, elasticsearch, distroless); `docker-compose.dev.yml` (часто копія prod healthcheck — фіксити ОБИДВА); installer health-probe; будь-який майбутній сервіс який додають з copy-paste healthcheck.

### 2026-05-29 — Query-shape фікс (relation-ім'я / nested where) без service-spec → невидима регресія — backend, test-coverage

**Сигнал:** fix-commit (часто з повідомленням «fix PrismaClientValidationError on search») змінює **relation-ім'я** у вкладеному `where` (`customerGarage`→`customerGarages`, singular→plural), форму `some`/`every`/`OR`, або `include`/`select` shape. Прод-код тепер коректний, але парного **service-spec немає** — є лише `*.contract.spec.ts`, який реєструє `{ provide: XService, useValue: serviceMock }`. Mock повністю заміняє сервіс → реальний `where` ніколи не доходить до Prisma → регресія назад до неправильного relation-імені пройде всі тести зеленими і впаде тільки на runtime з 500/`PrismaClientValidationError`.
**Причина виникнення:** `PrismaClientValidationError` — це валідація форми запиту на рівні Prisma-клієнта (не TypeScript: `mode`, nested relation names, `some/every` приймаються типами як loose object). Розробник фіксить relation-ім'я, бачить що сторінка працює, і не додає тест бо «contract spec вже є». Але contract spec для list-endpoint майже завжди мокає сервіс (щоб не піднімати реальну БД) → він тестує HTTP-shape (`{items,total}`, 401, 400), а НЕ query-shape. Жоден рівень не виконує справжній `where`.
**Підхід до виявлення:** для кожного fix що чіпав `where`/`include`/`select`/relation-ім'я/`mode` — перевірити чи існує `*.service.spec.ts` (не лише `*.contract.spec.ts`). Якщо contract spec мокає сервіс (`useValue: serviceMock` / `PrismaService, useValue: {}`) і service-spec відсутній → query-shape gap. Не зараховувати contract spec як покриття query-логіки.
**Підхід до фіксу:** service-spec з реальним сервісом + Prisma-мок-шпигуном: `{ provide: PrismaService, useValue: { model: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) }, $transaction: (ops) => Promise.all(ops) } }`. Викликати `service.findAll(orgId, { q })` і асертити `findMany.mock.calls[0][0].where` — правильні relation-імена присутні, старі/singular відсутні (`expect(branch).not.toHaveProperty('customerGarage')`), nested `deletedAt: null`, tenant `orgId`. Якщо `findAll` обгорнутий у `$transaction([...])` — мок `$transaction` має виконати масив через `Promise.all`.
**Severity:** MEDIUM — прод-код коректний на момент фіксу, але нуль захисту від регресії; relation-ім'я легко зламати назад при наступному рефакторі → 500 для користувача без жодного сигналу в CI.
**Де шукати ще:** будь-який list-сервіс з пошуком `?q=` через nested relation (`work-orders` counterparty-search, `goods` через preferredSupplier, vehicles через garage); будь-який `where.OR` з `some`/`every`; модулі що мають лише `*.contract.spec.ts` без `*.service.spec.ts` (counterparties було таким до Bug #163).

### 2026-05-28 — Optional FK у spread без org-scoped перевірки → cross-tenant leak — backend, tenant-isolation

**Сигнал:** сервіс пише `data: { ...dto, orgId }` (або `data: dto` в update) де DTO має optional FK-поля (`brandId?`, `unitId?`, `preferredSupplierId?`, `vehicleId?`...), і сервіс НЕ робить `findFirst({ id: dto.XId, orgId })` перед write. Часто з'являється коли FK-поле щойно додали до DTO (раніше whitelist його зрізав, P2003 не виникав, тому ніхто не думав про валідацію). База даних має лише звичайний FK constraint без `orgId` у ньому.
**Причина виникнення:** розробник (і навіть review) вважає, що сирий DB foreign key constraint + маппінг P2003→400 у HttpExceptionFilter — достатній захист. Це хибно у multi-tenant: DB FK перевіряє лише що `id` існує ГЛОБАЛЬНО, не що він належить поточній org. Тому `brandId` з org-B спокійно пишеться у товар org-A — cross-tenant linkage без жодної помилки. P2003 спрацьовує ЛИШЕ для повністю неіснуючого ID, не для валідного-у-чужій-org. Review може свідомо написати «P2003 прийнятний» — і це справедливо для «not found», але мовчки пропускає cross-tenant вимір.
**Підхід до виявлення:** для кожного `*.dto.ts` знайти optional/required `*Id` поля що є FK на org-scoped таблицю. Для кожного — у відповідному сервісі перевірити чи `create`/`update` робить org-scoped `findFirst` перед записом. НЕ зараховувати P2003-маппінг як захист: явно поставити питання «чи FK з ІНШОЇ org пройде?». Якщо так — HIGH (tenant isolation), не MEDIUM.
**Підхід до фіксу:** приватний `validateFkReferences(orgId, dto)` — `Promise.all` з `findFirst({ id: dto.XId, orgId, deletedAt: null, select: { id: true } })` для кожного наданого FK; кинути `BadRequestException` українською з конкретною назвою сутності («Бренд не знайдено»). Викликати ПЕРЕД `create` і `update` (усталений патерн Bug #90 з invoices/work-orders). Перевіряти лише надані поля (`dto.XId ? findFirst : Promise.resolve(null)`).
**Severity:** HIGH — cross-tenant data linkage порушує CLAUDE.md правило #6 (tenant isolation); дані не псуються одразу, але один tenant бачить/посилається на довідники іншого.
**Де шукати ще:** будь-який сервіс з optional FK у DTO який пишеться через spread — work-orders (vehicleId/counterpartyId/branchId на create, не лише clone), purchase-orders, invoices, stock-documents, pricing-rules (goodId), будь-який новий модуль з `preferredSupplierId`/`brandId`/`warehouseId` у DTO. Особлива увага — коли FK-поле ЩОЙНО додали до DTO (як 5045007): новий шлях запису без валідації.

### 2026-05-28 — Swallowed fetch годує обов'язковий контрол → заблокований workflow — frontend

**Сигнал:** `apiFetch('/list').then(setX).catch(() => {})` де `X` рендериться у `<Select>` обов'язкового поля, а submit-кнопка має `disabled={!form.fieldFromX}`. Базовий §1.3 анти-патерн (порожній catch) присутній, АЛЕ наслідок гірший за звичайний «порожній стан»: якщо список не завантажився, користувач фізично не може заповнити обов'язкове поле → кнопка назавжди disabled, без жодного пояснення. Часто сидить поряд з іншим catch який review/tester вже виправив (двійник на тій самій сторінці).
**Причина виникнення:** background-loader для довідника (філії, склади, валюти) додають як «другорядний» fetch і ставлять noop-catch, не усвідомлюючи що цей довідник гейтить критичний submit. Severity недооцінюють бо «список просто порожній».
**Підхід до виявлення:** для кожного `.catch(() => {})` знайти setter у `.then()`, далі grep чи цей state рендериться у `<Select required>` або у `disabled={!...}`. Якщо так — escalate з LOW до MEDIUM. Не плутати з тру-опціональними довідниками (там LOW досить).
**Підхід до фіксу:** окремий `xError` state (НЕ form-level `error`, бо loader спрацьовує до відкриття модалки і покаже stale-error); `.catch` встановлює повідомлення; inline `<p className="text-xs text-destructive-text">` під контролом.
**Severity:** MEDIUM — не втрата даних, але повністю заблокований legitimate workflow без feedback.
**Де шукати ще:** будь-яка mini-форма «створити X інлайн» (calendar new-WO, work-order new-client), будь-який екран з каскадними селектами (counterparty→vehicle→branch).

### 2026-05-28 — Мертвий стан/handler після inline→shared-component рефактору — frontend

**Сигнал:** після того як inline-патерн (search-dropdown, picker, autocomplete) замінили на shared-компонент (`SearchPickerModal`, `Combobox`), старі `useState`/`useCallback`/`useRef` + їх cleanup-ефекти лишаються. Ознака №1: setter (`setWoOptions`) викликається ТІЛЬКИ всередині reset-ефекту `if (!open) setX('')` і всередині самого orphaned-handler — а value (`woOptions`) НІКОЛИ не читається у JSX. Ознака №2: handler (`searchWorkOrders`) визначено через `useCallback` але жоден `onChange`/`onClick` його не викликає. Ознака №3: cleanup-ефект `return () => clearTimeout(woTimeoutRef.current)` для ref що більше нікуди не пишеться.
**Причина виникнення:** рефактор-комміт додає новий компонент і нові fetcher-и (`fetchWoItems`), правильно перемикає JSX, але «про всяк випадок» лишає старий код. `tsc` без `noUnusedLocals` (типово для Next.js) НЕ повідомляє про unused const на рівні тіла компонента. Code review теж пропускає бо локально кожен рядок виглядає валідним.
**Підхід до виявлення:** для кожного фіче-префіксного `useState` (`woX`, `cpX`, `searchX`) перевірити двосторонньо: (а) setter викликається десь окрім reset-ефекту? (б) value читається у JSX/computed? Якщо обидва «ні» — мертвий. Для `useCallback`-handler — grep чи його ім'я з'являється поза рядком визначення. Не покладатись на tsc.
**Підхід до фіксу:** видалити повний кластер — стани + handler + orphaned `timeoutRef` + його cleanup-ефект; спростити reset-ефект до того що реально лишилось; зберегти спільні типи/інтерфейси якщо їх використовує новий fetcher.
**Severity:** LOW — не runtime bug (код недосяжний), але плутає аудит (як Bug #158 що «виправив» вже-мертвий catch) і несе ризик зомбі-регресії якщо хтось випадково під'єднає назад.
**Де шукати ще:** будь-яка сторінка де inline-autocomplete мігрував у shared picker; settings-вкладки після уніфікації; форми де select замінили на modal-picker.

### 2026-05-28 — Timeline drag/resize px→time без clamp → Invalid Date → RangeError — frontend

**Сигнал:** timeline/calendar/gantt UI з drag або resize, де handler конвертує pointer delta у decimal-hours (`origEndH + deltaH`) і потім будує `new Date(\`${date}T${decimalHoursToHHMM(h)}:00\`).toISOString()`. Якщо resize-гілка clamp-ить результат ТІЛЬКИ проти протилежного краю (`origStartH + 0.25`) але НЕ проти меж видимого вікна — `h`може вийти за`[firstHour, lastHour+1]`. `decimalHoursToHHMM(24.5)`→`"24:30"`, `decimalHoursToHHMM(-1)`→`"-1:00"`→`new Date("...T24:30:00")`= **Invalid Date** →`.toISOString()`кидає`RangeError`. Помилка ловиться try/catch у pointerUp → показує нерелевантне "Помилка оновлення" і нічого не надсилає на сервер.
**Причина виникнення:** розробник клампить нову координату проти бізнес-правила "мінімум 15 хв тривалість" (проти протилежного краю слоту), але забуває що видиме вікно (08:00–20:00) — теж межа. Draw-гілка зазвичай безпечна бо `pxToDecimalHours`вже clamp-ить у`Math.max(HOURS[0], Math.min(HOURS[last], raw))`; resize рахує **delta** окремою формулою `pxToHours`і цей clamp обходить.
**Підхід до виявлення:** для кожного timeline/gantt page знайти ВСІ converter-и px→time (draw, resize-start, resize-end, drag-move — це різні гілки!). Для КОЖНОЇ перевірити: чи результат clamp-нутий у`[windowStart, windowEnd]`перед`new Date()`. Не довіряти що «draw clamp-ить, отже resize теж» — це окремі формули. Тест-сценарій: перетягнути край максимально за межу вікна.
**Підхід до фіксу:** додати `WINDOW_START`/`WINDOW_END`константи; обгорнути кожну resize/drag координату у`Math.max(WINDOW_START, Math.min(WINDOW_END, val))`; додатково hard-clamp у самому converter-і (`decimalHoursToHHMM`: `Math.min(24\*60, Math.max(0, totalMin))`) як остання лінія оборони для майбутніх викликачів.
**Severity:** MEDIUM — не втрата даних (PATCH не надсилається), але resize мовчки ламається + misleading error; UX broken на легітимній дії.
**Де шукати ще:** будь-який майбутній gantt/timeline/scheduler/booking-grid; mobile-планшет екран з drag слотів; будь-який handler що будує ISO timestamp з user-керованої координати.

### 2026-05-28 — Стала spec після рефактору сервісу — backend, test-coverage

**Сигнал:** baseline unit ❌ при docs-only diff. Дві ознаки: (1) NestJS "Nest can't resolve dependencies of the XService (PrismaService, ?) ... at index [N]" → нова constructor-залежність не замокана у `Test.createTestingModule`; (2) `expect(spy).toHaveBeenCalledWith(...)` → "Number of calls: 0" коли spy реально не викликався бо `mockResolvedValueOnce(null)` спожився раніше ніж очікувалось.
**Причина виникнення:** perf/simplify commit змінює сервіс (додає `CacheService` у конструктор, АБО зводить `create()/update()` з N `findFirst` до одного single-round-trip), але парний `*.spec.ts` не оновлюється. Тести лежать «зеленими» в пам'яті розробника, реально падають при наступному прогоні. Docs-only сесія не торкає код, але baseline-прогін викриває борг.
**Підхід до виявлення:** для кожного `service.ts` зміненого за останні N commits — звірити: (а) кожен `private readonly X: Type` конструктора присутній як provider у спеці; (б) кількість `mockResolvedValueOnce` на `findFirst` = реальна кількість викликів у методі (читати сервіс, не вгадувати). Не довіряти "тести зелені були минулого разу" — запускати baseline ЗАВЖДИ (Крок 0), навіть для docs-only.
**Підхід до фіксу:** фіксувати ТЕСТ, не код (prod коректний). Додати мок-провайдер для нової залежності (`CacheService.get` → `null` щоб не ламати cache-miss fallthrough); привести `mockResolvedValueOnce` ланцюг до фактичної кількості викликів.
**Severity:** MEDIUM — не runtime bug, але CI/baseline червоний → блокує наступні сесії та ховає реальні регресії за шумом.
**Де шукати ще:** усі `*.service.spec.ts` сервісів що отримали `CacheService` у perf-раунді (brands, units, payment-methods, branches, zones, work-categories, bank-accounts, cash-registers, dashboard) — якщо спека існує і будує власний TestingModule, вона під ризиком того ж DI fail.

### 2026-05-28 — Soft-delete resurrection / P2002 — backend, unique constraints

**Сигнал:** `create()` на таблиці з `@@unique([orgId, X])` де X не включає `deletedAt` — soft-deleted рядок займає uniq index
**Причина виникнення:** `findFirst({ deletedAt: null })` вважається повною перевіркою, але soft-deleted рядок блокує DB unique constraint
**Підхід до виявлення:** `@@unique` без partial `WHERE deletedAt IS NULL` + `create()` без resurrection
**Підхід до фіксу:** `findFirst({ NOT: { deletedAt: null } })` → якщо знайшов: `update({ ...dto, deletedAt: null })` замість `create`
**Severity:** HIGH — P2002 → HTTP 500 замість ConflictException; дані не псуються але UX broken
**Де шукати ще:** будь-який новий довідниковий модуль з `@@unique([orgId, code/name/shortName])`

---

### 2026-05-28 — @db.Date timezone mismatch — backend, date handling

**Сигнал:** `new Date(dto.date)` де `dto.date` — ISO string з TZ offset → UTC-parse зміщує дату
**Причина виникнення:** `new Date(isoString)` завжди парсить у UTC; `@db.Date` очікує UTC midnight
**Підхід до виявлення:** шукати `new Date(dto.X)` де X — поле `@IsDateString()` що пишеться у `@db.Date` колонку
**Підхід до фіксу:** `parseDateOnly(dto.date)` — витягти `YYYY-MM-DD` перші 10 символів + parse UTC midnight
**Severity:** HIGH — неправильна дата в БД для клієнтів у UTC+X
**Де шукати ще:** exchange-rates, warranties, maintenance-schedules, будь-що з date-only полем

---

### 2026-05-28 — $transaction(array, { timeout }) не підтримується Prisma 5 — backend

**Сигнал:** `prisma.$transaction([...promises], { timeout: N })` — TS-помилка (timeout не в array-form)
**Причина виникнення:** array-form приймає тільки `{ isolationLevel }`, callback-form — `{ timeout }`
**Підхід до виявлення:** grep `\$transaction(\[` — якщо там `timeout` → баг
**Підхід до фіксу:** переписати array → callback-form (`async tx => { for ... }`)
**Severity:** MEDIUM — TS-помилка при build; runtime може відпрацювати але без timeout гарантії
**Де шукати ще:** pricing.service.ts, будь-який масив із `$transaction` де хотіли timeout

---

### 2026-05-28 — Prisma plural table → singular model lookup — backend, sync

**Сигнал:** dynamic `(prisma as any)[modelName]` де modelName — snake_case plural (`work_orders`) → `prisma.workOrders === undefined`
**Причина виникнення:** Prisma exposes singular camelCase (`workOrder`), не plural; `@@map` задає plural тільки для таблиці
**Підхід до виявлення:** grep `toCamel\|snake.*camel` + перевірити чи є explicit `TABLE_TO_MODEL` map
**Підхід до фіксу:** explicit `Record<tableName, modelKey>` + `if (!model) throw` (fail-fast)
**Severity:** CRITICAL — `TypeError: Cannot read properties of undefined` на runtime; `.catch()` не ловить синхронний access
**Де шукати ще:** sync.service.ts будь-який dynamic model lookup

---

### 2026-05-28 — BigInt у payload spread → JSON.stringify 500 — backend, sync

**Сигнал:** `payload = { ...row }` де row має `syncVersion BigInt` → `Fastify JSON.stringify TypeError`
**Причина виникнення:** `syncVersion: Number(row.syncVersion)` конвертує top-level, але `{ ...row }` копіює BigInt у payload
**Підхід до виявлення:** grep `payload.*\.\.\.row\|{ \.\.\.row }` у sync/pull endpoints
**Підхід до фіксу:** прохід по полях: `if (typeof v === 'bigint') Number(v)` — об'єднати з BLACKLIST в один цикл
**Severity:** CRITICAL — 500 при будь-якому sync pull з реальними даними
**Де шукати ще:** будь-який endpoint що spread-ить Prisma row напряму у response

---

### 2026-05-28 — CRON findMany без deletedAt: null на Organisation — backend

**Сигнал:** `organisation.findMany()` без `where: { deletedAt: null }` у CRON-job → обробляє видалені org
**Причина виникнення:** CRON-код пишеться без думки про soft delete — кожен tenant проходить без перевірки
**Підхід до виявлення:** grep `organisation.findMany` у `*.processor.ts` / `*.scheduler.ts` | grep -v "deletedAt"
**Підхід до фіксу:** `where: { deletedAt: null }` — завжди для findMany на Organisation у CRON
**Severity:** HIGH — мертві org отримують SMS/webhooks, витрачаються кредити
**Де шукати ще:** followup.processor, будь-який новий scheduler

---

### 2026-05-28 — Playwright fullyParallel + Next.js dev → SyntaxError race — frontend, E2E

**Сигнал:** `Invalid or unexpected token` у console-errors.spec при > 5 workers + Next.js dev server
**Причина виникнення:** Next.js dev компілює chunks on-demand; паралельні workers отримують partial JS
**Підхід до виявлення:** console-errors.spec з `fullyParallel: true` і > 5 routes → SyntaxError у браузері
**Підхід до фіксу:** `test.describe.configure({ mode: 'serial' })` + `beforeAll` warm-up на `/dashboard`
**Severity:** MEDIUM — flaky tests, не production bug
**Де шукати ще:** будь-який E2E файл що навігує > 5 routes у Next.js dev

---

### 2026-05-28 — .catch(() => {}) ховає loading/error стан — frontend

**Сигнал:** `apiFetch(...).then(setX).catch(() => {})` у mount useEffect → loading ніколи false, error ніколи set
**Причина виникнення:** розробник додає fetch поступово без рефакторингу loading/error шаблону
**Підхід до виявлення:** grep `.catch(() => {})` + перевірити чи є `setLoading(true)` + `setError`
**Підхід до фіксу:** канонічний шаблон: `let cancelled=false; setLoading(true); fetch.then(...).catch(setError).finally(() => !cancelled && setLoading(false)); return () => cancelled=true`
**Severity:** LOW-MEDIUM — UX broken (empty state замість error, loading spinner ніколи не зникає)
**Де шукати ще:** нові вкладки settings, будь-яка сторінка де fetch додавався інкрементально

---

## Що вже перевірено (не дублювати)

**Backend:**

- ✅ FSM transition map pattern (work-orders.fsm.ts)
- ✅ InventoryService guards (quantity=0, available < qty, RESERVATION_RELEASE)
- ✅ SettlementsService guards (CHARGE ↑, PAYMENT ↓)
- ✅ Soft-delete: всі основні сервіси
- ✅ Resurrection pattern: currencies, exchange-rates, brands, units, payment-methods
- ✅ Org-scoped FK validation перед write: goods (brandId/unitId/preferredSupplierId — Bug #161), invoices/work-orders clone (Bug #90)
- ✅ $transaction explicit timeout: всі interactive callbacks
- ✅ ParseUUIDPipe: всі :id параметри
- ✅ Security headers (X-Content-Type-Options, X-Frame-Options, HSTS via @fastify/helmet@11)
- ✅ SSRF guard: webhooks.processor (validatePublicUrl + redirect: 'manual')
- ✅ ArrayMaxSize: inspection.dto, webhook payload
- ✅ Deploy/infra (phase18): docker-compose api healthcheck node-http /api/health (Bug #164/#165); minio healthcheck `mc ready local` замість curl-less образу + пін RELEASE-тегу (Bug #170); root .dockerignore (Bug #166); build-prod.ps1 export→apps/web/out + $PSScriptRoot fallback (Bug #167); nginx \_next/static immutable + gzip_types svg/js (Bug #168). /api/health публічний (HealthController без @UseGuards, auth per-controller) → healthcheck 200. minio/minio = лише mc, НЕ curl/wget (перевірено емпірично)

**Frontend:**

- ✅ cancelled flag: AuthProvider, всі mount-fetches (settings, crm, work-orders)
- ✅ SSR-safe today: useState(null) + useEffect → setToday(new Date())
- ✅ apiFetch error array join: `Array.isArray(msg) ? msg.join('; ') : msg`
- ✅ UUID validation client-side перед submit
- ✅ aria-label на іконкових кнопках (після bulk-fix)
- ✅ React named imports (не React.ReactNode)
- ✅ React Query Sprint B: QueryClient singleton (staleTime 30s, retry 1, refetchOnWindowFocus false); 5 query hooks (workOrders/invoices/counterparties/inventory/purchaseOrders) з queryKey factory; cross-resource invalidation покриває PO receive→inventory, PO apply-pricing→inventory, work-orders create→workOrders (Bug #210-#212); useWorkOrders.test.tsx як зразок query-hook tests (12 кейсів — queryKey factory, enabled gate, URLSearchParams build, signal abort)

**Tests:**

- ✅ Contract specs: auth, work-orders, warehouses, counterparties, sync, settings, audit, pricing-rules, batches, currencies, bank-accounts, exchange-rates, cash-registers, calendar (GET/POST/PATCH/DELETE — resize/drag PATCH endpoint)
- ✅ Service specs (query-shape): goods (FK validation), counterparties (?q= plural relation customerGarages→vehicles — Bug #163), work-orders (findAll calendarSlots include: plural relation + take:1 + deletedAt + orderBy asc; ?q= counterparty nested; employeeId some soft-delete — Bug #171)
- ✅ Pricing service specs: COST_TIER tier matching (first/mid/last/none), brandId priority over goodType (Bug #179)
- ✅ Calendar timeline px→time clamp: усі гілки (draw/pending-resize/saved-resize/drag) clamp у [WINDOW_START,WINDOW_END]; isEditingPast minHour-boundary (slot==minHour → НЕ past)
- ✅ Property-based invariants: inventory, settlements, FSM (26 invariants)
- ✅ Component tests: 148/148 passed (14 файлів)
- ✅ E2E: 42/42 passed (smoke, console-errors serial mode, inventory, api-errors)
