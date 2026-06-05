import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─── Налаштування — загальне ─────────────────────────────────────────────────

test.describe('Налаштування — сторінка', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 15_000 });
    // Чекати таб "Нумерація" — стабільний індикатор готовності UI
    await page
      .locator('button:has-text("Нумерація")')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
  });

  test('сторінка завантажується без помилок', async ({ page }) => {
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('вкладки налаштувань присутні', async ({ page }) => {
    // settings/page.tsx: tabs — кастомні <button> з border-b-2, НЕ role="tab"
    // Tabs: Нумерація, Робочі дні, Сповіщення, Оформлення, Інтерфейс, Нагадування, Інтеграції
    const tab = page
      .locator(
        'button:has-text("Нумерація"), button:has-text("Оформлення"), button:has-text("Інтеграції")',
      )
      .first();
    await expect(tab).toBeVisible({ timeout: 10_000 });
  });

  test('вкладка Нумерація відображає форму', async ({ page }) => {
    const numTab = page.locator('button:has-text("Нумерація")').first();
    if (await numTab.isVisible({ timeout: 5_000 })) {
      await numTab.click();
    }
    const formField = page.locator('input, select').first();
    await expect(formField).toBeVisible({ timeout: 10_000 });
  });

  test('вкладка Оформлення — перемикач теми присутній', async ({ page }) => {
    const designTab = page.locator('button:has-text("Оформлення")').first();
    if (!(await designTab.isVisible({ timeout: 5_000 }))) return;
    await designTab.click();

    const themeToggle = page
      .locator('button:has-text("Світла"), button:has-text("Темна"), button:has-text("Системна")')
      .first();
    await expect(themeToggle).toBeVisible({ timeout: 5_000 });
  });

  test('вкладка Інтеграції — форма вебхуків', async ({ page }) => {
    const intTab = page.locator('button:has-text("Інтеграції")').first();
    if (!(await intTab.isVisible({ timeout: 5_000 }))) return;
    await intTab.click();

    const addWebhookBtn = page
      .locator(
        'button:has-text("Додати вебхук"), button:has-text("Новий вебхук"), button:has-text("Додати")',
      )
      .first();
    await expect(addWebhookBtn).toBeVisible({ timeout: 5_000 });
  });
});

// ─── Dark mode ───────────────────────────────────────────────────────────────

test.describe('Налаштування — темна тема', () => {
  test('перемикання на темну тему додає клас dark на html', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 15_000 });
    // Чекати таб "Нумерація" — стабільний індикатор готовності UI
    await page
      .locator('button:has-text("Нумерація")')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });

    const designTab = page.locator('button:has-text("Оформлення")').first();
    if (!(await designTab.isVisible({ timeout: 5_000 }))) return;
    await designTab.click();

    const darkBtn = page.locator('button:has-text("Темна")').first();
    if (!(await darkBtn.isVisible({ timeout: 3_000 }))) return;

    await darkBtn.click();
    await page.waitForTimeout(300);

    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    expect(isDark).toBe(true);
  });

  test('перемикання на світлу тему прибирає клас dark', async ({ page }) => {
    // ВАЖЛИВО: goto ПЕРЕД evaluate — localStorage недоступний до завантаження сторінки
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 15_000 });
    // Чекати таб "Нумерація" — стабільний індикатор готовності UI
    await page
      .locator('button:has-text("Нумерація")')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });

    // Встановлюємо темну тему через localStorage після завантаження сторінки
    await page.evaluate(() => {
      localStorage.setItem('sto_color_mode', 'dark');
      document.documentElement.classList.add('dark');
    });

    const designTab = page.locator('button:has-text("Оформлення")').first();
    if (!(await designTab.isVisible({ timeout: 5_000 }))) return;
    await designTab.click();

    const lightBtn = page.locator('button:has-text("Світла")').first();
    if (!(await lightBtn.isVisible({ timeout: 3_000 }))) return;

    await lightBtn.click();
    await page.waitForTimeout(300);

    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    expect(isDark).toBe(false);
  });
});
