type VatMode = 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';

interface LineVatResult {
  vatAmount: number;
  priceWithoutVat: number;
  priceWithVat: number;
}

export function calcLineVat(
  price: number,
  qty: number,
  vatRate: number,
  vatMode: VatMode,
): LineVatResult {
  if (vatMode === 'NONE' || vatRate === 0) {
    return { vatAmount: 0, priceWithoutVat: price, priceWithVat: price };
  }
  const sum = price * qty;
  if (vatMode === 'EXCLUSIVE') {
    const vatAmount = (sum * vatRate) / 100;
    return {
      vatAmount,
      priceWithoutVat: price,
      priceWithVat: price * (1 + vatRate / 100),
    };
  }
  // INCLUSIVE: ПДВ вже включено в ціну
  const vatAmount = sum - sum / (1 + vatRate / 100);
  return {
    vatAmount,
    priceWithoutVat: price / (1 + vatRate / 100),
    priceWithVat: price,
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
  return { totalVat, totalWithoutVat, totalWithVat };
}
