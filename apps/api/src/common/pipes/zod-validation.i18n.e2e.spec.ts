import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { employeeCreateSchema, goodFormSchema } from '@sto/shared';
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

/**
 * Поле без власного ключа повідомлення (поле-об'єкт `rateScheme`, межі числа без тексту): zod дає свій
 * англійський текст — «Invalid input: expected object, received undefined». Pipe підставляє ключ:
 * поля немає → «Обов'язкове поле», не той тип чи межа → «Невірне значення» (TECH-DEBT (а), 2026-10-30).
 */
describe('вбудовані повідомлення zod — ключем каталогу, не англійським текстом', () => {
  const employee = { firstName: 'Іван', lastName: 'Коваль', role: 'MECHANIC' };
  const messages = (body: unknown, locale: 'uk' | 'en') =>
    runWithTenant({ locale }, () => {
      try {
        new ZodValidationPipe(employeeCreateSchema).transform(body);
        throw new Error('очікували BadRequestException');
      } catch (e) {
        if (!(e instanceof BadRequestException)) throw e;
        return (e.getResponse() as { message: string[] }).message;
      }
    });

  it("поля-об'єкта немає → «Обов'язкове поле» з назвою поля (uk і en)", () => {
    expect(messages(employee, 'uk')).toEqual(['Обов\'язкове поле (поле "rateScheme")']);
    expect(messages(employee, 'en')).toEqual(['Required field (field "rateScheme")']);
  });

  it('значення не того типу чи поза межами → «Невірне значення», без англійського тексту zod', () => {
    const wrongType = messages({ ...employee, rateScheme: 'x' }, 'uk');
    expect(wrongType).toEqual(['Невірне значення (поле "rateScheme")']);
    const outOfRange = messages(
      { ...employee, rateScheme: { type: 'percent_normo', params: { percent: 150 } } },
      'uk',
    );
    expect(outOfRange).toEqual(['Невірне значення (поле "rateScheme.params.percent")']);
  });
});
