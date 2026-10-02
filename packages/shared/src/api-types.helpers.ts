/**
 * Публічний фасад над ЗГЕНЕРОВАНИМИ типами OpenAPI (`api-types.ts`).
 *
 * `api-types.ts` генерується автоматично (`pnpm run gen:api-types`) і його НЕ можна
 * правити руками. Працювати з `components["schemas"]["XResponseDto"]` у кожному хуку
 * незручно, тож тут живуть короткі аліаси-утиліти.
 *
 * Патерн міграції рукописного `interface X` у web — див. docs/PATTERNS.md,
 * розділ «Типи API: беремо згенероване, не пишемо своє».
 */
import type { components, paths } from './api-types';

/** Усі схеми з OpenAPI-документа: `ApiSchemas['InvoiceResponseDto']`. */
export type ApiSchemas = components['schemas'];

/** Один тип зі схем: `ApiSchema<'InvoiceResponseDto'>`. Коротше за `components[...]`. */
export type ApiSchema<K extends keyof ApiSchemas> = ApiSchemas[K];

/** Усі шляхи — для рідких випадків, коли треба вивести тип query/body з роута. */
export type ApiPaths = paths;

export type { components, paths, operations } from './api-types';
