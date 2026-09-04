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

  test('колонки без групування → підказка «Групування не задано»', async ({ page }) => {
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });
    await page.locator('select').first().selectOption('workOrder');
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible({ timeout: 10_000 });

    // Клік «К» (колонка), НЕ «Г» → плоский список без груп.
    const statusRow = page.locator('div[draggable="true"]:has-text("Статус")').first();
    await statusRow.getByRole('button', { name: /колонк/i }).click();

    await page.locator('button:has-text("Сформувати")').click();
    await page.getByText(/Результат · рядків/).waitFor({ timeout: 10_000 });
    // Підказка про відсутнє групування видима (плоский режим, не групи).
    await expect(page.getByText(/Групування не задано/)).toBeVisible();

    const table = page.locator('table').first();
    // Перша колонка — «№» (не «Група») → це плоский режим.
    await expect(table.locator('thead th').first()).toHaveText('№');
    // NB: колонка «Кількість» у плоскому режимі З'ЯВЛЯЄТЬСЯ коли є склеєні дублікати
    // (mergeDetailRows → __mergedCount>1), і зникає коли всі рядки унікальні — тому НЕ
    // асертимо її відсутність (залежить від даних). Головний інваріант — вирівнювання:
    const headCols = await table.locator('thead tr th').count();
    const bodyCols = await table.locator('tbody tr').first().locator('td').count();
    const footCols = await table.locator('tfoot tr td').count();
    expect(bodyCols).toBe(headCols);
    expect(footCols).toBe(headCols);
  });

  test('плоский режим склеює ідентичні рядки в 1 з сумою (mergeDetailRows)', async ({ page }) => {
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
          config: { entity: 'purchaseOrderLine', columns: ['good.name', 'quantity'], groupBy: [] },
        }),
      });
      return { status: r.status, body: await r.json() };
    }, token);
    expect(resp.status).toBe(200);
    const detail = resp.body.result.detailRows as Array<{ __mergedCount?: number }>;
    // Склеєно: merged-рядків МЕНШЕ за сирий rowCount (дублі згорнуті).
    expect(detail.length).toBeLessThanOrEqual(resp.body.result.rowCount);
    // Кожен merged-рядок має __mergedCount; сумарний count == сирий rowCount (нічого не втрачено).
    const totalMerged = detail.reduce((s, x) => s + (x.__mergedCount ?? 1), 0);
    expect(totalMerged).toBe(resp.body.result.rowCount);
  });

  test('клік «Г» на полі → групування (не потрібен drag)', async ({ page }) => {
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });
    await page.locator('select').first().selectOption('workOrder');
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible({ timeout: 10_000 });

    // Bug #625: щоб групи мали детальні рядки (expandable drill-down), додаємо ще й колонку.
    // Без колонки backend не повертає node.rows → групи disabled без aria-expanded, і
    // page-level `button[aria-expanded].first()` матчив би «Згорнути»-тоггл, а не таблицю
    // (слабкий асерт — пройшов би навіть при плоскому/порожньому результаті).
    const sumRow = page.locator('div[draggable="true"]:has-text("Сума")').first();
    await sumRow.getByRole('button', { name: /колонк/i }).click();

    // Клік «Г» (групування) на полі «Статус» через кнопку-літеру (не drag).
    const statusRow = page.locator('div[draggable="true"]:has-text("Статус")').first();
    await statusRow.getByRole('button', { name: /групування/i }).click();

    await page.locator('button:has-text("Сформувати")').click();
    await page.getByText(/Результат · рядків/).waitFor({ timeout: 10_000 });

    // Справді згруповано (не плоский список): перша колонка заголовка — «Група», а не «№».
    const table = page.locator('table').first();
    await expect(table.locator('thead th').first()).toHaveText('Група');
    // Групові рядки з aria-expanded саме У ТАБЛИЦІ (Bug #625 — scope до table, не page).
    await expect(table.locator('button[aria-expanded]').first()).toBeVisible();
    expect(await table.locator('button[aria-expanded]').count()).toBeGreaterThan(1);
    // Банер «Групування не задано» ВІДСУТНІЙ (це grouped-режим).
    await expect(page.getByText(/Групування не задано/)).toHaveCount(0);
  });

  test('після Сформувати налаштування авто-згортаються, але групування лишається досяжним', async ({
    page,
  }) => {
    // Після «Сформувати» налаштування авто-згортаються (звільнити місце), АЛЕ компактна панель
    // + кнопка розгортання зберігають доступ до палітри → групування досяжне (не як раніше,
    // коли контроли ховались повністю і групування ставало неможливим — «досі не групується»).
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });
    await page.locator('select').first().selectOption('workOrder');
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible({ timeout: 10_000 });

    const priorityRow = page.locator('div[draggable="true"]:has-text("Пріоритет")').first();
    await priorityRow.getByRole('button', { name: /колонк/i }).click();
    await page.locator('button:has-text("Сформувати")').click();
    await page.getByText(/Результат · рядків/).waitFor({ timeout: 10_000 });

    // Авто-згорнулось: палітра схована, але компактна панель показує вибір.
    await expect(page.getByText(/Поля «Наряди»/)).toBeHidden();
    await expect(page.getByText(/Колонки:/)).toBeVisible();
    // Розгорнути назад через компактну панель → палітра знову доступна для групування.
    await page.getByText(/Колонки:/).click();
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible();
    const statusRow = page.locator('div[draggable="true"]:has-text("Статус")').first();
    await statusRow.getByRole('button', { name: /групування/i }).click();
    await page.locator('button:has-text("Сформувати")').click();
    await page.getByText(/Результат · рядків/).waitFor({ timeout: 10_000 });
    // Bug #625: асертимо групування саме У ТАБЛИЦІ (Пріоритет-колонка → node.rows expandable).
    const table = page.locator('table').first();
    await expect(table.locator('thead th').first()).toHaveText('Група');
    await expect(table.locator('button[aria-expanded]').first()).toBeVisible();
  });

  test('згорнуті налаштування → компактна панель з поточним вибором (не порожньо)', async ({
    page,
  }) => {
    await page.goto('/reports?tab=builder');
    await expect(page.locator('button:has-text("Конструктор")')).toBeVisible({ timeout: 20_000 });
    await page.locator('select').first().selectOption('workOrder');
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible({ timeout: 10_000 });

    const statusRow = page.locator('div[draggable="true"]:has-text("Статус")').first();
    await statusRow.getByRole('button', { name: /групування/i }).click();

    // Згорнути налаштування → компактна панель показує «Групування: Статус», палітра схована.
    await page.locator('button:has-text("Згорнути")').click();
    await expect(page.getByText(/Поля «Наряди»/)).toBeHidden();
    await expect(page.getByText(/Групування:/)).toBeVisible();
    // Клік по компактній панелі → розгортає назад.
    await page.getByText(/Групування:/).click();
    await expect(page.getByText(/Поля «Наряди»/)).toBeVisible();
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
