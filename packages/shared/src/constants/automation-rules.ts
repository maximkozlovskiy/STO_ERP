// Автоматизація, блок 2 (docs/objects/automation.md, BR-AUT-001…032): канали, дії, умови, каталог
// змінних шаблону й типові правила організації. Одне джерело для api (двигун, валідація), web
// (конструктор правила, блок 4) і seed.
import {
  AUTOMATION_PAYMENT_ACTIVE_STATUS,
  AUTOMATION_PAYMENT_REVERSED_STATUS,
  type AutomationDocumentTypeValue,
  type AutomationEventKindValue,
} from './automation';
import {
  INVOICE_STATUS_LABELS,
  PO_STATUS_LABELS,
  STOCK_DOC_STATUS_LABELS,
  SUPPLIER_PAYMENT_STATUS_LABELS,
  SUPPLIER_RETURN_STATUS_LABELS,
  TASK_STATUS_LABELS,
  WO_STATUS_LABELS,
} from './statuses';

/**
 * Статуси кожного типу документа з назвами: перелік для умов «у статус / зі статусу» (перевірка
 * правила) і значення змінної `{{status}}`. Оплата клієнта — псевдостатуси «діє» / «сторновано»
 * (BR-AUT-060); онлайн-запис — статуси заявки. Паритет із Prisma-enum-ами стереже спек api.
 */
export const AUTOMATION_STATUS_LABELS: Record<
  AutomationDocumentTypeValue,
  Readonly<Record<string, string>>
> = {
  WORK_ORDER: WO_STATUS_LABELS,
  INVOICE: INVOICE_STATUS_LABELS,
  PURCHASE_ORDER: PO_STATUS_LABELS,
  STOCK_DOCUMENT: STOCK_DOC_STATUS_LABELS,
  PAYMENT: {
    [AUTOMATION_PAYMENT_ACTIVE_STATUS]: 'Діє',
    [AUTOMATION_PAYMENT_REVERSED_STATUS]: 'Сторновано',
  },
  SUPPLIER_PAYMENT: SUPPLIER_PAYMENT_STATUS_LABELS,
  SUPPLIER_RETURN: SUPPLIER_RETURN_STATUS_LABELS,
  BOOKING: { PENDING: 'Новий', CONFIRMED: 'Підтверджено', CANCELLED: 'Скасовано' },
  TASK: TASK_STATUS_LABELS,
};

/**
 * Причини пропуску дії / повідомлення (журнал, BR-AUT-050): код у `NotificationLog.skipReason` і
 * `AutomationRun.actionResults[].reason`; підпис — у каталозі web (блок 4).
 */
export const AUTOMATION_SKIP_REASONS = [
  'NO_CONTACT',
  'NO_SERVICE_MESSAGES',
  'NO_MARKETING_CONSENT',
  'NO_CHANNEL',
  'TELEGRAM_BOT_NOT_CONNECTED',
  'NO_RECIPIENTS',
  'NO_ASSIGNEE',
  'TASK_EXISTS',
] as const;
export type AutomationSkipReason = (typeof AUTOMATION_SKIP_REASONS)[number];

/** Тип повідомлення правила (BR-AUT-012). Дзеркало Prisma-enum `AutomationMessageKind`. */
export const AUTOMATION_MESSAGE_KINDS = ['SERVICE', 'MARKETING'] as const;
export type AutomationMessageKindValue = (typeof AUTOMATION_MESSAGE_KINDS)[number];

/**
 * Канали повідомлення правила в типовому порядку (BR-AUT-011): власний Telegram-бот, Viber, SMS,
 * email, Telegram через eSputnik. Правило задає власний порядок з цього переліку.
 */
export const AUTOMATION_CHANNELS = ['TELEGRAM_BOT', 'VIBER', 'SMS', 'EMAIL', 'TELEGRAM'] as const;
export type AutomationChannelValue = (typeof AUTOMATION_CHANNELS)[number];

/** Канали зовнішнього сповіщення працівнику (BR-AUT-022): бот або за телефоном. */
export const AUTOMATION_EMPLOYEE_CHANNELS = ['TELEGRAM_BOT', 'VIBER', 'SMS'] as const;
export type AutomationEmployeeChannelValue = (typeof AUTOMATION_EMPLOYEE_CHANNELS)[number];

export const AUTOMATION_ACTION_TYPES = [
  'client_message',
  'employee_notification',
  'create_task',
] as const;
export type AutomationActionTypeValue = (typeof AUTOMATION_ACTION_TYPES)[number];

/** Пріоритет задачі й умова «пріоритет» (дзеркало Prisma `WorkOrderPriority`). */
export const AUTOMATION_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

/** Типи ремонту наряду для умови правила (дзеркало Prisma `RepairCategory`, BR-AUT-003). */
export const AUTOMATION_REPAIR_CATEGORIES = [
  'MAINTENANCE',
  'CURRENT_REPAIR',
  'MAJOR_REPAIR',
  'BODY_REPAIR',
  'DIAGNOSTICS',
  'WARRANTY',
  'SEASONAL',
] as const;

/** Ролі працівників — одержувачі сповіщення за роллю (без клієнтської ролі `CLIENT`). */
export const AUTOMATION_RECIPIENT_ROLES = [
  'OWNER',
  'ADMIN',
  'RECEPTIONIST',
  'MECHANIC',
  'STOREKEEPER',
  'ACCOUNTANT',
  'XLSX_MANAGER',
] as const;

/**
 * Документи з клієнтом — лише для них дія «повідомлення клієнту» (BR-AUT-010): наряд, рахунок,
 * оплата — контрагент документа; онлайн-запис — телефон заявки.
 */
export const AUTOMATION_CLIENT_DOCUMENT_TYPES: readonly AutomationDocumentTypeValue[] = [
  'WORK_ORDER',
  'INVOICE',
  'PAYMENT',
  'BOOKING',
];

/** Документи із сумою — умова «сума ≥ X» (BR-AUT-003). */
export const AUTOMATION_AMOUNT_DOCUMENT_TYPES: readonly AutomationDocumentTypeValue[] = [
  'WORK_ORDER',
  'INVOICE',
  'PAYMENT',
  'PURCHASE_ORDER',
  'SUPPLIER_PAYMENT',
  'SUPPLIER_RETURN',
];

/** Документи з пріоритетом — умова «пріоритет» (BR-AUT-003). */
export const AUTOMATION_PRIORITY_DOCUMENT_TYPES: readonly AutomationDocumentTypeValue[] = [
  'WORK_ORDER',
  'TASK',
];

/**
 * Статуси, з якими документ народжується, — для подій «створено», де перелік відомий наперед
 * (BR-AUT-003). Оплата клієнта при створенні завжди «діє» (подія пише `toStatus: ACTIVE`): правило
 * «оплату створено → у статус «Сторновано»» ніколи б не спрацювало, тому схема його не приймає.
 * Тип без запису тут — без обмеження (початковий статус залежить від шляху створення).
 */
export const AUTOMATION_CREATED_STATUSES: Partial<
  Record<AutomationDocumentTypeValue, readonly string[]>
> = {
  PAYMENT: [AUTOMATION_PAYMENT_ACTIVE_STATUS],
};

/**
 * Змінні шаблону — `{{ключ}}`. Значення підставляє двигун з даних документа й події (BR-AUT-014):
 * `date` / `time` — момент події за Києвом; `totalAmount` — «1 250,00 грн»; `branchPhone` — телефон
 * організації (у філії власного телефону немає); `status` — назва статусу документа;
 * `vehicle` — «марка модель (номер)», `vehiclePlate` — лише номер;
 * `visitDate` / `visitTime` — бажаний час онлайн-запису; `estimateLink` — посилання на кошторис,
 * якщо його вже надсилали й термін не минув.
 */
export const AUTOMATION_VARIABLE_KEYS = [
  'documentNumber',
  'status',
  'clientName',
  'clientPhone',
  'supplierName',
  'vehicle',
  'vehiclePlate',
  'totalAmount',
  'date',
  'time',
  'visitDate',
  'visitTime',
  'taskTitle',
  'assigneeName',
  'branchName',
  'branchPhone',
  'estimateLink',
] as const;
export type AutomationVariableKey = (typeof AUTOMATION_VARIABLE_KEYS)[number];

const COMMON_VARIABLES = ['status', 'date', 'time', 'branchName', 'branchPhone'] as const;

/**
 * Каталог змінних події за типом документа (BR-AUT-014). Змінна поза каталогом типу правила —
 * помилка збереження, а не порожнє місце в тексті.
 */
export const AUTOMATION_VARIABLES: Record<
  AutomationDocumentTypeValue,
  readonly AutomationVariableKey[]
> = {
  WORK_ORDER: [
    'documentNumber',
    'clientName',
    'clientPhone',
    'vehicle',
    'vehiclePlate',
    'totalAmount',
    'estimateLink',
    ...COMMON_VARIABLES,
  ],
  INVOICE: [
    'documentNumber',
    'clientName',
    'clientPhone',
    'vehicle',
    'vehiclePlate',
    'totalAmount',
    ...COMMON_VARIABLES,
  ],
  PAYMENT: ['clientName', 'clientPhone', 'totalAmount', ...COMMON_VARIABLES],
  BOOKING: ['clientName', 'clientPhone', 'visitDate', 'visitTime', ...COMMON_VARIABLES],
  PURCHASE_ORDER: ['documentNumber', 'supplierName', 'totalAmount', ...COMMON_VARIABLES],
  STOCK_DOCUMENT: ['documentNumber', ...COMMON_VARIABLES],
  SUPPLIER_PAYMENT: ['documentNumber', 'supplierName', 'totalAmount', ...COMMON_VARIABLES],
  SUPPLIER_RETURN: ['documentNumber', 'supplierName', 'totalAmount', ...COMMON_VARIABLES],
  TASK: ['taskTitle', 'assigneeName', ...COMMON_VARIABLES],
};

const TEMPLATE_VARIABLE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Імена змінних `{{…}}` шаблону в порядку появи, без повторів. */
export function templateVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(TEMPLATE_VARIABLE_RE)) seen.add(m[1] ?? '');
  return [...seen];
}

/** BR-AUT-014: змінні шаблону поза каталогом типу документа (порожній масив — шаблон чистий). */
export function findUnknownTemplateVariables(
  template: string,
  documentType: AutomationDocumentTypeValue,
): string[] {
  const known: readonly string[] = AUTOMATION_VARIABLES[documentType];
  return templateVariables(template).filter(v => !known.includes(v));
}

/** Підставляє змінні в перевірений шаблон; змінна без значення — порожній рядок. */
export function renderAutomationTemplate(
  template: string,
  vars: Partial<Record<AutomationVariableKey, string>>,
): string {
  return template.replace(
    TEMPLATE_VARIABLE_RE,
    (_m, key: string) => vars[key as AutomationVariableKey] ?? '',
  );
}

export const AUTOMATION_RULE_NAME_MAX = 200;
export const AUTOMATION_TEMPLATE_BODY_MAX = 1000;
export const AUTOMATION_TEMPLATE_SUBJECT_MAX = 200;
export const AUTOMATION_ACTIONS_MAX = 10;
export const AUTOMATION_LIST_MAX = 50;
/** Найдовший термін задачі від події — 30 діб. */
export const AUTOMATION_TASK_DUE_HOURS_MAX = 720;

/**
 * Типові правила організації — заміна зашитих повідомлень (BR-AUT-007): створюються міграцією
 * даних для наявних організацій і `setup.service` для нової. `systemKey` — унікальний у межах org.
 * Кошторис лишається ручною кнопкою (шаблон `WO_ESTIMATE_READY`), нагадування ТО — етап 2.
 */
export interface AutomationDefaultRule {
  systemKey: string;
  name: string;
  documentType: AutomationDocumentTypeValue;
  eventKind: AutomationEventKindValue;
  toStatuses: readonly string[];
  messageKind: AutomationMessageKindValue;
  channels: readonly AutomationChannelValue[];
  body: string;
}

export const AUTOMATION_DEFAULT_RULES: readonly AutomationDefaultRule[] = [
  {
    systemKey: 'WO_COMPLETED_CLIENT',
    name: 'Наряд виконано — повідомити клієнта',
    documentType: 'WORK_ORDER',
    eventKind: 'STATUS_CHANGED',
    toStatuses: ['COMPLETED'],
    messageKind: 'SERVICE',
    channels: ['VIBER', 'SMS'],
    body:
      'Вітаємо, {{clientName}}! Ваш автомобіль {{vehicle}} готовий до видачі ' +
      '(наряд {{documentNumber}}, сума {{totalAmount}}). {{branchName}}, тел. {{branchPhone}}',
  },
  {
    systemKey: 'PAYMENT_CREATED_CLIENT',
    name: 'Оплату отримано — повідомити клієнта',
    documentType: 'PAYMENT',
    eventKind: 'CREATED',
    toStatuses: [],
    messageKind: 'SERVICE',
    channels: ['VIBER', 'SMS'],
    body:
      'Дякуємо, {{clientName}}! Оплату {{totalAmount}} отримано {{date}} о {{time}}. ' +
      '{{branchName}}, тел. {{branchPhone}}',
  },
  {
    systemKey: 'BOOKING_CREATED_CLIENT',
    name: 'Онлайн-запис створено — підтвердити клієнту',
    documentType: 'BOOKING',
    eventKind: 'CREATED',
    toStatuses: [],
    messageKind: 'SERVICE',
    channels: ['VIBER', 'SMS'],
    body:
      'Вітаємо, {{clientName}}! Запис на {{visitDate}} о {{visitTime}} прийнято. Чекаємо на вас ' +
      'у {{branchName}}, тел. {{branchPhone}}',
  },
];

/** `actions` типового правила — той самий JSON, що пише міграція даних (паритет стереже спек api). */
export function defaultRuleActions(rule: AutomationDefaultRule) {
  return [
    {
      type: 'client_message' as const,
      channels: [...rule.channels],
      template: { body: rule.body },
    },
  ];
}
