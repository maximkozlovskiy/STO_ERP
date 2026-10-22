// BR-WAR-005: ролі вкладки «Гарантії» — дзеркало `@Roles` warranties.controller. Тест читає
// контролер і падає, щойно одна сторона зміниться без другої: інакше вкладка показується ролі,
// якій список віддає 403, або кнопка «Звернення» веде на відмову.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WARRANTY_CLAIM_ROLES, WARRANTY_VIEW_ROLES } from '../warranty-roles';

const CONTROLLER = resolve(
  __dirname,
  '../../../../api/src/modules/warranties/warranties.controller.ts',
);

function rolesAfter(decorator: string): string[] {
  const src = readFileSync(CONTROLLER, 'utf8');
  const at = src.indexOf(decorator);
  expect(at, decorator).toBeGreaterThan(-1);
  const m = src.slice(at).match(/@Roles\(([^)]*)\)/);
  expect(m, `@Roles після ${decorator}`).not.toBeNull();
  return m![1]
    .split(',')
    .map(r => r.trim().replace(/['"]/g, ''))
    .filter(Boolean)
    .sort();
}

describe('Ролі вкладки «Гарантії» = @Roles API', () => {
  // guards: BR-WAR-005
  it('перегляд — ролі GET /warranties', () => {
    expect([...WARRANTY_VIEW_ROLES].sort()).toEqual(rolesAfter('@Get()'));
  });

  // guards: BR-WAR-005
  it('звернення — ролі POST /warranties/:id/claim', () => {
    expect([...WARRANTY_CLAIM_ROLES].sort()).toEqual(rolesAfter("@Post(':id/claim')"));
  });
});
