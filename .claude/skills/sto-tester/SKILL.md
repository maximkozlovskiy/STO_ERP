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
5. Крок 4.5 (E2E Playwright) — якщо dev-сервер доступний, запускай e2e тести
6. Крок 5 — фінальний звіт
7. Оновити MemoryManual.md — Останній commit + стан тестів (БЕЗ запиту)

> Не питай дозволу на виправлення, коміт і оновлення MemoryManual.md — все виконується автоматично.
> Якщо fix потребує міграції БД або змін у shared — зафіксуй як CRITICAL і повідом після завершення.

### Як оновлювати MemoryManual.md (крок 6)

Після фінального коміту — одразу (без запиту) оновити в `MemoryManual.md`:

```markdown
## Останній commit
<hash> <commit message>
Дата: YYYY-MM-DD

## Поточний стан проєкту
TypeScript: ✅ 0 errors  (або ❌ N errors)
Тести:      ✅ N/N passed (або ❌ N failed)
E2E:        ✅ N passed (або ⏭ skipped — dev server offline)
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
- [ ] Жодного `prisma.X.delete()` на бізнес-сутностях

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

#### Роутинг
- [ ] Захищені сторінки мають redirect якщо не авторизований
- [ ] `/setup` доступний без авторизації (перший запуск)

### 1.4 — Тести Backend

Для кожного сервісу перевір, чи існує `.spec.ts` з покриттям:

| Сервіс | Обов'язкові тест-кейси |
|---|---|
| `work-orders.service` | happy path create; FSM invalid transition throws; soft delete; IN_PROGRESS резервує запчастини; COMPLETED списує і виставляє рахунок |
| `inventory.service` | createMovement RECEIPT збільшує qty; RESERVATION зменшує available; WRITEOFF кидає при insufficient stock; qty=0 кидає |
| `settlements.service` | CHARGE збільшує balance; PAYMENT зменшує; немає account → NotFoundException |
| `auth.service` | login happy path; login wrong password; login deleted employee; refresh invalid token |
| `sync.service` | pull фільтрує по orgId і syncVersion; push відхиляє заборонені таблиці; push cross-tenant FK кидає |

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

### Що робити якщо E2E тест падає

1. Зробити скріншот: `npx playwright test --screenshot=on`
2. Переглянути трейс: `npx playwright show-trace test-results/*/trace.zip`
3. Якщо помилка — зафіксувати як Bug в `BUG_REPORT.md` і виправити
4. Якщо тест хибно негативний (flaky через timing) — додати `await expect(...).toBeVisible({ timeout: 5000 })`

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
E2E (Playwright):  ✅ N passed / 0 failed  (або ⏭ skipped — dev server offline)
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
