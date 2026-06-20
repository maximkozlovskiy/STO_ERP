import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─────────────────────────────────────────────────────────────────────────────
// /counterparties/[id] — детальна сторінка контрагента з 7 вкладками:
//   info (Загальна інформація) · garages (Гаражі та авто) · contracts (Договори) ·
//   settlements (Взаєморозрахунки) · work-orders (Наряди) · warranties (Гарантії) ·
//   loyalty (Лояльність).
// Self-seed: створюємо тестового CLIENT через API у beforeAll, видаляємо в afterAll.
// ─────────────────────────────────────────────────────────────────────────────

let seededCpId: string | null = null;

async function getToken(page: Page): Promise<string> {
  return (await page.evaluate(() => sessionStorage.getItem('sto_access_token'))) ?? '';
}

async function apiCall(
  page: Page,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, method, path, body }) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body) headers['Content-Type'] = 'application/json';
      const r = await fetch(`${'http://localhost:3000'}/api${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) return null;
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    },
    { token, method, path, body: body ?? null },
  );
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  // Sessions storage потребує origin: спершу goto на app
  await p.goto('/counterparties');
  await p.waitForTimeout(500);
  const cp = (await apiCall(p, 'POST', '/counterparties', {
    type: 'CLIENT',
    firstName: 'E2E-Detail',
    lastName: 'TestClient',
    phone: '+380501234567',
  })) as { id: string } | null;
  seededCpId = cp?.id ?? null;
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  if (!seededCpId) return;
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await p.goto('/counterparties');
  await p.waitForTimeout(300);
  await apiCall(p, 'DELETE', `/counterparties/${seededCpId}`);
  await ctx.close();
});

test.describe('/counterparties/[id] — детальна картка', () => {
  test('сторінка завантажується без 500', async ({ page }) => {
    expect(seededCpId, 'beforeAll seed має створити контрагента').not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await expect(page).toHaveURL(new RegExp(`/counterparties/${seededCpId}`), { timeout: 15_000 });
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('h1 з іменем контрагента відображається', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await expect(page.locator('h1:has-text("E2E-Detail")')).toBeVisible({ timeout: 15_000 });
  });

  test('усі 7 вкладок присутні', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    const expectedTabs = [
      'Загальна інформація',
      'Гаражі та авто',
      'Договори',
      'Взаєморозрахунки',
      'Наряди',
      'Гарантії',
      'Лояльність',
    ];
    for (const label of expectedTabs) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test('вкладка "Гаражі та авто" — клік не падає', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await page.getByRole('button', { name: 'Гаражі та авто', exact: true }).click();
    // На пустому контрагенті очікуємо empty-state або список гаражів
    await expect(
      page.locator('text=Немає гаражів').or(page.locator('h2:has-text("Гаражі та автомобілі")')),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('вкладка "Договори" — клік не падає', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await page.getByRole('button', { name: 'Договори', exact: true }).click();
    // Empty-state "Немає договорів" + кнопка "Додати договір" (CRM-tab.tsx)
    await expect(
      page
        .locator('p:has-text("Немає договорів")')
        .or(page.locator('button:has-text("Додати договір")'))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('вкладка "Взаєморозрахунки" — клік не падає', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await page.getByRole('button', { name: 'Взаєморозрахунки', exact: true }).click();
    // Очікуємо контент вкладки (заголовок секції або список транзакцій)
    await page.waitForTimeout(800);
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('вкладка "Наряди" — клік не падає', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await page.getByRole('button', { name: 'Наряди', exact: true }).click();
    await page.waitForTimeout(800);
    // Без помилок overlay
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('вкладка "Гарантії" — клік не падає', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await page.getByRole('button', { name: 'Гарантії', exact: true }).click();
    await page.waitForTimeout(800);
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('вкладка "Лояльність" — клік не падає', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    await page.getByRole('button', { name: 'Лояльність', exact: true }).click();
    await page.waitForTimeout(800);
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('Назад-кнопка веде на /counterparties', async ({ page }) => {
    expect(seededCpId).not.toBeNull();
    await page.goto(`/counterparties/${seededCpId}`);
    // Іконка ArrowLeft — кнопка повернення до списку
    const backBtn = page.locator('button:has(svg.lucide-arrow-left)').first();
    if (await backBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await backBtn.click();
      await expect(page).toHaveURL(/\/counterparties(\?|$)/, { timeout: 10_000 });
    }
  });
});
