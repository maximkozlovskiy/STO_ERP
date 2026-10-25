import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Постачальники API (docs/objects/supplier-connection.md, supplier-offer.md) — через браузер,
 * проти фейкових серверів постачальників `tools/supplier-fakes` (:4100, webServer Playwright /
 * крок CI). API має бути запущений з `SUPPLIER_API_DEV_ALLOWED_ORIGINS=http://127.0.0.1:4100`,
 * інакше адресу фейку не прийме політика URL (BR-SCON-005) — перший тест про це скаже.
 *
 *  1. «Налаштування → Постачальники API»: підключення AVD і UTR → «Зберегти і перевірити» OK,
 *     «Синхронізувати каталог» AVD;
 *  2. новий список купівлі й ручна позиція (інтерфейс) → «Пропозиції»: чипи підключень, вибір UTR;
 *  3. «Підібрати автоматично»: ручний вибір лишається без прапорця, з ним — «Дешево» бере AVD;
 *  4. «Створити замовлення» → картка → «Відправити в API» → «Оновити статус» → підтверджено;
 *  5. 429 і немає зв'язку: «Немає зв'язку — повтор о HH:MM», останні відомі пропозиції;
 *  6. скасування відправленого — підтвердження «скасуйте в кабінеті постачальника» (BR-SCON-014).
 *
 * Передумови через API (інтерфейс їх не дає в цьому сценарії): постачальники-контрагенти, бренд і
 * товар з артикулом каталогу фейків. Підключення, список, позиція, вибір, автопідбір і замовлення —
 * через інтерфейс. Прибирання — в afterAll.
 */

const FAKES = process.env.E2E_SUPPLIER_FAKES_URL ?? 'http://127.0.0.1:4100';
const uid = Date.now().toString().slice(-6);
const SUP_AVD = `000 E2E Постачальник AVD ${uid}`;
const SUP_UTR = `000 E2E Постачальник UTR ${uid}`;
const CONN_AVD = `000 E2E AVD ${uid}`;
const CONN_UTR = `000 E2E UTR ${uid}`;
const GOOD = `000 E2E Фільтр OC90 ${uid}`;
const LIST_NAME = `000 E2E API список ${uid}`;
// sku МУСИТЬ дорівнювати артикулу з каталогу фейків (`tools/supplier-fakes/providers/catalog.js`):
// пошук пропозицій шле `good.sku` як артикул (supplier-offers.service.ts:149) і матчить його
// `normalizeArticle` проти дзеркала синхронізованого каталогу. Унікальний `OC 90 ${uid}` нормується
// у `OC90<uid>` ≠ `OC90` → жодної пропозиції (регресія Stage 2 / Bug #966 fix — тест зеленів на
// CI 145, червонів із 146). Самоізоляція від 409 — не через унікальний sku, а прибиранням
// залишкового живого товару з цим sku перед створенням (див. нижче).
const ARTICLE = 'OC 90';
const BRAND = 'MAHLE';

const state: {
  token?: string;
  supAvdId?: string;
  supUtrId?: string;
  brandId?: string;
  brandCreated?: boolean;
  goodId?: string;
  goodName?: string;
  goodReused?: boolean;
  warehouse?: { id: string; name: string };
  listId?: string;
  connIds: string[];
  poIds: string[];
} = { connIds: [], poIds: [] };

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

async function fakes(path: string, body?: unknown) {
  const r = await fetch(`${FAKES}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(r.ok, `фейки постачальників ${path}`).toBeTruthy();
  return r.json() as Promise<unknown>;
}

interface ItemDto {
  id: string;
  status: string;
  quantity: number;
  supplierId: string | null;
  offerKey: string | null;
  offerChosenBy: string | null;
  purchaseOrderId: string | null;
}

async function listItems(page: Page): Promise<ItemDto[]> {
  const res = await api<{ items: ItemDto[] }>(
    page,
    'GET',
    `/purchase-list-items?listId=${state.listId}&limit=50`,
  );
  expect(res.status).toBe(200);
  return res.body.items;
}

async function openItems(page: Page) {
  const good = state.goodName ?? GOOD;
  await page.goto('/purchase-orders?tab=procurement&view=items');
  await page.getByLabel('Товар, артикул, код').fill(good);
  const rows = page.getByTestId('purchase-list-item-row').filter({ hasText: good });
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  return rows;
}

/** Підключення через «Додати підключення» — модалка закривається, коли перевірка пройшла. */
async function addConnection(
  page: Page,
  o: {
    provider: string;
    supplier: string;
    name: string;
    apiUrl: string;
    creds: Record<string, string>;
    warehouse: Record<string, string>;
  },
) {
  await page.getByRole('button', { name: 'Додати підключення' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Нове підключення' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Постачальник API').selectOption({ label: o.provider });
  await dialog.getByLabel('Контрагент-постачальник').selectOption({ label: o.supplier });
  await dialog.getByLabel("Назва (необов'язково)").fill(o.name);
  await dialog.getByLabel("Адреса API (необов'язково)").fill(o.apiUrl);
  for (const [label, value] of Object.entries(o.creds)) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  const wh = dialog.getByRole('group', { name: state.warehouse!.name });
  for (const [label, value] of Object.entries(o.warehouse)) {
    await wh.getByLabel(label, { exact: true }).fill(value);
  }
  await dialog.getByRole('button', { name: 'Зберегти і перевірити' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const card = page.getByTestId('supplier-connection-card').filter({ hasText: o.name });
  await expect(card.getByTestId('verify-status')).toContainText('Перевірено', {
    timeout: 15_000,
  });
  return card;
}

test.describe('Постачальники API — від підключення до підтвердженого замовлення', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    await fetch(`${FAKES}/__reset`, { method: 'POST' }).catch(() => undefined);
    // Замовлення: відправлене скасовуємо з force (BR-SCON-014), чернетку видаляємо.
    for (const id of state.poIds) {
      const po = await apiRequest<{ status: string }>(
        request,
        token,
        'GET',
        `/purchase-orders/${id}`,
      );
      if (po.body?.status === 'DRAFT') {
        const del = await apiRequest(request, token, 'DELETE', `/purchase-orders/${id}?force=true`);
        expect.soft(del.status, `DELETE замовлення ${id}`).toBeLessThan(300);
      } else if (po.body?.status === 'ORDERED' || po.body?.status === 'PARTIAL') {
        const res = await apiRequest(request, token, 'POST', `/purchase-orders/${id}/transition`, {
          status: 'CANCELLED',
          force: true,
        });
        expect.soft(res.status, `скасування замовлення ${id}`).toBeLessThan(300);
      }
    }
    if (state.listId) {
      const cancel = await apiRequest(
        request,
        token,
        'POST',
        `/purchase-lists/${state.listId}/cancel`,
      );
      expect.soft(cancel.status, 'скасування списку').toBeLessThan(300);
      const del = await apiRequest(request, token, 'DELETE', `/purchase-lists/${state.listId}`);
      expect.soft([200, 204, 400], 'DELETE списку').toContain(del.status);
    }
    for (const id of state.connIds) {
      const res = await apiRequest(request, token, 'DELETE', `/supplier-connections/${id}`);
      expect.soft(res.status, 'DELETE підключення').toBeLessThan(300);
    }
    // Лише створений нами товар видаляємо; перевикористаний живий OC 90 лишаємо (його DELETE
    // і так інколи 400 через посилання, і він потрібен наступному прогону для матчу пропозицій).
    if (state.goodId && !state.goodReused) {
      const res = await apiRequest(request, token, 'DELETE', `/goods/${state.goodId}`);
      expect.soft(res.status, 'DELETE товару').toBeLessThan(300);
    }
    if (state.brandCreated && state.brandId) {
      const res = await apiRequest(request, token, 'DELETE', `/brands/${state.brandId}`);
      expect.soft(res.status, 'DELETE бренду').toBeLessThan(300);
    }
    for (const id of [state.supAvdId, state.supUtrId]) {
      if (!id) continue;
      const res = await apiRequest(request, token, 'DELETE', `/counterparties/${id}`);
      expect.soft(res.status, 'DELETE постачальника').toBeLessThan(300);
    }
  });

  test('1. підключення AVD і UTR: «Зберегти і перевірити» OK, каталог AVD', async ({ page }) => {
    test.setTimeout(150_000);
    await fakes('/__reset', {});
    await page.goto('/settings?tab=supplier-api');
    await expect(page.getByRole('button', { name: 'Додати підключення' })).toBeEnabled({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API ─────────────────────────────────────────────
    for (const [name, key] of [
      [SUP_AVD, 'supAvdId'],
      [SUP_UTR, 'supUtrId'],
    ] as const) {
      const cp = await api<{ id: string }>(page, 'POST', '/counterparties', {
        type: 'SUPPLIER',
        companyName: name,
      });
      expect(cp.status).toBe(201);
      state[key] = cp.body.id;
    }
    const brands = await api<{ items: Array<{ id: string; name: string }> }>(
      page,
      'GET',
      `/brands?q=${BRAND}&limit=20`,
    );
    const brand = brands.body.items.find(b => b.name.toUpperCase() === BRAND);
    if (brand) state.brandId = brand.id;
    else {
      const created = await api<{ id: string }>(page, 'POST', '/brands', { name: BRAND });
      expect(created.status).toBe(201);
      state.brandId = created.body.id;
      state.brandCreated = true;
    }
    // sku МУСИТЬ дорівнювати артикулу каталогу (OC 90) для матчу пропозицій, тож унікальним бути
    // не може. На брудній dev-базі з цим sku вже може лежати ЖИВИЙ товар попереднього прогону
    // (його DELETE інколи 400 — товар у рухах/замовленнях, тож просто видалити не можна). Тому:
    // є живий OC 90 → ПЕРЕВИКОРИСТАТИ його id, інакше створити. Самоізоляція без залежності від
    // того, чи вдалося прибрати попередній. На чистій базі CI — завжди гілка create.
    const existing = await api<{ items: Array<{ id: string; sku: string | null; name: string }> }>(
      page,
      'GET',
      `/goods?q=${encodeURIComponent(ARTICLE)}&limit=50`,
    );
    const liveSameSku = existing.body.items.find(x => x.sku === ARTICLE);
    if (liveSameSku) {
      // Перевикористаний товар має СВОЮ назву (не цьогопрогонний GOOD) — пошук у пікері нижче
      // мусить шукати саме її, інакше опція не зʼявиться (Bug: тест шукав GOOD поточного прогону).
      state.goodId = liveSameSku.id;
      state.goodName = liveSameSku.name;
      state.goodReused = true;
    } else {
      const good = await api<{ id: string }>(page, 'POST', '/goods', {
        name: GOOD,
        sku: ARTICLE,
        brandId: state.brandId,
        salePrice: 300,
        purchasePrice: 120,
      });
      expect(good.status, JSON.stringify(good.body)).toBe(201);
      state.goodId = good.body.id;
      state.goodName = GOOD;
    }
    const warehouses = await api<Array<{ id: string; name: string; isMain: boolean }>>(
      page,
      'GET',
      '/warehouses',
    );
    state.warehouse = warehouses.body.find(w => w.isMain) ?? warehouses.body[0];

    // ── Підключення через інтерфейс ───────────────────────────────────────
    await page.reload();
    const avdCard = await addConnection(page, {
      provider: 'AVD Trade',
      supplier: SUP_AVD,
      name: CONN_AVD,
      apiUrl: `${FAKES}/avd/api/v1`,
      creds: { 'API-ключ (x-api-key)': 'avd-test-key' },
      warehouse: {
        'Торгова точка AVD (GET /locations)': 'c1111111-0000-4000-8000-000000000001',
        'Перевізник AVD (GET /forwarders)': 'c1111111-0000-4000-8000-000000000002',
      },
    });
    await addConnection(page, {
      provider: 'UTR (UniqTrade)',
      supplier: SUP_UTR,
      name: CONN_UTR,
      apiUrl: `${FAKES}/utr`,
      creds: { 'Логін (email)': 'utr@test.ua', Пароль: 'utr-pass' },
      warehouse: {
        'Точка доставки UTR (GET /api/delivery-points)': '22',
        'Перевізник UTR (отримання перевізників)': '1',
      },
    });
    // Креди лише на запис: картка каже «Ключі збережено», значень у відповіді API немає.
    const conns = await api<{
      items: Array<{ id: string; name: string; hasCredentials: boolean; credentials?: unknown }>;
    }>(page, 'GET', '/supplier-connections');
    const mine = conns.body.items.filter(c => c.name === CONN_AVD || c.name === CONN_UTR);
    expect(mine).toHaveLength(2);
    state.connIds = mine.map(c => c.id);
    expect(mine.every(c => c.hasCredentials && c.credentials === undefined)).toBe(true);

    await avdCard.getByRole('button', { name: 'Синхронізувати каталог' }).click();
    await expect(avdCard.getByTestId('catalog-status')).toContainText('Каталог від', {
      timeout: 60_000,
    });
    await page.screenshot({ path: test.info().outputPath('sapi_e2e_connections.png') });
  });

  test('2. ручна позиція → «Пропозиції»: чипи підключень, вибір пропозиції UTR', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    // ── Список і позиція через інтерфейс ─────────────────────────────────
    await page.goto('/purchase-orders?tab=procurement&view=lists');
    await page.getByRole('button', { name: 'Новий список' }).first().click();
    const create = page.getByRole('dialog').filter({ hasText: 'Новий список' });
    await create.getByRole('textbox').first().fill(LIST_NAME);
    await create.getByRole('button', { name: 'Новий список' }).click();
    const detail = page.getByRole('dialog').filter({ hasText: LIST_NAME });
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await detail.getByRole('button', { name: 'Додати позицію' }).click();
    const add = page.getByRole('dialog').filter({ hasText: 'Кількість (базові од.)' });
    const goodName = state.goodName ?? GOOD;
    await add.getByRole('combobox', { name: 'Товар' }).fill(goodName);
    await page.getByRole('option', { name: goodName }).first().click();
    await add.getByLabel('Склад').selectOption({ label: state.warehouse!.name });
    await add.getByLabel('Кількість (базові од.)').fill('4');
    await add.getByRole('button', { name: 'Додати позицію' }).click();
    await expect(add).toBeHidden({ timeout: 15_000 });
    const lists = await api<{ items: Array<{ id: string; name: string | null }> }>(
      page,
      'GET',
      `/purchase-lists?status=OPEN&limit=100&q=${encodeURIComponent(LIST_NAME)}`,
    );
    state.listId = lists.body.items.find(l => l.name === LIST_NAME)?.id;
    expect(state.listId, 'список створено').toBeTruthy();
    expect(await listItems(page)).toEqual([
      expect.objectContaining({ quantity: 4, status: 'OPEN' }),
    ]);

    // ── «Пропозиції» ─────────────────────────────────────────────────────
    const rows = await openItems(page);
    await rows
      .first()
      .getByRole('button', { name: `Пропозиції постачальників для ${goodName}` })
      .click();
    const dialog = page.getByTestId('supplier-offers-dialog');
    await expect(dialog).toBeVisible();
    const chips = dialog.getByTestId('offer-connection-chip');
    await expect(chips.filter({ hasText: SUP_AVD })).toContainText(/пропоз|кешу/, {
      timeout: 30_000,
    });
    await expect(chips.filter({ hasText: SUP_UTR })).toContainText(/пропоз|кешу/, {
      timeout: 30_000,
    });
    const offerRows = dialog.getByTestId('supplier-offer-row');
    await expect(offerRows.filter({ hasText: SUP_AVD }).first()).toBeVisible();
    // Обмежений залишок постачальника показано як «≥10» (BR-SOFR-001).
    await expect(dialog.getByText('≥10').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('sapi_e2e_offers.png') });

    const utrRow = offerRows.filter({ hasText: SUP_UTR }).first();
    await utrRow.getByRole('button', { name: /^Обрати/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(rows.first().getByTestId('offer-badge')).toBeVisible({ timeout: 15_000 });
    const [item] = await listItems(page);
    expect(item).toMatchObject({ supplierId: state.supUtrId, offerChosenBy: 'MANUAL' });
  });

  test('3. «Підібрати автоматично»: ручний вибір лишається, з прапорцем — «Дешево» бере AVD', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const rows = await openItems(page);
    await rows.first().getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Підібрати автоматично' }).click();
    const dialog = page.getByTestId('auto-allocate-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Стратегія').selectOption({ label: 'Дешево' });
    const preview = dialog
      .getByTestId('allocation-row')
      .filter({ hasText: state.goodName ?? GOOD });
    await expect(preview).toContainText('обрано вручну — лишається', { timeout: 30_000 });
    await dialog.getByLabel(/Перезаписати ручний вибір/).check();
    await expect(preview).toContainText(SUP_AVD, { timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('sapi_e2e_allocate.png') });
    await page.getByRole('button', { name: 'Застосувати' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    const items = await listItems(page);
    expect(items).toEqual([
      expect.objectContaining({ supplierId: state.supAvdId, offerChosenBy: 'AUTO', quantity: 4 }),
    ]);
  });

  test('4. «Створити замовлення» → «Відправити в API» → «Оновити статус» → підтверджено', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1680, height: 950 });
    const rows = await openItems(page);
    await rows.first().getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Створити замовлення' }).click();
    await page.getByRole('button', { name: 'Так' }).click();
    await expect(page.getByText(/Створено замовлення: /)).toBeVisible({ timeout: 15_000 });
    const [item] = await listItems(page);
    expect(item!.purchaseOrderId).toBeTruthy();
    const poId = item!.purchaseOrderId!;
    state.poIds.push(poId);
    const po = await api<{ number: string }>(page, 'GET', `/purchase-orders/${poId}`);

    await page.goto(`/purchase-orders?open=${poId}`);
    const modal = page.getByRole('dialog').filter({ hasText: po.body.number });
    const block = modal.getByTestId('supplier-api-order-block');
    await expect(block).toBeVisible({ timeout: 30_000 });
    await expect(block.getByTestId('supplier-api-status')).toHaveText('Не відправлено');
    await block.getByRole('button', { name: 'Відправити в API' }).click();
    await page.getByRole('button', { name: 'Так' }).click();
    await expect(block.getByTestId('supplier-api-status')).toHaveText(/Відправлено|Підтверджено/, {
      timeout: 45_000,
    });
    await expect(block.getByTestId('supplier-api-external-order')).toContainText(CONN_AVD);
    const afterSend = await api<{ status: string }>(page, 'GET', `/purchase-orders/${poId}`);
    expect(afterSend.body.status, 'кнопка з чернетки переводить у «Замовлено»').toBe('ORDERED');

    // Статус у фейку рухається з кожним опитуванням — «Оновити статус», доки не підтверджено.
    await expect
      .poll(
        async () => {
          const btn = block.getByRole('button', { name: 'Оновити статус' });
          if (await btn.isEnabled()) await btn.click();
          return (await block.getByTestId('supplier-api-status').textContent()) ?? '';
        },
        { timeout: 60_000, intervals: [4_000] },
      )
      .toMatch(/Підтверджено/);
    await block.screenshot({ path: test.info().outputPath('sapi_e2e_order_block.png') });
  });

  test('5. 429 і немає зв’язку: «повтор о HH:MM» і останні відомі пропозиції', async ({ page }) => {
    test.setTimeout(150_000);
    // Нова позиція того самого товару — щоб «Пропозиції» було кому відкривати.
    await page.goto('/purchase-orders?tab=procurement&view=items');
    const added = await api(page, 'POST', `/purchase-lists/${state.listId}/items`, {
      goodId: state.goodId,
      warehouseId: state.warehouse!.id,
      quantity: 1,
    });
    expect(added.status, 'передумова: ще одна позиція').toBe(201);
    const rows = await openItems(page);
    // Фільтр «Не замовлено» типовий: замовлена позиція тесту 4 тут уже не видна.
    const open = rows.first();

    // Спершу звичайний пошук — є останні відомі пропозиції UTR.
    await open
      .getByRole('button', { name: `Пропозиції постачальників для ${state.goodName ?? GOOD}` })
      .click();
    const dialog = page.getByTestId('supplier-offers-dialog');
    const utrChip = dialog.getByTestId('offer-connection-chip').filter({ hasText: SUP_UTR });
    await expect(utrChip).toContainText(/пропоз|кешу/, { timeout: 30_000 });

    // 429 з Retry-After: задача відкладається без витрати спроби, чип — «повтор о HH:MM».
    await fakes('/__scenario', { provider: 'utr', mode: '429', retryAfter: 600 });
    await page.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(utrChip).toContainText(/Немає зв'язку — повтор о \d{2}:\d{2}/, {
      timeout: 30_000,
    });
    await expect(
      dialog.getByTestId('supplier-offer-row').filter({ hasText: SUP_UTR }).first(),
      'офлайн — останні відомі пропозиції',
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('sapi_e2e_429.png') });

    // Немає зв'язку (5xx): той самий стан, рядки лишаються.
    await fakes('/__scenario', { provider: 'utr', mode: '500' });
    await page.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(utrChip).toContainText(/Немає зв'язку/, { timeout: 30_000 });
    await expect(
      dialog.getByTestId('supplier-offer-row').filter({ hasText: SUP_UTR }).first(),
    ).toBeVisible();
    await fakes('/__scenario', { provider: 'utr', mode: 'ok' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('6. скасування відправленого — підтвердження «скасуйте в кабінеті постачальника»', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1680, height: 950 });
    const poId = state.poIds[0]!;
    await page.goto(`/purchase-orders?open=${poId}`);
    const po = await api<{ number: string }>(page, 'GET', `/purchase-orders/${poId}`);
    const modal = page.getByRole('dialog').filter({ hasText: po.body.number });
    await expect(modal.getByTestId('supplier-api-order-block')).toBeVisible({ timeout: 30_000 });
    await modal.getByRole('button', { name: 'Скасувати', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Замовлення вже в постачальника' });
    await expect(confirm).toContainText('скасуйте його в кабінеті постачальника', {
      timeout: 15_000,
    });
    // Escape у підтвердженні закриває лише його — картка лишається.
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(modal).toBeVisible();
    expect(
      (await api<{ status: string }>(page, 'GET', `/purchase-orders/${poId}`)).body.status,
    ).toBe('ORDERED');
    await modal.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await page.getByRole('button', { name: 'Так, скасовано в кабінеті' }).click();
    await expect
      .poll(
        async () =>
          (await api<{ status: string }>(page, 'GET', `/purchase-orders/${poId}`)).body.status,
        { timeout: 15_000 },
      )
      .toBe('CANCELLED');
  });
});
