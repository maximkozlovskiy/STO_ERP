import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type AutomationRule,
  type AutomationRunStatus,
  type DomainEvent,
} from '@prisma/client';
import {
  automationRuleSchema,
  type AutomationAction,
  type AutomationRuleFormValues,
} from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AutomationActionsService,
  type ActionResult,
  type ActionRun,
  type Vars,
} from './automation-actions.service';
import { AutomationContextService, type DocumentContext } from './automation-context.service';
import type { DomainEventHandler } from './domain-event-handler';
import { formatKyivDate, formatKyivTime } from './automation-text';

/** Скільки правил на одну подію береться (на тип документа + подію правил одиниці). */
const RULES_PER_EVENT_MAX = 100;
const ERROR_MAX = 500;

/** Розібране збережене правило: умови й дії — за схемою з `@sto/shared`. */
export type ParsedRule = Pick<AutomationRule, 'id' | 'messageKind' | 'toStatuses'> &
  Pick<AutomationRuleFormValues, 'conditions' | 'actions'>;

/** Збережене правило → умови й дії за схемою; зіпсований JSON — null. */
export function parseStoredRule(rule: AutomationRule): ParsedRule | null {
  const parsed = automationRuleSchema.safeParse({
    name: rule.name,
    enabled: rule.enabled,
    documentType: rule.documentType,
    eventKind: rule.eventKind,
    toStatuses: rule.toStatuses,
    messageKind: rule.messageKind,
    conditions: rule.conditions,
    actions: rule.actions,
  });
  if (!parsed.success) return null;
  return {
    id: rule.id,
    messageKind: rule.messageKind,
    toStatuses: rule.toStatuses,
    conditions: parsed.data.conditions,
    actions: parsed.data.actions,
  };
}

/** BR-AUT-003: усі умови правила — «І»; поле, якого в документа немає, умову не проходить. */
export function conditionsMet(
  c: AutomationRuleFormValues['conditions'],
  event: Pick<DomainEvent, 'fromStatus'>,
  ctx: Pick<DocumentContext, 'branchId' | 'repairCategory' | 'priority' | 'amount'>,
): boolean {
  if (c.branchIds.length > 0 && (!ctx.branchId || !c.branchIds.includes(ctx.branchId)))
    return false;
  if (
    c.fromStatuses.length > 0 &&
    (!event.fromStatus || !c.fromStatuses.includes(event.fromStatus))
  )
    return false;
  if (
    c.repairCategories.length > 0 &&
    (!ctx.repairCategory || !(c.repairCategories as readonly string[]).includes(ctx.repairCategory))
  )
    return false;
  if (
    c.priorities.length > 0 &&
    (!ctx.priority || !(c.priorities as readonly string[]).includes(ctx.priority))
  )
    return false;
  if (c.minAmount !== undefined && (ctx.amount === null || ctx.amount < c.minAmount)) return false;
  return true;
}

/** BR-AUT-005: статус спрацювання з результатів дій. */
export function runStatus(results: readonly ActionResult[]): AutomationRunStatus {
  const failed = results.filter(r => r.status === 'FAILED').length;
  if (failed === 0) return results.every(r => r.status === 'SKIPPED') ? 'SKIPPED' : 'DONE';
  return failed === results.length ? 'FAILED' : 'PARTIAL';
}

/** Змінні шаблону: документ + момент події за Києвом (BR-AUT-014). */
export function eventVars(ctx: DocumentContext, occurredAt: Date): Vars {
  return { ...ctx.vars, date: formatKyivDate(occurredAt), time: formatKyivTime(occurredAt) };
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Двигун правил (docs/objects/automation.md, BR-AUT-003…006) — обробник outbox-подій
 * (`DOMAIN_EVENT_HANDLERS`). Викликається в tenant-scope організації події.
 *
 * Ідемпотентність (BR-AUT-004): спрацювання — рядок `AutomationRun` з унікальною парою (правило,
 * подія), вставлений ДО дій. Повторна обробка події (збій іншого обробника, падіння процесу)
 * правило вже не виконує. Кожна дія — у власному try/catch (BR-AUT-005).
 */
@Injectable()
export class AutomationEngine implements DomainEventHandler {
  readonly name = 'automation-rules';
  private readonly logger = new Logger(AutomationEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AutomationContextService,
    private readonly actions: AutomationActionsService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const orgId = event.orgId;
    // BR-AUT-006: правило читається на момент обробки — вимкнене чи видалене не спрацьовує.
    const rules = await this.prisma.automationRule.findMany({
      where: {
        orgId,
        deletedAt: null,
        enabled: true,
        documentType: event.documentType,
        eventKind: event.kind,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: RULES_PER_EVENT_MAX,
    });
    const matching = rules.filter(
      r => r.toStatuses.length === 0 || (!!event.toStatus && r.toStatuses.includes(event.toStatus)),
    );
    if (matching.length === 0) return;

    const done = await this.prisma.automationRun.findMany({
      where: { orgId, eventId: event.id, ruleId: { in: matching.map(r => r.id) } },
      select: { ruleId: true },
      take: matching.length,
    });
    const pending = matching.filter(r => !done.some(d => d.ruleId === r.id));
    if (pending.length === 0) return;

    const ctx = await this.context.load(orgId, event.documentType, event.documentId);
    if (!ctx) return; // документ видалено до обробки — дій немає
    const vars = eventVars(ctx, event.occurredAt);
    for (const rule of pending) await this.runRule(rule, event, ctx, vars);
  }

  private async runRule(
    stored: AutomationRule,
    event: DomainEvent,
    ctx: DocumentContext,
    vars: Vars,
  ): Promise<void> {
    const orgId = event.orgId;
    const rule = parseStoredRule(stored);
    if (rule && !conditionsMet(rule.conditions, event, ctx)) return;

    // Захоплення ДО дій: дубль (повторна обробка) — P2002, правило вже виконано.
    let runId: string;
    try {
      const run = await this.prisma.automationRun.create({
        data: { orgId, ruleId: stored.id, eventId: event.id, status: 'FAILED', actionResults: [] },
        select: { id: true },
      });
      runId = run.id;
    } catch (e) {
      if (isUniqueViolation(e)) return;
      throw e;
    }

    const results: ActionResult[] = rule
      ? await this.execute(rule, event, ctx, vars)
      : [{ index: 0, type: 'client_message', status: 'FAILED', error: 'invalid rule definition' }];
    await this.prisma.automationRun.updateMany({
      where: { id: runId, orgId },
      data: {
        status: runStatus(results),
        actionResults: results as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async execute(
    rule: ParsedRule,
    event: DomainEvent,
    ctx: DocumentContext,
    vars: Vars,
  ): Promise<ActionResult[]> {
    const run: ActionRun = {
      orgId: event.orgId,
      rule: { id: rule.id, messageKind: rule.messageKind },
      ctx,
      vars,
      actorId: event.actorId,
      occurredAt: event.occurredAt,
      now: new Date(),
    };
    const results: ActionResult[] = [];
    for (const [index, action] of rule.actions.entries()) {
      try {
        results.push(await this.executeAction(index, action, run));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Правило ${rule.id}, дія ${index} (${action.type}): ${message}`);
        results.push({
          index,
          type: action.type,
          status: 'FAILED',
          error: message.slice(0, ERROR_MAX),
        });
      }
    }
    return results;
  }

  /** Одна дія; спільний вхід для двигуна й «Надіслати тест». */
  executeAction(index: number, action: AutomationAction, run: ActionRun): Promise<ActionResult> {
    switch (action.type) {
      case 'client_message':
        return this.actions.clientMessage(index, action, run);
      case 'employee_notification':
        return this.actions.employeeNotification(index, action, run);
      case 'create_task':
        return this.actions.createTask(index, action, run);
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }
}
