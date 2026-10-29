/**
 * Типові правила (BR-AUT-007): міграція даних для наявних організацій і `setup.service` для нової
 * пишуть ОДНІ Й ТІ САМІ правила — `AUTOMATION_DEFAULT_RULES` з `@sto/shared`. Розійдуться — у
 * старих і нових організацій буде різний текст повідомлень. Тут — паритет тексту міграції.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_DEFAULT_RULES,
  defaultRuleActions,
  findUnknownTemplateVariables,
} from '@sto/shared';
import { defaultAutomationRuleRows, ESTIMATE_READY_SMS_BODY } from './default-rules';

const MIGRATION = join(
  __dirname,
  '../../../../../packages/database/prisma/migrations/20261029230000_automation_default_rules/migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

describe('Типові правила організації', () => {
  // guards: BR-AUT-007
  it.each(AUTOMATION_DEFAULT_RULES.map(r => [r.systemKey, r] as const))(
    '%s: міграція пише той самий рядок, що setup.service',
    (_key, rule) => {
      const row = [
        lit(rule.systemKey),
        lit(rule.name),
        lit(rule.documentType),
        lit(rule.eventKind),
        lit(`{${rule.toStatuses.join(',')}}`),
        lit(rule.messageKind),
        lit(JSON.stringify(defaultRuleActions(rule))),
      ].join(', ');
      expect(sql).toContain(`(${row})`);
    },
  );

  // guards: BR-AUT-007
  it('міграція не дублює правила й шаблон (ON CONFLICT DO NOTHING) і пише шаблон кошторису', () => {
    expect(sql).toContain('ON CONFLICT ("orgId", "systemKey") DO NOTHING');
    expect(sql).toContain('ON CONFLICT ("orgId", "eventType", "channel") DO NOTHING');
    expect(sql).toContain(lit(ESTIMATE_READY_SMS_BODY));
  });

  // guards: BR-AUT-007, BR-AUT-014
  it('рядки нової організації: усі типові правила, увімкнені, шаблон — лише змінні каталогу', () => {
    const rows = defaultAutomationRuleRows('org-n');
    expect(rows.map(r => r.systemKey)).toEqual(AUTOMATION_DEFAULT_RULES.map(r => r.systemKey));
    expect(rows.every(r => r.orgId === 'org-n' && r.enabled)).toBe(true);
    for (const r of AUTOMATION_DEFAULT_RULES)
      expect(findUnknownTemplateVariables(r.body, r.documentType)).toEqual([]);
    // Кошторис — ті змінні, які передає WorkOrderShareService.
    expect(ESTIMATE_READY_SMS_BODY.match(/\{\{(\w+)\}\}/g)?.sort()).toEqual([
      '{{clientName}}',
      '{{link}}',
      '{{totalAmount}}',
      '{{vehiclePlate}}',
      '{{woNumber}}',
    ]);
  });
});
