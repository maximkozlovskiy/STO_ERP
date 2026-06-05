// Перехоплює console.error і page errors на кожній сторінці.
// Запускається з auth state щоб перевіряти авторизований контент.
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
  // 429 Too Many Requests — rate limit при паралельному запуску тестів (dev throttler)
  /429/,
  /Too Many Requests/i,
];

// /dashboard відкриває SSE EventSource → networkidle ніколи не настає.
// /calendar має багато паралельних API-запитів і pollingInterval → networkidle теж не настає.
// Для таких сторінок використовуємо `load` замість `networkidle`.
const LONG_LIVED_CONNECTIONS = ['/dashboard', '/calendar'];

function waitStrategy(route: string): 'load' | 'networkidle' {
  return LONG_LIVED_CONNECTIONS.includes(route) ? 'load' : 'networkidle';
}

function isIgnored(msg: string): boolean {
  return IGNORE_PATTERNS.some(p => p.test(msg));
}

const AUTH_PAGES = [
  '/work-orders',
  '/calendar',
  '/counterparties',
  '/inventory',
  '/catalog',
  '/employees',
  '/invoices',
  '/settlements',
  '/settings',
  '/dashboard',
];

const PUBLIC_PAGES = ['/login', '/setup'];

// Bug #134: під cold Next.js dev compile + fullyParallel браузер може отримати partial JS chunk
// → "Invalid or unexpected token" pageerror. Запуск тестів цього describe послідовно (mode: 'serial')
// дає dev-серверу скомпілювати кожен route без race на сусідніх workers.
// Інші e2e файли залишаються паралельними (через fullyParallel у config).
test.describe.configure({ mode: 'serial' });

test.describe('Console errors — авторизовані сторінки', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  // Bug #134: warm-up — перший route в serial-послідовності викликає cold Next.js compile
  // на shared chunks (vendors, app shell). Зробимо warm-up запит до загального layout перед
  // циклом, щоб уникнути "Invalid or unexpected token" на першому реальному тесті.
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    try {
      // /dashboard рендерить TopShell + повний layout — після цього вендорні chunks у кеші
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000);
    } catch {
      // якщо dashboard впав — не блокуємо решту тестів, retry політика Playwright це покриє
    } finally {
      await ctx.close();
    }
  });

  for (const route of AUTH_PAGES) {
    test(`${route} — немає console.error`, async ({ page }) => {
      const errors: string[] = [];

      page.on('console', msg => {
        if (msg.type() === 'error' && !isIgnored(msg.text())) {
          errors.push(`[console.error] ${msg.text()}`);
        }
      });
      page.on('pageerror', err => {
        if (!isIgnored(err.message)) {
          errors.push(`[pageerror] ${err.message}`);
        }
      });

      await page.goto(route, { waitUntil: waitStrategy(route) });
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
        if (msg.type() === 'error' && !isIgnored(msg.text())) {
          errors.push(`[console.error] ${msg.text()}`);
        }
      });
      page.on('pageerror', err => {
        if (!isIgnored(err.message)) {
          errors.push(`[pageerror] ${err.message}`);
        }
      });

      await page.goto(route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);

      expect(errors, `Помилки на ${route}:\n${errors.join('\n')}`).toHaveLength(0);
    });
  }
});

test.describe('Next.js error overlay — немає відкритого', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  for (const route of AUTH_PAGES) {
    test(`${route} — overlay відсутній`, async ({ page }) => {
      await page.goto(route, { waitUntil: waitStrategy(route) });
      await page.waitForTimeout(1500);

      const overlay = page.locator('nextjs-portal, [data-nextjs-dialog], iframe[src*="__nextjs"]');
      await expect(overlay).not.toBeVisible();
    });
  }
});
