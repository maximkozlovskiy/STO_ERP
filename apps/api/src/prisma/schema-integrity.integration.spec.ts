import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from './pg-adapter';
import { handleDbUnavailable } from '../common/testing/require-db';

/**
 * TD2 — ГВАРД проти втрати manual-SQL конструктів при schema-rebuild.
 *
 * Проблема: низка міграцій несе конструкти, яких `schema.prisma` НЕ виражає:
 *   • partial-unique індекси (`CREATE UNIQUE INDEX ... WHERE ...`) — фіскальна унікальність
 *     номерів документів серед АКТИВНИХ рядків + бізнес-інваріанти (один головний склад,
 *     одна відкрита касова зміна, idempotency нарахування лояльності);
 *   • GIN/pg_trgm пошукові індекси;
 *   • GiST EXCLUDE-констрейнт (антидубль бронювання) + розширення btree_gist;
 *   • CHECK-констрейнти (незмінний stock non-negative).
 *
 * `prisma db push` та будь-який rebuild зі схеми ТИХО викидають усе це → повертаються дублі
 * фіскальних номерів, подвійне бронювання, від'ємні залишки. Prisma introspection їх також не
 * матеріалізує у schema.prisma, тож drift-детектор мовчить. ЄДИНИЙ захист — заборона db push
 * на проді (див. docs/DATABASE.md) + цей тест, який червоніє щойно конструкт зник із живої БД.
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL (.env.dev). Без БД — SKIP (не фейлить CI без
 * docker), АЛЕ на dev-машині з піднятою БД виконується реально (не fake-green).
 *
 * НЕ асертимо по крихких іменах trgm-індексів (кілька міграцій створювали їх під різними
 * іменами через IF NOT EXISTS: idx_goods_name_trgm ↔ goods_name_trgm_idx). Замість цього
 * для trgm перевіряємо СЕМАНТИКУ: на (таблиця, колонка) існує хоч один GIN-індекс з trgm-опклассом.
 * Partial-unique / exclusion / check мають по одному канонічному імені → асертимо по імені.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

let dbAvailable = false;
let raw: PrismaClient;

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await raw.$connect();
    // Sanity: чи є хоч одна таблиця схеми (мігрована БД) — інакше вважаємо БД недоступною.
    await raw.$queryRawUnsafe(`SELECT 1 FROM "work_orders" LIMIT 0`);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або seed недоступні');
  }
}, 30_000);

afterAll(async () => {
  if (raw) await raw.$disconnect();
});

/**
 * Канонічні partial-unique / exclusion індекси — назва однозначна (один creator-міграція).
 * Фіскально/інваріантно критичні: втрата = дублі номерів / зламаний бізнес-інваріант.
 */
const REQUIRED_NAMED_INDEXES: { name: string; why: string }[] = [
  // Document-number uniqueness among active rows (фіскальна вимога UA)
  { name: 'work_orders_orgId_number_active_uq', why: 'унікальність № наряду серед активних' },
  { name: 'invoices_orgId_number_active_uq', why: 'унікальність № рахунку серед активних' },
  {
    name: 'purchase_orders_orgId_number_active_uq',
    why: 'унікальність № замовлення серед активних',
  },
  {
    name: 'supplier_connections_org_cp_provider_active_uq',
    why: 'одне підключення на постачальника й провайдера серед активних (BR-SCON)',
  },
  {
    name: 'purchase_lists_orgId_number_active_uq',
    why: 'унікальність № списку купівлі серед активних (BR-PL-001)',
  },
  {
    name: 'stock_documents_orgId_number_active_uq',
    why: 'унікальність № складського док. серед активних',
  },
  {
    name: 'supplier_returns_orgId_number_active_uq',
    why: 'унікальність № повернення серед активних',
  },
  {
    name: 'supplier_payments_orgId_number_active_uq',
    why: 'унікальність № оплати постач. серед активних',
  },
  {
    name: 'counterparty_contracts_orgId_number_active_uq',
    why: 'унікальність № договору серед активних',
  },
  {
    name: 'completion_acts_orgId_number_active_uq',
    why: 'унікальність № акту виконаних робіт серед активних',
  },
  // Business invariants
  { name: 'warehouses_orgId_isMain_unique', why: 'не більше одного головного складу на org' },
  {
    name: 'cash_shifts_one_open_per_register_uq',
    why: 'не більше однієї відкритої касової зміни на касу',
  },
  { name: 'loyalty_earn_one_per_document_uq', why: 'idempotency нарахування балів по документу' },
  {
    name: 'settlement_charge_one_per_document_uq',
    why: 'одне нарахування боргу (CHARGE) на документ — наряд чи рахунок',
  },
  {
    name: 'expense_categories_default_reason_uq',
    why: 'один привід за замовчуванням — одна стаття руху коштів в організації (BR-CASH-022)',
  },
];

/** (table, column) на яких має бути GIN trgm-індекс (пошук). Ім'я не фіксуємо (див. шапку). */
const REQUIRED_TRGM: { table: string; column: string }[] = [
  { table: 'work_orders', column: 'number' },
  { table: 'counterparties', column: 'firstName' },
  { table: 'counterparties', column: 'lastName' },
  { table: 'counterparties', column: 'companyName' },
  { table: 'counterparties', column: 'phone' },
  { table: 'goods', column: 'name' },
  { table: 'goods', column: 'sku' },
  { table: 'goods', column: 'barcode' },
  { table: 'works', column: 'name' },
];

describe('Schema integrity — manual-SQL конструкти живі у БД (TD2 guard, integration)', () => {
  it('передумова: dev-БД доступна', () => {
    if (!dbAvailable)
      console.warn('[schema-integrity] dev-БД недоступна — тест пропущено (не fake-green на CI)');
    expect(true).toBe(true);
  });

  it('partial-unique / інваріантні індекси існують (fiscal doc-number + business invariants)', async () => {
    if (!dbAvailable) return;
    const rows = await raw.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const present = new Set(rows.map(r => r.indexname));
    const missing = REQUIRED_NAMED_INDEXES.filter(i => !present.has(i.name));
    expect(
      missing,
      `Втрачено manual-SQL індекси (ймовірно db push/rebuild зі схеми):\n` +
        missing.map(m => `  • ${m.name} — ${m.why}`).join('\n'),
    ).toEqual([]);
  });

  it('усі partial-unique doc-number індекси справді ЧАСТКОВІ (мають predicate WHERE deletedAt IS NULL)', async () => {
    if (!dbAvailable) return;
    // Ловить регресію, коли конструкт відновили як ПОВНИЙ unique (без WHERE) — тоді soft-deleted
    // документ блокував би новий з тим самим номером (інша, теж зламана, поведінка).
    const rows = await raw.$queryRawUnsafe<{ indexname: string; pred: string | null }[]>(
      `SELECT c.relname AS indexname, pg_get_expr(i.indpred, i.indrelid) AS pred
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname LIKE '%_number_active_uq'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const notPartial = rows.filter(r => !r.pred || !/deletedAt/i.test(r.pred));
    expect(
      notPartial.map(r => r.indexname),
      'Ці doc-number індекси НЕ часткові — soft-delete більше не звільняє номер',
    ).toEqual([]);
  });

  // guards: BR-WORK-006
  it('одне CHARGE на документ: індекс частковий — лише CHARGE з документом (SUPPLIER_CHARGE вільний)', async () => {
    if (!dbAvailable) return;
    const rows = await raw.$queryRawUnsafe<{ pred: string | null; def: string }[]>(
      `SELECT pg_get_expr(i.indpred, i.indrelid) AS pred, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'settlement_charge_one_per_document_uq'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.def).toContain('UNIQUE');
    expect(rows[0]!.def).toContain('"orgId", "documentType", "documentId"');
    expect(rows[0]!.pred).toContain("'CHARGE'");
    expect(rows[0]!.pred).toContain('"documentId" IS NOT NULL');
  });

  it('GIN pg_trgm пошукові індекси існують на всіх критичних (таблиця, колонка)', async () => {
    if (!dbAvailable) return;
    // Семантична перевірка через indexdef (повний текст CREATE INDEX): GIN-індекс на потрібній
    // таблиці, чий вираз містить і назву колонки, і trgm-опклас. Не залежить від імені індексу
    // (кілька міграцій створювали їх під різними іменами) і від крихкого розбору indkey/indclass.
    const rows = await raw.$queryRawUnsafe<{ table: string; def: string }[]>(
      `SELECT tablename AS "table", indexdef AS "def"
         FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef ILIKE '%USING gin%' AND indexdef ILIKE '%trgm%'`,
    );
    const missing = REQUIRED_TRGM.filter(
      t =>
        !rows.some(
          r =>
            r.table === t.table && new RegExp(`"?${t.column}"?\\s+gin_trgm_ops`, 'i').test(r.def),
        ),
    );
    expect(
      missing.map(m => `${m.table}.${m.column}`),
      'Відсутні GIN trgm-індекси (пошук деградує до seq-scan; ймовірно db push скинув pg_trgm-індекси)',
    ).toEqual([]);
  });

  it('GiST EXCLUDE-констрейнт антидубль-бронювання живий (calendar_slots_no_overlap)', async () => {
    if (!dbAvailable) return;
    const rows = await raw.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname = 'calendar_slots_no_overlap'`,
    );
    expect(
      rows.length,
      'Втрачено EXCLUDE-констрейнт — можливе подвійне бронювання підйомника',
    ).toBe(1);
  });

  it('CHECK-констрейнти незмінного stock non-negative живі', async () => {
    if (!dbAvailable) return;
    const rows = await raw.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'c'
          AND conname IN ('stock_items_quantity_nonneg', 'stock_batches_remaining_nonneg')`,
    );
    const present = new Set(rows.map(r => r.conname));
    const missing = ['stock_items_quantity_nonneg', 'stock_batches_remaining_nonneg'].filter(
      c => !present.has(c),
    );
    expect(missing, "Втрачено CHECK-констрейнти — можливі від'ємні залишки").toEqual([]);
  });

  it('CHECK-констрейнти кількостей позиції списку купівлі живі (BR-PL-002, BR-PL-011)', async () => {
    if (!dbAvailable) return;
    const expected = [
      'purchase_list_items_quantity_positive_chk',
      'purchase_list_items_received_nonneg_chk',
      'purchase_list_items_reserved_range_chk',
    ];
    const rows = await raw.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname = ANY($1::text[])`,
      expected,
    );
    const present = new Set(rows.map(r => r.conname));
    expect(expected.filter(c => !present.has(c))).toEqual([]);
  });

  it('CHECK-констрейнти постачальників API живі (межі налаштувань, ціни й кількості)', async () => {
    if (!dbAvailable) return;
    const expected = [
      'org_settings_supplier_catalog_interval_chk',
      'org_settings_supplier_offer_retention_chk',
      'org_settings_supplier_offer_ttl_chk',
      'org_settings_supplier_poll_interval_chk',
      'org_settings_supplier_price_weight_chk',
      'org_settings_supplier_unknown_days_chk',
      'supplier_catalog_items_price_nonneg_chk',
      'supplier_offers_price_nonneg_chk',
      'supplier_offers_qty_nonneg_chk',
      'supplier_order_lines_confirmed_nonneg_chk',
      'supplier_order_lines_qty_positive_chk',
    ];
    const rows = await raw.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname = ANY($1::text[])`,
      expected,
    );
    const present = new Set(rows.map(r => r.conname));
    expect(expected.filter(c => !present.has(c))).toEqual([]);
  });

  it('append-only immutability тригери живі (ledger — фізична незмінність)', async () => {
    if (!dbAvailable) return;
    const rows = await raw.$queryRawUnsafe<{ tgname: string }[]>(
      `SELECT tgname FROM pg_trigger
        WHERE tgname IN ('trg_settlement_transactions_immutable', 'trg_stock_movements_immutable')
          AND NOT tgisinternal`,
    );
    const present = new Set(rows.map(r => r.tgname));
    const missing = [
      'trg_settlement_transactions_immutable',
      'trg_stock_movements_immutable',
    ].filter(t => !present.has(t));
    expect(
      missing,
      'Втрачено append-only тригери — ledger (settlement/stock movements) знову змінний лише за ' +
        'конвенцією (ймовірно db push/rebuild зі схеми скинув manual-SQL тригери)',
    ).toEqual([]);
  });

  it('розширення pg_trgm і btree_gist встановлені', async () => {
    if (!dbAvailable) return;
    const rows = await raw.$queryRawUnsafe<{ extname: string }[]>(
      `SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'btree_gist')`,
    );
    const present = new Set(rows.map(r => r.extname));
    const missing = ['pg_trgm', 'btree_gist'].filter(e => !present.has(e));
    expect(missing, 'Втрачено PG-розширення — trgm/exclusion індекси не збудуються').toEqual([]);
  });

  // guards: BR-INV-016
  it('джерело платежу: FK payments.bankAccountId / cashRegisterId — ON DELETE SET NULL', async () => {
    if (!dbAvailable) return;
    // confdeltype: 'n' = SET NULL, 'r' = RESTRICT, 'c' = CASCADE, 'a' = NO ACTION.
    // SET NULL означає: hard-delete рахунку чи каси не забирає з собою платіж і не блокується —
    // платіж лишається, зникає лише посилання на джерело коштів. Борг від нього не залежить.
    const rows = await raw.$queryRawUnsafe<{ column: string; onDelete: string }[]>(
      `SELECT a.attname AS "column", c.confdeltype::text AS "onDelete"
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'payments'::regclass AND c.contype = 'f'
          AND a.attname IN ('bankAccountId', 'cashRegisterId')
        ORDER BY a.attname`,
    );
    expect(rows).toEqual([
      { column: 'bankAccountId', onDelete: 'n' },
      { column: 'cashRegisterId', onDelete: 'n' },
    ]);
  });
});
