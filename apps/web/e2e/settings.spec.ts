import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─── Налаштування — загальне ─────────────────────────────────────────────────

test.describe('Налаштування — сторінка', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
  });

  test('сторінка завантажується без помилок', async ({ page }) => {
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('вкладки налаштувань присутні', async ({ page }) => {
    // Очікуємо хоча б одну вкладку: Організація, Методи оплати, Оформлення тощо
    const tabs = page.locator('[role="tab"], button[data-testid*="tab"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
  });

  test('вкладка Організація відображає форму', async ({ page }) => {
    // Натискаємо на таб Організація (може вже бути активним)
    const orgTab = page
      .locator('[role="tab"]:has-text("Організація"), button:has-text("Організація")')
      .first();
    if (await orgTab.isVisible()) {
      await orgTab.click();
    }
    // Форма з полями організації
    const nameField = page.locator('input, [data-testid*="org"]').first();
    await expect(nameField).toBeVisible({ timeout: 10_000 });
  });

  test('вкладка Оформлення — перемикач теми присутній', async ({ page }) => {
    const designTab = page
      .locator('[role="tab"]:has-text("Оформлення"), button:has-text("Оформлення")')
      .first();
    if (!(await designTab.isVisible({ timeout: 3_000 }))) return;

    await designTab.click();
    // Перемикач тем
    const themeToggle = page
      .locator('button:has-text("Світла"), button:has-text("Темна"), button:has-text("Системна")')
      .first();
    await expect(themeToggle).toBeVisible({ timeout: 5_000 });
  });

  test('вкладка Інтеграції — форма вебхуків', async ({ page }) => {
    const intTab = page
      .locator('[role="tab"]:has-text("Інтеграції"), button:has-text("Інтеграції")')
      .first();
    if (!(await intTab.isVisible({ timeout: 3_000 }))) return;

    await intTab.click();
    const addWebhookBtn = page
      .locator('button:has-text("Додати вебхук"), button:has-text("Новий вебхук")')
      .first();
    await expect(addWebhookBtn).toBeVisible({ timeout: 5_000 });
  });
});

// ─── Dark mode ───────────────────────────────────────────────────────────────

test.describe('Налаштування — темна тема', () => {
  test('перемикання на темну тему додає клас dark на html', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');

    const designTab = page
      .locator('[role="tab"]:has-text("Оформлення"), button:has-text("Оформлення")')
      .first();
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
    // Спочатку встановлюємо темну
    await page.evaluate(() => {
      localStorage.setItem('sto_color_mode', 'dark');
      document.documentElement.classList.add('dark');
    });

    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');

    const designTab = page
      .locator('[role="tab"]:has-text("Оформлення"), button:has-text("Оформлення")')
      .first();
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
