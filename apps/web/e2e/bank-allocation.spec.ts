import { test, expect, type Page } from '@playwright/test';
import { API } from './api-url';

test.use({ storageState: 'e2e/.auth/admin.json' });

/**
 * «Рознести як» у вікні «Новий банківський платіж» (BR-BANK-041): одна дія — платіж внесено й
 * рознесено; рознесення не вдалося — платежу немає.
 *
 * Наскрізне, чого unit-тести не доводять: справжня транзакція БД і справжня відмова оплати
 * (`PaymentsService.create` із перевіркою статусу рахунку) замість підробок, і що список після
 * відмови справді не показує платежу. Свої дані — з префіксом BNK10: клієнт і рахунок клієнта
 * лишаються (оплату клієнта в системі не сторнують), вихідний платіж прибирається наприкінці.
 */

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

const OWN_ACCOUNT = '000 E2E Банк UAH (рознесення)';
const OWN_CATEGORY = 'E2E Витрата (рознесення)';

/**
 * Власний гривневий банківський рахунок і стаття витрат сценарію: у чистій базі CI їх немає, а
 * покладатися на «перший-ліпший» рахунок dev-бази не можна. Беремо наявні з цими назвами або
 * створюємо — без накопичення між прогонами.
 */
async function ownRefs(
  page: Page,
): Promise<{ accountId: string; categoryId: string; categoryName: string }> {
  const token = await getToken(page);
  const refs = await page.evaluate(
    async ({ token, API, OWN_ACCOUNT, OWN_CATEGORY }) => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const list = async (path: string) => {
        const data = await (await fetch(`${API}${path}`, { headers: auth })).json();
        return (data.items ?? data) as Array<Record<string, unknown>>;
      };
      let account = (await list('/bank-accounts')).find(a => a.name === OWN_ACCOUNT);
      if (!account) {
        const currencies = await list('/currencies');
        const uah = currencies.find(c => c.code === 'UAH');
        const res = await fetch(`${API}/bank-accounts`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            name: OWN_ACCOUNT,
            ibanUA: `UA${String(Date.now()).slice(-9).padStart(27, '0')}`,
            currencyId: uah?.id,
          }),
        });
        account = (await res.json()) as Record<string, unknown>;
      }
      const flat: Array<Record<string, unknown>> = [];
      const walk = (nodes: Array<Record<string, unknown>>) =>
        nodes.forEach(n => {
          flat.push(n);
          if (Array.isArray(n.children)) walk(n.children as Array<Record<string, unknown>>);
        });
      walk(await list('/expense-categories'));
      let category = flat.find(c => c.name === OWN_CATEGORY && c.isActive !== false);
      if (!category) {
        const res = await fetch(`${API}/expense-categories`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ name: OWN_CATEGORY, type: 'EXPENSE' }),
        });
        category = (await res.json()) as Record<string, unknown>;
      }
      return {
        accountId: String(account?.id ?? ''),
        categoryId: String(category?.id ?? ''),
        categoryName: String(category?.name ?? ''),
      };
    },
    { token, API, OWN_ACCOUNT, OWN_CATEGORY },
  );
  expect(refs.accountId, 'власний гривневий банківський рахунок сценарію').toBeTruthy();
  expect(refs.categoryId, 'власна стаття витрат сценарію').toBeTruthy();
  return refs;
}

interface Fixtures {
  accountId: string;
  clientName: string;
  invoiceId: string;
  invoiceNumber: string;
}

/** UAH-рахунок (наявний), клієнт BNK10 і виставлений йому рахунок на `invoiceAmount`. */
async function clientInvoice(page: Page, invoiceAmount: number): Promise<Fixtures> {
  const token = await getToken(page);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const result = await page.evaluate(
    async ({ token, API, stamp, invoiceAmount }) => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const call = async (path: string, init: RequestInit = {}) => {
        const res = await fetch(`${API}${path}`, { ...init, headers: auth });
        return { status: res.status, body: (await res.json().catch(() => null)) as never };
      };
      const clientName = `BNK10 Клієнт ${stamp}`;
      const cp = await call('/counterparties', {
        method: 'POST',
        body: JSON.stringify({ type: 'CLIENT', companyName: clientName }),
      });
      const cpId = (cp.body as { id?: string } | null)?.id;
      const inv = await call('/invoices', {
        method: 'POST',
        body: JSON.stringify({ counterpartyId: cpId, amount: invoiceAmount }),
      });
      const invoice = inv.body as { id?: string; number?: string } | null;
      const sent = await call(`/invoices/${invoice?.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: 'SENT' }),
      });
      return {
        clientName,
        cp: cp.status,
        inv: inv.status,
        sent: sent.status,
        invoiceId: invoice?.id ?? '',
        invoiceNumber: invoice?.number ?? '',
      };
    },
    { token, API, stamp, invoiceAmount },
  );
  expect(result.cp, 'клієнт BNK10 створюється').toBeLessThan(300);
  expect(result.inv, 'рахунок клієнту створюється').toBeLessThan(300);
  expect(result.sent, 'рахунок виставляється').toBeLessThan(300);
  const { accountId } = await ownRefs(page);
  return { ...result, accountId };
}

async function invoiceStatus(page: Page, invoiceId: string): Promise<string> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, API, invoiceId }) => {
      const res = await fetch(`${API}/invoices/${invoiceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return ((await res.json()) as { status: string }).status;
    },
    { token, API, invoiceId },
  );
}

/** Платежі з цим призначенням, які бачить користувач (видалені список не віддає). */
async function paymentsWithPurpose(page: Page, purpose: string) {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, API, purpose }) => {
      const res = await fetch(
        `${API}/bank-statements/transactions?q=${encodeURIComponent(purpose)}&limit=50`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return ((await res.json()) as { items: { id: string; status: string }[] }).items;
    },
    { token, API, purpose },
  );
}

/** Вікно «Новий банківський платіж»: рахунок, сума, призначення. */
async function openCreate(page: Page, accountId: string, amount: string, purpose: string) {
  await page.getByRole('button', { name: 'Новий платіж' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новий банківський платіж' });
  await expect(dialog).toBeVisible({ timeout: 8_000 });
  await dialog.getByLabel(/Банківський рахунок/).selectOption(accountId);
  await dialog.getByLabel(/^Сума/).fill(amount);
  await dialog.getByLabel('Призначення платежу').fill(purpose);
  return dialog;
}

/** Обрати запис у пікері поля (n-та кнопка «Обрати» у вікні) пошуком за текстом. */
async function pick(
  page: Page,
  dialogName: string,
  nth: number,
  pickerTitle: string,
  text: string,
) {
  await page
    .getByRole('dialog', { name: dialogName })
    .getByRole('button', { name: 'Обрати' })
    .nth(nth)
    .click();
  const picker = page.getByRole('dialog', { name: pickerTitle });
  await expect(picker).toBeVisible({ timeout: 8_000 });
  await picker.getByPlaceholder('Пошук...').fill(text);
  await picker.getByRole('button', { name: new RegExp(text) }).click();
  await expect(picker).toBeHidden({ timeout: 8_000 });
}

test.describe('Новий банківський платіж — «Рознести як»', () => {
  test('вхідний платіж «Оплата рахунку» одним кроком: рахунок оплачено, рядок «Рознесено»', async ({
    page,
  }) => {
    await page.goto('/bank-statements?direction=IN');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    const fx = await clientInvoice(page, 300);
    const purpose = `BNK10 вхідний ${Date.now()}`;

    const dialog = await openCreate(page, fx.accountId, '300', purpose);
    await dialog.getByLabel('Рознести як').selectOption('INVOICE');
    await pick(page, 'Новий банківський платіж', 0, 'Оберіть контрагента', fx.clientName);
    await pick(page, 'Новий банківський платіж', 1, 'Оберіть рахунок', fx.invoiceNumber);
    await dialog.getByRole('button', { name: 'Внести й рознести' }).click();

    // Оплата рахунку проводить гроші — спершу крок підтвердження.
    const confirm = page.getByRole('dialog', { name: 'Підтвердіть внесення й рознесення' });
    await expect(confirm.getByRole('note')).toContainText(fx.invoiceNumber);
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await confirm.getByRole('button', { name: 'Підтвердити' }).click();
    const res = await created;
    expect(res.status(), 'платіж внесено й рознесено одним запитом').toBeLessThan(300);
    expect(await res.json()).toMatchObject({ status: 'MATCHED', matchedType: 'INVOICE' });
    await expect(confirm).toBeHidden({ timeout: 8_000 });

    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    const row = page.locator('table tbody tr').filter({ hasText: purpose });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText('Рознесено');
    await expect(row).toContainText('Оплата рахунку');
    await expect(row).toContainText(fx.clientName);
    expect(await invoiceStatus(page, fx.invoiceId)).toBe('PAID');
  });

  test('вихідний платіж «Витрата» одним кроком: рядок «Рознесено» зі статтею', async ({ page }) => {
    await page.goto('/bank-statements?direction=OUT');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const refs = await ownRefs(page);
    const purpose = `BNK10 вихідний ${Date.now()}`;

    const dialog = await openCreate(page, refs.accountId, '45,60', purpose);
    await expect(dialog.getByRole('button', { name: 'Вихідний' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog.getByLabel('Рознести як').selectOption('EXPENSE');
    await dialog.getByLabel(/Стаття витрат/).selectOption(refs.categoryId);
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: 'Внести й рознести' }).click();
    const res = await created;
    expect(res.status()).toBeLessThan(300);
    const body = (await res.json()) as { id: string; status: string; expenseCategoryId: string };
    expect(body).toMatchObject({ status: 'MATCHED', expenseCategoryId: refs.categoryId });
    await expect(dialog).toBeHidden({ timeout: 8_000 });

    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    const row = page.locator('table tbody tr').filter({ hasText: purpose });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText('−45,60');
    await expect(row).toContainText('Рознесено');
    await expect(row).toContainText('Витрата');
    await expect(row).toContainText(refs.categoryName);

    // Прибрати за собою: витрата лише класифікує платіж — зняти рознесення й видалити рядок.
    const cleanup = await page.evaluate(
      async ({ token, API, id }) => {
        const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const undo = await fetch(`${API}/bank-statements/transactions/${id}/unreconcile`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ reason: 'BNK10: прибирання E2E' }),
        });
        const del = await fetch(`${API}/bank-statements/transactions/${id}`, {
          method: 'DELETE',
          headers: { Authorization: auth.Authorization },
        });
        return [undo.status, del.status];
      },
      { token, API, id: body.id },
    );
    expect(cleanup).toEqual([201, 204]);
  });

  // Суму, більшу за залишок рахунку, вікно вже не відправляє (Bug #863) — відмову сервера дає
  // рахунок, скасований, поки вікно було відкрите на кроці підтвердження.
  test('рознесення не вдалося (рахунок скасовано, поки вікно відкрите) → помилка у вікні, платежу немає', async ({
    page,
  }) => {
    await page.goto('/bank-statements?direction=IN');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    const fx = await clientInvoice(page, 100);
    const purpose = `BNK10 відмова ${Date.now()}`;

    const dialog = await openCreate(page, fx.accountId, '80', purpose);
    await dialog.getByLabel('Рознести як').selectOption('INVOICE');
    await pick(page, 'Новий банківський платіж', 0, 'Оберіть контрагента', fx.clientName);
    await pick(page, 'Новий банківський платіж', 1, 'Оберіть рахунок', fx.invoiceNumber);
    await dialog.getByRole('button', { name: 'Внести й рознести' }).click();
    const confirm = page.getByRole('dialog', { name: 'Підтвердіть внесення й рознесення' });
    await expect(confirm).toBeVisible({ timeout: 8_000 });
    const token = await getToken(page);
    const cancelled = await page.evaluate(
      async ({ token, API, invoiceId }) => {
        const res = await fetch(`${API}/invoices/${invoiceId}/transition`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'CANCELLED' }),
        });
        return res.status;
      },
      { token, API, invoiceId: fx.invoiceId },
    );
    expect(cancelled, 'рахунок скасовується').toBeLessThan(300);
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await confirm.getByRole('button', { name: 'Підтвердити' }).click();
    expect((await created).status(), 'відмова оплати — 400').toBe(400);

    // Вікно лишається відкритим, з текстом відмови сервера, на кроці форми.
    const form = page.getByRole('dialog', { name: 'Новий банківський платіж' });
    await expect(form.getByRole('alert')).toContainText('оплата неможлива');
    await expect(form.getByLabel('Рознести як')).toHaveValue('INVOICE');
    // Уведене не губиться мовчки (Bug #862): закриття питає підтвердження.
    await form.getByRole('button', { name: 'Скасувати' }).click();
    await page.getByRole('button', { name: 'Покинути' }).click();
    await expect(form).toBeHidden({ timeout: 8_000 });

    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    await expect(page.locator('table tbody tr').filter({ hasText: purpose })).toHaveCount(0, {
      timeout: 10_000,
    });
    expect(await paymentsWithPurpose(page, purpose)).toEqual([]);
    expect(await invoiceStatus(page, fx.invoiceId)).toBe('CANCELLED');
  });
});
