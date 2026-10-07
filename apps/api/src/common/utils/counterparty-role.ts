import { BadRequestException } from '@nestjs/common';
import type { CounterpartyType } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';

/** Роль, у якій контрагент входить у документ: покупець (наряд, рахунок) чи постачальник (PO, оплата). */
export type CounterpartyRole = 'client' | 'supplier';

const FORBIDDEN_TYPE: Record<CounterpartyRole, CounterpartyType> = {
  client: 'SUPPLIER',
  supplier: 'CLIENT',
};

const ERROR_KEY = {
  client: 'err.counterparty.notAClient',
  supplier: 'err.counterparty.notASupplier',
} as const;

/**
 * BR-CP-001: CLIENT — лише в клієнтських документах, SUPPLIER — лише в документах постачальника,
 * BOTH — в обох. До 2026-10-07 це тримали тільки фільтри пікерів у web: через API, імпорт чи
 * mobile можна було створити замовлення постачальнику на клієнта.
 *
 * Приймає вже прочитаний `type`, а не id: сервіси читають контрагента у своєму `Promise.all`
 * разом з іншими FK, і окремий запит тут додав би RTT.
 */
export function assertCounterpartyRole(type: CounterpartyType, role: CounterpartyRole): void {
  if (type === FORBIDDEN_TYPE[role]) {
    throw new BadRequestException(translateError(ERROR_KEY[role], getLocale()));
  }
}
