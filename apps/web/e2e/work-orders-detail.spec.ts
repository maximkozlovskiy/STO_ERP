import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiCall(page: Page, method: string, path: string, body?: Record<string, unknown>) {
  const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
  return page.evaluate(
    async ({ token, method, path, body }) => {
      const r = await fetch(`http://localhost:3000/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) return null;
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    },
    { token, method, path, body: body ?? null },
  );
}

// UUID v4 version nibble is '4' at position 14 (0-indexed in hex without dashes)
function isV4Uuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function createWo(page: Page, description: string) {
  // Потрібен CLIENT (не SUPPLIER) щоб мати vehicleId
  const cp = await apiCall(page, 'GET', '/counterparties?type=CLIENT&limit=1');
  const cpId = cp?.items?.[0]?.id ?? (Array.isArray(cp) ? cp[0]?.id : null);
  if (!cpId) return null;

  // Беремо перший branch з v4 UUID — nil UUID не пройде @IsUUID() у WO DTO
  const branches = await apiCall(page, 'GET', '/branches');
  const branchList: { id: string }[] = Array.isArray(branches) ? branches : (branches?.items ?? []);
  const branchId = branchList.find(b => isV4Uuid(b.id))?.id ?? branchList[0]?.id;
  if (!branchId) return null;

  // Знайти авто цього клієнта через його гараж
  const garages = await apiCall(page, 'GET', `/counterparties/${cpId}/garages`);
  const garageId = Array.isArray(garages) ? garages[0]?.id : garages?.items?.[0]?.id;
  if (!garageId) return null;

  const vehicles = await apiCall(page, 'GET', `/vehicles?customerGarageId=${garageId}&limit=1`);
  const vehicleId = Array.isArray(vehicles) ? vehicles[0]?.id : vehicles?.items?.[0]?.id;
  if (!vehicleId) return null;

  return apiCall(page, 'POST', '/work-orders', {
    counterpartyId: cpId,
    branchId,
    vehicleId,
    description,
  });
}

async function transition(page: Page, woId: string, status: string) {
  return apiCall(page, 'POST', `/work-orders/${woId}/transition`, { status });
}

// ─── Додавання роботи до картки наряду ───────────────────────────────────────

test.describe('Наряд — додавання роботи', () => {
  test('кнопка "Додати роботу" присутня на картці DRAFT наряду', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });

    const wo = await createWo(page, 'E2E add-line test');
    if (!wo) {
      test.skip(true, 'Немає контрагентів для наряду');
      return;
    }

    await page.goto(`/work-orders/${wo.id}`);
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('button:has-text("Додати роботу"), button:has-text("+ Робота")').first(),
    ).toBeVisible({ timeout: 10_000 });

    await apiCall(page, 'DELETE', `/work-orders/${wo.id}`);
  });

  test('додати роботу → форма → рядок у таблиці', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });

    const wo = await createWo(page, 'E2E add-line save test');
    if (!wo) {
      test.skip(true, 'Немає контрагентів');
      return;
    }

    await page.goto(`/work-orders/${wo.id}`);
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 20_000 });

    await page
      .locator('button:has-text("Додати роботу"), button:has-text("+ Робота")')
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.getByText(/Додати роботу/i)).toBeVisible();

    // Вибрати роботу (перший у select після "— Оберіть —")
    const workSelect = modal.locator('select').first();
    await expect(workSelect).toBeVisible({ timeout: 5_000 });
    const worksCount = await workSelect.locator('option').count();
    if (worksCount < 2) {
      await page.keyboard.press('Escape');
      await apiCall(page, 'DELETE', `/work-orders/${wo.id}`);
      test.skip(true, 'Немає робіт у каталозі');
      return;
    }
    await workSelect.selectOption({ index: 1 });

    // Виконавець
    const empSelect = modal.locator('select').nth(1);
    const empCount = await empSelect.locator('option').count();
    if (empCount >= 2) await empSelect.selectOption({ index: 1 });

    const saveBtn = modal.locator('button:has-text("Додати"), button:has-text("Зберегти")').last();
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Рядок роботи з'явився в секції "Роботи" (lines рендеряться як div, не table)
    await expect(
      page
        .locator('h2:has-text("Роботи") ~ div div.flex')
        .first()
        .or(page.locator('[class*="divide-y"] > div').first()),
    ).toBeVisible({ timeout: 15_000 });

    await apiCall(page, 'DELETE', `/work-orders/${wo.id}`);
  });
});

// ─── Додавання запчастини до картки наряду ───────────────────────────────────

test.describe('Наряд — додавання запчастини', () => {
  test('кнопка "Додати запчастину" присутня на DRAFT наряді', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });

    const wo = await createWo(page, 'E2E add-part test');
    if (!wo) {
      test.skip(true, 'Немає контрагентів');
      return;
    }

    await page.goto(`/work-orders/${wo.id}`);
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('button:has-text("Додати запчастину"), button:has-text("+ Запчастина")').first(),
    ).toBeVisible({ timeout: 10_000 });

    await apiCall(page, 'DELETE', `/work-orders/${wo.id}`);
  });

  test('додати запчастину → пошук товару → рядок у таблиці', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });

    const wo = await createWo(page, 'E2E add-part save test');
    if (!wo) {
      test.skip(true, 'Немає контрагентів');
      return;
    }

    await page.goto(`/work-orders/${wo.id}`);
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 20_000 });

    await page
      .locator('button:has-text("Додати запчастину"), button:has-text("+ Запчастина")')
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.getByText(/запчастин/i)).toBeVisible();

    // Пошук товару — ввести щось щоб появились результати
    const goodInput = modal
      .locator(
        'input[placeholder*="Назва"], input[placeholder*="артикул"], input[placeholder*="штрих"]',
      )
      .first();
    await expect(goodInput).toBeVisible({ timeout: 5_000 });
    await goodInput.fill('');
    await page.waitForTimeout(600);

    const opt = page.locator('[role="option"]').first();
    if (!(await opt.isVisible({ timeout: 4_000 }).catch(() => false))) {
      await page.keyboard.press('Escape');
      await apiCall(page, 'DELETE', `/work-orders/${wo.id}`);
      test.skip(true, 'Немає товарів у каталозі');
      return;
    }
    await opt.click();

    const saveBtn = modal.locator('button:has-text("Додати"), button:has-text("Зберегти")').last();
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Запчастини рендеряться як div, не table
    await expect(
      page
        .locator('h2:has-text("Запчастини") ~ div div.flex')
        .first()
        .or(page.locator('[class*="divide-y"] > div').first()),
    ).toBeVisible({ timeout: 15_000 });

    await apiCall(page, 'DELETE', `/work-orders/${wo.id}`);
  });
});

// ─── Повний FSM цикл DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → COMPLETED → INVOICED → PAID ──

test.describe('Наряд — повний FSM цикл DRAFT→PAID', () => {
  let woId: string | null = null;

  test('DRAFT → Кошторис (ESTIMATE)', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });
    const wo = await createWo(page, 'E2E FSM full cycle');
    if (!wo) {
      test.skip(true, 'Немає контрагентів');
      return;
    }
    woId = wo.id;

    // Додати роботу через API щоб totalAmount > 0 (інакше COMPLETED заблокований)
    // employeeId — обов'язкове поле для лінії наряду
    const [works, emps] = await Promise.all([
      apiCall(page, 'GET', '/works?limit=1'),
      apiCall(page, 'GET', '/employees?limit=1'),
    ]);
    const workId = works?.items?.[0]?.id ?? (Array.isArray(works) ? works[0]?.id : null);
    const employeeId = emps?.items?.[0]?.id ?? (Array.isArray(emps) ? emps[0]?.id : null);
    if (workId && employeeId) {
      await apiCall(page, 'POST', `/work-orders/${woId}/lines`, {
        workId,
        employeeId,
        normoHours: 1,
        price: 100,
      });
    }

    await page.goto(`/work-orders/${woId}`);
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Кошторис")').first().click();
    const confirm = page.locator('button:has-text("Підтвердити"), button:has-text("Так")').first();
    if (await confirm.isVisible({ timeout: 3_000 })) await confirm.click();
    await expect(page.locator('text=Кошторис').first()).toBeVisible({ timeout: 10_000 });
  });

  test('ESTIMATE → Затвердити (APPROVED)', async ({ page }) => {
    if (!woId) {
      test.skip(true, 'попередній тест не створив WO');
      return;
    }
    await page.goto(`/work-orders/${woId}`);
    await expect(page.locator('text=Кошторис').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Затвердити")').first().click();
    const confirm = page.locator('button:has-text("Підтвердити"), button:has-text("Так")').first();
    if (await confirm.isVisible({ timeout: 3_000 })) await confirm.click();
    await expect(page.locator('text=Затверджено').first()).toBeVisible({ timeout: 10_000 });
  });

  test('APPROVED → В роботу (IN_PROGRESS)', async ({ page }) => {
    if (!woId) {
      test.skip(true, 'WO не доступний');
      return;
    }
    await page.goto(`/work-orders/${woId}`);
    await expect(page.locator('text=Затверджено').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("В роботу")').first().click();
    const confirm = page.locator('button:has-text("Підтвердити"), button:has-text("Так")').first();
    if (await confirm.isVisible({ timeout: 3_000 })) await confirm.click();
    await expect(page.locator('text=В роботі').first()).toBeVisible({ timeout: 10_000 });
  });

  test('IN_PROGRESS → Виконано (COMPLETED)', async ({ page }) => {
    if (!woId) {
      test.skip(true, 'WO не доступний');
      return;
    }
    await page.goto(`/work-orders/${woId}`);
    await expect(page.locator('text=В роботі').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Виконано")').first().click();
    const confirm = page.locator('button:has-text("Підтвердити"), button:has-text("Так")').first();
    if (await confirm.isVisible({ timeout: 3_000 })) await confirm.click();
    await expect(page.locator('text=Виконано').first()).toBeVisible({ timeout: 10_000 });
  });

  test('COMPLETED → Виставити рахунок (INVOICED)', async ({ page }) => {
    if (!woId) {
      test.skip(true, 'WO не доступний');
      return;
    }
    await page.goto(`/work-orders/${woId}`);
    await expect(page.locator('text=Виконано').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Виставити рахунок")').first().click();
    const confirm = page.locator('button:has-text("Підтвердити"), button:has-text("Так")').first();
    if (await confirm.isVisible({ timeout: 3_000 })) await confirm.click();
    await expect(page.locator('text=Виставлено').first()).toBeVisible({ timeout: 10_000 });
  });

  test('INVOICED → Оплачено (PAID)', async ({ page }) => {
    if (!woId) {
      test.skip(true, 'WO не доступний');
      return;
    }
    await page.goto(`/work-orders/${woId}`);
    await expect(page.locator('text=Виставлено').first()).toBeVisible({ timeout: 20_000 });
    // FSM INVOICED → PAID — кнопка "Оплачено" або "Оплатити"
    await page.locator('button:has-text("Оплачено"), button:has-text("Оплатити")').first().click();
    const confirm = page.locator('button:has-text("Підтвердити"), button:has-text("Так")').first();
    if (await confirm.isVisible({ timeout: 3_000 })) await confirm.click();
    await expect(page.locator('text=Оплачено').first()).toBeVisible({ timeout: 10_000 });

    // Cleanup — наряд у фінальному статусі, просто видаляємо
    await apiCall(page, 'DELETE', `/work-orders/${woId}`);
    woId = null;
  });
});
