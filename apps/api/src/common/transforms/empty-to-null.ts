/**
 * class-transformer helper для optional/nullable полів у Update DTO, де фронт має спосіб явно
 * ОЧИСТИТИ значення (наприклад: зняли галочку "Фіскальна каса" → провайдера і ID каси провайдера
 * треба стерти в БД, а не лишити застарілими).
 *
 * На відміну від `emptyToUndefined` (де `""` означає "поле не передавали" → пропустити),
 * тут `""` означає "очистити поле" → `null`, і сервіс далі просто мерджить `dto` у
 * `prisma.update({ data: dto })` — `undefined` поле Prisma ігнорує (не займає колонку),
 * а `null` явно записує NULL.
 *
 * Використання:
 * ```ts
 * @IsOptional()
 * @Transform(emptyToNull)
 * @IsString()
 * fiscalProvider?: string | null;
 * ```
 */
export const emptyToNull = ({ value }: { value: unknown }): unknown =>
  value === '' ? null : value;
