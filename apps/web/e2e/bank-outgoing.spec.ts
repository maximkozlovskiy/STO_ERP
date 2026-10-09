import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

const API = 'http://localhost:3000/api/v1';

/**
 * Вихідні банківські платежі (рішення власника 2026-10-09, BR-BANK-017…040).
 *
 * Наскрізний шлях, який unit-тестами не довести: платіж, внесений вручну через форму,
 * з'являється на вкладці «Вихідні», розноситься як витрата за статтею, рознесення знімається
 * лише з причиною, і нерознесений ручний платіж видаляється. Проведення, касу й оплату
 * постачальнику стережуть unit-тести сервісу — тут гроші не рухаються (вид «Витрата» лише
 * класифікує платіж), тож сценарій не лишає слідів у взаєморозрахунках.
 */

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

/** Банківський рахунок і активна стаття витрат потрібні сценарію; у чистій базі їх може не бути. */
async function ensureFixtures(page: Page): Promise<{ categoryId: string }> {
  const token = await getToken(page);
  const result = await page.evaluate(
    async ({ token, API }) => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const list = async (path: string) => {
        const data = await (await fetch(`${API}${path}`, { headers: auth })).json();
        return (data.items ?? data) as Array<Record<string, unknown>>;
      };

      let accounts = await list('/bank-accounts');
      if (accounts.length === 0) {
        const currencies = await list('/currencies');
        const iban = `UA${String(Date.now()).slice(-9).padStart(27, '0')}`;
        await fetch(`${API}/bank-accounts`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            name: `E2E Рахунок ${Date.now()}`,
            ibanUA: iban,
            currencyId: (currencies.find(c => c.code === 'UAH') ?? currencies[0])?.id,
          }),
        });
        accounts = await list('/bank-accounts');
      }

      const flat: Array<Record<string, unknown>> = [];
      const walk = (nodes: Array<Record<string, unknown>>) =>
        nodes.forEach(n => {
          flat.push(n);
          if (Array.isArray(n.children)) walk(n.children as Array<Record<string, unknown>>);
        });
      walk(await list('/expense-categories'));
      let category = flat.find(c => c.type === 'EXPENSE' && c.isActive !== false);
      if (!category) {
        const res = await fetch(`${API}/expense-categories`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ name: `E2E Витрата ${Date.now()}`, type: 'EXPENSE' }),
        });
        category = (await res.json()) as Record<string, unknown>;
      }
      return { accounts: accounts.length, categoryId: String(category?.id ?? '') };
    },
    { token, API },
  );
  expect(result.accounts, 'потрібен хоча б один банківський рахунок').toBeGreaterThan(0);
  expect(result.categoryId, 'потрібна активна стаття витрат').toBeTruthy();
  return { categoryId: result.categoryId };
}

test.describe('Банківські платежі — вихідні', () => {
  test('ручний вихідний платіж: внесення → рознесення на витрату → скасування з причиною → видалення', async ({
    page,
  }) => {
    await page.goto('/bank-statements?direction=OUT');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    const { categoryId } = await ensureFixtures(page);
    const purpose = `E2E вихідний ${Date.now()}`;

    // ── Внесення вручну: на вкладці «Вихідні» напрям за замовчуванням — вихідний ──
    await page.getByRole('button', { name: 'Новий платіж' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible({ timeout: 8_000 });
    const accountSelect = createDialog.locator('select').first();
    if ((await accountSelect.inputValue()) === '') await accountSelect.selectOption({ index: 1 });
    await createDialog.getByLabel(/Сума/).fill('12,34');
    await createDialog.getByLabel(/Призначення платежу/).fill(purpose);
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await createDialog.getByRole('button', { name: 'Внести платіж' }).click();
    const createdRes = await created;
    expect(createdRes.status(), 'ручний платіж має створитись').toBeLessThan(300);
    expect((await createdRes.json()).direction).toBe('OUT');
    await expect(createDialog).toBeHidden({ timeout: 8_000 });

    // ── Рядок у списку: сума зі знаком «−», нерознесений ──
    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    const row = page.locator('table tbody tr').filter({ hasText: purpose });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText('−12,34');
    await expect(row).toContainText('Внесено вручну');

    // ── Рознесення як витрата за статтею ──
    await row.getByRole('button', { name: 'Рознести' }).click();
    const matchDialog = page.getByRole('dialog');
    await expect(matchDialog).toContainText('Рознести вихідний платіж');
    await matchDialog.locator('select').first().selectOption('EXPENSE');
    await matchDialog.locator('select').nth(1).selectOption(categoryId);
    await matchDialog.getByRole('button', { name: 'Рознести', exact: true }).click();
    await expect(matchDialog).toBeHidden({ timeout: 10_000 });
    await expect(row).toContainText('Витрата', { timeout: 10_000 });
    await expect(row).toContainText('Рознесено');

    // ── Скасування рознесення: без причини кнопка вимкнена ──
    await row.getByRole('button', { name: 'Зняти рознесення' }).click();
    const undoDialog = page.getByRole('dialog');
    const undoSubmit = undoDialog.getByRole('button', { name: 'Зняти рознесення' });
    await expect(undoSubmit).toBeDisabled();
    await undoDialog.getByPlaceholder(/Чому рознесення знімається/).fill('   ');
    await expect(undoSubmit, 'самі пробіли — не причина').toBeDisabled();
    await undoDialog.getByPlaceholder(/Чому рознесення знімається/).fill('E2E: не та стаття');
    await undoSubmit.click();
    await expect(undoDialog).toBeHidden({ timeout: 10_000 });
    await expect(row).toContainText('Не рознесено', { timeout: 10_000 });
    await expect(row).toContainText('Рознесення скасовано: E2E: не та стаття');

    // ── Видалення ручного нерознесеного платежу ──
    await row.getByRole('button', { name: 'Видалити платіж' }).click();
    await page.getByRole('button', { name: 'Видалити', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  });

  test('вихідний платіж не можна рознести як оплату клієнта: старий match відповідає 400', async ({
    page,
  }) => {
    await page.goto('/bank-statements?direction=OUT');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    await ensureFixtures(page);
    const token = await getToken(page);
    const result = await page.evaluate(
      async ({ token, API }) => {
        const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const accounts = await (await fetch(`${API}/bank-accounts`, { headers: auth })).json();
        const account = (accounts.items ?? accounts)[0];
        const createdRes = await fetch(`${API}/bank-statements/transactions`, {
          method: 'POST',
          headers: { ...auth, 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            bankAccountId: account.id,
            direction: 'OUT',
            amount: 1.5,
            operationDate: new Date().toISOString().slice(0, 10),
            purpose: `E2E match-guard ${Date.now()}`,
          }),
        });
        const created = await createdRes.json();
        const cps = await (await fetch(`${API}/counterparties?limit=1`, { headers: auth })).json();
        const counterpartyId = (cps.items ?? cps)[0]?.id;
        const matchRes = await fetch(`${API}/bank-statements/transactions/${created.id}/match`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ counterpartyId, type: 'SERVICE' }),
        });
        const after = await (
          await fetch(`${API}/bank-statements/transactions?direction=OUT&limit=200`, {
            headers: auth,
          })
        ).json();
        const status = (after.items as Array<{ id: string; status: string }>).find(
          t => t.id === created.id,
        )?.status;
        const del = await fetch(`${API}/bank-statements/transactions/${created.id}`, {
          method: 'DELETE',
          // No JSON content-type on a body-less request: Fastify answers 400 to an empty JSON body.
          headers: { Authorization: auth.Authorization },
        });
        return {
          created: createdRes.status,
          hasCounterparty: !!counterpartyId,
          match: matchRes.status,
          status,
          deleted: del.status,
        };
      },
      { token, API },
    );
    expect(result.created).toBeLessThan(300);
    expect(result.hasCounterparty, 'потрібен хоча б один контрагент').toBe(true);
    expect(result.match, 'match приймає лише вхідні рядки').toBe(400);
    expect(result.status, 'рядок лишається нерознесеним').toBe('UNMATCHED');
    expect(result.deleted).toBe(204);
  });
});
