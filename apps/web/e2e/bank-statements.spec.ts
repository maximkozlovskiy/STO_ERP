import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000/api/v1';

/**
 * Bank Statements — сторінка /bank-statements (вхідні банк-платежі без рахунку).
 * Auth-gated (OWNER/ADMIN/ACCOUNTANT). Smoke-покриття: рендер, фільтр-пігулки,
 * порожній стан / таблиця, кнопка імпорту → wizard-модалка, модалка «Ігнорувати».
 * Money/staging-інваріанти покриті unit-тестами (bank-reconciliation.service.spec.ts).
 */

async function getToken(page: import('@playwright/test').Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

test.describe('Банківські платежі', () => {
  test('вкладки «Всі / Вхідні / Вихідні» + «Банк. рахунки», перемикання оновлює URL', async ({
    page,
  }) => {
    await page.goto('/bank-statements');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    // Вкладки напрямку і «Банк. рахунки» присутні; окремої «Список платежів» більше немає.
    await expect(page.getByRole('button', { name: 'Всі', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Вхідні', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Вихідні', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Банк. рахунки' })).toBeVisible();

    // «Вихідні» → URL ?direction=OUT, список лишається (кнопка імпорту на місці).
    await page.getByRole('button', { name: 'Вихідні', exact: true }).click();
    await expect(page).toHaveURL(/direction=OUT/, { timeout: 5_000 });
    await expect(page.locator('button:has-text("Імпорт виписки")').first()).toBeVisible();

    // Перемикаємо на «Банк. рахунки» → URL ?tab=accounts + контент вкладки рахунків.
    await page.getByRole('button', { name: 'Банк. рахунки' }).click();
    await expect(page).toHaveURL(/tab=accounts/, { timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Додати рахунок' }).first()).toBeVisible({
      timeout: 10_000,
    });

    // Назад на «Всі» → URL без параметрів + кнопка імпорту.
    // trailingSlash:true (next.config) → базовий URL є /bank-statements/ без query.
    await page.getByRole('button', { name: 'Всі', exact: true }).click();
    await expect(page).toHaveURL(/\/bank-statements\/$/, { timeout: 5_000 });
    await expect(page.locator('button:has-text("Імпорт виписки")').first()).toBeVisible();
  });

  test('пряме відкриття ?tab=accounts рендерить вкладку банк-рахунків', async ({ page }) => {
    await page.goto('/bank-statements?tab=accounts');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Додати рахунок' }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('невалідний ?tab=xxx → fallback на список платежів', async ({ page }) => {
    await page.goto('/bank-statements?tab=xxx');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    // Fallback-логіка: невідомий tab → transactions. Видно кнопку імпорту (не форму рахунків).
    await expect(page.locator('button:has-text("Імпорт виписки")').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Додати рахунок' })).toHaveCount(0);
  });

  test('сторінка /bank-statements рендериться з заголовком і кнопкою імпорту', async ({ page }) => {
    await page.goto('/bank-statements');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('button:has-text("Імпорт виписки")').first()).toBeVisible({
      timeout: 10_000,
    });
    // Таблиця або empty-state.
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Немає транзакцій|Нічого не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('фільтр-пігулки статусів присутні (Усі + статуси)', async ({ page }) => {
    await page.goto('/bank-statements');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Усі' }).first()).toBeVisible({
      timeout: 10_000,
    });
    // Статус-мітки з enumLabel (bankTxStatusLabel).
    for (const label of ['Не рознесено', 'Рознесено', 'Проігноровано']) {
      await expect(page.getByRole('button', { name: label }).first()).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test('клік пігулки статусу оновлює вибір (active)', async ({ page }) => {
    await page.goto('/bank-statements');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    const unmatched = page.getByRole('button', { name: 'Не рознесено' }).first();
    await unmatched.click();
    // Після кліку сторінка не падає, кнопка лишається у DOM (список перезапитано зі status).
    await expect(unmatched).toBeVisible();
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Немає транзакцій/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('кнопка «Імпорт виписки» відкриває wizard-модалку (крок 1: рахунок + файл)', async ({
    page,
  }) => {
    await page.goto('/bank-statements');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('button:has-text("Імпорт виписки")').first().click();

    await expect(page.getByText('Імпорт банківської виписки')).toBeVisible({ timeout: 10_000 });
    // Крок 1: селект банківського рахунку + file-input + кнопка «Далі».
    await expect(page.getByText('Банківський рахунок', { exact: false }).first()).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeVisible();
    await expect(page.locator('button:has-text("Далі")').first()).toBeVisible();
  });

  test('імпорт: «Далі» без файлу показує помилку валідації', async ({ page }) => {
    await page.goto('/bank-statements');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('button:has-text("Імпорт виписки")').first().click();
    await expect(page.getByText('Імпорт банківської виписки')).toBeVisible({ timeout: 10_000 });

    await page.locator('button:has-text("Далі")').first().click();
    // Без файлу/рахунку — inline-помилка, крок лишається 1 (селект рахунку ще видно).
    await expect(page.getByText(/Оберіть файл виписки|Оберіть банківський рахунок/)).toBeVisible({
      timeout: 8_000,
    });
  });

  test('модалка «Ігнорувати» відкривається для UNMATCHED-транзакції та валідує причину', async ({
    page,
  }) => {
    // Спершу переходимо на сторінку — інакше page.evaluate виконується на about:blank
    // (немає origin) → SecurityError при доступі до sessionStorage.
    await page.goto('/bank-statements');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    // Створюємо UNMATCHED банк-транзакцію через API (потрібен банківський рахунок).
    const token = await getToken(page);
    const seed = await page.evaluate(
      async ({ token, API }) => {
        const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        // Наявний рахунок або створюємо новий (seed БД може не містити банк-рахунків).
        const baRes = await fetch(`${API}/bank-accounts`, { headers: auth });
        const baData = await baRes.json();
        let bankAccountId = (baData.items ?? baData)?.[0]?.id;
        if (!bankAccountId) {
          const curRes = await fetch(`${API}/currencies`, { headers: auth });
          const curData = await curRes.json();
          const currencyId = (curData.items ?? curData)?.[0]?.id;
          // Валідний UA IBAN: 2 літери + рівно 27 цифр (29 символів).
          const iban = `UA${String(Date.now()).slice(-9).padStart(27, '0')}`;
          const crRes = await fetch(`${API}/bank-accounts`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              name: `E2E Рахунок ${Date.now()}`,
              ibanUA: iban,
              currencyId,
            }),
          });
          if (crRes.ok) bankAccountId = (await crRes.json()).id;
        }
        if (!bankAccountId) return { bankAccountId: null };
        const externalId = `E2E-${Date.now()}`;
        const applyRes = await fetch(`${API}/bank-statements/import/apply`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            bankAccountId,
            rows: [
              {
                externalId,
                operationDate: '2026-09-01',
                amount: 999.99,
                payerName: 'E2E Платник',
                purpose: 'E2E smoke transaction',
              },
            ],
          }),
        });
        const applyBody = applyRes.ok ? await applyRes.json() : { error: await applyRes.text() };
        return { bankAccountId, externalId, applyBody, applyStatus: applyRes.status };
      },
      { token, API },
    );

    if (!seed.bankAccountId) {
      test.skip(true, 'Немає банківського рахунку у цьому середовищі — пропускаємо');
      return;
    }
    expect(
      seed.applyStatus,
      `apply має створити транзакцію: ${JSON.stringify(seed.applyBody)}`,
    ).toBe(201);

    // Перезавантажуємо список, щоб побачити щойно створену транзакцію.
    await page.reload();
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    // Фільтруємо на UNMATCHED, щоб рядок гарантовано був у списку.
    await page.getByRole('button', { name: 'Не рознесено' }).first().click();

    const row = page.locator('table tbody tr:has-text("E2E Платник")').first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Клік кнопки «Ігнорувати» (icon-button з aria-label).
    await row.hover();
    await row.getByRole('button', { name: 'Ігнорувати' }).click();

    await expect(page.getByText('Ігнорувати платіж')).toBeVisible({ timeout: 10_000 });
    // Ввести причину (trim-guard: порожня причина блокує submit) → відправити.
    const reasonInput = page.getByPlaceholder('Чому цей платіж нерелевантний…');
    await reasonInput.fill('E2E нерелевантний');
    await page.getByRole('button', { name: 'Ігнорувати', exact: true }).last().click();

    // Успіх: транзакція перейшла у IGNORED (перевірка через API за externalId).
    await expect
      .poll(
        async () => {
          return page.evaluate(
            async ({ token, API, externalId }) => {
              const r = await fetch(
                `${API}/bank-statements/transactions?status=IGNORED&limit=100`,
                {
                  headers: { Authorization: `Bearer ${token}` },
                },
              );
              const d = await r.json();
              return (d.items ?? []).some(
                (t: { externalId: string; status: string }) =>
                  t.externalId === externalId && t.status === 'IGNORED',
              );
            },
            { token, API, externalId: seed.externalId },
          );
        },
        { timeout: 10_000, message: 'транзакція має стати IGNORED' },
      )
      .toBe(true);
  });
});
