import { test, expect, type Page } from '@playwright/test';
import { rowBodyCell } from './row-click';
import {
  API,
  apiCall,
  cardField,
  createCounterparty,
  createPlainRegister,
  deleteRegister,
  getBalance,
  getToken,
  historyRow,
  openCashCard,
  pickInCard,
} from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Оплати клієнтів — money-flow після рішення власника 2026-10-14: окремої сторінки
 * «Оплати клієнтів» немає. Оплату реєструють:
 *   - у рахунку — /invoices → бокова панель «Оплатити» → POST /payments (як і раніше);
 *   - у касі — /cash → «Внести» → привід «Оплата контрагента» з обов'язковим контрагентом
 *     (POST /cash-registers/:id/operations; каса сама створює оплату клієнта).
 * Стара адреса /payments веде в касу.
 *
 * ── Сценарії «за контрактом» ──
 * Тести з міткою [контракт] спираються на нову поведінку бекенда (BR-CASH-016…022): каса
 * створює оплату клієнта, рядок історії несе контрагента й фіскальний стан. До злиття з
 * бекендом вони можуть бути червоними — це очікувано.
 *
 * ── Свідомо НЕ покрито (потребує зовнішнього шлюзу) ──
 *   - QR-оплата (monobank/LiqPay) повний roundtrip — покрито детерміновану частину:
 *     перемикання методу на monobank_qr → футер модалки міняється на «Показати QR» — лише коли
 *     monobank підключено у філії; інакше способу monobank_qr у вікні немає (BR-PAY-033).
 *   - Фіскальний чек до DONE: без налаштованого Checkbox воркер переводить QUEUED у SKIPPED.
 *   - Успішне відкриття касової зміни: без ПРРО — «Фіскалізацію не налаштовано».
 *
 * Оплати й касові операції — append-only (фінансовий слід), тож лишаються в БД навмисно.
 * Каси й контрагентів, створених тестом, прибираємо.
 *
 * Готівка з рахунку — лише через касу (BR-PAY-019, рішення власника 2026-10-14): у вікні
 * «Оплатити» є поле «Каса», заповнене касою за замовчуванням способу оплати; без каси готівкою
 * оплатити не можна. Тести оплати рахунку готівкою обирають касу, створену у beforeAll.
 */

/** Клієнт для оплати рахунку. */
async function getClientId(page: Page, token: string): Promise<string> {
  const res = await apiCall<{ items?: { id: string }[] }>(
    page,
    token,
    'GET',
    '/counterparties?types=CLIENT,BOTH&limit=1',
  );
  const id = res.body.items?.[0]?.id ?? null;
  expect(id, 'seed має містити клієнта (CLIENT/BOTH)').toBeTruthy();
  return id as string;
}

/** Створює рахунок і транзитить у SENT (готовий до оплати). */
async function createSentInvoice(
  page: Page,
  token: string,
  counterpartyId: string,
  amount: number,
): Promise<{ id: string; number: string }> {
  const created = await apiCall<{ id: string; number: string }>(page, token, 'POST', '/invoices', {
    counterpartyId,
    amount,
  });
  expect(created.status, `створення рахунку: ${JSON.stringify(created.body)}`).toBe(201);
  // BR-INV-023: без рядків рахунок не виставляється. vatRate 0 — сума лишається `amount`
  // за будь-якого режиму ПДВ організації.
  const line = await apiCall(page, token, 'POST', `/invoices/${created.body.id}/lines`, {
    description: '000 E2E послуга',
    quantity: 1,
    unitPrice: amount,
    vatRate: 0,
  });
  expect(line.status, `рядок рахунку: ${JSON.stringify(line.body)}`).toBe(201);
  const sent = await apiCall(page, token, 'POST', `/invoices/${created.body.id}/transition`, {
    status: 'SENT',
  });
  expect(sent.status, `виставлення рахунку: ${JSON.stringify(sent.body)}`).toBeLessThan(300);
  return { id: created.body.id, number: created.body.number };
}

async function getInvoice(page: Page, token: string, id: string) {
  const res = await apiCall<{ status: string; paidAmount: number }>(
    page,
    token,
    'GET',
    `/invoices/${id}`,
  );
  return res.body;
}

/** Залишок каси (GET /cash-registers/:id). */
async function registerBalance(page: Page, token: string, id: string): Promise<number> {
  const res = await apiCall<{ balance: number | string }>(
    page,
    token,
    'GET',
    `/cash-registers/${id}`,
  );
  expect(res.status, `читання каси: ${JSON.stringify(res.body)}`).toBe(200);
  return Number(res.body.balance);
}

/** Рядки каси, що належать оплаті клієнта `paymentId`. */
async function paymentRows(page: Page, token: string, registerId: string, paymentId: string) {
  const res = await apiCall<
    { documentType?: string | null; documentId?: string | null; reason: string; amount: number }[]
  >(page, token, 'GET', `/cash-registers/${registerId}/operations?limit=100`);
  expect(res.status, `історія каси: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.filter(r => r.documentType === 'Payment' && r.documentId === paymentId);
}

/** Відкриває модалку оплати рахунку з бокової панелі списку. */
async function openInvoicePayModal(page: Page, invoiceNumber: string) {
  await page.goto('/invoices');
  await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
  // Свіжий рахунок має сьогоднішню дату — типовий фільтр «сьогодні» його показує.
  await page.locator('input[placeholder*="Пошук"]').first().fill(invoiceNumber);
  const row = page.locator(`table tbody tr:has-text("${invoiceNumber}")`).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  // «Оплатити» живе у боковій панелі; панель показує клік по рядку.
  await rowBodyCell(row).click();
  const payBtn = page.getByRole('button', { name: 'Оплатити' }).first();
  await expect(payBtn).toBeVisible({ timeout: 15_000 });
  await payBtn.click();
  const modal = page
    .locator('[role="dialog"]')
    .filter({ hasText: `Реєстрація оплати по рахунку ${invoiceNumber}` })
    .first();
  await expect(modal).toBeVisible({ timeout: 10_000 });
  return modal;
}

test.describe('Оплати клієнтів (money-flow)', () => {
  // Каса для оплат рахунків готівкою. «000» на початку: список кас віддає перші 200 за назвою, а в
  // dev-базі сотні старих «E2E Каса N» — без цього нова каса не потрапляла б у поле вікна оплати.
  const payStamp = Date.now();
  const payRegisterName = `000 E2E Оплата каса ${payStamp}`;
  let payRegisterId = '';
  // Власний спосіб оплати з касою за замовчуванням — системну «Готівку» тест не чіпає (сусідні
  // файли E2E ідуть паралельно, а її замовчування — спільне для всієї організації).
  const payMethodCode = `pay_e2e_${payStamp}`;
  const payMethodName = `000 E2E Оплата спосіб ${payStamp}`;
  let payMethodId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/cash');
    const token = await getToken(p);
    payRegisterId = await createPlainRegister(p, token, payRegisterName);
    const method = await apiCall<{ id: string }>(p, token, 'POST', '/payment-methods', {
      code: payMethodCode,
      name: payMethodName,
      // В кінець списку: інші вікна оплати беруть перший спосіб за замовчуванням.
      sortOrder: 999,
      requiresFiscal: false,
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: payRegisterId,
    });
    expect(method.status, `створення способу оплати: ${JSON.stringify(method.body)}`).toBe(201);
    payMethodId = method.body.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/cash');
    const token = await getToken(p);
    if (payMethodId) await apiCall(p, token, 'DELETE', `/payment-methods/${payMethodId}`);
    if (payRegisterId) await deleteRegister(p, token, payRegisterId);
    await ctx.close();
  });

  // ─── Сторінки більше немає ──────────────────────────────────────────────────
  test('стара адреса /payments веде в касу', async ({ page }) => {
    await page.goto('/payments');
    await expect(page).toHaveURL(/\/cash\/?$/, { timeout: 20_000 });
    await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
  });

  test('у меню немає пунктів оплат, каса на місці', async ({ page }) => {
    await page.goto('/cash');
    await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('a[href^="/cash"]').first()).toBeAttached();
    await expect(page.locator('a[href^="/payments"]')).toHaveCount(0);
    await expect(page.locator('a[href^="/supplier-payments"]')).toHaveCount(0);
  });

  // ─── Оплата рахунку через UI ────────────────────────────────────────────────
  test('оплата рахунку через UI: SENT → «Оплатити» → cash → рахунок PAID', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const inv = await createSentInvoice(page, token, await getClientId(page, token), 100);

    const modal = await openInvoicePayModal(page, inv.number);
    await expect(modal.getByText('Залишок до сплати:')).toBeVisible();
    // Метод «Готівка» і каса (BR-PAY-019). Порожня сума = оплата залишку повністю.
    await modal.getByLabel('Метод оплати').selectOption('cash');
    await modal.getByLabel(/^Каса/).selectOption(payRegisterId);
    await modal.getByRole('button', { name: 'Підтвердити оплату' }).click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    await expect
      .poll(async () => (await getInvoice(page, token, inv.id)).status, {
        timeout: 10_000,
        message: 'повна оплата має провести рахунок у PAID',
      })
      .toBe('PAID');
    expect((await getInvoice(page, token, inv.id)).paidAmount).toBeCloseTo(100, 2);
  });

  test('часткова оплата через UI → PARTIALLY_PAID, «Оплатити» лишається доступним', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const inv = await createSentInvoice(page, token, await getClientId(page, token), 200);

    const modal = await openInvoicePayModal(page, inv.number);
    await modal.getByLabel('Метод оплати').selectOption('cash');
    await modal.getByLabel(/^Каса/).selectOption(payRegisterId);
    await modal.getByLabel('Сума, ₴').fill('50');
    await modal.getByRole('button', { name: 'Підтвердити оплату' }).click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    await expect
      .poll(
        async () => {
          const u = await getInvoice(page, token, inv.id);
          return `${u.status}:${u.paidAmount}`;
        },
        { timeout: 10_000, message: 'часткова оплата → PARTIALLY_PAID, paid=50' },
      )
      .toBe('PARTIALLY_PAID:50');
    await expect(page.getByRole('button', { name: 'Оплатити' }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  // guards: BR-PAY-019
  test('оплата рахунку готівкою потрапляє в касу: рядок в історії, залишок виріс', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const before = await registerBalance(page, token, payRegisterId);
    const inv = await createSentInvoice(page, token, await getClientId(page, token), 120);

    const modal = await openInvoicePayModal(page, inv.number);
    await modal.getByLabel('Метод оплати').selectOption('cash');
    await modal.getByLabel(/^Каса/).selectOption(payRegisterId);
    const posted = page.waitForResponse(
      r => r.request().method() === 'POST' && /\/payments$/.test(new URL(r.url()).pathname),
    );
    await modal.getByRole('button', { name: 'Підтвердити оплату' }).click();
    const response = await posted;
    expect(response.status(), 'оплату прийнято').toBe(201);
    const sent = response.request().postDataJSON() as Record<string, unknown>;
    expect(sent).toMatchObject({
      method: 'cash',
      sourceType: 'CASH_REGISTER',
      cashRegisterId: payRegisterId,
    });
    const paymentId = ((await response.json()) as { id: string }).id;
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // Рядок каси належить саме цій оплаті, залишок каси виріс на її суму.
    const rows = await paymentRows(page, token, payRegisterId, paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'SALE_PAYMENT' });
    expect(Number(rows[0].amount)).toBeCloseTo(120, 2);
    expect((await registerBalance(page, token, payRegisterId)) - before).toBeCloseTo(120, 2);

    // І в історії каси на сторінці «Каса».
    await page.goto('/cash');
    await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
    await page.locator('select').first().selectOption(payRegisterId);
    // У цій касі вже є оплати попередніх тестів — шукаємо рядок саме на 120,00.
    const row = page
      .locator('table tbody tr')
      .filter({ hasText: 'Оплата контрагента' })
      .filter({ hasText: '120,00' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
  });

  // guards: BR-PAY-019
  test('готівка без каси: оплатити не можна, доки касу не обрано', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const methods = await apiCall<{ code: string; defaultSourceType: string | null }[]>(
      page,
      token,
      'GET',
      '/payment-methods',
    );
    test.skip(
      methods.body.some(m => m.code === 'cash' && m.defaultSourceType === 'CASH_REGISTER'),
      'У «Готівки» цієї організації задано касу за замовчуванням — поле не буде порожнім',
    );
    const inv = await createSentInvoice(page, token, await getClientId(page, token), 60);

    let posted = false;
    page.on('request', r => {
      if (r.method() === 'POST' && /\/payments$/.test(new URL(r.url()).pathname)) posted = true;
    });
    const modal = await openInvoicePayModal(page, inv.number);
    await modal.getByLabel('Метод оплати').selectOption('cash');
    const cash = modal.getByLabel(/^Каса/);
    await expect(cash).toHaveValue('');
    const confirm = modal.getByRole('button', { name: 'Підтвердити оплату' });
    await expect(confirm).toBeDisabled();
    await expect(modal.getByText('Для оплати готівкою оберіть касу')).toBeVisible();

    await cash.selectOption(payRegisterId);
    await expect(confirm).toBeEnabled();
    await expect(modal.getByText('Для оплати готівкою оберіть касу')).toHaveCount(0);
    expect(posted, 'без каси запит не мав піти').toBe(false);
    await page.keyboard.press('Escape');
  });

  // guards: BR-PAY-019
  test('спосіб із касою за замовчуванням: поле заповнене нею, оплата лягає в цю касу', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const before = await registerBalance(page, token, payRegisterId);
    const inv = await createSentInvoice(page, token, await getClientId(page, token), 75);

    const modal = await openInvoicePayModal(page, inv.number);
    await modal.getByLabel('Метод оплати').selectOption(payMethodCode);
    await expect(modal.getByLabel(/^Каса/)).toHaveValue(payRegisterId);
    const posted = page.waitForResponse(
      r => r.request().method() === 'POST' && /\/payments$/.test(new URL(r.url()).pathname),
    );
    await modal.getByRole('button', { name: 'Підтвердити оплату' }).click();
    const response = await posted;
    expect(response.status(), 'оплату прийнято').toBe(201);
    const paymentId = ((await response.json()) as { id: string }).id;
    await expect(modal).toBeHidden({ timeout: 10_000 });

    expect(await paymentRows(page, token, payRegisterId, paymentId)).toHaveLength(1);
    expect((await registerBalance(page, token, payRegisterId)) - before).toBeCloseTo(75, 2);
  });

  test('вибір методу monobank_qr → футер модалки міняється на «Показати QR»', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const methods = await apiCall<Array<{ code: string; isActive: boolean }>>(
      page,
      token,
      'GET',
      '/payment-methods',
    );
    const hasQr = methods.body.some(m => m.code === 'monobank_qr' && m.isActive);
    test.skip(!hasQr, 'Метод monobank_qr не активований у цій організації — QR-гілка недоступна');

    const inv = await createSentInvoice(page, token, await getClientId(page, token), 100);
    const gateway = await apiCall<{ provider: string | null }>(
      page,
      token,
      'GET',
      `/online-payments/gateway?invoiceId=${inv.id}`,
    );
    const modal = await openInvoicePayModal(page, inv.number);
    await expect(modal.getByRole('button', { name: 'Підтвердити оплату' })).toBeVisible();
    // BR-PAY-033: QR-спосіб — лише підключеного у філії шлюзу; PrivatBank QR — ніколи.
    await expect(
      modal.getByLabel('Метод оплати').locator('option[value="privat24_qr"]'),
    ).toHaveCount(0);
    if (gateway.body.provider !== 'monobank') {
      await expect(
        modal.getByLabel('Метод оплати').locator('option[value="monobank_qr"]'),
      ).toHaveCount(0);
      await page.keyboard.press('Escape');
      return;
    }
    await modal.getByLabel('Метод оплати').selectOption('monobank_qr');
    await expect(modal.getByRole('button', { name: 'Показати QR' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(modal.getByRole('button', { name: 'Підтвердити оплату' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  // ─── Оплата контрагента в касі ──────────────────────────────────────────────
  test.describe('каса: «Оплата контрагента»', () => {
    const stamp = Date.now();
    // «000» на початку: список кас віддає перші 200 за назвою, а в dev-базі сотні старих
    // «E2E Каса N» — без цього нова каса не потрапляла б у селектор картки.
    const registerName = `000 E2E Каса оплат ${stamp}`;
    const clientName = `E2E Клієнт каси ${stamp}`;
    let registerId = '';
    let clientId = '';

    test.beforeAll(async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
      const p = await ctx.newPage();
      await p.goto('/cash');
      const token = await getToken(p);
      registerId = await createPlainRegister(p, token, registerName);
      clientId = await createCounterparty(p, token, 'CLIENT', clientName);
      await ctx.close();
    });

    test.afterAll(async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
      const p = await ctx.newPage();
      await p.goto('/cash');
      const token = await getToken(p);
      if (registerId) await deleteRegister(p, token, registerId);
      // Контрагент з оплатою може не видалятись (є рух по розрахунках) — відмову ігноруємо.
      if (clientId) await apiCall(p, token, 'DELETE', `/counterparties/${clientId}`);
      await ctx.close();
    });

    test('привід показує поле контрагента; без контрагента запит не йде', async ({ page }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const dialog = await openCashCard(page, registerId, 'Внести');

      // Загальне внесення контрагента не має.
      await expect(dialog.locator('label').filter({ hasText: /^Контрагент/ })).toHaveCount(0);

      await dialog.getByLabel('Привід').selectOption('SALE_PAYMENT');
      await expect(cardField(dialog, /^Контрагент/)).toBeVisible();
      // Підстава з'являється лише після вибору контрагента.
      await expect(dialog.locator('label').filter({ hasText: /підстава/ })).toHaveCount(0);

      let posted = false;
      page.on('request', r => {
        if (r.method() === 'POST' && r.url().includes('/operations')) posted = true;
      });
      await dialog.getByLabel(/^Сума/).fill('150');
      await dialog.getByRole('button', { name: 'Внести', exact: true }).click();
      await expect(dialog.getByText('Для цього приводу вкажіть контрагента')).toBeVisible();
      expect(posted, 'без контрагента запит не має піти').toBe(false);

      // Escape у пікері закриває лише пікер: картка з введеною сумою лишається (у jsdom не
      // відтворюється — слухачі Escape обох модалок стоять на document).
      await cardField(dialog, /^Контрагент/)
        .getByRole('button', { name: 'Обрати' })
        .click();
      const picker = page.getByRole('dialog', { name: 'Оберіть клієнта', exact: true });
      await expect(picker).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('Escape');
      await expect(picker).toBeHidden({ timeout: 10_000 });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel(/^Сума/)).toHaveValue('150');

      await pickInCard(page, dialog, /^Контрагент/, 'Оберіть клієнта', clientName);
      await expect(dialog.getByText('Для цього приводу вкажіть контрагента')).toHaveCount(0);
      await expect(cardField(dialog, /Наряд-підстава/)).toBeVisible();
    });

    test('поля картки йдуть за приводом: працівник для підзвіту, нічого зайвого для банку', async ({
      page,
    }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const dialog = await openCashCard(page, registerId, 'Внести');
      const reason = dialog.getByLabel('Привід');
      const labels = (re: RegExp) => dialog.locator('label').filter({ hasText: re });

      await reason.selectOption('ADVANCE_RETURN');
      await expect(labels(/^Працівник/)).toHaveCount(1);
      await expect(labels(/^Контрагент/)).toHaveCount(0);

      await reason.selectOption('BANK_WITHDRAWAL');
      await expect(labels(/^Працівник/)).toHaveCount(0);
      await expect(labels(/^Контрагент/)).toHaveCount(0);

      await reason.selectOption('SUPPLIER_REFUND_IN');
      await expect(labels(/^Контрагент/)).toHaveCount(1);
      // «Зарплату» вручну обрати не можна — її ставить лише відомість.
      await expect(reason.locator('option[value="PAYROLL"]')).toHaveCount(0);
    });

    // [контракт] каса створює оплату клієнта: борг контрагента змінюється, рядок історії несе
    // контрагента й стан фіскального чека.
    test('[контракт] оплата контрагента з каси: рух у розрахунках і рядок історії', async ({
      page,
    }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const token = await getToken(page);
      const before = await getBalance(page, token, clientId);

      const dialog = await openCashCard(page, registerId, 'Внести');
      await dialog.getByLabel('Привід').selectOption('SALE_PAYMENT');
      await dialog.getByLabel(/^Сума/).fill('350,50');
      await pickInCard(page, dialog, /^Контрагент/, 'Оберіть клієнта', clientName);

      const created = page.waitForResponse(
        r => r.request().method() === 'POST' && r.url().includes(`/${registerId}/operations`),
      );
      await dialog.getByRole('button', { name: 'Внести', exact: true }).click();
      expect((await created).status(), 'операцію прийнято').toBe(201);
      await expect(dialog).toBeHidden({ timeout: 10_000 });

      // Рядок історії: привід, контрагент, позначка чека.
      const row = historyRow(page, clientName);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText('Оплата контрагента');
      await expect(row).toContainText('350,50');
      await expect(row.getByText(/^Чек:/)).toBeVisible();

      // Оплата клієнта рухає розрахунки рівно на суму операції.
      await expect
        .poll(async () => Math.abs((await getBalance(page, token, clientId)) - before), {
          timeout: 10_000,
          message: 'баланс клієнта має змінитись на суму оплати',
        })
        .toBeCloseTo(350.5, 2);

      // Каса створила саме оплату клієнта (а не «голий» рух готівки).
      const payments = await apiCall<{ items: { amount: number; method: string }[] }>(
        page,
        token,
        'GET',
        `/payments?counterpartyId=${clientId}&limit=10`,
      );
      expect(payments.body.items.map(p => Number(p.amount))).toContain(350.5);
    });

    // [контракт] подвійне підтвердження не створює двох оплат (Idempotency-Key картки).
    test('[контракт] повтор того самого запиту каси не створює другої оплати', async ({ page }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const token = await getToken(page);
      const key = `e2e-${Date.now()}`;
      const send = () =>
        page.evaluate(
          async ({ token, API, registerId, clientId, key }) => {
            const r = await fetch(`${API}/cash-registers/${registerId}/operations`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': key,
              },
              body: JSON.stringify({
                direction: 'IN',
                reason: 'SALE_PAYMENT',
                amount: 77.77,
                counterpartyId: clientId,
              }),
            });
            return r.status;
          },
          { token, API, registerId, clientId, key },
        );
      expect(await send()).toBe(201);
      expect(await send(), 'повтор віддає ту саму відповідь').toBe(201);
      const payments = await apiCall<{ items: { amount: number }[] }>(
        page,
        token,
        'GET',
        `/payments?counterpartyId=${clientId}&limit=50`,
      );
      expect(payments.body.items.filter(p => Number(p.amount) === 77.77)).toHaveLength(1);
    });
  });

  // ─── Каса: зміна на фіскальній касі (offline-first guard) ────────────────────
  test.describe('каса: фіскальна зміна', () => {
    let fiscalRegisterId = '';
    let fiscalRegisterCreated = false;

    test.beforeAll(async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
      const p = await ctx.newPage();
      await p.goto('/cash');
      const token = await getToken(p);
      // Спершу шукаємо готову фіскальну касу у списку, який рендерить UI.
      const list = await apiCall<{ items: { id: string; isFiscal: boolean }[] }>(
        p,
        token,
        'GET',
        '/cash-registers',
      );
      const existing = list.body.items.find(r => r.isFiscal);
      if (existing) {
        fiscalRegisterId = existing.id;
      } else {
        const [cur, br] = await Promise.all([
          apiCall<{ items: { id: string }[] }>(p, token, 'GET', '/currencies'),
          apiCall<{ items: { id: string }[] }>(p, token, 'GET', '/branches'),
        ]);
        const created = await apiCall<{ id: string }>(p, token, 'POST', '/cash-registers', {
          name: `E2E Фіскальна ${Date.now()}`,
          currencyId: (cur.body.items ?? (cur.body as unknown as { id: string }[]))[0]?.id,
          branchId: (br.body.items ?? (br.body as unknown as { id: string }[]))[0]?.id,
          isFiscal: true,
        });
        fiscalRegisterId = created.body.id;
        fiscalRegisterCreated = true;
      }
      await ctx.close();
    });

    test.afterAll(async ({ browser }) => {
      // Прибираємо лише те, що самі створили (наявну касу не чіпаємо).
      if (!fiscalRegisterId || !fiscalRegisterCreated) return;
      const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
      const p = await ctx.newPage();
      await p.goto('/cash');
      await deleteRegister(p, await getToken(p), fiscalRegisterId);
      await ctx.close();
    });

    test('фіскальна каса без зміни → «Зміну закрито» + «Відкрити зміну», операції заблоковані', async ({
      page,
    }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const select = page.locator('select').first();
      await expect(select).toBeVisible({ timeout: 15_000 });
      await select.selectOption(fiscalRegisterId);

      await expect(page.getByText('Зміну закрито')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /Відкрити зміну/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Внести', exact: true })).toBeDisabled();
    });

    test('«Відкрити зміну» без налаштованого ПРРО → детермінований guard-error', async ({
      page,
    }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const select = page.locator('select').first();
      await expect(select).toBeVisible({ timeout: 15_000 });
      await select.selectOption(fiscalRegisterId);

      const openBtn = page.getByRole('button', { name: /Відкрити зміну/ });
      await expect(openBtn).toBeEnabled({ timeout: 15_000 });
      await openBtn.click();
      // Без налаштованого Checkbox відкриття зміни неможливе — реальний бізнес-guard.
      await expect(page.getByText(/Фіскалізацію не налаштовано/).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('Зміну закрито')).toBeVisible();
    });
  });
});
