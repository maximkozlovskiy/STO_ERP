import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe.configure({ mode: 'serial' });

const uid = () => Date.now().toString().slice(-6);

test.describe('Персонал — CRUD співробітника', () => {
  test('створити механіка → перевірити в таблиці → видалити', async ({ page }) => {
    const firstName = `E2E-${uid()}`;

    await page.goto('/employees');
    // Add-button renamed to single noun "Співробітник" (commit 3785721/c3cd333).
    // Page header is "Співробітники" — exclude that.
    const addBtn = page
      .locator('button:has-text("Співробітник"):not(:has-text("Співробітники"))')
      .first();
    await expect(addBtn).toBeVisible({ timeout: 20_000 });

    await addBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Новий співробітник")')).toBeVisible();

    // Ім'я і прізвище через placeholder (в employees формі лише 1 input[placeholder="Іван"])
    await modal.locator('input[placeholder="Іван"]').fill(firstName);
    await modal.locator('input[placeholder="Коваль"]').fill('Тест');
    // Посада = Механік за замовчуванням — не змінюємо

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    await expect(page.locator(`table tbody tr:has-text("${firstName}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    // Cleanup
    const row = page.locator(`table tbody tr:has-text("${firstName}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('створити адміністратора → перевірити роль badge', async ({ page }) => {
    const firstName = `E2E-Adm-${uid()}`;

    await page.goto('/employees');
    // Add-button renamed to single noun "Співробітник" (commit 3785721/c3cd333).
    // Page header is "Співробітники" — exclude that.
    const addBtn = page
      .locator('button:has-text("Співробітник"):not(:has-text("Співробітники"))')
      .first();
    await expect(addBtn).toBeVisible({ timeout: 20_000 });

    await addBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    await modal.locator('input[placeholder="Іван"]').fill(firstName);
    await modal.locator('input[placeholder="Коваль"]').fill('Тест');

    // Вибрати роль — select "Посада*" (option value = 'ADMIN', text = 'Адміністратор')
    await modal.getByRole('combobox', { name: 'Посада*' }).selectOption('Адміністратор');

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    const row = page.locator(`table tbody tr:has-text("${firstName}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Badge ролі: "Адмін" або "Адміністратор"
    await expect(row.locator('text=/Адмін/')).toBeVisible();

    // Cleanup
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test("форма — кнопка Зберегти disabled без обов'язкових полів", async ({ page }) => {
    await page.goto('/employees');
    // Add-button renamed to single noun "Співробітник" (commit 3785721/c3cd333).
    // Page header is "Співробітники" — exclude that.
    const addBtn = page
      .locator('button:has-text("Співробітник"):not(:has-text("Співробітники"))')
      .first();
    await expect(addBtn).toBeVisible({ timeout: 20_000 });

    await addBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Порожня форма — disabled
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();

    // Тільки ім'я — ще disabled
    await modal.locator('input[placeholder="Іван"]').fill('Тест');
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();

    await modal.getByRole('button', { name: 'Закрити' }).click();
    // useDirtyForm guard fires because the "Ім'я" input was modified.
    // Wait explicitly for the leave button — it MUST appear; relying on isVisible
    // with a tight timeout makes this flaky under parallel load.
    const leaveBtn = page.locator('button:has-text("Покинути")').first();
    await expect(leaveBtn).toBeVisible({ timeout: 5_000 });
    await leaveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 8_000 });
  });
});
