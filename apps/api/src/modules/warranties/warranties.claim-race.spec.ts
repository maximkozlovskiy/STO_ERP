import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect } from 'vitest';
import { translateError } from '@sto/shared';
import { WarrantiesService } from './warranties.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * BR-WAR-004: звернення за гарантією атомарне. Сховище в пам'яті ВИКОНУЄ `where` у
 * `updateMany`, тож два одночасні звернення поводяться як у базі: перевірки на початку `claim`
 * обидва проходять (кожне прочитало гарантію до запису іншого), а рішення приймає умова запису.
 * Без `claimedAt: null` у `where` друге звернення мовчки переписувало перше.
 */

type Row = Record<string, unknown>;

const ORG = 'org-1';
const W_ID = 'wty-1';
const DAY = 86_400_000;

const cmp = (v: unknown) => (v instanceof Date ? v.getTime() : v);

/** Рівність скалярів і `null`, `gt` — те, що бере `claim`. Інше — помилка, не «збіглося». */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, c]) => {
    if (c === undefined) return true;
    if (!(k in row)) throw new Error(`fake: поле «${k}» відсутнє`);
    if (c !== null && typeof c === 'object' && !(c instanceof Date)) {
      const ops = Object.keys(c);
      if (ops.length !== 1 || ops[0] !== 'gt') throw new Error(`fake: оператор ${ops.join()}`);
      return row[k] !== null && (cmp(row[k]) as number) > (cmp((c as Row).gt) as number);
    }
    return cmp(row[k]) === cmp(c);
  });
}

function buildStore(warranty: Row) {
  const warranties = [warranty];
  const workOrders = [
    { id: 'wo-a', orgId: ORG, deletedAt: null, counterpartyId: 'cp-1' },
    { id: 'wo-b', orgId: ORG, deletedAt: null, counterpartyId: 'cp-1' },
    { id: 'wo-other', orgId: ORG, deletedAt: null, counterpartyId: 'cp-2' },
  ];
  // Копія, не сам рядок: інакше «прочитане» першим зверненням мінялося б під ним записом другого
  // (GOTCHAS 2026-10-18), і гонка зникала б у тесті, лишаючись у базі.
  const find = (rows: Row[], where: Row) => {
    const r = rows.find(x => matches(x, where));
    return r ? { ...r } : null;
  };
  return {
    warranties,
    prisma: {
      warranty: {
        findFirst: vi.fn((a: { where: Row }) => Promise.resolve(find(warranties, a.where))),
        findFirstOrThrow: vi.fn((a: { where: Row }) => {
          const r = find(warranties, a.where);
          return r
            ? Promise.resolve({ ...r, workOrder: null, counterparty: null })
            : Promise.reject(new Error('not found'));
        }),
        updateMany: vi.fn((a: { where: Row; data: Row }) => {
          const hit = warranties.filter(r => matches(r, a.where));
          for (const r of hit) Object.assign(r, a.data);
          return Promise.resolve({ count: hit.length });
        }),
      },
      workOrder: {
        findFirst: vi.fn((a: { where: Row }) => Promise.resolve(find(workOrders, a.where))),
      },
    },
  };
}

const warrantyRow = (over: Row = {}): Row => ({
  id: W_ID,
  orgId: ORG,
  workOrderId: 'wo-origin',
  workOrderLineId: null,
  workOrderPartId: null,
  counterpartyId: 'cp-1',
  expiresAt: new Date(Date.now() + 30 * DAY),
  description: 'Гарантія',
  claimedAt: null,
  claimWoId: null,
  deletedAt: null,
  createdAt: new Date(),
  ...over,
});

async function serviceOver(prisma: unknown) {
  const module = await Test.createTestingModule({
    providers: [WarrantiesService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get(WarrantiesService);
}

describe('BR-WAR-004: звернення за гарантією — атомарний запис', () => {
  // guards: BR-WAR-004
  it('два одночасні звернення → одне звернення й одна відмова «вже використана»', async () => {
    const store = buildStore(warrantyRow());
    const service = await serviceOver(store.prisma);

    const results = await Promise.allSettled([
      service.claim(ORG, W_ID, { claimWoId: 'wo-a' }),
      service.claim(ORG, W_ID, { claimWoId: 'wo-b' }),
    ]);

    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(BadRequestException);
    expect((failed[0].reason as Error).message).toBe(
      translateError('err.warranty.alreadyClaimed', 'uk'),
    );
    // Записане звернення — переможця, друге його не переписало.
    const winner = (ok[0] as PromiseFulfilledResult<{ claimWoId: string }>).value.claimWoId;
    expect(store.warranties[0].claimWoId).toBe(winner);
  });

  // guards: BR-WAR-004
  it('гарантія закінчилась між перевіркою і записом → 400 «термін минув», нічого не записано', async () => {
    const store = buildStore(warrantyRow());
    // Перевірка на початку бачить чинну гарантію, а запис — уже ні (час минув між ними).
    store.prisma.warranty.findFirst.mockImplementationOnce(() =>
      Promise.resolve({
        claimedAt: null,
        expiresAt: new Date(Date.now() + DAY),
        workOrderId: 'wo-origin',
        counterpartyId: 'cp-1',
      }),
    );
    store.warranties[0].expiresAt = new Date(Date.now() - 1);
    const service = await serviceOver(store.prisma);

    await expect(service.claim(ORG, W_ID, { claimWoId: 'wo-a' })).rejects.toThrow(
      translateError('err.warranty.expired', 'uk'),
    );
    expect(store.warranties[0].claimedAt).toBeNull();
    expect(store.warranties[0].claimWoId).toBeNull();
  });

  // guards: BR-WAR-004
  it('звичайне звернення записує claimedAt і наряд-звернення', async () => {
    const store = buildStore(warrantyRow());
    const service = await serviceOver(store.prisma);

    const res = await service.claim(ORG, W_ID, { claimWoId: 'wo-a' });

    expect(res.claimWoId).toBe('wo-a');
    expect(store.warranties[0].claimedAt).toBeInstanceOf(Date);
  });

  // guards: BR-WAR-004 — рішення власника 2026-10-22: наряд-звернення того самого клієнта
  it('наряд-звернення іншого клієнта → 400, гарантія не використана', async () => {
    const store = buildStore(warrantyRow());
    const service = await serviceOver(store.prisma);

    await expect(service.claim(ORG, W_ID, { claimWoId: 'wo-other' })).rejects.toThrow(
      'Наряд-звернення належить іншому клієнту',
    );
    expect(store.warranties[0].claimedAt ?? null).toBeNull();
    expect(store.prisma.warranty.updateMany).not.toHaveBeenCalled();
  });
});
