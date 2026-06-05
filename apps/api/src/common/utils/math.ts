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
