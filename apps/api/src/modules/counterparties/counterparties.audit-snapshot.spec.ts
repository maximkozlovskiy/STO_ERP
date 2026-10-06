/**
 * CounterpartiesService — коректність audit-знімка в update() (Bug #719)
 *
 * Виділено з `counterparties.service.spec.ts` (був 1194 рядки, 5 незалежних
 * top-level describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не
 * змінені — інакше `fullName` у test-baseline.json розійшовся б.
 *
 * `statusesMock` замінено на `statusesProvider()` з `./counterparties.spec-fixture`:
 * module-level `const` із `vi.fn()` при `isolate: false` течий би між файлами.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import { statusesProvider } from './counterparties.spec-fixture';

describe('CounterpartiesService — Bug #719: коректність audit-знімка в update()', () => {
  let service: CounterpartiesService;
  let auditRecord: ReturnType<typeof vi.fn>;
  let prisma: {
    counterparty: { findFirst: any; update: any };
  };

  const existingRow = {
    type: 'CLIENT',
    companyName: 'ТОВ Старе',
    firstName: null,
    lastName: null,
    edrpou: '12345678',
    vatPayer: true,
    phone: '+380501112233',
    email: 'old@sto.ua',
    notes: null,
    legalForm: null,
    legalAddress: null,
    actualAddress: null,
    bankAccount: null,
    bankName: null,
    contactPerson: null,
    taxNumber: null,
  };

  beforeEach(async () => {
    auditRecord = vi.fn().mockResolvedValue(undefined);
    prisma = {
      counterparty: {
        findFirst: vi.fn().mockResolvedValue(existingRow),
        update: vi.fn().mockResolvedValue({
          id: 'cp-1',
          orgId: 'org-1',
          type: 'CLIENT',
          firstName: null,
          lastName: null,
          companyName: 'ТОВ Старе',
          edrpou: '12345678',
          vatPayer: true,
          phone: '+380509998877',
          email: 'old@sto.ua',
          notes: null,
          legalForm: null,
          legalAddress: null,
          actualAddress: null,
          bankAccount: null,
          bankName: null,
          contactPerson: null,
          taxNumber: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          settlementAccount: { balance: 0 },
        }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: AuditService, useValue: { record: auditRecord } },
        statusesProvider(),
      ],
    }).compile();

    service = module.get(CounterpartiesService);
  });

  it('record() отримує правильні позиційні аргументи (orgId/Counterparty/id/UPDATE/userId)', async () => {
    await service.update('org-1', 'cp-1', { phone: '+380509998877' } as any, 'user-42');
    // best-effort .catch — дочекатись мікротаску, щоб spy встиг зафіксувати виклик
    await Promise.resolve();
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const args = auditRecord.mock.calls[0];
    expect(args[0]).toBe('org-1'); // orgId
    expect(args[1]).toBe('Counterparty'); // entityType
    expect(args[2]).toBe('cp-1'); // entityId
    expect(args[3]).toBe('UPDATE'); // action
    expect(args[4]).toBe('user-42'); // userId
  });

  it('old-snapshot НЕ містить id і НЕ містить полів поза PATCH (нема фейкового «→undefined»)', async () => {
    await service.update('org-1', 'cp-1', { phone: '+380509998877' } as any, 'user-42');
    await Promise.resolve();
    const oldData = auditRecord.mock.calls[0][5] as Record<string, unknown>;
    // лише ключ phone (єдине змінене поле)
    expect(Object.keys(oldData)).toEqual(['phone']);
    expect(oldData).not.toHaveProperty('id');
    expect(oldData).not.toHaveProperty('companyName');
    expect(oldData).not.toHaveProperty('email');
  });

  it('old-snapshot містить СПРАВЖНЄ попереднє значення зміненого поля (before, не after)', async () => {
    await service.update('org-1', 'cp-1', { phone: '+380509998877' } as any, 'user-42');
    await Promise.resolve();
    const oldData = auditRecord.mock.calls[0][5] as Record<string, unknown>;
    const newData = auditRecord.mock.calls[0][6] as Record<string, unknown>;
    expect(oldData.phone).toBe('+380501112233'); // значення ДО зміни
    expect(newData.phone).toBe('+380509998877'); // значення dto (після)
  });

  it('userId відсутній → record() НЕ викликається (best-effort gate)', async () => {
    await service.update('org-1', 'cp-1', { phone: '+380509998877' } as any, undefined);
    await Promise.resolve();
    expect(auditRecord).not.toHaveBeenCalled();
  });
});
