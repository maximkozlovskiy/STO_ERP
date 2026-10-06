/**
 * CounterpartiesService — SUPPLIER потребує companyName (Bug #739)
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

// ─── Bug #739: TYPE-AWARE name-guard (SUPPLIER вимагає companyName) ───────────────
describe('CounterpartiesService — Bug #739: SUPPLIER потребує companyName (не приховане ім)', () => {
  let service: CounterpartiesService;
  let prisma: {
    counterparty: { findFirst: any; update: any; create: any; findFirstOrThrow: any };
    settlementAccount: { create: any };
    customerGarage: { create: any };
    organisationSettings: { findUnique: any };
    counterpartyContract: { create: any };
    $transaction: any;
  };

  beforeEach(async () => {
    prisma = {
      counterparty: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({
          id: 'cp-1',
          orgId: 'org-1',
          type: 'SUPPLIER',
          firstName: null,
          lastName: null,
          companyName: 'ТОВ Пост',
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
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          settlementAccount: { balance: 0 },
        }),
        create: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      settlementAccount: { create: vi.fn() },
      customerGarage: { create: vi.fn() },
      organisationSettings: { findUnique: vi.fn().mockResolvedValue({ currency: 'UAH' }) },
      counterpartyContract: { create: vi.fn() },
      $transaction: vi.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn().mockResolvedValue('ДГ-1') } },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        statusesProvider(),
      ],
    }).compile();
    service = module.get(CounterpartiesService);
  });

  it('create SUPPLIER лише з firstName (без companyName) → BadRequestException', async () => {
    await expect(
      service.create('org-1', { type: 'SUPPLIER', firstName: 'Іван' } as any),
    ).rejects.toThrow(/назву компанії/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('create CLIENT лише з firstName (без companyName) → дозволено (guard пропускає)', async () => {
    // CLIENT-гілка не потребує contract → одразу входить у $transaction; мокаємо його no-op
    prisma.$transaction.mockImplementation(async (cb: any) =>
      cb({
        counterparty: {
          create: vi.fn().mockResolvedValue({ id: 'cp-1' }),
          findFirstOrThrow: vi.fn().mockResolvedValue({
            id: 'cp-1',
            orgId: 'org-1',
            type: 'CLIENT',
            firstName: 'Іван',
            lastName: null,
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
            createdAt: new Date(),
            updatedAt: new Date(),
            settlementAccount: { balance: 0 },
          }),
        },
        settlementAccount: { create: vi.fn() },
        customerGarage: { create: vi.fn() },
      }),
    );
    await expect(
      service.create('org-1', { type: 'CLIENT', firstName: 'Іван' } as any),
    ).resolves.toBeDefined();
  });

  it('update CLIENT(firstName-only)→SUPPLIER без companyName → BadRequestException (ефективний тип)', async () => {
    // existing: CLIENT з firstName, без companyName. PATCH міняє лише type→SUPPLIER.
    prisma.counterparty.findFirst.mockResolvedValue({
      type: 'CLIENT',
      companyName: null,
      firstName: 'Іван',
      lastName: null,
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
    });
    await expect(service.update('org-1', 'cp-1', { type: 'SUPPLIER' } as any)).rejects.toThrow(
      /назву компанії/i,
    );
    expect(prisma.counterparty.update).not.toHaveBeenCalled();
  });

  it('update SUPPLIER з companyName → проходить', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      type: 'SUPPLIER',
      companyName: 'ТОВ Пост',
      firstName: null,
      lastName: null,
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
    });
    await expect(
      service.update('org-1', 'cp-1', { phone: '+380501112233' } as any),
    ).resolves.toBeDefined();
    expect(prisma.counterparty.update).toHaveBeenCalled();
  });
});
