import { zodResolver } from '@hookform/resolvers/zod';
import type { Resolver, FieldValues } from 'react-hook-form';
import type { ZodType } from 'zod';
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
  // Пропускаємо ЛИШЕ 'message' (уже оброблено вище) і 'ref' (DOM-нода RHF — не помилка, рекурсія у неї
  // марна й потенційно циклічна). НЕ пропускаємо 'type': це і назва RHF-правила (рядок, рекурсія no-op),
  // і — критично — ім'я реального поля форми (counterparty/stock-document мають `type: z.enum`). Пропуск
  // 'type' лишав би errors.type.message сирим KEY-ом у UI (напр. 'v.counterparty.type.required'). Bug.
  for (const key of Object.keys(obj)) {
    if (key === 'message' || key === 'ref') continue;
    translateErrorTree(obj[key], locale);
  }
}

/**
 * Zod 4 ПРИБРАВ `ZodTypeDef`: тип став `ZodType<Output, Input>` (у v3 було
 * `ZodType<Output, Def, Input>`). Поки в сигнатурі стояв `ZodTypeDef`, TS резолвив його в
 * `any`, і виведений `Resolver` не збігався з очікуваним — 16 помилок TS2322 на всіх
 * формах, що беруть цю обгортку.
 */
export function i18nZodResolver<Input extends FieldValues, Context, Output>(
  schema: ZodType<Output, Input>,
): Resolver<Input, Context, Output> {
  const base = zodResolver<Input, Context, Output>(schema);
  return async (values, context, options) => {
    const result = await base(values, context, options);
    translateErrorTree(result.errors, getCurrentLocale());
    return result;
  };
}
