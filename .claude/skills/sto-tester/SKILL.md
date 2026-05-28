---
name: sto-tester
description: >
  Тестувальник STO ERP. Знаходить баги в бек- і фронт-частині, фіксує їх у BUG_REPORT.md,
  після чого автоматично виправляє кожен баг. Враховує бізнес-логіку: FSM нарядів,
  резервування запчастин, розрахунки балансів, tenant isolation, soft delete.
  Запускай командою /sto-tester після реалізації фічі або перед релізом.
model: claude-opus-4-7
---

# sto-tester — Автоматичний тестувальник STO ERP

## Два режими

| Режим | Коли | Що виконувати |
|---|---|---|
| **AUTO** | Автоматично після кожного git commit (post-feature QA) | Кроки 0 → 1 (тільки змінені файли) → 2 → 3 → 4 → 4.3 |
| **FULL** | Явний виклик `/sto-tester` користувачем | Всі кроки 0 → 1 → 2 → 3 → 4 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7 → 4.8 → 4.9 → 5 |

> **Як відрізнити:** якщо тестер запускається автоматично після завдання (через CLAUDE.md правило) — це AUTO. Якщо користувач явно написав `/sto-tester` або попросив протестувати — це FULL.

## AUTO режим — алгоритм (post-feature QA)

```
1. Крок 0: tsc (web + api + shared), unit tests
2. Крок 1: статичний аналіз ТІЛЬКИ змінених файлів (git diff HEAD --name-only)
   - api/*.ts     → §1.1 (бізнес-логіка), §1.2 (TS якість)
   - web/*.tsx    → §1.3 (frontend)
   - *.spec.ts    → §1.4 (тест-покриття)
   - prisma/*.ts  → §1.1 (soft delete, tenant), §1.2 (TS)
3. Крок 2: записати знайдені баги у BUG_REPORT.md
4. Крок 3: виправити кожен баг (CRITICAL → HIGH → MEDIUM → LOW)
5. Крок 4: верифікація (tsc + unit tests)
6. Крок 4.3: contract-тести ТІЛЬКИ для нових/змінених endpoints
7. git commit -m "fix(tester): ..." + оновити MemoryManual.md
```

**Матриця AUTO: тип зміни → що перевіряти**

> Нумерація §1.x — це розділи Кроку 1 цього файлу. Відповідні секції sto-review вказані в дужках.

| Тип зміни | Секції Кроку 1 | sto-review еквівалент |
|---|---|---|
| Новий `@Controller` або endpoint | §1.1 (tenant, soft delete, api contract), §1.2 (TS), §1.4 (contract spec) | §2, §4, §5, §13 |
| Змінений `*.service.ts` | §1.1 (business logic, FSM, inventory, settlements) | §5, §6 |
| Нова `page.tsx` або зміна UI | §1.3 → sto-review §8 (стани, hydration, routing, Tailwind) | §8 |
| Новий `*.dto.ts` | §1.2 (API якість), §1.1 (validation guards) | §2.3, §2.4 |
| Зміна `prisma/schema.prisma` | §1.1 (soft delete fields, orgId, deletedAt), §1.2 | §6, §9 |
| UI-only (тільки `components/ui/`) | §1.3 → sto-review §8, §1.2 (TS), §1.6 (a11y) | §8 |
| Config/docs/тести | §0 (tsc) — більше нічого | §1 |

## FULL режим — алгоритм (явний виклик)

```
1.  Крок 0: tsc + unit tests + перевірка optional deps (fast-check, Playwright, testing-library)
2.  Крок 0.1: запуск dev-серверів (для E2E)
3.  Крок 1: повний статичний аналіз (§1.1–§1.5)
4.  Крок 2: BUG_REPORT.md
5.  Крок 3: авто-фікс від CRITICAL до LOW
6.  Крок 4: верифікація (tsc + unit + build)
7.  Крок 4.3: contract-тести (Supertest) — всі .contract.spec.ts
8.  Крок 4.4: property-based (fast-check) — якщо встановлений
9.  Крок 4.5: E2E (Playwright) — якщо встановлений
10. Крок 4.6: component-тести (testing-library) — якщо встановлений
11. Крок 4.7: функціональне тестування (happy path)
12. Крок 4.8: негативне тестування
13. Крок 4.9: нефункціональне тестування
14. Крок 5: фінальний звіт
15. git commit + оновити MemoryManual.md
```

**Optional залежності** (встановити → розблокує відповідний крок):

| Залежність | Крок | Команда встановлення |
|---|---|---|
| `fast-check` | 4.4 Property-based | `pnpm --filter @sto/api add -D fast-check` |
| `@playwright/test` | 4.5 E2E | `pnpm --filter @sto/web add -D @playwright/test` |
| `@testing-library/react` | 4.6 Component | `pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom` |

> Якщо залежність не встановлена — позначити відповідний крок як `⏭ skipped` у звіті, не намагатись запустити.

> Не питай дозволу на виправлення, коміт і оновлення MemoryManual.md — все виконується автоматично.
> Якщо fix потребує міграції БД або змін у shared — зафіксуй як CRITICAL і повідом після завершення.

### Як оновлювати MemoryManual.md

Після фінального коміту — одразу (без запиту) оновити в `MemoryManual.md`:

```markdown
## Останній commit
<hash> <commit message>
Дата: YYYY-MM-DD

## Поточний стан проєкту
TypeScript:      ✅ 0 errors       (або ❌ N errors)
Unit:            ✅ N/N passed     (або ❌ N failed)
Contract:        ✅ N passed       (або ⏭ немає .contract.spec.ts)
Property:        ✅ N passed       (або ⏭ fast-check не встановлений — install to unlock)
Components:      ✅ N passed       (або ⏭ @testing-library не встановлений — install to unlock)
E2E:             ✅ N passed       (або ⏭ Playwright не встановлений — install to unlock)
Functional:      ✅ N кейсів OK   (або ⚠ N пропущено)   [тільки FULL режим]
Negative:        ✅ N кейсів OK   (або ⚠ N відсутніх)   [тільки FULL режим]
Non-functional:  ✅ perf/headers OK (або ⚠ N проблем)   [тільки FULL режим]
```

Якщо під час тестування виявились нові gotchas — дописати у відповідний розділ `MemoryManual.md` без запиту.

## Мета

Знайти **реальні баги** (не style-питання), зафіксувати їх у `BUG_REPORT.md`,
після чого **негайно виправити** кожен знайдений баг без додаткових запитів.

---

## Крок 0 — Підготовка

```bash
# 1. TypeScript — нульова точка відліку
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false 2>&1 | tail -20
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/shared exec tsc --noEmit

# 2. Запустити всі тести
pnpm --filter @sto/api test --run 2>&1 | tail -30
```

Якщо TypeScript або тести вже червоні — зафіксуй як Bug #0 і виправ ПЕРШИМ.

### 0.1 — Перевірка optional залежностей (тільки FULL режим)

```bash
# Перевірити наявність тестових залежностей
grep "fast-check" apps/api/package.json > /dev/null && echo "fast-check OK" || echo "fast-check MISSING — §4.4 skipped"
grep "@testing-library/react" apps/web/package.json > /dev/null && echo "testing-library OK" || echo "testing-library MISSING — §4.6 skipped"
test -f apps/web/playwright.config.ts && echo "playwright OK" || echo "playwright MISSING — §4.5 skipped"
```

### 0.2 — Запуск dev-серверів (тільки FULL режим, тільки перед E2E)

```bash
# Перевірка стану сервісів
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|redis|minio"
curl -s http://localhost:3000/api/docs > /dev/null 2>&1 && echo "API:UP" || echo "API:DOWN"
curl -s http://localhost:3001 > /dev/null 2>&1 && echo "WEB:UP" || echo "WEB:DOWN"
```

Якщо API:DOWN:
```bash
pnpm --filter @sto/api dev > /tmp/sto-api-dev.log 2>&1 &
until curl -s http://localhost:3000/api/docs > /dev/null 2>&1; do sleep 3; done && echo "API ready"
```

Якщо WEB:DOWN:
```bash
pnpm --filter @sto/web dev > /tmp/sto-web-dev.log 2>&1 &
until curl -s http://localhost:3001 > /dev/null 2>&1; do sleep 3; done && echo "WEB ready"
```

> Якщо після 90s сервер не піднявся — перевірити `/tmp/sto-*-dev.log`, зафіксувати як CRITICAL Bug і пропустити §4.5.

---

## Крок 1 — Збір багів (статичний аналіз)

> **AUTO режим:** аналізуй ТІЛЬКИ змінені файли (`git diff HEAD --name-only`). Пропускай §1.1–§1.5 для незмінених модулів.  
> **FULL режим:** повний аналіз всіх секцій §1.1–§1.5.

Кожен знайдений баг → записати в `BUG_REPORT.md`.

### 1.1 — Бізнес-логіка Backend

#### FSM нарядів (`work-orders`)
- [ ] Перевір, що `transition()` читає з `WORK_ORDER_TRANSITIONS` — не хардкодить статуси
- [ ] При переході → `IN_PROGRESS`: резервування запчастин через `InventoryService.createMovement(type: 'RESERVATION')`
- [ ] При переході → `COMPLETED`: списання запчастин (`WRITEOFF`) + зняття резерву (`RESERVATION_RELEASE`) + `SettlementsService.createTransaction(type: 'CHARGE')` — у `prisma.$transaction`
- [ ] При `CANCELLED` зі статусу де був резерв (`IN_PROGRESS`, `ON_HOLD`): зняття резерву (`RESERVATION_RELEASE`)
- [ ] Недозволений перехід → `BadRequestException` з українським повідомленням

#### Інвентар (`inventory`)
- [ ] Жодного прямого `prisma.stockItem.update({ data: { quantity: ... } })` поза `InventoryService`
- [ ] При `RESERVATION`: кидає `BadRequestException` якщо `available < qty`
- [ ] При `WRITEOFF`: кидає `BadRequestException` якщо `quantity < Math.abs(qty)`
- [ ] `quantity=0` → `BadRequestException`
- [ ] `RESERVATION_RELEASE` з позитивним qty → `BadRequestException`

#### Розрахунки (`settlements`)
- [ ] Жодного прямого `prisma.settlementAccount.update({ data: { balance: ... } })` поза `SettlementsService`
- [ ] Тип `CHARGE` збільшує баланс (клієнт нам винен)
- [ ] Типи `PAYMENT`, `PREPAYMENT`, `REFUND`, `CREDIT_NOTE` — зменшують баланс
- [ ] Немає `SettlementAccount` для контрагента → `NotFoundException`

#### Tenant Isolation
- [ ] Кожен `findFirst` / `findMany` / `update` / `delete` містить `orgId` у `where`
- [ ] FK-валідація в синхронізації: `customerGarageId`, `liftId`, `employeeId`, `workOrderId` перевіряються по `orgId`

#### Soft Delete
- [ ] Всі `findFirst` / `findMany` містять `deletedAt: null`
- [ ] **Виключення** (моделі без `deletedAt`): `SettlementAccount`, `SettlementTransaction`, `StockMovement`, `Payment`, `WorkOrderLineEmployee` — там `deletedAt` фільтр НЕ потрібен
- [ ] **Relation-фільтри теж** — якщо `findMany` рендериться в UI з FK на іншу soft-deletable модель, додати `where: { relatedModel: { deletedAt: null } }`. Інакше видалені сутності з'являються у списках/widgets (наприклад: `MaintenanceSchedule.findUpcoming` має фільтрувати `vehicle: { deletedAt: null }`).
- [ ] Жодного `prisma.X.delete()` на бізнес-сутностях
- [ ] **Soft-delete + повний `@@unique` = повторне створення неможливе** (Bug #152). Якщо модель має `@@unique([orgId, code])` БЕЗ partial-фільтра (`WHERE "deletedAt" IS NULL`), то soft-deleted рядок все ще займає унікальний ключ. App-level dup-check фільтрує `deletedAt: null` → проходить → `prisma.create` падає на DB P2002 → generic 409. Сценарій: видалив валюту "USD" → не можеш створити "USD" знову. Канон у `create()`: після перевірки активного дубля шукай soft-deleted рядок з тим самим ключем (`NOT: { deletedAt: null }`) і **воскрешай** через `update({ ...dto, deletedAt: null })` замість `create`.
  ```bash
  # Знайти повні @@unique (не partial) у schema.prisma на soft-deletable моделях
  grep -n "@@unique" packages/database/prisma/schema.prisma
  # Перевірити чи відповідна міграція має "WHERE ... IS NULL" — якщо НІ, а create() лише
  # перевіряє deletedAt:null без resurrection — це баг
  grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"
  ```
- [ ] **PATCH що змінює unique-поле має re-check унікальності** (Bug #151). Якщо `create()` робить explicit dup-check по `@@unique`, то `update()` теж мусить — інакше PATCH на зайняте значення покладається на DB P2002 → generic 409 замість локалізованого `ConflictException`. Канон: `if (dto.field !== undefined && dto.field !== existing.field) { duplicate = findFirst({ ...uniqueKey, NOT: { id } }); if (duplicate) throw ConflictException }`.

#### API Contract — list endpoints
- [ ] **Кожен list endpoint повертає `{ items, total, page?, limit? }`** — frontend всюди очікує `data.items.length`. Bare-array відповіді крашать з `TypeError: Cannot read properties of undefined`. Якщо `.catch(() => {})` ховає це — баг невидимий.
  ```bash
  # Знайти findAll що повертають голий масив
  grep -rn "async findAll\|Promise<.*\[\]>" apps/api/src/modules/ --include="*.service.ts" | grep -v "Paginated\|Dto\[\]>\|spec"
  ```

#### Cross-service auto-side-effects
- [ ] **Re-read entity всередині транзакції** перед auto-FSM-transition: `tx.X.update({ status: 'NEXT' })` після читання поза tx → race vікно + FSM bypass.
- [ ] **Catch не ковтає всі помилки**: `.catch(() => {})` після `await someService.doX()` ховає реальні баги. Шаблон: `if (!msg.includes('очікувана_бізнес_помилка')) logger.warn(...)`.
- [ ] **PATCH selective recalc**: `const next = dto.next ?? calc(...)` затирає `existing.next` якщо calc → null. Використовуй `shouldRecalc = INPUT_FIELDS.some(f => dto[f] !== undefined)`.

#### Append-only таблиці
- [ ] `StockMovement`, `SettlementTransaction` — ніколи не оновлюються і не видаляються

#### Захист на рівні сервісу (defense-in-depth)
- [ ] `SettlementsService.createTransaction` — внутрішня перевірка `amount > 0` і `Number.isFinite(amount)` (не покладатись лише на DTO `@Min`)
- [ ] `InventoryService.createMovement` — guards на `quantity=0`, `available < |qty|`, `RESERVATION_RELEASE > reserved`, `RESERVATION_RELEASE` з positive qty
- [ ] Будь-який `$queryRaw`/`$executeRaw` має `LIMIT N` — Prisma `take:` не діє на raw queries
  ```bash
  grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" | grep -v spec
  # Для кожного — перевір що SQL закінчується "LIMIT N"
  ```
- [ ] **Raw SQL identifier casing** — Prisma schema без `@map` створює Postgres колонки **double-quoted camelCase** (`"orgId"`, `"goodId"`, `"deletedAt"`, `"minStock"`). Snake_case (`org_id`, `good_id`) **НЕ ПРАЦЮЄ**. Постгрес folds unquoted identifiers to lowercase і не знаходить `"orgId"`.
  ```bash
  # Знайти всі raw SQL і перевірити що ідентифікатори у camelCase з лапками
  grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" -A 30 | grep -E "org_id|deleted_at|created_at|updated_at|good_id|warehouse_id|min_stock|current_seq|reset_period|last_reset|include_date|document_type"
  # Якщо щось знаходить — це CRITICAL bug: SQL крашиться з "column does not exist"
  ```
  Перевірка реальних колонок:
  ```bash
  docker exec stoerp-postgres-1 psql -U sto -d sto_erp \
    -c "SELECT column_name FROM information_schema.columns WHERE table_name='<table>'"
  ```
  Приклад правильного raw SQL:
  ```sql
  SELECT id, "orgId", "currentSeq", "lastResetYear"
  FROM document_number_configs
  WHERE "orgId" = ${orgId}::uuid
    AND "documentType" = ${documentType}::"DocumentType"
  FOR UPDATE
  LIMIT 1
  ```

#### Нумерація документів
- [ ] Номери генеруються через `DocumentNumberService.next(orgId, type)` — не хардкодяться у форматі
- [ ] `DocumentNumberConfig` читається по `orgId` — не по глобальному конфігу

#### Prisma model name lookup (snake_case table → camelCase model)
- [ ] **Plural table → singular model** — Prisma client експонує моделі **тільки у СІНГУЛЯР camelCase** (`prisma.workOrder`, `prisma.counterparty`, `prisma.warranty`). Postgres таблиці через `@@map` — **ПЛЮРАЛ** (`work_orders`, `counterparties`, `warranties`). Наївний `snake_to_camel` дає `workOrders` плюрал → `prisma.workOrders === undefined` → `TypeError: Cannot read properties of undefined`. Catch навколо async-функції НЕ ловить синхронний `.method` access на `undefined`. Bug #127.
  ```bash
  # Знайти підозрілі patternи snake_case → camelCase
  grep -rn "toCamel\|snake.*camel\|snakeCase" apps/api/src --include="*.ts" | grep -v spec
  # Для кожного — переконатись що є явний table→model map, або викликається лише з singular forms
  ```
- [ ] Якщо знайдено динамічний `(prisma as any)[modelName]` — мати **explicit table→model Record** + `if (!model) throw new Error(...)` (швидше провалюватись на dev ніж тихо повертати undefined).
- [ ] **Pull/push/sync що повертають Prisma rows напряму у response** — кожне `BigInt` поле (`syncVersion`) і `Decimal` поле має бути конвертоване через `Number()`/`.toNumber()`. `payload = { ...row }` → 500 на JSON.stringify. Bug #128.
  ```bash
  # Знайти sync/payload patterns
  grep -rn "payload.*\.\.\.row\|payload.*= row\|{ \.\.\.row }" apps/api/src/modules --include="*.ts" | grep -v spec
  ```

#### Алгоритми та формули (ОБОВ'ЯЗКОВО при змінах у pricing/batch/work-orders)

```bash
# Перевірити FEFO — nulls last (товари без терміну ідуть В КІНЦІ, не на початку)
grep -n "expiryDate\|FEFO" apps/api/src/modules/inventory/batch.service.ts
# Очікується: { expiryDate: 'asc', nulls: 'last' }

# Перевірити AVG_COST — зважене, не просте
grep -n "avgCost\|totalCost\|totalQty\|AVG_COST" apps/api/src/modules/inventory/batch.service.ts

# Перевірити округлення цін — Math.round (не ceil/floor)
grep -n "Math\.round\|Math\.ceil\|Math\.floor" apps/api/src/modules/inventory/pricing.service.ts

# Перевірити захист від від'ємної ціни
grep -n "Math.max" apps/api/src/modules/inventory/pricing.service.ts

# Перевірити Decimal cast у recalcTotals
grep -n "Number(l\.\|Number(p\.\|totalLabor\|totalParts" apps/api/src/modules/work-orders/work-orders.service.ts
```

- [ ] Pricing: `PERCENT` = `cost * (1 + pct/100)` — не `cost + pct/100`
- [ ] Pricing: `FIXED_AMOUNT` = `cost + delta` — не `cost * delta`
- [ ] Pricing: `FIXED_PRICE` fallback = `fixedPrice ?? costPrice` — не `fixedPrice ?? 0`
- [ ] Pricing: округлення = `Math.round(result / r) * r` — не `Math.ceil` і не `Math.floor`
- [ ] Pricing: floor guard = `Math.max(0, result)` присутній (ціна не від'ємна)
- [ ] Pricing: `Number(rule.percentValue ?? 0)` — Decimal cast перед арифметикою
- [ ] Batch FEFO: `[{ expiryDate: 'asc', nulls: 'last' }, { createdAt: 'asc' }]` — `nulls: 'last'` обов'язковий
- [ ] Batch AVG_COST: `SUM(qty * price) / SUM(qty)` — не `SUM(price) / count`
- [ ] Batch loop: `Math.min(remaining, batch.remainingQty)` — не `batch.remainingQty` напряму
- [ ] Batch loop: після циклу якщо `remaining > 0` → `throw BadRequestException` (недостатньо в батчах)
- [ ] recalcTotals: `Number(l.amount)` cast (Decimal у reduce без cast → рядкова конкатенація)
- [ ] recalcTotals: `totalAmount = totalLabor + totalParts` — дві окремі суми, не одна
- [ ] PriceHistory: `create` тільки якщо нова ціна відрізняється від `good.salePrice` (>0.001 tolerance)

### 1.2 — TypeScript / API якість

- [ ] Немає `any` (крім виправданих `as unknown as T`)
- [ ] `toResponseDto()` присутній — жоден `prisma.*` модель не повертається напряму в controller
- [ ] DTO-поля мають `@ApiProperty`
- [ ] Помилки `throw new XxxException('...')` — повідомлення українською
- [ ] `pnpm --filter @sto/web exec tsc --noEmit` — 0 errors
- [ ] `pnpm --filter @sto/api exec tsc --noEmit` — 0 errors

### 1.2.1 — Sentry інтеграція

```bash
# Перевірити що instrument.ts є першим імпортом у main.ts
head -3 apps/api/src/main.ts | grep "instrument"

# Перевірити що Sentry.captureException викликається тільки для 5xx
grep -n "captureException\|captureMessage" apps/api/src/common/filters/http-exception.filter.ts

# Перевірити що enabled: false у development
grep -n "enabled" apps/api/src/instrument.ts
grep -n "enabled" apps/web/src/lib/sentry.ts

# Перевірити що SentryProvider є у root layout
grep -n "SentryProvider" apps/web/src/app/layout.tsx
```

- [ ] `apps/api/src/instrument.ts` існує і є першим `import` у `main.ts` (до `@nestjs/core`)
- [ ] `Sentry.init({ enabled: process.env.NODE_ENV === 'production' && !!dsn })` — у development Sentry вимкнений
- [ ] `HttpExceptionFilter` — `captureException`/`captureMessage` тільки коли `status >= 500`; 4xx НЕ надсилаються
- [ ] `beforeSend` у `instrument.ts` — додатковий фільтр: відхиляє events з `status_code < 500`
- [ ] `apps/web/src/lib/sentry.ts` — `initSentry()` з `enabled: NODE_ENV === 'production' && !!dsn`
- [ ] `SentryProvider` присутній у `apps/web/src/app/layout.tsx` (НЕ у setup layout)
- [ ] У `apps/web/src/app/(setup)/layout.tsx` — `SentryProvider` **відсутній** (setup ізольований)
- [ ] `NEXT_PUBLIC_SENTRY_DSN` і `SENTRY_DSN` є у `.env.example` (з placeholder, не реальним DSN)

### 1.3 — Frontend (Next.js)

→ Виконати всі перевірки **§8 Web Frontend** зі `sto-review/SKILL.md` (UI стани, hydration, routing, SSE, Tailwind, async-init Select, UX features).

Додатково перевірити у контексті тестування:

- [ ] **Free-text `<Input>` що приймає UUID** (наприклад, workOrderId) — має клієнтську UUID-валідацію ПЕРЕД submit.
  ```typescript
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (form.workOrderId && !UUID_RE.test(form.workOrderId)) {
    setError('ID наряду має бути у форматі UUID'); return;
  }
  ```
  ```bash
  grep -rn "workOrderId\|vehicleId\|employeeId\|counterpartyId\|liftId" apps/web/src/app --include="*.tsx" \
    | grep "onChange.*e\.target\.value\|value=\{form\." | grep -v "Select\|<select"
  ```
- [ ] **`apiFetch` error array join**: сервер повертає `{ message: string[] }` при validation errors. `apiFetch` має `Array.isArray(msg) ? msg.join('; ') : msg`.
- [ ] **Async-init Select race**: `<Select value={form.xxxId}>` ініціалізується `''` → опції завантажуються async → перший option показується візуально але `form.xxxId = ''` → API 400. Фікс: `useEffect(() => { if (modal && !form.xxxId && options[0]) setForm(f => ({...f, xxxId: options[0].id})); }, [options, modal])`.
  ```bash
  grep -rn "value=\{form\." apps/web/src/app --include="*.tsx" | grep -v "//\|onChange"
  # Для кожного — перевірити чи опції завантажуються async і чи є sync useEffect
  ```
- [ ] **`.catch(() => {})` на list-fetch у `useEffect` — ховає loading/error стан** (Bug #145). Будь-який `apiFetch(...).then(setX).catch(() => {})` у mount/tab-effect має 4 запахи: (1) loading-прапорець оголошений але `setLoading(true)` ніколи не викликається → empty-state блимає під час завантаження; (2) `.catch(() => {})` ковтає 500 → виглядає як "немає даних"; (3) немає cancelled-flag → setState після unmount; (4) мертвий loading-state (declared, never read у JSX). Канон для кожного list-fetch effect: `let cancelled=false` + `return () => {cancelled=true}`; `setLoading(true)` перед, `.finally(() => !cancelled && setLoading(false))`; `.catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Помилка...'))`; у JSX `{loading && <Spinner/>}` + `{!loading && items.length===0 && <Empty/>}`.
  ```bash
  # Знайти fetch-и що тихо ковтають помилки
  grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx"
  # Знайти loading-state що оголошений але ніколи не set true
  grep -rn "const \[loading" apps/web/src/app --include="*.tsx"  # → перевірити setLoading(true) існує
  ```
- [ ] **UUID у контракт-тестах має валідну версію**: `@IsUUID()` (default version 'all') ВІДХИЛЯЄ nil/zero-version UUID `00000000-...-000000000001` (13-й hex = `0` не version 1-5) → 400 `"X must be a UUID"`. У `*.contract.spec.ts` для UUID-полів використовувати `11111111-1111-4111-8111-111111111111` (v4 layout), не nil-UUID. Це test-only баг — фіксувати ТЕСТ.

### 1.4 — Тести Backend _(AUTO: тільки якщо змінено *.spec.ts або service; FULL: завжди)_

#### Unit-тести (`.spec.ts`) — перевір покриття

| Сервіс | Обов'язкові тест-кейси |
|---|---|
| `work-orders.service` | happy path create; FSM invalid transition throws; soft delete; IN_PROGRESS резервує запчастини; COMPLETED списує і виставляє рахунок |
| `inventory.service` | createMovement RECEIPT збільшує qty; RESERVATION зменшує available; WRITEOFF кидає при insufficient stock; qty=0 кидає |
| `settlements.service` | CHARGE збільшує balance; PAYMENT зменшує; немає account → NotFoundException |
| `auth.service` | login happy path; login wrong password; login deleted employee; refresh invalid token |
| `sync.service` | pull фільтрує по orgId і syncVersion; push відхиляє заборонені таблиці; push cross-tenant FK кидає |

#### Contract-тести (`.contract.spec.ts`) — перевір HTTP шар

| Модуль | Обов'язкові contract тест-кейси |
|---|---|
| `work-orders` | GET /work-orders → 200 + pagination shape; POST без полів → 400; 401 без токена |
| `inventory` | GET /stock-items → 200 + items[].available; POST /movements → 400 при qty=0 |
| `auth` | POST /auth/login → 200 + accessToken + employee shape; 401 при невірному паролі |
| `settlements` | GET /settlements/accounts → 200 + balance є числом |
| `sync` | GET /sync/pull → 200 + records + maxSyncVersion |

Перевірити наявність contract тестів:
```bash
find apps/api/src -name "*.contract.spec.ts" | sort
# Якщо файлів немає — це LOW bug: відсутнє contract покриття
```

#### Property-based тести (`.invariants.spec.ts`) — перевір інваріанти

| Модуль | Обов'язкові інваріанти |
|---|---|
| `work-orders.fsm` | всі пари (from, to): якщо to ∉ TRANSITIONS[from] → blocked; ARCHIVED/CANCELLED → порожні списки |
| `inventory` | після валідних рухів: quantity≥0, reserved≥0, available≥0 |
| `settlements` | CHARGE підвищує баланс; PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE знижують |

Перевірити наявність property тестів:
```bash
find apps/api/src -name "*.invariants.spec.ts" | sort
# Якщо файлів немає і fast-check встановлений — це MEDIUM bug
```

### 1.5 — Тести Frontend _(тільки FULL режим)_

#### Component-тести (`src/components/ui/__tests__/*.test.tsx`)

| Компонент | Обов'язкові тест-кейси |
|---|---|
| `Button` | всі variants рендеряться; disabled блокує; loading показує spinner |
| `Select` | placeholder як disabled option; label/errorMessage/hint присутні |
| `Modal` | закритий не рендерить; Escape → onClose; footer рендерить кнопки |
| `Input` | label/errorMessage/hint відображаються |
| `EmptyState` | title + description; action кнопка якщо передана |

Перевірити наявність:
```bash
find apps/web/src -name "*.test.tsx" | sort
# Якщо 0 файлів — це LOW bug (відсутнє component покриття)
```

#### E2E тести (`e2e/*.spec.ts`) — smoke + user flows

| Тест файл | Мінімальне покриття |
|---|---|
| `smoke.spec.ts` | / і /login доступні; /setup без auth; /work-orders без auth → /login |
| `work-order-flow.spec.ts` | список WO завантажується; API mock: IN_PROGRESS WO показує кнопку COMPLETED |
| `inventory.spec.ts` | список завантажується; low-stock badge при minStock < quantity; empty state |
| `api-errors.spec.ts` | кожна сторінка показує error state при 500 від API |

Перевірити покриття E2E:
```bash
find apps/web/e2e -name "*.spec.ts" | sort
# smoke.spec.ts — обов'язковий, решта — рекомендовані
```

### 1.6 — Accessibility (a11y) _(тільки FULL режим)_

```bash
# Кнопки з onClick на не-інтерактивних елементах
grep -rn "onClick" apps/web/src/ --include="*.tsx" | grep -E "<div|<span|<p " | grep -v "role="

# Зображення без alt
grep -rn "<img" apps/web/src/ --include="*.tsx" | grep -v "alt="

# aria-label на іконкових кнопках
grep -rn "<Button" apps/web/src/ --include="*.tsx" | grep -E "(<[A-Z][a-z]+Icon|lucide)" | grep -v "aria-label\|aria-describedby\|title"

# SearchCombobox / combobox — WAI-ARIA wiring
grep -rn "role=\"combobox\"\|role=\"listbox\"\|aria-expanded" apps/web/src/ --include="*.tsx" | head -20
```

- [ ] Кожен `onClick` на `<div>` / `<span>` — додати `role="button"` та `tabIndex={0}` + `onKeyDown` handler
- [ ] Всі `<img>` мають `alt` (описовий для контентних, `alt=""` для декоративних)
- [ ] Іконкові кнопки (без тексту) мають `aria-label` або `<span className="sr-only">`
- [ ] `<SearchCombobox>` або combobox pattern: `role="combobox"` + `aria-expanded` + `aria-controls` → `role="listbox"` + `role="option"` на кожному елементі
- [ ] Modal закривається по `Escape` — `onKeyDown` handler у `<Modal>` компоненті
- [ ] Форми мають `<label htmlFor>` або `aria-label` на кожному `<input>` / `<select>`
- [ ] **opacity-0 pattern**: `opacity-0 pointer-events-none` для приховання контенту — переконатись що `aria-hidden="true"` теж присутній (screen readers читають opacity-0 елементи)
  ```bash
  grep -rn "opacity-0" apps/web/src/ --include="*.tsx" | grep -v "aria-hidden\|transition\|group-hover"
  ```
- [ ] Focus order логічний — tab переміщується у порядку DOM (нема `tabIndex > 0`)
  ```bash
  grep -rn "tabIndex=[^{]0}" apps/web/src/ --include="*.tsx" | grep -v "tabIndex={0}"
  ```

### 1.7 — i18n & Ukrainian UI Consistency _(тільки FULL режим)_

```bash
# Англійські рядки у JSX (підозрілі — може бути умисно для власних назв)
grep -rn ">[A-Z][a-z]* [A-Z][a-z]*<\|>[A-Z][a-z]* [a-z]* [A-Z][a-z]*<" apps/web/src/app/ --include="*.tsx" \
  | grep -v "className\|import\|//\|{" | head -30

# Англійські повідомлення про помилки в API
grep -rn "throw new.*Exception\|throw new.*Error" apps/api/src/modules/ --include="*.ts" \
  | grep -E "['\"](Cannot|Invalid|Not found|Already|Forbidden|Unauthorized|Failed)" | grep -v "spec"

# Логування без перекладу (ок — але перевірити що user-facing messages — не лог-рядки)
grep -rn "message:.*['\"].*[A-Z][a-z]" apps/api/src/modules/ --include="*.ts" \
  | grep "NotFoundException\|BadRequestException\|ForbiddenException" | grep -v "spec" | head -20
```

- [ ] Всі user-facing рядки у JSX — кирилицею (`uk-UA`)
- [ ] Всі `throw new XxxException('...')` у сервісах — повідомлення українською
- [ ] Дати відображаються у форматі `DD.MM.YYYY` — не `YYYY-MM-DD` або `MM/DD/YYYY`
  ```bash
  grep -rn "toLocaleDateString\|toISOString\|new Date.*toStr" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|api"
  # Перевірити що використовується форматування з локаллю uk-UA або date-fns uk
  ```
- [ ] Валюта відображається як `1 250,00 ₴` — не `UAH 1250.00` або `$1250`
  ```bash
  grep -rn "toFixed\|toLocaleString\|UAH\|грн" apps/web/src/ --include="*.tsx" | grep -v "//\|import" | head -20
  ```
- [ ] Час — `HH:mm` (24-год), не `12:30 PM`
- [ ] Тиждень починається з понеділка (`weekStartsOn: 1` у date-fns / react-day-picker)
  ```bash
  grep -rn "weekStartsOn\|startOfWeek\|getDay" apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "node_modules"
  ```
- [ ] Placeholder тексти — кирилицею (`Введіть назву...`, не `Enter name...`)
  ```bash
  grep -rn "placeholder=" apps/web/src/ --include="*.tsx" | grep -E '"[A-Z][a-z]' | head -20
  ```

---

## Крок 2 — Фіксація в BUG_REPORT.md

Після аналізу **одразу запиши** всі знайдені баги у файл `BUG_REPORT.md` в корені проєкту:

```markdown
# BUG_REPORT.md — STO ERP

Дата: YYYY-MM-DD
Сесія: <короткий опис що тестувалось>

---

## Bug #1 — [severity] Заголовок

**Файл:** `apps/api/src/modules/work-orders/work-orders.service.ts:145`
**Severity:** CRITICAL | HIGH | MEDIUM | LOW
**Категорія:** business-logic | security | typescript | frontend | test-coverage

**Опис:**
Що саме не так і чому це баг (не побажання).

**Очікувана поведінка:**
Що повинно відбуватись.

**Фактична поведінка:**
Що відбувається зараз.

**Статус:** [ ] відкритий / [x] виправлено

---
```

**Severity:**
- `CRITICAL` — втрата даних, неправильні фінансові розрахунки, cross-tenant витік
- `HIGH` — порушення бізнес-правила (FSM, резерви), security проблема
- `MEDIUM` — TypeScript помилка, відсутній тест на критичну гілку
- `LOW` — UI стан (loading/empty), незручність

---

## Крок 3 — Автоматичне виправлення

Після запису `BUG_REPORT.md` — **виправляй кожен баг по черзі**, від CRITICAL до LOW:

```
для кожного Bug #N:
  1. Прочитай файл з багом
  2. Зроби мінімальний точковий фікс (не рефактор)
  3. Після фіксу: pnpm --filter <package> exec tsc --noEmit
  4. Якщо тест покриття відсутнє → додай тест-кейс у .spec.ts
  5. Відмітити [x] у BUG_REPORT.md
  6. git add <змінені файли> && git commit -m "fix(tester): Bug #N — <заголовок>"  ← БЕЗ запиту

Після останнього Bug:
  7. Оновити MemoryManual.md (Останній commit + TypeScript + Тести) ← БЕЗ запиту
```

**Правила фіксу:**
- Мінімальний diff — не чіпай нічого крім проблемного місця
- Якщо фікс потребує міграції БД — зафіксуй як окремий CRITICAL, повідом користувача
- Якщо фікс потребує змін у `@sto/shared` типах — оновлюй синхронно

---

## Крок 4 — Верифікація

Після всіх фіксів:

```bash
# TypeScript — повинно бути 0 errors
pnpm --filter @sto/web exec tsc --noEmit
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/shared exec tsc --noEmit

# Unit тести — всі повинні пройти
pnpm --filter @sto/api test --run

# Build — перевірка що нічого не зламалось
pnpm --filter @sto/api build 2>&1 | tail -10
```

---

## Крок 4.3 — Contract-тести (Supertest)

Contract-тести перевіряють **HTTP шар**: статус-коди, shape відповіді, заголовки авторизації.

> Шаблон → `sto-tester-templates.md §4.3`

**Мета:** виявити розрив між `toResponseDto()` у сервісі та `interface` у фронтенді.

### Коли писати
- Новий `@Controller` → одразу `.contract.spec.ts`
- Зміна `toResponseDto()` → оновити snapshot
- Новий endpoint → тест 401/403/200/201

### Структура файлу
```
apps/api/src/modules/{domain}/{domain}.contract.spec.ts
```

### Що перевіряти

| Endpoint | Тест-кейси |
|---|---|
| `GET /work-orders` | 200 з pagination shape; 401 без токена |
| `POST /work-orders` | 201 + DTO shape; 400 без обов'яз. полів |
| `PATCH /work-orders/:id/status` | 400 при невалідному FSM-переході |
| `GET /inventory` | 200 + items[].available присутній |
| `POST /auth/login` | 200 + `{ accessToken, refreshToken, employee }`; 401 |
| `GET /sync/pull` | 200 + `{ records, maxSyncVersion }` |

### Запуск

```bash
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "contract|PASS|FAIL"
find apps/api/src -name "*.contract.spec.ts" | sort
# Якщо файлів немає — це LOW bug: відсутнє contract покриття
```

→ **Повний шаблон:** `sto-tester-templates.md §4.3`

---

## Крок 4.4 — Property-based тести (fast-check) _(тільки FULL режим)_

> **AUTO:** пропустити. **FULL:** виконати якщо `fast-check` встановлений.  
> → **Шаблони:** `sto-tester-templates.md §4.4` (FSM, Inventory, Settlements, Pricing invariants)

**Мета:** знайти edge cases які unit-тест з хардкодженими значеннями не покриє.

```bash
grep "fast-check" apps/api/package.json || pnpm --filter @sto/api add -D fast-check
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "invariant|property|PASS|FAIL"
find apps/api/src -name "*.invariants.spec.ts" | sort
```

| Модуль | Інваріанти |
|---|---|
| `work-orders.fsm` | всі пари (from, to) → blocked; ARCHIVED/CANCELLED = порожні |
| `inventory` | quantity≥0, reserved≥0, available≥0 після валідних рухів |
| `settlements` | CHARGE підвищує; PAYMENT/REFUND/CREDIT_NOTE знижують |
| `pricing` | PERCENT = `cost*(1+pct/100)`; округлення кратне roundTo; `Math.max(0,result)` |

---

## Крок 4.5 — E2E тести (Playwright) _(тільки FULL режим)_

> **AUTO:** пропустити. **FULL:** виконати якщо `@playwright/test` встановлений + dev-сервери з §0.2 запущені.  
> → **Шаблони:** `sto-tester-templates.md §4.5` (playwright.config.ts, auth.spec.ts, work-orders.spec.ts, inventory.spec.ts, api-errors.spec.ts, console-errors.spec.ts, setup-auth.ts)

```bash
test -f apps/web/playwright.config.ts && echo "EXISTS" || echo "NOT INSTALLED"
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -q 200 && echo "OK" || echo "OFFLINE"
pnpm --filter @sto/web exec playwright test --reporter=list 2>&1 | tail -40
pnpm --filter @sto/web exec playwright test e2e/console-errors.spec.ts --reporter=list 2>&1 | tail -50
```

**Структура e2e:**
```
apps/web/e2e/
  smoke.spec.ts           — публічні URL + auth guard
  auth.spec.ts            — login/logout flows
  work-orders.spec.ts     — список, CRUD, FSM переходи
  work-order-flow.spec.ts — повний user flow: WO → completion → payment
  inventory.spec.ts       — список, low-stock badge
  api-errors.spec.ts      — 500 → error state на кожній сторінці
  console-errors.spec.ts  — немає console.error/pageerror (ОБОВ'ЯЗКОВО)
  .auth/admin.json        — збережений auth state (gitignored)
```

**Якщо E2E тест падає:**
1. `--screenshot=on` → переглянути
2. Зафіксувати Bug → BUG_REPORT.md → виправити
3. Flaky → додати `{ timeout: 8_000 }`
4. Відсутній `data-testid` → додати у компонент (LOW bug)

**⚠️ STALE DEV API = console-errors false-positive (НЕ код-баг).** Якщо console-errors.spec
показує `Failed to load resource: 404` на сторінці що кличе НОВІ endpoints — спочатку перевір
чи це не stale API-процес (запущений ДО merge feature-коміту з новими routes). NestJS
`nest start --watch` не завжди підхоплює модулі додані поки сервер вже працював.
```bash
# Діагностика: route у коді але 404 на рантаймі?
curl -s http://localhost:3000/api/<new-route>   # 404 "Cannot GET" = stale; 401 = route OK (auth)
# Лік: рестарт API
powershell -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen | %{ Stop-Process -Id \$_.OwningProcess -Force }"
pnpm --filter @sto/api dev > /tmp/sto-api-dev.log 2>&1 &
until curl -s http://localhost:3000/api/<new-route> | grep -q "statusCode"; do sleep 3; done
```
404 на route який ТОЧНО є у `@Controller` + зареєстрований у AppModule = stale server, перезапусти і пере-прогон.

---

## Крок 4.6 — Component-тести (Vitest + Testing Library) _(тільки FULL режим)_

> **AUTO:** пропустити. **FULL:** виконати якщо `@testing-library/react` встановлений.  
> → **Шаблони:** `sto-tester-templates.md §4.6` (Button, Select, Modal, EmptyState)

```bash
grep "@testing-library" apps/web/package.json || \
  pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
find apps/web/src -name "*.test.tsx" | sort
pnpm --filter @sto/web exec vitest run --reporter=verbose 2>&1 | tail -30
```

**Checklist:**
- [ ] `Button` — всі variants; disabled блокує; loading spinner
- [ ] `Select` — placeholder disabled option; label/errorMessage/hint
- [ ] `Modal` — закритий не рендерить; Escape → onClose; footer
- [ ] `Input` — label/errorMessage/hint; leftElement/rightElement
- [ ] `EmptyState` — title + description; action кнопка

---

## Крок 4.7 — Функціональне тестування _(тільки FULL режим)_

> → **Шаблони:** `sto-tester-templates.md §4.7` (WorkOrders, Inventory, Settlements, CRM, Auth таблиці + код)

**Алгоритм:**
```
1. git diff → які service-методи змінились
2. Для кожного зміненого метода — пройти таблицю нижче
3. Написати/оновити .spec.ts якщо кейс відсутній
```

| Домен | Критичні кейси |
|---|---|
| WorkOrders | create → DRAFT; IN_PROGRESS → RESERVATION; COMPLETED → WRITEOFF+CHARGE в tx |
| Inventory | RECEIPT +qty; RESERVATION -available; WRITEOFF -qty; TRANSFER src→dst |
| Settlements | CHARGE +balance; PAYMENT -balance; SUM(CHARGE)=SUM(PAYMENT) → 0 |
| Auth | login happy path; wrong password 401; refresh → new accessToken |

---

## Крок 4.8 — Негативне тестування _(тільки FULL режим)_

> → **Шаблони:** `sto-tester-templates.md §4.8` (DTO, бізнес-правила, tenant isolation)

```bash
# Поля без захисту від від'ємних значень
grep -rn "@IsNumber\|@IsInt\|@IsPositive\|@Min" apps/api/src/modules/ --include="*.dto.ts" | grep -v "@Min(1\|@Min(0\|@IsPositive"

# :id без ParseUUIDPipe
grep -rn "@Param('id')" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe"
```

- [ ] Кожен `POST`/`PATCH` → 400 при відсутньому обов'язковому полі
- [ ] Кожен `:id` → `ParseUUIDPipe`
- [ ] `quantity=0`, `amount=0` → 400
- [ ] RESERVATION `qty > available` → 400
- [ ] Невалідний FSM-перехід → 400 з українським повідомленням
- [ ] Без `Authorization` → 401; неправильна роль → 403; чужий orgId → 404

---

## Крок 4.9 — Нефункціональне тестування _(тільки FULL режим)_

> → **Шаблони:** `sto-tester-templates.md §4.9` (perf Supertest, security headers, DB resilience, BullMQ)

```bash
# $transaction без timeout
grep -rn "prisma.\$transaction" apps/api/src/ --include="*.ts" | grep -v "timeout:"

# findMany без take
grep -rn "findMany(" apps/api/src/modules/ --include="*.service.ts" | grep -v "take:" | grep -v "spec"

# Security headers
curl -I http://localhost:3000/api/health 2>/dev/null | grep -iE "x-content-type|x-frame"
```

- [ ] List endpoints `< 200ms`; sync pull `< 500ms`
- [ ] `X-Content-Type-Options`, `X-Frame-Options` присутні
- [ ] `$transaction` з `timeout: 5000`
- [ ] P2002 → 409; P2025 → 404 (не 500)
- [ ] BullMQ processors re-throw помилки
- [ ] Всі `findMany` мають `take`

---

## Крок 5 — Фінальний звіт _(тільки FULL режим; AUTO — короткий підсумок)_

**AUTO підсумок:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧪 AUTO QA — STO ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TypeScript:  ✅ 0 errors
Unit:        ✅ N/N passed
Contract:    ✅ N passed  (або ⏭ немає .contract.spec.ts)
Баги:        N знайдено / N виправлено / 0 залишилось
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**FULL підсумок:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧪 FULL ТЕСТУВАННЯ STO ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Знайдено багів:    N (CRITICAL: X / HIGH: Y / MEDIUM: Z / LOW: W)
Виправлено:        N
Залишилось:        0

TypeScript:        ✅ 0 errors
Unit:              ✅ N passed / 0 failed
Contract:          ✅ N passed  (або ⏭ немає .contract.spec.ts)
Property-based:    ✅ N passed  (або ⏭ fast-check не встановлений)
Component:         ✅ N passed  (або ⏭ @testing-library не встановлений)
E2E:               ✅ N passed  (або ⏭ Playwright не встановлений)
Функціональне:     ✅ N кейсів (або ⚠ N пропущено)
Негативне:         ✅ N кейсів (або ⚠ N відсутніх)
Нефункціональне:   ✅ perf OK, headers OK (або ⚠ N проблем)
Build:             ✅ OK

Коміти:
  fix(tester): Bug #1 — ...
  fix(tester): Bug #2 — ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Шаблони тестів (copy-paste)

→ **Повні шаблони:** `sto-tester-templates.md §S` (service unit test + component test)

---

## Ключові файли для аналізу

| Область | Файли |
|---|---|
| FSM нарядів | `apps/api/src/modules/work-orders/work-orders.fsm.ts`, `work-orders.service.ts` |
| Інвентар | `apps/api/src/modules/inventory/inventory.service.ts` |
| Розрахунки | `apps/api/src/modules/settlements/settlements.service.ts` |
| Синхронізація | `apps/api/src/modules/sync/sync.service.ts` |
| Компоненти UI | `apps/web/src/components/ui/` |
| Design tokens | `apps/web/src/app/globals.css` |
| Shared types | `packages/shared/src/types/index.ts` |
| Auth guard | `apps/api/src/auth/guards/` |
| E2E тести | `apps/web/e2e/`, `apps/web/playwright.config.ts` |

---

## Самовдосконалення скіла (ОБОВ'ЯЗКОВО після кожного запуску)

Після виправлення кожного Bug #N — запитай себе:

> "Цей баг був передбачений існуючим пунктом у §1.1–§1.7?"

Якщо **НІ** — одразу оновити цей файл (`SKILL.md`):
1. Додати новий пункт у відповідний підрозділ:
   - `§1.1` — бізнес-логіка backend (FSM, інвентар, settlements, tenant isolation)
   - `§1.2` — TypeScript / API якість
   - `§1.3` — frontend-специфічні динамічні баги (async race, UUID validation)
   - `§1.4` — покриття backend тестами
   - `§1.5` — покриття frontend тестами
   - `§1.6` — accessibility (aria, keyboard, screen reader)
   - `§1.7` — i18n / Ukrainian UI consistency
   - якщо баг стосується статичного аналізу коду → **оновлювати sto-review** (§1–§13), не тестер
2. Якщо патерн виявляється grep'ом → додати bash команду
3. Commit: `docs(skills): add <баг> to sto-tester checklist`

**Мета:** кожен баг що пройшов непомічений — робить наступний запуск розумнішим.
