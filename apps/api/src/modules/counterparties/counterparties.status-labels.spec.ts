/**
 * CounterpartiesService — статуси-мітки контрагента (assign / unassign / показ у DTO)
 *
 * Аспект BR-CP-010: M:N `CounterpartyStatusLink`. Перевіряється сервісна частина правила:
 * tenant-ізоляція обох сторін зв'язку, ідемпотентний assign (P2002 → no-op), 404 на зняття
 * непризначеної мітки, приховування soft-deleted статусу у DTO і скидання кешу довідника.
 *
 * ЧОГО ТУТ НЕМА: ролей (`@Roles` на контролері — RolesGuard у contract-спеку замокано) і
 * «soft-delete статусу лишає links» — це поведінка модуля `counterparty-statuses`.
 */

import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import { CounterpartyStatusesService } from '../counterparty-statuses/counterparty-statuses.service';
import type { PrismaModelMock } from '../../common/testing/prisma-mock';
import { statusesProvider } from './counterparties.spec-fixture';

describe('CounterpartiesService — статуси-мітки (assign / unassign)', () => {
  let service: CounterpartiesService;
  let invalidateCache: ReturnType<typeof vi.fn>;
  let prisma: {
    counterparty: PrismaModelMock;
    counterpartyStatus: PrismaModelMock;
    counterpartyStatusLink: PrismaModelMock;
  };

  /** Повний рядок контрагента, якого чекає toDto (findOne після assign/unassign). */
  const cpRow = (
    statusLinks: { status: { id: string; name: string; color: string; deletedAt: Date | null } }[],
  ) => ({
    id: 'cp-1',
    orgId: 'org-1',
    type: 'CLIENT',
    firstName: 'Іван',
    lastName: 'Петренко',
    companyName: null,
    edrpou: null,
    vatPayer: false,
    phone: null,
    email: null,
    notes: null,
    legalForm: null,
    legalAddress: null,
    actualAddress: null,
    bankAccount: null,
    bankName: null,
    contactPerson: null,
    taxNumber: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    settlementAccount: { balance: 0 },
    statusLinks,
  });

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue(cpRow([])) },
      counterpartyStatus: { findFirst: vi.fn().mockResolvedValue({ id: 'st-1' }) },
      counterpartyStatusLink: {
        create: vi.fn().mockResolvedValue({ id: 'link-1' }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        statusesProvider(),
      ],
    }).compile();

    service = module.get(CounterpartiesService);
    invalidateCache = (
      module.get(CounterpartyStatusesService) as unknown as {
        invalidateCache: ReturnType<typeof vi.fn>;
      }
    ).invalidateCache;
  });

  // guards: BR-CP-010
  it('assign: і контрагент, і статус шукаються у СВОЇЙ org (orgId + deletedAt:null)', async () => {
    await service.assignStatus('org-1', 'cp-1', 'st-1');

    expect(prisma.counterparty.findFirst.mock.calls[0][0].where).toEqual({
      id: 'cp-1',
      orgId: 'org-1',
      deletedAt: null,
    });
    expect(prisma.counterpartyStatus.findFirst.mock.calls[0][0].where).toEqual({
      id: 'st-1',
      orgId: 'org-1',
      deletedAt: null,
    });
    expect(prisma.counterpartyStatusLink.create).toHaveBeenCalledWith({
      data: { orgId: 'org-1', counterpartyId: 'cp-1', statusId: 'st-1' },
    });
  });

  // guards: BR-CP-010
  it('assign: контрагент не з цієї org → NotFound, link НЕ створюється', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);

    await expect(service.assignStatus('org-1', 'cp-foreign', 'st-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.counterpartyStatusLink.create).not.toHaveBeenCalled();
  });

  // guards: BR-CP-010
  it('assign: статус не з цієї org → NotFound, link НЕ створюється', async () => {
    prisma.counterpartyStatus.findFirst.mockResolvedValueOnce(null);

    await expect(service.assignStatus('org-1', 'cp-1', 'st-foreign')).rejects.toThrow(
      /Статус не знайдено/,
    );
    expect(prisma.counterpartyStatusLink.create).not.toHaveBeenCalled();
  });

  // guards: BR-CP-010
  it('assign ідемпотентний: P2002 (мітка вже призначена) → no-op, повертає DTO', async () => {
    prisma.counterpartyStatusLink.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.assignStatus('org-1', 'cp-1', 'st-1')).resolves.toMatchObject({
      id: 'cp-1',
    });
  });

  // guards: BR-CP-010
  it('assign: будь-яка ІНША помилка create не ковтається', async () => {
    prisma.counterpartyStatusLink.create.mockRejectedValueOnce(new Error('db down'));

    await expect(service.assignStatus('org-1', 'cp-1', 'st-1')).rejects.toThrow('db down');
  });

  // guards: BR-CP-010
  it('unassign: мітку не призначено (deleteMany.count === 0) → NotFound', async () => {
    prisma.counterpartyStatusLink.deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.unassignStatus('org-1', 'cp-1', 'st-1')).rejects.toThrow(/не призначено/);
    expect(invalidateCache).not.toHaveBeenCalled();
  });

  // guards: BR-CP-010
  it('unassign: видаляє link лише у своїй org (where містить orgId)', async () => {
    await service.unassignStatus('org-1', 'cp-1', 'st-1');

    expect(prisma.counterpartyStatusLink.deleteMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', counterpartyId: 'cp-1', statusId: 'st-1' },
    });
  });

  // guards: BR-CP-010
  it('assign і unassign скидають кеш довідника статусів своєї org', async () => {
    await service.assignStatus('org-1', 'cp-1', 'st-1');
    expect(invalidateCache).toHaveBeenCalledTimes(1);
    expect(invalidateCache).toHaveBeenLastCalledWith('org-1');

    await service.unassignStatus('org-1', 'cp-1', 'st-1');
    expect(invalidateCache).toHaveBeenCalledTimes(2);
    expect(invalidateCache).toHaveBeenLastCalledWith('org-1');
  });

  // guards: BR-CP-010
  it('DTO показує лише активні мітки: link на soft-deleted статус лишається, але прихований', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce(
      cpRow([
        { status: { id: 'st-1', name: 'VIP', color: '#f59e0b', deletedAt: null } },
        {
          status: {
            id: 'st-2',
            name: 'Чорний список',
            color: '#111827',
            deletedAt: new Date('2026-02-01T00:00:00Z'),
          },
        },
      ]),
    );

    const dto = await service.findOne('org-1', 'cp-1');

    expect(dto.statuses).toEqual([{ id: 'st-1', name: 'VIP', color: '#f59e0b' }]);
  });
});
