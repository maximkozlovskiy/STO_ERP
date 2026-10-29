import type { AutomationDocumentType, AutomationEventKind, Prisma } from '@prisma/client';

/** Подія документа для outbox `DomainEvent` (BR-AUT-060). */
export interface DocumentEventInput {
  orgId: string;
  documentType: AutomationDocumentType;
  documentId: string;
  kind: AutomationEventKind;
  fromStatus?: string | null;
  toStatus?: string | null;
  /** Працівник-ініціатор (BR-AUT-023); `null` / не задано — система (job, процесор). */
  actorId?: string | null;
}

/** «Статус змінено» без зміни статусу — не подія (BR-AUT-060). */
function isNoopStatusChange(e: DocumentEventInput): boolean {
  return e.kind === 'STATUS_CHANGED' && (e.fromStatus ?? null) === (e.toStatus ?? null);
}

function toRow(e: DocumentEventInput): Prisma.DomainEventCreateManyInput {
  return {
    orgId: e.orgId,
    documentType: e.documentType,
    documentId: e.documentId,
    kind: e.kind,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    actorId: e.actorId ?? null,
  };
}

/**
 * BR-AUT-060: пише подію документа в outbox `DomainEvent` у ПЕРЕДАНІЙ транзакції — тій самій, що
 * змінює документ. Відкат зміни відкочує й подію; падіння процесу після коміту подію не губить
 * (її підбере job `automation-events`, BR-AUT-061).
 *
 * `tx` — завжди клієнт транзакції (`$transaction(async tx => …)`), не `this.prisma`: подія поза
 * транзакцією документа може лишитись без зміни або зміна — без події. Тест-перепис точок запису
 * статусу (`record-document-event.census.spec.ts`) вимагає цей виклик поруч із кожним записом.
 */
export async function recordDocumentEvent(
  tx: Prisma.TransactionClient,
  event: DocumentEventInput,
): Promise<void> {
  if (isNoopStatusChange(event)) return;
  await tx.domainEvent.create({ data: toRow(event) });
}

/**
 * Кілька подій однією вставкою (нічний OVERDUE — подія на кожен рахунок, BR-AUT-060). Ті самі
 * правила, що й у `recordDocumentEvent`: без зміни статусу — пропуск.
 */
export async function recordDocumentEvents(
  tx: Prisma.TransactionClient,
  events: readonly DocumentEventInput[],
): Promise<void> {
  const rows = events.filter(e => !isNoopStatusChange(e)).map(toRow);
  if (rows.length === 0) return;
  await tx.domainEvent.createMany({ data: rows });
}
