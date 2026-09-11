import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000';

// Широкий діапазон — гарантовано покриває всі seed-наряди із завершеними роботами.
const FROM = '2020-01-01';
const TO = '2030-12-31';

async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
  expect(t, 'E2E-hatch має покласти токен у sessionStorage').toBeTruthy();
  return t as string;
}

// Прибирання створених у тесті періодів (усі, окрім PAID — ті не видаляються за бізнес-правилом).
async function cleanupTestPeriods(page: Page): Promise<void> {
  const t = await token(page);
  await page.evaluate(
    async ({ API, t }) => {
      const list = (await (
        await fetch(`${API}/api/payroll/periods`, { headers: { Authorization: `Bearer ${t}` } })
      ).json()) as { id: string; status: string; note?: string | null }[];
      for (const p of list) {
        if (p.status !== 'PAID' && p.note?.startsWith('[e2e]')) {
          await fetch(`${API}/api/payroll/periods/${p.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${t}` },
          });
        }
      }
    },
    { API, t },
  );
}

test.describe('Зарплата — сторінка', () => {
  test('сторінка завантажується із заголовком «Зарплата»', async ({ page }) => {
    await page.goto('/payroll');
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 20_000 });
    // Немає Next.js error-overlay.
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('обидві панелі присутні: «Розрахунок за період» + «Зарплатні періоди»', async ({ page }) => {
    await page.goto('/payroll');
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Розрахунок за період')).toBeVisible();
    await expect(page.getByText('Зарплатні періоди')).toBeVisible();
  });

  test('пункт меню «Зарплата» веде на /payroll', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    // Sidebar nav link по тексту (nav/aside), а не за href — щоб не зловити KPI-картку у main
    // (той самий патерн, що dashboard.spec.ts).
    const navLink = page.locator('nav a, aside a').filter({ hasText: 'Зарплата' }).first();
    await expect(navLink).toBeVisible({ timeout: 20_000 });
    await Promise.all([page.waitForURL(/\/payroll/, { timeout: 15_000 }), navLink.click()]);
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Зарплата — розрахунок за період (preview)', () => {
  test('«Розрахувати» показує таблицю нарахувань або empty-state', async ({ page }) => {
    await page.goto('/payroll');
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 20_000 });

    // Виставляємо широкий діапазон дат (2 date-input у панелі розрахунку).
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill(FROM);
    await dateInputs.nth(1).fill(TO);

    await page.getByRole('button', { name: 'Розрахувати' }).first().click();

    // Після розрахунку: або таблиця з колонкою «Нараховано», або empty-state «Немає нарахувань».
    await expect(
      page.locator('th:has-text("Нараховано")').or(page.getByText('Немає нарахувань')).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('Зарплата — життєвий цикл періоду (FSM)', () => {
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
    await page.goto('/payroll');
    await cleanupTestPeriods(page).catch(() => {});
    await page.close();
  });

  test('create(DRAFT) → compute(COMPUTED) → pay(PAID) через UI-кнопки', async ({ page }) => {
    await page.goto('/payroll');
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 20_000 });
    const t = await token(page);

    // Створюємо період через API (детермінований note-маркер для пошуку рядка й cleanup).
    const note = `[e2e] ${Date.now()}`;
    const period = await page.evaluate(
      async ({ API, t, FROM, TO, note }) => {
        const r = await fetch(`${API}/api/payroll/periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ periodStart: FROM, periodEnd: TO, note }),
        });
        return (await r.json()) as { id: string; status: string };
      },
      { API, t, FROM, TO, note },
    );
    expect(period.id, 'Період створено').toBeTruthy();
    expect(period.status).toBe('DRAFT');

    // Перезавантажуємо — рядок ЦЬОГО періоду за стабільним data-testid (keyed by id).
    // Усі статус-перевірки скоупимо на periodRow (не page-global), бо у списку можуть бути інші
    // [e2e]-періоди — інакше .first() дає false-positive до реального переходу цього рядка.
    await page.reload();
    const periodRow = page.getByTestId(`payroll-period-${period.id}`);
    await expect(periodRow).toBeVisible({ timeout: 20_000 });
    await expect(periodRow.getByText('Чернетка')).toBeVisible();

    // Compute через UI — кнопка «Розрахувати» у рядку періоду.
    await periodRow.getByRole('button', { name: 'Розрахувати' }).click();
    await expect(periodRow.getByText('Розраховано')).toBeVisible({ timeout: 20_000 });

    // Pay через UI — кнопка «Виплатити» у рядку відкриває модалку «Провести виплату»
    // (вибір каси + футер-кнопка «Виплатити … ₴»). Це НЕ простий ConfirmDialog «Так» —
    // pay-flow отримав власну модалку з опційним cash-out (page.tsx: payPeriod modal).
    await periodRow.getByRole('button', { name: 'Виплатити' }).click();
    const payModal = page.locator('[role="dialog"]').filter({ hasText: 'Провести виплату' });
    await expect(payModal).toBeVisible({ timeout: 10_000 });
    // Каса за замовчуванням «— без каси (лише фіксація) —» → уникаємо вимоги відкритої
    // фіскальної зміни; перевіряємо чистий FSM-перехід COMPUTED → PAID.
    await payModal.getByRole('button', { name: /^Виплатити/ }).click();
    // Чекаємо перехід САМЕ цього рядка у «Виплачено» (scoped) — гарантує, що API вже flip-нув статус.
    await expect(periodRow.getByText('Виплачено')).toBeVisible({ timeout: 20_000 });

    // Верифікація через API: статус PAID, totalPaid > 0 або = accrued.
    const verify = await page.evaluate(
      async ({ API, t, id }) => {
        const r = await fetch(`${API}/api/payroll/periods/${id}`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        return (await r.json()) as { status: string; totalAccrued: number; totalPaid: number };
      },
      { API, t, id: period.id },
    );
    expect(verify.status).toBe('PAID');
    expect(verify.totalPaid).toBe(verify.totalAccrued);
  });

  test('FSM-guard: повторний compute вже-розрахованого періоду → 400 (API)', async ({ page }) => {
    await page.goto('/payroll');
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 20_000 });
    const t = await token(page);

    const res = await page.evaluate(
      async ({ API, t, FROM, TO }) => {
        const create = await fetch(`${API}/api/payroll/periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ periodStart: FROM, periodEnd: TO, note: '[e2e] guard' }),
        });
        const p = (await create.json()) as { id: string };
        const c1 = await fetch(`${API}/api/payroll/periods/${p.id}/compute`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t}` },
        });
        const c2 = await fetch(`${API}/api/payroll/periods/${p.id}/compute`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t}` },
        });
        // Прибираємо (COMPUTED не видаляється — лишаємо; але позначено [e2e]).
        return { first: c1.status, second: c2.status };
      },
      { API, t, FROM, TO },
    );
    expect([200, 201]).toContain(res.first); // перший compute успішний (POST → 201 default)
    expect(res.second).toBe(400); // повторний compute заборонено (не-DRAFT)
  });
});
