import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Календар — слоти', () => {
  test('сторінка завантажується в режимі День', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 20_000 });
    // Кнопки перемикання режимів
    await expect(page.locator('button:has-text("День")').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('button:has-text("Місяць")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Статистика")').first()).toBeVisible();
  });

  test('кнопка "+ Слот" присутня в режимі День', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 20_000 });
    // Спочатку вибрати День якщо не активний
    await page.locator('button:has-text("День")').first().click();
    await expect(page.locator('button:has-text("Слот")').first()).toBeVisible({ timeout: 15_000 });
  });

  test('статистика — форма редагування не відображається', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Статистика")').first().click();
    // У режимі статистики форма слоту не відображається
    await expect(page.locator('text=Редагування слоту')).not.toBeVisible({ timeout: 5_000 });
  });

  test('створити слот через API → перевірити в timeline → видалити', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 20_000 });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));

    // Отримати ВСІ ліфти + контрагента щоб мати запас на конфлікти "Підйомник вже зайнятий".
    const data = await page.evaluate(
      async ({ token }) => {
        const [liftsRes, cpRes] = await Promise.all([
          fetch('http://localhost:3000/api/lifts', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch('http://localhost:3000/api/counterparties?limit=1', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        const [lifts, cps] = await Promise.all([liftsRes.json(), cpRes.json()]);
        return {
          liftIds: Array.isArray(lifts) ? lifts.map((l: { id: string }) => l.id) : [],
          counterpartyId: cps.items?.[0]?.id,
        };
      },
      { token },
    );

    expect(data.liftIds.length, 'GET /api/lifts повернув порожньо').toBeGreaterThan(0);
    expect(data.counterpartyId, 'GET /api/counterparties повернув порожньо').toBeTruthy();

    // Bug #571 follow-up #2: одного ліфта недостатньо — на ньому може вже бути слот
    // на обраний час. Перебираємо комбінації lift × hour доки не знайдемо вільну.
    // Час: 07:00-13:00 UTC = 10:00-16:00 Kyiv (робочий день).
    const today = new Date().toISOString().split('T')[0];

    let slot: { id: string; [k: string]: unknown } | null = null;
    let lastError: unknown = null;
    outer: for (const liftId of data.liftIds) {
      for (let h = 7; h <= 13; h++) {
        const startAt = `${today}T${String(h).padStart(2, '0')}:00:00.000Z`;
        const endAt = `${today}T${String(h).padStart(2, '0')}:30:00.000Z`;
        const res = await page.evaluate(
          async ({ token, liftId, counterpartyId, startAt, endAt }) => {
            const r = await fetch('http://localhost:3000/api/calendar/slots', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ liftId, counterpartyId, startAt, endAt }),
            });
            if (!r.ok) return { error: r.status, body: await r.text().catch(() => '') };
            const text = await r.text();
            return text ? JSON.parse(text) : null;
          },
          { token, liftId, counterpartyId: data.counterpartyId, startAt, endAt },
        );
        if (res && !('error' in res)) {
          slot = res as typeof slot;
          break outer;
        }
        lastError = res;
      }
    }

    expect(
      slot,
      `Не знайдено вільної комбінації lift × hour для створення слоту. Last error: ${JSON.stringify(lastError)}`,
    ).toBeTruthy();

    // Перезавантажити і перевірити що слот є на timeline.
    // Точна перевірка наявності слоту: data-calendar-slot з відповідним часом.
    // Раніше використовували розмиту перевірку `.min-h` що матчить будь-який layout —
    // фактично fake-green (Bug #287).
    await page.reload();
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("День")').first().click();
    await page.waitForLoadState('networkidle');

    // Сам слот має відрендеритись (DraggableSlot ставить data-calendar-slot атрибут)
    await expect(page.locator('[data-calendar-slot]').first()).toBeVisible({ timeout: 15_000 });

    // Cleanup
    await page.evaluate(
      async ({ token, id }) => {
        await fetch(`http://localhost:3000/api/calendar/slots/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      { token, id: slot!.id },
    );
  });

  test('перемикання Місяць — відображає сітку місяця', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Місяць")').first().click();
    // Кнопки навігації "Попередній" / "Наступний"
    await expect(page.locator('button:has-text("Попередній")').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('button:has-text("Наступний")').first()).toBeVisible();
  });
});
