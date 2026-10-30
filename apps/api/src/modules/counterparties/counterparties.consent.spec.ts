/**
 * Згода контрагента на повідомлення й статус підписки на Telegram-бот (docs/objects/automation.md,
 * BR-AUT-042, 041): «не надсилати службові», «згода на маркетинг» (дату й автора ставить сервер),
 * бажаний канал — через API оновлення, зміни — у журналі змін; картка показує підписку на бот.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { counterpartyFormSchema, counterpartyUpdateSchema } from '@sto/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { memoryTable } from '../cash/cash.spec-fixture';
import type { CounterpartyStatusesService } from '../counterparty-statuses/counterparty-statuses.service';
import type { DocumentNumberService } from '../document-number/document-number.service';
import { UpdateCounterpartyDto } from './counterparties.dto';
import { CounterpartiesService } from './counterparties.service';

const ORG = 'org-a';
const CP = 'cp-1';
const USER = 'e-admin';

function setup(row: Record<string, unknown> = {}, subscriptions: Record<string, unknown>[] = []) {
  const counterparty = memoryTable([
    {
      id: CP,
      orgId: ORG,
      type: 'CLIENT',
      firstName: 'Іван',
      lastName: 'Петренко',
      companyName: null,
      phone: '+380671112233',
      noServiceMessages: false,
      marketingConsent: false,
      marketingConsentAt: null,
      marketingConsentById: null,
      preferredChannel: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      settlementAccount: null,
      statusLinks: [],
      ...row,
    },
  ]);
  // Prisma віддає КОПІЮ рядка: знімок «до зміни» не мутує подальший update (журнал змін).
  const read = counterparty.findFirst;
  counterparty.findFirst = vi.fn((args?: never) =>
    read(args).then(r => (r ? { ...r } : r)),
  ) as typeof read;
  const prisma = {
    counterparty,
    telegramSubscription: memoryTable(subscriptions),
  } as unknown as PrismaService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new CounterpartiesService(
    prisma,
    {} as DocumentNumberService,
    audit as unknown as AuditService,
    { invalidateCache: vi.fn() } as unknown as CounterpartyStatusesService,
  );
  return { service, row: counterparty.rows[0]!, audit };
}

describe('Згода контрагента на повідомлення (BR-AUT-042)', () => {
  // guards: BR-AUT-042
  it('згода на маркетинг — сервер ставить дату й автора; відповідь віддає поля згоди', async () => {
    const { service, row } = setup();
    const before = Date.now();
    const res = await service.update(ORG, CP, { marketingConsent: true }, USER);
    expect(row.marketingConsent).toBe(true);
    expect(row.marketingConsentById).toBe(USER);
    expect((row.marketingConsentAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(res).toMatchObject({
      marketingConsent: true,
      marketingConsentById: USER,
      marketingConsentAt: (row.marketingConsentAt as Date).toISOString(),
      noServiceMessages: false,
      preferredChannel: null,
    });
  });

  // guards: BR-AUT-042
  it('той самий стан згоди чи інші поля — дата й автор згоди не переписуються', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const { service, row } = setup({
      marketingConsent: true,
      marketingConsentAt: at,
      marketingConsentById: 'e-first',
    });
    await service.update(ORG, CP, { marketingConsent: true, noServiceMessages: true }, USER);
    await service.update(ORG, CP, { preferredChannel: 'TELEGRAM_BOT' }, USER);
    expect(row).toMatchObject({
      marketingConsentAt: at,
      marketingConsentById: 'e-first',
      noServiceMessages: true,
      preferredChannel: 'TELEGRAM_BOT',
    });

    // Відкликання згоди — теж зміна: нова дата й автор.
    await service.update(ORG, CP, { marketingConsent: false }, USER);
    expect(row.marketingConsentById).toBe(USER);
    expect(row.marketingConsentAt).not.toBe(at);
  });

  // guards: BR-AUT-042
  it('зміни згоди — у журналі змін контрагента: було → стало', async () => {
    const { service, audit } = setup();
    await service.update(
      ORG,
      CP,
      { noServiceMessages: true, marketingConsent: true, preferredChannel: 'SMS' },
      USER,
    );
    expect(audit.record).toHaveBeenCalledWith(
      ORG,
      'Counterparty',
      CP,
      'UPDATE',
      USER,
      { noServiceMessages: false, marketingConsent: false, preferredChannel: null },
      { noServiceMessages: true, marketingConsent: true, preferredChannel: 'SMS' },
    );
  });

  // guards: BR-AUT-042, BR-AUT-011, BR-CP-016 (Bug #1000, #1001)
  it('тіло PATCH / POST проходить схему контролера: поля згоди й бажаний канал не губляться, vatPayer не скидається, null у прапорцях — 400', () => {
    const pipe = (
      schema: typeof counterpartyUpdateSchema | typeof counterpartyFormSchema,
      body: unknown,
    ): Record<string, unknown> =>
      new ZodValidationPipe<Record<string, unknown>>(schema).transform(body);
    const consent = {
      noServiceMessages: true,
      marketingConsent: true,
      preferredChannel: 'TELEGRAM_BOT',
    };
    expect(pipe(counterpartyUpdateSchema, consent)).toEqual(consent);
    expect(
      pipe(counterpartyFormSchema, { type: 'CLIENT', firstName: 'Іван', ...consent }),
    ).toMatchObject(consent);
    expect(pipe(counterpartyUpdateSchema, { preferredChannel: null })).toEqual({
      preferredChannel: null,
    });
    // Частковий PATCH не чіпає того, чого в ньому немає (Bug #1001: vatPayer → false).
    expect(pipe(counterpartyUpdateSchema, { notes: 'дзвонити після 18:00' })).toEqual({
      notes: 'дзвонити після 18:00',
    });
    for (const bad of [
      { noServiceMessages: null },
      { marketingConsent: null },
      { preferredChannel: 'PIGEON' },
    ]) {
      expect(() => pipe(counterpartyUpdateSchema, bad)).toThrow(BadRequestException);
    }
  });

  // guards: BR-AUT-042
  it('DTO: бажаний канал — лише з переліку каналів (null — очистити); прапорці — boolean', () => {
    const errors = (body: Record<string, unknown>) =>
      validateSync(plainToInstance(UpdateCounterpartyDto, body)).map(e => e.property);
    expect(errors({ preferredChannel: 'TELEGRAM_BOT', marketingConsent: false })).toEqual([]);
    expect(errors({ preferredChannel: null })).toEqual([]);
    expect(errors({ preferredChannel: 'PIGEON' })).toEqual(['preferredChannel']);
    expect(errors({ noServiceMessages: 'так' })).toEqual(['noServiceMessages']);
  });
});

describe('Картка контрагента — підписка на Telegram-бот (BR-AUT-041)', () => {
  // guards: BR-AUT-041, BR-AUT-052
  it('активна підписка своєї org — active і дата; вимкнена чи чужа — не підписаний', async () => {
    const at = new Date('2026-10-30T08:00:00.000Z');
    const sub = (over: Record<string, unknown>) => ({
      orgId: ORG,
      counterpartyId: CP,
      chatId: '700100',
      active: true,
      deletedAt: null,
      subscribedAt: at,
      ...over,
    });
    const active = setup({}, [sub({}), sub({ active: false, subscribedAt: new Date() })]);
    expect((await active.service.findOne(ORG, CP)).telegramSubscription).toEqual({
      active: true,
      subscribedAt: at.toISOString(),
    });
    const none = setup({}, [sub({ active: false }), sub({ orgId: 'org-b' })]);
    expect((await none.service.findOne(ORG, CP)).telegramSubscription).toEqual({
      active: false,
      subscribedAt: null,
    });
  });
});
