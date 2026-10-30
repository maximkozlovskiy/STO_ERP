import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AutomationRule, Prisma } from '@prisma/client';
import type { AutomationRuleFormValues } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { err } from '../../common/utils/err';
import { kyivDayRangeFilter } from '../../common/utils/kyiv-date';
import { calculatePagination } from '../../common/utils/pagination';
import { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import type { ActionResult, ActionRun } from './automation-actions.service';
import { AutomationContextService } from './automation-context.service';
import { AutomationEngine, eventVars, parseStoredRule } from './automation-engine';
import type {
  AutomationMessageListQueryDto,
  AutomationMessageResponseDto,
  AutomationRuleListQueryDto,
  AutomationRuleResponseDto,
  AutomationRunListQueryDto,
  AutomationRunResponseDto,
  PaginatedAutomationMessagesDto,
  PaginatedAutomationRulesDto,
  PaginatedAutomationRunsDto,
} from './automation.dto';

const isTrue = (v?: string): boolean => v === 'true' || v === '1';

function toRuleDto(r: AutomationRule, lastRunAt: Date | null): AutomationRuleResponseDto {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    documentType: r.documentType,
    eventKind: r.eventKind,
    toStatuses: r.toStatuses,
    messageKind: r.messageKind,
    conditions: (r.conditions ?? {}) as Record<string, unknown>,
    actions: (Array.isArray(r.actions) ? r.actions : []) as Record<string, unknown>[],
    systemKey: r.systemKey,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Працівники, на яких посилаються дії правила (одержувачі, виконавець, запасний). */
function referencedEmployees(dto: AutomationRuleFormValues): string[] {
  const ids = new Set<string>();
  for (const a of dto.actions) {
    if (a.type === 'employee_notification') a.recipients.employeeIds.forEach(id => ids.add(id));
    if (a.type === 'create_task') {
      if (a.assignee !== 'responsible') ids.add(a.assignee.employeeId);
      if (a.fallbackEmployeeId) ids.add(a.fallbackEmployeeId);
    }
  }
  return [...ids];
}

/**
 * Правила автоматизації: CRUD, журнал спрацювань і повідомлень, «Надіслати тест»
 * (docs/objects/automation.md, BR-AUT-001, 050, 051, 052). Ролі — у контролері (OWNER, ADMIN).
 */
@Injectable()
export class AutomationRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AutomationContextService,
    private readonly engine: AutomationEngine,
    private readonly telegram: TelegramRecipientsService,
  ) {}

  async findAll(
    orgId: string,
    query: AutomationRuleListQueryDto,
  ): Promise<PaginatedAutomationRulesDto> {
    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const where: Prisma.AutomationRuleWhereInput = {
      orgId,
      deletedAt: null,
      ...(query.documentType && { documentType: query.documentType }),
      ...(query.enabled !== undefined && { enabled: isTrue(query.enabled) }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.automationRule.findMany({
        where,
        orderBy: [{ documentType: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.automationRule.count({ where }),
    ]);
    const last = await this.lastRuns(
      orgId,
      rows.map(r => r.id),
    );
    return {
      items: rows.map(r => toRuleDto(r, last.get(r.id) ?? null)),
      total,
      page: query.page,
      limit: take,
    };
  }

  async findOne(orgId: string, id: string): Promise<AutomationRuleResponseDto> {
    const row = await this.getRule(orgId, id);
    const last = await this.lastRuns(orgId, [row.id]);
    return toRuleDto(row, last.get(row.id) ?? null);
  }

  async create(
    orgId: string,
    actorId: string,
    dto: AutomationRuleFormValues,
  ): Promise<AutomationRuleResponseDto> {
    await this.assertReferences(orgId, dto);
    const row = await this.prisma.automationRule.create({
      data: { orgId, createdById: actorId, ...this.ruleData(dto) },
    });
    return toRuleDto(row, null);
  }

  /** PATCH — повна форма. Типове правило лишається типовим (`systemKey` не змінюється). */
  async update(
    orgId: string,
    id: string,
    dto: AutomationRuleFormValues,
  ): Promise<AutomationRuleResponseDto> {
    await this.getRule(orgId, id);
    await this.assertReferences(orgId, dto);
    const res = await this.prisma.automationRule.updateMany({
      where: { id, orgId, deletedAt: null },
      data: this.ruleData(dto),
    });
    if (res.count === 0) throw new NotFoundException(err('err.automation.ruleNotFound'));
    return this.findOne(orgId, id);
  }

  async setEnabled(
    orgId: string,
    id: string,
    enabled: boolean,
  ): Promise<AutomationRuleResponseDto> {
    const res = await this.prisma.automationRule.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { enabled },
    });
    if (res.count === 0) throw new NotFoundException(err('err.automation.ruleNotFound'));
    return this.findOne(orgId, id);
  }

  /** Типове правило (BR-AUT-007) не видаляється — лише вимикається. */
  async remove(orgId: string, id: string): Promise<void> {
    const rule = await this.getRule(orgId, id);
    if (rule.systemKey) throw new BadRequestException(err('err.automation.systemRuleKey'));
    const res = await this.prisma.automationRule.updateMany({
      where: { id, orgId, deletedAt: null, systemKey: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException(err('err.automation.ruleNotFound'));
  }

  /** BR-AUT-050: журнал спрацювань — правило, документ, подія, результат кожної дії. */
  async runs(orgId: string, query: AutomationRunListQueryDto): Promise<PaginatedAutomationRunsDto> {
    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const created = kyivDayRangeFilter(query.from, query.to);
    const where: Prisma.AutomationRunWhereInput = {
      orgId,
      deletedAt: null,
      isTest: false,
      ...(query.ruleId && { ruleId: query.ruleId }),
      ...(query.status && { status: query.status }),
      ...(created && { createdAt: created }),
      ...((query.documentType || query.documentId) && {
        event: {
          ...(query.documentType && { documentType: query.documentType }),
          ...(query.documentId && { documentId: query.documentId }),
        },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.automationRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
        include: {
          rule: { select: { name: true } },
          event: {
            select: {
              documentType: true,
              documentId: true,
              kind: true,
              fromStatus: true,
              toStatus: true,
              occurredAt: true,
            },
          },
        },
      }),
      this.prisma.automationRun.count({ where }),
    ]);
    const items: AutomationRunResponseDto[] = rows.map(r => ({
      id: r.id,
      ruleId: r.ruleId,
      ruleName: r.rule.name,
      eventId: r.eventId,
      documentType: r.event.documentType,
      documentId: r.event.documentId,
      eventKind: r.event.kind,
      fromStatus: r.event.fromStatus,
      toStatus: r.event.toStatus,
      occurredAt: r.event.occurredAt.toISOString(),
      status: r.status,
      actionResults: (Array.isArray(r.actionResults)
        ? r.actionResults
        : []) as unknown as ActionResult[],
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, total, page: query.page, limit: take };
  }

  /** BR-AUT-050: повідомлення правил — кому, канал, провайдер, статус доставки, причина. */
  async messages(
    orgId: string,
    query: AutomationMessageListQueryDto,
  ): Promise<PaginatedAutomationMessagesDto> {
    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const created = kyivDayRangeFilter(query.from, query.to);
    const where: Prisma.NotificationLogWhereInput = {
      orgId,
      ruleId: query.ruleId ?? { not: null },
      ...(query.documentType && { documentType: query.documentType }),
      ...(query.documentId && { documentId: query.documentId }),
      ...(query.status && { status: query.status }),
      ...(query.isTest !== undefined && { isTest: isTrue(query.isTest) }),
      ...(created && { createdAt: created }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notificationLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.notificationLog.count({ where }),
    ]);
    const items: AutomationMessageResponseDto[] = rows.map(r => ({
      id: r.id,
      ruleId: r.ruleId,
      documentType: r.documentType,
      documentId: r.documentId,
      counterpartyId: r.counterpartyId,
      channel: r.channel,
      provider: r.provider,
      recipient: r.recipient,
      status: r.status,
      error: r.error,
      skipReason: r.skipReason,
      isTest: r.isTest,
      attempt: r.attempt,
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, total, page: query.page, limit: take };
  }

  /**
   * BR-AUT-051: «Надіслати тест» — повідомлення правила з даними обраного документа на телефон /
   * email / Telegram (якщо підписаний на бот) того, хто тестує; без згоди й тихих годин; у журналі `isTest`. Спрацювання не пишеться,
   * задачі й сповіщення в системі не створюються.
   */
  async test(
    orgId: string,
    actorId: string,
    id: string,
    documentId: string,
  ): Promise<{ actionResults: ActionResult[] }> {
    const stored = await this.getRule(orgId, id);
    const rule = parseStoredRule(stored);
    if (!rule) throw new BadRequestException(err('err.automation.ruleNotFound'));
    const ctx = await this.context.load(orgId, stored.documentType, documentId);
    if (!ctx) throw new NotFoundException(err('err.automation.documentNotFound'));
    const [tester, chats] = await Promise.all([
      this.prisma.employee.findFirst({
        where: { id: actorId, orgId, deletedAt: null },
        select: { phone: true, email: true },
      }),
      this.telegram.chatIds(orgId, 'employee', [actorId]),
    ]);
    const telegramChatId = tester ? (chats.get(actorId) ?? null) : null;
    if (!tester?.phone && !tester?.email && !telegramChatId)
      throw new BadRequestException(err('err.automation.testNoContact'));

    const now = new Date();
    const run: ActionRun = {
      orgId,
      rule: { id: rule.id, messageKind: rule.messageKind },
      ctx,
      vars: eventVars(ctx, now),
      actorId,
      occurredAt: now,
      now,
      test: { phone: tester?.phone ?? null, email: tester?.email ?? null, telegramChatId },
    };
    const actionResults: ActionResult[] = [];
    for (const [index, action] of rule.actions.entries()) {
      try {
        actionResults.push(await this.engine.executeAction(index, action, run));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        actionResults.push({
          index,
          type: action.type,
          status: 'FAILED',
          error: message.slice(0, 500),
        });
      }
    }
    return { actionResults };
  }

  private ruleData(dto: AutomationRuleFormValues) {
    return {
      name: dto.name,
      enabled: dto.enabled,
      documentType: dto.documentType,
      eventKind: dto.eventKind,
      toStatuses: dto.toStatuses,
      messageKind: dto.messageKind,
      conditions: dto.conditions as Prisma.InputJsonValue,
      actions: dto.actions as Prisma.InputJsonValue,
    };
  }

  private async getRule(orgId: string, id: string): Promise<AutomationRule> {
    const row = await this.prisma.automationRule.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!row) throw new NotFoundException(err('err.automation.ruleNotFound'));
    return row;
  }

  private async lastRuns(orgId: string, ruleIds: string[]): Promise<Map<string, Date>> {
    if (ruleIds.length === 0) return new Map();
    const groups = await this.prisma.automationRun.groupBy({
      by: ['ruleId'],
      where: { orgId, ruleId: { in: ruleIds }, deletedAt: null },
      _max: { createdAt: true },
    });
    const out = new Map<string, Date>();
    for (const g of groups) if (g._max.createdAt) out.set(g.ruleId, g._max.createdAt);
    return out;
  }

  /** BR-AUT-052: філії й працівники правила — своєї організації, не видалені, не звільнені. */
  private async assertReferences(orgId: string, dto: AutomationRuleFormValues): Promise<void> {
    const branchIds = [...new Set(dto.conditions.branchIds)];
    const employeeIds = referencedEmployees(dto);
    const [branches, employees] = await Promise.all([
      branchIds.length
        ? this.prisma.garageBranch.count({
            where: { orgId, deletedAt: null, id: { in: branchIds } },
          })
        : Promise.resolve(0),
      employeeIds.length
        ? this.prisma.employee.count({
            where: { orgId, deletedAt: null, status: { not: 'FIRED' }, id: { in: employeeIds } },
          })
        : Promise.resolve(0),
    ]);
    if (branches !== branchIds.length)
      throw new BadRequestException(err('err.automation.branchNotFound'));
    if (employees !== employeeIds.length)
      throw new BadRequestException(err('err.automation.employeeNotFound'));
  }
}
