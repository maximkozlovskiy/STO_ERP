import { zodResolver } from '@hookform/resolvers/zod';
import type { Resolver, FieldValues } from 'react-hook-form';
import type { ZodType, ZodTypeDef } from 'zod';
import { translateValidation, type ValidationLocale } from '@sto/shared';
import { getCurrentLocale } from '@/i18n/locale';

/**
 * Обгортка zodResolver, що перекладає validation-KEY-и (issue.message тепер ключ, бо схеми у
 * @sto/shared емітять ключі) у поточну мову (getCurrentLocale). Рекурсивно, бо RHF-errors — дерево
 * (nested line-items у work-order superRefine мають вкладені шляхи; плоский Object.keys лишив би їх key-ами).
 *
 * Дзеркалить сигнатуру zodResolver<Input, Context, Output> → Resolver<Input, Context, Output>, щоб
 * інференс типів у `useForm<Input, Context, Output>` лишався таким самим. Заміна у формах:
 * `zodResolver(schema)` → `i18nZodResolver(schema)`; рендер-сайти (errors.x?.message) не міняються.
 */
function translateErrorTree(node: unknown, locale: ValidationLocale): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.message === 'string' && obj.message) {
    obj.message = translateValidation(obj.message, locale);
  }
  for (const key of Object.keys(obj)) {
    if (key === 'message' || key === 'ref' || key === 'type') continue;
    translateErrorTree(obj[key], locale);
  }
}

export function i18nZodResolver<Input extends FieldValues, Context, Output>(
  schema: ZodType<Output, ZodTypeDef, Input>,
): Resolver<Input, Context, Output> {
  const base = zodResolver<Input, Context, Output>(schema);
  return async (values, context, options) => {
    const result = await base(values, context, options);
    translateErrorTree(result.errors, getCurrentLocale());
    return result;
  };
}
