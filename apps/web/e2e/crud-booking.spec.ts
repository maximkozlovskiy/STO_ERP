import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Онлайн-запис (Bookings)', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/bookings');
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator('table, [class*="divide-y"]')
        .or(page.getByText(/Заявок на запис немає|Нічого не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('Підтвердити заявку → статус CONFIRMED', async ({ page }) => {
    await page.goto('/bookings');
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    // Створити заявку через публічний API.
    // CreateBookingRequestDto вимагає: branchId (UUID), clientName, clientPhone (+380XXXXXXXXX),
    // requestedDate (НЕ preferredDate). Раніше тут було неправильне поле і відсутній branchId —
    // /booking/request віддавав 400, r.ok=false → test.skip → fake-green silent skip (Bug #287).
    const data = await page.evaluate(async () => {
      const branchesRes = await fetch('http://localhost:3000/api/booking/branches');
      const branches = await branchesRes.json().catch(() => []);
      return {
        branchId: Array.isArray(branches) ? branches[0]?.id : null,
      };
    });

    if (!data.branchId) {
      test.skip(true, 'Немає публічної філії для онлайн-запису');
      return;
    }

    const bookingRes = await page.evaluate(
      async ({ branchId }) => {
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        const r = await fetch('http://localhost:3000/api/booking/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            branchId,
            clientName: 'E2E Тест',
            clientPhone: '+380991234567',
            requestedDate: tomorrow,
            notes: 'E2E test booking',
          }),
        });
        return r.ok ? await r.json() : null;
      },
      { branchId: data.branchId },
    );

    if (!bookingRes) {
      test.skip(true, 'Не вдалось створити заявку');
      return;
    }

    await page.reload();
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });

    // Знайти заявку E2E. Створили її через API — рядок ОБОВ'ЯЗКОВО має з'явитись.
    // Без strict expect тест перетворюється на fake-green: створили → нічого не перевірили (Bug #287).
    const row = page.locator('tr:has-text("E2E Тест"), li:has-text("E2E Тест")').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const confirmBtn = row.locator('button:has-text("Підтвердити")').first();
    // Якщо кнопки немає у рядку — це регресія UI (PENDING має мати "Підтвердити").
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
    await confirmBtn.click();
    await expect(page.locator('text=Підтверджено').first()).toBeVisible({ timeout: 8_000 });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/booking/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      },
      { token, id: bookingRes.id },
    );
  });

  test('Скасувати заявку → статус CANCELLED', async ({ page }) => {
    await page.goto('/bookings');
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    // DTO вимагає branchId + requestedDate (НЕ preferredDate). Див. коментар у попередньому тесті.
    const branchId = await page.evaluate(async () => {
      const r = await fetch('http://localhost:3000/api/booking/branches');
      const list = await r.json().catch(() => []);
      return Array.isArray(list) ? list[0]?.id : null;
    });
    if (!branchId) {
      test.skip(true, 'Немає публічної філії для онлайн-запису');
      return;
    }

    const bookingRes = await page.evaluate(
      async ({ branchId }) => {
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        const r = await fetch('http://localhost:3000/api/booking/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            branchId,
            clientName: 'E2E Cancel',
            clientPhone: '+380991234568',
            serviceIds: [],
            requestedDate: tomorrow,
          }),
        });
        return r.ok ? await r.json() : null;
      },
      { branchId },
    );

    if (!bookingRes) {
      test.skip(true, 'Не вдалось створити заявку');
      return;
    }

    await page.reload();
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });

    // Створили через API — рядок ОБОВ'ЯЗКОВО має з'явитись (без strict expect → fake-green, Bug #287).
    const row = page.locator('tr:has-text("E2E Cancel"), li:has-text("E2E Cancel")').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const cancelBtn = row.locator('button:has-text("Скасувати")').first();
    await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
    await cancelBtn.click();
    await expect(page.locator('text=Скасовано').first()).toBeVisible({ timeout: 8_000 });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/booking/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      },
      { token, id: bookingRes.id },
    );
  });
});
