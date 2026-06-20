import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

const uid = () => Date.now().toString().slice(-6);

// ─── Роботи ───────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

test.describe('Каталог — CRUD роботи', () => {
  test('створити роботу → перевірити в таблиці → видалити', async ({ page }) => {
    test.setTimeout(45_000); // CRUD + table refresh під паралельним навантаженням
    const workName = `E2E-Робота-${uid()}`;

    await page.goto('/catalog');
    // Чекати повного завантаження: заголовок + кнопка (не таб "Роботи")
    // networkidle не використовується бо під паралельним навантаженням інші воркери
    // тримають postMessage/polling-connections відкритими → ніколи не настає.
    await expect(page.locator('h1:has-text("Каталог")')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Робота', exact: true })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Робота', exact: true }).click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Нова робота")')).toBeVisible();

    // Заповнити: назва, норма-год, ціна (категорія вже вибрана за замовчуванням)
    await modal.getByPlaceholder('Заміна масла').fill(workName);
    await modal.getByPlaceholder('1.5').fill('1'); // норма-год
    await modal.getByPlaceholder('500').fill('500'); // ціна

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Bug #568: при stale E2E даних у БД sort=name ASC ховає новостворений рядок
    // за межами page 1. Використовуємо пошук щоб однозначно знайти рядок.
    await page.getByPlaceholder('Пошук робіт...').fill(workName);
    await expect(page.locator(`table tbody tr:has-text("${workName}")`).first()).toBeVisible({
      timeout: 20_000,
    });

    // Видалити
    const row = page.locator(`table tbody tr:has-text("${workName}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('форма роботи — Зберегти disabled без назви/норма-год/ціни', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.getByRole('button', { name: 'Робота', exact: true })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Робота', exact: true }).click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Порожня форма — disabled
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();

    // Тільки назва — ще disabled
    await modal.getByPlaceholder('Заміна масла').fill('Тест');
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();

    await page.keyboard.press('Escape');
  });
});

// ─── Товари ───────────────────────────────────────────────────────────────────

test.describe('Каталог — CRUD товару', () => {
  test('створити товар з артикулом → перевірити → видалити', async ({ page }) => {
    test.setTimeout(45_000); // CRUD + table refresh під паралельним навантаженням
    const goodName = `E2E-Товар-${uid()}`;
    const sku = `E2E-${uid()}`;

    await page.goto('/catalog');
    await expect(page.locator('button:has-text("Товари та запчастини")')).toBeVisible({
      timeout: 20_000,
    });

    // Перейти на таб Товари
    await page.locator('button:has-text("Товари та запчастини")').click();
    // Кнопка "Товар" (exact) — в тулбарі таба
    await expect(page.getByRole('button', { name: 'Товар', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Товар', exact: true }).click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Новий товар")')).toBeVisible();

    // Заповнити: назва, SKU, ціна продажу
    await modal.getByPlaceholder('Масло моторне 5W-40').fill(goodName);
    await modal.getByPlaceholder('OIL-5W40').fill(sku);
    await modal.getByPlaceholder('500').fill('100'); // Ціна продажу, ₴*

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    // After successful save GoodsTab intentionally reopens the modal in EDIT mode
    // (to allow adding barcodes/UoMs immediately — see openEditGood(newGood) in create()).
    // We expect the title to switch from "Новий товар" to "Редагування товару".
    await expect(page.locator('h2:has-text("Редагування товару")').first()).toBeVisible({
      timeout: 10_000,
    });
    // Close the edit modal so we can verify the row in the table.
    await page.keyboard.press('Escape');
    const leaveBtn = page.locator('button:has-text("Покинути")').first();
    if (await leaveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await leaveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    // Bug #568: stale E2E товари (Dup1-E2E-DUP-*) у БД при sort=name ASC ховають
    // новий рядок за межами page 1 (total>30). Шукаємо через пошук.
    await page.getByPlaceholder(/Пошук за назвою/).fill(goodName);
    await expect(page.locator(`table tbody tr:has-text("${goodName}")`).first()).toBeVisible({
      timeout: 20_000,
    });

    // Перевірити що SKU теж відображається
    const row = page.locator(`table tbody tr:has-text("${goodName}")`).first();
    await expect(row.locator(`text=${sku}`)).toBeVisible();

    // Видалити
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('товар з дублікатом SKU → API повертає помилку', async ({ page }) => {
    // Перевіряємо поведінку безпосередньо через API — не через UI
    const sku = `E2E-DUP-${uid()}`;
    await page.goto('/catalog');
    await expect(page.locator('h1:has-text("Каталог")')).toBeVisible({ timeout: 15_000 });
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
    const apiBase = 'http://localhost:3000';

    // Перший товар — має успішно створитись
    const r1 = await page.evaluate(
      async ({ sku, token, apiBase }) => {
        const r = await fetch(`${apiBase}/api/goods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: `Dup1-${sku}`, sku, salePrice: 100, unit: 'шт' }),
        });
        return { status: r.status, ok: r.ok };
      },
      { sku, token, apiBase },
    );
    expect(r1.ok, `Перший товар має створитись, статус: ${r1.status}`).toBe(true);

    // Другий з тим самим SKU — має повернути 409 Conflict
    const r2 = await page.evaluate(
      async ({ sku, token, apiBase }) => {
        const r = await fetch(`${apiBase}/api/goods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: `Dup2-${sku}`, sku, salePrice: 200, unit: 'шт' }),
        });
        return { status: r.status };
      },
      { sku, token, apiBase },
    );
    expect(r2.status, 'Дублікат SKU має повернути 409').toBe(409);
  });
});
