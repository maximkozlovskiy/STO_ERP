/**
 * Хто що може в касі (BR-CASH-014) — ролі на маршрутах `/cash-registers`.
 *
 * HTTP-ендпоінти каси живуть на `CashRegistersController` (модуль `cash-registers`), а не в
 * модулі `cash`: `CashModule` лише експортує сервіс. Читаємо метадані декоратора `@Roles`,
 * які `RolesGuard` звіряє з роллю користувача.
 */
import { describe, it, expect } from 'vitest';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { CashRegistersController } from '../cash-registers/cash-registers.controller';

const rolesOf = (method: keyof CashRegistersController): string[] =>
  [
    ...((Reflect.getMetadata(ROLES_KEY, CashRegistersController.prototype[method]) as
      string[] | undefined) ?? []),
  ].sort();

describe('CashRegistersController — ролі доступу до каси', () => {
  // guards: BR-CASH-014
  it('ручну операцію (внести/видати) проводять лише OWNER, ADMIN, ACCOUNTANT — без приймальника', () => {
    expect(rolesOf('createOperation')).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER']);
  });

  // guards: BR-CASH-014
  it.each(['findAll', 'balance', 'operations'] as const)(
    '%s — перегляд: OWNER, ADMIN, ACCOUNTANT і RECEPTIONIST',
    method => {
      expect(rolesOf(method)).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER', 'RECEPTIONIST']);
    },
  );

  // guards: BR-CASH-014
  it('картку однієї каси (findOne) відкривають OWNER, ADMIN, ACCOUNTANT — без приймальника', () => {
    expect(rolesOf('findOne')).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER']);
  });

  // guards: BR-CASH-014
  it.each(['create', 'update', 'remove'] as const)('%s каси — лише OWNER і ADMIN', method => {
    expect(rolesOf(method)).toEqual(['ADMIN', 'OWNER']);
  });
});
