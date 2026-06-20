import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Bug #571: knock-out fake-green skip коли E2E запускається у Sat/Fri вечір.
 * Повертає ISO timestamp наступного робочого дня (Mon-Fri у Києві) о 07:00Z = 10:00 Kyiv (EEST UTC+3) —
 * у межах робочих годин 09:00-18:00 на /booking/request. Обчислюється у Node перед `page.evaluate()`,
 * тому helper не дублюється в IIFE всередині кожного `page.evaluate`.
 */
function nextWorkingDayIso(): string {
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const isoWd = ((d.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
    if (isoWd >= 1 && isoWd <= 5) return d.toISOString().split('T')[0] + 'T07:00:00Z';
  }
  return new Date(Date.now() + 86400000).toISOString().split('T')[0] + 'T07:00:00Z';
}

test.describe('Онлайн-запис (Bookings)', () => {
  // Cleanup старих E2E заявок перед тестами щоб не накопичувалось 40+ рядків
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/bookings');
    await page.waitForTimeout(1000);
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
    await page.evaluate(async tok => {
      const r = await fetch('http://localhost:3000/api/booking', {
        headers: { Authorization: `Bearer ${tok}` },
      });
      const data = await r.json().catch(() => ({ items: [] }));
      const items = Array.isArray(data) ? data : (data.items ?? []);
      // Видалити всі E2E тестові заявки (clientName містить 'E2E')
      await Promise.all(
        items
          .filter((i: { clientName: string }) => i.clientName?.includes('E2E'))
          .map((i: { id: string }) =>
            fetch(`http://localhost:3000/api/booking/${i.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${tok}` },
            }).catch(() => {}),
          ),
      );
    }, token);
    await ctx.close();
  });

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

    // Bug #287/#571 follow-up: ніколи не skip — seed містить публічну філію.
    // Якщо відсутня — це регресія сидінгу, тест має падати голосно.
    expect(data.branchId, 'Seed не створив публічну філію /api/booking/branches').toBeTruthy();

    // Унікальний phone для кожного тест-запуску (останні 6 цифр = timestamp)
    const uniquePhone = `+38099${Date.now().toString().slice(-7)}`;
    const bookingRes = await page.evaluate(
      async ({ branchId, phone, requestedDate }) => {
        const r = await fetch('http://localhost:3000/api/booking/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            branchId,
            clientName: 'E2E Тест',
            clientPhone: phone,
            requestedDate,
          }),
        });
        if (!r.ok) return { error: r.status, body: await r.text().catch(() => '') };
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { branchId: data.branchId, phone: uniquePhone, requestedDate: nextWorkingDayIso() },
    );

    // Якщо API повернув помилку — це баг, не silent skip.
    expect(
      bookingRes && !('error' in bookingRes),
      `POST /api/booking/request має створити заявку, отримано: ${JSON.stringify(bookingRes)}`,
    ).toBeTruthy();

    await page.reload();
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });

    // Рядок заявки: div.flex.items-center.justify-between (структура з bookings/page.tsx)
    // Унікальний phone гарантує що знайдемо саме нашу заявку
    const row = page
      .locator('div.flex.items-center.justify-between')
      .filter({ hasText: uniquePhone })
      .filter({ has: page.locator('button:has-text("Підтвердити")') })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const confirmBtn = row.locator('button:has-text("Підтвердити")').first();
    await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
    await confirmBtn.scrollIntoViewIfNeeded();
    await confirmBtn.click();
    await expect(row.locator('button:has-text("Підтвердити")')).not.toBeVisible({
      timeout: 10_000,
    });

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
    expect(branchId, 'Seed не створив публічну філію /api/booking/branches').toBeTruthy();

    const cancelPhone = `+38099${(Date.now() + 1).toString().slice(-7)}`;
    const bookingRes = await page.evaluate(
      async ({ branchId, phone, requestedDate }) => {
        const r = await fetch('http://localhost:3000/api/booking/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            branchId,
            clientName: 'E2E Cancel',
            clientPhone: phone,
            requestedDate,
          }),
        });
        if (!r.ok) return { error: r.status, body: await r.text().catch(() => '') };
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { branchId, phone: cancelPhone, requestedDate: nextWorkingDayIso() },
    );

    expect(
      bookingRes && !('error' in bookingRes),
      `POST /api/booking/request має створити заявку, отримано: ${JSON.stringify(bookingRes)}`,
    ).toBeTruthy();

    await page.reload();
    await expect(page.locator('h1:has-text("Онлайн-запис"), h1:has-text("Заявки")')).toBeVisible({
      timeout: 20_000,
    });

    // Створили через API — рядок ОБОВ'ЯЗКОВО має з'явитись (без strict expect → fake-green, Bug #287).
    const row = page
      .locator('div.flex.items-center.justify-between')
      .filter({ hasText: cancelPhone })
      .filter({ has: page.locator('button:has-text("Скасувати")') })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const cancelBtn = row.locator('button:has-text("Скасувати")').first();
    await cancelBtn.scrollIntoViewIfNeeded();
    await cancelBtn.click();
    await expect(row.locator('button:has-text("Скасувати")')).not.toBeVisible({ timeout: 8_000 });

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
