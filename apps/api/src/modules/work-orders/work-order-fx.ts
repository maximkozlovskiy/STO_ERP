import type { Prisma } from '@prisma/client';
import { money, moneyFromDecimal } from '../../common/utils/money';
import type { SettlementsService } from '../settlements/settlements.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { isWorkOrderFullyPaid } from './work-order-status';
import { hasNetFx, netFxBalanceEffect, type FxDocumentFilter } from '../settlements/fx-net';

// Борг наряду вже нараховано (CHARGE при «Виконано») — лише тоді є з чим порівнювати оплати.
const CHARGED_STATUSES = new Set(['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED']);

/**
 * BR-PAY-022: курсова різниця наряду в іноземній валюті — коли наряд сплачено повністю і борг уже
 * нараховано. CHARGE брав курс дати документа, оплати — курс своїх дат, тож базовий залишок
 * контрагента за нарядом ≠ 0; одна проводка FX_LOSS / FX_GAIN його обнуляє.
 *
 * Нараховано — Σ `amountBase` проводок CHARGE наряду; сплачено — Σ `amountBase` оплат наряду без
 * сторно. Документ проводки — `WorkOrder`. Повторно не проводиться, поки чиста курсова різниця
 * наряду й будь-якого його рахунку ≠ 0 (старий шлях «рахунок став PAID» проводив її на `Invoice`);
 * сторно, що зробило наряд не сплаченим, її обнуляє (BR-PAY-028) — тоді повна оплата пише заново.
 *
 * Викликати в транзакції, що зробила наряд сплаченим (оплата) або нарахувала борг (перехід у
 * «Виконано»), ПІСЛЯ запису оплати. Нічого не робить для базової валюти і неповної оплати.
 */
export async function postWorkOrderFxInTx(
  tx: Prisma.TransactionClient,
  deps: { settlements: SettlementsService; exchangeRates: ExchangeRatesService },
  orgId: string,
  workOrderId: string,
  userId?: string,
): Promise<void> {
  const wo = await tx.workOrder.findFirst({
    where: { id: workOrderId, orgId, deletedAt: null },
    select: {
      status: true,
      currencyId: true,
      counterpartyId: true,
      totalAmount: true,
      paidAmount: true,
    },
  });
  if (!wo || !CHARGED_STATUSES.has(wo.status)) return;
  if (!isWorkOrderFullyPaid(wo.totalAmount, wo.paidAmount)) return;
  if (await deps.exchangeRates.sameCurrency(orgId, null, wo.currencyId)) return;

  const fxNet = await netFxBalanceEffect(
    tx,
    orgId,
    await workOrderFxDocuments(tx, orgId, workOrderId),
  );
  if (hasNetFx(fxNet)) return;

  const [chargeAgg, paidAgg] = await Promise.all([
    tx.settlementTransaction.aggregate({
      where: { orgId, type: 'CHARGE', documentType: 'WorkOrder', documentId: workOrderId },
      _sum: { amountBase: true },
    }),
    tx.payment.aggregate({
      where: { orgId, workOrderId, reversedAt: null },
      _sum: { amountBase: true },
    }),
  ]);
  const chargeBase = moneyFromDecimal(chargeAgg._sum.amountBase);
  const paidBase = moneyFromDecimal(paidAgg._sum.amountBase);
  const fx = money(chargeBase - paidBase);
  // EPS 0.005: копійчаний дрейф округлення / той самий курс → проводка не потрібна.
  if (Math.abs(fx) < 0.005) return;
  await deps.settlements.createTransaction(
    orgId,
    {
      counterpartyId: wo.counterpartyId,
      // fx>0: нарахували більше base, ніж отримали → збиток (гасить додатний залишок).
      type: fx > 0 ? 'FX_LOSS' : 'FX_GAIN',
      amount: Math.abs(fx),
      // БЕЗ currencyId → base-дельта (rate=1, base=amount); інакше повторна конвертація зіпсує суму.
      documentType: 'WorkOrder',
      documentId: workOrderId,
      notes: `Курсова різниця: нараховано ${chargeBase.toFixed(2)} за курсом документа, отримано ${paidBase.toFixed(2)} за курсом оплат`,
      createdBy: userId,
    },
    tx,
  );
}

/**
 * Документи, на яких могла лягти курсова різниця наряду: сам наряд і його рахунки (з видаленими
 * й скасованими — старий шлях «рахунок став PAID» проводив FX на рахунок).
 */
export async function workOrderFxDocuments(
  tx: Prisma.TransactionClient,
  orgId: string,
  workOrderId: string,
): Promise<FxDocumentFilter[]> {
  const invoices = await tx.invoice.findMany({
    where: { orgId, workOrderId },
    select: { id: true },
    // Рахунки одного наряду — одиниці; межа — від OOM, не відбір.
    take: 500,
  });
  return [
    { documentType: 'WorkOrder', documentId: workOrderId },
    ...(invoices.length > 0
      ? [{ documentType: 'Invoice', documentId: { in: invoices.map(i => i.id) } }]
      : []),
  ];
}
