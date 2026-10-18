import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, SupplierOrderStatus } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../../common/tenant/tenant-context';

type Tx = Prisma.TransactionClient;

/** Подія після коміту: замовлення постачальнику чекає відправки в API (BR-SCON-009). */
export const SUPPLIER_ORDER_QUEUED_EVENT = 'supplier-order.queued';
export interface SupplierOrderQueuedEvent {
  orgId: string;
  purchaseOrderId: string;
}

/**
 * Зовнішнє замовлення вже в постачальника (або могло туди дійти): скасування без `force`
 * заборонено (BR-SCON-014). SENDING — відправка йде, результат ще невідомий.
 */
export const SENT_SUPPLIER_ORDER_STATUSES: readonly SupplierOrderStatus[] = [
  'SENDING',
  'PLACED',
  'CONFIRMED',
  'PARTIALLY_CONFIRMED',
  'READY',
  'SHIPPED',
  'UNKNOWN',
];

/**
 * Outbox передачі замовлення в API постачальника — листковий модуль без залежностей від
 * PurchaseOrdersModule і SupplierApiModule (немає циклу): FSM замовлення викликає його у СВОЇЙ
 * транзакції, а постановку в чергу робить SupplierApiModule, слухаючи подію після коміту;
 * пропущене підхоплює `sweep` (рядок `supplierApiStatus = QUEUED` — джерело правди).
 */
@Injectable()
export class SupplierOrderOutboxService {
  constructor(private readonly events: EventEmitter2) {}

  /**
   * BR-SCON-009, режим ON_ORDERED: перехід у «Замовлено» в тій самій транзакції ставить
   * `supplierApiStatus = QUEUED`, якщо в постачальника є увімкнене підключення, а в замовленні —
   * позиції списку з обраною пропозицією (ручні рядки в API не йдуть). Повертає, чи поставлено.
   */
  async onOrderedInTx(tx: Tx, orgId: string, purchaseOrderId: string): Promise<boolean> {
    const settings = await tx.organisationSettings.findUnique({
      where: { orgId },
      select: { supplierOrderSendMode: true },
    });
    if (settings?.supplierOrderSendMode !== 'ON_ORDERED') return false;
    const po = await tx.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, orgId, deletedAt: null },
      select: { supplierId: true },
    });
    if (!po) return false;
    const [withOffer, connections] = await Promise.all([
      tx.purchaseListItem.count({
        where: { orgId, purchaseOrderId, deletedAt: null, NOT: { offerKey: null } },
      }),
      tx.supplierConnection.count({
        where: { orgId, counterpartyId: po.supplierId, enabled: true, deletedAt: null },
      }),
    ]);
    if (withOffer === 0 || connections === 0) return false;
    const res = await tx.purchaseOrder.updateMany({
      where: {
        id: purchaseOrderId,
        orgId,
        deletedAt: null,
        supplierApiStatus: { in: ['NOT_SENT', 'FAILED'] },
      },
      data: { supplierApiStatus: 'QUEUED', supplierApiError: null },
    });
    return res.count === 1;
  }

  /** Після коміту транзакції переходу — сигнал SupplierApiModule поставити задачу. */
  afterCommit(orgId: string, purchaseOrderId: string): void {
    const payload: SupplierOrderQueuedEvent = { orgId, purchaseOrderId };
    this.events.emit(SUPPLIER_ORDER_QUEUED_EVENT, payload);
  }

  /**
   * BR-SCON-014 / BR-PO-012: скасування чи видалення замовлення, переданого постачальнику, —
   * 400 `cancelSentOrder` без `force`. API постачальника не викликається; ще не відправлені
   * зовнішні замовлення скасовуються тут же, щоб обробник їх не відправив.
   */
  async assertCancellable(
    tx: Tx,
    orgId: string,
    purchaseOrderId: string,
    force: boolean,
  ): Promise<void> {
    const sent = await tx.supplierOrder.count({
      where: {
        orgId,
        purchaseOrderId,
        deletedAt: null,
        status: { in: [...SENT_SUPPLIER_ORDER_STATUSES] },
      },
    });
    if (sent > 0 && !force) {
      throw new BadRequestException(translateError('err.supplierApi.cancelSentOrder', getLocale()));
    }
    await tx.supplierOrder.updateMany({
      where: { orgId, purchaseOrderId, deletedAt: null, status: 'QUEUED' },
      data: { status: 'CANCELLED', nextPollAt: null },
    });
  }
}
