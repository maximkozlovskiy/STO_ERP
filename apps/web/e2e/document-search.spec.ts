import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

const API = 'http://localhost:3000/api/v1';

/**
 * Пошук на сторінках документів (рішення власника 2026-10-09: «не на всіх сторінках
 * документів є пошук та відбори по даті»).
 *
 * Що тут стережеться: на кожній із п'яти сторінок є поле пошуку, і введений текст справді
 * доходить до API параметром `q`. Що саме шукає `q` і як працюють межі дат — в unit-тестах
 * сервісів; тут — лише наскрізний шлях «поле → запит», який unit-тестом не довести.
 */

/** Вводить текст у поле пошуку й чекає запит до API з цим `q`. */
async function expectSearchReachesApi(page: Page, placeholder: RegExp, urlPart: string) {
  const needle = `e2e-${Date.now()}`;
  const field = page.getByPlaceholder(placeholder);
  await expect(field, 'поле пошуку має бути на сторінці').toBeVisible({ timeout: 20_000 });
  const request = page.waitForRequest(
    r => r.url().includes(urlPart) && new URL(r.url()).searchParams.get('q') === needle,
    { timeout: 15_000 },
  );
  await field.fill(needle);
  await request;
}

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

test.describe('Пошук на сторінках документів', () => {
  test('Склад → документи: пошук за номером або приміткою йде в запит', async ({ page }) => {
    await page.goto('/stock-documents');
    await expectSearchReachesApi(page, /Пошук за номером або приміткою/, '/stock-documents?');
  });

  test('Склад → Рухи: пошук за товаром або артикулом йде в запит', async ({ page }) => {
    await page.goto('/stock-documents?tab=movements');
    await expectSearchReachesApi(page, /Пошук за товаром або артикулом/, '/stock-items/movements?');
  });

  test('Оплати клієнтів: пошук за клієнтом, рахунком, нарядом іде в запит', async ({ page }) => {
    await page.goto('/payments');
    await expectSearchReachesApi(page, /Пошук за клієнтом, рахунком, нарядом/, '/payments?');
  });

  test('Банківські платежі: пошук є, дати за замовчуванням порожні — видно всі платежі', async ({
    page,
  }) => {
    const firstList = page.waitForRequest(r => r.url().includes('/bank-statements/transactions?'), {
      timeout: 20_000,
    });
    await page.goto('/bank-statements');
    // Виписку імпортують за минулі дні: сторінка відкривається БЕЗ обмеження за датою.
    const params = new URL((await firstList).url()).searchParams;
    expect(params.get('dateFrom')).toBeNull();
    expect(params.get('dateTo')).toBeNull();

    await expectSearchReachesApi(
      page,
      /Пошук за контрагентом, призначенням, IBAN/,
      '/bank-statements/transactions?',
    );
  });

  test('Каса → операції: пошук іде в запит, сторінка відкривається на сьогоднішньому дні', async ({
    page,
  }) => {
    // Операції показуються для каси; на чистій базі кас немає — створюємо свою.
    await page.goto('/cash?tab=registers');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const created = await page.evaluate(
      async ({ API, token }) => {
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
        const get = async (path: string) =>
          (await fetch(`${API}/${path}`, { headers })).json() as Promise<unknown>;
        const first = (r: unknown): { id: string } | undefined =>
          (Array.isArray(r) ? r : ((r as { items?: unknown[] }).items ?? []))[0] as
            { id: string } | undefined;
        const existing = first(await get('cash-registers'));
        if (existing) return { ok: true };
        const [branch, currency] = await Promise.all([
          get('branches').then(first),
          get('currencies').then(first),
        ]);
        if (!branch || !currency) return { ok: false, why: 'немає філії або валюти' };
        const r = await fetch(`${API}/cash-registers`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: `E2E Каса пошук ${Date.now()}`,
            branchId: branch.id,
            currencyId: currency.id,
          }),
        });
        return { ok: r.ok, why: `POST /cash-registers ${r.status}` };
      },
      { API, token },
    );
    expect(created.ok, `каса для тесту: ${created.why ?? ''}`).toBe(true);

    const firstList = page.waitForRequest(
      r => /\/cash-registers\/[^/]+\/operations\?/.test(r.url()),
      {
        timeout: 20_000,
      },
    );
    await page.goto('/cash');
    const params = new URL((await firstList).url()).searchParams;
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
    expect(params.get('dateFrom')).toBe(today);
    expect(params.get('dateTo')).toBe(today);

    await expectSearchReachesApi(page, /Пошук за приміткою або статтею/, '/operations?');
  });
});
