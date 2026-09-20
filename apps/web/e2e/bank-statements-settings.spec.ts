import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

/**
 * Bank Statements — вкладка налаштувань «Банк-виписки» (Privat24 auto-pull, Фаза 4).
 * Smoke: рендер вкладки (auth-gated), save інтервалу (реальний PATCH), pull-now ставить job
 * (перехоплюємо POST — переконуємось що кнопка викликає правильний endpoint, БЕЗ реального Privat24).
 * Реальний pull SKIP (нема мерчант-акаунту) — mock на межі HTTP, не fake-green.
 */

async function openBankTab(page: import('@playwright/test').Page) {
  await page.goto('/settings?tab=bank-statements');
  await expect(page).toHaveURL(/tab=bank-statements/, { timeout: 15_000 });
  // Заголовок секції авто-підтягування — стабільний індикатор готовності вкладки.
  await page
    .locator('h3:has-text("Авто-підтягування виписки")')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('Налаштування — Банк-виписки (Privat24 auto-pull)', () => {
  test('вкладка рендериться: провайдер-панель + інтервал + кнопки', async ({ page }) => {
    await openBankTab(page);
    // Секція провайдера виписки.
    await expect(page.locator('text=Банк-провайдер виписки').first()).toBeVisible({
      timeout: 10_000,
    });
    // Поле інтервалу + кнопки Зберегти / Підтягнути зараз.
    await expect(page.locator('input[type="number"]').first()).toBeVisible();
    await expect(page.locator('button:has-text("Підтягнути зараз")').first()).toBeVisible();
    // Без Next.js error-overlay.
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('save інтервалу → реальний PATCH /settings/organisation з валідним значенням', async ({
    page,
  }) => {
    await openBankTab(page);
    const input = page.locator('input[type="number"]').first();
    await input.fill('90');

    const [req] = await Promise.all([
      page.waitForRequest(
        r =>
          r.url().includes('/settings/organisation') &&
          r.method() === 'PATCH' &&
          (r.postData() ?? '').includes('bankStatementPollIntervalMinutes'),
        { timeout: 10_000 },
      ),
      page.locator('button:has-text("Зберегти")').first().click(),
    ]);
    const body = JSON.parse(req.postData() ?? '{}');
    expect(body.bankStatementPollIntervalMinutes).toBe(90);
  });

  test('невалідний інтервал (<15) → клієнтська помилка, БЕЗ PATCH', async ({ page }) => {
    await openBankTab(page);
    const input = page.locator('input[type="number"]').first();
    await input.fill('5');

    let patched = false;
    await page.route('**/settings/organisation', route => {
      if (route.request().method() === 'PATCH') patched = true;
      return route.continue();
    });
    await page.locator('button:has-text("Зберегти")').first().click();
    // Повідомлення про діапазон 15–1440.
    await expect(page.locator('text=/від 15 до 1440/').first()).toBeVisible({ timeout: 5_000 });
    expect(patched).toBe(false);
  });

  test('pull-now ставить job: POST /bank-statement-providers/pull-now (mock — job queued)', async ({
    page,
  }) => {
    await openBankTab(page);
    // Перехоплюємо реальний enqueue — переконуємось що кнопка б'є правильний endpoint методом POST.
    // Mock відповідь {queued:true} (щоб не залежати від стану Redis/черги на dev).
    let pullNowHit = false;
    await page.route('**/bank-statement-providers/pull-now', route => {
      if (route.request().method() === 'POST') {
        pullNowHit = true;
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ queued: true }),
        });
      }
      return route.continue();
    });

    await page.locator('button:has-text("Підтягнути зараз")').first().click();
    await expect.poll(() => pullNowHit, { timeout: 10_000 }).toBe(true);
  });
});
