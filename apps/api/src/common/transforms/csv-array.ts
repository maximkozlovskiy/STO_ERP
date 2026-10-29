/**
 * class-transformer helper для query-параметра «кілька значень»: `?statuses=A,B` або повторений
 * `?statuses=A&statuses=B` (Fastify віддає його масивом). Рядки розбиваються за комою й
 * обрізаються, порожні відкидаються; нічого не лишилось — `undefined` (`@IsOptional` пропускає).
 *
 * Без розбору масиву відбір мовчки зникав і список повертав записи в усіх статусах.
 *
 * Використання:
 * ```ts
 * @IsOptional()
 * @Transform(csvArray)
 * @IsArray()
 * @IsEnum(InvoiceStatus, { each: true })
 * statuses?: InvoiceStatus[];
 * ```
 */
export const csvArray = ({ value }: { value: unknown }): unknown[] | undefined => {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap(v => (typeof v === 'string' ? v.split(',') : [v]))
    .map(v => (typeof v === 'string' ? v.trim() : v))
    .filter(v => v !== '' && v != null);
  return parts.length > 0 ? parts : undefined;
};
