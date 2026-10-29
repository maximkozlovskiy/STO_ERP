import type { DomainEvent } from '@prisma/client';

/**
 * Точка розширення обробки outbox (BR-AUT-061): двигун правил (блок 2) — один з обробників.
 * Обробник викликається в tenant-scope організації події; кинута помилка — подія лишається
 * необробленою (`attempts`+1, `lastError`), повтор — з експоненційною паузою.
 *
 * Обробник має бути ідемпотентним: подію можуть обробити повторно після збою іншого обробника
 * чи падіння процесу між обробкою й позначкою `processedAt` (дедуплікація — BR-AUT-004).
 */
export interface DomainEventHandler {
  readonly name: string;
  handle(event: DomainEvent): Promise<void>;
}

/** DI-токен масиву обробників. Блок 1 — порожній: подія лише позначається обробленою. */
export const DOMAIN_EVENT_HANDLERS = Symbol('DOMAIN_EVENT_HANDLERS');
