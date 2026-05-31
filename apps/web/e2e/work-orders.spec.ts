import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─── List page ───────────────────────────────────────────────────────────────

test.describe('Наряди — список', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });
  });

  test('сторінка завантажується без 500', async ({ page }) => {
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('таблиця або empty state відображається', async ({ page }) => {
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Нарядів не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('статусні фільтри присутні', async ({ page }) => {
    await expect(
      page
        .locator('button:has-text("Всі")')
        .or(page.locator('button:has-text("В роботі")'))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Новий наряд" присутня', async ({ page }) => {
    await expect(page.locator('button:has-text("Новий наряд")').first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('пошук — поле введення присутнє', async ({ page }) => {
    await expect(
      page
        .locator('input[placeholder*="номером"]')
        .or(page.locator('input[placeholder*="клієнтом"]'))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});

// ─── Модалка створення ───────────────────────────────────────────────────────

test.describe('Наряди — форма створення', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });
    await expect(page.locator('button:has-text("Новий наряд")').first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('відкривається модалка нового наряду', async ({ page }) => {
    await page.locator('button:has-text("Новий наряд")').first().click();
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 8_000 });
  });

  test('модалка закривається кнопкою Скасувати або Escape', async ({ page }) => {
    await page.locator('button:has-text("Новий наряд")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Modal має кнопку X з aria-label="Закрити"
    const closeBtn = modal.locator('[aria-label="Закрити"]').first();
    if (await closeBtn.isVisible({ timeout: 2_000 })) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });
});

// ─── Картка наряду ───────────────────────────────────────────────────────────

test.describe('Наряди — картка', () => {
  test('картка наряду відкривається з правильним URL', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 10_000 })) {
      await firstRow.click();
      await expect(page).toHaveURL(/\/work-orders\/[a-z0-9-]+/, { timeout: 10_000 });
    }
  });

  test('неіснуючий ID → показує повідомлення "не знайдено"', async ({ page }) => {
    // Bug fix: раніше сторінка зависала на спінері нескінченно.
    // Після фіксу (woLoading state) — показує "Наряд не знайдено" або error message.
    await page.goto('/work-orders/00000000-0000-0000-0000-000000000000');
    await expect(page.getByText(/не знайдено|Наряд не знайдено|not found/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('картка наряду показує статус або FSM-кнопки', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });
    const firstRow = page.locator('table tbody tr').first();
    if (!(await firstRow.isVisible({ timeout: 10_000 }))) return; // немає нарядів у БД — skip

    await firstRow.click();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/\/work-orders\/[a-z0-9-]+/, { timeout: 10_000 });

    // Картка завжди показує або статус-badge, або FSM кнопки (або обидва)
    // Статус-badge є завжди — це мінімальна перевірка що картка відрендерилась
    const statusBadge = page.locator(
      'text=/Чернетка|Кошторис|Затверджено|В роботі|Виконано|Виставлено|Оплачено|Архів|Скасовано/',
    );
    await expect(statusBadge.first()).toBeVisible({ timeout: 10_000 });
  });
});
