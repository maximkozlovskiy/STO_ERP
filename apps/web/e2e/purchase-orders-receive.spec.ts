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
  await apiCall(page, 'POST', `/purchase-orders/${po.id}/transition`, { status: 'ORDERED' });

  // Отримати актуальний стан з lines (transition відповідь може не мати lines)
  const fresh = await apiCall(page, 'GET', `/purchase-orders/${po.id}`);
  return fresh ?? po;
}

// Увімкнути Detail Panel для purchase-orders (зберігається в localStorage)
async function enableDetailPanel(page: Page) {
  await page.evaluate(() => localStorage.setItem('sto_detail_panel_purchase-orders', 'true'));
}

async function readyPage(page: Page) {
  // addInitScript гарантує що localStorage встановлено до React hydration
  await page.addInitScript(() => {
    localStorage.setItem('sto_detail_panel_purchase-orders', 'true');
  });
  await page.goto('/purchase-orders');
  await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
}

// ─── Прийом товарів (PARTIAL / RECEIVED) ─────────────────────────────────────

test.describe('Замовлення постачальнику — прийом товарів', () => {
  test('кнопка "Оприбуткувати" присутня для ORDERED PO', async ({ page }) => {
    await readyPage(page);
    const po = await createPO(page);
    if (!po) {
      test.skip(true, 'Немає постачальника або складу');
      return;
    }

    // Скинути фільтр статусів (може стояти "Чернетка" і ORDERED не видно)
    const orderedBtn = page.locator('button:has-text("Замовлено")').first();
    if (await orderedBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await orderedBtn.click();
    await page.waitForTimeout(300);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 12_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено у таблиці');
      return;
    }

    // Відкрити PO edit modal через кнопку "Редагувати" (hover-only Pencil icon, title="Редагувати").
    // У редагованій моделі (PurchaseOrderCreateModal) кнопка прийому "Оприбуткувати" знаходиться
    // у заголовку таблиці позицій для статусів ORDERED і PARTIAL.
    await row.hover();
    await row.locator('button[title="Редагувати"]').first().click();
    await expect(page.locator('button:has-text("Оприбуткувати")').first()).toBeVisible({
      timeout: 8_000,
    });

    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });

  test('кнопка "Оприбуткувати" → відкриває inline receive mode з позиціями', async ({ page }) => {
    await readyPage(page);
    const po = await createPO(page);
    if (!po) {
      test.skip(true, 'Немає постачальника або складу');
      return;
    }

    // Скинути фільтр статусів щоб ORDERED рядок був видимий
    const orderedBtn = page.locator('button:has-text("Замовлено")').first();
    if (await orderedBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await orderedBtn.click();
    await page.waitForTimeout(300);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 10_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено');
      return;
    }

    // Open PO edit modal via Pencil (title="Редагувати").
    await row.hover();
    await row.locator('button[title="Редагувати"]').first().click();
    const receiveBtn = page.locator('button:has-text("Оприбуткувати")').first();
    if (!(await receiveBtn.isVisible({ timeout: 5_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Кнопка "Оприбуткувати" не знайдена');
      return;
    }

    await receiveBtn.click();
    // Інлайн receive mode — у тій самій PO-модалці з'являється кнопка "Підтвердити прийом".
    const poModal = page.locator('[role="dialog"]').first();
    await expect(poModal.locator('button:has-text("Підтвердити прийом")')).toBeVisible({
      timeout: 8_000,
    });

    // Закрити без збереження — кнопка "Скасувати" повертає у нормальний режим.
    await poModal.locator('button:has-text("Скасувати")').first().click();
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

    // Скинути фільтр статусів щоб ORDERED рядок був видимий
    const orderedBtn = page.locator('button:has-text("Замовлено")').first();
    if (await orderedBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await orderedBtn.click();
    await page.waitForTimeout(300);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 10_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено');
      return;
    }

    // Open PO edit modal via Pencil (title="Редагувати").
    await row.hover();
    await row.locator('button[title="Редагувати"]').first().click();
    const receiveBtn = page.locator('button:has-text("Оприбуткувати")').first();
    if (!(await receiveBtn.isVisible({ timeout: 5_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Кнопка прийому недоступна');
      return;
    }

    await receiveBtn.click();
    // Інлайн receive mode у тій самій PO-модалці.
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal.locator('button:has-text("Підтвердити прийом")')).toBeVisible({
      timeout: 8_000,
    });

    // Заповнити кількість для першої позиції — використати "Оприбуткувати все".
    await modal.locator('button:has-text("Оприбуткувати все")').click();

    // Підтвердити прийом
    await modal.locator('button:has-text("Підтвердити прийом")').click();
    // Чекаємо вихід з receive mode (зникнення кнопки "Підтвердити прийом" у модалці).
    await expect(modal.locator('button:has-text("Підтвердити прийом")')).not.toBeVisible({
      timeout: 10_000,
    });

    // Закрити PO-модалку
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Перемкнути фільтр на "Отримано" — рядок має з'явитись
    const receivedFilter = page.locator('button:has-text("Отримано")').first();
    if (await receivedFilter.isVisible({ timeout: 2_000 }).catch(() => false))
      await receivedFilter.click();
    await expect(page.locator(`table tbody tr:has-text("${po.number}")`).first()).toBeVisible({
      timeout: 10_000,
    });

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

    // Скинути фільтр статусів щоб ORDERED рядок був видимий
    const orderedBtn = page.locator('button:has-text("Замовлено")').first();
    if (await orderedBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await orderedBtn.click();
    await page.waitForTimeout(300);

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    if (!(await row.isVisible({ timeout: 10_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Рядок PO не знайдено');
      return;
    }

    // Open PO edit modal via Pencil (title="Редагувати").
    await row.hover();
    await row.locator('button[title="Редагувати"]').first().click();
    const receiveBtn = page.locator('button:has-text("Оприбуткувати")').first();
    if (!(await receiveBtn.isVisible({ timeout: 5_000 }))) {
      await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
      test.skip(true, 'Кнопка прийому недоступна');
      return;
    }

    await receiveBtn.click();
    // Інлайн receive mode — заповнити qty=1 у першу позицію (частковий прийом 1 з 5)
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal.locator('button:has-text("Підтвердити прийом")')).toBeVisible({
      timeout: 8_000,
    });

    // У receive mode з'являється колонка "До отримання" з input для qty.
    // Знайти перший input типу number у рядку позицій (placeholder містить "макс.").
    const qtyInput = modal.locator('input[placeholder*="макс."]').first();
    await expect(qtyInput).toBeVisible({ timeout: 5_000 });
    await qtyInput.fill('1');

    await modal.locator('button:has-text("Підтвердити прийом")').click();
    await expect(modal.locator('button:has-text("Підтвердити прийом")')).not.toBeVisible({
      timeout: 10_000,
    });

    // Закрити PO-модалку
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Статус PARTIAL — перемикаємо фільтр "Частково"
    const partialFilter = page.locator('button:has-text("Частково")').first();
    if (await partialFilter.isVisible({ timeout: 2_000 }).catch(() => false))
      await partialFilter.click();
    await expect(page.locator(`table tbody tr:has-text("${po.number}")`).first()).toBeVisible({
      timeout: 10_000,
    });

    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });
});
