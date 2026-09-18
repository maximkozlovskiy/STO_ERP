import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { goodFormSchema } from '@sto/shared';
import { ZodValidationPipe } from './zod-validation.pipe';
import { runWithTenant } from '../tenant/tenant-context';

/**
 * End-to-end локаль-конвеєр (integration): ZodValidationPipe.transform всередині ALS-scope
 * (runWithTenant({locale})) — той самий шлях, що й у проді (TenantContextInterceptor → getLocale()).
 * Джерело правди для повідомлень — @sto/shared dist-каталог (translateValidation).
 *
 * Контракт 400 незмінний: { statusCode:400, message:string[], error:'Bad Request' }.
 * Перевіряємо: uk BYTE-IDENTICAL, en локалізовано, БЕЗ scope → default 'uk'.
 */
function messagesFor(locale: 'uk' | 'en' | undefined): string[] {
  const pipe = new ZodValidationPipe(goodFormSchema);
  const run = () => {
    try {
      pipe.transform({ name: '' }); // порожня назва → v.good.name.required (+ path suffix)
      throw new Error('очікували BadRequestException');
    } catch (e) {
      if (!(e instanceof BadRequestException)) throw e;
      return (e.getResponse() as { message: string[] }).message;
    }
  };
  if (locale === undefined) return run(); // поза scope
  return runWithTenant({ locale }, run);
}

describe('locale pipeline (pipe + ALS + shared catalog)', () => {
  it('uk — байт-ідентичне українське повідомлення з суфіксом поля', () => {
    const msg = messagesFor('uk');
    expect(msg).toContain('Вкажіть назву товару (поле "name")');
  });

  it('en — англійське повідомлення з англомовним суфіксом поля', () => {
    const msg = messagesFor('en');
    expect(msg).toContain('Enter the product name (field "name")');
    // жодного українського тексту в en-відповіді
    expect(msg.join(' ')).not.toMatch(/[а-яіїєґ]/i);
  });

  it('без scope (BullMQ/cron/seed) → default uk', () => {
    const msg = messagesFor(undefined);
    expect(msg).toContain('Вкажіть назву товару (поле "name")');
  });

  it('дві послідовні різнолокальні валідації не течуть одна в одну (ALS-per-run)', () => {
    // Дзеркалить два конкурентні запити з різним Accept-Language: кожен runWithTenant ізольований.
    const en = messagesFor('en');
    const uk = messagesFor('uk');
    expect(en.join(' ')).toContain('Enter the product name');
    expect(uk.join(' ')).toContain('Вкажіть назву товару');
    // en-виклик НЕ протік у uk і навпаки
    expect(en.join(' ')).not.toContain('Вкажіть');
    expect(uk.join(' ')).not.toContain('Enter');
  });

  it('конкурентна ізоляція під interleaved await (ALS не тече між паралельними scope)', async () => {
    // Два «запити» стартують у різних scope і чергуються через await — перевіряє, що getLocale()
    // усередині кожного бачить СВІЙ locale, а не останній встановлений.
    const results: Record<string, string[]> = {};
    await Promise.all([
      runWithTenant({ locale: 'en' }, async () => {
        await new Promise(r => setTimeout(r, 5));
        const pipe = new ZodValidationPipe(goodFormSchema);
        try {
          pipe.transform({ name: '' });
        } catch (e) {
          results.en = (e as BadRequestException).getResponse() as never;
          results.en = ((e as BadRequestException).getResponse() as { message: string[] }).message;
        }
      }),
      runWithTenant({ locale: 'uk' }, async () => {
        await new Promise(r => setTimeout(r, 2));
        const pipe = new ZodValidationPipe(goodFormSchema);
        try {
          pipe.transform({ name: '' });
        } catch (e) {
          results.uk = ((e as BadRequestException).getResponse() as { message: string[] }).message;
        }
      }),
    ]);
    expect(results.en.join(' ')).toContain('Enter the product name');
    expect(results.uk.join(' ')).toContain('Вкажіть назву товару');
  });
});
