import { test, expect, type Page } from '@playwright/test';
import { clickRowMenuItem, rowMenuButton } from './row-click';
import {
  apiCall,
  createCounterparty,
  createPlainRegister,
  deleteRegister,
  getBalance,
  getToken,
} from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Сторно касової операції (BR-CASH-023…025), рішення власника 2026-10-14.
 *
 * Маршрут сторно: POST /cash-registers/:id/operations/:operationId/reverse; поля рядка історії
 * `reversalOfId` / `reversedBy`. Сценарії писались паралельно з бекендом, прогнані разом із ним
 * (2026-10-14).
 *
 * Касові операції — append-only (фінансовий слід), тож лишаються в БД навмисно. Касу й
 * контрагента, створених тестом, прибираємо.
 */

interface CashOp {
  id: string;
  reversalOfId?: string | null;
  reversedBy?: { id: string; reason: string | null } | null;
}

async function registerBalance(page: Page, token: string, id: string): Promise<number> {
  const res = await apiCall<{ items: { id: string; balance: number | string }[] }>(
    page,
    token,
    'GET',
    '/cash-registers',
  );
  return Number(res.body.items.find(r => r.id === id)?.balance ?? NaN);
}

async function createOperation(
  page: Page,
  token: string,
  registerId: string,
  body: Record<string, unknown>,
): Promise<CashOp> {
  const res = await apiCall<CashOp>(
    page,
    token,
    'POST',
    `/cash-registers/${registerId}/operations`,
    body,
  );
  expect(res.status, `касова операція: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body;
}

/** Каса на вкладці «Операції» обрана; таблиця історії на місці. */
async function selectRegister(page: Page, registerId: string) {
  await page.goto('/cash');
  await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
  const select = page.locator('select').first();
  await expect(select).toBeVisible({ timeout: 15_000 });
  await select.selectOption(registerId);
}

/** Сторно рядка через картку: причина → «Сторнувати» → «Так, сторнувати». */
async function reverseViaCard(page: Page, registerId: string, operationId: string, reason: string) {
  const row = page.locator(`#cash-op-${operationId}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await clickRowMenuItem(page, row, 'Сторнувати');

  const dialog = page.getByRole('dialog', { name: 'Сторно касової операції', exact: true });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByRole('region', { name: 'Що сторнується' })).toBeVisible();

  // Без причини запит не йде: помилка біля поля, другого кроку немає.
  await dialog.getByRole('button', { name: 'Сторнувати', exact: true }).click();
  await expect(dialog.getByText('Вкажіть причину сторно')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Так, сторнувати' })).toHaveCount(0);

  await dialog.getByLabel(/^Причина сторно/).fill(reason);
  await dialog.getByRole('button', { name: 'Сторнувати', exact: true }).click();
  const reversed = page.waitForResponse(
    r =>
      r.request().method() === 'POST' &&
      r.url().includes(`/cash-registers/${registerId}/operations/${operationId}/reverse`),
  );
  await dialog.getByRole('button', { name: 'Так, сторнувати' }).click();
  const res = await reversed;
  expect(res.ok(), `сторно прийнято: ${res.status()} ${await res.text()}`).toBe(true);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

test.describe('Сторно касової операції', () => {
  const stamp = Date.now();
  // «000» на початку: список кас віддає перші 200 за назвою, а в dev-базі сотні старих
  // «E2E Каса N» — без цього нова каса не потрапляла б у селектор.
  const registerName = `000 E2E Сторно ${stamp}`;
  const clientName = `000 E2E Сторно клієнт ${stamp}`;
  let registerId = '';
  let clientId = '';
  let simpleOpId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/cash');
    const token = await getToken(p);
    registerId = await createPlainRegister(p, token, registerName, 1000);
    clientId = await createCounterparty(p, token, 'CLIENT', clientName);
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/cash');
    const token = await getToken(p);
    if (registerId) await deleteRegister(p, token, registerId);
    // Контрагент з рухом по розрахунках може не видалятись — відмову ігноруємо.
    if (clientId) await apiCall(p, token, 'DELETE', `/counterparties/${clientId}`);
    await ctx.close();
  });

  test('сторно простої операції: залишок назад, обидва рядки позначені', async ({ page }) => {
    await page.goto('/cash');
    const token = await getToken(page);
    const op = await createOperation(page, token, registerId, {
      direction: 'IN',
      reason: 'OWNER_IN',
      amount: 250,
      notes: `E2E внесок ${stamp}`,
    });
    simpleOpId = op.id;
    expect(await registerBalance(page, token, registerId)).toBeCloseTo(1250, 2);

    await selectRegister(page, registerId);
    const reason = `E2E помилкове внесення ${stamp}`;
    await reverseViaCard(page, registerId, op.id, reason);

    // Залишок каси повернувся.
    await expect
      .poll(() => registerBalance(page, token, registerId), {
        timeout: 10_000,
        message: 'сторно внесення має повернути залишок каси',
      })
      .toBeCloseTo(1000, 2);

    // Оригінал: позначка «Сторновано: причина, дата», кнопки сторно більше немає.
    const original = page.locator(`#cash-op-${op.id}`);
    await expect(original).toHaveAttribute('data-reversed', 'true', { timeout: 15_000 });
    await expect(original).toContainText(`Сторновано: ${reason}`);
    await expect(rowMenuButton(original)).toHaveCount(0);

    // Рядок сторно: «Сторно: <привід>», видача тієї самої суми, посилання на оригінал.
    const reversal = page.locator('tr[data-reversal="true"]').filter({ hasText: reason });
    await expect(reversal).toHaveCount(1);
    await expect(reversal).toContainText('Сторно: Внесок власника');
    await expect(reversal).toContainText('−250,00');
    await expect(
      reversal.getByRole('button', { name: /^Показати сторновану операцію/ }),
    ).toBeVisible();
    await expect(rowMenuButton(reversal)).toHaveCount(0);
  });

  test('повторне сторно неможливе: кнопки немає, сервер відмовляє', async ({ page }) => {
    expect(simpleOpId, 'попередній сценарій створив і сторнував операцію').toBeTruthy();
    await selectRegister(page, registerId);
    const original = page.locator(`#cash-op-${simpleOpId}`);
    await expect(original).toHaveAttribute('data-reversed', 'true', { timeout: 15_000 });
    await expect(rowMenuButton(original)).toHaveCount(0);

    const token = await getToken(page);
    const history = await apiCall<CashOp[]>(
      page,
      token,
      'GET',
      `/cash-registers/${registerId}/operations?limit=500`,
    );
    const reversalId = history.body.find(o => o.reversalOfId === simpleOpId)?.id;
    expect(reversalId, 'рядок сторно є в історії').toBeTruthy();

    const again = await apiCall<{ message?: string | string[] }>(
      page,
      token,
      'POST',
      `/cash-registers/${registerId}/operations/${simpleOpId}/reverse`,
      { reason: 'друга спроба' },
    );
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.body)).toContain('Операцію вже сторновано');

    const ofReversal = await apiCall<{ message?: string | string[] }>(
      page,
      token,
      'POST',
      `/cash-registers/${registerId}/operations/${reversalId}/reverse`,
      { reason: 'сторно сторно' },
    );
    expect(ofReversal.status).toBe(400);
    expect(JSON.stringify(ofReversal.body)).toContain('Сторно не можна сторнувати');
  });

  // Bug #855: причина сторно показується в рядку сторно і в позначці оригіналу. Причина з 500
  // символів без пробілів (вставлене посилання чи номер) розтягувала таблицю на ширину «слова»:
  // суми й контрагенти всіх рядків ішли за горизонтальну прокрутку.
  test('довга причина без пробілів не розтягує історію: суми видно', async ({ page }) => {
    await page.goto('/cash');
    const token = await getToken(page);
    const op = await createOperation(page, token, registerId, {
      direction: 'IN',
      reason: 'OWNER_IN',
      amount: 5,
      notes: `E2E довга причина ${stamp}`,
    });
    const reversed = await apiCall(
      page,
      token,
      'POST',
      `/cash-registers/${registerId}/operations/${op.id}/reverse`,
      { reason: 'Ж'.repeat(500) },
    );
    expect(reversed.status, `сторно прийнято: ${JSON.stringify(reversed.body)}`).toBe(201);

    await selectRegister(page, registerId);
    const original = page.locator(`#cash-op-${op.id}`);
    await expect(original).toHaveAttribute('data-reversed', 'true', { timeout: 15_000 });
    const widths = await page
      .locator('table')
      .first()
      .evaluate(t => ({ table: t.scrollWidth, box: t.parentElement?.clientWidth ?? 0 }));
    expect(
      widths.table,
      `таблиця ${widths.table}px ширша за контейнер ${widths.box}px — суми за прокруткою`,
    ).toBeLessThanOrEqual(widths.box + 1);
    // Перенесена причина робить рядок високим: прокручуємо до нього за першою (лівою) коміркою —
    // по горизонталі прокрутка лишається на початку, тож сума мусить бути видна без неї.
    await original.locator('td').first().scrollIntoViewIfNeeded();
    await expect(original.locator('td').filter({ hasText: '+5,00' })).toBeInViewport();
  });

  test('сторно оплати контрагента: борг повертається', async ({ page }) => {
    await page.goto('/cash');
    const token = await getToken(page);
    const before = await getBalance(page, token, clientId);
    const payment = await createOperation(page, token, registerId, {
      direction: 'IN',
      reason: 'SALE_PAYMENT',
      amount: 300,
      counterpartyId: clientId,
    });
    await expect
      .poll(async () => Math.abs((await getBalance(page, token, clientId)) - before), {
        timeout: 10_000,
        message: 'оплата має змінити баланс клієнта',
      })
      .toBeCloseTo(300, 2);

    await selectRegister(page, registerId);
    const row = page.locator(`#cash-op-${payment.id}`);
    await expect(row).toContainText(clientName, { timeout: 15_000 });
    await clickRowMenuItem(page, row, 'Сторнувати');
    const dialog = page.getByRole('dialog', { name: 'Сторно касової операції', exact: true });
    await expect(dialog.getByRole('note')).toContainText('Борг контрагента');
    await dialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await reverseViaCard(page, registerId, payment.id, `E2E не той клієнт ${stamp}`);

    await expect
      .poll(() => getBalance(page, token, clientId), {
        timeout: 10_000,
        message: 'сторно оплати має повернути баланс клієнта',
      })
      .toBeCloseTo(before, 2);
    await expect(row).toHaveAttribute('data-reversed', 'true', { timeout: 15_000 });
    await expect(
      page.locator('tr[data-reversal="true"]').filter({ hasText: 'Сторно: Оплата контрагента' }),
    ).toHaveCount(1);
  });
});
