/**
 * Видалення контрагента з підключенням до API постачальника — BR-CP-019 (рішення власника
 * 2026-11-06, TECH-DEBT (б) №89).
 *
 * Аспект відділено від `counterparties.crud-search.spec.ts` (там MD-H1 — борг і відкриті
 * документи): тут лише підключення. Підробка `supplierConnection.findMany` ВИКОНУЄ `where` над
 * записами в пам'яті — чужа організація, чужий контрагент, вимкнене й видалене підключення справді
 * «не знаходяться», тож тест падає, якщо сервіс забув умову (заготовка `mockResolvedValue` цього не
 * ловить).
 *
 * Mutation-verify (кожна мутація валить названі кейси):
 *  · прибрати перевірку підключень → «увімкнене підключення → 409»;
 *  · прибрати `enabled: true` з where → «вимкнене підключення не заважає»;
 *  · прибрати `deletedAt: null` → «видалене підключення не заважає»;
 *  · прибрати `orgId` → «підключення іншої організації не заважає»;
 *  · назва лише з `name` (без назви провайдера) → «назва — власна або провайдера».
 */
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { vi, describe, it, expect } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import { statusesProvider } from './counterparties.spec-fixture';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const CP = 'cp-1';
const OTHER_CP = 'cp-2';

interface Connection {
  id: string;
  orgId: string;
  counterpartyId: string;
  provider: string;
  name: string | null;
  enabled: boolean;
  deletedAt: Date | null;
  createdAt: Date;
}

let seq = 0;
const connection = (over: Partial<Connection> = {}): Connection => ({
  id: `conn-${++seq}`,
  orgId: ORG,
  counterpartyId: CP,
  provider: 'UTR',
  name: null,
  enabled: true,
  deletedAt: null,
  createdAt: new Date(`2026-11-0${(seq % 9) + 1}T10:00:00.000Z`),
  ...over,
});

/** Збіг запису з плоским `where` (рівність полів) — рівно те, що пише сервіс. */
const matches = (rec: Connection, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === 'object') {
      throw new Error(`Підробка не розуміє фільтр ${key} = ${JSON.stringify(value)}`);
    }
    return (rec as unknown as Record<string, unknown>)[key] === value;
  });

async function setup(connections: Connection[]) {
  const supplierConnection = {
    findMany: vi.fn(
      (args: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
        orderBy?: { createdAt: 'asc' | 'desc' };
      }) => {
        const hit = connections
          .filter(c => matches(c, args.where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        // Суворий select: сервіс бачить лише вибрані поля.
        return Promise.resolve(
          hit.map(c =>
            Object.fromEntries(
              Object.keys(args.select).map(k => [k, (c as unknown as Record<string, unknown>)[k]]),
            ),
          ),
        );
      },
    ),
  };
  const prisma = {
    counterparty: {
      findFirst: vi.fn().mockResolvedValue({ settlementAccount: { balance: 0 } }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    counterpartyStatusLink: { findFirst: vi.fn().mockResolvedValue(null) },
    workOrder: { count: vi.fn().mockResolvedValue(0) },
    purchaseOrder: { count: vi.fn().mockResolvedValue(0) },
    invoice: { count: vi.fn().mockResolvedValue(0) },
    supplierConnection,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      CounterpartiesService,
      { provide: PrismaService, useValue: prisma },
      { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
      statusesProvider(),
    ],
  }).compile();
  return { prisma, service: moduleRef.get(CounterpartiesService) };
}

describe('CounterpartiesService.remove — підключення до API постачальника (BR-CP-019)', () => {
  // guards: BR-CP-019
  it('увімкнене підключення → 409 з назвою підключення, контрагент не видаляється', async () => {
    const { prisma, service } = await setup([connection({ name: 'UTR — основний склад' })]);

    const err = await service.remove(ORG, CP).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(
      translateError('err.counterparty.hasActiveSupplierConnections', 'uk', {
        names: 'UTR — основний склад',
      }),
    );
    expect(prisma.counterparty.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-CP-019
  it('назва — власна або назва провайдера з реєстру; кілька — через кому, у порядку створення', async () => {
    const { service } = await setup([
      connection({ provider: 'BM_PARTS', name: null }),
      connection({ provider: 'UTR', name: '  ' }),
      connection({ provider: 'TEHNOMIR', name: 'Техномир опт' }),
    ]);

    await expect(service.remove(ORG, CP)).rejects.toThrow(
      translateError('err.counterparty.hasActiveSupplierConnections', 'uk', {
        names: 'BM Parts, UTR (UniqTrade), Техномир опт',
      }),
    );
  });

  // guards: BR-CP-019
  it.each([
    ['вимкнене', { enabled: false }],
    ['видалене', { deletedAt: new Date('2026-11-01T00:00:00.000Z') }],
    ['іншого контрагента', { counterpartyId: OTHER_CP }],
    ['іншої організації', { orgId: OTHER_ORG }],
  ])('підключення %s не заважає — контрагента видалено', async (_name, over) => {
    const { prisma, service } = await setup([connection(over)]);

    await service.remove(ORG, CP);

    expect(prisma.counterparty.updateMany).toHaveBeenCalledTimes(1);
  });

  // guards: BR-CP-019
  it('перевірка — до запису й у межах організації: where orgId + контрагент + увімкнене + не видалене', async () => {
    const { prisma, service } = await setup([]);

    await service.remove(ORG, CP);

    expect(prisma.supplierConnection.findMany.mock.calls[0]![0].where).toEqual({
      orgId: ORG,
      counterpartyId: CP,
      enabled: true,
      deletedAt: null,
    });
    expect(prisma.supplierConnection.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.counterparty.updateMany.mock.invocationCallOrder[0]!,
    );
  });
});
