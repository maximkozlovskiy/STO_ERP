import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { handleDbUnavailable, testDatabaseUrl } from '../common/testing/require-db';

/**
 * Міграція `20261114150000_brand_name_lower_unique` (BR-GOOD-007, №11): частковий унікальний
 * індекс назви бренду без урахування регістру серед активних. Власник просив наявні дублі спершу
 * показати йому, тож за дублів міграція НЕ падає (оновлення в клієнта не зупиняється) — друкує їх
 * NOTICE і індексу не створює.
 *
 * Тест виконує САМ файл міграції на живій БД, але над тимчасовою копією таблиці: у транзакції
 * `CREATE TEMP TABLE "brands" (LIKE public."brands")` — тимчасова схема в Postgres шукається
 * першою, тож некваліфіковане `"brands"` у міграції бачить копію, а не справжню таблицю. Справжні
 * бренди не читаються й не пишуться; `ROLLBACK` прибирає копію разом з індексом.
 *
 * Наявність індексу на справжній таблиці стереже `schema-integrity.integration.spec.ts`.
 *
 * Mutation-verify (2026-11-14): у копії міграції прибрати `IF dup_count = 0` (індекс завжди) →
 * кейс «з дублями» падає на unique violation; прибрати `WHERE "deletedAt" IS NULL` з індексу →
 * кейс «видалений тезка не заважає» падає.
 */
const MIGRATION = join(
  __dirname,
  '../../../../packages/database/prisma/migrations/20261114150000_brand_name_lower_unique/migration.sql',
);
const INDEX = 'brands_orgId_lower_name_active_uq';
const ORG = '00000000-0000-4000-8000-0000000000b4';

let client: Client | null = null;
let dbAvailable = false;
const notices: string[] = [];

beforeAll(async () => {
  const c = new Client({ connectionString: testDatabaseUrl() });
  try {
    await c.connect();
    await c.query(`SELECT 1 FROM "brands" LIMIT 0`);
    c.on('notice', msg => notices.push(msg.message ?? ''));
    client = c;
    dbAvailable = true;
  } catch {
    await c.end().catch(() => undefined);
    handleDbUnavailable('підключення або міграції недоступні');
  }
}, 30_000);

afterAll(async () => {
  if (client) await client.end();
});

/** Копія таблиці з даними `names` (`[назва, видалений?]`), прогін міграції, перевірка, ROLLBACK. */
async function withMigratedCopy(
  names: Array<[string, boolean]>,
  check: (db: Client) => Promise<void>,
): Promise<void> {
  const db = client!;
  notices.length = 0;
  await db.query('BEGIN');
  try {
    await db.query(
      `CREATE TEMP TABLE "brands" (LIKE public."brands" INCLUDING DEFAULTS) ON COMMIT DROP`,
    );
    for (const [name, deleted] of names) {
      await db.query(
        `INSERT INTO "brands" ("orgId", "name", "updatedAt", "deletedAt")
         VALUES ($1::uuid, $2, now(), CASE WHEN $3 THEN now() ELSE NULL END)`,
        [ORG, name, deleted],
      );
    }
    await db.query(readFileSync(MIGRATION, 'utf8'));
    await check(db);
  } finally {
    await db.query('ROLLBACK');
  }
}

async function tempIndexDef(db: Client): Promise<string | null> {
  const res = await db.query<{ def: string }>(
    `SELECT indexdef AS def FROM pg_indexes
      WHERE indexname = $1 AND schemaname LIKE 'pg_temp%' AND tablename = 'brands'`,
    [INDEX],
  );
  return res.rows[0]?.def ?? null;
}

// guards: BR-GOOD-007
describe('міграція 20261114150000 — назва бренду унікальна без регістру', () => {
  it('без дублів: індекс частковий за lower(name), другий «BOSCH» відхиляє, видалений тезка — ні', async () => {
    if (!dbAvailable) return;
    await withMigratedCopy(
      [
        ['Bosch', false],
        ['bosch', true],
        ['Mann', false],
      ],
      async db => {
        const def = await tempIndexDef(db);
        expect(def).toMatch(/UNIQUE/);
        expect(def).toMatch(/lower\(name\)/);
        expect(def).toMatch(/WHERE \("deletedAt" IS NULL\)/);
        await db.query('SAVEPOINT dup');
        await expect(
          db.query(
            `INSERT INTO "brands" ("orgId", "name", "updatedAt") VALUES ($1::uuid, 'BOSCH', now())`,
            [ORG],
          ),
        ).rejects.toThrow(/brands_orgId_lower_name_active_uq/);
        await db.query('ROLLBACK TO SAVEPOINT dup');
        await expect(
          db.query(
            `INSERT INTO "brands" ("orgId", "name", "updatedAt", "deletedAt") VALUES ($1::uuid, 'MANN', now(), now())`,
            [ORG],
          ),
        ).resolves.toBeTruthy();
      },
    );
    expect(notices.filter(n => n.includes('Дублі назви бренду'))).toEqual([]);
  });

  it('з дублями: міграція не падає, друкує дублі NOTICE, індексу не створює', async () => {
    if (!dbAvailable) return;
    await withMigratedCopy(
      [
        ['Bosch', false],
        ['BOSCH', false],
        ['Mann', false],
      ],
      async db => {
        expect(await tempIndexDef(db)).toBeNull();
      },
    );
    const dupNotice = notices.find(n => n.includes('Дублі назви бренду'));
    expect(dupNotice).toContain(ORG);
    expect(dupNotice).toContain('Bosch');
    expect(dupNotice).toContain('BOSCH');
    expect(dupNotice).not.toContain('Mann');
    expect(notices.some(n => n.includes(`Індекс ${INDEX} не створено: 1 груп дублів`))).toBe(true);
  });
});
