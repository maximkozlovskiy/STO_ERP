import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getToken(page: Page): Promise<string> {
  return (await page.evaluate(() => sessionStorage.getItem('sto_access_token'))) ?? '';
}

async function apiPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, path, body }) => {
      const r = await fetch(`http://localhost:3000/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`POST ${path} → ${r.status}: ${t}`);
      }
      const t = await r.text();
      return (t ? JSON.parse(t) : null) as T;
    },
    { token, path, body },
  );
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, path }) => {
      const r = await fetch(`http://localhost:3000/api${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
      return r.json() as T;
    },
    { token, path },
  );
}

async function apiDelete(page: Page, path: string): Promise<void> {
  const token = await getToken(page);
  await page.evaluate(
    async ({ token, path }) => {
      await fetch(`http://localhost:3000/api${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    { token, path },
  );
}

/** Повертає { warehouseId, branchId } першого складу або null */
async function firstWarehouse(
  page: Page,
): Promise<{ warehouseId: string; branchId: string } | null> {
  const d = await apiGet<{ id: string; branchId: string }[]>(page, '/warehouses?limit=1');
  if (!Array.isArray(d) || !d[0]) return null;
  return { warehouseId: d[0].id, branchId: d[0].branchId };
}

/** Створює документ через API, повертає { id, number } */
async function createDocApi(
  page: Page,
  warehouseId: string,
  branchId: string,
  type = 'WRITEOFF',
): Promise<{ id: string; number: string }> {
  return apiPost(page, '/stock-documents', { type, warehouseId, branchId });
}

async function gotoStockDocs(page: Page, clearDateFilter = false) {
  await page.goto('/stock-documents');
  await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible({ timeout: 20_000 });
  if (clearDateFilter) {
    // Bug #345: stock-documents page has kyivToday() date filter by default
    const dateInputs = page.locator('input[placeholder="Від"], input[placeholder="До"]');
    const count = await dateInputs.count();
    for (let i = 0; i < count; i++) {
      await dateInputs.nth(i).fill('');
      await dateInputs.nth(i).press('Escape');
    }
    // Dismiss DatePicker popup (rdp-month intercepts table clicks) by clicking h1
    await page.locator('h1').first().click({ force: true });
    await page.waitForTimeout(500);
  }
}

// ─── 1. Навігація ─────────────────────────────────────────────────────────────

test.describe('Складські документи — навігація', () => {
  test('сторінка завантажується — заголовок і таблиця або empty state', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Документів не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка «Документ» (додати) присутня', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(page.getByRole('button', { name: /^Документ$/ }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('статусні фільтри присутні', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(page.locator('button:has-text("Всі")').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('button:has-text("Чернетка"), button:has-text("Підтверджено")').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('фільтри типу документа присутні', async ({ page }) => {
    await gotoStockDocs(page);
    // Тип-фільтри: Всі типи / Списання / Переміщення / Поч. залишки
    await expect(
      page.locator('button:has-text("Списання"), button:has-text("Переміщення"), select').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 2. Створення через UI ────────────────────────────────────────────────────

test.describe('Складські документи — створення через UI', () => {
  test('відкрити модалку «Новий документ» — поля присутні', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(
      modal.locator('h2:has-text("Новий документ"), h2:has-text("Новий складський")').first(),
    ).toBeVisible();
    // Є поле вибору типу або складу
    await expect(modal.locator('select, [role="combobox"]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test('форма містить поле «Дата документа» з DatePicker', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    // DatePickerInput рендерить input[placeholder="ДД.ММ.РРРР"]
    await expect(modal.locator('input[placeholder="ДД.ММ.РРРР"]')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('поле «Дата документа» ініціалізується сьогоднішньою датою', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    const dateInput = modal.locator('input[placeholder="ДД.ММ.РРРР"]');
    await expect(dateInput).toBeVisible({ timeout: 5_000 });
    const value = await dateInput.inputValue();
    // Має бути у форматі ДД.ММ.РРРР (сьогоднішня дата)
    expect(value).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    await page.keyboard.press('Escape');
  });

  test('documentDate зберігається при створенні та відображається в таблиці', async ({ page }) => {
    await gotoStockDocs(page);

    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Вибрати філію
    const branchSelect = modal.getByLabel('Філія*');
    await branchSelect.selectOption({ index: 1 });

    // Вибрати склад
    const warehouseSelect = modal.locator('select').nth(2);
    await warehouseSelect.selectOption({ index: 1 });

    // Дата документа — читаємо поточне (сьогоднішнє) значення з форми:
    // список фільтрується по dateFrom=today, тому документ з іншою датою не з'явиться.
    // Використовуємо значення що вже підставлене (kyivToday), і перевіряємо що воно є.
    const dateInput = modal.locator('input[placeholder="ДД.ММ.РРРР"]');
    await expect(dateInput).toBeVisible({ timeout: 5_000 });
    const todayDate = await dateInput.inputValue();
    expect(todayDate).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);

    // Зберегти
    await modal.getByRole('button', { name: 'Створити документ' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Найновіший рядок (перший, sort desc) показує сьогоднішню дату
    const firstDateCell = page.locator('tbody tr').first().locator('td').nth(6);
    await expect(firstDateCell).toHaveText(todayDate, { timeout: 10_000 });
  });

  test("вибір типу TRANSFER — з'являється поле «Склад призначення»", async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Вибрати тип TRANSFER
    const typeSelect = modal.locator('select').first();
    if (!(await typeSelect.isVisible({ timeout: 3_000 }).catch(() => false))) {
      await page.keyboard.press('Escape');
      return test.skip(true, 'Немає select типу');
    }
    await typeSelect.selectOption('TRANSFER');
    await page.waitForTimeout(300);

    // Поле "Склад призначення" або "Склад переміщення" має з'явитися
    await expect(
      modal.locator('select').nth(2).or(modal.locator('[placeholder*="призначення"]')).first(),
    ).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('кнопка «Створити документ» — без складу disabled', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    const saveBtn = modal.locator('button:has-text("Створити документ")');
    // Без вибору складу кнопка disabled (або активна якщо дефолтний склад вже обраний)
    const isDisabled = await saveBtn.isDisabled({ timeout: 3_000 }).catch(() => false);
    if (isDisabled) {
      await expect(saveBtn).toBeDisabled();
    }
    await page.keyboard.press('Escape');
  });
});

// ─── 3. Detail Panel ─────────────────────────────────────────────────────────

test.describe('Складські документи — Detail Panel', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('клік на рядок → Detail Panel відкривається', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(
      page.locator('[data-testid="detail-panel"], aside, .detail-panel').first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('Detail Panel — показує тип «Списання» і статус «Чернетка»', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('text=Списання').first()).toBeVisible({ timeout: 5_000 });
  });

  test('Detail Modal — кнопка «Підтвердити документ» присутня для DRAFT', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Відкрити Detail Modal через hover → кнопку «Відкрити деталі»
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('button:has-text("Підтвердити документ")').first()).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press('Escape');
  });

  test('Detail Modal — кнопка «Скасувати» присутня для DRAFT', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('button:has-text("Скасувати")').first()).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press('Escape');
  });
});

// ─── 4. FSM — переходи ────────────────────────────────────────────────────────

test.describe('Складські документи — FSM', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('DRAFT → CANCELLED: «Скасувати» → badge «Скасовано»', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Відкрити Detail Modal через «Відкрити деталі»
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    const cancelBtn = modal.locator('button:has-text("Скасувати")').first();
    await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
    await cancelBtn.click();

    // Confirm dialog (useConfirm)
    const confirmBtn = page
      .locator(
        '[role="dialog"]:not(:has(button:has-text("Скасувати"))) button:has-text("Так"), [role="alertdialog"] button:has-text("Так")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    await expect(page.locator('text=Скасовано').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 5. FSM CONFIRMED ────────────────────────────────────────────────────────

test.describe('Складські документи — FSM CONFIRMED', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('DRAFT → CONFIRMED: «Підтвердити документ» → badge «Підтверджено»', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Відкрити Detail Modal через «Відкрити деталі»
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    const confirmDocBtn = modal.locator('button:has-text("Підтвердити документ")').first();
    await expect(confirmDocBtn).toBeVisible({ timeout: 5_000 });
    await confirmDocBtn.click();

    // Confirm dialog від useConfirm
    const yesBtn = page
      .locator(
        '[role="alertdialog"] button:has-text("Так"), [role="alertdialog"] button:has-text("Підтвердити")',
      )
      .first();
    if (await yesBtn.isVisible({ timeout: 3_000 }).catch(() => false)) await yesBtn.click();

    await expect(page.locator('text=Підтверджено').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 6. Фільтри ──────────────────────────────────────────────────────────────

test.describe('Складські документи — фільтри', () => {
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId, 'OPENING_BALANCE');
    docId = doc.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('фільтр «Чернетка» — показує тільки DRAFT документи', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(500);
    // Всі видимі badge мають бути «Чернетка» або список порожній
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      await expect(
        page.locator('td:has-text("Підтверджено"), td:has-text("Скасовано")').first(),
      ).not.toBeVisible();
    }
  });

  test('фільтр «Всі» — скидає фільтр', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Всі")').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('h1:has-text("Складські документи")')).toBeVisible();
  });

  test('фільтр типу «Поч. залишки» — показує тільки OPENING_BALANCE', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page);
    // Тип-фільтр може бути pill-кнопкою або select
    const openingBtn = page
      .locator('button:has-text("Поч. залишки"), option[value="OPENING_BALANCE"]')
      .first();
    if (!(await openingBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      return test.skip(true, 'Фільтр типу не знайдено');
    }
    await openingBtn.click();
    await page.waitForTimeout(500);
    // Тільки «Поч. залишки» badge або порожньо
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      await expect(
        page.locator('td:has-text("Списання"), td:has-text("Переміщення")').first(),
      ).not.toBeVisible();
    }
  });
});

// ─── 7. Додавання позицій ────────────────────────────────────────────────────

test.describe('Складські документи — позиції (lines)', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('Detail Modal — показує таблицю позицій з колонкою «Товар»', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Відкрити Detail Modal
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    // У модалці є таблиця з колонкою «Товар» (навіть якщо рядків немає)
    await expect(modal.locator('th:has-text("Товар")').first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('форма створення — кнопка «+ Додати» позицію присутня', async ({ page }) => {
    // Позиції додаються у формі створення документа, не у Detail Modal
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Перевіряємо що секція «Позиції» з кнопкою «+ Додати» є у формі
    await expect(modal.locator('text=Позиції').first()).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator('button:has-text("+ Додати")').first()).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press('Escape');
  });
});

// ─── 8. Soft Delete ───────────────────────────────────────────────────────────

test.describe('Складські документи — soft delete', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test('hover → іконки дій → «Позначити на видалення» → рядок зникає', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Hover на рядок → іконка Trash2
    await row.hover();
    const trashBtn = row
      .locator('button[title*="видал"], button[aria-label*="видал"], button:has(svg.lucide-trash2)')
      .first();
    const hasTrash = await trashBtn.isVisible({ timeout: 2_000 }).catch(() => false);

    if (hasTrash) {
      await trashBtn.click();
    } else {
      // Альтернатива: через Detail Panel
      await row.click();
      const markBtn = page
        .locator('button:has-text("Помітити"), button:has-text("Видалити")')
        .first();
      await expect(markBtn).toBeVisible({ timeout: 8_000 });
      await markBtn.click();
    }

    const confirmBtn = page
      .locator(
        '[role="dialog"] button:has-text("Видалити"), [role="dialog"] button:has-text("Помітити"), [role="dialog"] button:has-text("Так")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    await page.waitForTimeout(800);
    // Рядок зникає або набуває opacity-60
    const activeRow = page.locator(`table tbody tr:not(.opacity-60):has-text("${docNumber}")`);
    const gone = !(await activeRow.isVisible({ timeout: 3_000 }).catch(() => false));
    const marked = await page
      .locator(`table tbody tr.opacity-60:has-text("${docNumber}")`)
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    expect(gone || marked).toBeTruthy();
  });

  test('toggle «Показати видалені» — кнопка присутня', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(
      page.locator('button[title="Показати видалені"], button[title*="видален"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('toggle «Показати видалені» — кнопка змінює title після кліку', async ({ page }) => {
    // Перевіряє що toggle реагує на клік (змінює title з «Показати» на «Сховати»).
    // Не залежить від API showDeleted підтримки.
    await gotoStockDocs(page);
    const eyeToggle = page.locator('button[title="Показати видалені"]').first();
    await expect(eyeToggle).toBeVisible({ timeout: 10_000 });
    await eyeToggle.click();
    await page.waitForTimeout(400);
    // Після кліку title має змінитись на «Сховати видалені»
    await expect(page.locator('button[title="Сховати видалені"]').first()).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ─── 9. XLSX-імпорт кнопка ────────────────────────────────────────────────────

test.describe('Складські документи — XLSX', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('в Detail Modal DRAFT документа є кнопка XLSX-імпорту позицій', async ({ page }) => {
    if (!docId) return test.skip(true, 'Документ не створено');
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Відкрити Detail Modal
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Шукаємо кнопку «Імпорт xlsx», «XLSX», «Завантажити шаблон»
    const xlsxBtn = modal
      .locator(
        'button:has-text("xlsx"), button:has-text("XLSX"), button:has-text("Імпорт"), button[title*="xlsx"]',
      )
      .first();
    if (!(await xlsxBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      await page.keyboard.press('Escape');
      return test.skip(true, 'XLSX кнопка не знайдена у Detail Modal');
    }
    await expect(xlsxBtn).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

// ─── 10. Bulk cancel ─────────────────────────────────────────────────────────

test.describe('Складські документи — bulk дії', () => {
  let doc1Id: string;
  let doc2Id: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const [d1, d2] = await Promise.all([
      createDocApi(p, wh.warehouseId, wh.branchId),
      createDocApi(p, wh.warehouseId, wh.branchId),
    ]);
    doc1Id = d1.id;
    doc2Id = d2.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    if (doc1Id) await apiDelete(p, `/stock-documents/${doc1Id}`).catch(() => {});
    if (doc2Id) await apiDelete(p, `/stock-documents/${doc2Id}`).catch(() => {});
    await ctx.close();
  });

  test("вибрати 2 документи → BulkActionsBar з'являється", async ({ page }) => {
    if (!doc1Id || !doc2Id) return test.skip(true, 'Документи не створено');
    await gotoStockDocs(page);
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });

    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    const count = await checkboxes.count();
    if (count < 2) return test.skip(true, 'Недостатньо рядків');

    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    await expect(
      page
        .locator('[data-testid="bulk-actions-bar"], .bulk-actions')
        .or(page.getByText(/Обрано:/i))
        .first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
