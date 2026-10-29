import type { Prisma } from '@prisma/client';
import { AUTOMATION_DEFAULT_RULES, defaultRuleActions } from '@sto/shared';

/**
 * Шаблон кошторису (ручна кнопка «Надіслати кошторис», `WO_ESTIMATE_READY`) — усі змінні, які
 * передає `WorkOrderShareService` (BR-AUT-007: кошторис лишається кнопкою, не правилом).
 */
export const ESTIMATE_READY_SMS_BODY =
  '{{clientName}}, кошторис {{woNumber}} на ремонт {{vehiclePlate}} готовий. ' +
  'Сума: {{totalAmount}} грн. Деталі: {{link}}';

/**
 * Рядки типових правил організації (BR-AUT-007) для `automationRule.createMany` — нова
 * організація (`setup.service`). Наявним організаціям ті самі правила пише міграція даних
 * `20261029230000_automation_default_rules`; паритет стереже `automation.default-rules.spec.ts`.
 */
export function defaultAutomationRuleRows(orgId: string): Prisma.AutomationRuleCreateManyInput[] {
  return AUTOMATION_DEFAULT_RULES.map(r => ({
    orgId,
    systemKey: r.systemKey,
    name: r.name,
    enabled: true,
    documentType: r.documentType,
    eventKind: r.eventKind,
    toStatuses: [...r.toStatuses],
    messageKind: r.messageKind,
    conditions: {},
    actions: defaultRuleActions(r),
  }));
}
