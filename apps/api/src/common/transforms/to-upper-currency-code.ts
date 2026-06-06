/**
 * class-transformer helper для normalize currency code DTO полів.
 *
 * Проблема: користувач може набрати ISO-код у fallback Input як `uah`
 * (lowercase) — DB зберігає коди UPPERCASE ('UAH', 'USD'). Без normalization
 * service lookup `currency.findFirst({ code: dto.currency })` повертає
 * 400 «не знайдена» для валідного коду, бо Postgres VARCHAR case-sensitive.
 *
 * Рішення: trim + uppercase + cap до 10 символів (max VARCHAR(10) у схемі).
 * Пустий рядок → undefined (для @IsOptional пропуску).
 *
 * Використання:
 * ```ts
 * @IsOptional()
 * @Transform(toUpperCurrencyCode)
 * @IsString()
 * @MaxLength(10)
 * currency?: string;
 * ```
 */
export const toUpperCurrencyCode = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.toUpperCase().slice(0, 10);
};
