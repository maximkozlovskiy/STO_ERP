---
name: sto-review
description: >
  Perform a thorough code review of STO ERP changes. Use when the user says "зроби code review", "перевір код", "review PR", or after implementing a feature. Reviews cover: correctness, security, memory leaks, performance, TypeScript quality, NestJS/Next.js/Expo conventions, business rule compliance, sync-readiness.
model: claude-opus-4-8
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

# .add() ПІСЛЯ закоміченої $transaction без .catch() — enqueue-fail валить успішну фінансову операцію
# (offline-first: Redis-down = нормальний стан). Сигнал: `await this.Xqueue.add(` НЕ у ланцюгу .catch
grep -rnE "await this\.[a-zA-Z]+[Qq]ueue\.add\(" apps/api/src/modules --include="*.service.ts" -A12 \
  | grep -L "\.catch(" 2>/dev/null; \
grep -rnE "await this\.[a-zA-Z]+[Qq]ueue\.add\(" apps/api/src/modules --include="*.service.ts"
```

- [ ] Кожен `.add()` → `attempts ≥ 10`, `backoff: { type: 'exponential' }`
- [ ] **`.add()` де `job.data` містить секрет (apiKey/token/creds/пароль) → `removeOnFail: N`** (bounded). Без нього невдалі jobs осідають у Redis назавжди → секрет живе безстроково + ріст памʼяті. Grep: `grep -rn "\.add(" apps/api/src --include="*.ts" -A8 | grep -iE "apiKey|token|secret|creds|password" ` → перевірити наявність `removeOnFail` у тому ж блоці опцій
- [ ] ПРРО: `attempts: 288`, `backoff: { delay: 300_000 }` (24 год)
- [ ] SMS: `attempts: 10`, `backoff: { delay: 60_000 }`
- [ ] Процесори → `try/catch` + `throw err` (щоб BullMQ retry спрацював)
- [ ] Ніяких прямих HTTP до зовнішніх API поза чергою
- [ ] **`@Process(name)` → `@Process({ name, concurrency: N })`**: HTTP I/O → `3-5`, DB write → `3`, batch fan-out → `1`
- [ ] **`.add()` ПІСЛЯ закоміченої `$transaction` → `.catch()` (non-blocking), НЕ голий `await`.** Коли фінансова/доменна операція вже закомічена (Payment+settlement+FSM), а enqueue йде ПІСЛЯ tx, голий `await queue.add()` при Redis-down кидає → HTTP 500 попри успішну операцію + сутність зависає у `QUEUED`/pending-статусі навічно (жодного job-а). Offline-first (CLAUDE.md §3: система не зупиняється без Redis). Fix: `.catch(async err => { logger.warn(...); await entity.update({ status → FAILED/термінальний, error: 'Черга недоступна' }) })` — дзеркалить сусідні non-blocking enqueue (`loyalty.queueEarn`, `notifications.send`). Grep: детектор вище. Severity: IMPORTANT (offline-first + stuck-status lifecycle hole)
- [ ] **Зовнішній connection/transport/pool у provider (nodemailer `createTransport`, БД-конект, socket) → `close()`/`dispose()` у `finally`, НЕ лише на success-гілці.** Створити ресурс ДО `try`; закрити у `finally`. Інакше кинутий виклик (таймаут/auth-фейл/ECONNREFUSED) лишає сокет висіти → при `concurrency=N × attempts=10` десятки leaked-сокетів. Дзеркалить fetch-патерн `clearTimeout(timer)` у `finally` (§7 AbortController). Grep: `grep -rnE "createTransport|\.connect\(|new (Pool|Client)\(" apps/api/src/modules --include="*.ts" | grep -v spec` → для кожного перевірити, що парний `close()`/`end()`/`dispose()` стоїть у `finally`, а не лише перед `return`

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

# Side-effect (apiFetch/fetch) ВСЕРЕДИНІ state-updater `setX(prev => { ...apiFetch...; return ... })`
# — updater має бути ЧИСТИМ; React StrictMode double-invoke updater у dev → дубль-GET.
# Toggle-select handler (клік по вже-вибраному → закрити) не має жити в updater.
grep -rnE "set[A-Z][A-Za-z]*\((prev|cur|p)\s*=>" apps/web/src/app apps/web/src/components --include="*.tsx" -A4 \
  | grep -E "apiFetch|apiBlobFetch|fetch\(" | head -10
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
- [ ] Side-effect (`apiFetch`/`fetch`) НЕ всередині state-updater `setX(prev => {...})` — updater має бути чистим; StrictMode double-invoke дублює запит. Sample bug (audit 6405c3a9): `selectPO` робив довантаження повного PO у `setSelectedPO(prev => { apiFetch(...); return po })` для toggle-логіки. Fix: fetch ПОЗА updater; toggle-рішення (клік по вже-вибраному → закрити) через синх `selectedIdRef` (sync-ується `useEffect([selected])`), не через читання `prev` у самому updater-і

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

# Sentinel empty-string у UUID FK write: shape `consumed[0].batchId` / `res[0].XId`
# без truthy-guard, при цьому колонка у Prisma-схемі — `@db.Uuid`. AVG_COST/aggregate
# branch у batch/alloc-сервісі може повертати '' → Postgres кидає runtime
# "invalid input syntax for type uuid: """.
grep -rnE "consumed\[0\]\.batchId|allocations\[0\]\.[a-zA-Z]+Id|results?\[0\]\.[a-zA-Z]+Id" apps/api/src/modules --include="*.ts" | grep -v spec | head
# Fix: `if (results[0].id) db.X.update({...})` або truthy у ternary:
# `results[0].id ? results[0].id : null`.
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
- [ ] **`getLinkedCounts` liveness == detail** (Bug #A/#641): count пов'язаних сутностей мусить gate FK на живості (`findMany` живих реф-id + `Set`-membership), бо парний `getLinkedDocuments` фільтрує `deletedAt:null`; безумовне `? 1 : 0` / `= 1` розсинхронить badge з панеллю коли реф soft-deleted (FK `ON DELETE SET NULL` не спрацьовує на soft-delete). Grep: `grep -rn "getLinkedCounts" apps/api/src/modules --include="*.service.ts"`

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

# СТАНДАРТ списків: сторінка з <DetailPanel> МУСИТЬ мати <DetailPanelToggle> (інакше
# користувач не може сховати панель; на deep-tab-сторінках панель мовчки зникає — Bug #496/#505).
for f in $(grep -rl "<DetailPanel\b" apps/web/src/app --include="*.tsx" | grep -v "detail-panel-toggle"); do
  grep -q "DetailPanelToggle" "$f" || echo "MISSING TOGGLE: $f має DetailPanel без DetailPanelToggle"
done
```

- [ ] Список із `<DetailPanel>` → має `<DetailPanelToggle>` (enabled/toggle з `useListPage().detailPanel` або `useDetailPanel(key)`); row onClick і панель гейтяться `detailPanel.enabled`
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
- [ ] **Export/render parity (екран↔файл):** окремий `exportCell`/`toCsvCell` helper поруч із екранним `fmtCell`/`renderCell` → мусить давати ТІ САМІ лейбли для КОЖНОГО `type` (enum, boolean, date). Grep обидва, порівняй гілки по-типах: пропущена гілка = мовчазна розбіжність. Sample bug (audit e4f2ed2e): `exportCell` не мав `boolean`-гілки → boolean-колонка (`isActive`/«Активна») експортувалась `String(true)`→"true"/"false" (англ.), екран через `fmtCell` давав «Так/Ні». Fix: додати відсутні type-гілки, дзеркалячи екранний форматер. Виняток — числове форматування: у файлі число лишається сирим (raw) для XLSX `ss:Type=Number`, це прийнятна різниця (значення те саме, лише без grouping/decimals), НЕ розбіжність лейблів. Grep: `grep -nE "function (export|toCsv|toXlsx)[A-Za-z]*Cell" apps/web/src` → для кожного знайти парний `fmtCell/renderCell` і звірити switch по type

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

> Формат: `дата — назва — §N` + **Сигнал / Grep / Фікс / Severity**. Grep наведено там, де це реальний детектор.

### 2026-06-19 — relation-include drift: findOne vs create/update — §13

**Сигнал:** новий scalar/relation у `findOne()` include + `toDto()`, але `create/update/addPart/updatePart` include-шейп старий → поле = `null` у POST/PATCH response. Frontend що рендерить з create/update payload одразу показує `null`. (purchase-orders: `lines.good` без `internalCode/brand`; work-orders: `parts.good` без `internalCode/sku/brand`).
**Grep:** `grep -nE "(good|supplier|vehicle|counterparty|warehouse):\s*\{\s*select:" apps/api/src/modules/X/*.service.ts | sort -t: -k3` — звірити shape findOne vs create/update.
**Фікс:** один shared `const GOOD_INCLUDE_SELECT = {...} satisfies Prisma.GoodSelect` → reuse у findOne/create/update/addPart/updatePart.
**Severity:** IMPORTANT — німа degradation (toDto `?` optional маркує), фронт показує null після POST/PATCH до refresh.

### 2026-06-19 — frontend мапер читає неіснуюче поле з DTO — §13

**Сигнал:** frontend type-cast вигадує relation (`brand: { name }`) і мапер читає `g.brand?.name ?? null`, а DTO повертає flat scalar (`brandName`). Спред `...g` пише правильний `brandName`, потім bogus мапер перетирає на `null`. TS не ловить (assertion vs runtime DTO). (GoodPickerModal — brandName завжди null).
**Grep:** `grep -rnE "apiFetch<\{[^}]*(brand|supplier|good):\s*\{" apps/web/src --include="*.tsx"` — звірити з backend toDto shape.
**Фікс:** прибрати фейковий relation з type-cast; покладатись на spread `...g`; лишити лише поля що потребують перетворення.
**Severity:** IMPORTANT — німа degradation, UI показує null для поля що backend віддає.

### 2026-05-28 — @@unique без deletedAt + create без resurrection — §5.2/§6

**Сигнал:** `@@unique([orgId, X])` де X ≠ `deletedAt`; `create()` має `findFirst({ deletedAt: null })` без resurrection.
**Фікс:** merged `findFirst` (без deletedAt) → JS-перевірка `deletedAt` → resurrect (`update`) або ConflictException.
**Severity:** IMPORTANT — HTTP 500 замість 409. (Bug #152)

### 2026-05-28 — memo() з fresh array/object prop — §3.1/§7

**Сигнал:** `memo(Component)` де батько передає inline `.filter()/.map()/{}` → нова референція кожен рендер → memo не спрацьовує.
**Фікс:** `useMemo` Map у батьку; stable empty constant замість `[]` default.
**Severity:** SUGGESTION — виправлений memo дає 50-200ms на drag/filter.

### 2026-05-28 — GET dedup + AbortSignal shared promise — §8.1

**Сигнал:** in-flight GET dedup keyed on `path` без guard `!init?.signal` → abort одного caller вбиває інших.
**Фікс:** `if (method === 'GET' && !init?.signal) { ...dedup... }`.
**Severity:** IMPORTANT — silent abort для не-aborted callers.

### 2026-05-28 — apiFetch message: string[] у всіх helpers — §8.1

**Сигнал:** fix `Array.isArray(message)` у `apiFetch`, але `apiBlobFetch`/`apiMultipartFetch` без нього.
**Фікс:** оновити всі три синхронно в одному коміті.
**Severity:** IMPORTANT — `[object Object]` або лише перший елемент при 400 validation.

### 2026-05-28 — BigInt syncVersion напряму у JSON response — §13

**Сигнал:** `findMany/findFirst` повертається напряму без `toDto()` на моделях з `syncVersion BigInt`.
**Фікс:** `rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }))` або `select` без syncVersion.
**Severity:** CRITICAL — HTTP 500 при будь-якому запиті до endpoint.

### 2026-05-28 — Prisma plural table → singular model — §13

**Сигнал:** dynamic `(prisma as any)[modelName]` де modelName наївно з snake_case plural. (Bug #127)
**Фікс:** explicit `TABLE_TO_MODEL: Record<string,string>` + `if (!model) throw` (fail-fast).
**Severity:** CRITICAL — TypeError на runtime; async `.catch()` не ловить синхронний property access.

### 2026-05-28 — closest() на data-атрибут якого бібліотека не ставить — §3.1/§8

**Сигнал:** `target.closest('[data-dnd-draggable]')` — dnd-kit `attributes` ставить лише `role/aria-*/tabindex`, НЕ `data-dnd-*`.
**Фікс:** власний стабільний маркер на корінь (`data-calendar-slot`) → один `closest()` покриває всіх дітей.
**Severity:** IMPORTANT — guard не працює, конкуруючі pointer-жести; німа degradation.

### 2026-05-28 — leave/cancel handler скидає лише частину pointer-режимів — §3.1

**Сигнал:** `onPointerLeave` коментар "cancel drawing/resize", але тіло скидає лише `drawingRef`, не `resizing/resizePreview`.
**Фікс:** скинути ВСІ режими: `if (drawing){...}; if (resizing){ setResizing(null); setResizePreview(null); }`.
**Severity:** IMPORTANT — застрягла UI-операція, фантомний preview.

### 2026-05-28 — schema.prisma enum/поле змінено без міграції — §6

**Сигнал:** diff містить зміну `schema.prisma` (нове enum-значення/поле/модель) але без папки у `migrations/`.
**Фікс:** папка `YYYYMMDDHHMMSS_<desc>/migration.sql`; enum → `ALTER TYPE "Enum" ADD VALUE IF NOT EXISTS 'X';` (окремий файл — Postgres забороняє ADD VALUE + use у одній транзакції).
**Severity:** CRITICAL — TS зелений, runtime fail; tsc мовчить.

### 2026-05-28 — UTF-8 BOM у .ts після Windows/PowerShell — §1

**Сигнал:** перші 3 байти = `ef bb bf`; diff показує `+﻿import`; неконсистентно (лише частина файлів).
**Фікс:** `tail -c +4 "$f" > tmp && mv tmp "$f"`; перевірити tsc 0 errors.
**Severity:** IMPORTANT — tsc толерує, але ламає JSON/ESM парсери, забруднює diff.

### 2026-05-29 — rgba(var(--X-rgb)) на CSS var якого немає → hardcoded fallback ігнорує тему — §1

**Сигнал:** inline `rgba(var(--color-primary-rgb, 59,130,246), a)` — `--color-primary-rgb` НЕ існує (є лише `--color-primary: hsl(...)` цілісне значення).
**Фікс:** `color-mix(in srgb, var(--color-X) ${round(a*100)}%, transparent)` — тема-aware alpha на реальному токені.
**Severity:** IMPORTANT — німа degradation: фіксований колір, зламаний dark mode/rebrand.

### 2026-05-29 — Promise.all(days.map(apiFetch)) fan-out без cap і abort — §7.2

**Сигнал:** `Promise.all(days.map(d => apiFetch(...)))` — масив з діапазону; немає cap, немає AbortController при зміні параметра.
**Фікс:** (1) `ref.current?.abort(); ref.current = ac = new AbortController();` → `{ signal }` у кожен fetch → `if (ac.signal.aborted) return`; (2) cap довжини.
**Severity:** IMPORTANT — stale-data race + перевантаження.

### 2026-05-30 — close-animation rAF без id-capture + missing unmount cleanup — §3.1

**Сигнал:** `requestAnimationFrame(() => outer.style.height='0px')` у close-branch toggle-ефекту; id не зберігається; rapid toggle лишає pending rAF.
**Фікс:** `rafRef.current = requestAnimationFrame(...)`; на старті toggle `if (rafRef.current !== null) cancelAnimationFrame(...)`; cleanup у dedicated unmount-effect.
**Severity:** IMPORTANT — visual glitch (height=0 на щойно-відкриту форму) + "setState on unmounted".

### 2026-05-30 — PATCH normalizeScope clear: всі exclusivity-сусіди однаковий null-out — §5

**Сигнал:** exclusive scope (goodId/brandId/goodCategory/goodType) у PATCH: 3 з 4 полів `normalized.X ?? null`, а 4-те `existing.X` fallback → не скидається.
**Фікс:** `<field>: normalized.<field> ?? null` для всіх exclusive; `existing.X` fallback ЛИШЕ для non-exclusive (name, priority, isActive).
**Severity:** CRITICAL — silent data corruption, порушення scope-exclusivity.

### 2026-05-30 — fire-and-forget PUT у hook без AbortController → out-of-order writes — §8.2

**Сигнал:** `apiFetch('/x', { method: 'PUT', body }).catch(() => {})` без AbortController; серверний стан гоняється (out-of-order).
**Фікс:** `abortRef.current?.abort(); ac = new AbortController(); abortRef.current = ac;` → `{ signal: ac.signal }`.
**Severity:** IMPORTANT — server-state drift; між-сесійна неузгодженість.

### 2026-05-30 — `@Param('key')` без validation — нескінченний рядок у Prisma where — §2.3

**Сигнал:** `@Param('key') key: string` (не uuid) → `prisma.X.findFirst({ where: { key } })`. ValidationPipe не валідує `@Param`.
**Фікс:** guard `ensureValidKey(key)` що кидає `BadRequestException` при `length > N` (узгоджено з MaxLength у DTO), викликається на початку handler.
**Severity:** IMPORTANT — DoS vector + log pollution; порушує defence-in-depth.

### 2026-05-30 — Soft-delete rule з child-таблицею + type-switch → «відродження» дочірніх — §5

**Сигнал:** parent з type-перемикачем має child-relation активний лише для одного типу (`tiers` для `COST_TIER`). PATCH міняє `type`, але не soft-delete-ить orphan children.
**Фікс:** `switchedAway = normalized.type !== undefined && normalized.type !== 'TYPE_X' && existing.type === 'TYPE_X';` → `tx.<child>.deleteMany` у тій же транзакції.
**Severity:** IMPORTANT — data drift при поверненні на тип.

### 2026-05-30 — rAF у persistent effect (не toggle) без id-capture — §3.1

**Сигнал:** `useEffect(() => { requestAnimationFrame(() => style.X = Y) }, [])`, id НЕ у ref → unmount під час pending rAF мутує detached DOM.
**Фікс:** `rafRef = useRef<number|null>(null)` → `rafRef.current = requestAnimationFrame(...)`; cleanup `if (rafRef.current !== null) cancelAnimationFrame(...)`.
**Severity:** IMPORTANT — "ghost" DOM mutation; ризиково для AnimatedBody/Drawer/collapse.

### 2026-05-30 — Soft-delete update без orgId у where → race-window для cross-session reuse — §2.2/§5

**Сигнал:** `findFirst({ id, orgId })` перевірка → потім `update({ where: { id } })` БЕЗ orgId у where.
**Фікс:** `updateMany({ where: { id, orgId, ...filters } })` + `findFirstOrThrow({ where: { id, orgId }, include })` для повернення relations.
**Severity:** IMPORTANT — defence-in-depth gap, race-window для multi-session writes.

### 2026-05-30 — bulk-apply loop: per-iteration `await $transaction([...])` без timeout + N+1 — §5/§6/§7.1

**Сигнал:** bulk-метод (`applyPricing/recalcAll`) робить `for (const item of children)` з `await service.calculateX()` (сам N+1) + per-iteration `$transaction([...])` (array-form default 5s timeout).
**Фікс:** prefetch pure compute перед loop (`getActiveRulesForOrg(orgId)`) → батчувати updates у ОДИН `$transaction(async tx, { timeout: N })`.
**Severity:** CRITICAL — на 50+ рядках silent default-timeout fail з частково-завершеною операцією.

### 2026-05-30 — Hook signature change → broken call-sites мовчки пройшли лінтер — §1

**Сигнал:** новий required parameter у експортованій hook (2-arg → 3-arg); tsc-кеш приховує `Expected N arguments`.
**Grep:** `grep -rn "<hookName>(" apps/web/src/app` — звірити arity кожного виклику.
**Фікс:** оновити всі call-sites в одному коміті (типово передати existing destructured value з scope).
**Severity:** IMPORTANT — runtime undefined → crash; TS ловить, але кеш приховує.

### 2026-05-30 — Buffer.buffer as ArrayBuffer ігнорує byteOffset/byteLength → читання з пулу — §2.3/§1

**Сигнал:** `library.load(buffer.buffer as ArrayBuffer)` (ExcelJS/jszip). `Buffer.allocUnsafe` (multipart uploads) — view над пулом → `.buffer` повертає весь пул.
**Grep:** `grep -rn "\.buffer as ArrayBuffer" apps/api/src` — перевірити byteOffset гарантії.
**Фікс:** helper `toArrayBuffer(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer; }`.
**Severity:** CRITICAL — silent data corruption на uploaded xlsx (лише на проді коли pool заповнений; dev часто byteOffset=0).

### 2026-05-30 — SSE/EventSource + global ThrottlerGuard → reconnect-loop вичерпує rate-limit — §2/§4

**Сигнал:** `@Sse()` endpoint + global `ThrottlerGuard` без `@SkipThrottle()`; frontend auto-reconnect + native EventSource reconnect.
**Фікс:** `@SkipThrottle()` на SSE-endpoint (опційно `@Throttle({ default: { ttl: 60_000, limit: 5 } })`).
**Severity:** IMPORTANT — degradation при network instability, потенційний DoS за NAT.

### 2026-05-30 — Constants exported but unused → orphan API surface — §1/§11

**Сигнал:** `export const MAX_QUERY_LIMIT = 1000` але `grep -rn "MAX_QUERY_LIMIT" apps/` → 0 матчів; commit обіцяв застосування.
**Фікс:** застосувати у сирітських findMany (`take: MAX_QUERY_LIMIT`) або `// TODO:` коментар; не лишати голий export.
**Severity:** SUGGESTION — orphan surface, degradation якості API.

### 2026-05-30 — Cache-Control: public на JWT-захищеному endpoint → cross-tenant витік через shared cache — §2/§2.2

**Сигнал:** `@Header('Cache-Control', 'public, max-age=N')` на endpoint з `@UseGuards(JwtAuthGuard, RolesGuard)` → proxy/CDN шарить per-tenant дані.
**Grep:** `grep -rn "Cache-Control.*public" apps/api/src/modules --include="*.controller.ts"`.
**Фікс:** `Cache-Control: private, max-age=N, stale-while-revalidate=M`.
**Severity:** CRITICAL — cross-tenant data leak при невірно налаштованому proxy.

### 2026-05-30 — IsUUID('4') у DTO ламає тести з nil-style UUID fixtures — §1/§2.3

**Сигнал:** `@IsUUID('4')` у DTO; контрактні тести використовують hex-only `00000000-0000-0000-0000-000000000099` як placeholder.
**Фікс:** `@IsUUID()` без версії (приймає v1-5), або оновити test fixtures на v4. Для `@Param` — `ParseUUIDPipe` без `version`.
**Severity:** IMPORTANT — контракт змінюється без помітних test failures; кросс-cutting через 22+ DTO.

### 2026-05-29 — event-handler fetch без request-token + stale похідний id — §8.2

**Сигнал:** `openEdit(item)/openCard/onSelect` (обробник події, НЕ useEffect) робить `apiFetch(...).then(setState)`; при повторному відкритті для іншого id стара in-flight резолвиться пізніше.
**Grep:** `grep -rnE "const (open|load|select)[A-Z]\w* = (async )?\(" apps/web/src/app --include="*.tsx"` + apiFetch у тілі.
**Фікс:** `const reqId = ++ref.current;` на старті; `if (ref.current !== reqId) return` перед кожним setState; скинути похідні id до fetch.
**Severity:** IMPORTANT — stale-data race + крос-сутнісна мутація на fetch-failure.

### 2026-05-31 — Per-item line.id-keyed onSelect sub-resource race — §8.2

**Сигнал:** `lines.map((l,i) => onSelect={async g => { setLines(...); const sub = await apiFetch(`/x/${g.id}/Y`); setLines(ls => ls.map((x,idx) => idx===i ? {...x, sub} : x)) }})` — race при швидкому переви­борі товару в рядку.
**Фікс:** capture `selectedGoodId = g.id`; скинути похідний стан одразу; після await перевірити `if (ls[idx]?.goodId !== selectedGoodId) return ls`.
**Severity:** IMPORTANT — silent UI inconsistency (UoM товару Y на товар X → невірний коефіцієнт/quantity).

### 2026-05-31 — `(line as any).X` cast для нового optional поля — §1/§13

**Сигнал:** feat додає optional поле у backend DTO + toResponseDto, але frontend interface без нього → `(line as any).unitShortName`.
**Grep:** `grep -rn "@ApiPropertyOptional() <field>?" apps/api/src` → знайти frontend interface.
**Фікс:** додати поле у frontend interface (SSOT — `hooks/api/use<Module>.ts` або `@sto/shared`); прибрати `as any`.
**Severity:** IMPORTANT — TS contract розірваний; регресує при перейменуванні поля (cast мовчить).

### 2026-05-31 — Inline lambda decorator повторений 10+ разів — §2.3/§1 DRY

**Сигнал:** `@Transform(({ value }) => value === '' ? undefined : value)` 20+ разів через grep.
**Grep:** `grep -rn "@Transform\b" apps/api/src/modules/ --include="*.dto.ts" | wc -l` → якщо > 10.
**Фікс:** `apps/api/src/common/transforms/<name>.ts` named export → `@Transform(emptyToUndefined)`; прибрати dead imports.
**Severity:** IMPORTANT — hot-reload + readability; кожна нова DTO копіює застарілу версію.

### 2026-05-31 — Видалили manual `*` припустивши що компонент додає його, а компонент кастомний — §8

**Сигнал:** `fix: прибрати ручні зірочки — Input/Select додають * через required` чіпає й inline Field/Select у файлі, які required-маркера НЕ рендерять.
**Grep:** `grep -rn "function Field\|const Field\|function Select" apps/web/src/app --include="*.tsx"`.
**Фікс:** додати `required?: boolean` у props inline-Field → `{required && <span className="ml-0.5 text-destructive">*</span>}` + `aria-required`.
**Severity:** IMPORTANT — UX regression: користувач не бачить required-маркера.

### 2026-05-31 — group-hover:\* без `group` класу на батьку → dead CSS — §1/§8

**Сигнал:** `group-hover:opacity-100` всередині батька без `group` у className → hover-зміна не з'являється.
**Grep:** `grep -rn "group-(hover|focus|active|disabled)" apps/web/src/ --include="*.tsx"` → перевірити наявність `group` на батьку.
**Фікс:** додати `group` на найближчий hover-target батько (той що має `onClick`/`cursor-*`).
**Severity:** SUGGESTION/IMPORTANT — прихована UI-підказка.

### 2026-05-31 — Controller з `@UseGuards` без `@Roles` на методах → RolesGuard no-op — §2.1

**Сигнал:** `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)`, але метод без `@Roles(...)`. `RolesGuard` повертає `true` коли `required.length === 0`.
**Grep:** `grep -B5 "@Get\|@Post\|@Patch\|@Delete" *.controller.ts | grep -v "@Roles\|@Public"`.
**Фікс:** explicit `@Roles(...)` з повним переліком або `@Public()`.
**Severity:** IMPORTANT — інваріант "RolesGuard перевіряє" порушений → майбутній field-add = silent privilege escalation.

### 2026-05-31 — Modal/Lightbox без Escape + role=dialog + aria-modal — §8 (a11y)

**Сигнал:** `<div className="fixed inset-0 z-50">` (lightbox/overlay) без `role="dialog"`, `aria-modal="true"`, `aria-label`, без Escape handler.
**Grep:** `grep -rnE "className=['\"]fixed inset-0.*z-50" apps/web/src --include="*.tsx"`.
**Severity:** IMPORTANT — недоступно клавіатурі; ARIA не озвучує "dialog opened".

### 2026-06-02 — Per-param `@Query('x')` без DTO → cap-less pagination + missing validation — §2.3/§4

**Сигнал:** `@Query('page') page = '1', @Query('limit') limit = '50'` (string defaults) + `Number(page)` у handler; немає cap на limit.
**Grep:** `grep -rn "@Query('[a-z]" apps/api/src/modules --include="*.controller.ts"`.
**Фікс:** `*QueryDto` як works/goods (`@Type(() => Number) @IsNumber() @Min(1) page = 1`, `@IsPositive() @Max(200) limit = 50`).
**Severity:** IMPORTANT — DoS вектор + inconsistency з сусідніми модулями.

### 2026-06-03 — Animation wrapper `if (!open) return null` ламає exit-анімацію Modal — §8/§3.1

**Сигнал:** обгортка (`ConfirmDialog`, custom dialog) рендерить `<Modal open={open}>` але має власний `if (!open) return null` ПЕРЕД return → unmount раніше за exit-анімацію.
**Grep:** `grep -rn "if (!open) return null" apps/web/src/components/ui --include="*.tsx"` (детектор у §8.5).
**Фікс:** прибрати `if (!open) return null` з wrapper; Modal сам обробляє visibility через useAnimatedPresence. Дорогий body → `{open && <HeavyContent/>}` всередині Modal.
**Severity:** CRITICAL — повна втрата exit-анімації; ламає useAnimatedPresence invariant.

### 2026-06-03 — Глобальний `[data-state="open"]` CSS селектор б'є по чужих data-state — §1/§8

**Сигнал:** глобальне `[data-state="open"] { animation }` у globals.css без маркера. Radix (Accordion/Dialog/Dropdown/…) використовує `data-state` як публічний контракт.
**Grep:** `grep -nE "^\[data-state=" apps/web/src/app/globals.css | grep -v "data-animate"` (детектор у §8.5).
**Фікс:** скоп-маркер `[data-animate][data-state="open"]`; direct-child `>` для backdrop.
**Severity:** IMPORTANT — catastrophic regression при додаванні будь-якої headless UI бібліотеки.

### 2026-06-02 — restore() з окремим read + non-null assertion — §5.2/§2.2

**Сигнал:** `restore(orgId, id)` робить 3 окремі DB-виклики (existence check → read → update) з non-null assertion між ними → race на concurrent hard-delete/resurrect.
**Grep:** `grep -rn "restore\(.*orgId" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** один atomic `updateMany({ where: { id, orgId, NOT: { deletedAt: null } }, data: { deletedAt: null } })` → `count === 0` → 404 → один `findFirstOrThrow` для relations.
**Severity:** CRITICAL — silent crash / data corruption на concurrent.

### 2026-06-03 — `(entity as any).newField` у toDto() — новий optional пропущено у param type — §1/§13

**Сигнал:** новий optional field доданий у DB + `create()`, але НЕ у типізованому параметрі `toDto` → `(entity as any).documentDate`.
**Grep:** `grep -rn "as any)\.[a-z]" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** додати `newField?: Type | null` у structural param type toDto → замінити cast на `entity.newField`.
**Severity:** IMPORTANT — TS contract порушений; IDE refactor не знаходить usages.

### 2026-06-03 — `new Date().toISOString().slice(0,10)` для local date в Kyiv — UTC vs local — §7.2/§8.3

**Сигнал:** `new Date().toISOString().slice(0, 10)` у render/useState як default дата → UTC, а не Kyiv.
**Grep:** `grep -rn "toISOString().slice(0, 10)" apps/web/src/app --include="*.tsx"`.
**Фікс:** `const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }); const kyivToday = () => KYIV_YMD.format(new Date());`.
**Severity:** IMPORTANT — між midnight і 2-3 AM фільтр "сьогодні" показує вчора.

### 2026-06-09 — Anchored popup useLayoutEffect deps `[anchorRef]` → stale position on re-open — §3.1/§8

**Сигнал:** попап читає `anchorRef.current.getBoundingClientRect()` у `useLayoutEffect(..., [anchorRef])`. `anchorRef` — стабільний, deps не тригерять реколк при новому anchor.
**Grep:** `grep -rnE "useLayoutEffect\(.*\}, \[anchorRef\]\)" apps/web/src/components/ui --include="*.tsx"` (детектор у §3.1).
**Фікс:** додати payload у deps (`preview`/`item`/`data`): `useLayoutEffect(..., [anchorRef, preview])`.
**Severity:** IMPORTANT — попап вирівнюється до неправильного рядка.

### 2026-06-09 — Nested overlay Esc handler → закриває весь вкладений ланцюг (parent Modal теж) — §3.1/§8 (a11y)

**Сигнал:** вкладений overlay додає `document.addEventListener('keydown', h)` у bubble-фазі для Esc; батьківський Modal теж слухає Esc → обидва закриваються.
**Grep:** `grep -rnE "document\.addEventListener\(['\"]keydown" apps/web/src/components/ui` (детектор у §3.1).
**Фікс:** handler у capture phase + `stopImmediatePropagation()`.
**Severity:** IMPORTANT — користувач втрачає незбережені зміни parent-modal; порушує "Esc closes ONLY topmost".

### 2026-06-12 — Naive `updateMany` на parent+continuation children колапсує split-day інтервал — §5/§6

**Сигнал:** cascade-update (`syncWorkOrderSlots`) робить `updateMany({ where: { parentRefId }, data: { startAt, endAt } })` без розрізнення parent vs continuation. `CalendarSlot.parentSlotId` розбиває split-day slot → updateMany колапсує обидва на однаковий interval.
**Grep:** `grep -rn "updateMany.*workOrderId\|updateMany.*parentSlotId" apps/api/src/modules/calendar`.
**Фікс:** `$transaction({ timeout })`: (1) soft-delete continuation (`parentSlotId: { not: null }`) → (2) update лише parent (`parentSlotId: null`); + `endAt > startAt` guard.
**Severity:** CRITICAL — silent data corruption на WO зі split-day slot (наряд ввечері → наступний день).

### 2026-06-12 — Ad-hoc `<div className="fixed inset-0 z-[N]">` confirm замість useConfirm — §8/§8.5 (a11y)

**Сигнал:** inline `{pending && <div className="fixed inset-0 z-[70]">…<Button>Так/Ні</Button></div>}` у файлі що вже імпортує `useConfirm`+`ConfirmDialog`. Немає `role="dialog"`, aria, Escape, focus trap, exit-animation.
**Grep:** `grep -rnE "fixed inset-0.*z-\[?[0-9]+" apps/web/src --include="*.tsx"` → якщо у файлі є `useConfirm` import → заміна.
**Фікс:** `const ok = await confirm({ title, message }); if (ok) { ... }`.
**Severity:** IMPORTANT — порушує a11y + useAnimatedPresence.

### 2026-06-14 — Boundary-константа змінена, але jsdoc/inline comments посилаються на старе значення — §1/§8

**Сигнал:** fix замінив magic number на const (`19*60` → `WINDOW_END*60`, `WINDOW_END=20`), але 3+ jsdoc/inline коментарі у файлі досі з СТАРИМ значенням. Рекурентно: `fef027b0` (calendar.service), `02e16389` (CalendarSlotModal 3 stale comments).
**Grep:** після `(\d+) * 60 → CONST * 60` fix → `grep -rn "<old_number>\|<old_HHmm>" <file>`; звірити з backend const (`grep -rn "WORK_DAY_END_H" apps/api/src`) — frontend і backend const мають збігатися.
**Фікс:** масово оновити коментарі; замінити сирі числа на ім'я константи.
**Severity:** IMPORTANT — майбутній regression коли розробник "виправить" правильний код за коментом.

### 2026-06-14 — Нова `<col>` у `<colgroup>` без інкременту `tfoot colSpan` → totals у неправильній колонці — §8/§8.6

**Сигнал:** feat додає колонку (`<col>` + `<th>` + `<td>` у всіх modes), але `<tfoot>` лишив старий `colSpan`. Layout зсувається → totals не у своїх комірках. Empty-state colSpan оновлюють (видно), а tfoot пропускають.
**Grep:** `grep -n "colSpan" <modal>.tsx` — формула: `colSpan + (cells після нього у row) === count(<col>)`. Детектор у §8.6 (git diff `+<col>`).
**Фікс:** інкрементнути ВСІ `colSpan` у `<tfoot>` + `<tbody>` empty-state row до count(`<col>`).
**Severity:** CRITICAL — visible layout bug при додаванні parts.

### 2026-06-14 — Bulk lookup без UUID-validation на `@Query('ids')` → 500 замість 400 — §2.3

**Сигнал:** `@Query('ids') ids: string` → `ids.split(',')` → `findMany({ where: { goodId: { in } } })`. Postgres `@db.Uuid` відхиляє non-UUID → 500 non-i18n. `ParseUUIDPipe` не працює на split-out items.
**Grep:** `grep -rnE "@Query\('ids'\)" apps/api/src/modules --include="*.controller.ts"`.
**Фікс:** `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;` → після split `const invalid = ids.find(id => !UUID_RE.test(id)); if (invalid) throw BadRequestException`. `ids?: string` (optional).
**Severity:** IMPORTANT — 500 замість 400; Prisma error у Sentry.

### 2026-06-14 — `apiFetch().catch(() => {})` у новому useEffect — silent stale-data race — §3.1/§8.2

**Сигнал:** `void apiFetch<T[]>('/x/bulk?ids=...').then(rows => setState(new Map(...))).catch(() => {})` без `cancelled` flag; Map лише з повернених рядків → `map.get(id)` undefined → `'—'` замість `0`.
**Grep:** `grep -rnE "useEffect\(\(\) => \{" apps/web/src/components/ui --include="*.tsx" -A20` + apiFetch + `.then(setState)`.
**Фікс:** `let cancelled = false; ...then(rows => { if (cancelled) return; const next = new Map(ids.map(id => [id, 0])); for (const r of rows) next.set(r.id, r.value); setState(next); }).catch(err => { if (cancelled) return; console.error(...) }); return () => { cancelled = true };`. Pre-init з `0`.
**Severity:** IMPORTANT — race + silent server-error blackout + UX edge (`'—'` замість `0`).

### 2026-06-05 — Partial `setPage(1)→resetPage()` migration: inline JSX handlers пропущено — §8.2/§8.6

**Сигнал:** `useListPage` експортує `setPage` і `resetPage`; `applyFilter` мігровано на `resetPage()`, а 5 inline handlers досі `setPage(1)`.
**Grep:** детектор у §8.6 (`useListPage<` файли з обома `setPage(1)` + `resetPage()`).
**Фікс:** inline handlers → `resetPage()`; `setPage` лишити (потрібен для `<Pagination onChange={setPage}>`).
**Severity:** SUGGESTION — DRY inconsistency; ризик regression якщо resetPage отримає side-effect.

### 2026-06-15 — Новий enum-value не підхоплений жорстко-закодованим масивом на фронті — §8

**Сигнал:** backend додає enum value + оновлює `*_LABELS` у `@sto/shared`, але фронт-таби з локального хардкоду (`['', 'WRITEOFF', 'TRANSFER', 'OPENING_BALANCE']` — RECEIPT відсутній).
**Grep:** `grep -rnE "'WRITEOFF',\s*'TRANSFER',\s*'OPENING_BALANCE'" apps/web/src/`; `grep -rn "STOCK_DOC_TYPE_LABELS\|WO_STATUS_LABELS" apps/web/src --include="*.tsx"`.
**Фікс:** `['', ...Object.keys(STOCK_DOC_TYPE_LABELS)]` — майбутні значення автоматично.
**Severity:** CRITICAL — фіча відвантажена, але не доступна в UI; TS green (не повний union не ловиться).

### 2026-06-15 — Tab buttons з `focus:outline-none` без `focus-visible:*` заміни — §8.5/§1

**Сигнал:** кастомний `<button>` (tab-bar) додає `focus:outline-none` без `focus-visible:ring-*`. Keyboard-only юзер не бачить focus. WCAG 2.1.1/2.4.7.
**Grep:** `grep -rnE "focus:outline-none" apps/web/src/app --include="*.tsx" | grep -v "focus-visible:\|focus:ring-"`.
**Фікс:** `focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm`.
**Severity:** IMPORTANT — WCAG fail; keyboard-only не орієнтується.

### 2026-06-15 — `router.replace(url)` без `{ scroll: false }` для URL sync — §8

**Сигнал:** `router.replace(`?${params.toString()}`)` без опцій. Next App Router скролить до top навіть при cosmetic query-update.
**Grep:** `grep -rnE "router\.(replace|push)\(" apps/web/src/app --include="*.tsx" | grep -v "scroll:\s*false"`.
**Фікс:** `router.replace(..., { scroll: false })` для filter/tab sync (реальна навігація — scroll-to-top нормальний).
**Severity:** IMPORTANT — UX: втрата scroll-контексту.

### 2026-06-16 — blob-download без `appendChild`/`removeChild` + immediate `URL.revokeObjectURL` — §1/§8

**Сигнал:** `URL.createObjectURL(blob)` → `a.click()` → одразу `revokeObjectURL` без setTimeout і без appendChild/removeChild. Firefox/Safari не диспатчать click на detached anchor; Chromium дропає download. (Bug #77/#341 покрив перші handler-и, третій додано окремо).
**Grep:** `grep -rnE "URL\.revokeObjectURL" apps/web/src/ -B5`; `grep -rnE "document\.createElement\(['\"]a['\"]\)" apps/web/src/ -A8 | grep -v "appendChild\|removeChild"`.
**Фікс:** `document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 100);`. Filename — human-readable (`invoice-${invoiceNumber}.pdf`, не UUID).
**Severity:** CRITICAL/IMPORTANT — тиха відмова download.

### 2026-06-16 — Hardcoded status labels поряд із готовим shared `*_STATUS_LABELS` — §8/§1 DRY

**Сигнал:** status badge через 5-гілковий ternary з рядковими літералами, хоча `@sto/shared` вже експортує `INVOICE_STATUS_LABELS`/`WO_STATUS_LABELS`. Risk: divergence (`'Відправлено'` vs shared `'Надіслано'`).
**Grep:** `grep -rnE "status === ['\"]DRAFT['\"]\s*\?\s*['\"][А-Яа-я]" apps/web/src/app --include="*.tsx"`; `grep -n "_STATUS_LABELS" packages/shared/src/constants/statuses.ts`.
**Фікс:** `import { INVOICE_STATUS_LABELS } from '@sto/shared'` → `{LABELS[status] ?? status}`.
**Severity:** IMPORTANT — divergence UA-назв між сторінками; порушує SSOT.

### 2026-06-16 — Backend/frontend `status: string` замість literal union — §13/§1

**Сигнал:** lightweight endpoint повертає `status: string` у explicit return type (Prisma select дає enum, але explicit type губить union). Frontend дзеркалить → `status === 'DRAF'` typo не ловиться.
**Grep:** `grep -rnE "status:\s*string" apps/api/src/modules --include="*.service.ts"`; те саме у `apps/web/src/app --include="*.tsx"`.
**Фікс:** `import { InvoiceStatus } from '@prisma/client'` (backend) / `@sto/shared` (frontend) → `status: InvoiceStatus`.
**Severity:** IMPORTANT — typo-magnet, lost type-safety на UI guards.

### 2026-06-15 — Dead code після onClick refactor: orphan `selectX/toggleSelectX` — §8/§1

**Сигнал:** пара `selectDoc`+`toggleSelectDoc` для DetailPanel; onClick змінено на `setEditingDocId(doc.id)`, але функції лишились orphan → `selectedDoc` завжди null → panel порожній. TS green.
**Grep:** `grep -rnE "const (select|toggle)[A-Z][A-Za-z]+ = useCallback" apps/web/src/app --include="*.tsx" -A1` → для кожної `grep -n "<fn>(" <file>`; якщо лише декларація → dead.
**Фікс:** видалити мертві функції; або додати окремий `onSelect` handler якщо DetailPanel потрібен.
**Severity:** IMPORTANT — broken feature без TS/runtime error; dead code = шум.

### 2026-06-17 — Aggregate-level field (recalcTotals) не пропагований у downstream per-line values — §5/§13

**Сигнал:** parent-агрегат рахується новою формулою (`SUM((actualHours ?? normoHours) × price)`), але стара `line.amount` зберігає планові (`normoHours × price`). Downstream (PDF/Excel/completion-act/refreshFromWorkOrder) пайпить `line.amount` напряму → `5 год × 100 = 300`, `SUM(line) ≠ parent.total`.
**Grep:** `grep -rn "l\.amount\|line\.amount\|Number(l\.amount)" apps/api/src/modules --include="*.ts"`; `grep -rn "wo\.lines\.map\|buildLines" apps/api/src/modules`.
**Фікс:** total з displayed quantity: `const quantity = l.actualHours ?? l.normoHours; const total = quantity * Number(l.price);` (single-source). У refreshFromWorkOrder/buildLines — додати `actualHours: true` у `lines.select`. Дзеркалити у всіх downstream.
**Severity:** CRITICAL — документ з арифметикою що не сходиться; юридично неправильний.

### 2026-06-17 — Нове `costPrice`/`purchasePrice` у nested DTO без role gate — §2.1

**Сигнал:** feat додає `costPrice/purchasePrice/margin/batchCostPrice` у nested DTO (`WorkOrderPartResponseDto`), а parent endpoint дозволяє `MECHANIC/RECEPTIONIST`. `toPartDto` мапить безумовно → field-level leak (RolesGuard на endpoint пропускає).
**Grep:** `grep -rnE "(costPrice|purchasePrice|margin|batchCostPrice)\??:" apps/api/src/modules --include="*.dto.ts"`; `grep -rn "canSeeCostPrice\|COST_PRICE_VISIBLE_ROLES" apps/api/src/modules`.
**Фікс:** `const COST_PRICE_VISIBLE_ROLES = new Set(['OWNER','ADMIN','STOREKEEPER','ACCOUNTANT']); const canSeeCostPrice = r => !!r && COST_PRICE_VISIBLE_ROLES.has(r);` → `toPartDto(part, userRole)` → `costPrice: canSeeCostPrice(userRole) ? Number(...) : undefined`. Internal callers fail-closed.
**Severity:** CRITICAL — financial data leak до MECHANIC/RECEPTIONIST; tsc + ручний тест мовчать.

### 2026-06-17 — Column alignment inconsistency: новий `<td>` `text-center` при `text-left` братів — §8.6

**Сигнал:** нова колонка у 3 modes (view/edit/new-input) — view/edit `text-left`, new-input `text-center` (для самотнього `—`).
**Grep:** `grep -rnE "px-2 py-1.5 text-(left|center|right)" apps/web/src/components/ui --include="*.tsx"`.
**Фікс:** уніфікувати з view-mode alignment (header задає істину).
**Severity:** SUGGESTION — UX inconsistency.

### 2026-06-17 — Frontend apiFetch до неіснуючого endpoint + silent `.catch(()=>{})` — §8.1/§8.2

**Сигнал:** UI-секція (VAT row) залежить від `apiFetch<{...}>('/X/Y')` де `/X/Y` НЕ існує у backend; робочий патерн того ж призначення поруч (`/settings/organisation`). Silent `.catch(() => {})` ховає що setVatMode ніколи не викликається → UI-блок тихо не рендериться.
**Grep:** цикл-детектор MISSING-endpoint (див. нижче); `grep -rnE "\.catch\(\(\) => \{\}\)" apps/web/src/`.
**Фікс:** реюзнути робочий URL; `.catch(err => console.error('[Component] X failed', err))`; explicit resolve через дод. endpoint якщо shape різниться (`defaultVatRate` vs `defaultVatRateId`).
**Severity:** CRITICAL — silent UI dead code; feature-flag drift.

### 2026-06-17 — Aggregation report без status-фільтра → юридично неправильний звіт ПДВ/виручки — §5/§13

**Сигнал:** tax-aware aggregate (`vatReport/revenueReport`) без `status: { in: [...] }` → включає DRAFT/CANCELLED → завищене ПДВ-зобов'язання.
**Grep:** `grep -rnE "\.aggregate\(\{" apps/api/src/modules/reports --include="*.service.ts" -A10 | grep -B5 "_sum\|_count" | grep -v "status:"`; per-model loop для Invoice/PurchaseOrder/WorkOrder/StockDocument.
**Фікс:** `status: { in: [...] }` за бізнес-правилами:

- Sales VAT (Invoice): `SENT, PAID, OVERDUE`
- Purchase VAT credit (PurchaseOrder): `PARTIAL, RECEIVED`
- Revenue (WorkOrder): `COMPLETED, INVOICED, PAID, ARCHIVED`
- Inventory (StockDocument): `CONFIRMED`

Документувати inline _чому саме ці статуси_.
**Severity:** CRITICAL — financial/regulatory compliance bug.

### 2026-09-02 — Sentinel empty-string у UUID FK колонку → runtime "invalid input syntax for type uuid" — §5/§6

**Сигнал:** сервіс повертає sentinel `''` у полі-ідентифікаторі (`consumeBatch(AVG_COST)` → `[{batchId: ''}]` = "агрегат по кількох партіях"). Викликач пише `''` у `batchId String? @db.Uuid` → Postgres `invalid input syntax for type uuid: ""` → FSM COMPLETED/CONFIRMED падає лише на org з AVG_COST. Тест з real-UUID мока не reproduce.
**Grep:** `grep -rnE "consumed\[0\]\.batchId|allocations\[0\]\.[a-zA-Z]+Id|results?\[0\]\.[a-zA-Z]+Id" apps/api/src/modules --include="*.ts"` (детектор у §5) — перевірити чи sentinel-повертайка дає `''` + чи колонка `@db.Uuid`.
**Фікс:** truthy-guard `consumed[0].batchId ? consumed[0].batchId : null` (порожній рядок falsy, UUID truthy). Або explicit `null` у sentinel. Regression-spec: mock `[{batchId: ''}]` → assert `data: { batchId: null }`.
**Severity:** CRITICAL — runtime blocker на всіх org з AVG_COST; TS зелений, unit з real UUID пропускають.

### 2026-06-17 — `vatMode: string` у service return → cast `as 'NONE' | ...` у консумерах — §1/§13

**Сигнал:** service повертає `Promise<{ vatMode: string }>` замість Prisma enum (`VatMode`) → кожен консумер робить `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'`.
**Grep:** `grep -rnE "Promise<\{[^}]*: string[;,]" apps/api/src/modules --include="*.service.ts"`; `grep -rnE "as ['\"][A-Z_]+['\"] \| ['\"][A-Z_]+['\"]" apps/api/src`.
**Фікс:** `import { VatMode } from '@prisma/client'` → `Promise<{ vatMode: VatMode }>` → видалити всі `as` касти.
**Severity:** IMPORTANT — DRY-загроза; будь-яка зміна enum ламає тихо.

### 2026-06-17 — Prisma `_sum.X` з ugly `(agg._sum as { X?: unknown })` cast — §1

**Сигнал:** `(agg._sum as { totalVat?: unknown }).totalVat ?? 0`. Prisma вже генерує precise `XSumAggregateOutputType` — direct `agg._sum.totalVat` працює.
**Grep:** `grep -rnE "_sum as \{|_count as \{|_avg as \{|_min as \{|_max as \{" apps/api/src --include="*.ts"`.
**Фікс:** прибрати cast; при потребі `pnpm prisma generate`.
**Severity:** SUGGESTION — TS guard слабшає, cargo cult.

### 2026-09-02 — `role="button"` без `tabIndex={0}` + `onKeyDown` (Enter/Space) → keyboard-broken drill-down — §8/§14 a11y

**Сигнал:** drill-down UI (клітинка шахматки, `<tr onClick>`, dashboard-плитка) додає `role="button"` + `cursor-pointer`, але забуває `tabIndex={0}` + `onKeyDown`. Keyboard-only юзер не активує. WCAG 2.1.1. Еталон — `inline-edit-cell.tsx`. (Знайдено у SupplierPaymentScheduleTab.tsx).
**Grep:**

```bash
grep -rnE "role=['\"]button['\"]" apps/web/src/ --include="*.tsx" -B2 -A5 | grep -v "onKeyDown\|tabIndex\|inline-edit-cell\|<button"
grep -rnE "<tr[^>]*onClick=" apps/web/src/ --include="*.tsx" -A3 | grep -v "onKeyDown\|role=\|tabIndex"
grep -rnE "cursor-pointer" apps/web/src/ --include="*.tsx" -B3 -A3 | grep -B3 -A3 "onClick" | grep -v "role=\"button\"\|<button\|tabIndex"
```

**Фікс:** module-level `function activateOnKey(onClick) { return e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }; }` → `role="button" tabIndex={0} onKeyDown={activateOnKey(handler)}` + `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`. Для `<tr>` — `aria-label="Відкрити X"`. Опціональний handler → всі 3 атрибути conditional (`clickable ? 0 : undefined`).
**Severity:** IMPORTANT — WCAG fail; latent regression у кожній новій heatmap/шахматка UI.

### 2026-09-06 — getLinkedCounts рахує FK-наявність, detail фільтрує deletedAt:null → count!=detail — §6/§13

**Сигнал:** новий `getLinkedCounts(orgId, ids)` рахує пов'язані сутності за самою наявністю FK (`X.purchaseOrderId ? 1 : 0`, обов'язковий FK → `1`), тоді як парний `getLinkedDocuments` робить `findFirst({ deletedAt: null })` і повертає `[]` коли реф soft-deleted. FK `ON DELETE SET NULL` спрацьовує ЛИШЕ при hard-delete → soft-delete лишає FK вказувати на мертвий рядок → badge показує «1», панель порожня (Bug #A/#641 count!=detail). Канонічний патерн у `invoices.getLinkedCounts` (коментар «Bug #A») уже це кодифікує; нові модулі (stock-documents/supplier-returns) його пропускали.
**Grep:** `grep -rn "getLinkedCounts" apps/api/src/modules --include="*.service.ts"` → для кожного: чи є `findMany` живих реф-id (PO/warehouse/counterparty) + `Set`-membership перед інкрементом, чи безумовне `? 1 : 0` / `= 1`. Обов'язковий FK (`warehouseId`/`supplierId`) ≠ живий → теж gate через liveness.
**Фікс:** зібрати унікальні реф-id → `findMany({ where: { id: { in: [...] }, orgId, deletedAt: null }, select: { id: true } })` → `new Set(...)` → `refId && liveSet.has(refId) ? 1 : 0` (дзеркалить invoices). +spec: soft-deleted реф → count=0.
**Severity:** IMPORTANT — badge/панель розсинхрон; німа degradation (лише коли реф soft-deleted поки документ на нього посилається).

### 2026-09-06 — queue.add() ПІСЛЯ закоміченої tx без .catch() → 500 на успішній операції + stuck QUEUED — §2.5/§10

**Сигнал:** доменна/фінансова операція комітиться у `$transaction` (Payment+settlement+FSM), сутність отримує статус `QUEUED`/pending ВСЕРЕДИНІ tx, а enqueue робочого job-а йде голим `await this.Xqueue.add(...)` ПІСЛЯ commit — без `.catch()`. При Redis-down (нормальний offline-стан) `.add()` кидає → HTTP 500 повертається клієнту попри те що гроші/статус вже закомічені, І сутність зависає у `QUEUED` навічно (жодного job-а не поставлено → processor ніколи не переведе у DONE/FAILED). Сусідні enqueue у тому ж методі (`loyalty.queueEarn`, `notifications.send`) вже non-blocking через `.catch()` — новий enqueue пропустив цю конвенцію. (ПРРО Крок 1: `checkboxQueue.add` для фіскального чеку.)
**Grep:** `grep -rnE "await this\.[a-zA-Z]+[Qq]ueue\.add\(" apps/api/src/modules --include="*.service.ts"` → для кожного перевірити чи виклик у ланцюгу `.catch(...)`; якщо enqueue ПІСЛЯ `$transaction` і голий — прапор.
**Фікс:** `.catch(async err => { logger.warn('enqueue failed: ...'); await this.prisma.entity.update({ where: { id, orgId }, data: { status: TERMINAL_FAILED, error: 'Черга недоступна' } }).catch(() => undefined) })` — знімає stuck-статус + не валить успішну операцію. Плюс `removeOnFail: N` у опціях (bounded retention). Дзеркалить offline-first інваріант (CLAUDE.md §3).
**Severity:** IMPORTANT — offline-first порушення (система стоїть без Redis) + lifecycle hole (навічно QUEUED); TS зелений, видно лише при Redis-down.

### 2026-09-06 — error-swallowing wrapper резолвиться → caller показує хибний success — §8.2

**Сигнал:** shared-мутатор (`patchChannel`/`saveX`) має внутрішній `try/catch`, що `setError`+`toast.error` і **резолвиться** (не re-throw). Caller (`saveCreds`/submit-handler) робить `await wrapper(...)` у власному `try` → після await беззастережно `toast.success('Збережено')` + `closeModal()`. Оскільки wrapper проковтнув помилку й не кинув, caller завжди думає що успіх → toast «збережено» + модалка закрита навіть коли PATCH впав (і поруч ще один error-toast). Аналогічно ланцюг залежних мутацій (priority-swap: два послідовні PATCH) виконує 2-й крок навіть коли 1-й впав → часткова неконсистентність.
**Grep:**

```bash
# wrapper з внутрішнім catch що НЕ кидає + caller з success-toast після await
grep -rnE "const (patch|save|update|toggle)[A-Za-z]* = (async )?\(" apps/web/src/app --include="*.tsx" -A25 \
  | grep -E "catch|toast\.success|return true|return false" | head -30
```

**Фікс:** wrapper повертає `boolean` (`return true`/`return false` у catch); caller гейтить `const ok = await wrapper(...); if (!ok) return;` перед success-toast/close. Ланцюг залежних мутацій — 2-й крок лише `if (ok)`; додати in-flight guard (`movingId`) проти конкурентних запусків.
**Severity:** IMPORTANT — хибний UX-сигнал (juser думає що збережено) + часткова неконсистентність у dependent-write ланцюгах.

### 2026-09-06 — provider-агностичне «template-id» поле → inline-канал шле ПОРОЖНІЙ текст — §5/§13

**Сигнал:** нове опц. поле-джерело-контенту (`externalTemplateId`) зберігається per-config незалежно від провайдера, а resolve-фільтр зараховує канал придатним за самою наявністю поля: `filter(c => hasLocalTemplate(c) || c.externalTemplateId)`. Але поле консумить лише ЧАСТИНА провайдерів/каналів (eSputnik Viber/Telegram через smartsend); inline-провайдер (SMS усіх, TurboSMS Viber) ігнорує його й шле `message` — який для external-template каналу = `''` (renderTemplate('')). Результат: `sendsms {text:''}` / `viber {text:''}` — мовчазна порожня відправка. Прямий API-виклик в обхід UI записує template-id на inline-канал.
**Grep:** `grep -rnE "\|\|\s*c\.(externalTemplateId|templateId|externalId)" apps/api/src/modules --include="*.service.ts"` — фільтр придатності що OR-иться на опц. поле без перевірки провайдера. Плюс: чи `templateBody: ... ?? ''` подається inline-провайдеру.
**Фікс (3 шари):** (1) провайдер декларує які канали template-based — `readonly templateChannels?: NotificationChannel[]` (SSOT, віддається у `registry.list()` для UI); (2) upsert примусово `field = isTemplateChannel ? dto.field ?? null : null` (defence-in-depth проти прямого API); (3) resolve-фільтр: канал без локального шаблону придатний лише якщо `registry.get(provider)?.templateChannels?.includes(channel)`. Frontend derive `needsX` з `provider.templateChannels`, не хардкод-Set. +регрес: inline-канал зі stray-template-id → канал ВИКЛЮЧЕНО / поле=null.
**Severity:** IMPORTANT — мовчазна порожня відправка на mis-config; TS зелений (поле опційне у всіх шарах).

### 2026-09-06 — exclusivity-action + сусідній per-item toggle що мовчки ламає інваріант — §8.2/§5

**Сигнал:** нова дія встановлює «ексклюзивно лише один X активний» (activate-provider, set-default-account, pin-single) через bulk-mutation (`updateMany others=false, updateMany chosen=true` / `$transaction`), АЛЕ у тому ж UI лишається старий per-item toggle (`Switch`/checkbox) що редагує те саме поле (`enabled`/`isDefault`) на БУДЬ-ЯКОМУ елементі. Юзер вмикає item іншої групи → інваріант «лише один» тихо порушено. Downstream-споживач (`resolveConfig` фільтрує `enabled:true` по ВСІХ) бере два → подвійна/невизначена поведінка. TS зелений (поле легітимне boolean).
**Grep:**

```bash
# activate/setDefault/setPrimary поруч із per-item enabled/isDefault toggle у тому ж файлі
grep -rlE "activate[A-Z]|setDefault|setPrimary|isExclusive|updateMany.*enabled" apps/web/src/app --include="*.tsx" \
  | xargs grep -lE "toggle[A-Z]|onChange.*enabled|checked=\{" 2>/dev/null
# derived «активний» через find(first-match) — маскує другий активний елемент
grep -rnE "= [a-zA-Z]+\.find\(c? => c?\.(enabled|isDefault|active)\)\??\.[a-zA-Z]+ \?\? null" apps/web/src --include="*.tsx"
```

**Фікс:** per-item toggle гейтить інваріант — увімкнути item можна лише якщо він у активній групі (`if (enable && item.group !== activeGroup) { setError(...); return; }`); toggle неактивної групи `disabled`. Вимкнути item активної групи (звузити) — дозволено. Активація іншої групи — лише через exclusivity-action. Empty-state guard на самій exclusivity-action: якщо група не має жодного item → bulk-mutation матчить 0 рядків = no-op + хибний success-toast → перевірити `items.some(i => i.group === chosen)` перед викликом.
**Severity:** IMPORTANT — тихе порушення інваріанта; downstream бере два «ексклюзивні» → неоднозначна поведінка; UX хибний success на no-op.

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
