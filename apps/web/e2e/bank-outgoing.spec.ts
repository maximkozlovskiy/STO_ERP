import { test, expect, type Locator, type Page } from '@playwright/test';
import { clickRowMenuItem } from './row-click';
import { API } from './api-url';

test.use({ storageState: 'e2e/.auth/admin.json' });

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
    await clickRowMenuItem(page, row, 'Зняти рознесення');
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

/**
 * Скасування рознесення оплати постачальнику (рішення власника 2026-11-06, BR-BANK-039): оплату,
 * СТВОРЕНУ з рядка («Рознести як» → «Оплата постачальнику» при внесенні), скасування сторнує —
 * «Сторновано», борг постачальнику повертається; оплату, до якої рядок лише ПРИВ'ЯЗАЛИ, — лише
 * відв'язує, вона лишається проведеною. Платежі вносяться, розносяться й знімаються через вікна;
 * API — лише для передумов (постачальник, проведена оплата для прив'язки) і перевірок стану.
 * Дані — «000 E2E …»; прибирання в afterAll (постачальник прив'язаної оплати лишається: його
 * борг не нульовий, а сторно банківської оплати поза рознесенням у системі немає).
 */
const SP_ACCOUNT = '000 E2E Банк UAH (рознесення)';

interface SpState {
  token: string;
  accountId: string;
  rowIds: string[];
  supplierIds: string[];
}

async function spApi<T>(
  page: Page,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ token, API, method, path, body, headers }) => {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as never };
    },
    { token, API, method, path, body, headers },
  );
}

type Named = { id: string; name?: string; code?: string };
const itemsOf = (body: unknown): Named[] =>
  Array.isArray(body) ? (body as Named[]) : ((body as { items?: Named[] } | null)?.items ?? []);

/** Власний гривневий рахунок сценарію (той самий, що в bank-allocation.spec.ts). */
async function spAccount(page: Page, token: string): Promise<string> {
  const own = itemsOf((await spApi(page, token, 'GET', '/bank-accounts')).body).find(
    a => a.name === SP_ACCOUNT,
  );
  if (own) return own.id;
  const uah = itemsOf((await spApi(page, token, 'GET', '/currencies')).body).find(
    c => c.code === 'UAH',
  );
  const created = await spApi<{ id: string }>(page, token, 'POST', '/bank-accounts', {
    name: SP_ACCOUNT,
    ibanUA: `UA${String(Date.now()).slice(-9).padStart(27, '0')}`,
    currencyId: uah?.id,
  });
  expect(created.status, 'власний рахунок сценарію').toBeLessThan(300);
  return created.body.id;
}

async function spSupplier(page: Page, state: SpState, name: string): Promise<string> {
  const res = await spApi<{ id: string }>(page, state.token, 'POST', '/counterparties', {
    type: 'SUPPLIER',
    companyName: name,
  });
  expect(res.status, `постачальник ${name}`).toBeLessThan(300);
  state.supplierIds.push(res.body.id);
  return res.body.id;
}

async function spBalance(page: Page, token: string, supplierId: string): Promise<number> {
  const res = await spApi<{ balance: number }>(
    page,
    token,
    'GET',
    `/counterparties/${supplierId}/balance`,
  );
  expect(res.status).toBe(200);
  return Number(res.body.balance);
}

async function spStatus(page: Page, token: string, id: string): Promise<string> {
  const res = await spApi<{ status: string }>(page, token, 'GET', `/supplier-payments/${id}`);
  expect(res.status).toBe(200);
  return res.body.status;
}

/** Сума, якої немає в інших прогонах: прив'язка пропонує оплати саме на суму рядка. */
const uniqueAmount = (): string =>
  `${100 + (Date.now() % 800)},${String(Date.now() % 97).padStart(2, '0')}`;

/** «Зняти рознесення» рядка з причиною; повертає текст наслідку з вікна. */
async function unreconcileRow(page: Page, row: Locator): Promise<string> {
  await clickRowMenuItem(page, row, 'Зняти рознесення');
  const dialog = page.getByRole('dialog', { name: 'Зняти рознесення' });
  await expect(dialog).toBeVisible({ timeout: 8_000 });
  const note = (await dialog.getByRole('note').textContent()) ?? '';
  await dialog.getByPlaceholder(/Чому рознесення знімається/).fill('E2E: рознесено помилково');
  const done = page.waitForResponse(
    r => r.url().includes('/unreconcile') && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await dialog.getByRole('button', { name: 'Зняти рознесення' }).click();
  expect((await done).status(), 'скасування рознесення').toBeLessThan(300);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(row).toContainText('Не рознесено', { timeout: 10_000 });
  return note;
}

/** Вікно «Новий банківський платіж»: рахунок, сума, призначення. */
async function openCreateOut(page: Page, accountId: string, amount: string, purpose: string) {
  await page.getByRole('button', { name: 'Новий платіж' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новий банківський платіж' });
  await expect(dialog).toBeVisible({ timeout: 8_000 });
  await dialog.getByLabel(/Банківський рахунок/).selectOption(accountId);
  await dialog.getByLabel(/^Сума/).fill(amount);
  await dialog.getByLabel('Призначення платежу').fill(purpose);
  return dialog;
}

test.describe('Банківські платежі — скасування рознесення оплати постачальнику (BR-BANK-039)', () => {
  const state: SpState = { token: '', accountId: '', rowIds: [], supplierIds: [] };

  test.beforeEach(async ({ page }) => {
    await page.goto('/bank-statements?direction=OUT');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    state.token = await getToken(page);
    state.accountId = await spAccount(page, state.token);
  });

  test.afterAll(async ({ browser }) => {
    if (!state.token) return;
    const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
    await page.goto('/bank-statements?direction=OUT');
    for (const id of state.rowIds) {
      const del = await spApi(page, state.token, 'DELETE', `/bank-statements/transactions/${id}`);
      expect.soft(del.status, `DELETE рядка ${id}`).toBe(204);
    }
    // Постачальник зі сторнованою оплатою має нульовий борг — видаляється; з проведеною — ні.
    for (const id of state.supplierIds) {
      if ((await spBalance(page, state.token, id)) !== 0) continue;
      const del = await spApi(page, state.token, 'DELETE', `/counterparties/${id}`);
      expect.soft(del.status, `DELETE постачальника ${id}`).toBeLessThan(300);
    }
    await page.close();
  });

  test('оплата, створена з рядка: «Зняти рознесення» → сторно, борг постачальнику повернувся', async ({
    page,
  }) => {
    const stamp = Date.now();
    const supplierName = `000 E2E Постачальник сторно ${stamp}`;
    const supplierId = await spSupplier(page, state, supplierName);
    const purpose = `000 E2E оплата з рядка ${stamp}`;
    const before = await spBalance(page, state.token, supplierId);

    // ── Внесення з рознесенням «Оплата постачальнику» (нова оплата) ──
    const dialog = await openCreateOut(page, state.accountId, uniqueAmount(), purpose);
    await dialog.getByLabel('Рознести як').selectOption('SUPPLIER_PAYMENT');
    await dialog.getByRole('button', { name: 'Обрати' }).first().click();
    const picker = page.getByRole('dialog', { name: 'Оберіть постачальника' });
    await expect(picker).toBeVisible({ timeout: 8_000 });
    await picker.getByPlaceholder('Пошук...').fill(supplierName);
    await picker.getByRole('button', { name: new RegExp(supplierName) }).click();
    await expect(picker).toBeHidden({ timeout: 8_000 });
    await dialog.getByRole('button', { name: 'Внести й рознести' }).click();
    const confirm = page.getByRole('dialog', { name: 'Підтвердіть внесення й рознесення' });
    await expect(confirm).toBeVisible({ timeout: 8_000 });
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await confirm.getByRole('button', { name: 'Підтвердити' }).click();
    const createdRes = await created;
    expect(createdRes.status(), 'платіж внесено й рознесено').toBeLessThan(300);
    const created0 = (await createdRes.json()) as {
      id: string;
      status: string;
      supplierPaymentId: string;
      supplierPaymentFromRow: boolean;
    };
    state.rowIds.push(created0.id);
    expect(created0).toMatchObject({ status: 'MATCHED', supplierPaymentFromRow: true });
    await expect(confirm).toBeHidden({ timeout: 8_000 });
    expect(await spStatus(page, state.token, created0.supplierPaymentId)).toBe('CONFIRMED');
    expect(await spBalance(page, state.token, supplierId), 'оплата змінила борг').not.toBe(before);

    // ── Скасування рознесення: наслідок — сторно ──
    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    const row = page.locator('table tbody tr').filter({ hasText: purpose });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText('Рознесено');
    const note = await unreconcileRow(page, row);
    expect(note).toMatch(/буде сторновано — борг постачальнику повернеться/);

    expect(await spStatus(page, state.token, created0.supplierPaymentId)).toBe('REVERSED');
    expect(await spBalance(page, state.token, supplierId), 'борг повернувся').toBe(before);
  });

  test('оплата, до якої рядок прив’язали: «Зняти рознесення» → лише відв’язка, оплата проведена', async ({
    page,
  }) => {
    const stamp = Date.now();
    const supplierName = `000 E2E Постачальник прив'язка ${stamp}`;
    const supplierId = await spSupplier(page, state, supplierName);
    const purpose = `000 E2E прив'язка ${stamp}`;
    const amount = uniqueAmount();
    // Передумова: оплата постачальнику, проведена окремою дією з цього рахунку на цю суму.
    const sp = await spApi<{ id: string; number: string; status: string }>(
      page,
      state.token,
      'POST',
      '/supplier-payments/pay',
      {
        supplierId,
        sourceType: 'BANK_ACCOUNT',
        bankAccountId: state.accountId,
        amount: Number(amount.replace(',', '.')),
        method: 'bank',
        notes: purpose,
      },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(sp.status, 'проведена оплата для прив’язки').toBeLessThan(300);
    expect(sp.body.status).toBe('CONFIRMED');
    const paid = await spBalance(page, state.token, supplierId);

    // ── Внесення без рознесення ──
    const dialog = await openCreateOut(page, state.accountId, amount, purpose);
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: 'Внести платіж' }).click();
    const createdRes = await created;
    expect(createdRes.status()).toBeLessThan(300);
    state.rowIds.push(((await createdRes.json()) as { id: string }).id);
    await expect(dialog).toBeHidden({ timeout: 8_000 });

    // ── Рознесення: прив'язати до наявної оплати ──
    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    const row = page.locator('table tbody tr').filter({ hasText: purpose });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByRole('button', { name: 'Рознести' }).click();
    const matchDialog = page.getByRole('dialog', { name: 'Рознести вихідний платіж' });
    await expect(matchDialog).toBeVisible({ timeout: 8_000 });
    await matchDialog.locator('select').first().selectOption('SUPPLIER_PAYMENT');
    await matchDialog.getByRole('radio', { name: new RegExp(sp.body.number) }).check();
    await matchDialog.getByRole('button', { name: 'Рознести', exact: true }).click();
    await expect(matchDialog).toBeHidden({ timeout: 10_000 });
    await expect(row).toContainText('Рознесено', { timeout: 10_000 });

    // ── Скасування: наслідок — лише відв'язка ──
    const note = await unreconcileRow(page, row);
    expect(note).toMatch(/лишиться проведеною/);
    expect(await spStatus(page, state.token, sp.body.id)).toBe('CONFIRMED');
    expect(await spBalance(page, state.token, supplierId), 'борг не змінився').toBe(paid);
  });
});
