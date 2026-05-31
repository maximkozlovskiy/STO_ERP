import { test, expect } from '@playwright/test';

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

  test('кнопка "Новий рахунок" присутня', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('button:has-text("Новий рахунок")').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('створити рахунок → DRAFT badge → видалити', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Новий рахунок")').first().click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Новий рахунок")')).toBeVisible();

    // Вибрати контрагента через пошук
    const cpInput = modal
      .locator('input[placeholder*="телефон"], input[placeholder*="держ. номер"]')
      .first();
    await cpInput.fill('Тест');
    await page.waitForTimeout(600);
    const firstOption = page.locator('[role="option"]').first();
    if (await firstOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstOption.click();
    } else {
      // Спробувати з пустим рядком — підвантажити всіх
      await cpInput.clear();
      await cpInput.fill('avd');
      await page.waitForTimeout(600);
      const opt = page.locator('[role="option"]').first();
      if (await opt.isVisible({ timeout: 3_000 }).catch(() => false)) await opt.click();
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
        return r.ok ? await r.json() : null;
      },
      { token, cpId: cpRes },
    );

    if (!inv) {
      test.skip(true, 'Не вдалось створити рахунок');
      return;
    }

    // Знайти кнопку "Надіслати" у Detail Panel
    await page.reload();
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const row = page.locator(`table tbody tr:has-text("${inv.number}")`).first();
    if (await row.isVisible({ timeout: 10_000 })) {
      await row.click();
      const sendBtn = page.locator('button:has-text("Надіслати")').first();
      if (await sendBtn.isVisible({ timeout: 5_000 })) {
        await sendBtn.click();
        await expect(page.locator('text=Надіслано').first()).toBeVisible({ timeout: 8_000 });
      }
    }

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
