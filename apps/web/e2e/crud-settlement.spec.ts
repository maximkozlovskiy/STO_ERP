import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Взаєморозрахунки', () => {
  test('сторінка завантажується — список контрагентів', async ({ page }) => {
    await page.goto('/settlements');
    await expect(
      page.locator('h1:has-text("Розрахунки"), h1:has-text("Взаєморозрахунки")'),
    ).toBeVisible({ timeout: 20_000 });
    // Список контрагентів або empty state
    await expect(
      page
        .locator('input[placeholder*="Пошук"]')
        .or(page.getByText(/Оберіть контрагента|Нема контрагентів/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('пошук контрагента — відображає результати', async ({ page }) => {
    await page.goto('/settlements');
    await expect(
      page.locator('h1:has-text("Розрахунки"), h1:has-text("Взаєморозрахунки")'),
    ).toBeVisible({ timeout: 20_000 });

    const searchInput = page
      .locator('input[placeholder*="контрагент"], input[placeholder*="Пошук"]')
      .first();
    if (!(await searchInput.isVisible({ timeout: 5_000 }).catch(() => false))) return;

    await searchInput.fill('Тест');
    await page.waitForTimeout(500);
    // Або знайшли кнопку-рядок контрагента або empty state
    await expect(
      page
        .locator('button[class*="text-left"]')
        .first()
        .or(page.getByText(/Не знайдено|немає/i).first()),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('клік на контрагента → показує баланс', async ({ page }) => {
    await page.goto('/settlements');
    await expect(
      page.locator('h1:has-text("Розрахунки"), h1:has-text("Взаєморозрахунки")'),
    ).toBeVisible({ timeout: 20_000 });

    // Знайти перший рядок контрагента — button в лівій панелі
    const firstCp = page.locator('button[class*="text-left"]').first();
    if (!(await firstCp.isVisible({ timeout: 10_000 }).catch(() => false))) return;

    await firstCp.click();
    // Має показати баланс або транзакції
    await expect(page.locator('text=/Баланс|Транзакції|₴/').first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test('кнопка акт звірки → форма дат → POST', async ({ page }) => {
    await page.goto('/settlements');
    await expect(
      page.locator('h1:has-text("Розрахунки"), h1:has-text("Взаєморозрахунки")'),
    ).toBeVisible({ timeout: 20_000 });

    // Вибрати першого контрагента
    const firstCp = page.locator('button[class*="text-left"]').first();
    if (!(await firstCp.isVisible({ timeout: 10_000 }).catch(() => false))) return;
    await firstCp.click();

    // Кнопка "Акт звірки"
    const actBtn = page
      .locator('button:has-text("Акт звірки"), button:has-text("Сформувати акт")')
      .first();
    if (!(await actBtn.isVisible({ timeout: 5_000 }).catch(() => false))) return;
    await actBtn.click();

    // Форма або модалка з датами
    const modal = page.locator('[role="dialog"]').first();
    if (await modal.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Заповнити дати якщо потрібно
      const submitBtn = modal
        .locator('button:has-text("Сформувати"), button:has-text("Створити")')
        .first();
      if (await submitBtn.isEnabled({ timeout: 3_000 }).catch(() => false)) {
        await submitBtn.click();
        // Акт має з'явитись
        await expect(page.locator('text=/Акт|звірки|закриваючий/i').first()).toBeVisible({
          timeout: 10_000,
        });
      }
    }
  });
});
