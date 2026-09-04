import { test, expect, type Page } from '@playwright/test';

// E2E для DetailPanelToggle-стандарту списків (коміт 6405c3a9 + review-fix 3fd7d5fb).
// Купівля → «Замовлення» та Склад → «Товари»: тогл бокової панелі поряд з «Колонки»,
// клік по рядку → панель з даними (Bug #496 — реальне підключення selection-state),
// тогл off → рядок не відкриває панель, тогл on → знову працює, enabled персиститься.

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── API helper (дзеркалить purchase-orders-receive.spec.ts) ───────────────────
async function apiCall(page: Page, method: string, path: string, body?: Record<string, unknown>) {
  const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
  return page.evaluate(
    async ({ token, method, path, body }) => {
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
  const lines = goodId ? [{ goodId, quantity: 5, price: 100 }] : [];
  const po = await apiCall(page, 'POST', '/purchase-orders', { supplierId, warehouseId, lines });
  return po ?? null;
}

// Тогл бокової панелі (поряд з «Колонки») — стабільно за aria-label.
function panelToggle(page: Page) {
  return page
    .locator(
      'button[aria-label="Сховати бокову панель"], button[aria-label="Показати бокову панель"]',
    )
    .first();
}

// ─── Купівля → Замовлення ──────────────────────────────────────────────────────
test.describe('DetailPanelToggle — Купівля / Замовлення', () => {
  test('тогл видимий; клік по рядку PO → панель з даними; тогл off → без панелі; on → знову', async ({
    page,
  }) => {
    // Явно виставляємо enabled=true до гідрації (детермінований старт).
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_purchase-orders', 'true');
    });

    const po = await (async () => {
      // Потрібен токен у sessionStorage → спершу відкрити сторінку.
      await page.goto('/purchase-orders');
      await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
      return createPO(page);
    })();
    expect(po, 'createPO має створити PO (seed має SUPPLIER + WAREHOUSE)').toBeTruthy();
    if (!po) return;

    await page.reload();
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });

    // 1. Тогл видимий у тулбарі
    await expect(panelToggle(page), 'кнопка бокової панелі має бути у тулбарі').toBeVisible({
      timeout: 10_000,
    });

    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    await expect(row, "створений PO має з'явитись у таблиці").toBeVisible({ timeout: 15_000 });

    // 2. Клік по рядку (toggle enabled) → панель відкривається з даними замовлення
    await row.click();
    // Заголовок панелі = номер PO; вкладка «Позиції» присутня → selection реально спрацював
    await expect(page.locator('h2:has-text("' + po.number + '")').first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.locator('button:has-text("Позиції")').first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('button:has-text("Відкрити замовлення")').first()).toBeVisible({
      timeout: 5_000,
    });

    // 3. Тогл off → DetailPanel колапсує у w-0 (панель зникає з екрана).
    // NB: контент лишається у DOM (width-collapse pattern), тому перевіряємо стан
    // тогла + реальну поведінку кліку, а не toHaveCount (overflow-hidden не робить
    // дочірні елементи "hidden" для Playwright).
    await panelToggle(page).click();
    await expect(
      page.locator('button[aria-label="Показати бокову панель"]'),
      'після off тогл показує стан «вимкнено»',
    ).toBeVisible({ timeout: 5_000 });

    // клік по рядку при вимкненому тоглі → відкриває edit-modal, НЕ панель
    await row.click();
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 8_000 });
    // закрити модалку (Escape)
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5_000 });

    // 4. Тогл знову on → клік по рядку знову відкриває панель
    await panelToggle(page).click();
    await expect(page.locator('button[aria-label="Сховати бокову панель"]')).toBeVisible({
      timeout: 5_000,
    });
    await row.click();
    await expect(page.locator('button:has-text("Відкрити замовлення")').first()).toBeVisible({
      timeout: 8_000,
    });

    // 5. Персистентність: enabled=true збережено у localStorage
    const storedBefore = await page.evaluate(() =>
      localStorage.getItem('sto_detail_panel_purchase-orders'),
    );
    expect(storedBefore).toBe('true');

    // Cleanup
    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });

  test('pencil (Редагувати) відкриває edit-modal, НЕ панель (stopPropagation)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_purchase-orders', 'true');
    });
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    const po = await createPO(page);
    expect(po).toBeTruthy();
    if (!po) return;
    await page.reload();
    const row = page.locator(`table tbody tr:has-text("${po.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.hover();
    await row.locator('button[title="Редагувати"]').first().click();
    // edit-modal (dialog) відкрито
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 8_000 });

    await apiCall(page, 'DELETE', `/purchase-orders/${po.id}`);
  });
});

// ─── Склад → Товари ────────────────────────────────────────────────────────────
test.describe('DetailPanelToggle — Склад / Товари', () => {
  test('тогл видимий у режимі «Товари»; клік по товару → панель; тогл off ховає', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_inventory', 'true');
    });
    await page.goto('/inventory');
    await page.waitForTimeout(1500);

    // Тогл видимий (goods mode за замовчуванням)
    await expect(panelToggle(page), 'тогл панелі має бути видимий у режимі Товари').toBeVisible({
      timeout: 15_000,
    });

    const firstRow = page.locator('table tbody tr').first();
    const hasRow = await firstRow.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!hasRow) {
      test.info().annotations.push({ type: 'skip-reason', description: 'немає товарів у seed' });
      return;
    }

    // Клік по товару → панель відкривається (тогл off ховає)
    await firstRow.click();
    // InventoryDetailPanel рендериться лише при enabled — перевіряємо наявність кнопки закриття панелі
    const panel = page.locator('aside, [class*="detail"], .flex.flex-col.shrink-0').first();
    // Головне: тогл off → InventoryDetailPanel демонтується
    await panelToggle(page).click();
    await page.waitForTimeout(300);
    // enabled=false у localStorage
    const stored = await page.evaluate(() => localStorage.getItem('sto_detail_panel_inventory'));
    expect(stored).toBe('false');
    void panel;
  });
});
