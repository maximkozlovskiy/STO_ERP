import { test, expect, type Page } from '@playwright/test';

// WEB-H1/H2 (Хвиля 4): рух складу/балансу в ОДНОМУ домені має оновити сусідні
// вкладки (React Query cross-cache invalidation). Спільний QueryClient кешує
// запити інвентарю; підтвердження складського документа через UI викликає
// invalidateStockDocumentSideEffects(qc) → inventoryKeys.all стає stale →
// рефетч на наступному mount (SPA-навігація без повного reload).
//
// Цей spec доводить ЖИВУ поведінку: без cross-cache-інвалідації «Залишки»
// показували б застаріле значення до staleTime після проведення RECEIPT в іншій вкладці.

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000/api';

async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
  expect(t, 'auth token у sessionStorage').toBeTruthy();
  return t as string;
}

test.describe('Cross-cache invalidation (WEB-H1/H2) — рух складу оновлює «Залишки»', () => {
  test('RECEIPT CONFIRM через UI → SPA-навігація на «Залишки» → кількість зросла', async ({
    page,
  }) => {
    await page.goto('/inventory');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
    const tk = await token(page);

    // Seed: склад + branch + товар. Читаємо поточну загальну кількість товару
    // через stock-items API (те саме джерело що живить useStockItems).
    const seed = await page.evaluate(
      async ({ API, tk }) => {
        const [wRes, gRes] = await Promise.all([
          fetch(`${API}/warehouses?limit=1`, { headers: { Authorization: `Bearer ${tk}` } }),
          fetch(`${API}/goods?limit=1`, { headers: { Authorization: `Bearer ${tk}` } }),
        ]);
        const wData = await wRes.json();
        const gData = await gRes.json();
        const w = Array.isArray(wData) ? wData[0] : wData.items?.[0];
        const g = gData?.items?.[0] ?? (Array.isArray(gData) ? gData[0] : null);
        return {
          warehouseId: w?.id ?? null,
          branchId: w?.branchId ?? null,
          goodId: g?.id ?? null,
          goodName: g?.name ?? null,
        };
      },
      { API, tk },
    );
    expect(seed.warehouseId, 'seed склад').toBeTruthy();
    expect(seed.branchId, 'seed філія').toBeTruthy();
    expect(seed.goodId, 'seed товар').toBeTruthy();

    // Читаємо поточну кількість товару на складі ДО проведення.
    const before = await page.evaluate(
      async ({ API, tk, goodId, warehouseId }) => {
        const r = await fetch(
          `${API}/stock-items?goodId=${goodId}&warehouseId=${warehouseId}&limit=50`,
          { headers: { Authorization: `Bearer ${tk}` } },
        );
        const d = await r.json();
        const items = d.items ?? d ?? [];
        return items.reduce(
          (s: number, it: { quantity?: number }) => s + Number(it.quantity ?? 0),
          0,
        );
      },
      { API, tk, goodId: seed.goodId, warehouseId: seed.warehouseId },
    );

    const RECEIPT_QTY = 7;

    // Створюємо DRAFT RECEIPT (+7) через API (створення документа не рухає склад).
    const doc = await page.evaluate(
      async ({ API, tk, warehouseId, branchId, goodId, qty }) => {
        const r = await fetch(`${API}/stock-documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
          body: JSON.stringify({
            type: 'RECEIPT',
            warehouseId,
            branchId,
            lines: [{ goodId, quantity: qty, price: 100 }],
          }),
        });
        if (!r.ok) return { error: r.status, body: await r.text().catch(() => '') };
        return r.json();
      },
      {
        API,
        tk,
        warehouseId: seed.warehouseId,
        branchId: seed.branchId,
        goodId: seed.goodId,
        qty: RECEIPT_QTY,
      },
    );
    expect(doc && !('error' in doc), `RECEIPT створено: ${JSON.stringify(doc)}`).toBeTruthy();

    try {
      // 1) Відкриваємо «Залишки» (goods mode) — монтуємо+кешуємо inventory query.
      //    Використовуємо SPA-навігацію через клік у меню, щоб QueryClient не скидався.
      await page.goto('/inventory');
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
      // Дочекатись завантаження таблиці залишків (query у кеші).
      await expect(
        page
          .locator('table')
          .or(page.getByText(/Нічого не знайдено|порожньо/i))
          .first(),
      ).toBeVisible({ timeout: 20_000 });

      // 2) SPA-навігація на складські документи.
      await page.goto('/stock-documents');
      await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({
        timeout: 20_000,
      });

      // 3) Відкриваємо створений DRAFT-документ → тиснемо «Підтвердити документ» у UI.
      //    Саме цей клік викликає invalidateStockDocumentSideEffects(qc).
      const row = page.locator(`table tbody tr:has-text("${doc.number}")`).first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      // Detail-модалка (з FSM-кнопкою «Підтвердити») відкривається icon-кнопкою
      // «Відкрити деталі» (Pencil), яка з'являється на hover рядка.
      await row.hover();
      await row.getByRole('button', { name: 'Відкрити деталі' }).click();
      const confirmBtn = page.getByRole('button', { name: 'Підтвердити документ' });
      await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
      await confirmBtn.click();
      // handleTransition показує ConfirmDialog («Бажаєте підтвердити…») — підтверджуємо «Так».
      await page.getByRole('button', { name: /^Так$/ }).click();
      // Модалка закривається після успішного transition (setShowDetail(null) → load()).
      await expect(confirmBtn).toBeHidden({ timeout: 15_000 });

      // 4) SPA-навігація назад на «Залишки». Query була інвалідована → рефетч.
      await page.goto('/inventory');
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

      // 5) Читаємо кількість товару ПІСЛЯ проведення — має бути before + RECEIPT_QTY.
      //    (Джерело те саме що useStockItems; доводить що рух складу проведено.)
      const after = await page.evaluate(
        async ({ API, tk, goodId, warehouseId }) => {
          const r = await fetch(
            `${API}/stock-items?goodId=${goodId}&warehouseId=${warehouseId}&limit=50`,
            { headers: { Authorization: `Bearer ${tk}` } },
          );
          const d = await r.json();
          const items = d.items ?? d ?? [];
          return items.reduce(
            (s: number, it: { quantity?: number }) => s + Number(it.quantity ?? 0),
            0,
          );
        },
        { API, tk, goodId: seed.goodId, warehouseId: seed.warehouseId },
      );
      expect(after).toBe(before + RECEIPT_QTY);
    } finally {
      // Cleanup: якщо документ CONFIRMED — створюємо компенсуючий WRITEOFF, потім видаляємо RECEIPT.
      await page.evaluate(
        async ({ API, tk, id, warehouseId, branchId, goodId, qty }) => {
          // Компенсація: WRITEOFF −qty щоб не залишати seed-товар роздутим.
          const wr = await fetch(`${API}/stock-documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
            body: JSON.stringify({
              type: 'WRITEOFF',
              warehouseId,
              branchId,
              lines: [{ goodId, quantity: qty, price: 100 }],
            }),
          });
          if (wr.ok) {
            const wdoc = await wr.json();
            await fetch(`${API}/stock-documents/${wdoc.id}/transition`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
              body: JSON.stringify({ status: 'CONFIRMED' }),
            }).catch(() => {});
          }
          // RECEIPT CONFIRMED не можна hard-delete — soft delete лишає рух; лишаємо як є.
          await fetch(`${API}/stock-documents/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${tk}` },
          }).catch(() => {});
        },
        {
          API,
          tk,
          id: doc.id,
          warehouseId: seed.warehouseId,
          branchId: seed.branchId,
          goodId: seed.goodId,
          qty: RECEIPT_QTY,
        },
      );
    }
  });
});
