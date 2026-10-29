/**
 * Типові правила (BR-AUT-007): міграція даних для наявних організацій і `setup.service` для нової
 * пишуть ОДНІ Й ТІ САМІ правила — `AUTOMATION_DEFAULT_RULES` з `@sto/shared`. Розійдуться — у
 * старих і нових організацій буде різний текст повідомлень. Тут — паритет тексту міграції.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  AUTOMATION_DEFAULT_RULES,
  defaultRuleActions,
  findUnknownTemplateVariables,
} from '@sto/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { defaultAutomationRuleRows, ESTIMATE_READY_SMS_BODY } from './default-rules';
import { AutomationDefaultRulesBootstrap } from './default-rules.bootstrap';

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

  // База, засіяна seed.ts (CI, нова dev-база): міграція даних іде до seed, коли організацій ще
  // немає, тож типові правила дописує старт api.
  // guards: BR-AUT-007
  it('старт api: кожній активній організації — усі типові правила; наявні не дублюються', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 3 });
    const prisma = {
      organisation: { findMany: vi.fn().mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }]) },
      automationRule: { createMany },
    };
    await new AutomationDefaultRulesBootstrap(
      prisma as unknown as PrismaService,
    ).onApplicationBootstrap();

    expect(prisma.organisation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [...defaultAutomationRuleRows('org-a'), ...defaultAutomationRuleRows('org-b')],
      skipDuplicates: true,
    });
  });

  // guards: BR-AUT-007
  it('старт api: збій запису правил не зупиняє старт', async () => {
    const prisma = {
      organisation: { findMany: vi.fn().mockResolvedValue([{ id: 'org-a' }]) },
      automationRule: { createMany: vi.fn().mockRejectedValue(new Error('db down')) },
    };
    await expect(
      new AutomationDefaultRulesBootstrap(
        prisma as unknown as PrismaService,
      ).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});
