/**
 * Хто бачить взаєморозрахунки (BR-SETL-014) — ролі на маршрутах SettlementsController.
 * Читаємо метадані декоратора `@Roles`, які `RolesGuard` звіряє з роллю користувача.
 */
import { describe, it, expect } from 'vitest';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { SettlementsController } from './settlements.controller';

const rolesOf = (method: keyof SettlementsController): string[] =>
  [
    ...((Reflect.getMetadata(ROLES_KEY, SettlementsController.prototype[method]) as
      string[] | undefined) ?? []),
  ].sort();

describe('SettlementsController — ролі доступу', () => {
  // guards: BR-SETL-014
  it('баланс контрагента бачать OWNER, ADMIN, ACCOUNTANT і RECEPTIONIST', () => {
    expect(rolesOf('getBalance')).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER', 'RECEPTIONIST']);
  });

  // guards: BR-SETL-014
  it.each(['getTransactions', 'createAct', 'getActs', 'downloadActPdf'] as const)(
    '%s — лише OWNER, ADMIN, ACCOUNTANT (без приймальника)',
    method => {
      expect(rolesOf(method)).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER']);
    },
  );
});
