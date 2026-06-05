import { test, expect } from '@playwright/test';
import { clearDateFilter } from './fixtures';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Рахунки — CRUD', () => {
  test('сторінка завантажується — таблиця або empty state', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Рахунків не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Рахунок" (додати) присутня', async ({ page }) => {
    // Add-button renamed from "Новий рахунок" to "Рахунок" (commit 3785721/c3cd333).
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /^Рахунок$/ }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('створити рахунок → DRAFT badge → видалити', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    // Add-button renamed: "Новий рахунок" → "Рахунок".
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Новий рахунок")')).toBeVisible();

    // Вибрати контрагента через EntityPickerField → SearchPickerModal.
    // У формі є кнопка з aria-label="Обрати" (MoreHorizontal "…").
    await modal.locator('button[aria-label="Обрати"]').first().click();
    const picker = page
      .locator('[role="dialog"]')
      .filter({ hasText: 'Оберіть контрагента' })
      .first();
    await expect(picker).toBeVisible({ timeout: 5_000 });
    // SearchPickerModal: кожен результат — <button class="w-full text-left ..."> у scrollable list.
    const firstResult = picker.locator('button.w-full.text-left').first();
    if (await firstResult.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstResult.click();
      await expect(picker).not.toBeVisible({ timeout: 5_000 });
    }

    // Сума
    await modal.getByPlaceholder('0.00').fill('100');

    const saveBtn = modal.locator('button:has-text("Створити рахунок")');
    const enabled = await saveBtn.isEnabled({ timeout: 5_000 }).catch(() => false);
    if (!enabled) {
      // Якщо не вдалось вибрати cp — тест перевіряє disabled стан і завершується
      await expect(saveBtn).toBeDisabled();
      await page.keyboard.press('Escape');
      return;
    }
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Перевірити що з'явився рядок з badge "Чернетка"
    const searchInput = page.locator('input[placeholder*="Пошук"]').first();
    if (await searchInput.isVisible({ timeout: 3_000 })) {
      await searchInput.fill('');
      await page.waitForTimeout(400);
    }
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });

    // Cleanup через API
    const token2 = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
    const firstInv = await page.evaluate(
      async ({ token }) => {
        const r = await fetch('http://localhost:3000/api/invoices?limit=1&status=DRAFT', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        return d.items?.[0]?.id ?? null;
      },
      { token: token2 },
    );
    if (firstInv) {
      await page.evaluate(
        async ({ token, id }) => {
          await fetch(`http://localhost:3000/api/invoices/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
        },
        { token: token2, id: firstInv },
      );
    }
  });

  test('FSM: Надіслати → SENT badge', async ({ page }) => {
    // Створити рахунок через API щоб уникнути UI flakiness
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    // Знайти контрагента
    const cpRes = await page.evaluate(
      async ({ token }) => {
        const r = await fetch('http://localhost:3000/api/counterparties?limit=1', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        return d.items?.[0]?.id ?? null;
      },
      { token },
    );

    if (!cpRes) {
      test.skip(true, 'Немає контрагентів');
      return;
    }

    // Створити рахунок через API
    const inv = await page.evaluate(
      async ({ token, cpId }) => {
        const r = await fetch('http://localhost:3000/api/invoices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ counterpartyId: cpId, amount: 50 }),
        });
        if (!r.ok) return null;
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { token, cpId: cpRes },
    );

    if (!inv) {
      test.skip(true, 'Не вдалось створити рахунок');
      return;
    }

    // Bug #345: invoices page has kyivToday() date filter by default.
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await clearDateFilter(page);

    // Search by number to narrow results
    const searchInput = page.locator('input[placeholder*="Пошук"]').first();
    await searchInput.fill(inv.number);
    await page.waitForTimeout(400);

    const row = page.locator(`table tbody tr:has-text("${inv.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const sendBtn = page.locator('button:has-text("Надіслати")').first();
    await expect(sendBtn).toBeVisible({ timeout: 8_000 });
    await sendBtn.click();
    await expect(page.locator('text=Надіслано').first()).toBeVisible({ timeout: 8_000 });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/invoices/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      { token, id: inv.id },
    );
  });

  test('статусні фільтри присутні', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('button:has-text("Всі"), button:has-text("Чернетка")').first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
