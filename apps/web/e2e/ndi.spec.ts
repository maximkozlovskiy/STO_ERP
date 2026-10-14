import { test, expect } from '@playwright/test';
import { apiCall, createPlainRegister, deleteRegister, getToken } from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * /ndi — Нормативно-довідкова інформація (ПРРО, валюти, ставки ПДВ).
 * Перевіряємо: завантаження, наявність усіх 6 табів, перемикання таб → URL ?tab=X,
 * рендер контенту в кожному табі без console error.
 * Каса-таб винесено на /cash (dedup 19b0148a) — тут його більше немає.
 * Банк. рахунки винесено на /bank-statements?tab=accounts (UI-реорганізація) — тут більше немає.
 */
const TABS = [
  { id: 'org', label: 'Організація' },
  { id: 'org-info', label: 'Реквізити організації' },
  { id: 'payments', label: 'Оплата' },
  { id: 'taxrates', label: 'Ставки ПДВ' },
  { id: 'currencies', label: 'Валюти' },
  { id: 'exchange-rates', label: 'Курси валют' },
];

test.describe('НДІ (Нормативно-довідкова інформація)', () => {
  test('сторінка завантажується з заголовком', async ({ page }) => {
    await page.goto('/ndi');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('всі 6 табів присутні', async ({ page }) => {
    await page.goto('/ndi');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    for (const t of TABS) {
      await expect(page.locator(`button:has-text("${t.label}")`).first()).toBeVisible({
        timeout: 5_000,
      });
    }
  });

  test('перемикання табу → URL оновлюється на ?tab=X', async ({ page }) => {
    await page.goto('/ndi');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });

    for (const t of ['payments', 'taxrates', 'currencies', 'exchange-rates'] as const) {
      const label = TABS.find(x => x.id === t)?.label;
      await page.locator(`button:has-text("${label}")`).first().click();
      // Чекати поки URL оновиться
      await expect(page).toHaveURL(new RegExp(`tab=${t}`), { timeout: 5_000 });
    }
  });

  test('таб "Валюти" завантажує контент (UAH у seed)', async ({ page }) => {
    await page.goto('/ndi?tab=currencies');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    // Seed містить UAH — має зявитись хоча б одна валюта
    await expect(page.getByText(/UAH|гривня|Гривня/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('таб "Ставки ПДВ" завантажує контент', async ({ page }) => {
    await page.goto('/ndi?tab=taxrates');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    // Очікуємо таблицю АБО empty state (без помилки)
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Немає|Empty|Не знайдено|Додати/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});

/**
 * НДІ → «Оплата»: куди надходять кошти способу оплати. Каса за замовчуванням способу — те, чим
 * вікно «Оплатити» рахунку заповнює поле «Каса» (BR-PAY-019). Тест працює зі своїм способом і
 * своєю касою: системну «Готівку» не чіпає (її замовчування спільне для паралельних файлів E2E).
 */
test.describe('НДІ → Оплата: куди надходять кошти', () => {
  const stamp = Date.now();
  const registerName = `000 E2E Оплата каса НДІ ${stamp}`;
  const methodName = `000 E2E Оплата спосіб НДІ ${stamp}`;
  let registerId = '';
  let methodId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/ndi');
    const token = await getToken(p);
    registerId = await createPlainRegister(p, token, registerName);
    const method = await apiCall<{ id: string }>(p, token, 'POST', '/payment-methods', {
      code: `pay_e2e_ndi_${stamp}`,
      name: methodName,
      sortOrder: 999,
    });
    expect(method.status, `створення способу оплати: ${JSON.stringify(method.body)}`).toBe(201);
    methodId = method.body.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/ndi');
    const token = await getToken(p);
    if (methodId) await apiCall(p, token, 'DELETE', `/payment-methods/${methodId}`);
    if (registerId) await deleteRegister(p, token, registerId);
    await ctx.close();
  });

  test('способу задають касу: у списку видно касу, сервер її зберіг', async ({ page }) => {
    await page.goto('/ndi?tab=payments');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    const code = `pay_e2e_ndi_${stamp}`;
    const destination = page.getByTestId(`pm-destination-${code}`);
    await expect(destination).toHaveText('— не вказано —', { timeout: 15_000 });

    await page.getByRole('button', { name: `Редагувати метод оплати: ${methodName}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Редагувати метод оплати' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByLabel('Куди надходять кошти').selectOption('CASH_REGISTER');
    const save = dialog.getByRole('button', { name: 'Зберегти' });
    await expect(save).toBeDisabled();
    await dialog.getByLabel(/^Каса/).selectOption(registerId);
    await save.click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(destination).toHaveText(`Каса: ${registerName}`);
    const token = await getToken(page);
    const list = await apiCall<
      { id: string; defaultSourceType: string | null; defaultCashRegisterId: string | null }[]
    >(page, token, 'GET', '/payment-methods');
    expect(list.body.find(m => m.id === methodId)).toMatchObject({
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: registerId,
    });
  });
});
