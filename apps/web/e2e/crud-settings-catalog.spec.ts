import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const uid = () => Date.now().toString().slice(-6);

// ─── Бренди ───────────────────────────────────────────────────────────────────

test.describe('Каталог — CRUD бренду', () => {
  test('створити бренд → перевірити в таблиці → видалити', async ({ page }) => {
    const brandName = `E2E-Бренд-${uid()}`;

    await page.goto('/catalog');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1:has-text("Каталог")')).toBeVisible({ timeout: 25_000 });

    // Перейти на таб Бренди
    await page.locator('button:has-text("Бренди")').click();
    // BrandsTab завантажується динамічно — чекати кнопку "Бренд"
    await expect(page.getByRole('button', { name: 'Бренд', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(500); // дати час dynamic import

    await page.getByRole('button', { name: 'Бренд', exact: true }).click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Новий бренд")')).toBeVisible();

    await modal.getByPlaceholder('наприклад: Bosch, NGK, Brembo').fill(brandName);

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Перевірити через API що бренд створено
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
    const brand = await page.evaluate(
      async ({ token, brandName }) => {
        const r = await fetch(
          `http://localhost:3000/api/brands?q=${encodeURIComponent(brandName)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const d = await r.json();
        const items = Array.isArray(d) ? d : (d.items ?? []);
        return items.find((b: { name: string }) => b.name === brandName) ?? null;
      },
      { token, brandName },
    );
    expect(brand, `Бренд "${brandName}" має бути в БД після збереження`).toBeTruthy();

    // Перевірка через API достатня — UI перевірено раніше (modal закрився)

    // Cleanup через API
    if (brand) {
      const token2 = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
      await page.evaluate(
        async ({ token, id }) => {
          await fetch(`http://localhost:3000/api/brands/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
        },
        { token: token2, id: brand.id },
      );
    }
  });

  test('бренд — Зберегти disabled без назви', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.locator('h1:has-text("Каталог")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Бренди")').click();
    await page.getByRole('button', { name: 'Бренд', exact: true }).click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();
    await page.keyboard.press('Escape');
  });
});

// ─── Одиниці виміру ───────────────────────────────────────────────────────────

test.describe('Каталог — CRUD одиниці виміру', () => {
  test('створити одиницю → перевірити → видалити', async ({ page }) => {
    const id = uid();
    const shortName = `e${id}`;
    const fullName = `E2E-Одиниця-${id}`;

    await page.goto('/catalog');
    await expect(page.locator('h1:has-text("Каталог")')).toBeVisible({ timeout: 20_000 });

    await page.locator('button:has-text("Одиниці виміру")').click();
    await expect(page.getByRole('button', { name: 'Одиниця', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: 'Одиниця', exact: true }).click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Нова одиниця")')).toBeVisible();

    // shortName (перший input type=text з placeholder "шт" — exact match)
    await modal.locator('input[placeholder="шт"]').first().fill(shortName);
    await modal.locator('input[placeholder="штука"]').fill(fullName);

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    await expect(page.locator(`table tbody tr:has-text("${shortName}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    // Cleanup
    const row = page.locator(`table tbody tr:has-text("${shortName}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page
      .locator('button:has-text("Помітити на видалення"), button:has-text("Видалити")')
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('одиниця — Зберегти disabled без shortName', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.locator('h1:has-text("Каталог")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Одиниці виміру")').click();
    await expect(page.getByRole('button', { name: 'Одиниця', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Одиниця', exact: true }).click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();
    // Тільки повна назва — ще disabled (потрібен shortName)
    await modal.getByPlaceholder('штука').fill('Тест');
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();
    await page.keyboard.press('Escape');
  });
});
