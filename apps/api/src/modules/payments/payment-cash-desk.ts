import { PaymentSourceType, type Prisma } from '@prisma/client';

/** Поля оплати, з яких видно, що гроші лягли в касу. */
export interface PaymentCashDeskFields {
  id: string;
  sourceType: PaymentSourceType | null;
  cashRegisterId: string | null;
}

/**
 * BR-PAY-024: які з оплат лежать у касі — їх сторнують лише в касі (там сторно — ще й рядок
 * протилежного напряму), `POST /payments/:id/reverse` відповідає `err.payment.reversalCashRow`.
 *
 * Каса — `sourceType = CASH_REGISTER`, `cashRegisterId`, або рядок каси з `documentType = 'Payment'`
 * на цю оплату: стара готівкова оплата (до BR-PAY-023) призначення не має, а рядок каси — має.
 *
 * Одна функція і для відмови `reverseNonCash`, і для ознаки `inCashDesk` рядка оплати в «Пов'язаних
 * документах»: кнопка «Сторнувати» не обіцяє дії, яку сервер відхилить. Один запит на всі оплати.
 */
export async function paymentsInCashDesk(
  db: Pick<Prisma.TransactionClient, 'cashOperation'>,
  orgId: string,
  payments: readonly PaymentCashDeskFields[],
): Promise<Set<string>> {
  const inCash = new Set<string>();
  const unknown: string[] = [];
  for (const p of payments) {
    if (p.sourceType === PaymentSourceType.CASH_REGISTER || p.cashRegisterId) inCash.add(p.id);
    else unknown.push(p.id);
  }
  if (unknown.length === 0) return inCash;
  // CashOperation — append-only (без deletedAt). Рядок сторно теж може посилатись на оплату,
  // тож `distinct`: одна відповідь на оплату, і `take` її не обрізає.
  const rows = await db.cashOperation.findMany({
    where: { orgId, documentType: 'Payment', documentId: { in: unknown } },
    select: { documentId: true },
    distinct: ['documentId'],
    take: unknown.length,
  });
  for (const r of rows) if (r.documentId) inCash.add(r.documentId);
  return inCash;
}

/** Що читає секція «Оплати» «Пов'язаних документів» (наряд, рахунок) — понад поля самого рядка. */
export interface LinkedPaymentSource extends PaymentCashDeskFields {
  amount: Prisma.Decimal | number | string;
  onlinePaymentIntentId: string | null;
  /** Валюта оплати; null — базова (оплата без `currencyId`). */
  currency?: { code: string } | null;
}

/**
 * Рядки секції «Оплати» «Пов'язаних документів» (BR-PAY-024): сума — число (§13) з кодом валюти
 * оплати (`currencyCode`, null — базова; Bug #1018), ознаки «онлайн-оплата QR» (`isOnline`) і «лежить
 * у касі» (`inCashDesk`, `paymentsInCashDesk`). Службові поля — id онлайн-наміру й каси — клієнту не йдуть.
 */
export async function toLinkedPaymentRows<T extends LinkedPaymentSource>(
  db: Pick<Prisma.TransactionClient, 'cashOperation'>,
  orgId: string,
  payments: readonly T[],
): Promise<
  Array<
    Omit<T, 'amount' | 'onlinePaymentIntentId' | 'cashRegisterId' | 'currency'> & {
      amount: number;
      currencyCode: string | null;
      isOnline: boolean;
      inCashDesk: boolean;
    }
  >
> {
  const inCash = await paymentsInCashDesk(db, orgId, payments);
  return payments.map(
    ({ onlinePaymentIntentId, cashRegisterId: _cashRegisterId, amount, currency, ...rest }) => ({
      ...rest,
      amount: Number(amount),
      currencyCode: currency?.code ?? null,
      isOnline: onlinePaymentIntentId != null,
      inCashDesk: inCash.has(rest.id),
    }),
  );
}
