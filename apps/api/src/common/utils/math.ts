/**
 * Returns a safe positive divisor from a coefficient value.
 *
 * DTO `@Min(0.000001)` blocks coefficient=0 on the write-path, but
 * legacy/seed/CSV-import data may have 0 or null. `?? 1` does NOT catch 0
 * (nullish coalescing only fires on null/undefined). `safeCoeff` catches
 * 0/NaN/negative/null/undefined — safe for `qty / coeff` division.
 */
export function safeCoeff(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 1;
  return value;
}

/**
 * Округлення грошей до 2 знаків (копійки), half-away-from-zero (бухгалтерське).
 *
 * Гроші зберігаються у Postgres `Decimal(12,2)`, але обчислення (ПДВ, суми, собівартість)
 * ідуть у JS `number` (IEEE-754). Без єдиного округлення на кожному кроці накопичується
 * float-дрейф: `300.3 * 0.2 = 60.059999999999995`, а `Σ(рядки)` може не дорівнювати `total`
 * на копійку (WO-H2 / FIN-H1). Застосовувати до КОЖНОГО грошового результату перед записом
 * та у сумуванні. `+1e-9` нейтралізує представлення на кшталт 1.005 → 1.00 замість 1.01.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-9)) / 100;
}
