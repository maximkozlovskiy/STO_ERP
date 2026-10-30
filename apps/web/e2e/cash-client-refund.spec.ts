import { test, expect, type Locator, type Page } from '@playwright/test';
import { clickRowMenuItem } from './row-click';
import {
  apiCall,
  createCounterparty,
  getBalance,
  getToken,
  historyRow,
  openCashCard,
  pickInCard,
} from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Каса й оплати клієнта — рішення власника 2026-10-30 (TECH-DEBT (б), етап Г1):
 *
 *   1. повернення клієнту — не більше його переплати (BR-CASH-029): понад переплату картка
 *      «Видати» показує помилку з доступною сумою, рівно переплату — проводить;
 *   2. сторно валютної оплати — за курсом оплати (BR-PAY-028): оплата 100 USD у доларову касу
 *      сторнується з картки сторно, баланс клієнта повертається до копійки.
 *
 * Оплату, повернення й сторно вносять через інтерфейс каси; касу й контрагента (передумови, яких UI
 * каси не дає) — через API. Касові операції лишаються в базі (журнал лише дописується); касу й
 * контрагента прибираємо.
 */

const stamp = Date.now();

/** Звичайна (не фіскальна) каса у валюті `code`, поповнена на `funding` (передумова). */
async function createRegister(
  page: Page,
  token: string,
  name: string,
  code: 'UAH' | 'USD',
  funding: number,
): Promise<string> {
  const [cur, br] = await Promise.all([
    apiCall<{ items?: { id: string; code: string }[] }>(page, token, 'GET', '/currencies'),
    apiCall<{ items?: { id: string }[] }>(page, token, 'GET', '/branches'),
  ]);
  const currencies = cur.body.items ?? (cur.body as unknown as { id: string; code: string }[]);
  const branches = br.body.items ?? (br.body as unknown as { id: string }[]);
  const currencyId = currencies.find(c => c.code === code)?.id;
  test.skip(!currencyId, `валюти ${code} в організації немає`);
  const res = await apiCall<{ id: string }>(page, token, 'POST', '/cash-registers', {
    name,
    currencyId,
    branchId: branches[0]?.id,
  });
  expect(res.status, `створення каси: ${JSON.stringify(res.body)}`).toBe(201);
  const fund = await apiCall(page, token, 'POST', `/cash-registers/${res.body.id}/operations`, {
    direction: 'IN',
    amount: funding,
    reason: 'MANUAL_IN',
    notes: 'E2E поповнення',
  });
  expect(fund.status, `поповнення каси: ${JSON.stringify(fund.body)}`).toBe(201);
  return res.body.id;
}

/** Закрити картку з уведеним: Escape питає про незбережені зміни — «Покинути». */
async function closeDirtyCard(page: Page, dialog: Locator) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Покинути', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

async function openCash(page: Page) {
  await page.goto('/cash');
  await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
}

/** Картка каси: привід, клієнт, сума → кнопка дії. Повертає статус відповіді сервера. */
async function submitClientOperation(
  page: Page,
  registerId: string,
  action: 'Внести' | 'Видати',
  reason: 'SALE_PAYMENT' | 'REFUND',
  clientName: string,
  amount: string,
) {
  const dialog = await openCashCard(page, registerId, action);
  await dialog.getByLabel('Привід').selectOption(reason);
  await dialog.getByLabel(/^Сума/).fill(amount);
  await pickInCard(page, dialog, /^Контрагент/, 'Оберіть клієнта', clientName);
  const response = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().includes(`/${registerId}/operations`),
  );
  await dialog.getByRole('button', { name: action, exact: true }).click();
  return { dialog, status: (await response).status() };
}

test.describe('Повернення клієнту не більше переплати (BR-CASH-029)', () => {
  const registerName = `000 E2E Повернення ${stamp}`;
  const clientName = `000 E2E Клієнт повернення ${stamp}`;
  let registerId = '';
  let clientId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/cash');
    const token = await getToken(p);
    registerId = await createRegister(p, token, registerName, 'UAH', 5000);
    clientId = await createCounterparty(p, token, 'CLIENT', clientName);
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/cash');
    const token = await getToken(p);
    if (registerId) {
      const del = await apiCall(p, token, 'DELETE', `/cash-registers/${registerId}`);
      expect.soft(del.status, 'каса спеку видалена').toBeLessThan(300);
    }
    // Контрагент з рухом по розрахунках може не видалятись — тоді лишається з префіксом «000 E2E».
    if (clientId) await apiCall(p, token, 'DELETE', `/counterparties/${clientId}`);
    await ctx.close();
  });

  // guards: BR-CASH-029
  test('без переплати повернення відхилено з доступною сумою; картка лишається з даними', async ({
    page,
  }) => {
    await openCash(page);
    const { dialog, status } = await submitClientOperation(
      page,
      registerId,
      'Видати',
      'REFUND',
      clientName,
      '50',
    );
    expect(status).toBe(400);
    await expect(dialog.getByRole('alert').first()).toContainText(
      /Повернути клієнту можна не більше 0,00 UAH/,
    );
    await expect(dialog.getByLabel(/^Сума/)).toHaveValue('50');
    await closeDirtyCard(page, dialog);
  });

  // guards: BR-CASH-029
  test('переплата 200: 200,01 — відмова з сумою; рівно 200 — повернення проведено, баланс 0', async ({
    page,
  }) => {
    await openCash(page);
    const token = await getToken(page);
    // Оплата без документа йде в розрахунки — клієнт переплатив 200.
    const paid = await submitClientOperation(
      page,
      registerId,
      'Внести',
      'SALE_PAYMENT',
      clientName,
      '200',
    );
    expect(paid.status).toBe(201);
    await expect(paid.dialog).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => getBalance(page, token, clientId), { timeout: 10_000 })
      .toBeCloseTo(-200, 2);

    const over = await submitClientOperation(
      page,
      registerId,
      'Видати',
      'REFUND',
      clientName,
      '200,01',
    );
    expect(over.status).toBe(400);
    await expect(over.dialog.getByRole('alert').first()).toContainText(/не більше 200,00 UAH/);
    await closeDirtyCard(page, over.dialog);

    const exact = await submitClientOperation(
      page,
      registerId,
      'Видати',
      'REFUND',
      clientName,
      '200',
    );
    expect(exact.status).toBe(201);
    await expect(exact.dialog).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => getBalance(page, token, clientId), { timeout: 10_000 })
      .toBeCloseTo(0, 2);
    await expect(historyRow(page, 'Повернення клієнту')).toContainText(clientName);
  });
});

// Готівка («cash») у dev-базі фіскальна, а ПРРО фіскалізує лише базову валюту — тож валютну оплату
// клієнта сценарій вносить на доларовий банківський рахунок (вікно «Новий платіж», «Оплата послуг»)
// і сторнує з рядка платежу: той самий `PaymentsService.reverse`, що й у касі.
test.describe('Сторно валютної оплати за курсом оплати (BR-PAY-028)', () => {
  const OWN_USD_ACCOUNT = '000 E2E Банк USD (сторно валютної оплати)';
  const clientName = `000 E2E Клієнт USD ${stamp}`;
  const purpose = `000 E2E USD сторно ${stamp}`;
  let accountId = '';
  let clientId = '';
  let bankTxId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/bank-statements');
    const token = await getToken(p);
    // Власний доларовий рахунок спеку: наявний із цією назвою або новий (без накопичення).
    const accounts = await apiCall<
      { items?: { id: string; name: string }[] } | { id: string; name: string }[]
    >(p, token, 'GET', '/bank-accounts');
    const list = Array.isArray(accounts.body) ? accounts.body : (accounts.body.items ?? []);
    accountId = list.find(a => a.name === OWN_USD_ACCOUNT)?.id ?? '';
    if (!accountId) {
      const cur = await apiCall<{ items?: { id: string; code: string }[] }>(
        p,
        token,
        'GET',
        '/currencies',
      );
      const currencies = cur.body.items ?? (cur.body as unknown as { id: string; code: string }[]);
      const usd = currencies.find(c => c.code === 'USD');
      test.skip(!usd, 'валюти USD в організації немає');
      const acc = await apiCall<{ id: string }>(p, token, 'POST', '/bank-accounts', {
        name: OWN_USD_ACCOUNT,
        ibanUA: `UA${String(Date.now()).slice(-9).padStart(27, '1')}`,
        currencyId: usd!.id,
      });
      expect(acc.status, `рахунок USD: ${JSON.stringify(acc.body)}`).toBe(201);
      accountId = acc.body.id;
    }
    clientId = await createCounterparty(p, token, 'CLIENT', clientName);
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/bank-statements');
    const token = await getToken(p);
    // Рядок після сторно нерознесений і ручний — його можна видалити (BR-BANK-024).
    if (bankTxId) {
      const del = await apiCall(p, token, 'DELETE', `/bank-statements/transactions/${bankTxId}`);
      expect.soft(del.status, 'рядок виписки спеку видалено').toBeLessThan(300);
    }
    if (clientId) await apiCall(p, token, 'DELETE', `/counterparties/${clientId}`);
    await ctx.close();
  });

  // guards: BR-PAY-028
  test('оплата 100 USD на доларовий рахунок → «Сторнувати оплату»: баланс клієнта повертається до копійки', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/bank-statements?direction=IN');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const before = await getBalance(page, token, clientId);

    await page.getByRole('button', { name: 'Новий платіж' }).click();
    const create = page.getByRole('dialog', { name: 'Новий банківський платіж' });
    await expect(create).toBeVisible({ timeout: 8_000 });
    await create.getByLabel(/Банківський рахунок/).selectOption(accountId);
    await create.getByLabel(/^Сума/).fill('100');
    await create.getByLabel('Призначення платежу').fill(purpose);
    await create.getByLabel('Рознести як').selectOption('SERVICE');
    await create.getByRole('button', { name: 'Обрати' }).first().click();
    const picker = page.getByRole('dialog', { name: 'Оберіть контрагента' });
    await expect(picker).toBeVisible({ timeout: 8_000 });
    await picker.getByPlaceholder('Пошук...').fill(clientName);
    await picker.getByRole('button', { name: new RegExp(clientName) }).click();
    await expect(picker).toBeHidden({ timeout: 8_000 });
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await create.getByRole('button', { name: 'Внести й рознести' }).click();
    const res = await created;
    expect(res.status(), `платіж USD внесено й рознесено: ${await res.text()}`).toBeLessThan(300);
    const tx = (await res.json()) as { id: string; paymentId: string | null };
    bankTxId = tx.id;
    expect(tx.paymentId).toBeTruthy();
    await expect(create).toBeHidden({ timeout: 8_000 });
    await expect
      .poll(async () => (await getBalance(page, token, clientId)) - before, { timeout: 10_000 })
      .toBeLessThan(-1);

    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    const row = page.locator('table tbody tr').filter({ hasText: purpose });
    await expect(page.locator('table tbody tr')).toHaveCount(1, { timeout: 15_000 });
    await clickRowMenuItem(page, row, 'Сторнувати оплату');

    const dialog = page.getByRole('dialog', { name: 'Сторно оплати', exact: true });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByLabel(/^Причина сторно/).fill(`E2E валютне сторно ${stamp}`);
    await dialog.getByRole('button', { name: 'Сторнувати', exact: true }).click();
    const reversed = page.waitForResponse(
      r => /\/payments\/[^/]+\/reverse$/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: 'Так, сторнувати' }).click();
    const rev = await reversed;
    // До рішення 2026-10-30 тут була відмова «Сторно оплати в іноземній валюті не підтримується».
    expect(rev.status(), `сторно валютної оплати: ${await rev.text()}`).toBeLessThan(300);
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // За курсом ОПЛАТИ: проводка сторно дзеркалить базову суму оригіналу — різниці не лишається.
    await expect
      .poll(() => getBalance(page, token, clientId), { timeout: 10_000 })
      .toBeCloseTo(before, 2);
    await expect(row).toContainText('Не рознесено', { timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('g1_usd_reversal.png') });
  });
});
