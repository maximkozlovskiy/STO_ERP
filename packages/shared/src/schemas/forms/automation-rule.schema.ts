import { z } from 'zod';
import {
  AUTOMATION_DOCUMENT_TYPES,
  AUTOMATION_EVENT_KINDS,
  type AutomationDocumentTypeValue,
} from '../../constants/automation';
import {
  AUTOMATION_ACTIONS_MAX,
  AUTOMATION_AMOUNT_DOCUMENT_TYPES,
  AUTOMATION_CHANNELS,
  AUTOMATION_CLIENT_DOCUMENT_TYPES,
  AUTOMATION_CREATED_STATUSES,
  AUTOMATION_EMPLOYEE_CHANNELS,
  AUTOMATION_LIST_MAX,
  AUTOMATION_MESSAGE_KINDS,
  AUTOMATION_PRIORITIES,
  AUTOMATION_PRIORITY_DOCUMENT_TYPES,
  AUTOMATION_RECIPIENT_ROLES,
  AUTOMATION_REPAIR_CATEGORIES,
  AUTOMATION_RULE_NAME_MAX,
  AUTOMATION_STATUS_LABELS,
  AUTOMATION_TASK_DUE_HOURS_MAX,
  AUTOMATION_TEMPLATE_BODY_MAX,
  AUTOMATION_TEMPLATE_SUBJECT_MAX,
  findUnknownTemplateVariables,
} from '../../constants/automation-rules';
import { MONEY_AMOUNT_MAX } from '../validators';
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from './task.schema';

/**
 * Правило автоматизації «подія → умови → дії» (docs/objects/automation.md, BR-AUT-001…032) —
 * ЄДИНЕ джерело валідації для api (`POST/PATCH /automation/rules`) і конструктора на web.
 *
 * Перехресні перевірки (`superRefine`): статуси — з переліку типу документа; умова лише для типу,
 * у якого є це поле; «повідомлення клієнту» — лише для документа з клієнтом; «створити задачу» не
 * ставиться на подію задачі (інакше правило породжувало б само себе); змінна шаблону — лише з
 * каталогу типу документа (BR-AUT-014). Повідомлення — ключі `v.*`.
 */

const uuid = () => z.string().trim().uuid('v.uuid');

/** Текст із `{{змінними}}`: обов'язковий, обрізаний, з лімітом. */
const templateText = (max: number, requiredKey: string, maxKey: string) =>
  z.string().trim().min(1, requiredKey).max(max, maxKey);

/** Необов'язковий текст: порожній рядок → undefined. */
const optionalTemplateText = (max: number, maxKey: string) =>
  z
    .string()
    .trim()
    .max(max, maxKey)
    .optional()
    .transform(v => (v ? v : undefined));

const messageTemplateSchema = z.object({
  subject: optionalTemplateText(
    AUTOMATION_TEMPLATE_SUBJECT_MAX,
    'v.automation.template.subjectMax',
  ),
  body: templateText(
    AUTOMATION_TEMPLATE_BODY_MAX,
    'v.automation.template.bodyRequired',
    'v.automation.template.bodyMax',
  ),
});

const clientMessageActionSchema = z.object({
  type: z.literal('client_message'),
  channels: z
    .array(z.enum(AUTOMATION_CHANNELS))
    .min(1, 'v.automation.channels.required')
    .max(AUTOMATION_CHANNELS.length, 'v.automation.channels.duplicate'),
  template: messageTemplateSchema,
});

const employeeNotificationActionSchema = z.object({
  type: z.literal('employee_notification'),
  recipients: z.object({
    employeeIds: z.array(uuid()).max(AUTOMATION_LIST_MAX, 'v.automation.list.max').default([]),
    roles: z
      .array(z.enum(AUTOMATION_RECIPIENT_ROLES))
      .max(AUTOMATION_RECIPIENT_ROLES.length, 'v.automation.list.max')
      .default([]),
    /** «Відповідальний з документа» (BR-AUT-020). */
    responsible: z.boolean().default(false),
  }),
  /** Заголовок сповіщення в системі (дзвіночок) — шаблон зі змінними. */
  title: templateText(
    AUTOMATION_RULE_NAME_MAX,
    'v.automation.notification.titleRequired',
    'v.automation.notification.titleMax',
  ),
  body: optionalTemplateText(AUTOMATION_TEMPLATE_BODY_MAX, 'v.automation.template.bodyMax'),
  inApp: z.boolean().default(true),
  external: z
    .object({
      channels: z
        .array(z.enum(AUTOMATION_EMPLOYEE_CHANNELS))
        .min(1, 'v.automation.channels.required')
        .max(AUTOMATION_EMPLOYEE_CHANNELS.length, 'v.automation.channels.duplicate'),
      template: messageTemplateSchema,
    })
    .optional(),
  /** BR-AUT-023: ініціатор зміни отримує сповіщення про власну дію лише за цим прапорцем. */
  notifyInitiator: z.boolean().default(false),
});

const createTaskActionSchema = z.object({
  type: z.literal('create_task'),
  title: templateText(TASK_TITLE_MAX, 'v.task.title.required', 'v.task.title.max'),
  description: optionalTemplateText(TASK_DESCRIPTION_MAX, 'v.task.description.max'),
  /** BR-AUT-030: «відповідальний з документа» або конкретний працівник. */
  assignee: z.union([z.literal('responsible'), z.object({ employeeId: uuid() })]),
  /** Запасний виконавець, коли відповідального немає або він недоступний (US-AUT-2). */
  fallbackEmployeeId: z
    .string()
    .trim()
    .optional()
    .transform(v => (v ? v : undefined))
    .pipe(z.string().uuid('v.uuid').optional()),
  dueInHours: z
    .number({ error: 'v.invalidNumber' })
    .int('v.automation.task.dueInHours')
    .min(0, 'v.automation.task.dueInHours')
    .max(AUTOMATION_TASK_DUE_HOURS_MAX, 'v.automation.task.dueInHours'),
  priority: z.enum(AUTOMATION_PRIORITIES).default('NORMAL'),
});

export const automationActionSchema = z.discriminatedUnion('type', [
  clientMessageActionSchema,
  employeeNotificationActionSchema,
  createTaskActionSchema,
]);

const statusList = () =>
  z
    .array(z.string().trim().min(1, 'v.automation.status.invalid'))
    .max(AUTOMATION_LIST_MAX, 'v.automation.list.max');

/** Умови «І» (BR-AUT-003); порожня умова — без обмеження. */
export const automationConditionsSchema = z.object({
  branchIds: z.array(uuid()).max(AUTOMATION_LIST_MAX, 'v.automation.list.max').default([]),
  fromStatuses: statusList().default([]),
  repairCategories: z.array(z.enum(AUTOMATION_REPAIR_CATEGORIES)).default([]),
  priorities: z.array(z.enum(AUTOMATION_PRIORITIES)).default([]),
  minAmount: z
    .number({ error: 'v.invalidNumber' })
    .min(0, 'v.nonNeg')
    .max(MONEY_AMOUNT_MAX, 'v.amountMax')
    .optional(),
});

type Ctx = z.RefinementCtx;
type Path = (string | number)[];

function checkTemplate(
  ctx: Ctx,
  text: string | undefined,
  documentType: AutomationDocumentTypeValue,
  path: Path,
): void {
  if (!text) return;
  if (findUnknownTemplateVariables(text, documentType).length > 0) {
    ctx.addIssue({ code: 'custom', message: 'v.automation.template.unknownVariable', path });
  }
}

function checkUnique(ctx: Ctx, list: readonly string[], path: Path): void {
  if (new Set(list).size !== list.length) {
    ctx.addIssue({ code: 'custom', message: 'v.automation.channels.duplicate', path });
  }
}

export const automationRuleSchema = z
  .object({
    name: templateText(
      AUTOMATION_RULE_NAME_MAX,
      'v.automation.name.required',
      'v.automation.name.max',
    ),
    enabled: z.boolean().default(true),
    documentType: z.enum(AUTOMATION_DOCUMENT_TYPES),
    eventKind: z.enum(AUTOMATION_EVENT_KINDS),
    /** У який статус (порожньо — будь-який); для «створено» — початковий статус. */
    toStatuses: statusList().default([]),
    messageKind: z.enum(AUTOMATION_MESSAGE_KINDS).default('SERVICE'),
    conditions: automationConditionsSchema.default({
      branchIds: [],
      fromStatuses: [],
      repairCategories: [],
      priorities: [],
    }),
    actions: z
      .array(automationActionSchema)
      .min(1, 'v.automation.actions.required')
      .max(AUTOMATION_ACTIONS_MAX, 'v.automation.actions.max'),
  })
  .superRefine((rule, ctx) => {
    const type = rule.documentType;
    const statuses = Object.keys(AUTOMATION_STATUS_LABELS[type]);
    rule.toStatuses.forEach((s, i) => {
      if (!statuses.includes(s))
        ctx.addIssue({
          code: 'custom',
          message: 'v.automation.status.invalid',
          path: ['toStatuses', i],
        });
    });
    // «Створено»: статус, з яким документ цього типу не народжується, — правило-мовчун.
    const createdStatuses =
      rule.eventKind === 'CREATED' ? AUTOMATION_CREATED_STATUSES[type] : undefined;
    if (createdStatuses)
      rule.toStatuses.forEach((s, i) => {
        if (statuses.includes(s) && !createdStatuses.includes(s))
          ctx.addIssue({
            code: 'custom',
            message: 'v.automation.conditions.notApplicable',
            path: ['toStatuses', i],
          });
      });
    const c = rule.conditions;
    c.fromStatuses.forEach((s, i) => {
      if (!statuses.includes(s))
        ctx.addIssue({
          code: 'custom',
          message: 'v.automation.status.invalid',
          path: ['conditions', 'fromStatuses', i],
        });
    });
    const notApplicable = (field: string) =>
      ctx.addIssue({
        code: 'custom',
        message: 'v.automation.conditions.notApplicable',
        path: ['conditions', field],
      });
    if (c.fromStatuses.length > 0 && rule.eventKind !== 'STATUS_CHANGED')
      notApplicable('fromStatuses');
    if (c.repairCategories.length > 0 && type !== 'WORK_ORDER') notApplicable('repairCategories');
    if (c.priorities.length > 0 && !AUTOMATION_PRIORITY_DOCUMENT_TYPES.includes(type))
      notApplicable('priorities');
    if (c.minAmount !== undefined && !AUTOMATION_AMOUNT_DOCUMENT_TYPES.includes(type))
      notApplicable('minAmount');

    rule.actions.forEach((a, i) => {
      const at = (...rest: Path): Path => ['actions', i, ...rest];
      switch (a.type) {
        case 'client_message':
          if (!AUTOMATION_CLIENT_DOCUMENT_TYPES.includes(type))
            ctx.addIssue({
              code: 'custom',
              message: 'v.automation.action.noClient',
              path: at('type'),
            });
          checkUnique(ctx, a.channels, at('channels'));
          checkTemplate(ctx, a.template.subject, type, at('template', 'subject'));
          checkTemplate(ctx, a.template.body, type, at('template', 'body'));
          break;
        case 'employee_notification': {
          const r = a.recipients;
          if (r.employeeIds.length === 0 && r.roles.length === 0 && !r.responsible)
            ctx.addIssue({
              code: 'custom',
              message: 'v.automation.recipients.required',
              path: at('recipients'),
            });
          if (!a.inApp && !a.external)
            ctx.addIssue({
              code: 'custom',
              message: 'v.automation.notification.channelRequired',
              path: at('inApp'),
            });
          checkTemplate(ctx, a.title, type, at('title'));
          checkTemplate(ctx, a.body, type, at('body'));
          if (a.external) {
            checkUnique(ctx, a.external.channels, at('external', 'channels'));
            checkTemplate(
              ctx,
              a.external.template.subject,
              type,
              at('external', 'template', 'subject'),
            );
            checkTemplate(ctx, a.external.template.body, type, at('external', 'template', 'body'));
          }
          break;
        }
        case 'create_task':
          if (type === 'TASK')
            ctx.addIssue({
              code: 'custom',
              message: 'v.automation.action.taskOnTask',
              path: at('type'),
            });
          checkTemplate(ctx, a.title, type, at('title'));
          checkTemplate(ctx, a.description, type, at('description'));
          break;
        default: {
          const _exhaustive: never = a;
          return _exhaustive;
        }
      }
    });
  });

/** Правило ПІСЛЯ парсингу (типові значення підставлено). */
export type AutomationRuleFormValues = z.infer<typeof automationRuleSchema>;
/** Вхід форми — до коерції. */
export type AutomationRuleFormInput = z.input<typeof automationRuleSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationConditions = z.infer<typeof automationConditionsSchema>;
export type AutomationClientMessageAction = z.infer<typeof clientMessageActionSchema>;
export type AutomationEmployeeNotificationAction = z.infer<typeof employeeNotificationActionSchema>;
export type AutomationCreateTaskAction = z.infer<typeof createTaskActionSchema>;

/** «Надіслати тест» (BR-AUT-051): документ, дані якого підставляються в шаблони правила. */
export const automationRuleTestSchema = z.object({ documentId: uuid() });
export type AutomationRuleTestValues = z.infer<typeof automationRuleTestSchema>;
