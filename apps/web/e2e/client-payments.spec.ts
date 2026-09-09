import { test, expect } from '@playwright/test';
import { clearDateFilter } from './fixtures';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000/api';

/**
 * Client Payments — UI money-flow клієнтських платежів (T17 pre-prod).
 *
 * Backend вже покрито unit/contract-тестами. Цей spec покриває UI-рівень:
 *   - /payments — read-only список (append-only), фіскальні бейджі, фільтри;
 *   - /invoices → DetailPanel «Оплатити» → модалка «Реєстрація оплати» → POST /payments
 *     (реальний money-flow: рахунок SENT → оплата → PAID);
 *   - /payments/[id] — картка платежу + секція фіскального чека;
 *   - /cash — касова зміна (open/close), офлайн-first guard.
 *
 * ── Свідомо НЕ покрито (потребує зовнішнього гейтвею, недоступного E2E) ──
 *   - QR-оплата (monobank/LiqPay) повний roundtrip: клієнт сканує QR і платить на
 *     сторінці шлюзу — інтеракція поза межами термінала. Покрито ДЕТЕРМІНОВАНУ частину:
 *     перемикання методу на monobank_qr → футер модалки міняється на «Показати QR».
 *   - Фіскальний чек до статусу DONE: Checkbox (ПРРО) — зовнішній сервіс. Cash-платіж
 *     ВХОДИТЬ у фіскальну чергу зі статусом QUEUED (перевіряємо на response POST /payments —
 *     офлайн-first: черга є, повтори до 24 год), але без налаштованого Checkbox воркер одразу
 *     переводить його у SKIPPED («Пропущено») — це й перевіряємо в UI як settled-стан.
 *     DONE недосяжний без реального Checkbox.
 *   - Успішне відкриття касової зміни: /cash-shifts/open робить Checkbox-виклик і без
 *     налаштованих кредів віддає «Фіскалізацію не налаштовано». Це і перевіряємо як
 *     детерміновану офлайн-first поведінку (не обхід — реальний guard).
 *
 * Payments є APPEND-ONLY (немає DELETE /payments — фінансовий audit trail), тож
 * створені платежі лишаються в БД навмисно (як і supplier-payments CONFIRMED-записи).
 * Рахунки-чернетки чистимо; оплачені лишаються (PAID видалити не можна — by design).
 */

async function getToken(page: import('@playwright/test').Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

/** Клієнт для оплати. */
async function getClientId(page: import('@playwright/test').Page, token: string): Promise<string> {
  const id = await page.evaluate(
    async ({ token, API }) => {
      const r = await fetch(`${API}/counterparties?types=CLIENT,BOTH&limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      return (d.items ?? d)?.[0]?.id ?? null;
    },
    { token, API },
  );
  expect(id, 'seed має містити клієнта (CLIENT/BOTH)').toBeTruthy();
  return id as string;
}

/** Створює рахунок і транзитить у SENT (готовий до оплати). Повертає {id, number, amount}. */
async function createSentInvoice(
  page: import('@playwright/test').Page,
  token: string,
  counterpartyId: string,
  amount: number,
): Promise<{ id: string; number: string; amount: number }> {
  return page.evaluate(
    async ({ token, API, counterpartyId, amount }) => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const cr = await fetch(`${API}/invoices`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ counterpartyId, amount }),
      });
      const inv = await cr.json();
      await fetch(`${API}/invoices/${inv.id}/transition`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ status: 'SENT' }),
      });
      return { id: inv.id, number: inv.number, amount };
    },
    { token, API, counterpartyId, amount },
  );
}

async function deleteInvoiceIfDraft(
  page: import('@playwright/test').Page,
  token: string,
  id: string,
) {
  await page.evaluate(
    async ({ token, API, id }) => {
      await fetch(`${API}/invoices/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    },
    { token, API, id },
  );
}

async function getInvoice(page: import('@playwright/test').Page, token: string, id: string) {
  return page.evaluate(
    async ({ token, API, id }) => {
      const r = await fetch(`${API}/invoices/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return r.json();
    },
    { token, API, id },
  );
}

test.describe('Оплати клієнтів (money-flow)', () => {
  // ─── Список ────────────────────────────────────────────────────────────────
  test('сторінка /payments рендериться: заголовок + таблиця/empty + фіскальна колонка', async ({
    page,
  }) => {
    await page.goto('/payments');
    await expect(page.locator('h1:has-text("Оплати клієнтів")')).toBeVisible({ timeout: 20_000 });

    // Або таблиця з колонкою «Чек (ПРРО)», або коректний empty-state.
    const table = page.locator('table');
    const empty = page.getByText('Платежів не знайдено');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 20_000 });

    if (await table.isVisible().catch(() => false)) {
      // Колонки money-flow таблиці.
      await expect(page.locator('th:has-text("Контрагент")')).toBeVisible();
      await expect(page.locator('th:has-text("Сума")')).toBeVisible();
      await expect(page.locator('th:has-text("Чек (ПРРО)")')).toBeVisible();
    }
  });

  test('фільтри «Метод» і «Фіскальний статус» присутні з коректними опціями', async ({ page }) => {
    await page.goto('/payments');
    await expect(page.locator('h1:has-text("Оплати клієнтів")')).toBeVisible({ timeout: 20_000 });

    // Фільтр фіскального статусу має 4 enum-опції + «Без фіскалізації».
    const fiscalSelect = page.getByLabel('Фіскальний статус');
    await expect(fiscalSelect).toBeVisible({ timeout: 10_000 });
    for (const label of ['У черзі', 'Пробито', 'Помилка', 'Пропущено', 'Без фіскалізації']) {
      await expect(fiscalSelect.locator(`option:has-text("${label}")`)).toHaveCount(1);
    }
    await expect(page.getByLabel('Метод')).toBeVisible();
  });

  // ─── ГОЛОВНИЙ money-flow: оплата рахунку через UI ───────────────────────────
  test('оплата рахунку через UI: SENT → DetailPanel «Оплатити» → cash → рахунок PAID', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const clientId = await getClientId(page, token);
    const inv = await createSentInvoice(page, token, clientId, 100);
    expect(inv.id).toBeTruthy();

    // Відкрити список, знайти рахунок (invoices за замовч. фільтрує по kyivToday → чистимо дату
    // тільки якщо не знайшли одразу; свіжий рахунок має сьогоднішню дату, тож має бути видимим).
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const searchInput = page.locator('input[placeholder*="Пошук"]').first();
    await searchInput.fill(inv.number);
    let row = page.locator(`table tbody tr:has-text("${inv.number}")`).first();
    if (!(await row.isVisible({ timeout: 5_000 }).catch(() => false))) {
      await clearDateFilter(page);
      await searchInput.fill(inv.number);
      row = page.locator(`table tbody tr:has-text("${inv.number}")`).first();
    }
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Клік по рядку відкриває edit-модалку; «Оплатити» живе у DetailPanel (олівець «Відкрити
    // деталі»). Наводимо hover → клік олівця → DetailPanel з кнопкою «Оплатити».
    await row.hover();
    await row.getByRole('button', { name: 'Відкрити деталі' }).click();

    // DetailPanel відкрився (заголовок = номер рахунку). SENT → transition PAID → кнопка «Оплатити».
    const payBtn = page.getByRole('button', { name: 'Оплатити' }).first();
    await expect(payBtn).toBeVisible({ timeout: 15_000 });
    await payBtn.click();

    // Модалка реєстрації оплати.
    const modal = page
      .locator('[role="dialog"]')
      .filter({ hasText: `Реєстрація оплати по рахунку ${inv.number}` })
      .first();
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByText('Залишок до сплати:')).toBeVisible();

    // Метод «Готівка» (cash → requiresFiscal). Порожня сума = оплата залишку повністю.
    await modal.getByLabel('Метод оплати').selectOption('cash');
    await modal.getByRole('button', { name: 'Підтвердити оплату' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Реальний money-flow: POST /payments провів рахунок у PAID (повна оплата).
    await expect
      .poll(async () => (await getInvoice(page, token, inv.id)).status, {
        timeout: 10_000,
        message: 'повна оплата має провести рахунок у PAID',
      })
      .toBe('PAID');

    const paid = await getInvoice(page, token, inv.id);
    expect(paid.paidAmount, 'paidAmount = сума рахунку').toBeCloseTo(100, 2);
    // PAID рахунок видалити не можна (audit trail) — лишаємо навмисно.
  });

  test('часткова оплата через UI → рахунок PARTIALLY_PAID, «Оплатити» лишається доступним', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const clientId = await getClientId(page, token);
    const inv = await createSentInvoice(page, token, clientId, 200);

    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const searchInput = page.locator('input[placeholder*="Пошук"]').first();
    await searchInput.fill(inv.number);
    const row = page.locator(`table tbody tr:has-text("${inv.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.hover();
    await row.getByRole('button', { name: 'Відкрити деталі' }).click();

    const payBtn = page.getByRole('button', { name: 'Оплатити' }).first();
    await expect(payBtn).toBeVisible({ timeout: 15_000 });
    await payBtn.click();

    const modal = page
      .locator('[role="dialog"]')
      .filter({ hasText: `Реєстрація оплати по рахунку ${inv.number}` })
      .first();
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Часткова оплата: 50 з 200.
    await modal.getByLabel('Метод оплати').selectOption('cash');
    await modal.getByLabel('Сума, ₴').fill('50');
    await modal.getByRole('button', { name: 'Підтвердити оплату' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Backend CAS: часткова оплата → PARTIALLY_PAID (paid < amount).
    await expect
      .poll(
        async () => {
          const u = await getInvoice(page, token, inv.id);
          return `${u.status}:${u.paidAmount}`;
        },
        { timeout: 10_000, message: 'часткова оплата → PARTIALLY_PAID, paid=50' },
      )
      .toBe('PARTIALLY_PAID:50');

    // DetailPanel лишається на PARTIALLY_PAID → кнопка «Оплатити» доступна для дозакриття.
    await expect(page.getByRole('button', { name: 'Оплатити' }).first()).toBeVisible({
      timeout: 10_000,
    });
    // PARTIALLY_PAID рахунок видалити не можна — лишаємо.
  });

  // ─── QR-гілка (детермінована частина) ───────────────────────────────────────
  test('вибір методу monobank_qr → футер модалки міняється на «Показати QR»', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const clientId = await getClientId(page, token);

    // Переконатись що метод monobank_qr узагалі активний у цій орг — інакше option немає.
    const hasQr = await page.evaluate(
      async ({ token, API }) => {
        const r = await fetch(`${API}/payment-methods`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d: Array<{ code: string; isActive: boolean }> = await r.json();
        return d.some(m => m.code === 'monobank_qr' && m.isActive);
      },
      { token, API },
    );
    test.skip(!hasQr, 'Метод monobank_qr не активований у цій організації — QR-гілка недоступна');

    const inv = await createSentInvoice(page, token, clientId, 100);
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await page.locator('input[placeholder*="Пошук"]').first().fill(inv.number);
    const row = page.locator(`table tbody tr:has-text("${inv.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.hover();
    await row.getByRole('button', { name: 'Відкрити деталі' }).click();
    await page.getByRole('button', { name: 'Оплатити' }).first().click();

    const modal = page
      .locator('[role="dialog"]')
      .filter({ hasText: `Реєстрація оплати по рахунку ${inv.number}` })
      .first();
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Дефолт — «Підтвердити оплату». Перемикання на QR → футер стає «Показати QR».
    await expect(modal.getByRole('button', { name: 'Підтвердити оплату' })).toBeVisible();
    await modal.getByLabel('Метод оплати').selectOption('monobank_qr');
    await expect(modal.getByRole('button', { name: 'Показати QR' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(modal.getByRole('button', { name: 'Підтвердити оплату' })).toHaveCount(0);

    // Далі — реальний QR-шлюз (клієнт сканує й платить на стороні монобанку): поза E2E.
    await page.keyboard.press('Escape');
    await deleteInvoiceIfDraft(page, token, inv.id); // рахунок лишився SENT/DRAFT → якщо DRAFT приберемо
  });

  // ─── Фіскальний бейдж у списку ──────────────────────────────────────────────
  test('cash-платіж входить у фіскальну чергу (QUEUED) і у /payments показує бейдж settled-стану', async ({
    page,
  }) => {
    await page.goto('/payments');
    await expect(page.locator('h1:has-text("Оплати клієнтів")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const clientId = await getClientId(page, token);
    const inv = await createSentInvoice(page, token, clientId, 100);

    // Оплата cash напряму через API (money-flow вже покрито UI-тестом вище; тут фокус на бейджі).
    const pay = await page.evaluate(
      async ({ token, API, clientId, invId }) => {
        const r = await fetch(`${API}/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            counterpartyId: clientId,
            invoiceId: invId,
            amount: 100,
            method: 'cash',
          }),
        });
        return r.json();
      },
      { token, API, clientId, invId: inv.id },
    );
    // Офлайн-first інваріант: cash (requiresFiscal) ВХОДИТЬ у фіскальну чергу зі статусом QUEUED.
    // Це assert на самому response POST /payments — гонки з воркером тут немає.
    expect(pay.fiscalStatus, 'cash-платіж ставиться у фіскальну чергу').toBe('QUEUED');

    // Воркер без налаштованого Checkbox переводить QUEUED → SKIPPED («Пропущено»). Це settled-стан
    // офлайн-first середовища. Дочекатись його через API (детерміновано), потім перевірити бейдж у UI.
    await expect
      .poll(
        async () => {
          const p = await page.evaluate(
            async ({ token, API, id }) => {
              const r = await fetch(`${API}/payments/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              return (await r.json()).fiscalStatus;
            },
            { token, API, id: pay.id },
          );
          return p;
        },
        { timeout: 15_000, message: 'без Checkbox воркер має перевести чек у SKIPPED' },
      )
      .toBe('SKIPPED');

    // Фільтр «Пропущено» → у таблиці рендериться бейдж «Пропущено».
    await page.goto('/payments');
    await expect(page.locator('h1:has-text("Оплати клієнтів")')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Фіскальний статус').selectOption('SKIPPED');
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('td:has-text("Пропущено")').first()).toBeVisible({ timeout: 15_000 });
    // PAID рахунок і платіж лишаються (audit trail).
  });

  // ─── Картка платежу ─────────────────────────────────────────────────────────
  test('картка /payments/[id] рендерить реквізити + секцію фіскального чека', async ({ page }) => {
    await page.goto('/payments');
    await expect(page.locator('h1:has-text("Оплати клієнтів")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const clientId = await getClientId(page, token);
    const inv = await createSentInvoice(page, token, clientId, 100);

    const pay = await page.evaluate(
      async ({ token, API, clientId, invId }) => {
        const r = await fetch(`${API}/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            counterpartyId: clientId,
            invoiceId: invId,
            amount: 100,
            method: 'cash',
            notes: 'E2E платіж-картка',
          }),
        });
        return r.json();
      },
      { token, API, clientId, invId: inv.id },
    );
    expect(pay.id).toBeTruthy();

    // Дочекатись settled-стану чека (SKIPPED) через API — QUEUED транзитний.
    await expect
      .poll(
        async () =>
          page.evaluate(
            async ({ token, API, id }) => {
              const r = await fetch(`${API}/payments/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              return (await r.json()).fiscalStatus;
            },
            { token, API, id: pay.id },
          ),
        { timeout: 15_000, message: 'чек має осісти у SKIPPED' },
      )
      .toBe('SKIPPED');

    await page.goto(`/payments/${pay.id}`);
    // Заголовок картки, реквізити, секція фіскального чека.
    await expect(page.getByText('До списку оплат')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Метод оплати').first()).toBeVisible();
    await expect(page.getByText('E2E платіж-картка')).toBeVisible();
    await expect(page.getByText('Фіскальний чек (ПРРО)')).toBeVisible();
    // Settled-бейдж «Пропущено» у секції чека (офлайн-first без Checkbox).
    await expect(page.getByText('Пропущено').first()).toBeVisible({ timeout: 10_000 });
  });

  // ─── Каса (offline-first guard) ─────────────────────────────────────────────
  test('/cash рендериться: закрита зміна + кнопка «Відкрити зміну»', async ({ page }) => {
    await page.goto('/cash');
    await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });

    // Немає відкритої зміни (cash-shifts/current = null) → стан «Зміну закрито».
    await expect(page.getByText('Зміну закрито')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Відкрити зміну/ })).toBeVisible();
  });

  test('«Відкрити зміну» без налаштованого ПРРО → детермінований guard-error', async ({ page }) => {
    await page.goto('/cash');
    await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });

    const openBtn = page.getByRole('button', { name: /Відкрити зміну/ });
    await expect(openBtn).toBeEnabled({ timeout: 15_000 });
    await openBtn.click();

    // Офлайн-first: без налаштованого Checkbox відкриття зміни неможливе — це РЕАЛЬНИЙ
    // бізнес-guard, а не обхід. Помилка має з'явитись (inline-банер або toast).
    await expect(page.getByText(/Фіскалізацію не налаштовано/).first()).toBeVisible({
      timeout: 15_000,
    });
    // Зміна лишається закритою (guard спрацював, стан не змінився).
    await expect(page.getByText('Зміну закрито')).toBeVisible();
  });
});
