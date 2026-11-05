import { BadRequestException } from '@nestjs/common';
import { PurchaseOrderStatus, type Prisma } from '@prisma/client';

import { err } from '../../common/utils/err';
import { withOrderedStamps } from '../../common/utils/line-order';
import { recordDocumentEvent } from '../automation/record-document-event';
import type { PurchaseListLinkService } from '../purchase-lists/purchase-list-link.service';

/**
 * Записи замовлення постачальнику, що мають наслідки для списків купівлі (BR-PO-010): зміна
 * статусу (`setStatus`), заміна рядків чернетки (`replaceDraftLines`), закриття для списків
 * (`closeOrderForPurchaseLists`). Хуки підключаються ТУТ, а не в кожному місці виклику: забутий
 * хук у переході «Отримано» залишав позиції ORDERED на закритому замовленні.
 *
 * Порядок блокувань — «позиції списків → рядок замовлення»: хук пише позиції ДО запису рядка
 * замовлення (приймання блокує позиції розподілом раніше за статус замовлення; зворотний порядок
 * давав би deadlock паралельних «Прийняти» і «Скасувати»).
 *
 * Функції, а не провайдер: імпорт XLSX (`PurchaseOrderImportAdapter`) кличе ту саму заміну рядків,
 * не залежачи від `PurchaseOrdersModule`; хуки передає виклик (`PurchaseListLinkService`).
 */

type Tx = Prisma.TransactionClient;

/** Хуки списків купівлі, якими замовлення повідомляє про свої зміни (BR-PL-009, 010, 012). */
export type PurchaseListHooks = Pick<
  PurchaseListLinkService,
  'onOrderClosed' | 'reconcileDraftOrder'
>;

/**
 * Статуси, у яких замовлення закрите для списків: неотримане повертається в позиції — скасоване
 * (BR-PL-010) і отримане, зокрема переходом «Отримано» без приймання (BR-PL-012).
 */
const CLOSED_FOR_LISTS: ReadonlySet<PurchaseOrderStatus> = new Set<PurchaseOrderStatus>([
  PurchaseOrderStatus.CANCELLED,
  PurchaseOrderStatus.RECEIVED,
]);

/** Замовлення закрито (скасовано, отримано, видалено) — неотримане повертається в позиції. */
export function closeOrderForPurchaseLists(
  tx: Tx,
  lists: PurchaseListHooks,
  orgId: string,
  purchaseOrderId: string,
): Promise<void> {
  return lists.onOrderClosed(tx, orgId, purchaseOrderId);
}

/**
 * BR-PL-009: рядки чернетки записано (заміна, дописування, швидкий імпорт) чи змінено склад —
 * позиції списків звіряються. `warehouseId` — склад після правки, коли його могли змінити.
 * Кликати ПІСЛЯ запису рядків і ДО запису рядка замовлення (тотали, поля форми).
 */
export function reconcileDraftLists(
  tx: Tx,
  lists: PurchaseListHooks,
  orgId: string,
  purchaseOrderId: string,
  warehouseId?: string,
): Promise<void> {
  return warehouseId === undefined
    ? lists.reconcileDraftOrder(tx, orgId, purchaseOrderId)
    : lists.reconcileDraftOrder(tx, orgId, purchaseOrderId, warehouseId);
}

export interface SetStatusInput {
  orgId: string;
  id: string;
  /** Статус, прочитаний викликом: запис — CAS за ним. */
  from: PurchaseOrderStatus;
  to: PurchaseOrderStatus;
  actorId?: string | null;
  /** Поля, що пишуться тим самим записом (дата оплати при повному прийманні). */
  data?: Omit<Prisma.PurchaseOrderUpdateManyMutationInput, 'status'>;
}

/**
 * Єдиний запис статусу замовлення: хук списків для закриття (до запису рядка замовлення) → CAS
 * за прочитаним статусом (паралельний перехід — 400 `statusChanged`, відкат транзакції) → подія
 * документа (BR-AUT-060). `from === to` (частковий прийом без зміни статусу) — CAS без події.
 */
export async function setStatus(
  tx: Tx,
  lists: PurchaseListHooks,
  input: SetStatusInput,
): Promise<void> {
  const { orgId, id, from, to } = input;
  if (CLOSED_FOR_LISTS.has(to)) await closeOrderForPurchaseLists(tx, lists, orgId, id);
  const moved = await tx.purchaseOrder.updateMany({
    where: { id, orgId, deletedAt: null, status: from },
    data: { ...input.data, status: to },
  });
  if (moved.count === 0) {
    throw new BadRequestException(err('err.purchaseOrder.statusChanged'));
  }
  await recordDocumentEvent(tx, {
    orgId,
    documentType: 'PURCHASE_ORDER',
    documentId: id,
    kind: 'STATUS_CHANGED',
    fromStatus: from,
    toStatus: to,
    actorId: input.actorId ?? null,
  });
}

/** Рядок чернетки до запису: ПДВ уже пораховано викликом (режим організації). */
export interface DraftLineInput {
  goodId: string;
  quantity: number;
  price: number;
  vatRate: number;
  vatAmount: number;
  pricedSalePrice?: number | null;
}

/**
 * Єдина заміна рядків чернетки (картка — PATCH, імпорт XLSX «замінити»): soft delete наявних +
 * нові з `createdAt` у порядку надсилання (BR-PO-016) + звірка позицій списків (BR-PL-009).
 * Тотали й поля замовлення пише виклик ПІСЛЯ — порядок блокувань «позиції → замовлення».
 */
export async function replaceDraftLines(
  tx: Tx,
  lists: PurchaseListHooks,
  input: {
    orgId: string;
    purchaseOrderId: string;
    lines: readonly DraftLineInput[];
    warehouseId?: string;
  },
): Promise<void> {
  const { orgId, purchaseOrderId, lines } = input;
  await tx.purchaseOrderLine.updateMany({
    where: { purchaseOrderId, orgId },
    data: { deletedAt: new Date() },
  });
  if (lines.length) {
    await tx.purchaseOrderLine.createMany({
      data: withOrderedStamps(
        lines.map(l => ({
          orgId,
          purchaseOrderId,
          goodId: l.goodId,
          quantity: l.quantity,
          price: l.price,
          vatRate: l.vatRate,
          vatAmount: l.vatAmount,
          ...(l.pricedSalePrice != null ? { pricedSalePrice: l.pricedSalePrice } : {}),
        })),
      ),
    });
  }
  await reconcileDraftLists(tx, lists, orgId, purchaseOrderId, input.warehouseId);
}
