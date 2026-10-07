# sto-tester — templates-web-e2e

> Частина скіла `sto-tester`; винесено дослівно, щоб кожен файл влазив в один Read.

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
    await page.route('**/work-orders*', route =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ items: [], total: 0, page: 1, limit: 20 }),
      }),
    );
    await page.goto('/work-orders');
    await expect(page.locator('[data-empty-state]')).toBeVisible();
  });

  test('API mock: WO зі статусом IN_PROGRESS показує кнопку COMPLETED', async ({ page }) => {
    await page.route('**/work-orders/wo-test-id', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'wo-test-id',
          number: 'WO-2026-0001',
          status: 'IN_PROGRESS',
          totalAmount: 1500,
          totalLabor: 1000,
          totalParts: 500,
          paidAmount: 0,
          vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA1234BB', year: 2020 },
          counterparty: {
            id: 'c-1',
            firstName: 'Іван',
            lastName: 'Петренко',
            companyName: null,
            phone: '+380671234567',
          },
          branch: { name: 'Центр' },
          lines: [],
          parts: [],
          payments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      }),
    );
    await page.goto('/work-orders/wo-test-id');
    await expect(
      page.locator('button:has-text("Виконано"), [data-testid="complete-btn"]'),
    ).toBeVisible({ timeout: 5_000 });
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
    await page.route('**/stock-items*', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'si-1',
              good: { name: 'Масло 5W40', sku: 'OIL-001', unit: 'л' },
              warehouse: { name: 'Головний склад' },
              quantity: 1,
              reserved: 0,
              available: 1,
              minStock: 5,
            },
          ],
          total: 1,
          page: 1,
          limit: 50,
        }),
      }),
    );
    await page.goto('/inventory');
    await expect(
      page.locator('[data-testid="low-stock"], .text-red, [class*="warning"]'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('empty state при порожньому складі', async ({ page }) => {
    await page.route('**/stock-items*', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, page: 1, limit: 50 }),
      }),
    );
    await page.goto('/inventory');
    await expect(page.locator('[data-empty-state], [data-testid="empty"]')).toBeVisible({
      timeout: 5_000,
    });
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
      await page.route('**/api/**', route =>
        route.fulfill({ status: 500, body: 'Internal Server Error' }),
      );
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
  '/work-orders',
  '/calendar',
  '/crm',
  '/inventory',
  '/catalog',
  '/employees',
  '/invoices',
  '/settlements',
  '/settings',
  '/dashboard',
];

const PUBLIC_PAGES = ['/login', '/setup'];

test.describe('Console errors — авторизовані сторінки', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  for (const route of AUTH_PAGES) {
    test(`${route} — немає console.error`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error' && !isIgnored(msg.text()))
          errors.push(`[console.error] ${msg.text()}`);
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
        if (msg.type() === 'error' && !isIgnored(msg.text()))
          errors.push(`[console.error] ${msg.text()}`);
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

| Помилка у console                     | Що це означає                               | Severity |
| ------------------------------------- | ------------------------------------------- | -------- |
| `GET /api/xxx 401`                    | Запит до API до завершення авторизації      | HIGH     |
| `GET /api/xxx 400`                    | Невалідні params — баг у фронт-валідації    | HIGH     |
| `GET /api/xxx 500`                    | Внутрішня помилка сервера                   | CRITICAL |
| `GET /api/xxx 404`                    | Неіснуючий endpoint — розбіжність контракту | HIGH     |
| `Cannot read properties of undefined` | Null-safety проблема у компоненті           | MEDIUM   |
| `Hydration failed`                    | SSR/CSR mismatch                            | HIGH     |

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

| Функція                 | Тест-кейс                                         | Очікуваний результат                                        |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Створення WO            | `create({ vehicleId, counterpartyId, branchId })` | `status = DRAFT`, `number` сформований                      |
| DRAFT → IN_PROGRESS     | `transition(id, 'IN_PROGRESS')`                   | RESERVATION для кожної запчастини                           |
| IN_PROGRESS → COMPLETED | `transition(id, 'COMPLETED')`                     | WRITEOFF + RESERVATION_RELEASE + CHARGE в одній tx          |
| Додавання роботи        | `addLine(...)`                                    | `line.amount = normoHours * price`; totalLabor перераховано |
| Soft delete             | `remove(id)`                                      | `deletedAt` встановлено                                     |

```typescript
it('IN_PROGRESS резервує всі запчастини', async () => {
  prisma.workOrderPart.findMany.mockResolvedValue([
    { id: 'p1', goodId: 'g1', warehouseId: 'w1', quantity: 3, deletedAt: null },
  ]);
  prisma.stockItem.findFirst.mockResolvedValue({
    id: 'si1',
    quantity: 10,
    reserved: 0,
    available: 10,
  });
  prisma.$transaction.mockImplementation(cb => cb(prisma));
  await service.transition(orgId, 'wo1', 'IN_PROGRESS');
  expect(inventoryService.createMovement).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'RESERVATION',
      quantity: 3,
      goodId: 'g1',
    }),
  );
});
```

### Inventory

| Функція     | Тест-кейс            | Очікуваний результат                        |
| ----------- | -------------------- | ------------------------------------------- |
| RECEIPT     | qty=10               | `stockItem.quantity += 10`                  |
| RESERVATION | qty=3                | `stockItem.reserved += 3`; `available -= 3` |
| WRITEOFF    | qty=2                | `stockItem.quantity -= 2`                   |
| TRANSFER    | qty=5, toWarehouseId | WRITEOFF source + RECEIPT target            |

### Settlements

| Функція        | Тест-кейс                                              | Очікуваний результат      |
| -------------- | ------------------------------------------------------ | ------------------------- |
| CHARGE         | amount=1000                                            | `account.balance += 1000` |
| PAYMENT        | amount=500                                             | `account.balance -= 500`  |
| Reconciliation | `openingBalance + charges - payments = closingBalance` | математична тотожність    |

```typescript
it('reconciliation formula', () => {
  const txs = [
    { type: 'CHARGE', amount: 1000 },
    { type: 'CHARGE', amount: 500 },
    { type: 'PAYMENT', amount: 300 },
  ];
  const closing = txs.reduce((b, t) => (t.type === 'CHARGE' ? b + t.amount : b - t.amount), 200);
  expect(closing).toBe(1400);
});
```

---
