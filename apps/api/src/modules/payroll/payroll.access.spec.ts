/**
 * Хто має доступ до зарплати (BR-PAYR-014) — ролі на маршрутах PayrollController.
 * Читаємо метадані декоратора `@Roles`, які `RolesGuard` звіряє з роллю користувача.
 */
import { describe, it, expect } from 'vitest';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { PayrollController } from './payroll.controller';

const rolesOf = (method: keyof PayrollController): string[] =>
  [
    ...((Reflect.getMetadata(ROLES_KEY, PayrollController.prototype[method]) as
      string[] | undefined) ?? []),
  ].sort();

describe('PayrollController — ролі доступу', () => {
  // guards: BR-PAYR-014
  it.each(['preview', 'findAll', 'findOne', 'create', 'compute'] as const)(
    '%s — OWNER, ADMIN, ACCOUNTANT (перегляд, створення, розрахунок)',
    method => {
      expect(rolesOf(method)).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER']);
    },
  );

  // guards: BR-PAYR-014
  it.each(['pay', 'remove'] as const)(
    '%s — лише OWNER, ADMIN (бухгалтер не виплачує і не видаляє)',
    method => {
      expect(rolesOf(method)).toEqual(['ADMIN', 'OWNER']);
    },
  );

  // guards: BR-PAYR-014
  it('жоден маршрут не відкритий MECHANIC чи RECEPTIONIST і жоден не лишився без @Roles', () => {
    const methods = Object.getOwnPropertyNames(PayrollController.prototype).filter(
      n => n !== 'constructor',
    ) as (keyof PayrollController)[];
    expect([...methods].sort()).toEqual([
      'compute',
      'create',
      'findAll',
      'findOne',
      'pay',
      'preview',
      'remove',
    ]);
    for (const method of methods) {
      const roles = rolesOf(method);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles).not.toContain('MECHANIC');
      expect(roles).not.toContain('RECEPTIONIST');
    }
  });
});
