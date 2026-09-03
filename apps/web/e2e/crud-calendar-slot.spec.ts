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
    // Bug #573: раніше `today` брався як UTC date (new Date().toISOString().split('T')[0])
    // і слот створювався на UTC-день, а календар за замовчуванням відкриває Kyiv-день
    // (Intl з timeZone: 'Europe/Kyiv'). Після півночі UTC (03:00 Kyiv) дати розходяться —
    // слот на 2026-08-29T07:00Z (Kyiv 10:00 29-го) не з'являється на view 30-го.
    // Fix: беремо Kyiv-дату (як frontend) і будуємо UTC ISO так, щоб слот
    // попадав на 10:00-16:00 Kyiv саме на цю Kyiv-дату (DST-safe через Intl).
    const kyivToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(
      new Date(),
    );

    /**
     * Convert Kyiv wall-clock (date + hour) → UTC ISO string.
     * Handles DST correctly: computes the actual offset for that specific moment.
     */
    function kyivWallToUtcIso(kyivDate: string, kyivHour: number, kyivMinute = 0): string {
      // Start with a naive UTC guess at the same wall clock.
      const guess = new Date(
        `${kyivDate}T${String(kyivHour).padStart(2, '0')}:${String(kyivMinute).padStart(2, '0')}:00Z`,
      );
      // Ask "what hour would this moment be in Kyiv?" — the difference is the offset.
      const kyivHourOfGuess = parseInt(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'Europe/Kyiv',
          hour: 'numeric',
          hour12: false,
        }).format(guess),
        10,
      );
      // If guess Kyiv-hour is 13 and we wanted 10, shift UTC back 3h.
      const shiftMs = (kyivHour - kyivHourOfGuess) * 3_600_000;
      return new Date(guess.getTime() + shiftMs).toISOString();
    }

    let slot: { id: string; [k: string]: unknown } | null = null;
    let lastError: unknown = null;
    outer: for (const liftId of data.liftIds) {
      for (let h = 10; h <= 16; h++) {
        // Kyiv 10:00-16:00 — робочий день (workStartHour=8, workEndHour=18 defaults).
        const startAt = kyivWallToUtcIso(kyivToday, h, 0);
        const endAt = kyivWallToUtcIso(kyivToday, h, 30);
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
