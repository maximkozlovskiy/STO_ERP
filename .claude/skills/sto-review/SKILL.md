---
name: sto-review
description: >
  Perform a thorough code review of STO ERP changes. Use when the user says "зроби code review", "перевір код", "review PR", or after implementing a feature. Reviews cover: correctness, security, memory leaks, performance, TypeScript quality, NestJS/Next.js/Expo conventions, business rule compliance, sync-readiness.
model: claude-opus-4-7
bypassPermissions: true
---

# sto-review — Code Review Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

**Все виконується без питань.** Алгоритм:

```
1. Крок 0 — контекст (git diff + scope)
2. Крок 1 — §1 TypeScript (завжди)
3. Крок 2 — секції за матрицею типу зміни
4. Крок 3 — виправити всі знайдені проблеми
5. Крок 4 — tsc 0 errors + git commit
6. Крок 5 — оновити MemoryManual.md
7. Крок 6 — самовдосконалення: записати нові підходи
```

> Не питай дозволу між кроками. Фіксуй одним реченням що робиш.

---

## Крок 0 — Контекст

```bash
# Scope та тип змін
git diff HEAD --name-only | head -30
CHANGED=$(git diff HEAD --name-only | wc -l)
echo "Змінено файлів: $CHANGED"

# Читай стан проєкту
cat MemoryManual.md | head -50
```

**Матриця: тип зміни → секції що запускати**

| Тип зміни | Обов'язкові секції | Пропустити |
|---|---|---|
| Новий `@Controller` | §1, §2.1, §2.2, §2.3, §4, §13 | §3, §6, §9, §10, §11 |
| Новий `*.service.ts` | §1, §4, §5, §6, §7.1 | §2, §8 |
| Нова Prisma модель | §1, §6, §9 | §2, §3, §5, §8 |
| Зміна `toResponseDto` | §1, §13 | всі інші |
| Нова `page.tsx` | §1, §3.1, §8 | §2, §4, §5, §6, §9 |
| Новий `*.dto.ts` | §1, §2.3, §2.4 | §3, §4, §5, §6 |
| Зміна BullMQ | §1, §2.5, §10 | §3, §4, §6, §8 |
| Новий `use*.ts` хук | §1, §3.1 | §2, §4, §5, §6, §9 |
| Новий `components/ui/` | §1, §8.5 | §2, §4, §5, §6, §9 |
| Config / docs / tests | §1 (tsc) — тільки | всі інші |

---

## Крок 1 — §1 TypeScript (завжди)

```bash
# Web — ОБОВ'ЯЗКОВО --incremental false (кеш приховує помилки)
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false

# API
pnpm --filter @sto/api exec tsc --noEmit

# Shared / UI
pnpm --filter @sto/shared exec tsc --noEmit

# React namespace без named import (→ VSCode errors, tsc може мовчати)
grep -rn "React\.\(ReactNode\|CSSProperties\|ChangeEvent\|FormEvent\|MouseEvent\|HTMLAttributes\|SVGAttributes\)" \
  apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "//\|spec"

# any типи
grep -rn ": any\b" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx" | grep -v "as unknown as\|spec"

# console.log у production коді
grep -rn "console\.log\b" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx" | grep -v "spec\|//.*console"

# Tailwind 4 — застарілі форми замість canonical tokens
grep -rn "\[var(--\|(--color-" apps/web/src/ --include="*.tsx" --include="*.ts"

# Tailwind 4 — inline HSL (не перемикається в dark mode)
grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"

# Inline style з rgba(var(--X-rgb)) / hsl(var(--X)) — звірити що CSS var РЕАЛЬНО існує у globals.css.
# Токени --color-* зберігаються як hsl()/var() цілісні значення, НЕ як rgb/hsl-триплети →
# rgba(var(--color-primary), a) мовчки падає на fallback (або transparent). Тема-aware фарба з alpha = color-mix().
grep -rnE "rgba\(var\(--|hsla?\(var\(--" apps/web/src/ --include="*.tsx" --include="*.ts"
# Для кожного --X-rgb / --X у rgba(): grep "X" apps/web/src/app/globals.css — якщо немає → CRITICAL/IMPORTANT

# Pixel значення замість Tailwind scale
grep -rnE "(w|h|top|left|right|bottom|max-w|min-w|p|m|gap)-\[[0-9]+px\]" apps/web/src/ --include="*.tsx"

# Незакрита дужка у arbitrary value (JIT тихо не генерує клас)
grep -rnE "\b[a-z:]+-\[[^]]*$" apps/web/src/ --include="*.tsx" --include="*.ts"

# findMany без take (OOM ризик)
grep -rn "findMany(" apps/api/src/ --include="*.ts" | grep -v "take:\|spec"

# Пакети без tsconfig.json
for f in packages/*/package.json apps/*/package.json; do
  dir=$(dirname "$f"); [ -f "$dir/tsconfig.json" ] || echo "MISSING tsconfig: $dir"
done

# UTF-8 BOM у .ts/.tsx (Windows-редактор/PowerShell Out-File -Encoding utf8) — неконсистентно з codebase
for f in $(git diff HEAD~10 --name-only 2>/dev/null | grep -E "\.(ts|tsx)$"); do
  [ -f "$f" ] && [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' ')" = "efbbbf" ] && echo "BOM: $f"
done
```

**Автофікси:**
| Помилка | Фікс |
|---|---|
| `React.ReactNode` | `import type { ReactNode } from 'react'` → `ReactNode` |
| `React.ChangeEvent<T>` / `React.FormEvent<T>` | `import type { ChangeEvent, FormEvent } from 'react'` |
| `bg-(--color-X)` / `border-(--color-X)` | Canonical token: `bg-X` / `border-X` |
| `w-[Npx]` | Tailwind scale: M = N/4 (52px→w-13) |
| `flex-shrink-0` | `shrink-0` |
| `URL.revokeObjectURL(url)` після `a.click()` | `setTimeout(() => URL.revokeObjectURL(url), 100)` |
| `findMany` без `take` | `take: 200` (list endpoints) або `take: 500` (sub-resources) |

- [ ] `tsc --noEmit` → 0 errors (web `--incremental false`, api, shared)
- [ ] Немає `React.X` — тільки named imports з `'react'`
- [ ] Немає `any` (крім `as unknown as T`)
- [ ] Немає `console.log`
- [ ] Всі `findMany` мають `take: N`
- [ ] Canonical Tailwind tokens (не `[var(--...)]`, не inline HSL)
- [ ] Немає UTF-8 BOM (`ef bb bf`) у .ts/.tsx — Windows/PowerShell редактори додають мовчки; tsc толерує, але неконсистентно й ламає деякі парсери/JSON-імпорти

---

## Крок 2 — Секції за матрицею

### §2 Security

#### §2.1 Auth & Guards
```bash
# Контролери без @UseGuards
grep -rn "@Controller" apps/api/src/ --include="*.controller.ts" | grep -v "UseGuards\|@Public"

# Endpoints без @Roles
grep -rn "@Get\|@Post\|@Patch\|@Delete" apps/api/src/modules/ --include="*.controller.ts" -A1 | grep -v "@Roles\|@Public\|spec" | head -20
```
- [ ] Кожен `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)` або явний `@Public()`
- [ ] `@Roles(...)` на кожному методі — без `@Roles` RolesGuard пропускає всіх авторизованих (включаючи MECHANIC до cost даних!)
- [ ] `costPrice`, `purchasePrice`, `salePrice`, `priceHistory`, `margin` → тільки `OWNER/ADMIN/STOREKEEPER/ACCOUNTANT`
- [ ] `/setup/init` → перевіряє `isAlreadyInitialized()` (anti-replay)
- [ ] `@CurrentUser()` повертає `{ sub, orgId, role }` — не `any`; у контролерах використовувати `user.id`, не `user.sub` (jwt.strategy.ts повертає `{ id, orgId, role }`)

#### §2.2 Tenant Isolation
```bash
# findFirst/findMany без orgId у where
grep -rn "findFirst\|findMany\|findUnique\|\.update(\|\.delete(" apps/api/src/modules/ --include="*.service.ts" \
  | grep -v "orgId\|spec\|//.*find" | head -20
```
- [ ] Кожен `findFirst` / `findMany` / `update` / `delete` містить `orgId`
- [ ] `@Param('id')` ніколи не використовується без перевірки належності до `orgId`
- [ ] PATCH/UPDATE з FK body-полем (`goodId`, `vehicleId`) → валідує що FK belongs to `orgId`
- [ ] FK у sync push (`customerGarageId`, `liftId`, `employeeId`) → `validateForeignKeys(orgId, ...)`

#### §2.3 Injection & Input Validation
```bash
# Рядкова інтерполяція у queryRaw
grep -rn "queryRaw\|executeRaw" apps/api/src/ --include="*.ts" | grep -v "Prisma\.sql\|plainto_tsquery\|spec"

# ParseUUIDPipe відсутній
grep -rn "@Param('id')\|@Param(\"id\")" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe\|spec"

# process.env напряму в сервісах
grep -rn "process\.env\." apps/api/src/ --include="*.ts" | grep -v "main.ts\|spec"
```
- [ ] `$queryRaw` — тільки tagged template або `Prisma.sql` (не рядкова інтерполяція)
- [ ] `@Param(':id')` → `ParseUUIDPipe` (не `version: '4'` — тести часто мають UUID v0)
- [ ] `process.env` тільки у `main.ts` та конфіг-файлах — сервіси → `ConfigService`
- [ ] Немає `eval()`, `new Function()`, `child_process.exec()`

#### §2.4 Витік даних
```bash
grep -rn "passwordHash\|apiKey\b\|secret\b" apps/api/src/modules/ --include="*.dto.ts"
```
- [ ] `passwordHash`, `apiKey`, `secret` відсутні у `*ResponseDto`
- [ ] `phone`, `edrpou`, `email` у `PULL_FIELD_BLACKLIST` (sync)

#### §2.5 BullMQ Queue Safety
```bash
# Queue add без attempts
grep -rn "\.add(" apps/api/src/ --include="*.ts" | grep -v "attempts\|spec"

# Прямі HTTP поза чергою
grep -rn "axios\|node-fetch\|https\.request\|http\.request" apps/api/src/modules/ --include="*.ts" \
  | grep -v "spec\|queue\|processor"
```
- [ ] Кожен `.add()` → `attempts ≥ 10`, `backoff: { type: 'exponential' }`
- [ ] ПРРО: `attempts: 288`, `backoff: { delay: 300_000 }` (24 год)
- [ ] SMS: `attempts: 10`, `backoff: { delay: 60_000 }`
- [ ] Процесори → `try/catch` + `throw err` (щоб BullMQ retry спрацював)
- [ ] Ніяких прямих HTTP до зовнішніх API поза чергою

#### §2.6 Sentry
```bash
head -3 apps/api/src/main.ts | grep "instrument"
grep -n "enabled" apps/api/src/instrument.ts apps/web/src/lib/sentry.ts 2>/dev/null
grep -n "captureException\|status >= 500" apps/api/src/common/filters/http-exception.filter.ts
grep -n "SentryProvider" apps/web/src/app/layout.tsx apps/web/src/app/\(setup\)/layout.tsx 2>/dev/null
```
- [ ] `instrument.ts` — перший import у `main.ts`
- [ ] `enabled: NODE_ENV === 'production' && !!dsn`
- [ ] `captureException` тільки при `status >= 500`; 4xx — ніколи
- [ ] `SentryProvider` у root layout, **відсутній** у setup layout

---

### §3 Memory Leaks

#### §3.1 React Hooks
```bash
# addEventListener/setInterval/setTimeout без cleanup
grep -rn "addEventListener\|setInterval\|setTimeout\b" apps/web/src/ --include="*.tsx" --include="*.ts" \
  | grep -v "clearTimeout\|clearInterval\|removeEventListener\|spec" | head -20

# debounceRef без clearTimeout у cleanup
grep -rn "debounceRef\|pollRef\|timerRef" apps/web/src/ --include="*.tsx" | grep -v "clearTimeout\|spec"

# fetch без cancelled flag або AbortController
grep -rn "apiFetch\|apiBlobFetch" apps/web/src/app/ --include="*.tsx" -B2 | grep "useEffect" | head -20
# Для кожного useEffect з apiFetch — перевірити наявність let cancelled або AbortController

# Статичні константи у render body (нова RegExp/Set/Map кожен рендер)
grep -rnE "^\s+const [A-Z_]+\s*=\s*(\/|new (Set|Map|RegExp))" apps/web/src/app --include="*.tsx"

# memo з inline array/object prop (memo марний)
grep -rnE "<[A-Z][A-Za-z]+[^>]*=\{[a-zA-Z.]+\.(filter|map|slice)\(" apps/web/src/app --include="*.tsx"

# closest()/matches() на data-атрибут якого бібліотека НЕ ставить (dnd-kit attributes = role/aria-*)
grep -rnE "closest\(['\"]?\[data-(dnd-draggable|dnd|rdnd)" apps/web/src/ --include="*.tsx"

# pointer interaction state (drawing/resizing) — leave-handler має скидати ВСІ режими
grep -rn "onPointerLeave\|PointerLeave" apps/web/src/app --include="*.tsx"
# Для кожного — звірити що скидаються всі pointer-режими (ghost + resize + draw), не лише один
```
- [ ] `addEventListener` → `return () => removeEventListener`
- [ ] `setInterval` / `setTimeout` → `return () => clearInterval / clearTimeout`
- [ ] `debounceRef.current` → `clearTimeout` у cleanup (HTTP запит стартує навіть якщо mounted=false)
- [ ] `useEffect` з `apiFetch` → `let cancelled=false; ... if (!cancelled) setState(...); return () => { cancelled=true }`
- [ ] Stateless константи (RegExp, Set, Map) → module-level, не у render body
- [ ] `memo(Component)` → пропсами — стабільні референції (через `useMemo` Map, не inline `.filter()`)
- [ ] Inline `ref={el => el.indeterminate = x}` → `useRef` + `useEffect([dep])` (крихко при React Compiler)
- [ ] `target.closest('[data-X]')` guard → атрибут реально рендериться у DOM (dnd-kit/radix НЕ ставлять `data-dnd-draggable`); додати власний маркер `data-Y` + перевіряти його
- [ ] `onPointerLeave` / cancel-handler → скидає **ВСІ** pointer-режими (drawing **і** resizing), не лише перший

#### §3.2 Backend
```bash
grep -rn "findMany(" apps/api/src/ --include="*.ts" | grep -v "take:\|spec"
```
- [ ] `findMany` без `take` — потенційний OOM
- [ ] Немає `new PrismaClient()` поза `PrismaService`
- [ ] `$transaction` має `{ timeout: N }` (5000–15000ms)
- [ ] Prisma `include` без циклічних зв'язків (A → B → A)

---

### §4 Architecture

```bash
# Бізнес-логіка у контролері
grep -rn "prisma\.\|NotFoundException\|BadRequestException" apps/api/src/ --include="*.controller.ts" \
  | grep -v "spec\|ParseUUID"

# List endpoint без { items, total } wrapper
grep -rn "async findAll\|async getAll" apps/api/src/modules/ --include="*.service.ts" \
  | grep -v "ResponseDto\[\]\|Dto\[\]>\|Paginated" | head -10
```
- [ ] Controller: HTTP layer тільки (ніяких Prisma, бізнес-логіки, `if/else`)
- [ ] Service: вся логіка + Prisma (ніяких `req`, `res`)
- [ ] `toResponseDto()` / `toDto()` — жоден Prisma об'єкт не повертається напряму
- [ ] List endpoints → `{ items, total }` (не bare array)
- [ ] Нові модулі → зареєстровані в `app.module.ts`
- [ ] Cross-service `.catch(() => {})` → `.catch(e => { if (!expected) logger.warn(...) })`
- [ ] Auto-FSM-transition у tx → re-read entity всередині tx + перевірка `status === expected`

#### §4.1 Circular DI
```bash
grep -rn "forwardRef" apps/api/src/ --include="*.module.ts" | head -5
```
- [ ] Circular DI → `forwardRef(() => ServiceB)`
- [ ] `EventEmitter2.on()` тільки у `onModuleInit()` або `constructor` (не в request handler)

---

### §5 Business Rules

```bash
# Прямий update stockItem поза InventoryService
grep -rn "stockItem\.update\|stockItem\.upsert" apps/api/src/modules/ --include="*.ts" \
  | grep -v "inventory.service\|spec"

# Прямий update balance поза SettlementsService
grep -rn "settlementAccount\.update" apps/api/src/modules/ --include="*.ts" | grep -v "settlements.service\|spec"

# Прямий delete (hard delete)
grep -rn "prisma\.[a-zA-Z]*\.delete(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec

# findFirst/findMany без deletedAt: null
grep -rn "findFirst\|findMany" apps/api/src/modules/ --include="*.service.ts" \
  | grep -v "deletedAt\|spec\|StockMovement\|SettlementTransaction\|Payment\|WorkOrderLineEmployee\|BatchConsumption\|PriceHistory\|Comment\|EmployeeBranch" | head -20

# $transaction без timeout
for f in $(grep -rl "\$transaction(async" apps/api/src --include="*.ts" | grep -v spec); do
  tx=$(grep -c "\$transaction(async" "$f")
  to=$(grep -c "timeout:" "$f")
  [ "$tx" -gt "$to" ] && echo "MISMATCH $f: $tx tx, $to timeouts"
done
```
- [ ] FSM: `transition()` читає з `WORK_ORDER_TRANSITIONS` map
- [ ] Stock: тільки через `InventoryService.createMovement()`
- [ ] Settlements: тільки через `SettlementsService.createTransaction()`
- [ ] `IN_PROGRESS` → `RESERVATION`; `COMPLETED` → `WRITEOFF+RESERVATION_RELEASE+CHARGE` у `$transaction`
- [ ] `CANCELLED` зі статусу з резервом → `RESERVATION_RELEASE`
- [ ] Soft delete скрізь; **без deletedAt**: `SettlementTransaction`, `StockMovement`, `StockBatch`, `BatchConsumption`, `PriceHistory`, `Payment`, `WorkOrderLineEmployee`, `Comment`, `EmployeeBranch`
- [ ] Кожен `$transaction(async cb)` → `{ timeout: N }` (5s–15s)
- [ ] `SettlementsService.createTransaction` → internal `amount > 0 && Number.isFinite(amount)` guard

#### §5.1 Pricing & Batches
```bash
grep -n "PERCENT\|FIXED_AMOUNT\|FIXED_PRICE\|roundTo\|Math.max\|Math.round\|nulls.*last\|AVG_COST" \
  apps/api/src/modules/inventory/pricing.service.ts \
  apps/api/src/modules/inventory/batch.service.ts 2>/dev/null
```
- [ ] `PERCENT` = `cost * (1 + pct/100)`; `FIXED_AMOUNT` = `cost + delta`; `FIXED_PRICE` fallback = `fixedPrice ?? costPrice`
- [ ] Округлення = `Math.round(result / r) * r`; захист = `Math.max(0, result)`
- [ ] FEFO: `[{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]`
- [ ] AVG_COST: `SUM(remainingQty * costPrice) / SUM(remainingQty)` (не `SUM(price) / count`)
- [ ] Batch loop: `Math.min(remaining, batch.remainingQty)`; після циклу `remaining > 0` → `throw`
- [ ] `Number(l.amount)` cast у `recalcTotals` (Decimal без cast → рядкова конкатенація)

#### §5.2 Soft-delete + @@unique = resurrection (Bug #152)
```bash
grep -n "@@unique" packages/database/prisma/schema.prisma | grep -v "deletedAt"
grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"
```
- [ ] Модель з `@@unique([orgId, X])` де X не `deletedAt` → `create()` має resurrection pattern:
  `findFirst({ orgId, X })` (без `deletedAt` filter) → якщо `deletedAt !== null` → `update({ ...dto, deletedAt: null })` замість `create`; якщо active → `ConflictException`
- [ ] `update()` що змінює unique-поле → re-check: `findFirst({ orgId, X, NOT: { id } })` → `ConflictException`

---

### §6 Database

```bash
# N+1 — findMany без include + подальший цикл
grep -rn "for.*of\|forEach\|\.map(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20
# Для кожного — перевірити чи є prisma виклик всередині циклу

# include: true замість select — тягне всі колонки
grep -rn "include:.*true\b" apps/api/src/modules/ --include="*.service.ts" | grep -v "spec\|//.*include" | head -15

# Raw SQL без LIMIT або snake_case ідентифікатори
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" | grep -v spec
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" -A 20 \
  | grep -E "org_id|deleted_at|created_at|updated_at|good_id|warehouse_id|min_stock" | head -10

# FK без @@index
grep -rn "@db.Uuid" packages/database/prisma/schema.prisma | grep -v "id\s\|@@index\|@@unique"

# schema.prisma змінено у diff — але міграція НЕ додана (Critical: schema ≠ DB)
if git diff HEAD~10 --name-only 2>/dev/null | grep -q "schema.prisma"; then
  echo "schema.prisma змінено — перевір що додана нова папка у migrations/:"
  git log --oneline -10 --name-only | grep -E "schema.prisma|migrations/" | head
fi
# Нове enum-значення у schema (ADD VALUE) — звірити з міграцією
git diff HEAD~10 -- packages/database/prisma/schema.prisma 2>/dev/null | grep -E "^\+\s+[A-Z_]+$"
grep -rn "ALTER TYPE.*ADD VALUE" packages/database/prisma/migrations/ | tail -5
```
- [ ] **Будь-яка зміна `schema.prisma` (enum value, поле, модель) → супутня папка у `migrations/`** — інакше schema ≠ DB, runtime error при insert/select нового значення
- [ ] Нове enum-значення → `ALTER TYPE "Enum" ADD VALUE IF NOT EXISTS 'X';` (окремий файл; Postgres не дозволяє ADD VALUE + use у одній транзакції)
- [ ] Немає N+1: `include` або окремий `findMany({ where: { id: { in: [...] } } })`
- [ ] `include: { vehicle: true }` → `include: { vehicle: { select: { make, model, licensePlate } } }`
- [ ] `$queryRaw` → LIMIT N у SQL (Prisma `take:` не впливає)
- [ ] Raw SQL ідентифікатори — camelCase у лапках: `"orgId"`, `"deletedAt"` (не `org_id`)
- [ ] Кожне нове FK поле → `@@index([orgId, fkId])`
- [ ] `@@index([orgId, syncVersion])` для sync-ready таблиць
- [ ] `prisma.$transaction` при зміні ≥ 2 таблиць

---

### §7 Performance

#### §7.1 Backend
```bash
# Послідовні незалежні запити (sequential → parallel)
grep -rn "const .* = await.*findFirst" apps/api/src/modules/ --include="*.service.ts" -A3 \
  | grep -B1 "await.*findFirst" | grep -v spec | head -20

# Blocking sync у async context
grep -rn "readFileSync\|writeFileSync\|existsSync" apps/api/src/ --include="*.ts"
```
- [ ] Незалежні запити → `Promise.all([...])` (не sequential `await`)
- [ ] Важкі операції (PDF, масовий import) → BullMQ, не request handler
- [ ] Немає `fs.readFileSync` у request handlers

#### §7.2 Frontend
```bash
# new Date() у render path (hydration mismatch)
grep -rn "new Date()\|Date\.now()" apps/web/src/app/ --include="*.tsx" \
  | grep -v "useEffect\|getTime\|setDate\|//\|spec"

# key={i} у re-sortable lists
grep -rn "key={i}\|key={index}" apps/web/src/app/ --include="*.tsx" | head -10

# Per-item fan-out: Promise.all(days/ids.map(apiFetch)) без cap і без AbortController
grep -rnE "Promise\.all\(\s*[a-zA-Z]+\.map\(" apps/web/src/app/ --include="*.tsx" -A2 | grep -i "apiFetch" | head -10
# Для кожного — перевірити (1) cap на довжину масиву (MAX_N), (2) AbortController на зміну параметра
```
- [ ] `new Date()` у render → `useState('')` + `useEffect(() => setX(new Date()), [])`
- [ ] `key={i}` у списках з filter/sort → `key={item.id}` або stable derived key
- [ ] Важкі обчислення у render → `useMemo`
- [ ] `createPortal` → `mounted` guard
- [ ] `Promise.all(arr.map(apiFetch))` fan-out (per-day/per-id) → (1) cap довжини масиву (`MAX_N`); (2) `AbortController`-ref що `.abort()` попередню партію при зміні параметра + `if (signal.aborted) return` перед setState (інакше race: остання-зарезолвлена партія, не остання-запитана, виграє)

---

### §8 Web Frontend

#### §8.1 API Calls
```bash
# Прямий fetch без apiFetch
grep -rn "fetch(" apps/web/src/ --include="*.tsx" --include="*.ts" \
  | grep -v "apiFetch\|api-client\|auth/context\|spec"

# apiBlobFetch / apiMultipartFetch без Array.isArray message guard
grep -n "message?: string\b\|message: string\b" apps/web/src/lib/api-client.ts
```
- [ ] Всі API → `apiFetch` / `apiBlobFetch` / `apiMultipartFetch` (не прямий `fetch`)
- [ ] Всі три helpers мають `Array.isArray(body.message) ? body.message.join('; ') : body.message`
- [ ] GET dedup у `api-client` → guard `!init?.signal` (abort одного caller не вбиває інших)
- [ ] Manifest static assets фізично існують у `public/`:
  ```bash
  jq -r '.icons[].src' apps/web/public/manifest.json 2>/dev/null \
    | while read p; do [ -f "apps/web/public${p}" ] || echo "MISSING: $p"; done
  ```

#### §8.2 UI Стани
```bash
# .catch(() => {}) на fetch — ховає помилки
grep -rn "\.catch(() => {})" apps/web/src/app/ --include="*.tsx"

# loading оголошений але setLoading(true) відсутній
grep -rn "const \[loading.*false" apps/web/src/app/ --include="*.tsx" | head -10
# Для кожного — перевірити чи є setLoading(true) перед fetch

# saving глобальний замість per-row
grep -rn "saving\b" apps/web/src/app/ --include="*.tsx" | grep "useState(false)" | head -5

# Paired display-name FK — обидва не скидаються разом
grep -rnE "setForm\(.*Id: ['\"]['\"]" apps/web/src/app/ --include="*.tsx"

# Event-handler fetch (openEdit/openCard/onSelect) що setState після resolve — без request-token guard
grep -rnE "const (open|load|select|fetch)[A-Z][A-Za-z]* = (async )?\(" apps/web/src/app/ --include="*.tsx" -A30 \
  | grep -E "apiFetch" | head -20
# Для кожного handler-fetch: re-виклик для іншого id → перевірити token-ref/AbortController + reset похідного стану на старті
```
- [ ] Кожен list-fetch: `setLoading(true)` перед; `.catch(setError)`; `.finally(() => setLoading(false))`; `{!loading && items.length===0 && <EmptyState/>}`
- [ ] `saving: boolean` → `savingId: string | null` (per-row, не глобальний)
- [ ] `error` page-level ≠ `formError` (не перезаписувати)
- [ ] Paired FK state (`counterpartyId` + `counterpartyDisplayName`) → скидати **обидва** на onClose/POST success/onClear
- [ ] Fetch у **обробнику події** (`openEdit`/`openCard`/`onSelect`, не `useEffect`) що `setState` після resolve → request-token ref (`++ref.current`; `if (ref.current !== reqId) return` перед кожним setState) бо `cancelled`-flag з useEffect тут не спрацьовує; **+ скинути похідний стан** (`garageId`, обраний рядок) на старті handler — інакше stale id на fetch-failure → мутація йде у чужу сутність

#### §8.2.1 Select race
```bash
grep -rnE "setForm.*[a-zA-Z]+Id:\s*['\"]['\"]|useState\(\{[^}]*[a-zA-Z]+Id:\s*['\"]['\"]" \
  apps/web/src/app/ --include="*.tsx" | grep -v "SearchCombobox"
```
- [ ] `<Select value={form.xxxId}>` де options асинхронні → `useEffect` що синхронізує value:
  `if (!modal || !options[0]) return; if (!form.xxxId) setForm(f => ({...f, xxxId: options[0].id}))`
- [ ] Виняток: є `placeholder` disabled option + submit `disabled={!form.xxxId}`

#### §8.3 Hydration Safety
```bash
grep -rn "localStorage\|sessionStorage\|window\.\|document\." apps/web/src/ \
  --include="*.tsx" --include="*.ts" | grep -v "useEffect\|'use client'\|spec"
```
- [ ] `localStorage` / `window.*` / `document.*` тільки в `useEffect` або `'use client'`
- [ ] `useState(() => localStorage.getItem(...))` → `useState(defaults)` + `useEffect` для read
- [ ] `useState(new Date())` → `useState('')` + `useEffect(() => setX(formatDate(new Date())), [])`
- [ ] `createPortal` → `mounted` guard

#### §8.4 Routing & Auth
- [ ] Захищені сторінки → `useRequireAuth(roles)` або redirect
- [ ] `/setup` має окремий `layout.tsx` без `AuthProvider`/`TopShell`
- [ ] PUBLIC_ROUTES (`/booking`, `/setup`, `/login`, `/403`) → `publicFetch`, не `apiFetch`

#### §8.5 UX Features
```bash
# toast без features.toastEnabled guard
grep -rn "toast\." apps/web/src/app/ apps/web/src/components/ --include="*.tsx" \
  | grep -v "features\.toastEnabled\|// toast\|ToastContainer"

# Promise.all для bulk-мутацій (має бути allSettled)
grep -rn "Promise\.all(" apps/web/src/ --include="*.tsx" \
  | grep -i "bulk\|map.*apiFetch" | grep -v "allSettled"

# indeterminate через inline ref (крихко)
grep -rn "indeterminate" apps/web/src/ --include="*.tsx" | grep -v "useEffect\|useRef\|//"
```
- [ ] `toast.X(...)` → `if (features.toastEnabled)`; fallback: `setError(msg)`
- [ ] Bulk-мутації → `Promise.allSettled` + `bulkSelect.clear()` + `load()` у finally
- [ ] `indeterminate` → `useRef` + `useEffect([dep])`, не inline `ref={el => el.indeterminate = x}`
- [ ] `useBulkSelect` → items prop оновлюється при `setData`
- [ ] Кнопка delete → `group-hover:opacity-100` + `focus:opacity-100` (не `self-hover`)

#### §8.6 Модульність UI
```bash
# Inline IIFE у JSX
grep -rnE "\{\(\(\) =>" apps/web/src/app/ --include="*.tsx"

# Дубльована date badge математика
grep -rn "86_400_000\|diffDays" apps/web/src/app/ --include="*.tsx" | grep -v "lib/utils\|expiry-badge"

# Власний picker не через picker-modal.tsx
grep -rn "<Modal" apps/web/src/app/ --include="*.tsx" -l
```
- [ ] FK-поле зі списком (готовий масив) → `<PickerModal<T>>`, не власний Modal зі своїм query-станом
- [ ] Великий датасет + сервер-пошук → `<SearchCombobox<T>>`
- [ ] Inline IIFE `{(() => {...})()}` → іменована функція; pointless wrapper навколо `.map()` → прибрати IIFE
- [ ] "Прострочено/скоро" badge → `<ExpiryBadge>` + `daysUntil()`, не inline `Math.ceil(.../86_400_000)`
- [ ] Однаковий helper 2+ рази → `lib/utils.ts`

---

### §9 Sync Readiness
```bash
grep -n "model " packages/database/prisma/schema.prisma | grep -v "//"
# Для кожної нової моделі — перевірити syncVersion BigInt
```
- [ ] Нові таблиці → `PULL_TABLES` або обґрунтовано виключені
- [ ] Push-безпечні → `PUSH_SAFE_TABLES` + `PUSH_FIELD_WHITELIST`
- [ ] PII у `PULL_FIELD_BLACKLIST` (phone, edrpou, email)

---

### §10 Offline-First
- [ ] Зовнішні API → тільки через BullMQ
- [ ] Конфігурація (терміни, ліміти, шаблони) → `SettingsService.get(orgId)`, не hardcode

---

### §11 Configuration over Hardcode
```bash
# Magic numbers у сервісах
grep -rn "= [0-9]\{2,\}" apps/api/src/modules/ --include="*.ts" \
  | grep -v "spec\|take:\|skip:\|1000\|200\|100\|60_000\|300_000" | head -15

# Hardcoded шаблони повідомлень
grep -rn "\"Шановний\|\"Ваш наряд\|\"Рахунок №\|'Дякуємо" apps/api/src/ --include="*.ts" | grep -v spec
```
- [ ] `invoiceDueDays`, `autoArchiveDays`, `warrantyDays` → `SettingsService.get(orgId)`
- [ ] SMS/Viber/Email шаблони → `NotificationTemplate`, не рядкові літерали
- [ ] Способи оплати → `PaymentMethodConfig`; ставки ПДВ → `TaxRate`

---

### §13 API Contract
```bash
# Frontend інтерфейси
grep -rn "^interface \|^type [A-Z]" apps/web/src/app/ --include="*.tsx" | grep -v "Props\b"

# Backend toResponseDto
grep -rn "toResponseDto\|toDto\|toDetailDto" apps/api/src/modules/ --include="*.ts" | grep -v spec

# syncVersion BigInt напряму у response
grep -rn "return\s*await\s*this\.prisma\.[a-zA-Z]\+\.\(findMany\|findFirst\|create\|update\)" \
  apps/api/src/modules/ --include="*.service.ts" | grep -v spec

# Payload spread з BigInt (Bug #128)
grep -rn "payload.*\.\.\.row\|payload:\s*row" apps/api/src/modules/ --include="*.ts" | grep -v spec

# Dynamic model lookup plural→singular (Bug #127)
grep -rn "toCamel\|snakeToCamel\|snake_to_camel" apps/api/src/ --include="*.ts" | grep -v spec
```
- [ ] Кожне обов'язкове поле frontend-`interface` повертається у `toResponseDto()`
- [ ] `Decimal` → `Number(x)` у DTO; `createdAt`: `string` (не `Date`) у фронті
- [ ] `syncVersion BigInt` **ніколи** напряму у response — `Number(row.syncVersion)` або `select` без нього
- [ ] `payload = { ...row }` → normalize loop: `if (typeof v === 'bigint') Number(v)`
- [ ] Dynamic `(prisma as any)[modelName]` → explicit `TABLE_TO_MODEL: Record<string,string>` + `if (!model) throw`
- [ ] Polymorphic `entityType` → `IsIn([...ENTITY_TYPES])` + фронт використовує ті самі константи

---

## Крок 3 — Виправлення

```
Для кожної знайденої проблеми (Critical → Important → Suggestion):
  1. Прочитай файл
  2. Застосуй мінімальний точковий фікс
  3. pnpm --filter <package> exec tsc --noEmit → 0 errors
  4. Якщо fix потребує міграції → зафіксуй як CRITICAL, повідом після всіх інших правок
```

---

## Крок 4 — TypeScript + Commit

```bash
pnpm --filter @sto/api exec tsc --noEmit
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false

git add apps/ packages/
git commit -m "fix(review): <коротко що виправлено>"
```

---

## Крок 5 — Оновити MemoryManual.md

```markdown
## Останній commit
<hash> fix(review): <message>
Дата: YYYY-MM-DD

## Поточний стан проєкту
TypeScript: ✅ 0 errors
Latest review: YYYY-MM-DD (<режим>, HEAD <hash>) — <підсумок>
```

---

## Крок 6 — Самовдосконалення (ОБОВ'ЯЗКОВО після кожного запуску)

Після виправлення кожної проблеми — запитай себе:

> **"Цей баг охоплений існуючим пунктом чекліста §1–§13?"**

Якщо **НІ** — одразу оновити цей файл:
1. Додати grep-команду у відповідний розділ
2. Додати checklist item
3. Записати підхід у "Накопичені підходи" нижче
4. Commit: `docs(skills): add <патерн> to sto-review`

**Розподіл sto-review vs sto-tester:**
- `sto-review` = статичний аналіз (grep, tsc, код-аналіз)
- `sto-tester` = динамічні баги (runtime, browser, a11y, i18n, E2E)

### Формат запису

```
### [Дата] — [Назва патерну] — [Секція §N]

**Сигнал:** статична ознака в коді
**Причина виникнення:** типова помилка або хибне припущення
**Підхід до виявлення:** загальний принцип статичного пошуку
**Підхід до фіксу:** загальний принцип виправлення
**Критичність:** CRITICAL / IMPORTANT / SUGGESTION
**Де шукати ще:** суміжні місця
```

---

## Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 CODE REVIEW — STO ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Файлів перевірено: N
Знайдено проблем:  N (Critical: X / Important: Y / Suggestion: Z)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### 🔴 Critical (must fix)
1. [файл:рядок] — що не так → як виправити

### 🟡 Important (should fix)
1. [файл:рядок] — що не так → як виправити

### 🔵 Suggestion (nice to have)
1. [файл:рядок] — пропозиція

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Накопичені підходи (оновлюється автоматично)

### 2026-05-28 — @@unique без deletedAt + create без resurrection — §6 Database

**Сигнал:** `@@unique([orgId, X])` де X не `deletedAt`; `create()` має `findFirst({ deletedAt: null })` але не resurrection
**Причина виникнення:** розробник перевіряє активний дублікат але не враховує що soft-deleted рядок займає DB unique index → P2002
**Підхід до виявлення:** зіставити `@@unique` без `deletedAt` з `create()` методами — якщо тільки `findFirst({ deletedAt: null })` без update-branch → кандидат
**Підхід до фіксу:** merged `findFirst` (без deletedAt filter) → JS перевірка `deletedAt` → resurrect (`update`) або ConflictException
**Критичність:** IMPORTANT — HTTP 500 замість 409
**Де шукати ще:** будь-який новий довідниковий модуль з name/code/shortName unique constraint

---

### 2026-05-28 — memo() з fresh array/object prop — §3 Memory / §7 Performance

**Сигнал:** `memo(Component)` де батько передає `.filter()` / `.map()` / `{}` inline як проп — нова референція кожен рендер → memo ніколи не спрацьовує
**Причина виникнення:** розробник додає memo для оптимізації але не думає про стабільність props
**Підхід до виявлення:** компоненти в `memo()` → перевірити як батько передає props → inline array/object → memo марний
**Підхід до фіксу:** `useMemo` Map у батьку для групування; stable empty constant замість `[]` default
**Критичність:** SUGGESTION — не баг, але виправлений memo дає 50-200ms на drag/filter
**Де шукати ще:** list components з onSelect callbacks + grid з slot arrays

---

### 2026-05-28 — GET dedup + AbortSignal shared promise — §8 Web Frontend

**Сигнал:** in-flight GET dedup keyed on `path` без guard `!init?.signal`
**Причина виникнення:** dedup оптимізація не враховує що AbortSignal є caller-specific
**Підхід до виявлення:** dedup Map у api-client → перевірити guard перед додаванням у Map
**Підхід до фіксу:** `if (method === 'GET' && !init?.signal) { ...dedup... }` — abortable GET не дедупити
**Критичність:** IMPORTANT — silent abort для не-aborted callers
**Де шукати ще:** будь-який shared fetch cache / dedup механізм

---

### 2026-05-28 — apiFetch message: string[] без Array.isArray у всіх helpers — §8.1

**Сигнал:** fix у `apiFetch` для `message: string[]` — але `apiBlobFetch` і `apiMultipartFetch` без того ж guard
**Причина виникнення:** фікс застосовано точково до одного helper, сусідні файлу залишились
**Підхід до виявлення:** після будь-якого fix в `api-client.ts` → grep всі три функції на однаковий патерн
**Підхід до фіксу:** оновити всі три синхронно в одному коміті
**Критичність:** IMPORTANT — `[object Object]` або тільки перший елемент при 400 з validation
**Де шукати ще:** будь-яке місце де є кілька функцій одного типу в одному файлі

---

### 2026-05-28 — BigInt syncVersion напряму у JSON response — §13 API Contract

**Сигнал:** `findMany` / `findFirst` повертається напряму без `toDto()` на моделях з `syncVersion BigInt`
**Причина виникнення:** розробник повертає Prisma result напряму — швидко, але `JSON.stringify(BigInt)` throws
**Підхід до виявлення:** grep `return await this.prisma.X.findMany` без `map(toDto)` у service → перевірити що немає BigInt у select
**Підхід до фіксу:** `rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }))` або `select` без syncVersion
**Критичність:** CRITICAL — HTTP 500 при будь-якому запиті до endpoint
**Де шукати ще:** будь-який новий endpoint що повертає Prisma result — особливо notification/audit/sync

---

### 2026-05-28 — Prisma plural table → singular model — §13 API Contract

**Сигнал:** dynamic `(prisma as any)[modelName]` де modelName наївно перетворений із snake_case plural
**Причина виникнення:** `@@map` задає plural тільки для таблиці; Prisma client — завжди singular camelCase
**Підхід до виявлення:** grep `toCamel\|snakeToCamel` → перевірити explicit TABLE_TO_MODEL map
**Підхід до фіксу:** explicit `Record<tableName, modelKey>` + `if (!model) throw` (fail-fast)
**Критичність:** CRITICAL — TypeError на runtime; async `.catch()` не ловить синхронний property access
**Де шукати ще:** sync.service.ts, будь-який динамічний model lookup

---

### 2026-05-28 — closest() guard на data-атрибут якого бібліотека не ставить — §3.1 / §8

**Сигнал:** `target.closest('[data-dnd-draggable]')` (або інший `data-*`) у pointer/click guard — а dnd-kit `useDraggable.attributes` ставить лише `role`/`aria-roledescription`/`aria-disabled`/`tabindex`, НЕ `data-dnd-draggable`
**Причина виникнення:** розробник припускає що drag-бібліотека маркує елемент `data-*`, але атрибут вигаданий → `closest()` ніколи не матчить → guard мовчки не спрацьовує (напр. pointerdown на слоті стартує паралельний ghost-draw)
**Підхід до виявлення:** grep `closest(['"]?\[data-(dnd|rdnd)` → звірити що атрибут реально присутній у JSX/DOM; будь-який guard на чужий `data-*` підозрілий
**Підхід до фіксу:** додати ВЛАСНИЙ стабільний маркер на корінь компонента (`data-calendar-slot`) і перевіряти його — він покриває всіх дітей (resize handles, label, delete) одним `closest()`
**Критичність:** IMPORTANT — guard не працює, конкуруючі pointer-жести; degradation без TS/runtime помилки
**Де шукати ще:** будь-який custom pointer-draw/drag поверх dnd-kit/radix; перевірки `matches()`/`closest()` на `data-state`, `data-disabled`

---

### 2026-05-28 — leave/cancel handler скидає лише частину pointer-режимів — §3.1

**Сигнал:** `onPointerLeave` коментар "cancel drawing/resize" але тіло скидає лише `drawingRef`/`ghost`, не `resizing`/`resizePreview`
**Причина виникнення:** другий pointer-режим (resize) доданий пізніше, cancel-handler не оновлено → покинутий resize off-element лишає застряглий preview + наступний pointermove продовжує маніпуляцію
**Підхід до виявлення:** grep `onPointerLeave` → перелічити всі pointer-режими у компоненті (drawingRef, resizing, dragging) → звірити що cancel-handler скидає кожен
**Підхід до фіксу:** у leave/cancel скинути ВСІ режими: `if (drawing) {...}; if (resizing) { setResizing(null); setResizePreview(null); }`
**Критичність:** IMPORTANT — застрягла UI-операція, фантомний preview
**Де шукати ще:** будь-який компонент з 2+ pointer-жестами (draw + resize + drag), timeline/canvas/gantt редактори

---

### 2026-05-28 — schema.prisma enum/поле змінено без міграції — §6 Database

**Сигнал:** diff містить зміну `schema.prisma` (нове enum-значення `+  PIT`, нове поле, нова модель) але у тому ж/сусідньому коміті НЕ додана папка у `packages/database/prisma/migrations/`
**Причина виникнення:** розробник править schema.prisma напряму (для типів Prisma client) і забуває `prisma migrate dev` → TS компілюється (тип існує), але БД enum/колонки не має → runtime error при першому insert/select нового значення
**Підхід до виявлення:** `git diff` на schema.prisma → для кожного `+` рядка (enum value / field / model) звірити що є відповідний migration файл; enum → grep `ALTER TYPE ... ADD VALUE`
**Підхід до фіксу:** створити папку `YYYYMMDDHHMMSS_<desc>/migration.sql` після останнього timestamp; enum → `ALTER TYPE "Enum" ADD VALUE IF NOT EXISTS 'X';` (окремий файл — Postgres забороняє ADD VALUE + використання у одній транзакції)
**Критичність:** CRITICAL — TS зелений, але runtime fail; найкаверзніше бо tsc мовчить
**Де шукати ще:** будь-який feat-коміт що чіпає schema.prisma; особливо enum enrichment, нові nullable поля

---

### 2026-05-28 — UTF-8 BOM у .ts після Windows/PowerShell-редагування — §1 TypeScript

**Сигнал:** перші 3 байти файлу = `ef bb bf`; git diff показує `+﻿import` (невидимий ﻿ перед import); тільки частина файлів того ж типу мають BOM (неконсистентно)
**Причина виникнення:** масове редагування файлів через PowerShell `Out-File`/`Set-Content` (default UTF-16/UTF-8-BOM) або редактор що зберігає з BOM → BOM додається до кожного зачепленого файлу
**Підхід до виявлення:** `head -c 3 "$f" | od -An -tx1` на змінених .ts/.tsx → `efbbbf` = BOM; порівняти з рештою файлів того ж каталогу
**Підхід до фіксу:** `tail -c +4 "$f" > tmp && mv tmp "$f"` для кожного BOM-файлу; перевірити що tsc усе ще 0 errors
**Критичність:** IMPORTANT — tsc толерує, але ламає деякі JSON/ESM парсери, забруднює git diff, неконсистентно з codebase
**Де шукати ще:** будь-який масовий sed/replace через PowerShell; коміти що чіпають багато файлів одночасно (validation-renames, import-reorgs)

---

### 2026-05-29 — rgba(var(--X-rgb)) на CSS var якого немає → hardcoded fallback ігнорує тему — §1 TypeScript/Tailwind

**Сигнал:** inline `style={{ backgroundColor: \`rgba(var(--color-primary-rgb, 59,130,246), ${a})\` }}` — `--color-primary-rgb` НЕ існує у globals.css; є лише `--color-primary: hsl(...)` (цілісне hsl-значення, НЕ rgb-триплет)
**Причина виникнення:** розробник хоче brand-колір з alpha, припускає що існує rgb-триплет варіант токена → пише rgba(var(...)) з «безпечним» числовим fallback; var невизначений → CSS мовчки бере fallback → колір захардкоджений, ігнорує тему й dark mode (жодної TS/runtime помилки, виглядає «майже правильно»)
**Підхід до виявлення:** grep `rgba\(var\(--|hsla?\(var\(--` у .tsx/.ts → для кожного var звірити з globals.css; токени `--color-*` тримають цілісне hsl()/var(), не триплети → не годяться всередині rgba()/hsla()
**Підхід до фіксу:** `color-mix(in srgb, var(--color-X) ${round(a*100)}%, transparent)` — тема-aware alpha на реальному токені (Tailwind 4 baseline підтримує color-mix). Inline `style` з цілим токеном (`var(--color-primary)` без alpha) — OK.
**Критичність:** IMPORTANT — degradation без помилки: фіксований колір, зламаний dark mode/rebrand
**Де шукати ще:** heatmap/badge/progress-bar з brand-альфою; будь-який rgba(var()) у JS-style або в @layer CSS

---

### 2026-05-29 — Promise.all(days.map(apiFetch)) fan-out без cap і без abort — §7.2 Frontend Performance

**Сигнал:** `await Promise.all(days.map(d => apiFetch(\`/x?date=${d}\`)))` — масив генерується з діапазону дат/масиву id; немає cap на довжину, немає AbortController при зміні параметра (місяць/діапазон)
**Причина виникнення:** немає range-endpoint на бекенді → розробник fan-out-ить по днях; забуває що (1) custom-діапазон може бути роком (365 паралельних запитів → вичерпання connection pool браузера + перевантаження API); (2) швидке перемикання влаштовує race — стара партія резолвиться ПІСЛЯ нової й перезаписує свіжий стан (виграє остання-зарезолвлена, не остання-запитана); mountedRef рятує лише від unmount, не від switch-race
**Підхід до виявлення:** grep `Promise\.all\(\s*\w+\.map\(` → перевірити чи всередині apiFetch → звірити cap (MAX_N) + AbortController-ref
**Підхід до фіксу:** (1) `const ac = new AbortController(); ref.current?.abort(); ref.current = ac;` на старті loader; передати `{ signal: ac.signal }` у кожен apiFetch; `if (ac.signal.aborted) return` перед setState. (2) cap довжину масиву (`while (cur <= end && n < MAX_N)`); clamp будь-який знаменник що залежить від days до того ж cap; UI-підказка коли діапазон обрізано
**Критичність:** IMPORTANT — stale-data race + потенційне перевантаження (degradation без помилки)
**Де шукати ще:** calendar month/stats, будь-який per-day/per-id loader; bulk-prefetch на dashboard

---

### 2026-05-29 — event-handler fetch без request-token + stale похідний id — §8.2 UI Стани

**Сигнал:** `openEdit(item)` / `openCard` / `onSelect` (обробник події, НЕ useEffect) робить `apiFetch(...).then(setState)`; при повторному відкритті для іншого id попередній in-flight fetch резолвиться пізніше й перезаписує стан. Додатково: похідний стан (`modalGarageId`, обраний рядок) не скидається на старті handler → на fetch-failure лишається id попередньої сутності
**Причина виникнення:** `cancelled`-flag патерн (§3.1) застосовний лише у useEffect (cleanup на unmount/dep-change); у event-handler немає cleanup-hook → розробник копіює fetch без жодного guard. Stale похідний id особливо небезпечний: наступна мутація (`addVehicle`) POST-ить у гараж ПОПЕРЕДНЬОГО контрагента
**Підхід до виявлення:** grep `const (open|load|select)[A-Z]\w* = (async )?\(` + наявність apiFetch у тілі → перевірити token-ref guard перед кожним setState + reset похідного стану на першому рядку handler
**Підхід до фіксу:** `const reqId = ++ref.current;` на старті; `if (ref.current !== reqId) return` перед кожним `.then(setState)`/`.finally`; скинути всі похідні id (`setModalGarageId(null)`) до fetch
**Критичність:** IMPORTANT — stale-data race + крос-сутнісна мутація на fetch-failure (degradation/data corruption без TS/runtime помилки)
**Де шукати ще:** будь-яка edit/detail модалка що довантажує під-ресурси по кліку; picker що fetch-ить деталі обраного; master-detail з ledзінню child-колекцій

---

## Карта секцій (quick reference)

| # | Секція | Стосується |
|---|---|---|
| 1 | TypeScript | api/, web/, packages/ — завжди |
| 2 | Security | Guards, tenant, injection, secrets, BullMQ, JWT, Sentry |
| 3 | Memory Leaks | web/ hooks; api/ DB connections |
| 4 | Architecture | DI, events, error handling, list wrappers |
| 5 | Business Rules | FSM, inventory, settlements, soft delete, $transaction timeout |
| 6 | Database | N+1, take, indexes, select vs include, resurrection |
| 7 | Performance | Parallel queries; SSR/hydration |
| 8 | Web Frontend | API calls, UI states, SSR, auth, UX features, modularity |
| 9 | Sync Readiness | PULL_TABLES, PUSH_SAFE, BLACKLIST |
| 10 | Offline-First | BullMQ, зовнішні API |
| 11 | Configuration | Magic numbers, hardcoded templates |
| 13 | API Contract | DTO ↔ interface, BigInt, dynamic model, polymorphic entityType |
