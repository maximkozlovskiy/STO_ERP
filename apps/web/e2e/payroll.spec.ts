import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000';

// Широкий діапазон — покриває всі завершені наряди, включно зі щойно створеним у тесті.
const FROM = '2020-01-01';
const TO = '2030-12-31';
// Порожнє вікно в далекому майбутньому — для тестів, яким наряди не потрібні. Наряд входить лише
// в одну відомість (BR-PAYR-015), тож розрахована або виплачена відомість на широкий діапазон
// забирає всі завершені наряди бази: наступний тест (і людина у dev-базі) їх уже не побачить.
const EMPTY_FROM = '2099-01-01';
const EMPTY_TO = '2099-01-31';

async function token(page: Page): Promise<string> {
  // poll, а не одноразове читання: токен у sessionStorage кладе AuthProvider під час гідрації,
  // а `page.goto` повертається раніше. У afterAll (без очікування заголовка) одноразове читання
  // давало null, помилку ковтав `.catch`, і прибирання періодів мовчки не виконувалось.
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('sto_access_token')), {
      timeout: 20_000,
      message: 'E2E-hatch має покласти токен у sessionStorage',
    })
    .toBeTruthy();
  return (await page.evaluate(() => sessionStorage.getItem('sto_access_token'))) as string;
}

// Прибирання створених у тесті періодів (усі, окрім PAID — ті не видаляються за бізнес-правилом).
async function cleanupTestPeriods(page: Page): Promise<void> {
  const t = await token(page);
  await page.evaluate(
    async ({ API, t }) => {
      // GET /payroll/periods тепер paginated — беремо великий limit, щоб покрити всі [e2e]-періоди.
      const res = (await (
        await fetch(`${API}/api/v1/payroll/periods?page=1&limit=200`, {
          headers: { Authorization: `Bearer ${t}` },
        })
      ).json()) as { items: { id: string; status: string; note?: string | null }[] };
      for (const p of res.items ?? []) {
        if (p.status !== 'PAID' && p.note?.startsWith('[e2e]')) {
          await fetch(`${API}/api/v1/payroll/periods/${p.id}`, {
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
    // Вікно — ПОРОЖНЄ майбутнє (EMPTY_FROM…EMPTY_TO): виплачену відомість видалити не можна, а
    // наряд входить лише в одну відомість (BR-PAYR-015) — широкий діапазон назавжди забирав би
    // всі завершені наряди бази у тестову виплату.
    const note = `[e2e] ${Date.now()}`;
    const period = await page.evaluate(
      async ({ API, t, FROM, TO, note }) => {
        const r = await fetch(`${API}/api/v1/payroll/periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ periodStart: FROM, periodEnd: TO, note }),
        });
        return (await r.json()) as { id: string; status: string };
      },
      { API, t, FROM: EMPTY_FROM, TO: EMPTY_TO, note },
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

    // Верифікація через API: статус PAID, виплачено рівно нараховане (у порожньому вікні це
    // оклади окладників, якщо вони є, або нуль).
    const verify = await page.evaluate(
      async ({ API, t, id }) => {
        const r = await fetch(`${API}/api/v1/payroll/periods/${id}`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        return (await r.json()) as { status: string; totalAccrued: number; totalPaid: number };
      },
      { API, t, id: period.id },
    );
    expect(verify.status).toBe('PAID');
    expect(verify.totalPaid).toBe(verify.totalAccrued);
  });

  test('drill-down: розкриття співробітника показує розшифровку по нарядах + tfoot «Разом база»', async ({
    page,
  }) => {
    await page.goto('/payroll');
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 20_000 });
    const t = await token(page);

    // Власний завершений наряд: наряд входить лише в ОДНУ відомість (BR-PAYR-015), тож «широкий
    // діапазон гарантує наряди» більше не працює — усі старі наряди вже чиїсь. Свіжий наряд ще
    // нічий, і саме він дасть розшифровку. Наприкінці відомість видаляємо (звільняє наряди),
    // а наряд скасовуємо й видаляємо.
    const seeded = await page.evaluate(
      async ({ API, t }) => {
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` };
        const get = async (path: string) =>
          (await fetch(`${API}/api/v1/${path}`, { headers })).json() as Promise<unknown>;
        const first = (r: unknown): { id: string } | undefined =>
          (Array.isArray(r) ? r : ((r as { items?: unknown[] }).items ?? []))[0] as
            { id: string } | undefined;
        const [branch, vehicle, client, work, employee] = await Promise.all([
          get('branches').then(first),
          get('vehicles?limit=1').then(first),
          get('counterparties?type=CLIENT&limit=1').then(first),
          get('works?limit=1').then(first),
          get('employees?limit=1').then(first),
        ]);
        if (!branch || !vehicle || !client || !work || !employee) return { error: 'seed' };
        const post = async (path: string, body: unknown) => {
          const r = await fetch(`${API}/api/v1/${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
          return { ok: r.ok, status: r.status, body: (await r.json()) as { id: string } };
        };
        const wo = await post('work-orders', {
          branchId: branch.id,
          vehicleId: vehicle.id,
          counterpartyId: client.id,
        });
        if (!wo.ok) return { error: `work-order ${wo.status}` };
        const line = await post(`work-orders/${wo.body.id}/lines`, {
          workId: work.id,
          employeeId: employee.id,
        });
        if (!line.ok) return { error: `line ${line.status}`, workOrderId: wo.body.id };
        for (const status of ['ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'COMPLETED']) {
          const tr = await post(`work-orders/${wo.body.id}/transition`, { status });
          if (!tr.ok) return { error: `${status} ${tr.status}`, workOrderId: wo.body.id };
        }
        return { workOrderId: wo.body.id };
      },
      { API, t },
    );
    expect(seeded.error, 'завершений наряд для розшифровки створено').toBeUndefined();

    // Створюємо+рахуємо період через API (широкий діапазон покриває сьогоднішній наряд).
    const note = `[e2e] drill ${Date.now()}`;
    const period = await page.evaluate(
      async ({ API, t, FROM, TO, note }) => {
        const c = await fetch(`${API}/api/v1/payroll/periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ periodStart: FROM, periodEnd: TO, note }),
        });
        const p = (await c.json()) as { id: string };
        await fetch(`${API}/api/v1/payroll/periods/${p.id}/compute`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t}` },
        });
        // Читаємо деталь — чи є хоч один рядок із розшифровкою (workOrders).
        const d = (await (
          await fetch(`${API}/api/v1/payroll/periods/${p.id}`, {
            headers: { Authorization: `Bearer ${t}` },
          })
        ).json()) as { lines?: { workOrders?: unknown[] }[] };
        const hasWo = (d.lines ?? []).some(l => (l.workOrders ?? []).length > 0);
        return { id: p.id, hasWo };
      },
      { API, t, FROM, TO, note },
    );

    try {
      expect(period.id).toBeTruthy();
      expect(period.hasWo, 'у періоді має бути хоча б один рядок із розшифровкою').toBe(true);

      await page.reload();
      const periodRow = page.getByTestId(`payroll-period-${period.id}`);
      await expect(periodRow).toBeVisible({ timeout: 20_000 });
      await expect(periodRow.getByText('Розраховано')).toBeVisible({ timeout: 20_000 });

      // Розгортаємо період.
      await periodRow.getByRole('button', { name: 'Розгорнути' }).click();
      // Перший рядок співробітника → кнопка «Показати наряди».
      const showWo = periodRow.getByRole('button', { name: 'Показати наряди' }).first();
      await expect(showWo).toBeVisible({ timeout: 15_000 });
      await showWo.click();

      // Розшифровка розкрита: заголовок таблиці + tfoot «Разом база».
      await expect(periodRow.getByText('Розшифровка по нарядах')).toBeVisible({ timeout: 15_000 });
      await expect(periodRow.getByText('Разом база')).toBeVisible();
      // Хоча б один клікабельний № наряду веде на картку наряду.
      const woLink = periodRow.locator('a[href^="/work-orders/"]').first();
      await expect(woLink).toBeVisible();
    } finally {
      // Розрахована відомість тримає наряди (BR-PAYR-015) — видаляємо одразу, не чекаючи afterAll.
      await page.evaluate(
        async ({ API, t, periodId, workOrderId }) => {
          const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` };
          if (periodId) {
            await fetch(`${API}/api/v1/payroll/periods/${periodId}`, { method: 'DELETE', headers });
          }
          if (workOrderId) {
            // COMPLETED → CANCELLED сторнує борг (CREDIT_NOTE); скасований наряд видаляється.
            await fetch(`${API}/api/v1/work-orders/${workOrderId}/transition`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ status: 'CANCELLED' }),
            });
            await fetch(`${API}/api/v1/work-orders/${workOrderId}`, { method: 'DELETE', headers });
          }
        },
        { API, t, periodId: period.id, workOrderId: seeded.workOrderId },
      );
    }
  });

  test('FSM-guard: повторний compute вже-розрахованого періоду → 400 (API)', async ({ page }) => {
    await page.goto('/payroll');
    await expect(page.locator('h1:has-text("Зарплата")')).toBeVisible({ timeout: 20_000 });
    const t = await token(page);

    const res = await page.evaluate(
      async ({ API, t, FROM, TO }) => {
        const create = await fetch(`${API}/api/v1/payroll/periods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ periodStart: FROM, periodEnd: TO, note: '[e2e] guard' }),
        });
        const p = (await create.json()) as { id: string };
        const c1 = await fetch(`${API}/api/v1/payroll/periods/${p.id}/compute`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t}` },
        });
        const c2 = await fetch(`${API}/api/v1/payroll/periods/${p.id}/compute`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t}` },
        });
        // Розрахований період видаляється (заборонено лише PAID) — прибираємо за собою.
        const del = await fetch(`${API}/api/v1/payroll/periods/${p.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${t}` },
        });
        return { first: c1.status, second: c2.status, deleted: del.status };
      },
      // Порожнє вікно: guard-у наряди не потрібні, а широкий діапазон забрав би їх у цю відомість.
      { API, t, FROM: EMPTY_FROM, TO: EMPTY_TO },
    );
    expect([200, 201]).toContain(res.first); // перший compute успішний (POST → 201 default)
    expect(res.second).toBe(400); // повторний compute заборонено (не-DRAFT)
    expect(res.deleted).toBe(204);
  });
});
