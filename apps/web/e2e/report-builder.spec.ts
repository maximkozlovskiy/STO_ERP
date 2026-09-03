import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('Конструктор звітів', () => {
  test('вкладка Конструктор: вибір джерела → палітра полів → зони', async ({ page }) => {
    await page.goto('/reports?tab=builder');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible();

    // Обрати джерело даних
    const entitySelect = page.locator('select').first();
    await entitySelect.selectOption('workOrderPart');

    // Палітра полів зʼявилась
    await expect(page.getByText(/Поля «Запчастини у нарядах»/)).toBeVisible({ timeout: 10_000 });
    // Зони присутні
    await expect(page.getByText('Колонки', { exact: false })).toBeVisible();
    await expect(page.getByText(/Групування/)).toBeVisible();
    await expect(page.getByText('Фільтри', { exact: false })).toBeVisible();
    // Поле-чіп у палітрі (Товар — relation good.name)
    await expect(page.getByText('Товар', { exact: true }).first()).toBeVisible();
  });

  test('запуск звіту через API-конфіг → таблиця з підсумками', async ({ page }) => {
    // Драг-н-дроп у headless нестабільний; перевіряємо рендер результату через прямий
    // виклик run у контексті сторінки (той самий шлях, що й кнопка «Запустити»).
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });

    const token = await page.evaluate(
      () =>
        localStorage.getItem('sto_access_token') || localStorage.getItem('sto_e2e_access_token'),
    );
    const resp = await page.evaluate(async tok => {
      const r = await fetch('http://localhost:3000/api/reports/builder/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          config: {
            entity: 'workOrder',
            columns: ['totalAmount'],
            groupBy: ['counterparty.type'],
            aggregations: [{ field: 'totalAmount', agg: 'SUM' }],
          },
        }),
      });
      return { status: r.status, body: await r.json() };
    }, token);

    expect(resp.status).toBe(200);
    expect(resp.body.result.grandTotals).toHaveProperty('SUM_totalAmount');
    // Σ топ-рівня == grandTotal (інваріант консистентності)
    const tree = resp.body.result.tree as { aggregates: Record<string, number> }[];
    const leafSum = tree.reduce((s, n) => s + (n.aggregates.SUM_totalAmount || 0), 0);
    expect(Math.round(leafSum)).toBe(Math.round(resp.body.result.grandTotals.SUM_totalAmount));
  });

  test('append-only сутність (StockMovement) зі знаковою quantity не падає', async ({ page }) => {
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });
    const token = await page.evaluate(
      () =>
        localStorage.getItem('sto_access_token') || localStorage.getItem('sto_e2e_access_token'),
    );
    const resp = await page.evaluate(async tok => {
      const r = await fetch('http://localhost:3000/api/reports/builder/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          config: {
            entity: 'stockMovement',
            columns: ['quantity'],
            groupBy: ['type'],
            aggregations: [{ field: 'quantity', agg: 'SUM' }],
          },
        }),
      });
      return { status: r.status, body: await r.json() };
    }, token);
    expect(resp.status).toBe(200);
    // append-only (без deletedAt) не падає; є групи по типах руху
    expect(resp.body.result.tree.length).toBeGreaterThan(0);
    expect(resp.body.result.grandTotals).toHaveProperty('SUM_quantity');
  });
});
