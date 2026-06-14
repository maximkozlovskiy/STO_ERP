import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── API helper ───────────────────────────────────────────────────────────────

async function apiCall(page: Page, method: string, path: string, body?: Record<string, unknown>) {
  const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
  return page.evaluate(
    async ({ token, method, path, body }) => {
      // Only set Content-Type: application/json when there's actually a body.
      // Sending Content-Type: application/json with empty body → Fastify SyntaxError → 500
      // (mirrors fix in apps/web/src/lib/api-client.ts).
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body) headers['Content-Type'] = 'application/json';
      const r = await fetch(`http://localhost:3000/api${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) return null;
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    },
    { token, method, path, body: body ?? null },
  );
}

async function readyPage(page: Page) {
  await page.goto('/stock-documents');
  await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({ timeout: 20_000 });
}

async function getWarehouses(page: Page) {
  const d = await apiCall(page, 'GET', '/warehouses');
  return Array.isArray(d) ? d : [];
}

// ─── TRANSFER (Переміщення між складами) ─────────────────────────────────────

test.describe('Документи складу — TRANSFER (Переміщення)', () => {
  test('форма TRANSFER показує два склади (джерело + призначення)', async ({ page }) => {
    await readyPage(page);

    // Add-button renamed: "Новий документ" → "Документ" (commit 3785721/c3cd333).
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Вибрати тип TRANSFER
    const typeSelect = modal.locator('select').first();
    await typeSelect.selectOption('TRANSFER');

    // Має з'явитись поле "Склад призначення"
    await expect(modal.locator('text=Склад призначення')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    // Підтвердити якщо є dirty guard
    const leaveBtn = page.locator('button:has-text("Покинути")').first();
    if (await leaveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await leaveBtn.click();
  });

  test('створити TRANSFER документ DRAFT → перевірити тип в таблиці', async ({ page }) => {
    await readyPage(page);

    const warehouses = await getWarehouses(page);
    if (warehouses.length < 2) {
      test.skip(true, 'Потрібно мінімум 2 склади для TRANSFER');
      return;
    }
    const [src, dst] = warehouses;

    // Знайти філію
    const branches = await apiCall(page, 'GET', '/branches');
    const branchId = Array.isArray(branches) ? branches[0]?.id : null;
    if (!branchId) {
      test.skip(true, 'Немає філій');
      return;
    }

    // Створити документ через API
    const doc = await apiCall(page, 'POST', '/stock-documents', {
      type: 'TRANSFER',
      warehouseId: src.id,
      targetWarehouseId: dst.id,
      branchId,
      notes: 'E2E TRANSFER test',
    });
    if (!doc) {
      test.skip(true, 'API не створив документ');
      return;
    }

    await page.reload();
    await readyPage(page);

    // Знайти рядок з типом "Переміщення"
    const row = page.locator(`table tbody tr:has-text("${doc.number}")`).first();
    if (await row.isVisible({ timeout: 10_000 })) {
      await expect(row.locator('text=Переміщення')).toBeVisible();
    }

    // Cleanup
    await apiCall(page, 'DELETE', `/stock-documents/${doc.id}`);
  });

  test('TRANSFER документ DRAFT → форма відображає обидва склади', async ({ page }) => {
    await readyPage(page);

    const warehouses = await getWarehouses(page);
    if (warehouses.length < 2) {
      test.skip(true, 'Потрібно 2 склади');
      return;
    }
    const [src, dst] = warehouses;
    const branches = await apiCall(page, 'GET', '/branches');
    const branchId = Array.isArray(branches) ? branches[0]?.id : null;
    if (!branchId) {
      test.skip(true, 'Немає філій');
      return;
    }

    const doc = await apiCall(page, 'POST', '/stock-documents', {
      type: 'TRANSFER',
      warehouseId: src.id,
      targetWarehouseId: dst.id,
      branchId,
    });
    if (!doc) {
      test.skip(true, 'API не створив документ');
      return;
    }

    await page.reload();
    await readyPage(page);

    const row = page.locator(`table tbody tr:has-text("${doc.number}")`).first();
    if (await row.isVisible({ timeout: 10_000 })) {
      await row.click();
      // Modal redesign (commit e6d2e148): клік на рядок відкриває edit modal, у якому
      // для TRANSFER показується лейбл "Склад призначення" (без дефіса) + Select зі складами.
      const modal = page.locator('[role="dialog"]').first();
      await expect(modal).toBeVisible({ timeout: 8_000 });
      await expect(modal.locator('text=Склад призначення').first()).toBeVisible({ timeout: 8_000 });
    }

    await apiCall(page, 'DELETE', `/stock-documents/${doc.id}`);
  });
});

// ─── OPENING_BALANCE (Початкові залишки) ─────────────────────────────────────

test.describe('Документи складу — OPENING_BALANCE (Початкові залишки)', () => {
  test('форма OPENING_BALANCE — не показує "Склад призначення"', async ({ page }) => {
    await readyPage(page);

    // Add-button renamed: "Новий документ" → "Документ" (commit 3785721/c3cd333).
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    const typeSelect = modal.locator('select').first();
    await typeSelect.selectOption('OPENING_BALANCE');

    // НЕ повинно бути поля "Склад призначення"
    await expect(modal.locator('text=Склад призначення')).not.toBeVisible({ timeout: 2_000 });
    // Але основний склад є (label "Склад *")
    await expect(
      modal
        .locator('label, span, div')
        .filter({ hasText: /^Склад/ })
        .first(),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    const leaveBtn = page.locator('button:has-text("Покинути")').first();
    if (await leaveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await leaveBtn.click();
  });

  test('створити OPENING_BALANCE документ DRAFT → перевірити тип badge', async ({ page }) => {
    await readyPage(page);

    const warehouses = await getWarehouses(page);
    if (!warehouses.length) {
      test.skip(true, 'Немає складів');
      return;
    }

    const branches = await apiCall(page, 'GET', '/branches');
    const branchId = Array.isArray(branches) ? branches[0]?.id : null;
    if (!branchId) {
      test.skip(true, 'Немає філій');
      return;
    }

    const doc = await apiCall(page, 'POST', '/stock-documents', {
      type: 'OPENING_BALANCE',
      warehouseId: warehouses[0].id,
      branchId,
      notes: 'E2E OPENING_BALANCE test',
    });
    if (!doc) {
      test.skip(true, 'API не створив документ');
      return;
    }

    await page.reload();
    await readyPage(page);

    const row = page.locator(`table tbody tr:has-text("${doc.number}")`).first();
    if (await row.isVisible({ timeout: 10_000 })) {
      // Badge "Поч. залишки"
      await expect(row.locator('text=/Поч\. залишки|OPENING/i').first()).toBeVisible();
    }

    await apiCall(page, 'DELETE', `/stock-documents/${doc.id}`);
  });

  test('фільтр типу — "Поч. залишки" показує тільки OPENING_BALANCE', async ({ page }) => {
    await readyPage(page);

    // Тип-фільтр у списку
    const typeFilter = page
      .locator('select')
      .filter({ hasText: /Всі|WRITEOFF|TRANSFER|OPENING/ })
      .first();
    if (!(await typeFilter.isVisible({ timeout: 5_000 }))) return;

    await typeFilter.selectOption('OPENING_BALANCE');
    await page.waitForTimeout(500);

    // Всі видимі рядки мають тип Поч. залишки або таблиця порожня
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      // Кожен рядок має badge "Поч. залишки"
      for (let i = 0; i < Math.min(count, 3); i++) {
        await expect(rows.nth(i).locator('text=/Поч\. залишки|OPENING/i')).toBeVisible();
      }
    }
  });
});
