import { test, expect, type Locator, type Page } from '@playwright/test';
import { API } from './api-url';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const uid = () => Date.now().toString().slice(-6);

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getToken(page: Page): Promise<string> {
  // Playwright не відновлює sessionStorage між контекстами: AuthProvider копіює
  // sto_e2e_access_token з localStorage у sessionStorage на mount (Bug #567).
  return page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ??
      localStorage.getItem('sto_e2e_access_token') ??
      '',
  );
}

async function apiCall<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ url, method, token, body }) => {
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
    { url: `${API}${path}`, method, token, body },
  );
}

async function gotoRules(page: Page) {
  await page.goto('/pricing-rules');
  await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
    timeout: 20_000,
  });
}

async function openCreateForm(page: Page): Promise<Locator> {
  // Add-button renamed to single noun "Правило" (commit 3785721/c3cd333).
  await page
    .getByRole('button', { name: /^Правило$/ })
    .first()
    .click();
  const modal = page.getByRole('dialog', { name: 'Нове правило ціноутворення' });
  await expect(modal).toBeVisible({ timeout: 8_000 });
  return modal;
}

/** Рядок правила в таблиці (через пошук — щоб не залежати від кількості правил у базі). */
async function findRuleRow(page: Page, ruleName: string): Promise<Locator> {
  await page.getByPlaceholder(/^Пошук по назві/).fill(ruleName);
  const row = page.locator('table tbody tr', { hasText: ruleName });
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

async function deleteRuleViaUi(page: Page, row: Locator) {
  await row.getByTitle('Видалити').click();
  const dialog = page.getByRole('dialog', { name: 'Видалити правило ціноутворення?' });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: 'Так' }).click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
}

test.describe('Правила ціноутворення — CRUD', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/pricing-rules');
    await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|правил не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Додати" присутня', async ({ page }) => {
    await page.goto('/pricing-rules');
    await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
      timeout: 20_000,
    });
    // Add-button renamed to single noun "Правило" (commit 3785721/c3cd333).
    await expect(page.getByRole('button', { name: /^Правило$/ }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('створити правило PERCENT → перевірити → видалити', async ({ page }) => {
    const ruleName = `E2E-Правило-${uid()}`;

    await gotoRules(page);
    const modal = await openCreateForm(page);

    await modal.getByPlaceholder('Запчастини +35%').fill(ruleName);
    // Тип PERCENT — типовий; відсоток обов'язковий.
    await modal.getByLabel(/Надбавка, %/).fill('20');

    const saveBtn = modal.getByRole('button', { name: 'Зберегти' });
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    const row = await findRuleRow(page, ruleName);
    await expect(row).toContainText('Весь асортимент');

    // Cleanup — справжнє видалення з підтвердженням (раніше тест шукав кнопку
    // «Помітити на видалення», якої в цьому діалозі немає, і лишав правило в базі).
    await deleteRuleViaUi(page, row);
  });

  test('форма — Зберегти disabled без назви', async ({ page }) => {
    await page.goto('/pricing-rules');
    await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByRole('button', { name: /^Правило$/ })
      .first()
      .click();
    const modal = page.getByRole('dialog', { name: 'Нове правило ціноутворення' });
    await expect(modal).toBeVisible({ timeout: 8_000 });
    // Саме «Зберегти»: старий локатор `button:has-text("Зберегти"), button:has-text("Додати")`
    // після появи кнопки «Додати товар» у формі знаходив би її, а не кнопку збереження.
    await expect(modal.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
    // Форма не має сторожа незбережених змін — закривається одразу.
    await modal.getByRole('button', { name: 'Закрити' }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });
});

// ─── Область правила: категорія з довідника і список товарів ──────────────────
// Рішення власника 2026-10-12: категорія обирається з довідника (не текстом), замість одного
// «конкретного товару» — список товарів правила.

test.describe('Правила ціноутворення — категорія з довідника і список товарів', () => {
  const run = uid();
  const categoryName = `E2E-Категорія-${run}`;
  const goodA = `E2E-Товар-А-${run}`;
  const goodB = `E2E-Товар-Б-${run}`;
  const rulePrefix = `E2E-Обл-${run}`;
  let categoryId = '';
  const goodIds: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await gotoRules(p);
    const cat = await apiCall<{ id: string }>(p, 'POST', '/good-categories', {
      name: categoryName,
    });
    categoryId = cat.id;
    for (const [i, name] of [goodA, goodB].entries()) {
      const g = await apiCall<{ id: string }>(p, 'POST', '/goods', {
        name,
        sku: `E2E-PR-${run}-${i}`,
        salePrice: 100,
      });
      goodIds.push(g.id);
    }
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await gotoRules(p);
    // Правила цього прогону, якщо тест упав до власного видалення.
    const rules = await apiCall<{ items: { id: string; name: string }[] }>(
      p,
      'GET',
      '/pricing-rules',
    );
    for (const r of rules.items.filter(x => x.name.startsWith(rulePrefix))) {
      await apiCall(p, 'DELETE', `/pricing-rules/${r.id}`);
    }
    for (const id of goodIds) await apiCall(p, 'DELETE', `/goods/${id}`);
    if (categoryId) await apiCall(p, 'DELETE', `/good-categories/${categoryId}`);
    await ctx.close();
  });

  test('правило з категорією з довідника → назва категорії в таблиці → видалити', async ({
    page,
  }, testInfo) => {
    expect(categoryId, 'beforeAll має створити категорію').toBeTruthy();
    // Номер спроби в назві: повтор після падіння не має натрапити на правило попередньої спроби.
    const ruleName = `${rulePrefix}-кат-${testInfo.retry}`;

    await gotoRules(page);
    const modal = await openCreateForm(page);
    await modal.getByPlaceholder('Запчастини +35%').fill(ruleName);
    await modal.getByLabel(/Надбавка, %/).fill('15');

    // Категорія — список із довідника, а не текстове поле.
    const category = modal.getByLabel("Категорія (необов'язково)");
    await expect(category.locator(`option[value="${categoryId}"]`)).toHaveText(categoryName, {
      timeout: 10_000,
    });
    await category.selectOption(categoryId);
    // Область має один вимір: категорія сильніша за тип.
    await expect(modal.getByLabel("Тип товару (необов'язково)")).toBeDisabled();

    await modal.getByRole('button', { name: 'Зберегти' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    const row = await findRuleRow(page, ruleName);
    await expect(row).toContainText(`Категорія: ${categoryName}`);

    await deleteRuleViaUi(page, row);
  });

  test('Escape у виборі товару закриває лише його: форма й доданий товар лишаються', async ({
    page,
  }) => {
    expect(goodIds, 'beforeAll має створити два товари').toHaveLength(2);
    await gotoRules(page);
    const modal = await openCreateForm(page);

    await modal.getByRole('button', { name: 'Додати товар' }).click();
    const picker = page.getByRole('dialog', { name: 'Оберіть товар' });
    await expect(picker).toBeVisible({ timeout: 8_000 });
    await picker.getByPlaceholder('Пошук товару / штрих-код...').fill(goodA);
    const item = picker.getByRole('button', { name: new RegExp(goodA) });
    await expect(item).toBeVisible({ timeout: 10_000 });
    // Саме ПІСЛЯ вибору товару Escape раніше закривав і вибір, і форму з незбереженим списком.
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Escape');
    await expect(picker).not.toBeVisible({ timeout: 5_000 });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Товари (1)')).toBeVisible();

    // Другий Escape — уже до форми; нічого не збережено.
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test('правило зі списком товарів: 2 товари → прибрати один → 1 → видалити', async ({
    page,
  }, testInfo) => {
    expect(goodIds, 'beforeAll має створити два товари').toHaveLength(2);
    const ruleName = `${rulePrefix}-тов-${testInfo.retry}`;

    await gotoRules(page);
    const modal = await openCreateForm(page);
    await modal.getByPlaceholder('Запчастини +35%').fill(ruleName);
    await modal.getByLabel(/Надбавка, %/).fill('10');

    // «Додати товар» → модалка множинного вибору: після вибору не закривається.
    await modal.getByRole('button', { name: 'Додати товар' }).click();
    const picker = page.getByRole('dialog', { name: 'Оберіть товар' });
    await expect(picker).toBeVisible({ timeout: 8_000 });
    const search = picker.getByPlaceholder('Пошук товару / штрих-код...');
    for (const name of [goodA, goodB]) {
      await search.fill(name);
      const item = picker.getByRole('button', { name: new RegExp(name) });
      await expect(item).toBeVisible({ timeout: 10_000 });
      await item.click();
      await expect(item).toHaveAttribute('aria-pressed', 'true');
      await expect(picker).toBeVisible();
    }
    await picker.getByRole('button', { name: 'Готово' }).click();
    await expect(picker).not.toBeVisible({ timeout: 5_000 });

    await expect(modal.getByText('Товари (2)')).toBeVisible();
    // Список товарів — єдиний вимір області: бренд, категорію й тип сховано.
    await expect(modal.getByLabel("Бренд (необов'язково)")).toHaveCount(0);
    await expect(modal.getByLabel("Категорія (необов'язково)")).toHaveCount(0);

    await modal.getByRole('button', { name: 'Зберегти' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    const row = await findRuleRow(page, ruleName);
    await expect(row).toContainText('Товари: 2');

    // Редагування: повний список довантажується з сервера.
    await row.getByTitle('Редагувати').click();
    const edit = page.getByRole('dialog', { name: 'Редагування правила' });
    await expect(edit).toBeVisible({ timeout: 8_000 });
    await expect(edit.getByText('Товари (2)')).toBeVisible({ timeout: 10_000 });
    await expect(edit.getByRole('cell', { name: goodA, exact: true })).toBeVisible();
    await expect(edit.getByRole('cell', { name: goodB, exact: true })).toBeVisible();

    await edit.getByRole('button', { name: `Прибрати «${goodA}» зі списку` }).click();
    await expect(edit.getByText('Товари (1)')).toBeVisible();
    await edit.getByRole('button', { name: 'Зберегти' }).click();
    await expect(edit).not.toBeVisible({ timeout: 10_000 });

    await expect(row).toContainText('Товари: 1', { timeout: 10_000 });

    // Збережено саме той товар, що лишився (а не порожній список і не обидва).
    await row.getByTitle('Редагувати').click();
    await expect(edit).toBeVisible({ timeout: 8_000 });
    await expect(edit.getByText('Товари (1)')).toBeVisible({ timeout: 10_000 });
    await expect(edit.getByRole('cell', { name: goodB, exact: true })).toBeVisible();
    await expect(edit.getByRole('cell', { name: goodA, exact: true })).toHaveCount(0);
    await edit.getByRole('button', { name: 'Скасувати' }).click();
    await expect(edit).not.toBeVisible({ timeout: 5_000 });

    await deleteRuleViaUi(page, row);
  });
});
