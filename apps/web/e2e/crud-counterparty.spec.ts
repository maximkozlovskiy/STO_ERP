import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe.configure({ mode: 'serial' });

const uid = () => Date.now().toString().slice(-6);

// Хелпер: вибрати тип у першому select модалки
async function selectType(modal: import('@playwright/test').Locator, value: string) {
  // select має id="тип" — використовуємо label
  await modal.getByRole('combobox').first().selectOption(value);
}

test.describe('CRM — CRUD контрагента', () => {
  test('створити фізособу-клієнта → перевірити в таблиці → видалити', async ({ page }) => {
    const name = `E2E-${uid()}`;

    await page.goto('/crm');
    await expect(page.locator('button:has-text("Додати")').first()).toBeVisible({
      timeout: 20_000,
    });

    await page.locator('button:has-text("Додати")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Новий контрагент")')).toBeVisible();

    // Тип Клієнт (вже вибрано за замовчуванням — не змінюємо)
    // Ім'я — getByRole щоб уникнути strict violation з placeholder 'Іван'
    await modal.getByRole('textbox', { name: "Ім'я" }).fill(name);
    await modal.getByRole('textbox', { name: 'Прізвище' }).fill('Тест');
    await modal.getByRole('textbox', { name: 'Телефон' }).fill('+380991234567');

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Пошук щоб знайти новий запис (список може бути пагінований)
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="пошук"]')
      .first();
    if (await searchInput.isVisible({ timeout: 3_000 })) {
      await searchInput.fill(name);
      await page.waitForTimeout(500); // debounce
    }

    await expect(page.locator(`table tbody tr:has-text("${name}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    // Видалити
    const row = page.locator(`table tbody tr:has-text("${name}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('створити юрособу-постачальника з ЄДРПОУ → перевірити тип badge', async ({ page }) => {
    const companyName = `E2E-Пост-${uid()}`;

    await page.goto('/crm');
    await expect(page.locator('button:has-text("Додати")').first()).toBeVisible({
      timeout: 20_000,
    });

    await page.locator('button:has-text("Додати")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Вибрати тип Постачальник — перший combobox у діалозі
    await modal.getByRole('combobox').first().selectOption('Постачальник');
    await modal.getByRole('textbox', { name: 'Назва компанії' }).fill(companyName);
    await modal.getByRole('textbox', { name: 'ЄДРПОУ' }).fill('12345678');

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Пошук щоб знайти новий запис
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="пошук"]')
      .first();
    if (await searchInput.isVisible({ timeout: 3_000 })) {
      await searchInput.fill(companyName);
      await page.waitForTimeout(500);
    }
    const row = page.locator(`table tbody tr:has-text("${companyName}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('text=Постачальник')).toBeVisible();

    // Cleanup
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test("клік на рядок → Detail Panel показує ім'я", async ({ page }) => {
    const name = `E2E-Panel-${uid()}`;

    await page.goto('/crm');
    await expect(page.locator('button:has-text("Додати")').first()).toBeVisible({
      timeout: 20_000,
    });

    // Створити
    await page.locator('button:has-text("Додати")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await modal.getByRole('textbox', { name: "Ім'я" }).fill(name);
    await modal.getByRole('textbox', { name: 'Прізвище' }).fill('Тест');
    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Пошук щоб знайти запис у пагінованому списку
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="пошук"]')
      .first();
    if (await searchInput.isVisible({ timeout: 3_000 })) {
      await searchInput.fill(name);
      await page.waitForTimeout(500);
    }

    // Клік на рядок → Detail Panel (URL лишається /crm/)
    const row = page.locator(`table tbody tr:has-text("${name}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // Detail Panel показує ім'я контрагента
    await expect(page.locator(`h2:has-text("${name}")`).first()).toBeVisible({
      timeout: 10_000,
    });

    // Cleanup
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });
});
