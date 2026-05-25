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

## Режим Auto (ОБОВ'ЯЗКОВО)

**Запускай у режимі Auto:** знаходь баги → записуй у BUG_REPORT.md → виправляй одразу → без питань.

Алгоритм:
1. Виконай Крок 0 (tsc + unit tests)
2. Пройди Крок 1 (збір багів) — записуй кожен у BUG_REPORT.md
3. Крок 3 (авто-фікс) — виправляй від CRITICAL до LOW без зупинки
4. Крок 4 (верифікація) — tsc + unit tests мають бути зеленими
5. Крок 4.3 (Contract-тести Supertest) — перевір HTTP контракт нових/змінених endpoints
6. Крок 4.4 (Property-based fast-check) — FSM і inventory/settlements інваріанти
7. Крок 4.5 (E2E Playwright) — smoke + user flows якщо dev-сервер доступний
8. Крок 4.6 (Component-тести Vitest) — ui/ компоненти якщо Testing Library встановлений
9. Крок 5 — фінальний звіт
10. Оновити MemoryManual.md — Останній commit + стан тестів (БЕЗ запиту)

> Не питай дозволу на виправлення, коміт і оновлення MemoryManual.md — все виконується автоматично.
> Якщо fix потребує міграції БД або змін у shared — зафіксуй як CRITICAL і повідом після завершення.

### Як оновлювати MemoryManual.md (крок 6)

Після фінального коміту — одразу (без запиту) оновити в `MemoryManual.md`:

```markdown
## Останній commit
<hash> <commit message>
Дата: YYYY-MM-DD

## Поточний стан проєкту
TypeScript:  ✅ 0 errors       (або ❌ N errors)
Unit:        ✅ N/N passed     (або ❌ N failed)
Contract:    ✅ N passed       (або ⏭ немає .contract.spec.ts)
Property:    ✅ N passed       (або ⏭ fast-check не встановлений)
Components:  ✅ N passed       (або ⏭ @testing-library не встановлений)
E2E:         ✅ N passed       (або ⏭ skipped — dev server offline)
```

Якщо під час тестування виявились нові gotchas — дописати у відповідний розділ `MemoryManual.md` без запиту.

## Мета

Знайти **реальні баги** (не style-питання), зафіксувати їх у `BUG_REPORT.md`,
після чого **негайно виправити** кожен знайдений баг без додаткових запитів.

---

## Крок 0 — Підготовка

```bash
# 1. TypeScript — нульова точка відліку
pnpm --filter @sto/web exec tsc --noEmit
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/shared exec tsc --noEmit

# 2. Запустити всі тести
pnpm --filter @sto/api test --run 2>&1 | tail -30
```

Якщо TypeScript або тести вже червоні — зафіксуй як Bug #0 і виправ ПЕРШИМ.

```bash
# 3. Перевірити наявність тестових залежностей
grep "fast-check" apps/api/package.json > /dev/null && echo "fast-check OK" || echo "fast-check MISSING"
grep "@testing-library/react" apps/web/package.json > /dev/null && echo "testing-library OK" || echo "testing-library MISSING — component tests skipped"
test -f apps/web/playwright.config.ts && echo "playwright OK" || echo "playwright MISSING"
```

---

## Крок 1 — Збір багів (статичний аналіз)

Проходь по кожному пункту нижче. Кожен знайдений баг → записати в `BUG_REPORT.md`.

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

### 1.2 — TypeScript / API якість

- [ ] Немає `any` (крім виправданих `as unknown as T`)
- [ ] `toResponseDto()` присутній — жоден `prisma.*` модель не повертається напряму в controller
- [ ] DTO-поля мають `@ApiProperty`
- [ ] Помилки `throw new XxxException('...')` — повідомлення українською
- [ ] `pnpm --filter @sto/web exec tsc --noEmit` — 0 errors
- [ ] `pnpm --filter @sto/api exec tsc --noEmit` — 0 errors

### 1.3 — Frontend (Next.js)

#### Форми
- [ ] Немає прямих `fetch`/`axios` у компонентах — тільки через `apiClient` або TanStack Query hooks
- [ ] Форми не блокують submit під час завантаження (кнопка `loading` стан)
- [ ] `errorMessage` або toast показується при помилці API

#### Стан
- [ ] Loading стан є на кожній сторінці з даними (`<Spinner />` або skeleton)
- [ ] Empty стан є — `<EmptyState />` коли список порожній
- [ ] Error стан є — `<EmptyState />` з повідомленням при помилці fetch

#### API/Frontend type contract
- [ ] Для кожного `interface` у page.tsx — перевір відповідний `toResponseDto()` або `toDto()` у сервісі. Кожне **обов'язкове** поле у фронтенд-типі повинно реально повертатись API.
  ```bash
  # Знайти всі interface у page.tsx файлах — звірити з toResponseDto у сервісах
  grep -rn "^interface " apps/web/src/app/ --include="*.tsx"
  ```
- [ ] Якщо API навмисно опускає поле (security, роль) — тип у frontend має бути `field?: Type` (optional), не обов'язковим. Приклад: `rateScheme` omitted in `findAll` → `rateScheme?: {...}` у Employee interface.
- [ ] Всі звернення до optional полів захищені guard-ом: `emp.rateScheme?.type`, або умовним рендером `{emp.rateScheme && ...}`.

#### Blob URL / memory leaks
- [ ] `URL.createObjectURL(blob)` — обов'язково `setTimeout(() => URL.revokeObjectURL(url), 100)` після `a.click()`
  ```bash
  grep -rn "URL.createObjectURL" apps/web/src --include="*.tsx"
  # Для кожного — перевір що поруч є revokeObjectURL
  ```

#### Hydration (SSR/CSR mismatch)
- [ ] Якщо є hydration помилка — першим кроком видаляй `.next` кеш (`rm -rf apps/web/.next`). Stale chunks є #1 причиною "клієнт рендерить щось зовсім інше".
- [ ] `new Date()`, `localStorage`, `window.*`, `document.*` — тільки в `useEffect` або `'use client'` компонентах з `mounted` guard.
- [ ] `createPortal` — обов'язково перевірити наявність `mounted` state (`useEffect(() => setMounted(true), [])`).
- [ ] Сторінки з `(auth)` або іншими folder groups в Next.js App Router — перевірити окремий `layout.tsx` без `AuthProvider` (щоб уникнути circular redirect при SSR).
  ```bash
  grep -rn "new Date()\|localStorage\|window\.\|document\." apps/web/src/app/ --include="*.tsx" | grep -v "useEffect"
  ```

#### Компоненти
- [ ] `Button variant="default"` існує у `Variant` union
- [ ] `Select placeholder` — рендериться як `<option value="" disabled>`
- [ ] `Input`, `Select` мають `label`, `errorMessage`, `hint` пропи
- [ ] `Modal` кнопки передані через `footer` проп, не всередині `children`

#### Tailwind 4 canonical classes
- [ ] `border-border` — не `border-(--color-border)` (якщо токен є в `@theme`)
- [ ] `ring-brand-100` — не `ring-(--color-brand-100)`
- [ ] `hover:border-border-hover` — не `hover:border-(--color-border-hover)`
- [ ] `bg-secondary` — не `bg-(--color-secondary)` (якщо є в `@theme`)
- [ ] **Жодних inline `text-[hsl(...)]` / `border-[hsl(...)]` / `bg-[hsl(...)]` для семантичних кольорів** — використовуй токени: `text-destructive-text`, `border-destructive-border`, `text-success-text`, `text-warning-text`, `text-info-text`. Inline HSL не перемикається в dark mode → WCAG контраст fail.
  ```bash
  grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"
  # Винятки: badge.tsx purple, inventory reserved orange, button.tsx destructive-hover, input/select destructive focus-ring
  ```

#### Роутинг
- [ ] Захищені сторінки мають redirect якщо не авторизований
- [ ] `/setup` доступний без авторизації (перший запуск)
- [ ] **`useRequireAuth` НЕ блокує рендер** — тільки запускає useEffect. Layout/Shell (`TopShell`) повинен мати **render-blocking guard** для не-публічних роутів: якщо `!employee && !isLoading` → return spinner + `router.replace('/login')`. Інакше дочірня сторінка показує власний UI скелетон неавторизованому користувачу (витік структури функціоналу).
  ```typescript
  // ✅ TopShell guard
  const PUBLIC_ROUTES = ['/login', '/setup', '/', '/403'];
  const isPublic = PUBLIC_ROUTES.some(p => pathname === p || pathname.startsWith(`${p}/`));
  useEffect(() => {
    if (!isPublic && !isLoading && !employee) router.replace('/login');
  }, [isPublic, isLoading, employee, router]);
  if (!isPublic && (isLoading || !employee)) return <Spinner />;
  ```

### 1.4 — Тести Backend

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

### 1.5 — Тести Frontend

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
Вони не мокають Prisma — звертаються до реального NestJS application instance з мокнутим PrismaService.

> **Мета:** виявити розрив між `toResponseDto()` у сервісі та `interface` у фронтенді — до того як це зробить користувач.

### Коли писати contract-тест

- Новий `@Controller` → одразу додати `.contract.spec.ts`
- Зміна `toResponseDto()` → оновити snapshot
- Новий endpoint → тест на 401 без токена, 403 з неправильною роллю, 200/201 з валідним тілом

### Структура

```
apps/api/src/modules/{domain}/{domain}.contract.spec.ts
```

### Шаблон contract-тесту

```typescript
// apps/api/src/modules/work-orders/work-orders.contract.spec.ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkOrdersModule } from './work-orders.module';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// Мок PrismaService — тільки ті методи що використовуються
const prismaMock = {
  workOrder: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn().mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr)),
};

// Мок guards — пропускаємо auth, тестуємо тільки HTTP contract
const mockJwtGuard  = { canActivate: vi.fn().mockReturnValue(true) };
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('WorkOrders — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [WorkOrdersModule],
    })
      .overrideProvider(PrismaService).useValue(prismaMock)
      .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
      .overrideGuard(RolesGuard).useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());

  describe('GET /work-orders', () => {
    it('повертає 200 з paginatedShape', async () => {
      prismaMock.$transaction.mockResolvedValueOnce([[], 0]);
      const res = await request(app.getHttpServer()).get('/work-orders').query({ page: 1, limit: 20 });

      expect(res.status).toBe(200);
      // Shape contract — ці поля ОБОВ'ЯЗКОВІ для фронтенду
      expect(res.body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
      });
    });

    it('повертає 401 без авторизації', async () => {
      mockJwtGuard.canActivate.mockReturnValueOnce(false);
      const res = await request(app.getHttpServer()).get('/work-orders');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /work-orders', () => {
    it('повертає 400 при відсутніх обов'язкових полях', async () => {
      const res = await request(app.getHttpServer())
        .post('/work-orders')
        .send({ description: 'без vehicleId і counterpartyId' });
      expect(res.status).toBe(400);
    });

    it('повертає 201 з коректним DTO', async () => {
      prismaMock.workOrder.create.mockResolvedValueOnce({
        id: 'wo-uuid', number: 'WO-2026-0001', status: 'DRAFT',
        totalAmount: 0, totalLabor: 0, totalParts: 0, paidAmount: 0,
        createdAt: new Date(), updatedAt: new Date(),
        vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA1234BB' },
        counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null },
        branch: { name: 'Центр' },
      });
      prismaMock.workOrder.count.mockResolvedValueOnce(0);

      const res = await request(app.getHttpServer())
        .post('/work-orders')
        .send({ vehicleId: 'v-uuid', counterpartyId: 'c-uuid', branchId: 'b-uuid' });

      expect(res.status).toBe(201);
      // Ці поля очікує фронт (WorkOrder interface у page.tsx)
      expect(res.body).toMatchObject({
        id: expect.any(String),
        number: expect.any(String),
        status: expect.any(String),
        vehicle: expect.objectContaining({ make: expect.any(String) }),
        counterparty: expect.any(Object),
      });
    });
  });
});
```

### Що перевіряти в contract-тестах

| Endpoint | Тест-кейси |
|---|---|
| `GET /work-orders` | 200 з pagination shape; 401 без токена |
| `POST /work-orders` | 201 + DTO shape; 400 без обов'яз. полів |
| `PATCH /work-orders/:id/status` | 400 при невалідному FSM-переході (через HTTP) |
| `GET /inventory` | 200 + items[].available присутній |
| `POST /auth/login` | 200 + `{ accessToken, refreshToken, employee }`; 401 при невірному паролі |
| `GET /sync/pull` | 200 + `{ records, maxSyncVersion }` shape |

### Запуск contract-тестів

```bash
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "contract|PASS|FAIL"
```

---

## Крок 4.4 — Property-based тести (fast-check)

Property-based тести генерують **сотні випадкових вхідних даних** і перевіряють інваріанти.
Найефективніші для: FSM (всі можливі пари переходів), фінансових розрахунків (кумулятивні суми), inventory (race conditions).

> **Мета:** знайти edge cases які unit-тест з хардкодженими значеннями не покриє.

### Встановлення fast-check

```bash
# Перевірити наявність
grep "fast-check" apps/api/package.json || echo "NOT INSTALLED"

# Встановити якщо відсутній
pnpm --filter @sto/api add -D fast-check
```

### Шаблон: FSM — всі заборонені переходи

```typescript
// apps/api/src/modules/work-orders/work-orders.fsm.spec.ts
import * as fc from 'fast-check';
import { WorkOrderStatus } from '@prisma/client';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';

const ALL_STATUSES = Object.keys(WORK_ORDER_TRANSITIONS) as WorkOrderStatus[];

describe('WORK_ORDER_TRANSITIONS — property-based', () => {
  it('кожен дозволений перехід є в списку дозволених для джерела', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (from, to) => {
          const allowed = WORK_ORDER_TRANSITIONS[from];
          if (allowed.includes(to)) {
            // якщо дозволений — то від зворотнього: `to` не містить `from` (немає циклів назад крім дозволених)
            return true; // просто перевіряємо що карта консистентна
          }
          // якщо НЕ дозволений — переконатись що заблокований
          return !allowed.includes(to);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('ARCHIVED і CANCELLED — фінальні стани (порожній список переходів)', () => {
    expect(WORK_ORDER_TRANSITIONS['ARCHIVED']).toHaveLength(0);
    expect(WORK_ORDER_TRANSITIONS['CANCELLED']).toHaveLength(0);
  });

  it('будь-який перехід з ARCHIVED або CANCELLED → порожній масив', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ARCHIVED' as WorkOrderStatus, 'CANCELLED' as WorkOrderStatus),
        (terminal) => WORK_ORDER_TRANSITIONS[terminal].length === 0,
      ),
    );
  });
});
```

### Шаблон: Inventory — інваріант балансу

```typescript
// apps/api/src/modules/inventory/inventory.invariants.spec.ts
import * as fc from 'fast-check';
import { StockMovementType } from '@prisma/client';

// Інваріант: після будь-якої послідовності валідних рухів
// quantity >= 0 і reserved >= 0 і available = quantity - reserved >= 0

function applyMovements(movements: { type: StockMovementType; qty: number }[]) {
  let quantity = 0;
  let reserved = 0;

  for (const { type, qty } of movements) {
    switch (type) {
      case 'RECEIPT':
        quantity += qty;
        break;
      case 'RESERVATION':
        if (quantity - reserved < qty) return null; // невалідний — пропускаємо
        reserved += qty;
        break;
      case 'RESERVATION_RELEASE':
        if (reserved < qty) return null;
        reserved -= qty;
        break;
      case 'WRITEOFF':
        if (quantity - reserved < qty) return null;
        quantity -= qty;
        break;
    }
  }
  return { quantity, reserved, available: quantity - reserved };
}

describe('Inventory — balance invariants (property-based)', () => {
  it('після валідних рухів: quantity >= 0, reserved >= 0, available >= 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom<StockMovementType>('RECEIPT', 'RESERVATION', 'RESERVATION_RELEASE', 'WRITEOFF'),
            qty: fc.integer({ min: 1, max: 100 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (movements) => {
          const result = applyMovements(movements);
          if (result === null) return true; // невалідна послідовність — пропускаємо
          return result.quantity >= 0 && result.reserved >= 0 && result.available >= 0;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('RECEIPT завжди збільшує quantity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 1, max: 100 }),
        (initialQty, initialReserved, receiptQty) => {
          fc.pre(initialQty >= initialReserved); // валідний початковий стан
          const before = initialQty;
          const after = before + receiptQty;
          return after > before;
        },
      ),
    );
  });
});
```

### Шаблон: Settlements — кумулятивний баланс

```typescript
// apps/api/src/modules/settlements/settlements.invariants.spec.ts
import * as fc from 'fast-check';

type TxType = 'CHARGE' | 'PAYMENT' | 'PREPAYMENT' | 'REFUND' | 'CREDIT_NOTE';
const BALANCE_INCREASING: TxType[] = ['CHARGE'];
const BALANCE_DECREASING: TxType[] = ['PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'];

function applyTransactions(txs: { type: TxType; amount: number }[]): number {
  return txs.reduce((balance, { type, amount }) => {
    if (BALANCE_INCREASING.includes(type)) return balance + amount;
    if (BALANCE_DECREASING.includes(type)) return balance - amount;
    return balance;
  }, 0);
}

describe('Settlements — balance invariants (property-based)', () => {
  it('тільки CHARGE транзакції збільшують баланс', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0.01, max: 100_000, noNaN: true }),
        (amount) => {
          const before = 0;
          const after = applyTransactions([{ type: 'CHARGE', amount }]);
          return after > before;
        },
      ),
    );
  });

  it('PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE зменшують баланс', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TxType>('PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'),
        fc.float({ min: 0.01, max: 100_000, noNaN: true }),
        (type, amount) => {
          const before = 200_000; // початковий баланс достатньо великий
          const after = before + applyTransactions([{ type, amount }]);
          return after < before;
        },
      ),
    );
  });

  it('сума CHARGE = сума всіх зменшень → balance = 0', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0.01, max: 1000, noNaN: true }), { minLength: 1, maxLength: 10 }),
        (amounts) => {
          const total = amounts.reduce((s, a) => s + a, 0);
          const txs = [
            ...amounts.map(amount => ({ type: 'CHARGE' as TxType, amount })),
            { type: 'PAYMENT' as TxType, amount: total },
          ];
          const balance = applyTransactions(txs);
          return Math.abs(balance) < 0.001; // float tolerance
        },
      ),
    );
  });
});
```

### Запуск property-based тестів

```bash
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "invariant|property|PASS|FAIL"
```

---

## Крок 4.5 — E2E тести (Playwright)

> **Умова запуску:** dev-сервер (`pnpm dev`) повинен бути активним.  
> Якщо `http://localhost:3001` не відповідає — пропустити цей крок, позначити в звіті як "⏭ skipped".

### Перевірка наявності Playwright

```bash
# Чи встановлений Playwright?
test -f apps/web/playwright.config.ts && echo "EXISTS" || echo "NOT INSTALLED"
```

Якщо `NOT INSTALLED` — встановити:

```bash
cd apps/web
pnpm add -D @playwright/test
npx playwright install chromium
```

Створити `apps/web/playwright.config.ts` (якщо відсутній):

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // НЕ використовуємо webServer — dev-сервер запускається окремо
});
```

### Запуск E2E

```bash
# Перевірити що сервер доступний
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -q 200 && echo "OK" || echo "OFFLINE"

# Запустити e2e тести
pnpm --filter @sto/web exec playwright test --reporter=list 2>&1 | tail -40
```

### Структура E2E тестів

```
apps/web/e2e/
  auth.spec.ts          — login, logout, redirect неавторизованого
  work-orders.spec.ts   — список, створення, перехід статусу
  calendar.spec.ts      — відображення слотів, перевірка дати
  inventory.spec.ts     — список товарів, low-stock badge
  customers.spec.ts     — пошук клієнта, картка авто
  setup.spec.ts         — /setup доступний без авторизації
```

### Структура e2e директорії

```
apps/web/e2e/
  smoke.spec.ts           — публічні URL + auth guard (вже є)
  auth.spec.ts            — login/logout flows
  work-orders.spec.ts     — список, CRUD, FSM переходи
  work-order-flow.spec.ts — повний user flow: WO → completion → payment
  calendar.spec.ts        — відображення слотів
  inventory.spec.ts       — список, low-stock badge
  customers.spec.ts       — пошук, картка авто
  setup.spec.ts           — /setup без авторизації
  .auth/
    admin.json            — збережений auth state (gitignored)
```

### Шаблони E2E тестів

```typescript
// apps/web/e2e/auth.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Авторизація', () => {
  test('login happy path', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="login"]', 'admin');
    await page.fill('[name="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/(dashboard|work-orders)/);
  });

  test('login з невірним паролем', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="login"]', 'admin');
    await page.fill('[name="password"]', 'wrong');
    await page.click('button[type="submit"]');
    await expect(page.locator('[role="alert"], .error, [data-error]')).toBeVisible();
  });

  test('неавторизований редиректиться на /login', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/login/);
  });

  test('/setup доступний без авторизації', async ({ page }) => {
    await page.goto('/setup');
    // НЕ редиректить на /login
    await expect(page).not.toHaveURL(/\/login/);
  });
});
```

```typescript
// apps/web/e2e/work-orders.spec.ts
import { test, expect } from '@playwright/test';

// Використати збережений auth state (щоб не логінитись кожен тест)
test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('Замовлення-наряди', () => {
  test('сторінка завантажується без помилок', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1, [data-page-title]')).toBeVisible();
    // Немає error стану
    await expect(page.locator('[data-error-state]')).not.toBeVisible();
  });

  test('показує loading spinner або skeleton при завантаженні', async ({ page }) => {
    // Сповільнити мережу
    await page.route('**/api/**', async route => {
      await new Promise(r => setTimeout(r, 500));
      await route.continue();
    });
    await page.goto('/work-orders');
    // Loading індикатор повинен з'явитись
    const spinner = page.locator('[data-loading], .animate-spin, [role="progressbar"]');
    // Не обов'язково перехоплювати — просто переконатись що сторінка врешті рендерить дані
    await expect(page.locator('table, [data-empty-state], [data-list]')).toBeVisible({ timeout: 10_000 });
  });

  test('empty state якщо немає нарядів', async ({ page }) => {
    // Мок порожньої відповіді
    await page.route('**/work-orders*', route => route.fulfill({
      status: 200,
      body: JSON.stringify({ items: [], total: 0, page: 1, limit: 20 }),
    }));
    await page.goto('/work-orders');
    await expect(page.locator('[data-empty-state]')).toBeVisible();
  });
});
```

```typescript
// apps/web/e2e/setup-auth.ts — глобальний setup для збереження auth state
import { chromium } from '@playwright/test';
import path from 'path';

async function globalSetup() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('http://localhost:3001/login');
  await page.fill('[name="login"]', process.env.E2E_LOGIN ?? 'admin');
  await page.fill('[name="password"]', process.env.E2E_PASSWORD ?? 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|work-orders)/);

  await page.context().storageState({ path: path.join(__dirname, '.auth/admin.json') });
  await browser.close();
}

export default globalSetup;
```

Додати до `playwright.config.ts`:

```typescript
globalSetup: './e2e/setup-auth.ts',
```

### E2E — User Flow тести (критичні бізнес-сценарії)

> User flow тести перевіряють **наскрізні сценарії** від початку до кінця.
> Вони вимагають живого dev-сервера + живої БД (або seeded state).
> Запускай лише якщо dev-сервер онлайн.

```typescript
// apps/web/e2e/work-order-flow.spec.ts
// Сценарій: створити WO → додати роботу → перевести в IN_PROGRESS → COMPLETED → оплатити
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('Work Order — повний lifecycle', () => {
  test('DRAFT → COMPLETED → оплата', async ({ page }) => {
    // 1. Відкрити список нарядів
    await page.goto('/work-orders');
    await expect(page.locator('h1, [data-page-title]')).toBeVisible();

    // 2. Створити новий наряд (якщо є кнопка)
    const createBtn = page.locator('[data-testid="create-work-order"], button:has-text("Новий наряд")');
    if (await createBtn.isVisible()) {
      await createBtn.click();
      // Форма відкрилась
      await expect(page.locator('[role="dialog"], form')).toBeVisible();
      await page.keyboard.press('Escape'); // закрити без збереження
    }

    // 3. Перевірити що сторінка не показує помилок
    await expect(page.locator('[data-error-state], [data-testid="error"]')).not.toBeVisible();
  });

  test('API mock: WO зі статусом IN_PROGRESS показує кнопку COMPLETED', async ({ page }) => {
    // Мок конкретного WO
    await page.route('**/work-orders/wo-test-id', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'wo-test-id', number: 'WO-2026-0001', status: 'IN_PROGRESS',
        totalAmount: 1500, totalLabor: 1000, totalParts: 500, paidAmount: 0,
        description: 'Заміна масла',
        vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA1234BB', year: 2020 },
        counterparty: { id: 'c-1', firstName: 'Іван', lastName: 'Петренко', companyName: null, phone: '+380671234567' },
        branch: { name: 'Центр' },
        lines: [], parts: [], payments: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    }));
    await page.goto('/work-orders/wo-test-id');
    // Кнопка переходу до COMPLETED повинна бути видима
    await expect(page.locator('button:has-text("Виконано"), [data-testid="complete-btn"]'))
      .toBeVisible({ timeout: 5_000 });
  });
});
```

```typescript
// apps/web/e2e/inventory.spec.ts
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('Інвентар', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/inventory');
    await expect(page.locator('h1, [data-page-title]')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('[data-error-state]')).not.toBeVisible();
  });

  test('low-stock badge відображається при API-моку', async ({ page }) => {
    await page.route('**/stock-items*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { id: 'si-1', good: { name: 'Масло 5W40', sku: 'OIL-001', unit: 'л' },
            warehouse: { name: 'Головний склад' }, quantity: 1, reserved: 0, available: 1, minStock: 5 },
        ],
        total: 1, page: 1, limit: 50,
      }),
    }));
    await page.goto('/inventory');
    // Low stock badge або попередження
    await expect(page.locator('[data-testid="low-stock"], .text-red, [class*="warning"]'))
      .toBeVisible({ timeout: 5_000 });
  });

  test('empty state при порожньому складі', async ({ page }) => {
    await page.route('**/stock-items*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, limit: 50 }),
    }));
    await page.goto('/inventory');
    await expect(page.locator('[data-empty-state], [data-testid="empty"]')).toBeVisible({ timeout: 5_000 });
  });
});
```

```typescript
// apps/web/e2e/api-errors.spec.ts — стійкість до API помилок
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('API error resilience', () => {
  const PAGES = ['/work-orders', '/inventory', '/crm', '/calendar', '/invoices'];

  for (const path of PAGES) {
    test(`${path} — показує error state при 500`, async ({ page }) => {
      await page.route('**/api/**', route => route.fulfill({ status: 500, body: 'Internal Server Error' }));
      await page.goto(path);
      // Сторінка не повинна падати/зависати — показує error state або empty state
      await expect(
        page.locator('[data-error-state], [data-empty-state], [data-testid="error"]'),
      ).toBeVisible({ timeout: 10_000 });
    });

    test(`${path} — не крашиться при 404 на конкретний ресурс`, async ({ page }) => {
      // Тільки resource-specific endpoints повертають 404
      await page.route(/\/api\/(work-orders|stock-items|counterparties)\/[a-f0-9-]{36}$/, route =>
        route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }),
      );
      await page.goto(path);
      await expect(page).not.toHaveURL('/403');
      await expect(page).not.toHaveURL('/500');
    });
  }
});
```

### Що робити якщо E2E тест падає

1. Зробити скріншот: `pnpm --filter @sto/web exec playwright test --screenshot=on`
2. Переглянути трейс: `pnpm --filter @sto/web exec playwright show-trace apps/web/test-results/*/trace.zip`
3. Якщо помилка — зафіксувати як Bug в `BUG_REPORT.md` і виправити
4. Якщо тест хибно негативний (flaky через timing) — додати `await expect(...).toBeVisible({ timeout: 8_000 })`
5. Якщо тест шукає `data-testid` якого нема — додати атрибут у компонент і вважати відсутність `data-testid` за LOW bug

---

## Крок 4.6 — Component-тести (Vitest + Testing Library)

Component-тести перевіряють **ізольовані React-компоненти**: рендер, props, взаємодія.
Вони швидші за E2E і ловлять регресії у `ui/` компонентах раніше.

> **Мета:** переконатись що `Button`, `Select`, `Modal`, `Input` рендеряться коректно
> і не ламаються при зміні props або variants.

### Встановлення Testing Library для web

```bash
# Перевірити наявність
grep "@testing-library" apps/web/package.json || echo "NOT INSTALLED"

# Встановити якщо відсутній
pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

Додати до `apps/web/vitest.config.ts` (або створити):

```typescript
// apps/web/vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

```typescript
// apps/web/src/__tests__/setup.ts
import '@testing-library/jest-dom';
```

### Шаблони component-тестів

```typescript
// apps/web/src/components/ui/__tests__/button.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { Button } from '../button';

describe('Button', () => {
  it('рендерить children', () => {
    render(<Button>Зберегти</Button>);
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeInTheDocument();
  });

  it('variant="destructive" додає відповідний клас', () => {
    render(<Button variant="destructive">Видалити</Button>);
    const btn = screen.getByRole('button');
    // Перевіряємо що клас деструктивного стилю застосований
    expect(btn.className).toMatch(/destructive|red|danger/i);
  });

  it('disabled блокує клік', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Кнопка</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading стан показує spinner і відключає кнопку', () => {
    render(<Button loading>Завантаження</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    // Spinner присутній
    expect(btn.querySelector('.animate-spin, [data-spinner]')).toBeTruthy();
  });

  it('всі variant рендеряться без помилок', () => {
    const variants = ['primary', 'secondary', 'outline', 'ghost', 'destructive', 'link', 'default'] as const;
    for (const variant of variants) {
      expect(() => render(<Button variant={variant}>Текст</Button>)).not.toThrow();
    }
  });
});
```

```typescript
// apps/web/src/components/ui/__tests__/select.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, describe } from 'vitest';
import { Select } from '../select';

describe('Select', () => {
  it('рендерить placeholder як disabled option', () => {
    render(
      <Select placeholder="Оберіть статус">
        <option value="DRAFT">Чернетка</option>
        <option value="ACTIVE">Активний</option>
      </Select>,
    );
    const placeholder = screen.getByRole('option', { name: 'Оберіть статус' });
    expect(placeholder).toBeDisabled();
    expect((placeholder as HTMLOptionElement).value).toBe('');
  });

  it('показує errorMessage', () => {
    render(<Select errorMessage="Поле обов'язкове"><option value="1">Один</option></Select>);
    expect(screen.getByText("Поле обов'язкове")).toBeInTheDocument();
  });

  it('показує label', () => {
    render(<Select label="Статус"><option value="1">Один</option></Select>);
    expect(screen.getByText('Статус')).toBeInTheDocument();
  });

  it('hint відображається', () => {
    render(<Select hint="Оберіть зі списку"><option value="1">Один</option></Select>);
    expect(screen.getByText('Оберіть зі списку')).toBeInTheDocument();
  });
});
```

```typescript
// apps/web/src/components/ui/__tests__/modal.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { Modal } from '../modal';

describe('Modal', () => {
  it('не рендерить content якщо isOpen=false', () => {
    render(<Modal isOpen={false} onClose={vi.fn()} title="Тест">Контент</Modal>);
    expect(screen.queryByText('Контент')).not.toBeInTheDocument();
  });

  it('рендерить контент якщо isOpen=true', () => {
    render(<Modal isOpen onClose={vi.fn()} title="Тест">Контент модалки</Modal>);
    expect(screen.getByText('Контент модалки')).toBeInTheDocument();
    expect(screen.getByText('Тест')).toBeInTheDocument();
  });

  it('виклик onClose при натисканні Escape', async () => {
    const onClose = vi.fn();
    render(<Modal isOpen onClose={onClose} title="Тест">Вміст</Modal>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('footer рендерить кнопки', () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Підтвердити"
        footer={<><button>Скасувати</button><button>Підтвердити</button></>}>
        Ви впевнені?
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Підтвердити' })).toBeInTheDocument();
  });
});
```

```typescript
// apps/web/src/components/ui/__tests__/empty-state.test.tsx
import { render, screen } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { EmptyState } from '../empty-state';

describe('EmptyState', () => {
  it('рендерить title і description', () => {
    render(<EmptyState title="Немає нарядів" description="Створіть перший наряд" />);
    expect(screen.getByText('Немає нарядів')).toBeInTheDocument();
    expect(screen.getByText('Створіть перший наряд')).toBeInTheDocument();
  });

  it('рендерить action кнопку якщо передана', () => {
    render(<EmptyState title="Порожньо" action={{ label: 'Додати', onClick: () => {} }} />);
    expect(screen.getByRole('button', { name: 'Додати' })).toBeInTheDocument();
  });
});
```

### Запуск component-тестів

```bash
# Перевірити наявність vitest config
test -f apps/web/vitest.config.ts && echo "EXISTS" || echo "NOT FOUND"

# Запустити
pnpm --filter @sto/web exec vitest run --reporter=verbose 2>&1 | tail -30
```

### Checklist component-тестів

- [ ] `Button` — всі variants рендеряться; disabled блокує клік; loading показує spinner
- [ ] `Select` — placeholder як disabled option; label, errorMessage, hint відображаються
- [ ] `Modal` — закритий не рендерить content; Escape викликає onClose; footer рендерить кнопки
- [ ] `Input` — label, errorMessage, hint відображаються; leftElement/rightElement присутні
- [ ] `EmptyState` — title + description; action кнопка якщо передана

---

## Крок 5 — Фінальний звіт

Виведи підсумок:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧪 РЕЗУЛЬТАТИ ТЕСТУВАННЯ STO ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Знайдено багів:    N (CRITICAL: X / HIGH: Y / MEDIUM: Z / LOW: W)
Виправлено:        N
Залишилось:        0

TypeScript:        ✅ 0 errors
Unit тести:        ✅ N passed / 0 failed
Contract тести:    ✅ N passed  (або ⏭ немає .contract.spec.ts)
Property-based:    ✅ N passed  (або ⏭ fast-check не встановлений)
Component тести:   ✅ N passed  (або ⏭ @testing-library не встановлений)
E2E (Playwright):  ✅ N passed / 0 failed  (або ⏭ dev server offline)
Build:             ✅ OK

Коміти:
  fix(tester): Bug #1 — ...
  fix(tester): Bug #2 — ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Шаблони тестів (copy-paste)

### Backend — service unit test

```typescript
// apps/api/src/modules/{domain}/{domain}.spec.ts
import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WorkOrdersService } from './{domain}.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('{Domain}Service', () => {
  let service: WorkOrdersService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        WorkOrdersService,
        {
          provide: PrismaService,
          useValue: {
            workOrder: {
              findFirst: vi.fn(),
              findMany: vi.fn(),
              create: vi.fn(),
              update: vi.fn(),
              count: vi.fn(),
            },
            $transaction: vi.fn().mockImplementation((fn) =>
              typeof fn === 'function' ? fn(prisma) : Promise.all(fn)
            ),
          },
        },
        // Inject other services as mocks
        { provide: InventoryService, useValue: { createMovement: vi.fn() } },
        { provide: SettlementsService, useValue: { createTransaction: vi.fn() } },
      ],
    }).compile();

    service = module.get(WorkOrdersService);
    prisma = module.get(PrismaService) as unknown as jest.Mocked<PrismaService>;
  });

  describe('transition', () => {
    it('кидає BadRequestException при недозволеному FSM-переході', async () => {
      (prisma.workOrder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'wo-1', orgId: 'org-1', status: 'COMPLETED', deletedAt: null,
      });

      await expect(service.transition('org-1', 'wo-1', 'DRAFT', 'emp-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('резервує запчастини при переході в IN_PROGRESS', async () => {
      // ...
    });
  });
});
```

### Frontend — компонент тест (якщо є jest/vitest для web)

```typescript
// apps/web/src/components/ui/__tests__/select.test.tsx
import { render, screen } from '@testing-library/react';
import { Select } from '../select';

it('рендерить placeholder як disabled option', () => {
  render(
    <Select placeholder="Оберіть...">
      <option value="1">Один</option>
    </Select>
  );
  const placeholder = screen.getByText('Оберіть...');
  expect(placeholder).toBeInTheDocument();
  expect(placeholder.closest('option')).toBeDisabled();
});
```

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

> "Цей баг був передбачений існуючим пунктом у §1.1–§1.4?"

Якщо **НІ** — одразу оновити цей файл (`SKILL.md`):
1. Додати новий пункт у відповідний підрозділ (§1.1 Backend, §1.2 TS, §1.3 Frontend, §1.4 Tests)
2. Якщо баг пов'язаний з бізнес-логікою STO ERP (нова FSM умова, новий інвентарний guard, sync edge case) → §1.1
3. Якщо патерн повторювався в кількох місцях → додати grep команду для виявлення
4. Commit разом з фіксом або окремо: `docs(skills): add <баг> to sto-tester checklist`

**Мета:** кожен баг що пройшов непомічений — робить наступний запуск розумнішим.
