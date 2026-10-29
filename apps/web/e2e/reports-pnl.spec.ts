import { test, expect, type Page } from '@playwright/test';
import {
  apiCall,
  createPlainRegister,
  deleteRegister,
  getToken,
  cardField,
  openCashCard,
} from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Звіт P&L (BR-RPT-030): витрата, видана з каси за статтею, з'являється у вкладці «P&L» у
 * рядку своєї статті за поточний місяць і зменшує чистий прибуток місяця на свою суму.
 *
 * Передумови (каса, стаття витрат) — через API; саму витрату вносить людина в картці каси.
 * Касові операції append-only, тож прибирання — сторно (витрата й поповнення каси сторнуються,
 * і P&L їх більше не рахує), далі видалення каси й статті.
 *
 * Налаштування звіту (рішення власника 2026-10-29): видача під звіт за тією самою статтею витрат
 * (картка каси) у P&L не входить, доки у вікні «Налаштування звіту» не увімкнено «Під звіт»; після
 * збереження вона в рядку статті й у рядку «Пораховано». Налаштування організації повертаються
 * в прибиранні (через API — до того, що було перед тестом).
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
const ADVANCE = 45.5;
/** Налаштування P&L організації до тесту — повертаються в прибиранні. */
let pnlSettingsBefore: Record<string, unknown> | null = null;

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
      if (pnlSettingsBefore) {
        const back = await apiCall(
          page,
          token,
          'PATCH',
          '/settings/organisation',
          pnlSettingsBefore,
        );
        expect
          .soft(back.status, `повернення налаштувань P&L: ${JSON.stringify(back.body)}`)
          .toBe(200);
      }
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

  test('«Налаштування звіту»: видача під звіт за статтею витрат — у P&L лише після увімкнення', async ({
    page,
  }) => {
    test.skip(!registerId || !categoryId, 'потрібні каса й стаття з попереднього тесту');
    await page.goto('/cash');
    await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
    token = await getToken(page);
    const org = await apiCall<Record<string, unknown>>(
      page,
      token,
      'GET',
      '/settings/organisation',
    );
    expect(org.status).toBe(200);
    pnlSettingsBefore = {
      pnlIncomeCashReasons: org.body.pnlIncomeCashReasons,
      pnlExpenseCashReasons: org.body.pnlExpenseCashReasons,
      pnlWarnFuturePayroll: org.body.pnlWarnFuturePayroll,
    };
    // Стартова точка — типові налаштування (під звіт не рахується).
    const reset = await apiCall(page, token, 'PATCH', '/settings/organisation', {
      pnlExpenseCashReasons: ['EXPENSE'],
    });
    expect(reset.status, `типові налаштування: ${JSON.stringify(reset.body)}`).toBe(200);

    // ── Видача під звіт механіку за статтею витрат — карткою каси ──
    const mechs = await apiCall<{ items: { firstName: string; lastName: string }[] }>(
      page,
      token,
      'GET',
      '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc',
    );
    const mech = mechs.body.items[0];
    expect(mech, 'у базі є механік').toBeTruthy();
    const mechName = `${mech!.lastName} ${mech!.firstName}`;
    const dialog = await openCashCard(page, registerId, 'Видати');
    await dialog.getByLabel('Привід').selectOption('ADVANCE_ISSUE');
    // Працівник — пікером; список перечитується на кожну літеру, тож клік — після відповіді на
    // прізвище (інакше рядок відривається від DOM під час кліку).
    await cardField(dialog, /^Працівник/)
      .getByRole('button', { name: 'Обрати' })
      .click();
    const picker = page.getByRole('dialog', { name: 'Оберіть працівника', exact: true });
    await expect(picker).toBeVisible({ timeout: 10_000 });
    const searched = page.waitForResponse(
      r =>
        r.url().includes('/employees?q=') && decodeURIComponent(r.url()).includes(mech!.lastName),
      { timeout: 15_000 },
    );
    // Пошук сервера — за одним полем (прізвище), не за «прізвище ім'я».
    await picker.locator('input').first().fill(mech!.lastName);
    await searched;
    await picker.getByRole('button', { name: mechName }).first().click();
    await expect(picker).toBeHidden({ timeout: 10_000 });
    await expect(cardField(dialog, /^Працівник/)).toContainText(mechName);
    await dialog.getByLabel(/^Стаття витрат/).selectOption({ label: CATEGORY });
    await dialog.getByLabel(/^Сума/).fill('45,50');
    await dialog.getByLabel(/^Нотатка/).fill('000 E2E під звіт P&L');
    const created = page.waitForResponse(
      r =>
        r.url().endsWith(`/cash-registers/${registerId}/operations`) &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: 'Видати', exact: true }).click();
    const res = await created;
    expect(res.status(), 'видача під звіт має провестись').toBe(201);
    operationIds.push(((await res.json()) as { id: string }).id);
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // ── P&L: стаття лише з витратою, «Пораховано» — лише «Витрата» ──
    await page.goto('/reports?tab=pnl');
    await expect(page.getByTestId('pnl-report')).toBeVisible({ timeout: 20_000 });
    const row = page.getByTestId('pnl-row-expenseCategory').filter({ hasText: CATEGORY });
    const total = row.locator('td').last();
    await expect(total).toHaveText(/321,07/, { timeout: 15_000 });
    await expect(page.getByTestId('pnl-settings-summary')).not.toContainText('Під звіт');

    // ── «Налаштування звіту» → «Під звіт» → «Зберегти» ──
    await page.getByRole('button', { name: 'Налаштування звіту' }).click();
    const modal = page.getByRole('dialog', { name: 'Налаштування звіту P&L' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByRole('checkbox', { name: /Витрата/ })).toBeDisabled();
    await modal.getByRole('checkbox', { name: 'Під звіт' }).check();
    const saved = page.waitForResponse(
      r => r.url().endsWith('/settings/organisation') && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    );
    await modal.getByRole('button', { name: 'Зберегти' }).click();
    expect((await saved).status()).toBe(200);
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // ── Звіт перечитано: під звіт у статті, «Пораховано» називає його ──
    await expect(page.getByTestId('pnl-settings-summary')).toContainText('Під звіт', {
      timeout: 15_000,
    });
    await expect(total).toHaveText(new RegExp(`${String(321.07 + ADVANCE).replace('.', ',')}`), {
      timeout: 15_000,
    });
  });
});
