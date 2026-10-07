/**
 * CounterpartiesService — рахунок розрахунків контрагента (BR-CP-012)
 *
 * `SettlementAccount` — singleton на контрагента. Його створює `create()` одразу, у тій
 * самій транзакції, що й самого контрагента. Лінивого створення немає:
 * `SettlementsService.createTransaction` без рахунку кидає NotFound (кейс у
 * `settlements/settlements.service.spec.ts`), тож контрагент без рахунку — це контрагент,
 * якому не можна провести жодної оплати чи нарахування.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import { statusesProvider } from './counterparties.spec-fixture';

describe('CounterpartiesService — рахунок розрахунків (SettlementAccount)', () => {
  let service: CounterpartiesService;
  let tx: {
    counterparty: { create: any; findFirstOrThrow: any };
    settlementAccount: { create: any };
    customerGarage: { create: any };
    counterpartyContract: { create: any };
  };
  let prisma: {
    settlementAccount: { create: any };
    organisationSettings: { findUnique: any };
    $transaction: any;
  };

  beforeEach(async () => {
    tx = {
      counterparty: {
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: 'cp-new',
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
      settlementAccount: { create: vi.fn().mockResolvedValue({}) },
      customerGarage: { create: vi.fn().mockResolvedValue({}) },
      counterpartyContract: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma = {
      // Поза транзакцією рахунок створюватись НЕ має — цей мок лишається невикликаним.
      settlementAccount: { create: vi.fn() },
      organisationSettings: { findUnique: vi.fn().mockResolvedValue({ currency: 'UAH' }) },
      $transaction: vi.fn().mockImplementation(async (cb: any) => cb(tx)),
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

  // guards: BR-CP-012
  it.each([
    ['CLIENT', { type: 'CLIENT', firstName: 'Іван' }],
    ['SUPPLIER', { type: 'SUPPLIER', companyName: 'ТОВ Постачальник' }],
    ['BOTH', { type: 'BOTH', companyName: 'ТОВ Обидва' }],
  ])(
    'create %s → рахунок створюється одразу, у тій самій транзакції, з нульовим балансом',
    async (_type, dto) => {
      await service.create('org-1', dto as any);

      expect(tx.settlementAccount.create).toHaveBeenCalledTimes(1);
      expect(tx.settlementAccount.create).toHaveBeenCalledWith({
        data: { orgId: 'org-1', counterpartyId: 'cp-new', balance: 0 },
      });
      // Саме tx-клієнт: рахунок поза транзакцією пережив би відкат створення контрагента.
      expect(prisma.settlementAccount.create).not.toHaveBeenCalled();
    },
  );
});
