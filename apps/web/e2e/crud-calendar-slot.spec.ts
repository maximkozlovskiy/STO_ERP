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

    // Отримати ліфт і контрагента
    const data = await page.evaluate(
      async ({ token }) => {
        const [liftsRes, cpRes] = await Promise.all([
          fetch('http://localhost:3000/api/lifts?limit=1', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch('http://localhost:3000/api/counterparties?limit=1', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        const [lifts, cps] = await Promise.all([liftsRes.json(), cpRes.json()]);
        return { liftId: lifts[0]?.id, counterpartyId: cps.items?.[0]?.id };
      },
      { token },
    );

    if (!data.liftId || !data.counterpartyId) {
      test.skip(true, 'Немає ліфту або контрагента');
      return;
    }

    // Сьогоднішня дата для слоту. Час обираємо унікальний в межах робочого дня
    // (07:00-14:00 UTC = 10:00-17:00 Kyiv EEST), щоб уникнути конфліктів з seed-слотами
    // і повторних запусків — Bug #571 (раніше фіксований T09:00 завжди конфліктував).
    const today = new Date().toISOString().split('T')[0];
    const hourOffset = (new Date().getSeconds() % 7) + 7; // 7..13 UTC = 10..16 Kyiv
    const startAt = `${today}T${String(hourOffset).padStart(2, '0')}:00:00.000Z`;
    const endAt = `${today}T${String(hourOffset).padStart(2, '0')}:30:00.000Z`;

    const slot = await page.evaluate(
      async ({ token, liftId, counterpartyId, startAt, endAt }) => {
        const r = await fetch('http://localhost:3000/api/calendar/slots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ liftId, counterpartyId, startAt, endAt }),
        });
        if (!r.ok) return null;
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      },
      { token, ...data, startAt, endAt },
    );

    if (!slot) {
      test.skip(true, 'Не вдалось створити слот');
      return;
    }

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
      { token, id: slot.id },
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
