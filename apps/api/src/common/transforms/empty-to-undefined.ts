/**
 * class-transformer helper для optional UUID/enum полів у DTO.
 *
 * Проблема: фронт часто шле порожній рядок `""` коли селект скинули.
 * `@IsOptional` пропускає лише `undefined`/`null`, а `""` доходить до `@IsUUID`,
 * що повертає 400 Bad Request — попри те що поле справді опціональне.
 *
 * Рішення: трансформ перетворює `""` на `undefined` ДО валідатора, тож
 * `@IsOptional` коректно його пропускає.
 *
 * Використання:
 * ```ts
 * @IsOptional()
 * @Transform(emptyToUndefined)
 * @IsUUID()
 * branchId?: string;
 * ```
 */
export const emptyToUndefined = ({ value }: { value: unknown }): unknown =>
  value === '' ? undefined : value;
