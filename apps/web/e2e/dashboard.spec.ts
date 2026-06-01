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

    // Клік на sidebar посилання Наряди. Sidebar nav — aside або nav елемент.
    // Уникаємо .first() бо перший a[href*="/work-orders"] може бути KPI-картка у main,
    // а не sidebar nav — KPI-картка може мати onClick захист або бути під overlay.
    // Bug: .first() вибирав KPI-картку, клік проходив але навігація не спрацьовувала
    // через Next.js prefetch + hydration lag на повільному CI. Рішення: явно брати
    // sidebar nav link по тексту "Наряди".
    const woLink = page.locator('nav a, aside a').filter({ hasText: 'Наряди' }).first();
    await expect(woLink).toBeVisible({ timeout: 10_000 });
    await Promise.all([page.waitForURL(/\/work-orders/, { timeout: 15_000 }), woLink.click()]);
  });
});
