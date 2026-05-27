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
      await page.goto(route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);

      const overlay = page.locator('nextjs-portal, [data-nextjs-dialog], iframe[src*="__nextjs"]');
      await expect(overlay).not.toBeVisible();
    });
  }
});
