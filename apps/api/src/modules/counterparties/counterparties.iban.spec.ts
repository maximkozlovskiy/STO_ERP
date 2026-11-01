/**
 * CounterpartiesService — IBAN для автозіставлення виписок (BR-CP-018, TECH-DEBT (а) §8 L441).
 *
 * `Counterparty.iban` — ключ зіставлення рядка виписки з контрагентом (`payerIban`). Шляху запису в API
 * не було: збіг працював лише для контрагентів зі старого backfill-у. Тепер IBAN виводиться з реквізиту
 * «Розрахунковий рахунок» (`bankAccount`) при створенні й зміні.
 */
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { ibanFromBankAccount } from './counterparty-iban';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import { statusesProvider } from './counterparties.spec-fixture';

const IBAN = 'UA213223130000026007233566001';

describe('ibanFromBankAccount — IBAN з реквізиту (BR-CP-018)', () => {
  // guards: BR-CP-018
  it.each([
    ['чистий IBAN', IBAN, IBAN],
    ['з пробілами й малими літерами', 'ua21 3223 1300 0002 6007 2335 66001', IBAN],
    ['у тексті реквізиту', `р/р ${IBAN} в АТ «Банк»`, IBAN],
    ['не IBAN (номер картки)', '4149 4393 1234 5678', null],
    ['IBAN іншої країни', 'DE89370400440532013000', null],
    ['коротший за 29 знаків', 'UA2132231300000260072335660', null],
    ['порожньо', '', null],
    ['null', null, null],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(ibanFromBankAccount(input)).toBe(expected);
  });
});

describe('CounterpartiesService — iban пишеться з bankAccount (BR-CP-018)', () => {
  let service: CounterpartiesService;
  const row = {
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
    deletedAt: null,
    settlementAccount: { balance: 0 },
  };
  const txCreate = vi.fn();
  const prisma = {
    counterparty: { findFirst: vi.fn(), update: vi.fn() },
    organisationSettings: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma.counterparty.findFirst.mockResolvedValue({ ...row, marketingConsent: false });
    prisma.counterparty.update.mockResolvedValue(row);
    txCreate.mockResolvedValue({ id: 'cp-1' });
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        counterparty: { create: txCreate, findFirstOrThrow: vi.fn().mockResolvedValue(row) },
        settlementAccount: { create: vi.fn() },
        customerGarage: { create: vi.fn() },
      }),
    );
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
  });

  // guards: BR-CP-018
  it('створення з реквізитом → iban нормалізований; без реквізиту → null', async () => {
    await service.create('org-1', {
      type: 'CLIENT',
      firstName: 'Іван',
      bankAccount: 'UA21 3223 1300 0002 6007 2335 66001',
    } as never);
    expect(txCreate.mock.calls[0][0].data.iban).toBe(IBAN);

    await service.create('org-1', { type: 'CLIENT', firstName: 'Іван' } as never);
    expect(txCreate.mock.calls[1][0].data.iban).toBeNull();
  });

  // guards: BR-CP-018
  it('зміна реквізиту оновлює iban; PATCH без реквізиту iban не чіпає', async () => {
    await service.update('org-1', 'cp-1', { bankAccount: `р/р ${IBAN}` } as never);
    expect(prisma.counterparty.update.mock.calls[0][0].data.iban).toBe(IBAN);

    await service.update('org-1', 'cp-1', { phone: '+380671234567' } as never);
    expect(prisma.counterparty.update.mock.calls[1][0].data).not.toHaveProperty('iban');
  });
});
