// sto-review §13: import Prisma's VatMode enum so consumers don't need
// `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'` casts. Prisma enum at runtime is a
// string literal union that matches this local type.
import type { VatMode } from '@prisma/client';
import { money, type Money } from './money';

interface LineVatResult {
  vatAmount: Money;
  priceWithoutVat: Money;
  priceWithVat: Money;
}

// FIN-H1/WO-H2: усі грошові результати квантуються до копійки (roundMoney) на кожному кроці —
// інакше float-дрейф (60.059999…) псує Σ==total і priceWithoutVat+vatAmount≠priceWithVat.
export function calcLineVat(
  price: number,
  qty: number,
  vatRate: number,
  vatMode: VatMode,
): LineVatResult {
  if (vatMode === 'NONE' || vatRate === 0) {
    return { vatAmount: money(0), priceWithoutVat: money(price), priceWithVat: money(price) };
  }
  const sum = price * qty;
  if (vatMode === 'EXCLUSIVE') {
    return {
      vatAmount: money((sum * vatRate) / 100),
      priceWithoutVat: money(price),
      priceWithVat: money(price * (1 + vatRate / 100)),
    };
  }
  // INCLUSIVE: ПДВ вже включено в ціну
  return {
    vatAmount: money(sum - sum / (1 + vatRate / 100)),
    priceWithoutVat: money(price / (1 + vatRate / 100)),
    priceWithVat: money(price),
  };
}

/**
 * A3/A5-money: ЄДИНЕ джерело формули ПДВ на ДОКУМЕНТ-БАЗІ (сумарна база, не per-line). Раніше цю
 * саму формулу WorkOrdersService.recalcTotals інлайнив окремо → VAT-математика не мала одного власника.
 * INCLUSIVE → ПДВ уже в базі (виділяємо); EXCLUSIVE → ПДВ зверху; NONE/0 → 0. Результат квантовано.
 */
export function calcVatOnBase(base: number, vatRate: number, vatMode: VatMode): Money {
  if (vatMode === 'NONE' || vatRate === 0) return money(0);
  if (vatMode === 'INCLUSIVE') return money(base - base / (1 + vatRate / 100));
  // EXCLUSIVE
  return money((base * vatRate) / 100);
}

/**
 * BR-WO-007: розкладає суму рядків наряду (`base`) на «без ПДВ» і «до сплати» за режимом ПДВ.
 * `vat` — результат `calcVatOnBase(base, …)` для того самого режиму.
 *
 *   NONE      → обидві = база
 *   INCLUSIVE → ПДВ уже в цінах: до сплати = база, без ПДВ = база − ПДВ
 *   EXCLUSIVE → ПДВ зверху: без ПДВ = база, до сплати = база + ПДВ
 *
 * Інваріант у всіх режимах: totalNet + vat = totalAmount.
 */
export function splitWorkOrderTotal(
  base: Money,
  vat: Money,
  vatMode: VatMode,
): { totalNet: Money; totalAmount: Money } {
  if (vatMode === 'EXCLUSIVE') return { totalNet: base, totalAmount: money(base + vat) };
  if (vatMode === 'INCLUSIVE') return { totalNet: money(base - vat), totalAmount: base };
  return { totalNet: base, totalAmount: base };
}

/**
 * Плановий підсумок наряду для КОШТОРИСУ клієнтові (публічна сторінка, PDF/XLSX/DOCX, SMS).
 *
 * Кошторис показує план (`totalLabor + totalParts`, нормо-години), а тотали наряду рахуються від
 * факту (`totalActualLabor + totalParts`). Щоб кошторис ніс той самий ПДВ, що й наряд, режим і
 * частка ПДВ беруться з уже записаних тоталів наряду (BR-WO-007), а не з налаштувань: публічний
 * кошторис працює без tenant-контексту, і наряд — єдине джерело того, що побачить клієнт у боргу.
 * Якщо план збігається з фактом (типово для кошторису — фактичних годин ще немає), повертаються
 * рівно тотали наряду, без повторного округлення.
 */
export function plannedWorkOrderTotals(wo: {
  totalLabor: unknown;
  totalActualLabor: unknown;
  totalParts: unknown;
  totalNet: unknown;
  totalAmount: unknown;
}): { totalNet: Money; totalVat: Money; totalAmount: Money } {
  const parts = Number(wo.totalParts);
  const plannedBase = money(Number(wo.totalLabor) + parts);
  const actualBase = money(Number(wo.totalActualLabor) + parts);
  const net = money(Number(wo.totalNet));
  const total = money(Number(wo.totalAmount));
  const vat = money(total - net);

  if (vat === 0 || actualBase === 0) {
    return { totalNet: plannedBase, totalVat: money(0), totalAmount: plannedBase };
  }
  if (plannedBase === actualBase) return { totalNet: net, totalVat: vat, totalAmount: total };
  // «ПДВ зверху»: база наряду = сума без ПДВ. Інакше ПДВ сидить у цінах («ПДВ у ціні»).
  if (net === actualBase) {
    const plannedVat = money((plannedBase * vat) / net);
    return {
      totalNet: plannedBase,
      totalVat: plannedVat,
      totalAmount: money(plannedBase + plannedVat),
    };
  }
  const plannedVat = money((plannedBase * vat) / total);
  return {
    totalNet: money(plannedBase - plannedVat),
    totalVat: plannedVat,
    totalAmount: plannedBase,
  };
}

/**
 * Сумує ВЖЕ-ОБЧИСЛЕНІ per-line значення ПДВ у підсумки документа (single-pass).
 * На відміну від `calcDocVat` (перераховує з raw price/qty/vatRate/vatMode) — тут рядки
 * несуть готові `priceWithoutVat`/`vatAmount`/`priceWithVat` (напр. InvoiceLine у БД).
 * `Number()` коерсія толерує Prisma `Decimal` і plain-number однаково.
 */
export function sumLineTotals(
  lines: { priceWithoutVat: unknown; vatAmount: unknown; priceWithVat: unknown }[],
): { totalWithoutVat: Money; totalVat: Money; totalWithVat: Money } {
  let totalWithoutVat = 0;
  let totalVat = 0;
  let totalWithVat = 0;
  for (const l of lines) {
    totalWithoutVat += Number(l.priceWithoutVat);
    totalVat += Number(l.vatAmount);
    totalWithVat += Number(l.priceWithVat);
  }
  // Квантуємо підсумки — Σ float-значень теж дрейфує (напр. 0.1+0.2).
  return {
    totalWithoutVat: money(totalWithoutVat),
    totalVat: money(totalVat),
    totalWithVat: money(totalWithVat),
  };
}

export function calcDocVat(
  lines: { qty: number; price: number; vatRate: number; vatMode: VatMode }[],
): { totalVat: Money; totalWithoutVat: Money; totalWithVat: Money } {
  let totalVat = 0;
  let totalWithoutVat = 0;
  let totalWithVat = 0;
  for (const l of lines) {
    const { vatAmount, priceWithoutVat, priceWithVat } = calcLineVat(
      l.price,
      l.qty,
      l.vatRate,
      l.vatMode,
    );
    totalVat += vatAmount;
    totalWithoutVat += priceWithoutVat * l.qty;
    totalWithVat += priceWithVat * l.qty;
  }
  return {
    totalVat: money(totalVat),
    totalWithoutVat: money(totalWithoutVat),
    totalWithVat: money(totalWithVat),
  };
}
