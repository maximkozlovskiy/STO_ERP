import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type { FieldValues } from 'react-hook-form';
import { i18nZodResolver } from '../i18nZodResolver';
import { counterpartyFormSchema } from '@sto/shared';
import { setCurrentLocale } from '@/i18n/locale';

/**
 * Регресія: i18nZodResolver мусить перекладати validation-KEY-и у RHF-дереві помилок для БУДЬ-ЯКОГО
 * поля — включно з полем, ім'я якого збігається з RHF-метаключем ('type'). counterparty/stock-document
 * мають `type: z.enum(...)`; попередній resolver пропускав key === 'type' у рекурсії й лишав
 * errors.type.message сирим KEY-ом ('v.counterparty.type.required') у UI.
 */
describe('i18nZodResolver', () => {
  beforeEach(() => setCurrentLocale('uk'));

  async function resolve<T extends FieldValues>(schema: z.ZodType<T>, values: unknown) {
    const resolver = i18nZodResolver<T, unknown, T>(schema as never);
    const res = await resolver(values as T, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    } as never);
    return res.errors as Record<string, { message?: string }>;
  }

  it('перекладає помилку поля з ім’ям "type" (не лишає сирий key)', async () => {
    // Порожній об'єкт → type (enum) обов'язковий → v.counterparty.type.required.
    const errors = await resolve(counterpartyFormSchema as never, {});
    expect(errors.type?.message).toBe('Оберіть тип контрагента');
    // Жодного сирого validation-key у жодному повідомленні дерева.
    const allMessages = JSON.stringify(errors);
    expect(allMessages).not.toMatch(/v\.[a-z]/i);
  });

  it('перекладає звичайне (не-"type") поле', async () => {
    const schema = z.object({ name: z.string().min(1, 'v.good.name.required') });
    const errors = await resolve(schema, { name: '' });
    expect(errors.name?.message).toBe('Вкажіть назву товару');
  });

  it('невідомий key лишається як є (fallback), але не крешить', async () => {
    const schema = z.object({ x: z.string().min(1, 'v.__missing__') });
    const errors = await resolve(schema, { x: '' });
    expect(errors.x?.message).toBe('v.__missing__');
  });
});
