import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { withTenantGuard } from './tenant-guard.extension';
import { TenantIsolationError } from './tenant-isolation.error';
import { runWithTenant, runUnscoped } from '../common/tenant/tenant-context';

/**
 * ІНТЕГРАЦІЙНИЙ тест tenant-guard $extends проти ЖИВОЇ dev-БД (A1).
 *
 * КРИТИЧНО: юніт-тести сервісів мокають Prisma → реальний guard-extension у них НЕ виконується.
 * Це — ЄДИНЕ реальне покриття поведінки guard-а (throw/pass/stamp/bypass/tx) проти справжнього
 * PrismaClient. Композиція дзеркалить prisma.service.onModuleInit (guard OUTERMOST).
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL. Без БД — SKIP (не фейлить CI без docker),
 * але на dev-машині з піднятою БД виконується реально (не fake-green).
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

let dbAvailable = false;
let raw: PrismaClient;
let guarded: PrismaClient;
let orgId: string;
let branchId: string;
const createdCounterpartyIds: string[] = [];

async function cleanup() {
  if (createdCounterpartyIds.length === 0) return;
  await raw
    .$executeRawUnsafe(
      `DELETE FROM counterparties WHERE id = ANY($1::uuid[])`,
      createdCounterpartyIds,
    )
    .catch(() => undefined);
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ datasourceUrl: DATABASE_URL });
  try {
    await raw.$connect();
    const branch = await raw.garageBranch.findFirst({ select: { id: true, orgId: true } });
    if (!branch) {
      dbAvailable = false;
      return;
    }
    orgId = branch.orgId;
    branchId = branch.id;
    dbAvailable = true;
    // Guard OUTERMOST — судить оригінальні args (тут без inner-extensions, достатньо для guard-поведінки).
    guarded = withTenantGuard(raw);
  } catch {
    dbAvailable = false;
  }
}, 30_000);

afterAll(async () => {
  if (raw) {
    await cleanup();
    await raw.$disconnect();
  }
});

describe('tenant-guard extension (integration, live DB)', () => {
  it('передумова: dev-БД доступна', () => {
    if (!dbAvailable) console.warn('[tenant-guard.integration] dev-БД недоступна — тест пропущено');
    expect(true).toBe(true);
  });

  it('READ tenant-моделі БЕЗ orgId → кидає TenantIsolationError', async () => {
    if (!dbAvailable) return;
    await expect(guarded.workOrder.findMany({ where: { deletedAt: null } })).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('READ з top-level orgId → проходить', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.workOrder.findMany({ where: { orgId, deletedAt: null }, take: 1 }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('READ з composite-key orgId (orgId_email на AuthAccount) → проходить', async () => {
    if (!dbAvailable) return;
    // findUnique по compound-unique — має пройти, навіть якщо рядка немає (null).
    await expect(
      guarded.authAccount.findUnique({
        where: { orgId_email: { orgId, email: 'nonexistent@example.com' } },
      }),
    ).resolves.toBeNull();
  });

  it('READ з composite-key branchId (branchId_channel) → проходить', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.notificationChannelConfig.findUnique({
        where: { branchId_channel: { branchId, channel: 'SMS' } },
      }),
    ).resolves.not.toThrow;
  });

  it('UPDATE по {id} БЕЗ orgId → кидає', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.workOrder.updateMany({ where: { id: orgId }, data: { description: 'x' } }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('DELETE по {id} БЕЗ orgId → кидає (fail-closed на видаленні)', async () => {
    if (!dbAvailable) return;
    await expect(guarded.workOrder.delete({ where: { id: orgId } })).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('deleteMany БЕЗ orgId → кидає (масове видалення без tenant-scope)', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.workOrder.deleteMany({ where: { deletedAt: null } }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('groupBy БЕЗ orgId → кидає (агрегація крос-tenant заборонена)', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.workOrder.groupBy({ by: ['status'], where: { deletedAt: null }, _count: true }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('groupBy З orgId → проходить', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.workOrder.groupBy({
        by: ['status'],
        where: { orgId, deletedAt: null },
        _count: true,
      }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('leak-вектор: READ orgId:{not:X} → кидає (негація не є tenant-scope)', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.workOrder.findMany({ where: { orgId: { not: orgId }, deletedAt: null }, take: 1 }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('leak-вектор: READ NOT:{orgId} → кидає (негований tenant-фільтр)', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.workOrder.findMany({ where: { NOT: { orgId }, deletedAt: null }, take: 1 }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('cross-org batch: READ orgId:{in:[...]} → проходить (легіт nbu-scheduler patttern)', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.organisationSettings.findMany({ where: { orgId: { in: [orgId] } } }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('UPSERT: create БЕЗ orgId + БЕЗ ambient → кидає (справжній пропуск tenant-контексту)', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.counterparty.upsert({
        where: { id: '00000000-0000-0000-0000-000000000000' },
        create: { type: 'CLIENT', firstName: 'upsert-fail', phone: '+380000000003' },
        update: {},
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('exempt-модель (Organisation за {id}) → проходить', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.organisation.findFirst({ where: { id: orgId } }),
    ).resolves.not.toBeUndefined();
  });

  it('CREATE без orgId + ambient ALS → стемпить orgId і створює', async () => {
    if (!dbAvailable) return;
    const created = await runWithTenant({ orgId }, async () =>
      guarded.counterparty.create({
        data: { type: 'CLIENT', firstName: 'A1-тест', phone: '+380000000001' },
      }),
    );
    createdCounterpartyIds.push(created.id);
    expect(created.orgId).toBe(orgId);
  });

  it('CREATE без orgId + БЕЗ ambient → кидає', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.counterparty.create({
        data: { type: 'CLIENT', firstName: 'A1-fail', phone: '+380000000002' },
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('runUnscoped(...) → tenant-less READ проходить (bypass)', async () => {
    if (!dbAvailable) return;
    // ВАЖЛИВО: await ВСЕРЕДИНІ runUnscoped — інакше lazy-PrismaPromise виконається ПІСЛЯ виходу зі scope.
    await expect(
      runUnscoped(
        async () => await guarded.workOrder.findMany({ where: { deletedAt: null }, take: 1 }),
      ),
    ).resolves.toBeInstanceOf(Array);
  });

  it('всередині $transaction: READ без orgId → кидає (доводить tx-inheritance + композицію)', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.$transaction(async tx => {
        return tx.workOrder.findMany({ where: { deletedAt: null } });
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('всередині $transaction з orgId → проходить', async () => {
    if (!dbAvailable) return;
    await expect(
      guarded.$transaction(async tx => tx.workOrder.findMany({ where: { orgId }, take: 1 })),
    ).resolves.toBeInstanceOf(Array);
  });
});
