/**
 * Хто має доступ до конструктора звітів (BR-RPT-020) — ролі на маршрутах
 * ReportBuilderController. Читаємо метадані декоратора `@Roles`, які `RolesGuard` звіряє
 * з роллю користувача.
 */
import { describe, it, expect } from 'vitest';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { ReportBuilderController } from './report-builder.controller';

const rolesOf = (method: keyof ReportBuilderController): string[] =>
  [
    ...((Reflect.getMetadata(ROLES_KEY, ReportBuilderController.prototype[method]) as
      string[] | undefined) ?? []),
  ].sort();

describe('ReportBuilderController — ролі доступу', () => {
  // guards: BR-RPT-020
  it.each([
    'getMetadata',
    'run',
    'listSaved',
    'createSaved',
    'runSaved',
    'getSaved',
    'updateSaved',
    'removeSaved',
  ] as const)('%s — лише OWNER, ADMIN, ACCOUNTANT', method => {
    expect(rolesOf(method)).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER']);
  });

  // guards: BR-RPT-020
  it('кожен маршрут контролера має @Roles — жодного відкритого методу', () => {
    const methods = Object.getOwnPropertyNames(ReportBuilderController.prototype).filter(
      m => m !== 'constructor',
    );
    expect(methods.sort()).toEqual(
      [
        'getMetadata',
        'run',
        'listSaved',
        'createSaved',
        'runSaved',
        'getSaved',
        'updateSaved',
        'removeSaved',
      ].sort(),
    );
  });
});
