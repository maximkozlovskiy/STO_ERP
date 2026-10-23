import 'reflect-metadata';
import { BadRequestException, ValidationPipe, type Type } from '@nestjs/common';
import { describe, it, expect } from 'vitest';
import { FiscalProvidersController } from './fiscal-providers.controller';
import { PaymentGatewaysController } from './payment-gateways.controller';
import { BankStatementProvidersController } from '../bank-statements/bank-statement-providers.controller';
import { DeliveryProvidersController } from '../purchase-orders/delivery/delivery-providers.controller';

/**
 * PATCH …/branch/:id (upsert конфіга провайдера) НЕ приймає `enabled` (рішення власника 2026-10-23):
 * увімкнення — лише через POST …/activate, де креди обов'язкові й активний один на філію й тип.
 * `enabled` в upsert обходив обидві перевірки (знахідка review блоку CodeQL).
 *
 * DTO-класи не експортуються — тип тіла береться з метаданих параметрів `upsert` і йде через той
 * самий ValidationPipe, що в main.ts (whitelist + forbidNonWhitelisted).
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

const upsertBodyType = (controller: Type<unknown>): Type<unknown> => {
  const params = Reflect.getMetadata(
    'design:paramtypes',
    controller.prototype as object,
    'upsert',
  ) as Type<unknown>[];
  const dto = params.find(p => /Upsert\w*Dto$/.test(p.name));
  if (!dto) throw new Error(`${controller.name}.upsert: немає Upsert*Dto серед параметрів`);
  return dto;
};

const validate = (controller: Type<unknown>, body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: upsertBodyType(controller) });

describe.each([
  ['фіскалізація', FiscalProvidersController],
  ['еквайринг', PaymentGatewaysController],
  ['банк-виписки', BankStatementProvidersController],
  ['доставка', DeliveryProvidersController],
])('PATCH upsert провайдера (%s)', (_name, controller) => {
  it('`enabled` у тілі → 400 (увімкнення лише через activate)', async () => {
    await expect(validate(controller, { provider: 'x', enabled: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('без `enabled` — тіло проходить', async () => {
    await expect(
      validate(controller, { provider: 'x', apiUrl: 'https://api.example', credentials: {} }),
    ).resolves.toMatchObject({ provider: 'x' });
  });
});
