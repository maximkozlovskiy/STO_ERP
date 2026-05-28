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

# Scope (AUTO: тільки змінені файли; FULL: весь проєкт)
git diff HEAD --name-only | head -30
cat MemoryManual.md | head -50
```

TS або unit червоні → зафіксуй як Bug #0, виправ ПЕРШИМ.

**AUTO: матриця що перевіряти за типом зміни**

| Тип зміни | Секції Кроку 1 |
|---|---|
| Новий `@Controller` / endpoint | §1.1 (tenant, soft delete), §1.2 (TS, API contract), §1.5 (contract spec) |
| Змінений `*.service.ts` | §1.1 (business logic, FSM, inventory, settlements) |
| Нова `page.tsx` / зміна UI | §1.3 (frontend стани, hydration, routing) |
| Новий `*.dto.ts` | §1.2 (validation guards, @IsUUID версія) |
| `prisma/schema.prisma` | §1.1 (soft delete fields, orgId), §1.2 (TS) |
| `components/ui/` only | §1.3 (стани), §1.6 (a11y) |
| Config / docs / тести | §0 (tsc) — більше нічого |

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
```

- [ ] Кожен `findFirst` / `findMany` / `update` містить `orgId` у `where`

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
```
- [ ] FEFO: `[{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]`
- [ ] `PERCENT` = `cost * (1 + pct/100)`; `FIXED_AMOUNT` = `cost + delta`; `FIXED_PRICE` fallback = `fixedPrice ?? costPrice`
- [ ] Округлення = `Math.round(result / r) * r`; захист від від'ємної ціни = `Math.max(0, result)`
- [ ] `recalcTotals`: `Number(l.amount)` cast (Decimal без cast → рядкова конкатенація)
- [ ] Batch loop: `Math.min(remaining, batch.remainingQty)`; якщо `remaining > 0` після циклу → `BadRequestException`

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

---

### §1.2 — TypeScript / API якість

```bash
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
```

- [ ] Немає `any` (крім `as unknown as T`)
- [ ] `toResponseDto()` — жоден Prisma model не повертається напряму
- [ ] `syncVersion: Number(row.syncVersion)` у всіх DTO (Decimal/BigInt → Number)
- [ ] `@Param(':id')` → `ParseUUIDPipe`
- [ ] `throw new XxxException('...')` — повідомлення українською
- [ ] `@IsUUID()` без версії ('all') відхиляє nil-UUID → у **тестах** для UUID-полів: `11111111-1111-4111-8111-111111111111` (v4 layout)

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
```

- [ ] Кожен list-fetch в `useEffect` має: `let cancelled=false` + `return () => {cancelled=true}`; `setLoading(true)` перед; `.finally(() => !cancelled && setLoading(false))`; `.catch((e) => !cancelled && setError(...))`; у JSX `{loading && <Spinner/>}` + `{!loading && items.length===0 && <Empty/>}`
- [ ] `new Date()` у render path → `useState<Date|null>(null)` + `useEffect(() => setToday(new Date()), [])`
- [ ] `key={i}` у списках де можлива re-order/filter → `key={item.id}` або stable derived key
- [ ] PUBLIC_ROUTES (`/booking`, `/setup`, `/login`, `/403`) → `publicFetch`, не `apiFetch`
- [ ] `import type { ReactNode, ChangeEvent, MouseEvent } from 'react'` (не `React.ReactNode`)
- [ ] `setTimeout` / `setInterval` у `useEffect` → `clearTimeout` / `clearInterval` у cleanup
- [ ] Timeline/gantt drag/resize: кожен px→decimal-hours converter clamp-ить результат у `[WINDOW_START, WINDOW_END]` ПЕРЕД побудовою `new Date(...).toISOString()` (інакше `endH>maxHour`/`startH<0` → `"24:30"`/`"-1:00"` → Invalid Date → RangeError у `toISOString()` → handler мовчки падає). Resize-гілка ОКРЕМО від draw-гілки — draw зазвичай clamp-ить через `pxToDecimalHours`, resize рахує delta і clamp-ить тільки проти протилежного краю

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
```

**Стала spec після рефактору сервісу (Bug #153-#155):**
- [ ] Кожен `private readonly X: Type` у конструкторі сервісу → є `{ provide: Type, useValue: mock }` у `Test.createTestingModule({ providers })` спеки (інакше NestJS DI fail на всіх тестах файлу)
- [ ] Кеш-мок: `CacheService.get` → `mockResolvedValue(null)` (cache miss → fallthrough на БД); `set/del/delPattern` → no-op
- [ ] Якщо `service.create()/update()` спрощено з N `findFirst` до 1 (single round-trip resurrection/dup-check) → spec мокає `findFirst` РІВНО стільки разів скільки реальних викликів (не успадкований `mockResolvedValueOnce(null).mockResolvedValueOnce(...)`)

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

- [ ] Нові `*.service.ts` → парний `*.spec.ts` з мінімальними кейсами вище
- [ ] Нові `@Controller` → парний `*.contract.spec.ts`

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

- [ ] `Button`, `Select`, `Modal`, `Input`, `EmptyState` — component тести існують
- [ ] `smoke.spec.ts` — обов'язковий: `/`, `/login`, `/setup` без auth, auth redirect

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

| Модуль | Інваріанти |
|---|---|
| `work-orders.fsm` | всі пари (from, to) → blocked; ARCHIVED/CANCELLED = порожні |
| `inventory` | quantity≥0, reserved≥0, available≥0 після валідних рухів |
| `settlements` | CHARGE ↑balance; PAYMENT/REFUND/CREDIT_NOTE ↓balance |
| `pricing` | PERCENT = `cost*(1+pct/100)`; округлення кратне roundTo; `Math.max(0,result)` |

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
TypeScript:      ✅ 0 errors
Unit+Contract:   ✅ N/N passed
Property-based:  ✅ N passed  (або ⏭ fast-check не встановлений)
Components:      ✅ N passed  (або ⏭ @testing-library не встановлений)
E2E (Playwright):✅ N passed  (або ⏭ Playwright не встановлений)
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

### 2026-05-28 — Timeline drag/resize px→time без clamp → Invalid Date → RangeError — frontend

**Сигнал:** timeline/calendar/gantt UI з drag або resize, де handler конвертує pointer delta у decimal-hours (`origEndH + deltaH`) і потім будує `new Date(\`${date}T${decimalHoursToHHMM(h)}:00\`).toISOString()`. Якщо resize-гілка clamp-ить результат ТІЛЬКИ проти протилежного краю (`origStartH + 0.25`) але НЕ проти меж видимого вікна — `h` може вийти за `[firstHour, lastHour+1]`. `decimalHoursToHHMM(24.5)` → `"24:30"`, `decimalHoursToHHMM(-1)` → `"-1:00"` → `new Date("...T24:30:00")` = **Invalid Date** → `.toISOString()` кидає `RangeError`. Помилка ловиться try/catch у pointerUp → показує нерелевантне "Помилка оновлення" і нічого не надсилає на сервер.
**Причина виникнення:** розробник клампить нову координату проти бізнес-правила "мінімум 15 хв тривалість" (проти протилежного краю слоту), але забуває що видиме вікно (08:00–20:00) — теж межа. Draw-гілка зазвичай безпечна бо `pxToDecimalHours` вже clamp-ить у `Math.max(HOURS[0], Math.min(HOURS[last], raw))`; resize рахує **delta** окремою формулою `pxToHours` і цей clamp обходить.
**Підхід до виявлення:** для кожного timeline/gantt page знайти ВСІ converter-и px→time (draw, resize-start, resize-end, drag-move — це різні гілки!). Для КОЖНОЇ перевірити: чи результат clamp-нутий у `[windowStart, windowEnd]` перед `new Date()`. Не довіряти що «draw clamp-ить, отже resize теж» — це окремі формули. Тест-сценарій: перетягнути край максимально за межу вікна.
**Підхід до фіксу:** додати `WINDOW_START`/`WINDOW_END` константи; обгорнути кожну resize/drag координату у `Math.max(WINDOW_START, Math.min(WINDOW_END, val))`; додатково hard-clamp у самому converter-і (`decimalHoursToHHMM`: `Math.min(24*60, Math.max(0, totalMin))`) як остання лінія оборони для майбутніх викликачів.
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
- ✅ $transaction explicit timeout: всі interactive callbacks
- ✅ ParseUUIDPipe: всі :id параметри
- ✅ Security headers (X-Content-Type-Options, X-Frame-Options, HSTS via @fastify/helmet@11)
- ✅ SSRF guard: webhooks.processor (validatePublicUrl + redirect: 'manual')
- ✅ ArrayMaxSize: inspection.dto, webhook payload

**Frontend:**
- ✅ cancelled flag: AuthProvider, всі mount-fetches (settings, crm, work-orders)
- ✅ SSR-safe today: useState(null) + useEffect → setToday(new Date())
- ✅ apiFetch error array join: `Array.isArray(msg) ? msg.join('; ') : msg`
- ✅ UUID validation client-side перед submit
- ✅ aria-label на іконкових кнопках (після bulk-fix)
- ✅ React named imports (не React.ReactNode)

**Tests:**
- ✅ Contract specs: auth, work-orders, warehouses, counterparties, sync, settings, audit, pricing-rules, batches, currencies, bank-accounts, exchange-rates, cash-registers, calendar (GET/POST/PATCH/DELETE — resize/drag PATCH endpoint)
- ✅ Property-based invariants: inventory, settlements, FSM (26 invariants)
- ✅ Component tests: 139/139 passed (13 файлів)
- ✅ E2E: 42/42 passed (smoke, console-errors serial mode, inventory, api-errors)
