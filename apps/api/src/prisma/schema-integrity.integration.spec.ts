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
});
