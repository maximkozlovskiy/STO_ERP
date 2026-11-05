import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { clearDateFilter } from './fixtures';

/**
 * Друк і «Зберегти як» (PDF / Excel / Word) рахунку, замовлення постачальнику, складського
 * документа й повернення (BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014) + рядок списку з
 * клавіатури (TECH-DEBT (б) №27).
 *
 * Документи створюються через інтерфейс; контрагент (довідник) — через API. Файл перевіряється
 * подією завантаження Playwright: ім'я — `<Тип>-<номер>.<формат>` із `Content-Disposition`.
 */

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const uid = Date.now().toString().slice(-6);
const PARTNER = `000 E2E Друк ${uid}`;

const state: {
  token?: string;
  cpId?: string;
  invoice?: { id: string; number: string };
  po?: { id: string; number: string };
  sd?: { id: string; number: string };
  sr?: { id: string; number: string };
} = {};

const safe = (n: string) => n.replace(/[/\\:*?"<>|]/g, '-');

/** «Зберегти як» кожного формату: подія завантаження з очікуваним іменем файла. */
async function saveAsAll(page: Page, card: Locator, prefix: string, number: string) {
  for (const [item, ext] of [
    ['PDF', 'pdf'],
    ['Excel (.xlsx)', 'xlsx'],
    ['Word (.docx)', 'docx'],
  ] as const) {
    await card.getByRole('button', { name: /Зберегти як/ }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: item, exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename(), `${prefix} ${ext}`).toBe(`${prefix}-${safe(number)}.${ext}`);
    expect(await file.failure()).toBeNull();
  }
}

/** Вибрати контрагента в підборі картки за назвою. */
async function pickPartner(page: Page, card: Locator, placeholder: string) {
  await card.locator('button[aria-label="Обрати"]').first().click();
  const picker = page
    .locator('[role="dialog"]')
    .filter({ has: page.locator(`input[placeholder="${placeholder}"]`) })
    .first();
  await expect(picker).toBeVisible({ timeout: 5_000 });
  await picker.locator(`input[placeholder="${placeholder}"]`).fill(PARTNER);
  await picker.locator('button.w-full.text-left', { hasText: PARTNER }).first().click();
  await expect(picker).not.toBeVisible({ timeout: 5_000 });
}

/** Рядок товару в картці: «Додати» → підбір першого товару → кількість і ціна → «Зберегти рядок». */
async function addGoodLine(page: Page, card: Locator, saveRow = 'Зберегти рядок') {
  await card.getByRole('button', { name: 'Додати', exact: true }).click();
  const inputRow = card
    .locator('tr')
    .filter({ has: page.getByTitle(saveRow) })
    .first();
  await expect(inputRow).toBeVisible({ timeout: 5_000 });
  await inputRow.locator('button[aria-label="Обрати"]').click();
  const goodPicker = page
    .locator('[role="dialog"]')
    .filter({ has: page.getByPlaceholder('Назва, артикул / штрих-код…') })
    .first();
  await expect(goodPicker).toBeVisible({ timeout: 5_000 });
  await goodPicker.locator('button.w-full.text-left').first().click();
  await expect(goodPicker).not.toBeVisible({ timeout: 5_000 });
  const numbers = inputRow.locator('input[type="number"]');
  await numbers.nth(0).fill('2');
  await numbers.nth(1).fill('100');
  await inputRow.getByTitle(saveRow).click();
  await expect(card.getByTitle(saveRow)).toHaveCount(0);
}

/** Склад картки: якщо не підставився сам (єдиний склад), — перший зі списку. */
async function pickWarehouse(card: Locator) {
  const select = card.getByLabel(/^Склад/).first();
  await expect(select).toBeVisible({ timeout: 5_000 });
  if ((await select.inputValue()) === '') await select.selectOption({ index: 1 });
}

/** Документ, який створила картка: відповідь POST <path>. */
function created(page: Page, path: string) {
  return page.waitForResponse(
    r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(path),
  );
}

test.describe('друк і «Зберегти як» документів', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/invoices');
    state.token = await getToken(page);
    const cp = await apiCall<{ id: string }>(page, state.token, 'POST', '/counterparties', {
      type: 'BOTH',
      companyName: PARTNER,
    });
    expect(cp.status, 'контрагент для документів').toBe(201);
    state.cpId = cp.body.id;
    await ctx.close();
  });

  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    for (const [path, doc] of [
      ['/invoices', state.invoice],
      ['/purchase-orders', state.po],
      ['/stock-documents', state.sd],
      ['/supplier-returns', state.sr],
    ] as const) {
      if (!doc) continue;
      const del = await apiRequest(request, token, 'DELETE', `${path}/${doc.id}`);
      expect.soft([200, 204, 404], `DELETE ${path} ${doc.number}`).toContain(del.status);
    }
    if (state.cpId) {
      const del = await apiRequest(request, token, 'DELETE', `/counterparties/${state.cpId}`);
      expect.soft(del.status, 'DELETE контрагента').toBeLessThan(300);
    }
  });

  // guards: BR-INV-028
  test('рахунок: створити в картці → «Зберегти як» PDF / Excel / Word з іменем Рахунок-<номер>', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const card = page.locator('[role="dialog"]').first();
    await expect(card.locator('h2:has-text("Новий рахунок")')).toBeVisible({ timeout: 10_000 });
    await pickPartner(page, card, "Ім'я, телефон, компанія...");
    await card.getByRole('button', { name: 'Додати', exact: true }).click();
    await card.getByPlaceholder('Опис позиції…').fill('000 E2E послуга друку');
    await card.getByPlaceholder('0.00').first().fill('100');
    await card.locator('button:has(svg.lucide-plus)').last().click();
    const res = created(page, '/invoices');
    await card.getByRole('button', { name: 'Створити рахунок' }).click();
    const body = (await (await res).json()) as { id: string; number: string };
    state.invoice = { id: body.id, number: body.number };
    await expect(card).not.toBeVisible({ timeout: 10_000 });

    await page.goto(`/invoices?open=${body.id}`);
    const opened = page.getByRole('dialog').filter({ hasText: body.number }).first();
    await expect(opened.getByRole('button', { name: /Зберегти як/ })).toBeVisible({
      timeout: 15_000,
    });
    await saveAsAll(page, opened, 'Рахунок', body.number);
  });

  // guards: TECH-DEBT (б) №27
  test('список рахунків: Tab до рядка, Enter → бокова панель', async ({ page }) => {
    await page.goto('/invoices');
    await clearDateFilter(page);
    await page.locator('input[placeholder*="Пошук"]').first().fill(state.invoice!.number);
    const row = page.locator(`table tbody tr:has-text("${state.invoice!.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.focus();
    await expect(row).toBeFocused();
    // Tab із рядка йде всередину нього (прапорець, номер) — Shift+Tab повертає на рядок.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { level: 2, name: state.invoice!.number }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  // guards: BR-PO-016
  test('замовлення постачальнику: створити в картці → «Зберегти як» усіх форматів', async ({
    page,
  }) => {
    await page.goto('/purchase-orders');
    await page
      .getByRole('button', { name: /^Замовлення$/ })
      .first()
      .click();
    const card = page.locator('[role="dialog"]').first();
    await expect(card.locator('h2:has-text("Нове замовлення")')).toBeVisible({ timeout: 10_000 });
    await pickPartner(page, card, 'Назва, телефон, компанія...');
    await pickWarehouse(card);
    await addGoodLine(page, card);
    const res = created(page, '/purchase-orders');
    await card.getByRole('button', { name: 'Створити замовлення' }).click();
    const body = (await (await res).json()) as { id: string; number: string };
    state.po = { id: body.id, number: body.number };
    await expect(card).not.toBeVisible({ timeout: 10_000 });

    await page.goto(`/purchase-orders?open=${body.id}`);
    const opened = page.getByRole('dialog').filter({ hasText: body.number }).first();
    await expect(opened.getByRole('button', { name: /Зберегти як/ })).toBeVisible({
      timeout: 15_000,
    });
    await saveAsAll(page, opened, 'Замовлення', body.number);
  });

  // guards: BR-SDOC-009
  test('складський документ (списання): створити в картці → «Зберегти як» з іменем Списання-<номер>', async ({
    page,
  }) => {
    await page.goto('/stock-documents');
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const card = page.locator('[role="dialog"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByLabel('Філія*').selectOption({ index: 1 });
    await card.locator('select').nth(2).selectOption({ index: 1 });
    const res = created(page, '/stock-documents');
    await card.getByRole('button', { name: 'Створити документ' }).click();
    const body = (await (await res).json()) as { id: string; number: string; type: string };
    state.sd = { id: body.id, number: body.number };
    expect(body.type).toBe('WRITEOFF');
    await expect(card).not.toBeVisible({ timeout: 10_000 });

    await page.goto(`/stock-documents?open=${body.id}`);
    const opened = page.getByRole('dialog').filter({ hasText: body.number }).first();
    await expect(opened.getByRole('button', { name: /Зберегти як/ })).toBeVisible({
      timeout: 15_000,
    });
    await saveAsAll(page, opened, 'Списання', body.number);
  });

  // guards: BR-SRET-014
  test('повернення: створити в картці → «Друк» відкриває PDF, «Зберегти як» усіх форматів', async ({
    page,
  }) => {
    await page.goto('/purchase-orders?tab=returns');
    await page
      .locator('button')
      .filter({ hasText: /^Повернення$/ })
      .first()
      .click();
    const card = page.locator('[role="dialog"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await pickPartner(page, card, 'Пошук...');
    await pickWarehouse(card);
    await addGoodLine(page, card, 'Додати рядок');
    const res = created(page, '/supplier-returns');
    await card.getByRole('button', { name: 'Створити повернення' }).click();
    const body = (await (await res).json()) as { id: string; number: string };
    state.sr = { id: body.id, number: body.number };
    await expect(card).not.toBeVisible({ timeout: 10_000 });

    await page.goto(`/purchase-orders?tab=returns&openReturn=${body.id}`);
    const opened = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: /Друк/ }) })
      .first();
    await expect(opened.getByRole('button', { name: /Друк/ })).toBeVisible({ timeout: 15_000 });

    const pdf = page.waitForResponse(
      r => r.url().includes(`/supplier-returns/${body.id}/export/pdf`) && r.status() === 200,
    );
    const popup = page.waitForEvent('popup');
    await opened.getByRole('button', { name: /Друк/ }).click();
    const [win, pdfRes] = await Promise.all([popup, pdf]);
    expect(pdfRes.headers()['content-type']).toBe('application/pdf');
    await win.close();

    await saveAsAll(page, opened, 'Повернення', body.number);
  });
});
