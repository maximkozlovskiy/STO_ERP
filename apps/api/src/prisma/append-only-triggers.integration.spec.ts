import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from './pg-adapter';
import { handleDbUnavailable } from '../common/testing/require-db';

/**
 * ІНТЕГРАЦІЙНИЙ тест append-only immutability тригерів (аудит Дані/Інфра) проти ЖИВОЇ dev-БД.
 *
 * Тригери роблять незмінність ledger ФІЗИЧНОЮ (не лише конвенція коду):
 *  · settlement_transactions — повна заборона UPDATE + DELETE;
 *  · stock_movements — заборона DELETE; UPDATE лише одноразове "batchId" NULL→value (createMovement).
 *
 * schema-integrity.spec перевіряє ІСНУВАННЯ тригерів; цей — їхню ПОВЕДІНКУ (реальний refactor міг би
 * перестворити тригер зі зламаною логікою, і existence-check це б не зловив). Якщо БД недоступна — SKIP.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

let raw: PrismaClient;
let dbAvailable = false;
let orgId = '';
let goodId = '';
let warehouseId = '';
let batchId: string | null = null;
const createdMovementIds: string[] = [];

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await raw.$connect();
    const org = await raw.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM organisations LIMIT 1`);
    if (!org.length) {
      dbAvailable = false;
      handleDbUnavailable('підключення або seed недоступні');
      return;
    }
    orgId = org[0].id;
    const good = await raw.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM goods WHERE "orgId"=$1::uuid LIMIT 1`,
      orgId,
    );
    const wh = await raw.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM warehouses WHERE "orgId"=$1::uuid LIMIT 1`,
      orgId,
    );
    const batch = await raw.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM stock_batches WHERE "orgId"=$1::uuid LIMIT 1`,
      orgId,
    );
    if (!good.length || !wh.length) {
      dbAvailable = false;
      handleDbUnavailable('підключення або seed недоступні');
      return;
    }
    goodId = good[0].id;
    warehouseId = wh[0].id;
    batchId = batch.length ? batch[0].id : null;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або seed недоступні');
  }
}, 30_000);

afterAll(async () => {
  if (raw && dbAvailable && createdMovementIds.length) {
    // Прибрати throwaway-рухи: тригер блокує DELETE → тимчасово вимикаємо його на час cleanup.
    await raw
      .$executeRawUnsafe(
        `ALTER TABLE stock_movements DISABLE TRIGGER trg_stock_movements_immutable`,
      )
      .catch(() => undefined);
    for (const id of createdMovementIds) {
      await raw
        .$executeRawUnsafe(`DELETE FROM stock_movements WHERE id=$1::uuid`, id)
        .catch(() => undefined);
    }
    await raw
      .$executeRawUnsafe(`ALTER TABLE stock_movements ENABLE TRIGGER trg_stock_movements_immutable`)
      .catch(() => undefined);
  }
  if (raw) await raw.$disconnect().catch(() => undefined);
});

async function insertMovement(): Promise<string> {
  const rows = await raw.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO stock_movements ("orgId","goodId","warehouseId",type,quantity,"createdAt")
     VALUES ($1::uuid,$2::uuid,$3::uuid,'RECEIPT',1,now()) RETURNING id`,
    orgId,
    goodId,
    warehouseId,
  );
  createdMovementIds.push(rows[0].id);
  return rows[0].id;
}

describe('append-only тригери — поведінка (жива БД)', () => {
  it('stock_movements: DELETE заборонено', async () => {
    if (!dbAvailable) return;
    const id = await insertMovement();
    await expect(
      raw.$executeRawUnsafe(`DELETE FROM stock_movements WHERE id=$1::uuid`, id),
    ).rejects.toThrow(/append-only/);
  });

  it('stock_movements: UPDATE quantity (не-batchId) заборонено', async () => {
    if (!dbAvailable) return;
    const id = await insertMovement();
    await expect(
      raw.$executeRawUnsafe(`UPDATE stock_movements SET quantity=2 WHERE id=$1::uuid`, id),
    ).rejects.toThrow(/append-only/);
  });

  it('stock_movements: одноразове "batchId" NULL→value ДОЗВОЛЕНО (createMovement flow)', async () => {
    if (!dbAvailable || !batchId) return; // немає партій — пропускаємо
    const id = await insertMovement();
    await expect(
      raw.$executeRawUnsafe(
        `UPDATE stock_movements SET "batchId"=$1::uuid WHERE id=$2::uuid`,
        batchId,
        id,
      ),
    ).resolves.not.toThrow();
  });

  it('stock_movements: "batchId" set РАЗОМ зі зміною price/notes/createdBy заборонено (не лише batchId)', async () => {
    if (!dbAvailable || !batchId) return; // немає партій — пропускаємо
    // Регресія: тригер мусить дозволяти ВИКЛЮЧНО batchId NULL→value, а не «batchId серед іншого».
    // Ранній перелік IS-NOT-DISTINCT не покривав price/notes/createdBy/unitOfMeasureId → зміну
    // ledger-money-поля price можна було протягти разом із batchId. Тепер порівнюється цілий рядок.
    const id = await insertMovement();
    await expect(
      raw.$executeRawUnsafe(
        `UPDATE stock_movements SET "batchId"=$1::uuid, price=999.99 WHERE id=$2::uuid`,
        batchId,
        id,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('settlement_transactions: UPDATE заборонено (повна незмінність)', async () => {
    if (!dbAvailable) return;
    // Не мутуємо реальні дані: UPDATE з неможливою умовою (0 рядків) НЕ зафаєрить BEFORE-тригер.
    // Тому тестуємо на реальному рядку, якщо він є; якщо ledger порожній — пропускаємо.
    const row = await raw.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM settlement_transactions WHERE "orgId"=$1::uuid LIMIT 1`,
      orgId,
    );
    if (!row.length) return; // порожній ledger — нічого мутувати
    await expect(
      raw.$executeRawUnsafe(
        `UPDATE settlement_transactions SET notes='trg-test' WHERE id=$1::uuid`,
        row[0].id,
      ),
    ).rejects.toThrow(/append-only/);
  });
});
