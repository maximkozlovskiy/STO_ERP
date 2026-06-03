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

| Тип зміни              | Обов'язкові секції            | Пропустити           |
| ---------------------- | ----------------------------- | -------------------- |
| Новий `@Controller`    | §1, §2.1, §2.2, §2.3, §4, §13 | §3, §6, §9, §10, §11 |
| Новий `*.service.ts`   | §1, §4, §5, §6, §7.1          | §2, §8               |
| Нова Prisma модель     | §1, §6, §9                    | §2, §3, §5, §8       |
| Зміна `toResponseDto`  | §1, §13                       | всі інші             |
| Нова `page.tsx`        | §1, §3.1, §8                  | §2, §4, §5, §6, §9   |
| Новий `*.dto.ts`       | §1, §2.3, §2.4                | §3, §4, §5, §6       |
| Зміна BullMQ           | §1, §2.5, §10                 | §3, §4, §6, §8       |
| Новий `use*.ts` хук    | §1, §3.1                      | §2, §4, §5, §6, §9   |
| Новий `components/ui/` | §1, §8.5                      | §2, §4, §5, §6, §9   |
| Config / docs / tests  | §1 (tsc) — тільки             | всі інші             |

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

# requestAnimationFrame без id-capture (cancelAnimationFrame неможливий)
grep -rnE "^\s*requestAnimationFrame\(" apps/web/src/app apps/web/src/components --include="*.tsx"
# Для кожного — якщо callback мутує DOM (style.height/transition) або викликає setState — id має бути збережений у ref для cancelAnimationFrame на rapid toggle/unmount

# imperative style.* мутації у callback (rAF/RO/setTimeout) — перевірити що мають component-level unmount cleanup
grep -rnE "\.style\.(height|transition|marginBottom|opacity|transform)\s*=" apps/web/src/app --include="*.tsx"
# Для кожного — звірити що є cleanup рекордера (formHideTimerRef, formCloseRafRef) у dedicated unmount-only useEffect (() => () => {...}, [])
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
- [ ] `requestAnimationFrame` що мутує DOM/state → зберегти id у `useRef<number|null>(null)`; `cancelAnimationFrame` на старті наступного toggle-ефекту + у component-level unmount cleanup `useEffect(() => () => {...}, [])`. Інакше rapid toggle лишає stale rAF що перезаписує щойно-відкритий стан (height='0px' на open form).
- [ ] Pair `setTimeout` + `requestAnimationFrame` для open/close-анімації → обидва id у refs; обидва cleanup-ються у dedicated unmount-effect (`useEffect(() => () => { clearTimeout(t); cancelAnimationFrame(r); }, [])`) — недостатньо чистити лише на наступному toggle, бо unmount між циклами зловить.

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

# Bulk-apply patterns: per-iteration $transaction([...]) + per-iteration calculate*()
# Сигнал що bulk-метод робить N окремих TX замість 1 batched (N+1 + missing timeout)
for f in $(grep -rl "for.*of.*\(lines\|items\|rows\|goods\)" apps/api/src/modules/ --include="*.service.ts" | grep -v spec); do
  has_calc=$(grep -c "await.*calculate\|await.*\.compute" "$f")
  has_arr_tx=$(grep -c "await this\.prisma\.\$transaction(\[" "$f")
  [ "$has_calc" -gt 0 ] && [ "$has_arr_tx" -gt 0 ] && echo "BULK-APPLY suspect: $f"
done
```

- [ ] Незалежні запити → `Promise.all([...])` (не sequential `await`)
- [ ] Важкі операції (PDF, масовий import) → BullMQ, не request handler
- [ ] Немає `fs.readFileSync` у request handlers
- [ ] **Bulk-apply паттерн:** методи що `for (const line of po.lines)` → перевірити що (a) calc-service prefetched ОДИН раз перед loop (не fetch per-item), (b) updates batched у `$transaction(async tx => {...}, { timeout: N })` chunked по 100 — НЕ per-iteration `await $transaction([...])` (array-form без timeout default 5s; на 50+ items під load → cascading default-timeout fail). Приклад patter: див. `pricing.service.ts:applyRuleToGoods` (eталон) vs ANTI-pattern до Bug #194 у `purchase-orders.service.ts:applyPricing`

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

# Hover-only кнопки без focus-visible/focus → невидимі при Tab-навігації (WCAG 2.1.1)
# Виключаємо pointer-events-none overlays (декоративні, не інтерактивні)
grep -rn "group-hover:opacity-100" apps/web/src/ --include="*.tsx" \
  | grep -v "focus-visible:opacity-100\|focus:opacity-100\|pointer-events-none"

# Animation wrapper з власним `if (!open) return null` ламає exit-анімацію Modal
# Wrapper що рендерить <Modal>/<PickerModal>/<SearchPickerModal> не має робити цей guard самостійно
for f in $(grep -rl "if (!open) return null" apps/web/src/components/ui --include="*.tsx"); do
  has_modal_wrapper=$(grep -c "<Modal\b\|<PickerModal\b\|<SearchPickerModal\b" "$f")
  [ "$has_modal_wrapper" -gt 0 ] && echo "EXIT-ANIM BUG: $f має if(!open) перед <Modal>"
done

# Глобальний [data-state] селектор у globals.css без скоп-маркера — небезпечно
# (Radix/HeadlessUI використовують data-state="open|closed" як публічний контракт)
grep -nE "^\[data-state=" apps/web/src/app/globals.css | grep -v "data-animate"
```

- [ ] `toast.X(...)` → `if (features.toastEnabled)`; fallback: `setError(msg)`
- [ ] Bulk-мутації → `Promise.allSettled` + `bulkSelect.clear()` + `load()` у finally
- [ ] `indeterminate` → `useRef` + `useEffect([dep])`, не inline `ref={el => el.indeterminate = x}`
- [ ] `useBulkSelect` → items prop оновлюється при `setData`
- [ ] Кнопка delete / hover-only action → `group-hover:opacity-100` **+ `focus-visible:opacity-100`** (або `focus:opacity-100`). Без focus-стану Tab-фокус приховує кнопку → недоступно з клавіатури. Виняток: `pointer-events-none` overlay-індикатори (декоративні, не інтерактивні).

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

**Сигнал:** inline `style={{ backgroundColor: \`rgba(var(--color-primary-rgb, 59,130,246), ${a})\` }}`—`--color-primary-rgb`НЕ існує у globals.css; є лише`--color-primary: hsl(...)`(цілісне hsl-значення, НЕ rgb-триплет)
**Причина виникнення:** розробник хоче brand-колір з alpha, припускає що існує rgb-триплет варіант токена → пише rgba(var(...)) з «безпечним» числовим fallback; var невизначений → CSS мовчки бере fallback → колір захардкоджений, ігнорує тему й dark mode (жодної TS/runtime помилки, виглядає «майже правильно»)
**Підхід до виявлення:** grep`rgba\(var\(--|hsla?\(var\(--`у .tsx/.ts → для кожного var звірити з globals.css; токени`--color-*`тримають цілісне hsl()/var(), не триплети → не годяться всередині rgba()/hsla()
**Підхід до фіксу:**`color-mix(in srgb, var(--color-X) ${round(a*100)}%, transparent)`— тема-aware alpha на реальному токені (Tailwind 4 baseline підтримує color-mix). Inline`style` з цілим токеном (`var(--color-primary)` без alpha) — OK.
**Критичність:** IMPORTANT — degradation без помилки: фіксований колір, зламаний dark mode/rebrand
**Де шукати ще:** heatmap/badge/progress-bar з brand-альфою; будь-який rgba(var()) у JS-style або в @layer CSS

---

### 2026-05-29 — Promise.all(days.map(apiFetch)) fan-out без cap і без abort — §7.2 Frontend Performance

**Сигнал:** `await Promise.all(days.map(d => apiFetch(\`/x?date=${d}\`)))`— масив генерується з діапазону дат/масиву id; немає cap на довжину, немає AbortController при зміні параметра (місяць/діапазон)
**Причина виникнення:** немає range-endpoint на бекенді → розробник fan-out-ить по днях; забуває що (1) custom-діапазон може бути роком (365 паралельних запитів → вичерпання connection pool браузера + перевантаження API); (2) швидке перемикання влаштовує race — стара партія резолвиться ПІСЛЯ нової й перезаписує свіжий стан (виграє остання-зарезолвлена, не остання-запитана); mountedRef рятує лише від unmount, не від switch-race
**Підхід до виявлення:** grep`Promise\.all\(\s\*\w+\.map\(`→ перевірити чи всередині apiFetch → звірити cap (MAX_N) + AbortController-ref
**Підхід до фіксу:** (1)`const ac = new AbortController(); ref.current?.abort(); ref.current = ac;`на старті loader; передати`{ signal: ac.signal }`у кожен apiFetch;`if (ac.signal.aborted) return` перед setState. (2) cap довжину масиву (`while (cur <= end && n < MAX_N)`); clamp будь-який знаменник що залежить від days до того ж cap; UI-підказка коли діапазон обрізано
**Критичність:** IMPORTANT — stale-data race + потенційне перевантаження (degradation без помилки)
**Де шукати ще:** calendar month/stats, будь-який per-day/per-id loader; bulk-prefetch на dashboard

---

### 2026-05-30 — close-animation rAF без id-capture + missing unmount cleanup — §3.1 Memory Leaks

**Сигнал:** `requestAnimationFrame(() => {...})` всередині close-branch toggle-ефекту мутує DOM (`outer.style.height='0px'`); id не зберігається; rapid toggle (close → open у тому ж frame) лишає pending rAF що перезаписує щойно-відкритий стан. Парний `setTimeout(setMounted(false), 420)` теж без component-unmount cleanup.
**Причина виникнення:** розробник додає collapse-анімацію (height→0 перед unmount); цикл toggle-ефекту чистить timer на наступному переході (`if (timerRef.current) clearTimeout(...)`), але забуває: (1) rAF взагалі не captureться → cancelAnimationFrame неможливий; (2) unmount між циклами не запускає toggle-логіку → pending timer/rAF переживає unmount, fire-ить setState/style на мертвий компонент. Тип помилки невидимий статично (TS зелений, RO має cleanup), проявляється лише при швидкому повторному відкритті або при навігації під час анімації.
**Підхід до виявлення:** grep `requestAnimationFrame(` у компонентах → перевірити чи id зберігається у ref; для пари (setTimeout + rAF) у toggle-ефекті — звірити що **обидва** cleanup-ються у dedicated unmount-only `useEffect(() => () => {...}, [])`, не лише на наступному toggle.
**Підхід до фіксу:** (1) `const rafRef = useRef<number|null>(null); rafRef.current = requestAnimationFrame(() => { rafRef.current = null; ... })`; (2) на старті toggle-ефекту `if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)`; (3) окремий unmount-effect `useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, [])`.
**Критичність:** IMPORTANT — visual glitch (height=0 на щойно-відкриту форму) + React warning "setState on unmounted component"; degradation без crash.
**Де шукати ще:** будь-який open/close-анімований компонент з парою (rAF + setTimeout) — Drawer, Sheet, Accordion, custom Modal-like; collapse-секції з ResizeObserver-driven height.

---

### 2026-05-30 — PATCH normalizeScope clear: всі exclusivity-сусіди мають однаковий null-out патерн — §5 Business Rules

**Сигнал:** мульти-полий exclusive scope (наприклад, goodId/brandId/goodCategory/goodType) у PATCH. Після `normalizeScope(merged)` 3 з 4 полів пишуться як `normalized.X ?? null` (правильно "знизити" якщо вище-пріоритетне поле тепер встановлене), але одне (зазвичай **нове додане**) поле зберігає старий патерн `normalized.X !== undefined ? (normalized.X ?? null) : existing.X` → коли normalizeScope очищає його до undefined (бо вище-пріоритетне поле тепер виграє), update лишає старе DB значення → 2 exclusive поля одночасно у рядку
**Причина виникнення:** додано нове поле (наприклад brandId до уже існуючих goodId/goodCategory/goodType) у середину пріоритетної ієрархії; розробник копіює "найбезпечніший" патерн (зберегти existing якщо undefined) не помічаючи що сусідні поля використовують агресивнішу `?? null`-нормалізацію; різниця "якщо normalizeScope нас знизив — все одно треба очистити" не очевидна без trace через сценарій
**Підхід до виявлення:** для будь-якого PATCH-контролера з exclusivity (нормалізатором scope-полів) — звірити що ВСІ exclusive-поля використовують однакову форму write-back; якщо одне `?? null`, а інше з `existing.X` fallback — bug; альтернатива: трейс "PATCH {goodId:'g1'} на правилі з {brandId:'b1'}" → чи лишається brandId у DB?
**Підхід до фіксу:** уніфікувати — `<field>: normalized.<field> ?? null` для всіх exclusive-сусідів; `existing.X` fallback потрібен ЛИШЕ для non-exclusive полів (name, priority, isActive)
**Критичність:** CRITICAL — silent data corruption, порушення інваріанту scope-exclusivity; будь-який наступний `applyRule` / `calculateSalePrice` отримує неоднозначний контекст
**Де шукати ще:** будь-який модуль із pricing-like exclusivity (taxes по type/category, discounts по brand/customer-group), FSM з кількома "терміналами"; коли PATCH контролер має `mergedScope` + `normalizeScope` patterns

---

### 2026-05-30 — fire-and-forget PUT у hook без AbortController → out-of-order writes — §8.2 UI Стани

**Сигнал:** хук викликає `apiFetch('/x', { method: 'PUT', body }).catch(() => {})` без AbortController; локальний стан керується через `setState(prev => ...)` (правильно), але **серверний** стан останньою-резолвленою-партією → rapid toggle 10×, серверні writes резолвлять out-of-order, на сервері зберігається стале значення; на reload — користувач бачить НЕ те що було видно перед закриттям вкладки
**Причина виникнення:** розробник правильно враховує race для локального стану (`setState(prev)`), але не думає про серверну upsert черговість; `.catch(() => {})` ховає AbortError так само як network-помилки; тестування у dev — usually one PUT at a time → ніколи не ловлять
**Підхід до виявлення:** grep `apiFetch(.+, { method: 'PUT' }).catch` у хуках; будь-який callback-write що викликається у onChange/onClick з частою повторюваністю (toggle/slider/keystroke); якщо ref-trackera немає — кандидат
**Підхід до фіксу:** `const abortRef = useRef<AbortController | null>(null); const save = useCallback((next) => { abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac; apiFetch(..., { method: 'PUT', body, signal: ac.signal }).catch(() => {}); }, []);` + cleanup `useEffect(() => () => { abortRef.current?.abort(); }, [])` на unmount
**Критичність:** IMPORTANT — server-state drift без crash; найгірше — між-сесійна неузгодженість що користувач помічає лише при логіні з іншого пристрою
**Де шукати ще:** будь-який settings-хук (`useTableColumns`, `useDetailPanel`, `useUiFeatures` подібний з API-persistance); будь-яка фіча "save user preference" з debounce-у-голові-розробника-але-без-debounce-у-коді

---

### 2026-05-30 — `@Param('key')` без validation — нескінченний рядок у Prisma where — §2.3 Injection & Input Validation

**Сигнал:** `@Param('key') key: string` (або інший рядковий path param НЕ uuid) → потрапляє у `prisma.X.findFirst({ where: { ..., key } })`. ValidationPipe не валідує `@Param` (валідує лише `@Body`/`@Query` через DTO). DTO body має `@MaxLength(200)` на тому самому полі, але path — без обмежень. Користувач/атакувальник може слати URL з 10KB ключем.
**Причина виникнення:** уявлення що ParseUUIDPipe + DTO на body вже "все покривають"; non-uuid path param випадає з-під захисту; не SQL-injection (Prisma параметризує), але DoS-вектор (важкий B-tree lookup) + потенційне порушення CDN cache-key обмежень
**Підхід до виявлення:** grep `@Param('[^']+')` без ParseUUIDPipe → перевірити що або (а) value passes through DTO validation, або (б) контролер має explicit guard на довжину/формат
**Підхід до фіксу:** функція-guard `ensureValidKey(key)` що кидає `BadRequestException` при `length > N` (узгоджена з MaxLength у DTO); викликається на початку handler перед service-call. Альтернатива: створити custom pipe `KeyLengthPipe` для повторного використання
**Критичність:** IMPORTANT — DoS vector + log/header pollution; не data breach, але порушує defence-in-depth
**Де шукати ще:** user-preferences, search endpoints з path-param query, dynamic config endpoints, будь-який REST-у-стилі-name-як-id endpoint

---

### 2026-05-30 — Soft-delete rule з child-таблицею + type-switch → "відродження" дочірніх записів — §5 Business Rules

**Сигнал:** parent-модель з типом-перемикачем (`type: 'COST_TIER' | 'PERCENT' | ...`) має один child-relation що активний лише для одного типу (`tiers` для `COST_TIER`). PATCH міняє `type` на інший, але child-таблиця НЕ чиститься → старі child-записи лишаються прив'язаними. Поки `type !== 'COST_TIER'` — не використовуються (бо `switch (rule.type)` ігнорує `case 'COST_TIER'`). Користувач перемикає назад → "відродження" старих тірів якими він давно не керує.
**Причина виникнення:** frontend `buildPayload` правильно не надсилає `tiers` для non-COST_TIER type → controller `if (tiers !== undefined)` — false → skip tier-tx; розробник орієнтується на "чи у нас НОВІ дані для child?" замість "чи треба ВИДАЛИТИ старі child-дані?"
**Підхід до виявлення:** для PATCH-контролерів з `type` switching + child-таблицями — звірити що `switchedAwayFrom<X>` логіка викликає `child.deleteMany` коли тип більше не сумісний з child-relation; інакше grep `prisma.<child>.deleteMany` у PATCH handler і перевірити що умова покриває type-switch case
**Підхід до фіксу:** `const switchedAway = normalized.type !== undefined && normalized.type !== '<TYPE_X>' && existing.type === '<TYPE_X>';` → запустити `tx.<child>.deleteMany` у тій же транзакції; розширити умову входу в tier-tx: `if (tiers !== undefined || switchedAway) ...`
**Критичність:** IMPORTANT — data drift, неочікувана поведінка при поверненні на тип; не immediate crash, але порушує модель "що бачу, тим і керую"
**Де шукати ще:** PricingRule (this fix), TaxRate з type-switch + brackets, Discount з type-switch + rules — будь-яке "правило-з-варіантами-та-власною-таблицею-параметрів"

---

### 2026-05-30 — rAF у persistent effect (не toggle) без id-capture — §3.1 Memory Leaks

**Сигнал:** компонент монтується назавжди (`useEffect(() => { ... requestAnimationFrame(() => style.X = Y) }, [])` — порожні deps), rAF мутує DOM (`.style.transition`/`.style.height`), id НЕ зберігається у ref → невозможно cancel при unmount; парний ResizeObserver правильно `disconnect()`-иться, що створює false sense of security
**Причина виникнення:** розробник додає rAF для "next frame після initial measurement" (зняти `transition: none` після першого measure); фокусується на ResizeObserver-cleanup і пропускає rAF як "одноразову" дію; реальність: rAF planning queue може триматися 16-32ms, unmount між schedule і fire → rAF callback fire-ить на detached DOM (ref.current === null → noop, OK), або на щойно-перемонтованому компоненті того ж типу (rare React internals reuse → state corruption)
**Підхід до виявлення:** grep `requestAnimationFrame(` всередині `useEffect` → перевірити (1) чи id зберігається у `useRef<number|null>(null)`; (2) чи cleanup return викликає `cancelAnimationFrame(rafRef.current)`; це справедливо НАВІТЬ для persistent effect (deps=[]), не лише для toggle (§3.1 попереднього патерну)
**Підхід до фіксу:** `const rafRef = useRef<number|null>(null); ... rafRef.current = requestAnimationFrame(() => { rafRef.current = null; ... }); return () => { ro.disconnect(); if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };` — комбінований cleanup для всіх registered async callbacks
**Критичність:** IMPORTANT — інколи degradation без crash, інколи "ghost" DOM mutation; найбільш ризиково для AnimatedBody / Drawer / collapse-секцій що часто mount/unmount
**Де шукати ще:** будь-який mount-only effect з rAF (initial measurement, scroll-into-view, focus management), persistent layout effect для height-auto detection

---

### 2026-05-30 — Soft-delete update без orgId у where → race-window для cross-session reuse — §2.2 Tenant Isolation / §5 Business Rules

**Сигнал:** контролер робить `findFirst({ id, orgId })` для перевірки → потім `prisma.X.update({ where: { id } })` БЕЗ orgId у where. Якщо існує `deletedAt: null` guard у findFirst, але update використовує лише `id` → defense-in-depth відсутній. На soft-delete (`update({ where: { id }, data: { deletedAt: new Date() } })`) ризик особливо тонкий: race-window між findFirst і update — інша сесія може soft-delete-нути запис у тій же org → наш update «воскрешає» його (knock-on: ConflictException на @@unique переходить у silent state corruption)
**Причина виникнення:** TS не ловить (Prisma приймає `where: { id: string }` бо id — primary key); existing.org перевірка дає false sense of security; копіюючи цей патерн у новий модуль розробник навіть не помічає що orgId guard вже відсутній
**Підхід до виявлення:** grep `prisma\.X\.update\(\{\s*where:\s*\{\s*id` без `orgId` → перевірити чи попередня findFirst-перевірка є + чи update міняє sensitive поле (deletedAt, foreign keys). Для тенант-захисту патерн — `updateMany({ where: { id, orgId, deletedAt: null } })` з перевіркою `count === 0` → 404
**Підхід до фіксу:** замінити `update` → `updateMany({ where: { id, orgId, ...filters } })` + `findFirstOrThrow({ where: { id, orgId }, include: ... })` для повернення з relations (бо updateMany не приймає include). Для DELETE — перевіряти `result.count === 0` і кидати NotFoundException замість окремого findFirst. Bug #191 pattern (PO/xlsx apply-pricing) уже встановлено — переносити на ВСІ нові endpoints що update entity
**Критичність:** IMPORTANT — defense-in-depth gap (не immediate data breach, але порушує консистентність patterns у codebase і відкриває race-window для multi-session writes)
**Де шукати ще:** будь-який новий PATCH/DELETE handler що приймає `id` через `@Param`, особливо catalog/довідникові endpoints де `@@unique` може спричинити resurrection після cross-session soft-delete

---

### 2026-05-30 — bulk-apply loop: per-iteration `await $transaction([...])` без timeout + N+1 на calculateX — §5 Business Rules / §6 Database / §7.1 Performance

**Сигнал:** новий "bulk-apply" сервісний метод (`applyPricing`/`recalcAll`/`bulkUpdate`) пройшовся `for (const item of parent.children)` де: (1) всередині circle `await someService.calculateX()` що сам робить `findMany` (N+1 — N запитів правил/конфігів); (2) для кожної зміни — окремий `await this.prisma.$transaction([... 2-3 statements])` БЕЗ `{ timeout }` (array-form не приймає, але якщо переробити на callback-form з timeout — швидко рятує). При 50 лініях = 50 calc-queries + 50 окремих TX; на 5s default timeout під connection pool тиском може почати fail-ити з cascading effect
**Причина виникнення:** copy-paste з 1-item методу (apply rule to ONE good → apply to PO lines); розробник не помічає що "atomic per-item" перетворюється на 50+ окремих TX (відомий патерн уникнення транзакційного локу, але тут навпаки — кожна TX лочить good row + price_history row, race з іншими користувачами); calc-service за дизайном fetches rules per-call (правильно для one-shot), а у bulk-context — потрібен prefetch
**Підхід до виявлення:** grep `for.*of.*lines\|for.*of.*items` у `*.service.ts` → перевірити (1) чи всередині є `await this.prisma.$transaction(`, (2) чи всередині є `await this.<otherService>.calculate*`; **обидва ХОЛОДНІ сигнали** = bulk-apply pattern → треба refactor на (a) prefetch один раз + in-memory computation, (b) batch-update у одну/кілька chunked TX з explicit timeout
**Підхід до фіксу:** (1) винести pure compute helper у calc-service як public + додати prefetch helper (`getActiveRulesForOrg(orgId)`); (2) переробити bulk-метод: `const rules = await calc.getActiveRulesForOrg(orgId)` → for-loop тільки compute у пам'яті → побудувати `plan: Update[]` → batch `$transaction(async tx => {...}, { timeout: 10_000 })` chunked по 100 (як уже працює `applyRuleToGoods` у `pricing.service`); (3) defense-in-depth status guard на початку bulk-методу — UI рендерить кнопку умовно, але клієнт обходиться (curl POST → можна розцінити CANCELLED)
**Критичність:** CRITICAL — на великому PO (50+ ліній) silent default-timeout fail з частково-завершеною операцією (5 ліній розцінено, 45 ні, користувач не знає); на пустому PO degradation непомітна → пізно виявляється
**Де шукати ще:** будь-який endpoint що "apply X to all Y" (apply pricing, recalc totals, sync prices, mass update); інкрементальні bulk endpoints де compute-service не bulk-aware

---

### 2026-05-30 — Hook signature change → broken call-sites silently passed by linter — §1 TypeScript

**Сигнал:** новий required parameter додано у експортовану hook (наприклад `useColumnDrag(visibleColumns, reorder, allColumns)` з 2-arg → 3-arg); після рефакторингу tsc на одному pass показує `Expected N arguments, but got M` тільки для тих файлів які ще не оновлені; легко пропустити якщо --incremental cache повертає stale результат
**Причина виникнення:** автоматичне покращення хука (додавання preserve-hidden-slot логіки) → linter/IDE іноді частково оновлює call-sites через quick-fix, але інші лишаються; web cached tsc видає 0 errors при --incremental true, але --incremental false показує реальний стан
**Підхід до виявлення:** після будь-якої hook signature зміни — `grep -rn "<hookName>\(" apps/web/src/app` → перевірити що arity у кожному виклику відповідає новій сигнатурі; ОБОВ'ЯЗКОВО запустити tsc з `--incremental false`
**Підхід до фіксу:** оновити всі call-sites у одному коміті разом з hook; типовий патерн — передавати existing destructured value (`orderedColumns`) яка вже є у scope з `useTableColumns`
**Критичність:** IMPORTANT — runtime undefined → null deref або silent incorrect behavior (у нашому випадку `allColumns.map(c => c.key)` на undefined → crash при першому drag); TS компілятор ловить, але кеш приховує
**Де шукати ще:** будь-яка зміна expoрт-ованого hook signature або prop interface shared компонента; завжди --incremental false на финальному tsc check

---

### 2026-05-30 — Buffer.buffer as ArrayBuffer ігнорує byteOffset/byteLength → читання з пулу — §2.3 Injection / §1 TS

**Сигнал:** `await library.load(buffer.buffer as ArrayBuffer)` (ExcelJS/jszip/protobuf parsers). Buffer.allocUnsafe (типовий шлях для multipart/fastify uploads) — це view над пулом → `buffer.buffer` повертає весь пул, `byteOffset` НЕ 0, `byteLength` < `buffer.buffer.byteLength`. Парсер читає від offset 0 → отримує дані інших buffer-ів у пулі або garbage до actual data.
**Причина виникнення:** автоматичний рефактор `(workbook.xlsx as any).load(buffer)` → `workbook.xlsx.load(buffer.buffer as ArrayBuffer)`; розробник прибрав `as any` лише типово, не подумав про Buffer pool семантику; tsc приймає (Buffer extends Uint8Array, .buffer типу ArrayBufferLike → cast OK), runtime парсить garbage → "невідома помилка" або silent data corruption
**Підхід до виявлення:** grep `\.buffer as ArrayBuffer\b` у апі-сервісах → перевірити що `byteOffset === 0` гарантовано (для NEW Buffer(N), Buffer.alloc(N) — так; для Buffer.allocUnsafe, .from(arrayBuffer, offset, len), .subarray — НІ); особливо ризиковано: fastify-multipart, .pipe()-based streams, anything that calls allocUnsafe internally
**Підхід до фіксу:** helper `private toArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer; }`; slice створює copy саме нашого зрізу. Альтернатива: якщо API приймає `Buffer` напряму (ExcelJS `load(buffer: Buffer)`) — не передавати `.buffer` взагалі, тримати Buffer-вхід.
**Критичність:** CRITICAL — silent data corruption на uploaded xlsx (буде вилазити лише на проді коли pool заповнений); локальний dev часто має byteOffset=0 і фікс не помічається
**Де шукати ще:** будь-який parser що приймає `ArrayBuffer` (ExcelJS, jspdf, mammoth, protobuf, sharp, browserify-buffer adapters); WebCrypto API (`crypto.subtle.verify(..., data: ArrayBuffer)`) на нодах де data приходить з http body

---

### 2026-05-30 — SSE/EventSource + global ThrottlerGuard → reconnect-loop вичерпує rate-limit — §2 Security / §4 Architecture

**Сигнал:** `@Sse()` endpoint + global `ThrottlerGuard` без явного `@SkipThrottle()` на цьому endpoint. Frontend має auto-reconnect (5s після network error) + browser native EventSource reconnect (1s default) + manual reconnect on token-expiry → під час degradation мережі та сама IP може зробити 50+ reconnect-ів/хв, з'ївши rate-limit budget для всіх tabs/users за NAT.
**Причина виникнення:** глобальний ThrottlerGuard додають "як defence-in-depth" → забувають що SSE — це довге з'єднання що рахується як 1 запит при відкритті, але EVERY reconnect — це новий запит; під load reconnect-storm моментально валить ліміт; ще гірше — налагоджена на user-experience черга reconnect-ів запускає cascading degradation бо валиться УВЕСЬ API за того ж IP
**Підхід до виявлення:** `grep '@Sse()\|@Get.*stream\|new EventSource'` → для кожного SSE endpoint у backend перевірити `@SkipThrottle()`; на frontend перевірити що reconnect має exponential backoff (НЕ fixed 5s) + max-attempts cap
**Підхід до фіксу:** (1) `import { SkipThrottle } from '@nestjs/throttler'` + `@SkipThrottle()` на SSE-endpoint; (2) (опційно) custom throttle on SSE — `@Throttle({ default: { ttl: 60_000, limit: 5 } })` що ліімтує лише opens-per-minute, не самі messages, але потребує custom guard що враховує час життя з'єднання
**Критичність:** IMPORTANT — degradation під час network instability, потенційний DoS за NAT; не immediate breach, але порушує availability invariant
**Де шукати ще:** будь-який long-polling endpoint, WebSocket gateway (хоча @WebSocketGateway зазвичай не йде через HTTP guards), `@Get` з `Observable` return type, `@Header('Content-Type', 'text/event-stream')`

---

### 2026-05-30 — Constants exported but unused → orphan API surface — §1 TS / §11 Configuration

**Сигнал:** `export const MAX_QUERY_LIMIT = 1000;` у `@sto/shared/src/constants.ts` — але `grep -rn "MAX_QUERY_LIMIT" apps/` повертає 0 матчів; commit-message обіцяє "MAX_QUERY_LIMIT on findMany" але код не використовує
**Причина виникнення:** plan-driven рефактор додає constant у shared "для майбутнього використання"; усі findMany вже мають explicit `take:`; розробник лишає експорт як "API hook for future" → з часом стає мертвим кодом, наступна людина копіює його у новий файл не розуміючи що нікому не потрібно
**Підхід до виявлення:** після кожного commit що додає `export const` у `packages/shared` → `grep -rn "<NAME>" apps/` — якщо 0 → або (а) видалити, або (б) додати TODO-коментар з планом використання + issue link
**Підхід до фіксу:** для unused constants — або (а) використати у виявлених сирітських findMany (`take: MAX_QUERY_LIMIT` як safety cap де було `take: 1000`), або (б) додати `// TODO: <plan>` коментар; не залишати "голий" export без використання
**Критичність:** SUGGESTION — не баг; degradation якості API через orphan surface
**Де шукати ще:** будь-який shared package export після `feat:`/`refactor:` commit; особливо magic numbers extracted до constants без consumer refactor

---

### 2026-05-30 — Cache-Control: public на JWT-захищеному endpoint → cross-tenant витік через shared cache — §2 Security / §2.2 Tenant Isolation

**Сигнал:** `@Header('Cache-Control', 'public, max-age=N')` на `@Controller`/`@Get` що також має `@UseGuards(JwtAuthGuard, RolesGuard)`. `public` дозволяє ПРОМІЖНІМ shared cache (CDN, корпоративний proxy, ServiceWorker без vary-by-Authorization, Cloudflare/Nginx) кешувати відповідь і віддавати її НАСТУПНИМ запитам з іншою сесією/Authorization → org-A може отримати tenant-scoped дані org-B; запит з role MECHANIC може отримати закешовані дані OWNER.
**Причина виникнення:** розробник копіює "browser cache" патерн з публічних static-assets (CDN cookbook) → припускає що `Authorization` header автоматично йде у cache key. Реальність: `public` сигналізує proxy "OK кешувати без vary"; навіть якщо `Vary: Authorization` додати, шерені proxy часто його ігнорують або key-collision на token-rotation; ServiceWorker без custom `vary`-обробки кешує по URL.
**Підхід до виявлення:** `grep -rn "Cache-Control.*public" apps/api/src/modules --include="*.controller.ts"` → для кожного матчу перевірити: чи контролер/метод має `@UseGuards(JwtAuthGuard)` або `JwtAuthGuard` глобально → якщо ТАК → CRITICAL, замінити на `private`. `public` коректний ЛИШЕ для `@Public()` endpoints (login page assets, /api/health, booking GET без auth).
**Підхід до фіксу:** `Cache-Control: private, max-age=N, stale-while-revalidate=M` — `private` означає "кешувати лише у браузері клієнта, ніколи у proxy/CDN"; `max-age` досягає UX-цілі (миттєвий другий рендер сторінки) без cross-tenant ризику. Для sensitive endpoints (auth status, billing) → `no-store`.
**Критичність:** CRITICAL — cross-tenant data leak; не immediate breach (CDN/proxy не всюди), але один невірно налаштований Nginx у проді = catastrophic; defence-in-depth invariant порушений.
**Де шукати ще:** будь-який нещодавно доданий `@Header('Cache-Control', ...)`; reference-data endpoints (`/branches`, `/zones`, `/units`); особливо ризиковано після кожного "performance sprint" що додає кеш для зменшення payload.

---

### 2026-05-30 — IsUUID('4') у DTO ламає тести з nil-style UUID fixtures — §1 TypeScript / §2.3 Input Validation

**Сигнал:** `@IsUUID('4')` (або `@IsUUID('4', { each: true })`) у DTO; контрактні тести використовують hex-only fixture типу `00000000-0000-0000-0000-000000000099` як placeholder для "id з іншої org". Class-validator `isUUID(value, '4')` (а також без аргументу) перевіряє RFC4122 version digit — `00000000...` має version digit `0` → відхиляється як 400 Bad Request, тест очікує 404 Not Found.
**Причина виникнення:** розробник переходить з `@Matches(/^[0-9a-f]{8}-...$/i)` (плоский hex regex, приймає будь-який hex-64-формат) на `@IsUUID('4')` (RFC4122-strict, лише версії 1-5 з вірним nibble), вважаючи це "правильнішим" — забуває що (1) тестові fixtures десятиліттями використовують nil-style UUIDs для синтетичних ID; (2) бекенд також генерує seed-data з ручними UUIDs (demo, sync, fixtures, migration-rollback ID); (3) ParseUUIDPipe на path-param може мати інші правила.
**Підхід до виявлення:** після будь-якого великого replacement `Matches` → `IsUUID('4')` чи `IsUUID()` — `pnpm --filter @sto/api test` ОБОВ'ЯЗКОВО; шукати у \*.spec.ts UUID-фікстури типу `00000000-` чи `aaaaaaaa-aaaa-aaaa-` — це сигнал що валідація змінила контракт.
**Підхід до фіксу:** два варіанти: (а) **`@IsUUID()` без версії** — приймає всі RFC4122 v1-5; це default класу-валідатор, але `00000000-...` усе ще rejected. (б) **Оновити test fixtures на v4** — `12345678-1234-4234-8234-123456789012` (third group починається з `4`, fourth з `8/9/a/b`); production `gen_random_uuid()` завжди v4. Skill-recommended підхід — оновити fixtures, бо v4 strict — реальніше contract і ловить malformed-id баги раніше.
**Критичність:** IMPORTANT — `feat:` commit з зеленим tsc лeгко мінятиме контракт без помітних test failures якщо репозиторій не запускає тести у CI на кожен push; кросс-cutting через 22+ DTO файлів.
**Де шукати ще:** будь-який masseren UUID-validation refactor; sync seeds; demo-data fixtures; migration rollback tests; будь-який тест що inject-ить `00000000-...` у POST/PATCH body чи URL.

---

### 2026-05-29 — event-handler fetch без request-token + stale похідний id — §8.2 UI Стани

**Сигнал:** `openEdit(item)` / `openCard` / `onSelect` (обробник події, НЕ useEffect) робить `apiFetch(...).then(setState)`; при повторному відкритті для іншого id попередній in-flight fetch резолвиться пізніше й перезаписує стан. Додатково: похідний стан (`modalGarageId`, обраний рядок) не скидається на старті handler → на fetch-failure лишається id попередньої сутності
**Причина виникнення:** `cancelled`-flag патерн (§3.1) застосовний лише у useEffect (cleanup на unmount/dep-change); у event-handler немає cleanup-hook → розробник копіює fetch без жодного guard. Stale похідний id особливо небезпечний: наступна мутація (`addVehicle`) POST-ить у гараж ПОПЕРЕДНЬОГО контрагента
**Підхід до виявлення:** grep `const (open|load|select)[A-Z]\w* = (async )?\(` + наявність apiFetch у тілі → перевірити token-ref guard перед кожним setState + reset похідного стану на першому рядку handler
**Підхід до фіксу:** `const reqId = ++ref.current;` на старті; `if (ref.current !== reqId) return` перед кожним `.then(setState)`/`.finally`; скинути всі похідні id (`setModalGarageId(null)`) до фetch
**Критичність:** IMPORTANT — stale-data race + крос-сутнісна мутація на fetch-failure (degradation/data corruption без TS/runtime помилки)
**Де шукати ще:** будь-яка edit/detail модалка що довантажує під-ресурси по кліку; picker що fetch-ить деталі обраного; master-detail з ledзінню child-колекцій

---

### 2026-05-31 — Per-item line.id-keyed onSelect sub-resource race — §8.2 UI Стани

**Сигнал:** `lines.map((l, i) => ... onSelect={async g => { setLines(...); const subResource = await apiFetch(\`/x/${g.id}/Y\`); setLines(ls => ls.map((x, idx) => idx === i ? {...x, subResource} : x)) }}` — index-keyed update після async fetch у row-array form (PO/SD/Invoice line, dynamic-form тощо). Користувач швидко змінює good у тому ж row → друга відповідь може прийти раніше першої → застосовується под-ресурс від goodId₂ до goodId₁ (silent UI inconsistency: показаний товар X, але UoM-list для товару Y)
**Причина виникнення:** lines зберігаються у локальному state з position-based identity (`idx === i`); після async fetch idx все ще валідний — але вміст рядка може бути іншим. `cancelled`-flag з §3.1 не годиться (це event-handler, не useEffect); ref-token з 2026-05-29 patten — overkill для row-array (потребує `useRef<Record<index, number>>`); найпростіший фікс — захопити identity entity-id на початку handler (`const selectedGoodId = g.id`) і всередині setLines callback перевірити `x.goodId === selectedGoodId`перед мерджем
**Підхід до виявлення:** grep`onSelect={async\|onSelect={\s*(async )?\s*(\w+) =>`у *.tsx + всередині handler`setLines(ls => ls.map((x, idx) => idx === i ?`→ перевірити чи після`await`є identity-check на entity-id (не лише index). Кандидати: будь-який line-array з SearchCombobox/Select+async-load-sub-resource
**Підхід до фіксу:**`onSelect={async g => { const selectedGoodId = g.id; setLines(ls => ls.map((x, idx) => idx === i ? {...x, goodId: g.id, subResource: emptyDefault} : x)); try { const subResource = await apiFetch(...); setLines(ls => ls.map((x, idx) => { if (idx !== i || x.goodId !== selectedGoodId) return x; return {...x, subResource}; })); } catch(err) { /_ toast _/ } }}`. Empty default — щоб старі sub-resource зникли одразу (UX) + race-guard — щоб stale response не перезаписав свіжий стан
**Критичність:** IMPORTANT — silent UI inconsistency: користувач бачить товар X, але UoM-список товару Y → невірний коефіцієнт → перерахунок quantity дає неправильне число → отриманий товар має невірну кіль. Не runtime error, але potential data corruption
**Де шукати ще:** PO/SD/Invoice line forms; будь-який bulk-form з row-array де onSelect-у-рядку довантажує під-ресурс (variants, batches, UoMs, price tiers); dynamic line-builder UI (work-orders parts, invoices items)

---

### 2026-05-31 — `(line as any).X` cast для нового optional поля — §1 TypeScript / §13 API Contract

**Сигнал:** свіжий feat-коміт додає optional поле у backend DTO (`@ApiPropertyOptional() unitShortName?: string`), сервіс мапить `toResponseDto()` коректно, але frontend interface (`POLine`/`DocLine` у hooks/api/_.ts або interface всередині page.tsx) НЕ оновлений. Розробник, не чіпаючи interface, використовує `(line as any).unitShortName` у JSX щоб обійти TS error. tsc зелений, але type contract розірваний — наступний consumer interface не бачить поля у IDE/auto-complete; refactor у IDE не знаходить usages.
**Причина виникнення:** скоупований feat-коміт додає поле у одному модулі (backend), а consumer-side (frontend interface) "не входить у scope коміту" → розробник вирішує "потім додам" і ставить `as any`. Через тиждень код мерджиться, "потім" не настає, наступний reviewer не помічає cast у середині JSX.
**Підхід до виявлення:** після кожного коміту що додає поле у backend ResponseDto — `grep -rn "@ApiPropertyOptional() <field>?" apps/api/src` → знайти interface що typing-ує endpoint на frontend → перевірити що поле є. Окремий grep на cast: `grep -rn "(line as any)\|(l as any)" apps/web/src/app --include="_.tsx"`→ BLOCK на review.
**Підхід до фіксу:** додати поле у frontend interface (single source of truth —`hooks/api/use<Module>.ts`або centralized type у`@sto/shared`); прибрати всі `as any`casts. Якщо поле використовується у багатьох сторінках — створити shared interface у`@sto/shared/src/types.ts`.
**Критичність:** IMPORTANT — TS type contract розірваний; IDE refactor + auto-complete не працюють; майбутні consumer-сторінки не знають про поле; легко регресує при перейменуванні поля у бекенді (cast мовчить)
**Де шукати ще:** будь-який feat-коміт що додає поле у `\*.dto.ts` ResponseDto; особливо у sub-resource endpoints (sync, list/detail tabs); після backend-only changes що проходять до frontend без review

---

### 2026-05-31 — Inline lambda decorator повторений 10+ разів — §2.3 / §1 DRY

**Сигнал:** `@Transform(({ value }) => (value === '' ? undefined : value))` (або інший inline-функційний-декоратор) зустрічається 20+ разів через grep по `apps/api/src/modules/`; кожне використання — точна копія
**Причина виникнення:** розробник створює helper-декоратор inline на місці, далі копіює-вставляє у кожен DTO замість екстракту; швидко на 1-3 разах, скейлиться лінійно з кількістю optional UUID полів
**Підхід до виявлення:** `grep -rn "@Transform\b" apps/api/src/modules/ --include="*.dto.ts" | wc -l` → якщо > 10 → перевірити чи лямбда однакова → `grep -c "value === '' ? undefined : value"` має бути значно меншим за кількість Transform
**Підхід до фіксу:** створити `apps/api/src/common/transforms/<name>.ts` з named export → замінити inline → `@Transform(emptyToUndefined)`; синхронно прибрати dead `Transform` imports у DTO які цю утиліту не використовують, і об'єднати duplicate `class-transformer` import statements (`import { Transform } from 'class-transformer'` + `import { Type } from 'class-transformer'` → один import)
**Критичність:** IMPORTANT — не баг, але hot-reload time + readability + reviewer fatigue; ще гірше — кожна нова DTO копіює застарілу версію helper-а коли пізніше треба «починаючий нуль теж в undefined»
**Де шукати ще:** будь-який `class-transformer` декоратор з inline lambda, `class-validator` custom messages зі складною логікою, `pipe()` operators у RxJS

---

### 2026-05-31 — Видалили manual `*` припустивши що компонент додає його, а компонент кастомний — §8 Web Frontend

**Сигнал:** коміт виду `fix(ui): прибрати ручні зірочки з label — Input/Select вже додають * через required prop` чіпає не лише `Input`/`Select` з `components/ui/`, а і **inline компонент Field/Select** у конкретній сторінці; manual `*` видалений з усіх label, але inline компонент не має render-блоку `{required && <span>*</span>}`
**Причина виникнення:** rapid clean-up — розробник робить bulk replace `"X *"` → `"X"` по всіх використаннях; кастомні (per-page) wrappers `function Field({ label, ... })` мають той самий тип props як справжні UI компоненти, але render просто `<label>{label}</label>` без required-індикатора → користувач втрачає required-знак тихо, без TS/runtime помилки
**Підхід до виявлення:** після будь-якого коміту "видалити manual `*`" — `grep -rn "function Field\|function Select\|function Input\|const Field\|const Select" apps/web/src/app --include="*.tsx"` → знайти всі inline-Field компоненти → звірити що рендер має `{required && <span ... >*</span>}` і `required?: boolean` у props
**Підхід до фіксу:** додати `required?: boolean` у props inline-Field, render `{required && <span className="ml-0.5 text-destructive">*</span>}`, передати `required` на нативний `<input>` + `aria-required={required || undefined}`; пройтись по callsite і виставити `required` на реально-обов'язкових полях
**Критичність:** IMPORTANT — UX regression: користувач не бачить required-маркера, форма дозволяє відправляти порожні значення → 400 з API без UI-підказки чому
**Де шукати ще:** wizard сторінки (`/setup`), модалки з власним form-layout (CalendarSlotModal, AssignSlotModal), будь-яка сторінка з inline `function Field` яка дублює UI компонент

---

### 2026-05-31 — group-hover:\* без `group` класу на батьку → dead CSS — §1 Tailwind 4 / §8

**Сигнал:** `<div className="... group-hover:opacity-100 ...">` всередині батька який НЕ має `className` що включає `group`; hover-зміна (zoom-hint, action buttons, overlay) ніколи не з'являється
**Причина виникнення:** Tailwind 4 `group-*` модифікатор активний лише коли батько має `group` клас; розробник додає `group-hover:` на дитину, забуваючи додати `group` на батьку, або через рефактор втрачає `group` коли витягує overlay у окремий компонент
**Підхід до виявлення:** `grep -rn "group-(hover|focus|active|disabled)" apps/web/src/ --include="*.tsx"` → для кожного — піднятися по JSX-дереву і знайти найближчий парент, який МАЄ ставити `group` клас; якщо нема — bug
**Підхід до фіксу:** додати `group` клас на найближчий hover-target батько (зазвичай той самий що має `onClick`/`cursor-*`)
**Критичність:** SUGGESTION/IMPORTANT — degradation без помилки: UI-підказка прихована, UX незрозумілий
**Де шукати ще:** card-overlay patterns (delete-on-hover, edit-on-hover), badge на preview-картинці, action-toolbar поверх рядка таблиці

---

### 2026-05-31 — Controller з `@UseGuards(JwtAuthGuard, RolesGuard)` без `@Roles` на методах → RolesGuard no-op — §2.1 Auth & Guards

**Сигнал:** `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)` (class- або method-level), але метод НЕ має `@Roles(...)` декоратора. `RolesGuard.canActivate` повертає `true` коли `required.length === 0` → guard стає no-op, пропускає **всіх** авторизованих користувачів незалежно від ролі (включно з MECHANIC до cost-чутливих endpoint-ів). TS зелений, ApiBearerAuth є — security gap невидимий статично без перевірки кожного методу.
**Причина виникнення:** розробник додає `RolesGuard` на клас з ідеєю "потім додам @Roles на кожен метод"; для read-only endpoint вирішує "пускаємо всіх логнутих, payload безпечний"; забуває що (1) майбутній рефактор може додати чутливе поле; (2) defence-in-depth invariant порушений; (3) review-чекліст ловить тільки `@UseGuards` відсутність, а не `@Roles` відсутність окремо.
**Підхід до виявлення:** для кожного method-level `@Get|@Post|@Patch|@Delete` у `*.controller.ts` що використовує `RolesGuard` — звірити що поряд є `@Roles(...)`. Один-рядковий grep: `grep -B5 "@Get\|@Post\|@Patch\|@Delete" *.controller.ts | grep -v "@Roles\|@Public"` → знайти методи без @Roles. Особливо ризиково для search/lookup/reference-data endpoints що "виглядають read-only".
**Підхід до фіксу:** explicit `@Roles('OWNER','ADMIN',...)` з повним переліком ролей; якщо endpoint реально публічний — `@Public()`. Для search-подібних з різними payload-комбінаціями: rolse list = unión всіх що мають мати доступ; не "пропустимо всіх" silent.
**Критичність:** IMPORTANT — degradation без immediate breach; payload може бути зараз безпечним, але інвариант "RolesGuard виконує перевірку" порушений → майбутній field-add без update @Roles = silent privilege escalation.
**Де шукати ще:** будь-який lookup/search/reference endpoint (`/zones`, `/units`, `/lifts`, `/branches`, `/works`); після рефакторингу контролера що додає `RolesGuard` на клас але переніс method bodies без `@Roles`; під час phase-driven module додавання коли `@Roles` "залишається на наступний крок".

---

### 2026-05-31 — Modal/Lightbox без Escape + role=dialog + aria-modal — §8 Web Frontend (a11y)

**Сигнал:** новий компонент `<div className="fixed inset-0 z-50 ...">` (lightbox/overlay/full-screen modal) без `role="dialog"`, без `aria-modal="true"`, без `aria-label`, без `useEffect` що ловить `Escape` keydown; close-button без `aria-label` та `type="button"`
**Причина виникнення:** розробник пише lightbox вручну (не через `<Modal>` з `components/ui/`) бо хоче специфічний layout (масштабовану картинку, відео-плеєр); забуває a11y-каркас бо тести проходять (`onClick={() => close()}` на overlay + close-button з іконкою)
**Підхід до виявлення:** `grep -rnE "className=['\"]fixed inset-0.*z-50" apps/web/src --include="*.tsx"` → для кожного — звірити (1) `role="dialog"`, (2) `aria-modal="true"`, (3) `aria-label`, (4) Escape-handler у `useEffect` з cleanup, (5) close-button з `aria-label` + `type="button"`
**Підхід до фіксу:**

```tsx
{
  open && (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="..."
      onClick={close}
      className="fixed inset-0 z-50 ..."
    >
      <div onClick={e => e.stopPropagation()}>... </div>
      <button type="button" aria-label="Закрити" onClick={close}>
        ×
      </button>
    </div>
  );
}
// + у компоненті:
useEffect(() => {
  if (!open) return;
  const h = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('keydown', h);
  return () => window.removeEventListener('keydown', h);
}, [open]);
```

**Критичність:** IMPORTANT — недоступно для клавіатурних користувачів; ARIA не озвучує "dialog opened"
**Де шукати ще:** lightbox для зображень/PDF/відео, full-screen forms, image-viewer, settings-preview overlays

---

### 2026-06-02 — Per-param `@Query('x')` без DTO → cap-less pagination + missing validation — §2.3 / §4 Architecture

**Сигнал:** контролер декларує список endpoint через окремі `@Query('q') q?: string, @Query('page') page = '1', @Query('limit') limit = '50'` (string defaults!) і всередині handler робить `Number(page)`, `Number(limit)`, `showDeleted === 'true'`. Сусідні модулі (works/goods) використовують `*QueryDto` з `@Type(() => Number) @IsNumber() @Max(200) @IsPositive()` + `@Transform(({ value }) => value === 'true' || value === true) @IsBoolean()`. Без DTO ValidationPipe не бачить ці параметри → клієнт може слати `?limit=999999999` → service передає до Prisma `take: 999999999` → OOM/timeout (DoS вектор) + reviewer губить контекст бо validation чекіст шукає `*QueryDto`/`@Max` у DTO файлах, а не у controller.
**Причина виникнення:** швидке прототипування — розробник копіює "найкоротший" патерн (`@Query('q')`) бо думає "це тільки список, пагінація проста"; забуває що (1) ValidationPipe не валідує per-param `@Query` без DTO декораторів; (2) `Number('abc')` → NaN → Prisma помилка; (3) кожен сусідній модуль уже має DTO, інакше — неконсистентність.
**Підхід до виявлення:** `grep -rn "@Query('[a-z]" apps/api/src/modules --include="*.controller.ts"` → для кожного match: якщо handler приймає 3+ `@Query` параметрів окремо → BUG, треба DTO. Окремо: `grep -rn "Number(.*@Query\|Number(page)\|Number(limit)" apps/api/src` → пряма ознака coercion-у-handler-і.
**Підхід до фіксу:** створити `*QueryDto` що дзеркалить works/goods (`@Type(() => Number) @IsNumber() @Min(1) page = 1`, `@IsPositive() @Max(200) limit = 50`, `@Transform(({ value }) => value === 'true' || value === true) @IsBoolean() showDeleted?: boolean`) → замінити handler signature на `@Query() query: <Name>QueryDto`. Якщо запит передається у service як positional args — або зберегти signature (передавати `query.page, query.limit, ...`), або переписати service на `query: QueryDto` (краще, але scope-creep).
**Критичність:** IMPORTANT — DoS вектор + inconsistency з сусідніми модулями (review fatigue, copy-paste новими розробниками)
**Де шукати ще:** будь-який list endpoint у новому module що "виглядає простим"; особливо after-feat-rush ситуації коли DTO ще не створене; catalog/reference-data endpoints; legacy endpoints до запровадження ValidationPipe

---

### 2026-06-03 — Animation wrapper `if (!open) return null` ламає exit-анімацію Modal — §8 Web Frontend / §3.1

**Сигнал:** свіжий компонент-обгортка (`ConfirmDialog`, `DirtyConfirmDialog`, custom dialog) рендерить `<Modal open={open} ...>` — але має власний guard `if (!open) return null` ПЕРЕД return. Коли `open` стає false, wrapper миттєво повертає null → Modal/`useAnimatedPresence` НЕ отримують `open=false` → exit-анімація НЕ запускається (зникнення без переходу).
**Причина виникнення:** legacy-патерн "оптимізації" `if (!open) return null` (запобігає рендеру важкого дерева коли модалка закрита) — коли Modal сам не мав exit-анімації, це було OK; після додавання `useAnimatedPresence` у Modal, обгортки що тримають той самий guard ламають архітектуру (Modal сам тримає DOM на час exit-анімації через `visible`-state).
**Підхід до виявлення:** `grep -rn "if (!open) return null" apps/web/src/components/ui --include="*.tsx"` → для кожного файлу перевірити чи рендер містить `<Modal>`/`<PickerModal>`/`<SearchPickerModal>` — якщо ТАК → BUG, прибрати guard. Виняток — кастомний overlay БЕЗ обгортки `<Modal>` (custom backdrop), там guard потрібен (або замінити на `useAnimatedPresence`).
**Підхід до фіксу:** прибрати `if (!open) return null` з wrapper; Modal сам обробляє visibility через useAnimatedPresence. Якщо є body що дорого рендерити — `{open && <HeavyContent/>}` всередині Modal children (умовний рендер змісту, не самого Modal).
**Критичність:** CRITICAL — повна втрата exit-анімації для критичного UX-компонента (підтвердження дії, видалення, скасування); також ламає `useAnimatedPresence` invariant (state="closed" → 180ms → unmount), бо wrapper unmount-ить дочірній компонент раніше за animation
**Де шукати ще:** будь-який *Dialog/*Modal wrapper у `components/ui/` що використовує базовий `<Modal>`; після введення exit-анімації у будь-якому presentational компоненті — пройтися по всіх consumers і прибрати дублікатний guard

---

### 2026-06-03 — Глобальний `[data-state="open"]` CSS селектор б'є по чужих data-state атрибутах — §1 TypeScript/Tailwind / §8

**Сигнал:** глобальне CSS правило `[data-state="open"] { animation: ... }` (без додаткового класу/атрибута-маркера) у `globals.css`. Radix UI primitives (Accordion, Dialog, Dropdown, Popover, Switch, Tabs, Tooltip), HeadlessUI, Reach UI використовують `data-state="open|closed|on|off|checked|unchecked"` як публічний контракт — будь-який майбутній компонент з цих бібліотек автоматично отримає неочікувану анімацію (modal-in/out на dropdown trigger, ескалація animation budget).
**Причина виникнення:** розробник хоче "одне правило для всіх модалок" — пише глобальний селектор за data-state; не знає що це публічний контракт сторонніх бібліотек; перевіряє лише поточні compoненти (де data-state ставить тільки Modal), не майбутні.
**Підхід до виявлення:** для кожного нового глобального CSS правила що матчить `data-*` атрибут — звірити з відомими бібліотечними контрактами (Radix `data-state`, HeadlessUI `data-headlessui-state`, ARIA `aria-expanded`); якщо співпадає → звузити селектор додатковим маркером (наприклад `[data-animate]`); особливо якщо правило використовує `animation:` shorthand (агресивніший за `transition:`).
**Підхід до фіксу:** ввести скоп-маркер: `[data-animate][data-state="open"]` — анімація вмикається лише на елементах де ми явно поставили `data-animate`. Direct-child `>` для backdrop замість descendant — щоб outer-modal не "затягував" inner-backdrop вкладеної модалки.
**Критичність:** IMPORTANT — degradation без immediate breakage (поки немає Radix у codebase); ризик catastrophic regression при додаванні будь-якої headless UI бібліотеки; defence-in-depth invariant порушений.
**Де шукати ще:** будь-який глобальний селектор на `data-*`/`aria-*` атрибут; після кожного PR що додає кастомні animation rules у `globals.css` — перевіряти scope; особливо якщо бібліотеки-кандидати з'являються у roadmap (Radix Tooltip, Sonner toast, Vaul drawer).

---

### 2026-06-02 — restore() з окремим read для відповіді + non-null assertion — §5.2 Soft-delete / §2.2 Tenant Isolation

**Сигнал:** `restore(orgId, id)` робить ТРИ окремі DB-виклики: (1) `findFirst({ NOT: deletedAt: null })` для existence check → (2) `findFirst({ id, orgId, include })` БЕЗ deletedAt-фільтра щоб дістати ще-soft-deleted рядок для відповіді → (3) `update({ where: { id, orgId } }, data: { deletedAt: null })`. У кінці — `return this.toDto({ ...item!, deletedAt: null })` з non-null assertion. Між (1) і (2)/(3) існує race-window де паралельна сесія може hard-delete-нути запис → `item` буде `null` → `item!` спрацює як `{ deletedAt: null }`-only об'єкт → toDto впаде на доступі до `item.name`/`item.serviceWorks` із `TypeError: Cannot read properties of undefined`. Або update може потрапити у вже-resurrected рядок (no-op) → returns старий cached state.
**Причина виникнення:** розробник хоче (а) перевірити "must be deleted" (то NOT: deletedAt: null filter), (б) повернути повний DTO з relations (то include), (в) виконати оновлення. Не помічає що Prisma `update().include` цілком покриває (а)+(б)+(в), або що `updateMany({ where: { NOT: deletedAt: null } }).count` дає той самий existence-check атомарно з оновленням. Use of `item!` ховає nullable від компілятора замість виправити race.
**Підхід до виявлення:** для кожного нового `restore()` методу — порахувати кількість `await this.prisma.*` викликів: якщо ≥3 для одного aggregate → bug; шукати `item!.` або `existing!.` non-null assertions як червоний прапор; `grep -rn "restore\(.*orgId" apps/api/src/modules --include="*.service.ts"` → для кожного match counter callсити кількість findFirst + update.
**Підхід до фіксу:** один atomic `updateMany({ where: { id, orgId, NOT: { deletedAt: null } }, data: { deletedAt: null } })` → перевірити `result.count === 0` → 404; ОДИН наступний `findFirstOrThrow({ where: { id, orgId }, include })` для повного DTO. Загальна формула: existence + tenant + must-be-deleted у one updateMany, повна форма — окремий read з includes. Усуває race, прибирає `!` assertion, зменшує RTT з 3 до 2.
**Критичність:** CRITICAL — silent crash на concurrent hard-delete; data corruption на concurrent resurrect від іншої сесії
**Де шукати ще:** будь-який новий soft-delete restore endpoint у каталозі/довідниках (Brand, Good, Work, Service, Unit, Customer, Supplier, Warehouse); особливо після bulk-додавання restore endpoints одним commit-ом — копіпаст ризик

---

## Карта секцій (quick reference)

| #   | Секція         | Стосується                                                     |
| --- | -------------- | -------------------------------------------------------------- |
| 1   | TypeScript     | api/, web/, packages/ — завжди                                 |
| 2   | Security       | Guards, tenant, injection, secrets, BullMQ, JWT, Sentry        |
| 3   | Memory Leaks   | web/ hooks; api/ DB connections                                |
| 4   | Architecture   | DI, events, error handling, list wrappers                      |
| 5   | Business Rules | FSM, inventory, settlements, soft delete, $transaction timeout |
| 6   | Database       | N+1, take, indexes, select vs include, resurrection            |
| 7   | Performance    | Parallel queries; SSR/hydration                                |
| 8   | Web Frontend   | API calls, UI states, SSR, auth, UX features, modularity       |
| 9   | Sync Readiness | PULL_TABLES, PUSH_SAFE, BLACKLIST                              |
| 10  | Offline-First  | BullMQ, зовнішні API                                           |
| 11  | Configuration  | Magic numbers, hardcoded templates                             |
| 13  | API Contract   | DTO ↔ interface, BigInt, dynamic model, polymorphic entityType |
