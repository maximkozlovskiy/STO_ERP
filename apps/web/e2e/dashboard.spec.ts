import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Дашборд', () => {
  test('сторінка завантажується без помилок', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('KPI картки відображаються (мін 3 штуки)', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // Чекати завантаження main контейнера
    await expect(page.locator('main').first()).toBeVisible({ timeout: 10_000 });

    // KPI картки використовують класи kpi-card-{blue|amber|green|violet|red}.
    // Локатор — клас починається з "kpi-card-".
    const kpiCards = page.locator('[class*="kpi-card-"]');
    // Очікуємо появу хоча б 3 карток (типово dashboard рендерить 6: В роботі/Очікують/Виручка/Місяць/Несплачені/Низький залишок)
    await expect
      .poll(async () => kpiCards.count(), {
        message: 'Має бути ≥3 KPI картки на дашборді',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(3);

    // Реальна перевірка контенту — хоча б одна картка з відомим лейблом
    await expect(
      page
        .locator('text=/В роботі|Очікують|Виручка сьогодні|Несплачені рахунки|Низький залишок/')
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('quick actions присутні', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // Кнопки швидких дій
    await expect(
      page.locator('a[href*="/work-orders"], button:has-text("Новий наряд")').first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('sidebar навігація — є посилання на основні розділи', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    // Sidebar містить посилання на основні розділи
    await expect(page.locator('a[href*="/work-orders"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('a[href*="/crm"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test('навігація з дашборду на наряди', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // Клік на посилання Наряди
    const woLink = page.locator('a[href*="/work-orders"]').first();
    if (await woLink.isVisible({ timeout: 8_000 })) {
      await woLink.click();
      await expect(page).toHaveURL(/\/work-orders/, { timeout: 10_000 });
    }
  });
});
