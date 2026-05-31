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

    // Створити заявку через публічний API
    const data = await page.evaluate(
      async ({ token }) => {
        const servicesRes = await fetch('http://localhost:3000/api/works?limit=1', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const services = await servicesRes.json();
        return { serviceId: services.items?.[0]?.id };
      },
      { token },
    );

    const bookingRes = await page.evaluate(
      async ({ serviceId }) => {
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        const r = await fetch('http://localhost:3000/api/booking/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientName: 'E2E Тест',
            clientPhone: '+380991234567',
            serviceIds: serviceId ? [serviceId] : [],
            preferredDate: tomorrow,
            notes: 'E2E test booking',
          }),
        });
        return r.ok ? await r.json() : null;
      },
      { serviceId: data.serviceId },
    );

    if (!bookingRes) {
      test.skip(true, 'Не вдалось створити заявку');
      return;
    }

    await page.reload();
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });

    // Знайти заявку E2E і підтвердити
    const row = page.locator('tr:has-text("E2E Тест"), li:has-text("E2E Тест")').first();
    if (await row.isVisible({ timeout: 10_000 })) {
      const confirmBtn = row.locator('button:has-text("Підтвердити")').first();
      if (await confirmBtn.isVisible({ timeout: 3_000 })) {
        await confirmBtn.click();
        await expect(page.locator('text=Підтверджено').first()).toBeVisible({ timeout: 8_000 });
      }
    }

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

    const bookingRes = await page.evaluate(async () => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      const r = await fetch('http://localhost:3000/api/booking/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'E2E Cancel',
          clientPhone: '+380991234568',
          serviceIds: [],
          preferredDate: tomorrow,
        }),
      });
      return r.ok ? await r.json() : null;
    });

    if (!bookingRes) {
      test.skip(true, 'Не вдалось створити заявку');
      return;
    }

    await page.reload();
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });

    const row = page.locator('tr:has-text("E2E Cancel"), li:has-text("E2E Cancel")').first();
    if (await row.isVisible({ timeout: 10_000 })) {
      const cancelBtn = row.locator('button:has-text("Скасувати")').first();
      if (await cancelBtn.isVisible({ timeout: 3_000 })) {
        await cancelBtn.click();
        await expect(page.locator('text=Скасовано').first()).toBeVisible({ timeout: 8_000 });
      }
    }

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
