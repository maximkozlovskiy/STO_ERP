import type { Prisma } from '@prisma/client';
import { money, moneyFromDecimal } from '../../common/utils/money';
import type { SettlementsService } from '../settlements/settlements.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { isWorkOrderFullyPaid } from './work-order-status';

// Борг наряду вже нараховано (CHARGE при «Виконано») — лише тоді є з чим порівнювати оплати.
const CHARGED_STATUSES = new Set(['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED']);

/**
 * BR-PAY-022: курсова різниця наряду в іноземній валюті — коли наряд сплачено повністю і борг уже
 * нараховано. CHARGE брав курс дати документа, оплати — курс своїх дат, тож базовий залишок
 * контрагента за нарядом ≠ 0; одна проводка FX_LOSS / FX_GAIN його обнуляє.
 *
 * Нараховано — Σ `amountBase` проводок CHARGE наряду; сплачено — Σ `amountBase` оплат наряду без
 * сторно. Документ проводки — `WorkOrder`. Повторно не проводиться: якщо вже є курсова проводка
 * наряду або будь-якого його рахунку (старий шлях «рахунок став PAID» проводив її на `Invoice`).
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

  const invoices = await tx.invoice.findMany({
    where: { orgId, workOrderId },
    select: { id: true },
  });
  const fxExisting = await tx.settlementTransaction.count({
    where: {
      orgId,
      type: { in: ['FX_GAIN', 'FX_LOSS'] },
      OR: [
        { documentType: 'WorkOrder', documentId: workOrderId },
        ...(invoices.length > 0
          ? [{ documentType: 'Invoice', documentId: { in: invoices.map(i => i.id) } }]
          : []),
      ],
    },
  });
  if (fxExisting > 0) return;

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
