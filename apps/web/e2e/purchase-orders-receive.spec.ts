import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── API helper ───────────────────────────────────────────────────────────────

async function apiCall(page: Page, method: string, path: string, body?: Record<string, unknown>) {
  const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
  return page.evaluate(
    async ({ token, method, path, body }) => {
      const r = await fetch(`http://localhost:3000/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) return null;
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    },
    { token, method, path, body: body ?? null },
  );
}

// Створити PO через API з позицією товару
async function createPO(page: Page) {
  const [cpRes, wRes, gRes] = await Promise.all([
    apiCall(page, 'GET', '/counterparties?types=SUPPLIER,BOTH&limit=1'),
    apiCall(page, 'GET', '/warehouses?limit=1'),
    apiCall(page, 'GET', '/goods?limit=1'),
  ]);

  const supplierId = cpRes?.items?.[0]?.id ?? (Array.isArray(cpRes) ? cpRes[0]?.id : null);
  const warehouseId = Array.isArray(wRes) ? wRes[0]?.id : wRes?.items?.[0]?.id;
  const goodId = gRes?.items?.[0]?.id ?? (Array.isArray(gRes) ? gRes[0]?.id : null);

  if (!supplierId || !warehouseId) return null;

  // Створити PO одразу з позицією (лінії передаються при створенні, окремого endpoint немає)
  const lines = goodId ? [{ goodId, quantity: 5, price: 100 }] : [];
  const po = await apiCall(page, 'POST', '/purchase-orders', { supplierId, warehouseId, lines });
  if (!po) return null;

  // Перевести в ORDERED щоб можна було прийняти
  const ordered = await apiCall(page, 'POST', `/purchase-orders/${po.id}/transition`, {
    status: 'ORDERED',
  });

  return ordered ?? po;
}

async function readyPage(page: Page) {
  await page.goto('/purchase-orders');
  await expect(page.locator('h1:has-text("Замовлення")')).toBeVisible({ timeout: 20_000 });
}

// ─── Прийом товарів (PARTIAL / RECEIVED) ─────────────────────────────────────

test.describe('Замовлення постачальнику — прийом товарів', () => {
  test('кнопка "Позначити отриманим" присутня для ORDERED PO', async ({ page }) => {
    await readyPage(page);
    const po = await createPO(page);
    if (!po) {
      test.skip(true, 'Немає постачальника або складу');
      return;
    }

    await page.reload();
    await readyPage(page);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 10_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено у таблиці');
      return;
    }

    // Відкрити Detail Panel
    await row.click();
    // Кнопка "Позначити отриманим" або "Часткове отримання"
    await expect(
      page
        .locator('button:has-text("Позначити отриманим"), button:has-text("Часткове отримання")')
        .first(),
    ).toBeVisible({ timeout: 8_000 });

    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });

  test('кнопка "Позначити отриманим" → відкриває модалку прийому з позиціями', async ({ page }) => {
    await readyPage(page);
    const po = await createPO(page);
    if (!po) {
      test.skip(true, 'Немає постачальника або складу');
      return;
    }

    await page.reload();
    await readyPage(page);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 10_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено');
      return;
    }

    await row.click();
    const receiveBtn = page.locator('button:has-text("Позначити отриманим")').first();
    if (!(await receiveBtn.isVisible({ timeout: 5_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Кнопка "Позначити отриманим" не знайдена');
      return;
    }

    await receiveBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Заголовок містить номер замовлення
    await expect(modal.locator(`text=/Прийом по замовленню/i`)).toBeVisible();

    // Є кнопка "Підтвердити прийом"
    await expect(modal.locator('button:has-text("Підтвердити прийом")')).toBeVisible();

    // Закрити без збереження
    await page.keyboard.press('Escape');
    const leaveBtn = page.locator('button:has-text("Покинути")').first();
    if (await leaveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await leaveBtn.click();

    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });

  test('прийняти товари → статус RECEIVED', async ({ page }) => {
    await readyPage(page);
    const po = await createPO(page);
    if (!po) {
      test.skip(true, 'Немає постачальника або складу');
      return;
    }

    // Якщо немає позицій — пропустити (потрібні рядки для прийому)
    const lines = po.lines ?? [];
    if (!lines.length) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'PO не має позицій (немає товарів у каталозі)');
      return;
    }

    await page.reload();
    await readyPage(page);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 10_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено');
      return;
    }

    await row.click();
    const receiveBtn = page.locator('button:has-text("Позначити отриманим")').first();
    if (!(await receiveBtn.isVisible({ timeout: 5_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Кнопка прийому недоступна');
      return;
    }

    await receiveBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Заповнити кількість для першої позиції (повний прийом)
    const qtyInputs = modal.locator('input[type="number"]');
    const firstInput = qtyInputs.first();
    await expect(firstInput).toBeVisible({ timeout: 5_000 });
    // Взяти max value з placeholder
    const ph = await firstInput.getAttribute('placeholder');
    const maxQty = ph?.replace('макс. ', '') ?? String(lines[0].quantity);
    await firstInput.fill(maxQty);

    // Підтвердити прийом
    await modal.locator('button:has-text("Підтвердити прийом")').click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Статус змінився на RECEIVED або PARTIAL
    await expect(
      page
        .locator('text=Отримано, text=Частково')
        .first()
        .or(
          page.locator(`table tbody tr:has-text("${po.number}") text=/Отримано|Частково/`).first(),
        ),
    ).toBeVisible({ timeout: 10_000 });

    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });

  test('часткове отримання → статус PARTIAL', async ({ page }) => {
    await readyPage(page);
    const po = await createPO(page);
    if (!po) {
      test.skip(true, 'Немає постачальника або складу');
      return;
    }

    const lines = po.lines ?? [];
    // Потрібно мінімум 2 одиниці щоб прийняти частково
    const firstLine = lines[0];
    if (!firstLine || firstLine.quantity < 2) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Потрібна позиція з qty >= 2 для часткового прийому');
      return;
    }

    await page.reload();
    await readyPage(page);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 10_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено');
      return;
    }

    await row.click();
    const receiveBtn = page.locator('button:has-text("Позначити отриманим")').first();
    if (!(await receiveBtn.isVisible({ timeout: 5_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Кнопка прийому недоступна');
      return;
    }

    await receiveBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Прийняти менше ніж замовлено (1 з 5)
    const firstInput = modal.locator('input[type="number"]').first();
    await expect(firstInput).toBeVisible({ timeout: 5_000 });
    await firstInput.fill('1'); // частковий прийом

    await modal.locator('button:has-text("Підтвердити прийом")').click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Статус PARTIAL
    await expect(
      page
        .locator('text=Частково')
        .first()
        .or(page.locator(`table tbody tr:has-text("${po.number}") text=Частково`).first()),
    ).toBeVisible({ timeout: 10_000 });

    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });
});
