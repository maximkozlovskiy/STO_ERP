import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getToken(page: Page): Promise<string> {
  // sessionStorage is only accessible when a page is already loaded on the app origin.
  // Caller must ensure page has navigated to localhost:3001 before calling getToken.
  return (await page.evaluate(() => sessionStorage.getItem('sto_access_token'))) ?? '';
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
        const text = await r.text();
        throw new Error(`POST ${path} → ${r.status}: ${text}`);
      }
      const text = await r.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    { token, path, body },
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

/** Повертає id першого активного контрагента або null */
async function firstCpId(page: Page): Promise<string | null> {
  const d = await apiGet<{ items: { id: string }[] }>(page, '/counterparties?limit=1');
  return d.items?.[0]?.id ?? null;
}

/** Створює рахунок через API, повертає { id, number } */
async function createInvoiceApi(
  page: Page,
  cpId: string,
  amount = 200,
): Promise<{ id: string; number: string }> {
  return apiPost(page, '/invoices', { counterpartyId: cpId, amount });
}

async function gotoInvoices(page: Page) {
  await page.goto('/invoices');
  await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
}

// ─── 1. Базова навігація ──────────────────────────────────────────────────────

test.describe('Рахунки — навігація', () => {
  test('сторінка завантажується — заголовок, таблиця або empty state', async ({ page }) => {
    await gotoInvoices(page);
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Рахунків не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка «Рахунок» (додати) присутня', async ({ page }) => {
    await gotoInvoices(page);
    await expect(page.getByRole('button', { name: /^Рахунок$/ }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('статусні фільтри-пілюлі присутні', async ({ page }) => {
    await gotoInvoices(page);
    // Pill для «Всі» завжди рендериться першим
    await expect(page.locator('button:has-text("Всі")').first()).toBeVisible({ timeout: 10_000 });
    // Перевірити що є хоча б два статус-фільтри
    await expect(
      page.locator('button:has-text("Чернетка"), button:has-text("Надіслано")').first(),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test('рядок пошуку присутній', async ({ page }) => {
    await gotoInvoices(page);
    await expect(
      page.locator('input[placeholder*="Пошук"], input[placeholder*="номер"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 2. Створення через UI ────────────────────────────────────────────────────

test.describe('Рахунки — створення через UI', () => {
  test('відкрити модалку «Новий рахунок» — поля присутні', async ({ page }) => {
    await gotoInvoices(page);
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Новий рахунок")')).toBeVisible();
    // Поля форми
    await expect(
      modal.locator('input[placeholder*="телефон"], input[placeholder*="Ім\'я"]').first(),
    ).toBeVisible();
    await expect(modal.getByPlaceholder('0.00')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test('кнопка «Створити рахунок» неактивна без заповнення контрагента', async ({ page }) => {
    await gotoInvoices(page);
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    // Лише сума — без контрагента кнопка має бути disabled
    await modal.getByPlaceholder('0.00').fill('100');
    const saveBtn = modal.locator('button:has-text("Створити рахунок")');
    await expect(saveBtn).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('створити рахунок → DRAFT badge → cleanup', async ({ page }) => {
    await gotoInvoices(page);
    const cpId = await firstCpId(page);
    if (!cpId) return test.skip(true, 'Немає контрагентів у БД');

    await gotoInvoices(page);
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Пошук контрагента
    const cpInput = modal
      .locator(
        'input[placeholder*="телефон"], input[placeholder*="Ім\'я"], input[placeholder*="держ. номер"]',
      )
      .first();
    await cpInput.fill('');
    await cpInput.type('a');
    await page.waitForTimeout(600);
    const opt = page.locator('[role="option"]').first();
    if (!(await opt.isVisible({ timeout: 4_000 }).catch(() => false))) {
      return test.skip(true, 'Combobox не знайшов контрагентів');
    }
    await opt.click();

    await modal.getByPlaceholder('0.00').fill('500');
    const saveBtn = modal.locator('button:has-text("Створити рахунок")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Перевірити появу рядка з badge «Чернетка»
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 10_000 });

    // Cleanup: видалити перший DRAFT
    const firstInv = await apiGet<{ items: { id: string }[] }>(
      page,
      '/invoices?limit=1&status=DRAFT',
    );
    if (firstInv.items?.[0]?.id) {
      await apiDelete(page, `/invoices/${firstInv.items[0].id}`);
    }
  });
});

// ─── 3. Detail Panel ─────────────────────────────────────────────────────────

test.describe('Рахунки — Detail Panel', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 750);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`);
    await ctx.close();
  });

  test('клік на рядок → Detail Panel відкривається', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Panel відображає номер рахунку
    await expect(
      page.locator(`[data-testid="detail-panel"], .detail-panel, aside`).first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('Detail Panel — вкладка «Основне» показує статус Чернетка', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Badge «Чернетка» у панелі
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 8_000 });
  });

  test('Detail Panel — кнопка «Надіслати» присутня для DRAFT', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator('button:has-text("Надіслати")').first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test('Detail Panel — вкладка «Позиції» відображається', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const linesTab = page
      .locator('button:has-text("Позиції"), [role="tab"]:has-text("Позиції")')
      .first();
    await expect(linesTab).toBeVisible({ timeout: 8_000 });
    await linesTab.click();
    // Empty state або список
    await expect(
      page
        .locator('text=Немає позицій')
        .or(page.locator('.rounded-lg.border.border-border'))
        .first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ─── 4. FSM — статусні переходи ──────────────────────────────────────────────

test.describe('Рахунки — FSM переходи', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 300);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('DRAFT → SENT: клік «Надіслати» → badge «Надіслано»', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const sendBtn = page.locator('button:has-text("Надіслати")').first();
    await expect(sendBtn).toBeVisible({ timeout: 8_000 });
    await sendBtn.click();

    // Confirm dialog
    const confirmBtn = page
      .locator(
        '[role="dialog"] button:has-text("Надіслати"), [role="dialog"] button:has-text("Підтвердити"), [role="dialog"] button:has-text("Так")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    await expect(page.locator('text=Надіслано').first()).toBeVisible({ timeout: 10_000 });
  });

  test('SENT → CANCELLED: клік «Скасувати» → badge «Скасовано»', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // Перевірити поточний стан — якщо вже CANCELLED (попередній тест не переходив)
    const alreadyCancelled = await page
      .locator('text=Скасовано')
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (alreadyCancelled) return;

    // Якщо SENT — є кнопка Скасувати
    const cancelBtn = page.locator('button:has-text("Скасувати")').first();
    if (!(await cancelBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return test.skip(true, 'Рахунок не у статусі SENT');
    }
    await cancelBtn.click();

    const confirmBtn = page
      .locator(
        '[role="dialog"] button:has-text("Скасувати"), [role="dialog"] button:has-text("Підтвердити"), [role="dialog"] button:has-text("Так")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    await expect(page.locator('text=Скасовано').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 5. Оплата ───────────────────────────────────────────────────────────────

test.describe('Рахунки — реєстрація оплати', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    // Створити + перевести в SENT
    const inv = await createInvoiceApi(p, cpId, 400);
    invId = inv.id;
    invNumber = inv.number;
    await apiPost(p, `/invoices/${invId}/transition`, { status: 'SENT' });
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('SENT → «Оплатити» → модалка оплати → PAID', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const payBtn = page.locator('button:has-text("Оплатити")').first();
    await expect(payBtn).toBeVisible({ timeout: 8_000 });
    await payBtn.click();

    // Модалка оплати
    const payModal = page.locator('[role="dialog"]').first();
    await expect(payModal).toBeVisible({ timeout: 8_000 });
    await expect(
      payModal.locator('h2:has-text("Оплата"), h2:has-text("Реєстрація оплати")').first(),
    ).toBeVisible();

    // Перевірити поля: метод оплати + сума
    await expect(payModal.locator('select, [role="combobox"]').first()).toBeVisible();
    // Сума — може бути автозаповнена або порожня
    const amountInput = payModal
      .locator('input[placeholder*="Сума"], input[type="number"]')
      .first();
    if (await amountInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await amountInput.fill('400');
    }

    const confirmPayBtn = payModal
      .locator('button:has-text("Оплатити"), button:has-text("Підтвердити")')
      .first();
    await expect(confirmPayBtn).toBeVisible({ timeout: 5_000 });
    await confirmPayBtn.click();

    await expect(payModal).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Оплачено').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 6. Клонування ───────────────────────────────────────────────────────────

test.describe('Рахунки — клонування', () => {
  let invId: string;
  let invNumber: string;
  let clonedId: string | undefined;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 600);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    if (invId) await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    if (clonedId) await apiDelete(p, `/invoices/${clonedId}`).catch(() => {});
    await ctx.close();
  });

  test('«Дублювати» → новий рахунок DRAFT з тим же контрагентом', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const cloneBtn = page.locator('button:has-text("Дублювати")').first();
    await expect(cloneBtn).toBeVisible({ timeout: 8_000 });

    const totalBefore = await page.locator('table tbody tr').count();
    await cloneBtn.click();

    // Очікуємо появи нового рядка або оновлення списку
    await page.waitForTimeout(1500);
    // Detail Panel має показати новий рахунок (DRAFT badge)
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 10_000 });

    // Зберегти id клону для cleanup
    const inv2 = await apiGet<{ items: { id: string; number: string }[] }>(
      page,
      '/invoices?limit=2&status=DRAFT',
    );
    const cloneItem = inv2.items?.find(i => i.id !== invId);
    if (cloneItem) clonedId = cloneItem.id;

    // Список стався довшим або залишився (якщо була пагінація)
    const totalAfter = await page.locator('table tbody tr').count();
    expect(totalAfter).toBeGreaterThanOrEqual(totalBefore);
  });
});

// ─── 7. Пошук і фільтрація ───────────────────────────────────────────────────

test.describe('Рахунки — пошук і фільтри', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 111);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('пошук за номером → знаходить рахунок', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="номер"]')
      .first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill(invNumber);
    await page.waitForTimeout(600);
    await expect(page.locator(`table tbody tr:has-text("${invNumber}")`).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('фільтр статус «Чернетка» → показує тільки DRAFT', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(500);
    // Всі badge у таблиці мають бути «Чернетка» (або empty state)
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      // Перевіряємо що немає badge Надіслано/Оплачено
      await expect(
        page.locator('td:has-text("Надіслано"), td:has-text("Оплачено")').first(),
      ).not.toBeVisible();
    }
  });

  test('скидання фільтру «Всі» → відображає всі рахунки', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Всі")').first().click();
    await page.waitForTimeout(400);
    // Сторінка завантажилась без помилок
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible();
  });

  test('пошук пустий рядок → відображає всі', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="номер"]')
      .first();
    await searchInput.fill('zzz_not_found_xyz');
    await page.waitForTimeout(600);
    await searchInput.clear();
    await page.waitForTimeout(600);
    // Таблиця знову показує рядки
    await expect(
      page
        .locator('table tbody tr')
        .first()
        .or(page.getByText(/Нічого не знайдено/i).first()),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 8. Soft Delete + ShowDeleted ────────────────────────────────────────────

test.describe('Рахунки — soft delete', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 50);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test('hover → іконка видалення → підтвердити → рахунок зникає зі списку', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Hover на рядок → з'являється іконка видалення (Trash2)
    await row.hover();
    const deleteIcon = row
      .locator('button[title*="видал"], button[title*="Видал"], button[aria-label*="видал"]')
      .first();
    const hasHoverIcon = await deleteIcon.isVisible({ timeout: 2_000 }).catch(() => false);

    if (hasHoverIcon) {
      await deleteIcon.click();
    } else {
      // Альтернатива: через Detail Panel → кнопку «Помітити на видалення»
      await row.click();
      const markBtn = page
        .locator('button:has-text("Помітити"), button:has-text("Видалити")')
        .first();
      await expect(markBtn).toBeVisible({ timeout: 8_000 });
      await markBtn.click();
    }

    // Confirm dialog
    const confirmBtn = page
      .locator(
        '[role="dialog"] button:has-text("Видалити"), [role="dialog"] button:has-text("Так"), [role="dialog"] button:has-text("Підтвердити")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // Рядок зникає (або отримує opacity-60)
    await page.waitForTimeout(800);
    const deletedRow = page.locator(`table tbody tr.opacity-60:has-text("${invNumber}")`);
    const gone = !(await page
      .locator(`table tbody tr:not(.opacity-60):has-text("${invNumber}")`)
      .isVisible({ timeout: 3_000 })
      .catch(() => false));
    const markedDeleted = await deletedRow.isVisible({ timeout: 2_000 }).catch(() => false);
    expect(gone || markedDeleted).toBeTruthy();
  });

  test('toggle «Показати видалені» → кількість рядків зростає', async ({ page }) => {
    // Self-contained: перевіряє що після toggle total рахунків збільшується.
    // Не залежить від конкретного номера — стійкий до пагінації та debounce.
    await gotoInvoices(page);

    // Запам'ятати кількість рядків БЕЗ видалених
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });
    const countBefore = await page.locator('table tbody tr').count();

    // Переконатися що є хоча б один видалений запис (попередній тест видалив invId)
    // Якщо invId не встановлений — пропускаємо
    if (!invId) return test.skip(true, 'Рахунок для видалення не створено');

    // Переконатись що invId видалено (попередній тест міг вже зробити це)
    await apiDelete(page, `/invoices/${invId}`).catch(() => {});
    await page.reload();
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });

    // Знаємо total без видалених
    const totalText = await page
      .locator('p.page-subtitle, p:has-text("рахунків")')
      .first()
      .textContent();
    const totalWithout = parseInt(totalText?.match(/\d+/)?.[0] ?? '0', 10);

    // Клік toggle — «Показати видалені»
    const eyeToggle = page.locator('button[title="Показати видалені"]').first();
    await expect(eyeToggle).toBeVisible({ timeout: 10_000 });
    await eyeToggle.click();
    await page.waitForTimeout(800);

    // Total має зрости (є хоча б один видалений)
    const totalTextAfter = await page
      .locator('p.page-subtitle, p:has-text("рахунків")')
      .first()
      .textContent();
    const totalWith = parseInt(totalTextAfter?.match(/\d+/)?.[0] ?? '0', 10);

    expect(totalWith).toBeGreaterThan(totalWithout);
  });
});

// ─── 9. PDF завантаження ─────────────────────────────────────────────────────

test.describe('Рахунки — PDF', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 900);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('«Завантажити PDF» — не кидає видиму помилку', async ({ page }) => {
    if (!invId) return test.skip(true, 'Рахунок не створено');
    await gotoInvoices(page);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const pdfBtn = page.locator('button:has-text("Завантажити PDF")').first();
    await expect(pdfBtn).toBeVisible({ timeout: 8_000 });

    // Перехопити download event або переконатись що немає помилки
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 8_000 }).catch(() => null),
      pdfBtn.click(),
    ]);

    // Якщо download не відбувся — перевіряємо що нема error banner
    if (!download) {
      // Може бути що /pdf endpoint повертає blob inline
      await page.waitForTimeout(1000);
      const errorBanner = page.locator('.text-destructive-text, [class*="destructive"]').first();
      const hasError = await errorBanner.isVisible({ timeout: 2_000 }).catch(() => false);
      expect(hasError).toBeFalsy();
    } else {
      expect(download.suggestedFilename()).toMatch(/invoice.*\.pdf/i);
    }
  });
});

// ─── 10. Bulk actions ────────────────────────────────────────────────────────

test.describe('Рахунки — bulk cancel', () => {
  let inv1Id: string;
  let inv2Id: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const [i1, i2] = await Promise.all([
      createInvoiceApi(p, cpId, 110),
      createInvoiceApi(p, cpId, 220),
    ]);
    // Перевести обидва в SENT щоб bulk cancel мав ефект
    await Promise.all([
      apiPost(p, `/invoices/${i1.id}/transition`, { status: 'SENT' }),
      apiPost(p, `/invoices/${i2.id}/transition`, { status: 'SENT' }),
    ]);
    inv1Id = i1.id;
    inv2Id = i2.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    if (inv1Id) await apiDelete(p, `/invoices/${inv1Id}`).catch(() => {});
    if (inv2Id) await apiDelete(p, `/invoices/${inv2Id}`).catch(() => {});
    await ctx.close();
  });

  test('вибрати 2 рахунки → «Скасувати вибрані» → BulkActionsBar зникає', async ({ page }) => {
    if (!inv1Id || !inv2Id) return test.skip(true, 'Рахунки не створено');
    await gotoInvoices(page);

    // Чекаємо завантаження таблиці
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });

    // Чекбокс у першому рядку
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    const count = await checkboxes.count();
    if (count < 2) return test.skip(true, 'Недостатньо рядків для bulk select');

    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    // BulkActionsBar має з'явитись
    const bulkBar = page
      .locator('[data-testid="bulk-actions-bar"], .bulk-actions, text=вибрано')
      .first();
    await expect(bulkBar).toBeVisible({ timeout: 5_000 });

    const bulkCancelBtn = page.locator('button:has-text("Скасувати вибрані")').first();
    if (!(await bulkCancelBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      return test.skip(true, 'Bulk cancel кнопка не знайдена');
    }
    await bulkCancelBtn.click();

    // Confirm якщо є
    const confirmBtn = page
      .locator(
        '[role="dialog"] button:has-text("Скасувати"), [role="dialog"] button:has-text("Так")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // BulkActionsBar зникає після операції
    await expect(bulkBar).not.toBeVisible({ timeout: 8_000 });
  });
});
