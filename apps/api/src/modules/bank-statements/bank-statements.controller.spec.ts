import { describe, it, expect } from 'vitest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { BankStatementsController } from './bank-statements.controller';

// Доступ до банківських платежів (BR-BANK-015). RolesGuard читає metadata 'roles' з методу,
// тож перевіряємо саме її: імпорт, перегляд, рознесення й ігнорування — OWNER/ADMIN/ACCOUNTANT,
// і ніхто інший (MANAGER/MECHANIC/… гроші на контрагента не розносять).
describe('BankStatementsController — доступ', () => {
  const ROUTES = ['rawPreview', 'preview', 'apply', 'list', 'match', 'ignore'] as const;

  const rolesOf = (method: (typeof ROUTES)[number]): string[] =>
    Reflect.getMetadata('roles', BankStatementsController.prototype[method]);

  // guards: BR-BANK-015
  it.each(ROUTES)('%s — рівно OWNER / ADMIN / ACCOUNTANT', method => {
    expect(rolesOf(method)).toEqual(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  });

  // guards: BR-BANK-015
  it('контролер закритий JwtAuthGuard + RolesGuard (без них @Roles нічого не обмежує)', () => {
    const guards = Reflect.getMetadata('__guards__', BankStatementsController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });

  // guards: BR-BANK-015
  it('жоден метод-маршрут контролера не лишився поза переліком цього спеку', () => {
    const proto = BankStatementsController.prototype as unknown as Record<string, object>;
    const routed = Object.getOwnPropertyNames(proto).filter(
      name => name !== 'constructor' && Reflect.getMetadata('path', proto[name]!) !== undefined,
    );
    expect(routed.sort()).toEqual([...ROUTES].sort());
  });
});
