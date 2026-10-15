import { BadRequestException } from '@nestjs/common';
import { InvoiceStatus, type Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { money, moneyFromDecimal } from '../../common/utils/money';

// Статуси, які дзеркало перераховує за сплаченим. DRAFT показує сплачене, але лишається DRAFT;
// CANCELLED — не активний рахунок, його дзеркало не чіпає (BR-INV-018).
const MIRRORED_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  InvoiceStatus.SENT,
  InvoiceStatus.PARTIALLY_PAID,
  InvoiceStatus.OVERDUE,
  InvoiceStatus.PAID,
]);

// Скільки разів перечитати рахунок, якщо його змінили між читанням і записом (паралельний
// перерахунок / відправка). Кожна спроба — CAS; після останньої — 400 «повторіть».
const MAX_ATTEMPTS = 3;

/**
 * Статус рахунку наряду за сплаченим (BR-INV-018). Чиста функція — її ж перевіряють спеки.
 * SENT / PARTIALLY_PAID / OVERDUE / PAID → PAID при повній сумі, PARTIALLY_PAID при частковій,
 * SENT при нулі (OVERDUE лишається OVERDUE); DRAFT і CANCELLED не змінюються.
 */
export function mirroredInvoiceStatus(
  status: InvoiceStatus,
  amount: number,
  paid: number,
): InvoiceStatus {
  if (!MIRRORED_STATUSES.has(status)) return status;
  if (amount > 0 && paid >= amount - 1e-9) return InvoiceStatus.PAID;
  if (paid > 1e-9) return InvoiceStatus.PARTIALLY_PAID;
  return status === InvoiceStatus.OVERDUE ? InvoiceStatus.OVERDUE : InvoiceStatus.SENT;
}

/**
 * BR-INV-018: рахунок наряду — дзеркало наряду. Активний (не скасований, не видалений) рахунок
 * наряду отримує `paidAmount = min(сплачено наряду, сума рахунку)` і статус за
 * `mirroredInvoiceStatus`. Викликати в ТІЙ САМІЙ транзакції після кожної зміни `paidAmount` наряду
 * (оплата, сторно) і після зміни суми чи статусу рахунку наряду (створення, оновлення з наряду,
 * перерахунок, відправка).
 *
 * Запис — CAS за прочитаними статусом, сумою і сплаченим (він же блокує рядок рахунку): паралельна
 * зміна рахунку → перечитати й порахувати заново. Рядок наряду викликач блокує раніше (оплата,
 * сторно, створення рахунку) — порядок блокувань «наряд → рахунок» той самий, що в оплаті.
 * Нічого не пише, якщо рахунку немає або він уже збігається з нарядом.
 */
export async function syncWorkOrderInvoicePaid(
  tx: Prisma.TransactionClient,
  orgId: string,
  workOrderId: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [wo, inv] = await Promise.all([
      tx.workOrder.findFirst({
        where: { id: workOrderId, orgId },
        select: { paidAmount: true },
      }),
      tx.invoice.findFirst({
        where: {
          workOrderId,
          orgId,
          deletedAt: null,
          status: { not: InvoiceStatus.CANCELLED },
        },
        select: { id: true, status: true, amount: true, paidAmount: true },
      }),
    ]);
    if (!wo || !inv) return;

    const amount = moneyFromDecimal(inv.amount);
    const paid = money(Math.min(moneyFromDecimal(wo.paidAmount), amount));
    const status = mirroredInvoiceStatus(inv.status, amount, paid);
    if (paid === moneyFromDecimal(inv.paidAmount) && status === inv.status) return;

    const moved = await tx.invoice.updateMany({
      where: {
        id: inv.id,
        orgId,
        deletedAt: null,
        status: inv.status,
        amount: inv.amount,
        paidAmount: inv.paidAmount,
      },
      data: { paidAmount: paid, status },
    });
    if (moved.count === 1) return;
  }
  throw new BadRequestException(translateError('err.payment.invoiceConcurrentChange', getLocale()));
}
