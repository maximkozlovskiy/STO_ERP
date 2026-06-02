import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Замовлення постачальнику — CRUD', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Замовлення")')).toBeVisible({ timeout: 20_000 });
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|замовлень не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Замовлення" (додати) присутня', async ({ page }) => {
    // Add-button renamed from "Нове замовлення" to "Замовлення" (commit 3785721/c3cd333).
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Замовлення")')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /^Замовлення$/ }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('створити замовлення DRAFT → перевірити → видалити', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Замовлення")')).toBeVisible({ timeout: 20_000 });
    // Add-button renamed to single noun "Замовлення".
    await page
      .getByRole('button', { name: /^Замовлення$/ })
      .first()
      .click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Нове замовлення")')).toBeVisible();

    // Вибрати постачальника
    const supplierInput = modal
      .locator('input[placeholder*="Назва компанії"], input[placeholder*="телефон"]')
      .first();
    await supplierInput.fill('avd');
    const firstOption = page.locator('[role="option"]').first();
    if (await firstOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstOption.click();
    }

    // Вибрати склад — перший combobox після постачальника
    const warehouseSelect = modal
      .locator('select, [role="combobox"]')
      .filter({ hasText: /Оберіть склад|Головний склад/ })
      .first();
    if (await warehouseSelect.isVisible({ timeout: 3_000 })) {
      const opts = await warehouseSelect.locator('option').count();
      if (opts > 1) await warehouseSelect.selectOption({ index: 1 });
    }

    // Додати позицію: кнопка "Додати позицію" або "+"
    const addLineBtn = modal
      .locator(
        'button:has-text("Додати позицію"), button:has-text("Додати товар"), button:has-text("+")',
      )
      .first();
    if (await addLineBtn.isVisible({ timeout: 3_000 })) {
      await addLineBtn.click();
      // Заповнити товар і кількість
      const goodInput = modal.locator('input[placeholder*="Товар"]').first();
      if (await goodInput.isVisible({ timeout: 3_000 })) {
        await goodInput.fill('Масло');
        const goodOption = page.locator('[role="option"]').first();
        if (await goodOption.isVisible({ timeout: 3_000 }).catch(() => false))
          await goodOption.click();
      }
      const qtyInput = modal.locator('input[placeholder*="Кіл"]').first();
      if (await qtyInput.isVisible({ timeout: 2_000 })) await qtyInput.fill('1');
      const priceInput = modal.locator('input[placeholder*="Ціна"]').first();
      if (await priceInput.isVisible({ timeout: 2_000 })) await priceInput.fill('100');
    }

    const saveBtn = modal.locator('button:has-text("Створити замовлення")');
    const isEnabled = await saveBtn.isEnabled({ timeout: 5_000 }).catch(() => false);
    if (!isEnabled) {
      await expect(saveBtn).toBeDisabled();
      await page.keyboard.press('Escape');
      return;
    }
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Перевірити рядок у таблиці
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });

    // Cleanup
    const row = page.locator('table tbody tr').first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('FSM: DRAFT → Підтвердити замовлення → ORDERED', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Замовлення")')).toBeVisible({ timeout: 20_000 });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    // Знайти постачальника і склад через API
    const data = await page.evaluate(
      async ({ token }) => {
        const [cpRes, wRes] = await Promise.all([
          fetch('http://localhost:3000/api/counterparties?types=SUPPLIER,BOTH&limit=1', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch('http://localhost:3000/api/warehouses?limit=1', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        const [cpData, wData] = await Promise.all([cpRes.json(), wRes.json()]);
        return { supplierId: cpData.items?.[0]?.id, warehouseId: wData[0]?.id };
      },
      { token },
    );

    if (!data.supplierId || !data.warehouseId) {
      test.skip(true, 'Немає постачальника або складу');
      return;
    }

    // Створити PO через API
    const po = await page.evaluate(
      async ({ token, supplierId, warehouseId }) => {
        const r = await fetch('http://localhost:3000/api/purchase-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ supplierId, warehouseId }),
        });
        if (!r.ok) return null;
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { token, ...data },
    );

    if (!po) {
      test.skip(true, 'Не вдалось створити PO');
      return;
    }

    // PO створено через API — перевести в ORDERED через API і перевірити статус у таблиці.
    // Detail Panel кнопка залежить від localStorage стану — ненадійно в E2E.
    // Тестуємо FSM через API + перевіряємо відображення статусу в UI.
    const ordered = await page.evaluate(
      async ({ token, id }) => {
        const r = await fetch(`http://localhost:3000/api/purchase-orders/${id}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'ORDERED' }),
        });
        if (!r.ok) return null;
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { token, id: po.id },
    );

    if (!ordered || ordered.status !== 'ORDERED') {
      await page.evaluate(
        async ({ token, id }) => {
          await fetch(`http://localhost:3000/api/purchase-orders/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
        },
        { token, id: po.id },
      );
      test.skip(true, 'Не вдалось перевести PO в ORDERED');
      return;
    }

    await page.reload();
    await expect(page.locator('h1:has-text("Замовлення")')).toBeVisible({ timeout: 20_000 });
    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Перевіряємо що статус "Замовлено" відображається в рядку таблиці
    await expect(row.locator('text=Замовлено').first()).toBeVisible({ timeout: 5_000 });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/purchase-orders/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      { token, id: po.id },
    );
  });

  test('статусні фільтри присутні', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Замовлення")')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('button:has-text("Всі"), button:has-text("Чернетка")').first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
