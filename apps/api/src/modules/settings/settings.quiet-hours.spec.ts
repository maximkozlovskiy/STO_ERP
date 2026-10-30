import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, it, expect, vi } from 'vitest';
import { validationExceptionFactory } from '../../common/pipes/validation-error.factory';
import { UpdateOrganisationSettingsDto } from './settings.dto';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Тихі години організації (docs/objects/automation.md, BR-AUT-013): налаштування приймає й віддає
// `quietHoursStart` / `quietHoursEnd` у форматі «ГГ:ХХ». До блоку 4 полів у DTO не було — PATCH
// відкидав їх як невідомі, і змінити типові 21:00–09:00 з інтерфейсу було неможливо.

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: validationExceptionFactory,
});
const validate = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: UpdateOrganisationSettingsDto });

async function messagesOf(body: Record<string, unknown>): Promise<string[]> {
  try {
    await validate(body);
  } catch (e) {
    if (e instanceof BadRequestException) {
      const res = e.getResponse() as { message: string | string[] };
      return Array.isArray(res.message) ? res.message : [res.message];
    }
    throw e;
  }
  return [];
}

describe('тихі години в налаштуваннях організації (BR-AUT-013)', () => {
  // guards: BR-AUT-013
  it('PATCH приймає «ГГ:ХХ» — і межі доби, і вікно через північ', async () => {
    await expect(validate({ quietHoursStart: '22:30', quietHoursEnd: '07:00' })).resolves.toEqual(
      expect.objectContaining({ quietHoursStart: '22:30', quietHoursEnd: '07:00' }),
    );
    await expect(validate({ quietHoursStart: '00:00', quietHoursEnd: '23:59' })).resolves.toEqual(
      expect.objectContaining({ quietHoursStart: '00:00', quietHoursEnd: '23:59' }),
    );
  });

  // guards: BR-AUT-013
  it.each(['24:00', '9:00', '21-00', '21:60', '', 'ніч'])(
    'PATCH відхиляє «%s» з текстом про формат ГГ:ХХ, а не загальним шаблоном',
    async value => {
      const messages = await messagesOf({ quietHoursStart: value });
      expect(messages).toContain('Формат “ГГ:ХХ” (00:00–23:59)');
    },
  );

  // guards: BR-AUT-013
  it('GET віддає збережені межі з рядка налаштувань', async () => {
    const row = {
      orgId: 'org-1',
      currency: 'UAH',
      vatMode: 'NONE',
      laborCostRatio: 0.4,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
      loyaltyRedeemRate: 1,
      supplierOptimalPriceWeight: 0.7,
      uiFeatures: {},
      quietHoursStart: '22:00',
      quietHoursEnd: '08:30',
      updatedAt: new Date('2026-10-30T00:00:00Z'),
    };
    const prisma = {
      organisationSettings: { findUnique: vi.fn().mockResolvedValue(row) },
    } as unknown as PrismaService;
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    const service = new SettingsService(
      prisma,
      redis as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const res = await service.getOrganisationSettings('org-1');

    expect(res).toMatchObject({ quietHoursStart: '22:00', quietHoursEnd: '08:30' });
  });
});
