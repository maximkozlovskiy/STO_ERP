import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, getToken } from './api-helpers';

/**
 * Каталог, блок 4 техборгу (рішення власника 2026-10-30) — через інтерфейс:
 *  · BR-GOOD-007 (№10): видалений бренд відновлюється разом із синонімами, знятими разом із ним;
 *    синонім, написання якого тим часом стало назвою іншого бренду, не повертається — сторінка
 *    його називає. (Синонім, доданий іншому бренду, — не той випадок: зняте написання переїжджає
 *    до нового власника разом із рядком і вже не належить відновлюваному бренду.)
 *  · BR-GOOD-010 (№14): категорію товарів, яку використовує правило ціни, не видалити — вікно
 *    категорій показує відмову сервера з назвою правила, категорія лишається.
 *
 * Бренди створюються, видаляються й відновлюються в UI; категорія і правило ціни — передумови
 * через API (їх UI окремо стережуть crud-pricing-rules і crud-catalog).
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString().slice(-6);

async function gotoCatalogTab(page: Page, tab: 'Бренди' | 'Товари') {
  await page.goto('/catalog');
  await expect(page.locator('h1:has-text("Каталог")')).toBeVisible({ timeout: 25_000 });
  await page.locator(`button:has-text("${tab}")`).first().click();
}

function brandRow(page: Page, name: string): Locator {
  return page.locator('tr', { has: page.getByText(name, { exact: true }) });
}

async function createBrandViaUi(page: Page, name: string, synonyms: string[]) {
  await page.getByRole('button', { name: 'Бренд', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: 'Новий бренд' })).toBeVisible();
  await modal.getByPlaceholder('наприклад: Bosch, NGK, Brembo').fill(name);
  const synonymInput = modal.getByPlaceholder(/Введіть синонім/);
  for (const s of synonyms) {
    await synonymInput.fill(s);
    await synonymInput.press('Enter');
    await expect(modal.getByText(s, { exact: true })).toBeVisible();
  }
  await modal.getByRole('button', { name: 'Зберегти' }).click();
  await expect(modal).not.toBeVisible({ timeout: 10_000 });
  await expect(brandRow(page, name)).toBeVisible({ timeout: 10_000 });
}

test.describe('Бренди — відновлення з синонімами (BR-GOOD-007, №10)', () => {
  const brandA = `000 E2E Бренд ${run}`;
  const kept = `000e2e-a-${run}`;
  // Синонім бренду A, який поки A видалений, стає назвою бренду B.
  const brandB = `000 E2E Власник ${run}`;
  const taken = brandB;

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/catalog');
    const token = await getToken(p);
    const list = await apiCall<{ items: Array<{ id: string; name: string }> }>(
      p,
      token,
      'GET',
      '/brands?limit=200',
    );
    for (const b of (list.body?.items ?? []).filter(x => [brandA, brandB].includes(x.name))) {
      const res = await apiCall(p, token, 'DELETE', `/brands/${b.id}`);
      expect.soft(res.status, `прибирання бренду ${b.name}`).toBe(204);
    }
    await ctx.close();
  });

  // guards: BR-GOOD-007
  test('видалити бренд → синонім став назвою іншого бренду → відновити: свій синонім на місці, зайнятий названо', async ({
    page,
  }) => {
    await gotoCatalogTab(page, 'Бренди');
    await expect(page.getByRole('button', { name: 'Бренд', exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await createBrandViaUi(page, brandA, [kept, taken]);

    // Видалення: синоніми знімаються разом із брендом і стають вільними.
    const rowA = brandRow(page, brandA);
    await rowA.hover();
    await rowA.getByTitle('Помітити на видалення').click();
    const confirm = page.getByRole('dialog');
    await confirm.getByRole('button', { name: 'Так' }).click();
    await expect(brandRow(page, brandA)).toHaveCount(0, { timeout: 10_000 });

    // Поки бренд видалений, його синонім стає назвою іншого бренду.
    await createBrandViaUi(page, brandB, []);

    await page.getByTitle('Показати видалені').click();
    const deletedRow = brandRow(page, brandA);
    await expect(deletedRow).toBeVisible({ timeout: 10_000 });
    await deletedRow.getByTitle('Відновити').click();

    await expect(
      page.getByText(
        `Бренд «${brandA}» відновлено без синонімів, які вже має інший бренд: ${taken}`,
      ),
    ).toBeVisible({ timeout: 10_000 });

    // Рядок бренду: свій синонім повернувся, зайнятий — ні (він назва бренду B).
    const restoredRow = brandRow(page, brandA);
    await expect(restoredRow.getByText(kept, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(restoredRow.getByText(taken, { exact: true })).toHaveCount(0);
  });
});

test.describe('Категорії товарів — категорію з правилом ціни не видалити (BR-GOOD-010, №14)', () => {
  const categoryName = `000 E2E Категорія ${run}`;
  const ruleName = `000 E2E Правило категорії ${run}`;
  let categoryId = '';
  let ruleId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/catalog');
    const token = await getToken(p);
    const cat = await apiCall<{ id: string }>(p, token, 'POST', '/good-categories', {
      name: categoryName,
    });
    expect(cat.status, 'категорія-передумова').toBe(201);
    categoryId = cat.body.id;
    const rule = await apiCall<{ id: string }>(p, token, 'POST', '/pricing-rules', {
      name: ruleName,
      type: 'PERCENT',
      percentValue: 15,
      goodCategoryId: categoryId,
    });
    expect(rule.status, 'правило-передумова').toBe(201);
    ruleId = rule.body.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/catalog');
    const token = await getToken(p);
    // Спершу правило — інакше категорію не видалити (саме це правило й перевіряється).
    if (ruleId)
      expect
        .soft((await apiCall(p, token, 'DELETE', `/pricing-rules/${ruleId}`)).status)
        .toBeLessThan(300);
    if (categoryId)
      expect
        .soft((await apiCall(p, token, 'DELETE', `/good-categories/${categoryId}`)).status)
        .toBeLessThan(300);
    await ctx.close();
  });

  // guards: BR-GOOD-010
  test('видалити категорію з правилом → відмова з назвою правила, категорія лишається', async ({
    page,
  }) => {
    expect(categoryId && ruleId, 'beforeAll має створити категорію й правило').toBeTruthy();
    await gotoCatalogTab(page, 'Товари');
    await page.getByTitle('Управління категоріями').first().click();
    const manager = page.getByRole('dialog', { name: /Управління — Категорії товарів/ });
    await expect(manager).toBeVisible({ timeout: 10_000 });

    const node = manager.locator('li', { has: page.getByText(categoryName, { exact: true }) });
    await node.getByText(categoryName, { exact: true }).hover();
    await node.getByTitle('Видалити').first().click();
    await page
      .getByRole('dialog', { name: `Видалити "${categoryName}"?` })
      .getByRole('button', {
        name: 'Так',
      })
      .click();

    await expect(
      page.getByText(
        `Категорію не видалити: її використовують правила ціни — «${ruleName}». Спершу змініть категорію в правилах`,
      ),
    ).toBeVisible({ timeout: 10_000 });
    await expect(manager.getByText(categoryName, { exact: true })).toBeVisible();
  });
});
