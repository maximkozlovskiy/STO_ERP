import { test, expect, type Page } from '@playwright/test';
import { API } from './api-url';

// Блок 4 техборгу (рішення власника 2026-10-30), через браузер:
//  - №21 BR-GOOD-009: «Додати всю категорію» у пікері товарів правила — у список ідуть УСІ товари
//    категорії з підкатегоріями, повідомлення «Додано N (уже були M)»; правило зберігається з ними;
//  - №17 BR-GOOD-011: «Розцінити список» — товар без жодного правила ціну не змінює, у звіті
//    рядок «без правила» і лічильник «Без правила».
// Правило створюється й редагується через форму; API — лише передумови (категорії, товари з
// собівартістю) і прибирання.

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString().slice(-6);
const PREFIX = `000 E2E Б4-${run}`;
const ROOT = `${PREFIX} Категорія`;
const SUB = `${PREFIX} Підкатегорія`;
const RULE = `${PREFIX} Правило категорії +40%`;
const GOODS = {
  inRoot: { name: `${PREFIX} Товар у категорії`, sku: `E2E-B4-${run}-1` },
  inSub1: { name: `${PREFIX} Товар підкатегорії 1`, sku: `E2E-B4-${run}-2` },
  inSub2: { name: `${PREFIX} Товар підкатегорії 2`, sku: `E2E-B4-${run}-3` },
  free: { name: `${PREFIX} Товар без правила`, sku: `E2E-B4-${run}-4` },
};

const ids = { root: '', sub: '', goods: {} as Record<keyof typeof GOODS, string> };

async function apiCall<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ url, method, body }) => {
      const token =
        sessionStorage.getItem('sto_access_token') ??
        localStorage.getItem('sto_e2e_access_token') ??
        '';
      const r = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${text}`);
      return (text ? JSON.parse(text) : null) as T;
    },
    { url: `${API}${path}`, method, body },
  );
}

async function gotoRules(page: Page) {
  await page.goto('/pricing-rules');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
}

type RuleRow = {
  id: string;
  name: string;
  isActive: boolean;
  supplierId: string | null;
  hasGoodsList: boolean;
  brandId: string | null;
  goodCategoryId: string | null;
  goodCategory: string | null;
  goodType: string | null;
};

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await gotoRules(p);
  ids.root = (await apiCall<{ id: string }>(p, 'POST', '/good-categories', { name: ROOT })).id;
  ids.sub = (
    await apiCall<{ id: string }>(p, 'POST', '/good-categories', { name: SUB, parentId: ids.root })
  ).id;
  const categoryOf: Record<keyof typeof GOODS, string | undefined> = {
    inRoot: ids.root,
    inSub1: ids.sub,
    inSub2: ids.sub,
    free: undefined,
  };
  for (const key of Object.keys(GOODS) as Array<keyof typeof GOODS>) {
    const g = await apiCall<{ id: string }>(p, 'POST', '/goods', {
      ...GOODS[key],
      purchasePrice: 100,
      salePrice: 175,
      ...(categoryOf[key] ? { goodCategoryId: categoryOf[key] } : {}),
    });
    ids.goods[key] = g.id;
  }
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await gotoRules(p);
  const del = async (path: string) => {
    const error = await apiCall(p, 'DELETE', path).then(
      () => null,
      (e: unknown) => String(e),
    );
    expect.soft(error, `прибрати ${path}`).toBeNull();
  };
  const rules = await apiCall<{ items: RuleRow[] }>(p, 'GET', '/pricing-rules');
  for (const r of rules.items.filter(x => x.name.startsWith(PREFIX)))
    await del(`/pricing-rules/${r.id}`);
  for (const id of Object.values(ids.goods)) if (id) await del(`/goods/${id}`);
  if (ids.sub) await del(`/good-categories/${ids.sub}`);
  if (ids.root) await del(`/good-categories/${ids.root}`);
  await ctx.close();
});

// guards: BR-GOOD-009
test('«Додати всю категорію»: у список правила — усі товари категорії з підкатегоріями', async ({
  page,
}) => {
  expect(ids.root, 'beforeAll має створити категорії й товари').toBeTruthy();
  await gotoRules(page);
  await page
    .getByRole('button', { name: /^Правило$/ })
    .first()
    .click();
  const form = page.getByRole('dialog', { name: 'Нове правило ціноутворення' });
  await expect(form).toBeVisible({ timeout: 8_000 });
  await form.getByPlaceholder('Запчастини +35%').fill(RULE);
  await form.getByLabel(/Надбавка, %/).fill('40');

  await form.getByRole('button', { name: 'Додати товар' }).click();
  const picker = page.getByRole('dialog', { name: 'Оберіть товар' });
  await expect(picker).toBeVisible({ timeout: 8_000 });
  // Без категорії — дії немає: «усе показане» і «уся категорія» — різні речі.
  await expect(picker.getByRole('button', { name: 'Додати всю категорію' })).toHaveCount(0);
  await picker.getByText(ROOT, { exact: true }).click();
  await picker.getByRole('button', { name: 'Додати всю категорію' }).click();

  // Тост і рядок під списком — однаковий текст; перевіряємо рядок форми (тост зникає сам).
  await expect(form.getByRole('status').filter({ hasText: 'Додано 3 (уже були 0)' })).toBeVisible({
    timeout: 10_000,
  });
  await picker.getByRole('button', { name: 'Готово' }).click();
  await expect(picker).not.toBeVisible({ timeout: 5_000 });
  await expect(form.getByText('Товари (3)')).toBeVisible();
  for (const g of [GOODS.inRoot, GOODS.inSub1, GOODS.inSub2])
    await expect(form.getByRole('cell', { name: g.name, exact: true })).toBeVisible();
  await expect(form.getByRole('cell', { name: GOODS.free.name, exact: true })).toHaveCount(0);

  await form.getByRole('button', { name: 'Зберегти' }).click();
  await expect(form).not.toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder(/^Пошук по назві/).fill(RULE);
  await expect(page.locator('table tbody tr', { hasText: RULE })).toContainText('Товари: 3', {
    timeout: 15_000,
  });
});

// guards: BR-GOOD-011
test('«Розцінити список»: товар без правила — ціна та сама, у звіті «без правила»', async ({
  page,
}) => {
  await gotoRules(page);
  // Передумова: правило «весь асортимент» розцінило б і «вільний» товар — тоді перевіряти нічого.
  const rules = await apiCall<{ items: RuleRow[] }>(page, 'GET', '/pricing-rules');
  const catchAll = rules.items.filter(
    r =>
      r.isActive &&
      !r.supplierId &&
      !r.hasGoodsList &&
      !r.brandId &&
      !r.goodCategoryId &&
      !r.goodCategory &&
      !r.goodType,
  );
  test.skip(catchAll.length > 0, `у базі є правило на весь асортимент: ${catchAll[0]?.name}`);
  expect(
    rules.items.some(r => r.name === RULE),
    'попередній тест має зберегти правило',
  ).toBe(true);

  await page.getByRole('button', { name: 'Розцінити список' }).click();
  await page
    .locator('input[type="file"][accept*=".csv"]')
    .first()
    .setInputFiles({
      name: 'список.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`sku\n${GOODS.inRoot.sku}\n${GOODS.free.sku}\n`, 'utf-8'),
    });
  await page.getByRole('button', { name: 'Розцінити', exact: true }).click();

  const free = page.locator('tr', { hasText: GOODS.free.name });
  await expect(free).toBeVisible({ timeout: 15_000 });
  await expect(free).toContainText('без правила');
  await expect(free).toContainText('175,00');
  const ruled = page.locator('tr', { hasText: GOODS.inRoot.name });
  await expect(ruled).toContainText('140,00 ₴');
  await expect(ruled).not.toContainText('без правила');
  const counter = page.locator('span', { hasText: 'Без правила:' });
  await expect(counter.locator('strong')).toHaveText('1');

  // Ціна товару без правила в базі та сама; розцінений — за правилом.
  const freeGood = await apiCall<{ salePrice: number }>(page, 'GET', `/goods/${ids.goods.free}`);
  const ruledGood = await apiCall<{ salePrice: number }>(page, 'GET', `/goods/${ids.goods.inRoot}`);
  expect(Number(freeGood.salePrice)).toBe(175);
  expect(Number(ruledGood.salePrice)).toBe(140);
});
