import { test, expect, type Page } from '@playwright/test';
import { apiCall, createPlainRegister, deleteRegister, getToken } from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Звіт P&L (BR-RPT-030): витрата, видана з каси за статтею, з'являється у вкладці «P&L» у
 * рядку своєї статті за поточний місяць і зменшує чистий прибуток місяця на свою суму.
 *
 * Передумови (каса, стаття витрат) — через API; саму витрату вносить людина в картці каси.
 * Касові операції append-only, тож прибирання — сторно (витрата й поповнення каси сторнуються,
 * і P&L їх більше не рахує), далі видалення каси й статті.
 */

const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });
const norm = (s: string | null) => (s ?? '').replace(/\s/g, ' ').trim();

interface PnlDto {
  months: string[];
  rows: { key: string; label?: string | null; amounts: number[]; total: number }[];
}

const stamp = Date.now();
const CATEGORY = `000 E2E P&L стаття ${stamp}`;
const AMOUNT = 321.07;
const FUNDING = 1000;

let token = '';
let registerId = '';
let categoryId = '';
const operationIds: string[] = [];

async function monthNet(page: Page): Promise<number> {
  const today = KYIV_YMD.format(new Date());
  const res = await apiCall<PnlDto>(
    page,
    token,
    'GET',
    `/reports/pnl?from=${today.slice(0, 7)}-01&to=${today}`,
  );
  expect(res.status, `P&L: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.rows.find(r => r.key === 'netProfit')?.total ?? NaN;
}

test.describe('Звіти — P&L (BR-RPT-030)', () => {
  test.afterAll(async ({ browser }) => {
    if (!token) return;
    const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
    try {
      await page.goto('/reports');
      // Спершу витрата (повертає готівку), потім поповнення — інакше сторно поповнення впало б
      // у мінус каси.
      for (const opId of [...operationIds].reverse()) {
        const rev = await apiCall(
          page,
          token,
          'POST',
          `/cash-registers/${registerId}/operations/${opId}/reverse`,
          { reason: '000 E2E прибирання P&L' },
        );
        expect.soft(rev.status, `сторно ${opId}: ${JSON.stringify(rev.body)}`).toBe(201);
      }
      if (registerId) await deleteRegister(page, token, registerId);
      if (categoryId) {
        const del = await apiCall(page, token, 'DELETE', `/expense-categories/${categoryId}`);
        expect.soft(del.status, `видалення статті: ${JSON.stringify(del.body)}`).toBeLessThan(300);
      }
    } finally {
      await page.close();
    }
  });

  test('витрата з каси за статтею — у P&L місяця, чистий прибуток меншає на її суму', async ({
    page,
  }) => {
    await page.goto('/cash');
    await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
    token = await getToken(page);

    // ── Передумови: стаття витрат і звичайна каса з готівкою ──
    const cat = await apiCall<{ id: string }>(page, token, 'POST', '/expense-categories', {
      name: CATEGORY,
      type: 'EXPENSE',
    });
    expect(cat.status, `стаття: ${JSON.stringify(cat.body)}`).toBe(201);
    categoryId = cat.body.id;
    registerId = await createPlainRegister(page, token, `000 E2E P&L каса ${stamp}`);
    const fund = await apiCall<{ id: string }>(
      page,
      token,
      'POST',
      `/cash-registers/${registerId}/operations`,
      { direction: 'IN', amount: FUNDING, reason: 'MANUAL_IN', notes: '000 E2E поповнення P&L' },
    );
    expect(fund.status, `поповнення: ${JSON.stringify(fund.body)}`).toBe(201);
    operationIds.push(fund.body.id);

    const netBefore = await monthNet(page);

    // ── Витрата через картку каси: «Видати» → привід «Витрата» → стаття → сума ──
    await page.reload();
    const select = page.locator('select').first();
    await expect(select).toBeVisible({ timeout: 15_000 });
    await select.selectOption(registerId);
    await page.getByRole('button', { name: 'Видати', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Видати готівку', exact: true });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByLabel('Привід').selectOption('EXPENSE');
    await dialog.getByLabel(/^Стаття витрат/).selectOption({ label: CATEGORY });
    await dialog.getByLabel(/^Сума/).fill('321,07');
    await dialog.getByLabel(/^Нотатка/).fill('000 E2E витрата P&L');
    const created = page.waitForResponse(
      r =>
        r.url().endsWith(`/cash-registers/${registerId}/operations`) &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: 'Видати', exact: true }).click();
    const res = await created;
    expect(res.status(), 'витрата має провестись').toBe(201);
    operationIds.push(((await res.json()) as { id: string }).id);
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // ── Вкладка «P&L»: рядок статті з сумою в колонці поточного місяця ──
    await page.goto('/reports?tab=pnl');
    await expect(page.getByTestId('pnl-report')).toBeVisible({ timeout: 20_000 });
    const row = page.getByTestId('pnl-row-expenseCategory').filter({ hasText: CATEGORY });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    const cells = row.locator('td');
    const count = await cells.count();
    // Колонки: стаття, місяці від початку року до поточного, «Разом» — поточний перед «Разом».
    expect(norm(await cells.nth(count - 2).textContent())).toBe('321,07 ₴');
    expect(norm(await cells.nth(count - 1).textContent())).toBe('321,07 ₴');

    // ── Чистий прибуток місяця менший рівно на суму витрати ──
    const netAfter = await monthNet(page);
    expect(Math.round((netBefore - netAfter) * 100)).toBe(Math.round(AMOUNT * 100));
  });
});
