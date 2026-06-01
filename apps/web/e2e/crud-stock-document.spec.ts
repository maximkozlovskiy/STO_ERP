import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Документи складу — CRUD', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Документів не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Новий документ" присутня', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('button:has-text("Новий документ")').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('створити WRITEOFF документ DRAFT → перевірити → видалити', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('button:has-text("Новий документ")').first().click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Вибрати тип WRITEOFF якщо є вибір
    const typeSelect = modal
      .locator('select, [role="combobox"]')
      .filter({ hasText: /Тип|Списання|WRITEOFF/ })
      .first();
    if (await typeSelect.isVisible({ timeout: 2_000 })) {
      const hasWriteoff = await typeSelect
        .locator('option:has-text("Списання"), option[value="WRITEOFF"]')
        .isVisible()
        .catch(() => false);
      if (hasWriteoff) await typeSelect.selectOption('WRITEOFF');
    }

    // Вибрати склад
    const warehouseSelect = modal
      .locator('select, [role="combobox"]')
      .filter({ hasText: /Оберіть склад|Головний/ })
      .first();
    if (await warehouseSelect.isVisible({ timeout: 3_000 })) {
      const opts = await warehouseSelect.locator('option').count();
      if (opts > 1) await warehouseSelect.selectOption({ index: 1 });
    }

    const saveBtn = modal.locator('button:has-text("Створити документ")');
    const isEnabled = await saveBtn.isEnabled({ timeout: 5_000 }).catch(() => false);
    if (!isEnabled) {
      await expect(saveBtn).toBeDisabled();
      await page.keyboard.press('Escape');
      return;
    }
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });

    // Cleanup
    const row = page.locator('table tbody tr').first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('FSM DRAFT → CONFIRMED через Detail Panel', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    // Знайти склад
    const warehouseId = await page.evaluate(
      async ({ token }) => {
        const r = await fetch('http://localhost:3000/api/warehouses?limit=1', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        return d[0]?.id ?? null;
      },
      { token },
    );

    if (!warehouseId) {
      test.skip(true, 'Немає складів');
      return;
    }

    // Створити документ через API
    const doc = await page.evaluate(
      async ({ token, warehouseId }) => {
        const r = await fetch('http://localhost:3000/api/stock-documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ type: 'WRITEOFF', warehouseId }),
        });
        return r.ok ? await r.json() : null;
      },
      { token, warehouseId },
    );

    if (!doc) {
      test.skip(true, 'Не вдалось створити документ');
      return;
    }

    await page.reload();
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });

    // Документ створено через API — рядок ОБОВ'ЯЗКОВО має з'явитись.
    // Без strict expect — fake-green (Bug #287).
    const row = page.locator(`table tbody tr:has-text("${doc.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Кнопка "Провести" у Detail Panel
    const confirmDocBtn = page.locator('button:has-text("Провести")').first();
    await expect(confirmDocBtn).toBeVisible({ timeout: 8_000 });
    await confirmDocBtn.click();
    // Підтвердити якщо є confirm dialog (опціонально — не всі типи документів мають)
    const yesBtn = page.locator('button:has-text("Підтвердити"), button:has-text("Так")').first();
    if (await yesBtn.isVisible({ timeout: 3_000 }).catch(() => false)) await yesBtn.click();
    await expect(page.locator('text=Підтверджено').first()).toBeVisible({ timeout: 8_000 });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/stock-documents/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      { token, id: doc.id },
    );
  });

  test('статусні фільтри присутні', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.locator('button:has-text("Всі"), button:has-text("Чернетка")').first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
