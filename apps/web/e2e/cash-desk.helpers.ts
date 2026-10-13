import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Спільні помічники сценаріїв «каса як місце готівкових оплат»: сторінок оплат клієнтів і
 * постачальників більше немає, оплату вносять у касі (картка операції з контрагентом).
 */

export const API = 'http://localhost:3000/api/v1';

export async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

/** Запит до API від імені користувача сторінки. Тіло відповіді — JSON або null. */
export async function apiCall<T = unknown>(
  page: Page,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ token, API, method, path, body }) => {
      const r = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: r.status, body: parsed as never };
    },
    { token, API, method, path, body },
  );
}

/** Контрагент-юрособа з передбачуваною назвою (за нею його знаходить пікер картки). */
export async function createCounterparty(
  page: Page,
  token: string,
  type: 'CLIENT' | 'SUPPLIER',
  companyName: string,
): Promise<string> {
  const res = await apiCall<{ id: string }>(page, token, 'POST', '/counterparties', {
    type,
    companyName,
  });
  expect(res.status, `створення контрагента: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.id;
}

export async function getBalance(page: Page, token: string, counterpartyId: string) {
  const res = await apiCall<{ balance?: number | string }>(
    page,
    token,
    'GET',
    `/counterparties/${counterpartyId}/balance`,
  );
  return Number(res.body.balance ?? 0);
}

/**
 * Звичайна (не фіскальна) каса в базовій валюті, поповнена на `funding`. Фіскальна каса без
 * відкритої зміни блокує операції, а зміну в E2E не відкрити (потрібен ПРРО).
 */
export async function createPlainRegister(
  page: Page,
  token: string,
  name: string,
  funding = 0,
): Promise<string> {
  const [cur, br] = await Promise.all([
    apiCall<{ items?: { id: string; code: string }[] }>(page, token, 'GET', '/currencies'),
    apiCall<{ items?: { id: string }[] }>(page, token, 'GET', '/branches'),
  ]);
  const currencies = cur.body.items ?? (cur.body as unknown as { id: string; code: string }[]);
  const branches = br.body.items ?? (br.body as unknown as { id: string }[]);
  const currencyId = (currencies.find(c => c.code === 'UAH') ?? currencies[0])?.id;
  const res = await apiCall<{ id: string }>(page, token, 'POST', '/cash-registers', {
    name,
    currencyId,
    branchId: branches[0]?.id,
  });
  expect(res.status, `створення каси: ${JSON.stringify(res.body)}`).toBe(201);
  if (funding > 0) {
    const fund = await apiCall(page, token, 'POST', `/cash-registers/${res.body.id}/operations`, {
      direction: 'IN',
      amount: funding,
      reason: 'MANUAL_IN',
      notes: 'E2E поповнення',
    });
    expect(fund.status, `поповнення каси: ${JSON.stringify(fund.body)}`).toBe(201);
  }
  return res.body.id;
}

export async function deleteRegister(page: Page, token: string, id: string) {
  await apiCall(page, token, 'DELETE', `/cash-registers/${id}`);
}

/** Обирає касу у вкладці «Операції» й відкриває картку внесення або видачі. */
export async function openCashCard(
  page: Page,
  registerId: string,
  action: 'Внести' | 'Видати',
): Promise<Locator> {
  const select = page.locator('select').first();
  await expect(select).toBeVisible({ timeout: 15_000 });
  await select.selectOption(registerId);
  await page.getByRole('button', { name: action, exact: true }).click();
  // За назвою діалогу, а не за текстом усередині: назва пікера («Оберіть клієнта») збігається
  // з підказкою поля в самій картці.
  const dialog = page.getByRole('dialog', {
    name: action === 'Внести' ? 'Внести готівку' : 'Видати готівку',
    exact: true,
  });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

/** Поле-посилання картки за підписом (підпис + значення + кнопки «×» і «…»). */
export function cardField(dialog: Locator, label: RegExp): Locator {
  return dialog.locator('label').filter({ hasText: label }).locator('..');
}

/** Відкриває пікер поля, шукає за назвою й обирає знайдений рядок. */
export async function pickInCard(
  page: Page,
  dialog: Locator,
  label: RegExp,
  pickerTitle: string,
  name: string,
) {
  await cardField(dialog, label).getByRole('button', { name: 'Обрати' }).click();
  const picker = page.getByRole('dialog', { name: pickerTitle, exact: true });
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await picker.locator('input').first().fill(name);
  await picker.getByRole('button', { name }).first().click();
  await expect(picker).toBeHidden({ timeout: 10_000 });
  await expect(cardField(dialog, label)).toContainText(name);
}

/** Рядок історії операцій каси за текстом (назва контрагента, примітка). */
export function historyRow(page: Page, text: string): Locator {
  return page.locator('table tbody tr').filter({ hasText: text }).first();
}
