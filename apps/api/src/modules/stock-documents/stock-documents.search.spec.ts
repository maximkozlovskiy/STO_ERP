/**
 * StockDocumentsService.findAll — пошук (`q`) у списку складських документів.
 *
 * Рішення власника 2026-10-09: на всіх сторінках документів є пошук і відбір за датою. До цього
 * `q` у `StockDocumentQueryDto` приймався, але сервіс його ігнорував — поле пошуку нічого б не
 * звужувало.
 *
 * Mutation-verify: (1) прибрати гілку `where.OR` → кейси 1 і 2 падають; (2) перенести orgId
 * всередину OR → кейс про tenant падає; (3) шукати лише за номером → кейс 1 падає.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StockDocumentsService } from './stock-documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';

describe('StockDocumentsService.findAll — пошук за номером і приміткою', () => {
  let service: StockDocumentsService;
  let prisma: {
    stockDocument: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  };
  const ORG = 'org-1';

  beforeEach(async () => {
    prisma = {
      stockDocument: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        StockDocumentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      ],
    }).compile();
    service = module.get(StockDocumentsService);
  });

  const whereOf = (mock: ReturnType<typeof vi.fn>) =>
    (mock.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
  const search = (q?: string, status?: string) =>
    service.findAll(
      ORG,
      1,
      20,
      undefined,
      status,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      q,
    );

  it('q шукає за номером АБО приміткою, без урахування регістру', async () => {
    await search('спс-2026');

    expect(whereOf(prisma.stockDocument.findMany).OR).toEqual([
      { number: { contains: 'спс-2026', mode: 'insensitive' } },
      { notes: { contains: 'спс-2026', mode: 'insensitive' } },
    ]);
  });

  it('пошук діє і на вибірку, і на лічильник — сторінок стільки, скільки знайдено', async () => {
    await search('брак');

    expect(whereOf(prisma.stockDocument.count)).toEqual(whereOf(prisma.stockDocument.findMany));
  });

  it('orgId і deletedAt лишаються на верхньому рівні — OR не відкриває чужі документи', async () => {
    await search('1', 'DRAFT');

    const where = whereOf(prisma.stockDocument.findMany);
    expect(where).toMatchObject({ orgId: ORG, deletedAt: null, status: 'DRAFT' });
    expect(JSON.stringify(where.OR)).not.toContain('orgId');
  });

  it.each([undefined, '', '   '])('порожній пошук (%j) умови не додає', async q => {
    await search(q);

    expect(whereOf(prisma.stockDocument.findMany)).not.toHaveProperty('OR');
  });

  // Prisma значення `contains` не екранує: без escapeLike «%» знаходив би всі документи.
  it('символи підстановки LIKE (% _ і зворотна коса) шукаються буквально', async () => {
    await search('50%_знижка\\');

    const contains = { contains: '50\\%\\_знижка\\\\', mode: 'insensitive' };
    expect(whereOf(prisma.stockDocument.findMany).OR).toEqual([
      { number: contains },
      { notes: contains },
    ]);
  });

  it('пробіли довкола запиту обрізаються', async () => {
    await search('  ПРХ-7  ');

    const or = whereOf(prisma.stockDocument.findMany).OR as { number?: { contains: string } }[];
    expect(or[0]!.number!.contains).toBe('ПРХ-7');
  });
});
