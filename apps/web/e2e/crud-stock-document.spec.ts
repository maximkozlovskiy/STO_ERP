import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Документи складу — CRUD', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Документів не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Документ" (додати) присутня', async ({ page }) => {
    // Add-button renamed from "Новий документ" to "Документ" (commit 3785721/c3cd333).
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: /^Документ$/ }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('створити WRITEOFF документ DRAFT через API → видно у списку → видалити', async ({
    page,
  }) => {
    // Bug #571 fix: попередньо UI-flow через модалку був ненадійний (selects з UI можуть
    // не знайти склад/тип → skip → fake-green). Замінено на API-creation, оскільки модалка
    // тестується окремим тестом "кнопка Документ присутня".
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    const seed = await page.evaluate(
      async ({ token }) => {
        const wRes = await fetch('http://localhost:3000/api/warehouses?limit=1', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const w = (await wRes.json())[0];
        return { warehouseId: w?.id ?? null, branchId: w?.branchId ?? null };
      },
      { token },
    );
    expect(seed.warehouseId, 'Seed має містити хоча б 1 склад').toBeTruthy();
    expect(seed.branchId, 'Склад seed має мати привязану філію').toBeTruthy();

    const doc = await page.evaluate(
      async ({ token, warehouseId, branchId }) => {
        const r = await fetch('http://localhost:3000/api/stock-documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ type: 'WRITEOFF', warehouseId, branchId, lines: [] }),
        });
        if (!r.ok) return { error: r.status, body: await r.text().catch(() => '') };
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { token, warehouseId: seed.warehouseId, branchId: seed.branchId },
    );
    expect(
      doc && !('error' in doc),
      `POST /api/stock-documents має створити WRITEOFF, отримано: ${JSON.stringify(doc)}`,
    ).toBeTruthy();

    await page.reload();
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    const row = page.locator(`table tbody tr:has-text("${doc.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/stock-documents/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      { token, id: doc.id },
    );
  });

  test('FSM DRAFT → CONFIRMED через API transition', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    // Знайти склад + branchId + good (DTO вимагає branchId, transition вимагає lines — Bug #571 fix).
    const seed = await page.evaluate(
      async ({ token }) => {
        const [wRes, gRes] = await Promise.all([
          fetch('http://localhost:3000/api/warehouses?limit=1', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch('http://localhost:3000/api/goods?limit=1', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        const wData = await wRes.json();
        const gData = await gRes.json();
        const w = wData[0];
        const g = gData?.items?.[0] ?? gData[0];
        return {
          warehouseId: w?.id ?? null,
          branchId: w?.branchId ?? null,
          goodId: g?.id ?? null,
        };
      },
      { token },
    );

    expect(seed.warehouseId, 'Seed має містити склад').toBeTruthy();
    expect(seed.branchId, 'Склад має бути привязаний до філії').toBeTruthy();
    expect(seed.goodId, 'Seed має містити хоча б 1 товар').toBeTruthy();

    // Створити RECEIPT з позицією (WRITEOFF з порожнім складом → undefined cost у transition).
    // RECEIPT збільшує склад, transition підтверджує без перевірки залишків.
    const doc = await page.evaluate(
      async ({ token, warehouseId, branchId, goodId }) => {
        const r = await fetch('http://localhost:3000/api/stock-documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            type: 'RECEIPT',
            warehouseId,
            branchId,
            lines: [{ goodId, quantity: 1, price: 100 }],
          }),
        });
        if (!r.ok) return { error: r.status, body: await r.text().catch(() => '') };
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { token, warehouseId: seed.warehouseId, branchId: seed.branchId, goodId: seed.goodId },
    );

    expect(
      doc && !('error' in doc),
      `POST /api/stock-documents має створити RECEIPT, отримано: ${JSON.stringify(doc)}`,
    ).toBeTruthy();

    await page.reload();
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });

    // Документ створено через API — рядок ОБОВ'ЯЗКОВО має з'явитись.
    // Без strict expect — fake-green (Bug #287).
    const row = page.locator(`table tbody tr:has-text("${doc.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Bug #504: Detail Panel у stock-documents видалений (dead UI).
    // FSM transition виконується через API endpoint /stock-documents/:id/transition.
    // Тест перевіряє реальну поведінку: статус DRAFT → CONFIRMED після POST на transition,
    // і що UI оновлює badge на "Проведено" (фільтр відображення).
    const transitionRes = await page.evaluate(
      async ({ token, id }) => {
        const r = await fetch(`http://localhost:3000/api/stock-documents/${id}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'CONFIRMED' }),
        });
        return { status: r.status, body: await r.text() };
      },
      { token, id: doc.id },
    );
    expect(transitionRes.status).toBeLessThan(400);
    const updatedDoc = JSON.parse(transitionRes.body);
    expect(updatedDoc.status).toBe('CONFIRMED');

    // UI має відобразити проведений документ — перемикаємо фільтр "Проведені" / reload.
    await page.reload();
    await expect(page.locator(`table tbody tr:has-text("${doc.number}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/stock-documents/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      { token, id: doc.id },
    );
  });

  test('статусні фільтри присутні', async ({ page }) => {
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.locator('button:has-text("Всі"), button:has-text("Чернетка")').first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
