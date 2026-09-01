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

**Визнач агрегати зі scope → читай відповідні дос'є паралельно:**

| Ключові слова у змінених файлах            | Читати                           |
| ------------------------------------------ | -------------------------------- |
| `work-order`, `WorkOrder`, `work-orders.`  | `docs/objects/work-order.md`     |
| `invoice`, `Invoice`                       | `docs/objects/invoice.md`        |
| `purchase-order`, `PurchaseOrder`          | `docs/objects/purchase-order.md` |
| `stock-document`, `StockDocument`          | `docs/objects/stock-document.md` |
| `counterpart`, `Counterparty`              | `docs/objects/counterparty.md`   |
| `good`, `Good`, `catalog`                  | `docs/objects/good.md`           |
| `work-categor`, `Work`, `works.`           | `docs/objects/work.md`           |
| `calendar`, `CalendarSlot`                 | `docs/objects/calendar.md`       |
| `stock-item`, `StockMovement`, `inventory` | `docs/objects/inventory.md`      |
| `settlement`, `transaction`, `payment`     | `docs/objects/settlements.md`    |

Якщо scope торкається сервісних файлів (`*.service.ts`) → також читай `docs/BUSINESS-RULES.md`.
Якщо scope — нова сторінка або компонент → також читай `docs/GOTCHAS.md`.

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
- [ ] Restore-endpoint (`POST :id/restore`) → ролі ІДЕНТИЧНІ delete-endpoint. Асиметрія (restore дозволений ширшій ролі ніж delete) = роль може «undo» видалення яке сама не мала права зробити

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

# @Process без concurrency (IMPORTANT: без concurrency Bull default = 1, але для I/O процесорів
# з мережевими викликами це означає серіалізацію: 100 jobs × 15s = 1500s стіни)
grep -rn "@Process(" apps/api/src/ --include="*.processor.ts" | grep -v "concurrency\|spec"
```

- [ ] Кожен `.add()` → `attempts ≥ 10`, `backoff: { type: 'exponential' }`
- [ ] ПРРО: `attempts: 288`, `backoff: { delay: 300_000 }` (24 год)
- [ ] SMS: `attempts: 10`, `backoff: { delay: 60_000 }`
- [ ] Процесори → `try/catch` + `throw err` (щоб BullMQ retry спрацював)
- [ ] Ніяких прямих HTTP до зовнішніх API поза чергою
- [ ] **`@Process(name)` → `@Process({ name, concurrency: N })`**: HTTP I/O → `3-5`, DB write → `3`, batch fan-out → `1`

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

# Статичні константи у render body (нова RegExp/Set/Map кожен рендер)
grep -rnE "^\s+const [A-Z_]+\s*=\s*(\/|new (Set|Map|RegExp))" apps/web/src/app --include="*.tsx"

# memo з inline array/object prop (memo марний)
grep -rnE "<[A-Z][A-Za-z]+[^>]*=\{[a-zA-Z.]+\.(filter|map|slice)\(" apps/web/src/app --include="*.tsx"

# closest()/matches() на data-атрибут якого бібліотека НЕ ставить (dnd-kit attributes = role/aria-*)
grep -rnE "closest\(['\"]?\[data-(dnd-draggable|dnd|rdnd)" apps/web/src/ --include="*.tsx"

# pointer interaction state (drawing/resizing) — leave-handler має скидати ВСІ режими
grep -rn "onPointerLeave\|PointerLeave" apps/web/src/app --include="*.tsx"

# requestAnimationFrame без id-capture (cancelAnimationFrame неможливий)
grep -rnE "^\s*requestAnimationFrame\(" apps/web/src/app apps/web/src/components --include="*.tsx"

# imperative style.* мутації у callback (rAF/RO/setTimeout) — перевірити unmount cleanup
grep -rnE "\.style\.(height|transition|marginBottom|opacity|transform)\s*=" apps/web/src/app --include="*.tsx"

# Anchored popup useLayoutEffect deps `[anchorRef]` — стейл позиція при re-open
grep -rnE "useLayoutEffect\(.*\}, \[anchorRef\]\)" apps/web/src/components/ui --include="*.tsx"

# Nested overlay Esc handler у bubble-фазі — закриває батьківський Modal
grep -rnE "document\.addEventListener\(['\"]keydown" apps/web/src/components/ui --include="*.tsx" --include="*.ts"

# Spread SyntheticEvent з заміною target — ламає прототип
grep -rnE "\{\s*\.\.\.e\s*,\s*target:\s*\{\s*\.\.\.e\.target" apps/web/src/ --include="*.tsx" --include="*.ts"

# Skip-first-run ref (`*LoadedRef` / `mountedRef` / `initedRef`) поруч з toggle-useEffect —
# перевірити чи ref СКИДАЄТЬСЯ у батьківському (parent-key) useEffect. Інакше при зміні
# parent-id (counterparty/tab/entity) main useEffect І toggle useEffect обидва фаєрять
# fetch → дубль-запит + гонка (реф `true` з попередньої сесії парента).
grep -rnE "(Loaded|Mounted|Inited|SkipFirst)Ref\s*=\s*useRef\(false\)" apps/web/src/ --include="*.tsx"
```

- [ ] `addEventListener` → `return () => removeEventListener`
- [ ] `setInterval` / `setTimeout` → `return () => clearInterval / clearTimeout`
- [ ] `debounceRef.current` → `clearTimeout` у cleanup (HTTP запит стартує навіть якщо mounted=false)
- [ ] `useEffect` з `apiFetch` → `let cancelled=false; ... if (!cancelled) setState(...); return () => { cancelled=true }`
- [ ] Stateless константи (RegExp, Set, Map) → module-level, не у render body
- [ ] `memo(Component)` → пропсами — стабільні референції (через `useMemo` Map, не inline `.filter()`)
- [ ] Inline `ref={el => el.indeterminate = x}` → `useRef` + `useEffect([dep])` (крихко при React Compiler)
- [ ] `target.closest('[data-X]')` → атрибут реально рендериться у DOM (dnd-kit НЕ ставить `data-dnd-draggable`); додати власний `data-Y` маркер
- [ ] `onPointerLeave` → скидає **ВСІ** pointer-режими (drawing **і** resizing)
- [ ] `requestAnimationFrame` що мутує DOM/state → id у `useRef<number|null>(null)`; `cancelAnimationFrame` на toggle + у unmount `useEffect(() => () => {...}, [])`
- [ ] Pair `setTimeout` + `rAF` для анімації → обидва id у refs; cleanup у dedicated unmount-effect
- [ ] `<Input>` wrapper з mask → НЕ `{ ...e, target: {...e.target, value: X} }` (ламає SyntheticEvent прототип); мутувати `e.target.value` напряму
- [ ] Skip-first-run ref (`*LoadedRef`) у toggle-useEffect → батьківський (parent-key) useEffect ЯКИЙ ФАЄРИТЬ ПРИ ЗМІНІ CP/entity-id повинен скидати `ref.current = false` (інакше дубль-fetch при switch — main + toggle обидва фаєрять на новий id); ref-декларація перед useEffect що її використовує (уникнення TDZ якщо refactor пересуне блоки)

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
- [ ] FSM auto-transition у tx → re-read entity всередині tx + перевірка `status === expected`

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
- [ ] **Bulk-apply:** `for (const line of lines)` → calc prefetched перед loop; updates batched у `$transaction(async tx, { timeout: N })` — НЕ per-iteration `$transaction([...])` (array-form default 5s timeout)

#### §7.2 Frontend

```bash
# new Date() у render path (hydration mismatch)
grep -rn "new Date()\|Date\.now()" apps/web/src/app/ --include="*.tsx" \
  | grep -v "useEffect\|getTime\|setDate\|//\|spec"

# key={i} у re-sortable lists
grep -rn "key={i}\|key={index}" apps/web/src/app/ --include="*.tsx" | head -10

# Per-item fan-out: Promise.all(days/ids.map(apiFetch)) без cap і без AbortController
grep -rnE "Promise\.all\(\s*[a-zA-Z]+\.map\(" apps/web/src/app/ --include="*.tsx" -A2 | grep -i "apiFetch" | head -10
```

- [ ] `new Date()` у render → `useState('')` + `useEffect(() => setX(new Date()), [])`
- [ ] `key={i}` у списках з filter/sort → `key={item.id}` або stable derived key
- [ ] Важкі обчислення у render → `useMemo`
- [ ] `createPortal` → `mounted` guard
- [ ] `Promise.all(arr.map(apiFetch))` fan-out → cap(`MAX_N`) + `AbortController`-ref: `.abort()` попередню партію; `if (signal.aborted) return` перед setState

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
- [ ] Fetch у обробнику події → token-ref (`++ref.current`; `if (ref.current !== reqId) return`) + скинути похідний стан
- [ ] **Cross-field guard на беку → знайти ВСІ frontend-entry-points**: коли додано backend-cross-field валідацію (напр. `hasCounterpartyName`), grep `POST /<endpoint>` по apps/web/src → **кожен** callsite має власний frontend guard з ідентичною логікою (**trim + OR + одне повідомлення**). Sample bug: guard у CounterpartyEditModal, але CalendarSlotModal-wizard (2й callsite) мав власний `!x && !y` без trim → whitespace-only обходило frontend, backend повертав 400 із загальним message без inline. Grep: `grep -rn "'/counterparties'" apps/web/src` — перевір ВСІ файли, не тільки основний edit-modal
- [ ] **Enum-axis розширення → знайти ВСІ inline списки TX_TYPES (sibling-drift)**: коли розширюється enum-value що впливає на знак/колір/семантику (`SettlementTransactionType` += SUPPLIER_CHARGE/PAYMENT/REFUND), оновлення однієї TX_LABELS/COLORS/BALANCE_UP-мапи НЕ достатньо. У frontend можуть існувати ІНШІ inline-копії старої осі — grep за назвами старих values (`['PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE']`, `type === 'CHARGE'`, `.includes(t.type)`, `TX_COLORS`, `TX_LABELS`) по всьому apps/web/src → кожна знайдена копія має бути оновлена ідентично (з module-level Set + коментар-посилання на бекове BALANCE_SIGN як source of truth). Sample bug: коміт 23ce9109 оновив SettlementsTabContent.tsx (нові типи в BALANCE_UP_TYPES), але sibling `apps/web/src/app/(app)/counterparties/[id]/PageClient.tsx:1331,1336` мав власну inline-копію `['PAYMENT','PREPAYMENT','REFUND','CREDIT_NOTE'].includes(t.type)` без SUPPLIER_CHARGE → отримання товару малювалось як «+ red» (наче нам винні). Fix: 2 module-level Set + коментар-посилання. Правило: після 3-го consumer → shared helper у `lib/utils.ts`. Grep рецепти для enum axes: `grep -rnE "\.includes\(t\.type\)" apps/web/src`, `grep -rn "TX_LABELS\|TX_COLORS" apps/web/src`

#### §8.2.1 Select race

```bash
grep -rnE "setForm.*[a-zA-Z]+Id:\s*['\"]['\"]|useState\(\{[^}]*[a-zA-Z]+Id:\s*['\"]['\"]" \
  apps/web/src/app/ --include="*.tsx" | grep -v "SearchCombobox"
```

- [ ] `<Select value={form.xxxId}>` де options асинхронні → `useEffect` синхронізація: `if (!form.xxxId && options[0]) setForm(f => ({...f, xxxId: options[0].id}))`

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
- [ ] Hover-only кнопки → `group-hover:opacity-100` **+ `focus-visible:opacity-100`** (виняток: `pointer-events-none` декоративні)

#### §8.6 Модульність UI

```bash
# Inline IIFE у JSX
grep -rnE "\{\(\(\) =>" apps/web/src/app/ --include="*.tsx"

# Нова <col> додана у <colgroup> але tfoot colSpan не оновлений
# (порівняти кількість <col> у <colgroup> з усіма colSpan-ами + сусідніми cells у tfoot/empty-state row)
# Сигнал: feat-diff показує `+ <col className="w-N">` у тому ж файлі що має <tfoot> з captured colSpan
git diff HEAD~5 --unified=0 apps/web/src/components --include="*.tsx" 2>/dev/null | grep -E "^\+\s+<col\b"

# Дубльована date badge математика
grep -rn "86_400_000\|diffDays" apps/web/src/app/ --include="*.tsx" | grep -v "lib/utils\|expiry-badge"

# Власний picker не через picker-modal.tsx
grep -rn "<Modal" apps/web/src/app/ --include="*.tsx" -l

# Partial helper-migration: файл-консумент useListPage використовує і setPage(1) і resetPage() одночасно
# (зазвичай applyFilter мігровано на resetPage, а inline JSX handlers досі викликають setPage(1))
for f in $(grep -rl "useListPage<" apps/web/src/app --include="*.tsx"); do
  has_set=$(grep -c "setPage(1)" "$f")
  has_reset=$(grep -c "resetPage()" "$f")
  [ "$has_set" -gt 0 ] && [ "$has_reset" -gt 0 ] && echo "MIXED: $f (setPage(1)=$has_set, resetPage()=$has_reset)"
done
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
### YYYY-MM-DD — [Назва] — §N

**Сигнал:** ...
**Grep:** ...
**Фікс:** ...
**Severity:** CRITICAL / IMPORTANT / SUGGESTION
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

### 2026-06-19 — relation-include drift: findOne vs create/update — §13 API Contract

**Сигнал:** новий scalar/relation з'являється у `findOne()` include + `toDto()` мапінг, але `create()`/`update()`/`addPart()`/`updatePart()` include шейп старий → поле = null у POST/PATCH response. Frontend який rendering з create/update payload одразу (без подальшого findOne) показує `null`. Зустрілось у purchase-orders.service (lines.good без `internalCode`/`brand`) і work-orders.service (parts.good без `internalCode`/`sku`/`brand`) у тому ж комі.
**Grep:**

```bash
# Знайди всі include що тягнуть `good:` у service-файлах і звір кожен з findOne shape
grep -nE "good:\s*\{\s*select:" apps/api/src/modules/{purchase-orders,work-orders,invoices,stock-documents,completion-acts}/*.service.ts
# Або шукай у тому ж файлі різні shape-и одного relation
grep -nE "(good|supplier|vehicle|counterparty|warehouse):\s*\{\s*select:" apps/api/src/modules/X/X.service.ts | sort -t: -k3
```

**Фікс:** один shared `const GOOD_INCLUDE_SELECT = { name, internalCode, sku, unit, unitOfMeasure: {...}, brand: {...} } satisfies Prisma.GoodSelect` у service file + reuse у findOne/create/update/addPart/updatePart. Це гарантує що drift не повторюється.
**Severity:** IMPORTANT — degradation без TS-помилки (toDto signature маркує optional `?`); фронт показує null після POST/PATCH, користувач думає що дані не збереглись поки не зробить refresh.

---

### 2026-06-19 — frontend мапер читає неіснуюче поле з DTO — §13 API Contract

**Сигнал:** frontend type assertion для API response вигадує relation (`brand: { name: string }`) і мапер читає його (`g.brand?.name ?? null`), а реальний backend DTO повертає flat scalar (`brandName: string`). Спред `...g` спочатку записує правильний `brandName` з DTO, потім bogus мапер перетирає на `null`. Помилка німа — TS не може перевірити assertion проти runtime DTO. Знайдено у GoodPickerModal (brandName завжди null).
**Grep:**

```bash
# Знайди frontend ApiResponse-каст з відомими relation іменами які backend насправді flatten-нув
grep -rnE "apiFetch<\{[^}]*brand:\s*\{|apiFetch<\{[^}]*supplier:\s*\{|apiFetch<\{[^}]*good:\s*\{" apps/web/src --include="*.tsx" --include="*.ts"
# Для кожного — звірити з backend toDto() / toResponseDto() shape у відповідному service.ts
```

**Фікс:** прибрати фейковий relation з типу-каста; покладатись на spread `...g` що приносить вже маповані flat поля з DTO; залишити лише поля які потребують перетворення (наприклад unit → unitShortName).
**Severity:** IMPORTANT — degradation без TS/runtime помилки; UI показує null/empty стан для поля яке backend насправді віддає.

---

### 2026-05-28 — @@unique без deletedAt + create без resurrection — §6 Database

**Сигнал:** `@@unique([orgId, X])` де X не `deletedAt`; `create()` має `findFirst({ deletedAt: null })` але не resurrection
**Фікс:** merged `findFirst` (без deletedAt filter) → JS перевірка `deletedAt` → resurrect (`update`) або ConflictException
**Severity:** IMPORTANT — HTTP 500 замість 409

---

### 2026-05-28 — memo() з fresh array/object prop — §3 Memory / §7 Performance

**Сигнал:** `memo(Component)` де батько передає `.filter()` / `.map()` / `{}` inline як проп — нова референція кожен рендер → memo ніколи не спрацьовує
**Фікс:** `useMemo` Map у батьку для групування; stable empty constant замість `[]` default
**Severity:** SUGGESTION — не баг, але виправлений memo дає 50-200ms на drag/filter

---

### 2026-05-28 — GET dedup + AbortSignal shared promise — §8 Web Frontend

**Сигнал:** in-flight GET dedup keyed on `path` без guard `!init?.signal`
**Фікс:** `if (method === 'GET' && !init?.signal) { ...dedup... }` — abortable GET не дедупити
**Severity:** IMPORTANT — silent abort для не-aborted callers

---

### 2026-05-28 — apiFetch message: string[] без Array.isArray у всіх helpers — §8.1

**Сигнал:** fix у `apiFetch` для `message: string[]` — але `apiBlobFetch` і `apiMultipartFetch` без того ж guard
**Фікс:** оновити всі три синхронно в одному коміті
**Severity:** IMPORTANT — `[object Object]` або тільки перший елемент при 400 з validation

---

### 2026-05-28 — BigInt syncVersion напряму у JSON response — §13 API Contract

**Сигнал:** `findMany` / `findFirst` повертається напряму без `toDto()` на моделях з `syncVersion BigInt`
**Grep:** `grep `return await this.prisma.X.findMany`без`map(toDto)` у service → перевірити що немає BigInt у`
**Фікс:** `rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }))` або `select` без syncVersion
**Severity:** CRITICAL — HTTP 500 при будь-якому запиті до endpoint

---

### 2026-05-28 — Prisma plural table → singular model — §13 API Contract

**Сигнал:** dynamic `(prisma as any)[modelName]` де modelName наївно перетворений із snake_case plural
**Grep:** `grep `toCamel\|snakeToCamel` → перевірити explicit TABLE_TO_MODEL map`
**Фікс:** explicit `Record<tableName, modelKey>` + `if (!model) throw` (fail-fast)
**Severity:** CRITICAL — TypeError на runtime; async `.catch()` не ловить синхронний property access

---

### 2026-05-28 — closest() guard на data-атрибут якого бібліотека не ставить — §3.1 / §8

**Сигнал:** `target.closest('[data-dnd-draggable]')` (або інший `data-*`) у pointer/click guard — а dnd-kit `useDraggable.attributes` ставить лише `role`/`aria-roledescription`/`aria-disabled`/`tabindex`, НЕ...
**Grep:** `grep `closest(['"]?\[data-(dnd|rdnd)` → звірити що атрибут реально присутній у JSX/DOM; будь-який gu`
**Фікс:** додати ВЛАСНИЙ стабільний маркер на корінь компонента (`data-calendar-slot`) і перевіряти його — він покриває всіх дітей (resize handles, label, delete) одним `closest()`
**Severity:** IMPORTANT — guard не працює, конкуруючі pointer-жести; degradation без TS/runtime помилки

---

### 2026-05-28 — leave/cancel handler скидає лише частину pointer-режимів — §3.1

**Сигнал:** `onPointerLeave` коментар "cancel drawing/resize" але тіло скидає лише `drawingRef`/`ghost`, не `resizing`/`resizePreview`
**Grep:** `grep `onPointerLeave` → перелічити всі pointer-режими у компоненті (drawingRef, resizing, dragging)`
**Фікс:** у leave/cancel скинути ВСІ режими: `if (drawing) {...}; if (resizing) { setResizing(null); setResizePreview(null); }`
**Severity:** IMPORTANT — застрягла UI-операція, фантомний preview

---

### 2026-05-28 — schema.prisma enum/поле змінено без міграції — §6 Database

**Сигнал:** diff містить зміну `schema.prisma` (нове enum-значення `+  PIT`, нове поле, нова модель) але у тому ж/сусідньому коміті НЕ додана папка у `packages/database/prisma/migrations/`
**Grep:** `grep `ALTER TYPE ... ADD VALUE``**Фікс:** створити папку`YYYYMMDDHHMMSS\_<desc>/migration.sql`після останнього timestamp; enum →`ALTER TYPE "Enum" ADD VALUE IF NOT EXISTS 'X';` (окремий файл — Postgres забороняє ADD VALUE + використання у...
**Severity:** CRITICAL — TS зелений, але runtime fail; найкаверзніше бо tsc мовчить

---

### 2026-05-28 — UTF-8 BOM у .ts після Windows/PowerShell-редагування — §1 TypeScript

**Сигнал:** перші 3 байти файлу = `ef bb bf`; git diff показує `+﻿import` (невидимий ﻿ перед import); тільки частина файлів того ж типу мають BOM (неконсистентно)
**Фікс:** `tail -c +4 "$f" > tmp && mv tmp "$f"` для кожного BOM-файлу; перевірити що tsc усе ще 0 errors
**Severity:** IMPORTANT — tsc толерує, але ламає деякі JSON/ESM парсери, забруднює git diff, неконсистентно з codebase

---

### 2026-05-29 — rgba(var(--X-rgb)) на CSS var якого немає → hardcoded fallback ігнорує тему — §1 TypeScript/Tailwind

**Сигнал:** inline `style={{ backgroundColor: \`rgba(var(--color-primary-rgb, 59,130,246), ${a})\` }}`—`--color-primary-rgb`НЕ існує у globals.css; є лише`--color-primary: hsl(...)`(цілісне hsl-значення, НЕ...
**Фікс:** `color-mix(in srgb, var(--color-X) ${round(a\*100)}%, transparent)`— тема-aware alpha на реальному токені (Tailwind 4 baseline підтримує color-mix). Inline`style` з цілим токеном...
**Severity:** IMPORTANT — degradation без помилки: фіксований колір, зламаний dark mode/rebrand

---

### 2026-05-29 — Promise.all(days.map(apiFetch)) fan-out без cap і без abort — §7.2 Frontend Performance

**Сигнал:** `await Promise.all(days.map(d => apiFetch(\`/x?date=${d}\`)))`— масив генерується з діапазону дат/масиву id; немає cap на довжину, немає AbortController при зміні параметра (місяць/діапазон)
**Фікс:** (1)`const ac = new AbortController(); ref.current?.abort(); ref.current = ac;`на старті loader; передати`{ signal: ac.signal }`у кожен apiFetch;`if (ac.signal.aborted) return` перед setState. (2) cap...
**Severity:** IMPORTANT — stale-data race + потенційне перевантаження (degradation без помилки)

---

### 2026-05-30 — close-animation rAF без id-capture + missing unmount cleanup — §3.1 Memory Leaks

**Сигнал:** `requestAnimationFrame(() => {...})` всередині close-branch toggle-ефекту мутує DOM (`outer.style.height='0px'`); id не зберігається; rapid toggle (close → open у тому ж frame) лишає pending rAF що...
**Grep:** `grep `requestAnimationFrame(` у компонентах → перевірити чи id зберігається у ref; для пари (setTime`
**Фікс:** (1) `const rafRef = useRef<number|null>(null); rafRef.current = requestAnimationFrame(() => { rafRef.current = null; ... })`; (2) на старті toggle-ефекту `if (rafRef.current !== null)...
**Severity:** IMPORTANT — visual glitch (height=0 на щойно-відкриту форму) + React warning "setState on unmounted component"; degradation без crash.

---

### 2026-05-30 — PATCH normalizeScope clear: всі exclusivity-сусіди мають однаковий null-out патерн — §5 Business Rules

**Сигнал:** мульти-полий exclusive scope (наприклад, goodId/brandId/goodCategory/goodType) у PATCH. Після `normalizeScope(merged)` 3 з 4 полів пишуться як `normalized.X ?? null` (правильно "знизити" якщо...
**Фікс:** уніфікувати — `<field>: normalized.<field> ?? null` для всіх exclusive-сусідів; `existing.X` fallback потрібен ЛИШЕ для non-exclusive полів (name, priority, isActive)
**Severity:** CRITICAL — silent data corruption, порушення інваріанту scope-exclusivity; будь-який наступний `applyRule` / `calculateSalePrice` отримує неоднозначний контекст

---

### 2026-05-30 — fire-and-forget PUT у hook без AbortController → out-of-order writes — §8.2 UI Стани

**Сигнал:** хук викликає `apiFetch('/x', { method: 'PUT', body }).catch(() => {})` без AbortController; локальний стан керується через `setState(prev => ...)` (правильно), але **серверний** стан...
**Grep:** `grep `apiFetch(.+, { method: 'PUT' }).catch` у хуках; будь-який callback-write що викликається у onC`
**Фікс:** `const abortRef = useRef<AbortController | null>(null); const save = useCallback((next) => { abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac; apiFetch(..., {...
**Severity:** IMPORTANT — server-state drift без crash; найгірше — між-сесійна неузгодженість що користувач помічає лише при логіні з іншого пристрою

---

### 2026-05-30 — `@Param('key')` без validation — нескінченний рядок у Prisma where — §2.3 Injection & Input Validation

**Сигнал:** `@Param('key') key: string` (або інший рядковий path param НЕ uuid) → потрапляє у `prisma.X.findFirst({ where: { ..., key } })`. ValidationPipe не валідує `@Param` (валідує лише `@Body`/`@Query`...
**Grep:** `grep `@Param('[^']+')` без ParseUUIDPipe → перевірити що або (а) value passes through DTO validation`
**Фікс:** функція-guard `ensureValidKey(key)` що кидає `BadRequestException` при `length > N` (узгоджена з MaxLength у DTO); викликається на початку handler перед service-call. Альтернатива: створити custom...
**Severity:** IMPORTANT — DoS vector + log/header pollution; не data breach, але порушує defence-in-depth

---

### 2026-05-30 — Soft-delete rule з child-таблицею + type-switch → "відродження" дочірніх записів — §5 Business Rules

**Сигнал:** parent-модель з типом-перемикачем (`type: 'COST_TIER' | 'PERCENT' | ...`) має один child-relation що активний лише для одного типу (`tiers` для `COST_TIER`). PATCH міняє `type` на інший, але...
**Grep:** `grep `prisma.<child>.deleteMany` у PATCH handler і перевірити що умова покриває type-switch case`
**Фікс:** `const switchedAway = normalized.type !== undefined && normalized.type !== '<TYPE_X>' && existing.type === '<TYPE_X>';` → запустити `tx.<child>.deleteMany` у тій же транзакції; розширити умову входу...
**Severity:** IMPORTANT — data drift, неочікувана поведінка при поверненні на тип; не immediate crash, але порушує модель "що бачу, тим і керую"

---

### 2026-05-30 — rAF у persistent effect (не toggle) без id-capture — §3.1 Memory Leaks

**Сигнал:** компонент монтується назавжди (`useEffect(() => { ... requestAnimationFrame(() => style.X = Y) }, [])` — порожні deps), rAF мутує DOM (`.style.transition`/`.style.height`), id НЕ зберігається у ref →...
**Grep:** `grep `requestAnimationFrame(`всередині`useEffect`→ перевірити (1) чи id зберігається у`useRef<nu`**Фікс:**`const rafRef = useRef<number|null>(null); ... rafRef.current = requestAnimationFrame(() => { rafRef.current = null; ... }); return () => { ro.disconnect(); if (rafRef.current !== null)...
**Severity:** IMPORTANT — інколи degradation без crash, інколи "ghost" DOM mutation; найбільш ризиково для AnimatedBody / Drawer / collapse-секцій що часто mount/unmount

---

### 2026-05-30 — Soft-delete update без orgId у where → race-window для cross-session reuse — §2.2 Tenant Isolation / §5 Business Rules

**Сигнал:** контролер робить `findFirst({ id, orgId })` для перевірки → потім `prisma.X.update({ where: { id } })` БЕЗ orgId у where. Якщо існує `deletedAt: null` guard у findFirst, але update використовує лише...
**Grep:** `grep `prisma\.X\.update\(\{\s*where:\s*\{\s\*id`без`orgId` → перевірити чи попередня findFirst-пере`
**Фікс:** замінити `update` → `updateMany({ where: { id, orgId, ...filters } })` + `findFirstOrThrow({ where: { id, orgId }, include: ... })` для повернення з relations (бо updateMany не приймає include). Для...
**Severity:** IMPORTANT — defense-in-depth gap (не immediate data breach, але порушує консистентність patterns у codebase і відкриває race-window для multi-session writes)

---

### 2026-05-30 — bulk-apply loop: per-iteration `await $transaction([...])` без timeout + N+1 на calculateX — §5 Business Rules / §6 Database / §7.1 Performance

**Сигнал:** новий "bulk-apply" сервісний метод (`applyPricing`/`recalcAll`/`bulkUpdate`) пройшовся `for (const item of parent.children)` де: (1) всередині circle `await someService.calculateX()` що сам робить...
**Grep:** `grep `for.*of.*lines\|for.*of.*items`у`\*.service.ts`→ перевірити (1) чи всередині є`await this.p`
**Фікс:** (1) винести pure compute helper у calc-service як public + додати prefetch helper (`getActiveRulesForOrg(orgId)`); (2) переробити bulk-метод: `const rules = await calc.getActiveRulesForOrg(orgId)` →...
**Severity:** CRITICAL — на великому PO (50+ ліній) silent default-timeout fail з частково-завершеною операцією (5 ліній розцінено, 45 ні, користувач не знає); на пустому PO degradation непомітна → пізно виявляється

---

### 2026-05-30 — Hook signature change → broken call-sites silently passed by linter — §1 TypeScript

**Сигнал:** новий required parameter додано у експортовану hook (наприклад `useColumnDrag(visibleColumns, reorder, allColumns)` з 2-arg → 3-arg); після рефакторингу tsc на одному pass показує `Expected N...
**Grep:** `grep -rn "<hookName>\(" apps/web/src/app` → перевірити що arity у кожному виклику відповідає новій с`
**Фікс:** оновити всі call-sites у одному коміті разом з hook; типовий патерн — передавати existing destructured value (`orderedColumns`) яка вже є у scope з `useTableColumns`
**Severity:** IMPORTANT — runtime undefined → null deref або silent incorrect behavior (у нашому випадку `allColumns.map(c => c.key)` на undefined → crash при першому drag); TS компілятор ловить, але кеш приховує

---

### 2026-05-30 — Buffer.buffer as ArrayBuffer ігнорує byteOffset/byteLength → читання з пулу — §2.3 Injection / §1 TS

**Сигнал:** `await library.load(buffer.buffer as ArrayBuffer)` (ExcelJS/jszip/protobuf parsers). Buffer.allocUnsafe (типовий шлях для multipart/fastify uploads) — це view над пулом → `buffer.buffer` повертає...
**Grep:** `grep `\.buffer as ArrayBuffer\b`у апі-сервісах → перевірити що`byteOffset === 0` гарантовано (для`
**Фікс:** helper `private toArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer; }`; slice створює copy саме нашого...
**Severity:** CRITICAL — silent data corruption на uploaded xlsx (буде вилазити лише на проді коли pool заповнений); локальний dev часто має byteOffset=0 і фікс не помічається

---

### 2026-05-30 — SSE/EventSource + global ThrottlerGuard → reconnect-loop вичерпує rate-limit — §2 Security / §4 Architecture

**Сигнал:** `@Sse()` endpoint + global `ThrottlerGuard` без явного `@SkipThrottle()` на цьому endpoint. Frontend має auto-reconnect (5s після network error) + browser native EventSource reconnect (1s default) +...
**Фікс:** (1) `import { SkipThrottle } from '@nestjs/throttler'` + `@SkipThrottle()` на SSE-endpoint; (2) (опційно) custom throttle on SSE — `@Throttle({ default: { ttl: 60_000, limit: 5 } })` що ліімтує лише...
**Severity:** IMPORTANT — degradation під час network instability, потенційний DoS за NAT; не immediate breach, але порушує availability invariant

---

### 2026-05-30 — Constants exported but unused → orphan API surface — §1 TS / §11 Configuration

**Сигнал:** `export const MAX_QUERY_LIMIT = 1000;` у `@sto/shared/src/constants.ts` — але `grep -rn "MAX_QUERY_LIMIT" apps/` повертає 0 матчів; commit-message обіцяє "MAX_QUERY_LIMIT on findMany" але код не...
**Grep:** `grep -rn "MAX_QUERY_LIMIT" apps/` повертає 0 матчів; commit-message обіцяє "MAX_QUERY_LIMIT on findM`
**Фікс:** для unused constants — або (а) використати у виявлених сирітських findMany (`take: MAX_QUERY_LIMIT`як safety cap де було`take: 1000`), або (б) додати `// TODO: <plan>` коментар; не залишати "голий"...
**Severity:** SUGGESTION — не баг; degradation якості API через orphan surface

---

### 2026-05-30 — Cache-Control: public на JWT-захищеному endpoint → cross-tenant витік через shared cache — §2 Security / §2.2 Tenant Isolation

**Сигнал:** `@Header('Cache-Control', 'public, max-age=N')` на `@Controller`/`@Get` що також має `@UseGuards(JwtAuthGuard, RolesGuard)`. `public` дозволяє ПРОМІЖНІМ shared cache (CDN, корпоративний proxy,...
**Grep:** `grep -rn "Cache-Control.*public" apps/api/src/modules --include="*.controller.ts"` → для кожного мат`**Фікс:**`Cache-Control: private, max-age=N, stale-while-revalidate=M`—`private`означає "кешувати лише у браузері клієнта, ніколи у proxy/CDN";`max-age` досягає UX-цілі (миттєвий другий рендер сторінки)...
**Severity:** CRITICAL — cross-tenant data leak; не immediate breach (CDN/proxy не всюди), але один невірно налаштований Nginx у проді = catastrophic; defence-in-depth invariant порушений.

---

### 2026-05-30 — IsUUID('4') у DTO ламає тести з nil-style UUID fixtures — §1 TypeScript / §2.3 Input Validation

**Сигнал:** `@IsUUID('4')` (або `@IsUUID('4', { each: true })`) у DTO; контрактні тести використовують hex-only fixture типу `00000000-0000-0000-0000-000000000099` як placeholder для "id з іншої org"....
**Фікс:** два варіанти: (а) **`@IsUUID()` без версії** — приймає всі RFC4122 v1-5; це default класу-валідатор, але `00000000-...` усе ще rejected. (б) **Оновити test fixtures на v4** —...
**Severity:** IMPORTANT — `feat:` commit з зеленим tsc лeгко мінятиме контракт без помітних test failures якщо репозиторій не запускає тести у CI на кожен push; кросс-cutting через 22+ DTO файлів.

---

### 2026-05-29 — event-handler fetch без request-token + stale похідний id — §8.2 UI Стани

**Сигнал:** `openEdit(item)` / `openCard` / `onSelect` (обробник події, НЕ useEffect) робить `apiFetch(...).then(setState)`; при повторному відкритті для іншого id попередній in-flight fetch резолвиться пізніше...
**Grep:** `grep `const (open|load|select)[A-Z]\w\* = (async )?\(` + наявність apiFetch у тілі → перевірити token`
**Фікс:** `const reqId = ++ref.current;` на старті; `if (ref.current !== reqId) return` перед кожним `.then(setState)`/`.finally`; скинути всі похідні id (`setModalGarageId(null)`) до фetch
**Severity:** IMPORTANT — stale-data race + крос-сутнісна мутація на fetch-failure (degradation/data corruption без TS/runtime помилки)

---

### 2026-05-31 — Per-item line.id-keyed onSelect sub-resource race — §8.2 UI Стани

**Сигнал:** `lines.map((l, i) => ... onSelect={async g => { setLines(...); const subResource = await apiFetch(\`/x/${g.id}/Y\`); setLines(ls => ls.map((x, idx) => idx === i ? {...x, subResource} : x)) }}`—...
**Фікс:**`onSelect={async g => { const selectedGoodId = g.id; setLines(ls => ls.map((x, idx) => idx === i ? {...x, goodId: g.id, subResource: emptyDefault} : x)); try { const subResource = await...
**Severity:** IMPORTANT — silent UI inconsistency: користувач бачить товар X, але UoM-список товару Y → невірний коефіцієнт → перерахунок quantity дає неправильне число → отриманий товар має невірну кіль. Не runtime error, але potential data corruption

---

### 2026-05-31 — `(line as any).X` cast для нового optional поля — §1 TypeScript / §13 API Contract

**Сигнал:** свіжий feat-коміт додає optional поле у backend DTO (`@ApiPropertyOptional() unitShortName?: string`), сервіс мапить `toResponseDto()` коректно, але frontend interface (`POLine`/`DocLine` у...
**Grep:** `grep -rn "@ApiPropertyOptional() <field>?" apps/api/src` → знайти interface що typing-ує endpoint на`
**Фікс:** додати поле у frontend interface (single source of truth —`hooks/api/use<Module>.ts`або centralized type у`@sto/shared`); прибрати всі `as any`casts. Якщо поле використовується у багатьох сторінках —...
**Severity:** IMPORTANT — TS type contract розірваний; IDE refactor + auto-complete не працюють; майбутні consumer-сторінки не знають про поле; легко регресує при перейменуванні поля у бекенді (cast мовчить)

---

### 2026-05-31 — Inline lambda decorator повторений 10+ разів — §2.3 / §1 DRY

**Сигнал:** `@Transform(({ value }) => (value === '' ? undefined : value))` (або інший inline-функційний-декоратор) зустрічається 20+ разів через grep по `apps/api/src/modules/`; кожне використання — точна копія
**Grep:** `grep -rn "@Transform\b" apps/api/src/modules/ --include="*.dto.ts" | wc -l` → якщо > 10 → перевірити`**Фікс:** створити`apps/api/src/common/transforms/<name>.ts`з named export → замінити inline →`@Transform(emptyToUndefined)`; синхронно прибрати dead `Transform` imports у DTO які цю утиліту не...
**Severity:** IMPORTANT — не баг, але hot-reload time + readability + reviewer fatigue; ще гірше — кожна нова DTO копіює застарілу версію helper-а коли пізніше треба «починаючий нуль теж в undefined»

---

### 2026-05-31 — Видалили manual `*` припустивши що компонент додає його, а компонент кастомний — §8 Web Frontend

**Сигнал:** коміт виду `fix(ui): прибрати ручні зірочки з label — Input/Select вже додають * через required prop` чіпає не лише `Input`/`Select` з `components/ui/`, а і **inline компонент Field/Select** у...
**Grep:** `grep -rn "function Field\|function Select\|function Input\|const Field\|const Select" apps/web/src/a`
**Фікс:** додати `required?: boolean` у props inline-Field, render `{required && <span className="ml-0.5 text-destructive">*</span>}`, передати `required` на нативний `<input>` + `aria-required={required ||...
**Severity:** IMPORTANT — UX regression: користувач не бачить required-маркера, форма дозволяє відправляти порожні значення → 400 з API без UI-підказки чому

---

### 2026-05-31 — group-hover:\* без `group` класу на батьку → dead CSS — §1 Tailwind 4 / §8

**Сигнал:** `<div className="... group-hover:opacity-100 ...">` всередині батька який НЕ має `className` що включає `group`; hover-зміна (zoom-hint, action buttons, overlay) ніколи не з'являється
**Grep:** `grep -rn "group-(hover|focus|active|disabled)" apps/web/src/ --include="*.tsx"` → для кожного — підн`**Фікс:** додати`group`клас на найближчий hover-target батько (зазвичай той самий що має`onClick`/`cursor-\*`)
**Severity:** SUGGESTION/IMPORTANT — degradation без помилки: UI-підказка прихована, UX незрозумілий

---

### 2026-05-31 — Controller з `@UseGuards(JwtAuthGuard, RolesGuard)` без `@Roles` на методах → RolesGuard no-op — §2.1 Auth & Guards

**Сигнал:** `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)` (class- або method-level), але метод НЕ має `@Roles(...)` декоратора. `RolesGuard.canActivate` повертає `true` коли `required.length === 0` →...
**Grep:** `grep -B5 "@Get\|@Post\|@Patch\|@Delete" *.controller.ts | grep -v "@Roles\|@Public"` → знайти методи`**Фікс:** explicit`@Roles('OWNER','ADMIN',...)`з повним переліком ролей; якщо endpoint реально публічний —`@Public()`. Для search-подібних з різними payload-комбінаціями: rolse list = unión всіх що мають...
**Severity:** IMPORTANT — degradation без immediate breach; payload може бути зараз безпечним, але інвариант "RolesGuard виконує перевірку" порушений → майбутній field-add без update @Roles = silent privilege escalation.

---

### 2026-05-31 — Modal/Lightbox без Escape + role=dialog + aria-modal — §8 Web Frontend (a11y)

**Сигнал:** новий компонент `<div className="fixed inset-0 z-50 ...">` (lightbox/overlay/full-screen modal) без `role="dialog"`, без `aria-modal="true"`, без `aria-label`, без `useEffect` що ловить `Escape`...
**Grep:** `grep -rnE "className=['\"]fixed inset-0.*z-50" apps/web/src --include="*.tsx"` → для кожного — звіри`
**Severity:** IMPORTANT — недоступно для клавіатурних користувачів; ARIA не озвучує "dialog opened"

---

### 2026-06-02 — Per-param `@Query('x')` без DTO → cap-less pagination + missing validation — §2.3 / §4 Architecture

**Сигнал:** контролер декларує список endpoint через окремі `@Query('q') q?: string, @Query('page') page = '1', @Query('limit') limit = '50'` (string defaults!) і всередині handler робить `Number(page)`,...
**Grep:** `grep -rn "@Query('[a-z]" apps/api/src/modules --include="*.controller.ts"` → для кожного match: якщо`**Фікс:** створити`\*QueryDto` що дзеркалить works/goods (`@Type(() => Number) @IsNumber() @Min(1) page = 1`, `@IsPositive() @Max(200) limit = 50`, `@Transform(({ value }) => value === 'true' || value ===...
**Severity:** IMPORTANT — DoS вектор + inconsistency з сусідніми модулями (review fatigue, copy-paste новими розробниками)

---

### 2026-06-03 — Animation wrapper `if (!open) return null` ламає exit-анімацію Modal — §8 Web Frontend / §3.1

**Сигнал:** свіжий компонент-обгортка (`ConfirmDialog`, `DirtyConfirmDialog`, custom dialog) рендерить `<Modal open={open} ...>` — але має власний guard `if (!open) return null` ПЕРЕД return. Коли `open` стає...
**Grep:** `grep -rn "if (!open) return null" apps/web/src/components/ui --include="*.tsx"` → для кожного файлу`**Фікс:** прибрати`if (!open) return null`з wrapper; Modal сам обробляє visibility через useAnimatedPresence. Якщо є body що дорого рендерити —`{open && <HeavyContent/>}`всередині Modal children (умовний...
**Severity:** CRITICAL — повна втрата exit-анімації для критичного UX-компонента (підтвердження дії, видалення, скасування); також ламає`useAnimatedPresence` invariant (state="closed" → 180ms → unmount), бо wrapper unmount-ить дочірній компонент раніше за animation

---

### 2026-06-03 — Глобальний `[data-state="open"]` CSS селектор б'є по чужих data-state атрибутах — §1 TypeScript/Tailwind / §8

**Сигнал:** глобальне CSS правило `[data-state="open"] { animation: ... }` (без додаткового класу/атрибута-маркера) у `globals.css`. Radix UI primitives (Accordion, Dialog, Dropdown, Popover, Switch, Tabs,...
**Фікс:** ввести скоп-маркер: `[data-animate][data-state="open"]` — анімація вмикається лише на елементах де ми явно поставили `data-animate`. Direct-child `>` для backdrop замість descendant — щоб outer-modal...
**Severity:** IMPORTANT — degradation без immediate breakage (поки немає Radix у codebase); ризик catastrophic regression при додаванні будь-якої headless UI бібліотеки; defence-in-depth invariant порушений.

---

### 2026-06-02 — restore() з окремим read для відповіді + non-null assertion — §5.2 Soft-delete / §2.2 Tenant Isolation

**Сигнал:** `restore(orgId, id)` робить ТРИ окремі DB-виклики: (1) `findFirst({ NOT: deletedAt: null })` для existence check → (2) `findFirst({ id, orgId, include })` БЕЗ deletedAt-фільтра щоб дістати...
**Grep:** `grep -rn "restore\(.*orgId" apps/api/src/modules --include="*.service.ts"` → для кожного match count`**Фікс:** один atomic`updateMany({ where: { id, orgId, NOT: { deletedAt: null } }, data: { deletedAt: null } })`→ перевірити`result.count === 0`→ 404; ОДИН наступний`findFirstOrThrow({ where: { id, orgId...
**Severity:** CRITICAL — silent crash на concurrent hard-delete; data corruption на concurrent resurrect від іншої сесії

---

### 2026-06-03 — `(entity as any).newField` у toDto() — новий nullable optional у param type пропущено — §1 TypeScript / §13 API Contract

**Сигнал:** `toDto(entity: { id: string; ... })` — новий optional field (`documentDate?: Date | null`) доданий у DB schema і у `create()` logic, але НЕ у типізованому параметрі `toDto`. Розробник використовує...
**Grep:** `grep -rn "as any\)\..*Date\|as any\)\.[a-z]" apps/api/src/modules --include="*.service.ts"` → кожен`**Фікс:** додати`newField?: Type | null`у structural param type`toDto(entity: { ... newField?: Date | null; ... })`. Потім замінити `(entity as any).newField`на`entity.newField`.
**Severity:** IMPORTANT — TS contract порушений; IDE refactor не знаходить usages; майбутній consumer toDto не бачить поля у type inference.

---

### 2026-06-03 — `new Date().toISOString().slice(0,10)` для local date в Kyiv — UTC vs local timezone — §7.2 Frontend Performance / §8.3 Hydration Safety

**Сигнал:** `const today = new Date().toISOString().slice(0, 10)` або `new Date().toISOString().slice(0, 10)` в render body або `useState` initializer; використовується як default дата фільтра або як поле форми...
**Grep:** `grep -rn "toISOString()\.slice(0, 10)" apps/web/src/app --include="*.tsx"` → кожне таке місце — канд`**Фікс:** module-level formatter`const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }); const kyivToday = () => KYIV_YMD.format(new Date());`. `sv-SE` locale повертає YYYY-MM-DD....
**Severity:** IMPORTANT — між midnight і 2-3 AM Ukraine time фільтр "сьогодні" показує документи вчорашнього дня; форма documentDate дефолтить на вчора; деградація без помилки.

---

### 2026-06-09 — Anchored popup useLayoutEffect deps `[anchorRef]` only → stale position on re-open — §3.1 Memory / §8 Web Frontend

**Сигнал:** компонент попапу/тултіпу читає координати anchor через `anchorRef.current.getBoundingClientRect()` у `useLayoutEffect(() => {...}, [anchorRef])`. Батько ставить `anchorRef.current = e.currentTarget`...
**Grep:** `grep -rnE "useLayoutEffect\(.*\}, \[anchorRef\]\)" apps/web/src/components/ui --include="*.tsx"` або`
**Фікс:** додати у deps значення яке змінюється при re-anchor — найчастіше це сам payload попапу (`preview`, `item`, `data`). `useLayoutEffect(() => {...}, [anchorRef, preview])`. Альтернатива (якщо payload...
**Severity:** IMPORTANT — UI bug без TS/runtime помилки: попап вирівнюється до неправильного рядка, користувач бачить дані рядка B але координати рядка A → візуальна неконсистентність + потенційне закривання попапу при overlay-кліку поза очікуваною областю.

---

### 2026-06-09 — Nested overlay Esc handler → закриває весь вкладений ланцюг (parent Modal теж) — §3.1 / §8 Web Frontend (a11y)

**Сигнал:** вкладений overlay (conflict-dialog/preview-popup/dropdown) додає `document.addEventListener('keydown', h)` у bubble-фазі для перехоплення Esc. Батьківський `<Modal>` теж слухає Esc на `document`...
**Grep:** `grep -rnE "document\.addEventListener\(['\"]keydown" apps/web/src/components/ui --include="*.tsx" --`
**Фікс:** перевести handler у capture phase + `stopImmediatePropagation()`:
**Severity:** IMPORTANT — катастрофічний UX: користувач втрачає несhraneні зміни WO modal при спробі закрити vложений confirmation; не data corruption, але порушує очікування "Esc closes ONLY the topmost overlay".

---

### 2026-06-12 — Naive `updateMany` на parent+continuation children колапсує split-day інтервал — §5 Business Rules / §6 Database

**Сигнал:** новий cascade-update сервіс (`syncWorkOrderSlots`, `bulkUpdateXByParent`) робить `updateMany({ where: { parentRefId }, data: { startAt, endAt } })` без розрізнення parent slot vs continuation children. У `CalendarSlot` model `parentSlotId` дозволяє split-day (createSlot ділить slot що зашовло за межі робочого дня на parent+child). updateMany із одним `{startAt, endAt}` колапсує обидва slot'и на однаковий interval → invariant `parent.endAt < child.startAt` порушений → calendar UI шиє overlapping intervals.
**Grep:** `grep -rn "updateMany.*workOrderId\|updateMany.*parentSlotId" apps/api/src/modules/calendar` — для кожного match перевірити чи розрізняє `parentSlotId: null` vs `parentSlotId: { not: null }`
**Фікс:** wrap у `$transaction({ timeout: TRANSACTION_TIMEOUT_MS })`; (1) soft-delete continuation children (`parentSlotId: { not: null }`) → (2) update тільки parent (`parentSlotId: null`). Якщо новий range > working day — можна додатково recreate continuation, але мінімально безпечно — залишити 1 anchor slot. Також обов'язково додати `endAt > startAt` guard (як у createSlot/updateSlot).
**Severity:** CRITICAL — silent data corruption на будь-якому WO з split-day slot (звичайний кейс коли наряд починається ввечері й переходить на наступний день); user-visible тільки коли натрапиш на overlapping slot у календарі.

---

### 2026-06-12 — Ad-hoc `<div className="fixed inset-0 z-[N]">` confirm-dialog замість useConfirm — §8 Web Frontend / §8.5 a11y

**Сигнал:** новий inline блок `{somePending && (<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">…<Button>Так</Button><Button>Ні</Button></div>)}` всередині великого modal-компоненту, для async confirm після save(). Файл уже imports `useConfirm` + `ConfirmDialog` + використовує `<ConfirmDialog {...confirmDialogProps} />` 5+ разів. Ad-hoc div: немає `role="dialog"`, `aria-modal="true"`, `aria-labelledby`; немає Escape handler; немає focus trap; немає exit-animation (Modal-wrapper sustains state="closed" → 180ms → unmount, а тут unmount миттєвий).
**Grep:** `grep -rnE "fixed inset-0.*z-\[?[0-9]+" apps/web/src --include="*.tsx"` — для кожного match перевірити чи має `role="dialog"`; якщо ні і в тому ж файлі є `useConfirm` import → mandatory заміна
**Фікс:** замінити inline div + `usePendingState + useRef<payload>` парою на `const ok = await confirm({ title, message, confirmLabel, cancelLabel }); if (ok) { try { await apiFetch(...) } catch (err) { console.warn(...) } }` всередині save-handler. Hook через Promise resolver elegantly serializує async flow + reuse-ить існуючий ConfirmDialog. -50 LOC, +3 a11y attrs, синхронно з рештою codebase.
**Severity:** IMPORTANT — порушує §8.5 modularity, §8 a11y, useAnimatedPresence invariant; degradation без crash, але клавіатурні юзери не можуть закрити dialog, screen reader не озвучує "dialog opened".

---

### 2026-06-14 — Boundary-константа змінена у коді, але jsdoc/inline comments досі посилаються на старе значення — §1 TypeScript / §8 Web Frontend

**Сигнал:** свіжий fix-commit замінив hardcoded magic number на named const (наприклад `19 * 60` → `WINDOW_END * 60` де `WINDOW_END = 20`). Перевір diff — fix торкається ОДНОГО місця, але у тому самому файлі є 3+ jsdoc/inline коментарі (`@param`, `// e.g.`, `// matches backend X = 19`) які пояснюють логіку через приклад зі СТАРИМ значенням. Comments не падають у tsc, не ламають runtime, але вводять в оману наступного читача — він поправить новий код назад "щоб відповідав документації". Рекурентний баг: `fef027b0` (calendar.service.ts doc-drift) і `02e16389` (CalendarSlotModal 3 stale comments).
**Grep:** після будь-якого `(\d+) \* 60 → CONST_NAME \* 60` fix → `grep -rn "<old_number>\|<old_HHmm>" <file>` у тому ж файлі та сусідніх; також звірити з backend константою (`grep -rn "WORK_DAY_END_H\|CONST_NAME" apps/api/src`) — frontend і backend константи мають збігатися (іманентний інваріант).
**Фікс:** масово оновити всі коментарі/jsdoc у тому ж файлі — заміна сирих чисел на ім'я константи (`WORK_DAY_END_H = 20`) робить майбутній drift неможливим; якщо приклад залишається конкретним ("2h from 20:00 → endAt=22:00"), окремий commit `fix(review): stale comments — X is Y, not Z`.
**Severity:** IMPORTANT — degradation якості документації; ризик майбутнього regression коли наступний розробник довіряє коменту і "виправляє" правильний код.

---

### 2026-06-14 — Нова `<col>` у `<colgroup>` додана, але `tfoot colSpan` не інкрементнутий → totals у неправильній колонці — §8 Web Frontend

**Сигнал:** feat-commit додає колонку у table (`<colgroup>` отримує новий `<col>`, `<thead>` — новий `<th>`, у `<tbody>` map-рядках — новий `<td>` у всіх режимах view/edit/new-input). АЛЕ у `<tfoot>` залишений старий `colSpan={vatMode !== 'NONE' ? 4 : 5}` що покривав попередню кількість колонок. Після зміни layout (8→9 з ПДВ, 7→8 без ПДВ) колонок, тлумачення `colSpan` зсувається: label "Разом товарів:" розтягується на 4 (замість потрібних 5) — `partsTotals.vat` потрапляє у комірку де має бути сума, `partsTotals.total` — у комірку дій. Empty-state `<td colSpan>` зазвичай оновлюють разом з рядками (видно), а tfoot прихований у кінці файлу й часто пропускають.
**Grep:** `grep -n "colSpan" <modal>.tsx` — для кожного match: порахувати фактичні `<col>` у тому самому table + `<col>{cond}` умовні; формула: `colSpan + (кількість cells після нього у тому ж row) === count(<col>)`. Якщо у diff додано новий `<col>` — інкрементнути ВСІ `colSpan` у `<tfoot>` та `<tbody>` empty-state row.
**Фікс:** ручно перерахувати: `<thead>` row має N `<th>` (включно з умовними) = N `<col>` у `<colgroup>`. `<tfoot>` row: `colSpan + (кожна сусідня `<td>`чи умовна`<td>` після label) = N`. У нашому випадку: VAT-on path = 9 cells = `colSpan=5` + 1 empty + 1 vat + 1 total + 1 actions. VAT-off path = 8 cells = `colSpan=6` + 1 total + 1 actions.
**Severity:** CRITICAL — visible layout bug одразу при додаванні parts (`Разом товарів:` totals у колонці дій, кнопки накладені на цифри); порушує table-formatting інваріант. Empty-state colSpan оновлений (видно бо завжди показується перед додаванням), а tfoot ні (показується лише після першого item — пропустили у smoke-test).

---

### 2026-06-14 — Bulk lookup endpoint без UUID-validation на `@Query('ids')` → 500 замість 400 — §2.3 Input Validation

**Сигнал:** новий "bulk get" контролер-метод приймає comma-separated IDs: `@Query('ids') ids: string` → `ids.split(',').map(trim).filter(Boolean)` → пряме `prisma.X.findMany({ where: { goodId: { in: goodIds } } })`. Postgres `@db.Uuid` колонки відхиляють non-UUID literal → `invalid input syntax for type uuid: "abc"` → 500 з не-i18n повідомленням. ParseUUIDPipe працює тільки на `@Param`, не на split-out item-ах усередині query. Окремий ризик: `ids: string` (required) тоді як логіка коректно обробляє відсутній ids (`ids ? ... : []`) → краще зробити `ids?: string`.
**Grep:** `grep -rnE "@Query\('ids'\)" apps/api/src/modules --include="*.controller.ts"` — для кожного match: чи виконується split + чи валідуються UUID-и; також — чи parameter позначений optional `?: string`.
**Фікс:** module-level `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;` (RFC4122 v1-v8, дозволяє тестовий nil UUID `00000000-...`). Після split + filter — `const invalid = goodIds.find(id => !UUID_RE.test(id)); if (invalid) throw new BadRequestException(`Некоректний goodId: ${invalid}`);`. `@Query('ids') ids?: string` коли handler коректно обробляє відсутнє значення.
**Severity:** IMPORTANT — degradation: 500 замість 400; не data-breach, але порушує defence-in-depth (Prisma error message потрапляє у логи/Sentry зі stack trace зайвої глибини).

---

### 2026-06-14 — `apiFetch().catch(() => {})` у новому useEffect — silent stale-data race без cancelled-guard — §3.1 Memory / §8.2 UI Стани

**Сигнал:** новий `useEffect` що тягне суміжні дані (totals, counters, related items) для поточного стану форми: `void apiFetch<T[]>('/x/bulk?ids=...').then(rows => setState(new Map(...))).catch(() => {});`. Без `cancelled` flag — резолв старого запиту після unmount/deps-change перезаписує свіжий state. Без `console.error` у catch — будь-яка серверна помилка (500/timeout) пройде непомітно для розробника й користувача. Третій ризик: `Map` побудовано лише з реально-повернених рядків — для goodId без `StockItem` строки (groupBy omits empty buckets) `map.get(id)` повертає `undefined` → `'—'` у UI, хоча правильніше показати `0`.
**Grep:** `grep -rnE "useEffect\(\(\) => \{" apps/web/src/components/ui --include="*.tsx" -A20` → для кожного блоку що містить `apiFetch` + `.then(setState)`: (1) чи є `let cancelled = false` + cleanup; (2) чи catch робить `console.error` (а не `() => {}`); (3) для Map-результату — чи pre-initialized z `0`/default для всіх запитуваних ID.
**Фікс:** `let cancelled = false; void apiFetch(...).then(rows => { if (cancelled) return; const next = new Map(ids.map(id => [id, 0])); for (const r of rows) next.set(r.id, r.value); setState(next); }).catch(err => { if (cancelled) return; console.error('[label] fetch failed', err); }); return () => { cancelled = true; };`. Pre-init з `0` дає правильний UX для goods без StockItem рядків.
**Severity:** IMPORTANT — race-window коли користувач швидко змінює selection/parts (degradation без crash); silent server-error blackout зашкоджує діагностиці; UX edge-case (`'—'` коли має бути `0`) — мінорна але часта плутанина зі складом.

---

### 2026-06-05 — Partial `setPage(1)→resetPage()` migration: applyFilter мігровано, inline JSX handlers пропущено — §8.2 UI Стани / §8.6 Модульність UI

**Сигнал:** Сторінка використовує `useListPage` хук що експортує і `setPage` і `resetPage = useCallback(() => setPage(1), [])`. Один callback (зазвичай `applyFilter`) використовує `resetPage()` — а інші 5 сайтів...
**Grep:** `grep -rn "setPage(1)\|<helper-back-form>" apps/web/src/app/` → перевірити кожен файл-консумент окрем`**Фікс:** Для кожного inline JSX handler —`setPage(1)`→`resetPage()`. `setPage`ОБОВ'ЯЗКОВО лишити у destructured scope (потрібен для`<Pagination onChange={setPage}>`що передає довільні номери сторінок,...
**Severity:** SUGGESTION — функційно ідентично (бо`resetPage()`=`setPage(1)`), але порушує DRY consistency (одна сторінка має 2 різні способи однакової дії); посилює когнітивне навантаження читача; ризик майбутньої regression якщо `resetPage`отримає side-effect (наприклад`setActiveSavedFilterId(null)` всередині хука).

---

### 2026-06-15 — Новий enum-value не підхоплений жорстко-закодованим масивом на фронті — §8 Web Frontend

**Сигнал:** Backend додає нове значення в enum (`StockDocumentType.RECEIPT`, `WorkOrderStatus.X`) і оновлює відповідний `*_LABELS` у `@sto/shared`. Але на фронті фільтр-таби рендеряться з локального хардкоду:

```ts
const types = ['', 'WRITEOFF', 'TRANSFER', 'OPENING_BALANCE']; // ❌ RECEIPT відсутній
```

Користувач не бачить нову опцію в UI попри повну підтримку у Prisma/seed/API/labels.

**Grep:**

```bash
# Після `feat: add <NEW_VALUE> to <ENUM>` — звірити що в апп-сторінках немає hardcoded масивів з рештою значень того ж enum
grep -rnE "'WRITEOFF',\s*'TRANSFER',\s*'OPENING_BALANCE'" apps/web/src/
grep -rn "STOCK_DOC_TYPE_LABELS\|WO_STATUS_LABELS" apps/web/src/ --include="*.tsx" -A1 | grep -E "const \w+ = \["
# або загально: знайти сторінки що іменують enum-values в локальних масивах поряд із імпортом labels
```

**Фікс:** додати новий value у hardcoded array. Краще — замінити array на `['', ...Object.keys(STOCK_DOC_TYPE_LABELS)]` щоб майбутні значення підхоплювались автоматично.

**Severity:** CRITICAL — фіча відвантажена, але не доступна користувачу в UI (тип-таб для нового значення відсутній → не можна фільтрувати/орієнтуватись). TS green — компілятор не ловить «не повний union».

---

### 2026-06-15 — Tab buttons з `focus:outline-none` без `focus-visible:*` заміни — §8.5 a11y / §1 Tailwind

**Сигнал:** новий tab-bar (section tabs у purchase-orders, type tabs у stock-documents, будь-який кастомний `<button>` із styled border-b) додає `focus:outline-none` щоб прибрати браузерний outline, але НЕ додає `focus-visible:ring-*` або `focus-visible:rounded-*`. Результат: клавіатурний користувач (Tab navigation) не бачить де він знаходиться — focus indicator повністю прибраний, WCAG 2.1.1 (Keyboard accessible) і 2.4.7 (Focus visible) порушено. Типовий патерн виник з desire прибрати "потворний" нативний outline без розуміння що `focus-visible` — це окремий перемикач (тільки коли input modality = keyboard), `:focus` ловить навіть mouse click.

**Grep:**

```bash
# Tab/button із focus:outline-none БЕЗ focus-visible:* заміни
grep -rnE "focus:outline-none" apps/web/src/app --include="*.tsx" | grep -v "focus-visible:\|focus:ring-"
# Інакше: знайти <button> або клас-композицію де є focus:outline-none тa немає focus-visible:ring/border/bg
```

**Фікс:** додати `focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm` (або еквівалентний focus indicator що відповідає design system). Для якщо tab уже має активний `border-primary` колір — focus-visible не дублює, а додає легкий outline-ring навколо.

**Severity:** IMPORTANT — degradation без crash; keyboard-only користувачі (a11y user, power user, screen reader) не можуть зорієнтуватись. WCAG fail.

---

### 2026-06-15 — `router.replace(url)` без `{ scroll: false }` для URL sync — §8 Web Frontend

**Сигнал:** новий URL sync патерн (`?tab=`, `?type=`, `?status=` на list-сторінках) використовує `router.replace(\`?${params.toString()}\`)`без опцій. Next.js 13+ App Router default scroll behavior:`router.replace`(як і`router.push`) **скролить контейнер до top** після route change, навіть якщо path не змінився. На длинних сторінках (table з 50+ рядків, scroll вниз → клік tab → стрибок наверх) це руйнує UX continuity. Спрацьовує також при `setActiveTab` через ChangeEvent — кожен клік повертає до header.

**Grep:**

```bash
# router.replace/push без { scroll: false } у tab/filter-sync handlers
grep -rnE "router\.(replace|push)\(" apps/web/src/app --include="*.tsx" | grep -v "scroll:\s*false\|//\|spec"
# Звернути увагу на ті де URL — query-string update (`/?x=` чи `?tab=`), а не повний path
```

**Фікс:** `router.replace(\`?${params.toString()}\`, { scroll: false })`. Те саме для `router.push` коли URL change cosmetic (filter/tab sync). Для реальної навігації (open detail page) scroll-to-top нормальний — НЕ додавати.

**Severity:** IMPORTANT — UX degradation; не data loss, але втрата context (користувач відскролив до конкретного рядка → клік на tab → знову зверху).

---

### 2026-06-16 — Новий blob-download handler без `appendChild`/`removeChild` + immediate `URL.revokeObjectURL` — §1 TypeScript / §8 Web Frontend

**Сигнал:** свіжий feat-commit додає кнопку завантаження PDF (`downloadInvoicePdf`, `downloadXlsx`, …) яка робить `URL.createObjectURL(blob)` → `a.click()` → одразу `URL.revokeObjectURL(url)` без `setTimeout` і без `document.body.appendChild(a)/removeChild(a)`. У тому ж файлі вже є робочі hand­лери (`downloadPdf`, `downloadActPdf`) з паттерном `appendChild → click → removeChild → setTimeout(revoke, 100)`. Без appendChild Firefox/Safari не диспатчать `click` на detached anchor; без `setTimeout` Chromium може дропнути download (revoke до того, як browser почав читати blob). Bug #77/#341 покривав це для перших двох handler-ів — третій додано окремо й паттерн пропустили.

**Grep:**

```bash
# Кожен виклик URL.revokeObjectURL у фронті — впевнитись, що setTimeout або у unmount-effect
grep -rnE "URL\.revokeObjectURL" apps/web/src/ --include="*.tsx" --include="*.ts" -B5 \
  | grep -E "revokeObjectURL|click\(\)" | head -20
# Якщо `a.click()` і `URL.revokeObjectURL(url)` стоять у сусідніх рядках без `setTimeout` — bug.
# Окремо: для кожного `document.createElement('a')` має бути `document.body.appendChild(a)` і `removeChild(a)`.
grep -rnE "document\.createElement\(['\"]a['\"]\)" apps/web/src/ --include="*.tsx" --include="*.ts" -A8 \
  | grep -v "appendChild\|removeChild" | head
```

**Фікс:** уніфікувати з існуючим патерном файлу — `document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 100);`. Filename — використовувати human-readable identifier (number, name), не UUID (`invoice-${invoiceNumber}.pdf`, не `invoice-${invoiceId}.pdf`) — UUID непридатний для archive/grep.

**Severity:** CRITICAL/IMPORTANT — Firefox/Safari не починають download (тиха відмова без помилки); Chromium під load — race-window коли revoke перед read; UUID-filename ускладнює архівацію клієнтом.

---

### 2026-06-16 — Hardcoded status labels у новій секції, поряд із готовим shared `*_STATUS_LABELS` — §8 Web Frontend / §1 DRY

**Сигнал:** свіжа секція картки наряду/контрагента/SD рендерить status badge через 5-гілковий ternary з рядковими літералами:

```tsx
{
  invoiceRef.status === 'DRAFT'
    ? 'Чернетка'
    : invoiceRef.status === 'SENT'
      ? 'Відправлено'
      : invoiceRef.status === 'PAID'
        ? 'Оплачено'
        : ...;
}
```

АЛЕ `@sto/shared` уже експортує `INVOICE_STATUS_LABELS` / `WO_STATUS_LABELS` / `STOCK_DOC_TYPE_LABELS` тощо як `Record<string, string>` (повний UA-labels mapping). Risk: divergence у точному формулюванні — наприклад, локально `'Відправлено'` vs shared `'Надіслано'` для `SENT` → один і той самий статус має різну UA-назву у різних місцях UI (badge на WO card vs invoice list page).

**Grep:**

```bash
# Inline ternary з status labels у нових секціях
grep -rnE "status === ['\"]DRAFT['\"]\s*\?\s*['\"][А-ЯҐЄІЇа-яґєії]" apps/web/src/app --include="*.tsx" | head
# Звірити з shared
grep -n "_STATUS_LABELS\b" packages/shared/src/constants/statuses.ts
# Для кожного match — у тому ж файлі імпортується відповідний *_STATUS_LABELS?
```

**Фікс:** імпортувати `INVOICE_STATUS_LABELS` (або відповідний) з `@sto/shared`, замінити ternary на `{LABELS[status] ?? status}`. Якщо потрібен color-mapping — використати `_STATUS_BADGE` (теж у shared). Кожен новий status-аware UI блок мусить first-check shared constants.

**Severity:** IMPORTANT — divergence між сторінками для одного й того ж статусу (degradation UX без crash); порушує SSOT-інваріант `@sto/shared`.

---

### 2026-06-16 — Backend response type декларує `status: string` замість `InvoiceStatus`/`WorkOrderStatus` literal union — §13 API Contract / §1 TypeScript

**Сигнал:** новий lightweight endpoint (`findByWorkOrder`, `getActiveByX`, summary endpoint) повертає об'єкт зі `status: string` у Promise return type:

```ts
async findByWorkOrder(...): Promise<{
  id: string; number: string; status: string;  // ❌ bare string
  amount: number; documentDate: string | null;
} | null> { ... }
```

Prisma `select` повертає prisma-enum (`InvoiceStatus`/`WorkOrderStatus`), і TS-вивід вдало звужує — але explicit return type губить literal union. Frontend дзеркалить ту ж саму помилку (`status: string` у `useState<…>`), і UI порівняння (`status === 'DRAFT'`) перестає захищати від typo (`'DRAF'`) — TypeScript уже не ловить.

**Grep:**

```bash
# Backend service return types з status: string
grep -rnE "status:\s*string" apps/api/src/modules --include="*.service.ts" | head
# Frontend lightweight ref types з тим же gap
grep -rnE "status:\s*string" apps/web/src/app --include="*.tsx" | grep -v "completionAct.status" | head
```

**Фікс:** `import { InvoiceStatus } from '@prisma/client'` (backend) → `status: InvoiceStatus` у return type. Frontend → `import type { InvoiceStatus } from '@sto/shared'` (literal union вже існує) → `status: InvoiceStatus`. Перевірити що `'DRAFT' | 'SENT' | ...` exhaustive проти всіх case-ів у UI.

**Severity:** IMPORTANT — typo-magnet, lost type-safety на UI guards (один з найчастіших джерел тихих UI bugs).

---

### 2026-06-15 — Dead code після onClick refactor: orphan `selectX/toggleSelectX` після redirect на edit modal — §8 Web Frontend / §1 TS

**Сигнал:** list-сторінка має пару функцій `const selectDoc = useCallback(...)` + `const toggleSelectDoc = useCallback(() => { setSelectedDoc; void selectDoc; }, [selectDoc])` для DetailPanel selection. Розробник міняє onClick рядка з `() => toggleSelectDoc(doc)` на `() => setEditingDocId(doc.id)` (відкриває edit modal замість DetailPanel selection). АЛЕ `toggleSelectDoc` і `selectDoc` лишаються в файлі і ніхто на них не посилається — TS green (функції оголошені), runtime ніколи не виконує. Результат: DetailPanel ніколи не показує дані бо `selectedDoc` залишається `null` — `setSelectedDoc` викликається тільки з `toggleSelectDoc` що мертвий. Toggle button у toolbar є, але `selectedDoc` ніколи не присвоюється → panel порожній.

**Grep:**

```bash
# Подвійна функція + orphan check
grep -rnE "const (select|toggle)[A-Z][A-Za-z]+ = useCallback" apps/web/src/app/ --include="*.tsx" -A1
# Для кожного знайденого: grep -n "<functionName>(" <file>; якщо тільки місце оголошення → dead
# Особливо ризиковано коли є setSelectedX state + DetailPanel що покладається на нього
```

**Фікс:** видалити мертві `selectDoc` + `toggleSelectDoc`; **АБО** якщо DetailPanel реально потрібен — додати окремий handler `onSelect` (через icon-button "очі") чи long-press; не пересікати з row-click що відкриває edit. Перевірити: чи `selectedDoc` state взагалі потрібен якщо DetailPanel не використовується? Тоді видалити весь pipeline.

**Severity:** IMPORTANT — broken feature без TS/runtime error; DetailPanel "є у UI" (toggle button) але порожній → користувач думає що це bug панелі, а не зламана wiring; також dead code = шум для майбутніх читачів.

---

### 2026-06-17 — Aggregate-level field змінено (recalcTotals) але per-line displayed values not propagated downstream — §5 Business Rules / §13 API Contract

**Сигнал:** новий поле-агрегат у parent-моделі (`WorkOrder.totalActualLabor`, `Invoice.totalWithVat`) рахується через **нову формулу** у `recalcTotals` (`SUM((actualHours ?? normoHours) × price)`). Aggregate тепер записаний у БД, але стара `line.amount` колонка зберігає **планові** значення (`normoHours × price`). Будь-який downstream document що пайпить `line.amount` напряму у вивід (PDF, Excel, DOCX, completion-act, invoice refresh-from-WO) показує:

- line: `quantity = actualHours` (нове) × `price`, але `total = l.amount` (старе) → "5 год × 100 ₴ = 300 ₴" — арифметика не сходиться
- `SUM(line.total) ≠ parent.totalAmount` (бо parent рахує actualHours, line.amount — normoHours)
- `refreshFromWorkOrder` мовчки перезаписує `invoice.amount` сумою `normoHours × price`, тоді як `createFromWorkOrder` поставив `wo.totalAmount` (actualHours × price)

**Grep:**

```bash
# Знайти всі місця де line/part .amount читається напряму у вивід
grep -rn "l\.amount\|line\.amount\|Number(l\.amount)\|Number(line\.amount)" apps/api/src/modules --include="*.ts" | grep -v spec | head
# Кожне таке місце — порівняти що quantity у тому ж об'єкті рахується з actualHours, а total — з amount
# refreshFromWorkOrder-стилі (re-build invoice/act lines з WO lines) — особливо ризиковано
grep -rn "wo\.lines\.map\|workOrder\.lines\.map\|buildLines" apps/api/src/modules --include="*.ts" | grep -v spec | head
```

**Фікс:**

1. Замість `total: Number(l.amount)` рахувати з displayed quantity: `const quantity = l.actualHours ?? l.normoHours; const total = quantity * Number(l.price);` (single-source: одна формула на parent + child).
2. У `refreshFromWorkOrder`/`buildLines`-стилі обов'язково додавати `actualHours: true` у `lines.select` (бо вузький `select` без actualHours = silent fallback на normoHours).
3. Перевірити всі downstream "act of completed work": completion-act, invoice refresh, PDF/Excel/DOCX, public estimate share — мають дзеркалити нову формулу parent-агрегату.

**Severity:** CRITICAL — користувач бачить документ з арифметикою що не сходиться ("5 × 100 = 300"); сума рядків ≠ ЗАГАЛЬНА; invoice після refresh мовчки змінює суму. tsc мовчить, runtime працює, але документ юридично неправильний.

---

### 2026-06-17 — Нове `costPrice`/`purchasePrice` поле у nested DTO без role gate — §2.1 Auth & Guards

**Сигнал:** feat-commit додає чутливе цінове поле (`costPrice`, `purchasePrice`, `margin`, `batchCostPrice`) у nested sub-DTO (`WorkOrderPartResponseDto`, `InvoiceLineResponseDto`, `StockDocumentLineResponseDto`), а parent endpoint (`GET /work-orders/:id`, `GET /invoices/:id`) дозволяє ширший Roles-список (`MECHANIC`, `RECEPTIONIST`, `CLIENT`-сюжетно). `toPartDto` мапить поле безумовно — без врахування ролі поточного користувача. RolesGuard на ENDPOINT-рівні пропускає виклик (бо `MECHANIC` дозволено читати наряд), але field-level visibility інваріант з `goods.controller.ts` (`/price-history` лише OWNER/ADMIN/STOREKEEPER/ACCOUNTANT) порушений.

**Grep:**

```bash
# Нове чутливе поле у nested DTO
grep -rnE "(costPrice|purchasePrice|margin|batchCostPrice)\??:" apps/api/src/modules --include="*.dto.ts" | head
# Для кожного match — endpoint що повертає цей DTO + перевірити @Roles
# Якщо endpoint дозволяє MECHANIC/RECEPTIONIST → шукати role-based маскування у toDto
grep -rn "canSeeCostPrice\|COST_PRICE_VISIBLE_ROLES\|userRole.*toPartDto\|role.*toLineDto" apps/api/src/modules --include="*.service.ts"
# Зразок маскування у goods/price-history (§2.1 reference pattern)
grep -n "@Roles.*STOREKEEPER" apps/api/src/modules/goods/goods.controller.ts
```

**Фікс:** module-level `const COST_PRICE_VISIBLE_ROLES = new Set(['OWNER','ADMIN','STOREKEEPER','ACCOUNTANT']); const canSeeCostPrice = (r?: string) => !!r && COST_PRICE_VISIBLE_ROLES.has(r);` → `toPartDto` приймає `userRole?: string` другим параметром → `costPrice: canSeeCostPrice(userRole) ? Number(...) : undefined`. Controller передає `@CurrentUser() user: { role: string }` у `findOne(orgId, id, user.role)`. Internal callers (без role-контексту) автоматично fail-closed.

**Severity:** CRITICAL — financial data leak до MECHANIC/RECEPTIONIST. tsc мовчить (`?: number | null` приймає undefined); ручний тест mechanic-сесії не показує (FE не рендерить undefined); виявляється лише через DTO inspection або проникаючий тест. Захист defence-in-depth — RolesGuard на endpoint не покриває field-level.

---

### 2026-06-17 — Inline column alignment inconsistency: новий `<td>` має `text-center` при `text-left` у братів — §8.6 Модульність UI

**Сигнал:** нова колонка таблиці додана у три "modes" (view, edit, new-input) одного компоненту. View та edit мають `text-left tabular-nums text-muted-foreground`, а new-input — `text-center` (звичайно `text-center` для самотнього `—` через "візуальну гарність"). Header `<th>` — `text-left`. Результат: при додаванні товару колонка показує `—` по центру, при перегляді — справа від `:`. Inconsistency помітна тільки коли користувач переключається між modes.

**Grep:**

```bash
# Знайти triple-mode column (view/edit/new-input) у крупних модалках
grep -rnE "px-2 py-1.5 text-(left|center|right)" apps/web/src/components/ui --include="*.tsx" | head
# Для кожної нової колонки: переконатись що всі три mode-комірки мають однаковий alignment (узгоджений з header)
```

**Фікс:** уніфікувати з view-mode — той самий `text-left tabular-nums text-muted-foreground`. Header задає істину alignment-а; усі body-комірки повинні дзеркалити.

**Severity:** SUGGESTION — degradation UX без функційної помилки; запахом inconsistency reviewer-fatigue.

---

### 2026-06-17 — Frontend modal apiFetch до неіснуючого endpoint + silent .catch(()=>{}) — §8.1 / §8.2

**Сигнал:** новий feat-commit додає UI секцію (VAT row, optional sub-counter) що залежить від сетингів через `apiFetch<{...}>('/X/Y')` де `/X/Y` — endpoint якого НЕМАЄ у backend. У тому ж файлі / сусідньому модалі вже є робочий патерн з ТИМ САМИМ призначенням (читання org settings) через інший URL (`/settings/organisation`). Silent `.catch(() => {})` приховує що setVatMode/setVatRate ніколи не викликаються, і UI-блок (умовна VAT-колонка/рядок) тихо лишається невідрендеренним. Frontend-тести проходять (DTO accepts undefined), e2e не помічає (фіча не активна). У PROD виходить feature-flag drift: backend готовий, frontend "має кнопку" але вона не реагує.

**Grep:**

```bash
# Endpoint що не існує у backend
for url in $(grep -rnE "apiFetch<[^>]*>\(['\"]/[a-z]" apps/web/src --include="*.tsx" -o | grep -oE "['\"]/[^'\"]+['\"]" | sort -u); do
  path=$(echo "$url" | tr -d "'\"" | cut -d'?' -f1 | sed -E 's|/:[a-zA-Z]+|/X|g')
  base=$(echo "$path" | cut -d'/' -f2)
  grep -rqn "@Controller\(['\"]$base['\"]" apps/api/src/modules/ --include="*.controller.ts" || echo "MISSING: $url"
done

# .catch(()=>{}) у fetch handler — приховує що state ніколи не сетиться
grep -rnE "\.catch\(\(\) => \{\}\)" apps/web/src/ --include="*.tsx" --include="*.ts"
```

**Фікс:**

1. Звірити з робочим патерном того ж призначення (нерідко це інший modal у тому ж теці) — реюзнути URL і поле.
2. Замінити `.catch(() => {})` на `.catch(err => console.error('[ComponentName] X failed', err))` щоб майбутній regression миттєво потрапив у browser console + Sentry.
3. Якщо response shape різниться (наприклад `defaultVatRate` (число) vs `defaultVatRateId` (uuid)) — додати explicit resolve step через додатковий endpoint (`/settings/tax-rates`).

**Severity:** CRITICAL — silent UI dead code. Feature-flag drift: фіча "написана" але не показана; merging без user-testing цикл пропустить.

---

### 2026-06-17 — Aggregation report без status-фільтра → юридично неправильний звіт ПДВ/виручки — §5 Business Rules / §13

**Сигнал:** новий tax-aware aggregation endpoint (`vatReport`, `revenueReport`, `payablesReport`) робить `prisma.X.aggregate({ where: { orgId, deletedAt: null, documentDate: { gte, lte } }, _sum: { totalVat: true } })` БЕЗ `status: { in: [...] }` фільтра. Включаються DRAFT (ще не виставлені/не отримані), CANCELLED (анульовані) → звіт показує більший ПДВ-зобов'язання ніж юридично винний; інкримінує організацію перед ДПС. Симетрично для PurchaseOrder: VAT credit з DRAFT/ORDERED ще не реалізований (не отримано постачання) → завищена сторона "ПДВ сплачено".

**Grep:**

```bash
# aggregate без status у where
grep -rnE "\.aggregate\(\{" apps/api/src/modules/reports apps/api/src/modules/*/reports* --include="*.service.ts" -A10 \
  | grep -B5 "_sum\|_count" | grep -v "status:" | head -20

# Альтернатива: aggregate на моделі що має status enum
for model in Invoice PurchaseOrder WorkOrder StockDocument SupplierReturn; do
  grep -rn "${model,,}.aggregate\|prisma\.${model,,}\.aggregate" apps/api/src/modules \
    --include="*.service.ts" -A5 | grep -B1 "status:" || echo "MISSING status filter: $model"
done
```

**Фікс:** додати `status: { in: [VALID_STATUSES] }` згідно бізнес-правил:

- **Sales VAT (Invoice):** `SENT`, `PAID`, `OVERDUE` (виставлені — податкова подія сталась). DRAFT/CANCELLED — ні.
- **Purchase VAT credit (PurchaseOrder):** `PARTIAL`, `RECEIVED` (отримано постачання). DRAFT/ORDERED/CANCELLED — ні.
- **Revenue (WorkOrder):** `COMPLETED`, `INVOICED`, `PAID`, `ARCHIVED` (закриті завершенням).
- **Inventory (StockDocument):** `CONFIRMED` (DRAFT може бути неточним).

Документувати inline коментарем _чому саме ці статуси_ — інакше наступний розробник додасть DRAFT "для повноти" і поверне баг.

**Severity:** CRITICAL — financial/regulatory compliance bug. tsc мовчить, runtime працює, користувач довіряє звіту; виявляється лише при перевірці ДПС або реальному квартальному звіті.

---

### 2026-06-17 — `vatMode: string` у service return → cast `as 'NONE' | ...` у консумерах — §1 TypeScript / §13 API Contract

**Сигнал:** service-метод (`getDefaultVatRate`, `getStatus`, `getCurrentMode`) повертає `Promise<{ vatMode: string; ... }>` — bare `string`, а не Prisma enum (`VatMode`). Кожен консумер змушений робити `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'` каст перед використанням у utility (`calcLineVat(...)` чекає `VatMode`). Типовий патерн при поспіху: автор написав return type перед тим як думати про union, або тестуючи. tsc приймає (bare string subtype literal), але cognitive overhead + DRY-загроза (одна зміна enum value — оновлювати всі касти).

**Grep:**

```bash
# Service return type з bare-string на полі що є enum у Prisma
grep -rnE "Promise<\{[^}]*: string[;,]" apps/api/src/modules --include="*.service.ts" | head
# Для кожного — переконатися що поле НЕ enum: grep "<field>" packages/database/prisma/schema.prisma
# Якщо enum → return type має містити Prisma's enum

# Каст `as 'X' | 'Y'` у callers — сигнал що service return type невірний
grep -rnE "as ['\"][A-Z_]+['\"] \| ['\"][A-Z_]+['\"]" apps/api/src --include="*.ts" | head
```

**Фікс:** `import { VatMode } from '@prisma/client'` у service → `Promise<{ vatMode: VatMode; ... }>` → видалити всі `as` касти у callers. Якщо utility має локальний дубль типу (`type VatMode = 'NONE' | ...`) — замінити на `import type { VatMode } from '@prisma/client'`. Single-source-of-truth.

**Severity:** IMPORTANT — degradation TS contract; не runtime bug, але порушує DRY + кросс-cutting через всі callers; будь-яка зміна enum (`+ MIXED`) ламає тихо.

---

### 2026-06-17 — Prisma `_sum.X` з ugly `(agg._sum as { X?: unknown })` cast → автор зайвий обернувся — §1 TypeScript

**Сигнал:** `prisma.X.aggregate({ _sum: { totalVat: true } })` → callers витягують значення через `(agg._sum as { totalVat?: unknown }).totalVat ?? 0`. Prisma вже генерує precise type `XSumAggregateOutputType = { totalVat: Decimal | null }` — direct `agg._sum.totalVat` працює без касту. Зайвий cast = (1) показник що автор копіював без розуміння, (2) ламається при rename поля у schema (як 1) cast виживає silently бо `unknown`).

**Grep:**

```bash
grep -rnE "_sum as \{" apps/api/src --include="*.ts"
grep -rnE "_count as \{|_avg as \{|_min as \{|_max as \{" apps/api/src --include="*.ts"
```

**Фікс:** прибрати cast, користуватися згенерованим типом напряму. Якщо TS чомусь не виводить — повторно генерувати Prisma client (`pnpm prisma generate`) і повторити; cast — ніколи не рішення.

**Severity:** SUGGESTION — не баг, але cleanup: TS guard слабшає, runtime ідентичний; нагромадження касту у codebase призводить до "так і потрібно" cargo cult.

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
