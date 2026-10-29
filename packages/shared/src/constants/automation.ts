// Автоматизація (docs/objects/automation.md, BR-AUT-*): спільні для api і web переліки. Значення
// дзеркалять Prisma-enum-и `AutomationDocumentType` / `AutomationEventKind` (13_automation.prisma);
// паритет стереже спек api.

/** Документи, події яких фіксує outbox `DomainEvent` і на які можна ставити правила. */
export const AUTOMATION_DOCUMENT_TYPES = [
  'WORK_ORDER',
  'INVOICE',
  'PURCHASE_ORDER',
  'STOCK_DOCUMENT',
  'PAYMENT',
  'SUPPLIER_PAYMENT',
  'SUPPLIER_RETURN',
  'BOOKING',
  'TASK',
] as const;
export type AutomationDocumentTypeValue = (typeof AUTOMATION_DOCUMENT_TYPES)[number];

/** Етап 1: «документ створено» і «статус змінено» (BR-AUT-002). Події за часом — етап 2. */
export const AUTOMATION_EVENT_KINDS = ['CREATED', 'STATUS_CHANGED'] as const;
export type AutomationEventKindValue = (typeof AUTOMATION_EVENT_KINDS)[number];

/**
 * Псевдостатус «оплату сторновано» для оплат клієнта й постачальнику: поля статусу в `Payment`
 * немає (є `reversedAt`), але сторно — подія STATUS_CHANGED, на яку ставлять правила.
 */
export const AUTOMATION_PAYMENT_REVERSED_STATUS = 'REVERSED';

/** Термін дії одноразового коду підписки на Telegram-бот (рішення власника 2026-10-29). */
export const TELEGRAM_LINK_CODE_TTL_DAYS = 7;
