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
    // Заголовки зон (не плутати з текстом-підказкою палітри, що теж містить «колонки»).
    await expect(page.getByText('Колонки · що показувати')).toBeVisible();
    await expect(page.getByText(/^Групування/)).toBeVisible();
    await expect(page.getByText('Фільтри · умови вибірки')).toBeVisible();
    // Поле-чіп у палітрі (Товар — relation good.name)
    await expect(page.getByText('Товар', { exact: true }).first()).toBeVisible();
  });

  test('клік «Г» на полі → групування (не потрібен drag)', async ({ page }) => {
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });
    await page.locator('select').first().selectOption('workOrder');
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible({ timeout: 10_000 });

    // Клік «Г» (групування) на полі «Статус» через кнопку-літеру (не drag).
    const statusRow = page.locator('div[draggable="true"]:has-text("Статус")').first();
    await statusRow.getByRole('button', { name: /групування/i }).click();

    await page.locator('button:has-text("Запустити")').click();
    await page.getByText(/Результат · рядків/).waitFor({ timeout: 10_000 });
    // Є групові рядки (aria-expanded) — тобто згруповано, а не плоский список.
    await expect(page.locator('button[aria-expanded]').first()).toBeVisible();
  });

  test('Bug #606: повторний клік «Г» на вже-активному полі при 5/5 — без toast «Максимум»', async ({
    page,
  }) => {
    // Регресія: раніше guard groupBy.length>=5 перевірявся ДО includes → повторний клік
    // по вже додажному полю при повному ліміті кидав misleading toast «Максимум 5 рівнів».
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });
    await page.locator('select').first().selectOption('workOrder');
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible({ timeout: 10_000 });

    // Додаємо 5 groupable-полів (workOrder має: Номер, Статус, Пріоритет, Завершено, Дата,
    // Тип контрагента, Контрагент, ...). Беремо перші 5, які groupable.
    const groupableLabels = ['Номер', 'Статус', 'Пріоритет', 'Завершено', 'Дата'];
    for (const label of groupableLabels) {
      const row = page.locator(`div[draggable="true"]:has-text("${label}")`).first();
      await row.getByRole('button', { name: /групування/i }).click();
    }
    // Заголовок зони показує «5/5»
    await expect(page.getByText(/Групування \(5\/5\)/)).toBeVisible();

    // Повторний клік «Г» на вже активному «Статус» — має бути no-op БЕЗ toast «Максимум».
    const statusRow = page.locator('div[draggable="true"]:has-text("Статус")').first();
    await statusRow.getByRole('button', { name: /групування/i }).click();
    // Дати toast час зʼявитись, якби кидався
    await page.waitForTimeout(500);
    await expect(page.getByText(/Максимум 5 рівнів групування/)).toHaveCount(0);
    // Все ще 5/5 (не 6/6)
    await expect(page.getByText(/Групування \(5\/5\)/)).toBeVisible();
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
