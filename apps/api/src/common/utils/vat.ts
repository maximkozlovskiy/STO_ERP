// sto-review §13: import Prisma's VatMode enum so consumers don't need
// `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'` casts. Prisma enum at runtime is a
// string literal union that matches this local type.
import type { VatMode } from '@prisma/client';
import { roundMoney } from './math';

interface LineVatResult {
  vatAmount: number;
  priceWithoutVat: number;
  priceWithVat: number;
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
    return { vatAmount: 0, priceWithoutVat: roundMoney(price), priceWithVat: roundMoney(price) };
  }
  const sum = price * qty;
  if (vatMode === 'EXCLUSIVE') {
    return {
      vatAmount: roundMoney((sum * vatRate) / 100),
      priceWithoutVat: roundMoney(price),
      priceWithVat: roundMoney(price * (1 + vatRate / 100)),
    };
  }
  // INCLUSIVE: ПДВ вже включено в ціну
  return {
    vatAmount: roundMoney(sum - sum / (1 + vatRate / 100)),
    priceWithoutVat: roundMoney(price / (1 + vatRate / 100)),
    priceWithVat: roundMoney(price),
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
): { totalWithoutVat: number; totalVat: number; totalWithVat: number } {
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
    totalWithoutVat: roundMoney(totalWithoutVat),
    totalVat: roundMoney(totalVat),
    totalWithVat: roundMoney(totalWithVat),
  };
}

export function calcDocVat(
  lines: { qty: number; price: number; vatRate: number; vatMode: VatMode }[],
): { totalVat: number; totalWithoutVat: number; totalWithVat: number } {
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
    totalVat: roundMoney(totalVat),
    totalWithoutVat: roundMoney(totalWithoutVat),
    totalWithVat: roundMoney(totalWithVat),
  };
}
