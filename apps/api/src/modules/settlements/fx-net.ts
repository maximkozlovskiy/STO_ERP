import { SupplierPaymentStatus, type Prisma } from '@prisma/client';
import { money, moneyFromDecimal } from '../../common/utils/money';
import type { SettlementsService } from './settlements.service';

/** Нижче — копійчаний дрейф округлення: курсової різниці немає (як EPS у проводці FX). */
export const FX_NET_EPS = 0.005;

/** Документ, за яким ведеться курсова різниця: проводки FX несуть його `documentType` / `documentId`. */
export type FxDocumentFilter = Pick<
  Prisma.SettlementTransactionWhereInput,
  'documentType' | 'documentId'
>;

/**
 * Чистий вплив курсових різниць документа на баланс контрагента в базовій валюті:
 * Σ `FX_GAIN` (+) − Σ `FX_LOSS` (−), як `BALANCE_SIGN`. Не 0 — курсову різницю визнано й не
 * відкочено; 0 — її не проводили або сторно її вже відкотило (BR-PAY-022, BR-PAY-028, BR-SUPPAY-012).
 */
export async function netFxBalanceEffect(
  tx: Prisma.TransactionClient,
  orgId: string,
  documents: FxDocumentFilter[],
): Promise<number> {
  if (documents.length === 0) return 0;
  const sumOf = (type: 'FX_GAIN' | 'FX_LOSS') =>
    tx.settlementTransaction.aggregate({
      where: { orgId, type, OR: documents },
      _sum: { amountBase: true },
    });
  const [gain, loss] = await Promise.all([sumOf('FX_GAIN'), sumOf('FX_LOSS')]);
  return money(moneyFromDecimal(gain._sum.amountBase) - moneyFromDecimal(loss._sum.amountBase));
}

/** Курсову різницю документа вже визнано (чиста FX ≠ 0) — повторно не проводиться. */
export function hasNetFx(net: number): boolean {
  return Math.abs(net) >= FX_NET_EPS;
}

/**
 * BR-PAY-028 / BR-SUPPAY-012: сторно зробило документ не повністю сплаченим — курсова різниця,
 * визнана при повній оплаті, більше не має підстави. Одна проводка протилежного знаку на ЧИСТУ суму
 * обнуляє вплив FX документа (`documents` — усі документи, на яких її могли провести); проводиться
 * на `target`. Чиста FX уже 0 — нічого не пише, тож повторний виклик безпечний. Наступна повна
 * оплата бачить чисту FX = 0 і визнає курсову різницю заново за курсами оплат, що лишились.
 */
export async function reverseNetFxInTx(
  tx: Prisma.TransactionClient,
  settlements: SettlementsService,
  orgId: string,
  params: {
    counterpartyId: string;
    target: { documentType: string; documentId: string };
    documents: FxDocumentFilter[];
    notes: string;
    userId?: string;
  },
): Promise<void> {
  const net = await netFxBalanceEffect(tx, orgId, params.documents);
  if (!hasNetFx(net)) return;
  await settlements.createTransaction(
    orgId,
    {
      counterpartyId: params.counterpartyId,
      // Чистий FX_GAIN (+) гасить FX_LOSS (−) на ту саму суму, і навпаки.
      type: net > 0 ? 'FX_LOSS' : 'FX_GAIN',
      amount: Math.abs(net),
      // БЕЗ currencyId → базова дельта (rate=1, base=amount), як і сама курсова різниця.
      documentType: params.target.documentType,
      documentId: params.target.documentId,
      notes: params.notes,
      createdBy: params.userId,
    },
    tx,
  );
}

/**
 * BR-SUPPAY-012 / 018: курсова різниця прийнятого й повністю сплаченого валютного замовлення
 * постачальнику — одна функція для обох порядків подій: проведення оплати, що зробила ПРИЙНЯТЕ
 * замовлення сплаченим повністю (`SupplierPaymentsService.confirm`), і прийому, що перевів
 * ПЕРЕДОПЛАЧЕНЕ замовлення в «Отримано» (`PurchaseOrdersService.receive`). Умови (статус «Отримано»,
 * `paidAt`, валюта не базова) перевіряє виклик; тут — лише сума.
 *
 * Чиста FX замовлення вже ≠ 0 — визнано, нічого не пише (повтор безпечний). Інакше
 * `fx = Σ SUPPLIER_CHARGE.amountBase замовлення − Σ SUPPLIER_PAYMENT.amountBase його проведених
 * оплат`: нараховано за курсами прийомів, сплачено за курсами оплат — результат не залежить від
 * того, що було раніше. Сплачено у валюті більше, ніж нараховано, — у суму йдуть лише оплати в межах
 * нарахованого (Bug #1061). Викликати в транзакції запису — після проводки, яку сума має включати.
 */
export async function recognizeSupplierOrderFxInTx(
  tx: Prisma.TransactionClient,
  settlements: SettlementsService,
  orgId: string,
  params: { purchaseOrderId: string; supplierId: string; userId?: string },
): Promise<void> {
  const poId = params.purchaseOrderId;
  const [chargeAgg, spIds, fxNet] = await Promise.all([
    tx.settlementTransaction.aggregate({
      where: { orgId, type: 'SUPPLIER_CHARGE', documentType: 'PurchaseOrder', documentId: poId },
      _sum: { amount: true, amountBase: true },
    }),
    tx.supplierPayment.findMany({
      where: {
        orgId,
        purchaseOrderId: poId,
        status: SupplierPaymentStatus.CONFIRMED,
        deletedAt: null,
      },
      select: { id: true },
      take: 500,
    }),
    // Чиста FX ≠ 0 — уже визнано; сторно, що зробило замовлення не сплаченим, її обнуляє
    // (BR-SUPPAY-012) — тоді наступна повна оплата визнає її заново.
    netFxBalanceEffect(tx, orgId, [{ documentType: 'PurchaseOrder', documentId: poId }]),
  ]);
  if (hasNetFx(fxNet)) return;
  const paidWhere: Prisma.SettlementTransactionWhereInput = {
    orgId,
    type: 'SUPPLIER_PAYMENT',
    documentType: 'SupplierPayment',
    documentId: { in: spIds.map(s => s.id) },
  };
  const paidAgg = await tx.settlementTransaction.aggregate({
    where: paidWhere,
    _sum: { amount: true, amountBase: true },
  });
  const chargeBase = moneyFromDecimal(chargeAgg._sum.amountBase);
  const chargeAmount = moneyFromDecimal(chargeAgg._sum.amount);
  // Bug #1061: переплата (сплачено у валюті замовлення більше, ніж нараховано — переплата чи
  // «Отримано» без приймання) — не курсова різниця: FX лише на сплачене в межах нарахованого
  // (оплати по черзі проведення), надлишок лишається авансом за курсом своєї оплати.
  const paidBase =
    money(moneyFromDecimal(paidAgg._sum.amount) - chargeAmount) >= FX_NET_EPS
      ? await paidBaseWithinCharge(tx, paidWhere, chargeAmount)
      : moneyFromDecimal(paidAgg._sum.amountBase);
  const fx = money(chargeBase - paidBase);
  if (Math.abs(fx) < FX_NET_EPS) return;
  await settlements.createTransaction(
    orgId,
    {
      counterpartyId: params.supplierId,
      // ⚠️ ІНВЕРСІЯ клієнта: SUPPLIER_CHARGE(−1)/SUPPLIER_PAYMENT(+1) → залишок = paidBase−chargeBase.
      // fx>0 (нарахували більше base) → залишок ВІД'ЄМНИЙ → FX_GAIN(+1) підіймає до 0.
      // fx<0 (сплатили більше) → залишок ДОДАТНИЙ → FX_LOSS(−1). НЕ копіювати клієнтський тернарник!
      type: fx > 0 ? 'FX_GAIN' : 'FX_LOSS',
      amount: Math.abs(fx),
      // БЕЗ currencyId → base-дельта (rate=1, base=amount).
      documentType: 'PurchaseOrder',
      documentId: poId,
      notes: `Курсова різниця (постачальник): нараховано ${chargeBase.toFixed(2)} за курсом прийому, сплачено ${paidBase.toFixed(2)} за курсом оплат`,
      createdBy: params.userId,
    },
    tx,
  );
}

/**
 * Базова сума оплат замовлення в межах нарахованого (`chargeAmount` у валюті замовлення): оплати по
 * черзі проведення, остання — пропорційно своїй частці. Нічого не нараховано — 0 (FX немає).
 */
async function paidBaseWithinCharge(
  tx: Prisma.TransactionClient,
  where: Prisma.SettlementTransactionWhereInput,
  chargeAmount: number,
): Promise<number> {
  const rows = await tx.settlementTransaction.findMany({
    where,
    select: { amount: true, amountBase: true },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  let left = chargeAmount;
  let base = 0;
  for (const row of rows) {
    if (left < FX_NET_EPS) break;
    const amount = moneyFromDecimal(row.amount);
    if (amount <= 0) continue;
    const part = Math.min(amount, left);
    base += (moneyFromDecimal(row.amountBase) * part) / amount;
    left = money(left - part);
  }
  return money(base);
}
