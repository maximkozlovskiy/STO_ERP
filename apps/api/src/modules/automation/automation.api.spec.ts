/**
 * API автоматизації (docs/objects/automation.md): хто керує правилами (BR-AUT-001, 050), перевірка
 * тіла правила (BR-AUT-014), межі організації (BR-AUT-052), типове правило не видаляється
 * (BR-AUT-007), «Надіслати тест» (BR-AUT-051), дзвіночок — лише свої сповіщення (BR-AUT-021).
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { automationRuleSchema, type AutomationRuleFormValues } from '@sto/shared';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { memoryTable } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import { AutomationController, EmployeeNotificationsController } from './automation.controller';
import { AutomationRulesService } from './automation-rules.service';
import { EmployeeNotificationsService } from './employee-notifications.service';
import {
  ACTOR,
  BRANCH,
  FIRED,
  FOREIGN,
  OTHER_BRANCH,
  OTHER_ORG,
  RECEPTION,
  automationHarness,
  clientMessage,
  fakeRule,
} from './automation.spec-fixture';

const rolesOf = (cls: { prototype: object }, method: string): string[] =>
  [
    ...((Reflect.getMetadata(ROLES_KEY, (cls.prototype as Record<string, object>)[method]!) as
      string[] | undefined) ??
      (Reflect.getMetadata(ROLES_KEY, cls) as string[] | undefined) ??
      []),
  ].sort();

const form = (over: Record<string, unknown> = {}): AutomationRuleFormValues =>
  automationRuleSchema.parse({
    name: 'Наряд у роботі',
    documentType: 'WORK_ORDER',
    eventKind: 'STATUS_CHANGED',
    toStatuses: ['IN_PROGRESS'],
    actions: [clientMessage()],
    ...over,
  });

function rulesService(rules: Record<string, unknown>[] = []) {
  const h = automationHarness({ rules });
  h.tables.automationRun.groupBy = vi.fn().mockResolvedValue([]) as never;
  return { h, svc: new AutomationRulesService(h.prisma, h.context, h.engine, h.telegram) };
}

describe('Ролі маршрутів автоматизації', () => {
  // guards: BR-AUT-001, BR-AUT-050
  it.each([
    'findAll',
    'create',
    'runs',
    'messages',
    'test',
    'setEnabled',
    'findOne',
    'update',
    'remove',
  ])('правила, журнал і тест (%s) — лише OWNER і ADMIN', method => {
    expect(rolesOf(AutomationController, method)).toEqual(['ADMIN', 'OWNER']);
  });

  // guards: BR-AUT-021
  it.each(['list', 'unreadCount', 'readAll', 'read'])(
    'дзвіночок (%s) — усі ролі персоналу',
    method => {
      expect(rolesOf(EmployeeNotificationsController, method)).toEqual([
        'ACCOUNTANT',
        'ADMIN',
        'MECHANIC',
        'OWNER',
        'RECEPTIONIST',
        'STOREKEEPER',
        'XLSX_MANAGER',
      ]);
    },
  );
});

describe('AutomationRulesService', () => {
  // guards: BR-AUT-014
  it('тіло з невідомою змінною — 400 українською ще до сервісу', () => {
    const pipe = new ZodValidationPipe(automationRuleSchema);
    const body = { ...form(), actions: [clientMessage({ template: { body: 'Привіт {{імʼя}}' } })] };
    try {
      pipe.transform(body);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const msg = ((e as BadRequestException).getResponse() as { message: string[] }).message;
      expect(msg.join(' ')).toContain('змінну, якої немає в переліку');
    }
  });

  // guards: BR-AUT-001
  it('створення: правило організації з автором; умови й дії — як у формі', async () => {
    const { h, svc } = rulesService();
    const dto = await svc.create('org-a', ACTOR, form({ conditions: { branchIds: [BRANCH] } }));
    expect(h.tables.automationRule.rows).toEqual([
      expect.objectContaining({
        orgId: 'org-a',
        createdById: ACTOR,
        name: 'Наряд у роботі',
        enabled: true,
      }),
    ]);
    expect(dto.conditions).toMatchObject({ branchIds: [BRANCH] });
    expect(dto.lastRunAt).toBeNull();
  });

  // guards: BR-AUT-052
  it('філія чи працівник чужої організації або звільнений — 400', async () => {
    const { svc } = rulesService();
    await expect(
      svc.create('org-a', ACTOR, form({ conditions: { branchIds: [OTHER_BRANCH] } })),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const emp of [FOREIGN, FIRED]) {
      const bad = form({
        actions: [
          { type: 'employee_notification', recipients: { employeeIds: [emp] }, title: 'Т' },
        ],
      });
      await expect(svc.create('org-a', ACTOR, bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  // guards: BR-AUT-052
  it('правило чужої організації — 404 на читання, зміну, вимкнення, видалення', async () => {
    const foreign = fakeRule({ orgId: OTHER_ORG });
    const { svc } = rulesService([foreign]);
    const id = foreign.id as string;
    await expect(svc.findOne('org-a', id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.update('org-a', id, form())).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setEnabled('org-a', id, false)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('org-a', id)).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.enabled).toBe(true);
    expect(foreign.deletedAt).toBeNull();
  });

  // guards: BR-AUT-007
  it('типове правило не видаляється (лише вимикається); звичайне — м’яке видалення', async () => {
    const system = fakeRule({ systemKey: 'WO_COMPLETED_CLIENT' });
    const own = fakeRule();
    const { svc } = rulesService([system, own]);
    await expect(svc.remove('org-a', system.id as string)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(system.deletedAt).toBeNull();
    await svc.setEnabled('org-a', system.id as string, false);
    expect(system.enabled).toBe(false);
    await svc.remove('org-a', own.id as string);
    expect(own.deletedAt).toBeInstanceOf(Date);
  });

  // guards: BR-AUT-007
  it('зміна типового правила лишає systemKey', async () => {
    const system = fakeRule({ systemKey: 'PAYMENT_CREATED_CLIENT' });
    const { svc } = rulesService([system]);
    const dto = await svc.update('org-a', system.id as string, form({ name: 'Нова назва' }));
    expect(dto.systemKey).toBe('PAYMENT_CREATED_CLIENT');
    expect(dto.name).toBe('Нова назва');
  });

  // guards: BR-AUT-051
  it('тест: повідомлення — на телефон того, хто тестує, з позначкою isTest; спрацювання не пишеться', async () => {
    const rule = fakeRule();
    const { h, svc } = rulesService([rule]);
    const res = await svc.test('org-a', RECEPTION, rule.id as string, 'doc-wo-1');
    expect(res.actionResults).toEqual([expect.objectContaining({ status: 'DONE' })]);
    const [, , chain, opts] = h.enqueueChain.mock.calls[0]!;
    expect((chain as { recipient: string }[]).map(c => c.recipient)).toEqual([
      '+380670000004',
      '+380670000004',
    ]);
    expect(opts).toMatchObject({ meta: { isTest: true, ruleId: rule.id } });
    expect(h.runs).toHaveLength(0);
  });

  // guards: BR-AUT-051
  it('тест: у профілі немає контакту — 400; документа немає — 404', async () => {
    const rule = fakeRule();
    const { h, svc } = rulesService([rule]);
    await expect(svc.test('org-a', ACTOR, rule.id as string, 'doc-wo-1')).resolves.toBeDefined();
    const mech = h.tables.employee.rows.find(e => e.id === RECEPTION)!;
    mech.phone = null;
    await expect(
      svc.test('org-a', RECEPTION, rule.id as string, 'doc-wo-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    h.load.mockResolvedValueOnce(null);
    await expect(svc.test('org-a', ACTOR, rule.id as string, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('EmployeeNotificationsService — дзвіночок', () => {
  const rows = () => [
    {
      id: 'n1',
      orgId: 'org-a',
      employeeId: ACTOR,
      title: 'A',
      body: null,
      documentType: null,
      documentId: null,
      readAt: null,
      createdAt: new Date('2026-10-29T10:00:00Z'),
      deletedAt: null,
    },
    {
      id: 'n2',
      orgId: 'org-a',
      employeeId: ACTOR,
      title: 'B',
      body: null,
      documentType: null,
      documentId: null,
      readAt: new Date(),
      createdAt: new Date('2026-10-29T11:00:00Z'),
      deletedAt: null,
    },
    {
      id: 'n3',
      orgId: 'org-a',
      employeeId: RECEPTION,
      title: 'C',
      body: null,
      documentType: null,
      documentId: null,
      readAt: null,
      createdAt: new Date(),
      deletedAt: null,
    },
    {
      id: 'n4',
      orgId: OTHER_ORG,
      employeeId: ACTOR,
      title: 'D',
      body: null,
      documentType: null,
      documentId: null,
      readAt: null,
      createdAt: new Date(),
      deletedAt: null,
    },
  ];
  const make = () => {
    const table = memoryTable(rows());
    const prisma = { employeeNotification: table } as unknown as PrismaService;
    return { table, svc: new EmployeeNotificationsService(prisma) };
  };

  // guards: BR-AUT-021, BR-AUT-052
  it('кожен бачить лише свої сповіщення своєї організації; лічильник — непрочитані', async () => {
    const { svc } = make();
    const list = await svc.listMine('org-a', ACTOR, { page: 1, limit: 20 });
    expect(list.items.map(n => n.id)).toEqual(['n2', 'n1']);
    const unread = await svc.listMine('org-a', ACTOR, { page: 1, limit: 20, unread: 'true' });
    expect(unread.items.map(n => n.id)).toEqual(['n1']);
    expect(await svc.unreadCount('org-a', ACTOR)).toEqual({ count: 1 });
  });

  // guards: BR-AUT-021, BR-AUT-052
  it('«прочитано» — лише своє (чуже — 404 без змін); «усі прочитані» — лише свої', async () => {
    const { svc, table } = make();
    await expect(svc.markRead('org-a', ACTOR, 'n3')).rejects.toBeInstanceOf(NotFoundException);
    expect(table.rows.find(r => r.id === 'n3')?.readAt).toBeNull();
    const read = await svc.markRead('org-a', ACTOR, 'n1');
    expect(read.readAt).not.toBeNull();
    expect(await svc.markAllRead('org-a', RECEPTION)).toEqual({ updated: 1 });
    expect(table.rows.find(r => r.id === 'n4')?.readAt).toBeNull();
  });
});
