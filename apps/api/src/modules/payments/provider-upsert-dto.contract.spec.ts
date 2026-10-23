import 'reflect-metadata';
import { BadRequestException, ValidationPipe, type Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { describe, it, expect } from 'vitest';
import { validationExceptionFactory } from '../../common/pipes/validation-error.factory';
import { FiscalProvidersController } from './fiscal-providers.controller';
import { PaymentGatewaysController } from './payment-gateways.controller';
import { BankStatementProvidersController } from '../bank-statements/bank-statement-providers.controller';
import { DeliveryProvidersController } from '../purchase-orders/delivery/delivery-providers.controller';

/**
 * PATCH …/branch/:id (upsert конфіга провайдера) НЕ приймає `enabled` (рішення власника 2026-10-23):
 * увімкнення — лише через POST …/activate, де креди обов'язкові й активний один на філію й тип.
 * `enabled` в upsert обходив обидві перевірки (знахідка review блоку CodeQL).
 *
 * DTO-класи не експортуються — тип тіла береться з метаданих: позиція параметра з `@Body()`
 * (route-args Nest) → його тип у `design:paramtypes`. Не залежить ні від назви DTO, ні від порядку
 * параметрів. Тіло йде через той самий ValidationPipe, що в main.ts.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: validationExceptionFactory,
});

const upsertBodyType = (controller: Type<unknown>): Type<unknown> => {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, 'upsert') ?? {}) as Record<
    string,
    { index: number }
  >;
  const bodyKey = Object.keys(args).find(k => k.startsWith(`${RouteParamtypes.BODY}:`));
  if (!bodyKey) throw new Error(`${controller.name}.upsert: немає параметра з @Body()`);
  const params = Reflect.getMetadata(
    'design:paramtypes',
    controller.prototype as object,
    'upsert',
  ) as Type<unknown>[];
  const dto = params[args[bodyKey]!.index];
  // Object/undefined — тіло без класу: ValidationPipe нічого б не перевірив, і спек хибно зеленів би.
  if (!dto || dto === Object) throw new Error(`${controller.name}.upsert: тіло без DTO-класу`);
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
  // guards: BR-PAY-013
  it.each([true, false])('`enabled: %s` у тілі → 400 (стан вмикає лише activate)', async value => {
    await expect(validate(controller, { provider: 'x', enabled: value })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('без `enabled` — тіло проходить', async () => {
    await expect(
      validate(controller, { provider: 'x', apiUrl: 'https://api.example', credentials: {} }),
    ).resolves.toMatchObject({ provider: 'x' });
  });
});
