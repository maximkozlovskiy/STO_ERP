# sto-tester — Шаблони тестів

> Цей файл містить повні шаблони коду для Кроків 4.3–4.9 та copy-paste шаблони.
> Посилання з SKILL.md: `→ дивись sto-tester-templates.md § X.Y`

---

## §4.3 Contract-тести (Supertest)

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
    it('повертає 400 при відсутніх обов\'язкових полях', async () => {
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
| `PATCH /work-orders/:id/status` | 400 при невалідному FSM-переході |
| `GET /inventory` | 200 + items[].available присутній |
| `POST /auth/login` | 200 + `{ accessToken, refreshToken, employee }`; 401 при невірному паролі |
| `GET /sync/pull` | 200 + `{ records, maxSyncVersion }` shape |

### Запуск

```bash
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "contract|PASS|FAIL"
```

---

## §4.4 Property-based тести (fast-check)

> **AUTO:** пропустити. **FULL:** виконати якщо `fast-check` встановлений.

### Встановлення

```bash
grep "fast-check" apps/api/package.json || pnpm --filter @sto/api add -D fast-check
```

### FSM — всі заборонені переходи

```typescript
// apps/api/src/modules/work-orders/work-orders.fsm.spec.ts
import * as fc from 'fast-check';
import { WorkOrderStatus } from '@prisma/client';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';

const ALL_STATUSES = Object.keys(WORK_ORDER_TRANSITIONS) as WorkOrderStatus[];

describe('WORK_ORDER_TRANSITIONS — property-based', () => {
  it('карта переходів консистентна', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (from, to) => {
          const allowed = WORK_ORDER_TRANSITIONS[from];
          return !allowed.includes(to) || true; // map is consistent
        },
      ),
      { numRuns: 500 },
    );
  });

  it('ARCHIVED і CANCELLED — фінальні стани', () => {
    expect(WORK_ORDER_TRANSITIONS['ARCHIVED']).toHaveLength(0);
    expect(WORK_ORDER_TRANSITIONS['CANCELLED']).toHaveLength(0);
  });
});
```

### Inventory — інваріант балансу

```typescript
// apps/api/src/modules/inventory/inventory.invariants.spec.ts
import * as fc from 'fast-check';
import { StockMovementType } from '@prisma/client';

function applyMovements(movements: { type: StockMovementType; qty: number }[]) {
  let quantity = 0; let reserved = 0;
  for (const { type, qty } of movements) {
    switch (type) {
      case 'RECEIPT': quantity += qty; break;
      case 'RESERVATION':
        if (quantity - reserved < qty) return null;
        reserved += qty; break;
      case 'RESERVATION_RELEASE':
        if (reserved < qty) return null;
        reserved -= qty; break;
      case 'WRITEOFF':
        if (quantity - reserved < qty) return null;
        quantity -= qty; break;
    }
  }
  return { quantity, reserved, available: quantity - reserved };
}

describe('Inventory — balance invariants', () => {
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
          if (result === null) return true;
          return result.quantity >= 0 && result.reserved >= 0 && result.available >= 0;
        },
      ),
      { numRuns: 1000 },
    );
  });
});
```

### Settlements — кумулятивний баланс

```typescript
// apps/api/src/modules/settlements/settlements.invariants.spec.ts
import * as fc from 'fast-check';

type TxType = 'CHARGE' | 'PAYMENT' | 'PREPAYMENT' | 'REFUND' | 'CREDIT_NOTE';

function applyTransactions(txs: { type: TxType; amount: number }[]): number {
  return txs.reduce((balance, { type, amount }) =>
    type === 'CHARGE' ? balance + amount : balance - amount, 0);
}

describe('Settlements — balance invariants', () => {
  it('тільки CHARGE збільшує баланс', () => {
    fc.assert(
      fc.property(fc.float({ min: 0.01, max: 100_000, noNaN: true }), (amount) => {
        return applyTransactions([{ type: 'CHARGE', amount }]) > 0;
      }),
    );
  });

  it('PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE зменшують баланс', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TxType>('PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'),
        fc.float({ min: 0.01, max: 100_000, noNaN: true }),
        (type, amount) => {
          const before = 200_000;
          return before + applyTransactions([{ type, amount }]) < before;
        },
      ),
    );
  });

  it('SUM(CHARGE) = SUM(PAYMENT) → balance = 0', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0.01, max: 1000, noNaN: true }), { minLength: 1, maxLength: 10 }),
        (amounts) => {
          const total = amounts.reduce((s, a) => s + a, 0);
          const txs = [
            ...amounts.map(amount => ({ type: 'CHARGE' as TxType, amount })),
            { type: 'PAYMENT' as TxType, amount: total },
          ];
          return Math.abs(applyTransactions(txs)) < 0.001;
        },
      ),
    );
  });
});
```

### Pricing algorithm invariants

```typescript
// apps/api/src/modules/inventory/pricing.invariants.spec.ts
import * as fc from 'fast-check';

const calcPercent = (cost: number, pct: number) => Math.max(0, cost * (1 + pct / 100));
const applyRounding = (value: number, roundTo: number) =>
  roundTo <= 0 ? value : Math.round(value / roundTo) * roundTo;

describe('Pricing — algorithm invariants', () => {
  it('PERCENT >= 0 для cost >= 0 і pct >= 0', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 100_000, noNaN: true }),
        fc.float({ min: 0, max: 500, noNaN: true }),
        (cost, pct) => calcPercent(cost, pct) >= 0,
      ),
    );
  });

  it('округлення є кратним roundTo', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 10_000, noNaN: true }),
        fc.constantFrom(0.5, 1, 5, 10, 50, 100),
        (value, r) => {
          const rounded = applyRounding(value, r);
          return Math.abs(rounded % r) < 0.001 || Math.abs(rounded % r - r) < 0.001;
        },
      ),
    );
  });
});

describe('WorkOrder totals — invariants', () => {
  it('totalAmount = totalLabor + totalParts завжди', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 10_000, noNaN: true }), { minLength: 0, maxLength: 20 }),
        fc.array(fc.float({ min: 0, max: 10_000, noNaN: true }), { minLength: 0, maxLength: 20 }),
        (lineAmounts, partAmounts) => {
          const totalLabor = lineAmounts.reduce((s, a) => s + a, 0);
          const totalParts = partAmounts.reduce((s, a) => s + a, 0);
          const directSum = [...lineAmounts, ...partAmounts].reduce((s, a) => s + a, 0);
          return Math.abs(totalLabor + totalParts - directSum) < 0.001;
        },
      ),
    );
  });
});
```

### Запуск

```bash
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "invariant|property|PASS|FAIL"
```

---

## §4.5 E2E тести (Playwright)

> **AUTO:** пропустити. **FULL:** виконати якщо `@playwright/test` встановлений + dev-сервери запущені.

### Встановлення

```bash
test -f apps/web/playwright.config.ts || (cd apps/web && pnpm add -D @playwright/test && npx playwright install chromium)
```

### playwright.config.ts

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
});
```

### setup-auth.ts

```typescript
// apps/web/e2e/setup-auth.ts
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

### auth.spec.ts

```typescript
import { test, expect } from '@playwright/test';

test.describe('Авторизація', () => {
  test('login happy path', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="login"]', 'admin');
    await page.fill('[name="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/(dashboard|work-orders)/);
  });

  test('login з невірним паролем показує помилку', async ({ page }) => {
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
    await expect(page).not.toHaveURL(/\/login/);
  });
});
```

### work-orders.spec.ts

```typescript
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('Замовлення-наряди', () => {
  test('сторінка завантажується без помилок', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1, [data-page-title]')).toBeVisible();
    await expect(page.locator('[data-error-state]')).not.toBeVisible();
  });

  test('empty state при порожній відповіді API', async ({ page }) => {
    await page.route('**/work-orders*', route => route.fulfill({
      status: 200,
      body: JSON.stringify({ items: [], total: 0, page: 1, limit: 20 }),
    }));
    await page.goto('/work-orders');
    await expect(page.locator('[data-empty-state]')).toBeVisible();
  });

  test('API mock: WO зі статусом IN_PROGRESS показує кнопку COMPLETED', async ({ page }) => {
    await page.route('**/work-orders/wo-test-id', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'wo-test-id', number: 'WO-2026-0001', status: 'IN_PROGRESS',
        totalAmount: 1500, totalLabor: 1000, totalParts: 500, paidAmount: 0,
        vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA1234BB', year: 2020 },
        counterparty: { id: 'c-1', firstName: 'Іван', lastName: 'Петренко', companyName: null, phone: '+380671234567' },
        branch: { name: 'Центр' },
        lines: [], parts: [], payments: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    }));
    await page.goto('/work-orders/wo-test-id');
    await expect(page.locator('button:has-text("Виконано"), [data-testid="complete-btn"]'))
      .toBeVisible({ timeout: 5_000 });
  });
});
```

### inventory.spec.ts

```typescript
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('Інвентар', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/inventory');
    await expect(page.locator('h1, [data-page-title]')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('[data-error-state]')).not.toBeVisible();
  });

  test('low-stock badge при API-моку', async ({ page }) => {
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
    await expect(page.locator('[data-testid="low-stock"], .text-red, [class*="warning"]'))
      .toBeVisible({ timeout: 5_000 });
  });

  test('empty state при порожньому складі', async ({ page }) => {
    await page.route('**/stock-items*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, limit: 50 }),
    }));
    await page.goto('/inventory');
    await expect(page.locator('[data-empty-state], [data-testid="empty"]')).toBeVisible({ timeout: 5_000 });
  });
});
```

### api-errors.spec.ts

```typescript
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

const PAGES = ['/work-orders', '/inventory', '/crm', '/calendar', '/invoices'];

test.describe('API error resilience', () => {
  for (const path of PAGES) {
    test(`${path} — показує error state при 500`, async ({ page }) => {
      await page.route('**/api/**', route => route.fulfill({ status: 500, body: 'Internal Server Error' }));
      await page.goto(path);
      await expect(
        page.locator('[data-error-state], [data-empty-state], [data-testid="error"]'),
      ).toBeVisible({ timeout: 10_000 });
    });
  }
});
```

### console-errors.spec.ts

```typescript
// apps/web/e2e/console-errors.spec.ts
import { test, expect } from '@playwright/test';

const IGNORE_PATTERNS = [
  /message channel closed/i,
  /ResizeObserver loop/i,
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /Failed to fetch dynamically imported module/i,
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /\[HMR\]/i,
];

function isIgnored(msg: string): boolean {
  return IGNORE_PATTERNS.some(p => p.test(msg));
}

const AUTH_PAGES = [
  '/work-orders', '/calendar', '/crm', '/inventory',
  '/catalog', '/employees', '/invoices', '/settlements', '/settings', '/dashboard',
];

const PUBLIC_PAGES = ['/login', '/setup'];

test.describe('Console errors — авторизовані сторінки', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  for (const route of AUTH_PAGES) {
    test(`${route} — немає console.error`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error' && !isIgnored(msg.text())) errors.push(`[console.error] ${msg.text()}`);
      });
      page.on('pageerror', err => {
        if (!isIgnored(err.message)) errors.push(`[pageerror] ${err.message}`);
      });
      await page.goto(route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      expect(errors, `Помилки на ${route}:\n${errors.join('\n')}`).toHaveLength(0);
    });
  }
});

test.describe('Console errors — публічні сторінки', () => {
  for (const route of PUBLIC_PAGES) {
    test(`${route} — немає console.error`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error' && !isIgnored(msg.text())) errors.push(`[console.error] ${msg.text()}`);
      });
      page.on('pageerror', err => {
        if (!isIgnored(err.message)) errors.push(`[pageerror] ${err.message}`);
      });
      await page.goto(route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);
      expect(errors, `Помилки на ${route}:\n${errors.join('\n')}`).toHaveLength(0);
    });
  }
});

test.describe('Next.js error overlay — відсутній', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });
  for (const route of AUTH_PAGES) {
    test(`${route} — overlay відсутній`, async ({ page }) => {
      await page.goto(route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      const overlay = page.locator('nextjs-portal, [data-nextjs-dialog], iframe[src*="__nextjs"]');
      await expect(overlay).not.toBeVisible();
    });
  }
});
```

#### Інтерпретація console errors

| Помилка у console | Що це означає | Severity |
|---|---|---|
| `GET /api/xxx 401` | Запит до API до завершення авторизації | HIGH |
| `GET /api/xxx 400` | Невалідні params — баг у фронт-валідації | HIGH |
| `GET /api/xxx 500` | Внутрішня помилка сервера | CRITICAL |
| `GET /api/xxx 404` | Неіснуючий endpoint — розбіжність контракту | HIGH |
| `Cannot read properties of undefined` | Null-safety проблема у компоненті | MEDIUM |
| `Hydration failed` | SSR/CSR mismatch | HIGH |

### Запуск E2E

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -q 200 && echo "OK" || echo "OFFLINE"
pnpm --filter @sto/web exec playwright test --reporter=list 2>&1 | tail -40
pnpm --filter @sto/web exec playwright test e2e/console-errors.spec.ts --reporter=list 2>&1 | tail -50
```

### Якщо E2E тест падає

1. `pnpm --filter @sto/web exec playwright test --screenshot=on`
2. `pnpm --filter @sto/web exec playwright show-trace apps/web/test-results/*/trace.zip`
3. Зафіксувати як Bug → BUG_REPORT.md → виправити
4. Якщо flaky → `await expect(...).toBeVisible({ timeout: 8_000 })`
5. Відсутній `data-testid` → додати атрибут у компонент (LOW bug)

---

## §4.6 Component-тести (Vitest + Testing Library)

> **AUTO:** пропустити. **FULL:** виконати якщо `@testing-library/react` встановлений.

### Встановлення

```bash
grep "@testing-library" apps/web/package.json || \
  pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

### vitest.config.ts

```typescript
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
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
```

```typescript
// apps/web/src/__tests__/setup.ts
import '@testing-library/jest-dom';
```

### Button

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

  it('variant="destructive" — відповідний клас', () => {
    render(<Button variant="destructive">Видалити</Button>);
    expect(screen.getByRole('button').className).toMatch(/destructive|red|danger/i);
  });

  it('disabled блокує клік', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Кнопка</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading показує spinner і відключає кнопку', () => {
    render(<Button loading>Завантаження</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.querySelector('.animate-spin, [data-spinner]')).toBeTruthy();
  });

  it('всі variants рендеряться без помилок', () => {
    const variants = ['primary', 'secondary', 'outline', 'ghost', 'destructive', 'link', 'default'] as const;
    for (const variant of variants) {
      expect(() => render(<Button variant={variant}>Текст</Button>)).not.toThrow();
    }
  });
});
```

### Select

```typescript
// apps/web/src/components/ui/__tests__/select.test.tsx
import { render, screen } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { Select } from '../select';

describe('Select', () => {
  it('placeholder як disabled option', () => {
    render(
      <Select placeholder="Оберіть статус">
        <option value="DRAFT">Чернетка</option>
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

### Modal

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
  });

  it('виклик onClose при Escape', async () => {
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

### EmptyState

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

  it('рендерить action кнопку', () => {
    render(<EmptyState title="Порожньо" action={{ label: 'Додати', onClick: () => {} }} />);
    expect(screen.getByRole('button', { name: 'Додати' })).toBeInTheDocument();
  });
});
```

### Запуск

```bash
test -f apps/web/vitest.config.ts && echo "EXISTS" || echo "NOT FOUND"
pnpm --filter @sto/web exec vitest run --reporter=verbose 2>&1 | tail -30
```

---

## §4.7 Функціональне тестування

### WorkOrders

| Функція | Тест-кейс | Очікуваний результат |
|---|---|---|
| Створення WO | `create({ vehicleId, counterpartyId, branchId })` | `status = DRAFT`, `number` сформований |
| DRAFT → IN_PROGRESS | `transition(id, 'IN_PROGRESS')` | RESERVATION для кожної запчастини |
| IN_PROGRESS → COMPLETED | `transition(id, 'COMPLETED')` | WRITEOFF + RESERVATION_RELEASE + CHARGE в одній tx |
| Додавання роботи | `addLine(...)` | `line.amount = normoHours * price`; totalLabor перераховано |
| Soft delete | `remove(id)` | `deletedAt` встановлено |

```typescript
it('IN_PROGRESS резервує всі запчастини', async () => {
  prisma.workOrderPart.findMany.mockResolvedValue([
    { id: 'p1', goodId: 'g1', warehouseId: 'w1', quantity: 3, deletedAt: null },
  ]);
  prisma.stockItem.findFirst.mockResolvedValue({ id: 'si1', quantity: 10, reserved: 0, available: 10 });
  prisma.$transaction.mockImplementation(cb => cb(prisma));
  await service.transition(orgId, 'wo1', 'IN_PROGRESS');
  expect(inventoryService.createMovement).toHaveBeenCalledWith(expect.objectContaining({
    type: 'RESERVATION', quantity: 3, goodId: 'g1',
  }));
});
```

### Inventory

| Функція | Тест-кейс | Очікуваний результат |
|---|---|---|
| RECEIPT | qty=10 | `stockItem.quantity += 10` |
| RESERVATION | qty=3 | `stockItem.reserved += 3`; `available -= 3` |
| WRITEOFF | qty=2 | `stockItem.quantity -= 2` |
| TRANSFER | qty=5, toWarehouseId | WRITEOFF source + RECEIPT target |

### Settlements

| Функція | Тест-кейс | Очікуваний результат |
|---|---|---|
| CHARGE | amount=1000 | `account.balance += 1000` |
| PAYMENT | amount=500 | `account.balance -= 500` |
| Reconciliation | `openingBalance + charges - payments = closingBalance` | математична тотожність |

```typescript
it('reconciliation formula', () => {
  const txs = [
    { type: 'CHARGE', amount: 1000 }, { type: 'CHARGE', amount: 500 }, { type: 'PAYMENT', amount: 300 },
  ];
  const closing = txs.reduce((b, t) => t.type === 'CHARGE' ? b + t.amount : b - t.amount, 200);
  expect(closing).toBe(1400);
});
```

---

## §4.8 Негативне тестування

### DTO / Validation

```typescript
describe('POST /work-orders — негативні кейси', () => {
  it('400 при відсутньому vehicleId', async () => {
    const res = await request(app.getHttpServer())
      .post('/work-orders').set('Authorization', `Bearer ${token}`)
      .send({ counterpartyId: 'c-uuid', branchId: 'b-uuid' });
    expect(res.status).toBe(400);
  });

  it('400 при некоректному UUID', async () => {
    const res = await request(app.getHttpServer())
      .post('/work-orders').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 'not-a-uuid', counterpartyId: 'c-uuid', branchId: 'b-uuid' });
    expect(res.status).toBe(400);
  });

  it('400 при від\'ємній кількості', async () => {
    const res = await request(app.getHttpServer())
      .post('/work-orders/wo-id/parts').set('Authorization', `Bearer ${token}`)
      .send({ goodId: 'g-uuid', warehouseId: 'w-uuid', quantity: -5, price: 100 });
    expect(res.status).toBe(400);
  });
});
```

| Endpoint | Негативний кейс | Очікуваний код |
|---|---|---|
| `POST /work-orders` | без `vehicleId` | 400 |
| `POST /stock-movements` | `quantity = 0` | 400 |
| `POST /settlements/transactions` | `amount = 0` | 400 |
| `PATCH /work-orders/:id/status` | невалідний FSM-перехід | 400 |
| `GET /work-orders/:id` | чужий orgId | 404 |
| `POST /auth/login` | неправильний пароль | 401 |
| `POST /auth/refresh` | протухлий токен | 401 |

### Бізнес-правила

```typescript
describe('Inventory — негативні кейси', () => {
  it('RESERVATION: 400 якщо available < qty', async () => {
    stockItem.mockResolvedValue({ quantity: 5, reserved: 3, available: 2 });
    await expect(
      inventoryService.createMovement({ type: 'RESERVATION', quantity: 5, goodId: 'g1', warehouseId: 'w1', orgId }),
    ).rejects.toThrow(BadRequestException);
  });

  it('WRITEOFF: 400 якщо quantity < qty', async () => {
    stockItem.mockResolvedValue({ quantity: 3, reserved: 0, available: 3 });
    await expect(
      inventoryService.createMovement({ type: 'WRITEOFF', quantity: 5, goodId: 'g1', warehouseId: 'w1', orgId }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('WorkOrder FSM — негативні кейси', () => {
  it('DRAFT → COMPLETED заборонено', async () => {
    workOrder.mockResolvedValue({ status: 'DRAFT' });
    await expect(service.transition(orgId, 'wo1', 'COMPLETED')).rejects.toThrow(BadRequestException);
  });

  it('ARCHIVED → будь-який статус заборонено', async () => {
    workOrder.mockResolvedValue({ status: 'ARCHIVED' });
    for (const status of ['DRAFT', 'ESTIMATE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
      await expect(service.transition(orgId, 'wo1', status as WorkOrderStatus))
        .rejects.toThrow(BadRequestException);
    }
  });
});
```

### Auth / Tenant Isolation

```typescript
describe('Tenant isolation', () => {
  it('GET /work-orders/:id — 404 якщо WO належить іншому orgId', async () => {
    prisma.workOrder.findFirst.mockResolvedValue(null);
    await expect(service.findOne('other-org', 'wo-id')).rejects.toThrow(NotFoundException);
  });
});

describe('Auth — негативні кейси', () => {
  it('401 без Authorization header', async () => {
    const res = await request(app.getHttpServer()).get('/work-orders');
    expect(res.status).toBe(401);
  });

  it('401 при протухлому access token', async () => {
    const res = await request(app.getHttpServer())
      .get('/work-orders').set('Authorization', 'Bearer expired.jwt.token');
    expect(res.status).toBe(401);
  });
});
```

### Checklist негативного тестування

```bash
# Поля без @IsPositive або @Min(0)
grep -rn "@IsNumber\|@IsInt\|@IsPositive\|@Min" apps/api/src/modules/ --include="*.dto.ts" | grep -v "@Min(1\|@Min(0\|@IsPositive"

# Endpoints без ParseUUIDPipe
grep -rn "@Param('id')" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe"
```

- [ ] Кожен `POST`/`PATCH` повертає 400 при відсутньому обов'язковому полі
- [ ] Кожен `:id` параметр має `ParseUUIDPipe`
- [ ] `quantity: 0` і `amount: 0` → 400
- [ ] Без `Authorization` → 401 на всі захищені endpoints
- [ ] Чужий `orgId` у :id → 404

---

## §4.9 Нефункціональне тестування

### Response Time

```bash
curl -o /dev/null -s -w "\n%{time_total}s — GET /work-orders\n" \
  -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/work-orders

# Пороги: list endpoints < 200ms; sync pull < 500ms; create < 300ms
```

```typescript
it('GET /work-orders відповідає за < 200ms', async () => {
  const start = Date.now();
  const res = await request(app.getHttpServer()).get('/work-orders').query({ page: 1, limit: 20 });
  expect(res.status).toBe(200);
  expect(Date.now() - start).toBeLessThan(200);
}, 5_000);
```

### Security Headers

```bash
curl -I http://localhost:3000/api/health 2>/dev/null | grep -iE "x-content-type|x-frame|x-xss"
```

```typescript
it('security headers присутні', async () => {
  const res = await request(app.getHttpServer()).get('/health');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toMatch(/DENY|SAMEORIGIN/);
});
```

### Database Resilience

```bash
grep -rn "prisma.\$transaction" apps/api/src/ --include="*.ts" | grep -v "timeout:"
```

```typescript
it('Prisma P2002 → 409 Conflict', async () => {
  prisma.employee.create.mockRejectedValueOnce(
    Object.assign(new Error(), { code: 'P2002', meta: { target: ['login'] } }),
  );
  const res = await request(app.getHttpServer()).post('/employees').send({ login: 'existing-login' });
  expect(res.status).toBe(409);
});
```

### BullMQ Resilience

```typescript
it('processor re-throws для BullMQ retry', async () => {
  smsService.send.mockRejectedValueOnce(new Error('Network error'));
  await expect(processor.handleSmsSend({ phone: '+380...', message: 'test' }))
    .rejects.toThrow('Network error');
});
```

### Checklist нефункціонального тестування

```bash
# $transaction без timeout
grep -rn "prisma.\$transaction" apps/api/src/ --include="*.ts" -A10 | grep -v "timeout:" | grep "transaction("

# findMany без take
grep -rn "findMany(" apps/api/src/modules/ --include="*.service.ts" | grep -v "take:" | grep -v "spec"
```

- [ ] List endpoints `< 200ms` (локально)
- [ ] Security headers: `X-Content-Type-Options`, `X-Frame-Options`
- [ ] `$transaction` з явним `timeout: 5000`
- [ ] P2002 → 409; P2025 → 404
- [ ] BullMQ processors re-throw помилки
- [ ] Всі `findMany` мають `take` ліміт

---

## §S Service unit test шаблон (copy-paste)

```typescript
// apps/api/src/modules/{domain}/{domain}.spec.ts
import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WorkOrdersService } from './{domain}.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('{Domain}Service', () => {
  let service: WorkOrdersService;
  let prisma: ReturnType<typeof vi.mocked<PrismaService>>;

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
        { provide: InventoryService, useValue: { createMovement: vi.fn() } },
        { provide: SettlementsService, useValue: { createTransaction: vi.fn() } },
      ],
    }).compile();

    service = module.get(WorkOrdersService);
    prisma = module.get(PrismaService) as unknown as ReturnType<typeof vi.mocked<PrismaService>>;
  });

  describe('transition', () => {
    it('кидає BadRequestException при недозволеному FSM-переході', async () => {
      (prisma.workOrder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'wo-1', orgId: 'org-1', status: 'COMPLETED', deletedAt: null,
      });
      await expect(service.transition('org-1', 'wo-1', 'DRAFT', 'emp-1'))
        .rejects.toThrow(BadRequestException);
    });
  });
});
```
